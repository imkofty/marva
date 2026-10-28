// MARVA Backend Node Orchestrator — diagram-exact server.
// Node standard library only, no paid dependencies, no build step.
// One backend holds the 7-agent pipeline (see run-job.mjs); this file
// is only the HTTP surface: generic Job Queue (one job at a time for
// the demo, 409 while one is active), real SSE live streaming, and
// the report / confirmation / delete / history endpoints.
// Secrets come from env only (MODEL_API_KEY, SCOPUS_API_KEY). The
// manuscript text is never returned by any GET endpoint and never
// persisted: DELETE removes the job entirely.
// Body limit: 50 MB (the diagram's "Max. 50MB"). A Content-Length
// above the limit is rejected with 413 before the body is read; a
// body that grows past the limit while streaming is also rejected.
import { createServer as createHttpServer } from "node:http";
import { randomUUID } from "node:crypto";
import { extractTextFromPdf } from "./lib/pdf.mjs";
import { buildReport, buildReportHTML, buildReportPDF } from "./lib/export.mjs";
import { jobs, activeJobId, setActiveJobId, clearActiveIf, publicJob, historyEntry } from "./store.mjs";
import { runJob } from "./run-job.mjs";
import { SYNTHETIC_DEMO } from "./demo.mjs";

export const MAX_BODY_BYTES = 50 * 1024 * 1024;

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
  res.end(JSON.stringify(body));
}

function rejectTooLarge(req, res) {
  // The request body is incomplete (declared above the limit, or grew
  // past it), so the keep-alive socket must NOT be reused for the next
  // request — without Connection: close the agent reuses it and the
  // next request fails with ECONNRESET ("socket hang up").
  res.writeHead(413, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", Connection: "close" });
  res.end(JSON.stringify({ error: "Body exceeds 50MB limit" }));
  req.resume();
}

async function readBody(req, res) {
  const declared = Number(req.headers["content-length"] || 0);
  if (declared > MAX_BODY_BYTES) { rejectTooLarge(req, res); return null; }
  let body = "";
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) { rejectTooLarge(req, res); return null; }
    body += chunk;
  }
  return body;
}

export function createServer() {
  return createHttpServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (req.method === "OPTIONS") {
      res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" });
      res.end();
      return;
    }
    try {
      // One-click synthetic demo: cached diagnostic, no key, no model call.
      if (req.method === "GET" && url.pathname === "/demo/synthetic") { json(res, 200, SYNTHETIC_DEMO); return; }
      // Real job history (for Upload History): public entries only, never text.
      if (req.method === "GET" && url.pathname === "/jobs") {
        const list = [...jobs.values()].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).map(historyEntry);
        json(res, 200, { jobs: list }); return;
      }
      if (req.method === "POST" && url.pathname === "/jobs") {
        if (activeJobId) {
          const active = jobs.get(activeJobId);
          if (active && active.status === "running") { json(res, 409, { error: "One job at a time for the demo", activeJobId }); return; }
          clearActiveIf(activeJobId);
        }
        const body = await readBody(req, res);
        if (body === null) return;
        let data;
        try { data = JSON.parse(body); } catch { json(res, 400, { error: "Body must be JSON" }); return; }
        if (!data || typeof data !== "object") { json(res, 400, { error: "Body must be JSON" }); return; }
        let text = "";
        let pdf_note = null;
        if (typeof data.text === "string") text = data.text;
        else if (typeof data.pdfBase64 === "string") {
          try {
            text = extractTextFromPdf(Buffer.from(data.pdfBase64, "base64"));
            if (!text) pdf_note = "PDF text extraction returned no text; scanned-image and encrypted PDFs are not readable by this extractor.";
          } catch (e) { pdf_note = `PDF extraction failed: ${String(e.message || e).slice(0, 200)}`; }
        }
        const job = {
          id: randomUUID(), status: "running", events: [], listeners: new Set(),
          text,
          citations: Array.isArray(data.citations) ? data.citations : [],
          references: Array.isArray(data.references) ? data.references : [],
          reader: null, result: null, verifier: null, gap: null,
          journal: null, journal_recommendations: [], journal_evidence: null,
          supervisor: null, strengthening: null, quality_gate: null,
          confirmed: false, partial: false, pdf_note,
          createdAt: Date.now(), updatedAt: Date.now(),
        };
        jobs.set(job.id, job);
        setActiveJobId(job.id);
        json(res, 201, { jobId: job.id, status: job.status });
        runJob(job);
        return;
      }
      const eventsMatch = url.pathname.match(/^\/jobs\/([^/]+)\/events$/);
      if (req.method === "GET" && eventsMatch) {
        const job = jobs.get(eventsMatch[1]);
        if (!job) { json(res, 404, { error: "Job not found" }); return; }
        const wantsSSE = (req.headers.accept || "").includes("text/event-stream");
        if (!wantsSSE) { json(res, 200, { jobId: job.id, status: job.status, events: job.events }); return; }
        // Real SSE: replay real past events, then stream new ones live.
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "Access-Control-Allow-Origin": "*" });
        for (const e of job.events) res.write(`data: ${JSON.stringify(e)}\n\n`);
        if (job.status === "done") { res.end(); return; }
        job.listeners.add(res);
        req.on("close", () => job.listeners.delete(res));
        return;
      }
      const reportJsonMatch = url.pathname.match(/^\/jobs\/([^/]+)\/report\.json$/);
      if (req.method === "GET" && reportJsonMatch) {
        const job = jobs.get(reportJsonMatch[1]);
        if (!job) { json(res, 404, { error: "Job not found" }); return; }
        json(res, 200, buildReport(job)); return;
      }
      const reportHtmlMatch = url.pathname.match(/^\/jobs\/([^/]+)\/report\.html$/);
      if (req.method === "GET" && reportHtmlMatch) {
        const job = jobs.get(reportHtmlMatch[1]);
        if (!job) { json(res, 404, { error: "Job not found" }); return; }
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Access-Control-Allow-Origin": "*" });
        res.end(buildReportHTML(buildReport(job))); return;
      }
      const reportPdfMatch = url.pathname.match(/^\/jobs\/([^/]+)\/report\.pdf$/);
      if (req.method === "GET" && reportPdfMatch) {
        const job = jobs.get(reportPdfMatch[1]);
        if (!job) { json(res, 404, { error: "Job not found" }); return; }
        const pdf = buildReportPDF(buildReport(job));
        res.writeHead(200, { "Content-Type": "application/pdf", "Content-Length": pdf.length, "Access-Control-Allow-Origin": "*" });
        res.end(pdf); return;
      }
      const confirmMatch = url.pathname.match(/^\/jobs\/([^/]+)\/confirm$/);
      if (req.method === "POST" && confirmMatch) {
        const job = jobs.get(confirmMatch[1]);
        if (!job) { json(res, 404, { error: "Job not found" }); return; }
        const body = await readBody(req, res);
        if (body === null) return;
        let data = {};
        try { data = JSON.parse(body || "{}"); } catch { json(res, 400, { error: "Body must be JSON" }); return; }
        if (data.confirmed !== true) { json(res, 400, { error: "confirmed must be true" }); return; }
        job.confirmed = true;
        job.updatedAt = Date.now();
        job.events.push({ stage: "gate", status: "confirmed", detail: "Author confirmed references (POST /jobs/:id/confirm). Confirmation records the author's review; it does not verify a reference or a journal by itself.", gate: "author_confirmation" });
        json(res, 200, { jobId: job.id, confirmed: true }); return;
      }
      const jobMatch = url.pathname.match(/^\/jobs\/([^/]+)$/);
      if (req.method === "GET" && jobMatch) {
        const job = jobs.get(jobMatch[1]);
        if (!job) { json(res, 404, { error: "Job not found" }); return; }
        json(res, 200, publicJob(job)); return;
      }
      if (req.method === "DELETE" && jobMatch) {
        const job = jobs.get(jobMatch[1]);
        if (!job) { json(res, 404, { error: "Job not found" }); return; }
        for (const listener of job.listeners) { try { listener.end(); } catch {} }
        job.listeners.clear();
        jobs.delete(jobMatch[1]);
        clearActiveIf(jobMatch[1]);
        json(res, 200, { deleted: true, jobId: jobMatch[1] }); return;
      }
      json(res, 404, { error: "Not found" });
    } catch (e) {
      try { json(res, 500, { error: String(e.message || e).slice(0, 300) }); } catch {}
    }
  });
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  const port = process.env.PORT || 3001;
  createServer().listen(port, () => console.log(`MARVA backend-node listening on ${port}`));
}
