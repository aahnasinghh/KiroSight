import type { Scheduler, TimerHandle } from '../../src/backend/backendClient';

interface FakeTimer {
  readonly id: number;
  readonly callback: () => void;
  readonly delayMs: number;
  readonly dueAt: number;
}

/**
 * A manual clock. Nothing runs until advance() is called, so tests never wait in real time and
 * can assert the exact delay each timer was registered with.
 */
export class FakeScheduler implements Scheduler {
  public now = 0;
  public readonly registeredDelays: number[] = [];
  private nextId = 1;
  private readonly timers = new Map<number, FakeTimer>();

  public setTimeout(callback: () => void, delayMs: number): TimerHandle {
    const id = this.nextId++;
    this.registeredDelays.push(delayMs);
    this.timers.set(id, { id, callback, delayMs, dueAt: this.now + delayMs });
    return id;
  }

  public clearTimeout(handle: TimerHandle): void {
    this.timers.delete(handle as number);
  }

  /** Delays of timers that are still scheduled. */
  public get pendingDelays(): number[] {
    return [...this.timers.values()].map((timer) => timer.delayMs);
  }

  public get pendingCount(): number {
    return this.timers.size;
  }

  /** Moves the clock forward, firing due timers in due-time order (including ones they add). */
  public advance(ms: number): void {
    const target = this.now + ms;
    for (;;) {
      const due = [...this.timers.values()]
        .filter((timer) => timer.dueAt <= target)
        .sort((a, b) => a.dueAt - b.dueAt || a.id - b.id)[0];
      if (due === undefined) break;
      this.timers.delete(due.id);
      this.now = Math.max(this.now, due.dueAt);
      due.callback();
    }
    this.now = target;
  }
}
