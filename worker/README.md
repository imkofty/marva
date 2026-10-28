# MARVA Worker (Cloudflare Workers port)

A port of `../backend/` (Node server) to a Cloudflare Worker. The original
Node backend is untouched; this folder is a separate implementation of
the same job flow, adapted to the Workers runtime.

## What changed vs the Node server

- **No `node:http` server.** The entry point is a `fetch` handler in
  `src/index.mjs` (`POST /jobs`, `GET /jobs/:id`,
  `GET /jobs/:id/events`, `GET /demo/synthetic`).
- **Polling replaces SSE.** The Node server held an SSE stream open in
  one long-lived process. A Worker isolate does not hold state across
  requests, and a true cross-request SSE stream would need Durable
  Objects, which this port deliberately does not use. Instead
  `GET /jobs/:id/events` returns the full event list as JSON, and the
  frontend polls it every 2 seconds and renders new events. The events
  are still real: each one is written to KV only when its stage really
  finishes, fails, or is skipped.
- **Job state in KV, not in memory.** Binding `MARVA_JOBS` (see
  `wrangler.toml`). The stored record never contains manuscript text:
  text is passed to `runJob` in memory only and is stripped before
  every KV write, so a manuscript is processed for that job only.
- **Step-wise execution, NOT `ctx.waitUntil()`.** `ctx.waitUntil()`
  extends execution only up to 30 seconds after the response, which
  kills a 7-stage model pipeline mid-job (first live job: 5 stages
  done, then stuck at journal forever). Instead `POST /jobs` runs
  the Reader stage synchronously (the only stage needing the
  manuscript text, which is never persisted to KV) and returns 201;
  each `GET /jobs/:id/events` poll then advances exactly one stage,
  guarded by an `advancing_until` lock against overlapping polls.
  A stage that fails or times out (model 60s, databases 15s) is
  recorded honestly and the job continues.
- **Key from Worker env, not `process.env`.** `env.MODEL_API_KEY`.
  Without a real key, Reader/Gap/Journal/Supervisor model stages
  report `skipped`, never faked; deterministic matcher, database
  verifier, and the deterministic Supervisor fallback still run.
- **CORS added.** The Node server served the frontend from the same
  origin; the Worker has its own origin, so responses carry
  `Access-Control-Allow-Origin: *` and `OPTIONS` is answered. This is
  a demo setting, not a production CORS policy.
- **PDF extraction needs `nodejs_compat`.** `src/pdf.mjs` uses
  `node:zlib` (enabled by `compatibility_flags = ["nodejs_compat"]`
  in `wrangler.toml`). Scanned-image and encrypted PDFs still cannot
  be read; that limit is reported in `pdf_note`, never papered over.
- **One job at a time, with stale-lock recovery.** A second POST
  while a job is `running` returns 409. If the active job record is
  done, missing, or not updated for 10 minutes, the next POST clears
  the lock. KV puts are not atomic compare-and-swap, so two POSTs in
  the same instant could both pass the lock check — a demo
  limitation, documented in `src/index.mjs`.

## Full job flow (same stages as the plan, now wired)

1. Reader (Spark) — structure, claims, theories, quotes, citations,
   references, method, equations, tables. Skipped without a key.
2. Deterministic citation matcher (code, never a model) — missing /
   uncited / duplicates, exact match after case/whitespace
   normalisation only.
3. Reference Verifier — Crossref by DOI, OpenAlex by title. The
   database decides: `verified` only on a Crossref DOI match,
   `candidate` on an OpenAlex title match, otherwise `flagged` /
   `unresolved`. Wonder escalation runs only for flagged ambiguous
   cases, with `reasoning_effort: "low"`, and a Wonder answer NEVER
   upgrades a reference to `verified`; it is stored separately as
   `wonder_reviewed`.
4. Gap Assessor (Wonder/Spark per prompt) — missing/rival theories,
   outdated references. Skipped without a key; a code fallback lists
   only references older than 20 years for author review.
5. Strengthening search — OpenAlex search for each gap theory
   (max 2 terms, 3 works each), then each candidate re-verified by
   DOI (Crossref) or title (OpenAlex). Unresolved candidates are
   dropped and counted, never recommended. Recommendations carry
   `verification: "verified"` or `"candidate"` only.
6. Journal Matcher (Spark) — top fields with evidence, never one
   locked field. `scopus_indexed_status` is always `"unverified"`
   in this port: the agent classifies fields only, and Scopus status
   must be verified against official sources before it is ever
   shown as indexed.
7. Supervisor / Report Builder (Spark, deterministic fallback without
   a key) — merged diagnostic, must-fix vs nice-to-have fixes.
   The Narrator model is not called inside `runJob` (same as the Node
   server): live-office bubbles are the real stage-event details.

## Export

`GET /jobs/:id` includes `report` (JSON, from `src/export.mjs`).
Export endpoints are wired: `GET /jobs/:id/report.json`,
`GET /jobs/:id/report.html`, `GET /jobs/:id/report.pdf` (text-summary
PDF, same shape as the Node backend), `POST /jobs/:id/confirm
{confirmed:true}` (author-confirmation gate; report carries
`held_until_confirmation` until confirmed), and
`DELETE /jobs/:id` (removes the job record). The report never contains full
manuscript text, a plagiarism percentage, an unverified reference
written as certain, or a journal written as Scopus-indexed when its
status is unverified. Limitations text is always included.

## Synthetic demo

`GET /demo/synthetic` returns the cached diagnostic for the synthetic
manuscript (answer key in `../examples/expected-answers.md`). No job
is created, no key is needed, no model is called. It is labelled
`demo: true, synthetic: true` in the payload.

## KV setup step needed at deploy (already done by the parent)

- Namespace `marva-jobs`, binding `MARVA_JOBS`, id already in
  `wrangler.toml` (Imkofty account). Live Worker:
  `https://marva-backend-worker.imkofty.workers.dev` (workers.dev
  route must be enabled via the subdomain endpoint; a fresh API
  upload leaves it disabled, which surfaces as Cloudflare error
  1042). If the namespace is recreated, update the `id` there and
  redeploy. No secret is stored in this repo.

## What is NOT yet wired

- The `reviewer_simulator` (Wonder) prompt is present in
  `src/agents.mjs` but is not a stage in `runJob`; it is a demo-beat
  option for later, not part of the main flow.
- No search-grounding call: strengthening search uses OpenAlex /
  Crossref directly, not Meta search grounding.
- KV reads are eventually consistent across Cloudflare edges: a
  read immediately after a write (confirm, delete, or a stage save)
  can briefly return the previous version from another edge. The
  frontend polls repeatedly, so it catches up; a single stale read
  is not a lost write.

## Deploy

Live deploy is done by the parent via the Cloudflare API (multipart
script upload + secret + subdomain enable), not by `wrangler deploy`
in this VM, because wrangler auth is not wired to the connector
token. The deploy script lives outside this folder
(`~/workspace/meta-hackathon/cf-worker-deploy.py`); it reads the
Meta key from a 600 file at runtime only to set the Worker secret,
never printing it. Then rebuild the frontend with
`VITE_API_BASE=https://marva-backend-worker.imkofty.workers.dev`
and redeploy to Cloudflare Pages project `marva`.

## Local test

```sh
node --check src/*.mjs
node --test tests/worker.test.mjs
```

`wrangler dev` / miniflare were not available in the build VM, so
local testing is a Node harness with a fake KV and a fake model
fetch (see `tests/worker.test.mjs`). It proves the handler, the
deterministic matcher, the full stage order, and the demo endpoint;
it does NOT prove a real Workers runtime, a real KV namespace, or
real model/database responses — those need the deploy step above.
