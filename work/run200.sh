#!/bin/bash
# Trial: pull captions for 200 more videos, then translate up to 200.
cd /d/360MoveData/Users/asus/Desktop/hackertube || exit 1
start=$(date +%s)
echo "$start" > work/run200.start
: > work/run200.progress
echo "START $(date '+%F %T')" >> work/run200.progress

python -I tools/pull_from_vps.py --limit 240 > work/pull200.log 2>&1
echo "PULL_DONE $(date '+%F %T')" >> work/run200.progress

python -I tools/make_subs.py --limit 200 > work/run200.log 2>&1
rc=$?
echo "DONE rc=$rc $(date '+%F %T') elapsed=$(( $(date +%s) - start ))s" >> work/run200.progress
