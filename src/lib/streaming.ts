import { env } from "./env";

export type PlaybackResult =
  | { kind: "unavailable"; message: string }
  | { kind: "embed"; url: string }
  | { kind: "hls"; url: string };

/**
 * Livestream provider adapter. Call `getPlayback` ONLY after `checkStreamAccess` allowed the viewer;
 * a real implementation should mint a short-lived, viewer-bound playback token/URL.
 * No real provider is integrated: confirm the provider's content policy, access-control
 * (signed playback) support and hosting compatibility first.
 */
export interface StreamProvider {
  readonly id: string;
  readonly isConfigured: boolean;
  getPlayback(stream: { id: string; providerRef: string | null }, viewerId: string | null): Promise<PlaybackResult>;
}

class NoStreamProvider implements StreamProvider {
  readonly id = "none";
  readonly isConfigured = false;
  async getPlayback(): Promise<PlaybackResult> {
    return { kind: "unavailable", message: "Livestreaming is coming soon. No streaming provider has been integrated yet." };
  }
}

export function getStreamProvider(): StreamProvider {
  switch (env.streamProvider) {
    case "none": return new NoStreamProvider();
    default: throw new Error(`STREAM_PROVIDER="${env.streamProvider}" has no adapter. See docs/PROVIDERS.md.`);
  }
}
