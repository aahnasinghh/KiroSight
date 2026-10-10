/**
 * Deterministic request freshness tracking ("latest utterance wins").
 *
 * Every request receives a monotonically increasing id. Only the most recently
 * issued id is current, and supersede() makes every outstanding id stale. A
 * reply whose id is no longer current must be dropped by the caller.
 * No clock, randomness, or external state is used.
 */
export class RequestTracker {
  private lane = 0;

  /** Issues a new id; all earlier ids become stale. */
  public begin(): number {
    this.lane += 1;
    return this.lane;
  }

  /** The id of the latest request, or 0 when none has been issued. */
  public current(): number {
    return this.lane;
  }

  public isCurrent(id: number): boolean {
    return id === this.lane;
  }

  /** Invalidates every outstanding id without issuing a new request. */
  public supersede(): void {
    this.lane += 1;
  }
}
