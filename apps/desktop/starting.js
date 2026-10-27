/**
 * 渲染启动视觉内容并向桌面端记录启动阶段。
 * EN: Render startup visuals and report desktop startup stages.
 *
 * 依据启动配置选择静态、视频或动态图形，处理跳过与媒体回退，并上报资源展示阶段。
 * EN: Select static, video, or animated startup media, handle skipping and fallback, and report display stages.
 */
(() => {
  const visual = document.getElementById('visual'),
    skip = document.getElementById('skip');
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  let config,
    skipped = false,
    generation = 0;
  /**
   * 尽力通过桌面桥上报当前高精度启动时间，诊断失败不阻塞视觉显示。
   * EN: Attempt to report a high-resolution startup mark through the bridge without blocking visuals on diagnostic failure.
   */
  const mark = (stage, status = 'ok') =>
    void window.elysia
      ?.markStartupStage?.({ stage, status, atEpoch: performance.timeOrigin + performance.now() })
      .catch(() => {});
  // 替换动画前释放旧视频的来源，避免隐藏页面继续解码或播放。
  // EN: Release the previous video source before replacing visuals so a hidden page does not keep
  // decoding or playing it.
  const replaceVisual = (...elements) => {
    visual.querySelectorAll('video').forEach((element) => {
      element.pause();
      element.removeAttribute('src');
      element.load();
    });
    visual.replaceChildren(...elements);
  };
  /**
   * 创建本地品牌装饰DOM作为默认或媒体加载失败后的回退。
   * EN: Build local emblem DOM used by default and as a media-load fallback.
   */
  const emblem = () => {
    const element = document.createElement('div');
    element.className = 'startup-emblem';
    const letter = document.createElement('span');
    letter.textContent = 'E';
    element.append(
      letter,
      document.createElement('i'),
      document.createElement('i'),
      document.createElement('i'),
    );
    return element;
  };
  // generation 防止较早的异步媒体读取覆盖最新偏好或已销毁的页面。
  // EN: Use generation identity to prevent an older asynchronous media read from overwriting newer
  // preferences or a disposed page.
  const render = async () => {
    const current = ++generation,
      moving = config?.enabled !== false && !skipped && !reduced.matches;
    const style = moving ? config?.style || 'bloom' : 'minimal';
    visual.className = `startup-visual startup-${style}`;
    replaceVisual(emblem());
    skip.hidden = config?.enabled === false || skipped || reduced.matches;
    if (config && !moving) mark('media-ready', 'skipped');
    const media = moving && style === 'media' ? config?.media : undefined;
    if (!media) return;
    try {
      const source = await window.elysia.readStartupMedia(media);
      if (current !== generation) return;
      const element = document.createElement(media.mime === 'image/gif' ? 'img' : 'video');
      element.className = 'startup-media-content';
      if (element instanceof HTMLVideoElement) {
        element.autoplay = true;
        element.loop = true;
        element.muted = true;
        element.playsInline = true;
        element.preload = 'auto';
      } else element.alt = '';
      element.addEventListener(
        media.mime === 'image/gif' ? 'load' : 'loadeddata',
        () => {
          if (current === generation) mark('media-ready');
        },
        { once: true },
      );
      element.addEventListener(
        'error',
        () => {
          if (current !== generation) return;
          mark('media-ready', 'error');
          visual.className = 'startup-visual startup-minimal';
          replaceVisual(emblem());
        },
        { once: true },
      );
      element.src = source;
      replaceVisual(element);
    } catch {
      if (current === generation) {
        mark('media-ready', 'error');
        visual.className = 'startup-visual startup-minimal';
        replaceVisual(emblem());
      }
    }
  };
  skip.addEventListener('click', () => {
    skipped = true;
    mark('media-ready', 'skipped');
    void render();
  });
  reduced.addEventListener('change', () => void render());
  window.addEventListener('pagehide', () => {
    ++generation;
    replaceVisual();
  });
  void render();
  // 偏好与媒体读取不会阻塞后端启动或页面导航。
  // EN: Preference and media reads do not gate backend startup or page navigation.
  window.elysia
    ?.readStartup?.()
    .then((value) => {
      config = value.config;
      document.getElementById('title').textContent = config.title;
      document.getElementById('caption').textContent = config.caption;
      document.getElementById('caption').hidden = !config.caption;
      document.body.style.setProperty('--startup-accent', config.accent);
      document.body.style.setProperty('--startup-background', config.background);
      const rgb = [1, 3, 5].map((offset) => parseInt(config.background.slice(offset, offset + 2), 16) / 255);
      const luminance = rgb.reduce(
        (sum, value, index) =>
          sum +
          [0.2126, 0.7152, 0.0722][index] *
            (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4),
        0,
      );
      document.body.style.setProperty('--startup-ink', luminance > 0.179 ? '#000000' : '#ffffff');
      mark('preferences-ready', value.issue ? 'error' : 'ok');
      void render();
    })
    .catch(() => mark('preferences-ready', 'error'));
})();
