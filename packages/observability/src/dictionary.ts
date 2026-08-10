export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

export const MARKER_EVENTS = {
  "[CAPABILITY]": ["capability.detected"],
  "[COMMAND]": [
    "execution.started",
    "execution.completed",
    "execution.failed",
    "transaction.merged",
    "undo.completed",
    "redo.completed",
  ],
  "[IMPORT]": [
    "probe.started",
    "probe.completed",
    "queue.state",
    "progress",
    "completed",
    "cancelled",
    "failed",
  ],
  "[PROXY]": [
    "cache.hit",
    "cache.miss",
    "generation.started",
    "generation.progress",
    "generation.completed",
    "generation.cancelled",
    "generation.failed",
    "queue.state",
  ],
  "[SEEK]": [
    "request",
    "request.superseded",
    "request.cancelled",
    "request.failed",
  ],
  "[DEMUX]": ["packet", "completed", "backpressure", "failed"],
  "[DECODE]": [
    "frame",
    "queue.state",
    "queue.watermark",
    "frame.dropped",
    "completed",
    "failed",
  ],
  "[WASM]": [
    "call.started",
    "call.completed",
    "call.failed",
    "waveform.completed",
    "binary.validated",
  ],
  "[ECS]": ["evaluate", "revision.rebuilt", "entity.released", "failed"],
  "[RENDER]": ["present", "frame.dropped", "resource.released", "failed"],
  "[EXPORT]": [
    "started",
    "queue.state",
    "progress",
    "backpressure",
    "completed",
    "cancelled",
    "failed",
  ],
  "[PROBE]": [
    "metadata",
    "main-track.selected",
    "capability",
    "summary",
    "failed",
  ],
} as const;

export type LogMarker = keyof typeof MARKER_EVENTS;

export type LogEvent<M extends LogMarker = LogMarker> =
  (typeof MARKER_EVENTS)[M][number];

export type MarkerEventPair = {
  [M in LogMarker]: {
    event: LogEvent<M>;
    marker: M;
  };
}[LogMarker];

export type EventDefinition = {
  description: string;
  example: string;
};

export const EVENT_DICTIONARY: {
  readonly [M in LogMarker]: Readonly<Record<LogEvent<M>, EventDefinition>>;
} = {
  "[CAPABILITY]": {
    "capability.detected": {
      description:
        "浏览器能力与动作可用性检测完成；input 记录安全上下文和 UA，output 记录全部能力与动作。",
      example:
        "editor-bootstrap 输出 secureContext、userAgent、actions、capabilities 和 durationMs。",
    },
  },
  "[COMMAND]": {
    "execution.started": {
      description: "Command Bus 开始执行命令。",
      example: "记录命令、事务和 beforeRevision。",
    },
    "execution.completed": {
      description: "命令执行并通过不变量校验。",
      example: "记录 afterRevision。",
    },
    "execution.failed": {
      description: "命令执行或校验失败。",
      example: "记录命令参数和错误上下文。",
    },
    "transaction.merged": {
      description: "连续命令合并到同一事务。",
      example: "合并连续拖动命令。",
    },
    "undo.completed": {
      description: "撤销事务完成。",
      example: "记录恢复后的 revision。",
    },
    "redo.completed": {
      description: "重做事务完成。",
      example: "记录恢复后的 revision。",
    },
  },
  "[IMPORT]": {
    "probe.started": {
      description: "素材探测开始。",
      example: "记录文件名、大小和来源。",
    },
    "probe.completed": {
      description: "素材元数据探测完成。",
      example: "输出主音视频轨摘要。",
    },
    "queue.state": {
      description: "素材导入调度队列状态。",
      example: "记录 active、queued、concurrency 和 highWatermark。",
    },
    progress: {
      description: "导入任务进度。",
      example: "记录读取字节和当前阶段。",
    },
    completed: {
      description: "素材导入完成。",
      example: "输出素材 ID 和指纹。",
    },
    cancelled: {
      description: "素材导入被取消。",
      example: "记录取消阶段和已读字节。",
    },
    failed: {
      description: "素材导入失败。",
      example: "记录输入来源和错误。",
    },
  },
  "[PROXY]": {
    "cache.hit": {
      description: "代理缓存命中。",
      example: "记录缓存键和产物大小。",
    },
    "cache.miss": {
      description: "代理缓存未命中。",
      example: "记录缓存键和生成参数。",
    },
    "generation.started": {
      description: "代理生成开始。",
      example: "记录源尺寸和目标尺寸。",
    },
    "generation.progress": {
      description: "代理生成进度。",
      example: "记录已处理帧和输出字节。",
    },
    "generation.completed": {
      description: "代理生成完成。",
      example: "记录 OPFS 路径和输出摘要。",
    },
    "generation.cancelled": {
      description: "代理生成被取消。",
      example: "记录临时文件清理结果。",
    },
    "generation.failed": {
      description: "代理生成失败。",
      example: "记录 codec 配置和错误。",
    },
    "queue.state": {
      description: "代理任务调度队列状态。",
      example: "记录 active、queued、concurrency 和 highWatermark。",
    },
  },
  "[SEEK]": {
    request: {
      description: "收到新的 Seek 请求。",
      example: "记录工程时间和 revision。",
    },
    "request.superseded": {
      description: "Seek 请求被更新请求取代。",
      example: "输出 supersededBy requestId。",
    },
    "request.cancelled": {
      description: "Seek 请求被主动取消。",
      example: "记录取消原因。",
    },
    "request.failed": {
      description: "Seek 请求失败。",
      example: "记录时间、revision 和错误。",
    },
  },
  "[DEMUX]": {
    packet: {
      description: "Demux 输出 packet 摘要。",
      example: "记录时间戳、关键帧标记和二进制摘要。",
    },
    completed: {
      description: "Demux 请求完成。",
      example: "记录读取 packet 数。",
    },
    backpressure: {
      description: "Demux 因下游水位暂停。",
      example: "记录队列长度和上限。",
    },
    failed: {
      description: "Demux 失败。",
      example: "记录容器位置和错误。",
    },
  },
  "[DECODE]": {
    frame: {
      description: "解码器输出帧。",
      example: "记录帧时间戳、尺寸和队列水位。",
    },
    "queue.state": {
      description: "应用层解码调度队列状态。",
      example: "明确区分应用调度队列与不可见的库内部 codec 队列。",
    },
    "queue.watermark": {
      description: "解码队列达到配置水位。",
      example: "记录 decodeQueueSize。",
    },
    "frame.dropped": {
      description: "解码帧被丢弃。",
      example: "记录过期 requestId 或时间戳原因。",
    },
    completed: {
      description: "解码请求完成。",
      example: "记录输出帧数。",
    },
    failed: {
      description: "解码请求失败。",
      example: "记录 codec 状态和错误。",
    },
  },
  "[WASM]": {
    "call.started": {
      description: "调用 WASM 导出函数。",
      example: "记录函数名和 TypedArray 摘要。",
    },
    "call.completed": {
      description: "WASM 调用完成。",
      example: "记录输出摘要和耗时。",
    },
    "call.failed": {
      description: "WASM 调用失败。",
      example: "记录函数名和错误。",
    },
    "waveform.completed": {
      description: "WASM 波形计算完成。",
      example: "记录样本数、桶数和耗时。",
    },
    "binary.validated": {
      description: "WASM 二进制校验完成。",
      example: "记录长度、类型和摘要。",
    },
  },
  "[ECS]": {
    evaluate: {
      description: "ECS 求值当前工程时间。",
      example: "记录 revision、playhead 和可见实体数。",
    },
    "revision.rebuilt": {
      description: "运行时按新 revision 重建。",
      example: "记录前后 revision。",
    },
    "entity.released": {
      description: "运行实体离开时间范围并释放。",
      example: "记录实体 ID 和资源数量。",
    },
    failed: {
      description: "ECS 求值失败。",
      example: "记录 system 名称和错误。",
    },
  },
  "[RENDER]": {
    present: {
      description: "最终帧已呈现。",
      example: "记录画布尺寸、帧时间和 FPS。",
    },
    "frame.dropped": {
      description: "渲染帧被丢弃。",
      example: "记录过期或时钟漂移原因。",
    },
    "resource.released": {
      description: "渲染资源已释放。",
      example: "记录纹理或 VideoFrame 数量。",
    },
    failed: {
      description: "渲染失败。",
      example: "记录 renderer 类型和错误。",
    },
  },
  "[EXPORT]": {
    started: {
      description: "高质量导出开始。",
      example: "记录 source、画布和 codec 配置。",
    },
    "queue.state": {
      description: "导出任务调度队列状态。",
      example: "记录 active、queued、concurrency 和 highWatermark。",
    },
    progress: {
      description: "导出进度。",
      example: "记录帧、进度、ETA 和输出字节。",
    },
    backpressure: {
      description: "编码或 Mux 队列达到水位。",
      example: "记录 encodeQueueSize。",
    },
    completed: {
      description: "导出完成。",
      example: "记录总帧数、大小和 MIME。",
    },
    cancelled: {
      description: "导出被取消。",
      example: "记录 codec 和临时文件清理状态。",
    },
    failed: {
      description: "导出失败。",
      example: "记录源素材、codec 和错误。",
    },
  },
  "[PROBE]": {
    metadata: {
      description: "CLI 输出素材元数据。",
      example: "记录输入路径、容器和轨道。",
    },
    "main-track.selected": {
      description: "CLI 输出主轨选择。",
      example: "记录选中轨和排除轨原因。",
    },
    capability: {
      description: "CLI 输出 codec 能力判断。",
      example: "记录 codec 和支持状态。",
    },
    summary: {
      description: "CLI 输出机器可读探测摘要。",
      example: "记录最终 JSON 摘要。",
    },
    failed: {
      description: "CLI 素材探测失败。",
      example: "记录完整输入路径和错误上下文。",
    },
  },
};

const levelSet = new Set<string>(LOG_LEVELS);

export function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === "string" && levelSet.has(value);
}

export function isLogMarker(value: unknown): value is LogMarker {
  return (
    typeof value === "string" &&
    Object.prototype.hasOwnProperty.call(MARKER_EVENTS, value)
  );
}

export function isMarkerEvent(
  marker: LogMarker,
  event: unknown,
): event is LogEvent<typeof marker> {
  return (
    typeof event === "string" &&
    (MARKER_EVENTS[marker] as readonly string[]).includes(event)
  );
}
