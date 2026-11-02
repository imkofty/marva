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

// A marker that is nothing but a page footer ("16. Page 21 of 21"):
// it hijacks the chain's first occurrence of that number and displaces
// the real entry. Such a marker is retried at its next occurrence.
const isFooterOnlyEntry = (txt) => /^(?:\d+\.|\[\d+\])\s*Page \d+( of \d+)?\s*$/.test(txt);

function parseNumericZone(zone) {
  const build = (markers) => {
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
    return { entries: entries.map((e) => e.text), keys, count: entries.length, rawEntries: entries };
  };
  const tryChain = (makeRe) => {
    const markers = []; // {n, idx}
    for (let n = 1; n <= 999; n++) {
      const re = makeRe(n);
      const m = re.exec(zone);
      if (!m) break;
      markers.push({ n, idx: m.index });
    }
    if (markers.length < 2) return null;
    // Footer fixup: a footer-only entry means the marker position is
    // wrong, not the entry missing; advance that marker to its next
    // occurrence and rebuild. Each move strictly increases an index,
    // so this terminates.
    for (let iter = 0; iter < 20; iter++) {
      const built = build(markers);
      const bad = built.rawEntries.find((e) => isFooterOnlyEntry(e.text));
      if (!bad) break;
      const mk = markers.find((m) => m.n === bad.n);
      const re = makeRe(mk.n);
      re.lastIndex = mk.idx + 1;
      const m2 = re.exec(zone);
      if (!m2) break;
      mk.idx = m2.index;
    }
    const built = build(markers);
    return { style: "numeric", entries: built.entries, keys: built.keys, count: built.count };
  };
  // What may follow the marker: any Unicode letter (\\p{L}) — the old
  // [A-Za-z] class stopped the 421 genetics chain at 115 because
  // entry 116 starts "Øvretveit", merging 116-125 into entry 115 —
  // or a number-word title start ("62. 7 Cups ...": the 315 chain
  // stopped at 61 because entry 62 starts with a digit, merging
  // 62-92 into entry 61). The digit form requires a space + letter
  // after the digits, so decimals ("3.5") still do not match.
  // Tried in order: dotted lists first (existing behaviour), then
  // bracketed lists "[1] ...", which previously returned no list.
  return tryChain((n) => new RegExp(`(?<!\\d)${n}\\.(?:\\s*\\p{L}|\\s+\\d+\\s+\\p{L})`, "gu"))
    || tryChain((n) => new RegExp(`\\[${n}\\](?:\\s*\\p{L}|\\s+\\d+\\s+\\p{L})`, "gu"));
}

function parseAuthorYearZone(zone) {
  // Two author-year list styles, both line-based:
  //  - "Davis, 1989. Perceived usefulness..." (surname, year up front)
  //  - APA: "Serra, C. E. M., & Kunc, M. (2015). Benefits..." and
  //    "Shaw, J., Gray, C. S., ... & Wodchis, W. (2018). ..." where
  //    the year sits in parentheses lines AFTER the start line (long
  //    author lists wrap). The year is therefore read from the whole
  //    entry, not from the start line alone; entries without any
  //    year are dropped (footers, headers, fragments).
  const lines = String(zone).split(/\n/);
  const entries = []; // {text, key}
  let current = null;
  let currentSurname = null;
  const flush = () => {
    if (current) {
      const parenYear = current.match(/\(((?:19|20)\d{2})\)/);
      const plainYear = current.match(/^[^,;]+,\s*((?:19|20)\d{2})\b/);
      const year = parenYear ? parenYear[1] : (plainYear ? plainYear[1] : null);
      // Artefact guard (20-paper test, Psychology paper): a fragment
      // like "(1), 2041" must not become a reference entry. Drop
      // entries whose author part has no letter at all (a bare
      // "(1)" or number) or is literally "et al.", and years beyond
      // next year (a misread volume/page, not a publication year).
      const sName = (currentSurname || "").trim().toLowerCase();
      const plausible = year && currentSurname
        && /[a-zà-ÿ]/.test(sName) && sName !== "et al." && sName !== "et al"
        && Number(year) <= new Date().getFullYear() + 1;
      if (plausible) entries.push({ text: current, key: `${currentSurname.trim().toLowerCase()}, ${year}` });
    }
    current = null;
    currentSurname = null;
  };
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (/^(appendix|acknowledg|funding|author contributions|conflict)/i.test(line)) { flush(); break; }
    let stripped = line.replace(/^[-•*]\s+/, "").replace(/^\d{1,3}\.\s+/, "");
    const plain = stripped.match(/^([^,;]{1,80}?),\s*((?:19|20)\d{2})\b/);
    const apa = stripped.match(/^([^,;]{1,80}?),\s*(?:[A-Z]\.\s*)+/);
    // Organisation author: "World Bank. (2006). Title..." / "OECD. (2015). ..."
    // — no comma after the name, so neither pattern above fires.
    const org = stripped.match(/^([A-Z][A-Za-zÀ-ÿ'’\-]+(?:\s+[A-Z][A-Za-zÀ-ÿ'’\-]+)*)\.\s*\(((?:19|20)\d{2})\)/);
    const orgSurname = org ? org[1] : null;
    // A surname+initial line is a NEW entry only when the current
    // entry already has its year. Otherwise it is still the author
    // list of the current entry wrapping onto a new line — the real
    // APA trap: "… Sheridan, N., &" then "Wodchis, W. (2018)." must
    // NOT split the Shaw entry into a yearless Shaw (dropped) plus
    // a spurious Wodchis entry.
    const currentHasYear = current && (/\(((?:19|20)\d{2})\)/.test(current) || /^[^,;]+,\s*(?:19|20)\d{2}\b/.test(current));
    if ((plain || apa || org) && (!current || currentHasYear)) {
      flush();
      current = stripped;
      currentSurname = plain ? plain[1] : (apa ? apa[1] : orgSurname);
    } else if (current) {
      // Continuation line of the previous entry (wrapped PDF line).
      if (!/^\d{1,3}\.\s*[A-Z]/.test(line)) current += " " + line;
    }
  }
  flush();
  if (entries.length < 2) return null;
  return { style: "author-year", entries: entries.map((e) => e.text), keys: entries.map((e) => e.key), count: entries.length };
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
  // PDF extraction wraps lines and mangles ligatures inside citations:
  // "Fadiji et al.\n,\n2024" (comma wrapped to the next line) and
  // "Abdellaoui et\x1fal., 2020" (the et-al. ligature surfacing as a
  // control character) are both real citations the old regexes missed
  // entirely: on the 20-paper test this dropped Psychology detection
  // from 92 real citations to 0 and Education from 117 to 6.
  // Normalise before scanning: control characters (ligature artefacts)
  // become spaces, and a hyphen at a line break joins the word back.
  // Newlines themselves are kept: \s in the patterns already spans them.
  const text = String(bodyText)
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, " ")
    .replace(/-\n/g, "-");
  const out = [];
  const seen = new Set();
  const push = (surname, year) => {
    const key = `${surname.trim().toLowerCase()}, ${year}`;
    if (!seen.has(key)) { seen.add(key); out.push(key); }
  };
  // Second-author guard: a surname that directly follows "&" or
  // "and" (allowing a line break between, as PDF extraction wraps:
  // "Serra & \nKunc, 2015") is NOT its own citation; re3/re4 capture
  // the first author instead. A fixed lookbehind alone fails across
  // the line break, so check the last word before the match.
  const isSecondAuthor = (idx) => /(?:^|[\s])(&|and)$/.test(text.slice(0, idx).trimEnd());
  const re1 = /\b(?<!& )(?<!and )([A-Z][A-Za-zÀ-ÿ'’\-]+)(?:\s+et al\.?)?\s*,\s*((?:19|20)\d{2})\b/g;
  let m;
  while ((m = re1.exec(text)) !== null) { if (!isSecondAuthor(m.index)) push(m[1], m[2]); }
  const re2 = /\b(?<!& )(?<!and )([A-Z][A-Za-zÀ-ÿ'’\-]+)(?:\s+et al\.?)?\s*\(((?:19|20)\d{2})\)/g;
  while ((m = re2.exec(text)) !== null) { if (!isSecondAuthor(m.index)) push(m[1], m[2]); }
  // APA two-author citations: only the FIRST author keys the entry,
  // so "(Serra & Kunc, 2015)" and "Serra and Kunc (2015)" must yield
  // "serra, 2015", not "kunc, 2015" (which would false-flag both ways).
  const re3 = /\b([A-Z][A-Za-zÀ-ÿ'’\-]+)\s+(?:&|and)\s+[A-Z][A-Za-zÀ-ÿ'’\-]+\s*,\s*((?:19|20)\d{2})\b/g;
  while ((m = re3.exec(bodyText)) !== null) push(m[1], m[2]);
  const re4 = /\b([A-Z][A-Za-zÀ-ÿ'’\-]+)\s+(?:&|and)\s+[A-Z][A-Za-zÀ-ÿ'’\-]+\s*\(((?:19|20)\d{2})\)/g;
  while ((m = re4.exec(bodyText)) !== null) push(m[1], m[2]);
  return out;
}

// Citing-sentence contexts for the Wonder cross-check: for each distinct
// author-year key found by scanAuthorYearCitations, the sentence that
// contains its first occurrence (bounded by sentence terminators or
// 300 characters each way). The cross-check needs the sentence because
// a cited key alone cannot distinguish two same-surname same-year
// entries; without it, a model pick would be a guess, not evidence.
// Same normalisation and patterns as scanAuthorYearCitations, so the
// keys here match that scan exactly.
export function scanAuthorYearCitationContexts(bodyText) {
  const text = String(bodyText)
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, " ")
    .replace(/-\n/g, "-");
  const out = [];
  const seen = new Set();
  const sentenceAround = (idx, len) => {
    let start = idx;
    const back = text.slice(Math.max(0, idx - 300), idx);
    const bm = back.match(/[.!?][\s\n]+[^\s\n]*$/);
    if (bm) start = Math.max(0, idx - 300) + bm.index + bm[0].length;
    else start = Math.max(0, idx - 300);
    let end = idx + len;
    const fwd = text.slice(idx + len, idx + len + 300);
    const fm = fwd.match(/[.!?](?:\s|$)/);
    if (fm) end = idx + len + fm.index + 1;
    else end = Math.min(text.length, idx + len + 300);
    return text.slice(start, end).replace(/\s+/g, " ").trim();
  };
  const push = (surname, year, idx, len) => {
    const key = `${surname.trim().toLowerCase()}, ${year}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ key, sentence: sentenceAround(idx, len) });
  };
  const isSecondAuthor = (idx) => /(?:^|[\s])(&|and)$/.test(text.slice(0, idx).trimEnd());
  let m;
  const re1 = /\b(?<!& )(?<!and )([A-Z][A-Za-zÀ-ÿ'’\-]+)(?:\s+et al\.?)?\s*,\s*((?:19|20)\d{2})\b/g;
  while ((m = re1.exec(text)) !== null) { if (!isSecondAuthor(m.index)) push(m[1], m[2], m.index, m[0].length); }
  const re2 = /\b(?<!& )(?<!and )([A-Z][A-Za-zÀ-ÿ'’\-]+)(?:\s+et al\.?)?\s*\(((?:19|20)\d{2})\)/g;
  while ((m = re2.exec(text)) !== null) { if (!isSecondAuthor(m.index)) push(m[1], m[2], m.index, m[0].length); }
  const re3 = /\b([A-Z][A-Za-zÀ-ÿ'’\-]+)\s+(?:&|and)\s+[A-Z][A-Za-zÀ-ÿ'’\-]+\s*,\s*((?:19|20)\d{2})\b/g;
  while ((m = re3.exec(text)) !== null) push(m[1], m[2], m.index, m[0].length);
  const re4 = /\b([A-Z][A-Za-zÀ-ÿ'’\-]+)\s+(?:&|and)\s+[A-Z][A-Za-zÀ-ÿ'’\-]+\s*\(((?:19|20)\d{2})\)/g;
  while ((m = re4.exec(text)) !== null) push(m[1], m[2], m.index, m[0].length);
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
