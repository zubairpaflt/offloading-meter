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
 * - segment_summaries: 1-2 sentence summary per segment
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
 * Prompt rubric (tightened):
 * measure observable cognitive participation in thinking,
 * not interaction quantity, persistence, or formatting activity.
 */
const RUBRIC = `
You are scoring USER cognitive engagement in a human-AI chat using 7 dimensions (R,K,M,C,I,G,D).
Cognitive engagement = observable participation in thinking (reasoning, reflection, evaluation, integration, knowledge use)
during interaction. Interaction quantity alone is NOT engagement.

IMPORTANT:
- Do NOT infer cognition from politeness, verbosity, persistence, repeated refinement, or topic continuity.
- Formatting, rewriting, summarizing, simplifying, or style-control requests alone are LOW cognitive engagement unless the user
  explicitly demonstrates conceptual reasoning/evaluation/integration in the same turn.

Tag definitions:
- operational: formatting/rewrite/summarize/simplify/style/output-generation/delegation WITHOUT explicit conceptual reasoning.
  Examples: "define", "what is ...", "explain", "easy words", "short", "one line", "rewrite", "summarize", "main points",
  "convert to bullets", "change tone", "translate".
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
R (Reasoning): 0 none; 0.5 explicit causal/comparative reasoning; 1 multi-step explicit reasoning with steps.
K (Knowledge): 0 none; 0.5 user provides relevant facts/examples; 1 rich, specific domain input shaping the direction/output.
M (Metacognition): 0 none; 0.5 explicit self-monitoring ("I'm confused because...", "my assumption was...", "I changed my view because...");
                 1 sustained reflective monitoring with explicit rationale. NOTE: simple revisions/rewrites without reflection are NOT metacognition.
C (Critical eval): 0 none; 0.5 asks evidence/limits OR points flaw; 1 strong critique + alternatives/testing criteria.
I (Initiative): 0 reactive; 0.5 conceptually leads with subquestions/criteria/goals; 1 consistently sets conceptual agenda + evaluation frame.
               NOTE: formatting/stylistic constraints alone are NOT initiative.
G (Integration): 0 isolated request; 0.5 combines/compares concepts; 1 coherent synthesis/framework across turns.
D (Dependency): 0 minimal delegation; 0.5 balanced; 1 strong delegation ("do it all") with little conceptual contribution.
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

function normText(s: string) {
  return (s ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

// --------------------------------------------------
// Deterministic operational detection (robust)
// --------------------------------------------------

const OPERATIONAL_PATTERNS: RegExp[] = [
  /^(define|definition of)\b/,
  /^what is\b/,
  /^whats\b/,
  /^meaning of\b/,
  /^explain\b/,
  /^tell me\b/,

  /\bsummarize\b/,
  /\bsummary\b/,
  /\bshort(en)?\b/,
  /\bconcise\b/,
  /\bone line\b/,
  /\bone-liner\b/,
  /\bmain points?\b/,
  /\bkey points?\b/,
  /\bbullets?\b/,
  /\bconvert to\b.*\b(bullets?|points?)\b/,
  /\brewrite\b/,
  /\bre-?write\b/,
  /\brephrase\b/,
  /\bparaphrase\b/,
  /\bsimplif(y|ication)\b/,
  /\beasy (words|language)\b/,
  /\bin easy (words|language)\b/,
  /\bmake it easy\b/,
  /\bmake it simpler\b/,
  /\bmake it clear(er)?\b/,

  /\bgrammar\b/,
  /\bfix\b.*\bgrammar\b/,
  /\bcorrect\b/,
  /\bpolish\b/,
  /\bproofread\b/,
  /\btone\b/,
  /\bstyle\b/,
  /\bformal\b/,
  /\binformal\b/,
  /\bprofessional\b/,

  /\btranslate\b/
];

// Conceptual markers (explicit cognitive evidence)
const CONCEPTUAL_MARKERS: RegExp[] = [
  /\bwhy\b/,
  /\bhow\b/,
  /\bbecause\b/,
  /\btherefore\b/,
  /\bmechanism\b/,
  /\bcause\b/,
  /\beffect\b/,
  /\bcompare\b/,
  /\bcontrast\b/,
  /\bdifference\b/,
  /\bsimilar(ity)?\b/,
  /\bimplication(s)?\b/,
  /\blimitation(s)?\b/,
  /\bevidence\b/,
  /\bvalid(ity)?\b/,
  /\breliab(le|ility)\b/,
  /\bcritique\b/,
  /\bevaluate\b/,
  /\btest\b/,
  /\bhypothesis\b/,
  /\bassumption\b/,
  /\bwhat if\b/,
  /\bi think\b/,
  /\bi believe\b/,
  /\bi suspect\b/,
  /\bi’m confused\b|\bi am confused\b|\bconfused\b/,
  /\bdoes that mean\b/,
  /\bis that reasonable\b/,
  /\bis this correct\b/,
  /\btrade-?off\b/
];

function countMatches(text: string, patterns: RegExp[]) {
  let c = 0;
  for (const p of patterns) if (p.test(text)) c++;
  return c;
}

/**
 * Conservative tag classifier:
 * - operational: obvious define/short/easy/rewrite/format turns
 * - mixed: both operational + conceptual cues
 * - conceptual: conceptual cues and no operational cues
 */
function classifyTurn(textRaw: string): {
  forcedTag: "operational" | "conceptual" | "mixed";
  formattingOnly: boolean;
} {
  const t = normText(textRaw);
  if (!t) return { forcedTag: "operational", formattingOnly: true };

  const opHits = countMatches(t, OPERATIONAL_PATTERNS);
  const conHits = countMatches(t, CONCEPTUAL_MARKERS);

  const hasQuestion = t.includes("?");
  const isShort = t.length <= 80;

  const formattingOnly =
    opHits > 0 &&
    conHits === 0 &&
    (isShort || !hasQuestion);

  const forcedOperational =
    formattingOnly ||
    (opHits > 0 && conHits === 0 && isShort) ||
    (/^(define|what is|explain)\b/.test(t) && conHits === 0);

  const forcedMixed = opHits > 0 && conHits > 0;
  const forcedConceptual = conHits > 0 && opHits === 0;

  if (forcedOperational) return { forcedTag: "operational", formattingOnly };
  if (forcedMixed) return { forcedTag: "mixed", formattingOnly: false };
  if (forcedConceptual) return { forcedTag: "conceptual", formattingOnly: false };

  return { forcedTag: "operational", formattingOnly: false };
}

// --------------------------------------------------
// Question-depth signals (feeds existing 7 dims)
// --------------------------------------------------

const QUESTION_DEPTH_PATTERNS = {
  retrieval: [
    /^(what is|whats)\b/,
    /^\bdefine\b/,
    /\bdefinition of\b/,
    /\bmeaning of\b/,
    /\blist\b/,
    /\bname\b/
  ],
  causal: [
    /\bwhy\b/,
    /\bwhat causes\b/,
    /\bcauses of\b/,
    /\bhow does\b/,
    /\bmechanism\b/,
    /\bbecause\b/
  ],
  analytical: [
    /\bcompare\b/,
    /\bcontrast\b/,
    /\bdifference\b/,
    /\bevaluate\b/,
    /\bcritique\b/,
    /\bpros and cons\b/,
    /\blimitations?\b/
  ],
  integrative: [
    /\binteract\b/,
    /\bintegrat(e|ion)\b/,
    /\bcombine\b/,
    /\brelationship\b/,
    /\bhow are\b.*\brelated\b/,
    /\bconnection\b/
  ],
  reflective: [
    /\bi think\b/,
    /\bi wonder\b/,
    /\bi suspect\b/,
    /\bis that reasonable\b/,
    /\bdoes that mean\b/,
    /\bi am confused\b/,
    /\bi’m confused\b/
  ],
  applied: [
    /\bhow can\b/,
    /\bhow should\b/,
    /\bwhat should\b/,
    /\bhow do we\b/,
    /\bmanage\b/,
    /\bsolution\b/,
    /\bintervention\b/
  ]
};

function detectQuestionDepth(textRaw: string) {
  const t = normText(textRaw);
  const retrieval = countMatches(t, QUESTION_DEPTH_PATTERNS.retrieval);
  const causal = countMatches(t, QUESTION_DEPTH_PATTERNS.causal);
  const analytical = countMatches(t, QUESTION_DEPTH_PATTERNS.analytical);
  const integrative = countMatches(t, QUESTION_DEPTH_PATTERNS.integrative);
  const reflective = countMatches(t, QUESTION_DEPTH_PATTERNS.reflective);
  const applied = countMatches(t, QUESTION_DEPTH_PATTERNS.applied);
  return { retrieval, causal, analytical, integrative, reflective, applied };
}

/**
 * Deterministic enforcement:
 * - override tags for easy-to-detect operational turns
 * - apply hard caps on operational turns
 * - incorporate question-depth signals into existing dims (R/C/G/M/I)
 * - recompute conceptual_share from final tags
 */
function applyOperationalSuppression(out: ModelScoreOutput, turns: Turn[]) {
  const userTextById = buildUserTurnTextMap(turns);

  for (const ts of out.turn_scores) {
    const rawText = userTextById.get(ts.turnId) ?? "";
    const cls = classifyTurn(rawText);
    const qd = detectQuestionDepth(rawText);

    ts.tag = cls.forcedTag;

    // Bound everything
    ts.dims.R = clamp01(ts.dims.R);
    ts.dims.K = clamp01(ts.dims.K);
    ts.dims.M = clamp01(ts.dims.M);
    ts.dims.C = clamp01(ts.dims.C);
    ts.dims.I = clamp01(ts.dims.I);
    ts.dims.G = clamp01(ts.dims.G);
    ts.dims.D = clamp01(ts.dims.D);

    // Operational caps (no inflation from formatting)
    if (ts.tag === "operational") {
      ts.dims.R = cap(ts.dims.R, 0.20);
      ts.dims.K = cap(ts.dims.K, 0.20);
      ts.dims.M = cap(ts.dims.M, 0.20);
      ts.dims.C = cap(ts.dims.C, 0.20);
      ts.dims.G = cap(ts.dims.G, 0.20);

      if (cls.formattingOnly) {
        ts.dims.I = cap(ts.dims.I, 0.35);
      }
      // D remains free
      ts.dims.D = clamp01(ts.dims.D);
    }

    // Question-depth enhancement (only if NOT purely operational)
    if (ts.tag !== "operational") {
      if (qd.causal > 0) {
        ts.dims.R = clamp01(ts.dims.R + 0.12);
      }
      if (qd.analytical > 0) {
        ts.dims.R = clamp01(ts.dims.R + 0.10);
        ts.dims.C = clamp01(ts.dims.C + 0.15);
      }
      if (qd.integrative > 0) {
        ts.dims.G = clamp01(ts.dims.G + 0.18);
        ts.dims.R = clamp01(ts.dims.R + 0.08);
      }
      if (qd.reflective > 0) {
        ts.dims.M = clamp01(ts.dims.M + 0.15);
        ts.dims.I = clamp01(ts.dims.I + 0.08);
      }
      if (qd.applied > 0) {
        ts.dims.I = clamp01(ts.dims.I + 0.12);
        ts.dims.R = clamp01(ts.dims.R + 0.08);
      }
    }

    // Prevent retrieval inflation (pure retrieval stays low)
    const isPureRetrieval =
      qd.retrieval > 0 &&
      qd.causal === 0 &&
      qd.analytical === 0 &&
      qd.integrative === 0 &&
      qd.reflective === 0 &&
      qd.applied === 0;

    if (isPureRetrieval) {
      ts.dims.R = cap(ts.dims.R, 0.20);
      ts.dims.C = cap(ts.dims.C, 0.15);
      ts.dims.G = cap(ts.dims.G, 0.15);
      if (ts.tag === "operational") {
        ts.dims.M = cap(ts.dims.M, 0.15);
      }
    }
  }

  // Recompute conceptual_share
  const n = out.turn_scores.length || 1;
  const conceptualCount = out.turn_scores.reduce((acc, t) => {
    if (t.tag === "conceptual") return acc + 1;
    if (t.tag === "mixed") return acc + 0.5;
    return acc;
  }, 0);

  out.conceptual_share = clamp01(conceptualCount / n);
  return out;
}

async function scoreInternal(turns: Turn[], mode: "full" | "meter"): Promise<ModelScoreOutput> {
  const transcript = buildTranscript(turns);

  const header =
    mode === "meter"
      ? `You are producing a LIVE METER PREVIEW for the most recent part of a chat.
Return the same JSON schema, but keep qualitative_summary short (2-4 sentences) focused on the window only.`
      : `You are scoring USER engagement in a human-AI chat session using 7 dimensions (R,K,M,C,I,G,D).
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
4) qualitative_summary: 4-7 sentences summarizing engagement pattern for the whole session.
   - must be session-based (not trait-based)
   - must align with the eventual numeric band (low/moderate/high)
5) segment_summaries: 1-2 sentences per segment describing engagement in that segment.
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

  return applyOperationalSuppression(parsed, turns);
}

// Exports required by src/server.ts
export async function scoreWithModel(turns: Turn[]): Promise<ModelScoreOutput> {
  return scoreInternal(turns, "full");
}

export async function scoreWithModelMeter(turns: Turn[]): Promise<ModelScoreOutput> {
  return scoreInternal(turns, "meter");
}