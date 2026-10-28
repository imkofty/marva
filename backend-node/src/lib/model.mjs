// Model caller. Standard mode only, never Contributor.
// Key comes from env only, never from a file, log or repo.
export async function callModel({ system, user, model = "muse-spark-1.3", fetchImpl = fetch }) {
  const apiKey = process.env.MODEL_API_KEY;
  if (!apiKey) return { error: "MODEL_API_KEY not set" };
  const res = await fetchImpl("https://api.meta.ai/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
      response_format: { type: "json_object" },
      temperature: 0,
      ...(model.includes("wonder") ? { reasoning_effort: "low", max_tokens: 15000 } : {}),
    }),
  });
  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content ?? "";
  try { return { data: JSON.parse(text) }; }
  catch { return { error: "Model did not return valid JSON", raw: text.slice(0, 500) }; }
}
