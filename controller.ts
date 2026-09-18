import { recordAudio, playAudio } from './audio.ts';
import { checkAbort, safeMessage } from './processes.ts';
import { playPipelined } from './pipeline.ts';
import { VoiceLibrary, REFERENCE_TEXT, matchingVoices } from './voices.ts';
import { saveConfigPatch } from './config.ts';

export function assistantText(message) {
  if (message?.role !== 'assistant' || message.stopReason !== 'stop') return '';
  return (message.content ?? []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
}
export function lastReply(entries) {
  for (let i = entries.length - 1; i >= 0; i--) {
    const text = entries[i].type === 'message' ? assistantText(entries[i].message) : '';
    if (text) return text;
  }
  return '';
}

export class VoiceController {
  constructor(config, backend, deps = {}) {
    this.config = config;
    this.backend = backend;
    this.record = deps.record ?? recordAudio;
    this.play = deps.play ?? playAudio;
    this.library = deps.library ?? new VoiceLibrary(config);
    this.persist = deps.persist ?? saveConfigPatch;
    this.job = null;
    this.tail = Promise.resolve();
    this.disposed = false;
    this.autoRead = false;
    this.autoQueue = [];
    this.idleTimer = null;
    this.inputEpoch = 0;
    this.operation = 0;
  }
  status(ctx, text = '') {
    if (this.disposed || ctx?.mode !== 'tui') return;
    ctx.ui.setStatus('local-voice', text || `语音 Alt+M · 朗读 Alt+S${this.autoRead ? ' · 自动朗读开' : ''}`);
  }
  notify(ctx, text, level = 'info') {
    if (!this.disposed && ctx?.mode === 'tui') ctx.ui.notify(text, level);
  }
  start(ctx, kind, action, automatic = false) {
    if (this.disposed || ctx.mode !== 'tui') return;
    clearTimeout(this.idleTimer);
    if (!automatic) this.autoQueue = [];
    const previous = this.tail;
    this.job?.abort.abort();
    const job = { kind, automatic, abort: new AbortController(), recorder: null, epoch: this.inputEpoch };
    this.job = job;
    ++this.operation;
    const current = () => this.job === job && !job.abort.signal.aborted && !this.disposed;
    const update = text => { if (current()) this.status(ctx, text); };
    update(kind === 'record' ? '语音：准备录音… Alt+X 取消'
      : kind === 'reference' ? '语音：音色设置… Alt+X 取消' : '语音：准备朗读… Alt+X 停止');
    job.done = (async () => {
      await previous;
      checkAbort(job.abort.signal);
      await action(job, update, current);
    })().catch(error => {
      if (current()) this.notify(ctx, `语音失败：${safeMessage(error)}`, 'error');
    }).finally(() => {
      if (this.job !== job) return;
      this.job = null;
      this.status(ctx);
      if (this.disposed) return;
      if (this.autoQueue.length && this.autoRead) {
        const next = this.autoQueue.shift();
        const op = this.operation;
        // Start outside this promise's finally; Stop also invalidates this deferred start.
        queueMicrotask(() => {
          if (op === this.operation && !this.job && !this.disposed && this.autoRead) this.speak(next.ctx, next.text, true);
        });
      } else if (this.config.idleUnloadSeconds) {
        this.idleTimer = setTimeout(() => {
          if (!this.job && !this.disposed) void this.stop(ctx, true).catch(e => this.notify(ctx, safeMessage(e), 'error'));
        }, this.config.idleUnloadSeconds * 1000);
        this.idleTimer.unref?.();
      }
    });
    this.tail = job.done;
    return job;
  }
  toggleRecord(ctx) {
    if (this.job?.kind === 'record') {
      if (this.job.recorder) this.job.recorder.finish();
      else void this.stop(ctx).catch(e => this.notify(ctx, safeMessage(e), 'error'));
      return;
    }
    this.start(ctx, 'record', async (job, update, current) => {
      const signal = job.abort.signal;
      job.recorder = this.record(this.config, signal, () => update('● 正在录音 · Alt+M 停止转写 · Alt+X 取消'));
      const audio = await job.recorder.result;
      job.recorder = null;
      checkAbort(signal);
      job.kind = 'asr';
      update('语音：Qwen ASR 识别中… Alt+X 取消');
      const result = await this.backend.transcribe(audio, signal);
      checkAbort(signal);
      if (!current() || job.epoch !== this.inputEpoch) return;
      const text = String(result.text ?? '').trim();
      if (!text) { this.notify(ctx, '未识别到语音（静音或音量过低）', 'warning'); return; }
      // Use native paste rather than replacing editor state/attached images. Never submit.
      const prefix = ctx.ui.getEditorText().trim() ? '\n' : '';
      ctx.ui.pasteToEditor(prefix + text);
      this.notify(ctx, '识别文字已填入输入框，确认后按 Enter 发送');
    });
  }
  speak(ctx, text, automatic = false) {
    if (!text?.trim()) { this.notify(ctx, '当前分支没有可朗读的完整回复', 'warning'); return; }
    // Bound resource use explicitly; never silently truncate a long reply.
    if (text.length > 30000) { this.notify(ctx, '回复超过 30000 字符，请用 /speak 指定较短文本', 'warning'); return; }
    this.start(ctx, 'tts', async (job, update) => {
      const signal = job.abort.signal;
      const segments = await this.backend.segments(text, signal);
      checkAbort(signal);
      if (!segments.length) { this.notify(ctx, '没有可朗读的正文（代码和表格不朗读）', 'warning'); return; }
      await playPipelined(segments,
        (text, signal) => this.backend.synthesize(text, signal),
        (audio, signal) => this.play(audio.wav, this.config, signal),
        { signal, prebuffer: this.config.prebufferSentences, progress: update });
    }, automatic);
  }
  async listVoices(ctx) {
    const entries = await this.library.list();
    this.notify(ctx, entries.map(v => `${v.id === this.config.voice ? '✓ ' : ''}${v.source}: ${v.label} — ${v.id}`).join('\n'));
  }
  applyVoice(id) {
    this.persist({ voice: id });
    this.config.voice = id;
  }
  chooseVoice(ctx, name = '') {
    this.start(ctx, 'reference', async job => {
      const signal = job.abort.signal;
      const entries = await this.library.list();
      checkAbort(signal);
      let selected;
      if (name) {
        const found = matchingVoices(entries, name);
        if (found.length !== 1) throw new Error('音色不存在或名称重复，请用 /voice use 从列表选择');
        selected = found[0];
      } else {
        const labels = entries.map(v => `${v.id === this.config.voice ? '✓ ' : ''}${v.source}: ${v.label} [${v.id}]`);
        const choice = await ctx.ui.select('选择 CosyVoice 3 音色（仅修改 Pi）', labels, { signal });
        checkAbort(signal);
        if (choice === undefined) return;
        selected = entries[labels.indexOf(choice)];
        if (!selected) return;
      }
      await this.backend.unload();
      checkAbort(signal);
      this.applyVoice(selected.id);
      this.notify(ctx, `已选用 ${selected.label}，已保存；/speak 指定文字即可试听。DSH 设置未改动。`);
    });
  }
  cloneVoice(ctx, name = '', fromFile = false) {
    this.start(ctx, 'reference', async (job, update) => {
      const signal = job.abort.signal;
      if (!name) name = await ctx.ui.input('音色名称（仅使用本人或已授权的声音）', '我的声音', { signal });
      checkAbort(signal);
      if (name === undefined) return;
      name = this.library.assertAvailable(name);
      let file;
      if (fromFile) {
        const path = await ctx.ui.input('本地参考音频路径（3–20 秒；WAV/FLAC/MP3/M4A/OGG）', '/path/to/reference.wav', { signal });
        checkAbort(signal);
        if (!path) return;
        file = this.library.resolveFile(path, ctx.cwd);
      }
      const defaultText = fromFile ? this.library.sidecar(file) : REFERENCE_TEXT;
      const entered = await ctx.ui.input(defaultText ? '参考逐字稿（回车使用示例／同名 TXT；必须与声音一致）' : '参考音频逐字稿（必填，与音频一致）', defaultText, { signal });
      checkAbort(signal);
      if (entered === undefined) return;
      const text = entered.trim() || defaultText;
      if (!text) throw new Error('克隆音色需要准确的参考逐字稿');
      let pcm;
      if (fromFile) {
        update('语音：导入参考音频… Alt+X 取消');
        pcm = await this.library.decode(file, signal);
      } else {
        const ready = await ctx.ui.confirm('准备录制音色？', `请照读：${text}\n确认后开麦，录制 3–20 秒；Alt+M 结束，Alt+X 放弃。录音将保存在 Pi 音色目录。`, { signal });
        checkAbort(signal);
        if (!ready) return;
        job.kind = 'record';
        job.recorder = this.record({ ...this.config, maxRecordingSeconds: 20 }, signal,
          () => update('● 正在录制音色 · Alt+M 保存 · Alt+X 放弃 · 最长 20 秒'));
        pcm = await job.recorder.result;
        job.recorder = null;
        job.kind = 'reference';
      }
      checkAbort(signal);
      await this.backend.unload();
      checkAbort(signal);
      // Commit is synchronous: Stop cannot land between the final abort check and saving.
      const ref = this.library.save(name, pcm, text);
      try { this.applyVoice(ref.id); }
      catch (error) { throw new Error(`音色已保存到 ${ref.id}，但设置默认音色失败：${safeMessage(error)}`); }
      this.notify(ctx, `音色 ${ref.label} 已保存并选用（${ref.seconds.toFixed(1)} 秒）：${ref.id}\n用 /speak 你好，这是我的声音。试听；原 DSH 音色不受影响。`);
    });
  }
  automatic(ctx, text) {
    if (!this.autoRead || !text || this.disposed) return;
    if (['record', 'asr', 'reference'].includes(this.job?.kind)) {
      this.notify(ctx, '正在语音输入或配置音色，已跳过本次自动朗读，避免回声', 'info'); return;
    }
    if (this.job) {
      if (this.autoQueue.length >= 3) { this.notify(ctx, '自动朗读队列已满，请手动朗读此回复', 'warning'); return; }
      this.autoQueue.push({ ctx, text });
    } else this.speak(ctx, text, true);
  }
  async setAuto(ctx, enabled) {
    this.autoRead = enabled;
    if (!enabled) {
      this.autoQueue = [];
      if (this.job?.automatic) await this.stop(ctx);
    }
    this.status(ctx);
    this.notify(ctx, `本次会话自动朗读已${enabled ? '开启' : '关闭'}（重新加载后默认关闭）`);
  }
  async stop(ctx, unload = true) {
    clearTimeout(this.idleTimer);
    this.autoQueue = [];
    const op = ++this.operation;
    const previous = this.tail;
    this.job?.abort.abort();
    this.job = null;
    this.status(ctx, unload ? '语音：停止并释放模型…' : '语音：已停止');
    const done = previous.then(() => unload ? this.backend.unload() : undefined);
    // Record cleanup as a barrier so a new operation cannot race model unloading.
    this.tail = done.catch(() => {});
    await done;
    if (this.operation === op) this.status(ctx);
  }
  inputSubmitted(ctx) {
    ++this.inputEpoch;
    if (['record', 'asr', 'reference'].includes(this.job?.kind)) {
      void this.stop(ctx).catch(e => this.notify(ctx, safeMessage(e), 'error'));
      this.notify(ctx, '输入已提交，已取消旧录音／转写，避免写入下一条消息', 'info');
    }
  }
  async dispose(ctx) {
    this.disposed = true;
    await this.stop(ctx, true);
    if (ctx?.mode === 'tui') ctx.ui.setStatus('local-voice', undefined);
  }
}
