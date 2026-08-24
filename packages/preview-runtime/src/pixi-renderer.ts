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

type VideoLayerState = {
  canvas: HTMLCanvasElement;
  source: CanvasSource;
  sprite: Sprite;
};

export class PixiPreviewRenderer implements RuntimeRenderTarget {
  private readonly application = new Application();
  private readonly textNodes = new Map<string, Text>();
  private readonly videoLayers = new Map<string, VideoLayerState>();
  private readonly videoLayer = new Container();
  private readonly textLayer = new Container();
  private initialized = false;

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
    this.application.canvas.dataset.previewCanvas = "pixi-v8";
    host.replaceChildren(this.application.canvas);
    this.initialized = true;
    this.application.render();
  }

  sync(entities: readonly RuntimeEntity[]): void {
    if (!this.initialized) {
      return;
    }
    const visibleVideoIds = new Set<string>();
    for (const entity of entities) {
      if (!entity.video) {
        continue;
      }
      visibleVideoIds.add(entity.id);
      const layer = this.ensureVideoLayer(entity.id);
      const { animation, effects, transform } = entity;
      layer.sprite.visible = true;
      layer.sprite.alpha = animation.opacity;
      layer.sprite.position.set(transform.x, transform.y);
      layer.sprite.rotation = transform.rotationRad;
      layer.sprite.width = transform.width * transform.scaleX;
      layer.sprite.height = transform.height * transform.scaleY;
      layer.sprite.filters = createPixiEffectFilters(effects.resolved);
      this.videoLayer.addChild(layer.sprite);
    }
    for (const [id, layer] of this.videoLayers) {
      if (!visibleVideoIds.has(id)) {
        this.releaseVideoLayer(id, layer);
      }
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
      entityId: string;
      playheadUs: number;
      projectRevision: number;
      requestId: string;
    },
  ): void {
    if (!this.initialized) {
      throw new Error("PixiPreviewRenderer is not initialized");
    }
    const layer = this.videoLayers.get(options.entityId);
    if (!layer) {
      return;
    }
    const context = layer.canvas.getContext("2d");
    if (!context) {
      throw new Error("Preview frame canvas 2D context is unavailable");
    }
    const sourceWidth = frame.displayWidth;
    const sourceHeight = frame.displayHeight;
    const scale = Math.min(
      layer.canvas.width / sourceWidth,
      layer.canvas.height / sourceHeight,
    );
    const width = sourceWidth * scale;
    const height = sourceHeight * scale;
    const x = (layer.canvas.width - width) / 2;
    const y = (layer.canvas.height - height) / 2;
    context.clearRect(0, 0, layer.canvas.width, layer.canvas.height);
    context.drawImage(frame, x, y, width, height);
    layer.source.update();
    this.application.render();
    this.options.logger?.log({
      event: "present",
      input: {
        entityId: options.entityId,
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
    for (const [id, layer] of this.videoLayers) {
      this.releaseVideoLayer(id, layer);
    }
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

  private ensureVideoLayer(entityId: string): VideoLayerState {
    const existing = this.videoLayers.get(entityId);
    if (existing) {
      return existing;
    }
    const { profile } = this.options;
    const canvas = document.createElement("canvas");
    canvas.width = profile.width;
    canvas.height = profile.height;
    const source = new CanvasSource({
      autoDensity: false,
      resource: canvas,
    });
    const texture = new Texture({ source });
    const sprite = new Sprite({
      anchor: 0.5,
      texture,
    });
    sprite.position.set(profile.width / 2, profile.height / 2);
    sprite.width = profile.width;
    sprite.height = profile.height;
    sprite.visible = false;
    const layer = { canvas, source, sprite };
    this.videoLayers.set(entityId, layer);
    this.videoLayer.addChild(sprite);
    return layer;
  }

  private releaseVideoLayer(entityId: string, layer: VideoLayerState): void {
    this.videoLayers.delete(entityId);
    layer.sprite.destroy({
      children: true,
      texture: true,
      textureSource: true,
    });
  }
}
