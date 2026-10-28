import { useCallback, useEffect, useRef, useState } from "react";
import MeetingRoom from "./components/MeetingRoom";
import {
  AGENTS,
  agentStatuses,
  progress,
  createJobFromPdfBase64,
  createJobFromText,
  fetchEvents,
  fetchJob,
  fetchSyntheticDemo,
  downloadReport,
  deleteJob,
  fileToBase64,
} from "./lib/api";

const HISTORY_KEY = "marva-history";
const MAX_MB = 50; // Mockup label: "Max. 50MB". Enforced client-side.

function loadHistory() {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
  } catch {
    return [];
  }
}

function fmtBytes(n) {
  if (n == null) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export default function App() {
  const [jobId, setJobId] = useState(null);
  const [jobStatus, setJobStatus] = useState(null);
  const [events, setEvents] = useState([]);
  const [report, setReport] = useState(null);
  const [history, setHistory] = useState(loadHistory);
  const [dragOver, setDragOver] = useState(false);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [pasteText, setPasteText] = useState("");
  const pollRef = useRef(null);

  const saveHistory = (list) => {
    setHistory(list);
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(list));
    } catch {
      /* private-mode storage failure: history is best-effort only */
    }
  };

  const stopPolling = () => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = null;
  };

  // Poll GET /jobs/:id/events every 2s until done, then fetch the job
  // for its report. The backend currently serves JSON here; if it ever
  // serves text/event-stream, this polling still works because the
  // JSON endpoint is the documented one.
  const pollJob = useCallback((id) => {
    stopPolling();
    setJobId(id);
    setJobStatus("running");
    setEvents([]);
    setReport(null);
    const tick = async () => {
      try {
        const data = await fetchEvents(id);
        setEvents(data.events || []);
        setJobStatus(data.status || "running");
        if (data.status && data.status !== "running") {
          stopPolling();
          const job = await fetchJob(id);
          setReport(job.report || job);
          setHistory((h) => {
            const next = h.map((x) => (x.jobId === id ? { ...x, status: data.status } : x));
            saveHistory(next);
            return next;
          });
        }
      } catch (e) {
        setNotice(`Polling failed: ${e.message}`);
        stopPolling();
      }
    };
    tick();
    pollRef.current = setInterval(tick, 2000);
  }, []);

  useEffect(() => () => stopPolling(), []);

  const startPdf = async (file) => {
    if (!file) return;
    if (file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) {
      setNotice("Only PDF files are accepted, as shown in Info Document.");
      return;
    }
    if (file.size > MAX_MB * 1024 * 1024) {
      setNotice(`File is ${fmtBytes(file.size)} — over the Max. ${MAX_MB}MB limit shown in the mockup.`);
      return;
    }
    setBusy(true);
    setNotice("");
    try {
      const b64 = await fileToBase64(file);
      const res = await createJobFromPdfBase64(b64);
      const entry = {
        jobId: res.jobId,
        fileName: file.name,
        sizeBytes: file.size,
        createdAt: new Date().toISOString(),
        status: res.status || "running",
        kind: "pdf",
      };
      saveHistory([entry, ...history]);
      pollJob(res.jobId);
    } catch (e) {
      setNotice(`Upload failed: ${e.message}`);
    } finally {
      setBusy(false);
    }
  };

  const startPaste = async () => {
    if (!pasteText.trim()) {
      setNotice("Paste manuscript text first, or upload a PDF above.");
      return;
    }
    setBusy(true);
    setNotice("");
    try {
      const res = await createJobFromText(pasteText);
      const entry = {
        jobId: res.jobId,
        fileName: "Pasted text (demo fallback)",
        sizeBytes: new Blob([pasteText]).size,
        createdAt: new Date().toISOString(),
        status: res.status || "running",
        kind: "text",
      };
      saveHistory([entry, ...history]);
      pollJob(res.jobId);
    } catch (e) {
      setNotice(`Start failed: ${e.message}`);
    } finally {
      setBusy(false);
    }
  };

  // Synthetic demo: the backend's cached diagnostic, labelled as such.
  // It is NOT a job and is never presented as one. A history entry is
  // added only because the demo was actually run, marked demo:true.
  const runSynthetic = async () => {
    setBusy(true);
    setNotice("");
    try {
      const demo = await fetchSyntheticDemo();
      setReport(demo);
      setEvents([]);
      setJobId(null);
      setJobStatus("demo");
      saveHistory([
        { jobId: null, fileName: "Synthetic demo manuscript (cached)", sizeBytes: null, createdAt: new Date().toISOString(), status: "demo", kind: "synthetic-demo" },
        ...history,
      ]);
    } catch (e) {
      setNotice(`Synthetic demo failed: ${e.message}`);
    } finally {
      setBusy(false);
    }
  };

  const openHistory = (entry) => {
    if (!entry.jobId) {
      if (entry.kind === "synthetic-demo") runSynthetic();
      return;
    }
    pollJob(entry.jobId);
  };

  const onExport = async (kind) => {
    if (!jobId) {
      setNotice("No job selected: start an audit or open a history entry first.");
      return;
    }
    try {
      const data = await downloadReport(jobId, kind);
      if (kind === "html") {
        const blob = new Blob([data], { type: "text/html" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = `marva-report-${jobId}.html`;
        a.click();
        URL.revokeObjectURL(a.href);
      } else {
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = `marva-report-${jobId}.json`;
        a.click();
        URL.revokeObjectURL(a.href);
      }
      setNotice(`Export ${kind.toUpperCase()} downloaded.`);
    } catch (e) {
      // Honest failure: the backend report endpoint is not implemented
      // yet on the live Worker, so say so instead of faking a report.
      setNotice(`Export failed: ${e.message}. The full report below (from GET /jobs/:id) is still available.`);
    }
  };

  const onDelete = async () => {
    if (!jobId) {
      setNotice("No job selected.");
      return;
    }
    try {
      await deleteJob(jobId);
      saveHistory(history.filter((x) => x.jobId !== jobId));
      setJobId(null);
      setJobStatus(null);
      setEvents([]);
      setReport(null);
      setNotice("Job deleted on the backend and removed from history.");
    } catch (e) {
      setNotice(
        `Backend delete failed: ${e.message}. The backend delete endpoint is not implemented yet, so the job was NOT deleted server-side. Use "Remove from this browser's history" to clear only the local entry.`
      );
    }
  };

  const removeLocal = () => {
    saveHistory(history.filter((x) => x.jobId !== jobId));
    setJobId(null);
    setJobStatus(null);
    setEvents([]);
    setReport(null);
    setNotice("Removed from this browser's history only — not deleted on the backend.");
  };

  const statuses = agentStatuses(events, jobStatus);
  const prog = progress(events);
  // Bubbles: latest real events, mapped to their agent. The Narrator
  // (stage null) is excluded by construction — it never gets a bubble.
  const bubbles = events
    .filter((e) => e.detail)
    .map((e) => {
      const a = AGENTS.find((x) => x.stage === e.stage);
      return a ? { agentId: a.id, agentLabel: a.label, detail: e.detail } : null;
    })
    .filter(Boolean);
  // Meeting log: every real event, time + agent + detail. No invented
  // rows, no Narrator row, no fixed times.
  const logLines = events.map((e, i) => {
    const a = AGENTS.find((x) => x.stage === e.stage);
    return { key: i, agent: a ? a.label : e.stage || "Job", detail: e.detail || e.status || "", status: e.status };
  });

  return (
    <div className="marva-app">
      <header className="marva-header">
        <div className="marva-logo">🐻</div>
        <div>
          <h1>MARVA</h1>
          <p>Meta Audit Review Verification for Authors</p>
        </div>
        <div className="marva-header-icons">
          <button aria-label="Notifications" title="Notifications">🔔</button>
          <button aria-label="Help" title="Help">❔</button>
          <div className="marva-avatar" title="Author">AD</div>
          <span aria-hidden="true">▾</span>
        </div>
      </header>

      {notice && <div className="marva-notice" role="alert">{notice}</div>}

      <main className="marva-grid">
        <section className="marva-card marva-upload">
          <h2>⬆ Upload PDF</h2>
          <div
            className={`marva-drop ${dragOver ? "over" : ""}`}
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              startPdf(e.dataTransfer.files[0]);
            }}
          >
            <div className="marva-cloud">☁️</div>
            <p><strong>Drag &amp; drop your PDF here</strong></p>
            <p>or click to select file</p>
            <label className="marva-btn">
              + Select PDF File
              <input
                type="file"
                accept="application/pdf,.pdf"
                hidden
                onChange={(e) => startPdf(e.target.files[0])}
              />
            </label>
          </div>

          <h3>Info Document</h3>
          <p className="marva-meta">Format: PDF • Max. {MAX_MB}MB</p>
          <p className="marva-meta marva-small">
            MARVA does not guarantee acceptance at any journal. Manuscript
            text is processed for this job only and is never returned by
            the API; the report below contains findings, not the manuscript.
          </p>

          <h3>Upload History</h3>
          {history.length === 0 ? (
            <p className="marva-meta">No uploads yet. Upload a PDF to start your first audit.</p>
          ) : (
            <ul className="marva-history">
              {history.map((h, i) => (
                <li key={`${h.jobId || h.kind}-${i}`}>
                  <button onClick={() => openHistory(h)} title={h.jobId ? `Open job ${h.jobId}` : "Re-run synthetic demo"}>
                    📄 {h.fileName}
                    {h.sizeBytes != null && <> • {fmtBytes(h.sizeBytes)}</>}
                    {" • "}{new Date(h.createdAt).toLocaleDateString()}
                    {" • "}{h.status}
                  </button>
                </li>
              ))}
            </ul>
          )}

          <h3>Paste text (demo fallback)</h3>
          <textarea
            value={pasteText}
            onChange={(e) => setPasteText(e.target.value)}
            placeholder="Paste manuscript text here (demo only)"
            rows={4}
          />
          <button className="marva-btn" onClick={startPaste} disabled={busy}>
            {busy ? "Starting…" : "Start audit"}
          </button>{" "}
          <button className="marva-btn marva-btn-secondary" onClick={runSynthetic} disabled={busy}>
            Try synthetic demo
          </button>
        </section>

        <section className="marva-card marva-room-card">
          <div className="marva-room-head">
            <h2>Live Meeting Room — Pre-Submit Review Session</h2>
            <span className="marva-live-badge">● Live • 7 participants</span>
          </div>
          <MeetingRoom statuses={statuses} bubbles={bubbles} live={jobStatus === "running"} />
        </section>

        <section className="marva-card">
          <h2>Meeting Log: Brief</h2>
          {logLines.length === 0 ? (
            <p className="marva-meta">No events yet. Start an audit to see real agent events here.</p>
          ) : (
            <ul className="marva-log">
              {logLines.map((l) => (
                <li key={l.key}>
                  <strong>{l.agent}:</strong> {l.detail}
                  <span className="marva-meta"> ({l.status})</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="marva-card">
          <h2>Audit Progress</h2>
          <p>
            {prog.pct}% ({prog.doneCount} of {prog.total} stages done)
          </p>
          <div className="marva-bar" aria-label={`${prog.pct}% of stages done`}>
            <div className="marva-bar-fill" style={{ width: `${prog.pct}%` }} />
          </div>
          <ul className="marva-stages">
            {prog.stages.map((s) => (
              <li key={s.name} className={s.done ? "done" : ""}>
                {s.done ? "✓" : "○"} {s.name}
              </li>
            ))}
          </ul>
          <p className="marva-meta">
            Progress is real stages finished / total stages. No completion
            time is estimated, because the backend provides no timing data.
          </p>
          <div className="marva-actions">
            <button className="marva-btn" onClick={() => onExport("json")}>Export JSON</button>{" "}
            <button className="marva-btn" onClick={() => onExport("html")}>Export HTML</button>{" "}
            <button className="marva-btn marva-btn-danger" onClick={onDelete}>Delete job</button>{" "}
            <button className="marva-btn marva-btn-secondary" onClick={removeLocal}>
              Remove from this browser's history
            </button>
          </div>
        </section>

        <section className="marva-card marva-report-card">
          <h2>Report</h2>
          {report ? (
            <pre className="marva-report">{JSON.stringify(report, null, 2)}</pre>
          ) : (
            <p className="marva-meta">
              No report yet. Run the synthetic demo or start an audit; the
              report appears here when the job finishes. It never contains
              the full manuscript text, and it never contains a plagiarism
              percentage.
            </p>
          )}
        </section>
      </main>
    </div>
  );
}
