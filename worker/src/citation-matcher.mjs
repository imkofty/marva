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

export function matchAuthorYearKeys(inText, referenceList) {
  const cited = inText.map(normalizeKey);
  const listed = referenceList.map(normalizeKey);
  const yearOf = (key) => (key.split(",")[1] || "").trim();
  const matchKey = (key) => `${matchSurname(key)}, ${yearOf(key)}`;
  const lastWord = (surname) => {
    const words = surname.split(/\s+/);
    return words[words.length - 1];
  };
  const matchedListed = new Set();
  const missing = [];
  const ambiguous = [];
  for (const c of new Set(cited)) {
    const cm = matchKey(c);
    const exact = listed.filter((l) => !matchedListed.has(l) && matchKey(l) === cm);
    if (exact.length === 1) { matchedListed.add(exact[0]); continue; }
    if (exact.length > 1) { missing.push(c); ambiguous.push({ cited: c, candidates: exact }); continue; }
    const cands = listed.filter((l) => !matchedListed.has(l) && yearOf(l) === yearOf(c) && lastWord(matchSurname(l)) === lastWord(matchSurname(c)) && matchSurname(l) !== matchSurname(c));
    if (cands.length === 1) matchedListed.add(cands[0]);
    else {
      missing.push(c);
      if (cands.length > 1) ambiguous.push({ cited: c, candidates: cands });
    }
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
  const listed = referenceList.map(normalizeKey);
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
