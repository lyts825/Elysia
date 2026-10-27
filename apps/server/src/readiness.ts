/**
 * 汇总运行环境就绪状态并提供查询接口。
 * 只读整理已保存配置为缺失、记录、需复核或未知提示；不发网络/启动进程，历史核验不证明此刻仍可用。
 * EN: Aggregates environment readiness and exposes read endpoints. Read-only summaries classify saved configuration as missing/recorded/review/unknown without network/process probes or claims of present availability.
 */
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import {
  VERSION,
  type Project,
  type ProviderConfig,
  type WorkspaceSurface,
} from '../../../packages/contracts/src/index.js';
import { ReadinessSnapshot, type ReadinessCheck } from '../../../packages/contracts/src/readiness.js';
import {
  TerminalConnectionBinding,
  TerminalConnectionHealth,
  TerminalProjectPreferences,
} from '../../../packages/contracts/src/terminal-control.js';
import type { Store } from '../../../packages/storage/src/index.js';
import { terminalControlApps, terminalSettings } from './terminal-settings.js';
import { terminalProtocols } from './terminal-catalog.js';

/**
 * 限制公开诊断标签长度，超限加省略号，不修改已保存配置。
 * EN: Bounds public diagnostic labels with ellipsis without changing saved configuration.
 */
const label = (value: string, length = 220) =>
  value.length <= length ? value : value.slice(0, length - 1) + '…';

/**
 * 读取并按指定 schema 校验一条配置元数据；缺失返回 undefined，损坏让外层明确标为需核对。
 * EN: Reads one metadata entry through its schema; absent returns undefined and damage propagates for explicit review status.
 */
function metadata<T>(store: Store, key: string, schema: z.ZodType<T>): T | undefined {
  const row = store.db.prepare('SELECT value FROM storage_meta WHERE key=?').get(key) as
    | { value: string }
    | undefined;
  return row ? schema.parse(JSON.parse(row.value)) : undefined;
}

/**
 * 将未归档原生模型配置转换为有界就绪项目，区分缺失、历史验证和需复核，并明确静态记录无法证明当前凭据可用。
 * EN: Maps nonarchived native configurations to bounded readiness checks, distinguishing missing/historically verified/review states without claiming current credential availability.
 */
function nativeChecks(store: Store): ReadinessCheck[] {
  const providers = store.all<ProviderConfig>('providers').filter((provider) => !provider.archived);
  if (!providers.length)
    return [
      {
        id: 'native-models',
        title: '模型连接',
        status: 'missing',
        detail: '尚未保存模型连接。添加 API 连接或订阅连接后，在设置中明确验证一次实际调用。',
        action: { kind: 'models' },
      },
    ];
  const checks: ReadinessCheck[] = providers.slice(0, 100).map((provider, index) => {
    const verified = provider.checkedRevision === provider.revision;
    return {
      id: `provider:${index}`,
      title: label(provider.label),
      status: verified ? 'recorded' : 'review',
      detail: `${label(provider.model || '尚未填写模型')} · 配置版本 ${provider.revision}。${
        verified
          ? '此版本有历史调用通过记录；不代表当前连接仍可用。'
          : '此版本尚无调用通过记录，请在模型设置中核对并验证。'
      }`,
      action: { kind: 'models', ...(provider.id.length <= 160 ? { targetId: provider.id } : {}) },
    };
  });
  if (providers.length > 100)
    checks.push({
      id: 'native-models-more',
      title: '更多模型连接',
      status: 'optional',
      detail: `共有 ${providers.length} 个连接，此处展示前 100 个。其余连接可在模型设置中查看。`,
      action: { kind: 'models' },
    });
  checks.push({
    id: 'native-credentials',
    title: '凭据与在线状态',
    status: 'unknown',
    detail:
      '本次未读取密钥库、环境变量或订阅登录，也未发起模型请求。需要确认当前连接时，在模型设置中明确验证；实际调用可能产生费用。',
    action: { kind: 'models' },
  });
  return checks;
}

/**
 * 组合模板、应用、项目偏好和保存连接的静态诊断；只做兼容读取，不调用 Docker、读取凭据或发送模型请求。
 * EN: Combines template/app/project/saved-connection static diagnostics using compatibility reads only, without Docker, secret lookup or model requests.
 */
function terminalChecks(store: Store, project?: Project): ReadinessCheck[] {
  /**
   * 这些兼容读取器仅计算已保存配置，不写入或探测外部环境。
   * EN: These compatibility readers compute saved configuration only; they never write or probe.
   */
  const settings = terminalSettings(store),
    apps = terminalControlApps(store);
  const preferences = project
    ? metadata(store, `surface:terminal:control:project:${project.id}`, TerminalProjectPreferences)
    : undefined;
  const connections =
    metadata(store, 'surface:terminal:control:connections:v1', z.array(TerminalConnectionBinding).max(100)) ??
    [];
  const preferred = settings.profiles.find((profile) => profile.id === preferences?.defaultProfileId);
  const profile = preferred ?? settings.profiles.find((profile) => profile.id === settings.defaultProfileId);
  const checks: ReadinessCheck[] = [];
  if (preferences?.defaultProfileId && !preferred)
    checks.push({
      id: 'terminal-project-profile',
      title: '项目默认模板',
      status: 'review',
      detail: '项目指定的模板已不存在，当前展示全局默认模板。请重新核对项目默认。',
      action: { kind: 'terminal-project' },
    });
  if (!profile)
    checks.push({
      id: 'terminal-template',
      title: '终端模板',
      status: 'missing',
      detail: '当前没有可用的默认模板，请在终端管理中选择应用或模板。',
      action: { kind: 'terminal-templates' },
    });
  else {
    checks.push({
      id: 'terminal-template',
      title: '终端模板',
      status: 'recorded',
      detail: `${profile.label} · ${profile.agent}。${preferred ? '采用项目默认。' : '采用全局默认。'}这里只确认模板配置记录，尚未检查镜像和 CLI。`,
      action: { kind: 'terminal-templates', targetId: profile.id },
    });
    /**
     * 按模板代理支持的协议判断连接能否供该模板选择，不以显示标签猜测。
     * EN: Checks connection protocol against the template adapter's supported protocols rather than display labels.
     */
    const compatible = (connection: TerminalConnectionBinding) =>
      terminalProtocols[profile.agent].includes(connection.protocol);
    const projectConnection = connections.find((connection) => connection.id === preferences?.connectionId);
    let selected: string | null, source: string;
    if (profile.connectionId !== undefined) {
      selected = profile.connectionId;
      source = '模板指定';
    } else if (projectConnection && compatible(projectConnection)) {
      selected = projectConnection.id;
      source = '项目默认';
    } else {
      if (preferences?.connectionId)
        checks.push({
          id: 'terminal-project-connection',
          title: '项目连接',
          status: 'review',
          detail: '项目连接已删除或与当前 CLI 不兼容，当前沿用应用连接或环境变量。请核对项目默认。',
          action: { kind: 'terminal-project' },
        });
      selected = apps.entries.find((app) => app.id === profile.agent)?.connectionId ?? null;
      source = '应用默认';
    }
    const connection = connections.find((item) => item.id === selected);
    if (selected && !connection)
      checks.push({
        id: 'terminal-binding',
        title: '终端 API 连接',
        status: 'missing',
        detail: `${source}引用的连接已不存在，请选择其他连接。`,
        action: { kind: 'terminal-connections' },
      });
    else if (connection) {
      checks.push({
        id: 'terminal-binding',
        title: '终端 API 连接',
        status: compatible(connection) ? 'recorded' : 'review',
        detail: `${source}：${connection.name} · ${connection.model}。${compatible(connection) ? '绑定记录存在；凭据未读取。' : '连接协议与当前 CLI 不兼容，请重新选择。'}`,
        action: { kind: 'terminal-connections', targetId: connection.id },
      });
      const health = metadata(
        store,
        `surface:terminal:control:health:${connection.id}`,
        TerminalConnectionHealth,
      );
      const check = health?.check;
      const current = check?.connectionId === connection.id && check.revision === connection.revision;
      checks.push({
        id: 'terminal-verification',
        title: '终端 API 验证记录',
        status:
          current && check.status === 'passed'
            ? 'recorded'
            : current && check.status === 'failed'
              ? 'review'
              : 'unknown',
        detail:
          current && check.status === 'passed'
            ? `连接版本 ${connection.revision} 有历史 API 通过记录；当前认证与网络未检测。`
            : current && check.status === 'failed'
              ? '此版本最近一次 API 检查未通过，请在终端管理中查看并明确重试。'
              : '此版本没有 API 通过记录。可在终端管理中明确检查连接，可能发起外部请求。',
        action: { kind: 'terminal-connections', targetId: connection.id },
      });
    } else
      checks.push({
        id: 'terminal-binding',
        title: '终端凭据来源',
        status: 'unknown',
        detail: '当前模板沿用环境变量，未读取变量或宿主登录。请在终端管理中核对模板所需配置。',
        action: { kind: 'terminal-templates', targetId: profile.id },
      });
  }
  checks.push({
    id: 'terminal-environment',
    title: 'Docker、镜像与 CLI',
    status: 'unknown',
    detail:
      '本次未启动进程、容器或安装任务。请在终端管理中明确检查运行环境；API 连接验证与本地环境检查分别进行。',
    action: { kind: 'terminal-apps' },
  });
  return checks;
}

/**
 * 只读汇总本机已登记配置，区分缺失、需复核和未知状态；不启动进程或发外部认证请求。 无法解析部分配置时增加明确的 review 项，不能用静态记录声称 Docker/API 已真实可用。
 * EN: Summarizes registered local configuration as missing, needing review or unknown without spawning processes or external authentication calls. Unreadable configuration adds review items; static records cannot prove Docker or APIs are operational.
 */
export function readinessSnapshot(
  store: Store,
  surface: WorkspaceSurface,
  projectId?: string,
): ReadinessSnapshot {
  const projects = store.all<Project>('projects'),
    project = projects.find((item) => item.id === projectId);
  const active = projects.filter((item) => !item.archived);
  const checks: ReadinessCheck[] = [
    {
      id: 'service',
      title: '本机服务',
      status: 'recorded',
      detail: `已读取 ${surface === 'native' ? 'Elysia 原生' : 'Agent 终端'}入口的本机配置 · v${VERSION}。两个入口的模型连接与项目记录分别维护。`,
    },
  ];
  if (projectId && !project)
    checks.push({
      id: 'project',
      title: '当前项目',
      status: 'missing',
      detail: '当前项目记录已不存在，请重新选择或打开项目。',
      action: { kind: 'projects' },
    });
  else if (project)
    checks.push({
      id: 'project',
      title: label(project.name),
      status: project.archived ? 'review' : 'recorded',
      detail: project.archived
        ? '项目已归档。需恢复归档后才能创建任务。'
        : '项目记录已登记。目录、Git 基线和本次任务权限仍在创建任务时核对。',
      action: { kind: 'projects', targetId: project.id },
    });
  else
    checks.push({
      id: 'project',
      title: '项目',
      status: surface === 'native' ? 'optional' : 'missing',
      detail:
        surface === 'native'
          ? '独立对话无需项目。需要处理本地文件时，再打开项目并确认目录。'
          : `终端任务需要项目。${active.length ? `已有 ${active.length} 个未归档项目，请选择一个。` : '请先打开本地项目。'}`,
      action: { kind: active.length ? 'projects' : 'new-project' },
    });
  try {
    checks.push(...(surface === 'native' ? nativeChecks(store) : terminalChecks(store, project)));
  } catch {
    checks.push({
      id: 'configuration-unreadable',
      title: '配置记录',
      status: 'review',
      detail: '部分配置记录无法解析，本次未判定为可用。请打开对应设置核对，原始记录保持。',
      action: { kind: surface === 'native' ? 'models' : 'terminal-apps' },
    });
  }
  return ReadinessSnapshot.parse({
    version: 1,
    appVersion: VERSION,
    surface,
    checkedAt: new Date().toISOString(),
    projectId: projectId ?? null,
    checks,
  });
}

/**
 * 注册就绪查询路由；可选项目 ID 必须通过格式校验。
 * EN: Registers readiness reads and validates any optional project ID.
 */
export function registerReadiness(app: FastifyInstance, store: Store, surface: WorkspaceSurface) {
  app.get('/api/readiness', (request) => {
    const query = z.object({ projectId: z.string().uuid().optional() }).strict().parse(request.query);
    return readinessSnapshot(store, surface, query.projectId);
  });
}
