import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
export function setupHelp() {
  const command = `python3 ${quote(fileURLToPath(new URL('./tools/setup.py', import.meta.url)))}`;
  return ['Pi Voice 安装引导（在普通终端执行；不会自动开始下载）',
    `${command} --asr    # 仅语音输入，不安装 TTS`,
    `${command} --tts    # 仅朗读，不安装 ASR`,
    `${command} --all    # 两者都安装`,
    '不带选项会询问安装哪些功能；--dry-run 只显示计划。',
    '已有环境可用 --asr-python / --asr-model 或 --tts-python / --tts-model / --cosyvoice-repo / --wetext-model 指定绝对路径复用。',
    '需要 Linux、NVIDIA 驱动、uv，以及所选功能的 PipeWire/ffmpeg；TTS 新建环境还需要 C++ 编译器。',
    '首次准备可能下载数 GB 的依赖和模型；安装前会确认。完成后 /reload，再 /voice doctor。'].join('\n');
}
async function present(path, executable = false) {
  try { await access(path, executable ? constants.X_OK : constants.R_OK); return true; } catch { return false; }
}
async function commandAvailable(name) {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) if (dir && await present(join(dir, name), true)) return true;
  return false;
}
export async function doctor(config) {
  const lines = ['Pi Voice 环境检查', `后端：${config.backend}（跨窗口共享服务）`];
  for (const name of ['node','flock','pw-record','pw-play','ffmpeg']) lines.push(`${await commandAvailable(name) ? '✓' : '缺少'} ${name}`);
  try {
    const { stdout } = await exec('node', ['--version'], { timeout: 5000 });
    lines.push(`Node：${stdout.trim()}（需 >=22.18）`);
  } catch { /* Missing executable already listed above. */ }
  if (config.backend === 'dsh') {
    lines.push(`DSH 模块：${await present(join(config.pluginDir, 'lib/core/python-asr.js')) ? '可读' : '缺少'}`);
    lines.push(`ASR Python：${await present(config.asrPython,true) ? '可执行' : '未安装'}`);
    lines.push(`ASR 模型：${await present(config.asrModel) ? '已找到' : '未安装'}`);
    lines.push(`TTS Python：${await present(join(config.ttsRoot,'cosyvoice/venv/bin/python'),true) ? '可执行' : '未安装'}`);
  } else {
    for (const [feature, python, model, sentinel] of [
      ['ASR',config.asrPython,config.asrModel,'config.json'],
      ['TTS',config.ttsPython,config.ttsModel,'cosyvoice3.yaml'],
    ]) {
      const ready = await present(python,true) && await present(join(model,sentinel));
      lines.push(`${feature}：${ready ? '环境／模型路径已找到' : '未安装或不完整（可选）'}`);
    }
    lines.push(`CosyVoice 源码：${await present(join(config.cosyvoiceRepo,'cosyvoice/cli/cosyvoice.py')) ? '已找到' : '未安装（仅 TTS 需要）'}`);
    lines.push(`WeText：${await present(config.wetextModel) ? '已找到' : '未安装（仅 TTS 需要）'}`);
  }
  lines.push('此检查不加载模型；不代表 CUDA 推理测试通过。安装／复用现有模型：/voice setup');
  return lines.join('\n');
}
