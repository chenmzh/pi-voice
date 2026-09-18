import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as tick } from 'node:timers/promises';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { playPipelined } from '../pipeline.ts';
import { VoiceLibrary, validateReference, referenceName, pcmWav } from '../voices.ts';
import { VoiceController } from '../controller.ts';
import { resolveConfig, saveConfigPatch } from '../config.ts';

function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};}
function pcm(seconds=4){const p=Buffer.alloc(Math.round(seconds*32000));for(let i=0;i<p.length;i+=2)p.writeInt16LE(Math.round(2000*Math.sin(i/12)),i);return p;}
function temp(t){const dir=mkdtempSync(join(tmpdir(),'pi-voice-tests-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));return dir;}

test('prefetch overlaps playback, preserves order and bounds the look-ahead',async()=>{
  const playing=deferred(),synth=[],played=[];
  const run=playPipelined(['a','b','c','d','e'],async text=>{synth.push(text);return text;},async audio=>{played.push(audio);if(audio==='a')await playing.promise;});
  await tick();assert.deepEqual(played,['a']);assert.deepEqual(synth,['a','b','c']);
  playing.resolve();await run;assert.deepEqual(played,['a','b','c','d','e']);
});

test('playback waits for the configured initial prebuffer, not just the first sentence',async()=>{
  const second=deferred(),played=[];
  const run=playPipelined(['a','b'],t=>t==='a'?Promise.resolve(t):second.promise,async t=>played.push(t));
  await tick();assert.deepEqual(played,[]);second.resolve('b');await run;assert.deepEqual(played,['a','b']);
});

test('playback failure aborts an in-flight prefetched synthesis and drains it',async()=>{
  let cancelled=false;
  await assert.rejects(playPipelined(['a','b','c'],(t,s)=>t==='c'?new Promise((_,reject)=>{
    s.addEventListener('abort',()=>{cancelled=true;reject(new DOMException('cancel','AbortError'));},{once:true});
  }):Promise.resolve(t),async()=>{await tick();throw new Error('speaker failed');}),/speaker failed/);
  assert.equal(cancelled,true);
});

test('prefetch rejection during playback is observed and not silently skipped',async()=>{
  const gate=deferred();const run=playPipelined(['a','b','c'],async t=>{if(t==='c')throw new Error('synth failed');return t;},async t=>{if(t==='a')await gate.promise;});
  await tick();gate.resolve();await assert.rejects(run,/synth failed/);
});

test('Stop during prebuffer never plays late results',async()=>{
  const gate=deferred(),a=new AbortController(),played=[];
  const run=playPipelined(['a','b'],()=>gate.promise,async t=>played.push(t),{signal:a.signal});
  await tick();a.abort();gate.resolve('late');await assert.rejects(run,{name:'AbortError'});assert.deepEqual(played,[]);
});

test('reference validation rejects silence, short/long audio and unsafe names',()=>{
  assert.throws(()=>validateReference(Buffer.alloc(128000)),/静音/);
  assert.throws(()=>validateReference(pcm(2)),/3–20/);
  assert.throws(()=>validateReference(pcm(21)),/3–20/);
  for(const n of ['../voice','a/b','.', ''])assert.throws(()=>referenceName(n),/音色名/);
  assert.equal(referenceName('我的声音 1'),'我的声音 1');
  const wav=pcmWav(pcm());assert.equal(wav.subarray(0,4).toString(),'RIFF');assert.equal(wav.readUInt32LE(24),16000);
});

test('save creates a WAV/TXT pair without overwriting existing voices',t=>{
  const dir=temp(t),library=new VoiceLibrary(resolveConfig({refsDir:dir}));
  const ref=library.save('我的声音',pcm(),'准确逐字稿');
  assert.equal(readFileSync(ref.textPath,'utf8'),'准确逐字稿\n');
  assert.equal(statSync(ref.id).mode&0o777,0o600);
  assert.throws(()=>library.save('我的声音',pcm(),'different'),/已存在/);
  assert.equal(readFileSync(ref.textPath,'utf8'),'准确逐字稿\n');
  writeFileSync(join(dir,'orphan.txt'),'keep');assert.throws(()=>library.save('orphan',pcm(),'new'),/已存在/);
  assert.equal(readdirSync(dir).length,3);
});

test('voice discovery combines presets, Pi and read-only DSH references without model loading',async()=>{
  const c=resolveConfig({refsDir:'/pi-refs',dshRefsDir:'/dsh-refs'});
  const library=new VoiceLibrary(c,{scan:dir=>[{label:'voice',id:join(dir,'voice.wav')}]});
  const voices=await library.list();assert.deepEqual(voices.map(v=>v.source),['预置','预置','Pi','DSH']);
});

test('voice completion rescans references, filters names/IDs and marks the current voice',async()=>{
  const c=resolveConfig({refsDir:'/pi',dshRefsDir:'/dsh'});let refs=[{label:'Demo',id:'/dsh/Demo.wav'}];
  const library=new VoiceLibrary(c,{scan:dir=>dir==='/dsh'?refs:[]});
  await library.list();
  assert.deepEqual(library.completions('d','/dsh/Demo.wav'),[{value:'use Demo',label:'✓ DSH: Demo',description:'当前音色 · /dsh/Demo.wav'}]);
  assert.equal(library.completions('/dsh/D','')[0].value,'use Demo');
  refs=[{label:'新声音 2',id:'/dsh/新声音 2.wav'}];
  assert.deepEqual(library.completions('Demo',''),[]);
  assert.equal(library.completions('新声音 ','')[0].value,'use 新声音 2');
});

test('completion disambiguates duplicate and reserved voice names with absolute IDs',()=>{
  const c=resolveConfig({refsDir:'/pi',dshRefsDir:'/dsh'});
  const library=new VoiceLibrary(c,{scan:dir=>[{label:'Demo',id:join(dir,'Demo.wav')},{label:'zero_shot_prompt',id:join(dir,'zero_shot_prompt.wav')}]});
  assert.deepEqual(library.completions('Demo','').map(v=>v.value),['use /pi/Demo.wav','use /dsh/Demo.wav']);
  assert.deepEqual(library.completions('zero_shot_prompt','').map(v=>v.value),['use /pi/zero_shot_prompt.wav','use /dsh/zero_shot_prompt.wav']);
});

test('import decoder reads local audio, preserves source and respects cancellation',async t=>{
  const dir=temp(t),file=join(dir,'source.wav'),audio=pcmWav(pcm());writeFileSync(file,audio);
  const library=new VoiceLibrary(resolveConfig({refsDir:join(dir,'refs')}));
  assert.equal(library.resolveFile(file,dir),file);
  const decoded=await library.decode(file,new AbortController().signal);assert.equal(decoded.length,128000);
  assert.deepEqual(readFileSync(file),audio);
  assert.throws(()=>library.decode(file,AbortSignal.abort()),{name:'AbortError'});
});

test('configuration merge preserves unrelated edits and writes valid JSON atomically',t=>{
  const dir=temp(t),file=join(dir,'config.json');writeFileSync(file,JSON.stringify({asrLanguage:'en',idleUnloadSeconds:42}));
  saveConfigPatch({voice:'/references/voice.wav'},file);
  assert.deepEqual(JSON.parse(readFileSync(file)),{asrLanguage:'en',idleUnloadSeconds:42,voice:'/references/voice.wav'});
  assert.equal(readdirSync(dir).length,1);
});

function ctx(){const notices=[];return {mode:'tui',cwd:'/tmp',notices,ui:{notify:(m)=>notices.push(m),setStatus(){},input:async()=>'',confirm:async()=>true,getEditorText:()=>'',pasteToEditor:()=>{throw new Error('clone must not paste transcript');}}};}

test('Pi clone records a reference and persists selection, never submits/pastes it',async t=>{
  const dir=temp(t),c=resolveConfig({refsDir:dir,idleUnloadSeconds:0});let cap,selected;
  const v=new VoiceController(c,{unload:async()=>{}},{persist:p=>{selected=p.voice;},record:(config,_s,start)=>{
    cap=config.maxRecordingSeconds;start();return {result:Promise.resolve(pcm()),finish(){}};
  }});
  const context=ctx();v.cloneVoice(context,'我的声音');await v.tail;
  assert.equal(cap,20);assert.equal(selected,join(dir,'我的声音.wav'));assert.equal(v.config.voice,selected);
  assert.match(readFileSync(join(dir,'我的声音.txt'),'utf8'),/你好/);await v.dispose(context);
});

test('Stop during clone capture discards a late recording without saving files',async t=>{
  const dir=temp(t),pending=deferred(),c=resolveConfig({refsDir:dir,idleUnloadSeconds:0});
  const v=new VoiceController(c,{unload:async()=>{}},{persist:()=>{throw new Error('must not persist');},record:()=>({result:pending.promise,finish(){}})});
  const context=ctx();v.cloneVoice(context,'cancelled');await tick();assert.equal(v.job.kind,'record');
  const stop=v.stop(context);pending.resolve(pcm());await stop;assert.deepEqual(readdirSync(dir),[]);await v.dispose(context);
});

test('selecting a DSH voice saves the absolute path without touching its source',async()=>{
  const c=resolveConfig({idleUnloadSeconds:0});let saved;
  const v=new VoiceController(c,{unload:async()=>{}},{persist:p=>{saved=p;},library:{list:async()=>[{label:'Demo',id:'/dsh/Demo.wav',source:'DSH'}]}});
  const context=ctx();v.chooseVoice(context,'Demo');await v.tail;assert.deepEqual(saved,{voice:'/dsh/Demo.wav'});assert.equal(c.voice,'/dsh/Demo.wav');await v.dispose(context);
});
