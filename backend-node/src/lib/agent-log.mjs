// Agent log format. Every entry is a real event, shown in SSE and the
// meeting log. No entry is invented: a plan, a tool call, a replan, or
// a human confirmation gate only appears when it really happened.
// This is the Agentic bonus evidence: plan + tools + recovery + gate.
export function planEntry(stages) {
  return { type: "plan", stages, note: "Stages that may run in parallel are marked parallel; the rest are sequential." };
}
export function toolEntry(tool, args, result) {
  return { type: "tool", tool, args, result };
}
export function replanEntry(from, to, reason) {
  return { type: "replan", from, to, reason };
}
export function gateEntry(gate, status) {
  return { type: "gate", gate, status };
}
