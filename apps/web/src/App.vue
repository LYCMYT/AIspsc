<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import type { ScenarioName } from '../../../packages/contracts/src/index';
import Icon from './components/Icon.vue';
import Modal from './components/Modal.vue';
import SelectMenu from './components/SelectMenu.vue';
import { useStudioStore } from './services/studio';
import { failureMessage, scenarioLabels } from './services/labels';
const navigation = [{ path: '/create', label: '创作', icon: 'create' }, { path: '/assets', label: '资产库', icon: 'assets' }, { path: '/history', label: '历史记录', icon: 'history' }, { path: '/decompose', label: '视频拆解', icon: 'decompose' }, { path: '/recognize', label: '素材识别', icon: 'recognize' }];
const scenarioOptions = (Object.entries(scenarioLabels) as [ScenarioName, string][]).map(([value, label]) => ({ value, label }));
const studio = useStudioStore(); const router = useRouter();
const settings = ref(false); const confirmingReset = ref(false); const confirmingDraft = ref(false); const ledger = ref(false); const resetting = ref(false); const scenario = ref<ScenarioName>('seed');
onMounted(() => { void studio.start(); }); onBeforeUnmount(() => studio.stop());
async function reset() { resetting.value = true; const result = await studio.resetScenario(scenario.value); resetting.value = false; if (result.ok) { confirmingReset.value = false; settings.value = false; await router.push('/create'); } }
function newDraft() { if (studio.draft.prompt.trim() || studio.draft.references.length) confirmingDraft.value = true; else void router.push('/create'); }
function clearDraft() { studio.resetDraft(); confirmingDraft.value = false; void router.push('/create'); }
</script>
<template>
  <div class="studio-shell">
    <aside class="sidebar">
      <RouterLink
        class="brand"
        to="/create"
        aria-label="多模型 AI营销视频生产平台"
      >
        <span class="brand-mark"><i /><i /><i /><i /></span><span><strong>多模型 AI</strong><small>营销视频生产平台</small></span>
      </RouterLink>
      <nav aria-label="主导航">
        <RouterLink
          v-for="entry in navigation"
          :key="entry.path"
          :to="entry.path"
          :aria-label="entry.label"
        >
          <Icon :name="entry.icon" /><span>{{ entry.label }}</span><span class="nav-indicator" />
        </RouterLink>
      </nav>
      <div class="sidebar-footer">
        <p class="quota-label">
          演示额度
        </p><strong class="quota-value">{{ studio.credits?.available ?? '—' }}</strong><div class="row spread quota-meta">
          <button
            class="text-button"
            @click="ledger = true"
          >
            额度流水
          </button>
        </div>
      </div>
    </aside>
    <div class="workspace">
      <header class="topbar">
        <button
          class="new-creation"
          @click="newDraft"
        >
          <Icon
            name="plus"
            :size="16"
          />新建创作
        </button><div class="topbar-right">
          <button
            class="environment-button"
            aria-label="演示工具"
            @click="settings = true"
          >
            <span class="status-dot" /><span>演示环境</span><Icon
              name="settings"
              :size="14"
            />
          </button>
        </div>
      </header>
      <main id="main-content">
        <div
          v-if="studio.error"
          class="notice error app-error"
          role="alert"
        >
          {{ failureMessage(studio.error) }} <button
            v-if="!studio.ready"
            class="small-button"
            @click="studio.start"
          >
            重新连接本地存储
          </button><button
            class="small-button ghost"
            aria-label="关闭错误提示"
            @click="studio.error = undefined"
          >
            <Icon
              name="close"
              :size="14"
            />
          </button>
        </div><RouterView />
      </main>
    </div>
    <Modal
      :open="settings"
      title="固定测试场景"
      @close="settings = false"
    >
      <p class="muted">
        重建测试样例。重置只清理本应用的演示任务、素材和额度。
      </p><div class="field">
        <span class="field-label">选择测试场景</span><SelectMenu
          :model-value="scenario"
          label="选择测试场景"
          :options="scenarioOptions"
          @update:model-value="scenario = $event as ScenarioName"
        />
      </div><div class="notice">
        当前：{{ studio.snapshot ? scenarioLabels[studio.snapshot.scenario] : '初始化中' }}。所有结果均为 Mock；无真实 Provider 调用。
      </div><button
        class="primary"
        @click="confirmingReset = true"
      >
        重置演示
      </button>
    </Modal>
    <Modal
      :open="confirmingReset"
      title="确认重置演示"
      @close="confirmingReset = false"
    >
      <p>将清除本应用的本地素材与演示记录，并载入“{{ scenarioLabels[scenario] }}”。</p><p
        v-if="studio.error"
        class="notice error"
        role="alert"
      >
        {{ failureMessage(studio.error) }}
      </p><div class="form-actions">
        <button @click="confirmingReset = false">
          保留当前数据
        </button><button
          class="danger"
          :disabled="resetting"
          @click="reset"
        >
          {{ resetting ? '重置中…' : '确认重置' }}
        </button>
      </div>
    </Modal>
    <Modal
      :open="confirmingDraft"
      title="新建创作"
      @close="confirmingDraft = false"
    >
      <p>当前有未提交内容。确认后清空当前表单，历史记录保留。</p><div class="form-actions">
        <button @click="confirmingDraft = false">
          继续编辑
        </button><button
          class="primary"
          @click="clearDraft"
        >
          确认新建
        </button>
      </div>
    </Modal>
    <Modal
      :open="ledger"
      title="演示额度流水"
      wide
      @close="ledger = false"
    >
      <div class="three-columns">
        <div class="notice">
          可用 <strong>{{ studio.credits?.available ?? 0 }}</strong>
        </div><div class="notice">
          预占 <strong>{{ studio.credits?.reserved ?? 0 }}</strong>
        </div><div class="notice">
          已消耗 <strong>{{ studio.credits?.spent ?? 0 }}</strong>
        </div>
      </div><div class="table-scroll">
        <table>
          <thead><tr><th>动作</th><th>额度</th><th>关联记录</th><th>时间</th></tr></thead><tbody>
            <tr
              v-for="(entry, index) in studio.snapshot?.ledger"
              :key="index"
            >
              <td>{{ ({ GRANT: '分配', RESERVE: '预占', COMMIT: '结算', RELEASE: '释放' })[entry.action] }}</td><td>{{ entry.units }}</td><td class="mono">
                {{ entry.referenceId }}
              </td><td>{{ new Date(entry.createdAt).toLocaleString('zh-CN') }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </Modal>
  </div>
</template>
