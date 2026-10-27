/* 配置并校验同行评审。 */
import { useId } from 'react';
import type { PeerReviewPolicy } from '../../../packages/contracts/src/peer-review';
import type { SelectableProvider } from './ModelPicker';
import './peer-review.css';

const modelIdentity = (model: string) => model.trim().toLowerCase();

/** 评审模型须互不重复且不同于执行模型，并使用当前版本已验证的连接。 */
export function peerReviewSetupIssue(
  value: PeerReviewPolicy | undefined,
  providers: SelectableProvider[],
  executionModel: string,
) {
  if (!value) return '';
  if (value.reviewerProviderIds.length < 1 || value.reviewerProviderIds.length > 3)
    return '请选择 1 至 3 个评审模型。';
  const models = new Set<string>();
  for (const providerId of value.reviewerProviderIds) {
    const provider = providers.find((item) => item.id === providerId);
    if (
      !provider ||
      provider.archived ||
      !provider.keyConfigured ||
      provider.checkedRevision !== provider.revision
    )
      return '所选评审连接已失效或尚未验证，请重新选择。';
    const model = modelIdentity(provider.model);
    if (!model || model === modelIdentity(executionModel)) return '评审模型必须与当前执行模型不同。';
    if (models.has(model)) return '每个评审模型只能选择一次；更换连接或账号不算不同模型。';
    models.add(model);
  }
  if (!Number.isInteger(value.minScore) || value.minScore < 0 || value.minScore > 100)
    return '通过分数须为 0 至 100 的整数。';
  if (!Number.isInteger(value.maxRounds) || value.maxRounds < 1 || value.maxRounds > 3)
    return '评审轮次上限须为 1 至 3 的整数。';
  return '';
}

export function PeerReviewSetup({
  value,
  providers,
  executionModel,
  disabled,
  change,
}: {
  value?: PeerReviewPolicy;
  providers: SelectableProvider[];
  executionModel: string;
  disabled: boolean;
  change: (value: PeerReviewPolicy | undefined) => void;
}) {
  const id = useId();
  const issue = peerReviewSetupIssue(value, providers, executionModel);
  const selected = new Set(value?.reviewerProviderIds ?? []);
  const selectedModels = new Set(
    providers
      .filter((provider) => selected.has(provider.id))
      .map((provider) => modelIdentity(provider.model)),
  );
  const available = providers.filter(
    (provider) =>
      !provider.archived && provider.keyConfigured && provider.checkedRevision === provider.revision,
  );
  const unavailable = (value?.reviewerProviderIds ?? []).filter(
    (providerId) => !available.some((provider) => provider.id === providerId),
  );
  const remove = (providerId: string) =>
    value &&
    change({
      ...value,
      reviewerProviderIds: value.reviewerProviderIds.filter((item) => item !== providerId),
    });
  return (
    <section className="peer-review-setup" aria-label="模型评审模式">
      <label className="check-label">
        <input
          type="checkbox"
          role="switch"
          checked={!!value}
          disabled={disabled}
          aria-describedby={id + '-help'}
          onChange={(event) =>
            change(event.target.checked ? { reviewerProviderIds: [], minScore: 80, maxRounds: 3 } : undefined)
          }
        />
        评审模式
      </label>
      <p className="field-help" id={id + '-help'}>
        所选的其余模型独立审计总代理的最终输出，按每项验收标准打分。每位评审的每项评分均达标且结论通过后，才能确认目标完成。
      </p>
      {value && (
        <>
          <fieldset className="peer-review-models" disabled={disabled} aria-describedby={id + '-models-help'}>
            <legend>评审模型 · 已选 {selected.size} / 3</legend>
            <p className="field-help" id={id + '-models-help'}>
              使用连接当前配置的型号，创建任务后固定。不同连接、账号或思考强度不算不同模型。
            </p>
            {available.map((provider) => {
              const model = modelIdentity(provider.model);
              const chosen = selected.has(provider.id);
              const reason =
                model === modelIdentity(executionModel)
                  ? '与当前执行模型相同'
                  : !chosen && selectedModels.has(model)
                    ? '已选择相同型号'
                    : !chosen && selected.size >= 3
                      ? '已达到 3 个模型上限'
                      : '';
              return (
                <label className="check-label peer-review-model" key={provider.id}>
                  <input
                    type="checkbox"
                    checked={chosen}
                    disabled={disabled || (!chosen && !!reason)}
                    onChange={(event) =>
                      event.target.checked
                        ? change({
                            ...value,
                            reviewerProviderIds: [...value.reviewerProviderIds, provider.id],
                          })
                        : remove(provider.id)
                    }
                  />
                  <span>
                    <strong>{provider.label}</strong>
                    <span>{provider.model}</span>
                    {reason && <small>{reason}</small>}
                  </span>
                </label>
              );
            })}
            {!available.length && <p className="field-help">暂无已验证连接，请先在模型设置中配置并验证。</p>}
            {unavailable.map((providerId) => (
              <label className="check-label peer-review-model" key={providerId}>
                <input type="checkbox" checked disabled={disabled} onChange={() => remove(providerId)} />
                <span>
                  连接不可用：{providers.find((provider) => provider.id === providerId)?.label ?? providerId}
                  ，取消勾选可移除。
                </span>
              </label>
            ))}
          </fieldset>
          <div className="form-columns peer-review-settings">
            <label>
              每项通过分数
              <input
                type="number"
                min={0}
                max={100}
                step={1}
                required
                value={value.minScore < 0 ? '' : value.minScore}
                disabled={disabled}
                onChange={(event) =>
                  change({ ...value, minScore: event.target.value === '' ? -1 : Number(event.target.value) })
                }
              />
            </label>
            <label>
              评审轮次上限
              <input
                type="number"
                min={1}
                max={3}
                step={1}
                required
                value={value.maxRounds < 0 ? '' : value.maxRounds}
                disabled={disabled}
                onChange={(event) =>
                  change({ ...value, maxRounds: event.target.value === '' ? -1 : Number(event.target.value) })
                }
              />
            </label>
          </div>
          <p className="field-help">
            未通过时反馈给执行模型修订，并重新评审。达到轮次上限仍未通过时暂停；评审调用与修订共同消耗本任务累计预算。
          </p>
          {issue && (
            <p className="field-error" role="alert">
              {issue}
            </p>
          )}
        </>
      )}
    </section>
  );
}
