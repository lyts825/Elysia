/**
 * 注册可信的来源、回信和语义路由端口，默认没有外接适配器。
 * 适配器只读冻结的项目来源绑定；路由输出是提案，不是执行或授权命令。
 * EN: Registers trusted source, channel and semantic routing ports with no default external adapters.
 * Adapters receive frozen project-source bindings; routing outputs are proposals, never execution or authorization commands.
 */
import { invariant } from '../../contracts/src/index.js';
import type {
  AutomationSourceInstance,
  AutomationSourceBatch,
  AutomationOutboxMessage,
  AutomationDeliveryResult,
  AutomationCandidate,
  AutomationIncomingEvent,
  AutomationRouteProposal,
} from '../../contracts/src/automation-plugins.js';
import { PluginRegistry, type PluginContributions } from './index.js';

export interface AutomationAdapterContext {
  readonly source: Readonly<AutomationSourceInstance>;
  readonly config: Readonly<Record<string, unknown>>;
  readonly signal: AbortSignal;
}
export interface AutomationSourceAdapter {
  /** 同步校验非敏感配置；凭据值由适配器自行从宿主引用解析，不写入配置。
   * EN: Synchronously validates non-secret configuration; adapters resolve credentials through host references, never config values. */
  validateConfig(config: Record<string, unknown>): Record<string, unknown>;
  /** 显式读取一次；返回的游标必须与输入快照匹配，宿主原子接收整批事件。
   * EN: Performs one explicit read; its cursor must match the snapshot and the host commits the batch atomically. */
  read(context: AutomationAdapterContext): Promise<AutomationSourceBatch>;
}
export interface AutomationChannelAdapter {
  /** 按稳定 message.id 发送；未证明没有副作用的失败必须返回 unknown 或抛错。
   * EN: Sends using stable message.id; failures without proof of no side effect must return unknown or throw. */
  send(
    context: AutomationAdapterContext & {
      readonly message: Readonly<AutomationOutboxMessage>;
      readonly text: string;
    },
  ): Promise<AutomationDeliveryResult>;
  /** 只查询远端事实，不发送；not-sent 必须证明原消息没有送达且没有仍在途的请求。
   * EN: Reads remote evidence without sending; not-sent proves neither delivery nor an outstanding original request. */
  reconcile?(
    context: AutomationAdapterContext & { readonly message: Readonly<AutomationOutboxMessage> },
  ): Promise<AutomationDeliveryResult>;
}
export interface AutomationRouterAdapter {
  /** 只提出路由建议；宿主验证目标项目并持久记录，不自动创建运行、授权或订阅。
   * EN: Only proposes routing; the host checks project ownership and records it without creating runs, authority or subscriptions. */
  propose(
    context: AutomationAdapterContext & {
      readonly candidate: Readonly<AutomationCandidate>;
      readonly event: Readonly<AutomationIncomingEvent>;
    },
  ): Promise<AutomationRouteProposal>;
}
interface AutomationAdapterMap {
  source: AutomationSourceAdapter;
  channel: AutomationChannelAdapter;
  router: AutomationRouterAdapter;
}
export type AutomationContribution =
  | { kind: 'source'; adapter: AutomationSourceAdapter }
  | { kind: 'channel'; adapter: AutomationChannelAdapter }
  | { kind: 'router'; adapter: AutomationRouterAdapter };
export type AutomationPlugin = PluginContributions<AutomationContribution>;

/** 固定插件注册表复用共享身份/冲突校验，并验证每类真实调用端口。
 * EN: A fixed registry reuses shared identity/conflict checks and verifies actual callable ports. */
export class AutomationPlugins {
  private readonly registry: PluginRegistry<AutomationContribution>;
  constructor(plugins: readonly AutomationPlugin[] = []) {
    this.registry = new PluginRegistry(plugins);
    for (const [, contribution] of this.registry.entries()) {
      invariant(
        contribution && ['source', 'channel', 'router'].includes(contribution.kind),
        'PLUGIN_CONTRACT',
        '自动化贡献类型无效',
      );
      const valid =
        contribution.kind === 'source'
          ? typeof contribution.adapter?.read === 'function' &&
            typeof contribution.adapter.validateConfig === 'function'
          : contribution.kind === 'channel'
            ? typeof contribution.adapter?.send === 'function'
            : typeof contribution.adapter?.propose === 'function';
      invariant(valid, 'PLUGIN_CONTRACT', '自动化插件缺少调用端口');
    }
  }
  /** 查询指定类型端口；未装配时不回退到其他类型或平台。
   * EN: Looks up the requested port without falling back to another kind or platform. */
  get<K extends keyof AutomationAdapterMap>(
    kind: K,
    name: string | null,
  ): AutomationAdapterMap[K] | undefined {
    const entry = name === null ? undefined : this.registry.get(name);
    return entry?.kind === kind ? (entry.adapter as AutomationAdapterMap[K]) : undefined;
  }
  /** 必需的适配器缺失时给出明确的未配置错误。
   * EN: A missing required adapter produces an explicit not-configured error. */
  require<K extends keyof AutomationAdapterMap>(kind: K, name: string | null): AutomationAdapterMap[K] {
    const adapter = this.get(kind, name);
    invariant(adapter, 'AUTOMATION_NOT_CONFIGURED', `未配置 ${kind} 适配器：${name ?? '无'}`);
    return adapter;
  }
  /** 只返回注册身份和能力名称，不暴露实例配置或凭据引用。
   * EN: Returns registration identity and capability names without instance config or credential references. */
  describe() {
    const entries = this.registry.entries();
    return {
      configured: entries.length > 0,
      plugins: this.registry.describe(),
      sources: entries.filter(([, item]) => item.kind === 'source').map(([name]) => name),
      channels: entries.filter(([, item]) => item.kind === 'channel').map(([name]) => name),
      routers: entries.filter(([, item]) => item.kind === 'router').map(([name]) => name),
      defaultRouter: 'subscriptions-or-candidate' as const,
    };
  }
}
