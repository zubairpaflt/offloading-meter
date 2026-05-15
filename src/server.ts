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
 * ✅ 0.10-step bands in the CODE format your frontend expects
 * (because stateForEband() in the HTML uses these codes)
 */
type BandCode =
  | "very_low"
  | "low"
  | "mild_moderate"
  | "moderate"
  | "moderate_high"
  | "high"
  | "very_high"
  | "advanced";

function band10Code(xRaw: number): BandCode {
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

function labelFromBand10(b: BandCode) {
  switch (b) {
    case "very_low": return "Very Low";
    case "low": return "Low";
    case "mild_moderate": return "Mild–Moderate";
    case "moderate": return "Moderate";
    case "moderate_high": return "Moderate–High";
    case "high": return "High";
    case "very_high": return "Very High";
    case "advanced": return "Advanced";
    default: return "—";
  }
}

// ✅ 0.10-step CP bands (same code system)
function cpBand10(cp: number): BandCode {
  return band10Code(cp);
}

/**
 * Summary must match E + CP.
 * ✅ Stability sentence now treats 10+ turns as stable (not "minimum reliable").
 */
function alignedLevel1Summary(params: {
  engagementBand: BandCode;
  CP: number;
  userTurnsCount: number;
}) {
  const { engagementBand, CP, userTurnsCount } = params;
  const cpB = cpBand10(CP);

  let s1 = "";
  switch (engagementBand) {
    case "very_low":
      s1 = "The interaction shows very low observable cognitive engagement, with mostly operational or minimal participation.";
      break;
    case "low":
      s1 = "The interaction shows low cognitive engagement, with limited elaboration beyond basic requests.";
      break;
    case "mild_moderate":
      s1 = "The interaction shows emerging engagement, with early conceptual reasoning beginning to appear but not consistently sustained.";
      break;
    case "moderate":
      s1 = "The interaction shows moderate engagement, with some conceptual reasoning but not sustained throughout.";
      break;
    case "moderate_high":
      s1 = "The interaction shows solid engagement, with meaningful conceptual reasoning appearing regularly across turns.";
      break;
    case "high":
      s1 = "The interaction shows high engagement, with frequent reasoning and meaningful conceptual exploration across turns.";
      break;
    case "very_high":
      s1 = "The interaction shows very high engagement, with sustained conceptual reasoning and reflective inquiry across the session.";
      break;
    case "advanced":
      s1 = "The interaction shows advanced engagement, marked by sustained high-level conceptual reasoning, integration, and reflective depth.";
      break;
    default:
      s1 = "The interaction shows mixed engagement patterns across turns.";
  }

  let s2 = "";
  switch (cpB) {
    case "very_low":
      s2 = "Conceptual participation is very low, with most user turns remaining operational rather than exploratory.";
      break;
    case "low":
      s2 = "Conceptual participation is low, with conceptual turns appearing infrequently.";
      break;
    case "mild_moderate":
      s2 = "Conceptual participation is mild–moderate, with some conceptual turns but limited sustained elaboration.";
      break;
    case "moderate":
      s2 = "Conceptual participation is moderate, with regular conceptual contributions alongside some operational turns.";
      break;
    case "moderate_high":
      s2 = "Conceptual participation is moderate–high, with many turns showing reasoning, comparison, or explanation.";
      break;
    case "high":
      s2 = "Conceptual participation is high, with most user turns contributing reasoning, critique, or integration.";
      break;
    case "very_high":
      s2 = "Conceptual participation is very high, with sustained reasoning and frequent synthesis across turns.";
      break;
    case "advanced":
      s2 = "Conceptual participation is advanced, with consistently deep reasoning and integrative synthesis.";
      break;
    default:
      s2 = "Conceptual participation varies across turns.";
  }

  const s3 =
    userTurnsCount >= 10
      ? "The estimate is supported by sufficient interaction length for stability."
      : "The estimate is based on the minimum reliable turn count, so stability may improve with longer sessions.";

  return [s1, s2, s3].filter(Boolean).slice(0, 3).join(" ");
}

/**
 * Sp = conceptual persistence (NOT raw length).
 * Rewards sustained conceptual/mixed streaks + overall conceptual ratio.
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

  const ratio = conceptualishCount / n;
  const streakScore = clamp01((longestStreak - 1) / 4);

  let Sp = 0.65 * ratio + 0.35 * streakScore;

  // small-session penalty under 6 turns
  const sizeFactor = clamp01(n / 6);
  Sp *= sizeFactor;

  return clamp01(Sp);
}

function buildTurns(text: string) {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  const turns: Array<{ id: string; speaker: "user" | "assistant"; text: string }> = [];
  let idx = 1;

  for (const line of lines) {
    const raw = line.trim();
    if (!raw) continue;

    const userPrefix = /^(\s*)(u(?:ser)?\s*\d*)\s*[:\-]\s*/i;
    const asstPrefix = /^(\s*)(a(?:ssistant)?|chatgpt)\s*\d*\s*[:\-]\s*/i;

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

    turns.push({ id: `turn_${idx++}`, speaker, text: clean });
  }

  return turns;
}

app.get("/", (_req, res) => {
  // Keep your exact HTML UI (unchanged)
  // (Copied from your file so you can just replace everything safely)
  res.type("html").send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Cognitive Engagement Insight</title>
  <style>
    :root{
      --bg:#0b0d12; --card:#121622; --muted:#a7b0c0; --text:#e9edf5;
      --line:#20283a; --soft:#0f1422;

      --g-red:    linear-gradient(135deg, rgba(255,80,80,.30), rgba(255,80,80,.05));
      --g-orange: linear-gradient(135deg, rgba(255,170,70,.30), rgba(255,170,70,.05));
      --g-yellow: linear-gradient(135deg, rgba(255,230,90,.26), rgba(255,230,90,.05));
      --g-green:  linear-gradient(135deg, rgba(90,255,160,.26), rgba(90,255,160,.05));
      --g-cyan:   linear-gradient(135deg, rgba(90,210,255,.26), rgba(90,210,255,.05));
      --g-violet: linear-gradient(135deg, rgba(190,120,255,.28), rgba(190,120,255,.06));

      --b-red:    rgba(255,80,80,.55);
      --b-orange: rgba(255,170,70,.55);
      --b-yellow: rgba(255,230,90,.45);
      --b-green:  rgba(90,255,160,.45);
      --b-cyan:   rgba(90,210,255,.45);
      --b-violet: rgba(190,120,255,.45);
    }

    body{
      margin:0;
      font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial;
      background: radial-gradient(1200px 600px at 20% 0%, #1a2140 0%, var(--bg) 60%);
      color: var(--text);
    }
    .wrap{ max-width: 1120px; margin: 26px auto; padding: 0 16px; }
    h1{ margin: 0 0 8px; font-size: 26px; letter-spacing: .2px; }
    .desc{ margin:0 0 14px; color: var(--muted); line-height: 1.45; max-width: 90ch; }

    .grid{ display:grid; grid-template-columns: 1.2fr .8fr; gap: 14px; }
    @media (max-width: 980px){ .grid{ grid-template-columns:1fr; } }

    .card{
      background: rgba(18,22,34,.92);
      border:1px solid var(--line);
      border-radius: 18px;
      padding: 14px;
      box-shadow: 0 10px 34px rgba(0,0,0,.28);
    }

    textarea{
      width:100%;
      min-height: 230px;
      padding: 12px 12px;
      border-radius: 14px;
      background: var(--soft);
      color: var(--text);
      border:1px solid var(--line);
      outline:none;
      font-size: 13.5px;
      line-height: 1.38;
      resize: vertical;
    }
    textarea:focus{ border-color:#3a4a77; box-shadow: 0 0 0 3px rgba(88,120,255,.15); }

    .row{ display:flex; gap:10px; align-items:center; flex-wrap:wrap; margin-top: 10px; }
    button{
      padding: 10px 12px;
      border-radius: 12px;
      border: 1px solid #2a3552;
      background: linear-gradient(180deg, #2b3b6b, #1a2341);
      color: var(--text);
      font-weight: 800;
      cursor:pointer;
    }
    button:disabled{ opacity:.6; cursor:not-allowed; }

    .pill{
      padding: 6px 10px;
      background: var(--soft);
      border:1px solid var(--line);
      border-radius:999px;
      font-size:12px;
      color: var(--muted);
      font-weight: 700;
    }

    .summaryBox{
      margin-top: 10px;
      padding: 12px;
      border-radius: 16px;
      border:1px solid var(--line);
      background: linear-gradient(180deg, rgba(15,20,34,.95), rgba(15,20,34,.75));
    }
    .summaryBox .t{ font-size: 12px; color: var(--muted); margin-bottom: 8px; font-weight: 900; letter-spacing:.2px; }
    .summaryBox .p{ margin:0; color: var(--text); line-height: 1.55; font-size: 13.2px; }

    details{ margin-top: 12px; }
    summary{ cursor:pointer; user-select:none; color: var(--text); font-weight: 900; }
    pre{
      background: #0d1220;
      border:1px solid var(--line);
      border-radius: 16px;
      padding: 10px;
      overflow:auto;
      font-size: 12px;
      color:#d8deea;
    }

    .small{ font-size: 12px; color: var(--muted); font-weight: 900; letter-spacing:.2px; }

    .kpi{ display:grid; grid-template-columns: repeat(2, minmax(0,1fr)); gap: 10px; margin-top:10px; }
    .k{
      position: relative;
      background: var(--soft);
      border:1px solid var(--line);
      border-radius: 16px;
      padding: 12px;
      overflow:hidden;
    }
    .k::before{
      content:"";
      position:absolute;
      inset:-1px;
      opacity:0;
      transition: opacity .18s ease;
      pointer-events:none;
    }
    .k .t{ font-size: 12px; color: var(--muted); margin-bottom: 6px; font-weight: 900; }
    .k .v{ font-size: 22px; font-weight: 950; letter-spacing:.2px; }
    .k .s{ margin-top: 6px; font-size: 12px; color: var(--muted); line-height: 1.35; }

    .k.state-red{ border-color: rgba(255,80,80,.35); }
    .k.state-red::before{ background: var(--g-red); opacity:1; }
    .k.state-orange{ border-color: rgba(255,170,70,.35); }
    .k.state-orange::before{ background: var(--g-orange); opacity:1; }
    .k.state-yellow{ border-color: rgba(255,230,90,.28); }
    .k.state-yellow::before{ background: var(--g-yellow); opacity:1; }
    .k.state-green{ border-color: rgba(90,255,160,.28); }
    .k.state-green::before{ background: var(--g-green); opacity:1; }
    .k.state-cyan{ border-color: rgba(90,210,255,.28); }
    .k.state-cyan::before{ background: var(--g-cyan); opacity:1; }
    .k.state-violet{ border-color: rgba(190,120,255,.28); }
    .k.state-violet::before{ background: var(--g-violet); opacity:1; }

    .badge{
      display:inline-flex;
      align-items:center;
      gap:6px;
      padding: 6px 10px;
      border-radius: 999px;
      border: 1px solid var(--line);
      background: rgba(15,20,34,.75);
      color: var(--text);
      font-size: 12px;
      font-weight: 900;
    }
    .dot{ width:9px; height:9px; border-radius:999px; display:inline-block; background: rgba(255,255,255,.35); }

    .badge.red{ border-color: rgba(255,80,80,.35); }
    .badge.red .dot{ background: var(--b-red); }
    .badge.orange{ border-color: rgba(255,170,70,.35); }
    .badge.orange .dot{ background: var(--b-orange); }
    .badge.yellow{ border-color: rgba(255,230,90,.28); }
    .badge.yellow .dot{ background: var(--b-yellow); }
    .badge.green{ border-color: rgba(90,255,160,.28); }
    .badge.green .dot{ background: var(--b-green); }
    .badge.cyan{ border-color: rgba(90,210,255,.28); }
    .badge.cyan .dot{ background: var(--b-cyan); }
    .badge.violet{ border-color: rgba(190,120,255,.28); }
    .badge.violet .dot{ background: var(--b-violet); }
  </style>
</head>
<body>
  <div class="wrap">
    <h1>Cognitive Engagement Insight</h1>
    <p class="desc">
      Level 1 shows three numbers: Cognitive Engagement (E), Conceptual Participation (CP), and Collaborative Index (CI = average of E and CP).
    </p>

    <div class="grid">
      <div class="card">
        <div class="small">Paste conversation</div>
        <textarea id="text" placeholder="U: ...&#10;A: ...&#10;U: ..."></textarea>

        <div class="row">
          <button id="btn">Analyze</button>
          <span class="pill" id="status">idle</span>
        </div>

        <div class="summaryBox">
          <div class="t">Summary</div>
          <p class="p" id="summary">Paste text and click Analyze.</p>
        </div>

        <details>
          <summary>Raw JSON</summary>
          <pre id="raw">(empty)</pre>
        </details>
      </div>

      <div class="card">
        <div class="small">Level 1 snapshot</div>

        <div class="kpi">
          <div class="k" id="cardE">
            <div class="t">Cognitive Engagement</div>
            <div class="v" id="E">—</div>
            <div class="s" id="Elabel">—</div>
          </div>

          <div class="k" id="cardCP">
            <div class="t">Conceptual Participation</div>
            <div class="v" id="CP">—</div>
            <div class="s">
              <span class="badge" id="CPbadge"><span class="dot"></span><span id="CPband">—</span></span>
              <span style="display:block; margin-top:8px;">Share of conceptual user turns</span>
            </div>
          </div>

          <div class="k" id="cardCI">
            <div class="t">Collaborative Index</div>
            <div class="v" id="CI">—</div>
            <div class="s">
              <span class="badge" id="CIbadge"><span class="dot"></span><span id="CIband">—</span></span>
              <span style="display:block; margin-top:8px;">Average of E and CP</span>
            </div>
          </div>

          <div class="k" id="cardT">
            <div class="t">User Turns</div>
            <div class="v" id="T">—</div>
            <div class="s" id="Tnote">—</div>
          </div>
        </div>

      </div>
    </div>

    <script>
      const $ = (id) => document.getElementById(id);

      function clearStates(el){
        el.classList.remove("state-red","state-orange","state-yellow","state-green","state-cyan","state-violet");
      }
      function setState(el, state){
        clearStates(el);
        if(state) el.classList.add("state-" + state);
      }

      function stateForEband(band){
        if(band === "very_low") return "red";
        if(band === "low") return "orange";
        if(band === "mild_moderate") return "yellow";
        if(band === "moderate") return "yellow";
        if(band === "moderate_high") return "green";
        if(band === "high") return "green";
        if(band === "very_high") return "cyan";
        if(band === "advanced") return "violet";
        return "yellow";
      }

      // ✅ 0.10-step bands for CP/CI display
      function band10(x){
        const v = Math.max(0, Math.min(1, Number(x)||0));
        if(v <= 0.10) return "Very Low";
        if(v <= 0.20) return "Low";
        if(v <= 0.30) return "Mild–Moderate";
        if(v <= 0.40) return "Moderate";
        if(v <= 0.50) return "Moderate–High";
        if(v <= 0.60) return "High";
        if(v <= 0.70) return "Very High";
        return "Advanced";
      }

      function stateForBandLabel(lbl){
        if(lbl === "Very Low") return "orange";
        if(lbl === "Low") return "yellow";
        if(lbl === "Mild–Moderate") return "green";
        if(lbl === "Moderate") return "green";
        if(lbl === "Moderate–High") return "cyan";
        if(lbl === "High") return "cyan";
        if(lbl === "Very High") return "violet";
        if(lbl === "Advanced") return "violet";
        return "yellow";
      }

      function setBadge(badgeEl, state){
        badgeEl.classList.remove("red","orange","yellow","green","cyan","violet");
        badgeEl.classList.add(state);
      }

      const btn = $("btn");
      const status = $("status");

      btn.onclick = async () => {
        btn.disabled = true;
        status.textContent = "working...";
        $("summary").textContent = "Analyzing...";
        $("raw").textContent = "(loading...)";

        try {
          const text = $("text").value || "";
          const resp = await fetch("/analyze", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ text })
          });
          const data = await resp.json();
          $("raw").textContent = JSON.stringify(data, null, 2);

          const turns = data?.meta?.userTurnsCount ?? 0;
          $("T").textContent = String(turns);

          if (data?.meta?.quantitativeSuppressed) {
            $("E").textContent = "—";
            $("CP").textContent = "—";
            $("CI").textContent = "—";
            $("Elabel").textContent = data?.meta?.suppressedReason || "Quantitative estimates suppressed.";
            $("Tnote").textContent = "Needs ≥ 5 user turns for numeric estimate";

            setState($("cardE"), "orange");
            setState($("cardCP"), "orange");
            setState($("cardCI"), "orange");
            setState($("cardT"), "orange");

            $("CPband").textContent = "—";
            $("CIband").textContent = "—";
            setBadge($("CPbadge"), "orange");
            setBadge($("CIbadge"), "orange");
          } else {
            const E = Number(data?.level1?.E ?? 0);
            const eBand = data?.level1?.engagementBand ?? "moderate";
            const eLabel = data?.level1?.engagementLabel ?? "—";

            const CP = Number(data?.level1?.CP ?? 0);
            const CI = Number(data?.level1?.collaborativeIndex ?? 0);

            $("E").textContent = E.toFixed(3);
            $("Elabel").textContent = eLabel;
            $("CP").textContent = CP.toFixed(2);
            $("CI").textContent = CI.toFixed(2);

            $("Tnote").textContent = "Sufficient turns for reliability";

            setState($("cardE"), stateForEband(eBand));

            const cpLbl = band10(CP);
            const cpState = stateForBandLabel(cpLbl);
            setState($("cardCP"), cpState);
            $("CPband").textContent = cpLbl;
            setBadge($("CPbadge"), cpState);

            const ciLbl = band10(CI);
            const ciState = stateForBandLabel(ciLbl);
            setState($("cardCI"), ciState);
            $("CIband").textContent = ciLbl;
            setBadge($("CIbadge"), ciState);

            setState($("cardT"), turns >= 10 ? "green" : "yellow");
          }

          $("summary").textContent = data?.qualitativeSummary || "(no summary)";
          status.textContent = "done";
        } catch (e) {
          status.textContent = "error";
          $("summary").textContent = "Error: " + (e?.message || e);
          $("raw").textContent = "(error)";
        } finally {
          btn.disabled = false;
        }
      };
    </script>
  </div>
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

    // ✅ FIX 1: count user turns from parsed turns (source of truth)
    const parsedUserTurnsCount = turns.filter(t => t.speaker === "user").length;

    const scored = await scoreWithModel(turns);

    // Model reliability check (still useful, but not the source of truth for userTurnsCount)
    const MIN_USER_TURNS = 5;

    if (parsedUserTurnsCount < MIN_USER_TURNS) {
      return res.json({
        ok: true,
        meta: {
          userTurnsCount: parsedUserTurnsCount,
          segmentsCount: scored.segments.length,
          quantitativeSuppressed: true,
          suppressedReason: `Quantitative estimates require at least ${MIN_USER_TURNS} user turns.`,
          scorerModel: process.env.SCORER_MODEL ?? null
        },
        qualitativeSummary: scored.qualitative_summary,
        rawModelSummary: scored.qualitative_summary,
        session: { mode: "qual_only" }
      });
    }

    // If model returns no turn_scores, treat as server error (otherwise everything will be zero)
    if (!scored.turn_scores || scored.turn_scores.length === 0) {
      return res.status(500).json({
        ok: false,
        error: "Model returned empty turn_scores. Please retry or check SCORER_MODEL / API key."
      });
    }

    const utSeriesObjects = computeUtSeries(scored.turn_scores);
    const dimMeans = meanDims(utSeriesObjects);

    const Sp = computeSpFromTurnScores(scored.turn_scores);

    const session = computeSessionE({
      dimMeans,
      UtSeries: utSeriesObjects.map((x) => x.Ut),
      conceptualShare: scored.conceptual_share,
      participationRichness: Sp,
      userTurnsCount: parsedUserTurnsCount
    });

    // ✅ FIX 2: use local 0.10 band codes for E (keeps frontend working)
    const Eband = band10Code(session.E);
    const Elabel = labelFromBand10(Eband);

    // Collaborative Index (CI) = average of E and CP
    const CI = clamp01((session.E + scored.conceptual_share) / 2);

    const alignedSummary = alignedLevel1Summary({
      engagementBand: Eband,
      CP: scored.conceptual_share,
      userTurnsCount: parsedUserTurnsCount
    });

    const level1 = {
      E: session.E,
      engagementBand: Eband,
      engagementLabel: Elabel,
      CP: scored.conceptual_share,
      CPBand: cpBand10(scored.conceptual_share),
      collaborativeIndex: CI,
      collaborativeBand: cpBand10(CI),
      userTurns: parsedUserTurnsCount
    };

    const advanced = {
      components: {
        Sd: session.Sd,
        St: session.St,
        Sc: session.Sc,
        Sp: session.Sp,
        Ecore: session.Ecore,
        durationBonus: session.durationBonus,
        qualityGate: session.qualityGate,
        nTurns: session.nTurns,
        trajectory: session.tr
      },
      dimensionMeans: dimMeans,
      dependencyMean: (dimMeans as any).D,
      series: {
        chart: {
          labels: utSeriesObjects.map(x => x.turnId),
          Ut: utSeriesObjects.map(x => x.Ut),
          R: utSeriesObjects.map(x => x.dims.R),
          K: utSeriesObjects.map(x => x.dims.K),
          M: utSeriesObjects.map(x => x.dims.M),
          C: utSeriesObjects.map(x => x.dims.C),
          I: utSeriesObjects.map(x => x.dims.I),
          G: utSeriesObjects.map(x => x.dims.G),
          D: utSeriesObjects.map(x => x.dims.D)
        }
      }
    };

    return res.json({
      ok: true,
      meta: {
        userTurnsCount: parsedUserTurnsCount,
        segmentsCount: scored.segments.length,
        quantitativeSuppressed: false,
        scorerModel: process.env.SCORER_MODEL ?? null
      },
      level1,
      advanced,
      qualitativeSummary: alignedSummary,
      rawModelSummary: scored.qualitative_summary
    });
  } catch (error: any) {
    console.error(error?.stack || error);
    return res.status(500).json({ ok: false, error: error?.message || "Server error" });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Server listening on http://localhost:${PORT}`);
});