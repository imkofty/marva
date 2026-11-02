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
// Execution engine (since 2026-10-29): a Durable Object per job
// (job-object.mjs). POST runs Reader synchronously, hands the record
// to the DO, and the DO drives the rest with alarms — one stage (or
// one verifier batch) per alarm, one storage write per step. GET
// /events is read-only; the frontend poll no longer advances anything.
// KV keeps the DOI cache and the `active` gate only.
// Honest rules, same as Node: if MODEL_API_KEY is unset, model stages
// report "skipped", never faked; no plagiarism percentage anywhere;
// a failed stage is recorded with status "failed" and the job
// continues with the stages that can still run; the final report
// carries partial=true when any stage failed or was skipped for a
// missing key. One job at a time for the demo: a second POST while a
// job is running returns 409. A stale active lock (job record done,
// missing, or not updated for 10 minutes) is cleared on the next POST.
// Race note: the per-job stage race is gone — a DO serialises its
// own requests, so no lock is needed inside a job. The POST gate
// still reads the KV `active` key, so two POSTs arriving in the same
// instant could both pass the gate check; that residual demo
// limitation (not the stage race) remains.
import { extractReferenceKey, normalizeKey, matchAuthorYearKeys, resolveIbidKeys } from "./citation-matcher.mjs";
import { parseReferences, scanAuthorYearCitations, scanAuthorYearCitationContexts, scanBracketCitations, scanSuperscriptCitations, splitMarkedBody, stripMarkerChars } from "./reference-parser.mjs";
import { runAgent, escalateAmbiguous } from "./agents.mjs";
import { runCrosscheck } from "./crosscheck.mjs";
import { analyzePdf, SCANNED_PDF_REASON } from "./pdf.mjs";
import { verifyReference, searchStrengthening, extractDOI } from "./strengthening.mjs";
import { withOpenAlexKey } from "./database.mjs";
import { createQuotaCounter, snapshotQuota, quotaBudget, checkStrengtheningQuota } from "./quota.mjs";
import { buildVenueRecommendations, buildJournalRecommendations, mergeFieldCandidates } from "./journal-evidence.mjs";
import { buildReport, buildReportHTML, buildReportPDF } from "./export.mjs";
import { loadJob, saveJob, loadActive, saveActive, clearActiveIf, deleteJob } from "./store.mjs";
import { SYNTHETIC_DEMO } from "./demo.mjs";

// Durable Object class (defined in job-object.mjs; re-exported here
// because Cloudflare requires DO classes to be exported from the
// Worker's main module). See the circular-import note in that file.
export { JobObject } from "./job-object.mjs";

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

// --- Durable Object routing ------------------------------------------------
// The DO is the live home of every job record. The Worker only routes:
// POST /jobs initialises the DO after the synchronous Reader stage,
// and every later job route reads or mutates through the DO. KV keeps
// the DOI cache, the `active` gate, and pre-migration job copies.
// In tests env.JOB_OBJECTS is a fake binding (see worker.test.mjs);
// in production the binding always exists after the DO deploy.
function doStub(env, id) {
  if (!env.JOB_OBJECTS) throw new Error("JOB_OBJECTS binding not configured");
  return env.JOB_OBJECTS.get(env.JOB_OBJECTS.idFromName(id));
}

async function doCall(env, id, path, opts = {}) {
  const stub = doStub(env, id);
  const res = await stub.fetch(new Request(`http://do${path}${path.includes("?") ? "&" : "?"}id=${encodeURIComponent(id)}`, opts));
  const body = await res.json().catch(() => ({}));
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(body.error || `DO ${path} failed (${res.status})`);
  return body;
}

async function doState(env, id) {
  return doCall(env, id, "/state");
}

// Events are buffered in memory only. The caller persists them with
// saveJob: the DO alarm saves once at the end of every alarm step
// (lock save at start + final save), and the POST /jobs handler saves
// after the synchronous Reader stage. Saving on every event used to
// cost a full KV put per event on top of those saves — under the
// free-tier 1,000-writes/day budget that burned the quota mid-job
// (2026-10-29: job 429 stalled at 134/161 on "KV put() limit
// exceeded"). Buffering is what takes an advancing poll from 3–4
// puts down to exactly 2. `env` is kept in the signature so all
// existing call sites stay unchanged.
export async function pushEvent(env, job, event) {
  job.events.push(event);
  if (event.status === "failed" || event.status === "skipped") job.partial = true;
}

// Chunk body text at paragraph boundaries so a long paper's claims are
// read in full, not just its first 20,000 characters. Chunking happens
// only in the Reader stage, while the manuscript text is in memory;
// text is never persisted to KV, so later stages cannot re-chunk it.
function chunkText(text, maxChars = 30000) {
  const lines = String(text || "").split(/\n/);
  const chunks = [];
  let cur = "";
  for (const line of lines) {
    if (cur.length + line.length + 1 > maxChars && cur.trim()) { chunks.push(cur); cur = ""; }
    if (line.length > maxChars) {
      for (let i = 0; i < line.length; i += maxChars) chunks.push(line.slice(i, i + maxChars));
    } else {
      cur += (cur ? "\n" : "") + line;
    }
  }
  if (cur.trim()) chunks.push(cur);
  return chunks.length ? chunks : [String(text || "")];
}

function mergeReader(acc, data) {
  if (!data) return acc;
  const out = acc || { claims: [], theories: [], quotes: [], citations: [], method: null, equations: [], tables: [] };
  const dedup = (arr, key) => {
    const seen = new Set((arr || []).map((x) => String(typeof x === "string" ? x : (x?.[key] ?? x?.text ?? JSON.stringify(x))).toLowerCase()));
    return (v) => {
      const k = String(typeof v === "string" ? v : (v?.[key] ?? v?.text ?? JSON.stringify(v))).toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    };
  };
  const claimOk = dedup(out.claims, "text");
  for (const c of data.claims || []) if (claimOk(c)) out.claims.push(c);
  const theoryOk = dedup(out.theories, "name");
  for (const t of data.theories || []) if (theoryOk(t)) out.theories.push(t);
  const quoteOk = dedup(out.quotes, "text");
  for (const q of data.quotes || []) if (quoteOk(q)) out.quotes.push(q);
  const citOk = dedup(out.citations, null);
  for (const c of data.citations || []) if (citOk(c)) out.citations.push(c);
  if (!out.method && data.method) out.method = data.method;
  const eqOk = dedup(out.equations, null);
  for (const e of data.equations || []) if (eqOk(e)) out.equations.push(e);
  const tabOk = dedup(out.tables, null);
  for (const t of data.tables || []) if (tabOk(t)) out.tables.push(t);
  return out;
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
  // OpenAlex free API key (Worker secret OPENALEX_API_KEY, set separately
  // from MODEL_API_KEY): when present, every api.openalex.org call made
  // through fetchImpl carries it. When absent, fetchImpl is untouched
  // and calls behave exactly as before (anonymous pool).
  const fetchImpl = withOpenAlexKey(deps.fetchImpl || fetch, env.OPENALEX_API_KEY || "");
  const apiKey = deps.apiKey !== undefined ? deps.apiKey : (env.MODEL_API_KEY || "");
  const hasKey = !!apiKey && apiKey !== "REPLACE_AT_DEPLOY_VIA_WRANGLER_SECRET";
  const agentDeps = { fetchImpl, apiKey: hasKey ? apiKey : "" };
  // Per-job OpenAlex usage counter (quota.mjs): a plain object on the
  // job, so it persists with the job across DO alarm steps and
  // accumulates across verifier batches. Additive only — stages that
  // never touch a database simply leave it at zero. Old jobs loaded
  // from storage without a counter get one on their next stage.
  const quota = job.quota || (job.quota = createQuotaCounter());
  // Scanned-PDF gate (2026-11-03): a PDF with no text layer has no
  // manuscript text for any text-dependent stage. Skipping them with
  // the recorded reason beats letting a model invent findings from
  // empty input. The verifier is NOT gated: it needs only the
  // reference list (possibly author-provided), and its verdicts come
  // from database DOI matches, never from the missing text.
  // Strengthening skips itself (no gap theories). One scanned job
  // touches nothing outside its own record, so other jobs are
  // unaffected.
  const SCANNED_GATED_STAGES = new Set(["reader", "citation_matcher", "gap", "journal", "supervisor"]);
  if (job.pdf_scanned && SCANNED_GATED_STAGES.has(stage)) {
    await pushEvent(env, job, { stage, status: "skipped", detail: SCANNED_PDF_REASON });
    return;
  }
  if (stage === "reader") {
    if (job.pdf_encrypted) {
      // The bytes could not be read at all: report the reader stage
      // skipped with the exact reason, never "done" on empty text.
      // Later stages see zero references and skip honestly; the
      // matcher preserves this status (see citation_matcher below).
      job.citation_status = "skipped_encrypted";
      job.citation_note = "PDF terenkripsi, tidak bisa dibuka. Pemeriksaan sitasi dilewati; dimensi ini tidak dinilai.";
      await pushEvent(env, job, { stage: "reader", status: "skipped", detail: "PDF terenkripsi, tidak bisa dibuka" });
      return;
    }
    if (text) {
      // Deterministic parsing first, model second. References come
      // from the document tail parser (or footnote entries when no
      // tail section exists), never from the model; citations
      // come from code scanning the BODY (never the reference zone),
      // unioned with whatever the Reader model reports.
      const plainText = stripMarkerChars(text);
      const parsed = parseReferences(plainText);
      const plainBody = parsed.body && parsed.body.trim() ? parsed.body : plainText;
      const scanned = {
        author_year: scanAuthorYearCitations(plainBody),
        bracket: scanBracketCitations(plainBody),
        superscript: scanSuperscriptCitations(splitMarkedBody(text)),
      };
      job.scanned_citations = scanned;
      // Citing sentences for the Wonder cross-check (same class of
      // derived excerpt as the Reader's own quotes: one sentence per
      // cited key, used only to resolve ambiguous matches, never
      // returned as manuscript text and deleted with the job).
      job.citation_contexts = scanAuthorYearCitationContexts(plainBody);
      const providedCitations = job.citations || [];
      const providedReferences = job.references || [];
      if (parsed.status === "parsed") {
        job.references = parsed.entries;
        job.reference_keys = parsed.keys;
        job.reference_style = parsed.style;
        if (parsed.style === "footnote") job.footnote_repeats = parsed.footnote_repeats || 0;
        job.citation_status = "parsed";
        job.citation_note = null;
      } else if (providedReferences.length > 0) {
        job.reference_keys = null;
        job.reference_style = null;
        job.citation_status = "provided";
        job.citation_note = null;
      } else {
        job.references = [];
        job.reference_keys = null;
        job.reference_style = null;
        job.citation_status = "skipped_no_references";
        job.citation_note = parsed.note;
      }
      const scannedAll = [...new Set([...scanned.author_year, ...scanned.bracket, ...scanned.superscript])];
      if (!hasKey) {
        job.citations = [...new Set([...providedCitations, ...scannedAll])];
        await pushEvent(env, job, { stage: "reader", status: "skipped", detail: `MODEL_API_KEY not set. References parsed by code: ${job.references.length}, citations scanned by code: ${scannedAll.length}` });
      } else {
        const chunks = chunkText(plainBody);
        let merged = null;
        let failed = 0;
        for (const chunk of chunks) {
          const reader = await runAgent("reader", { text: chunk }, agentDeps);
          if (reader.data) merged = mergeReader(merged, reader.data);
          else failed++;
        }
        if (merged) {
          job.reader = merged;
          job.citations = [...new Set([...providedCitations, ...scannedAll, ...(merged.citations || [])])];
          job.reader_chunks = { total: chunks.length, failed };
          if (failed > 0) job.reader_chunks_failed = failed;
          await pushEvent(env, job, { stage: "reader", status: "done", detail: `Claims: ${merged.claims?.length ?? 0}, citations: ${job.citations.length}, references: ${job.references.length}, chunks: ${chunks.length}${failed ? `, failed chunks: ${failed}` : ""}` });
        } else {
          await pushEvent(env, job, { stage: "reader", status: "failed", detail: "Reader failed on every chunk" });
        }
      }
    } else {
      job.citation_status = (job.references || []).length > 0 ? "provided" : "skipped_no_references";
      if (job.citation_status === "skipped_no_references") job.citation_note = "No reference list was found in the document. Citation checking was skipped; this dimension is not scored.";
      await pushEvent(env, job, { stage: "reader", status: "done", detail: "Text split into sections" });
    }
    return;
  }
  if (stage === "citation_matcher") {
    // Deterministic, never a model. Mode is chosen from what was
    // actually found, never guessed:
    //  - author-year list -> match author-year keys.
    //  - footnote list -> match author-year keys. Footnote numbers
    //    restart per page, so they are never numeric keys, and body
    //    footnote markers are not citations into the list; the
    //    superscript scan is ignored in this mode (the author-year
    //    branch below uses the body author-year scan only).
    //  - numeric list + bracket citations -> match numbers.
    //  - numeric list + marked superscript -> match marked numbers.
    //  - numeric list + neither -> SKIP honestly. Bare numbers in
    //    plain text cannot be told apart from page numbers, years
    //    and counts, so matching them would manufacture findings.
    //  - no references at all -> SKIP with skipped_no_references.
    const refs = job.references || [];
    if (refs.length === 0) {
      // An encrypted PDF keeps its own skip status end to end: the
      // reason is the encryption, not a missing reference list.
      const encrypted = job.citation_status === "skipped_encrypted";
      if (!encrypted) job.citation_status = "skipped_no_references";
      job.citation_note = job.citation_note || "No reference list was found in the document. Citation checking was skipped; this dimension is not scored.";
      job.result = { missing: [], uncited: [], duplicates: [], status: encrypted ? "skipped_encrypted" : "skipped_no_references", note: job.citation_note };
      await pushEvent(env, job, { stage: "citation_matcher", status: "skipped", detail: job.citation_note, result: job.result });
      return;
    }
    const scanned = job.scanned_citations || {};
    let citedKeys, listedKeys, mode;
    if (job.reference_keys && job.reference_style === "numeric") {
      listedKeys = job.reference_keys;
      if ((scanned.bracket || []).length > 0) { mode = "numeric-bracket"; citedKeys = scanned.bracket; }
      else if ((scanned.superscript || []).length > 0) { mode = "numeric-superscript"; citedKeys = scanned.superscript; }
      else {
        job.citation_status = "skipped_superscript_unparsed";
        job.citation_note = "Citation checking was skipped: the reference list is numbered, but no bracketed citations and no marked superscript citations were found in the text, and bare numbers cannot be told apart from page numbers, years and counts. This dimension is not scored for citation matching; reference database checks still ran.";
        job.result = { missing: [], uncited: [], duplicates: [], status: "skipped_superscript_unparsed", note: job.citation_note };
        await pushEvent(env, job, { stage: "citation_matcher", status: "skipped", detail: job.citation_note, result: job.result });
        return;
      }
    } else if (job.reference_keys && (job.reference_style === "author-year" || job.reference_style === "footnote")) {
      listedKeys = job.reference_keys;
      // Cited keys come ONLY from code scanning the body. The Reader
      // model's citation strings are deliberately excluded here:
      // live they arrive in raw forms ("Bhattacharya et al., 2012",
      // "Serra & Kunc, 2015", whole multi-citation strings joined by
      // ";") that do not match listed keys and flooded the live
      // RISET job with 60+ false missing findings, while the body
      // scan alone gave the correct 5. A model citation is not
      // evidence of a body citation; the scan is.
      citedKeys = [...new Set(scanned.author_year || [])];
      mode = job.reference_style === "footnote" ? "footnote" : "author-year";
      // Parser author-year lists use last-word surname matching
      // (text "Souza" for listed "De Souza", "Bank" for "World Bank").
      // matchAuthorYearKeys returns missing/uncited directly, so
      // handle this mode before the generic _origMatch below.
      const ayMatched = matchAuthorYearKeys(citedKeys, listedKeys);
      // Wonder cross-check (sub-step of this stage, not a new stage:
      // the 7-stage room mapping stays intact). Only code-flagged
      // ambiguous cases reach Wonder; every proposal is validated by
      // code, and only accepted ones move a key out of missing/uncited
      // into "matched-by-crosscheck" — never into "verified".
      let missing = ayMatched.missing;
      let uncited = ayMatched.uncited;
      let crosscheck = { proposed: 0, accepted: [], rejected: [], abstained: [], skipped: null };
      if (ayMatched.ambiguous && ayMatched.ambiguous.length > 0) {
        if (hasKey) {
          const cc = await runCrosscheck(ayMatched.ambiguous, { listedKeys, refs, contexts: job.citation_contexts || [], agentDeps });
          crosscheck = cc;
          const accCited = new Set(cc.accepted.map((a) => a.cited));
          const accMatched = new Set(cc.accepted.map((a) => a.matched));
          missing = missing.filter((m) => !accCited.has(m));
          uncited = uncited.filter((u) => !accMatched.has(u));
        } else {
          crosscheck.skipped = "MODEL_API_KEY not set; ambiguous cases stay flagged.";
        }
      }
      job.result = { missing, uncited, duplicates: ayMatched.duplicates, ambiguous: ayMatched.ambiguous, crosscheck, status: "done", mode, ...(job.reference_style === "footnote" ? { footnote_repeats: job.footnote_repeats || 0 } : {}) };
      job.result.uncited_references = refs.filter((r, idx) => uncited.includes(listedKeys[idx]));
      job.citation_status = "done";
      job.citation_note = null;
      await pushEvent(env, job, { stage: "citation_matcher", status: "done", detail: `Missing: ${missing.length}, uncited: ${uncited.length}, duplicates: ${ayMatched.duplicates.length} (mode: ${mode}; crosscheck: ${crosscheck.proposed} proposed, ${crosscheck.accepted.length} accepted by code validation, ${crosscheck.rejected.length} rejected, ${crosscheck.abstained.length} abstained${crosscheck.skipped ? "; crosscheck skipped: no model key" : ""})`, result: job.result });
      return;
    } else {
      // Provided references have no parser keys, so ibid/op. cit.
      // entries arrive as raw keys ("ibid, 2021", "smith, op. cit.")
      // and must be resolved list-level before matching — and the
      // uncited display filter must compare resolved keys by index,
      // or resolved entries would vanish from the display list.
      listedKeys = resolveIbidKeys(refs.map(extractReferenceKey));
      citedKeys = (job.citations || []).map(normalizeKey);
      mode = "author-year";
    }
    const matched = _origMatch(citedKeys, listedKeys);
    job.result = { ...matched, status: "done", mode };
    if (mode.startsWith("numeric")) {
      job.result.uncited_references = refs.filter((r, idx) => matched.uncited.includes(listedKeys[idx]));
      // Truncated-list honesty (20-paper test: 435 parsed 13 of ~137,
      // 509 parsed 28 of ~76): when the body cites far beyond the end
      // of the parsed list, the tail was not parsed — merged entries
      // or an unrecognised format — so "missing" tail numbers are
      // unconfirmed, not proven absent. A gap under 5 is ordinary
      // missing references, not truncation.
      const nums = citedKeys.map(Number).filter(Number.isFinite);
      const maxCited = nums.length ? Math.max(...nums) : 0;
      if (maxCited - listedKeys.length >= 5) {
        job.result.list_truncated = true;
        job.result.list_note = `The parsed reference list ends at ${listedKeys.length}, but the body cites up to [${maxCited}]: the tail of the list was not parsed (merged entries or an unrecognised list format), so the ${matched.missing.length} "missing" numbers above are unconfirmed, not proven absent.`;
      }
    } else {
      job.result.uncited_references = refs.filter((r, idx) => matched.uncited.includes(listedKeys[idx]));
    }
    job.citation_status = "done";
    job.citation_note = null;
    await pushEvent(env, job, { stage: "citation_matcher", status: "done", detail: `Missing: ${matched.missing.length}, uncited: ${matched.uncited.length}, duplicates: ${matched.duplicates.length} (mode: ${mode})`, result: job.result });
    return;
  }
  if (stage === "reference_verifier") {
    // Resumable across polls (Wonder P5): a 200-reference paper cannot
    // be verified in one poll without either timing out or hammering
    // a rate-limited database. Each poll verifies the next batch of 8
    // references and reports "N/M checked"; the DO alarm re-runs this
    // stage (without advancing) while job.verifier_incomplete is set.
    // Order is DOI-bearing references first: Crossref DOI checks are
    // the ones that can actually reach "verified", and OpenAlex title
    // checks are what hits the 429 wall, so DOI work should not wait
    // behind 190 title lookups. DOI results are cached in KV for 30
    // days (verified only, Wonder #4 — never a rate-limit outcome,
    // or a transient limit would become permanent). On a 429 the loop
    // stops at once (no hammering) and later polls wait out an
    // exponential backoff (60s -> 300s -> 900s, Wonder #3) before
    // fetching again. Three labels stay strictly
    // separate: verified (Crossref DOI match) / candidate (OpenAlex
    // title match, escalated to Wonder) / inconclusive (database
    // rate limit — not a verdict on the reference).
    try {
      if (job.verifier_retry_after && job.verifier_retry_after > Date.now()) return;
      const refs = job.references || [];
      let prog = job.verifier_progress;
      if (!prog) {
        const order = refs.map((ref, i) => ({ i, doi: !!extractDOI(ref) }));
        order.sort((a, b) => (b.doi - a.doi) || (a.i - b.i));
        prog = { order: order.map((o) => o.i), pos: 0, verified: [], verified_venues: [], flagged: [], ambiguous: [], inconclusive: [] };
      }
      // Wonder #2: batch 8 -> 24, guarded by a ~20s wall-clock budget
      // (not by guesswork about per-ref latency). The budget is the
      // real guard: a batch must stay far under the 120s advancing
      // lock, and under persistent 429 the loop already exits on the
      // first limit hit, so a bigger batch costs nothing there.
      // At least one ref is always processed per batch (done > 0
      // check) so a single slow ref can never produce a zero-progress
      // poll.
      const cachedThisBatch = new Set();
      const BATCH_MAX = 24;
      const BATCH_BUDGET_MS = 20000;
      const batchStart = Date.now();
      let done = 0;
      let hitLimit = false;
      while (prog.pos < prog.order.length && done < BATCH_MAX) {
        if (done > 0 && Date.now() - batchStart > BATCH_BUDGET_MS) break;
        const ref = refs[prog.order[prog.pos]];
        const doi = extractDOI(ref);
        let v = null;
        if (doi && env.MARVA_JOBS) {
          try {
            const cached = await env.MARVA_JOBS.get(`verify:doi:${doi}`);
            if (cached) { const db = JSON.parse(cached); v = { reference: ref, status: db.status, db }; }
          } catch { v = null; }
        }
        if (!v) {
          v = await verifyReference(ref, fetchImpl, quota);
          if (v.status === "inconclusive") {
            prog.inconclusive.push({ reference: ref, reason: v.db?.reason || "rate limited" });
            prog.pos += 1;
            // Exponential backoff ladder (Wonder #3): a flat 60s retry
            // made the job burn ~3 KV puts per minute per rate-limited
            // reference while producing only inconclusive results.
            // Ladder 60s -> 300s -> 900s (capped) slows the burn rate
            // per hour; a clean batch resets it (see below). The
            // field is optional: jobs stored before this change have
            // no backoff_level and are treated as level 0, so the
            // running job 328 resumes at 60s, not at a cold start.
            const level = job.backoff_level || 0;
            const delays = [60, 300, 900];
            job.verifier_retry_after = Date.now() + delays[Math.min(level, delays.length - 1)] * 1000;
            job.backoff_level = level + 1;
            hitLimit = true;
            break;
          }
          // Wonder #4: cache ONLY exact-DOI verified results, never
          // candidate — caching a candidate would lock 30 days of
          // uncertainty behind a "verified-looking" cache hit. And
          // dedupe within the batch: a repeated DOI (duplicate
          // references, e.g. live job 328) must not pay for the same
          // cache write twice. (The read path above already returns
          // a cached DOI for later duplicates; this set covers the
          // case where the put itself is the first write.)
          if (doi && v.status === "verified" && env.MARVA_JOBS && !cachedThisBatch.has(doi)) {
            try { await env.MARVA_JOBS.put(`verify:doi:${doi}`, JSON.stringify(v.db), { expirationTtl: 30 * 24 * 3600 }); cachedThisBatch.add(doi); } catch {}
          }
        }
        if (v.status === "verified") {
          prog.verified.push(ref);
          // Venue trail for the journal stage (P6 fix, 2026-11-02):
          // Crossref container-title of this DOI-verified reference.
          // Additive only — verified stays a plain string list, and
          // refs without a journal name leave no venue entry (a venue
          // must never be guessed from the reference string).
          if (v.db?.journal) prog.verified_venues.push({ journal: v.db.journal, doi: doi || null, reference: ref });
        }
        else if (v.status === "candidate") prog.ambiguous.push({ reference: ref, db: v.db });
        else prog.flagged.push({ reference: ref, reason: v.db?.reason || "unresolved" });
        prog.pos += 1;
        done += 1;
      }
      // A batch with no 429 resets the backoff ladder: the next limit
      // hit starts again at 60s instead of inheriting a 900s wait
      // from an earlier, unrelated rate-limit episode.
      if (!hitLimit) job.backoff_level = 0;
      job.verifier_progress = prog;
      if (prog.pos < prog.order.length) {
        job.verifier_incomplete = true;
        // No saveJob here: pushEvent only buffers, and the DO alarm
        // persists everything with its single storage write. The
        // old extra save was the 4th put on the old KV path.
        await pushEvent(env, job, { stage: "reference_verifier", status: "running", detail: `Checked ${prog.pos}/${prog.order.length} references — verified: ${prog.verified.length}, flagged: ${prog.flagged.length}, ambiguous: ${prog.ambiguous.length}, inconclusive: ${prog.inconclusive.length}${hitLimit ? " (database rate limit reached; backing off before retrying)" : ""}` });
        return;
      }
      job.verifier_incomplete = false;
      job.verifier_retry_after = 0;
      job.backoff_level = 0;
      job.verifier_progress = null;
      job.verifier = { verified: prog.verified, verified_venues: prog.verified_venues || [], flagged: prog.flagged, ambiguous: prog.ambiguous.map((a) => a.reference), inconclusive: prog.inconclusive };
      if (prog.ambiguous.length > 0 && hasKey) {
        const esc = await escalateAmbiguous(prog.ambiguous.map((a) => a.reference), agentDeps);
        job.verifier.wonder_reviewed = esc.data || null;
        if (esc.error) job.verifier.wonder_error = esc.error;
      } else if (prog.ambiguous.length > 0) {
        job.verifier.wonder_reviewed = null;
      }
      await pushEvent(env, job, { stage: "reference_verifier", status: "done", detail: `Verified: ${prog.verified.length}, flagged: ${prog.flagged.length}, ambiguous: ${prog.ambiguous.length}, inconclusive: ${prog.inconclusive.length}` });
    } catch (e) {
      job.verifier = null;
      job.verifier_incomplete = false;
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
        job.strengthening = { skipped: true, reason: "No gap theories to search for", recommendations: [], quota: snapshotQuota(quota) };
        await pushEvent(env, job, { stage: "strengthening", status: "skipped", detail: "No gap theories to search for" });
      } else {
        // Reservation (quota.mjs): estimate the worst-case OpenAlex
        // cost BEFORE spending anything. If the job's usage plus
        // that estimate exceeds the budget, the stage is skipped
        // with reason "quota_reserved" — recorded in the report,
        // never a silent zero. With no budget configured
        // (budget 0), this check never fires and the stage runs
        // exactly as before.
        const budget = quotaBudget(env, deps);
        const check = checkStrengtheningQuota({ quota, budget, terms });
        if (check.reserved) {
          job.strengthening = { skipped: true, reason: "quota_reserved", recommendations: [], quota: snapshotQuota(quota), quota_budget: budget, quota_estimate: check.estimate };
          await pushEvent(env, job, { stage: "strengthening", status: "skipped", detail: `Strengthening skipped: OpenAlex quota reserved (used ${check.used}/${budget} OpenAlex calls, estimated cost ${check.estimate} for ${Math.min(terms.filter(Boolean).length, 2)} term(s))` });
        } else {
          job.strengthening = await searchStrengthening(terms, fetchImpl, quota);
          job.strengthening.quota = snapshotQuota(quota);
          await pushEvent(env, job, { stage: "strengthening", status: "done", detail: `Recommendations: ${job.strengthening.recommendations.length} (verified or candidate only), dropped unresolved: ${job.strengthening.dropped_unresolved}, dropped inconclusive: ${job.strengthening.dropped_inconclusive}` });
        }
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
          // Journal recommendations, submission version (P6 fix,
          // 2026-11-02) + field-candidate rehabilitation (2026-11-03):
          // naming comes ONLY from venues of this paper's own
          // DOI-verified references (threshold 2, citation trail).
          // OpenAlex field search runs again, but ONLY as an
          // additional candidate source: a field candidate is merely
          // annotated onto an already-named venue, and an unverified
          // field candidate is dropped in diagnostics, never named.
          // Field search uses the keyed fetch, and a field-search
          // failure is contained (field_search: "failed") — it never
          // fails the stage and never changes the named set.
          try {
            const venue = buildVenueRecommendations(job.verifier?.verified_venues || [], j.data.fields || []);
            let merged = null;
            try {
              const field = await buildJournalRecommendations(j.data.fields || [], fetchImpl);
              merged = mergeFieldCandidates(venue, field.recommendations || []);
            } catch {
              merged = null;
            }
            if (merged) {
              job.journal_recommendations = merged.recommendations;
              job.journal_diagnostics = merged.diagnostics;
            } else {
              job.journal_recommendations = venue.recommendations;
              job.journal_diagnostics = { ...venue.diagnostics, field_search: { status: "failed", reason: "Field search failed; citation-trail naming unaffected." } };
            }
          } catch {
            job.journal_recommendations = [];
            job.journal_diagnostics = null;
          }
          await pushEvent(env, job, { stage: "journal", status: "done", detail: `Fields: ${(j.data.fields || []).map((f) => f.name).join(", ") || "none"}; journal recommendations: ${(job.journal_recommendations || []).length} (citation-trail naming; field candidates corroborated: ${(job.journal_diagnostics?.field_search?.corroborated || []).length}, dropped unverified: ${(job.journal_diagnostics?.field_search?.dropped_unverified || []).length})` });
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

// Full pipeline, kept for tests: runs all stages sequentially in one
// call (no waitUntil). Production POST uses reader + DO alarms, not
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
    // Same explicit-save reason as the DO completion branch:
    // pushEvent buffers only, so persist the done status here.
    await saveJob(env, job);
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
          // The gate reads DO state, not the KV copy: after the DO
          // deploy the KV copy freezes at its post-Reader snapshot
          // and would read "running" forever, breaking the staleness
          // check. A missing DO record counts as stale.
          const activeJob = await doState(env, activeId).catch(() => null);
          const stale = !activeJob || activeJob.status !== "running" || (Date.now() - (activeJob.updatedAt || 0) > STALE_MS);
          if (!stale) return json({ error: "One job at a time for the demo", activeJobId: activeId }, 409);
          await saveActive(env, "");
        }
        let text = "";
        let pdf_note = null;
        let pdf_scanned = false;
        let pdf_encrypted = false;
        let extraction = null;
        if (typeof data.text === "string") text = data.text;
        else if (typeof data.pdfBase64 === "string") {
          try {
            // One analysis serves all three PDF concerns: encryption
            // (flag + explicit reason, never scanned), scanned
            // (flag + reason + citation skip below), and P7
            // extraction status (partial note + job record).
            const pdf = analyzePdf(base64ToBuffer(data.pdfBase64));
            text = pdf.text;
            extraction = pdf.extraction || null;
            if (pdf.encrypted) { pdf_encrypted = true; pdf_note = "PDF terenkripsi, tidak bisa dibuka"; }
            else if (pdf.scanned) { pdf_scanned = true; pdf_note = pdf.reason; }
            else if (!text) { pdf_note = "PDF text extraction returned no text; scanned-image PDFs are not readable by this extractor."; }
            else if (pdf.extraction && pdf.extraction.status === "partial") { pdf_note = `PDF extraction partial: ${pdf.extraction.reason}.`; }
          } catch (e) {
            if (e && e.code === "PDF_ENCRYPTED") {
              pdf_note = "PDF terenkripsi, tidak bisa dibuka";
              pdf_encrypted = true;
            } else {
              pdf_note = `PDF extraction failed: ${String(e.message || e).slice(0, 200)}`;
            }
          }
        }
        const job = {
          id: crypto.randomUUID(), status: "running", events: [],
          citations: Array.isArray(data.citations) ? data.citations : [],
          references: Array.isArray(data.references) ? data.references : [],
          reader: null, result: null, verifier: null, gap: null,
          journal: null, supervisor: null, strengthening: null,
          confirmed: false, next_stage: 1, advancing_until: 0,
          partial: false, pdf_note, pdf_scanned, ...(pdf_encrypted ? { pdf_encrypted: true } : {}), extraction, updatedAt: Date.now(),
        };
        // A scanned PDF has no text for the citation stage either:
        // record the skip reason up front so the report's References
        // dimension carries it (dimensions treat any "skipped*"
        // citation_status as unscored for citation matching).
        if (pdf_scanned) {
          job.citation_status = "skipped_scanned_pdf";
          job.citation_note = SCANNED_PDF_REASON;
        }
        await saveJob(env, job);
        await saveActive(env, job.id);
        // Step-wise: run Reader synchronously here (only stage that
        // needs the manuscript text, which is never persisted
        // anywhere). Later stages advance on DO alarms, not on
        // frontend polls — never use ctx.waitUntil for the pipeline:
        // it is capped at 30 seconds after the response, which kills
        // a 7-stage job mid-pipeline.
        try {
          await runStage(env, job, "reader", text, {});
        } catch (e) {
          await pushEvent(env, job, { stage: "reader", status: "failed", detail: String(e.message || e).slice(0, 300) });
        }
        job.next_stage = 1;
        await saveJob(env, job);
        // Hand the record to its Durable Object, which arms the first
        // alarm and drives the remaining stages itself. The KV copy
        // above stays as the migration/backup snapshot. If /init
        // fails, POST fails honestly (500) — the job is recoverable
        // via the 409 activeJobId path and the DO lazy-migrates the
        // KV copy on first access.
        await doCall(env, job.id, "/init", { method: "POST", body: JSON.stringify({ job }), headers: { "Content-Type": "application/json" } });
        return json({ jobId: job.id, status: job.status }, 201);
      }
      const eventsMatch = url.pathname.match(/^\/jobs\/([^/]+)\/events$/);
      if (request.method === "GET" && eventsMatch) {
        const job = await doState(env, eventsMatch[1]);
        if (!job) return json({ error: "Job not found" }, 404);
        // Read-only since the DO migration: the frontend polls this
        // every 2 seconds and renders new events, but progress is
        // driven by DO alarms, not by polls. /kick is the
        // self-healing net: if a running job somehow has no alarm
        // scheduled (failed init, lost alarm), this poll re-arms it.
        if (job.status === "running") {
          await doCall(env, eventsMatch[1], "/kick", { method: "POST" }).catch(() => null);
        }
        return json({ jobId: job.id, status: job.status, events: job.events || [] });
      }
      const reportJsonMatch = url.pathname.match(/^\/jobs\/([^/]+)\/report\.json$/);
      if (request.method === "GET" && reportJsonMatch) {
        const job = await doState(env, reportJsonMatch[1]);
        if (!job) return json({ error: "Job not found" }, 404);
        return json(buildReport(job));
      }
      const reportHtmlMatch = url.pathname.match(/^\/jobs\/([^/]+)\/report\.html$/);
      if (request.method === "GET" && reportHtmlMatch) {
        const job = await doState(env, reportHtmlMatch[1]);
        if (!job) return json({ error: "Job not found" }, 404);
        return new Response(buildReportHTML(buildReport(job)), { status: 200, headers: { "Content-Type": "text/html; charset=utf-8", ...CORS } });
      }
      const reportPdfMatch = url.pathname.match(/^\/jobs\/([^/]+)\/report\.pdf$/);
      if (request.method === "GET" && reportPdfMatch) {
        const job = await doState(env, reportPdfMatch[1]);
        if (!job) return json({ error: "Job not found" }, 404);
        return new Response(buildReportPDF(buildReport(job)), { status: 200, headers: { "Content-Type": "application/pdf", ...CORS } });
      }
      const confirmMatch = url.pathname.match(/^\/jobs\/([^/]+)\/confirm$/);
      if (request.method === "POST" && confirmMatch) {
        let data = {};
        try { data = await request.json(); } catch { return json({ error: "Body must be JSON" }, 400); }
        if (data.confirmed !== true) return json({ error: "confirmed must be true" }, 400);
        const res = await doCall(env, confirmMatch[1], "/confirm", { method: "POST" });
        if (!res) return json({ error: "Job not found" }, 404);
        return json(res);
      }
      const jobMatch = url.pathname.match(/^\/jobs\/([^/]+)$/);
      if (request.method === "GET" && jobMatch) {
        const job = await doState(env, jobMatch[1]);
        if (!job) return json({ error: "Job not found" }, 404);
        return json(publicJob(job));
      }
      if (request.method === "DELETE" && jobMatch) {
        const job = await doState(env, jobMatch[1]);
        if (!job) return json({ error: "Job not found" }, 404);
        await doCall(env, jobMatch[1], "/delete", { method: "POST" }).catch(() => null);
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
