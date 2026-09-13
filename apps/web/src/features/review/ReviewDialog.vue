<script setup lang="ts">
import { failureMessage } from '../../services/labels';
import { computed, ref, watch } from 'vue';
import type { BasicMediaReviewInput, EvaluationDimensionId, GenerationItem, HardFailureCode, VideoReviewInput } from '../../../../../packages/contracts/src/index';
import Modal from '../../components/Modal.vue';
import MediaPreview from '../../components/MediaPreview.vue';
import SelectMenu from '../../components/SelectMenu.vue';
import { useStudioStore } from '../../services/studio';
const props = defineProps<{ item?: GenerationItem; open: boolean }>();
const emit = defineEmits<{ close: []; saved: [] }>();
const studio = useStudioStore(); const saving = ref(false); const failure = ref(''); const revisionReason = ref('');
const dimensions: [EvaluationDimensionId, string][] = [['Q01', '商品存在性'], ['Q02', '商品一致性'], ['Q03', '人物一致性'], ['Q04', '人体/结构完整性'], ['Q05', '动作自然度'], ['Q06', '时序稳定性'], ['Q07', '画面清晰度'], ['Q08', '场景正确性'], ['Q09', '指令遵循度'], ['Q10', '参考素材遵循度'], ['Q11', '投流素材可用性']];
const hardLabels: [HardFailureCode, string][] = [['H01', '任务要求的商品完全缺失'], ['H02', '商品严重失真/关键特征错误'], ['H03', '严重人体或画面结构穿帮']];
const decisionOptions = [{ value: 'approved', label: '通过' }, { value: 'rejected', label: '不通过' }];
function newVideo(): VideoReviewInput { return { rubricVersion: 'rubric-v2-rebuild', score: 7, applicability: Object.fromEntries(dimensions.map(([id]) => [id, { applicable: true, reason: '' }])) as VideoReviewInput['applicability'], issueTags: [], hardFailures: [], technicalErrors: [], notes: '' }; }
const video = ref(newVideo());
const basic = ref<BasicMediaReviewInput>({ rubricVersion: 'basic-media-review-v1', humanDecision: 'approved', readable: false, followsTask: false, reason: '' });
const evaluations = computed(() => studio.snapshot?.evaluations.filter((evaluation) => evaluation.itemId === props.item?.id) ?? []);
const isDemo = computed(() => studio.snapshot?.mediaMetadata.find((media) => media.id === props.item?.resultMediaId)?.isDemo !== false);
const batch = computed(() => studio.batches.find((entry) => entry.id === props.item?.batchId));
watch(() => [props.open, props.item?.id], () => { if (!props.open) return; video.value = newVideo(); basic.value = { rubricVersion: 'basic-media-review-v1', humanDecision: 'approved', readable: false, followsTask: false, reason: '' }; failure.value = ''; revisionReason.value = ''; });
async function save() {
  if (!props.item || saving.value) return;
  saving.value = true; failure.value = '';
  const form = props.item.mode === 'video' ? JSON.parse(JSON.stringify(video.value)) as VideoReviewInput : { ...basic.value };
  const result = await studio.act(() => evaluations.value.length ? studio.platform.saveReviewRevision(props.item!.id, form, revisionReason.value) : studio.platform.review.save(props.item!.id, form.rubricVersion, form));
  saving.value = false;
  if (!result.ok) { failure.value = failureMessage(result.error); return; }
  emit('saved'); emit('close');
}
</script>
<template>
  <Modal
    :open="open"
    title="人工审核"
    wide
    @close="emit('close')"
  >
    <template v-if="item">
      <div class="review-intro">
        <MediaPreview
          :media-id="item.resultMediaId"
          :text="item.text"
          :demo="isDemo"
          generated
        /><div class="stack">
          <span
            v-if="isDemo"
            class="badge demo"
          >演示结果</span><h3>审核结果 {{ item.index + 1 }}</h3><p>{{ batch?.requestSnapshot.prompt }}</p><p class="notice">
            通过后仍需返回历史记录手动入库。
          </p>
        </div>
      </div>
      <form
        class="stack"
        @submit.prevent="save"
      >
        <template v-if="item.mode === 'video'">
          <div class="panel-header">
            <h3>质量检查</h3>
          </div>
          <div class="rubric-grid">
            <div
              v-for="[id, label] in dimensions"
              :key="id"
              class="rubric-row"
            >
              <div class="row spread">
                <strong>{{ label }}</strong><label class="check-row"><input
                  v-model="video.applicability[id].applicable"
                  type="checkbox"
                  :aria-label="`${label}适用`"
                />适用</label>
              </div><label
                v-if="video.applicability[id].applicable"
                class="check-row muted"
              ><input
                v-model="video.issueTags"
                type="checkbox"
                :value="id"
                :aria-label="`${label}存在问题`"
              />存在问题</label><input
                v-else
                v-model="video.applicability[id].reason"
                :aria-label="`${label}不适用原因`"
                placeholder="不适用原因（必填）"
                required
              />
            </div>
          </div>
          <div class="two-columns">
            <div class="field">
              <label for="review-score">综合分</label><input
                id="review-score"
                v-model.number="video.score"
                aria-label="人工综合分（1–10 整数）"
                type="number"
                min="1"
                max="10"
                step="1"
                required
              />
            </div><div class="notice warning">
              严重问题或文件异常将判为不通过。
            </div>
          </div>
          <div class="stack">
            <h3>严重问题</h3><label
              v-for="[id, label] in hardLabels"
              :key="id"
              class="check-row"
            ><input
              v-model="video.hardFailures"
              type="checkbox"
              :value="id"
              :aria-label="label"
            />{{ label }}</label>
          </div>
          <label class="field">审核备注<textarea
            v-model="video.notes"
            aria-label="审核备注"
            placeholder="填写审核说明"
          /></label>
          <div class="notice">
            文件检查（保存时）：可读取、时长、画面尺寸、音轨。
          </div>
        </template>
        <template v-else>
          <h3>基础媒体审核</h3><label class="check-row"><input
            v-model="basic.readable"
            type="checkbox"
          />输出可读取</label><label class="check-row"><input
            v-model="basic.followsTask"
            type="checkbox"
          />符合任务要求</label><div class="field">
            <span class="field-label">人工结论</span><SelectMenu
              :model-value="basic.humanDecision"
              label="人工结论"
              :options="decisionOptions"
              @update:model-value="basic.humanDecision = $event as BasicMediaReviewInput['humanDecision']"
            />
          </div><label class="field">审核原因<textarea
            v-model="basic.reason"
            aria-label="审核原因"
            placeholder="不通过时必填；文案不得编造商品事实"
          /></label>
        </template>
        <label
          v-if="evaluations.length"
          class="field"
        >改判原因<input
          v-model="revisionReason"
          aria-label="改判原因"
          placeholder="创建新审核版本，不覆盖原记录"
          required
        /></label>
        <p
          v-if="failure"
          class="notice error"
          role="alert"
        >
          {{ failure }}
        </p>
        <div class="form-actions">
          <button
            type="button"
            @click="emit('close')"
          >
            取消
          </button><button
            class="primary"
            :disabled="saving"
            type="submit"
          >
            {{ saving ? '保存审核中…' : '保存审核' }}
          </button>
        </div>
      </form>
    </template>
  </Modal>
</template>
<style scoped>
.review-intro{display:grid;grid-template-columns:220px 1fr;gap:24px;align-items:start}.review-intro .preview{height:240px}.rubric-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}.rubric-row{display:grid;gap:10px;padding:14px;background:var(--input);border:1px solid var(--border);border-radius:8px}.rubric-row strong{font-size:13px}.rubric-row input:not([type=checkbox]){font-size:12px;min-height:34px;padding:8px}@media(max-width:900px){.review-intro,.rubric-grid{grid-template-columns:1fr}}
</style>
