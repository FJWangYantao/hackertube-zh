"""Streaming, stdlib-only Deepgram transcription with conservative retries."""

from __future__ import annotations

import json
import math
import os
import time
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from http.client import HTTPException
from pathlib import Path
from typing import Any, Callable
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener


LISTEN_URL = "https://api.deepgram.com/v1/listen?" + urlencode({
    "model": "nova-3",
    "language": "en",
    "utterances": "true",
    "smart_format": "true",
    "punctuate": "true",
})
MAX_ATTEMPTS = 10
MAX_RETRY_DELAY = 60.0
TIMING_TOLERANCE = 0.1
MAX_CUE_WORDS = 25
MAX_CUE_SECONDS = 15.0
AUDIO_MIME_TYPES = {
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".flac": "audio/flac",
    ".m4a": "audio/mp4",
    ".mp4": "audio/mp4",
    ".aac": "audio/aac",
    ".ogg": "audio/ogg",
    ".opus": "audio/ogg",
    ".webm": "audio/webm",
}


class DeepgramError(RuntimeError):
    """Safe public failure; uncertain requests require explicit caller recovery."""

    def __init__(
        self, message: str, *, status: int | None = None, uncertain: bool = False
    ) -> None:
        super().__init__(message)
        self.status = status
        self.uncertain = uncertain


class _NoRedirect(HTTPRedirectHandler):
    """Never forward an authenticated upload to a redirect destination."""

    def redirect_request(
        self, req: Request, fp: Any, code: int, msg: str,
        headers: Any, newurl: str,
    ) -> None:
        return None


def _finite_number(value: Any) -> bool:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return False
    try:
        return math.isfinite(value)
    except OverflowError:
        return False


def _invalid_response() -> DeepgramError:
    return DeepgramError("Deepgram returned invalid or empty transcript data.")


def _text(value: Any) -> str:
    if not isinstance(value, str) or not value.strip():
        raise _invalid_response()
    return value.strip()


def _times(row: dict[str, Any], limit: float) -> tuple[float, float]:
    start, end = row.get("start"), row.get("end")
    if not _finite_number(start) or not _finite_number(end):
        raise _invalid_response()
    start, end = float(start), float(end)
    # Deepgram's own duration can run a hair past ffprobe's; clamp instead of
    # rejecting an otherwise good transcript.
    end = min(end, limit)
    if not 0 <= start < end:
        raise _invalid_response()
    return start, end


def _words(rows: Any, limit: float) -> list[dict[str, Any]]:
    if not isinstance(rows, list) or not rows:
        raise _invalid_response()
    normalized = []
    previous_start = -1.0
    for row in rows:
        if not isinstance(row, dict):
            raise _invalid_response()
        raw_start = row.get("start")
        if not _finite_number(raw_start) or float(raw_start) >= limit:
            continue  # entirely beyond the probed audio; drop, don't fail
        start, end = _times(row, limit)
        if start <= previous_start:
            raise _invalid_response()
        raw_word = _text(row.get("word"))
        word = _text(row["punctuated_word"]) if "punctuated_word" in row else raw_word
        confidence = row.get("confidence")
        if not _finite_number(confidence) or not 0 <= confidence <= 1:
            raise _invalid_response()
        normalized.append({
            "start": start, "end": end, "word": word,
            "probability": float(confidence),
        })
        previous_start = start
    # Nova can give a word an end beyond the next word's start. Preserve
    # every word and its start, trimming only the earlier alignment's end.
    return [{**word, "end": min(word["end"], normalized[index + 1]["start"])}
            if index + 1 < len(normalized) else word
            for index, word in enumerate(normalized)]


def _utterances(rows: Any, limit: float) -> list[dict[str, Any]]:
    if not isinstance(rows, list) or not rows:
        raise _invalid_response()
    segments = []
    previous_end = 0.0
    for row in rows:
        if not isinstance(row, dict):
            raise _invalid_response()
        start, end = _times(row, limit)
        start = max(start, previous_end)  # Nova's boundaries can overlap by ms; clamp
        if start >= end:
            continue
        words = _words(row.get("words"), limit)
        words = [w for w in words if w["end"] > start and w["start"] < end]
        if not words:
            continue
        words = [{**w, "start": max(w["start"], start), "end": min(w["end"], end)}
                 for w in words]
        if "confidence" in row:
            confidence = row["confidence"]
            if not _finite_number(confidence) or not 0 <= confidence <= 1:
                raise _invalid_response()
        segments.append({
            "start": start, "end": end, "text": _text(row.get("transcript")),
            "words": words,
        })
        previous_end = end
    return segments


def _cue(words: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "start": words[0]["start"],
        "end": words[-1]["end"],
        "text": " ".join(word["word"] for word in words),
        "words": words,
    }


def _group_words(words: list[dict[str, Any]]) -> list[dict[str, Any]]:
    segments = []
    offset = 0
    for index, word in enumerate(words):
        if word["end"] - word["start"] > MAX_CUE_SECONDS:
            raise _invalid_response()
        if index > offset and (
            index - offset >= MAX_CUE_WORDS
            or word["end"] - words[offset]["start"] > MAX_CUE_SECONDS
        ):
            segments.append(_cue(words[offset:index]))
            offset = index
    segments.append(_cue(words[offset:]))
    return segments


def _normalize(body: bytes, duration: float) -> list[dict[str, Any]]:
    try:
        payload = json.loads(body)
    except (ValueError, UnicodeError, RecursionError):
        raise _invalid_response() from None
    if not isinstance(payload, dict) or not isinstance(payload.get("results"), dict):
        raise _invalid_response()
    results = payload["results"]
    limit = duration + TIMING_TOLERANCE
    if "utterances" in results:
        return _utterances(results["utterances"], limit)
    channels = results.get("channels")
    if not isinstance(channels, list) or not channels or not isinstance(channels[0], dict):
        raise _invalid_response()
    alternatives = channels[0].get("alternatives")
    if not isinstance(alternatives, list) or not alternatives:
        raise _invalid_response()
    if not isinstance(alternatives[0], dict):
        raise _invalid_response()
    return _group_words(_words(alternatives[0].get("words"), limit))


def _retry_delay(value: str | None, attempt: int) -> float:
    fallback = min(2.0 ** attempt, MAX_RETRY_DELAY)
    if value is None:
        return fallback
    try:
        seconds = float(value)
    except (TypeError, ValueError, OverflowError):
        try:
            date = parsedate_to_datetime(value)
            if date.tzinfo is None:
                date = date.replace(tzinfo=timezone.utc)
            seconds = (date - datetime.now(timezone.utc)).total_seconds()
        except (TypeError, ValueError, OverflowError):
            return fallback
    if not math.isfinite(seconds) or seconds < 0:
        return fallback
    return min(seconds, MAX_RETRY_DELAY)


def _default_opener() -> Callable[..., Any]:
    """Opener honouring DEEPGRAM_PROXY: direct uploads from CN networks reset."""
    handlers: list[Any] = [_NoRedirect()]
    proxy = os.environ.get("DEEPGRAM_PROXY", "")
    if proxy:
        handlers.append(ProxyHandler({"http": proxy, "https": proxy}))
    return build_opener(*handlers).open


class DeepgramClient:
    """Upload English audio; retry only explicit HTTP 429 rate-limit responses."""

    def __init__(
        self, api_key: str, *, timeout: float = 180, max_attempts: int = 3,
        opener: Callable[..., Any] | None = None,
        sleep: Callable[[float], Any] | None = None,
    ) -> None:
        if not isinstance(api_key, str) or not api_key or any(
            not 33 <= ord(character) <= 126 for character in api_key
        ):
            raise ValueError("A nonblank API key without whitespace is required.")
        if not _finite_number(timeout) or timeout <= 0:
            raise ValueError("Timeout must be finite and positive.")
        if type(max_attempts) is not int or not 1 <= max_attempts <= MAX_ATTEMPTS:
            raise ValueError("Attempt count must be an integer from 1 through 10.")
        if opener is not None and not callable(opener):
            raise TypeError("The HTTP opener must be callable.")
        if sleep is not None and not callable(sleep):
            raise TypeError("The sleep callback must be callable.")
        self._api_key = api_key
        self._timeout = float(timeout)
        self._max_attempts = max_attempts
        self._opener = _default_opener() if opener is None else opener
        self._sleep = time.sleep if sleep is None else sleep

    def _upload(self, audio_path: Path) -> bytes:
        try:
            audio = audio_path.open("rb")
        except OSError:
            raise DeepgramError("The audio file could not be opened.") from None
        with audio:
            try:
                size = os.fstat(audio.fileno()).st_size
            except OSError:
                raise DeepgramError("The audio file could not be inspected.") from None
            if size <= 0:
                raise DeepgramError("The audio file is empty.")
            request = Request(
                LISTEN_URL, data=audio, method="POST", headers={
                    "Authorization": f"Token {self._api_key}",
                    "Content-Type": AUDIO_MIME_TYPES.get(
                        audio_path.suffix.lower(), "application/octet-stream"
                    ),
                    "Content-Length": str(size),
                },
            )
            with self._opener(request, timeout=self._timeout) as response:
                return response.read()

    def transcribe(self, audio_path: Path, duration: float) -> list[dict[str, Any]]:
        """Return validated cues, or a sanitized error carrying retry certainty."""
        if not isinstance(audio_path, Path):
            raise DeepgramError("The audio path must be a Path.")
        if not _finite_number(duration) or duration <= 0:
            raise DeepgramError("Audio duration must be finite and positive.")
        for attempt in range(self._max_attempts):
            try:
                body = self._upload(audio_path)
            except HTTPError as error:
                status = error.code
                retry_after = error.headers.get("Retry-After") if error.headers else None
                error.close()
                if status == 429 and attempt + 1 < self._max_attempts:
                    self._sleep(_retry_delay(retry_after, attempt))
                    continue
                raise DeepgramError(
                    "Deepgram rejected the transcription request.",
                    status=status, uncertain=500 <= status <= 599,
                ) from None
            except (URLError, TimeoutError, OSError, HTTPException):
                raise DeepgramError(
                    "Deepgram request completion is unknown; explicit retry is required.",
                    uncertain=True,
                ) from None
            return _normalize(body, float(duration))
        raise DeepgramError("Deepgram rate-limit attempts were exhausted.", status=429)
