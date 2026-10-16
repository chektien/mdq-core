/** The part of an open question the countdown needs. */
export interface CountdownQuestion {
  startedAt: number;
  timeLimitSec: number | null;
  deadlineAt?: number | null;
}

/**
 * The difference between the server's clock and this device's, estimated from
 * the countdown the server last reported. Ticks carry whole seconds, so the
 * estimate is good to about a second, which is all the countdown shows.
 */
export function clockOffsetFromTick(question: CountdownQuestion, remainingSec: number, localNow: number): number {
  if (question.timeLimitSec === null || question.deadlineAt === null) return 0;
  return (question.deadlineAt ?? question.startedAt + question.timeLimitSec * 1000) - remainingSec * 1000 - localNow;
}

/**
 * Seconds left on an open question, worked out on this device while it has no
 * connection to receive the server's ticks. The next tick replaces it.
 */
export function localRemainingSec(question: CountdownQuestion, localNow: number, clockOffsetMs = 0): number | null {
  if (question.timeLimitSec === null || question.deadlineAt === null) return null;
  const due = question.deadlineAt ?? question.startedAt + question.timeLimitSec * 1000;
  return Math.min(question.timeLimitSec, Math.max(0, Math.ceil((due - localNow - clockOffsetMs) / 1000)));
}
