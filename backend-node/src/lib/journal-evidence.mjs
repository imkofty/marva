// Journal recommendations, built from real database evidence only.
// Source: OpenAlex works in the classified fields. Works are grouped by
// journal; a journal appears ONLY when at least one recent OpenAlex
// work in that field names it. Scopus status comes from scopus.mjs and
// stays "unverified" unless that API really returns a match.
// A recommendation is never a claim that the journal will accept the
// manuscript, and never a claim that it is Scopus-indexed.
import { checkScopusJournal } from "./scopus.mjs";

export async function searchJournalEvidence(fields, fetchImpl = fetch) {
  const names = (fields || []).map((f) => f.name).filter(Boolean).slice(0, 2);
  const works = [];
  for (const name of names) {
    try {
      const res = await fetchImpl(`https://api.openalex.org/works?search=${encodeURIComponent(name)}&per-page=3`, { headers: { Accept: "application/json" } });
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
  return works;
}

export async function buildJournalRecommendations(fields, fetchImpl = fetch) {
  const works = await searchJournalEvidence(fields, fetchImpl);
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
    const scopus = await checkScopusJournal(entry.journal, fetchImpl);
    recommendations.push({
      journal: entry.journal,
      scope_evidence: {
        fields: [...entry.fields],
        recent_works: entry.recent_works.slice(0, 3),
        note: "Journal named by recent OpenAlex works in the classified field(s); this is scope evidence only, not an acceptance prediction.",
      },
      verification: "candidate",
      scopus_indexed_status: scopus.scopus_indexed_status,
      scopus: scopus.scopus_indexed_status === "indexed" ? scopus : { reason: scopus.reason },
    });
  }
  return { works, recommendations };
}
