/* 展示交付内容的变更摘要。 */
import type { DeliveryChangeSummary } from '../../../packages/contracts/src/workflow';
import './delivery-changes.css';

/** 渲染服务端确认的比较结果，只有 changed 才列变化范围；缺失基线不被转换为零变化。 */
export function DeliveryChanges({ value }: { value?: DeliveryChangeSummary | null }) {
  // 未知比较结果保留原因；只有服务端确认一致时才显示未变化。
  if (!value) return null;
  if (value.status === 'unknown')
    return (
      <section className="delivery-comparison-summary" data-state="unknown" aria-label="复核交付变化比较状态">
        <h4>暂时无法比较交付变化</h4>
        <p className="field-help" role="status">
          {value.reason === 'current_unreadable'
            ? '当前交付暂不可读取，无法比较变更，请重试读取交付。'
            : value.reason === 'baseline_invalid'
              ? '历史比较信息损坏或版本不支持，仍可查看原复核，无法确定具体变更。'
              : '这份旧复核没有完整比较基线，无法确定具体变更；请按当前证据重新核对。'}
        </p>
      </section>
    );
  if (value.status === 'unchanged')
    return (
      <section
        className="delivery-comparison-summary"
        data-state="unchanged"
        aria-label="复核交付变化比较状态"
      >
        <h4>交付内容未变化</h4>
        <p className="field-help">当前交付与此复核记录的内容一致。</p>
      </section>
    );
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
    <section
      className="workflow-change-summary delivery-comparison-summary"
      data-state="changed"
      aria-label="复核后的交付变化"
    >
      <h4>自这份复核后，交付内容已变化</h4>
      {!!names.length && (
        <>
          <p className="delivery-comparison-caption">已标记 {names.length} 类变化范围</p>
          <ul className="delivery-comparison-fields" aria-label="已标记变化的交付字段">
            {names.map((name) => (
              <li key={name as string}>{name}</li>
            ))}
          </ul>
        </>
      )}
      {!fields && <p className="field-help">具体变化字段未提供。</p>}
      {value.artifacts ? (
        <dl className="delivery-comparison-counts" aria-label="产物变更数量">
          <div>
            <dt>新增产物</dt>
            <dd>{value.artifacts.added}</dd>
          </div>
          <div>
            <dt>移除产物</dt>
            <dd>{value.artifacts.removed}</dd>
          </div>
          <div>
            <dt>内容或版本变化</dt>
            <dd>{value.artifacts.changed}</dd>
          </div>
        </dl>
      ) : (
        <p className="field-help">未提供产物变更数量。</p>
      )}
      <p className="field-help">变更说明用于定位复核范围，不代表内容已经通过用户验收。</p>
    </section>
  );
}
