"""Hybrid-batch telemetry tests; no network and no real work artifacts."""
from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))

import pipeline_server as ps


def write_json(path: Path, payload: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload), encoding="utf-8")


def recognition_payload() -> dict:
    rows = [
        {"start": 0.0, "end": 1.0, "text": "Hello world",
         "words": [{"word": "Hello", "start": 0.0, "end": 0.4, "probability": 0.9}]},
        {"start": 1.0, "end": 2.0, "text": "second line", "words": []},
    ]
    return {"version": 1, "vid": "VIDEO1", "source": "deepgram", "model": "nova-3",
            "duration": 2.0, "rows": rows, "audio_path": "work/a.mp3", "audio_sha256": "x"}


class PipelineServerTests(unittest.TestCase):
    def setUp(self) -> None:
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.work = self.root / "work"
        self.hybrid = self.work / "hybrid_batch"
        self.subs = self.root / "site" / "data" / "subs"
        self.subs.mkdir(parents=True)
        self.patches = [
            patch.object(ps, "WORK_DIR", self.work),
            patch.object(ps, "HYBRID_DIR", self.hybrid),
            patch.object(ps, "HYBRID_STATUS_PATH", self.hybrid / "status.json"),
            patch.object(ps, "WHISPER_BATCH_DIR", self.work / "whisper_batch"),
            patch.object(ps, "STATUS_PATH", self.work / "whisper_batch" / "status.json"),
            patch.object(ps, "SUBS_OUT_DIR", self.subs),
            patch.object(ps, "get_video_catalog", return_value={}),
        ]
        for guard in self.patches:
            guard.start()
            self.addCleanup(guard.stop)

    def test_missing_hybrid_stage_reports_absent(self) -> None:
        self.assertEqual(ps.inspect_hybrid_stage("VIDEO1")["exists"], False)

    def test_hybrid_stage_reads_recognition_checkpoint_and_lock(self) -> None:
        stage = self.hybrid / "VIDEO1"
        write_json(stage / "recognition.json", recognition_payload())
        write_json(stage / "translation.abc.json", {
            "model": "gateway", "fingerprint": "f" * 64,
            "translations": {"0": "你好，世界"},
        })
        write_json(self.hybrid / "batch.lock", {"pid": 4321})
        result = ps.inspect_hybrid_stage("VIDEO1", {"status": "translating", "provider": "deepgram"})
        self.assertTrue(result["exists"])
        self.assertTrue(result["locked"])
        self.assertEqual(result["runner_state"]["phase"], "translation")
        self.assertEqual(result["transcript_count"], 2)
        self.assertEqual(result["translated_count"], 1)
        self.assertEqual(result["groups"][0]["done"], 1)
        self.assertTrue(result["cues"][0]["done"])
        self.assertTrue(result["cues"][0]["words_head"])
        self.assertEqual(result["log"]["recognized_segments"], 2)
        self.assertFalse(result["has_staged_subtitle"])

    def test_live_payload_prefers_hybrid_batch_when_present(self) -> None:
        stage = self.hybrid / "VIDEO1"
        write_json(stage / "recognition.json", recognition_payload())
        write_json(self.hybrid / "status.json", {
            "version": 1,
            "configuration": {"translation_workers": [{"model": "a", "workers": 10},
                                                       {"model": "b", "workers": 6}]},
            "videos": {
                "VIDEO1": {"event": "video", "vid": "VIDEO1", "status": "translating",
                           "provider": "local", "duration": 2.0},
                "VIDEO2": {"event": "video", "vid": "VIDEO2", "status": "completed",
                           "provider": "deepgram", "duration": 9.0},
            },
            "latest": {"event": "video", "translation_active": 3, "backlog_groups": 5},
            "active_vids": ["VIDEO1"],
        })
        payload = ps.build_live_payload()
        self.assertEqual(payload["engine"], "hybrid")
        self.assertEqual(payload["active_vid"], "VIDEO1")
        self.assertEqual(payload["stage"]["engine"], "hybrid")
        self.assertEqual(payload["batch_status_counts"]["processing"], 1)
        self.assertEqual(payload["batch_status_counts"]["completed"], 1)
        self.assertEqual(payload["hybrid"]["backlog_groups"], 5)
        self.assertEqual(payload["hybrid"]["translation_active"], 3)
        self.assertEqual(payload["published_subs_total"], 0)

    def test_live_payload_falls_back_to_legacy_status(self) -> None:
        write_json(self.work / "whisper_batch" / "status.json",
                   {"OLD": {"status": "completed", "duration": 10}})
        payload = ps.build_live_payload()
        self.assertEqual(payload["engine"], "whisper_batch")
        self.assertEqual(payload["active_vid"], "OLD")
        self.assertFalse(payload["hybrid"]["configured"])


if __name__ == "__main__":
    unittest.main()
