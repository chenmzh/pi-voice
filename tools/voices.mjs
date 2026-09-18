import { readFileSync, statSync } from 'node:fs';
import { loadConfig, saveConfigPatch } from '../config.ts';
import { VoiceLibrary } from '../voices.ts';

const config = loadConfig(), library = new VoiceLibrary(config);
const [action, name, audioPath, textPath] = process.argv.slice(2);
try {
  if (action === 'list') {
    for (const v of await library.list()) console.log(`${v.id === config.voice ? '✓' : ' '} ${v.source}: ${v.label}\t${v.id}`);
  } else if (action === 'use' && name) {
    const entries = (await library.list()).filter(v => v.id === name || v.label === name);
    if (entries.length !== 1) throw new Error('音色不存在或重名，请先 list，再用完整音频路径选择');
    saveConfigPatch({ voice: entries[0].id });
    console.log(`已选用 ${entries[0].label}；已打开的 Pi 请 /reload。`);
  } else if (action === 'import' && name && audioPath && textPath) {
    library.assertAvailable(name);
    const path = library.resolveFile(audioPath, process.cwd());
    if (statSync(textPath).size > 16000) throw new Error('逐字稿文件过大');
    const text = readFileSync(textPath, 'utf8').trim();
    if (!text || text.length > 4000) throw new Error('参考逐字稿需 1–4000 字符');
    const pcm = await library.decode(path, AbortSignal.timeout(20000));
    const ref = library.save(name, pcm, text);
    console.log(`已保存音色 ${ref.label}：${ref.id}`);
    saveConfigPatch({ voice: ref.id });
    console.log('已设为 Pi 音色；已打开的 Pi 请 /reload。DSH 未改动。');
  } else {
    throw new Error('用法：node tools/voices.mjs list | use 名称或路径 | import 新名称 音频路径 逐字稿TXT路径');
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
