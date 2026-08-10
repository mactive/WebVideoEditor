import { probeBrowserMedia } from "@web-video-editor/media-runtime";
import { ALL_FORMATS, BlobSource, EncodedPacketSink, Input } from "mediabunny";

import type { MediaExportInspection } from "./export-types";

export async function inspectExportFile(
  file: File,
): Promise<MediaExportInspection> {
  const probe = await probeBrowserMedia({
    blob: file,
    kind: "blob",
    name: file.name,
  });
  const input = new Input({
    formats: ALL_FORMATS,
    source: new BlobSource(file, { maxCacheSize: 8 * 1024 * 1024 }),
  });

  try {
    const audioTracks = await input.getAudioTracks();
    const audioTrack =
      audioTracks.find((track) => track.id === probe.primaryAudioTrackId) ??
      (await input.getPrimaryAudioTrack());
    if (!audioTrack) {
      return { audio: null, probe };
    }

    let firstTimestampUs = Number.POSITIVE_INFINITY;
    let lastEndTimestampUs = 0;
    let packetCount = 0;
    let previousTimestampUs = Number.NEGATIVE_INFINITY;
    let timestampsMonotonic = true;
    for await (const packet of new EncodedPacketSink(audioTrack).packets(
      undefined,
      undefined,
      { metadataOnly: true },
    )) {
      const timestampUs = packet.microsecondTimestamp;
      timestampsMonotonic &&= timestampUs >= previousTimestampUs;
      previousTimestampUs = timestampUs;
      firstTimestampUs = Math.min(firstTimestampUs, timestampUs);
      lastEndTimestampUs = Math.max(
        lastEndTimestampUs,
        timestampUs + packet.microsecondDuration,
      );
      packetCount += 1;
    }

    return {
      audio: {
        firstTimestampUs:
          firstTimestampUs === Number.POSITIVE_INFINITY ? 0 : firstTimestampUs,
        lastEndTimestampUs,
        packetCount,
        timestampsMonotonic,
      },
      probe,
    };
  } finally {
    input.dispose();
  }
}
