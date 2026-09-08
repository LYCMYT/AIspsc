<script setup lang="ts">
import { failureMessage } from '../../services/labels';
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';
import type { Asset, GenerationReference } from '../../../../../packages/contracts/src/index';
import { useStudioStore } from '../../services/studio';
import { roleLabels } from '../../services/labels';
import Icon from '../../components/Icon.vue';
import Modal from '../../components/Modal.vue';
import MediaPreview from '../../components/MediaPreview.vue';
import SelectMenu from '../../components/SelectMenu.vue';
const studio = useStudioStore(); const router = useRouter();
const search = ref(''); const mediaType = ref('all'); const source = ref('all'); const uploading = ref(false); const selectedId = ref(''); const deleting = ref(false); const title = ref(''); const tags = ref(''); const role = ref<GenerationReference['role']>('product'); const saving = ref(false); const message = ref('');
const selected = computed(() => studio.assets.find((asset) => asset.id === selectedId.value));
const visible = computed(() => studio.assets.filter((asset) => (mediaType.value === 'all' || asset.mediaType === mediaType.value) && (source.value === 'all' || asset.source === source.value) && `${asset.title} ${asset.tags.join(' ')}`.toLowerCase().includes(search.value.trim().toLowerCase())));
const metadata = computed(() => studio.snapshot?.mediaMetadata.find((file) => file.id === selected.value?.mediaFileId));
const sourceOptions = [{ value: 'all', label: '全部来源' }, { value: 'upload', label: '上传源素材' }, { value: 'generated', label: '已审核生成结果' }, { value: 'fixture', label: '演示样例' }];
const roleOptions = (['product', 'person', 'background'] as const).map((value) => ({ value, label: roleLabels[value] }));
const sourceLabel = (asset: Asset) => ({ upload: '上传源素材', generated: '已审核生成结果', fixture: '演示样例' })[asset.source];
function open(asset: Asset) { selectedId.value = asset.id; title.value = asset.title; tags.value = asset.tags.join('，'); role.value = asset.mediaType === 'video' ? 'reference_video' : 'product'; message.value = ''; }
async function uploadFiles(files: FileList | File[] | null) {
  if (!files?.length || uploading.value) return;
  uploading.value = true;
  for (const file of Array.from(files)) { const result = await studio.act(() => studio.platform.upload(file, file.name)); if (!result.ok) break; }
  uploading.value = false;
}
async function onFiles(event: Event) { const input = event.target as HTMLInputElement; await uploadFiles(input.files); input.value = ''; }
async function restore(event: Event) { const file = (event.target as HTMLInputElement).files?.[0]; if (!file || !selected.value) return; await studio.act(() => studio.platform.restore(selected.value!.id, file)); }
async function save() { if (!selected.value) return; saving.value = true; const result = await studio.act(() => studio.platform.updateAsset(selected.value!.id, { title: title.value.trim(), tags: tags.value.split(/[,，]/).map((tag) => tag.trim()).filter(Boolean) })); saving.value = false; if (result.ok) message.value = '素材信息已保存'; }
function useAsset() { if (!selected.value) return; studio.reuse(selected.value, role.value); selectedId.value = ''; void router.push('/create'); }
async function remove() { if (!selected.value) return; const result = await studio.act(() => studio.platform.deleteAsset(selected.value!.id)); if (result.ok) { deleting.value = false; selectedId.value = ''; } }
</script>
<template>
  <section class="page">
    <header class="page-header">
      <div>
        <h1>资产库</h1>
      </div><label class="upload-button"><Icon name="upload" />{{ uploading ? '上传中…' : '上传素材' }}<input
        aria-label="上传素材文件"
        type="file"
        accept="image/png,image/jpeg,image/webp,video/mp4,video/webm"
        multiple
        :disabled="uploading || !studio.ready"
        @change="onFiles"
      /></label>
    </header>
    <div class="toolbar panel">
      <div
        class="tabs"
        aria-label="素材类型"
      >
        <button
          v-for="[key, label] in [['all','全部'], ['video','视频'], ['image','图片'], ['text','文案']]"
          :key="key"
          :class="{ active: mediaType === key }"
          @click="mediaType = key!"
        >
          {{ label }}
        </button>
      </div><SelectMenu
        :model-value="source"
        class="source-filter"
        label="素材来源"
        :options="sourceOptions"
        @update:model-value="source = $event"
      /><label class="search"><Icon name="search" /><input
        v-model="search"
        aria-label="搜索素材"
        placeholder="搜索标题或标签"
      /></label>
    </div>
    <div
      v-if="!visible.length"
      class="panel empty-state"
      @dragover.prevent
      @drop.prevent="uploadFiles($event.dataTransfer?.files ?? null)"
    >
      <span class="empty-icon"><Icon
        name="assets"
        :size="30"
      /></span><h3>{{ studio.assets.length ? '无搜索结果' : '暂无素材' }}</h3><p>{{ studio.assets.length ? '调整关键词或筛选条件。' : '上传源素材，或将已审核的生成结果入库。' }}</p><small v-if="!studio.assets.length">支持 PNG / JPEG / WebP / MP4 / WebM，单文件最大 200 MB</small>
    </div>
    <div
      v-else
      class="card-grid"
      @dragover.prevent
      @drop.prevent="uploadFiles($event.dataTransfer?.files ?? null)"
    >
      <article
        v-for="asset in visible"
        :key="asset.id"
        class="asset-card"
      >
        <button
          class="asset-preview-button"
          :aria-label="`查看 ${asset.title}`"
          @click="open(asset)"
        >
          <div
            v-if="asset.availability === 'missing'"
            class="missing-preview"
          >
            <Icon
              name="info"
              :size="28"
            /><span>文件需重新选择</span>
          </div><MediaPreview
            v-else
            :media-id="asset.mediaFileId"
            :text="asset.text"
            :demo="asset.isDemo"
            compact
          />
        </button><div class="asset-info">
          <div class="row spread">
            <span :class="['badge', asset.source === 'generated' ? 'success' : 'neutral']">{{ sourceLabel(asset) }}</span><span
              v-if="asset.reviewValidity === 'review_invalidated'"
              class="badge failed"
            >审核已失效</span>
          </div><h3 class="truncate">
            {{ asset.title }}
          </h3><div
            v-if="asset.tags.length"
            class="row"
          >
            <span
              v-for="tag in asset.tags.slice(0,2)"
              :key="tag"
              class="tag"
            >{{ tag }}</span>
          </div><button
            class="small-button ghost"
            @click="open(asset)"
          >
            查看详情<Icon
              name="arrow"
              :size="14"
            />
          </button>
        </div>
      </article>
    </div>
    <Modal
      :open="Boolean(selected)"
      title="素材详情"
      wide
      @close="selectedId = ''"
    >
      <template v-if="selected">
        <p
          v-if="studio.error"
          class="notice error"
          role="alert"
        >
          {{ failureMessage(studio.error) }}
        </p>
        <div class="two-columns">
          <MediaPreview
            v-if="selected.availability !== 'missing'"
            :key="selected.mediaFileId"
            :media-id="selected.mediaFileId"
            :text="selected.text"
            :demo="selected.isDemo"
          /><div
            v-else
            class="preview"
          >
            <div class="empty-state">
              <Icon
                name="info"
                :size="28"
              /><h3>文件需重新选择</h3><input
                aria-label="重新选择文件"
                type="file"
                accept="image/*,video/mp4,video/webm"
                @change="restore"
              />
            </div>
          </div><div class="stack">
            <span class="badge neutral">{{ sourceLabel(selected) }}</span><label class="field">素材标题<input
              v-model="title"
              aria-label="素材标题"
            /></label><label class="field">人工标签<input
              v-model="tags"
              aria-label="素材标签"
              placeholder="多个标签用逗号分隔"
            /></label><dl class="asset-facts">
              <dt>格式</dt><dd>{{ selected.mediaType === 'video' ? '视频' : selected.mediaType === 'image' ? '图片' : '文案' }}</dd><template v-if="metadata">
                <dt>尺寸</dt><dd>{{ metadata.width }} × {{ metadata.height }}</dd><template v-if="metadata.durationMs">
                  <dt>时长</dt><dd>{{ metadata.durationMs / 1000 }} 秒</dd>
                </template>
              </template><dt>来源</dt><dd>{{ sourceLabel(selected) }}</dd>
            </dl><details class="metadata-details">
              <summary>开发诊断</summary>
              <dl>
                <template v-if="metadata">
                  <dt>MIME</dt><dd>{{ metadata.mime }}</dd><dt>内容哈希</dt><dd class="mono">
                    {{ metadata.sha256 }}
                  </dd>
                </template><dt>来源记录</dt><dd class="mono">
                  {{ selected.originItemId ?? '本地源素材 / 固定测试样例' }}
                </dd><template v-if="selected.reviewId">
                  <dt>审核记录 ID</dt><dd class="mono">
                    {{ selected.reviewId }}
                  </dd>
                </template>
              </dl>
            </details><button
              class="primary"
              :disabled="saving || !title.trim()"
              @click="save"
            >
              {{ saving ? '保存中…' : '保存素材信息' }}
            </button>
          </div>
        </div><p
          v-if="message"
          class="notice success"
          role="status"
        >
          {{ message }}
        </p><p
          v-if="selected.reviewValidity === 'review_invalidated'"
          class="notice error"
        >
          最新审核已改判为不通过，此资产保留追溯记录，已禁用新的复用。
        </p><div
          v-if="selected.mediaType === 'image'"
          class="field"
        >
          <span class="field-label">用于创作的参考角色</span><SelectMenu
            :model-value="role"
            label="复用参考角色"
            :options="roleOptions"
            @update:model-value="role = $event as GenerationReference['role']"
          />
        </div><div class="form-actions">
          <button
            class="danger"
            @click="deleting = true"
          >
            <Icon
              name="trash"
              :size="16"
            />删除库记录
          </button><button
            class="primary"
            :disabled="selected.availability !== 'available' || selected.reviewValidity === 'review_invalidated'"
            @click="useAsset"
          >
            用于创作<Icon
              name="arrow"
              :size="16"
            />
          </button>
        </div>
      </template>
    </Modal>
    <Modal
      :open="deleting"
      title="确认删除素材"
      @close="deleting = false"
    >
      <p>删除库记录不会删除已入库的衍生成果。运行中的任务引用此素材时，系统将拒绝删除。</p><p
        v-if="studio.error"
        class="notice error"
        role="alert"
      >
        {{ failureMessage(studio.error) }}
      </p><div class="form-actions">
        <button @click="deleting = false">
          保留素材
        </button><button
          class="danger"
          @click="remove"
        >
          确认删除
        </button>
      </div>
    </Modal>
  </section>
</template>
<style scoped>
.upload-button{position:relative;display:inline-flex;align-items:center;gap:8px;background:var(--accent);color:var(--text);padding:12px 18px;border-radius:8px;cursor:pointer;overflow:hidden;white-space:nowrap}.upload-button input{position:absolute;inset:0;width:100%;opacity:0;cursor:pointer}.upload-button:focus-within{outline:2px solid var(--accent-text);outline-offset:3px}.source-filter{width:180px!important}.asset-card{border:1px solid var(--border);border-radius:16px;overflow:hidden;background:var(--panel);transition:border-color .18s ease,transform .18s ease}.asset-card:hover{border-color:var(--accent);transform:translateY(-1px)}.asset-preview-button{display:block;position:relative;padding:0;width:100%;border:0;border-radius:0;height:184px;background:var(--input)}.asset-preview-button :deep(.preview){height:100%;border:0;border-radius:0;pointer-events:none}.asset-info{padding:16px;display:grid;gap:10px}.asset-info>.small-button{justify-self:end}.missing-preview{height:100%;display:grid;align-content:center;justify-items:center;gap:12px;color:var(--warning)}.asset-facts{margin:2px 0;display:grid;grid-template-columns:max-content 1fr;gap:8px 14px}.asset-facts dt{color:var(--muted)}.asset-facts dd{margin:0}.metadata-details{border-top:1px solid var(--border);border-bottom:1px solid var(--border);padding:13px 0;color:var(--muted)}.metadata-details summary{cursor:pointer;font-size:13px}.metadata-details summary:focus-visible{outline:2px solid var(--accent-text);outline-offset:3px}.metadata-details dl{margin:16px 0 2px;color:var(--text)}
</style>
