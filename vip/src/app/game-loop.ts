import { EDITOR_CONFIG } from "../../../game-core/src/config/editor/editor.ts";

export class GameLoop {
  private readonly stepSeconds: number;
  private readonly maxFrameSeconds: number;
  private readonly update: (dt: number) => void;
  private readonly render: (alpha: number, now: number) => void;
  private timeScale: number;
  private accumulator: number;
  private lastTs: number;

  constructor(update: (dt: number) => void, render: (alpha: number, now: number) => void) {
    this.stepSeconds = 1 / EDITOR_CONFIG.gameLoop.stepsPerSecond;
    this.maxFrameSeconds = EDITOR_CONFIG.gameLoop.maxFrameSeconds;
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
    this.timeScale = Math.max(
      EDITOR_CONFIG.gameLoop.minTimeScale,
      Math.min(EDITOR_CONFIG.gameLoop.maxTimeScale, scale),
    );
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
