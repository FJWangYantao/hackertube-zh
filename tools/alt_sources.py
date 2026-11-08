#!/usr/bin/env python3
"""Inventory non-YouTube-IP caption sources and classify the remaining gap.

The builder on ``tencent`` already holds captions/audio that we may not have
consumed locally.  Before buying proxies or transcript credits, this tool
answers three questions:

1. How many missing videos already have a local/remote source?
2. How many have an official transcript page (TED, Lex Fridman, media.ccc.de)?
3. Which channel buckets remain and therefore need a paid API or ASR?

Usage:
    python -I tools/alt_sources.py inventory
    python -I tools/alt_sources.py plan
    python -I tools/alt_sources.py all
"""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import difflib
import gzip
import hashlib
import html as html_lib
import json
import re
import subprocess
import sys
import time
import urllib.parse
import urllib.request
from collections import Counter
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent.parent
WORK = ROOT / "work" / "alt_sources"
FEED_FILES = (ROOT / "site" / "data" / "feed.json", ROOT / "site" / "data" / "feed-rest.json")
OUT_SUBS = ROOT / "site" / "data" / "subs"
LOCAL_VTT = ROOT / "work" / "subs"
REMOTE = "tencent"
REMOTE_SOURCE = ROOT / "work" / "vps_download_audio.py"

# Channels whose official site usually publishes a transcript or caption file.
# Matching is case-insensitive against the channel name.
OFFICIAL_BUCKETS: tuple[tuple[str, str], ...] = (
    ("TED / TEDx", r"\bted\b|tedx|ted-ed"),
    ("Lex Fridman", r"lex fridman"),
    ("media.ccc.de", r"media\.ccc\.de|chaos computer club|\bccc\b"),
    ("MIT OCW", r"mit opencourseware|mit ocw"),
    ("Stanford Online", r"stanford"),
    ("CppCon", r"cppcon"),
    ("Strange Loop", r"strange loop"),
    ("GOTO Conferences", r"goto conferences"),
    ("PyCon", r"pycon"),
    ("InfoQ", r"infoq"),
    ("Google TechTalks", r"google tech ?talks|talks at google"),
    ("Y Combinator", r"y combinator"),
    ("Computer History Museum", r"computer history museum"),
)

# Hosted transcript APIs are a fallback for everything else.  They do not make
# us fetch YouTube ourselves, but may still be billed per video/minute.
API_BUCKET = "paid transcript API"

REMOTE_CODE = r"""
from pathlib import Path
import json, re
base = Path.home() / "yt_audio"
out = {}
for folder in base.iterdir():
    if not folder.is_dir():
        continue
    ea = folder / "english_audio"
    if not ea.is_dir():
        continue
    vtts = [f for f in ea.glob("captions*.vtt") if f.stat().st_size > 300]
    en = [f for f in vtts if re.search(r"\.en(?:[.-])", f.name)]
    audio = [f for f in ea.iterdir()
             if f.suffix in (".webm", ".m4a", ".mp3", ".opus", ".wav")
             and f.stat().st_size > 0]
    out[folder.name] = {
        "vtt": len(vtts),
        "en": len(en),
        "audio": len(audio),
        "audio_bytes": sum(f.stat().st_size for f in audio),
        "sample_vtt": sorted(f.name for f in vtts[:2]),
    }
print(json.dumps(out, ensure_ascii=False))
"""


def ssh_json() -> dict:
    proc = subprocess.run(
        ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=12", REMOTE, "python3 -I -"],
        input=REMOTE_CODE, capture_output=True, text=True,
        encoding="utf-8", errors="replace", timeout=90,
    )
    if proc.returncode != 0:
        raise SystemExit(f"ssh failed ({proc.returncode}): {proc.stderr.strip()[:300]}")
    return json.loads(proc.stdout)


def load_feed() -> list[dict]:
    rows: list[dict] = []
    for path in FEED_FILES:
        rows.extend(json.loads(path.read_text(encoding="utf-8")))
    return rows


def load_ids(folder: Path, suffix: str) -> set[str]:
    return {p.stem.split(".")[0] for p in folder.glob(f"*{suffix}")}


def bucket_for(channel: str) -> str:
    text = (channel or "").lower()
    for name, pattern in OFFICIAL_BUCKETS:
        if re.search(pattern, text):
            return name
    return API_BUCKET


def cmd_inventory() -> dict:
    WORK.mkdir(parents=True, exist_ok=True)
    inv = ssh_json()
    payload = {
        "generated_at": dt.datetime.now().astimezone().isoformat(timespec="seconds"),
        "remote": REMOTE,
        "source_sha256": (hashlib.sha256(REMOTE_SOURCE.read_bytes()).hexdigest()
                          if REMOTE_SOURCE.exists() else None),
        "videos": inv,
    }
    (WORK / "remote_inventory.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"inventory: {len(inv)} remote video folders -> {WORK / 'remote_inventory.json'}")
    return payload


def cmd_plan() -> None:
    inv_path = WORK / "remote_inventory.json"
    if not inv_path.exists():
        raise SystemExit("run `inventory` first")
    inventory = json.loads(inv_path.read_text(encoding="utf-8"))
    remote = inventory["videos"]
    feed = load_feed()
    published = load_ids(OUT_SUBS, ".json")
    local_vtt = load_ids(LOCAL_VTT, ".vtt")

    missing = [v for v in feed if v["vid"] not in published]
    rows: list[dict] = []
    for v in missing:
        vid = v["vid"]
        r = remote.get(vid, {})
        has_local = vid in local_vtt
        remote_vtt = int(r.get("vtt", 0))
        remote_en = int(r.get("en", 0))
        remote_audio = int(r.get("audio", 0))
        if has_local:
            action, source = "translate_local", "local VTT"
        elif remote_en:
            action, source = "pull_captions", "remote English VTT"
        elif remote_vtt:
            action, source = "pull_non_english", "remote non-English VTT"
        elif remote_audio:
            action, source = "transcribe_audio", "remote audio"
        else:
            action, source = "needs_source", "no cached source"
        bucket = bucket_for(v.get("channel", ""))
        rows.append({
            "vid": vid,
            "channel": v.get("channel", ""),
            "score": v.get("score", 0),
            "title": v.get("title", ""),
            "bucket": bucket,
            "action": action,
            "source": source,
            "remote_vtt": remote_vtt,
            "remote_en": remote_en,
            "remote_audio": remote_audio,
            "has_local_vtt": has_local,
        })

    # Priority: free cached work first, then official-site candidates by score.
    action_rank = {"translate_local": 0, "pull_captions": 1,
                   "pull_non_english": 2, "transcribe_audio": 3, "needs_source": 4}
    rows.sort(key=lambda r: (action_rank[r["action"]], -r["score"]))

    WORK.mkdir(parents=True, exist_ok=True)
    csv_path = WORK / "candidates.csv"
    with csv_path.open("w", encoding="utf-8-sig", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=list(rows[0]) if rows else [])
        writer.writeheader()
        writer.writerows(rows)

    action_counts = Counter(r["action"] for r in rows)
    bucket_counts = Counter(r["bucket"] for r in rows)
    official_rows = [r for r in rows if r["bucket"] != API_BUCKET and r["action"] == "needs_source"]
    official_counts = Counter(r["bucket"] for r in official_rows)
    audio_gb = sum(int(r.get("audio_bytes", 0)) for r in remote.values()) / 1024 ** 3

    lines = [
        "# Alternative caption source coverage",
        "",
        f"- Generated: {inventory.get('generated_at', '')}",
        f"- Feed videos: {len(feed)}; published subtitles: {len(published)}; missing: {len(missing)}",
        f"- Remote inventory: {len(remote)} video folders; {audio_gb:.2f} GB audio cached on {REMOTE}",
        "",
        "## Missing videos by available source",
        "",
        "| Action | Videos | Meaning |",
        "|---|---:|---|",
    ]
    meanings = {
        "translate_local": "VTT already local; only translation remains",
        "pull_captions": "English VTT on tencent; pull and translate",
        "pull_non_english": "Only non-English VTT; needs English or ASR",
        "transcribe_audio": "Audio cached; ASR required",
        "needs_source": "No cached captions/audio; external source needed",
    }
    for action in ("translate_local", "pull_captions", "pull_non_english",
                   "transcribe_audio", "needs_source"):
        lines.append(f"| {action} | {action_counts.get(action, 0)} | {meanings[action]} |")

    lines += ["", "## Missing videos with no cached source, by channel bucket", "",
              "| Bucket | Videos | First step |", "|---|---:|---|"]
    first_step = {
        "TED / TEDx": "match talk page / official transcript",
        "Lex Fridman": "parse episode transcript page",
        "media.ccc.de": "match event page, download SRT/VTT",
        "MIT OCW": "match lecture page, download transcript",
        "paid transcript API": "test native mode on 10-20 videos",
    }
    for name, count in official_counts.most_common():
        lines.append(f"| {name} | {count} | {first_step.get(name, 'check site for transcript')} |")
    api_count = sum(1 for r in rows if r["bucket"] == API_BUCKET and r["action"] == "needs_source")
    lines.append(f"| {API_BUCKET} | {api_count} | paid fallback after free sources |")

    lines += ["", "## Free work available now (top 40 by score)", "",
              "| vid | score | action | channel | title |", "|---|---:|---|---|---|"]
    free = [r for r in rows if r["action"] in ("translate_local", "pull_captions")]
    for r in free[:40]:
        title = r["title"].replace("|", "\\|")[:70]
        channel = r["channel"].replace("|", "\\|")[:28]
        lines.append(f"| `{r['vid']}` | {r['score']:.0f} | {r['action']} | {channel} | {title} |")

    lines += ["", "## Official-source yield", "",
              "| Source | Matched | Written | Status breakdown |", "|---|---:|---:|---|"]
    for filename, label in (("ted_matches.json", "TED"),
                            ("ccc_matches.json", "media.ccc.de"),
                            ("lex_matches.json", "Lex Fridman")):
        path = WORK / filename
        if not path.exists():
            continue
        results = json.loads(path.read_text(encoding="utf-8"))
        counts = Counter(r.get("status") for r in results)
        written = sum(1 for r in results if r.get("written"))
        lines.append(f"| {label} | {counts.get('matched', 0)}/{len(results)} | "
                     f"{written} | {dict(counts)} |")

    (WORK / "coverage.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print("\n".join(lines[:40]))
    print(f"\nfull report: {WORK / 'coverage.md'}")
    print(f"candidate list: {csv_path}")


def curl_bytes(url: str, timeout: int = 60) -> bytes:
    """Download with curl, following the CDN's redirect to a mirror."""
    proc = subprocess.run(
        ["curl", "-sS", "-L", "--fail", "--max-time", str(timeout), url],
        capture_output=True, timeout=timeout + 5)
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.decode("utf-8", "replace")[:300])
    return proc.stdout


def json_request(url: str, timeout: int = 60) -> bytes:
    """Fetch bytes, falling back to the system curl on local TLS-store issues.

    Some sites fail Python's CA bundle on this machine while curl verifies the
    same certificate normally; curl keeps verification enabled (no ``-k``).
    """
    request = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    try:
        return urllib.request.urlopen(request, timeout=timeout).read()
    except Exception as error:
        if "CERTIFICATE_VERIFY_FAILED" not in str(error):
            raise
        proc = subprocess.run(
            ["curl", "-sS", "--fail", "--max-time", str(timeout), url],
            capture_output=True, timeout=timeout + 5)
        if proc.returncode != 0:
            raise RuntimeError(proc.stderr.decode("utf-8", "replace")[:300])
        return proc.stdout


STOP_WORDS = set(
    "the a an of to and is are was were you your how why what with for in on that "
    "this it be may can do does i my we our they their at as by from or not".split()
)


def title_tokens(value: str) -> set[str]:
    """Normalise a YouTube title/slug for fuzzy matching, dropping channel suffix."""
    text = value.split("|")[0]
    text = re.sub(r"[^a-z0-9]", " ", text.lower())
    return {word for word in text.split() if len(word) > 1 and word not in STOP_WORDS}


def ted_sitemap(force: bool = False) -> list[str]:
    WORK.mkdir(parents=True, exist_ok=True)
    cache = WORK / "ted_sitemap.xml"
    if force or not cache.exists():
        raw = json_request("https://www.ted.com/sitemaps/videos.xml.gz", timeout=180)
        cache.write_bytes(gzip.decompress(raw))
    text = cache.read_text(encoding="utf-8", errors="replace")
    return [url for url in re.findall(r"<loc>([^<]+)</loc>", text) if "/talks/" in url]


def ted_candidates() -> list[dict]:
    path = WORK / "candidates.csv"
    if not path.exists():
        raise SystemExit("run `plan` first")
    with path.open(encoding="utf-8-sig") as fh:
        rows = list(csv.DictReader(fh))
    return [r for r in rows if r["bucket"] == "TED / TEDx" and r["action"] == "needs_source"]


def best_slug(title: str, talks: list[str], top: int = 2) -> list[tuple[str, float]]:
    tokens = title_tokens(title)
    scored: list[tuple[float, str]] = []
    for url in talks:
        slug = url.rsplit("/", 1)[-1]
        slug_tokens = title_tokens(slug.replace("_", " "))
        union = tokens | slug_tokens
        if not union:
            continue
        jaccard = len(tokens & slug_tokens) / len(union)
        ratio = difflib.SequenceMatcher(
            None, " ".join(sorted(tokens)), " ".join(sorted(slug_tokens))).ratio()
        scored.append((jaccard * 0.7 + ratio * 0.3, slug))
    scored.sort(reverse=True)
    return scored[:top]


def fetch_ted_talk(slug: str) -> dict:
    url = f"https://www.ted.com/talks/{slug}"
    html = json_request(url, timeout=45).decode("utf-8", "replace")
    match = re.search(
        r'<script id="__NEXT_DATA__" type="application/json">(.*?)</script>', html, re.S)
    if not match:
        raise ValueError("no __NEXT_DATA__")
    page = json.loads(match.group(1))["props"]["pageProps"]
    video = page["videoData"]
    external = (video.get("videoPlayerData") or {}).get("external") or {}
    translation = (page.get("transcriptData") or {}).get("translation") or {}
    language = ((translation.get("language") or {}).get("internalLanguageCode") or "")
    cues = [
        {"time": int(cue["time"]), "text": str(cue.get("text") or "").strip()}
        for paragraph in translation.get("paragraphs") or []
        for cue in paragraph.get("cues") or []
        if int(cue.get("time") or 0) >= 0 and str(cue.get("text") or "").strip()
    ]
    return {
        "slug": slug,
        "title": video.get("title"),
        "youtube_id": external.get("code"),
        "duration_ms": int(video.get("duration") or 0) * 1000,
        "language": language,
        "cues": cues,
    }


def vtt_timestamp(ms: int) -> str:
    ms = max(0, int(ms))
    hours, rest = divmod(ms, 3_600_000)
    minutes, rest = divmod(rest, 60_000)
    seconds, millis = divmod(rest, 1_000)
    return f"{hours:02d}:{minutes:02d}:{seconds:02d}.{millis:03d}"


def write_vtt(vid: str, talk: dict) -> Path:
    cues = talk["cues"]
    lines = ["WEBVTT", ""]
    for index, cue in enumerate(cues):
        start = cue["time"]
        end = (cues[index + 1]["time"] if index + 1 < len(cues)
               else max(start + 1000, talk["duration_ms"]))
        if end <= start:
            end = start + 500
        text = re.sub(r"\s+", " ", cue["text"]).strip()
        lines += [f"{vtt_timestamp(start)} --> {vtt_timestamp(end)}", text, ""]
    LOCAL_VTT.mkdir(parents=True, exist_ok=True)
    target = LOCAL_VTT / f"{vid}.en.vtt"
    target.write_text("\n".join(lines), encoding="utf-8")
    return target


def cmd_probe_ted(write: bool, limit: int | None) -> None:
    rows = ted_candidates()
    if limit:
        rows = rows[:limit]
    talks = ted_sitemap()
    print(f"TED sitemap: {len(talks)} talks; candidates: {len(rows)}")
    results: list[dict] = []
    for index, row in enumerate(rows, 1):
        vid = row["vid"]
        outcome = {"vid": vid, "title": row["title"], "status": "no_match"}
        for score, slug in best_slug(row["title"], talks):
            try:
                talk = fetch_ted_talk(slug)
            except Exception as error:  # network/parse failures are per-candidate
                outcome.update(status="fetch_error", error=f"{type(error).__name__}: {error}")
                continue
            if talk["youtube_id"] != vid:
                outcome.update(status="id_mismatch", slug=slug,
                               expected=vid, got=talk["youtube_id"])
                continue
            outcome.update(status="matched", slug=slug, score=round(score, 3),
                           cues=len(talk["cues"]), language=talk["language"])
            if write and talk["cues"]:
                target = write_vtt(vid, talk)
                outcome["written"] = str(target.relative_to(ROOT))
            break
            # Best match is authoritative when its ID matches; otherwise try
            # the next candidate (handles TEDx/title edits).
        results.append(outcome)
        print(f"[{index}/{len(rows)}] {vid} {outcome['status']} {outcome.get('slug', '')}")
        time.sleep(1.0)

    WORK.mkdir(parents=True, exist_ok=True)
    (WORK / "ted_matches.json").write_text(
        json.dumps(results, ensure_ascii=False, indent=1), encoding="utf-8")
    counts = Counter(r["status"] for r in results)
    written = sum(1 for r in results if r.get("written"))
    print(f"\nstatus: {dict(counts)}; vtt written: {written}")


def ccc_candidates() -> list[dict]:
    path = WORK / "candidates.csv"
    if not path.exists():
        raise SystemExit("run `plan` first")
    with path.open(encoding="utf-8-sig") as fh:
        rows = list(csv.DictReader(fh))
    return [r for r in rows if r["bucket"] == "media.ccc.de" and r["action"] == "needs_source"]


def srt_to_vtt(srt: str) -> str:
    """Convert SubRip cues to WebVTT; timestamps only need the comma replaced."""
    text = srt.replace("﻿", "").replace("\r\n", "\n")
    lines = ["WEBVTT", ""]
    for block in re.split(r"\n\s*\n", text.strip()):
        rows = [line for line in block.splitlines() if line.strip()]
        index = next((i for i, line in enumerate(rows) if "-->" in line), None)
        if index is None:
            continue
        timing = rows[index].replace(",", ".")
        body = [line for line in rows[index + 1:] if line.strip()]
        if body:
            lines += [timing, "\n".join(body), ""]
    return "\n".join(lines)


def cmd_probe_ccc(write: bool, limit: int | None) -> None:
    rows = ccc_candidates()
    if limit:
        rows = rows[:limit]
    results: list[dict] = []
    for index, row in enumerate(rows, 1):
        vid = row["vid"]
        query = re.sub(r"^\d+C\d+\s*-\s*", "", row["title"]).split("|")[0].strip()
        queries = [query]
        # CCC event titles usually drop the speaker prefix ("Joanna R.: Talk").
        if ":" in query:
            queries.append(query.split(":", 1)[1].strip())
        outcome = {"vid": vid, "title": row["title"], "query": query, "status": "no_event"}
        event = None
        try:
            for candidate in queries:
                payload = json.loads(json_request(
                    "https://api.media.ccc.de/public/events/search?q="
                    + urllib.parse.quote(candidate), timeout=45))
                events = payload.get("events") or []
                target = candidate.lower().strip()
                event = next(
                    (e for e in events
                     if (e.get("title") or "").lower().strip() == target
                     or target in (e.get("title") or "").lower()),
                    None,
                )
                if event is not None:
                    break
        except Exception as error:
            outcome.update(status="search_error", error=f"{type(error).__name__}: {error}")
            results.append(outcome)
            print(f"[{index}/{len(rows)}] {vid} {outcome['status']}")
            continue
        if event is None:
            results.append(outcome)
            print(f"[{index}/{len(rows)}] {vid} no_event ({query[:50]})")
            time.sleep(0.7)
            continue
        srt_urls = [
            rec.get("recording_url") for rec in event.get("recordings") or []
            if rec.get("mime_type") == "application/x-subrip"
            and str(rec.get("language", "")).lower() in ("eng", "en")
            and rec.get("recording_url")
        ]
        outcome.update(event=event.get("frontend_link"), event_title=event.get("title"),
                       original_language=event.get("original_language"),
                       srt_url=srt_urls[0] if srt_urls else None)
        if not srt_urls:
            outcome["status"] = "no_english_srt"
        else:
            try:
                srt = curl_bytes(srt_urls[0], timeout=60).decode("utf-8", "replace")
                if len(srt) < 100 or "-->" not in srt:
                    raise ValueError(f"short/invalid SRT ({len(srt)} bytes)")
                vtt = srt_to_vtt(srt)
                if write:
                    LOCAL_VTT.mkdir(parents=True, exist_ok=True)
                    target_path = LOCAL_VTT / f"{vid}.en.vtt"
                    target_path.write_text(vtt, encoding="utf-8")
                    outcome["written"] = str(target_path.relative_to(ROOT))
                outcome.update(status="matched", cues=vtt.count("-->"))
            except Exception as error:
                outcome.update(status="download_error",
                               error=f"{type(error).__name__}: {error}")
        results.append(outcome)
        print(f"[{index}/{len(rows)}] {vid} {outcome['status']} "
              f"{outcome.get('event_title', '')[:55]}")
        time.sleep(0.7)

    WORK.mkdir(parents=True, exist_ok=True)
    (WORK / "ccc_matches.json").write_text(
        json.dumps(results, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"\nstatus: {dict(Counter(r['status'] for r in results))}; "
          f"vtt written: {sum(1 for r in results if r.get('written'))}")


def lex_posts() -> list[str]:
    WORK.mkdir(parents=True, exist_ok=True)
    cache = WORK / "lex_posts.xml"
    if not cache.exists():
        cache.write_bytes(curl_bytes("https://lexfridman.com/post-sitemap.xml", timeout=90))
    text = cache.read_text(encoding="utf-8", errors="replace")
    return re.findall(r"<loc>([^<]+)</loc>", text)


def lex_candidates() -> list[dict]:
    path = WORK / "candidates.csv"
    if not path.exists():
        raise SystemExit("run `plan` first")
    with path.open(encoding="utf-8-sig") as fh:
        rows = list(csv.DictReader(fh))
    return [r for r in rows if r["bucket"] == "Lex Fridman" and r["action"] == "needs_source"]


def split_sentences(text: str) -> list[str]:
    parts = re.split(r"(?<=[.!?])\s+", re.sub(r"\s+", " ", text).strip())
    return [part for part in parts if part]


def lex_transcript_cues(html: str) -> list[dict]:
    """Parse Lex's ts-segment blocks; timestamps are paragraph starts only."""
    blocks = re.findall(
        r'<div class="ts-segment">(.*?)</div>', html, re.S)
    segments: list[tuple[int, str]] = []
    for block in blocks:
        # WordPress escapes the ampersand as &#038;, so match the bare t=.
        stamp = re.search(r"t=(\d+)", block)
        text_match = re.search(r'<span class="ts-text">(.*?)</span>', block, re.S)
        if not stamp or not text_match:
            continue
        raw = re.sub(r"<[^>]+>", " ", text_match.group(1))
        text = re.sub(r"\s+", " ", html_lib.unescape(raw)).strip()
        if text:
            segments.append((int(stamp.group(1)), text))
    # WordPress occasionally repeats a chapter timestamp or emits a segment
    # slightly before the previous one; make starts strictly monotonic so the
    # resulting VTT never runs backwards.
    segments.sort(key=lambda item: item[0])
    monotonic: list[tuple[int, str]] = []
    for start, text in segments:
        if monotonic and start <= monotonic[-1][0]:
            start = monotonic[-1][0] + 1
        monotonic.append((start, text))
    segments = monotonic
    cues: list[dict] = []
    for index, (start, text) in enumerate(segments):
        end = segments[index + 1][0] if index + 1 < len(segments) else start + 30
        if end <= start:
            end = start + 5
        sentences = split_sentences(text)
        weights = [max(1, len(sentence)) for sentence in sentences]
        total = sum(weights)
        cursor = start
        for sentence, weight in zip(sentences, weights):
            span = (end - start) * weight / total
            cues.append({"s": cursor, "e": cursor + span, "en": sentence,
                         "coarse": True})
            cursor += span
    return cues


def write_cues_vtt(vid: str, cues: list[dict], *, coarse: bool) -> Path:
    lines = ["WEBVTT", ""]
    if coarse:
        lines += ["NOTE source=official-transcript timing=coarse", ""]
    for cue in cues:
        lines += [f"{vtt_timestamp(int(cue['s'] * 1000))} --> "
                  f"{vtt_timestamp(int(cue['e'] * 1000))}", cue["en"], ""]
    LOCAL_VTT.mkdir(parents=True, exist_ok=True)
    target = LOCAL_VTT / f"{vid}.en.vtt"
    target.write_text("\n".join(lines), encoding="utf-8")
    return target


def cmd_probe_lex(write: bool, limit: int | None) -> None:
    rows = lex_candidates()
    if limit:
        rows = rows[:limit]
    locs = lex_posts()
    episodes = [url for url in locs if "-transcript" not in url]
    transcripts = {url.rstrip("/") + "/" for url in locs if "-transcript" in url}
    results: list[dict] = []
    for index, row in enumerate(rows, 1):
        vid = row["vid"]
        tokens = title_tokens(row["title"].split("|")[0])
        scored: list[tuple[float, str]] = []
        for url in episodes:
            slug = url.rstrip("/").rsplit("/", 1)[-1]
            slug_tokens = title_tokens(slug.replace("-", " "))
            union = tokens | slug_tokens
            if not union or not (tokens & slug_tokens):
                continue
            jaccard = len(tokens & slug_tokens) / len(union)
            ratio = difflib.SequenceMatcher(
                None, " ".join(sorted(tokens)), " ".join(sorted(slug_tokens))).ratio()
            scored.append((jaccard * 0.7 + ratio * 0.3, url))
        scored.sort(reverse=True)
        outcome = {"vid": vid, "title": row["title"], "status": "no_match"}
        for score, url in scored[:3]:
            try:
                html = curl_bytes(url, timeout=45).decode("utf-8", "replace")
            except Exception as error:
                outcome.update(status="fetch_error",
                               error=f"{type(error).__name__}: {error}")
                continue
            ids = re.findall(r"youtube\.com/embed/([A-Za-z0-9_-]{11})", html)
            if vid not in ids:
                continue
            transcript_url = url.rstrip("/") + "-transcript/"
            outcome.update(episode=url, transcript=transcript_url,
                           available=transcript_url in transcripts, score=round(score, 3))
            if transcript_url not in transcripts:
                outcome["status"] = "no_transcript"
                break
            try:
                transcript_html = curl_bytes(transcript_url, timeout=60).decode(
                    "utf-8", "replace")
                cues = lex_transcript_cues(transcript_html)
            except Exception as error:
                outcome.update(status="transcript_error",
                               error=f"{type(error).__name__}: {error}")
                break
            if not cues:
                outcome.update(status="empty_transcript")
                break
            outcome.update(status="matched", cues=len(cues))
            if write:
                target = write_cues_vtt(vid, cues, coarse=True)
                outcome["written"] = str(target.relative_to(ROOT))
            break
        results.append(outcome)
        print(f"[{index}/{len(rows)}] {vid} {outcome['status']} "
              f"{outcome.get('episode', '')}")
        time.sleep(0.7)

    (WORK / "lex_matches.json").write_text(
        json.dumps(results, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"\nstatus: {dict(Counter(r['status'] for r in results))}; "
          f"vtt written: {sum(1 for r in results if r.get('written'))}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("command",
                        choices=("inventory", "plan", "all", "probe-ted",
                                 "probe-ccc", "probe-lex"))
    parser.add_argument("--write", action="store_true", help="write matched cues to work/subs")
    parser.add_argument("--limit", type=int)
    args = parser.parse_args()
    if args.command in ("inventory", "all"):
        cmd_inventory()
    if args.command in ("plan", "all"):
        cmd_plan()
    if args.command == "probe-ted":
        cmd_probe_ted(args.write, args.limit)
    if args.command == "probe-ccc":
        cmd_probe_ccc(args.write, args.limit)
    if args.command == "probe-lex":
        cmd_probe_lex(args.write, args.limit)


if __name__ == "__main__":
    main()
