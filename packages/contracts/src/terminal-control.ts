import { z } from 'zod';

export const TerminalAppId = z.enum(['codex', 'dsh', 'claude', 'gemini', 'custom']);
export type TerminalAppId = z.infer<typeof TerminalAppId>;
export const TerminalConnectionProtocol = z.enum([
  'openai-responses',
  'openai-chat',
  'anthropic-messages',
  'gemini',
]);
export type TerminalConnectionProtocol = z.infer<typeof TerminalConnectionProtocol>;
const safeText = (maximum: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(maximum)
    .regex(/^[^\u0000-\u001f\u007f]+$/);
export const TerminalApiBaseUrl = z
  .string()
  .trim()
  .max(2000)
  .url()
  .refine((value) => {
    const url = new URL(value);
    return (
      ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash
    );
  }, 'API 地址须为 HTTP(S)，且不能包含账号、密钥、查询或片段');
export const TerminalCredential = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('environment'), env: z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/) }).strict(),
  z.object({ kind: z.literal('vault'), credentialRef: z.string().uuid() }).strict(),
]);
export type TerminalCredential = z.infer<typeof TerminalCredential>;
/** Frozen on a run; references never resolve through a mutable connection record. */
export const TerminalConnectionBinding = z
  .object({
    id: z.string().uuid(),
    revision: z.number().int().nonnegative(),
    name: safeText(80),
    protocol: TerminalConnectionProtocol,
    baseUrl: TerminalApiBaseUrl,
    model: safeText(200),
    auth: TerminalCredential,
  })
  .strict();
export type TerminalConnectionBinding = z.infer<typeof TerminalConnectionBinding>;
export interface TerminalConnectionView extends TerminalConnectionBinding {
  keyConfigured: boolean;
  credentialSource: 'environment' | 'vault';
}
export const TerminalConnectionWrite = z
  .object({
    commandId: z.string().uuid(),
    expectedRevision: z.number().int().nonnegative(),
    connection: z
      .object({
        name: safeText(80),
        protocol: TerminalConnectionProtocol,
        baseUrl: TerminalApiBaseUrl,
        model: safeText(200),
        credentialMode: z.enum(['environment', 'vault']),
        apiKeyEnv: z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/),
      })
      .strict(),
    apiKey: z.string().trim().min(1).max(8192).optional(),
  })
  .strict()
  .refine((value) => value.connection.credentialMode === 'vault' || value.apiKey === undefined, {
    message: '环境变量模式不接收 API Key，请选择加密保存',
    path: ['apiKey'],
  });
export type TerminalConnectionWrite = z.infer<typeof TerminalConnectionWrite>;
export const TerminalControlApps = z
  .object({
    revision: z.number().int().nonnegative(),
    defaultAppId: TerminalAppId,
    entries: z
      .array(
        z
          .object({
            id: TerminalAppId,
            visible: z.boolean(),
            connectionId: z.string().uuid().nullable(),
          })
          .strict(),
      )
      .length(5),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.entries.map((entry) => entry.id)).size !== 5)
      context.addIssue({ code: 'custom', path: ['entries'], message: '请保留所有应用且不要重复' });
    if (!value.entries.some((entry) => entry.id === value.defaultAppId && entry.visible))
      context.addIssue({ code: 'custom', path: ['defaultAppId'], message: '默认应用须开启显示' });
  });
export type TerminalControlApps = z.infer<typeof TerminalControlApps>;
export const TerminalProjectPreferences = z
  .object({
    revision: z.number().int().nonnegative(),
    defaultProfileId: z.string().uuid().nullable(),
    connectionId: z.string().uuid().nullable(),
  })
  .strict();
export type TerminalProjectPreferences = z.infer<typeof TerminalProjectPreferences>;
export interface TerminalAppCatalogEntry {
  id: TerminalAppId;
  label: string;
  description: string;
  executable: string;
  protocols: TerminalConnectionProtocol[];
  preset: {
    id: string;
    label: string;
    agent: 'codex' | 'dsh' | 'claude' | 'gemini' | 'custom';
    image: string;
    command: string[];
    protocol: 'codex-jsonl' | 'dsh-jsonl' | 'claude-stream-json' | 'gemini-stream-json' | 'text';
    environment: string[];
  };
}
export interface TerminalControlOverview {
  catalog: TerminalAppCatalogEntry[];
  apps: TerminalControlApps;
  connections: TerminalConnectionView[];
}
export const TerminalCliInstallationJob = z
  .object({
    id: z.string().uuid(),
    revision: z.number().int().nonnegative(),
    appId: TerminalAppId,
    profileId: z.string().uuid().nullable(),
    baseImage: z.string().min(1).max(200),
    requestedVersion: z.string().min(1).max(80).optional(),
    status: z.enum(['running', 'completed', 'failed', 'cancelled']),
    result: z
      .object({
        image: z.string().regex(/^sha256:[a-f0-9]{64}$/),
        imageTag: z.string().min(1).max(200),
        version: z.string().min(1).max(80),
      })
      .strict()
      .optional(),
    code: z.string().min(1).max(100).optional(),
    message: z.string().min(1).max(1000).optional(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict();
export type TerminalCliInstallationJob = z.infer<typeof TerminalCliInstallationJob>;
