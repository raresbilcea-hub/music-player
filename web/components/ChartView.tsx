"use client";

// Full chart display: header (key/tempo/capo pills, verified badge) +
// sections of chord-over-lyric lines. In edit mode, chord taps and lyric
// taps are routed to the editing callbacks instead of the diagram sheet.

import { sortedChords, type ChordChart } from "../lib/chart";
import { ChartLine } from "./ChartLine";
import styles from "./ChartView.module.css";

export type ChordTarget = {
  sectionIndex: number;
  lineIndex: number;
  chordIndex: number | null; // null = adding a new chord
  position: number;
  chord: string;
};

export function ChartView({
  chart,
  editMode = false,
  onShowDiagram,
  onEditChord,
}: {
  chart: ChordChart;
  editMode?: boolean;
  onShowDiagram?: (chord: string) => void;
  onEditChord?: (target: ChordTarget) => void;
}) {
  return (
    <div>
      <header className={styles.header}>
        <h1 className={styles.title}>{chart.title}</h1>
        <p className={styles.artist}>{chart.artist}</p>
        <div className={styles.pills}>
          {chart.musicalKey && (
            <span className={styles.pill}>
              Key <b>{chart.musicalKey}</b>
            </span>
          )}
          {chart.tempo ? (
            <span className={styles.pill}>
              <b>{Math.round(chart.tempo)}</b> BPM
            </span>
          ) : null}
          <span className={styles.pill}>
            Capo <b>{chart.capo || "none"}</b>
          </span>
          {chart.verified && (
            <span className={`${styles.pill} ${styles.verified}`}>✓ Musician verified</span>
          )}
        </div>
      </header>

      {chart.sections.map((section, si) => (
        <section key={si} className={`${styles.section} chart-section`}>
          <h2 className={styles.sectionLabel}>{section.label}</h2>
          {section.lines.map((line, li) => (
            <ChartLine
              key={li}
              line={line}
              onChordClick={
                editMode && onEditChord
                  ? (chord, sortedIndex) => {
                      // ChartLine renders chords sorted by position; map the
                      // sorted index back to the index in the line's array.
                      const target = sortedChords(line.chords)[sortedIndex];
                      const ci = (line.chords ?? []).indexOf(target);
                      onEditChord({
                        sectionIndex: si,
                        lineIndex: li,
                        chordIndex: ci >= 0 ? ci : null,
                        position: target?.position ?? 0,
                        chord,
                      });
                    }
                  : onShowDiagram
              }
              onLyricClick={
                editMode && onEditChord
                  ? (pos) =>
                      onEditChord({
                        sectionIndex: si,
                        lineIndex: li,
                        chordIndex: null,
                        position: pos,
                        chord: "",
                      })
                  : undefined
              }
            />
          ))}
        </section>
      ))}
    </div>
  );
}
