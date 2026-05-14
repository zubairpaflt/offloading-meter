import OpenAI from "openai";
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
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
};
function buildTranscript(turns) {
    return turns.map(t => `[${t.id}] ${t.speaker.toUpperCase()}: ${t.text}`).join("\n");
}
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
- conceptual: explicit cognitive moves (why/how, causal reasoning, implications, limitations, evidence critique, comparison,
  integration/synthesis, hypothesis, reflective confusion, testing alternatives).
- mixed: both operational + conceptual in the same turn.

Hard constraints:
- If tag = operational, do NOT inflate R,K,M,C,G unless the transcript explicitly demonstrates those cognitive moves.
  Operational turns normally keep: R,K,M,C,G <= 0.20
- If the turn is formatting-only (style/length/format edits with no conceptual content), keep Initiative low:
  formatting-only normally keeps: I <= 0.35
- D (Dependency) may be HIGH on operational turns if the user is delegating work.
`.trim();
function clamp01(x) {
    if (Number.isNaN(x))
        return 0;
    if (x < 0)
        return 0;
    if (x > 1)
        return 1;
    return x;
}
function cap(x, max) {
    return Math.min(clamp01(x), max);
}
function buildUserTurnTextMap(turns) {
    const map = new Map();
    for (const t of turns) {
        if (t.speaker.toLowerCase() === "user")
            map.set(t.id, t.text ?? "");
    }
    return map;
}
function normText(s) {
    return (s ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}
// Operational patterns
const OPERATIONAL_PATTERNS = [
    /^(define|definition of)\b/,
    /^what is\b/,
    /^whats\b/,
    /^meaning of\b/,
    /^explain\b/,
    /^tell me\b/,
    /\bsummarize\b/,
    /\bshort(en)?\b/,
    /\bconcise\b/,
    /\bone line\b/,
    /\bmain points?\b/,
    /\bkey points?\b/,
    /\bbullets?\b/,
    /\brewrite\b/,
    /\brephrase\b/,
    /\bparaphrase\b/,
    /\bsimplif(y|ication)\b/,
    /\beasy (words|language)\b/,
    /\bmake it easy\b/,
    /\bmake it simpler\b/,
    /\bgrammar\b/,
    /\bproofread\b/,
    /\btone\b/,
    /\bstyle\b/,
    /\btranslate\b/
];
// Conceptual markers (question forms + reasoning cues)
const CONCEPTUAL_MARKERS = [
    /\bwhy\b/,
    /\bhow\b/,
    /\bmechanism\b/,
    /\bcause\b/,
    /\beffect\b/,
    /\btrade[- ]?off\b/,
    /\bcompare\b/,
    /\bcontrast\b/,
    /\bdifference\b/,
    /\bimplication(s)?\b/,
    /\blimitation(s)?\b/,
    /\bevidence\b/,
    /\bcritique\b/,
    /\bevaluate\b/,
    /\bhypothesis\b/,
    /\bassumption\b/,
    /\bwhat if\b/,
    /\bi think\b/,
    /\bi wonder\b/,
    /\bi suspect\b/,
    /\bdoes that mean\b/,
    /\bis that reasonable\b/,
    /\bmy understanding\b/,
    /\bso\b/,
    /\btherefore\b/
];
// NEW: elaboration markers (explicit conceptual processing beyond asking)
const ELABORATION_MARKERS = [
    /\bi think\b/,
    /\bthis means\b/,
    /\bdoes that mean\b/,
    /\bso\b/,
    /\btherefore\b/,
    /\bin other words\b/,
    /\blet me\b/,
    /\bmy understanding\b/,
    /\bif i assume\b/,
    /\bif that assumption\b/,
    /\btest my understanding\b/,
    /\blimitation(s)?\b/,
    /\bevidence\b/,
    /\btrade[- ]?off\b/,
    /\bcounterexample\b/,
    /\bframework\b/,
    /\bloop\b/,
    /\bconnect\b/,
    /\brelationship\b/,
    /\bintegrat(e|ion)\b/
];
function countMatches(text, patterns) {
    let c = 0;
    for (const p of patterns)
        if (p.test(text))
            c++;
    return c;
}
function isQuestionHeavy(textRaw) {
    const t = normText(textRaw);
    if (!t)
        return false;
    const qmarks = (t.match(/\?/g) || []).length;
    const words = t.split(" ").filter(Boolean).length;
    // Mostly question, short-ish, little declarative content
    return qmarks >= 1 && words <= 28;
}
function classifyTurn(textRaw) {
    const t = normText(textRaw);
    if (!t)
        return { forcedTag: "operational", formattingOnly: true, hasElaboration: false, questionHeavy: false };
    const opHits = countMatches(t, OPERATIONAL_PATTERNS);
    const conHits = countMatches(t, CONCEPTUAL_MARKERS);
    const hasElaboration = countMatches(t, ELABORATION_MARKERS) > 0;
    const questionHeavy = isQuestionHeavy(t);
    const hasQuestion = t.includes("?");
    const isShort = t.length <= 80;
    const formattingOnly = opHits > 0 && conHits === 0 && (isShort || !hasQuestion);
    const forcedOperational = formattingOnly ||
        (opHits > 0 && conHits === 0 && isShort) ||
        (/^(define|what is|explain)\b/.test(t) && conHits === 0);
    const forcedMixed = opHits > 0 && conHits > 0;
    // IMPORTANT: Questioning alone is not full conceptual unless elaboration is present.
    // So if it's purely question-heavy with conceptual markers but no elaboration,
    // we prefer MIXED instead of CONCEPTUAL.
    const forcedConceptual = conHits > 0 && opHits === 0 && (!questionHeavy || hasElaboration);
    if (forcedOperational)
        return { forcedTag: "operational", formattingOnly, hasElaboration, questionHeavy };
    if (forcedMixed)
        return { forcedTag: "mixed", formattingOnly: false, hasElaboration, questionHeavy };
    if (forcedConceptual)
        return { forcedTag: "conceptual", formattingOnly: false, hasElaboration, questionHeavy };
    // conceptual markers exist but question-heavy without elaboration => mixed
    if (conHits > 0 && opHits === 0) {
        return { forcedTag: "mixed", formattingOnly: false, hasElaboration, questionHeavy };
    }
    return { forcedTag: "operational", formattingOnly: false, hasElaboration, questionHeavy };
}
// Question-depth patterns
const QUESTION_DEPTH_PATTERNS = {
    retrieval: [/^(what is|whats)\b/, /^\bdefine\b/, /\bmeaning of\b/, /\blist\b/],
    causal: [/\bwhy\b/, /\bwhat causes\b/, /\bcauses of\b/, /\bhow does\b/, /\bmechanism\b/],
    analytical: [/\bcompare\b/, /\bcontrast\b/, /\bdifference\b/, /\bevaluate\b/, /\bcritique\b/, /\blimitations?\b/, /\btrade[- ]?off\b/],
    integrative: [/\binteract\b/, /\bintegrat(e|ion)\b/, /\bcombine\b/, /\brelationship\b/, /\brelated\b/, /\bconnected\b/, /\bconnect\b/],
    reflective: [/\bi think\b/, /\bi wonder\b/, /\bi suspect\b/, /\bis that reasonable\b/, /\bdoes that mean\b/, /\bi'?m confused\b/, /\bmy understanding\b/],
    applied: [/\bhow can\b/, /\bhow should\b/, /\bwhat should\b/, /\bmanage\b/, /\bsolution\b/, /\badvise\b/]
};
function detectQuestionDepth(textRaw) {
    const t = normText(textRaw);
    const retrieval = countMatches(t, QUESTION_DEPTH_PATTERNS.retrieval);
    const causal = countMatches(t, QUESTION_DEPTH_PATTERNS.causal);
    const analytical = countMatches(t, QUESTION_DEPTH_PATTERNS.analytical);
    const integrative = countMatches(t, QUESTION_DEPTH_PATTERNS.integrative);
    const reflective = countMatches(t, QUESTION_DEPTH_PATTERNS.reflective);
    const applied = countMatches(t, QUESTION_DEPTH_PATTERNS.applied);
    return { retrieval, causal, analytical, integrative, reflective, applied };
}
function applyOperationalSuppression(out, turns) {
    const userTextById = buildUserTurnTextMap(turns);
    for (const ts of out.turn_scores) {
        const rawText = userTextById.get(ts.turnId) ?? "";
        const cls = classifyTurn(rawText);
        const qd = detectQuestionDepth(rawText);
        const higherOrderCount = qd.causal + qd.analytical + qd.integrative + qd.reflective + qd.applied;
        // Start with forced tag
        ts.tag = cls.forcedTag;
        // If classifier says "operational" but the question is clearly higher-order (and not formatting-only),
        // upgrade to mixed so depth can be credited (WITHOUT making it fully conceptual).
        if (ts.tag === "operational" && !cls.formattingOnly && higherOrderCount > 0 && qd.retrieval === 0) {
            ts.tag = "mixed";
        }
        // Clamp base dims
        ts.dims.R = clamp01(ts.dims.R);
        ts.dims.K = clamp01(ts.dims.K);
        ts.dims.M = clamp01(ts.dims.M);
        ts.dims.C = clamp01(ts.dims.C);
        ts.dims.I = clamp01(ts.dims.I);
        ts.dims.G = clamp01(ts.dims.G);
        ts.dims.D = clamp01(ts.dims.D);
        // Determine retrieval-only
        const isPureRetrieval = qd.retrieval > 0 &&
            qd.causal === 0 &&
            qd.analytical === 0 &&
            qd.integrative === 0 &&
            qd.reflective === 0 &&
            qd.applied === 0;
        // Boost scaling:
        // - If there is elaboration (interpretation/critique/integration/reflection), full boosts.
        // - If it's mostly questioning without elaboration, reduced boosts.
        const boostScale = cls.hasElaboration ? 1.0 : 0.55;
        // Apply higher-order boosts (but do NOT let questions-alone overinflate)
        const allowBoost = ts.tag !== "operational" || higherOrderCount > 0;
        if (allowBoost && !isPureRetrieval) {
            if (qd.causal > 0)
                ts.dims.R = clamp01(ts.dims.R + 0.18 * boostScale);
            if (qd.analytical > 0) {
                ts.dims.R = clamp01(ts.dims.R + 0.12 * boostScale);
                ts.dims.C = clamp01(ts.dims.C + 0.20 * boostScale);
            }
            if (qd.integrative > 0) {
                ts.dims.G = clamp01(ts.dims.G + 0.25 * boostScale);
                ts.dims.R = clamp01(ts.dims.R + 0.10 * boostScale);
            }
            if (qd.reflective > 0) {
                ts.dims.M = clamp01(ts.dims.M + 0.22 * boostScale);
                ts.dims.I = clamp01(ts.dims.I + 0.10 * boostScale);
            }
            if (qd.applied > 0) {
                ts.dims.I = clamp01(ts.dims.I + 0.18 * boostScale);
                ts.dims.R = clamp01(ts.dims.R + 0.10 * boostScale);
            }
            // If it's question-heavy and lacks elaboration, prevent tag from becoming full conceptual
            if (cls.questionHeavy && !cls.hasElaboration && ts.tag === "conceptual") {
                ts.tag = "mixed";
            }
        }
        // Pure retrieval stays low
        if (isPureRetrieval) {
            ts.tag = "operational";
            ts.dims.R = cap(ts.dims.R, 0.20);
            ts.dims.C = cap(ts.dims.C, 0.15);
            ts.dims.G = cap(ts.dims.G, 0.15);
            ts.dims.M = cap(ts.dims.M, 0.15);
            ts.dims.I = cap(ts.dims.I, 0.25);
        }
        // Hard caps for operational turns (preserve your rule)
        if (ts.tag === "operational") {
            ts.dims.R = cap(ts.dims.R, 0.20);
            ts.dims.K = cap(ts.dims.K, 0.20);
            ts.dims.M = cap(ts.dims.M, 0.20);
            ts.dims.C = cap(ts.dims.C, 0.20);
            ts.dims.G = cap(ts.dims.G, 0.20);
            if (cls.formattingOnly)
                ts.dims.I = cap(ts.dims.I, 0.35);
        }
    }
    // Recompute conceptual share
    const n = out.turn_scores.length || 1;
    const conceptualCount = out.turn_scores.reduce((acc, t) => {
        if (t.tag === "conceptual")
            return acc + 1;
        if (t.tag === "mixed")
            return acc + 0.5;
        return acc;
    }, 0);
    out.conceptual_share = clamp01(conceptualCount / n);
    return out;
}
async function scoreInternal(turns, mode) {
    const transcript = buildTranscript(turns);
    const header = mode === "meter"
        ? `You are producing a LIVE METER PREVIEW for the most recent part of a chat.
Return the same JSON schema, but keep qualitative_summary short (2-4 sentences) focused on the window only.`
        : `You are scoring USER engagement in a human-AI chat session using 7 dimensions (R,K,M,C,I,G,D).
Score ONLY USER turns.`;
    const tasks = mode === "meter"
        ? ""
        : `
Tasks:
1) Segment the session into coherent topic segments. Unrelated topics MUST be separate segments.
   - segments[].turnIds MUST include only USER turn IDs.
2) For each USER turn, output dims (0..1) and tag (operational/conceptual/mixed).
3) conceptual_share = fraction of USER turns that are conceptual (mixed counts as 0.5).
4) qualitative_summary: 4-7 sentences summarizing engagement pattern for the whole session.
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
    });
    const outText = resp.output_text ?? "";
    const parsed = JSON.parse(outText);
    return applyOperationalSuppression(parsed, turns);
}
export async function scoreWithModel(turns) {
    return scoreInternal(turns, "full");
}
export async function scoreWithModelMeter(turns) {
    return scoreInternal(turns, "meter");
}
