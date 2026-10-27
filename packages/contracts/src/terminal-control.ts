// 终端应用、连接与控制配置的校验和契约。
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
// API 地址只允许 HTTP(S)，禁止把凭据、查询参数或片段混入地址。
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
// 凭据按来源区分，配置保存引用信息而非把密钥放进 API 地址。
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
  health?: TerminalConnectionHealth;
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
export const TerminalConnectionProbeRequest = z
  .object({ expectedRevision: z.number().int().nonnegative() })
  .strict();
export type TerminalConnectionProbeRequest = z.infer<typeof TerminalConnectionProbeRequest>;
export const TerminalConnectionModel = z.object({ id: safeText(200), name: safeText(200) }).strict();
export type TerminalConnectionModel = z.infer<typeof TerminalConnectionModel>;
/** Explicit remote operations never return provider response text or credential values. */
// 探测结果记录连接验证与模型目录数据，不能代替后续实际请求结果。
export const TerminalConnectionProbeResult = z
  .object({
    connectionId: z.string().uuid(),
    revision: z.number().int().nonnegative(),
    checkedAt: z.string().datetime(),
    status: z.enum(['passed', 'failed', 'unsupported']),
    code: safeText(100),
    message: safeText(1000),
    latencyMs: z.number().int().nonnegative(),
    httpStatus: z.number().int().min(100).max(599).optional(),
    resolvedModel: safeText(200).optional(),
    models: z.array(TerminalConnectionModel).max(2000).optional(),
    truncated: z.boolean().optional(),
  })
  .strict();
export type TerminalConnectionProbeResult = z.infer<typeof TerminalConnectionProbeResult>;
/** Persist summaries only: never provider bodies, generated text, model lists or credentials. */
export const TerminalConnectionHealthResult = TerminalConnectionProbeResult.omit({
  models: true,
  resolvedModel: true,
})
  .extend({ modelCount: z.number().int().nonnegative().optional() })
  .strict();
export type TerminalConnectionHealthResult = z.infer<typeof TerminalConnectionHealthResult>;
export const TerminalConnectionHealth = z
  .object({
    connectionId: z.string().uuid(),
    revision: z.number().int().nonnegative(),
    check: TerminalConnectionHealthResult.optional(),
    models: TerminalConnectionHealthResult.optional(),
  })
  .strict();
export type TerminalConnectionHealth = z.infer<typeof TerminalConnectionHealth>;
export const TerminalProfileDiagnostics = z
  .object({
    profileId: z.string().uuid(),
    profileLabel: safeText(80),
    appId: TerminalAppId,
    image: z.string(),
    settingsRevision: z.number().int().nonnegative(),
    appsRevision: z.number().int().nonnegative(),
    projectId: z.string().uuid().nullable(),
    projectRevision: z.number().int().nonnegative().nullable(),
    source: z.enum(['template', 'project', 'app', 'environment']),
    connection: TerminalConnectionBinding.nullable(),
    keyConfigured: z.boolean().nullable(),
    environmentNames: z.array(z.string()),
    missingEnvironment: z.array(z.string()),
    commandPreview: z.array(z.string()),
    issues: z.array(
      z
        .object({ severity: z.enum(['error', 'warning']), code: safeText(100), message: safeText(1000) })
        .strict(),
    ),
    ready: z.boolean(),
  })
  .strict();
export type TerminalProfileDiagnostics = z.infer<typeof TerminalProfileDiagnostics>;
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
export const TerminalCliInstallationPhase = z.enum([
  'queued',
  'engine',
  'base-image',
  'build',
  'verify',
  'complete',
]);
export type TerminalCliInstallationPhase = z.infer<typeof TerminalCliInstallationPhase>;
export const TerminalCliInstallationJob = z
  .object({
    id: z.string().uuid(),
    revision: z.number().int().nonnegative(),
    appId: TerminalAppId,
    profileId: z.string().uuid().nullable(),
    baseImage: z.string().min(1).max(200),
    requestedVersion: z.string().min(1).max(80).optional(),
    status: z.enum(['running', 'completed', 'failed', 'cancelled']),
    phase: TerminalCliInstallationPhase.optional(),
    phaseStartedAt: z.string().optional(),
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
