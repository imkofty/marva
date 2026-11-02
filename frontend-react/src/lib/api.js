// MARVA frontend API layer — honest-data rules live here, not in the UI.
// API base comes from the build env VITE_API_BASE. The default is the
// live Cloudflare Worker backend. There is deliberately NO fallback to
// any other host: a build with a wrong VITE_API_BASE must fail loudly
// against the live backend, never silently hit a dead backend.
// No content is ever invented here: every finding, percentage and log
// line comes from a backend response, or is labelled as a local error.

export const API_BASE =
  import.meta.env.VITE_API_BASE || "https://marva-backend-worker.imkofty.workers.dev";

// The backend pipeline stages, in backend order, plus the Narrator.
// `stage` is the backend event stage name; `progress` is the mockup
// Audit Progress stage it feeds, or null when the mockup progress bar
// has no slot for it. Strengthening IS a real backend stage (between
// gap and journal) even though it has no room character and no progress
// slot: omitting it made the "first stage with no event yet" running
// inference misattribute strengthening's whole window to Journal
// Matcher. It is never silently counted as another progress stage.
export const AGENTS = [
  { id: "reader", label: "Reader", stage: "reader", progress: "Structure" },
  { id: "citation", label: "Citation Matcher", stage: "citation_matcher", progress: "Citations" },
  { id: "verifier", label: "Reference Verifier", stage: "reference_verifier", progress: "Reference Consistency" },
  { id: "gap", label: "Gap Assessor", stage: "gap", progress: "Completeness" },
  { id: "strengthening", label: "Strengthening", stage: "strengthening", progress: null },
  { id: "journal", label: "Journal Matcher", stage: "journal", progress: null },
  { id: "supervisor", label: "Supervisor", stage: "supervisor", progress: "Final" },
  { id: "narrator", label: "Narrator", stage: null, progress: null },
];

// Mockup Audit Progress stages, in mockup order.
export const PROGRESS_STAGES = [
  "Structure",
  "Completeness",
  "Citations",
  "Reference Consistency",
  "Final",
];

// Map backend events to per-agent status: done / skipped / failed /
// running / waiting. "running" is INFERRED, honestly, from real events:
// while a job is running, the first pipeline stage with no terminal
// event yet is the stage currently running. The backend only pushes a
// terminal event when a stage finishes (the verifier's intermediate
// "running" events are the exception: they mark that stage running
// without finishing it), so this is the only running-stage signal
// available.
// The Narrator has no backend stage: it is "typing" while the job runs
// (it is rewriting that stage's bubble), and it never produces a bubble
// of its own. Its completion signal is the job-completion signal
// itself — job status "done" from /events, or the backend's
// {stage:"job", status:"done"} event — so after an audit it is "done",
// not "waiting". It is never hardcoded to "done": it flips only on
// that real backend signal. Before any job it stays "waiting".
export function agentStatuses(events, jobStatus) {
  const byStage = new Map();
  for (const e of events || []) {
    if (e.stage) byStage.set(e.stage, e.status);
  }
  const jobDone = jobStatus === "done" || byStage.get("job") === "done";
  // A finished job has no running stage, even if a stale poll still
  // reports "running" alongside the job-completion event.
  const running = jobStatus === "running" && !jobDone;
  let runningAssigned = false;
  const out = {};
  for (const a of AGENTS) {
    if (a.id === "narrator") {
      out.narrator = jobDone ? "done" : running ? "typing" : "waiting";
      continue;
    }
    const s = byStage.get(a.stage);
    if (s === "done" || s === "skipped" || s === "failed") {
      out[a.id] = s;
    } else if (running && !runningAssigned) {
      out[a.id] = "running";
      runningAssigned = true;
    } else {
      out[a.id] = "waiting";
    }
  }
  return out;
}

// Progress bar = real mockup stages finished / total mockup stages.
// A stage counts as finished when its backend stage event is TERMINAL:
// "done", "skipped" or "failed". The verifier's intermediate "running"
// events are not terminal and never count. Skipped/failed are NOT
// counted as successful: the agent's tile still shows skipped/failed
// and the meeting log still shows it — the bar counts pipeline
// completion, not success. Counting only "done" left the bar stuck
// below 5/5 on every partial job (e.g. citation skipped when no
// reference list exists) even after the audit was fully over.
// Never a fixed percentage, never an estimated time: with no backend
// timing data, no time estimate is shown at all.
const TERMINAL_STAGE_STATUSES = ["done", "skipped", "failed"];
export function progress(events) {
  const byStage = new Map();
  for (const e of events || []) {
    if (e.stage) byStage.set(e.stage, e.status);
  }
  const finished = [];
  for (const a of AGENTS) {
    if (a.progress && TERMINAL_STAGE_STATUSES.includes(byStage.get(a.stage))) finished.push(a.progress);
  }
  const stages = PROGRESS_STAGES.map((name) => {
    const agent = AGENTS.find((a) => a.progress === name);
    return {
      name,
      done: byStage.get(agent.stage) === "done",
      finished: finished.includes(name),
    };
  });
  const pct = Math.round((finished.length / PROGRESS_STAGES.length) * 100);
  return { stages, finishedCount: finished.length, total: PROGRESS_STAGES.length, pct };
}

async function getJson(path) {
  const res = await fetch(`${API_BASE}${path}`);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${res.status} ${text.slice(0, 200)}`);
  }
  return res.json();
}

export async function createJobFromPdfBase64(pdfBase64) {
  const res = await fetch(`${API_BASE}/jobs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pdfBase64 }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`POST /jobs ${res.status}: ${text.slice(0, 300)}`);
  }
  return res.json();
}

export async function createJobFromText(text) {
  const res = await fetch(`${API_BASE}/jobs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`POST /jobs ${res.status}: ${t.slice(0, 300)}`);
  }
  return res.json();
}

export async function fetchEvents(jobId) {
  return getJson(`/jobs/${jobId}/events`);
}

export async function fetchJob(jobId) {
  return getJson(`/jobs/${jobId}`);
}

export async function fetchSyntheticDemo() {
  return getJson(`/demo/synthetic`);
}

// Export buttons call the backend report endpoints (JSON, HTML, PDF),
// all implemented on the live Worker. If the backend returns an error,
// the caller must say so honestly instead of generating a fake report
// locally. PDF is returned as a Blob so the caller can download it.
export async function downloadReport(jobId, kind) {
  const path =
    kind === "html" ? `/jobs/${jobId}/report.html`
    : kind === "pdf" ? `/jobs/${jobId}/report.pdf`
    : `/jobs/${jobId}/report.json`;
  const res = await fetch(`${API_BASE}${path}`);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`GET ${path} ${res.status}: ${text.slice(0, 200)}`);
  }
  if (kind === "pdf") return res.blob();
  return kind === "html" ? res.text() : res.json();
}

// Author Confirmation Gate: POST /jobs/:id/confirm {confirmed:true}.
// Confirmation records the author's review; it does not verify a
// reference or a journal by itself.
export async function confirmJob(jobId) {
  const res = await fetch(`${API_BASE}/jobs/${jobId}/confirm`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ confirmed: true }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`POST /jobs/${jobId}/confirm ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

export async function deleteJob(jobId) {
  const res = await fetch(`${API_BASE}/jobs/${jobId}`, { method: "DELETE" });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`DELETE /jobs/${jobId} ${res.status}: ${text.slice(0, 200)}`);
  }
  return true;
}

export function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] || "");
    r.onerror = () => reject(new Error("Could not read the file"));
    r.readAsDataURL(file);
  });
}
