// 限制桌面窗口和子框架可访问的本地导航目标。
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
    // 终端和原生界面使用不同路由前缀，不能借子框架跨入口访问资源。
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
