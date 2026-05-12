import "dotenv/config"; // loads .env into process.env BEFORE other imports

import express from "express";
import cors from "cors";

import { computeUtSeries, meanDims, computeSessionE } from "./compute.js";
import { scoreWithModel } from "./scoring.js";

const app = express();
const PORT = Number(process.env.PORT ?? 8787);

app.use(cors());
app.use(express.json({ limit: "4mb" }));

// ✅ Simple Frontend UI (served from backend)
app.get("/", (_req, res) => {
  res.type("html").send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Offloading Meter</title>
  <style>
    body { font-family: Arial, sans-serif; max-width: 900px; margin: 24px auto; padding: 0 16px; }
    h1 { margin: 0 0 10px; }
    .muted { color: #666; margin: 0 0 18px; }
    textarea { width: 100%; min-height: 220px; padding: 12px; font-size: 14px; }
    button { padding: 10px 14px; font-size: 14px; cursor: pointer; margin-top: 10px; }
    pre { background: #f6f6f6; padding: 12px; overflow: auto; }
    .row { display:flex; gap:12px; align-items:center; flex-wrap:wrap; margin: 10px 0; }
    .pill { padding: 6px 10px; background:#eee; border-radius:999px; font-size: 12px; }
  </style>
</head>
<body>
  <h1>Offloading Meter</h1>
  <p class="muted">Paste your chat/session text (one line per turn). Click Analyze.</p>

  <textarea id="text" placeholder="Example:
User: define photosynthesis
User: make it simpler
User: give examples"></textarea>

  <div class="row">
    <button id="btn">Analyze</button>
    <span class="pill" id="status">idle</span>
  </div>

  <h3>Result</h3>
  <pre id="out">{}</pre>

<script>
  const btn = document.getElementById("btn");
  const textEl = document.getElementById("text");
  const out = document.getElementById("out");
  const statusEl = document.getElementById("status");

  btn.addEventListener("click", async () => {
    const text = textEl.value || "";
    if (!text.trim()) {
      alert("Please paste some text first.");
      return;
    }
    statusEl.textContent = "working...";
    out.textContent = "Loading...";

    try {
      const resp = await fetch("/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text })
      });

      const data = await resp.json();
      out.textContent = JSON.stringify(data, null, 2);
      statusEl.textContent = resp.ok ? "done" : "error";
    } catch (e) {
      out.textContent = String(e);
      statusEl.textContent = "error";
    }
  });
</script>
</body>
</html>`);
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
      return res.status(400).json({ ok: false, error: "Provide { text } or { turns }" });
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
        ? { mode: "qual_only", reason: "Multiple unrelated segments detected. Quantitative session scoring suppressed." }
        : { mode: "quant_qual", ...session },
    });
  } catch (error: any) {
    console.error(error?.stack || error);
    return res.status(500).json({ ok: false, error: error?.message || "Server error" });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Server listening on http://localhost:${PORT}`);
  console.log(`✅ Analyze endpoint: POST http://localhost:${PORT}/analyze`);
});