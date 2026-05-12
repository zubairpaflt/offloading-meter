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
              required: ["R","K","M","C","I","G","D"],
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

// Rubric anchors included in prompt for stability
const RUBRIC = `
Scoring rubric (0..1):

R (Reasoning): 0 none; .5 some causal/comparative reasoning; 1 multi-step explicit reasoning.
K (Knowledge): 0 none; .5 relevant facts/examples; 1 rich, specific domain input shaping output.
M (Metacognition): 0 none; .5 identifies weakness + rationale; 1 sustained self-monitoring/revisions with justification.
C (Critical eval): 0 none; .5 asks evidence/limits or points flaw; 1 strong critique + alternatives/testing.
I (Initiative): 0 reactive; .5 clear constraints/subquestions; 1 consistently leads agenda and evaluation criteria.
G (Integration): 0 isolated request; .5 asks to combine/compare; 1 coherent framework/model synthesis across turns.
D (Dependency): 0 minimal delegation; .5 balanced; 1 extreme “do everything” delegation with few constraints.

Tag:
- operational: rewrite/shorten/format/style
- conceptual: why/how/limitations/compare/synthesize/build model
- mixed: both
`.trim();

export async function scoreWithModel(turns: Turn[]): Promise<ModelScoreOutput> {
  const transcript = buildTranscript(turns);

  const prompt = `
You are scoring USER engagement in a human–AI chat session using 7 dimensions (R,K,M,C,I,G,D).
Score ONLY USER turns.

Tasks:
1) Segment the session into coherent topic segments. Unrelated topics MUST be separate segments.
   - segments[].turnIds MUST include only USER turn IDs.
2) For each USER turn, output dims (0..1) and tag (operational/conceptual/mixed).
3) conceptual_share = fraction of USER turns that are conceptual (mixed counts as 0.5).
4) qualitative_summary: 4–7 sentences summarizing engagement pattern for the whole session.
   - must be session-based (not trait-based)
   - must align with the eventual numeric band (low/moderate/high)
5) segment_summaries: 1–2 sentences per segment describing engagement in that segment.

${RUBRIC}

Transcript:
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
  return JSON.parse(outText);
}

export async function scoreWithModelMeter(turns: Turn[]): Promise<ModelScoreOutput> {
  const transcript = buildTranscript(turns);

  const prompt = `
You are producing a LIVE METER PREVIEW for the most recent part of a chat.
Return the same JSON schema, but keep qualitative_summary short (2–4 sentences) focused on the window only.

${RUBRIC}

Transcript window:
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
  return JSON.parse(outText);
}