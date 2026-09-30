"use client";

import { useRouter } from "next/navigation";
import { useCallback } from "react";
import { useRecorder } from "../hooks/useRecorder";
import type { IdentifyResult } from "../lib/api";
import styles from "./RecordButton.module.css";

export function RecordButton() {
  const router = useRouter();

  const onIdentified = useCallback(
    (result: IdentifyResult) => {
      if (result.identified && result.songInfo) {
        const { title, artist, artwork } = result.songInfo;
        const url = `/song?title=${encodeURIComponent(title)}&artist=${encodeURIComponent(artist)}${artwork ? `&artwork=${encodeURIComponent(artwork)}` : ""}${result.lyricsUnavailable ? "&lyricsUnavailable=1" : ""}`;
        router.push(url);
      }
    },
    [router]
  );

  const { state, error, secondsLeft, start, stop, reset } = useRecorder(onIdentified);

  const label =
    state === "listening" ? `${secondsLeft}s` : state === "identifying" ? "..." : "TAP TO\nLISTEN";

  const status =
    state === "listening"
      ? "Listening... play or sing the song"
      : state === "identifying"
        ? "Identifying the song..."
        : state === "identified"
          ? "Found it! Opening the chart..."
          : "Hold your phone near the music";

  if (state === "error") {
    return (
      <div className={styles.wrap}>
        <button className={styles.button} onClick={reset}>
          RETRY
        </button>
        <p className={styles.error}>{error}</p>
      </div>
    );
  }

  return (
    <div className={styles.wrap}>
      <button
        className={`${styles.button} ${state === "listening" ? styles.listening : ""}`}
        onClick={state === "listening" ? stop : state === "idle" ? start : undefined}
        disabled={state === "identifying" || state === "identified"}
        aria-label="Record audio to identify a song"
      >
        <span style={{ whiteSpace: "pre-line" }}>{label}</span>
      </button>
      <p className={styles.status}>{status}</p>
    </div>
  );
}
