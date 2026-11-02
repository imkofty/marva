// Adversarial cross-check (Wonder P-plan, 2026-10-29): the deterministic
// matcher flags ambiguous author-year citations — one cited key with two
// or more listed entries sharing its last word + year — and stops there
// rather than guessing. Wonder may resolve ONLY those code-filtered
// cases, and only from the citing sentence plus the candidate entries.
// The code then validates every proposal deterministically, and a
// rejected proposal stays flagged: it is shown as "model proposal that
// failed code validation", never silently matched. An accepted case
// becomes status "matched-by-crosscheck", strictly separate from
// "verified" (verified comes only from a database DOI match).
// Never called on bulk citations, never on numeric lists, never
// without a citing sentence: a key alone cannot distinguish two
// same-surname same-year entries, so a sentence-less cross-check
// would be theatre, and it is not shipped.
import { runAgent } from "./agents.mjs";

const STOP = new Set("the and for with from that this these those which when where have been were are was its into over under between after before about their there then than also such more most other than into upon per via within without".split(" "));

function contentTokens(s) {
  return new Set(String(s || "").toLowerCase().replace(/[^a-zà-ÿ\s]/g, " ").split(/\s+/).filter((w) => w.length >= 4 && !STOP.has(w)));
}

// Deterministic validation of one Wonder proposal. The year must match
// (it does by construction for ambiguous candidates, but it is checked
// anyway), and the citing sentence must share at least two content
// tokens with the candidate's entry text — the cited surname itself
// does not count, since every candidate shares it. Fewer than two
// shared tokens means the sentence does not distinguish this candidate
// from its rivals, so the proposal is rejected even if Wonder was
// confident: confidence is not evidence.
export function validateCrosscheckPick(citedKey, candidateKey, sentence, candidateEntry) {
  const yearOf = (k) => (String(k).split(",")[1] || "").trim();
  if (yearOf(citedKey) !== yearOf(candidateKey)) return { ok: false, reason: "candidate year does not match the cited year" };
  const surnameWords = new Set(String(citedKey).split(",")[0].trim().toLowerCase().split(/\s+/));
  const sent = contentTokens(sentence);
  const entry = contentTokens(candidateEntry);
  for (const w of surnameWords) { sent.delete(w); entry.delete(w); }
  const shared = [...sent].filter((t) => entry.has(t));
  if (shared.length >= 2) return { ok: true, shared };
  return { ok: false, reason: `citing sentence shares only ${shared.length} content token(s) with this candidate entry (${shared.join(", ") || "none"}); the sentence does not distinguish it from its rivals` };
}

export async function runCrosscheck(ambiguous, { listedKeys, refs, contexts, agentDeps }) {
  const contextByKey = new Map((contexts || []).map((c) => [c.key, c.sentence]));
  const cases = ambiguous.map((a) => ({
    cited: a.cited,
    sentence: contextByKey.get(a.cited) || null,
    candidates: a.candidates.map((cand) => {
      const idx = listedKeys.indexOf(cand);
      return { key: cand, entry: idx >= 0 ? refs[idx] : cand };
    }),
  })).filter((c) => c.sentence);
  const out = { proposed: cases.length, accepted: [], rejected: [], abstained: [] };
  if (cases.length === 0) return out;
  const res = await runAgent("crosscheck", { cases, instruction: "For each case, pick exactly one candidate key or null. Pick only on textual evidence in the citing sentence; if the sentence does not distinguish the candidates, pick null, never guess." }, { ...agentDeps, model: "muse-wonder-1.0" });
  if (res.error || !res.data || !Array.isArray(res.data.decisions)) {
    for (const c of cases) out.rejected.push({ cited: c.cited, proposed: null, reason: res.error ? `model call failed: ${res.error}` : "model response did not contain decisions" });
    return out;
  }
  const decisionByCited = new Map(res.data.decisions.map((d) => [d.cited, d]));
  for (const c of cases) {
    const d = decisionByCited.get(c.cited);
    if (!d) { out.rejected.push({ cited: c.cited, proposed: null, reason: "model gave no decision for this case" }); continue; }
    if (d.pick === null || d.pick === undefined) { out.abstained.push({ cited: c.cited, reason: d.reason || "model abstained" }); continue; }
    const cand = c.candidates.find((k) => k.key === d.pick);
    if (!cand) { out.rejected.push({ cited: c.cited, proposed: d.pick, reason: "model picked a key that is not one of the code-filtered candidates" }); continue; }
    const v = validateCrosscheckPick(c.cited, cand.key, c.sentence, cand.entry);
    if (v.ok) out.accepted.push({ cited: c.cited, matched: cand.key, reason: d.reason || "", evidence_tokens: v.shared });
    else out.rejected.push({ cited: c.cited, proposed: cand.key, reason: `model proposal failed code validation: ${v.reason}. Model reason was: ${d.reason || "(none)"}` });
  }
  return out;
}
