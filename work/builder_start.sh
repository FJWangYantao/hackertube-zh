#!/bin/bash
# 启动建库器(systemd 守护:崩溃 30 秒后自动拉起)
sudo systemctl start hackertube-builder && echo started
sudo systemctl status hackertube-builder --no-pager -n 2 | head -6
