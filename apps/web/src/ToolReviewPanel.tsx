/**
 * 展示和处理工具操作评审。
 *
 * EN: Displays tool-operation review decisions.
 *
 * 本模块展示运行创建时冻结的审核策略和当前已载入事件中的最近有效审核决定；仅解释已有证据，不主动补读全部历史，审核允许也不代表工具执行成功。
 * EN: Displays frozen run review policy and recent valid review decisions in loaded events. It interprets existing evidence without fetching complete history, and an allowed review does not imply successful execution.
 */
import './peer-review.css';
import type { Run } from '../../../packages/contracts/src/index';
import { ToolReviewDecision } from '../../../packages/contracts/src/execution-policy';

/**
 * 展示创建运行时冻结的审核/命令策略，以及当前已载入事件中的最近十条有效审核决定。
 * 不主动补读全部审核历史，也不把“允许调用”当作“调用已经成功”，操作结果另由账本显示。
 *
 * EN: Shows creation-frozen review/backend policies and the last ten valid loaded decisions. Does not fetch all history or equate allowed execution with successful completion; outcomes come from the ledger.
 */
export function ToolReviewPanel({
  run,
  events,
}: {
  run: Run;
  events: { type: string; seq: number; payload: unknown }[];
}) {
  const policy = run.contract.toolReview,
    backend = run.contract.commandBackend;
  if ((!policy || policy.mode === 'off') && backend?.kind !== 'docker') return null;
  const receipts = events
    /**
     * 只展示可解析的审核回执和最近十条，避免将无效事件当作审核结论。
     *
     * EN: Displays only parseable receipts and the latest ten, never treating malformed events as review decisions.
     */
    .filter((e) => e.type === 'tool.reviewed')
    .flatMap((e) => {
      const parsed = ToolReviewDecision.safeParse(
        e.payload && typeof e.payload === 'object'
          ? { decision: (e.payload as any).decision, reason: (e.payload as any).reason }
          : null,
      );
      return parsed.success
        ? [{ ...parsed.data, seq: e.seq, name: String((e.payload as any).name ?? '工具') }]
        : [];
    })
    .slice(-10);
  return (
    <section className="peer-review-setup tool-review-panel" aria-label="执行策略与工具审核">
      <h3>执行策略</h3>
      <p>
        工具审核：
        {policy?.mode === 'model' ? '规则与模型' : policy?.mode === 'rules' ? '规则' : '关闭额外审核'}
        {run.toolReviewBinding ? ` · ${run.toolReviewBinding.label} / ${run.toolReviewBinding.model}` : ''}
        ；命令环境：{backend?.kind === 'docker' ? `Docker · ${backend.image}` : '本机进程'}
      </p>
      <p className="field-help">
        以下为最近载入的审核记录。通过审核后仍需执行权限检查，审核通过不代表操作已经完成。
      </p>
      {receipts.length ? (
        <ul>
          {receipts.map((r) => (
            <li key={r.seq}>
              <strong>
                {r.name} · {r.decision === 'allow' ? '审核通过' : '审核拒绝'}
              </strong>
              ：{r.reason}
            </li>
          ))}
        </ul>
      ) : (
        <p className="field-help">当前载入范围内没有审核记录。</p>
      )}
    </section>
  );
}
