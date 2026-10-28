# MARVA — Meta Audit Review Verification for Authors

Pre-submit journal assistant. English-only web app. Built for the
Meta Global AI Developer Hackathon (Indie Developer, solo, theme
"Build for Your World").

What it does, in plain words: an author uploads a manuscript PDF.
MARVA checks citations against the reference list, verifies each
reference against external databases (Crossref and OpenAlex —
databases decide truth, models only reason), assesses gaps and
rival theories, matches journals by scope evidence, and returns a
per-dimension diagnostic plus a prioritised fix list. The author
decides and revises. MARVA does not write the manuscript, does
not guarantee acceptance, and is not a Turnitin replacement.

**Scopus, stated plainly:** there is currently no live Scopus
check in this project. No Scopus API key is configured, so every
journal's Scopus status is reported as `unverified`, never as
indexed. The README must never be read as claiming a Scopus
verification that does not run. Journal recommendations are scope
evidence only (a recent OpenAlex work in a classified field named
that journal), never an acceptance prediction and never a claim
of Scopus indexing.

Live office view: 7 agents at one table, speech bubbles narrating
real pipeline events, a silent Narrator typing notes. No clickable
detail panels. No plagiarism percentage anywhere.

## Live deployment

- Frontend: Cloudflare Pages, project `marva`
  (live at marva-dil.pages.dev).
- Backend: Cloudflare Worker `marva-backend-worker`
  (live at marva-backend-worker.imkofty.workers.dev), KV job state.
- The frontend's API base defaults to the live Worker; `VITE_API_BASE`
  overrides it at build time. There is no fallback to any other host.

## Layout

- `frontend-react/` — React + Vite + Tailwind web app, per the mockup:
  upload view, live meeting room, meeting log, audit progress,
  formatted report view (with raw JSON available), confirm button
  for the author-confirmation gate, export JSON / HTML / PDF, delete.
- `backend-node/` — Node stdlib-only reference backend. Same 7-agent
  pipeline, same honesty rules. Reference only; it is not the live
  backend. Tests 4/4 pass.
- `worker/` — Cloudflare Worker, the LIVE backend. Step-wise pipeline:
  `POST /jobs` runs the Reader only; each `GET /jobs/:id/events`
  poll advances exactly one stage (the Cloudflare `waitUntil`
  30-second cap kills a 7-stage job, so it is never used for the
  pipeline). Endpoints: `POST /jobs`, `GET /jobs/:id`,
  `GET /jobs/:id/events`, `GET /jobs/:id/report.json`,
  `/report.html`, `/report.pdf`, `POST /jobs/:id/confirm`,
  `DELETE /jobs/:id`, `GET /demo/synthetic`. Tests 10/10 pass.
  - Agents: Reader, Citation Matcher, Reference Verifier, Gap Assessor,
    Journal Matcher, Supervisor + Report Builder, Narrator (silent).
  - Citation pipeline (deterministic code, never a model): the PDF
    extractor parses Tj/TJ operators in stream order and marks true
    superscript numbers; the reference list is parsed from the
    document tail (numbered lists keyed by number, author-year
    lists line-based), never supplied by the model; citations are
    scanned from the body only (author-year, bracket ranges/groups,
    marked superscript). The Reader runs chunked over the full body,
    not just the first 20,000 characters. If no reference list is
    found, or a numbered list has neither bracket nor marked
    superscript citations, citation checking is skipped honestly
    and its dimension is not scored — bare numbers are never
    treated as citations. Reference verification: Spark bulk, Wonder
    only for flagged ambiguous cases; a model answer never upgrades
    a reference to "verified". Only a Crossref DOI match is "verified";
    an OpenAlex title match is a "candidate".
- `docs/` — architecture, honesty limits, how to run.
- `examples/` — synthetic demo manuscripts only. Never a real unpublished manuscript.

## Rules that are not negotiable

- Standard mode only, never Contributor. An unpublished manuscript is confidential.
- Manuscript processed for that job only, deleted after the session.
- Every strengthening reference and journal recommendation is verified
  before it is shown as certain; unverified stays labelled unverified.
  When a search fails or no candidate verifies enough, the report
  says so honestly instead of leaving a blank space or inventing one.
- Export: readable report (PDF/printable) + structured JSON, recommendations
  included, full manuscript text never included.
- One job at a time for the demo. Secrets only via environment variables.
  No real manuscript, key, or secret is ever committed to the public repo.
- The final report is held until the author confirms the references
  (`POST /jobs/:id/confirm`); confirmation records the author's review,
  it does not verify a reference or a journal by itself.

## Status

Live since 2026-10-28: frontend on Cloudflare Pages, backend on
Cloudflare Workers, public repo complete. A full live synthetic
job finishes done with a per-dimension diagnostic, citation flags,
prioritised fixes, and a working confirm/delete flow. The mandatory
3-minute demo video is not made yet; that is the remaining
submission item, not a hidden gap.
