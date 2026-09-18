import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { constants } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DshBackend } from './backend.ts';
import { OwnedProcesses, checkAbort } from './processes.ts';

const workerPath = fileURLToPath(new URL('./python/worker.py', import.meta.url));

/** One owned JSON-lines worker. Startup, calls, process failure and cancellation are bounded. */
export class JsonWorker {
  constructor(owner, python, args, log) {
    this.owner = owner; this.python = python; this.args = args; this.log = log;
    this.child = null; this.pending = new Map(); this.sequence = 0; this.buffer = '';
  }
  start() {
    if (this.ready) return this.ready;
    this.ready = new Promise((resolve, reject) => {
      const startup = setTimeout(() => this.fail(new Error('语音模型加载超时')), 420000);
      this.startup = { resolve: () => { clearTimeout(startup); this.startup = null; resolve(); },
        reject: error => { clearTimeout(startup); this.startup = null; reject(error); } };
      this.child = this.owner.spawn(this.python, this.args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', HF_HUB_DISABLE_TELEMETRY: '1', PYTHONUNBUFFERED: '1' },
      });
      this.child.stdout.setEncoding('utf8');
      this.child.on('error', error => this.fail(error));
      this.child.stdin.on('error', error => this.fail(error));
      this.child.on('close', (code, signal) => this.fail(new Error(`语音 worker 已退出 (${code ?? signal})`)));
      this.child.stderr.on('data', data => this.log(data.toString()));
      this.child.stdout.on('data', data => {
        this.buffer += data.toString();
        if (this.buffer.length > 64 * 1024 * 1024) return this.fail(new Error('语音 worker 输出过大'));
        let end;
        while ((end = this.buffer.indexOf('\n')) !== -1) {
          const line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1);
          let message;
          try { message = JSON.parse(line); } catch { this.log(line); continue; }
          if ('ready' in message) {
            if (message.ready) this.startup?.resolve();
            else this.fail(new Error(message.error || '语音模型加载失败'));
          } else {
            const request = this.pending.get(message.id);
            if (!request) continue;
            this.pending.delete(message.id); clearTimeout(request.timer);
            if (message.error) request.reject(new Error(message.error)); else request.resolve(message);
          }
        }
      });
    });
    return this.ready;
  }
  request(payload) {
    if (!this.child || this.child.exitCode !== null || this.child.signalCode !== null) return Promise.reject(new Error('语音 worker 未运行'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new Error('语音推理超时')), 180000);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ ...payload, id }) + '\n');
    });
  }
  fail(error) {
    this.startup?.reject(error);
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(error); }
    this.pending.clear(); this.child?.kill('SIGTERM');
  }
  dispose() { this.fail(new DOMException('已取消', 'AbortError')); }
}

export function speechSegments(text) {
  const clean = text.replace(/```[\s\S]*?(?:```|$)/g, '').replace(/~~~[\s\S]*?(?:~~~|$)/g, '')
    .replace(/^\s*\|.*$/gm, '').replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/https?:\/\/\S+/g, '')
    .replace(/^[\s]*[#>*+-]+\s*/gm, '').replace(/[`*_]/g, '').trim();
  const result = [];
  for (const sentence of clean.match(/[^。！？.!?\n]+[。！？.!?]?/gu) ?? []) {
    const chars = [...sentence.trim()];
    for (let i = 0; i < chars.length; i += 180) {
      const part = chars.slice(i, i + 180).join('').trim();
      if (/[\p{L}\p{N}]/u.test(part)) result.push(part);
    }
  }
  return result;
}

/** Reuse only the lifecycle/serialization of the legacy adapter; no DSH imports. */
export class NativeBackend extends DshBackend {
  constructor(config, deps = {}) { super(config); this.spawnImpl = deps.spawn; this.workerPath = deps.workerPath ?? workerPath; }
  async imports() { return {}; }
  async ensure(kind, signal) {
    checkAbort(signal);
    if (this.active?.kind === kind) return this.active;
    await this.release(); checkAbort(signal);
    const c = this.config, python = kind === 'asr' ? c.asrPython : c.ttsPython;
    const model = kind === 'asr' ? c.asrModel : c.ttsModel;
    try { await access(python, constants.X_OK); await access(join(model, kind === 'asr' ? 'config.json' : 'cosyvoice3.yaml')); }
    catch { throw new Error('本地语音环境尚未准备好，请先运行 /voice doctor，按 /voice setup 的说明安装'); }
    checkAbort(signal);
    const owner = new OwnedProcesses(this.spawnImpl);
    const proc = new JsonWorker(owner, python, [this.workerPath, '--kind', kind, '--model', model,
      '--repo', c.cosyvoiceRepo, '--wetext', c.wetextModel], this.log);
    this.active = { kind, owner, proc };
    return this.active;
  }
  async segments(text, signal) { checkAbort(signal); return speechSegments(text); }
  transcribe(audio, signal) {
    if (!Buffer.isBuffer(audio) || audio.length % 2 || audio.length > 120 * 32000) return Promise.reject(new Error('录音必须是 16kHz 单声道 PCM16，且不超过 120 秒'));
    return this.run('asr', signal, proc => proc.request({ audio: audio.toString('base64'), language: this.config.asrLanguage }));
  }
  synthesize(text, signal) {
    return this.run('tts', signal, async proc => {
      const data = await proc.request({ text, voice: this.config.voice, instruct: this.config.instructText, language: this.config.instructLanguage });
      checkAbort(signal);
      if (!data.wav) throw new Error('CosyVoice 3 未生成音频');
      return { ...data, wav: Buffer.from(data.wav, 'base64') };
    });
  }
}
