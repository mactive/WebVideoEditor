#!/usr/bin/env node

import { resolve } from "node:path";

import {
  CliLogSink,
  StructuredLogger,
  serializeError,
} from "@web-video-editor/observability";

import { probeNodeFile } from "./probe-node";
import type { MediaProbeResult } from "./probe-types";

type CliOptions = {
  json: boolean;
  paths: string[];
};

function parseArgs(args: readonly string[]): CliOptions {
  const paths: string[] = [];
  let json = false;
  for (const arg of args) {
    if (arg === "--") {
      continue;
    } else if (arg === "--json") {
      json = true;
    } else if (arg.startsWith("-")) {
      throw new TypeError(`Unknown option: ${arg}`);
    } else {
      paths.push(resolve(arg));
    }
  }
  if (paths.length === 0) {
    paths.push(
      resolve("test_assets/test_1.mp4"),
      resolve("test_assets/test_2.mp4"),
      resolve("test_assets/test_3.mp4"),
    );
  }
  return { json, paths };
}

function primaryVideo(result: MediaProbeResult) {
  return result.videoTracks.find(
    (track) => track.trackId === result.primaryVideoTrackId,
  );
}

function primaryAudio(result: MediaProbeResult) {
  return result.audioTracks.find(
    (track) => track.trackId === result.primaryAudioTrackId,
  );
}

function logResult(
  logger: StructuredLogger,
  inputPath: string,
  result: MediaProbeResult,
): void {
  const video = primaryVideo(result);
  const audio = primaryAudio(result);
  logger.log({
    event: "metadata",
    input: { path: inputPath },
    level: "info",
    marker: "[PROBE]",
    output: {
      audioTracks: result.audioTracks,
      container: result.container,
      durationSec: result.durationSec,
      file: result.source,
      videoTracks: result.videoTracks,
    },
  });
  logger.log({
    event: "main-track.selected",
    input: {
      excludedVideoTracks: result.excludedVideoTracks,
      videoTrackCount: result.videoTracks.length,
    },
    level: "info",
    marker: "[PROBE]",
    output: {
      audio,
      video,
    },
  });
  logger.log({
    event: "capability",
    input: {
      runtime: "node",
      note: "Container probing uses Mediabunny CustomSource; WebCodecs decode support is browser-specific.",
    },
    level: "info",
    marker: "[PROBE]",
    output: {
      audioDecodable: audio?.decodable ?? false,
      readable: true,
      videoDecodable: video?.decodable ?? false,
    },
  });
  logger.log({
    event: "summary",
    input: { path: inputPath },
    level: "info",
    marker: "[PROBE]",
    output: {
      audio: audio
        ? {
            channels: audio.channels,
            codec: audio.codec,
            profile: audio.profile,
            sampleRate: audio.sampleRate,
          }
        : null,
      durationSec: result.durationSec,
      excludedVideoTracks: result.excludedVideoTracks,
      fingerprint: result.fingerprint,
      read: result.read,
      video: video
        ? {
            codec: video.codec,
            frameRate: video.frameRate,
            height: video.displayHeight,
            profile: video.profile,
            rotation: video.rotation,
            width: video.displayWidth,
          }
        : null,
    },
  });
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const logger = new StructuredLogger(
    new CliLogSink({
      humanWriter: (text) => process.stdout.write(text),
    }),
    "media-probe-cli",
  );
  const results: Array<{ path: string; probe: MediaProbeResult }> = [];

  for (const inputPath of options.paths) {
    try {
      const probe = await probeNodeFile(inputPath);
      results.push({ path: inputPath, probe });
      if (!options.json) {
        logResult(logger, inputPath, probe);
      }
    } catch (error) {
      if (options.json) {
        process.stderr.write(
          `${JSON.stringify({
            error: serializeError(error, { path: inputPath }),
            path: inputPath,
          })}\n`,
        );
      } else {
        logger.log({
          error,
          event: "failed",
          input: { path: inputPath },
          level: "error",
          marker: "[PROBE]",
        });
      }
      process.exitCode = 1;
    }
  }

  if (options.json) {
    process.stdout.write(
      `${JSON.stringify({ results, version: 1 }, null, 2)}\n`,
    );
  }
}

void main();
