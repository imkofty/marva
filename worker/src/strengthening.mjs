// Strengthening-reference search.
// Real search calls only: OpenAlex (and Crossref by DOI when a DOI is
// known). Every candidate is verified by DOI/title/authors/year/journal
// BEFORE it is shown as a recommendation. A candidate whose database
// check returns "unresolved" is dropped from the recommendations and
// counted in dropped_unresolved, never presented as certain.
// Verification labels: "verified" (Crossref DOI match only) or
// "candidate" (OpenAlex title match, not yet DOI-verified). There is no
// other label, and no recommendation is ever labelled verified without
// a database match.
import { checkByDOI, checkByTitle } from "./database.mjs";

export function parseReferenceTitle(ref) {
  const m = String(ref).match(/,\s*\d{4}\.\s*(.+?)(?:\.\s+[A-Z][^.]*)?\.?\s*$/);
  if (m) return m[1].trim();
  return String(ref).trim();
}

export function extractDOI(ref) {
  const m = String(ref).match(/10\.\d{4,9}\/[-._;()/:A-Z0-9]+/i);
  return m ? m[0] : null;
}

// Verify one manuscript reference against the databases.
// Returns {reference, status, db} where status is verified/candidate/
// unresolved. "candidate" is NOT verified.
export async function verifyReference(ref, fetchImpl = fetch) {
  const doi = extractDOI(ref);
  if (doi) {
    const db = await checkByDOI(doi, fetchImpl);
    return { reference: ref, status: db.status, db };
  }
  const db = await checkByTitle(parseReferenceTitle(ref), fetchImpl);
  return { reference: ref, status: db.status, db };
}

// Search for strengthening references for up to 2 query terms.
// Each query hits OpenAlex (per-page 3), then each returned work is
// re-verified: DOI works go through Crossref, others through OpenAlex
// title lookup. Unresolved candidates are dropped, not recommended.
export async function searchStrengthening(queryTerms, fetchImpl = fetch) {
  const terms = (queryTerms || []).filter(Boolean).slice(0, 2);
  const recommendations = [];
  let dropped_unresolved = 0;
  let searched = 0;
  for (const term of terms) {
    searched += 1;
    let works = [];
    try {
      const res = await fetchImpl(`https://api.openalex.org/works?search=${encodeURIComponent(term)}&per-page=3`, { headers: { Accept: "application/json" }, signal: typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(15000) : undefined });
      if (res.ok) {
        const data = await res.json();
        works = data.results || [];
      }
    } catch { works = []; }
    for (const w of works) {
      const doi = w.doi ? w.doi.replace(/^https:\/\/doi\.org\//, "") : null;
      const db = doi ? await checkByDOI(doi, fetchImpl) : await checkByTitle(w.title || "", fetchImpl);
      if (db.status === "unresolved") { dropped_unresolved += 1; continue; }
      recommendations.push({
        query: term,
        title: db.title || w.title || null,
        authors: db.authors || (w.authorships || []).map((a) => a.author?.display_name).filter(Boolean),
        year: db.year ?? w.publication_year ?? null,
        journal: db.journal || w.primary_location?.source?.display_name || null,
        doi: doi || w.doi || null,
        verification: db.status, // "verified" or "candidate" only
      });
    }
  }
  return { searched_terms: terms, recommendations, dropped_unresolved };
}
