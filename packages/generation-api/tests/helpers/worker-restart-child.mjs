import { createServer } from 'vite';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, relative, join, isAbsolute } from 'node:path';

const [mode, stage, suppliedDirectory] = process.argv.slice(2);
if (!['seed', 'resume'].includes(mode) || !['submitting', 'submitted', 'polling', 'downloading', 'settled'].includes(stage) || !suppliedDirectory) throw Error('INVALID_CHILD_INPUT');
const directory = resolve(suppliedDirectory);
const contained = relative(resolve('.cache/generation-tests/process-restart'), directory);
if (!contained || contained.startsWith('..') || isAbsolute(contained)) throw Error('INVALID_CHILD_DIRECTORY');
// This synthetic port has no network implementation or secret configuration.
globalThis.fetch = async () => { throw Error('NETWORK_FORBIDDEN_IN_PROCESS_TEST'); };
const loader = await createServer({ configFile: false, root: process.cwd(), server: { middlewareMode: true, hmr: false, ws: false, watch: null }, appType: 'custom', logLevel: 'error' });
let store;
let worker;
try {
  const { GenerationStore } = await loader.ssrLoadModule('/packages/generation-api/src/store.ts');
  const { GenerationApiService } = await loader.ssrLoadModule('/packages/generation-api/src/service.ts');
  const { GenerationWorker } = await loader.ssrLoadModule('/packages/generation-api/src/worker.ts');
  const { GenerationMediaRepository } = await loader.ssrLoadModule('/packages/generation-api/src/media-repository.ts');
  const { FixtureCatalog } = await loader.ssrLoadModule('/packages/generation-api/src/fixtures.ts');
  const fixtures = await FixtureCatalog.open(resolve('apps/web/public/demo'));
  store = await GenerationStore.open(join(directory, 'state'));
  const callsPath = join(directory, 'calls.json');
  const calls = mode === 'seed' ? { create: 0, get: 0, download: 0, jobIds: [] } : JSON.parse(await readFile(callsPath, 'utf8'));
  const count = async (action, jobId) => {
    calls[action]++;
    if (jobId) calls.jobIds.push(jobId);
    await writeFile(callsPath, JSON.stringify(calls));
  };
  const report = async () => {
    const state = store.read();
    const attempt = state.attempts[0];
    await writeFile(join(directory, `${mode}-report.json`), JSON.stringify({ pid: process.pid, status: state.items[0].status, attemptState: attempt.submissionState, attemptId: attempt.attemptId, externalJobId: attempt.externalJobId, submittedAt: attempt.submittedAt, attemptCount: state.attempts.length, reserved: state.credits.reserved, spent: state.credits.spent, rawSha256: attempt.rawMedia?.rawSha256, derivativeSourceSha256: attempt.derivativeEvidence?.sourceSha256, calls }));
  };
  const controlledExit = async () => {
    await report();
    // Deliberately release the ownership lock, then exit before the awaited operation responds.
    // This tests a separate process reopening durable records, not SIGKILL/power-loss lock recovery.
    await store.close();
    process.exit(0);
  };
  const provider = {
    bindingId: 'agnes-simulated',
    create: async () => {
      await count('create');
      if (mode === 'seed' && stage === 'submitting') await controlledExit();
      return { externalJobId: 'process-original-job', status: 'queued' };
    },
    get: async (jobId) => {
      if (jobId !== 'process-original-job') throw Error('UNEXPECTED_PROVIDER_JOB');
      await count('get', jobId);
      if (mode === 'seed' && stage === 'polling') return { status: 'running' };
      return stage === 'downloading'
        ? { status: 'result_ready', result: { kind: 'https', url: 'https://platform-outputs.agnes-ai.space/synthetic-process.mp4' } }
        : { status: 'result_ready', result: { kind: 'text', text: '独立进程恢复演示文案' } };
    },
    download: async (reference) => {
      await count('download');
      if (reference.kind === 'text') return { kind: 'text', text: reference.text };
      const actual = await fixtures.readFixture('video-5-16x9-720p-silent');
      return { kind: 'media', bytes: actual.bytes, sha256: actual.media.sha256, mime: 'video/mp4', provenance: 'synthetic_provider_simulation' };
    },
  };
  const repository = stage === 'downloading' ? await GenerationMediaRepository.open(join(directory, 'state'), fixtures) : undefined;
  if (repository && mode === 'seed') repository.finalize = controlledExit;
  let now = Date.now() + (mode === 'resume' ? 1000 : 0);
  const service = new GenerationApiService(store, fixtures, () => now);
  worker = new GenerationWorker(store, provider, fixtures, repository, () => now);
  if (mode === 'seed') {
    const created = await service.create(stage === 'downloading'
      ? { mode: 'video', prompt: '独立进程恢复演示', count: 1, references: [], video: { durationSeconds: 5, ratio: '16:9', resolution: '720p', audio: false } }
      : { mode: 'copy', prompt: '独立进程恢复演示', count: 1, references: [], copy: { language: 'zh-CN', maxCharacters: 100 } }, 'process-create');
    if (!created.ok) throw Error('PROCESS_FIXTURE_CREATE_FAILED');
    now += 101;
    await worker.tick();
    if (stage !== 'submitted') { now += 101; await worker.tick(); }
  } else {
    await worker.tick();
    now += 101;
    await worker.tick();
  }
  await report();
} finally {
  await worker?.stop();
  await store?.close();
  await loader.close();
}
