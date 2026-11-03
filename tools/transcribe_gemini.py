#!/usr/bin/env python3
"""Transcribe caption-less videos with Gemini, then translate to Chinese.

The Google AI Studio key is read from work/.gemini_key. Audio is downloaded
with yt-dlp, uploaded through the Gemini Files API, transcribed with sentence
timestamps, and translated with the local magpie gateway.

Usage:
    python -I tools/transcribe_gemini.py --vid-file work/missing_subs.txt
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import make_subs  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
AUDIO_DIR = ROOT / "work" / "audio"
OUT_DIR = ROOT / "site" / "data" / "subs"
KEY_FILE = ROOT / "work" / ".gemini_key"
PROXY = os.environ.get("HT_PROXY", "http://127.0.0.1:7890")
DEFAULT_MODEL = "gemini-3.1-flash-lite"
CHUNK_SECONDS = 600
API = "https://generativelanguage.googleapis.com"
UPLOAD = f"{API}/upload/v1beta/files"

MIME = {
    ".m4a": "audio/mp4",
    ".mp3": "audio/mpeg",
    ".webm": "audio/webm",
    ".ogg": "audio/ogg",
    ".wav": "audio/wav",
}
AUDIO_SUFFIXES = set(MIME)

# Common English function words, used only to spot a non-English audio track.
ENGLISH_WORDS = {
    "the", "and", "to", "of", "a", "in", "that", "is", "it", "you", "for",
    "we", "this", "with", "on", "as", "are", "be", "i", "have", "so", "but",
    "what", "if", "not", "they", "was", "at", "from", "or", "an", "there",
}

PROMPT = (
    "Transcribe this audio verbatim. Output one line per sentence in the format:\n"
    "<start_seconds>\t<end_seconds>\t<sentence text>\n"
    "Use a literal tab between the three fields. Do not output JSON, headers, "
    "comments, numbering or translations. Keep technical terms and names in English."
)


def to_seconds(value) -> float:
    text = str(value).strip()
    if ":" in text:
        total = 0.0
        for part in text.split(":"):
            total = total * 60 + float(part)
        return total
    return float(text)


def parse_segments(text: str) -> list[dict]:
    try:
        data = json.loads(text)
        if isinstance(data, dict):
            data = data.get("segments") or data.get("transcript") or []
        segments = []
        for segment in data:
            if not isinstance(segment, dict) or not segment.get("text"):
                continue
            # Gemini sometimes labels the start field "*" instead of "start".
            start_value = segment.get("start", segment.get("*"))
            end_value = segment.get("end")
            if start_value is None or end_value is None:
                continue
            try:
                start, end = to_seconds(start_value), to_seconds(end_value)
            except (TypeError, ValueError):
                continue
            segments.append({"start": start, "end": end, "text": segment["text"]})
        if segments:
            return segments
    except (ValueError, TypeError):
        pass
    segments = []
    for line in text.splitlines():
        parts = line.split("\t")
        if len(parts) < 3:
            continue
        try:
            start, end = to_seconds(parts[0]), to_seconds(parts[1])
        except ValueError:
            continue
        segment_text = "\t".join(parts[2:]).strip()
        if segment_text:
            segments.append({"start": start, "end": end, "text": segment_text})
    return segments


def normalize(cues: list[dict]) -> list[dict]:
    """Sort by start time and give every cue a positive duration."""
    ordered = sorted(cues, key=lambda cue: cue["s"])
    for index, cue in enumerate(ordered):
        limit = ordered[index + 1]["s"] if index + 1 < len(ordered) else cue["s"] + 4.0
        if cue["e"] <= cue["s"]:
            cue["e"] = cue["s"] + 0.4
        # Trim overlap, but never back to zero when the next cue starts at the
        # same instant as this one.
        if index + 1 < len(ordered) and limit > cue["s"] and cue["e"] > limit:
            cue["e"] = limit
    return ordered


def check_timeline(cues: list[dict]) -> None:
    """Reject transcripts whose timestamps collapsed into a few seconds.

    Gemini occasionally emits a full transcript packed into the opening
    seconds; a human speaker cannot exceed ~6 words per second, so anything
    above that means the timestamps are unusable.
    """
    if not cues:
        raise ValueError("empty transcript")
    span = cues[-1]["e"] - cues[0]["s"]
    words = sum(len(cue["en"].split()) for cue in cues)
    if span <= 0 or (len(cues) >= 10 and words / span > 6):
        raise ValueError(
            f"collapsed timeline: {len(cues)} cues / {words} words in {span:.1f}s")


def check_language(cues: list[dict]) -> None:
    """Reject transcripts that are not English.

    YouTube auto-dubs videos into other languages, and a bare ``bestaudio``
    selector can grab a dub. Translating that dub would quietly ship a
    translation of a translation.
    """
    text = " ".join(cue["en"] for cue in cues[:200])
    letters = re.findall(r"[^\W\d_]", text, re.UNICODE)
    if len(letters) < 200:
        return
    tokens = re.findall(r"[a-zA-Z']+", text.lower())
    # A Hindi, Japanese or Arabic dub has almost no Latin letters at all.
    latin_share = sum(len(token) for token in tokens) / len(letters)
    if latin_share < 0.5:
        raise ValueError(
            f"transcript is not English ({latin_share:.0%} Latin letters); wrong audio track?")
    # A Latin-script dub (Indonesian, Spanish, …) is caught by function words.
    share = sum(1 for token in tokens if token in ENGLISH_WORDS) / len(tokens)
    if share < 0.10:
        raise ValueError(
            f"transcript looks non-English ({share:.0%} common words); wrong audio track?")


def check_coverage(cues: list[dict], duration: float) -> None:
    """Reject transcripts that stop well before the end of the audio."""
    if duration <= 0 or not cues:
        return
    if cues[-1]["e"] < duration * 0.8:
        raise ValueError(
            f"covers only {cues[-1]['e']:.0f}s of {duration:.0f}s")


def opener() -> urllib.request.OpenerDirector:
    return urllib.request.build_opener(
        urllib.request.ProxyHandler({"https": PROXY})
    )


def load_key() -> str:
    return KEY_FILE.read_text(encoding="utf-8").strip()


def find_audio(vid: str) -> Path | None:
    for path in AUDIO_DIR.glob(f"{vid}.*"):
        if path.suffix.lower() in AUDIO_SUFFIXES and path.stat().st_size > 0:
            return path
    return None


def download_audio(vid: str, attempts: int = 3) -> Path | None:
    found = find_audio(vid)
    if found:
        return found
    AUDIO_DIR.mkdir(parents=True, exist_ok=True)
    # YouTube serves auto-dubbed tracks (Indonesian, Hindi, …) alongside the
    # original; a bare "bestaudio" can pick a dub, so prefer an English track.
    cmd = [
        sys.executable, "-m", "yt_dlp", "--proxy", PROXY,
        "-f", ("bestaudio[language^=en][abr<=64]/bestaudio[language^=en]"
               "/bestaudio[abr<=64]/bestaudio"),
        "--no-warnings",
        "-o", str(AUDIO_DIR / "%(id)s.%(ext)s"),
        f"https://www.youtube.com/watch?v={vid}",
    ]
    tail = ""
    for attempt in range(1, attempts + 1):
        proc = subprocess.run(cmd, capture_output=True, text=True,
                              encoding="utf-8", errors="replace")
        found = find_audio(vid)
        if found:
            return found
        lines = (proc.stderr or proc.stdout).strip().splitlines()
        tail = lines[-1][:140] if lines else "no output"
        if attempt < attempts:
            time.sleep(10 * attempt)
    print(f"  {vid}: download failed: {tail}")
    return None


def upload(path: Path, key: str, attempts: int = 5) -> dict:
    client = opener()
    mime = MIME.get(path.suffix.lower(), "audio/mpeg")
    data = path.read_bytes()
    last: Exception | None = None
    for attempt in range(1, attempts + 1):
        try:
            start = f"{UPLOAD}?key={key}"
            body = json.dumps({"file": {"display_name": path.name}}).encode()
            request = urllib.request.Request(start, data=body, method="POST", headers={
                "Content-Type": "application/json",
                "X-Goog-Upload-Protocol": "resumable",
                "X-Goog-Upload-Command": "start",
                "X-Goog-Upload-Header-Content-Length": str(len(data)),
                "X-Goog-Upload-Header-Content-Type": mime,
            })
            with client.open(request, timeout=60) as response:
                upload_url = response.headers["X-Goog-Upload-URL"]
            request = urllib.request.Request(upload_url, data=data, method="POST", headers={
                "Content-Length": str(len(data)),
                "X-Goog-Upload-Offset": "0",
                "X-Goog-Upload-Command": "upload, finalize",
            })
            with client.open(request, timeout=900) as response:
                return json.load(response)["file"]
        except (urllib.error.URLError, TimeoutError, OSError, ValueError,
                KeyError) as exc:
            last = exc
            if attempt < attempts:
                time.sleep(10 * attempt)
    raise last if last else RuntimeError("upload failed")


def transcribe(file: dict, key: str, model: str, attempts: int = 5) -> list[dict]:
    client = opener()
    body = {
        "contents": [{"parts": [
            {"text": PROMPT},
            {"file_data": {"mime_type": file["mimeType"], "file_uri": file["uri"]}},
        ]}],
        "generationConfig": {"responseMimeType": "text/plain"},
    }
    url = f"{API}/v1beta/models/{model}:generateContent?key={key}"
    for attempt in range(1, attempts + 1):
        try:
            request = urllib.request.Request(
                url, data=json.dumps(body).encode(),
                headers={"Content-Type": "application/json"},
            )
            with client.open(request, timeout=900) as response:
                payload = json.load(response)
            text = "".join(
                part.get("text", "")
                for part in payload["candidates"][0]["content"]["parts"]
            )
            text = re.sub(r"^```(?:json)?|```$", "", text.strip(), flags=re.M).strip()
            segments = parse_segments(text)
            if segments:
                return segments
            raise ValueError("no segments parsed")
        except (urllib.error.URLError, TimeoutError, OSError, KeyError,
                IndexError, ValueError):
            if attempt == attempts:
                raise
            # 503s from the shared endpoint can last minutes; back off hard.
            time.sleep(15 * attempt)
    return []


def segments_to_cues(segments: list[dict]) -> list[dict]:
    return normalize([
        {"s": float(segment["start"]), "e": float(segment["end"]),
         "en": str(segment["text"]).strip()}
        for segment in segments
        if isinstance(segment, dict) and segment.get("text")
        and "start" in segment and "end" in segment
    ])


def ffmpeg_exe() -> str | None:
    override = os.environ.get("HT_FFMPEG")
    if override:
        return override
    vendor = ROOT / "work" / "vendor" / "imageio_ffmpeg" / "binaries"
    if vendor.is_dir():
        found = sorted(vendor.glob("ffmpeg*"))
        if found:
            return str(found[0])
    return shutil.which("ffmpeg")


def probe_duration(exe: str, path: Path) -> float:
    proc = subprocess.run([exe, "-hide_banner", "-i", str(path)],
                          capture_output=True, text=True, encoding="utf-8",
                          errors="replace")
    match = re.search(r"Duration: (\d+):(\d+):(\d+\.?\d*)", proc.stderr or "")
    if not match:
        return 0.0
    hours, minutes, seconds = match.groups()
    return int(hours) * 3600 + int(minutes) * 60 + float(seconds)


def transcribe_chunked(vid: str, audio: Path, key: str, model: str,
                       chunk_seconds: int = 600) -> list[dict]:
    """Transcribe in slices so long talks keep usable timestamps."""
    exe = ffmpeg_exe()
    if not exe:
        raise RuntimeError("ffmpeg not found; cannot chunk")
    duration = probe_duration(exe, audio)
    if duration <= 0:
        raise RuntimeError("cannot read audio duration")
    chunk_dir = AUDIO_DIR / "chunks"
    chunk_dir.mkdir(parents=True, exist_ok=True)
    segments: list[dict] = []
    offset = 0.0
    while offset < duration:
        part = chunk_dir / f"{vid}.{int(offset)}{audio.suffix}"
        subprocess.run([
            exe, "-hide_banner", "-loglevel", "error", "-y",
            "-ss", str(offset), "-t", str(chunk_seconds), "-i", str(audio),
            "-c", "copy", str(part),
        ], check=False, capture_output=True)
        if not part.exists() or part.stat().st_size == 0:
            raise RuntimeError(f"ffmpeg produced no audio for {int(offset)}s")
        print(f"  {vid}: chunk {int(offset)}s ({part.stat().st_size // 1024} KiB)")
        file = upload(part, key)
        for attempt in range(2):
            chunk = transcribe(file, key, model)
            try:
                check_timeline(segments_to_cues(chunk))
                break
            except ValueError as exc:
                if attempt == 1:
                    raise RuntimeError(f"chunk at {int(offset)}s: {exc}") from exc
                print(f"  {vid}: chunk at {int(offset)}s collapsed; retrying")
        for segment in chunk:
            segments.append({
                "start": segment["start"] + offset,
                "end": segment["end"] + offset,
                "text": segment["text"],
            })
        part.unlink(missing_ok=True)
        offset += chunk_seconds
    check_gaps(segments, chunk_seconds)
    return segments


def check_gaps(segments: list[dict], chunk_seconds: int) -> None:
    """Reject a merged transcript that is missing a whole slice."""
    ordered = sorted(segments, key=lambda segment: segment["start"])
    limit = chunk_seconds * 0.9
    for previous, current in zip(ordered, ordered[1:]):
        if current["start"] - previous["end"] > limit:
            raise RuntimeError(
                f"gap of {current['start'] - previous['end']:.0f}s at "
                f"{previous['end']:.0f}s; a chunk is missing")


def transcribe_audio(vid: str, audio: Path, key: str, model: str,
                     force_chunks: bool = False) -> list[dict]:
    exe = ffmpeg_exe()
    duration = probe_duration(exe, audio) if exe else 0.0
    if force_chunks:
        segments = transcribe_chunked(vid, audio, key, model, CHUNK_SECONDS)
        cues = segments_to_cues(segments)
        check_language(cues)
        check_timeline(cues)
        check_coverage(cues, duration)
        return segments
    print(f"  {vid}: uploading {audio.name} ({audio.stat().st_size // 1024} KiB)")
    file = upload(audio, key)
    print(f"  {vid}: transcribing with {model}")
    segments = transcribe(file, key, model)
    cues = segments_to_cues(segments)
    check_language(cues)
    try:
        check_timeline(cues)
        check_coverage(cues, duration)
        return segments
    except ValueError as exc:
        print(f"  {vid}: {exc}; retrying in {CHUNK_SECONDS}s chunks")
    segments = transcribe_chunked(vid, audio, key, model, CHUNK_SECONDS)
    cues = segments_to_cues(segments)
    check_language(cues)
    check_timeline(cues)
    check_coverage(cues, duration)
    return segments


def build(vid: str, key: str, model: str, force: bool,
          force_chunks: bool = False) -> bool:
    out_path = OUT_DIR / f"{vid}.json"
    if out_path.exists() and not force:
        print(f"  {vid}: already translated, skipped")
        return False

    transcript = AUDIO_DIR / f"{vid}.gemini.json"
    if transcript.exists():
        segments = json.loads(transcript.read_text(encoding="utf-8"))
    else:
        audio = download_audio(vid)
        if not audio:
            print(f"  {vid}: no audio (age-restricted or removed)")
            return False
        segments = transcribe_audio(vid, audio, key, model, force_chunks)
        if not segments:
            print(f"  {vid}: empty transcript")
            return False
        transcript.write_text(
            json.dumps(segments, ensure_ascii=False, indent=1), encoding="utf-8")

    cues = segments_to_cues(segments)
    if not cues:
        print(f"  {vid}: no cues")
        return False
    check_timeline(cues)

    groups = make_subs.group_cues(cues)
    print(f"  {vid}: {len(cues)} cues -> {len(groups)} chunks")
    with ThreadPoolExecutor(max_workers=make_subs.WORKERS) as pool:
        translated = [cue for part in pool.map(make_subs.translate_group, groups)
                      for cue in part]

    kept = [cue for cue in translated if cue["zh"].strip()]
    if not kept:
        raise RuntimeError("all cues untranslated")

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    payload = {
        "vid": vid,
        "model": model,
        "source": "gemini",
        "cues": [{"s": round(cue["s"], 2), "e": round(cue["e"], 2),
                  "zh": cue["zh"]} for cue in kept],
    }
    out_path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    print(f"  {vid}: wrote {len(kept)} cues, "
          f"{len(translated) - len(kept)} untranslated dropped")
    return True


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--vid-file", required=True)
    parser.add_argument("--model", default=DEFAULT_MODEL)
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--chunk", action="store_true",
                        help="always transcribe in 10-minute slices")
    args = parser.parse_args()

    make_subs.WORKERS = max(1, args.workers)
    key = load_key()
    vids = Path(args.vid_file).read_text(encoding="utf-8").split()
    if not vids:
        print(f"empty --vid-file: {args.vid_file}")
        return

    done = 0
    for index, vid in enumerate(dict.fromkeys(vids), 1):
        print(f"[{index}/{len(vids)}] {vid}")
        try:
            done += build(vid, key, args.model, args.force, args.chunk)
        except Exception as exc:  # noqa: BLE001 - one bad video must not stop the run
            print(f"  {vid}: FAILED {type(exc).__name__} {exc}")
    print(f"built {done}/{len(vids)}")


if __name__ == "__main__":
    main()
