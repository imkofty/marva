// Deterministic citation matcher — no model, no guessing.
// Copied verbatim in logic from backend/src/lib/citation-matcher.mjs.
// Matching is exact after normalising case and whitespace only; fuzzy
// matching is deliberately NOT done, because a near-match presented as
// a match would be a fabricated verification.
export function normalizeKey(key) {
  return String(key).trim().toLowerCase().replace(/\s+/g, " ");
}

// Deterministic author-year key for a reference-list entry. Reader
// returns full reference strings ("Davis, 1989. Perceived usefulness..."),
// while in-text citations are keys ("Davis, 1989"). Matching full strings
// against keys would falsely report every citation as missing, so the
// matcher compares keys: surname + year extracted by regex, never by
// fuzzy similarity. If no author-year pattern is found, the normalized
// full string is the key, so nothing is silently dropped.
export function extractReferenceKey(ref) {
  // Strip a leading list marker ("- ", "12. ") before the surname.
  const cleaned = String(ref).trim().replace(/^[-•*]\s+/, "").replace(/^\d{1,3}\.\s+/, "");
  const m = cleaned.match(/^([^,;]+),\s*(\d{4})\b/);
  if (m) return `${m[1].trim().toLowerCase()}, ${m[2]}`;
  return normalizeKey(cleaned);
}

// Author-year matching with one deterministic variant rule, on top of
// exact matching: a cited surname that equals the LAST word of a
// listed surname (same year) counts as that entry. This covers the
// paper's own variants — text cites "Souza" for listed "De Souza",
// "Costa" for listed "Da Silva Costa", "Bank" for listed
// "World Bank" — without fuzzy similarity: the year must match, and
// if two listed entries share the same last word + year, the cited
// key stays unmatched (ambiguous, flagged for the author, never
// silently assigned to one of them).
// A listed entry's matching surname is its FIRST author only: the parser
// keeps the full author string as the key ("herawati et al., 2021",
// "li & cai, 2021"), while body citations are keyed by first author
// ("herawati, 2021", "li, 2021"). Without this reduction the 20-paper
// test's Agriculture paper reported 50 missing from only 17 references.
// The last-word fallback below still covers "De Souza" cited as "Souza"
// and "World Bank" cited as "Bank". Displayed missing/uncited lists
// always use the ORIGINAL keys, never the reduced ones.
const matchSurname = (key) => {
  let s = key.split(",")[0].trim().toLowerCase();
  s = s.replace(/\s+et al\.?$/, "");
  s = s.split(/\s+(?:&|and)\s+/)[0].trim();
  return s;
};

// Ibid / op. cit. resolution for reference-list keys (list-level only —
// a single key carries no "previous entry", so extractReferenceKey
// cannot resolve on its own). Deterministic anaphora resolution, NOT
// fuzzy matching: only literal ibid/idem tokens and op. cit. markers
// are rewritten, and only to an entry already present in the list.
//  - "ibid, 2021" after "smith, 2020" IS "smith, 2021" (chains work:
//    each resolved entry's surname carries forward).
//  - "smith, op. cit." with exactly one prior same-surname entry IS
//    that entry's key (the repeat is then honestly flagged by the
//    duplicates check); ambiguous or absent -> left as-is, so it
//    reports as uncited/missing rather than silently assigned.
//  - Unresolvable leading ibid ("ibid, 2021" with no previous entry)
//    stays literal: honestly unresolvable, never guessed.
// Idempotent: already-resolved keys pass through unchanged, so
// applying this inside the matchers is safe even when the parser
// already resolved (text mode) or when keys came from
// extractReferenceKey (provided-references mode).
const IBID_SURNAMES = new Set(["ibid", "ibidem", "idem", "eadem"]);
const OPCIT_LIST_KEY_RE = /^([^,]+),\s*(?:[a-z]\.\s*)*op\.?\s*cit\.?$/;
export function resolveIbidKeys(keys) {
  const out = [];
  let prevSurname = null;
  for (const raw of keys) {
    const key = normalizeKey(raw);
    const comma = key.indexOf(",");
    const surname = (comma === -1 ? key : key.slice(0, comma)).trim();
    const rest = comma === -1 ? "" : key.slice(comma + 1).trim();
    if (IBID_SURNAMES.has(surname) && /^(?:19|20)\d{2}$/.test(rest)) {
      // "ibid" is not a surname: prevSurname only advances on real
      // entries, so an unresolvable leading ibid leaves the chain
      // anchored at the last real entry, not at "ibid".
      out.push(prevSurname ? `${prevSurname}, ${rest}` : key);
      continue;
    }
    if (OPCIT_LIST_KEY_RE.test(key)) {
      const cands = out.filter((l) => matchSurname(l) === surname);
      out.push(cands.length === 1 ? cands[0] : key);
      prevSurname = surname;
      continue;
    }
    out.push(key);
    prevSurname = matchSurname(key);
  }
  return out;
}

export function matchAuthorYearKeys(inText, referenceList) {
  const cited = inText.map(normalizeKey);
  // Resolved list keys: see resolveIbidKeys. Displayed missing/
  // uncited lists use these resolved identities (the referent, not
  // the anaphor) — that is the point: "ibid, 2021" must not appear
  // as an unknown citation when it IS "smith, 2021".
  const listed = resolveIbidKeys(referenceList.map(normalizeKey));
  const yearOf = (key) => (key.split(",")[1] || "").trim();
  const matchKey = (key) => `${matchSurname(key)}, ${yearOf(key)}`;
  const lastWord = (surname) => {
    const words = surname.split(/\s+/);
    return words[words.length - 1];
  };
  const matchedListed = new Set();
  const missing = [];
  const ambiguous = [];
  // Body "op. cit." markers (emitted by scanAuthorYearCitations as
  // "surname, op. cit.") resolve here, after full citations have
  // claimed their entries: a marker naming a work already claimed by
  // a full citation is satisfied (op. cit. = the most recently cited
  // same-author work); a marker with exactly one unclaimed
  // same-surname entry claims it; anything else stays flagged.
  const opcitCitedRe = /^(.+),\s*op\.?\s*cit\.?$/;
  const normal = [];
  const markers = [];
  for (const c of new Set(cited)) (opcitCitedRe.test(c) ? markers : normal).push(c);
  for (const c of normal) {
    const cm = matchKey(c);
    const exact = listed.filter((l) => !matchedListed.has(l) && matchKey(l) === cm);
    if (exact.length === 1) { matchedListed.add(exact[0]); continue; }
    if (exact.length > 1) {
      // Identical keys = the same work listed twice (e.g. an op. cit.
      // entry resolved to its full entry): there is no which-question,
      // so claim one — the duplicates check still flags the repeat.
      // Distinct keys sharing a matchKey stay ambiguous, never assigned.
      if (new Set(exact).size === 1) { matchedListed.add(exact[0]); continue; }
      missing.push(c); ambiguous.push({ cited: c, candidates: exact }); continue;
    }
    const cands = listed.filter((l) => !matchedListed.has(l) && yearOf(l) === yearOf(c) && lastWord(matchSurname(l)) === lastWord(matchSurname(c)) && matchSurname(l) !== matchSurname(c));
    if (cands.length === 1) matchedListed.add(cands[0]);
    else {
      missing.push(c);
      if (cands.length > 1) ambiguous.push({ cited: c, candidates: cands });
    }
  }
  for (const mk of markers) {
    const surname = matchSurname(mk);
    const sameSurname = listed.filter((l) => matchSurname(l) === surname);
    const unclaimed = sameSurname.filter((l) => !matchedListed.has(l));
    if (sameSurname.length === 0) { missing.push(mk); continue; }
    if (sameSurname.some((l) => matchedListed.has(l))) continue; // satisfied by a full citation
    if (unclaimed.length === 1) { matchedListed.add(unclaimed[0]); continue; }
    missing.push(mk);
    ambiguous.push({ cited: mk, candidates: unclaimed });
  }
  const uncited = listed.filter((l) => !matchedListed.has(l));
  const seen = new Set();
  const duplicates = [];
  for (const l of listed) {
    if (seen.has(l) && !duplicates.includes(l)) duplicates.push(l);
    seen.add(l);
  }
  return { missing: [...new Set(missing)], uncited: [...new Set(uncited)], duplicates, ambiguous };
}

export function matchCitations(inText, referenceList) {
  const cited = inText.map(normalizeKey);
  // Same list-side ibid resolution as the author-year matcher, so
  // provided-references mode benefits too. No-op for numeric keys.
  const listed = resolveIbidKeys(referenceList.map(normalizeKey));
  const listedSet = new Set(listed);
  const citedSet = new Set(cited);
  const missing = [...new Set(cited.filter((c) => !listedSet.has(c)))];
  const uncited = [...new Set(listed.filter((l) => !citedSet.has(l)))];
  const seen = new Set();
  const duplicates = [];
  for (const l of listed) {
    if (seen.has(l) && !duplicates.includes(l)) duplicates.push(l);
    seen.add(l);
  }
  return { missing, uncited, duplicates };
}
