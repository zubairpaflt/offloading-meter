import "dotenv/config";

import express from "express";
import cors from "cors";
import type { Request, Response } from "express";

import {
  computeUtSeries,
  meanDims,
  computeSessionE,
  clamp01,
} from "./compute.js";

import { scoreWithModel } from "./scoring.js";
import type { Band, Turn } from "./types.js";

const app = express();
const PORT = Number(process.env.PORT ?? 8787);

app.use(cors());
app.use(express.json({ limit: "4mb" }));

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

function labelFromBand10(b: Band): string {
  switch (b) {
    case "very_low":
      return "Very Low";

    case "low":
      return "Low";

    case "mild_moderate":
      return "Mild–Moderate";

    case "moderate":
      return "Moderate";

    case "moderate_high":
      return "Moderate–High";

    case "high":
      return "High";

    case "very_high":
      return "Very High";

    case "advanced":
      return "Advanced";
  }
}

function computeSpFromTurnScores(
  turnScores: Array<{ tag: string }>
) {
  const n = Math.max(1, (turnScores ?? []).length);

  const isConceptualish = (tag: string) =>
    tag === "conceptual" || tag === "mixed";

  let conceptualishCount = 0;
  let longestStreak = 0;
  let currentStreak = 0;

  for (const t of turnScores ?? []) {
    if (isConceptualish(t.tag)) {
      conceptualishCount++;
      currentStreak++;

      if (currentStreak > longestStreak) {
        longestStreak = currentStreak;
      }
    } else {
      currentStreak = 0;
    }
  }

  const ratio = conceptualishCount / n;
  const streakScore = clamp01((longestStreak - 1) / 4);

  let Sp = 0.65 * ratio + 0.35 * streakScore;

  const sizeFactor = clamp01(n / 6);
  Sp *= sizeFactor;

  return clamp01(Sp);
}

function buildTurns(text: string): Turn[] {
  const rawLines = (text ?? "")
    .replace(/\r\n/g, "\n")
    .split("\n");

  const lines = rawLines
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => !/^```/.test(l))
    .filter((l) => !/^text\s+id\s*=\s*".*"\s*$/i.test(l))
    .map((l) =>
      l.replace(/^(>{1,3}|>>+|\s*\|\s*)\s*/g, "").trim()
    )
    .filter(Boolean);

  const turns: Turn[] = [];

  let idx = 1;

  const userPrefix =
    /^(\s*(\d+[\)\.\-]\s*)?)(u(?:ser)?\s*\d*)\s*[:\-]\s*/i;

  const asstPrefix =
    /^(\s*(\d+[\)\.\-]\s*)?)(a(?:ssistant)?|chatgpt)\s*\d*\s*[:\-]\s*/i;

  for (const line of lines) {
    const raw = line.trim();

    if (!raw) continue;

    let speaker: "user" | "assistant" = "user";
    let textOut = raw;

    if (asstPrefix.test(raw)) {
      speaker = "assistant";
      textOut = raw.replace(asstPrefix, "");
    } else if (userPrefix.test(raw)) {
      speaker = "user";
      textOut = raw.replace(userPrefix, "");
    } else {
      speaker = "user";
      textOut = raw;
    }

    const clean = textOut.trim();

    if (!clean) continue;

    turns.push({
      id: `turn_${idx++}`,
      speaker,
      text: clean,
    });
  }

  return turns;
}

app.get("/", (_req: Request, res: Response) => {
  res.status(200).send("offloading-meter-api ok");
});

app.post(
  "/analyze",
  async (req: Request, res: Response) => {
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

      const parsedUserTurnsCount = turns.filter(
        (t) => t.speaker === "user"
      ).length;

      const scored = await scoreWithModel(turns);

      const MIN_USER_TURNS = 5;

      if (parsedUserTurnsCount < MIN_USER_TURNS) {
        return res.json({
          ok: true,

          meta: {
            userTurnsCount: parsedUserTurnsCount,
            segmentsCount: scored.segments.length,
            quantitativeSuppressed: true,
            suppressedReason:
              `Quantitative estimates require at least ${MIN_USER_TURNS} user turns.`,
          },

          qualitativeSummary:
            scored.qualitative_summary,

          session: {
            mode: "qual_only",
          },
        });
      }

      const utSeriesObjects =
        computeUtSeries(scored.turn_scores);

      const dimMeans =
        meanDims(utSeriesObjects);

      const Sp =
        computeSpFromTurnScores(
          scored.turn_scores
        );

      const session =
        computeSessionE({
          dimMeans,

          UtSeries:
            utSeriesObjects.map(
              (x) => x.Ut
            ),

          conceptualShare:
            scored.conceptual_share,

          participationRichness:
            Sp,

          userTurnsCount:
            parsedUserTurnsCount,
        });

      const Eband =
        band10Code(session.E);

      const Elabel =
        labelFromBand10(Eband);

      const CI = clamp01(
        (
          session.E +
          scored.conceptual_share
        ) / 2
      );

      return res.json({
        ok: true,

        meta: {
          userTurnsCount:
            parsedUserTurnsCount,

          segmentsCount:
            scored.segments.length,

          quantitativeSuppressed:
            false,
        },

        level1: {
          E: session.E,

          engagementBand:
            Eband,

          engagementLabel:
            Elabel,

          CP:
            scored.conceptual_share,

          CPBand:
            band10Code(
              scored.conceptual_share
            ),

          collaborativeIndex:
            CI,

          collaborativeBand:
            band10Code(CI),

          userTurns:
            parsedUserTurnsCount,
        },

        advanced: {
          dimensionMeans:
            dimMeans,

          dependencyMean:
            (dimMeans as any).D,

          series: {
            chart: {
              labels:
                utSeriesObjects.map(
                  (x) => x.turnId
                ),

              Ut:
                utSeriesObjects.map(
                  (x) => x.Ut
                ),
            },
          },
        },

        qualitativeSummary:
          scored.qualitative_summary,
      });
    } catch (error: any) {
      console.error(
        error?.stack || error
      );

      return res.status(500).json({
        ok: false,
        error:
          error?.message ||
          "Server error",
      });
    }
  }
);

app.listen(PORT, () => {
  console.log(
    `✅ Server listening on http://localhost:${PORT}`
  );
});