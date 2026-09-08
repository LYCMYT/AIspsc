<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue';
import { platform } from '../services/platform';
const props = withDefaults(defineProps<{ mediaId?: string; text?: string; demo?: boolean; compact?: boolean }>(), { mediaId: undefined, text: undefined, demo: true, compact: false });
const url = ref(''); const mime = ref(''); const missing = ref(false); let version = 0;
function dispose() { if (url.value) URL.revokeObjectURL(url.value); url.value = ''; }
watch(() => props.mediaId, async (id) => {
  const current = ++version; dispose(); missing.value = false;
  if (!id) return;
  const result = await platform.media.get(id);
  if (current !== version) return;
  if (!result.ok) { missing.value = true; return; }
  mime.value = result.value.media.mime; url.value = URL.createObjectURL(result.value.blob);
}, { immediate: true });
onBeforeUnmount(() => { version += 1; dispose(); });
</script>
<template>
  <div :class="['preview', { compact }]">
    <p
      v-if="missing"
      class="notice warning"
    >
      文件需重新选择
    </p>
    <pre
      v-else-if="text"
      class="copy-preview"
    >{{ text }}</pre>
    <video
      v-else-if="url && mime.startsWith('video/')"
      :src="url"
      :controls="!compact"
      preload="metadata"
      playsinline
      :aria-label="demo ? '演示视频' : '上传的源视频'"
    />
    <img
      v-else-if="url"
      :src="url"
      :alt="demo ? '演示图片' : '上传的源素材'"
    />
    <p
      v-else
      class="muted"
    >
      {{ mediaId ? '读取媒体信息…' : '暂无可预览结果' }}
    </p>
    <span
      v-if="demo && !missing"
      class="demo-watermark badge demo"
    >{{ text ? '演示文案' : mime.startsWith('video/') ? '演示视频' : '演示素材' }}</span>
  </div>
</template>
