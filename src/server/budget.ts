// A sliding one-minute budget per key.

const WINDOW_MS = 60_000;

export class Budget {
  private spent = new Map<string, number[]>();

  constructor(
    private perMinute: number,
    private now: () => number,
  ) {}

  /** Counts one use; false when the key has used up its minute. */
  take(key: string): boolean {
    const t = this.now();
    const recent = (this.spent.get(key) ?? []).filter((at) => t - at < WINDOW_MS);
    if (recent.length >= this.perMinute) return false;
    recent.push(t);
    this.spent.set(key, recent);
    return true;
  }
}
