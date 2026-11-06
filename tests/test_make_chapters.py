"""Tests for tools/make_chapters.py; runnable with unittest or pytest under python -I."""

from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))

import make_chapters as mc


class ParsePayloadTests(unittest.TestCase):
    def test_fenced_json(self) -> None:
        content = '```json\n{"tldr": "摘要", "chapters": []}\n```'
        self.assertEqual(mc.parse_payload(content), {"tldr": "摘要", "chapters": []})

    def test_json_with_prose_around(self) -> None:
        content = '好的，结果如下：{"a": 1} 以上。'
        self.assertEqual(mc.parse_payload(content), {"a": 1})

    def test_no_json_raises(self) -> None:
        with self.assertRaises(ValueError):
            mc.parse_payload("抱歉，我无法处理这个请求。")


class SanitizeTests(unittest.TestCase):
    def raw(self, **overrides: object) -> dict:
        payload = {
            "tldr": "这是一场关于分布式系统一致性权衡的经典演讲。",
            "chapters": [
                {"s": 0, "t": "开场"},
                {"s": 300, "t": "CAP 定理"},
                {"s": 700, "t": "实践取舍"},
                {"s": 1000, "t": "总结"},
            ],
        }
        payload.update(overrides)
        return payload

    def test_valid_outline_passes(self) -> None:
        outline = mc.sanitize(self.raw(), 1200)
        self.assertIsNotNone(outline)
        self.assertEqual([c["s"] for c in outline["chapters"]], [0, 300, 700, 1000])

    def test_late_first_chapter_gets_opening(self) -> None:
        payload = self.raw()
        payload["chapters"] = payload["chapters"][1:]
        outline = mc.sanitize(payload, 1200)
        self.assertEqual(outline["chapters"][0], {"s": 0, "t": "开场"})

    def test_close_chapters_collapse(self) -> None:
        payload = self.raw(chapters=[
            {"s": 0, "t": "开场"},
            {"s": 300, "t": "CAP 定理"},
            {"s": 320, "t": "重复章节"},
            {"s": 700, "t": "实践"},
            {"s": 1000, "t": "总结"},
        ])
        outline = mc.sanitize(payload, 1200)
        self.assertNotIn(320, [c["s"] for c in outline["chapters"]])

    def test_out_of_range_seconds_clamped(self) -> None:
        payload = self.raw(chapters=[
            {"s": -50, "t": "开场"},
            {"s": 300, "t": "CAP 定理"},
            {"s": 99999, "t": "结尾"},
        ])
        outline = mc.sanitize(payload, 600)
        self.assertEqual([c["s"] for c in outline["chapters"]], [0, 300, 599])

    def test_too_few_chapters_rejected(self) -> None:
        payload = self.raw(chapters=[{"s": 0, "t": "只有一章"}, {"s": 300, "t": "两章"}])
        self.assertIsNone(mc.sanitize(payload, 1200))

    def test_short_tldr_rejected(self) -> None:
        self.assertIsNone(mc.sanitize(self.raw(tldr="太短"), 1200))

    def test_long_title_capped(self) -> None:
        payload = self.raw(chapters=[
            {"s": 0, "t": "一" * 40},
            {"s": 300, "t": "二"},
            {"s": 700, "t": "三"},
            {"s": 1000, "t": "四"},
        ])
        outline = mc.sanitize(payload, 1200)
        self.assertTrue(all(len(c["t"]) <= 16 for c in outline["chapters"]))

    def test_non_dict_rejected(self) -> None:
        self.assertIsNone(mc.sanitize([1, 2, 3], 1200))
        self.assertIsNone(mc.sanitize(None, 1200))


class TranscriptTests(unittest.TestCase):
    def test_windows_pack_and_cap(self) -> None:
        cues = [
            {"s": i * 5, "e": i * 5 + 5, "en": f"line {i} " + "x" * 100, "zh": ""}
            for i in range(20)
        ]
        lines = mc.build_transcript(cues)
        # 100 seconds of cues with >=10s windows -> at most ~10 lines.
        self.assertLessEqual(len(lines), 11)
        self.assertTrue(all(len(text) <= mc.MAX_LINE_CHARS for _, text in lines))
        self.assertEqual(lines[0][0], 0)

    def test_prefers_en_falls_back_to_zh(self) -> None:
        lines = mc.build_transcript([
            {"s": 0, "e": 12, "en": "english text", "zh": ""},
            {"s": 12, "e": 24, "en": "", "zh": "中文内容"},
        ])
        joined = " ".join(text for _, text in lines)
        self.assertIn("english text", joined)
        self.assertIn("中文内容", joined)


if __name__ == "__main__":
    unittest.main()
