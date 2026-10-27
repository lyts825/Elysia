/**
 * 封装各界面与本地服务通信的客户端、错误处理和请求能力。
 * 为原生和终端分别绑定路由、CSRF、事件流及存储键，分类网络/HTTP/协议错误并对读取限时；写入未知结果不自动重试。
 * EN: Provides surface-bound local-service clients, errors, and request helpers. Binds routes, CSRF, event streams, and storage keys separately for native/terminal surfaces, classifies network/HTTP/protocol errors, and bounds reads; unknown writes are not retried automatically.
 */
import type { WorkspaceSurface } from '../../../packages/contracts/src/index';
import { ReadDeadline } from './ReadCoordinator';

export const localSurface: WorkspaceSurface = (() => {
  const requested = new URLSearchParams(typeof location === 'undefined' ? '' : location.search).get(
    'surface',
  );
  return requested === 'terminal' ? 'terminal' : 'native';
})();
/**
 * 生成切换入口后的同源相对地址，只改变 surface 参数并保留其他查询及锚点。
 * EN: Build same-origin relative surface-switch URL, changing only surface while preserving other query/hash values.
 */
export function surfaceLocation(surface: WorkspaceSurface): string {
  const url = new URL(location.href);
  if (surface === 'terminal') url.searchParams.set('surface', 'terminal');
  else url.searchParams.delete('surface');
  return url.pathname + url.search + url.hash;
}

/**
 * 区分传输、HTTP 拒绝和响应协议错误，供界面决定重试、重新连接或保留未知写入回执。
 * EN: Distinguish transport/HTTP/protocol errors for retry, reconnect, or unknown-write receipt handling.
 */
export class ApiError extends Error {
  /**
   * 构建带网络、HTTP或协议类别的请求错误，保留可选状态码和业务码，供界面区分重试与明确拒绝。
   * EN: Builds a request error classified as network, HTTP, or protocol while retaining optional status/business codes for retry and definitive-rejection decisions.
   */
  constructor(
    message: string,
    public readonly kind: 'network' | 'http' | 'protocol',
    public readonly status?: number,
    public readonly code?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}
/**
 * 只对暂时性网络故障或服务端错误开放重试；会话和来源校验失败须重新建立环境。
 * EN: Retry transient network/server errors only; session/origin validation failures require rebuilding context.
 */
export function canRetryConnection(error: unknown) {
  return (
    error instanceof ApiError &&
    !['SESSION_REQUIRED', 'BOOTSTRAP_EXPIRED', 'HOST_DENIED', 'ORIGIN_DENIED', 'ORIGIN_REQUIRED'].includes(
      error.code || '',
    ) &&
    (error.kind === 'network' ||
      (error.kind === 'http' && (error.status || 0) >= 500 && (error.status || 0) < 600))
  );
}
/**
 * 建立永久绑定一个入口的客户端，闭包单独保存 CSRF、认证范围和初始化结果。
 * 调用方可在界面切换后继续完成原入口的请求，不能根据当前页面全局变量临时改目的地。
 * EN: Create a permanently surface-bound client whose closure owns CSRF/auth scope/initialization. Async actions retain original destination even after UI surface switching instead of consulting global state.
 */
export function createSurfaceClient(surface: WorkspaceSurface) {
  /**
   * 入口和存储键在客户端创建时固定，异步回调不会因切换页面改写另一个入口的草稿。
   * EN: Freeze endpoint/storage scope at creation so async callbacks cannot modify another surface's draft.
   */
  const apiPrefix = surface === 'terminal' ? '/terminal/api' : '/api';
  /**
   * 把相对API路径绑定到当前入口前缀，确保原生与终端请求使用各自路由。
   * EN: Binds relative API paths to the current surface prefix so native and terminal requests use their corresponding routes.
   */
  const apiUrl = (path: string) => apiPrefix + path;
  /**
   * 为终端入口增加固定键后缀，隔离与原生入口同名的浏览器缓存。
   * EN: Adds a stable suffix for the terminal surface, isolating browser caches with the same base key from the native surface.
   */
  const surfaceStorageKey = (key: string) => (surface === 'terminal' ? key + ':terminal' : key);
  let csrf = '';
  let workbenchScope: string | undefined;
  /**
   * 读取或写入 JSON。未指定方法时按是否有 body 选择 GET/POST，有 body 才附 CSRF。
   * GET 同时限制响应读取时间；取消原样向上传递，其余错误归类为 ApiError。
   * 写入不自动重试，因为连接失败可能发生在服务端已提交之后。
   * EN: Read/write JSON; default GET/POST depends on body presence and attach CSRF only for bodies. GET deadline covers response reading. Propagate cancellation, classify other failures as ApiError. Never auto-retry writes because server may already have committed.
   */
  async function api<T = any>(
    path: string,
    body?: unknown,
    method?: string,
    signal?: AbortSignal,
  ): Promise<T> {
    const verb = method || (body ? 'POST' : 'GET');
    /**
     * 自动超时只适用于读取；写入超时后的副作用可能未知，不能直接当作可重试失败。
     * EN: Automatic deadline applies only to reads; timed-out writes may have unknown effects rather than retryable failure.
     */
    const deadline = verb === 'GET' ? new ReadDeadline(signal) : undefined;
    const request: RequestInit = {
      method: verb,
      credentials: 'same-origin',
      headers: { ...(body ? { 'Content-Type': 'application/json', 'X-Elysia-Csrf': csrf } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: deadline?.signal ?? signal,
    };
    let response: Response;
    let text: string;
    try {
      response = await fetch(apiUrl(path), request);
      text = await response.text();
    } catch (error) {
      if (deadline?.expired)
        throw new ApiError('读取本机服务超时，请重试。', 'network', undefined, 'READ_TIMEOUT');
      if (signal && (signal.aborted || (error instanceof Error && error.name === 'AbortError'))) throw error;
      throw new ApiError('无法连接本机服务，请确认 Elysia 已启动后重试。', 'network');
    } finally {
      deadline?.clear();
    }
    const failed = `本机请求失败（HTTP ${response.status}），请重试。`;
    let result: any;
    try {
      result = JSON.parse(text);
    } catch {
      if (!response.ok) throw new ApiError(failed, 'http', response.status);
      if (response.status === 204) return undefined as T;
      throw new ApiError('本机服务返回的数据无法读取，请重新打开 Elysia。', 'protocol', response.status);
    }
    if (!response.ok) {
      const message = typeof result?.message === 'string' ? result.message.trim() : '';
      throw new ApiError(
        message ? `${message}（HTTP ${response.status}）` : failed,
        'http',
        response.status,
        typeof result?.code === 'string' ? result.code : undefined,
      );
    }
    return result;
  }
  /**
   * 下载原始字节，超时覆盖 fetch 和正文读取；非成功响应仍尝试读取服务端 JSON 错误。
   * EN: Download raw bytes with deadline covering fetch/body; non-success still attempts server JSON error parsing.
   */
  async function apiBytes(path: string, signal?: AbortSignal): Promise<Uint8Array> {
    const deadline = new ReadDeadline(signal);
    let response: Response;
    try {
      response = await fetch(apiUrl(path), {
        method: 'GET',
        credentials: 'same-origin',
        signal: deadline.signal,
      });
    } catch (error) {
      deadline.clear();
      if (deadline.expired)
        throw new ApiError('读取本机服务超时，请重试。', 'network', undefined, 'READ_TIMEOUT');
      if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) throw error;
      throw new ApiError('无法连接本机服务，请确认 Elysia 已启动后重试。', 'network');
    }
    try {
      if (response.ok) return new Uint8Array(await response.arrayBuffer());
      let result: any;
      try {
        result = JSON.parse(await response.text());
      } catch (error) {
        if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) throw error;
      }
      const message = typeof result?.message === 'string' ? result.message.trim() : '';
      throw new ApiError(
        message
          ? `${message}（HTTP ${response.status}）`
          : `本机请求失败（HTTP ${response.status}），请重试。`,
        'http',
        response.status,
        typeof result?.code === 'string' ? result.code : undefined,
      );
    } catch (error) {
      if (deadline.expired)
        throw new ApiError('读取本机服务超时，请重试。', 'network', undefined, 'READ_TIMEOUT');
      if (
        signal?.aborted ||
        (error instanceof Error && error.name === 'AbortError') ||
        error instanceof ApiError
      )
        throw error;
      throw new ApiError('无法连接本机服务，请确认 Elysia 已启动后重试。', 'network');
    } finally {
      deadline.clear();
    }
  }
  /**
   * 默认附加幂等命令 ID；调用方已提供 commandId 时保留，以核对同一未知写入。
   * EN: Add idempotent command ID by default, preserving caller-supplied ID to reconcile the same unknown write.
   */
  const mutation = <T = any>(path: string, body: Record<string, unknown>, method = 'POST') =>
    api<T>(path, { commandId: crypto.randomUUID(), ...body }, method);
  let sessionPromise: Promise<string | undefined> | null = null;
  let sessionFailure: unknown;
  let bootstrapToken: string | null = null;
  let bootstrapRead = false;
  /**
   * 一次性消费地址栏启动令牌并缓存认证 Promise，合并同入口并发初始化。
   * 显式重试先检查已有 Cookie，仅在 SESSION_REQUIRED 时复用内存令牌；成功或不可重试
   * 失败后立即清除令牌。返回值用于选择范围，工作台草稿范围另保存在 workbenchScope。
   * EN: Consume URL bootstrap token once and cache auth Promise across concurrent initialization. Explicit retry checks cookie, reusing in-memory token only after SESSION_REQUIRED. Clear token after success/non-retryable failure. Return selection scope separately from stored workbenchScope.
   */
  function initializeSession(options?: { retry?: boolean }) {
    /**
     * 合并并发初始化；明确不可重试的失败会保留，直到调用方重新建立上下文。
     * EN: Coalesce initialization; retain non-retryable failure until caller rebuilds context.
     */
    if (sessionPromise) return sessionPromise;
    if (sessionFailure && (!options?.retry || !canRetryConnection(sessionFailure)))
      return Promise.reject(sessionFailure);
    const retry = !!sessionFailure;
    sessionPromise = (async () => {
      if (!bootstrapRead) {
        bootstrapRead = true;
        /**
         * 启动令牌只读取一次，并立即从地址栏移除；可重试期间暂存在内存。
         * EN: Read bootstrap token once, immediately remove it from URL, and retain in memory only during retry window.
         */
        const params = new URLSearchParams(location.hash.slice(1));
        bootstrapToken = params.get('bootstrap');
        if (bootstrapToken) history.replaceState(null, '', location.pathname + location.search);
      }
      let result: any;
      if (!retry) result = await api('/session', bootstrapToken ? { token: bootstrapToken } : undefined);
      else {
        try {
          result = await api('/session');
        } catch (error) {
          if (!(error instanceof ApiError) || error.code !== 'SESSION_REQUIRED' || !bootstrapToken)
            throw error;
          /**
           * 只有明确重试检查 Cookie 后才可再次使用内存令牌一次。
           * EN: Only an explicit retry may reuse the in-memory token, once, after checking the cookie.
           */
          result = await api('/session', { token: bootstrapToken });
        }
      }
      if (typeof result?.csrf !== 'string' || !result.csrf.trim())
        throw new ApiError('本机服务返回的会话无法读取，请重新打开 Elysia。', 'protocol', 200);
      csrf = result.csrf;
      workbenchScope =
        typeof result.workbenchScope === 'string' && /^[a-f0-9]{64}$/.test(result.workbenchScope)
          ? result.workbenchScope
          : undefined;
      bootstrapToken = null;
      sessionFailure = undefined;
      return typeof result.selectionScope === 'string' && result.selectionScope.trim()
        ? surface === 'terminal'
          ? `${result.selectionScope}:terminal`
          : result.selectionScope
        : undefined;
    })().catch((error) => {
      sessionPromise = null;
      sessionFailure = error;
      if (!canRetryConnection(error)) bootstrapToken = null;
      throw error;
    });
    return sessionPromise;
  }
  return {
    surface,
    api,
    apiBytes,
    apiUrl,
    mutation,
    initializeSession,
    surfaceStorageKey,
    /**
     * 返回客户端初始化后取得的工作台作用域；尚未建立身份时保持undefined，供缓存层延后绑定。
     * EN: Returns the workbench scope obtained during client initialization, remaining undefined until identity is established so the cache can defer binding.
     */
    workbenchScope: () => workbenchScope,
  };
}
export type SurfaceClient = ReturnType<typeof createSurfaceClient>;
/**
 * 独立辅助模块仍可直接导入；React 工作台通过
 * EN: Keep direct imports usable by standalone helper consumers; React workbenches
 */
/**
 * SurfaceClientContext 取得各自永久绑定客户端。
 * EN: receive their own permanently bound client through SurfaceClientContext.
 */
export const defaultSurfaceClient = createSurfaceClient(localSurface);
export const { api, apiBytes, apiUrl, mutation, initializeSession, surfaceStorageKey } = defaultSurfaceClient;
