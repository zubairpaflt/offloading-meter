import { Segment, ModelTurnScore, SegmentReport, Turn } from "./types.js";
import { computeUtSeries, meanDims, computeSessionE, band } from "./compute.js";

function clamp01(x: number) {
  if (Number.isNaN(x)) return 0;
  return Math.max(0, Math.min(1, x));
}

/**
 * Phase 2: Sp (persistence) for a segment.
 * - rewards conceptual/mixed density
 * - rewards longest conceptual-ish streak
 * - mild small-segment penalty so very short segments don't look "advanced"
 */
function computeSpFromTurnScores(turnScores: Array<{ tag: string }>) {
  const n = Math.max(1, turnScores.length);
  const isConceptualish = (tag: string) => tag === "conceptual" || tag === "mixed";

  let conceptualishCount = 0;
  let longestStreak = 0;
  let currentStreak = 0;

  for (const t of turnScores) {
    if (isConceptualish(t.tag)) {
      conceptualishCount++;
      currentStreak++;
      if (currentStreak > longestStreak) longestStreak = currentStreak;
    } else {
      currentStreak = 0;
    }
  }

  const ratio = conceptualishCount / n;                // 0..1
  const streakScore = clamp01((longestStreak - 1) / 4); // 1 at streak>=5

  let Sp = 0.65 * ratio + 0.35 * streakScore;

  // Small-segment penalty: scale down under 6 turns
  const sizeFactor = clamp01(n / 6);
  Sp *= sizeFactor;

  return clamp01(Sp);
}

export function scoreSegments(params: {
  turns: Turn[];
  segments: Segment[];
  modelTurnScores: ModelTurnScore[];
  segmentQualSummaries?: Record<string, string>;
}): SegmentReport[] {

  const userTurns = params.turns.filter(t => t.speaker === "user");
  const totalUserTurns = Math.max(userTurns.length, 1);

  const scoreById = new Map(
    params.modelTurnScores.map(s => [s.turnId, s])
  );

  return params.segments.map(seg => {

    const segScores = seg.turnIds
      .map(id => scoreById.get(id))
      .filter(Boolean) as ModelTurnScore[];

    const utSeries = computeUtSeries(
      segScores.map(s => ({
        turnId: s.turnId,
        dims: s.dims
      }))
    );

    const dimMeans = meanDims(utSeries);
    const UtValues = utSeries.map(x => x.Ut);

    // Sc (conceptual share):
    // conceptual=1, mixed=0.5, operational=0
    const conceptualShare =
      segScores.length === 0
        ? 0
        : segScores.reduce((acc, s) => {
            if (s.tag === "conceptual") return acc + 1;
            if (s.tag === "mixed") return acc + 0.5;
            return acc;
          }, 0) / segScores.length;

    // Sp (persistence)
    const Sp = computeSpFromTurnScores(segScores);

    // Phase 2: pass Sp + segment length for proportional deep-credit
    const { E, tr } = computeSessionE({
      dimMeans,
      UtSeries: UtValues,
      conceptualShare,
      participationRichness: Sp,
      userTurnsCount: segScores.length
    });

    const share = (seg.turnIds?.length ?? 0) / totalUserTurns;

    const qualitativeSummary =
      params.segmentQualSummaries?.[seg.segmentId];

    return {
      segmentId: seg.segmentId,
      label: seg.label,

      mode: "quant_qual",

      shareUserTurns: share,

      E_segment: E,
      band: band(E),

      dimensionMeans: dimMeans,
      dependencyMean: dimMeans.D,

      conceptualShare: clamp01(conceptualShare),

      trajectory: tr,

      UtSeries: utSeries.map(u => ({
        turnId: u.turnId,
        Ut: u.Ut
      })),

      qualitativeSummary
    };
  });
}