// src/compute.ts
// Compute helpers used by server.ts
// This file MUST match the call-shape used in server.ts.

export type BandCode =
  | "very_low"
  | "low"
  | "mild_moderate"
  | "moderate"
  | "moderate_high"
  | "high"
  | "very_high"
  | "advanced";

export function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(1, x));
}

export function mean(nums: number[]): number {
  const arr = (nums ?? []).filter((n) => Number.isFinite(n));
  if (arr.length === 0) return 0;
  const s = arr.reduce((a, b) => a + b, 0);
  return s / arr.length;
}

/**
 * 0.10-step band codes (what your backend UI expects in server.ts)
 */
export function band(xRaw: number): BandCode {
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
 * Build a per-user-turn series from model turn_scores.
 * Output items have:
 * - turnId
 * - Ut (0..1)
 * - dims {R,K,M,C,I,G,D}
 */
export function computeUtSeries(turnScores: any[]): Array<{
  turnId: string;
  Ut: number;
  dims: { R: number; K: number; M: number; C: number; I: number; G: number; D: number };
}> {
  const arr = Array.isArray(turnScores) ? turnScores : [];

  return arr.map((t: any, i: number) => {
    const dimsIn = (t?.dims ?? {}) as any;
    const dims = {
      R: clamp01(dimsIn.R),
      K: clamp01(dimsIn.K),
      M: clamp01(dimsIn.M),
      C: clamp01(dimsIn.C),
      I: clamp01(dimsIn.I),
      G: clamp01(dimsIn.G),
      D: clamp01(dimsIn.D),
    };

    // Ut = mean of "cognitive" dims excluding dependency D
    const Ut = clamp01(mean([dims.R, dims.K, dims.M, dims.C, dims.I, dims.G]));

    return {
      turnId: String(t?.turnId ?? `turn_${i + 1}`),
      Ut,
      dims,
    };
  });
}

/**
 * Mean of dims across the series.
 * Returns {R,K,M,C,I,G,D,Ut}
 */
export function meanDims(series: Array<{ Ut: number; dims: Record<string, number> }>): Record<string, number> {
  const arr = Array.isArray(series) ? series : [];
  if (arr.length === 0) return { Ut: 0, R: 0, K: 0, M: 0, C: 0, I: 0, G: 0, D: 0 };

  const keys = new Set<string>(["Ut", "R", "K", "M", "C", "I", "G", "D"]);
  const out: Record<string, number> = {};

  for (const k of keys) {
    if (k === "Ut") out.Ut = clamp01(mean(arr.map((x) => clamp01(x?.Ut))));
    else out[k] = clamp01(mean(arr.map((x) => clamp01((x?.dims ?? {})[k]))));
  }

  return out;
}

export type ComputeSessionEInput = {
  dimMeans: Record<string, number>;
  UtSeries: number[]; // array of Ut values
  conceptualShare: number;
  participationRichness: number; // your Sp from server.ts
  userTurnsCount: number;
};

/**
 * This matches how server.ts calls it.
 * Returns the fields server.ts reads under advanced.components + level1.E
 */
export function computeSessionE(input: ComputeSessionEInput) {
  const dimMeans = input?.dimMeans ?? {};
  const ut = Array.isArray(input?.UtSeries) ? input.UtSeries : [];
  const conceptualShare = clamp01(input?.conceptualShare ?? 0);
  const participationRichness = clamp01(input?.participationRichness ?? 0);
  const userTurnsCount = Math.max(0, Number(input?.userTurnsCount ?? 0));

  const UtMean = clamp01(mean(ut.map(clamp01)));

  // Simple component construction (stable + explainable)
  const Sd = clamp01(mean([dimMeans.R, dimMeans.K, dimMeans.M, dimMeans.C, dimMeans.I, dimMeans.G].map(clamp01)));
  const St = UtMean; // trajectory/through-session energy proxy
  const Sc = conceptualShare; // conceptual participation
  const Sp = participationRichness; // conceptual persistence (already computed in server.ts)

  // Core score (weights can be tuned later)
  const Ecore = clamp01(0.40 * Sd + 0.25 * Sc + 0.20 * Sp + 0.15 * St);

  // Duration bonus (small)
  const durationBonus = clamp01((userTurnsCount - 5) / 25) * 0.08; // max +0.08 after ~30 turns

  // Quality gate: penalize extremely low conceptual share
  const qualityGate = clamp01(0.65 + 0.35 * Sc);

  const E = clamp01((Ecore + durationBonus) * qualityGate);

  // Trajectory label (basic)
  let tr: "increasing" | "decreasing" | "stable" = "stable";
  if (ut.length >= 3) {
    const first = mean(ut.slice(0, Math.ceil(ut.length / 3)));
    const last = mean(ut.slice(Math.floor((2 * ut.length) / 3)));
    const diff = last - first;
    if (diff > 0.07) tr = "increasing";
    else if (diff < -0.07) tr = "decreasing";
  }

  return {
    E,
    Sd,
    St,
    Sc,
    Sp,
    Ecore,
    durationBonus,
    qualityGate,
    nTurns: userTurnsCount,
    tr,
  };
}