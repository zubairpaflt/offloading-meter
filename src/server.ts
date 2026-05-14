import "dotenv/config";

import express from "express";
import cors from "cors";

import { computeUtSeries, meanDims, computeSessionE } from "./compute.js";
import { scoreWithModel } from "./scoring.js";

const app = express();
const PORT = Number(process.env.PORT ?? 8787);

app.use(cors());
app.use(express.json({ limit: "4mb" }));

function clamp01(x: number) {
  if (Number.isNaN(x)) return 0;
  return Math.max(0, Math.min(1, x));
}

/**
 * Sp = conceptual persistence (NOT raw length).
 * - rewards sustained conceptual/mixed streaks and overall conceptual ratio
 * - penalizes tiny sessions so 1–3 high-order questions don't look "very high"
 */
function computeSpFromTurnScores(turnScores: Array<{ tag: string }>) {
  const n = Math.max(1, turnScores.length);

  const isConceptualish = (tag: string) => tag === "conceptual" || tag === "mixed";

  let conceptualishCount = 0;
  let longestStreak = 0;
  let currentStreak = 0;

  for (const t of turnScores) {
    if (isConceptualish(t.tag)) {
      conceptualishCount++;
      currentStreak++;
      if (currentStreak > longestStreak) longestStreak = currentStreak;
    } else {
      currentStreak = 0;
    }
  }

  const ratio = conceptualishCount / n; // 0..1

  // Streak score: 1 at streak>=5, 0 at streak<=1
  const streakScore = clamp01((longestStreak - 1) / 4);

  // Core persistence: ratio matters more than streak, but both matter
  let Sp = 0.65 * ratio + 0.35 * streakScore;

  // Small-session penalty: if < 6 turns, scale down (prevents early-stop inflation)
  const sizeFactor = clamp01(n / 6);
  Sp *= sizeFactor;

  return clamp01(Sp);
}

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

// ✅ Frontend UI
app.get("/", (_req, res) => {
  res.type("html").send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Offloading Meter</title>
  <style>
    :root { --bg:#0b0d12; --card:#121622; --muted:#a7b0c0; --text:#e9edf5; --line:#20283a; }
    body { margin:0; font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial;
           background: radial-gradient(1200px 600px at 20% 0%, #1a2140 0%, var(--bg) 60%);
           color: var(--text); }
    .wrap { max-width: 980px; margin: 26px auto; padding: 0 16px; }
    h1 { margin: 0 0 6px; font-size: 26px; letter-spacing: .2px; }
    .sub { margin:0 0 18px; color: var(--muted); line-height: 1.4; }
    .grid { display:grid; grid-template-columns: 1.2fr .8fr; gap: 14px; }
    @media (max-width: 900px){ .grid{ grid-template-columns:1fr; } }
    .card { background: rgba(18,22,34,.92); border:1px solid var(--line); border-radius: 16px; padding: 14px; box-shadow: 0 8px 30px rgba(0,0,0,.25); }
    textarea { width:100%; min-height: 210px; padding: 12px 12px; border-radius: 12px;
               background:#0f1422; color: var(--text); border:1px solid var(--line); outline:none;
               font-size: 13.5px; line-height: 1.35; resize: vertical; }
    textarea:focus { border-color:#3a4a77; box-shadow: 0 0 0 3px rgba(88,120,255,.15); }
    .row { display:flex; gap:10px; align-items:center; flex-wrap:wrap; margin-top: 10px; }
    button { padding: 10px 12px; border-radius: 12px; border: 1px solid #2a3552;
             background: linear-gradient(180deg, #2b3b6b, #1a2341); color: var(--text);
             font-weight: 600; cursor:pointer; }
    button:disabled { opacity:.6; cursor:not-allowed; }
    .ghost { background: transparent; border:1px solid var(--line); }
    .pill { padding: 6px 10px; background:#0f1422; border:1px solid var(--line); border-radius:999px; font-size:12px; color: var(--muted); }
    .kpi { display:grid; grid-template-columns: repeat(2, minmax(0,1fr)); gap: 10px; }
    .k { background:#0f1422; border:1px solid var(--line); border-radius: 14px; padding: 10px; }
    .k .t { font-size: 12px; color: var(--muted); margin-bottom: 6px; }
    .k .v { font-size: 18px; font-weight: 700; letter-spacing:.2px; }
    .seg { padding: 10px; border:1px solid var(--line); border-radius: 14px; background:#0f1422; margin-top:10px; }
    .seg h4 { margin:0 0 6px; font-size: 14px; }
    .seg p { margin:0; color: var(--muted); line-height: 1.45; font-size: 13px; }
    pre { background:#0f1422; border:1px solid var(--line); border-radius: 14px; padding: 10px; overflow:auto; font-size: 12px; color:#d8deea; }
    .small { font-size: 12px; color: var(--muted); }
    a { color:#9bb2ff; text-decoration:none; }
  </style>
</head>
<body>
  <div class="wrap">
    <h1>Offloading Meter</h1>
    <p class="sub">Paste your session text (one line per user turn). Click <b>Analyze</b> to get quantitative + qualitative results.</p>

    <div class="grid">
      <div class="card">
        <div class="small">Input</div>
        <textarea id="text" placeholder="Example:
define inflation
what causes inflation?
why do central banks raise interest rates?"></textarea>

        <div class="row">
          <button id="btn">Analyze</button>
          <button id="copy" class="ghost" disabled>Copy report</button>
          <span class="pill" id="status">idle</span>
        </div>

        <div class="small" style="margin-top:10px;">
          Tip: the meter rewards <b>depth</b> and <b>persistence</b> of conceptual engagement (not formatting activity).
        </div>
      </div>

      <div class="card" id="summaryCard">
        <div class="small">Summary</div>
        <div class="kpi" style="margin-top:10px;">
          <div class="k">
            <div class="t">Segments</div>
            <div class="v" id="kSeg">—</div>
          </div>
          <div class="k">
            <div class="t">Turns</div>
            <div class="v" id="kTurns">—</div>
          </div>
          <div class="k">
            <div class="t">Conceptual share</div>
            <div class="v" id="kConcept">—</div>
          </div>
          <div class="k">
            <div class="t">Session E</div>
            <div class="v" id="kE">—</div>
          </div>
        </div>

        <div class="row" style="margin-top:12px;">
          <span class="pill" id="modePill">mode: —</span>
          <span class="pill" id="trendPill">trend: —</span>
        </div>
      </div>
    </div>

    <div class="card" style="margin-top:14px;">
      <div class="small">Segments</div>
      <div id="segments"></div>
    </div>

    <div class="card" style="margin-top:14px;">
      <div class="small">Qualitative interpretation</div>
      <div class="seg" style="margin-top:10px;">
        <p id="qual">—</p>
      </div>
    </div>

    <div class="card" style="margin-top:14px;">
      <div class="row" style="justify-content:space-between;">
        <div class="small">Raw JSON (optional)</div>
        <button id="toggleRaw" class="ghost" disabled>Show raw</button>
      </div>
      <div id="rawWrap" style="display:none; margin-top:10px;">
        <pre id="raw">{}</pre>
      </div>
    </div>
  </div>

<script>
  const btn = document.getElementById("btn");
  const copyBtn = document.getElementById("copy");
  const textEl = document.getElementById("text");
  const statusEl = document.getElementById("status");

  const kSeg = document.getElementById("kSeg");
  const kTurns = document.getElementById("kTurns");
  const kConcept = document.getElementById("kConcept");
  const kE = document.getElementById("kE");
  const modePill = document.getElementById("modePill");
  const trendPill = document.getElementById("trendPill");

  const segmentsWrap = document.getElementById("segments");
  const qualEl = document.getElementById("qual");

  const raw = document.getElementById("raw");
  const rawWrap = document.getElementById("rawWrap");
  const toggleRaw = document.getElementById("toggleRaw");

  let lastData = null;

  function fmt(n, digits=2){
    if (n === null || n === undefined || Number.isNaN(Number(n))) return "—";
    return Number(n).toFixed(digits);
  }

  function buildReport(d){
    const lines = [];
    lines.push("Offloading Meter Report");
    lines.push("======================");
    lines.push("");
    lines.push(\`Turns: \${d?.meta?.turnsCount ?? "—"}\`);
    lines.push(\`Segments: \${d?.meta?.segmentsCount ?? "—"}\`);
    lines.push(\`Conceptual share: \${d?.conceptualShare ?? "—"}\`);
    lines.push(\`Sp (persistence): \${d?.session?.Sp ?? "—"}\`);
    lines.push(\`Session E: \${d?.session?.E ?? "—"}\`);
    lines.push(\`Session trend: \${d?.session?.tr ?? "—"}\`);
    lines.push("");
    lines.push("Segments:");
    (d?.segments ?? []).forEach((s) => {
      lines.push(\`- \${s.label} (\${(s.turnIds||[]).length} turns)\`);
    });
    lines.push("");
    lines.push("Qualitative Summary:");
    lines.push(d?.qualitativeSummary ?? "");
    return lines.join("\\n");
  }

  function render(d){
    kSeg.textContent = d?.meta?.segmentsCount ?? "—";
    kTurns.textContent = d?.meta?.turnsCount ?? "—";
    kConcept.textContent = fmt(d?.conceptualShare, 2);

    kE.textContent = fmt(d?.session?.E, 3);
    modePill.textContent = "mode: quant + qual";
    trendPill.textContent = "trend: " + (d?.session?.tr ?? "—");

    segmentsWrap.innerHTML = "";
    const segs = d?.segments ?? [];
    const sums = new Map((d?.segmentSummaries ?? []).map(x => [x.segmentId, x.summary]));
    if (!segs.length){
      segmentsWrap.innerHTML = '<div class="seg"><p>No segments returned.</p></div>';
    } else {
      segs.forEach(s => {
        const div = document.createElement("div");
        div.className = "seg";
        const turns = (s.turnIds || []).length;
        const summary = sums.get(s.segmentId) || "";
        div.innerHTML = \`
          <h4>\${s.label} <span class="pill" style="margin-left:8px;">\${turns} turns</span></h4>
          <p>\${summary || "—"}</p>\`;
        segmentsWrap.appendChild(div);
      });
    }

    qualEl.textContent = d?.qualitativeSummary ?? "—";

    raw.textContent = JSON.stringify(d, null, 2);
    toggleRaw.disabled = false;
    copyBtn.disabled = false;
  }

  toggleRaw.addEventListener("click", () => {
    const isOpen = rawWrap.style.display !== "none";
    rawWrap.style.display = isOpen ? "none" : "block";
    toggleRaw.textContent = isOpen ? "Show raw" : "Hide raw";
  });

  copyBtn.addEventListener("click", async () => {
    if (!lastData) return;
    try{
      await navigator.clipboard.writeText(buildReport(lastData));
      statusEl.textContent = "copied!";
      setTimeout(() => statusEl.textContent = "done", 1200);
    } catch(e){
      alert("Copy failed. You can open Raw JSON and copy manually.");
    }
  });

  btn.addEventListener("click", async () => {
    const text = (textEl.value || "").trim();
    if (!text) { alert("Please paste some text first."); return; }

    btn.disabled = true;
    copyBtn.disabled = true;
    toggleRaw.disabled = true;
    statusEl.textContent = "working...";
    segmentsWrap.innerHTML = "";
    qualEl.textContent = "—";
    raw.textContent = "{}";
    rawWrap.style.display = "none";
    toggleRaw.textContent = "Show raw";
    modePill.textContent = "mode: —";
    trendPill.textContent = "trend: —";
    kSeg.textContent = "—";
    kTurns.textContent = "—";
    kConcept.textContent = "—";
    kE.textContent = "—";

    try {
      const resp = await fetch("/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text })
      });

      const data = await resp.json();
      lastData = data;

      if (!resp.ok || !data?.ok){
        statusEl.textContent = "error";
        rawWrap.style.display = "block";
        toggleRaw.disabled = false;
        toggleRaw.textContent = "Hide raw";
        raw.textContent = JSON.stringify(data, null, 2);
        alert(data?.error || "Analyze failed");
      } else {
        render(data);
        statusEl.textContent = "done";
      }
    } catch (e) {
      statusEl.textContent = "error";
      rawWrap.style.display = "block";
      toggleRaw.disabled = false;
      toggleRaw.textContent = "Hide raw";
      raw.textContent = String(e);
    } finally {
      btn.disabled = false;
    }
  });
</script>
</body>
</html>`);
});

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

    // 1) LLM scoring (turn tags + dims + segments + qualitative)
    const scored = await scoreWithModel(turns);

    // 2) Ut series + means
    const utSeriesObjects = computeUtSeries(scored.turn_scores);
    const mean = meanDims(utSeriesObjects);

    // 3) Sp = conceptual persistence (depth × persistence agreement)
    const Sp = computeSpFromTurnScores(scored.turn_scores);

    // 4) Session E (math architecture intact)
    const session = computeSessionE({
      dimMeans: mean,
      UtSeries: utSeriesObjects.map((x) => x.Ut),
      conceptualShare: scored.conceptual_share,
      participationRichness: Sp,
    });

    return res.json({
      ok: true,
      meta: {
        turnsCount: turns.length,
        segmentsCount: scored.segments.length,
        quantitativeSuppressed: false,
        scorerModel: process.env.SCORER_MODEL ?? null,
      },
      segments: scored.segments,
      segmentSummaries: scored.segment_summaries,
      qualitativeSummary: scored.qualitative_summary,
      conceptualShare: scored.conceptual_share,
      turnScores: utSeriesObjects,
      dimensionMeans: mean,
      session: { mode: "quant_qual", ...session },
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