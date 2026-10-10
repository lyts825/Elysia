export type LocalAgentKind = 'codex' | 'claude' | 'dsh';
export type LocalItemKind = 'memory' | 'skill' | 'mcp';
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
export interface LocalAgentScan {
  scanId: string;
  source: LocalAgentSource;
  candidates: LocalAgentCandidate[];
  warnings: string[];
  expiresAt: string;
}
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
