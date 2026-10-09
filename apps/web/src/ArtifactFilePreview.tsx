import { useState } from 'react';
import { FilePageControls } from './FilePageControls';
import { FileContentView, fileEncodingOptions } from './FileContentView';
import { useFilePage } from './useFilePage';

export function ArtifactFilePreview({ id }: { id: string }) {
  const [encoding, setEncoding] = useState('auto');
  const reader = useFilePage('/artifacts/' + id + '/preview', encoding, 0);
  const { value, loading, error } = reader;
  return (
    <div className="artifact-file-preview" aria-busy={loading}>
      {(!value || value.text !== null) && (
        <div className="file-encoding-choice">
          <label>
            编码{' '}
            <select
              aria-label="文本编码"
              value={encoding}
              disabled={loading}
              onChange={(event) => setEncoding(event.target.value)}
            >
              {fileEncodingOptions.map(([key, name]) => (
                <option key={key} value={key}>
                  {name}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}
      {reader.notice && (
        <p className="file-read-notice" role="status">
          {reader.notice}
        </p>
      )}
      {loading && (
        <p className="file-loading" role="status">
          正在核对并读取产物…
        </p>
      )}
      {error && (
        <div className="inline-warning" role="alert">
          <span>{error}</span>
          <button type="button" disabled={loading} onClick={reader.restart}>
            重试
          </button>
        </div>
      )}
      {value && (
        <>
          {value.page?.paged && (
            <FilePageControls
              page={value.page}
              loading={loading}
              hasPrevious={reader.hasPrevious}
              previous={reader.previous}
              next={reader.next}
              jump={reader.jump}
              restart={reader.restart}
            />
          )}
          <FileContentView key={id + ':' + encoding} file={value} />
        </>
      )}
    </div>
  );
}
