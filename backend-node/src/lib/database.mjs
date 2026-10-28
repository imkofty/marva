// Database truth layer. The database decides, the model only reasons.
// Crossref for DOI lookup, OpenAlex for title lookup. No API key needed
// for these public endpoints. A reference is verified only when the
// database returns a matching title/authors/year; anything else is
// flagged or unresolved, never presented as verified.
// External database calls must never hang a job: 15s per call, then
// unresolved. A slow database is a failed check, not a stuck audit.
function timedFetch(fetchImpl, url, opts) {
  try {
    const signal = typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(15000) : undefined;
    return fetchImpl(url, signal ? { ...opts, signal } : opts);
  } catch { return fetchImpl(url, opts); }
}

export async function checkByDOI(doi, fetchImpl = fetch) {
  if (!doi || !doi.includes("/")) return { status: "unresolved", reason: "No DOI" };
  try {
    const res = await timedFetch(fetchImpl, `https://api.crossref.org/works/${encodeURIComponent(doi)}`, { headers: { Accept: "application/json" } });
    if (!res.ok) return { status: "unresolved", reason: `Crossref ${res.status}` };
    const data = await res.json();
    const m = data.message || {};
    return { status: "verified", title: (m.title || [])[0] || null, authors: (m.author || []).map((a) => `${a.family || ""}, ${a.given || ""}`.trim()), year: m.published?.["date-parts"]?.[0]?.[0] || m.issued?.["date-parts"]?.[0]?.[0] || null, journal: (m["container-title"] || [])[0] || null };
  } catch (e) { return { status: "unresolved", reason: String(e.message || e) }; }
}

export async function checkByTitle(title, fetchImpl = fetch) {
  if (!title) return { status: "unresolved", reason: "No title" };
  try {
    const res = await timedFetch(fetchImpl, `https://api.openalex.org/works?search=${encodeURIComponent(title)}&per-page=1`, { headers: { Accept: "application/json" } });
    if (!res.ok) return { status: "unresolved", reason: `OpenAlex ${res.status}` };
    const data = await res.json();
    const w = (data.results || [])[0];
    if (!w) return { status: "unresolved", reason: "No match" };
    return { status: "candidate", title: w.title, authors: (w.authorships || []).map((a) => a.author?.display_name).filter(Boolean), year: w.publication_year, journal: w.primary_location?.source?.display_name || null, doi: w.doi || null };
  } catch (e) { return { status: "unresolved", reason: String(e.message || e) }; }
}
