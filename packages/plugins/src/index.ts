// 定义插件清单、贡献及注册表的共享机制。
import { AppError, invariant } from '../../contracts/src/index.js';

export const PLUGIN_API_VERSION = 1;

/** 宿主可检查的插件身份；apiVersion 约束共享接口，version 标记插件实现。 */
export interface PluginManifest {
  readonly id: string;
  readonly version: string;
  readonly apiVersion: typeof PLUGIN_API_VERSION;
}

/** 同一插件的清单与命名贡献点；名称冲突在整个注册表中拒绝。 */
export interface PluginContributions<T> {
  readonly manifest: PluginManifest;
  readonly contributions: Readonly<Record<string, T>>;
}

function checkedManifest(manifest: PluginManifest): Readonly<PluginManifest> {
  // 身份、版本和接口版本在注册或加载前校验；冻结副本避免调用方事后改写清单。
  invariant(
    manifest &&
      /^[a-z][a-z0-9.-]*$/.test(manifest.id) &&
      /^\d+(?:\.\d+){0,2}$/.test(manifest.version) &&
      manifest.apiVersion === PLUGIN_API_VERSION,
    'PLUGIN_CONTRACT',
    '插件身份或接口版本无效',
  );
  return Object.freeze({ id: manifest.id, version: manifest.version, apiVersion: manifest.apiVersion });
}

/** An immutable composition of trusted code. This is not an external-code sandbox. */
export class PluginRegistry<T> {
  private readonly contributions = new Map<string, T>();
  private readonly manifests: ReadonlyArray<{
    manifest: Readonly<PluginManifest>;
    contributions: readonly string[];
  }>;

  constructor(plugins: readonly PluginContributions<T>[]) {
    const ids = new Set<string>();
    this.manifests = Object.freeze(
      plugins.map((plugin) => {
        const manifest = checkedManifest(plugin.manifest);
        invariant(!ids.has(manifest.id), 'PLUGIN_DUPLICATE', `插件重复注册：${manifest.id}`);
        ids.add(manifest.id);
        const names = Object.keys(plugin.contributions);
        // 贡献名在整个注册表内唯一，不能因插件顺序而覆盖已有实现。
        for (const name of names) {
          invariant(
            name.trim().length > 0 && plugin.contributions[name] !== undefined,
            'PLUGIN_CONTRACT',
            `插件贡献点无效：${manifest.id}`,
          );
          invariant(!this.contributions.has(name), 'PLUGIN_CONTRIBUTION_CONFLICT', `插件贡献点重复：${name}`);
          this.contributions.set(name, plugin.contributions[name]);
        }
        return Object.freeze({ manifest, contributions: Object.freeze(names) });
      }),
    );
  }

  /** 可选查询；不触发模块加载，也不允许调用方替换贡献。 */
  get(name: string): T | undefined {
    return this.contributions.get(name);
  }

  /** 必需贡献缺失时给出稳定错误，避免宿主悄悄选择另一个实现。 */
  require(name: string): T {
    const contribution = this.get(name);
    invariant(contribution !== undefined, 'PLUGIN_CONTRIBUTION_MISSING', `插件贡献点不存在：${name}`);
    return contribution;
  }

  /** 返回映射副本用于遍历，内部注册顺序和映射不暴露给外部修改。 */
  entries(): ReadonlyArray<readonly [string, T]> {
    return [...this.contributions.entries()];
  }

  describe() {
    return this.manifests;
  }
}

export interface PluginInstance {
  dispose(): void | Promise<void>;
}

/** 工厂只接收宿主提供的能力上下文；create 若在返回实例前失败，其局部资源由工厂清理。 */
export interface PluginFactory<Context, Instance extends PluginInstance> {
  readonly manifest: PluginManifest;
  create(context: Context): Instance | Promise<Instance>;
}

/** One lazy instance per owner, with shared activation and idempotent shutdown. */
export class LazyPlugin<Context, Instance extends PluginInstance> {
  readonly manifest: Readonly<PluginManifest>;
  private instance?: Instance;
  private pending?: Promise<Instance>;
  private closing?: Promise<void>;
  private closed = false;
  private cleanupFailure?: AggregateError;

  constructor(
    manifest: PluginManifest,
    private readonly context: Context,
    private readonly loader: () => Promise<PluginFactory<Context, Instance>>,
    private readonly validate: (instance: Instance) => void = () => {},
  ) {
    this.manifest = checkedManifest(manifest);
  }

  get loaded() {
    return this.instance;
  }

  /**
   * 惰性激活一个实例；同宿主并发调用共享 pending，成功后共享 instance。
   * 校验或关闭竞争发生在 create 后时由本层释放；清理失败永久记住，防止重试叠加副作用。
   */
  load(): Promise<Instance> {
    if (this.cleanupFailure) return Promise.reject(this.cleanupFailure);
    if (this.closed)
      return Promise.reject(new AppError('PLUGIN_DISPOSED', `插件已释放：${this.manifest.id}`));
    if (this.instance) return Promise.resolve(this.instance);
    // 同一宿主的并发加载复用一个 Promise，避免重复创建实例。
    if (this.pending) return this.pending;
    const pending = (async () => {
      const factory = await this.loader();
      this.checkOpen();
      const manifest = checkedManifest(factory.manifest);
      invariant(
        manifest.id === this.manifest.id && manifest.version === this.manifest.version,
        'PLUGIN_CONTRACT',
        `插件加载版本不匹配：${this.manifest.id}`,
      );
      const instance = await factory.create(this.context);
      invariant(instance && typeof instance.dispose === 'function', 'PLUGIN_CONTRACT', '插件缺少释放接口');
      try {
        this.checkOpen();
        this.validate(instance);
      } catch (error) {
        // 创建完成后若关闭或校验失败，由激活流程释放实例；释放失败会阻止后续重试。
        try {
          await instance.dispose();
        } catch (cleanupError) {
          this.cleanupFailure = new AggregateError(
            [error, cleanupError],
            `插件激活及释放失败：${this.manifest.id}`,
          );
          throw this.cleanupFailure;
        }
        throw error;
      }
      this.instance = instance;
      return instance;
    })();
    this.pending = pending;
    const settled = () => {
      if (this.pending === pending) this.pending = undefined;
    };
    void pending.then(settled, settled);
    return pending;
  }

  private checkOpen() {
    invariant(!this.closed, 'PLUGIN_DISPOSED', `插件已释放：${this.manifest.id}`);
  }

  /**
   * 幂等关闭：先拒绝新加载，再等待当前激活完成并清理实例。
   * 加载本身失败不使关闭失败，只有明确记录的清理失败或实例释放失败向上传递。
   */
  dispose(): Promise<void> {
    // 多次关闭共享结果；先阻止新加载，再等待正在进行的激活收束。
    if (this.closing) return this.closing;
    this.closed = true;
    this.closing = (async () => {
      try {
        await this.pending;
      } catch {
        // Activation owns cleanup. Only its recorded cleanup failure makes shutdown fail;
        // a loader may itself reject with AggregateError without having created an instance.
      }
      if (this.cleanupFailure) throw this.cleanupFailure;
      const instance = this.instance;
      this.instance = undefined;
      await instance?.dispose();
    })();
    return this.closing;
  }
}
