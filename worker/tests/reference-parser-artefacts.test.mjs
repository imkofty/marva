// Reference-parser artefact guards: dash-glued surnames and bare
// articles must never become author-year keys.
//
// Proven (live audit job b4a9d02f, 2026-11-03): the reference list
// contained a wrapped author list "...; -Snow, N., Henderson, J. V.;"
// which produced key "-snow, 2015", and a title fragment which
// produced key "the, 2026". Both showed up as uncited entries.
// Neither is a real author: the dash is a line-wrap artefact, and
// no author surname is a bare article.
import test from "node:test";
import assert from "node:assert/strict";
import { parseReferences } from "../src/reference-parser.mjs";

test("dash glued to surname is stripped: -Snow becomes snow", () => {
  const text = `References
Elbanna, S., Shepherd, N. G. Title A. J Test. 2015.
-Snow, N., Henderson, J. V. Title B. J Test. 2015.
Jones, A. Title C. J Test. 2016.`;
  const p = parseReferences(text);
  assert.equal(p.style, "author-year");
  assert.ok(p.keys.includes("snow, 2015"));
  assert.ok(!p.keys.some((k) => k.startsWith("-")));
});

test("bare article is never an author: the, 2026 is dropped", () => {
  const text = `References
Smith, J. Title A. J Test. 2020.
the, S. Some title fragment. J Test. 2026.
Jones, A. Title C. J Test. 2021.`;
  const p = parseReferences(text);
  assert.equal(p.count, 2);
  assert.deepEqual([...p.keys].sort(), ["jones, 2021", "smith, 2020"]);
});

test("multi-word org name containing The is kept", () => {
  const text = `References
The World Bank. (2006). Title A.
Smith, J. Title B. J Test. 2020.`;
  const p = parseReferences(text);
  assert.ok(p.keys.includes("the world bank, 2006"));
});

test("hyphen inside a real surname survives", () => {
  const text = `References
Smith-Jones, A. Title A. J Test. 2020.
Jones, B. Title B. J Test. 2021.`;
  const p = parseReferences(text);
  assert.ok(p.keys.includes("smith-jones, 2020"));
});
