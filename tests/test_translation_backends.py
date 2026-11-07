"""Fake-only backend pool tests, including the existing recovery executor."""

from __future__ import annotations

import copy
import json
import sys
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from dataclasses import FrozenInstanceError, is_dataclass
from pathlib import Path
from typing import Callable
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))

import subtitle_recovery as recovery
import translation_backends as backends

WAIT = 10


def echo(sentences: list[str]) -> list[str]:
    return ["译 " + sentence for sentence in sentences]


def configured_pool(antigravity: object = echo, deepseek: object = echo) -> backends.BackendPool:
    return backends.BackendPool((
        backends.TranslationBackend(backends.ANTIGRAVITY_MODEL, 10, antigravity),
        backends.TranslationBackend(backends.DEEPSEEK_CN_MODEL, 6, deepseek),
    ))


class NetworkGuardTests(unittest.TestCase):
    def setUp(self) -> None:
        for target in ("socket.create_connection", "socket.socket.connect"):
            guard = patch(target, side_effect=AssertionError("network prohibited"))
            guard.start()
            self.addCleanup(guard.stop)


class BackendTests(NetworkGuardTests):
    def test_required_constants_and_frozen_dataclass(self) -> None:
        self.assertEqual(backends.ANTIGRAVITY_MODEL, "antigravity/gemini-3.8-flash")
        self.assertEqual(backends.DEEPSEEK_CN_MODEL, "workbuddy-vps/cn:deepseek-v4.1-flash")
        self.assertEqual(backends.TRAE_MODEL, "trae-cn/deepseek-v4.1-flash")
        self.assertEqual(backends.HIYO_MODEL, "hiyo/gpt-6-luna")
        self.assertEqual(backends.CLOUDC_MODEL, "cloudc/glm-5.3-flash")
        self.assertEqual(backends.ZHACHA_MODEL, "zhacha/glm-5.3-flash")
        self.assertEqual(backends.HUB_OAIFREE_MODEL, "hub-oaifree/glm-5.3-flash")
        self.assertEqual(backends.HUB_WANAI_MODEL, "hub-wanai/glm-5.3-flash")
        self.assertEqual(backends.COMMANDCODE_MODEL, "commandcode-plan/deepseek/deepseek-v4.1-flash")
        self.assertEqual(backends.GEMINI_LITE_MODEL, "antigravity/gemini-3.5-flash-lite")
        self.assertEqual(backends.TRANSLATION_MODELS, (
            (backends.ANTIGRAVITY_MODEL, 6),
            (backends.TRAE_MODEL, 5),
            (backends.DEEPSEEK_CN_MODEL, 5),
            (backends.HIYO_MODEL, 4),
            (backends.CLOUDC_MODEL, 4),
            (backends.ZHACHA_MODEL, 4),
            (backends.HUB_OAIFREE_MODEL, 4),
            (backends.HUB_WANAI_MODEL, 4),
            (backends.COMMANDCODE_MODEL, 4),
            (backends.GEMINI_LITE_MODEL, 6),
        ))
        self.assertEqual(backends.TOTAL_WORKERS, 46)
        self.assertEqual(backends.DEFAULT_ANTIGRAVITY_WORKERS, 10)
        self.assertEqual(backends.DEFAULT_DEEPSEEK_WORKERS, 6)
        backend = backends.TranslationBackend("model", 1, echo)
        self.assertTrue(is_dataclass(backend))
        with self.assertRaises(FrozenInstanceError):
            backend.workers = 2

    def test_hybrid_pool_worker_caps(self) -> None:
        backends.validate_pool_worker_counts({
            backends.ANTIGRAVITY_MODEL: 6,
            backends.TRAE_MODEL: 3, backends.DEEPSEEK_CN_MODEL: 3,
        })
        for bad in ({backends.ANTIGRAVITY_MODEL: 7}, {backends.TRAE_MODEL: 6},
                    {backends.DEEPSEEK_CN_MODEL: -1}, {"unknown/model": 1}, {}):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                backends.validate_pool_worker_counts(bad)

    def test_pool_reports_total_models_and_configuration_metadata(self) -> None:
        pool = configured_pool()
        self.assertEqual(pool.workers, 16)
        self.assertEqual(tuple(pool.models), (backends.ANTIGRAVITY_MODEL, backends.DEEPSEEK_CN_MODEL))
        self.assertEqual(list(pool.metadata), [
            {"model": backends.ANTIGRAVITY_MODEL, "workers": 10},
            {"model": backends.DEEPSEEK_CN_MODEL, "workers": 6},
        ])
        self.assertNotIn("translate", json.dumps(pool.metadata))
        snapshot = pool.metadata
        snapshot[0]["workers"] = 999
        snapshot.clear()
        self.assertEqual(pool.metadata[0]["workers"], 10)
        self.assertEqual(pool.workers, 16)

    def test_pool_breaker_trips_after_quota_failures(self) -> None:
        calls = []

        def quota_fail(sentences: list[str]) -> list[str]:
            calls.append(sentences)
            raise backends.urllib.error.HTTPError("u", 402, "quota gone", None, None)

        pool = backends.BackendPool((backends.TranslationBackend("m", 1, quota_fail),))
        for _ in range(backends.BREAKER_THRESHOLD):
            with self.assertRaises(backends.urllib.error.HTTPError):
                pool(["x"])
        self.assertEqual(len(calls), backends.BREAKER_THRESHOLD)
        with patch.object(backends, "BREAKER_GIVE_UP", 0.05):
            with self.assertRaises(RuntimeError):
                pool(["x"])
        self.assertEqual(len(calls), backends.BREAKER_THRESHOLD)

    def test_pool_breaker_trips_on_transport_failures(self) -> None:
        calls = []

        def timeout_fail(sentences: list[str]) -> list[str]:
            calls.append(sentences)
            raise TimeoutError("slow upstream")

        pool = backends.BackendPool((backends.TranslationBackend("m", 1, timeout_fail),))
        for _ in range(backends.BREAKER_THRESHOLD):
            with self.assertRaises(TimeoutError):
                pool(["x"])
        self.assertEqual(len(calls), backends.BREAKER_THRESHOLD)
        with patch.object(backends, "BREAKER_GIVE_UP", 0.05):
            with self.assertRaises(RuntimeError):
                pool(["x"])
        self.assertEqual(len(calls), backends.BREAKER_THRESHOLD)

    def test_pool_breaker_routes_waiting_calls_to_healthy_lane(self) -> None:
        bad_calls = []

        def quota_fail(sentences: list[str]) -> list[str]:
            bad_calls.append(sentences)
            raise backends.urllib.error.HTTPError("u", 429, "rate limited", None, None)

        pool = backends.BackendPool((
            backends.TranslationBackend("bad", 3, quota_fail),
            backends.TranslationBackend("ok", 1, echo),
        ))
        for _ in range(backends.BREAKER_THRESHOLD):
            pool._record("bad", backends.urllib.error.HTTPError("u", 429, "rate limited", None, None))
        self.assertIsNotNone(pool._breakers["bad"]["tripped_at"])
        self.assertEqual(pool(["x"]), echo(["x"]))
        self.assertEqual(bad_calls, [])

    def test_pool_breaker_reopens_after_cooldown(self) -> None:
        calls = []

        def flaky(sentences: list[str]) -> list[str]:
            calls.append(len(calls))
            if len(calls) <= backends.BREAKER_THRESHOLD:
                raise backends.urllib.error.HTTPError("u", 402, "quota", None, None)
            return echo(sentences)

        pool = backends.BackendPool((backends.TranslationBackend("m", 1, flaky),))
        for _ in range(backends.BREAKER_THRESHOLD):
            with self.assertRaises(backends.urllib.error.HTTPError):
                pool(["x"])
        with patch.object(backends, "BREAKER_GIVE_UP", 0.05):
            with self.assertRaises(RuntimeError):
                pool(["x"])
        self.assertEqual(len(calls), backends.BREAKER_THRESHOLD)
        pool._breakers["m"]["tripped_at"] -= backends.BREAKER_COOLDOWN + 1
        self.assertEqual(pool(["x"]), echo(["x"]))
        self.assertIsNone(pool._breakers["m"]["tripped_at"])

    def test_single_backend_identity_is_exact_for_existing_cache(self) -> None:
        model = " exact/中文:model "
        pool = backends.BackendPool((backends.TranslationBackend(model, 3, echo),))
        self.assertEqual(pool.model_identity, model)
        self.assertEqual(pool.workers, 3)

    def test_multi_identity_is_sorted_compact_json_independent_of_capacity_and_order(self) -> None:
        first = configured_pool()
        second = backends.BackendPool((
            backends.TranslationBackend(backends.DEEPSEEK_CN_MODEL, 1, lambda texts: texts),
            backends.TranslationBackend(backends.ANTIGRAVITY_MODEL, 2, echo),
        ))
        expected = "pool:" + json.dumps(sorted(first.models), separators=(",", ":"))
        self.assertEqual(first.model_identity, expected)
        self.assertEqual(second.model_identity, expected)
        changed = backends.BackendPool((backends.TranslationBackend("different", 1, echo),))
        self.assertNotEqual(first.model_identity, changed.model_identity)

    def test_identity_handles_quotes_unicode_and_ambiguous_delimiters(self) -> None:
        models = ('quote"/中文', "comma,colon:", "🌍")
        pool = backends.BackendPool(tuple(backends.TranslationBackend(model, 1, echo) for model in models))
        self.assertEqual(json.loads(pool.model_identity.removeprefix("pool:")), sorted(models))
        alternate = backends.BackendPool((backends.TranslationBackend(",".join(models), 1, echo),))
        self.assertNotEqual(pool.model_identity, alternate.model_identity)

    def test_invalid_model_ids_are_rejected_at_configuration(self) -> None:
        for model in (None, "", " \n\t", 1, [], True):
            with self.subTest(model=model), self.assertRaises((TypeError, ValueError)):
                backends.TranslationBackend(model, 1, echo)

    def test_workers_require_positive_exact_integer(self) -> None:
        for workers in (None, 0, -1, True, False, 1.0, "1", [], 0.5):
            with self.subTest(workers=workers), self.assertRaises((TypeError, ValueError)):
                backends.TranslationBackend("model", workers, echo)
        backend = backends.TranslationBackend("model", 10001, echo)
        self.assertEqual(backend.workers, 10001)

    def test_callbacks_must_be_callable(self) -> None:
        for callback in (None, [], "translate", 1, {}):
            with self.subTest(callback=callback), self.assertRaises(TypeError):
                backends.TranslationBackend("model", 1, callback)

    def test_pool_rejects_empty_duplicate_and_invalid_entries(self) -> None:
        valid = backends.TranslationBackend("same", 1, echo)
        for configured in ((), None, "model", (None,), (object(),), (valid, valid),
                           (valid, backends.TranslationBackend("same", 2, echo))):
            with self.subTest(configured=configured), self.assertRaises((TypeError, ValueError)):
                backends.BackendPool(configured)

    def test_initial_slots_are_interleaved_for_short_jobs(self) -> None:
        seen = []
        pool = configured_pool(lambda texts: seen.append("a") or texts,
                               lambda texts: seen.append("d") or texts)
        for _ in range(4):
            pool(["source"])
        self.assertEqual(seen, ["a", "d", "a", "d"])

    def test_callback_gets_independent_input_and_output_is_preserved(self) -> None:
        source = ["中文 🌍 ';", "source"]
        original = source.copy()
        output = ["翻译"]
        seen = []

        def mutate(sentences: list[str]) -> list[str]:
            seen.append(sentences)
            sentences.clear()
            return output

        pool = backends.BackendPool((backends.TranslationBackend("model", 1, mutate),))
        self.assertIs(pool(source), output)
        self.assertEqual(source, original)
        self.assertIsNot(seen[0], source)

    def test_empty_and_large_inputs_are_passed_without_content_transformation(self) -> None:
        pool = backends.BackendPool((backends.TranslationBackend("model", 1, echo),))
        self.assertEqual(pool([]), [])
        source = ["中文 🌍 SQL ';" for _ in range(10001)]
        self.assertEqual(pool(source), echo(source))
        self.assertEqual(len(source), 10001)

    def test_invalid_input_releases_slot_and_does_not_call_backend(self) -> None:
        calls = []
        pool = backends.BackendPool((backends.TranslationBackend(
            "model", 1, lambda texts: calls.append(texts) or texts),))
        with self.assertRaises(TypeError):
            pool(None)
        self.assertEqual(pool(["after"]), ["after"])
        self.assertEqual(calls, [["after"]])

    def test_exception_is_preserved_without_retry_or_fallback_and_slot_is_released(self) -> None:
        for error in (ValueError("semantic"), ConnectionError("transport"), KeyboardInterrupt()):
            with self.subTest(error=type(error).__name__):
                calls = []

                def fail_once(texts: list[str]) -> list[str]:
                    calls.append(texts)
                    if len(calls) == 1:
                        raise error
                    return ["恢复"]

                pool = backends.BackendPool((backends.TranslationBackend("model", 1, fail_once),))
                with self.assertRaises(type(error)) as raised:
                    pool(["first"])
                self.assertIs(raised.exception, error)
                self.assertEqual(len(calls), 1)
                finished = threading.Event()
                results = []

                def next_call() -> None:
                    results.append(pool(["second"]))
                    finished.set()

                thread = threading.Thread(target=next_call, daemon=True)
                thread.start()
                self.assertTrue(finished.wait(WAIT), "exception leaked a backend slot")
                thread.join(WAIT)
                self.assertEqual(results, [["恢复"]])

    def test_failure_does_not_invoke_other_backend_as_fallback(self) -> None:
        calls = []
        error = TimeoutError("fake timeout")

        def fail(texts: list[str]) -> list[str]:
            calls.append("a")
            raise error

        pool = configured_pool(fail, lambda texts: calls.append("d") or texts)
        with self.assertRaises(TimeoutError) as raised:
            pool(["source"])
        self.assertIs(raised.exception, error)
        self.assertEqual(calls, ["a"])
        self.assertEqual(pool(["next"]), ["next"])
        self.assertEqual(calls, ["a", "d"])

    def test_independent_pools_do_not_share_mutable_model_selection(self) -> None:
        one = backends.BackendPool((backends.TranslationBackend("one", 1, lambda texts: ["一"]),))
        two = backends.BackendPool((backends.TranslationBackend("two", 1, lambda texts: ["二"]),))
        self.assertEqual([one([]), two([]), one([])], [["一"], ["二"], ["一"]])
        self.assertEqual((one.model_identity, two.model_identity), ("one", "two"))

    def test_actual_sixteen_slots_hold_limits_through_simulated_transport_retries(self) -> None:
        lock = threading.Lock()
        full = threading.Event()
        release = threading.Event()
        barrier = threading.Barrier(16, timeout=WAIT)
        active = {"a": 0, "d": 0}
        peaks = {"a": 0, "d": 0}
        calls = {"a": 0, "d": 0}
        attempts = {"a": 0, "d": 0}

        def callback(model: str) -> Callable[[list[str]], list[str]]:
            def translate(texts: list[str]) -> list[str]:
                with lock:
                    active[model] += 1
                    calls[model] += 1
                    peaks[model] = max(peaks[model], active[model])
                    if sum(active.values()) == 16:
                        full.set()
                try:
                    if not release.wait(WAIT):
                        raise AssertionError("initial sixteen slots did not fill")
                    for _ in range(3):
                        with lock:
                            attempts[model] += 1
                        barrier.wait()
                    return echo(texts)
                finally:
                    with lock:
                        active[model] -= 1
            return translate

        pool = configured_pool(callback("a"), callback("d"))
        with ThreadPoolExecutor(max_workers=48) as executor:
            futures = [executor.submit(pool, [str(index)]) for index in range(48)]
            try:
                self.assertTrue(full.wait(WAIT))
                with lock:
                    self.assertEqual(active, {"a": 10, "d": 6})
            finally:
                release.set()
            results = [future.result(timeout=WAIT) for future in futures]
        self.assertEqual(results, [["译 " + str(index)] for index in range(48)])
        self.assertEqual(peaks, {"a": 10, "d": 6})
        self.assertEqual(active, {"a": 0, "d": 0})
        self.assertEqual(sum(calls.values()), 48)
        self.assertEqual(sum(attempts.values()), 144)
        self.assertEqual(attempts, {model: count * 3 for model, count in calls.items()})

    def test_freed_fast_slots_consume_shared_work_without_fixed_model_partition(self) -> None:
        lock = threading.Lock()
        slow_full = threading.Event()
        fast_finished = threading.Event()
        release_slow = threading.Event()
        calls = {"a": 0, "d": 0}

        def slow(texts: list[str]) -> list[str]:
            with lock:
                calls["a"] += 1
                if calls["a"] == 10:
                    slow_full.set()
            if not release_slow.wait(WAIT):
                raise AssertionError("slow jobs were not released")
            return echo(texts)

        def fast(texts: list[str]) -> list[str]:
            if not slow_full.wait(WAIT):
                raise AssertionError("all ten slow slots must be occupied")
            with lock:
                calls["d"] += 1
                if calls["d"] == 38:
                    fast_finished.set()
            return echo(texts)

        pool = configured_pool(slow, fast)
        with ThreadPoolExecutor(max_workers=16) as executor:
            futures = [executor.submit(pool, [str(index)]) for index in range(48)]
            try:
                self.assertTrue(fast_finished.wait(WAIT), "freed fast slots did not consume queued work")
                with lock:
                    self.assertEqual(calls, {"a": 10, "d": 38})
            finally:
                release_slow.set()
            self.assertEqual(len([future.result(timeout=WAIT) for future in futures]), 48)


class RecoveryPoolTests(NetworkGuardTests):
    def test_capacity_and_order_changes_reuse_existing_recovery_checkpoint(self) -> None:
        groups = [[{"s": 0, "e": 1, "en": "source"}]]
        first = configured_pool()
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "checkpoint.json"
            expected = recovery.translate_with_checkpoint(
                groups, path, first, model=first.model_identity, workers=first.workers)
            before = json.loads(path.read_text(encoding="utf-8"))

            def forbidden(texts: list[str]) -> list[str]:
                self.fail("changing capacity or backend order must reuse accepted translations")

            resized = backends.BackendPool((
                backends.TranslationBackend(backends.DEEPSEEK_CN_MODEL, 2, forbidden),
                backends.TranslationBackend(backends.ANTIGRAVITY_MODEL, 1, forbidden),
            ))
            actual = recovery.translate_with_checkpoint(
                groups, path, resized, model=resized.model_identity, workers=resized.workers)
            self.assertEqual(actual, expected)
            self.assertEqual(json.loads(path.read_text(encoding="utf-8")), before)

    def test_resized_pool_resumes_only_missing_cues_from_partial_checkpoint(self) -> None:
        groups = [[{"s": 0, "e": 1, "en": "accepted"},
                   {"s": 1, "e": 2, "en": "missing"}]]
        first = configured_pool(lambda texts: ["可用", ""], lambda texts: ["可用", ""])
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "checkpoint.json"
            with self.assertRaisesRegex(RuntimeError, "cue 2"):
                recovery.translate_with_checkpoint(
                    groups, path, first, model=first.model_identity,
                    workers=first.workers, repair_attempts=0)
            self.assertEqual(json.loads(path.read_text(encoding="utf-8"))["translations"],
                             {"0": "可用"})
            calls = []

            def repaired(texts: list[str]) -> list[str]:
                calls.append(texts)
                return ["修复"]

            resized = backends.BackendPool((
                backends.TranslationBackend(backends.DEEPSEEK_CN_MODEL, 1, repaired),
                backends.TranslationBackend(backends.ANTIGRAVITY_MODEL, 2, repaired),
            ))
            output = recovery.translate_with_checkpoint(
                groups, path, resized, model=resized.model_identity, workers=resized.workers)
        self.assertEqual(calls, [["missing"]])
        self.assertEqual([cue["zh"] for cue in output], ["可用", "修复"])

    def test_single_backend_reuses_legacy_model_checkpoint(self) -> None:
        groups = [[{"s": 0, "e": 1, "en": "source"}]]
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "checkpoint.json"
            expected = recovery.translate_with_checkpoint(groups, path, echo, model="legacy-model")
            pool = backends.BackendPool((backends.TranslationBackend(
                "legacy-model", 2, lambda texts: self.fail("legacy checkpoint should be reused")),))
            self.assertEqual(recovery.translate_with_checkpoint(
                groups, path, pool, model=pool.model_identity, workers=pool.workers), expected)

    def test_recovery_shared_queue_and_semantic_repairs_obey_same_caps(self) -> None:
        lock = threading.Lock()
        barrier = threading.Barrier(16, timeout=WAIT)
        earlier_completed = threading.Event()
        active = {"a": 0, "d": 0}
        peaks = {"a": 0, "d": 0}
        phase_active = {2: {"a": 0, "d": 0}, 1: {"a": 0, "d": 0}}
        phase_peaks = {2: {"a": 0, "d": 0}, 1: {"a": 0, "d": 0}}
        calls = []
        completion_order = []
        groups = [[{"s": i * 2, "e": i * 2 + 1, "en": f"source {i}"},
                   {"s": i * 2 + 1, "e": i * 2 + 2, "en": f"repair {i}"}] for i in range(48)]
        original = copy.deepcopy(groups)

        def callback(model: str) -> Callable[[list[str]], list[str]]:
            def translate(texts: list[str]) -> list[str]:
                snapshot = texts.copy()
                phase = len(snapshot)
                with lock:
                    active[model] += 1
                    peaks[model] = max(peaks[model], active[model])
                    phase_active[phase][model] += 1
                    phase_peaks[phase][model] = max(
                        phase_peaks[phase][model], phase_active[phase][model])
                    calls.append((model, snapshot))
                try:
                    barrier.wait()
                    if snapshot == ["source 0", "repair 0"]:
                        if not earlier_completed.wait(WAIT):
                            raise AssertionError("other group could not finish first")
                    with lock:
                        completion_order.append(snapshot)
                        earlier_completed.set()
                    texts.clear()
                    return ["", "@@@"] if len(snapshot) == 2 else echo(snapshot)
                finally:
                    with lock:
                        active[model] -= 1
                        phase_active[phase][model] -= 1
            return translate

        pool = configured_pool(callback("a"), callback("d"))
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "checkpoint.json"
            output = recovery.translate_with_checkpoint(
                groups, path, pool, model=pool.model_identity, workers=pool.workers, repair_attempts=1)
            payload = json.loads(path.read_text(encoding="utf-8"))
        self.assertEqual(peaks, {"a": 10, "d": 6})
        self.assertEqual(active, {"a": 0, "d": 0})
        self.assertEqual(phase_peaks, {2: {"a": 10, "d": 6}, 1: {"a": 10, "d": 6}})
        self.assertEqual(phase_active, {2: {"a": 0, "d": 0}, 1: {"a": 0, "d": 0}})
        self.assertEqual(len(calls), 144)
        self.assertEqual(sum(len(texts) == 2 for _, texts in calls), 48)
        self.assertEqual(sum(len(texts) == 1 for _, texts in calls), 96)
        self.assertNotEqual(completion_order[0], ["source 0", "repair 0"])
        self.assertEqual(groups, original)
        self.assertEqual(output, [{**cue, "zh": "译 " + cue["en"]}
                                  for group in original for cue in group])
        self.assertEqual(len(payload["translations"]), 96)
        self.assertEqual(payload["model"], pool.model_identity)


class TelemetryTests(unittest.TestCase):
    def test_telemetry_records_success_and_failure_metrics(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            storage = Path(td) / "telemetry.json"
            telem = backends.TranslationTelemetry(storage_path=storage)
            model = backends.ANTIGRAVITY_MODEL
            telem.record_start(model)
            telem.record_success(model, 1200.0, 5, 200)
            summary = telem.get_summary()
            ch = next(c for c in summary["channels"] if c["model"] == model)
            self.assertGreaterEqual(ch["total_requests"], 1)
            self.assertGreater(ch["avg_latency_ms"], 0)
            self.assertEqual(ch["last_status"], "ok")

            # Record failure
            telem.record_start(model)
            telem.record_failure(model, 5000.0, 3, 100, "TimeoutError: gateway timed out")
            summary2 = telem.get_summary()
            ch2 = next(c for c in summary2["channels"] if c["model"] == model)
            self.assertGreaterEqual(ch2["error_requests"], 1)
            self.assertEqual(ch2["last_status"], "error")
            self.assertIn("TimeoutError", ch2["last_error"])

            # Bottleneck diagnostics
            self.assertIn("bottlenecks", summary2)
            self.assertIn("recommendations", summary2)
            self.assertTrue(storage.exists())


if __name__ == "__main__":
    unittest.main()
