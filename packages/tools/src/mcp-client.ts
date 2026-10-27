// 实现 MCP 连接、权限检查、工具发现及调用。
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { AppError } from '../../contracts/src/index.js';
import type { LocalMcpConfig } from '../../contracts/src/local-integrations.js';
import { spawnMcpProcess } from './mcp-windows.js';

const PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const TOOL_NAME = /^[A-Za-z0-9_.-]{1,128}$/;
const MAX_ARGUMENT_BYTES = 256 * 1024;

export interface McpPermission {
  exec: boolean;
  write: boolean;
  urls: string[];
}
export interface McpTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}
export interface McpInspection {
  protocolVersion: string;
  serverInfo: { name: string; version: string; title?: string };
  tools: McpTool[];
  truncated: boolean;
  trust: 'untrusted';
}
export interface McpCallResult {
  tool: string;
  result: Record<string, unknown>;
  trust: 'untrusted';
}
type RpcMessage = Record<string, unknown> & { jsonrpc: '2.0' };
type Session = {
  request(method: string, params?: Record<string, unknown>, onSent?: () => void): Promise<unknown>;
  notify(method: string): Promise<void>;
  close(): Promise<void>;
};
type ConnectionContext = {
  config: LocalMcpConfig;
  signal: AbortSignal;
  maxBytes: number;
  env: NodeJS.ProcessEnv;
  headers: Record<string, string>;
  secrets: string[];
  program?: string;
  args?: string[];
};

function failure(code: string, message: string) {
  return new AppError(code, message, false);
}
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function baseEnv(): NodeJS.ProcessEnv {
  const keys = [
    'PATH',
    'PATHEXT',
    'SystemRoot',
    'WINDIR',
    'COMSPEC',
    'TEMP',
    'TMP',
    'HOME',
    'USERPROFILE',
    'APPDATA',
    'LOCALAPPDATA',
    'LANG',
    'LC_ALL',
  ];
  return Object.fromEntries(keys.filter((key) => process.env[key]).map((key) => [key, process.env[key]]));
}
function envValue(name: string, secrets: string[]) {
  if (!ENV_NAME.test(name)) throw failure('MCP_ENV_INVALID', 'MCP 环境变量名称无效');
  const value = process.env[name];
  if (!value) throw failure('MCP_ENV_MISSING', 'MCP 所需环境变量尚未配置');
  secrets.push(value);
  return value;
}
async function prepare(
  config: LocalMcpConfig,
  signal: AbortSignal,
  maxBytes: number,
): Promise<ConnectionContext> {
  if (config.needsConfiguration)
    throw failure('MCP_CONFIGURATION', 'MCP 配置包含未迁移的参数或凭据，请配置环境变量引用并核对连接参数');
  const env = baseEnv(),
    secrets: string[] = [],
    headers: Record<string, string> = {};
  if (!Array.isArray(config.envNames) || config.envNames.length > 64)
    throw failure('MCP_CONFIGURATION', 'MCP 环境变量配置无效');
  for (const name of config.envNames) env[name] = envValue(name, secrets);
  if (!object(config.headerEnv) || Object.keys(config.headerEnv).length > 32)
    throw failure('MCP_CONFIGURATION', 'MCP 请求头配置无效');
  for (const [name, envName] of Object.entries(config.headerEnv)) {
    if (
      !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) ||
      /^(host|connection|content-length|content-type|accept|origin|mcp-session-id|mcp-protocol-version)$/i.test(
        name,
      )
    )
      throw failure('MCP_CONFIGURATION', 'MCP 请求头名称无效或属于保留请求头');
    const value = envValue(envName, secrets);
    if (/[\r\n\0]/.test(value)) throw failure('MCP_CONFIGURATION', 'MCP 请求头值无效');
    headers[name] = value;
  }
  if (config.bearerTokenEnv) headers.Authorization = 'Bearer ' + envValue(config.bearerTokenEnv, secrets);
  for (const list of [config.allowedTools, config.deniedTools])
    if (
      list !== undefined &&
      (!Array.isArray(list) ||
        list.length > 500 ||
        list.some((name) => typeof name !== 'string' || !TOOL_NAME.test(name)))
    )
      throw failure('MCP_CONFIGURATION', 'MCP 工具访问范围无效');
  if (config.transport === 'stdio') {
    if (
      !config.command ||
      config.command.length > 2048 ||
      /[\r\n\0]/.test(config.command) ||
      !Array.isArray(config.args ?? []) ||
      (config.args?.length ?? 0) > 100 ||
      (config.args ?? []).some((arg) => typeof arg !== 'string' || arg.length > 4096 || arg.includes('\0')) ||
      (config.cwd && (!path.isAbsolute(config.cwd) || config.cwd.includes('\0')))
    )
      throw failure('MCP_CONFIGURATION', 'MCP 程序、参数或工作目录无效');
  } else if (config.transport === 'http') {
    let url: URL;
    try {
      url = new URL(config.url!);
    } catch {
      throw failure('MCP_CONFIGURATION', 'MCP URL 无效');
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash)
      throw failure('MCP_CONFIGURATION', 'MCP URL 仅支持无内嵌凭据的 HTTP(S)');
  } else throw failure('MCP_CONFIGURATION', 'MCP 传输方式不支持');
  const executable =
    config.transport === 'stdio' ? await stdioExecutable(config.command!, config.args ?? []) : {};
  signal.throwIfAborted();
  return { config, signal, maxBytes, env, headers, secrets, ...executable };
}
async function stdioExecutable(command: string, args: string[]) {
  if (process.platform !== 'win32') return { program: command, args };
  const basename = path.basename(command).toLowerCase(),
    name = basename.replace(/\.(cmd|bat)$/, '');
  const entries: Record<string, string> = {
    npx: 'npm/bin/npx-cli.js',
    npm: 'npm/bin/npm-cli.js',
    pnpm: 'pnpm/bin/pnpm.cjs',
    yarn: 'yarn/bin/yarn.js',
  };
  if (!entries[name]) {
    if (/\.(cmd|bat)$/i.test(command))
      throw failure(
        'MCP_CONFIGURATION',
        'Windows MCP 请使用 node 或可执行程序；自定义批处理不通过 shell 启动',
      );
    return { program: command, args };
  }
  const isFile = async (filename: string) => {
    try {
      return (await fs.stat(filename)).isFile();
    } catch {
      return false;
    }
  };
  const directories = path.isAbsolute(command)
    ? [path.dirname(command)]
    : (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  for (const directory of directories) {
    if (!/\.(cmd|bat)$/i.test(command)) {
      const executable = path.join(directory, basename + '.exe');
      if (await isFile(executable)) return { program: executable, args };
    }
    const shim = path.isAbsolute(command) ? command : path.join(directory, name + '.cmd');
    if (!(await isFile(shim))) continue;
    const entry = path.join(directory, 'node_modules', entries[name]);
    if (await isFile(entry)) return { program: process.execPath, args: [entry, ...args] };
    throw failure('MCP_CONFIGURATION', 'Windows MCP 包管理器入口无法解析，请改为 node 和明确的脚本路径');
  }
  return { program: command, args };
}
function toolAllowed(config: LocalMcpConfig, name: string) {
  return (!config.allowedTools || config.allowedTools.includes(name)) && !config.deniedTools?.includes(name);
}
function permissionGate(config: LocalMcpConfig, permission: McpPermission | undefined, calling: boolean) {
  if (!permission || !permission.exec) throw failure('MCP_EXEC_DENIED', 'MCP 连接需要任务的执行权限');
  if (calling && !permission.write)
    throw failure('MCP_WRITE_DENIED', 'MCP 工具可能产生副作用，需要任务的写入权限');
  if (config.transport === 'http') {
    let target: string;
    try {
      target = new URL(config.url!).href;
    } catch {
      throw failure('MCP_CONFIGURATION', 'MCP URL 无效');
    }
    const allowed = permission.urls.some((url) => {
      try {
        return new URL(url).href === target;
      } catch {
        return false;
      }
    });
    if (!allowed) throw failure('MCP_URL_DENIED', 'MCP URL 未在任务中明确授权');
  }
}
// Environment references are resolved only for this connection. Never expose their values in
// diagnostics, tool results, schema metadata or server-provided error strings.
function sanitized(value: unknown, secrets: string[]): unknown {
  let nodes = 0;
  const clean = (input: unknown, depth: number): unknown => {
    if (++nodes > 100000 || depth > 64) throw failure('MCP_OUTPUT_LIMIT', 'MCP 返回内容结构过大');
    if (typeof input === 'string') {
      for (const secret of secrets) input = (input as string).split(secret).join('[已隐藏]');
      return input;
    }
    if (Array.isArray(input)) return input.map((item) => clean(item, depth + 1));
    if (object(input))
      return Object.fromEntries(
        Object.entries(input).map(([key, item]) => [clean(key, depth + 1) as string, clean(item, depth + 1)]),
      );
    return input;
  };
  return clean(value, 0);
}
function parseMessage(text: string): RpcMessage {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw failure('MCP_PROTOCOL', 'MCP 返回了无效 JSON');
  }
  if (!object(value) || value.jsonrpc !== '2.0')
    throw failure('MCP_PROTOCOL', 'MCP 返回了无效 JSON-RPC 消息');
  return value as RpcMessage;
}
function responseValue(message: RpcMessage) {
  if (object(message.error)) {
    const code = typeof message.error.code === 'number' ? String(message.error.code) : 'unknown';
    throw failure('MCP_REMOTE_ERROR', 'MCP 请求失败（' + code + '）');
  }
  if (!Object.hasOwn(message, 'result')) throw failure('MCP_PROTOCOL', 'MCP 响应缺少结果');
  return message.result;
}

async function killTree(child: ChildProcessWithoutNullStreams) {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    await new Promise<void>((resolve) => {
      const killer = spawn(
        path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'),
        ['/PID', String(child.pid), '/T', '/F'],
        { windowsHide: true, stdio: 'ignore', env: baseEnv() },
      );
      const timer = setTimeout(() => {
        killer.kill();
        resolve();
      }, 3000);
      const finish = () => {
        clearTimeout(timer);
        resolve();
      };
      killer.once('error', finish);
      killer.once('close', finish);
    });
  } else {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {}
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {}
  }
  child.stdin.destroy();
  child.stdout.destroy();
  child.stderr.destroy();
}
class StdioSession implements Session {
  private child: ChildProcessWithoutNullStreams;
  private nextId = 0;
  private pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  private buffer = '';
  private bytes = 0;
  private failed?: Error;
  private stopping?: Promise<void>;
  private abort: () => void;
  constructor(private context: ConnectionContext) {
    context.signal.throwIfAborted();
    this.child = spawnMcpProcess(context.program!, context.args ?? [], context.config.cwd, context.env);
    this.abort = () => this.fail(failure('MCP_ABORTED', 'MCP 请求已取消或超时'));
    context.signal.addEventListener('abort', this.abort, { once: true });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (data: string) => {
      if (this.failed || this.stopping) return;
      this.bytes += Buffer.byteLength(data);
      if (this.bytes > context.maxBytes)
        return this.fail(failure('MCP_OUTPUT_LIMIT', 'MCP 返回内容超过大小上限'));
      this.buffer += data;
      let newline: number;
      while ((newline = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, newline).trim();
        this.buffer = this.buffer.slice(newline + 1);
        if (!line) continue;
        try {
          this.receive(parseMessage(line));
        } catch (error) {
          this.fail(error as Error);
          return;
        }
      }
    });
    this.child.stderr.resume();
    this.child.stdin.on('error', () => this.fail(failure('MCP_PROCESS', 'MCP 输入流已关闭')));
    this.child.once('error', () =>
      this.fail(failure('MCP_START_FAILED', '无法启动 MCP 程序，请检查程序和工作目录')),
    );
    this.child.once('close', () => {
      if (!this.stopping) this.fail(failure('MCP_PROCESS', 'MCP 程序在完成请求前退出'));
    });
  }
  private receive(message: RpcMessage) {
    if (typeof message.method === 'string') {
      if (message.id !== undefined)
        this.send({
          jsonrpc: '2.0',
          id: message.id,
          ...(message.method === 'ping'
            ? { result: {} }
            : { error: { code: -32601, message: 'Client capability unavailable' } }),
        });
      return;
    }
    if (typeof message.id !== 'number') return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    try {
      pending.resolve(responseValue(message));
    } catch (error) {
      pending.reject(error as Error);
    }
  }
  private send(message: RpcMessage, onSent?: () => void) {
    if (this.failed) throw this.failed;
    this.context.signal.throwIfAborted();
    onSent?.();
    this.child.stdin.write(JSON.stringify(message) + '\n');
  }
  private fail(error: Error) {
    if (this.failed) return;
    this.failed = error;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    void this.close();
  }
  request(method: string, params?: Record<string, unknown>, onSent?: () => void): Promise<unknown> {
    if (this.failed) return Promise.reject(this.failed);
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.send({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) }, onSent);
      } catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    });
  }
  async notify(method: string) {
    this.send({ jsonrpc: '2.0', method });
  }
  close(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.context.signal.removeEventListener('abort', this.abort);
    for (const pending of this.pending.values()) pending.reject(failure('MCP_CLOSED', 'MCP 连接已关闭'));
    this.pending.clear();
    this.stopping = killTree(this.child);
    return this.stopping;
  }
}
class HttpSession implements Session {
  private nextId = 0;
  private sessionId?: string;
  protocol?: string;
  private controller = new AbortController();
  private bytes = 0;
  private stopping?: Promise<void>;
  private replies = new Set<Promise<unknown>>();
  constructor(private context: ConnectionContext) {}
  request(method: string, params?: Record<string, unknown>, onSent?: () => void) {
    return this.post({ jsonrpc: '2.0', id: ++this.nextId, method, ...(params ? { params } : {}) }, onSent);
  }
  async notify(method: string) {
    await this.post({ jsonrpc: '2.0', method });
  }
  close(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.stopping = this.finishClose();
    return this.stopping;
  }
  private async finishClose() {
    await Promise.allSettled([...this.replies]);
    this.controller.abort();
    if (this.sessionId)
      await new Promise<void>((resolve) => {
        const url = new URL(this.context.config.url!);
        const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(
          url,
          {
            method: 'DELETE',
            signal: AbortSignal.timeout(1500),
            maxHeaderSize: 16 * 1024,
            headers: {
              ...this.context.headers,
              'MCP-Session-Id': this.sessionId!,
              ...(this.protocol ? { 'MCP-Protocol-Version': this.protocol } : {}),
            },
          },
          (response) => {
            response.destroy();
            resolve();
          },
        );
        request.on('error', () => resolve());
        request.end();
      });
  }
  private post(message: RpcMessage, onSent?: () => void): Promise<unknown> {
    const url = new URL(this.context.config.url!);
    const signal = AbortSignal.any([this.context.signal, this.controller.signal]);
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const body = JSON.stringify(message);
      const headers: Record<string, string> = {
        ...this.context.headers,
        Accept: 'application/json, text/event-stream',
        'Content-Type': 'application/json',
        'Accept-Encoding': 'identity',
        'Content-Length': String(Buffer.byteLength(body)),
        ...(this.sessionId ? { 'MCP-Session-Id': this.sessionId } : {}),
        ...(this.protocol ? { 'MCP-Protocol-Version': this.protocol } : {}),
      };
      let settled = false;
      const finish = (error: Error | null, value?: unknown) => {
        if (settled) return;
        settled = true;
        if (error) reject(error);
        else resolve(value);
      };
      const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(
        url,
        {
          method: 'POST',
          headers,
          signal,
          maxHeaderSize: 16 * 1024,
        },
        (response) => {
          const status = response.statusCode ?? 0;
          if (status < 200 || status >= 300) {
            response.destroy();
            finish(failure('MCP_HTTP', 'MCP 返回 HTTP ' + status));
            return;
          }
          if (message.id === undefined || typeof message.method !== 'string') {
            response.destroy();
            finish(status === 202 ? null : failure('MCP_PROTOCOL', 'MCP 未接受初始化通知'));
            return;
          }
          if (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') {
            response.destroy();
            finish(failure('MCP_PROTOCOL', 'MCP 返回不支持的压缩响应'));
            return;
          }
          if (message.method === 'initialize') {
            const sessionId = response.headers['mcp-session-id'];
            if (
              sessionId !== undefined &&
              (typeof sessionId !== 'string' || !/^[\x21-\x7e]{1,512}$/.test(sessionId))
            ) {
              response.destroy();
              finish(failure('MCP_PROTOCOL', 'MCP 会话标识无效'));
              return;
            }
            this.sessionId = sessionId;
          }
          const contentType = response.headers['content-type']?.split(';')[0].trim().toLowerCase();
          const accept = (reply: RpcMessage) => {
            if (typeof reply.method === 'string') {
              if (reply.id !== undefined) {
                const pending = this.post({
                  jsonrpc: '2.0',
                  id: reply.id,
                  ...(reply.method === 'ping'
                    ? { result: {} }
                    : { error: { code: -32601, message: 'Client capability unavailable' } }),
                }).catch(() => {});
                this.replies.add(pending);
                void pending.finally(() => this.replies.delete(pending));
              }
              return;
            }
            if (reply.id !== message.id) return;
            try {
              finish(null, responseValue(reply));
            } catch (error) {
              finish(error as Error);
            }
            response.destroy();
          };
          if (contentType === 'application/json') this.readJson(response, accept, finish);
          else if (contentType === 'text/event-stream') this.readEvents(response, accept, finish);
          else {
            response.destroy();
            finish(failure('MCP_PROTOCOL', 'MCP 响应必须为 JSON 或 SSE'));
          }
        },
      );
      request.on('error', () =>
        finish(
          failure(
            signal.aborted ? 'MCP_ABORTED' : 'MCP_HTTP',
            signal.aborted ? 'MCP 请求已取消或超时' : 'MCP HTTP 连接失败',
          ),
        ),
      );
      onSent?.();
      request.end(body);
    });
  }
  private consume(response: IncomingMessage, chunk: string, finish: (error: Error | null) => void) {
    this.bytes += Buffer.byteLength(chunk);
    if (this.bytes <= this.context.maxBytes) return true;
    response.destroy();
    finish(failure('MCP_OUTPUT_LIMIT', 'MCP 返回内容超过大小上限'));
    return false;
  }
  private readJson(
    response: IncomingMessage,
    accept: (message: RpcMessage) => void,
    finish: (error: Error | null) => void,
  ) {
    let text = '';
    response.setEncoding('utf8');
    response.on('data', (chunk: string) => {
      if (this.consume(response, chunk, finish)) text += chunk;
    });
    response.on('end', () => {
      try {
        accept(parseMessage(text));
        finish(failure('MCP_PROTOCOL', 'MCP 响应未包含请求结果'));
      } catch (error) {
        finish(error as Error);
      }
    });
    response.on('error', () => finish(failure('MCP_HTTP', 'MCP 响应中断')));
  }
  private readEvents(
    response: IncomingMessage,
    accept: (message: RpcMessage) => void,
    finish: (error: Error | null) => void,
  ) {
    let buffer = '',
      data: string[] = [];
    const dispatch = () => {
      if (!data.length) return;
      const text = data.join('\n');
      data = [];
      accept(parseMessage(text));
    };
    response.setEncoding('utf8');
    response.on('data', (chunk: string) => {
      if (!this.consume(response, chunk, finish)) return;
      buffer += chunk;
      let newline: number;
      try {
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline).replace(/\r$/, '');
          buffer = buffer.slice(newline + 1);
          if (!line) dispatch();
          else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
        }
      } catch (error) {
        response.destroy();
        finish(error as Error);
      }
    });
    response.on('end', () => finish(failure('MCP_PROTOCOL', 'MCP SSE 响应未包含请求结果')));
    response.on('error', () => finish(failure('MCP_HTTP', 'MCP SSE 响应中断')));
  }
}

/** Short-lived MCP sessions: configuration import never connects or executes a tool. */
export class McpClient {
  private active = new Map<AbortController, Promise<void>>();
  private closed = false;
  constructor(
    private options: {
      timeoutMs?: number;
      maxResponseBytes?: number;
      maxTools?: number;
      maxConnections?: number;
    } = {},
  ) {}
  /**
   * 建立短会话并读取允许的工具目录；限制页数和工具数，校验名称及分页游标。
   * 返回内容标记为不可信，已识别的敏感值会从响应中清理。
   */
  inspect(config: LocalMcpConfig, signal?: AbortSignal, permission?: McpPermission): Promise<McpInspection> {
    if (permission) permissionGate(config, permission, false);
    return this.withSession(config, signal, async (session, initialized, context) => {
      const tools: McpTool[] = [],
        seen = new Set<string>(),
        cursors = new Set<string>();
      const maxTools = Math.min(500, Math.max(1, this.options.maxTools ?? 500));
      let cursor: string | undefined,
        truncated = false;
      for (let page = 0; page < 20; page++) {
        const value = sanitized(
          await session.request('tools/list', cursor ? { cursor } : {}),
          context.secrets,
        );
        if (!object(value) || !Array.isArray(value.tools)) throw failure('MCP_PROTOCOL', 'MCP 工具目录无效');
        for (const tool of value.tools) {
          if (
            !object(tool) ||
            typeof tool.name !== 'string' ||
            !TOOL_NAME.test(tool.name) ||
            !object(tool.inputSchema)
          )
            throw failure('MCP_PROTOCOL', 'MCP 工具定义无效');
          if (seen.has(tool.name)) throw failure('MCP_PROTOCOL', 'MCP 工具名称重复');
          seen.add(tool.name);
          if (!toolAllowed(config, tool.name)) continue;
          if (tools.length >= maxTools) {
            truncated = true;
            break;
          }
          tools.push({
            name: tool.name,
            inputSchema: tool.inputSchema,
            ...(typeof tool.title === 'string' ? { title: tool.title.slice(0, 200) } : {}),
            ...(typeof tool.description === 'string' ? { description: tool.description.slice(0, 8000) } : {}),
            ...(object(tool.annotations) ? { annotations: tool.annotations } : {}),
          });
        }
        if (truncated || !value.nextCursor) break;
        if (
          typeof value.nextCursor !== 'string' ||
          value.nextCursor.length > 4096 ||
          cursors.has(value.nextCursor)
        )
          throw failure('MCP_PROTOCOL', 'MCP 工具目录分页无效');
        cursor = value.nextCursor;
        cursors.add(cursor);
        if (page === 19) truncated = true;
      }
      return { ...initialized, tools, truncated, trust: 'untrusted' };
    });
  }
  /**
   * 检查调用权限和参数大小后执行远端工具。请求发出后若连接中断且结果无法确认，
   * 返回 MCP_CALL_UNCERTAIN，提醒调用方先核验副作用再决定是否重试。
   */
  call(
    config: LocalMcpConfig,
    tool: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
    permission?: McpPermission,
  ): Promise<McpCallResult> {
    permissionGate(config, permission, true);
    if (!TOOL_NAME.test(tool) || !object(args)) throw failure('MCP_ARGUMENTS', 'MCP 工具名称或参数无效');
    if (!toolAllowed(config, tool)) throw failure('MCP_TOOL_DENIED', 'MCP 工具不在连接的允许范围中');
    let serialized: string;
    try {
      serialized = JSON.stringify(args);
    } catch {
      throw failure('MCP_ARGUMENTS', 'MCP 参数无法编码为 JSON');
    }
    if (Buffer.byteLength(serialized) > MAX_ARGUMENT_BYTES)
      throw failure('MCP_ARGUMENTS', 'MCP 参数超过 256 KiB');
    return this.withSession(config, signal, async (session, _initialized, context) => {
      let invoked = false;
      try {
        const result = sanitized(
          await session.request('tools/call', { name: tool, arguments: args }, () => {
            invoked = true;
          }),
          context.secrets,
        );
        if (!object(result) || !Array.isArray(result.content))
          throw failure('MCP_PROTOCOL', 'MCP 工具结果无效');
        return { tool, result, trust: 'untrusted' };
      } catch (error) {
        if (invoked && !(error instanceof AppError && error.code === 'MCP_REMOTE_ERROR'))
          throw new AppError(
            'MCP_CALL_UNCERTAIN',
            'MCP 工具请求已发出，执行结果未能确认；请核验副作用后再继续',
            false,
            { invoked: true, causeCode: error instanceof AppError ? error.code : 'MCP_CONNECTION' },
          );
        throw error;
      }
    });
  }
  /** 取消所有活动会话并等待它们结束；关闭后不再接受新连接。 */
  async close() {
    this.closed = true;
    for (const controller of this.active.keys()) controller.abort();
    await Promise.allSettled([...this.active.values()]);
  }
  private async withSession<T>(
    config: LocalMcpConfig,
    signal: AbortSignal | undefined,
    use: (
      session: Session,
      initialized: Omit<McpInspection, 'tools' | 'truncated' | 'trust'>,
      context: ConnectionContext,
    ) => Promise<T>,
  ): Promise<T> {
    if (this.closed) throw failure('MCP_CLOSED', 'MCP 客户端已关闭');
    if (this.active.size >= Math.min(8, Math.max(1, this.options.maxConnections ?? 4)))
      throw failure('MCP_BUSY', 'MCP 连接数量已达上限，请稍后重试');
    signal?.throwIfAborted();
    const controller = new AbortController();
    const timeoutMs = Math.min(120000, Math.max(100, this.options.timeoutMs ?? 30000));
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    let complete!: () => void;
    this.active.set(
      controller,
      new Promise<void>((resolve) => {
        complete = resolve;
      }),
    );
    let session: Session | undefined;
    try {
      const context = await prepare(
        config,
        combined,
        Math.min(8 * 1024 * 1024, Math.max(1024, this.options.maxResponseBytes ?? 4 * 1024 * 1024)),
      );
      session = config.transport === 'stdio' ? new StdioSession(context) : new HttpSession(context);
      const initialized = sanitized(
        await session.request('initialize', {
          protocolVersion: PROTOCOLS[0],
          capabilities: {},
          clientInfo: { name: 'elysia-local-mcp', version: '1.0.0' },
        }),
        context.secrets,
      );
      if (
        !object(initialized) ||
        typeof initialized.protocolVersion !== 'string' ||
        !PROTOCOLS.includes(initialized.protocolVersion) ||
        !object(initialized.serverInfo) ||
        typeof initialized.serverInfo.name !== 'string' ||
        typeof initialized.serverInfo.version !== 'string' ||
        !object(initialized.capabilities) ||
        !object(initialized.capabilities.tools)
      )
        throw failure('MCP_PROTOCOL', 'MCP 协议版本或工具能力不兼容');
      if (session instanceof HttpSession) session.protocol = initialized.protocolVersion;
      await session.notify('notifications/initialized');
      return await use(
        session,
        {
          protocolVersion: initialized.protocolVersion,
          serverInfo: {
            name: initialized.serverInfo.name.slice(0, 200),
            version: initialized.serverInfo.version.slice(0, 100),
            ...(typeof initialized.serverInfo.title === 'string'
              ? { title: initialized.serverInfo.title.slice(0, 200) }
              : {}),
          },
        },
        context,
      );
    } finally {
      clearTimeout(timer);
      await session?.close();
      this.active.delete(controller);
      complete();
    }
  }
}
