import type { StructuredLogger } from "@web-video-editor/observability";
import {
  Application,
  CanvasSource,
  ColorMatrixFilter,
  Container,
  Graphics,
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

type TextLayerState = {
  background: Graphics;
  container: Container;
  text: Text;
};

const TEXT_BACKGROUND_PADDING_X_RATIO = 0.35;
const TEXT_BACKGROUND_PADDING_Y_RATIO = 0.22;

export class PixiPreviewRenderer implements RuntimeRenderTarget {
  private readonly application = new Application();
  private readonly textNodes = new Map<string, TextLayerState>();
  private readonly videoLayers = new Map<string, VideoLayerState>();
  private readonly sceneLayer = new Container();
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
    this.application.stage.addChild(this.sceneLayer);
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
    const visibleTextIds = new Set<string>();
    for (const entity of entities) {
      if (entity.video) {
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
        this.sceneLayer.addChild(layer.sprite);
      }
      if (entity.text) {
        visibleTextIds.add(entity.id);
        const layer = this.ensureTextLayer(entity.id);
        this.syncTextLayer(layer, entity);
        this.sceneLayer.addChild(layer.container);
      }
    }
    for (const [id, layer] of this.videoLayers) {
      if (!visibleVideoIds.has(id)) {
        this.releaseVideoLayer(id, layer);
      }
    }
    for (const [id, layer] of this.textNodes) {
      layer.container.visible = visibleTextIds.has(id);
    }
    this.application.render();
  }

  private ensureTextLayer(entityId: string): TextLayerState {
    const existing = this.textNodes.get(entityId);
    if (existing) {
      return existing;
    }
    const background = new Graphics();
    const text = new Text({
      anchor: 0.5,
      style: {
        fontFamily: "Inter, sans-serif",
        fontWeight: "700",
      },
    });
    const container = new Container();
    container.addChild(background, text);
    container.visible = false;
    const layer = { background, container, text };
    this.textNodes.set(entityId, layer);
    return layer;
  }

  private syncTextLayer(layer: TextLayerState, entity: RuntimeEntity): void {
    if (!entity.text) {
      return;
    }
    const { background, container, text } = layer;
    container.visible = true;
    container.alpha = entity.animation.opacity;
    container.position.set(entity.transform.x, entity.transform.y);
    container.rotation = entity.transform.rotationRad;
    container.scale.set(entity.transform.scaleX, entity.transform.scaleY);
    text.text = entity.text.value;
    text.style.fill = entity.text.color;
    text.style.fontFamily = entity.text.fontFamily;
    text.style.fontSize = entity.text.fontSize;
    text.style.padding = Math.ceil(Math.max(2, entity.text.strokeWidth));
    text.style.stroke = {
      color: entity.text.strokeColor,
      width: entity.text.strokeWidth,
    };
    background.clear();
    background.visible = entity.text.backgroundOpacity > 0;
    if (!background.visible) {
      return;
    }
    const paddingX = Math.max(
      4,
      entity.text.fontSize * TEXT_BACKGROUND_PADDING_X_RATIO,
    );
    const paddingY = Math.max(
      2,
      entity.text.fontSize * TEXT_BACKGROUND_PADDING_Y_RATIO,
    );
    const width = text.width + paddingX * 2;
    const height = text.height + paddingY * 2;
    background
      .roundRect(-width / 2, -height / 2, width, height, paddingY)
      .fill({
        alpha: entity.text.backgroundOpacity,
        color: colorNumber(entity.text.backgroundColor),
      });
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
    for (const layer of this.textNodes.values()) {
      layer.container.destroy({ children: true });
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
