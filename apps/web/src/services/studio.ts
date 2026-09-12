import { defineStore } from 'pinia';
import { computed, markRaw, reactive, ref, shallowRef } from 'vue';
import type { Asset, CreateGenerationRequest, DemoSnapshot, DomainFailure, GenerationMode, GenerationReference, Result, ScenarioName } from '../../../../packages/contracts/src/index';
import { platform } from './platform';

export const useStudioStore = defineStore('studio', () => {
  const snapshot = shallowRef<DemoSnapshot>();
  const ready = ref(false); const loading = ref(false); const error = ref<DomainFailure>();
  const draft = reactive({ mode: 'video' as GenerationMode, prompt: '', references: [] as GenerationReference[], count: 1,
    video: { durationSeconds: 10, ratio: '9:16' as const as '9:16' | '16:9' | '1:1', resolution: '720p' as '720p' | '1080p', audio: false },
    image: { ratio: '1:1' as '9:16' | '16:9' | '1:1', resolution: '1024' }, copy: { language: 'zh-CN' as const, maxCharacters: 300 },
  });
  let timer: ReturnType<typeof setInterval> | undefined; let reading = false;
  const assets = computed(() => snapshot.value?.assets.filter((asset) => !asset.archivedAt) ?? []);
  const batches = computed(() => snapshot.value?.batches ?? []);
  const credits = computed(() => snapshot.value?.credits);
  async function refresh() {
    if (reading) return;
    reading = true;
    try { await platform.pump(); snapshot.value = await platform.snapshot(); }
    finally { reading = false; }
  }
  async function start() {
    if (timer) return;
    loading.value = true;
    try { await platform.ready(); await refresh(); ready.value = true; error.value = undefined;
      timer = setInterval(() => { void refresh().catch((cause: unknown) => { error.value = { code: 'STORAGE_UNAVAILABLE', message: cause instanceof Error ? cause.message : '无法恢复演示状态' }; }); }, 500);
    } catch (cause) { error.value = { code: 'STORAGE_UNAVAILABLE', message: cause instanceof Error ? cause.message : '无法读取本地存储' }; }
    finally { loading.value = false; }
  }
  function stop() { clearInterval(timer); timer = undefined; }
  async function act<T>(work: () => Promise<Result<T>>): Promise<Result<T>> {
    error.value = undefined;
    let result: Result<T>;
    try { result = await work(); }
    catch (cause) { const failure: DomainFailure = { code: 'NETWORK_ERROR', message: cause instanceof Error ? cause.message : '请求失败，请重试' }; error.value = failure; return { ok: false, error: failure }; }
    if (!result.ok) error.value = result.error;
    try { await refresh(); }
    catch (cause) {
      // A snapshot failure is independent of an already confirmed mutation result.
      error.value = { code: 'STORAGE_UNAVAILABLE', message: cause instanceof Error ? cause.message : '无法恢复演示状态' };
    }
    return result;
  }
  function buildRequest(): CreateGenerationRequest {
    const base = { prompt: draft.prompt, count: draft.count, references: draft.references.map(({ assetId, role }) => ({ assetId, role })) };
    if (draft.mode === 'video') return { ...base, mode: 'video', video: { ...draft.video } };
    if (draft.mode === 'image') return { ...base, mode: 'image', image: { ...draft.image } };
    return { ...base, mode: 'copy', copy: { ...draft.copy } };
  }
  function loadRequest(request: CreateGenerationRequest) {
    draft.mode = request.mode; draft.prompt = request.prompt; draft.count = request.count;
    draft.references = structuredClone(request.references);
    if (request.mode === 'video') Object.assign(draft.video, request.video);
    if (request.mode === 'image') Object.assign(draft.image, request.image);
    if (request.mode === 'copy') Object.assign(draft.copy, request.copy);
  }
  function resetDraft() {
    draft.mode = 'video'; draft.prompt = ''; draft.references = []; draft.count = 1;
    Object.assign(draft.video, { durationSeconds: 10, ratio: '9:16', resolution: '720p', audio: false });
    Object.assign(draft.image, { ratio: '1:1', resolution: '1024' });
    Object.assign(draft.copy, { language: 'zh-CN', maxCharacters: 300 });
  }
  function reuse(asset: Asset, role?: GenerationReference['role']) {
    if (asset.mediaType === 'text') { draft.prompt = asset.text ?? ''; draft.mode = 'copy'; draft.references = []; return; }
    draft.mode = 'video'; const chosenRole = role ?? (asset.mediaType === 'video' ? 'reference_video' : 'product');
    draft.references = [...draft.references.filter((reference) => reference.role !== chosenRole), { assetId: asset.id, role: chosenRole }];
  }
  async function resetScenario(name: ScenarioName) { const result = await act(() => platform.resetScenario(name, true)); if (result.ok) resetDraft(); return result; }
  return { snapshot, ready, loading, error, draft, assets, batches, credits, platform: markRaw(platform), start, stop, refresh, act, buildRequest, loadRequest, resetDraft, reuse, resetScenario };
});
