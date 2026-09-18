import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { access } from 'node:fs/promises';
import { recordAudio, playAudio } from '../audio.ts';
import { OwnedProcesses } from '../processes.ts';
import { resolveConfig } from '../config.ts';

const config=resolveConfig({maxRecordingSeconds:1,idleUnloadSeconds:0});

test('recorder requests bounded mono 16k PCM and accepts natural sample-count exit',async()=>{
  let received;
  const rec=recordAudio(config,new AbortController().signal,()=>{}, {spawn:(command,args,opts)=>{
    received={command,args};return spawn(process.execPath,['-e','process.stdout.write(Buffer.alloc(6400))'],opts);
  }});
  assert.equal((await rec.result).length,6400);assert.equal(received.command,'pw-record');
  assert.deepEqual(received.args,['--raw','--rate','16000','--channels','1','--format','s16','--sample-count','16000','-']);
});

test('recorder errors are surfaced instead of transcribing partial audio',async()=>{
  const rec=recordAudio(config,undefined,()=>{}, {spawn:(_c,_a,opts)=>spawn(process.execPath,['-e',"process.stdout.write(Buffer.alloc(6400));process.stderr.write('device unavailable');process.exitCode=2"],opts)});
  await assert.rejects(rec.result,/device unavailable/);
});

test('failed spawn is observed and does not leave timers/children',async()=>{
  const rec=recordAudio(config,undefined,()=>{}, {spawn:(_c,_a,opts)=>spawn('/no-such-pi-voice-test-executable',[],opts)});
  await assert.rejects(rec.result,/ENOENT/);
});

test('microphone cancellation discards buffered audio',async()=>{
  const abort=new AbortController();let child;
  const rec=recordAudio(config,abort.signal,()=>{}, {spawn:(_c,_a,opts)=>{
    child=spawn(process.execPath,['-e','process.stdout.write(Buffer.alloc(6400));setInterval(()=>{},1000)'],opts);return child;
  }});
  await once(child.stdout,'data');abort.abort();await assert.rejects(rec.result,{name:'AbortError'});
  assert.notEqual(child.signalCode,null);
});

test('finish returns buffered PCM and waits for recorder exit',async()=>{
  let child;
  const rec=recordAudio(config,undefined,()=>{}, {spawn:(_c,_a,opts)=>{
    child=spawn(process.execPath,['-e','process.stdout.write(Buffer.alloc(6400));setInterval(()=>{},1000)'],opts);return child;
  }});
  await once(child.stdout,'data');rec.finish();assert.equal((await rec.result).length,6400);
  assert.equal(child.signalCode,'SIGINT');
});

test('pw-cat SIGINT convention (exit 1 without stderr) finalizes valid recorded PCM',async()=>{
  let child;
  const rec=recordAudio(config,undefined,()=>{}, {spawn:(_c,_a,opts)=>{
    child=spawn(process.execPath,['-e',"process.on('SIGINT',()=>process.exit(1));process.stdout.write(Buffer.alloc(6400));setInterval(()=>{},1000)"],opts);return child;
  }});
  await once(child.stdout,'data');rec.finish();assert.equal((await rec.result).length,6400);assert.equal(child.exitCode,1);
});

test('recording memory cap rejects oversized data',async()=>{
  const rec=recordAudio(config,undefined,()=>{}, {spawn:(_c,_a,opts)=>spawn(process.execPath,['-e','process.stdout.write(Buffer.alloc(64000))'],opts)});
  await assert.rejects(rec.result,/超过/);
});

test('playback uses a private WAV, reports completion, and deletes the file',async()=>{
  let filename;
  await playAudio(Buffer.from('fixture'),config,undefined,{spawn:(command,args,opts)=>{
    assert.equal(command,'pw-play');filename=args.at(-1);
    return spawn(process.execPath,['-e',"const fs=require('fs');if(fs.readFileSync(process.argv[1],'utf8')!=='fixture')process.exit(1)",filename],opts);
  }});
  await assert.rejects(access(filename),{code:'ENOENT'});
});

test('playback cancellation waits for child exit and deletes WAV',async()=>{
  const abort=new AbortController();let filename,child;
  const playing=playAudio(Buffer.from('fixture'),config,abort.signal,{spawn:(_command,args,opts)=>{
    filename=args.at(-1);child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],opts);
    child.once('spawn',()=>abort.abort());return child;
  }});
  await assert.rejects(playing,{name:'AbortError'});await assert.rejects(access(filename),{code:'ENOENT'});assert.notEqual(child.signalCode,null);
});

test('player device errors are not silently treated as success',async()=>{
  await assert.rejects(playAudio(Buffer.alloc(44),config,undefined,{spawn:(_c,_a,opts)=>spawn(process.execPath,['-e',"process.stderr.write('sink missing');process.exitCode=1"],opts)}),/sink missing/);
});

test('process cleanup escalates for a child ignoring SIGTERM',async()=>{
  const owner=new OwnedProcesses();
  const child=owner.spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});process.stdout.write('ready');setInterval(()=>{},1000)"],{stdio:['ignore','pipe','pipe']});
  await once(child.stdout,'data');await owner.stop();assert.equal(child.signalCode,'SIGKILL');assert.equal(owner.children.size,0);await owner.stop();
});

test('configuration validates unknown keys, bounds and absolute model paths',()=>{
  assert.throws(()=>resolveConfig({maxRecordingSeconds:121}),/maxRecordingSeconds/);
  assert.throws(()=>resolveConfig({asrModel:'relative'}),/绝对路径/);
  assert.throws(()=>resolveConfig({autoReed:true}),/未知/);
  assert.throws(()=>resolveConfig({voice:''}),/voice/);
  const c=resolveConfig({dshRoot:'/custom',idleUnloadSeconds:0});assert.equal(c.asrModel,'/custom/models/voice-multimodel/qwen');
});
