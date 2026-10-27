/* 提供 useReviewSource React Hook 使用的状态与处理逻辑。 */
import { useEffect, useState } from 'react';
import type { DeliveryReview } from '../../../packages/contracts/src/workflow';
import { useSurfaceClient } from './SurfaceClientContext';

/**
 * 按运行、运行版本、交接阶段和显式重试代次重新读取当前交付来源。
 * 每次开始先清空旧 value，enabled=false 时不请求；清理取消旧读取，避免用旧指纹继续确认来源。
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
