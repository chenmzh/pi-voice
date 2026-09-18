import net from 'node:net';
import { chmodSync, rmSync } from 'node:fs';
import { DshBackend } from './backend.ts';
import { NativeBackend } from './native.ts';
import { resolveConfig } from './config.ts';
import { checkAbort, safeMessage } from './processes.ts';
import { servicePaths, prepareServiceDirectory } from './shared.ts';

const MODEL_KEYS = ['backend','asrPython','asrModel','ttsPython','ttsModel','cosyvoiceRepo','wetextModel',
  'pluginDir','ttsRoot','ttsModelsRoot','textnormPath'];

/** A single process, one backend/model at a time, one ordered inference queue. */
export async function startService({ root, createBackend = config => config.backend === 'dsh' ? new DshBackend(config) : new NativeBackend(config) } = {}) {
  const paths = servicePaths(root);
  prepareServiceDirectory(paths.root);
  let backend = null, profile = '', tail = Promise.resolve(), activeJob = null, closing = false;
  let emptySince = Date.now();
  const jobs = new Set(), leases = new Map(), sockets = new Set();
  const active = () => backend?.active ? { kind: backend.active.kind,
    pid: backend.active.owner?.children.keys().next().value?.pid } : null;
  const status = () => ({ running: true, pid: process.pid, active: active(), clients: leases.size, queued: jobs.size - (activeJob ? 1 : 0) });
  const expire = () => {
    const now = Date.now();
    for (const [id, lease] of leases) if (lease.seconds && now - lease.touched >= lease.seconds * 1000 && ![...jobs].some(job => job.clientId === id)) leases.delete(id);
  };
  let cleanup = Promise.resolve();
  const releaseUnused = () => {
    // Mark cleanup as a barrier before any await; new jobs cannot race unloading.
    if (!jobs.size && !leases.size && backend?.active) {
      cleanup = backend.unload();
    }
    return cleanup;
  };
  const server = net.createServer(socket => {
    socket.setEncoding('utf8');
    sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket));
    let input = '', received = false;
    const headerTimer = setTimeout(() => socket.destroy(), 10000);
    socket.on('close', () => clearTimeout(headerTimer));
    const reply = result => { if (!socket.destroyed) socket.end(JSON.stringify({ ok: true, result }) + '\n'); };
    const failure = error => { if (!socket.destroyed) socket.end(JSON.stringify({ ok: false, error: safeMessage(error) }) + '\n'); };
    socket.on('data', data => {
      if (received) return;
      input += data.toString();
      if (input.length > 12 * 1024 * 1024) { socket.destroy(); return; }
      const end = input.indexOf('\n');
      if (end === -1) return;
      received = true; clearTimeout(headerTimer);
      let request;
      try { request = JSON.parse(input.slice(0, end)); } catch (error) { failure(error); return; }
      if (request.op === 'status') { reply(status()); return; }
      if (typeof request.clientId !== 'string' || request.clientId.length > 128) { failure(new Error('Invalid client ID')); return; }
      if (request.op === 'release') {
        leases.delete(request.clientId);
        const owned = [...jobs].filter(job => job.clientId === request.clientId);
        for (const job of owned) job.abort.abort();
        // Wait for this client's work only. Another window's active inference is untouched.
        void Promise.all(owned.map(job => job.done)).then(() => releaseUnused()).then(() => reply({ released: true, active: active() }), failure);
        return;
      }
      if (!['segments','transcribe','synthesize'].includes(request.op)) { failure(new Error('Unknown operation')); return; }
      let config;
      try {
        config = resolveConfig(request.config);
        if (typeof request.data !== 'string' || (request.op !== 'transcribe' && request.data.length > 30000)) throw new Error('Invalid request data');
      } catch (error) { failure(error); return; }
      if (jobs.size >= 32) { failure(new Error('共享语音队列已满，请稍后重试')); return; }
      const abort = new AbortController();
      let done;
      const job = { clientId: request.clientId, abort, done: new Promise(resolve => { done = resolve; }) };
      socket.on('close', () => abort.abort()); jobs.add(job);
      const execute = async () => {
        try {
          checkAbort(abort.signal); activeJob = job;
          await cleanup; checkAbort(abort.signal);
          const key = JSON.stringify(MODEL_KEYS.map(name => config[name]));
          if (!backend || key !== profile) {
            if (backend) await backend.unload();
            checkAbort(abort.signal);
            backend = createBackend(config); profile = key; leases.clear();
          } else backend.config = config;
          let value;
          if (request.op === 'segments') value = await backend.segments(request.data, abort.signal);
          else {
            const kind = request.op === 'transcribe' ? 'asr' : 'tts';
            // Leases for the previous kind cannot pin the newly switched model.
            if (backend.active && backend.active.kind !== kind) leases.clear();
            leases.set(request.clientId, { touched: Date.now(), seconds: config.idleUnloadSeconds });
            if (kind === 'asr') value = await backend.transcribe(Buffer.from(request.data, 'base64'), abort.signal);
            else {
              const audio = await backend.synthesize(request.data, abort.signal);
              value = { ...audio, wav: audio.wav.toString('base64') };
            }
            leases.set(request.clientId, { touched: Date.now(), seconds: config.idleUnloadSeconds });
          }
          checkAbort(abort.signal); reply({ value, active: active() });
        } catch (error) { leases.delete(request.clientId); failure(error); }
        finally { if (activeJob === job) activeJob = null; jobs.delete(job); done(); }
      };
      tail = tail.then(execute, execute);
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(paths.socket, () => { server.removeListener('error', reject); chmodSync(paths.socket, 0o600); resolve(); });
  });
  server.on('error', () => {});
  const interval = setInterval(() => {
    expire(); void releaseUnused().catch(() => {});
    if (jobs.size || leases.size) emptySince = Date.now();
    else if (Date.now() - emptySince > 60000) void close();
  }, 1000);
  interval.unref();
  async function close() {
    if (closing) return; closing = true; clearInterval(interval);
    for (const job of jobs) job.abort.abort();
    for (const socket of sockets) socket.destroy();
    await tail; await cleanup; await backend?.unload();
    await new Promise(resolve => server.close(resolve));
    rmSync(paths.socket, { force: true });
  }
  return { close, status, paths };
}
