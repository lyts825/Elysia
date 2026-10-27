/** 管理订阅服务及其状态。 */
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

/** OAuth secrets stay in the backend and the OS-encrypted desktop vault. */
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
  constructor(
    private desktop?: DesktopServices,
    private request: typeof fetch = fetch,
  ) {}

  private exclusive<T>(action: () => Promise<T>): Promise<T> {
    const result = this.queue.then(action);
    this.queue = result.catch(() => {});
    return result;
  }
  private async save(data: VaultData) {
    // Retain rotated tokens in memory even if the disk write fails. Never reuse the old refresh token.
    this.data = data;
    this.vaultDirty = true;
    await this.desktop!.request('vault-write', data);
    this.vaultDirty = false;
  }
  private async load() {
    invariant(this.desktop, 'DESKTOP_REQUIRED', 'ChatGPT 订阅登录需要从 Elysia 桌面入口启动');
    return (this.loading ??= (async () => {
      const stored = await this.desktop!.request('vault-read');
      if (stored) this.data = Vault.parse(stored);
      else await this.save({ version: 1, hostId: 'urn:uuid:' + randomUUID(), accounts: [] });
    })());
  }
  private account(id: string) {
    const account = this.data?.accounts.find((a) => a.id === id);
    invariant(account, 'CHATGPT_ACCOUNT', '找不到订阅账号，请在模型设置中登录');
    return account;
  }
  private async replace(account: Account) {
    const others = this.data!.accounts.filter((a) => a.id !== account.id);
    await this.save({ ...this.data!, accounts: [...others, account] });
  }
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
  async start(accountId?: string, consent = false) {
    return this.exclusive(() => this.startLogin(accountId, consent));
  }
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
      attempt.status = 'exchanging'; // Consume once, before any asynchronous work.
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
    return { id: attempt.id }; // Never return authorization URLs with retained ID tokens to the renderer.
  }
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
        onUsageLimit: () => {
          this.usageBlocked.add(id);
        },
      };
    });
  }
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
  async welcome(id: string) {
    await this.load();
    await this.exclusive(() => this.replace({ ...this.account(id), welcomed: true }));
  }
  retryUsage(id: string) {
    this.account(id);
    this.usageBlocked.delete(id);
  }
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
                /* Retry transient transport failures while the refresh token is available. */
              }
              if (tries === 0) await new Promise((resolve) => setTimeout(resolve, 750));
            }
          } catch {
            /* The local sign-out still completes if remote revocation is unavailable. */
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
  async close() {
    this.closed = true;
    this.cancel();
    for (const controller of this.controllers.values()) controller.abort();
    await this.queue;
  }
}
