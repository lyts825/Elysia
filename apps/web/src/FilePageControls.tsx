/**
 * 提供文件内容分页控制和字节数格式化。
 * 按服务端字节页信息展示前后页、跳转及重试控制，动作通过回调交回读取层；不自行拼接跨版本正文。
 * EN: Provides file pagination controls and byte-size formatting. Displays previous/next, jump, and retry controls from server byte-page metadata, delegating actions to readers without joining content across revisions.
 */
import { useEffect, useId, useState } from 'react';
import type { TextFilePage } from '../../../packages/contracts/src/files';
import { Icon } from './Icon';
import './file-page.css';

/**
 * 用二进制单位显示字节数量，保留最多一位小数。
 * EN: Format byte counts using binary units with at most one decimal place.
 */
export function formatFileBytes(bytes: number) {
  if (bytes < 1024) return `${bytes.toLocaleString()} B`;
  const divisor = bytes < 1024 ** 2 ? 1024 : bytes < 1024 ** 3 ? 1024 ** 2 : 1024 ** 3;
  const unit = divisor === 1024 ? 'KiB' : divisor === 1024 ** 2 ? 'MiB' : 'GiB';
  return `${(bytes / divisor).toLocaleString(undefined, { maximumFractionDigits: 1 })} ${unit}`;
}

/**
 * 控制字节分页，显示当前实际读取范围。百分比只是目标位置，服务端负责按编码边界对齐；
 * 100% 定位末页起点而非 EOF，确保仍有内容可读。翻页过程中禁用动作以免累积旧游标。
 * EN: Control byte-based pagination and show the actual loaded range. A percentage is a target only; the server aligns to encoding boundaries. At 100%, target the final page start instead of EOF so content remains readable. Disable actions while paging to avoid accumulating stale cursors.
 */
export function FilePageControls({
  page,
  loading,
  hasPrevious,
  previous,
  next,
  jump,
  restart,
}: {
  page: TextFilePage;
  loading: boolean;
  hasPrevious: boolean;
  previous: () => void;
  next: () => void;
  jump: (offset: number) => void;
  restart?: () => void;
}) {
  const positionHelpId = useId();
  const [percent, setPercent] = useState('0');
  /**
   * 服务端页偏移、总字节或版本变化时同步跳转百分比输入，避免新页沿用旧页的表单值。
   * EN: Synchronizes the jump-percentage input after offset, total-byte, or revision changes so a new page does not retain the old form value.
   */
  useEffect(() => {
    setPercent(String(page.totalBytes ? Math.floor((page.offset / page.totalBytes) * 100) : 0));
  }, [page.offset, page.totalBytes, page.version]);
  const target = Number(percent);
  const valid = percent.trim() !== '' && Number.isFinite(target) && target >= 0 && target <= 100;
  /**
   * 百分之百定位到末页起点，其他比例预留末尾字节以便服务端对齐编码边界。
   * EN: One hundred percent targets the final page start. Other percentages reserve trailing bytes so the server can align the encoding boundary.
   */
  const targetOffset =
    target === 100
      ? Math.max(0, page.totalBytes - Math.max(4, page.endOffset - page.offset))
      : Math.min(Math.max(0, page.totalBytes - 4), Math.floor((page.totalBytes * target) / 100));
  return (
    <div className="file-page-controls" aria-label="文件分页">
      <span
        className="file-page-range"
        title={`字节 ${page.offset.toLocaleString()}–${page.endOffset.toLocaleString()} / ${page.totalBytes.toLocaleString()}`}
      >
        <span className="file-page-range-label">当前片段</span>
        {formatFileBytes(page.offset)}–{formatFileBytes(page.endOffset)}
        <span> / {formatFileBytes(page.totalBytes)}</span>
      </span>
      <div className="file-page-actions">
        {restart && page.offset > 0 && (
          <button type="button" disabled={loading} onClick={restart} title="回到文件开头">
            开头
          </button>
        )}
        <button type="button" aria-label="上一页" disabled={loading || !hasPrevious} onClick={previous}>
          <Icon name="chevron" size={13} />
        </button>
        <button
          type="button"
          aria-label="下一页"
          disabled={loading || page.nextOffset === null}
          onClick={next}
        >
          <Icon name="chevron" size={13} />
        </button>
        <label className="file-page-jump">
          <span>位置</span>
          <input
            aria-label="文件位置百分比"
            title="按位置读取；100% 查看末尾一页"
            aria-describedby={positionHelpId}
            aria-invalid={!valid}
            type="number"
            min={0}
            max={100}
            step={1}
            value={percent}
            disabled={loading}
            onChange={(event) => setPercent(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && valid && !loading) {
                event.preventDefault();
                jump(targetOffset);
              }
            }}
          />
          <span>%</span>
        </label>
        <button
          type="button"
          disabled={loading || !valid || !page.totalBytes}
          aria-describedby={positionHelpId}
          onClick={() => jump(targetOffset)}
        >
          定位
        </button>
      </div>
      <p className="file-page-position-help" id={positionHelpId} data-invalid={!valid}>
        {valid
          ? '按文件字节位置读取；100% 查看末尾一页。'
          : '请输入 0～100 的位置百分比；100% 查看末尾一页。'}
      </p>
      <details className="file-page-detail">
        <summary>精确字节与定位说明</summary>
        <div
          className="file-page-detail-reading"
          tabIndex={0}
          role="region"
          aria-label="当前文件片段精确字节与定位说明"
        >
          <dl>
            <div>
              <dt>片段起点（含）</dt>
              <dd>{page.offset.toLocaleString()} 字节</dd>
            </div>
            <div>
              <dt>片段终点（不含）</dt>
              <dd>{page.endOffset.toLocaleString()} 字节</dd>
            </div>
            <div>
              <dt>文件大小</dt>
              <dd>{page.totalBytes.toLocaleString()} 字节</dd>
            </div>
          </dl>
          <p>实际片段起点会对齐文本编码边界。</p>
        </div>
      </details>
    </div>
  );
}
