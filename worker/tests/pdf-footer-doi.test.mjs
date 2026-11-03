// Footer-DOI fix tests: MDPI page footers glued to reference entries
// must not hand the verifier the HOST paper's DOI.
//
// Proven (papers 336/443, sweep-8, 2026-11-03): the extractor
// concatenates per-page footers into the references zone, and a
// footer landing between two numeric markers is glued to the
// preceding entry. The footer carries the host DOI
// (10.3390/nano16191212 / 10.3390/molecules31203680); MDPI entries
// carry no DOI of their own (only "[ CrossRef ]" links), so the
// verifier's extractDOI (first DOI in the entry text) returned the
// host DOI and Crossref resolved it -> 5 false "verified" per paper,
// and the journal stage named the host journal off that artefact.
// 336/443 pre-fix: 5 DOI entries, all 5 host DOI, 0 genuine DOIs.
// Post-fix both must be 0 host DOI with entry counts unchanged
// (108 / 97); 313 (PeerJ, author-year, 72 genuine per-work DOIs)
// must be byte-identical.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { parseReferences } from "../src/reference-parser.mjs";
import { extractDOI } from "../src/strengthening.mjs";

const HOST_336 = "10.3390/nano16191212";
const OWN = "10.1016/j.joule.2020.01.001";

test("footer shape 1 (DOI + journal + N of M) stripped, host DOI gone", () => {
  const text = `References
1. Smith J. Title one. J Test. 2020, 10, 100-110. [CrossRef] https://doi.org/${HOST_336} Nanomaterials 2026, 16, 1212 30 of 33
2. Jones A. Title two. J Test. 2021, 11, 200-210.`;
  const p = parseReferences(text);
  assert.equal(p.style, "numeric");
  assert.equal(p.count, 2);
  assert.equal(p.entries[0], "1. Smith J. Title one. J Test. 2020, 10, 100-110.");
  assert.equal(extractDOI(p.entries[0]), null);
});

test("footer shape 2 (Disclaimer note + bare host DOI) stripped", () => {
  const text = `References
1. Smith J. Title one. J Test. 2020, 10, 100-110. [CrossRef] [PubMed] Disclaimer/Publisher's Note: The statements, opinions and data contained in all publications are solely those of the individual author(s) and contributor(s) and not of MDPI and/or the editor(s). https://doi.org/${HOST_336}
2. Jones A. Title two. J Test. 2021, 11, 200-210.`;
  const p = parseReferences(text);
  assert.equal(p.count, 2);
  assert.equal(p.entries[0], "1. Smith J. Title one. J Test. 2020, 10, 100-110.");
  assert.equal(extractDOI(p.entries[0]), null);
});

test("genuine entry DOI preserved (never followed by N of M)", () => {
  const text = `References
1. Smith J. Title one. J Test. 2020, 10, 100-110. https://doi.org/${OWN}
2. Jones A. Title two. J Test. 2021, 11, 200-210.`;
  const p = parseReferences(text);
  assert.equal(p.entries[0], `1. Smith J. Title one. J Test. 2020, 10, 100-110. https://doi.org/${OWN}`);
  assert.equal(extractDOI(p.entries[0]), OWN);
});

test("own DOI + glued footer: footer stripped, own DOI kept", () => {
  const text = `References
1. Smith J. Title one. J Test. 2020, 10, 100-110. https://doi.org/${OWN} https://doi.org/${HOST_336} Nanomaterials 2026, 16, 1212 30 of 33
2. Jones A. Title two. J Test. 2021, 11, 200-210.`;
  const p = parseReferences(text);
  assert.equal(p.entries[0], `1. Smith J. Title one. J Test. 2020, 10, 100-110. https://doi.org/${OWN}`);
  assert.equal(extractDOI(p.entries[0]), OWN);
});

test("313 regression: real PeerJ zone parses byte-identical to pre-fix", () => {
  const zone = readFileSync(new URL("./fixtures/refs-313-zone.txt", import.meta.url), "utf8");
  const p = parseReferences(zone);
  assert.equal(p.style, "author-year");
  assert.equal(p.count, 72);
  const hash = createHash("sha256").update(p.entries.join("\n")).digest("hex");
  assert.equal(hash, "a9b589011efa26bcc17ce7aca903ee10bb52ab85d821aee9ca4338487f4ad1b9");
  assert.equal(p.entries.filter((e) => extractDOI(e)).length, 72);
});
