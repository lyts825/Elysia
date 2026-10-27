/**
 * 编辑并校验上下文窗口策略。
 * 区分托管和手动窗口配置，并依据模型上限校验输入；只编辑策略值，保存与运行时压缩由上层负责。
 * EN: Edits and validates context-window policies. Distinguishes managed/manual window policies and validates against model limits; it edits policy values while parents own saving and runtime compaction.
 */
import { useId, useState } from 'react';
import {
  CONTEXT_MAX_WINDOW_TOKENS,
  CONTEXT_TOKEN_UNIT,
  CONTEXT_WINDOW_PRESETS,
  type ContextPolicy,
} from '../../../packages/contracts/src/index';
import { contextWindowSizeLabel } from './ContextLabel';
import './context-window.css';
import './context-policy-editor.css';

/**
 * 托管策略可不指定窗口；手动窗口还需符合最小值、模型上限与整千单位。
 * EN: A managed policy may omit a window. A manual window must also satisfy the minimum, model ceiling, and whole-thousand unit.
 */
export function validContextPolicy(
  policy: ContextPolicy,
  minimumWindowTokens: number,
  providerLimit: number,
) {
  const limit = Math.min(providerLimit, CONTEXT_MAX_WINDOW_TOKENS);
  if (limit < minimumWindowTokens) return false;
  if (policy.mode === 'managed' && policy.windowTokens === undefined) return true;
  return (
    Number.isInteger(policy.windowTokens) &&
    (policy.windowTokens || 0) >= minimumWindowTokens &&
    (policy.windowTokens || 0) <= limit &&
    (policy.mode !== 'manual' || (policy.windowTokens || 0) % CONTEXT_TOKEN_UNIT === 0)
  );
}

/**
 * 优先选择范围内的首个预设，无法使用预设时选择不超过上限的整千值。
 * EN: Choose the first available preset in range; otherwise choose a whole-thousand value that does not exceed the ceiling.
 */
export function defaultManualContextWindowTokens(minimumWindowTokens: number, providerLimit: number) {
  const limit = Math.min(providerLimit, CONTEXT_MAX_WINDOW_TOKENS);
  const preset = CONTEXT_WINDOW_PRESETS.find((tokens) => tokens >= minimumWindowTokens && tokens <= limit);
  const custom = Math.floor(limit / CONTEXT_TOKEN_UNIT) * CONTEXT_TOKEN_UNIT;
  return preset ?? (custom >= minimumWindowTokens ? custom : undefined);
}

/**
 * 受控窗口编辑器，只通过 change 上报草稿，不直接写入运行配置。
 * 手动输入以 K 展示、以 token 保存；自定义选项状态与当前值分开，保留用户选中自定义的意图。
 * EN: This controlled window editor reports a draft through change and never writes run configuration directly. Show manual input in K while storing tokens. Track the custom-option choice separately from its value so the user can keep editing a custom window.
 */
export function ContextPolicyEditor({
  value,
  change,
  minimumWindowTokens,
  providerLimit,
  disabled = false,
  child = false,
}: {
  value: ContextPolicy;
  change: (value: ContextPolicy) => void;
  minimumWindowTokens: number;
  providerLimit: number;
  disabled?: boolean;
  child?: boolean;
}) {
  const id = useId();
  const [customSelected, setCustomSelected] = useState(false);
  const limit = Math.min(providerLimit, CONTEXT_MAX_WINDOW_TOKENS);
  const minimumK = Math.ceil(minimumWindowTokens / CONTEXT_TOKEN_UNIT);
  const maximumK = Math.floor(limit / CONTEXT_TOKEN_UNIT);
  const isPreset = CONTEXT_WINDOW_PRESETS.some((tokens) => tokens === value.windowTokens);
  const custom = customSelected || !isPreset;
  const fractionalWindow =
    value.mode === 'manual' &&
    value.windowTokens !== undefined &&
    value.windowTokens % CONTEXT_TOKEN_UNIT !== 0;
  const valid = validContextPolicy(value, minimumWindowTokens, providerLimit);
  return (
    <div className="context-policy-editor context-allocation-editor">
      <dl className="context-allocation-metrics" aria-label="当前上下文分配范围">
        <div>
          <dt>当前草稿</dt>
          <dd>
            {value.mode === 'managed'
              ? '托管分配'
              : value.windowTokens === undefined
                ? '手动 · 未填写'
                : `手动 · ${value.windowTokens.toLocaleString()} Token`}
          </dd>
        </div>
        <div>
          <dt>任务最低容量</dt>
          <dd>{minimumWindowTokens.toLocaleString()} Token</dd>
        </div>
        <div>
          <dt>模型可用容量</dt>
          <dd>{limit.toLocaleString()} Token</dd>
        </div>
      </dl>
      <p className="context-allocation-state" id={id + '-state'} data-valid={valid}>
        {disabled
          ? '当前不可编辑，显示已有配置。'
          : valid
            ? '当前草稿在可用范围内；应用或保存后生效。'
            : '当前草稿需要调整，具体原因见下方说明。'}
      </p>
      <label htmlFor={id + '-mode'}>分配方式</label>
      <select
        id={id + '-mode'}
        value={value.mode}
        disabled={disabled}
        aria-describedby={id + '-state'}
        onChange={(event) => {
          setCustomSelected(false);
          change(
            event.target.value === 'manual'
              ? {
                  mode: 'manual',
                  windowTokens: defaultManualContextWindowTokens(minimumWindowTokens, providerLimit),
                }
              : { mode: 'managed' },
          );
        }}
      >
        <option value="managed">{child ? '托管 · 由上级模型分配' : '托管 · 使用模型容量'}</option>
        <option value="manual">手动分配</option>
      </select>
      {value.mode === 'manual' && (
        <>
          <fieldset className="context-window-presets" disabled={disabled}>
            <legend>窗口大小</legend>
            <div className="context-preset-options">
              {CONTEXT_WINDOW_PRESETS.map((tokens) => {
                const available = tokens >= minimumWindowTokens && tokens <= limit;
                return (
                  <button
                    key={tokens}
                    type="button"
                    className="context-preset-option"
                    aria-pressed={!custom && value.windowTokens === tokens}
                    disabled={!available}
                    title={
                      available
                        ? `${tokens.toLocaleString()} Token，包含输入与输出预留`
                        : tokens > limit
                          ? '超出当前模型可用容量'
                          : '无法容纳当前任务的必要指令与输出预留'
                    }
                    onClick={() => {
                      setCustomSelected(false);
                      change({ mode: 'manual', windowTokens: tokens });
                    }}
                  >
                    <span>{contextWindowSizeLabel(tokens)}</span>
                    {!available && <small>{tokens > limit ? '超出容量' : '低于最低'}</small>}
                  </button>
                );
              })}
              <button
                type="button"
                className="context-preset-option"
                aria-pressed={custom}
                onClick={() => setCustomSelected(true)}
              >
                自定义
              </button>
            </div>
          </fieldset>
          {custom && (
            <div className="context-custom-window">
              <label htmlFor={id + '-tokens'}>自定义窗口（K）</label>
              <div className="context-window-input">
                <input
                  id={id + '-tokens'}
                  type="number"
                  inputMode="numeric"
                  min={minimumK}
                  max={maximumK}
                  step={1}
                  value={value.windowTokens === undefined ? '' : value.windowTokens / CONTEXT_TOKEN_UNIT}
                  disabled={disabled}
                  aria-invalid={!valid}
                  aria-describedby={id + '-range'}
                  onChange={(event) =>
                    change({
                      mode: 'manual',
                      windowTokens:
                        event.target.value === ''
                          ? undefined
                          : Number(event.target.value) * CONTEXT_TOKEN_UNIT,
                    })
                  }
                />
                <span aria-hidden="true">K</span>
              </div>
            </div>
          )}
          <p className="field-help" id={id + '-range'}>
            {maximumK >= minimumK
              ? `可分配 ${minimumK}–${maximumK}K，含输入与输出预留。1K = 1000 Token · 1M = 1000K。`
              : '当前模型容量无法容纳整数 K 的窗口及必要指令与输出预留。'}
          </p>
          {fractionalWindow && (
            <p className="inline-warning" role="status">
              当前设置为 {value.windowTokens?.toLocaleString()} Token。请选择档位或输入整数 K 后保存。
            </p>
          )}
        </>
      )}
      {value.mode === 'managed' && (
        <div className="context-policy-hint">
          <p className="field-help">
            {child
              ? `${value.windowTokens ? `上级已建议 ${contextWindowSizeLabel(value.windowTokens)}（${value.windowTokens.toLocaleString()} Token）。` : ''}直属上级按任务分配；手动设置后，上级不会覆盖。`
              : '使用模型真实容量；子代理由各自直属上级分配。'}
            最高 1M（1000K）。
          </p>
        </div>
      )}
      {!valid && !fractionalWindow && (
        <p className="inline-warning" role="status">
          {limit < minimumWindowTokens
            ? `当前可用容量不足，至少需要 ${minimumWindowTokens.toLocaleString()} Token 保留必要指令与输出。`
            : value.mode === 'manual'
              ? `请输入 ${minimumK}–${maximumK} 范围内的整数 K，或选择可用档位。`
              : `窗口大小须为 ${minimumWindowTokens.toLocaleString()}–${limit.toLocaleString()} Token，请调整分配或选择更大的模型。`}
        </p>
      )}
    </div>
  );
}
