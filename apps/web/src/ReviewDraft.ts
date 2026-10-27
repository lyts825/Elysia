/* 读取和整理交付复核草稿及候选项。 */
import type {
  DeliveryReview,
  DeliveryUserReview,
  ReviewSourceNote,
} from '../../../packages/contracts/src/workflow';

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
export function criterionSnapshot(note: { criterionText?: string | null }) {
  return note.criterionText?.trim() ? note.criterionText : unknownCriterionText;
}
const unknownText = (text: string) =>
  text === unknownCriterionText || /^第\s*\d+\s*项(?:（旧版本）)?$/.test(text);
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
export function reviewCandidates(
  review: (DeliveryUserReview & { stale: boolean }) | null,
  draft: ReviewDraft | undefined,
  fingerprint: string,
  reviewId: string | null = null,
): ReviewCandidate[] {
  const result: ReviewCandidate[] = [];
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
