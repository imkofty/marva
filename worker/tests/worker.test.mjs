// Node test harness for the Worker handler.
// NOT a Workers runtime test: wrangler/miniflare were not available
// in the build VM. Fake KV (Map) + fake global fetch prove the
// handler, stage order, deterministic matcher, demo endpoint, and
// honest no-key behaviour. Real KV, real Workers, and real model /
// database responses are NOT proven here and need the deploy step.
import test from "node:test";
import assert from "node:assert/strict";
import worker, { runJob } from "../src/index.mjs";

class FakeKV {
  constructor() { this.map = new Map(); }
  async get(k) { return this.map.has(k) ? this.map.get(k) : null; }
  async put(k, v) { this.map.set(k, v); }
  async delete(k) { this.map.delete(k); }
}

function makeEnv(apiKey) {
  return { MARVA_JOBS: new FakeKV(), MODEL_API_KEY: apiKey || "" };
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

// Step-wise polling: each GET /events advances one stage, so loop
// until done (max 12 polls, one per stage + margin).
async function pollUntilDone(env, id) {
  for (let i = 0; i < 12; i++) {
    const res = await worker.fetch(new Request(`https://worker.test/jobs/${id}/events`), env, {});
    const body = await res.json();
    if (body.status === "done") return body;
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
