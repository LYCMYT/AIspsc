import { expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
const execute=promisify(execFile);
const stages=['submitting','submitted','polling','downloading','settled'] as const;
interface ChildReport { pid:number;status:string;attemptState:string;attemptId:string;externalJobId?:string;submittedAt?:string;attemptCount:number;reserved:number;spent:number;rawSha256?:string;derivativeSourceSha256?:string;calls:{create:number;get:number;download:number;jobIds:string[]}; }
it.each(stages)('a separate Node process resumes durable %s without another create',async stage=>{
 const parent=resolve('.cache/generation-tests/process-restart');await mkdir(parent,{recursive:true});const directory=await mkdtemp(join(parent,`${stage}-`));
 const child=resolve('packages/generation-api/tests/helpers/worker-restart-child.mjs');
 const run=async(mode:'seed'|'resume')=>{
  await execute(process.execPath,[child,mode,stage,directory],{cwd:process.cwd(),timeout:45000,maxBuffer:1024*1024,windowsHide:true});
  return JSON.parse(await readFile(join(directory,`${mode}-report.json`),'utf8')) as ChildReport;
 };
 const first=await run('seed');expect(first.attemptState).toBe(stage);expect(first.calls.create).toBe(1);expect(first.attemptCount).toBe(1);expect(first.submittedAt).toBeDefined();
 const second=await run('resume');expect(second.pid).not.toBe(first.pid);expect(second.attemptId).toBe(first.attemptId);expect(second.attemptCount).toBe(1);expect(second.calls.create).toBe(1);expect(second.submittedAt).toBe(first.submittedAt);
 if(stage==='submitting'){
  expect(first.externalJobId).toBeUndefined();expect(second.externalJobId).toBeUndefined();expect(second.status).toBe('needs_reconciliation');expect(second.reserved).toBe(1);expect(second.calls.get).toBe(0);
 }else{
  expect(first.externalJobId).toBe('process-original-job');expect(second.externalJobId).toBe(first.externalJobId);expect(second.status).toBe('succeeded');expect(second.reserved).toBe(0);expect(second.spent).toBe(1);expect(second.calls.jobIds.every(id=>id===first.externalJobId)).toBe(true);
 }
 if(stage==='downloading'){
  expect(first.status).toBe('finalizing');expect(first.rawSha256).toMatch(/^[a-f0-9]{64}$/);expect(first.derivativeSourceSha256).toBeUndefined();expect(second.rawSha256).toBe(first.rawSha256);expect(second.derivativeSourceSha256).toBe(first.rawSha256);expect(second.calls).toEqual(first.calls);
 }
 if(stage==='settled')expect(second.calls).toEqual(first.calls);
},60000);
