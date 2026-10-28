// MARVA frontend API layer — honest-data rules live here, not in the UI.
// API base comes from the build env VITE_API_BASE. The default is the
// live Cloudflare Worker backend. There is deliberately NO fallback to
// any other host: a build with a wrong VITE_API_BASE must fail loudly
// against the live backend, never silently hit a dead backend.
// No content is ever invented here: every finding, percentage and log
// line comes from a backend response, or is labelled as a local error.

export const API_BASE =
  import.meta.env.VITE_API_BASE || "https://marva-backend-worker.imkofty.workers.dev";

// The 7 agents, in pipeline order. `stage` is the backend event stage
// name; `progress` is the mockup Audit Progress stage it feeds, or null
// when the mockup progress bar has no slot for it (Journal Matcher and
// the strengthening step are still shown on their own tiles and in the
// report — they are never silently counted as another progress stage).
export const AGENTS = [
  { id: "reader", label: "Reader", stage: "reader", progress: "Structure" },
  { id: "citation", label: "Citation Matcher", stage: "citation_matcher", progress: "Citations" },
  { id: "verifier", label: "Reference Verifier", stage: "reference_verifier", progress: "Reference Consistency" },
  { id: "gap", label: "Gap Assessor", stage: "gap", progress: "Completeness" },
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
// while a job is running, the first pipeline stage with no event yet is
// the stage currently running. The backend only pushes an event when a
// stage finishes, so this is the only running-stage signal available.
// The Narrator has no backend stage: it is "typing" only while any real
// stage is running (it is rewriting that stage's bubble), and it never
// produces a bubble of its own.
export function agentStatuses(events, jobStatus) {
  const byStage = new Map();
  for (const e of events || []) {
    if (e.stage) byStage.set(e.stage, e.status);
  }
  const running = jobStatus === "running";
  let runningAssigned = false;
  const out = {};
  for (const a of AGENTS) {
    if (a.id === "narrator") {
      out.narrator = running ? "typing" : "waiting";
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
// A stage counts as finished only when its backend stage event is
// "done" (skipped/failed do not count as done, and are shown as such).
// Never a fixed percentage, never an estimated time: with no backend
// timing data, no time estimate is shown at all.
export function progress(events) {
  const byStage = new Map();
  for (const e of events || []) {
    if (e.stage) byStage.set(e.stage, e.status);
  }
  const done = [];
  for (const a of AGENTS) {
    if (a.progress && byStage.get(a.stage) === "done") done.push(a.progress);
  }
  const stages = PROGRESS_STAGES.map((name) => ({
    name,
    done: done.includes(name),
  }));
  const pct = Math.round((done.length / PROGRESS_STAGES.length) * 100);
  return { stages, doneCount: done.length, total: PROGRESS_STAGES.length, pct };
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
