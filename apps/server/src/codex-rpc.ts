/** 封装 Codex 进程发现和 RPC 通信。 */
import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { promisify } from 'node:util';
import { AppError, VERSION } from '../../../packages/contracts/src/index.js';

// Process-only overrides: never write the user's Codex configuration or read auth.json.
export const codexConfig: Record<string, string | boolean | number | string[]> = {
  model_provider: 'openai',
  forced_login_method: 'chatgpt',
  web_search: 'disabled',
  'features.respect_system_proxy': true,
  'features.system_proxy_fallback': true,
  'features.shell_tool': false,
  'features.plugins': false,
  'features.apps': false,
  'features.code_mode': false,
  'features.code_mode_only': false,
  'features.code_mode_host': false,
  'features.multi_agent': false,
  'features.multi_agent_v2': false,
  'features.codex_hooks': false,
  'features.hooks': false,
  'features.memories': false,
  'features.memory_tool': false,
  'features.skill_search': false,
  'features.skip_host_skill_discovery': true,
  'features.image_generation': false,
  'features.imagegenext': false,
  'features.browser_use': false,
  'features.computer_use': false,
  'features.shell_snapshot': false,
  'features.sleep_tool': false,
  'features.tool_suggest': false,
  'features.deferred_executor': false,
  'features.context_management': false,
  'features.token_budget': false,
  'features.goals': false,
  'tools.update_plan.enabled': false,
  'tools.experimental_request_user_input.enabled': false,
  include_environment_context: false,
  include_apps_instructions: false,
  project_doc_max_bytes: 0,
  notify: [],
};

/** 从显式路径、系统 PATH 或 Windows 桌面安装目录查找 Codex，并校验版本。 */
export async function findCodex(): Promise<{ binary: string; version: string }> {
  const explicit = process.env.ELYSIA_CODEX_BINARY;
  const candidates: string[] = explicit ? [path.resolve(explicit)] : [];
  if (!explicit) {
    for (const directory of (process.env.PATH || '').split(path.delimiter))
      if (directory)
        candidates.push(path.join(directory, process.platform === 'win32' ? 'codex.exe' : 'codex'));
    if (process.platform === 'win32') {
      const root = path.join(
        process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
        'OpenAI',
        'Codex',
        'bin',
      );
      const directories = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
      const versions = await Promise.all(
        directories
          .filter((d) => d.isDirectory())
          .map(async (d) => {
            const binary = path.join(root, d.name, 'codex.exe');
            return { binary, modified: (await fs.stat(binary).catch(() => null))?.mtimeMs || 0 };
          }),
      );
      candidates.push(...versions.sort((a, b) => b.modified - a.modified).map((v) => v.binary));
    }
  }
  for (const binary of [...new Set(candidates)]) {
    if (!(await fs.stat(binary).catch(() => null))?.isFile()) continue;
    try {
      const { stdout } = await promisify(execFile)(binary, ['--version'], {
        windowsHide: true,
        timeout: 5000,
        maxBuffer: 4096,
      });
      const version = /codex-cli (\d+)\.(\d+)\.(\d+)/.exec(stdout);
      if (!version || (Number(version[1]) === 0 && Number(version[2]) < 160))
        throw new AppError('CODEX_VERSION', '订阅通道需要 Codex CLI 0.160.0 或更新版本，请更新 Codex');
      return { binary, version: version[0].replace('codex-cli ', '') };
    } catch (e) {
      if (e instanceof AppError) throw e;
    }
  }
  throw new AppError(
    'CODEX_MISSING',
    '未找到 Codex CLI。请安装 Codex 桌面版，或设置 ELYSIA_CODEX_BINARY 为 codex 可执行文件路径',
  );
}

/** 维护 Codex 子进程 RPC 会话，按请求 ID 管理等待响应和超时。 */
export class CodexRpc extends EventEmitter {
  private child: ChildProcessWithoutNullStreams;
  private pending = new Map<
    number,
    { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >();
  private sequence = 0;
  private closed = false;
  private buffer = '';
  constructor(binary: string, cwd: string, home?: string) {
    super();
    const env: NodeJS.ProcessEnv = { ...process.env, ...(home ? { CODEX_HOME: home } : {}) };
    delete env.OPENAI_API_KEY;
    delete env.OPENAI_BASE_URL;
    this.child = spawn(
      binary,
      [
        'app-server',
        '--listen',
        'stdio://',
        ...Object.entries(codexConfig).flatMap(([k, v]) => ['-c', `${k}=${JSON.stringify(v)}`]),
      ],
      {
        cwd,
        env,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (part: string) => {
      this.buffer += part;
      if (this.buffer.length > 16 * 1024 * 1024)
        return this.close(new AppError('CODEX_PROTOCOL', 'Codex 响应超过限制'));
      let split: number;
      while ((split = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, split);
        this.buffer = this.buffer.slice(split + 1);
        if (!line.trim()) continue;
        let message: any;
        try {
          message = JSON.parse(line);
        } catch {
          this.close(new AppError('CODEX_PROTOCOL', 'Codex 返回了无效协议数据'));
          return;
        }
        if (message.id !== undefined && !message.method) {
          const request = this.pending.get(message.id);
          if (!request) continue;
          this.pending.delete(message.id);
          clearTimeout(request.timer);
          if (message.error) request.reject(new AppError('CODEX_RPC', cleanError(message.error.message)));
          else request.resolve(message.result);
        } else if (message.id !== undefined) {
          // This adapter performs one inference only. Every actual action goes through Elysia's gateway.
          this.send({
            id: message.id,
            error: { code: -32601, message: 'Native tool execution is disabled in Elysia' },
          });
          this.emit('unexpectedRequest', message);
        } else this.emit('notification', message);
      }
    });
    // Vendor stderr may include private request context. Do not persist or forward it.
    this.child.stderr.resume();
    this.child.stdin.on('error', () => this.close(new AppError('CODEX_DISCONNECTED', 'Codex 连接已中断')));
    this.child.on('error', () =>
      this.close(new AppError('CODEX_START', '无法启动 Codex，请检查可执行文件与版本')),
    );
    this.child.on('exit', () =>
      this.close(new AppError('CODEX_EXIT', 'Codex 已退出，请重新连接；也请检查 Codex 配置是否有效')),
    );
  }
  private send(message: unknown) {
    if (!this.closed) this.child.stdin.write(JSON.stringify(message) + '\n');
  }
  /** 为单次 RPC 分配递增 ID 和独立超时；迟到响应找不到 pending 时忽略，不归属给后续请求。 */
  call(method: string, params: unknown, timeout = 30000): Promise<any> {
    if (this.closed) return Promise.reject(new AppError('CODEX_DISCONNECTED', 'Codex 连接已关闭'));
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new AppError('CODEX_TIMEOUT', 'Codex 连接超时，请检查系统代理和网络后重新连接', true));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ id, method, params });
    });
  }
  /** 完成协议初始化再发 initialized 通知，调用方必须等待后才能使用账号和推理接口。 */
  async initialize() {
    await this.call('initialize', {
      clientInfo: { name: 'elysia', title: 'Elysia', version: VERSION },
      capabilities: { experimentalApi: true },
    });
    this.send({ method: 'initialized' });
  }
  /** 幂等结束进程、拒绝全部在途 RPC 并清监听器；进程退出不被当作有效空响应。 */
  close(error = new AppError('CODEX_CLOSED', 'Codex 连接已关闭')) {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(error);
    }
    this.pending.clear();
    this.child.kill();
    this.emit('closed', error);
    this.removeAllListeners();
  }
}

/** 清理错误文本中的凭据样式和服务地址，并限制返回长度。 */
export function cleanError(value: unknown) {
  return String(value || 'Codex 请求失败')
    .replace(/(?:Bearer\s+|sk-)[\w.\-]+/gi, '[redacted]')
    .replace(/https?:\/\/[^\s"<>]+/g, '[服务地址]')
    .slice(0, 500);
}
