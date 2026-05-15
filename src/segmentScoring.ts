// src/segmentScoring.ts
import { clamp01, computeSessionE, computeUtSeries, meanDims } from "./compute.js";
import type { Band, TurnScore } from "./types.js";

export type SegmentReport = {
  segmentId: string;
  label: string;
  mode: "qual_only" | "quant_qual";
  shareUserTurns: number;

  // Quant fields (present when mode = quant_qual)
  E_segment?: number;
  band?: Band;
  dimensionMeans?: Record<string, number>;
  dependencyMean?: number;
  conceptualShare?: number;
  trajectory?: "increasing" | "decreasing" | "stable";
  UtSeries?: Array<{ turnId: string; Ut: number; dims: Record<string, number> }>;

  // Qual fields
  qualitativeSummary?: string;
};

function band10Code(xRaw: number): Band {
  const x = clamp01(xRaw);
  if (x <= 0.10) return "very_low";
  if (x <= 0.20) return "low";
  if (x <= 0.30) return "mild_moderate";
  if (x <= 0.40) return "moderate";
  if (x <= 0.50) return "moderate_high";
  if (x <= 0.60) return "high";
  if (x <= 0.70) return "very_high";
  return "advanced";
}

/**
 * Creates per-segment reports using already-scored user turn scores.
 * Keeps Band type aligned with src/types.ts (lowercase underscore codes).
 */
export function buildSegmentReports(args: {
  segments: Array<{ id: string; title?: string; turnIds?: string[] }>;
  turnScores: TurnScore[];
  conceptualShare: number;
  qualitativeSummary?: string;
}): SegmentReport[] {
  const segments = args.segments ?? [];
  const turnScores = args.turnScores ?? [];
  const conceptualShare = clamp01(args.conceptualShare ?? 0);

  // If no segments, return one whole-session segment
  if (!segments.length) {
    const utObjs = computeUtSeries(turnScores);
    const means = meanDims(utObjs);
    const session = computeSessionE({
      dimMeans: means,
      UtSeries: utObjs.map((x) => x.Ut),
      conceptualShare,
      participationRichness: 0,
      userTurnsCount: turnScores.length,
    });

    return [
      {
        segmentId: "session",
        label: "Session",
        mode: "quant_qual",
        shareUserTurns: 1,
        E_segment: session.E,
        band: band10Code(session.E),
        dimensionMeans: means,
        dependencyMean: (means as any).D,
        conceptualShare,
        trajectory: session.tr,
        UtSeries: utObjs,
        qualitativeSummary: args.qualitativeSummary,
      },
    ];
  }

  const total = Math.max(1, turnScores.length);

  const reports: SegmentReport[] = [];

  for (const seg of segments) {
    const ids = new Set(seg.turnIds ?? []);
    const segScores = ids.size ? turnScores.filter((t) => ids.has(t.turnId)) : [];

    const share = clamp01(segScores.length / total);

    // If we can’t map turns, output qual-only segment
    if (!segScores.length) {
      reports.push({
        segmentId: String(seg.id ?? "seg"),
        label: seg.title ?? "Segment",
        mode: "qual_only",
        shareUserTurns: share,
        qualitativeSummary: args.qualitativeSummary,
      });
      continue;
    }

    const utObjs = computeUtSeries(segScores);
    const means = meanDims(utObjs);

    const session = computeSessionE({
      dimMeans: means,
      UtSeries: utObjs.map((x) => x.Ut),
      conceptualShare,
      participationRichness: 0,
      userTurnsCount: segScores.length,
    });

    reports.push({
      segmentId: String(seg.id ?? "seg"),
      label: seg.title ?? "Segment",
      mode: "quant_qual",
      shareUserTurns: share,
      E_segment: session.E,
      band: band10Code(session.E),
      dimensionMeans: means,
      dependencyMean: (means as any).D,
      conceptualShare,
      trajectory: session.tr,
      UtSeries: utObjs,
      qualitativeSummary: args.qualitativeSummary,
    });
  }

  return reports;
}