import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { decideReview } from '../../domain/src/review.ts';
import type { VideoReviewInput } from '../../contracts/src/generation.ts';
import { decodeVideo, MAX_MEDIA_BYTES, probeVideo, processDelivery, readMp4 } from '../../media-processing/src/processor.ts';
import type { DeliveryReport } from '../../media-processing/src/processor.ts';
import { planDelivery, validateTarget } from '../../media-processing/src/policy.ts';
import type { DeliveryTarget, VideoFacts } from '../../media-processing/src/policy.ts';
export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, code: string) { super(code); this.status = status; }
}
const digest = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const timestamp = () => new Date().toISOString();
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
interface StoredReview { id: string; revision: number; resultSha256: string; decision: 'approved' | 'rejected'; form: VideoReviewInput; reason: string; createdAt: string }
export interface DeliveryTask {
  id: string; version: number; prompt: string; createdAt: string;
  source: { kind: 'operator_import'; sha256: string; byteSize: number; media: VideoFacts };
  status: 'source_ready' | 'processing' | 'ready' | 'failed' | 'interrupted';
  reviewState: 'pending' | 'approved' | 'rejected';
  libraryState: 'not_saved' | 'saved' | 'review_invalidated';
  derivative?: { id: string; report: DeliveryReport };
  processingId?: string; errorCode?: string; reviews: StoredReview[];
}
interface StoredAsset { id: string; taskId: string; reviewId: string; resultSha256: string; valid: boolean; createdAt: string }
interface StoreState {
  version: 1; tasks: DeliveryTask[]; assets: StoredAsset[];
  memo: Record<string, { hash: string; id: string }>;
  audit: Array<{ id: string; taskId: string; action: string; at: string }>;
}
const fresh = (): StoreState => ({ version: 1, tasks: [], assets: [], memo: {}, audit: [] });
export function strictObject(value: unknown, fields: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !fields.includes(key))) throw new ApiError(400, 'INVALID_BODY');
  return value as Record<string, unknown>;
}
function reviewForm(value: unknown): VideoReviewInput {
  const v = strictObject(value, ['rubricVersion','score','applicability','issueTags','hardFailures','technicalErrors','notes']);
  const ids = Array.from({length:11},(_,i)=>`Q${String(i+1).padStart(2,'0')}`);
  if (v.rubricVersion !== 'rubric-v2-rebuild' || !Number.isInteger(v.score) || Number(v.score)<1 || Number(v.score)>10) throw new ApiError(400,'INVALID_REVIEW');
  const app = strictObject(v.applicability, ids);
  for (const id of ids) {
    const a = strictObject(app[id], ['applicable','reason']);
    if (typeof a.applicable !== 'boolean' || (a.reason !== undefined && (typeof a.reason !== 'string' || a.reason.length > 1000))) throw new ApiError(400,'INVALID_REVIEW');
  }
  for (const [field, allowed] of [['issueTags', ids], ['hardFailures',['H01','H02','H03']], ['technicalErrors',['TECH_CORRUPT','TECH_DURATION','TECH_RESOLUTION','TECH_AUDIO']]] as const) {
    if (!Array.isArray(v[field]) || v[field].length > 20 || v[field].some((item: unknown) => typeof item !== 'string' || !(allowed as readonly string[]).includes(item))) throw new ApiError(400,'INVALID_REVIEW');
  }
  if (v.notes !== undefined && (typeof v.notes !== 'string' || v.notes.length > 4000)) throw new ApiError(400,'INVALID_REVIEW');
  return structuredClone(v) as unknown as VideoReviewInput;
}
async function atomicJson(path: string, state: StoreState) {
  const temporary = path + '.' + randomUUID() + '.pending';
  const handle = await open(temporary,'wx',0o600);
  try { await handle.writeFile(JSON.stringify(state)); await handle.sync(); } finally { await handle.close(); }
  try { await rename(temporary,path); } finally { await rm(temporary,{force:true}); }
}
export class DeliveryStore {
  private state: StoreState;
  private queue: Promise<unknown> = Promise.resolve();
  private workers = new Set<Promise<void>>();
  private closed = false;
  private readonly root: string;
  private readonly lock: FileHandle;
  private constructor(root: string, lock: FileHandle, state: StoreState) { this.root=root;this.lock=lock;this.state = state; }
  static async open(directory: string): Promise<DeliveryStore> {
    const root=resolve(directory); await mkdir(root,{recursive:true,mode:0o700});
    const info=await lstat(root); if(!info.isDirectory() || info.isSymbolicLink()) throw new Error('INVALID_STORE_DIRECTORY');
    let lock: FileHandle;
    try { lock=await open(join(root,'.lock'),'wx',0o600); } catch { throw new Error('STORE_LOCKED'); }
    try {
      await lock.writeFile(String(process.pid));
      await mkdir(join(root,'tasks'),{recursive:true,mode:0o700});
      if ((await lstat(join(root,'tasks'))).isSymbolicLink()) throw new Error('INVALID_STORE_DIRECTORY');
      let state=fresh();
      try {
        const p=join(root,'state.json'); if((await lstat(p)).isSymbolicLink())throw new Error('INVALID_STORE');
        state=JSON.parse(await readFile(p,'utf8')) as StoreState;
      } catch(error) { if((error as NodeJS.ErrnoException).code!=='ENOENT')throw new Error('INVALID_STORE', {cause:error}); }
      if(state.version!==1 || !Array.isArray(state.tasks) || !Array.isArray(state.assets) || !Array.isArray(state.audit) || !state.memo ||
          state.tasks.some(t=>!uuid.test(t.id) || !Number.isSafeInteger(t.version) || (t.derivative && !uuid.test(t.derivative.id))))throw new Error('INVALID_STORE');
      for(const task of state.tasks) if(task.status==='processing') {
        task.status='interrupted';task.errorCode='PROCESS_INTERRUPTED';task.version++;task.reviewState='pending';
        for (const asset of state.assets) if (asset.taskId===task.id) {asset.valid=false;task.libraryState='review_invalidated';}
        state.audit.push({id:randomUUID(),taskId:task.id,action:'restart_interrupted',at:timestamp()});
      }
      await atomicJson(join(root,'state.json'),state);
      return new DeliveryStore(root,lock,state);
    } catch(error) { await lock.close();await rm(join(root,'.lock'),{force:true});throw error; }
  }
  private async mutate<T>(action:(state:StoreState)=>Promise<T>|T):Promise<T> {
    const run=async()=>{if(this.closed)throw new ApiError(503,'STORE_CLOSED');const next=structuredClone(this.state);const result=await action(next);await atomicJson(join(this.root,'state.json'),next);this.state=next;return structuredClone(result);};
    const job=this.queue.then(run,run);this.queue=job.catch(()=>{});return job;
  }
  snapshot(){return structuredClone({tasks:this.state.tasks,assets:this.state.assets,audit:this.state.audit});}
  private get(state:StoreState,id:string){const task=state.tasks.find(t=>t.id===id);if(!task || !uuid.test(id))throw new ApiError(404,'TASK_NOT_FOUND');return task;}
  getTask(id:string){return structuredClone(this.get(this.state,id));}
  private checkVersion(task:DeliveryTask,version:unknown){if(!Number.isSafeInteger(version))throw new ApiError(400,'VERSION_REQUIRED');if(task.version!==version)throw new ApiError(409,'VERSION_CONFLICT');}
  private memo(state:StoreState,scope:string,key:string,payload:unknown) {
    if(!/^[a-zA-Z0-9_-]{1,100}$/.test(key))throw new ApiError(400,'IDEMPOTENCY_KEY_REQUIRED');
    const name=`${scope}/${key}`;const hash=digest(JSON.stringify(payload));const prior=state.memo[name];
    if(prior && prior.hash!==hash)throw new ApiError(409,'IDEMPOTENCY_CONFLICT');
    if(!prior && Object.keys(state.memo).length>=5000)throw new ApiError(503,'STORE_CAPACITY');
    return { prior, save:(id:string)=>{state.memo[name]={hash,id};} };
  }
  private audit(state:StoreState,task:DeliveryTask,action:string){state.audit.push({id:randomUUID(),taskId:task.id,action,at:timestamp()});}
  private invalidate(state:StoreState,task:DeliveryTask){let any=false;for(const a of state.assets)if(a.taskId===task.id){a.valid=false;any=true;}if(any)task.libraryState='review_invalidated';}
  async importVideo(bytes:Buffer,prompt:string,key:string) {
    if(typeof prompt!=='string' || !prompt.trim() || prompt.length>6000)throw new ApiError(400,'PROMPT_REQUIRED');
    if(bytes.length<12 || bytes.length>MAX_MEDIA_BYTES || bytes.toString('ascii',4,8)!=='ftyp')throw new ApiError(400,'INVALID_LOCAL_MP4');
    const hash=digest(bytes);
    return this.mutate(async state=>{
      const memo=this.memo(state,'import',key,{sha256:hash,prompt:prompt.trim()});if(memo.prior)return this.get(state,memo.prior.id);
      if(state.tasks.length>=200)throw new ApiError(503,'STORE_CAPACITY');
      const id=randomUUID();const directory=join(this.root,'tasks',id);await mkdir(directory,{mode:0o700});
      try {
        const original=join(directory,'original.mp4');await writeFile(original,bytes,{flag:'wx',mode:0o400});
        const media=await probeVideo(original);await decodeVideo(original);
        const task:DeliveryTask={id,version:1,prompt:prompt.trim(),createdAt:timestamp(),source:{kind:'operator_import',sha256:hash,byteSize:bytes.length,media},status:'source_ready',reviewState:'pending',libraryState:'not_saved',reviews:[]};
        state.tasks.push(task);memo.save(id);this.audit(state,task,'import');return task;
      } catch { await rm(directory,{recursive:true,force:true});throw new ApiError(400,'INVALID_LOCAL_MP4'); }
    });
  }
  async postprocess(id:string,body:unknown,key:string) {
    const input=strictObject(body,['expectedVersion','target']);let target:DeliveryTarget;
    try {target=validateTarget(input.target);} catch {throw new ApiError(400,'INVALID_TARGET');}
    const {task,run}=await this.mutate(state=>{
      const task=this.get(state,id);const memo=this.memo(state,`process/${id}`,key,input);if(memo.prior)return {task,run:false};
      this.checkVersion(task,input.expectedVersion);
      if(state.tasks.some(t=>t.status==='processing'))throw new ApiError(409,'PROCESSOR_BUSY');
      try {planDelivery(task.source.media,target);} catch {throw new ApiError(422,'SOURCE_TARGET_INCOMPATIBLE');}
      task.status='processing';task.processingId=randomUUID();task.version++;task.reviewState='pending';delete task.errorCode;
      this.invalidate(state,task);memo.save(id);this.audit(state,task,'postprocess_started');return {task,run:true};
    });
    if(run){const worker=this.process(task,target).finally(()=>{this.workers.delete(worker);});this.workers.add(worker);}
    return task;
  }
  private async process(task:DeliveryTask,target:DeliveryTarget) {
    try {
      const original=join(this.root,'tasks',task.id,'original.mp4');
      if(digest(await readMp4(original))!==task.source.sha256)throw new Error('SOURCE_CHANGED');
      const report=await processDelivery(original,join(this.root,'tasks',task.id,task.processingId!),target);
      await this.mutate(state=>{const t=this.get(state,task.id);t.derivative={id:task.processingId!,report};t.status='ready';t.version++;delete t.processingId;this.audit(state,t,'postprocess_completed');});
    } catch {
      await this.mutate(state=>{const t=this.get(state,task.id);t.status='failed';t.errorCode='DELIVERY_PROCESSING_FAILED';t.version++;this.audit(state,t,'postprocess_failed');}).catch(()=>{});
    }
  }
  async review(id:string,body:unknown,key:string) {
    const input=strictObject(body,['expectedVersion','form','reason']);const form=reviewForm(input.form);
    if(typeof input.reason!=='string' || input.reason.length>4000)throw new ApiError(400,'REVIEW_REASON_REQUIRED');
    const reason=input.reason;
    return this.mutate(async state=>{
      const t=this.get(state,id);const memo=this.memo(state,`review/${id}`,key,input);if(memo.prior)return t;
      this.checkVersion(t,input.expectedVersion);if(t.status!=='ready' || !t.derivative)throw new ApiError(409,'ITEM_NOT_READY');
      await this.readResult(t);
      if(t.reviews.length && !reason.trim())throw new ApiError(400,'REVIEW_REVISION_REASON_REQUIRED');
      if(t.reviews.length>=100)throw new ApiError(503,'STORE_CAPACITY');
      const decision=decideReview({status:'succeeded',mode:'video',resultAvailable:true},form);
      if(!decision.ok)throw new ApiError(400,'INVALID_REVIEW');
      this.invalidate(state,t);
      t.reviews.push({id:randomUUID(),revision:t.reviews.length+1,resultSha256:t.derivative.report.result.sha256,decision:decision.value.decision,form,reason,createdAt:timestamp()});
      t.reviewState=decision.value.decision;t.version++;memo.save(id);this.audit(state,t,'review_'+t.reviewState);return t;
    });
  }
  async saveAsset(id:string,body:unknown,key:string) {
    const input=strictObject(body,['expectedVersion']);
    return this.mutate(async state=>{
      const t=this.get(state,id);const memo=this.memo(state,`save/${id}`,key,input);
      if(memo.prior){const found=state.assets.find(a=>a.id===memo.prior!.id);if(found)return found;throw new ApiError(409,'ASSET_NOT_FOUND');}
      this.checkVersion(t,input.expectedVersion);const review=t.reviews.at(-1);
      if(t.status!=='ready' || !t.derivative || t.reviewState!=='approved' || review?.decision!=='approved' || review.resultSha256!==t.derivative.report.result.sha256)throw new ApiError(409,'REVIEW_REQUIRED');
      await this.readResult(t);
      let asset=state.assets.find(a=>a.taskId===id && a.reviewId===review.id && a.valid);
      if(!asset){asset={id:randomUUID(),taskId:id,reviewId:review.id,resultSha256:review.resultSha256,valid:true,createdAt:timestamp()};state.assets.push(asset);}
      t.libraryState='saved';t.version++;memo.save(asset.id);this.audit(state,t,'manual_save');return asset;
    });
  }
  private async readResult(t:DeliveryTask) {
    if(!t.derivative || !uuid.test(t.derivative.id))throw new ApiError(409,'RESULT_NOT_READY');
    try {const bytes=await readMp4(join(this.root,'tasks',t.id,t.derivative.id,'result.mp4'));if(digest(bytes)!==t.derivative.report.result.sha256)throw new Error('CHANGED');return bytes;}catch{throw new ApiError(409,'RESULT_UNAVAILABLE');}
  }
  async result(id:string){const task=this.get(this.state,id);if(task.status!=='ready')throw new ApiError(409,'RESULT_NOT_READY');return this.readResult(task);}
  async assetFile(id:string) {
    const a=this.state.assets.find(asset=>asset.id===id);if(!a)throw new ApiError(404,'ASSET_NOT_FOUND');
    const t=this.get(this.state,a.taskId);if(!a.valid || t.status!=='ready' || t.reviewState!=='approved' || t.reviews.at(-1)?.id!==a.reviewId || t.derivative?.report.result.sha256!==a.resultSha256)throw new ApiError(409,'ASSET_REVIEW_INVALIDATED');
    return this.readResult(t);
  }
  async waitForIdle(){await Promise.all([...this.workers]);await this.queue;}
  async close(){if(this.closed)return;await this.waitForIdle();this.closed=true;await this.lock.close();await rm(join(this.root,'.lock'),{force:true});}
}
