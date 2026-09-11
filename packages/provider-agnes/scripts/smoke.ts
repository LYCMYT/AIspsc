import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { AgnesProviderError, AgnesVideoClient, AGNES_VIDEO_MODEL } from '../src/index.ts';

const apiKey = process.env.AGNES_API_KEY?.trim();
if (!apiKey) throw new Error('AGNES_API_KEY is required. Configure it as a GitHub Actions secret or local environment variable.');

function positiveInteger(name: string, fallback: number) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer.`);
  return value;
}

const pollMs = positiveInteger('AGNES_SMOKE_POLL_MS', 5_000);
const timeoutMs = positiveInteger('AGNES_SMOKE_TIMEOUT_MS', 600_000);
const outputDir = resolve('artifacts/agnes-smoke');
await mkdir(outputDir, { recursive: true });

const startedAt = new Date().toISOString();
const timeline: Array<{ at: string; providerStatus: string; normalizedStatus: string; progress?: number }> = [];
const client = new AgnesVideoClient({ apiKey });

const request = {
  prompt: 'A simple blue geometric cube slowly rotates in a clean neutral studio, stable shape, gentle camera movement, soft light, no text.',
  durationSeconds: 5,
  ratio: '16:9' as const,
  resolution: '720p' as const,
  audio: false,
  seed: 42,
};

async function saveRecord(record: unknown) {
  await writeFile(resolve(outputDir, 'smoke.json'), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
}

try {
  console.log(`Starting Agnes smoke test with ${AGNES_VIDEO_MODEL}.`);
  let task = await client.createVideo(request);
  if (!task.videoId) throw new Error('Agnes create response did not include video_id.');
  timeline.push({ at: new Date().toISOString(), providerStatus: task.providerStatus, normalizedStatus: task.status, progress: task.progress });
  console.log(`Created video task ${task.videoId}; status=${task.providerStatus}.`);

  const deadline = Date.now() + timeoutMs;
  while (task.status === 'queued' || task.status === 'running' || task.status === 'needs_reconciliation') {
    if (Date.now() >= deadline) throw new Error(`Agnes smoke test exceeded ${timeoutMs}ms polling timeout.`);
    await new Promise((resolveSleep) => setTimeout(resolveSleep, pollMs));
    task = await client.getVideo(task.videoId);
    timeline.push({ at: new Date().toISOString(), providerStatus: task.providerStatus, normalizedStatus: task.status, progress: task.progress });
    console.log(`Poll status=${task.providerStatus}; progress=${task.progress ?? 'n/a'}.`);
  }

  if (task.status !== 'succeeded' || !task.resultUrl) {
    throw new Error(`Agnes smoke task ended as ${task.providerStatus}: ${task.errorMessage ?? 'no provider error message'}`);
  }

  const resultResponse = await fetch(task.resultUrl, { signal: AbortSignal.timeout(60_000) });
  if (!resultResponse.ok) throw new Error(`Generated video download failed with HTTP ${resultResponse.status}.`);
  const bytes = Buffer.from(await resultResponse.arrayBuffer());
  if (!bytes.length) throw new Error('Generated video download returned an empty file.');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  await writeFile(resolve(outputDir, 'result.mp4'), bytes);

  const completedAt = new Date().toISOString();
  await saveRecord({
    version: 1,
    provider: 'Agnes AI',
    model: AGNES_VIDEO_MODEL,
    startedAt,
    completedAt,
    request,
    externalIds: { taskId: task.taskId, videoId: task.videoId },
    statusTimeline: timeline,
    providerReported: { seconds: task.seconds, size: task.size },
    result: { filename: 'result.mp4', sha256, byteSize: bytes.length },
    secretHandling: 'AGNES_API_KEY was read only from the environment and is not written to artifacts.',
  });
  console.log(`Agnes smoke succeeded; saved ${bytes.length} bytes with sha256=${sha256}.`);
} catch (error) {
  const safeError = error instanceof AgnesProviderError
    ? { name: error.name, kind: error.kind, status: error.status, message: error.message }
    : { name: error instanceof Error ? error.name : 'Error', message: error instanceof Error ? error.message : String(error) };
  await saveRecord({
    version: 1,
    provider: 'Agnes AI',
    model: AGNES_VIDEO_MODEL,
    startedAt,
    failedAt: new Date().toISOString(),
    request,
    statusTimeline: timeline,
    error: safeError,
    secretHandling: 'AGNES_API_KEY was read only from the environment and is not written to artifacts.',
  });
  throw error;
}
