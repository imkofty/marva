// Sequential PDF text extractor, adapted from backend/src/lib/pdf.mjs.
// Requires nodejs_compat (see wrangler.toml) for node:zlib and Buffer.
// Handles uncompressed and FlateDecode streams, Tj and TJ operators
// IN STREAM ORDER. The previous version collected all Tj chunks before
// all TJ chunks per stream, which scrambled real PDFs: PLOS reference
// numbers ("1. Ioannidis...") and MDPI brackets ("[4]", "[5,6]")
// were separated from their entries, and MDPI looked "superscript"
// when it is in fact bracketed. Order matters, so operators are
// tokenised and executed in sequence here.
// Superscript marking: a run is wrapped in \u0001...\u0002 ONLY when
// it is a pure number that is BOTH smaller than body text AND raised
// above its line (Ts rise, or smaller size + y offset vs the previous
// body run in the same stream). Bracket citations are the same size
// as body text, so they are never marked. Marked numbers are the
// ONLY superscript citations the matcher may use; bare numbers in
// plain text are never treated as citations.
// It does NOT handle scanned images, encrypted PDFs, hex-string text,
// or embedded fonts with custom encodings: those return what could
// be extracted, and the caller must report the limit honestly, never
// invent missing text.
import { inflateSync } from "node:zlib";

function decodePdfString(s) {
  return s.replace(/\\([()\\])/g, "$1").replace(/\\([0-7]{1,3})/g, (_, o) => String.fromCharCode(parseInt(o, 8)));
}

function tokenize(data) {
  const toks = [];
  let i = 0;
  while (i < data.length) {
    const c = data[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === "%") { while (i < data.length && data[i] !== "\n") i++; continue; }
    if (c === "<" || c === ">") { i++; continue; }
    if (c === "(") {
      let depth = 1, j = i + 1, buf = "";
      while (j < data.length && depth > 0) {
        const ch = data[j];
        if (ch === "\\" && j + 1 < data.length) { buf += data[j] + data[j + 1]; j += 2; continue; }
        if (ch === "(") depth++;
        else if (ch === ")") depth--;
        if (depth > 0) buf += ch;
        j++;
      }
      toks.push({ t: "str", v: decodePdfString(buf) });
      i = j;
      continue;
    }
    if (c === "[") { toks.push({ t: "[", v: "[" }); i++; continue; }
    if (c === "]") { toks.push({ t: "]", v: "]" }); i++; continue; }
    if (c === "/") {
      let j = i + 1;
      while (j < data.length && !/[\s\[\]()<>/%]/.test(data[j])) j++;
      toks.push({ t: "name", v: data.slice(i, j) });
      i = j;
      continue;
    }
    let j = i;
    while (j < data.length && !/[\s\[\]()<>/%]/.test(data[j])) j++;
    if (j === i) j++;
    const w = data.slice(i, j);
    toks.push({ t: /^-?\d+(\.\d+)?$/.test(w) ? "num" : "op", v: w });
    i = j;
  }
  return toks;
}

function extractRuns(data) {
  const toks = tokenize(data);
  const runs = [];
  let stack = [];
  let arr = null;
  let fontSize = 0, rise = 0, leading = 0;
  let lineM = [1, 0, 0, 1, 0, 0], textM = [1, 0, 0, 1, 0, 0];
  const emit = (text) => {
    if (text) runs.push({ text, size: fontSize * Math.hypot(textM[0], textM[1]) || fontSize, rise, x: textM[4], y: textM[5] });
  };
  for (const tk of toks) {
    if (tk.t === "[") { arr = []; continue; }
    if (tk.t === "]") { stack.push({ t: "arr", v: arr }); arr = null; continue; }
    if (arr !== null) { arr.push(tk); continue; }
    if (tk.t === "op") {
      const op = tk.v;
      if (op === "BT") { lineM = [1, 0, 0, 1, 0, 0]; textM = [1, 0, 0, 1, 0, 0]; }
      else if (op === "Tf") fontSize = parseFloat(stack[stack.length - 1]?.v || 0);
      else if (op === "Ts") rise = parseFloat(stack[stack.length - 1]?.v || 0);
      else if (op === "TL") leading = parseFloat(stack[stack.length - 1]?.v || 0);
      else if (op === "Td" || op === "TD") {
        const ty = parseFloat(stack[stack.length - 1]?.v || 0), tx = parseFloat(stack[stack.length - 2]?.v || 0);
        if (op === "TD") leading = -ty;
        lineM = [lineM[0], lineM[1], lineM[2], lineM[3], lineM[4] + tx, lineM[5] + ty];
        textM = [...lineM];
      }
      else if (op === "Tm") {
        const nums = stack.slice(-6).map((s) => parseFloat(s.v || 0));
        if (nums.length === 6) { lineM = nums; textM = [...nums]; }
      }
      else if (op === "T*") { lineM = [lineM[0], lineM[1], lineM[2], lineM[3], lineM[4], lineM[5] - leading]; textM = [...lineM]; }
      else if (op === "Tj") { const s = stack[stack.length - 1]; if (s?.t === "str") emit(s.v); }
      else if (op === "TJ") {
        const a = stack[stack.length - 1];
        if (a?.t === "arr") {
          // One TJ array = one run: fragments join with "" (word
          // fragments like "(Robot)1(ic)" must NOT be split), and a
          // large negative kerning gap (<= -200, e.g. -250 word
          // spaces in MDPI, -502 after "1." in PLOS) becomes a space.
          // Small kerning (18, 92, 111) is letter spacing, not a space.
          let s = "";
          for (const el of a.v) {
            if (el.t === "str") s += el.v;
            else if (el.t === "num" && parseFloat(el.v) <= -200 && s && !/\s$/.test(s)) s += " ";
          }
          emit(s);
        }
      }
      else if (op === "'" || op === '"') { const s = stack[stack.length - 1]; if (s?.t === "str") emit(s.v); }
      stack = [];
      continue;
    }
    stack.push(tk);
  }
  return runs;
}

function markSuperscripts(runs) {
  // Body size: median size of long runs (paragraph text, not headers).
  const bodySizes = runs.filter((r) => r.text.length >= 20 && r.size > 0).map((r) => r.size).sort((a, b) => a - b);
  const bodySize = bodySizes.length ? bodySizes[Math.floor(bodySizes.length / 2)] : 0;
  return runs.map((r, i) => {
    if (!/^\d{1,3}$/.test(r.text.trim())) return r.text;
    if (r.rise > 0.5) return `\u0001${r.text.trim()}\u0002`;
    if (bodySize > 0 && r.size > 0 && r.size < bodySize * 0.85) {
      // Raised above the previous body run in the same stream?
      // Runs are in stream order, so look back at most 3 runs.
      for (let j = i - 1; j >= Math.max(0, i - 3); j--) {
        const prev = runs[j];
        if (prev.text.length >= 10 && prev.size >= bodySize * 0.9) {
          const dy = r.y - prev.y;
          if (dy >= 1 && dy <= 6) return `\u0001${r.text.trim()}\u0002`;
          break;
        }
      }
    }
    return r.text;
  });
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
    if (!data.includes("Tj") && !data.includes("TJ")) continue;
    const runs = extractRuns(data);
    if (runs.length === 0) continue;
    chunks.push(...markSuperscripts(runs));
  }
  return chunks.join("\n").trim();
}
