<script setup lang="ts">
import { computed, ref, watch } from 'vue';

type UploadKind = 'video' | 'media';

const props = withDefaults(defineProps<{
  inputLabel: string;
  kind: UploadKind;
  busy?: boolean;
  disabled?: boolean;
  compact?: boolean;
  error?: string;
}>(), {
  busy: false,
  disabled: false,
  compact: false,
  error: '',
});

const emit = defineEmits<{
  file: [file: File];
  invalid: [message: string];
}>();

const MAX_FILE_SIZE = 200 * 1024 * 1024;
const VIDEO_TYPES = new Set(['video/mp4', 'video/webm']);
const MEDIA_TYPES = new Set([...VIDEO_TYPES, 'image/png', 'image/jpeg', 'image/webp']);

const input = ref<HTMLInputElement>();
const dragDepth = ref(0);
const clientError = ref('');

const inactive = computed(() => props.disabled || props.busy);
const dragging = computed(() => dragDepth.value > 0 && !inactive.value);
const acceptedTypes = computed(() => props.kind === 'video'
  ? 'video/mp4,video/webm'
  : 'image/png,image/jpeg,image/webp,video/mp4,video/webm');
const heading = computed(() => props.kind === 'video'
  ? '点击或拖拽视频到此处'
  : '点击或拖拽素材到此处');
const hint = computed(() => props.kind === 'video'
  ? 'MP4 / WebM · 最大 200 MB · 至少 5 秒'
  : 'PNG / JPG / WebP / MP4 / WebM · 最大 200 MB');
const actionLabel = computed(() => props.compact
  ? '替换文件'
  : props.kind === 'video' ? '上传视频' : '上传素材');
const visibleError = computed(() => clientError.value || props.error);

watch(inactive, (value) => {
  if (value) dragDepth.value = 0;
});

watch(() => props.error, (value) => {
  if (!value) clientError.value = '';
});

function openPicker(): void {
  if (!inactive.value) input.value?.click();
}

function onZoneClick(event: MouseEvent): void {
  const target = event.target;
  if (inactive.value || !(target instanceof Element) || target.closest('button, input')) return;
  openPicker();
}

function reject(message: string): void {
  clientError.value = message;
  emit('invalid', message);
}

function validate(files: File[]): void {
  if (inactive.value || files.length === 0) return;
  if (files.length !== 1) {
    reject('单次请选择一个文件');
    return;
  }

  const file = files[0]!;
  if (file.size === 0) {
    reject('文件不能为空');
    return;
  }
  if (file.size > MAX_FILE_SIZE) {
    reject('文件不能超过 200 MB');
    return;
  }

  const supportedTypes = props.kind === 'video' ? VIDEO_TYPES : MEDIA_TYPES;
  if (!supportedTypes.has(file.type.toLowerCase())) {
    reject('不支持此文件格式');
    return;
  }

  clientError.value = '';
  emit('file', file);
}

function onInputChange(event: Event): void {
  const target = event.target as HTMLInputElement;
  const files = Array.from(target.files ?? []);
  target.value = '';
  validate(files);
}

function onDragEnter(event: DragEvent): void {
  event.preventDefault();
  if (!inactive.value) dragDepth.value += 1;
}

function onDragOver(event: DragEvent): void {
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = inactive.value ? 'none' : 'copy';
}

function onDragLeave(event: DragEvent): void {
  event.preventDefault();
  if (dragDepth.value > 0) dragDepth.value -= 1;
}

function onDrop(event: DragEvent): void {
  event.preventDefault();
  dragDepth.value = 0;
  if (!inactive.value) validate(Array.from(event.dataTransfer?.files ?? []));
}
</script>

<template>
  <div
    data-testid="upload-dropzone"
    :class="['upload-dropzone', { compact, dragging, disabled }]"
    :aria-busy="busy"
    @dragenter="onDragEnter"
    @dragover="onDragOver"
    @dragleave="onDragLeave"
    @drop="onDrop"
    @click="onZoneClick"
  >
    <input
      ref="input"
      class="sr-only"
      type="file"
      tabindex="-1"
      :aria-label="inputLabel"
      :accept="acceptedTypes"
      :disabled="inactive"
      @change="onInputChange"
    />

    <div
      class="folder-mark"
      aria-hidden="true"
    >
      <svg
        viewBox="0 0 72 60"
        fill="none"
      >
        <path d="M7 14a6 6 0 0 1 6-6h16l7 8h23a6 6 0 0 1 6 6v25a6 6 0 0 1-6 6H13a6 6 0 0 1-6-6V14Z" />
        <path d="M27 37h18M36 28v18" />
      </svg>
    </div>

    <div class="upload-copy">
      <h3>{{ heading }}</h3>
      <p>{{ hint }}</p>
    </div>

    <button
      type="button"
      class="primary upload-action"
      :disabled="inactive"
      @click="openPicker"
    >
      {{ actionLabel }}
    </button>

    <p
      v-if="busy"
      class="busy-state"
      role="status"
    >
      正在读取文件…
    </p>

    <div
      v-if="visibleError"
      class="upload-error"
      role="alert"
    >
      <span>{{ visibleError }}</span>
      <button
        type="button"
        class="text-button"
        :disabled="inactive"
        @click="openPicker"
      >
        重新选择
      </button>
    </div>
  </div>
</template>

<style scoped>
.upload-dropzone {
  position: relative;
  min-height: 240px;
  padding: 32px;
  display: grid;
  place-content: center;
  justify-items: center;
  gap: 16px;
  text-align: center;
  color: var(--muted);
  background: var(--panel);
  border: 1px dashed var(--border-strong);
  border-radius: var(--radius);
  transition: background .15s, border-color .15s;
}

.upload-dropzone.dragging {
  background: var(--accent-soft);
  border-color: var(--accent);
  border-style: solid;
}

.upload-dropzone.disabled {
  opacity: .55;
}

.upload-dropzone.compact {
  min-height: 108px;
  padding: 20px;
  grid-template-columns: auto minmax(0, 1fr) auto;
  justify-items: start;
  text-align: left;
  gap: 12px 20px;
}

.folder-mark {
  width: 60px;
  height: 56px;
  display: grid;
  place-items: center;
  color: var(--accent-text);
  background: transparent;
  border-radius: 12px;
}

.folder-mark svg {
  width: 54px;
  height: 48px;
}

.folder-mark path:first-child {
  fill: var(--accent-soft);
  stroke: var(--accent-text);
  stroke-width: 2;
}

.folder-mark path:last-child {
  stroke: var(--text);
  stroke-width: 3;
  stroke-linecap: round;
}

.upload-copy {
  display: grid;
  gap: 6px;
}

.upload-copy h3 {
  color: var(--text);
  font-size: 18px;
}

.upload-copy p {
  color: var(--muted);
  font-size: 13px;
}

.upload-action {
  min-width: 124px;
}

.busy-state {
  color: var(--accent-text);
  font-size: 13px;
}

.upload-error {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  color: var(--danger);
  font-size: 13px;
}

.upload-error .text-button {
  color: var(--accent-text);
}

.compact .folder-mark {
  grid-row: 1 / span 2;
  width: 60px;
  height: 56px;
}

.compact .folder-mark svg {
  width: 46px;
  height: 40px;
}

.compact .upload-copy {
  align-self: end;
}

.compact .upload-action {
  grid-row: 1 / span 2;
  grid-column: 3;
  align-self: center;
}

.compact .busy-state,
.compact .upload-error {
  grid-column: 2 / -1;
}

input[type="file"].sr-only {
  position: absolute;
  inset: 0 auto auto 0;
  width: 1px;
  height: 1px;
  min-height: 0;
  min-width: 0;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

@media (max-width: 700px) {
  .upload-dropzone.compact {
    grid-template-columns: 1fr;
    justify-items: center;
    text-align: center;
  }

  .compact .folder-mark,
  .compact .upload-action,
  .compact .busy-state,
  .compact .upload-error {
    grid-row: auto;
    grid-column: auto;
  }
}
</style>
