// 本地代理、技能、记忆及 MCP 配置的数据契约。
export type LocalAgentKind = 'codex' | 'claude' | 'dsh';
export type LocalItemKind = 'memory' | 'skill' | 'mcp';
// stdio 使用命令与环境变量名；HTTP 使用 URL 和请求头对应的环境变量名。
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
/** 扫描阶段发现的候选元数据；未被导入且启用之前不能作为运行能力。 */
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
/** 导入记录保留当前内容摘要与显式启用状态，来源扫描哈希和存储内容摘要分别保存。 */
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
/** 有有效期的只读扫描结果，用户选定后才能导入；warnings 说明未能完整扫描的部分。 */
export interface LocalAgentScan {
  scanId: string;
  source: LocalAgentSource;
  candidates: LocalAgentCandidate[];
  warnings: string[];
  expiresAt: string;
}
/** UTF-16 文字页及下一偏移，hash 绑定正文版本；正文中的命令仍按不可信资料处理。 */
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
