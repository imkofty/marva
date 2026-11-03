// 2nd-citation fix tests: a narrative citation after prose + "and"
// must not be swallowed by the second-author guard.
// Root cause (proven by span print, NOT the guessed greedy-hyphen
// span): re2 finds BOTH matches (first ends exactly at its year);
// the old isSecondAuthor returned true for ANY surname after &/and
// unless the text immediately before ended with a year, so prose
// ("did X, and") made the new citation look like a co-author.
// The fix narrows the guard to a BARE author list still awaiting
// its year (walk-back over surnames/separators); prose or "et al."
// before &/and means a new citation.
import test from "node:test";
import assert from "node:assert/strict";
import {
  scanAuthorYearCitations, scanAuthorYearCitationContexts,
} from "../src/reference-parser.mjs";

test("2nd citation (1): hyphen-first narrative, two citations one sentence", () => {
  assert.deepEqual(
    scanAuthorYearCitations("Ben-Youssef et al. (2017) introduced the UE-HRI dataset, and Sumer et al. (2021) analysed multimodal signals."),
    ["ben-youssef, 2017", "sumer, 2021"]);
});

test("2nd citation (2): reversed order", () => {
  assert.deepEqual(
    scanAuthorYearCitations("Sumer et al. (2021) analysed multimodal signals, and Ben-Youssef et al. (2017) introduced the UE-HRI dataset."),
    ["sumer, 2021", "ben-youssef, 2017"]);
});

test("2nd citation (3): single hyphen citation, no second", () => {
  assert.deepEqual(
    scanAuthorYearCitations("Ben-Youssef et al. (2017) introduced the UE-HRI dataset."),
    ["ben-youssef, 2017"]);
});

test("2nd citation (4): adverb guard intact (429)", () => {
  const cited = scanAuthorYearCitations("Interestingly, Tan and Tan (2000) found that trust differs.");
  assert.deepEqual(cited, ["tan, 2000"]);
  assert.ok(!cited.includes("interestingly, 2000"));
});

test("2nd citation (5): co-author guards intact", () => {
  // True two-author: second surname is NOT its own citation.
  assert.deepEqual(scanAuthorYearCitations("Serra and Kunc (2015) showed this."), ["serra, 2015"]);
  assert.deepEqual(scanAuthorYearCitations("(Serra & Kunc, 2015) showed this."), ["serra, 2015"]);
  // Three-author list: first author only.
  assert.deepEqual(scanAuthorYearCitations("Meng, Cheng & Li, 2024 proposed this."), ["meng, 2024"]);
  // Year-end exemption: closed citation before "and" starts a new one.
  assert.deepEqual(scanAuthorYearCitations("Venkatesh, 2003 and Davis, 1989 argued this."), ["venkatesh, 2003", "davis, 1989"]);
  assert.deepEqual(scanAuthorYearCitations("Solaiman et al. (2010) and Hammer et al. (2015) argued this."), ["solaiman, 2010", "hammer, 2015"]);
});

test("2nd citation (6): three narrative, hyphen in the middle", () => {
  assert.deepEqual(
    scanAuthorYearCitations("Smith et al. (2017) did A, Jones et al. (2018) did B, and Ben-Youssef et al. (2019) did C."),
    ["smith, 2017", "jones, 2018", "ben-youssef, 2019"]);
});

test("2nd citation: contexts keys match scan keys exactly", () => {
  const s = "Ben-Youssef et al. (2017) introduced the UE-HRI dataset, and Sumer et al. (2021) analysed multimodal signals.";
  const keys = scanAuthorYearCitationContexts(s).map((c) => c.key);
  assert.deepEqual(keys, scanAuthorYearCitations(s));
});

test("2nd citation: real 328 parenthetical group still scans", () => {
  const cited = scanAuthorYearCitations("is algorithm has also been used for performance comparison with other algorithms (Ben-Youssef et al., 2019 ; Sumer et al., 2021 ; Rudovic et al., 2018b ).");
  assert.ok(cited.includes("ben-youssef, 2019"));
  assert.ok(cited.includes("sumer, 2021"));
});

test("2nd citation: damaged first author must not leak a false second-author key (429 mangling)", () => {
  // Extraction destroyed Dielmann's initial ("Dielmann" -> control
  // char -> normalised lowercase "ielmann"). The narrowed guard
  // must still block Hilbig here: Hilbig is never a first author
  // in this paper, so emitting it would be a false missing.
  const mangled = "results are inconsistent. For example, while some found Honesty-Humility to be related to trust ( \x1dielmann and Hilbig, 2015 ; Pfattheicher and B\u00f6hm, 2018 ), others found no relationship.";
  const cited = scanAuthorYearCitations(mangled);
  assert.ok(!cited.includes("hilbig, 2015"));
  assert.ok(cited.includes("pfattheicher, 2018"));
  // Clean form: second author still blocked via the bare-list walk.
  assert.deepEqual(
    scanAuthorYearCitations("Dielmann and Hilbig (2014) proposed this."),
    ["dielmann, 2014"]);
  // Boundary layer, independent of the et-al. gate: even WITH et al.,
  // a damaged-name second author stays blocked.
  const mangledEtAl = "rows show ( \x1dielmann and Hilbig et al. (2014) Psychology German HEXACO-60.";
  assert.ok(!scanAuthorYearCitations(mangledEtAl).includes("hilbig, 2014"));
});
