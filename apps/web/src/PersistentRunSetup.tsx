/**
 * 提供持久化运行的设置界面。
 * 将运行设置表单与工作台缓存连接，保护损坏原稿并比较已保存基线；只维护启动输入，创建运行由父组件执行。
 * EN: Adds persistent-draft gates around run setup. Connects run-setup forms to the workbench cache, protects malformed source, and compares saved baselines; it maintains launch input while parents create runs.
 */
import { useEffect, useState, type ComponentProps } from 'react';
import { Modal } from './Modal';
import { RunModal } from './RunSetupModal';
import { readRunSetupDraft, writeRunSetupDraft, type RunSetupDraft } from './RunSetupDraft';
import type { WorkbenchCache } from './WorkbenchCache';

/**
 * 在 RunModal 外提供按草稿键的加载和保存门禁。读取完成前不挂载可编辑表单，避免默认值
 * 回写覆盖尚未读到的保留草稿；解析失败只显示恢复入口，清空必须由用户明确操作。
 * submit 同时获得精确序列化快照，父级可据此仅清理本次创建所用的未变化草稿。
 * EN: Load/save by draft key around RunModal. Mount editing only after read to prevent defaults overwriting retained input. Parse errors offer recovery; clearing is explicit. Submit includes exact serialized bytes so the parent clears only the unchanged creation draft.
 */
export function PersistentRunSetup({
  cache,
  draftKey,
  persistence,
  openPersistence,
  settings,
  submit,
  ...props
}: Omit<ComponentProps<typeof RunModal>, 'initial' | 'changed' | 'settings' | 'submit'> & {
  cache: WorkbenchCache;
  draftKey: string;
  persistence: { status: string; error: string };
  openPersistence: () => void;
  settings: () => void;
  submit: (body: Record<string, unknown>, draftSnapshot: string) => void;
}) {
  const [loaded, setLoaded] = useState<{ draft?: RunSetupDraft }>();
  const [readError, setReadError] = useState(''),
    [writeError, setWriteError] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    /**
     * 草稿键准备完成后才恢复表单；读取失败时保留错误供重试。
     * EN: Restore after draft-key preparation; retain read failure for retry.
     */
    let live = true;
    setLoaded(undefined);
    setReadError('');
    void cache
      .ensureKey(draftKey, retry > 0)
      .then(() => {
        const draft = readRunSetupDraft(cache.get(draftKey));
        if (live) setLoaded({ draft });
      })
      .catch((issue) => {
        if (live)
          setReadError(issue instanceof Error ? issue.message : '创建草稿读取失败，未覆盖已保存内容。');
      });
    return () => {
      live = false;
    };
  }, [cache, draftKey, retry]);
  /**
   * 语义相同的规范化表单沿用原始字节，防止默认字段补齐导致创建成功后的精确清理失配。
   * EN: Reuse original bytes for semantically equal normalized forms so filled defaults do not break exact cleanup.
   */
  const snapshot = (draft: RunSetupDraft) => {
    const raw = writeRunSetupDraft(draft);
    const current = cache.get(draftKey);
    /**
     * 先校验运行设置草稿，再统一可选字段的空值并序列化；使语义相同的缺省配置不会被误判为编辑冲突。
     * EN: Validates a run-setup draft, normalizes empty optional fields, and serializes it so equivalent defaults are not mistaken for conflicting edits.
     */
    const comparable = (value: unknown) => {
      const parsed = readRunSetupDraft(value);
      if (!parsed) return;
      const { maxCost, deliverables, acceptanceCriteria, ...fields } = parsed;
      return JSON.stringify({
        ...fields,
        maxCost: maxCost ?? null,
        deliverables: deliverables ?? '',
        acceptanceCriteria: acceptanceCriteria ?? '',
      });
    };
    /**
     * 读取规范化字段顺序，表单补齐可选默认值。
     * EN: Reading normalizes field order and the form fills optional defaults.
     */
    /**
     * 未改变时保留原始字节，用于提交后的精确清除。
     * EN: Preserve unchanged original bytes, also used to clear after submit.
     */
    if (typeof current === 'string' && comparable(current) === comparable(raw)) return current;
    return raw;
  };
  /**
   * 序列化或缓存保存失败时返回 false，使“打开设置”等后续跳转保留当前表单。
   * EN: Return false on serialization/cache-save failure so subsequent navigation preserves the form.
   */
  const save = (draft: RunSetupDraft) => {
    try {
      cache.set(draftKey, snapshot(draft));
      setWriteError('');
      return true;
    } catch (issue) {
      setWriteError(issue instanceof Error ? issue.message : '草稿保存失败，当前表单仍保留。');
      return false;
    }
  };
  if (!loaded)
    return (
      <Modal title="读取创建草稿" close={props.close}>
        <div className="form-body">
          {readError ? (
            <>
              <p className="field-error" role="alert">
                {readError}
              </p>
              <button
                className="secondary"
                onClick={() => {
                  setRetry((v) => v + 1);
                }}
              >
                重新读取草稿
              </button>
              <button
                className="text-button"
                onClick={() => {
                  cache.set(draftKey, '');
                  setRetry((v) => v + 1);
                }}
              >
                清空此创建配置草稿
              </button>
            </>
          ) : (
            <p role="status">正在读取本入口、当前项目的创建配置…</p>
          )}
        </div>
      </Modal>
    );
  return (
    <RunModal
      {...props}
      initial={loaded.draft}
      changed={save}
      submit={(body, draft) => {
        try {
          submit(body, snapshot(draft));
        } catch (issue) {
          setWriteError(issue instanceof Error ? issue.message : '创建配置无法读取，当前表单仍保留。');
        }
      }}
      settings={(draft) => {
        if (save(draft)) settings();
      }}
      beforeForm={
        <>
          {loaded.draft && (
            <p className="field-help">
              已恢复本次创建草稿。请重新核对模型、执行权限与预算；项目默认不会自动覆盖。
            </p>
          )}
          {persistence.status === 'error' && (
            <p className="field-error" role="alert">
              {persistence.error} 当前表单已保留。
              <button type="button" className="text-button" onClick={openPersistence}>
                核对草稿保存问题
              </button>
            </p>
          )}
          {writeError && (
            <p className="field-error" role="alert">
              {writeError}
            </p>
          )}
          {props.beforeForm}
        </>
      }
    />
  );
}
