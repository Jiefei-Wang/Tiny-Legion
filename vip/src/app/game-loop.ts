export class GameLoop {
  private readonly stepSeconds: number;
  private readonly maxFrameSeconds: number;
  private readonly update: (dt: number) => void;
  private readonly render: (alpha: number, now: number) => void;
  private timeScale: number;
  private accumulator: number;
  private lastTs: number;

  constructor(update: (dt: number) => void, render: (alpha: number, now: number) => void) {
    this.stepSeconds = 1 / 60;
    this.maxFrameSeconds = 0.033;
    this.update = update;
    this.render = render;
    this.timeScale = 1;
    this.accumulator = 0;
    this.lastTs = 0;
  }

  public setTimeScale(scale: number): void {
    if (!Number.isFinite(scale)) {
      return;
    }
    this.timeScale = Math.max(0.5, Math.min(5, scale));
  }

  public start(): void {
    const frame = (ts: number): void => {
      if (this.lastTs === 0) {
        this.lastTs = ts;
      }
      const rawFrameSeconds = (ts - this.lastTs) / 1000;
      const scaledFrameSeconds = rawFrameSeconds * this.timeScale;
      const frameSeconds = Math.min(this.maxFrameSeconds * this.timeScale, scaledFrameSeconds);
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
