import { getLastMeter, getLastReport } from "./sessionStore.js";
import type { MeterPreview, SessionReport } from "./types.js";

function esc(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function fmt(n?: number) {
  if (typeof n !== "number" || Number.isNaN(n)) return "—";
  return n.toFixed(2);
}

function pct(n?: number) {
  if (typeof n !== "number" || Number.isNaN(n)) return "—";
  return `${Math.round(Math.max(0, Math.min(1, n)) * 100)}%`;
}

function bar(label: string, value?: number) {
  const v = typeof value === "number" ? Math.max(0, Math.min(1, value)) : null;
  const w = v === null ? 0 : Math.round(v * 100);
  return `
    <div class="row">
      <div class="label">${esc(label)}</div>
      <div class="track"><div class="fill" style="width:${w}%"></div></div>
      <div class="val">${v === null ? "—" : w + "%"}</div>
    </div>
  `;
}

function spark(series?: Array<{ Ut: number }>) {
  if (!series?.length) return `<div class="muted">No U<sub>t</sub> series.</div>`;
  return `
    <div class="spark">
      ${series
        .map((p) => {
          const h = Math.round(Math.max(0, Math.min(1, p.Ut)) * 60);
          return `<div class="sparkbar" style="height:${h}px"></div>`;
        })
        .join("")}
    </div>
    <div class="muted">Each bar is one user turn (taller = higher engagement estimate).</div>
  `;
}

function meterCard(m: MeterPreview | null) {
  if (!m) {
    return `
      <div class="card">
        <h2>Live meter</h2>
        <p class="muted">No meter preview yet. Use “Update meter” in the chat.</p>
      </div>
    `;
  }

  const head =
    m.mode === "quant_qual"
      ? `<div class="big"><span class="score">${fmt(m.E_window)}</span><span class="pill">${esc(
          m.band ?? "—"
        )}</span></div>`
      : `<div class="pill warnpill">qual-only</div>`;

  const meta = `
    <div class="meta">
      <div><b>Window:</b> last ${m.userTurnsUsed}/${m.windowUserTurns} user turns</div>
      <div><b>Trajectory:</b> ${esc(m.trajectory ?? "—")}</div>
      <div><b>Conceptual:</b> ${pct(m.conceptualShare)}</div>
      <div><b>Dependency:</b> ${fmt(m.dependencyMean)}</div>
    </div>
  `;

  return `
    <div class="card">
      <h2>Live meter (recent window)</h2>
      ${head}
      ${meta}
      <p class="summary">${esc(m.qualitativeSummary).replace(/\n/g, "<br/>")}</p>
    </div>
  `;
}

function renderReport(r: SessionReport): string {
  const mode = r.mode;

  const title =
    mode === "quant_qual"
      ? "Engagement & Offloading Report"
      : mode === "qual_only"
      ? "Qualitative Report (Quant suppressed)"
      : "No Report";

  const exports = `
    <div class="card">
      <h2>Export</h2>
      <div class="btnrow">
        <a class="btn" href="${esc(r.exportJsonUri ?? "#")}">Export JSON</a>
        <a class="btn" href="${esc(r.exportCsvUri ?? "#")}">Export CSV</a>
      </div>
      <div class="muted">Exports contain only this session’s report.</div>
    </div>
  `;

  const scoreBlock =
    mode === "quant_qual"
      ? `
      <div class="card">
        <h2>Final score</h2>
        <div class="big">
          <span class="score">${fmt(r.E_session)}</span>
          <span class="pill">${esc(r.band ?? "—")}</span>
        </div>
        <div class="meta">
          <div><b>Trajectory:</b> ${esc(r.trajectory ?? "—")}</div>
          <div><b>Conceptual share:</b> ${pct(r.conceptualShare)}</div>
          <div><b>Dependency mean:</b> ${fmt(r.dependencyMean)}</div>
        </div>
      </div>
    `
      : `
      <div class="card warn">
        <h2>Quantitative score not shown</h2>
        <p>${esc(r.reason ?? "Quantitative scoring suppressed for this session.")}</p>
      </div>
    `;

  const dims = r.dimensionMeans;
  const dimsBlock =
    mode === "quant_qual" && dims
      ? `
      <div class="card">
        <h2>7-dimension profile (session means)</h2>
        ${bar("R — Reasoning", dims.R)}
        ${bar("K — Knowledge", dims.K)}
        ${bar("M — Metacognition", dims.M)}
        ${bar("C — Critical evaluation", dims.C)}
        ${bar("I — Initiative", dims.I)}
        ${bar("G — Integration", dims.G)}
        ${bar("D — Dependency (higher = more delegation)", dims.D)}
      </div>
    `
      : "";

  const segments = (r.segments ?? [])
    .map((s) => {
      const share =
        typeof s.shareUserTurns === "number"
          ? `${Math.round(s.shareUserTurns * 100)}%`
          : "—";
      return `<li><b>${esc(s.label)}</b> <span class="muted">(${share} of user turns)</span></li>`;
    })
    .join("");

  const segmentsBlock = `
    <div class="card">
      <h2>Detected segments</h2>
      ${segments ? `<ul>${segments}</ul>` : `<p class="muted">No segments returned.</p>`}
    </div>
  `;

  const segCards = (r.segmentReports ?? [])
    .map((sr) => {
      const d = sr.dimensionMeans;
      const share =
        typeof sr.shareUserTurns === "number"
          ? `${Math.round(sr.shareUserTurns * 100)}%`
          : "—";
      return `
      <div class="card">
        <h2>Segment: ${esc(sr.label)} <span class="muted">(${share})</span></h2>
        <div class="big">
          <span class="score">${fmt(sr.E_segment)}</span>
          <span class="pill">${esc(sr.band ?? "—")}</span>
        </div>
        <div class="meta">
          <div><b>Trajectory:</b> ${esc(sr.trajectory ?? "—")}</div>
          <div><b>Conceptual:</b> ${pct(sr.conceptualShare)}</div>
          <div><b>Dependency:</b> ${fmt(sr.dependencyMean)}</div>
        </div>
        ${
          d
            ? `
          ${bar("R", d.R)} ${bar("K", d.K)} ${bar("M", d.M)} ${bar("C", d.C)}
          ${bar("I", d.I)} ${bar("G", d.G)} ${bar("D", d.D)}
        `
            : ""
        }
        ${sr.qualitativeSummary ? `<p class="summary">${esc(sr.qualitativeSummary)}</p>` : ""}
      </div>
    `;
    })
    .join("");

  const qualBlock = `
    <div class="card">
      <h2>Holistic summary</h2>
      <p class="summary">${esc(r.qualitativeSummary ?? "").replace(/\n/g, "<br/>")}</p>
    </div>
  `;

  const utBlock =
    mode === "quant_qual"
      ? `
      <div class="card">
        <h2>Engagement over turns (U<sub>t</sub>)</h2>
        ${spark((r.UtSeries ?? []).map((x) => ({ Ut: x.Ut })))}
      </div>
    `
      : "";

  return `
    <div class="header">
      <div>
        <h1>${esc(title)}</h1>
        <div class="muted">Session-based estimate of observable engagement using 7 dimensions.</div>
      </div>
    </div>

    ${exports}
    ${scoreBlock}
    ${dimsBlock}
    ${utBlock}
    ${segmentsBlock}

    ${
      segCards
        ? `
      <div class="card">
        <h2>Segment reports</h2>
        <div class="muted">Segments are scored separately to stay valid even when the overall session is mixed.</div>
      </div>
      ${segCards}
    `
        : ""
    }

    ${qualBlock}
  `;
}

function page(body: string): string {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Offloading Meter</title>
  <style>
    :root { --bg:#0b0f17; --card:#111827; --text:#e5e7eb; --muted:#9ca3af; --accent:#60a5fa; --warn:#f59e0b; }
    body { margin:0; background:var(--bg); color:var(--text); font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial; }
    .container { max-width: 900px; margin: 0 auto; padding: 18px; }
    .header { display:flex; align-items:flex-end; justify-content:space-between; margin-bottom: 10px; }
    h1 { font-size: 20px; margin: 0 0 6px 0; }
    h2 { font-size: 16px; margin: 0 0 12px 0; }
    .muted { color: var(--muted); font-size: 13px; }
    .card { background: var(--card); border: 1px solid rgba(255,255,255,0.06); border-radius: 14px; padding: 14px; margin: 12px 0; box-shadow: 0 10px 20px rgba(0,0,0,0.25); }
    .warn { border-color: rgba(245,158,11,0.35); }
    .big { display:flex; align-items:center; gap: 10px; margin-bottom: 10px; }
    .score { font-size: 34px; font-weight: 700; letter-spacing: 0.5px; }
    .pill { padding: 4px 10px; border-radius: 999px; border: 1px solid rgba(96,165,250,0.35); color: var(--accent); font-size: 12px; font-weight: 600; text-transform: uppercase; }
    .warnpill { border-color: rgba(245,158,11,0.45); color: var(--warn); }
    .meta { display:flex; gap: 18px; flex-wrap: wrap; font-size: 13px; color: var(--muted); }
    ul { margin: 8px 0 0 18px; }
    li { margin: 6px 0; }
    .row { display:grid; grid-template-columns: 220px 1fr 60px; gap: 10px; align-items:center; margin: 8px 0; }
    .label { font-size: 13px; color: var(--text); }
    .track { height: 10px; background: rgba(255,255,255,0.08); border-radius: 999px; overflow:hidden; }
    .fill { height: 100%; background: rgba(96,165,250,0.9); }
    .val { font-size: 12px; color: var(--muted); text-align:right; }
    .summary { line-height: 1.45; font-size: 14px; }
    .spark { display:flex; gap: 3px; align-items:flex-end; padding: 10px 6px; background: rgba(255,255,255,0.04); border-radius: 12px; overflow-x:auto; }
    .sparkbar { width: 8px; background: rgba(96,165,250,0.85); border-radius: 4px 4px 0 0; flex: 0 0 auto; }
    .btnrow{display:flex; gap:10px; flex-wrap:wrap;}
    .btn{display:inline-block; padding:10px 12px; border-radius:10px; text-decoration:none;
         color:var(--text); border:1px solid rgba(255,255,255,0.10); background:rgba(255,255,255,0.04);}
    .btn:hover{border-color: rgba(96,165,250,0.45);}
  </style>
</head>
<body>
  ${body}
</body>
</html>`;
}

/**
 * ✅ IMPORTANT:
 * server.ts imports this exact named export:
 *   import { renderReportHTML } from "./ui.js";
 */
export function renderReportHTML(sessionId: string): string {
  const report = getLastReport(sessionId);
  const meter = getLastMeter(sessionId);

  if (!report) {
    return page(`
      <div class="container">
        ${meterCard(meter)}
        <div class="card">
          <h2>No session report yet</h2>
          <p>Run <b>Score session</b> first, then reopen this dashboard.</p>
        </div>
      </div>
    `);
  }

  return page(`
    <div class="container">
      ${meterCard(meter)}
      ${renderReport(report)}
    </div>
  `);
}