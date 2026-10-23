import { useEffect, useRef, useState } from 'react';
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
const errorText = (issue: unknown) => (issue instanceof Error ? issue.message : '请求失败，请重试。');
export const projectIntelligenceKey = (id: string) => `draft:project-intelligence:${id}`;

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
const sameMemory = (value: MemoryDraft | undefined, request: MemoryDraft) =>
  !!value &&
  ['id', 'expectedRevision', 'title', 'text', 'source', 'status'].every(
    (key) => value[key as keyof MemoryDraft] === request[key as keyof MemoryDraft],
  );
const sameSelection = (
  value: z.infer<typeof selectionShape> | undefined,
  request: z.infer<typeof selectionShape>,
) =>
  !!value &&
  value.expectedRevision === request.expectedRevision &&
  JSON.stringify(value.builtinSkillIds) === JSON.stringify(request.builtinSkillIds) &&
  JSON.stringify(value.localItemIds) === JSON.stringify(request.localItemIds);
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
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      Object.values(readers.current).forEach((reader) => reader?.abort());
    };
  }, []);
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

  async function read(kind: 'capabilities' | 'memories') {
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
  useEffect(() => {
    void read('capabilities');
    void read('memories');
  }, [api, projectId]);
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
  function change(update: (value: Draft) => Draft) {
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
  const matched = (name: string, description: string) =>
    `${name} ${description}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
  const capabilityNames = (value: { builtinSkillIds: string[]; localItemIds: string[] }) =>
    [
      ...value.builtinSkillIds.map(
        (id) => view?.catalog.builtinSkills.find((item) => item.id === id)?.name ?? `已失效技能 ${id}`,
      ),
      ...value.localItemIds.map(
        (id) => view?.catalog.localItems.find((item) => item.id === id)?.name ?? `已失效导入项 ${id}`,
      ),
    ].join('、') || '未选择能力';
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
  async function submit(request: Pending) {
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
        // A successful item write does not confirm the whole list; cancel stale reads and refresh it.
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
  function prepareMemory(item?: ProjectMemory, status?: MemoryDraft['status']) {
    if (locked || editor) return;
    change((value) => ({
      ...value,
      memory: item
        ? { ...memoryDraft(item), ...(status ? { status } : {}) }
        : { title: '', text: '', source: '', status: 'draft' },
    }));
  }
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
        <p className="field-error" role="alert">
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
        <p className="field-error" role="alert">
          {actionError}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
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
                <p>当前配置：{capabilityNames(view.config)}</p>
                <p>我的选择：{capabilityNames(selection)}</p>
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
                  value={editor.title}
                  onChange={(event) =>
                    change((value) => ({ ...value, memory: { ...editor, title: event.target.value } }))
                  }
                />
              </label>
              <label>
                正文
                <textarea
                  rows={5}
                  value={editor.text}
                  onChange={(event) =>
                    change((value) => ({ ...value, memory: { ...editor, text: event.target.value } }))
                  }
                />
              </label>
              <span className={bytes > memoryLimit ? 'field-error' : 'field-help'}>
                {bytes.toLocaleString()} / {memoryLimit.toLocaleString()} 字节（UTF-8）
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
