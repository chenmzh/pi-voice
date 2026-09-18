"""Pi Voice local inference worker. JSON lines on stdout; diagnostics on stderr."""
import argparse
import base64
import contextlib
import io
import json
import os
from pathlib import Path
import sys
import time

parser = argparse.ArgumentParser()
parser.add_argument('--kind', choices=['asr', 'tts'], required=True)
parser.add_argument('--model', required=True)
parser.add_argument('--repo', required=True)
parser.add_argument('--wetext', required=True)
args = parser.parse_args()

# One managed model across this user's Pi Voice windows, including ASR/TTS.
# The OS releases the lease even after a crash; no stale PID-file ownership.
def acquire_gpu():
    import fcntl
    root = Path(os.environ.get('XDG_CACHE_HOME', Path.home() / '.cache')) / 'pi-voice'
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    lease = os.fdopen(os.open(root / 'gpu.lock', os.O_CREAT | os.O_RDWR, 0o600), 'r+')
    try:
        fcntl.flock(lease, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        lease.close()
        raise RuntimeError('另一个 Pi Voice 窗口正在使用模型。请在该窗口执行 /voice unload 后重试；未重复加载模型。')
    return lease

def emit(value):
    print(json.dumps(value, ensure_ascii=False), flush=True)

LANGUAGES = dict(zh='Chinese', en='English', ja='Japanese', ko='Korean', de='German',
    fr='French', es='Spanish', ru='Russian', it='Italian', pt='Portuguese', ar='Arabic',
    hi='Hindi', id='Indonesian', th='Thai', vi='Vietnamese', tr='Turkish', nl='Dutch',
    pl='Polish', cs='Czech', sv='Swedish', da='Danish', fi='Finnish', el='Greek', ro='Romanian')
PREFIX = 'You are a helpful assistant.<|endofprompt|>'
try:
    lease = acquire_gpu()
    with contextlib.redirect_stdout(sys.stderr):
        import numpy as np
        import torch
        if not torch.cuda.is_available():
            raise RuntimeError('CUDA 不可用；此版本需要可用的 NVIDIA 驱动和 CUDA PyTorch')
        if args.kind == 'asr':
            from qwen_asr import Qwen3ASRModel
            model = Qwen3ASRModel.from_pretrained(args.model, dtype=torch.bfloat16,
                device_map='cuda:0', attn_implementation='sdpa', max_inference_batch_size=1, max_new_tokens=1024)
        else:
            import soundfile as sf
            import torchaudio
            # SoundFile avoids a TorchCodec/FFmpeg-shared-library dependency in newer torchaudio.
            def load_audio(path, **_kwargs):
                samples, rate = sf.read(str(path), dtype='float32', always_2d=True)
                return torch.from_numpy(samples.T.copy()), rate
            torchaudio.load = load_audio
            if not Path(args.wetext).is_dir():
                raise RuntimeError('缺少 WeText 模型，请重新运行 setup --tts')
            import wetext.wetext as wetext
            wetext.snapshot_download = lambda *_a, **_kw: args.wetext
            sys.path[:0] = [args.repo, str(Path(args.repo) / 'third_party/Matcha-TTS')]
            from cosyvoice.cli.cosyvoice import AutoModel
            model = AutoModel(model_dir=args.model, load_trt=False, load_vllm=False, fp16=False)
            if not model.frontend.text_frontend:
                raise RuntimeError('CosyVoice 文本归一化不可用，请运行 /voice doctor')
    emit({'ready': True})
except Exception as error:
    emit({'ready': False, 'error': str(error)})
    sys.exit(1)

for line in sys.stdin:
    request = {}
    try:
        if len(line) > 12 * 1024 * 1024:
            raise ValueError('Request too large')
        request = json.loads(line)
        started = time.monotonic()
        with contextlib.redirect_stdout(sys.stderr):
            if args.kind == 'asr':
                pcm = base64.b64decode(request['audio'], validate=True)
                if len(pcm) % 2 or len(pcm) > 120 * 32000:
                    raise ValueError('Expected <=120s mono 16kHz PCM16')
                audio = np.frombuffer(pcm, dtype='<i2').astype(np.float32) / 32768
                if audio.size < 1600 or np.max(np.abs(audio), initial=0) < 0.001:
                    response = {'text': '', 'language': ''}
                else:
                    language = request.get('language', 'auto')
                    language = None if language == 'auto' else LANGUAGES.get(language, language)
                    result = model.transcribe(audio=(audio, 16000), language=language)[0]
                    response = {'text': result.text.strip(), 'language': result.language}
            else:
                voice = request.get('voice', 'zero_shot_zh')
                if voice in ('zero_shot_zh', 'zero_shot_prompt', 'cross_lingual_zh'):
                    reference = Path(args.repo) / 'asset/zero_shot_prompt.wav'
                    transcript = '希望你以后能够做的比我还好呦。' if voice != 'cross_lingual_zh' else ''
                else:
                    reference = Path(voice)
                    if not reference.is_absolute() or not reference.is_file():
                        raise ValueError('参考音色文件不存在，请用 /voice use 选择')
                    transcript_file = reference.with_suffix('.txt')
                    if transcript_file.exists() and transcript_file.stat().st_size > 16000:
                        raise ValueError('参考逐字稿过大')
                    transcript = transcript_file.read_text().strip() if transcript_file.exists() else ''
                text = request['text']
                if not isinstance(text, str) or not text or len(text) > 1000:
                    raise ValueError('TTS segment must be 1–1000 characters')
                instruction = request.get('instruct', '').strip()
                language = request.get('language', 'auto')
                if language != 'auto':
                    instruction = f'Speak in {LANGUAGES.get(language, language)}. {instruction}'
                if instruction:
                    chunks = model.inference_instruct2(text,
                        f'You are a helpful assistant. {instruction}<|endofprompt|>', str(reference), stream=False)
                elif transcript:
                    chunks = model.inference_zero_shot(text, PREFIX + transcript, str(reference), stream=False)
                else:
                    chunks = model.inference_cross_lingual(PREFIX + text, str(reference), stream=False)
                output = [chunk['tts_speech'].detach().cpu() for chunk in chunks]
                if not output:
                    raise RuntimeError('CosyVoice returned no audio')
                audio = torch.cat(output, dim=-1).squeeze(0).numpy()
                wav = io.BytesIO()
                sf.write(wav, audio, model.sample_rate, format='WAV', subtype='PCM_16')
                response = {'wav': base64.b64encode(wav.getvalue()).decode(), 'sampleRate': model.sample_rate,
                    'audioSeconds': len(audio) / model.sample_rate, 'synthSeconds': time.monotonic() - started}
        emit({'id': request['id'], **response})
    except Exception as error:
        emit({'id': request.get('id'), 'error': str(error)})
