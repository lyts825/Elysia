/**
 * Web 界面的入口：挂载应用并引入全局样式。
 * EN: The Web entry mounts the application and imports global styles.
 *
 * 装配双入口界面、导航、请求协调器、草稿同步与实时事件流。异步结果以请求序号、实体和导航代次核对归属；具体领域面板与缓存实现分别委托给独立模块。
 * EN: Assemble dual surfaces, navigation, request coordination, draft synchronization, and event streams. Check async ownership by request, entity, and navigation epoch, delegating domain panels and cache mechanics to modules.
 */
import { ToolReviewPanel } from './ToolReviewPanel';
import React, { Activity, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';
import './motion.css';
import {
  ApiError,
  canRetryConnection,
  localSurface,
  surfaceLocation,
  createSurfaceClient,
  defaultSurfaceClient,
  type SurfaceClient,
} from './api';
import { SurfaceClientContext, SurfaceRootContext, useSurfaceClient } from './SurfaceClientContext';
import { SurfaceSwitcher } from './SurfaceSwitcher';
import { deferredPanel } from './DeferredPanel';
import {
  ProjectPlanNavigationGuard,
  type ProjectPlanNavigationLifecycle,
  type PendingProjectPlanLeave,
} from './ProjectPlanNavigation';
const RunModal = deferredPanel(
  () => import('./PersistentRunSetup').then((m) => m.PersistentRunSetup),
  '任务设置',
);
const RunHandoff = deferredPanel(() => import('./RunHandoff').then((m) => m.RunHandoff), '任务交接');
const SourceSummary = deferredPanel(() => import('./RunHandoff').then((m) => m.SourceSummary), '来源摘要');
const RunRevisionLinks = deferredPanel(
  () => import('./RunRevisionLinks').then((m) => m.RunRevisionLinks),
  '修订关系',
);
const DeliveryReview = deferredPanel(
  () => import('./DeliveryReview').then((m) => m.DeliveryReview),
  '交付验收',
);
const DeliveryStatusCard = deferredPanel(
  () => import('./DeliveryStatusCard').then((m) => m.DeliveryStatusCard),
  '复核状态',
);
const PreviewPanel = deferredPanel(() => import('./PreviewPanel').then((m) => m.PreviewPanel), '预览');
const PreviewDock = deferredPanel(() => import('./PreviewDock').then((m) => m.PreviewDock), '预览分屏');
const ProjectFiles = deferredPanel(() => import('./ProjectFiles').then((m) => m.ProjectFiles), '项目文件');
const MarkdownDocument = deferredPanel(
  () => import('./MarkdownDocument').then((m) => m.MarkdownDocument),
  '正文',
);
import { manageUsage } from './desktop';
import {
  VERSION,
  minimumContextWindowTokens,
  terminalResourceRequirement,
  SurfaceTerminalSettings,
  type TerminalControlOverview,
  type TerminalProjectPreferences,
} from '../../../packages/contracts/src/index';
const TerminalRecovery = deferredPanel(
  () => import('./TerminalRecovery').then((m) => m.TerminalRecovery),
  '终端恢复',
);
const TerminalContinuation = deferredPanel(
  () => import('./TerminalContinuation').then((m) => m.TerminalContinuation),
  '终端续接',
);
const TerminalCommunication = deferredPanel(
  () => import('./TerminalCommunication').then((m) => m.TerminalCommunication),
  '终端通信',
);
const NativeInboxReceipts = deferredPanel(
  () => import('./NativeInboxReceipts').then((m) => m.NativeInboxReceipts),
  '补充消息状态',
);
const BackgroundJobs = deferredPanel(
  () => import('./BackgroundJobs').then((m) => m.BackgroundJobs),
  '后台作业',
);
import {
  readTerminalCommunicationDraft,
  readTerminalResolutionDraft,
} from '../../../packages/contracts/src/terminal-communication';
import { readContinuationDraft } from './ContinuationDraft';
import {
  inspectReplyReceipt,
  matchesReplyReceipt,
  readReplyReceipt,
  replyReceiptPayload,
  type ReplyReceipt,
} from './ReplyReceipt';
import { RecordHistory } from './RecordHistory';
import { taskCenterDestination, type TaskCenterTarget } from './TaskCenterNavigation';
import type { RecordPage, RunUsageSummary, RunListItem } from '../../../packages/contracts/src/run-reads';
import type {
  ExecutorRuntimeSnapshot,
  TerminalRuntimeSnapshot,
} from '../../../packages/contracts/src/terminal-runtime';
const TerminalRuntimePanel = deferredPanel(
  () => import('./TerminalRuntimePanel').then((m) => m.TerminalRuntimePanel),
  '运行状态',
);
const ProviderSettings = React.lazy(() =>
  import('./ProviderSettings').then((module) => ({ default: module.ProviderSettings })),
);
const TerminalControlCenter = React.lazy(() =>
  import('./TerminalControlCenter').then((module) => ({ default: module.TerminalControlCenter })),
);
const StartupSettings = React.lazy(() =>
  import('./StartupSettings').then((module) => ({ default: module.StartupSettings })),
);
const LocalAgentSettings = deferredPanel(
  () => import('./LocalAgentSettings').then((module) => module.LocalAgentSettings),
  '本机能力',
);
import type {
  Run,
  Task,
  Project,
  ProjectSpace,
  Agent,
  Message,
  Artifact,
  RequestRecord,
  Operation,
  ProviderConfig,
  ContextPolicy,
  ContextProjection,
  ContextSnapshot,
} from '../../../packages/contracts/src/index';
import { Icon } from './Icon';
import { EmptyArtwork } from './Brand';
import { Modal, ModalErrorContext } from './Modal';
import { WorkspaceHome } from './WorkspaceHome';
import { projectBoardKey, readProjectBoardDraft, writeProjectBoardDraft } from './ProjectBoardDraft';
const ProjectWorkbench = deferredPanel(
  () => import('./ProjectWorkbench').then((m) => m.ProjectWorkbench),
  '项目交付工作台',
);
const ProjectItemSetup = deferredPanel(
  () => import('./ProjectItemSetup').then((m) => m.ProjectItemSetup),
  '交付项任务设置',
);
const WorkspaceManager = deferredPanel(
  () => import('./WorkspaceManager').then((m) => m.WorkspaceManager),
  '工作区管理',
);
import { SessionSidebar, type SessionTarget, type SessionUpdateResult } from './SessionSidebar';
import { WorkbenchCache, newDraftKey, runSetupDraftKey, createWorkbenchSnapshot } from './WorkbenchCache';
import { WorkbenchPersistence, WorkbenchSaveStatus, workbenchEntryLabel } from './WorkbenchPersistence';
import { ConversationScroll } from './ConversationScroll';
import { ConversationHistoryState } from './ConversationHistoryState';
const ConversationSearch = React.lazy(() =>
  import('./ConversationSearch').then((module) => ({ default: module.ConversationSearch })),
);
import type { HistoryAnchor } from './HistoryScroll';
import { TaskNotifications } from './TaskNotifications';
import type { TaskCenterState } from './TaskCenter';
import { markStartupStage } from './StartupDiagnostics';
const TaskCenter = React.lazy(() =>
  import('./TaskCenter').then((module) => ({ default: module.TaskCenter })),
);
import {
  earlierMessages,
  retainedRuns,
  runHistoryPageSize,
  runHistoryWindowLimit,
  messageHistoryPageSize,
  messageHistoryWindowLimit,
} from './HistoryWindow';
import { StartupTransition } from './StartupTransition';
import { ToolActivity } from './ToolActivity';
import { RunStream, type LiveReasoning } from './RunStream';
import { ReasoningView, type ReasoningReadings } from './ReasoningView';
import type { ReasoningDelta } from '../../../packages/contracts/src/reasoning';
import { ReadCoordinator } from './ReadCoordinator';
import { bindReadingCheckpointScope } from './ReadingCheckpoint';
import { conversationMessages, isInboxUserMessage } from './MessageTimeline';
import { conversationCallKey, conversationIndex } from './ConversationIndex';
import {
  initialNavigation,
  navigationKey,
  readNavigation,
  resolveNavigation,
  writeNavigation,
  type NavigationState,
} from './NavigationState';
import { defaultChoice, type ModelChoice } from './ModelPicker';
import { modelSwitchReason, modelTaskCanContinue, taskResumeReason } from './ModelSwitchGuards';
const ModelSwitchModal = deferredPanel(
  () => import('./ModelSwitchModal').then((m) => m.ModelSwitchModal),
  '模型选择',
);
import { ComposerModelControl } from './ComposerModelControl';
import { useContextPreview } from './useContextPreview';
import { PlanAlignmentLoader } from './PlanAlignmentLoader';
const ContextMeter = deferredPanel(() => import('./ContextWindow').then((m) => m.ContextMeter), '上下文');
const ContextOverview = deferredPanel(
  () => import('./ContextWindow').then((m) => m.ContextOverview),
  '上下文',
);
const ContextWindowModal = deferredPanel(
  () => import('./ContextWindow').then((m) => m.ContextWindowModal),
  '上下文设置',
);
const NewContextWindowModal = deferredPanel(
  () => import('./ContextWindow').then((m) => m.NewContextWindowModal),
  '上下文设置',
);
const ReadinessPanel = deferredPanel(
  () => import('./ReadinessPanel').then((m) => m.ReadinessPanel),
  '首次使用检查',
);
import { contextPolicyLabel } from './ContextLabel';
import { validContextPolicy } from './ContextPolicyEditor';
const TaskGraph = deferredPanel(() => import('./TaskGraph').then((m) => m.TaskGraph), '任务图');
const PeerReviewPanel = deferredPanel(
  () => import('./PeerReviewPanel').then((m) => m.PeerReviewPanel),
  '模型评审',
);
const TaskRecovery = deferredPanel(() => import('./TaskRecovery').then((m) => m.TaskRecovery), '分支恢复');
import { agentOrder } from './agentOrder';
import {
  archiveFeedback,
  currentQuestions,
  currentQuestionsReadNotice,
  getRunFeedback,
  rateWaitText,
} from './RunFeedback';
import { detailReadReason, type DetailReadState } from './DetailReadState';
import { DetailReadNotice } from './DetailReadNotice';
import type { RunCurrentQuestions, RunStopCurrentResult } from '../../../packages/contracts/src/run-reads';
import { ContractModal } from './ContractModal';
import { MotionContent, MotionTabs, Presence, usePositionMotion } from './Motion';
import { useDrawerFocus, useViewportMatch } from './ResponsiveLayout';
type Detail = DetailReadState & {
  run: Run;
  tasks: Task[];
  agents: Agent[];
  taskPage?: { total: number; limit: number; after: string | null; nextCursor: string | null };
  messages: Message[];
  messagePage?: {
    hasMore: boolean;
    nextBefore: string | null;
    before: string | null;
    limit: number;
    anchorMessageId?: string;
    hasNewer?: boolean;
  };
  artifacts: Artifact[];
  requests: RequestRecord[];
  operations: Operation[];
  events: any[];
  currentQuestions?: RunCurrentQuestions;
  edges: { taskId: string; dependencyId: string }[];
  contexts: ContextProjection[];
  usageSummary?: RunUsageSummary;
  recordCounts?: { requests: number; operations: number; artifacts: number };
  recordsLimited?: boolean;
  summaryDeferred?: boolean;
  eventCursor?: number;
  recordVersions?: { requests: string; operations: string; artifacts: string };
  terminalRuntime?: { executor: ExecutorRuntimeSnapshot; terminal: TerminalRuntimeSnapshot };
};
type Provider = ProviderConfig & { keyConfigured: boolean };
type HistoryPosition = { runId: string; before: string; trail: string[]; around?: string };
type ArtifactView = Artifact;
type ReadSource = 'session' | 'lists' | 'detail' | 'configuration';
type ReadIssue = { message: string; retryable: boolean; reopen: boolean; request: number; runId?: string };
/**
 * 将读取错误转换为界面可消费的状态。request 用于防止旧错误清除新请求的失败，runId
 * 将详情错误绑定到所属运行；认证和来源校验错误额外提示重新打开应用。
 * EN: Convert read failures to UI state. request prevents an older error/success clearing newer failure; runId binds detail errors to their run. Authentication/origin failures additionally ask the user to reopen the app.
 */
function readIssueFor(error: unknown, request: number, runId?: string): ReadIssue {
  return {
    message: error instanceof Error ? error.message : '无法读取本机服务，请重试。',
    retryable: canRetryConnection(error),
    reopen:
      error instanceof ApiError &&
      (error.status === 401 ||
        error.status === 403 ||
        ['SESSION_REQUIRED', 'BOOTSTRAP_EXPIRED', 'HOST_DENIED', 'ORIGIN_DENIED', 'ORIGIN_REQUIRED'].includes(
          error.code || '',
        )),
    request,
    runId,
  };
}
const statuses: Record<string, string> = {
  DRAFT: '待开始',
  READY: '就绪',
  RUNNING: '执行中',
  WAITING: '等待',
  VERIFYING: '待验收',
  DONE: '已完成',
  FAILED: '失败',
  CANCELLED: '已取消',
};
const reasons: Record<string, string> = {
  subscription_limit: 'ChatGPT 订阅额度受限，请在模型设置中管理用量',
  plan: '等待接受计划',
  user: '等待你的回答',
  children: '等待子任务',
  paused: '已暂停',
  interrupted: '服务中断，等待恢复',
  verification: '副作用待核验',
  limit: '达到运行上限',
  peer_review_limit: '评审轮次已用完，查看意见并新建任务继续',
  rate_limit: '等待账号额度',
  background_job: '后台命令执行中',
  dependency_failed: '依赖分支失败或已取消，等待局部恢复',
  no_progress: '相同工具错误重复发生，已暂停此代理',
};
/**
 * 把执行状态映射为中文标签和对应 CSS 类；未知状态保留原值，便于识别新增或异常状态。
 * EN: Map execution status to a localized label and CSS class, retaining unknown values to make new or unexpected states visible.
 */
function Badge({ status }: { status: string }) {
  return (
    <span className={'badge ' + status.toLowerCase()}>
      <i />
      {statuses[status] || status}
    </span>
  );
}
/**
 * 一个原生或终端入口的完整工作台。客户端由 Context 固定，导航、草稿、分页与流状态
 * 均属于该入口；外层 Activity 隐藏入口时保留 React 状态，读取 effect 会停止并在返回后恢复。
 * 服务端实体通过请求序号和导航 epoch 防止迟到覆盖，草稿则通过 WorkbenchCache 独立持久化。
 * EN: Own one native or terminal workbench under a Context-fixed client. Navigation/drafts/pages/streams stay surface-local. Activity retains hidden React state while effects stop and resume. Request sequence/navigation epoch reject late entity snapshots; WorkbenchCache persists drafts independently.
 */
function App({
  changeSurface,
  registerCache,
  registerSession,
  notificationTarget,
}: {
  changeSurface: (surface: 'native' | 'terminal') => void;
  registerCache: (
    surface: 'native' | 'terminal',
    cache: WorkbenchCache,
    reading: ConversationHistoryState,
  ) => void;
  registerSession: (surface: 'native' | 'terminal') => void;
  notificationTarget?: { taskId: string; sequence: number };
}) {
  const client = useSurfaceClient();
  const { api, apiUrl, mutation, initializeSession, surface: localSurface } = client;
  /**
   * 客户端固定绑定原生或终端入口，所有后续读取和写入沿用该入口。
   * EN: The client is permanently bound to native or terminal; later reads/writes keep that scope.
   */
  const terminalSurface = localSurface === 'terminal';
  const [ready, setReady] = useState(false),
    [error, setError] = useState(''),
    [readIssues, setReadIssues] = useState<Partial<Record<ReadSource, ReadIssue>>>({}),
    [retrying, setRetrying] = useState(false),
    [busy, setBusy] = useState(false),
    [projects, setProjects] = useState<Project[]>([]),
    [spaces, setSpaces] = useState<ProjectSpace[]>([]),
    [runs, setRuns] = useState<RunListItem[]>([]),
    [providers, setProviders] = useState<Provider[]>([]),
    [terminalSettings, setTerminalSettings] = useState<SurfaceTerminalSettings | null>(null),
    [terminalControl, setTerminalControl] = useState<TerminalControlOverview | null>(null),
    [terminalPreferences, setTerminalPreferences] = useState<{
      projectId: string;
      value: TerminalProjectPreferences;
    } | null>(null),
    [sessionInitializing, setSessionInitializing] = useState(true),
    [detail, setDetail] = useState<Detail | null>(null),
    [tab, setTab] = useState('tasks'),
    [previewOpen, setPreviewOpen] = useState(false),
    [previewTaskId, setPreviewTaskId] = useState(''),
    [modal, setModalState] = useState(''),
    [artifactView, setArtifactView] = useState<ArtifactView | null>(null),
    [streaming, setStreaming] = useState<Record<string, string>>({});
  const agentPagePosition = useRef<{ runId: string; after: string; trail: string[] }>({
    runId: '',
    after: '',
    trail: [],
  });
  const [agentPaging, setAgentPaging] = useState(false);
  const [streamingReasoning, setStreamingReasoning] = useState<Record<string, LiveReasoning>>({});
  const [cacheState, setCacheState] = useState(createWorkbenchSnapshot);
  const [settingsTarget, setSettingsTarget] = useState<{
    providerId?: string;
    connectionId?: string;
    profileId?: string;
    terminalTab?: 'apps' | 'connections' | 'project' | 'templates';
  }>();
  const [settingsEpoch, setSettingsEpoch] = useState(0);
  const settingsIntent = useRef<string | undefined>(undefined);
  const [cachePanelOpen, setCachePanelOpen] = useState(false);
  const [cacheFormEpoch, setCacheFormEpoch] = useState(0);
  const cacheStateRef = useRef(cacheState);
  cacheStateRef.current = cacheState;
  const modalCurrent = useRef(modal);
  modalCurrent.current = modal;
  /**
   * 分页位置使用 ref 同步更新，historyPending 只在详情读取成功后提交可见位置；失败可回滚。
   * EN: Update pagination refs synchronously; historyPending commits visible position only after successful detail read and supports rollback.
   */
  const historyPosition = useRef<HistoryPosition>({
    /**
     * 保存分页游标和跳转轨迹；读取失败时可恢复原位置。
     * EN: Retain cursors/navigation trail for restoration after failed reads.
     */
    runId: '',
    before: '',
    trail: [],
  });
  const [historyLoading, setHistoryLoading] = useState(false);
  const historyMoving = useRef(false);
  const historyAppend = useRef(false);
  const historyPending = useRef<
    | {
        target: HistoryPosition;
        prior: HistoryPosition;
        priorAppend: boolean;
        reposition: boolean;
      }
    | undefined
  >(undefined);
  const [historySegment, setHistorySegment] = useState(0);
  const [initialHistoryAnchor, setInitialHistoryAnchor] = useState<HistoryAnchor>();
  const [conversationSearchOpen, setConversationSearchOpen] = useState(false);
  const [taskCenterState, setTaskCenterState] = useState<TaskCenterState>({
    filter: 'attention',
    before: '',
    trail: [],
  });
  const [conversationHistory] = useState(() => new ConversationHistoryState(client));
  const startupMeasured = useRef({ lists: false, messages: false });
  useEffect(() => () => conversationHistory.flush(), [conversationHistory]);
  const fullDetailRequested = useRef(false);
  const summaryDemand = useRef(false);
  const streamCursor = useRef({ runId: '', cursor: 0 });
  const [summaryLoading, setSummaryLoading] = useState(false);
  const detailSnapshot = useRef(detail);
  detailSnapshot.current = detail;
  const [runListPage, setRunListPage] = useState<RecordPage>({
    total: 0,
    limit: runHistoryPageSize,
    before: null,
    hasMore: false,
    nextBefore: null,
  });
  const [runListReadCoverage, setRunListReadCoverage] = useState<{
    complete: boolean;
    unavailable: number;
  }>();
  const [projectCounts, setProjectCounts] = useState<Record<string, number>>();
  const [runListQuery, setRunListQuery] = useState('');
  const [runListArchive, setRunListArchive] = useState<boolean | undefined>(undefined);
  const [runListBusy, setRunListBusy] = useState(false);
  const runListPosition = useRef({
    before: '',
    trail: [] as string[],
    query: '',
    archived: undefined as boolean | undefined,
  });
  const runListMoving = useRef(false);
  const runListWindow = useRef({ filter: '', before: '', rows: [] as RunListItem[] });
  const runListAppend = useRef(false);
  const [runWindowCount, setRunWindowCount] = useState(0);
  const runListFullSummary = useRef(false);
  const lastListFilter = useRef({ query: '', archived: undefined as boolean | undefined });
  const [previewFileTarget, setPreviewFileTarget] = useState<{
    taskId: string;
    path: string;
    anchor?: string;
    requestId: string;
  }>();
  /**
   * 将消息、请求和工具操作先建立配对索引，再隐藏已并入模型回复的独立工具回执。
   * EN: Index messages/requests/operations first, then hide receipts embedded into model replies.
   */
  const messageIndex = useMemo(
    () => conversationIndex(detail),
    [detail?.messages, detail?.requests, detail?.agents, detail?.tasks, detail?.operations],
  );
  const visibleMessages = useMemo(
    () =>
      conversationMessages(detail?.messages || []).filter(
        (message) => message.role !== 'tool' || !messageIndex.boundResponses.has(message.id),
      ),
    [detail?.messages, messageIndex],
  );
  /**
   * 终端日志产物的运行归属只在具备读取权限时传给预览，避免跨任务链接扩大访问范围。
   * EN: Provide terminal-log run identity to preview only with read eligibility, avoiding cross-task permission expansion.
   */
  const logContexts = useMemo(
    () =>
      Object.fromEntries(
        !detail?.run.contract.permissionProfile.read
          ? []
          : (detail?.operations || []).flatMap((operation) => {
              const result = operation.result as { transcriptArtifactId?: string } | undefined;
              return operation.name === 'terminal_agent' && result?.transcriptArtifactId
                ? [[result.transcriptArtifactId, { runId: operation.runId, taskId: operation.taskId }]]
                : [];
            }),
      ),
    [detail?.operations, detail?.run.contract.permissionProfile.read],
  );
  /**
   * 将文件链接拆成路径与锚点；每次生成新请求 ID，使重复点击同一链接也能重新定位。
   * EN: Split links into path/anchor and create fresh request ID so repeated clicks can locate again.
   */
  const openPreviewFile = useCallback((taskId: string, target: string) => {
    const hash = target.indexOf('#');
    const path = hash < 0 ? target : target.slice(0, hash);
    if (!path) return;
    setPreviewTaskId(taskId);
    setPreviewFileTarget({
      taskId,
      path,
      anchor: hash < 0 ? undefined : target.slice(hash + 1),
      requestId: crypto.randomUUID(),
    });
    setArtifactView(null);
    setPreviewOpen(true);
  }, []);
  const previewFileLinks = useMemo(
    () =>
      new Map(
        (detail?.tasks || []).map((task) => [task.id, (path: string) => openPreviewFile(task.id, path)]),
      ),
    [detail?.tasks, openPreviewFile],
  );
  const [cache] = useState(() => {
    const instance = new WorkbenchCache(setCacheState, client);
    registerCache(localSurface, instance, conversationHistory);
    return instance;
  });
  const [selection, setSelection] = useState(initialNavigation);
  const { spaceId, projectId, runId } = selection;
  const draftKey = newDraftKey(projectId);
  const draft =
    typeof cacheState.entries[draftKey]?.value === 'string'
      ? (cacheState.entries[draftKey].value as string)
      : '';
  /**
   * 首次编辑即固定当前导航，避免异步恢复的上次选择覆盖用户正在输入的新草稿。
   * EN: First editing fixes current navigation so late restored selection cannot replace a new draft.
   */
  const setDraft = (value: string) => {
    if (!navigationInitialized.current) {
      navigationInitialized.current = true;
      savedNavigation.current = undefined;
      navigationEpoch.current++;
      writeNavigation(navigationStorageKey.current, navigation.current);
    }
    cache.set(draftKey, value);
  };
  const [homeModels, setHomeModels] = useState<Record<string, ModelChoice>>({});
  const homeModel = homeModels[draftKey] || defaultChoice(providers);
  const homeProvider = providers.find((provider) => provider.id === homeModel.providerId);
  /**
   * 型号和连接修订共同构成校验身份；连接更新后不能沿用旧选择的“已就绪”结果。
   * EN: Model plus connection revision form validation identity; updates invalidate old ready status.
   */
  const homeModelKey = JSON.stringify([
    draftKey,
    homeModel.providerId,
    homeModel.model,
    homeModel.reasoningEffort,
    homeProvider?.revision,
    homeProvider?.checkedRevision,
    homeProvider?.keyConfigured,
  ]);
  const [homeModelReady, setHomeModelReady] = useState({ key: '', valid: false });
  /**
   * 按当前输入草稿键保存首页模型选择，切换项目后保留各自配置而不互相覆盖。
   * EN: Save the home model choice under the current draft key so project-specific selections remain independent.
   */
  const changeHomeModel = (choice: ModelChoice) =>
    setHomeModels((previous) => ({ ...previous, [draftKey]: choice }));
  const updateHomeModelReady = useCallback(
    (valid: boolean) =>
      setHomeModelReady((previous) =>
        previous.key === homeModelKey && previous.valid === valid ? previous : { key: homeModelKey, valid },
      ),
    [homeModelKey],
  );
  const homeModelValid = homeModelReady.key === homeModelKey && homeModelReady.valid;
  const profileSelectionKey = `settings:selected-terminal-profile:${projectId || 'home'}`;
  const terminalProfileId = cacheState.entries[profileSelectionKey]?.value;
  const projectPreferences = terminalPreferences?.projectId === projectId ? terminalPreferences.value : null;
  const terminalProfiles =
    terminalSettings?.profiles.filter(
      (profile) =>
        !terminalControl ||
        terminalControl.apps.entries.some((entry) => entry.id === profile.agent && entry.visible),
    ) || [];
  /**
   * 选择优先级为当前草稿、项目默认、全局默认、默认应用、首个可见配置。
   * EN: Choice priority is current draft, project defaults, global defaults, default app, then first visible profile.
   */
  const chosenTerminalProfile =
    terminalProfiles.find((profile) => profile.id === terminalProfileId) ||
    terminalProfiles.find((profile) => profile.id === projectPreferences?.defaultProfileId) ||
    terminalProfiles.find((profile) => profile.id === terminalSettings?.defaultProfileId) ||
    terminalProfiles.find((profile) => profile.agent === terminalControl?.apps.defaultAppId) ||
    terminalProfiles[0];
  const inheritedConnection = terminalControl?.connections.find(
    (connection) => connection.id === projectPreferences?.connectionId,
  );
  /**
   * 项目继承连接只有协议与所选终端应用兼容时才覆盖配置本身的连接。
   * EN: Inherited project connection overrides profile connection only when protocol matches selected terminal app.
   */
  const compatibleProjectConnection =
    inheritedConnection &&
    terminalControl?.catalog
      .find((entry) => entry.id === chosenTerminalProfile?.agent)
      ?.protocols.includes(inheritedConnection.protocol);
  const terminalProfile = chosenTerminalProfile
    ? {
        ...chosenTerminalProfile,
        ...(compatibleProjectConnection ? { connectionId: inheritedConnection!.id } : {}),
      }
    : undefined;
  const [homeContexts, setHomeContexts] = useState<Record<string, ContextPolicy>>({});
  const homeContext = homeContexts[draftKey] || { mode: 'managed' as const };
  const homeContextValid = validContextPolicy(
    homeContext,
    homeProvider ? minimumContextWindowTokens(homeProvider) : 4096,
    homeProvider?.contextLimit || 4096,
  );
  const readSource: ReadSource | undefined =
    readIssues.detail?.runId === runId
      ? 'detail'
      : readIssues.lists
        ? 'lists'
        : readIssues.configuration
          ? 'configuration'
          : readIssues.session
            ? 'session'
            : undefined;
  const readIssue = readSource ? readIssues[readSource] : undefined;
  const project = projects.find((p) => p.id === projectId);
  const runSetupKey = runSetupDraftKey(projectId);
  const isChat = detail?.run.kind === 'chat';
  const archived = !!detail?.run.archived || !!project?.archived;
  const legacyTerminal = !terminalSurface && detail?.run.execution?.kind === 'docker-agent';
  const detailReadOnlyReason = detailReadReason(detail);
  const runReadOnly = archived || legacyTerminal || !!detailReadOnlyReason;
  const [retryingDetailRun, setRetryingDetailRun] = useState('');
  const detailRetryRun = useRef('');
  const [feedbackTime, setFeedbackTime] = useState(Date.now);
  const hasRateWait =
    !!detail &&
    !archived &&
    (['READY', 'RUNNING'].includes(detail.run.status) || detail.run.reason === 'rate_limit') &&
    (detail.run.reason === 'rate_limit' ||
      detail.tasks.some((task) => task.status === 'WAITING' && task.waitReason === 'rate_limit'));
  useEffect(() => {
    if (!hasRateWait || archived) return;
    setFeedbackTime(Date.now());
    const timer = window.setInterval(() => setFeedbackTime(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [runId, hasRateWait, archived]);
  const feedback = detail
    ? getRunFeedback(detail, archived, hasRateWait ? feedbackTime : Date.now())
    : undefined;
  const questions = detail && !terminalSurface && !legacyTerminal ? currentQuestions(detail) : [];
  const questionNotice =
    detail && !terminalSurface && !legacyTerminal ? currentQuestionsReadNotice(detail) : '';
  const resumeTask = detail?.tasks.find((task) => task.id === feedback?.resumeTaskId);
  const taskDetailRefs = useRef(new Map<string, HTMLDivElement>());
  const pendingTaskFocus = useRef<string | undefined>(undefined);
  const resumeTaskReason = legacyTerminal
    ? '旧终端记录仅供查看。'
    : detail && resumeTask
      ? taskResumeReason(detail, archived, resumeTask.id)
      : '';
  const planRef = useRef<HTMLDivElement>(null);
  const questionRef = useRef<HTMLDivElement>(null);
  const runStatusRef = useRef<HTMLDivElement>(null);
  const terminalReviewRef = useRef<HTMLDivElement>(null);
  const terminalRecoveryRefs = useRef(new Map<string, HTMLDivElement>());
  const [taskCenterTarget, setTaskCenterTarget] = useState<{
    id: string;
    category: TaskCenterTarget;
    epoch: number;
    afterRequest: number;
  }>();
  const notificationSequence = useRef(0);
  const replyRef = useRef<HTMLTextAreaElement>(null);
  const [assignmentDrafts, setAssignmentDrafts] = useState<
    Record<string, Record<string, ModelChoice & { contextPolicy?: ContextPolicy }>>
  >({});
  const assignmentKey = detail?.run.plan ? `${detail.run.id}:${detail.run.plan.version}` : '';
  const assignments = assignmentDrafts[assignmentKey] || {};
  const [assignmentReady, setAssignmentReady] = useState<Record<string, boolean>>({});
  const decisionOperation = modal.startsWith('decision:')
    ? detail?.operations.find((operation) => operation.id === modal.slice(9))
    : undefined;
  const switchAgent = modal.startsWith('model:')
    ? detail?.agents.find((agent) => agent.id === modal.slice(6))
    : undefined;
  const switchTask = detail?.tasks.find((task) => task.id === switchAgent?.taskId);
  const rootAgent = detail?.agents.find((agent) => agent.taskId === detail.run.rootTaskId);
  const liveContext = useContextPreview(
    client,
    runId,
    rootAgent,
    ready && !!detail && !detailReadOnlyReason && detail.run.execution?.kind !== 'docker-agent',
  );
  const [contextSnapshot, setContextSnapshot] = useState<ContextSnapshot>();
  const [contextReading, setContextReading] = useState(false);
  const contextReadController = useRef<AbortController | undefined>(undefined);
  const contextReadAgent = modal.startsWith('context:')
    ? contextSnapshot?.runId === runId
      ? contextSnapshot.agents.find((item) => item.agentId === modal.slice(8))
      : undefined
    : undefined;
  /**
   * 上下文设置是读取时快照；运行或代理版本前进后仍可查看，但不可按旧快照直接保存。
   * EN: Context settings are a read-time snapshot; newer run/agent revisions may be viewed but not saved through the old snapshot.
   */
  const contextReadStale =
    !!contextReadAgent &&
    !!contextSnapshot &&
    !!detail &&
    (detail.run.revision > contextSnapshot.runRevision ||
      (detail.agents.find((agent) => agent.id === contextReadAgent.agentId)?.revision || 0) >
        contextReadAgent.agentRevision);
  const contextAgent =
    contextReadAgent && (contextReadStale || detailReadOnlyReason)
      ? {
          ...contextReadAgent,
          safeToConfigure: false,
          configureReason: detailReadOnlyReason || '会话已更新，请重新读取上下文设置。',
        }
      : contextReadAgent;
  useEffect(() => () => contextReadController.current?.abort(), [runId]);
  useEffect(() => {
    if (!modal.startsWith('context:')) contextReadController.current?.abort();
  }, [modal]);
  const rootModelReason = legacyTerminal
    ? '旧终端记录仅供查看。'
    : detail && rootAgent
      ? modelSwitchReason(detail, archived, rootAgent.taskId)
      : '模型正在准备中。';
  /**
   * 汇总副作用核验的只读原因；只有未结束、未归档且仍 UNCERTAIN 的操作可提交。
   * EN: Collect verification read-only reasons; submit only for non-ended/non-archived runs with an operation still UNCERTAIN.
   */
  const decisionDisabledReason = (operation: Operation) => {
    if (detailReadOnlyReason) return detailReadOnlyReason;
    if (legacyTerminal) return '旧终端记录仅供查看，请在 Agent 终端入口创建新任务。';
    if (archived) return '请先恢复归档记录，再提交核验决定。';
    if (
      ['DONE', 'CANCELLED'].includes(detail?.run.status || '') ||
      ['DONE', 'CANCELLED'].includes(detail?.tasks.find((task) => task.id === operation.taskId)?.status || '')
    )
      return '任务已结束，核验记录仅供查看。';
    if (operation.status !== 'UNCERTAIN') return '该操作已完成核验，无需重复提交。';
    return '';
  };
  /**
   * 以可用连接默认值填充计划建议，保留计划明确指定的型号和推理强度。
   * EN: Fill plan suggestions with usable connection defaults while retaining explicit model/effort choices.
   */
  const proposedChoice = (task: Task['spec']): ModelChoice & { contextPolicy?: ContextPolicy } => {
    const fallback = defaultChoice(providers, task.providerId);
    return {
      ...fallback,
      model: task.model ?? fallback.model,
      reasoningEffort: task.reasoningEffort ?? fallback.reasoningEffort,
    };
  };
  const narrowLayout = useViewportMatch('(max-width: 760px)');
  const compactLayout = useViewportMatch('(max-width: 1180px)');
  const [navigationOpen, setNavigationOpen] = useState(false);
  const [detailsCollapsed, setDetailsCollapsed] = useState(false);
  const [detailsDrawerOpen, setDetailsDrawerOpen] = useState(false);
  /**
   * 打开弹窗时收起两个抽屉；不同设置意图递增 epoch，避免退出动画中的旧表单被复用。
   * EN: Opening settings closes both drawers; each intent advances epoch so exiting retained forms cannot be reused.
   */
  const setModal = (value: string, target?: typeof settingsTarget) => {
    setNavigationOpen(false);
    setDetailsDrawerOpen(false);
    const settings = ['settings', 'run-settings', 'handoff-settings', 'project-item-run-settings'].includes(
      value,
    );
    /**
     * 新打开不能复用仍为退出动画挂载的设置。
     * EN: A fresh opening must not reuse settings still mounted for the exit animation.
     */
    if (settings && settingsIntent.current !== value) setSettingsEpoch((epoch) => epoch + 1);
    settingsIntent.current = settings ? value : undefined;
    setSettingsTarget(target);
    setModalState(value);
  };
  const sidebarRef = useRef<HTMLElement>(null);
  const detailsRef = useRef<HTMLElement>(null);
  const sidebarCollapsed = !narrowLayout && cacheState.entries['collapsed:sidebar']?.value === true;
  const navigationDrawerOpen = narrowLayout && navigationOpen;
  const detailsVisible =
    !!runId && !!detail && !previewOpen && (compactLayout ? detailsDrawerOpen : !detailsCollapsed);
  const detailsOverlayOpen = compactLayout && detailsVisible;
  summaryDemand.current = detailsVisible && ['agents', 'artifacts', 'usage'].includes(tab);
  useDrawerFocus(sidebarRef, navigationDrawerOpen, () => setNavigationOpen(false));
  useDrawerFocus(detailsRef, detailsOverlayOpen, () => setDetailsDrawerOpen(false));
  useEffect(() => {
    setNavigationOpen(false);
    setDetailsDrawerOpen(false);
  }, [narrowLayout, compactLayout, runId]);
  const mainMotion = usePositionMotion<HTMLElement>();
  const activeRunId = useRef('');
  const heldNavigation = useRef<{ runId: string; operationId: string; epoch: number } | undefined>(undefined);
  const detailRequest = useRef(0);
  const detailLoadedRequest = useRef(0);
  const runStream = useRef(new RunStream());
  const reasoningReadings = useRef<ReasoningReadings>(new Map());
  const streamRun = useRef('');
  const [connection, setConnection] = useState('connecting');
  const actionPending = useRef(false);
  const navigation = useRef(initialNavigation);
  const navigationEpoch = useRef(0);
  const navigationStorageKey = useRef<string | undefined>(undefined);
  const savedNavigation = useRef<NavigationState | undefined>(undefined);
  const navigationInitialized = useRef(false);
  const workbenchNavigation = useRef<ProjectPlanNavigationLifecycle | null>(null);
  const [pendingProjectLeave, setPendingProjectLeave] = useState<PendingProjectPlanLeave | null>(null);
  const [projectLeaveGuard] = useState(
    () =>
      new ProjectPlanNavigationGuard(
        () => ({ ...navigation.current, epoch: navigationEpoch.current }),
        () => workbenchNavigation.current,
        setPendingProjectLeave,
      ),
  );
  /**
   * 取消待确认的项目离开流程并打开草稿保存面板，让用户先处理未保存内容。
   * EN: Cancel pending project-leave confirmation and open draft persistence so unsaved content can be handled first.
   */
  const openPersistence = () => {
    projectLeaveGuard.cancel();
    setCachePanelOpen(true);
  };
  const listRequest = useRef(0);
  const listReads = useRef(new ReadCoordinator());
  const detailReads = useRef(new ReadCoordinator());
  const configurationReads = useRef(new ReadCoordinator());
  const configurationRequest = useRef(0);
  const configurationAt = useRef(0);
  const listData = useRef({ projects: [] as Project[], spaces: [] as ProjectSpace[] });
  useEffect(
    () => () => {
      listReads.current.stop();
      detailReads.current.stop();
      configurationReads.current.stop();
    },
    [],
  );
  const listedEntities = useRef({ projects: new Set<string>(), runs: new Set<string>() });
  const sessionReady = useRef(false);
  const connectPending = useRef(false);
  const sessionRequest = useRef(0);
  const replyKey = `draft:run:${runId}`;
  const reply =
    typeof cacheState.entries[replyKey]?.value === 'string'
      ? (cacheState.entries[replyKey].value as string)
      : '';
  /**
   * 新的重规划选择属于此运行与入口，只有匹配的未知发送
   * EN: Fresh replan choices belong to this run and surface. Only a matching unknown
   */
  /**
   * 回执才可在重新打开后恢复，以重试同一命令。
   * EN: send receipt may restore one after reopening, to retry that exact command.
   */
  const [replyIntents, setReplyIntents] = useState<Map<string, { value: 'continue' | 'replan' }>>(
    () => new Map(),
  );
  const replyIntentKey = `${localSurface}:${runId}`;
  const replyChanges = useRef(new Map<string, number>());
  const receiptChanges = useRef(new Map<string, number>());
  const [replyReceiptStatus, setReplyReceiptStatus] = useState(new Map<string, string>());
  const replyReceiptKey = `draft:terminal-send:${runId}`;
  const replyReceiptRead = !terminalSurface
    ? inspectReplyReceipt(cacheState.entries[replyReceiptKey]?.value, runId)
    : { status: 'empty' as const };
  const cachedReplyReceipt = replyReceiptRead.status === 'ready' ? replyReceiptRead.receipt : null;
  const pendingReplyReceipt =
    cachedReplyReceipt?.targetRunId === runId &&
    !cachedReplyReceipt.outcome &&
    cachedReplyReceipt.text === reply &&
    (receiptChanges.current.get(cachedReplyReceipt.commandId) ?? 0) ===
      (replyChanges.current.get(replyIntentKey) ?? 0)
      ? cachedReplyReceipt
      : null;
  /**
   * 未知发送恢复时仅对同一命令恢复原始意图，
   * EN: Restoring an unknown send restores its original intent only for the same
   */
  /**
   * 新草稿仍默认继续。
   * EN: command. A fresh draft still defaults to continue.
   */
  const replyIntent = replyIntents.get(replyIntentKey)?.value ?? pendingReplyReceipt?.intent ?? 'continue';
  /**
   * 递增当前回复意图的编辑计数，异步提交可据此判断发送期间是否出现新输入。
   * EN: Increment the reply-intent change counter so asynchronous submission can detect edits made while sending.
   */
  const markReplyChanged = () =>
    replyChanges.current.set(replyIntentKey, (replyChanges.current.get(replyIntentKey) ?? 0) + 1);
  const canChooseReplyIntent =
    !terminalSurface &&
    detail?.run.kind === 'task' &&
    detail.run.execution?.kind !== 'docker-agent' &&
    detail.run.planMode !== false &&
    !!(detail.run.plan || detail.run.authorized);
  useEffect(() => {
    /**
     * 在页面生命周期事件中请求缓存立即刷出待保存项，复用缓存自身的串行和版本保护。
     * EN: Request a cache flush from page lifecycle events, retaining its serialization and revision protections.
     */
    const flush = () => void cache.flush();
    /**
     * 页面进入隐藏状态时触发最后一次保存，缩小切后台后编辑尚未同步的窗口。
     * EN: Flush pending edits when the document becomes hidden to reduce unsynchronized work on backgrounding.
     */
    const hidden = () => {
      if (document.visibilityState === 'hidden') flush();
    };
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', hidden);
    return () => {
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', hidden);
      /**
       * Activity 隐藏工作区但不卸载状态，保持草稿
       * EN: Activity hides a workspace without unmounting its state. Keep draft
       */
      /**
       * 持久化工作，仅外层最终销毁时停止缓存。
       * EN: persistence alive; only the outer host stops caches on actual teardown.
       */
      void cache.flush();
    };
  }, [cache]);
  const closeArtifact = useCallback(() => {
    setArtifactView(null);
  }, []);
  /**
   * 只清除不晚于指定请求的错误，较新请求的失败不能被旧成功结果抹掉。
   * EN: Clear only failures no newer than the specified request; old success cannot erase later failure.
   */
  const clearReadIssue = useCallback((source: ReadSource, request = Infinity) => {
    setReadIssues((old) => {
      if (!old[source] || old[source]!.request > request) return old;
      const next = { ...old };
      delete next[source];
      return next;
    });
  }, []);
  /**
   * 提交已获准的导航。跨运行时重置详情、预览和流游标，并恢复目标会话的阅读锚点；
   * 显式导航递增 epoch，使所有基于旧选择发出的异步动作失效。
   * EN: Commit allowed navigation. Cross-run changes reset detail/preview/stream cursors and restore target reading anchor. Explicit navigation advances epoch to invalidate async actions from prior selection.
   */
  const commitNavigation = useCallback(
    (next: NavigationState, explicit = false) => {
      if (explicit) {
        setNavigationOpen(false);
        navigationEpoch.current++;
        navigationInitialized.current = true;
        savedNavigation.current = undefined;
      }
      if (navigation.current.runId !== next.runId) {
        agentPagePosition.current = { runId: next.runId, after: '', trail: [] };
        setAgentPaging(false);
        const reading = conversationHistory.get(next.runId);
        const anchor = reading?.following === false ? reading.anchor : undefined;
        historyPosition.current = { runId: next.runId, before: '', trail: [], around: anchor?.id };
        setInitialHistoryAnchor(anchor);
        setConversationSearchOpen(false);
        historyAppend.current = false;
        historyPending.current = undefined;
        historyMoving.current = false;
        fullDetailRequested.current = false;
        streamCursor.current = { runId: next.runId, cursor: 0 };
        setHistoryLoading(false);
        setSummaryLoading(false);
        setHistorySegment(0);
        closeArtifact();
        setDetail(null);
        setPreviewFileTarget(undefined);
        setPreviewOpen(false);
        setReadIssues((old) => {
          if (!old.detail) return old;
          const next = { ...old };
          delete next.detail;
          return next;
        });
      }
      navigation.current = next;
      activeRunId.current = next.runId;
      setSelection(next);
      if (navigationInitialized.current) writeNavigation(navigationStorageKey.current, next);
    },
    [closeArtifact, conversationHistory],
  );
  /**
   * 导航统一经过项目草稿离开门禁。用户显式离开可触发保存/保留确认；列表自动协调选择
   * 则直接提交，并废弃旧项目导航意图，避免恢复结果弹出已失效的离开确认。
   * EN: Route navigation through project-draft leave guards. Explicit departure may require save/preserve confirmation; automatic list reconciliation commits directly and retires old project intents so restoration cannot reopen stale leave dialogs.
   */
  const navigate = useCallback(
    (
      next: NavigationState,
      explicit = false,
      options: {
        intent?: number;
        bypass?: boolean;
        after?: () => void;
        label?: string;
      } = {},
    ) => {
      const current = navigation.current;
      const leaving =
        current.spaceId !== next.spaceId ||
        current.projectId !== next.projectId ||
        current.runId !== next.runId;
      /**
       * 提交已通过离开检查的导航，再执行附带动作；将清理界面等副作用放在真正切换成功之后。
       * EN: Commit navigation after leave checks, then run its continuation so UI cleanup occurs only after an accepted transition.
       */
      const commit = () => {
        commitNavigation(next, explicit);
        options.after?.();
      };
      if (!explicit) {
        if (leaving) {
          projectLeaveGuard.begin();
          workbenchNavigation.current?.discard();
        }
        commit();
        return true;
      }
      return projectLeaveGuard.request(commit, { ...options, leaving });
    },
    [commitNavigation, projectLeaveGuard],
  );
  /**
   * 独立刷新模型或终端配置，普通调用在 60 秒内复用读取时效；force 安排尾随刷新。
   * 各配置并行读取，成功部分及时发布；一个接口失败只产生配置错误，不阻止会话列表使用。
   * EN: Refresh model/terminal configuration independently, reusing ordinary freshness for 60 seconds; force requests a trailing refresh. Parallel reads publish successful parts; one config error does not block session lists.
   */
  const refreshConfiguration = useCallback(
    (force = false) => {
      if (!force && Date.now() - configurationAt.current < 60000) return Promise.resolve(true);
      return configurationReads.current.run(
        'configuration',
        async (signal) => {
          const request = ++configurationRequest.current;
          /**
           * 同时核对取消信号和配置请求序号，阻止前一次配置响应回写当前界面。
           * EN: Check both abort state and configuration request sequence before accepting an asynchronous result.
           */
          const current = () => !signal.aborted && request === configurationRequest.current;
          const result = await Promise.allSettled([
            terminalSurface
              ? Promise.resolve([] as Provider[])
              : api<Provider[]>('/providers', undefined, undefined, signal).then((value) => {
                  if (current()) setProviders(value);
                  return value;
                }),
            terminalSurface
              ? api<SurfaceTerminalSettings>('/terminal/settings', undefined, undefined, signal).then(
                  (value) => {
                    if (current()) setTerminalSettings(value);
                    return value;
                  },
                )
              : Promise.resolve(null),
            terminalSurface
              ? api<TerminalControlOverview>('/terminal/control', undefined, undefined, signal).then(
                  (value) => {
                    if (current()) setTerminalControl(value);
                    return value;
                  },
                )
              : Promise.resolve(null),
          ] as const);
          if (!current()) return false;
          configurationAt.current = Date.now();
          const failure = result.find((entry) => entry.status === 'rejected');
          if (failure?.status === 'rejected')
            setReadIssues((old) => ({ ...old, configuration: readIssueFor(failure.reason, request) }));
          else clearReadIssue('configuration', request);
          return !failure;
        },
        force,
      );
    },
    [terminalSurface, clearReadIssue],
  );
  /**
   * 协调项目、空间和分页会话列表。查询键相同的调用共享请求；保留窗口合并新旧记录，
   * 游标失效时仅在仍属于原导航的情况下回到最新页。显式导航后，迟到列表可更新数据，
   * 但不能再替用户恢复或改变选择。配置读取独立发起，不成为列表成功的前提。
   * EN: Coordinate project/space/paged-run lists with shared reads for equal query keys and bounded retained windows. Reset bad cursor only if still on original navigation. Late lists may update data but cannot restore/change selection after explicit navigation. Config reads are independent of list success.
   */
  const refresh = useCallback(
    async (forceConfiguration = false, trailing = false) => {
      void refreshConfiguration(forceConfiguration);
      const position = runListPosition.current;
      const epoch = navigationEpoch.current;
      const listQuery = new URLSearchParams({ limit: String(runHistoryPageSize) });
      if (!runListFullSummary.current) listQuery.set('summary', 'deferred');
      const filter = JSON.stringify([position.query, position.archived]);
      if (
        runListWindow.current.filter === filter &&
        runListWindow.current.rows.length &&
        (runListWindow.current.before === position.before || runListAppend.current)
      )
        listQuery.set('retained', runListWindow.current.rows.map((row) => row.id).join(','));
      if (position.before) listQuery.set('before', position.before);
      if (position.query) listQuery.set('query', position.query);
      if (position.archived !== undefined) listQuery.set('archived', String(position.archived));
      const selected = savedNavigation.current?.runId || navigation.current.runId;
      if (selected) listQuery.set('includeRunId', selected);
      const pinned = Object.entries(cacheStateRef.current.entries)
        .filter(([key, entry]) => key.startsWith('pinned:run:') && entry.value === true)
        .map(([key]) => key.slice('pinned:run:'.length))
        .slice(0, 40);
      if (pinned.length) listQuery.set('pinned', pinned.join(','));
      const key = listQuery.toString();
      return listReads.current.run(
        key,
        async (signal) => {
          const request = ++listRequest.current;
          type Listing = {
            runs: RunListItem[];
            included: RunListItem[];
            page: RecordPage;
            projectCounts?: Record<string, number>;
            readCoverage?: { complete: boolean; unavailable: number };
            unavailableIds?: string[];
          };
          /**
           * 读取当前列表页；仅在仍有效的请求遇到已失效的记录游标时清除游标和累积窗口，再从首段重读。其他错误继续上抛，避免把普通失败误判为分页过期。
           * EN: Read the list page; when a still-current request encounters an invalidated cursor, reset cursor and retained window and retry from the beginning. Propagate other errors unchanged.
           */
          const readListing = async () => {
            try {
              return await api<Listing>('/runs?' + listQuery.toString(), undefined, undefined, signal);
            } catch (issue) {
              if (
                !signal.aborted &&
                issue instanceof ApiError &&
                issue.code === 'RECORD_CURSOR_MISSING' &&
                position.before &&
                request === listRequest.current &&
                epoch === navigationEpoch.current &&
                runListPosition.current === position
              ) {
                runListPosition.current = { ...position, before: '', trail: [] };
                runListAppend.current = false;
                runListWindow.current = { filter, before: '', rows: [] };
                listQuery.delete('before');
                listQuery.delete('retained');
                return api<Listing>('/runs?' + listQuery.toString(), undefined, undefined, signal);
              }
              throw issue;
            }
          };
          /**
           * 核对列表请求的取消状态与序号，只有最新有效请求可以更新列表状态。
           * EN: Check list-request cancellation and sequence so only the latest active request can update list state.
           */
          const current = () => !signal.aborted && request === listRequest.current;
          /**
           * 先发布成功列表；后续其他接口失败时，保留这些已核验的新记录。
           * EN: Publish successful lists before later endpoint errors, retaining verified records.
           */
          const publishListing = (listing: Listing) => {
            if (!current()) return;
            const window = runListWindow.current;
            const retain =
              window.filter === filter &&
              (window.before === (listing.page.before || '') || runListAppend.current);
            const unavailable = new Set(listing.unavailableIds || []);
            const rows = retainedRuns(
              retain ? window.rows.filter((row) => !unavailable.has(row.id)) : [],
              listing.runs,
              listing.included,
            );
            runListWindow.current = { filter, before: listing.page.before || '', rows };
            const runs = [...new Map([...rows, ...listing.included].map((run) => [run.id, run])).values()];
            setRunListPage(listing.page);
            setRunListReadCoverage(listing.readCoverage);
            setProjectCounts(listing.projectCounts);
            setRunWindowCount(rows.length);
            setRuns(runs);
            listedEntities.current.runs = new Set(runs.map((run) => run.id));
            if (!startupMeasured.current.lists) {
              startupMeasured.current.lists = true;
              markStartupStage('lists-ready', { surface: localSurface, status: 'ok' });
            }
          };
          const [projectResult, listingResult, spaceResult] = await Promise.allSettled([
            /**
             * 互不依赖的列表并行读取；部分失败不会丢弃已成功更新的内容。
             * EN: Read independent lists in parallel and retain successful updates after partial failure.
             */
            api<Project[]>('/projects', undefined, undefined, signal).then((value) => {
              if (current()) {
                listData.current.projects = value;
                setProjects(value);
              }
              return value;
            }),
            readListing().then((value) => {
              publishListing(value);
              return value;
            }),
            api<ProjectSpace[]>('/spaces', undefined, undefined, signal).then((value) => {
              if (current()) {
                listData.current.spaces = value;
                setSpaces(value);
              }
              return value;
            }),
          ] as const);
          if (!current()) return;
          const failure = [projectResult, listingResult, spaceResult].find(
            (entry) => entry.status === 'rejected',
          );
          if (!startupMeasured.current.lists) {
            startupMeasured.current.lists = true;
            markStartupStage('lists-ready', { surface: localSurface, status: failure ? 'error' : 'ok' });
          }
          if (failure?.status === 'rejected')
            setReadIssues((old) => ({ ...old, lists: readIssueFor(failure.reason, request) }));
          else clearReadIssue('lists', request);
          if (listingResult.status === 'rejected') return false;
          const listing = listingResult.value;
          const p = listData.current.projects,
            s = listData.current.spaces;
          const rows = runListWindow.current.rows;
          const r = [...new Map([...rows, ...listing.included].map((run) => [run.id, run])).values()];
          listedEntities.current = {
            projects: new Set(p.map((project) => project.id)),
            runs: new Set(r.map((run) => run.id)),
          };
          if (projectResult.status === 'fulfilled')
            cache.prune(listedEntities.current.projects, listedEntities.current.runs, false);
          /**
           * 只有项目和空间都成功，且期间没有显式导航，才重新协调保存的选择。
           * EN: Reconcile saved selection only after both project/space succeeded and no explicit navigation intervened.
           */
          if (
            epoch !== navigationEpoch.current ||
            projectResult.status === 'rejected' ||
            spaceResult.status === 'rejected'
          )
            return true;
          const restoring = !navigationInitialized.current;
          const next = resolveNavigation(savedNavigation.current || navigation.current, p, r, s, restoring);
          if (!startupMeasured.current.messages && !next.runId) {
            startupMeasured.current.messages = true;
            markStartupStage('messages-ready', { surface: localSurface, status: 'skipped' });
          }
          navigationInitialized.current = true;
          savedNavigation.current = undefined;
          if (restoring && next.runId) {
            const run = r.find((run) => run.id === next.runId)!;
            setPreviewTaskId(run.rootTaskId);
            setTab(run.kind === 'chat' ? 'agents' : 'tasks');
          }
          navigate(next);
          return true;
        },
        trailing || forceConfiguration,
      );
    },
    [navigate, clearReadIssue, cache, refreshConfiguration],
  );
  /**
   * 切换会话列表页；较早页可追加到有界窗口，失败时恢复游标和追加方式。
   * EN: Change run-list page; append older pages within bounds, restoring cursor/append mode on failure.
   */
  async function changeRunList(direction: 'older' | 'newer' | 'latest') {
    /**
     * 乐观更新游标；读取失败时恢复原游标和追加方式。
     * EN: Optimistically change cursor, rolling back cursor/append mode on read failure.
     */
    if (runListMoving.current) return;
    const prior = runListPosition.current;
    const priorAppend = runListAppend.current;
    if (direction === 'older' && !runListPage.nextBefore) return;
    if (direction === 'newer' && !prior.trail.length) return;
    const next =
      direction === 'older'
        ? { ...prior, before: runListPage.nextBefore!, trail: [...prior.trail, prior.before] }
        : direction === 'newer'
          ? { ...prior, before: prior.trail.at(-1)!, trail: prior.trail.slice(0, -1) }
          : { ...prior, before: '', trail: [] };
    runListPosition.current = next;
    runListAppend.current =
      direction === 'older' &&
      !runListFullSummary.current &&
      runListWindow.current.rows.length + runHistoryPageSize <= runHistoryWindowLimit;
    runListMoving.current = true;
    setRunListBusy(true);
    try {
      if ((await refresh()) === false && runListPosition.current === next) {
        runListPosition.current = prior;
        runListAppend.current = priorAppend;
      }
    } finally {
      runListMoving.current = false;
      setRunListBusy(false);
    }
  }
  useEffect(() => {
    if (!ready) return;
    const filter = { query: runListQuery.trim(), archived: runListArchive };
    if (filter.query === lastListFilter.current.query && filter.archived === lastListFilter.current.archived)
      return;
    const timer = setTimeout(() => {
      lastListFilter.current = filter;
      runListAppend.current = false;
      runListPosition.current = {
        before: '',
        trail: [],
        query: runListQuery.trim(),
        archived: runListArchive,
      };
      void refresh();
    }, 300);
    return () => clearTimeout(timer);
  }, [runListQuery, runListArchive, ready, refresh]);
  useEffect(() => {
    if (!modal.startsWith('manage:')) setRunListArchive(undefined);
  }, [modal]);
  useEffect(() => {
    const full = modal.startsWith('manage:');
    if (full && !runListFullSummary.current) {
      runListAppend.current = false;
      runListWindow.current = { filter: '', before: '', rows: [] };
    }
    runListFullSummary.current = full;
    if (ready && runListFullSummary.current) void refresh();
  }, [modal, ready, refresh]);
  /**
   * 读取当前运行的会话详情。参数分别控制尾随刷新、完整统计和不可读投影重试。
   * 请求键包含运行、消息窗口与保留消息；只有活动运行和请求序号仍匹配才发布结果。
   * 合并时保留更高修订的运行状态，事件只保留最近 100 条；消息分页失败则回滚待提交位置。
   * EN: Read current run detail with trailing/full-summary/projection-retry controls. Key includes run/message window/retained messages; publish only for current run and request sequence. Keep higher run revision and latest 100 events; roll back pending history position on failure.
   */
  const refreshDetail = useCallback(
    async (trailing = false, forceSummary = false, retryProjections = false) => {
      const wanted = activeRunId.current;
      if (!wanted) return;
      if (!retryProjections && detailRetryRun.current === wanted) return;
      const position = historyPosition.current;
      const before = position.runId === wanted ? position.before : '';
      const around = position.runId === wanted ? position.around : undefined;
      const full = forceSummary || (fullDetailRequested.current && summaryDemand.current);
      const append = historyAppend.current;
      const retained =
        append && detailSnapshot.current?.run.id === wanted
          ? detailSnapshot.current.messages.map((message) => message.id)
          : [];
      const taskAfter = agentPagePosition.current.runId === wanted ? agentPagePosition.current.after : '';
      return detailReads.current.run(
        `${wanted}:${before}:${around || ''}:${full}:${retained.join(',')}:${retryProjections}:${taskAfter}`,
        async (signal) => {
          const request = ++detailRequest.current;
          let result: Detail;
          try {
            let retryUnreadable = retryProjections;
            /**
             * 按锚点或前向游标读取会话消息页，附带需要保留的消息标识；不可读投影仅在本轮首次请求附带重试参数，限制重复恢复。
             * EN: Read conversation messages around an anchor or before a cursor, retaining requested message IDs; attach projection-retry parameters only once per recovery round.
             */
            const read = (cursor: string, anchor?: string) => {
              const retryQuery = retryUnreadable ? '&retryProjections=true' : '';
              retryUnreadable = false;
              return api<Detail>(
                '/runs/' +
                  wanted +
                  `?messageLimit=${messageHistoryPageSize}&view=conversation` +
                  (full ? '' : '&summary=deferred') +
                  (anchor
                    ? '&aroundMessage=' + encodeURIComponent(anchor)
                    : cursor
                      ? '&beforeMessage=' + encodeURIComponent(cursor)
                      : '') +
                  (retained.length ? '&retainedMessages=' + encodeURIComponent(retained.join(',')) : '') +
                  (taskAfter ? '&taskAfter=' + encodeURIComponent(taskAfter) : '') +
                  retryQuery,
                undefined,
                undefined,
                signal,
              );
            };
            try {
              result = await read(before, around);
            } catch (issue) {
              if (
                !signal.aborted &&
                activeRunId.current === wanted &&
                detailRequest.current === request &&
                issue instanceof ApiError &&
                issue.code === 'MESSAGE_CURSOR_MISSING' &&
                (around || before) &&
                !historyPending.current &&
                detailSnapshot.current?.run.id !== wanted
              ) {
                historyPosition.current = { runId: wanted, before: '', trail: [] };
                conversationHistory.remove([wanted]);
                setInitialHistoryAnchor(undefined);
                setError('原阅读位置已失效，已返回最新消息。');
                result = await read('');
              } else throw issue;
            }
          } catch (error) {
            if (!signal.aborted && activeRunId.current === wanted && detailRequest.current === request) {
              const pending = historyPending.current;
              if (pending?.target === position) {
                historyPosition.current = pending.prior;
                historyAppend.current = pending.priorAppend;
                historyPending.current = undefined;
              }
              setReadIssues((old) => ({ ...old, detail: readIssueFor(error, request, wanted) }));
              return false;
            }
            return;
          }
          if (!signal.aborted && activeRunId.current === wanted && detailRequest.current === request) {
            if (!startupMeasured.current.messages) {
              startupMeasured.current.messages = true;
              markStartupStage('messages-ready', { surface: localSurface });
            }
            /**
             * 同一收件消息可能有多份显示投影，阅读锚点应归一到当前可见的消息身份。
             * EN: An inbox message may have multiple projections; normalize reading anchors to the visible message identity.
             */
            if (around) {
              const target = result.messages.find((message) => message.id === around);
              const canonical =
                target &&
                conversationMessages(result.messages).find(
                  (message) =>
                    message.id === around ||
                    (isInboxUserMessage(target) &&
                      isInboxUserMessage(message) &&
                      message.sourceInboxId === target.sourceInboxId &&
                      message.text === target.text),
                );
              if (canonical && canonical.id !== around)
                setInitialHistoryAnchor((old) => old && { ...old, id: canonical.id });
            }
            if (Number.isSafeInteger(result.eventCursor) && result.eventCursor! >= 0)
              streamCursor.current = { runId: wanted, cursor: result.eventCursor! };
            const pending = historyPending.current;
            if (pending?.target === position) {
              historyPending.current = undefined;
              if (pending.reposition) setHistorySegment((value) => value + 1);
            }
            clearReadIssue('detail', request);
            detailLoadedRequest.current = request;
            runStream.current.sync(result.requests);
            setStreaming(runStream.current.texts());
            setStreamingReasoning(runStream.current.reasonings());
            setDetail((old) => {
              if (old?.run.id !== wanted) return result;
              const messages = append ? earlierMessages(result.messages, old.messages) : result.messages;
              const events = [
                ...new Map([...old.events, ...result.events].map((event) => [event.seq, event])).values(),
              ]
                .sort((a, b) => a.seq - b.seq)
                .slice(-100);
              /**
               * SSE 后触发的较早快照不能让运行状态倒退；不可读状态仍采用本次明确诊断。
               * EN: An older post-SSE snapshot cannot roll run state backward; explicit unreadability diagnostics still apply.
               */
              return old.run.revision > result.run.revision
                ? detailReadReason(result)
                  ? { ...result, run: old.run, messages, events }
                  : old.taskPage?.after !== result.taskPage?.after
                    ? { ...result, run: old.run, messages, events }
                    : { ...old, messages, messagePage: result.messagePage, events }
                : { ...result, messages, events };
            });
          }
          return true;
        },
        trailing,
      );
    },
    [clearReadIssue, conversationHistory],
  );
  /**
   * 请求消息历史窗口。向前读且容量允许时追加，否则替换并重新定位；pending 保存旧位置，
   * 由 refreshDetail 在结果确认后提交，防止读取失败后界面游标与正文不一致。
   * EN: Request a history window, appending older pages only within capacity; otherwise replace/relocate. pending retains prior position until refreshDetail confirms success, keeping cursor and body aligned on failure.
   */
  async function changeAgentPage(after: string, trail: string[]) {
    if (!detail || agentPaging) return;
    const previous = agentPagePosition.current;
    const position = { runId: detail.run.id, after, trail };
    agentPagePosition.current = position;
    setAgentPaging(true);
    try {
      const ok = await refreshDetail();
      if (!ok && agentPagePosition.current === position) agentPagePosition.current = previous;
    } finally {
      if (agentPagePosition.current === position || agentPagePosition.current === previous)
        setAgentPaging(false);
    }
  }
  async function changeHistory(before: string, trail: string[], around?: string) {
    if (historyMoving.current) return;
    const wanted = activeRunId.current;
    const prior = historyPosition.current;
    const priorAppend = historyAppend.current;
    const append =
      !around &&
      !!before &&
      trail.length > prior.trail.length &&
      (detailSnapshot.current?.messages.length || 0) + messageHistoryPageSize <= messageHistoryWindowLimit;
    historyMoving.current = true;
    historyAppend.current = append;
    const target = { runId: wanted, before, trail, around };
    setInitialHistoryAnchor(around ? { id: around, offset: 24 } : undefined);
    historyPosition.current = target;
    historyPending.current = { target, prior, priorAppend, reposition: !append };
    setHistoryLoading(true);
    try {
      return (await refreshDetail()) === true;
    } finally {
      if (activeRunId.current === wanted) {
        historyMoving.current = false;
        setHistoryLoading(false);
      }
    }
  }
  /**
   * 显式加载代理、产物和用量统计，完成时再次确认用户仍停留在原运行。
   * EN: Load complete agents/artifacts/usage explicitly and confirm original run is still selected before publication.
   */
  async function loadDetailedSummary() {
    if (summaryLoading || !activeRunId.current) return false;
    const wanted = activeRunId.current;
    fullDetailRequested.current = true;
    setSummaryLoading(true);
    try {
      return (await refreshDetail(false, true)) === true && activeRunId.current === wanted;
    } finally {
      if (activeRunId.current === wanted) setSummaryLoading(false);
    }
  }
  /**
   * 对不可读投影执行一次显式重试；重试标记防止普通刷新同时绕过该过程。
   * EN: Explicitly retry unreadable projections; retry flag prevents normal refresh bypassing that workflow.
   */
  async function retryDetailRecords(forceSummary = true) {
    const wanted = activeRunId.current;
    if (!wanted || detailRetryRun.current) return;
    detailRetryRun.current = wanted;
    setRetryingDetailRun(wanted);
    try {
      await refreshDetail(false, forceSummary, true);
    } finally {
      detailRetryRun.current = '';
      setRetryingDetailRun('');
    }
  }
  /**
   * 为指定代理读取一致上下文快照。新打开会取消旧读取，结果还需同时匹配运行和弹窗身份；
   * 关闭弹窗或切换运行的清理 effect 会中止请求。
   * EN: Read a consistent agent context snapshot. Cancel old open requests; validate both run and dialog identity. Closing/switching cleanup aborts the read.
   */
  async function openContext(agentId: string) {
    const target = detailSnapshot.current;
    if (!target?.agents.some((agent) => agent.id === agentId)) return;
    contextReadController.current?.abort();
    const controller = new AbortController();
    contextReadController.current = controller;
    if (contextSnapshot?.runId !== target.run.id || modalCurrent.current !== 'context:' + agentId)
      setContextSnapshot(undefined);
    setContextReading(true);
    setModal('context:' + agentId);
    try {
      const snapshot = await api<ContextSnapshot>(
        '/runs/' + target.run.id + '/context',
        undefined,
        undefined,
        controller.signal,
      );
      if (
        !controller.signal.aborted &&
        activeRunId.current === target.run.id &&
        modalCurrent.current === 'context:' + agentId
      )
        setContextSnapshot(snapshot);
    } catch (issue) {
      if (!controller.signal.aborted && activeRunId.current === target.run.id)
        setError(issue instanceof Error ? issue.message : '上下文读取失败，请重试。');
    } finally {
      if (!controller.signal.aborted && activeRunId.current === target.run.id) setContextReading(false);
    }
  }
  /**
   * 初始化入口会话，绑定导航与草稿的认证范围，然后分别加载列表和持久草稿。
   * 已认证时按 source 仅重试相关读取；会话初始化及写操作期间避免重复发起连接流程。
   * EN: Initialize surface session and bind auth scope for navigation/drafts, then load lists and persistent drafts independently. Authenticated retries target their failed source only; prevent duplicate init during session/write activity.
   */
  const connect = useCallback(
    async (retry = false, source?: ReadSource, target?: string) => {
      if (connectPending.current || actionPending.current) return;
      connectPending.current = true;
      if (!sessionReady.current) setSessionInitializing(true);
      setRetrying(true);
      const refreshCurrentDetail = sessionReady.current && !source;
      try {
        if (!sessionReady.current) {
          const request = ++sessionRequest.current;
          let scope: string | undefined;
          try {
            scope = await initializeSession({ retry });
          } catch (error) {
            setReadIssues((old) => ({ ...old, session: readIssueFor(error, request) }));
            return;
          }
          clearReadIssue('session', request);
          bindReadingCheckpointScope(client, scope);
          navigationStorageKey.current = navigationKey(scope, client);
          savedNavigation.current = readNavigation(navigationStorageKey.current);
          cache.bindScope(client.workbenchScope());
          conversationHistory.bindScope(client.workbenchScope());
          markStartupStage('auth-ready', { surface: localSurface });
          /**
           * 认证后的工作台与列表互不依赖。
           * EN: The authenticated workbench and lists do not depend on each other.
           */
          sessionReady.current = true;
          setReady(true);
          registerSession(localSurface);
          /**
           * 认证后工作台即可使用，历史与持久
           * EN: The workbench is usable after authentication. History and persisted
           */
          /**
           * 草稿独立协调并保留加载期间的编辑。
           * EN: drafts reconcile independently, preserving edits made while loading.
           */
          void cache.load().catch(() => {});
          void refresh();
          return;
        }
        if (source === 'detail') {
          if (target === activeRunId.current) await refreshDetail();
        } else if (source === 'configuration') {
          await refreshConfiguration(true);
        } else {
          await refresh();
          if (retry && refreshCurrentDetail) await refreshDetail();
        }
      } finally {
        connectPending.current = false;
        setSessionInitializing(false);
        setRetrying(false);
      }
    },
    [
      clearReadIssue,
      refresh,
      refreshDetail,
      refreshConfiguration,
      cache,
      conversationHistory,
      registerSession,
    ],
  );
  useEffect(() => {
    void connect();
  }, [connect]);
  /**
   * 仅按当前项目、运行及待核验操作补读所需草稿，避免一次载入全部历史草稿正文。
   * EN: Read draft bodies only for current project/run/uncertain operations instead of all historical drafts.
   */
  useEffect(() => {
    if (!ready) return;
    const keys = [newDraftKey(projectId), runSetupDraftKey(projectId)];
    if (projectId && !terminalSurface) keys.push(projectBoardKey(projectId));
    if (runId)
      keys.push(
        `draft:run:${runId}`,
        `draft:terminal-continuation:${runId}`,
        `draft:terminal-communication:${runId}`,
        `draft:terminal-resolution:${runId}`,
        `draft:terminal-send:${runId}`,
        `draft:handoff:${runId}`,
        `draft:delivery-review:${runId}`,
        `draft:source-resolutions:${runId}`,
      );
    for (const operation of detail?.operations || [])
      if (operation.status === 'UNCERTAIN') keys.push(`draft:terminal-recovery:${runId}:${operation.id}`);
    void cache.ensureKeys(keys).catch(() => {});
  }, [ready, projectId, runId, detail?.operations, cache]);
  /**
   * 项目默认配置属于当前终端项目；切换项目立即取消旧请求并清除不适用的继承值。
   * EN: Project defaults belong to current terminal project; switching immediately aborts read and clears inapplicable inheritance.
   */
  useEffect(() => {
    if (!terminalSurface || !ready || !projectId) {
      setTerminalPreferences(null);
      return;
    }
    const controller = new AbortController();
    void api<TerminalProjectPreferences>(
      `/terminal/control/projects/${projectId}/preferences`,
      undefined,
      undefined,
      controller.signal,
    )
      .then((value) => {
        if (!controller.signal.aborted) setTerminalPreferences({ projectId, value });
      })
      .catch((issue) => {
        if (!controller.signal.aborted)
          setError(issue instanceof Error ? issue.message : '无法读取项目默认配置');
      });
    return () => controller.abort();
  }, [projectId, ready, terminalSurface, api]);
  useEffect(() => {
    if (!ready) return;
    const timer = setInterval(() => void refresh().catch(() => {}), 5000);
    return () => clearInterval(timer);
  }, [ready, refresh]);
  /**
   * 当前运行的实时同步生命周期：先读取可靠详情取得事件游标，再订阅 SSE。
   * 文本片段按动画帧合并发布，状态事件以短延迟合并详情刷新；存在偏移缺口时回查快照。
   * 清理时关闭事件源、定时器与动画帧，隐藏/切换入口后的旧事件不能继续写入界面。
   * EN: Synchronize current run by reading reliable detail/event cursor before SSE. Batch text per animation frame and coalesce state refreshes with short delay; backfill offset gaps from snapshots. Cleanup closes source/timers/frames so hidden/switched surfaces reject old events.
   */
  useEffect(() => {
    if (streamRun.current !== runId) {
      streamRun.current = runId;
      runStream.current.clear();
      setStreaming({});
      setStreamingReasoning({});
    }
    /**
     * 热返回时保留上次任务视图并与服务端协调；
     * EN: Preserve the last task view on a hot return while reconciling it with the
     */
    /**
     * 切换到其他运行时 navigate 已清空旧状态。
     * EN: server. A different run was already cleared by navigate().
     */
    setDetail((old) => (old?.run.id === runId ? old : null));
    setConnection('connecting');
    if (!ready || !runId) return;
    let source: EventSource | undefined;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let frame: number | null = null;
    /**
     * 把高频流式文本更新合并到单个动画帧，并在卸载后停止发布。文本和推理同时读取同一累积器，减少渲染压力及显示不同步。
     * EN: Coalesce streaming updates into one animation frame and stop publishing after disposal; read text and reasoning from the same accumulator to reduce render load and visual skew.
     */
    const publishStream = () => {
      if (frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        if (!disposed) {
          setStreaming(runStream.current.texts());
          setStreamingReasoning(runStream.current.reasonings());
        }
      });
    };
    let listsDirty = false;
    /**
     * 多个邻近事件共用一次详情读取；会改变侧栏状态的事件再额外刷新列表。
     * EN: Coalesce nearby events into one detail read; refresh lists separately for sidebar-affecting events.
     */
    const reload = (lists = false) => {
      listsDirty ||= lists;
      if (!disposed && !timer)
        timer = setTimeout(() => {
          timer = null;
          void refreshDetail(true).catch(() => {});
          if (listsDirty) void refresh(false, true).catch(() => {});
          listsDirty = false;
        }, 120);
    };
    /**
     * 先成功刷新会话详情，再用已确认游标连接事件流；详情未读成功时延迟重试。连接事件驱动列表、上下文和实时内容更新，所有回调受当前会话及清理状态约束，避免串入旧会话事件。
     * EN: Refresh run details before opening the event stream from its confirmed cursor, retrying later if refresh fails. Stream callbacks coordinate list, context, and live content while honoring active-run identity and disposal.
     */
    const start = async () => {
      const read = await refreshDetail();
      if (disposed || activeRunId.current !== runId) return;
      if (read !== true) {
        timer = setTimeout(() => {
          timer = null;
          void start();
        }, 5000);
        return;
      }
      const cursor = streamCursor.current.runId === runId ? streamCursor.current.cursor : 0;
      source = new EventSource(apiUrl('/runs/' + runId + '/events?after=' + cursor));
      source.addEventListener('open', () => {
        if (disposed) return;
        setConnection('connected');
        reload();
        void liveContext.request();
      });
      source.addEventListener('error', (event) => {
        if (!disposed && !(event instanceof MessageEvent)) setConnection('reconnecting');
      });
      const events = [
        'run.updated',
        'plan.proposed',
        'task.updated',
        'agent.started',
        'message.completed',
        'tool.started',
        'tool.completed',
        'tool.reviewed',
        'decision.required',
        'artifact.created',
        'usage.updated',
        'context.updated',
        'context.policy.updated',
        'terminal.started',
        'terminal.phase',
        'terminal.output',
        'terminal.completed',
        'terminal.failed',
        'terminal.unavailable',
        'terminal.accepted',
        'inbox.received',
        'terminal.message_received',
        'terminal.message_sent',
        'terminal.message_resolved',
        'terminal.inbox_applied',
        'error',
      ];
      for (const event of events)
        source.addEventListener(event, (e) => {
          if (disposed) return;
          if (event === 'context.updated') {
            const data = JSON.parse((e as MessageEvent).data);
            if (data.runId === runId) liveContext.update(data.payload);
            return;
          }
          if (event === 'terminal.output') {
            const data = JSON.parse((e as MessageEvent).data);
            setDetail((old) =>
              old?.run.id === runId
                ? {
                    ...old,
                    events: [...old.events.filter((item) => item.seq !== data.seq), data]
                      .sort((a, b) => a.seq - b.seq)
                      .slice(-100),
                  }
                : old,
            );
            return;
          }
          if (event === 'message.completed') {
            const data = JSON.parse((e as MessageEvent).data);
            if (data.runId !== runId) return;
            runStream.current.complete(data.taskId, data.payload);
            publishStream();
          }
          reload(
            [
              'run.updated',
              'terminal.completed',
              'terminal.failed',
              'terminal.accepted',
              'terminal.unavailable',
            ].includes(event),
          );
        });
      source.addEventListener('message.delta', (e) => {
        if (disposed) return;
        const data = JSON.parse((e as MessageEvent).data);
        if (data.runId !== runId) return;
        if (!runStream.current.delta(data)) reload();
        publishStream();
      });
      source.addEventListener('message.reasoning.delta', (e) => {
        if (disposed || terminalSurface) return;
        const data = JSON.parse((e as MessageEvent).data) as ReasoningDelta;
        if (data.runId !== runId) return;
        if (!runStream.current.reasoningDelta(data)) reload();
        publishStream();
      });
    };
    void start();
    return () => {
      disposed = true;
      source?.close();
      if (timer) clearTimeout(timer);
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [ready, runId, refreshDetail, refresh, liveContext.request, liveContext.update]);
  useEffect(() => {
    setAssignmentReady({});
  }, [assignmentKey]);
  useEffect(() => setError(''), [modal]);
  /**
   * 关闭或替换来源弹窗会废弃尚未完成的导航请求。
   * EN: Closing or replacing a source dialog retires its unfinished navigation request.
   */
  React.useLayoutEffect(() => {
    projectLeaveGuard.begin();
  }, [modal, projectLeaveGuard]);
  /**
   * 串行化用户写操作并统一呈现错误。动作成功后刷新配置、列表与详情；失败不清空草稿，
   * 返回布尔值供调用方决定是否关闭弹窗或重置自身输入。
   * EN: Serialize writes and present errors centrally. After success refresh config/lists/detail; preserve drafts on failure. Return boolean so caller decides whether to close/reset its own form.
   */
  async function act(fn: () => Promise<unknown>) {
    if (actionPending.current) return false;
    actionPending.current = true;
    setBusy(true);
    setError('');
    try {
      await fn();
      await refresh(true);
      await refreshDetail(true);
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      actionPending.current = false;
      setBusy(false);
    }
  }
  /**
   * 写操作先取得项目离开意图；需要用户处理草稿时返回 false，获准后才调用 action。
   * EN: Acquire leave intent before project writes; return false while draft needs handling and call action only after approval.
   */
  const submitAfterProjectLeave = (label: string, action: (intent: number) => Promise<boolean>) => {
    const intent = projectLeaveGuard.begin();
    let result: Promise<boolean> | undefined;
    projectLeaveGuard.request(
      () => {
        result = action(intent);
      },
      { intent, label },
    );
    return result ?? Promise.resolve(false);
  };
  /**
   * 项目内先打开任务设置；独立对话直接用当前型号、上下文和无文件/执行权限配置创建运行。
   * 创建完成只清除与发送时相同的原草稿，期间新增输入或导航不会被迟到结果覆盖。
   * EN: Open task settings within projects; create chat directly with current model/context and no file/exec permissions. Clear only original unchanged creation draft; later input/navigation survives late success.
   */
  const startConversation = () => {
    if (terminalSurface && (!project || !terminalProfile || !projectPreferences)) return;
    if (busy || (!project && (!homeModelValid || !homeContextValid)) || !draft.trim() || project?.archived)
      return;
    if (project) {
      setModal('run');
      return;
    }
    const text = draft;
    const key = draftKey;
    const epoch = navigationEpoch.current;
    void act(async () => {
      const run = await mutation<Run>('/runs', {
        ...homeModel,
        contextPolicy: homeContext,
        objective: text,
        kind: 'chat',
        projectId: null,
        inputs: [],
        permissionProfile: { read: false, write: false, exec: false, urls: [], writePaths: [] },
        budget: { maxRequests: 80, maxTokens: 500000, maxCost: null },
        limits: {
          maxDepth: 0,
          maxAgents: 1,
          concurrency: 1,
          toolConcurrency: 4,
          maxSteps: 20,
          maxMinutes: 30,
        },
      });
      if (navigationEpoch.current === epoch) selectRun(run);
      if (cache.get(key) === text) cache.set(key, '');
    });
  };
  /**
   * 发送补充前固定运行版本、文字和继续/重规划意图，并保存带 commandId 的回执。
   * 未确认结果重试沿用同一负载；明确的版本拒绝才允许重新形成请求。
   * 成功清理仅作用于本次未变化的草稿和意图，保护发送期间的新输入。
   * EN: Freeze run revision/text/continue-or-replan intent and persist commandId receipt before supplement. Unknown retries keep exact payload; only definitive version rejection creates new request. Clear only unchanged submitted draft/intent, preserving later typing.
   */
  const sendReply = () => {
    if (
      !detail ||
      detail.run.id !== runId ||
      busy ||
      runReadOnly ||
      !reply.trim() ||
      ['DONE', 'CANCELLED'].includes(detail.run.status)
    )
      return;
    const target = runId;
    const text = reply;
    const revision = detail.run.revision;
    const terminalInput = detail.run.execution?.kind === 'docker-agent';
    const intentKey = replyIntentKey;
    const selectedIntent = replyIntents.get(intentKey);
    const intent = pendingReplyReceipt?.intent ?? (canChooseReplyIntent ? replyIntent : undefined);
    const change = replyChanges.current.get(intentKey) ?? 0;
    void act(async () => {
      const receiptKey = `draft:terminal-send:${target}`;
      if (!terminalInput) {
        /**
         * 替换持久回执前先读取，包括迟到的首次加载。
         * EN: Read before replacing a durable receipt, including a late first load.
         */
        await cache.ensureKey(receiptKey);
        const previousRead = inspectReplyReceipt(cache.get(receiptKey), target);
        if (previousRead.status === 'unreadable') throw new Error(previousRead.message);
        const previous = previousRead.status === 'ready' ? previousRead.receipt : null;
        /**
         * 首次读取可能晚于点击发送，渲染时默认值
         * EN: A first read may finish after send was clicked. The render-time default
         */
        /**
         * 不能替换未修改且尚未确认的保存请求意图。
         * EN: must not replace the intent of an untouched, unresolved stored request.
         */
        const requestedIntent =
          !selectedIntent && change === 0 && previous?.text === text && !previous.outcome
            ? previous.intent
            : intent;
        const receipt: ReplyReceipt =
          matchesReplyReceipt(previous, target, text, requestedIntent) &&
          (receiptChanges.current.get(previous.commandId) ?? 0) === change
            ? previous
            : {
                version: 1,
                targetRunId: target,
                text,
                ...(requestedIntent === undefined ? {} : { intent: requestedIntent }),
                commandId: crypto.randomUUID(),
                expectedRevision: revision,
              };
        const savedReceipt = JSON.stringify(receipt);
        receiptChanges.current.set(receipt.commandId, change);
        cache.set(receiptKey, savedReceipt);
        try {
          await mutation('/runs/' + target + '/messages', replyReceiptPayload(receipt));
        } catch (error) {
          /**
           * 此 CAS 拒绝证明命令没有提交，刷新可形成
           * EN: This CAS rejection proves the command did not commit. Refreshing can
           */
          /**
           * 新请求；传输或5xx失败保留精确负载。
           * EN: create a new request; transport/5xx failures retain the exact payload.
           */
          if (
            error instanceof ApiError &&
            error.kind === 'http' &&
            typeof error.status === 'number' &&
            error.status >= 400 &&
            error.status < 500 &&
            error.code === 'REVISION_CONFLICT' &&
            cache.get(receiptKey) === savedReceipt
          ) {
            cache.set(receiptKey, '');
            if ((replyChanges.current.get(intentKey) ?? 0) === change && receipt.intent)
              setReplyIntents((current) =>
                current.get(intentKey) === selectedIntent
                  ? new Map(current).set(intentKey, { value: receipt.intent! })
                  : current,
              );
          }
          throw error;
        }
        if (cache.get(receiptKey) === savedReceipt) {
          cache.set(receiptKey, '');
          if ((replyChanges.current.get(intentKey) ?? 0) === change) {
            if (cache.get(`draft:run:${target}`) === text) cache.set(`draft:run:${target}`, '');
            setReplyIntents((current) => {
              if (current.get(intentKey) !== selectedIntent) return current;
              const next = new Map(current);
              next.delete(intentKey);
              return next;
            });
          }
        }
        return;
      }
      const previous = readTerminalCommunicationDraft(cache.get(receiptKey));
      const receipt =
        terminalInput &&
        previous.text === text &&
        previous.commandId &&
        previous.expectedRevision !== undefined
          ? previous
          : { targetRunId: target, text, commandId: crypto.randomUUID(), expectedRevision: revision };
      if (terminalInput) cache.set(receiptKey, JSON.stringify(receipt));
      await mutation('/runs/' + target + '/messages', {
        expectedRevision: terminalInput ? receipt.expectedRevision : revision,
        text,
        ...(intent ? { intent } : {}),
        ...(terminalInput ? { commandId: receipt.commandId } : {}),
      });
      if (cache.get(`draft:run:${target}`) === text) cache.set(`draft:run:${target}`, '');
      if (terminalInput && cache.get(receiptKey) === JSON.stringify(receipt)) cache.set(receiptKey, '');
      if (intent)
        setReplyIntents((current) => {
          /**
           * 迟到成功只能清除属于自身且未改变的选择，不能清除
           * EN: A late success may clear only its own unchanged choice, never a
           */
          /**
           * 新选择或其他运行的草稿。
           * EN: newer selection or another run's draft.
           */
          if (current.get(intentKey) !== selectedIntent) return current;
          const next = new Map(current);
          next.delete(intentKey);
          return next;
        });
    });
  };
  /**
   * 使用保存的原始回执核对未知发送。明确未提交时保存 not-sent 与原文；确认已提交时
   * 清除回执但保留当前草稿，不将重试过程当成新的用户补充。
   * EN: Reconcile unknown send with saved original receipt. Definitively uncommitted requests keep not-sent/original text; confirmed commits clear receipt but preserve current draft. Reconciliation is not a new supplement.
   */
  const reconcileReply = () => {
    if (busy || !cachedReplyReceipt || cachedReplyReceipt.outcome || cachedReplyReceipt.targetRunId !== runId)
      return;
    const receipt = cachedReplyReceipt;
    const key = replyReceiptKey;
    const statusKey = replyIntentKey;
    void act(async () => {
      await cache.ensureKey(key);
      const raw = cache.get(key);
      if (JSON.stringify(readReplyReceipt(raw)) !== JSON.stringify(receipt))
        throw new Error('发送回执已变化，请核对当前记录后重试。');
      try {
        await mutation('/runs/' + receipt.targetRunId + '/messages', replyReceiptPayload(receipt));
      } catch (error) {
        if (
          error instanceof ApiError &&
          error.kind === 'http' &&
          typeof error.status === 'number' &&
          error.status >= 400 &&
          error.status < 500 &&
          ['INVALID_STATE', 'REVISION_CONFLICT', 'ARCHIVED'].includes(error.code || '') &&
          cache.get(key) === raw
        ) {
          cache.set(key, JSON.stringify({ ...receipt, outcome: 'not-sent' }));
          const draftKey = `draft:run:${receipt.targetRunId}`;
          if (!cache.get(draftKey)) cache.set(draftKey, receipt.text);
          setReplyReceiptStatus((current) =>
            new Map(current).set(statusKey, '上次补充未提交，原文已保留，当前草稿未替换。'),
          );
          return;
        }
        throw error;
      }
      if (cache.get(key) === raw) {
        cache.set(key, '');
        setReplyReceiptStatus((current) =>
          new Map(current).set(statusKey, '上次发送已确认，未重复提交；当前草稿保留。'),
        );
      }
    });
  };
  /**
   * 通过导航门禁选择运行；提交选择后展开所属项目、清除未读标记并重置详情默认页。
   * EN: Choose runs through navigation guard, then expand project, clear unread flag, and reset detail default page.
   */
  const selectRun = (
    run: RunListItem,
    options: { intent?: number; bypass?: boolean; after?: () => void } = {},
  ) => {
    const owner = projects.find((p) => p.id === run.projectId);
    return navigate(
      {
        spaceId: owner?.spaceId || navigation.current.spaceId,
        projectId: run.projectId || '',
        runId: run.id,
      },
      true,
      {
        ...options,
        label: `任务「${run.title || '未命名'}」`,
        /**
         * 会话导航成功后清除未读、展开所属项目并初始化详情页签，再执行调用方后续动作。
         * EN: After accepted run navigation, clear unread state, expand its project, initialize the detail tab, and invoke the caller continuation.
         */
        after: () => {
          if (cache.get(`unread:run:${run.id}`) === true) cache.set(`unread:run:${run.id}`, false);
          if (run.projectId && cache.get(`collapsed:project:${run.projectId}`) === true)
            cache.set(`collapsed:project:${run.projectId}`, false);
          setPreviewTaskId(run.rootTaskId);
          setPreviewOpen(false);
          setTab(run.kind === 'chat' ? 'agents' : 'tasks');
          options.after?.();
        },
      },
    );
  };
  /**
   * 普通操作打开核验弹窗；终端操作滚动到恢复卡片，动画帧执行前再检查导航身份。
   * EN: Ordinary uncertain operations open dialog; terminal operations scroll to recovery card after frame-time navigation recheck.
   */
  const openVerification = (operation: Operation, ownerRunId: string, epoch = navigationEpoch.current) => {
    if (operation.name !== 'terminal_agent') {
      setModal('decision:' + operation.id);
      return;
    }
    setModal('');
    requestAnimationFrame(() => {
      if (activeRunId.current !== ownerRunId || navigationEpoch.current !== epoch || modalCurrent.current)
        return;
      const recovery = terminalRecoveryRefs.current.get(operation.id);
      if (recovery) {
        recovery.scrollIntoView({ block: 'start' });
        recovery.focus({ preventScroll: true });
      } else replyRef.current?.focus();
    });
  };
  /**
   * 等 DOM 更新后定位待答问题；问题区不存在时退到回复框，旧导航不得夺取焦点。
   * EN: Wait for DOM then focus questions, falling back to reply input; stale navigation cannot take focus.
   */
  const focusQuestions = (ownerRunId = runId, epoch = navigationEpoch.current) => {
    setPreviewOpen(false);
    requestAnimationFrame(() => {
      if (activeRunId.current !== ownerRunId || navigationEpoch.current !== epoch || modalCurrent.current)
        return;
      if (questionRef.current) {
        questionRef.current.scrollIntoView({ block: 'start' });
        questionRef.current.focus({ preventScroll: true });
      } else replyRef.current?.focus();
    });
  };
  /**
   * 任务中心跳转先要求详情读取晚于点击时的请求，避免依据列表旧快照定位操作入口。
   * EN: Task-center navigation requires detail newer than click-time request instead of acting on old list snapshot.
   */
  const openTaskCenterTarget = (id: string, category: TaskCenterTarget) => {
    setTaskCenterTarget({
      id,
      category,
      epoch: navigationEpoch.current,
      afterRequest: detailRequest.current,
    });
    /**
     * 重开当前运行也必须读取晚于列表或头快照的数据。
     * EN: Even reopening the currently selected run must read past the list/header snapshot.
     */
    void refreshDetail(true, true);
  };
  useEffect(() => {
    const target = taskCenterTarget;
    if (!target) return;
    if (target.epoch !== navigationEpoch.current || modalCurrent.current) {
      setTaskCenterTarget(undefined);
      return;
    }
    if (!detail || detail.run.id !== target.id || detailLoadedRequest.current <= target.afterRequest) return;
    const destination = taskCenterDestination(detail, target.category, archived, terminalSurface);
    if (destination.kind === 'summary') {
      void loadDetailedSummary();
      return;
    }
    setTaskCenterTarget(undefined);
    setPreviewOpen(false);
    setDetailsDrawerOpen(false);
    /**
     * 下一动画帧把目标区滚入视野并聚焦；执行前再次检查会话、导航代次和弹窗，避免迟到的焦点跳转干扰新界面。
     * EN: Scroll and focus the target on the next frame only if run, navigation epoch, and modal state still match, preventing late focus jumps.
     */
    const focus = (element: React.RefObject<HTMLDivElement | null>) => {
      requestAnimationFrame(() => {
        if (
          activeRunId.current !== target.id ||
          navigationEpoch.current !== target.epoch ||
          modalCurrent.current
        )
          return;
        element.current?.scrollIntoView({ block: 'start' });
        element.current?.focus({ preventScroll: true });
      });
    };
    switch (destination.kind) {
      case 'operation': {
        const operation = detail.operations.find((item) => item.id === destination.operationId);
        if (operation) openVerification(operation, target.id, target.epoch);
        break;
      }
      case 'review':
        setModal('delivery');
        break;
      case 'terminal-review':
        focus(terminalReviewRef);
        break;
      case 'plan':
        focus(planRef);
        break;
      case 'questions':
      case 'reply':
        focusQuestions(target.id, target.epoch);
        break;
      case 'limits':
      case 'settings':
        setModal(destination.kind);
        break;
      case 'archive':
        setModal('manage:archive');
        break;
      case 'tasks':
        openTaskDetails(destination.taskId);
        break;
      case 'artifacts':
      case 'usage':
        setDetailsCollapsed(false);
        setDetailsDrawerOpen(true);
        setTab(destination.kind);
        void loadDetailedSummary();
        break;
      case 'status':
        focus(runStatusRef);
        break;
    }
  }, [detail, taskCenterTarget]);
  useEffect(() => {
    if (!ready || !notificationTarget || notificationTarget.sequence <= notificationSequence.current) return;
    notificationSequence.current = notificationTarget.sequence;
    const controller = new AbortController(),
      epoch = navigationEpoch.current,
      intent = projectLeaveGuard.begin();
    void api<Run>('/runs/' + notificationTarget.taskId + '/header', undefined, undefined, controller.signal)
      .then((target) => {
        if (
          controller.signal.aborted ||
          navigationEpoch.current !== epoch ||
          !projectLeaveGuard.current(intent)
        )
          return;
        selectRun(target, {
          intent,
          /** 仅在关联导航成功后关闭当前弹窗，保留离开检查取消时的原界面。 EN: Close the modal only after its associated navigation succeeds, preserving the current view when leave checks cancel it. */ after:
            () => setModal(''),
        });
      })
      .catch((issue) => {
        if (!controller.signal.aborted && projectLeaveGuard.current(intent))
          setError(issue instanceof Error ? issue.message : '无法打开通知对应的任务。');
      });
    return () => controller.abort();
  }, [ready, notificationTarget?.sequence, api]);
  /**
   * 从资源跳到所属运行，并在需要时定位未知操作。读取头信息期间保存导航意图；
   * 如果用户已离开，结果被忽略。尚未载入的操作通过 heldNavigation 等待详情到达。
   * EN: Navigate from resource to owner run and optionally uncertain operation. Save intent during header read, ignore if user left, and hold absent-operation navigation until detail arrives.
   */
  const openResourceOwner = async (ownerRunId: string, operationId?: string) => {
    if (actionPending.current) return;
    const epoch = navigationEpoch.current,
      intent = projectLeaveGuard.begin();
    try {
      const target = await api<Run>('/runs/' + ownerRunId + '/header');
      if (epoch !== navigationEpoch.current || !projectLeaveGuard.current(intent)) return;
      selectRun(target, {
        intent,
        /**
         * 导航到产物区后读取完整详情并展开侧栏；不确定操作可立即打开复核，尚未读到的操作则记录导航意图等待详情到达。
         * EN: Open artifacts with full details after navigation; inspect an uncertain operation immediately when loaded, or retain its navigation intent until details arrive.
         */
        after: () => {
          setTab('artifacts');
          fullDetailRequested.current = true;
          void refreshDetail(false, true);
          setDetailsCollapsed(false);
          setDetailsDrawerOpen(true);
          heldNavigation.current = operationId
            ? { runId: ownerRunId, operationId, epoch: navigationEpoch.current }
            : undefined;
          const operation =
            detail?.run.id === ownerRunId
              ? detail.operations.find((row) => row.id === operationId && row.status === 'UNCERTAIN')
              : undefined;
          if (operation) {
            heldNavigation.current = undefined;
            openVerification(operation, ownerRunId);
          }
        },
      });
    } catch (issue) {
      if (projectLeaveGuard.current(intent))
        setError(issue instanceof Error ? issue.message : '无法打开资源所属对话');
    }
  };
  useEffect(() => {
    const target = heldNavigation.current;
    if (!target) return;
    if (target.epoch !== navigationEpoch.current) {
      heldNavigation.current = undefined;
      return;
    }
    if (detail?.run.id !== target.runId) return;
    const operation = detail.operations.find((row) => row.id === target.operationId);
    heldNavigation.current = undefined;
    if (operation?.status === 'UNCERTAIN') openVerification(operation, target.runId, target.epoch);
  }, [detail]);
  /**
   * 通过统一导航进入空会话，可显式传递已处理的离开检查；切换成功后才清除旧详情和预览。
   * EN: Navigate to an empty conversation through the shared leave flow, optionally bypassing already-handled checks; clear old details and preview only after acceptance.
   */
  const newRun = (bypass = false) => {
    navigate({ ...navigation.current, runId: '' }, true, {
      bypass,
      label: '新会话',
      /**
       * 新会话导航确认后清除旧会话详情和预览，避免界面继续显示先前内容。
       * EN: Clear prior run details and preview after new-conversation navigation is accepted.
       */
      after: () => {
        setDetail(null);
        setPreviewOpen(false);
      },
    });
  };
  /**
   * 把当前会话的完整目标放入新输入区，关闭弹窗并发起新会话导航。
   * EN: Copy the current full objective into the new input, close the modal, and initiate new-conversation navigation.
   */
  const startFromRun = () => {
    if (!detail) return;
    setDraft(detail.run.objective);
    setModal('');
    newRun();
  };
  /**
   * 把反馈中声明的动作分派到对应面板、焦点或管理入口；产物请求完整摘要，任务动作携带被阻塞任务标识。
   * EN: Dispatch feedback actions to panels, focus targets, or management views; load full artifact summaries and pass blocked-task IDs to task actions.
   */
  const feedbackAction = () => {
    switch (feedback?.action) {
      case 'artifacts':
        setPreviewOpen(false);
        setDetailsCollapsed(false);
        setDetailsDrawerOpen(true);
        setTab('artifacts');
        void loadDetailedSummary();
        break;
      case 'plan':
        setPreviewOpen(false);
        requestAnimationFrame(() => planRef.current?.scrollIntoView({ block: 'start' }));
        break;
      case 'reply':
        replyRef.current?.focus();
        break;
      case 'questions':
        focusQuestions();
        break;
      case 'archive':
        setModal('manage:archive');
        break;
      case 'settings':
        setModal('settings');
        break;
      case 'limits':
        setModal('limits');
        break;
      case 'tasks':
        openTaskDetails(feedback.blockedTaskId);
        break;
      case 'new':
        startFromRun();
        break;
    }
  };
  /**
   * 展开任务详情并请求完整统计；任务 DOM 尚未出现时保留 pendingTaskFocus 供后续定位。
   * EN: Expand task detail and request full summary; retain pendingTaskFocus until its DOM appears.
   */
  const openTaskDetails = (taskId?: string) => {
    pendingTaskFocus.current = taskId;
    setPreviewOpen(false);
    setDetailsCollapsed(false);
    setDetailsDrawerOpen(true);
    setTab('tasks');
    void loadDetailedSummary();
    requestAnimationFrame(() => {
      const target = taskId ? taskDetailRefs.current.get(taskId) : undefined;
      if (target) {
        target.scrollIntoView({ block: 'start' });
        target.focus({ preventScroll: true });
        pendingTaskFocus.current = undefined;
      }
    });
  };
  /**
   * 根据项目归属选择空间并清空会话标识，经过统一离开保护后清理旧详情，再调用后续动作。
   * EN: Select the project ownership space and clear run selection through shared leave protection, then reset prior details and run the continuation.
   */
  const selectProject = (id: string, after?: () => void, bypass = false) => {
    const owner = projects.find((p) => p.id === id);
    return navigate(
      { spaceId: owner?.spaceId || navigation.current.spaceId, projectId: id, runId: '' },
      true,
      {
        bypass,
        label: owner ? `项目「${owner.name}」` : '新建独立对话',
        /**
         * 项目切换成功后清除旧详情及预览，再执行调用方动作，避免在导航被取消时提前清空界面。
         * EN: Reset old details and preview after project navigation succeeds, then run the caller action without clearing UI on cancellation.
         */
        after: () => {
          setDetail(null);
          setPreviewOpen(false);
          after?.();
        },
      },
    );
  };
  /**
   * 管理操作完成后协调当前选择、阅读位置和关联草稿。删除运行或项目时只清理其明确
   * 所属的缓存键，其余草稿保留；最后重新读取列表并返回读取结果。
   * EN: After management reconcile selection/reading/cache. Delete only keys explicitly owned by removed run/project, preserve others, then reread lists and return result.
   */
  const managed = async (deleted?: { kind: 'project' | 'run' | 'space'; id: string; runIds?: string[] }) => {
    if (deleted) conversationHistory.remove(deleted.kind === 'run' ? [deleted.id] : deleted.runIds || []);
    if (
      (deleted?.kind === 'run' && deleted.id === runId) ||
      (deleted?.kind === 'project' && deleted.id === projectId)
    ) {
      if (deleted.kind === 'project') selectProject('', undefined, true);
      else newRun(true);
    } else if (runId) await refreshDetail();
    const refreshed = await refresh();
    if (deleted?.kind === 'run')
      setAssignmentDrafts((old) =>
        Object.fromEntries(Object.entries(old).filter(([key]) => !key.startsWith(deleted.id + ':'))),
      );
    if (deleted?.kind === 'run')
      cache.remove(
        Object.keys(cacheStateRef.current.entries).filter(
          (key) =>
            [
              `draft:run:${deleted.id}`,
              `pinned:run:${deleted.id}`,
              `unread:run:${deleted.id}`,
              `draft:terminal-continuation:${deleted.id}`,
              `draft:terminal-communication:${deleted.id}`,
              `draft:terminal-send:${deleted.id}`,
              `draft:terminal-resolution:${deleted.id}`,
              `draft:handoff:${deleted.id}`,
              `draft:delivery-review:${deleted.id}`,
              `draft:source-resolutions:${deleted.id}`,
            ].includes(key) ||
            key.startsWith(`draft:terminal-recovery:${deleted.id}:`) ||
            key.startsWith(`draft:working-state:${deleted.id}:`),
        ),
      );
    if (deleted?.kind === 'project') {
      const children = new Set(
        deleted.runIds || runs.filter((run) => run.projectId === deleted.id).map((run) => run.id),
      );
      cache.remove([
        newDraftKey(deleted.id),
        runSetupDraftKey(deleted.id),
        projectBoardKey(deleted.id),
        `draft:project-intelligence:${deleted.id}`,
        `draft:project-schedules:${deleted.id}`,
        `collapsed:project:${deleted.id}`,
        `settings:selected-terminal-profile:${deleted.id}`,
        ...Object.keys(cacheStateRef.current.entries).filter((key) => {
          const match =
            /^(?:(?:draft|pinned|unread):run:|draft:(?:working-state|handoff|delivery-review|source-resolutions):|draft:terminal-(?:continuation|recovery|communication|send|resolution):)([^:]+)(?::[^:]+)?$/.exec(
              key,
            );
          return !!match && children.has(match[1]);
        }),
      ]);
    }
    return refreshed;
  };
  /**
   * 重命名、归档或删除会话/项目时提交用户看到的 expectedRevision。
   * 版本冲突返回独立 conflict 状态并刷新记录，要求重新核对，不能自动重放修改。
   * EN: Send user-seen expectedRevision for rename/archive/delete. Conflicts return separate state and refresh records for review rather than automatically replaying edits.
   */
  const updateSession = async (
    target: SessionTarget,
    changes: Record<string, unknown>,
    remove?: boolean,
  ): Promise<SessionUpdateResult> => {
    if (target.kind === 'run' && !terminalSurface && target.item.execution?.kind === 'docker-agent') {
      setError('旧终端记录仅供查看，请在 Agent 终端入口创建新任务。');
      return false;
    }
    let conflicted = false;
    const succeeded = await act(async () => {
      const current =
        target.kind === 'run'
          ? runs.find((run) => run.id === target.item.id)
          : projects.find((project) => project.id === target.item.id);
      if (!current) throw new Error('记录已被删除，请刷新会话列表。');
      try {
        const result = await mutation<{ deletedRunIds?: string[] }>(
          `/${target.kind === 'run' ? 'runs' : 'projects'}/${current.id}`,
          { ...changes, expectedRevision: target.item.revision },
          remove ? 'DELETE' : 'PATCH',
        );
        if (remove) await managed({ kind: target.kind, id: current.id, runIds: result.deletedRunIds });
      } catch (e) {
        if (
          !(e instanceof ApiError && e.kind === 'http' && e.status === 409 && e.code === 'REVISION_CONFLICT')
        )
          throw e;
        conflicted = true;
        let message = '记录已更新，本次操作未执行。请核对列表后重新操作。';
        try {
          if ((await managed()) === false) message += '列表读取失败，请刷新会话列表后重新操作。';
        } catch (readError) {
          message +=
            '列表读取失败：' +
            (readError instanceof Error ? readError.message : String(readError)) +
            ' 请刷新会话列表后重新操作。';
        }
        throw new Error(message);
      }
    });
    return conflicted ? 'conflict' : succeeded;
  };
  const totalTokens =
    detail?.usageSummary?.totalTokens ??
    detail?.requests.reduce((s, r) => s + (r.usage?.inputTotal ?? 0) + (r.usage?.outputTotal ?? 0), 0) ??
    0;
  /**
   * 运行控制始终带当前运行版本；归档、旧入口或详情不可读时直接拒绝界面操作。
   * EN: Run controls carry current revision and reject archived/legacy-surface/unreadable-detail UI actions.
   */
  const runAction = (action: string, taskId?: string) =>
    runReadOnly
      ? Promise.resolve(false)
      : act(() =>
          mutation('/runs/' + runId + '/actions', { action, taskId, expectedRevision: detail!.run.revision }),
        );
  /**
   * 在空闲且初始化完成时切换原生/终端界面，先请求保存当前缓存，使切换前的输入进入同步流程。
   * EN: Switch native/terminal surfaces only when idle and initialized, requesting a cache flush before changing surfaces.
   */
  const switchSurface = (surface: 'native' | 'terminal') => {
    if (surface === localSurface || actionPending.current || sessionInitializing) return;
    void cache.flush();
    changeSurface(surface);
  };
  const surfaceSwitcher = (
    <SurfaceSwitcher disabled={busy || sessionInitializing} switching={false} change={switchSurface} />
  );
  /**
   * 仅为当前运行打开产物预览，避免迟到的列表点击在切换会话后展示错属资源。
   * EN: Open artifact preview only for current run so late clicks cannot show resources of another run.
   */
  function openArtifact(a: Artifact) {
    if (a.runId !== activeRunId.current) return;
    setArtifactView(a);
    setDetailsDrawerOpen(false);
    setPreviewOpen(true);
  }
  if (!ready)
    return (
      <StartupTransition>
        <div className="surface-loading-switcher">{surfaceSwitcher}</div>
        {readIssue && <p role="alert">{readIssue.message}</p>}
        {readIssue?.retryable && (
          <button
            className="secondary"
            aria-label="重试连接"
            disabled={retrying}
            aria-busy={retrying}
            onClick={() => void connect(true, readSource, readIssue.runId)}
          >
            <Icon name="refresh" size={16} />
            {retrying ? '正在重试…' : '重试连接'}
          </button>
        )}
        {readIssue && (
          <div className="auth-help">
            {readIssue.retryable ? (
              '确认本机服务正在运行后，再重试连接。'
            ) : (
              <>
                请双击 <code>Start-Elysia.vbs</code> 重新打开 Elysia。
                <br />
                重新启动服务可获取新的链接。
              </>
            )}
          </div>
        )}
      </StartupTransition>
    );
  /**
   * 首页输入器作为独立对话首页或项目工作台的自由输入区复用，草稿键仍按项目区分。
   * EN: Reuse home composer for chat home/project free input while keeping draft keys project-specific.
   */
  const workspaceHome = (
    <WorkspaceHome
      project={project}
      providers={providers}
      modelChoice={homeModel}
      changeModel={changeHomeModel}
      modelReady={
        terminalSurface
          ? !!terminalProfile && (!project || !!projectPreferences)
          : !!project || homeModelValid
      }
      setModelReady={updateHomeModelReady}
      contextReady={!!project || homeContextValid}
      contextControl={
        <button
          type="button"
          className="context-meter"
          disabled={busy}
          onClick={() => setModal('new-context')}
          title={contextPolicyLabel(homeContext)}
        >
          窗口 {homeContext.mode === 'manual' ? '手动' : '托管'}
        </button>
      }
      draft={draft}
      setDraft={setDraft}
      busy={busy}
      openSettings={() => setModal('settings')}
      start={startConversation}
      terminal={terminalSurface}
      terminalProfiles={terminalProfiles}
      terminalProfileId={terminalProfile?.id}
      changeTerminalProfile={(id) => cache.set(profileSelectionKey, id)}
      openProject={() => setModal('project')}
    />
  );
  return (
    <div
      className={
        'app-shell' +
        (sidebarCollapsed ? ' sidebar-collapsed' : '') +
        (navigationDrawerOpen ? ' navigation-open' : '')
      }
    >
      {navigationDrawerOpen && (
        <div className="navigation-backdrop" onClick={() => setNavigationOpen(false)} aria-hidden="true" />
      )}
      <aside
        className="sidebar"
        id={localSurface + '-session-navigation'}
        ref={sidebarRef}
        role={navigationDrawerOpen ? 'dialog' : undefined}
        aria-modal={navigationDrawerOpen || undefined}
        aria-label="项目与会话导航"
        inert={(narrowLayout && !navigationOpen) || detailsOverlayOpen}
        tabIndex={navigationDrawerOpen ? -1 : undefined}
      >
        <div className="brand surface-brand">
          {surfaceSwitcher}
          {narrowLayout && (
            <button
              className="icon-button mobile-nav-close"
              data-drawer-close
              onClick={() => setNavigationOpen(false)}
              aria-label="关闭会话导航"
              title="关闭会话导航 · Esc"
            >
              <Icon name="close" size={18} />
            </button>
          )}
        </div>
        <button
          className="new-task"
          onClick={() => (terminalSurface ? (project ? newRun() : setModal('project')) : selectProject(''))}
          title={terminalSurface ? '新建终端任务' : '新建独立对话'}
          aria-label={terminalSurface ? '新建终端任务' : '新建独立对话'}
        >
          <Icon name="plus" />
          <span>{terminalSurface ? '新建终端任务' : '新建独立对话'}</span>
        </button>
        <div className="space-selector">
          <label htmlFor={localSurface + '-sidebar-space'}>项目空间</label>
          <div>
            <select
              id={localSurface + '-sidebar-space'}
              value={spaceId}
              onChange={(e) => {
                navigate({ spaceId: e.target.value, projectId: '', runId: '' }, true, {
                  label: '所选项目空间',
                });
              }}
            >
              {spaces.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
            <button
              className="icon-button"
              title="管理平级项目空间"
              aria-label="管理平级项目空间"
              onClick={() => setModal('manage:spaces')}
            >
              <Icon name="settings" size={15} />
            </button>
          </div>
        </div>
        <SessionSidebar
          projects={projects}
          spaces={spaces}
          runs={runs}
          listPage={runListPage}
          listTrail={runListPosition.current.trail.length > 0}
          listBusy={runListBusy}
          listDynamic
          listError={readIssues.lists?.message}
          listReadCoverage={runListReadCoverage}
          inspectUnreadable={() => {
            setTaskCenterState({ filter: 'unavailable', before: '', trail: [] });
            setModal('task-center');
          }}
          listWindowLimited={runWindowCount + runHistoryPageSize > runHistoryWindowLimit}
          listQuery={runListQuery}
          changeListQuery={setRunListQuery}
          listNavigate={(direction) => void changeRunList(direction)}
          projectCounts={projectCounts}
          spaceId={spaceId}
          projectId={projectId}
          runId={runId}
          entries={cacheState.entries}
          busy={busy}
          error={error}
          setValue={(key, value) => cache.set(key, value)}
          selectProject={selectProject}
          selectRun={selectRun}
          create={(id, objective) => {
            if (terminalSurface && !id) return;
            selectProject(id, () => {
              if (objective !== undefined) cache.set(newDraftKey(id), objective);
              if (id && !terminalSurface)
                void cache
                  .ensureKey(projectBoardKey(id))
                  .then(() => {
                    writeProjectBoardDraft(cache, id, (value) => ({ ...value, freeOpen: true }));
                  })
                  .catch((issue) => setError(issue instanceof Error ? issue.message : '项目草稿无法读取'));
            });
          }}
          files={(target) => {
            selectProject(target.id, () => setModal('project-files'));
          }}
          manage={(tab) => setModal(tab === 'new-project' ? 'project' : `manage:${tab}`)}
          update={updateSession}
        />
        <div className="sidebar-bottom">
          <button
            className="nav-item"
            onClick={() => setModal('manage:archive')}
            title="项目、对话与归档"
            aria-label="项目、对话与归档"
            aria-haspopup="dialog"
            aria-expanded={modal.startsWith('manage:')}
          >
            <Icon name="history" />
            <span>项目与归档</span>
          </button>
          <button
            className="nav-item"
            onClick={() => setModal('settings')}
            aria-label={terminalSurface ? '终端管理' : '模型与设置'}
            title={terminalSurface ? '终端管理' : '模型与设置'}
            aria-haspopup="dialog"
            aria-expanded={modal === 'settings'}
          >
            <Icon name="settings" />
            <span>{terminalSurface ? '终端管理' : '模型与设置'}</span>
          </button>
          <details className="sidebar-tools">
            <summary title="工具与偏好" aria-label="工具与偏好">
              <Icon name="more" />
              <span>工具与偏好</span>
              <Icon name="chevron" size={14} />
            </summary>
            {!terminalSurface && (
              <button
                className="nav-item"
                onClick={() => setModal('local-agents')}
                title="Skills、记忆与 MCP"
                aria-label="Skills、记忆与 MCP"
                aria-haspopup="dialog"
                aria-expanded={modal === 'local-agents'}
              >
                <Icon name="tree" />
                <span>本机能力</span>
              </button>
            )}
            <button
              className="nav-item"
              onClick={() => setModal('appearance')}
              title="外观与启动"
              aria-label="外观与启动"
              aria-haspopup="dialog"
              aria-expanded={modal === 'appearance'}
            >
              <Icon name="spark" />
              <span>外观与启动</span>
            </button>
            <button
              type="button"
              className="nav-item"
              disabled={!ready}
              title="首次使用检查"
              aria-label="首次使用检查"
              aria-haspopup="dialog"
              aria-expanded={modal === 'readiness'}
              onClick={() => setModal('readiness')}
            >
              <Icon name="check" />
              <span>首次使用检查</span>
            </button>
          </details>
          <WorkbenchSaveStatus snapshot={cacheState} open={openPersistence} />
          <div className="local-indicator">
            <i />
            本机连接<span>v{VERSION}</span>
          </div>
        </div>
      </aside>
      <main className="main" ref={mainMotion.ref} inert={navigationDrawerOpen}>
        <header className="topbar" inert={detailsOverlayOpen}>
          <div className="breadcrumb">
            <button
              className="icon-button sidebar-toggle"
              onClick={() =>
                narrowLayout
                  ? setNavigationOpen(true)
                  : mainMotion.change(() => cache.set('collapsed:sidebar', !sidebarCollapsed))
              }
              aria-label={narrowLayout ? '打开会话导航' : sidebarCollapsed ? '展开侧栏' : '收起侧栏'}
              aria-expanded={narrowLayout ? navigationOpen : !sidebarCollapsed}
              aria-controls={localSurface + '-session-navigation'}
              title={narrowLayout ? '打开会话导航' : sidebarCollapsed ? '展开侧栏' : '收起侧栏'}
            >
              <Icon name="panel" />
              {narrowLayout && <span>会话</span>}
            </button>
            <Icon name="folder" size={16} />
            {project && !terminalSurface ? (
              <button
                type="button"
                className="breadcrumb-project quiet-button"
                title="返回项目交付工作台"
                onClick={() => selectProject(project.id)}
              >
                {project.name}
              </button>
            ) : (
              <span
                className="breadcrumb-project"
                title={project?.name || (terminalSurface ? 'Agent 终端' : '独立对话')}
              >
                {project?.name || (terminalSurface ? 'Agent 终端' : '独立对话')}
              </span>
            )}
            <span className="slash">/</span>
            <strong title={detail?.run.objective}>
              {detail
                ? detail.run.title || detail.run.objective
                : project
                  ? terminalSurface
                    ? '新建任务'
                    : '交付工作台'
                  : terminalSurface
                    ? '选择项目'
                    : '新建对话'}
            </strong>
          </div>
          <div className="topbar-right">
            <button
              className="icon-button"
              aria-label="任务中心"
              title="任务中心"
              disabled={!ready}
              onClick={() => setModal('task-center')}
            >
              <Icon name="grid" size={17} />
            </button>
            <span className="local-chip port-chip" title={location.origin}>
              <Icon name="lock" size={12} />
              本机
            </span>
            <button
              className="icon-button"
              onClick={() => void connect(true)}
              title="刷新"
              aria-label="刷新会话"
              disabled={retrying || busy}
              aria-busy={retrying}
            >
              <Icon name="refresh" size={16} />
            </button>
          </div>
        </header>
        {error && (
          <div className="error-banner" role="alert">
            <span>{error}</span>
            <button className="icon-button" onClick={() => setError('')} aria-label="关闭错误">
              <Icon name="close" size={16} />
            </button>
          </div>
        )}
        {readIssue && (
          <div className="error-banner" role="alert">
            <span>
              {readIssue.message}
              {readIssue.reopen && ' 请双击 Start-Elysia.vbs 重新打开 Elysia。'}
            </span>
            {readIssue.retryable && (
              <button
                className="secondary"
                aria-label="重试连接"
                disabled={retrying || busy}
                aria-busy={retrying}
                onClick={() => void connect(true, readSource, readIssue.runId)}
              >
                <Icon name="refresh" size={16} />
                {retrying ? '正在重试…' : '重试连接'}
              </button>
            )}
            <button
              className="icon-button"
              onClick={() => readSource && clearReadIssue(readSource)}
              aria-label="关闭连接错误"
            >
              <Icon name="close" size={16} />
            </button>
          </div>
        )}
        {!runId ? (
          project && !terminalSurface ? (
            <ProjectWorkbench
              key={project.id}
              project={project}
              cache={cache}
              navigationLifecycle={workbenchNavigation}
              raw={cacheState.entries[projectBoardKey(project.id)]?.value}
              freeComposer={workspaceHome}
              launch={() => setModal('project-item-run')}
              openTaskCenter={() => {
                setTaskCenterState((value) => ({ ...value, projectId: project.id, before: '', trail: [] }));
                setModal('task-center');
              }}
              openRun={async (id, review) => {
                const epoch = navigationEpoch.current,
                  intent = projectLeaveGuard.begin();
                try {
                  const target = await api<Run>('/runs/' + id + '/header');
                  if (
                    epoch !== navigationEpoch.current ||
                    !projectLeaveGuard.current(intent) ||
                    navigation.current.runId ||
                    navigation.current.projectId !== project.id
                  )
                    return;
                  selectRun(target, {
                    intent,
                    /**
                     * 进入目标会话后按需打开任务复核入口，等待导航成功再定位任务。
                     * EN: Open task review when requested after navigating successfully to the owning run.
                     */
                    after: () => {
                      if (review) openTaskCenterTarget(id, 'review');
                    },
                  });
                } catch (issue) {
                  if (projectLeaveGuard.current(intent)) throw issue;
                }
              }}
            />
          ) : (
            workspaceHome
          )
        ) : detail ? (
          <>
            <div
              className="run-toolbar"
              inert={detailsOverlayOpen}
              ref={runStatusRef}
              tabIndex={-1}
              aria-label="执行状态"
            >
              <div className="run-status">
                <Badge status={feedback?.displayStatus || detail.run.status} />
                <span className="run-reason" title={feedback?.text}>
                  {feedback?.text}
                </span>
                {connection !== 'connected' && (
                  <span className="connection-status" role="status">
                    {connection === 'reconnecting' ? '实时连接中断，正在重连…' : '正在连接实时更新…'}
                  </span>
                )}
              </div>
              <div className="run-controls">
                <button
                  className="quiet-button"
                  aria-expanded={conversationSearchOpen}
                  onClick={() => setConversationSearchOpen((value) => !value)}
                >
                  <Icon name="search" size={14} />
                  搜索正文
                </button>
                <button
                  className="quiet-button details-toggle"
                  aria-expanded={detailsVisible}
                  aria-controls={localSurface + '-run-details'}
                  onClick={() => {
                    setPreviewOpen(false);
                    if (compactLayout) setDetailsDrawerOpen(!detailsVisible);
                    else setDetailsCollapsed(detailsVisible);
                    if (
                      !detailsVisible &&
                      detail.summaryDeferred &&
                      ['agents', 'artifacts', 'usage'].includes(tab)
                    )
                      void loadDetailedSummary();
                  }}
                >
                  <Icon name="panel" size={14} />
                  {detailsVisible ? '收起详情' : isChat ? '模型与用量' : '任务详情'}
                </button>
                <button className="quiet-button" onClick={() => setModal('manage:runs')}>
                  <Icon name="history" size={14} />
                  管理对话
                </button>
                <button
                  className="quiet-button preview-toggle"
                  aria-pressed={previewOpen}
                  aria-expanded={previewOpen}
                  aria-controls={localSurface + '-run-preview'}
                  onClick={() => setPreviewOpen(!previewOpen)}
                >
                  <Icon name="panel" size={14} />
                  {previewOpen ? '收起预览' : '打开预览'}
                </button>
                {!isChat && (
                  <button className="quiet-button" onClick={() => setModal('contract')}>
                    <Icon name="file" size={14} />
                    任务约定
                  </button>
                )}
                {isChat && !terminalSurface && !archived && (
                  <button className="quiet-button" disabled={busy} onClick={() => setModal('handoff')}>
                    <Icon name="arrow" size={14} />
                    在项目中执行
                  </button>
                )}
                {feedback?.action && !legacyTerminal && (
                  <button className="quiet-button run-next-action" disabled={busy} onClick={feedbackAction}>
                    <Icon
                      name={
                        feedback.action === 'limits' ? 'chart' : feedback.action === 'new' ? 'plus' : 'arrow'
                      }
                      size={14}
                    />
                    {
                      {
                        artifacts: detail.run.status === 'DONE' ? '查看产物' : '查看待核验操作',
                        plan: '查看计划',
                        reply: '补充回答',
                        questions: '查看问题',
                        archive: '查看归档',
                        limits: '查看限制',
                        settings: '管理模型用量',
                        tasks: '查看阻塞分支',
                        new: isChat ? '新建独立对话' : '新建任务',
                      }[feedback.action]
                    }
                  </button>
                )}
                {feedback?.limit && feedback.action !== 'limits' && (
                  <button className="quiet-button" disabled={busy} onClick={() => setModal('limits')}>
                    <Icon name="chart" size={14} />
                    查看限制
                  </button>
                )}
                {resumeTask && modelTaskCanContinue(resumeTask) && (
                  <button
                    className="quiet-button"
                    disabled={
                      busy ||
                      !!resumeTaskReason ||
                      (!detail.run.authorized && resumeTask.phase !== 'planning')
                    }
                    title={resumeTaskReason || '按已有授权继续总代理，累计预算保持'}
                    onClick={() => void runAction('resume_task', resumeTask.id)}
                  >
                    <Icon name="play" size={14} />
                    继续总代理
                  </button>
                )}
                {feedback?.control === 'pause' ? (
                  <button
                    className="quiet-button"
                    disabled={busy || runReadOnly}
                    onClick={() => void runAction('pause')}
                  >
                    <Icon name="pause" size={14} />
                    {detail.run.status === 'WAITING' && detail.run.reason === 'rate_limit'
                      ? '暂停自动重试'
                      : '暂停'}
                  </button>
                ) : (
                  (feedback?.control === 'resume' || feedback?.control === 'retry') && (
                    <button
                      className="quiet-button"
                      disabled={busy || runReadOnly}
                      title={feedback.control === 'retry' ? '按已有授权重试，累计预算保持' : undefined}
                      onClick={() => void runAction('resume')}
                    >
                      <Icon name="play" size={14} />
                      {detail.localExecutionStopped
                        ? '恢复本机调度'
                        : feedback.control === 'retry'
                          ? '重试'
                          : '恢复'}
                    </button>
                  )
                )}
                {!['DONE', 'CANCELLED'].includes(detail.run.status) && (
                  <button
                    className="quiet-button danger"
                    disabled={busy || runReadOnly}
                    onClick={() => void runAction('cancel')}
                  >
                    <Icon name="stop" size={14} />
                    取消
                  </button>
                )}
              </div>
            </div>
            <DetailReadNotice
              key={detail.run.id}
              detail={detail}
              busy={busy || retryingDetailRun === detail.run.id}
              retry={() => void retryDetailRecords()}
              retryPreview={() => void retryDetailRecords(false)}
              finished={['DONE', 'CANCELLED'].includes(detail.run.status)}
              clearHold={
                !archived &&
                !legacyTerminal &&
                ['DONE', 'CANCELLED'].includes(detail.run.status) &&
                detail.localExecutionStopped
                  ? () => runAction('resume')
                  : undefined
              }
              stop={
                !archived && !legacyTerminal && !['DONE', 'CANCELLED'].includes(detail.run.status)
                  ? async () => {
                      let result: RunStopCurrentResult | undefined;
                      await act(async () => {
                        result = await mutation<RunStopCurrentResult>('/runs/' + detail.run.id + '/actions', {
                          action: 'stop_current',
                          expectedRevision: detail.run.revision,
                        });
                      });
                      if (!result) throw new Error('停止请求未确认，请检查提示后重试。');
                      return result;
                    }
                  : undefined
              }
            />
            <div
              key={detail.run.id}
              className={'run-layout' + (previewOpen ? ' preview-open' : '') + (isChat ? ' chat-layout' : '')}
            >
              <section className="conversation" inert={detailsOverlayOpen}>
                {conversationSearchOpen && (
                  <React.Suspense
                    fallback={
                      <p className="field-help" role="status">
                        正在载入搜索…
                      </p>
                    }
                  >
                    <ConversationSearch
                      embedded
                      onClose={() => setConversationSearchOpen(false)}
                      runId={detail.run.id}
                      disabled={historyLoading}
                      activeMessageId={historyPosition.current.around}
                      onSelect={(messageId) => changeHistory('', [], messageId)}
                    />
                  </React.Suspense>
                )}
                <ConversationScroll
                  positionKey={detail.run.id + ':' + historySegment}
                  startAtLatest={
                    !detail.messagePage?.before && !detail.messagePage?.hasNewer && !initialHistoryAnchor
                  }
                  initialAnchor={initialHistoryAnchor}
                  onCheckpoint={(reading) =>
                    conversationHistory.set(detail.run.id, {
                      ...reading,
                      following:
                        reading.following && !detail.messagePage?.before && !detail.messagePage?.hasNewer,
                      before: detail.messagePage?.before,
                      around: detail.messagePage?.anchorMessageId,
                    })
                  }
                  onReturnLatest={() => void changeHistory('', [])}
                  olderCursor={
                    detail.messages.length + messageHistoryPageSize <= messageHistoryWindowLimit
                      ? detail.messagePage?.nextBefore
                      : undefined
                  }
                  olderLoading={historyLoading}
                  olderError={
                    readIssues.detail?.runId === detail.run.id ? readIssues.detail.message : undefined
                  }
                  onLoadOlder={() =>
                    detail.messagePage?.nextBefore &&
                    void changeHistory(detail.messagePage.nextBefore, [
                      ...historyPosition.current.trail,
                      historyPosition.current.before,
                    ])
                  }
                >
                  {(detail.messagePage?.hasMore ||
                    detail.messagePage?.before ||
                    detail.messagePage?.hasNewer) && (
                    <nav className="conversation-pages" aria-label="对话历史分页">
                      <button
                        className="secondary"
                        disabled={historyLoading || !detail.messagePage?.nextBefore}
                        onClick={() =>
                          void changeHistory(detail.messagePage!.nextBefore!, [
                            ...historyPosition.current.trail,
                            historyPosition.current.before,
                          ])
                        }
                      >
                        {detail.messages.length + messageHistoryPageSize > messageHistoryWindowLimit
                          ? '继续更早消息'
                          : '更早消息'}
                      </button>
                      <span role="status">
                        {historyLoading
                          ? '读取历史…'
                          : detail.messagePage?.before || detail.messagePage?.hasNewer
                            ? `已加载 ${detail.messages.length} 条历史${detail.messages.length + messageHistoryPageSize > messageHistoryWindowLimit ? ' · 继续将切换历史段落' : ''}`
                            : '最近消息'}
                      </span>
                      {(detail.messagePage?.before || detail.messagePage?.hasNewer) && (
                        <>
                          <button
                            className="secondary"
                            disabled={historyLoading}
                            onClick={() => {
                              const trail = [...historyPosition.current.trail];
                              void changeHistory(trail.pop() || '', trail);
                            }}
                          >
                            更新消息
                          </button>
                          <button
                            className="text-button"
                            disabled={historyLoading}
                            onClick={() => void changeHistory('', [])}
                          >
                            返回最新
                          </button>
                        </>
                      )}
                    </nav>
                  )}
                  {legacyTerminal && (
                    <div className="system-note">
                      <Icon name="history" size={14} />
                      <span>旧终端记录 · 只读。新任务请切换到 Agent 终端。</span>
                    </div>
                  )}
                  {!isChat && (
                    <div className="user-message">
                      <div className="message-avatar user">你</div>
                      <div>
                        <span className="message-label">
                          {isChat ? '独立对话 · 你' : `任务目标 · ${project?.name || '项目'}`}
                        </span>
                        <p>{detail.run.objective}</p>
                      </div>
                    </div>
                  )}
                  {archived && (
                    <div className="system-note archive-note">
                      <Icon name="history" size={14} />
                      <span>{archiveFeedback(detail.run, !!project?.archived)}</span>
                      <button className="text-button" onClick={() => setModal('manage:archive')}>
                        查看归档
                      </button>
                    </div>
                  )}
                  {detail.run.source && <SourceSummary source={detail.run.source} />}
                  {!terminalSurface && !legacyTerminal && (
                    <RunRevisionLinks
                      key={`revisions:${detail.run.id}`}
                      runId={detail.run.id}
                      openRun={selectRun}
                    />
                  )}
                  {!isChat && (
                    <div className="system-note">
                      <Icon name="lock" size={14} />
                      <span>
                        授权：读取{detail.run.contract.permissionProfile.write ? ' · 指定目录写入' : ''}
                        {detail.run.contract.permissionProfile.exec ? ' · 命令执行' : ''} ·{' '}
                        {detail.run.contract.permissionProfile.urls.length} 个网页来源。
                        {detail.run.planMode === false
                          ? '在创建时授权范围内执行。'
                          : !detail.run.acceptedPlanVersion && '计划接受后开始执行。'}
                        {detail.run.execution?.kind === 'docker-agent' &&
                          ` Docker · ${detail.run.execution.profile.label}`}
                      </span>
                    </div>
                  )}
                  {visibleMessages.map((m) => {
                    if (m.purpose === 'runtime_notice')
                      return (
                        <div className="system-note model-handoff" key={m.id} data-history-anchor={m.id}>
                          <Icon name="history" size={14} />
                          <details>
                            <summary>运行提醒</summary>
                            <pre>{m.text}</pre>
                          </details>
                        </div>
                      );
                    if (m.purpose === 'model_handoff')
                      return (
                        <div className="system-note model-handoff" key={m.id} data-history-anchor={m.id}>
                          <Icon name="history" size={14} />
                          <details>
                            <summary>模型已切换，已保留对话交接</summary>
                            <pre>{m.text}</pre>
                          </details>
                        </div>
                      );
                    const request = messageIndex.requests.get(m.requestId || '');
                    const agent =
                      messageIndex.sessions.get(m.sessionId) ||
                      messageIndex.agents.get(request?.taskId || '');
                    const task = messageIndex.tasks.get(agent?.taskId || '');
                    return (
                      <div className={'message ' + m.role} key={m.id} data-history-anchor={m.id}>
                        <div className={'message-avatar ' + m.role}>
                          {m.role === 'user' ? (
                            '你'
                          ) : m.role === 'tool' ? (
                            <Icon name="code" size={17} />
                          ) : (
                            <Icon name={task?.spec.role === 'coordinator' ? 'spark' : 'tree'} size={17} />
                          )}
                        </div>
                        <div className="message-body">
                          <div className="message-label">
                            {m.role === 'tool'
                              ? '工具返回'
                              : m.role === 'user'
                                ? isChat || isInboxUserMessage(m)
                                  ? '你'
                                  : '用户 / 交接'
                                : task?.spec.role === 'coordinator'
                                  ? isChat
                                    ? '助手'
                                    : '总代理'
                                  : task?.spec.title || 'Agent'}
                            <small>
                              {m.role === 'assistant'
                                ? request?.providerBinding.model || agent?.providerBinding.model
                                : ''}
                            </small>
                          </div>
                          {!terminalSurface &&
                          m.role === 'assistant' &&
                          (m.reasoning?.characters || m.reasoning?.readUnavailable) ? (
                            <ReasoningView
                              runId={detail.run.id}
                              messageId={m.id}
                              requestId={m.requestId}
                              reasoning={m.reasoning}
                              readings={reasoningReadings.current}
                            />
                          ) : null}
                          {m.text &&
                            (m.role === 'tool' ? (
                              <details open={initialHistoryAnchor?.id === m.id || undefined}>
                                <summary>查看结果</summary>
                                <pre>{m.text}</pre>
                              </details>
                            ) : m.role === 'assistant' ? (
                              <MarkdownDocument
                                text={m.text}
                                onLocalLink={
                                  task && detail.run.contract.permissionProfile.read
                                    ? previewFileLinks.get(task.id)
                                    : undefined
                                }
                              />
                            ) : (
                              <p>{m.text}</p>
                            ))}
                          {!!m.calls?.length && (
                            <section className="tool-process" aria-label="工具调用与操作过程">
                              <div className="tool-process-heading">
                                <span>操作过程</span>
                                <small>本轮 {m.calls.length} 项工具调用</small>
                              </div>
                              <ol className="tool-process-calls" aria-label="按请求顺序列出的工具调用">
                                {m.calls.map((c, index) => (
                                  <li key={`${c.id}:${index}`}>
                                    <ToolActivity
                                      invocationLabel={`调用 ${index + 1}`}
                                      call={c}
                                      operation={messageIndex.operations.get(conversationCallKey(m.id, c.id))}
                                      toolResponse={messageIndex.responses.get(
                                        conversationCallKey(m.id, c.id),
                                      )}
                                      focused={
                                        !!initialHistoryAnchor?.id &&
                                        initialHistoryAnchor.id ===
                                          messageIndex.responses.get(conversationCallKey(m.id, c.id))?.id
                                      }
                                      taskStatus={task?.status}
                                    />
                                  </li>
                                ))}
                              </ol>
                            </section>
                          )}
                        </div>
                      </div>
                    );
                  })}
                  {(streamRun.current === detail.run.id
                    ? [...new Set([...Object.keys(streaming), ...Object.keys(streamingReasoning)])]
                    : []
                  )
                    .filter(
                      (taskId) =>
                        (streaming[taskId] || streamingReasoning[taskId]) &&
                        !detail.messagePage?.before &&
                        !detail.messages.some(
                          (message) =>
                            message.requestId && message.requestId === streamingReasoning[taskId]?.requestId,
                        ),
                    )
                    .map((taskId) => (
                      <div className="message assistant" key={taskId}>
                        <div className="message-avatar assistant">
                          <Icon name="spark" size={17} />
                        </div>
                        <div className="message-body">
                          <div className="message-label">
                            {streaming[taskId] ? '正在生成回答' : '正在思考'}
                            <span className="typing-dot" />
                          </div>
                          {!terminalSurface && streamingReasoning[taskId] && (
                            <ReasoningView
                              runId={detail.run.id}
                              requestId={streamingReasoning[taskId].requestId}
                              reasoning={streamingReasoning[taskId]}
                              liveText={streamingReasoning[taskId].text}
                              readings={reasoningReadings.current}
                              onPage={(text, offset) => {
                                if (activeRunId.current !== detail.run.id) return;
                                runStream.current.seedReasoning(
                                  taskId,
                                  streamingReasoning[taskId].requestId,
                                  text,
                                  offset,
                                );
                                setStreaming(runStream.current.texts());
                                setStreamingReasoning(runStream.current.reasonings());
                              }}
                            />
                          )}
                          {streaming[taskId] && (
                            <MarkdownDocument
                              text={streaming[taskId]}
                              onLocalLink={
                                detail.run.contract.permissionProfile.read
                                  ? previewFileLinks.get(taskId)
                                  : undefined
                              }
                            />
                          )}
                        </div>
                      </div>
                    ))}
                  {!terminalSurface &&
                    detail.requests
                      .filter(
                        (request) =>
                          !detail.messagePage?.before &&
                          request.reasoning?.status === 'interrupted' &&
                          (request.reasoning.characters || request.reasoning.readUnavailable) &&
                          !detail.messages.some((message) => message.requestId === request.id),
                      )
                      .map((request) => (
                        <div
                          className="message"
                          key={`reasoning:${request.id}`}
                          data-reasoning-request={request.id}
                        >
                          <div className="message-avatar assistant">
                            <Icon name="history" size={17} />
                          </div>
                          <div className="message-body">
                            <div className="message-label">
                              已中断的思考 ·{' '}
                              {messageIndex.tasks.get(request.taskId)?.spec.title || '模型请求'}
                            </div>
                            <ReasoningView
                              runId={detail.run.id}
                              requestId={request.id}
                              reasoning={request.reasoning!}
                              readings={reasoningReadings.current}
                            />
                          </div>
                        </div>
                      ))}
                  {detail.tasks
                    .filter(
                      (t) =>
                        t.status === 'RUNNING' &&
                        !streaming[t.id] &&
                        !streamingReasoning[t.id] &&
                        !detail.messagePage?.before,
                    )
                    .map((t) => (
                      <div
                        className="message assistant pending-response"
                        key={'pending:' + t.id}
                        role="status"
                      >
                        <div className="message-avatar assistant">
                          <Icon name="spark" size={17} />
                        </div>
                        <div className="message-body">
                          <div className="message-label">
                            {isChat ? '助手' : t.spec.title}
                            <span className="typing-dot" />
                          </div>
                          <p>
                            {detail.operations.some((o) => o.taskId === t.id && o.status === 'INTENT')
                              ? '正在执行工具，结果会自动更新…'
                              : detail.detailCoverage?.operations.complete === false
                                ? '部分操作记录无法读取，正在等待可用进度…'
                                : '正在等待模型响应…'}
                          </p>
                        </div>
                      </div>
                    ))}
                  {questionNotice && (
                    <div className="question-card" ref={questionRef} tabIndex={-1}>
                      <p role="status">{questionNotice}</p>
                      <button
                        type="button"
                        className="text-button"
                        disabled={retryingDetailRun === runId}
                        onClick={() => void retryDetailRecords(false)}
                      >
                        {retryingDetailRun === runId
                          ? '正在核对问题…'
                          : detail.currentQuestions?.coverage.limited
                            ? '重新核对问题'
                            : '重试读取问题'}
                      </button>
                    </div>
                  )}
                  {questions.map((question, index) => (
                    <div
                      className="question-card"
                      key={question.eventId}
                      id={`${localSurface}-question-${question.taskId}`}
                      ref={!questionNotice && index === 0 ? questionRef : undefined}
                      tabIndex={-1}
                    >
                      <span className="eyebrow">需要你的输入 · {question.title}</span>
                      {question.questions.map((q, i) => (
                        <p key={i}>
                          {i + 1}. {q}
                        </p>
                      ))}
                    </div>
                  ))}
                  {detail.run.plan && (
                    <PlanAlignmentLoader
                      key={`plan:${detail.run.id}`}
                      anchorRef={planRef}
                      detail={detail}
                      providers={providers}
                      assignments={assignments}
                      assignmentReady={assignmentReady}
                      proposedChoice={proposedChoice}
                      busy={busy || !!detailReadOnlyReason}
                      archived={archived || legacyTerminal}
                      readOnlyReason={detailReadOnlyReason}
                      changeAssignment={(key, choice) =>
                        setAssignmentDrafts((old) => ({
                          ...old,
                          [assignmentKey]: { ...old[assignmentKey], [key]: choice },
                        }))
                      }
                      readyAssignment={(key, valid) =>
                        setAssignmentReady((old) => (old[key] === valid ? old : { ...old, [key]: valid }))
                      }
                      accept={() =>
                        !runReadOnly &&
                        void act(() =>
                          mutation('/runs/' + runId + '/plan/accept', {
                            expectedRevision: detail.run.revision,
                            version: detail.run.plan!.version,
                            assignments: detail.run
                              .plan!.tasks.filter(
                                (task) =>
                                  !Object.hasOwn(detail.run.planRouting ?? {}, task.key) ||
                                  Object.hasOwn(assignments, task.key),
                              )
                              .map((task) => ({
                                key: task.key,
                                ...(Object.hasOwn(assignments, task.key)
                                  ? assignments[task.key]
                                  : proposedChoice(task)),
                              })),
                          }),
                        )
                      }
                    />
                  )}
                  {detail.run.execution?.kind === 'docker-agent' &&
                    detail.run.reason === 'terminal_review' && (
                      <div
                        className="delivery-card"
                        ref={terminalReviewRef}
                        tabIndex={-1}
                        aria-label="终端交付验收"
                      >
                        <Icon name="terminal" size={24} />
                        <div>
                          <h3>Agent 终端已结束，等待验收</h3>
                          <p>在右侧查看终端记录和文件差异，确认交付符合约定后验收。</p>
                          <button
                            type="button"
                            className="text-button"
                            onClick={() => {
                              const operation = detail.operations
                                .filter((item) => item.name === 'terminal_agent')
                                .at(-1);
                              const transcriptId = (operation?.result as any)?.transcriptArtifactId;
                              const artifact =
                                detail.artifacts.find((item) => item.id === transcriptId) ??
                                detail.artifacts[0];
                              if (artifact) openArtifact(artifact);
                              else setPreviewOpen(true);
                            }}
                          >
                            查看日志与差异
                          </button>
                          <button
                            type="button"
                            className="primary"
                            disabled={busy || runReadOnly}
                            onClick={() =>
                              void act(() =>
                                mutation('/runs/' + detail.run.id + '/terminal/accept', {
                                  expectedRevision: detail.run.revision,
                                }),
                              )
                            }
                          >
                            确认交付并验收
                          </button>
                          {!runReadOnly && (
                            <TerminalContinuation
                              key={detail.run.id}
                              run={detail.run}
                              messageRevision={Math.max(
                                0,
                                ...detail.events
                                  .filter((event) =>
                                    [
                                      'inbox.received',
                                      'terminal.inbox_applied',
                                      'terminal.message_resolved',
                                    ].includes(event.type),
                                  )
                                  .map((event) => event.seq),
                              )}
                              disabled={busy}
                              act={act}
                              draft={readContinuationDraft(
                                cacheState.entries[`draft:terminal-continuation:${detail.run.id}`]?.value,
                              )}
                              changeDraft={(value) =>
                                cache.set(
                                  `draft:terminal-continuation:${detail.run.id}`,
                                  JSON.stringify(value),
                                )
                              }
                              submitted={(sent) => {
                                const key = `draft:terminal-continuation:${detail.run.id}`;
                                const current = readContinuationDraft(cache.get(key));
                                if (
                                  JSON.stringify(current) ===
                                  JSON.stringify(readContinuationDraft(JSON.stringify(sent)))
                                )
                                  cache.set(
                                    key,
                                    JSON.stringify({ mode: current.mode, text: '', inboxIds: [] }),
                                  );
                              }}
                            />
                          )}
                        </div>
                      </div>
                    )}
                  {detail.run.execution?.kind === 'docker-agent' && (
                    <div className="terminal-activity">
                      <h4>Docker 终端 · {detail.run.execution.profile.label}</h4>
                      {detail.events.some((event) => event.type === 'terminal.output') && (
                        <pre role="log" aria-label="终端公开输出">
                          {detail.events
                            .filter((event) => event.type === 'terminal.output')
                            .map((event) => String(event.payload?.text ?? ''))
                            .join('')
                            .slice(-16000)}
                        </pre>
                      )}
                      {!!detail.tasks.find((task) => task.id === detail.run.rootTaskId)?.result && (
                        <p className="field-help">
                          {String(
                            (detail.tasks.find((task) => task.id === detail.run.rootTaskId)?.result as any)
                              ?.terminal?.message ?? '',
                          )}
                        </p>
                      )}
                      <p className="field-help">
                        完整记录保存为产物，可在右侧预览。中断时保留工作目录，通过核验入口决定验收或暂停后手动恢复。
                      </p>
                    </div>
                  )}
                  {terminalSurface && detail.run.execution?.kind === 'docker-agent' && (
                    <TerminalCommunication
                      key={detail.run.id}
                      run={detail.run}
                      messageRevision={Math.max(
                        0,
                        ...detail.events
                          .filter((event) =>
                            [
                              'inbox.received',
                              'terminal.inbox_applied',
                              'terminal.message_resolved',
                            ].includes(event.type),
                          )
                          .map((event) => event.seq),
                      )}
                      disabled={busy || runReadOnly}
                      draft={readTerminalCommunicationDraft(
                        cacheState.entries[`draft:terminal-communication:${detail.run.id}`]?.value,
                      )}
                      changeDraft={(value) =>
                        cache.set(`draft:terminal-communication:${detail.run.id}`, JSON.stringify(value))
                      }
                      resolutionDraft={readTerminalResolutionDraft(
                        cacheState.entries[`draft:terminal-resolution:${detail.run.id}`]?.value,
                      )}
                      changeResolutionDraft={(value) =>
                        cache.set(
                          `draft:terminal-resolution:${detail.run.id}`,
                          value ? JSON.stringify(value) : '',
                        )
                      }
                      resolutionSubmitted={(sent) => {
                        const key = `draft:terminal-resolution:${detail.run.id}`;
                        if (
                          JSON.stringify(readTerminalResolutionDraft(cache.get(key))) ===
                          JSON.stringify(readTerminalResolutionDraft(JSON.stringify(sent)))
                        )
                          cache.set(key, '');
                      }}
                      submitted={(sent) => {
                        const key = `draft:terminal-communication:${detail.run.id}`;
                        if (
                          JSON.stringify(readTerminalCommunicationDraft(cache.get(key))) ===
                          JSON.stringify(readTerminalCommunicationDraft(JSON.stringify(sent)))
                        )
                          cache.set(key, JSON.stringify({ targetRunId: sent.targetRunId, text: '' }));
                      }}
                      onNavigate={(target) => void openResourceOwner(target)}
                    />
                  )}
                  {detail.terminalRuntime && (
                    <TerminalRuntimePanel
                      snapshot={detail.terminalRuntime}
                      tasks={detail.tasks}
                      onNavigate={(runId, operationId) => void openResourceOwner(runId, operationId)}
                    />
                  )}
                  {detail.run.execution?.kind === 'docker-agent' &&
                    detail.run.reason === 'terminal_verification' &&
                    detail.operations
                      .filter(
                        (operation) =>
                          operation.name === 'terminal_agent' && operation.status === 'UNCERTAIN',
                      )
                      .map((operation) => (
                        <div
                          key={operation.id}
                          ref={(element) => {
                            if (element) terminalRecoveryRefs.current.set(operation.id, element);
                            else terminalRecoveryRefs.current.delete(operation.id);
                          }}
                          tabIndex={-1}
                          aria-label="终端操作核验"
                        >
                          <TerminalRecovery
                            disabled={busy || runReadOnly}
                            note={
                              typeof cacheState.entries[
                                `draft:terminal-recovery:${detail.run.id}:${operation.id}`
                              ]?.value === 'string'
                                ? (cacheState.entries[
                                    `draft:terminal-recovery:${detail.run.id}:${operation.id}`
                                  ].value as string)
                                : ''
                            }
                            changeNote={(note) =>
                              cache.set(`draft:terminal-recovery:${detail.run.id}:${operation.id}`, note)
                            }
                            submit={(outcome, note) =>
                              void act(async () => {
                                const key = `draft:terminal-recovery:${detail.run.id}:${operation.id}`;
                                const sent = cache.get(key);
                                await mutation('/runs/' + detail.run.id + '/terminal/verify', {
                                  expectedRevision: detail.run.revision,
                                  operationId: operation.id,
                                  outcome,
                                  note,
                                });
                                if (cache.get(key) === sent) cache.set(key, '');
                              })
                            }
                          />
                        </div>
                      ))}
                  {!isChat &&
                    detail.run.status === 'DONE' &&
                    (!terminalSurface && !legacyTerminal ? (
                      <DeliveryStatusCard
                        key={`delivery:${detail.run.id}`}
                        runId={detail.run.id}
                        version={`${detail.run.revision}:${detail.tasks.find((task) => task.id === detail.run.rootTaskId)?.revision}:${detail.recordVersions?.artifacts}`}
                        open={() => setModal('delivery')}
                      />
                    ) : (
                      <div className="delivery-card">
                        <Icon name="check" size={24} />
                        <div>
                          <h3>交付已通过证据核验</h3>
                          <p>查看右侧产物和差异，复核内容是否符合你的目标。</p>
                          {!terminalSurface && !legacyTerminal && (
                            <button className="text-button" onClick={() => setModal('delivery')}>
                              逐项查看交付与验收
                            </button>
                          )}
                        </div>
                      </div>
                    ))}
                </ConversationScroll>
                {['DONE', 'CANCELLED'].includes(detail.run.status) ? (
                  <div className="conversation-ended">
                    <Icon name={detail.run.status === 'DONE' ? 'check' : 'stop'} size={18} />
                    <span>
                      {isChat
                        ? '本次对话已结束'
                        : detail.run.status === 'DONE'
                          ? '本次任务已完成'
                          : '本次任务已取消'}
                    </span>
                    <button
                      className="secondary"
                      onClick={() => {
                        if (isChat) {
                          selectProject('');
                          return;
                        }
                        setPreviewOpen(false);
                        setTab('artifacts');
                        setDetailsCollapsed(false);
                        setDetailsDrawerOpen(true);
                        void loadDetailedSummary();
                      }}
                    >
                      {isChat ? '新建独立对话' : '查看产物'}
                      <Icon name="arrow" size={14} />
                    </button>
                    {!isChat &&
                      !terminalSurface &&
                      !legacyTerminal &&
                      !archived &&
                      detail.run.status === 'DONE' && (
                        <button className="primary" disabled={busy} onClick={() => setModal('handoff')}>
                          提出修改
                        </button>
                      )}
                  </div>
                ) : (
                  <form
                    className="reply-box"
                    onSubmit={(e) => {
                      e.preventDefault();
                      sendReply();
                    }}
                  >
                    <textarea
                      ref={replyRef}
                      aria-label="回复或补充需求"
                      maxLength={20000}
                      value={reply}
                      onChange={(e) => {
                        markReplyChanged();
                        cache.set(replyKey, e.target.value);
                      }}
                      onKeyDown={(e) => {
                        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && !e.nativeEvent.isComposing) {
                          e.preventDefault();
                          sendReply();
                        }
                      }}
                      placeholder={
                        detailReadOnlyReason
                          ? '执行记录暂不可读，输入仍可保留为草稿'
                          : legacyTerminal
                            ? '旧终端记录仅供查看'
                            : archived
                              ? '恢复归档后可继续对话'
                              : isChat
                                ? '继续对话…'
                                : '回答问题，或补充需求…'
                      }
                      disabled={
                        archived || legacyTerminal || ['DONE', 'CANCELLED'].includes(detail.run.status)
                      }
                    />
                    {canChooseReplyIntent &&
                      !runReadOnly &&
                      !['DONE', 'CANCELLED'].includes(detail.run.status) && (
                        <div className="reply-intent">
                          <label>
                            本次补充
                            <select
                              aria-label="补充处理方式"
                              aria-describedby={`reply-intent-help-${localSurface}`}
                              value={replyIntent}
                              onChange={(e) => {
                                markReplyChanged();
                                const value = e.target.value === 'replan' ? 'replan' : 'continue';
                                setReplyIntents((current) => new Map(current).set(replyIntentKey, { value }));
                              }}
                            >
                              <option value="continue">按原约定继续</option>
                              <option value="replan">重新规划</option>
                            </select>
                          </label>
                          <p className="field-help" id={`reply-intent-help-${localSurface}`}>
                            {replyIntent === 'replan'
                              ? '发送后旧计划将失效，未完成子任务会取消；重新规划后需再次接受计划。'
                              : detail.run.authorized
                                ? '在原约定内补充，不重复确认计划；保留授权、子任务和累计预算。暂停或待核验的任务仍需在对应入口处理。'
                                : '补充说明后继续核对约定与计划，执行前仍需接受计划；权限和累计预算不变。'}
                          </p>
                        </div>
                      )}
                    {!isChat &&
                      !canChooseReplyIntent &&
                      !runReadOnly &&
                      !['DONE', 'CANCELLED'].includes(detail.run.status) &&
                      (detail.run.authorized || detail.run.plan) && (
                        <p className="field-help reply-guidance">
                          {detail.run.execution?.kind === 'docker-agent'
                            ? '补充需求进入待处理队列。运行中不会打断 CLI；正常结束后在“补充需求并继续”中选择消息。暂停和中断须先恢复或核验。'
                            : '补充消息会在安全边界送入当前任务；权限和累计预算保持。'}
                        </p>
                      )}
                    {pendingReplyReceipt && (
                      <p className="field-help reply-guidance" role="status">
                        {busy
                          ? '正在核对本次发送结果…'
                          : `上次${pendingReplyReceipt.intent === 'replan' ? '重新规划' : '补充'}发送结果待核对；重试沿用原请求，修改正文或处理方式将发送新请求。`}
                      </p>
                    )}
                    <div>
                      <div className="reply-model-controls">
                        <ComposerModelControl
                          key={runId}
                          modelLabel={
                            detail.run.execution?.kind === 'docker-agent'
                              ? detail.run.execution.profile.agent.toUpperCase()
                              : rootAgent?.providerBinding.model || '模型准备中…'
                          }
                          providerLabel={rootAgent?.providerBinding.label}
                          reasoningEffort={rootAgent?.providerBinding.reasoningEffort}
                          modelDisabledReason={
                            detail.run.execution?.kind === 'docker-agent'
                              ? '此任务使用冻结的终端模板。'
                              : rootModelReason
                          }
                          onOpenModel={
                            rootAgent && detail.run.execution?.kind !== 'docker-agent'
                              ? () => setModal('model:' + rootAgent.id)
                              : undefined
                          }
                          projection={detailReadOnlyReason ? undefined : liveContext.projection}
                          contextLoading={liveContext.loading}
                          contextError={detailReadOnlyReason || liveContext.error}
                          onRequestContext={() => void liveContext.request()}
                          onOpenContext={() => rootAgent && void openContext(rootAgent.id)}
                          contextDisabled={
                            !!detailReadOnlyReason ||
                            !rootAgent ||
                            detail.run.execution?.kind === 'docker-agent'
                          }
                        />
                        <span className="reply-hint">
                          {busy
                            ? '正在提交…'
                            : legacyTerminal
                              ? '旧终端记录 · 只读'
                              : detailReadOnlyReason
                                ? '执行操作暂不可用 · 输入草稿保留'
                                : archived
                                  ? '已归档，保留全部对话记录'
                                  : isChat
                                    ? 'Ctrl + Enter 发送 · 独立会话自动保存'
                                    : detail.run.execution?.kind === 'docker-agent'
                                      ? 'Ctrl + Enter 发送 · 消息状态见终端通信'
                                      : 'Ctrl + Enter 发送 · 补充需求在安全边界应用'}
                        </span>
                      </div>
                      <button
                        className="send-button"
                        aria-label="发送补充需求"
                        title="发送补充需求 · Ctrl + Enter"
                        disabled={
                          runReadOnly ||
                          !reply.trim() ||
                          busy ||
                          ['DONE', 'CANCELLED'].includes(detail.run.status)
                        }
                      >
                        <Icon name="send" size={17} />
                      </button>
                    </div>
                  </form>
                )}
                {!terminalSurface && <NativeInboxReceipts key={runId} runId={detail.run.id} />}
                {!terminalSurface && (
                  <BackgroundJobs
                    key={`jobs:${runId}`}
                    runId={detail.run.id}
                    revision={detail.run.revision}
                    disabledReason={
                      detailReadOnlyReason ||
                      (archived || ['DONE', 'CANCELLED'].includes(detail.run.status)
                        ? '已结束或归档的运行仅供查看'
                        : '')
                    }
                    verify={(operationId) => void openResourceOwner(detail.run.id, operationId)}
                  />
                )}
                {!terminalSurface &&
                  (archived || ['DONE', 'CANCELLED'].includes(detail.run.status)) &&
                  ((cachedReplyReceipt?.targetRunId === runId && cachedReplyReceipt) ||
                    replyReceiptRead.status === 'unreadable' ||
                    replyReceiptStatus.get(replyIntentKey)) && (
                    <div className="system-note reply-receipt-notice">
                      <Icon name="history" size={14} />
                      <div>
                        <p role="status">
                          {replyReceiptRead.status === 'unreadable'
                            ? replyReceiptRead.message
                            : cachedReplyReceipt?.outcome === 'not-sent'
                              ? '上次补充未提交，原文已保留，当前草稿未替换。'
                              : replyReceiptStatus.get(replyIntentKey) ||
                                '上次发送结果待核对。仅重试原命令以读取结果，不创建新的补充请求。'}
                        </p>
                        {cachedReplyReceipt?.targetRunId === runId && (
                          <>
                            <details>
                              <summary>查看发送原文</summary>
                              <pre>{cachedReplyReceipt.text}</pre>
                            </details>
                            {!cachedReplyReceipt.outcome && (
                              <button
                                className="secondary"
                                type="button"
                                disabled={busy}
                                onClick={reconcileReply}
                              >
                                {busy ? '正在核对…' : '核对上次发送结果'}
                              </button>
                            )}
                          </>
                        )}
                      </div>
                    </div>
                  )}
              </section>
              <Presence>
                {previewOpen && (
                  <PreviewDock
                    key={runId}
                    workspaceRequestId={previewFileTarget?.requestId}
                    logContexts={logContexts}
                    allowLogContextLookup={detail.run.contract.permissionProfile.read}
                    workspaceAvailable={detail.run.contract.permissionProfile.read}
                    artifacts={
                      artifactView?.runId === runId &&
                      !detail.artifacts.some((item) => item.id === artifactView.id)
                        ? [artifactView, ...detail.artifacts]
                        : detail.artifacts
                    }
                    checkpointKey={detail.run.id}
                    selectedArtifactId={artifactView?.runId === runId ? artifactView.id : undefined}
                    selectArtifact={setArtifactView}
                    close={() => setPreviewOpen(false)}
                  >
                    <PreviewPanel
                      embedded
                      fileTarget={previewFileTarget}
                      runId={runId}
                      tasks={detail.tasks}
                      agents={detail.agents}
                      messages={detail.messages}
                      operations={detail.operations}
                      artifacts={detail.artifacts}
                      streaming={streaming}
                      selectedTaskId={previewTaskId}
                      selectTask={setPreviewTaskId}
                      close={() => setPreviewOpen(false)}
                    />
                  </PreviewDock>
                )}
              </Presence>
              {detailsOverlayOpen && (
                <div
                  className="details-backdrop"
                  onClick={() => setDetailsDrawerOpen(false)}
                  aria-hidden="true"
                />
              )}
              {detailsVisible && (
                <aside
                  className={'details-panel' + (compactLayout ? ' details-drawer' : '')}
                  id={localSurface + '-run-details'}
                  ref={detailsRef}
                  role={detailsOverlayOpen ? 'dialog' : undefined}
                  aria-modal={detailsOverlayOpen || undefined}
                  aria-label={isChat ? '模型与用量' : '任务详情'}
                  tabIndex={detailsOverlayOpen ? -1 : undefined}
                >
                  <div className="details-heading">
                    <div>
                      <strong>{isChat ? '模型与用量' : '任务详情'}</strong>
                      <small>{detail.run.title || detail.run.objective}</small>
                    </div>
                    <button
                      className="icon-button"
                      data-drawer-close
                      aria-label="收起详情"
                      title="收起详情"
                      onClick={() =>
                        compactLayout ? setDetailsDrawerOpen(false) : setDetailsCollapsed(true)
                      }
                    >
                      <Icon name="close" size={17} />
                    </button>
                  </div>
                  <MotionTabs className="detail-tabs" label="任务详情" value={tab}>
                    {(isChat
                      ? [
                          { key: 'agents', icon: 'chat', title: '模型' },
                          { key: 'usage', icon: 'chart', title: '用量' },
                        ]
                      : [
                          { key: 'tasks', icon: 'grid', title: '任务' },
                          { key: 'agents', icon: 'tree', title: '代理' },
                          { key: 'artifacts', icon: 'file', title: '产物' },
                          { key: 'usage', icon: 'chart', title: '用量' },
                        ]
                    ).map((t) => (
                      <button
                        key={t.key}
                        className={tab === t.key ? 'active' : ''}
                        aria-pressed={tab === t.key}
                        onClick={() => {
                          setTab(t.key);
                          if (['agents', 'artifacts', 'usage'].includes(t.key) && detail.summaryDeferred)
                            void loadDetailedSummary();
                        }}
                      >
                        <Icon name={t.icon} size={15} />
                        {t.title}
                      </button>
                    ))}
                  </MotionTabs>
                  <MotionContent className="detail-content" motionKey={tab}>
                    {(tab === 'tasks' || tab === 'agents') && detail.taskPage && (
                      <div className="panel-heading agent-pagination" aria-label="代理分页">
                        <span>
                          本页 {detail.agents.length} 个代理（含总代理和上级），共 {detail.taskPage.total} 个
                        </span>
                        <button
                          className="secondary"
                          disabled={agentPaging || !detail.taskPage.after}
                          onClick={() =>
                            void changeAgentPage(
                              agentPagePosition.current.trail.at(-1) ?? '',
                              agentPagePosition.current.trail.slice(0, -1),
                            )
                          }
                        >
                          上一页
                        </button>
                        <button
                          className="secondary"
                          disabled={agentPaging || !detail.taskPage.nextCursor}
                          onClick={() =>
                            void changeAgentPage(detail.taskPage!.nextCursor!, [
                              ...(agentPagePosition.current.runId === detail.run.id
                                ? agentPagePosition.current.trail
                                : []),
                              detail.taskPage!.after ?? '',
                            ])
                          }
                        >
                          下一页
                        </button>
                      </div>
                    )}
                    {tab === 'tasks' && (
                      <>
                        {detail.run.contract.peerReview && <PeerReviewPanel run={detail.run} />}
                        <ToolReviewPanel run={detail.run} events={detail.events} />
                        <div className="panel-heading">
                          <h3>执行拓扑</h3>
                          <span>
                            {detail.detailCoverage?.tasks.complete === false
                              ? `已读 ${detail.tasks.length} 条 · 完整进度未知`
                              : `${detail.taskPage ? '本页 ' : ''}${detail.tasks.filter((t) => t.status === 'DONE').length}/${detail.tasks.length} 完成`}
                          </span>
                        </div>
                        <TaskGraph
                          detail={detail}
                          archived={archived || legacyTerminal}
                          selectTask={openTaskDetails}
                        />
                        <div className="panel-heading">
                          <h3>任务列表</h3>
                          <span>按任务查看进度与结果</span>
                        </div>
                        {detail.tasks.map((t) => (
                          <div
                            className="task-detail"
                            key={t.id}
                            tabIndex={-1}
                            ref={(element) => {
                              if (!element) taskDetailRefs.current.delete(t.id);
                              else {
                                taskDetailRefs.current.set(t.id, element);
                                if (pendingTaskFocus.current === t.id) {
                                  element.scrollIntoView({ block: 'start' });
                                  element.focus({ preventScroll: true });
                                  pendingTaskFocus.current = undefined;
                                }
                              }
                            }}
                          >
                            <div>
                              <strong>{t.spec.title}</strong>
                              <Badge status={t.status} />
                            </div>
                            <p>
                              {t.waitReason === 'rate_limit'
                                ? rateWaitText(
                                    t,
                                    !archived &&
                                      (['READY', 'RUNNING'].includes(detail.run.status) ||
                                        detail.run.reason === 'rate_limit'),
                                    feedbackTime,
                                    detail.edges
                                      .filter((edge) => edge.taskId === t.id)
                                      .every((edge) =>
                                        detail.tasks.some(
                                          (dependency) =>
                                            dependency.id === edge.dependencyId &&
                                            dependency.status === 'DONE',
                                        ),
                                      ),
                                  )
                                : t.waitReason
                                  ? reasons[t.waitReason] || t.waitReason
                                  : t.spec.objective}
                            </p>
                            {t.status === 'FAILED' &&
                              typeof t.result === 'object' &&
                              t.result !== null &&
                              'error' in t.result &&
                              typeof t.result.error === 'string' && (
                                <p className="task-failure" role="alert">
                                  {t.result.error}
                                </p>
                              )}
                            {(modelTaskCanContinue(t) || t.waitReason === 'dependency_failed') && (
                              <TaskRecovery
                                task={t}
                                detail={detail}
                                archived={runReadOnly}
                                busy={busy}
                                locate={openTaskDetails}
                                resume={(id) => void runAction('resume_task', id)}
                              />
                            )}
                            <small>
                              {t.spec.providerId} · 深度 {t.depth}
                            </small>
                            {t.baseline && <code title={t.baseline}>基线 {t.baseline.slice(0, 10)}</code>}
                            <button
                              className="agent-preview-button"
                              onClick={() => {
                                setArtifactView(null);
                                setPreviewTaskId(t.id);
                                setPreviewOpen(true);
                              }}
                            >
                              预览此代理的工作 ↗
                            </button>
                            {t.workspace && (
                              <p className="path-text" title={t.workspace}>
                                {t.workspace}
                              </p>
                            )}
                            {Boolean(t.result) && (
                              <details>
                                <summary>查看结果</summary>
                                <pre>{JSON.stringify(t.result, null, 2)}</pre>
                              </details>
                            )}
                          </div>
                        ))}
                      </>
                    )}
                    {tab === 'agents' && (
                      <>
                        <div className="panel-heading">
                          <h3>{isChat ? '会话模型' : '代理责任树'}</h3>
                          <span>
                            {detail.taskPage?.total ?? detail.agents.length}/
                            {detail.run.limits.maxAgents ?? '不限'}
                          </span>
                        </div>
                        {agentOrder(detail.agents).map((a) => {
                          const task = detail.tasks.find((t) => t.id === a.taskId);
                          const switchReason = legacyTerminal
                            ? '旧终端记录仅供查看。'
                            : modelSwitchReason(detail, archived, a.taskId);
                          const continueReason = legacyTerminal
                            ? '旧终端记录仅供查看。'
                            : taskResumeReason(detail, archived, a.taskId);
                          return (
                            <div
                              className="agent-card"
                              key={a.id}
                              style={{ marginLeft: (task?.depth || 0) * 14 }}
                            >
                              <div className="agent-avatar">
                                <Icon name={task?.spec.role === 'coordinator' ? 'spark' : 'tree'} size={18} />
                              </div>
                              <div>
                                <strong>
                                  {task?.spec.role === 'coordinator'
                                    ? isChat
                                      ? '助手'
                                      : '总代理'
                                    : task?.spec.title ||
                                      (detail.detailCoverage?.tasks.complete === false
                                        ? '任务记录暂不可读'
                                        : '代理')}
                                </strong>
                                <p>
                                  {a.providerBinding.label} · {a.providerBinding.model}
                                  {a.providerBinding.reasoningEffort
                                    ? ` · ${a.providerBinding.reasoningEffort}`
                                    : ''}
                                </p>
                                <small>独立会话 {a.sessionId.slice(0, 8)}</small>
                                <ContextMeter
                                  projection={detail.contexts?.find((item) => item.agentId === a.id)}
                                  disabled={busy || runReadOnly || summaryLoading}
                                  open={() => void openContext(a.id)}
                                />
                                <button
                                  className="agent-preview-button"
                                  disabled={busy || !!switchReason}
                                  title={switchReason || '为此代理选择模型'}
                                  onClick={() => setModal('model:' + a.id)}
                                >
                                  切换模型
                                </button>
                                {task && modelTaskCanContinue(task) && (
                                  <button
                                    className="agent-preview-button"
                                    disabled={
                                      busy ||
                                      !!continueReason ||
                                      (!detail.run.authorized && task.phase !== 'planning')
                                    }
                                    onClick={() => void runAction('resume_task', task.id)}
                                    title={continueReason || '仅恢复此代理，累计预算保持'}
                                  >
                                    继续此代理
                                  </button>
                                )}
                                {switchReason && <small className="model-switch-help">{switchReason}</small>}
                                {!isChat && (
                                  <button
                                    className="agent-preview-button"
                                    onClick={() => {
                                      setArtifactView(null);
                                      setPreviewTaskId(a.taskId);
                                      setPreviewOpen(true);
                                    }}
                                  >
                                    查看工作预览 ↗
                                  </button>
                                )}
                              </div>
                              <span className={'status-dot ' + a.status.toLowerCase()} />
                            </div>
                          );
                        })}
                        <div className="info-note">
                          {isChat
                            ? '独立会话不绑定项目；后续回复使用当前会话模型。'
                            : '每个实例独立保存会话、工具操作和工作目录。'}
                          {detail.run.execution?.kind === 'docker-agent'
                            ? 'Docker 终端使用冻结的配置和独立容器。'
                            : '账号共享并发与速率额度。'}
                        </div>
                      </>
                    )}
                    {tab === 'artifacts' && (
                      <>
                        <div className="panel-heading">
                          <h3>版本化产物</h3>
                          <span>
                            {detail.summaryDeferred ? '已加载 ' : ''}
                            {detail.recordCounts?.artifacts ?? detail.artifacts.length} 个
                          </span>
                        </div>
                        {!terminalSurface && !legacyTerminal && !isChat && (
                          <button className="quiet-button" onClick={() => setModal('delivery')}>
                            查看交付与验收
                          </button>
                        )}
                        {detail.artifacts.map((a) => (
                          <button className="artifact-card" key={a.id} onClick={() => void openArtifact(a)}>
                            <span className="artifact-icon">
                              <Icon name={a.name.endsWith('.diff') ? 'code' : 'file'} size={21} />
                            </span>
                            <div>
                              <strong>{a.name}</strong>
                              <p>
                                v{a.version} · {a.verified ? '证据已核验' : '待验收'}
                              </p>
                              <small>SHA256 {a.hash.slice(0, 12)}</small>
                            </div>
                            <Icon name="arrow" size={14} />
                          </button>
                        ))}
                        {!detail.artifacts.length && (
                          <Empty title="产物将在这里交付" text="报告、附件和 Git diff 会保留版本与来源。" />
                        )}
                        {detail.recordsLimited && !detail.summaryDeferred && (
                          <RecordHistory
                            runId={detail.run.id}
                            kind="artifacts"
                            label="全部产物"
                            version={detail.recordVersions?.artifacts ?? detail.run.revision}
                            total={detail.recordCounts?.artifacts ?? 0}
                            render={(artifact: Artifact) => (
                              <button
                                className="secondary"
                                type="button"
                                onClick={() => openArtifact(artifact)}
                              >
                                {artifact.name} · v{artifact.version}
                              </button>
                            )}
                          />
                        )}
                        <div className="panel-heading">
                          <h3>待核验操作</h3>
                        </div>
                        {detail.operations
                          .filter((o) => o.status === 'UNCERTAIN')
                          .map((o) => (
                            <div className="decision-card" key={o.id}>
                              <strong>{o.name}</strong>
                              <p>{o.error || '操作 intent 已记录，结果未确定。请核验本机证据。'}</p>
                              <pre>{JSON.stringify(o.evidence || o.args, null, 2)}</pre>
                              {decisionDisabledReason(o) && (
                                <p className="field-help">{decisionDisabledReason(o)}</p>
                              )}
                              <button
                                className="secondary"
                                disabled={busy || !!decisionDisabledReason(o)}
                                onClick={() => openVerification(o, detail.run.id)}
                              >
                                提交核验决定
                              </button>
                            </div>
                          ))}
                        {!detail.operations.some((o) => o.status === 'UNCERTAIN') && (
                          <p className="muted small">
                            {detail.detailCoverage?.operations.complete === false
                              ? '操作记录不完整，无法判断是否还有待核验副作用。'
                              : '当前没有待核验副作用'}
                          </p>
                        )}
                        {detail.recordsLimited && !detail.summaryDeferred && (
                          <RecordHistory
                            runId={detail.run.id}
                            kind="operations"
                            label="全部操作记录"
                            version={detail.recordVersions?.operations ?? detail.run.revision}
                            total={detail.recordCounts?.operations ?? 0}
                          />
                        )}
                      </>
                    )}
                    {tab === 'usage' && (
                      <UsagePanel
                        detail={detail}
                        totalTokens={totalTokens}
                        summaryLoading={summaryLoading}
                        loadSummary={() => void loadDetailedSummary()}
                        configureContext={(projection) => setModal('context:' + projection.agentId)}
                      />
                    )}
                  </MotionContent>
                  <div className="panel-bottom">
                    <Icon name="history" size={13} />
                    任务记录自动保存在本机
                  </div>
                </aside>
              )}
            </div>
          </>
        ) : (
          <div className="loading">正在读取任务…</div>
        )}
      </main>
      <Activity mode={pendingProjectLeave || cachePanelOpen ? 'hidden' : 'visible'}>
        <ModalErrorContext.Provider value={modal === 'task-center' ? '' : error || readIssue?.message || ''}>
          {modal === 'delivery' && detail && !terminalSurface && (
            <DeliveryReview
              key={detail.run.id}
              runId={detail.run.id}
              reviewDraft={cacheState.entries[`draft:delivery-review:${detail.run.id}`]?.value}
              changeReviewDraft={(raw) => cache.set(`draft:delivery-review:${detail.run.id}`, raw)}
              handoffDraft={cacheState.entries[`draft:handoff:${detail.run.id}`]?.value}
              changeHandoffDraft={(raw) => cache.set(`draft:handoff:${detail.run.id}`, raw)}
              resolutionDraft={cacheState.entries[`draft:source-resolutions:${detail.run.id}`]?.value}
              changeResolutionDraft={(raw) => cache.set(`draft:source-resolutions:${detail.run.id}`, raw)}
              readOnly={archived}
              updated={(revision) =>
                setDetail((old) =>
                  old?.run.id === detail.run.id ? { ...old, run: { ...old.run, revision } } : old,
                )
              }
              close={() => setModal('')}
              revise={!archived && detail.run.status === 'DONE' ? () => setModal('handoff') : undefined}
              openFile={(taskId, path) => {
                setModal('');
                openPreviewFile(taskId, path);
              }}
            />
          )}
          {modal === 'handoff' && detail && !terminalSurface && (
            <RunHandoff
              run={detail.run}
              projects={projects}
              providers={providers}
              modelChoice={homeModel}
              contextPolicy={homeContext}
              value={cacheState.entries[`draft:handoff:${detail.run.id}`]?.value}
              reviewDraft={cacheState.entries[`draft:delivery-review:${detail.run.id}`]?.value}
              backToReview={
                detail.run.status === 'DONE' && detail.run.kind === 'task'
                  ? () => setModal('delivery')
                  : undefined
              }
              change={(value) => cache.set(`draft:handoff:${detail.run.id}`, value)}
              close={() => setModal('')}
              settings={() => setModal('handoff-settings')}
              busy={busy}
              submit={(body) =>
                void act(async () => {
                  const key = `draft:handoff:${detail.run.id}`;
                  const sent = cache.get(key);
                  const run = await mutation<Run>('/runs', body);
                  if (cache.get(key) === sent) cache.set(key, '');
                  selectRun(run);
                  setModal('');
                })
              }
            />
          )}
          {modal === 'task-center' && (
            <React.Suspense
              fallback={
                <Modal title="任务中心" close={() => setModal('')}>
                  <p className="field-help">正在载入…</p>
                </Modal>
              }
            >
              <TaskCenter
                state={taskCenterState}
                changeState={setTaskCenterState}
                projects={projects}
                close={() => setModal('')}
                openRun={async (id, category) => {
                  const epoch = navigationEpoch.current,
                    intent = projectLeaveGuard.begin();
                  try {
                    const target = await api<Run>('/runs/' + id + '/header');
                    if (
                      epoch !== navigationEpoch.current ||
                      !projectLeaveGuard.current(intent) ||
                      modalCurrent.current !== 'task-center'
                    )
                      return;
                    selectRun(target, {
                      intent,
                      /**
                       * 进入目标会话后打开指定任务分类并关闭当前弹窗，使定位动作应用到正确会话。
                       * EN: Open the requested task category after reaching its run, then close the current modal.
                       */
                      after: () => {
                        openTaskCenterTarget(id, category);
                        setModal('');
                      },
                    });
                  } catch (issue) {
                    if (projectLeaveGuard.current(intent)) throw issue;
                  }
                }}
              />
            </React.Suspense>
          )}
          {modal === 'appearance' && (
            <React.Suspense
              fallback={
                <Modal title="外观与启动" close={() => setModal('')}>
                  <p role="status">正在准备设置…</p>
                </Modal>
              }
            >
              <StartupSettings close={() => setModal('')} />
            </React.Suspense>
          )}
          {modal === 'local-agents' && <LocalAgentSettings close={() => setModal('')} />}
          <Presence>
            {modal ? (
              <React.Fragment key={modal}>
                {modal === 'readiness' && (
                  <ReadinessPanel
                    projectId={project?.id}
                    close={() => setModal('')}
                    repair={(action) => {
                      if (action.kind === 'models') setModal('settings', { providerId: action.targetId });
                      else if (action.kind === 'new-project') setModal('project');
                      else if (action.kind === 'projects')
                        setModal(
                          projects.find((value) => value.id === action.targetId)?.archived
                            ? 'manage:archive'
                            : 'manage:projects',
                        );
                      else {
                        const targets = {
                          'terminal-apps': 'apps',
                          'terminal-connections': 'connections',
                          'terminal-project': 'project',
                          'terminal-templates': 'templates',
                        } as const;
                        setModal('settings', {
                          terminalTab: targets[action.kind],
                          ...(action.kind === 'terminal-connections'
                            ? { connectionId: action.targetId }
                            : {}),
                          ...(action.kind === 'terminal-templates' ? { profileId: action.targetId } : {}),
                        });
                      }
                    }}
                  />
                )}
                {modal === 'project' && (
                  <ProjectModal
                    spaces={spaces}
                    projects={projects}
                    initialSpaceId={spaceId}
                    close={() => setModal('')}
                    busy={busy}
                    submit={(body) =>
                      submitAfterProjectLeave('新建项目', (intent) =>
                        act(async () => {
                          const p = await mutation<Project>('/projects', body);
                          if (!projectLeaveGuard.current(intent)) return;
                          navigate({ spaceId: p.spaceId, projectId: p.id, runId: '' }, true, {
                            intent,
                            bypass: true,
                            /**
                             * 关联会话导航成功后关闭弹窗，避免离开检查取消时丢失当前操作上下文。
                             * EN: Close the modal after associated run navigation succeeds so cancelled leave checks preserve the current action context.
                             */
                            after: () => setModal(''),
                          });
                        }),
                      )
                    }
                  />
                )}
                {modal === 'project-files' && project && (
                  <Modal
                    title={project.name}
                    subtitle={project.workspaceRoot}
                    close={() => setModal('')}
                    wide
                  >
                    <ProjectFiles projectId={project.id} />
                  </Modal>
                )}
                {modal.startsWith('manage:') && (
                  <WorkspaceManager
                    spaces={spaces}
                    projects={projects}
                    runs={runs}
                    listPage={runListPage}
                    listTrail={runListPosition.current.trail.length > 0}
                    listBusy={runListBusy}
                    listQuery={runListQuery}
                    changeListQuery={setRunListQuery}
                    listNavigate={(direction) => void changeRunList(direction)}
                    projectCounts={projectCounts}
                    changeListArchive={setRunListArchive}
                    initial={modal.slice(7)}
                    close={() => setModal('')}
                    updated={managed}
                    selectRun={selectRun}
                  />
                )}
                {modal === 'project-item-run' && project && !terminalSurface && (
                  <ProjectItemSetup
                    key={project.id}
                    projectId={project.id}
                    projectName={project.name}
                    cache={cache}
                    providers={providers}
                    modelChoice={homeModel}
                    contextPolicy={homeContext}
                    busy={busy}
                    close={() => setModal('')}
                    settings={() => setModal('project-item-run-settings')}
                    submit={(body, sentLaunch) =>
                      submitAfterProjectLeave('从交付项创建任务', (intent) =>
                        act(async () => {
                          const created = await mutation<Run>('/runs', {
                            ...body,
                            objective: sentLaunch.objective,
                            kind: 'task',
                            projectId: project.id,
                            projectDelivery: {
                              itemId: sentLaunch.itemId,
                              expectedRevision: sentLaunch.expectedRevision,
                            },
                          });
                          if (!projectLeaveGuard.current(intent)) return;
                          selectRun(created, {
                            intent,
                            bypass: true,
                            /**
                             * 创建成功后仅清理仍等于已发送 launch 配置的项目草稿；提交期间的新编辑保留，再关闭弹窗。
                             * EN: After creation, clear project launch draft only if it still matches the submitted configuration, preserving edits made during submission before closing the modal.
                             */
                            after: () => {
                              const current = readProjectBoardDraft(cache.get(projectBoardKey(project.id)));
                              if (JSON.stringify(current.launch) === JSON.stringify(sentLaunch))
                                writeProjectBoardDraft(cache, project.id, (value) => ({
                                  ...value,
                                  launch: undefined,
                                }));
                              setModal('');
                            },
                          });
                        }),
                      )
                    }
                  />
                )}
                {modal === 'run' && (!terminalSurface || (project && terminalProfile)) && (
                  <RunModal
                    key={`${runSetupKey}:${cacheFormEpoch}`}
                    cache={cache}
                    draftKey={runSetupKey}
                    persistence={cacheState}
                    openPersistence={openPersistence}
                    objective={draft}
                    kind={project ? 'task' : 'chat'}
                    projectName={project?.name}
                    projectId={project?.id}
                    providers={providers}
                    modelChoice={homeModel}
                    contextPolicy={homeContext}
                    terminalTemplate={terminalProfile}
                    terminalConnections={terminalControl?.connections || []}
                    close={() => {
                      setModal('');
                    }}
                    busy={busy}
                    submit={(body, sentSetup) =>
                      submitAfterProjectLeave('新建任务', (intent) =>
                        act(async () => {
                          const sentObjective = draft;
                          const run = await mutation<Run>('/runs', {
                            ...body,
                            objective: draft,
                            kind: project ? 'task' : 'chat',
                            projectId: projectId || null,
                          });
                          if (!projectLeaveGuard.current(intent)) return;
                          selectRun(run, {
                            intent,
                            bypass: true,
                            /**
                             * 创建成功后逐项比较已发送目标和配置，仅清除未被用户再次编辑的草稿，再关闭弹窗。
                             * EN: After creation, clear objective and setup drafts only when each still matches its submitted value, preserving concurrent typing before closing the modal.
                             */
                            after: () => {
                              if (cache.get(draftKey) === sentObjective) cache.set(draftKey, '');
                              if (cache.get(runSetupKey) === sentSetup) cache.set(runSetupKey, '');
                              setModal('');
                            },
                          });
                        }),
                      )
                    }
                    settings={() => {
                      if (actionPending.current) return;
                      setModal('run-settings');
                    }}
                  />
                )}
                {(modal === 'settings' || modal === 'run-settings') &&
                  terminalSurface &&
                  (terminalSettings ? (
                    <React.Suspense
                      fallback={
                        <Modal title="终端管理" close={() => setModal('')}>
                          <div className="form-body" role="status">
                            正在加载终端管理…
                          </div>
                        </Modal>
                      }
                    >
                      <TerminalControlCenter
                        key={`terminal-settings:${settingsEpoch}`}
                        initial={terminalSettings}
                        initialTab={settingsTarget?.terminalTab ?? 'apps'}
                        initialConnectionId={settingsTarget?.connectionId}
                        initialProfileId={settingsTarget?.profileId}
                        project={project}
                        close={() => setModal(modal === 'run-settings' ? 'run' : '')}
                        updated={(settings) => {
                          setTerminalSettings(settings);
                          void refresh();
                        }}
                        controlUpdated={(overview, preferences) => {
                          setTerminalControl(overview);
                          if (preferences && project) {
                            if (projectPreferences && preferences.revision !== projectPreferences.revision)
                              cache.set(profileSelectionKey, '');
                            setTerminalPreferences({ projectId: project.id, value: preferences });
                          }
                        }}
                        activity={(pending) => {
                          actionPending.current = pending;
                          setBusy(pending);
                        }}
                      />
                    </React.Suspense>
                  ) : (
                    <Modal title="终端管理" close={() => setModal('')}>
                      <div className="form-body" role="status">
                        {readIssue ? readIssue.message : '正在读取终端模板…'}
                        <button
                          type="button"
                          className="secondary"
                          disabled={retrying}
                          onClick={() => void connect(true)}
                        >
                          重试读取
                        </button>
                      </div>
                    </Modal>
                  ))}
                {(modal === 'settings' ||
                  modal === 'run-settings' ||
                  modal === 'handoff-settings' ||
                  modal === 'project-item-run-settings') &&
                  !terminalSurface && (
                    <React.Suspense
                      fallback={
                        <Modal
                          title="模型与连接"
                          close={() =>
                            setModal(
                              modal === 'run-settings'
                                ? 'run'
                                : modal === 'handoff-settings'
                                  ? 'handoff'
                                  : modal === 'project-item-run-settings'
                                    ? 'project-item-run'
                                    : '',
                            )
                          }
                        >
                          <div className="form-body" role="status">
                            正在加载模型设置…
                          </div>
                        </Modal>
                      }
                    >
                      <ProviderSettings
                        key={`provider-settings:${settingsEpoch}`}
                        providers={providers}
                        initialProviderId={settingsTarget?.providerId}
                        close={() =>
                          setModal(
                            modal === 'run-settings'
                              ? 'run'
                              : modal === 'handoff-settings'
                                ? 'handoff'
                                : modal === 'project-item-run-settings'
                                  ? 'project-item-run'
                                  : '',
                          )
                        }
                        updated={() => refresh(true)}
                      />
                    </React.Suspense>
                  )}
                {modal.startsWith('model:') && detail && switchAgent && switchTask && (
                  <ModelSwitchModal
                    key={detail.run.id + ':' + switchAgent.id}
                    providers={providers}
                    agent={switchAgent}
                    task={switchTask}
                    chat={isChat}
                    busy={busy}
                    disabledReason={
                      legacyTerminal
                        ? '旧终端记录仅供查看。'
                        : modelSwitchReason(detail, archived, switchTask.id)
                    }
                    close={() => setModal('')}
                    submit={(choice, switchMode) =>
                      act(async () => {
                        await mutation('/runs/' + detail.run.id + '/actions', {
                          ...choice,
                          action: 'switch_model',
                          switchMode,
                          taskId: switchTask.id,
                          expectedRevision: detail.run.revision,
                        });
                        setModal('');
                      })
                    }
                  />
                )}
                {modal === 'new-context' && (
                  <NewContextWindowModal
                    key={draftKey}
                    policy={homeContext}
                    provider={homeProvider}
                    busy={busy}
                    close={() => setModal('')}
                    submit={(policy) => {
                      setHomeContexts((old) => ({ ...old, [draftKey]: policy }));
                      setModal('');
                    }}
                  />
                )}
                {modal.startsWith('context:') && detail && contextAgent && (
                  <ContextWindowModal
                    key={
                      detail.run.id +
                      ':' +
                      contextAgent.agentId +
                      ':' +
                      contextSnapshot!.runRevision +
                      ':' +
                      contextAgent.agentRevision
                    }
                    projection={contextAgent}
                    runId={detail.run.id}
                    cache={cache}
                    title={
                      detail.tasks.find((task) => task.id === contextAgent.taskId)?.spec.title || '当前会话'
                    }
                    runRevision={contextSnapshot!.runRevision}
                    busy={busy || contextReading}
                    close={() => setModal('')}
                    refresh={() => void openContext(contextAgent.agentId)}
                    submit={(policy, expectedAgentRevision, expectedRevision) =>
                      void act(async () => {
                        await mutation('/runs/' + detail.run.id + '/context', {
                          agentId: contextAgent.agentId,
                          expectedAgentRevision,
                          expectedRevision,
                          policy,
                        });
                        setModal('');
                      })
                    }
                  />
                )}
                {modal.startsWith('context:') && detail && !contextAgent && (
                  <Modal title="上下文设置" close={() => setModal('')}>
                    <p className="field-help" role="status">
                      {contextReading ? '正在读取上下文…' : '上下文暂时不可用。'}
                    </p>
                    {!contextReading && (
                      <button className="secondary" onClick={() => void openContext(modal.slice(8))}>
                        重试
                      </button>
                    )}
                  </Modal>
                )}
                {modal === 'contract' && detail && (
                  <ContractModal
                    key={detail.run.id}
                    contract={detail.run.contract}
                    planMode={detail.run.planMode !== false}
                    close={() => setModal('')}
                    busy={busy}
                    disabled={
                      runReadOnly ||
                      ['DONE', 'CANCELLED'].includes(detail.run.status) ||
                      detail.run.execution?.kind === 'docker-agent'
                    }
                    submit={(contract, sameModelReviewConfirmed) =>
                      act(async () => {
                        await mutation('/runs/' + runId + '/messages', {
                          expectedRevision: detail.run.revision,
                          contract,
                          sameModelReviewConfirmed,
                          text:
                            detail.run.planMode === false
                              ? '我已修改任务约定，请按更新后的交付和验收项继续。'
                              : '我已修改任务约定，请根据约定重新提出计划。',
                        });
                        setModal('');
                      })
                    }
                  />
                )}
                {modal === 'limits' && detail && (
                  <Modal
                    title="运行上限与预算"
                    subtitle={feedback?.limit?.message || '当前限制状态已更新'}
                    close={() => setModal('')}
                    busy={busy}
                  >
                    <div className="form-body">
                      <p>{feedback?.limit?.explanation || '请核对当前状态后继续操作。'}</p>
                      {feedback?.limit && (
                        <ul className="limit-tasks">
                          {feedback.limit.tasks.map((task) => (
                            <li key={task.id}>
                              <strong>{task.title}</strong>
                              <span>{task.message}</span>
                            </li>
                          ))}
                        </ul>
                      )}
                      <dl className="limits-summary">
                        <div>
                          <dt>请求次数预算</dt>
                          <dd>{detail.run.contract.budget.maxRequests}</dd>
                        </div>
                        <div>
                          <dt>Token 预算</dt>
                          <dd>{detail.run.contract.budget.maxTokens.toLocaleString()}</dd>
                        </div>
                        <div>
                          <dt>费用预算</dt>
                          <dd>
                            {detail.run.contract.budget.maxCost === null
                              ? '未设置金额上限'
                              : detail.run.contract.budget.maxCost}
                          </dd>
                        </div>
                        <div>
                          <dt>每次尝试最多步骤</dt>
                          <dd>{detail.run.limits.maxSteps}</dd>
                        </div>
                        <div>
                          <dt>{isChat ? '每轮聊天计时上限' : '累计计时上限'}</dt>
                          <dd>{detail.run.limits.maxMinutes} 分钟</dd>
                        </div>
                      </dl>
                      <p className="field-help">新任务保留旧记录，并重新确认需求、模型、权限和预算。</p>
                    </div>
                    <footer className="modal-footer">
                      <button className="secondary" disabled={busy} onClick={() => setModal('')}>
                        返回
                      </button>
                      {feedback?.limit?.recheck && !runReadOnly && (
                        <button
                          className="secondary"
                          disabled={busy}
                          onClick={() =>
                            void act(async () => {
                              await mutation('/runs/' + runId + '/actions', {
                                action: 'resume',
                                expectedRevision: detail.run.revision,
                              });
                              setModal('');
                            })
                          }
                        >
                          {isChat && feedback.limit.code === 'TIME_BUDGET' ? '重新计时并恢复' : '检查后恢复'}
                        </button>
                      )}
                      <button className="primary" disabled={busy} onClick={startFromRun}>
                        {isChat ? '新建独立对话' : '新建任务'}
                      </button>
                    </footer>
                  </Modal>
                )}
                {modal.startsWith('decision:') && detail && decisionOperation && (
                  <DecisionModal
                    operation={decisionOperation}
                    close={() => setModal('')}
                    busy={busy}
                    disabledReason={decisionDisabledReason(decisionOperation)}
                    submit={(body) =>
                      act(async () => {
                        await mutation('/runs/' + runId + '/decisions', {
                          ...body,
                          expectedRevision: detail.run.revision,
                        });
                        setModal('');
                      })
                    }
                  />
                )}
              </React.Fragment>
            ) : null}
          </Presence>
        </ModalErrorContext.Provider>
      </Activity>
      {cachePanelOpen && (
        <WorkbenchPersistence
          cache={cache}
          snapshot={cacheState}
          labelFor={(key) => workbenchEntryLabel(key, projects, runs)}
          onAdoptRemote={(key) => {
            if (key === runSetupKey) setCacheFormEpoch((value) => value + 1);
          }}
          close={() => setCachePanelOpen(false)}
        />
      )}
      {pendingProjectLeave && (
        <Modal title="离开未应用的计划预览" close={() => projectLeaveGuard.cancel()}>
          <div className="form-body">
            <p>将打开：{pendingProjectLeave.label}。</p>
            <p>
              离开会取消正在读取或尚未应用的计划导入预览；当前编辑草稿和导入前原稿仍保留。返回后需重选计划文件。
            </p>
            <div className="project-actions">
              <button type="button" className="secondary" onClick={() => projectLeaveGuard.cancel()}>
                留在当前工作台
              </button>
              <button type="button" className="primary" onClick={() => projectLeaveGuard.confirm()}>
                确认离开 · 保留编辑草稿
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
/**
 * 统一空状态插画与说明，kind 只决定视觉，不隐含数据是否已经加载。
 * EN: Use common empty artwork/copy; kind selects visuals and does not imply data readiness.
 */
function Empty({
  kind = 'delivery',
  title,
  text,
}: {
  kind?: 'workspace' | 'delivery';
  title: string;
  text: string;
}) {
  return (
    <div className="empty-state">
      <EmptyArtwork kind={kind} />
      <strong>{title}</strong>
      <p>{text}</p>
    </div>
  );
}
/**
 * 呈现运行的可观测用量。优先使用服务端完整汇总，旧数据回退到当前请求列表；
 * 未知费用、缺失缓存指标与终端未观测用量明确保留为未知，不以零代替。
 * EN: Show observable usage, preferring complete server summary and falling back to visible requests for legacy data. Keep unknown cost/cache/terminal measurement unknown instead of zero.
 */
function UsagePanel({
  detail,
  totalTokens,
  configureContext,
  summaryLoading,
  loadSummary,
}: {
  detail: Detail;
  totalTokens: number;
  configureContext: (projection: ContextProjection) => void;
  summaryLoading: boolean;
  loadSummary: () => void;
}) {
  if (detail.run.execution?.kind === 'docker-agent') {
    const resources = terminalResourceRequirement(detail.run.execution.profile.resourcePreset);
    return (
      <div className="terminal-activity">
        <h3>Docker Agent 执行</h3>
        <p>
          {detail.run.execution.profile.label} · {detail.run.execution.profile.image}
        </p>
        <p className="field-help">
          外部 Agent 管理模型请求与用量，Elysia 未观测其 Token 与费用。请结合终端日志及服务商用量复核。
        </p>
        <p className="field-help">
          最长 {detail.run.limits.maxMinutes} 分钟 · 容器 {resources.cpus} CPU / {resources.memoryMiB / 1024}{' '}
          GiB 内存
        </p>
      </div>
    );
  }
  if (detail.summaryDeferred)
    return (
      <div className="info-note">
        <p>详细用量与上下文按需读取。</p>
        <button className="secondary" disabled={summaryLoading} onClick={loadSummary}>
          {summaryLoading ? '正在读取…' : '读取完整统计'}
        </button>
      </div>
    );
  const settled = detail.requests.filter((r) => r.status === 'SETTLED'),
    unknown = detail.requests.filter((r) => r.status === 'UNKNOWN');
  /**
   * 当前列表只在每条已结算记录都有费用值时展示合计；服务端汇总可覆盖分页限制。
   * EN: Sum visible records only when all settled records have cost; full server summary can span pagination.
   */
  const totalCostKnown = settled.length && settled.every((r) => r.usage?.cost !== null);
  const costs = settled.reduce((sum, r) => sum + (r.usage?.cost || 0), 0);
  const summary = detail.usageSummary;
  const requestCount = summary?.requestCount ?? detail.requests.length;
  const providerMetrics =
    summary?.providers ??
    [...new Set(detail.requests.map((r) => r.providerId))].map((providerId) => {
      const rows = detail.requests.filter((r) => r.providerId === providerId && r.usage);
      const ttft = rows.flatMap((r) => (typeof r.usage?.ttftMs === 'number' ? [r.usage.ttftMs] : []));
      return {
        providerId,
        input: rows.reduce((s, r) => s + (r.usage?.inputTotal ?? 0), 0),
        cacheRead:
          rows.length && rows.every((r) => typeof r.usage?.cacheRead === 'number')
            ? rows.reduce((s, r) => s + (r.usage?.cacheRead ?? 0), 0)
            : null,
        ttftMs: ttft.length ? ttft.reduce((a, b) => a + b, 0) / ttft.length : null,
      };
    });
  return (
    <>
      <ContextOverview
        contexts={detail.contexts || []}
        titleFor={(projection) =>
          detail.tasks.find((task) => task.id === projection.taskId)?.spec.title || '当前代理'
        }
        configure={configureContext}
      />
      <div className="panel-heading">
        <h3>调用与预算</h3>
        <span>按 requestId 去重</span>
      </div>
      <div className="metric-grid">
        <div>
          <span>模型请求</span>
          <strong>
            {requestCount}
            <small> / {detail.run.contract.budget.maxRequests}</small>
          </strong>
        </div>
        <div>
          <span>实际 Token</span>
          <strong>{totalTokens.toLocaleString()}</strong>
        </div>
        <div>
          <span>已知成本</span>
          <strong>
            {(summary?.costKnown ?? totalCostKnown) ? (summary?.cost ?? costs).toFixed(4) : '—'}
          </strong>
        </div>
        <div>
          <span>待核验调用</span>
          <strong>{summary?.unknownCount ?? unknown.length}</strong>
        </div>
      </div>
      {summary?.readCoverage && !summary.readCoverage.complete && (
        <p className="field-error" role="status">
          {summary.readCoverage.unavailable}{' '}
          条请求用量暂不可读取。请求总数包含这些记录，Token、厂商指标仅含可读取部分，完整成本未知。
        </p>
      )}
      <div className="budget-bar">
        <i
          style={{
            transform: `scaleX(${Math.min(1, requestCount / detail.run.contract.budget.maxRequests)})`,
          }}
        />
      </div>
      <div className="panel-heading">
        <h3>厂商缓存观测</h3>
      </div>
      {providerMetrics.map(({ providerId, input, cacheRead: cache, ttftMs }) => {
        const cacheKnown = cache !== null;
        return (
          <div className="cache-card" key={providerId}>
            <div>
              <strong>{providerId}</strong>
              <span>{cacheKnown && input ? Math.round((cache! / input) * 100) + '% 命中' : '待观测'}</span>
            </div>
            <p>
              读取 {cacheKnown ? cache!.toLocaleString() : '—'} / 输入 {input.toLocaleString()} Token
            </p>
            <small>平均首字 {ttftMs === null ? '—' : Math.round(ttftMs) + ' ms'}</small>
          </div>
        );
      })}
      {!requestCount && (
        <Empty kind="workspace" title="等待真实调用" text="使用供应商返回的 usage；缺失指标显示为未知。" />
      )}
      <div className="info-note">
        资料快照复用、厂商 Prompt 缓存和会话续接分别记录。未返回用量的请求保留预算预留；成本需要有效价格配置。
      </div>
      {(summary?.unknownCount ?? unknown.length) > 0 && (
        <p className="info-note" role="status">
          部分模型调用尚未确认实际用量。请结合服务商记录核对下方请求清单；预算预留仍保留，打开此页不会恢复执行。
        </p>
      )}
      {detail.agents.some((a) => ['chatgpt', 'codex'].includes(a.providerBinding.authMode || '')) && (
        <div className="info-note">
          此任务使用 ChatGPT 订阅；API 单价不适用于订阅调用。
          <button className="text-button" onClick={manageUsage}>
            管理 ChatGPT 用量
          </button>
        </div>
      )}
      <div className="panel-heading">
        <h3>请求清单</h3>
      </div>
      {detail.recordsLimited ? (
        <RecordHistory
          runId={detail.run.id}
          kind="requests"
          label="请求清单"
          version={detail.recordVersions?.requests ?? detail.run.revision}
          total={requestCount}
        />
      ) : (
        detail.requests.map((r) => (
          <details className="request-detail" key={r.id}>
            <summary>
              <span>{r.providerBinding.model}</span>
              <small>{r.status}</small>
            </summary>
            <pre>
              {JSON.stringify(
                { requestId: r.id, manifest: r.manifest, usage: r.usage, error: r.error },
                null,
                2,
              )}
            </pre>
          </details>
        ))
      )}
    </>
  );
}
/**
 * 新建项目先检查本机目录，再允许提交规范化路径和 Git 基线。目录选择器与检查请求
 * 使用同一递增序号互斥，关闭或卸载时取消；自动名称只在用户尚未编辑名称时填写。
 * EN: Check local directory before project creation and submit normalized path/Git baseline. Chooser/check share sequence, cancel/invalidate on close/unmount, and auto-name only while name untouched.
 */
function ProjectModal({
  spaces,
  projects,
  initialSpaceId,
  close,
  busy,
  submit,
}: {
  spaces: ProjectSpace[];
  projects: Project[];
  initialSpaceId: string;
  close: () => void;
  busy: boolean;
  submit: (body: any) => void;
}) {
  const { api } = useSurfaceClient();
  const [name, setName] = useState(''),
    [root, setRoot] = useState(''),
    [baseline, setBaseline] = useState('HEAD'),
    [spaceId, setSpaceId] = useState(initialSpaceId);
  const [folder, setFolder] = useState<any>(),
    [inspecting, setInspecting] = useState(false),
    [choosing, setChoosing] = useState(false),
    [error, setError] = useState('');
  const mounted = useRef(true),
    readSequence = useRef(0),
    inspection = useRef<{ sequence: number; controller: AbortController } | null>(null),
    chooser = useRef<number | null>(null),
    nameEdited = useRef(false),
    creating = useRef(busy);
  creating.current = busy;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      readSequence.current++;
      inspection.current?.controller.abort();
      inspection.current = null;
      chooser.current = null;
    };
  }, []);
  /**
   * 同时失效原生选择器结果和可取消的目录检查，防止关闭后回填表单。
   * EN: Invalidate both native chooser and cancellable directory checks to prevent post-close form updates.
   */
  const cancelRead = () => {
    readSequence.current++;
    inspection.current?.controller.abort();
    inspection.current = null;
    chooser.current = null;
    setInspecting(false);
    setChoosing(false);
    setError('');
  };
  /**
   * 项目创建中保持弹窗；其余情况下先取消在途目录读取再关闭，阻止迟到结果更新已关闭界面。
   * EN: Keep the dialog open during project creation; otherwise cancel in-flight directory reading before closing to prevent late UI updates.
   */
  const closeProject = () => {
    if (creating.current) return;
    cancelRead();
    close();
  };
  const existing = projects.find(
    (item) =>
      item.spaceId === spaceId && item.workspaceRoot.toLowerCase() === folder?.workspaceRoot?.toLowerCase(),
  );
  /**
   * 检查服务器实际可用的工作区根路径；只发布当前序号的结果，失败保留错误供用户处理。
   * EN: Check server-usable root and publish only current-sequence results; preserve errors for correction.
   */
  const inspect = async (directory: string) => {
    if (creating.current || inspection.current || chooser.current !== null || !mounted.current) return;
    const sequence = ++readSequence.current,
      controller = new AbortController();
    inspection.current = { sequence, controller };
    /**
     * 同时核对组件存活、读取取消信号和请求序号，仅接收当前目录读取结果。
     * EN: Accept directory results only while mounted, not aborted, and still associated with the current read sequence.
     */
    const current = () => mounted.current && !controller.signal.aborted && readSequence.current === sequence;
    setInspecting(true);
    setError('');
    setFolder(undefined);
    try {
      const info = await api('/projects/inspect', { workspaceRoot: directory }, 'POST', controller.signal);
      if (!current()) return;
      setRoot(info.workspaceRoot);
      if (!nameEdited.current) setName(info.name.slice(0, 80));
      setBaseline('HEAD');
      setFolder(info);
    } catch (e) {
      if (current()) setError((e as Error).message);
    } finally {
      if (inspection.current?.sequence === sequence) {
        inspection.current = null;
        if (mounted.current) setInspecting(false);
      }
    }
  };
  /**
   * 原生目录选择不能被 AbortController 取消，故用序号和 mounted 双重检查丢弃迟到结果。
   * EN: Native chooser is not abortable, so sequence and mounted checks discard late results.
   */
  const chooseFolder = async () => {
    if (creating.current || inspection.current || chooser.current !== null || !window.elysia) return;
    const sequence = ++readSequence.current;
    chooser.current = sequence;
    setChoosing(true);
    setError('');
    try {
      const directory = await window.elysia.chooseDirectory();
      if (!mounted.current || readSequence.current !== sequence || creating.current) return;
      chooser.current = null;
      setChoosing(false);
      if (directory) {
        setRoot(directory);
        await inspect(directory);
      }
    } catch (e) {
      if (mounted.current && readSequence.current === sequence) setError((e as Error).message);
    } finally {
      if (chooser.current === sequence) {
        chooser.current = null;
        if (mounted.current) setChoosing(false);
      }
    }
  };
  return (
    <Modal
      title="新建项目"
      subtitle="选择资料目录与所属项目空间，再在项目下新建任务"
      close={closeProject}
      busy={busy}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (
            creating.current ||
            inspecting ||
            choosing ||
            inspection.current ||
            chooser.current !== null ||
            !folder ||
            !name.trim()
          )
            return;
          submit({ name, workspaceRoot: root, spaceId, ...(folder?.gitAvailable ? { baseline } : {}) });
        }}
      >
        <div className="form-body">
          <label>
            所属项目空间
            <select
              aria-label="新项目所属空间"
              value={spaceId}
              disabled={busy}
              onChange={(e) => setSpaceId(e.target.value)}
            >
              {spaces.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="folder-picker"
            disabled={busy || inspecting || choosing || !window.elysia}
            onClick={() => void chooseFolder()}
          >
            <Icon name="folder" size={25} />
            <strong>选择本机文件夹</strong>
            <span>代码仓库、文档或资料目录</span>
          </button>
          {!window.elysia && (
            <p className="field-help">命令行模式可填写下方路径；桌面入口支持系统文件夹选择。</p>
          )}
          <label>
            文件夹路径
            <div className="folder-path-row">
              <input
                required
                value={root}
                disabled={busy || choosing}
                onChange={(e) => {
                  cancelRead();
                  setRoot(e.target.value);
                  setFolder(undefined);
                }}
                placeholder="D:\项目或资料目录"
              />
              <button
                type="button"
                className="secondary"
                disabled={busy || inspecting || choosing || !root.trim()}
                onClick={() => void inspect(root)}
              >
                读取目录
              </button>
            </div>
          </label>
          {choosing && <p role="status">正在选择文件夹…</p>}
          {inspecting && (
            <p role="status">
              正在读取文件夹…{' '}
              <button type="button" className="text-button" disabled={busy} onClick={cancelRead}>
                取消读取
              </button>
            </p>
          )}
          {error && (
            <p className="inline-warning" role="alert">
              {error}
            </p>
          )}
          {folder && (
            <div className="folder-inspection">
              <strong>
                {existing
                  ? existing.archived
                    ? '该空间中已有归档项目，可打开后恢复'
                    : '当前空间中已有此项目，点击下方按钮即可打开'
                  : folder.gitAvailable
                    ? '已识别 Git 项目'
                    : '已识别本机文件夹'}
              </strong>
              <p className="field-help">
                {folder.gitAvailable
                  ? '根据 Git 基线创建任务目录，保留主目录中的未提交改动。'
                  : folder.gitRoot
                    ? '当前目录是仓库子目录或还没有提交；代理可读取资料，并在独立任务目录生成结果。'
                    : '代理可读取此目录中的资料，并在独立任务目录生成结果。'}
              </p>
              <div className="folder-entries">
                {folder.entries.map((e: any) => (
                  <span key={e.name}>
                    {e.directory ? '▸ ' : ''}
                    {e.name}
                  </span>
                ))}
              </div>
            </div>
          )}
          <label>
            项目名称
            <input
              required
              value={name}
              disabled={busy}
              onChange={(e) => {
                nameEdited.current = true;
                setName(e.target.value);
              }}
              placeholder="例如：我的研究项目"
            />
          </label>
          {folder?.gitAvailable && (
            <label>
              Git 基线
              <input
                required
                value={baseline}
                disabled={busy}
                onChange={(e) => setBaseline(e.target.value)}
              />
              <span className="field-help">解析并保存具体 commit，不复制主目录的未提交改动。</span>
            </label>
          )}
        </div>
        <footer className="modal-footer">
          <button type="button" className="secondary" disabled={busy} onClick={closeProject}>
            取消
          </button>
          <button className="primary" disabled={busy || inspecting || choosing || !folder || !name.trim()}>
            {existing ? '打开已有项目' : '打开文件夹作为项目'}
            <Icon name="arrow" size={15} />
          </button>
        </footer>
      </form>
    </Modal>
  );
}
/**
 * 收集未知副作用的人工核验结论与证据说明。可选结果必须先通过 JSON 解析；
 * disabledReason 来自外层当前运行状态，核验记录本身不会在此组件中被改写。
 * EN: Collect human verification/outcome/evidence for unknown effects. Parse optional result JSON first; outer run state supplies disabledReason. This form does not itself rewrite verification records.
 */
function DecisionModal({
  operation,
  close,
  submit,
  busy,
  disabledReason,
}: {
  operation: Operation;
  close: () => void;
  submit: (body: any) => void;
  busy: boolean;
  disabledReason: string;
}) {
  const [outcome, setOutcome] = useState('confirmed'),
    [processStopped, setProcessStopped] = useState(false),
    [note, setNote] = useState(''),
    [result, setResult] = useState(''),
    [parseError, setParseError] = useState('');
  return (
    <Modal title="核验副作用结果" subtitle="请先检查本机文件或进程证据，再提交决定" close={close} busy={busy}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (busy || disabledReason || (operation.name === 'job_execution' && !processStopped)) return;
          try {
            const parsed = result.trim() ? JSON.parse(result) : undefined;
            setParseError('');
            submit({
              operationId: operation.id,
              outcome,
              note,
              result: parsed,
              ...(operation.name === 'job_execution' ? { processStopped } : {}),
            });
          } catch {
            setParseError('结果需要是合法 JSON');
          }
        }}
      >
        <div className="form-body">
          {disabledReason && (
            <p role="status" className="field-help">
              {disabledReason}
            </p>
          )}
          <pre>{JSON.stringify(operation.evidence || operation.args, null, 2)}</pre>
          {operation.name === 'job_execution' && (
            <label className="checkbox-label">
              <input
                type="checkbox"
                required
                checked={processStopped}
                disabled={busy || !!disabledReason}
                onChange={(event) => setProcessStopped(event.target.checked)}
              />
              已核验命令及其子进程停止，并在证据说明中记录依据。停止不代表副作用已撤销。
            </label>
          )}
          <label>
            核验结论
            <select
              disabled={busy || !!disabledReason}
              value={outcome}
              onChange={(e) => setOutcome(e.target.value)}
            >
              <option value="confirmed">确认已应用</option>
              <option value="not_applied">确认未应用 / 失败</option>
            </select>
          </label>
          <label>
            证据说明
            <textarea
              required
              minLength={operation.name === 'job_execution' ? 5 : 1}
              maxLength={operation.name === 'job_execution' ? 2000 : undefined}
              disabled={busy || !!disabledReason}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </label>
          <label>
            工具结果 JSON（可选）
            <textarea
              disabled={busy || !!disabledReason}
              className="code-input"
              placeholder="留空时使用证据说明作为核验结果"
              value={result}
              onChange={(e) => setResult(e.target.value)}
            />
          </label>
          {parseError && <p role="alert">{parseError}</p>}
        </div>
        <footer className="modal-footer">
          <button type="button" className="secondary" disabled={busy} onClick={close}>
            返回
          </button>
          <button className="primary" disabled={busy || !!disabledReason}>
            提交决定
          </button>
        </footer>
      </form>
    </Modal>
  );
}
/**
 * 为一个入口提供固定客户端和 DOM 根引用。隐藏入口保留 React 状态并设为 inert，
 * Activity 负责停用其 effect；恢复时仍使用原客户端、草稿缓存和消息阅读状态。
 * EN: Provide fixed client/DOM root per surface. Hidden surface retains state/inert; Activity disables effects. Resume with original client/cache/reading state.
 */
function SurfaceEntry({
  client,
  active,
  changeSurface,
  registerCache,
  registerSession,
  notificationTarget,
}: {
  client: SurfaceClient;
  active: boolean;
  changeSurface: (surface: 'native' | 'terminal') => void;
  registerCache: (
    surface: 'native' | 'terminal',
    cache: WorkbenchCache,
    reading: ConversationHistoryState,
  ) => void;
  registerSession: (surface: 'native' | 'terminal') => void;
  notificationTarget?: { taskId: string; sequence: number };
}) {
  const root = useRef<HTMLDivElement>(null);
  return (
    <div
      ref={root}
      data-workspace-surface={client.surface}
      data-surface-active={active}
      hidden={!active}
      inert={!active}
    >
      <SurfaceClientContext.Provider value={client}>
        <SurfaceRootContext.Provider value={root}>
          <Activity name={client.surface} mode={active ? 'visible' : 'hidden'}>
            <App
              changeSurface={changeSurface}
              registerCache={registerCache}
              registerSession={registerSession}
              notificationTarget={notificationTarget}
            />
          </Activity>
        </SurfaceRootContext.Provider>
      </SurfaceClientContext.Provider>
    </div>
  );
}

/**
 * 管理两个入口的访问集合、客户端和资源生命周期。首次访问才挂载工作台，随后切换
 * 只改变可见性；最终卸载时才停止所有缓存与阅读状态。桌面通知会先切换入口再传递定位目标。
 * EN: Own visited surfaces, clients, and resource lifecycle. Mount on first visit; later switch visibility only. Final unmount stops caches/reading state. Desktop notification switches surface before delivering navigation target.
 */
function SurfaceWorkspaces() {
  /**
   * 每个入口创建独立客户端；已访问入口保持挂载以保留草稿和页面状态。
   * EN: Create independent clients per surface and keep visited workspaces mounted for draft/page retention.
   */
  const [current, setCurrent] = useState(localSurface);
  const [visited, setVisited] = useState(() => new Set([localSurface]));
  const [notificationTarget, setNotificationTarget] = useState<{
    surface: 'native' | 'terminal';
    taskId: string;
    sequence: number;
  }>();
  const [clients] = useState(() => ({
    native: localSurface === 'native' ? defaultSurfaceClient : createSurfaceClient('native'),
    terminal: localSurface === 'terminal' ? defaultSurfaceClient : createSurfaceClient('terminal'),
  }));
  const caches = useRef(new Map<'native' | 'terminal', WorkbenchCache>());
  const histories = useRef(new Map<'native' | 'terminal', ConversationHistoryState>());
  const [sessions, setSessions] = useState(() => new Set<'native' | 'terminal'>());
  const registerSession = useCallback((surface: 'native' | 'terminal') => {
    setSessions((old) => (old.has(surface) ? old : new Set([...old, surface])));
  }, []);
  const registerCache = useCallback(
    (surface: 'native' | 'terminal', cache: WorkbenchCache, reading: ConversationHistoryState) => {
      caches.current.set(surface, cache);
      histories.current.set(surface, reading);
    },
    [],
  );
  useEffect(
    () => () => {
      for (const cache of caches.current.values()) cache.stop();
      for (const reading of histories.current.values()) reading.stop();
    },
    [],
  );
  const changeSurface = useCallback((surface: 'native' | 'terminal') => {
    /**
     * 同步地址栏以支持历史导航，再激活对应工作台。
     * EN: Synchronize address bar for history navigation before activating the target workspace.
     */
    history.replaceState(null, '', surfaceLocation(surface));
    setVisited((old) => new Set([...old, surface]));
    setCurrent(surface);
  }, []);
  useEffect(
    () =>
      window.elysia?.onTaskNotification?.((value) => {
        if (
          !['native', 'terminal'].includes(value.surface) ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.taskId)
        )
          return;
        changeSurface(value.surface);
        setNotificationTarget((old) => ({ ...value, sequence: (old?.sequence || 0) + 1 }));
      }),
    [changeSurface],
  );
  useEffect(() => {
    /**
     * 从地址栏恢复原生或终端界面选择，用于浏览器历史变化后的入口一致性。
     * EN: Restore native or terminal surface selection from the URL to keep the entry view consistent with browser history.
     */
    const restore = () =>
      changeSurface(
        new URLSearchParams(location.search).get('surface') === 'terminal' ? 'terminal' : 'native',
      );
    window.addEventListener('popstate', restore);
    return () => window.removeEventListener('popstate', restore);
  }, [changeSurface]);
  return (
    <>
      {(['native', 'terminal'] as const).map(
        (surface) =>
          visited.has(surface) && (
            <SurfaceEntry
              key={surface}
              client={clients[surface]}
              active={current === surface}
              changeSurface={changeSurface}
              registerCache={registerCache}
              registerSession={registerSession}
              notificationTarget={notificationTarget?.surface === surface ? notificationTarget : undefined}
            />
          ),
      )}
      {(['native', 'terminal'] as const).map((surface) => (
        <TaskNotifications
          key={'notifications:' + surface}
          client={clients[surface]}
          ready={sessions.size > 0}
        />
      ))}
    </>
  );
}
if (!window.elysia) markStartupStage('web-loaded');
createRoot(document.getElementById('root')!).render(<SurfaceWorkspaces />);
