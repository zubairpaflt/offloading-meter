const reportBySession = new Map();
const meterBySession = new Map();
export function setLastReport(sessionId, report) {
    reportBySession.set(sessionId, report);
}
export function getLastReport(sessionId) {
    return reportBySession.get(sessionId) ?? null;
}
export function setLastMeter(sessionId, meter) {
    meterBySession.set(sessionId, meter);
}
export function getLastMeter(sessionId) {
    return meterBySession.get(sessionId) ?? null;
}
