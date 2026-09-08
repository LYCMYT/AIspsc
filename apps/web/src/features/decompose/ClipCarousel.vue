<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import type { DemoSplitJob, TimeInterval } from '../../../../../packages/contracts/src/index';
import Icon from '../../components/Icon.vue';
import { useStudioStore } from '../../services/studio';
import { extractVideoFrames, revokeVideoFrames, type VideoFramePreview } from './videoFrames';

const props = defineProps<{
  job: DemoSplitJob;
  sourceMediaId: string;
  sourceDemo: boolean;
}>();

const studio = useStudioStore();
const selectedIndex = ref(0);
const frames = ref<VideoFramePreview[]>([]);
const loading = ref(false);
const loadError = ref(false);
const playerUrl = ref('');
const playerUsesClip = ref(false);
const currentSourceTimeMs = ref(0);
const retryVersion = ref(0);
const player = ref<HTMLVideoElement>();
let activeController: AbortController | undefined;
let pendingSeekSourceTimeMs: number | undefined;

const selected = computed(() => props.job.intervals[selectedIndex.value] ?? props.job.intervals[0]);
const playerCaption = computed(() => {
  if (selected.value?.mediaFileId && playerUsesClip.value) return '演示视频 · 已生成切片';
  if (props.sourceDemo) return '演示源视频区间预览 · 未生成切片文件';
  return '源视频区间预览 · 未生成切片文件';
});

function formatInterval(interval: TimeInterval): string {
  return `${(interval.startMs / 1000).toFixed(3)}–${(interval.endMs / 1000).toFixed(3)} 秒`;
}

function formatClock(timeMs: number): string {
  const safeTimeMs = Math.max(0, Math.round(timeMs));
  const minutes = Math.floor(safeTimeMs / 60_000);
  const seconds = Math.floor((safeTimeMs % 60_000) / 1000);
  const milliseconds = safeTimeMs % 1000;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(milliseconds).padStart(3, '0')}`;
}

function clearFrames(): void {
  revokeVideoFrames(frames.value);
  frames.value = [];
}

function clearPlayer(): void {
  const oldUrl = playerUrl.value;
  playerUrl.value = '';
  if (oldUrl) URL.revokeObjectURL(oldUrl);
}

function choose(index: number): void {
  if (index < 0 || index >= props.job.intervals.length || index === selectedIndex.value) return;
  selectedIndex.value = index;
}

function initializePlayer(): void {
  const video = player.value;
  const interval = selected.value;
  if (!video || !interval || video.readyState < HTMLMediaElement.HAVE_METADATA) return;
  if (pendingSeekSourceTimeMs !== undefined) {
    const requestedTimeMs = pendingSeekSourceTimeMs;
    pendingSeekSourceTimeMs = undefined;
    seekToFrame(requestedTimeMs);
    return;
  }
  video.currentTime = playerUsesClip.value ? 0 : interval.startMs / 1000;
  currentSourceTimeMs.value = interval.startMs;
}

function updateCurrentTime(): void {
  const video = player.value;
  const interval = selected.value;
  if (!video || !interval) return;
  if (!playerUsesClip.value) {
    const sourceTimeMs = video.currentTime * 1000;
    if (sourceTimeMs < interval.startMs) {
      video.pause();
      video.currentTime = interval.startMs / 1000;
    } else if (sourceTimeMs >= interval.endMs) {
      video.pause();
      video.currentTime = Math.max(interval.startMs, interval.endMs - 40) / 1000;
    }
  }
  const absoluteMs = playerUsesClip.value
    ? interval.startMs + video.currentTime * 1000
    : video.currentTime * 1000;
  currentSourceTimeMs.value = Math.min(interval.endMs, Math.max(interval.startMs, Math.round(absoluteMs)));
}

function guardPlayback(): void {
  const video = player.value;
  const interval = selected.value;
  if (!video || !interval) return;
  const outOfRange = playerUsesClip.value
    ? video.currentTime * 1000 >= interval.endMs - interval.startMs
    : video.currentTime * 1000 < interval.startMs || video.currentTime * 1000 >= interval.endMs;
  if (outOfRange) video.currentTime = playerUsesClip.value ? 0 : interval.startMs / 1000;
}

function seekToFrame(sourceTimeMs: number): void {
  const video = player.value;
  const interval = selected.value;
  if (!video || !interval || video.readyState < HTMLMediaElement.HAVE_METADATA) {
    pendingSeekSourceTimeMs = sourceTimeMs;
    return;
  }
  const requestedSeconds = playerUsesClip.value
    ? (sourceTimeMs - interval.startMs) / 1000
    : sourceTimeMs / 1000;
  video.currentTime = Math.min(Math.max(0, video.duration - 0.001), Math.max(0, requestedSeconds));
  currentSourceTimeMs.value = sourceTimeMs;
}

watch(() => [props.sourceMediaId, props.job.id], () => { selectedIndex.value = 0; }, { flush: 'sync' });

watch(() => {
  const interval = selected.value;
  return [props.sourceMediaId, props.job.id, selectedIndex.value, interval?.startMs, interval?.endMs, interval?.mediaFileId, retryVersion.value] as const;
}, async (_key, _oldKey, onCleanup) => {
  activeController?.abort();
  const controller = new AbortController();
  activeController = controller;
  onCleanup(() => controller.abort());
  clearFrames();
  clearPlayer();
  loading.value = true;
  loadError.value = false;
  playerUsesClip.value = false;
  pendingSeekSourceTimeMs = undefined;
  const interval = selected.value;
  currentSourceTimeMs.value = interval?.startMs ?? 0;
  if (!interval) { loading.value = false; loadError.value = true; return; }

  try {
    const sourceResult = await studio.platform.media.get(props.sourceMediaId);
    if (controller.signal.aborted) return;
    if (!sourceResult.ok) { loadError.value = true; return; }

    let playbackBlob = sourceResult.value.blob;
    if (interval.mediaFileId) {
      const clipResult = await studio.platform.media.get(interval.mediaFileId);
      if (controller.signal.aborted) return;
      if (clipResult.ok) { playbackBlob = clipResult.value.blob; playerUsesClip.value = true; }
    }
    const nextPlayerUrl = URL.createObjectURL(playbackBlob);
    if (controller.signal.aborted) { URL.revokeObjectURL(nextPlayerUrl); return; }
    playerUrl.value = nextPlayerUrl;

    const nextFrames = await extractVideoFrames(sourceResult.value.blob, interval, controller.signal);
    if (controller.signal.aborted) { revokeVideoFrames(nextFrames); return; }
    frames.value = nextFrames;
  } catch (error) {
    if (!controller.signal.aborted && !(error instanceof DOMException && error.name === 'AbortError')) loadError.value = true;
  } finally {
    if (!controller.signal.aborted) loading.value = false;
  }
}, { immediate: true, flush: 'sync' });

onBeforeUnmount(() => {
  activeController?.abort();
  clearFrames();
  clearPlayer();
});
</script>

<template>
  <section
    class="panel clip-carousel"
    aria-label="视频片段轮播"
  >
    <div class="carousel-heading">
      <div>
        <h2>片段 {{ selectedIndex + 1 }} <span class="muted">/ {{ job.intervals.length }}</span></h2>
      </div>
      <div class="row carousel-navigation">
        <button
          class="icon-button ghost"
          aria-label="上一个片段"
          :disabled="selectedIndex === 0"
          @click="choose(selectedIndex - 1)"
        >
          <Icon
            name="chevron"
            :size="18"
          />
        </button>
        <button
          class="icon-button ghost next-button"
          aria-label="下一个片段"
          :disabled="selectedIndex === job.intervals.length - 1"
          @click="choose(selectedIndex + 1)"
        >
          <Icon
            name="chevron"
            :size="18"
          />
        </button>
      </div>
    </div>

    <div class="carousel-main">
      <div class="carousel-player">
        <video
          v-if="playerUrl"
          ref="player"
          :src="playerUrl"
          controls
          preload="metadata"
          playsinline
          :aria-label="`片段 ${selectedIndex + 1} 视频`"
          @loadedmetadata="initializePlayer"
          @play="guardPlayback"
          @timeupdate="updateCurrentTime"
          @seeked="updateCurrentTime"
        />
        <p
          v-else
          class="muted player-loading"
        >
          {{ loadError ? '无法读取视频画面' : '正在读取视频…' }}
        </p>
        <span class="badge demo player-badge">{{ playerCaption }}</span>
      </div>
      <div class="carousel-details">
        <div>
          <span class="muted">当前区间</span>
          <strong>{{ selected ? formatInterval(selected) : '—' }}</strong>
        </div>
        <div>
          <span class="muted">源视频时间</span>
          <strong
            class="mono"
            data-testid="carousel-current-time"
          >{{ formatClock(currentSourceTimeMs) }}</strong>
        </div>
      </div>
    </div>

    <div
      class="clip-selector"
      aria-label="选择片段"
    >
      <button
        v-for="(interval, index) in job.intervals"
        :key="`${interval.startMs}-${interval.endMs}`"
        :class="['clip-selector-button', { active: selectedIndex === index }]"
        :aria-label="`查看片段 ${index + 1}`"
        :aria-current="selectedIndex === index ? 'true' : undefined"
        @click="choose(index)"
      >
        <span>{{ String(index + 1).padStart(2, '0') }}</span>
        <small>{{ formatInterval(interval) }}</small>
      </button>
    </div>

    <section
      class="frame-region"
      aria-label="片段帧预览"
    >
      <div class="row spread">
        <h3>片段帧预览</h3>
        <span
          v-if="loading"
          class="muted"
          role="status"
        >正在提取画面…</span>
      </div>
      <div
        v-if="loadError"
        class="notice error frame-error"
        role="alert"
      >
        <span>无法读取视频画面</span>
        <button
          class="small-button"
          aria-label="重试提取画面"
          @click="retryVersion += 1"
        >
          <Icon
            name="retry"
            :size="15"
          />重试
        </button>
      </div>
      <div class="frame-strip">
        <button
          v-for="(frame, index) in frames"
          :key="frame.url"
          class="frame-button"
          :aria-label="`定位到帧 ${index + 1}`"
          @click="seekToFrame(frame.sourceTimeMs)"
        >
          <img
            :src="frame.url"
            :alt="`片段 ${selectedIndex + 1} 帧 ${index + 1}`"
            :data-source-time-ms="frame.sourceTimeMs"
          />
          <span>取帧位置 {{ formatClock(frame.sourceTimeMs) }}</span>
        </button>
      </div>
    </section>
  </section>
</template>

<style scoped>
.clip-carousel{display:grid;gap:16px;padding:20px}.carousel-heading{display:flex;align-items:center;justify-content:space-between;gap:16px}.carousel-heading h2 span{font-size:14px;font-weight:400}.carousel-navigation{flex-wrap:nowrap}.carousel-navigation .icon-button:first-child :deep(svg){transform:rotate(180deg)}.next-button :deep(svg){transform:none}.carousel-main{display:grid;grid-template-columns:minmax(0,1.75fr) minmax(210px,.6fr);gap:16px;align-items:stretch;min-width:0}.carousel-main>*{min-width:0}.carousel-player{position:relative;display:grid;grid-template-rows:minmax(0,1fr);place-items:center;min-width:0;min-height:340px;max-height:470px;overflow:hidden;border:1px solid var(--border);border-radius:12px;background:var(--input)}.carousel-player video{display:block;width:100%;height:100%;min-width:0;min-height:0;max-height:470px;object-fit:contain;background:var(--bg)}.player-loading{align-self:center}.player-badge{position:absolute;top:12px;left:12px;pointer-events:none;background:var(--bg)}.carousel-details{display:grid;align-content:center;gap:18px;padding:20px;border:1px solid var(--border);border-radius:12px;background:var(--input)}.carousel-details>div{display:grid;gap:6px}.carousel-details strong{font-size:16px;font-variant-numeric:tabular-nums}.clip-selector{display:flex;gap:8px;overflow-x:auto;padding:2px 2px 6px}.clip-selector-button{flex:1 0 168px;justify-content:flex-start;min-height:54px;text-align:left;background:var(--input)}.clip-selector-button>span{display:grid;place-items:center;width:28px;height:28px;border-radius:7px;background:var(--panel-raised);color:var(--accent-text);font-size:12px}.clip-selector-button small{color:var(--muted);font-variant-numeric:tabular-nums}.clip-selector-button.active{border-color:var(--accent);background:var(--accent-soft)}.frame-region{display:grid;gap:12px;padding-top:16px;border-top:1px solid var(--border)}.frame-strip{display:flex;gap:10px;overflow-x:auto;padding:2px 2px 8px;min-height:126px}.frame-button{position:relative;display:block;flex:1 0 150px;min-height:116px;padding:0;overflow:hidden;border-radius:10px;background:var(--input)}.frame-button img{display:block;width:100%;height:114px;object-fit:cover}.frame-button span{position:absolute;inset:auto 0 0;padding:20px 8px 8px;background:linear-gradient(transparent,color-mix(in srgb,var(--bg) 92%,transparent));font-size:12px;text-align:left;color:var(--text);font-variant-numeric:tabular-nums}.frame-error{display:flex;align-items:center;justify-content:space-between;gap:16px}.frame-error button{color:var(--text);background:var(--panel-raised)}@media(max-width:1000px){.carousel-main{grid-template-columns:1fr}.carousel-player{min-height:330px}.carousel-details{grid-template-columns:repeat(2,minmax(0,1fr));padding:16px}}@media(max-width:700px){.clip-carousel{padding:16px}.carousel-heading{align-items:center}.carousel-main{gap:12px}.carousel-player{min-height:280px}.carousel-details{grid-template-columns:1fr;gap:14px}.frame-button{flex-basis:145px}}
</style>
