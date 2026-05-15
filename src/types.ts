// src/types.ts

export type Speaker = "user" | "assistant";

/** Bands (lowercase underscore) */
export type Band =
  | "very_low"
  | "low"
  | "mild_moderate"
  | "moderate"
  | "moderate_high"
  | "high"
  | "very_high"
  | "advanced";

/** Compatibility aliases (your older files import these) */
export type BandCode = Band;
export type ReportMode = "qual_only" | "quant_qual";

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

export type TurnScore = {
  turnId: string;
  tag: "operational" | "conceptual" | "mixed";
  dims: Dims7;
};

/** Older name used in scoring.ts */
export type ModelTurnScore = TurnScore;

export type Segment = {
  id: string;
  title?: string;
  turnIds?: string[];

  // optional fields used by segmenter.ts
  label?: string;
  shareUserTurns?: number;
};

export type ModelScoringResult = {
  turn_scores: TurnScore[];
  conceptual_share: number;
  segments: Segment[];
  qualitative_summary: string;
};