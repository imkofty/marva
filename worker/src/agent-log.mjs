// Agent log format, copied from backend/src/lib/agent-log.mjs.
// Every entry is a real event. A plan, tool call, replan or gate only
// appears when it really happened.
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
