export class GameLoop {
  private readonly stepSeconds: number;
  private readonly maxFrameSeconds: number;
  private readonly update: (dt: number) => void;
  private readonly render: (alpha: number, now: number) => void;
  private accumulator: number;
  private lastTs: number;

  constructor(update: (dt: number) => void, render: (alpha: number, now: number) => void) {
    this.stepSeconds = 1 / 60;
    this.maxFrameSeconds = 0.033;
    this.update = update;
    this.render = render;
    this.accumulator = 0;
    this.lastTs = 0;
  }

  public start(): void {
    const frame = (ts: number): void => {
      if (this.lastTs === 0) {
        this.lastTs = ts;
      }
      const frameSeconds = Math.min(this.maxFrameSeconds, (ts - this.lastTs) / 1000);
      this.lastTs = ts;
      this.accumulator += frameSeconds;

      while (this.accumulator >= this.stepSeconds) {
        this.update(this.stepSeconds);
        this.accumulator -= this.stepSeconds;
      }

      const alpha = this.accumulator / this.stepSeconds;
      this.render(alpha, ts / 1000);
      requestAnimationFrame(frame);
    };

    requestAnimationFrame(frame);
  }
}
