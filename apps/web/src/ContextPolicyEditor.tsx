import { useId, useState } from 'react';
import {
  CONTEXT_MAX_WINDOW_TOKENS,
  CONTEXT_TOKEN_UNIT,
  CONTEXT_WINDOW_PRESETS,
  type ContextPolicy,
} from '../../../packages/contracts/src/index';
import { contextWindowSizeLabel } from './ContextLabel';
import './context-window.css';

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

export function defaultManualContextWindowTokens(minimumWindowTokens: number, providerLimit: number) {
  const limit = Math.min(providerLimit, CONTEXT_MAX_WINDOW_TOKENS);
  const preset = CONTEXT_WINDOW_PRESETS.find((tokens) => tokens >= minimumWindowTokens && tokens <= limit);
  const custom = Math.floor(limit / CONTEXT_TOKEN_UNIT) * CONTEXT_TOKEN_UNIT;
  return preset ?? (custom >= minimumWindowTokens ? custom : undefined);
}

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
  const fractionalLegacy =
    value.mode === 'manual' &&
    value.windowTokens !== undefined &&
    value.windowTokens % CONTEXT_TOKEN_UNIT !== 0;
  const valid = validContextPolicy(value, minimumWindowTokens, providerLimit);
  return (
    <div className="context-policy-editor">
      <label htmlFor={id + '-mode'}>上下文窗口分配</label>
      <select
        id={id + '-mode'}
        value={value.mode}
        disabled={disabled}
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
                    {contextWindowSizeLabel(tokens)}
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
              ? `可分配 ${minimumK}–${maximumK}K，最高 1M（1000K）。1K = 1000 Token，包含输入与输出预留。`
              : '当前模型容量无法容纳整数 K 的窗口及必要指令与输出预留。'}
          </p>
          {fractionalLegacy && (
            <p className="inline-warning" role="status">
              历史设置为 {value.windowTokens?.toLocaleString()} Token，已保留原值。请选择档位或输入整数 K
              后保存。
            </p>
          )}
        </>
      )}
      {value.mode === 'managed' && (
        <p className="field-help">
          {child
            ? `${value.windowTokens ? `上级已建议 ${contextWindowSizeLabel(value.windowTokens)}（${value.windowTokens.toLocaleString()} Token）。` : ''}直属上级模型按任务需要分配此代理的独立窗口，最高为 1M 与模型真实上限中的较小值；手动设置后，上级不会覆盖。`
            : `使用模型真实容量，最高 1M（1000K）。当前可用 ${contextWindowSizeLabel(limit)}；子代理由各自直属上级分配窗口。`}
        </p>
      )}
      {!valid && !fractionalLegacy && (
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
