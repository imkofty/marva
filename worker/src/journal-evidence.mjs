// Journal recommendations, built from real database evidence only.
// Ported from backend-node/src/lib/journal-evidence.mjs, minus Scopus:
// the Worker has no SCOPUS_API_KEY, so scopus_indexed_status is always
// "unverified" here, never a claim. Source: OpenAlex works in the
// classified fields. Works are grouped by journal; a journal appears
// ONLY when at least one recent OpenAlex work in that field names it.
// A recommendation is never a claim that the journal will accept the
// manuscript, and never a claim that it is Scopus-indexed. A search
// failure produces no evidence; the stage still succeeds with an
// empty list, and the report must say so honestly.
export async function buildJournalRecommendations(fields, fetchImpl = fetch) {
  const names = (fields || []).map((f) => f.name).filter(Boolean).slice(0, 2);
  const works = [];
  for (const name of names) {
    try {
      const res = await fetchImpl(`https://api.openalex.org/works?search=${encodeURIComponent(name)}&per-page=3`, {
        headers: { Accept: "application/json" },
        signal: typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(15000) : undefined,
      });
      if (!res.ok) continue;
      const data = await res.json();
      for (const w of data.results || []) {
        works.push({
          field: name,
          title: w.title || null,
          authors: (w.authorships || []).map((a) => a.author?.display_name).filter(Boolean),
          year: w.publication_year ?? null,
          journal: w.primary_location?.source?.display_name || null,
          doi: w.doi ? w.doi.replace(/^https:\/\/doi\.org\//, "") : null,
          verification: "candidate",
          scopus_indexed_status: "unverified",
        });
      }
    } catch { /* search failure -> no evidence, stage still succeeds */ }
  }
  const byJournal = new Map();
  for (const w of works) {
    if (!w.journal) continue;
    if (!byJournal.has(w.journal)) byJournal.set(w.journal, { journal: w.journal, fields: new Set(), recent_works: [] });
    const entry = byJournal.get(w.journal);
    entry.fields.add(w.field);
    entry.recent_works.push({ title: w.title, authors: w.authors, year: w.year, doi: w.doi });
  }
  const recommendations = [];
  for (const entry of byJournal.values()) {
    recommendations.push({
      journal: entry.journal,
      scope_evidence: {
        fields: [...entry.fields],
        recent_works: entry.recent_works.slice(0, 3),
        note: "Journal named by recent OpenAlex works in the classified field(s); this is scope evidence only, not an acceptance prediction.",
      },
      verification: "candidate",
      scopus_indexed_status: "unverified",
    });
  }
  return { works, recommendations };
}
