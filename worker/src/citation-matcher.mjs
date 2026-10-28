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
export function matchAuthorYearKeys(inText, referenceList) {
  const cited = inText.map(normalizeKey);
  const listed = referenceList.map(normalizeKey);
  const listedSet = new Set(listed);
  const citedSet = new Set(cited);
  const lastWord = (key) => {
    const surname = key.split(",")[0].trim();
    const words = surname.split(/\s+/);
    return words[words.length - 1];
  };
  const yearOf = (key) => (key.split(",")[1] || "").trim();
  const matchedListed = new Set();
  const missing = [];
  for (const c of new Set(cited)) {
    if (listedSet.has(c)) { matchedListed.add(c); continue; }
    const cands = listed.filter((l) => !matchedListed.has(l) && yearOf(l) === yearOf(c) && lastWord(l) === lastWord(c));
    if (cands.length === 1) matchedListed.add(cands[0]);
    else missing.push(c);
  }
  const uncited = listed.filter((l) => !matchedListed.has(l));
  const seen = new Set();
  const duplicates = [];
  for (const l of listed) {
    if (seen.has(l) && !duplicates.includes(l)) duplicates.push(l);
    seen.add(l);
  }
  return { missing: [...new Set(missing)], uncited: [...new Set(uncited)], duplicates };
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
