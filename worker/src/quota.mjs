// Per-job OpenAlex usage counter + strengthening reservation.
//
// Scope (deliberate): the counter tracks THIS job's database calls
// only. A shared daily pool across jobs would need a KV/DO ledger
// written on every API call — the exact write-budget failure the DO
// migration removed — so cross-job daily accounting is NOT done
// here. The per-job budget (Worker env OPENALEX_JOB_BUDGET, or
// deps.quotaBudget in tests) defaults to unlimited: with no budget
// configured, job flow is identical to before, and the counter is
// purely observational.
//
// What counts (call-site counting, never URL sniffing):
// - openalex_searches: strengthening search queries (per-page 3).
// - openalex_title_lookups: OpenAlex title lookups (per-page 1),
//   used for references without a DOI and for re-verifying
//   non-DOI strengthening candidates. These hit the same OpenAlex
//   pool as searches, and are what hits the 429 wall.
// - crossref_doi_lookups: Crossref DOI checks. These ride the
//   Crossref pool, NOT the OpenAlex budget, so they are reported
//   but never counted against the reservation budget.
// KV-cache hits never reach an API call, so they are never counted.
//
// Reservation: before the strengthening stage runs, the worst-case
// cost is estimated (per term: 1 search + up to 3 re-verifications
// = 4 OpenAlex calls; terms capped at 2, so at most 8). If the
// job's OpenAlex usage plus that estimate exceeds the budget, the
// stage is skipped with reason "quota_reserved" — recorded in the
// report, never a silent zero. A 429 DURING a search is a different
// signal and keeps its existing "rate_limited" per-term diagnostic.
export function createQuotaCounter() {
  return { openalex_searches: 0, openalex_title_lookups: 0, crossref_doi_lookups: 0 };
}

export function quotaTotals(q) {
  const openalex_searches = q?.openalex_searches || 0;
  const openalex_title_lookups = q?.openalex_title_lookups || 0;
  const crossref_doi_lookups = q?.crossref_doi_lookups || 0;
  const openalex_calls = openalex_searches + openalex_title_lookups;
  return { openalex_searches, openalex_title_lookups, crossref_doi_lookups, openalex_calls, total_api_calls: openalex_calls + crossref_doi_lookups };
}

export function snapshotQuota(q) {
  return q ? quotaTotals(q) : null;
}

// 0 (or unset, or unparseable) means unlimited: no reservation, no
// behaviour change. Worker env vars arrive as strings; tests may
// pass a number via deps.
export function quotaBudget(env, deps) {
  const raw = deps?.quotaBudget ?? env?.OPENALEX_JOB_BUDGET;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export function estimateStrengtheningCost(terms) {
  return Math.min((terms || []).filter(Boolean).length, 2) * 4;
}

export function checkStrengtheningQuota({ quota, budget, terms }) {
  const used = (quota?.openalex_searches || 0) + (quota?.openalex_title_lookups || 0);
  const estimate = estimateStrengtheningCost(terms);
  if (budget > 0 && used + estimate > budget) {
    return { reserved: true, used, estimate, budget, remaining: budget - used };
  }
  return { reserved: false, used, estimate, budget, remaining: budget > 0 ? budget - used : null };
}
