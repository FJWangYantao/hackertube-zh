"""Tests for tools/subindex.py; runnable with unittest or pytest under python -I."""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))

import subindex


def decode(encoded: str) -> list[int]:
    out = []
    acc = 0
    for part in encoded.split(" "):
        acc += int(part, 36)
        out.append(acc)
    return out


class ExtractTokensTests(unittest.TestCase):
    def test_english_words_drop_stopwords_and_short_words(self) -> None:
        tokens = subindex.extract_tokens([{"en": "The CAP theorem is a theorem", "zh": ""}])
        self.assertEqual(tokens, {"cap", "theorem"})

    def test_cjk_bigrams(self) -> None:
        tokens = subindex.extract_tokens([{"en": "", "zh": "分布式系统"}])
        self.assertEqual(tokens, {"分布", "布式", "式系", "系统"})

    def test_mixed_script_and_hyphens(self) -> None:
        tokens = subindex.extract_tokens([{"en": "Objective-C don't", "zh": "你好，世界。"}])
        self.assertIn("objective-c", tokens)
        self.assertIn("don't", tokens)
        self.assertIn("你好", tokens)
        self.assertIn("世界", tokens)

    def test_single_cjk_char_yields_no_bigram(self) -> None:
        self.assertEqual(subindex.extract_tokens([{"zh": "中"}]), set())


class EncodePostingsTests(unittest.TestCase):
    def test_delta_base36(self) -> None:
        self.assertEqual(subindex.encode_postings([3, 10, 47]), "3 7 11")
        self.assertEqual(subindex.encode_postings([0]), "0")
        self.assertEqual(decode(subindex.encode_postings([3, 10, 47])), [3, 10, 47])


class BuildIndexTests(unittest.TestCase):
    def setUp(self) -> None:
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.subs = Path(self.directory.name)
        self.write_subs("vidA", [
            {"s": 0, "e": 5, "zh": "分布式系统入门", "en": "cap theorem intro"},
            {"s": 5, "e": 9, "zh": "讲一致性", "en": "about consistency"},
        ])
        self.write_subs("vidB", [
            {"s": 0, "e": 5, "zh": "系统设计", "en": "cap for design"},
        ])

    def write_subs(self, vid: str, cues: list[dict]) -> None:
        (self.subs / f"{vid}.json").write_text(
            json.dumps({"vid": vid, "cues": cues}, ensure_ascii=False), encoding="utf-8")

    def test_postings_and_min_videos_pruning(self) -> None:
        index = subindex.build_index(self.subs)
        self.assertEqual(index["v"], ["vidA", "vidB"])
        # "cap" is in both videos; "theorem"/"consistency" only in one and get pruned.
        self.assertEqual(decode(index["i"]["cap"]), [0, 1])
        self.assertNotIn("theorem", index["i"])
        self.assertNotIn("consistency", index["i"])

    def test_write_index_round_trip(self) -> None:
        index = subindex.build_index(self.subs)
        out = self.subs / "out.json"
        subindex.write_index(index, out)
        loaded = json.loads(out.read_text(encoding="utf-8"))
        self.assertEqual(loaded["v"], ["vidA", "vidB"])
        self.assertEqual(decode(loaded["i"]["cap"]), [0, 1])


if __name__ == "__main__":
    unittest.main()
