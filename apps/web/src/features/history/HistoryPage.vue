<script setup lang="ts">
import { failureMessage } from '../../services/labels';
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';
import type { DomainErrorCode, Evaluation, GenerationBatchSnapshot, GenerationItem } from '../../../../../packages/contracts/src/index';
import DownloadLink from '../../components/DownloadLink.vue';
import Icon from '../../components/Icon.vue';
import MediaPreview from '../../components/MediaPreview.vue';
import Modal from '../../components/Modal.vue';
import SelectMenu from '../../components/SelectMenu.vue';
import ReviewDialog from '../review/ReviewDialog.vue';
import { modeLabels, statusLabels } from '../../services/labels';
import { useStudioStore } from '../../services/studio';

const studio = useStudioStore();
const router = useRouter();
const search = ref('');
const mode = ref('all');
const state = ref('all');
const detailItem = ref<GenerationItem>();
const reviewItem = ref<GenerationItem>();
const cancelItem = ref<GenerationItem>();
const reconcileItem = ref<GenerationItem>();
const busyItemId = ref('');
const actionFailure = ref<Record<string, string>>({});
const copiedItemId = ref('');
// Ambiguous responses must replay the same command even after a refreshed snapshot.
const retryKeys = new Map<string, string>();
const stateOptions = [
  { value: 'all', label: '全部状态' },
  { value: 'queued', label: '队列中' },
  { value: 'running', label: '运行中' },
  { value: 'finalizing', label: '保存结果中' },
  { value: 'failed', label: '生成失败' },
  { value: 'needs_reconciliation', label: '待确认状态' },
  { value: 'cancel_requested', label: '取消确认中' },
  { value: 'succeeded', label: '生成成功' },
  { value: 'partial_succeeded', label: '部分成功' },
  { value: 'cancelled', label: '已取消' },
];
const itemErrorLabels: Partial<Record<DomainErrorCode, string>> = {
  NETWORK_ERROR: '产物下载失败',
  STORAGE_QUOTA_EXCEEDED: '本地存储空间不足',
  STORAGE_UNAVAILABLE: '本地文件暂不可用',
  FILE_FIXTURE_MISSING: '演示文件缺失',
  PROVIDER_OUTCOME_UNKNOWN: '结果未知，需人工确认',
  QUOTA_INSUFFICIENT: '演示额度不足',
  CANCELLED: '任务已取消',
  NO_COMPATIBLE_MODEL: '当前参数暂不支持',
  MEDIA_UNAVAILABLE: '参考素材不可用',
};

const batches = computed(() => studio.batches
  .filter((batch) => mode.value === 'all' || batch.requestSnapshot.mode === mode.value)
  .filter((batch) => state.value === 'all' || batch.status === state.value || batch.items.some((item) => item.status === state.value))
  .filter((batch) => batch.requestSnapshot.prompt.toLowerCase().includes(search.value.trim().toLowerCase()))
  .slice().reverse());

function latestEvaluation(item: GenerationItem): Evaluation | undefined {
  return studio.snapshot?.evaluations.filter((evaluation) => evaluation.itemId === item.id).at(-1);
}

function assetFor(item: GenerationItem) {
  return studio.snapshot?.assets.find((asset) => asset.originItemId === item.id);
}

function needsLibraryAction(item: GenerationItem) {
  return item.reviewState === 'approved' && (item.libraryState === 'not_saved' || assetFor(item)?.reviewValidity === 'review_invalidated');
}

function attemptFor(item: GenerationItem) {
  return studio.snapshot?.attempts.filter((attempt) => attempt.itemId === item.id).at(-1);
}

function batchFor(item: GenerationItem) {
  return studio.batches.find((batch) => batch.id === item.batchId);
}

const detailBatch = computed(() => detailItem.value ? batchFor(detailItem.value) : undefined);
const detailEvaluation = computed(() => detailItem.value ? latestEvaluation(detailItem.value) : undefined);
const detailParameters = computed(() => {
  const request = detailBatch.value?.requestSnapshot;
  if (!request) return [];
  const parameters = [
    { label: '生成类型', value: modeLabels[request.mode] },
    { label: '生成数量', value: `${request.count} 条` },
    { label: '参考素材', value: request.references.length ? `${request.references.length} 个` : '未使用' },
  ];
  if (request.mode === 'video') parameters.push(
    { label: '画面比例', value: request.video.ratio },
    { label: '分辨率', value: request.video.resolution },
    { label: '时长', value: `${request.video.durationSeconds} 秒` },
    { label: '音频', value: request.video.audio ? '开启' : '关闭' },
  );
  if (request.mode === 'image') parameters.push(
    { label: '画面比例', value: request.image.ratio },
    { label: '分辨率', value: request.image.resolution },
  );
  if (request.mode === 'copy') parameters.push(
    { label: '语言', value: '简体中文' },
    { label: '最多字符', value: `${request.copy.maxCharacters} 字` },
  );
  return parameters;
});

function reviewLabel(item: GenerationItem) {
  if (item.reviewState === 'pending') return '待审核';
  if (needsLibraryAction(item)) return '通过，待手动入库';
  if (item.reviewState === 'approved') return '已通过并入库';
  return '审核不通过';
}

function failure(item: GenerationItem, message: string) {
  actionFailure.value = { ...actionFailure.value, [item.id]: message };
}

function clearFailure(item: GenerationItem) {
  const next = { ...actionFailure.value };
  delete next[item.id];
  actionFailure.value = next;
}

async function copyText(item: GenerationItem) {
  if (!item.text) return;
  clearFailure(item);
  try { await navigator.clipboard.writeText(item.text); copiedItemId.value = item.id; }
  catch { failure(item, '无法写入剪贴板，请手动选择文案复制'); }
}

async function saveToLibrary(item: GenerationItem) {
  const evaluation = latestEvaluation(item);
  if (!evaluation || busyItemId.value) return;
  busyItemId.value = item.id;
  clearFailure(item);
  const result = await studio.act(() => studio.platform.asset.saveApprovedOutput(item.id, evaluation.id));
  busyItemId.value = '';
  if (!result.ok) failure(item, failureMessage(result.error));
}

async function confirmCancel() {
  const item = cancelItem.value;
  if (!item || busyItemId.value) return;
  busyItemId.value = item.id;
  clearFailure(item);
  const result = await studio.act(() => studio.platform.generation.cancel(item.id, item.version));
  busyItemId.value = '';
  if (!result.ok) { failure(item, failureMessage(result.error)); return; }
  cancelItem.value = undefined;
}

async function retry(item: GenerationItem) {
  if (busyItemId.value) return;
  busyItemId.value = item.id;
  clearFailure(item);
  const idempotencyKey = retryKeys.get(item.id) ?? crypto.randomUUID();
  retryKeys.set(item.id, idempotencyKey);
  const result = await studio.act(() => studio.platform.generation.retry(item.id, { idempotencyKey }));
  if (result.ok || result.error.code !== 'NETWORK_ERROR') retryKeys.delete(item.id);
  busyItemId.value = '';
  if (!result.ok) failure(item, failureMessage(result.error));
}

async function retryDownload(item: GenerationItem) {
  if (busyItemId.value) return;
  busyItemId.value = item.id;
  clearFailure(item);
  const result = await studio.act(() => studio.platform.retryDownload(item.id));
  busyItemId.value = '';
  if (!result.ok) failure(item, failureMessage(result.error));
}

async function reconcile(outcome: 'success' | 'failure') {
  const item = reconcileItem.value;
  if (!item || busyItemId.value) return;
  busyItemId.value = item.id;
  clearFailure(item);
  const result = await studio.act(() => studio.platform.resolveUnknown(item.id, outcome));
  busyItemId.value = '';
  if (!result.ok) { failure(item, failureMessage(result.error)); return; }
  reconcileItem.value = undefined;
}

function useConfiguration(batch: GenerationBatchSnapshot) {
  studio.loadRequest(batch.requestSnapshot);
  void router.push('/create');
}

function reviewSaved() {
  reviewItem.value = undefined;
}

function formatDate(value: string) {
  return new Date(value).toLocaleString('zh-CN', { hour12: false });
}

function errorMessage(item: GenerationItem) {
  return item.errorCode ? itemErrorLabels[item.errorCode] ?? '任务未完成，请查看详情' : '';
}
</script>

<template>
  <section class="page history-page">
    <header class="page-header">
      <h1>历史记录</h1>
    </header>
    <div class="toolbar panel">
      <div
        class="tabs"
        aria-label="历史模态筛选"
      >
        <button
          v-for="[key, label] in [['all','全部'], ['video','视频'], ['image','图片'], ['copy','文案']]"
          :key="key"
          :class="{ active: mode === key }"
          @click="mode = key!"
        >
          {{ label }}
        </button>
      </div>
      <SelectMenu
        :model-value="state"
        class="status-filter"
        label="任务状态筛选"
        :options="stateOptions"
        @update:model-value="state = $event"
      />
      <label class="search"><Icon name="search" /><input
        v-model="search"
        aria-label="搜索 Prompt"
        placeholder="搜索 Prompt"
      /></label>
    </div>

    <div
      v-if="!batches.length"
      class="panel empty-state"
    >
      <span class="empty-icon"><Icon
        name="history"
        :size="30"
      /></span><h3>{{ studio.batches.length ? '无搜索结果' : '暂无历史记录' }}</h3><p>{{ studio.batches.length ? '调整 Prompt 关键词或筛选条件。' : '提交创作后，批次和每条结果会在这里显示。' }}</p><RouterLink
        v-if="!studio.batches.length"
        class="primary-link"
        to="/create"
      >
        开始创作
      </RouterLink>
    </div>

    <article
      v-for="batch in batches"
      :key="batch.id"
      class="batch panel"
      data-testid="batch-card"
    >
      <header class="batch-header">
        <div class="stack batch-title">
          <div class="row">
            <span :class="['badge', ['succeeded','partial_succeeded'].includes(batch.status) ? 'success' : batch.status === 'failed' ? 'failed' : 'pending']">{{ statusLabels[batch.status] }}</span><span class="badge neutral">{{ modeLabels[batch.requestSnapshot.mode] }}</span><time class="muted">{{ formatDate(batch.createdAt) }}</time>
          </div><h2>{{ batch.requestSnapshot.prompt }}</h2><p class="muted">
            {{ batch.items.filter((item) => item.status === 'succeeded').length }} / {{ batch.requestedCount }} 条成功
          </p>
        </div>
        <button
          class="small-button ghost"
          @click="useConfiguration(batch)"
        >
          <Icon
            name="retry"
            :size="15"
          />复制配置到创作
        </button>
      </header>
      <div class="item-grid">
        <section
          v-for="item in batch.items"
          :key="item.id"
          class="result-card"
          data-testid="result-card"
        >
          <MediaPreview
            v-if="item.status === 'succeeded'"
            :media-id="item.resultMediaId"
            :text="item.text"
            demo
          />
          <div
            v-else
            class="result-placeholder"
          >
            <Icon
              :name="item.status === 'failed' ? 'info' : 'history'"
              :size="28"
            /><small v-if="item.errorCode">{{ errorMessage(item) }}</small><small v-else-if="item.status === 'queued'">等待演示任务开始</small><small v-else-if="item.status === 'running'">演示任务处理中</small><small v-else-if="item.status === 'finalizing'">正在保存并校验本地文件</small><small v-else-if="item.status === 'cancel_requested'">正在确认取消，结果仍可能返回</small><small v-else-if="item.status === 'needs_reconciliation'">结果未知，需人工确认</small>
          </div>
          <div class="result-body">
            <div class="row spread">
              <strong>结果 {{ item.index + 1 }}</strong><span :class="['badge', item.status === 'succeeded' ? 'success' : item.status === 'failed' ? 'failed' : 'pending']">{{ statusLabels[item.status] }}</span>
            </div>
            <small
              v-if="item.retryOfItemId"
              class="muted"
            >重新生成</small>
            <template v-if="item.status === 'succeeded'">
              <div class="review-state">
                <span
                  v-if="item.reviewState === 'pending'"
                  class="badge pending"
                >待审核</span>
                <span
                  v-else-if="needsLibraryAction(item)"
                  class="badge success"
                >通过未入库</span>
                <span
                  v-else-if="item.reviewState === 'approved'"
                  class="badge success"
                >已入库</span>
                <span
                  v-else
                  class="badge failed"
                >审核不通过</span>
              </div>
              <p
                v-if="assetFor(item)?.reviewValidity === 'review_invalidated'"
                class="notice error"
              >
                审核已改判，原资产审核已失效，不能继续作为新任务参考。
              </p>
              <div class="result-actions">
                <button
                  v-if="item.reviewState === 'pending'"
                  class="small-button primary"
                  @click="reviewItem = item"
                >
                  人工审核
                </button>
                <button
                  v-else
                  class="small-button ghost"
                  @click="reviewItem = item"
                >
                  改判
                </button>
                <button
                  v-if="needsLibraryAction(item)"
                  class="small-button primary"
                  :disabled="busyItemId === item.id"
                  @click="saveToLibrary(item)"
                >
                  {{ busyItemId === item.id ? '入库中…' : '入库' }}
                </button>
                <button
                  v-if="item.reviewState === 'rejected'"
                  class="small-button ghost"
                  @click="useConfiguration(batch)"
                >
                  复制配置回创作
                </button>
                <button
                  v-if="item.mode === 'copy'"
                  class="small-button ghost"
                  @click="copyText(item)"
                >
                  <Icon
                    name="copy"
                    :size="14"
                  />{{ copiedItemId === item.id ? '已复制' : '复制文案' }}
                </button>
                <DownloadLink
                  v-else-if="item.resultMediaId"
                  :media-id="item.resultMediaId"
                  :filename="`演示结果-${item.id}.${item.mode === 'video' ? 'mp4' : 'png'}`"
                />
                <button
                  class="small-button ghost"
                  aria-label="只读详情"
                  @click="detailItem = item"
                >
                  详情
                </button>
              </div>
            </template>
            <template v-else>
              <div class="result-actions">
                <button
                  v-if="['queued','running'].includes(item.status)"
                  class="small-button danger"
                  @click="cancelItem = item"
                >
                  取消任务
                </button>
                <button
                  v-if="['failed','cancelled'].includes(item.status)"
                  class="small-button primary"
                  :disabled="busyItemId === item.id"
                  @click="retry(item)"
                >
                  {{ busyItemId === item.id ? '提交中…' : '重新生成' }}
                </button>
                <button
                  v-if="item.status === 'needs_reconciliation'"
                  class="small-button primary"
                  @click="reconcileItem = item"
                >
                  模拟对账
                </button>
                <button
                  v-if="item.status === 'finalizing' && item.errorCode"
                  class="small-button primary"
                  :disabled="busyItemId === item.id"
                  @click="retryDownload(item)"
                >
                  {{ busyItemId === item.id ? '恢复中…' : '重试下载' }}
                </button>
                <button
                  class="small-button ghost"
                  aria-label="只读详情"
                  @click="detailItem = item"
                >
                  详情
                </button>
              </div>
            </template>
            <p
              v-if="actionFailure[item.id]"
              class="notice error"
              role="alert"
            >
              {{ actionFailure[item.id] }}
            </p>
          </div>
        </section>
      </div>
    </article>

    <ReviewDialog
      :item="reviewItem"
      :open="Boolean(reviewItem)"
      @close="reviewItem = undefined"
      @saved="reviewSaved"
    />

    <Modal
      :open="Boolean(cancelItem)"
      title="确认取消任务"
      @close="cancelItem = undefined"
    >
      <template v-if="cancelItem">
        <p>运行中的外部任务会先进入“取消确认中”。若结果已经完成，任务仍可能收敛为成功并结算实际额度。</p><p
          v-if="actionFailure[cancelItem.id]"
          class="notice error"
          role="alert"
        >
          {{ actionFailure[cancelItem.id] }}
        </p><div class="form-actions">
          <button @click="cancelItem = undefined">
            继续等待
          </button><button
            class="danger"
            :disabled="busyItemId === cancelItem.id"
            @click="confirmCancel"
          >
            {{ busyItemId === cancelItem.id ? '提交中…' : '确认取消' }}
          </button>
        </div>
      </template>
    </Modal>

    <Modal
      :open="Boolean(reconcileItem)"
      title="模拟对账"
      @close="reconcileItem = undefined"
    >
      <template v-if="reconcileItem">
        <p class="notice warning">
          这是固定测试场景的人工对账入口。未知结果不会自动重发生成请求，也不会立即释放预占额度。
        </p><p
          v-if="actionFailure[reconcileItem.id]"
          class="notice error"
          role="alert"
        >
          {{ actionFailure[reconcileItem.id] }}
        </p><div class="form-actions">
          <button @click="reconcileItem = undefined">
            保持待确认
          </button><button
            :disabled="busyItemId === reconcileItem.id"
            @click="reconcile('failure')"
          >
            对账为失败
          </button><button
            class="primary"
            :disabled="busyItemId === reconcileItem.id"
            @click="reconcile('success')"
          >
            对账为成功
          </button>
        </div>
      </template>
    </Modal>

    <Modal
      :open="Boolean(detailItem)"
      title="任务只读详情"
      wide
      @close="detailItem = undefined"
    >
      <template v-if="detailItem">
        <div
          v-if="detailBatch"
          class="two-columns detail-overview"
        >
          <section class="stack">
            <h3>创作内容</h3><p class="detail-prompt">
              {{ detailBatch.requestSnapshot.prompt }}
            </p><dl class="detail-list">
              <template
                v-for="parameter in detailParameters"
                :key="parameter.label"
              >
                <dt>{{ parameter.label }}</dt><dd>{{ parameter.value }}</dd>
              </template>
            </dl>
          </section>
          <section class="stack">
            <h3>结果与审核</h3><dl class="detail-list">
              <dt>结果</dt><dd>第 {{ detailItem.index + 1 }} 条</dd><dt>任务状态</dt><dd>{{ statusLabels[detailItem.status] }}</dd><dt>审核状态</dt><dd>{{ reviewLabel(detailItem) }}</dd><template v-if="detailEvaluation?.score">
                <dt>综合分</dt><dd>{{ detailEvaluation.score }} / 10</dd>
              </template><template v-if="detailEvaluation">
                <dt>审核结论</dt><dd>{{ detailEvaluation.decision === 'approved' ? '通过' : '不通过' }}</dd><dt>审核摘要</dt><dd>{{ detailEvaluation.reason || '无补充说明' }}</dd>
              </template>
            </dl>
          </section>
        </div>
        <details class="developer-details">
          <summary>开发诊断</summary><p class="diagnostic-note">
            以下信息只用于开发排查。
          </p><div class="two-columns">
            <section class="stack">
              <h3>请求快照</h3><pre>{{ JSON.stringify(batchFor(detailItem)?.requestSnapshot, null, 2) }}</pre><h3>输出快照</h3><dl>
                <dt>批次 ID</dt><dd class="mono">
                  {{ detailItem.batchId }}
                </dd><dt>子任务 ID</dt><dd class="mono">
                  {{ detailItem.id }}
                </dd><template v-if="detailItem.retryOfItemId">
                  <dt>重试自</dt><dd class="mono">
                    {{ detailItem.retryOfItemId }}
                  </dd>
                </template><template v-if="detailItem.errorCode">
                  <dt>错误码</dt><dd class="mono">
                    {{ detailItem.errorCode }}
                  </dd>
                </template><dt>状态</dt><dd>{{ statusLabels[detailItem.status] }}</dd><dt>媒体 ID</dt><dd class="mono">
                  {{ detailItem.resultMediaId ?? '无' }}
                </dd><dt>版本</dt><dd>{{ detailItem.version }}</dd>
              </dl>
            </section>
            <section class="stack">
              <h3>路由诊断</h3><dl>
                <dt>执行器</dt><dd class="mono">
                  {{ detailItem.routingSnapshot.modelKey }}
                </dd><dt>绑定 ID</dt><dd class="mono">
                  {{ detailItem.routingSnapshot.bindingId }}
                </dd><dt>规则版本</dt><dd>{{ detailItem.routingSnapshot.ruleVersion }}</dd><dt>原因</dt><dd>{{ detailItem.routingSnapshot.reason }}</dd>
              </dl><pre>{{ JSON.stringify(detailItem.routingSnapshot.capabilitySnapshot, null, 2) }}</pre><h3>价格与执行</h3><dl>
                <dt>价格版本</dt><dd>{{ detailItem.pricingSnapshot.version }}</dd><dt>单位成本</dt><dd>{{ detailItem.pricingSnapshot.unitCost }} 演示额度</dd><dt>外部任务</dt><dd class="mono">
                  {{ attemptFor(detailItem)?.externalJobId ?? '无可查询 ID' }}
                </dd><dt>提交状态</dt><dd>{{ attemptFor(detailItem)?.submissionState ?? '无' }}</dd>
              </dl>
            </section>
          </div><hr class="divider" /><h3>审核版本</h3><pre>{{ JSON.stringify(studio.snapshot?.evaluations.filter((evaluation) => evaluation.itemId === detailItem?.id) ?? [], null, 2) }}</pre><h3>额度流水 ID</h3><pre>{{ JSON.stringify(studio.snapshot?.ledger.filter((entry) => entry.referenceId === detailItem?.id).map((entry) => ({ referenceId: entry.referenceId, action: entry.action, units: entry.units })), null, 2) }}</pre>
        </details>
      </template>
    </Modal>
  </section>
</template>

<style scoped>
.primary-link{display:inline-flex;align-items:center;gap:8px;padding:11px 16px;border-radius:8px}.status-filter{width:180px!important}.batch{display:grid;gap:22px;padding:24px}.batch-header{display:flex;align-items:flex-start;justify-content:space-between;gap:24px}.batch-title{gap:7px;min-width:0}.batch-title h2{max-width:920px;margin-top:2px;overflow-wrap:anywhere;font-size:19px;line-height:1.45}.item-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px}.result-card{border:1px solid var(--border);border-radius:14px;background:var(--input);overflow:hidden;min-width:0}.result-card :deep(.preview){height:232px;border:0;border-radius:0;border-bottom:1px solid var(--border)}.result-placeholder{height:232px;display:grid;place-items:center;align-content:center;gap:12px;text-align:center;color:var(--muted);border-bottom:1px solid var(--border);padding:24px}.result-placeholder small{max-width:280px;line-height:1.55}.result-body{padding:16px;display:grid;gap:13px}.review-state{display:flex;align-items:center;gap:9px;flex-wrap:wrap}.result-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.result-actions :deep(.download-link){min-height:32px;padding:5px 10px}.detail-overview{margin-bottom:20px}.detail-overview>section{padding:16px;border:1px solid var(--border);border-radius:12px;background:var(--input)}.detail-prompt{line-height:1.7;overflow-wrap:anywhere}.detail-list{display:grid;grid-template-columns:max-content 1fr;gap:9px 16px;margin:0}.detail-list dt{color:var(--muted)}.detail-list dd{margin:0;overflow-wrap:anywhere}.developer-details{padding-top:16px;border-top:1px solid var(--border)}.developer-details summary{width:max-content;cursor:pointer;color:var(--muted)}.developer-details summary:focus-visible{outline:2px solid var(--accent-text);outline-offset:3px}.developer-details[open] summary{margin-bottom:14px}.diagnostic-note{margin:0 0 18px;color:var(--muted);font-size:13px}@media(max-width:1200px){.item-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}@media(max-width:760px){.batch-header,.detail-overview{grid-template-columns:1fr}.item-grid{grid-template-columns:1fr}}
</style>
