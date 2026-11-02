// Node test harness for the Worker handler.
// NOT a Workers runtime test: wrangler/miniflare were not available
// in the build VM. Fake KV (Map) + fake DO storage + fake global
// fetch prove the handler, stage order, deterministic matcher, demo
// endpoint, and honest no-key behaviour. Real KV, real Durable
// Objects, real Workers, and real model / database responses are NOT
// proven here and need the deploy step.
import test from "node:test";
import assert from "node:assert/strict";
import worker, { runJob } from "../src/index.mjs";
import { JobObject } from "../src/job-object.mjs";

class FakeKV {
  constructor() { this.map = new Map(); }
  async get(k) { return this.map.has(k) ? this.map.get(k) : null; }
  async put(k, v) { this.map.set(k, v); }
  async delete(k) { this.map.delete(k); }
}

// Fake DO storage: Map-backed, with alarm bookkeeping. get() returns
// undefined for missing keys, like real DO storage (not null).
class FakeDOStorage {
  constructor() { this.map = new Map(); this.alarmTime = null; this.puts = 0; }
  async get(k) { return this.map.has(k) ? this.map.get(k) : undefined; }
  async put(k, v) { this.map.set(k, v); this.puts += 1; }
  async delete(k) { this.map.delete(k); }
  async deleteAll() { this.map.clear(); }
  async setAlarm(t) { this.alarmTime = t; }
  async getAlarm() { return this.alarmTime; }
}

class FakeDOStub {
  constructor(instance) { this.instance = instance; }
  async fetch(request) { return this.instance.fetch(request); }
}

function makeDoBinding(env) {
  const instances = new Map();
  return {
    _instances: instances,
    idFromName: (name) => name,
    get: (id) => {
      if (!instances.has(id)) instances.set(id, new JobObject({ storage: new FakeDOStorage() }, env));
      const stub = new FakeDOStub(instances.get(id));
      stub.instance = instances.get(id);
      return stub;
    },
  };
}

function makeEnv(apiKey) {
  const env = { MARVA_JOBS: new FakeKV(), MODEL_API_KEY: apiKey || "" };
  env.JOB_OBJECTS = makeDoBinding(env);
  return env;
}

function makeCtx() {
  const ctx = { promises: [], waitUntil(p) { ctx.promises.push(p); } };
  return ctx;
}

// Fake fetch router: Meta model API, Crossref, OpenAlex.
function installFakeFetch() {
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.includes("api.meta.ai")) {
      const body = JSON.parse(opts.body || "{}");
      const sys = body.messages?.[0]?.content || "";
      let payload;
      if (sys.includes("extract structure")) {
        payload = { claims: [{ text: "Checklist helps farmers", location: "Abstract" }], theories: [{ name: "Technology Acceptance Model", originator: "Davis", location: "Abstract" }], quotes: [], citations: ["Davis, 1989", "Rahman, 2021", "Patel, 2019", "Kumar, 2005", "Venkatesh, 2003"], references: ["Davis, 1989. Perceived usefulness. MIS Quarterly.", "Venkatesh, 2003. User acceptance. MIS Quarterly.", "Patel, 2018. Mobile checklists for farm work.", "Kumar, 2005. Early farm advisory services.", "Wijaya, 2017. Irrigation scheduling in dry regions."], method: "pilot study", equations: [], tables: [] };
      } else if (sys.includes("assess gaps")) {
        payload = { missing_theories: [{ name: "Diffusion of Innovations", why: "rival adoption theory not discussed" }], rival_theories: [], outdated_references: ["Kumar, 2005"], note: "test" };
      } else if (sys.includes("classify a manuscript")) {
        payload = { fields: [{ name: "Agricultural technology", evidence: "mobile checklist for farmers" }], note: "test" };
      } else if (sys.includes("merge audit results")) {
        payload = { diagnostic: [{ dimension: "citation", finding: "Missing citation", evidence: "text", location: "Abstract" }], fixes: [{ priority: "must-fix", action: "Add the missing reference.", evidence: "text" }] };
      } else if (sys.includes("screen references")) {
        payload = { verified: [], flagged: [], ambiguous: [] };
      } else {
        payload = {};
      }
      return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(payload) } }] }) };
    }
    if (u.includes("api.crossref.org")) {
      return { ok: true, json: async () => ({ message: { title: ["A verified test paper"], author: [{ family: "Test", given: "T" }], published: { "date-parts": [[2020]] }, "container-title": ["Test Journal"] } }) };
    }
    if (u.includes("api.openalex.org")) {
      const q = decodeURIComponent((u.match(/search=([^&]*)/) || ["", ""])[1] || "");
      return { ok: true, json: async () => ({ results: [{ title: q || "Test work", authorships: [{ author: { display_name: "Test Author" } }], publication_year: 2021, primary_location: { source: { display_name: "Test Journal" } }, doi: "https://doi.org/10.1234/testwork" }] }) };
    }
    throw new Error(`Unexpected fetch in test: ${u}`);
  };
  return orig;
}

async function postJob(env, ctx, body) {
  const req = new Request("https://worker.test/jobs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return worker.fetch(req, env, ctx);
}

async function getJob(env, id) {
  const res = await worker.fetch(new Request(`https://worker.test/jobs/${id}`), env, {});
  return { status: res.status, body: await res.json() };
}

// Polling + simulated alarms: GET /events is read-only since the DO
// migration, so progress comes from DO alarms. Each loop iteration
// polls once, then fires the job's next alarm (what the Workers
// runtime does on its own in production), until done (max 12 polls,
// one per stage + margin).
async function pollUntilDone(env, id) {
  for (let i = 0; i < 12; i++) {
    const res = await worker.fetch(new Request(`https://worker.test/jobs/${id}/events`), env, {});
    const body = await res.json();
    if (body.status === "done") return body;
    const inst = env.JOB_OBJECTS._instances.get(id);
    if (inst) await inst.alarm();
  }
  throw new Error("job did not finish after 12 polls");
}

test("POST + polling events + deterministic missing citation, no key", async () => {
  const orig = installFakeFetch();
  try {
    const env = makeEnv("");
    const ctx = makeCtx();
    const res = await postJob(env, ctx, { text: "Some manuscript text.", citations: ["Rahman, 2021"], references: ["Davis, 1989. Perceived usefulness. MIS Quarterly."] });
    assert.equal(res.status, 201);
    const created = await res.json();
    // Second POST while running must be 409.
    const ctx2 = makeCtx();
    const res2 = await postJob(env, ctx2, { text: "x" });
    assert.equal(res2.status, 409);
    await pollUntilDone(env, created.jobId);
    const { body } = await getJob(env, created.jobId);
    assert.equal(body.status, "done");
    assert.deepEqual(body.result.missing, ["rahman, 2021"]);
    assert.deepEqual(body.result.uncited, ["davis, 1989"]);
    assert.deepEqual(body.result.uncited_references, ["Davis, 1989. Perceived usefulness. MIS Quarterly."]);
    assert.equal(body.reader, null);
    assert.equal(body.report.limitations[0], "MARVA does not guarantee acceptance at any journal.");
    assert.ok(!JSON.stringify(body).includes("plagiarism_percentage"));
    assert.ok(!("text" in body));
    const evRes = await worker.fetch(new Request(`https://worker.test/jobs/${created.jobId}/events`), env, {});
    const evBody = await evRes.json();
    assert.ok(evBody.events.some((e) => e.stage === "reader" && e.status === "skipped"));
    assert.ok(evBody.events.some((e) => e.stage === "citation_matcher" && e.status === "done"));
    assert.ok(evBody.events.some((e) => e.stage === "job" && e.status === "done"));
  } finally { globalThis.fetch = orig; }
});

test("Full-key job: reader, verifier, gap, strengthening, journal, supervisor", async () => {
  const orig = installFakeFetch();
  try {
    const env = makeEnv("test-key-not-real");
    const ctx = makeCtx();
    const res = await postJob(env, ctx, { text: "Synthetic manuscript text. The checklist is based on the Technology Acceptance Model (Davis, 1989). It builds on earlier farm work (Kumar, 2005), recent checklist work (Patel, 2019) and a missing study (Rahman, 2021), and follows acceptance research (Venkatesh, 2003).\n\n## References\n- Davis, 1989. Perceived usefulness. MIS Quarterly.\n- Venkatesh, 2003. User acceptance. MIS Quarterly.\n- Patel, 2018. Mobile checklists for farm work.\n- Kumar, 2005. Early farm advisory services.\n- Wijaya, 2017. Irrigation scheduling in dry regions." });
    assert.equal(res.status, 201);
    const created = await res.json();
    await pollUntilDone(env, created.jobId);
    const { body } = await getJob(env, created.jobId);
    assert.equal(body.status, "done");
    assert.equal(body.reader.method, "pilot study");
    assert.ok(body.result.missing.includes("rahman, 2021"));
    assert.ok(body.result.uncited.some((u) => u.includes("wijaya, 2017")));
    assert.equal(body.gap.missing_theories[0].name, "Diffusion of Innovations");
    assert.ok(Array.isArray(body.strengthening.recommendations));
    assert.ok(body.strengthening.recommendations.length >= 1);
    for (const r of body.strengthening.recommendations) {
      assert.ok(["verified", "candidate"].includes(r.verification), `bad verification label: ${r.verification}`);
    }
    assert.equal(body.journal.scopus_indexed_status, "unverified");
    assert.ok(body.supervisor.diagnostic.length >= 1);
    assert.ok(body.report.diagnostic);
  } finally { globalThis.fetch = orig; }
});

test("Verifier DOI path returns verified via Crossref", async () => {
  const orig = installFakeFetch();
  try {
    const env = makeEnv("");
    const ctx = makeCtx();
    const res = await postJob(env, ctx, { citations: [], references: ["Test, 2020. A verified test paper. https://doi.org/10.1234/test"] });
    const created = await res.json();
    await pollUntilDone(env, created.jobId);
    const { body } = await getJob(env, created.jobId);
    assert.ok(body.verifier.verified.includes("Test, 2020. A verified test paper. https://doi.org/10.1234/test"));
  } finally { globalThis.fetch = orig; }
});

test("Demo synthetic needs no key and makes no model call", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("demo must not call fetch"); };
  try {
    const env = makeEnv("");
    const res = await worker.fetch(new Request("https://worker.test/demo/synthetic"), env, {});
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.demo, true);
    assert.equal(body.synthetic, true);
    assert.equal(body.findings.length, 7);
    assert.ok(body.citation_flags.missing.includes("rahman, 2021"));
    assert.ok(body.findings.some((f) => f.type === "theory_gap"));
  } finally { globalThis.fetch = orig; }
});

test("Report JSON/HTML/PDF + confirm gate + delete, no key", async () => {
  const orig = installFakeFetch();
  try {
    const env = makeEnv("");
    const ctx = makeCtx();
    const res = await postJob(env, ctx, { text: "Some manuscript text.", citations: ["Rahman, 2021"], references: ["Davis, 1989. Perceived usefulness. MIS Quarterly."] });
    const created = await res.json();
    await pollUntilDone(env, created.jobId);
    const rj = await worker.fetch(new Request(`https://worker.test/jobs/${created.jobId}/report.json`), env, {});
    assert.equal(rj.status, 200);
    const report = await rj.json();
    assert.equal(report.held_until_confirmation, true);
    assert.equal(report.confirmed, false);
    assert.equal(report.dimensions.length, 5);
    assert.ok(report.dimensions.every((d) => typeof d.count === "number"));
    const rh = await worker.fetch(new Request(`https://worker.test/jobs/${created.jobId}/report.html`), env, {});
    assert.equal(rh.status, 200);
    assert.ok((await rh.text()).includes("MARVA Report"));
    const rp = await worker.fetch(new Request(`https://worker.test/jobs/${created.jobId}/report.pdf`), env, {});
    assert.equal(rp.status, 200);
    assert.equal(rp.headers.get("Content-Type"), "application/pdf");
    assert.ok((await rp.text()).startsWith("%PDF-"));
    const bad = await worker.fetch(new Request(`https://worker.test/jobs/${created.jobId}/confirm`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }), env, {});
    assert.equal(bad.status, 400);
    const ok = await worker.fetch(new Request(`https://worker.test/jobs/${created.jobId}/confirm`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirmed: true }) }), env, {});
    assert.equal(ok.status, 200);
    const rj2 = await worker.fetch(new Request(`https://worker.test/jobs/${created.jobId}/report.json`), env, {});
    const report2 = await rj2.json();
    assert.equal(report2.confirmed, true);
    assert.equal(report2.held_until_confirmation, false);
    const del = await worker.fetch(new Request(`https://worker.test/jobs/${created.jobId}`, { method: "DELETE" }), env, {});
    assert.equal(del.status, 200);
    const gone = await worker.fetch(new Request(`https://worker.test/jobs/${created.jobId}`), env, {});
    assert.equal(gone.status, 404);
  } finally { globalThis.fetch = orig; }
});

test("Journal evidence from OpenAlex + honest empty-recommendation notes", async () => {
  const { buildJournalRecommendations } = await import("../src/journal-evidence.mjs");
  const { buildReport } = await import("../src/export.mjs");
  const fakeFetch = async () => ({ ok: true, json: async () => ({ results: [{ title: "Field work", authorships: [{ author: { display_name: "A. Test" } }], publication_year: 2022, primary_location: { source: { display_name: "Test Journal" } }, doi: "https://doi.org/10.1234/fieldwork" }] }) });
  const ev = await buildJournalRecommendations([{ name: "Agricultural technology" }], fakeFetch);
  assert.equal(ev.recommendations.length, 1);
  assert.equal(ev.recommendations[0].journal, "Test Journal");
  assert.equal(ev.recommendations[0].scopus_indexed_status, "unverified");
  assert.equal(ev.recommendations[0].verification, "candidate");
  // Empty recommendations must produce honest notes, not a blank space.
  const emptyReport = buildReport({ id: "t", status: "done", confirmed: false, supervisor: { diagnostic: [], fixes: [] }, result: {}, journal_recommendations: [], strengthening: { recommendations: [] } });
  assert.ok(emptyReport.recommendation_notes.length >= 2);
  assert.ok(emptyReport.recommendation_notes.join(" ").includes("verified enough"));
});

test("404, 400, and runJob export", async () => {
  const env = makeEnv("");
  const res404 = await worker.fetch(new Request("https://worker.test/jobs/nope"), env, {});
  assert.equal(res404.status, 404);
  const res400 = await worker.fetch(new Request("https://worker.test/jobs", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{bad" }), env, {});
  assert.equal(res400.status, 400);
  assert.equal(typeof runJob, "function");
});

test("Parser: numeric chain by number (not text order), bracket matching, no false missing", async () => {
  const { parseReferences, scanBracketCitations } = await import("../src/reference-parser.mjs");
  const { matchCitations } = await import("../src/citation-matcher.mjs");
  // Entry 9 displaced after 19 in text order (real MDPI artefact pattern).
  const text = "Body cites [1], [4,8,17] and [18-20].\n\nReferences\n1. Bogue, R. Robotic Exoskeletons.\n2. Inoue, Y. Wrist exoskeleton.\n3. Wang, Z. Hip exoskeletons.\n4. ISO standard.\n5. Jarrasse, N. Methodology.\n6. Proietti, T. Upper limb.\n7. Qiu, S. Wearable exoskeletons.\n8. Xiloyannis, M. Soft exosuit.\n10. European Agency. Factsheet.\n11. Publications Office. Trends.\n12. Jakobsen, L. Back support.\n13. Moeller, T. Muscle synergy.\n14. Godwin, A. Back support.\n15. Feigin, V. Stroke burden.\n16. Gassert, R. Rehabilitation.\n17. Wafa, H. Stroke burden.\n18. Cramer, S. Neural repair.\n9. de Looze, M. Industrial exoskeletons.\n19. Mehrholz, J. Locomotor training.\n20. Lanzani, V. EMG processing.";
  const p = parseReferences(text);
  assert.equal(p.status, "parsed");
  assert.equal(p.style, "numeric");
  assert.deepEqual(p.keys, ["1","2","3","4","5","6","7","8","9","10","11","12","13","14","15","16","17","18","19","20"]);
  const cited = scanBracketCitations(p.body);
  const res = matchCitations(cited, p.keys);
  assert.deepEqual(res.missing, []);
  assert.ok(res.uncited.includes("2"));
  assert.ok(res.uncited.includes("9"));
});

test("Parser: author-year synthetic, gate when no references", async () => {
  const { parseReferences, scanAuthorYearCitations } = await import("../src/reference-parser.mjs");
  const syn = "Work cites (Kumar, 2005), (Patel, 2019), (Davis, 1989) and (Rahman, 2021).\n\n## References\n- Davis, 1989. Perceived usefulness.\n- Patel, 2018. Mobile checklists.\n- Kumar, 2005. Early farm advisory.\n- Wijaya, 2017. Irrigation scheduling.";
  const p = parseReferences(syn);
  assert.equal(p.style, "author-year");
  assert.deepEqual(p.keys, ["davis, 1989", "patel, 2018", "kumar, 2005", "wijaya, 2017"]);
  const { matchCitations } = await import("../src/citation-matcher.mjs");
  const res = matchCitations(scanAuthorYearCitations(p.body), p.keys);
  assert.deepEqual(res.missing.sort(), ["patel, 2019", "rahman, 2021"]);
  assert.deepEqual(res.uncited.sort(), ["patel, 2018", "wijaya, 2017"]);
  const empty = parseReferences("A manuscript with no reference section at all, citing (Davis, 1989).");
  assert.equal(empty.status, "no_references");
});

test("Gate: job with no references reports skipped, not missing flood", async () => {
  const orig = installFakeFetch();
  try {
    const env = makeEnv("");
    const ctx = makeCtx();
    const res = await postJob(env, ctx, { text: "A manuscript citing (Davis, 1989) but with no reference list." });
    const created = await res.json();
    await pollUntilDone(env, created.jobId);
    const { body } = await getJob(env, created.jobId);
    assert.equal(body.result.status, "skipped_no_references");
    assert.deepEqual(body.result.missing, []);
    assert.equal(body.report.citation_flags.status, "skipped_no_references");
    const refDim = body.report.dimensions.find((d) => d.dimension === "References");
    assert.ok(refDim.note && refDim.note.includes("skipped"));
  } finally { globalThis.fetch = orig; }
});

test("Parser: APA author-year list, year on a later line, & citations keyed by first author", async () => {
  const { parseReferences, scanAuthorYearCitations } = await import("../src/reference-parser.mjs");
  const { matchCitations } = await import("../src/citation-matcher.mjs");
  const text = "Work builds on (Serra & Kunc, 2015) and on Shaw et al. (2018), plus an uncited older work and a missing study (Rahman, 2021).\n\nReferences\nSerra, C. E. M., & Kunc, M. (2015). Benefits realisation management and its influence on project success. International Journal of Project Management, 33(1), 53-66.\nShaw, J., Gray, C. S., Baker, G. R., Denis, J. L., Breton, M., Gutberg, J., Embuldeniya, G., Carswell, P., Dunham, A., McKillop, A., Kenealy, T., Sheridan, N., & Wodchis, W. (2018). Mechanisms, contexts and points of contention. BMC Medical Research Methodology, 18, Article 178.\nTodes, A. (2012). New directions in spatial planning. Journal of Planning Education and Research, 32(4), 400-414.";
  const p = parseReferences(text);
  assert.equal(p.style, "author-year");
  assert.deepEqual(p.keys, ["serra, 2015", "shaw, 2018", "todes, 2012"]);
  const cited = scanAuthorYearCitations(p.body);
  assert.ok(cited.includes("serra, 2015"), "Serra & Kunc must key by first author");
  assert.ok(cited.includes("shaw, 2018"));
  assert.ok(!cited.includes("kunc, 2015"));
  const res = matchCitations(cited, p.keys);
  assert.deepEqual(res.missing, ["rahman, 2021"]);
  assert.deepEqual(res.uncited, ["todes, 2012"]);
});

test("Parser: APA wrapped author list does not split, wrapped & does not create second-author citation", async () => {
  const { parseReferences, scanAuthorYearCitations } = await import("../src/reference-parser.mjs");
  const { matchCitations } = await import("../src/citation-matcher.mjs");
  const text = "Work cites (Shaw et al., 2018) and (Serra & \nKunc, 2015).\n\nReferences\nShaw, J., Gray, C. S., Baker, G. R., Denis, J. L., Breton, M., Gutberg, J., Embuldeniya, G., Carswell, P., Dunham, A., McKillop, A., Kenealy, T., Sheridan, N., & \nWodchis, W. (2018). Mechanisms, contexts and points of contention. BMC Medical Research Methodology, 18, Article 178.\nSerra, C. E. M., & Kunc, M. (2015). Benefits realisation management. International Journal of Project Management, 33(1), 53-66.";
  const p = parseReferences(text);
  assert.deepEqual(p.keys, ["shaw, 2018", "serra, 2015"]);
  const cited = scanAuthorYearCitations(p.body);
  assert.ok(cited.includes("shaw, 2018"));
  assert.ok(cited.includes("serra, 2015"));
  assert.ok(!cited.includes("wodchis, 2018"));
  assert.ok(!cited.includes("kunc, 2015"));
  const res = matchCitations(cited, p.keys);
  assert.deepEqual(res.missing, []);
  assert.deepEqual(res.uncited, []);
});

test("Matcher: last-word surname variant + organisation entries", async () => {
  const { parseReferences, scanAuthorYearCitations } = await import("../src/reference-parser.mjs");
  const { matchAuthorYearKeys } = await import("../src/citation-matcher.mjs");
  const text = "Work cites (Souza, 2016), (Bank, 2019) and (Costa, 1998).\n\nReferences\nDe Souza, M. (2016). Governance in practice.\nWorld Bank. (2019). Development report.\nDa Silva Costa, A. (1998). Regional planning.";
  const p = parseReferences(text);
  assert.deepEqual(p.keys, ["de souza, 2016", "world bank, 2019", "da silva costa, 1998"]);
  const res = matchAuthorYearKeys(scanAuthorYearCitations(p.body), p.keys);
  assert.deepEqual(res.missing, []);
  assert.deepEqual(res.uncited, []);
  // Ambiguous last word: two listed entries share last word + year.
  const amb = matchAuthorYearKeys(["souza, 2016"], ["de souza, 2016", "da souza, 2016"]);
  assert.deepEqual(amb.missing, ["souza, 2016"]);
});

test("Matcher ignores messy Reader-model citations, uses body scan only", async () => {
  const orig = installFakeFetch();
  const fake = globalThis.fetch;
  // Wrap the fake: Reader returns raw messy citation strings, as live.
  globalThis.fetch = async (url, opts = {}) => {
    const res = await fake(url, opts);
    const u = String(url);
    if (u.includes("api.meta.ai")) {
      const body = JSON.parse(opts.body || "{}");
      if ((body.messages?.[0]?.content || "").includes("extract structure")) {
        const data = await res.json();
        const payload = JSON.parse(data.choices[0].message.content);
        payload.citations = ["Bhattacharya et al., 2012", "Serra & Kunc, 2015", "Coleman & Kirkham, 2026; Malekpour & Newig, 2020", "Davis, 1989", "Rahman, 2021", "Patel, 2019", "Kumar, 2005", "Venkatesh, 2003"];
        return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(payload) } }] }) };
      }
    }
    return res;
  };
  try {
    const env = makeEnv("x");
    const ctx = makeCtx();
    const res = await postJob(env, ctx, { text: "Synthetic manuscript text. The checklist is based on the Technology Acceptance Model (Davis, 1989). It builds on earlier farm work (Kumar, 2005), recent checklist work (Patel, 2019) and a missing study (Rahman, 2021), and follows acceptance research (Venkatesh, 2003).\n\n## References\n- Davis, 1989. Perceived usefulness. MIS Quarterly.\n- Venkatesh, 2003. User acceptance. MIS Quarterly.\n- Patel, 2018. Mobile checklists for farm work.\n- Kumar, 2005. Early farm advisory services.\n- Wijaya, 2017. Irrigation scheduling in dry regions." });
    const created = await res.json();
    await pollUntilDone(env, created.jobId);
    const { body } = await getJob(env, created.jobId);
    assert.deepEqual(body.result.missing.sort(), ["patel, 2019", "rahman, 2021"]);
    assert.deepEqual(body.result.uncited.sort(), ["patel, 2018", "wijaya, 2017"]);
    assert.ok(!body.result.missing.join(" ").includes("bhattacharya"));
    assert.ok(!body.result.missing.join(" ").includes("serra"));
  } finally { globalThis.fetch = orig; }
});

test("Scanner: author-year citations survive PDF line-wrap and ligature artefacts", async () => {
  const { scanAuthorYearCitations } = await import("../src/reference-parser.mjs");
  // Wrapped comma: "Fadiji et al.\n,\n2024" is one citation, and the
  // et-al. ligature surfacing as a control character must not hide it.
  const body = "Well-being on the continent (\nFadiji et al.\n,\n2024\n; Wilson Fadiji & Khumalo, 2023). Earlier work (Abdellaoui et\u001fal., 2020) agrees.";
  const found = scanAuthorYearCitations(body);
  assert.ok(found.includes("fadiji, 2024"), `missing fadiji 2024 in ${found}`);
  assert.ok(found.includes("abdellaoui, 2020"), `missing abdellaoui 2020 in ${found}`);
  assert.ok(found.includes("fadiji, 2023") || found.includes("khumalo, 2023") || found.length >= 2);
});

test("Matcher: listed et al. and multi-author keys match first-author citations", async () => {
  const { matchAuthorYearKeys } = await import("../src/citation-matcher.mjs");
  const res = matchAuthorYearKeys(
    ["herawati, 2021", "li, 2021", "souza, 2016"],
    ["herawati et al., 2021", "li & cai, 2021", "de souza, 2016"],
  );
  assert.deepEqual(res.missing, []);
  assert.deepEqual(res.uncited, []);
});

test("Parser: artefact entry with implausible year is dropped, not a reference", async () => {
  const { parseReferences } = await import("../src/reference-parser.mjs");
  const text = "Body text here.\n\nReferences\nSmith, J. (2020). Title A.\n(1), 2041. Fragment.\nJones, K. (2019). Title B.";
  const p = parseReferences(text);
  assert.deepEqual(p.keys, ["smith, 2020", "jones, 2019"]);
});

test("Matcher: ambiguous last-word collisions are reported, not assigned", async () => {
  const { matchAuthorYearKeys } = await import("../src/citation-matcher.mjs");
  const res = matchAuthorYearKeys(["souza, 2016"], ["de souza, 2016", "da souza, 2016"]);
  assert.deepEqual(res.missing, ["souza, 2016"]);
  assert.equal(res.ambiguous.length, 1);
  assert.equal(res.ambiguous[0].cited, "souza, 2016");
  assert.deepEqual(res.ambiguous[0].candidates, ["de souza, 2016", "da souza, 2016"]);
});

test("Scanner: citing-sentence contexts match scanned keys", async () => {
  const { scanAuthorYearCitations, scanAuthorYearCitationContexts } = await import("../src/reference-parser.mjs");
  const body = "Yield gains were reported by Souza (2016) for rainfed plots. Later work disagrees (Costa, 1998).";
  const keys = scanAuthorYearCitations(body);
  const ctx = scanAuthorYearCitationContexts(body);
  // Both scans run re1 (Surname, Year) before re2 (Surname (Year)),
  // so order is regex order, not text order — but the key SETS match.
  assert.deepEqual([...keys].sort(), ["costa, 1998", "souza, 2016"]);
  assert.deepEqual(ctx.map((c) => c.key).sort(), [...keys].sort());
  const byKey = new Map(ctx.map((c) => [c.key, c.sentence]));
  assert.ok(byKey.get("souza, 2016").includes("Yield gains"));
  assert.ok(byKey.get("costa, 1998").includes("Later work disagrees"));
});

test("Crosscheck validation: two shared content tokens accept, one rejects, year must match", async () => {
  const { validateCrosscheckPick } = await import("../src/crosscheck.mjs");
  const sent = "Souza (2016) showed drip irrigation raised maize yields under drought conditions.";
  const entry = "De Souza, M. (2016). Drip irrigation and maize yields under drought conditions. Agricultural Water Management.";
  const ok = validateCrosscheckPick("souza, 2016", "de souza, 2016", sent, entry);
  assert.equal(ok.ok, true);
  assert.ok(ok.shared.length >= 2);
  const weak = validateCrosscheckPick("souza, 2016", "de souza, 2016", "Souza (2016) wrote about this topic.", entry);
  assert.equal(weak.ok, false);
  const year = validateCrosscheckPick("souza, 2016", "de souza, 2017", sent, entry);
  assert.equal(year.ok, false);
});

test("Crosscheck end-to-end: Wonder pick validated by code, abstention kept flagged", async () => {
  const { runCrosscheck } = await import("../src/crosscheck.mjs");
  const stubFetch = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ decisions: [
    { cited: "souza, 2016", pick: "de souza, 2016", reason: "Sentence shares drip irrigation and maize yields with this entry." },
    { cited: "costa, 1998", pick: null, reason: "Sentence does not distinguish the candidates." },
  ] }) } }] }) });
  const ambiguous = [
    { cited: "souza, 2016", candidates: ["de souza, 2016", "da souza, 2016"] },
    { cited: "costa, 1998", candidates: ["da silva costa, 1998", "de costa, 1998"] },
  ];
  const listedKeys = ["de souza, 2016", "da souza, 2016", "da silva costa, 1998", "de costa, 1998"];
  const refs = [
    "De Souza, M. (2016). Drip irrigation and maize yields under drought conditions. Agricultural Water Management.",
    "Da Souza, A. (2016). Urban water pricing and household demand. Water Policy.",
    "Da Silva Costa, A. (1998). Regional planning under scarcity. Planning Journal.",
    "De Costa, B. (1998). Coastal erosion and harbour works. Ocean Engineering.",
  ];
  const contexts = [
    { key: "souza, 2016", sentence: "Souza (2016) showed drip irrigation raised maize yields under drought conditions." },
    { key: "costa, 1998", sentence: "Costa (1998) discussed planning." },
  ];
  const cc = await runCrosscheck(ambiguous, { listedKeys, refs, contexts, agentDeps: { fetchImpl: stubFetch, apiKey: "x" } });
  assert.equal(cc.proposed, 2);
  assert.equal(cc.accepted.length, 1);
  assert.equal(cc.accepted[0].matched, "de souza, 2016");
  assert.equal(cc.abstained.length, 1);
  assert.equal(cc.rejected.length, 0);
});


test("Matcher: numeric list flags truncation when body cites far beyond parsed list", async () => {
  const { runStage } = await import("../src/index.mjs");
  const env = makeEnv("");
  const refs = Array.from({ length: 13 }, (_, i) => `${i + 1}. Author, A. Title ${i + 1}. Journal.`);
  const job = { id: "t-test", status: "running", events: [], references: refs, reference_keys: refs.map((_, i) => String(i + 1)), reference_style: "numeric", scanned_citations: { bracket: ["1", "2", "137"], author_year: [], superscript: [] }, citation_contexts: [] };
  await runStage(env, job, "citation_matcher", null, {});
  assert.equal(job.result.list_truncated, true);
  assert.ok(job.result.list_note.includes("[137]"));
});

test("Parser: glued decimals (1.123) do not form a numeric chain; digit-titles do", async () => {
  const { parseReferences } = await import("../src/reference-parser.mjs");
  // 429-style: glued decimals sit on their OWN line above the entry
  // (extraction shape), so the author-year entries must parse as
  // author-year — the decimals must not seed a numeric chain.
  const glued = "Body.\n\nReferences\n1.123\nMayer, R. C., Davis, J. H., and Schoorman, F. D. (1995). Trust model.\n2.11055\nMiller, K. (2021). Humility.\n3.706\nKnowledge at Wharton (2010). Cycle.";
  const g = parseReferences(glued);
  assert.equal(g.style, "author-year");
  assert.ok(g.keys.includes("mayer, 1995"));
  // 315-style: "62. 7 Cups" (space, digit, space, title) continues a
  // chain that runs unbroken from 1.
  const lines = ["Body.", "", "References"];
  for (let n = 1; n <= 60; n++) lines.push(`${n}. Author${n}, A. (2020). Title ${n}.`);
  lines.push("61. Group, P. H. (2025). MindDoc.");
  lines.push("62. 7 Cups connects you to listeners. 2025.");
  lines.push("63. Rediscover yourself. 2025.");
  const d = parseReferences(lines.join("\n"));
  assert.equal(d.style, "numeric");
  assert.equal(d.count, 63);
  assert.deepEqual(d.keys.slice(-3), ["61", "62", "63"]);
});

test("Parser: non-ASCII entry initials continue the numeric chain (421)", async () => {
  const { parseReferences } = await import("../src/reference-parser.mjs");
  // The chain must run unbroken from 1: entries 1..114 are filler,
  // 115..117 carry the real-world break (Øvretveit at 116).
  const lines = ["Body.", "", "References"];
  for (let n = 1; n <= 114; n++) lines.push(`${n}. Author${n}, A. (2020). Title ${n}.`);
  lines.push("115. Wang, Y. (2024). Genomic predictors.");
  lines.push("116. Øvretveit, K. (2025). Polygenic prediction.");
  lines.push("117. Ström, K. (2026). Muscle regulation.");
  const p = parseReferences(lines.join("\n"));
  assert.equal(p.style, "numeric");
  assert.equal(p.count, 117);
  assert.deepEqual(p.keys.slice(-3), ["115", "116", "117"]);
  assert.ok(p.entries[115].includes("Øvretveit"));
});

test("Parser: page-footer marker is skipped for the real entry (319)", async () => {
  const { parseReferences } = await import("../src/reference-parser.mjs");
  // Full 1..17 chain: the footer "16. Page 21 of 21" sits between the
  // real entries 15 and 16, and must not hijack marker 16.
  const lines = ["Body.", "", "References"];
  for (let n = 1; n <= 17; n++) {
    if (n === 16) lines.push("16. Page 21 of 21");
    lines.push(`${n}. Author${n}, A. (20${String(n).padStart(2, "0")}). Title ${n}.`);
  }
  const p = parseReferences(lines.join("\n"));
  assert.equal(p.style, "numeric");
  assert.deepEqual(p.keys, Array.from({ length: 17 }, (_, i) => String(i + 1)));
  assert.ok(p.entries[15].includes("Author16"));
});

// --- Wonder #1 + #3 (2026-10-29): KV write savings ------------------------
// #1: one advancing poll must cost exactly 2 KV puts (lock save +
// final save), for both a verifier batch and a plain stage. Before
// this change a verifier-incomplete poll cost 4 (lock + event save +
// extra save + incomplete-branch save).

// #3: 429 backoff escalates 60s -> 300s -> 900s (capped) and a clean
// batch resets the ladder to 60s.
test("Wonder #3: 429 backoff escalates 60s -> 300s -> 900s, resets on clean batch", async () => {
  const { runStage } = await import("../src/index.mjs");
  const env = makeEnv("");
  const refs = Array.from({ length: 10 }, (_, i) => `Author${i}, A. (2020). Title number ${i}. Journal of Tests.`);
  const stub429 = async () => ({ ok: false, status: 429, json: async () => ({}) });
  const job = { id: "ladder-test", status: "running", events: [], references: refs, next_stage: 2, advancing_until: 0, verifier_progress: null };
  const approx = (actual, secs) => {
    const d = (actual - Date.now()) / 1000;
    assert.ok(d > secs - 10 && d < secs + 10, `expected ~${secs}s backoff, got ${d}s`);
  };
  await runStage(env, job, "reference_verifier", null, { fetchImpl: stub429 });
  assert.equal(job.backoff_level, 1);
  approx(job.verifier_retry_after, 60);
  job.verifier_retry_after = 0;
  await runStage(env, job, "reference_verifier", null, { fetchImpl: stub429 });
  assert.equal(job.backoff_level, 2);
  approx(job.verifier_retry_after, 300);
  job.verifier_retry_after = 0;
  await runStage(env, job, "reference_verifier", null, { fetchImpl: stub429 });
  assert.equal(job.backoff_level, 3);
  approx(job.verifier_retry_after, 900);
  job.verifier_retry_after = 0;
  const stubOk = async () => ({ ok: true, json: async () => ({ results: [] }) });
  await runStage(env, job, "reference_verifier", null, { fetchImpl: stubOk });
  assert.equal(job.backoff_level, 0);
});

// Wonder Q4 regression fixture: a job stored mid-verifier (shaped
// like live job 328: pos 5/10, results already recorded) must resume
// from the same pos, keep its earlier results intact, and not
// duplicate them — before the DO migration touches this shape.

// --- Wonder #2 + #4 (2026-10-29): bigger batches, selective cache -------
test("Wonder #2: verifier batch cap is 24 refs per poll", async () => {
  const { runStage } = await import("../src/index.mjs");
  const env = makeEnv("");
  const refs = Array.from({ length: 30 }, (_, i) => `Author${i}, A. (2020). Title number ${i}. Journal of Tests.`);
  const stubOk = async () => ({ ok: true, json: async () => ({ results: [] }) });
  const job = { id: "batch24", status: "running", events: [], references: refs, next_stage: 2, advancing_until: 0, verifier_progress: null };
  await runStage(env, job, "reference_verifier", null, { fetchImpl: stubOk });
  assert.equal(job.verifier_progress.pos, 24);
  assert.equal(job.verifier_incomplete, true);
  await runStage(env, job, "reference_verifier", null, { fetchImpl: stubOk });
  assert.equal(job.verifier_incomplete, false);
});

// Slow stub (5.5s/ref): refs start at ~0, 5.5, 11, 16.5s; before the
// 5th, elapsed ~22s exceeds the 20s budget, so the batch stops at 4.
test("Wonder #2: verifier batch stops at the ~20s budget", async () => {
  const { runStage } = await import("../src/index.mjs");
  const env = makeEnv("");
  const refs = Array.from({ length: 30 }, (_, i) => `Author${i}, A. (2020). Title number ${i}. Journal of Tests.`);
  const stubSlow = async () => { await new Promise((r) => setTimeout(r, 5500)); return { ok: true, json: async () => ({ results: [] }) }; };
  const job = { id: "batch-budget", status: "running", events: [], references: refs, next_stage: 2, advancing_until: 0, verifier_progress: null };
  await runStage(env, job, "reference_verifier", null, { fetchImpl: stubSlow });
  assert.equal(job.verifier_progress.pos, 4);
});

// Verified DOI cached exactly once even when two references share it;
// an unresolved DOI is never cached.
test("Wonder #4: DOI cache stores verified once per DOI, never unresolved", async () => {
  const { runStage } = await import("../src/index.mjs");
  const env = makeEnv("");
  let cachePuts = 0;
  const origPut = env.MARVA_JOBS.put.bind(env.MARVA_JOBS);
  env.MARVA_JOBS.put = async (k, v, o) => { if (String(k).startsWith("verify:doi:")) cachePuts += 1; return origPut(k, v, o); };
  const stubFetch = async (url) => {
    const u = String(url);
    if (u.includes("api.crossref.org")) {
      if (u.includes("10.1234%2Fverified")) return { ok: true, json: async () => ({ message: { title: ["Verified work"], author: [{ family: "Author", given: "A" }], published: { "date-parts": [[2020]] }, "container-title": ["Journal"] } }) };
      return { ok: false, status: 404, json: async () => ({}) };
    }
    throw new Error(`Unexpected fetch: ${u}`);
  };
  const refs = [
    "Author, A. (2020). Verified work. Journal. https://doi.org/10.1234/verified",
    "Author, B. (2021). Same verified work again. Journal. https://doi.org/10.1234/verified",
    "Author, C. (2022). Unresolved work. Journal. https://doi.org/10.9999/missing",
  ];
  const job = { id: "cache-test", status: "running", events: [], references: refs, next_stage: 2, advancing_until: 0, verifier_progress: null };
  await runStage(env, job, "reference_verifier", null, { fetchImpl: stubFetch });
  assert.equal(cachePuts, 1, "same DOI written once, unresolved DOI never written");
  assert.ok(await env.MARVA_JOBS.get("verify:doi:10.1234/verified"));
  assert.equal(await env.MARVA_JOBS.get("verify:doi:10.9999/missing"), null);
  env.MARVA_JOBS.put = origPut;
});

// --- Durable Object engine (2026-10-29): replaces advanceJob --------
// DO verifier: 429 stops the batch, the alarm (not a poll) carries
// the backoff, an early alarm fetches nothing, resume completes.
test("DO verifier: 429 stops the batch, backoff holds, resume completes", async () => {
  const env = makeEnv("");
  let calls = 0;
  let mode = "429";
  const stubFetch = async (url) => {
    calls += 1;
    if (mode === "429") return { ok: false, status: 429, json: async () => ({}) };
    return { ok: true, json: async () => ({ results: [{ title: "Title number 0", authorships: [{ author: { display_name: "Author0 A" } }], publication_year: 2020, primary_location: { source: { display_name: "Journal of Tests" } }, doi: null }] }) };
  };
  const refs = Array.from({ length: 10 }, (_, i) => `Author${i}, A. (2020). Title number ${i}. Journal of Tests.`);
  const job = { id: "do-429", status: "running", events: [], references: refs, next_stage: 2, advancing_until: 0, verifier_progress: null, verifier_incomplete: false, verifier_retry_after: 0, partial: false, updatedAt: Date.now() };
  const stub = env.JOB_OBJECTS.get("do-429");
  const init = await stub.fetch(new Request("http://do/init?id=do-429", { method: "POST", body: JSON.stringify({ job }), headers: { "Content-Type": "application/json" } }));
  assert.equal(init.status, 200);
  await stub.instance.alarm({ fetchImpl: stubFetch });
  let state = await (await stub.fetch(new Request("http://do/state?id=do-429"))).json();
  assert.equal(state.verifier_incomplete, true);
  assert.equal(state.verifier_progress.inconclusive.length, 1);
  assert.equal(calls, 1);
  const alarmAt = await stub.instance.storage.getAlarm();
  assert.ok(alarmAt - Date.now() > 50000 && alarmAt - Date.now() < 70000, `expected ~60s alarm, got ${alarmAt - Date.now()}ms`);
  // An alarm firing early (before retry_after) must not fetch again.
  await stub.instance.alarm({ fetchImpl: stubFetch });
  assert.equal(calls, 1);
  // After backoff expiry, resume: batch 24 takes all 9 remaining.
  const stored = await stub.instance.storage.get("job");
  stored.verifier_retry_after = 0;
  await stub.instance.storage.put("job", stored);
  mode = "ok";
  await stub.instance.alarm({ fetchImpl: stubFetch });
  state = await (await stub.fetch(new Request("http://do/state?id=do-429"))).json();
  assert.equal(state.verifier_incomplete, false);
  assert.equal(state.next_stage, 3);
  assert.equal(state.verifier.verified.length, 0);
  assert.equal(state.verifier.ambiguous.length, 9);
  assert.equal(state.verifier.inconclusive.length, 1);
});

// Successor to the old KV put-count test: one DO alarm step costs
// exactly 1 DO storage write and 0 KV writes.
test("DO: one alarm step costs exactly 1 storage write, 0 KV writes", async () => {
  const env = makeEnv("");
  const stubOk = async () => ({ ok: true, json: async () => ({ results: [] }) });
  const job = { id: "do-puts", status: "running", events: [], references: ["Author, A. (2020). Title one. Journal of Tests."], next_stage: 2, advancing_until: 0, verifier_progress: null, verifier_incomplete: false, verifier_retry_after: 0, partial: false, updatedAt: Date.now() };
  const stub = env.JOB_OBJECTS.get("do-puts");
  await stub.fetch(new Request("http://do/init?id=do-puts", { method: "POST", body: JSON.stringify({ job }), headers: { "Content-Type": "application/json" } }));
  const putsBefore = stub.instance.storage.puts;
  await stub.instance.alarm({ fetchImpl: stubOk });
  assert.equal(stub.instance.storage.puts - putsBefore, 1);
  assert.equal(env.MARVA_JOBS.map.size, 0);
});

// Wonder Q4, DO edition: a KV copy shaped exactly like live job 328
// mid-flight migrates on first DO access and resumes from the same
// pos, keeping earlier results intact and duplicating nothing.
test("DO migration: KV mid-progress job resumes from pos, no duplicates", async () => {
  const { saveJob } = await import("../src/store.mjs");
  const env = makeEnv("");
  const refs = Array.from({ length: 10 }, (_, i) => `Author${i}, A. (2020). Title number ${i}. Journal of Tests.`);
  const stubOk = async () => ({ ok: true, json: async () => ({ results: [] }) });
  const kvJob = { id: "do-mig", status: "running", events: [], references: refs, next_stage: 2, advancing_until: 0,
    verifier_progress: { order: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], pos: 5, verified: [refs[0], refs[1]], flagged: [], ambiguous: [], inconclusive: [{ reference: refs[2], reason: "rate limited" }] },
    verifier_incomplete: true, verifier_retry_after: 0, partial: false, updatedAt: Date.now() };
  await saveJob(env, kvJob);
  const stub = env.JOB_OBJECTS.get("do-mig");
  const res = await stub.fetch(new Request("http://do/state?id=do-mig"));
  assert.equal(res.status, 200);
  const migrated = await res.json();
  assert.equal(migrated.verifier_progress.pos, 5);
  await stub.instance.alarm({ fetchImpl: stubOk });
  const j = await (await stub.fetch(new Request("http://do/state?id=do-mig"))).json();
  assert.equal(j.verifier_incomplete, false);
  assert.equal(j.next_stage, 3);
  assert.equal(j.verifier.verified.length, 2, "pre-existing verified results preserved, not duplicated");
  assert.equal(j.verifier.inconclusive.length, 1);
  assert.ok(j.verifier.verified.includes(refs[0]) && j.verifier.verified.includes(refs[1]));
});

// Invalid stored progress must be a hard 500, never a silent reset —
// the KV copy stays intact for inspection.
test("DO migration: invalid stored progress is a hard 500, never a silent reset", async () => {
  const { saveJob } = await import("../src/store.mjs");
  const env = makeEnv("");
  const bad = { id: "do-bad", status: "running", events: [], references: ["A, A. (2020). T. J."], next_stage: 2,
    verifier_progress: { order: [0], pos: 5, verified: [], flagged: [], ambiguous: [], inconclusive: [] },
    verifier_incomplete: true, updatedAt: Date.now() };
  await saveJob(env, bad);
  const stub = env.JOB_OBJECTS.get("do-bad");
  const res = await stub.fetch(new Request("http://do/state?id=do-bad"));
  assert.equal(res.status, 500);
});

// P6 mandatory package (2026-11-02): whitelist labels, per-term
// diagnostics, citation-trail journal venues, OpenAlex key wrapper.
test("P6 whitelist: inconclusive strengthening candidates are dropped and counted", async () => {
  const { searchStrengthening } = await import("../src/strengthening.mjs");
  const okSearch = { ok: true, status: 200, json: async () => ({ results: [{ title: "Some theory work", doi: "https://doi.org/10.1234/rate-limited", authorships: [], publication_year: 2021, primary_location: { source: { display_name: "Some Journal" } } }] }) };
  // Case 1: Crossref 429 on re-verification -> inconclusive -> dropped, never shown.
  const fetch429 = async (url) => {
    if (String(url).includes("api.openalex.org")) return okSearch;
    return { ok: false, status: 429, json: async () => ({}) };
  };
  const r1 = await searchStrengthening(["Some theory framework"], fetch429);
  assert.equal(r1.recommendations.length, 0);
  assert.equal(r1.dropped_inconclusive, 1);
  assert.equal(r1.per_term[0].search_status, "ok");
  assert.equal(r1.per_term[0].dropped_inconclusive, 1);
  // Case 2: Crossref 200 -> verified -> shown with the verified label.
  const fetchOk = async (url) => {
    if (String(url).includes("api.openalex.org")) return okSearch;
    return { ok: true, status: 200, json: async () => ({ message: { title: ["Some theory work"], author: [{ family: "Test", given: "A" }], published: { "date-parts": [[2021]] }, "container-title": ["Some Journal"] } }) };
  };
  const r2 = await searchStrengthening(["Some theory framework"], fetchOk);
  assert.equal(r2.recommendations.length, 1);
  assert.equal(r2.recommendations[0].verification, "verified");
  assert.equal(r2.per_term[0].kept_verified, 1);
});

test("P6 diagnostics: OpenAlex search 429 is recorded as rate_limited, not silent", async () => {
  const { searchStrengthening } = await import("../src/strengthening.mjs");
  const fetch429 = async () => ({ ok: false, status: 429, json: async () => ({}) });
  const r = await searchStrengthening(["Some theory framework"], fetch429);
  assert.equal(r.recommendations.length, 0);
  assert.equal(r.per_term[0].search_status, "rate_limited");
  assert.equal(r.per_term[0].http_status, 429);
  assert.equal(r.per_term[0].raw_results, 0);
  assert.equal(r.terms_considered, 1);
});

test("P6 journal venue: threshold 2 names a journal, below threshold only fields", async () => {
  const { buildVenueRecommendations } = await import("../src/journal-evidence.mjs");
  const venues = [
    { journal: "MIS Quarterly", doi: "10.1234/a", reference: "Davis, 1989." },
    { journal: "MIS Quarterly", doi: "10.1234/b", reference: "Venkatesh, 2003." },
    { journal: "Other Journal", doi: "10.1234/c", reference: "Patel, 2018." },
  ];
  const v = await buildVenueRecommendations(venues, [{ name: "Information Systems" }]);
  assert.equal(v.recommendations.length, 1);
  assert.equal(v.recommendations[0].journal, "MIS Quarterly");
  assert.equal(v.recommendations[0].verification, "citation-trail");
  assert.equal(v.recommendations[0].scopus_indexed_status, "unverified");
  assert.ok(v.recommendations[0].evidence.includes("2 dari 3"));
  assert.equal(v.diagnostics.threshold, 2);
  assert.equal(v.diagnostics.field_search.status, "skipped");
  const v2 = await buildVenueRecommendations([{ journal: "Solo Journal", doi: "10.1234/x", reference: "Solo, 2020." }], [{ name: "Field" }]);
  assert.equal(v2.recommendations.length, 0);
  assert.equal(v2.diagnostics.venues_found[0].count, 1);
});

test("P6 OpenAlex key wrapper: api_key only on api.openalex.org", async () => {
  const { withOpenAlexKey } = await import("../src/database.mjs");
  const seen = [];
  const base = async (url) => { seen.push(String(url)); return { ok: true }; };
  const wrapped = withOpenAlexKey(base, "test-key-123");
  await wrapped("https://api.openalex.org/works?search=test");
  await wrapped("https://api.crossref.org/works/10.1234/x");
  assert.ok(seen[0].includes("api_key=test-key-123"));
  assert.ok(!seen[1].includes("api_key"));
  const plain = withOpenAlexKey(base, "");
  assert.equal(plain, base);
});

test("P6 export carries strengthening and journal diagnostics", async () => {
  const { buildReport } = await import("../src/export.mjs");
  const report = buildReport({ id: "t", status: "done", confirmed: false, supervisor: { diagnostic: [], fixes: [] }, result: {}, journal_recommendations: [], journal_diagnostics: { source: "citation-trail", threshold: 2 }, strengthening: { recommendations: [], terms_considered: 8, searched_terms: ["A"], per_term: [{ term: "A", search_status: "rate_limited" }], dropped_unresolved: 0, dropped_inconclusive: 0 } });
  assert.equal(report.strengthening_diagnostics.searched_terms[0], "A");
  assert.equal(report.strengthening_diagnostics.per_term[0].search_status, "rate_limited");
  assert.equal(report.journal_diagnostics.source, "citation-trail");
  assert.ok(report.recommendation_notes.join(" ").includes("verified enough"));
});
