/**
 * 本地代理、技能、记忆及 MCP 配置的数据契约。
 * 目录、导入记录和冻结资源分开表达，使发现资料不等同于启用或执行资料。
 *
 * EN: Defines local agent, skill, memory, and MCP configuration records.
 * Separates catalogs, imports, and frozen resources so discovery is not enablement or execution.
 */
export type LocalAgentKind = 'codex' | 'claude' | 'dsh';
export type LocalItemKind = 'memory' | 'skill' | 'mcp';
/**
 * stdio 使用命令与环境变量名；HTTP 使用 URL 和请求头对应的环境变量名。
 *
 * EN: stdio uses a command and environment-variable names; HTTP uses a URL and environment references for headers.
 */
export interface LocalMcpConfig {
  transport: 'stdio' | 'http';
  command?: string;
  args?: string[];
  cwd?: string;
  envNames: string[];
  url?: string;
  headerEnv: Record<string, string>;
  bearerTokenEnv?: string;
  allowedTools?: string[];
  deniedTools?: string[];
  needsConfiguration: boolean;
}
export interface LocalAgentSource {
  id: string;
  kind: LocalAgentKind;
  root: string;
  name: string;
  syncedAt?: string;
}
/**
 * 扫描阶段发现的候选元数据；未被导入且启用之前不能作为运行能力。
 *
 * EN: Metadata discovered during scanning; it cannot become a run capability before explicit import and enablement.
 */
export interface LocalAgentCandidate {
  id: string;
  kind: LocalItemKind;
  sourceId: string;
  sourceKind: LocalAgentKind;
  name: string;
  description: string;
  path: string;
  hash: string;
  bytes: number;
  config?: LocalMcpConfig;
  modelInvocable?: boolean;
  userInvocable?: boolean;
}
/**
 * 导入记录保留当前内容摘要与显式启用状态，来源扫描哈希和存储内容摘要分别保存。
 *
 * EN: An imported record retains its current content digest and explicit enabled state; source-scan and stored-content hashes are distinct.
 */
export interface LocalAgentItem extends LocalAgentCandidate {
  enabled: boolean;
  importedAt: string;
  updatedAt: string;
  contentHash: string;
  resourcePaths?: string[];
}
export interface LocalAgentOverview {
  revision: number;
  sources: LocalAgentSource[];
  items: LocalAgentItem[];
  defaults: { kind: LocalAgentKind; roots: string[] }[];
}
/**
 * 有有效期的只读扫描结果，用户选定后才能导入；warnings 说明未能完整扫描的部分。
 *
 * EN: A read-only scan result with an expiry; only user-selected entries may be imported, and warnings describe incomplete scan coverage.
 */
export interface LocalAgentScan {
  scanId: string;
  source: LocalAgentSource;
  candidates: LocalAgentCandidate[];
  warnings: string[];
  expiresAt: string;
}
/**
 * UTF-16 文字页及下一偏移，hash 绑定正文版本；正文中的命令仍按不可信资料处理。
 *
 * EN: A UTF-16 text page and next offset; hash binds the body version, while commands in the body remain untrusted data.
 */
export interface LocalContentPage {
  id: string;
  text: string;
  offset: number;
  nextOffset: number | null;
  totalCharacters: number;
  hash: string;
  path?: string;
  trust: 'untrusted';
}
