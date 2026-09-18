#!/usr/bin/env python3
"""Opt-in ASR and/or TTS provisioning. No downloads until an explicit selection."""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parent.parent
COSY_REPO = 'https://github.com/FunAudioLLM/CosyVoice.git'
COSY_REV = '074ca6dc9e80a2f424f1f74b48bdd7d3fea531cc'
MODELS = {
    'asr': ('Qwen/Qwen3-ASR-1.7B', '7278e1e70fe206f11671096ffdd38061171dd6e5'),
    'tts': ('FunAudioLLM/Fun-CosyVoice3-0.5B', '29e01c4e8d000f4bcd70751be16fa94bf3d85a18'),
}

def parser():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--asr', action='store_true', help='Only install speech recognition')
    p.add_argument('--tts', action='store_true', help='Only install speech synthesis')
    p.add_argument('--all', action='store_true', help='Install both features')
    p.add_argument('--yes', action='store_true', help='Confirm installation/downloads without prompting')
    p.add_argument('--dry-run', action='store_true', help='Print the plan without modifying files or downloading')
    p.add_argument('--data-dir', type=Path, default=Path(os.environ.get('XDG_DATA_HOME', Path.home()/'.local/share'))/'pi-voice')
    for name in ['asr-python', 'asr-model', 'tts-python', 'tts-model', 'cosyvoice-repo', 'wetext-model']:
        p.add_argument('--'+name, type=Path, help='Reuse this existing path without downloading/installing its contents')
    return p

def plan(args):
    data = args.data_dir.expanduser().resolve()
    profiles = [name for name in ['asr', 'tts'] if args.all or getattr(args, name)]
    paths = dict(asrPython=data/'asr/venv/bin/python', asrModel=data/'models/qwen3-asr',
        ttsPython=data/'tts/venv/bin/python', ttsModel=data/'models/cosyvoice3',
        cosyvoiceRepo=data/'cosyvoice', wetextModel=data/'models/wetext')
    for flag, key in [('asr_python','asrPython'),('asr_model','asrModel'),('tts_python','ttsPython'),
                      ('tts_model','ttsModel'),('cosyvoice_repo','cosyvoiceRepo'),('wetext_model','wetextModel')]:
        if getattr(args, flag): paths[key] = getattr(args, flag).expanduser().resolve()
    return data, profiles, paths

def run(*args):
    subprocess.run([str(a) for a in args], check=True)

def install_python(profile, path):
    env_dir = path.parent.parent
    if not path.exists(): run('uv', 'venv', '--python', '3.11', env_dir)
    run('uv','pip','install','--python',path,'torch==2.8.0','torchaudio==2.8.0',
        '--index-url','https://download.pytorch.org/whl/cu128')
    run('uv','pip','install','--python',path,'--build-constraint',ROOT/'python/build-constraints.in',
        '-r',ROOT/f'python/requirements-{profile}.in','torch==2.8.0','torchaudio==2.8.0')

def download(python, kind, target):
    model, revision = MODELS[kind]
    run(python, '-c', 'from huggingface_hub import snapshot_download; import sys; snapshot_download(sys.argv[1], revision=sys.argv[2], local_dir=sys.argv[3])', model, revision, target)

def save_config(patch):
    root = Path(os.environ.get('PI_CODING_AGENT_DIR', Path.home()/'.pi/agent'))
    target = root/'local-voice.json'
    current = json.loads(target.read_text()) if target.exists() else {}
    if not isinstance(current, dict): raise ValueError('Existing local-voice.json must be an object')
    current.update({key:str(value) for key,value in patch.items()})
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, tmp = tempfile.mkstemp(prefix='local-voice-', suffix='.tmp', dir=root)
    try:
        with os.fdopen(fd,'w') as out: json.dump(current,out,ensure_ascii=False,indent=2);out.write('\n')
        os.replace(tmp,target)
    finally:
        if os.path.exists(tmp):os.unlink(tmp)

def main(argv=None):
    args = parser().parse_args(argv)
    if not (args.asr or args.tts or args.all):
        if not sys.stdin.isatty(): raise ValueError('Choose --asr, --tts or --all; nothing was installed')
        choice = input('安装哪些功能？1=仅 ASR 语音输入，2=仅 TTS 朗读，3=两者，其他=取消：').strip()
        if choice not in ['1','2','3']: return 0
        args.asr, args.tts, args.all = choice=='1', choice=='2', choice=='3'
    data, profiles, paths = plan(args)
    keys = ['asrPython','asrModel'] if profiles==['asr'] else ['ttsPython','ttsModel','cosyvoiceRepo','wetextModel'] if profiles==['tts'] else list(paths)
    print(json.dumps({'features':profiles,'dataDir':str(data),'paths':{k:str(paths[k]) for k in keys},
        'reuse':{k:str(v) for k,v in vars(args).items() if k not in ['data_dir'] and isinstance(v,Path)}},ensure_ascii=False,indent=2))
    if args.dry_run: return 0
    if sys.platform != 'linux': raise ValueError('This installer currently supports Linux only')
    if not args.yes:
        if not sys.stdin.isatty() or input('将准备所选环境并下载缺少的组件（可能数 GB）；继续？[y/N] ').lower() != 'y':
            raise ValueError('Cancelled; use --yes to explicitly approve installation')
    required = ['nvidia-smi']
    if 'asr' in profiles: required += ['pw-record']
    if 'tts' in profiles: required += ['pw-play','ffmpeg']
    if any(not getattr(args, name+'_python') for name in profiles): required += ['uv']
    if 'tts' in profiles and not args.cosyvoice_repo: required += ['git']
    if 'tts' in profiles and not args.tts_python: required += ['c++']
    missing = [cmd for cmd in required if not shutil.which(cmd)]
    if missing: raise ValueError('Missing commands: '+', '.join(missing)+'; see README prerequisites')
    run('nvidia-smi','--query-gpu=name,driver_version','--format=csv,noheader')
    # Check every explicit reuse path before making any changes.
    for flag in ['asr_python','asr_model','tts_python','tts_model','cosyvoice_repo','wetext_model']:
        selected = ('asr' in profiles) if flag.startswith('asr_') else ('tts' in profiles)
        value = getattr(args,flag)
        if selected and value and not value.expanduser().exists(): raise ValueError('Reuse path does not exist: '+str(value))
    patch = {'backend':'native','dataDir':data}
    for profile in profiles:
        python = paths[profile+'Python']
        if not getattr(args,profile+'_python'): install_python(profile,python)
        run(python,'-c','import torch; assert torch.cuda.is_available(), "CUDA unavailable in this Python environment"')
        if profile=='asr':
            if not args.asr_model: download(python,'asr',paths['asrModel'])
            patch.update({k:paths[k] for k in ['asrPython','asrModel']})
        else:
            repo = paths['cosyvoiceRepo']
            if not args.cosyvoice_repo:
                if not repo.exists():
                    repo.parent.mkdir(parents=True,exist_ok=True)
                    run('git','clone','--filter=blob:none','--no-checkout',COSY_REPO,repo)
                else:
                    dirty = subprocess.check_output(['git','-C',str(repo),'status','--porcelain'],text=True)
                    remote = subprocess.check_output(['git','-C',str(repo),'remote','get-url','origin'],text=True).strip()
                    if dirty or remote != COSY_REPO: raise ValueError('Existing CosyVoice checkout is modified/unrecognized; use --cosyvoice-repo to reuse it explicitly')
                run('git','-C',repo,'fetch','--depth','1','origin',COSY_REV)
                run('git','-C',repo,'checkout','--detach',COSY_REV)
                run('git','-C',repo,'submodule','update','--init','--recursive','--depth','1')
            if not args.tts_model: download(python,'tts',paths['ttsModel'])
            if not args.wetext_model:
                run(python,'-c','from modelscope import snapshot_download; import sys; snapshot_download("pengzhendong/wetext", local_dir=sys.argv[1])',paths['wetextModel'])
            patch.update({k:paths[k] for k in ['ttsPython','ttsModel','cosyvoiceRepo','wetextModel']})
    save_config(patch)
    print('所选功能已准备好。在 Pi 中执行 /reload，再 /voice doctor。未安装的功能可日后单独添加。')
    return 0

if __name__ == '__main__':
    try: sys.exit(main())
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        print('Setup failed: '+str(error),file=sys.stderr);sys.exit(1)
