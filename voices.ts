import { execFile } from 'node:child_process';
import { mkdirSync, writeFileSync, unlinkSync, existsSync, statSync, readFileSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { checkAbort } from './processes.ts';

export const REFERENCE_TEXT = '你好，这是我的声音。我希望用自然清晰的语气，朗读中文和日常对话。';
export const PRESET_VOICES = [
  { id: 'zero_shot_zh', label: '默认中文', source: '预置' },
  { id: 'cross_lingual_zh', label: '跨语言参考', source: '预置' },
];

export function matchingVoices(entries, name) {
  return entries.filter(v => v.id === name || v.label === name || (name === 'zero_shot_prompt' && v.id === 'zero_shot_zh'));
}

export function referenceName(value) {
  const name = String(value ?? '').trim();
  if (!/^[\p{L}\p{N}][\p{L}\p{N} _-]{0,63}$/u.test(name)) throw new Error('音色名请用 1–64 个中文、字母、数字、空格、短横线或下划线，不能含路径');
  return name;
}
export function validateReference(pcm) {
  if (!Buffer.isBuffer(pcm) || pcm.length % 2) throw new Error('参考音频必须是单声道 PCM16');
  const seconds = pcm.length / 32000;
  if (seconds < 3 || seconds > 20) throw new Error(`参考音频需 3–20 秒，当前 ${seconds.toFixed(1)} 秒；建议 5–15 秒干净单人语音`);
  let sum = 0;
  for (let i = 0; i < pcm.length; i += 2) sum += (pcm.readInt16LE(i) / 32768) ** 2;
  const rms = Math.sqrt(sum / (pcm.length / 2));
  if (rms < 0.001) throw new Error('参考音频为静音或音量过低，请靠近麦克风重新录制');
  return { seconds, rms };
}
export function pcmWav(pcm) {
  const header = Buffer.alloc(44);
  header.write('RIFF'); header.writeUInt32LE(pcm.length + 36, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16000, 24); header.writeUInt32LE(32000, 28); header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

export class VoiceLibrary {
  constructor(config, deps = {}) { this.config = config; this.scan = deps.scan; this.exec = deps.exec ?? execFile; }
  async list() {
    this.scan ??= (await import(pathToFileURL(join(this.config.pluginDir, 'lib/core/ref-wavs.js')).href)).listRefWavs;
    return this.listSync();
  }
  // Pi argument completion is synchronous. Load the scanner at TUI startup,
  // then rescan filenames only so new/deleted references appear immediately.
  listSync() {
    const scan = this.scan ?? (() => []);
    const voices = [...PRESET_VOICES];
    for (const [source, dir] of [['Pi', this.config.refsDir], ['DSH', this.config.dshRefsDir]]) {
      for (const item of scan(dir)) {
        if (!voices.some(v => v.id === item.id)) voices.push({ ...item, source });
      }
    }
    return voices;
  }
  completions(prefix, current) {
    const entries = this.listSync(), query = prefix.trimStart().toLocaleLowerCase();
    return entries.filter(v => [v.label, v.id].some(value => value.toLocaleLowerCase().startsWith(query)))
      .map(v => ({
        // Short names are convenient; ambiguous names must insert the exact ID.
        value: `use ${matchingVoices(entries, v.label).length === 1 ? v.label : v.id}`,
        label: `${v.id === current ? '✓ ' : ''}${v.source}: ${v.label}`,
        description: `${v.id === current ? '当前音色 · ' : ''}${v.id}`,
      }));
  }
  assertAvailable(name) {
    name = referenceName(name);
    if (['.wav', '.flac', '.txt'].some(ext => existsSync(join(this.config.refsDir, name + ext)))) {
      throw new Error(`音色“${name}”已存在，请换一个名称；不会覆盖旧录音`);
    }
    return name;
  }
  save(name, pcm, text) {
    name = this.assertAvailable(name);
    const info = validateReference(pcm);
    const transcript = String(text ?? '').trim();
    if (!transcript || transcript.length > 4000) throw new Error('请提供与参考音频一致的逐字稿（1–4000 字符）');
    mkdirSync(this.config.refsDir, { recursive: true, mode: 0o700 });
    const id = join(this.config.refsDir, name + '.wav'), textPath = join(this.config.refsDir, name + '.txt');
    const created = [];
    try {
      writeFileSync(id, pcmWav(pcm), { flag: 'wx', mode: 0o600 }); created.push(id);
      writeFileSync(textPath, transcript + '\n', { flag: 'wx', mode: 0o600 }); created.push(textPath);
    } catch (error) {
      for (const file of created) unlinkSync(file);
      throw error;
    }
    return { id, textPath, label: name, ...info };
  }
  resolveFile(file, cwd) {
    const expanded = file.startsWith('~/') ? join(homedir(), file.slice(2)) : file;
    const path = resolve(cwd, expanded), stat = statSync(path);
    if (!stat.isFile() || stat.size > 100 * 1024 * 1024) throw new Error('请选择本地音频文件（不超过 100 MB）');
    if (!['.wav', '.flac', '.mp3', '.m4a', '.ogg'].includes(extname(path).toLowerCase())) throw new Error('支持 WAV、FLAC、MP3、M4A、OGG');
    return path;
  }
  sidecar(file) {
    const path = join(dirname(file), basename(file, extname(file)) + '.txt');
    try {
      if (statSync(path).size > 16000) return '';
      return readFileSync(path, 'utf8').trim();
    } catch { return ''; }
  }
  decode(file, signal) {
    checkAbort(signal);
    return new Promise((resolve, reject) => {
      // Decode at most 21s, then reject >20s instead of silently truncating a voice.
      this.exec('ffmpeg', ['-nostdin', '-v', 'error', '-protocol_whitelist', 'file,pipe', '-i', file,
        '-t', '21', '-ac', '1', '-ar', '16000', '-f', 's16le', 'pipe:1'],
      { encoding: 'buffer', signal, timeout: 15000, maxBuffer: 21 * 32000 + 1024 }, (error, stdout) => {
        try {
          checkAbort(signal);
          if (error) throw new Error(`参考音频解码失败：${error.message}`);
          validateReference(stdout);
          resolve(stdout);
        } catch (e) { reject(e); }
      });
    });
  }
}
