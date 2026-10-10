import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { useStartupPreferences, type StartupPreferences } from './StartupPreferences';
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
}: {
  config: StartupPreferences;
  skipped?: boolean;
}) {
  const reduced = useReducedMotion();
  const video = useRef<HTMLVideoElement>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [config.media?.dataUrl]);
  const media =
    config.enabled && !skipped && !reduced && !failed && config.style === 'media' ? config.media : undefined;
  useEffect(() => {
    const element = video.current;
    return () => {
      element?.pause();
      element?.removeAttribute('src');
      element?.load();
    };
  }, [media?.dataUrl]);
  const style =
    !config.enabled || skipped || reduced
      ? 'minimal'
      : config.style === 'media' && !media
        ? 'bloom'
        : config.style;
  return (
    <div className={`startup-visual startup-${style}`} aria-hidden="true">
      {media ? (
        media.mime === 'image/gif' ? (
          <img className="startup-media-content" src={media.dataUrl} alt="" onError={() => setFailed(true)} />
        ) : (
          <video
            ref={video}
            className="startup-media-content"
            src={media.dataUrl}
            autoPlay
            loop
            muted
            playsInline
            preload="metadata"
            onError={() => setFailed(true)}
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
  const { config } = useStartupPreferences();
  const [skipped, setSkipped] = useState(false);
  return (
    <main className={`startup-screen ${className}`} style={startupColors(config)}>
      <div className="startup-content">
        <StartupVisual config={config} skipped={skipped} />
        <h1>{config.title}</h1>
        {config.caption && <p className="startup-caption">{config.caption}</p>}
        <p className="startup-status" role="status">
          <span className="startup-status-dot" />
          正在准备工作台
        </p>
        {config.enabled && !skipped && (
          <button className="startup-skip" onClick={() => setSkipped(true)}>
            跳过动画
          </button>
        )}
        <div className="startup-actions">{children}</div>
      </div>
    </main>
  );
}
