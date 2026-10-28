// Minimal PDF text extractor, Node standard library only.
// Handles uncompressed and FlateDecode streams, Tj and TJ operators.
// It does NOT handle scanned images, encrypted PDFs, or embedded fonts
// with custom encodings: those return what could be extracted, and the
// caller must report the limit honestly, never invent missing text.
import { inflateSync } from "node:zlib";

function decodePdfString(s) {
  return s.replace(/\\([()\\])/g, "$1").replace(/\\([0-7]{1,3})/g, (_, o) => String.fromCharCode(parseInt(o, 8)));
}

export function extractTextFromPdf(buffer) {
  const raw = buffer.toString("latin1");
  const chunks = [];
  const streamRe = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let m;
  while ((m = streamRe.exec(raw)) !== null) {
    let data;
    try { data = inflateSync(Buffer.from(m[1], "latin1")).toString("latin1"); }
    catch { data = m[1]; }
    const tjRe = /\((?:[^()\\]|\\.)*\)\s*Tj/g;
    let t;
    while ((t = tjRe.exec(data)) !== null) chunks.push(decodePdfString(t[0].slice(1, -3)));
    const tjArrRe = /\[(?:[^\[\]])*\]\s*TJ/g;
    while ((t = tjArrRe.exec(data)) !== null) {
      const inner = t[0].match(/\((?:[^()\\]|\\.)*\)/g) || [];
      chunks.push(inner.map((s) => decodePdfString(s.slice(1, -1))).join(""));
    }
  }
  return chunks.join("\n").trim();
}
