<script setup lang="ts">
import { failureMessage } from '../../services/labels';
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';
import { useStudioStore } from '../../services/studio';
import Icon from '../../components/Icon.vue';
import MediaPreview from '../../components/MediaPreview.vue';
import SelectMenu from '../../components/SelectMenu.vue';
import UploadDropzone from '../../components/UploadDropzone.vue';
const studio = useStudioStore(); const router = useRouter(); const selectedId = ref(''); const tags = ref(''); const busy = ref(false); const saved = ref(false);
const uploadBusy = ref(false); const uploadError = ref(''); let selectionVersion = 0;
const assets = computed(() => studio.assets.filter((asset) => asset.mediaType === 'video' || asset.mediaType === 'image'));
const assetOptions = computed(() => assets.value.map((asset) => ({ value: asset.id, label: asset.title, disabled: asset.availability !== 'available' })));
const selected = computed(() => assets.value.find((asset) => asset.id === selectedId.value));
const media = computed(() => studio.snapshot?.mediaMetadata.find((entry) => entry.id === selected.value?.mediaFileId));
const fixture = computed(() => media.value?.fixtureKey?.startsWith('image-') || media.value?.fixtureKey === 'scene-source');
function choose(id: string) { selectionVersion += 1; selectedId.value = id; tags.value = selected.value?.tags.join('，') ?? ''; saved.value = false; uploadError.value = ''; }
async function sample() { busy.value = true; const result = await studio.act(() => studio.platform.loadFixture('image-1x1-1024')); busy.value = false; if (result.ok) choose(result.value.id); }
async function upload(file: File) {
  if (busy.value) return;
  busy.value = true; uploadBusy.value = true; uploadError.value = ''; const version = selectionVersion;
  const result = await studio.act(() => studio.platform.upload(file, file.name));
  busy.value = false; uploadBusy.value = false;
  if (version !== selectionVersion) return;
  if (result.ok) choose(result.value.id);
  else { uploadError.value = failureMessage(result.error); studio.error = undefined; }
}
async function save() { if (!selected.value) return; busy.value = true; saved.value = false; const result = await studio.act(() => studio.platform.updateAsset(selected.value!.id, { title: selected.value!.title, tags: tags.value.split(/[,，]/).map((tag) => tag.trim()).filter(Boolean) })); busy.value = false; saved.value = result.ok; }
function reuse() { if (!selected.value) return; studio.reuse(selected.value); void router.push('/create'); }
</script>
<template>
  <section class="page">
    <header class="page-header">
      <h1>素材识别</h1>
    </header>
    <UploadDropzone
      input-label="上传识别素材"
      kind="media"
      :compact="!!selected"
      :busy="uploadBusy"
      :disabled="busy || !studio.ready"
      :error="uploadError"
      @file="upload"
      @invalid="uploadError = $event"
    />
    <div class="source-toolbar">
      <SelectMenu
        :model-value="selectedId"
        label="选择识别素材"
        placeholder="从资产库选择"
        :options="assetOptions"
        :disabled="busy"
        @update:model-value="choose"
      /><button
        :disabled="busy || !studio.ready"
        @click="sample"
      >
        <Icon
          name="recognize"
          :size="16"
        />使用识别样例
      </button>
    </div>
    <div
      v-if="!selected"
      class="panel empty-state tool-empty"
    >
      <span class="empty-icon"><Icon
        name="recognize"
        :size="32"
      /></span><h3>暂无识别结果</h3>
    </div>
    <div
      v-else
      class="recognize-layout"
    >
      <div class="panel stack">
        <div class="panel-header">
          <span class="badge neutral">{{ selected.source === 'upload' ? '上传源素材' : selected.source === 'generated' ? '已审核生成结果' : '固定演示源' }}</span><button
            class="icon-button ghost"
            aria-label="移除文件"
            :disabled="busy"
            @click="choose('')"
          >
            <Icon
              name="close"
              :size="16"
            />
          </button>
        </div><MediaPreview
          :media-id="selected.mediaFileId"
          :demo="selected.isDemo"
        /><h3>{{ selected.title }}</h3><p
          v-if="media"
          class="muted"
        >
          {{ selected.mediaType === 'video' ? '视频' : '图片' }} · {{ media.width }} × {{ media.height }} · {{ media.byteSize >= 1048576 ? `${(media.byteSize / 1048576).toFixed(1)} MB` : `${(media.byteSize / 1024).toFixed(1)} KB` }}<template v-if="media.durationMs">
            · {{ media.durationMs / 1000 }} 秒
          </template>
        </p>
        <p
          v-if="selected.availability !== 'available'"
          class="notice warning"
        >
          文件需重新选择
        </p>
      </div><div class="panel stack recognition-editor">
        <section class="stack">
          <div class="panel-header">
            <h2>内容标签</h2>
          </div><template v-if="fixture">
            <div class="notice">
              固定样例 · 预设标签，非 AI 分析
            </div><div class="sample-tags">
              <div><small class="muted">主体样例</small><h3>几何图形</h3></div><div><small class="muted">场景样例</small><h3>纯色测试背景</h3></div>
            </div>
          </template><div
            v-else
            class="unknown-state"
          >
            <Icon
              name="info"
              :size="26"
            /><h3>内容识别未执行</h3>
          </div>
        </section><section class="stack manual-tags">
          <h2>人工标签</h2><label class="field">标签内容<input
            v-model="tags"
            aria-label="人工标签"
            placeholder="输入人工确认的标签，以逗号分隔"
            @input="saved = false"
          /></label><p
            v-if="saved"
            class="notice success"
            role="status"
          >
            人工标签已保存
          </p><div class="form-actions">
            <button
              :disabled="busy"
              @click="save"
            >
              {{ busy ? '保存中…' : '保存人工标签' }}
            </button><button
              class="primary"
              :disabled="selected.availability !== 'available' || selected.reviewValidity === 'review_invalidated'"
              @click="reuse"
            >
              用于创作<Icon
                name="arrow"
                :size="16"
              />
            </button>
          </div>
        </section>
      </div>
    </div>
  </section>
</template>
<style scoped>
.recognize-layout{display:grid;grid-template-columns:1fr 1.1fr;gap:20px}.recognize-layout .preview{height:270px}.recognize-layout .panel-header{margin-bottom:0}.recognize-layout h3{overflow-wrap:anywhere}.sample-tags{display:grid;grid-template-columns:1fr 1fr;gap:12px}.sample-tags>div{padding:14px;background:var(--input);border-radius:8px}.sample-tags h3{margin-top:8px}.recognition-editor{align-content:start;gap:20px}.manual-tags{border-top:1px solid var(--border);padding-top:20px}.unknown-state{display:flex;align-items:center;gap:10px;color:var(--muted);padding:4px 0}.unknown-state h3{font-size:14px;font-weight:500;color:var(--text)}@media(max-width:900px){.recognize-layout{grid-template-columns:1fr}}
</style>
