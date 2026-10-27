/** 在本地端口启动监听。 */
import type { FastifyInstance } from 'fastify';

/** 仅监听回环地址；首选端口被占用时让系统分配端口，并返回实际端口。 */
/** The OS reserves the fallback port atomically, with no probe/bind race. */
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
