import type { TimeInterval } from '../../../../../packages/contracts/src/index';

export interface VideoFramePreview {
  sourceTimeMs: number;
  url: string;
}

const MEDIA_TIMEOUT_MS = 10_000;

function abortFailure(): DOMException {
  return new DOMException('Frame extraction cancelled', 'AbortError');
}

// Seek completion can precede presentation of the newly decoded surface.
// Subscribe before loading/seeking so Canvas cannot read the preceding frame.
function waitForPresentedFrame(video: HTMLVideoElement, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(abortFailure()); return; }
    let callbackId: number | undefined;
    let animationId: number | undefined;
    const timeout = window.setTimeout(() => finish(new Error('Timed out waiting for video frame')), MEDIA_TIMEOUT_MS);
    const onAbort = () => finish(abortFailure());
    const onError = () => finish(new Error('Video decoding failed'));
    function finish(error?: Error | DOMException) {
      window.clearTimeout(timeout);
      signal.removeEventListener('abort', onAbort);
      video.removeEventListener('error', onError);
      if (callbackId !== undefined) video.cancelVideoFrameCallback(callbackId);
      if (animationId !== undefined) window.cancelAnimationFrame(animationId);
      if (error) reject(error); else resolve();
    }
    signal.addEventListener('abort', onAbort, { once: true });
    video.addEventListener('error', onError, { once: true });
    if (typeof video.requestVideoFrameCallback === 'function') {
      callbackId = video.requestVideoFrameCallback(() => finish());
    } else {
      animationId = window.requestAnimationFrame(() => {
        animationId = window.requestAnimationFrame(() => finish());
      });
    }
  });
}

function waitForMediaEvent(
  video: HTMLVideoElement,
  eventName: 'loadedmetadata' | 'loadeddata' | 'seeked',
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(abortFailure()); return; }
    const timeout = window.setTimeout(() => finish(new Error(`Timed out waiting for ${eventName}`)), MEDIA_TIMEOUT_MS);
    const onAbort = () => finish(abortFailure());
    const onError = () => finish(new Error('Video decoding failed'));
    const onEvent = () => finish();
    function finish(error?: Error | DOMException) {
      window.clearTimeout(timeout);
      signal.removeEventListener('abort', onAbort);
      video.removeEventListener('error', onError);
      video.removeEventListener(eventName, onEvent);
      if (error) reject(error); else resolve();
    }
    signal.addEventListener('abort', onAbort, { once: true });
    video.addEventListener('error', onError, { once: true });
    video.addEventListener(eventName, onEvent, { once: true });
  });
}

function frameTimes(interval: TimeInterval, count: number): number[] {
  const durationMs = interval.endMs - interval.startMs;
  if (!Number.isFinite(durationMs) || durationMs <= 0 || count < 1) throw new Error('Invalid frame interval');
  const lastTimeMs = Math.max(interval.startMs, interval.endMs - Math.min(40, durationMs / 2));
  if (count === 1) return [Math.round(interval.startMs)];
  return Array.from({ length: count }, (_, index) => Math.round(
    interval.startMs + ((lastTimeMs - interval.startMs) * index) / (count - 1),
  ));
}

async function seek(video: HTMLVideoElement, timeMs: number, signal: AbortSignal): Promise<void> {
  const maximum = Math.max(0, video.duration - 0.001);
  const target = Math.min(maximum, Math.max(0, timeMs / 1000));
  if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && Math.abs(video.currentTime - target) < 0.001) return;
  const ready = waitForMediaEvent(video, 'seeked', signal);
  const presented = typeof video.requestVideoFrameCallback === 'function' ? waitForPresentedFrame(video, signal) : undefined;
  video.currentTime = target;
  await Promise.all([ready, presented]);
  if (!presented) await waitForPresentedFrame(video, signal);
}

function canvasBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob); else reject(new Error('Unable to encode video frame'));
    }, 'image/jpeg', 0.86);
  });
}

export function revokeVideoFrames(frames: readonly VideoFramePreview[]): void {
  for (const frame of frames) URL.revokeObjectURL(frame.url);
}

export async function extractVideoFrames(
  sourceBlob: Blob,
  interval: TimeInterval,
  signal: AbortSignal,
  count = 5,
): Promise<VideoFramePreview[]> {
  const localController = new AbortController();
  const abortLocal = () => localController.abort();
  if (signal.aborted) abortLocal(); else signal.addEventListener('abort', abortLocal, { once: true });
  let sourceUrl = '';
  const video = document.createElement('video');
  const frames: VideoFramePreview[] = [];
  video.muted = true;
  video.preload = 'auto';
  video.playsInline = true;

  try {
    if (localController.signal.aborted) throw abortFailure();
    sourceUrl = URL.createObjectURL(sourceBlob);
    const metadataReady = waitForMediaEvent(video, 'loadedmetadata', localController.signal);
    const firstFrameReady = waitForMediaEvent(video, 'loadeddata', localController.signal);
    const firstPresented = typeof video.requestVideoFrameCallback === 'function' ? waitForPresentedFrame(video, localController.signal) : undefined;
    video.src = sourceUrl;
    video.load();
    await Promise.all([metadataReady, firstFrameReady, firstPresented]);
    if (!firstPresented) await waitForPresentedFrame(video, localController.signal);
    if (!Number.isFinite(video.duration) || video.videoWidth < 1 || video.videoHeight < 1) throw new Error('Invalid video metadata');

    const scale = Math.min(1, 320 / video.videoWidth);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
    const context = canvas.getContext('2d', { alpha: false, willReadFrequently: false });
    if (!context) throw new Error('Canvas is unavailable');

    for (const sourceTimeMs of frameTimes(interval, count)) {
      await seek(video, sourceTimeMs, localController.signal);
      if (localController.signal.aborted) throw abortFailure();
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      const blob = await canvasBlob(canvas);
      if (localController.signal.aborted) throw abortFailure();
      frames.push({ sourceTimeMs, url: URL.createObjectURL(blob) });
    }
    return frames;
  } catch (error) {
    revokeVideoFrames(frames);
    throw error;
  } finally {
    localController.abort();
    signal.removeEventListener('abort', abortLocal);
    video.pause();
    video.removeAttribute('src');
    video.load();
    if (sourceUrl) URL.revokeObjectURL(sourceUrl);
  }
}
