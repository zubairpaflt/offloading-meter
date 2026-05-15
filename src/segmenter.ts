import { Segment, ReportMode } from "./types.js";

function clamp01(x: number) {
  if (Number.isNaN(x)) return 0;
  return Math.max(0, Math.min(1, x));
}

function norm(s: string) {
  return (s ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Phase 2 coherence rule:
 * - Allow topic + related subtopics + interdisciplinary expansions.
 * - Suppress quantitative scoring only when there is cognitive discontinuity
 *   (e.g., CBT then email drafting, then coding/debugging, etc.)
 *
 * We detect discontinuity using a lightweight "task category" heuristic on segment labels.
 * This avoids over-suppressing legitimate conceptual expansion within one topic.
 */
function segmentCategory(label: string): "topic" | "email" | "code" | "formatting" | "translation" | "admin" {
  const t = norm(label);

  // email / letter writing
  if (/\b(email|mail|letter|cover letter|recommendation|application|subject line|reply)\b/.test(t)) return "email";

  // coding / debugging
  if (/\b(code|coding|debug|bug|error|stack|typescript|javascript|python|node|react|next|api|server|vercel|git|github)\b/.test(t)) return "code";

  // formatting / rewriting / summarizing (utility tasks)
  if (/\b(rewrite|rephrase|paraphrase|summarize|shorten|condense|bullet|format|proofread|grammar|tone|style)\b/.test(t)) return "formatting";

  // translation
  if (/\b(translate|translation|urdu|english)\b/.test(t)) return "translation";

  // admin / logistics / misc utilities
  if (/\b(schedule|meeting|appointment|deadline|reminder|invoice|billing|account|login)\b/.test(t)) return "admin";

  return "topic";
}

export function decideReportMode(
  segments: Segment[],
  userTurnsCount: number,
  minUserTurnsForQuant = 5
): { mode: ReportMode; reason?: string } {
  // Phase 2: Minimum reliability rule
  if (userTurnsCount < minUserTurnsForQuant) {
    return {
      mode: "qual_only",
      reason: `Too few user turns (${userTurnsCount}) for reliable quantitative scoring (requires ≥ ${minUserTurnsForQuant}).`
    };
  }

  // Ensure shareUserTurns exists (some callers may not pre-fill it)
  const segs = segments.map(s => ({
    ...s,
    shareUserTurns: typeof s.shareUserTurns === "number"
      ? clamp01(s.shareUserTurns)
      : clamp01((s.turnIds?.length ?? 0) / Math.max(userTurnsCount, 1))
  }));

  // Consider only "substantial" segments (avoid tiny incidental fragments)
  const substantial = segs.filter(s => (s.shareUserTurns ?? 0) >= 0.15);

  // If there is essentially one dominant segment, allow quant+qual
  const dominant = substantial.find(s => (s.shareUserTurns ?? 0) >= 0.70);
  if (dominant) return { mode: "quant_qual" };

  // Categorize substantial segments by task type
  const categories = substantial.map(s => segmentCategory(s.label));
  const distinct = Array.from(new Set(categories));

  // If everything is still "topic" (even if multiple subtopics), allow quant+qual
  // This supports: topic → related subtopics → interdisciplinary expansion.
  if (distinct.length === 1 && distinct[0] === "topic") {
    return { mode: "quant_qual" };
  }

  // If there is any utility-task category mixed with topic or other utilities,
  // treat as cognitive discontinuity.
  const hasUtility = distinct.some(c => c !== "topic");

  // Strong fragmentation: many substantial unrelated tasks
  if (hasUtility && distinct.length >= 3) {
    return {
      mode: "no_report",
      reason: "Session contains multiple unrelated task segments (cognitive discontinuity); a single quantitative score would be misleading."
    };
  }

  // Moderate fragmentation: 2 substantial different categories (e.g., CBT then email)
  if (hasUtility && distinct.length >= 2) {
    return {
      mode: "qual_only",
      reason: "Unrelated task shift detected (e.g., topic discussion → utility task); quantitative scoring is suppressed for reliability."
    };
  }

  // Default
  return { mode: "quant_qual" };
}