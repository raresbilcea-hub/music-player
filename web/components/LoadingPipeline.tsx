"use client";

// Waiting experience for chart generation. The server may take 2-3 minutes
// on the audio-analysis path (stem separation + chord detection), so we
// show honest staged messages on a timer while the request runs.

import { useEffect, useState } from "react";
import styles from "./LoadingPipeline.module.css";

const STAGES: { afterSeconds: number; message: string }[] = [
  { afterSeconds: 0, message: "Searching chord libraries..." },
  { afterSeconds: 12, message: "Listening to the song..." },
  { afterSeconds: 35, message: "Separating the instruments..." },
  { afterSeconds: 80, message: "Detecting the chords from the guitar..." },
  { afterSeconds: 140, message: "Writing out your chart..." },
];

export function LoadingPipeline() {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const stage = [...STAGES].reverse().find((s) => elapsed >= s.afterSeconds) ?? STAGES[0];

  return (
    <div className={styles.wrap}>
      <div className={styles.bar} />
      <div className={styles.stage}>{stage.message}</div>
      <p className={styles.hint}>
        First time for this song? We analyze the actual recording, which can
        take a couple of minutes. The chart is saved afterwards, so it&apos;s
        instant next time.
      </p>
    </div>
  );
}
