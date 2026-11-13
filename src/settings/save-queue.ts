/** Coalesce typing bursts and serialize every settings write, including unload. */
export class SettingsSaveQueue {
  private timer: number | null = null;
  private queue: Promise<void> = Promise.resolve();
  private pending: (() => void)[] = [];

  constructor(
    private readonly save: () => Promise<void>,
    private readonly onError: (error: unknown) => void,
    private readonly delayMs = 200,
  ) {}

  schedule(): Promise<void> {
    if (this.timer !== null) window.clearTimeout(this.timer);
    const completion = new Promise<void>((resolve) => this.pending.push(resolve));
    this.timer = window.setTimeout(() => void this.flush(), this.delayMs);
    return completion;
  }

  flush(): Promise<void> {
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = null;
    const pending = this.pending.splice(0);
    if (pending.length === 0) return this.queue;
    this.queue = this.queue
      .then(() => this.save())
      .catch((error: unknown) => this.onError(error))
      .finally(() => pending.forEach((resolve) => resolve()));
    return this.queue;
  }
}
