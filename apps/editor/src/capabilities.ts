import type { StructuredLogger } from "@web-video-editor/observability";

export type CapabilityId =
  | "webCodecs"
  | "h264Decode"
  | "h264Encode"
  | "aacDecode"
  | "aacEncode"
  | "worker"
  | "opfs"
  | "webgl"
  | "webgpu"
  | "offscreenCanvas"
  | "sharedArrayBuffer"
  | "crossOriginIsolated";

export type CapabilityGroup = "codec" | "graphics" | "platform";

export type CapabilityResult = {
  detail: string;
  group: CapabilityGroup;
  id: CapabilityId;
  impact: string;
  label: string;
  suggestion: string;
  supported: boolean;
};

export type CapabilityReport = {
  generatedAt: string;
  results: CapabilityResult[];
};

export type EditorAction = "export" | "import" | "preview" | "sharedMemory";

export type ActionAvailability = {
  enabled: boolean;
  id: EditorAction;
  label: string;
  missing: CapabilityId[];
  reason: string;
};

type CodecProbe = {
  isConfigSupported(
    config: Record<string, unknown>,
  ): Promise<{ supported: boolean }>;
};

const labels: Record<CapabilityId, string> = {
  webCodecs: "WebCodecs API",
  h264Decode: "H.264 解码",
  h264Encode: "H.264 编码",
  aacDecode: "AAC 解码",
  aacEncode: "AAC 编码",
  worker: "Module Worker",
  opfs: "OPFS",
  webgl: "WebGL",
  webgpu: "WebGPU",
  offscreenCanvas: "OffscreenCanvas",
  sharedArrayBuffer: "SharedArrayBuffer",
  crossOriginIsolated: "Cross-origin isolation",
};

function result(
  id: CapabilityId,
  group: CapabilityGroup,
  supported: boolean,
  detail: string,
  impact: string,
  suggestion: string,
): CapabilityResult {
  return {
    id,
    label: labels[id],
    group,
    supported,
    detail,
    impact,
    suggestion,
  };
}

function runtimeValue(name: string): unknown {
  return (globalThis as unknown as Record<string, unknown>)[name];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function detectCodec(
  id: CapabilityId,
  constructorName: string,
  config: Record<string, unknown>,
  purpose: string,
): Promise<CapabilityResult> {
  const constructor = runtimeValue(constructorName) as CodecProbe | undefined;
  if (!constructor || typeof constructor.isConfigSupported !== "function") {
    return result(
      id,
      "codec",
      false,
      `${constructorName}.isConfigSupported 不可用`,
      purpose,
      "使用最新版 Chrome 或 Edge，并确认页面运行在安全上下文。",
    );
  }

  try {
    const support = await constructor.isConfigSupported(config);
    return result(
      id,
      "codec",
      support.supported,
      support.supported
        ? `${String(config.codec)} 配置可用`
        : `${String(config.codec)} 配置不受支持`,
      purpose,
      support.supported
        ? "无需处理。"
        : "更新浏览器或检查操作系统硬件编解码支持。",
    );
  } catch (error) {
    return result(
      id,
      "codec",
      false,
      `检测失败：${errorMessage(error)}`,
      purpose,
      "更新浏览器，并在浏览器媒体诊断页检查 codec 支持。",
    );
  }
}

async function detectWorker(): Promise<CapabilityResult> {
  if (typeof Worker === "undefined") {
    return result(
      "worker",
      "platform",
      false,
      "Worker 构造器不可用",
      "媒体任务无法移出主线程。",
      "使用最新版 Chrome 或 Edge。",
    );
  }

  const url = URL.createObjectURL(
    new Blob(["export {};"], { type: "text/javascript" }),
  );
  try {
    const worker = new Worker(url, { type: "module" });
    worker.terminate();
    return result(
      "worker",
      "platform",
      true,
      "Module Worker 可创建",
      "媒体任务可以在后台线程运行。",
      "无需处理。",
    );
  } catch (error) {
    return result(
      "worker",
      "platform",
      false,
      `创建失败：${errorMessage(error)}`,
      "媒体任务无法移出主线程。",
      "检查 Content Security Policy 和浏览器 Worker 设置。",
    );
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function detectOpfs(): Promise<CapabilityResult> {
  const storage = navigator.storage as StorageManager & {
    getDirectory?: () => Promise<FileSystemDirectoryHandle>;
  };
  if (typeof storage?.getDirectory !== "function") {
    return result(
      "opfs",
      "platform",
      false,
      "navigator.storage.getDirectory 不可用",
      "代理和大型缓存无法持久化。",
      "使用最新版 Chrome 或 Edge，并通过 localhost 或 HTTPS 访问。",
    );
  }

  try {
    await storage.getDirectory();
    return result(
      "opfs",
      "platform",
      true,
      "已取得 OPFS 根目录句柄",
      "代理和大型缓存可以持久化。",
      "无需处理。",
    );
  } catch (error) {
    return result(
      "opfs",
      "platform",
      false,
      `访问失败：${errorMessage(error)}`,
      "代理和大型缓存无法持久化。",
      "检查站点存储权限和隐私浏览设置。",
    );
  }
}

function detectWebGl(): CapabilityResult {
  const canvas = document.createElement("canvas");
  const context =
    canvas.getContext("webgl2") ?? canvas.getContext("webgl") ?? null;
  const supported = context !== null;
  const detail = context
    ? context instanceof WebGL2RenderingContext
      ? "WebGL 2 context 可创建"
      : "WebGL 1 context 可创建"
    : "无法创建 WebGL context";

  const loseContext = context?.getExtension("WEBGL_lose_context");
  loseContext?.loseContext();

  return result(
    "webgl",
    "graphics",
    supported,
    detail,
    "预览合成需要 WebGL 或 WebGPU。",
    supported ? "无需处理。" : "启用浏览器硬件加速或更新显卡驱动。",
  );
}

async function detectWebGpu(): Promise<CapabilityResult> {
  const gpu = (
    navigator as Navigator & {
      gpu?: { requestAdapter: () => Promise<unknown | null> };
    }
  ).gpu;
  if (!gpu) {
    return result(
      "webgpu",
      "graphics",
      false,
      "navigator.gpu 不可用",
      "预览将回退到 WebGL。",
      "可启用浏览器 WebGPU；WebGL 可用时不阻塞预览。",
    );
  }

  try {
    const adapter = await gpu.requestAdapter();
    return result(
      "webgpu",
      "graphics",
      adapter !== null,
      adapter ? "GPU adapter 可获取" : "未找到 GPU adapter",
      "WebGPU 不可用时预览回退到 WebGL。",
      adapter ? "无需处理。" : "启用硬件加速或更新显卡驱动。",
    );
  } catch (error) {
    return result(
      "webgpu",
      "graphics",
      false,
      `检测失败：${errorMessage(error)}`,
      "预览将回退到 WebGL。",
      "检查浏览器 WebGPU 和硬件加速设置。",
    );
  }
}

function detectOffscreenCanvas(): CapabilityResult {
  try {
    const canvas = new OffscreenCanvas(1, 1);
    const supported = canvas.getContext("2d") !== null;
    return result(
      "offscreenCanvas",
      "graphics",
      supported,
      supported ? "OffscreenCanvas 2D context 可创建" : "2D context 不可用",
      "不可用时后台画布渲染将降级到主线程。",
      supported ? "无需处理。" : "使用最新版 Chrome 或 Edge。",
    );
  } catch (error) {
    return result(
      "offscreenCanvas",
      "graphics",
      false,
      `检测失败：${errorMessage(error)}`,
      "后台画布渲染将降级到主线程。",
      "使用最新版 Chrome 或 Edge。",
    );
  }
}

function detectSharedMemory(): CapabilityResult {
  const isolated = globalThis.crossOriginIsolated;
  const supported =
    isolated &&
    typeof SharedArrayBuffer !== "undefined" &&
    typeof Atomics !== "undefined";
  return result(
    "sharedArrayBuffer",
    "platform",
    supported,
    supported
      ? "SharedArrayBuffer + Atomics 可用"
      : `构造器：${typeof SharedArrayBuffer !== "undefined" ? "存在" : "缺失"}；隔离：${isolated ? "已启用" : "未启用"}`,
    "不可用时共享播放时钟实验改用消息传递。",
    supported
      ? "无需处理。"
      : "通过带 COOP: same-origin 与 COEP: require-corp 的开发服务访问。",
  );
}

function detectCrossOriginIsolation(): CapabilityResult {
  const supported = globalThis.crossOriginIsolated;
  return result(
    "crossOriginIsolated",
    "platform",
    supported,
    supported ? "页面已跨源隔离" : "页面未跨源隔离",
    "未隔离时 SharedArrayBuffer 不可用。",
    supported ? "无需处理。" : "检查文档响应的 COOP/COEP 响应头。",
  );
}

export async function detectCapabilities(): Promise<CapabilityReport> {
  const webCodecsNames = [
    "VideoDecoder",
    "VideoEncoder",
    "AudioDecoder",
    "AudioEncoder",
  ];
  const webCodecsSupported = webCodecsNames.every(
    (name) => typeof runtimeValue(name) === "function",
  );

  const results = await Promise.all([
    Promise.resolve(
      result(
        "webCodecs",
        "codec",
        webCodecsSupported,
        webCodecsSupported
          ? "视频与音频 codec API 均存在"
          : "一个或多个 codec API 缺失",
        "缺失时无法执行帧级预览或导出。",
        webCodecsSupported
          ? "无需处理。"
          : "使用最新版 Chrome 或 Edge，并通过 localhost 或 HTTPS 访问。",
      ),
    ),
    detectCodec(
      "h264Decode",
      "VideoDecoder",
      { codec: "avc1.64001f", codedHeight: 1080, codedWidth: 1920 },
      "H.264 素材无法解码预览。",
    ),
    detectCodec(
      "h264Encode",
      "VideoEncoder",
      {
        avc: { format: "avc" },
        bitrate: 5_000_000,
        codec: "avc1.640028",
        framerate: 30,
        height: 1080,
        width: 1920,
      },
      "无法导出首选 H.264 视频。",
    ),
    detectCodec(
      "aacDecode",
      "AudioDecoder",
      { codec: "mp4a.40.2", numberOfChannels: 2, sampleRate: 48_000 },
      "AAC 音轨无法解码预览。",
    ),
    detectCodec(
      "aacEncode",
      "AudioEncoder",
      {
        aac: { format: "aac" },
        bitrate: 128_000,
        codec: "mp4a.40.2",
        numberOfChannels: 2,
        sampleRate: 48_000,
      },
      "无法导出首选 AAC 音频。",
    ),
    detectWorker(),
    detectOpfs(),
    Promise.resolve(detectWebGl()),
    detectWebGpu(),
    Promise.resolve(detectOffscreenCanvas()),
    Promise.resolve(detectSharedMemory()),
    Promise.resolve(detectCrossOriginIsolation()),
  ]);

  return {
    generatedAt: new Date().toISOString(),
    results,
  };
}

export function getActionAvailability(
  report: CapabilityReport,
): ActionAvailability[] {
  const capabilities = new Map(report.results.map((item) => [item.id, item]));
  const has = (...ids: CapabilityId[]) =>
    ids.every((id) => capabilities.get(id)?.supported === true);
  const availability = (
    id: EditorAction,
    label: string,
    required: CapabilityId[],
    enabledReason: string,
  ): ActionAvailability => {
    const missing = required.filter(
      (capabilityId) => !capabilities.get(capabilityId)?.supported,
    );
    return {
      enabled: missing.length === 0,
      id,
      label,
      missing,
      reason:
        missing.length === 0
          ? enabledReason
          : missing
              .map((capabilityId) => {
                const capability = capabilities.get(capabilityId);
                return capability
                  ? `${capability.label}：${capability.detail}；建议：${capability.suggestion}`
                  : `${labels[capabilityId]}：未获得检测结果。`;
              })
              .join(" "),
    };
  };

  return [
    availability(
      "import",
      "导入素材",
      ["worker", "opfs", "webCodecs", "h264Decode"],
      "流式导入、代理与缓存能力可用。",
    ),
    availability(
      "preview",
      "启动预览",
      ["worker", "webCodecs", "h264Decode", has("webgl") ? "webgl" : "webgpu"],
      "预览基础能力可用。",
    ),
    availability(
      "export",
      "开始导出",
      [
        "worker",
        "opfs",
        "webCodecs",
        "h264Decode",
        "aacDecode",
        "h264Encode",
        "aacEncode",
        "offscreenCanvas",
      ],
      "原素材 MP4 导出能力可用。",
    ),
    availability(
      "sharedMemory",
      "共享内存实验",
      ["sharedArrayBuffer", "crossOriginIsolated"],
      "共享内存实验可用。",
    ),
  ];
}

export function logCapabilityReport(
  logger: StructuredLogger,
  report: CapabilityReport,
  actions: ActionAvailability[],
  durationMs: number,
): void {
  logger.log({
    durationMs: Math.round(durationMs * 100) / 100,
    event: "capability.detected",
    input: {
      secureContext: globalThis.isSecureContext,
      userAgent: navigator.userAgent,
    },
    level: "info",
    marker: "[CAPABILITY]",
    output: {
      actions,
      capabilities: report.results,
    },
  });
}
