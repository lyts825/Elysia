/**
 * 管理项目记忆及能力配置。
 * 编辑项目技能选择及记忆，分别维护目录、权威修订和本地原稿；提交回执只清理仍匹配请求的输入，未知写入结果保留核对依据。
 * EN: Manages project memories and capabilities. Edits project capability selections and memories while separating catalog, authoritative revision, and local source; acknowledgements clear only matching input and unknown writes retain reconciliation evidence.
 */
import { useEffect, useId, useRef, useState } from 'react';
import { z } from 'zod';
import type {
  ProjectIntelligenceView,
  ProjectMemory,
  ProjectMemoryList,
  ProjectMemoryVersion,
} from '../../../packages/contracts/src/project-intelligence';
import { ApiError } from './api';
import { useSurfaceClient } from './SurfaceClientContext';
import type { WorkbenchCache } from './WorkbenchCache';
import { ProjectModelRouting, routingDraftShape } from './ProjectModelRouting';
import './project-intelligence.css';

const ids = z.array(z.string().min(1).max(160)).max(500);
const selectionShape = z
  .object({ expectedRevision: z.number().int().nonnegative(), builtinSkillIds: ids, localItemIds: ids })
  .strict();
const memoryShape = z
  .object({
    id: z.string().uuid().optional(),
    expectedRevision: z.number().int().positive().optional(),
    title: z.string().max(160),
    text: z.string().max(200000),
    source: z.string().max(2000),
    status: z.enum(['draft', 'active', 'revoked']),
  })
  .strict();
const pendingShape = z.discriminatedUnion('kind', [
  /**
   * 持久化待处理操作及命令 ID，以便请求结果未知时保留核对依据。
   * EN: Persist pending operations/command IDs for reconciliation of unknown outcomes.
   */
  selectionShape.extend({ kind: z.literal('capability'), commandId: z.string().uuid() }),
  memoryShape.extend({ kind: z.literal('memory'), commandId: z.string().uuid() }),
  z
    .object({
      kind: z.literal('restore'),
      commandId: z.string().uuid(),
      id: z.string().uuid(),
      expectedRevision: z.number().int().positive(),
      restoreRevision: z.number().int().positive(),
    })
    .strict(),
]);
const draftShape = z
  .object({
    version: z.literal(1),
    selection: selectionShape.optional(),
    memory: memoryShape.optional(),
    pending: pendingShape.optional(),
    routing: routingDraftShape.optional(),
  })
  .strict();
type Draft = z.infer<typeof draftShape>;
type Pending = z.infer<typeof pendingShape>;
type MemoryDraft = z.infer<typeof memoryShape>;
type ReadState = { status: 'idle' | 'loading' | 'ready' | 'error'; message: string };
const idle: ReadState = { status: 'idle', message: '' };
const states = { draft: '草稿', active: '已启用', revoked: '已撤销' };
/**
 * 把Error实例的消息交给界面，其余未知失败使用统一可重试提示，避免渲染不可读异常对象。
 * EN: Exposes Error messages and uses a consistent retry message for unknown failures instead of rendering an unreadable exception object.
 */
const errorText = (issue: unknown) => (issue instanceof Error ? issue.message : '请求失败，请重试。');
/**
 * 按项目ID生成能力与记忆编辑草稿键，隔离不同项目的未提交输入。
 * EN: Builds a project-scoped capabilities and memory draft key, isolating unsaved inputs between projects.
 */
export const projectIntelligenceKey = (id: string) => `draft:project-intelligence:${id}`;

/**
 * 严格读取持久草稿；损坏、超限或记忆 ID/版本配对不完整时抛错，调用方保留原文供导出。
 * 缺少草稿是合法初始状态，不能把无法读取的草稿静默替换成空对象。
 * EN: Strictly restore drafts; reject corruption, oversize input, or incomplete memory ID/revision pairing and preserve original for export. Absence is valid, unreadability must not silently become empty.
 */
function readDraft(raw: unknown): Draft {
  if (raw === undefined || raw === '') return { version: 1 };
  if (typeof raw !== 'string' || raw.length > 200000) throw Error('能力与记忆草稿无法读取，原文保留。');
  const result = draftShape.safeParse(JSON.parse(raw));
  if (!result.success) throw Error('能力与记忆草稿格式或版本无法读取，原文保留。');
  if (
    result.data.pending?.kind === 'memory' &&
    !!result.data.pending.id !== !!result.data.pending.expectedRevision
  )
    throw Error('保存请求的记忆版本不完整，原稿保留。');
  return result.data;
}
/**
 * 从权威记忆生成编辑基线，expectedRevision 随草稿保存以检测后续并发修改。
 * EN: Build editing baseline from authoritative memory and retain expectedRevision for concurrent changes.
 */
function memoryDraft(memory: ProjectMemory): MemoryDraft {
  return {
    id: memory.id,
    expectedRevision: memory.revision,
    title: memory.title,
    text: memory.text,
    source: memory.source,
    status: memory.status,
  };
}
/**
 * 逐项比较记忆草稿身份、预期版本和内容；提交回执只清理仍与原请求一致的草稿。
 * EN: Compares memory identity, expected revision, and content so an acknowledgement clears only a draft still matching its request.
 */
const sameMemory = (value: MemoryDraft | undefined, request: MemoryDraft) =>
  !!value &&
  ['id', 'expectedRevision', 'title', 'text', 'source', 'status'].every(
    (key) => value[key as keyof MemoryDraft] === request[key as keyof MemoryDraft],
  );
/**
 * 比较能力选择的预期版本及两个有序ID列表，用于防止旧保存结果清除后续编辑。
 * EN: Compares expected revision and both ordered capability-ID lists so an old save result cannot clear subsequent edits.
 */
const sameSelection = (
  value: z.infer<typeof selectionShape> | undefined,
  request: z.infer<typeof selectionShape>,
) =>
  !!value &&
  value.expectedRevision === request.expectedRevision &&
  JSON.stringify(value.builtinSkillIds) === JSON.stringify(request.builtinSkillIds) &&
  JSON.stringify(value.localItemIds) === JSON.stringify(request.localItemIds);
/**
 * 将无法安全处理的原草稿原样导出为文本，下载后延迟释放对象 URL。
 * EN: Export unsafe-to-process originals verbatim as text; release URL after download starts.
 */
function exportOriginal(raw: unknown, projectId: string) {
  const url = URL.createObjectURL(
    new Blob([typeof raw === 'string' ? raw : JSON.stringify(raw ?? '')], {
      type: 'text/plain;charset=utf-8',
    }),
  );
  const link = document.createElement('a');
  link.href = url;
  link.download = `project-intelligence-${projectId}.txt`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * 用 projectId 作为编辑器身份；切换项目重新建立读取、草稿和提交状态。
 * EN: Key editor by projectId to rebuild reads/drafts/submission state on project changes.
 */
export function ProjectIntelligence({
  projectId,
  cache,
  archived = false,
}: {
  projectId: string;
  cache: WorkbenchCache;
  archived?: boolean;
}) {
  return <IntelligenceEditor key={projectId} projectId={projectId} cache={cache} archived={archived} />;
}

/**
 * 管理项目冻结能力选择、项目记忆及模型路由草稿。能力和记忆分别读取，草稿单独加载；
 * 未知保存结果以 pending 命令持久保留并锁住新提交，直到相同负载重试得到确定结果。
 * 归档、草稿损坏或基线版本过期时保持只读或要求重新核对，不能自行覆盖服务端数据。
 * EN: Track capability/memory reads and local draft separately. Persist unknown saves as pending exact commands and lock new submissions until identical retry resolves them. Archive/corruption/stale baseline requires read-only handling or renewed review, not automatic server overwrite.
 */
function IntelligenceEditor({
  projectId,
  cache,
  archived,
}: {
  projectId: string;
  cache: WorkbenchCache;
  archived: boolean;
}) {
  const { api, mutation } = useSurfaceClient();
  const editorId = useId();
  const key = projectIntelligenceKey(projectId),
    base = `/projects/${projectId}`;
  const [view, setView] = useState<ProjectIntelligenceView>();
  const [memories, setMemories] = useState<ProjectMemoryList>();
  const [capRead, setCapRead] = useState<ReadState>(idle),
    [memoryRead, setMemoryRead] = useState<ReadState>(idle);
  const [loaded, setLoaded] = useState(false),
    [draftError, setDraftError] = useState('');
  const [actionError, setActionError] = useState(''),
    [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false),
    [draftAttempt, setDraftAttempt] = useState(0),
    [, rerender] = useState(0);
  const [query, setQuery] = useState(''),
    [historyId, setHistoryId] = useState('');
  const [restore, setRestore] = useState<{
    id: string;
    expectedRevision: number;
    version: ProjectMemoryVersion;
  }>();
  const [clearConfirmed, setClearConfirmed] = useState(false);
  const searchInput = useRef<HTMLInputElement>(null);
  const active = useRef(true),
    writing = useRef(false);
  const readers = useRef<{ capabilities?: AbortController; memories?: AbortController }>({});
  /**
   * 组件生命周期控制能力与记忆异步回写权限；卸载同时取消两个资源读取，提交结果另通过active检查。
   * EN: Uses component lifetime to gate capability/memory updates, aborting both resource readers on teardown while submissions separately check active.
   */
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      Object.values(readers.current).forEach((reader) => reader?.abort());
    };
  }, []);
  /**
   * 缓存、项目键或重试代次变化时先确保完整原稿已载入；只有仍有效的effect发布就绪或错误，避免空状态覆盖未读草稿。
   * EN: Ensures the complete source draft is loaded when cache, project key, or retry changes; only the live effect publishes readiness/error so an empty state cannot replace unread input.
   */
  useEffect(() => {
    let current = true;
    void cache
      .ensureKey(key)
      .then(() => {
        if (current) {
          setLoaded(true);
          setDraftError('');
        }
      })
      .catch((issue) => {
        if (current) setDraftError(errorText(issue));
      });
    return () => {
      current = false;
    };
  }, [cache, key, draftAttempt]);

  /**
   * 取消同类旧读取后验证项目归属，再发布结果；能力读取不取消记忆读取。
   * EN: Cancel old same-kind reads, validate project, then publish; capability reads do not cancel memories.
   */
  async function read(kind: 'capabilities' | 'memories') {
    /**
     * 能力和记忆分别取消及读取；结果必须属于当前项目。
     * EN: Read/cancel capabilities and memories independently and validate current project.
     */
    readers.current[kind]?.abort();
    const controller = new AbortController();
    readers.current[kind] = controller;
    const setRead = kind === 'capabilities' ? setCapRead : setMemoryRead;
    setRead({ status: 'loading', message: '' });
    try {
      if (kind === 'capabilities') {
        const next = await api<ProjectIntelligenceView>(
          base + '/intelligence',
          undefined,
          undefined,
          controller.signal,
        );
        if (next.config.projectId !== projectId) throw Error('项目能力所属不匹配，请重新读取。');
        if (active.current && !controller.signal.aborted) setView(next);
      } else {
        const next = await api<ProjectMemoryList>(
          base + '/memories',
          undefined,
          undefined,
          controller.signal,
        );
        if (next.projectId !== projectId || next.memories.some((item) => item.projectId !== projectId))
          throw Error('项目记忆所属不匹配，请重新读取。');
        if (active.current && !controller.signal.aborted) setMemories(next);
      }
      if (active.current && !controller.signal.aborted) setRead({ status: 'ready', message: '' });
    } catch (issue) {
      if (active.current && !controller.signal.aborted)
        setRead({ status: 'error', message: errorText(issue) });
    }
  }
  /**
   * 入口客户端或项目变化时分别读取能力目录和记忆基线，两类读取保持独立状态，取消由各读取器与生命周期清理协调。
   * EN: Reads capability and memory baselines separately after client/project changes, retaining independent read state with cancellation coordinated by their readers and lifecycle cleanup.
   */
  useEffect(() => {
    void read('capabilities');
    void read('memories');
  }, [api, projectId]);
  /**
   * 取消指定能力或记忆读取并标记需重读，保留上次结果和本地输入以供核对。
   * EN: Cancels a capabilities or memories read and marks it for rereading while retaining the prior result and local input for inspection.
   */
  function cancel(kind: 'capabilities' | 'memories') {
    readers.current[kind]?.abort();
    (kind === 'capabilities' ? setCapRead : setMemoryRead)({
      status: 'error',
      message: '读取已取消，保留上次结果及输入。请重新读取后再保存。',
    });
  }
  let draft: Draft | undefined,
    parseError = '';
  try {
    if (loaded) draft = readDraft(cache.get(key));
  } catch (issue) {
    parseError = errorText(issue);
  }
  /**
   * 基于缓存中的最新草稿执行更新，再校验形状和总容量，成功后触发当前组件重读。
   * EN: Update newest cached draft, validate shape/capacity, then trigger reread after save.
   */
  function change(update: (value: Draft) => Draft) {
    /**
     * 先校验并检查容量，再覆盖缓存；失败时保留原草稿。
     * EN: Validate/capacity-check before cache replacement; preserve old draft on failure.
     */
    try {
      if (!loaded || !active.current) return false;
      const next = draftShape.parse(update(readDraft(cache.get(key))));
      const raw = JSON.stringify(next);
      if (raw.length > 200000) throw Error('能力与记忆草稿超过 200000 字符，未覆盖原稿。');
      cache.set(key, raw);
      rerender((value) => value + 1);
      setDraftError('');
      return true;
    } catch (issue) {
      setDraftError(errorText(issue));
      return false;
    }
  }
  const pending = draft?.pending,
    locked = busy || !!pending || archived || !draft;
  const selection =
    draft?.selection ??
    (view
      ? {
          expectedRevision: view.config.revision,
          builtinSkillIds: view.config.builtinSkillIds,
          localItemIds: view.config.localItemIds,
        }
      : undefined);
  const selectionStale = !!selection && !!view && selection.expectedRevision !== view.config.revision;
  const editor = draft?.memory;
  const currentMemory = editor?.id ? memories?.memories.find((item) => item.id === editor.id) : undefined;
  const memoryStale = !!editor?.id && (!currentMemory || editor.expectedRevision !== currentMemory.revision);
  const bytes = new TextEncoder().encode(editor?.text ?? '').length;
  const memoryLimit = memories?.limits.memoryBytes ?? 16384;
  const history = memories?.memories.find((item) => item.id === historyId);
  /**
   * 将名称与描述组合后按去空白、忽略大小写的查询筛选能力列表。
   * EN: Filters capabilities by matching a trimmed case-insensitive query against combined name and description.
   */
  const matched = (name: string, description: string) =>
    `${name} ${description}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
  /**
   * 把已选技能和本地导入ID解析为目录名称；缺失项保留失效标识，空集合明确显示未选择。
   * EN: Resolves selected skill/import IDs to catalog names, preserving invalid-ID labels for missing entries and an explicit empty-selection label.
   */
  const capabilityNames = (value: { builtinSkillIds: string[]; localItemIds: string[] }) =>
    [
      ...value.builtinSkillIds.map(
        (id) => view?.catalog.builtinSkills.find((item) => item.id === id)?.name ?? `已失效技能 ${id}`,
      ),
      ...value.localItemIds.map(
        (id) => view?.catalog.localItems.find((item) => item.id === id)?.name ?? `已失效导入项 ${id}`,
      ),
    ].join('、') || '未选择能力';
  /**
   * 在未锁定且已有选择草稿时增删指定能力ID；新增使用Set去重，其余草稿字段通过change保留。
   * EN: Adds or removes a capability ID only for an unlocked existing selection, deduplicating additions with Set and preserving other draft fields through change.
   */
  function toggle(field: 'builtinSkillIds' | 'localItemIds', id: string, checked: boolean) {
    if (!selection || locked) return;
    const next = {
      ...selection,
      [field]: checked
        ? [...new Set([...selection[field], id])]
        : selection[field].filter((value) => value !== id),
    };
    change((value) => ({ ...value, selection: next }));
  }
  /**
   * 发送前将精确负载和 commandId 写入草稿，并确认它仍对应当前编辑内容。
   * 成功只清除属于本次命令且未被改动的部分；记忆写入后重新读完整列表。
   * 未知错误保留 pending，用户只能核对或重试同一请求，避免重复创建或覆盖新版本。
   * EN: Persist exact payload/commandId before sending and confirm matching edits. Clear only unchanged parts of this command on success, then reread memories. Unknown failure retains pending for identical retry/reconciliation, avoiding duplicate creates or newer-version overwrite.
   */
  async function submit(request: Pending) {
    /**
     * 发送前固定当前输入和请求；已有待核对请求只能使用同一内容继续。
     * EN: Freeze input/request first; unresolved commands continue only with the same content.
     */
    if (writing.current || archived || !active.current) return;
    if (
      !change((value) => {
        if (value.pending) {
          if (JSON.stringify(value.pending) !== JSON.stringify(pendingShape.parse(request)))
            throw Error('待核对的保存请求已变化，请重新查看当前输入。');
          return value;
        }
        if (
          pending ||
          (request.kind === 'memory' && !sameMemory(value.memory, request)) ||
          (request.kind === 'capability' && !sameSelection(value.selection ?? selection, request))
        )
          throw Error('当前输入或保存请求已变化，请重新核对后保存。');
        return { ...value, pending: request };
      })
    )
      return;
    writing.current = true;
    setBusy(true);
    setNotice('');
    setActionError('');
    try {
      if (request.kind === 'capability') {
        const { kind: _kind, ...body } = request;
        const next = await mutation<ProjectIntelligenceView>(base + '/intelligence', body, 'PUT');
        if (next.config.projectId !== projectId) throw Error('保存返回的项目不匹配，上次请求需核对。');
        if (!active.current) return;
        readers.current.capabilities?.abort();
        setView(next);
        setCapRead({ status: 'ready', message: '' });
        change((value) =>
          value.pending?.commandId === request.commandId
            ? {
                ...value,
                selection: sameSelection(value.selection, request) ? undefined : value.selection,
                pending: undefined,
              }
            : value,
        );
      } else {
        const { kind: _kind, id, ...body } = request;
        const next = await mutation<ProjectMemory>(
          base + '/memories' + (id ? `/${id}` : ''),
          body,
          id ? 'PUT' : 'POST',
        );
        if (next.projectId !== projectId || (id && next.id !== id))
          throw Error('保存返回的记忆不匹配，上次请求需核对。');
        if (!active.current) return;
        /**
         * 单项成功不能确认全列表；取消旧读取并刷新。
         * EN: A successful item write does not confirm the whole list; cancel stale reads and refresh it.
         */
        readers.current.memories?.abort();
        setMemories((value) =>
          value
            ? {
                ...value,
                memories: value.memories.some((item) => item.id === next.id)
                  ? value.memories.map((item) => (item.id === next.id ? next : item))
                  : [...value.memories, next],
              }
            : value,
        );
        change((value) =>
          value.pending?.commandId === request.commandId
            ? {
                ...value,
                ...(request.kind === 'memory' && sameMemory(value.memory, request)
                  ? { memory: undefined }
                  : {}),
                pending: undefined,
              }
            : value,
        );
        setRestore(undefined);
        void read('memories');
      }
      setNotice(
        request.kind === 'restore'
          ? '历史内容已恢复为新的记忆版本。'
          : request.kind === 'memory'
            ? '项目记忆已保存。'
            : '项目能力已保存，将用于之后创建的任务。',
      );
    } catch (issue) {
      if (!active.current) return;
      const definitive =
        issue instanceof ApiError &&
        issue.kind === 'http' &&
        (issue.status ?? 0) >= 400 &&
        (issue.status ?? 0) < 500;
      if (definitive)
        change((value) =>
          value.pending?.commandId === request.commandId ? { ...value, pending: undefined } : value,
        );
      if (definitive && (issue as ApiError).status === 409) {
        (request.kind === 'capability' ? setCapRead : setMemoryRead)({
          status: 'error',
          message: '版本发生变化，请重新读取并核对；当前输入已保留。',
        });
      }
      setActionError(
        errorText(issue) +
          (definitive ? ' 当前输入已保留。' : ' 结果尚未确认，重试会核对同一请求；输入已保留。'),
      );
    } finally {
      writing.current = false;
      if (active.current) setBusy(false);
    }
  }
  /**
   * 在未锁定且无编辑器时创建记忆草稿；已有记忆保留身份与版本，可覆盖目标状态，新记忆从空字段开始。
   * EN: Creates a memory draft only while unlocked and no editor is active, preserving existing identity/revision with an optional status change or initializing empty fields for a new memory.
   */
  function prepareMemory(item?: ProjectMemory, status?: MemoryDraft['status']) {
    if (locked || editor) return;
    change((value) => ({
      ...value,
      memory: item
        ? { ...memoryDraft(item), ...(status ? { status } : {}) }
        : { title: '', text: '', source: '', status: 'draft' },
    }));
  }
  /**
   * 按读取类型与状态渲染重读、取消和错误反馈；保留结果时明确提示它们尚未更新。
   * EN: Renders reread, cancellation, and error controls by resource and read state, indicating when retained results have not been refreshed.
   */
  const readControls = (kind: 'capabilities' | 'memories', state: ReadState, retained: boolean) => (
    <div className="intelligence-read">
      <button
        type="button"
        className="secondary"
        disabled={busy || state.status === 'loading'}
        onClick={() => void read(kind)}
      >
        {state.status === 'loading' ? '正在读取…' : kind === 'capabilities' ? '重新读取能力' : '重新读取记忆'}
      </button>
      {state.status === 'loading' && (
        <button type="button" className="text-button" onClick={() => cancel(kind)}>
          取消读取{kind === 'capabilities' ? '能力' : '记忆'}
        </button>
      )}
      {state.status !== 'ready' && retained && <span role="status">显示上次结果，当前状态尚未确认。</span>}
      {state.message && (
        <p
          className="field-error intelligence-reading"
          role="alert"
          aria-label={kind === 'capabilities' ? '能力读取错误全文' : '记忆读取错误全文'}
          tabIndex={0}
        >
          {state.message}
        </p>
      )}
    </div>
  );

  return (
    <section className="project-intelligence" aria-label="项目能力与记忆">
      <header>
        <h2>项目能力与记忆</h2>
        <p>
          选择项目可用的能力，保存经过确认的长期资料。每个任务保留创建时的配置；这里的修改不会替换旧任务依据。
        </p>
      </header>
      {archived && <p role="status">项目已归档，可查看资料，暂不修改。</p>}
      {(draftError || parseError) && (
        <div className="intelligence-issue" role="alert">
          <p>{draftError || parseError}</p>
          <div className="project-actions">
            <button type="button" className="secondary" onClick={() => setDraftAttempt((value) => value + 1)}>
              重新读取草稿
            </button>
            <button
              type="button"
              className="secondary"
              onClick={() => exportOriginal(cache.get(key), projectId)}
            >
              导出能力与记忆原稿
            </button>
          </div>
          {parseError && (
            <>
              <label className="intelligence-check">
                <input
                  type="checkbox"
                  checked={clearConfirmed}
                  onChange={(event) => setClearConfirmed(event.target.checked)}
                />
                我已另存原稿，确认清空此项目的能力与记忆草稿
              </label>
              <button
                type="button"
                className="text-button"
                disabled={!clearConfirmed || busy}
                onClick={() => {
                  try {
                    cache.set(key, '');
                    rerender((value) => value + 1);
                    setClearConfirmed(false);
                    setDraftError('');
                  } catch (issue) {
                    setDraftError(errorText(issue));
                  }
                }}
              >
                清空无法读取的草稿
              </button>
            </>
          )}
        </div>
      )}
      {!loaded && !draftError && <p role="status">正在读取本机草稿…</p>}
      {actionError && (
        <p
          className="field-error intelligence-reading"
          role="alert"
          aria-label="项目资料保存错误全文"
          tabIndex={0}
        >
          {actionError}
        </p>
      )}
      {notice && (
        <p className="intelligence-reading" role="status" aria-label="项目资料操作反馈全文" tabIndex={0}>
          {notice}
        </p>
      )}
      {pending && (
        <div className="intelligence-issue" role="status">
          <p>
            {busy
              ? '正在保存，请稍候。'
              : '上次保存结果待核对。原请求和输入已保留；核对完成前暂不发起其他修改。'}
          </p>
          <button
            type="button"
            className="secondary"
            disabled={busy || archived}
            onClick={() => void submit(pending)}
          >
            {busy ? '正在核对…' : '重试核对上次保存'}
          </button>
        </div>
      )}
      <section className="intelligence-section" aria-label="项目能力选择">
        <div className="intelligence-heading">
          <h3>可用能力</h3>
          {view && <span>配置版本 {view.config.revision}</span>}
        </div>
        {readControls('capabilities', capRead, !!view)}
        {view && selection && (
          <>
            <dl className="intelligence-selection-summary" aria-label="当前能力选择依据">
              <div>
                <dt>显示来源</dt>
                <dd>{draft?.selection ? '本机选择草稿' : '已读项目配置'}</dd>
              </div>
              <div>
                <dt>选择依据</dt>
                <dd>版本 {selection.expectedRevision}</dd>
              </div>
            </dl>
            <p className="field-help">
              {view.config.mode === 'legacy'
                ? '当前沿用本机能力库；保存后只使用本项目明确选择的能力。'
                : '当前使用本项目独立选择。'}{' '}
              任务执行权限仍需单独确认，选中 MCP 不会扩大权限。
            </p>
            <label className="intelligence-search">
              搜索能力
              <input
                ref={searchInput}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="名称或说明"
              />
            </label>
            {!!query && (
              <button
                type="button"
                className="text-button"
                onClick={() => {
                  setQuery('');
                  searchInput.current?.focus();
                }}
              >
                清除能力筛选
              </button>
            )}
            <fieldset disabled={locked || capRead.status !== 'ready'}>
              <legend>
                内置 Skills · 显示{' '}
                {view.catalog.builtinSkills.filter((item) => matched(item.name, item.description)).length} 项
              </legend>
              <div className="intelligence-options" role="region" aria-label="内置 Skills 列表" tabIndex={0}>
                {view.catalog.builtinSkills
                  .filter((item) => matched(item.name, item.description))
                  .map((item) => (
                    <label key={item.id}>
                      <input
                        type="checkbox"
                        checked={selection.builtinSkillIds.includes(item.id)}
                        onChange={(event) => toggle('builtinSkillIds', item.id, event.target.checked)}
                      />
                      <span>
                        <strong>{item.name}</strong>
                        <small>{item.description}</small>
                      </span>
                    </label>
                  ))}
                {!view.catalog.builtinSkills.some((item) => matched(item.name, item.description)) && (
                  <p className="field-help">没有匹配的内置 Skills。</p>
                )}
              </div>
            </fieldset>
            {(['skill', 'memory', 'mcp'] as const).map((kind) => (
              <fieldset key={kind} disabled={locked || capRead.status !== 'ready'}>
                <legend>
                  {{ skill: '导入 Skills', memory: '导入记忆', mcp: 'MCP 服务' }[kind]} · 显示{' '}
                  {
                    view.catalog.localItems.filter(
                      (item) => item.kind === kind && matched(item.name, item.description),
                    ).length
                  }{' '}
                  项
                </legend>
                <div
                  className="intelligence-options"
                  role="region"
                  aria-label={`${{ skill: '导入 Skills', memory: '导入记忆', mcp: 'MCP 服务' }[kind]}列表`}
                  tabIndex={0}
                >
                  {view.catalog.localItems
                    .filter((item) => item.kind === kind && matched(item.name, item.description))
                    .map((item) => (
                      <label key={item.id}>
                        <input
                          type="checkbox"
                          checked={selection.localItemIds.includes(item.id)}
                          disabled={!item.enabled && !selection.localItemIds.includes(item.id)}
                          onChange={(event) => toggle('localItemIds', item.id, event.target.checked)}
                        />
                        <span>
                          <strong>{item.name}</strong>
                          <small>
                            {item.sourceKind} · {item.enabled ? '本机库已启用' : '本机库已关闭'}
                            {item.modelInvocable === false ? ' · 禁止模型调用' : ''}
                          </small>
                          <small>{item.description}</small>
                        </span>
                      </label>
                    ))}
                  {!view.catalog.localItems.some(
                    (item) => item.kind === kind && matched(item.name, item.description),
                  ) && <p className="field-help">没有匹配条目；可在侧栏“本机能力”同步或启用。</p>}
                </div>
              </fieldset>
            ))}
            {(selection.builtinSkillIds.some(
              (id) => !view.catalog.builtinSkills.some((item) => item.id === id),
            ) ||
              selection.localItemIds.some(
                (id) => !view.catalog.localItems.some((item) => item.id === id),
              )) && (
              <div className="intelligence-issue">
                <p>选择中包含已不在目录的条目，保存前请核对。</p>
                <button
                  type="button"
                  className="secondary"
                  disabled={locked || capRead.status !== 'ready'}
                  onClick={() =>
                    change((value) => ({
                      ...value,
                      selection: {
                        ...selection,
                        builtinSkillIds: selection.builtinSkillIds.filter((id) =>
                          view.catalog.builtinSkills.some((item) => item.id === id),
                        ),
                        localItemIds: selection.localItemIds.filter((id) =>
                          view.catalog.localItems.some((item) => item.id === id),
                        ),
                      },
                    }))
                  }
                >
                  移除失效选择
                </button>
              </div>
            )}
            {selectionStale && (
              <div className="intelligence-issue">
                <p>
                  配置已从版本 {selection.expectedRevision} 变为 {view.config.revision}
                  。请先比较，再决定本次选择。
                </p>
                <p
                  className="intelligence-reading"
                  role="region"
                  aria-label="当前能力配置全部选择"
                  tabIndex={0}
                >
                  当前配置：{capabilityNames(view.config)}
                </p>
                <p
                  className="intelligence-reading"
                  role="region"
                  aria-label="本机能力草稿全部选择"
                  tabIndex={0}
                >
                  我的选择：{capabilityNames(selection)}
                </p>
                <div className="project-actions">
                  <button
                    type="button"
                    className="secondary"
                    disabled={locked || capRead.status !== 'ready'}
                    onClick={() =>
                      change((value) => ({
                        ...value,
                        selection: { ...selection, expectedRevision: view.config.revision },
                      }))
                    }
                  >
                    保留我的选择，以当前版本核对
                  </button>
                  <button
                    type="button"
                    className="secondary"
                    disabled={locked}
                    onClick={() => change((value) => ({ ...value, selection: undefined }))}
                  >
                    采用当前能力配置
                  </button>
                </div>
              </div>
            )}
            <div className="project-actions">
              <span>已选择 {selection.builtinSkillIds.length + selection.localItemIds.length} 项</span>
              <button
                type="button"
                className="primary"
                disabled={locked || capRead.status !== 'ready' || selectionStale}
                onClick={() =>
                  void submit({ kind: 'capability', commandId: crypto.randomUUID(), ...selection })
                }
              >
                保存项目能力
              </button>
            </div>
          </>
        )}
      </section>
      <section className="intelligence-section" aria-label="项目长期记忆">
        <div className="intelligence-heading">
          <h3>项目长期记忆</h3>
          {memories && (
            <span>
              {memories.memories.length}/{memories.limits.memoryCount} 条
            </span>
          )}
        </div>
        <p className="field-help">
          只启用已核对的事实、决策与约束，并注明来源。记忆作为参考资料使用，不替代用户指令或执行授权；撤销不会抹去历史任务已捕获的资料。
        </p>
        {readControls('memories', memoryRead, !!memories)}
        <button
          type="button"
          className="secondary"
          disabled={
            locked ||
            !!editor ||
            memoryRead.status !== 'ready' ||
            !memories ||
            memories.memories.length >= memories.limits.memoryCount
          }
          onClick={() => prepareMemory()}
        >
          新增项目记忆
        </button>
        {editor && (
          <form
            className="intelligence-editor"
            aria-label="项目记忆编辑"
            onSubmit={(event) => {
              event.preventDefault();
              if (
                !locked &&
                memoryRead.status === 'ready' &&
                !memoryStale &&
                editor.title.trim() &&
                editor.text.trim() &&
                bytes <= memoryLimit
              )
                void submit({ kind: 'memory', commandId: crypto.randomUUID(), ...editor });
            }}
          >
            <h4>{editor.id ? '编辑项目记忆' : '新记忆'}</h4>
            <fieldset disabled={locked}>
              <label>
                标题
                <input
                  maxLength={160}
                  aria-invalid={!editor.title.trim()}
                  aria-describedby={`${editorId}-title`}
                  value={editor.title}
                  onChange={(event) =>
                    change((value) => ({ ...value, memory: { ...editor, title: event.target.value } }))
                  }
                />
                <small className="field-help" id={`${editorId}-title`}>
                  {editor.title.length} / 160 字符
                  {!editor.title.trim() && ' · 请填写记忆标题，空白不能保存。'}
                </small>
              </label>
              <label>
                正文
                <textarea
                  rows={5}
                  aria-invalid={!editor.text.trim() || bytes > memoryLimit}
                  aria-describedby={`${editorId}-bytes`}
                  value={editor.text}
                  onChange={(event) =>
                    change((value) => ({ ...value, memory: { ...editor, text: event.target.value } }))
                  }
                />
              </label>
              <span id={`${editorId}-bytes`} className={bytes > memoryLimit ? 'field-error' : 'field-help'}>
                {bytes.toLocaleString()} / {memoryLimit.toLocaleString()} 字节（UTF-8）
                {!editor.text.trim() && ' · 请填写记忆正文，空白不能保存。'}
              </span>
              <label>
                来源与核对说明
                <textarea
                  rows={2}
                  maxLength={2000}
                  value={editor.source}
                  placeholder="例如：用户确认日期、文件位置或来源任务"
                  onChange={(event) =>
                    change((value) => ({ ...value, memory: { ...editor, source: event.target.value } }))
                  }
                />
              </label>
              <label>
                保存后的状态
                <select
                  value={editor.status}
                  onChange={(event) =>
                    change((value) => ({
                      ...value,
                      memory: { ...editor, status: event.target.value as MemoryDraft['status'] },
                    }))
                  }
                >
                  <option value="draft">草稿 · 暂不使用</option>
                  <option value="active">启用 · 供之后创建的任务参考</option>
                  {editor.id && <option value="revoked">撤销 · 保留记录，不供新任务使用</option>}
                </select>
              </label>
            </fieldset>
            {memoryStale && (
              <div className="intelligence-issue">
                <p>记忆已变化或不存在，当前输入已保留。</p>
                {currentMemory && (
                  <>
                    <details>
                      <summary>查看当前版本 {currentMemory.revision} 的完整内容</summary>
                      <strong>{currentMemory.title}</strong>
                      <MemoryContent
                        context={`当前记忆版本 ${currentMemory.revision}`}
                        text={currentMemory.text}
                        source={currentMemory.source || '未填写'}
                      />
                      <p>{states[currentMemory.status]}</p>
                    </details>
                    <button
                      type="button"
                      className="secondary"
                      disabled={locked || memoryRead.status !== 'ready'}
                      onClick={() =>
                        change((value) => ({
                          ...value,
                          memory: { ...editor, expectedRevision: currentMemory.revision },
                        }))
                      }
                    >
                      保留输入，以当前记忆版本核对
                    </button>
                  </>
                )}
              </div>
            )}
            <div className="project-actions">
              <button
                type="submit"
                className="primary"
                aria-describedby={`${editorId}-title ${editorId}-bytes`}
                disabled={
                  locked ||
                  memoryRead.status !== 'ready' ||
                  memoryStale ||
                  !editor.title.trim() ||
                  !editor.text.trim() ||
                  bytes > memoryLimit
                }
              >
                保存记忆
              </button>
              <button
                type="button"
                className="text-button"
                disabled={locked}
                onClick={() => change((value) => ({ ...value, memory: undefined }))}
              >
                舍弃此记忆编辑稿
              </button>
              <button
                type="button"
                className="text-button"
                onClick={() => exportOriginal(cache.get(key), projectId)}
              >
                导出当前原稿
              </button>
            </div>
            <p className="field-help">输入保存在本机草稿；保存或舍弃当前编辑稿后可编辑另一条记忆。</p>
          </form>
        )}
        <div className="intelligence-memory-list">
          {memories?.memories.map((item) => (
            <article key={item.id}>
              <div className="intelligence-heading">
                <strong>{item.title}</strong>
                <span className="intelligence-memory-state" data-status={item.status}>
                  {states[item.status]} · 版本 {item.revision}
                </span>
              </div>
              <details>
                <summary>正文与来源</summary>
                <MemoryContent
                  context={`${item.title}，当前版本 ${item.revision}`}
                  text={item.text}
                  source={item.source || '未填写来源说明'}
                />
                <small>更新于 {new Date(item.updatedAt).toLocaleString()}</small>
              </details>
              <div className="project-actions">
                <button
                  type="button"
                  className="text-button"
                  disabled={locked || !!editor || memoryRead.status !== 'ready'}
                  onClick={() => prepareMemory(item)}
                >
                  编辑
                </button>
                {item.status !== 'active' && (
                  <button
                    type="button"
                    className="text-button"
                    disabled={locked || !!editor || memoryRead.status !== 'ready'}
                    onClick={() => prepareMemory(item, 'active')}
                  >
                    准备启用
                  </button>
                )}
                {item.status !== 'revoked' && (
                  <button
                    type="button"
                    className="text-button"
                    disabled={locked || !!editor || memoryRead.status !== 'ready'}
                    onClick={() => prepareMemory(item, 'revoked')}
                  >
                    准备撤销
                  </button>
                )}
                <button
                  type="button"
                  className="text-button"
                  aria-expanded={historyId === item.id}
                  onClick={() => {
                    setHistoryId(historyId === item.id ? '' : item.id);
                    setRestore(undefined);
                  }}
                >
                  历史版本（{item.history.length}）
                </button>
              </div>
            </article>
          ))}
        </div>
        {memories && !memories.memories.length && (
          <p className="field-help">尚无项目记忆，可先保存草稿，核对后再启用。</p>
        )}
        {history && (
          <section className="intelligence-history" aria-label="项目记忆历史">
            <h4>{history.title} · 历史版本</h4>
            <p className="field-help">
              最多保留 {memories?.limits.historyCount} 个旧版本，当前正文与历史合计最多{' '}
              {(memories?.limits.memoryRecordBytes ?? 128 * 1024) / 1024} KiB；超限时移除完整的最旧版本。
              恢复会创建新版本，并恢复当时的正文、来源与启用状态。
            </p>
            {!history.history.length && <p>暂无旧版本。</p>}
            {history.history.map((version) => (
              <details key={version.revision}>
                <summary>
                  版本 {version.revision} · {states[version.status]} ·{' '}
                  {new Date(version.updatedAt).toLocaleString()}
                </summary>
                <strong>{version.title}</strong>
                <MemoryContent
                  context={`历史记忆版本 ${version.revision}`}
                  text={version.text}
                  source={version.source || '未填写'}
                />
                <button
                  type="button"
                  className="secondary"
                  disabled={locked || !!editor || memoryRead.status !== 'ready'}
                  onClick={() => setRestore({ id: history.id, expectedRevision: history.revision, version })}
                >
                  核对恢复版本 {version.revision}
                </button>
              </details>
            ))}
          </section>
        )}
        {restore && (
          <div className="intelligence-issue intelligence-restore" aria-label="恢复记忆版本确认">
            <h4>恢复为新版本</h4>
            <p>
              将把当前版本 {restore.expectedRevision} 替换为以下历史内容，状态为“
              {states[restore.version.status]}”。当前历史仍保留。
            </p>
            <div className="intelligence-restore-preview">
              <strong>{restore.version.title}</strong>
              <MemoryContent
                context={`待恢复记忆版本 ${restore.version.revision}`}
                text={restore.version.text}
                source={restore.version.source || '未填写'}
              />
            </div>
            {memories?.memories.find((item) => item.id === restore.id)?.revision !==
              restore.expectedRevision && (
              <p className="field-error">当前记忆已变化，请重新选择历史版本核对。</p>
            )}
            <div className="project-actions">
              <button
                type="button"
                className="primary"
                disabled={
                  locked ||
                  !!editor ||
                  memoryRead.status !== 'ready' ||
                  memories?.memories.find((item) => item.id === restore.id)?.revision !==
                    restore.expectedRevision
                }
                onClick={() =>
                  void submit({
                    kind: 'restore',
                    commandId: crypto.randomUUID(),
                    id: restore.id,
                    expectedRevision: restore.expectedRevision,
                    restoreRevision: restore.version.revision,
                  })
                }
              >
                确认恢复历史内容
              </button>
              <button
                type="button"
                className="secondary"
                disabled={busy}
                onClick={() => setRestore(undefined)}
              >
                取消恢复
              </button>
            </div>
          </div>
        )}
      </section>
      <ProjectModelRouting projectId={projectId} cache={cache} archived={archived} />
    </section>
  );
}

/**
 * 在可聚焦的阅读区域完整展示记忆正文和来源，使用上下文标签区分不同记忆。
 * EN: Displays full memory text and source in focusable reading regions, using contextual labels to distinguish entries.
 */
function MemoryContent({ context, text, source }: { context: string; text: string; source: string }) {
  return (
    <div className="intelligence-content">
      <div>
        <span className="intelligence-content-label">正文</span>
        <p className="intelligence-text" role="region" aria-label={`${context}正文`} tabIndex={0}>
          {text}
        </p>
      </div>
      <div>
        <span className="intelligence-content-label">来源与核对说明</span>
        <p className="intelligence-text" role="region" aria-label={`${context}来源`} tabIndex={0}>
          {source}
        </p>
      </div>
    </div>
  );
}
