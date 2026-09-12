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
