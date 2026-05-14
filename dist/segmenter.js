export function decideReportMode(segments, userTurnsCount, minUserTurnsForQuant = 10) {
    if (userTurnsCount < minUserTurnsForQuant) {
        return {
            mode: "qual_only",
            reason: `Too few user turns (${userTurnsCount}) for stable quantitative scoring.`
        };
    }
    const substantial = segments.filter(s => (s.shareUserTurns ?? 0) >= 0.20);
    const dominant = segments.find(s => (s.shareUserTurns ?? 0) >= 0.70);
    if (substantial.length >= 3) {
        return {
            mode: "no_report",
            reason: "Session is highly fragmented across multiple unrelated tasks."
        };
    }
    if (!dominant && substantial.length >= 2) {
        return {
            mode: "qual_only",
            reason: "Multiple unrelated task segments detected; a single quantitative score would be unreliable."
        };
    }
    return { mode: "quant_qual" };
}
