"""Exercise gateway request construction with fake responses and no network."""
from __future__ import annotations

import io
import json
import sys
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
import make_subs as ms


class GatewayModelRoutingTests(unittest.TestCase):
    def setUp(self) -> None:
        network = patch("socket.create_connection", side_effect=AssertionError("network prohibited"))
        network.start()
        self.addCleanup(network.stop)

    def test_explicit_model_is_sent_without_changing_default(self) -> None:
        default = ms.MODEL
        with patch.object(ms.urllib.request, "urlopen", return_value=io.BytesIO(json.dumps({
            "choices": [{"message": {"content": "译文"}}]
        }).encode())) as request:
            self.assertEqual(ms.call_gateway(["Hello"], model="fake/antigravity"), ["译文"])
        self.assertEqual(json.loads(request.call_args.args[0].data)["model"], "fake/antigravity")
        self.assertEqual(ms.MODEL, default)

    def test_no_model_argument_keeps_legacy_default(self) -> None:
        with patch.object(ms, "MODEL", "legacy-model"), patch.object(
            ms.urllib.request, "urlopen", return_value=io.BytesIO(json.dumps({
                "choices": [{"message": {"content": "译文"}}]
            }).encode())
        ) as request:
            ms.call_gateway(["Hello"])
        self.assertEqual(json.loads(request.call_args.args[0].data)["model"], "legacy-model")

    def test_sixteen_overlapping_requests_keep_their_model(self) -> None:
        barrier = threading.Barrier(16, timeout=5)
        captured = []
        lock = threading.Lock()
        default = ms.MODEL

        def fake_open(request: object, **kwargs: object) -> io.BytesIO:
            body = json.loads(request.data)
            barrier.wait()
            with lock:
                captured.append(body)
            return io.BytesIO(json.dumps({"choices": [{"message": {"content": body["model"]}}]}).encode())

        models = ["fake/antigravity"] * 10 + ["fake/deepseek-cn"] * 6
        with patch.object(ms.urllib.request, "urlopen", side_effect=fake_open):
            with ThreadPoolExecutor(max_workers=16) as pool:
                futures = [pool.submit(ms.call_gateway, [model], model=model) for model in models]
                self.assertEqual([future.result() for future in futures], [[model] for model in models])
        self.assertEqual(sum(body["model"] == "fake/antigravity" for body in captured), 10)
        self.assertEqual(sum(body["model"] == "fake/deepseek-cn" for body in captured), 6)
        self.assertTrue(all(body["messages"][-1]["content"].endswith(body["model"]) for body in captured))
        self.assertEqual(ms.MODEL, default)

    def test_single_cue_split_into_sentences_is_joined(self) -> None:
        content = "第一句。@@@第二句。@@@第三句。"
        with patch.object(ms.urllib.request, "urlopen", return_value=io.BytesIO(json.dumps({
            "choices": [{"message": {"content": content}}]
        }).encode())):
            self.assertEqual(ms.call_gateway(["One long cue."]), ["第一句。第二句。第三句。"])

    def test_group_separator_mismatch_still_raises(self) -> None:
        content = "甲@@@乙@@@丙"
        with patch.object(ms.urllib.request, "urlopen", return_value=io.BytesIO(json.dumps({
            "choices": [{"message": {"content": content}}]
        }).encode())), self.assertRaises(ValueError):
            ms.call_gateway(["a", "b"])

    def test_invalid_explicit_model_fails_before_request(self) -> None:
        with patch.object(ms.urllib.request, "urlopen") as request:
            for model in ("", " ", 42):
                with self.subTest(model=model), self.assertRaises(ValueError):
                    ms.call_gateway(["Hello"], model=model)
            request.assert_not_called()


if __name__ == "__main__":
    unittest.main()
