#!/usr/bin/env python3
"""One-command orchestrator for the full content pipeline.

Chains the existing tools as subprocesses, stage by stage, and records each
completed stage in a per-batch state file so an interrupted run can resume:

    1. plan      validate ids and show what would run (always executed)
    2. transcribe  tools/run_hybrid_batch.py --run --publish  (ASR + translation)
    3. check     tools/check_subs.py          (quality gate; --fix is opt-in)
    4. build     tools/build_site.py          (site data + subtitle index)
    5. chapters  tools/make_chapters.py       (AI outlines for new subtitles)

Default is a read-only plan; --run executes the remaining stages and --from-stage
resumes after an interruption. Each stage is a separate process, so a failed
stage never corrupts the others and can be retried alone.

Usage:
    python -I tools/pipeline.py --ids-file work/batch_next.txt
    python -I tools/pipeline.py --ids-file work/batch_next.txt --run
    python -I tools/pipeline.py --ids-file work/batch_next.txt --run --from-stage check
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
STATE_DIR = ROOT / "work" / "pipeline"
VIDEO_ID = re.compile(r"[A-Za-z0-9_-]{11}\Z")
STAGES = ("plan", "transcribe", "check", "build", "chapters")


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--ids-file", required=True, type=Path,
                        help="one video id per line; # comments allowed")
    parser.add_argument("--name", default="",
                        help="batch name for the state file (default: ids-file stem)")
    parser.add_argument("--run", action="store_true", help="execute; otherwise only print a plan")
    parser.add_argument("--from-stage", choices=STAGES, default="plan",
                        help="resume starting at this stage (completed stages are skipped)")
    parser.add_argument("--only-stage", choices=STAGES, help="run a single stage and exit")
    parser.add_argument("--check-fix", action="store_true",
                        help="pass --fix to check_subs.py (repairs timeline issues)")
    parser.add_argument("--chapters-workers", type=int, default=4)
    parser.add_argument("--hybrid-args", default="",
                        help="extra arguments passed verbatim to run_hybrid_batch.py")
    args = parser.parse_args(argv)
    if args.only_stage:
        args.from_stage = args.only_stage
    return args


def read_ids(path: Path) -> list[str]:
    text = path.read_text(encoding="utf-8-sig")
    ids = [line.split()[0] for line in text.splitlines()
           if line.strip() and not line.lstrip().startswith("#")]
    seen = list(dict.fromkeys(ids))
    bad = [vid for vid in seen if not VIDEO_ID.fullmatch(vid)]
    if bad:
        raise ValueError(f"invalid video id(s) in {path}: {' '.join(bad)}")
    return seen


def state_path(args: argparse.Namespace) -> Path:
    name = args.name or args.ids_file.stem
    return STATE_DIR / f"{name}.json"


def load_state(path: Path) -> dict:
    if not path.exists():
        return {"version": 1, "completed": [], "stages": {}}
    state = json.loads(path.read_text(encoding="utf-8"))
    if state.get("version") != 1 or not isinstance(state.get("completed"), list):
        raise ValueError(f"unrecognized pipeline state in {path}; inspect or delete it")
    return state


def save_state(path: Path, state: dict, stage: str, ok: bool, summary: str) -> dict:
    stages = {**state["stages"], stage: {"ok": ok, "summary": summary[:500]}}
    completed = state["completed"] if stage in state["completed"] else (
        [*state["completed"], stage] if ok else state["completed"])
    updated = {**state, "stages": stages, "completed": completed}
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(updated, ensure_ascii=False, indent=1), encoding="utf-8")
    tmp.replace(path)
    return updated


def run_stage(name: str, command: list[str]) -> tuple[bool, str]:
    print(f"\n=== {name}: {' '.join(command)}\n", flush=True)
    result = subprocess.run(command, cwd=ROOT)
    ok = result.returncode == 0
    print(f"\n=== {name}: {'ok' if ok else 'FAILED'}", flush=True)
    return ok, "exit code " + str(result.returncode)


def stage_commands(args: argparse.Namespace) -> dict[str, list[str]]:
    py = [sys.executable, "-I", "-X", "utf8"]
    hybrid_extra = args.hybrid_args.split() if args.hybrid_args else []
    check = py + [str(ROOT / "tools" / "check_subs.py")]
    if args.check_fix:
        check.append("--fix")
    return {
        "plan": [],  # handled inline; nothing to execute
        "transcribe": py + [str(ROOT / "tools" / "run_hybrid_batch.py"),
                            "--ids-file", str(args.ids_file), "--run", "--publish",
                            *hybrid_extra],
        "check": check,
        "build": py + [str(ROOT / "tools" / "build_site.py")],
        "chapters": py + [str(ROOT / "tools" / "make_chapters.py"),
                          "--vid-file", str(args.ids_file),
                          "--workers", str(args.chapters_workers)],
    }


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    ids = read_ids(args.ids_file)
    pending_subs = [vid for vid in ids
                    if not (ROOT / "site" / "data" / "subs" / f"{vid}.json").exists()]
    spath = state_path(args)
    state = load_state(spath)
    if "plan" not in state["completed"]:
        state = save_state(spath, state, "plan", True,
                           f"{len(ids)} ids, {len(pending_subs)} without subtitles")
    print(f"batch {args.ids_file.stem}: {len(ids)} ids, "
          f"{len(pending_subs)} lacking subtitles (they drive transcribe)")
    print("completed stages:", ", ".join(state["completed"]) or "(none)")
    print("state file:", spath)
    commands = stage_commands(args)
    order = STAGES[STAGES.index(args.from_stage):]
    if not args.run:
        print("\nPLAN (dry run; add --run to execute):")
        for stage in order:
            cmd = commands[stage]
            print(f"  {stage}: {'(inline check)' if not cmd else ' '.join(cmd)}")
        return 0
    for stage in order:
        if stage == "plan":
            continue
        if stage in state["completed"] and not args.only_stage:
            print(f"\n=== {stage}: already completed, skipping (use --from-stage to redo)")
            continue
        command = commands[stage]
        if not command:
            continue
        ok, summary = run_stage(stage, command)
        state = save_state(spath, state, stage, ok, summary)
        if not ok:
            print(f"\nstopped at stage '{stage}'; fix it, then resume with "
                  f"--from-stage {stage}")
            return 1
    print("\npipeline complete; state:", spath)
    return 0


if __name__ == "__main__":
    sys.exit(main())
