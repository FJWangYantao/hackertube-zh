#!/usr/bin/env python3
"""Pull caption VTTs from the VPS and keep a pull ledger on both ends.

The VPS only knows what it downloaded; it has no idea what we already copied
back. Every successful pull appends a record to ``yt_audio/_pulled.jsonl`` on
the server (and mirrors it locally in ``work/pulled.jsonl``), so a later run —
or a human — can tell what is already here without re-listing local files.

Usage:
    python -I tools/pull_from_vps.py --limit 200
    python -I tools/pull_from_vps.py --status
    python -I tools/pull_from_vps.py --backfill
    python -I tools/pull_from_vps.py --sync-translated
"""

from __future__ import annotations

import argparse
import datetime as dt
import io
import json
import subprocess
import sys
import tarfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
VIDEOS_FILE = ROOT / "data" / "videos.jsonl"
SUBS_DIR = ROOT / "work" / "subs"
OUT_SUBS = ROOT / "site" / "data" / "subs"
STATE_LOCAL = ROOT / "work" / "pulled.jsonl"
REMOTE = "tencent"
STATE_REMOTE = "yt_audio/_pulled.jsonl"
TRANSLATED_REMOTE = "yt_audio/_translated.txt"
HOST_HOME = "/home/ubuntu"


def ssh(args: str, *, input_text: str | None = None) -> str:
    proc = subprocess.run(["ssh", REMOTE, args], input=input_text, capture_output=True,
                          text=True, encoding="utf-8", errors="replace")
    if proc.returncode != 0 and "No such file" not in (proc.stderr or ""):
        raise RuntimeError(f"ssh failed ({proc.returncode}): {proc.stderr.strip()[:200]}")
    return proc.stdout


def remote_caps_list() -> list[str]:
    code = (
        "from pathlib import Path\n"
        "base = Path.home() / 'yt_audio'\n"
        "for p in base.glob('*/english_audio'):\n"
        "    vtts = list(p.glob('captions*.vtt'))\n"
        "    if vtts and max(v.stat().st_size for v in vtts) > 300:\n"
        "        print(p.parent.name)\n"
    )
    return [line.strip() for line in ssh(f"python3 -c {q(code)}").splitlines() if line.strip()]


def remote_audio_list() -> list[str]:
    code = (
        "from pathlib import Path\n"
        "base = Path.home() / 'yt_audio'\n"
        "for p in base.glob('*/english_audio'):\n"
        "    if list(p.glob('audio.*')) and not list(p.glob('captions*.vtt')):\n"
        "        print(p.parent.name)\n"
    )
    return [line.strip() for line in ssh(f"python3 -c {q(code)}").splitlines() if line.strip()]


def q(code: str) -> str:
    """Single-quote a python snippet for the remote shell."""
    return "'" + code.replace("'", "'\"'\"'") + "'"


def read_state() -> dict[str, dict]:
    text = ssh(f"cat {STATE_REMOTE} 2>/dev/null || true")
    state: dict[str, dict] = {}
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            rec = json.loads(line)
        except json.JSONDecodeError:
            continue
        state[rec["vid"]] = rec
    return state


def append_state(records: list[dict]) -> None:
    if not records:
        return
    payload = "".join(json.dumps(r, ensure_ascii=False) + "\n" for r in records)
    ssh(f"cat >> {STATE_REMOTE}", input_text=payload)
    STATE_LOCAL.parent.mkdir(parents=True, exist_ok=True)
    with STATE_LOCAL.open("a", encoding="utf-8") as fh:
        fh.write(payload)


def load_videos() -> dict[str, dict]:
    videos: dict[str, dict] = {}
    with VIDEOS_FILE.open(encoding="utf-8") as fh:
        for line in fh:
            if line.strip():
                v = json.loads(line)
                videos[v["vid"]] = v
    return videos


def normalize(files: list[tuple[str, bytes]], vid: str) -> int:
    """Write the pulled caption files as <vid>.<lang>.vtt; returns file count."""
    saved: set[str] = set()
    extras: list[tuple[int, str, bytes]] = []
    for fname, data in files:
        lang = fname.replace("captions.", "").replace(".vtt", "")
        if lang in ("en", "en-orig", "en-US", "en-GB", "en-CA"):
            (SUBS_DIR / f"{vid}.{lang}.vtt").write_bytes(data)
            saved.add(lang)
        elif lang.startswith("en"):
            extras.append((len(data), lang, data))
    if "en" not in saved and "en-orig" not in saved and extras:
        extras.sort(key=lambda x: x[0], reverse=True)
        (SUBS_DIR / f"{vid}.en.vtt").write_bytes(extras[0][2])
        saved.add("en")
    return len(saved)


def pull(limit: int, force: bool) -> int:
    videos = load_videos()
    state = read_state()
    already_translated = {p.stem for p in OUT_SUBS.glob("*.json")}
    caps = remote_caps_list()
    print(f"server captions: {len(caps)} | already pulled: {len(state)} | "
          f"translated locally: {len(already_translated)}", flush=True)

    todo = [vid for vid in caps if force or vid not in state]
    todo = [vid for vid in todo if vid in videos]
    todo.sort(key=lambda v: (videos[v].get("score", 0), videos[v].get("published_at", "")),
              reverse=True)
    picked = todo[:limit]
    if not picked:
        print("nothing new to pull")
        return 0
    print(f"pulling {len(picked)} vids (untranslated: "
          f"{sum(1 for v in picked if v not in already_translated)})", flush=True)

    SUBS_DIR.mkdir(parents=True, exist_ok=True)
    code = (
        "import sys, tarfile\n"
        "from pathlib import Path\n"
        "vids = sys.argv[1:]\n"
        "base = Path.home() / 'yt_audio'\n"
        "with tarfile.open(fileobj=sys.stdout.buffer, mode='w|') as tar:\n"
        "    for vid in vids:\n"
        "        ea = base / vid / 'english_audio'\n"
        "        if not ea.exists():\n"
        "            continue\n"
        "        for f in ea.glob('captions.*.vtt'):\n"
        "            lang = f.name.replace('captions.', '').replace('.vtt', '')\n"
        "            if lang.startswith('en'):\n"
        "                ti = tar.gettarinfo(str(f), arcname=vid + '/' + f.name)\n"
        "                with open(f, 'rb') as fp:\n"
        "                    tar.addfile(ti, fp)\n"
    )
    remote_cmd = f"python3 -c {q(code)} " + " ".join(picked)
    proc = subprocess.run(["ssh", REMOTE, remote_cmd], capture_output=True)
    if proc.returncode != 0:
        raise RuntimeError(f"tar stream failed: {proc.stderr.decode('utf-8', 'replace')[:300]}")

    by_vid: dict[str, list[tuple[str, bytes]]] = {}
    with tarfile.open(fileobj=io.BytesIO(proc.stdout), mode="r|") as tar:
        for member in tar:
            if not member.isfile():
                continue
            parts = member.name.split("/")
            if len(parts) != 2:
                continue
            fobj = tar.extractfile(member)
            if fobj:
                by_vid.setdefault(parts[0], []).append((parts[1], fobj.read()))

    now = dt.datetime.now().astimezone().isoformat(timespec="seconds")
    records: list[dict] = []
    for vid, files in by_vid.items():
        count = normalize(files, vid)
        if not count:
            continue
        records.append({
            "vid": vid,
            "kind": "captions",
            "files": sorted(name for name, _ in files),
            "bytes": sum(len(data) for _, data in files),
            "saved": count,
            "pulled_at": now,
            "translated": (OUT_SUBS / f"{vid}.json").exists(),
        })
    append_state(records)
    print(f"pulled {len(records)}/{len(picked)} vids, ledger appended to "
          f"{STATE_REMOTE} (+ local {STATE_LOCAL})")
    return len(records)


def backfill() -> None:
    """Record caption sets already sitting in work/subs from earlier pulls."""
    state = read_state()
    now = dt.datetime.now().astimezone().isoformat(timespec="seconds")
    records: list[dict] = []
    grouped: dict[str, list[str]] = {}
    for path in SUBS_DIR.glob("*.vtt"):
        vid = path.name.split(".")[0]
        grouped.setdefault(vid, []).append(path.name)
    for vid, names in sorted(grouped.items()):
        if vid in state:
            continue
        records.append({
            "vid": vid,
            "kind": "captions",
            "files": sorted(names),
            "bytes": sum((SUBS_DIR / n).stat().st_size for n in names),
            "saved": len(names),
            "pulled_at": now,
            "translated": (OUT_SUBS / f"{vid}.json").exists(),
            "backfilled": True,
        })
    append_state(records)
    print(f"backfilled {len(records)} vids (already recorded: {len(state)})")


def sync_translated() -> None:
    """Mirror the local translated set onto the server for easy checking."""
    vids = sorted(p.stem for p in OUT_SUBS.glob("*.json"))
    ssh(f"cat > {TRANSLATED_REMOTE}", input_text="\n".join(vids) + "\n")
    print(f"wrote {len(vids)} translated vids to {HOST_HOME}/{TRANSLATED_REMOTE}")


def blocked_vids() -> set[str]:
    """Videos build_site.py removes, so their subtitle JSON never reaches the site."""
    blocklist = ROOT / "tools" / "blocklist.txt"
    if not blocklist.exists():
        return set()
    ids: set[str] = set()
    areas: set[str] = set()
    for line in blocklist.read_text(encoding="utf-8").splitlines():
        entry = line.split("#", 1)[0].strip()
        if not entry:
            continue
        if entry.startswith("area:"):
            areas.add(entry.split(":", 1)[1].strip())
        else:
            ids.add(entry)
    taxonomy = json.loads((ROOT / "data" / "taxonomy.json").read_text(encoding="utf-8"))
    category_area = {}
    for area in taxonomy.get("areas") or []:
        for category in area.get("categories") or []:
            category_area[category.get("name", "")] = area["id"]
    out: set[str] = set()
    for line in VIDEOS_FILE.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        video = json.loads(line)
        vid = video["vid"]
        if vid in ids:
            out.add(vid)
            continue
        categories = [c.get("name", "") for c in video.get("categories") or []]
        area = next((category_area[n] for n in categories if n in category_area), "")
        if area in areas:
            out.add(vid)
    return out


def status() -> None:
    caps = set(remote_caps_list())
    audio = set(remote_audio_list())
    state = read_state()
    translated = {p.stem for p in OUT_SUBS.glob("*.json")}
    pulled = set(state)
    local_caption_vids = {p.name.split(".")[0] for p in SUBS_DIR.glob("*.vtt")}
    pending = pulled - translated
    blocked = pending & blocked_vids()
    print(f"server captions            : {len(caps)}")
    print(f"server audio-only          : {len(audio)}")
    print(f"ledger entries (pulled)    : {len(pulled)}")
    print(f"  local vtt present        : {len(local_caption_vids)}")
    print(f"  translated and on site   : {len(translated & pulled)}")
    print(f"  pulled, not on site      : {len(pending)}"
          f"  (blocklisted {len(blocked)}, still to translate {len(pending - blocked)})")
    print(f"unpulled captions left     : {len(caps - pulled)}")
    missing = local_caption_vids - pulled
    if missing:
        print(f"local vtt without ledger   : {len(missing)}  (run --backfill)")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--limit", type=int, default=200)
    parser.add_argument("--force", action="store_true", help="ignore the ledger")
    parser.add_argument("--status", action="store_true")
    parser.add_argument("--backfill", action="store_true")
    parser.add_argument("--sync-translated", action="store_true")
    args = parser.parse_args()

    if args.status:
        status()
    elif args.backfill:
        backfill()
    elif args.sync_translated:
        sync_translated()
    else:
        pull(args.limit, args.force)


if __name__ == "__main__":
    main()
