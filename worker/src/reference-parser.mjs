// Deterministic reference-list parser + citation scanner — code, never a model.
// Why this module exists (verified against real extracted text, 2026-10-28):
//  - The old extractor joined Tj chunks before TJ chunks per stream, so
//    PLOS reference numbers ("1. Ioannidis...") and MDPI brackets
//    ("[4]", "[5,6]") were scrambled or lost in the old output. The
//    sequential extractor in pdf.mjs restores them, and this parser
//    reads them back with rules that can be tested against fixtures.
//  - MDPI Sensors (35 pp) is BRACKETED, not superscript, in sequential
//    extraction: citations appear as [4], [5,6], [7,8]. The earlier
//    "MDPI = superscript" claim was an artefact of the old extractor
//    (brackets separated by newlines, numbers as bare text). True
//    superscript PDFs are handled by the marked-number path below;
//    bare numbers are NEVER treated as citations, because they cannot
//    be told apart from page numbers, years and counts.
// Parser rules:
//  - Zone: text after the LAST References/Bibliography heading that
//    yields a usable list (tried last-to-first, so a body mention of
//    the word "references" does not hijack the zone).
//  - Numeric list: entries are keyed by number, NOT by text order.
//    MDPI streams put entry 9 after entry 19 in file order, so a
//    sequential 1,2,3 chain in text order fails on real PDFs. For
//    n = 1,2,3,... we take the first marker "n." that is NOT preceded
//    by a digit (this rejects "0." inside "10.", "3." inside "13.",
//    and "357." page-footer artefacts) and stop at the first missing
//    number. Entry text runs to the next marker in TEXT order.
//  - Author-year list: line-based, "- Davis, 1989. ..." lines, with
//    continuation lines appended. A leading "12. " number is stripped.
//  - Failure is honest: a broken chain or <2 entries returns
//    status "failed", and the caller must gate, never half-match.
// Citation scanning (body text only — the reference zone itself is
// NEVER scanned, or every listed reference would look "cited"):
//  - author-year: "Davis, 1989", "Davis (1989)", "Davis et al., 1989"
//    (et al stripped, so the key matches "davis, 1989").
//  - bracket: [10], [4,8,17], [18-20] (en-dash and hyphen ranges).
//  - superscript: numbers wrapped in \u0001...\u0002 by pdf.mjs only.
//    Bare numbers in plain text are never scanned as citations.

export function stripMarkerChars(s) {
  return String(s || "").replace(/|/g, "");
}

function cleanEntry(s) {
  let e = String(s || "").replace(/\s+/g, " ").trim();
  // Strip trailing CrossRef / PubMed tokens (repeated at entry ends).
  e = e.replace(/(?:\s*\[?(?:CrossRef|PubMed)\]?)+$/i, "").trim();
  // Strip a page-footer artefact glued to the end ("...444432of35").
  return e;
}

function parseNumericZone(zone) {
  const markers = []; // {n, idx}
  for (let n = 1; n <= 999; n++) {
    // Letter after the dot may be lowercase ("de Looze", "van der").
    const re = new RegExp(`(?<!\\d)${n}\\.\\s*[A-Za-z]`, "g");
    const m = re.exec(zone);
    if (!m) break;
    markers.push({ n, idx: m.index });
  }
  if (markers.length < 2) return null;
  const byPos = [...markers].sort((a, b) => a.idx - b.idx);
  const entries = [];
  const keys = [];
  for (const mk of markers) {
    const next = byPos.find((x) => x.idx > mk.idx);
    const end = next ? next.idx : zone.length;
    entries.push({ n: mk.n, text: cleanEntry(zone.slice(mk.idx, end)) });
    keys.push(String(mk.n));
  }
  entries.sort((a, b) => a.n - b.n);
  keys.sort((a, b) => Number(a) - Number(b));
  return { style: "numeric", entries: entries.map((e) => e.text), keys, count: entries.length };
}

function parseAuthorYearZone(zone) {
  const lines = String(zone).split(/\n/);
  const entries = [];
  let current = null;
  const flush = () => { if (current) entries.push(current); current = null; };
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (/^(appendix|acknowledg|funding|author contributions|conflict)/i.test(line)) { flush(); break; }
    let stripped = line.replace(/^[-•*]\s+/, "").replace(/^\d{1,3}\.\s+/, "");
    const m = stripped.match(/^([^,;]{1,80}?),\s*((?:19|20)\d{2})\b/);
    if (m) {
      flush();
      current = stripped;
    } else if (current) {
      // Continuation line of the previous entry (wrapped PDF line).
      if (!/^\d{1,3}\.\s*[A-Z]/.test(line)) current += " " + line;
    }
  }
  flush();
  if (entries.length < 2) return null;
  const keys = entries.map((e) => {
    const mm = e.match(/^([^,;]+),\s*((?:19|20)\d{2})\b/);
    return mm ? `${mm[1].trim().toLowerCase()}, ${mm[2]}` : e.toLowerCase();
  });
  return { style: "author-year", entries, keys, count: entries.length };
}

export function splitReferenceZone(text) {
  const plain = stripMarkerChars(text);
  const headingRe = /\b(References|Bibliography)\b/gi;
  const headings = [...plain.matchAll(headingRe)];
  for (let i = headings.length - 1; i >= 0; i--) {
    const h = headings[i];
    const zoneStart = h.index + h[0].length;
    const zone = plain.slice(zoneStart);
    const body = plain.slice(0, h.index);
    const numeric = parseNumericZone(zone);
    if (numeric) return { found: true, body, zone, headingIndex: h.index, ...numeric };
    const ay = parseAuthorYearZone(zone);
    if (ay) return { found: true, body, zone, headingIndex: h.index, ...ay };
  }
  return { found: false, body: plain, zone: "", headingIndex: -1, style: null, entries: [], keys: [], count: 0 };
}

export function parseReferences(text) {
  const split = splitReferenceZone(text);
  if (!split.found) return { status: "no_references", style: null, entries: [], keys: [], count: 0, body: split.body, note: "No reference list was found in the document. Citation checking was skipped; this dimension is not scored." };
  return { status: "parsed", style: split.style, entries: split.entries, keys: split.keys, count: split.entries.length, body: split.body, note: null };
}

export function scanAuthorYearCitations(bodyText) {
  const out = [];
  const seen = new Set();
  const push = (surname, year) => {
    const key = `${surname.trim().toLowerCase()}, ${year}`;
    if (!seen.has(key)) { seen.add(key); out.push(key); }
  };
  const re1 = /\b([A-Z][A-Za-zÀ-ÿ'’\-]+)(?:\s+et al\.?)?,\s*((?:19|20)\d{2})\b/g;
  let m;
  while ((m = re1.exec(bodyText)) !== null) push(m[1], m[2]);
  const re2 = /\b([A-Z][A-Za-zÀ-ÿ'’\-]+)(?:\s+et al\.?)?\s*\(((?:19|20)\d{2})\)/g;
  while ((m = re2.exec(bodyText)) !== null) push(m[1], m[2]);
  return out;
}

export function expandBracketGroup(group) {
  const out = [];
  for (const part of String(group).split(",")) {
    const p = part.trim();
    const range = p.match(/^(\d{1,3})\s*[–\-]\s*(\d{1,3})$/);
    if (range) {
      const a = Number(range[1]), b = Number(range[2]);
      if (b >= a && b - a <= 100) for (let n = a; n <= b; n++) out.push(String(n));
    } else if (/^\d{1,3}$/.test(p)) out.push(String(Number(p)));
  }
  return out;
}

export function scanBracketCitations(bodyText) {
  const out = [];
  const seen = new Set();
  const re = /\[\s*(\d{1,3}(?:\s*[,–\-]\s*\d{1,3})*)\s*\]/g;
  let m;
  while ((m = re.exec(bodyText)) !== null) {
    for (const n of expandBracketGroup(m[1])) {
      if (!seen.has(n)) { seen.add(n); out.push(n); }
    }
  }
  return out;
}

export function scanSuperscriptCitations(markedBodyText) {
  const out = [];
  const seen = new Set();
  const re = /(\d{1,3}(?:,\d{1,3})*)/g;
  let m;
  while ((m = re.exec(markedBodyText)) !== null) {
    for (const n of m[1].split(",")) {
      const k = String(Number(n));
      if (!seen.has(k)) { seen.add(k); out.push(k); }
    }
  }
  return out;
}

// Body split for marked text: same heading search, on marked text.
export function splitMarkedBody(markedText) {
  const re = /\b(References|Bibliography)\b/gi;
  const headings = [...markedText.matchAll(re)];
  if (headings.length === 0) return markedText;
  return markedText.slice(0, headings[headings.length - 1].index);
}
