#!/bin/bash
# 停止建库器(本地批次要开跑前执行;systemd 不会自动再拉起)
sudo systemctl stop hackertube-builder && echo stopped
