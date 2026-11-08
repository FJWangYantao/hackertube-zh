"""Fake-only end-to-end staging and CLI checks for hybrid ASR."""
from __future__ import annotations

import copy
import json
import os
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from io import StringIO
from pathlib import Path
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))

from hybrid_pipeline import HybridJob, Recognition
from hybrid_runtime import HybridRuntime, batch_lock, vtt_rows
import run_hybrid_batch as cli

VID = "abcdefghijk"


class VttRowsTests(unittest.TestCase):
    def test_vtt_rows_parse_and_collapse_rolling_repeats(self) -> None:
        vtt = """WEBVTT

00:00:01.000 --> 00:00:03.000 align:start position:0%
 hi<00:00:01.500><c> there</c>

00:00:03.000 --> 00:00:05.000 align:start position:0%
 hi there everybody

00:00:05.000 --> 00:00:07.000 align:start position:0%
 welcome to the show

00:00:07.000 --> 00:00:09.000 align:start position:0%
 welcome to the show
"""
        rows = vtt_rows(vtt)
        self.assertEqual([(r["start"], r["end"]) for r in rows],
                         [(1.0, 5.0), (5.0, 9.0)])
        self.assertEqual([r["text"] for r in rows],
                         ["hi there everybody", "welcome to the show"])

    def test_vtt_rows_skip_blank_cues(self) -> None:
        vtt = """WEBVTT

00:00:00.000 --> 00:00:02.000
[Music]

00:00:02.000 --> 00:00:04.000

00:00:04.000 --> 00:00:06.000
real content starts here
"""
        rows = vtt_rows(vtt)
        self.assertEqual([(r["start"], r["end"], r["text"]) for r in rows],
                         [(0.0, 2.0, "[Music]"), (4.0, 6.0, "real content starts here")])


def sample_rows() -> list[dict]:
    return [{"start": float(i * 20), "end": float(i * 20 + 12),
             "text": f"This is the example for you and the people {i}.", "words": []}
            for i in range(6)]


class RuntimeTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.audio = self.root / "work" / "audio" / "sample.webm"
        self.audio.parent.mkdir(parents=True)
        self.audio.write_bytes(b"fake audio")
        self.job = HybridJob(VID, self.root / "work" / "hybrid_batch" / VID)
        self.client = Mock()
        self.client.transcribe.return_value = sample_rows()
        self.loader = Mock(return_value=object())
        self.transcribe = Mock(return_value=sample_rows())
        self.audio_loader = Mock(return_value=(self.audio, 120.0))
        self.net = patch("socket.create_connection", side_effect=AssertionError("network forbidden"))
        self.net.start()
        self.addCleanup(self.net.stop)

    def runtime(self, **kwargs: object) -> HybridRuntime:
        return HybridRuntime(self.root, deepgram=self.client, audio_loader=self.audio_loader,
            local_loader=self.loader, local_transcribe=self.transcribe, **kwargs)

    def cues(self, result: Recognition) -> list[dict]:
        return [{"s": r["start"], "e": r["end"], "en": r["text"], "zh": "这是测试译文。"}
                for r in result.rows]

    def test_cloud_result_is_cached_and_resume_never_reuploads(self) -> None:
        runtime = self.runtime()
        result = runtime.recognize_deepgram(self.job)
        self.assertEqual(result.source, "deepgram")
        self.assertEqual(result.model, "nova-3")
        self.client.transcribe.assert_called_once_with(self.audio, 120.0)
        self.client.transcribe.side_effect = AssertionError("reupload")
        self.audio_loader.side_effect = AssertionError("download")
        self.assertEqual(runtime.recognize_local(self.job), result)
        self.loader.assert_not_called()
        cache = json.loads((self.job.stage / "recognition.json").read_text(encoding="utf-8"))
        self.assertEqual(cache["vid"], VID)
        self.assertEqual(cache["source"], "deepgram")
        self.assertNotIn("Authorization", json.dumps(cache))

    def test_real_overlap_normalizer_drops_only_collapsed_word_times(self) -> None:
        import hybrid_runtime
        _, runner = hybrid_runtime.legacy_modules()
        original = [
            {"start": 0.0, "end": 2.0, "text": "This is the source.",
             "words": [{"start": 1.6, "end": 2.0, "word": "source"}]},
            {"start": 1.5, "end": 3.0, "text": "And this is next.", "words": []},
        ]
        before = copy.deepcopy(original)
        with patch.object(runner, "recognize_batched", return_value=original):
            rows = hybrid_runtime.transcribe_local(object(), self.audio)
        self.assertEqual(rows[0]["words"], [])
        hybrid_runtime.validate_recognition(Recognition(VID, "whisper-local",
            "faster-whisper-small.en", 120.0, rows))
        self.assertEqual(original, before)

    def test_local_model_is_loaded_once_across_videos(self) -> None:
        runtime = self.runtime()
        runtime.recognize_local(self.job)
        other = HybridJob("zyxwvutsrqp", self.root / "work" / "hybrid_batch" / "zyxwvutsrqp")
        result = runtime.recognize_local(other)
        self.assertEqual(result.source, "whisper-local")
        self.loader.assert_called_once_with("cuda")
        self.assertEqual(self.transcribe.call_count, 2)

    def test_corrupt_or_changed_audio_cache_is_not_silently_replaced(self) -> None:
        runtime = self.runtime()
        runtime.recognize_local(self.job)
        self.audio.write_bytes(b"changed audio")
        with self.assertRaises(ValueError):
            runtime.recognize_deepgram(self.job)
        self.client.transcribe.assert_not_called()

    def test_unknown_cache_source_is_rejected_before_network(self) -> None:
        runtime = self.runtime()
        runtime.recognize_local(self.job)
        path = self.job.stage / "recognition.json"
        payload = json.loads(path.read_text(encoding="utf-8"))
        path.write_text(json.dumps({**payload, "source": "invented"}), encoding="utf-8")
        with self.assertRaises(ValueError):
            runtime.recognize_deepgram(self.job)
        self.client.transcribe.assert_not_called()

    def test_ambiguous_cloud_request_requires_explicit_retry(self) -> None:
        from deepgram_asr import DeepgramError
        self.client.transcribe.side_effect = DeepgramError("timeout", uncertain=True)
        runtime = self.runtime()
        with self.assertRaises(DeepgramError):
            runtime.recognize_deepgram(self.job)
        state = json.loads((self.job.stage / "cloud_request.json").read_text())
        self.assertEqual(state["status"], "uncertain")
        self.client.transcribe.side_effect = None
        with self.assertRaisesRegex(RuntimeError, "uncertain"):
            runtime.recognize_deepgram(self.job)
        self.assertEqual(self.client.transcribe.call_count, 1)
        retried = self.runtime(retry_uncertain=True).recognize_deepgram(self.job)
        self.assertEqual(retried.source, "deepgram")
        self.assertEqual(self.client.transcribe.call_count, 2)

    def test_billed_but_rejected_response_does_not_reupload_on_plain_resume(self) -> None:
        from deepgram_asr import DeepgramError
        self.client.transcribe.side_effect = DeepgramError("invalid response data", uncertain=False)
        runtime = self.runtime()
        with self.assertRaises(DeepgramError):
            runtime.recognize_deepgram(self.job)
        marker = json.loads((self.job.stage / "cloud_request.json").read_text())
        self.assertEqual(marker["status"], "uncertain")
        with self.assertRaises(RuntimeError):
            runtime.recognize_deepgram(self.job)
        self.assertEqual(self.client.transcribe.call_count, 1)

    def test_submitted_marker_survives_process_crash_and_blocks_reupload(self) -> None:
        self.job.stage.mkdir(parents=True)
        (self.job.stage / "cloud_request.json").write_text('{"status":"submitted"}')
        with self.assertRaisesRegex(RuntimeError, "uncertain"):
            self.runtime().recognize_deepgram(self.job)
        self.client.transcribe.assert_not_called()

    def test_invalid_audio_and_invalid_transcript_are_rejected(self) -> None:
        self.audio_loader.return_value = (self.audio, float("nan"))
        with self.assertRaises(ValueError):
            self.runtime().recognize_local(self.job)
        self.audio_loader.return_value = (self.audio, 120.0)
        self.transcribe.return_value = [{"start": 10, "end": 1, "text": "bad"}]
        with self.assertRaises(ValueError):
            self.runtime().recognize_local(self.job)
        self.assertFalse((self.job.stage / "recognition.json").exists())

    def test_audio_path_must_stay_inside_work(self) -> None:
        outside = self.root / "outside.webm"
        outside.write_bytes(b"audio")
        self.audio_loader.return_value = (outside, 120.0)
        with self.assertRaises(ValueError):
            self.runtime().recognize_deepgram(self.job)
        self.client.transcribe.assert_not_called()

    def test_staging_preserves_source_and_does_not_publish_by_default(self) -> None:
        runtime = self.runtime()
        result = runtime.recognize_deepgram(self.job)
        runtime.finish(self.job, result, self.cues(result))
        staged = json.loads((self.job.stage / "subtitle.json").read_text(encoding="utf-8"))
        self.assertEqual(staged["source"], "deepgram")
        self.assertFalse((self.root / "site" / "data" / "subs" / f"{VID}.json").exists())
        self.assertFalse((self.audio.parent / f"{VID}.whisper.json").exists())

    def test_publication_does_not_overwrite_existing_subtitles(self) -> None:
        runtime = self.runtime(publish=True)
        result = runtime.recognize_deepgram(self.job)
        runtime.finish(self.job, result, self.cues(result))
        dest = self.root / "site" / "data" / "subs" / f"{VID}.json"
        before = dest.read_bytes()
        runtime.finish(self.job, result, self.cues(result))
        self.assertEqual(dest.read_bytes(), before)
        self.assertEqual(json.loads(before)["source"], "deepgram")

    def test_invalid_translation_or_changed_timing_never_publishes(self) -> None:
        runtime = self.runtime(publish=True)
        result = runtime.recognize_local(self.job)
        for field, value in (("zh", "@@@"), ("s", 5.0), ("en", "changed")):
            cues = self.cues(result)
            cues[0] = {**cues[0], field: value}
            with self.subTest(field=field), self.assertRaises(ValueError):
                runtime.finish(self.job, result, cues)
        self.assertFalse((self.job.stage / "subtitle.json").exists())

    def test_lock_rejects_second_owner_and_is_released(self) -> None:
        path = self.root / "batch.lock"
        with batch_lock(path):
            with self.assertRaises(FileExistsError):
                with batch_lock(path):
                    self.fail("second owner")
        self.assertFalse(path.exists())


class CliTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.ids = self.root / "ids.txt"
        self.ids.write_text(f"{VID}\nzyxwvutsrqp\n{VID}\n", encoding="utf-8")

    def test_default_plan_is_read_only_and_needs_no_key(self) -> None:
        out = StringIO()
        with patch.object(cli, "ROOT", self.root), patch.dict(os.environ, {}, clear=True), \
             patch.object(cli, "execute", side_effect=AssertionError("must not run")), redirect_stdout(out):
            self.assertEqual(cli.main(["--ids-file", str(self.ids), "--limit", "1"]), 0)
        self.assertIn("1", out.getvalue())
        self.assertFalse((self.root / "work").exists())

    def test_default_configuration_and_invalid_limits(self) -> None:
        args = cli.parse_args(["--ids-file", str(self.ids)])
        self.assertEqual((args.local_workers, args.deepgram_workers,
                          args.cc_workers, args.cn_workers, args.global_workers),
                         (1, 1, 130, 10, 10))
        for extra in (["--limit", "0"], ["--local-workers", "2"],
                      ["--deepgram-workers", "7"], ["--queue-low", "32"],
                      ["--publish"], ["--local-workers", "0", "--deepgram-workers", "0"],
                      ["--cc-workers", "131"], ["--cn-workers", "11"],
                      ["--global-workers", "11"]):
            with self.subTest(extra=extra), redirect_stderr(StringIO()), self.assertRaises(SystemExit):
                cli.parse_args(["--ids-file", str(self.ids)] + extra)

    def test_plan_deduplicates_and_skips_existing_publications(self) -> None:
        folder = self.root / "site" / "data" / "subs"
        folder.mkdir(parents=True)
        (folder / f"{VID}.json").write_text("{}")
        args = cli.parse_args(["--ids-file", str(self.ids)])
        jobs = cli.make_plan(args, self.root)
        self.assertEqual([job.vid for job in jobs], ["zyxwvutsrqp"])

    def test_run_without_key_fails_before_creating_state(self) -> None:
        with patch.object(cli, "ROOT", self.root), patch.dict(os.environ, {}, clear=True):
            with self.assertRaisesRegex(ValueError, "DEEPGRAM_API_KEY"):
                cli.main(["--ids-file", str(self.ids), "--run"])
        self.assertFalse((self.root / "work").exists())

    def test_fake_end_to_end_cli_publishes_both_sources(self) -> None:
        audio = self.root / "work" / "audio" / "sample.webm"
        audio.parent.mkdir(parents=True)
        audio.write_bytes(b"fake")
        client = Mock()
        client.transcribe.return_value = sample_rows()
        with patch.object(cli, "ROOT", self.root), \
             patch.dict(os.environ, {"DEEPGRAM_API_KEY": "fake-key"}), \
             patch.object(cli, "DeepgramClient", return_value=client), \
             patch("hybrid_runtime.load_audio", return_value=(audio, 120.0)), \
             patch("hybrid_runtime.load_local", return_value=object()) as loader, \
             patch("hybrid_runtime.transcribe_local", return_value=sample_rows()), \
             patch.object(cli.make_subs, "call_gateway", side_effect=lambda texts, **kw: ["这是译文。"] * len(texts)), \
             patch("socket.create_connection", side_effect=AssertionError("network forbidden")), \
             redirect_stdout(StringIO()):
            code = cli.main(["--ids-file", str(self.ids), "--run", "--publish"])
        self.assertEqual(code, 0)
        loader.assert_called_once()
        client.transcribe.assert_called_once()
        files = list((self.root / "site" / "data" / "subs").glob("*.json"))
        self.assertEqual(len(files), 2)
        self.assertEqual({json.loads(p.read_text(encoding="utf-8"))["source"] for p in files},
                         {"whisper-local", "deepgram"})
        stage = self.root / "work" / "hybrid_batch"
        self.assertFalse((stage / "batch.lock").exists())
        state = json.loads((stage / "status.json").read_text(encoding="utf-8"))
        self.assertTrue(all(v["status"] == "completed" for v in state["videos"].values()))

    def test_cloud_disabled_run_does_not_require_key(self) -> None:
        args = cli.parse_args(["--ids-file", str(self.ids), "--deepgram-workers", "0", "--run"])
        with patch.dict(os.environ, {}, clear=True), \
             patch.object(cli, "DeepgramClient", side_effect=AssertionError("cloud disabled")), \
             patch.object(cli.HybridPipeline, "run", return_value={}), redirect_stdout(StringIO()):
            self.assertEqual(cli.execute(args, [], self.root), 0)

    def test_plan_rejects_corrupt_history_and_bad_resume(self) -> None:
        args = cli.parse_args(["--ids-file", str(self.ids), "--start-vid", "notpending1"])
        with self.assertRaises(ValueError):
            cli.make_plan(args, self.root)
        status = self.root / "work" / "whisper_batch" / "status.json"
        status.parent.mkdir(parents=True)
        status.write_text("[]")
        with self.assertRaises(ValueError):
            cli.make_plan(cli.parse_args(["--ids-file", str(self.ids)]), self.root)

    def test_low_disk_stops_before_any_work(self) -> None:
        args = cli.parse_args(["--ids-file", str(self.ids), "--deepgram-workers", "0", "--run"])
        with patch.object(cli.shutil, "disk_usage", return_value=Mock(free=0)):
            with self.assertRaisesRegex(ValueError, "3 GB"):
                cli.execute(args, [], self.root)
        self.assertFalse((self.root / "work").exists())

    def test_bad_video_id_fails_before_any_work(self) -> None:
        self.ids.write_text("../../outside", encoding="utf-8")
        with patch.object(cli, "ROOT", self.root), self.assertRaises(ValueError):
            cli.main(["--ids-file", str(self.ids)])


if __name__ == "__main__":
    unittest.main()
