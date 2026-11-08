#!/bin/bash
# Finish the remaining backlog: pull all unpulled captions, translate every
# untranslated local VTT, then retry FAILED videos once.
cd /d/360MoveData/Users/asus/Desktop/hackertube || exit 1
start=$(date +%s)
echo "$start" > work/runrest.start
: > work/runrest.progress
echo "START $(date '+%F %T')" >> work/runrest.progress

python -I tools/pull_from_vps.py --limit 500 > work/pullrest.log 2>&1
echo "PULL_DONE $(date '+%F %T')" >> work/runrest.progress

python -I tools/make_subs.py > work/runrest.log 2>&1
echo "PASS1_DONE rc=$? $(date '+%F %T')" >> work/runrest.progress

failed=$(grep 'FAILED' work/runrest.log | sed -E 's/^ +([^:]+): FAILED.*/\1/' | tr '\n' ' ')
if [ -n "$failed" ]; then
  echo "RETRY $failed" >> work/runrest.progress
  python -I tools/make_subs.py --vids $failed > work/runrest_retry.log 2>&1
fi
echo "DONE $(date '+%F %T') elapsed=$(( $(date +%s) - start ))s" >> work/runrest.progress
