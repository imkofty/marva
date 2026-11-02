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
// title lookup.
//
// Honesty rules (P6 fix, 2026-11-02 — the "0 in every job" finding):
// 1. WHITELIST, not blacklist: a candidate is shown ONLY when its
//    re-verification status is exactly "verified" or "candidate".
//    Every other status — "unresolved", "inconclusive" (including a
//    429-hit re-verification), anything unknown — is dropped and
//    counted separately. The old code dropped only "unresolved", so
//    an inconclusive candidate could slip through unlabelled.
// 2. SEARCH STATUS IS RECORDED, never silent: a failed search
//    (including 429) used to collapse into works=[] with no trace,
//    making "quota exhausted" indistinguishable from "no literature".
//    Each term now reports search_status (ok | empty | rate_limited
//    | error), its HTTP status, raw result count, and kept/dropped
//    counts, so a zero in the report carries its reason with it.
// Query shortening, per-page, and term-count changes are DELIBERATELY
// NOT done here (deferred post-submission per the deadline plan):
// query_used is the full theory name for now, so any future query
// experiment can be compared term-by-term against these diagnostics.
export async function searchStrengthening(queryTerms, fetchImpl = fetch) {
  const allTerms = (queryTerms || []).filter(Boolean);
  const terms = allTerms.slice(0, 2);
  const recommendations = [];
  let dropped_unresolved = 0;
  let dropped_inconclusive = 0;
  const per_term = [];
  for (const term of terms) {
    let search_status = "error";
    let http_status = null;
    let works = [];
    try {
      const res = await fetchImpl(`https://api.openalex.org/works?search=${encodeURIComponent(term)}&per-page=3`, { headers: { Accept: "application/json" }, signal: typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(15000) : undefined });
      http_status = res.status;
      if (res.ok) {
        const data = await res.json();
        works = data.results || [];
        search_status = works.length > 0 ? "ok" : "empty";
      } else {
        search_status = res.status === 429 ? "rate_limited" : "error";
      }
    } catch { search_status = "error"; works = []; }
    let kept_verified = 0;
    let kept_candidate = 0;
    let t_dropped_unresolved = 0;
    let t_dropped_inconclusive = 0;
    for (const w of works) {
      const doi = w.doi ? w.doi.replace(/^https:\/\/doi\.org\//, "") : null;
      const db = doi ? await checkByDOI(doi, fetchImpl) : await checkByTitle(w.title || "", fetchImpl);
      if (db.status === "verified" || db.status === "candidate") {
        recommendations.push({
          query: term,
          title: db.title || w.title || null,
          authors: db.authors || (w.authorships || []).map((a) => a.author?.display_name).filter(Boolean),
          year: db.year ?? w.publication_year ?? null,
          journal: db.journal || w.primary_location?.source?.display_name || null,
          doi: doi || w.doi || null,
          verification: db.status, // "verified" or "candidate" only
        });
        if (db.status === "verified") kept_verified += 1; else kept_candidate += 1;
      } else if (db.status === "inconclusive") {
        dropped_inconclusive += 1; t_dropped_inconclusive += 1;
      } else {
        dropped_unresolved += 1; t_dropped_unresolved += 1;
      }
    }
    per_term.push({ term, query_used: term, search_status, http_status, raw_results: works.length, kept_verified, kept_candidate, dropped_unresolved: t_dropped_unresolved, dropped_inconclusive: t_dropped_inconclusive });
  }
  return { searched_terms: terms, terms_considered: allTerms.length, recommendations, dropped_unresolved, dropped_inconclusive, per_term };
}
