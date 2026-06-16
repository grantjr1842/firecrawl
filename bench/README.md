# Bench

Performance and load benchmarks for Firecrawl's self-hosted stack.

## Quick start

Run a scrape benchmark against the 1k-URL corpus shipped in this repo:

```bash
FIRECRAWL_BENCH_CORPUS=apps/api/bench/corpus-1k.json pnpm bench:scrape
```

## Environment variables

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `FIRECRAWL_BENCH_CORPUS` | no | built-in sample | Absolute or repo-relative path to a JSON corpus file. The corpus must be a JSON object of the shape emitted by `seed-bench-corpus.ts` (see `apps/api/bench/corpus-1k.json` for a reference): `{ schema_version, generated_at, seed, count, categories, corpus_id, entries: [{ url, category, source, ... }] }`. When unset, bench scripts fall back to their hard-coded sample set. |
| `FIRECRAWL_BENCH_DURATION` | no | `30` | Wall-clock seconds each benchmark runs before producing a result. |
| `FIRECRAWL_BENCH_CONCURRENCY` | no | `8` | Number of concurrent scrapes/queue jobs/etc. the bench driver issues. |

## Corpus file

A 1,000-URL reference corpus lives at `apps/api/bench/corpus-1k.json`. It is committed as a fixture so operators have a deterministic input for reproducible runs across machines. It spans ten categories (hackernews, wikipedia, news, ecommerce, academic, government, blog, social, documentation, code) and is large enough to amortize cold-start effects.

To regenerate the corpus (requires the seed script — currently internal; see `apps/api/src/scripts/seed-bench-corpus.ts` once it is exposed as a public script), delete `apps/api/bench/corpus-1k.json` and re-run `pnpm seed:bench-corpus`.

## What is not here yet

The `bench:scrape` (and the related `bench:latency`, `bench:queue`, `bench:render`, `bench:cache`) pnpm scripts referenced above are not yet wired into `apps/api/package.json`. Follow-up items:

- Add the `bench:*` script entries to `apps/api/package.json` (see `.audit/recursive-ultracode/RECOMMENDATIONS.md` item #15 sibling entries in `followup-recommendations.js`).
- Add the `bench/scrape-throughput.ts`, `bench/scrape-latency.ts`, `bench/queue-throughput.ts`, `bench/browser-render.ts`, and `bench/cache-hitrate.ts` scripts themselves.
- Add a `Performance benchmarks` section to `SELF_HOST.md` covering how to run, expected baselines on a 1 CPU / 1 GB box, and how to interpret the JSON output each script emits.

Until those scripts land, the `FIRECRAWL_BENCH_CORPUS` env var is a contract the bench driver honors but the driver itself is still pending. Tracking issue: see `.audit/recursive-ultracode/RECOMMENDATIONS.md` #15 (and #1, #5-#9 for the related bench script work).
