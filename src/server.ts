import 'dotenv/config';
import "dotenv/config"; // ✅ loads .env into process.env BEFORE other imports

import express from "express";
import cors from "cors";

import { computeUtSeries, meanDims, computeSessionE } from "./compute.js";
import { scoreWithModel } from "./scoring.js";

const app = express();
const PORT = Number(process.env.PORT ?? 8787);

app.use(cors());
app.use(express.json({ limit: "4mb" }));

app.get("/", (_req, res) => {
  res.type("text").send("OK: offloading-meter server running");
});

function buildTurns(text: string) {
  return text
    .split("\n")
    .map((t, i) => ({
      id: `turn_${i + 1}`,
      speaker: "user" as const,
      text: t.trim(),
    }))
    .filter((t) => t.text.length > 0);
}

app.post("/analyze", async (req, res) => {
  try {
    const body = req.body ?? {};

    const text =
      typeof body.text === "string"
        ? body.text
        : Array.isArray(body.turns)
        ? body.turns.join("\n")
        : "";

    if (!text.trim()) {
      return res.status(400).json({
        ok: false,
        error: "Provide { text } or { turns }",
      });
    }

    const turns = buildTurns(text);

    // REAL MODEL SCORING (OpenAI)
    const scored = await scoreWithModel(turns);

    // Compute Ut trajectory
    const utSeriesObjects = computeUtSeries(scored.turn_scores);

    // Mean dimensions
    const mean = meanDims(utSeriesObjects);

    // Holistic session score
    const session = computeSessionE({
      dimMeans: mean,
      UtSeries: utSeriesObjects.map((x) => x.Ut),
      conceptualShare: scored.conceptual_share,
      participationRichness: 0.5,
    });

    // Multi-topic suppression logic (simple rule)
    const suppressQuant = scored.segments.length >= 3;

    return res.json({
      ok: true,
      meta: {
        turnsCount: turns.length,
        segmentsCount: scored.segments.length,
        quantitativeSuppressed: suppressQuant,
        scorerModel: process.env.SCORER_MODEL ?? null,
      },
      segments: scored.segments,
      segmentSummaries: scored.segment_summaries,
      qualitativeSummary: scored.qualitative_summary,
      conceptualShare: scored.conceptual_share,
      turnScores: utSeriesObjects,
      dimensionMeans: mean,
      session: suppressQuant
        ? {
            mode: "qual_only",
            reason:
              "Multiple unrelated segments detected. Quantitative session scoring suppressed.",
          }
        : {
            mode: "quant_qual",
            ...session,
          },
    });
  } catch (error: any) {
    console.error(error?.stack || error);
    return res.status(500).json({
      ok: false,
      error: error?.message || "Server error",
    });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Server listening on http://localhost:${PORT}`);
  console.log(`✅ Analyze endpoint: POST http://localhost:${PORT}/analyze`);
});