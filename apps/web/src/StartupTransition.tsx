import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import {
  readStartupMedia,
  useStartupPreferences,
  type StartupPreferences,
  type StartupMediaUpload,
} from './StartupPreferences';
import { markStartupStage } from './StartupDiagnostics';
import './Startup.css';

function useReducedMotion() {
  const [reduced, setReduced] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReduced(query.matches);
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  return reduced;
}

export function startupColors(config: StartupPreferences): CSSProperties {
  const rgb = [1, 3, 5].map((offset) => parseInt(config.background.slice(offset, offset + 2), 16) / 255);
  const luminance = rgb.reduce(
    (sum, value, index) =>
      sum +
      [0.2126, 0.7152, 0.0722][index] * (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4),
    0,
  );
  return {
    '--startup-accent': config.accent,
    '--startup-background': config.background,
    '--startup-ink': luminance > 0.179 ? '#000000' : '#ffffff',
  } as CSSProperties;
}

export function StartupVisual({
  config,
  skipped = false,
  upload,
  onError,
  recordReady = false,
}: {
  config: StartupPreferences;
  skipped?: boolean;
  upload?: StartupMediaUpload;
  onError?: (message: string) => void;
  recordReady?: boolean;
}) {
  const reduced = useReducedMotion();
  const video = useRef<HTMLVideoElement>(null);
  const [failed, setFailed] = useState(false);
  const [source, setSource] = useState('');
  const errorHandler = useRef(onError);
  errorHandler.current = onError;
  useEffect(() => {
    setFailed(false);
    setSource('');
  }, [config.media?.id, upload]);
  const media =
    config.enabled && !skipped && !reduced && !failed && config.style === 'media' ? config.media : undefined;
  useEffect(() => {
    let cancelled = false,
      temporary: string | undefined;
    setSource('');
    if (media) {
      const request =
        upload?.media.id === media.id
          ? Promise.resolve(
              upload.blob ? (temporary = URL.createObjectURL(upload.blob)) : upload.dataUrl || '',
            )
          : readStartupMedia(media);
      void request
        .then((value) => {
          if (!cancelled) setSource(value);
        })
        .catch(() => {
          if (cancelled) return;
          setFailed(true);
          errorHandler.current?.('已保存的动画无法读取，请重新导入。');
          if (recordReady) markStartupStage('media-ready', { status: 'error' });
        });
    } else if (recordReady && (!config.enabled || skipped || reduced))
      markStartupStage('media-ready', { status: 'skipped' });
    return () => {
      cancelled = true;
      if (temporary) URL.revokeObjectURL(temporary);
    };
  }, [media?.id, upload, recordReady, config.enabled, skipped, reduced]);
  useEffect(() => {
    const element = video.current;
    return () => {
      element?.pause();
      element?.removeAttribute('src');
      element?.load();
    };
  }, [source]);
  const failure = () => {
    setFailed(true);
    errorHandler.current?.('动画无法解码，请换用其他 GIF、MP4 或 WebM 文件。');
    if (recordReady) markStartupStage('media-ready', { status: 'error' });
  };
  const decoded = () => {
    if (recordReady) markStartupStage('media-ready');
  };
  const style =
    !config.enabled || skipped || reduced
      ? 'minimal'
      : config.style === 'media' && !media
        ? 'bloom'
        : config.style;
  return (
    <div className={`startup-visual startup-${style}`} aria-hidden="true">
      {media && source ? (
        media.mime === 'image/gif' ? (
          <img className="startup-media-content" src={source} alt="" onError={failure} onLoad={decoded} />
        ) : (
          <video
            ref={video}
            className="startup-media-content"
            src={source}
            autoPlay
            loop
            muted
            playsInline
            preload="metadata"
            onError={failure}
            onLoadedData={decoded}
          />
        )
      ) : (
        <div className="startup-emblem">
          <span>E</span>
          <i />
          <i />
          <i />
        </div>
      )}
    </div>
  );
}

export function StartupTransition({
  children,
  className = '',
}: {
  children?: ReactNode;
  className?: string;
}) {
  const { config, desktopBootShown } = useStartupPreferences();
  const [skipped, setSkipped] = useState(false);
  return (
    <main className={`startup-screen ${className}`} style={startupColors(config)}>
      <div className="startup-content">
        <StartupVisual config={config} skipped={skipped || desktopBootShown} recordReady />
        <h1>{config.title}</h1>
        {config.caption && <p className="startup-caption">{config.caption}</p>}
        <p className="startup-status" role="status">
          <span className="startup-status-dot" />
          正在准备工作台
        </p>
        {config.enabled && !skipped && !desktopBootShown && (
          <button className="startup-skip" onClick={() => setSkipped(true)}>
            跳过动画
          </button>
        )}
        <div className="startup-actions">{children}</div>
      </div>
    </main>
  );
}
