import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startWorkbench } from './server.ts';
import { DeliveryStore } from './store.ts';
const token = 'local-test-operator-token-not-a-provider-secret';
let root: string;
let app: Awaited<ReturnType<typeof startWorkbench>>;
let bytes: Buffer;
let taskId: string;
let assetId: string;
const target = { durationSeconds: 5, ratio: '16:9', resolution: '720p', audio: false };
const form = { rubricVersion: 'rubric-v2-rebuild', score: 8,
  applicability: Object.fromEntries(Array.from({length:11},(_,i)=>[`Q${String(i+1).padStart(2,'0')}`,{applicable:true}])),
  issueTags: [], hardFailures: [], technicalErrors: [], notes: 'Synthetic fixture review for automated tests only.' };
async function request(path: string, method = 'GET', body?: unknown, key?: string) {
  return fetch(app.url + path, { method, headers: { authorization: `Bearer ${token}`, ...(body ? {'content-type':'application/json'} : {}), ...(key ? {'idempotency-key':key} : {}) }, body: body ? JSON.stringify(body) : undefined });
}
async function task() { return (await (await request(`/v1/tasks/${taskId}`)).json()).task; }
beforeAll(async () => {
  root=await mkdtemp(join(tmpdir(),'workbench-test-'));
  const source=join(root,'source.mp4');
  await promisify(execFile)('ffmpeg',['-v','error','-f','lavfi','-i','color=c=blue:s=1280x704:r=24','-frames:v','121','-c:v','libx264','-threads','1','-pix_fmt','yuv420p',source]);
  bytes=await readFile(source);
  app=await startWorkbench({ directory:join(root,'data'), token, port:0 });
});
afterAll(async()=>{if(app) await app.close(); if(root)await rm(root,{recursive:true,force:true});});
describe('controlled local delivery API',()=>{
  it('requires auth and rejects cross-origin requests, URL tokens and generation',async()=>{
    expect((await fetch(app.url+'/v1/tasks')).status).toBe(401);
    expect((await fetch(app.url+'/v1/tasks',{headers:{authorization:`Bearer ${token}`,origin:'https://untrusted.example'}})).status).toBe(403);
    expect((await fetch(app.url+'/v1/tasks?token='+token)).status).toBe(400);
    expect((await request('/v1/generate','POST',{})).status).toBe(404);
  });
  it('imports only with a prompt and idempotency key, never a path or URL',async()=>{
    const headers={'authorization':`Bearer ${token}`,'content-type':'video/mp4','idempotency-key':'import-1','x-task-prompt':encodeURIComponent('A geometric fixture, imported from an existing output.')};
    const first=await fetch(app.url+'/v1/tasks/import',{method:'POST',headers,body:new Uint8Array(bytes)});
    expect(first.status).toBe(201);const payload=await first.json();taskId=payload.task.id;
    expect(payload.task.source.kind).toBe('operator_import');
    expect(payload.task.reviewState).toBe('pending');
    const second=await fetch(app.url+'/v1/tasks/import',{method:'POST',headers,body:new Uint8Array(bytes)});
    expect((await second.json()).task.id).toBe(taskId);
    const mismatch=await fetch(app.url+'/v1/tasks/import',{method:'POST',headers:{...headers,'x-task-prompt':'different'},body:new Uint8Array(bytes)});
    expect(mismatch.status).toBe(409);
    expect((await fetch(app.url+'/v1/tasks/import',{method:'POST',headers:{...headers,'idempotency-key':'import-2','x-task-prompt':''},body:new Uint8Array(bytes)})).status).toBe(400);
    expect((await request(`/v1/tasks/${taskId}/postprocess`,'POST',{expectedVersion:999,target},'bad-version')).status).toBe(409);
    expect((await request(`/v1/tasks/${taskId}/assets`,'POST',{expectedVersion:1},'premature')).status).toBe(409);
  });
  it('runs an async derivative, binds review to its hash and saves only explicitly',async()=>{
    const body={expectedVersion:(await task()).version,target};
    expect((await request(`/v1/tasks/${taskId}/postprocess`,'POST',body,'process-1')).status).toBe(202);
    expect((await request(`/v1/tasks/${taskId}/postprocess`,'POST',body,'process-1')).status).toBe(202);
    expect((await request(`/v1/tasks/${taskId}/postprocess`,'POST',body,'process-concurrent')).status).toBe(409);
    await app.store.waitForIdle();
    let current=await task();expect(current.status).toBe('ready');
    expect(current.derivative.report.result.media).toMatchObject({height:720,frames:120,hasAudio:false});
    expect((await request(`/v1/tasks/${taskId}/assets`,'POST',{expectedVersion:current.version},'still-unreviewed')).status).toBe(409);
    const review=await request(`/v1/tasks/${taskId}/reviews`,'POST',{expectedVersion:current.version,form,reason:''},'review-1');
    expect(review.status).toBe(200); current=await task();
    expect(current.reviewState).toBe('approved');expect(current.libraryState).toBe('not_saved');
    expect((await (await request('/v1/assets')).json()).assets).toHaveLength(0);
    const saved=await request(`/v1/tasks/${taskId}/assets`,'POST',{expectedVersion:current.version},'save-1');
    expect(saved.status).toBe(200);assetId=(await saved.json()).asset.id;
    expect((await request(`/v1/assets/${assetId}/file`)).status).toBe(200);
  });
  it('hard failures override high scores and invalidate previously saved assets',async()=>{
    let current=await task();
    expect((await request(`/v1/tasks/${taskId}/reviews`,'POST',{expectedVersion:current.version,form:{...form,score:10,hardFailures:['H02']},reason:'Detected product identity mismatch.'},'review-2')).status).toBe(200);
    current=await task();expect(current.reviewState).toBe('rejected');
    expect((await request(`/v1/assets/${assetId}/file`)).status).toBe(409);
    expect((await request(`/v1/tasks/${taskId}/assets`,'POST',{expectedVersion:current.version},'save-rejected')).status).toBe(409);
    expect(current.reviews).toHaveLength(2);
  });
  it('rejects malformed review fields and a concurrent store process',async()=>{
    const current=await task();
    expect((await request(`/v1/tasks/${taskId}/reviews`,'POST',{expectedVersion:current.version,form:{...form,hardFailures:['H99']},reason:'bad'},'bad-review')).status).toBe(400);
    await expect(DeliveryStore.open(join(root,'data'))).rejects.toThrow('STORE_LOCKED');
  });
  it('requires a new manual save after a later approval and enforces N/A reasons',async()=>{
    let current=await task();
    expect((await request(`/v1/tasks/${taskId}/reviews`,'POST',{expectedVersion:current.version,form:{...form,applicability:{...form.applicability,Q03:{applicable:false}}},reason:'Fix'},'review-invalid-na')).status).toBe(400);
    expect((await request(`/v1/tasks/${taskId}/reviews`,'POST',{expectedVersion:current.version,form,reason:'Rechecked synthetic fixture.'},'review-3')).status).toBe(200);
    current=await task();expect(current.libraryState).toBe('review_invalidated');
    expect((await request(`/v1/assets/${assetId}/file`)).status).toBe(409);
    const saved=await request(`/v1/tasks/${taskId}/assets`,'POST',{expectedVersion:current.version},'save-new-approval');
    expect(saved.status).toBe(200);expect((await saved.json()).asset.id).not.toBe(assetId);
  });
  it('persists history/review/invalidation across restart, without storing a token',async()=>{
    await app.close();app=await startWorkbench({directory:join(root,'data'),token,port:0});
    expect((await task()).reviewState).toBe('approved');
    expect((await request(`/v1/assets/${assetId}/file`)).status).toBe(409);
    const state=await readFile(join(root,'data','state.json'),'utf8');
    expect(state).not.toContain(token);expect(state).not.toContain(root);
  });
  it('marks interrupted jobs on restart and does not expose an obsolete derivative',async()=>{
    await app.close();
    const statePath=join(root,'data','state.json');const state=JSON.parse(await readFile(statePath,'utf8'));state.tasks[0].status='processing';await writeFile(statePath,JSON.stringify(state));
    app=await startWorkbench({directory:join(root,'data'),token,port:0});
    expect((await task()).status).toBe('interrupted');
    expect((await request(`/v1/tasks/${taskId}/result`)).status).toBe(409);
  });
});
