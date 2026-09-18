# Pi Voice

为 [Pi](https://pi.dev/) 提供本地 **Qwen3-ASR 语音输入**和 **CosyVoice 3 语音输出**的插件。

- 录音转文字，仅填入输入框，由你确认发送。
- 手动／自动朗读，流水线预合成减少句间等待。
- 音色选择、命令补全、零样本克隆和本地音频导入。
- 停止／取消、闲置模型卸载、会话清理。
- 仅在交互 TUI 中启用；不在 RPC、print、JSON 或常规子 agent 中开启音频。

> **当前是 DSH 本地语音后端的 Pi 适配器，不是独立的模型安装器。**
> 需要事先配置兼容的 DSH voice 插件、Python 环境和模型。仓库不包含该后端、模型权重、任何人的录音、逐字稿或用户配置，也不会自动下载这些文件。

## 环境要求

- Linux、PipeWire 的 `pw-record` / `pw-play`、`ffmpeg`。
- Pi（已在 0.85.1 验证），Node.js >=22.18；开发用 TUI 测试还需要 Python 3。
- 已可运行的 Qwen3-ASR / CosyVoice 3 本地 CUDA 环境。本适配器的 ASR 当前使用 CUDA，不承诺 CPU 或其他系统可用。
- DSH voice 插件的 `lib/core/` 需提供：
  `python-asr.js`、`python-tts.js`、`tts-engines.js`、`text-prep.js`、
  `asr-languages.js`、`tts-instruct.js`、`ref-wavs.js`，以及它们依赖的 Python worker。
  该插件不由本仓库分发；只有本仓库代码不足以启动语音推理。

## 安装

先确认已拥有仓库读取权限；私有仓库需要配置 GitHub Git 认证。

```sh
pi install git:github.com/chenmzh/pi-voice
```

然后在 Pi 中执行 `/reload`，运行 `/voice help`。第一行显示 **Pi Voice v0.3.0**。

如果之前装过本地 `pi-local-voice`，请先移除旧包的安装条目，再安装此包，避免两份扩展争用同一组命令。已有的 `local-voice.json` 和音色目录继续复用；卸载扩展不会删除它们。

也可从源码安装：

```sh
git clone https://github.com/chenmzh/pi-voice.git
cd pi-voice
pi install "$PWD"
```

更新使用 `pi update --extensions`，再 `/reload`；卸载：

```sh
pi remove git:github.com/chenmzh/pi-voice
```

## 配置后端

配置位于 `~/.pi/agent/local-voice.json`，遵循 `PI_CODING_AGENT_DIR`。此文件**不要放进仓库**。
参考 [config.example.json](config.example.json)，把 `dshRoot` 改成你的实际绝对路径。
如果已有配置，合并需要的字段，不要直接覆盖。

默认布局如下（均相对于 `dshRoot`）：

| 配置项 | 默认相对路径 |
|---|---|
| `pluginDir` | `plugins/dsh-voice-draft` |
| `asrPython` | `.runtime/voice-python/bin/python` |
| `asrModel` | `models/voice-multimodel/qwen` |
| `ttsRoot` | `.runtime/tts` |
| `ttsModelsRoot` | `models/tts` |
| `textnormPath` | `.runtime/tts/tools/textnorm.py` |

这些路径均可单独指定绝对路径。CosyVoice Python 和模型位置由已有 DSH `resolveEngineSpec('cosyvoice3', ...)` 解析。不启动 HTTP 服务，也不安装 vLLM。

其他配置：

- `voice`：预置 ID，或参考 WAV/FLAC 的绝对路径。同名 TXT 为准确逐字稿。
- `asrLanguage`：默认 `auto`，语言映射复用后端。
- `instructLanguage` / `instructText`：CosyVoice 语言／风格指令。
- `recordTarget` / `playbackTarget`：空串使用默认设备；显式目标不可用时拒绝回退到其他设备。
- `maxRecordingSeconds`：1–120，默认 120。
- `idleUnloadSeconds`：默认 300；0 表示不自动卸载，最大 3600。
- `prebufferSentences`：1–4，默认 2。较大的值会增加首播等待，但可减少缓冲耗尽。
- `refsDir`：Pi 音色目录，默认在 Pi agent 目录下的 `voice-refs/`。
- `dshRefsDir`：DSH 音色发现目录，默认 `$DSH_HOME/voice-refs` 或 `~/.dsh/voice-refs`，只读使用。

修改配置后 `/reload`。配置未知字段会报错，避免拼写错误被忽略。

## 命令

| 命令／快捷键 | 作用 |
|---|---|
| `/voice` / **Alt+M** | 开始录音，再按一次停止并转写 |
| `/voice speak` / `/speak` / **Alt+S** | 朗读当前分支最后一条正常完成的回复 |
| `/voice speak 文字` / `/speak 文字` | 朗读指定内容 |
| `/voice stop` / **Alt+X** | 取消操作，释放本扩展拥有的模型 |
| `/voice auto on` / `/voice auto off` | 本会话自动朗读，默认关闭 |
| `/voice voices` | 查看预置、Pi 和 DSH 音色 |
| `/voice use` | 打开音色选择器 |
| `/voice use 名称` | 选用并保存音色 |
| `/voice clone 名称` | 录制本人或获授权的声音 |
| `/voice import 名称` | 导入本地音频与准确逐字稿 |
| `/voice status` / `/voice unload` / `/voice help` | 状态／释放模型／帮助 |

输入 `/voice use `（末尾空格）显示已有音色，↑/↓ 选择、Tab 补全、Enter 应用；继续输入名称可筛选。`✓` 标记当前音色。同名条目通过来源区分并填入准确路径。新增／删除参考文件会在下次补全时重新发现。

## 克隆和导入音色

只使用本人或已获授权的声音；这属于**零样本参考音频克隆**，无需训练模型。

- 建议 5–15 秒干净的单人语音，允许 3–20 秒，需要准确逐字稿。
- `/voice clone 我的声音`：确认后开麦，Alt+M 保存，Alt+X 放弃。
- `/voice import 我的声音`：支持 WAV、FLAC、MP3、M4A、OGG；可采用同名 TXT。
- 保存成功后自动选用；已有同名文件不会被覆盖。
- Pi 新音色保存在 `refsDir`，不会修改 DSH 的设置或已有参考文件。

从源码目录也能在普通终端操作：

```sh
node tools/voices.mjs list
node tools/voices.mjs use 我的声音
node tools/voices.mjs import 我的声音 /path/to/reference.wav /path/to/transcript.txt
```

这些命令会更新 Pi 配置；其他已运行实例需要 `/reload`。

## 行为和资源边界

转写保留现有草稿和附件，不自动提交。自动朗读只读最终回复，不读 thinking、工具调用或历史消息；重新加载／新会话后默认关闭。录音或配置音色期间跳过自动朗读，避免回声。

合成与播放重叠，使用有界预取；不是整篇合成后才开始播放。长文本若合成持续慢于播放，仍可能产生停顿。模型按需启动，同一实例切换 ASR/TTS 时先等待旧进程退出；多个 Pi／DSH 实例仍可能各自占显存。只清理本扩展拥有的子进程。

不声称所有音频设备、GPU 或终端快捷键均已验证。请自行确认实际设备权限、按键传递和听感。

## 隐私

详见 [PRIVACY.md](PRIVACY.md)。语音推理使用本地后端，但**你确认发送转写文本后，该文本会作为正常消息发给 Pi 当前选择的对话模型**。

仓库只收录代码和通用示例；`.gitignore`、包文件白名单和隐私检查用于降低误提交风险，不替代人工审核。`private: true` 防止意外发布到 npm，不影响 Git 安装，也不决定 GitHub 仓库可见性。

## 开发和验证

```sh
npm test
npm run test:reload
# 提交前先暂存待提交文件，再检查实际 Git 索引：
git add <准备提交的代码文件>
npm run check:privacy
```

单元测试不调用模型、不使用真实麦克风或扬声器；导入测试需要 `ffmpeg`。TUI 回归使用临时配置、模拟后端文件扫描和非音频占位文件，验证同一 Pi 进程中的升级／重载、命令帮助、音色候选、选择和持久化，不依赖本机音色。

运行时依赖保持 `.ts`：Pi `/reload` 无法清除原生 `.mjs` 导入缓存，改回 `.mjs` 可能使运行中的扩展保持旧版。

可选真实模型冒烟测试（需要自己配置后端）：

```sh
node tools/smoke.mjs "$(mktemp -d)"
```

该测试合成示例文本再识别，不录音、不播放。输出 WAV 和诊断仅留在指定临时目录，**不要提交测试输出**。本次仓库整理未重新进行 GPU 性能验证。
