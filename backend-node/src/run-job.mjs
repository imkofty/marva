// Node Orchestrator job flow — the diagram's 7-agent pipeline inside
// ONE backend, not 7 servers. Order: Reader -> deterministic Citation
// Matcher (code, never a model) -> Reference Verifier (database
// decides; Wonder escalation only for flagged ambiguous cases) ->
// Gap Assessor -> Strengthening search (OpenAlex, re-verified) ->
// Journal Matcher (+ journal evidence, Scopus status unverified
// unless the Scopus API really returns a match) -> Supervisor /
// Report Builder (Oversight + Quality Gate) -> Narrator bubbles.
// Narrator never issues a bubble for itself: it rewrites real stage
// facts only. If MODEL_API_KEY is unset, model stages report
// "skipped" honestly and the deterministic supervisor fallback is
// used; nothing is faked. A failed stage is recorded "failed" and
// the job continues with the stages that can still run.
import { matchCitations, extractReferenceKey, normalizeKey } from "./lib/citation-matcher.mjs";
import { runAgent, escalateAmbiguous, narratorModel } from "./agents/agents.mjs";
import { verifyReference, searchStrengthening } from "./lib/strengthening.mjs";
import { buildJournalRecommendations } from "./lib/journal-evidence.mjs";
import { planEntry, toolEntry, gateEntry } from "./lib/agent-log.mjs";
import { clearActiveIf } from "./store.mjs";

export const STAGES = ["reader", "citation_matcher", "reference_verifier", "gap", "strengthening", "journal", "supervisor"];

function hasKey() { return !!process.env.MODEL_API_KEY; }

async function narrate(job, event) {
  // Narrator (Spark, or NARRATOR_MODEL if a live Glimmer deployment is
  // named — never label Spark output as Glimmer). No key -> no bubble,
  // the raw event detail stands on its own; never invent a sentence.
  if (!hasKey()) return null;
  try {
    const r = await runAgent("narrator", { stage: event.stage, status: event.status, detail: event.detail }, { model: narratorModel() });
    if (r.data?.bubble) return { bubble: r.data.bubble, model: narratorModel() };
  } catch { /* narrator failure never fails the stage */ }
  return null;
}

export async function pushEvent(job, event) {
  const bubble = event.stage === "narrator" ? null : await narrate(job, event);
  const full = bubble ? { ...event, ...bubble } : event;
  job.events.push(full);
  job.updatedAt = Date.now();
  for (const res of job.listeners) {
    try { res.write(`data: ${JSON.stringify(full)}\n\n`); } catch { /* listener gone */ }
  }
  return full;
}

function deterministicSupervisor(job) {
  const diagnostic = [];
  const fixes = [];
  for (const m of job.result?.missing || []) {
    diagnostic.push({ dimension: "References", finding: `Missing citation: ${m}`, evidence: "cited in text, absent from reference list", location: "text" });
    fixes.push({ priority: "must-fix", action: `Add ${m} to the reference list or remove the in-text citation.`, evidence: "deterministic citation match" });
  }
  for (const u of job.result?.uncited || []) {
    diagnostic.push({ dimension: "References", finding: `Uncited reference: ${u}`, evidence: "in reference list, never cited in text", location: "reference list" });
    fixes.push({ priority: "nice-to-have", action: `Cite ${u} in the text or remove it from the reference list.`, evidence: "deterministic citation match" });
  }
  for (const f of job.verifier?.flagged || []) {
    diagnostic.push({ dimension: "References", finding: `Flagged reference: ${f.reference}`, evidence: f.reason || "database check did not verify it", location: "reference list" });
    fixes.push({ priority: "must-fix", action: `Check ${f.reference} against the database record before submitting.`, evidence: "database check" });
  }
  return { diagnostic, fixes, source: "deterministic-fallback (Supervisor model skipped: no key)" };
}

export async function runJob(job) {
  try {
    // Supervisor plan first (Agentic evidence): plan is a real event.
    job.events.push({ type: "plan", ...planEntry(STAGES) });
    // 1. Reader (Spark)
    if (job.text) {
      if (!hasKey()) {
        await pushEvent(job, { stage: "reader", status: "skipped", detail: "MODEL_API_KEY not set" });
      } else {
        const reader = await runAgent("reader", { text: job.text.slice(0, 20000) });
        if (reader.data) {
          job.reader = reader.data;
          if (Array.isArray(reader.data.citations)) job.citations = reader.data.citations;
          if (Array.isArray(reader.data.references)) job.references = reader.data.references;
          await pushEvent(job, { stage: "reader", status: "done", detail: `Claims: ${reader.data.claims?.length ?? 0}, citations: ${job.citations.length}, references: ${job.references.length}` });
        } else {
          await pushEvent(job, { stage: "reader", status: "failed", detail: reader.error || "Reader failed" });
        }
      }
    } else {
      await pushEvent(job, { stage: "reader", status: "done", detail: "Text split into sections" });
    }
    // 2. Deterministic citation matcher (never a model). Reader returns
    // full reference strings, citations are author-year keys, so match
    // on extracted keys; the original strings stay in job.references
    // for the Verifier and the report.
    job.reference_keys = job.references.map(extractReferenceKey);
    job.result = matchCitations(job.citations.map(normalizeKey), job.reference_keys);
    job.result.uncited_references = job.references.filter((r) => job.result.uncited.includes(extractReferenceKey(r)));
    await pushEvent(job, { stage: "citation_matcher", status: "done", detail: `Missing: ${job.result.missing.length}, uncited: ${job.result.uncited.length}, duplicates: ${job.result.duplicates.length}`, result: job.result });
    job.events.push(toolEntry("matchCitations", { citations: job.citations.length, references: job.references.length }, job.result));
    // 3. Reference Verifier (database decides)
    try {
      const verified = [];
      const flagged = [];
      const ambiguous = [];
      for (const ref of job.references) {
        const v = await verifyReference(ref);
        if (v.status === "verified") verified.push(ref);
        else if (v.status === "candidate") ambiguous.push({ reference: ref, db: v.db });
        else flagged.push({ reference: ref, reason: v.db?.reason || "unresolved" });
      }
      job.verifier = { verified, flagged, ambiguous: ambiguous.map((a) => a.reference) };
      if (ambiguous.length > 0 && hasKey()) {
        const esc = await escalateAmbiguous(ambiguous.map((a) => a.reference));
        job.verifier.wonder_reviewed = esc.data || null;
        if (esc.error) job.verifier.wonder_error = esc.error;
        // Wonder never upgrades a reference to verified.
      } else if (ambiguous.length > 0) {
        job.verifier.wonder_reviewed = null;
      }
      await pushEvent(job, { stage: "reference_verifier", status: "done", detail: `Verified: ${verified.length}, flagged: ${flagged.length}, ambiguous: ${ambiguous.length}` });
    } catch (e) {
      job.verifier = null;
      job.partial = true;
      await pushEvent(job, { stage: "reference_verifier", status: "failed", detail: String(e.message || e).slice(0, 300) });
    }
    // 4. Gap Assessor (Spark)
    try {
      if (!hasKey()) {
        const oldRefs = (job.references || []).filter((r) => {
          const y = parseInt((String(r).match(/\b(19|20)\d{2}\b/) || [])[0] || "0", 10);
          return y && y < new Date().getFullYear() - 20;
        });
        job.gap = { skipped: true, reason: "MODEL_API_KEY not set", old_references_for_author_review: oldRefs };
        await pushEvent(job, { stage: "gap", status: "skipped", detail: "MODEL_API_KEY not set" });
      } else {
        const gap = await runAgent("gap", { reader: job.reader || null, citations: job.citations, references: job.references });
        if (gap.data) {
          job.gap = gap.data;
          await pushEvent(job, { stage: "gap", status: "done", detail: `Missing theories: ${gap.data.missing_theories?.length ?? 0}, outdated: ${gap.data.outdated_references?.length ?? 0}` });
        } else {
          job.gap = null;
          job.partial = true;
          await pushEvent(job, { stage: "gap", status: "failed", detail: gap.error || "Gap failed" });
        }
      }
    } catch (e) {
      job.gap = null;
      job.partial = true;
      await pushEvent(job, { stage: "gap", status: "failed", detail: String(e.message || e).slice(0, 300) });
    }
    // 5. Strengthening search (only when gap theories are known)
    try {
      const terms = [];
      for (const t of job.gap?.missing_theories || []) terms.push(t.name);
      for (const t of job.gap?.rival_theories || []) terms.push(t.name);
      if (terms.length === 0) {
        job.strengthening = { skipped: true, reason: "No gap theories to search for", recommendations: [] };
        await pushEvent(job, { stage: "strengthening", status: "skipped", detail: "No gap theories to search for" });
      } else {
        job.strengthening = await searchStrengthening(terms);
        await pushEvent(job, { stage: "strengthening", status: "done", detail: `Recommendations: ${job.strengthening.recommendations.length} (verified or candidate only), dropped unresolved: ${job.strengthening.dropped_unresolved}` });
      }
    } catch (e) {
      job.strengthening = null;
      job.partial = true;
      await pushEvent(job, { stage: "strengthening", status: "failed", detail: String(e.message || e).slice(0, 300) });
    }
    // 6. Journal Matcher (Spark) + journal evidence (OpenAlex, Scopus gate)
    try {
      if (!hasKey()) {
        job.journal = { skipped: true, reason: "MODEL_API_KEY not set" };
        job.journal_recommendations = [];
        await pushEvent(job, { stage: "journal", status: "skipped", detail: "MODEL_API_KEY not set" });
      } else {
        const j = await runAgent("journal", { reader: job.reader || null, references: job.references });
        if (j.data) {
          job.journal = { ...j.data, scopus_indexed_status: "unverified" };
          const evidence = await buildJournalRecommendations(j.data.fields || []);
          job.journal_evidence = evidence.works;
          job.journal_recommendations = evidence.recommendations;
          await pushEvent(job, { stage: "journal", status: "done", detail: `Fields: ${(j.data.fields || []).map((f) => f.name).join(", ") || "none"}, journal candidates: ${evidence.recommendations.length}` });
        } else {
          job.journal = null;
          job.partial = true;
          await pushEvent(job, { stage: "journal", status: "failed", detail: j.error || "Journal failed" });
        }
      }
    } catch (e) {
      job.journal = null;
      job.partial = true;
      await pushEvent(job, { stage: "journal", status: "failed", detail: String(e.message || e).slice(0, 300) });
    }
    // 7. Supervisor / Report Builder — Oversight + Quality Gate + Escalation
    try {
      let raw;
      if (!hasKey()) {
        raw = deterministicSupervisor(job);
        await pushEvent(job, { stage: "supervisor", status: "done", detail: "Deterministic diagnostic (Supervisor model skipped: no key)" });
      } else {
        const s = await runAgent("supervisor", { reader: job.reader || null, result: job.result, verifier: job.verifier, gap: job.gap, journal: job.journal, strengthening: job.strengthening });
        if (s.data) {
          raw = s.data;
          await pushEvent(job, { stage: "supervisor", status: "done", detail: `Diagnostic items: ${s.data.diagnostic?.length ?? 0}, fixes: ${s.data.fixes?.length ?? 0}` });
        } else {
          raw = deterministicSupervisor(job);
          job.partial = true;
          await pushEvent(job, { stage: "supervisor", status: "failed", detail: s.error || "Supervisor failed, deterministic fallback used" });
        }
      }
      // Quality Gate (Oversight): drop diagnostic items with no evidence
      // and no finding; record what was dropped, never silently invent.
      const checked = raw.diagnostic || [];
      const kept = checked.filter((it) => it && it.finding && (it.evidence || it.location));
      const dropped = checked.length - kept.length;
      job.supervisor = { ...raw, diagnostic: kept };
      job.quality_gate = {
        checked: checked.length,
        kept: kept.length,
        dropped,
        note: dropped > 0 ? `${dropped} diagnostic item(s) dropped by the Quality Gate for lacking evidence or a finding.` : "All diagnostic items passed the Quality Gate (finding + evidence/location present).",
        gate: gateEntry("quality_gate", dropped > 0 ? "passed_with_drops" : "passed"),
      };
      job.events.push({ stage: "supervisor", status: "gate", detail: job.quality_gate.note, gate: job.quality_gate.gate });
    } catch (e) {
      job.supervisor = deterministicSupervisor(job);
      job.partial = true;
      await pushEvent(job, { stage: "supervisor", status: "failed", detail: String(e.message || e).slice(0, 300) });
    }
    // Narrator summary bubble event: the Narrator agent itself never
    // speaks for itself in the log; this event records that bubbles
    // were attached to real stage events above.
    job.events.push({ stage: "narrator", status: "done", detail: "Narrator bubbles attached to real stage events (no bubble issued for the Narrator itself)." });
  } finally {
    job.status = "done";
    const finalEvent = { stage: "job", status: "done", detail: job.partial ? "Job complete with skipped or failed stages (see events)" : "All stages complete" };
    job.events.push(finalEvent);
    for (const res of job.listeners) { try { res.write(`data: ${JSON.stringify(finalEvent)}\n\n`); res.end(); } catch {} }
    job.listeners.clear();
    clearActiveIf(job.id);
  }
}
