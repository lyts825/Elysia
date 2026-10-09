import type { WorkspaceSurface } from '../../../packages/contracts/src/index';

export const localSurface: WorkspaceSurface = (() => {
  const requested = new URLSearchParams(typeof location === 'undefined' ? '' : location.search).get(
    'surface',
  );
  return requested === 'terminal' ? 'terminal' : 'native';
})();
const apiPrefix = localSurface === 'terminal' ? '/terminal/api' : '/api';
export const apiUrl = (path: string) => apiPrefix + path;
export const surfaceStorageKey = (key: string) => (localSurface === 'terminal' ? key + ':terminal' : key);
export function surfaceLocation(surface: WorkspaceSurface): string {
  const url = new URL(location.href);
  if (surface === 'terminal') url.searchParams.set('surface', 'terminal');
  else url.searchParams.delete('surface');
  return url.pathname + url.search + url.hash;
}

let csrf = '';
export class ApiError extends Error {
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
export async function api<T = any>(
  path: string,
  body?: unknown,
  method?: string,
  signal?: AbortSignal,
): Promise<T> {
  const request: RequestInit = {
    method: method || (body ? 'POST' : 'GET'),
    credentials: 'same-origin',
    headers: { ...(body ? { 'Content-Type': 'application/json', 'X-Elysia-Csrf': csrf } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal,
  };
  let response: Response;
  let text: string;
  try {
    response = await fetch(apiUrl(path), request);
    text = await response.text();
  } catch (error) {
    if (signal && (signal.aborted || (error instanceof Error && error.name === 'AbortError'))) throw error;
    throw new ApiError('无法连接本机服务，请确认 Elysia 已启动后重试。', 'network');
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
export async function apiBytes(path: string, signal?: AbortSignal): Promise<Uint8Array> {
  let response: Response;
  try {
    response = await fetch(apiUrl(path), { method: 'GET', credentials: 'same-origin', signal });
  } catch (error) {
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
      message ? `${message}（HTTP ${response.status}）` : `本机请求失败（HTTP ${response.status}），请重试。`,
      'http',
      response.status,
      typeof result?.code === 'string' ? result.code : undefined,
    );
  } catch (error) {
    if (
      signal?.aborted ||
      (error instanceof Error && error.name === 'AbortError') ||
      error instanceof ApiError
    )
      throw error;
    throw new ApiError('无法连接本机服务，请确认 Elysia 已启动后重试。', 'network');
  }
}
export const mutation = <T = any>(path: string, body: Record<string, unknown>, method = 'POST') =>
  api<T>(path, { commandId: crypto.randomUUID(), ...body }, method);
let sessionPromise: Promise<string | undefined> | null = null;
let sessionFailure: unknown;
let bootstrapToken: string | null = null;
let bootstrapRead = false;
export function initializeSession(options?: { retry?: boolean }) {
  if (sessionPromise) return sessionPromise;
  if (sessionFailure && (!options?.retry || !canRetryConnection(sessionFailure)))
    return Promise.reject(sessionFailure);
  const retry = !!sessionFailure;
  sessionPromise = (async () => {
    if (!bootstrapRead) {
      bootstrapRead = true;
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
        if (!(error instanceof ApiError) || error.code !== 'SESSION_REQUIRED' || !bootstrapToken) throw error;
        // Only an explicit retry may reuse the in-memory token, once, after checking the cookie.
        result = await api('/session', { token: bootstrapToken });
      }
    }
    if (typeof result?.csrf !== 'string' || !result.csrf.trim())
      throw new ApiError('本机服务返回的会话无法读取，请重新打开 Elysia。', 'protocol', 200);
    csrf = result.csrf;
    bootstrapToken = null;
    sessionFailure = undefined;
    return typeof result.selectionScope === 'string' && result.selectionScope.trim()
      ? localSurface === 'terminal'
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
