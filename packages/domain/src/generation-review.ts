import type { Asset, Evaluation, GenerationItem, GenerationState, ItemReviewInput, ItemSaveInput, Result } from '../../contracts/src/index.js';
import { validateHttpBody } from '../../contracts/src/index.js';
import { checkedItem, failure, iso, nextId, publishItem } from './generation-state.js';
import { decideReview } from './review.js';

export type { ItemReviewInput, ItemSaveInput } from '../../contracts/src/index.js';
function resultDigestMatches(state: GenerationState, item: GenerationItem, digest: string): boolean {
  if (!digest.trim() || item.status !== 'succeeded' || !item.resultAvailable) return false;
  // Copy digests are calculated over exact persisted text by the IO service.
  if (item.mode === 'copy') return typeof item.text === 'string' && item.text.length > 0;
  const media = state.mediaMetadata.find(row => row.id === item.resultMediaId);
  return Boolean(media && media.availability === 'available' && media.sha256 === digest);
}
export function saveItemReview(state: GenerationState, id: string, input: ItemReviewInput, resultSha256: string, now: number): Result<Evaluation> {
  const checked = checkedItem(state, id, input); if (!checked.ok) return checked;
  const validated = validateHttpBody('review', input); if (!validated.ok) return validated;
  const item = checked.value;
  if (!resultDigestMatches(state, item, resultSha256)) return failure('ITEM_NOT_READY', '当前产物不可用或文件摘要已变化');
  const revisions = state.evaluations.filter(row => row.itemId === id);
  if (revisions.length && !input.reason.trim()) return failure('INVALID_PARAMETERS', '审核改判必须填写原因');
  const decision = decideReview(item, input.form); if (!decision.ok) return decision;
  const form = structuredClone(input.form);
  const evaluation: Evaluation = {
    id: nextId(state, 'evaluation'), itemId: id, revision: revisions.length + 1, rubricVersion: form.rubricVersion,
    ...(form.rubricVersion === 'rubric-v2-rebuild' ? { score: form.score, applicability: form.applicability } : {}),
    issueTags: form.rubricVersion === 'rubric-v2-rebuild' ? form.issueTags : [], hardFailures: form.rubricVersion === 'rubric-v2-rebuild' ? form.hardFailures : [], technicalErrors: form.rubricVersion === 'rubric-v2-rebuild' ? form.technicalErrors : [],
    decision: decision.value.decision, reason: input.reason.trim() || decision.value.reason, reviewerId: 'local-operator', createdAt: iso(now),
  };
  state.evaluations.push(evaluation);
  state.reviewForms[evaluation.id] = { form, reason: input.reason, resultSha256 };
  for (const asset of state.assets.filter(row => row.originItemId === id)) asset.reviewValidity = 'review_invalidated';
  item.reviewState = evaluation.decision; item.libraryState = 'not_saved'; publishItem(state, item, input.expectedVersion, now);
  return { ok: true, value: structuredClone(evaluation) };
}

export function saveItemAsset(state: GenerationState, id: string, input: ItemSaveInput, resultSha256: string, now: number): Result<Asset> {
  const checked = checkedItem(state, id, input); if (!checked.ok) return checked;
  const validated = validateHttpBody('save', input); if (!validated.ok) return validated;
  const item = checked.value;
  if (!resultDigestMatches(state, item, resultSha256)) return failure('ITEM_NOT_READY', '当前产物不可用或文件摘要已变化');
  const latest = state.evaluations.filter(row => row.itemId === id).sort((a, b) => b.revision - a.revision)[0];
  if (!latest || latest.id !== input.evaluationId) return failure('REVIEW_REQUIRED', '必须使用最新审核版本显式入库');
  if (latest.decision !== 'approved' || item.reviewState !== 'approved') return failure('REVIEW_REJECTED', '审核未通过，不能入库');
  if (state.reviewForms[latest.id]?.resultSha256 !== resultSha256) return failure('REVIEW_REQUIRED', '产物摘要已变化，必须重新审核');
  let asset = state.assets.find(row => row.originItemId === id);
  if (asset) { asset.reviewId = latest.id; asset.reviewValidity = 'valid'; asset.availability = 'available'; delete asset.archivedAt; }
  else {
    asset = { id: nextId(state, 'asset'), workspaceId: 'demo', ...(item.mode === 'copy' ? { text: item.text! } : { mediaFileId: item.resultMediaId! }), mediaType: item.mode === 'copy' ? 'text' : item.mode, availability: 'available', source: 'generated', originItemId: id, reviewId: latest.id, reviewValidity: 'valid', title: '演示生成结果', tags: [], createdAt: iso(now), isDemo: true };
    state.assets.push(asset);
  }
  item.libraryState = 'saved'; publishItem(state, item, input.expectedVersion, now);
  return { ok: true, value: structuredClone(asset) };
}
