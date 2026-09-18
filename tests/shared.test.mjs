import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as tick } from 'node:timers/promises';
import { startService } from '../server.ts';
import { SharedBackend } from '../shared.ts';
import { NativeBackend, speechSegments } from '../native.ts';
import { resolveConfig } from '../config.ts';

function temp(t) { const dir=mkdtempSync(join(tmpdir(),'pi-voice-shared-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));return dir; }
function deferred(){let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};}
async function fixture(t) {
  const root=temp(t), config=resolveConfig({idleUnloadSeconds:300});
  const stats={instances:0,loads:0,running:0,peak:0,unloads:0,voices:[]};let gate=null;
  const service=await startService({root,createBackend:c=>{
    stats.instances++;
    return {config:c,active:null,
      async segments(text){return [text];},
      async work(kind,signal){
        if(this.active?.kind!==kind){this.active={kind};stats.loads++;}
        stats.running++;stats.peak=Math.max(stats.peak,stats.running);
        try{
          if(gate){const wait=gate;gate=null;wait.started.resolve();await new Promise((resolve,reject)=>{
            const cancel=()=>reject(new DOMException('cancel','AbortError'));
            signal.addEventListener('abort',cancel,{once:true});
            wait.release.promise.then(()=>{signal.removeEventListener('abort',cancel);resolve();});
          });}
          if(signal.aborted)throw new DOMException('cancel','AbortError');
        }finally{stats.running--;}
      },
      async transcribe(_audio,signal){await this.work('asr',signal);return {text:'中文识别'};},
      async synthesize(text,signal){stats.voices.push(this.config.voice);await this.work('tts',signal);return {wav:Buffer.from(text)};},
      async unload(){this.active=null;stats.unloads++;},
    };
  }});
  t.after(()=>service.close());
  return {root,service,stats,config,client:()=>new SharedBackend({...config},{serviceRoot:root}),hold:()=>{gate={started:deferred(),release:deferred()};return gate;}};
}

test('two windows share one backend/load and serialize inference',async t=>{
  const f=await fixture(t),a=f.client(),b=f.client();
  const result=await Promise.all([a.transcribe(Buffer.alloc(3200)),b.transcribe(Buffer.alloc(3200))]);
  assert.deepEqual(result.map(x=>x.text),['中文识别','中文识别']);
  assert.equal(f.stats.instances,1);assert.equal(f.stats.loads,1);assert.equal(f.stats.peak,1);
  assert.equal((await a.status()).clients,2);assert.equal(statSync(f.service.paths.socket).mode&0o777,0o600);
  await a.unload();assert.equal((await b.status()).active.kind,'asr');
  await b.unload();assert.equal((await b.status()).active,null);
});

test('closing one idle window does not interrupt another active window',async t=>{
  const f=await fixture(t),a=f.client(),b=f.client();await a.transcribe(Buffer.alloc(3200));
  const gate=f.hold(),running=b.transcribe(Buffer.alloc(3200));await gate.started.promise;
  await a.unload();assert.equal(f.stats.running,1);
  gate.release.resolve();assert.equal((await running).text,'中文识别');
  assert.equal(f.stats.loads,1);await b.unload();
});

test('cancelling one request does not cancel the next window in the queue',async t=>{
  const f=await fixture(t),a=f.client(),b=f.client(),abort=new AbortController(),gate=f.hold();
  const one=a.transcribe(Buffer.alloc(3200),abort.signal);const rejected=assert.rejects(one,{name:'AbortError'});
  await gate.started.promise;const two=b.transcribe(Buffer.alloc(3200));abort.abort();
  await rejected;await a.unload();assert.equal((await two).text,'中文识别');gate.release.resolve();await b.unload();
});

test('voice selection is per request, while ASR/TTS switch within one shared backend',async t=>{
  const f=await fixture(t),a=f.client(),b=f.client();a.config.voice='/example/Demo.wav';b.config.voice='/example/Sample.wav';
  await a.transcribe(Buffer.alloc(3200));await a.synthesize('一句');await b.synthesize('第二句');
  assert.equal(f.stats.instances,1);assert.equal(f.stats.loads,2);assert.deepEqual(f.stats.voices,[a.config.voice,b.config.voice]);
  await a.unload();await b.unload();
});

test('native backend uses one worker until model kind changes; unload exits it',async t=>{
  const root=temp(t),script=join(root,'fake.mjs');
  writeFileSync(join(root,'config.json'),'{}');writeFileSync(join(root,'cosyvoice3.yaml'),'');
  writeFileSync(script,`import readline from 'node:readline'; console.log(JSON.stringify({ready:true}));
    for await (const line of readline.createInterface({input:process.stdin})) { const r=JSON.parse(line); console.log(JSON.stringify({id:r.id,text:'ok',wav:Buffer.from('audio').toString('base64')})); }`);
  const backend=new NativeBackend(resolveConfig({asrPython:process.execPath,asrModel:root,ttsPython:process.execPath,ttsModel:root}),{workerPath:script});
  t.after(()=>backend.unload());
  assert.equal((await backend.transcribe(Buffer.alloc(3200))).text,'ok');const first=backend.active.proc.child;
  await backend.transcribe(Buffer.alloc(3200));assert.equal(backend.active.proc.child.pid,first.pid);
  assert.equal((await backend.synthesize('hello')).wav.toString(),'audio');assert.ok(first.exitCode!==null||first.signalCode!==null);
  const second=backend.active.proc.child;await backend.unload();assert.ok(second.exitCode!==null||second.signalCode!==null);
});

test('uninstalled optional features fail with setup guidance without spawning a worker',async t=>{
  const root=temp(t);let spawned=0;
  const backend=new NativeBackend(resolveConfig({asrPython:process.execPath,asrModel:root,ttsPython:process.execPath,ttsModel:root}),{spawn:()=>{spawned++;throw new Error('must not spawn');}});
  await assert.rejects(backend.transcribe(Buffer.alloc(3200)),/voice setup/);
  await assert.rejects(backend.synthesize('hello'),/voice setup/);
  assert.equal(spawned,0);assert.equal(backend.active,null);await backend.unload();
});

test('native text preparation strips code/links/tables and bounds sentence size',()=>{
  const parts=speechSegments('# 标题\n正文。\n```js\nsecret()\n```\n| table |\n[链接](https://example.test)\n'+'长'.repeat(400));
  assert.ok(!parts.join('').includes('secret'));assert.ok(!parts.join('').includes('https'));assert.ok(!parts.join('').includes('table'));
  assert.ok(parts.every(x=>[...x].length<=180));
});
