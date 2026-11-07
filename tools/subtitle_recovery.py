"""Validate translations and retain resumable progress without publishing subtitles.

The supplied translator owns transport retries and timeouts. This module retries
only semantic failures, using single-cue calls. A checkpoint belongs to one
ordered input (including grouping), model identifier, and validation version.
Use a separate checkpoint path for each concurrent invocation.
"""

from __future__ import annotations

import hashlib
import json
import logging
import math
import os
import tempfile
import time
from collections import deque
from dataclasses import dataclass
from concurrent.futures import FIRST_COMPLETED, Future, ThreadPoolExecutor, wait
from pathlib import Path
from typing import Callable

DEFAULT_TRANSLATION_WORKERS = 6
MAX_TRANSLATION_CHARS = 200
# Chinese runs shorter than English; this ratio only catches runaway output.
TRANSLATION_RATIO = 0.8
VALIDATION_VERSION = 1
# Never valid in a translation, wherever they appear.
_SUSPICIOUS = ("as an ai", "@@@")
# Legal Chinese phrases too; only a leak when the text starts with them or they
# head a line/field, as in an echoed reasoning trace.
_REASONING_HEADINGS = ("分隔符", "思考过程")
_LOG = logging.getLogger(__name__)
Translator = Callable[[list[str]], list[str]]


def translation_limit(source: str | None = None) -> int:
    """Cap length by the source text; Whisper cues are whole paragraphs, not lines."""
    if not source:
        return MAX_TRANSLATION_CHARS
    return max(MAX_TRANSLATION_CHARS, int(len(source) * TRANSLATION_RATIO))


def translation_issue(text: object, source: str | None = None) -> str | None:
    """Return a rejection reason, or None for an acceptable translation."""
    if not isinstance(text, str):
        return "translation must be a string"
    if not text.strip():
        return "blank translation"
    limit = translation_limit(source)
    if len(text) > limit:
        return f"translation exceeds {limit} characters"
    lowered = text.casefold()
    for marker in _SUSPICIOUS:
        if marker in lowered:
            return f"suspicious marker {marker!r}"
    for marker in _REASONING_HEADINGS:
        if _heads_text(lowered, marker):
            return f"suspicious marker {marker!r}"
    return None


def _heads_text(text: str, marker: str) -> bool:
    """True when the marker opens the text or is followed by a colon."""
    start = text.find(marker)
    while start != -1:
        opening = not text[:start].strip(" \t\r\n\"'*#-—")
        after = text[start + len(marker): start + len(marker) + 1]
        if opening or after in (":", "："):
            return True
        start = text.find(marker, start + 1)
    return False


def write_json_atomic(path: Path, payload: object) -> None:
    """Replace JSON only after serialization succeeds; preserve the old file on failure."""
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w", encoding="utf-8", dir=path.parent,
            prefix=f".{path.name}.", suffix=".tmp", delete=False,
        ) as stream:
            temporary = Path(stream.name)
            json.dump(payload, stream, ensure_ascii=False, allow_nan=False)
            stream.flush()
            os.fsync(stream.fileno())
        for attempt in range(5):
            try:
                os.replace(temporary, path)
                break
            except PermissionError:
                # A concurrent reader (e.g. the status dashboard) briefly holds
                # the target open on Windows; back off and try again.
                if attempt == 4:
                    raise
                time.sleep(0.2 * (attempt + 1))
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def _validate_request(
    groups: list[list[dict]], translate: Translator, model: str,
    workers: int, repair_attempts: int,
) -> None:
    if not callable(translate):
        raise TypeError("translate must be callable")
    if not isinstance(model, str) or not model.strip():
        raise ValueError("model must be a nonblank string")
    if type(workers) is not int or workers < 1:
        raise ValueError("workers must be a positive integer")
    if type(repair_attempts) is not int or repair_attempts < 0:
        raise ValueError("repair_attempts must be a nonnegative integer")
    if not isinstance(groups, list) or any(not isinstance(group, list) for group in groups):
        raise ValueError("groups must be a list of cue lists")
    for index, cue in enumerate(cue for group in groups for cue in group):
        if not isinstance(cue, dict) or not {"s", "e", "en"} <= cue.keys():
            raise ValueError(f"cue {index + 1} must contain s, e, en")
        if not isinstance(cue["en"], str) or not cue["en"].strip():
            raise ValueError(f"cue {index + 1} source must be a nonblank string")
        for key in ("s", "e"):
            value = cue[key]
            if type(value) not in (int, float) or not math.isfinite(value):
                raise ValueError(f"cue {index + 1} {key} must be a finite number")


def _identity(groups: list[list[dict]], model: str) -> dict:
    provenance = {"version": VALIDATION_VERSION, "model": model, "groups": groups}
    try:
        encoded = json.dumps(
            provenance, ensure_ascii=False, sort_keys=True, allow_nan=False,
            separators=(",", ":"),
        ).encode("utf-8")
    except (TypeError, ValueError) as exc:
        raise ValueError("input cues must be JSON serializable") from exc
    return {"version": VALIDATION_VERSION, "model": model,
            "fingerprint": hashlib.sha256(encoded).hexdigest()}


def _load_checkpoint(path: Path, identity: dict, sources: list[str]) -> dict[str, str]:
    if not path.exists():
        return {}
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (ValueError, OSError) as exc:
        raise ValueError(f"Cannot read checkpoint {path}: {exc}") from exc
    if not isinstance(payload, dict):
        raise ValueError(f"Malformed checkpoint {path}: expected an object")
    if type(payload.get("version")) is not int or any(
        payload.get(key) != value for key, value in identity.items()
    ):
        raise ValueError(f"checkpoint provenance mismatch at {path}; use a new checkpoint path")
    values = payload.get("translations")
    if not isinstance(values, dict):
        raise ValueError(f"Malformed checkpoint {path}: translations must be an object")
    if any(not key.isascii() or not key.isdigit() or str(int(key)) != key
           or int(key) >= len(sources) for key in values):
        raise ValueError(f"Malformed checkpoint {path}: invalid cue indexes")
    accepted = {}
    for key, value in values.items():
        issue = translation_issue(value, sources[int(key)])
        if issue:
            _LOG.warning("Ignoring checkpoint translation for cue %s: %s", int(key) + 1, issue)
        else:
            accepted[key] = value
    return accepted


def _inspect_output(
    output: object, indexes: list[int], sources: list[str],
) -> tuple[dict[str, str], dict[int, str]]:
    if not isinstance(output, list):
        return {}, {index: "translator output must be a list" for index in indexes}
    if len(output) != len(indexes):
        reason = f"translation count mismatch: expected {len(indexes)}, got {len(output)}"
        return {}, {index: reason for index in indexes}
    valid = {}
    invalid = {}
    for index, text in zip(indexes, output):
        reason = translation_issue(text, sources[index])
        if reason:
            invalid[index] = reason
        else:
            valid[str(index)] = text
    return valid, invalid


def _group_indexes(groups: list[list[dict]], completed: dict[str, str]) -> list[list[int]]:
    batches = []
    offset = 0
    for group in groups:
        missing = [index for index in range(offset, offset + len(group))
                   if str(index) not in completed]
        if missing:
            batches.append(missing)
        offset += len(group)
    return batches


def _result(
    future: Future, indexes: list[int], sources: list[str],
) -> tuple[dict[str, str], dict[int, str], Exception | None]:
    try:
        return (*_inspect_output(future.result(), indexes, sources), None)
    except ValueError as exc:
        return {}, {index: f"invalid translation: {exc}" for index in indexes}, None
    except Exception as exc:
        return {}, {index: f"translator {type(exc).__name__}: {exc}" for index in indexes}, exc


def _collect(
    pool: ThreadPoolExecutor, pending: dict[Future, tuple[list[int], int]],
    cues: list[dict], translate: Translator, checkpoint_path: Path,
    identity: dict, completed: dict[str, str], repair_attempts: int,
) -> dict[str, str]:
    failures: dict[int, str] = {}
    first_error: Exception | None = None
    sources = [cue["en"] for cue in cues]
    while pending:
        finished, _ = wait(pending, return_when=FIRST_COMPLETED)
        for future in finished:
            indexes, attempt = pending.pop(future)
            valid, invalid, error = _result(future, indexes, sources)
            if valid:
                completed = {**completed, **valid}
                write_json_atomic(checkpoint_path, {**identity, "translations": completed})
            if error is not None and first_error is None:
                first_error = error
            for index, reason in invalid.items():
                if error is not None or attempt >= repair_attempts:
                    failures[index] = reason
                else:
                    repair = pool.submit(translate, [cues[index]["en"]])
                    pending[repair] = ([index], attempt + 1)
    if failures:
        write_json_atomic(checkpoint_path, {**identity, "translations": completed})
        details = "; ".join(f"cue {index + 1}: {reason}" for index, reason in sorted(failures.items()))
        raise RuntimeError(
            f"Translation incomplete: {details}. Checkpoint saved to {checkpoint_path}; "
            "resolve the failure and rerun to request only missing cues."
        ) from first_error
    return completed


@dataclass(frozen=True)
class TranslationWork:
    """One callback; owner prevents accidental completion in another session."""

    indexes: tuple[int, ...]
    attempt: int
    owner: object


class RecoverySession:
    """Incremental, threadless recovery owned by a single coordinator.

    A scheduler obtains work with take(), submits it to a shared executor, then
    accepts its result. Semantic repair is queued, never executed recursively.
    The checkpoint schema and identity match translate_with_checkpoint().
    """

    def __init__(
        self, groups: list[list[dict]], checkpoint_path: Path, *, model: str,
        repair_attempts: int = 2,
    ) -> None:
        _validate_request(groups, lambda texts: texts, model, 1, repair_attempts)
        self.path = checkpoint_path
        self.identity = _identity(groups, model)
        self.cues = [dict(cue) for group in groups for cue in group]
        self.sources = [cue["en"] for cue in self.cues]
        self.completed = _load_checkpoint(self.path, self.identity, self.sources)
        self.repair_attempts = repair_attempts
        self._owner = object()
        self._pending = deque(TranslationWork(tuple(indexes), 0, self._owner)
                              for indexes in _group_indexes(groups, self.completed))
        self._active: set[TranslationWork] = set()
        self._failures: dict[int, str] = {}
        write_json_atomic(self.path, {**self.identity, "translations": self.completed})

    @property
    def pending_count(self) -> int:
        return len(self._pending)

    @property
    def done(self) -> bool:
        return not self._pending and not self._active

    def take(self) -> TranslationWork | None:
        if not self._pending:
            return None
        work = self._pending.popleft()
        self._active.add(work)
        return work

    def texts(self, work: TranslationWork) -> list[str]:
        if work not in self._active:
            raise ValueError("work does not belong to this active session")
        return [self.sources[index] for index in work.indexes]

    def accept(
        self, work: TranslationWork, output: object = None, *, error: Exception | None = None,
    ) -> None:
        if work not in self._active:
            raise ValueError("work was already collected or belongs to another session")
        if error is None:
            valid, invalid = _inspect_output(output, list(work.indexes), self.sources)
        else:
            valid, invalid = {}, {index: f"translator {type(error).__name__}"
                                 for index in work.indexes}
        self._active.remove(work)
        self.completed = {**self.completed, **valid}
        transport_failure = error is not None and not isinstance(error, ValueError)
        for index, reason in invalid.items():
            if transport_failure or work.attempt >= self.repair_attempts:
                self._failures = {**self._failures, index: reason}
            else:
                self._pending.append(TranslationWork((index,), work.attempt + 1, self._owner))
        write_json_atomic(self.path, {**self.identity, "translations": self.completed})

    def result(self) -> list[dict]:
        if not self.done:
            raise RuntimeError("Translation incomplete: work is still pending")
        if self._failures:
            raise RuntimeError(f"Translation incomplete: {len(self._failures)} rejected cues; "
                               f"checkpoint saved to {self.path}")
        return [{**cue, "zh": self.completed[str(index)]}
                for index, cue in enumerate(self.cues)]


def translate_with_checkpoint(
    groups: list[list[dict]], checkpoint_path: Path, translate: Translator, *,
    model: str, workers: int = DEFAULT_TRANSLATION_WORKERS, repair_attempts: int = 2,
) -> list[dict]:
    """Translate missing cues, saving validated progress as each call finishes.

    A group gets one initial call; each rejected cue gets at most
    ``repair_attempts`` additional singleton calls. Transport errors are never
    retried here. All submitted calls are drained before a translation error is
    raised, so other successes survive. The callable must supply finite timeouts:
    Python threads cannot interrupt a hung external call.

    Malformed or incompatible checkpoint metadata raises ValueError without
    overwriting it. Invalid cached translations are warned about and recomputed.
    This function writes only its checkpoint; the caller owns final publication.
    """
    _validate_request(groups, translate, model, workers, repair_attempts)
    identity = _identity(groups, model)
    cues = [dict(cue) for group in groups for cue in group]
    completed = _load_checkpoint(checkpoint_path, identity, [cue["en"] for cue in cues])
    write_json_atomic(checkpoint_path, {**identity, "translations": completed})
    batches = _group_indexes(groups, completed)
    if batches:
        with ThreadPoolExecutor(max_workers=workers) as pool:
            pending = {pool.submit(translate, [cues[index]["en"] for index in indexes]):
                       (indexes, 0) for indexes in batches}
            completed = _collect(
                pool, pending, cues, translate, checkpoint_path,
                identity, completed, repair_attempts,
            )
    return [{**cue, "zh": completed[str(index)]} for index, cue in enumerate(cues)]
