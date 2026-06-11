"use client";

// One line of a chart: chord names positioned above the lyric syllables.
// Uses CSS `ch` units in a monospace context, so a chord's character
// `position` maps exactly to its visual column — no pixel math needed.

import { buildDisplayLyric, sortedChords, type Line } from "../lib/chart";
import styles from "./ChartLine.module.css";

export function ChartLine({
  line,
  onChordClick,
  onLyricClick,
}: {
  line: Line;
  onChordClick?: (chord: string, sortedIndex: number) => void;
  onLyricClick?: (charPosition: number) => void;
}) {
  const chords = sortedChords(line.chords);
  const hasChords = chords.length > 0;
  const hasLyrics = !!line.lyrics?.trim();
  if (!hasChords && !hasLyrics) return null;

  const displayLyric = hasChords
    ? buildDisplayLyric(chords, line.lyrics ?? "")
    : (line.lyrics ?? "");

  // Chord-only line (e.g. an Intro): the chords often share position 0, so
  // absolute positioning would stack them. Lay them out inline instead.
  if (hasChords && !hasLyrics) {
    return (
      <div className={styles.scroll}>
        <div className={`${styles.inner} ${styles.chordOnlyRow}`}>
          {chords.map((c, i) => (
            <button
              key={i}
              className={`${styles.chord} ${styles.chordInline} ${onChordClick ? styles.chordTappable : ""}`}
              onClick={onChordClick ? () => onChordClick(c.chord, i) : undefined}
              tabIndex={onChordClick ? 0 : -1}
            >
              {c.chord}
            </button>
          ))}
        </div>
      </div>
    );
  }

  function handleLyricClick(e: React.MouseEvent<HTMLDivElement>) {
    if (!onLyricClick) return;
    const target = e.currentTarget;
    const rect = target.getBoundingClientRect();
    // 1ch in this font = width of one character; measure it from a probe span
    const probe = document.createElement("span");
    probe.style.cssText = "position:absolute;visibility:hidden;white-space:pre";
    probe.textContent = "0";
    target.appendChild(probe);
    const chWidth = probe.getBoundingClientRect().width || 9;
    target.removeChild(probe);
    const pos = Math.max(0, Math.round((e.clientX - rect.left) / chWidth));
    onLyricClick(Math.min(pos, (line.lyrics ?? "").length));
  }

  return (
    <div className={styles.scroll}>
      <div className={styles.inner}>
        {hasChords && (
          <div className={styles.chordRow}>
            {chords.map((c, i) => (
              <button
                key={i}
                className={`${styles.chord} ${onChordClick ? styles.chordTappable : ""}`}
                style={{ left: `${c.position ?? 0}ch` }}
                onClick={onChordClick ? () => onChordClick(c.chord, i) : undefined}
                tabIndex={onChordClick ? 0 : -1}
              >
                {c.chord}
              </button>
            ))}
          </div>
        )}
        <div
          className={styles.lyrics}
          onClick={onLyricClick ? handleLyricClick : undefined}
          style={onLyricClick ? { cursor: "copy" } : undefined}
        >
          {displayLyric || " "}
        </div>
      </div>
    </div>
  );
}
