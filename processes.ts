import { spawn } from 'node:child_process';

export function abortError() { return new DOMException('已取消', 'AbortError'); }
export function checkAbort(signal) { if (signal?.aborted) throw abortError(); }
export function safeMessage(error) {
  return String(error?.message ?? error).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x1f\x7f]/g, ' ').slice(-1000);
}

/** Only children created by this instance are ever signalled. Never pkill by name. */
export class OwnedProcesses {
  constructor(spawnImpl = spawn) { this.spawnImpl = spawnImpl; this.children = new Map(); this.stopping = null; }
  spawn = (command, args, options) => {
    const child = this.spawnImpl(command, args, options);
    const record = { child, closed: null };
    record.closed = new Promise(resolve => {
      child.once('close', () => { this.children.delete(child); resolve(); });
    });
    // A listener is needed before an asynchronous failed spawn; callers still receive the error.
    child.on('error', () => {});
    this.children.set(child, record);
    return child;
  };
  async stop(signal = 'SIGTERM') {
    if (this.stopping) return this.stopping;
    const records = [...this.children.values()];
    if (!records.length) return;
    this.stopping = (async () => {
      const kill = sig => { for (const { child } of records) if (child.exitCode === null && child.signalCode === null) child.kill(sig); };
      kill(signal);
      const escalation = setTimeout(() => kill('SIGKILL'), 1500);
      let deadline;
      try {
        await Promise.race([
          Promise.all(records.map(r => r.closed)),
          new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('语音子进程未能退出；暂不加载新模型')), 6000); }),
        ]);
      } finally { clearTimeout(escalation); clearTimeout(deadline); }
    })();
    try { await this.stopping; } finally { this.stopping = null; }
  }
}
