# Product Brain RAG

Q&A over Dream11's Product Brain (Notion). Zero servers: the index is a static JSON, retrieval runs in the browser, generation is Claude Sonnet.

```
Notion ──MCP──► corpus/*.md ──► build.py ──► index.json + synonyms.json ──► product-brain-qa.jsx (artifact)
                                                    │
                                              eval/run.py
```

## Layout
- `corpus/` — one Markdown file per Product Brain page, front-matter with `notion_url`, `owner`, `section`. Source of truth for the index. Refresh by re-fetching from Notion.
- `build.py` — heading-based chunker (`##`, falls back to `###` over 800 tokens), heading-path prefix, metadata (`section_type`, `rule_ids`, `has_gap`), BM25 stats, synonym map from the Glossary "Also written as" column. No dependencies.
- `index.json`, `synonyms.json` — built artefacts. Commit them; GitHub Pages serves them.
- `eval/questions.jsonl` — 35 labelled questions. `eval/run.py` — retrieval hit@k, same algorithm as the artifact.
- `product-brain-qa.jsx` — the Claude artifact. Paste into claude.ai as a React artifact, or host anywhere React runs.

## Run
```
python3 build.py        # corpus -> index.json, synonyms.json, prints stats
python3 eval/run.py     # retrieval eval
```
Current: 17 pages, 141 chunks, 326 KB. Retrieval: hit@1 49%, strict hit@5 89%, answerable@5 100% (35 questions).

## Deploy
1. Push this repo to GitHub. Settings → Pages → deploy from `main` / root.
2. In `product-brain-qa.jsx`, set `DEFAULT_INDEX_URL` and `DEFAULT_SYN_URL` to `https://<user>.github.io/<repo>/index.json` and `.../synonyms.json`.
3. Open the artifact, click **Fetch from URL**. If the artifact sandbox blocks the fetch, use **Choose files from disk** and select both JSON files — everything else is identical.

## Refresh
Ask Claude (with the Notion connector) to re-export Product Brain to `corpus/`, run `build.py`, run the eval, commit. Diff `index.json` to see which chunks changed.

## Design notes
- Every rule value lives once, in `corpus/l0-rules.md` (R-01…R-34). Feature docs cite IDs. The retrieval boosts Layer 0 chunks 1.25× so the canonical copy wins.
- Chunks with `has_gap: true` trigger the amber banner in the artifact; the prompt tells Sonnet to say "not established" rather than fill in.
- No dense embeddings, no reranker, no vector DB. Add dense retrieval only if `answerable@5` drops below 85% as the corpus grows.
