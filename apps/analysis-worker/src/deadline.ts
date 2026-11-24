/** Returns the remaining portion of an absolute deadline, never a negative budget. */
export function remainingDeadlineMs(
  deadlineAt: number,
  now = Date.now(),
): number {
  return Math.max(0, deadlineAt - now);
}
