<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { downwardPosition, makeRoomBelow } from './popoverPosition';

const props = defineProps<{ open: boolean; title: string; anchor?: HTMLElement; focusSelector?: string }>();
const emit = defineEmits<{ close: [] }>();
const panel = ref<HTMLElement>();
const position = ref<Record<string, string>>({});
let previousAnchor: HTMLElement | undefined;
let revision = 0;
let releaseSpace: (() => void) | undefined;

function controls() {
  return [...(panel.value?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), [tabindex="0"]') ?? [])]
    .filter(element => element.getClientRects().length && (!(element instanceof HTMLInputElement) || element.type !== 'radio' || element.checked));
}
function place() {
  if (!props.anchor || !panel.value) return;
  position.value = downwardPosition(props.anchor, 408, 460);
}
watch(() => [props.open, props.anchor] as const, async ([open]) => {
  const current = ++revision;
  if (!open) {
    releaseSpace?.(); releaseSpace = undefined;
    if (panel.value?.contains(document.activeElement)) previousAnchor?.focus({ preventScroll: true });
    return;
  }
  previousAnchor = props.anchor;
  releaseSpace?.();
  releaseSpace = props.anchor ? makeRoomBelow(props.anchor, 420) : undefined;
  await nextTick();
  if (current !== revision || !props.open || !panel.value) return;
  place();
  panel.value.showPopover();
  await nextTick();
  const first = props.focusSelector ? panel.value.querySelector<HTMLElement>(props.focusSelector) : controls()[0];
  (first ?? panel.value).focus({ preventScroll: true });
}, { flush: 'pre' });
function close(restoreFocus = false) {
  if (!props.open) return;
  if (restoreFocus) previousAnchor?.focus({ preventScroll: true });
  emit('close');
}
function keydown(event: KeyboardEvent) {
  if (event.defaultPrevented) return;
  if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); }
  if (event.key !== 'Tab') return;
  const items = controls(); const first = items[0]; const last = items.at(-1);
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
}
function outside(event: Event) {
  if (event.target instanceof Node && !panel.value?.contains(event.target) && !props.anchor?.contains(event.target)) close();
}
onMounted(() => { document.addEventListener('pointerdown', outside); window.addEventListener('resize', place); window.addEventListener('scroll', place, true); });
onBeforeUnmount(() => { revision += 1; releaseSpace?.(); document.removeEventListener('pointerdown', outside); window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); });
</script>

<template>
  <section
    v-if="open"
    ref="panel"
    class="anchored-panel"
    role="dialog"
    :aria-label="title"
    tabindex="-1"
    popover="manual"
    :style="position"
    @keydown="keydown"
  >
    <slot />
  </section>
</template>

<style scoped>
.anchored-panel{position:fixed;inset:auto;margin:0;padding:20px;border:1px solid var(--border);border-radius:14px;background:var(--panel-raised);color:var(--text);box-shadow:0 16px 48px color-mix(in srgb,var(--bg) 75%,transparent);overflow:auto;overscroll-behavior:contain;z-index:100;min-width:0}
.anchored-panel:popover-open{display:grid;gap:18px}
</style>
