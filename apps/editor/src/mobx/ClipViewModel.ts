import { makeAutoObservable, reaction, type IReactionDisposer } from "mobx";

export type ClipViewModelSnapshot = {
  actionCount: number;
  opacity: number;
  reactionCount: number;
  rotationDeg: number;
  scale: number;
  x: number;
  y: number;
};

export class ClipViewModel {
  x = 0.5;
  y = 0.5;
  scale = 1;
  rotationDeg = 0;
  opacity = 1;
  actionCount = 0;
  reactionCount = 0;
  lastAction = "等待操作";
  lastReaction = "尚未触发";

  private disposeReaction?: IReactionDisposer;

  constructor() {
    makeAutoObservable(this, {}, { autoBind: true });
    this.disposeReaction = reaction(
      () => [this.x, this.y, this.scale, this.rotationDeg, this.opacity],
      (values) => {
        this.reactionCount += 1;
        this.lastReaction = values.map((value) => value.toFixed(2)).join(" / ");
      },
    );
  }

  setX(value: number): void {
    this.record("setX", () => {
      this.x = value;
    });
  }

  setY(value: number): void {
    this.record("setY", () => {
      this.y = value;
    });
  }

  setScale(value: number): void {
    this.record("setScale", () => {
      this.scale = value;
    });
  }

  setRotation(value: number): void {
    this.record("setRotation", () => {
      this.rotationDeg = value;
    });
  }

  setOpacity(value: number): void {
    this.record("setOpacity", () => {
      this.opacity = value;
    });
  }

  snapshot(): ClipViewModelSnapshot {
    return {
      actionCount: this.actionCount,
      opacity: this.opacity,
      reactionCount: this.reactionCount,
      rotationDeg: this.rotationDeg,
      scale: this.scale,
      x: this.x,
      y: this.y,
    };
  }

  dispose(): void {
    this.disposeReaction?.();
  }

  private record(name: string, update: () => void): void {
    update();
    this.actionCount += 1;
    this.lastAction = `${name}(${this.actionCount})`;
  }
}
