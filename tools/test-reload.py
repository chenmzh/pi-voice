"""Real Pi hot-reload regression. Isolated config; no model calls or audio access.

Exercises legacy native .mjs -> .ts migration, then edits .ts dependencies while
THE SAME Pi process is still running. A fresh-start-only smoke misses this bug.
"""
import fcntl
import json
import os
from pathlib import Path
import pty
import select
import struct
import subprocess
import sys
import tempfile
import termios
import time

package = Path(__file__).resolve().parent.parent
root = Path(tempfile.mkdtemp(prefix='pi-voice-reload-test-'))
fixture = root / 'package'
agent = root / 'agent'
fixture.mkdir()
agent.mkdir()
sources = {p.name: p.read_text() for p in package.glob('*.ts')}
manifest = json.loads((package / 'package.json').read_text())
help_heading = f'Pi Voice v{manifest["version"]} · 帮助'
(fixture / 'package.json').write_text(json.dumps(manifest))
(agent / 'settings.json').write_text(json.dumps({'packages': [str(fixture)]}))
# A tiny test scanner avoids reading any installed backend or real voice directory.
backend = root / 'backend-fixture'
(backend / 'lib/core').mkdir(parents=True)
(backend / 'package.json').write_text('{"type":"module"}')
(backend / 'lib/core/ref-wavs.js').write_text(r'''
import { readdirSync } from 'node:fs';
import { join, basename, extname } from 'node:path';
export function listRefWavs(dir) {
  try { return readdirSync(dir).filter(n => /\.(wav|flac)$/i.test(n)).map(n => ({id:join(dir,n),label:basename(n,extname(n))})); }
  catch { return []; }
}
''')
(agent / 'local-voice.json').write_text(json.dumps({'pluginDir': str(backend), 'refsDir': str(root / 'refs'), 'dshRefsDir': str(root / 'dsh-refs')}))
(root / 'dsh-refs').mkdir()
for name in ['Demo', 'Sample']:
    # Discovery reads filenames only. These fixtures are never synthesized/played.
    (root / 'dsh-refs' / (name + '.wav')).write_bytes(b'filename-discovery fixture')
# A legacy installation with cacheable native ESM dependencies.
for name, content in sources.items():
    oldname = name if name == 'index.ts' else name.replace('.ts', '.mjs')
    content = content.replace(".ts'", ".mjs'")
    if name == 'extension.ts':
        content = content.replace(help_heading, 'LEGACY_HELP_MARKER')
        content = '\n'.join(line for line in content.splitlines() if "'/voice voices：" not in line and "'/voice clone [名称]：" not in line)
    if name == 'controller.ts':
        content = content.replace('  async listVoices(ctx) {', "  async listVoices(ctx) {\n    this.notify(ctx, 'LEGACY_CONTROLLER_MARKER'); return;")
    (fixture / oldname).write_text(content)

master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 45, 180, 0, 0))
env = dict(os.environ, PI_CODING_AGENT_DIR=str(agent), PI_OFFLINE='1', PI_TELEMETRY='0', TERM='xterm-256color')
process = subprocess.Popen(['pi', '--offline', '--no-approve', '--no-context-files', '--no-skills', '--no-prompt-templates', '--no-session'], stdin=slave, stdout=slave, stderr=slave, env=env, cwd=root, start_new_session=True)
os.close(slave)
output = bytearray()
results = {'pid': process.pid, 'evidence': str(root)}

def wait_for(needle, timeout=15):
    start = len(output)
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if select.select([master], [], [], 0.1)[0]:
            try:
                data = os.read(master, 65536)
            except OSError:
                break
            output.extend(data)
            if b'\x1b[6n' in data:
                os.write(master, b'\x1b[1;1R')
            if needle.encode() in output[start:]:
                return True
        if process.poll() is not None:
            break
    return False

def command(text, expected, key):
    os.write(master, (text + '\r').encode())
    results[key] = wait_for(expected)
    if not results[key]:
        raise RuntimeError(f'{text}: missing {expected}; see {root}/tui.ansi')

try:
    if not wait_for('Alt+M'):
        raise RuntimeError('Pi startup failed')
    command('/voice help', 'LEGACY_HELP_MARKER', 'legacyHelp')
    command('/voice voices', 'LEGACY_CONTROLLER_MARKER', 'legacyController')
    # Upgrade on disk without restarting the running Pi process.
    for name, content in sources.items():
        (fixture / name).write_text(content)
    for path in fixture.glob('*.mjs'):
        path.unlink()
    command('/reload', 'Reloaded', 'migrationReload')
    help_start = len(output)
    command('/voice help', '/voice clone [名称]', 'newCloneHelp')
    # Repeating an identical notification may produce no new TUI diff. Inspect
    # the same help rendering, rather than requiring a second repaint.
    results['newSpeakHelp'] = b'/voice speak' in output[help_start:]
    if not results['newSpeakHelp']:
        raise RuntimeError('Updated help does not show /voice speak')
    command('/voice speak', '当前分支没有可朗读的完整回复', 'speakDispatch')
    command('/voice voices', '预置: 默认中文', 'newController')
    os.write(master, b'/voice use ')
    results['voiceOptions'] = wait_for('DSH: Sample')
    if not results['voiceOptions']:
        raise RuntimeError('Existing voices missing from argument completion')
    # Narrow to Demo, complete the argument with Tab and execute it.
    os.write(master, b'D')
    if not wait_for('DSH: Demo'):
        raise RuntimeError('Voice prefix filter failed')
    command('\t', '已选用 Demo', 'completionSelection')
    results['savedSelection'] = json.loads((agent / 'local-voice.json').read_text())['voice'] == str(root / 'dsh-refs' / 'Demo.wav')
    os.write(master, b'/voice use ')
    results['currentVoiceMarked'] = wait_for('✓ DSH: Demo')
    if not results['savedSelection'] or not results['currentVoiceMarked']:
        raise RuntimeError('Selected voice not persisted/marked')
    os.write(master, b'Sample')
    if not wait_for('DSH: Sample'):
        raise RuntimeError('Second voice prefix filter failed')
    command('\t', '已选用 Sample', 'secondSelection')
    (root / 'dsh-refs' / '新音色.wav').write_bytes(b'filename-discovery fixture')
    os.write(master, '/voice use 新'.encode())
    results['newVoiceWithoutReload'] = wait_for('DSH: 新音色')
    if not results['newVoiceWithoutReload']:
        raise RuntimeError('New reference did not appear without reloading')
    command('\t', '已选用 新音色', 'newVoiceSelection')
    # Same filename changes must also reload, including transitive dependencies.
    path = fixture / 'extension.ts'
    path.write_text(path.read_text().replace(help_heading, 'UPDATED_TYPESCRIPT_HELP'))
    path = fixture / 'controller.ts'
    path.write_text(path.read_text().replace('  async listVoices(ctx) {', "  async listVoices(ctx) {\n    this.notify(ctx, 'UPDATED_TYPESCRIPT_CONTROLLER'); return;"))
    command('/reload', 'Reloaded', 'dependencyReload')
    command('/voice help', 'UPDATED_TYPESCRIPT_HELP', 'updatedHelp')
    command('/voice voices', 'UPDATED_TYPESCRIPT_CONTROLLER', 'updatedController')
    os.write(master, b'/quit\r')
    process.wait(timeout=12)
    results['exitCode'] = process.returncode
    results['ok'] = process.returncode == 0
except Exception as error:
    results['ok'] = False
    results['error'] = str(error)
finally:
    if process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
    os.close(master)
    (root / 'tui.ansi').write_bytes(output)
    (root / 'result.json').write_text(json.dumps(results, ensure_ascii=False, indent=2))
    print(json.dumps(results, ensure_ascii=False, indent=2))
    sys.exit(0 if results.get('ok') else 1)
