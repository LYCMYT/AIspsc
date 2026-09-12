import { describe, expect, it } from 'vitest';
import type { ProviderAttempt } from '../../contracts/src/index.js';
import { normalizeProviderAttempt, transitionAttempt, validateProviderAttempt } from '../src/provider-attempt.js';
const now = Date.parse('2026-09-13T00:00:00.000Z');
const legacy = (): ProviderAttempt => ({ itemId: 'item-1', attemptNo: 1, providerBindingId: 'mock-video', externalIdempotencyKey: 'fake-item-1', submissionState: 'not_submitted', createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString() });
describe('checked provider attempt lifecycle', () => {
 it('walks legal transitions immutably and prevents repeat submission', () => {
  let a = normalizeProviderAttempt(legacy(), 'fake-local');
  expect(() => transitionAttempt(a, 'settled', now)).toThrow('INVALID_ATTEMPT_TRANSITION');
  expect(a.submissionState).toBe('not_submitted');
  a = transitionAttempt(a, 'submitting', now);
  a = transitionAttempt(a, 'submitted', now, { externalJobId: 'job-1', submittedAt: new Date(now).toISOString(), providerStatus: 'queued' });
  for (const state of ['polling', 'result_ready', 'downloading', 'settled'] as const) a = transitionAttempt(a, state, now);
  expect(() => transitionAttempt(a, 'submitting', now)).toThrow('INVALID_ATTEMPT_TRANSITION');
 });
 it.each(['submitting', 'outcome_unknown'] as const)('adopts legacy %s as ambiguous', submissionState => {
  const a = normalizeProviderAttempt({ ...legacy(), submissionState }, 'fake-local');
  expect(a.submissionState).toBe('needs_reconciliation');
  expect(() => transitionAttempt(a, 'submitting', now)).toThrow('INVALID_ATTEMPT_TRANSITION');
 });
 it.each([{ nextPollAt: 'bad' }, { externalJobId: 'https://private?token=secret' }, { providerStatus: 'secret' }, { actualCost: 1 }, { providerBindingId: 'real-production' }, { submissionState: 'outcome_unknown' }])('rejects corrupt metadata %j', patch => {
  expect(() => validateProviderAttempt({ ...normalizeProviderAttempt(legacy(), 'fake-local'), ...patch })).toThrow('INVALID_PROVIDER_ATTEMPT');
 });
});
const lifecycleStates = ['not_submitted','submitting','submitted','polling','result_ready','downloading','needs_reconciliation','settled','failed'] as const;
const legal: Record<string, string[]> = { not_submitted:['submitting','failed'], submitting:['submitted','needs_reconciliation','failed'], submitted:['polling','needs_reconciliation','failed'], polling:['polling','result_ready','needs_reconciliation','failed'], result_ready:['downloading','needs_reconciliation','failed'], downloading:['downloading','result_ready','settled','needs_reconciliation','failed'], needs_reconciliation:['polling','failed'], settled:[], failed:[] };
describe('complete attempt transition matrix', () => {
 for (const from of lifecycleStates) for (const to of lifecycleStates) it(`${from} -> ${to}`, () => {
  const a = { ...normalizeProviderAttempt(legacy(), 'agnes-simulated'), submissionState: from, ...(from === 'not_submitted' ? {} : { externalJobId: 'known-job', submittedAt: new Date(now).toISOString() }) };
  const snapshot = structuredClone(a);
  const run = () => transitionAttempt(a, to, now, to === 'submitted' ? { externalJobId: 'known-job', submittedAt: new Date(now).toISOString() } : {});
  if (legal[from]!.includes(to)) expect(run().submissionState).toBe(to); else expect(run).toThrow('INVALID_ATTEMPT_TRANSITION');
  expect(a).toEqual(snapshot);
 });
 it('retains legacy submitted identity and settled history on adoption', () => {
  for (const submissionState of ['submitted','settled'] as const) {
   const old = { ...legacy(), submissionState, externalJobId:'fake-job-item-1' };
   expect(normalizeProviderAttempt(old,'fake-local')).toMatchObject({ submissionState, externalJobId:old.externalJobId, externalIdempotencyKey:old.externalIdempotencyKey });
  }
 });
});

describe('durable job and nested evidence regression', () => {
 it('cannot clear a known job through an explicitly undefined patch', () => {
  const a = normalizeProviderAttempt({ ...legacy(), submissionState: 'submitted', externalJobId:'known-job' }, 'agnes-simulated');
  expect(() => transitionAttempt(a, 'needs_reconciliation', now, { externalJobId: undefined })).toThrow('INVALID_ATTEMPT_TRANSITION');
  expect(a.externalJobId).toBe('known-job');
 });
 it('rejects arbitrary nested media fields', () => {
  const a = normalizeProviderAttempt({ ...legacy(), submissionState: 'submitted', externalJobId:'known-job' }, 'agnes-simulated');
  const uuid = '11111111-1111-4111-8111-111111111111';
  const rawMedia = { provider:'agnes-simulated',externalJobId:'known-job',providerResultReferenceKind:'https',resultHost:'platform-outputs.agnes-ai.space',retrievedAt:a.updatedAt,rawSha256:'a'.repeat(64),rawActualWidth:1280,rawActualHeight:704,rawDuration:5,rawHasAudio:true,rawFps:24,rawFrames:120,rawDecodeVerified:true,rawObjectKey:`media/raw-${uuid}.mp4`,rawByteSize:100,downloadedAt:a.updatedAt,provenance:'synthetic_provider_simulation' };
  // Exercise the original shape as well as the new hash-bound report shape.
  for (const report of [{}, { reportSha256:'c'.repeat(64) }]) expect(() => validateProviderAttempt({ ...a, rawMedia, derivativeEvidence: { policy:'delivery-v1',sourceSha256:rawMedia.rawSha256,completedAt:a.updatedAt,...report,media:{objectKey:`media/delivery-${uuid}/result.mp4`,sha256:'b'.repeat(64),unexpectedPrivateField:'synthetic-sentinel'} } })).toThrow('INVALID_PROVIDER_ATTEMPT');
 });
});

it('accepts bounded hash-bound evidence and rejects each corrupted scalar or nested field', () => {
 const uuid='11111111-1111-4111-8111-111111111111';const at=new Date(now).toISOString();
 const a: ProviderAttempt={...normalizeProviderAttempt({...legacy(),submissionState:'submitted',externalJobId:'known-job'},'agnes-simulated'),submissionState:'downloading',rawMedia:{provider:'agnes-simulated',externalJobId:'known-job',providerResultReferenceKind:'https',resultHost:'platform-outputs.agnes-ai.space',retrievedAt:at,rawSha256:'a'.repeat(64),rawActualWidth:1280,rawActualHeight:704,rawDuration:5,rawHasAudio:true,rawFps:24,rawFrames:120,rawDecodeVerified:true,rawObjectKey:`media/raw-${uuid}.mp4`,rawByteSize:100,downloadedAt:at,provenance:'synthetic_provider_simulation'},derivativeEvidence:{policy:'delivery-v1',sourceSha256:'a'.repeat(64),reportSha256:'c'.repeat(64),completedAt:at,media:{id:`provider-${uuid}`,workspaceId:'demo',mediaType:'video',mime:'video/mp4',byteSize:100,width:1280,height:720,durationMs:5000,objectKey:`media/delivery-${uuid}/result.mp4`,sha256:'b'.repeat(64),availability:'available',hasAudio:false,isDemo:true,fixtureKey:'synthetic-provider-simulation'}}};
 expect(()=>validateProviderAttempt(a)).not.toThrow();
 for(const patch of [{resultHost:'evil.example'}, {rawActualWidth:4097}, {rawByteSize:128*1024*1024+1}, {rawDuration:61}, {rawFps:121}, {rawObjectKey:'media/raw-------------------------------------.mp4'}]) expect(()=>validateProviderAttempt({...a,rawMedia:{...a.rawMedia,...patch}})).toThrow('INVALID_PROVIDER_ATTEMPT');
 for(const patch of [{unexpectedPrivateField:'synthetic-sentinel'}, {hasAudio:true}, {durationMs:0}, {width:4098}, {fixtureKey:'forged'}, {objectKey:'../../private.mp4'}]) expect(()=>validateProviderAttempt({...a,derivativeEvidence:{...a.derivativeEvidence,media:{...a.derivativeEvidence!.media,...patch}}})).toThrow('INVALID_PROVIDER_ATTEMPT');
 expect(()=>validateProviderAttempt({...a,derivativeEvidence:{...a.derivativeEvidence,reportSha256:'bad'}})).toThrow('INVALID_PROVIDER_ATTEMPT');
});
