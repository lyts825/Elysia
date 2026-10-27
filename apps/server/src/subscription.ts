/**
 * 管理订阅服务及其状态。
 * 串行管理 OAuth/OIDC、加密保险库与旋转令牌，并提供账号取消/额度封锁；秘密不返渲染层，模型正文和预算仍归请求执行层。
 * EN: Manages subscription authentication and account state. Serializes OAuth/OIDC, encrypted vault and token rotation with account cancellation/quota blocking; secrets stay backend while request layers own bodies/budgets.
 */
import { createServer, type Server } from 'node:http';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createRemoteJWKSet, customFetch, jwtVerify } from 'jose';
import { z } from 'zod';
import { AppError, invariant } from '../../../packages/contracts/src/index.js';
import type { DesktopServices } from './desktop.js';

const issuer = 'https://auth.openai.com';
const resource = 'https://api.openai.com/v1';
const scopes = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const permission = 'chatgpt.tokens.use.direct';
/**
 * 生成 32 字节密码学随机值并以 Base64URL 编码，用于 OAuth state、nonce 或 PKCE 材料。
 * EN: Generates 32 cryptographically random bytes as Base64URL for OAuth state, nonce or PKCE material.
 */
const random = () => randomBytes(32).toString('base64url');
const Credentials = z.object({
  id: z.string(),
  clientId: z.string(),
  subject: z.string(),
  email: z.string(),
  accessToken: z.string().optional(),
  refreshToken: z.string().optional(),
  idToken: z.string().optional(),
  expiresAt: z.number(),
  earliestRefreshAt: z.number().default(0),
  scopes: z.array(z.string()),
  welcomed: z.boolean().default(false),
});
type Account = z.infer<typeof Credentials>;
const Vault = z.object({ version: z.literal(1), hostId: z.string(), accounts: z.array(Credentials) });
type VaultData = z.infer<typeof Vault>;
interface Attempt {
  id: string;
  state: string;
  nonce: string;
  verifier: string;
  redirectUri: string;
  clientId: string;
  accountId?: string;
  expiresAt: number;
  status: 'pending' | 'exchanging' | 'completed' | 'failed' | 'cancelled';
  message?: string;
  server: Server;
  timer: NodeJS.Timeout;
  abort: AbortController;
}

/**
 * OAuth 密钥仅保留在后端和由操作系统加密的桌面保险库中。 管理订阅登录、凭据和模型目录；关闭时取消登录与在途请求。
 * EN: OAuth secrets stay in the backend and the OS-encrypted desktop vault. Manages subscription login, credentials and catalogs, cancelling login and in-flight requests on close.
 */
export class SubscriptionService {
  private data?: VaultData;
  private loading?: Promise<void>;
  private discovery?: any;
  private jwks?: ReturnType<typeof createRemoteJWKSet>;
  private pending?: Attempt;
  private queue: Promise<unknown> = Promise.resolve();
  private controllers = new Map<string, AbortController>();
  private signingOut = new Set<string>();
  private usageBlocked = new Set<string>();
  private closed = false;
  private vaultDirty = false;
  /**
   * 绑定可选桌面保险库和可注入 fetch；构造时不读令牌或发授权请求。
   * EN: Binds optional desktop vault and injectable fetch without reading tokens or sending auth requests at construction.
   */
  constructor(
    private desktop?: DesktopServices,
    private request: typeof fetch = fetch,
  ) {}

  /**
   * 串行处理登录、刷新和退出，避免两个请求并发使用同一轮换 refresh token。
   * EN: Serializes login, refresh and logout to prevent concurrent reuse of rotating refresh tokens.
   */
  private exclusive<T>(action: () => Promise<T>): Promise<T> {
    const result = this.queue.then(action);
    this.queue = result.catch(() => {});
    return result;
  }
  /**
   * 先更新内存并标记未落盘，再写系统保险库，成功才清除 dirty；轮换后的令牌即使落盘失败也不能退回旧值。
   * EN: Updates memory/dirty state before OS-vault persistence and clears dirty only on success; rotated tokens never revert to old values after write failure.
   */
  private async save(data: VaultData) {
    /**
     * 即使磁盘写入失败也在内存保留轮换后的令牌，不能重用旧 refresh token。
     * EN: Retain rotated tokens in memory even if the disk write fails. Never reuse the old refresh token.
     */
    this.data = data;
    this.vaultDirty = true;
    await this.desktop!.request('vault-write', data);
    this.vaultDirty = false;
  }
  /**
   * 要求桌面能力并合并首次保险库加载，校验已存数据或建立新的主机身份；同一实例复用加载承诺。
   * EN: Requires desktop capability and coalesces initial vault loading, validating saved data or creating a host identity; the instance reuses that promise.
   */
  private async load() {
    invariant(this.desktop, 'DESKTOP_REQUIRED', 'ChatGPT 订阅登录需要从 Elysia 桌面入口启动');
    return (this.loading ??= (async () => {
      const stored = await this.desktop!.request('vault-read');
      if (stored) this.data = Vault.parse(stored);
      else await this.save({ version: 1, hostId: 'urn:uuid:' + randomUUID(), accounts: [] });
    })());
  }
  /**
   * 从当前内存保险库按 ID 取账号，不存在则要求重新登录，不自动选择其他账号。
   * EN: Finds an account by ID in the loaded vault or requests login without choosing another account.
   */
  private account(id: string) {
    const account = this.data?.accounts.find((a) => a.id === id);
    invariant(account, 'CHATGPT_ACCOUNT', '找不到订阅账号，请在模型设置中登录');
    return account;
  }
  /**
   * 以相同 ID 替换单账号并保存完整保险库，其他账号资料保持原顺序。
   * EN: Replaces one account by ID and persists the vault while retaining other accounts' order.
   */
  private async replace(account: Account) {
    const others = this.data!.accounts.filter((a) => a.id !== account.id);
    await this.save({ ...this.data!, accounts: [...others, account] });
  }
  /**
   * 使用禁止重定向且带 20 秒/调用方取消的授权 HTTP 请求，完整读取文本后检查大小并解析；失败只公开安全代码、状态和请求 ID。
   * EN: Makes auth HTTP requests with redirects disabled and caller/20-second cancellation, checks size after reading text and parses JSON; failures expose only safe codes/status/request IDs.
   */
  private async json(url: string, init: RequestInit = {}) {
    let response: Response;
    try {
      response = await this.request(url, {
        ...init,
        redirect: 'error',
        signal: AbortSignal.any([init.signal ?? new AbortController().signal, AbortSignal.timeout(20000)]),
      });
    } catch {
      throw new AppError('CHATGPT_NETWORK', '无法连接 OpenAI，请检查网络后重试', true);
    }
    const text = await response.text();
    invariant(text.length < 2 * 1024 * 1024, 'CHATGPT_RESPONSE', 'OpenAI 返回数据超过限制');
    let body: any;
    try {
      body = JSON.parse(text);
    } catch {
      body = {};
    }
    if (!response.ok) {
      const code = typeof body.error === 'string' ? body.error : body.error?.code;
      const safeCode = typeof code === 'string' && /^[a-zA-Z0-9_]{1,100}$/.test(code) ? code : 'CHATGPT_HTTP';
      throw new AppError(
        safeCode,
        `OpenAI 授权服务返回 HTTP ${response.status}（${safeCode}）`,
        response.status >= 500,
        {
          status: response.status,
          requestId: response.headers.get('x-request-id') ?? response.headers.get('openai-request-id'),
        },
      );
    }
    return body;
  }
  /**
   * OIDC discovery 必须来自固定签发者和精确端点，再建立仅支持指定算法的身份验证。
   * EN: Requires discovery from the pinned issuer and exact endpoints before constructing algorithm-restricted identity verification.
   */
  private async metadata() {
    if (this.discovery) return this.discovery;
    const doc = await this.json(issuer + '/.well-known/openid-configuration');
    invariant(doc.issuer === issuer, 'OIDC_ISSUER', 'OpenAI 登录签发者不匹配');
    for (const field of ['authorization_endpoint', 'token_endpoint', 'jwks_uri', 'revocation_endpoint']) {
      const endpoint = new URL(doc[field]);
      invariant(
        endpoint.origin === issuer && !endpoint.username && !endpoint.password && !endpoint.hash,
        'OIDC_ENDPOINT',
        'OpenAI 登录端点无效',
      );
    }
    invariant(
      doc.authorization_endpoint === issuer + '/api/accounts/authorize' &&
        doc.token_endpoint === issuer + '/api/accounts/oauth/token',
      'OIDC_ENDPOINT',
      'OpenAI 登录端点不匹配',
    );
    this.jwks = createRemoteJWKSet(new URL(doc.jwks_uri), {
      [customFetch]: this.request,
      timeoutDuration: 20000,
    });
    return (this.discovery = doc);
  }
  /**
   * 核验签名、issuer、audience、时效与可选 nonce，拒绝登录返回到不同客户端或账号。
   * EN: Checks signature, issuer, audience, lifetime and optional nonce to reject responses for a different client or account.
   */
  private async identity(token: string, clientId: string, nonce?: string) {
    await this.metadata();
    try {
      const { payload } = await jwtVerify(token, this.jwks!, {
        issuer,
        audience: clientId,
        algorithms: ['RS256', 'PS256', 'ES256', 'EdDSA'],
        requiredClaims: ['sub', 'exp', 'iat', ...(nonce ? ['nonce'] : [])],
        clockTolerance: 30,
      });
      invariant(
        typeof payload.sub === 'string' &&
          !!payload.sub &&
          (!nonce || payload.nonce === nonce) &&
          (!Array.isArray(payload.aud) || payload.aud.length === 1 || payload.azp === clientId),
        'OIDC_IDENTITY',
        '登录身份或 nonce 无效',
      );
      return {
        subject: payload.sub,
        email: typeof payload.email === 'string' ? payload.email : 'ChatGPT 账号',
      };
    } catch {
      throw new AppError('OIDC_IDENTITY', 'OpenAI 登录身份校验失败，请重新登录');
    }
  }
  /**
   * 校验 Bearer 令牌响应及正有效期，计算到期/最早刷新时刻；刷新响应省略轮换字段时才保留旧值。
   * EN: Validates Bearer responses/positive lifetime and computes expiry/earliest refresh, retaining old rotation fields only when omitted.
   */
  private tokens(body: any, previous?: Account) {
    invariant(
      typeof body.access_token === 'string' &&
        body.access_token.length > 0 &&
        typeof body.expires_in === 'number' &&
        Number.isFinite(body.expires_in) &&
        body.expires_in > 0 &&
        body.token_type?.toLowerCase() === 'bearer',
      'OAUTH_TOKENS',
      'OpenAI 返回的凭据格式无效',
    );
    const granted =
      typeof body.scope === 'string' ? body.scope.split(/\s+/).filter(Boolean) : (previous?.scopes ?? []);
    const earliest =
      typeof body.earliest_refresh_at === 'number'
        ? body.earliest_refresh_at * 1000
        : Date.parse(body.earliest_refresh_at ?? '') || 0;
    return {
      accessToken: body.access_token as string,
      refreshToken: typeof body.refresh_token === 'string' ? body.refresh_token : previous?.refreshToken,
      idToken: typeof body.id_token === 'string' ? body.id_token : previous?.idToken,
      expiresAt: Date.now() + body.expires_in * 1000,
      earliestRefreshAt: earliest,
      scopes: granted,
    };
  }
  /**
   * 返回公开账号摘要与当前登录尝试，不返回令牌；无桌面能力显示不可用，connected 仅依据已存凭据时效/刷新可能性。
   * EN: Returns public account/login-attempt summaries without tokens; absent desktop is unavailable and connected reflects stored expiry/refresh possibility only.
   */
  async status() {
    if (!this.desktop)
      return { available: false, accounts: [], attempt: null, message: '请从桌面入口使用订阅登录' };
    await this.load();
    return {
      available: true,
      accounts: this.data!.accounts.map((a) => ({
        id: a.id,
        label: `${a.email} · ${a.clientId.slice(-8)}`,
        email: a.email,
        connected: !!a.accessToken && (a.expiresAt > Date.now() || !!a.refreshToken),
        planEnabled: a.scopes.includes(permission),
        welcomed: a.welcomed,
        usageBlocked: this.usageBlocked.has(a.id),
      })),
      attempt: this.pending
        ? {
            id: this.pending.id,
            accountId: this.pending.accountId,
            status: this.pending.status,
            message: this.pending.message,
          }
        : null,
    };
  }
  /**
   * 从内存检查账号权限、令牌和保险库落盘状态及退出锁，不在线验证认证是否仍有效。
   * EN: Checks cached permissions/tokens, persisted-vault state and sign-out lock without online authentication verification.
   */
  configured(id?: string | null) {
    const account = this.data?.accounts.find((a) => a.id === id);
    return (
      !this.vaultDirty &&
      !!account?.accessToken &&
      account.scopes.includes(permission) &&
      (account.expiresAt > Date.now() || !!account.refreshToken) &&
      !this.signingOut.has(account.id)
    );
  }
  /**
   * 把登录启动放入账号串行队列，避免与刷新或退出同时改写凭据。
   * EN: Serializes login startup with credential refresh/logout to prevent concurrent token mutation.
   */
  async start(accountId?: string, consent = false) {
    return this.exclusive(() => this.startLogin(accountId, consent));
  }
  /**
   * 读取受信发现配置后建立仅回环监听的 OAuth 回调服务，生成一次性 state/nonce/PKCE 并通过桌面打开登录页；回调严格核对方法、路径、Host、时效及 state，消费后再异步换码。
   * EN: Loads trusted discovery, creates a loopback OAuth callback server and one-use state/nonce/PKCE, then opens login via desktop. Callback validates method/path/Host/expiry/state before consumption and async exchange.
   */
  private async startLogin(accountId?: string, consent = false) {
    await this.load();
    await this.metadata();
    invariant(!this.closed, 'STOPPED', '服务已停止');
    this.cancel();
    const account = accountId ? this.account(accountId) : undefined;
    const server = createServer((request, response) => {
      const attempt = this.pending;
      let url: URL;
      try {
        url = new URL(request.url ?? '/', 'http://127.0.0.1');
      } catch {
        response.writeHead(400).end();
        return;
      }
      response.setHeader('Content-Type', 'text/plain; charset=utf-8');
      response.setHeader('Cache-Control', 'no-store');
      response.setHeader('Referrer-Policy', 'no-referrer');
      response.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
      const state = Buffer.from(url.searchParams.get('state') ?? '');
      const expected = Buffer.from(attempt?.state ?? '');
      if (
        !attempt ||
        attempt.server !== server ||
        attempt.status !== 'pending' ||
        request.method !== 'GET' ||
        url.pathname !== '/auth/callback' ||
        request.headers.host !== new URL(attempt.redirectUri).host ||
        Date.now() >= attempt.expiresAt ||
        state.length !== expected.length ||
        !timingSafeEqual(state, expected)
      ) {
        response.writeHead(400).end('登录回调无效。请返回 Elysia 重新登录。');
        return;
      }
      attempt.status = 'exchanging'; /**
       * 在任何异步工作之前，一次性消费该值。
       * EN: Consume once, before any asynchronous work.
       */
      clearTimeout(attempt.timer);
      void this.exclusive(() => this.complete(attempt, url))
        .then(() => {
          response.end('授权已完成，请返回 Elysia 选择模型并验证连接。可以关闭此页面。');
        })
        .catch((error) => {
          if (attempt.status !== 'cancelled') {
            attempt.status = 'failed';
            attempt.message = error.message;
          }
          response.writeHead(400).end('登录未完成。请返回 Elysia 查看原因并重试。');
        })
        .finally(() => server.close());
    });
    server.requestTimeout = 15000;
    server.headersTimeout = 10000;
    server.maxConnections = 8;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    invariant(address && typeof address !== 'string', 'OAUTH_CALLBACK', '无法启动登录回调');
    const attempt: Attempt = {
      id: randomUUID(),
      state: random(),
      nonce: random(),
      verifier: random(),
      redirectUri: `http://127.0.0.1:${address.port}/auth/callback`,
      clientId: account?.clientId ?? 'dynamic_agent_client',
      accountId,
      expiresAt: Date.now() + 10 * 60000,
      status: 'pending',
      server,
      timer: setTimeout(() => {
        if (attempt.status === 'pending') {
          this.cancel();
          attempt.status = 'failed';
          attempt.message = '登录已超时，请重试';
        }
      }, 10 * 60000),
      abort: new AbortController(),
    };
    this.pending = attempt;
    const url = new URL(this.discovery.authorization_endpoint);
    url.search = new URLSearchParams({
      client_id: attempt.clientId,
      ext_agent_host_id: this.data!.hostId,
      response_type: 'code',
      redirect_uri: attempt.redirectUri,
      scope: scopes,
      resource,
      state: attempt.state,
      nonce: attempt.nonce,
      code_challenge_method: 'S256',
      code_challenge: createHash('sha256').update(attempt.verifier).digest('base64url'),
      ...(account ? {} : { agent_name_hint: 'Elysia' }),
      ...(account?.idToken ? { id_token_hint: account.idToken } : {}),
      ...(account?.email ? { login_hint: account.email } : {}),
      ...(consent ? { prompt: 'consent' } : {}),
    }).toString();
    try {
      await this.desktop!.request('open-auth', url.href);
    } catch (error) {
      this.cancel();
      throw error;
    }
    return { id: attempt.id }; /**
     * 不得向渲染进程返回保留 ID token 的授权 URL。
     * EN: Never return authorization URLs with retained ID tokens to the renderer.
     */
  }
  /**
   * 校验回调客户端及授权码，以 PKCE 换令牌并验证 OIDC 身份，再核对可选既有账号并持久保存；仅当前有效尝试可完成，取消和失败不冒充登录成功。
   * EN: Validates callback client/code, exchanges with PKCE, verifies OIDC identity and optional existing account before persistence. Only the current valid attempt completes; cancellation/failure never becomes login success.
   */
  private async complete(attempt: Attempt, url: URL) {
    invariant(
      !url.searchParams.has('error'),
      'OAUTH_DENIED',
      '未完成 ChatGPT 授权，可重新登录或使用 API Key',
    );
    const callbackClient = url.searchParams.get('client_id');
    const clientId = attempt.clientId === 'dynamic_agent_client' ? callbackClient : attempt.clientId;
    invariant(
      clientId &&
        clientId !== 'dynamic_agent_client' &&
        /^[a-zA-Z0-9._-]{8,256}$/.test(clientId) &&
        (attempt.clientId === 'dynamic_agent_client' || !callbackClient || callbackClient === clientId),
      'OAUTH_CLIENT',
      '登录返回的客户端身份不匹配',
    );
    const code = url.searchParams.get('code');
    invariant(code && code.length < 16000, 'OAUTH_CODE', '登录未返回有效授权码');
    const body = await this.json(this.discovery.token_endpoint, {
      method: 'POST',
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: clientId,
        code,
        code_verifier: attempt.verifier,
        redirect_uri: attempt.redirectUri,
        resource,
      }),
      signal: attempt.abort.signal,
    });
    invariant(typeof body.id_token === 'string', 'OIDC_IDENTITY', '登录未返回身份凭据');
    const identity = await this.identity(body.id_token, clientId, attempt.nonce);
    const previous = attempt.accountId
      ? this.account(attempt.accountId)
      : this.data!.accounts.find((a) => a.clientId === clientId && a.subject === identity.subject);
    invariant(!previous || previous.subject === identity.subject, 'OIDC_ACCOUNT', '登录账号与所选账号不一致');
    attempt.abort.signal.throwIfAborted();
    const account: Account = {
      ...identity,
      clientId,
      id: previous?.id ?? randomUUID(),
      welcomed: previous?.welcomed ?? false,
      ...this.tokens(body),
    };
    await this.replace(account);
    this.usageBlocked.delete(account.id);
    this.controllers.get(account.id)?.abort();
    this.controllers.set(account.id, new AbortController());
    attempt.accountId = account.id;
    attempt.status = 'completed';
    attempt.message = account.scopes.includes(permission)
      ? '已连接 ChatGPT 订阅，请选择模型并保存验证'
      : '已登录，但未授权使用 ChatGPT 订阅';
  }
  /**
   * 对 pending/exchanging 尝试标记取消、中止请求并关闭回环服务及连接；已结束尝试保持原结果。
   * EN: Marks pending/exchanging attempts cancelled, aborts requests and closes loopback server/connections while preserving settled attempts.
   */
  cancel() {
    const attempt = this.pending;
    if (attempt && ['pending', 'exchanging'].includes(attempt.status)) {
      attempt.status = 'cancelled';
      attempt.abort.abort();
      clearTimeout(attempt.timer);
      attempt.server.close();
      attempt.server.closeAllConnections();
    }
  }
  /**
   * 在串行区取得可用访问令牌，临近过期且允许刷新时轮换凭据并持久化。 返回账号级取消信号与额度封锁回调；退出或额度受限立即阻止后续模型调用， 刷新明确失效时清除旧凭据，不能继续重用已轮换或已撤销的 refresh token。
   * EN: Obtains usable access tokens inside the serialized section and rotates/persists near-expiry credentials when allowed. Returns account cancellation and quota blocking callbacks; logout/quota blocks later calls, and invalid refresh credentials are cleared rather than reused.
   */
  async credential(id: string) {
    await this.load();
    return this.exclusive(async () => {
      if (this.vaultDirty) await this.save(this.data!);
      invariant(!this.closed && !this.signingOut.has(id), 'CHATGPT_SIGNED_OUT', '账号已退出，请重新登录');
      invariant(!this.usageBlocked.has(id), 'CHATGPT_USAGE_LIMIT', '订阅额度受限，请管理用量后重新检查');
      let account = this.account(id);
      invariant(account.accessToken, 'CHATGPT_SIGNED_OUT', 'ChatGPT 账号需要重新登录');
      if (Date.now() >= account.expiresAt - 60000 && Date.now() >= account.earliestRefreshAt) {
        invariant(account.refreshToken, 'CHATGPT_EXPIRED', 'ChatGPT 登录已过期，请重新登录');
        await this.metadata();
        try {
          const body = await this.json(this.discovery.token_endpoint, {
            method: 'POST',
            body: new URLSearchParams({
              grant_type: 'refresh_token',
              client_id: account.clientId,
              refresh_token: account.refreshToken,
              resource,
            }),
          });
          if (body.id_token) {
            const identity = await this.identity(body.id_token, account.clientId);
            invariant(identity.subject === account.subject, 'OIDC_ACCOUNT', '续期返回的账号身份不一致');
          }
          account = { ...account, ...this.tokens(body, account) };
          await this.replace(account);
        } catch (error) {
          if (
            error instanceof AppError &&
            [
              'invalid_grant',
              'invalid_refresh_token',
              'token_expired',
              'refresh_token_expired',
              'refresh_token_invalidated',
              'refresh_token_reused',
            ].includes(error.code)
          )
            await this.clear(account);
          throw error;
        }
      }
      invariant(account.expiresAt > Date.now(), 'CHATGPT_EXPIRED', '订阅凭据已过期，请稍后续期或重新登录');
      invariant(account.scopes.includes(permission), 'CHATGPT_PERMISSION', '请先授权使用 ChatGPT 订阅');
      invariant(!this.signingOut.has(id), 'CHATGPT_SIGNED_OUT', '账号正在退出');
      if (!this.controllers.has(id)) this.controllers.set(id, new AbortController());
      return {
        token: account.accessToken!,
        signal: this.controllers.get(id)!.signal,
        /**
         * 在本进程封锁指定账号后续模型调用，直到用户显式请求重试额度。
         * EN: Blocks subsequent model calls for this account in-process until explicit usage retry.
         */
        onUsageLimit: () => {
          this.usageBlocked.add(id);
        },
      };
    });
  }
  /**
   * 取得可用账号凭据后读取订阅目录，仅公开可列出且具有有效 slug 的型号，不返回授权头或原始账号正文。
   * EN: Obtains valid credentials and reads subscription models, exposing only list-visible string slugs without auth headers/account bodies.
   */
  async models(id: string) {
    const credential = await this.credential(id);
    const body = await this.json(resource + '/models', {
      headers: { Authorization: 'Bearer ' + credential.token },
      signal: credential.signal,
    });
    invariant(Array.isArray(body.models), 'CHATGPT_MODELS', 'OpenAI 未返回订阅模型目录');
    return body.models
      .filter((m: any) => m.visibility === 'list' && typeof m.slug === 'string')
      .map((m: any) => ({ id: m.slug, name: typeof m.display_name === 'string' ? m.display_name : m.slug }));
  }
  /**
   * 先中止账号在途请求，再保存已清除访问/刷新/身份令牌的账号；持久化失败保留错误和内存新状态。
   * EN: Aborts account requests before saving cleared access/refresh/ID tokens; persistence errors retain the new memory state and propagate.
   */
  private async clear(account: Account) {
    this.controllers.get(account.id)?.abort();
    this.controllers.delete(account.id);
    await this.replace({
      ...account,
      accessToken: undefined,
      refreshToken: undefined,
      idToken: undefined,
      expiresAt: 0,
    });
  }
  /**
   * 加载保险库后在串行区保存用户已阅读欢迎信息的标记，不修改其他账号字段。
   * EN: Loads the vault then serially persists the welcomed marker without changing other account fields.
   */
  async welcome(id: string) {
    await this.load();
    await this.exclusive(() => this.replace({ ...this.account(id), welcomed: true }));
  }
  /**
   * 确认账号存在后解除本进程额度封锁，不宣称远端额度已经恢复。
   * EN: Confirms account existence and clears the local quota block without claiming remote quota recovery.
   */
  retryUsage(id: string) {
    this.account(id);
    this.usageBlocked.delete(id);
  }
  /**
   * 先中止该账号在途调用，再尝试远端撤销并清除本机凭据；远端失败单独报告而不阻止本机退出。
   * EN: Aborts account requests first, then attempts remote revocation and clears local credentials; remote failure is reported separately without preventing local logout.
   */
  async logout(id: string) {
    await this.load();
    this.signingOut.add(id);
    this.controllers.get(id)?.abort();
    if (this.pending?.accountId === id) this.cancel();
    try {
      return await this.exclusive(async () => {
        const account = this.account(id);
        let revoked = !account.refreshToken;
        if (account.refreshToken) {
          try {
            await this.metadata();
            for (let tries = 0; tries < 2; tries++) {
              try {
                const response = await this.request(this.discovery.revocation_endpoint, {
                  method: 'POST',
                  redirect: 'error',
                  signal: AbortSignal.timeout(10000),
                  body: new URLSearchParams({
                    token: account.refreshToken,
                    token_type_hint: 'refresh_token',
                    client_id: account.clientId,
                  }),
                });
                await response.body?.cancel();
                revoked = response.status === 200;
                if (revoked || response.status < 500) break;
              } catch {
                /**
                 * 仍有刷新令牌时，允许重试临时传输失败。
                 * EN: Retry transient transport failures while the refresh token is available.
                 */
              }
              if (tries === 0) await new Promise((resolve) => setTimeout(resolve, 750));
            }
          } catch {
            /**
             * 即使远端撤销不可用，本地退出仍应完成。
             * EN: The local sign-out still completes if remote revocation is unavailable.
             */
          }
        }
        await this.clear(account);
        return {
          revoked,
          message: revoked
            ? '已退出此账号'
            : '本机凭据已清除；远端撤销未确认，可在 ChatGPT 设置中断开 Elysia',
        };
      });
    } finally {
      this.signingOut.delete(id);
    }
  }
  /**
   * 禁止新工作、取消登录和账号请求，等待凭据串行队列收束后再由宿主释放桌面服务。
   * EN: Rejects new work, cancels login/account requests and waits for the credential queue before the host releases desktop services.
   */
  async close() {
    this.closed = true;
    this.cancel();
    for (const controller of this.controllers.values()) controller.abort();
    await this.queue;
  }
}
