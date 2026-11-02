// Durable Object per job — the execution engine for MARVA jobs.
//
// Why this exists (2026-10-29, Wonder's architecture verdict): the
// old engine stored job state in KV and let the frontend's 2s poll
// advance the job. KV free tier allows 1,000 writes/day across the
// whole account, and every advancing poll cost 2–4 puts, so one
// rate-limited verifier job (live job 429: stuck at 134/161 with
// "KV put() limit exceeded") could eat the entire daily budget.
// KV also has no compare-and-swap, so the time-based
// `advancing_until` lock was risk reduction, not a guarantee.
//
// The DO removes that class of problem by design:
// - One object per job, requests to it serialised by the runtime —
//   no lock, no race, no per-poll lock writes.
// - Progress lives in DO storage (SQLite-backed; free tier 100k row
//   writes/day, 100k requests/day), not in globally-billed KV puts.
// - The object drives itself with alarms: a verifier batch arms the
//   next alarm in ~1s, a 429 arms it at the backoff delay. The
//   frontend's GET /events becomes read-only — closing the tab no
//   longer pauses the audit.
// - KV keeps exactly two jobs: the DOI cache (`verify:doi:*`) and
//   the single-job `active` gate. Job records in KV are migration
//   sources only (see loadOrMigrate).
//
// Internal protocol (called only by the Worker, never by browsers):
//   POST /init    {job}  store the post-Reader record, arm first alarm
//   GET  /state?id=..   job record, lazy-migrating from KV if needed
//   POST /confirm?id=.. apply the author-confirmation gate event
//   POST /delete?id=..  drop DO storage for the job
//   POST /kick?id=..    arm an alarm iff none is scheduled and the
//                        job is running (self-healing; safe to call
//                        on every /events poll)
// The Worker passes the job id as a query param because a DO stub
// addressed by idFromName cannot recover the original id string.
//
// Circular-import note: this module imports runStage/STAGES/pushEvent
// from index.mjs, and index.mjs re-exports JobObject from here. That
// cycle is safe: this module only touches those bindings inside
// methods (called at request time, long after both modules have
// evaluated), never at module top level.
import { runStage, STAGES, pushEvent } from "./index.mjs";
import { loadJob, clearActiveIf } from "./store.mjs";

const JOB_KEY = "job";
const NEXT_ALARM_MS = 1000;

function validateVerifierProgress(p) {
  if (!p || typeof p !== "object") return false;
  if (!Array.isArray(p.order) || !p.order.every((i) => Number.isInteger(i))) return false;
  if (!Number.isInteger(p.pos) || p.pos < 0 || p.pos > p.order.length) return false;
  for (const k of ["verified", "flagged", "ambiguous", "inconclusive"]) {
    if (!Array.isArray(p[k])) return false;
  }
  return true;
}

// Advance a running job by exactly one step (one stage, or one
// verifier batch), without any lock and without KV writes. This is
// advanceJob's successor: same stage semantics, minus the lock save,
// the lock clear, and the KV persistence — the caller (alarm) saves
// the record to DO storage exactly once per step.
export async function driveOneStep(env, job, deps = {}) {
  if (!job || job.status !== "running") return job;
  const idx = job.next_stage ?? 0;
  if (idx >= STAGES.length) return job;
  // Verifier backoff guard: the alarm was scheduled for retry_after,
  // but if this step runs early, do nothing — the alarm handler
  // re-arms for the remaining wait instead of burning a batch.
  if (job.verifier_incomplete && job.verifier_retry_after && job.verifier_retry_after > Date.now()) return job;
  try {
    await runStage(env, job, STAGES[idx], null, deps);
  } catch (e) {
    await pushEvent(env, job, { stage: STAGES[idx], status: "failed", detail: String(e.message || e).slice(0, 300) });
  }
  if (job.verifier_incomplete) return job;
  job.next_stage = idx + 1;
  if (job.next_stage >= STAGES.length) {
    job.status = "done";
    await pushEvent(env, job, { stage: "job", status: "done", detail: job.partial ? "Job complete with skipped or failed stages (see events)" : "All stages complete" });
  }
  return job;
}

export class JobObject {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.storage = ctx.storage;
  }

  // Live record, or the KV record imported once on first access.
  // Migration is what lets the running job 328 survive the deploy:
  // its KV record (verifier_progress pos + results) becomes the DO
  // record verbatim, and the DO continues from the same pos. An
  // invalid stored progress is a hard 500, never a silent reset —
  // the KV copy stays intact for inspection.
  async loadOrMigrate(jobId) {
    let job = await this.storage.get(JOB_KEY);
    if (job) return job;
    const kvJob = await loadJob(this.env, jobId).catch(() => null);
    if (!kvJob) return null;
    if (typeof kvJob !== "object" || kvJob.id !== jobId || !Array.isArray(kvJob.events)) {
      throw new Error("stored job record failed validation, refusing migration");
    }
    if (kvJob.verifier_progress && !validateVerifierProgress(kvJob.verifier_progress)) {
      throw new Error("stored verifier progress failed validation, refusing migration");
    }
    await this.storage.put(JOB_KEY, kvJob);
    return kvJob;
  }

  async arm(delayMs) {
    await this.storage.setAlarm(Date.now() + delayMs);
  }

  // Alarm handler: one step, one storage write, then re-arm (or
  // finish). `deps` is {} in production; tests pass a stub fetch.
  async alarm(deps = {}) {
    const job = await this.storage.get(JOB_KEY);
    if (!job || job.status !== "running") return;
    if (job.verifier_incomplete && job.verifier_retry_after && job.verifier_retry_after > Date.now()) {
      await this.arm(job.verifier_retry_after - Date.now());
      return;
    }
    await driveOneStep(this.env, job, deps);
    job.updatedAt = Date.now();
    await this.storage.put(JOB_KEY, job);
    if (job.status === "done") {
      await clearActiveIf(this.env, job.id);
      return;
    }
    if (job.verifier_incomplete && job.verifier_retry_after && job.verifier_retry_after > Date.now()) {
      await this.arm(job.verifier_retry_after - Date.now());
    } else {
      await this.arm(NEXT_ALARM_MS);
    }
  }

  async fetch(request) {
    const url = new URL(request.url);
    const jobId = url.searchParams.get("id");
    try {
      if (request.method === "POST" && url.pathname === "/init") {
        const { job } = await request.json();
        if (!job || job.id !== jobId) return new Response(JSON.stringify({ error: "job id mismatch" }), { status: 400 });
        await this.storage.put(JOB_KEY, job);
        await this.arm(NEXT_ALARM_MS);
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (request.method === "GET" && url.pathname === "/state") {
        const job = await this.loadOrMigrate(jobId);
        if (!job) return new Response(JSON.stringify({ error: "Job not found" }), { status: 404 });
        const { text, ...rest } = job;
        return new Response(JSON.stringify(rest), { status: 200 });
      }
      if (request.method === "POST" && url.pathname === "/confirm") {
        const job = await this.loadOrMigrate(jobId);
        if (!job) return new Response(JSON.stringify({ error: "Job not found" }), { status: 404 });
        job.confirmed = true;
        job.events.push({ stage: "gate", status: "confirmed", detail: "Author confirmed references (POST /jobs/:id/confirm). Confirmation records the author's review; it does not verify a reference or a journal by itself.", gate: "author_confirmation" });
        job.updatedAt = Date.now();
        await this.storage.put(JOB_KEY, job);
        return new Response(JSON.stringify({ jobId: job.id, confirmed: true }), { status: 200 });
      }
      if (request.method === "POST" && url.pathname === "/delete") {
        await this.storage.delete(JOB_KEY);
        return new Response(JSON.stringify({ deleted: true }), { status: 200 });
      }
      if (request.method === "POST" && url.pathname === "/kick") {
        const job = await this.loadOrMigrate(jobId);
        if (!job) return new Response(JSON.stringify({ error: "Job not found" }), { status: 404 });
        if (job.status === "running") {
          const pending = await this.storage.getAlarm();
          // A missing alarm means a lost alarm; an alarm scheduled in
          // the past means a zombie alarm: its invocation failed (the
          // 2026-11-01 DO free-tier throttle killed the 23:41 UTC
          // alarm of job 443 and the platform never retried it), so
          // it will never fire yet it blocks the old "arm only if
          // none" rule. A future alarm is live and must be left
          // alone, or two alarms would drive the same step twice.
          if (pending === null || pending === undefined || pending < Date.now()) await this.arm(NEXT_ALARM_MS);
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: "Not found" }), { status: 404 });
    } catch (e) {
      return new Response(JSON.stringify({ error: String(e.message || e).slice(0, 300) }), { status: 500 });
    }
  }
}
