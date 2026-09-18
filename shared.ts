import net from 'node:net';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, chmodSync, lstatSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkAbort } from './processes.ts';

export function servicePaths(root = join(process.env.XDG_RUNTIME_DIR || join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'pi-voice'), 'pi-voice-service')) {
  return { root, socket: join(root, 'voice-v1.sock'), lock: join(root, 'daemon.lock') };
}
export function prepareServiceDirectory(root) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const info = lstatSync(root);
  if (!info.isDirectory() || info.isSymbolicLink() || (process.getuid && info.uid !== process.getuid())) throw new Error('共享语音目录不属于当前用户');
  chmodSync(root, 0o700);
}

/** Each connection owns one cancellable request; no audio is sent over TCP. */
export function serviceRequest(paths, payload, signal) {
  checkAbort(signal);
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(paths.socket);
    socket.setEncoding('utf8');
    let buffer = '', settled = false;
    const finish = (error, value) => {
      if (settled) return; settled = true;
      clearTimeout(timer); signal?.removeEventListener('abort', abort); socket.destroy();
      if (error) reject(error); else resolve(value);
    };
    const abort = () => finish(new DOMException('已取消', 'AbortError'));
    const timer = setTimeout(() => finish(new Error('共享语音请求超时')), 600000);
    signal?.addEventListener('abort', abort, { once: true });
    socket.on('connect', () => socket.write(JSON.stringify(payload) + '\n'));
    socket.on('error', error => finish(error));
    socket.on('close', () => finish(new Error('共享语音服务连接中断')));
    socket.on('data', data => {
      buffer += data.toString();
      if (buffer.length > 64 * 1024 * 1024) return finish(new Error('共享语音响应过大'));
      const end = buffer.indexOf('\n');
      if (end < 0) return;
      try {
        const message = JSON.parse(buffer.slice(0, end));
        if (!message.ok) finish(new Error(message.error || '共享语音请求失败'));
        else finish(null, message.result);
      } catch (error) { finish(error); }
    });
    if (signal?.aborted) abort();
  });
}

export class SharedBackend {
  constructor(config, deps = {}) {
    this.config = config; this.shared = true; this.active = null;
    this.clientId = randomUUID(); this.paths = servicePaths(deps.serviceRoot);
    this.pending = new Set(); this.connecting = null;
  }
  async ensureService(signal) {
    checkAbort(signal);
    try { await serviceRequest(this.paths, { op: 'status' }, signal); return; }
    catch (error) { if (!['ENOENT', 'ECONNREFUSED'].includes(error.code)) throw error; }
    if (!this.connecting) {
      this.connecting = (async () => {
        prepareServiceDirectory(this.paths.root);
        // flock --no-fork execs Node in-place and owns the lifetime lock. Only the
        // lock winner may remove a stale socket; simultaneous windows are safe.
        const child = spawn('flock', ['--nonblock', '--no-fork', this.paths.lock, 'node',
          fileURLToPath(new URL('./tools/daemon.mjs', import.meta.url)), this.paths.root],
        { detached: true, stdio: 'ignore' });
        let failure;
        child.on('error', error => { failure = error; }); child.unref();
        const deadline = Date.now() + 12000;
        while (Date.now() < deadline) {
          if (failure) throw failure;
          try { await serviceRequest(this.paths, { op: 'status' }); return; }
          catch (error) { if (!['ENOENT', 'ECONNREFUSED'].includes(error.code)) throw error; }
          await new Promise(resolve => setTimeout(resolve, 80));
        }
        throw new Error('共享语音服务无法启动。需要 Node >=22.18 和 flock；请运行 /voice doctor');
      })().finally(() => { this.connecting = null; });
    }
    await this.connecting; checkAbort(signal);
  }
  async call(op, data, signal) {
    const abort = new AbortController();
    const cancel = () => abort.abort();
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) abort.abort();
    this.pending.add(abort);
    try {
      await this.ensureService(abort.signal);
      const reply = await serviceRequest(this.paths, { op, data, config: this.config, clientId: this.clientId }, abort.signal);
      this.active = reply.active;
      return reply.value;
    } finally { signal?.removeEventListener('abort', cancel); this.pending.delete(abort); }
  }
  segments(text, signal) { return this.call('segments', text, signal); }
  transcribe(audio, signal) { return this.call('transcribe', audio.toString('base64'), signal); }
  async synthesize(text, signal) {
    const result = await this.call('synthesize', text, signal);
    return { ...result, wav: Buffer.from(result.wav, 'base64') };
  }
  async status() {
    try { return await serviceRequest(this.paths, { op: 'status' }); }
    catch (error) { if (['ENOENT','ECONNREFUSED'].includes(error.code)) return { running: false, active: null }; throw error; }
  }
  async unload() {
    for (const abort of this.pending) abort.abort();
    this.active = null;
    // Do not start a daemon merely to unload; release only this window's lease.
    try { await serviceRequest(this.paths, { op: 'release', clientId: this.clientId }); }
    catch (error) { if (!['ENOENT','ECONNREFUSED'].includes(error.code)) throw error; }
  }
}
