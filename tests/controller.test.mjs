import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as tick } from 'node:timers/promises';
import { VoiceController, assistantText, lastReply } from '../controller.ts';
import registerVoice from '../extension.ts';
import { resolveConfig } from '../config.ts';
import { VoiceLibrary } from '../voices.ts';

function deferred() { let resolve, reject; const promise = new Promise((a,b) => {resolve=a;reject=b;}); return {promise,resolve,reject}; }
function context() {
  const notices=[], statuses=[]; let draft='';
  return { mode:'tui',hasUI:true,isIdle:()=>true,sessionManager:{getBranch:()=>[]},notices,statuses,
    ui:{notify:(...x)=>notices.push(x),setStatus:(...x)=>statuses.push(x),getEditorText:()=>draft,pasteToEditor:s=>{draft+=s;},setEditorText:s=>{draft=s;}} };
}
function setup(overrides = {}) {
  const ctx=context(), played=[], calls=[];
  const backend={
    segments:async t=>t.split('|'),
    synthesize:async text=>{calls.push(text);return {wav:Buffer.from(text)};},
    transcribe:async()=>({text:'你好'}),
    unload:async()=>{calls.push('unload');},
    ...overrides,
  };
  const c=new VoiceController(resolveConfig({idleUnloadSeconds:0}),backend,{play:async wav=>played.push(wav.toString())});
  return {ctx,c,backend,played,calls};
}
async function settle(c) { await c.tail; await tick(); await c.tail; }

test('extract only final assistant text, never thinking/tool/failed/partial replies',()=>{
  const msg={role:'assistant',stopReason:'stop',content:[{type:'thinking',thinking:'secret'},{type:'text',text:'answer'},{type:'toolCall',name:'bash'}]};
  assert.equal(assistantText(msg),'answer');
  for(const stopReason of ['toolUse','error','aborted','pending','length']) assert.equal(assistantText({...msg,stopReason}),'');
  assert.equal(lastReply([{type:'message',message:msg},{type:'message',message:{role:'user',content:'x'}}]),'answer');
});

test('recording preserves draft/edits and does not submit',async()=>{
  const {ctx,c}=setup(); const recording=deferred();
  c.record=(_config,_signal,started)=>{started();return {result:recording.promise,finish:()=>recording.resolve(Buffer.alloc(6400))};};
  ctx.ui.setEditorText('已有内容');
  c.toggleRecord(ctx); await tick();
  ctx.ui.pasteToEditor('，录音时继续打字');
  c.toggleRecord(ctx); await settle(c);
  assert.equal(ctx.ui.getEditorText(),'已有内容，录音时继续打字\n你好');
  assert.match(ctx.notices.at(-1)[0],/确认后按 Enter/);
  await c.dispose(ctx);
});

test('submitted input invalidates an in-flight transcription',async()=>{
  const pending=deferred();const {ctx,c}=setup({transcribe:()=>pending.promise});
  c.record=()=>({result:Promise.resolve(Buffer.alloc(6400)),finish(){}});
  c.toggleRecord(ctx);await tick();assert.equal(c.job.kind,'asr');
  c.inputSubmitted(ctx);ctx.ui.setEditorText('下一条草稿');pending.resolve({text:'迟到结果'});
  await settle(c);assert.equal(ctx.ui.getEditorText(),'下一条草稿');
  await c.dispose(ctx);
});

test('silence leaves draft untouched and reports it',async()=>{
  const {ctx,c}=setup({transcribe:async()=>({text:''})});
  c.record=()=>({result:Promise.resolve(Buffer.alloc(6400)),finish(){}});
  c.toggleRecord(ctx);await settle(c);assert.equal(ctx.ui.getEditorText(),'');assert.match(ctx.notices.at(-1)[0],/未识别到/);
  await c.dispose(ctx);
});

test('Stop during synthesis rejects late audio and following sentences',async()=>{
  const pending=deferred();const {ctx,c,played}=setup({synthesize:()=>pending.promise});
  c.speak(ctx,'one|two');await tick();const stopping=c.stop(ctx);
  pending.resolve({wav:Buffer.from('late')});await stopping;
  assert.deepEqual(played,[]);assert.equal(c.job,null);
  await c.dispose(ctx);
});

test('Stop aborts active playback and waits for exit before replacement',async()=>{
  const {ctx,c,played,calls}=setup();const exited=deferred();let signal;
  c.play=async(wav,_config,s)=>{played.push(wav.toString());signal=s;await exited.promise;};
  c.speak(ctx,'first');await tick();const stop=c.stop(ctx,true);
  c.speak(ctx,'second');await tick();assert.ok(signal.aborted);assert.deepEqual(calls,['first']);
  exited.resolve();await stop;await settle(c);assert.deepEqual(calls,['first','unload','second']);
  await c.dispose(ctx);
});

test('automatic playback queues behind manual playback without interruption',async()=>{
  const {ctx,c,played}=setup();const pending=deferred();let count=0;
  c.play=async wav=>{played.push(wav.toString());if(++count===1)await pending.promise;};
  await c.setAuto(ctx,true);c.speak(ctx,'manual');await tick();c.automatic(ctx,'automatic');
  assert.equal(c.autoQueue.length,1);assert.ok(!c.job.abort.signal.aborted);
  pending.resolve();await settle(c);assert.deepEqual(played,['manual','automatic']);await c.dispose(ctx);
});

test('Stop clears queued automatic responses',async()=>{
  const {ctx,c,played}=setup();const pending=deferred();c.play=async wav=>{played.push(wav.toString());await pending.promise;};
  await c.setAuto(ctx,true);c.speak(ctx,'manual');await tick();c.automatic(ctx,'queued');
  const stop=c.stop(ctx);pending.resolve();await stop;await settle(c);assert.deepEqual(played,['manual']);assert.equal(c.autoQueue.length,0);
  await c.dispose(ctx);
});

test('automatic playback is skipped while recording to avoid feedback',async()=>{
  const {ctx,c}=setup();const pending=deferred();
  c.record=(_config,signal)=>{signal.addEventListener('abort',()=>pending.reject(new DOMException('cancel','AbortError')));return{result:pending.promise,finish(){}};};
  await c.setAuto(ctx,true);c.toggleRecord(ctx);await tick();c.automatic(ctx,'do not play');
  assert.equal(c.autoQueue.length,0);assert.equal(c.job.kind,'record');await c.dispose(ctx);
});

test('model or playback error surfaces; no falsely completed or skipped sentences',async()=>{
  const {ctx,c,played}=setup({synthesize:async()=>{throw new Error('GPU unavailable');}});
  c.speak(ctx,'one|two');await settle(c);assert.deepEqual(played,[]);assert.match(ctx.notices.at(-1)[0],/GPU unavailable/);assert.equal(ctx.notices.at(-1)[1],'error');
  await c.dispose(ctx);
});

test('shutdown invalidates late replies and cleans up idempotently',async()=>{
  const pending=deferred();const {ctx,c,played}=setup({synthesize:()=>pending.promise});
  c.speak(ctx,'one');await tick();const disposing=c.dispose(ctx);pending.resolve({wav:Buffer.from('late')});await disposing;
  assert.deepEqual(played,[]);await c.dispose(ctx);assert.equal(c.disposed,true);
});

function harness(deps={}) {
  const events=new Map(),commands=new Map(),shortcuts=new Map();
  registerVoice({on:(n,f)=>events.set(n,f),registerCommand:(n,o)=>commands.set(n,o),registerShortcut:(n,o)=>shortcuts.set(n,o)},{library:{list:async()=>[],completions:()=>[]},...deps});
  return {events,commands,shortcuts};
}

test('extension registers without starting processes; headless/RPC commands never record',async()=>{
  let initialized=0,recorded=0;
  const h=harness({loadConfig:()=>{initialized++;return resolveConfig();},record:()=>{recorded++;throw new Error('must not record');}});
  assert.equal(initialized,0);assert.deepEqual([...h.shortcuts.keys()],['alt+m','alt+s','alt+x']);
  for(const mode of ['rpc','print','json']) {
    const ctx=context();ctx.mode=mode;
    await h.events.get('session_start')({},ctx);await h.commands.get('voice').handler('',ctx);await h.commands.get('speak').handler('hi',ctx);
  }
  assert.equal(initialized,0);assert.equal(recorded,0);
});

test('auto speaks once at settled only, not history/startup or intermediate tool messages',async()=>{
  const played=[];const backend={segments:async t=>[t],synthesize:async t=>({wav:Buffer.from(t)}),unload:async()=>{}};
  const h=harness({loadConfig:()=>resolveConfig({idleUnloadSeconds:0}),backend,play:async w=>played.push(w.toString())});
  const ctx=context();await h.events.get('session_start')({},ctx);
  await h.commands.get('voice').handler('auto on',ctx);
  const message={role:'assistant',stopReason:'stop',content:[{type:'text',text:'final'}]};
  h.events.get('message_end')({message:{...message,stopReason:'toolUse'}},ctx);
  h.events.get('agent_settled')({},ctx);await tick();assert.deepEqual(played,[]);
  h.events.get('message_end')({message},ctx);assert.deepEqual(played,[]);
  h.events.get('agent_settled')({},ctx);await tick();h.events.get('agent_settled')({},ctx);await tick();assert.deepEqual(played,['final']);
  await h.events.get('session_shutdown')({},ctx);
});

test('/voice speak is an exact alias for /speak, including last reply and multiline text',async()=>{
  const played=[];
  const h=harness({loadConfig:()=>resolveConfig({idleUnloadSeconds:0}),
    backend:{segments:async t=>[t],synthesize:async t=>({wav:Buffer.from(t)}),unload:async()=>{}},
    play:async w=>played.push(w.toString())});
  const ctx=context();ctx.sessionManager.getBranch=()=>[{type:'message',message:{role:'assistant',stopReason:'stop',content:[{type:'text',text:'最后回复'}]}}];
  await h.commands.get('voice').handler('speak',ctx);await tick();
  await h.commands.get('voice').handler('speak 第一行\n第二行',ctx);await tick();
  await h.commands.get('speak').handler('原有命令',ctx);await tick();
  assert.deepEqual(played,['最后回复','第一行\n第二行','原有命令']);
  assert.ok(h.commands.get('voice').getArgumentCompletions('sp').some(x=>x.value==='speak'));
  await h.commands.get('voice').handler('help',ctx);assert.match(ctx.notices.at(-1)[0],/\/voice speak/);
  await h.events.get('session_shutdown')({},ctx);
});

test('/voice use completes existing voices and reflects selection in both menus',async()=>{
  const config=resolveConfig({refsDir:'/pi',dshRefsDir:'/dsh',idleUnloadSeconds:0}),saved=[];
  const library=new VoiceLibrary(config,{scan:dir=>dir==='/dsh'?[{id:'/dsh/Demo.wav',label:'Demo'},{id:'/dsh/Sample.wav',label:'Sample'}]:[]});
  const h=harness({loadConfig:()=>config,library,backend:{unload:async()=>{}},persist:p=>saved.push(p)});
  const ctx=context(),voice=h.commands.get('voice');
  assert.deepEqual(voice.getArgumentCompletions('use '),[]);
  await h.events.get('session_start')({},ctx);
  const items=voice.getArgumentCompletions('use ');
  assert.equal(items.length,4);assert.match(items[0].label,/^✓ /);
  assert.equal(voice.getArgumentCompletions('use').length,4);
  assert.deepEqual(voice.getArgumentCompletions('use d').map(v=>v.value),['use Demo']);
  await voice.handler(voice.getArgumentCompletions('use d')[0].value,ctx);await tick();
  assert.deepEqual(saved,[{voice:'/dsh/Demo.wav'}]);
  assert.match(voice.getArgumentCompletions('use d')[0].label,/^✓ DSH: Demo$/);
  ctx.ui.select=async(_title,labels)=>{assert.ok(labels.some(x=>x.startsWith('✓ DSH: Demo')));return labels.find(x=>x.startsWith('DSH: Sample'));};
  await voice.handler('use',ctx);await tick();
  assert.equal(config.voice,'/dsh/Sample.wav');assert.match(voice.getArgumentCompletions('use Sample')[0].label,/^✓ DSH: Sample$/);
  await h.events.get('session_shutdown')({},ctx);
});

test('voice discovery failure does not break help or the editor',async()=>{
  const h=harness({loadConfig:()=>resolveConfig(),backend:{unload:async()=>{}},library:{
    list:async()=>{throw new Error('missing scanner');},completions:()=>{throw new Error('unreadable directory');},
  }}),ctx=context();
  await h.events.get('session_start')({},ctx);assert.match(ctx.notices.at(-1)[0],/音色列表读取失败/);
  assert.deepEqual(h.commands.get('voice').getArgumentCompletions('use '),[]);
  await h.commands.get('voice').handler('help',ctx);assert.match(ctx.notices.at(-1)[0],/\/voice use/);
  await h.events.get('session_shutdown')({},ctx);
});

test('invalid config reports useful errors and never initializes audio',async()=>{
  const ctx=context();const h=harness({loadConfig:()=>{throw new Error('invalid local-voice.json');}});
  await h.commands.get('voice').handler('',ctx);assert.match(ctx.notices.at(-1)[0],/invalid local-voice/);
});
