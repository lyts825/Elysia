/**
 * 在本地端口启动监听。
 * 处理本地端口监听与地址返回，使用实际分配端口；只管理监听，不组装业务路由或执行领域状态动作。
 * EN: Starts listening on a local port. Establishes local listeners and returns assigned addresses; owns listening rather than route composition or domain actions.
 */
import type { FastifyInstance } from 'fastify';

/**
 * 仅监听回环地址，端口 0 表示由系统分配。只有首选端口 EADDRINUSE 才回退， 权限或其他监听错误继续抛出；返回实际端口供引导链接和 Origin 校验同步使用。 操作系统原子预留回退端口，不存在先探测后绑定的竞态。
 * EN: Binds loopback only; port zero lets the OS allocate a port. Only EADDRINUSE on the preferred port triggers fallback; permission and other failures propagate. Returns the actual port for bootstrap URLs and Origin checks. The OS reserves the fallback port atomically, with no probe/bind race.
 */
export async function listenLocal(app: FastifyInstance, preferredPort: number) {
  if (
    !Number.isInteger(preferredPort) ||
    (preferredPort !== 0 && (preferredPort < 1024 || preferredPort > 65535))
  )
    throw new Error('ELYSIA_PORT 必须为 0（自动分配）或 1024–65535');
  try {
    await app.listen({ host: '127.0.0.1', port: preferredPort });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE' || preferredPort === 0) throw error;
    await app.listen({ host: '127.0.0.1', port: 0 });
  }
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('无法读取服务端口');
  return address.port;
}
