// Model caller, adapted from backend/src/lib/model.mjs for Workers.
// Differences from Node: the key comes from the Worker env argument
// (env.MODEL_API_KEY), NOT from process.env, because Workers have no
// process.env. Standard mode only, never Contributor.
// Key is never logged, never stored in KV, never returned in a response.
export async function callModel({ system, user, model = "muse-spark-1.3", fetchImpl = fetch, apiKey = "" }) {
  if (!apiKey || apiKey === "REPLACE_AT_DEPLOY_VIA_WRANGLER_SECRET") {
    return { error: "MODEL_API_KEY not set" };
  }
  // 60s timeout: a stage must fail honestly, never hang a polling
  // request forever. Workers support AbortSignal.timeout.
  const signal = typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(60000) : undefined;
  let res;
  try {
    res = await fetchImpl("https://api.meta.ai/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      signal,
      body: JSON.stringify({
        model,
        messages: [{ role: "system", content: system }, { role: "user", content: user }],
        response_format: { type: "json_object" },
        temperature: 0,
        ...(model.includes("wonder") ? { reasoning_effort: "low", max_tokens: 15000 } : {}),
      }),
    });
  } catch (e) {
    return { error: `Model call failed: ${String(e.message || e).slice(0, 200)}` };
  }
  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content ?? "";
  try { return { data: JSON.parse(text) }; }
  catch { return { error: "Model did not return valid JSON", raw: text.slice(0, 500) }; }
}
