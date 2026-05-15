// src/types.ts

export type Speaker = "user" | "assistant";

/** ✅ Single source of truth for bands (lowercase underscore) */
export type Band =
  | "very_low"
  | "low"
  | "mild_moderate"
  | "moderate"
  | "moderate_high"
  | "high"
  | "very_high"
  | "advanced";

/** ✅ Compatibility: some files may import BandCode */
export type BandCode = Band;

/** ✅ Compatibility: some files may import ReportMode */
export type ReportMode = "qual_only" | "quant_qual";

/** 7 dimensions */
export type Dims7 = {
  R: number;
  K: number;
  M: number;
  C: number;
  I: number;
  G: number;
  D: number;
};

export type Turn = {
  id: string;
  speaker: Speaker;
  text: string;
};

/** Per-turn model score */
export type TurnScore = {
  turnId: string;
  tag: "operational" | "conceptual" | "mixed";
  dims: Dims7;
};

/** ✅ Compatibility: some files import ModelTurnScore */
export type ModelTurnScore = TurnScore;

/**
 * Segment metadata
 * ✅ includes optional fields used in segmenter.ts (label/shareUserTurns)
 */
export type Segment = {
  id: string;
  title?: string;
  turnIds?: string[];

  // optional fields (some logic may attach these)
  label?: string;
  shareUserTurns?: number;
};

export type ModelScoringResult = {
  turn_scores: TurnScore[];
  conceptual_share: number;
  segments: Segment[];
  qualitative_summary: string;
};