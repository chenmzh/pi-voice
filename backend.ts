import { access } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { OwnedProcesses, checkAbort } from './processes.ts';

/** Reuse DSH's workers and normalizer without activating its host/browser plugin. */
export class DshBackend {
  constructor(config) {
    this.config = config;
    this.active = null;
    this.queue = Promise.resolve();
    this.modules = null;
    this.logTail = '';
  }
  log = line => { this.logTail = (this.logTail + '\n' + line).slice(-6000); };
  async imports() {
    if (!this.modules) {
      const load = file => import(pathToFileURL(join(this.config.pluginDir, 'lib/core', file)).href);
      this.modules = Promise.all(['python-asr.js', 'python-tts.js', 'tts-engines.js', 'text-prep.js', 'asr-languages.js', 'tts-instruct.js'].map(load))
        .then(parts => Object.assign({}, ...parts));
    }
    try { return await this.modules; }
    catch (error) { this.modules = null; throw new Error(`无法复用 DSH 语音模块 (${this.config.pluginDir}): ${error.message}`); }
  }
  serial(task) {
    const result = this.queue.then(task);
    this.queue = result.catch(() => {});
    return result;
  }
  async release() {
    const active = this.active;
    if (!active) return;
    active.proc.dispose();
    await active.owner.stop();
    if (this.active === active) this.active = null;
  }
  unload() { return this.serial(() => this.release()); }
  async ensure(kind, signal) {
    checkAbort(signal);
    if (this.active?.kind === kind) return this.active;
    await this.release(); // Wait for CUDA context exit before switching models.
    checkAbort(signal);
    const modules = await this.imports();
    checkAbort(signal);
    const c = this.config;
    const owner = new OwnedProcesses();
    let proc;
    if (kind === 'asr') {
      if (!modules.isAsrLanguage(c.asrLanguage)) throw new Error(`不支持的 ASR 语言: ${c.asrLanguage}`);
      await access(c.asrPython, constants.X_OK);
      await access(c.asrModel);
      proc = new modules.PythonAsr({ nativeBackend: 'qwen', pythonExecutable: c.asrPython,
        qwenModelDir: c.asrModel, asrDevice: 'cuda' }, this.log, { spawn: owner.spawn });
    } else {
      if (!modules.isInstructLanguage(c.instructLanguage)) throw new Error(`不支持的 TTS 指令语言: ${c.instructLanguage}`);
      const spec = modules.resolveEngineSpec('cosyvoice3', { ttsRoot: c.ttsRoot, modelsRoot: c.ttsModelsRoot });
      spec.defaultVoice = c.voice;
      await access(spec.python, constants.X_OK);
      await access(spec.modelDir);
      proc = new modules.PythonTts(spec, this.log, { spawn: owner.spawn });
    }
    checkAbort(signal);
    this.active = { kind, owner, proc };
    return this.active;
  }
  run(kind, signal, action) {
    return this.serial(async () => {
      const active = await this.ensure(kind, signal);
      const cancel = () => active.proc.dispose();
      signal?.addEventListener('abort', cancel, { once: true });
      try {
        checkAbort(signal);
        await active.proc.start();
        checkAbort(signal);
        return await action(active.proc, await this.imports());
      } catch (error) {
        await this.release();
        checkAbort(signal);
        throw error;
      } finally { signal?.removeEventListener('abort', cancel); }
    });
  }
  transcribe(audio, signal) {
    if (!Buffer.isBuffer(audio) || audio.length % 2 || audio.length > 16000 * 2 * 120) return Promise.reject(new Error('录音必须是 16kHz 单声道 PCM16，且不超过 120 秒'));
    return this.run('asr', signal, (proc, modules) => proc.transcribe(audio, {
      language: modules.backendLanguage(this.config.asrLanguage, 'qwen'),
    }));
  }
  async segments(text, signal) {
    checkAbort(signal);
    const { prepareSegments } = await this.imports();
    checkAbort(signal);
    const result = await prepareSegments(text, {
      engine: 'cosyvoice3', textnormPath: this.config.textnormPath,
      exec: (command, args, options, callback) => execFile(command, args, { ...options, signal }, callback),
    });
    checkAbort(signal);
    // Fail visibly instead of reading code/URLs after a silent normalizer fallback.
    if (result.degraded) throw new Error('DSH 文本预处理不可用；已停止朗读，请检查 textnormPath');
    return result.segments.filter(s => /[\p{L}\p{N}]/u.test(s));
  }
  synthesize(text, signal) {
    return this.run('tts', signal, async (proc, modules) => {
      const instruct = modules.buildInstruct(this.config.instructLanguage, this.config.instructText);
      const result = await proc.speak({ text, voice: this.config.voice, prepared: true, ...(instruct ? { instruct } : {}) });
      checkAbort(signal);
      if (!result.wav?.length) throw new Error(`CosyVoice 3 未生成音频: ${result.skipped || 'empty WAV'}`);
      return result;
    });
  }
}
