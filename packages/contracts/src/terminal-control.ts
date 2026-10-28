/**
 * 终端应用、连接与控制配置的校验和契约。
 * 可编辑连接、安全视图和任务冻结绑定分离，凭据原文不进入公开诊断或目录。
 *
 * EN: Defines validation and contracts for terminal applications, connections, and control settings.
 * Separates editable connections, safe views, and frozen bindings; secrets never enter public diagnostics/catalogs.
 */
import { z } from 'zod';

export const TerminalAppId = z.enum(['codex', 'dsh', 'claude', 'gemini', 'antigravity', 'custom']);
export type TerminalAppId = z.infer<typeof TerminalAppId>;
export const TerminalConnectionProtocol = z.enum([
  'openai-responses',
  'openai-chat',
  'anthropic-messages',
  'gemini',
]);
export type TerminalConnectionProtocol = z.infer<typeof TerminalConnectionProtocol>;
/** 构造有长度上限的非空展示字段，拒绝控制字符，避免协议或诊断文本污染安全视图。
 * EN: Builds a bounded nonempty display-field schema that rejects control characters in safe configuration views.
 */
const safeText = (maximum: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(maximum)
    .regex(/^[^\u0000-\u001f\u007f]+$/);
/**
 * API 地址只允许 HTTP(S)，禁止把凭据、查询参数或片段混入地址。
 *
 * EN: API addresses allow only HTTP(S), with no embedded credentials, query, or fragment.
 */
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
/**
 * 凭据按来源区分，配置保存引用信息而非把密钥放进 API 地址。
 *
 * EN: Credentials are distinguished by source; settings save references rather than embedding secrets in the API address.
 */
export const TerminalCredential = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('environment'), env: z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/) }).strict(),
  z.object({ kind: z.literal('vault'), credentialRef: z.string().uuid() }).strict(),
]);
export type TerminalCredential = z.infer<typeof TerminalCredential>;
/**
 * 在运行中冻结；引用不能再通过可变连接记录解析。
 *
 * EN: Frozen on a run; references never resolve through a mutable connection record.
 */
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
/**
 * 编辑连接的幂等命令；密钥只允许加密保存模式接收，环境变量模式只保存变量名。
 *
 * EN: An idempotent connection-edit command; only encrypted-vault mode accepts a secret, while environment mode saves a variable name.
 */
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
/**
 * 显式远端操作不返回供应商响应正文或凭据值。
 * 探测结果记录连接验证与模型目录数据，不能代替后续实际请求结果。
 *
 * EN: Explicit remote operations never return provider response text or credential values.
 * Probe results record connection checks and model catalogs; they do not replace later actual request outcomes.
 */
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
/**
 * 只持久保存摘要，不保存供应商正文、生成文本、模型列表或凭据。
 *
 * EN: Persist summaries only: never provider bodies, generated text, model lists or credentials.
 */
export const TerminalConnectionHealthResult = TerminalConnectionProbeResult.omit({
  models: true,
  resolvedModel: true,
})
  .extend({ modelCount: z.number().int().nonnegative().optional() })
  .strict();
export type TerminalConnectionHealthResult = z.infer<typeof TerminalConnectionHealthResult>;
/**
 * 连通性与模型目录分别记录时间和状态，且都绑定连接修订以识别配置变化后的旧结果。
 *
 * EN: Connectivity and model catalogs keep separate timestamps/states, both bound to connection revision to detect stale results.
 */
export const TerminalConnectionHealth = z
  .object({
    connectionId: z.string().uuid(),
    revision: z.number().int().nonnegative(),
    check: TerminalConnectionHealthResult.optional(),
    models: TerminalConnectionHealthResult.optional(),
  })
  .strict();
export type TerminalConnectionHealth = z.infer<typeof TerminalConnectionHealth>;
/**
 * 模板/项目/应用选择解析后的安全诊断；只列环境变量名和命令预览，不返回凭据值。
 *
 * EN: A safe diagnosis after resolving template/project/app choices; returns environment names and command previews, never secret values.
 */
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
/**
 * 固定保留五个应用身份，可调整可见性和连接；默认应用必须在可见集合内。
 *
 * EN: Retains five fixed application identities with configurable visibility/connections; the default app must be visible.
 */
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
/**
 * 项目级模板与连接选择，null 表示沿用上层默认，不复制可变连接作为运行绑定。
 *
 * EN: Project-level template and connection selections; null follows the upper default, and a mutable connection is not copied as the run binding.
 */
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
    agent: 'codex' | 'dsh' | 'claude' | 'gemini' | 'antigravity' | 'custom';
    image: string;
    command: string[];
    protocol: 'codex-jsonl' | 'dsh-jsonl' | 'claude-stream-json' | 'gemini-stream-json' | 'antigravity-stream-json' | 'text';
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
/**
 * 安装任务的阶段快照；只有核验后的 result 才包含实际镜像摘要和实际 CLI 版本。
 *
 * EN: An installation-stage snapshot; only a verified result contains the actual image digest and CLI version.
 */
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
