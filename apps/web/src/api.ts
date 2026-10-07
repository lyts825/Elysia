let csrf = '';
export async function api<T = any>(path: string, body?: unknown, method?: string): Promise<T> {
  const request: RequestInit = {
    method: method || (body ? 'POST' : 'GET'),
    credentials: 'same-origin',
    headers: { ...(body ? { 'Content-Type': 'application/json', 'X-Elysia-Csrf': csrf } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  };
  let response: Response;
  let text: string;
  try {
    response = await fetch('/api' + path, request);
    text = await response.text();
  } catch {
    throw new Error('无法连接本机服务，请确认工作台已启动后重试。');
  }
  const failed = `本机请求失败（HTTP ${response.status}），请重试。`;
  let result: any;
  try {
    result = JSON.parse(text);
  } catch {
    if (!response.ok) throw new Error(failed);
    if (response.status === 204) return undefined as T;
    throw new Error('本机服务返回的数据无法读取，请刷新工作台后重试。');
  }
  if (!response.ok) {
    const message = typeof result?.message === 'string' ? result.message.trim() : '';
    throw new Error(message ? `${message}（HTTP ${response.status}）` : failed);
  }
  return result;
}
export const mutation = <T = any>(path: string, body: Record<string, unknown>, method = 'POST') =>
  api<T>(path, { commandId: crypto.randomUUID(), ...body }, method);
let sessionPromise: Promise<void> | null = null;
export function initializeSession() {
  if (!sessionPromise)
    sessionPromise = (async () => {
      const params = new URLSearchParams(location.hash.slice(1));
      const token = params.get('bootstrap');
      if (token) history.replaceState(null, '', location.pathname);
      const result = await api('/session', token ? { token } : undefined);
      csrf = result.csrf;
    })();
  return sessionPromise;
}
