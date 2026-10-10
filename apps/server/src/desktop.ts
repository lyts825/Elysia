import { randomUUID } from 'node:crypto';
import { AppError } from '../../../packages/contracts/src/index.js';

export interface DesktopServices {
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
export function desktopServices(): DesktopServices | undefined {
  if (!process.send || process.env.ELYSIA_DESKTOP !== '1') return undefined;
  return {
    request(operation, value) {
      return new Promise((resolve, reject) => {
        const id = randomUUID();
        const finish = (error?: string, result?: unknown) => {
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
