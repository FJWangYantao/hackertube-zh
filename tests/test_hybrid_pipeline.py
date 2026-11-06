"""Offline scheduling tests: no model loads, downloads or paid API calls."""
from __future__ import annotations

import json
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))

from subtitle_recovery import RecoverySession
from hybrid_pipeline import HybridJob, HybridPipeline, Recognition
from translation_backends import BackendPool, TranslationBackend


def groups(count: int = 3) -> list[list[dict]]:
    return [[{"s": i * 20.0, "e": i * 20.0 + 10, "en": f"source {i}"}]
            for i in range(count)]


class SessionTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / "checkpoint.json"

    def test_session_preserves_partial_success_and_repairs_only_bad_cue(self) -> None:
        source = [groups(2)[0] + groups(2)[1]]
        session = RecoverySession(source, self.path, model="fake")
        work = session.take()
        session.accept(work, ["译文", "@@@"])
        self.assertEqual(session.pending_count, 1)
        repair = session.take()
        self.assertEqual(session.texts(repair), ["source 1"])
        session.accept(repair, ["修复"])
        self.assertTrue(session.done)
        self.assertEqual([c["zh"] for c in session.result()], ["译文", "修复"])
        resumed = RecoverySession(source, self.path, model="fake")
        self.assertIsNone(resumed.take())
        self.assertEqual(resumed.result(), session.result())

    def test_session_transport_failure_retains_checkpoint_without_semantic_retry(self) -> None:
        session = RecoverySession(groups(2), self.path, model="fake")
        first, second = session.take(), session.take()
        session.accept(first, ["可用"])
        session.accept(second, error=OSError("offline"))
        self.assertTrue(session.done)
        with self.assertRaisesRegex(RuntimeError, "incomplete"):
            session.result()
        resumed = RecoverySession(groups(2), self.path, model="fake")
        self.assertEqual(resumed.pending_count, 1)
        self.assertEqual(resumed.texts(resumed.take()), ["source 1"])

    def test_session_exhausts_repairs_and_rejects_checkpoint_mismatch(self) -> None:
        session = RecoverySession(groups(1), self.path, model="fake", repair_attempts=1)
        session.accept(session.take(), [""])
        session.accept(session.take(), ["@@@"])
        with self.assertRaises(RuntimeError):
            session.result()
        original = self.path.read_bytes()
        with self.assertRaises(ValueError):
            RecoverySession(groups(2), self.path, model="fake")
        self.assertEqual(self.path.read_bytes(), original)

    def test_session_rejects_result_before_completion_and_foreign_work(self) -> None:
        session = RecoverySession(groups(1), self.path, model="fake")
        with self.assertRaises(RuntimeError):
            session.result()
        work = session.take()
        session.accept(work, ["完成"])
        with self.assertRaises(ValueError):
            session.accept(work, ["重复"])


class HybridTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.network = patch("socket.create_connection", side_effect=AssertionError("network forbidden"))
        self.network.start()
        self.addCleanup(self.network.stop)

    def jobs(self, count: int) -> list[HybridJob]:
        return [HybridJob(f"video{i:06d}", self.root / f"v{i}") for i in range(count)]

    @staticmethod
    def recognize(job: HybridJob) -> Recognition:
        return Recognition(job.vid, "whisper-local", "small.en", 300.0,
                           [{"start": 0.0, "end": 200.0, "text": job.vid}])

    def make_pipeline(self, recognizers: dict | None = None, **kwargs: object) -> HybridPipeline:
        return HybridPipeline(
            recognizers=recognizers or {"local": (1, self.recognize)},
            translate=kwargs.pop("translate", BackendPool((TranslationBackend("fake", 2,
                lambda texts: ["译文"] * len(texts)),))),
            group=kwargs.pop("group", lambda result: groups(3)),
            finish=kwargs.pop("finish", lambda job, result, cues: None),
            **kwargs,
        )

    def test_local_and_cloud_overlap_and_each_video_has_one_owner(self) -> None:
        barrier = threading.Barrier(2)
        owners = []
        lock = threading.Lock()

        def recognize(job: HybridJob) -> Recognition:
            with lock:
                owners.append(job.vid)
            barrier.wait(timeout=3)
            return self.recognize(job)

        pipeline = self.make_pipeline({"local": (1, recognize), "deepgram": (1, recognize)})
        result = pipeline.run(self.jobs(2))
        self.assertEqual(len(set(owners)), 2)
        self.assertEqual([r["status"] for r in result.values()], ["completed"] * 2)

    def test_all_videos_share_sixteen_calls_and_backend_ten_plus_six(self) -> None:
        barrier = threading.Barrier(16)
        lock = threading.Lock()
        active = {"a": 0, "d": 0}
        peak = {"a": 0, "d": 0, "total": 0}
        calls = 0

        def callback(name: str):
            def translate(texts: list[str]) -> list[str]:
                nonlocal calls
                with lock:
                    calls += 1
                    number = calls
                    active[name] += 1
                    peak[name] = max(peak[name], active[name])
                    peak["total"] = max(peak["total"], sum(active.values()))
                try:
                    if number <= 16:
                        barrier.wait(timeout=5)
                    return ["译文"] * len(texts)
                finally:
                    with lock:
                        active[name] -= 1
            return translate

        pool = BackendPool((TranslationBackend("a", 10, callback("a")),
                            TranslationBackend("d", 6, callback("d"))))
        observed = []
        pipeline = self.make_pipeline(
            {"local": (1, self.recognize), "deepgram": (1, self.recognize)},
            translate=pool, group=lambda result: groups(12), on_event=observed.append,
        )
        result = pipeline.run(self.jobs(3))
        self.assertTrue(all(r["status"] == "completed" for r in result.values()))
        self.assertEqual(peak, {"a": 10, "d": 6, "total": 16})
        self.assertTrue(all(e.get("translation_active", 0) <= 16 for e in observed))

    def test_failure_isolated_and_successful_video_checkpoint_reused(self) -> None:
        jobs = self.jobs(2)
        def recognize(job: HybridJob) -> Recognition:
            if job == jobs[0]:
                raise OSError("bad audio")
            return self.recognize(job)
        finished = []
        pipeline = self.make_pipeline({"local": (1, recognize)}, finish=lambda *args: finished.append(args))
        result = pipeline.run(jobs)
        self.assertEqual(result[jobs[0].vid]["status"], "failed")
        self.assertEqual(result[jobs[0].vid]["reason"], "OSError: bad audio")
        self.assertEqual(result[jobs[1].vid]["status"], "completed")
        self.assertEqual(len(finished), 1)
        forbidden = BackendPool((TranslationBackend("fake", 2,
            lambda texts: self.fail("checkpoint must avoid translation")),))
        result = self.make_pipeline(translate=forbidden).run(jobs[1:])
        self.assertEqual(result[jobs[1].vid]["status"], "completed")

    def test_translation_failure_keeps_progress_and_does_not_finish_video(self) -> None:
        def translate(texts: list[str]) -> list[str]:
            if texts == ["source 1"]:
                raise OSError("unavailable")
            return ["译文"] * len(texts)
        pool = BackendPool((TranslationBackend("fake", 2, translate),))
        finished = []
        job = self.jobs(1)[0]
        result = self.make_pipeline(translate=pool, finish=lambda *args: finished.append(args)).run([job])
        self.assertEqual(result[job.vid]["status"], "failed")
        self.assertEqual(finished, [])
        checkpoint = next(job.stage.glob("translation*.json"))
        self.assertEqual(len(json.loads(checkpoint.read_text())["translations"]), 2)
        good = self.make_pipeline()
        self.assertEqual(good.run([job])[job.vid]["status"], "completed")

    def test_high_watermark_pauses_admission_until_backlog_drains(self) -> None:
        seen = []
        pipeline = self.make_pipeline(queue_low=0, queue_high=2,
            group=lambda result: groups(6), on_event=seen.append)
        result = pipeline.run(self.jobs(3))
        self.assertTrue(all(r["status"] == "completed" for r in result.values()))
        paused = [e for e in seen if e.get("event") == "admission" and e.get("paused")]
        resumed = [e for e in seen if e.get("event") == "admission" and e.get("paused") is False]
        self.assertTrue(paused)
        self.assertTrue(resumed)

    def test_single_huge_job_does_not_deadlock_reservation(self) -> None:
        job = HybridJob("hugevideo01", self.root / "huge", estimated_groups=100)
        result = self.make_pipeline(queue_high=2, queue_low=0).run([job])
        self.assertEqual(result[job.vid]["status"], "completed")

    def test_repair_burst_uses_same_executor_and_preserves_sources(self) -> None:
        seen = {}
        def translate(texts: list[str]) -> list[str]:
            count = seen.get(texts[0], 0)
            seen[texts[0]] = count + 1
            return ["@@@"] if count == 0 else ["修复"]
        pool = BackendPool((TranslationBackend("fake", 2, translate),))
        finished = []
        result = self.make_pipeline(translate=pool, finish=lambda *args: finished.append(args)).run(self.jobs(1))
        self.assertEqual(next(iter(result.values()))["status"], "completed")
        self.assertTrue(all(c["zh"] == "修复" for c in finished[0][2]))
        self.assertTrue(all(count == 2 for count in seen.values()))

    def test_invalid_configuration_and_duplicate_jobs_fail_before_recognition(self) -> None:
        for kwargs in ({"queue_low": 3, "queue_high": 3}, {"queue_low": -1}, {"queue_high": 0}):
            with self.subTest(kwargs=kwargs), self.assertRaises(ValueError):
                self.make_pipeline(**kwargs)
        for recognizers in ({"local": (2, self.recognize)}, {"deepgram": (3, self.recognize)}):
            with self.assertRaises(ValueError):
                self.make_pipeline(recognizers)
        pipeline = self.make_pipeline()
        job = self.jobs(1)[0]
        with self.assertRaises(ValueError):
            pipeline.run([job, job])

    def test_one_checkpoint_write_failure_does_not_lose_another_video(self) -> None:
        import subtitle_recovery as recovery
        jobs = self.jobs(2)
        original = recovery.write_json_atomic
        def write(path: Path, payload: dict) -> None:
            if path.parent == jobs[0].stage and payload.get("translations"):
                raise PermissionError("one video stage unwritable")
            original(path, payload)
        with patch.object(recovery, "write_json_atomic", side_effect=write):
            result = self.make_pipeline(
                {"local": (1, self.recognize), "deepgram": (1, self.recognize)}).run(jobs)
        self.assertEqual(result[jobs[0].vid]["status"], "failed")
        self.assertEqual(result[jobs[1].vid]["status"], "completed")
        checkpoint = next(jobs[1].stage.glob("translation*.json"))
        self.assertEqual(len(json.loads(checkpoint.read_text())["translations"]), 3)

    def test_interrupt_drains_started_translations_into_checkpoint(self) -> None:
        interrupted = False
        def on_event(event: dict) -> None:
            nonlocal interrupted
            if event["event"] == "dispatch" and event["translation_active"] and not interrupted:
                interrupted = True
                raise KeyboardInterrupt
        job = self.jobs(1)[0]
        with self.assertRaises(KeyboardInterrupt):
            self.make_pipeline(on_event=on_event).run([job])
        checkpoint = next(job.stage.glob("translation*.json"))
        saved = json.loads(checkpoint.read_text())["translations"]
        self.assertEqual(len(saved), 2)
        self.assertEqual(self.make_pipeline().run([job])[job.vid]["status"], "completed")

    def test_publish_failure_does_not_mark_completed(self) -> None:
        def finish(*args: object) -> None:
            raise ValueError("invalid subtitle")
        result = self.make_pipeline(finish=finish).run(self.jobs(1))
        self.assertEqual(next(iter(result.values()))["status"], "failed")


if __name__ == "__main__":
    unittest.main()
