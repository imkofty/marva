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
  const m = String(ref).trim().match(/^([^,;]+),\s*(\d{4})\b/);
  if (m) return `${m[1].trim().toLowerCase()}, ${m[2]}`;
  return normalizeKey(ref);
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
