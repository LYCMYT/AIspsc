import { randomBytes } from 'node:crypto';
import { startWorkbench } from '../src/server.ts';
const token=process.env.AISPSC_OPERATOR_TOKEN?.trim() || randomBytes(32).toString('hex');
const directory=process.env.AISPSC_DATA_DIR || 'artifacts/local-delivery';
const port=Number(process.env.AISPSC_PORT || 8787);
try {
  const app=await startWorkbench({directory,token,port});
  console.log(`Local delivery workbench: ${app.url}`);
  console.log(`Local operator token (not a Provider key; do not share): ${token}`);
  console.log('Provider calls disabled. Browser keeps this local token in memory only.');
  for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{void app.close().then(()=>process.exit(0));});
} catch { console.error('LOCAL_WORKBENCH_START_FAILED: check port, data directory lock, and operator-token settings.');process.exitCode=1; }
