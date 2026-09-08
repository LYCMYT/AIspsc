<script setup lang="ts">
import { useId } from 'vue';
export interface SegmentOption { value: string; label: string; ratio?: readonly [number, number] }
defineProps<{ modelValue: string; label: string; options: readonly SegmentOption[] }>();
const emit = defineEmits<{ 'update:modelValue': [value: string] }>();
const id = useId();
function shape(ratio: readonly [number, number]) {
  return { width: `${Math.round(20 * Math.min(1, ratio[0] / ratio[1]))}px`, height: `${Math.round(20 * Math.min(1, ratio[1] / ratio[0]))}px` };
}
</script>

<template>
  <div
    class="parameter-choice"
    role="radiogroup"
    :aria-label="label"
  >
    <span class="field-label">{{ label }}</span>
    <div class="segmented-options">
      <label
        v-for="option in options"
        :key="option.value"
        :class="['segmented-option', { selected: modelValue === option.value, illustrated: option.ratio }]"
      >
        <input
          type="radio"
          :name="id"
          :aria-label="option.label"
          :value="option.value"
          :checked="modelValue === option.value"
          @change="emit('update:modelValue', option.value)"
        />
        <span
          v-if="option.ratio"
          class="ratio-icon"
          aria-hidden="true"
        ><i :style="shape(option.ratio)" /></span>
        <span>{{ option.label }}</span>
      </label>
    </div>
  </div>
</template>

<style scoped>
.parameter-choice{display:grid;gap:10px;min-width:0}.field-label{font-size:13px;color:var(--muted)}
.segmented-options{display:flex;gap:4px;padding:4px;background:var(--input);border-radius:10px;min-width:0}
.segmented-option{position:relative;flex:1;min-width:0;min-height:36px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;border-radius:7px;color:var(--muted);cursor:pointer;font-size:14px;line-height:1.4;padding:8px 4px}
.segmented-option.illustrated{min-height:68px}.segmented-option.selected{color:var(--text);background:var(--panel-raised)}.segmented-option:hover{color:var(--text)}
.segmented-option:has(input:focus-visible){outline:2px solid var(--accent-text);outline-offset:1px}
.segmented-option input{position:absolute;inset:0;width:100%;height:100%;min-height:0;margin:0;padding:0;opacity:0;cursor:pointer}
.ratio-icon{display:grid;place-items:center;width:24px;height:22px}.ratio-icon i{display:block;border:1.5px solid currentColor;border-radius:3px}
</style>
