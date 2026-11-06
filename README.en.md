# dsh-tube-insight

> Turn YouTube videos into **citable, archivable, searchable notes** inside DeepSeek Harness: fetch captions → merge them into readable timestamped paragraphs → search across every video you have fetched → build a cited evidence brief → analyze in the current session → export cited Markdown.

Ported from [rubyzhao666/tube-insight](https://github.com/rubyzhao666/tube-insight) (MIT, by Zara Zhang) into a DSH plugin. The upstream is a Chrome extension (side panel + Supadata + a second LLM API key). This plugin moves the deterministic work to the DSH host (fetch, segment, cache, export) and **lets the session model do the analysis and writing** — no second API key, no double billing.

## What it does

- **Fetch captions**: `tube_transcript` accepts a YouTube URL/ID and returns title, channel, duration, caption language (native/auto-generated), paragraph count, chapters, cache paths and a short preview. No Chrome extension, no browser needed.
- **Readable segmentation**: raw caption lines are merged into complete sentences and paragraphs (splitting on pauses >2s, sentence punctuation, and length limits), each keeping its start second; a `[MM:SS]` Markdown copy is written for the model to `read`.
- **Chapter parsing**: parses `00:00 Title` timestamps from the video description (only when at least two are found).
- **Export**: `tube_export` turns model-written Markdown into a file with YAML frontmatter and a trailing `## 来源` (Sources) section of `youtu.be/<id>?t=<sec>` links, then updates an `index.md` grouped by module.
- **Cross-video search** (0.2.0): `tube_search` searches the transcripts of **all videos you have previously fetched** (BM25 + contiguous-phrase boost, English/CJK tokenization) and returns the video, `[MM:SS]` timestamp, original snippet and a jump link — for "what did the videos I watched say about X?" and topic reviews. It searches the local cache only, never the whole web.
- **Topic brief** (0.3.0): `tube_synthesis` runs 1–7 search terms (`query` + `queries`) over your cached videos, merges/dedupes by (video, timestamp), groups by video and trims the result — returning a fixed-structure **evidence brief** (every item with `[MM:SS]` and a jump link, plus zero-hit videos and coverage stats). Pass `dir` to save it as Markdown with frontmatter (module=knowledge), a sources block and an updated `index.md`; the model writes the review from the brief without copying citations by hand.
- **Bundled skill**: the `tube-insight` skill ships overview / intel / insights / prd / compare / knowledge / translation workflows plus citation rules.

Limits: caption-only (native or auto-generated) — no ASR transcription; private/restricted videos are rejected with an actionable error.

## Install

This is a pure ESM, zero-runtime-dependency DSH bundle. Install the local directory:

```
plugin_manager { action: "install_bundle", target: "<absolute path to this directory>" }
```

Or add the local directory from the DSH Plugins UI. After installation you should see four tools — `tube_transcript`, `tube_search`, `tube_synthesis`, `tube_export` — and the `tube-insight` skill.

Requirements: Node.js `^22.19.0 || >=24.0.0`, DSH `>=0.2.1-rc.2 <0.3.0`. No Chrome extension and no Supadata key are required for native captions (Supadata is an optional fallback only).

## Usage

Just talk to the agent:

- "What is this video about: https://www.youtube.com/watch?v=zjkBMFhNj_g"
- "Turn this video into a product-intel note / insights note / PRD draft"
- "Compare these two videos and save the result to <workspace path>"
- "Export that as Markdown into <absolute directory>"
- **Recall**: "In the videos I watched before, what was said about LLM training data?" → the model calls `tube_search`, gets timestamped quotes, and `read`s the cached transcript of any hit that needs expanding.
- **Topic review**: "Search everything I have cached about pricing / model evaluation and turn it into one knowledge card" → `tube_search` for evidence → skill workflow → `tube_export` (module=knowledge or insights).
- **Write a topic review**: "Turn what the videos I watched say about AI products into one review" → `tube_synthesis` gathers the evidence brief in one call (optionally saved to disk) → the model writes the review (consensus / disagreements / gaps) using the brief links as-is.

The model calls the tools first, then follows the bundled skill workflow. `tube_search` **only searches videos you have already fetched with `tube_transcript`**: an empty cache produces an actionable error telling you to fetch a video first; it never searches the whole web.

### Tool signatures

`tube_transcript`

| Parameter | Type | Description |
|---|---|---|
| `video` | string, required | YouTube URL or 11-char video ID |
| `languages` | string[], optional | Caption language priority, default `["en","zh-Hans","zh","ja"]` |
| `refresh` | boolean, default false | Ignore the cache and refetch |
| `format` | `segments` \| `text`, default segments | Format of the inline body: timestamped lines / plain text |
| `inline` | boolean, default false | Put the full transcript in the tool result (capped at ~60k chars, truncation is reported); otherwise only preview + paths |

Returns: `videoId, title, channel, durationSeconds, publishedAt?, language, captionKind(native|asr), source, segmentCount, charCount, chapters[], transcriptPath, cacheJsonPath, fetchedAt, cached, preview{head,tail}, inlineText?, truncated?`.

`tube_search` (0.2.0, cross-video retrieval)

| Parameter | Type | Description |
|---|---|---|
| `query` | string, required | Search terms, 1–200 chars, mixed English/Chinese |
| `video` | string, optional | Search only this video (URL or 11-char ID); invalid or uncached IDs error out |
| `since` | string, optional | Only videos cached (`fetchedAt`) on/after this date, ISO `YYYY-MM-DD` |
| `limit` | number, optional | 1–20, default 8 (values >20 are clamped) |
| `context` | number, optional | 0–2, default 1: return up to N segments before/after as `before`/`after` |

Returns: `query, scannedVideos, matchedVideos, resultCount, scannedSegments, elapsedMs, results[], truncated?, skippedCacheFiles?`; each result has `videoId, title, channel, url, startSeconds, timestamp, link, text, score, matchedTerms, before?, after?`. Scoring uses BM25 (k1=1.2, b=0.75) plus a ×1.8 boost for a contiguous query phrase; English matches by word, Chinese/CJK by character bigram. When the cache holds more than 500 videos only the 500 most recent are scanned (`truncated: true`); corrupt cache files are skipped without failing.

`tube_synthesis` (0.3.0, search → evidence brief)

| Parameter | Type | Description |
|---|---|---|
| `query` | string, required | Topic/main search term, 1–200 chars; also used as brief title and filename |
| `queries` | string[], optional | 0–6 extra search terms (merged/deduped with query, each searched once) |
| `video` | string, optional | Search only this video (URL or 11-char ID) |
| `since` | string, optional | Only videos cached on/after this date, ISO `YYYY-MM-DD` |
| `limitPerVideo` | number, optional | Max evidence items per video, 1–8, default 4 |
| `maxVideos` | number, optional | Max videos to keep, 1–10, default 10 |
| `dir` | string, optional | Absolute export directory; when given the brief is saved, otherwise only returned |
| `title` | string, optional | Frontmatter title for the saved file (default "主题综述：<query>"); the filename still uses query |

Returns: `query, queries, scannedVideos, scannedSegments, videos[{videoId,title,channel,url,durationSeconds,hits[{timestamp,startSeconds,link,text}]}], coverage{hitVideos,zeroHitVideos,totalHits,queriedTerms}, markdown, path?, indexpath?, bytes?`.
Multi-term hits are merged/deduped by (video, timestamp) keeping the higher-scoring copy; videos are ordered by hit count desc with hits ascending by time. No hits plus `dir` is an actionable error and writes nothing; no hits without `dir` returns an empty brief. Brief links come straight from `tube_search` and must be used as-is when writing the review.

`tube_export`

| Parameter | Type | Description |
|---|---|---|
| `videos` | string[], required | 1–10 YouTube URLs/IDs |
| `module` | enum, required | `overview` / `intel` / `insights` / `prd` / `compare` / `knowledge` / `translation` |
| `markdown` | string, required | Model-written body (the plugin does not rewrite it) |
| `title` | string, optional | Title, also used for the filename; defaults to the first video's title |
| `dir` | string, optional | Absolute export directory, default `~/TubeInsight` |
| `notes` | string[], optional | User notes, appended verbatim under "## 我的笔记" |

Returns: `path, indexpath, bytes, title, module, videos[]`.

## Caption sources & fallback chain

Tried in order, moving on only after a failure:

1. **InnerTube IOS** (primary, verified): read `INNERTUBE_API_KEY`/`VISITOR_DATA` from the watch page → call `youtubei/v1/player` with the IOS client → fetch `captionTracks[].baseUrl + &fmt=json3`.
2. **`ytInitialPlayerResponse` from the watch page**: the player response embedded in the same HTML, as a fallback when the InnerTube player call fails (may hit pot checks).
3. **Supadata** (optional, needs a key): `/v1/transcript?mode=native`; videos longer than 20 minutes are handled through async job polling.
4. **yt-dlp** (optional, only if installed): `--write-auto-subs --write-subs --sub-format json3 --skip-download`.

If everything fails, the error lists each step's reason and the next action (retry / configure Supadata / install yt-dlp / try another video). It never silently returns an empty transcript.

Note: the Android/Web clients and legacy `/api/timedtext` are currently unusable (observed 400 / UNPLAYABLE / empty body), so they are not used.

## Configuration

**No configuration is needed for native captions.** Optional keys are read only from environment variables or the config file; the plugin never writes secrets:

| Source | Key | Description |
|---|---|---|
| env | `SUPADATA_API_KEY` | Supadata fallback key (takes precedence) |
| config file | `$DSH_HOME/tube-insight/config.json` | `{"supadataApiKey": "..."}` |
| env | `DSH_TUBE_INSIGHT_YTDLP` | Custom yt-dlp binary path (default `yt-dlp`) |

`$DSH_HOME` defaults to `~/.dsh`.

## Data locations

```
$DSH_HOME/tube-insight/
├── config.json          # optional user config/secrets
├── cache/
│   ├── <videoId>.json   # metadata + semantic paragraphs + chapters (deletable, rebuildable)
│   └── <videoId>.md     # human/model-readable [MM:SS] transcript (read with the read tool)
├── indexes/<hash>.json  # machine-readable bookkeeping for exported index.md files
└── exports/             # artifacts of scripts/smoke.mjs (normal exports go to the dir parameter)
```

Export directories are chosen with the `dir` parameter (default `~/TubeInsight`). Cache entries never expire; `refresh=true` refetches, repeated calls hit the cache first (idempotent).

`tube_search` is **read-only** over `cache/`: it writes no files, makes no network requests and creates no new data directories. When the cache holds more than 500 videos it scans only the 500 most recent (by `fetchedAt`) and reports `truncated: true`; fetch/refresh a video with `tube_transcript` before searching for the latest content.

`tube_synthesis` is read-only by default too; it only writes to the export directory when `dir` is given (reusing the `tube_export` pipeline: frontmatter module=knowledge, sources block, `index.md`, duplicate names numbered).

## Export format

```markdown
---
title: "…"
module: "overview"
generated_at: "2026-11-06T01:43:44.724Z"
generator: "dsh-tube-insight@0.2.0"
source:
  - title: "…"
    channel: "…"
    url: "https://www.youtube.com/watch?v=<id>"
    videoId: "<id>"
    durationSeconds: 3588
---

<model-written body>

## 我的笔记
- …

## 来源

- [Title](https://youtu.be/<id>?t=0) · channel · 59:48
```

Filenames keep CJK characters and alphanumerics, turn spaces into `-`, truncate to 60 chars, then append `_<YYYY-MM-DD>.md`; duplicates get `-2`, `-3`. `index.md` in the same directory groups entries by module and is updated on every export.

## Development & tests

```bash
cd plugins/dsh-tube-insight
node --check lib/index.js
node --test test/*.test.mjs      # fully offline: fake ctx + mocked fetch
npm pack --dry-run               # check the files list
node scripts/smoke.mjs           # real fetch of one video (network), writes under $DSH_HOME/tube-insight/
```

Coverage: plugin shape, tool registration, skill provider (tolerates a missing `skills/` directory), URL parsing, segmentation, chapter parsing, cache round-trip, export format, cross-video search (tokenization / BM25 / phrase boost / video·since·limit·context filters / corrupt-cache skipping / 500-video truncation / performance: 100 videos and 50k segments under 2s), topic briefs (multi-term merge & dedupe / grouping & truncation / fixed structure / frontmatter + index on disk / determinism / error paths), tool happy paths and error paths (no captions / age restriction / network failure / invalid Supadata key / bad arguments).

## Privacy & license

- Talks only to YouTube (and optionally Supadata). No accounts, no telemetry, no upload of user data.
- Persistent data lives in `$DSH_HOME/tube-insight/` and the export directory the user specifies.
- Caption fetching relies on YouTube-internal endpoints and may break when YouTube changes; failures come with actionable errors and fallback advice.

MIT. Upstream [rubyzhao666/tube-insight](https://github.com/rubyzhao666/tube-insight) © 2026 Zara Zhang; DSH plugin port © 2026 rubyzhao666. See [LICENSE](./LICENSE).
