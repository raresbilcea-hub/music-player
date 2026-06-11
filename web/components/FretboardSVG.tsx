// SVG fretboard diagram — web rewrite of the mobile ChordDiagram renderer,
// using the same ChordShape data and layout constants.

import { lookupChord, type ChordShape } from "../lib/chordDiagrams";

const SG = 30; // gap between strings
const FH = 36; // height of each fret row
const FR = 4; // number of frets shown
const DOT_R = 10;
const PAD_H = 24;
const PAD_TOP = 34;
const PAD_BOT = 12;

const W = SG * 5 + PAD_H * 2;
const H = PAD_TOP + FH * FR + PAD_BOT;

const STRING_LABELS = ["E", "A", "D", "G", "B", "e"];

export function FretboardSVG({ shape }: { shape: ChordShape }) {
  const { positions, baseFret = 1 } = shape;
  const fretted = positions.filter((p) => p > 0);
  const minFret = fretted.length > 0 ? Math.min(...fretted) : 1;
  const base = baseFret > 1 ? baseFret : minFret > FR ? minFret : 1;
  const showFretNum = base > 1;

  return (
    <svg
      width={W + (showFretNum ? 28 : 0)}
      height={H}
      viewBox={`0 0 ${W + (showFretNum ? 28 : 0)} ${H}`}
      role="img"
    >
      {/* string labels */}
      {STRING_LABELS.map((label, si) => (
        <text
          key={`l${si}`}
          x={PAD_H + si * SG}
          y={10}
          textAnchor="middle"
          fontSize={10}
          fill="var(--text-dim)"
        >
          {label}
        </text>
      ))}

      {/* open / muted markers */}
      {positions.map((pos, si) => {
        if (pos === 0)
          return (
            <circle
              key={`o${si}`}
              cx={PAD_H + si * SG}
              cy={23}
              r={4.5}
              fill="none"
              stroke="var(--chord)"
              strokeWidth={1.5}
            />
          );
        if (pos === -1)
          return (
            <text
              key={`m${si}`}
              x={PAD_H + si * SG}
              y={27}
              textAnchor="middle"
              fontSize={12}
              fontWeight={600}
              fill="var(--danger)"
            >
              ✕
            </text>
          );
        return null;
      })}

      {/* nut (thick when chart starts at fret 1) */}
      <rect
        x={PAD_H}
        y={PAD_TOP - (showFretNum ? 1 : 3)}
        width={SG * 5}
        height={showFretNum ? 1.5 : 4}
        fill={showFretNum ? "var(--border)" : "var(--text)"}
      />

      {/* fret lines */}
      {Array.from({ length: FR }).map((_, fi) => (
        <line
          key={`f${fi}`}
          x1={PAD_H}
          y1={PAD_TOP + (fi + 1) * FH}
          x2={PAD_H + SG * 5}
          y2={PAD_TOP + (fi + 1) * FH}
          stroke="var(--border)"
          strokeWidth={1}
        />
      ))}

      {/* strings */}
      {Array.from({ length: 6 }).map((_, si) => (
        <line
          key={`s${si}`}
          x1={PAD_H + si * SG}
          y1={PAD_TOP}
          x2={PAD_H + si * SG}
          y2={PAD_TOP + FH * FR}
          stroke="var(--border)"
          strokeWidth={1}
        />
      ))}

      {/* finger dots */}
      {positions.map((pos, si) => {
        if (pos <= 0) return null;
        const row = pos - base;
        if (row < 0 || row >= FR) return null;
        return (
          <circle
            key={`d${si}`}
            cx={PAD_H + si * SG}
            cy={PAD_TOP + row * FH + FH / 2}
            r={DOT_R}
            fill="var(--chord)"
          />
        );
      })}

      {/* base fret label */}
      {showFretNum && (
        <text
          x={PAD_H + SG * 5 + 8}
          y={PAD_TOP + FH / 2 + 4}
          fontSize={11}
          fill="var(--text-dim)"
        >
          {base}fr
        </text>
      )}
    </svg>
  );
}

export function ChordPreview({ chordName }: { chordName: string }) {
  if (!chordName?.trim()) return null;
  const shape = lookupChord(chordName);
  if (!shape) {
    return (
      <p style={{ color: "var(--text-dim)", fontStyle: "italic", fontSize: 14, textAlign: "center" }}>
        ♩ Not in chord library yet
      </p>
    );
  }
  return (
    <div style={{ display: "flex", justifyContent: "center" }}>
      <FretboardSVG shape={shape} />
    </div>
  );
}
