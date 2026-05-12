import { DimScores } from "./types.js";

export interface Weights {
  wR: number; wK: number; wM: number; wC: number; wI: number; wG: number; wD: number;
  beta0: number;
  lambda: number;
}

export const DEFAULT_WEIGHTS: Weights = {
  wR: 0.15, wK: 0.10, wM: 0.15, wC: 0.18, wI: 0.12, wG: 0.20, wD: 0.10,
  beta0: -0.15,
  lambda: 0.30
};

export function clamp01(x: number) {
  return Math.max(0, Math.min(1, x));
}

export function sigmoid(x: number) {
  return 1 / (1 + Math.exp(-x));
}

export function computeUtSeries(
  turnScores: Array<{ turnId: string; dims: DimScores }>,
  W: Weights = DEFAULT_WEIGHTS
) {
  let prevUt = 0;

  return turnScores.map(t => {
    const { R, K, M, C, I, G, D } = t.dims;

    const z =
      W.beta0 +
      W.wR * R +
      W.wK * K +
      W.wM * M +
      W.wC * C +
      W.wI * I +
      W.wG * G -
      W.wD * D +
      W.lambda * prevUt;

    const Ut = clamp01(sigmoid(z));
    prevUt = Ut;

    return { turnId: t.turnId, dims: t.dims, Ut };
  });
}

export function meanDims(series: Array<{ dims: DimScores }>): DimScores {
  const n = Math.max(series.length, 1);

  const sum = series.reduce((acc, s) => {
    acc.R += s.dims.R; acc.K += s.dims.K; acc.M += s.dims.M; acc.C += s.dims.C;
    acc.I += s.dims.I; acc.G += s.dims.G; acc.D += s.dims.D;
    return acc;
  }, { R:0, K:0, M:0, C:0, I:0, G:0, D:0 });

  return {
    R: sum.R/n, K: sum.K/n, M: sum.M/n, C: sum.C/n, I: sum.I/n, G: sum.G/n, D: sum.D/n
  };
}

export function trajectoryLabel(Ut: number[]): "increasing" | "flat" | "decreasing" | "fluctuating" {
  if (Ut.length < 6) return "flat";

  const q = Math.max(1, Math.floor(Ut.length / 4));
  const a = Ut.slice(0, q).reduce((x, y) => x + y, 0) / q;
  const b = Ut.slice(Ut.length - q).reduce((x, y) => x + y, 0) / q;
  const diff = b - a;

  const mean = Ut.reduce((x, y) => x + y, 0) / Ut.length;
  const variance = Ut.reduce((acc, u) => acc + (u - mean) * (u - mean), 0) / Ut.length;

  if (variance > 0.04) return "fluctuating";
  if (diff > 0.08) return "increasing";
  if (diff < -0.08) return "decreasing";
  return "flat";
}

export function band(E: number): "very_low"|"low"|"moderate"|"high"|"very_high" {
  if (E <= 0.20) return "very_low";
  if (E <= 0.40) return "low";
  if (E <= 0.60) return "moderate";
  if (E <= 0.80) return "high";
  return "very_high";
}

/**
 * Holistic session score:
 * Sd (dimension structure) + St (trajectory) + Sc (conceptual share) + Sp (optional richness)
 */
export function computeSessionE(params: {
  dimMeans: DimScores;
  UtSeries: number[];
  conceptualShare: number;        // 0..1
  participationRichness?: number; // 0..1 (optional later)
}) {
  const { dimMeans, UtSeries, conceptualShare } = params;
  const Sp = clamp01(params.participationRichness ?? 0);

  // Sd: weighted dimension structure -> sigmoid to bound
  const zSd =
    -0.10 +
    0.15*dimMeans.R +
    0.10*dimMeans.K +
    0.15*dimMeans.M +
    0.18*dimMeans.C +
    0.12*dimMeans.I +
    0.20*dimMeans.G -
    0.10*dimMeans.D;

  const Sd = clamp01(sigmoid(4.0 * (zSd - 0.10)));

  // St: coarse mapping from trajectory label
  const tr = trajectoryLabel(UtSeries);
  const St = tr === "increasing" ? 0.80 : tr === "flat" ? 0.55 : tr === "decreasing" ? 0.35 : 0.50;

  const Sc = clamp01(conceptualShare);

  const E = clamp01(0.45*Sd + 0.20*St + 0.20*Sc + 0.15*Sp);
  return { E, Sd, St, Sc, Sp, tr };
}