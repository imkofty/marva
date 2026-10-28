// Per-dimension diagnostic mapping — code, not a model.
// Dimensions are exactly the diagram's five: Clarity, Rigor, Novelty,
// References, Suitability. An item lands in a dimension ONLY when a
// real finding maps to it (supervisor diagnostic item, verifier flag,
// gap theory, matcher flag, or journal field). A dimension with no
// real finding is returned with items: [] and an explicit note that
// nothing was mapped — it is never filled with an invented finding
// and never presented as scored.
export const DIMENSIONS = ["Clarity", "Rigor", "Novelty", "References", "Suitability"];

function hasAny(haystack, words) {
  const s = String(haystack || "").toLowerCase();
  return words.some((w) => s.includes(w));
}

function mapItem(item) {
  const text = `${item.dimension || ""} ${item.finding || ""} ${item.evidence || ""} ${item.action || ""}`;
  const d = String(item.dimension || "").toLowerCase();
  if (d === "clarity" || d === "rigor" || d === "novelty" || d === "references" || d === "suitability") {
    return d.charAt(0).toUpperCase() + d.slice(1);
  }
  if (hasAny(text, ["citation", "reference", "doi", "bibliograph", "uncited", "missing citation"])) return "References";
  if (hasAny(text, ["claim", "method", "sample", "control group", "outdated", "evidence", "statistic", "yield"])) return "Rigor";
  if (hasAny(text, ["theory", "rival", "gap", "novel", "original"])) return "Novelty";
  if (hasAny(text, ["structure", "heading", "clarity", "unclear", "section", "abstract"])) return "Clarity";
  if (hasAny(text, ["journal", "scope", "field", "audience"])) return "Suitability";
  return null;
}

export function mapDiagnosticToDimensions(job) {
  const buckets = Object.fromEntries(DIMENSIONS.map((d) => [d, []]));
  const push = (dim, item) => { if (dim && buckets[dim]) buckets[dim].push(item); };
  // When citation matching was skipped, citation findings must not
  // appear as if they were checked. Supervisor items mapped to
  // References and matcher items are excluded; verifier database
  // flags are kept (they are real database checks, not citation
  // matching) and the skip note is carried on the dimension below.
  const citationSkipped = String(job.citation_status || "").startsWith("skipped");

  const supervisorItems = job.supervisor?.diagnostic || [];
  for (const item of supervisorItems) {
    const dim = mapItem(item);
    if (dim && !(citationSkipped && dim === "References")) push(dim, { finding: item.finding, evidence: item.evidence || null, location: item.location || null, source: "supervisor" });
  }
  for (const fix of job.supervisor?.fixes || []) {
    const dim = mapItem(fix);
    if (dim && fix.priority === "must-fix" && !(citationSkipped && dim === "References")) push(dim, { finding: fix.action, evidence: fix.evidence || null, source: "supervisor-fix" });
  }
  if (!citationSkipped) {
    for (const m of job.result?.missing || []) push("References", { finding: `Missing citation: ${m}`, evidence: "cited in text, absent from reference list", source: "deterministic-matcher" });
    for (const u of job.result?.uncited || []) push("References", { finding: `Uncited reference: ${u}`, evidence: "in reference list, never cited in text", source: "deterministic-matcher" });
  }
  for (const f of job.verifier?.flagged || []) push("References", { finding: `Flagged reference: ${f.reference}`, evidence: f.reason || "database check did not verify it", source: "reference-verifier" });
  for (const t of job.gap?.missing_theories || []) push("Novelty", { finding: `Missing theory: ${t.name}`, evidence: t.why || null, source: "gap-assessor" });
  for (const t of job.gap?.rival_theories || []) push("Novelty", { finding: `Rival theory not discussed: ${t.name}`, evidence: t.why || null, source: "gap-assessor" });
  for (const r of job.gap?.outdated_references || []) push("Rigor", { finding: `Outdated reference: ${r}`, evidence: "gap assessor flagged as outdated", source: "gap-assessor" });
  for (const f of job.journal?.fields || []) push("Suitability", { finding: `Classified field: ${f.name}`, evidence: f.evidence || null, source: "journal-matcher" });
  for (const rec of job.journal_recommendations || []) push("Suitability", { finding: `Journal candidate (scope evidence only): ${rec.journal}`, evidence: `Recent OpenAlex works in ${rec.scope_evidence.fields.join(", ")}`, source: "journal-evidence" });

  return DIMENSIONS.map((d) => {
    if (d === "References" && citationSkipped) {
      return {
        dimension: d,
        items: buckets[d],
        count: buckets[d].length,
        note: (job.citation_note || "Citation checking was skipped; this dimension is not scored for citation matching.") + (buckets[d].length > 0 ? " Reference database checks still ran and their flags are listed above." : ""),
      };
    }
    return {
      dimension: d,
      items: buckets[d],
      count: buckets[d].length,
      ...(buckets[d].length === 0 ? { note: "No finding in this job mapped to this dimension. This dimension is not scored and no finding was invented for it." } : {}),
    };
  });
}
