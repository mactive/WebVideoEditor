const DEFAULT_REMOTE_TEST_ASSET_BASE_URL =
  "https://pub-1311bfa3e5804b5181de3aa3f2b7028f.r2.dev/web-video-editor/";

export const TEST_ASSET_BASE_URL =
  import.meta.env.VITE_TEST_ASSET_BASE_URL ??
  (import.meta.env.PROD ? DEFAULT_REMOTE_TEST_ASSET_BASE_URL : "");

const TEST_ASSET_PATHS = [
  "/test_assets/test_1.mp4",
  "/test_assets/test_2.mp4",
  "/test_assets/test_3.mp4",
] as const;

export const TEST_ASSETS = [
  {
    description: "方形短视频 · 约 2.88 MB",
    name: "test_1.mp4",
    path: TEST_ASSET_PATHS[0],
    url: resolveTestAssetUrl(TEST_ASSET_PATHS[0]),
  },
  {
    description: "横屏长视频 · 约 911 MB",
    name: "test_2.mp4",
    path: TEST_ASSET_PATHS[1],
    url: resolveTestAssetUrl(TEST_ASSET_PATHS[1]),
  },
  {
    description: "竖屏视频 · 约 141.75 MB",
    name: "test_3.mp4",
    path: TEST_ASSET_PATHS[2],
    url: resolveTestAssetUrl(TEST_ASSET_PATHS[2]),
  },
] as const;

export type TestAssetName = (typeof TEST_ASSETS)[number]["name"];

export function resolveTestAssetUrl(path: string): string {
  const base = TEST_ASSET_BASE_URL?.trim();
  const relativePath = path.replace(/^\/+/, "");
  if (base) {
    return new URL(
      removeDuplicatedLeadingSegment(relativePath, base),
      ensureTrailingSlash(base),
    ).href;
  }
  if (typeof window === "undefined") {
    return path;
  }
  return new URL(path, window.location.href).href;
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function removeDuplicatedLeadingSegment(path: string, base: string): string {
  const baseLastSegment = getLastPathSegment(base);
  const pathParts = path.split("/");
  if (baseLastSegment && pathParts[0] === baseLastSegment) {
    return pathParts.slice(1).join("/");
  }
  return path;
}

function getLastPathSegment(value: string): string | undefined {
  try {
    return new URL(ensureTrailingSlash(value)).pathname
      .split("/")
      .filter(Boolean)
      .at(-1);
  } catch {
    return value
      .replace(/[?#].*$/, "")
      .replace(/\/+$/, "")
      .split("/")
      .filter(Boolean)
      .at(-1);
  }
}
