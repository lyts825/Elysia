(() => {
  const visual = document.getElementById('visual');
  const skip = document.getElementById('skip');
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  let config;
  let skipped = false;
  const replaceVisual = (...elements) => {
    visual.querySelectorAll('video').forEach((element) => {
      element.pause();
      element.removeAttribute('src');
      element.load();
    });
    visual.replaceChildren(...elements);
  };
  const emblem = () => {
    const mark = document.createElement('div');
    mark.className = 'startup-emblem';
    const letter = document.createElement('span');
    letter.textContent = 'E';
    mark.append(
      letter,
      document.createElement('i'),
      document.createElement('i'),
      document.createElement('i'),
    );
    return mark;
  };
  const render = () => {
    const moving = config?.enabled !== false && !skipped && !reduced.matches;
    const style = moving ? config?.style || 'bloom' : 'minimal';
    visual.className = `startup-visual startup-${style}`;
    replaceVisual(emblem());
    skip.hidden = config?.enabled === false || skipped || reduced.matches;
    const media = moving && style === 'media' ? config?.media : undefined;
    if (media) {
      const element = document.createElement(media.mime === 'image/gif' ? 'img' : 'video');
      element.className = 'startup-media-content';
      if (element instanceof HTMLVideoElement) {
        element.autoplay = true;
        element.loop = true;
        element.muted = true;
        element.playsInline = true;
        element.preload = 'metadata';
      } else element.alt = '';
      element.addEventListener(
        'error',
        () => {
          visual.className = 'startup-visual startup-minimal';
          replaceVisual(emblem());
        },
        { once: true },
      );
      element.src = media.dataUrl;
      replaceVisual(element);
    }
  };
  skip.addEventListener('click', () => {
    skipped = true;
    render();
  });
  reduced.addEventListener('change', render);
  render();
  // Reading preferences is independent of backend startup and never gates navigation.
  window.elysia
    ?.readStartup?.()
    .then((value) => {
      config = value;
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
      render();
    })
    .catch(() => {});
})();
