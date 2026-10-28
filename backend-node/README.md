# MARVA Backend Node Orchestrator

Diagram-exact Node backend for MARVA (Meta Audit Review Verification
for Authors). Built in a NEW folder; the old `backend/` Node server
and the Cloudflare `worker/` are untouched.

## Diagram mapping

| Diagram box | Implementation here |
|---|---|
| Backend Node Orchestrator | `src/server.mjs` — one server, not 7 servers |
| Job Queue (generic) | `src/store.mjs` + server: one job at a time for the demo, 409 while one is active |
| Live Streaming with SSE | `GET /jobs/:id/events` with `Accept: text/event-stream` replays real past events, then streams new ones live; JSON polling is the fallback when SSE is not requested |
| 7-agent pipeline (all Meta models) | `src/run-job.mjs`: Reader, Citation Matcher (deterministic code + prompt kept), Reference Verifier, Gap Assessor, Journal Matcher, Supervisor (Oversight, Quality Gate, Wonder escalation), Narrator bubbles. All Spark except Wonder escalation, Standard mode only, never Contributor |
| Deterministic Verification Layer | `src/lib/citation-matcher.mjs` (code), Crossref by DOI = verified, OpenAlex by title = candidate only |
| Crossref / OpenAlex / Scopus Sources | `src/lib/database.mjs`, `src/lib/journal-evidence.mjs`, `src/lib/scopus.mjs`. Scopus status is ALWAYS "unverified" unless `SCOPUS_API_KEY` is set and the Scopus API really returns a matching serial record |
| Per-dimension Diagnostic Report | Dimensions Clarity, Rigor, Novelty, References, Suitability, mapped from real findings only (`src/lib/dimensions.mjs`); a dimension with no finding is returned empty with an explicit note, never invented |
| Prioritised Fix Recommendations | Supervisor fixes, must-fix vs nice-to-have |
| Verified References | `verifier.verified` = Crossref DOI match only; OpenAlex matches stay candidate |
| Journal Recommendations | Grouped from real OpenAlex works in the classified fields, with scope evidence; never an acceptance prediction |
| Export PDF and JSON | `GET /jobs/:id/report.json`, `GET /jobs/:id/report.html` (printable), `GET /jobs/:id/report.pdf` (stdlib PDF summary) |
| Author Confirmation Gate | `POST /jobs/:id/confirm {confirmed:true}`; the report is held (`held_until_confirmation: true`) until then, and the report says so honestly |
| Manuscript Deleted After Session | `DELETE /jobs/:id` removes the job and its listeners entirely. Manuscript text is never returned by any GET endpoint and never persisted |
| No Secrets | Keys only from env (`MODEL_API_KEY`, `SCOPUS_API_KEY`); no key in code or repo |

## Run

```sh
cd backend-node
node src/server.mjs          # listens on $PORT (default 3001)
npm test                     # node --test tests/backend-node.test.mjs
```

## Endpoints

- `POST /jobs` `{text | citations+references | pdfBase64}` — 50 MB body limit (413 above), 201 `{jobId, status}` or 409 while a job is active
- `GET /jobs/:id/events` — SSE when `Accept: text/event-stream`, JSON `{jobId, status, events}` otherwise
- `GET /jobs/:id` — job state + report, never manuscript text
- `GET /jobs/:id/report.json`, `/report.html`, `/report.pdf`
- `POST /jobs/:id/confirm` `{confirmed:true}`
- `DELETE /jobs/:id`
- `GET /jobs` — real job history (public entries only, never text)
- `GET /demo/synthetic` — cached diagnostic from `examples/expected-answers.md`, no key, no model call

## Honest limits (same as the original backend)

- Without `MODEL_API_KEY`, model stages report `skipped` and the
  deterministic supervisor fallback is used; nothing is faked.
- Scanned-image and encrypted PDFs cannot be read by the stdlib
  extractor; the job records a `pdf_note` instead of inventing text.
- One job at a time, in-memory state: this is demo scale, not a
  production guarantee (KV race note from the Worker does not apply
  here, but a server restart loses in-memory jobs).
