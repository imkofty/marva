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
//  - Zone: text after the LAST reference-section heading that
//    yields a usable list (tried last-to-first, so a body mention of
//    the word "references" does not hijack the zone). Headings are
//    multilingual (REFERENCE_HEADINGS below), not English-only.
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

// Sentence-initial discourse adverbs are NEVER authors (429 wart, 2026-11-03):
// "Interestingly, Tan and Tan (2000)" was scanned as "interestingly, 2000"
// two ways at once — the three-author pattern re6 read the adverb as a
// first author, and precededBySurnameComma read "Interestingly, " as
// "Surname, ", which blocked the true "Tan and Tan (2000)" match.
// The set holds only unambiguous discourse markers: no entry is a
// plausible surname (Long, Young, Still, Well are deliberately absent),
// so rejecting a captured first author in this set cannot drop a real
// citation. Applied to the captured first author of all six patterns
// in both scan functions, and as an exemption inside
// precededBySurnameComma, so the true citation author wins.
const SENTENCE_ADVERBS = new Set([
  "accordingly", "additionally", "admittedly", "alternatively", "amazingly",
  "astonishingly", "clearly", "consequently", "conversely", "crucially",
  "curiously", "essentially", "evidently", "finally", "firstly",
  "fortunately", "furthermore", "happily", "hopefully", "however",
  "importantly", "initially", "interestingly", "ironically", "lastly",
  "meanwhile", "moreover", "nevertheless", "nonetheless", "notably",
  "obviously", "originally", "paradoxically", "practically",
  "predictably", "previously", "realistically", "recently", "regrettably",
  "remarkably", "revealingly", "sadly", "secondly", "significantly",
  "similarly", "strikingly", "subsequently", "surprisingly", "thankfully",
  "thirdly", "ultimately", "understandably", "unfortunately",
  "unsurprisingly", "worryingly",
]);
const isSentenceAdverb = (word) => SENTENCE_ADVERBS.has(String(word).toLowerCase());

// Reference-section headings, beyond English. Longest forms first:
// alternation tries left to right, so "Literaturverzeichnis" must
// precede "Literatur" or the match would start mid-word. Boundaries
// are Unicode letter/number lookarounds, not \b: \b is ASCII-only
// and would never match a Cyrillic heading. A bare word in body text
// (e.g. German "Literatur") is harmless by design: the caller tries
// headings last-to-first and only accepts a zone that yields a
// usable (>=2-entry) list, exactly as for English "References".
const REFERENCE_HEADINGS = [
  "Referencias Bibliográficas",
  "Referências Bibliográficas",
  "Riferimenti bibliografici",
  "Список использованных источников",
  "Daftar Pustaka",
  "Daftar Referensi",
  "Literaturverzeichnis",
  "Quellenverzeichnis",
  "Literatuurlijst",
  "Список литературы",
  "Bibliografía",
  "Bibliographie",
  "Bibliografia",
  "Referencias",
  "Referências",
  "Referenties",
  "Referanser",
  "Referenser",
  "Références",
  "Literatur",
  "Literatuur",
  "Bibliography",
  "References",
  "Литература",
  "Bronnen",
  "Kaynakça",
];
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const REFERENCE_HEADING_RE = new RegExp(
  `(?<![\\p{L}\\p{N}])(?:${REFERENCE_HEADINGS.map(escRe).join("|")})(?![\\p{L}\\p{N}])`,
  "giu"
);

export function stripMarkerChars(s) {
  return String(s || "").replace(/|/g, "");
}

function stripMdpiFooter(e) {
  // Shape 2: MDPI publisher boilerplate glued to the last entry.
  // The MDPI mention guards against cutting a hypothetical real
  // sentence that merely contains the word "Disclaimer".
  const disc = e.indexOf("Disclaimer/Publisher's Note:");
  if (disc >= 0 && e.slice(disc).includes("MDPI")) return e.slice(0, disc).trim();
  // Shape 1: footer DOI + journal + year/vol/article + "N of M".
  // Start from the LAST doi.org match: an entry could in theory
  // carry its own DOI before the footer, and only the footer tail
  // may go. The tail must match the full footer shape — a genuine
  // entry DOI is never followed by "N of M".
  const re = /(?:https?:\/\/)?doi\.org\/10\.\d{4,9}\/\S+/g;
  let last = null, m;
  while ((m = re.exec(e)) !== null) last = m;
  if (!last) return e;
  const tail = e.slice(last.index);
  if (/^(?:https?:\/\/)?doi\.org\/10\.\d{4,9}\/\S+\s+.+\s\d{4}\s*,\s*\d+\s*,\s*\S+\s+\d+ of \d+$/.test(tail)) {
    return e.slice(0, last.index).trim();
  }
  return e;
}

function cleanEntry(s) {
  let e = String(s || "").replace(/\s+/g, " ").trim();
  // Strip an MDPI page footer glued to the end of the entry (papers
  // 336/443, 2026-11-03): the extractor concatenates page footers
  // into the references zone, and a footer landing between two
  // markers is glued to the preceding entry. The footer carries the
  // HOST paper's DOI, and the verifier's extractDOI takes the first
  // DOI in the entry text — so the host DOI verified 5 unrelated
  // entries in each paper, and the journal stage named the host
  // journal off that artefact. Strip BEFORE the CrossRef/PubMed
  // trim: the footer follows "[ CrossRef ]", so the token is only
  // trailing once the footer is gone.
  e = stripMdpiFooter(e);
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
  // First-author surname of a parsed key ("smith, 2020" -> "smith";
  // "herawati et al., 2021" -> "herawati"). Local copy of the
  // matcher's rule, kept here so the parser stays decoupled.
  const firstAuthorOfKey = (key) => {
    let s = String(key).split(",")[0].trim().toLowerCase();
    s = s.replace(/\s+et al\.?$/, "");
    s = s.split(/\s+(?:&|and)\s+/)[0].trim();
    return s;
  };
  const IBID_WORDS = /^(?:ibid|ibidem|idem|eadem)$/;
  // Two author-year list styles, both line-based:
  //  - "Davis, 1989. Perceived usefulness..." (surname, year up front)
  //  - APA: "Serra, C. E. M., & Kunc, M. (2015). Benefits..." and
  //    "Shaw, J., Gray, C. S., ... & Wodchis, W. (2018). ..." where
  //    the year sits in parentheses lines AFTER the start line (long
  //    author lists wrap). The year is therefore read from the whole
  //    entry, not from the start line alone; entries without any
  //    year are dropped (footers, headers, fragments).
  //  - PeerJ (paper 313, 2026-11-03): "Abed R. 2022." and
  //    "Woolf D, Amonette J, ..., Joseph S. 2010." — surname +
  //    initial(s), NO comma after the first surname, year bare (no
  //    parens) after the final period. Without this pattern the
  //    whole true list parsed to ZERO entries, and the zone search
  //    fell back to a table column headed "References", yielding
  //    16 fake "entries" (table study rows) and 46 false missing.
  //    Two wraps occur: year on the next line ("... Gorzelak MA."
  //    / "2024.") and hyphen-wrapped author lists ("Sadiman-" /
  //    "tara GR, ... H. 2023.") — the latter is fixed by joining
  //    hyphen line-breaks first, the same normalisation the body
  //    scanner already applies.
  const lines = String(zone).replace(/-\n/g, "-").split(/\n/);
  const entries = []; // {text, key}
  let current = null;
  let currentSurname = null;
  let currentOpCit = false;
  const flush = () => {
    if (current) {
      if (currentOpCit) {
        // Op. cit. names no year of its own: it IS the author's
        // earlier work. Unique prior same-surname entry -> resolve
        // to that key (the duplicates check then flags the repeat
        // honestly); ambiguous or absent -> drop, never guess.
        const sName = (currentSurname || "").trim().toLowerCase();
        const cands = entries.filter((e) => firstAuthorOfKey(e.key) === sName);
        if (cands.length === 1) entries.push({ text: current, key: cands[0].key });
      } else {
        const parenYear = current.match(/\(((?:19|20)\d{2})\)/);
        const plainYear = current.match(/^[^,;]+,\s*((?:19|20)\d{2})\b/);
        // PeerJ year: the ". YYYY." after the author block. Scanned
        // (not anchored) so a year wrapped onto its own line
        // ("... Gorzelak MA. 2024.") is found too. Ordered last, so
        // it never overrides a paren or plain year.
        const peerjYear = current.match(/\.\s*((?:19|20)\d{2})\./);
        const year = parenYear ? parenYear[1] : (plainYear ? plainYear[1] : (peerjYear ? peerjYear[1] : null));
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
    }
    current = null;
    currentSurname = null;
    currentOpCit = false;
  };
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (/^(appendix|acknowledg|funding|author contributions|conflict)/i.test(line)) { flush(); break; }
    // Page-footer fragment: "Setyawan et al. (2026)," on its own
    // line, followed by journal / DOI / page lines. Appended to an
    // entry it hijacks flush's parenYear (paper 313: 7 entries
    // mis-year'd to 2026, the paper's own year). A real entry line
    // never ends exactly here — it carries title text after the
    // year — so skipping the bare footer line is safe.
    if (/^[A-Z][\p{L}\p{M}\x80-\xFF'’\-]+ et al\.\s*\((?:19|20)\d{2}\),?$/u.test(line)) continue;
    let stripped = line.replace(/^[-•*]\s+/, "").replace(/^\d{1,3}\.\s+/, "");
    const plain = stripped.match(/^([^,;]{1,80}?),\s*((?:19|20)\d{2})\b/);
    const apa = stripped.match(/^([^,;]{1,80}?),\s*(?:[A-Z]\.\s*)+/);
    // Organisation author: "World Bank. (2006). Title..." / "OECD. (2015). ..."
    // — no comma after the name, so neither pattern above fires.
    const org = stripped.match(/^([A-Z][\p{L}\p{M}\x80-\xFF'’\-]+(?:\s+[A-Z][\p{L}\p{M}\x80-\xFF'’\-]+)*)\.\s*\(((?:19|20)\d{2})\)/u);
    const orgSurname = org ? org[1] : null;
    // Ibid resolution: an entry starting with Ibid./Ibidem/Idem/
    // Eadem, a dash-repeat author ("——. (2021). ..."), or
    // "Surname, op. cit." is a NEW entry whose author is the
    // previous entry — previously such lines were glued onto the
    // previous entry's text, so the cited work falsely reported as
    // missing and the ibid work was invisible. These lines ALWAYS
    // start a new entry (they are never a wrapped author line).
    // Resolution target = the last successfully parsed entry; a
    // leading ibid with no previous entry keeps the literal "ibid"
    // surname: honestly unresolvable, reported as uncited.
    const ibidStart = stripped.match(/^(?:ibid\.?|ibidem|idem|eadem)\b/i);
    const dashStart = stripped.match(/^[—–―]+\s*(?:\.|\()/);
    const opcitStart = stripped.match(/^([^,;]{1,80}?),\s*(?:[A-Z]\.\s*)*op\.?\s*cit\.?/i);
    // PeerJ: "Abed R. 2022." / "Woolf D, Amonette J, ..., Joseph S.
    // 2010." — the first author MUST carry an initial, so a bare
    // journal line ("Mycorrhiza.") can never start an entry
    // mid-list. peerjNoYear is the same author list with the year
    // wrapped onto the next line; the year line is appended as an
    // ordinary continuation and read by flush's peerjYear.
    // peerjWrap is an author list wrapped across lines with neither
    // year nor trailing period ("Jabborova D, ..., Vikram" /
    // "KV, ... RZ. 2022."; "Sopandi TP, ..., Farid MAA," /
    // "Setyawan HY. 2025."): it starts the entry, the completing
    // line is appended, and flush reads the year from it. An entry
    // that never gains a year is dropped by flush as before.
    // Initials: 1-3 capitals (LMH, ZBZ, ARG), hyphenated (Z-H,
    // A-BF), accented capitals (Á). Surnames use a broad class so
    // extraction-mangled diacritics (Medy«ska, Popovi¢, \x82wiel¡g)
    // do not break the middle of an author list; the key uses the
    // first surname, which is clean in the observed data.
    const SUR = "[\\p{L}\\p{M}\\x80-\\xFF'’\\-]+";
    const INI = "[A-ZÀ-Þ]{1,3}(?:-[A-ZÀ-Þ]{1,3})?";
    const peerj = stripped.match(new RegExp(`^(${SUR})\\s+${INI}(?:,\\s*${SUR}(?:\\s+${INI})?)*\\.\\s*((?:19|20)\\d{2})\\.?`, "u"));
    const peerjNoYear = !peerj && stripped.match(new RegExp(`^(${SUR})\\s+${INI}(?:,\\s*${SUR}(?:\\s+${INI})?)*\\.$`, "u"));
    const peerjWrap = !peerj && !peerjNoYear && stripped.match(new RegExp(`^(${SUR})\\s+${INI}(?:,\\s*${SUR}(?:\\s+${INI})?)+(?:,\\s*${SUR})?,?$`, "u")); // requires a comma: bare "PLoS ONE" journal lines otherwise match "Surname Initial" (ONE as initial) and hijack the next entry (paper 335)
    // A surname+initial line is a NEW entry only when the current
    // entry already has its year. Otherwise it is still the author
    // list of the current entry wrapping onto a new line — the real
    // APA trap: "… Sheridan, N., &" then "Wodchis, W. (2018)." must
    // NOT split the Shaw entry into a yearless Shaw (dropped) plus
    // a spurious Wodchis entry.
    // The peerj check is bounded to the entry's first 600 chars
    // (the author block), so a year mentioned deep in a title
    // cannot fake a completed entry.
    const currentHasYear = current && (/\(((?:19|20)\d{2})\)/.test(current) || /^[^,;]+,\s*(?:19|20)\d{2}\b/.test(current) || /\.\s*(?:19|20)\d{2}\./.test(current.slice(0, 600)));
    if (ibidStart || dashStart) {
      flush();
      const prev = entries.length ? entries[entries.length - 1] : null;
      const prevSurname = prev ? firstAuthorOfKey(prev.key) : null;
      current = stripped;
      currentSurname = (prevSurname && !IBID_WORDS.test(prevSurname)) ? prevSurname : "Ibid";
      currentOpCit = false;
    } else if (opcitStart) {
      flush();
      current = stripped;
      currentSurname = opcitStart[1];
      currentOpCit = true;
    } else if ((plain || apa || org || peerj || peerjNoYear || peerjWrap) && (!current || currentHasYear)) {
      flush();
      current = stripped;
      currentSurname = plain ? plain[1] : (apa ? apa[1] : (org ? orgSurname : (peerj ? peerj[1] : (peerjNoYear ? peerjNoYear[1] : peerjWrap[1]))));
      currentOpCit = false;
    } else if (current) {
      // Continuation line of the previous entry (wrapped PDF line).
      if (!/^\d{1,3}\.\s*[A-Z]/.test(line)) current += " " + line;
    }
  }
  flush();
  if (entries.length < 2) return null;
  return { style: "author-year", entries: entries.map((e) => e.text), keys: entries.map((e) => e.key), count: entries.length };
}

// Footnote reference lists: documents with no References/Bibliography
// section at all, whose references live in footnotes at page bottoms.
// Why this is hard, and what is deliberately NOT done:
//  - Footnote numbers restart on every page, so they are NEVER keys:
//    footnote "1" on page 2 and footnote "1" on page 5 are different
//    works. Keys are author-year ("surname, year"), the same format
//    the section parser produces, so the matcher works unchanged.
//  - Body footnote markers are superscript numbers. They are NOT
//    citations into this list: without page boundaries in the
//    extracted text, a body marker cannot be mapped to its footnote
//    entry (page-local numbering). Matching therefore uses the body
//    author-year scan only, exactly like the author-year branch; the
//    superscript scan is ignored for footnote documents (see
//    index.mjs). A document cited ONLY by per-page footnote numbers
//    still gets its list parsed and database-verified, but its
//    missing/uncited counts come from author-year mentions only.
//  - Entries are SINGLE extracted lines. Wrapped footnotes are real,
//    but without page geometry a continuation line cannot be told
//    apart from body text, and consuming body lines would manufacture
//    false missing/uncited. So a wrapped footnote whose first line is
//    not itself a complete reference is skipped, not guessed.
//  - Entry lines are excised from the body: otherwise the author-year
//    scan would find "Smith, 2020" inside every footnote entry and
//    every footnote would look cited.
//  - Repeats are citations, not duplicates: the same work footnoted
//    twice keeps one list entry; the extra occurrences are counted
//    in footnote_repeats, never silently dropped, never flagged as
//    duplicate bibliography entries.
//  - "Ibid." lines are explicitly skipped: ibid resolution (previous
//    footnote's key) is a separate task and is never guessed here.
const FOOTNOTE_MARKER_RE = /^(?:\d{1,3}[.)]?\s+|[¹²³⁴⁵⁶⁷⁸⁹⁰]+\s*|[*†‡]\s+)/;

function stripFootnoteMarker(line) {
  return String(line).trim().replace(FOOTNOTE_MARKER_RE, "");
}

const plausibleFootnoteYear = (y) => Number(y) <= new Date().getFullYear() + 1;
const plausibleFootnoteSurname = (s) => {
  const t = (s || "").trim().toLowerCase();
  return /[a-zà-ÿ]/.test(t) && t !== "et al." && t !== "et al";
};

// Returns { key, text } or null. `text` is the marker-stripped line.
function footnoteEntryKey(rawLine) {
  const s = stripFootnoteMarker(rawLine);
  if (!s || /^ibid\.?/i.test(s)) return null;
  // APA: "Smith, J. (2020). Title..." (initials, then more authors,
  // then the year in parens and a period before the title).
  let m = s.match(/^([^,;]{1,80}?),\s*(?:[A-Z]\.\s*)+[^()]*\(((?:19|20)\d{2})\)\.\s+(\S.{9,})$/);
  if (m && plausibleFootnoteYear(m[2]) && plausibleFootnoteSurname(m[1])) return { key: `${m[1].trim().toLowerCase()}, ${m[2]}`, text: s };
  // Full first name: "Smith, John (2020). Title..." — the period
  // after the paren year is the discriminator (body prose reads
  // "Smith, John (2020) argues...", with no period).
  m = s.match(/^([^,;]{1,80}?),\s+[A-Z][A-Za-zÀ-ÿ'’\-]+\s+\(((?:19|20)\d{2})\)\.\s+(\S.{9,})$/);
  if (m && plausibleFootnoteYear(m[2]) && plausibleFootnoteSurname(m[1])) return { key: `${m[1].trim().toLowerCase()}, ${m[2]}`, text: s };
  // Plain: "Davis, 1989. Perceived usefulness..." — the PERIOD after
  // the year is the discriminator: body sentences read "Davis, 1989,
  // argues...", with a comma, and must never match.
  m = s.match(/^([^,;]{1,80}?),\s*((?:19|20)\d{2})\.\s+(\S.{19,})$/);
  if (m && plausibleFootnoteYear(m[2]) && plausibleFootnoteSurname(m[1])) return { key: `${m[1].trim().toLowerCase()}, ${m[2]}`, text: s };
  // Organisation: "World Bank. (2019). Development report..."
  m = s.match(/^([A-Z][A-Za-zÀ-ÿ'’\-]+(?:\s+[A-Z][A-Za-zÀ-ÿ'’\-]+)*)\.\s*\(((?:19|20)\d{2})\)\.\s+(\S.{9,})$/);
  if (m && plausibleFootnoteYear(m[2])) return { key: `${m[1].trim().toLowerCase()}, ${m[2]}`, text: s };
  // Chicago note: "John Smith, The Wealth of Things (New York: Norton, 2020)."
  // Author is first-name-first; the surname is its last word. The
  // publisher paren must be the last group on the line (only an
  // optional page ref and period may follow), which is what keeps
  // body sentences from matching.
  m = s.match(/^([A-Z][A-Za-zÀ-ÿ'’\-]+(?:\s+[A-Z][A-Za-zÀ-ÿ'’\-]+)+),\s+([^()]{15,}?)\s*\((?:[^()]*,\s*)?((?:19|20)\d{2})\)\s*(?:,\s*\d+(?:[–\-]\d+)?)?\.?\s*$/);
  if (m && plausibleFootnoteYear(m[3])) {
    const words = m[1].trim().split(/\s+/);
    const surname = words[words.length - 1];
    if (plausibleFootnoteSurname(surname)) return { key: `${surname.toLowerCase()}, ${m[3]}`, text: s };
  }
  return null;
}

export function parseFootnoteEntries(text) {
  const lines = stripMarkerChars(text).split("\n");
  const entries = [];
  const keys = [];
  const seen = new Set();
  const entryLines = new Set();
  let repeats = 0;
  for (let i = 0; i < lines.length; i++) {
    const hit = footnoteEntryKey(lines[i]);
    if (!hit) continue;
    entryLines.add(i);
    if (seen.has(hit.key)) { repeats++; continue; }
    seen.add(hit.key);
    entries.push(hit.text);
    keys.push(hit.key);
  }
  if (entries.length < 2) return null;
  const body = lines.filter((_, i) => !entryLines.has(i)).join("\n");
  return { style: "footnote", entries, keys, count: entries.length, body, footnote_repeats: repeats };
}

export function splitReferenceZone(text) {
  const plain = stripMarkerChars(text);
  const headings = [...plain.matchAll(REFERENCE_HEADING_RE)];
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
  if (split.found) return { status: "parsed", style: split.style, entries: split.entries, keys: split.keys, count: split.entries.length, body: split.body, note: null };
  // No tail section: fall back to footnote entries. A tail section
  // always wins when one exists, so footnotes never override a
  // bibliography.
  const fn = parseFootnoteEntries(text);
  if (fn) return { status: "parsed", style: fn.style, entries: fn.entries, keys: fn.keys, count: fn.count, body: fn.body, footnote_repeats: fn.footnote_repeats, note: null };
  return { status: "no_references", style: null, entries: [], keys: [], count: 0, body: split.body, note: "No reference list was found in the document. Citation checking was skipped; this dimension is not scored." };
}

export function scanAuthorYearCitations(bodyText) {
  // Tables and captions (task 5): citations inside them are scanned
  // with the SAME patterns as prose — the extractor joins every PDF
  // run with a newline, and every pattern above spans newlines, so a
  // citation in a cell or a caption is found exactly like one in
  // prose. Counts are order-independent: the matcher compares SETS,
  // so row-wise vs column-first stream order (and caption placement)
  // cannot change missing/uncited, and a citation repeated in prose,
  // table and caption is deduped to one key (no double count).
  // Narrow cells wrap mid-phrase, so two wrap shapes are tolerated
  // that prose rarely needs: "et" and "al." split across a line
  // break ("Davis et\n al., 1989") and the year wrapping to the next
  // line inside parens ("Davis et al. (\n2020)"). Both are plain
  // whitespace tolerance — no new citation form is invented.
  // Honest limits, deliberately NOT worked around (guessing would
  // misattribute): (1) content AFTER the References heading
  // (appendix/supplementary tables) is outside the body zone and is
  // not scanned — the zone itself must never be scanned or every
  // listed reference would look cited; (2) a bracket group in a
  // numeric-style paper IS a citation by that paper's own convention,
  // so a table data range like "[12-15]" cannot be told apart from
  // a citation range — far-beyond-list numbers are flagged
  // list_truncated by the matcher stage, never proven missing;
  // (3) a year glued to the next cell with no separator at all
  // ("1989Smith") is not matched: the trailing word boundary is
  // kept so year-suffix variants ("1989a") are never misattributed
  // to a different same-author same-year entry; (4) a table
  // footnote digit with Ts rise is visually identical to a
  // superscript citation and cannot be told apart without layout
  // analysis, which the flat extracted text does not carry.
  // PDF extraction wraps lines and mangles ligatures inside citations:
  // "Fadiji et al.\n,\n2024" (comma wrapped to the next line) and
  // "Abdellaoui et\x1fal., 2020" (the et-al. ligature surfacing as a
  // control character) are both real citations the old regexes missed
  // entirely: on the 20-paper test this dropped Psychology detection
  // from 92 real citations to 0 and Education from 117 to 6.
  // Normalise before scanning: control characters (ligature artefacts)
  // become spaces, and a hyphen at a line break joins the word back.
  // Newlines themselves are kept: \s in the patterns already spans them.
  // "et al." split across a line break ("Sousa et\n al., 2024")
  // is rejoined first, or the citation is missed entirely.
  const text = String(bodyText)
    .replace(/\bet[ \t]*\r?\n[ \t]*al\.?/g, "et al")
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
  // Second-author guard, combined (tables + inv313): a surname that
  // directly follows "&" or "and" is NOT its own citation — unless
  // what precedes the &/and already ends with a closed citation
  // year ("Venkatesh, 2003 and Davis, 1989", "Solaiman et al.
  // (2010) and Hammer et al. (2015)"), in which case the next
  // surname starts its own citation. Trailing parens are stripped
  // first ("(Asadabadi, ... (2021)) and" leaves a doubled stem),
  // then trailing punctuation, then the year-end checks.
  const isSecondAuthor = (idx) => {
    const before = text.slice(0, idx).trimEnd();
    const mAnd = before.match(/(?:^|[\s])(&|and)$/);
    if (!mAnd) return false;
    const beforeAnd = before.slice(0, mAnd.index).trimEnd();
    const stem = beforeAnd.replace(/\)+$/, "").replace(/[,;:]+$/, "").trimEnd();
    if (/\((?:19|20)\d{2}$/.test(stem)) return false;
    if (/,\s*(?:19|20)\d{2}$/.test(stem)) return false;
    if (/(?:19|20)\d{2}$/.test(stem)) return false;
    return true;
  };
  // A match starting right after "-" or an apostrophe is the tail
  // of a hyphenated surname ("Cwielag-Piasecka" yielding a false
  // "piasecka, 2022"), not its own citation.
  const startsMidToken = (str, idx) => /[-'’]$/.test(str.slice(0, idx));
  // A surname preceded by "Surname, " is the MIDDLE of a longer
  // author list, not its own citation: in "Meng, Cheng & Li,
  // 2024" the pair rule below would otherwise emit a false
  // "cheng, 2024" while the true first author (Meng) is missed.
  const precededBySurnameComma = (str, idx) => {
    const mm = str.slice(0, idx).trimEnd().match(/([A-Z][\p{L}\p{M}\x80-\xFF'’\-]+),\s*$/u);
    if (!mm) return false;
    // 429 wart: "Interestingly, " is an adverb, not "Surname, " — it must
    // not block the true citation that follows ("Tan and Tan (2000)").
    return !isSentenceAdverb(mm[1]);
  };
  // Page-footer citation: the paper's own footer ("Setyawan et
  // al. (2026), PeerJ, DOI 10.7717/... 16/22") repeats on every
  // page; scanned as a citation it becomes a false "missing" for
  // the paper itself. A match immediately followed (within 80
  // chars) by ", Journal, DOI 10." is footer material, not prose.
  const isFooterCite = (str, end) => /^\s*,?\s*[A-Z][A-Za-z .&'’\-]{0,40}?,?\s*DOI\s+10\./.test(str.slice(end, end + 80).replace(/\s+/g, " "));
  const re1 = /\b([A-Z][\p{L}\p{M}\x80-\xFF'’\-]+)(?:\s+et\s+al\.?)?\s*,\s*((?:19|20)\d{2})\b/gu;
  let m;
  while ((m = re1.exec(text)) !== null) { if (!isSecondAuthor(m.index) && !startsMidToken(text, m.index) && !isFooterCite(text, m.index + m[0].length) && !isSentenceAdverb(m[1])) push(m[1], m[2]); }
  const re2 = /\b([A-Z][\p{L}\p{M}\x80-\xFF'’\-]+)(?:\s+et\s+al\.?)?\s*\(\s*((?:19|20)\d{2})\s*\)/gu;
  while ((m = re2.exec(text)) !== null) { if (!isSecondAuthor(m.index) && !startsMidToken(text, m.index) && !isFooterCite(text, m.index + m[0].length) && !isSentenceAdverb(m[1])) push(m[1], m[2]); }
  // APA two-author citations: only the FIRST author keys the entry,
  // so "(Serra & Kunc, 2015)" and "Serra and Kunc (2015)" must yield
  // "serra, 2015", not "kunc, 2015" (which would false-flag both ways).
  const re3 = /\b([A-Z][\p{L}\p{M}\x80-\xFF'’\-]+)\s+(?:&|and)\s+[A-Z][\p{L}\p{M}\x80-\xFF'’\-]+\s*,\s*((?:19|20)\d{2})\b/gu;
  while ((m = re3.exec(bodyText)) !== null) { if (!isSecondAuthor(m.index) && !startsMidToken(bodyText, m.index) && !precededBySurnameComma(bodyText, m.index) && !isFooterCite(bodyText, m.index + m[0].length) && !isSentenceAdverb(m[1])) push(m[1], m[2]); }
  const re4 = /\b([A-Z][\p{L}\p{M}\x80-\xFF'’\-]+)\s+(?:&|and)\s+[A-Z][\p{L}\p{M}\x80-\xFF'’\-]+\s*\(\s*((?:19|20)\d{2})\s*\)/gu;
  while ((m = re4.exec(bodyText)) !== null) { if (!isSecondAuthor(m.index) && !startsMidToken(bodyText, m.index) && !precededBySurnameComma(bodyText, m.index) && !isFooterCite(bodyText, m.index + m[0].length) && !isSentenceAdverb(m[1])) push(m[1], m[2]); }
  // Three-author citations: "Meng, Cheng & Li, 2024" and
  // "Asadabadi, Hage-Ahmed & Steinkellner (2021)" must yield the
  // FIRST author only ("meng, 2024", "asadabadi, 2021"). The
  // middle-author guard also applies here, so a 4-author list
  // ("A, B, C & D, year") yields no key rather than a wrong one.
  const re5 = /\b([A-Z][\p{L}\p{M}\x80-\xFF'’\-]+),\s+[A-Z][\p{L}\p{M}\x80-\xFF'’\-]+\s+(?:&|and)\s+[A-Z][\p{L}\p{M}\x80-\xFF'’\-]+\s*,\s*((?:19|20)\d{2})\b/gu;
  while ((m = re5.exec(bodyText)) !== null) { if (!startsMidToken(bodyText, m.index) && !precededBySurnameComma(bodyText, m.index) && !isFooterCite(bodyText, m.index + m[0].length) && !isSentenceAdverb(m[1])) push(m[1], m[2]); }
  const re6 = /\b([A-Z][\p{L}\p{M}\x80-\xFF'’\-]+),\s+[A-Z][\p{L}\p{M}\x80-\xFF'’\-]+\s+(?:&|and)\s+[A-Z][\p{L}\p{M}\x80-\xFF'’\-]+\s*\(((?:19|20)\d{2})\)/gu;
  while ((m = re6.exec(bodyText)) !== null) { if (!startsMidToken(bodyText, m.index) && !precededBySurnameComma(bodyText, m.index) && !isFooterCite(bodyText, m.index + m[0].length) && !isSentenceAdverb(m[1])) push(m[1], m[2]); }
  // Op. cit. body citations: "Smith, op. cit." cites Smith's earlier
  // work, but carries no year, so the year-based patterns above miss
  // it entirely and the listed work falsely reports as uncited. Emit
  // a marker key ("smith, op. cit."); matchAuthorYearKeys resolves
  // it against the list (unique same-surname entry only). Body
  // "Ibid." needs no marker: it always refers to the immediately
  // preceding citation, which the patterns above already emitted,
  // so it cannot change the missing/uncited sets.
  const pushMarker = (surname) => {
    const key = `${surname.trim().toLowerCase()}, op. cit.`;
    if (!seen.has(key)) { seen.add(key); out.push(key); }
  };
  const reOp = /\b([A-Z][A-Za-zÀ-ÿ'’\-]+)(?:\s+et al\.?)?\s*,?\s*[Oo]p\.?\s*[Cc]it\.?/g;
  while ((m = reOp.exec(text)) !== null) { if (!isSecondAuthor(m.index)) pushMarker(m[1]); }
  const reOp2 = /\b([A-Z][A-Za-zÀ-ÿ'’\-]+)\s+(?:&|and)\s+[A-Z][A-Za-zÀ-ÿ'’\-]+\s*,?\s*[Oo]p\.?\s*[Cc]it\.?/g;
  while ((m = reOp2.exec(text)) !== null) pushMarker(m[1]);
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
  // "et al." split across a line break ("Sousa et\n al., 2024")
  // is rejoined first, or the citation is missed entirely.
  const text = String(bodyText)
    .replace(/\bet[ \t]*\r?\n[ \t]*al\.?/g, "et al")
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
  // Second-author guard, combined (tables + inv313): a surname that
  // directly follows "&" or "and" is NOT its own citation — unless
  // what precedes the &/and already ends with a closed citation
  // year ("Venkatesh, 2003 and Davis, 1989", "Solaiman et al.
  // (2010) and Hammer et al. (2015)"), in which case the next
  // surname starts its own citation. Trailing parens are stripped
  // first ("(Asadabadi, ... (2021)) and" leaves a doubled stem),
  // then trailing punctuation, then the year-end checks.
  const isSecondAuthor = (idx) => {
    const before = text.slice(0, idx).trimEnd();
    const mAnd = before.match(/(?:^|[\s])(&|and)$/);
    if (!mAnd) return false;
    const beforeAnd = before.slice(0, mAnd.index).trimEnd();
    const stem = beforeAnd.replace(/\)+$/, "").replace(/[,;:]+$/, "").trimEnd();
    if (/\((?:19|20)\d{2}$/.test(stem)) return false;
    if (/,\s*(?:19|20)\d{2}$/.test(stem)) return false;
    if (/(?:19|20)\d{2}$/.test(stem)) return false;
    return true;
  };
  const startsMidToken = (idx) => /[-'’]$/.test(text.slice(0, idx));
  // Same guards as scanAuthorYearCitations, so the keys here match
  // that scan exactly: middle-author suppression for 3-author
  // lists, and page-footer citations (", Journal, DOI 10.") skipped.
  const precededBySurnameComma = (idx) => {
    const mm = text.slice(0, idx).trimEnd().match(/([A-Z][\p{L}\p{M}\x80-\xFF'’\-]+),\s*$/u);
    if (!mm) return false;
    return !isSentenceAdverb(mm[1]);
  };
  const isFooterCite = (end) => /^\s*,?\s*[A-Z][A-Za-z .&'’\-]{0,40}?,?\s*DOI\s+10\./.test(text.slice(end, end + 80).replace(/\s+/g, " "));
  let m;
  const re1 = /\b([A-Z][\p{L}\p{M}\x80-\xFF'’\-]+)(?:\s+et\s+al\.?)?\s*,\s*((?:19|20)\d{2})\b/gu;
  while ((m = re1.exec(text)) !== null) { if (!isSecondAuthor(m.index) && !startsMidToken(m.index) && !isFooterCite(m.index + m[0].length) && !isSentenceAdverb(m[1])) push(m[1], m[2], m.index, m[0].length); }
  const re2 = /\b([A-Z][\p{L}\p{M}\x80-\xFF'’\-]+)(?:\s+et\s+al\.?)?\s*\(\s*((?:19|20)\d{2})\s*\)/gu;
  while ((m = re2.exec(text)) !== null) { if (!isSecondAuthor(m.index) && !startsMidToken(m.index) && !isFooterCite(m.index + m[0].length) && !isSentenceAdverb(m[1])) push(m[1], m[2], m.index, m[0].length); }
  const re3 = /\b([A-Z][\p{L}\p{M}\x80-\xFF'’\-]+)\s+(?:&|and)\s+[A-Z][\p{L}\p{M}\x80-\xFF'’\-]+\s*,\s*((?:19|20)\d{2})\b/gu;
  while ((m = re3.exec(text)) !== null) { if (!isSecondAuthor(m.index) && !startsMidToken(m.index) && !precededBySurnameComma(m.index) && !isFooterCite(m.index + m[0].length) && !isSentenceAdverb(m[1])) push(m[1], m[2], m.index, m[0].length); }
  const re4 = /\b([A-Z][\p{L}\p{M}\x80-\xFF'’\-]+)\s+(?:&|and)\s+[A-Z][\p{L}\p{M}\x80-\xFF'’\-]+\s*\(\s*((?:19|20)\d{2})\s*\)/gu;
  while ((m = re4.exec(text)) !== null) { if (!isSecondAuthor(m.index) && !startsMidToken(m.index) && !precededBySurnameComma(m.index) && !isFooterCite(m.index + m[0].length) && !isSentenceAdverb(m[1])) push(m[1], m[2], m.index, m[0].length); }
  const re5 = /\b([A-Z][\p{L}\p{M}\x80-\xFF'’\-]+),\s+[A-Z][\p{L}\p{M}\x80-\xFF'’\-]+\s+(?:&|and)\s+[A-Z][\p{L}\p{M}\x80-\xFF'’\-]+\s*,\s*((?:19|20)\d{2})\b/gu;
  while ((m = re5.exec(text)) !== null) { if (!startsMidToken(m.index) && !precededBySurnameComma(m.index) && !isFooterCite(m.index + m[0].length) && !isSentenceAdverb(m[1])) push(m[1], m[2], m.index, m[0].length); }
  const re6 = /\b([A-Z][\p{L}\p{M}\x80-\xFF'’\-]+),\s+[A-Z][\p{L}\p{M}\x80-\xFF'’\-]+\s+(?:&|and)\s+[A-Z][\p{L}\p{M}\x80-\xFF'’\-]+\s*\(((?:19|20)\d{2})\)/gu;
  while ((m = re6.exec(text)) !== null) { if (!startsMidToken(m.index) && !precededBySurnameComma(m.index) && !isFooterCite(m.index + m[0].length) && !isSentenceAdverb(m[1])) push(m[1], m[2], m.index, m[0].length); }
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
  const headings = [...markedText.matchAll(REFERENCE_HEADING_RE)];
  if (headings.length === 0) return markedText;
  return markedText.slice(0, headings[headings.length - 1].index);
}
