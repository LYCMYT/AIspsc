import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { AgnesProviderError } from './index.ts';
import type { AgnesVideoTask } from './index.ts';
import { runAgnesSmoke } from './smoke-runner.ts';
import type { SmokeEvidence } from './smoke-runner.ts';

const resultUrl = 'https://platform-outputs.agnes-ai.space/videos/test.mp4?signature=private';
const request = { prompt: 'test', durationSeconds: 5, ratio: '16:9' as const, resolution: '720p' as const, audio: false };
const result = { filename: 'result.mp4', sha256: 'a'.repeat(64), byteSize: 100, media: { durationMs: 5042, width: 1280, height: 720, hasAudio: false, decodeVerified: true } };
function task(status: AgnesVideoTask['status'], url?: string): AgnesVideoTask {
  return { videoId: 'video-original', model: 'agnes-video-v2.0', providerStatus: status === 'succeeded' ? 'completed' : status, status, resultUrl: url };
}
function harness(tasks: AgnesVideoTask[]) {
  let creates = 0;
  let clock = 0;
  let downloads = 0;
  const ids: string[] = [];
  const saved: SmokeEvidence[] = [];
  return {
    counters: () => ({ creates, downloads, ids }), saved,
    options: {
      client: {
        createVideo: async () => { creates++; return task('queued'); },
        getVideo: async (id: string) => { ids.push(id); return tasks.shift() ?? task('succeeded', resultUrl); },
      },
      persist: async (record: SmokeEvidence) => { saved.push(structuredClone(record)); },
      download: async () => { downloads++; return result; },
      now: () => clock,
      sleep: async (ms: number) => { clock += ms; },
      pollMs: 1, timeoutMs: 5,
    },
  };
}

describe('Agnes resumable smoke control', () => {
  it('recovers an existing video with zero create calls', async () => {
    const h = harness([task('succeeded', resultUrl)]);
    const record = await runAgnesSmoke({ ...h.options, existingVideoId: 'video-original' });
    assert.equal(record.outcome, 'succeeded');
    assert.equal(h.counters().creates, 0);
    assert.equal(h.counters().downloads, 1);
    assert.deepEqual(h.counters().ids, ['video-original']);
    assert.equal(record.request, undefined); // recovery must not invent the original inputs
    assert.ok(!JSON.stringify(h.saved).includes('signature=private'));
  });
  it('blocks creating a task without explicit create authorization', async () => {
    const h = harness([]);
    await assert.rejects(runAgnesSmoke({ ...h.options, request }), /CREATE_NOT_AUTHORIZED/);
    assert.equal(h.counters().creates, 0);
  });
  it('polls completed-without-url using the same ID instead of creating again', async () => {
    const h = harness([task('succeeded'), task('succeeded', resultUrl)]);
    const record = await runAgnesSmoke({ ...h.options, request, allowCreate: true });
    assert.equal(record.outcome, 'succeeded');
    assert.equal(h.counters().creates, 1);
    assert.deepEqual(h.counters().ids, ['video-original', 'video-original']);
    assert.ok(h.saved.some((r) => r.phase === 'finalizing'));
  });
  it('checkpoints the external ID before a download can fail', async () => {
    const h = harness([task('succeeded', resultUrl)]);
    await assert.rejects(runAgnesSmoke({ ...h.options, existingVideoId: 'video-original', download: async () => { throw new Error('secret URL'); } }), /RESULT_DOWNLOAD_FAILED/);
    const last = h.saved.at(-1);
    assert.equal(last?.externalVideoId, 'video-original');
    assert.equal(last?.outcome, 'needs_reconciliation');
    assert.ok(!JSON.stringify(h.saved).includes('secret URL'));
  });
  it('never retries an ambiguous create timeout', async () => {
    const h = harness([]);
    let creates = 0;
    await assert.rejects(runAgnesSmoke({ ...h.options, request, allowCreate: true, client: { ...h.options.client, createVideo: async () => { creates++; throw new AgnesProviderError('transient', 'timeout'); } } }), /CREATE_OUTCOME_UNKNOWN/);
    assert.equal(creates, 1);
    assert.equal(h.saved.at(-1)?.outcome, 'needs_reconciliation');
  });
  it('does not claim success when a completed task never provides a URL', async () => {
    const h = harness([]);
    await assert.rejects(runAgnesSmoke({ ...h.options, existingVideoId: 'video-original', client: { ...h.options.client, getVideo: async () => task('succeeded') } }), /RESULT_NOT_READY/);
    assert.equal(h.counters().creates, 0);
    assert.equal(h.counters().downloads, 0);
    assert.equal(h.saved.at(-1)?.externalVideoId, 'video-original');
  });
  it('records provider failure separately from local result-download failure', async () => {
    const h = harness([task('failed')]);
    await assert.rejects(runAgnesSmoke({ ...h.options, existingVideoId: 'video-original' }), /PROVIDER_TASK_FAILED/);
    assert.equal(h.saved.at(-1)?.outcome, 'failed');
    assert.equal(h.counters().downloads, 0);
  });
});
