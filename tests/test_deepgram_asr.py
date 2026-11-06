"""Deepgram adapter contract tests; all HTTP and sleep behavior is fake."""

from __future__ import annotations

import copy
import io
import json
import math
import sys
import tempfile
import unittest
from email.message import Message
from pathlib import Path
from types import TracebackType
from typing import Any
from unittest.mock import patch
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))

from deepgram_asr import DeepgramClient, DeepgramError


API_KEY = "fake-deepgram-secret-do-not-persist"
SERVER_SECRET = "private-server-body-do-not-disclose"
AUDIO_BYTES = b"fake-audio-payload\x00\xff" * 128
DURATION = 20.0


def utterance_payload() -> dict[str, Any]:
    return {
        "metadata": {"request_id": "fake-request", "model_info": {}},
        "results": {
            "utterances": [
                {
                    "start": 0.25,
                    "end": 1.6,
                    "transcript": "Hello, world!",
                    "confidence": 0.91,
                    "words": [
                        {
                            "start": 0.25,
                            "end": 0.7,
                            "word": "hello",
                            "punctuated_word": "Hello,",
                            "confidence": 0.97,
                        },
                        {
                            "start": 0.8,
                            "end": 1.6,
                            "word": "world",
                            "punctuated_word": "world!",
                            "confidence": 0.85,
                        },
                    ],
                }
            ],
            "channels": [
                {"alternatives": [{"transcript": "Wrong fallback", "words": []}]}
            ],
        },
    }


class FakeResponse:
    def __init__(self, payload: Any, *, raw: bool = False) -> None:
        self.body = payload if raw else json.dumps(payload).encode("utf-8")

    def __enter__(self) -> FakeResponse:
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        return None

    def read(self) -> bytes:
        return self.body


class FakeOpener:
    """Consume each request body, including requests that will fail."""

    def __init__(self, outcomes: list[Any]) -> None:
        self.outcomes = iter(outcomes)
        self.calls: list[tuple[Any, float]] = []
        self.uploads: list[bytes] = []

    def __call__(self, request: Any, *, timeout: float) -> FakeResponse:
        self.calls.append((request, timeout))
        data = request.data
        self.uploads.append(data.read() if hasattr(data, "read") else bytes(data))
        outcome = next(self.outcomes)
        if isinstance(outcome, BaseException):
            raise outcome
        return outcome


def http_error(status: int, retry_after: str | None = None) -> HTTPError:
    headers = Message()
    if retry_after is not None:
        headers["Retry-After"] = retry_after
    return HTTPError(
        "https://api.deepgram.com/v1/listen",
        status,
        f"{SERVER_SECRET} {API_KEY}",
        headers,
        io.BytesIO(f"{SERVER_SECRET} {API_KEY}".encode("utf-8")),
    )


class DeepgramClientTests(unittest.TestCase):
    def setUp(self) -> None:
        for target in ("socket.create_connection", "socket.socket.connect"):
            guard = patch(target, side_effect=AssertionError("network prohibited"))
            guard.start()
            self.addCleanup(guard.stop)
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.directory = Path(directory.name)
        self.audio = self.directory / "sample.mp3"
        self.audio.write_bytes(AUDIO_BYTES)

    def assert_normalized(self, segments: Any, duration: float) -> None:
        self.assertIsInstance(segments, list)
        self.assertTrue(segments, "Empty transcripts must never be published")
        previous_end = 0.0
        for segment in segments:
            self.assertTrue({"start", "end", "text", "words"} <= segment.keys())
            self.assertIsInstance(segment["text"], str)
            self.assertTrue(segment["text"].strip())
            self.assertTrue(math.isfinite(segment["start"]))
            self.assertTrue(math.isfinite(segment["end"]))
            self.assertGreaterEqual(segment["start"], previous_end)
            self.assertGreater(segment["end"], segment["start"])
            self.assertLessEqual(segment["end"], duration + 0.1)
            previous_end = segment["end"]
            word_end = segment["start"]
            for word in segment["words"]:
                self.assertTrue({"start", "end", "word", "probability"} <= word.keys())
                self.assertIsInstance(word["word"], str)
                self.assertTrue(word["word"].strip())
                self.assertTrue(math.isfinite(word["start"]))
                self.assertTrue(math.isfinite(word["end"]))
                self.assertGreaterEqual(word["start"], word_end)
                self.assertGreater(word["end"], word["start"])
                self.assertLessEqual(word["end"], duration + 0.1)
                self.assertTrue(math.isfinite(word["probability"]))
                self.assertGreaterEqual(word["probability"], 0)
                self.assertLessEqual(word["probability"], 1)
                word_end = word["end"]

    def test_constructor_rejects_missing_blank_and_header_injection_keys(self) -> None:
        for key in (None, "", " ", "\t\n", "abc\ndef", "abc\rdef", 123):
            with self.subTest(key=key):
                with self.assertRaises((TypeError, ValueError, DeepgramError)) as caught:
                    DeepgramClient(key)
                self.assertNotIn(API_KEY, str(caught.exception))

    def test_constructor_rejects_invalid_timeouts_and_attempt_counts(self) -> None:
        invalid = (0, -1, float("nan"), float("inf"), float("-inf"))
        for field in ("timeout", "max_attempts"):
            for value in invalid:
                with self.subTest(field=field, value=value):
                    with self.assertRaises((TypeError, ValueError, DeepgramError)):
                        DeepgramClient(API_KEY, **{field: value})
        DeepgramClient(API_KEY, timeout=0.01, max_attempts=1)

    def test_utterances_preserve_text_timing_and_word_confidence_without_files(self) -> None:
        payload = utterance_payload()
        snapshot = copy.deepcopy(payload)
        opener = FakeOpener([FakeResponse(payload)])
        segments = DeepgramClient(API_KEY, opener=opener).transcribe(self.audio, DURATION)
        self.assert_normalized(segments, DURATION)
        self.assertEqual(len(segments), 1)
        self.assertEqual(segments[0]["text"], "Hello, world!")
        self.assertEqual((segments[0]["start"], segments[0]["end"]), (0.25, 1.6))
        words = segments[0]["words"]
        self.assertEqual(len(words), 2)
        self.assertEqual((words[0]["start"], words[0]["end"]), (0.25, 0.7))
        self.assertIn(words[0]["word"], ("hello", "Hello,"))
        self.assertAlmostEqual(words[0]["probability"], 0.97)
        self.assertAlmostEqual(words[1]["probability"], 0.85)
        self.assertEqual(payload, snapshot)
        self.assertEqual(set(self.directory.iterdir()), {self.audio})
        self.assertEqual(self.audio.read_bytes(), AUDIO_BYTES)
        self.assertNotIn(API_KEY, json.dumps(segments))

    def test_monotonic_overlapping_word_alignments_trim_earlier_end(self) -> None:
        payload = utterance_payload()
        payload["results"]["utterances"][0]["words"][0]["end"] = 1.15
        before = copy.deepcopy(payload)
        result = DeepgramClient(API_KEY, opener=FakeOpener([FakeResponse(payload)])).transcribe(self.audio, DURATION)
        words = result[0]["words"]
        self.assertEqual(len(words), 2)
        self.assertEqual(words[0]["end"], words[1]["start"])
        self.assertEqual(result[0]["text"], "Hello, world!")
        self.assertEqual(payload, before)
        self.assert_normalized(result, DURATION)

    def test_word_fallback_preserves_every_word_in_readable_cues(self) -> None:
        words = [
            {
                "start": index * 0.5,
                "end": index * 0.5 + 0.4,
                "word": f"word{index}",
                "punctuated_word": f"word{index}.",
                "confidence": 0.93,
            }
            for index in range(61)
        ]
        payload = {"results": {"channels": [{"alternatives": [{"words": words}]}]}}
        opener = FakeOpener([FakeResponse(payload)])
        segments = DeepgramClient(API_KEY, opener=opener).transcribe(self.audio, 31.0)
        self.assert_normalized(segments, 31.0)
        flattened = [word for segment in segments for word in segment["words"]]
        self.assertEqual(len(flattened), len(words))
        self.assertEqual([word["start"] for word in flattened], [w["start"] for w in words])
        for segment in segments:
            self.assertLessEqual(len(segment["words"]), 25)
            self.assertLessEqual(segment["end"] - segment["start"], 15.0)
            for word in segment["words"]:
                self.assertIn(word["word"].rstrip("."), segment["text"])
                self.assertAlmostEqual(word["probability"], 0.93)

    def test_malformed_json_raises_sanitized_domain_error(self) -> None:
        for body in (b"", b"{broken", b"\xff", f"{API_KEY} {SERVER_SECRET}".encode()):
            with self.subTest(body=body):
                opener = FakeOpener([FakeResponse(body, raw=True)])
                with self.assertRaises(DeepgramError) as caught:
                    DeepgramClient(API_KEY, max_attempts=1, opener=opener).transcribe(
                        self.audio, DURATION
                    )
                self.assertIsInstance(caught.exception, RuntimeError)
                self.assertNotIn(API_KEY, str(caught.exception))
                self.assertNotIn(SERVER_SECRET, str(caught.exception))
                self.assertIsNone(getattr(caught.exception, "status", None))
                self.assertIs(caught.exception.uncertain, False)

    def test_missing_schema_empty_speech_and_blank_text_are_errors(self) -> None:
        blank = utterance_payload()
        blank["results"]["utterances"][0]["transcript"] = " \t "
        payloads = (
            None,
            [],
            {},
            {"results": None},
            {"results": {"utterances": "not-a-list"}},
            {"results": {"utterances": [{}]}},
            {"results": {"utterances": []}},
            {"results": {"channels": [{"alternatives": [{"words": []}]}]}},
            blank,
        )
        for payload in payloads:
            with self.subTest(payload=payload):
                opener = FakeOpener([FakeResponse(payload)])
                with self.assertRaises(DeepgramError) as caught:
                    DeepgramClient(API_KEY, max_attempts=1, opener=opener).transcribe(
                        self.audio, DURATION
                    )
                self.assertIs(caught.exception.uncertain, False)

    def test_invalid_times_and_overlapping_rows_are_rejected_or_normalized(self) -> None:
        cases: list[dict[str, Any]] = []
        for field, value in (
            ("start", -0.1), ("start", float("nan")), ("start", "0"),
            ("end", float("inf")), ("end", 0.25), ("end", 20.11),
        ):
            payload = utterance_payload()
            payload["results"]["utterances"][0][field] = value
            cases.append(payload)
        for field, value in (("start", -1), ("end", float("nan")), ("end", 25)):
            payload = utterance_payload()
            payload["results"]["utterances"][0]["words"][0][field] = value
            cases.append(payload)
        for start, end in ((0.1, 1.0), (1.0, 2.0)):
            payload = utterance_payload()
            row = copy.deepcopy(payload["results"]["utterances"][0])
            row.update(start=start, end=end, words=[])
            payload["results"]["utterances"].append(row)
            cases.append(payload)
        for payload in cases:
            with self.subTest(payload=payload):
                opener = FakeOpener([FakeResponse(payload)])
                try:
                    result = DeepgramClient(
                        API_KEY, max_attempts=1, opener=opener
                    ).transcribe(self.audio, DURATION)
                except DeepgramError as error:
                    self.assertIs(error.uncertain, False)
                    continue
                self.assert_normalized(result, DURATION)

    def test_request_uses_fixed_english_endpoint_auth_mime_and_timeout(self) -> None:
        for suffix, accepted_mimes in (
            (".mp3", {"audio/mpeg"}),
            (".wav", {"audio/wav", "audio/x-wav", "audio/wave"}),
            (".flac", {"audio/flac", "audio/x-flac"}),
        ):
            with self.subTest(suffix=suffix):
                audio = self.directory / f"sample{suffix}"
                audio.write_bytes(AUDIO_BYTES)
                opener = FakeOpener([FakeResponse(utterance_payload())])
                DeepgramClient(API_KEY, timeout=7.5, opener=opener).transcribe(audio, DURATION)
                self.assertEqual(len(opener.calls), 1)
                request, timeout = opener.calls[0]
                url = urlsplit(request.full_url)
                self.assertEqual((url.scheme, url.netloc, url.path),
                                 ("https", "api.deepgram.com", "/v1/listen"))
                query = parse_qs(url.query)
                for name, value in (("model", "nova-3"), ("language", "en"),
                                    ("utterances", "true"), ("smart_format", "true"),
                                    ("punctuate", "true")):
                    self.assertEqual(query.get(name), [value])
                headers = {name.lower(): value for name, value in request.header_items()}
                self.assertEqual(headers.get("authorization"), f"Token {API_KEY}")
                self.assertIn(headers.get("content-type"), accepted_mimes)
                self.assertEqual(request.get_method(), "POST")
                self.assertEqual(timeout, 7.5)
                self.assertEqual(opener.uploads, [AUDIO_BYTES])
                self.assertNotIn(API_KEY, request.full_url)

    def test_rate_limits_retry_with_default_attempts_and_reset_audio(self) -> None:
        opener = FakeOpener([
            http_error(429), http_error(429), FakeResponse(utterance_payload()),
        ])
        delays: list[float] = []
        result = DeepgramClient(
            API_KEY, opener=opener, sleep=delays.append
        ).transcribe(self.audio, DURATION)
        self.assert_normalized(result, DURATION)
        self.assertEqual(len(opener.calls), 3)
        self.assertEqual(opener.uploads, [AUDIO_BYTES] * 3)
        self.assertEqual(len(delays), 2)
        self.assertTrue(all(math.isfinite(delay) and 0 <= delay <= 300 for delay in delays))

    def test_network_timeout_and_server_errors_are_uncertain_without_reupload(self) -> None:
        outcomes = (
            (URLError(f"{API_KEY} {SERVER_SECRET}"), None),
            (TimeoutError(f"{API_KEY} {SERVER_SECRET}"), None),
            (URLError(TimeoutError(f"{API_KEY} {SERVER_SECRET}")), None),
            (http_error(500), 500),
            (http_error(502), 502),
            (http_error(503), 503),
            (http_error(504), 504),
        )
        for error, status in outcomes:
            with self.subTest(error_type=type(error).__name__, status=status):
                opener = FakeOpener([error, FakeResponse(utterance_payload())])
                delays: list[float] = []
                with self.assertRaises(DeepgramError) as caught:
                    DeepgramClient(
                        API_KEY, max_attempts=3, opener=opener, sleep=delays.append
                    ).transcribe(self.audio, DURATION)
                self.assertIs(caught.exception.uncertain, True)
                self.assertEqual(getattr(caught.exception, "status", None), status)
                self.assertEqual(len(opener.calls), 1)
                self.assertEqual(opener.uploads, [AUDIO_BYTES])
                self.assertEqual(delays, [])
                for rendered in (str(caught.exception), repr(caught.exception)):
                    self.assertNotIn(API_KEY, rendered)
                    self.assertNotIn(SERVER_SECRET, rendered)

    def test_authentication_errors_have_status_and_never_retry_or_leak_secrets(self) -> None:
        for status in (401, 403):
            with self.subTest(status=status):
                opener = FakeOpener([http_error(status)])
                delays: list[float] = []
                with self.assertRaises(DeepgramError) as caught:
                    DeepgramClient(API_KEY, opener=opener, sleep=delays.append).transcribe(
                        self.audio, DURATION
                    )
                self.assertEqual(caught.exception.status, status)
                self.assertIs(caught.exception.uncertain, False)
                self.assertEqual(len(opener.calls), 1)
                self.assertEqual(delays, [])
                for rendered in (str(caught.exception), repr(caught.exception)):
                    self.assertNotIn(API_KEY, rendered)
                    self.assertNotIn(SERVER_SECRET, rendered)

    def test_rate_limit_exhaustion_is_bounded_and_certain(self) -> None:
        for attempts in (1, 3):
            with self.subTest(attempts=attempts):
                opener = FakeOpener([http_error(429) for _ in range(attempts + 1)])
                delays: list[float] = []
                with self.assertRaises(DeepgramError) as caught:
                    DeepgramClient(
                        API_KEY, max_attempts=attempts, opener=opener, sleep=delays.append
                    ).transcribe(self.audio, DURATION)
                self.assertEqual(len(opener.calls), attempts)
                self.assertEqual(opener.uploads, [AUDIO_BYTES] * attempts)
                self.assertEqual(len(delays), attempts - 1)
                self.assertEqual(caught.exception.status, 429)
                self.assertIs(caught.exception.uncertain, False)
                self.assertNotIn(API_KEY, str(caught.exception))
                self.assertNotIn(SERVER_SECRET, str(caught.exception))

    def test_untrusted_retry_after_values_cannot_cause_unbounded_or_invalid_sleep(self) -> None:
        for retry_after in ("999999999999999999", "inf", "nan", "-1", "invalid", "2"):
            with self.subTest(retry_after=retry_after):
                opener = FakeOpener([
                    http_error(429, retry_after), FakeResponse(utterance_payload())
                ])
                delays: list[float] = []
                result = DeepgramClient(
                    API_KEY, max_attempts=2, opener=opener, sleep=delays.append
                ).transcribe(self.audio, DURATION)
                self.assert_normalized(result, DURATION)
                self.assertEqual(len(opener.calls), 2)
                self.assertEqual(len(delays), 1)
                self.assertTrue(math.isfinite(delays[0]))
                self.assertGreaterEqual(delays[0], 0)
                self.assertLessEqual(delays[0], 300)


if __name__ == "__main__":
    unittest.main()
