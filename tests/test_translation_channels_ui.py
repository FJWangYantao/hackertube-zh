"""Test translation channels telemetry API and HTML markup."""

from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))

import pipeline_server as ps
import translation_backends as tb


class TranslationChannelsTelemetryTests(unittest.TestCase):
    def test_telemetry_summary_structure(self) -> None:
        summary = tb.GLOBAL_TELEMETRY.get_summary()
        self.assertIn("channels", summary)
        self.assertIn("fastest_channel", summary)
        self.assertIn("slowest_channel", summary)
        self.assertIn("bottlenecks", summary)
        self.assertIn("recommendations", summary)
        self.assertIn("recent_requests", summary)
        self.assertEqual(len(summary["channels"]), len(tb.TRANSLATION_MODELS))

        for ch in summary["channels"]:
            self.assertIn("model", ch)
            self.assertIn("workers", ch)
            self.assertIn("avg_latency_ms", ch)
            self.assertIn("p90_latency_ms", ch)
            self.assertIn("success_rate", ch)
            self.assertIn("is_bottleneck", ch)

    def test_live_payload_includes_channels_telemetry(self) -> None:
        payload = ps.build_live_payload()
        self.assertIn("channels_telemetry", payload)
        self.assertIsInstance(payload["channels_telemetry"], dict)
        self.assertIn("channels", payload["channels_telemetry"])

    def test_html_contains_channel_dashboard_elements(self) -> None:
        html = (ROOT / "reports" / "translation-pipeline.html").read_text(encoding="utf-8")
        self.assertIn('id="channels"', html)
        self.assertIn('id="tc-bottleneck-card"', html)
        self.assertIn('id="channel-metrics-table"', html)
        self.assertIn('id="tc-latency-bars"', html)
        self.assertIn('id="tc-req-stream"', html)
        self.assertIn('id="btn-probe-all"', html)
        self.assertIn("renderChannelsTelemetry", html)
        self.assertIn("renderRequestStream", html)


if __name__ == "__main__":
    unittest.main()
