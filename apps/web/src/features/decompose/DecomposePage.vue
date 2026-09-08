<script setup lang="ts">
import { failureMessage } from '../../services/labels';
import { computed, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import type { DemoSplitJob, SplitMode, TimeInterval } from '../../../../../packages/contracts/src/index';
import { useStudioStore } from '../../services/studio';
import MediaPreview from '../../components/MediaPreview.vue';
import DownloadLink from '../../components/DownloadLink.vue';
import Icon from '../../components/Icon.vue';
import SelectMenu from '../../components/SelectMenu.vue';
import UploadDropzone from '../../components/UploadDropzone.vue';
import ClipCarousel from './ClipCarousel.vue';
const studio = useStudioStore(); const router = useRouter();
const sourceId = ref(''); const mode = ref<SplitMode>('sequential'); const busy = ref(false); const error = ref(''); const job = ref<DemoSplitJob>();
const intervals = ref([{ start: 0, end: 15 }]);
const uploadBusy = ref(false); const uploadError = ref('');
const sources = computed(() => studio.assets.filter((asset) => asset.mediaType === 'video'));
const sourceOptions = computed(() => sources.value.map((asset) => ({
  value: asset.id,
  label: `${asset.title}${asset.availability === 'missing' ? ' · 文件需重新选择' : ''}`,
  disabled: asset.availability !== 'available',
})));
const source = computed(() => sources.value.find((asset) => asset.id === sourceId.value));
const metadata = computed(() => studio.snapshot?.mediaMetadata.find((media) => media.id === source.value?.mediaFileId));
const modes: [SplitMode, string, string][] = [['sequential', '顺序拆解', '每 15 秒一段，短尾补至 5 秒'], ['average', '平均拆解', '均匀分布的 15 秒窗口，可重合'], ['scene', '场景检测', '固定测试源的 FFmpeg 场景边界'], ['manual', '手动区间', '拖动起止位置，单段 5–15 秒']];
const activeMode = computed(() => modes.find(([key]) => key === mode.value));
let planningVersion = 0; let sourceSelectionVersion = 0;
function invalidatePlan() { planningVersion += 1; job.value = undefined; error.value = ''; }
function selectMode(value: SplitMode) { mode.value = value; invalidatePlan(); }
function choose(id: string) { sourceSelectionVersion += 1; sourceId.value = id; uploadError.value = ''; invalidatePlan(); }
watch(intervals, invalidatePlan, { deep: true, flush: 'sync' });
function milliseconds(value: number): number {
  const match = /^(-?)(\d+)(?:\.(\d{1,3}))?$/.exec(String(value));
  if (!match) return Number.NaN;
  return (match[1] ? -1 : 1) * (Number(match[2]) * 1000 + Number((match[3] ?? '').padEnd(3, '0')));
}
async function sample() { busy.value = true; const result = await studio.act(() => studio.platform.loadFixture('scene-source')); busy.value = false; if (result.ok) choose(result.value.id); }
async function upload(file: File) {
  if (busy.value) return;
  invalidatePlan(); uploadError.value = ''; busy.value = true; uploadBusy.value = true;
  const version = ++sourceSelectionVersion;
  const result = await studio.act(() => studio.platform.upload(file, file.name));
  busy.value = false; uploadBusy.value = false;
  if (version !== sourceSelectionVersion) return;
  if (result.ok) choose(result.value.id);
  else { uploadError.value = failureMessage(result.error); studio.error = undefined; }
}
async function plan() {
  if (!metadata.value || busy.value) return;
  busy.value = true; error.value = ''; job.value = undefined;
  const version = ++planningVersion;
  const manualIntervals: TimeInterval[] = intervals.value.map(({ start, end }) => ({ startMs: milliseconds(start), endMs: milliseconds(end) }));
  const result = await studio.act(() => studio.platform.split.create({ sourceMediaId: metadata.value!.id, mode: mode.value, ...(mode.value === 'manual' ? { manualIntervals } : {}) }));
  busy.value = false;
  if (version !== planningVersion) return;
  if (result.ok) job.value = result.value as DemoSplitJob; else error.value = failureMessage(result.error);
}
async function reuse(index: number) { if (!job.value) return; const result = await studio.act(() => studio.platform.saveClipAsset(job.value!.id, index)); if (result.ok) { studio.reuse(result.value, 'reference_video'); await router.push('/create'); } }
const format = (interval: TimeInterval) => `${(interval.startMs / 1000).toFixed(3)}–${(interval.endMs / 1000).toFixed(3)} 秒`;
const expanded = (interval: TimeInterval) => job.value?.expandedIntervals?.some((entry) => entry.startMs === interval.startMs && entry.endMs === interval.endMs);
</script>
<template>
  <section class="page">
    <header class="page-header">
      <h1>视频拆解</h1>
    </header>
    <UploadDropzone
      input-label="上传拆解视频"
      kind="video"
      :compact="!!source"
      :busy="uploadBusy"
      :disabled="busy || !studio.ready"
      :error="uploadError"
      @file="upload"
      @invalid="uploadError = $event"
    />
    <div class="source-toolbar">
      <SelectMenu
        :model-value="sourceId"
        label="选择源视频"
        placeholder="从资产库选择视频"
        :options="sourceOptions"
        @update:model-value="choose"
      />
      <button
        :disabled="busy || !studio.ready"
        @click="sample"
      >
        <Icon
          name="play"
          :size="16"
        />使用固定测试视频
      </button>
    </div>
    <div
      v-if="source"
      class="panel source-panel"
    >
      <MediaPreview
        :media-id="source.mediaFileId"
        :demo="source.isDemo"
      />
      <div class="source-info stack">
        <div class="row spread">
          <span class="badge neutral">{{ metadata?.fixtureKey ? '固定演示源' : '上传源素材' }}</span><button
            class="icon-button ghost"
            aria-label="移除文件"
            :disabled="uploadBusy"
            @click="choose('')"
          >
            <Icon
              name="close"
              :size="16"
            />
          </button>
        </div>
        <h2>{{ source.title }}</h2>
        <p
          v-if="metadata"
          class="muted"
        >
          {{ (metadata.durationMs ?? 0) / 1000 }} 秒 · {{ metadata.width }} × {{ metadata.height }} · {{ (metadata.byteSize / 1024 / 1024).toFixed(1) }} MB
        </p>
        <p
          v-if="!metadata?.fixtureKey"
          class="muted"
        >
          仅规划区间，尚未生成切片文件。
        </p>
      </div>
    </div>
    <div
      v-if="source"
      class="panel stack"
    >
      <div class="panel-header">
        <h2>拆解方式</h2>
      </div><div class="mode-grid">
        <button
          v-for="[key, label] in modes"
          :key="key"
          :aria-label="label"
          :class="['mode-option', { active: mode === key }]"
          @click="selectMode(key)"
        >
          <strong>{{ label }}</strong>
        </button>
      </div><span class="sr-only">{{ activeMode?.[2] }}</span>
      <div
        v-if="mode === 'scene'"
        class="notice warning"
      >
        仅支持固定测试视频的场景边界。
      </div>
      <div
        v-if="mode === 'manual'"
        class="stack"
      >
        <div
          v-for="(interval, index) in intervals"
          :key="index"
          class="manual-interval"
        >
          <div class="row spread">
            <h3>区间 {{ index + 1 }}</h3><span class="badge neutral">选择长度 {{ (interval.end - interval.start).toFixed(3) }} 秒</span><button
              v-if="intervals.length > 1"
              class="icon-button"
              :aria-label="`删除区间 ${index + 1}`"
              @click="intervals.splice(index,1)"
            >
              <Icon
                name="close"
                :size="16"
              />
            </button>
          </div><div class="two-columns">
            <label class="field">开始时间（秒）<input
              v-model.number="interval.start"
              type="number"
              step="0.001"
              aria-label="开始时间（秒）"
            /><input
              v-model.number="interval.start"
              type="range"
              min="0"
              :max="(metadata?.durationMs ?? 32000) / 1000"
              step="0.001"
              aria-label="拖动开始位置"
            /></label><label class="field">结束时间（秒）<input
              v-model.number="interval.end"
              type="number"
              step="0.001"
              aria-label="结束时间（秒）"
            /><input
              v-model.number="interval.end"
              type="range"
              min="0"
              :max="(metadata?.durationMs ?? 32000) / 1000"
              step="0.001"
              aria-label="拖动结束位置"
            /></label>
          </div>
        </div><button
          class="ghost"
          @click="intervals.push({ start: 0, end: 5 })"
        >
          <Icon
            name="plus"
            :size="16"
          />新增区间
        </button>
      </div>
      <div class="form-actions">
        <button
          class="primary"
          :disabled="!metadata || busy"
          @click="plan"
        >
          <Icon
            name="decompose"
            :size="18"
          />{{ busy ? '处理区间中…' : '规划区间' }}
        </button>
      </div><p
        v-if="error"
        class="notice error"
        role="alert"
      >
        {{ error }}
      </p>
    </div>
    <section
      v-if="job"
      class="stack"
    >
      <div class="panel-header">
        <h2>区间列表 <span class="muted">/ {{ job.intervals.length }}</span></h2>
      </div><div
        class="timeline"
        aria-label="已规划的视频区间"
      >
        <div
          v-for="(clip,index) in job.intervals"
          :key="index"
          class="timeline-track"
        >
          <span :style="{ left: `${clip.startMs / job.sourceDurationMs * 100}%`, width: `${(clip.endMs - clip.startMs) / job.sourceDurationMs * 100}%` }">{{ index + 1 }}</span>
        </div><div class="row spread muted">
          <small>0:00</small><small>{{ job.sourceDurationMs / 1000 }} 秒</small>
        </div>
      </div><details
        v-if="job.sceneRanges"
        class="panel scene-boundaries"
      >
        <summary>场景边界</summary><p
          v-for="(range,index) in job.sceneRanges"
          :key="index"
        >
          {{ format(range) }}
        </p>
      </details><div class="card-grid">
        <article
          v-for="(clip,index) in job.intervals"
          :key="index"
          class="panel clip-card"
        >
          <div class="row spread">
            <strong>片段 {{ String(index + 1).padStart(2,'0') }}</strong><span class="badge neutral">{{ (clip.endMs - clip.startMs) / 1000 }} 秒</span>
          </div><div
            v-if="!clip.mediaFileId"
            class="clip-unrendered"
          >
            <Icon
              name="decompose"
              :size="30"
            /><span>尚未生成切片文件</span>
          </div><h3>{{ format(clip) }}</h3><small
            v-if="expanded(clip)"
            class="warning-text"
          >为满足参考长度扩展</small><div
            v-if="clip.mediaFileId"
            class="row"
          >
            <DownloadLink
              :media-id="clip.mediaFileId"
              :filename="`演示切片-${index + 1}.mp4`"
              :label="`下载切片 ${index + 1}`"
            /><button
              class="small-button"
              @click="reuse(index)"
            >
              用于创作
            </button>
          </div>
        </article>
      </div>
      <ClipCarousel
        :job="job"
        :source-media-id="job.sourceMediaId"
        :source-demo="!!source?.isDemo"
      />
    </section>
    <div
      v-if="!source"
      class="panel empty-state tool-empty"
    >
      <span class="empty-icon"><Icon
        name="decompose"
        :size="32"
      /></span>
      <h3>暂无拆解内容</h3>
    </div>
  </section>
</template>
<style scoped>
.source-panel{display:grid;grid-template-columns:minmax(0,.85fr) minmax(0,1.15fr);gap:24px}.source-panel>.preview{height:220px}.source-info{align-content:center}.source-info h2{overflow-wrap:anywhere}.mode-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}.mode-option{padding:14px;background:var(--input)}.mode-option.active{border-color:var(--accent);background:var(--accent-soft)}.manual-interval{background:var(--input);border-radius:10px;padding:16px;display:grid;gap:16px}.timeline{background:var(--panel);border:1px solid var(--border);border-radius:12px;padding:16px}.timeline-track{height:22px;position:relative;background:var(--input);margin-bottom:5px;border-radius:4px}.timeline-track span{position:absolute;top:0;bottom:0;display:flex;align-items:center;justify-content:center;background:var(--accent-soft);border:1px solid var(--accent);font-size:12px;border-radius:4px}.scene-boundaries{padding:14px 16px}.scene-boundaries summary{cursor:pointer;font-weight:600}.scene-boundaries p{margin:10px 0 0;color:var(--muted);font-variant-numeric:tabular-nums}.clip-card{display:grid;gap:12px;padding:18px}.clip-unrendered{display:flex;align-items:center;gap:8px;color:var(--muted);font-size:12px}.clip-unrendered svg{width:18px;height:18px}.warning-text{color:var(--warning)}@media(max-width:900px){.source-panel{grid-template-columns:1fr}.mode-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
</style>
