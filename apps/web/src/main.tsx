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
import { PreviewPanel } from './PreviewPanel';
import { PreviewDock } from './PreviewDock';
import { ProjectFiles } from './ProjectFiles';
import { MarkdownDocument } from './MarkdownDocument';
import { manageUsage } from './desktop';
import {
  VERSION,
  minimumContextWindowTokens,
  AgentTerminalProfile,
  SurfaceTerminalSettings,
  type TerminalControlOverview,
  type TerminalProjectPreferences,
  type TerminalConnectionView,
} from '../../../packages/contracts/src/index';
import { TerminalSetup, terminalPreset } from './TerminalSetup';
import { TerminalRecovery } from './TerminalRecovery';
import { TerminalContinuation } from './TerminalContinuation';
const ProviderSettings = React.lazy(() =>
  import('./ProviderSettings').then((module) => ({ default: module.ProviderSettings })),
);
const TerminalControlCenter = React.lazy(() =>
  import('./TerminalControlCenter').then((module) => ({ default: module.TerminalControlCenter })),
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
  Contract,
  ProviderConfig,
  ContextPolicy,
  ContextProjection,
} from '../../../packages/contracts/src/index';
import { Icon } from './Icon';
import { BrandIcon, EmptyArtwork } from './Brand';
import { Modal, ModalErrorContext } from './Modal';
import { WorkspaceHome } from './WorkspaceHome';
import { WorkspaceManager } from './WorkspaceManager';
import { SessionSidebar, type SessionTarget, type SessionUpdateResult } from './SessionSidebar';
import { WorkbenchCache, newDraftKey, type CacheEntry } from './WorkbenchCache';
import { ConversationScroll } from './ConversationScroll';
import { ToolActivity } from './ToolActivity';
import { RunStream } from './RunStream';
import { conversationMessages, isInboxUserMessage } from './MessageTimeline';
import { conversationIndex } from './ConversationIndex';
import {
  initialNavigation,
  navigationKey,
  readNavigation,
  resolveNavigation,
  writeNavigation,
  type NavigationState,
} from './NavigationState';
import { ModelPicker, defaultChoice, type ModelChoice } from './ModelPicker';
import { ModelSwitchModal, modelSwitchReason, modelTaskCanContinue } from './ModelSwitchModal';
import { PlanAlignmentLoader } from './PlanAlignmentLoader';
import {
  ContextMeter,
  ContextOverview,
  ContextWindowModal,
  NewContextWindowModal,
  contextPolicyLabel,
} from './ContextWindow';
import { ContextPolicyEditor, validContextPolicy } from './ContextPolicyEditor';
import { TaskGraph } from './TaskGraph';
import { agentOrder } from './agentOrder';
import { archiveFeedback, currentQuestions, getRunFeedback, rateWaitText } from './RunFeedback';
import { MotionContent, MotionTabs, Presence, usePositionMotion } from './Motion';
import { useDrawerFocus, useViewportMatch } from './ResponsiveLayout';
type Detail = {
  run: Run;
  tasks: Task[];
  agents: Agent[];
  messages: Message[];
  messagePage?: { hasMore: boolean; nextBefore: string | null; before: string | null; limit: number };
  artifacts: Artifact[];
  requests: RequestRecord[];
  operations: Operation[];
  events: any[];
  edges: { taskId: string; dependencyId: string }[];
  contexts: ContextProjection[];
};
type Provider = ProviderConfig & { keyConfigured: boolean };
type ArtifactTarget = Pick<Artifact, 'id' | 'name' | 'runId'>;
type ArtifactView = ArtifactTarget;
type ReadSource = 'session' | 'lists' | 'detail';
type ReadIssue = { message: string; retryable: boolean; reopen: boolean; request: number; runId?: string };
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
  rate_limit: '等待账号额度',
};
function Badge({ status }: { status: string }) {
  return (
    <span className={'badge ' + status.toLowerCase()}>
      <i />
      {statuses[status] || status}
    </span>
  );
}
function App({
  changeSurface,
  registerCache,
}: {
  changeSurface: (surface: 'native' | 'terminal') => void;
  registerCache: (surface: 'native' | 'terminal', cache: WorkbenchCache) => void;
}) {
  const client = useSurfaceClient();
  const { api, apiUrl, mutation, initializeSession, surface: localSurface } = client;
  const terminalSurface = localSurface === 'terminal';
  const [ready, setReady] = useState(false),
    [error, setError] = useState(''),
    [readIssues, setReadIssues] = useState<Partial<Record<ReadSource, ReadIssue>>>({}),
    [retrying, setRetrying] = useState(false),
    [busy, setBusy] = useState(false),
    [projects, setProjects] = useState<Project[]>([]),
    [spaces, setSpaces] = useState<ProjectSpace[]>([]),
    [runs, setRuns] = useState<Run[]>([]),
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
    [runSetup, setRunSetup] = useState<{ key: string; draft: RunSetupDraft } | null>(null),
    [streaming, setStreaming] = useState<Record<string, string>>({});
  const [cacheState, setCacheState] = useState<{
    entries: Record<string, CacheEntry>;
    status: 'loading' | 'saved' | 'saving' | 'error';
    error: string;
  }>({ entries: {}, status: 'loading', error: '' });
  const historyPosition = useRef<{ runId: string; before: string; trail: string[] }>({
    runId: '',
    before: '',
    trail: [],
  });
  const [historyLoading, setHistoryLoading] = useState(false);
  const [previewFileTarget, setPreviewFileTarget] = useState<{
    taskId: string;
    path: string;
    anchor?: string;
    requestId: string;
  }>();
  const messageIndex = useMemo(
    () => conversationIndex(detail),
    [detail?.messages, detail?.requests, detail?.agents, detail?.tasks, detail?.operations],
  );
  const visibleMessages = useMemo(
    () => conversationMessages(detail?.messages || []).filter((message) => message.role !== 'tool'),
    [detail?.messages],
  );
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
    registerCache(localSurface, instance);
    return instance;
  });
  const [selection, setSelection] = useState(initialNavigation);
  const { spaceId, projectId, runId } = selection;
  const draftKey = newDraftKey(projectId);
  const draft =
    typeof cacheState.entries[draftKey]?.value === 'string'
      ? (cacheState.entries[draftKey].value as string)
      : '';
  const setDraft = (value: string) => cache.set(draftKey, value);
  const [homeModels, setHomeModels] = useState<Record<string, ModelChoice>>({});
  const homeModel = homeModels[draftKey] || defaultChoice(providers);
  const homeProvider = providers.find((provider) => provider.id === homeModel.providerId);
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
  const chosenTerminalProfile =
    terminalProfiles.find((profile) => profile.id === terminalProfileId) ||
    terminalProfiles.find((profile) => profile.id === projectPreferences?.defaultProfileId) ||
    terminalProfiles.find((profile) => profile.id === terminalSettings?.defaultProfileId) ||
    terminalProfiles.find((profile) => profile.agent === terminalControl?.apps.defaultAppId) ||
    terminalProfiles[0];
  const inheritedConnection = terminalControl?.connections.find(
    (connection) => connection.id === projectPreferences?.connectionId,
  );
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
        : readIssues.session
          ? 'session'
          : undefined;
  const readIssue = readSource ? readIssues[readSource] : undefined;
  const project = projects.find((p) => p.id === projectId);
  const runSetupKey = JSON.stringify([projectId, project ? 'task' : 'chat', draft]);
  const isChat = detail?.run.kind === 'chat';
  const archived = !!detail?.run.archived || !!project?.archived;
  const legacyTerminal = !terminalSurface && detail?.run.execution?.kind === 'docker-agent';
  const runReadOnly = archived || legacyTerminal;
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
  const questions = detail ? currentQuestions(detail) : [];
  const resumeTask = detail?.tasks.find((task) => task.id === feedback?.resumeTaskId);
  const resumeTaskReason = legacyTerminal
    ? '旧终端记录仅供查看。'
    : detail && resumeTask
      ? modelSwitchReason(detail, archived, resumeTask.id)
      : '';
  const planRef = useRef<HTMLDivElement>(null);
  const questionRef = useRef<HTMLDivElement>(null);
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
  const rootContext = detail?.contexts?.find((item) => item.agentId === rootAgent?.id);
  const contextAgent = modal.startsWith('context:')
    ? detail?.contexts?.find((item) => item.agentId === modal.slice(8))
    : undefined;
  const rootModelReason = legacyTerminal
    ? '旧终端记录仅供查看。'
    : detail && rootAgent
      ? modelSwitchReason(detail, archived, rootAgent.taskId)
      : '模型正在准备中。';
  const decisionDisabledReason = (operation: Operation) => {
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
  const setModal = (value: string) => {
    setNavigationOpen(false);
    setDetailsDrawerOpen(false);
    setModalState(value);
  };
  const sidebarRef = useRef<HTMLElement>(null);
  const detailsRef = useRef<HTMLElement>(null);
  const sidebarCollapsed = !narrowLayout && cacheState.entries['collapsed:sidebar']?.value === true;
  const navigationDrawerOpen = narrowLayout && navigationOpen;
  const detailsVisible =
    !!runId && !!detail && !previewOpen && (compactLayout ? detailsDrawerOpen : !detailsCollapsed);
  const detailsOverlayOpen = compactLayout && detailsVisible;
  useDrawerFocus(sidebarRef, navigationDrawerOpen, () => setNavigationOpen(false));
  useDrawerFocus(detailsRef, detailsOverlayOpen, () => setDetailsDrawerOpen(false));
  useEffect(() => {
    setNavigationOpen(false);
    setDetailsDrawerOpen(false);
  }, [narrowLayout, compactLayout, runId]);
  const mainMotion = usePositionMotion<HTMLElement>();
  const activeRunId = useRef('');
  const detailRequest = useRef(0);
  const runStream = useRef(new RunStream());
  const streamRun = useRef('');
  const [connection, setConnection] = useState('connecting');
  const actionPending = useRef(false);
  const navigation = useRef(initialNavigation);
  const navigationEpoch = useRef(0);
  const navigationStorageKey = useRef<string | undefined>(undefined);
  const savedNavigation = useRef<NavigationState | undefined>(undefined);
  const navigationInitialized = useRef(false);
  const listRequest = useRef(0);
  const listedEntities = useRef({ projects: new Set<string>(), runs: new Set<string>() });
  const sessionReady = useRef(false);
  const connectPending = useRef(false);
  const sessionRequest = useRef(0);
  const replyKey = `draft:run:${runId}`;
  const reply =
    typeof cacheState.entries[replyKey]?.value === 'string'
      ? (cacheState.entries[replyKey].value as string)
      : '';
  useEffect(() => {
    const flush = () => void cache.flush();
    const hidden = () => {
      if (document.visibilityState === 'hidden') flush();
    };
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', hidden);
    return () => {
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', hidden);
      // Activity hides a workspace without unmounting its state. Keep draft
      // persistence alive; only the outer host stops caches on actual teardown.
      void cache.flush();
    };
  }, [cache]);
  const closeArtifact = useCallback(() => {
    setArtifactView(null);
  }, []);
  const clearReadIssue = useCallback((source: ReadSource, request = Infinity) => {
    setReadIssues((old) => {
      if (!old[source] || old[source]!.request > request) return old;
      const next = { ...old };
      delete next[source];
      return next;
    });
  }, []);
  const navigate = useCallback(
    (next: NavigationState, explicit = false) => {
      if (explicit) {
        setNavigationOpen(false);
        navigationEpoch.current++;
        navigationInitialized.current = true;
        savedNavigation.current = undefined;
      }
      if (navigation.current.runId !== next.runId) {
        historyPosition.current = { runId: next.runId, before: '', trail: [] };
        setHistoryLoading(false);
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
    [closeArtifact],
  );
  const refresh = useCallback(async () => {
    const request = ++listRequest.current;
    const epoch = navigationEpoch.current;
    let p: Project[],
      r: Run[],
      v: Provider[],
      s: ProjectSpace[],
      settings: SurfaceTerminalSettings | null,
      control: TerminalControlOverview | null;
    try {
      [p, r, v, s, settings, control] = await Promise.all([
        api<Project[]>('/projects'),
        api<Run[]>('/runs'),
        terminalSurface ? Promise.resolve([]) : api<Provider[]>('/providers'),
        api<ProjectSpace[]>('/spaces'),
        terminalSurface ? api<SurfaceTerminalSettings>('/terminal/settings') : Promise.resolve(null),
        terminalSurface ? api<TerminalControlOverview>('/terminal/control') : Promise.resolve(null),
      ]);
    } catch (error) {
      if (request === listRequest.current)
        setReadIssues((old) => ({ ...old, lists: readIssueFor(error, request) }));
      return false;
    }
    if (request !== listRequest.current) return;
    clearReadIssue('lists', request);
    setProjects(p);
    setRuns(r);
    setProviders(v);
    setTerminalSettings(settings);
    setTerminalControl(control);
    setSpaces(s);
    listedEntities.current = {
      projects: new Set(p.map((project) => project.id)),
      runs: new Set(r.map((run) => run.id)),
    };
    cache.prune(listedEntities.current.projects, listedEntities.current.runs);
    if (epoch !== navigationEpoch.current) return;
    const restoring = !navigationInitialized.current;
    const next = resolveNavigation(savedNavigation.current || navigation.current, p, r, s, restoring);
    navigationInitialized.current = true;
    savedNavigation.current = undefined;
    if (restoring && next.runId) {
      const run = r.find((run) => run.id === next.runId)!;
      setPreviewTaskId(run.rootTaskId);
      setTab(run.kind === 'chat' ? 'agents' : 'tasks');
    }
    navigate(next);
    return true;
  }, [navigate, clearReadIssue, cache, terminalSurface]);
  const refreshDetail = useCallback(async () => {
    const wanted = activeRunId.current;
    if (!wanted) return;
    const request = ++detailRequest.current;
    let result: Detail;
    try {
      const before = historyPosition.current.runId === wanted ? historyPosition.current.before : '';
      result = await api<Detail>(
        '/runs/' +
          wanted +
          '?messageLimit=160' +
          (before ? '&beforeMessage=' + encodeURIComponent(before) : ''),
      );
    } catch (error) {
      if (activeRunId.current === wanted && detailRequest.current === request) {
        setReadIssues((old) => ({ ...old, detail: readIssueFor(error, request, wanted) }));
        return false;
      }
      return;
    }
    if (activeRunId.current === wanted && detailRequest.current === request) {
      clearReadIssue('detail', request);
      runStream.current.sync(result.requests);
      setStreaming(runStream.current.texts());
      setDetail((old) => {
        if (old?.run.id !== wanted) return result;
        const events = [
          ...new Map([...result.events, ...old.events].map((event) => [event.seq, event])).values(),
        ]
          .sort((a, b) => a.seq - b.seq)
          .slice(-100);
        return old.run.revision > result.run.revision
          ? { ...old, messages: result.messages, messagePage: result.messagePage, events }
          : { ...result, events };
      });
    }
    return true;
  }, [clearReadIssue]);
  async function changeHistory(before: string, trail: string[]) {
    if (historyLoading) return;
    const wanted = activeRunId.current;
    const prior = historyPosition.current;
    historyPosition.current = { runId: wanted, before, trail };
    setHistoryLoading(true);
    const loaded = await refreshDetail();
    if (activeRunId.current === wanted) {
      if (loaded === false) historyPosition.current = prior;
      setHistoryLoading(false);
    }
  }
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
          navigationStorageKey.current = navigationKey(scope, client);
          savedNavigation.current = readNavigation(navigationStorageKey.current);
          // The authenticated workbench and lists do not depend on each other.
          const lists = refresh();
          try {
            const [, listed] = await Promise.all([cache.load(), lists]);
            if (listed === true) cache.prune(listedEntities.current.projects, listedEntities.current.runs);
          } catch (error) {
            setReadIssues((old) => ({ ...old, session: readIssueFor(error, request) }));
            return;
          }
          sessionReady.current = true;
          setReady(true);
          return;
        }
        if (source === 'detail') {
          if (target === activeRunId.current) await refreshDetail();
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
    [clearReadIssue, refresh, refreshDetail, cache],
  );
  useEffect(() => {
    void connect();
  }, [connect]);
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
  useEffect(() => {
    if (streamRun.current !== runId) {
      streamRun.current = runId;
      runStream.current.clear();
      setStreaming({});
    }
    // Preserve the last task view on a hot return while reconciling it with the
    // server. A different run was already cleared by navigate().
    setDetail((old) => (old?.run.id === runId ? old : null));
    setConnection('connecting');
    if (!ready || !runId) return;
    void refreshDetail();
    const source = new EventSource(apiUrl('/runs/' + runId + '/events'));
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let frame: number | null = null;
    const publishStream = () => {
      if (frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        if (!disposed) setStreaming(runStream.current.texts());
      });
    };
    const reload = () => {
      if (!disposed && !timer)
        timer = setTimeout(() => {
          timer = null;
          void refreshDetail().catch(() => {});
          void refresh().catch(() => {});
        }, 120);
    };
    source.addEventListener('open', () => {
      if (disposed) return;
      setConnection('connected');
      reload();
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
      'decision.required',
      'artifact.created',
      'usage.updated',
      'context.updated',
      'context.policy.updated',
      'terminal.started',
      'terminal.output',
      'terminal.completed',
      'terminal.failed',
      'terminal.unavailable',
      'terminal.accepted',
      'error',
    ];
    for (const event of events)
      source.addEventListener(event, (e) => {
        if (disposed) return;
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
          runStream.current.complete(data.taskId, data.payload);
          publishStream();
        }
        reload();
      });
    source.addEventListener('message.delta', (e) => {
      if (disposed) return;
      const data = JSON.parse((e as MessageEvent).data);
      if (!runStream.current.delta(data)) reload();
      publishStream();
    });
    return () => {
      disposed = true;
      source.close();
      if (timer) clearTimeout(timer);
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [ready, runId, refreshDetail, refresh]);
  useEffect(() => {
    setAssignmentReady({});
  }, [assignmentKey]);
  useEffect(() => setError(''), [modal]);
  async function act(fn: () => Promise<unknown>) {
    if (actionPending.current) return false;
    actionPending.current = true;
    setBusy(true);
    setError('');
    try {
      await fn();
      await refresh();
      await refreshDetail();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      actionPending.current = false;
      setBusy(false);
    }
  }
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
  const sendReply = () => {
    if (!detail || busy || runReadOnly || !reply.trim() || ['DONE', 'CANCELLED'].includes(detail.run.status))
      return;
    const target = runId;
    const text = reply;
    const revision = detail.run.revision;
    void act(async () => {
      await mutation('/runs/' + target + '/messages', { expectedRevision: revision, text });
      if (cache.get(`draft:run:${target}`) === text) cache.set(`draft:run:${target}`, '');
    });
  };
  const selectRun = (run: Run) => {
    if (cache.get(`unread:run:${run.id}`) === true) cache.set(`unread:run:${run.id}`, false);
    if (run.projectId && cache.get(`collapsed:project:${run.projectId}`) === true)
      cache.set(`collapsed:project:${run.projectId}`, false);
    setPreviewTaskId(run.rootTaskId);
    const owner = projects.find((p) => p.id === run.projectId);
    navigate(
      {
        spaceId: owner?.spaceId || navigation.current.spaceId,
        projectId: run.projectId || '',
        runId: run.id,
      },
      true,
    );
    setPreviewOpen(false);
    setTab(run.kind === 'chat' ? 'agents' : 'tasks');
  };
  const newRun = () => {
    navigate({ ...navigation.current, runId: '' }, true);
    setDetail(null);
    setPreviewOpen(false);
  };
  const startFromRun = () => {
    if (!detail) return;
    setDraft(detail.run.objective);
    setModal('');
    newRun();
  };
  const feedbackAction = () => {
    switch (feedback?.action) {
      case 'artifacts':
        setPreviewOpen(false);
        setDetailsCollapsed(false);
        setDetailsDrawerOpen(true);
        setTab('artifacts');
        break;
      case 'plan':
        setPreviewOpen(false);
        requestAnimationFrame(() => planRef.current?.scrollIntoView({ block: 'start' }));
        break;
      case 'reply':
        replyRef.current?.focus();
        break;
      case 'questions':
        setPreviewOpen(false);
        requestAnimationFrame(() => {
          if (questionRef.current) {
            questionRef.current.scrollIntoView({ block: 'start' });
            questionRef.current.focus({ preventScroll: true });
          } else replyRef.current?.focus();
        });
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
      case 'new':
        startFromRun();
        break;
    }
  };
  const selectProject = (id: string) => {
    const owner = projects.find((p) => p.id === id);
    navigate({ spaceId: owner?.spaceId || navigation.current.spaceId, projectId: id, runId: '' }, true);
    setDetail(null);
    setPreviewOpen(false);
  };
  const managed = async (deleted?: { kind: 'project' | 'run' | 'space'; id: string }) => {
    if (
      (deleted?.kind === 'run' && deleted.id === runId) ||
      (deleted?.kind === 'project' && deleted.id === projectId)
    ) {
      if (deleted.kind === 'project') selectProject('');
      else newRun();
    } else if (runId) await refreshDetail();
    const refreshed = await refresh();
    if (deleted?.kind === 'run')
      setAssignmentDrafts((old) =>
        Object.fromEntries(Object.entries(old).filter(([key]) => !key.startsWith(deleted.id + ':'))),
      );
    if (deleted?.kind === 'run')
      cache.remove([`draft:run:${deleted.id}`, `pinned:run:${deleted.id}`, `unread:run:${deleted.id}`]);
    if (deleted?.kind === 'project') {
      const children = runs.filter((run) => run.projectId === deleted.id);
      cache.remove([
        newDraftKey(deleted.id),
        `collapsed:project:${deleted.id}`,
        ...children.flatMap((run) => [`draft:run:${run.id}`, `pinned:run:${run.id}`, `unread:run:${run.id}`]),
      ]);
    }
    return refreshed;
  };
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
        await mutation(
          `/${target.kind === 'run' ? 'runs' : 'projects'}/${current.id}`,
          { ...changes, expectedRevision: target.item.revision },
          remove ? 'DELETE' : 'PATCH',
        );
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
      if (remove) await managed({ kind: target.kind, id: current.id });
    });
    return conflicted ? 'conflict' : succeeded;
  };
  const totalTokens =
    detail?.requests.reduce((s, r) => s + (r.usage?.inputTotal ?? 0) + (r.usage?.outputTotal ?? 0), 0) || 0;
  const runAction = (action: string, taskId?: string) =>
    runReadOnly
      ? Promise.resolve(false)
      : act(() =>
          mutation('/runs/' + runId + '/actions', { action, taskId, expectedRevision: detail!.run.revision }),
        );
  const switchSurface = (surface: 'native' | 'terminal') => {
    if (surface === localSurface || actionPending.current || sessionInitializing) return;
    void cache.flush();
    changeSurface(surface);
  };
  const surfaceSwitcher = (
    <SurfaceSwitcher disabled={busy || sessionInitializing} switching={false} change={switchSurface} />
  );
  function openArtifact(a: ArtifactTarget) {
    if (a.runId !== activeRunId.current) return;
    setArtifactView({ id: a.id, name: a.name, runId: a.runId });
    setDetailsDrawerOpen(false);
    setPreviewOpen(true);
  }
  if (!ready)
    return (
      <div className="auth-screen">
        <div className="surface-loading-switcher">{surfaceSwitcher}</div>
        <BrandIcon />
        <h1>{terminalSurface ? 'Agent 终端' : 'Elysia'}</h1>
        <p>{readIssue?.message || (terminalSurface ? '正在连接 Agent 终端…' : '正在连接 Elysia…')}</p>
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
      </div>
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
                navigate({ spaceId: e.target.value, projectId: '', runId: '' }, true);
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
            selectProject(id);
            if (objective !== undefined) cache.set(newDraftKey(id), objective);
          }}
          files={(target) => {
            selectProject(target.id);
            setModal('project-files');
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
          >
            <Icon name="history" />
            <span>项目、对话与归档</span>
          </button>
          <button
            className="nav-item"
            onClick={() => setModal('settings')}
            aria-label={terminalSurface ? '终端管理' : '模型与设置'}
            title={terminalSurface ? '终端管理' : '模型与设置'}
          >
            <Icon name="settings" />
            <span>{terminalSurface ? '终端管理' : '模型与设置'}</span>
          </button>
          <div
            className="cache-state"
            role="status"
            title={cacheState.error || '输入内容按项目和会话自动保存在本机'}
          >
            {cacheState.status === 'error' ? (
              <>
                保存失败 · 草稿已保留 <button onClick={() => void cache.retry()}>重试保存</button>
              </>
            ) : cacheState.status === 'saving' ? (
              '正在保存草稿与偏好…'
            ) : (
              '草稿与偏好已保存'
            )}
          </div>
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
            <span
              className="breadcrumb-project"
              title={project?.name || (terminalSurface ? 'Agent 终端' : '独立对话')}
            >
              {project?.name || (terminalSurface ? 'Agent 终端' : '独立对话')}
            </span>
            <span className="slash">/</span>
            <strong title={detail?.run.objective}>
              {detail
                ? detail.run.title || detail.run.objective
                : project
                  ? '新建任务'
                  : terminalSurface
                    ? '选择项目'
                    : '新建对话'}
            </strong>
          </div>
          <div className="topbar-right">
            <span className="local-chip port-chip" title={location.origin}>
              <Icon name="lock" size={12} />
              本机 · {location.port}
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
            <button onClick={() => setError('')} aria-label="关闭错误">
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
                aria-label="重试连接"
                disabled={retrying || busy}
                aria-busy={retrying}
                onClick={() => void connect(true, readSource, readIssue.runId)}
              >
                <Icon name="refresh" size={16} />
                {retrying ? '正在重试…' : '重试连接'}
              </button>
            )}
            <button onClick={() => readSource && clearReadIssue(readSource)} aria-label="关闭连接错误">
              <Icon name="close" size={16} />
            </button>
          </div>
        )}
        {!runId ? (
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
        ) : detail ? (
          <>
            <div className="run-toolbar" inert={detailsOverlayOpen}>
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
                  className="quiet-button details-toggle"
                  aria-expanded={detailsVisible}
                  aria-controls={localSurface + '-run-details'}
                  onClick={() => {
                    setPreviewOpen(false);
                    if (compactLayout) setDetailsDrawerOpen(!detailsVisible);
                    else setDetailsCollapsed(detailsVisible);
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
                      {feedback.control === 'retry' ? '重试' : '恢复'}
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
            <div
              key={detail.run.id}
              className={'run-layout' + (previewOpen ? ' preview-open' : '') + (isChat ? ' chat-layout' : '')}
            >
              <section className="conversation" inert={detailsOverlayOpen}>
                <ConversationScroll
                  positionKey={detail.run.id + ':' + (detail.messagePage?.before || '')}
                  startAtLatest={!detail.messagePage?.before}
                >
                  {(detail.messagePage?.hasMore || detail.messagePage?.before) && (
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
                        更早消息
                      </button>
                      <span role="status">
                        {historyLoading
                          ? '读取历史…'
                          : detail.messagePage?.before
                            ? '正在查看历史'
                            : '最近消息'}
                      </span>
                      {detail.messagePage?.before && (
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
                    if (m.purpose === 'model_handoff')
                      return (
                        <div className="system-note model-handoff" key={m.id}>
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
                      <div className={'message ' + m.role} key={m.id}>
                        <div className={'message-avatar ' + m.role}>
                          {m.role === 'user' ? (
                            '你'
                          ) : (
                            <Icon name={task?.spec.role === 'coordinator' ? 'spark' : 'tree'} size={17} />
                          )}
                        </div>
                        <div className="message-body">
                          <div className="message-label">
                            {m.role === 'user'
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
                          {m.text &&
                            (m.role === 'assistant' ? (
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
                          {m.calls?.map((c) => (
                            <ToolActivity
                              key={c.id}
                              call={c}
                              operation={messageIndex.operations.get(c.id)}
                              toolResponse={messageIndex.responses.get(c.id)}
                              taskStatus={task?.status}
                            />
                          ))}
                        </div>
                      </div>
                    );
                  })}
                  {Object.entries(streaming)
                    .filter(([, value]) => value && !detail.messagePage?.before)
                    .map(([taskId, value]) => (
                      <div className="message assistant" key={taskId}>
                        <div className="message-avatar assistant">
                          <Icon name="spark" size={17} />
                        </div>
                        <div className="message-body">
                          <div className="message-label">
                            正在生成
                            <span className="typing-dot" />
                          </div>
                          <MarkdownDocument
                            text={value}
                            onLocalLink={
                              detail.run.contract.permissionProfile.read
                                ? previewFileLinks.get(taskId)
                                : undefined
                            }
                          />
                        </div>
                      </div>
                    ))}
                  {detail.tasks
                    .filter((t) => t.status === 'RUNNING' && !streaming[t.id] && !detail.messagePage?.before)
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
                              : '正在等待模型响应…'}
                          </p>
                        </div>
                      </div>
                    ))}
                  {questions.map((question, index) => (
                    <div
                      className="question-card"
                      key={question.eventId}
                      id={`${localSurface}-question-${question.taskId}`}
                      ref={index === 0 ? questionRef : undefined}
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
                      key={detail.run.id}
                      anchorRef={planRef}
                      detail={detail}
                      providers={providers}
                      assignments={assignments}
                      assignmentReady={assignmentReady}
                      proposedChoice={proposedChoice}
                      busy={busy}
                      archived={runReadOnly}
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
                        void act(() =>
                          mutation('/runs/' + runId + '/plan/accept', {
                            expectedRevision: detail.run.revision,
                            version: detail.run.plan!.version,
                            assignments: detail.run.plan!.tasks.map((task) => ({
                              key: task.key,
                              ...(assignments[task.key] || proposedChoice(task)),
                            })),
                          }),
                        )
                      }
                    />
                  )}
                  {detail.run.execution?.kind === 'docker-agent' &&
                    detail.run.reason === 'terminal_review' && (
                      <div className="delivery-card">
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
                            <TerminalContinuation run={detail.run} disabled={busy} act={act} />
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
                  {detail.run.execution?.kind === 'docker-agent' &&
                    detail.run.reason === 'terminal_verification' &&
                    detail.operations
                      .filter(
                        (operation) =>
                          operation.name === 'terminal_agent' && operation.status === 'UNCERTAIN',
                      )
                      .map((operation) => (
                        <TerminalRecovery
                          key={operation.id}
                          disabled={busy || runReadOnly}
                          submit={(outcome, note) =>
                            void act(() =>
                              mutation('/runs/' + detail.run.id + '/terminal/verify', {
                                expectedRevision: detail.run.revision,
                                operationId: operation.id,
                                outcome,
                                note,
                              }),
                            )
                          }
                        />
                      ))}
                  {!isChat && detail.run.status === 'DONE' && (
                    <div className="delivery-card">
                      <Icon name="check" size={24} />
                      <div>
                        <h3>交付已通过证据核验</h3>
                        <p>查看右侧产物和差异，复核内容是否符合你的目标。</p>
                      </div>
                    </div>
                  )}
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
                      }}
                    >
                      {isChat ? '新建独立对话' : '查看产物'}
                      <Icon name="arrow" size={14} />
                    </button>
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
                      value={reply}
                      onChange={(e) => cache.set(replyKey, e.target.value)}
                      onKeyDown={(e) => {
                        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && !e.nativeEvent.isComposing) {
                          e.preventDefault();
                          sendReply();
                        }
                      }}
                      placeholder={
                        legacyTerminal
                          ? '旧终端记录仅供查看'
                          : archived
                            ? '恢复归档后可继续对话'
                            : isChat
                              ? '继续对话…'
                              : '回答问题，或补充需求…'
                      }
                      disabled={runReadOnly || ['DONE', 'CANCELLED'].includes(detail.run.status)}
                    />
                    {!isChat &&
                      !runReadOnly &&
                      !['DONE', 'CANCELLED'].includes(detail.run.status) &&
                      (detail.run.authorized || detail.run.plan) && (
                        <p className="field-help" style={{ padding: '0 16px 10px' }}>
                          {detail.run.execution?.kind === 'docker-agent'
                            ? '终端执行中收到的补充需求会保存到记录。正常结束后可在验收卡片中补充需求并继续；中断须先核验。'
                            : detail.run.planMode === false
                              ? '补充消息会在安全边界送入当前任务；权限和累计预算保持。'
                              : '发送后旧计划将失效，未完成子任务会取消；总代理重新规划后需再次确认。'}
                        </p>
                      )}
                    <div>
                      <div className="reply-model-controls">
                        <button
                          type="button"
                          className="composer-model"
                          aria-label={`切换${isChat ? '会话' : '总代理'}模型`}
                          disabled={
                            busy ||
                            !rootAgent ||
                            !!rootModelReason ||
                            detail.run.execution?.kind === 'docker-agent'
                          }
                          title={rootModelReason || rootAgent?.providerBinding.label}
                          onClick={() => rootAgent && setModal('model:' + rootAgent.id)}
                        >
                          <Icon name="spark" size={15} />
                          <span>
                            {detail.run.execution?.kind === 'docker-agent'
                              ? detail.run.execution.profile.agent.toUpperCase()
                              : rootAgent?.providerBinding.model || '模型准备中…'}
                          </span>
                          <Icon name="chevron" size={12} />
                        </button>
                        {detail.run.execution?.kind !== 'docker-agent' && (
                          <ContextMeter
                            projection={rootContext}
                            showStreaming
                            disabled={!rootContext || busy}
                            open={() => rootContext && setModal('context:' + rootContext.agentId)}
                          />
                        )}
                        <span className="reply-hint">
                          {busy
                            ? '正在提交…'
                            : legacyTerminal
                              ? '旧终端记录 · 只读'
                              : archived
                                ? '已归档，保留全部对话记录'
                                : isChat
                                  ? 'Ctrl + Enter 发送 · 独立会话自动保存'
                                  : detail.run.execution?.kind === 'docker-agent'
                                    ? 'Ctrl + Enter 发送 · 补充说明保存到任务记录'
                                    : 'Ctrl + Enter 发送 · 补充需求在安全边界应用'}
                        </span>
                      </div>
                      <button
                        className="send-button"
                        aria-label="发送补充需求"
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
              </section>
              <Presence>
                {previewOpen && (
                  <PreviewDock
                    key={runId}
                    workspaceRequestId={previewFileTarget?.requestId}
                    logContexts={logContexts}
                    workspaceAvailable={detail.run.contract.permissionProfile.read}
                    artifacts={detail.artifacts}
                    selectedArtifactId={artifactView?.runId === runId ? artifactView.id : undefined}
                    selectArtifact={(artifact) =>
                      setArtifactView(
                        artifact ? { id: artifact.id, name: artifact.name, runId: artifact.runId } : null,
                      )
                    }
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
                        onClick={() => setTab(t.key)}
                      >
                        <Icon name={t.icon} size={15} />
                        {t.title}
                      </button>
                    ))}
                  </MotionTabs>
                  <MotionContent className="detail-content" motionKey={tab}>
                    {tab === 'tasks' && (
                      <>
                        <div className="panel-heading">
                          <h3>执行拓扑</h3>
                          <span>
                            {detail.tasks.filter((t) => t.status === 'DONE').length}/{detail.tasks.length}{' '}
                            完成
                          </span>
                        </div>
                        <TaskGraph detail={detail} archived={runReadOnly} />
                        <div className="panel-heading">
                          <h3>任务列表</h3>
                          <span>按任务查看进度与结果</span>
                        </div>
                        {detail.tasks.map((t) => (
                          <div className="task-detail" key={t.id}>
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
                            {detail.agents.length}/{detail.run.limits.maxAgents}
                          </span>
                        </div>
                        {agentOrder(detail.agents).map((a) => {
                          const task = detail.tasks.find((t) => t.id === a.taskId);
                          const switchReason = legacyTerminal
                            ? '旧终端记录仅供查看。'
                            : modelSwitchReason(detail, archived, a.taskId);
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
                                    : task?.spec.title}
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
                                  disabled={
                                    busy ||
                                    runReadOnly ||
                                    !detail.contexts?.some((item) => item.agentId === a.id)
                                  }
                                  open={() => setModal('context:' + a.id)}
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
                                      !!switchReason ||
                                      (!detail.run.authorized && task.phase !== 'planning')
                                    }
                                    onClick={() => void runAction('resume_task', task.id)}
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
                          <span>{detail.artifacts.length} 个</span>
                        </div>
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
                                onClick={() => setModal('decision:' + o.id)}
                              >
                                提交核验决定
                              </button>
                            </div>
                          ))}
                        {!detail.operations.some((o) => o.status === 'UNCERTAIN') && (
                          <p className="muted small">当前没有待核验副作用</p>
                        )}
                      </>
                    )}
                    {tab === 'usage' && (
                      <UsagePanel
                        detail={detail}
                        totalTokens={totalTokens}
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
      <ModalErrorContext.Provider value={error || readIssue?.message || ''}>
        <Presence>
          {modal ? (
            <React.Fragment key={modal}>
              {modal === 'project' && (
                <ProjectModal
                  spaces={spaces}
                  projects={projects}
                  initialSpaceId={spaceId}
                  close={() => setModal('')}
                  busy={busy}
                  submit={(body) =>
                    act(async () => {
                      const p = await mutation<Project>('/projects', body);
                      navigate({ spaceId: p.spaceId, projectId: p.id, runId: '' }, true);
                      setModal('');
                    })
                  }
                />
              )}
              {modal === 'project-files' && project && (
                <Modal title={project.name} subtitle={project.workspaceRoot} close={() => setModal('')} wide>
                  <ProjectFiles projectId={project.id} />
                </Modal>
              )}
              {modal.startsWith('manage:') && (
                <WorkspaceManager
                  spaces={spaces}
                  projects={projects}
                  runs={runs}
                  initial={modal.slice(7)}
                  close={() => setModal('')}
                  updated={managed}
                  selectRun={selectRun}
                />
              )}
              {modal === 'run' && (!terminalSurface || (project && terminalProfile)) && (
                <RunModal
                  objective={draft}
                  kind={project ? 'task' : 'chat'}
                  projectName={project?.name}
                  providers={providers}
                  modelChoice={homeModel}
                  contextPolicy={homeContext}
                  terminalTemplate={terminalProfile}
                  terminalConnections={terminalControl?.connections || []}
                  initial={runSetup?.key === runSetupKey ? runSetup.draft : undefined}
                  close={() => {
                    setRunSetup(null);
                    setModal('');
                  }}
                  busy={busy}
                  submit={(body) =>
                    act(async () => {
                      const run = await mutation<Run>('/runs', {
                        ...body,
                        objective: draft,
                        kind: project ? 'task' : 'chat',
                        projectId: projectId || null,
                      });
                      selectRun(run);
                      setDraft('');
                      setRunSetup(null);
                      setModal('');
                    })
                  }
                  settings={(configuration) => {
                    if (actionPending.current) return;
                    setRunSetup({ key: runSetupKey, draft: configuration });
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
                      initial={terminalSettings}
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
              {(modal === 'settings' || modal === 'run-settings') && !terminalSurface && (
                <React.Suspense
                  fallback={
                    <Modal title="模型与连接" close={() => setModal(modal === 'run-settings' ? 'run' : '')}>
                      <div className="form-body" role="status">
                        正在加载模型设置…
                      </div>
                    </Modal>
                  }
                >
                  <ProviderSettings
                    providers={providers}
                    close={() => setModal(modal === 'run-settings' ? 'run' : '')}
                    updated={refresh}
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
                  key={detail.run.id + ':' + contextAgent.agentId}
                  projection={contextAgent}
                  title={
                    detail.tasks.find((task) => task.id === contextAgent.taskId)?.spec.title || '当前会话'
                  }
                  runRevision={detail.run.revision}
                  busy={busy}
                  close={() => setModal('')}
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
              {modal === 'contract' && detail && (
                <ContractModal
                  contract={detail.run.contract}
                  planMode={detail.run.planMode !== false}
                  close={() => setModal('')}
                  busy={busy}
                  disabled={
                    runReadOnly ||
                    ['DONE', 'CANCELLED'].includes(detail.run.status) ||
                    detail.run.execution?.kind === 'docker-agent'
                  }
                  submit={(contract) =>
                    act(async () => {
                      await mutation('/runs/' + runId + '/messages', {
                        expectedRevision: detail.run.revision,
                        contract,
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
    </div>
  );
}
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
function UsagePanel({
  detail,
  totalTokens,
  configureContext,
}: {
  detail: Detail;
  totalTokens: number;
  configureContext: (projection: ContextProjection) => void;
}) {
  if (detail.run.execution?.kind === 'docker-agent')
    return (
      <div className="terminal-activity">
        <h3>Docker Agent 执行</h3>
        <p>
          {detail.run.execution.profile.label} · {detail.run.execution.profile.image}
        </p>
        <p className="field-help">
          外部 Agent 管理模型请求与用量，Elysia 未观测其 Token 与费用。请结合终端日志及服务商用量复核。
        </p>
        <p className="field-help">最长 {detail.run.limits.maxMinutes} 分钟 · 容器 2 CPU / 2 GiB 内存</p>
      </div>
    );
  const settled = detail.requests.filter((r) => r.status === 'SETTLED'),
    unknown = detail.requests.filter((r) => r.status === 'UNKNOWN');
  const totalCostKnown = settled.length && settled.every((r) => r.usage?.cost !== null);
  const costs = settled.reduce((sum, r) => sum + (r.usage?.cost || 0), 0);
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
            {detail.requests.length}
            <small> / {detail.run.contract.budget.maxRequests}</small>
          </strong>
        </div>
        <div>
          <span>实际 Token</span>
          <strong>{totalTokens.toLocaleString()}</strong>
        </div>
        <div>
          <span>已知成本</span>
          <strong>{totalCostKnown ? costs.toFixed(4) : '—'}</strong>
        </div>
        <div>
          <span>待核验调用</span>
          <strong>{unknown.length}</strong>
        </div>
      </div>
      <div className="budget-bar">
        <i
          style={{
            transform: `scaleX(${Math.min(1, detail.requests.length / detail.run.contract.budget.maxRequests)})`,
          }}
        />
      </div>
      <div className="panel-heading">
        <h3>厂商缓存观测</h3>
      </div>
      {[...new Set(detail.requests.map((r) => r.providerId))].map((providerId) => {
        const rows = detail.requests.filter((r) => r.providerId === providerId && r.usage),
          cacheKnown = rows.length && rows.every((r) => r.usage?.cacheRead !== null),
          input = rows.reduce((s, r) => s + (r.usage?.inputTotal || 0), 0),
          cache = rows.reduce((s, r) => s + (r.usage?.cacheRead || 0), 0),
          ttft = rows.map((r) => r.usage?.ttftMs).filter((n): n is number => typeof n === 'number');
        return (
          <div className="cache-card" key={providerId}>
            <div>
              <strong>{providerId}</strong>
              <span>{cacheKnown && input ? Math.round((cache / input) * 100) + '% 命中' : '待观测'}</span>
            </div>
            <p>
              读取 {cacheKnown ? cache.toLocaleString() : '—'} / 输入 {input.toLocaleString()} Token
            </p>
            <small>
              平均首字 {ttft.length ? Math.round(ttft.reduce((a, b) => a + b, 0) / ttft.length) + ' ms' : '—'}
            </small>
          </div>
        );
      })}
      {!detail.requests.length && (
        <Empty kind="workspace" title="等待真实调用" text="使用供应商返回的 usage；缺失指标显示为未知。" />
      )}
      <div className="info-note">
        资料快照复用、厂商 Prompt 缓存和会话续接分别记录。未返回用量的请求保留预算预留；成本需要有效价格配置。
      </div>
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
      {detail.requests.map((r) => (
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
      ))}
    </>
  );
}
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
  const cancelRead = () => {
    readSequence.current++;
    inspection.current?.controller.abort();
    inspection.current = null;
    chooser.current = null;
    setInspecting(false);
    setChoosing(false);
    setError('');
  };
  const closeProject = () => {
    if (creating.current) return;
    cancelRead();
    close();
  };
  const existing = projects.find(
    (item) =>
      item.spaceId === spaceId && item.workspaceRoot.toLowerCase() === folder?.workspaceRoot?.toLowerCase(),
  );
  const inspect = async (directory: string) => {
    if (creating.current || inspection.current || chooser.current !== null || !mounted.current) return;
    const sequence = ++readSequence.current,
      controller = new AbortController();
    inspection.current = { sequence, controller };
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
type RunSetupDraft = {
  planMode: boolean;
  executionKind: 'native' | 'docker-agent';
  terminalProfile: AgentTerminalProfile;
  choice: ModelChoice;
  contextPolicy: ContextPolicy;
  write: boolean;
  exec: boolean;
  urls: string;
  inputs: string;
  writePaths: string;
  maxRequests: number;
  maxTokens: number;
  concurrency: number;
};

function RunModal({
  providers,
  objective,
  kind,
  projectName,
  close,
  busy,
  submit,
  settings,
  initial,
  modelChoice,
  contextPolicy,
  terminalTemplate,
  terminalConnections = [],
}: {
  providers: Provider[];
  objective: string;
  kind: 'task' | 'chat';
  projectName?: string;
  close: () => void;
  busy: boolean;
  submit: (body: any) => void;
  settings: (draft: RunSetupDraft) => void;
  initial?: RunSetupDraft;
  modelChoice: ModelChoice;
  contextPolicy: ContextPolicy;
  terminalTemplate?: AgentTerminalProfile;
  terminalConnections?: TerminalConnectionView[];
}) {
  const { surface: localSurface } = useSurfaceClient();
  const executionKind = localSurface === 'terminal' ? 'docker-agent' : 'native';
  const [choice, setChoice] = useState<ModelChoice>(() => initial?.choice ?? modelChoice),
    [planMode, setPlanMode] = useState(initial?.planMode ?? true),
    [terminalProfile, setTerminalProfile] = useState<AgentTerminalProfile>(() =>
      structuredClone(initial?.terminalProfile ?? terminalTemplate ?? terminalPreset()),
    ),
    [modelReady, setModelReady] = useState(false),
    [context, setContext] = useState<ContextPolicy>(() => initial?.contextPolicy ?? contextPolicy),
    [write, setWrite] = useState(initial?.write ?? true),
    [exec, setExec] = useState(initial?.exec ?? true),
    [urls, setUrls] = useState(initial?.urls ?? ''),
    [inputs, setInputs] = useState(initial?.inputs ?? ''),
    [writePaths, setWritePaths] = useState(initial?.writePaths ?? '.'),
    [maxRequests, setMaxRequests] = useState(initial?.maxRequests ?? 80),
    [maxTokens, setMaxTokens] = useState(initial?.maxTokens ?? 500000),
    [concurrency, setConcurrency] = useState(initial?.concurrency ?? 4);
  const selected = providers.find((p) => p.id === choice.providerId);
  const contextValid = validContextPolicy(
    context,
    selected ? minimumContextWindowTokens(selected) : 4096,
    selected?.contextLimit || 4096,
  );
  const chat = kind === 'chat';
  const terminal = !chat && executionKind === 'docker-agent';
  const setupReady = terminal
    ? AgentTerminalProfile.safeParse(terminalProfile).success
    : modelReady && contextValid;
  const lines = (s: string) =>
    s
      .split('\n')
      .map((v) => v.trim())
      .filter(Boolean);
  return (
    <Modal
      title={chat ? '新建独立对话' : '新建项目任务'}
      subtitle={(chat ? '归属：独立会话' : `归属：${projectName}`) + ' · ' + objective.slice(0, 80)}
      close={close}
      busy={busy}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (busy || !setupReady || !objective.trim() || (localSurface === 'terminal' && chat)) return;
          submit({
            ...(terminal ? {} : { ...choice, contextPolicy: context }),
            planMode: terminal ? false : planMode,
            execution: terminal ? { kind: 'docker-agent', profile: terminalProfile } : { kind: 'native' },
            inputs: lines(inputs),
            permissionProfile: chat
              ? { read: false, write: false, exec: false, urls: [], writePaths: [] }
              : terminal
                ? { read: true, write: true, exec: true, urls: [], writePaths: ['.'] }
                : { read: true, write, exec, urls: lines(urls), writePaths: lines(writePaths) },
            budget: { maxRequests, maxTokens, maxCost: null },
            limits: {
              maxDepth: chat ? 0 : 2,
              maxAgents: chat ? 1 : 12,
              concurrency: chat ? 1 : concurrency,
              toolConcurrency: 4,
              maxSteps: 20,
              maxMinutes: terminal ? Math.ceil(terminalProfile.timeoutMs / 60000) : 30,
            },
          });
        }}
      >
        <div className="form-body">
          <p className="field-help">
            {chat
              ? '选择会话模型后开始聊天。独立对话可使用技能说明；处理项目文件和生成附件时，在项目下新建任务。'
              : terminal
                ? '确认终端配置后，在独立 Docker 任务目录中执行。'
                : '确认模型、计划模式与授权范围。'}
          </p>
          {!chat && !terminal && (
            <>
              <label className="check-label">
                <input
                  type="checkbox"
                  role="switch"
                  aria-label="计划模式"
                  checked={planMode}
                  disabled={busy}
                  onChange={(e) => setPlanMode(e.target.checked)}
                />
                计划模式
              </label>
              <p className="field-help">
                {planMode
                  ? '先生成计划，确认具体版本后执行。'
                  : '创建任务即授权在下方权限和预算内执行，仍需提供验收证据。'}
              </p>
            </>
          )}
          {terminal ? (
            <>
              <label>
                API 连接
                <select
                  aria-label="任务 API 连接"
                  value={
                    terminalProfile.connectionId === null ? 'environment' : terminalProfile.connectionId || ''
                  }
                  disabled={busy}
                  onChange={(event) => {
                    const { connection: _frozen, connectionId: _old, ...clean } = terminalProfile;
                    setTerminalProfile({
                      ...clean,
                      ...(event.target.value
                        ? { connectionId: event.target.value === 'environment' ? null : event.target.value }
                        : {}),
                    });
                  }}
                >
                  <option value="">使用默认连接</option>
                  <option value="environment">仅使用模板环境变量</option>
                  {terminalConnections
                    .filter(
                      (connection) =>
                        terminalProfile.agent === 'custom' ||
                        (terminalProfile.agent === 'codex'
                          ? connection.protocol === 'openai-responses'
                          : terminalProfile.agent === 'gemini'
                            ? connection.protocol === 'gemini'
                            : connection.protocol === 'anthropic-messages'),
                    )
                    .map((connection) => (
                      <option key={connection.id} value={connection.id}>
                        {connection.name} · {connection.model}
                      </option>
                    ))}
                </select>
              </label>
              <p className="field-help">
                连接在创建任务时固定。CLI 安装、API 连接和项目默认配置可在终端管理中调整。
              </p>
              <details>
                <summary>终端参数</summary>
                <TerminalSetup value={terminalProfile} change={setTerminalProfile} disabled={busy} />
              </details>
            </>
          ) : (
            <>
              <ModelPicker
                providers={providers}
                value={choice}
                change={setChoice}
                ready={setModelReady}
                disabled={busy}
                label={chat ? '会话模型连接' : '总代理连接'}
              />
              <details className="context-compact-setup">
                <summary>上下文窗口 · {context.mode === 'manual' ? '手动分配' : '托管'}</summary>
                <ContextPolicyEditor
                  value={context}
                  change={setContext}
                  minimumWindowTokens={selected ? minimumContextWindowTokens(selected) : 4096}
                  providerLimit={selected?.contextLimit || 4096}
                  disabled={busy || !selected}
                />
              </details>
              {['chatgpt', 'codex'].includes(selected?.authMode || '') && (
                <p className="field-help">
                  正在使用 ChatGPT 订阅 ·{' '}
                  <button type="button" className="text-button" disabled={busy} onClick={manageUsage}>
                    管理用量
                  </button>
                </p>
              )}
              {(!selected?.keyConfigured || selected.checkedRevision !== selected.revision) && (
                <div className="inline-warning">
                  请先连接并验证一个可用模型。
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      if (busy) return;
                      settings({
                        planMode,
                        executionKind,
                        terminalProfile,
                        choice,
                        contextPolicy: context,
                        write,
                        exec,
                        urls,
                        inputs,
                        writePaths,
                        maxRequests,
                        maxTokens,
                        concurrency,
                      });
                    }}
                  >
                    前往模型设置
                  </button>
                </div>
              )}
            </>
          )}
          {!chat && !terminal && (
            <>
              <label>
                补充资料路径（可选，每行一项）
                <textarea
                  value={inputs}
                  disabled={busy}
                  onChange={(e) => setInputs(e.target.value)}
                  placeholder="已可读取整个项目目录；可在此指定重点文件"
                  rows={2}
                />
              </label>
              <div className="permission-card">
                <h4>执行范围</h4>
                <label className="check-label">
                  <input type="checkbox" checked readOnly disabled={busy} />
                  项目内读取
                </label>
                <label className="check-label">
                  <input
                    type="checkbox"
                    checked={write}
                    disabled={busy}
                    onChange={(e) => setWrite(e.target.checked)}
                  />
                  任务目录写入
                </label>
                {write && (
                  <label>
                    允许写入的相对目录
                    <textarea
                      rows={1}
                      value={writePaths}
                      disabled={busy}
                      onChange={(e) => setWritePaths(e.target.value)}
                    />
                  </label>
                )}
                <label className="check-label">
                  <input
                    type="checkbox"
                    checked={exec}
                    disabled={busy}
                    onChange={(e) => setExec(e.target.checked)}
                  />
                  命令执行（当前系统用户权限）
                </label>
                <label>
                  授权网页 URL（每行一项）
                  <textarea
                    value={urls}
                    disabled={busy}
                    onChange={(e) => setUrls(e.target.value)}
                    rows={2}
                    placeholder="https://…"
                  />
                </label>
              </div>
            </>
          )}
          {!terminal && (
            <div className="form-columns">
              <label>
                模型请求上限
                <input
                  type="number"
                  min={1}
                  max={80}
                  value={maxRequests}
                  disabled={busy}
                  onChange={(e) => setMaxRequests(Number(e.target.value))}
                />
              </label>
              <label>
                Token 上限
                <input
                  type="number"
                  min={1000}
                  value={maxTokens}
                  disabled={busy}
                  onChange={(e) => setMaxTokens(Number(e.target.value))}
                />
              </label>
              {!chat && (
                <label>
                  并发实例
                  <input
                    type="number"
                    min={1}
                    max={4}
                    value={concurrency}
                    disabled={busy}
                    onChange={(e) => setConcurrency(Number(e.target.value))}
                  />
                </label>
              )}
            </div>
          )}
          <p className="field-help">
            {chat
              ? '普通回复后等待你继续。调用与 Token 按会话预算累计。'
              : terminal
                ? '只映射独立任务目录；不会修改项目主目录或自动发布。'
                : `${planMode ? '接受计划后' : '创建后'}执行。每次最多 12 个 Agent，递归深度 2，最长 30 分钟。`}
          </p>
        </div>
        <footer className="modal-footer">
          <button type="button" className="secondary" disabled={busy} onClick={close}>
            返回
          </button>
          <button className="primary" disabled={busy || !setupReady || !objective.trim()}>
            {busy
              ? '正在创建…'
              : chat
                ? '开始对话'
                : terminal
                  ? '创建 Docker 任务'
                  : planMode
                    ? '生成约定与计划'
                    : '开始执行'}
            <Icon name="arrow" size={15} />
          </button>
        </footer>
      </form>
    </Modal>
  );
}
function ContractModal({
  contract,
  planMode,
  close,
  submit,
  busy,
  disabled,
}: {
  contract: Contract;
  planMode: boolean;
  close: () => void;
  submit: (c: Contract) => void;
  busy: boolean;
  disabled: boolean;
}) {
  const [value, setValue] = useState(contract);
  const labels: Record<string, string> = {
    scope: '范围',
    nonGoals: '不包含',
    inputs: '输入资料',
    deliverables: '交付物',
    acceptanceCriteria: '验收项',
    constraints: '约束',
    assumptions: '可见假设',
  };
  return (
    <Modal
      title={'任务约定 · v' + contract.version}
      subtitle={
        disabled
          ? '当前约定仅供查看；继续调整可新建任务。'
          : planMode
            ? '修改后在安全边界重新生成计划，需再次确认；权限范围与累计预算保持。'
            : '在安全边界应用新的交付与验收项；权限范围与累计预算保持。'
      }
      busy={busy}
      close={close}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (busy || disabled) return;
          submit(value);
        }}
      >
        <div className="form-body">
          <label>
            目标
            <textarea
              disabled={busy}
              readOnly={disabled}
              value={value.objective}
              onChange={(e) => setValue((v) => ({ ...v, objective: e.target.value }))}
            />
          </label>
          {Object.entries(labels).map(([key, label]) => (
            <label key={key}>
              {label}（每行一项）
              <textarea
                rows={2}
                disabled={busy}
                readOnly={disabled}
                value={(value[key as keyof Contract] as string[]).join('\n')}
                onChange={(e) => setValue((v) => ({ ...v, [key]: e.target.value.split('\n') }))}
              />
            </label>
          ))}
          <p className="field-help">
            请求上限 {contract.budget.maxRequests} · Token 上限 {contract.budget.maxTokens}
          </p>
        </div>
        <footer className="modal-footer">
          <button type="button" className="secondary" disabled={busy} onClick={close}>
            关闭
          </button>
          <button className="primary" disabled={busy || disabled}>
            {busy ? '正在保存约定…' : planMode ? '保存并重新规划' : '保存约定并继续'}
          </button>
        </footer>
      </form>
    </Modal>
  );
}
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
    [note, setNote] = useState(''),
    [result, setResult] = useState(''),
    [parseError, setParseError] = useState('');
  return (
    <Modal title="核验副作用结果" subtitle="请先检查本机文件或进程证据，再提交决定" close={close} busy={busy}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (busy || disabledReason) return;
          try {
            const parsed = result.trim() ? JSON.parse(result) : undefined;
            setParseError('');
            submit({ operationId: operation.id, outcome, note, result: parsed });
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
function SurfaceEntry({
  client,
  active,
  changeSurface,
  registerCache,
}: {
  client: SurfaceClient;
  active: boolean;
  changeSurface: (surface: 'native' | 'terminal') => void;
  registerCache: (surface: 'native' | 'terminal', cache: WorkbenchCache) => void;
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
            <App changeSurface={changeSurface} registerCache={registerCache} />
          </Activity>
        </SurfaceRootContext.Provider>
      </SurfaceClientContext.Provider>
    </div>
  );
}

function SurfaceWorkspaces() {
  const [current, setCurrent] = useState(localSurface);
  const [visited, setVisited] = useState(() => new Set([localSurface]));
  const [clients] = useState(() => ({
    native: localSurface === 'native' ? defaultSurfaceClient : createSurfaceClient('native'),
    terminal: localSurface === 'terminal' ? defaultSurfaceClient : createSurfaceClient('terminal'),
  }));
  const caches = useRef(new Map<'native' | 'terminal', WorkbenchCache>());
  const registerCache = useCallback((surface: 'native' | 'terminal', cache: WorkbenchCache) => {
    caches.current.set(surface, cache);
  }, []);
  useEffect(
    () => () => {
      for (const cache of caches.current.values()) cache.stop();
    },
    [],
  );
  const changeSurface = useCallback((surface: 'native' | 'terminal') => {
    history.replaceState(null, '', surfaceLocation(surface));
    setVisited((old) => new Set([...old, surface]));
    setCurrent(surface);
  }, []);
  useEffect(() => {
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
            />
          ),
      )}
    </>
  );
}
createRoot(document.getElementById('root')!).render(<SurfaceWorkspaces />);
