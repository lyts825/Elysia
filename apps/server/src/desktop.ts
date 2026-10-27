/**
 * 定义并获取桌面环境提供的服务。
 * 以随机请求 ID 关联宿主响应，处理超时和断连并清理监听；实际系统保险库/浏览器操作由桌面宿主完成。
 * EN: Defines and acquires services supplied by the desktop environment. Correlates host replies by random IDs with timeout/disconnect/listener cleanup; the desktop host implements vault/browser operations.
 */
import { randomUUID } from 'node:crypto';
import { AppError } from '../../../packages/contracts/src/index.js';

export interface DesktopServices {
  /**
   * 只允许列出的桌面操作；明文秘密仅在父子进程 IPC 中传递，持久化由桌面安全存储处理。
   * EN: Allows only enumerated desktop operations. Plaintext secrets pass only through parent/child IPC; desktop secure storage owns persistence.
   */
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
/**
 * 仅在桌面子进程启用 IPC；每个请求以随机 ID 匹配响应，并在 15 秒后超时。
 * EN: Enables IPC only in desktop child processes. Each request has a random response ID and a 15-second timeout.
 */
export function desktopServices(): DesktopServices | undefined {
  if (!process.send || process.env.ELYSIA_DESKTOP !== '1') return undefined;
  return {
    /**
     * 通过进程 IPC 发出带随机 ID 的桌面能力请求并等待对应响应；超时或发送失败转为领域错误，结果不跨请求共享。
     * EN: Sends an ID-correlated desktop IPC capability request and waits for its response; timeout/send failures become domain errors without cross-request result reuse.
     */
    request(operation, value) {
      return new Promise((resolve, reject) => {
        const id = randomUUID();
        /**
         * 移除定时器和消息监听后结算当前承诺；成功返回值，失败转 DESKTOP_SERVICE 错误。
         * EN: Removes timer/message listener before settling the promise with either its value or a DESKTOP_SERVICE error.
         */
        const finish = (error?: string, result?: unknown) => {
          /**
           * 每次完成都移除专属监听和超时，避免长期账号操作积累 message 监听器。
           * EN: Removes per-request listeners and timers on completion to prevent accumulated message listeners during long-lived account use.
           */
          clearTimeout(timer);
          process.off('message', receive);
          if (error) reject(new AppError('DESKTOP_SERVICE', error));
          else resolve(result);
        };
        /**
         * 仅接收类型和随机 ID 同时匹配的桌面回执，忽略其他并发请求消息。
         * EN: Accepts only matching response type and random ID, ignoring messages from concurrent requests.
         */
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
