# HackerTube data

The data behind [HackerTube](https://hackertube.org): the YouTube videos that Hacker News keeps
telling each other to watch. Use it to build your own UI, recommender, newsletter, analysis, or
anything else. Exported 2026-10-31.

- 6,454 videos, recommended (or at least discussed) on HN between 2007 and 2026
- 39,834 HN comments linking them, each labeled by what the commenter was doing
- 150 topic categories in 16 areas, and the graph of videos that share HN recommenders

## For AI agents: start here

You were probably handed this folder and asked to build something with it (a site, a recommender, a
newsletter, a CLI, an analysis). Everything you need is in these files. No network access or API key
is required, except optionally the YouTube Data API (see "What's not included").

**File map and joins**

| file | one row is | key | joins to |
|---|---|---|---|
| `videos.jsonl` | a video (6,454 rows, best-scored first) | `vid` (11-char YouTube id) | the hub |
| `mentions.jsonl` | an HN comment linking a video (39,834 rows) | `hn_comment_id` + `vid` | `vid` → `videos.vid` |
| `related.jsonl` | a video's co-recommended videos (3,778 rows) | `vid` | `vid`, `related[].vid` → `videos.vid` |
| `taxonomy.json` | the topic tree (16 areas, 150 categories) | category `id` | `videos.categories[].id` |
| `embeddings.npy` | a video's 384-d vector | row index | row `i` ↔ `embedding_ids.json[i]` → `videos.vid` |

**Loading:** all `.jsonl` files are UTF-8, one JSON object per line. They fit in memory (the largest,
`mentions.jsonl`, is ~35 MB). For example, `pandas.read_json(path, lines=True)` or a line-by-line
`json.loads`.

**Things to know before you build**

- `videos.score` is the ranking signal: the number of distinct months HN recommended the video, with
  strong recommendations counting extra. Sort by it for "best of"; sample from it for variety.
- Only `stance` ∈ {`rec`, `strong_rec`} are recommendations. `reference`, `joke` and `critical`
  mentions also exist. About 25% of videos were only cited and never recommended
  (`hn.recommenders == 0`), so decide whether to show those.
- At most 20 mentions per video are included, so `hn.mentions` is capped at 20.
- `mentions.text` is cut at 1,500 characters. Links in it appear as `[VIDEO]` (this video) and `[LINK]`.
- `shelf_life == "news"` marks videos that only matter around one event; most UIs should hide them by
  default.
- Stances, summaries and categories were written by an LLM: good, but expect a few percent of noise.
- Some talks were uploaded twice under different `vid`s with near-identical titles. Dedupe by
  normalized title if that matters.
- Video thumbnails need no API: `https://i.ytimg.com/vi/<vid>/hqdefault.jpg` (the uploader's custom
  thumbnail) or `.../hq2.jpg` (an automatic frame from the middle of the video, which HackerTube
  shows instead). Embed a player with `https://www.youtube-nocookie.com/embed/<vid>`.
- For semantic search, embed the query with the same model: see `embeddings.npy` below.

**Example records** (one of each, long text trimmed)

`videos.jsonl`:
```json
{
 "vid": "fNk_zzaMoSs",
 "url": "https://www.youtube.com/watch?v=fNk_zzaMoSs",
 "title": "Vectors | Chapter 1, Essence of linear algebra",
 "channel": "3Blue1Brown",
 "summary": "The first chapter of 3Blue1Brown's Essence of Linear Algebra series, introducing vectors with animated geometric visuals. It begins a series that builds intuition for linear algebra from the basics.",
 "why_hn": "HN's go-to recommendation for learning linear algebra intuition, repeatedly credited with making concepts click and complementing textbooks.",
 "content_type": "course",
 "level": "intro",
 "shelf_life": "evergreen",
 "primary_topic": "linear algebra",
 "tags": [
  "vectors",
  "linear algebra",
  "visual intuition",
  "3blue1brown",
  "machine learning math"
 ],
 "categories": [
  {
   "id": "pure-mathematics",
   "name": "Pure mathematics",
   "area": "math-theory",
   "area_name": "Mathematics & Theoretical CS"
  },
  {
   "id": "recreational-math",
   "name": "Recreational & visual math",
   "area": "math-theory",
   "area_name": "Mathematics & Theoretical CS"
  }
 ],
 "quote": {
  "text": "the most welcoming and informative introduction to the topic I've ever seen",
  "hn_comment_id": 18679785,
  "year": "2018"
 },
 "hn": {
  "mentions": 20,
  "recommenders": 17,
  "rec_months": 18,
  "strong_recs": 14,
  "stances": {
   "rec": 5,
   "strong_rec": 14,
   "reference": 1
  },
  "first_year": 2018,
  "last_year": 2026
 },
 "score": 25.0
}
```

`mentions.jsonl`:
```json
{
 "hn_comment_id": 18679785,
 "hn_url": "https://news.ycombinator.com/item?id=18679785",
 "vid": "fNk_zzaMoSs",
 "author": "nicebill8",
 "month": "2018-12",
 "story_title": "Introduction to Applied Linear Algebra: Vectors, Matrices, and Least Squares",
 "stance": "strong_rec",
 "why": "Most welcoming and informative intro to linear algebra",
 "quote": "the most welcoming and informative introduction to the topic I've ever seen",
 "text": "The 3B1B series on Linear Algebra is by far the most welcoming and informative introduction to the topic I've ever seen: [VIDEO]"
}
```

## How it was made

1. Every HN comment 2007–2026 (from the
   [open-index/hacker-news](https://huggingface.co/datasets/open-index/hacker-news) archive) was scanned
   for YouTube links. A mention counts only if the comment has at least 100 characters of its own text.
2. A video is included if at least 3 different people mentioned it, in at least 3 different months
   (up to 20 mentions per video are kept, favouring different commenters).
3. Each mention was read by Claude Sonnet 5.5 (with the HN story title for context) and labeled with a
   **stance**, topics, a short "why" and a verbatim quote.
4. Each video got a card written by Claude Sonnet 5.5 from its mentions and YouTube metadata: summary,
   why HN likes it, content type, level, shelf life, topics.
5. Videos were assigned 1–3 categories from a shared taxonomy (drafted by Claude from the data).
6. The whole pipeline was built and coordinated by Claude Opus 5.5 in Claude Code, prompted by
   [@karpathy](https://x.com/karpathy).

LLM labels are good but not perfect: expect a few percent of stances or summaries to be off.

## Files

### `videos.jsonl`: one JSON object per line, best-scored first

| field | meaning |
|---|---|
| `vid`, `url` | YouTube video id and link |
| `title`, `channel` | as shown publicly on YouTube |
| `summary` | 2–3 sentence summary of the video |
| `why_hn` | one sentence on why HN people point others to it (or how HN uses it) |
| `content_type` | talk, lecture, course, documentary, explainer, interview, podcast, tutorial, demo, news, commentary, comedy, music, other |
| `level` | general, intro, intermediate, advanced (weak signal: mostly "general") |
| `shelf_life` | evergreen, dated, news |
| `primary_topic`, `tags` | free-form topic phrase and tags |
| `categories` | 1–3 taxonomy categories, best first: `id`, `name`, `area`, `area_name` |
| `quote` | best pull quote: `text`, `hn_comment_id`, `year` (or null) |
| `hn.mentions` | number of labeled mentions kept (capped at 20) |
| `hn.recommenders` | distinct commenters whose mention was a recommendation |
| `hn.rec_months` | distinct months with at least one recommendation |
| `hn.strong_recs` | number of strong recommendations |
| `hn.stances` | count of mentions per stance |
| `hn.first_year`, `hn.last_year` | span of the mentions |
| `score` | HackerTube's quality score: `rec_months + 0.5 × months with a strong recommendation` |

### `mentions.jsonl`: one labeled HN comment per line

| field | meaning |
|---|---|
| `hn_comment_id`, `hn_url` | the HN comment |
| `vid` | the video it links |
| `author`, `month` | HN username and `YYYY-MM` |
| `story_title` | title of the HN story the thread is under |
| `stance` | `strong_rec` (enthusiastic recommendation), `rec` (points people to it), `reference` (cites it neutrally), `joke` (meme / punchline), `critical` (criticizes or debunks it) |
| `why` | ≤15 words on what a viewer gets from the video, per this comment (empty for jokes/criticism) |
| `quote` | a verbatim excerpt of the comment, checked to occur in it (may be empty) |
| `text` | the comment: HTML stripped, links replaced by `[VIDEO]` (this video) or `[LINK]` (anything else), cut at 1,500 characters |

### `taxonomy.json`

`{"version", "areas": [{"id", "name", "categories": [{"id", "name", "description"}]}]}`. Descriptions
list synonyms and are handy for search.

### `related.jsonl`

`{"vid", "related": [{"vid", "shared_recommenders"}]}`: other videos recommended by the same HN
people, up to 20, most overlap first. 3,778 videos have at least one.

### `embeddings.npy` + `embedding_ids.json`

float16 matrix `[6454, 384]`, L2-normalized, from
[`BAAI/bge-small-en-v1.5`](https://huggingface.co/BAAI/bge-small-en-v1.5) (the quantized ONNX build used by
[fastembed](https://github.com/qdrant/fastembed), `Qdrant/bge-small-en-v1.5-onnx-Q`) over each video's
title, channel, topics, categories, summary and HN "whys". No instruction prefix was used. Row `i` is
video `embedding_ids[i]`.

For semantic search, embed the query with the same model, also without a prefix (that's what
HackerTube does), L2-normalize it, and take dot products. `fastembed`'s
`TextEmbedding("BAAI/bge-small-en-v1.5")` gives matching vectors; the sentence-transformers build of the
same model gives very close ones. Compare rows directly for "similar videos". For better relevance,
rerank the top few dozen hits with a cross-encoder (HackerTube uses `jinaai/jina-reranker-v1-turbo-en`).

```python
import json, numpy as np
emb = np.load("embeddings.npy").astype(np.float32)
ids = json.load(open("embedding_ids.json"))
row = {v: i for i, v in enumerate(ids)}
sims = emb @ emb[row["SxdOUGdseq4"]]          # videos similar to "Simple Made Easy"
print([ids[i] for i in np.argsort(-sims)[1:6]])
```

## What's not included, and how to get it

YouTube's own metadata isn't redistributed, because YouTube's API terms don't allow it: descriptions,
view and like counts, durations, publish dates, YouTube tags, and whether a video has since been
deleted. Thumbnails need no API (see above). For everything else you need a free YouTube Data API key.
All 6,454 videos take about 130 requests, well inside the free daily quota of 10,000 units.

### Steps for the human (about 5 minutes, free, no credit card)

Agents: you can't do these steps yourself. Walk your human through them, then ask them to put the key
in an environment variable (never paste it into code or commit it).

1. Open https://console.cloud.google.com/ and sign in with a Google account.
2. Create a project (top bar → project picker → **New project**). Any name works, e.g. "hackertube-fork".
3. Go to **APIs & Services → Library**, search for **YouTube Data API v3**, and click **Enable**.
4. Go to **APIs & Services → Credentials → Create credentials → API key**, and copy the key.
5. Recommended: click the new key → **API restrictions → Restrict key → YouTube Data API v3** → Save.
   This means the key can't be used for anything else if it leaks.
6. Make the key available to the agent without putting it in a file that might be shared:
   `export YOUTUBE_API_KEY=...` in the shell that will run the fetch.

### Steps for the agent

Call `videos.list` with up to 50 ids per request (1 quota unit each, regardless of how many `part`s you
ask for), and cache the raw responses so you never fetch the same video twice:

```python
# fetch_youtube_meta.py: standard library only. Usage: YOUTUBE_API_KEY=... python fetch_youtube_meta.py
import json, os, time, urllib.parse, urllib.request

key = os.environ["YOUTUBE_API_KEY"]
vids = [json.loads(line)["vid"] for line in open("videos.jsonl")]
out = "youtube_meta.jsonl"
done = set()
if os.path.exists(out):
    done = {json.loads(line)["vid"] for line in open(out)}
todo = [v for v in vids if v not in done]

with open(out, "a") as f:
    for i in range(0, len(todo), 50):
        ids = todo[i:i + 50]
        q = urllib.parse.urlencode({"part": "snippet,contentDetails,statistics,status",
                                    "id": ",".join(ids), "key": key})
        items = json.load(urllib.request.urlopen(f"https://www.googleapis.com/youtube/v3/videos?{q}"))["items"]
        got = {it["id"]: it for it in items}
        for v in ids:  # ids missing from the response were deleted or made private
            f.write(json.dumps({"vid": v, "item": got.get(v)}) + "\n")
        time.sleep(0.2)  # be polite
print("done:", len(vids), "videos")
```

Useful fields in each `item`:
- `snippet.publishedAt`, `snippet.description`, `snippet.tags`
- `contentDetails.duration`: ISO 8601, e.g. `PT1H2M3S`
- `statistics.viewCount`, `statistics.likeCount`
- `status.embeddable`, `status.privacyStatus`

An `item` of `null` means the video is gone; hide it in your UI. HackerTube found about 6% of the
originally linked videos already deleted or private.

Terms to respect: keep the key private; show the data with attribution to YouTube; don't redistribute
it; and refresh what you store from time to time, because YouTube's developer policies expect API data
to be kept current (counts and availability change). See
https://developers.google.com/youtube/terms/developer-policies.

## License and attribution

Released under the [Open Data Commons Attribution License (ODC-By) v1.0](https://opendatacommons.org/licenses/by/1-0/),
like the HN archive it is derived from. Please credit **HackerTube** (https://hackertube.org) and the
[open-index/hacker-news](https://huggingface.co/datasets/open-index/hacker-news) dataset. Hacker News
data is provided by Y Combinator, and comments remain the work of their authors. Video titles and
channel names belong to their creators. Not affiliated with YouTube, Google, Hacker News or Y Combinator.
