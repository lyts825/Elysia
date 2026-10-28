/**
 * 校验并同步本地代理配置。
 * 从用户选择的 CLI 来源核验路径/句柄、摘要、敏感信息与容量后导入私有库；不改源文件，不自动启用未补全 MCP。
 * EN: Validates and synchronizes local-agent configuration. Imports selected CLI sources after path/handle/hash/secret/budget checks without modifying originals or enabling incomplete MCP.
 */
import { constants } from 'node:fs';
import { lstat, realpath, opendir, open } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { createZstdDecompress } from 'node:zlib';
import { parseDocument } from 'yaml';
import { parse as parseToml } from 'smol-toml';
import { AppError } from '../../../packages/contracts/src/index.js';
import type {
  LocalAgentKind,
  LocalAgentCandidate,
  LocalAgentScan,
  LocalAgentSource,
  LocalAgentOverview,
  LocalMcpConfig,
} from '../../../packages/contracts/src/local-integrations.js';
import { Store, hash, stable } from '../../../packages/storage/src/index.js';
import { parseSkillMetadata } from '../../../packages/context/src/skills.js';
import {
  importedLibrary,
  writeImportedLibrary,
  publicLocalItem,
  localItem,
  localItemText,
  pageLocalText,
  type LocalStoredItem,
} from '../../../packages/context/src/local-library.js';

const MAX_FILE = 512 * 1024,
  MAX_TOTAL = 16 * 1024 * 1024,
  MAX_ITEMS = 500;
const secretName =
  /^(?:\.env(?:\..*)?|\.?auth(?:\.json)?|\.?credentials?(?:\..*)?|oauth_creds\.json|google_accounts\.json|secrets?(?:\..*)?|tokens?(?:\..*)?|id_(?:rsa|ed25519)|.*\.(?:pem|key|p12|pfx))$/i;
const envName = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const label = { codex: 'Codex', claude: 'Claude Code', dsh: 'DeepSeek Harness', antigravity: 'Antigravity' };
type Prepared = {
  candidate: LocalAgentCandidate;
  text: string;
  resources: { path: string; text: string; hash: string }[];
};
type CachedScan = { result: LocalAgentScan; prepared: Map<string, Prepared>; createdAt: number };
/**
 * 检查可选扫描信号，已取消时抛统一的 499 领域错误，阻止继续读本机资料。
 * EN: Checks the optional scan signal and throws a shared 499 cancellation error before further local reads.
 */
const cancelled = (signal?: AbortSignal) => {
  if (signal?.aborted) throw new AppError('LOCAL_SCAN_CANCELLED', '本机同步已取消', false, null, 499);
};
/**
 * 生成统一正斜杠的来源相对路径，供候选 ID 和公开路径使用。
 * EN: Produces a forward-slash source-relative path for candidate IDs and public paths.
 */
const relative = (root: string, file: string) => path.relative(root, file).replace(/\\/g, '/');
/**
 * 按当前平台比较已规范化路径，Windows 忽略大小写，其他平台精确比较。
 * EN: Compares normalized paths using case-insensitivity on Windows and exact matching elsewhere.
 */
const samePath = (a: string, b: string) =>
  process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
/**
 * 检查词法路径是否位于来源根目录或其内部；链接身份仍由读取阶段单独验证。
 * EN: Checks lexical inclusion in or equal to the source root; read stages separately validate link identity.
 */
const within = (root: string, file: string) => {
  const value = path.relative(root, file);
  return value === '' || (!value.startsWith('..' + path.sep) && value !== '..' && !path.isAbsolute(value));
};

/**
 * 移除已识别的凭据形态和赋值；属于尽力脱敏，不能保证发现业务文本中所有秘密。
 * EN: Removes recognized credential patterns and assignments as best-effort redaction, without claiming to discover every secret in business text.
 */
function redact(text: string) {
  return text
    .replace(
      /(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|Bearer\s+[A-Za-z0-9._~+\/-]{12,})/gi,
      '[已隐去凭据]',
    )
    .replace(
      /(["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|authorization)["']?\s*[:=]\s*)["']?[^\s,"'\n}]+["']?/gi,
      '$1[已隐去凭据]',
    );
}
/**
 * 识别脱敏器可检出或含凭据赋值语法的参数，供导入过滤使用；此判断不读取实际密钥。
 * EN: Detects arguments recognized by redaction or credential-assignment syntax for import filtering without resolving secrets.
 */
const secretArgument = (value: string) =>
  redact(value) !== value || /(?:api[_-]?key|token|password|secret|authorization)\s*[=:]/i.test(value);
/**
 * 把非数组对象视为字段映射，其他未知输入降为新空对象，简化只读兼容解析。
 * EN: Treats non-array objects as field maps and other unknown input as a fresh empty map for compatibility parsing.
 */
function plain(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
/**
 * 校验有界短字符串数组并拒绝控制字符；无效输入返回 undefined，不截断后接受。
 * EN: Validates bounded short-string arrays without control characters; invalid input returns undefined rather than accepting truncated data.
 */
function strings(value: unknown, maximum = 100) {
  if (
    !Array.isArray(value) ||
    value.length > maximum ||
    value.some((v) => typeof v !== 'string' || v.length > 2000 || /[\u0000-\u001F]/.test(v))
  )
    return undefined;
  return value as string[];
}
/**
 * 只保留不含认证、查询和片段的 HTTP(S) 地址，避免把 URL 中的秘密同步入库。
 * EN: Retains HTTP(S) URLs only without authentication, query, or fragment components so URL secrets are not imported.
 */
function safeUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 4000) return undefined;
  try {
    const url = new URL(value);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      secretArgument(value)
    )
      return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}
/**
 * 识别环境变量引用语法，只返回变量名，不解析本机实际值。
 * EN: Recognizes environment-reference syntax and returns names only, never resolving local values.
 */
function reference(value: unknown) {
  if (typeof value !== 'string') return undefined;
  return /^(?:\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)|env:([A-Za-z_][A-Za-z0-9_]*))$/
    .exec(value)
    ?.slice(1)
    .find(Boolean);
}

/**
 * 校验用户保存的 MCP 安全配置：只接受显式字段、环境变量名称和有界参数。 stdio 命令/参数拒绝已知明文凭据，HTTP 地址拒绝用户信息及查询参数；此检查只描述 连接配置，不建立连接、不证明远端工具安全，也不授予调用权限。
 * EN: Validates saved MCP configuration using explicit fields, environment names, and bounded arguments. stdio rejects known plaintext credentials; HTTP rejects user info and queries. This describes configuration only: it neither connects, proves remote safety, nor grants invocation rights.
 */
export function validateLocalMcpConfig(value: unknown): LocalMcpConfig {
  const config = plain(value);
  const keys = new Set([
    'transport',
    'command',
    'args',
    'cwd',
    'envNames',
    'url',
    'headerEnv',
    'bearerTokenEnv',
    'needsConfiguration',
    'allowedTools',
    'deniedTools',
  ]);
  if (
    Object.keys(config).some((key) => !keys.has(key)) ||
    !['stdio', 'http'].includes(String(config.transport)) ||
    typeof config.needsConfiguration !== 'boolean'
  )
    throw new AppError('MCP_CONFIG_INVALID', 'MCP 配置只能包含安全连接字段和环境变量名称');
  const names = strings(config.envNames, 100),
    headers = plain(config.headerEnv);
  if (
    !names ||
    names.some((name) => !envName.test(name)) ||
    Object.keys(headers).length > 32 ||
    Object.entries(headers).some(
      ([key, v]) => !/^[A-Za-z0-9-]{1,100}$/.test(key) || typeof v !== 'string' || !envName.test(v),
    )
  )
    throw new AppError('MCP_CONFIG_INVALID', 'MCP 环境变量或请求头引用无效');
  if (
    config.bearerTokenEnv !== undefined &&
    (typeof config.bearerTokenEnv !== 'string' || !envName.test(config.bearerTokenEnv))
  )
    throw new AppError('MCP_CONFIG_INVALID', 'MCP token 必须是环境变量名称');
  const allowedTools = config.allowedTools === undefined ? undefined : strings(config.allowedTools, 500);
  const deniedTools = config.deniedTools === undefined ? undefined : strings(config.deniedTools, 500);
  if (
    (config.allowedTools !== undefined && !allowedTools) ||
    (config.deniedTools !== undefined && !deniedTools)
  )
    throw new AppError('MCP_CONFIG_INVALID', 'MCP 工具筛选无效');
  const result: LocalMcpConfig = {
    transport: config.transport as LocalMcpConfig['transport'],
    envNames: [...new Set(names)],
    headerEnv: headers as Record<string, string>,
    needsConfiguration: config.needsConfiguration,
    ...(allowedTools ? { allowedTools } : {}),
    ...(deniedTools ? { deniedTools } : {}),
    ...(typeof config.bearerTokenEnv === 'string' ? { bearerTokenEnv: config.bearerTokenEnv } : {}),
  };
  if (result.transport === 'stdio') {
    const args = strings(config.args ?? [], 100);
    if (
      typeof config.command !== 'string' ||
      !config.command.trim() ||
      config.command.length > 2000 ||
      /[\u0000-\u001F]/.test(config.command) ||
      secretArgument(config.command) ||
      !args ||
      args.some(secretArgument) ||
      args.some(
        (arg, index) =>
          /^--?(?:api[_-]?key|token|password|secret|authorization)$/i.test(args[index - 1] ?? '') &&
          !reference(arg),
      )
    )
      throw new AppError('MCP_CONFIG_INVALID', 'MCP 命令或参数包含无效内容或明文凭据');
    result.command = config.command;
    result.args = args;
    if (config.cwd !== undefined) {
      if (
        typeof config.cwd !== 'string' ||
        !path.isAbsolute(config.cwd) ||
        config.cwd.length > 4000 ||
        /[\u0000-\u001F]/.test(config.cwd)
      )
        throw new AppError('MCP_CONFIG_INVALID', 'MCP 工作目录必须是绝对路径');
      result.cwd = config.cwd;
    }
  } else {
    const url = safeUrl(config.url);
    if (!url) throw new AppError('MCP_CONFIG_INVALID', 'MCP URL 不得携带凭据、查询参数或片段');
    result.url = url;
  }
  return result;
}

/**
 * 将不同代理的 MCP 格式转换为本地描述。无法安全保留的字段不执行，也不迁移实际秘密， 而是设置 needsConfiguration，使导入项默认禁用并等待用户补齐引用。
 * EN: Converts agent-specific MCP formats into local descriptions. Unsafe fields and real secrets are not executed or migrated; needsConfiguration disables imported entries until the user supplies references.
 */
function normalizeMcp(value: unknown): LocalMcpConfig {
  const raw = plain(value),
    headers: Record<string, string> = {};
  let incomplete = false;
  const envNames = Object.keys(plain(raw.env)).filter((key) => envName.test(key));
  for (const [key, v] of Object.entries(plain(raw.env)))
    if (!envName.test(key) || reference(v) !== key) incomplete = true;
  for (const entry of Array.isArray(raw.env_vars) ? raw.env_vars : []) {
    if (typeof entry === 'string' && envName.test(entry)) envNames.push(entry);
    else if (
      typeof plain(entry).name === 'string' &&
      envName.test(String(plain(entry).name)) &&
      plain(entry).source === 'local'
    )
      envNames.push(String(plain(entry).name));
    else incomplete = true;
  }
  for (const [key, v] of Object.entries({ ...plain(raw.http_headers), ...plain(raw.headers) })) {
    const ref = reference(v);
    if (ref && /^[A-Za-z0-9-]{1,100}$/.test(key) && Object.keys(headers).length < 32) headers[key] = ref;
    else incomplete = true;
  }
  for (const [key, v] of Object.entries(plain(raw.env_http_headers)))
    if (
      typeof v === 'string' &&
      envName.test(v) &&
      /^[A-Za-z0-9-]{1,100}$/.test(key) &&
      Object.keys(headers).length < 32
    )
      headers[key] = v;
    else incomplete = true;
  if (
    raw.oauth ||
    raw.http_headers_helper ||
    raw.headersHelper ||
    raw.type === 'sse' ||
    raw.transport === 'sse'
  )
    incomplete = true;
  const command =
    typeof raw.command === 'string' && !secretArgument(raw.command) && !/[\u0000-\u001F]/.test(raw.command)
      ? raw.command
      : undefined;
  if (raw.command && !command) incomplete = true;
  const originalArgs = strings(raw.args ?? [], 100);
  const args = (originalArgs ?? []).map((arg, index) => {
    if (
      secretArgument(arg) ||
      /^--?(?:api[_-]?key|token|password|secret|authorization)$/i.test(originalArgs?.[index - 1] ?? '')
    ) {
      incomplete = true;
      return '[请移除明文凭据]';
    }
    return arg;
  });
  if (!originalArgs) incomplete = true;
  if (
    (raw.enabled_tools !== undefined && !strings(raw.enabled_tools, 500)) ||
    (raw.disabled_tools !== undefined && !strings(raw.disabled_tools, 500))
  )
    incomplete = true;
  const url = safeUrl(raw.url ?? raw.serverUrl),
    transport: 'stdio' | 'http' =
      raw.url ||
      raw.serverUrl ||
      ['http', 'streamable-http', 'sse'].includes(String(raw.type ?? raw.transport))
        ? 'http'
        : 'stdio';
  if ((transport === 'http' && !url) || (transport === 'stdio' && !command)) incomplete = true;
  const config: LocalMcpConfig = {
    transport,
    envNames: [...new Set(envNames)].slice(0, 100),
    headerEnv: headers,
    needsConfiguration: incomplete,
    ...(transport === 'stdio' ? { command: command ?? '', args } : { url: url ?? '' }),
    ...(typeof raw.cwd === 'string' && path.isAbsolute(raw.cwd) ? { cwd: raw.cwd } : {}),
    ...(typeof raw.bearer_token_env_var === 'string' && envName.test(raw.bearer_token_env_var)
      ? { bearerTokenEnv: raw.bearer_token_env_var }
      : {}),
    ...(strings(raw.enabled_tools, 500) ? { allowedTools: strings(raw.enabled_tools, 500) } : {}),
    ...(strings(raw.disabled_tools, 500) ? { deniedTools: strings(raw.disabled_tools, 500) } : {}),
  };
  return config;
}

/**
 * 禁止重复键、别名和有警告的 YAML，避免宽松解析把导入来源解释成不同配置。
 * EN: Rejects duplicate keys, aliases, and YAML warnings so permissive parsing cannot reinterpret imported configuration.
 */
function yaml(source: string): unknown {
  const doc = parseDocument(source, { uniqueKeys: true, schema: 'core', strict: true });
  if (doc.errors.length || doc.warnings.length)
    throw new AppError('LOCAL_CONFIG_INVALID', 'YAML 配置格式无效');
  return doc.toJS({ maxAliasCount: 0 });
}
/**
 * 解析 TOML 的 mcp_servers 映射，语法失败转为安全的本机配置错误。
 * EN: Parses the TOML mcp_servers map and converts syntax failures to a safe local-configuration error.
 */
function tomlMcp(source: string): Record<string, unknown> {
  try {
    return plain(parseToml(source).mcp_servers);
  } catch {
    throw new AppError('LOCAL_CONFIG_INVALID', 'MCP TOML 配置格式无效');
  }
}
/**
 * 有界枚举全局/项目 MCP 配置；DSH 另按其插件节点结构查找，不递归执行任何来源代码。
 * EN: Enumerates global/project MCP files within bounds; DSH follows its plugin-node layout without recursively executing source code.
 */
function configEntries(value: unknown, kind: LocalAgentKind) {
  const result: { name: string; value: unknown }[] = [];
  /**
   * 从一个 MCP 映射最多收集 100 项并补来源前缀，保持目录扫描容量有界。
   * EN: Collects at most 100 MCP entries from a map with an optional source prefix to bound catalog scanning.
   */
  const addMap = (map: unknown, prefix = '') => {
    for (const [name, config] of Object.entries(plain(map)).slice(0, 100))
      result.push({ name: prefix + name, value: config });
  };
  if (kind !== 'dsh') {
    const root = plain(value);
    addMap(root.mcpServers ?? root.mcp_servers);
    for (const [project, config] of Object.entries(plain(root.projects)).slice(0, 100))
      addMap(plain(config).mcpServers, `${project}: `);
  } else {
    addMap(plain(value).mcpServers ?? plain(value).mcp_servers);
    /**
     * 有界递归发现 DSH MCP 客户端节点，限制深度、子项数与结果数，避免任意配置树导致无限展开。
     * EN: Recursively finds DSH MCP client nodes with depth, child and result caps to prevent unbounded configuration expansion.
     */
    const visit = (node: unknown, depth: number) => {
      if (depth > 12 || result.length >= 100) return;
      if (Array.isArray(node)) for (const child of node.slice(0, 500)) visit(child, depth + 1);
      else if (node && typeof node === 'object') {
        const entry = plain(node);
        if (entry.name === '@deepseek-ai/dsh-mcp-client') {
          const config = plain(entry.config);
          result.push({
            name: typeof config.serverName === 'string' ? config.serverName : 'DSH MCP',
            value: config,
          });
        } else for (const child of Object.values(entry).slice(0, 500)) visit(child, depth + 1);
      }
    };
    visit(value, 0);
  }
  return result;
}

/**
 * 从字符串或允许类型的文本块抽取公开正文，忽略其他结构而不序列化工具/私密载荷。
 * EN: Extracts text from strings or allowlisted text blocks, ignoring other structures rather than serializing private/tool payloads.
 */
function textContent(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value))
    return value
      .filter((block) => ['text', 'input_text', 'output_text'].includes(String(plain(block).type)))
      .map((block) => (typeof plain(block).text === 'string' ? plain(block).text : ''))
      .join('\n');
  return '';
}
/**
 * 从多种 JSONL 日志中抽取公开用户/助手正文，跳过元事件、侧链和无法解析的行。 尾部截取时丢弃第一条不完整行；结果只作为脱敏资料，不恢复原代理执行状态。
 * EN: Extracts public user/assistant text from JSONL logs, skipping meta events, side chains, and invalid lines. Tail reads drop the first incomplete line. Results are redacted reference material, never restored execution state.
 */
function conversationText(source: string, truncated: boolean) {
  const lines = source.split('\n'),
    result: string[] = [];
  if (truncated) lines.shift();
  for (const line of lines) {
    if (!line.trim() || line.length > MAX_FILE) continue;
    let row: Record<string, unknown>;
    try {
      row = plain(JSON.parse(line));
    } catch {
      continue;
    }
    let message = plain(row.message ?? row.payload ?? row),
      role = String(message.role ?? row.role ?? '');
    if (row.type === 'user/message') {
      message = plain(row.data);
      role = 'user';
      if (plain(message.source).kind && plain(message.source).kind !== 'user') continue;
    }
    if (row.type === 'assistant/message') {
      message = plain(plain(row.data).message);
      role = 'assistant';
    }
    if (!['user', 'assistant'].includes(role) || row.type === 'event_msg' || row.isSidechain || row.isMeta)
      continue;
    const text = textContent(message.content ?? message.text);
    if (text.trim()) result.push(`### ${role === 'user' ? '用户' : '助手'}\n${redact(text).slice(0, 32768)}`);
  }
  return result.join('\n\n').slice(-MAX_FILE / 2);
}

/**
 * 扫描和同步本地代理资源；扫描结果与当前本地库分别管理。
 * EN: Scans and synchronizes local resources while keeping scan candidates separate from the persisted library.
 */
export class LocalAgentSync {
  private scans = new Map<string, CachedScan>();
  /**
   * 绑定导入库存储和默认用户目录；构造阶段不扫描文件或读取外部 CLI 凭据。
   * EN: Binds imported-library storage and default home without scanning files or reading external CLI credentials at construction.
   */
  constructor(
    private store: Store,
    private home = os.homedir(),
  ) {}
  /**
   * 返回持久导入库的公开条目与各 CLI 默认来源目录，不包含保存的正文对象。
   * EN: Returns public imported-library entries and CLI default source roots without retained content objects.
   */
  overview(): LocalAgentOverview {
    const library = importedLibrary(this.store);
    return {
      revision: library.revision,
      sources: library.sources,
      items: library.items.map(publicLocalItem),
      defaults: [
        { kind: 'codex', roots: [path.join(this.home, '.codex'), path.join(this.home, '.agents')] },
        { kind: 'claude', roots: [path.join(this.home, '.claude'), this.home] },
        { kind: 'dsh', roots: [path.join(this.home, '.dsh'), path.join(this.home, '.agents')] },
        {
          kind: 'antigravity',
          roots: [
            path.join(this.home, '.gemini'),
            path.join(this.home, '.gemini', 'config'),
            path.join(this.home, '.gemini', 'antigravity-cli'),
            path.join(this.home, '.gemini', 'antigravity'),
          ],
        },
      ],
    };
  }
  /**
   * 同 commandId 只重放相同载荷；相同 ID 配不同选择或版本时拒绝，避免误合并请求。
   * EN: Replays a command ID only for identical payloads; changed selection or revision with the same ID is rejected.
   */
  private replay(commandId: string | undefined, payload: unknown): LocalAgentOverview | undefined {
    if (!commandId) return undefined;
    const old = this.store.db.prepare('SELECT fingerprint FROM commands WHERE id=?').get(commandId) as
      | { fingerprint: string }
      | undefined;
    if (!old) return undefined;
    if (old.fingerprint !== hash(stable(payload)))
      throw new AppError('COMMAND_REUSED', 'commandId 已用于不同请求', false, null, 409);
    return this.store.command<LocalAgentOverview>(commandId, payload, () => {
      throw new Error('unreachable');
    });
  }
  /**
   * 比较导入库预期版本，不匹配时抛冲突，防止旧扫描覆盖更新。
   * EN: Checks imported-library expected revision and throws conflicts to prevent stale scans overwriting updates.
   */
  private revision(expected: number) {
    if (importedLibrary(this.store).revision !== expected)
      throw new AppError('LOCAL_REVISION_CHANGED', '本机同步目录已更新，请刷新后重试', false, null, 409);
  }
  /**
   * 核验本机来源根目录后扫描候选，结果在当前进程缓存十分钟且最多保留三次扫描。 扫描只生成可供选择的资料；持久库不变化，MCP 配置不会因此自动连接或启用。
   * EN: Validates source roots and caches selectable candidates in process for ten minutes, retaining at most three scans. Scanning does not change the persistent library or connect/enable imported MCP entries.
   */
  async scan(kind: LocalAgentKind, requestedRoot?: string, signal?: AbortSignal): Promise<LocalAgentScan> {
    if (!['codex', 'claude', 'dsh', 'antigravity'].includes(kind))
      throw new AppError(
        'LOCAL_SOURCE_INVALID',
        '请选择 Codex、Claude Code、DeepSeek Harness 或 Antigravity',
      );
    const requested =
      requestedRoot ||
      path.join(this.home, { claude: '.claude', codex: '.codex', dsh: '.dsh', antigravity: '.gemini' }[kind]);
    if (!path.isAbsolute(requested) || requested.length > 4000 || /[\u0000-\u001F]/.test(requested))
      throw new AppError('LOCAL_ROOT_INVALID', '请选择本机来源的绝对目录');
    const root = path.resolve(requested);
    cancelled(signal);
    let stat;
    try {
      stat = await lstat(root);
    } catch {
      throw new AppError('LOCAL_ROOT_MISSING', '来源目录不存在或不可读', false, null, 404);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(await realpath(root), root))
      throw new AppError('LOCAL_ROOT_UNSAFE', '来源目录不能是符号链接或联接');
    const source: LocalAgentSource = {
      id: `source:${kind}:${hash(process.platform === 'win32' ? root.toLowerCase() : root).slice(0, 24)}`,
      kind,
      root,
      name: label[kind],
    };
    const { prepared, warnings } = await this.collect(source, signal);
    const scanId = randomUUID(),
      createdAt = Date.now();
    const result: LocalAgentScan = {
      scanId,
      source,
      candidates: [...prepared.values()].map((p) => p.candidate),
      warnings,
      expiresAt: new Date(createdAt + 10 * 60 * 1000).toISOString(),
    };
    for (const [id, scan] of this.scans)
      if (createdAt - scan.createdAt > 10 * 60 * 1000) this.scans.delete(id);
    while (this.scans.size >= 3) this.scans.delete(this.scans.keys().next().value!);
    this.scans.set(scanId, { result, prepared, createdAt });
    return result;
  }
  /**
   * 统一采集技能、记忆、会话正文和 MCP 描述。目录/文件/解压/总读取量均有独立上限； 未知文件、链接、敏感路径和不可解析来源通过警告保留，不推断其可安全导入。
   * EN: Collects skills, memories, public sessions, and MCP descriptions with separate bounds on directories, files, decompression, and total reads. Unknown files, links, sensitive paths, and invalid sources remain warnings rather than being assumed safe.
   */
  private async collect(source: LocalAgentSource, signal?: AbortSignal) {
    const prepared = new Map<string, Prepared>(),
      warnings: string[] = [];
    const rootName = path.basename(source.root).toLowerCase();
    const standardRoot =
      ['.codex', '.claude', '.dsh', '.agents', '.agent', '.gemini'].includes(rootName) ||
      (source.kind === 'antigravity' && ['config', 'antigravity', 'antigravity-cli'].includes(rootName)) ||
      samePath(source.root, this.home);
    const latestDsh = new Map<string, { path: string; version: number; compressed: boolean }>();
    let total = 0,
      visited = 0,
      readBytes = 0;
    /**
     * 最多保留 100 条扫描警告，避免目录异常无限放大响应。
     * EN: Retains at most 100 scan warnings so directory anomalies cannot grow responses indefinitely.
     */
    const warn = (message: string) => {
      if (warnings.length < 100) warnings.push(message);
    };
    /**
     * 在来源根内安全读取候选文件或有界尾部，核对路径/句柄身份及前后版本并累计总读取预算；取消、链接、超限或检测到变化都使候选失败。
     * EN: Safely reads a candidate or bounded tail inside the source root, validating path/handle identity and before/after versions while charging a shared budget. Cancellation, links, limits or detected changes fail the candidate.
     */
    const read = async (file: string, tail = false) => {
      /**
       * 路径和文件句柄都核验身份；读取前后的版本变化会使整个候选失效。
       * EN: Validates both path and file-handle identity; detected version changes invalidate the candidate.
       */
      cancelled(signal);
      const relativePath = relative(source.root, file);
      if (!within(source.root, file) || relativePath.split('/').some((part) => secretName.test(part)))
        throw new AppError('LOCAL_PATH_UNSAFE', '来源路径无效');
      const real = await realpath(file),
        before = await lstat(file);
      if (before.isSymbolicLink() || !before.isFile() || !samePath(real, file))
        throw new AppError('LOCAL_PATH_UNSAFE', '跳过来源链接');
      if (!tail && before.size > MAX_FILE) throw new AppError('LOCAL_FILE_LIMIT', '超过单文件512KiB限制');
      readBytes += Math.min(before.size, file.endsWith('.zstd') ? 4 * 1024 * 1024 : MAX_FILE);
      if (readBytes > 64 * 1024 * 1024)
        throw new AppError('LOCAL_SCAN_LIMIT', '单次扫描读取达到64MiB，请缩小来源目录');
      const fd = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const actual = await fd.stat();
        if (
          actual.ino !== before.ino ||
          actual.dev !== before.dev ||
          actual.size !== before.size ||
          actual.mtimeMs !== before.mtimeMs
        )
          throw new AppError('LOCAL_SOURCE_CHANGED', '扫描期间来源已改变', false, null, 409);
        let data: Buffer;
        if (file.endsWith('.zstd')) {
          /**
           * 压缩输入和解压输出分别限流，只保留最近正文尾部，避免小压缩文件放大占用。
           * EN: Bounds compressed input and decompressed output separately and retains only a recent text tail to limit expansion.
           */
          if (before.size > 4 * 1024 * 1024)
            throw new AppError('LOCAL_FILE_LIMIT', '压缩日志超过4MiB，请导出近期 JSONL 或 Markdown');
          const stream = fd.createReadStream({ autoClose: false, highWaterMark: 65536 }),
            decoder = createZstdDecompress();
          /**
           * 销毁压缩来源流和解码器，携带本机扫描取消错误终止解压。
           * EN: Destroys compressed source/decoder with the local-scan cancellation error.
           */
          const abort = () => {
            stream.destroy();
            decoder.destroy(new AppError('LOCAL_SCAN_CANCELLED', '本机同步已取消', false, null, 499));
          };
          signal?.addEventListener('abort', abort, { once: true });
          stream.on('error', (error) => decoder.destroy(error));
          cancelled(signal);
          let bytes = 0,
            complete = false;
          data = Buffer.alloc(0);
          try {
            stream.pipe(decoder);
            for await (const chunk of decoder) {
              cancelled(signal);
              const buffer = Buffer.from(chunk as Buffer);
              bytes += buffer.length;
              if (bytes > 32 * 1024 * 1024)
                throw new AppError('LOCAL_FILE_LIMIT', '日志解压超过32MiB，请导出近期正文');
              data = Buffer.concat([data, buffer]);
              if (data.length > MAX_FILE) data = data.subarray(data.length - MAX_FILE);
            }
            complete = true;
          } finally {
            signal?.removeEventListener('abort', abort);
            if (!complete) stream.destroy();
            decoder.destroy();
          }
        } else {
          const length = Math.min(MAX_FILE, before.size),
            offset = tail ? Math.max(0, before.size - length) : 0;
          data = Buffer.alloc(length);
          let count = 0;
          while (count < length) {
            cancelled(signal);
            const r = await fd.read(data, count, length - count, offset + count);
            if (!r.bytesRead) break;
            count += r.bytesRead;
          }
          data = data.subarray(0, count);
        }
        const after = await fd.stat();
        if (
          after.size !== before.size ||
          after.mtimeMs !== before.mtimeMs ||
          !samePath(await realpath(file), file)
        )
          throw new AppError('LOCAL_SOURCE_CHANGED', '扫描期间来源已改变', false, null, 409);
        if (data.includes(0)) throw new AppError('LOCAL_BINARY_SKIPPED', '非 UTF-8 文本不导入');
        if (tail) {
          /**
           * 尾部切片可能起于 UTF-8 续字节，先跳到完整字符边界再进行严格解码。
           * EN: A tail slice may start on a UTF-8 continuation byte; advance to a full-character boundary before strict decoding.
           */
          let start = 0;
          while (start < data.length && (data[start] & 0xc0) === 0x80) start++;
          data = data.subarray(start);
        }
        return {
          text: new TextDecoder('utf-8', { fatal: true }).decode(data),
          hash: hash(data),
          size: before.size,
          truncated: tail && (before.size > MAX_FILE || file.endsWith('.zstd')),
        };
      } finally {
        await fd.close();
      }
    };
    /**
     * 按来源、路径及 MCP 名称派生稳定候选 ID，去重并累计正文/资源容量；达到项数或总量上限时保留警告，不创建半个候选。
     * EN: Derives stable source/path/MCP IDs, deduplicates and charges text/resource budgets; limits warn and skip rather than create partial candidates.
     */
    const add = (
      kind: LocalAgentCandidate['kind'],
      file: string,
      name: string,
      description: string,
      text: string,
      digest: string,
      resources: Prepared['resources'] = [],
      config?: LocalMcpConfig,
      invocation?: { modelInvocable: boolean; userInvocable: boolean },
    ) => {
      const bytes = Buffer.byteLength(text) + resources.reduce((n, r) => n + Buffer.byteLength(r.text), 0);
      if (prepared.size >= MAX_ITEMS || total + bytes > MAX_TOTAL) {
        warn('来源超过500项或16MiB总量，仅列出范围内的候选项。');
        return;
      }
      const itemPath = relative(source.root, file),
        id = `local:${source.kind}:${kind}:${hash(source.id + '\0' + itemPath + '\0' + (kind === 'mcp' ? name : '')).slice(0, 24)}`;
      if (prepared.has(id)) return;
      total += bytes;
      prepared.set(id, {
        candidate: {
          id,
          kind,
          sourceId: source.id,
          sourceKind: source.kind,
          name: redact(name).slice(0, 160),
          description: redact(description).slice(0, 4000),
          path: itemPath,
          hash: digest,
          bytes,
          ...(config ? { config } : {}),
          ...invocation,
        },
        text,
        resources,
      });
    };
    /**
     * 递归收集技能目录内允许的文本资源，排除链接、隐藏/敏感和依赖目录；共享项数/字节预算并检查取消。
     * EN: Recursively collects allowlisted skill text resources, excluding links, hidden/sensitive paths and dependencies under shared count/byte limits and cancellation.
     */
    const resources = async (
      directory: string,
      depth = 0,
      budget = { count: 0, bytes: 0 },
    ): Promise<Prepared['resources']> => {
      const result: Prepared['resources'] = [];
      if (depth > 5) return result;
      const directoryStat = await lstat(directory);
      if (
        directoryStat.isSymbolicLink() ||
        !directoryStat.isDirectory() ||
        !samePath(await realpath(directory), directory)
      )
        return result;
      const dir = await opendir(directory);
      for await (const entry of dir) {
        cancelled(signal);
        if (budget.count >= 100 || budget.bytes >= MAX_TOTAL - total - MAX_FILE) {
          warn('技能资源超过100项或剩余容量，额外资源未导入。');
          break;
        }
        if (
          entry.name.startsWith('.') ||
          secretName.test(entry.name) ||
          ['node_modules', '__pycache__'].includes(entry.name)
        )
          continue;
        const file = path.join(directory, entry.name);
        if (entry.isSymbolicLink()) {
          warn(`跳过链接：${relative(source.root, file)}`);
          continue;
        }
        if (entry.isDirectory()) {
          for (const child of await resources(file, depth + 1, budget))
            result.push({ ...child, path: entry.name + '/' + child.path });
        } else if (
          entry.isFile() &&
          entry.name !== 'SKILL.md' &&
          /\.(?:md|txt|json|yaml|yml|toml|csv|ts|js|mjs|py|sh|ps1|html|css|svg)$/i.test(entry.name)
        ) {
          try {
            const value = await read(file);
            const text = redact(value.text);
            if (budget.bytes + Buffer.byteLength(text) > MAX_TOTAL - total - MAX_FILE) {
              warn('技能资源达到剩余容量，额外资源未导入。');
              continue;
            }
            budget.count++;
            budget.bytes += Buffer.byteLength(text);
            result.push({ path: entry.name, text, hash: hash(text) });
          } catch (error) {
            if (signal?.aborted) throw error;
            warn(`资源未导入：${relative(source.root, file)}`);
          }
        }
      }
      return result.slice(0, 100);
    };
    /**
     * 有界遍历来源目录并解析允许的技能、记忆和会话；标准根限制首层范围，链接与敏感目录跳过，异常以有界警告保留。
     * EN: Traverses source roots within depth/entry/budget caps to parse skills, memory and sessions. Standard roots restrict first-level scope; links/sensitive paths are skipped with bounded diagnostics.
     */
    const visit = async (directory: string, depth: number) => {
      if (depth > 8 || visited > 4000 || prepared.size >= MAX_ITEMS || total >= MAX_TOTAL) return;
      const directoryStat = await lstat(directory);
      if (
        directoryStat.isSymbolicLink() ||
        !directoryStat.isDirectory() ||
        !samePath(await realpath(directory), directory)
      ) {
        warn(`跳过链接目录：${relative(source.root, directory)}`);
        return;
      }
      const dir = await opendir(directory);
      for await (const entry of dir) {
        cancelled(signal);
        if (++visited > 4000) {
          warn('来源目录超过4000个条目，扫描已到达上限。');
          break;
        }
        if (
          secretName.test(entry.name) ||
          ['node_modules', '.git', 'cache', 'logs', 'plugins', 'auth', 'credentials', '.system'].includes(
            entry.name,
          ) ||
          (source.kind === 'antigravity' &&
            ['brain', 'browser_profiles', 'conversations'].includes(entry.name))
        )
          continue;
        const file = path.join(directory, entry.name),
          rel = relative(source.root, file),
          segments = rel.split('/');
        if (entry.isSymbolicLink()) {
          warn(`跳过链接：${rel}`);
          continue;
        }
        if (entry.isDirectory()) {
          const agentDirectory =
            (source.kind === 'claude' && entry.name === '.claude') ||
            (source.kind === 'antigravity' && ['.agents', '.agent'].includes(entry.name)) ||
            (source.kind === 'antigravity' && samePath(directory, this.home) && entry.name === '.gemini');
          const allow =
            depth > 0 ||
            !standardRoot ||
            ['skills', 'memories', 'memory', 'projects', 'sessions', 'archived_sessions'].includes(
              entry.name,
            ) ||
            (['claude', 'antigravity'].includes(source.kind) && entry.name === 'rules') ||
            (source.kind === 'antigravity' &&
              ['config', 'antigravity', 'antigravity-cli'].includes(entry.name)) ||
            agentDirectory ||
            path.basename(source.root) === 'skills' ||
            (source.kind === 'dsh' && /^--|^_no-cwd/.test(entry.name));
          if (allow && (!entry.name.startsWith('.') || agentDirectory))
            try {
              await visit(file, depth + 1);
            } catch (error) {
              if (signal?.aborted) throw error;
              warn(`无法扫描目录：${rel}`);
            }
          continue;
        }
        if (!entry.isFile()) continue;
        if (source.kind === 'dsh') {
          const match = /^(.*\/)?session(?:\.v(\d+))?\.jsonl(\.zstd)?$/.exec(rel);
          if (match) {
            const key = match[1] ?? '',
              version = Number(match[2] ?? 0),
              compressed = Boolean(match[3]),
              old = latestDsh.get(key);
            if (!old || version > old.version || (version === old.version && compressed && !old.compressed))
              latestDsh.set(key, { path: rel, version, compressed });
          }
        }
        try {
          const isSkill =
            entry.name === 'SKILL.md' ||
            (source.kind === 'dsh' &&
              entry.name.endsWith('.md') &&
              ((depth === 1 && segments[0] === 'skills') ||
                (depth === 0 && !['.dsh', '.agents', 'memory', 'memories'].includes(rootName))));
          if (isSkill) {
            const value = await read(file),
              metadata = parseSkillMetadata(value.text, rel);
            if (!metadata.instructions) throw new AppError('SKILL_INVALID', '技能正文为空');
            const resourceList = (entry.name === 'SKILL.md' ? await resources(path.dirname(file)) : []).sort(
              (a, b) => a.path.localeCompare(b.path, 'en'),
            );
            const text = redact(value.text);
            parseSkillMetadata(text, rel);
            add(
              'skill',
              file,
              metadata.name,
              metadata.description,
              text,
              hash(
                stable({
                  sourceHash: value.hash,
                  resources: resourceList.map((r) => ({ path: r.path, hash: r.hash })),
                }),
              ),
              resourceList,
              undefined,
              { modelInvocable: metadata.modelInvocable, userInvocable: metadata.userInvocable },
            );
            continue;
          }
          if (
            /\.(?:jsonl|jsonl\.zstd)$/i.test(entry.name) &&
            (segments.some((s) => ['sessions', 'archived_sessions', 'projects'].includes(s)) ||
              source.kind === 'dsh')
          ) {
            const value = await read(file, true),
              text = conversationText(value.text, value.truncated);
            if (text)
              add(
                'memory',
                file,
                entry.name.replace(/\.jsonl(?:\.zstd)?$/, ''),
                '对话正文摘录；不含工具、系统指令、推理或凭据。',
                text,
                value.hash,
              );
            else warn(`没有可导入的对话正文：${rel}`);
            continue;
          }
          const isRule =
            (source.kind === 'claude' && /^(?:CLAUDE(?:\.local)?|AGENTS)\.md$/i.test(entry.name)) ||
            (source.kind === 'antigravity' && /^(?:GEMINI|AGENTS)\.md$/i.test(entry.name)) ||
            (['claude', 'antigravity'].includes(source.kind) &&
              entry.name.endsWith('.md') &&
              (rootName === 'rules' || segments.includes('rules')));
          if (
            /\.(?:md|txt)$/i.test(entry.name) &&
            (isRule ||
              segments.some((s) => ['memory', 'memories'].includes(s)) ||
              ['memory', 'memories'].includes(rootName) ||
              /^MEMORY\.md$/i.test(entry.name))
          ) {
            const value = await read(file),
              text = redact(value.text);
            add(
              'memory',
              file,
              entry.name,
              isRule
                ? '来源规则文档；保留正文与作用范围说明，作为按需记忆读取，不自动应用原工具触发条件。'
                : (text
                    .split('\n')
                    .find((line) => line.trim())
                    ?.slice(0, 160) ?? '本机记忆文档'),
              text,
              value.hash,
            );
            continue;
          }
          if (
            (depth === 0 ||
              (source.kind === 'claude' && path.basename(directory) === '.claude') ||
              (source.kind === 'antigravity' &&
                segments
                  .slice(0, -1)
                  .every((segment) =>
                    ['.gemini', 'config', 'antigravity', 'antigravity-cli', '.agent', '.agents'].includes(
                      segment,
                    ),
                  ))) &&
            /^(?:config\.(?:toml|json|ya?ml)|settings\.json|\.claude\.json|\.mcp\.json|mcp(?:_config)?\.json|cordis\.ya?ml)$/i.test(
              entry.name,
            )
          ) {
            const value = await read(file),
              parsed = entry.name.endsWith('.toml')
                ? { mcp_servers: tomlMcp(value.text) }
                : /\.ya?ml$/.test(entry.name)
                  ? yaml(value.text)
                  : JSON.parse(value.text);
            for (const item of configEntries(parsed, source.kind)) {
              const config = normalizeMcp(item.value);
              if (config.needsConfiguration)
                warn(
                  `MCP ${redact(item.name).slice(0, 80)} 需要补充环境变量引用或安全连接字段，导入后默认禁用。`,
                );
              add(
                'mcp',
                file,
                item.name,
                'MCP 连接配置；凭据仅保留环境变量名称。',
                stable(config),
                hash(stable({ sourceHash: value.hash, name: item.name })),
                [],
                config,
              );
            }
            continue;
          }
        } catch (error) {
          if (signal?.aborted) throw error;
          warn(`未导入 ${rel}：${error instanceof AppError ? error.message : '格式无效或文件不可读'}`);
        }
      }
    };
    await visit(source.root, 0);
    cancelled(signal);
    /**
     * DSH保留不可变前代日志，仅导入最新规范日志。
     * EN: DSH keeps immutable predecessor generations; import only the newest canonical log.
     */
    if (source.kind === 'dsh') {
      for (const [id, item] of prepared) {
        const match = /^(.*\/)?session(?:\.v(\d+))?\.jsonl(\.zstd)?$/.exec(item.candidate.path);
        if (!match) continue;
        if (latestDsh.get(match[1] ?? '')?.path !== item.candidate.path) prepared.delete(id);
      }
    }
    return { prepared, warnings };
  }
  /**
   * 显式同步选中的候选：先重新采集并核对扫描时哈希，再在事务中复核库版本。 保留用户对 MCP 的本地覆盖；覆盖项的来源发生变化时要求重新核对，不能静默替换。
   * EN: Explicitly synchronizes selected candidates: recollect and verify their scanned hashes, then recheck library revision in a transaction. Preserves local MCP overrides; changed override sources require revalidation rather than silent replacement.
   */
  async sync(
    scanId: string,
    ids: string[],
    expectedRevision: number,
    signal?: AbortSignal,
    commandId?: string,
  ): Promise<LocalAgentOverview> {
    const payload = { action: 'local-agents:sync', scanId, ids, expectedRevision },
      replayed = this.replay(commandId, payload);
    if (replayed) return replayed;
    this.revision(expectedRevision);
    const cached = this.scans.get(scanId);
    if (!cached || Date.now() - cached.createdAt > 10 * 60 * 1000)
      throw new AppError('LOCAL_SCAN_EXPIRED', '扫描已过期，请重新扫描', false, null, 409);
    if (
      !ids.length ||
      ids.length > MAX_ITEMS ||
      new Set(ids).size !== ids.length ||
      ids.some((id) => !cached.prepared.has(id))
    )
      throw new AppError('LOCAL_SELECTION_INVALID', '请选择扫描结果中的同步项');
    const current = await this.collect(cached.result.source, signal);
    cancelled(signal);
    const selected = ids.map((id) => {
      const item = current.prepared.get(id);
      if (!item || item.candidate.hash !== cached.prepared.get(id)!.candidate.hash)
        throw new AppError(
          'LOCAL_SOURCE_CHANGED',
          '选择的来源内容已改变，请重新扫描后确认',
          false,
          null,
          409,
        );
      return item;
    });
    /**
     * 在事务内重新核对库版本和已导入对象，保存选择的正文/资源对象并合并元数据；本地改写的 MCP 与变化来源冲突时拒绝覆盖。
     * EN: Rechecks library revision/imported objects transactionally, saves selected text/resource objects and merges metadata; changed sources cannot overwrite locally edited MCP configuration.
     */
    const commit = () =>
      this.store.tx(() => {
        this.revision(expectedRevision);
        const library = importedLibrary(this.store),
          timestamp = new Date().toISOString();
        for (const entry of selected) {
          const old = library.items.find((i) => i.id === entry.candidate.id);
          if (old?.contentRef) localItemText(this.store, old);
          if (old?.configOverridden && old.hash !== entry.candidate.hash)
            throw new AppError(
              'LOCAL_ITEM_EDITED',
              'MCP 配置已有本地修改且来源已改变，请核对后移除重新导入',
              false,
              null,
              409,
            );
        }
        const merged = new Map(library.items.map((item) => [item.id, item]));
        for (const entry of selected) {
          const old = merged.get(entry.candidate.id),
            object = this.store.object(entry.text);
          const item: LocalStoredItem = {
            ...entry.candidate,
            contentRef: object.objectRef,
            contentHash: object.hash,
            enabled: old?.enabled ?? entry.candidate.kind !== 'mcp',
            importedAt: old?.importedAt ?? timestamp,
            updatedAt: timestamp,
            ...(entry.resources.length
              ? {
                  resourcePaths: entry.resources.map((r) => r.path),
                  resourceRefs: entry.resources.map((r) => {
                    const object = this.store.object(r.text);
                    return {
                      path: r.path,
                      objectRef: object.objectRef,
                      hash: object.hash,
                      bytes: Buffer.byteLength(r.text),
                    };
                  }),
                }
              : {}),
            ...(old?.configOverridden ? { config: old.config, configOverridden: true } : {}),
          };
          merged.set(item.id, item);
        }
        if (
          merged.size > MAX_ITEMS ||
          [...merged.values()].reduce((sum, item) => sum + item.bytes, 0) > MAX_TOTAL
        )
          throw new AppError('LOCAL_LIBRARY_LIMIT', '已同步内容超过500项或16MiB，请先移除不需要的项');
        const sources = new Map(library.sources.map((source) => [source.id, source]));
        sources.set(cached.result.source.id, { ...cached.result.source, syncedAt: timestamp });
        writeImportedLibrary(this.store, {
          version: 1,
          revision: library.revision + 1,
          sources: [...sources.values()],
          items: [...merged.values()],
        });
        return this.overview();
      });
    return commandId ? this.store.command(commandId, payload, commit) : commit();
  }
  /**
   * 对单个持久项执行版本化修改；启用不完整 MCP 被拒绝，移除只影响本地导入库。
   * EN: Applies a versioned edit to one stored item. Incomplete MCP entries cannot be enabled; removal affects only the imported library.
   */
  update(
    itemId: string,
    changes: { enabled?: boolean; remove?: boolean; config?: LocalMcpConfig },
    expectedRevision: number,
    commandId?: string,
  ): LocalAgentOverview {
    const payload = { action: 'local-agents:update', itemId, changes, expectedRevision },
      replayed = this.replay(commandId, payload);
    if (replayed) return replayed;
    /**
     * 事务内按版本修改单项的启用、移除或 MCP 配置并递增库版本；未补全的 MCP 禁止启用，返回更新后的公开目录。
     * EN: Transactionally revision-checks item enable/remove/MCP edits and increments library revision; incomplete MCP cannot be enabled, then returns the updated public catalog.
     */
    const commit = () =>
      this.store.tx(() => {
        this.revision(expectedRevision);
        const library = importedLibrary(this.store),
          item = library.items.find((i) => i.id === itemId);
        if (!item) throw new AppError('LOCAL_ITEM_NOT_FOUND', '同步项不存在', false, null, 404);
        if (changes.remove) {
          library.items = library.items.filter((i) => i.id !== itemId);
        } else {
          if (changes.config) {
            if (item.kind !== 'mcp') throw new AppError('LOCAL_ITEM_INVALID', '只有 MCP 可以修改连接配置');
            item.config = validateLocalMcpConfig(changes.config);
            item.configOverridden = true;
          }
          if (changes.enabled !== undefined) {
            if (changes.enabled && item.kind === 'mcp' && item.config?.needsConfiguration)
              throw new AppError('MCP_CONFIGURATION_REQUIRED', '请先补充安全连接字段和环境变量引用');
            item.enabled = changes.enabled;
          }
          item.updatedAt = new Date().toISOString();
        }
        library.revision++;
        writeImportedLibrary(this.store, library);
        return this.overview();
      });
    return commandId ? this.store.command(commandId, payload, commit) : commit();
  }
  /**
   * 以内容摘要分页预览已导入资料；MCP 展示的是规范化安全配置，而非原始秘密配置文件。
   * EN: Paginates imported reference previews by content digest. MCP previews expose normalized safe configuration rather than original secret-bearing files.
   */
  preview(itemId: string, options: { offset?: number; limit?: number; query?: string } = {}) {
    const item = localItem(this.store, itemId, undefined, true),
      text = item.kind === 'mcp' ? stable(item.config) : localItemText(this.store, item);
    return pageLocalText({ ...item, contentHash: hash(text) }, text, options);
  }
  /**
   * 释放进程内预扫描缓存；不删除已经持久导入的条目或来源文件。
   * EN: Clears in-memory prepared scans without deleting imported entries or source files.
   */
  close() {
    this.scans.clear();
  }
}
