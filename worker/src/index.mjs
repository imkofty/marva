// MARVA Worker — Cloudflare Workers port of backend/src/server.mjs.
// Endpoints:
//   POST /jobs            {text | citations+references | pdfBase64}
//   GET  /jobs/:id        job state + report (never manuscript text)
//   GET  /jobs/:id/events polling-friendly JSON event list (not SSE)
//   GET  /jobs/:id/report.json supervisor report JSON
//   GET  /jobs/:id/report.html printable report HTML
//   GET  /jobs/:id/report.pdf printable report PDF summary
//   POST /jobs/:id/confirm {confirmed:true} author-confirmation gate
//   DELETE /jobs/:id      remove job record entirely
//   GET  /demo/synthetic  cached synthetic diagnostic, no key needed
// Job flow: Reader -> deterministic citation matcher -> Reference
// Verifier (Crossref/OpenAlex) -> Gap Assessor -> strengthening search
// (OpenAlex, verified before recommending) -> Journal Matcher ->
// Supervisor/Report Builder. Wonder escalation only for flagged
// ambiguous verifier cases. The Narrator model is NOT called inside
// runJob: live-office bubbles are the real stage-event details, the
// same as the Node server; a Narrator call would add a model round
// trip per stage for no new finding.
// Honest rules, same as Node: if MODEL_API_KEY is unset, model stages
// report "skipped", never faked; no plagiarism percentage anywhere;
// a failed stage is recorded with status "failed" and the job
// continues with the stages that can still run; the final report
// carries partial=true when any stage failed or was skipped for a
// missing key. One job at a time for the demo: a second POST while a
// job is running returns 409. A stale active lock (job record done,
// missing, or not updated for 10 minutes) is cleared on the next POST.
// KV race note: KV put is not an atomic compare-and-swap, so two
// POSTs arriving in the same instant could both pass the lock check;
// this is a demo limitation, not a guarantee for production.
import { extractReferenceKey, normalizeKey } from "./citation-matcher.mjs";
import { runAgent, escalateAmbiguous } from "./agents.mjs";
import { extractTextFromPdf } from "./pdf.mjs";
import { verifyReference, searchStrengthening } from "./strengthening.mjs";
import { buildReport, buildReportHTML, buildReportPDF } from "./export.mjs";
import { loadJob, saveJob, loadActive, saveActive, clearActiveIf, deleteJob } from "./store.mjs";
import { SYNTHETIC_DEMO } from "./demo.mjs";

const STALE_MS = 10 * 60 * 1000;
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...CORS } });
}

function publicJob(job) {
  // Never return manuscript text, even though runJob holds it in memory.
  const { text, ...rest } = job;
  return { ...rest, report: buildReport(job) };
}

async function pushEvent(env, job, event) {
  job.events.push(event);
  if (event.status === "failed" || event.status === "skipped") job.partial = true;
  await saveJob(env, job);
}

function base64ToBuffer(b64) {
  // Workers with nodejs_compat provide Buffer; fall back to atob.
  if (typeof Buffer !== "undefined") return Buffer.from(b64, "base64");
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function deterministicSupervisor(job) {
  // Code-only fallback when the Supervisor model is skipped (no key).
  // Built only from matcher + verifier results, never invented.
  const diagnostic = [];
  const fixes = [];
  for (const m of job.result?.missing || []) {
    diagnostic.push({ dimension: "citation", finding: `Missing citation: ${m}`, evidence: "cited in text, absent from reference list", location: "text" });
    fixes.push({ priority: "must-fix", action: `Add ${m} to the reference list or remove the in-text citation.`, evidence: "deterministic citation match" });
  }
  for (const u of job.result?.uncited || []) {
    diagnostic.push({ dimension: "citation", finding: `Uncited reference: ${u}`, evidence: "in reference list, never cited in text", location: "reference list" });
    fixes.push({ priority: "nice-to-have", action: `Cite ${u} in the text or remove it from the reference list.`, evidence: "deterministic citation match" });
  }
  for (const f of job.verifier?.flagged || []) {
    diagnostic.push({ dimension: "reference", finding: `Flagged reference: ${f.reference}`, evidence: f.reason || "database check did not verify it", location: "reference list" });
    fixes.push({ priority: "must-fix", action: `Check ${f.reference} against the database record before submitting.`, evidence: "database check" });
  }
  return { diagnostic, fixes, source: "deterministic-fallback (Supervisor model skipped: no key)" };
}

// Journal-adjacent evidence, honest version: search OpenAlex for recent
// works in the classified fields and return them as CANDIDATE evidence
// only. These are works, not journal recommendations, and no journal is
// ever labelled Scopus-indexed here: scopus_indexed_status stays
// "unverified" because no real Scopus Sources check exists in this port.
// A failed search returns an empty list and never fails the journal stage.
export async function searchJournalEvidence(fields, fetchImpl = fetch) {
  const names = (fields || []).map((f) => f.name).filter(Boolean).slice(0, 2);
  const works = [];
  for (const name of names) {
    try {
      const res = await fetchImpl(`https://api.openalex.org/works?search=${encodeURIComponent(name)}&per-page=3`, { headers: { Accept: "application/json" } });
      if (!res.ok) continue;
      const data = await res.json();
      for (const w of data.results || []) {
        works.push({
          field: name,
          title: w.title || null,
          authors: (w.authorships || []).map((a) => a.author?.display_name).filter(Boolean),
          year: w.publication_year ?? null,
          journal: w.primary_location?.source?.display_name || null,
          doi: w.doi ? w.doi.replace(/^https:\/\/doi\.org\//, "") : null,
          verification: "candidate",
          scopus_indexed_status: "unverified",
          note: "Recent work in the classified field, shown as candidate evidence only; not a journal recommendation and not claimed Scopus-indexed.",
        });
      }
    } catch { /* search failure -> no evidence, stage still succeeds */ }
  }
  return works;
}

// Step-wise pipeline for Cloudflare Workers.
// Why step-wise, not waitUntil: ctx.waitUntil() extends execution only
// up to 30 seconds after the response is sent (Cloudflare Workers
// limits docs). A full 7-stage model pipeline takes longer than that,
// so a waitUntil job is killed mid-pipeline with no failure event and
// the job stays "running" forever — exactly what happened to the first
// live Imkofty job (5 stages done, then stuck at journal).
// Instead: POST /jobs runs the Reader stage synchronously (the only
// stage that needs the manuscript text, which is never persisted to
// KV), then returns 201. Each subsequent GET /jobs/:id/events request
// advances exactly one stage synchronously (the request stays open
// while the client is connected, which Workers allow without a hard
// wall-clock limit), guarded by an advancing_until lock so overlapping
// polls (frontend polls every 2s) cannot run the same stage twice.
// A stage that fails or times out is recorded honestly and the job
// continues to the next stage, never hanging forever.
import { matchCitations as _origMatch } from "./citation-matcher.mjs";
export const STAGES = ["reader", "citation_matcher", "reference_verifier", "gap", "strengthening", "journal", "supervisor"];

export async function runStage(env, job, stage, text, deps = {}) {
  const fetchImpl = deps.fetchImpl || fetch;
  const apiKey = deps.apiKey !== undefined ? deps.apiKey : (env.MODEL_API_KEY || "");
  const hasKey = !!apiKey && apiKey !== "REPLACE_AT_DEPLOY_VIA_WRANGLER_SECRET";
  const agentDeps = { fetchImpl, apiKey: hasKey ? apiKey : "" };
  if (stage === "reader") {
    if (text) {
      if (!hasKey) {
        await pushEvent(env, job, { stage: "reader", status: "skipped", detail: "MODEL_API_KEY not set" });
      } else {
        const reader = await runAgent("reader", { text: text.slice(0, 20000) }, agentDeps);
        if (reader.data) {
          job.reader = reader.data;
          if (Array.isArray(reader.data.citations)) job.citations = reader.data.citations;
          if (Array.isArray(reader.data.references)) job.references = reader.data.references;
          await pushEvent(env, job, { stage: "reader", status: "done", detail: `Claims: ${reader.data.claims?.length ?? 0}, citations: ${job.citations.length}, references: ${job.references.length}` });
        } else {
          await pushEvent(env, job, { stage: "reader", status: "failed", detail: reader.error || "Reader failed" });
        }
      }
    } else {
      await pushEvent(env, job, { stage: "reader", status: "done", detail: "Text split into sections" });
    }
    return;
  }
  if (stage === "citation_matcher") {
    // Deterministic, never a model. Reader returns full reference
    // strings ("Davis, 1989. Perceived usefulness...") while in-text
    // citations are keys ("Davis, 1989"): matching full strings against
    // keys falsely reports every citation as missing, so compare
    // author-year keys extracted by regex, originals kept for the
    // verifier/report. Same fix as backend-node run-job.mjs.
    job.reference_keys = (job.references || []).map(extractReferenceKey);
    job.result = _origMatch((job.citations || []).map(normalizeKey), job.reference_keys);
    job.result.uncited_references = (job.references || []).filter((r) => job.result.uncited.includes(extractReferenceKey(r)));
    await pushEvent(env, job, { stage: "citation_matcher", status: "done", detail: `Missing: ${job.result.missing.length}, uncited: ${job.result.uncited.length}, duplicates: ${job.result.duplicates.length}`, result: job.result });
    return;
  }
  if (stage === "reference_verifier") {
    try {
      const verified = [];
      const flagged = [];
      const ambiguous = [];
      for (const ref of job.references) {
        const v = await verifyReference(ref, fetchImpl);
        if (v.status === "verified") verified.push(ref);
        else if (v.status === "candidate") ambiguous.push({ reference: ref, db: v.db });
        else flagged.push({ reference: ref, reason: v.db?.reason || "unresolved" });
      }
      job.verifier = { verified, flagged, ambiguous: ambiguous.map((a) => a.reference) };
      if (ambiguous.length > 0 && hasKey) {
        const esc = await escalateAmbiguous(ambiguous.map((a) => a.reference), agentDeps);
        job.verifier.wonder_reviewed = esc.data || null;
        if (esc.error) job.verifier.wonder_error = esc.error;
      } else if (ambiguous.length > 0) {
        job.verifier.wonder_reviewed = null;
      }
      await pushEvent(env, job, { stage: "reference_verifier", status: "done", detail: `Verified: ${verified.length}, flagged: ${flagged.length}, ambiguous: ${ambiguous.length}` });
    } catch (e) {
      job.verifier = null;
      await pushEvent(env, job, { stage: "reference_verifier", status: "failed", detail: String(e.message || e).slice(0, 300) });
    }
    return;
  }
  if (stage === "gap") {
    try {
      if (!hasKey) {
        const oldRefs = (job.references || []).filter((r) => {
          const y = parseInt((String(r).match(/\b(19|20)\d{2}\b/) || [])[0] || "0", 10);
          return y && y < new Date().getFullYear() - 20;
        });
        job.gap = { skipped: true, reason: "MODEL_API_KEY not set", old_references_for_author_review: oldRefs };
        await pushEvent(env, job, { stage: "gap", status: "skipped", detail: "MODEL_API_KEY not set" });
      } else {
        const gap = await runAgent("gap", { reader: job.reader || null, citations: job.citations, references: job.references }, agentDeps);
        if (gap.data) {
          job.gap = gap.data;
          await pushEvent(env, job, { stage: "gap", status: "done", detail: `Missing theories: ${gap.data.missing_theories?.length ?? 0}, outdated: ${gap.data.outdated_references?.length ?? 0}` });
        } else {
          job.gap = null;
          await pushEvent(env, job, { stage: "gap", status: "failed", detail: gap.error || "Gap failed" });
        }
      }
    } catch (e) {
      job.gap = null;
      await pushEvent(env, job, { stage: "gap", status: "failed", detail: String(e.message || e).slice(0, 300) });
    }
    return;
  }
  if (stage === "strengthening") {
    try {
      const terms = [];
      for (const t of job.gap?.missing_theories || []) terms.push(t.name);
      for (const t of job.gap?.rival_theories || []) terms.push(t.name);
      if (terms.length === 0) {
        job.strengthening = { skipped: true, reason: "No gap theories to search for", recommendations: [] };
        await pushEvent(env, job, { stage: "strengthening", status: "skipped", detail: "No gap theories to search for" });
      } else {
        job.strengthening = await searchStrengthening(terms, fetchImpl);
        await pushEvent(env, job, { stage: "strengthening", status: "done", detail: `Recommendations: ${job.strengthening.recommendations.length} (verified or candidate only), dropped unresolved: ${job.strengthening.dropped_unresolved}` });
      }
    } catch (e) {
      job.strengthening = null;
      await pushEvent(env, job, { stage: "strengthening", status: "failed", detail: String(e.message || e).slice(0, 300) });
    }
    return;
  }
  if (stage === "journal") {
    try {
      if (!hasKey) {
        job.journal = { skipped: true, reason: "MODEL_API_KEY not set" };
        await pushEvent(env, job, { stage: "journal", status: "skipped", detail: "MODEL_API_KEY not set" });
      } else {
        const j = await runAgent("journal", { reader: job.reader || null, references: job.references }, agentDeps);
        if (j.data) {
          job.journal = { ...j.data, scopus_indexed_status: "unverified" };
          await pushEvent(env, job, { stage: "journal", status: "done", detail: `Fields: ${(j.data.fields || []).map((f) => f.name).join(", ") || "none"}` });
        } else {
          job.journal = null;
          await pushEvent(env, job, { stage: "journal", status: "failed", detail: j.error || "Journal failed" });
        }
      }
    } catch (e) {
      job.journal = null;
      await pushEvent(env, job, { stage: "journal", status: "failed", detail: String(e.message || e).slice(0, 300) });
    }
    return;
  }
  if (stage === "supervisor") {
    try {
      if (!hasKey) {
        job.supervisor = deterministicSupervisor(job);
        await pushEvent(env, job, { stage: "supervisor", status: "done", detail: "Deterministic diagnostic (Supervisor model skipped: no key)" });
      } else {
        const s = await runAgent("supervisor", { reader: job.reader || null, result: job.result, verifier: job.verifier, gap: job.gap, journal: job.journal, strengthening: job.strengthening }, agentDeps);
        if (s.data) {
          job.supervisor = s.data;
          await pushEvent(env, job, { stage: "supervisor", status: "done", detail: `Diagnostic items: ${s.data.diagnostic?.length ?? 0}, fixes: ${s.data.fixes?.length ?? 0}` });
        } else {
          job.supervisor = deterministicSupervisor(job);
          await pushEvent(env, job, { stage: "supervisor", status: "failed", detail: s.error || "Supervisor failed, deterministic fallback used" });
        }
      }
    } catch (e) {
      job.supervisor = deterministicSupervisor(job);
      await pushEvent(env, job, { stage: "supervisor", status: "failed", detail: String(e.message || e).slice(0, 300) });
    }
    return;
  }
}

// Advance a running job by exactly one stage, guarded by a lock so
// overlapping polls cannot run the same stage twice. Returns the job
// after advancing (or unchanged if locked / not running).
export async function advanceJob(env, job, deps = {}) {
  if (!job || job.status !== "running") return job;
  if (job.advancing_until && job.advancing_until > Date.now()) return job;
  const idx = job.next_stage ?? 0;
  if (idx >= STAGES.length) return job;
  job.advancing_until = Date.now() + 120000;
  await saveJob(env, job);
  try {
    await runStage(env, job, STAGES[idx], null, deps);
  } catch (e) {
    await pushEvent(env, job, { stage: STAGES[idx], status: "failed", detail: String(e.message || e).slice(0, 300) });
  }
  job.advancing_until = 0;
  job.next_stage = idx + 1;
  if (job.next_stage >= STAGES.length) {
    job.status = "done";
    await pushEvent(env, job, { stage: "job", status: "done", detail: job.partial ? "Job complete with skipped or failed stages (see events)" : "All stages complete" });
    await clearActiveIf(env, job.id);
  } else {
    await saveJob(env, job);
  }
  return job;
}

// Full pipeline, kept for tests: runs all stages sequentially in one
// call (no waitUntil). Production POST uses reader + advanceJob, not
// this, because a single HTTP request that runs the whole pipeline
// would block the frontend's live room for the full duration.
export async function runJob(env, job, text, deps = {}) {
  try {
    for (let i = 0; i < STAGES.length; i++) {
      await runStage(env, job, STAGES[i], i === 0 ? text : null, deps);
    }
  } finally {
    job.status = "done";
    await pushEvent(env, job, { stage: "job", status: "done", detail: job.partial ? "Job complete with skipped or failed stages (see events)" : "All stages complete" });
    await clearActiveIf(env, job.id);
  }
}


export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }
    try {
      if (request.method === "GET" && url.pathname === "/demo/synthetic") {
        return json(SYNTHETIC_DEMO);
      }
      if (request.method === "POST" && url.pathname === "/jobs") {
        let data;
        try { data = await request.json(); } catch { return json({ error: "Body must be JSON" }, 400); }
        if (!data || typeof data !== "object") return json({ error: "Body must be JSON" }, 400);
        const activeId = await loadActive(env);
        if (activeId) {
          const activeJob = await loadJob(env, activeId).catch(() => null);
          const stale = !activeJob || activeJob.status !== "running" || (Date.now() - (activeJob.updatedAt || 0) > STALE_MS);
          if (!stale) return json({ error: "One job at a time for the demo", activeJobId: activeId }, 409);
          await saveActive(env, "");
        }
        let text = "";
        let pdf_note = null;
        if (typeof data.text === "string") text = data.text;
        else if (typeof data.pdfBase64 === "string") {
          try {
            text = extractTextFromPdf(base64ToBuffer(data.pdfBase64));
            if (!text) pdf_note = "PDF text extraction returned no text; scanned-image and encrypted PDFs are not readable by this extractor.";
          } catch (e) {
            pdf_note = `PDF extraction failed: ${String(e.message || e).slice(0, 200)}`;
          }
        }
        const job = {
          id: crypto.randomUUID(), status: "running", events: [],
          citations: Array.isArray(data.citations) ? data.citations : [],
          references: Array.isArray(data.references) ? data.references : [],
          reader: null, result: null, verifier: null, gap: null,
          journal: null, supervisor: null, strengthening: null,
          confirmed: false, next_stage: 1, advancing_until: 0,
          partial: false, pdf_note, updatedAt: Date.now(),
        };
        await saveJob(env, job);
        await saveActive(env, job.id);
        // Step-wise: run Reader synchronously here (only stage that
        // needs the manuscript text, which is never persisted to KV).
        // Later stages advance one per GET /events poll. Never use
        // ctx.waitUntil for the pipeline: it is capped at 30 seconds
        // after the response, which kills a 7-stage job mid-pipeline.
        try {
          await runStage(env, job, "reader", text, {});
        } catch (e) {
          await pushEvent(env, job, { stage: "reader", status: "failed", detail: String(e.message || e).slice(0, 300) });
        }
        job.next_stage = 1;
        await saveJob(env, job);
        return json({ jobId: job.id, status: job.status }, 201);
      }
      const eventsMatch = url.pathname.match(/^\/jobs\/([^/]+)\/events$/);
      if (request.method === "GET" && eventsMatch) {
        let job = await loadJob(env, eventsMatch[1]);
        if (!job) return json({ error: "Job not found" }, 404);
        // Polling-friendly JSON, not SSE: the frontend polls this every
        // 2 seconds and renders new events. Each poll advances exactly
        // one stage (locked against overlapping polls), so the live
        // room updates stage by stage without a long background task.
        if (job.status === "running") {
          job = await advanceJob(env, job, {});
        }
        return json({ jobId: job.id, status: job.status, events: job.events || [] });
      }
      const reportJsonMatch = url.pathname.match(/^\/jobs\/([^/]+)\/report\.json$/);
      if (request.method === "GET" && reportJsonMatch) {
        const job = await loadJob(env, reportJsonMatch[1]);
        if (!job) return json({ error: "Job not found" }, 404);
        return json(buildReport(job));
      }
      const reportHtmlMatch = url.pathname.match(/^\/jobs\/([^/]+)\/report\.html$/);
      if (request.method === "GET" && reportHtmlMatch) {
        const job = await loadJob(env, reportHtmlMatch[1]);
        if (!job) return json({ error: "Job not found" }, 404);
        return new Response(buildReportHTML(buildReport(job)), { status: 200, headers: { "Content-Type": "text/html; charset=utf-8", ...CORS } });
      }
      const reportPdfMatch = url.pathname.match(/^\/jobs\/([^/]+)\/report\.pdf$/);
      if (request.method === "GET" && reportPdfMatch) {
        const job = await loadJob(env, reportPdfMatch[1]);
        if (!job) return json({ error: "Job not found" }, 404);
        return new Response(buildReportPDF(buildReport(job)), { status: 200, headers: { "Content-Type": "application/pdf", ...CORS } });
      }
      const confirmMatch = url.pathname.match(/^\/jobs\/([^/]+)\/confirm$/);
      if (request.method === "POST" && confirmMatch) {
        const job = await loadJob(env, confirmMatch[1]);
        if (!job) return json({ error: "Job not found" }, 404);
        let data = {};
        try { data = await request.json(); } catch { return json({ error: "Body must be JSON" }, 400); }
        if (data.confirmed !== true) return json({ error: "confirmed must be true" }, 400);
        job.confirmed = true;
        job.events.push({ stage: "gate", status: "confirmed", detail: "Author confirmed references (POST /jobs/:id/confirm). Confirmation records the author's review; it does not verify a reference or a journal by itself.", gate: "author_confirmation" });
        await saveJob(env, job);
        return json({ jobId: job.id, confirmed: true });
      }
      const jobMatch = url.pathname.match(/^\/jobs\/([^/]+)$/);
      if (request.method === "GET" && jobMatch) {
        const job = await loadJob(env, jobMatch[1]);
        if (!job) return json({ error: "Job not found" }, 404);
        return json(publicJob(job));
      }
      if (request.method === "DELETE" && jobMatch) {
        const job = await loadJob(env, jobMatch[1]);
        if (!job) return json({ error: "Job not found" }, 404);
        await deleteJob(env, jobMatch[1]);
        await clearActiveIf(env, jobMatch[1]);
        return json({ deleted: true, jobId: jobMatch[1] });
      }
      return json({ error: "Not found" }, 404);
    } catch (e) {
      if (String(e.message || "").includes("MARVA_JOBS binding")) {
        return json({ error: "MARVA_JOBS binding not configured" }, 500);
      }
      return json({ error: String(e.message || e).slice(0, 300) }, 500);
    }
  },
};
