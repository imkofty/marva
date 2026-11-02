// Venue-based journal recommendations (submission version, 2026-11-02).
// Built ONLY from the paper's own DOI-verified references: the verifier
// already paid for their Crossref metadata, so this path costs ZERO
// new OpenAlex searches and cannot 429. A venue is named ONLY when at
// least THRESHOLD verified references of this paper were published in
// it; below that, only the classified fields are shown, with the
// reason written out. The label is deliberately NOT "best journal":
// it is "journal from this paper's citation trail" — venues the author
// already cites, not a prediction of acceptance and not a Scopus
// claim (scopus_indexed_status stays "unverified" always).
// verifiedVenues entries: { journal, doi, reference } as recorded by
// the verifier stage (Crossref container-title for DOI-verified refs).
// Entries without a journal name are ignored: a venue that cannot be
// named from database metadata must not be guessed from a reference
// string.
export function buildVenueRecommendations(verifiedVenues, fields) {
  const THRESHOLD = 2;
  const fieldNames = (fields || []).map((f) => f.name).filter(Boolean);
  const byVenue = new Map();
  const used = (verifiedVenues || []).filter((v) => v && v.journal);
  for (const v of used) {
    const key = v.journal.trim().toLowerCase();
    if (!byVenue.has(key)) byVenue.set(key, { journal: v.journal, refs: [] });
    byVenue.get(key).refs.push({ doi: v.doi || null, reference: v.reference || null });
  }
  const recommendations = [];
  const venues_found = [];
  for (const entry of byVenue.values()) {
    venues_found.push({ journal: entry.journal, count: entry.refs.length });
    if (entry.refs.length >= THRESHOLD) {
      const evidence = `${entry.refs.length} dari ${used.length} referensi terverifikasi paper ini terbit di jurnal ini`;
      recommendations.push({
        journal: entry.journal,
        scope_evidence: {
          fields: fieldNames,
          recent_works: entry.refs,
          note: "Jurnal dari jejak sitasi paper ini: venue dari referensi terverifikasi DOI paper itu sendiri, bukan prediksi penerimaan dan bukan klaim Scopus.",
        },
        verification: "citation-trail",
        scopus_indexed_status: "unverified",
        evidence,
      });
    }
  }
  venues_found.sort((a, b) => b.count - a.count);
  return {
    recommendations,
    diagnostics: {
      source: "citation-trail",
      verified_refs_used: used.length,
      threshold: THRESHOLD,
      venues_found,
      field_search: { status: "skipped", reason: "Penamaan jurnal versi submission memakai jejak sitasi terverifikasi; pencarian bidang OpenAlex tidak dipakai sebagai sumber penamaan." },
      scopus: "unverified",
    },
  };
}

// Field-candidate merge (rehabilitation, 2026-11-03): OpenAlex
// field search returns as an ADDITIONAL CANDIDATE source alongside the
// citation trail — never as a naming source. The named set is EXACTLY
// venueResult.recommendations: a field candidate is only ANNOTATED
// (also_suggested_by_field) onto a venue whose verified citation-trail
// count already meets THRESHOLD. A field candidate with verified count
// below threshold (including zero, i.e. never cited by this paper) is
// dropped and recorded in diagnostics, never recommended. Matching is
// exact on normalized (trimmed, lowercased) venue names — no fuzzy
// matching, so a near-miss is dropped rather than falsely corroborated.
// Naming authority stays the citation trail + DOI verification; this
// function cannot lower the threshold and cannot name a new journal.
export function mergeFieldCandidates(venueResult, fieldCandidates) {
  const norm = (s) => String(s || "").trim().toLowerCase();
  const threshold = venueResult?.diagnostics?.threshold ?? 2;
  const counts = new Map();
  for (const v of venueResult?.diagnostics?.venues_found || []) {
    if (v?.journal) counts.set(norm(v.journal), v.count ?? 0);
  }
  // Defensive fallback: a venue already named by the trail counts as
  // meeting the threshold even if venues_found is absent.
  for (const r of venueResult?.recommendations || []) {
    if (r?.journal && !counts.has(norm(r.journal))) counts.set(norm(r.journal), threshold);
  }
  const recommendations = (venueResult?.recommendations || []).map((r) => ({ ...r }));
  const byKey = new Map(recommendations.map((r) => [norm(r.journal), r]));
  const seen = new Set();
  const corroborated = [];
  const dropped_unverified = [];
  for (const c of fieldCandidates || []) {
    const name = c?.journal?.trim();
    if (!name) continue;
    const key = norm(name);
    if (seen.has(key)) continue;
    seen.add(key);
    const count = counts.get(key) ?? 0;
    if (count >= threshold && byKey.has(key)) {
      byKey.get(key).also_suggested_by_field = true;
      corroborated.push({ journal: byKey.get(key).journal, verified_count: count });
    } else {
      dropped_unverified.push({
        journal: name,
        verified_count: count,
        reason: `Field candidate dropped: only ${count} verified reference(s) in this paper's citation trail, below naming threshold ${threshold}.`,
      });
    }
  }
  return {
    recommendations,
    diagnostics: {
      ...(venueResult?.diagnostics || {}),
      field_search: { status: "ok", candidates: seen.size, corroborated, dropped_unverified },
    },
  };
}

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
