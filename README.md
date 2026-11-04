# HackerTube 数据整理

本地副本，用于离线分析。原站 <https://hackertube.org>，数据导出日期 **2026-10-31**。

## 目录

```
hackertube/
├── download/            原始压缩包（17.8 MB，可删）
│   └── hackertube-data.zip
├── data/                解压后的原始数据（不要手改）
│   ├── videos.jsonl         6,454 个视频
│   ├── mentions.jsonl      39,834 条 HN 评论（含立场标注与原文）
│   ├── related.jsonl        3,778 条视频关联
│   ├── taxonomy.json         16 领域 / 150 主题
│   ├── embeddings.npy        6,454 × 384，float16，已 L2 归一化
│   ├── embedding_ids.json    向量行号 ↔ vid
│   └── DATA.md               上游作者的完整字段说明
├── tools/
│   ├── summarize.py     本仓库的统计脚本（标准库，无需安装依赖）
│   └── DATA.md          上游说明的副本
└── reports/             整理产物
    ├── overview.md          概览报告（分布 + Top 25）
    ├── videos.csv           全部 6,454 条，按分数降序
    ├── top_videos.csv       前 200 条
    ├── categories.csv       主题分布
    ├── channels.csv         频道分布（含累计分数）
    └── mentions_by_year.csv 评论年份分布
```

## 几个关键事实

- **分数** `score = 推荐月数 + 0.5 × 有强推荐的月数`，是排序主信号。
- **只有 `stance` 为 `rec` / `strong_rec` 才算推荐**；`reference`、`joke`、`critical` 也会被收录。**1,658 个视频（25.7%）从没被推荐过，只是被引用**，做推荐系统时要决定是否过滤。
- 每个视频最多保留 20 条评论，`hn.mentions` 因此封顶 20。
- `mentions.text` 截断在 1,500 字符，链接被替换为 `[VIDEO]` / `[LINK]`。
- `shelf_life == "news"` 的 407 个视频只在某个事件前后有意义，大多数界面应默认隐藏。
- 有 24 组疑似重复标题（同一演讲被不同 `vid` 上传），按标题归一化去重。

## 重新生成报告

```bash
python -I tools/summarize.py data reports
```

`-I` 会隔离解释器，不把当前目录加入 `sys.path`，避免数据目录里可能的同名模块被意外 import。

## 预览站点

```bash
python -I tools/build_site.py
python -I -m http.server 8765 --bind 127.0.0.1 --directory site
```

打开 <http://127.0.0.1:8765/>。前端使用原生 ES modules，必须通过 HTTP 访问，直接双击 `index.html` 无法加载数据。

`build_site.py` 会额外生成 `site/data/feed.json`（首页前 600 条）、`feed-rest.json`（其余条目，首屏渲染后后台加载）、`related.json`（相关视频）和 `meta.json`（领域中文名与评论计数）。`site/data/comments/` 仍由 `translate_comments.py` 单独生成，不会被覆盖。

### 屏蔽某些视频

`tools/blocklist.txt` 每行一个 video id（`#` 之后是注释）。`build_site.py` 会在生成前过滤掉这些视频，并从 `feed.json`、`related.json` 和评论计数里一并移除。删掉对应行再重新构建即可恢复。

## 中文字幕

观看页支持站内中文字幕：播放器底部叠加同步字幕，简介下方提供可点击跳转的「字幕文稿」面板。字幕按钮三态循环：**字幕 关 → 字幕 中 → 字幕 中英**，选择存在 `localStorage`；「字幕文稿」始终中英对照。

字幕按视频拆分为 `site/data/subs/<vid>.json`，点开观看页时才加载：

```json
{ "vid": "…", "model": "…", "source": "….en.vtt",
  "cues": [{ "s": 0.0, "e": 10.92, "zh": "…", "en": "…" }] }
```

生成分两步（都需要外网，`HT_PROXY` 默认 `http://127.0.0.1:7890`）：

```bash
# 1. 抓英文字幕到 work/subs/（--workers 并发，已缓存的自动跳过）
python -I tools/fetch_subs.py --limit 200 --workers 4 --sleep 0.5

# 2. 翻译成中文（--all 读 work/picked.json；也可 --vid-file 指定列表）
python -I tools/make_subs.py --all --workers 8

# 3. 校验时间轴（--fix 会排序、补零时长、删空句）
python -I tools/check_subs.py

# 4. 给已有字幕补英文原文（按起始时间对齐，不重新翻译）
python -I tools/add_english.py
```

`make_subs.py` 调用本地网关 `http://127.0.0.1:3425/v1/chat/completions`，默认模型 `workbuddy-vps/cn:deepseek-v4.1-flash`，可用 `--model` 换成其他上游并行跑。没有英文字幕的视频会被跳过。

### 没有英文字幕的视频

对 YouTube 没有英文字幕的视频，用 Google AI Studio 的 Gemini 做语音转写，再复用上面的翻译逻辑：

1. 把 API key 写到 `work/.gemini_key`（已 gitignore，不要提交）。
2. 运行：

```bash
python -I tools/transcribe_gemini.py --vid-file work/missing_subs.txt
```

脚本会用 yt-dlp 下载 m4a（走 `HT_PROXY`），通过 Gemini Files API 上传，用 `gemini-3.1-flash-lite` 返回 `{start, end, text}` 分句，再调用本地网关翻译并写入 `site/data/subs/<vid>.json`。转写结果缓存在 `work/audio/<vid>.gemini.json`，可重复翻译而不必重新转写。年龄限制或已删除的视频拿不到音频，会被跳过。

长视频整段转写时，Gemini 偶尔会把整篇稿子压进开头几秒（时间轴塌缩）。脚本检测到每秒超过 6 个词就判定为塌缩，改用 ffmpeg 切成 10 分钟片段逐段转写、再按偏移拼回去。ffmpeg 可用 `HT_FFMPEG` 指定路径，或装一份到本地目录：

```bash
python -m pip install --target work/vendor imageio-ffmpeg --no-deps
```

## 语义检索示例

```python
import json, numpy as np

emb = np.load("data/embeddings.npy").astype(np.float32)
ids = json.load(open("data/embedding_ids.json", encoding="utf-8"))
row = {v: i for i, v in enumerate(ids)}

sims = emb @ emb[row["SxdOUGdseq4"]]          # "Simple Made Easy" 的相似视频
print([ids[i] for i in np.argsort(-sims)[1:6]])
```

向量来自 `BAAI/bge-small-en-v1.5`（无指令前缀）。要做**文本**检索，需用同一模型编码查询，不加前缀，归一化后点积。

## 缺失的部分

YouTube 自身的元数据（观看数、时长、发布日期、是否已删除）**不在包内**——YouTube API 条款不允许再分发。需要的话用自己的 YouTube Data API v3 密钥补齐，6,454 个视频约 130 次请求。作者说原始链接中约 6% 的视频已被删除或转为私有。缩略图无需 API：`https://i.ytimg.com/vi/<vid>/hqdefault.jpg`。

## 许可与署名

数据以 **ODC-By 1.0** 发布，可自由使用，但需署名：

- [HackerTube](https://hackertube.org)
- [open-index/hacker-news](https://huggingface.co/datasets/open-index/hacker-news) 数据集

HN 评论版权属于各评论者本人；视频标题与频道名属于创作者。摘要、分类与立场标注由 LLM（Claude Sonnet 5.5）生成，官方估计有「百分之几」的误差，不要当成事实依据。本站与 YouTube、Google、Hacker News、Y Combinator 均无关联。
