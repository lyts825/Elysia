// 终端 CLI 安装失败分类及对应修复指引。
export type TerminalCliInstallRepair = 'check' | 'version' | 'template' | 'retry';
// 保留原始错误码、分类和可执行修复动作，供界面选择对应的指引。
export type TerminalCliInstallFailure = {
  code: string;
  category: string;
  message: string;
  actions: readonly TerminalCliInstallRepair[];
};

const guides: Record<string, Omit<TerminalCliInstallFailure, 'code'>> = {
  DOCKER_CLI_MISSING: {
    category: 'Docker 未安装',
    message: '请安装 Docker Desktop 并启动 Linux 引擎，然后重新检查。',
    actions: ['check'],
  },
  DOCKER_UNAVAILABLE: {
    category: 'Docker 未就绪',
    message: '请在 Docker Desktop 启动 Linux 引擎，然后重新检查。',
    actions: ['check'],
  },
  DOCKER_PLATFORM: {
    category: '容器模式不匹配',
    message: '请在 Docker Desktop 切换到 Linux 容器模式，然后重新检查。',
    actions: ['check'],
  },
  DOCKER_IMAGE_MISSING: {
    category: '基础镜像不可用',
    message: '请选择已构建或导入的基础镜像，再重新安装。',
    actions: ['template', 'retry'],
  },
  TERMINAL_CLI_IMAGE: {
    category: '镜像无法确认',
    message: '无法固定基础镜像内容，请检查 Docker 或编辑模板中的镜像。',
    actions: ['check', 'template'],
  },
  TERMINAL_RESOURCE_CAPACITY: {
    category: 'Docker 资源不足',
    message: '请在 Docker Desktop 增加可用 CPU 或内存，然后重试安装。',
    actions: ['retry'],
  },
  TERMINAL_CLI_INSTALL_NETWORK: {
    category: '下载连接失败',
    message: '依赖或基础镜像下载未完成，请检查网络、代理和证书后重试。',
    actions: ['retry'],
  },
  TERMINAL_CLI_INSTALL_PACKAGE_VERSION: {
    category: '版本不可获取',
    message: '包管理器未找到所需包或版本，请检查安装版本后重试。',
    actions: ['version'],
  },
  TERMINAL_CLI_INSTALL_STORAGE: {
    category: '构建空间不足',
    message: 'Docker 构建空间不足，请在 Docker Desktop 释放空间后重试。',
    actions: ['retry'],
  },
  TERMINAL_CLI_INSTALL_TIMEOUT: {
    category: '安装超时',
    message: '安装超过等待时限，请检查 Docker 和下载连接后重试。',
    actions: ['check', 'retry'],
  },
  TERMINAL_CLI_INSTALL_ENGINE: {
    category: '构建引擎中断',
    message: 'Docker 构建引擎连接中断，请检查引擎后重试。',
    actions: ['check', 'retry'],
  },
  TERMINAL_CLI_VERIFY: {
    category: '安装验证未完成',
    message: '构建结束后未能确认 CLI 镜像，请重新检查后再安装。',
    actions: ['check', 'retry'],
  },
  TERMINAL_CLI_UNAVAILABLE: {
    category: 'CLI 无法运行',
    message: '镜像中的 CLI 未通过离线检测，请检查模板或重新安装。',
    actions: ['template', 'retry'],
  },
  TERMINAL_CLI_EXECUTABLE: {
    category: 'CLI 命令无效',
    message: '模板需要一个明确的 CLI 可执行程序，请编辑模板后重试。',
    actions: ['template'],
  },
  TERMINAL_CLI_VERSION: {
    category: '版本无法确认',
    message: '请使用明确版本号；安装后的 CLI 也须返回可确定的版本。',
    actions: ['version', 'check'],
  },
  TERMINAL_CLI_VERSION_MISMATCH: {
    category: '安装版本不一致',
    message: '检测到的 CLI 版本与请求版本不一致，请检查版本后重新安装；未应用镜像。',
    actions: ['version', 'check'],
  },
  TERMINAL_CLI_CLEANUP: {
    category: '检测容器待确认',
    message: '离线检测容器尚未确认清理，资源仍保留；请检查 Docker 后重新检测。',
    actions: ['check'],
  },
  TERMINAL_CLI_INTERRUPTED: {
    category: '安装已中断',
    message: '服务退出或重启中断了安装，请重新安装；任务镜像未更改。',
    actions: ['retry'],
  },
  TERMINAL_CLI_CANCELLED: {
    category: '安装已取消',
    message: '安装已取消；如仍需安装，请手动重新开始。',
    actions: ['retry'],
  },
  TERMINAL_CLI_CLOSED: {
    category: '服务正在退出',
    message: '终端管理服务正在退出，请重新打开 Elysia 后检查。',
    actions: ['check'],
  },
  TERMINAL_CLI_BUSY: {
    category: '安装正在收尾',
    message: '已有安装正在执行或收尾，请等待完成后重试。',
    actions: ['retry'],
  },
  TERMINAL_CLI_CUSTOM_INSTALL: {
    category: '使用自定义镜像',
    message: '自定义 CLI 需要自行构建的镜像，请在模板中配置。',
    actions: ['template'],
  },
  TERMINAL_CLI_INSTALL: {
    category: '安装未完成',
    message: '未能确定安装失败原因，请重新检查 Docker 和安装选项后重试。',
    actions: ['check', 'retry'],
  },
};
const versionPattern = '[0-9]+\\.[0-9]+\\.[0-9]+(?:-[a-zA-Z0-9][a-zA-Z0-9.-]*)?';
const version = new RegExp(`^${versionPattern}$`);
const mismatchMessage = new RegExp(
  `^实际 CLI 版本 (${versionPattern}) 与请求版本 (${versionPattern}) 不一致，请重新安装；未应用镜像$`,
);
/** 仅接受结构化版本字段或精确匹配旧版错误模板的内容，防止任意远端诊断进入界面。 */
function versions(details: unknown): { actualVersion: string; requestedVersion: string } | undefined {
  if (typeof details === 'string' && details.length <= 240) {
    const match = mismatchMessage.exec(details);
    if (match) details = { actualVersion: match[1], requestedVersion: match[2] };
  }
  if (!details || typeof details !== 'object') return;
  const values = details as Record<string, unknown>;
  if (
    typeof values.actualVersion === 'string' &&
    typeof values.requestedVersion === 'string' &&
    values.actualVersion.length <= 80 &&
    values.requestedVersion.length <= 80 &&
    version.test(values.actualVersion) &&
    version.test(values.requestedVersion)
  )
    return { actualVersion: values.actualVersion, requestedVersion: values.requestedVersion };
}

/** Public installation failures use a closed vocabulary, never transport text or arbitrary AppError messages. */
// 未知错误码映射为通用说明；仅在版本格式严格有效时展示实际与请求版本。
export function terminalCliInstallFailure(code: unknown, details?: unknown): TerminalCliInstallFailure {
  const safeCode = typeof code === 'string' && Object.hasOwn(guides, code) ? code : 'TERMINAL_CLI_INSTALL';
  const guide = guides[safeCode];
  const mismatch = safeCode === 'TERMINAL_CLI_VERSION_MISMATCH' ? versions(details) : undefined;
  return {
    code: safeCode,
    ...guide,
    ...(mismatch
      ? {
          message: `实际 CLI 版本 ${mismatch.actualVersion} 与请求版本 ${mismatch.requestedVersion} 不一致，请重新安装；未应用镜像`,
        }
      : {}),
  };
}
