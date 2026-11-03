// 328 name-normalisation tests: table citations that spell a surname
// differently from prose + bibliography must reconcile to the same
// work — but only under deterministic rules, never by similarity.
// Live 328 (job cbcdd727): tables cite "Youssef" (bare) where prose
// and the list write "Ben-Youssef", and tables write "Sümer" where
// prose and the list write "Sumer". Both were false missing.
// Guardrails: year must match, ambiguous candidates stay flagged,
// truly different spellings never force-match, and the honest cases
// (thiruthvanathan vs thiruthuvanathan, table-only s-syun) stay
// missing/uncited exactly as before.
import test from "node:test";
import assert from "node:assert/strict";
import { matchAuthorYearKeys } from "../src/citation-matcher.mjs";
import { parseReferences, scanAuthorYearCitations } from "../src/reference-parser.mjs";

test("hyphen: bare table form matches hyphenated list entry", () => {
  const r = matchAuthorYearKeys(["youssef, 2017"], ["ben-youssef, 2017"]);
  assert.deepEqual(r.missing, []);
  assert.deepEqual(r.uncited, []);
});

test("hyphen: hyphenated citation matches bare list entry (symmetric)", () => {
  const r = matchAuthorYearKeys(["ben-youssef, 2019"], ["youssef, 2019"]);
  assert.deepEqual(r.missing, []);
  assert.deepEqual(r.uncited, []);
});

test("diacritic: Sümer matches Sumer", () => {
  const r = matchAuthorYearKeys(["sümer, 2021"], ["sumer, 2021"]);
  assert.deepEqual(r.missing, []);
  assert.deepEqual(r.uncited, []);
});

test("328 variant re-citation, prose-first order: no false missing", () => {
  const r = matchAuthorYearKeys(
    ["ben-youssef, 2017", "youssef, 2017", "sumer, 2021", "sümer, 2021"],
    ["ben-youssef, 2017", "sumer, 2021"],
  );
  assert.deepEqual(r.missing, []);
  assert.deepEqual(r.uncited, []);
});

test("328 variant re-citation, table-first order: order-independent", () => {
  const r = matchAuthorYearKeys(
    ["youssef, 2017", "ben-youssef, 2017", "sümer, 2021", "sumer, 2021"],
    ["ben-youssef, 2017", "sumer, 2021"],
  );
  assert.deepEqual(r.missing, []);
  assert.deepEqual(r.uncited, []);
});

test("ambiguity guard: two hyphenated entries sharing a segment stay flagged", () => {
  const r = matchAuthorYearKeys(
    ["youssef, 2020"], ["ben-youssef, 2020", "al-youssef, 2020"],
  );
  assert.deepEqual(r.missing, ["youssef, 2020"]);
  assert.equal(r.ambiguous.length, 1);
  assert.deepEqual([...r.uncited].sort(), ["al-youssef, 2020", "ben-youssef, 2020"]);
});

test("honest: thiruthvanathan vs thiruthuvanathan never force-matched", () => {
  const r = matchAuthorYearKeys(
    ["thiruthvanathan, 2021"], ["thiruthuvanathan, 2021"],
  );
  assert.deepEqual(r.missing, ["thiruthvanathan, 2021"]);
  assert.deepEqual(r.uncited, ["thiruthuvanathan, 2021"]);
});

test("honest: table-only s-syun stays missing", () => {
  const r = matchAuthorYearKeys(["s-syun, 2012"], ["smith, 2012"]);
  assert.deepEqual(r.missing, ["s-syun, 2012"]);
  assert.deepEqual(r.uncited, ["smith, 2012"]);
});

test("diacritic-distinct list entries: spelled citation still resolves exactly", () => {
  const r = matchAuthorYearKeys(
    ["müller, 2020"], ["müller, 2020", "muller, 2020"],
  );
  assert.deepEqual(r.missing, []);
  assert.deepEqual(r.uncited, ["muller, 2020"]);
});

test("old last-word rule preserved: Souza / Bank", () => {
  assert.deepEqual(matchAuthorYearKeys(["souza, 2020"], ["de souza, 2020"]).missing, []);
  assert.deepEqual(matchAuthorYearKeys(["bank, 2020"], ["world bank, 2020"]).missing, []);
});

test("guardrail: different spelling is not a hyphen variant", () => {
  const r = matchAuthorYearKeys(["youssef, 2017"], ["ben-yousef, 2017"]);
  assert.deepEqual(r.missing, ["youssef, 2017"]);
  assert.deepEqual(r.uncited, ["ben-yousef, 2017"]);
});

test("guardrail: two hyphenated surnames sharing a segment do not match", () => {
  const r = matchAuthorYearKeys(["smith-jones, 2020"], ["brown-jones, 2020"]);
  assert.deepEqual(r.missing, ["smith-jones, 2020"]);
  assert.deepEqual(r.uncited, ["brown-jones, 2020"]);
});

test("guardrail: year must match for hyphen and diacritic rules", () => {
  assert.deepEqual(matchAuthorYearKeys(["youssef, 2018"], ["ben-youssef, 2017"]).missing, ["youssef, 2018"]);
  assert.deepEqual(matchAuthorYearKeys(["sümer, 2022"], ["sumer, 2021"]).missing, ["sümer, 2022"]);
});

test("328-derived full path: real entries + real citation shapes, zero missing", () => {
  const doc = [
    "Ben-Youssef et al. (2017) introduced the UE-HRI dataset.",
    "Sumer et al. (2021) analysed multimodal signals.",
    "Table 3 summarises prior work. (UE-HRI) Youssef et al. (2017) Youssef et al. (2019) Youssef et al. (2021) Sümer et al. (2021)",
    "References",
    "Ben-Youssef, A., Clavel, C., Essid, S., Bilac, M., Chamoux, M. & Lim, A. (2017). UE-HRI: A new dataset for the study of user engagement.",
    "Ben-Youssef, A., Varni, G., Essid, S., & Clavel, C. (2019). On-the-fly detection of user engagement decrease.",
    "Ben-Youssef, A., Clavel, C., & Essid, S. (2021). Early detection of user engagement breakdown.",
    "Sumer, O., Goldberg, P., D'Mello, S., Gerjets, P., Trautwein, U., & Kasneci, E. (2021). Multimodal engagement analysis.",
  ].join("\n");
  const parsed = parseReferences(doc);
  assert.deepEqual(parsed.keys, ["ben-youssef, 2017", "ben-youssef, 2019", "ben-youssef, 2021", "sumer, 2021"]);
  const cited = scanAuthorYearCitations(parsed.body);
  const r = matchAuthorYearKeys(cited, parsed.keys);
  assert.deepEqual(r.missing, []);
  assert.deepEqual(r.uncited, []);
});
