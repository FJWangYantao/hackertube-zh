#!/bin/bash
# tencent 建库器停止(跑完或磁盘暂停)后,拉起本机建库器接棒
VPS_HOST=${HT_VPS_HOST:?set HT_VPS_HOST to the builder server host}
LOG=$HOME/dl_stdout.log
tail -n 3 "$LOG" 2>/dev/null | grep -q "round complete" && exit 0
systemctl is-active --quiet hackertube-builder && exit 0
state=$(ssh -i $HOME/.ssh/id_ed25519 -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10 -o BatchMode=yes "ubuntu@$VPS_HOST" "systemctl is-active hackertube-builder" 2>/dev/null)
if [ "$state" = "inactive" ] || [ "$state" = "failed" ]; then
    sudo systemctl start hackertube-builder && echo "$(date +%m-%d\ %H:%M:%S) takeover: tencent $state, started" >> "$LOG"
fi
