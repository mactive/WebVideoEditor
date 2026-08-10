import type { StructuredLogger } from "@web-video-editor/observability";
import {
  Application,
  CanvasSource,
  ColorMatrixFilter,
  Container,
  Sprite,
  Text,
  Texture,
} from "pixi.js";

import type { RuntimeRenderTarget } from "./systems";
import type { NormalizedEffect, QualityProfile, RuntimeEntity } from "./types";

function colorNumber(value: string): number {
  return Number.parseInt(value.slice(1), 16);
}

export function createPixiEffectFilters(
  effects: readonly NormalizedEffect[],
): ColorMatrixFilter[] {
  return effects.map((effect) => {
    const filter = new ColorMatrixFilter();
    switch (effect.kind) {
      case "grayscale":
        filter.greyscale(1, false);
        filter.alpha = effect.amount;
        break;
      case "vintage":
        filter.vintage(false);
        filter.alpha = effect.amount;
        break;
      case "adjustments":
        filter.brightness(1 + effect.brightness, false);
        filter.contrast(0.5 + effect.contrast * 0.5, true);
        break;
    }
    return filter;
  });
}

export type PixiPreviewRendererOptions = {
  backgroundColor: string;
  logger?: StructuredLogger;
  profile: QualityProfile;
};

export class PixiPreviewRenderer implements RuntimeRenderTarget {
  private readonly application = new Application();
  private readonly frameCanvas = document.createElement("canvas");
  private readonly textNodes = new Map<string, Text>();
  private readonly videoLayer = new Container();
  private readonly textLayer = new Container();
  private videoSprite?: Sprite;
  private frameSource?: CanvasSource;
  private initialized = false;
  private activeVideo?: RuntimeEntity;

  constructor(private readonly options: PixiPreviewRendererOptions) {}

  async init(host: HTMLElement): Promise<void> {
    const { profile } = this.options;
    await this.application.init({
      antialias: true,
      autoStart: false,
      backgroundColor: colorNumber(this.options.backgroundColor),
      height: profile.height,
      preference: "webgl",
      preserveDrawingBuffer: true,
      resolution: 1,
      width: profile.width,
    });
    this.application.stage.addChild(this.videoLayer, this.textLayer);
    this.frameCanvas.width = profile.width;
    this.frameCanvas.height = profile.height;
    this.frameSource = new CanvasSource({
      autoDensity: false,
      resource: this.frameCanvas,
    });
    const texture = new Texture({ source: this.frameSource });
    this.videoSprite = new Sprite({
      anchor: 0.5,
      texture,
    });
    this.videoSprite.position.set(profile.width / 2, profile.height / 2);
    this.videoSprite.width = profile.width;
    this.videoSprite.height = profile.height;
    this.videoSprite.visible = false;
    this.videoLayer.addChild(this.videoSprite);
    this.application.canvas.dataset.previewCanvas = "pixi-v8";
    host.replaceChildren(this.application.canvas);
    this.initialized = true;
    this.application.render();
  }

  sync(entities: readonly RuntimeEntity[]): void {
    if (!this.initialized || !this.videoSprite) {
      return;
    }
    this.activeVideo = entities.find((entity) => entity.video);
    this.videoSprite.visible = Boolean(this.activeVideo);
    if (this.activeVideo) {
      const { animation, effects, transform } = this.activeVideo;
      this.videoSprite.alpha = animation.opacity;
      this.videoSprite.position.set(transform.x, transform.y);
      this.videoSprite.rotation = transform.rotationRad;
      this.videoSprite.width = transform.width * transform.scaleX;
      this.videoSprite.height = transform.height * transform.scaleY;
      this.videoSprite.filters = createPixiEffectFilters(effects.resolved);
    } else {
      this.videoSprite.filters = [];
    }

    const visibleTextIds = new Set<string>();
    for (const entity of entities) {
      if (!entity.text) {
        continue;
      }
      visibleTextIds.add(entity.id);
      let node = this.textNodes.get(entity.id);
      if (!node) {
        node = new Text({
          anchor: 0.5,
          style: {
            fontFamily: "Inter, sans-serif",
            fontWeight: "700",
          },
          text: entity.text.value,
        });
        this.textNodes.set(entity.id, node);
        this.textLayer.addChild(node);
      }
      node.visible = true;
      node.text = entity.text.value;
      node.style.fill = entity.text.color;
      node.style.fontSize = entity.text.fontSize;
      node.alpha = entity.animation.opacity;
      node.position.set(entity.transform.x, entity.transform.y);
      node.rotation = entity.transform.rotationRad;
      node.scale.set(entity.transform.scaleX, entity.transform.scaleY);
    }
    for (const [id, node] of this.textNodes) {
      node.visible = visibleTextIds.has(id);
    }
    this.application.render();
  }

  present(
    frame: VideoFrame,
    options: {
      playheadUs: number;
      projectRevision: number;
      requestId: string;
    },
  ): void {
    if (!this.initialized || !this.frameSource || !this.videoSprite) {
      throw new Error("PixiPreviewRenderer is not initialized");
    }
    const context = this.frameCanvas.getContext("2d");
    if (!context) {
      throw new Error("Preview frame canvas 2D context is unavailable");
    }
    const sourceWidth = frame.displayWidth;
    const sourceHeight = frame.displayHeight;
    const scale = Math.min(
      this.frameCanvas.width / sourceWidth,
      this.frameCanvas.height / sourceHeight,
    );
    const width = sourceWidth * scale;
    const height = sourceHeight * scale;
    const x = (this.frameCanvas.width - width) / 2;
    const y = (this.frameCanvas.height - height) / 2;
    context.clearRect(0, 0, this.frameCanvas.width, this.frameCanvas.height);
    context.drawImage(frame, x, y, width, height);
    this.frameSource.update();
    this.application.render();
    this.options.logger?.log({
      event: "present",
      input: {
        frameTimestampUs: frame.timestamp,
        playheadUs: options.playheadUs,
      },
      level: "debug",
      marker: "[RENDER]",
      output: {
        height: frame.displayHeight,
        width: frame.displayWidth,
      },
      projectRevision: options.projectRevision,
      requestId: options.requestId,
    });
  }

  destroy(): void {
    if (!this.initialized) {
      return;
    }
    for (const node of this.textNodes.values()) {
      node.destroy();
    }
    this.textNodes.clear();
    this.activeVideo = undefined;
    this.application.destroy(true, {
      children: true,
      context: true,
      style: true,
      texture: true,
      textureSource: true,
    });
    this.initialized = false;
    this.options.logger?.log({
      event: "resource.released",
      input: { resource: "pixi-scene" },
      level: "debug",
      marker: "[RENDER]",
      output: { active: 0 },
    });
  }
}
