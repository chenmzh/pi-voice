import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OwnedProcesses, checkAbort } from './processes.ts';

export function recordAudio(config, signal, onStarted = () => {}, deps = {}) {
  checkAbort(signal);
  const owner = new OwnedProcesses(deps.spawn);
  const args = ['--raw', '--rate', '16000', '--channels', '1', '--format', 's16',
    '--sample-count', String(config.maxRecordingSeconds * 16000)];
  if (config.recordTarget) args.push('--target', config.recordTarget,
    '--properties', '{ node.dont-fallback = true node.dont-reconnect = true }');
  args.push('-');
  const child = owner.spawn('pw-record', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let stopping = false, error = null, stderr = '', bytes = 0;
  const chunks = [];
  const finish = () => {
    if (stopping) return;
    stopping = true;
    void owner.stop('SIGINT').catch(e => { error = e; });
  };
  const abort = () => { void owner.stop().catch(e => { error = e; }); };
  signal?.addEventListener('abort', abort, { once: true });
  child.once('spawn', onStarted);
  child.on('error', e => { error = e; });
  child.stdout.on('error', e => { error = e; finish(); });
  child.stderr.on('data', data => { stderr = (stderr + data).slice(-2000); });
  let startupTimer;
  child.stdout.on('data', data => {
    clearTimeout(startupTimer);
    bytes += data.length;
    if (bytes > config.maxRecordingSeconds * 32000) {
      error = new Error('录音数据超过时长上限'); finish(); return;
    }
    chunks.push(data);
  });
  startupTimer = setTimeout(() => { error = new Error('录音设备未输出音频，请检查目标名称和麦克风权限'); finish(); }, 10000);
  const timer = setTimeout(finish, config.maxRecordingSeconds * 1000 + 1000);
  const result = new Promise((resolve, reject) => {
    child.once('close', (code, sig) => {
      clearTimeout(timer);
      clearTimeout(startupTimer);
      signal?.removeEventListener('abort', abort);
      try {
        checkAbort(signal);
        if (error) throw error;
        // PipeWire's pw-cat SIGINT handler exits with code 1 (no stderr),
        // rather than reporting signalCode=SIGINT. Accept only our requested stop.
        const requestedStop = stopping && (sig === 'SIGINT' || (code === 1 && !stderr.trim()));
        if (code !== 0 && !requestedStop) throw new Error(`麦克风录音失败 (${code ?? sig}): ${stderr}`);
        const audio = Buffer.concat(chunks);
        if (audio.length < 3200 || audio.length % 2) throw new Error('未收到有效麦克风音频，请检查默认输入设备');
        resolve(audio);
      } catch (e) { reject(e); }
    });
  });
  // The caller starts awaiting in a background job; keep failed-spawn timing safe.
  void result.catch(() => {});
  return { finish, result };
}

export async function playAudio(wav, config, signal, deps = {}) {
  checkAbort(signal);
  const dir = await mkdtemp(join(tmpdir(), 'pi-local-voice-'));
  const owner = new OwnedProcesses(deps.spawn);
  let timer;
  const abort = () => { void owner.stop().catch(() => {}); };
  try {
    const file = join(dir, 'speech.wav');
    await writeFile(file, wav, { mode: 0o600 });
    checkAbort(signal);
    const args = config.playbackTarget
      ? ['--target', config.playbackTarget, '--properties', '{ node.dont-fallback = true node.dont-reconnect = true }', file]
      : [file];
    const child = owner.spawn('pw-play', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    signal?.addEventListener('abort', abort, { once: true });
    let error, stderr = '';
    child.on('error', e => { error = e; });
    child.stderr.on('data', data => { stderr = (stderr + data).slice(-2000); });
    timer = setTimeout(() => { error = new Error('音频播放超时'); abort(); }, 180000);
    await new Promise((resolve, reject) => {
      child.once('close', (code, sig) => {
        try {
          checkAbort(signal);
          if (error) throw error;
          if (code !== 0) throw new Error(`播放失败 (${code ?? sig}): ${stderr}`);
          resolve();
        } catch (e) { reject(e); }
      });
    });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    await owner.stop();
    await rm(dir, { recursive: true, force: true });
  }
}
