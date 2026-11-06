"""Fake-only checkpoint tests; runnable with unittest or pytest under python -I."""

from __future__ import annotations

import copy
import json
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))

import subtitle_recovery as recovery


def cue(index: int, text: str | None = None) -> dict:
    return {"s": index * 1.5, "e": index * 1.5 + 1, "en": text or f"source {index}"}


class RecoveryTests(unittest.TestCase):
    def setUp(self) -> None:
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name) / "nested" / "checkpoint.json"
        self.groups = [[cue(0), cue(1)], [cue(2)]]
        self.network = patch("socket.create_connection", side_effect=AssertionError("network prohibited"))
        self.network.start()
        self.addCleanup(self.network.stop)

    def run_translation(self, translate: object, groups: object = None, **kwargs: object) -> list[dict]:
        return recovery.translate_with_checkpoint(
            self.groups if groups is None else groups, self.path, translate,
            model=kwargs.pop("model", "fake-model"), **kwargs,
        )

    def read_checkpoint(self) -> dict:
        return json.loads(self.path.read_text(encoding="utf-8"))

    def test_validation_boundaries_and_markers(self) -> None:
        self.assertEqual(recovery.DEFAULT_TRANSLATION_WORKERS, 6)
        self.assertEqual(recovery.MAX_TRANSLATION_CHARS, 200)
        for text in (None, 42, [], {}, "", " \n\t", "中" * 201,
                     "AS AN AI, hello", "prefix @@@ suffix", "分隔符", "思考过程"):
            with self.subTest(text=text):
                self.assertIsInstance(recovery.translation_issue(text), str)
        for text in ("中", "中" * 200, "  技术字幕  ", "你好 🌍 ' ; DROP TABLE", "English term"):
            with self.subTest(text=text):
                self.assertIsNone(recovery.translation_issue(text))

    def test_length_limit_scales_with_a_long_source_cue(self) -> None:
        source = "word " * 100
        self.assertEqual(recovery.translation_limit(source), 400)
        self.assertEqual(recovery.translation_limit("short"), recovery.MAX_TRANSLATION_CHARS)
        self.assertEqual(recovery.translation_limit(None), recovery.MAX_TRANSLATION_CHARS)
        self.assertIsNone(recovery.translation_issue("中" * 380, source))
        self.assertIsInstance(recovery.translation_issue("中" * 401, source), str)

    def test_reasoning_words_inside_a_sentence_are_translation(self) -> None:
        self.assertIsNone(recovery.translation_issue("背后涉及太多的层级、决策和思考过程。"))
        self.assertIsInstance(recovery.translation_issue("思考过程：先翻译第一句"), str)
        self.assertIsInstance(recovery.translation_issue("分隔符：不要输出"), str)

    def test_preserves_order_timing_source_and_does_not_mutate(self) -> None:
        original = copy.deepcopy(self.groups)
        output = self.run_translation(lambda texts: ["译 " + text for text in texts])
        self.assertEqual(self.groups, original)
        self.assertEqual(output, [{**item, "zh": "译 " + item["en"]}
                                  for group in original for item in group])
        self.assertTrue(all(result is not source for result, source in
                            zip(output, [item for group in self.groups for item in group])))

    def test_successful_resume_has_zero_calls(self) -> None:
        expected = self.run_translation(lambda texts: ["译文"] * len(texts))
        def forbidden(texts: list[str]) -> list[str]:
            self.fail("valid checkpoint should prevent translation")
        self.assertEqual(self.run_translation(forbidden), expected)

    def test_keeps_valid_group_cues_and_repairs_only_invalid(self) -> None:
        calls = []
        def translate(texts: list[str]) -> list[str]:
            calls.append(texts)
            return ["可用", "AS AN AI"] if len(texts) == 2 else ["修复"]
        result = self.run_translation(translate, groups=[self.groups[0]])
        self.assertEqual(calls, [["source 0", "source 1"], ["source 1"]])
        self.assertEqual([item["zh"] for item in result], ["可用", "修复"])

    def test_exhaustion_retains_partial_and_resume_only_bad_cue(self) -> None:
        calls = []
        def translate(texts: list[str]) -> list[str]:
            calls.append(texts)
            return ["可用", ""] if len(texts) == 2 else ["@@@"]
        with self.assertRaisesRegex(RuntimeError, r"cue 2.*@@@"):
            self.run_translation(translate, groups=[self.groups[0]])
        self.assertEqual(calls, [["source 0", "source 1"], ["source 1"], ["source 1"]])
        self.assertEqual(self.read_checkpoint()["translations"], {"0": "可用"})
        resumed = []
        output = self.run_translation(lambda texts: resumed.append(texts) or ["修复"],
                                      groups=[self.groups[0]])
        self.assertEqual(resumed, [["source 1"]])
        self.assertEqual([item["zh"] for item in output], ["可用", "修复"])

    def test_separator_and_count_mismatch_retry_individually(self) -> None:
        for broken in ("separator", [], ["wrong count"], ["a", "b", "c"], None, "not a list", ("a", "b")):
            with self.subTest(broken=broken):
                self.path.unlink(missing_ok=True)
                calls = []
                def translate(texts: list[str]) -> list[str]:
                    calls.append(texts)
                    if len(texts) == 2:
                        if broken == "separator":
                            raise ValueError("separator mismatch")
                        return broken
                    return ["修复"]
                result = self.run_translation(translate, groups=[self.groups[0]])
                self.assertEqual(len(result), 2)
                self.assertCountEqual(calls[1:], [["source 0"], ["source 1"]])
                self.assertEqual(len(calls), 3)

    def test_invalid_types_in_correct_length_result_preserve_other_cues(self) -> None:
        calls = []
        def translate(texts: list[str]) -> list[str]:
            calls.append(texts)
            return ["可用", None] if len(texts) == 2 else ["修复"]
        self.run_translation(translate, groups=[self.groups[0]])
        self.assertEqual(calls, [["source 0", "source 1"], ["source 1"]])

    def test_repairs_bounded_for_value_errors_and_invalid_outputs(self) -> None:
        for broken in ("exception", [], [""], [None], "中文"):
            with self.subTest(broken=broken):
                self.path.unlink(missing_ok=True)
                calls = []
                def translate(texts: list[str]) -> list[str]:
                    calls.append(texts)
                    if broken == "exception":
                        raise ValueError("separator mismatch")
                    return broken
                with self.assertRaisesRegex(RuntimeError, r"cue 1"):
                    self.run_translation(translate, groups=[[cue(0)]], repair_attempts=2)
                self.assertEqual(len(calls), 3)
                self.assertEqual(self.read_checkpoint()["translations"], {})

    def test_zero_repairs_does_not_retry(self) -> None:
        calls = []
        with self.assertRaisesRegex(RuntimeError, r"cue 1.*blank"):
            self.run_translation(lambda texts: calls.append(texts) or [""],
                                 groups=[[cue(0)]], repair_attempts=0)
        self.assertEqual(len(calls), 1)

    def test_all_exhausted_indexes_are_reported(self) -> None:
        with self.assertRaises(RuntimeError) as raised:
            self.run_translation(lambda texts: [""] * len(texts), repair_attempts=0)
        for index in (1, 2, 3):
            self.assertIn(f"cue {index}", str(raised.exception))

    def test_group_transport_failure_saves_other_successes_without_retry(self) -> None:
        calls = []
        def translate(texts: list[str]) -> list[str]:
            calls.append(texts)
            if texts == ["source 0", "source 1"]:
                raise ConnectionError("gateway unavailable")
            return ["成功"]
        with self.assertRaisesRegex(RuntimeError, r"cue 1.*gateway unavailable") as raised:
            self.run_translation(translate)
        self.assertIsInstance(raised.exception.__cause__, ConnectionError)
        self.assertEqual(len(calls), 2)
        self.assertEqual(self.read_checkpoint()["translations"], {"2": "成功"})

    def test_repair_transport_failure_is_not_retried(self) -> None:
        calls = []
        def translate(texts: list[str]) -> list[str]:
            calls.append(texts)
            if len(texts) == 2:
                return ["", "成功"]
            raise TimeoutError("gateway timeout")
        with self.assertRaisesRegex(RuntimeError, r"cue 1.*gateway timeout"):
            self.run_translation(translate, groups=[self.groups[0]], repair_attempts=9)
        self.assertEqual(len(calls), 2)
        self.assertEqual(self.read_checkpoint()["translations"], {"1": "成功"})

    def test_finished_success_is_persisted_before_slow_first_group_returns(self) -> None:
        saved = threading.Event()
        original_write = recovery.write_json_atomic
        def observe(path: Path, payload: object) -> None:
            original_write(path, payload)
            if payload["translations"].get("1") == "快速":
                saved.set()
        def translate(texts: list[str]) -> list[str]:
            if texts == ["source 0"]:
                if not saved.wait(3):
                    raise AssertionError("completion was blocked by input order")
                raise ConnectionError("slow failure")
            return ["快速"]
        with patch.object(recovery, "write_json_atomic", side_effect=observe):
            with self.assertRaisesRegex(RuntimeError, "slow failure"):
                self.run_translation(translate, groups=[[cue(0)], [cue(1)]], workers=2)
        self.assertTrue(saved.is_set())

    def test_repair_success_saved_before_other_repair_finishes(self) -> None:
        saved = threading.Event()
        original_write = recovery.write_json_atomic
        def observe(path: Path, payload: object) -> None:
            original_write(path, payload)
            if payload["translations"].get("0") == "修复":
                saved.set()
        def translate(texts: list[str]) -> list[str]:
            if len(texts) == 2:
                return ["", ""]
            if texts == ["source 0"]:
                return ["修复"]
            if not saved.wait(3):
                raise AssertionError("repair success was not saved immediately")
            return ["最后"]
        with patch.object(recovery, "write_json_atomic", side_effect=observe):
            result = self.run_translation(translate, groups=[self.groups[0]], workers=2)
        self.assertEqual([item["zh"] for item in result], ["修复", "最后"])

    def test_model_input_order_timing_source_and_version_mismatch_fail_closed(self) -> None:
        self.run_translation(lambda texts: ["成功"] * len(texts))
        original = self.path.read_bytes()
        changed_text = copy.deepcopy(self.groups)
        changed_text[0][0]["en"] = "changed"
        changed_time = copy.deepcopy(self.groups)
        changed_time[0][0]["e"] = 99
        variants = [(self.groups, "other"), (changed_text, "fake-model"),
                    (changed_time, "fake-model"), (list(reversed(self.groups)), "fake-model")]
        for groups, model in variants:
            with self.subTest(model=model, groups=groups):
                with self.assertRaisesRegex(ValueError, "checkpoint.*(mismatch|provenance)"):
                    self.run_translation(lambda texts: self.fail("cache mismatch must fail closed"),
                                         groups=groups, model=model)
                self.assertEqual(self.path.read_bytes(), original)
        payload = self.read_checkpoint()
        for bad_version in (-1, True):
            with self.subTest(version=bad_version):
                recovery.write_json_atomic(self.path, {**payload, "version": bad_version})
                with self.assertRaisesRegex(ValueError, "checkpoint"):
                    self.run_translation(lambda texts: self.fail("invalid validation version must fail closed"))

    def test_malformed_checkpoint_fails_clearly_without_calls_or_overwrite(self) -> None:
        self.path.parent.mkdir()
        for raw in ("{", "null", "[]", "{}", '\xff'):
            with self.subTest(raw=raw):
                self.path.write_bytes(raw.encode("latin-1"))
                before = self.path.read_bytes()
                with self.assertRaisesRegex(ValueError, "checkpoint"):
                    self.run_translation(lambda texts: self.fail("malformed cache must not be used"))
                self.assertEqual(self.path.read_bytes(), before)

    def test_malformed_translation_mapping_fails_closed(self) -> None:
        self.run_translation(lambda texts: ["成功"] * len(texts))
        original = self.read_checkpoint()
        for bad in ([], None, {"500": "outside"}, {"-1": "outside"}, {"01": "alias"}):
            with self.subTest(bad=bad):
                recovery.write_json_atomic(self.path, {**original, "translations": bad})
                with self.assertRaisesRegex(ValueError, "checkpoint"):
                    self.run_translation(lambda texts: self.fail("malformed mapping must fail closed"))

    def test_cached_translations_are_revalidated(self) -> None:
        self.run_translation(lambda texts: ["成功"] * len(texts))
        payload = self.read_checkpoint()
        for bad in ("", "@@@", "中" * 201, None):
            with self.subTest(bad=bad):
                recovery.write_json_atomic(self.path, {**payload, "translations":
                    {**payload["translations"], "1": bad}})
                calls = []
                with self.assertLogs(recovery.__name__, level="WARNING"):
                    self.run_translation(lambda texts: calls.append(texts) or ["修复"])
                self.assertEqual(calls, [["source 1"]])

    def test_empty_input_and_empty_groups(self) -> None:
        self.assertEqual(self.run_translation(lambda texts: self.fail("empty input"),
                                               groups=[[], []]), [])
        self.assertEqual(self.read_checkpoint()["translations"], {})

    def test_bad_configuration_and_source_fail_before_calls(self) -> None:
        variants = [{"workers": 0}, {"workers": True}, {"workers": 1.2},
                    {"repair_attempts": -1}, {"repair_attempts": True},
                    {"model": ""}, {"model": None}]
        for kwargs in variants:
            with self.subTest(kwargs=kwargs):
                with self.assertRaises((ValueError, TypeError)):
                    self.run_translation(lambda texts: self.fail("invalid config"), **kwargs)
        for groups in (None, "bad", [None], [[{}]], [[{**cue(0), "en": ""}]],
                       [[{**cue(0), "s": float("nan")}]], [[{**cue(0), "e": True}]],
                       [[{**cue(0), "en": 123}]], [[None]],
                       [[{**cue(0), "extra": object()}]]):
            with self.subTest(groups=groups):
                with self.assertRaises((ValueError, TypeError)):
                    recovery.translate_with_checkpoint(groups, self.path,
                        lambda texts: self.fail("invalid source"), model="fake")
        with self.assertRaises((ValueError, TypeError)):
            self.run_translation(None)
        self.assertFalse(self.path.exists())

    def test_concurrency_is_bounded_including_repairs(self) -> None:
        lock = threading.Lock()
        barrier = threading.Barrier(3, timeout=3)
        active = 0
        peak = 0
        seen = set()
        def translate(texts: list[str]) -> list[str]:
            nonlocal active, peak
            with lock:
                active += 1
                peak = max(peak, active)
                first = texts[0] not in seen
                seen.add(texts[0])
            try:
                barrier.wait()
                return [""] if first else ["完成"]
            finally:
                with lock:
                    active -= 1
        # Six initial single-cue groups ensure two full waves and exercise repairs.
        output = self.run_translation(translate, groups=[[cue(i)] for i in range(6)], workers=3)
        self.assertEqual(len(output), 6)
        self.assertEqual(peak, 3)
        self.assertEqual(active, 0)

    def test_large_input_and_special_characters(self) -> None:
        source = [cue(i, "Unicode 中文 🌍 SQL ';") for i in range(10001)]
        result = self.run_translation(lambda texts: ["中文 🌍"] * len(texts), groups=[source])
        self.assertEqual(len(result), 10001)
        self.assertEqual(result[-1]["s"], source[-1]["s"])

    def test_atomic_replace_failure_retains_valid_checkpoint_and_cleans_temp(self) -> None:
        recovery.write_json_atomic(self.path, {"old": "有效"})
        before = self.path.read_bytes()
        with patch.object(recovery.os, "replace", side_effect=OSError("replace denied")):
            with self.assertRaisesRegex(OSError, "replace denied"):
                recovery.write_json_atomic(self.path, {"new": "value"})
        self.assertEqual(self.path.read_bytes(), before)
        self.assertEqual(list(self.path.parent.iterdir()), [self.path])

    def test_atomic_serialization_failure_does_not_truncate_checkpoint(self) -> None:
        recovery.write_json_atomic(self.path, {"old": "有效"})
        before = self.path.read_bytes()
        with self.assertRaises((TypeError, ValueError)):
            recovery.write_json_atomic(self.path, {"not_json": object()})
        self.assertEqual(self.path.read_bytes(), before)
        self.assertEqual(list(self.path.parent.iterdir()), [self.path])

    def test_checkpoint_write_failure_surfaces_without_publishing(self) -> None:
        with patch.object(recovery, "write_json_atomic", side_effect=OSError("disk full")):
            with self.assertRaisesRegex(OSError, "disk full"):
                self.run_translation(lambda texts: ["成功"] * len(texts))
        self.assertFalse(self.path.exists())


if __name__ == "__main__":
    unittest.main()
