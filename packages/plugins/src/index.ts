import { AppError, invariant } from '../../contracts/src/index.js';

export const PLUGIN_API_VERSION = 1;

export interface PluginManifest {
  readonly id: string;
  readonly version: string;
  readonly apiVersion: typeof PLUGIN_API_VERSION;
}

export interface PluginContributions<T> {
  readonly manifest: PluginManifest;
  readonly contributions: Readonly<Record<string, T>>;
}

function checkedManifest(manifest: PluginManifest): Readonly<PluginManifest> {
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

  get(name: string): T | undefined {
    return this.contributions.get(name);
  }

  require(name: string): T {
    const contribution = this.get(name);
    invariant(contribution !== undefined, 'PLUGIN_CONTRIBUTION_MISSING', `插件贡献点不存在：${name}`);
    return contribution;
  }

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

  load(): Promise<Instance> {
    if (this.cleanupFailure) return Promise.reject(this.cleanupFailure);
    if (this.closed)
      return Promise.reject(new AppError('PLUGIN_DISPOSED', `插件已释放：${this.manifest.id}`));
    if (this.instance) return Promise.resolve(this.instance);
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

  dispose(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.closing = (async () => {
      try {
        await this.pending;
      } catch (error) {
        // Activation owns cleanup; retain cleanup failures rather than reporting a clean shutdown.
        if (error instanceof AggregateError) throw error;
      }
      if (this.cleanupFailure) throw this.cleanupFailure;
      const instance = this.instance;
      this.instance = undefined;
      await instance?.dispose();
    })();
    return this.closing;
  }
}
