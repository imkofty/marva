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
// Memory bound (2026-10-29 fix for Worker 1102 upload failures): the old
// version built one token object per operator/number of every stream, so
// PDFs with 10-45 MB inflated streams (the five 20-paper upload failures)
// blew the 128 MB Worker limit while smaller PDFs worked. Tokenising is
// now lazy (generator, one token alive at a time) and image streams are
// skipped before inflation, so peak memory is bounded by the largest
// single text stream, not by the sum of all tokens.
// Scanned images and encrypted PDFs are DETECTED, not read:
// extractPdfWithStatus reports image-only pages as EMPTY and tracks
// whether any non-image stream carries text operators, so analyzePdf
// can label a file scanned (image dicts present, zero text, no text
// operators) without guessing from absent text; isEncryptedPdf
// detects the /Encrypt entry structurally. Hex-string text and
// custom font encodings still return what could be extracted, and
// the caller must report the limit honestly, never invent text.
import { inflateSync } from "node:zlib";

function decodePdfString(s) {
  return s.replace(/\\([()\\])/g, "$1").replace(/\\([0-7]{1,3})/g, (_, o) => String.fromCharCode(parseInt(o, 8)));
}

function* tokenize(data) {
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
      yield { t: "str", v: decodePdfString(buf) };
      i = j;
      continue;
    }
    if (c === "[") { yield { t: "[", v: "[" }; i++; continue; }
    if (c === "]") { yield { t: "]", v: "]" }; i++; continue; }
    if (c === "/") {
      let j = i + 1;
      while (j < data.length && !/[\s\[\]()<>/%]/.test(data[j])) j++;
      yield { t: "name", v: data.slice(i, j) };
      i = j;
      continue;
    }
    let j = i;
    while (j < data.length && !/[\s\[\]()<>/%]/.test(data[j])) j++;
    if (j === i) j++;
    const w = data.slice(i, j);
    yield { t: /^-?\d+(\.\d+)?$/.test(w) ? "num" : "op", v: w };
    i = j;
  }
}

function extractRuns(data) {
  const runs = [];
  let stack = [];
  let arr = null;
  let fontSize = 0, rise = 0, leading = 0;
  let lineM = [1, 0, 0, 1, 0, 0], textM = [1, 0, 0, 1, 0, 0];
  const emit = (text) => {
    if (text) runs.push({ text, size: fontSize * Math.hypot(textM[0], textM[1]) || fontSize, rise, x: textM[4], y: textM[5] });
  };
  for (const tk of tokenize(data)) {
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
      // Raised above a neighbouring body line? Stream order scrambles
      // two-column layouts, so the digit's own line may sit AFTER it
      // in stream order (315: digit y=262.7, following line y=258.2,
      // raised by 4.5) as well as before it. Check the nearest long
      // body run in either direction (up to 6 runs out); a digit
      // sitting 1-6 units above that line's baseline is a superscript
      // citation. Rise (Ts) above already returned above.
      const isBodyLine = (x) => x.text.length >= 10 && x.size >= bodySize * 0.9;
      for (let j = i - 1; j >= Math.max(0, i - 6); j--) {
        if (isBodyLine(runs[j])) {
          const dy = r.y - runs[j].y;
          if (dy >= 1 && dy <= 6) return `\u0001${r.text.trim()}\u0002`;
          break;
        }
      }
      for (let j = i + 1; j <= Math.min(runs.length - 1, i + 6); j++) {
        if (isBodyLine(runs[j])) {
          const dy = r.y - runs[j].y;
          if (dy >= 1 && dy <= 6) return `\u0001${r.text.trim()}\u0002`;
          break;
        }
      }
    }
    return r.text;
  });
}

// ---- P7: page-aware extraction status (2026-11-03) ----
// The legacy extractor scanned streams globally and returned bare
// text: a broken xref stream, a broken page, or a partially readable
// file all looked identical (a string, possibly empty). The status
// wrapper below keeps that text byte-identical for healthy files
// and adds honest accounting alongside it:
//   status "ok"      — text extracted, no failed/damaged page, xref readable.
//   status "partial" — text extracted from at least one page, but some
//                      page failed/damaged, or the xref stream is broken.
//   status "failed"  — no text extracted at all (all pages failed, or
//                      content hidden in object streams, or no text).
// Page numbers are 1-based indices of /Page objects in file order
// (the /Pages /Kids tree order is NOT followed; for linear PDFs the
// two coincide). A page FAILS only when it has content streams, none
// produced text, and at least one stream is broken (a FlateDecode
// stream that fails to inflate with no recoverable runs, a throwing
// content parser, or a referenced stream object with no parseable
// stream data). A page
// with text but a broken stream is DAMAGED, not failed. A page with
// no text and no broken stream (image-only, blank) is EMPTY, not a
// failure. Xref status "failed" means an /XRef stream object exists
// whose FlateDecode data does not inflate, or whose stream data is
// missing/truncated. Xref streams without a FlateDecode filter are
// not judged failed on inflate error, since their raw bytes are
// readable as-is (real writers always use FlateDecode here).
// Streams that inflate but yield no runs are EMPTY, never broken:
// an uncompressed content stream "fails" inflate by design (it is
// not zlib data) and recovers its text from the raw fallback, so
// broken requires a FlateDecode claim AND inflate failure AND no
// runs from the fallback.

// Dict-only window for an object header: end at the object's own
// stream keyword or endobj, so a window never swallows the NEXT
// object's dict (a stream followed by a /Page dict within 4000
// chars would otherwise be misclassified as a page itself).
// 328 fix (2026-11-03): dictWindow used to call raw.indexOf() per
// header, and that scan runs forward to the NEXT stream — which for
// dict-only objects can be most of the file away. With 2754 headers
// in epmc2-328 that one call cost ~5.0s of the ~5.1s analyzePdf and
// pushed the POST handler past the live Worker CPU budget (1102),
// while 443 (711 headers, ~1.3s) and 435 (2060 headers, ~1.9s) still
// passed. The positions are now collected once (one linear pass)
// and looked up by binary search: identical window semantics, no
// per-header scan. Callers without precomputed arrays keep the old
// indexOf path, so the function stays usable standalone.
export function collectNeedlePositions(raw, needle) {
  const positions = [];
  let pos = raw.indexOf(needle, 0);
  while (pos >= 0) {
    positions.push(pos);
    pos = raw.indexOf(needle, pos + 1);
  }
  return positions;
}

export function nextPosAtOrAfter(positions, start) {
  let lo = 0, hi = positions.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (positions[mid] < start) lo = mid + 1; else hi = mid;
  }
  return lo < positions.length ? positions[lo] : -1;
}

function dictWindow(raw, start, streamPos, endobjPos) {
  let winEnd = start + 4000;
  const s = streamPos ? nextPosAtOrAfter(streamPos, start) : raw.indexOf("\nstream", start);
  const e = endobjPos ? nextPosAtOrAfter(endobjPos, start) : raw.indexOf("endobj", start);
  if (s >= 0) winEnd = Math.min(winEnd, s);
  if (e >= 0) winEnd = Math.min(winEnd, e);
  return raw.slice(start, winEnd);
}

function parsePageObjects(raw, headers, streamPos, endobjPos) {
  const pages = [];
  const xrefNums = new Set();
  for (const h of headers) {
    const win = dictWindow(raw, h.start, streamPos, endobjPos);
    if (/\/Type\s*\/XRef\b/.test(win)) { xrefNums.add(h.num); continue; }
    if (!/\/Type\s*\/Page\b/.test(win)) continue;
    let contents = [];
    const arr = win.match(/\/Contents\s*\[([^\]]*)\]/);
    if (arr) {
      for (const cm of arr[1].matchAll(/(\d+)\s+\d+\s+R/g)) contents.push(+cm[1]);
    } else {
      const single = win.match(/\/Contents\s+(\d+)\s+\d+\s+R/);
      if (single) contents = [+single[1]];
    }
    if (contents.length === 0 && win.includes("stream")) contents = [h.num];
    pages.push({ num: h.num, contents });
  }
  return { pages, xrefNums };
}

// Encrypted-PDF detection (deterministic, spec-grounded): every
// encrypted PDF MUST carry an /Encrypt entry in its trailer
// dictionary (classic xref) or its xref-stream dictionary (PDF
// 1.5+). Both live at end of file, so detection is structural:
//   1. classic: the dict after the last "trailer" keyword;
//   2. xref-stream: the dict of the last object before "startxref"
//      (up to 8 " obj" candidates scanned backwards, so binary
//      xref-stream data containing " obj" bytes cannot hide it);
//   3. fallback for malformed files with neither structure: the
//      last 64 KB tail.
// The key must be followed by an indirect reference or a direct
// dictionary, so prose merely mentioning encryption never matches.
// Documented limitation: an uncompressed content stream in the
// last 64 KB literally containing "/Encrypt 12 0 R" as text would
// false-positive on path 3 only; real PDFs compress streams, and
// the failure it causes is honest (skipped with the encryption
// reason), never a fake number.
const ENCRYPT_KEY_RE = /\/Encrypt\s*(<<|\d+\s+\d+\s+R)/;

export function isEncryptedPdf(input) {
  const raw = typeof input === "string" ? input : Buffer.from(input).toString("latin1");
  const startxref = raw.lastIndexOf("startxref");
  const trailer = raw.lastIndexOf("trailer");
  if (trailer >= 0) {
    const region = startxref > trailer ? raw.slice(trailer, startxref) : raw.slice(trailer);
    if (ENCRYPT_KEY_RE.test(region)) return true;
  }
  if (startxref >= 0) {
    let pos = startxref;
    for (let n = 0; n < 8; n++) {
      const objAt = raw.lastIndexOf(" obj", pos);
      if (objAt < 0) break;
      const streamAt = raw.indexOf("stream", objAt);
      const region = raw.slice(objAt, streamAt >= 0 && streamAt < startxref ? streamAt : startxref);
      if (ENCRYPT_KEY_RE.test(region)) return true;
      pos = objAt - 1;
    }
  } else if (trailer < 0) {
    if (ENCRYPT_KEY_RE.test(raw.slice(-65536))) return true;
  }
  return false;
}

// Scanned-PDF detection (2026-11-03, fix-scan): a PDF page that is a
// raster image has NO text operators in its content stream — only an
// image XObject invocation (Do). Detection is structural, never a
// guess from the (absent) text:
//   scanned  = zero extracted text AND an image XObject dict present
//              AND no Tj/TJ operator in any non-image stream.
// The Tj/TJ condition is the anti-false-positive guard: a text PDF
// that uses an encoding this extractor cannot read (hex strings,
// custom font encodings) still HAS text operators, so it is reported
// as unreadable text — never mislabelled "scanned". An /Encrypt
// marker takes precedence over both: an encrypted file is reported
// encrypted, never scanned. A dict hidden inside a compressed object
// stream is invisible to this scan, so such a file degrades to the
// generic no-text note rather than a false "scanned" label.
// Partial scans (some pages text, some image) are NOT detected: the
// extractor does not map streams to pages, so a mixed PDF runs on
// its text pages and the image pages are silently absent — a known
// limit, not a claim of coverage.
export const SCANNED_PDF_REASON = "PDF hasil scan, tidak ada lapisan teks; OCR di luar cakupan Worker sehingga teks tidak dapat dibaca.";
export const ENCRYPTED_PDF_REASON = "PDF terenkripsi; teks tidak dapat dibaca tanpa kata sandi.";

export function extractPdfWithStatus(buffer) {
  const raw = buffer.toString("latin1");
  const headers = [];
  const headerRe = /(\d+)\s+(\d+)\s+obj\b/g;
  let hm;
  while ((hm = headerRe.exec(raw)) !== null) headers.push({ num: +hm[1], start: hm.index });
  // One linear pass each: the per-header dictWindow lookups below
  // binary-search these instead of scanning forward per header.
  const streamPos = collectNeedlePositions(raw, "\nstream");
  const endobjPos = collectNeedlePositions(raw, "endobj");
  const { pages, xrefNums } = parsePageObjects(raw, headers, streamPos, endobjPos);

  const chunks = [];
  const streamRec = new Map(); // objNum -> { ok, broken, empty, skippedImage }
  const note = (num, kind) => {
    if (num === null) return;
    let r = streamRec.get(num);
    if (!r) { r = { ok: 0, broken: 0, empty: 0, skippedImage: 0 }; streamRec.set(num, r); }
    r[kind]++;
  };
  let xrefStatus = xrefNums.size ? "ok" : "absent";
  let xrefReason = null;
  const xrefSeen = new Set();
  // Scan-detection accounting (fix-scan): image dicts in the file,
  // and whether any non-image stream carries a text operator (the
  // anti-false-positive guard: hex/custom-encoded text PDFs still
  // HAVE operators, so they are never mislabelled "scanned").
  const imageCount = (raw.match(/\/Subtype\s*\/Image\b/g) || []).length;
  let sawTextOperators = false;

  const streamRe = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let m, hi = 0;
  while ((m = streamRe.exec(raw)) !== null) {
    while (hi + 1 < headers.length && headers[hi + 1].start <= m.index) hi++;
    const owner = headers.length && headers[hi].start <= m.index ? headers[hi].num : null;
    const isXref = owner !== null && xrefNums.has(owner);
    // Image XObjects inflate to full raster size (tens of MB) and can
    // never contain text operators: skip them before inflating.
    const dictAt = raw.lastIndexOf("<<", m.index);
    const dictWin = dictAt >= 0 && m.index - dictAt < 4000 ? raw.slice(dictAt, m.index) : "";
    if (!isXref && dictWin && /\/Subtype\s*\/Image/.test(dictWin)) { note(owner, "skippedImage"); continue; }
    let data, inflateOk = true;
    try { data = inflateSync(Buffer.from(m[1], "latin1")).toString("latin1"); }
    catch { data = m[1]; inflateOk = false; }
    if (isXref) {
      xrefSeen.add(owner);
      if (!inflateOk && /FlateDecode/.test(dictWindow(raw, headers[hi].start, streamPos, endobjPos))) { xrefStatus = "failed"; xrefReason = "xref-stream-inflate-failed"; }
      continue;
    }
    if (data.includes("Tj") || data.includes("TJ")) sawTextOperators = true;
    // A FlateDecode stream that fails to inflate and yields no text
    // is broken; any other text-less stream is merely empty (a
    // vector-only or image-only content stream, or an uncompressed
    // stream with no text operators).
    const brokenIfEmpty = !inflateOk && /FlateDecode/.test(dictWin);
    if (!data.includes("Tj") && !data.includes("TJ")) { note(owner, brokenIfEmpty ? "broken" : "empty"); continue; }
    try {
      const runs = extractRuns(data);
      if (runs.length === 0) { note(owner, brokenIfEmpty ? "broken" : "empty"); continue; }
      chunks.push(...markSuperscripts(runs));
    } catch { note(owner, "broken"); continue; }
    // Inflate failure with runs recovered from the raw fallback
    // counts as ok: the stream's text survived, nothing was lost.
    note(owner, "ok");
  }
  for (const xn of xrefNums) {
    if (!xrefSeen.has(xn) && xrefStatus !== "failed") { xrefStatus = "failed"; xrefReason = "xref-stream-truncated"; }
  }

  const failedPages = [], damagedPages = [];
  let okPages = 0, emptyPages = 0, missingStreams = 0;
  for (let i = 0; i < pages.length; i++) {
    let ok = 0, broken = 0;
    for (const cn of pages[i].contents) {
      const r = streamRec.get(cn);
      if (!r) { broken++; missingStreams++; }
      else if (r.broken > 0) broken++;
      else if (r.ok > 0) ok++;
      // empty / skippedImage only: neutral, not a failure.
    }
    if (ok > 0 && broken === 0) okPages++;
    else if (ok > 0) damagedPages.push(i + 1);
    else if (broken > 0) failedPages.push(i + 1);
    else emptyPages++;
  }
  const agg = { total: 0, ok: 0, broken: 0, empty: 0, skippedImage: 0, missing: missingStreams };
  for (const r of streamRec.values()) {
    agg.ok += r.ok; agg.broken += r.broken; agg.empty += r.empty; agg.skippedImage += r.skippedImage;
  }
  agg.total = agg.ok + agg.broken + agg.empty + agg.skippedImage;

  const text = chunks.join("\n").trim();
  let status, reason = null;
  if (!text) {
    status = "failed";
    reason = pages.length && failedPages.length === pages.length ? "all-pages-failed"
      : xrefStatus === "failed" ? "xref-stream-broken-no-text"
      : "no-text-extracted";
  } else if (failedPages.length || damagedPages.length || xrefStatus === "failed") {
    status = "partial";
    const parts = [];
    if (failedPages.length) parts.push(`${failedPages.length} page(s) failed (${failedPages.join(",")})`);
    if (damagedPages.length) parts.push(`${damagedPages.length} page(s) damaged (${damagedPages.join(",")})`);
    if (xrefStatus === "failed") parts.push(`xref stream broken (${xrefReason})`);
    reason = parts.join("; ");
  } else status = "ok";
  return {
    text,
    status,
    reason,
    chars: text.length,
    pages: { total: pages.length, ok: okPages, damaged: damagedPages.length, failed: failedPages.length, empty: emptyPages, failedPages, damagedPages },
    streams: agg,
    xref: { present: xrefNums.size > 0, status: xrefStatus, reason: xrefReason },
    imageCount,
    sawTextOperators,
  };
}

export function extractTextFromPdf(buffer) {
  if (isEncryptedPdf(buffer)) {
    const err = new Error("PDF terenkripsi, tidak bisa dibuka");
    err.code = "PDF_ENCRYPTED";
    throw err;
  }
  return extractPdfWithStatus(buffer).text;
}

export function analyzePdf(buffer) {
  const raw = Buffer.from(buffer).toString("latin1");
  const pageCount = (raw.match(/\/Type\s*\/Page(?![A-Za-z])/g) || []).length;
  if (isEncryptedPdf(raw)) {
    const imageCount = (raw.match(/\/Subtype\s*\/Image\b/g) || []).length;
    return { text: "", pageCount, imageCount, scanned: false, encrypted: true, reason: ENCRYPTED_PDF_REASON };
  }
  const pdf = extractPdfWithStatus(buffer);
  const scanned = !pdf.text && pdf.imageCount > 0 && !pdf.sawTextOperators;
  return {
    text: pdf.text,
    pageCount,
    imageCount: pdf.imageCount,
    scanned,
    encrypted: false,
    reason: scanned ? SCANNED_PDF_REASON : null,
    extraction: pdf,
  };
}
