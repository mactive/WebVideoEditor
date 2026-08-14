import { useEffect, useMemo, useState } from "react";

type DirectoryEntry = [
  string,
  FileSystemDirectoryHandle | FileSystemFileHandle,
];

type IterableDirectory = FileSystemDirectoryHandle & {
  entries(): AsyncIterableIterator<DirectoryEntry>;
};

type OpfsNode = {
  children?: OpfsNode[];
  handle: FileSystemDirectoryHandle | FileSystemFileHandle;
  kind: "directory" | "file";
  path: string;
  size?: number;
};

type SelectedFile = {
  file: File;
  path: string;
};

type ManifestShape = {
  cacheKey?: string;
  cover?: { path: string; timestampSec: number };
  createdAt?: string;
  keyframes?: Array<{
    byteLength: number;
    durationSec: number;
    sequenceNumber: number;
    timestampSec: number;
  }>;
  parameters?: Record<string, unknown>;
  proxy?: {
    byteLength: number;
    durationSec: number;
    frameRate: number;
    height: number;
    path: string;
    width: number;
  };
  source?: {
    durationSec: number;
    height: number;
    width: number;
  };
  thumbnails?: Array<{
    byteLength: number;
    height: number;
    path: string;
    timestampSec: number;
    width: number;
  }>;
  waveform?: {
    bucketCount: number;
    byteLength: number;
    path: string;
    sampleCount: number;
  };
};

type ProxySummary = {
  directory: string;
  manifest: ManifestShape;
};

type FilePreview =
  | { kind: "binary"; bytes: number }
  | { kind: "error"; message: string }
  | { kind: "image"; url: string }
  | { kind: "json"; json: unknown; text: string }
  | { kind: "text"; text: string }
  | { kind: "video"; url: string }
  | {
      bucketCount: number;
      kind: "waveform";
      max: number[];
      min: number[];
      rms: number[];
      stats: {
        maxValue: number;
        minValue: number;
        rmsMax: number;
      };
    };

const PROXY_ROOT = "web-video-editor-media-cache-v1";

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  }
  if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(1)} KiB`;
  }
  return `${bytes} B`;
}

function formatTime(seconds: number | undefined): string {
  if (seconds === undefined || !Number.isFinite(seconds)) {
    return "N/A";
  }
  const rounded = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(rounded / 60);
  const remaining = rounded % 60;
  return `${minutes}:${String(remaining).padStart(2, "0")}`;
}

function sortNodes(left: OpfsNode, right: OpfsNode): number {
  if (left.kind !== right.kind) {
    return left.kind === "directory" ? -1 : 1;
  }
  return left.path.localeCompare(right.path);
}

async function readTree(
  directory: FileSystemDirectoryHandle,
  prefix = "",
): Promise<OpfsNode[]> {
  const nodes: OpfsNode[] = [];
  for await (const [name, handle] of (
    directory as IterableDirectory
  ).entries()) {
    const path = prefix ? `${prefix}/${name}` : name;
    if (handle.kind === "directory") {
      nodes.push({
        children: await readTree(handle, path),
        handle,
        kind: "directory",
        path,
      });
      continue;
    }
    const file = await handle.getFile();
    nodes.push({ handle, kind: "file", path, size: file.size });
  }
  return nodes.sort(sortNodes);
}

function flatten(nodes: readonly OpfsNode[]): OpfsNode[] {
  const result: OpfsNode[] = [];
  for (const node of nodes) {
    result.push(node);
    if (node.children) {
      result.push(...flatten(node.children));
    }
  }
  return result;
}

async function fileByPath(path: string): Promise<File> {
  const parts = path.split("/").filter(Boolean);
  let directory = await navigator.storage.getDirectory();
  for (const part of parts.slice(0, -1)) {
    directory = await directory.getDirectoryHandle(part);
  }
  return directory
    .getFileHandle(parts[parts.length - 1]!)
    .then((handle) => handle.getFile());
}

async function readManifestSummaries(): Promise<ProxySummary[]> {
  const root = await navigator.storage.getDirectory();
  let cache: FileSystemDirectoryHandle;
  try {
    cache = await root.getDirectoryHandle(PROXY_ROOT);
  } catch (error) {
    if (error instanceof DOMException && error.name === "NotFoundError") {
      return [];
    }
    throw error;
  }
  const summaries: ProxySummary[] = [];
  for await (const [name, handle] of (cache as IterableDirectory).entries()) {
    if (handle.kind !== "directory" || name.startsWith(".tmp-")) {
      continue;
    }
    try {
      const manifestFile = await handle.getFileHandle("manifest.json");
      const manifest = JSON.parse(
        await (await manifestFile.getFile()).text(),
      ) as ManifestShape;
      summaries.push({ directory: `${PROXY_ROOT}/${name}`, manifest });
    } catch {
      // Ignore partial or invalid entries; the cache cleanup path owns deletion.
    }
  }
  return summaries.sort((left, right) =>
    left.directory.localeCompare(right.directory),
  );
}

function isTextFile(file: File, path: string): boolean {
  return (
    file.type.startsWith("text/") ||
    path.endsWith(".txt") ||
    path.endsWith(".md") ||
    path.endsWith(".json")
  );
}

async function previewFile(file: File, path: string): Promise<FilePreview> {
  try {
    if (path.endsWith(".json")) {
      const text = await file.text();
      return { json: JSON.parse(text), kind: "json", text };
    }
    if (path.endsWith(".webp") || file.type.startsWith("image/")) {
      return { kind: "image", url: URL.createObjectURL(file) };
    }
    if (path.endsWith(".mp4") || file.type.startsWith("video/")) {
      return { kind: "video", url: URL.createObjectURL(file) };
    }
    if (path.endsWith(".f32")) {
      const data = new Float32Array(await file.arrayBuffer());
      const bucketCount = Math.floor(data.length / 3);
      const min = data.subarray(0, bucketCount);
      const max = data.subarray(bucketCount, bucketCount * 2);
      const rms = data.subarray(bucketCount * 2, bucketCount * 3);
      return {
        bucketCount,
        kind: "waveform",
        max: [...max.slice(0, 24)],
        min: [...min.slice(0, 24)],
        rms: [...rms.slice(0, 24)],
        stats: {
          maxValue: max.reduce((value, sample) => Math.max(value, sample), -1),
          minValue: min.reduce((value, sample) => Math.min(value, sample), 1),
          rmsMax: rms.reduce((value, sample) => Math.max(value, sample), 0),
        },
      };
    }
    if (isTextFile(file, path)) {
      return { kind: "text", text: await file.text() };
    }
    return { bytes: file.size, kind: "binary" };
  } catch (error) {
    return {
      kind: "error",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

function WaveformBars({ values }: { values: readonly number[] }) {
  const width = 240;
  const height = 64;
  const step = width / Math.max(values.length, 1);
  return (
    <svg
      aria-label="waveform sample preview"
      className="opfs-waveform"
      viewBox={`0 0 ${width} ${height}`}
    >
      <line x1="0" x2={width} y1={height / 2} y2={height / 2} />
      {values.map((value, index) => {
        const bar = Math.max(1, Math.abs(value) * height);
        return (
          <rect
            height={bar}
            key={`${index}-${value}`}
            width={Math.max(2, step - 1)}
            x={index * step}
            y={(height - bar) / 2}
          />
        );
      })}
    </svg>
  );
}

function JsonBlock({ value }: { value: unknown }) {
  return <pre>{JSON.stringify(value, null, 2)}</pre>;
}

function FilePreviewView({ preview }: { preview: FilePreview | undefined }) {
  if (!preview) {
    return <p className="opfs-muted">选择一个文件查看内容。</p>;
  }
  switch (preview.kind) {
    case "binary":
      return <p>二进制文件，大小 {formatBytes(preview.bytes)}。</p>;
    case "error":
      return <p className="opfs-error">{preview.message}</p>;
    case "image":
      return <img alt="OPFS image preview" src={preview.url} />;
    case "json":
      return <JsonBlock value={preview.json} />;
    case "text":
      return <pre>{preview.text}</pre>;
    case "video":
      return <video controls src={preview.url} />;
    case "waveform":
      return (
        <div className="opfs-waveform-panel">
          <dl>
            <div>
              <dt>buckets</dt>
              <dd>{preview.bucketCount}</dd>
            </div>
            <div>
              <dt>min</dt>
              <dd>{preview.stats.minValue.toFixed(4)}</dd>
            </div>
            <div>
              <dt>max</dt>
              <dd>{preview.stats.maxValue.toFixed(4)}</dd>
            </div>
            <div>
              <dt>rms max</dt>
              <dd>{preview.stats.rmsMax.toFixed(4)}</dd>
            </div>
          </dl>
          <h3>前 24 个 max bucket</h3>
          <WaveformBars values={preview.max} />
          <h3>前 24 个 rms bucket</h3>
          <WaveformBars values={preview.rms} />
          <JsonBlock
            value={{
              maxFirst24: preview.max,
              minFirst24: preview.min,
              rmsFirst24: preview.rms,
            }}
          />
        </div>
      );
  }
}

function ManifestSummary({
  summaries,
}: {
  summaries: readonly ProxySummary[];
}) {
  if (summaries.length === 0) {
    return (
      <p className="opfs-muted">
        暂无 proxy manifest。先在主编辑器导入素材并等待 proxy 完成。
      </p>
    );
  }
  return (
    <div className="opfs-proxy-grid">
      {summaries.map(({ directory, manifest }) => (
        <article key={directory}>
          <strong>{directory.replace(`${PROXY_ROOT}/`, "")}</strong>
          <dl>
            <div>
              <dt>source</dt>
              <dd>
                {manifest.source?.width ?? "?"}×{manifest.source?.height ?? "?"}{" "}
                · {formatTime(manifest.source?.durationSec)}
              </dd>
            </div>
            <div>
              <dt>proxy</dt>
              <dd>
                {manifest.proxy?.width ?? "?"}×{manifest.proxy?.height ?? "?"} ·{" "}
                {manifest.proxy?.frameRate ?? "?"}fps ·{" "}
                {formatBytes(manifest.proxy?.byteLength ?? 0)}
              </dd>
            </div>
            <div>
              <dt>artifacts</dt>
              <dd>
                {manifest.thumbnails?.length ?? 0} thumbs ·{" "}
                {manifest.keyframes?.length ?? 0} keyframes ·{" "}
                {manifest.waveform?.bucketCount ?? 0} waveform buckets
              </dd>
            </div>
          </dl>
        </article>
      ))}
    </div>
  );
}

export function OpfsExplorer() {
  const [error, setError] = useState<string>();
  const [nodes, setNodes] = useState<OpfsNode[]>([]);
  const [preview, setPreview] = useState<FilePreview>();
  const [selected, setSelected] = useState<SelectedFile>();
  const [summaries, setSummaries] = useState<ProxySummary[]>([]);
  const [loading, setLoading] = useState(false);
  const flatNodes = useMemo(() => flatten(nodes), [nodes]);
  const totalBytes = flatNodes.reduce((sum, node) => sum + (node.size ?? 0), 0);

  const refresh = async () => {
    setError(undefined);
    setLoading(true);
    try {
      const root = await navigator.storage.getDirectory();
      const [tree, proxySummaries] = await Promise.all([
        readTree(root),
        readManifestSummaries(),
      ]);
      setNodes(tree);
      setSummaries(proxySummaries);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  };

  const openFile = async (path: string) => {
    setError(undefined);
    try {
      const file = await fileByPath(path);
      setSelected({ file, path });
      setPreview(await previewFile(file, path));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  useEffect(() => {
    return () => {
      if (preview?.kind === "image" || preview?.kind === "video") {
        URL.revokeObjectURL(preview.url);
      }
    };
  }, [preview]);

  return (
    <main className="opfs-explorer">
      <header className="opfs-hero">
        <div>
          <p className="eyebrow">OPFS EXPLORER</p>
          <h1>OPFS 查看器</h1>
          <p>
            读取当前 origin 的 Origin Private File System，查看 proxy cache、
            waveform、缩略图、manifest 和导出 MP4。
          </p>
        </div>
        <nav>
          <a href="/">返回编辑器</a>
          <a href="/docs/">文档</a>
          <button
            disabled={loading}
            onClick={() => void refresh()}
            type="button"
          >
            {loading ? "扫描中…" : "刷新"}
          </button>
        </nav>
      </header>

      {error ? <p className="opfs-error">{error}</p> : null}

      <section className="opfs-summary">
        <span>
          {flatNodes.filter((node) => node.kind === "directory").length} dirs
        </span>
        <span>
          {flatNodes.filter((node) => node.kind === "file").length} files
        </span>
        <span>{formatBytes(totalBytes)}</span>
        <span>{summaries.length} proxy manifests</span>
      </section>

      <section className="opfs-section">
        <div className="opfs-section__heading">
          <h2>Proxy Cache 关联视图</h2>
          <span>{PROXY_ROOT}</span>
        </div>
        <ManifestSummary summaries={summaries} />
      </section>

      <section className="opfs-grid">
        <div className="opfs-panel">
          <div className="opfs-section__heading">
            <h2>文件列表</h2>
            <span>点击文件查看内容</span>
          </div>
          <ul className="opfs-tree">
            {flatNodes.map((node) => (
              <li data-kind={node.kind} key={node.path}>
                {node.kind === "file" ? (
                  <button
                    onClick={() => void openFile(node.path)}
                    type="button"
                  >
                    <span>{node.path}</span>
                    <small>{formatBytes(node.size ?? 0)}</small>
                  </button>
                ) : (
                  <span>{node.path}/</span>
                )}
              </li>
            ))}
          </ul>
        </div>

        <div className="opfs-panel opfs-preview">
          <div className="opfs-section__heading">
            <h2>文件内容</h2>
            <span>{selected?.path ?? "未选择"}</span>
          </div>
          {selected ? (
            <dl className="opfs-file-meta">
              <div>
                <dt>name</dt>
                <dd>{selected.file.name}</dd>
              </div>
              <div>
                <dt>size</dt>
                <dd>{formatBytes(selected.file.size)}</dd>
              </div>
              <div>
                <dt>type</dt>
                <dd>{selected.file.type || "application/octet-stream"}</dd>
              </div>
            </dl>
          ) : null}
          <FilePreviewView preview={preview} />
        </div>
      </section>
    </main>
  );
}
