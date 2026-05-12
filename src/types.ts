export type Speaker = "user" | "assistant";

export interface Turn {
  id: string;
  speaker: Speaker;
  text: string;
}

export interface DimScores {
  R: number; K: number; M: number; C: number; I: number; G: number; D: number; // 0..1
}

export type TurnTag = "operational" | "conceptual" | "mixed";

export interface ModelTurnScore {
  turnId: string;
  tag: TurnTag;
  dims: DimScores;
}

export interface Segment {
  segmentId: string;
  label: string;
  turnIds: string[];          // user turn IDs
  shareUserTurns?: number;    // computed server-side
}

export type ReportMode = "quant_qual" | "qual_only" | "no_report";

export interface SegmentReport {
  segmentId: string;
  label: string;
  mode: "quant_qual" | "qual_only" | "no_report";
  shareUserTurns?: number;

  E_segment?: number;
  band?: "very_low" | "low" | "moderate" | "high" | "very_high";
  dimensionMeans?: DimScores;
  dependencyMean?: number;
  conceptualShare?: number;
  trajectory?: "increasing" | "flat" | "decreasing" | "fluctuating";
  UtSeries?: Array<{ turnId: string; Ut: number }>;

  qualitativeSummary?: string;
  reason?: string;
}

export interface SessionReport {
  mode: ReportMode;
  segments: Segment[];
  reason?: string;

  E_session?: number;
  band?: "very_low" | "low" | "moderate" | "high" | "very_high";
  dimensionMeans?: DimScores;
  dependencyMean?: number;
  conceptualShare?: number;
  trajectory?: "increasing" | "flat" | "decreasing" | "fluctuating";
  UtSeries?: Array<{ turnId: string; Ut: number }>;

  qualitativeSummary?: string;

  segmentReports?: SegmentReport[];

  dashboardUri?: string;
  exportJsonUri?: string;
  exportCsvUri?: string;
}

export interface MeterPreview {
  windowUserTurns: number;
  userTurnsUsed: number;

  mode: "quant_qual" | "qual_only";
  reason?: string;

  E_window?: number;
  band?: "very_low" | "low" | "moderate" | "high" | "very_high";
  dimensionMeans?: DimScores;
  dependencyMean?: number;
  conceptualShare?: number;
  trajectory?: "increasing" | "flat" | "decreasing" | "fluctuating";
  UtSeries?: Array<{ turnId: string; Ut: number }>;

  qualitativeSummary: string;
}