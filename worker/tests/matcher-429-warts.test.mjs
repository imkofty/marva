// 429 wart tests: sentence-initial adverbs must never become authors,
// and possessive citation keys must normalise before matching.
// Live 429 (sweep-9): "interestingly, 2000" false missing + "tan, 2000"
// false uncited (one citation, Tan and Tan 2000, split by the adverb),
// and "mcallister\x92s, 1995" false missing (possessive not normalised).
import test from "node:test";
import assert from "node:assert/strict";
import {
  scanAuthorYearCitations, scanAuthorYearCitationContexts,
} from "../src/reference-parser.mjs";
import { matchAuthorYearKeys, matchCitations } from "../src/citation-matcher.mjs";

// Exact 429 sentence (with the preceding sentence fragment, so the
// precededBySurnameComma condition is reproduced faithfully).
const TAN_SENTENCE =
  "( Yang, 2006 ; Kwantes et al., 2025 ). Interestingly, Tan and Tan (2000) " +
  "found that trust in managers or leaders and trust in organizations are distinct constructs.";
const MCALLISTER_SENTENCE =
  "Regarding trust, we recommend the use of McAllister\u0092s (1995) definition of trust, " +
  "which includes a focus on affective and cognitive elements.";

test("429 wart (a): adverb sentence start yields the true author, not the adverb", () => {
  const cited = scanAuthorYearCitations(TAN_SENTENCE);
  assert.deepEqual(cited, ["yang, 2006", "kwantes, 2025", "tan, 2000"]);
  assert.ok(!cited.includes("interestingly, 2000"));
});

test("429 wart (a): other adverbs, both citation shapes", () => {
  assert.deepEqual(
    scanAuthorYearCitations("Surprisingly, Lee and Kim (2019) showed the opposite."),
    ["lee, 2019"]);
  assert.deepEqual(
    scanAuthorYearCitations("Importantly, Smith, Jones & Lee, 2021 argued for replication."),
    ["smith, 2021"]);
  assert.deepEqual(
    scanAuthorYearCitations("Notably, Garcia et al. (2018) reported a null result."),
    ["garcia, 2018"]);
  assert.deepEqual(
    scanAuthorYearCitations("However, Davis (2020) noted the limitation."),
    ["davis, 2020"]);
});

test("429 wart (a): guardrails — real multi-author lists and word-like surnames intact", () => {
  assert.deepEqual(
    scanAuthorYearCitations("Work builds on Meng, Cheng & Li, 2024 and on Smith, Jones & Lee, 2021."),
    ["meng, 2024", "smith, 2021"]);
  assert.deepEqual(
    scanAuthorYearCitations("Long, Wang & Zhang, 2020 proposed the model."),
    ["long, 2020"]);
});

test("429 wart (a): citation contexts stay identical to the scan", () => {
  const ctx = scanAuthorYearCitationContexts(TAN_SENTENCE);
  assert.deepEqual(ctx.map((c) => c.key), ["yang, 2006", "kwantes, 2025", "tan, 2000"]);
  assert.ok(!ctx.some((c) => c.key === "interestingly, 2000"));
  const tan = ctx.find((c) => c.key === "tan, 2000");
  assert.ok(tan.sentence.includes("Tan and Tan (2000)"));
});

test("429 wart (b): possessive keys match, all three apostrophe variants", () => {
  for (const cited of ["mcallister\u0092s, 1995", "mcallister's, 1995", "mcallister\u2019s, 1995"]) {
    const res = matchAuthorYearKeys([cited], ["mcallister, 1995"]);
    assert.deepEqual(res.missing, [], cited);
    assert.deepEqual(res.uncited, [], cited);
  }
  const two = matchAuthorYearKeys(["mcallister\u0092s & lee, 1995"], ["mcallister & lee, 1995"]);
  assert.deepEqual(two.missing, []);
  assert.deepEqual(two.uncited, []);
  const numeric = matchCitations(["mcallister\u0092s, 1995"], ["mcallister, 1995"]);
  assert.deepEqual(numeric.missing, []);
  assert.deepEqual(numeric.uncited, []);
});

test("429 wart (b): guardrails — O'Kane never merges into Kane, bare -s never stripped", () => {
  const ok = matchAuthorYearKeys(["o\u0092kane, 2012"], ["o\u0092kane, 2012"]);
  assert.deepEqual(ok.missing, []);
  assert.deepEqual(ok.uncited, []);
  const noMerge = matchAuthorYearKeys(["o\u0092kane, 2012"], ["kane, 2012"]);
  assert.deepEqual(noMerge.missing, ["o\u0092kane, 2012"]);
  assert.deepEqual(noMerge.uncited, ["kane, 2012"]);
  const davis = matchAuthorYearKeys(["davis, 2020"], ["davi, 2020"]);
  assert.deepEqual(davis.missing, ["davis, 2020"]);
  assert.deepEqual(davis.uncited, ["davi, 2020"]);
});

test("429 warts end-to-end: both real sentences match, nothing missing or uncited", () => {
  const body = `${TAN_SENTENCE} ${MCALLISTER_SENTENCE}`;
  const cited = scanAuthorYearCitations(body);
  assert.ok(cited.includes("tan, 2000"), JSON.stringify(cited));
  assert.ok(!cited.includes("interestingly, 2000"), JSON.stringify(cited));
  const res = matchAuthorYearKeys(cited, ["tan, 2000", "mcallister, 1995", "yang, 2006", "kwantes, 2025"]);
  assert.deepEqual(res.missing, []);
  assert.deepEqual(res.uncited, []);
});
