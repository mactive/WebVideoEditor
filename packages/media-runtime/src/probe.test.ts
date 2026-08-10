import { assertPureJson } from "@web-video-editor/domain";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { MediaSourceRegistry } from "./media-probe-worker";
import {
  mediaProbeToProjectAsset,
  probeBrowserMedia,
  selectPrimaryVideoTrack,
} from "./probe";
import { probeNodeFile } from "./probe-node";

const testAsset = fileURLToPath(
  new URL("../../../test_assets/test_1.mp4", import.meta.url),
);
const largeTestAsset = fileURLToPath(
  new URL("../../../test_assets/test_2.mp4", import.meta.url),
);
const portraitTestAsset = fileURLToPath(
  new URL("../../../test_assets/test_3.mp4", import.meta.url),
);

function selectedTracks(result: Awaited<ReturnType<typeof probeNodeFile>>) {
  return {
    audio: result.audioTracks.find(
      (track) => track.trackId === result.primaryAudioTrackId,
    ),
    video: result.videoTracks.find(
      (track) => track.trackId === result.primaryVideoTrackId,
    ),
  };
}

describe("Mediabunny media probe", () => {
  it("probes the real square fixture and creates a JSON-only Project Asset", async () => {
    const result = await probeNodeFile(testAsset);
    const video = result.videoTracks.find(
      (track) => track.trackId === result.primaryVideoTrackId,
    );
    const audio = result.audioTracks.find(
      (track) => track.trackId === result.primaryAudioTrackId,
    );

    expect(video).toMatchObject({
      codec: "avc",
      displayHeight: 720,
      displayWidth: 720,
      frameRate: 30,
      profile: "High",
      rotation: 0,
    });
    expect(audio).toMatchObject({
      channels: 2,
      codec: "aac",
      profile: "LC",
      sampleRate: 48_000,
    });
    expect(result.durationSec).toBeCloseTo(36.053, 2);
    expect(result.excludedVideoTracks).toContainEqual(
      expect.objectContaining({
        codec: "mjpeg",
        reason: "jpeg-cover-art",
      }),
    );
    expect(result.read).toMatchObject({
      adapter: "CustomSource",
      fullFileRead: false,
      mode: "on-demand",
    });
    expect(result.read.fullFileRead).toBe(false);

    const asset = mediaProbeToProjectAsset(result, "asset-test-1");
    expect(() => assertPureJson(asset)).not.toThrow();
    expect(asset.media).toMatchObject({
      audio: { channels: 2, sampleRate: 48_000 },
      video: { codec: "avc", profile: "High" },
    });
    expect(JSON.stringify(asset)).not.toContain("blob");
  });

  it("produces the same fingerprint for path and Blob sources", async () => {
    const pathProbe = await probeNodeFile(testAsset);
    const fileBytes = await readFile(testAsset);
    const blobProbe = await probeBrowserMedia({
      blob: new Blob([fileBytes]),
      kind: "blob",
      name: "renamed.mp4",
    });
    const fileProbe = await probeBrowserMedia({
      blob: new File([fileBytes], "selected.mp4", {
        lastModified: 123,
        type: "video/mp4",
      }),
      kind: "file",
      lastModified: 123,
      name: "selected.mp4",
    });

    expect(blobProbe.fingerprint).toBe(pathProbe.fingerprint);
    expect(fileProbe.fingerprint).toBe(pathProbe.fingerprint);
    expect(blobProbe.read.adapter).toBe("BlobSource");
    expect(fileProbe.read.adapter).toBe("BlobSource");
    expect(mediaProbeToProjectAsset(blobProbe).source.kind).toBe("blob");
    expect(mediaProbeToProjectAsset(fileProbe).source).toMatchObject({
      kind: "file",
      lastModified: 123,
      name: "selected.mp4",
    });
  });

  it("probes a real URL through HTTP range requests", async () => {
    const bytes = await readFile(testAsset);
    const rangeRequests: string[] = [];
    const server = createServer((request, response) => {
      const range = request.headers.range;
      if (!range) {
        response.statusCode = 400;
        response.end();
        return;
      }
      rangeRequests.push(range);
      const match = /^bytes=(\d+)-$/.exec(range);
      const start = Number(match?.[1]);
      if (!Number.isSafeInteger(start) || start < 0 || start >= bytes.length) {
        response.statusCode = 416;
        response.end();
        return;
      }
      response.statusCode = 206;
      response.setHeader("Accept-Ranges", "bytes");
      response.setHeader(
        "Content-Range",
        `bytes ${start}-${bytes.length - 1}/${bytes.length}`,
      );
      response.setHeader("Content-Length", String(bytes.length - start));
      response.end(bytes.subarray(start));
    });

    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    try {
      const address = server.address() as AddressInfo;
      const result = await probeBrowserMedia({
        kind: "url",
        name: "remote-test-1.mp4",
        url: `http://127.0.0.1:${address.port}/test_1.mp4`,
      });

      expect(result.fingerprint).toBe(
        (await probeNodeFile(testAsset)).fingerprint,
      );
      expect(result.read).toMatchObject({
        adapter: "UrlSource",
        fullFileRead: false,
        mode: "on-demand",
      });
      expect(rangeRequests.length).toBeGreaterThan(0);
      expect(mediaProbeToProjectAsset(result).source.kind).toBe("url");
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("matches the large fixture baseline without a whole-file ArrayBuffer", async () => {
    const progress: Array<{
      bytesRead: number;
      fileSize: number;
      stage: string;
    }> = [];
    const result = await probeNodeFile(largeTestAsset, {
      onProgress: (event) => progress.push(event),
    });
    const { audio, video } = selectedTracks(result);
    const firstMetadata = progress.find((event) => event.stage === "metadata");

    expect(video).toMatchObject({
      codec: "avc",
      displayHeight: 1080,
      displayWidth: 1920,
      frameRate: 30,
      profile: "High",
    });
    expect(audio).toMatchObject({
      channels: 2,
      codec: "aac",
      profile: "LC",
      sampleRate: 44_100,
    });
    expect(result.durationSec).toBeCloseTo(3207.93, 2);
    expect(result.source.size).toBe(911_401_782);
    expect(video?.firstKeyframe).toMatchObject({
      timestampSec: 0,
      type: "key",
    });
    expect(result.excludedVideoTracks).toContainEqual(
      expect.objectContaining({
        codec: "mjpeg",
        reason: "jpeg-cover-art",
      }),
    );
    expect(firstMetadata).toBeDefined();
    expect(firstMetadata?.bytesRead).toBeLessThan(8 * 1024 * 1024);
    expect(firstMetadata?.bytesRead).toBeLessThan(firstMetadata?.fileSize ?? 0);
    expect(result.read).toMatchObject({
      adapter: "CustomSource",
      fullFileRead: false,
      mode: "on-demand",
    });
    expect(result.read.largestReadBytes).toBeLessThan(result.source.size);
    expect(result.read.readRatio).toBeLessThan(0.01);
  });

  it("matches the portrait fixture baseline", async () => {
    const result = await probeNodeFile(portraitTestAsset);
    const { audio, video } = selectedTracks(result);

    expect(video).toMatchObject({
      codec: "avc",
      displayHeight: 1920,
      displayWidth: 1080,
      frameRate: 30,
      profile: "High",
      rotation: 0,
    });
    expect(audio).toMatchObject({
      channels: 2,
      codec: "aac",
      profile: "LC",
      sampleRate: 48_000,
    });
    expect(result.durationSec).toBeCloseTo(125.02, 2);
    expect(result.source.size).toBe(141_746_939);
    expect(video?.firstKeyframe).toMatchObject({ type: "key" });
    expect(result.read.fullFileRead).toBe(false);
  });

  it("excludes an MJPEG attachment even when it has a larger frame", async () => {
    const result = await probeNodeFile(testAsset);
    const h264 = result.videoTracks[0];
    expect(h264).toBeDefined();
    if (!h264) {
      return;
    }
    const mjpeg = {
      ...h264,
      codec: "mjpeg",
      displayHeight: 2160,
      displayWidth: 3840,
      frameRate: 0,
      packetCount: 1,
      trackId: 3,
    };

    const selection = selectPrimaryVideoTrack([mjpeg, h264]);

    expect(selection.primary.trackId).toBe(h264.trackId);
    expect(selection.excluded).toEqual([
      {
        codec: "mjpeg",
        id: "3",
        reason: "mjpeg-additional-track",
        source: "video-track",
      },
    ]);
  });
});

describe("MediaSourceRegistry", () => {
  it("keeps Blob handles in runtime instead of Project metadata", () => {
    const registry = new MediaSourceRegistry();
    const source = {
      blob: new Blob(["runtime-only"]),
      kind: "file",
      name: "runtime.mp4",
    } as const;

    registry.register("sha256:runtime", source);

    expect(registry.get("sha256:runtime")).toBe(source);
    expect(registry.size).toBe(1);
    registry.clear();
    expect(registry.size).toBe(0);
  });
});
