<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from 'vue';
import Icon from './Icon.vue';
const props = defineProps<{ open: boolean; title: string; wide?: boolean }>();
const emit = defineEmits<{ close: [] }>();
const dialog = ref<HTMLDialogElement>();
let trigger: HTMLElement | null = null;
watch(() => props.open, async (open) => {
  await nextTick();
  if (open) { trigger = document.activeElement as HTMLElement; dialog.value?.showModal(); }
  else { dialog.value?.close(); trigger?.focus(); }
}, { immediate: true });
function keydown(event: KeyboardEvent) {
  if (event.key !== 'Tab') return;
  const controls = [...(dialog.value?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]') ?? [])].filter((el) => el.getClientRects().length);
  const first = controls[0]; const last = controls.at(-1);
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
  if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
}
onBeforeUnmount(() => { dialog.value?.close(); trigger?.focus(); });
</script>
<template>
  <dialog
    ref="dialog"
    :class="['modal', { wide }]"
    :aria-label="title"
    @cancel.prevent="emit('close')"
    @keydown="keydown"
  >
    <header class="modal-header">
      <h2>{{ title }}</h2><button
        class="icon-button"
        aria-label="关闭"
        @click="emit('close')"
      >
        <Icon name="close" />
      </button>
    </header>
    <div class="modal-body">
      <slot />
    </div>
  </dialog>
</template>
