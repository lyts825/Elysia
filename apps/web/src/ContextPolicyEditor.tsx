import { useId } from 'react';
import type { ContextPolicy } from '../../../packages/contracts/src/index';
import './context-window.css';

export function validContextPolicy(
  policy: ContextPolicy,
  minimumWindowTokens: number,
  providerLimit: number,
) {
  if (providerLimit < minimumWindowTokens) return false;
  if (policy.mode === 'managed' && policy.windowTokens === undefined) return true;
  return (
    Number.isInteger(policy.windowTokens) &&
    (policy.windowTokens || 0) >= minimumWindowTokens &&
    (policy.windowTokens || 0) <= providerLimit
  );
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
  const valid = validContextPolicy(value, minimumWindowTokens, providerLimit);
  return (
    <div className="context-policy-editor">
      <label htmlFor={id + '-mode'}>上下文窗口分配</label>
      <select
        id={id + '-mode'}
        value={value.mode}
        disabled={disabled}
        onChange={(event) =>
          change(
            event.target.value === 'manual'
              ? { mode: 'manual', windowTokens: value.windowTokens ?? providerLimit }
              : { mode: 'managed' },
          )
        }
      >
        <option value="managed">{child ? '托管 · 由上级模型分配' : '托管 · 使用模型容量'}</option>
        <option value="manual">手动分配</option>
      </select>
      {value.mode === 'manual' && (
        <>
          <label htmlFor={id + '-tokens'}>窗口大小（Token）</label>
          <input
            id={id + '-tokens'}
            type="number"
            min={minimumWindowTokens}
            max={providerLimit}
            step={1}
            value={value.windowTokens ?? ''}
            disabled={disabled}
            onChange={(event) => change({ mode: 'manual', windowTokens: Number(event.target.value) })}
          />
          <p className="field-help">
            {providerLimit >= minimumWindowTokens
              ? `可分配 ${minimumWindowTokens.toLocaleString()}–${providerLimit.toLocaleString()} Token，包含输入与输出预留。`
              : '当前模型容量无法容纳必要指令与输出预留。'}
          </p>
        </>
      )}
      {value.mode === 'managed' && (
        <p className="field-help">
          {child
            ? `${value.windowTokens ? `上级已建议 ${value.windowTokens.toLocaleString()} Token。` : ''}上级模型会按任务需要分配此代理的独立窗口；手动分配后，上级不会覆盖你的设置。`
            : '使用当前模型的上下文容量；子代理由各自上级分配窗口。'}
        </p>
      )}
      {!valid && (
        <p className="inline-warning" role="status">
          {providerLimit < minimumWindowTokens
            ? `所选模型容量不足，至少需要 ${minimumWindowTokens.toLocaleString()} Token 保留必要指令与输出。`
            : `窗口大小须为 ${minimumWindowTokens.toLocaleString()}–${providerLimit.toLocaleString()} 范围内的整数，请调整分配或选择更大的模型。`}
        </p>
      )}
    </div>
  );
}
