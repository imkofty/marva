// In-memory job store for the Node orchestrator (demo scale).
// The stored job record NEVER contains the manuscript text: text is
// held in memory only for the running job and is stripped from every
// public view, history entry, and report. DELETE removes the job and
// its listeners entirely — that is the "Manuscript Deleted After
// Session" control. There is no persistent storage in this server.
import { buildReport } from "./lib/export.mjs";

export const jobs = new Map();
export let activeJobId = null;
export function setActiveJobId(id) { activeJobId = id; }
export function clearActiveIf(id) { if (activeJobId === id) activeJobId = null; }

export function publicJob(job) {
  const { text, listeners, ...rest } = job;
  return { ...rest, report: buildReport(job) };
}

export function historyEntry(job) {
  return {
    id: job.id,
    status: job.status,
    createdAt: job.createdAt,
    confirmed: job.confirmed === true,
    stages: (job.events || []).map((e) => e.stage).filter(Boolean),
    reader_summary: job.reader ? { claims: job.reader.claims?.length ?? 0, citations: job.citations.length, references: job.references.length } : null,
    citation_flags: job.result || null,
  };
}
