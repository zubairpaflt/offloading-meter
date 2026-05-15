// src/types.ts

export type Speaker = "user" | "assistant";

/**
 * Band codes used by your UI + server
 */
export type Band =
  | "very_low"
  | "low"
  | "mild_moderate"
  | "moderate"
  | "moderate_high"
  | "high"
  | "very_high"
  | "advanced";

export type Dims7 = {
  R: number; // Reasoning / inquiry
  K: number; // Knowledge use
  M: number; // Metacognition / reflection
  C: number; // Contribution / creation
  I: number; // Initiative / exploration
  G: number; // Integration / synthesis
  D: number; // Dependency / delegation
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