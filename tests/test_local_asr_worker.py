"""Exercise real local IPC using tiny fake children, never Whisper/CUDA."""
from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from contextlib import redirect_stdout
from io import StringIO
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
from local_asr_worker import LocalWhisperProcess


class LocalWorkerTests(unittest.TestCase):
    def factory(self, code: str):
        original = subprocess.Popen
        def spawn(command: list[str], **kwargs: object):
            script = next(index for index, arg in enumerate(command) if arg.endswith(".py"))
            return original([*command[:script], "-c", code], **kwargs)
        return spawn

    def test_actual_isolated_worker_starts_without_loading_model(self) -> None:
        worker = Path(__file__).resolve().parents[1] / "tools" / "local_asr_worker.py"
        result = subprocess.run([sys.executable, "-I", "-X", "utf8", str(worker), "--device", "cpu"],
                                input="", text=True, encoding="utf-8", capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, "")

    def test_non_ascii_result_uses_utf8_in_the_real_transport(self) -> None:
        code = ('import sys,json\n'
                'for line in sys.stdin:\n'
                ' print(json.dumps({"rows":[{"text":"café 中文"}]},ensure_ascii=False),flush=True)\n')
        with patch("local_asr_worker.subprocess.Popen", side_effect=self.factory(code)):
            worker = LocalWhisperProcess("cpu", timeout=3)
            try:
                self.assertEqual(worker.transcribe(Path("fake.wav"))[0]["text"], "café 中文")
            finally:
                worker.close()

    def test_two_requests_reuse_one_child_process(self) -> None:
        code = ('import sys,json\n'
                'for line in sys.stdin:\n'
                ' print(json.dumps({"rows":[{"start":0,"end":1,"text":"Hello"}]}),flush=True)\n')
        with patch("local_asr_worker.subprocess.Popen", side_effect=self.factory(code)) as spawn:
            worker = LocalWhisperProcess("cpu", timeout=3)
            try:
                self.assertEqual(worker.transcribe(Path("fake.wav"))[0]["text"], "Hello")
                self.assertEqual(worker.transcribe(Path("fake2.wav"))[0]["text"], "Hello")
                self.assertEqual(spawn.call_count, 1)
            finally:
                worker.close()
            self.assertIsNotNone(worker.process.poll())

    def test_stalled_child_is_terminated_after_deadline(self) -> None:
        code = 'import sys,time\nfor line in sys.stdin:\n time.sleep(60)\n'
        with patch("local_asr_worker.subprocess.Popen", side_effect=self.factory(code)):
            worker = LocalWhisperProcess("cpu", timeout=0.1)
            started = time.monotonic()
            with self.assertRaises(TimeoutError):
                worker.transcribe(Path("fake.wav"))
            self.assertLess(time.monotonic() - started, 5)
            self.assertIsNotNone(worker.process.poll())
            worker.close()

    def test_close_releases_waiting_recognition_thread(self) -> None:
        code = 'import sys,time\nfor line in sys.stdin:\n time.sleep(60)\n'
        errors = []
        entered = threading.Event()
        with patch("local_asr_worker.subprocess.Popen", side_effect=self.factory(code)):
            worker = LocalWhisperProcess("cpu", timeout=20)
            def recognize() -> None:
                entered.set()
                try:
                    worker.transcribe(Path("fake.wav"))
                except Exception as exc:
                    errors.append(type(exc).__name__)
            thread = threading.Thread(target=recognize)
            thread.start()
            self.assertTrue(entered.wait(2))
            worker.close()
            thread.join(timeout=3)
            self.assertFalse(thread.is_alive())
            self.assertTrue(errors)

    def test_worker_server_loads_once_and_rejects_external_audio_paths(self) -> None:
        import local_asr_worker as worker_module
        from unittest.mock import Mock
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            audio = root / "work" / "a.wav"
            audio.parent.mkdir()
            audio.write_bytes(b"fake")
            loader = Mock(return_value=object())
            source = '\n'.join((json.dumps({"audio": str(audio)}),
                                json.dumps({"audio": str(audio)}),
                                '{"audio":"/outside.wav"}', 'bad json')) + '\n'
            output = StringIO()
            with patch.object(worker_module, "ROOT", root), \
                 patch.object(sys, "stdin", StringIO(source)), \
                 patch("hybrid_runtime.legacy_modules", return_value=(None, SimpleNamespace(load_pipeline=loader))), \
                 patch("hybrid_runtime.transcribe_local", return_value=[{"text": "Hello"}]), \
                 redirect_stdout(output):
                worker_module.serve("cpu")
            responses = [json.loads(line) for line in output.getvalue().splitlines()]
            loader.assert_called_once_with("cpu")
            self.assertEqual(responses[0]["rows"], responses[1]["rows"])
            self.assertEqual(responses[2]["error_type"], "ValueError")
            self.assertEqual(responses[3]["error_type"], "JSONDecodeError")

    def test_rejects_invalid_device_or_timeout(self) -> None:
        for device, timeout in (("invalid", 1), ("cpu", 0), ("cpu", float("inf"))):
            with self.subTest(device=device, timeout=timeout), self.assertRaises(ValueError):
                LocalWhisperProcess(device, timeout=timeout)

    def test_child_error_and_invalid_json_are_sanitized(self) -> None:
        for output in ('{"error_type":"RuntimeError"}', 'invalid response'):
            code = f'import sys\nfor line in sys.stdin:\n print({output!r},flush=True)\n'
            with self.subTest(output=output), patch("local_asr_worker.subprocess.Popen", side_effect=self.factory(code)):
                worker = LocalWhisperProcess("cpu", timeout=3)
                try:
                    with self.assertRaises(RuntimeError):
                        worker.transcribe(Path("fake.wav"))
                finally:
                    worker.close()


if __name__ == "__main__":
    unittest.main()
