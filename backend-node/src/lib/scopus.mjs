// Scopus Sources integration point — honest version.
// A journal is reported Scopus-indexed ONLY when the Elsevier Scopus
// API, called with a real SCOPUS_API_KEY from env, actually returns a
// matching serial record. In every other case the status stays
// "unverified" and no network call is made. No key is ever stored in
// code, and no journal is ever labelled indexed on a guess.
// Elsevier endpoint used: GET https://api.elsevier.com/content/serial/title
// with header X-ELS-APIKey. This call needs a Scopus subscription key;
// without one the integration point exists but reports unverified.
export async function checkScopusJournal(journalName, fetchImpl = fetch) {
  if (!journalName) return { scopus_indexed_status: "unverified", reason: "No journal name" };
  const apiKey = process.env.SCOPUS_API_KEY;
  if (!apiKey) return { scopus_indexed_status: "unverified", reason: "SCOPUS_API_KEY not set" };
  try {
    const url = `https://api.elsevier.com/content/serial/title?title=${encodeURIComponent(journalName)}`;
    const res = await fetchImpl(url, { headers: { Accept: "application/json", "X-ELS-APIKey": apiKey } });
    if (!res.ok) return { scopus_indexed_status: "unverified", reason: `Scopus API ${res.status}` };
    const data = await res.json();
    const entries = data?.["serial-metadata-response"]?.entry || [];
    const match = entries.find((e) => {
      const t = (e?.["dc:title"] || "").toLowerCase();
      return t && journalName.toLowerCase().includes(t) || t.includes(journalName.toLowerCase());
    });
    if (!match) return { scopus_indexed_status: "unverified", reason: "No matching serial record returned by Scopus API" };
    return {
      scopus_indexed_status: "indexed",
      source: "scopus",
      title: match["dc:title"] || null,
      issn: match["prism:issn"] || null,
      publisher: match["dc:publisher"] || null,
    };
  } catch (e) {
    return { scopus_indexed_status: "unverified", reason: String(e.message || e) };
  }
}
