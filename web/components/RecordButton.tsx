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
        // The adaptive microphone probes use identifyOnly=true. That response
        // intentionally does not include a chart yet, so let the song page
        // start the normal chart-generation pipeline after navigation.
        const url = `/song?title=${encodeURIComponent(title)}&artist=${encodeURIComponent(artist)}${artwork ? `&artwork=${encodeURIComponent(artwork)}` : ""}`;
        router.push(url);
      }
    },
    [router]
  );

  const { state, error, start, stop, reset } = useRecorder(onIdentified);

  const label =
    state === "listening" ? "LISTENING" : state === "identifying" ? "..." : "TAP TO\nLISTEN";

  const status =
    state === "listening"
      ? "Listening... identifying automatically"
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
