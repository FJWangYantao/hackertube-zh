"""Offline integration checks: never load a model or contact a gateway."""
from __future__ import annotations

import importlib.util
import json
import sys
from contextlib import ExitStack
from types import SimpleNamespace
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))
sys.path.insert(0, str(ROOT / "work"))


def load_script(name: str, filename: str) -> object:
    spec = importlib.util.spec_from_file_location(name, ROOT / "work" / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


runner = load_script("recovery_runner", "whisper_wl_runner.py")
batch = load_script("recovery_batch", "run_whisper_batch.py")
prefetch = load_script("prefetch_audio", "prefetch_audio.py")


class RunnerRecoveryTests(unittest.TestCase):
    def test_overlapping_recognition_is_trimmed_without_mutating_input(self) -> None:
        rows = [{"start": 0.0, "end": 10.0, "text": "One.",
                 "words": [{"start": 9.0, "end": 9.8, "word": " One."}]},
                {"start": 9.5, "end": 12.0, "text": "Two.", "words": []}]
        fixed, trimmed = runner.normalize_overlaps(rows)
        self.assertEqual(trimmed, 1)
        self.assertEqual(fixed[0]["end"], 9.5)
        self.assertEqual(fixed[0]["words"][0]["end"], 9.5)
        self.assertEqual(fixed[1]["end"], 12.0)
        self.assertEqual(rows[0]["end"], 10.0)

    def test_segments_that_would_collapse_are_left_for_validation(self) -> None:
        rows = [{"start": 9.49, "end": 10.0, "text": "One."},
                {"start": 9.5, "end": 12.0, "text": "Two."}]
        fixed, trimmed = runner.normalize_overlaps(rows)
        self.assertEqual(trimmed, 0)
        self.assertEqual(fixed, rows)

    def test_cached_transcript_does_not_load_whisper(self) -> None:
        rows = [{"start": 0.0, "end": 5.0, "text": "Hello."}]
        with tempfile.TemporaryDirectory() as folder:
            stage = Path(folder)
            (stage / "transcript.json").write_text(json.dumps(rows), encoding="utf-8")
            with patch.object(runner, "STAGE", stage), patch.object(
                runner, "load_pipeline", side_effect=AssertionError("model loaded")
            ):
                self.assertEqual(runner.full_transcript(10.0, "cuda"), rows)

    def test_invalid_cached_transcript_is_not_silently_reused(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            stage = Path(folder)
            (stage / "transcript.json").write_text("[]", encoding="utf-8")
            with patch.object(runner, "STAGE", stage), patch.object(
                runner, "load_pipeline", side_effect=AssertionError("model loaded")
            ):
                with self.assertRaisesRegex(ValueError, "empty recognition"):
                    runner.full_transcript(10.0, "cuda")

    def test_failed_translation_keeps_reason_and_does_not_write_subtitle(self) -> None:
        rows = [{"start": 0.0, "end": 5.0, "text": "Hello."}]
        with tempfile.TemporaryDirectory() as folder:
            stage = Path(folder)
            with patch.object(runner, "STAGE", stage), patch.object(
                runner, "translate_with_checkpoint", side_effect=ValueError("cue 1: blank")
            ):
                with self.assertRaisesRegex(ValueError, "cue 1: blank"):
                    runner.translate_staged(rows)
            self.assertFalse((stage / "subtitle.json").exists())

    def test_accepted_translation_preserves_source_order_and_stays_in_stage(self) -> None:
        rows = [{"start": float(i * 20), "end": float(i * 20 + 10),
                 "text": f"Sentence {i}."} for i in range(5)]
        cues = [{"s": row["start"], "e": row["end"], "en": row["text"], "zh": "译文。"}
                for row in rows]
        with tempfile.TemporaryDirectory() as folder:
            stage = Path(folder)
            with patch.object(runner, "STAGE", stage), patch.object(
                runner, "translate_with_checkpoint", return_value=cues
            ) as translator:
                runner.translate_staged(rows, workers=3, deepseek_workers=0)
            payload = json.loads((stage / "subtitle.json").read_text(encoding="utf-8"))
            self.assertEqual(payload["cues"], cues)
            self.assertEqual(translator.call_args.kwargs["workers"], 3)
            self.assertEqual(payload["source"], "whisper-local")

    def test_probe_offset_includes_word_timestamps_without_mutation(self) -> None:
        rows = [{"start": 0.5, "end": 1.5, "text": "Hello.", "words": [
            {"start": 0.5, "end": 1.5, "word": "Hello."}]}]
        shifted = runner.offset_rows(rows, 870)
        self.assertEqual(shifted[0]["start"], 870.5)
        self.assertEqual(shifted[0]["words"][0]["end"], 871.5)
        self.assertEqual(rows[0]["words"][0]["end"], 1.5)

    def test_new_recognition_is_saved_atomically_for_reuse(self) -> None:
        rows = [{"start": 0.0, "end": 5.0, "text": "Hello."}]
        with tempfile.TemporaryDirectory() as folder:
            stage = Path(folder)
            with patch.object(runner, "STAGE", stage), patch.object(
                runner, "load_pipeline", return_value=object()
            ) as loader, patch.object(runner, "recognize_batched", return_value=rows):
                self.assertEqual(runner.full_transcript(10.0, "cuda"), rows)
                self.assertEqual(runner.full_transcript(10.0, "cuda"), rows)
            self.assertEqual(loader.call_count, 1)
            self.assertEqual(json.loads((stage / "transcript.json").read_text(encoding="utf-8")), rows)

    def test_translation_cannot_change_source_or_timestamps(self) -> None:
        rows = [{"start": 0.0, "end": 5.0, "text": "Hello."}]
        changed = [{"s": 1.0, "e": 5.0, "en": "Wrong source", "zh": "你好"}]
        with tempfile.TemporaryDirectory() as folder:
            stage = Path(folder)
            with patch.object(runner, "STAGE", stage), patch.object(
                runner, "translate_with_checkpoint", return_value=changed
            ):
                with self.assertRaisesRegex(ValueError, "changed source"):
                    runner.translate_staged(rows)
            self.assertFalse((stage / "subtitle.json").exists())

    def test_probe_path_uses_batched_recognizer_and_offsets_results(self) -> None:
        rows = [{"start": 0.5, "end": 1.5, "text": "Hello."}]
        with tempfile.TemporaryDirectory() as folder:
            stage = Path(folder)
            with patch.object(runner, "STAGE", stage), patch.object(
                runner, "load_pipeline", return_value=object()
            ) as loader, patch.object(runner, "recognize_batched", return_value=rows), patch.object(
                runner.subprocess, "run"
            ):
                runner.stage_probes("fake-ffmpeg", "cuda")
                runner.stage_probes("fake-ffmpeg", "cuda")
            self.assertEqual(loader.call_count, 1)
            probe = json.loads((stage / "probe_1770_1830.json").read_text(encoding="utf-8"))
            self.assertEqual(probe[0]["start"], 1770.5)

    def test_recognition_rejects_malformed_or_nonfinite_timestamps(self) -> None:
        for rows in (None, [], [None], [{"start": float("nan"), "end": 5.0, "text": "Hi"}],
                     [{"start": True, "end": 5.0, "text": "Hi"}],
                     [{"start": 3.0, "end": 2.0, "text": "Hi"}],
                     [{"start": 0.0, "end": 5.0, "text": ""}]):
            with self.subTest(rows=rows), self.assertRaises(ValueError):
                runner.validate(rows, 0, 10)

    def test_execute_routes_cached_source_to_translation_and_records_completion(self) -> None:
        args = SimpleNamespace(full=True, translate=True, device="cuda", translation_workers=3,
                               deepseek_workers=6)
        rows = [{"start": 0.0, "end": 10.0, "text": "Hello."}]
        with tempfile.TemporaryDirectory() as folder:
            stage = Path(folder)
            with patch.object(runner, "STAGE", stage), patch.object(
                runner.tg, "ffmpeg_exe", return_value="fake-ffmpeg"
            ), patch.object(runner.tg, "probe_duration", return_value=100.0), patch.object(
                runner, "full_transcript", return_value=rows
            ), patch.object(runner, "translate_staged") as translator:
                runner.execute(args)
            translator.assert_called_once_with(rows, workers=3, deepseek_workers=6)
            state = json.loads((stage / "runner_state.json").read_text(encoding="utf-8"))
            self.assertEqual(state["status"], "completed")

    def test_execute_routes_probes_and_rejects_invalid_audio(self) -> None:
        args = SimpleNamespace(full=False, translate=False, device="cuda", translation_workers=6)
        with tempfile.TemporaryDirectory() as folder:
            with patch.object(runner, "STAGE", Path(folder)), patch.object(
                runner.tg, "ffmpeg_exe", return_value="fake-ffmpeg"
            ), patch.object(runner.tg, "probe_duration", return_value=100.0) as probe, patch.object(
                runner, "stage_probes"
            ) as stages:
                runner.execute(args)
                stages.assert_called_once_with("fake-ffmpeg", "cuda")
                probe.return_value = 0.0
                with self.assertRaisesRegex(RuntimeError, "duration unavailable"):
                    runner.execute(args)
            with patch.object(runner, "STAGE", Path(folder)), patch.object(
                runner.tg, "ffmpeg_exe", return_value=None
            ):
                with self.assertRaisesRegex(RuntimeError, "ffmpeg unavailable"):
                    runner.execute(args)

    def test_pipeline_initialization_uses_selected_device_with_fake_backend(self) -> None:
        fake = SimpleNamespace(WhisperModel=unittest.mock.Mock(return_value="fake-model"),
                               BatchedInferencePipeline=unittest.mock.Mock(return_value="fake-pipeline"))
        with patch.dict(sys.modules, {"faster_whisper": fake}), patch.object(
            runner, "enable_gpu_runtime"
        ) as runtime, patch.dict("os.environ", {}, clear=False):
            self.assertEqual(runner.load_pipeline("cuda"), "fake-pipeline")
            runtime.assert_called_once()
            self.assertEqual(fake.WhisperModel.call_args.kwargs["compute_type"], "int8_float16")
            self.assertEqual(runner.load_pipeline("cpu"), "fake-pipeline")
            self.assertEqual(fake.WhisperModel.call_args.kwargs["compute_type"], "int8")
            fake.BatchedInferencePipeline.assert_called_with(model="fake-model")

    def test_configure_paths_rejects_invalid_id_and_outside_audio(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            audio = root / "work" / "audio.webm"
            audio.parent.mkdir()
            audio.write_bytes(b"fake")
            with patch.object(runner, "ROOT", root), patch.object(runner, "VID"), patch.object(
                runner, "AUDIO"
            ), patch.object(runner, "STAGE"):
                runner.configure_paths(SimpleNamespace(vid="abcdefghijk", audio=str(audio)))
                self.assertEqual(runner.AUDIO, audio)
                with self.assertRaisesRegex(ValueError, "invalid video id"):
                    runner.configure_paths(SimpleNamespace(vid="../bad", audio=str(audio)))
                outside = root / "outside.webm"
                outside.write_bytes(b"fake")
                with self.assertRaisesRegex(ValueError, "inside work"):
                    runner.configure_paths(SimpleNamespace(vid="abcdefghijk", audio=str(outside)))

    def test_same_video_cannot_have_two_stage_writers(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            stage = Path(folder)
            with patch.object(runner, "STAGE", stage):
                with runner.stage_lock():
                    with self.assertRaisesRegex(RuntimeError, "already active"):
                        with runner.stage_lock():
                            self.fail("second stage writer was admitted")
                    self.assertTrue((stage / "runner.lock").exists())
                self.assertFalse((stage / "runner.lock").exists())
                with self.assertRaisesRegex(ValueError, "injected failure"):
                    with runner.stage_lock():
                        raise ValueError("injected failure")
                self.assertFalse((stage / "runner.lock").exists())

    def test_main_records_failed_translation_phase(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            stage = Path(folder)

            def fail_translation(args: object) -> None:
                runner.set_progress("translation")
                raise ValueError("cue 7: blank")

            with patch.object(runner, "STAGE", stage), patch.object(
                runner, "parse_args", return_value=object()
            ), patch.object(runner, "configure_paths"), patch.object(
                runner, "execute", side_effect=fail_translation
            ), patch.object(runner.LOGGER, "exception"):
                with self.assertRaises(SystemExit) as error:
                    runner.main()
            self.assertEqual(error.exception.code, 1)
            state = json.loads((stage / "runner_state.json").read_text(encoding="utf-8"))
            self.assertEqual(state["phase"], "translation")
            self.assertEqual(state["status"], "failed")
            self.assertIn("cue 7: blank", state["reason"])


class BatchRecoveryTests(unittest.TestCase):
    def test_publish_rejects_the_same_long_text_as_staging(self) -> None:
        cues = [{"s": float(i * 20), "e": float(i * 20 + 10),
                 "en": "This is the source sentence.", "zh": "中" * 201}
                for i in range(5)]
        payload = {"vid": "abcdefghijk", "source": "whisper-local", "cues": cues}
        with self.assertRaisesRegex(ValueError, "cue 1.*exceeds 200 characters"):
            batch.verify(payload, 100.0, "abcdefghijk")

    def test_runner_failure_reports_logged_cause(self) -> None:
        with tempfile.TemporaryDirectory(dir=ROOT / "work") as folder:
            stage_root = Path(folder)
            stage = stage_root / "abcdefghijk"
            stage.mkdir()

            def fake_run(command: list[str], **kwargs: object) -> object:
                kwargs["stdout"].write("ValueError: cue 7: blank\n")
                return type("Result", (), {"returncode": 1})()

            with patch.object(batch, "STAGE", stage_root), patch.object(
                batch.subprocess, "run", side_effect=fake_run
            ):
                with self.assertRaisesRegex(RuntimeError, "cue 7: blank"):
                    batch.run_runner("abcdefghijk", stage / "audio.webm", "cuda", 6)
            logs = list(stage.glob("runner_*.log"))
            self.assertEqual(len(logs), 1)

    def test_stale_runner_error_is_not_reused(self) -> None:
        with tempfile.TemporaryDirectory(dir=ROOT / "work") as folder:
            stage_root = Path(folder)
            stage = stage_root / "abcdefghijk"
            stage.mkdir()
            (stage / "runner_state.json").write_text(json.dumps({
                "status": "failed", "phase": "translation", "reason": "stale error"
            }), encoding="utf-8")

            def fake_run(command: list[str], **kwargs: object) -> object:
                kwargs["stdout"].write("fresh process startup failure\n")
                return type("Result", (), {"returncode": 1})()

            with patch.object(batch, "STAGE", stage_root), patch.object(
                batch.subprocess, "run", side_effect=fake_run
            ):
                with self.assertRaisesRegex(RuntimeError, "fresh process startup failure") as error:
                    batch.run_runner("abcdefghijk", stage / "audio.webm", "cuda", 6)
            self.assertNotIn("stale error", str(error.exception))

    def test_current_runner_failure_includes_stage_and_exit_code(self) -> None:
        with tempfile.TemporaryDirectory(dir=ROOT / "work") as folder:
            stage_root = Path(folder)
            stage = stage_root / "abcdefghijk"
            stage.mkdir()

            def fake_run(command: list[str], **kwargs: object) -> object:
                (stage / "runner_state.json").write_text(json.dumps({
                    "status": "failed", "phase": "translation", "reason": "cue 9: too_long",
                    "run_id": command[command.index("--run-id") + 1]
                }), encoding="utf-8")
                return type("Result", (), {"returncode": 1})()

            with patch.object(batch, "STAGE", stage_root), patch.object(
                batch.subprocess, "run", side_effect=fake_run
            ):
                with self.assertRaises(batch.RunnerFailure) as error:
                    batch.run_runner("abcdefghijk", stage / "audio.webm", "cuda", 6)
            self.assertEqual(error.exception.phase, "translation")
            self.assertEqual(error.exception.exit_code, 1)
            self.assertIn("cue 9: too_long", str(error.exception))

    def test_successful_runner_passes_configured_concurrency(self) -> None:
        with tempfile.TemporaryDirectory(dir=ROOT / "work") as folder:
            stage_root = Path(folder)
            stage = stage_root / "abcdefghijk"
            stage.mkdir()
            with patch.object(batch, "STAGE", stage_root), patch.object(
                batch.subprocess, "run", return_value=type("Result", (), {"returncode": 0})()
            ) as process:
                log = batch.run_runner("abcdefghijk", stage / "audio.webm", "cuda", 3)
            self.assertTrue(log.exists())
            command = process.call_args.args[0]
            self.assertEqual(command[command.index("--antigravity-workers") + 1], "3")
            self.assertEqual(command[command.index("--deepseek-workers") + 1], "6")
            self.assertIn("-I", command)

    def test_leading_hyphen_video_id_reaches_real_argument_parser(self) -> None:
        vid = "-k3mVnRlQLU"
        with tempfile.TemporaryDirectory(dir=ROOT / "work") as folder:
            stage_root = Path(folder)
            (stage_root / vid).mkdir()
            with patch.object(batch, "STAGE", stage_root), patch.object(
                batch.subprocess, "run", return_value=SimpleNamespace(returncode=0)
            ) as process:
                batch.run_runner(vid, stage_root / vid / "audio.webm", "cuda", 6)
            command = process.call_args.args[0]
            with patch.object(sys, "argv", ["runner", *command[4:]]):
                args = runner.parse_args()
            self.assertEqual(args.vid, vid)

    def test_existing_subtitle_is_not_overwritten(self) -> None:
        vid = "abcdefghijk"
        rows = [{"start": float(i * 20), "end": float(i * 20 + 10),
                 "text": "This is the original source sentence."} for i in range(5)]
        cues = [{"s": row["start"], "e": row["end"], "en": row["text"], "zh": "译文。"}
                for row in rows]
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            stage = root / "stage" / vid
            dest = root / "site" / "data" / "subs" / f"{vid}.json"
            stage.mkdir(parents=True)
            dest.parent.mkdir(parents=True)
            dest.write_text("existing subtitle", encoding="utf-8")
            (stage / "subtitle.json").write_text(json.dumps(
                {"vid": vid, "source": "whisper-local", "cues": cues}), encoding="utf-8")
            (stage / "transcript.json").write_text(json.dumps(rows), encoding="utf-8")
            with patch.object(batch, "ROOT", root), patch.object(batch, "STAGE", stage.parent), patch.object(
                batch.tg, "check_language"
            ):
                self.assertFalse(batch.publish(vid, 100.0))
            self.assertEqual(dest.read_text(encoding="utf-8"), "existing subtitle")

    def test_optional_cache_created_by_another_writer_is_preserved(self) -> None:
        vid = "abcdefghijk"
        rows = [{"start": float(i * 20), "end": float(i * 20 + 10),
                 "text": "This is the original source sentence."} for i in range(5)]
        cues = [{"s": r["start"], "e": r["end"], "en": r["text"], "zh": "译文。"} for r in rows]
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            stage = root / "stage" / vid
            stage.mkdir(parents=True)
            (root / "site" / "data" / "subs").mkdir(parents=True)
            audio_dir = root / "audio"
            audio_dir.mkdir()
            cache = audio_dir / f"{vid}.whisper.json"
            (stage / "subtitle.json").write_text(json.dumps(
                {"vid": vid, "source": "whisper-local", "cues": cues}), encoding="utf-8")
            (stage / "transcript.json").write_text(json.dumps(rows), encoding="utf-8")
            original_open = Path.open

            def racing_open(path: Path, mode: str = "r", *args: object, **kwargs: object) -> object:
                if path == cache and mode == "x":
                    with original_open(cache, "w", encoding="utf-8") as out:
                        out.write("other writer's cache")
                return original_open(path, mode, *args, **kwargs)

            with patch.object(batch, "ROOT", root), patch.object(batch, "STAGE", stage.parent), patch.object(
                batch.tg, "AUDIO_DIR", audio_dir
            ), patch.object(batch.tg, "check_language"), patch.object(Path, "open", racing_open):
                self.assertTrue(batch.publish(vid, 100.0))
            self.assertEqual(cache.read_text(encoding="utf-8"), "other writer's cache")


class BatchOrchestrationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.stage = self.root / "work" / "whisper_batch"
        (self.root / "work").mkdir()
        (self.root / "site" / "data" / "subs").mkdir(parents=True)
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.stack.enter_context(patch.object(batch, "ROOT", self.root))
        self.stack.enter_context(patch.object(batch, "STAGE", self.stage))
        self.stack.enter_context(patch.object(batch, "STATUS", self.stage / "status.json"))
        self.stack.enter_context(patch.object(batch.tg, "AUDIO_DIR", self.root / "work" / "audio"))
        self.stack.enter_context(patch.object(sys, "argv", ["batch", "--device", "cuda"]))
        self.stack.enter_context(patch("builtins.print"))
        self.stack.enter_context(patch("socket.create_connection", side_effect=AssertionError("network prohibited")))
        self.disk = self.stack.enter_context(patch.object(
            batch.shutil, "disk_usage", return_value=SimpleNamespace(free=10 * 1024**3)))
        self.audio = self.stack.enter_context(patch.object(
            batch, "get_audio", return_value=(self.stage / "audio.webm", 100.0)))
        self.process = self.stack.enter_context(patch.object(
            batch, "run_runner", return_value=self.stage / "fake.log"))
        self.publish = self.stack.enter_context(patch.object(batch, "publish", return_value=True))
        self.ids = ["abcdefghijk", "bcdefghijkl", "cdefghijklm", "defghijklmn"]

    def run_batch(self, ids: list[str] | None = None) -> dict:
        (self.root / "work" / "batch200.txt").write_text(
            "\n".join(self.ids if ids is None else ids), encoding="utf-8")
        batch.main()
        path = self.stage / "status.json"
        return json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}

    def test_successful_batch_records_completion_and_skips_existing(self) -> None:
        existing = self.root / "site" / "data" / "subs" / f"{self.ids[0]}.json"
        existing.write_text("already present", encoding="utf-8")
        state = self.run_batch(self.ids[:2])
        self.assertEqual(state[self.ids[1]]["status"], "completed")
        self.assertEqual(state[self.ids[1]]["duration"], 100.0)
        self.audio.assert_called_once_with(self.ids[1])
        self.assertEqual(self.process.call_args.args[-2:], (10, 6))

    def test_failed_runner_preserves_phase_duration_and_log(self) -> None:
        self.process.side_effect = batch.RunnerFailure(
            "translation", "cue 7: blank", self.stage / "failed.log", 1)
        state = self.run_batch(self.ids[:1])[self.ids[0]]
        self.assertEqual(state["phase"], "translation")
        self.assertEqual(state["duration"], 100.0)
        self.assertEqual(state["exit_code"], 1)
        self.assertIn("failed.log", state["log_path"])
        self.publish.assert_not_called()

    def test_three_download_blocks_pause_without_starting_runner(self) -> None:
        self.audio.side_effect = RuntimeError("bot_check")
        state = self.run_batch()
        self.assertEqual(self.audio.call_count, 3)
        self.assertEqual(len(state), 3)
        self.assertTrue(all(item["phase"] == "download" for item in state.values()))
        self.process.assert_not_called()

    def test_login_and_silent_videos_are_not_requested(self) -> None:
        ids = ["LQRAfJyEsko", "sWblpsLZ-O8"]
        state = self.run_batch(ids)
        self.assertEqual(state[ids[0]]["status"], "login_required")
        self.assertEqual(state[ids[1]]["status"], "no_speech")
        self.audio.assert_not_called()

    def test_low_disk_space_stops_before_download(self) -> None:
        self.disk.return_value = SimpleNamespace(free=1)
        self.assertEqual(self.run_batch(), {})
        self.audio.assert_not_called()

    def test_publication_limit_stops_after_that_many_successes(self) -> None:
        with patch.object(sys, "argv", ["batch", "--device", "cuda", "--limit", "2"]):
            state = self.run_batch()
        self.assertEqual(len(state), 2)
        self.assertEqual(self.publish.call_count, 2)

    def test_already_existing_publication_does_not_consume_the_limit(self) -> None:
        self.publish.side_effect = [False, True, True]
        with patch.object(sys, "argv", ["batch", "--device", "cuda", "--limit", "1"]):
            state = self.run_batch()
        self.assertEqual(set(state), {self.ids[0], self.ids[1]})

    def test_resume_starts_at_requested_pending_video(self) -> None:
        with patch.object(sys, "argv", ["batch", "--start-vid", self.ids[2]]):
            state = self.run_batch()
        self.assertEqual(set(state), set(self.ids[2:]))

    def test_ids_file_replaces_the_default_batch_list(self) -> None:
        custom = self.root / "work" / "custom.txt"
        custom.write_text("\n".join(self.ids[2:]), encoding="utf-8")
        (self.root / "work" / "batch200.txt").write_text(
            "\n".join(self.ids[:2]), encoding="utf-8")
        with patch.object(sys, "argv", ["batch", "--device", "cuda",
                                        "--ids-file", str(custom)]):
            batch.main()
        state = json.loads((self.stage / "status.json").read_text(encoding="utf-8"))
        self.assertEqual(set(state), set(self.ids[2:]))


class EnglishAudioTests(unittest.TestCase):
    def test_untagged_single_track_is_accepted(self) -> None:
        info = {"formats": [{"acodec": "mp4a.40.2", "vcodec": "none"}],
                "requested_downloads": [{"acodec": "mp4a.40.2"}]}
        self.assertTrue(batch.tg.english_audio_ok(info))

    def test_only_dubbed_audio_is_rejected(self) -> None:
        info = {"formats": [{"acodec": "mp4a.40.2", "language": "es"}],
                "requested_downloads": [{"language": "es"}]}
        self.assertFalse(batch.tg.english_audio_ok(info))

    def test_english_track_alongside_dubs_is_accepted(self) -> None:
        info = {"formats": [{"acodec": "mp4a.40.2", "language": "en"},
                            {"acodec": "mp4a.40.2", "language": "es"}],
                "requested_downloads": [{"language": "en"}]}
        self.assertTrue(batch.tg.english_audio_ok(info))

    def test_selected_dub_is_rejected_even_when_english_exists(self) -> None:
        info = {"formats": [{"acodec": "mp4a.40.2", "language": "en"},
                            {"acodec": "mp4a.40.2", "language": "es"}],
                "requested_downloads": [{"language": "es"}]}
        self.assertFalse(batch.tg.english_audio_ok(info))


class PrefetchQueueTests(unittest.TestCase):
    def test_pending_excludes_published_and_deliberately_skipped(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            subs = Path(folder)
            (subs / "abcdefghijk.json").write_text("{}", encoding="utf-8")
            with patch.object(prefetch, "SUBS_DIR", subs):
                pending = prefetch.pending_ids([
                    "abcdefghijk", "bcdefghijkl", "LQRAfJyEsko", "sWblpsLZ-O8",
                    "bcdefghijkl",
                ])
        self.assertEqual(pending, ["bcdefghijkl"])

    def test_prefetch_downloads_only_missing_audio(self) -> None:
        with tempfile.TemporaryDirectory() as folder, patch.object(
            prefetch, "SUBS_DIR", Path(folder)
        ), patch.object(
            prefetch, "is_audio_ready", side_effect=lambda vid: vid == "bcdefghijkl"
        ), patch.object(prefetch, "download_audio", return_value=True) as download, patch(
            "builtins.print"
        ):
            outcomes = prefetch.prefetch(["abcdefghijk", "bcdefghijkl"], workers=2)
        self.assertEqual(outcomes, {"abcdefghijk": "downloaded", "bcdefghijkl": "ready"})
        download.assert_called_once_with("abcdefghijk")

    def test_failed_download_is_recorded_once(self) -> None:
        with tempfile.TemporaryDirectory() as folder, patch.object(
            prefetch, "SUBS_DIR", Path(folder)
        ), patch.object(prefetch, "is_audio_ready", return_value=False), patch.object(
            prefetch, "download_audio", return_value=False
        ) as download, patch("builtins.print"):
            outcomes = prefetch.prefetch(["abcdefghijk"], workers=1)
        self.assertEqual(outcomes, {"abcdefghijk": "failed"})
        self.assertEqual(download.call_count, 1)

    def test_low_disk_skips_downloads(self) -> None:
        with tempfile.TemporaryDirectory() as folder, patch.object(
            prefetch, "SUBS_DIR", Path(folder)
        ), patch.object(prefetch.shutil, "disk_usage", return_value=SimpleNamespace(free=1)), patch.object(
            prefetch, "download_audio"
        ) as download, patch("builtins.print"):
            outcomes = prefetch.prefetch(["abcdefghijk"], workers=1)
        self.assertEqual(outcomes, {"abcdefghijk": "skipped_disk"})
        download.assert_not_called()

    def test_invalid_worker_count_is_rejected(self) -> None:
        for value in (0, -1, True, 1.5):
            with self.subTest(value=value), self.assertRaises(ValueError):
                prefetch.prefetch([], workers=value)


if __name__ == "__main__":
    unittest.main()
