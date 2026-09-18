import { mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { DshBackend } from '../backend.ts';
import { loadConfig } from '../config.ts';

if (!process.argv[2]) throw new Error('Usage: node tools/smoke.mjs /tmp/output-directory');
const out = resolve(process.argv[2]);
await mkdir(out, { recursive: true, mode: 0o700 });
const backend = new DshBackend(loadConfig());
const report = { text: '你好，这是派的本地语音输入和输出测试。', microphoneUsed: false, playback: false };
const abort = new AbortController();
const timeout = setTimeout(() => abort.abort(), 180000);
try {
  const segments = await backend.segments(report.text, abort.signal);
  if (segments.length !== 1) throw new Error('Unexpected smoke segmentation');
  const start = Date.now();
  const result = await backend.synthesize(segments[0], abort.signal);
  report.tts = {sampleRate:result.sampleRate,audioSeconds:result.audioSeconds,synthSeconds:result.synthSeconds,wallSeconds:(Date.now()-start)/1000};
  await writeFile(join(out,'cosyvoice3.wav'),result.wav,{mode:0o600});
  const oldChildren = [...backend.active.owner.children.keys()];
  const pcm = execFileSync('ffmpeg',['-v','error','-i',join(out,'cosyvoice3.wav'),'-ar','16000','-ac','1','-f','s16le','pipe:1'],{maxBuffer:8*1024*1024});
  report.asr = await backend.transcribe(pcm,abort.signal);
  report.ttsExitedBeforeAsrCompleted = oldChildren.every(c=>c.exitCode!==null||c.signalCode!==null);
  const silent = await backend.transcribe(Buffer.alloc(32000),abort.signal);
  report.silenceEmpty = silent.text === '';
  const clean = s => s.replace(/[\p{P}\p{Z}\s]/gu,'');
  report.exact = clean(report.text) === clean(report.asr.text);
  report.ok = report.exact && report.silenceEmpty && report.ttsExitedBeforeAsrCompleted;
  if (!report.ok) process.exitCode = 1;
} catch (error) { report.ok=false;report.error=String(error.stack??error);process.exitCode=1; }
finally {
  clearTimeout(timeout);
  await backend.unload();
  report.unloaded = backend.active === null;
  await writeFile(join(out,'result.json'),JSON.stringify(report,null,2)+'\n');
  await writeFile(join(out,'worker.log'),backend.logTail,{mode:0o600});
  console.log(JSON.stringify(report,null,2));
}
