import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const demoRoot = resolve(scriptDirectory, '../public/demo');
const manifestPath = join(demoRoot, 'MEDIA_MANIFEST.json');
const ratios = {
  '9x16': { '720p': [720, 1280], '1080p': [1080, 1920] },
  '16x9': { '720p': [1280, 720], '1080p': [1920, 1080] },
  '1x1': { '720p': [720, 720], '1080p': [1080, 1080] },
};
const entries = [];
let produced = 0;
let reused = 0;

for (const directory of ['videos', 'images', 'scene', 'clips']) mkdirSync(join(demoRoot, directory), { recursive: true });

function run(command, args, label) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 300_000, windowsHide: true });
  if (result.error || result.status !== 0) {
    throw new Error(`${label} failed: ${result.error?.message ?? result.stderr.trim() ?? `exit ${result.status}`}`);
  }
  return result.stdout;
}

function probe(path) {
  return JSON.parse(run('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', path], `probe ${path}`));
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

function isValid(path, { width, height, durationMs, hasAudio, image = false, sceneCutMs, sourcePath, startMs }) {
  try {
    const data = probe(path);
    const video = data.streams.find((stream) => stream.codec_type === 'video');
    if (!video || video.width !== width || video.height !== height) return false;
    if (data.streams.some((stream) => stream.codec_type === 'audio') !== hasAudio) return false;
    if (!image) {
      const measuredMs = Math.round(Number(data.format.duration) * 1000);
      if (!Number.isFinite(measuredMs) || Math.abs(measuredMs - durationMs) > 50 || video.avg_frame_rate !== '24/1') return false;
    }
    if (sceneCutMs && JSON.stringify(detectSceneCutMs(path)) !== JSON.stringify(sceneCutMs)) return false;
    if (sourcePath) {
      const clipRgb = sampleAverageRgb(path, 500);
      const sourceRgb = sampleAverageRgb(sourcePath, startMs + 500);
      if (!clipRgb || !sourceRgb || Math.max(...clipRgb.map((value, index) => Math.abs(value - sourceRgb[index]))) > 8) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function ensure(path, spec, create) {
  if (!spec.force && isValid(path, spec)) {
    reused += 1;
    return false;
  }
  create();
  if (!isValid(path, spec)) throw new Error(`generated file failed probe policy: ${path}`);
  produced += 1;
  const total = produced + reused;
  if (total % 12 === 0) console.log(`generation progress: ${total}/146 files prepared (${produced} generated, ${reused} reused)`);
  return true;
}

function visualFilter(accent = '6374FF') {
  return [
    `drawbox=x=iw*0.22:y=ih*0.22:w=iw*0.56:h=ih*0.56:color=0x${accent}@0.88:t=fill`,
    'drawbox=x=mod(t*180\\,iw+iw*0.2)-iw*0.2:y=ih*0.1:w=iw*0.18:h=ih*0.8:color=0xF5F7FF@0.55:t=fill',
    'drawbox=x=iw*0.1:y=mod(t*110\\,ih+ih*0.08)-ih*0.08:w=iw*0.8:h=ih*0.05:color=0xFFB454@0.92:t=fill',
    'format=yuv420p',
  ].join(',');
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function measuredEntry({ key, path, kind, fixtureKey = key, ...extra }) {
  const data = probe(path);
  const video = data.streams.find((stream) => stream.codec_type === 'video');
  const isImage = kind === 'image';
  return {
    key,
    path: relative(demoRoot, path).split(sep).join('/'),
    kind,
    sha256: sha256(path),
    source: 'self-generated',
    mime: isImage ? 'image/png' : 'video/mp4',
    ...(isImage ? {} : { durationMs: Math.round(Number(data.format.duration) * 1000) }),
    width: video.width,
    height: video.height,
    hasAudio: data.streams.some((stream) => stream.codec_type === 'audio'),
    fixtureKey,
    ...extra,
  };
}

for (const [ratio, resolutions] of Object.entries(ratios)) {
  for (const [resolution, [width, height]] of Object.entries(resolutions)) {
    const masterKey = `video-15-${ratio}-${resolution}-silent`;
    const masterPath = join(demoRoot, 'videos', `${masterKey}.mp4`);
    ensure(masterPath, { width, height, durationMs: 15000, hasAudio: false }, () => {
      run('ffmpeg', [
        '-y', '-v', 'error', '-f', 'lavfi', '-i', `color=c=0x101728:s=${width}x${height}:r=24:d=15`,
        '-vf', visualFilter(), '-frames:v', '360', '-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '40',
        '-g', '24', '-keyint_min', '24', '-sc_threshold', '0', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', masterPath,
      ], masterKey);
    });

    for (let duration = 5; duration <= 15; duration += 1) {
      const silentKey = `video-${duration}-${ratio}-${resolution}-silent`;
      const silentPath = join(demoRoot, 'videos', `${silentKey}.mp4`);
      if (duration !== 15) {
        ensure(silentPath, { width, height, durationMs: duration * 1000, hasAudio: false }, () => {
          run('ffmpeg', ['-y', '-v', 'error', '-i', masterPath, '-t', String(duration), '-map', '0:v:0', '-c:v', 'copy', '-an', '-movflags', '+faststart', silentPath], silentKey);
        });
      }
      entries.push(measuredEntry({ key: silentKey, path: silentPath, kind: 'video' }));

      const audioKey = `video-${duration}-${ratio}-${resolution}-audio`;
      const audioPath = join(demoRoot, 'videos', `${audioKey}.mp4`);
      ensure(audioPath, { width, height, durationMs: duration * 1000, hasAudio: true }, () => {
        run('ffmpeg', [
          '-y', '-v', 'error', '-i', silentPath, '-f', 'lavfi', '-i', 'sine=frequency=220:sample_rate=48000',
          '-t', String(duration), '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '32k',
          '-filter:a', 'volume=0.04', '-movflags', '+faststart', audioPath,
        ], audioKey);
      });
      entries.push(measuredEntry({ key: audioKey, path: audioPath, kind: 'video' }));
    }
  }
}

const images = [
  ['image-9x16-1024', 576, 1024],
  ['image-16x9-1024', 1024, 576],
  ['image-1x1-1024', 1024, 1024],
];
for (const [key, width, height] of images) {
  const path = join(demoRoot, 'images', `${key}.png`);
  ensure(path, { width, height, hasAudio: false, image: true }, () => {
    run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', `color=c=0x101728:s=${width}x${height}:r=1:d=1`, '-vf', visualFilter('31D0AA'), '-frames:v', '1', '-update', '1', path], key);
  });
  entries.push(measuredEntry({ key, path, kind: 'image' }));
}

const scenePath = join(demoRoot, 'scene', 'scene-source.mp4');
const sceneRegenerated = ensure(scenePath, { width: 720, height: 1280, durationMs: 32000, hasAudio: false, sceneCutMs: [3000, 12000, 20000] }, () => {
  const colors = ['black', 'white', 'red', 'cyan'];
  const durations = [3, 9, 8, 12];
  const args = ['-y', '-v', 'error'];
  colors.forEach((color, index) => args.push('-f', 'lavfi', '-i', `color=c=${color}:s=720x1280:r=24:d=${durations[index]}`));
  const chains = colors.map((_, index) => `[${index}:v]${visualFilter(['6374FF', 'E85D75', '31D0AA', 'FFB454'][index])}[v${index}]`);
  args.push(
    '-filter_complex', `${chains.join(';')};[v0][v1][v2][v3]concat=n=4:v=1:a=0[v]`,
    '-map', '[v]', '-frames:v', '768', '-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '38',
    '-g', '24', '-keyint_min', '24', '-sc_threshold', '0', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', scenePath,
  );
  run('ffmpeg', args, 'scene-source');
});
const sceneSha256 = sha256(scenePath);
entries.push(measuredEntry({ key: 'scene-source', path: scenePath, kind: 'source', sceneCutMs: [3000, 12000, 20000] }));

const clipGroups = {
  sequential: [[0, 15000], [15000, 30000], [27000, 32000]],
  average: [[0, 15000], [8500, 23500], [17000, 32000]],
  scene: [[0, 5000], [3000, 12000], [12000, 20000], [20000, 32000]],
};
for (const [mode, ranges] of Object.entries(clipGroups)) {
  ranges.forEach(([startMs, endMs], index) => {
    const key = `scene-${mode}-${index + 1}`;
    const path = join(demoRoot, 'clips', `${key}.mp4`);
    ensure(path, {
      width: 720, height: 1280, durationMs: endMs - startMs, hasAudio: false,
      force: sceneRegenerated, sourcePath: scenePath, startMs,
    }, () => {
      run('ffmpeg', [
        '-y', '-v', 'error', '-ss', (startMs / 1000).toFixed(3), '-i', scenePath, '-t', ((endMs - startMs) / 1000).toFixed(3),
        '-map', '0:v:0', '-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '38', '-r', '24',
        '-g', '24', '-keyint_min', '24', '-sc_threshold', '0', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', path,
      ], key);
    });
    entries.push(measuredEntry({ key, path, kind: 'clip', sourceSha256: sceneSha256, startMs, endMs }));
  });
}

entries.sort((left, right) => left.key.localeCompare(right.key));
const manifest = {
  version: 1,
  generatedBy: 'apps/web/scripts/generate-demo-media.mjs',
  policy: {
    videoDurationSeconds: { min: 5, max: 15, integerOnly: true },
    videoRatios: ['9:16', '16:9', '1:1'],
    videoResolutions: ['720p', '1080p'],
    framesPerSecond: 24,
    imageResolution: 'long-edge-1024',
    provenance: 'local geometric fixtures; no commercial source material',
  },
  files: entries,
};
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
console.log(`MEDIA GENERATION PASS: ${entries.length} entries written (${produced} generated, ${reused} reused)`);
