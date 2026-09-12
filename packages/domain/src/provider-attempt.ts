import type { ProviderAttempt, ProviderSubmissionState } from '../../contracts/src/index.js';
const states = ['not_submitted', 'submitting', 'submitted', 'polling', 'result_ready', 'downloading', 'settled', 'needs_reconciliation', 'failed'];
const bindings = ['fake-local', 'agnes-simulated', 'agnes-disabled'];
const id = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(v);
const date = (v: unknown): v is string => typeof v === 'string' && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
const uuidPattern = '[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}';
const rawKey = new RegExp(`^media/raw-${uuidPattern}\\.mp4$`);
const derivativeKey = new RegExp(`^media/delivery-${uuidPattern}/result\\.mp4$`);
const mediaId = new RegExp(`^provider-${uuidPattern}$`);
const hash = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const bad = (): never => { throw Error('INVALID_PROVIDER_ATTEMPT'); };
/** Strict private lifecycle validation, separate from untouched browser attempts. */
export function validateProviderAttempt(value: unknown): asserts value is ProviderAttempt {
 if (!value || typeof value !== 'object' || Array.isArray(value)) bad();
 const a = value as ProviderAttempt;
 const required = ['lifecycleVersion','attemptId','itemId','attemptNo','providerBindingId','externalIdempotencyKey','submissionState','createdAt','updatedAt','actualCost'];
 const optional = ['externalJobId','providerStatus','submittedAt','lastPolledAt','nextPollAt','errorCategory','rawMedia','derivativeEvidence'];
 if (required.some(k => !Object.hasOwn(a,k)) || Object.keys(a).some(k => ![...required,...optional].includes(k))) bad();
 if (a.lifecycleVersion !== 1 || !id(a.attemptId) || !id(a.itemId) || a.attemptNo !== 1 || !bindings.includes(a.providerBindingId) || !id(a.externalIdempotencyKey) || (a.externalJobId !== undefined && !id(a.externalJobId)) || !states.includes(a.submissionState) || a.actualCost !== null) bad();
 if (!date(a.createdAt) || !date(a.updatedAt) || a.updatedAt < a.createdAt) bad();
 for (const t of [a.submittedAt,a.lastPolledAt,a.nextPollAt]) if (t !== undefined && (!date(t) || t < a.createdAt)) bad();
 if (a.lastPolledAt && (!a.submittedAt || a.lastPolledAt < a.submittedAt || a.lastPolledAt > a.updatedAt)) bad();
 if (a.nextPollAt && a.lastPolledAt && a.nextPollAt < a.lastPolledAt) bad();
 if (a.submittedAt && a.submittedAt > a.updatedAt) bad();
 if (a.providerStatus !== undefined && !['queued','running','result_ready','failed','cancelled','unknown'].includes(a.providerStatus)) bad();
 if (a.errorCategory !== undefined && !['invalid_request','unauthorized','not_found','rate_limited','transient','unknown'].includes(a.errorCategory)) bad();
 if (['submitted','polling','result_ready','downloading'].includes(a.submissionState) && (!a.externalJobId || !a.submittedAt)) bad();
 if (a.submissionState === 'not_submitted' && (a.externalJobId || a.submittedAt)) bad();
 if (a.rawMedia !== undefined) validateRaw(a);
 if (a.derivativeEvidence !== undefined) {
  const d = a.derivativeEvidence;
  if (!d || typeof d !== 'object' || !a.rawMedia || Object.keys(d).sort().join(',') !== 'completedAt,media,policy,reportSha256,sourceSha256' || d.policy !== 'delivery-v1' || d.sourceSha256 !== a.rawMedia.rawSha256 || !hash(d.reportSha256) || !date(d.completedAt) || d.completedAt < a.rawMedia.downloadedAt) bad();
  const m = d.media;
  const mediaFields = ['id','workspaceId','mediaType','mime','byteSize','width','height','durationMs','objectKey','sha256','availability','hasAudio','isDemo','fixtureKey'];
  if (!m || typeof m !== 'object' || Object.keys(m).length !== mediaFields.length || mediaFields.some(k => !Object.hasOwn(m,k)) || !mediaId.test(m.id) || !derivativeKey.test(m.objectKey ?? '') || !hash(m.sha256) || m.workspaceId !== 'demo' || m.mediaType !== 'video' || m.mime !== 'video/mp4' || m.availability !== 'available' || m.hasAudio !== false || m.isDemo !== true || m.fixtureKey !== 'synthetic-provider-simulation') bad();
  if (!Number.isSafeInteger(m.byteSize) || m.byteSize <= 0 || m.byteSize > 128 * 1024 * 1024 || !Number.isSafeInteger(m.durationMs) || m.durationMs! < 5000 || m.durationMs! > 15000) bad();
  for (const n of [m.width,m.height]) if (!Number.isSafeInteger(n) || n! <= 0 || n! > 4096 || n! % 2) bad();
  if (!['downloading','settled'].includes(a.submissionState)) bad();
 }
}
function validateRaw(a: ProviderAttempt) {
 const r = a.rawMedia!;
 const required = ['provider','externalJobId','providerResultReferenceKind','resultHost','retrievedAt','rawSha256','rawActualWidth','rawActualHeight','rawDuration','rawHasAudio','rawFps','rawFrames','rawDecodeVerified','rawObjectKey','rawByteSize','downloadedAt','provenance'];
 if (!r || typeof r !== 'object' || required.some(k => !Object.hasOwn(r,k)) || Object.keys(r).some(k => ![...required,'providerReportedSeconds','providerReportedSize'].includes(k))) bad();
 if (r.provider !== a.providerBindingId || r.externalJobId !== a.externalJobId || r.providerResultReferenceKind !== 'https' || !['platform-outputs.agnes-ai.space','cos-platform-outputs.agnes-ai.cn'].includes(r.resultHost) || !date(r.retrievedAt) || !date(r.downloadedAt) || !/^[a-f0-9]{64}$/.test(r.rawSha256) || !rawKey.test(r.rawObjectKey) || r.rawDecodeVerified !== true || r.provenance !== 'synthetic_provider_simulation' || typeof r.rawHasAudio !== 'boolean') bad();
 for (const n of [r.rawActualWidth,r.rawActualHeight,r.rawFrames,r.rawByteSize]) if (!Number.isSafeInteger(n) || n <= 0) bad();
 // Retain original raw evidence while re-querying its same job after an unknown/corrupt-file recovery.
 if (r.rawActualWidth > 4096 || r.rawActualHeight > 4096 || r.rawByteSize > 128 * 1024 * 1024 || r.rawDuration > 60 || r.rawFps > 120 || r.rawFrames > 7200 || r.downloadedAt < r.retrievedAt || !['polling','result_ready','downloading','settled','needs_reconciliation','failed'].includes(a.submissionState)) bad();
 for (const n of [r.rawDuration,r.rawFps,r.providerReportedSeconds ?? 1]) if (!Number.isFinite(n) || n <= 0 || n > 100000) bad();
 if (r.providerReportedSize !== undefined && !/^\d{1,5}x\d{1,5}$/.test(r.providerReportedSize)) bad();
}
/** Adoption is explicit: an interrupted claim must never become eligible for POST. */
export function normalizeProviderAttempt(legacy: ProviderAttempt, bindingId: string): ProviderAttempt {
 if (legacy.lifecycleVersion !== undefined) { validateProviderAttempt(legacy); return structuredClone(legacy); }
 if (!['not_submitted','submitting','submitted','outcome_unknown','settled'].includes(legacy.submissionState)) bad();
 const a: ProviderAttempt = { ...legacy, lifecycleVersion: 1, attemptId: `attempt-${legacy.itemId}-${legacy.attemptNo}`, providerBindingId: bindingId, actualCost: null,
 submissionState: ['submitting','outcome_unknown'].includes(legacy.submissionState) ? 'needs_reconciliation' : legacy.submissionState,
 ...(legacy.externalJobId ? { submittedAt: legacy.updatedAt } : {}) };
 validateProviderAttempt(a); return a;
}
const edges: Record<string, string[]> = {
 not_submitted: ['submitting','failed'], submitting: ['submitted','needs_reconciliation','failed'], submitted: ['polling','needs_reconciliation','failed'],
 polling: ['polling','result_ready','needs_reconciliation','failed'], result_ready: ['downloading','needs_reconciliation','failed'], downloading: ['downloading','result_ready','settled','needs_reconciliation','failed'],
 needs_reconciliation: ['polling','failed'], settled: [], failed: [],
};
export function transitionAttempt(attempt: ProviderAttempt, next: Exclude<ProviderSubmissionState,'outcome_unknown'>, now: number, patch: Partial<Pick<ProviderAttempt,'externalJobId'|'providerStatus'|'submittedAt'|'lastPolledAt'|'nextPollAt'|'errorCategory'|'rawMedia'|'derivativeEvidence'>> = {}): ProviderAttempt {
 validateProviderAttempt(attempt);
 if (Object.keys(patch).some(k => !['externalJobId','providerStatus','submittedAt','lastPolledAt','nextPollAt','errorCategory','rawMedia','derivativeEvidence'].includes(k))) throw Error('INVALID_ATTEMPT_TRANSITION');
 if (!edges[attempt.submissionState]?.includes(next)) throw Error('INVALID_ATTEMPT_TRANSITION');
 if (attempt.externalJobId && Object.hasOwn(patch, 'externalJobId') && attempt.externalJobId !== patch.externalJobId) throw Error('INVALID_ATTEMPT_TRANSITION');
 const result = { ...structuredClone(attempt), ...structuredClone(patch), submissionState: next, updatedAt: new Date(now).toISOString() };
 validateProviderAttempt(result); return result;
}
