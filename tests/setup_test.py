import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('voice_setup', Path(__file__).resolve().parents[1]/'tools/setup.py')
setup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(setup)

class SetupTests(unittest.TestCase):
    def test_asr_only_does_not_install_or_download_tts(self):
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ, {'PI_CODING_AGENT_DIR':tmp}), \
             patch.object(setup.shutil,'which',return_value='/mock/tool'), patch.object(setup,'run') as run, \
             patch.object(setup,'install_python') as install, patch.object(setup,'download') as download, \
             contextlib.redirect_stdout(io.StringIO()):
            path=Path(tmp)/'local-voice.json';path.write_text(json.dumps({'voice':'custom','ttsModel':'/existing/tts'}))
            self.assertEqual(setup.main(['--asr','--yes','--data-dir',str(Path(tmp)/'data')]),0)
            self.assertEqual([c.args[0] for c in install.call_args_list],['asr'])
            self.assertEqual([c.args[1] for c in download.call_args_list],['asr'])
            self.assertFalse(any('git'==c.args[0] or 'modelscope' in str(c.args) for c in run.call_args_list))
            config=json.loads(path.read_text());self.assertEqual(config['voice'],'custom');self.assertEqual(config['ttsModel'],'/existing/tts')
            self.assertEqual(config['backend'],'native')

    def test_tts_only_can_reuse_everything_without_download(self):
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ, {'PI_CODING_AGENT_DIR':tmp}), \
             patch.object(setup.shutil,'which',return_value='/mock/tool'),patch.object(setup,'run') as run, \
             patch.object(setup,'install_python') as install,patch.object(setup,'download') as download, \
             contextlib.redirect_stdout(io.StringIO()):
            argv=['--tts','--yes','--data-dir',tmp]
            for name in ['tts-python','tts-model','cosyvoice-repo','wetext-model']:argv+=['--'+name,tmp]
            self.assertEqual(setup.main(argv),0)
            install.assert_not_called();download.assert_not_called()
            self.assertFalse(any('asr' in str(c.args) or 'snapshot_download' in str(c.args) for c in run.call_args_list))
            config=json.loads((Path(tmp)/'local-voice.json').read_text());self.assertNotIn('asrPython',config)

    def test_dry_run_has_no_files_network_or_processes(self):
        with tempfile.TemporaryDirectory() as tmp,patch.object(setup,'run') as run,patch.object(setup,'save_config') as save,contextlib.redirect_stdout(io.StringIO()) as out:
            self.assertEqual(setup.main(['--tts','--dry-run','--data-dir',str(Path(tmp)/'absent')]),0)
            run.assert_not_called();save.assert_not_called();self.assertFalse((Path(tmp)/'absent').exists())
            data=json.loads(out.getvalue());self.assertEqual(data['features'],['tts']);self.assertNotIn('asrModel',data['paths'])

    def test_no_selection_never_defaults_to_downloading_both(self):
        with patch.object(setup.sys.stdin,'isatty',return_value=False),patch.object(setup,'run') as run:
            with self.assertRaisesRegex(ValueError,'Choose'):setup.main([])
            run.assert_not_called()

if __name__=='__main__':unittest.main()
