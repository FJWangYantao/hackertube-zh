# tools/ 使用说明

字幕站全部数据工具。统一入口是 `pipeline.py`，其余为各阶段实现。

## 统一入口：pipeline.py

把「转写 → 质检 → 建站 → AI 章节」串成一条可断点续跑的流水线：

```bash
# 1. 只看计划（默认，不上传、不下载、不写站点）
python -I tools/pipeline.py --ids-file work/batch_next.txt

# 2. 真正执行（需要 DEEPGRAM_API_KEY；翻译走本地网关）
python -I tools/pipeline.py --ids-file work/batch_next.txt --run

# 3. 中断后从某阶段续跑（之前完成的阶段自动跳过）
python -I tools/pipeline.py --ids-file work/batch_next.txt --run --from-stage check

# 只重跑单个阶段
python -I tools/pipeline.py --ids-file work/batch_next.txt --run --only-stage build
```

阶段顺序：`plan`（校验 id，只读）→ `transcribe`（调 run_hybrid_batch，ASR+翻译+发布字幕）→ `check`（check_subs 质检，加 `--check-fix` 自动修复）→ `build`（build_site，含全文索引）→ `chapters`（make_chapters，仅对已有字幕的视频）。

状态记录在 `work/pipeline/<批次名>.json`，每阶段完成即写入；失败会停在当前阶段并提示续跑命令。额外参数用 `--hybrid-args` 透传给 run_hybrid_batch（如 `--limit 20`）。

## 各阶段工具

| 工具 | 作用 |
|------|------|
| `run_hybrid_batch.py` | 混合 ASR 批处理（本地 whisper + Deepgram），翻译并发池，禁止覆盖发布 |
| `check_subs.py` | 字幕质检：时间轴乱序/重叠、空翻译、语速异常 |
| `build_site.py` | 合并数据集与翻译，生成 `site/data/*.json` 与全文索引 |
| `make_chapters.py` | 调网关生成中文 TL;DR + 时间戳章节 |
| `make_series.py` | 从标题规律挖掘「合集」，生成 `site/data/series.json`（观看页合集导航与按集连播） |
| `subindex.py` | 字幕倒排索引（build_site 内部也会调用） |
| `fetch_subs*.py` / `make_subs.py` / `translate_*.py` | 单步旧入口（勿与混合批处理同时运行） |

设计细节见 [docs/hybrid-pipeline.md](../docs/hybrid-pipeline.md)。
