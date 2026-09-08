<script setup lang="ts">
import { failureMessage } from '../../services/labels';
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import type { Asset, GenerationBatchSnapshot, GenerationMode, GenerationReference, ReferenceRole } from '../../../../../packages/contracts/src/index';
import Icon from '../../components/Icon.vue';
import MediaPreview from '../../components/MediaPreview.vue';
import Modal from '../../components/Modal.vue';
import SelectMenu from '../../components/SelectMenu.vue';
import AnchoredPanel from '../../components/AnchoredPanel.vue';
import OptionSegments from '../../components/OptionSegments.vue';
import { modeLabels, statusLabels } from '../../services/labels';
import { useStudioStore } from '../../services/studio';

const studio = useStudioStore();
const router = useRouter();
const promptElement = ref<HTMLTextAreaElement>();
const parametersOpen = ref(false);
const parametersAnchor = ref<HTMLElement>();
function showParameters(event: MouseEvent) {
  const anchor = event.currentTarget as HTMLElement;
  if (parametersOpen.value && parametersAnchor.value === anchor) { parametersOpen.value = false; return; }
  parametersAnchor.value = anchor; parametersOpen.value = true;
}
const referencePickerOpen = ref(false);
const activeRole = ref<ReferenceRole>('product');
const referenceBusy = ref(false);
const submitting = ref(false);
const pendingMode = ref<GenerationMode>();
const formFailure = ref('');
let idempotencyKey = '';
let referenceOperation = 0;
let mounted = true;

const roleOrder: ReferenceRole[] = ['reference_video', 'person', 'product', 'background'];
const createRoleLabels: Record<ReferenceRole, string> = { reference_video: '参考视频', person: '模特', product: '产品', background: '背景' };
const modeOptions = [
  { value: 'video', label: '视频生成', icon: 'video' },
  { value: 'image', label: '图片生成', icon: 'image' },
  { value: 'copy', label: '文案生成', icon: 'copy' },
];
const ratioOptions = [{ value: '16:9', label: '16:9', ratio: [16, 9] }, { value: '1:1', label: '1:1', ratio: [1, 1] }, { value: '9:16', label: '9:16', ratio: [9, 16] }] as const;
const countOptions = Array.from({ length: 4 }, (_, index) => ({ value: String(index + 1), label: String(index + 1) }));
const referenceMethods = [{ value: 'omni', label: '全能参考', icon: 'assets' }, { value: 'first_last', label: '首尾帧', icon: 'image', disabled: true }];
const videoResolutionOptions = [{ value: '720p', label: '720p' }, { value: '1080p', label: '1080p' }];
const imageResolutionOptions = [{ value: '1024', label: '1024' }];
const languageOptions = [{ value: 'zh-CN', label: '简体中文' }];

const references = computed(() => studio.draft.references
  .map((reference) => ({ reference, asset: studio.assets.find((asset) => asset.id === reference.assetId) }))
  .filter((entry): entry is { reference: GenerationReference; asset: Asset } => Boolean(entry.asset)));
const activeRoleAssets = computed(() => studio.assets.filter((asset) => asset.availability === 'available'
  && asset.reviewValidity !== 'review_invalidated'
  && (activeRole.value === 'reference_video' ? asset.mediaType === 'video' : asset.mediaType === 'image')));
const parameterSummary = computed(() => {
  if (studio.draft.mode === 'video') return `${studio.draft.video.ratio} · ${studio.draft.video.resolution} · ${studio.draft.count}`;
  if (studio.draft.mode === 'image') return `${studio.draft.image.ratio} · ${studio.draft.image.resolution} · ${studio.draft.count}`;
  return `简体中文 · ${studio.draft.count}`;
});
const recentBatches = computed(() => studio.batches.slice().sort((left, right) => right.createdAt.localeCompare(left.createdAt)).slice(0, 3));

watch(studio.draft, () => { idempotencyKey = ''; formFailure.value = ''; }, { deep: true });
onBeforeUnmount(() => { mounted = false; referenceOperation += 1; });

function canUseRole(role: ReferenceRole, mode: GenerationMode = studio.draft.mode) {
  if (mode === 'copy') return false;
  return mode === 'video' || role !== 'reference_video';
}
function openReferencePicker() {
  if (!canUseRole('product') || referenceBusy.value) return;
  formFailure.value = '';
  activeRole.value = 'product'; referencePickerOpen.value = true;
}
function chooseRole(role: ReferenceRole) {
  if (!canUseRole(role) || referenceBusy.value) return;
  formFailure.value = '';
  activeRole.value = role;
}
function closeReferencePicker() {
  referenceOperation += 1;
  referenceBusy.value = false;
  referencePickerOpen.value = false;
}
function chooseMode(mode: GenerationMode) {
  if (referenceBusy.value || mode === studio.draft.mode) return;
  if (incompatibleReferences(mode).length) { pendingMode.value = mode; return; }
  studio.draft.mode = mode; referencePickerOpen.value = false;
  if (!canUseRole(activeRole.value, mode)) activeRole.value = 'product';
}
function incompatibleReferences(mode: GenerationMode) {
  if (mode === 'copy') return studio.draft.references;
  if (mode === 'image') return studio.draft.references.filter((entry) => entry.role === 'reference_video');
  return [];
}
function confirmModeChange() {
  const mode = pendingMode.value ?? 'copy';
  const incompatible = new Set(incompatibleReferences(mode).map((entry) => `${entry.role}:${entry.assetId}`));
  studio.draft.references = studio.draft.references.filter((entry) => !incompatible.has(`${entry.role}:${entry.assetId}`));
  studio.draft.mode = mode; referencePickerOpen.value = false; activeRole.value = 'product'; pendingMode.value = undefined;
}
function assetForRole(role: ReferenceRole) { return studio.draft.references.find((reference) => reference.role === role)?.assetId ?? ''; }
function assignRole(role: ReferenceRole, assetId: string) {
  if (!canUseRole(role)) return;
  studio.draft.references = [...studio.draft.references.filter((reference) => reference.role !== role), ...(assetId ? [{ assetId, role }] : [])];
}
function removeReference(role: ReferenceRole) { studio.draft.references = studio.draft.references.filter((reference) => reference.role !== role); }
async function upload(event: Event) {
  const input = event.target as HTMLInputElement; const file = input.files?.[0]; input.value = '';
  if (!file || referenceBusy.value) return;
  const role = activeRole.value; const operation = ++referenceOperation; referenceBusy.value = true; formFailure.value = '';
  const result = await studio.act(() => studio.platform.upload(file, file.name));
  if (!mounted || operation !== referenceOperation) return;
  referenceBusy.value = false;
  if (!result.ok) { formFailure.value = failureMessage(result.error); return; }
  const expectedType = role === 'reference_video' ? 'video' : 'image';
  if (result.value.mediaType !== expectedType) {
    formFailure.value = `${createRoleLabels[role]}需要${expectedType === 'video' ? '视频' : '图片'}素材`;
    return;
  }
  assignRole(role, result.value.id);
}
async function loadDemo() {
  if (referenceBusy.value) return;
  const role = activeRole.value; const operation = ++referenceOperation; referenceBusy.value = true; formFailure.value = '';
  const result = await studio.act(() => studio.platform.loadFixture(role === 'reference_video' ? 'scene-source' : 'image-1x1-1024'));
  if (!mounted || operation !== referenceOperation) return;
  referenceBusy.value = false;
  if (result.ok) assignRole(role, result.value.id); else formFailure.value = failureMessage(result.error);
}
function previewItem(batch: GenerationBatchSnapshot) { return batch.items.find((item) => item.status === 'succeeded') ?? batch.items[0]; }
function formatDate(value: string) { return new Date(value).toLocaleString('zh-CN', { hour12: false }); }
function statusTone(status: GenerationBatchSnapshot['status']) {
  if (status === 'succeeded' || status === 'partial_succeeded') return 'success';
  if (status === 'failed' || status === 'cancelled') return 'failed';
  return 'pending';
}
async function submit() {
  if (submitting.value) return;
  submitting.value = true; formFailure.value = ''; idempotencyKey ||= crypto.randomUUID();
  const result = await studio.act(() => studio.platform.generation.create(studio.buildRequest(), { idempotencyKey }));
  submitting.value = false;
  if (!result.ok) { formFailure.value = failureMessage(result.error); return; }
  idempotencyKey = ''; await router.push('/history');
}
</script>

<template>
  <section class="page create-page">
    <h1 class="sr-only">
      创作
    </h1>
    <form
      class="composer panel"
      novalidate
      @submit.prevent="submit"
    >
      <div class="composer-main">
        <section
          class="reference-summary"
          :aria-label="studio.draft.mode === 'copy' ? undefined : '参考素材'"
        >
          <button
            type="button"
            class="upload-tile"
            aria-label="上传素材"
            :disabled="studio.draft.mode === 'copy' || referenceBusy"
            @click="openReferencePicker"
          >
            <Icon
              name="plus"
              :size="32"
            />
            <strong>上传素材</strong>
          </button>
          <div
            v-if="references.length"
            class="selected-references"
          >
            <article
              v-for="entry in references"
              :key="`${entry.reference.role}:${entry.asset.id}`"
              class="reference-slot"
            >
              <MediaPreview
                :media-id="entry.asset.mediaFileId"
                :demo="entry.asset.isDemo"
                compact
              />
              <div class="reference-meta">
                <span>{{ createRoleLabels[entry.reference.role] }}</span><small class="truncate">{{ entry.asset.title }}</small>
              </div>
              <button
                type="button"
                class="remove-reference"
                :aria-label="`移除${createRoleLabels[entry.reference.role]}参考`"
                @click="removeReference(entry.reference.role)"
              >
                <Icon
                  name="close"
                  :size="13"
                />
              </button>
            </article>
          </div>
        </section>
        <label class="prompt-field">
          <span class="sr-only">Prompt</span>
          <textarea
            ref="promptElement"
            v-model="studio.draft.prompt"
            aria-label="Prompt"
            required
            maxlength="5000"
            placeholder="输入视频创意、图片需求或文案想法…"
          />
        </label>
      </div>
      <div class="composer-toolbar">
        <SelectMenu
          class="mode-picker"
          :model-value="studio.draft.mode"
          label="生成类型"
          :options="modeOptions"
          :disabled="referenceBusy"
          @update:model-value="chooseMode($event as GenerationMode)"
        />
        <SelectMenu
          v-if="studio.draft.mode !== 'copy'"
          class="reference-method"
          model-value="omni"
          label="参考方式"
          :options="referenceMethods"
          :disabled="referenceBusy"
        />
        <button
          type="button"
          class="parameter-button"
          aria-label="生成参数"
          aria-haspopup="dialog"
          :aria-expanded="parametersOpen"
          aria-controls="generation-parameters"
          @click="showParameters($event)"
        >
          <Icon
            name="settings"
            :size="16"
          /><span>{{ parameterSummary }}</span>
        </button>
        <div class="credit-summary">
          <strong>{{ studio.draft.count }} 个演示额度</strong>
        </div>
        <button
          class="primary generate-button"
          type="submit"
          :disabled="submitting || !studio.ready"
        >
          <Icon
            name="play"
            :size="17"
          />{{ submitting ? '提交中…' : '生成' }}
        </button>
      </div>
      <p
        v-if="formFailure"
        class="notice error"
        role="status"
      >
        {{ formFailure }}
      </p>
      <p
        v-if="studio.draft.mode === 'copy'"
        class="copy-reference-note"
      >
        文案生成不接受参考素材
      </p>
    </form>

    <section
      class="recent-section"
      aria-labelledby="recent-title"
    >
      <header class="recent-header">
        <div>
          <h2 id="recent-title">
            生成历史
          </h2>
        </div>
        <RouterLink
          v-if="recentBatches.length"
          class="history-link"
          to="/history"
        >
          查看全部 <Icon
            name="arrow"
            :size="15"
          />
        </RouterLink>
      </header>
      <div
        v-if="recentBatches.length"
        class="recent-grid"
      >
        <RouterLink
          v-for="batch in recentBatches"
          :key="batch.id"
          class="recent-card panel"
          to="/history"
        >
          <MediaPreview
            v-if="previewItem(batch)?.status === 'succeeded'"
            :media-id="previewItem(batch)?.resultMediaId"
            :text="previewItem(batch)?.text"
            demo
            compact
          />
          <div
            v-else
            class="recent-placeholder"
          >
            <Icon
              :name="batch.status === 'failed' ? 'info' : 'history'"
              :size="26"
            /><span>{{ statusLabels[batch.status] }}</span>
          </div>
          <div class="recent-body">
            <div class="recent-badges">
              <span :class="['badge', statusTone(batch.status)]">{{ statusLabels[batch.status] }}</span><span class="badge neutral">{{ modeLabels[batch.requestSnapshot.mode] }}</span>
            </div>
            <strong class="recent-prompt">{{ batch.requestSnapshot.prompt }}</strong>
            <small>{{ batch.items.filter((item) => item.status === 'succeeded').length }} / {{ batch.requestedCount }} 条成功 · {{ formatDate(batch.createdAt) }}</small>
          </div>
        </RouterLink>
      </div>
      <div
        v-else
        class="recent-empty"
      >
        <span
          class="history-illustration"
          aria-hidden="true"
        >
          <svg
            viewBox="0 0 160 120"
            fill="none"
          >
            <path d="M35 72 80 91l45-19-45-18-45 18Z" />
            <path d="M35 72v18l45 19 45-19V72M80 91v18" />
            <path d="m88 39 39-20-17 40-7-14-15-6Z" />
            <path d="M103 45 127 19" />
            <path
              class="flight-path"
              d="M28 48c17-20 36-20 48-7 11 12 1 24-11 17-8-5-4-15 8-18"
            />
            <circle
              cx="24"
              cy="50"
              r="2"
            />
            <circle
              cx="137"
              cy="73"
              r="2"
            />
          </svg>
        </span>
        <div><h3>暂无记录</h3><p>你的生成历史将显示在这里。</p></div>
      </div>
    </section>

    <Modal
      :open="referencePickerOpen"
      title="选择参考素材"
      wide
      @close="closeReferencePicker"
    >
      <div
        class="role-tabs"
        role="tablist"
        aria-label="参考素材类型"
      >
        <button
          v-for="role in roleOrder"
          :key="role"
          type="button"
          role="tab"
          :aria-selected="activeRole === role"
          :disabled="!canUseRole(role) || referenceBusy"
          :title="role === 'reference_video' && studio.draft.mode === 'image' ? '图片生成不接受参考视频' : undefined"
          :class="{ active: activeRole === role }"
          @click="chooseRole(role)"
        >
          <Icon
            :name="role === 'reference_video' ? 'video' : 'image'"
            :size="16"
          />{{ createRoleLabels[role] }}
        </button>
      </div>
      <section
        class="reference-picker-content"
        role="tabpanel"
        :aria-label="createRoleLabels[activeRole]"
      >
        <header class="picker-heading">
          <strong>{{ createRoleLabels[activeRole] }}</strong>
          <button
            v-if="assetForRole(activeRole)"
            type="button"
            class="text-button"
            @click="removeReference(activeRole)"
          >
            清除此位置
          </button>
        </header>
        <div class="picker-actions">
          <label class="upload-file-action"><Icon
                                              name="upload"
                                              :size="17"
                                            />{{ referenceBusy ? '上传中…' : '上传文件' }}
            <input
              :aria-label="`上传${createRoleLabels[activeRole]}参考素材`"
              type="file"
              :accept="activeRole === 'reference_video' ? 'video/mp4,video/webm' : 'image/png,image/jpeg,image/webp'"
              :disabled="referenceBusy"
              @change="upload"
            />
          </label>
          <button
            type="button"
            class="small-button ghost"
            aria-label="载入演示参考"
            :disabled="referenceBusy"
            @click="loadDemo"
          >
            <Icon
              name="plus"
              :size="15"
            />{{ referenceBusy ? '载入中…' : '演示素材' }}
          </button>
        </div>
        <p
          v-if="formFailure"
          class="notice error"
          role="alert"
        >
          {{ formFailure }}
        </p>
        <div
          v-if="activeRoleAssets.length"
          class="asset-picker-grid"
        >
          <button
            v-for="asset in activeRoleAssets"
            :key="asset.id"
            type="button"
            class="asset-option"
            :class="{ selected: assetForRole(activeRole) === asset.id }"
            :aria-pressed="assetForRole(activeRole) === asset.id"
            :aria-label="`选择${asset.title}`"
            :disabled="referenceBusy"
            @click="assignRole(activeRole, asset.id)"
          >
            <MediaPreview
              :media-id="asset.mediaFileId"
              :demo="asset.isDemo"
              compact
            />
            <span class="asset-option-copy"><strong class="truncate">{{ asset.title }}</strong><small>{{ asset.source === 'fixture' ? '演示样例' : asset.source === 'upload' ? '上传素材' : '已入库成果' }}</small></span>
            <span
              v-if="assetForRole(activeRole) === asset.id"
              class="selected-mark"
            ><Icon
              name="check"
              :size="14"
            />已选择</span>
          </button>
        </div>
        <p
          v-else
          class="picker-empty"
        >
          暂无可用素材
        </p>
      </section>
      <div class="form-actions picker-footer">
        <span class="muted">已选择 {{ references.length }} / {{ studio.draft.mode === 'video' ? 4 : 3 }} 个位置</span>
        <button
          type="button"
          class="primary"
          :disabled="referenceBusy"
          @click="closeReferencePicker"
        >
          完成选择
        </button>
      </div>
    </Modal>

    <AnchoredPanel
      id="generation-parameters"
      :open="parametersOpen"
      title="生成参数"
      :anchor="parametersAnchor"
      @close="parametersOpen = false"
    >
      <template v-if="studio.draft.mode !== 'copy'">
        <OptionSegments
          :model-value="studio.draft.mode === 'video' ? studio.draft.video.ratio : studio.draft.image.ratio"
          label="选择比例"
          :options="ratioOptions"
          @update:model-value="studio.draft.mode === 'video' ? studio.draft.video.ratio = $event as '9:16' | '16:9' | '1:1' : studio.draft.image.ratio = $event as '9:16' | '16:9' | '1:1'"
        />
        <OptionSegments
          :model-value="studio.draft.mode === 'video' ? studio.draft.video.resolution : studio.draft.image.resolution"
          label="选择分辨率"
          :options="studio.draft.mode === 'video' ? videoResolutionOptions : imageResolutionOptions"
          @update:model-value="studio.draft.mode === 'video' ? studio.draft.video.resolution = $event as '720p' | '1080p' : studio.draft.image.resolution = $event"
        />
      </template>
      <template v-else>
        <div class="field">
          <span class="field-label">语言</span><SelectMenu
            :model-value="studio.draft.copy.language"
            label="语言"
            :options="languageOptions"
            @update:model-value="studio.draft.copy.language = $event as 'zh-CN'"
          />
        </div>
        <label class="field"><span class="field-label">最大字符数</span><input
          v-model.number="studio.draft.copy.maxCharacters"
          aria-label="最大字符数"
          type="number"
          min="1"
          max="2000"
        /></label>
      </template>
      <OptionSegments
        :model-value="String(studio.draft.count)"
        label="选择生成数量"
        :options="countOptions"
        @update:model-value="studio.draft.count = Number($event)"
      />
      <div
        v-if="studio.draft.mode === 'video'"
        class="video-options"
      >
        <label class="field"><span class="field-label">时长（秒）</span><input
          v-model.number="studio.draft.video.durationSeconds"
          aria-label="时长（秒）"
          type="number"
          min="5"
          max="15"
          step="1"
          required
        /></label>
        <label class="check-row"><input
          v-model="studio.draft.video.audio"
          aria-label="生成音频"
          type="checkbox"
        />生成音频</label>
      </div>
    </AnchoredPanel>

    <Modal
      :open="Boolean(pendingMode)"
      title="移除参考素材"
      @close="pendingMode = undefined"
    >
      <p>{{ pendingMode === 'image' ? '图片生成不接受参考视频。' : '文案生成不接受参考素材。' }}继续切换将移除 {{ incompatibleReferences(pendingMode ?? 'copy').length }} 个不兼容参考素材。</p>
      <div class="form-actions">
        <button
          type="button"
          @click="pendingMode = undefined"
        >
          保留并返回
        </button><button
          type="button"
          class="danger"
          @click="confirmModeChange"
        >
          确认移除并切换
        </button>
      </div>
    </Modal>
  </section>
</template>

<style scoped>
.create-page{gap:24px}.composer{display:grid;gap:0;padding:0;overflow:visible}.composer-main{display:grid;grid-template-columns:188px minmax(0,1fr);min-height:236px}.reference-summary{padding:20px;border-right:0;display:flex;flex-direction:column;gap:12px;min-width:0}.upload-tile{width:100%;min-height:140px;padding:20px 14px;display:flex;flex-direction:column;gap:14px;border-radius:13px;border-style:dashed;border-color:color-mix(in srgb,var(--border) 70%,transparent);background:color-mix(in srgb,var(--input) 45%,transparent);color:var(--muted)}.upload-tile:hover:not(:disabled){color:var(--text);background:var(--accent-soft)}.upload-tile strong{font-size:14px}.upload-tile>svg{color:var(--accent-text)}.selected-references{display:grid;gap:8px}.reference-slot{position:relative;display:grid;grid-template-columns:44px minmax(0,1fr) 24px;align-items:center;gap:8px;padding:7px;border:1px solid var(--border);border-radius:9px;background:var(--input);min-width:0}.reference-slot :deep(.preview){width:44px;height:44px;min-height:44px;border-radius:7px}.reference-slot :deep(.demo-watermark){display:none}.reference-meta{display:grid;gap:2px;min-width:0}.reference-meta span{font-size:12px;color:var(--accent-text)}.reference-meta small{font-size:12px}.remove-reference{width:24px;min-height:24px;padding:3px;border:0;background:transparent;color:var(--muted)}.prompt-field{position:relative;display:block;padding:24px;min-width:0}.prompt-field textarea{min-height:184px;padding:12px 0;border:0;border-radius:0;background:transparent;font-size:17px;line-height:1.75;resize:none}.prompt-field textarea:focus-visible{outline:0}.composer-toolbar{display:flex;align-items:center;flex-wrap:wrap;gap:10px;padding:14px 20px;border-top:1px solid var(--border)}.mode-picker{width:144px}.reference-method{width:144px}.parameter-button{min-height:44px;min-width:156px;padding:10px 12px;background:var(--input);font-size:13px;white-space:nowrap}.parameter-button>span{display:block}.credit-summary{margin-left:auto;color:var(--muted);font-size:12px;white-space:nowrap}.credit-summary strong{font-size:12px;font-weight:400}.generate-button{min-width:92px;min-height:44px}.video-options{display:grid;grid-template-columns:1fr 1fr;gap:20px;align-items:end}.video-options .check-row{min-height:42px}.composer>.notice,.copy-reference-note{margin:0 20px 16px}.copy-reference-note{color:var(--muted);font-size:12px}.recent-section{display:grid;gap:16px}.recent-header{display:flex;align-items:end;justify-content:space-between;gap:18px;padding:0 3px}.recent-header h2{font-size:18px}.recent-header p{margin-top:5px;color:var(--muted);font-size:12px}.history-link{display:inline-flex;align-items:center;gap:7px;color:var(--accent-text);font-size:13px}.recent-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px}.recent-card{display:grid;grid-template-columns:112px minmax(0,1fr);padding:0;overflow:hidden;border-radius:13px;transition:border-color .15s,transform .15s}.recent-card:hover{border-color:var(--accent);transform:translateY(-1px)}.recent-card :deep(.preview){height:132px;min-height:132px;border:0;border-right:1px solid var(--border);border-radius:0}.recent-placeholder{height:132px;display:grid;place-content:center;justify-items:center;gap:9px;color:var(--muted);background:var(--input);border-right:1px solid var(--border);font-size:12px}.recent-body{padding:14px;display:grid;align-content:center;gap:9px;min-width:0}.recent-badges{display:flex;gap:6px;flex-wrap:wrap}.recent-prompt{font-size:13px;line-height:1.55;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}.recent-body>small{color:var(--muted);font-size:12px}.recent-empty{min-height:230px;display:grid;justify-items:center;align-content:center;gap:12px;padding:24px;text-align:center;color:var(--muted)}.recent-empty h3{color:var(--text);margin-bottom:5px}.recent-empty p{font-size:13px}.history-illustration{width:124px;height:92px;display:grid;place-items:center;margin-bottom:4px;color:var(--accent-text)}.history-illustration svg{width:100%;height:100%;overflow:visible;filter:none}.history-illustration path,.history-illustration circle{stroke:currentColor;stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round}.history-illustration path:not(.flight-path){fill:color-mix(in srgb,var(--accent-soft) 75%,transparent)}.history-illustration .flight-path{stroke-dasharray:5 5}.role-tabs{display:grid;grid-template-columns:repeat(4,1fr);gap:8px}.role-tabs button{background:var(--input);color:var(--muted)}.role-tabs button.active{background:var(--accent-soft);border-color:var(--accent);color:var(--accent-text)}.reference-picker-content{display:grid;gap:16px}.picker-heading{display:flex;justify-content:space-between;align-items:start;gap:16px}.picker-heading p{margin-top:4px;color:var(--muted);font-size:12px}.picker-actions{display:flex;align-items:center;gap:10px}.upload-file-action{position:relative;overflow:hidden;display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:34px;padding:6px 12px;border:1px solid var(--border);border-radius:8px;background:var(--panel-raised);font-size:12px;cursor:pointer}.upload-file-action input{position:absolute;inset:0;opacity:0;cursor:pointer}.asset-picker-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;max-height:360px;overflow:auto;padding:2px}.asset-option{position:relative;display:grid;gap:9px;padding:8px;min-width:0;text-align:left;background:var(--input);border-radius:11px}.asset-option.selected{border-color:var(--accent);background:var(--accent-soft)}.asset-option :deep(.preview){width:100%;height:126px;min-height:126px}.asset-option-copy{display:grid;gap:3px;min-width:0;width:100%}.asset-option-copy strong{font-size:12px}.asset-option-copy small{color:var(--muted);font-size:12px}.selected-mark{position:absolute;top:15px;right:15px;display:inline-flex;align-items:center;gap:4px;padding:3px 6px;border-radius:5px;background:var(--accent);font-size:12px}.picker-empty{padding:34px;text-align:center;border:1px dashed var(--border);border-radius:10px;color:var(--muted);font-size:13px}.picker-footer{align-items:center;justify-content:space-between;padding-top:18px;border-top:1px solid var(--border)}
.prompt-field:focus-within{box-shadow:inset 0 0 0 2px var(--accent)}
@media(max-width:1150px){.recent-grid{grid-template-columns:1fr}.recent-card{grid-template-columns:140px minmax(0,1fr)}}
@media(max-width:760px){.composer-main{grid-template-columns:1fr}.reference-summary{border-right:0;border-bottom:1px solid color-mix(in srgb,var(--border) 52%,transparent)}.upload-tile{min-height:112px}.composer-toolbar{grid-template-columns:1fr}.composer-toolbar>*{width:100%}.credit-summary{justify-content:start}.generate-button{justify-self:stretch}.recent-empty{min-height:300px}.role-tabs{grid-template-columns:repeat(2,1fr)}.asset-picker-grid,.parameter-layout{grid-template-columns:1fr}.recent-card{grid-template-columns:105px minmax(0,1fr)}}
</style>
