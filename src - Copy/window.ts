import { Turn } from "./types.js";

/**
 * Takes the last N USER turns, but keeps assistant turns in between
 * by slicing from the position of the Nth-from-last user turn to the end.
 */
export function sliceRecentWindow(turns: Turn[], windowUserTurns: number) {
  const userIdx: number[] = [];
  for (let i = 0; i < turns.length; i++) {
    if (turns[i].speaker === "user") userIdx.push(i);
  }

  const useN = Math.max(1, windowUserTurns);
  const startUserPos = Math.max(0, userIdx.length - useN);
  const startIdx = userIdx[startUserPos] ?? 0;

  const slicedTurns = turns.slice(startIdx);
  const userTurnsUsed = slicedTurns.filter(t => t.speaker === "user").length;

  return { slicedTurns, userTurnsUsed };
}