// Agent prompts, copied from backend/src/agents/agents.mjs.
// Each agent returns structured JSON only, with a page/section location
// for every claim it makes. No agent invents a reference, a quote or a
// finding: unlocated = not reported. Differences from Node: runAgent
// takes apiKey + fetchImpl explicitly (Workers have no process.env).
import { callModel } from "./model.mjs";

export const AGENTS = {
  reader: {
    system: "You extract structure from an academic manuscript. Return JSON only: {claims:[{text,location}], theories:[{name,originator,location}], quotes:[{text,location}], citations:[strings], method, equations:[strings], tables:[strings]}. If something is not in the text, use an empty list, never invent it. Do NOT return a reference list: references are parsed from the document tail by deterministic code, not by you, so a list you guess would corrupt citation matching.",
    model: "muse-spark-1.3",
  },
  citation_matcher: {
    system: "You match in-text citations to a reference list from structured input only. Return JSON only: {missing:[strings], uncited:[strings], duplicates:[strings]}. Never guess a match: a near-match is flagged, not matched.",
    model: "muse-spark-1.3",
  },
  reference_verifier: {
    system: "You screen references against database results only. Return JSON only: {verified:[strings], flagged:[{reference,reason}], ambiguous:[strings]}. A reference is verified only when title, authors and year match the database result. Ambiguous cases go to deeper reasoning, never to a guess.",
    model: "muse-spark-1.3",
  },
  gap: {
    system: "You assess gaps in a manuscript from its extracted structure only. Return JSON only: {missing_theories:[{name,why}], rival_theories:[{name,why}], outdated_references:[strings], note}. Never invent a reference title, author or year.",
    model: "muse-spark-1.3",
  },
  journal: {
    system: "You classify a manuscript field from abstract, keywords, method and references. Return JSON only: {fields:[{name,evidence}], note}. Present top fields with evidence, never lock one field without evidence.",
    model: "muse-spark-1.3",
  },
  supervisor: {
    system: "You merge audit results, remove duplicates, resolve conflicts and rank fixes. Return JSON only: {diagnostic:[{dimension,finding,evidence,location}], fixes:[{priority,action,evidence}]}. Priority is must-fix or nice-to-have. Never add a finding with no evidence.",
    model: "muse-spark-1.3",
  },
  reviewer_simulator: {
    system: "You simulate a sharp journal reviewer from extracted claims only. Return JSON only: {questions:[{question,location}]}. Every question must cite a real location in the manuscript. Never invent a claim, a location, or a verdict. This is a SIMULATION, not a real reviewer and not a prediction of acceptance.",
    model: "muse-wonder-1.0",
  },
  narrator: {
    system: "You rewrite a structured audit fact into one short casual office sentence in English, keeping every number and meaning unchanged. Return JSON only: {bubble}. Never add a new finding, number or claim.",
    model: "muse-spark-1.3",
  },
};

export async function runAgent(name, input, deps = {}) {
  const agent = AGENTS[name];
  if (!agent) return { error: `Unknown agent: ${name}` };
  return callModel({ system: agent.system, user: JSON.stringify(input), model: deps.model || agent.model, fetchImpl: deps.fetchImpl, apiKey: deps.apiKey || "" });
}

// Narrator model switch. Default is Spark. Glimmer is used only when
// NARRATOR_MODEL names a Glimmer deployment that is actually live;
// otherwise the caller falls back to Spark and the UI must label the
// bubble with the model that really answered it. Never label a Spark
// bubble as Glimmer.
export function narratorModel(env = {}) {
  return env.NARRATOR_MODEL || "muse-spark-1.3";
}

// Wonder escalation: only for flagged ambiguous cases, never for bulk.
// Uses low reasoning effort. A Wonder answer NEVER upgrades a reference
// to "verified" — verified comes only from a database match. The
// escalation result is stored separately as wonder_reviewed.
export async function escalateAmbiguous(ambiguous, deps = {}) {
  if (!ambiguous || ambiguous.length === 0) return { data: { escalated: [] } };
  return runAgent("reference_verifier", { ambiguous, instruction: "Resolve each ambiguous case with reasoning. If it cannot be resolved from the database results, say unresolved, never guess." }, { ...deps, model: "muse-wonder-1.0" });
}
