import { checkAbort } from './processes.ts';

/** A bounded look-ahead queue: synthesis overlaps playback, never two GPU calls at once
 * (the backend serializes them). Prebuffering absorbs short synthesis-time spikes.
 * Every started promise is observed, including failures/cancellation during playback.
 */
export async function playPipelined(segments, synthesize, play, {
  signal, prebuffer = 2, progress = () => {},
} = {}) {
  checkAbort(signal);
  if (!segments.length) return;
  const local = new AbortController();
  const cancel = () => local.abort();
  signal?.addEventListener('abort', cancel, { once: true });
  const pending = [];
  let next = 0;
  const ahead = Math.min(Math.max(1, prebuffer), segments.length);
  const enqueue = () => {
    const index = next++;
    // Convert failures to values immediately, so a failed prefetched clip never
    // produces an unhandled rejection while the preceding clip is still playing.
    pending.push(Promise.resolve().then(() => {
      checkAbort(local.signal);
      return synthesize(segments[index], local.signal);
    }).then(audio => ({ audio, index }), error => ({ error, index })));
  };
  try {
    progress(`语音：预缓冲 ${ahead} 句… Alt+X 停止`);
    for (let i = 0; i < ahead; i++) enqueue();
    const initial = await Promise.all(pending);
    checkAbort(local.signal);
    const failed = initial.find(item => item.error);
    if (failed) throw failed.error;
    for (let i = 0; i < segments.length; i++) {
      const result = await pending.shift();
      checkAbort(local.signal);
      if (result.error) throw result.error;
      // Crucially do not await this synthesis before playing the current clip.
      if (next < segments.length) enqueue();
      progress(`语音：播放 ${i + 1}/${segments.length} · 后续音频预合成中 · Alt+X 停止`);
      await play(result.audio, local.signal);
      checkAbort(local.signal);
    }
  } finally {
    local.abort();
    await Promise.all(pending);
    signal?.removeEventListener('abort', cancel);
  }
}
