import { loadConfig, configPath } from './config.ts';
import { SharedBackend } from './shared.ts';
import { setupHelp, doctor } from './setup.ts';
import { VoiceController, assistantText, lastReply } from './controller.ts';
import { safeMessage } from './processes.ts';

export const HELP = [
  'Pi Voice v0.4.0 · 帮助',
  '/voice setup：选择安装 ASR / TTS / 两者；/voice doctor：检查环境（不下载、不加载模型）',
  'Alt+M / /voice：开始录音；再按一次停止并转写（只填输入框，不发送）',
  'Alt+S / /voice speak / /speak：朗读当前分支最后一条完整回复',
  '/voice speak 文本（或 /speak 文本）：朗读指定文字',
  'Alt+X / /voice stop：取消本窗口任务并释放使用权，不中断其他窗口；模型由共享服务管理',
  '/voice auto on|off：本次会话自动朗读（默认关闭；只读最终回复）',
  '/voice voices：列出 Pi / DSH 音色；/voice use [名称]：选择并保存音色',
  '/voice use 后空格：补全现有音色（✓ 当前）；直接执行 /voice use：打开选择列表',
  '/voice clone [名称]：录制新音色；/voice import [名称]：导入音频和逐字稿',
  '/voice status：状态和配置位置；/voice unload：释放模型；/voice help：帮助',
].join('\n');

export default function registerVoice(pi, deps = {}) {
  let controller = null, configError = null, candidate = '';
  const initialize = () => {
    if (controller || configError) return;
    try {
      const config = (deps.loadConfig ?? loadConfig)();
      const backend = deps.backend ?? new SharedBackend(config);
      controller = new VoiceController(config, backend, deps);
    } catch (error) { configError = error; }
  };
  const guard = (ctx, action) => {
    // hasUI is also true in RPC; microphone/speaker access is deliberately TUI-only.
    if (ctx.mode !== 'tui') {
      if (ctx.hasUI) ctx.ui.notify('本地语音仅在 Pi 交互终端启用，不在 RPC／子 agent 中开麦或播放', 'warning');
      return;
    }
    initialize();
    if (configError) { ctx.ui.notify(safeMessage(configError), 'error'); return; }
    return Promise.resolve().then(() => action(controller)).catch(error => ctx.ui.notify(safeMessage(error), 'error'));
  };
  pi.on('session_start', async (_event, ctx) => {
    if (ctx.mode !== 'tui') return;
    initialize();
    if (configError) ctx.ui.notify(safeMessage(configError), 'error');
    else {
      const voice = controller;
      voice.status(ctx);
      // Only discover reference filenames; never start workers or access audio.
      try { await voice.library.list(); }
      catch (error) { voice.notify(ctx, `音色列表读取失败：${safeMessage(error)}`, 'warning'); }
    }
  });
  pi.on('session_shutdown', async (_event, ctx) => {
    candidate = '';
    await controller?.dispose(ctx);
    controller = null;
    configError = null;
  });
  pi.on('session_tree', async (_event, ctx) => {
    candidate = '';
    await controller?.stop(ctx, true);
  });
  pi.on('input', (_event, ctx) => { controller?.inputSubmitted(ctx); });
  pi.on('agent_start', () => { candidate = ''; });
  pi.on('message_end', (event, ctx) => {
    if (ctx.mode === 'tui' && event.message?.role === 'assistant') candidate = assistantText(event.message);
  });
  pi.on('agent_settled', (_event, ctx) => {
    const text = candidate;
    candidate = '';
    if (ctx.mode === 'tui' && ctx.isIdle()) controller?.automatic(ctx, text);
  });
  pi.registerCommand('voice', {
    description: 'Pi Voice：录音 / speak / voices / use / clone / import / help',
    getArgumentCompletions: prefix => {
      const use = /^use(?:\s+([\s\S]*))?$/.exec(prefix);
      if (use) {
        try { return controller?.library.completions(use[1] ?? '', controller.config.voice) ?? []; }
        catch { return []; } // A disappearing/unreadable directory must not break the editor.
      }
      return ['help', 'setup', 'doctor', 'speak', 'status', 'stop', 'unload', 'auto on', 'auto off', 'voices', 'use', 'clone', 'import']
        .filter(value => value.startsWith(prefix)).map(value => ({ value, label: value }));
    },
    handler: (args, ctx) => guard(ctx, async voice => {
      const arg = args.trim();
      if (!arg) return voice.toggleRecord(ctx);
      if (arg === 'help') return ctx.ui.notify(HELP, 'info');
      if (arg === 'setup') return ctx.ui.notify(setupHelp(), 'info');
      if (arg === 'doctor') return ctx.ui.notify(await doctor(voice.config), 'info');
      if (arg === 'voices') return voice.listVoices(ctx);
      const speech = /^speak(?:\s+([\s\S]*))?$/.exec(arg);
      if (speech) return voice.speak(ctx, speech[1]?.trim() || lastReply(ctx.sessionManager.getBranch()));
      const action = /^(use|clone|import)(?:\s+(.*))?$/.exec(arg);
      if (action) {
        candidate = '';
        if (action[1] === 'use') return voice.chooseVoice(ctx, action[2] ?? '');
        return voice.cloneVoice(ctx, action[2] ?? '', action[1] === 'import');
      }
      if (arg === 'stop' || arg === 'unload') { candidate = ''; return voice.stop(ctx, true); }
      if (arg === 'auto on' || arg === 'auto off') {
        candidate = ''; return voice.setAuto(ctx, arg === 'auto on');
      }
      if (arg === 'status') {
        const service = await voice.backend.status?.();
        return ctx.ui.notify([
          ...(service ? [`共享服务：${service.running ? `PID ${service.pid}；模型 ${service.active?.kind ?? '未加载'}；使用窗口 ${service.clients}；排队 ${service.queued}` : '未启动（按需启动）'}`] : []),
          `本地语音：${voice.job?.kind ?? '空闲'}；模型：${voice.backend.active?.kind ?? '未加载'}；自动朗读：${voice.autoRead ? '开' : '关'}`,
          `输入：Qwen3-ASR；输出：CosyVoice 3；音色：${voice.config.voice}`,
          `配置：${configPath()}（修改后 /reload）`,
          `闲置卸载：${voice.config.idleUnloadSeconds} 秒；录音上限：${voice.config.maxRecordingSeconds} 秒；预缓冲：${voice.config.prebufferSentences} 句`,
          `Pi 音色目录：${voice.config.refsDir}；DSH 音色目录（只读）：${voice.config.dshRefsDir}`,
        ].join('\n'), 'info');
      }
      ctx.ui.notify(HELP, 'warning');
    }),
  });
  pi.registerCommand('speak', {
    description: 'CosyVoice 3 朗读最后完整回复，或 /speak 指定文本',
    handler: (args, ctx) => guard(ctx, voice => voice.speak(ctx, args.trim() || lastReply(ctx.sessionManager.getBranch()))),
  });
  pi.registerShortcut('alt+m', {
    description: 'Qwen ASR：开始／停止录音，文字填入输入框',
    handler: ctx => guard(ctx, voice => voice.toggleRecord(ctx)),
  });
  pi.registerShortcut('alt+s', {
    description: 'CosyVoice 3：朗读最后完整回复',
    handler: ctx => guard(ctx, voice => voice.speak(ctx, lastReply(ctx.sessionManager.getBranch()))),
  });
  pi.registerShortcut('alt+x', {
    description: '停止语音并释放本扩展的模型',
    handler: ctx => guard(ctx, voice => { candidate = ''; return voice.stop(ctx, true); }),
  });
}
