import { Segment, ModelTurnScore, SegmentReport, Turn } from "./types.js";
import { computeUtSeries, meanDims, computeSessionE, band } from "./compute.js";

export function scoreSegments(params: {
  turns: Turn[];
  segments: Segment[];
  modelTurnScores: ModelTurnScore[];
  segmentQualSummaries?: Record<string, string>;
}) : SegmentReport[] {

  const userTurns = params.turns.filter(t => t.speaker === "user");

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

    // conceptualShare:
    // conceptual=1
    // mixed=0.5
    // operational=0
    const conceptualShare =
      segScores.length === 0
        ? 0
        : segScores.reduce((acc, s) => {
            if (s.tag === "conceptual") return acc + 1;
            if (s.tag === "mixed") return acc + 0.5;
            return acc;
          }, 0) / segScores.length;

    const { E, tr } = computeSessionE({
      dimMeans,
      UtSeries: UtValues,
      conceptualShare
    });

    const share =
      seg.turnIds.length / Math.max(userTurns.length, 1);

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

      conceptualShare,

      trajectory: tr,

      UtSeries: utSeries.map(u => ({
        turnId: u.turnId,
        Ut: u.Ut
      })),

      qualitativeSummary
    };
  });
}