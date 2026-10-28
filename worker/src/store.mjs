// KV job store. Binding name MARVA_JOBS (see wrangler.toml).
// The stored job record NEVER contains the manuscript text: text is
// passed to runJob in memory only and is not persisted to KV, so a
// manuscript is processed for that job only and is not stored.
// Job record shape (all JSON-serialisable):
// {id, status, citations, references, reader, result, verifier, gap,
//  journal, supervisor, strengthening, events, partial, pdf_note, updatedAt}
// The "active" key holds the currently running job id, or null.
// Local-only fallback: if env.MARVA_JOBS is missing (node test), the
// caller supplies a FakeKV; in production the binding must exist and
// a missing binding returns a 500, never a silent in-memory store.
export async function loadJob(env, id) {
  if (!env.MARVA_JOBS) throw new Error("MARVA_JOBS binding not configured");
  const raw = await env.MARVA_JOBS.get(`job:${id}`);
  return raw ? JSON.parse(raw) : null;
}

export async function saveJob(env, job) {
  if (!env.MARVA_JOBS) throw new Error("MARVA_JOBS binding not configured");
  const { text, ...stored } = job; // never persist manuscript text
  stored.updatedAt = Date.now();
  await env.MARVA_JOBS.put(`job:${job.id}`, JSON.stringify(stored));
  return stored;
}

export async function loadActive(env) {
  if (!env.MARVA_JOBS) throw new Error("MARVA_JOBS binding not configured");
  return env.MARVA_JOBS.get("active");
}

export async function saveActive(env, jobId) {
  await env.MARVA_JOBS.put("active", jobId || "");
}

export async function clearActiveIf(env, jobId) {
  const cur = await loadActive(env);
  if (cur === jobId) await saveActive(env, "");
}

export async function deleteJob(env, id) {
  if (!env.MARVA_JOBS) throw new Error("MARVA_JOBS binding not configured");
  await env.MARVA_JOBS.delete(`job:${id}`);
}
