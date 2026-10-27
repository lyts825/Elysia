/* 提供 useFilePage React Hook 使用的状态与处理逻辑。 */
import { useEffect, useRef, useState } from 'react';
import { ApiError } from './api';
import { useSurfaceClient } from './SurfaceClientContext';
import type { PreviewFile } from '../../../packages/contracts/src/preview';
import { forgetReadingCheckpoint, readingCheckpoint, saveReadingCheckpoint } from './ReadingCheckpoint';

export type FilePreviewContent = Pick<
  PreviewFile,
  'path' | 'text' | 'kind' | 'mediaType' | 'page' | 'encoding' | 'encodingSource' | 'resourceUrl'
> & {
  resourceBase?: string | null;
  directory?: boolean;
  entries?: { path: string; name: string; directory: boolean; size?: number }[];
  truncated?: boolean;
};

const start = (scope: string) => ({
  scope,
  offset: 0,
  version: undefined as string | undefined,
  history: [] as number[],
  revision: 0,
});

/**
 * 按文件端点、编码和手动刷新代次形成读取范围，页偏移与服务端版本决定一次正文请求。
 * 同范围翻页期间可保留上次内容，跨文件/编码则立即废弃旧游标；FILE_CHANGED 回到首页，
 * 不将不同版本字节拼接。返回的导航函数会检查加载互斥、偏移范围及最多 128 次历史。
 */
export function useFilePage(endpoint: string, encoding: string, refresh: number, checkpointKey?: string) {
  const client = useSurfaceClient(),
    { api } = client;
  const scope = JSON.stringify([endpoint, encoding, refresh]);
  const savedKey = JSON.stringify(['file-page', checkpointKey, endpoint, encoding]);
  const restore = () => ({
    ...start(scope),
    ...(checkpointKey ? readingCheckpoint<ReturnType<typeof start>>(client, savedKey) : {}),
    scope,
  });
  const [position, setPosition] = useState(restore);
  const current = position.scope === scope ? position : restore();
  // Retire the old cursor even when the new file/encoding fails to load.
  if (position.scope !== scope) setPosition(current);
  const key = JSON.stringify([scope, current.offset, current.version, current.revision]);
  const [result, setResult] = useState<{
    scope: string;
    key: string;
    value?: FilePreviewContent;
    error?: string;
    loading: boolean;
  }>({ scope: '', key: '', loading: true });
  const [notice, setNotice] = useState<{ scope: string; text: string } | null>(null);
  const request = useRef<AbortController | null>(null);
  const pending = useRef(false);
  const loading = result.key !== key || result.loading;
  const value = result.scope === scope ? result.value : undefined;
  const error = result.key === key ? result.error : undefined;
  useEffect(() => {
    // 每次分页变更取消旧请求，只接收当前读取结果。
    let alive = true;
    const controller = new AbortController();
    request.current = controller;
    pending.current = true;
    setResult((old) => ({ scope, key, loading: true, value: old.scope === scope ? old.value : undefined }));
    const query = new URLSearchParams({ encoding, offset: String(current.offset), limit: String(64 * 1024) });
    if (current.version) query.set('version', current.version);
    api<FilePreviewContent>(
      endpoint + (endpoint.includes('?') ? '&' : '?') + query,
      undefined,
      undefined,
      controller.signal,
    )
      .then((value) => {
        if (alive && !controller.signal.aborted) {
          setResult({ scope, key, value, loading: false });
          if (checkpointKey && value.page)
            saveReadingCheckpoint(client, savedKey, { ...current, version: value.page.version });
        }
      })
      .catch((error: unknown) => {
        if (!alive || controller.signal.aborted) return;
        if (error instanceof ApiError && error.code === 'FILE_CHANGED' && current.version) {
          // 内容版本变化时清除旧偏移并回到开头，避免把不同版本的分页拼在一起。
          if (checkpointKey) forgetReadingCheckpoint(client, savedKey);
          setNotice({ scope, text: '文件已变化，已重新读取开头。' });
          setPosition({ ...start(scope), revision: current.revision + 1 });
        } else
          setResult({
            scope,
            key,
            error: error instanceof Error ? error.message : '读取失败，请重试。',
            loading: false,
          });
      })
      .finally(() => {
        if (request.current === controller) {
          request.current = null;
          pending.current = false;
        }
      });
    return () => {
      alive = false;
      controller.abort();
    };
  }, [key, scope, endpoint, encoding, current.offset, current.version, current.revision]);
  /** 页面必须先取得有效 version，后续跳转全部携带此版本以供服务端对齐和变更检查。 */
  const move = (offset: number, history: number[]) => {
    // 读取尚未完成或偏移无效时不切页；历史最多保留 128 次跳转。
    if (loading || pending.current || !value?.page) return;
    const total = value.page.totalBytes;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset >= total || offset === value.page.offset)
      return;
    pending.current = true;
    const next = {
      scope,
      offset,
      version: value.page.version,
      history: history.slice(-128),
      revision: current.revision,
    };
    if (checkpointKey) saveReadingCheckpoint(client, savedKey, next);
    setPosition(next);
  };
  return {
    value,
    error,
    loading,
    notice: notice?.scope === scope ? notice.text : '',
    hasPrevious: current.history.length > 0,
    previous: () => {
      const history = current.history.slice();
      const offset = history.pop();
      if (offset !== undefined) move(offset, history);
    },
    next: () => {
      if (value?.page?.nextOffset != null)
        move(value.page.nextOffset, [...current.history, value.page.offset]);
    },
    jump: (offset: number) => move(offset, value?.page ? [...current.history, value.page.offset] : []),
    restart: () => {
      request.current?.abort();
      if (checkpointKey) forgetReadingCheckpoint(client, savedKey);
      setPosition({ ...start(scope), revision: current.revision + 1 });
    },
  };
}
