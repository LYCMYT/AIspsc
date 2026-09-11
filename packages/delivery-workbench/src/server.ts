import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { ApiError, DeliveryStore } from './store.ts';
import { MAX_MEDIA_BYTES } from '../../media-processing/src/processor.ts';
async function body(req:IncomingMessage,maximum:number):Promise<Buffer> {
  if(Number(req.headers['content-length'])>maximum)throw new ApiError(413,'BODY_TOO_LARGE');
  const chunks:Buffer[]=[];let count=0;
  for await(const chunk of req){const data=Buffer.from(chunk);count+=data.length;if(count>maximum)throw new ApiError(413,'BODY_TOO_LARGE');chunks.push(data);}
  return Buffer.concat(chunks,count);
}
async function jsonBody(req:IncomingMessage) {
  if(req.headers['content-type']?.split(';')[0]!=='application/json')throw new ApiError(415,'JSON_REQUIRED');
  const bytes=await body(req,64*1024);
  try {return JSON.parse(bytes.toString('utf8')) as unknown;}catch{throw new ApiError(400,'INVALID_JSON');}
}
function json(res:ServerResponse,status:number,payload:unknown){res.writeHead(status,{'content-type':'application/json; charset=utf-8'});res.end(JSON.stringify(payload));}
export async function startWorkbench(options:{directory:string;token:string;port?:number}) {
  if(typeof options.token!=='string' || options.token.length<32 || options.token.length>512 || /[^\x21-\x7e]/.test(options.token))throw new Error('INVALID_OPERATOR_TOKEN');
  const port=options.port??8787;if(!Number.isSafeInteger(port) || port<0 || port>65535)throw new Error('INVALID_PORT');
  const store=await DeliveryStore.open(options.directory);
  const expected=createHash('sha256').update(`Bearer ${options.token}`).digest();
  const server=createServer(async(req,res)=>{
    res.setHeader('cache-control','no-store');res.setHeader('x-content-type-options','nosniff');res.setHeader('referrer-policy','no-referrer');
    res.setHeader('content-security-policy',"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; media-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    try {
      const address=server.address();if(!address || typeof address==='string')throw new ApiError(503,'NOT_READY');
      const hosts=[`127.0.0.1:${address.port}`,`localhost:${address.port}`];
      if(!hosts.includes(req.headers.host??''))throw new ApiError(403,'INVALID_HOST');
      if(req.headers.origin && req.headers.origin!==`http://${req.headers.host}`)throw new ApiError(403,'ORIGIN_REJECTED');
      if(!req.url || req.url.includes('?') || req.url.includes('#'))throw new ApiError(400,'QUERY_NOT_ALLOWED');
      if(req.method==='GET' && req.url==='/health')return json(res,200,{mode:'local-operator-workbench',providerCallsEnabled:false});
      const staticFiles:Record<string,[string,string]>={'/':['index.html','text/html; charset=utf-8'],'/app.js':['app.js','text/javascript; charset=utf-8'],'/style.css':['style.css','text/css; charset=utf-8']};
      if(req.method==='GET' && staticFiles[req.url]) {
        const [file,mime]=staticFiles[req.url]!;const bytes=await readFile(new URL('../web/'+file,import.meta.url));res.writeHead(200,{'content-type':mime});res.end(bytes);return;
      }
      const auth=typeof req.headers.authorization==='string'?req.headers.authorization:'';
      if(!timingSafeEqual(expected,createHash('sha256').update(auth).digest()))throw new ApiError(401,'UNAUTHORIZED');
      const key=typeof req.headers['idempotency-key']==='string'?req.headers['idempotency-key']:'';
      if(req.method==='GET' && req.url==='/v1/tasks')return json(res,200,{tasks:store.snapshot().tasks});
      if(req.method==='GET' && req.url==='/v1/assets')return json(res,200,{assets:store.snapshot().assets});
      if(req.method==='GET' && req.url==='/v1/audit')return json(res,200,{events:store.snapshot().audit});
      if(req.method==='POST' && req.url==='/v1/tasks/import') {
        if(req.headers['content-type']!=='video/mp4')throw new ApiError(415,'MP4_REQUIRED');
        let prompt:string;try{prompt=decodeURIComponent(String(req.headers['x-task-prompt']??''));}catch{throw new ApiError(400,'INVALID_PROMPT');}
        return json(res,201,{task:await store.importVideo(await body(req,MAX_MEDIA_BYTES),prompt,key)});
      }
      const taskRoute=/^\/v1\/tasks\/([a-f0-9-]{36})(?:\/(postprocess|reviews|assets|result))?$/.exec(req.url);
      if(taskRoute){
        const id=taskRoute[1]!;const action=taskRoute[2];
        if(req.method==='GET' && !action)return json(res,200,{task:store.getTask(id)});
        if(req.method==='POST' && action==='postprocess')return json(res,202,{task:await store.postprocess(id,await jsonBody(req),key)});
        if(req.method==='POST' && action==='reviews')return json(res,200,{task:await store.review(id,await jsonBody(req),key)});
        if(req.method==='POST' && action==='assets')return json(res,200,{asset:await store.saveAsset(id,await jsonBody(req),key)});
        if(req.method==='GET' && action==='result'){const bytes=await store.result(id);res.writeHead(200,{'content-type':'video/mp4','content-length':bytes.length});res.end(bytes);return;}
      }
      const assetRoute=/^\/v1\/assets\/([a-f0-9-]{36})\/file$/.exec(req.url);
      if(req.method==='GET' && assetRoute){const bytes=await store.assetFile(assetRoute[1]!);res.writeHead(200,{'content-type':'video/mp4','content-length':bytes.length});res.end(bytes);return;}
      throw new ApiError(404,'NOT_FOUND');
    } catch(error) {
      if(res.headersSent){res.destroy();return;}
      const e=error instanceof ApiError?error:new ApiError(500,'INTERNAL_ERROR');
      res.setHeader('connection','close');json(res,e.status,{error:e.message});
    }
  });
  server.maxConnections=8;server.requestTimeout=30_000;server.headersTimeout=15_000;
  try {await new Promise<void>((done,fail)=>{server.once('error',fail);server.listen(port,'127.0.0.1',()=>{server.off('error',fail);done();});});}
  catch(error){await store.close();throw error;}
  const address=server.address();if(!address || typeof address==='string')throw new Error('SERVER_NOT_LISTENING');
  let closed=false;
  return {url:`http://127.0.0.1:${address.port}`,store,close:async()=>{if(closed)return;closed=true;await new Promise<void>((done)=>server.close(()=>done()));await store.close();}};
}
