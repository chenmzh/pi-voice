import { homedir } from 'node:os';
import { join, isAbsolute, dirname } from 'node:path';
import { readFileSync, mkdirSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

export function configPath() {
  return join(process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi/agent'), 'local-voice.json');
}

export function loadConfig(path = configPath()) {
  let input = {};
  try { input = JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error(`语音配置 ${path}: ${error.message}`); }
  return resolveConfig(input);
}

export function resolveConfig(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('语音配置必须是 JSON 对象');
  const root = input.dshRoot ?? join(homedir(), 'deepseek_harness');
  const config = {
    dshRoot: root,
    pluginDir: join(root, 'plugins/dsh-voice-draft'),
    asrPython: join(root, '.runtime/voice-python/bin/python'),
    asrModel: join(root, 'models/voice-multimodel/qwen'),
    ttsRoot: join(root, '.runtime/tts'),
    ttsModelsRoot: join(root, 'models/tts'),
    textnormPath: join(root, '.runtime/tts/tools/textnorm.py'),
    asrLanguage: 'auto',
    voice: 'zero_shot_zh',
    instructLanguage: 'auto',
    instructText: '',
    recordTarget: '',
    playbackTarget: '',
    maxRecordingSeconds: 120,
    idleUnloadSeconds: 300,
    prebufferSentences: 2,
    refsDir: join(dirname(configPath()), 'voice-refs'),
    dshRefsDir: join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'voice-refs'),
    ...input,
  };
  // Validate the explicit schema, including unknown keys (typos must not be silent).
  const keys = ['dshRoot', 'pluginDir', 'asrPython', 'asrModel', 'ttsRoot', 'ttsModelsRoot',
    'textnormPath', 'asrLanguage', 'voice', 'instructLanguage', 'instructText',
    'recordTarget', 'playbackTarget', 'maxRecordingSeconds', 'idleUnloadSeconds',
    'prebufferSentences', 'refsDir', 'dshRefsDir'];
  for (const key of Object.keys(input)) if (!keys.includes(key)) throw new Error(`未知语音配置项: ${key}`);
  for (const key of [...keys.slice(0, 7), 'refsDir', 'dshRefsDir']) {
    if (typeof config[key] !== 'string' || !isAbsolute(config[key])) throw new Error(`${key} 必须是绝对路径`);
  }
  for (const key of keys.slice(7, 13)) if (typeof config[key] !== 'string') throw new Error(`${key} 必须是字符串`);
  if (!config.voice.trim()) throw new Error('voice 不能为空');
  for (const [key, min, max] of [['maxRecordingSeconds', 1, 120], ['idleUnloadSeconds', 0, 3600], ['prebufferSentences', 1, 4]]) {
    if (!Number.isInteger(config[key]) || config[key] < min || config[key] > max) throw new Error(`${key} 必须在 ${min}–${max} 之间`);
  }
  return config;
}

/** Merge at the moment of writing; do not clobber unrelated user settings with a stale snapshot. */
export function saveConfigPatch(patch, path = configPath()) {
  let current = {};
  try { current = JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const next = { ...current, ...patch };
  resolveConfig(next);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify(next, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    renameSync(temp, path);
  } finally { rmSync(temp, { force: true }); }
}
