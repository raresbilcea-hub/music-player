"use client";

// Edit-mode modal: type a chord name (with auto-suggest from the chord
// library) and see a live fretboard preview before saving. Ported from the
// mobile app's edit flow in song.tsx.

import { useEffect, useMemo, useRef, useState } from "react";
import { getAllChordNames } from "../lib/chordDiagrams";
import { ChordPreview } from "./FretboardSVG";
import type { ChordTarget } from "./ChartView";
import styles from "./ChordEditModal.module.css";

export function ChordEditModal({
  target,
  onSave,
  onDelete,
  onClose,
}: {
  target: ChordTarget;
  onSave: (chordName: string) => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const [value, setValue] = useState(target.chord);
  const inputRef = useRef<HTMLInputElement>(null);
  const isNew = target.chordIndex === null;

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const suggestions = useMemo(() => {
    const q = value.trim();
    if (!q) return [];
    const lower = q.toLowerCase();
    return getAllChordNames()
      .filter((n) => n.toLowerCase().startsWith(lower) && n !== q)
      .slice(0, 8);
  }, [value]);

  const canSave = value.trim().length > 0;

  return (
    <div className={`${styles.overlay} no-print`} onClick={onClose}>
      <div className={styles.box} onClick={(e) => e.stopPropagation()}>
        <p className={styles.heading}>
          {isNew ? "Add a chord here" : "Edit this chord"}
        </p>

        <input
          ref={inputRef}
          className={styles.input}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && canSave) onSave(value.trim());
            if (e.key === "Escape") onClose();
          }}
          placeholder="e.g. G, Am, F#m7"
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
        />

        <div className={styles.suggestions}>
          {suggestions.map((name) => (
            <button
              key={name}
              className={styles.suggestion}
              onClick={() => setValue(name)}
            >
              {name}
            </button>
          ))}
        </div>

        <ChordPreview chordName={value.trim()} />

        <div className={styles.actions}>
          <button
            className={styles.save}
            disabled={!canSave}
            onClick={() => onSave(value.trim())}
          >
            {isNew ? "Add chord" : "Save"}
          </button>
          {!isNew && (
            <button className={styles.delete} onClick={onDelete}>
              Delete
            </button>
          )}
          <button className={styles.cancel} onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
