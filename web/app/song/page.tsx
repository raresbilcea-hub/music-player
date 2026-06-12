"use client";

// Chart page: /song?title=...&artist=...
// Fast path: chart already cached server-side -> renders immediately.
// Slow path: first request for this song -> POST /chords kicks off the
// full pipeline (scrapers -> audio analysis -> AI), with staged progress
// UI and a polling fallback if the long request drops.

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useState } from "react";
import { getCachedChart, generateChartWithFallback, saveCorrection } from "../../lib/api";
import type { ChordChart } from "../../lib/chart";
import { ChartView, type ChordTarget } from "../../components/ChartView";
import { ChordSheet } from "../../components/ChordSheet";
import { ChordEditModal } from "../../components/ChordEditModal";
import { LoadingPipeline } from "../../components/LoadingPipeline";
import styles from "./page.module.css";

function SongPageInner() {
  const params = useSearchParams();
  const title = params.get("title") ?? "";
  const artist = params.get("artist") ?? "";

  const [chart, setChart] = useState<ChordChart | null>(null);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [diagramChord, setDiagramChord] = useState<string | null>(null);

  const [editMode, setEditMode] = useState(false);
  const [draft, setDraft] = useState<ChordChart | null>(null);
  const [editTarget, setEditTarget] = useState<ChordTarget | null>(null);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (!title || !artist) {
      setError("Missing song information.");
      setLoading(false);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const cached = await getCachedChart(title, artist);
        if (cancelled) return;
        if (cached) {
          setChart(cached);
          setLoading(false);
          return;
        }
        setLoading(false);
        setGenerating(true);
        const generated = await generateChartWithFallback(title, artist);
        if (cancelled) return;
        setChart(generated);
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "Could not load this chart.");
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
          setGenerating(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [title, artist]);

  const startEdit = useCallback(() => {
    if (!chart) return;
    setDraft(structuredClone(chart));
    setDirty(false);
    setEditMode(true);
  }, [chart]);

  const cancelEdit = useCallback(() => {
    if (dirty && !window.confirm("Throw away your chord changes without saving?")) return;
    setEditMode(false);
    setDraft(null);
    setEditTarget(null);
    setDirty(false);
  }, [dirty]);

  const applyChordEdit = useCallback(
    (chordName: string) => {
      if (!draft || !editTarget) return;
      const next = structuredClone(draft);
      const line = next.sections[editTarget.sectionIndex]?.lines[editTarget.lineIndex];
      if (line) {
        line.chords = line.chords ?? [];
        if (editTarget.chordIndex === null) {
          line.chords.push({ chord: chordName, position: editTarget.position });
        } else if (line.chords[editTarget.chordIndex]) {
          line.chords[editTarget.chordIndex].chord = chordName;
        }
      }
      setDraft(next);
      setDirty(true);
      setEditTarget(null);
    },
    [draft, editTarget]
  );

  const deleteChord = useCallback(() => {
    if (!draft || !editTarget || editTarget.chordIndex === null) return;
    const next = structuredClone(draft);
    const line = next.sections[editTarget.sectionIndex]?.lines[editTarget.lineIndex];
    if (line?.chords) line.chords.splice(editTarget.chordIndex, 1);
    setDraft(next);
    setDirty(true);
    setEditTarget(null);
  }, [draft, editTarget]);

  const saveEdits = useCallback(async () => {
    if (!draft) return;
    setSaving(true);
    try {
      await saveCorrection({
        title: draft.title || title,
        artist: draft.artist || artist,
        sections: draft.sections,
        musicalKey: draft.musicalKey,
        tempo: draft.tempo,
        capo: draft.capo,
      });
      setChart({ ...draft, verified: true });
      setEditMode(false);
      setDraft(null);
      setDirty(false);
    } catch (e) {
      alert(e instanceof Error ? e.message : "Could not save your corrections.");
    } finally {
      setSaving(false);
    }
  }, [draft, title, artist]);

  if (loading) return <main />;
  if (generating) {
    return (
      <main>
        <LoadingPipeline />
      </main>
    );
  }
  if (error || !chart) {
    return (
      <main>
        <div className={styles.error}>
          <p>{error ?? "Chart not found."}</p>
          <p className={styles.errorHint}>
            <Link href="/">← Back to search</Link>
          </p>
        </div>
      </main>
    );
  }

  const shown = editMode && draft ? draft : chart;

  return (
    <main>
      <div className={`${styles.topbar} no-print`}>
        <Link href="/" className={styles.back}>
          ← Search
        </Link>
        <div className={styles.actions}>
          {editMode ? (
            <>
              <button className={styles.action} onClick={cancelEdit}>
                Cancel
              </button>
              <button
                className={`${styles.action} ${styles.actionPrimary}`}
                onClick={saveEdits}
                disabled={saving}
              >
                {saving ? "Saving..." : "Save chart"}
              </button>
            </>
          ) : (
            <>
              <button className={styles.action} onClick={() => window.print()}>
                Print
              </button>
              <button className={styles.action} onClick={startEdit}>
                Edit chords
              </button>
            </>
          )}
        </div>
      </div>

      {editMode && (
        <p className={`${styles.editBanner} no-print`}>
          {dirty
            ? "⚠️ You have unsaved changes — press “Save chart” above to keep them!"
            : "Tap a chord to change or remove it. Tap anywhere in the lyrics to add a chord at that spot."}
        </p>
      )}

      <ChartView
        chart={shown}
        editMode={editMode}
        onShowDiagram={setDiagramChord}
        onEditChord={setEditTarget}
      />

      <ChordSheet chordName={diagramChord} onClose={() => setDiagramChord(null)} />

      {editTarget && (
        <ChordEditModal
          target={editTarget}
          onSave={applyChordEdit}
          onDelete={deleteChord}
          onClose={() => setEditTarget(null)}
        />
      )}
    </main>
  );
}

export default function SongPage() {
  return (
    <Suspense fallback={<main />}>
      <SongPageInner />
    </Suspense>
  );
}
