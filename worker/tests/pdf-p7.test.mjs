// P7 extractor tests: honest xref-stream failure, per-page isolation,
// and partial status with page counts. Synthetic PDFs are built by
// hand; the extractor is regex-based, so structural validity beyond
// object headers, /Type /Page + /Contents, and stream/endstream
// markers is not required for these tests.
import test from "node:test";
import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";
import { extractTextFromPdf, extractPdfWithStatus } from "../src/pdf.mjs";
import worker from "../src/index.mjs";
import { JobObject } from "../src/job-object.mjs";

const GARBAGE = "this is not zlib data at all";

function textOps(s) {
  return `BT /F1 12 Tf 100 700 Td (${s}) Tj ET`;
}

// Stream spec: { text } = FlateDecode stream with one text line;
// { raw } = uncompressed stream; { garbage: true } = FlateDecode
// stream whose bytes are not zlib data (simulates corrupt/truncated).
function buildPdf(pageStreams, xref) {
  // Layout: 1 Catalog, 2 Pages, then per page: page obj + stream objs.
  let next = 3;
  const layout = pageStreams.map((streams) => {
    const pageNum = next++;
    const streamNums = streams.map(() => next++);
    return { pageNum, streamNums };
  });
  const xrefNum = xref ? next++ : null;
  const parts = [];
  const push = (s) => parts.push(Buffer.from(s, "latin1"));
  push("%PDF-1.5\n");
  push("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");
  push(`2 0 obj\n<< /Type /Pages /Kids [${layout.map((l) => `${l.pageNum} 0 R`).join(" ")}] /Count ${layout.length} >>\nendobj\n`);
  pageStreams.forEach((streams, i) => {
    const { pageNum, streamNums } = layout[i];
    const ref = streamNums.length === 1 ? `${streamNums[0]} 0 R` : `[${streamNums.map((n) => `${n} 0 R`).join(" ")}]`;
    push(`${pageNum} 0 obj\n<< /Type /Page /Parent 2 0 R /Contents ${ref} >>\nendobj\n`);
    streams.forEach((spec, j) => {
      let bytes, filter = "";
      if (spec.text !== undefined) { bytes = deflateSync(Buffer.from(textOps(spec.text), "latin1")); filter = " /Filter /FlateDecode"; }
      else if (spec.raw !== undefined) { bytes = Buffer.from(spec.raw, "latin1"); }
      else { bytes = Buffer.from(GARBAGE, "latin1"); filter = " /Filter /FlateDecode"; }
      push(`${streamNums[j]} 0 obj\n<< /Length ${bytes.length}${filter} >>\nstream\n`);
      parts.push(bytes);
      push("\nendstream\nendobj\n");
    });
  });
  if (xref === "broken") {
    const bytes = Buffer.from(GARBAGE, "latin1");
    push(`${xrefNum} 0 obj\n<< /Type /XRef /Length ${bytes.length} /Filter /FlateDecode /W [1 4 1] /Size 20 >>\nstream\n`);
    parts.push(bytes);
    push("\nendstream\nendobj\n");
  } else if (xref === "truncated") {
    push(`${xrefNum} 0 obj\n<< /Type /XRef /Length 0 /Filter /FlateDecode /W [1 4 1] /Size 20 >>\nendobj\n`);
  }
  push(`trailer\n<< /Size ${next} /Root 1 0 R >>\n%%EOF\n`);
  return Buffer.concat(parts);
}

test("P7 healthy 2-page PDF: ok, 2/2 pages, text from both, wrapper identical", () => {
  const buf = buildPdf([[{ text: "Hello page one" }], [{ text: "Hello page two" }]], null);
  const r = extractPdfWithStatus(buf);
  assert.equal(r.status, "ok");
  assert.equal(r.reason, null);
  assert.deepEqual(r.pages, { total: 2, ok: 2, damaged: 0, failed: 0, empty: 0, failedPages: [], damagedPages: [] });
  assert.equal(r.xref.status, "absent");
  assert.match(r.text, /Hello page one/);
  assert.match(r.text, /Hello page two/);
  assert.equal(extractTextFromPdf(buf), r.text);
});

test("P7 broken xref stream: recorded failed, overall partial, text intact", () => {
  const buf = buildPdf([[{ text: "Surviving page text" }]], "broken");
  const r = extractPdfWithStatus(buf);
  assert.equal(r.xref.status, "failed");
  assert.equal(r.xref.reason, "xref-stream-inflate-failed");
  assert.equal(r.status, "partial");
  assert.match(r.reason, /xref stream broken/);
  assert.match(r.text, /Surviving page text/);
  assert.deepEqual(r.pages.failedPages, []);
});

test("P7 truncated xref stream (dict, no stream data): recorded failed", () => {
  const buf = buildPdf([[{ text: "Surviving page text" }]], "truncated");
  const r = extractPdfWithStatus(buf);
  assert.equal(r.xref.status, "failed");
  assert.equal(r.xref.reason, "xref-stream-truncated");
  assert.equal(r.status, "partial");
});

test("P7 one broken page: other page still parsed, partial, failedPages [2]", () => {
  const buf = buildPdf([[{ text: "Good page text" }], [{ garbage: true }]], null);
  let r;
  assert.doesNotThrow(() => { r = extractPdfWithStatus(buf); });
  assert.equal(r.status, "partial");
  assert.deepEqual(r.pages.failedPages, [2]);
  assert.equal(r.pages.failed, 1);
  assert.equal(r.pages.ok, 1);
  assert.match(r.text, /Good page text/);
  assert.equal(r.text.includes("not zlib"), false);
});

test("P7 damaged page (good + broken stream): damagedPages [1], text kept", () => {
  const buf = buildPdf([[{ text: "Damaged page good stream" }, { garbage: true }]], null);
  const r = extractPdfWithStatus(buf);
  assert.equal(r.status, "partial");
  assert.deepEqual(r.pages.damagedPages, [1]);
  assert.deepEqual(r.pages.failedPages, []);
  assert.match(r.text, /Damaged page good stream/);
});

test("P7 all pages broken: failed, empty text, recorded reason", () => {
  const buf = buildPdf([[{ garbage: true }]], null);
  const r = extractPdfWithStatus(buf);
  assert.equal(r.status, "failed");
  assert.equal(r.text, "");
  assert.match(r.reason, /all-pages-failed/);
  assert.deepEqual(r.pages.failedPages, [1]);
  assert.equal(extractTextFromPdf(buf), "");
});

test("P7 legacy stream without page objects: ok when text found", () => {
  const buf = Buffer.from("stream\nBT /F1 12 Tf 100 700 Td (Legacy text here) Tj ET\nendstream\n", "latin1");
  const r = extractPdfWithStatus(buf);
  assert.equal(r.status, "ok");
  assert.equal(r.pages.total, 0);
  assert.match(r.text, /Legacy text here/);
});

// --- Minimal handler harness: proves the status is RECORDED on the
// job (extraction field + pdf_note), not just returned by pdf.mjs.
class FakeKV {
  constructor() { this.map = new Map(); }
  async get(k) { return this.map.has(k) ? this.map.get(k) : null; }
  async put(k, v) { this.map.set(k, v); }
  async delete(k) { this.map.delete(k); }
}
class FakeDOStorage {
  constructor() { this.map = new Map(); this.alarmTime = null; this.puts = 0; }
  async get(k) { return this.map.has(k) ? this.map.get(k) : undefined; }
  async put(k, v) { this.map.set(k, v); this.puts += 1; }
  async delete(k) { this.map.delete(k); }
  async deleteAll() { this.map.clear(); }
  async setAlarm(t) { this.alarmTime = t; }
  async getAlarm() { return this.alarmTime; }
}
class FakeDOStub {
  constructor(instance) { this.instance = instance; }
  async fetch(request) { return this.instance.fetch(request); }
}
function makeEnv() {
  const env = { MARVA_JOBS: new FakeKV(), MODEL_API_KEY: "test" };
  const instances = new Map();
  env.JOB_OBJECTS = {
    _instances: instances,
    idFromName: (name) => name,
    get: (id) => {
      if (!instances.has(id)) instances.set(id, new JobObject({ storage: new FakeDOStorage() }, env));
      return new FakeDOStub(instances.get(id));
    },
  };
  return env;
}

test("P7 job record carries extraction status + partial pdf_note", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    if (String(url).includes("api.meta.ai")) {
      return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ claims: [], theories: [], quotes: [], citations: [], references: [], method: "", equations: [], tables: [] }) } }] }) };
    }
    throw new Error(`Unexpected fetch in test: ${url}`);
  };
  try {
    const env = makeEnv();
    const ctx = { promises: [], waitUntil(p) { ctx.promises.push(p); } };
    const pdf = buildPdf([[{ text: "Job page text" }], [{ garbage: true }]], null);
    const req = new Request("https://worker.test/jobs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pdfBase64: pdf.toString("base64") }) });
    const res = await worker.fetch(req, env, ctx);
    assert.equal(res.status, 201);
    const { jobId } = await res.json();
    const got = await worker.fetch(new Request(`https://worker.test/jobs/${jobId}`), env, {});
    const body = await got.json();
    assert.equal(body.extraction.status, "partial");
    assert.deepEqual(body.extraction.pages.failedPages, [2]);
    assert.match(body.pdf_note, /partial/);
  } finally {
    globalThis.fetch = orig;
  }
});
