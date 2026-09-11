import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { AgnesVideoClient } from '../src/index.ts';
import { runAgnesSmoke } from '../src/smoke-runner.ts';
import { downloadAgnesVideo } from '../src/download.ts';

async function main() {
  const apiKey = process.env.AGNES_API_KEY?.trim();
  if (!apiKey) throw new Error('AGNES_API_KEY_REQUIRED');
  const mode = process.env.AGNES_SMOKE_MODE ?? 'recover';
  if (!['recover', 'text', 'image'].includes(mode)) throw new Error('INVALID_SMOKE_MODE');
  const videoId = process.env.AGNES_EXISTING_VIDEO_ID?.trim();
  if (mode === 'recover' && !videoId) throw new Error('RECOVERY_VIDEO_ID_REQUIRED');
  if (mode !== 'recover' && videoId) throw new Error('AMBIGUOUS_CREATE_AND_RECOVER');
  if (mode !== 'recover' && process.env.AGNES_ALLOW_CREATE !== '1') throw new Error('CREATE_NOT_AUTHORIZED');
  function boundedInteger(name: string, fallback: number, minimum: number, maximum: number) {
    const value = Number(process.env[name] || fallback);
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error('INVALID_POLLING_LIMITS');
    return value;
  }
  const outputDir = resolve('artifacts/agnes-smoke');
  await mkdir(outputDir, { recursive: true });
  // Every create uses the fixed benign fixture, never customer inputs or a signed image URL.
  const imagePath = 'apps/web/public/demo/images/image-16x9-1024.png';
  const fixtureCommit = 'c130a35cc49214343f7685411c628d89356798e8';
  const imageUrl = `https://raw.githubusercontent.com/LYCMYT/AIspsc/${fixtureCommit}/${imagePath}`;
  let inputEvidence: { filename: string; sha256: string; sourceCommit: string } | undefined;
  if (mode === 'image') {
    const input = await readFile(imagePath);
    const hash = createHash('sha256').update(input).digest('hex');
    if (hash !== 'd01dbd1055c516ec511d8f682afcc755e2ce2ea884694c84159a4e7782700667') throw new Error('INPUT_FIXTURE_HASH_MISMATCH');
    // Verify the exact public reference before consuming a generation request.
    const response = await fetch(imageUrl, { redirect: 'error', signal: AbortSignal.timeout(20_000) });
    if (!response.ok || !response.headers.get('content-type')?.startsWith('image/')) throw new Error('INPUT_FIXTURE_UNAVAILABLE');
    const remote = Buffer.from(await response.arrayBuffer());
    if (createHash('sha256').update(remote).digest('hex') !== hash) throw new Error('PUBLIC_FIXTURE_HASH_MISMATCH');
    await writeFile(resolve(outputDir, 'input.png'), input);
    inputEvidence = { filename: 'input.png', sha256: hash, sourceCommit: fixtureCommit };
  }
  const request = {
    prompt: mode === 'image'
      ? 'Animate the supplied geometric test image with a slow gentle camera push-in. Preserve the original shapes, colors and composition. No new objects, no text, no cuts.'
      : 'A simple blue geometric cube slowly rotates in a clean neutral studio, stable shape, gentle camera movement, soft light, no text.',
    ...(mode === 'image' ? { imageUrl } : {}),
    durationSeconds: 5, ratio: '16:9' as const, resolution: '720p' as const, audio: false, seed: 42,
  };
  const record = await runAgnesSmoke({
    client: new AgnesVideoClient({ apiKey }),
    existingVideoId: mode === 'recover' ? videoId : undefined,
    request: mode === 'recover' ? undefined : request,
    allowCreate: mode !== 'recover' && process.env.AGNES_ALLOW_CREATE === '1',
    pollMs: boundedInteger('AGNES_SMOKE_POLL_MS', 5000, 1000, 30000),
    timeoutMs: boundedInteger('AGNES_SMOKE_TIMEOUT_MS', 600000, 1000, 600000),
    persist: async (evidence) => {
      const json = JSON.stringify({ ...evidence, inputEvidence, sourceRunId: process.env.AGNES_SOURCE_RUN_ID || null }, null, 2).split(apiKey).join('[REDACTED]');
      const pending = resolve(outputDir, 'smoke.pending.json');
      await writeFile(pending, `${json}\n`, { mode: 0o600 });
      await rename(pending, resolve(outputDir, 'smoke.json'));
    },
    download: (url) => downloadAgnesVideo(url, outputDir),
  });
  console.log(JSON.stringify({ outcome: record.outcome, operation: record.operation, newTaskSubmissions: record.newTaskSubmissions, result: record.result }));
}

await main().catch(() => {
  console.error('Agnes smoke did not complete. Inspect smoke.json for the safe error code and original video ID. Do not repeat create; recover the existing task.');
  process.exitCode = 1;
});
