<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue';
import { platform } from '../services/platform';
import Icon from './Icon.vue';
const props = defineProps<{ mediaId: string; filename: string; label?: string }>();
const url = ref(''); const failure = ref(false); let generation = 0;
watch(() => props.mediaId, async (id) => { const current = ++generation; if (url.value) URL.revokeObjectURL(url.value); url.value = ''; failure.value = false; const result = await platform.media.get(id); if (generation !== current) return; if (!result.ok) { failure.value = true; return; } url.value = URL.createObjectURL(result.value.blob); }, { immediate: true });
onBeforeUnmount(() => { generation++; if (url.value) URL.revokeObjectURL(url.value); });
</script>
<template>
  <a
    v-if="url"
    class="download-link"
    :href="url"
    :download="filename"
  ><Icon
    name="download"
    :size="16"
  />{{ label ?? '下载文件' }}</a><span
    v-else
    class="muted"
  >{{ failure ? '文件需重新选择' : '读取文件…' }}</span>
</template>
<style scoped>.download-link{display:inline-flex;align-items:center;gap:8px;padding:9px 12px;border:1px solid var(--border);border-radius:8px;color:var(--accent-text);font-size:13px}.download-link:hover{background:var(--accent-soft)}</style>
