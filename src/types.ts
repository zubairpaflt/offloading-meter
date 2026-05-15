// src/types.ts

export type Speaker = "user" | "assistant";

/** ✅ Single source of truth */
export type Band =
  | "very_low"
  | "low"
  | "mild_moderate"
  | "moderate"
  | "moderate_high"
  | "high"
  | "very_high"
  | "advanced";

/** ✅ Compatibility: if any file uses BandCode */
export type BandCode = Band;

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

export type Segment = {
  id: string;
  title?: string;
  turnIds?: string[];
};

export type ModelScoringResult = {
  turn_scores: TurnScore[];
  conceptual_share: number;
  segments: Segment[];
  qualitative_summary: string;
};