/**
 * 提供 useFilePage React Hook 使用的状态与处理逻辑。
 * 以文件端点、编码和刷新代次隔离读取状态，管理字节分页、取消、版本变更与阅读检查点；不拼接不同版本内容。
 * EN: Provides versioned, encoded file pagination state and actions. Isolates reads by file endpoint, encoding, and refresh generation and manages byte paging, cancellation, revision changes, and checkpoints without joining different revisions.
 */
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

/**
 * 为指定文件读取作用域建立首页游标、空历史和初始修订，每次返回独立状态对象。
 * EN: Creates fresh first-page position, empty history, and initial revision for a file-read scope.
 */
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
 * EN: Scope reads by endpoint/encoding/manual refresh; page offset/server version identify body request. Same-scope paging may retain prior content; file/encoding changes retire cursors immediately. FILE_CHANGED returns to first page without mixing bytes. Navigation validates exclusivity/range and caps history at 128.
 */
export function useFilePage(endpoint: string, encoding: string, refresh: number, checkpointKey?: string) {
  const client = useSurfaceClient(),
    { api } = client;
  const scope = JSON.stringify([endpoint, encoding, refresh]);
  const savedKey = JSON.stringify(['file-page', checkpointKey, endpoint, encoding]);
  /**
   * 将有效阅读检查点覆盖到首页状态并强制使用当前scope，使恢复游标不能切换到其他文件范围。
   * EN: Overlays a valid reading checkpoint onto first-page state while forcing the current scope so restoration cannot move into another file scope.
   */
  const restore = () => ({
    ...start(scope),
    ...(checkpointKey ? readingCheckpoint<ReturnType<typeof start>>(client, savedKey) : {}),
    scope,
  });
  const [position, setPosition] = useState(restore);
  const current = position.scope === scope ? position : restore();
  /**
   * 即使新文件或编码读取失败，也废弃旧游标。
   * EN: Retire the old cursor even when the new file/encoding fails to load.
   */
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
    /**
     * 每次分页变更取消旧请求，只接收当前读取结果。
     * EN: Cancel old read for each page change and accept current response only.
     */
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
          /**
           * 内容版本变化时清除旧偏移并回到开头，避免把不同版本的分页拼在一起。
           * EN: Changed content version clears offset and returns to start, avoiding mixed-version pages.
           */
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
  /**
   * 页面必须先取得有效 version，后续跳转全部携带此版本以供服务端对齐和变更检查。
   * EN: Obtain a valid version before navigation; all later offsets carry it for server alignment/change detection.
   */
  const move = (offset: number, history: number[]) => {
    /**
     * 读取尚未完成或偏移无效时不切页；历史最多保留 128 次跳转。
     * EN: Do not page while loading or for invalid offsets; retain at most 128 navigation positions.
     */
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
    /**
     * 从当前返回轨迹弹出上一页偏移并交给统一move校验；无历史时保持不动。
     * EN: Pops the preceding offset from the current return trail and delegates to validated move, remaining unchanged when history is empty.
     */
    previous: () => {
      const history = current.history.slice();
      const offset = history.pop();
      if (offset !== undefined) move(offset, history);
    },
    /**
     * 只有服务端给出nextOffset时才翻页，并把当前页偏移加入返回历史。
     * EN: Advances only when the server supplies nextOffset, adding the current page offset to return history.
     */
    next: () => {
      if (value?.page?.nextOffset != null)
        move(value.page.nextOffset, [...current.history, value.page.offset]);
    },
    /**
     * 把目标字节偏移交给move进行边界与忙碌校验，并在已有正文时保留当前页作为返回点。
     * EN: Delegates a target byte offset to move for bounds/busy checks, retaining the loaded page as a return point when available.
     */
    jump: (offset: number) => move(offset, value?.page ? [...current.history, value.page.offset] : []),
    /**
     * 取消当前读取、删除该文件阅读检查点并重建首页；增加修订使相同文件也重新发起读取。
     * EN: Aborts the current read, deletes this file checkpoint, and resets to page one, advancing revision so the same file is reread.
     */
    restart: () => {
      request.current?.abort();
      if (checkpointKey) forgetReadingCheckpoint(client, savedKey);
      setPosition({ ...start(scope), revision: current.revision + 1 });
    },
  };
}
