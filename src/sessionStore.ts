import { MeterPreview, SessionReport } from "./types.js";

const reportBySession = new Map<string, SessionReport>();
const meterBySession = new Map<string, MeterPreview>();

export function setLastReport(sessionId: string, report: SessionReport) {
  reportBySession.set(sessionId, report);
}

export function getLastReport(sessionId: string): SessionReport | null {
  return reportBySession.get(sessionId) ?? null;
}

export function setLastMeter(sessionId: string, meter: MeterPreview) {
  meterBySession.set(sessionId, meter);
}

export function getLastMeter(sessionId: string): MeterPreview | null {
  return meterBySession.get(sessionId) ?? null;
}