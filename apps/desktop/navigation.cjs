function allowedLocalNavigation(url, currentUrl, origin, main) {
  try {
    const target = new URL(url);
    if (!main) {
      const current = new URL(currentUrl);
      if (current.origin !== origin) return false;
      // Chromium redirects PDF subframes to its bundled reader's generated stream URL.
      if (
        target.protocol === 'chrome-extension:' &&
        target.host === 'mhjfbmdgcfjbbpaeojofohoefgiehjai' &&
        !target.username &&
        !target.password &&
        /^\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(target.pathname)
      )
        return true;
    }
    if (target.origin !== origin) return false;
    if (main) return target.pathname === '/';
    const terminal = new URL(currentUrl).searchParams.get('surface') === 'terminal';
    const prefix = terminal ? '/terminal' : '';
    const pathname = prefix
      ? target.pathname.startsWith(prefix + '/')
        ? target.pathname.slice(prefix.length)
        : null
      : target.pathname.startsWith('/terminal/')
        ? null
        : target.pathname;
    return (
      pathname !== null &&
      (pathname.startsWith('/preview/') ||
        /^\/api\/projects\/[^/]+\/(?:resources\/.+|files\/resource)$/.test(pathname) ||
        /^\/api\/artifacts\/[^/]+$/.test(pathname))
    );
  } catch {
    return false;
  }
}
module.exports = { allowedLocalNavigation };
