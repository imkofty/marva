# MARVA build plan — outline first, code in small steps

Deadline: submission due 4 Nov 2026 9:00 PM ET = 5 Nov 2026 09:00 WIB.
Track: Indie, solo. Theme: Build for Your World.

## Step 1 — skeleton (done 2026-10-27)
Folders + this plan + README. No pipeline yet.

## Step 2 — backend core, no model calls yet
Orchestrator: receive PDF, split text per page/section, task queue,
live event stream (SSE) to frontend, job state in memory for one job.
Deterministic citation matcher (in-text citation vs reference list)
with unit tests on planted-error examples.

## Step 3 — agents, one at a time, each with a test
1. Reader (Spark, structured output)
2. Citation Matcher (Spark + deterministic layer)
3. Reference Verifier (Spark bulk + external database truth layer,
   Wonder only for flagged ambiguous cases)
4. Gap Assessor (Wonder gap reasoning, Spark search, verify before recommending)
5. Journal Matcher (Spark classification, top 3 fields with evidence,
   scope + indexing verification)
6. Supervisor + Report Builder (merge, dedup, resolve conflicts,
   hold report until author confirms references)
7. Narrator (Spark, silent — bubbles for other agents only, numbers unchanged)

## Step 4 — synthetic demo manuscript
English, 8–12 pages, clearly synthetic, one field, planted errors
(missing citation, wrong year, outdated reference, too-strong claim,
undiscussed rival theory) with an expected-answer test file.
One error-heavy variant for demo, one clean variant to prove
the pipeline does not flag indiscriminately.

## Step 5 — frontend
Upload view, live office view (7 colour-coded characters, one table,
natural gazes, narrator typing silently, bubbles + meeting log),
final report view, export PDF + JSON.

## Step 6 — hosting + demo proof
Frontend on Pages or Vercel, backend Node on Railway or Render
with keep-alive (decision still open, recommendation: simple Node
server, orchestrator logic separated from transport). Demo video
is automatic after the build, not discussed at idea stage.

## Open decisions (not guessed)
- Backend host final choice.
- Synthetic manuscript field and content.
- Trademark/domain/repo final check for MARVA (general check done:
  no exact repo, old dead trademarks, but a course-management
  software named Marva in another field exists — decision on
  whether that cross-field collision is acceptable).
