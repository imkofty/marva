// 328 fix tests: dictWindow must not scan forward per header.
// epmc2-328 (2754 object headers) spent ~5.0s inside raw.indexOf("\nstream")
// called once per header — dict-only objects scan forward to the NEXT
// stream, which can be most of the file away — and died live with
// Cloudflare 1102 while 443 (711 headers) passed. Positions are now
// collected once and binary-searched; windows must stay identical.
import test from "node:test";
import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";
import {
  collectNeedlePositions, nextPosAtOrAfter, extractPdfWithStatus,
} from "../src/pdf.mjs";

// Old implementation, kept here ONLY as the equivalence oracle.
function oldDictWindow(raw, start) {
  let winEnd = start + 4000;
  const s = raw.indexOf("\nstream", start);
  const e = raw.indexOf("endobj", start);
  if (s >= 0) winEnd = Math.min(winEnd, s);
  if (e >= 0) winEnd = Math.min(winEnd, e);
  return raw.slice(start, winEnd);
}

function newDictWindow(raw, start, streamPos, endobjPos) {
  let winEnd = start + 4000;
  const s = nextPosAtOrAfter(streamPos, start);
  const e = nextPosAtOrAfter(endobjPos, start);
  if (s >= 0) winEnd = Math.min(winEnd, s);
  if (e >= 0) winEnd = Math.min(winEnd, e);
  return raw.slice(start, winEnd);
}

test("nextPosAtOrAfter: exact, between, past-end, empty", () => {
  const pos = [5, 20, 30];
  assert.equal(nextPosAtOrAfter(pos, 0), 5);
  assert.equal(nextPosAtOrAfter(pos, 5), 5);
  assert.equal(nextPosAtOrAfter(pos, 6), 20);
  assert.equal(nextPosAtOrAfter(pos, 30), 30);
  assert.equal(nextPosAtOrAfter(pos, 31), -1);
  assert.equal(nextPosAtOrAfter([], 0), -1);
});

test("collectNeedlePositions: all occurrences, overlapping included", () => {
  assert.deepEqual(collectNeedlePositions("aaa", "aa"), [0, 1]);
  assert.deepEqual(collectNeedlePositions("ab\nstream cd\nstream", "\nstream"), [2, 12]);
  assert.deepEqual(collectNeedlePositions("no match here", "\nstream"), []);
});

test("dictWindow equivalence: old indexOf vs new binary search, mixed layout", () => {
  // Layout mimicking 328's hazard: a long run of dict-only objects
  // (font descriptors) BEFORE any stream, then pages + streams.
  const parts = ["%PDF-1.5\n"];
  for (let n = 1; n <= 300; n++) {
    parts.push(`${n} 0 obj\n<< /Type /FontDescriptor /FontName /F${n} /Flags 4 >>\nendobj\n`);
  }
  parts.push("301 0 obj\n<< /Type /Page /Parent 2 0 R /Contents 302 0 R >>\nendobj\n");
  parts.push("302 0 obj\n<< /Length 44 >>\nstream\nBT /F1 12 Tf 100 700 Td (Hello window) Tj ET\nendstream\nendobj\n");
  parts.push("303 0 obj\n<< /Type /Page /Parent 2 0 R /Contents 304 0 R >>\nendobj\n");
  parts.push("304 0 obj\n<< /Length 44 >>\nstream\nBT /F1 12 Tf 100 700 Td (Second page) Tj ET\nendstream\nendobj\n");
  const raw = parts.join("");
  const streamPos = collectNeedlePositions(raw, "\nstream");
  const endobjPos = collectNeedlePositions(raw, "endobj");
  // Every object header start must yield the identical window both ways.
  const headerRe = /(\d+)\s+(\d+)\s+obj\b/g;
  let hm, count = 0;
  while ((hm = headerRe.exec(raw)) !== null) {
    assert.equal(newDictWindow(raw, hm.index, streamPos, endobjPos), oldDictWindow(raw, hm.index));
    count++;
  }
  assert.equal(count, 304);
  // And the full extractor must see both pages through the dict run.
  const pdf = extractPdfWithStatus(Buffer.from(raw, "latin1"));
  assert.equal(pdf.pages.total, 2);
  assert.equal(pdf.pages.ok, 2);
  assert.match(pdf.text, /Hello window/);
  assert.match(pdf.text, /Second page/);
});

test("dictWindow equivalence: stream directly followed by a /Page dict", () => {
  // The stream cutoff must stop the window before the NEXT object's
  // dict, or the page dict would be swallowed into the stream object.
  const raw = [
    "%PDF-1.5\n",
    "1 0 obj\n<< /Length 30 >>\nstream\nBT /F1 12 Tf (X) Tj ET\nendstream\nendobj\n",
    "2 0 obj\n<< /Type /Page /Contents 1 0 R >>\nendobj\n",
  ].join("");
  const streamPos = collectNeedlePositions(raw, "\nstream");
  const endobjPos = collectNeedlePositions(raw, "endobj");
  const headerRe = /(\d+)\s+(\d+)\s+obj\b/g;
  let hm;
  while ((hm = headerRe.exec(raw)) !== null) {
    assert.equal(newDictWindow(raw, hm.index, streamPos, endobjPos), oldDictWindow(raw, hm.index));
  }
  const pdf = extractPdfWithStatus(Buffer.from(raw, "latin1"));
  assert.equal(pdf.pages.total, 1);
  assert.equal(pdf.pages.ok, 1);
  assert.match(pdf.text, /X/);
});

test("dictWindow equivalence: FlateDecode stream + xref stream dict", () => {
  const textStream = deflateSync(Buffer.from("BT /F1 12 Tf 100 700 Td (Flated text) Tj ET", "latin1"));
  const parts = ["%PDF-1.5\n"];
  parts.push("1 0 obj\n<< /Type /Page /Contents 2 0 R >>\nendobj\n");
  const s2 = Buffer.concat([Buffer.from("2 0 obj\n<< /Length 60 /Filter /FlateDecode >>\nstream\n", "latin1"), textStream, Buffer.from("\nendstream\nendobj\n", "latin1")]);
  parts.push(s2.toString("latin1"));
  parts.push("3 0 obj\n<< /Type /XRef /Length 10 /Filter /FlateDecode >>\nstream\n");
  parts.push("garbage-not-zlib");
  parts.push("\nendstream\nendobj\n");
  const raw = parts.join("");
  const streamPos = collectNeedlePositions(raw, "\nstream");
  const endobjPos = collectNeedlePositions(raw, "endobj");
  const headerRe = /(\d+)\s+(\d+)\s+obj\b/g;
  let hm;
  while ((hm = headerRe.exec(raw)) !== null) {
    assert.equal(newDictWindow(raw, hm.index, streamPos, endobjPos), oldDictWindow(raw, hm.index));
  }
  const pdf = extractPdfWithStatus(Buffer.from(raw, "latin1"));
  assert.match(pdf.text, /Flated text/);
  assert.equal(pdf.xref.status, "failed");
});
