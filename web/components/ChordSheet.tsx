"use client";

// Bottom-sheet modal showing the fretboard diagram for a tapped chord.

import { lookupChord } from "../lib/chordDiagrams";
import { FretboardSVG } from "./FretboardSVG";
import styles from "./ChordSheet.module.css";

export function ChordSheet({
  chordName,
  onClose,
}: {
  chordName: string | null;
  onClose: () => void;
}) {
  if (!chordName) return null;
  const shape = lookupChord(chordName);

  return (
    <div className={`${styles.overlay} no-print`} onClick={onClose}>
      <div className={styles.sheet} onClick={(e) => e.stopPropagation()}>
        <div className={styles.header}>
          <span className={styles.name}>{chordName}</span>
          <button className={styles.close} onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        {shape ? (
          <>
            <FretboardSVG shape={shape} />
            <div className={styles.legend}>
              <span>○ open</span>
              <span>✕ muted</span>
              <span>● finger</span>
            </div>
          </>
        ) : (
          <p style={{ color: "var(--text-dim)", padding: "16px 0" }}>
            ♩ Not in chord library yet
          </p>
        )}
      </div>
    </div>
  );
}
