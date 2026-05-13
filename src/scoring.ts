import OpenAI from "openai";
import { Segment, ModelTurnScore, Turn } from "./types.js";

// OpenAI client
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

/**
 * Structured Outputs schema:
 * - segments: topic segments (user turn IDs only)
 * - turn_scores: per USER turn 7 dimensions + tag
 * - conceptual_share: conceptual fraction (mixed counts 0.5)
 * - qualitative_summary: whole-session summary
 * - segment_summaries: 1–2 sentence summary per segment
 */
const SCORE_SCHEMA = {
  name: "offloading_session_score",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["segments", "turn_scores", "conceptual_share", "qualitative_summary", "segment_summaries"],
    properties: {
      segments: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["segmentId", "label", "turnIds"],
          properties: {
            segmentId: { type: "string" },
            label: { type: "string" },
            turnIds: { type: "array", items: { type: "string" } }
          }
        }
      },
      segment_summaries: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["segmentId", "summary"],
          properties: {
            segmentId: { type: "string" },
            summary: { type: "string" }
          }
        }
      },
      turn_scores: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["turnId", "tag", "dims"],
          properties: {
            turnId: { type: "string" },
            tag: { type: "string", enum: ["operational", "conceptual", "mixed"] },
            dims: {
              type: "object",
              additionalProperties: false,
              required: ["R", "K", "M", "C", "I", "G", "D"],
              properties: {
                R: { type: "number", minimum: 0, maximum: 1 },
                K: { type: "number", minimum: 0, maximum: 1 },
                M: { type: "number", minimum: 0, maximum: 1 },
                C: { type: "number", minimum: 0, maximum: 1 },
                I: { type: "number", minimum: 0, maximum: 1 },
                G: { type: "number", minimum: 0, maximum: 1 },
                D: { type: "number", minimum: 0, maximum: 1 }
              }
            }
          }
        }
      },
      conceptual_share: { type: "number", minimum: 0, maximum: 1 },
      qualitative_summary: { type: "string" }
    }
  }
} as const;

export type ModelScoreOutput = {
  segments: Segment[];
  segment_summaries: Array<{ segmentId: string; summary: string }>;
  turn_scores: ModelTurnScore[];
  conceptual_share: number;
  qualitative_summary: string;
};

function buildTranscript(turns: Turn[]) {
  return turns.map(t => `[${t.id}] ${t.speaker.toUpperCase()}: ${t.text}`).join("\n");
}

/**
 * -----------------------------
 * Operationalization (tightened)
 * -----------------------------
 * Key principle:
 * We measure observable cognitive participation in thinking,
 * not interaction quantity, persistence, or formatting activity.
 *
 * Operational turns should not inflate R,K,M,C,G.
 */
const RUBRIC = `
You are scoring USER cognitive engagement in a human–AI chat using 7 dimensions (R,K,M,C,I,G,D).
Cognitive engagement = observable participation in thinking (reasoning, reflection, evaluation, integration, knowledge use)
during interaction. Interaction quantity alone is NOT engagement.

IMPORTANT:
- Do NOT infer cognition from politeness, verbosity, persistence, repeated refinement, or topic continuity.
- Formatting, rewriting, summarizing, simplifying, or style-control requests alone are LOW cognitive engagement unless the user
  explicitly demonstrates conceptual reasoning/evaluation/integration in the same turn.

Tag definitions:
- operational: formatting/rewrite/summarize/simplify/style/output-generation/delegation WITHOUT explicit conceptual reasoning.
  Examples: "define", "explain", "easy words", "short", "one line", "rewrite", "summarize", "main points", "make it concise",
  "write for me", "convert to bullets", "change tone".
- conceptual: explicit cognitive moves (why/how, causal reasoning, implications, limitations, evidence critique, comparison,
  integration/synthesis, hypothesis, reflective confusion, testing alternatives).
- mixed: both operational + conceptual in the same turn.

Suppression rules (hard constraints you must follow):
- If tag = operational, do NOT inflate R,K,M,C,G unless the user text explicitly contains those cognitive moves.
  Operational turns normally keep: R,K,M,C,G <= 0.20
- If the turn is formatting-only (style/length/format edits with no conceptual content), keep Initiative low:
  formatting-only normally keeps: I <= 0.35
- D (Dependency) may be HIGH on operational turns if the user is delegating work.

Scoring rubric (0..1):
R (Reasoning): 0 none; .5 explicit causal/comparative reasoning; 1 multi-step explicit reasoning with steps.
K (Knowledge): 0 none; .5 user provides relevant facts/examples; 1 rich, specific domain input shaping the direction/output.
M (Metacognition): 0 none; .5 explicit self-monitoring ("I'm confused because...", "my assumption was...", "I changed my view because...");
                 1 sustained reflective monitoring with explicit rationale. NOTE: simple revisions/rewrites without reflection are NOT metacognition.
C (Critical eval): 0 none; .5 asks evidence/limits OR points flaw; 1 strong critique + alternatives/testing criteria.
I (Initiative): 0 reactive; .5 conceptually leads with subquestions/criteria/goals; 1 consistently sets conceptual agenda + evaluation frame.
               NOTE: formatting/stylistic constraints alone are NOT initiative.
G (Integration): 0 isolated request; .5 combines/compares concepts; 1 coherent synthesis/framework across turns.
D (Dependency): 0 minimal delegation; .5 balanced; 1 strong delegation ("do it all") with little conceptual contribution.
`.trim();

function clamp01(x: number) {
  if (Number.isNaN(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

function cap(x: number, max: number) {
  return Math.min(clamp01(x), max);
}

function buildUserTurnTextMap(turns: Turn[]) {
  const map = new Map<string, string>();
  for (const t of turns) {
    if (t.speaker.toLowerCase() === "user") map.set(t.id, t.text ?? "");
  }
  return map;
}

/**
 * Heuristic detector for "formatting-only" operational turns.
 * Goal: only used to APPLY caps / tag correction (never to inflate).
 */
function isFormattingOnly(textRaw: string) {
  const text = (textRaw ?? "").toLowerCase().trim();

  // Common operational/formatting directives
  const formattingSignals = [
    "rewrite", "re-write", "rephrase", "paraphrase", "summarize", "summary",
    "short", "shorten", "concise", "one line", "one-line", "bullet", "bullets",
    "points", "main points", "key points", "easy", "simplify", "simple words",
    "in easy words", "format", "formatting", "tone", "style", "grammar",
    "fix", "correct", "polish", "improve wording", "make it clear", "clearer",
    "make it professional", "make it formal", "make it informal",
    "translate", "definition", "define", "what is"
  ];

  // Markers of conceptual cognition (if present, it's not formatting-only)
  const conceptualMarkers = [
    "why", "how", "because", "therefore", "cause", "causal", "mechanism",
    "compare", "contrast", "difference", "similar", "implication", "tradeoff",
    "limitation", "evidence", "study", "research", "prove", "test", "hypothesis",
    "assumption", "critique", "evaluate", "valid", "reliable",
    "i think", "i believe", "i guess", "i'm confused", "i am confused",
    "my confusion", "does it mean", "what if"
  ];

  const hasFormatting = formattingSignals.some(s => text.includes(s));
  const hasConceptual = conceptualMarkers.some(s => text.includes(s));

  // If the turn is very short and contains formatting signals, treat as formatting-only.
  const veryShort = text.length <= 60;

  return hasFormatting && !hasConceptual && (veryShort || !/[?]/.test(text));
}

/**
 * Enforce your psychological constraints deterministically.
 * - Prevent operational turns from inflating R/K/M/C/G
 * - Cap I for formatting-only turns
 * - Optionally correct tag to "operational" when the text is clearly formatting-only
 */
function applyOperationalSuppression(out: ModelScoreOutput, turns: Turn[]) {
  const userTextById = buildUserTurnTextMap(turns);

  for (const ts of out.turn_scores) {
    const rawText = userTextById.get(ts.turnId) ?? "";
    const formattingOnly = isFormattingOnly(rawText);

    // If the model mis-tagged a clearly formatting-only turn, fix tag to operational.
    if (formattingOnly && ts.tag !== "operational") {
      ts.tag = "operational";
    }

    // Apply caps based on tag + formatting-only
    if (ts.tag === "operational") {
      ts.dims.R = cap(ts.dims.R, 0.20);
      ts.dims.K = cap(ts.dims.K, 0.20);
      ts.dims.M = cap(ts.dims.M, 0.20);
      ts.dims.C = cap(ts.dims.C, 0.20);
      ts.dims.G = cap(ts.dims.G, 0.20);

      if (formattingOnly) {
        ts.dims.I = cap(ts.dims.I, 0.35);
      } else {
        ts.dims.I = clamp01(ts.dims.I);
      }

      // D is allowed to remain high on operational turns (delegation).
      ts.dims.D = clamp01(ts.dims.D);
    } else {
      // Always keep values within [0,1]
      ts.dims.R = clamp01(ts.dims.R);
      ts.dims.K = clamp01(ts.dims.K);
      ts.dims.M = clamp01(ts.dims.M);
      ts.dims.C = clamp01(ts.dims.C);
      ts.dims.I = clamp01(ts.dims.I);
      ts.dims.G = clamp01(ts.dims.G);
      ts.dims.D = clamp01(ts.dims.D);
    }
  }

  // Recompute conceptual_share after any tag corrections
  const userTurns = out.turn_scores.length || 1;
  const conceptualCount =
    out.turn_scores.reduce((acc, t) => {
      if (t.tag === "conceptual") return acc + 1;
      if (t.tag === "mixed") return acc + 0.5;
      return acc;
    }, 0);

  out.conceptual_share = clamp01(conceptualCount / userTurns);

  return out;
}

async function scoreInternal(turns: Turn[], mode: "full" | "meter"): Promise<ModelScoreOutput> {
  const transcript = buildTranscript(turns);

  const header =
    mode === "meter"
      ? `You are producing a LIVE METER PREVIEW for the most recent part of a chat.
Return the same JSON schema, but keep qualitative_summary short (2–4 sentences) focused on the window only.`
      : `You are scoring USER engagement in a human–AI chat session using 7 dimensions (R,K,M,C,I,G,D).
Score ONLY USER turns.`;

  const tasks =
    mode === "meter"
      ? ""
      : `
Tasks:
1) Segment the session into coherent topic segments. Unrelated topics MUST be separate segments.
   - segments[].turnIds MUST include only USER turn IDs.
2) For each USER turn, output dims (0..1) and tag (operational/conceptual/mixed).
3) conceptual_share = fraction of USER turns that are conceptual (mixed counts as 0.5).
4) qualitative_summary: 4–7 sentences summarizing engagement pattern for the whole session.
   - must be session-based (not trait-based)
   - must align with the eventual numeric band (low/moderate/high)
5) segment_summaries: 1–2 sentences per segment describing engagement in that segment.
`.trim();

  const prompt = `
${header}

${tasks}

${RUBRIC}

Transcript${mode === "meter" ? " window" : ""}:
${transcript}
`.trim();

  const resp = await client.responses.create({
    model: process.env.SCORER_MODEL ?? "gpt-4.1-mini",
    input: prompt,
    text: {
      format: {
        type: "json_schema",
        name: SCORE_SCHEMA.name,
        schema: SCORE_SCHEMA.schema,
        strict: true
      }
    }
  } as any);

  const outText = (resp as any).output_text ?? "";
  const parsed = JSON.parse(outText) as ModelScoreOutput;

  // Deterministic psychological enforcement layer (pre-math cleanup)
  return applyOperationalSuppression(parsed, turns);
}

export async function scoreWithModel(turns: Turn[]): Promise<ModelScoreOutput> {
  return scoreInternal(turns, "full");
}

export async function scoreWithModelMeter(turns: Turn[]): Promise<ModelScoreOutput> {
  return scoreInternal(turns, "meter");
}