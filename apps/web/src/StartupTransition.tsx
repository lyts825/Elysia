/**
 * 展示应用启动过渡及视觉效果。
 * 根据偏好、就绪阶段和减少动态效果设置选择启动视觉与退出节奏，记录媒体就绪并保留跳过能力；不阻止主应用继续加载。
 * EN: Displays startup transitions and visuals. Chooses startup visuals/exit timing from preferences, readiness, and reduced-motion settings, records media readiness, and supports skipping while the main app continues loading.
 */
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import {
  readStartupMedia,
  useStartupPreferences,
  type StartupPreferences,
  type StartupMediaUpload,
} from './StartupPreferences';
import { markStartupStage } from './StartupDiagnostics';
import './Startup.css';

/**
 * 读取并持续订阅系统减少动态效果偏好，返回当前布尔值；卸载时解除media-query监听。
 * EN: Reads and subscribes to system reduced-motion preference, returns the current boolean, and removes the media-query listener on unmount.
 */
function useReducedMotion() {
  /**
   * 持续监听系统减少动态效果设置，卸载时移除监听。
   * EN: Observe system reduced motion continuously and remove listeners on unmount.
   */
  const [reduced, setReduced] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    /**
     * 把当前媒体查询匹配状态同步到React，使系统偏好变更立即影响启动动画。
     * EN: Synchronizes the media-query match into React so system preference changes immediately affect startup animation.
     */
    const update = () => setReduced(query.matches);
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  return reduced;
}

/**
 * 将六位背景色转为线性亮度后选择黑/白前景，生成独立于全局主题的启动页颜色变量。
 * EN: Convert six-digit background color to linear luminance, choose black/white foreground, and emit theme-independent startup CSS variables.
 */
export function startupColors(config: StartupPreferences): CSSProperties {
  /**
   * 根据背景亮度选择适合的前景颜色，并以 CSS 变量传给启动视觉。
   * EN: Choose foreground by background brightness and pass CSS variables to visuals.
   */
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

/**
 * 显示配置动画或本地导入预览；禁用、跳过或系统减少动态效果时使用静态标记。
 * 媒体读取和视频生命周期独立清理，失败回退内置视觉并可报告诊断，不能阻塞工作台连接。
 * EN: Show configured animation/local preview, falling back to static mark when disabled/skipped/reduced motion. Clean media reads/video lifecycle independently; failure uses built-in visuals and optional diagnostics without blocking workbench connection.
 */
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
  /**
   * 标记媒体视觉加载失败并通知上层；需要诊断时记录media-ready失败阶段，供启动记录核对。
   * EN: Marks visual media loading failed and informs the parent, recording a media-ready error stage when diagnostics are enabled.
   */
  const failure = () => {
    setFailed(true);
    errorHandler.current?.('动画无法解码，请换用其他 GIF、MP4 或 WebM 文件。');
    if (recordReady) markStartupStage('media-ready', { status: 'error' });
  };
  /**
   * 在启用就绪记录时标记媒体已解码，用于区分资源读取与实际视觉就绪。
   * EN: Marks media decoding ready when diagnostic recording is enabled, distinguishing resource retrieval from visual readiness.
   */
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

/**
 * 启动等待界面复用共享偏好；桌面已展示过开屏动画时跳过重复播放，但保留连接状态与操作。
 * EN: Waiting screen shares preferences. Skip duplicate animation if desktop already showed it, retaining connection state/actions.
 */
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
