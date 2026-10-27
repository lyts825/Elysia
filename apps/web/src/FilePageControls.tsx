/* 提供文件内容分页控制和字节数格式化。 */
import { useEffect, useId, useState } from 'react';
import type { TextFilePage } from '../../../packages/contracts/src/files';
import { Icon } from './Icon';
import './file-page.css';

/** 用二进制单位显示字节数量，保留最多一位小数。 */
export function formatFileBytes(bytes: number) {
  if (bytes < 1024) return `${bytes.toLocaleString()} B`;
  const divisor = bytes < 1024 ** 2 ? 1024 : bytes < 1024 ** 3 ? 1024 ** 2 : 1024 ** 3;
  const unit = divisor === 1024 ? 'KiB' : divisor === 1024 ** 2 ? 'MiB' : 'GiB';
  return `${(bytes / divisor).toLocaleString(undefined, { maximumFractionDigits: 1 })} ${unit}`;
}

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
  useEffect(() => {
    setPercent(String(page.totalBytes ? Math.floor((page.offset / page.totalBytes) * 100) : 0));
  }, [page.offset, page.totalBytes, page.version]);
  const target = Number(percent);
  const valid = percent.trim() !== '' && Number.isFinite(target) && target >= 0 && target <= 100;
  // 百分之百定位到末页起点，其他比例预留末尾字节以便服务端对齐编码边界。
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
