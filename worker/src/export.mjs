// Export builder, ported from backend/src/lib/export.mjs.
// Code, not a model: the report structure is fixed, so nothing in the
// export can invent a finding.
// Export NEVER contains: full manuscript text, a plagiarism percentage,
// an unverified reference written as certain, or a journal written as
// Scopus-indexed when its status is unverified.
import { mapDiagnosticToDimensions } from "./dimensions.mjs";

export function buildReport(job) {
  const r = job.result || {};
  const confirmed = job.confirmed === true;
  return {
    product: "MARVA",
    jobId: job.id,
    status: job.status,
    confirmed,
    held_until_confirmation: !confirmed,
    confirmation_note: confirmed
      ? "The author has confirmed the references in this report."
      : "Final report held until the author confirms references: the author must review and confirm every reference (POST /jobs/:id/confirm) before this report is treated as final. Confirmation records the author's review; it does not verify a reference or a journal by itself.",
    diagnostic: job.supervisor || null,
    dimensions: mapDiagnosticToDimensions(job),
    citation_flags: { missing: r.missing || [], uncited: r.uncited || [], duplicates: r.duplicates || [] },
    reader_summary: job.reader ? { claims: job.reader.claims?.length ?? 0, theories: job.reader.theories?.length ?? 0, quotes: job.reader.quotes?.length ?? 0 } : null,
    verifier: job.verifier || null,
    gap: job.gap || null,
    journal: job.journal || null,
    journal_recommendations: job.journal_recommendations || [],
    strengthening_references: job.strengthening ? job.strengthening.recommendations || [] : null,
    fixes: job.supervisor?.fixes || [],
    quality_gate: job.quality_gate || null,
    partial: !!job.partial,
    limitations: [
      "MARVA does not guarantee acceptance at any journal.",
      "Unverified references and journals are labelled unverified, never certain.",
      "The author confirms every reference before it enters a bibliography.",
    ],
    ai_disclosure: "This report was produced by an automated pre-submission audit. The author remains responsible for all revisions.",
  };
}

export function buildReportHTML(report) {
  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const dims = (report.dimensions || []).map((d) => `<h3>${esc(d.dimension)} (${d.count})</h3>${d.note ? `<p>${esc(d.note)}</p>` : ""}<pre>${esc(JSON.stringify(d.items, null, 2))}</pre>`).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><title>MARVA Report</title></head><body><h1>MARVA Report</h1><p>Job: ${esc(report.jobId)}</p><p>Author confirmed: ${report.confirmed ? "yes" : "no"}</p><p>${esc(report.confirmation_note || "")}</p><h2>Per-dimension diagnostic</h2>${dims}<h2>Citation flags</h2><pre>${esc(JSON.stringify(report.citation_flags, null, 2))}</pre><h2>Diagnostic</h2><pre>${esc(JSON.stringify(report.diagnostic, null, 2))}</pre><h2>Strengthening references (verified or candidate only)</h2><pre>${esc(JSON.stringify(report.strengthening_references, null, 2))}</pre><h2>Limitations</h2><ul>${report.limitations.map((l) => `<li>${esc(l)}</li>`).join("")}</ul><p>${esc(report.ai_disclosure)}</p></body></html>`;
}

// Minimal PDF export, same text-summary shape as backend-node.
// Printable summary, Helvetica, no compression. Works in Workers
// with nodejs_compat (Buffer available); falls back to a latin1
// string encoded as bytes if Buffer is missing.
export function buildReportPDF(report) {
  const lines = [];
  lines.push("MARVA Report");
  lines.push(`Job: ${report.jobId}`);
  lines.push(`Author confirmed: ${report.confirmed ? "yes" : "no"}`);
  lines.push(report.confirmation_note || "");
  lines.push("");
  for (const d of report.dimensions || []) {
    lines.push(`${d.dimension} (${d.count})`);
    if (d.note) lines.push(d.note);
    for (const it of d.items) lines.push(`- ${it.finding || ""}`);
    lines.push("");
  }
  lines.push("Citation flags:");
  lines.push(JSON.stringify(report.citation_flags || {}));
  lines.push("");
  lines.push("Fixes:");
  for (const f of report.fixes || []) lines.push(`[${f.priority || ""}] ${f.action || ""}`);
  lines.push("");
  lines.push("MARVA does not guarantee acceptance at any journal.");
  const escText = (s) => String(s).replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)").slice(0, 180);
  const wrapped = [];
  for (const line of lines) {
    let rest = line;
    while (rest.length > 95) { wrapped.push(rest.slice(0, 95)); rest = rest.slice(95); }
    wrapped.push(rest);
  }
  const perPage = 45;
  const pages = [];
  for (let i = 0; i < wrapped.length; i += perPage) pages.push(wrapped.slice(i, i + perPage));
  if (pages.length === 0) pages.push(["(empty report)"]);
  const objects = [];
  const pageObjIds = pages.map((_, i) => 3 + i * 2);
  const contentObjIds = pages.map((_, i) => 4 + i * 2);
  const fontId = 3 + pages.length * 2;
  objects.push(`1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n`);
  objects.push(`2 0 obj\n<< /Type /Pages /Kids [${pageObjIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>\nendobj\n`);
  pages.forEach((pageLines, i) => {
    const stream = pageLines.map((l, j) => `BT /F1 11 Tf 36 ${760 - j * 16} Td (${escText(l)}) Tj ET`).join("\n");
    objects.push(`${pageObjIds[i]} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${contentObjIds[i]} 0 R /Resources << /Font << /F1 ${fontId} 0 R >> >> >>\nendobj\n`);
    objects.push(`${contentObjIds[i]} 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}\nendstream\nendobj\n`);
  });
  objects.push(`${fontId} 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n`);
  let pdf = "%PDF-1.4\n";
  const offsets = [];
  for (const obj of objects) { offsets.push(pdf.length); pdf += obj; }
  const xrefPos = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += `${String(off).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`;
  if (typeof Buffer !== "undefined") return Buffer.from(pdf, "latin1");
  const bytes = new Uint8Array(pdf.length);
  for (let i = 0; i < pdf.length; i++) bytes[i] = pdf.charCodeAt(i) & 0xff;
  return bytes;
}
