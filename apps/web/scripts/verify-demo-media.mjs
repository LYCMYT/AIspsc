import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, normalize, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const demoRoot = resolve(scriptDirectory, '../public/demo');
const manifestPath = join(demoRoot, 'MEDIA_MANIFEST.json');
const failures = [];
let decodedFiles = 0;

const ratios = {
  '9x16': { '720p': [720, 1280], '1080p': [1080, 1920] },
  '16x9': { '720p': [1280, 720], '1080p': [1920, 1080] },
  '1x1': { '720p': [720, 720], '1080p': [1080, 1080] },
};

function expectedEntries() {
  const entries = [];
  for (let duration = 5; duration <= 15; duration += 1) {
    for (const [ratio, resolutions] of Object.entries(ratios)) {
      for (const [resolution, [width, height]] of Object.entries(resolutions)) {
        for (const hasAudio of [false, true]) {
          const suffix = hasAudio ? 'audio' : 'silent';
          const key = `video-${duration}-${ratio}-${resolution}-${suffix}`;
          entries.push({ key, path: `videos/${key}.mp4`, kind: 'video', durationMs: duration * 1000, width, height, hasAudio });
        }
      }
    }
  }

  entries.push(
    { key: 'image-9x16-1024', path: 'images/image-9x16-1024.png', kind: 'image', width: 576, height: 1024, hasAudio: false },
    { key: 'image-16x9-1024', path: 'images/image-16x9-1024.png', kind: 'image', width: 1024, height: 576, hasAudio: false },
    { key: 'image-1x1-1024', path: 'images/image-1x1-1024.png', kind: 'image', width: 1024, height: 1024, hasAudio: false },
    { key: 'scene-source', path: 'scene/scene-source.mp4', kind: 'source', durationMs: 32000, width: 720, height: 1280, hasAudio: false, sceneCutMs: [3000, 12000, 20000] },
  );

  const clipGroups = {
    sequential: [[0, 15000], [15000, 30000], [27000, 32000]],
    average: [[0, 15000], [8500, 23500], [17000, 32000]],
    scene: [[0, 5000], [3000, 12000], [12000, 20000], [20000, 32000]],
  };
  for (const [mode, ranges] of Object.entries(clipGroups)) {
    ranges.forEach(([startMs, endMs], index) => {
      const key = `scene-${mode}-${index + 1}`;
      entries.push({ key, path: `clips/${key}.mp4`, kind: 'clip', durationMs: endMs - startMs, width: 720, height: 1280, hasAudio: false, startMs, endMs });
    });
  }
  return entries;
}

function fail(message) {
  failures.push(message);
}

function run(command, args, label) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 120_000, windowsHide: true });
  if (result.error || result.status !== 0) {
    fail(`${label}: ${result.error?.message ?? result.stderr.trim() ?? `exit ${result.status}`}`);
    return null;
  }
  return result.stdout;
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function detectSceneCutMs(path) {
  const result = spawnSync('ffmpeg', [
    '-v', 'info', '-i', path, '-vf', 'select=gt(scene\\,0.30),metadata=print', '-an', '-f', 'null', '-',
  ], { encoding: 'utf8', timeout: 120_000, windowsHide: true });
  if (result.error || result.status !== 0) return [];
  return [...result.stderr.matchAll(/pts_time:([0-9.]+)/g)].map((match) => Math.round(Number(match[1]) * 1000));
}

function sampleAverageRgb(path, timeMs) {
  const result = spawnSync('ffmpeg', [
    '-v', 'error', '-ss', (timeMs / 1000).toFixed(3), '-i', path,
    '-frames:v', '1', '-vf', 'scale=1:1,format=rgb24', '-f', 'rawvideo', '-',
  ], { timeout: 120_000, windowsHide: true });
  if (result.error || result.status !== 0 || result.stdout.length < 3) return null;
  return [...result.stdout.subarray(0, 3)];
}

let manifest;
try {
  manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
} catch (error) {
  console.error(`MEDIA VERIFY FAIL: cannot read ${manifestPath}: ${error.message}`);
  process.exit(1);
}

if (manifest.version !== 1 || !Array.isArray(manifest.files)) {
  console.error('MEDIA VERIFY FAIL: manifest must contain version=1 and a files array');
  process.exit(1);
}

const expected = expectedEntries();
const actualByKey = new Map();
for (const item of manifest.files) {
  if (!item?.key || actualByKey.has(item.key)) fail(`duplicate or missing key: ${item?.key}`);
  actualByKey.set(item?.key, item);
}
if (manifest.files.length !== expected.length) fail(`expected ${expected.length} files, found ${manifest.files.length}`);
const sceneSourceSha256 = actualByKey.get('scene-source')?.sha256;
const detectedSceneCutMs = detectSceneCutMs(join(demoRoot, 'scene', 'scene-source.mp4'));
if (JSON.stringify(detectedSceneCutMs) !== JSON.stringify([3000, 12000, 20000])) {
  fail(`scene-source: FFmpeg scene=0.30 detected ${JSON.stringify(detectedSceneCutMs)}, expected [3000,12000,20000]`);
}

for (const [specIndex, spec] of expected.entries()) {
  const item = actualByKey.get(spec.key);
  if (!item) {
    fail(`missing manifest entry: ${spec.key}`);
    continue;
  }
  for (const field of ['path', 'kind', 'width', 'height', 'hasAudio']) {
    if (item[field] !== spec[field]) fail(`${spec.key}: ${field} expected ${spec[field]}, found ${item[field]}`);
  }
  if (spec.durationMs !== undefined && item.durationMs !== spec.durationMs) fail(`${spec.key}: manifest durationMs expected ${spec.durationMs}, found ${item.durationMs}`);
  if (item.source !== 'self-generated' || item.fixtureKey !== spec.key) fail(`${spec.key}: provenance/fixtureKey mismatch`);
  if (item.mime !== (spec.kind === 'image' ? 'image/png' : 'video/mp4')) fail(`${spec.key}: incorrect MIME`);
  if (spec.sceneCutMs && JSON.stringify(item.sceneCutMs) !== JSON.stringify(spec.sceneCutMs)) fail(`${spec.key}: sceneCutMs mismatch`);
  if (spec.startMs !== undefined && (item.startMs !== spec.startMs || item.endMs !== spec.endMs)) fail(`${spec.key}: clip interval mismatch`);
  if (spec.kind === 'clip' && item.sourceSha256 !== sceneSourceSha256) fail(`${spec.key}: sourceSha256 does not bind to scene-source`);

  const filePath = resolve(demoRoot, normalize(item.path));
  if (relative(demoRoot, filePath).startsWith('..')) {
    fail(`${spec.key}: path escapes demo root`);
    continue;
  }
  let digest;
  try {
    digest = sha256(filePath);
  } catch (error) {
    fail(`${spec.key}: file missing/unreadable (${error.message})`);
    continue;
  }
  if (digest !== item.sha256) fail(`${spec.key}: SHA-256 mismatch`);

  const probeText = run('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', filePath], `${spec.key} ffprobe`);
  if (!probeText) continue;
  let probe;
  try {
    probe = JSON.parse(probeText);
  } catch (error) {
    fail(`${spec.key}: invalid ffprobe JSON (${error.message})`);
    continue;
  }
  const video = probe.streams.find((stream) => stream.codec_type === 'video');
  const audioStream = probe.streams.find((stream) => stream.codec_type === 'audio');
  const audio = Boolean(audioStream);
  if (!video || video.width !== spec.width || video.height !== spec.height) fail(`${spec.key}: probed dimensions mismatch`);
  if (audio !== spec.hasAudio) fail(`${spec.key}: probed hasAudio expected ${spec.hasAudio}, found ${audio}`);
  if (spec.hasAudio && audioStream?.codec_name !== 'aac') fail(`${spec.key}: expected AAC audio, found ${audioStream?.codec_name}`);
  if (spec.kind !== 'image') {
    const durationMs = Math.round(Number(probe.format.duration) * 1000);
    if (!Number.isFinite(durationMs) || Math.abs(durationMs - spec.durationMs) > 50) fail(`${spec.key}: probed duration ${durationMs}ms differs from ${spec.durationMs}ms`);
    if (video?.avg_frame_rate !== '24/1') fail(`${spec.key}: expected 24fps, found ${video?.avg_frame_rate}`);
    const decoded = run('ffmpeg', ['-v', 'error', '-i', filePath, '-map', '0:v:0', '-f', 'null', '-'], `${spec.key} decode`);
    if (decoded !== null) decodedFiles += 1;
  }
  if (spec.kind === 'clip') {
    const clipRgb = sampleAverageRgb(filePath, 500);
    const sourceRgb = sampleAverageRgb(join(demoRoot, 'scene', 'scene-source.mp4'), spec.startMs + 500);
    const channelDelta = clipRgb && sourceRgb ? Math.max(...clipRgb.map((value, index) => Math.abs(value - sourceRgb[index]))) : Infinity;
    if (channelDelta > 8) fail(`${spec.key}: decoded pixels do not match its bound source interval (RGB delta ${channelDelta})`);
  }
  if ((specIndex + 1) % 24 === 0) console.log(`verification progress: ${specIndex + 1}/${expected.length} manifest entries checked`);
}

if (failures.length > 0) {
  console.error(`MEDIA VERIFY FAIL: ${failures.length} issue(s), ${decodedFiles}/${expected.filter((item) => item.kind !== 'image').length} videos decoded`);
  failures.slice(0, 30).forEach((failure) => console.error(`- ${failure}`));
  if (failures.length > 30) console.error(`- ... ${failures.length - 30} additional issue(s)`);
  process.exit(1);
}

console.log(`MEDIA VERIFY PASS: ${expected.length} manifest entries; 132 parameter videos, 3 images, 1 scene source, 10 clips; ${decodedFiles} videos fully decoded`);
