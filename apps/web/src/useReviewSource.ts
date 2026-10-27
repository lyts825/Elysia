/**
 * 提供 useReviewSource React Hook 使用的状态与处理逻辑。
 * 把复核来源选择与上层续接草稿同步，使用最新引用合并并校验容量及身份；只维护本地选择，不发送运行请求。
 * EN: Reads current delivery provenance for review/handoff. Synchronizes review-source selections with the parent continuation draft through latest-ref merging and size/identity validation, maintaining local choices without submitting a run request.
 */
import { useEffect, useState } from 'react';
import type { DeliveryReview } from '../../../packages/contracts/src/workflow';
import { useSurfaceClient } from './SurfaceClientContext';

/**
 * 按运行、运行版本、交接阶段和显式重试代次重新读取当前交付来源。
 * 每次开始先清空旧 value，enabled=false 时不请求；清理取消旧读取，避免用旧指纹继续确认来源。
 * EN: Reread by run/revision/handoff stage/explicit retry. Clear prior value at read start and skip disabled reads; cleanup cancels old requests so stale fingerprints cannot confirm sources.
 */
export function useReviewSource(
  runId: string,
  enabled: boolean,
  version: number,
  stage: string,
  retry: number,
) {
  const { api } = useSurfaceClient();
  const [value, setValue] = useState<DeliveryReview>();
  const [error, setError] = useState(''),
    [reading, setReading] = useState(false);
  /**
   * 来源运行、版本、阶段或重试变化时重建复核读取，禁用时只清空显示；清理中断请求，旧结果不进入新来源状态。
   * EN: Recreates review reads after source run, version, stage, or retry changes, clearing display while disabled; cleanup aborts requests so obsolete results cannot enter the new source state.
   */
  useEffect(() => {
    const controller = new AbortController();
    setValue(undefined);
    setError('');
    setReading(enabled);
    if (enabled)
      void api<DeliveryReview>(`/runs/${runId}/delivery`, undefined, undefined, controller.signal)
        .then((next) => {
          if (!controller.signal.aborted) setValue(next);
        })
        .catch((issue) => {
          if (!controller.signal.aborted)
            setError(issue instanceof Error ? issue.message : '来源交付读取失败。');
        })
        .finally(() => {
          if (!controller.signal.aborted) setReading(false);
        });
    return () => controller.abort();
  }, [api, runId, enabled, version, stage, retry]);
  return { value, error, reading };
}
