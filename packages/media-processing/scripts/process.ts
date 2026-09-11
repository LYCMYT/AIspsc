import { processDelivery } from '../src/processor.ts';
const [source,output,duration='5',ratio='16:9',resolution='720p']=process.argv.slice(2);
if(!source || !output){console.error('Usage: pnpm delivery:process <source.mp4> <new-output-directory> [5-15] [16:9|9:16|1:1] [720p|1080p]');process.exitCode=1;}
else {try{const report=await processDelivery(source,output,{durationSeconds:Number(duration),ratio,resolution,audio:false});console.log(JSON.stringify(report,null,2));}catch{console.error('DELIVERY_FAILED: check source MP4, target duration, and exclusive output directory. Source was not overwritten.');process.exitCode=1;}}
