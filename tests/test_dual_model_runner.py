"""Dual-backend wiring tests; no live gateway or batch operations."""
from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))
sys.path.insert(0, str(ROOT / "work"))
import run_whisper_batch as batch
import whisper_wl_runner as runner

ANTIGRAVITY = "antigravity-tools/gemini-3.8-flash-low"
DEEPSEEK_CN = "workbuddy-vps/cn:deepseek-v4.1-flash"


def source_rows() -> list[dict]:
    return [{"start": float(i * 20), "end": float(i * 20 + 10),
             "text": f"This is source sentence {i}."} for i in range(5)]


def translated_cues() -> list[dict]:
    return [{"s": row["start"], "e": row["end"], "en": row["text"], "zh": "译文。"}
            for row in source_rows()]


class DualModelRunnerTests(unittest.TestCase):
    def setUp(self) -> None:
        network = patch("socket.create_connection", side_effect=AssertionError("network prohibited"))
        network.start()
        self.addCleanup(network.stop)

    def test_default_runner_arguments_are_ten_plus_six(self) -> None:
        with patch.object(sys, "argv", ["runner"]):
            args = runner.parse_args()
        self.assertEqual(args.translation_workers, 10)
        self.assertEqual(args.deepseek_workers, 6)

    def test_legacy_antigravity_flag_and_new_spelling_are_aliases(self) -> None:
        for flag in ("--antigravity-workers", "--translation-workers"):
            with patch.object(sys, "argv", ["runner", flag, "4", "--deepseek-workers", "0"]):
                args = runner.parse_args()
            self.assertEqual(args.translation_workers, 4)
            self.assertEqual(args.deepseek_workers, 0)

    def test_backend_callbacks_bind_models_without_global_switch(self) -> None:
        default = runner.ms.MODEL
        seen = []

        def fake_translate(sentences: list[str], *, model: str) -> list[str]:
            seen.append(model)
            return [model] * len(sentences)

        with patch.object(runner.ms, "call_gateway", side_effect=fake_translate):
            pool = runner.create_translation_pool(10, 6)
            outputs = [pool(["Hello"])[0] for _ in range(16)]
        self.assertEqual(pool.workers, 16)
        self.assertEqual(set(seen), {ANTIGRAVITY, DEEPSEEK_CN})
        self.assertEqual(outputs, seen)
        self.assertEqual(runner.ms.MODEL, default)

    def test_default_staging_uses_sixteen_and_records_both_models(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            stage = Path(folder)
            with patch.object(runner, "STAGE", stage), patch.object(
                runner, "translate_with_checkpoint", return_value=translated_cues()
            ) as translate:
                runner.translate_staged(source_rows())
            self.assertEqual(translate.call_args.kwargs["workers"], 16)
            self.assertIn(ANTIGRAVITY, translate.call_args.kwargs["model"])
            self.assertIn(DEEPSEEK_CN, translate.call_args.kwargs["model"])
            self.assertNotEqual(translate.call_args.args[1].name, "translation_checkpoint.json")
            payload = json.loads((stage / "subtitle.json").read_text(encoding="utf-8"))
            self.assertEqual(set(payload["translation_models"]), {ANTIGRAVITY, DEEPSEEK_CN})
            self.assertEqual(payload["translation_workers"], {ANTIGRAVITY: 10, DEEPSEEK_CN: 6})

    def test_capacity_changes_reuse_same_checkpoint_identity(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            with patch.object(runner, "STAGE", Path(folder)), patch.object(
                runner, "translate_with_checkpoint", return_value=translated_cues()
            ) as translate:
                runner.translate_staged(source_rows(), workers=10, deepseek_workers=6)
                first = translate.call_args
                runner.translate_staged(source_rows(), workers=5, deepseek_workers=3)
                second = translate.call_args
            self.assertEqual(first.args[1], second.args[1])
            self.assertEqual(first.kwargs["model"], second.kwargs["model"])
            self.assertEqual(second.kwargs["workers"], 8)

    def test_antigravity_only_checkpoint_is_named_per_grouping(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            with patch.object(runner, "STAGE", Path(folder)), patch.object(
                runner, "translate_with_checkpoint", return_value=translated_cues()
            ) as translate:
                runner.translate_staged(source_rows(), workers=3, deepseek_workers=0)
            name = translate.call_args.args[1].name
            self.assertTrue(name.startswith("translation_checkpoint."))
            self.assertNotEqual(name, "translation_checkpoint.json")
            self.assertEqual(translate.call_args.kwargs["model"], ANTIGRAVITY)
            self.assertEqual(translate.call_args.kwargs["workers"], 3)

    def test_grouping_change_uses_a_different_checkpoint(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            with patch.object(runner, "STAGE", Path(folder)), patch.object(
                runner, "translate_with_checkpoint", return_value=translated_cues()
            ) as translate:
                runner.translate_staged(source_rows(), workers=10, deepseek_workers=6)
                wide = translate.call_args.args[1]
                with patch.object(runner, "TRANSLATION_GROUP_CHARS", 1):
                    runner.translate_staged(source_rows(), workers=10, deepseek_workers=6)
                narrow = translate.call_args.args[1]
            self.assertNotEqual(wide, narrow)

    def test_larger_group_budget_cuts_requests_per_video(self) -> None:
        cues = [{"s": float(i), "e": float(i + 1), "en": "word " * 100 + "."} for i in range(10)]
        small = runner.ms.group_cues(cues, max_chars=700)
        large = runner.ms.group_cues(cues, max_chars=runner.TRANSLATION_GROUP_CHARS)
        self.assertGreater(len(small), len(large))
        self.assertEqual(sum(len(group) for group in large), len(cues))
        self.assertGreaterEqual(len(large[0]), 4)
        with self.assertRaises(ValueError):
            runner.ms.group_cues(cues, max_chars=0)

    def test_invalid_capacity_rejected_before_starting_work(self) -> None:
        for ant, deep in ((0, 0), (-1, 6), (10, -1), (11, 6), (10, 7), (16, 0)):
            args = ["runner", "--antigravity-workers", str(ant), "--deepseek-workers", str(deep)]
            with self.subTest(ant=ant, deep=deep), patch.object(sys, "argv", args), patch(
                "sys.stderr"
            ):
                with self.assertRaises(SystemExit):
                    runner.parse_args()
                with patch.object(batch, "get_audio") as get_audio, patch.object(batch, "STAGE") as stage:
                    stage.mkdir.side_effect = AssertionError("must reject before filesystem work")
                    with self.assertRaises(SystemExit):
                        batch.main()
                    get_audio.assert_not_called()

    def test_direct_pool_factory_rejects_counts_above_ten_plus_six(self) -> None:
        for ant, deep in ((11, 6), (10, 7), (16, 0), (True, 6), (0, 0)):
            with self.subTest(ant=ant, deep=deep), self.assertRaises(ValueError):
                runner.create_translation_pool(ant, deep)

    def test_direct_batch_entry_rejects_excess_before_log_or_process(self) -> None:
        with patch.object(batch.tempfile, "NamedTemporaryFile") as log, patch.object(
            batch.subprocess, "run"
        ) as process:
            with self.assertRaises(ValueError):
                batch.run_runner("abcdefghijk", Path("unused.webm"), "cuda", 11, 6)
            log.assert_not_called()
            process.assert_not_called()

    def test_batch_subprocess_receives_both_limits(self) -> None:
        with tempfile.TemporaryDirectory(dir=ROOT / "work") as folder:
            stage_root = Path(folder)
            stage = stage_root / "abcdefghijk"
            stage.mkdir()
            with patch.object(batch, "STAGE", stage_root), patch.object(
                batch.subprocess, "run", return_value=unittest.mock.Mock(returncode=0)
            ) as process:
                batch.run_runner("abcdefghijk", stage / "audio.webm", "cuda", 10, 6)
            command = process.call_args.args[0]
            with patch.object(sys, "argv", ["runner", *command[4:]]):
                args = runner.parse_args()
            self.assertEqual((args.translation_workers, args.deepseek_workers), (10, 6))


if __name__ == "__main__":
    unittest.main()
