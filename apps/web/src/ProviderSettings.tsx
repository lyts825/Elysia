import { useEffect, useRef, useState } from 'react';
import type { ProviderConfig } from '../../../packages/contracts/src/index';
import { api, mutation } from './api';
import { CodexSettings } from './CodexSettings';
import { SubscriptionSettings } from './SubscriptionSettings';
import { Modal } from './Modal';
import { Icon } from './Icon';
import { MotionContent } from './Motion';
import './providers.css';
import { officialDeepSeek, supportsText, type CatalogModel } from './ModelCatalog';

type Provider = ProviderConfig & { keyConfigured: boolean };
const presets = [
  ['codex', 'ChatGPT 订阅', '复用 Codex 登录'],
  ['openai', 'OpenAI API', 'Responses API'],
  ['deepseek', 'DeepSeek', 'Chat Completions'],
  ['custom', '自定义服务', '兼容 API 端点'],
];
function preset(name: string): Provider {
  return {
    id: crypto.randomUUID(),
    label: presets.find((p) => p[0] === name)?.[1] || '新配置',
    kind: name === 'deepseek' ? 'deepseek' : 'openai',
    authMode: name === 'codex' ? 'codex' : 'apiKey',
    model: name === 'deepseek' ? 'deepseek-flash' : '',
    reasoningEffort: name === 'deepseek' ? 'high' : null,
    baseUrl: name === 'deepseek' ? 'https://api.deepseek.com' : 'https://api.openai.com/v1',
    apiKeyEnv: name === 'deepseek' ? 'DEEPSEEK_API_KEY' : 'OPENAI_API_KEY',
    account: name === 'deepseek' ? 'deepseek-default' : 'openai-default',
    contextLimit: name === 'deepseek' ? 1048576 : name === 'codex' ? 128000 : 32000,
    outputLimit: name === 'deepseek' ? 8192 : 4096,
    concurrency: 2,
    rpm: 60,
    tpm: 200000,
    cache: {
      mode: name === 'deepseek' ? 'automatic' : 'unknown',
      minTokens: null,
      ttl: null,
      parameters: {},
    },
    prices: null,
    revision: 0,
    checkedRevision: null,
    keyConfigured: false,
  };
}
const editable = (p?: Provider) =>
  p &&
  JSON.stringify(
    Object.fromEntries(
      Object.entries(p).filter(
        ([k]) => !['revision', 'checkedRevision', 'checkedAt', 'keyConfigured'].includes(k),
      ),
    ),
    (_key, value) =>
      value && typeof value === 'object' && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
        : value,
  );
export function ProviderSettings({
  providers,
  close,
  updated,
}: {
  providers: Provider[];
  close: () => void;
  updated: () => Promise<unknown>;
}) {
  const [config, setConfig] = useState<Provider | undefined>(
    providers.find((p) => p.authMode === 'codex') || providers[0],
  );
  const [adding, setAdding] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const [apiKey, setApiKey] = useState(''),
    [keyMode, setKeyMode] = useState(config?.credentialId ? 'stored' : 'env');
  const [catalog, setCatalog] = useState<CatalogModel[]>([]),
    [subscriptionReady, setSubscriptionReady] = useState(false),
    [deleting, setDeleting] = useState(false),
    [advanced, setAdvanced] = useState('');
  const [pendingChoice, setPendingChoice] = useState<Provider>();
  const [confirmClose, setConfirmClose] = useState(false);
  const actionPending = useRef(false);
  useEffect(() => {
    if (!config && providers.length) {
      const initial = providers.find((p) => p.authMode === 'codex') || providers[0];
      setConfig(initial);
      setKeyMode(initial.credentialId ? 'stored' : 'env');
    }
  }, [providers, config]);
  const saved = providers.find((p) => p.id === config?.id),
    dirty = !!config && (editable(config) !== editable(saved) || !!apiKey);
  useEffect(() => {
    if (!dirty) setConfirmClose(false);
  }, [dirty]);
  const subscription = !!config && ['codex', 'chatgpt'].includes(config.authMode || '');
  const deepSeek = !!config && !subscription && officialDeepSeek(config);
  const selectedModel = catalog.find((model) => model.id === config?.model);
  const deepSeekEfforts = selectedModel?.efforts?.filter((effort) =>
    ['low', 'high', 'max'].includes(effort),
  ) || ['low', 'high', 'max'];
  const unsupportedApiModel =
    !subscription && !!catalog.find((model) => model.id === config?.model && !supportsText(model));
  const change = (patch: Partial<ProviderConfig>) => setConfig((p) => p && { ...p, ...patch });
  const choose = (next: Provider, force = false, completedAction = false) => {
    if (actionPending.current && !completedAction) return;
    if (dirty && !force) {
      setPendingChoice(next);
      return;
    }
    setConfig(next);
    setKeyMode(
      next.credentialId || (officialDeepSeek(next) && !providers.some((p) => p.id === next.id))
        ? 'stored'
        : 'env',
    );
    setApiKey('');
    setCatalog([]);
    setSubscriptionReady(false);
    setError('');
    setNotice('');
    setAdding(false);
    setDeleting(false);
    setPendingChoice(undefined);
    setAdvanced('');
  };
  const perform = async (fn: () => Promise<void>) => {
    if (actionPending.current) return;
    actionPending.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      actionPending.current = false;
      setBusy(false);
    }
  };
  const save = () =>
    perform(async () => {
      if (!config) return;
      if (unsupportedApiModel) throw new Error('所选型号不支持文字对话，请选择文字型号后再保存。');
      if (subscription && !subscriptionReady) throw new Error('请选择当前目录中支持文字对话的型号后再保存。');
      if (!subscription && keyMode === 'stored' && !config.credentialId && !apiKey.trim())
        throw new Error('请输入 API Key，或改用环境变量');
      const value = await mutation<Provider>(
        '/providers/' + config.id,
        { ...config, ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}), expectedRevision: config.revision },
        'PUT',
      );
      setConfig({
        ...value,
        keyConfigured: subscription || keyMode === 'stored' ? true : !!saved?.keyConfigured,
      });
      setApiKey('');
      await updated();
      setNotice('配置已保存，下一步验证实际调用。');
    });
  const verify = () =>
    perform(async () => {
      if (!config) return;
      if (unsupportedApiModel) throw new Error('所选型号不支持文字对话，请选择文字型号后再验证。');
      if (subscription && !subscriptionReady) throw new Error('请选择当前目录中支持文字对话的型号后再验证。');
      const result = await mutation('/providers/' + config.id + '/check', {
        expectedRevision: config.revision,
      });
      setConfig({ ...result.provider, keyConfigured: true });
      await updated();
      setNotice(
        `实际调用成功：${result.response || '已收到完整响应'}${result.usage?.inputTotal != null ? ` · 输入 ${result.usage.inputTotal} / 输出 ${result.usage.outputTotal ?? '未知'} Token` : ''}`,
      );
    });
  return (
    <Modal
      title="模型与连接"
      subtitle="为你的代理配置模型与账号"
      className="provider-center"
      busy={busy}
      close={() => {
        if (dirty) setConfirmClose(true);
        else close();
      }}
    >
      {confirmClose && (
        <div className="dialog-notice" role="alert">
          <span>配置尚未保存，继续编辑或舍弃更改后关闭。</span>
          <button className="secondary" onClick={() => setConfirmClose(false)}>
            继续编辑
          </button>
          <button className="text-button" onClick={close}>
            舍弃并关闭
          </button>
        </div>
      )}
      <div className="provider-workspace">
        <nav className="provider-list" aria-label="提供商配置">
          <div className="section-heading">
            <strong>提供商</strong>
            <button className="text-button" disabled={busy} onClick={() => setAdding(!adding)}>
              ＋ 新增
            </button>
          </div>
          {providers.map((p) => (
            <button
              className={'provider-card ' + (config?.id === p.id ? 'selected' : '')}
              aria-pressed={config?.id === p.id}
              key={p.id}
              disabled={busy}
              onClick={() => choose(p)}
            >
              <span className="provider-card-title">
                <span className="provider-symbol">
                  <Icon
                    name={p.authMode === 'codex' || p.authMode === 'chatgpt' ? 'spark' : 'globe'}
                    size={16}
                  />
                </span>
                {p.label}
              </span>
              <span>{p.model}</span>
              <small>
                {p.authMode === 'codex'
                  ? 'ChatGPT · Codex'
                  : p.authMode === 'chatgpt'
                    ? 'ChatGPT · 直接授权'
                    : p.kind === 'openai'
                      ? 'Responses API'
                      : 'Chat Completions'}
              </small>
              <span
                className={
                  'provider-state ' + (p.checkedRevision === p.revision && p.keyConfigured ? 'ready' : '')
                }
              >
                {!p.keyConfigured ? '待连接' : p.checkedRevision === p.revision ? '已验证' : '待验证'}
              </span>
            </button>
          ))}
          {!providers.length && <p className="field-help">从预设添加第一个连接。</p>}
          {!providers.some((p) => p.authMode === 'codex') && (
            <button className="secondary" disabled={busy} onClick={() => choose(preset('codex'))}>
              连接 ChatGPT 订阅
            </button>
          )}
          {config && !saved && (
            <div className="provider-card selected">
              <strong>{config.label}</strong>
              <small>新配置 · 尚未保存</small>
            </div>
          )}
        </nav>
        <MotionContent className="provider-editor" motionKey={adding ? 'presets' : config?.id || 'empty'}>
          {pendingChoice && (
            <div className="draft-prompt">
              <p>当前配置有未保存的更改。</p>
              <button className="secondary" onClick={() => setPendingChoice(undefined)}>
                继续编辑
              </button>
              <button className="secondary" onClick={() => choose(pendingChoice, true)}>
                舍弃更改并切换
              </button>
            </div>
          )}
          {(adding || !config) && (
            <section className="preset-picker">
              <h3>从预设开始</h3>
              <div>
                {presets.map(([id, label, detail]) => (
                  <button className="preset-card" key={id} disabled={busy} onClick={() => choose(preset(id))}>
                    <strong>{label}</strong>
                    <small>{detail}</small>
                  </button>
                ))}
              </div>
            </section>
          )}
          {config && (
            <fieldset className="provider-fields" disabled={busy}>
              <div className="section-heading">
                <div>
                  <h3>{config.label || '新配置'}</h3>
                  <p className="field-help">
                    {!saved
                      ? '新建配置'
                      : dirty
                        ? '有未保存的更改'
                        : saved.checkedRevision === saved.revision
                          ? '当前配置已通过实际调用验证'
                          : '保存配置后验证连接'}
                  </p>
                </div>
                <div className="provider-tools">
                  <button
                    className="secondary"
                    disabled={busy}
                    onClick={() =>
                      choose(
                        {
                          ...config,
                          id: crypto.randomUUID(),
                          label: config.label + ' 副本',
                          revision: 0,
                          checkedRevision: null,
                          checkedAt: undefined,
                        },
                        true,
                      )
                    }
                  >
                    复制
                  </button>
                  {saved && (
                    <button className="text-button" disabled={busy} onClick={() => setDeleting(!deleting)}>
                      删除
                    </button>
                  )}
                </div>
              </div>
              {deleting && (
                <div className="draft-prompt">
                  <p>删除“{config.label}”配置？已有任务保留其模型和密钥引用。</p>
                  <button className="secondary" onClick={() => setDeleting(false)}>
                    保留
                  </button>
                  <button
                    className="secondary danger"
                    disabled={busy}
                    onClick={() =>
                      void perform(async () => {
                        await mutation(
                          '/providers/' + config.id,
                          { expectedRevision: config.revision },
                          'DELETE',
                        );
                        await updated();
                        choose(providers.find((p) => p.id !== config.id) || preset('codex'), true, true);
                      })
                    }
                  >
                    删除配置
                  </button>
                </div>
              )}
              <div className="form-columns">
                <label>
                  显示名称
                  <input value={config.label} onChange={(e) => change({ label: e.target.value })} />
                </label>
                <label>
                  连接方式
                  <select
                    value={config.authMode || 'apiKey'}
                    onChange={(e) => {
                      const mode = e.target.value as ProviderConfig['authMode'];
                      setCatalog([]);
                      setSubscriptionReady(false);
                      setApiKey('');
                      change({
                        authMode: mode,
                        model: '',
                        subscriptionAccountId: null,
                        reasoningEffort: null,
                        credentialId: null,
                        ...(mode !== 'apiKey'
                          ? {
                              kind: 'openai',
                              baseUrl: 'https://api.openai.com/v1',
                              prices: null,
                              contextLimit: 128000,
                            }
                          : {}),
                      });
                      setKeyMode('env');
                    }}
                  >
                    <option value="codex">ChatGPT 订阅（推荐）</option>
                    <option value="apiKey">API Key</option>
                    <option value="chatgpt">ChatGPT 直接授权（兼容旧配置）</option>
                  </select>
                </label>
              </div>
              {config.authMode === 'codex' && (
                <CodexSettings
                  key={config.id + '-codex'}
                  config={config}
                  change={change}
                  ready={setSubscriptionReady}
                />
              )}
              {config.authMode === 'chatgpt' && (
                <>
                  <p className="inline-warning">
                    旧版直接授权依赖 OpenAI SIWC 服务。若登录接口返回 403，可将连接方式改为“ChatGPT 订阅”。
                  </p>
                  <SubscriptionSettings
                    key={config.id}
                    accountId={config.subscriptionAccountId}
                    model={config.model}
                    change={change}
                    ready={setSubscriptionReady}
                  />
                </>
              )}
              {!subscription && (
                <section className="connection-panel">
                  {deepSeek && (
                    <div className="deepseek-guide">
                      <div>
                        <span className="provider-badge">DeepSeek API</span>
                        <h4>选择型号，保存并验证连接</h4>
                        <p>使用 DeepSeek 平台的 API Key，可选快速或更强的模型。</p>
                      </div>
                      <div className="deepseek-model-presets">
                        {[
                          ['deepseek-flash', 'Flash', '日常对话与快速任务'],
                          ['deepseek-v4-pro', 'Pro', '复杂推理与项目任务'],
                        ].map(([id, name, hint]) => (
                          <button
                            type="button"
                            key={id}
                            aria-pressed={config.model === id}
                            onClick={() => {
                              setCatalog([]);
                              change({ model: id, reasoningEffort: 'high' });
                            }}
                          >
                            <strong>{name}</strong>
                            <small>{hint}</small>
                            <code>{id}</code>
                          </button>
                        ))}
                      </div>
                      {['deepseek-chat', 'deepseek-reasoner', 'deepseek-v4-flash'].includes(config.model) && (
                        <p className="inline-warning" role="alert">
                          当前配置使用旧型号「{config.model}
                          」。请明确选择新型号，再保存和验证；已有任务保留原绑定。
                        </p>
                      )}
                    </div>
                  )}
                  <div className="form-columns">
                    <label>
                      API 协议
                      <select
                        value={config.kind}
                        onChange={(e) => {
                          setCatalog([]);
                          change({ kind: e.target.value as ProviderConfig['kind'], reasoningEffort: null });
                        }}
                      >
                        <option value="openai">OpenAI Responses</option>
                        <option value="deepseek">Chat Completions（DeepSeek 兼容）</option>
                      </select>
                    </label>
                    <label>
                      Base URL
                      <input
                        value={config.baseUrl}
                        onChange={(e) => {
                          setCatalog([]);
                          change({ baseUrl: e.target.value.trim() });
                        }}
                        placeholder="https://api.example.com/v1"
                      />
                    </label>
                  </div>
                  <label>
                    凭据来源
                    <select
                      value={keyMode}
                      onChange={(e) => {
                        setKeyMode(e.target.value);
                        setApiKey('');
                        if (e.target.value === 'env') change({ credentialId: null });
                      }}
                    >
                      <option value="stored">在本机加密保存 API Key</option>
                      <option value="env">读取环境变量</option>
                    </select>
                  </label>
                  {keyMode === 'stored' ? (
                    <label>
                      API Key
                      <input
                        type="password"
                        autoComplete="new-password"
                        value={apiKey}
                        onChange={(e) => setApiKey(e.target.value)}
                        placeholder={
                          config.credentialId ? '已保存；填写新值替换' : '输入服务商提供的 API Key'
                        }
                      />
                      <span className="field-help">
                        系统加密保存，页面只保留凭据引用。更换密钥后需重新验证。
                      </span>
                    </label>
                  ) : (
                    <label>
                      环境变量名称
                      <input
                        value={config.apiKeyEnv}
                        onChange={(e) => change({ apiKeyEnv: e.target.value.trim() })}
                      />
                    </label>
                  )}
                  <div className="model-selection">
                    <label>
                      模型 ID
                      <input
                        list={'models-' + config.id}
                        value={config.model}
                        onChange={(e) => change({ model: e.target.value.trim() })}
                        placeholder="填写模型 ID 或从目录选择"
                      />
                      <datalist id={'models-' + config.id}>
                        {catalog.map((m) => (
                          <option key={m.id} value={m.id} disabled={!supportsText(m)}>
                            {m.name || m.id}
                            {!supportsText(m) ? '（不支持文字对话）' : ''}
                          </option>
                        ))}
                      </datalist>
                    </label>
                    <button
                      className="secondary"
                      disabled={busy || !saved || dirty}
                      onClick={() =>
                        void perform(async () => {
                          const values = await api<CatalogModel[]>('/providers/' + config.id + '/models');
                          setCatalog(values);
                          setNotice(
                            `已读取 ${values.length} 个模型，其中 ${values.filter(supportsText).length} 个支持文字对话，可在模型输入框中选择。`,
                          );
                        })
                      }
                    >
                      读取模型目录
                    </button>
                  </div>
                  {deepSeek && (
                    <div className="form-columns deepseek-thinking">
                      <label>
                        思考模式
                        <select
                          value={config.reasoningEffort === 'none' ? 'disabled' : 'enabled'}
                          onChange={(e) =>
                            change({
                              reasoningEffort:
                                e.target.value === 'disabled'
                                  ? 'none'
                                  : (selectedModel?.defaultEffort as ProviderConfig['reasoningEffort']) ||
                                    'high',
                            })
                          }
                        >
                          <option value="enabled">开启思考</option>
                          <option value="disabled">关闭思考 · 更快回复</option>
                        </select>
                      </label>
                      {config.reasoningEffort !== 'none' && (
                        <label>
                          推理强度
                          <select
                            value={config.reasoningEffort || 'high'}
                            onChange={(e) =>
                              change({ reasoningEffort: e.target.value as ProviderConfig['reasoningEffort'] })
                            }
                          >
                            {config.reasoningEffort && !deepSeekEfforts.includes(config.reasoningEffort) && (
                              <option value={config.reasoningEffort}>
                                {config.reasoningEffort}（兼容旧设置）
                              </option>
                            )}
                            {deepSeekEfforts.map((effort) => (
                              <option key={effort} value={effort}>
                                {effort === 'low'
                                  ? '低 · 优先速度'
                                  : effort === 'high'
                                    ? '高 · 平衡速度与质量'
                                    : '最高 · 适合复杂任务'}
                              </option>
                            ))}
                          </select>
                        </label>
                      )}
                      <p className="field-help">连接验证使用短文本检查。正式任务使用这里选择的思考模式。</p>
                    </div>
                  )}
                  {selectedModel && (
                    <p className="model-capacity">
                      {selectedModel.contextWindow
                        ? `模型上下文 ${(selectedModel.contextWindow / 1024).toLocaleString()}K`
                        : ''}
                      {selectedModel.maxOutputTokens
                        ? ` · 单次输出能力 ${(selectedModel.maxOutputTokens / 1024).toLocaleString()}K`
                        : ''}
                      {selectedModel.contextWindow || selectedModel.maxOutputTokens
                        ? ' · 实际请求仍受下方预算限制'
                        : ''}
                    </p>
                  )}
                  <p className="field-help">
                    先填写模型 ID 并保存连接，再读取服务商目录。目录接口不可用时可继续手动填写。
                  </p>
                  {unsupportedApiModel && (
                    <p className="inline-warning" role="alert">
                      所选型号不支持文字对话，请选择文字型号。
                    </p>
                  )}
                </section>
              )}
              <details className="provider-advanced">
                <summary>预算、速率与高级配置</summary>
                <div className="form-columns">
                  <label>
                    上下文预算
                    <input
                      type="number"
                      min={4096}
                      value={config.contextLimit}
                      onChange={(e) => change({ contextLimit: Number(e.target.value) })}
                    />
                  </label>
                  <label>
                    {subscription ? '输出预算预估' : '输出上限'}
                    <input
                      type="number"
                      min={256}
                      value={config.outputLimit}
                      onChange={(e) => change({ outputLimit: Number(e.target.value) })}
                    />
                  </label>
                  <label>
                    账号并发
                    <input
                      type="number"
                      min={1}
                      max={2}
                      value={config.concurrency}
                      onChange={(e) => change({ concurrency: Number(e.target.value) })}
                    />
                  </label>
                </div>
                <div className="form-columns">
                  <label>
                    每分钟请求数
                    <input
                      type="number"
                      min={1}
                      value={config.rpm}
                      onChange={(e) => change({ rpm: Number(e.target.value) })}
                    />
                  </label>
                  <label>
                    每分钟 Token
                    <input
                      type="number"
                      min={1}
                      value={config.tpm}
                      onChange={(e) => change({ tpm: Number(e.target.value) })}
                    />
                  </label>
                  {!subscription && (
                    <label>
                      账号额度分组
                      <input value={config.account} onChange={(e) => change({ account: e.target.value })} />
                    </label>
                  )}
                </div>
                {subscription && (
                  <p className="field-help">
                    订阅输出预算用于请求前预留，完成后按实际 Token
                    结算。模型步骤完成后显示文本，工具和文件预览仍由 Elysia 更新。
                  </p>
                )}
                <button
                  className="text-button"
                  onClick={() =>
                    setAdvanced(JSON.stringify({ cache: config.cache, prices: config.prices }, null, 2))
                  }
                >
                  编辑缓存和价格 JSON
                </button>
                {advanced && (
                  <>
                    <textarea
                      className="code-input"
                      rows={10}
                      value={advanced}
                      onChange={(e) => setAdvanced(e.target.value)}
                    />
                    <button
                      className="secondary"
                      onClick={() => {
                        try {
                          const value = JSON.parse(advanced);
                          change({ cache: value.cache, prices: subscription ? null : value.prices });
                          setError('');
                        } catch {
                          setError('高级配置不是有效 JSON');
                        }
                      }}
                    >
                      应用到表单
                    </button>
                  </>
                )}
              </details>
              <p className="field-help">
                新任务选择已验证的配置。保存、复制和删除不会改变已启动任务的模型绑定。连接检查会发起一次短请求。
              </p>
              {error && (
                <p className="inline-warning" role="alert">
                  {error}
                </p>
              )}
              {notice && (
                <p className="connection-notice" role="status">
                  {notice}
                </p>
              )}
              <footer className="provider-footer">
                <span>{busy ? '正在处理…' : dirty ? '未保存' : '已保存'}</span>
                <button
                  className="secondary"
                  disabled={
                    busy ||
                    !config.label.trim() ||
                    !config.model.trim() ||
                    (subscription && !config.subscriptionAccountId) ||
                    (subscription && !subscriptionReady) ||
                    unsupportedApiModel
                  }
                  onClick={() => void save()}
                >
                  保存配置
                </button>
                <button
                  className="primary"
                  disabled={
                    busy ||
                    dirty ||
                    !saved ||
                    !saved.keyConfigured ||
                    (subscription && !subscriptionReady) ||
                    unsupportedApiModel
                  }
                  onClick={() => void verify()}
                >
                  验证实际调用
                </button>
              </footer>
            </fieldset>
          )}
        </MotionContent>
      </div>
    </Modal>
  );
}
