/**
 * 读取和整理交付复核草稿及候选项。
 * 兼容本地旧备注及服务端复核记录，生成带标准快照、来源和过期标志的候选；旧记录缺少原标准时要求手工核对。
 * EN: Restores review drafts and builds note candidates. Supports legacy local notes and server reviews and generates candidates with criterion snapshots, provenance, and staleness; missing original standards require manual inspection.
 */
import type {
  DeliveryReview,
  DeliveryUserReview,
  ReviewSourceNote,
} from '../../../packages/contracts/src/workflow';

/**
 * 一条本机备注同时保留原索引和原标准文字，不能仅按后来同索引标准自动复用。
 * EN: Keep original criterion index and wording together; a later criterion at the same index is not automatically equivalent.
 */
export type ReviewNote = {
  index: number;
  text: string;
  note: string;
  unknownStandard?: boolean;
  fingerprint?: string;
};
export type ReviewDraft = {
  fingerprint: string;
  decision: '' | 'accepted' | 'changes_requested';
  note: string;
  criteriaNotes: ReviewNote[];
  unlinked: { text: string; note: string; unknownStandard?: boolean; fingerprint?: string }[];
};
export const unknownCriterionText = '旧标准内容未记录';
/**
 * 旧数据未捕获原标准时保留明确占位，后续重关联必须由用户核对。
 * EN: Use explicit placeholders when older data lacks criterion text; relinking requires user review.
 */
export function criterionSnapshot(note: { criterionText?: string | null }) {
  return note.criterionText?.trim() ? note.criterionText : unknownCriterionText;
}
/**
 * 识别旧版占位验收标准文本，使缺失原标准的备注不会误关联到当前同序号标准。
 * EN: Recognizes legacy placeholder criterion text so notes missing an original standard are not automatically linked to the current criterion at the same index.
 */
const unknownText = (text: string) =>
  text === unknownCriterionText || /^第\s*\d+\s*项(?:（旧版本）)?$/.test(text);
/**
 * 读取有界本地草稿，兼容旧记录缺少标准标识的情况；无效内容返回 undefined。
 * EN: Restore bounded local drafts, including older missing criterion identities; invalid data returns undefined.
 */
export function readLocalReviewDraft(raw: unknown): ReviewDraft | undefined {
  if (typeof raw !== 'string' || !raw || raw.length > 200000) return;
  try {
    const parsed = JSON.parse(raw);
    if (
      !parsed ||
      typeof parsed.fingerprint !== 'string' ||
      !['', 'accepted', 'changes_requested'].includes(parsed.decision) ||
      typeof parsed.note !== 'string' ||
      !Array.isArray(parsed.criteriaNotes)
    )
      return;
    /**
     * 筛选结构合法的备注并补充旧版未知标准标志，保留可读输入供后续手工关联。
     * EN: Filters structurally valid notes and annotates legacy unknown standards, retaining readable input for later manual linking.
     */
    const notes = (items: unknown[]) =>
      items
        .filter(
          (item): item is ReviewNote =>
            !!item &&
            typeof item === 'object' &&
            typeof (item as ReviewNote).text === 'string' &&
            typeof (item as ReviewNote).note === 'string',
        )
        .map((item) => ({
          ...item,
          unknownStandard:
            typeof item.unknownStandard === 'boolean' ? item.unknownStandard : unknownText(item.text),
          fingerprint: typeof item.fingerprint === 'string' ? item.fingerprint : undefined,
        }));
    return {
      fingerprint: parsed.fingerprint,
      decision: parsed.decision,
      note: parsed.note,
      criteriaNotes: notes(parsed.criteriaNotes)
        .filter((item) => Number.isInteger(item.index) && item.index >= 0)
        .slice(0, 40),
      unlinked: Array.isArray(parsed.unlinked) ? notes(parsed.unlinked) : [],
    };
  } catch {
    return;
  }
}
/**
 * 优先保留本机未保存草稿，否则从服务端复核记录构建可编辑副本。
 * EN: Prefer unsaved local draft; otherwise build an editable copy from server review.
 */
export function readReviewDraft(raw: unknown, value: DeliveryReview): ReviewDraft {
  const local = readLocalReviewDraft(raw);
  if (local) return local;
  const review = value.userReview;
  return {
    fingerprint: review?.fingerprint || value.fingerprint,
    decision: review?.decision || '',
    note: review?.note || '',
    criteriaNotes: (review?.criteriaNotes || []).map((item) => ({
      index: item.index,
      note: item.note,
      text: criterionSnapshot(item),
      unknownStandard: !item.criterionText?.trim(),
    })),
    unlinked: [],
  };
}

export type ReviewCandidate = {
  id: string;
  source: ReviewSourceNote;
  origin: '已保存' | '本机未保存';
  fingerprint: string;
  stale: boolean;
  title: string;
  text: string;
  note: string;
};
/**
 * 汇总已保存、本机未保存和未关联备注，保留来源、原标准及指纹作为选取身份。
 * 仅去掉与已保存内容完全重复的本机项；不同版本或文字保留供用户明确选择。
 * EN: Combine saved/local/unlinked notes with source/original criterion/fingerprint identity. Drop local entries only when exactly duplicate saved content; retain different versions/text for explicit choice.
 */
export function reviewCandidates(
  review: (DeliveryUserReview & { stale: boolean }) | null,
  draft: ReviewDraft | undefined,
  fingerprint: string,
  reviewId: string | null = null,
): ReviewCandidate[] {
  /**
   * 同时展示已保存和本机备注；按指纹标记过期，不把旧标准视为当前标准。
   * EN: Show saved and local notes together; mark stale by fingerprint rather than treating old criteria as current.
   */
  const result: ReviewCandidate[] = [];
  /**
   * 将非空备注规范化为带来源、指纹及过期状态的候选项，并建立可验证标准关联供续接选择。
   * EN: Normalizes a nonempty note into a candidate with origin, fingerprint, and staleness, including verifiable criterion linkage for continuation selection.
   */
  const add = (
    origin: ReviewCandidate['origin'],
    version: string,
    title: string,
    text: string,
    note: string,
    criterionIndex: number | null,
    criterionText: string | null,
    old = false,
  ) => {
    if (!note.trim()) return;
    const entry = { origin, fingerprint: version, stale: old || version !== fingerprint, title, text, note };
    const source: ReviewSourceNote = {
      origin: origin === '已保存' ? 'saved' : 'draft',
      reviewId: origin === '已保存' ? reviewId : null,
      fingerprint: version || null,
      criterionIndex,
      criterionText,
      note,
    };
    result.push({ ...entry, source, id: JSON.stringify(source) });
  };
  if (review) {
    add('已保存', review.fingerprint, '整体备注', '', review.note, null, null, review.stale);
    for (const item of review.criteriaNotes)
      add(
        '已保存',
        review.fingerprint,
        `原第 ${item.index + 1} 项`,
        criterionSnapshot(item),
        item.note,
        item.index,
        item.criterionText ?? null,
        review.stale,
      );
  }
  if (draft) {
    if (draft.fingerprint !== review?.fingerprint || draft.note !== review?.note)
      add('本机未保存', draft.fingerprint, '整体备注', '', draft.note, null, null);
    for (const item of draft.criteriaNotes) {
      /**
       * 已保存内容完全相同时不重复列出；其他本机备注保留原始来源。
       * EN: Do not duplicate equal saved content; other local notes preserve original provenance.
       */
      if (
        draft.fingerprint === review?.fingerprint &&
        review.criteriaNotes.some((saved) => saved.index === item.index && saved.note === item.note)
      )
        continue;
      add(
        '本机未保存',
        draft.fingerprint,
        `原第 ${item.index + 1} 项`,
        item.unknownStandard ? unknownCriterionText : item.text,
        item.note,
        item.index,
        item.unknownStandard ? null : item.text,
      );
    }
    for (const item of draft.unlinked) {
      const text = item.unknownStandard ? unknownCriterionText : item.text;
      if (
        review &&
        item.fingerprint === review?.fingerprint &&
        review.criteriaNotes.some((saved) => saved.note === item.note && criterionSnapshot(saved) === text)
      )
        continue;
      add(
        '本机未保存',
        item.fingerprint || '',
        '未关联旧备注',
        text,
        item.note,
        null,
        item.unknownStandard ? null : item.text,
        true,
      );
    }
  }
  return result;
}
