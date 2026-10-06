let csrf = '';
export async function api<T = any>(path: string, body?: unknown, method?: string): Promise<T> {
  const response = await fetch('/api' + path, {
    method: method || (body ? 'POST' : 'GET'),
    credentials: 'same-origin',
    headers: { ...(body ? { 'Content-Type': 'application/json', 'X-Elysia-Csrf': csrf } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.message || '请求失败');
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
