// backend-node tests. No key, no model call, no deploy, no GitHub.
// Run: node --test tests/backend-node.test.mjs  (from backend-node/)
// The no-key job must report model stages as skipped, never fake data.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createServer } from "../src/server.mjs";
import { jobs, setActiveJobId, clearActiveIf } from "../src/store.mjs";

delete process.env.MODEL_API_KEY;
delete process.env.SCOPUS_API_KEY;

let base;
let server;
test.before(async () => {
  server = createServer();
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { await new Promise((r) => server.close(r)); });

function req(method, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request(base + path, { method, headers: { "Content-Type": "application/json", ...headers } }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    r.on("error", reject);
    if (body !== undefined) r.write(typeof body === "string" ? body : JSON.stringify(body));
    r.end();
  });
}

async function waitDone(jobId, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const r = await req("GET", `/jobs/${jobId}`);
    assert.equal(r.status, 200);
    const j = JSON.parse(r.body);
    if (j.status === "done") return j;
    await new Promise((r2) => setTimeout(r2, 100));
  }
  throw new Error("job did not finish in time");
}

test("no-key job: reader skipped, deterministic missing citation, report held until confirmation", async () => {
  const created = await req("POST", "/jobs", { text: "A pilot study. It cites (Rahman, 2021) and (Davis, 1989).", citations: ["Rahman, 2021"], references: [] });
  assert.equal(created.status, 201);
  const { jobId } = JSON.parse(created.body);
  const job = await waitDone(jobId);
  assert.equal(job.report.citation_flags.missing.includes("rahman, 2021"), true);
  assert.equal(job.report.confirmed, false);
  assert.equal(job.report.held_until_confirmation, true);
  assert.match(job.report.confirmation_note, /held until the author confirms/);
  // Reader skipped honestly in no-key mode (no fake model data).
  const readerEvent = job.events.find((e) => e.stage === "reader");
  assert.equal(readerEvent.status, "skipped");
  // Manuscript text is never returned.
  assert.equal("text" in job, false);
  assert.equal(job.report.diagnostic.source, "deterministic-fallback (Supervisor model skipped: no key)");
  // Dimensions are exactly the diagram's five, mapped from real findings.
  assert.deepEqual(job.report.dimensions.map((d) => d.dimension), ["Clarity", "Rigor", "Novelty", "References", "Suitability"]);
  const refsDim = job.report.dimensions.find((d) => d.dimension === "References");
  assert.ok(refsDim.count >= 1, "References dimension must carry the real missing-citation finding");
  const emptyDims = job.report.dimensions.filter((d) => d.count === 0);
  for (const d of emptyDims) assert.match(d.note, /No finding in this job mapped/);
  // Quality Gate ran on the deterministic diagnostic.
  assert.ok(job.quality_gate && job.quality_gate.kept >= 1);
  // Scopus status is unverified without a key (no fake indexed claim).
  assert.equal(job.journal.scopus_indexed_status, undefined); // journal stage skipped in no-key mode
  globalThis.__jobId = jobId;
});

test("409 while a job is active (gate logic, deterministic via store)", async () => {
  jobs.set("fake-active", { id: "fake-active", status: "running" });
  setActiveJobId("fake-active");
  try {
    const r = await req("POST", "/jobs", { text: "x" });
    assert.equal(r.status, 409);
    assert.equal(JSON.parse(r.body).activeJobId, "fake-active");
  } finally {
    jobs.delete("fake-active");
    clearActiveIf("fake-active");
  }
});

test("report.json / report.html / report.pdf, confirm gate, history, delete, 404s", async () => {
  const jobId = globalThis.__jobId;
  const rj = await req("GET", `/jobs/${jobId}/report.json`);
  assert.equal(rj.status, 200);
  assert.equal(JSON.parse(rj.body).held_until_confirmation, true);
  const rh = await req("GET", `/jobs/${jobId}/report.html`);
  assert.equal(rh.status, 200);
  assert.match(rh.headers["content-type"], /text\/html/);
  assert.match(rh.body, /MARVA Report/);
  assert.match(rh.body, /held until the author confirms/);
  const rp = await req("GET", `/jobs/${jobId}/report.pdf`);
  assert.equal(rp.status, 200);
  assert.match(rp.headers["content-type"], /application\/pdf/);
  assert.match(rp.body.slice(0, 8), /%PDF-/);
  // Confirm with a wrong body is rejected; confirm=true unlocks the report.
  const bad = await req("POST", `/jobs/${jobId}/confirm`, { confirmed: false });
  assert.equal(bad.status, 400);
  const ok = await req("POST", `/jobs/${jobId}/confirm`, { confirmed: true });
  assert.equal(ok.status, 200);
  assert.equal(JSON.parse(ok.body).confirmed, true);
  const after = await req("GET", `/jobs/${jobId}/report.json`);
  assert.equal(JSON.parse(after.body).confirmed, true);
  assert.equal(JSON.parse(after.body).held_until_confirmation, false);
  // History lists the real job, without text.
  const hist = await req("GET", "/jobs");
  assert.equal(hist.status, 200);
  const entry = JSON.parse(hist.body).jobs.find((j) => j.id === jobId);
  assert.ok(entry);
  assert.equal("text" in entry, false);
  // 404s for unknown jobs on every route.
  for (const [m, p, b] of [["GET", "/jobs/nope", undefined], ["GET", "/jobs/nope/report.json", undefined], ["GET", "/jobs/nope/report.html", undefined], ["GET", "/jobs/nope/report.pdf", undefined], ["POST", "/jobs/nope/confirm", { confirmed: true }], ["DELETE", "/jobs/nope", undefined], ["GET", "/jobs/nope/events", undefined]]) {
    const r = await req(m, p, b);
    assert.equal(r.status, 404, `${m} ${p} should 404`);
  }
  // Delete removes the job entirely (Manuscript Deleted After Session).
  const del = await req("DELETE", `/jobs/${jobId}`);
  assert.equal(del.status, 200);
  assert.equal(JSON.parse(del.body).deleted, true);
  const gone = await req("GET", `/jobs/${jobId}`);
  assert.equal(gone.status, 404);
});

test("SSE header + real event stream, JSON polling fallback, synthetic demo, 50MB limit", async () => {
  const created = await req("POST", "/jobs", { citations: ["Rahman, 2021"], references: [] });
  assert.equal(created.status, 201);
  const jobId = JSON.parse(created.body).jobId;
  await waitDone(jobId);
  const sse = await req("GET", `/jobs/${jobId}/events`, undefined, { Accept: "text/event-stream" });
  assert.match(sse.headers["content-type"], /text\/event-stream/);
  assert.match(sse.body, /data: /);
  assert.match(sse.body, /citation_matcher/);
  const jsonEvents = await req("GET", `/jobs/${jobId}/events`, undefined, { Accept: "application/json" });
  assert.equal(jsonEvents.status, 200);
  assert.ok(Array.isArray(JSON.parse(jsonEvents.body).events));
  const demo = await req("GET", "/demo/synthetic");
  assert.equal(demo.status, 200);
  const d = JSON.parse(demo.body);
  assert.equal(d.demo, true);
  assert.equal(d.synthetic, true);
  assert.equal(d.findings.length, 7);
  // 50MB limit: a declared Content-Length above the limit is rejected 413.
  const over = await new Promise((resolve, reject) => {
    const r = http.request(base + "/jobs", { method: "POST", headers: { "Content-Type": "application/json", "Content-Length": 50 * 1024 * 1024 + 1 } }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode, body: data }));
    });
    r.on("error", reject);
    r.end();
  });
  assert.equal(over.status, 413);
  await req("DELETE", `/jobs/${jobId}`);
});
