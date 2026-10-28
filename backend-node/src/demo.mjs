// Cached synthetic demo diagnostic, from examples/expected-answers.md.
// This is NOT a model call and needs NO key. It is the one-click demo:
// the frontend can show a complete, honest diagnostic without any
// manuscript upload and without any model cost.
// It describes the SYNTHETIC manuscript only (Ana Pratama / Budi
// Santoso, "A Mobile Checklist for Smallholder Farmers: A Pilot Study").
// Note on finding 2: the deterministic matcher normalises keys, so
// "Patel, 2019" cited vs "Patel, 2018" listed appears in raw matcher
// output as missing + uncited. The demo diagnostic interprets that
// pair as the single wrong-year finding below; the interpretation is
// labelled as such and is not raw matcher output.
export const SYNTHETIC_DEMO = {
  product: "MARVA",
  demo: true,
  synthetic: true,
  note: "Cached synthetic demo. Not a real paper, no model call, no key needed. The manuscript behind this diagnostic is synthetic test data, invented for testing only.",
  manuscript: {
    title: "A Mobile Checklist for Smallholder Farmers: A Pilot Study",
    authors: ["Ana Pratama", "Budi Santoso"],
    synthetic: true,
  },
  citation_flags: {
    missing: ["rahman, 2021"],
    uncited: ["wijaya, 2017"],
    duplicates: [],
    interpretation: "Patel cited as 2019 but listed as 2018 is reported as one wrong-year finding, not as two separate missing/uncited flags.",
  },
  findings: [
    { n: 1, type: "missing_citation", finding: "Rahman, 2021 is cited in the abstract but absent from the reference list." },
    { n: 2, type: "wrong_year", finding: "Patel is cited as 2019 in the text but listed as 2018 in the references." },
    { n: 3, type: "outdated_reference", finding: "Kumar, 2005 on early farm advisory services is outdated for a current mobile-tool study." },
    { n: 4, type: "over_strong_claim", finding: "\"increases yields by 80% for all farmers\" is stronger than a 40-person pilot with questionnaire data only can support." },
    { n: 5, type: "theory_gap", finding: "Diffusion of Innovations is a rival adoption theory that is not discussed." },
    { n: 6, type: "uncited_reference", finding: "Wijaya, 2017 appears in the reference list but is never cited in the text." },
    { n: 7, type: "correct", finding: "Davis, 1989 and Venkatesh, 2003 are correctly cited and listed." },
  ],
  limitations: [
    "MARVA does not guarantee acceptance at any journal.",
    "Unverified references and journals are labelled unverified, never certain.",
    "The author confirms every reference before it enters a bibliography.",
  ],
  ai_disclosure: "This cached demo diagnostic was written from the synthetic manuscript answer key. It is not a live audit of a real manuscript.",
};
