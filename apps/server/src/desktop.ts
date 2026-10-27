/** 定义并获取桌面环境提供的服务。 */
import { randomUUID } from 'node:crypto';
import { AppError } from '../../../packages/contracts/src/index.js';

export interface DesktopServices {
  /** 只允许列出的桌面操作；明文秘密仅在父子进程 IPC 中传递，持久化由桌面安全存储处理。 */
  request(
    operation:
      | 'vault-read'
      | 'vault-write'
      | 'key-vault-read'
      | 'key-vault-write'
      | 'terminal-key-vault-read'
      | 'terminal-key-vault-write'
      | 'open-auth',
    value?: unknown,
  ): Promise<any>;
}
/** 仅在桌面子进程启用 IPC；每个请求以随机 ID 匹配响应，并在 15 秒后超时。 */
export function desktopServices(): DesktopServices | undefined {
  if (!process.send || process.env.ELYSIA_DESKTOP !== '1') return undefined;
  return {
    request(operation, value) {
      return new Promise((resolve, reject) => {
        const id = randomUUID();
        const finish = (error?: string, result?: unknown) => {
          // 每次完成都移除专属监听和超时，避免长期账号操作积累 message 监听器。
          clearTimeout(timer);
          process.off('message', receive);
          if (error) reject(new AppError('DESKTOP_SERVICE', error));
          else resolve(result);
        };
        const receive = (message: any) => {
          if (message?.type === 'desktop-response' && message.id === id) finish(message.error, message.value);
        };
        const timer = setTimeout(() => finish('桌面服务未响应'), 15000);
        process.on('message', receive);
        process.send!(
          { type: 'desktop-request', id, operation, value },
          undefined,
          undefined,
          (error: Error | null) => {
            if (error) finish('桌面连接已断开');
          },
        );
      });
    },
  };
}
