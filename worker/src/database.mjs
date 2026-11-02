// Database truth layer, copied in logic from backend/src/lib/database.mjs.
// The database decides, the model only reasons. Crossref for DOI lookup,
// OpenAlex for title lookup. No API key needed for these public endpoints.
// A reference is verified only when the database returns a matching
// title/authors/year; anything else is flagged or unresolved, never
// presented as verified.
export async function checkByDOI(doi, fetchImpl = fetch, counter = null) {
  if (!doi || !doi.includes("/")) return { status: "unresolved", reason: "No DOI" };
  // Quota counter (optional, additive): only a real outgoing call
  // counts — validation failures above never touch the network.
  if (counter) counter.crossref_doi_lookups = (counter.crossref_doi_lookups || 0) + 1;
  try {
    const res = await fetchImpl(`https://api.crossref.org/works/${encodeURIComponent(doi)}`, { headers: { Accept: "application/json" }, signal: typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(15000) : undefined });
    if (res.status === 429) return { status: "inconclusive", reason: "Crossref 429 rate limit" };
    if (!res.ok) return { status: "unresolved", reason: `Crossref ${res.status}` };
    const data = await res.json();
    const m = data.message || {};
    return { status: "verified", title: (m.title || [])[0] || null, authors: (m.author || []).map((a) => `${a.family || ""}, ${a.given || ""}`.trim()), year: m.published?.["date-parts"]?.[0]?.[0] || m.issued?.["date-parts"]?.[0]?.[0] || null, journal: (m["container-title"] || [])[0] || null };
  } catch (e) { return { status: "unresolved", reason: String(e.message || e) }; }
}

// Wrap a fetch implementation so OpenAlex calls carry the free API key
// when one is configured (Worker secret OPENALEX_API_KEY). Only
// api.openalex.org URLs are touched; every other host passes through
// unchanged. An unknown query parameter is ignored by OpenAlex, so
// sending api_key can never break an anonymous call — worst case the
// key is ignored and the call behaves exactly as before. No key means
// no wrapper behaviour at all (the original fetch is returned as-is).
export function withOpenAlexKey(fetchImpl, apiKey) {
  if (!apiKey) return fetchImpl;
  return (url, opts) => {
    try {
      const u = new URL(String(url));
      if (u.hostname === "api.openalex.org") u.searchParams.set("api_key", apiKey);
      return fetchImpl(u.toString(), opts);
    } catch { return fetchImpl(url, opts); }
  };
}

export async function checkByTitle(title, fetchImpl = fetch, counter = null) {
  if (!title) return { status: "unresolved", reason: "No title" };
  // Quota counter (optional, additive): only a real outgoing call
  // counts — the empty-title guard above never touches the network.
  if (counter) counter.openalex_title_lookups = (counter.openalex_title_lookups || 0) + 1;
  try {
    const res = await fetchImpl(`https://api.openalex.org/works?search=${encodeURIComponent(title)}&per-page=1`, { headers: { Accept: "application/json" }, signal: typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(15000) : undefined });
    if (res.status === 429) return { status: "inconclusive", reason: "OpenAlex 429 rate limit" };
    if (!res.ok) return { status: "unresolved", reason: `OpenAlex ${res.status}` };
    const data = await res.json();
    const w = (data.results || [])[0];
    if (!w) return { status: "unresolved", reason: "No match" };
    return { status: "candidate", title: w.title, authors: (w.authorships || []).map((a) => a.author?.display_name).filter(Boolean), year: w.publication_year, journal: w.primary_location?.source?.display_name || null, doi: w.doi || null };
  } catch (e) { return { status: "unresolved", reason: String(e.message || e) }; }
}
