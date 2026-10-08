// Typed client for the Railway backend. All calls go directly from the
// browser to the Express server (CORS is open there), so chart generation
// is never subject to Vercel function timeouts.

import type { ChordChart, Section, SongInfo } from "./chart";

const API_URL =
  process.env.NEXT_PUBLIC_API_URL ||
  "https://music-player-production-524a.up.railway.app";

class HttpError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export type SearchSong = {
  title: string;
  artist: string;
  album?: string;
  year?: string;
  genre?: string;
  artwork?: string;
};

export async function searchSongs(q: string): Promise<SearchSong[]> {
  const res = await fetch(`${API_URL}/search?q=${encodeURIComponent(q)}`);
  if (!res.ok) throw new Error("Search failed");
  const data = await res.json();
  return data.songs ?? [];
}

export async function getCachedChart(
  title: string,
  artist: string
): Promise<ChordChart | null> {
  const res = await fetch(
    `${API_URL}/chords?title=${encodeURIComponent(title)}&artist=${encodeURIComponent(artist)}`
  );
  if (!res.ok) return null;
  const data = await res.json();
  return data.found ? (data.chart as ChordChart) : null;
}

export async function generateChart(
  title: string,
  artist: string,
  force = false
): Promise<ChordChart> {
  const res = await fetch(`${API_URL}/chords`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title, artist, force }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new HttpError(
      body?.error || `Chart generation failed (${res.status})`,
      res.status
    );
  }
  const data = await res.json();
  return data.chart as ChordChart;
}

// Generation can take 2-3 minutes when the server runs the full
// audio-analysis pipeline (stem separation + chord detection). If the long
// request drops mid-flight, the server still finishes and caches the chart
// in the database — so on failure we poll the fast cache endpoint until the
// chart appears.
export async function generateChartWithFallback(
  title: string,
  artist: string,
  opts: { pollIntervalMs?: number; maxPollMs?: number } = {}
): Promise<ChordChart> {
  const pollIntervalMs = opts.pollIntervalMs ?? 10_000;
  const maxPollMs = opts.maxPollMs ?? 5 * 60_000;
  try {
    return await generateChart(title, artist);
  } catch (error) {
    if (error instanceof HttpError && error.status >= 400 && error.status < 500) {
      throw error;
    }
    const deadline = Date.now() + maxPollMs;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, pollIntervalMs));
      const cached = await getCachedChart(title, artist).catch(() => null);
      if (cached) return cached;
    }
    throw new Error(
      "We couldn't generate this chart right now. Please try again in a minute."
    );
  }
}

export type IdentifyResult = {
  identified: boolean;
  songInfo?: SongInfo | null;
  chart?: ChordChart | null;
  source?: string;
  lyricsAvailable?: boolean;
  lyricsUnavailable?: boolean;
};

// /identify still returns the chart for recognized songs, and an uncached
// chart can run through the multi-minute audio-analysis fallback.
const IDENTIFY_TIMEOUT_MS = 4 * 60_000;

export async function identifyRecording(
  audioBase64: string,
  mimeType: string,
  signal?: AbortSignal,
  identifyOnly = false
): Promise<IdentifyResult> {
  const controller = new AbortController();
  let timedOut = false;
  const abortRequest = () => controller.abort();
  if (signal?.aborted) {
    controller.abort();
  } else {
    signal?.addEventListener("abort", abortRequest, { once: true });
  }
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, IDENTIFY_TIMEOUT_MS);

  try {
    const res = await fetch(`${API_URL}/identify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ audioBase64, mimeType, identifyOnly }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      throw new Error(body?.error || `Identification failed (${res.status})`);
    }
    return (await res.json()) as IdentifyResult;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError" && timedOut) {
      throw new Error("Song identification timed out. Please try again.");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abortRequest);
  }
}

export async function saveCorrection(chart: {
  title: string;
  artist: string;
  sections: Section[];
  musicalKey?: string | null;
  tempo?: number | null;
  capo?: number;
}): Promise<void> {
  const res = await fetch(`${API_URL}/chords`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(chart),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error || "Could not save your corrections");
  }
}
