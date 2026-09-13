import { expect, it } from 'vitest';
import { normalizeProviderAttempt, validateProviderAttempt, mergeProviderReportedFacts } from '../src/provider-attempt.js';
const at = '2026-09-13T00:00:00.000Z';
const legacy = { itemId: 'item-1', attemptNo: 1, providerBindingId: 'mock-video', externalIdempotencyKey: 'fake-item-1', submissionState: 'not_submitted' as const, createdAt: at, updatedAt: at };
it('merges only current output facts while retaining original identity through omitted or changed poll IDs', () => {
  const original = { status: 'queued' as const, videoId: 'original', taskId: 'task', id: 'create', createdAt: 123, seconds: 5.04, size: '1280x704' };
  const first = mergeProviderReportedFacts(original, { status: 'in_progress' });
  expect(first).toEqual({ ...original, status: 'in_progress' });
  const second = mergeProviderReportedFacts(first, { status: 'completed', videoId: 'different', taskId: 'different', id: 'different', createdAt: 456, seconds: 5.041667, sizeMapping: { adjusted: true, height: 704 } });
  expect(second).toEqual({ ...original, status: 'completed', seconds: 5.041667, sizeMapping: { adjusted: true, height: 704 } });
  expect(original.status).toBe('queued');
});
it('accepts private bounded reported facts and the explicit real binding', () => {
  const a = normalizeProviderAttempt(legacy, 'agnes-authorized-real');
  expect(() => validateProviderAttempt({ ...a, reported: { videoId: 'original', id: 'create-id', taskId: 'create-task', createdAt: 1789257600, status: 'queued', seconds: 5.04, size: '1280x704', sizeMapping: { width: 1280, height: 704, requestedWidth: 1280, requestedHeight: 720, adjusted: true, ratio: '16:9', resolution: '720p' } } })).not.toThrow();
});
it.each([{ status: 'secret' }, { status: 'queued', url: 'https://private' }, { status: 'queued', videoId: 'id?secret' }, { status: 'queued', seconds: 0 }, { status: 'queued', seconds: 61 }, { status: 'queued', createdAt: -1 }, { status: 'queued', size: '0x720' }, { status: 'queued', sizeMapping: { width: 10000 } }, { status: 'queued', sizeMapping: { adjusted: 'yes' } }, { status: 'queued', sizeMapping: { ratio: '2:1' } }, { status: 'queued', sizeMapping: { secret: 'value' } }])('rejects malformed private reported facts %j', reported => {
  const a = normalizeProviderAttempt(legacy, 'agnes-simulated');
  expect(() => validateProviderAttempt({ ...a, reported })).toThrow('INVALID_PROVIDER_ATTEMPT');
});
