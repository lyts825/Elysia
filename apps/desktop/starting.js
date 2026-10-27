// 渲染启动视觉内容并向桌面端记录启动阶段。
(() => {
  const visual = document.getElementById('visual'),
    skip = document.getElementById('skip');
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  let config,
    skipped = false,
    generation = 0;
  const mark = (stage, status = 'ok') =>
    void window.elysia
      ?.markStartupStage?.({ stage, status, atEpoch: performance.timeOrigin + performance.now() })
      .catch(() => {});
  const replaceVisual = (...elements) => {
    visual.querySelectorAll('video').forEach((element) => {
      element.pause();
      element.removeAttribute('src');
      element.load();
    });
    visual.replaceChildren(...elements);
  };
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
  // Preference and media reads never gate backend startup or navigation.
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
