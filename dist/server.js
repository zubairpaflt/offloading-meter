import "dotenv/config";
import express from "express";
import cors from "cors";
import { computeUtSeries, meanDims, computeSessionE } from "./compute.js";
import { scoreWithModel } from "./scoring.js";
const app = express();
const PORT = Number(process.env.PORT ?? 8787);
app.use(cors());
app.use(express.json({ limit: "4mb" }));
function clamp01(x) {
    if (Number.isNaN(x))
        return 0;
    return Math.max(0, Math.min(1, x));
}
/**
 * Your revised interpretation bands:
 * 0.00–0.10 Very Low
 * 0.11–0.20 Low
 * 0.21–0.30 Mild–Moderate
 * 0.31–0.50 Moderate
 * 0.51–0.60 High
 * 0.61–0.70 Very High
 * 0.71+ Exceptional
 */
function engagementLabel(E) {
    const e = clamp01(E);
    if (e <= 0.10)
        return "Very Low";
    if (e <= 0.20)
        return "Low";
    if (e <= 0.30)
        return "Mild–Moderate";
    if (e <= 0.50)
        return "Moderate";
    if (e <= 0.60)
        return "High";
    if (e <= 0.70)
        return "Very High";
    return "Exceptional";
}
/**
 * Sp = conceptual persistence (NOT raw length).
 * - rewards sustained conceptual/mixed streaks and overall conceptual ratio
 * - penalizes tiny sessions so 1–3 high-order questions don't look "very high"
 */
function computeSpFromTurnScores(turnScores) {
    const n = Math.max(1, turnScores.length);
    const isConceptualish = (tag) => tag === "conceptual" || tag === "mixed";
    let conceptualishCount = 0;
    let longestStreak = 0;
    let currentStreak = 0;
    for (const t of turnScores) {
        if (isConceptualish(t.tag)) {
            conceptualishCount++;
            currentStreak++;
            if (currentStreak > longestStreak)
                longestStreak = currentStreak;
        }
        else {
            currentStreak = 0;
        }
    }
    const ratio = conceptualishCount / n; // 0..1
    const streakScore = clamp01((longestStreak - 1) / 4); // 1 at streak>=5, 0 at streak<=1
    let Sp = 0.65 * ratio + 0.35 * streakScore;
    // Small-session penalty: if < 6 user turns, scale down (prevents early-stop inflation)
    const sizeFactor = clamp01(n / 6);
    Sp *= sizeFactor;
    return clamp01(Sp);
}
/**
 * Build a turn list from pasted text.
 * Supports either:
 *  - USER-only lines (default speaker=user)
 *  - Mixed transcripts with prefixes:
 *      U:, User:, U1:
 *      A:, Assistant:, ChatGPT:, A1:
 *
 * NOTE: We keep both user+assistant turns for context, but scoring.ts only scores USER turns.
 */
function buildTurns(text) {
    const lines = text
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
    const turns = [];
    let idx = 1;
    for (const line of lines) {
        const raw = line.trim();
        if (!raw)
            continue;
        const userPrefix = /^(\s*)(u(?:ser)?\s*\d*)\s*[:\-]\s*/i;
        const asstPrefix = /^(\s*)(a(?:ssistant)?|chatgpt)\s*\d*\s*[:\-]\s*/i;
        let speaker = "user";
        let textOut = raw;
        if (asstPrefix.test(raw)) {
            speaker = "assistant";
            textOut = raw.replace(asstPrefix, "");
        }
        else if (userPrefix.test(raw)) {
            speaker = "user";
            textOut = raw.replace(userPrefix, "");
        }
        else {
            speaker = "user";
            textOut = raw;
        }
        const clean = textOut.trim();
        if (!clean)
            continue;
        turns.push({
            id: `turn_${idx++}`,
            speaker,
            text: clean
        });
    }
    return turns;
}
function twoLineSummary(s) {
    const t = (s ?? "").replace(/\s+/g, " ").trim();
    if (!t)
        return "";
    // split on sentence endings; keep first 2 meaningful chunks
    const parts = t.split(/(?<=[.!?])\s+/).map(x => x.trim()).filter(Boolean);
    if (parts.length <= 2)
        return parts.join(" ");
    return `${parts[0]} ${parts[1]}`;
}
// ✅ UI
app.get("/", (_req, res) => {
    res.type("html").send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Cognitive Engagement Insight</title>
  <style>
    :root { --bg:#0b0d12; --card:#121622; --muted:#a7b0c0; --text:#e9edf5; --line:#20283a; --soft:#0f1422; }
    body { margin:0; font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial;
           background: radial-gradient(1200px 600px at 20% 0%, #1a2140 0%, var(--bg) 60%);
           color: var(--text); }
    .wrap { max-width: 980px; margin: 26px auto; padding: 0 16px; }
    h1 { margin: 0 0 8px; font-size: 26px; letter-spacing: .2px; }
    .desc { margin:0 0 14px; color: var(--muted); line-height: 1.45; max-width: 75ch; }
    .note { margin:0 0 18px; color: var(--muted); font-size: 12px; }
    .grid { display:grid; grid-template-columns: 1.15fr .85fr; gap: 14px; }
    @media (max-width: 900px){ .grid{ grid-template-columns:1fr; } }
    .card { background: rgba(18,22,34,.92); border:1px solid var(--line); border-radius: 16px; padding: 14px; box-shadow: 0 8px 30px rgba(0,0,0,.25); }
    textarea { width:100%; min-height: 220px; padding: 12px 12px; border-radius: 12px;
               background: var(--soft); color: var(--text); border:1px solid var(--line); outline:none;
               font-size: 13.5px; line-height: 1.38; resize: vertical; }
    textarea:focus { border-color:#3a4a77; box-shadow: 0 0 0 3px rgba(88,120,255,.15); }
    .row { display:flex; gap:10px; align-items:center; flex-wrap:wrap; margin-top: 10px; }
    button { padding: 10px 12px; border-radius: 12px; border: 1px solid #2a3552;
             background: linear-gradient(180deg, #2b3b6b, #1a2341); color: var(--text);
             font-weight: 600; cursor:pointer; }
    button:disabled { opacity:.6; cursor:not-allowed; }
    .ghost { background: transparent; border:1px solid var(--line); }
    .pill { padding: 6px 10px; background: var(--soft); border:1px solid var(--line); border-radius:999px; font-size:12px; color: var(--muted); }
    .kpi { display:grid; grid-template-columns: repeat(2, minmax(0,1fr)); gap: 10px; margin-top:10px; }
    .k { background: var(--soft); border:1px solid var(--line); border-radius: 14px; padding: 10px; }
    .k .t { font-size: 12px; color: var(--muted); margin-bottom: 6px; }
    .k .v { font-size: 20px; font-weight: 800; letter-spacing:.2px; }
    .k .s { margin-top: 6px; font-size: 12px; color: var(--muted); line-height: 1.35; }
    .summaryBox { margin-top: 10px; padding: 12px; border-radius: 14px; border:1px solid var(--line); background: var(--soft); }
    .summaryBox .t { font-size: 12px; color: var(--muted); margin-bottom: 8px; }
    .summaryBox .p { margin:0; color: var(--text); line-height: 1.45; font-size: 13px; }
    details { margin-top: 12px; }
    summary { cursor:pointer; user-select:none; color: var(--text); font-weight: 700; }
    .subcard { margin-top: 10px; padding: 12px; border-radius: 14px; border:1px solid var(--line); background: var(--soft); }
    .subcard h3 { margin: 0 0 8px; font-size: 13px; color: var(--muted); font-weight: 700; }
    .seg { padding: 10px; border:1px solid var(--line); border-radius: 14px; background: #0d1220; margin-top:10px; }
    .seg h4 { margin:0 0 6px; font-size: 14px; }
    .seg p { margin:0; color: var(--muted); line-height: 1.45; font-size: 13px; }
    pre { background: #0d1220; border:1px solid var(--line); border-radius: 14px; padding: 10px; overflow:auto; font-size: 12px; color:#d8deea; }
    .small { font-size: 12px; color: var(--muted); }
  </style>
</head>
<body>
  <div class="wrap">
    <h1>Cognitive Engagement Insight</h1>

    <p class="desc">
      This app estimates how you engaged with AI during a conversation.
      It looks for patterns such as conceptual questioning, reasoning, reflection, evaluation, and sustained participation.
      It does <b>not</b> measure intelligence, correctness, or personality.
    </p>

    <p class="note">
      You can paste <b>only user lines</b> (one per line) or a full transcript using <b>U:</b>/<b>A:</b>.
      Results reflect interaction style within this session and may change across topics and goals.
    </p>

    <div class="grid">
      <div class="card">
        <div class="small">Paste conversation</div>
        <textarea id="text" placeholder="Example (USER-only):
Why does inflation happen?
Compare demand-pull vs cost-push.
Let me test my understanding: ...

Example (FULL transcript):
U: Why does inflation happen?
A: ...
U: What are limitations of this view?
A: ..."></textarea>

        <div class="row">
          <button id="btn">Analyze</button>
          <span class="pill" id="status">idle</span>
        </div>
      </div>

      <div class="card">
        <div class="small">Results</div>

        <div class="kpi">
          <div class="k">
            <div class="t">Cognitive Engagement</div>
            <div class="v"><span id="kE">—</span> <span class="pill" id="kEBand">—</span></div>
            <div class="s" id="kEHint">—</div>
          </div>

          <div class="k">
            <div class="t">Conceptual Participation</div>
            <div class="v" id="kConcept">—</div>
            <div class="s" id="kConceptHint">—</div>
          </div>
        </div>

        <div class="summaryBox">
          <div class="t">Two-line summary</div>
          <p class="p" id="twoLine">—</p>
        </div>

        <details id="advanced">
          <summary>Show detailed analysis</summary>

          <div class="subcard">
            <h3>Session details</h3>
            <div class="row">
              <span class="pill" id="kTurns">User turns: —</span>
              <span class="pill" id="kSeg">Themes: —</span>
              <span class="pill" id="trendPill">Trend: —</span>
              <span class="pill" id="spPill">Persistence (Sp): —</span>
            </div>
          </div>

          <div class="subcard">
            <h3>Conversation themes</h3>
            <div id="segments"></div>
          </div>

          <div class="subcard">
            <h3>Full session summary</h3>
            <div class="seg" style="margin-top:10px;">
              <p id="qual" style="margin:0;color:var(--muted);line-height:1.45;font-size:13px;">—</p>
            </div>
          </div>

          <div class="subcard">
            <h3>Raw JSON (optional)</h3>
            <pre id="raw">{}</pre>
          </div>
        </details>
      </div>
    </div>
  </div>

<script>
  const btn = document.getElementById("btn");
  const textEl = document.getElementById("text");
  const statusEl = document.getElementById("status");

  const kE = document.getElementById("kE");
  const kEBand = document.getElementById("kEBand");
  const kEHint = document.getElementById("kEHint");

  const kConcept = document.getElementById("kConcept");
  const kConceptHint = document.getElementById("kConceptHint");

  const twoLine = document.getElementById("twoLine");

  const kTurns = document.getElementById("kTurns");
  const kSeg = document.getElementById("kSeg");
  const trendPill = document.getElementById("trendPill");
  const spPill = document.getElementById("spPill");

  const segmentsWrap = document.getElementById("segments");
  const qualEl = document.getElementById("qual");
  const raw = document.getElementById("raw");

  function fmt(n, digits=2){
    if (n === null || n === undefined || Number.isNaN(Number(n))) return "—";
    return Number(n).toFixed(digits);
  }

  function engagementLabel(e){
    const x = Math.max(0, Math.min(1, Number(e)));
    if (x <= 0.10) return "Very Low";
    if (x <= 0.20) return "Low";
    if (x <= 0.30) return "Mild–Moderate";
    if (x <= 0.50) return "Moderate";
    if (x <= 0.60) return "High";
    if (x <= 0.70) return "Very High";
    return "Exceptional";
  }

  function sentenceTwoLine(s){
    const t = String(s||"").replace(/\\s+/g," ").trim();
    if (!t) return "—";
    const parts = t.split(/(?<=[.!?])\\s+/).map(x=>x.trim()).filter(Boolean);
    if (parts.length <= 2) return parts.join(" ");
    return parts[0] + " " + parts[1];
  }

  function conceptHint(cs){
    const x = Math.max(0, Math.min(1, Number(cs)));
    if (x < 0.15) return "Mostly retrieval, formatting, or delegation.";
    if (x < 0.35) return "Some conceptual turns, but many operational turns.";
    if (x < 0.60) return "Meaningful conceptual participation mixed with operational turns.";
    return "Most turns show conceptual or reflective engagement.";
  }

  function engagementHint(e){
    const lab = engagementLabel(e);
    if (lab === "Very Low") return "Mostly operational use (formatting, simple retrieval, or delegation).";
    if (lab === "Low") return "Light engagement with limited conceptual elaboration.";
    if (lab === "Mild–Moderate") return "Conceptual engagement is emerging but not sustained.";
    if (lab === "Moderate") return "Meaningful engagement with mixed conceptual + operational turns.";
    if (lab === "High") return "Strong sustained conceptual participation and persistence.";
    if (lab === "Very High") return "Deep, sustained conceptual engagement across the session.";
    return "Unusually strong reflective, integrative, sustained engagement.";
  }

  function renderSegments(segs, segSummaries){
    segmentsWrap.innerHTML = "";
    const sums = new Map((segSummaries||[]).map(x => [x.segmentId, x.summary]));
    if (!segs || !segs.length){
      segmentsWrap.innerHTML = '<div class="seg"><p>No themes returned.</p></div>';
      return;
    }
    segs.forEach(s => {
      const div = document.createElement("div");
      div.className = "seg";
      const turns = (s.turnIds||[]).length;
      const summary = sums.get(s.segmentId) || "";
      div.innerHTML = \`
        <h4>\${s.label} <span class="pill" style="margin-left:8px;">\${turns} turns</span></h4>
        <p>\${summary || "—"}</p>\`;
      segmentsWrap.appendChild(div);
    });
  }

  btn.addEventListener("click", async () => {
    const text = (textEl.value || "").trim();
    if (!text) { alert("Please paste some conversation text first."); return; }

    btn.disabled = true;
    statusEl.textContent = "working...";

    // reset
    kE.textContent = "—";
    kEBand.textContent = "—";
    kEHint.textContent = "—";
    kConcept.textContent = "—";
    kConceptHint.textContent = "—";
    twoLine.textContent = "—";
    kTurns.textContent = "User turns: —";
    kSeg.textContent = "Themes: —";
    trendPill.textContent = "Trend: —";
    spPill.textContent = "Persistence (Sp): —";
    segmentsWrap.innerHTML = "";
    qualEl.textContent = "—";
    raw.textContent = "{}";

    try {
      const resp = await fetch("/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text })
      });

      const data = await resp.json();
      raw.textContent = JSON.stringify(data, null, 2);

      if (!resp.ok || !data?.ok){
        statusEl.textContent = "error";
        alert(data?.error || "Analyze failed");
      } else {
        const E = data?.session?.E;
        const Sc = data?.conceptualShare;

        kE.textContent = fmt(E, 3);
        kEBand.textContent = engagementLabel(E);
        kEHint.textContent = engagementHint(E);

        kConcept.textContent = fmt(Sc, 2);
        kConceptHint.textContent = conceptHint(Sc);

        twoLine.textContent = sentenceTwoLine(data?.qualitativeSummary);

        kTurns.textContent = "User turns: " + (data?.meta?.userTurnsCount ?? "—");
        kSeg.textContent = "Themes: " + (data?.meta?.segmentsCount ?? "—");
        trendPill.textContent = "Trend: " + (data?.session?.tr ?? "—");
        spPill.textContent = "Persistence (Sp): " + fmt(data?.session?.Sp, 2);

        renderSegments(data?.segments, data?.segmentSummaries);
        qualEl.textContent = data?.qualitativeSummary ?? "—";

        statusEl.textContent = "done";
      }
    } catch (e) {
      statusEl.textContent = "error";
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
        const text = typeof body.text === "string"
            ? body.text
            : Array.isArray(body.turns)
                ? body.turns.join("\n")
                : "";
        if (!text.trim()) {
            return res.status(400).json({ ok: false, error: "Provide { text } or { turns }" });
        }
        const turns = buildTurns(text);
        // 1) LLM scoring (turn tags + dims + segments + qualitative)
        // scoring.ts scores ONLY user turns internally
        const scored = await scoreWithModel(turns);
        // 2) Ut series + means
        const utSeriesObjects = computeUtSeries(scored.turn_scores);
        const mean = meanDims(utSeriesObjects);
        // 3) Sp = conceptual persistence (depth × persistence)
        const Sp = computeSpFromTurnScores(scored.turn_scores);
        // 4) Session E (math architecture intact)
        const session = computeSessionE({
            dimMeans: mean,
            UtSeries: utSeriesObjects.map((x) => x.Ut),
            conceptualShare: scored.conceptual_share,
            participationRichness: Sp
        });
        return res.json({
            ok: true,
            meta: {
                userTurnsCount: scored.turn_scores.length,
                segmentsCount: scored.segments.length,
                quantitativeSuppressed: false,
                scorerModel: process.env.SCORER_MODEL ?? null
            },
            segments: scored.segments,
            segmentSummaries: scored.segment_summaries,
            qualitativeSummary: scored.qualitative_summary,
            conceptualShare: scored.conceptual_share,
            // still returned for debugging/advanced users
            turnScores: utSeriesObjects,
            dimensionMeans: mean,
            // mode + session values
            session: {
                mode: "quant_qual",
                ...session,
                // add friendly label (does not change math)
                engagementLabel: engagementLabel(session.E)
            }
        });
    }
    catch (error) {
        console.error(error?.stack || error);
        return res.status(500).json({ ok: false, error: error?.message || "Server error" });
    }
});
app.listen(PORT, () => {
    console.log(`✅ Server listening on http://localhost:${PORT}`);
});
