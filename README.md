# MARVA — Meta Audit Review Verification for Authors

Pre-submit journal assistant. English-only web app.

What it does, in plain words: an author uploads a manuscript PDF.
MARVA checks citations against the reference list, verifies each
reference against external databases (Crossref, OpenAlex, Scopus
Sources — databases decide truth, models only reason), assesses
gaps and rival theories, matches journals by scope and verified
indexing status, and returns a per-dimension diagnostic plus a
prioritised fix list. The author decides and revises. MARVA does
not write the manuscript, does not guarantee acceptance, and is
not a Turnitin replacement.

Live office view: 7 agents at one table, speech bubbles narrating
real pipeline events, a silent Narrator typing notes. No clickable
detail panels. No plagiarism percentage anywhere.

## Layout

- `frontend/` — English web app: upload view, live office view, final report view.
- `backend/src/` — Node orchestrator + 7 agent modules + deterministic verification.
  - Agents: Reader, Citation Matcher, Reference Verifier, Gap Assessor,
    Journal Matcher, Supervisor + Report Builder, Narrator (silent).
  - `lib/` — deterministic checks (citation matching, DOI/database field
    comparison, journal scope/indexing verification from official sources).
- `docs/` — architecture, honesty limits, how to run.
- `examples/` — synthetic demo manuscripts only. Never a real unpublished manuscript.
- `tests/` — test manuscripts with deliberately planted errors + expected answers.

## Rules that are not negotiable

- Standard mode only, never Contributor. An unpublished manuscript is confidential.
- Manuscript processed for that job only, deleted after the session.
- Every strengthening reference and journal recommendation is verified
  before it is shown as certain; unverified stays labelled unverified.
- Export: readable report (PDF/printable) + structured JSON, recommendations
  included, full manuscript text never included.
- One job at a time for the demo. Secrets only via environment variables.
  No real manuscript, key, or secret is ever committed to the public repo.

## Status

Build started 2026-10-27, from the agreed core + mockup + architecture
diagram. Skeleton only in this first step; pipeline code follows in
small, tested steps, one agent at a time.
