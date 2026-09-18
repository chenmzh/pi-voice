# Pi Voice

为 [Pi](https://pi.dev/) 提供本地 **Qwen3-ASR 语音输入**和 **CosyVoice 3 语音输出**。

- **按需安装**：只装 ASR、只装 TTS，或同时安装；也能复用已有环境和模型。
- **多窗口共享模型**：同一用户的 Pi 窗口连接一个本地服务，推理排队执行，不按窗口重复加载模型。
- **语音输入**：转写只填入编辑器，确认后再发送。
- **语音输出**：手动／自动朗读、流水线预合成、音色选择、克隆和导入。
- 默认后端不依赖 DSH；已有 DSH 环境仍可选用兼容后端。

## 快速开始

### 1. 安装插件

```sh
pi install git:github.com/chenmzh/pi-voice
```

在 Pi 中执行：

```text
/reload
/voice setup
```

`/voice setup` 会显示本机可直接复制到终端的安装命令。**安装插件本身不下载模型，也不启动语音推理。**

### 2. 选择需要的功能

安装脚本有三个入口，任选其一：

```sh
python3 <插件目录>/tools/setup.py --asr  # 仅语音输入
python3 <插件目录>/tools/setup.py --tts  # 仅语音输出
python3 <插件目录>/tools/setup.py --all  # 两者都安装
```

把 `<插件目录>` 换成 `/voice setup` 显示的实际路径。也可以不加功能选项，由脚本询问；不会默认下载全部模型。

- **只装 ASR**：准备 Qwen3-ASR，不下载 CosyVoice、WeText 或 TTS 环境。
- **只装 TTS**：准备 CosyVoice 3，不下载 Qwen3-ASR 或 ASR 环境。
- `--dry-run` 只显示计划；真正安装前会确认，`--yes` 可显式跳过确认。
- 两种 Python 环境相互隔离，避免不同版本的 Transformers 冲突。
- 模型和环境默认位于 `~/.local/share/pi-voice`，支持 `XDG_DATA_HOME` 和 `--data-dir`。

所需下载可能达到数 GB。脚本从 PyTorch、PyPI、GitHub、Hugging Face 和 ModelScope 获取对应组件；不用的功能可以以后再添加。

### 3. 检查并使用

```text
/reload
/voice doctor
```

- 语音输入：**Alt+M** 开始录音，再按一次停止并转写。
- 语音输出：`/speak 你好，这是语音测试。`
- 完整命令：`/voice help`，版本为 **Pi Voice v0.4.0**。

未安装的功能会提示准备环境，不会因使用另一项功能而自动下载安装。

## 环境要求

当前支持 **Linux + NVIDIA CUDA**，不承诺 CPU、macOS 或 Windows 推理可用。

- Pi（已验证 0.85.1）、Node.js >=22.18、Python 3。
- [uv](https://docs.astral.sh/uv/getting-started/installation/)：为新环境准备 Python 3.11 和依赖。复用已有 Python 时不需要为该功能创建环境。
- NVIDIA 驱动：需兼容安装脚本使用的 CUDA 12.8 PyTorch。
- 共享服务需要 `flock`（通常由 `util-linux` 提供）。
- ASR：PipeWire 的 `pw-record`。
- TTS：`pw-play`、`ffmpeg`；首次构建 TTS 环境还需要 Git 和 C++ 编译工具。

例如 Debian/Ubuntu 的系统工具可用以下命令安装：

```sh
sudo apt install python3 git ffmpeg pipewire-bin util-linux build-essential
```

其他发行版请使用对应包管理器。驱动、uv 和运行中的 PipeWire 会话需另行准备。建议预留充足磁盘空间；实际显存需求取决于模型、输入长度和其他 GPU 程序。

## 复用已有模型

使用 `--asr-python` / `--asr-model` 等参数指定已有绝对路径，会跳过对应环境安装或模型下载：

```sh
python3 <插件目录>/tools/setup.py --asr \
  --asr-python /path/to/asr/venv/bin/python \
  --asr-model /path/to/Qwen3-ASR-1.7B
```

TTS 可分别指定：

```sh
python3 <插件目录>/tools/setup.py --tts \
  --tts-python /path/to/tts/venv/bin/python \
  --tts-model /path/to/Fun-CosyVoice3-0.5B \
  --cosyvoice-repo /path/to/CosyVoice \
  --wetext-model /path/to/wetext
```

已有 Python 需包含相应推理依赖；已有 CosyVoice checkout 需兼容 CosyVoice 3。脚本不会向显式复用的 Python 环境安装包，也不会修改显式复用的模型／源码目录。

## 命令

| 命令／快捷键 | 作用 |
|---|---|
| `/voice setup` | 查看按功能安装及复用环境的命令 |
| `/voice doctor` | 检查工具和环境路径，不加载模型 |
| `/voice` / **Alt+M** | 开始录音，再按一次停止并转写 |
| `/voice speak` / `/speak` / **Alt+S** | 朗读当前分支最后一条正常完成的回复 |
| `/voice speak 文字` / `/speak 文字` | 朗读指定内容 |
| `/voice stop` / **Alt+X** | 取消本窗口任务并释放使用权 |
| `/voice auto on` / `/voice auto off` | 本会话自动朗读，默认关闭 |
| `/voice voices` | 查看预置、Pi 和已有 DSH 音色 |
| `/voice use` | 打开音色选择器 |
| `/voice use 名称` | 选用并保存音色 |
| `/voice clone 名称` | 录制本人或获授权的声音 |
| `/voice import 名称` | 导入本地音频与逐字稿 |
| `/voice status` | 本窗口状态及共享服务 PID、模型、排队情况 |
| `/voice unload` | 释放本窗口的模型使用权 |
| `/voice help` | 命令帮助 |

输入 `/voice use `（末尾空格）显示已有音色，↑/↓ 选择、Tab 补全、Enter 应用。继续输入名称可筛选，`✓` 表示当前音色。同名条目按来源区分并填入准确路径。

克隆建议使用 5–15 秒干净单人语音，允许 3–20 秒，并提供准确逐字稿。Alt+M 结束录制，Alt+X 放弃。导入支持 WAV、FLAC、MP3、M4A、OGG，可采用同名 TXT。保存后自动选用，已有同名文件不会被覆盖。

从源码目录也可操作音色：

```sh
node tools/voices.mjs list
node tools/voices.mjs use 我的声音
node tools/voices.mjs import 我的声音 /path/to/reference.wav /path/to/transcript.txt
```

## 多窗口如何工作

每个窗口自行录音和播放，推理请求通过当前用户的 Unix socket 发给共享服务；没有 TCP/HTTP 监听。

- 相同配置和模型在多个窗口之间复用同一个 Python worker。
- 共享服务一次执行一个推理请求；ASR/TTS 切换时先卸载旧模型，因此不会为每个窗口保留各自一套模型。
- 不同窗口可以选择不同音色，音色随请求传递。
- Stop／关闭窗口只取消该窗口的请求并释放它的使用权，不取消其他窗口的请求。
- 其他窗口仍持有使用权时，`/voice unload` 不会强制卸载共享模型；所有使用权释放或到期后才卸载。
- 默认闲置 300 秒释放；`idleUnloadSeconds: 0` 禁用该窗口的自动释放。服务无任务和使用者后自行退出。

共享范围是**同一用户、同一运行目录中的新版 Pi Voice 实例**。外部 DSH 程序、其他用户或旧版 Pi Voice 不受此服务管理。升级后请在所有已打开的 Pi 窗口执行一次 `/reload`；旧版窗口未重载前仍可能保留自己的 worker。

## 配置

配置文件：`~/.pi/agent/local-voice.json`，遵循 `PI_CODING_AGENT_DIR`。安装脚本会合并所选功能的配置，保留已有音色及其他设置。修改后 `/reload`。

参考 [config.example.json](config.example.json)。常用字段：

- `backend`：默认 `native`；`dsh` 为已有 DSH 环境的兼容模式。
- `dataDir`：安装资源根目录，默认 `$XDG_DATA_HOME/pi-voice` 或 `~/.local/share/pi-voice`。
- `asrPython` / `asrModel`：ASR Python 和模型路径。
- `ttsPython` / `ttsModel` / `cosyvoiceRepo` / `wetextModel`：TTS 所需路径。
- `voice`：预置 ID，或参考 WAV/FLAC 的绝对路径。
- `asrLanguage`：默认 `auto`；如 `zh`、`en`、`ja`。
- `instructLanguage` / `instructText`：TTS 语言和风格指令。
- `recordTarget` / `playbackTarget`：空串用默认设备；显式目标失败时不回退到其他设备。
- `maxRecordingSeconds`：1–120，默认 120。
- `idleUnloadSeconds`：0–3600，默认 300。
- `prebufferSentences`：1–4，默认 2；增加初始缓冲会增加首播等待。
- `refsDir`：Pi 音色目录，默认 Pi agent 目录下的 `voice-refs/`。
- `dshRefsDir`：已有 DSH 音色的发现目录，只读使用。

兼容 DSH 时设置 `backend: "dsh"` 和 `dshRoot`；也支持单独覆盖 `pluginDir`、`asrPython`、`asrModel`、`ttsRoot`、`ttsModelsRoot`、`textnormPath`。旧配置中显式指定 `dshRoot` 或 `pluginDir` 且未指定 `backend` 时，自动选用兼容模式。

## 使用边界

转写保留草稿和附件，不自动提交；确认发送后，文本会作为正常消息发给 Pi 当前选择的对话模型。自动朗读只读最终回复，不读 thinking、工具消息或历史内容，重新加载／新会话后默认关闭。录音或配置音色期间跳过自动朗读，避免回声。

仅交互 TUI 启用语音操作；RPC、print、JSON 和常规子 agent 不开麦或播放。模型按需启动。流水线预合成可以减少句间等待，但若合成长期慢于播放或其他窗口占用推理队列，仍可能出现停顿。

## 更新与开发

```sh
pi update --extensions
# 然后在所有 Pi 窗口执行 /reload
```

如果原来使用本地 `pi-local-voice`，切换 Git 安装前应先移除旧包的安装条目，避免重复注册命令。已有配置和音色目录可继续使用。

```sh
git clone https://github.com/chenmzh/pi-voice.git
cd pi-voice
npm test
npm run test:reload
pi install "$PWD"
```

单元测试包含多客户端复用、排队、取消隔离以及 ASR/TTS 独立安装选项。TUI 测试使用临时配置和占位文件。测试需要 Python 3、ffmpeg；TUI 测试还需要 Pi。运行时模块保持 `.ts`，以便 Pi `/reload` 正确刷新依赖。
