<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useId, watch } from 'vue';
import Icon from './Icon.vue';
import { downwardPosition, makeRoomBelow } from './popoverPosition';

export interface SelectOption { value: string; label: string; description?: string; icon?: string; disabled?: boolean }
const props = withDefaults(defineProps<{ modelValue: string; label: string; options: readonly SelectOption[]; disabled?: boolean; placeholder?: string }>(), { disabled: false, placeholder: '' });
const emit = defineEmits<{ 'update:modelValue': [value: string] }>();
const root = ref<HTMLElement>(); const trigger = ref<HTMLButtonElement>(); const panel = ref<HTMLElement>();
const open = ref(false); const activeIndex = ref(-1); const position = ref<Record<string, string>>({});
let opening = false; let revision = 0; let releaseSpace: (() => void) | undefined;
const id = `select-${useId()}`;
const selected = computed(() => props.options.find(option => option.value === props.modelValue));
const triggerText = computed(() => selected.value?.label ?? (props.modelValue || props.placeholder));
const enabledIndices = computed(() => props.options.flatMap((option, index) => option.disabled ? [] : [index]));

function close() {
  revision += 1; opening = false;
  if (panel.value?.matches(':popover-open')) panel.value.hidePopover?.();
  open.value = false;
  releaseSpace?.(); releaseSpace = undefined;
}
function closeAndRestoreFocus() { close(); trigger.value?.focus({ preventScroll: true }); }
function scrollActiveIntoView() {
  void nextTick(() => panel.value?.querySelector(`#${id}-option-${activeIndex.value}`)?.scrollIntoView({ block: 'nearest' }));
}
function activate(index: number) { activeIndex.value = index; scrollActiveIntoView(); }
async function show() {
  if (props.disabled || open.value || opening || !trigger.value) return;
  const currentRevision = ++revision;
  opening = true;
  releaseSpace = makeRoomBelow(trigger.value, Math.min(props.options.length * 47 + 12, 330));
  await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
  if (currentRevision !== revision || props.disabled) return;
  opening = false;
  const current = props.options.findIndex(option => option.value === props.modelValue && !option.disabled);
  activeIndex.value = current >= 0 ? current : (enabledIndices.value[0] ?? -1);
  open.value = true;
  await nextTick();
  if (!open.value || !trigger.value || !panel.value) return;
  const rect = trigger.value.getBoundingClientRect();
  const longestLabel = Math.max(0, ...props.options.map(option => [...option.label].length));
  const preferredWidth = longestLabel > 7 ? 220 : 180;
  const width = Math.min(Math.max(rect.width, preferredWidth), 220, window.innerWidth - 24);
  position.value = downwardPosition(trigger.value, width, 330);
  panel.value.showPopover?.();
  scrollActiveIntoView();
}
function toggle() { if (open.value || opening) close(); else void show(); }
function choose(index: number) {
  const option = props.options[index];
  if (!option || option.disabled) return;
  close(); trigger.value?.focus({ preventScroll: true }); emit('update:modelValue', option.value);
}
function move(direction: number) {
  const indices = enabledIndices.value;
  if (!indices.length) return;
  const current = indices.indexOf(activeIndex.value);
  activate(indices[(current + direction + indices.length) % indices.length]!);
}
function keydown(event: KeyboardEvent) {
  if (props.disabled) return;
  if (event.key === 'Escape' && (open.value || opening)) { event.preventDefault(); event.stopPropagation(); closeAndRestoreFocus(); return; }
  if (event.key === 'Tab') { close(); return; }
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', ' '].includes(event.key)) return;
  event.preventDefault(); event.stopPropagation();
  if (!open.value) { void show(); return; }
  if (event.key === 'Enter' || event.key === ' ') { choose(activeIndex.value); return; }
  if (event.key === 'Home') activate(enabledIndices.value[0] ?? -1);
  else if (event.key === 'End') activate(enabledIndices.value.at(-1) ?? -1);
  else move(event.key === 'ArrowDown' ? 1 : -1);
}
function outside(event: Event) { if (event.target instanceof Node && !root.value?.contains(event.target)) close(); }
function scroll(event: Event) { if (!opening && (!(event.target instanceof Node) || !panel.value?.contains(event.target))) close(); }
watch(() => props.disabled, disabled => { if (disabled) close(); });
onMounted(() => { document.addEventListener('pointerdown', outside); document.addEventListener('focusin', outside); window.addEventListener('resize', close); window.addEventListener('scroll', scroll, true); });
onBeforeUnmount(() => { close(); document.removeEventListener('pointerdown', outside); document.removeEventListener('focusin', outside); window.removeEventListener('resize', close); window.removeEventListener('scroll', scroll, true); });
</script>

<template>
  <div
    ref="root"
    class="select-menu"
    @keydown="keydown"
  >
    <button
      ref="trigger"
      type="button"
      class="select-trigger"
      role="combobox"
      :aria-label="label"
      :aria-expanded="open"
      :aria-controls="id"
      :aria-activedescendant="open && activeIndex >= 0 ? `${id}-option-${activeIndex}` : undefined"
      aria-haspopup="listbox"
      :data-value="modelValue"
      :disabled="disabled"
      @click="toggle"
    >
      <Icon
        v-if="selected?.icon"
        :name="selected.icon"
        :size="19"
      />
      <span :class="{ placeholder: !selected && !modelValue && placeholder }">{{ triggerText }}</span>
    </button>
    <div
      v-if="open"
      :id="id"
      ref="panel"
      class="select-options"
      role="listbox"
      :aria-label="label"
      popover="manual"
      :style="position"
      @pointerdown.prevent
    >
      <div
        v-for="(option, index) in options"
        :id="`${id}-option-${index}`"
        :key="option.value"
        class="select-option"
        :class="{ highlighted: activeIndex === index, selected: modelValue === option.value, disabled: option.disabled }"
        role="option"
        :aria-label="option.label"
        :aria-selected="modelValue === option.value"
        :aria-disabled="!!option.disabled"
        :data-value="option.value"
        @pointermove="!option.disabled && (activeIndex = index)"
        @click="choose(index)"
      >
        <Icon
          v-if="option.icon"
          :name="option.icon"
          :size="20"
        />
        <span class="option-copy"><strong>{{ option.label }}</strong></span>
        <Icon
          v-if="modelValue === option.value"
          name="check"
          :size="16"
        />
      </div>
    </div>
  </div>
</template>

<style scoped>
.select-menu{position:relative;min-width:0}.select-trigger{width:100%;height:44px;justify-content:flex-start;background:var(--input);border-radius:8px;padding:8px 12px;color:var(--text)}.select-trigger>span{flex:1;min-width:0;overflow:hidden;text-align:left;text-overflow:ellipsis;white-space:nowrap}.select-trigger>span.placeholder{color:var(--muted)}.select-trigger[aria-expanded=true]{border-color:var(--accent);background:var(--accent-soft)}
.select-options{position:fixed;inset:auto;margin:0;padding:6px;background:var(--panel-raised);color:var(--text);border:1px solid var(--border);border-radius:10px;box-shadow:0 12px 36px color-mix(in srgb,var(--bg) 75%,transparent);overflow-y:auto;overscroll-behavior:contain;z-index:100;min-width:0}.select-options:popover-open{display:grid;gap:3px}.select-option{display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:8px;height:44px;cursor:pointer}.select-option.highlighted{background:var(--accent-soft)}.select-option.selected{color:var(--accent-text)}.select-option.disabled{opacity:.45;cursor:not-allowed}.option-copy{display:block;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.option-copy strong{font-size:14px;font-weight:500}
</style>
