import type { DeliveryChangeSummary } from '../../../packages/contracts/src/workflow';

export function DeliveryChanges({ value }: { value?: DeliveryChangeSummary | null }) {
  if (!value) return null;
  if (value.status === 'unknown')
    return (
      <p className="field-help" role="status">
        {value.reason === 'current_unreadable'
          ? '当前交付暂不可读取，无法比较变更，请重试读取交付。'
          : value.reason === 'baseline_invalid'
            ? '历史比较信息损坏或版本不支持，仍可查看原复核，无法确定具体变更。'
            : '这份旧复核没有完整比较基线，无法确定具体变更；请按当前证据重新核对。'}
      </p>
    );
  if (value.status === 'unchanged') return <p className="field-help">当前交付与此复核记录的内容一致。</p>;
  const fields = value.fields;
  const names = fields
    ? [
        fields.root && '根任务',
        fields.status && '执行状态',
        fields.deliverables && '交付物要求',
        fields.criteria && '验收标准',
        fields.result && '交付结果',
      ].filter(Boolean)
    : [];
  return (
    <section className="workflow-change-summary" aria-label="复核后的交付变化">
      <strong>自这份复核后，交付内容已变化</strong>
      {!!names.length && <p>{names.join('、')}</p>}
      {value.artifacts && (
        <p>
          产物新增 {value.artifacts.added} · 移除 {value.artifacts.removed} · 内容或版本变化{' '}
          {value.artifacts.changed}
        </p>
      )}
      <p className="field-help">变更说明用于定位复核范围，不代表内容已经通过用户验收。</p>
    </section>
  );
}
