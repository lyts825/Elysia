/**
 * 限制桌面窗口和子框架可访问的本地导航目标。
 * 判断窗口导航是否允许：主框架只允许本地根路径，子框架只允许当前入口的预览和资源。
 * 内置 PDF 阅读器的受限 stream URL 单独放行；解析失败或来源不符时拒绝。
 * EN: Restrict navigation of the main window and child frames. The main frame may visit only the
 * local root; subframes may use previews and resources belonging to their current surface. Allow the
 * narrowly defined built-in PDF stream URL separately, and reject invalid URLs or origins.
 */
function allowedLocalNavigation(url, currentUrl, origin, main) {
  try {
    const target = new URL(url);
    if (!main) {
      const current = new URL(currentUrl);
      if (current.origin !== origin) return false;
      // Chromium 会将 PDF 子框架重定向到内置阅读器生成的流地址。
      // EN: Chromium redirects PDF subframes to the generated stream URL of its bundled viewer.
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
    // EN: Native and terminal surfaces use different route prefixes, so subframes cannot use resource
    // navigation to cross between surfaces.
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
