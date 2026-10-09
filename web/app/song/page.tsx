"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import {
  getCachedChart,
  generateChartWithFallback,
  saveCorrection,
} from "../../lib/api";
import type { ChordChart } from "../../lib/chart";
import { ChartView, type ChordTarget } from "../../components/ChartView";
import { ChordSheet } from "../../components/ChordSheet";
import { ChordEditModal } from "../../components/ChordEditModal";
import { LoadingPipeline } from "../../components/LoadingPipeline";
import { FreeGateModal } from "../../components/FreeGateModal";
import { useAuth } from "../../context/auth";
import { shouldShowGate, consumeFreeAction } from "../../lib/freeGate";
import { addToHistory } from "../../lib/songHistory";
import styles from "./page.module.css";

function SongPageInner() {
  const params = useSearchParams();
  const title = params.get("title") ?? "";
  const artist = params.get("artist") ?? "";
  const artwork = params.get("artwork") ?? undefined;
  const lyricsUnavailable = params.get("lyricsUnavailable") === "1";

  const { session, loading: authLoading } = useAuth();
  const isAuthenticated = Boolean(session?.user.id);
  const artworkRef = useRef(artwork);

  const [chart, setChart] = useState<ChordChart | null>(null);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [gated, setGated] = useState(false);

  const [diagramChord, setDiagramChord] = useState<string | null>(null);

  const [editMode, setEditMode] = useState(false);
  const [editSessionToken, setEditSessionToken] = useState<string | null>(null);
  const [draft, setDraft] = useState<ChordChart | null>(null);
  const [editTarget, setEditTarget] = useState<ChordTarget | null>(null);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    artworkRef.current = artwork;
  }, [artwork]);

  useEffect(() => {
    if (authLoading) return;

    let cancelled = false;
    (async () => {
      setError(null);
      setChart(null);
      setLoading(true);
      setGenerating(false);
      setGated(false);

      if (!title || !artist) {
        setError("Missing song information.");
        setLoading(false);
        return;
      }

      // Gate check: unauthenticated users get 3 free songs per month
      if (!isAuthenticated && shouldShowGate()) {
        setGated(true);
        setLoading(false);
        return;
      }

      try {
        const cached = await getCachedChart(title, artist);
        if (cancelled) return;
        if (cached) {
          setChart(cached);
          setLoading(false);
          addToHistory({ title, artist, artwork: artworkRef.current });
          if (!isAuthenticated) consumeFreeAction();
          return;
        }
        if (lyricsUnavailable) {
          setError("Song identified, but no verified lyric chart is available yet.");
          return;
        }
        setLoading(false);
        setGenerating(true);
        const generated = await generateChartWithFallback(title, artist);
        if (cancelled) return;
        setChart(generated);
        addToHistory({ title, artist, artwork: artworkRef.current });
        if (!isAuthenticated) consumeFreeAction();
      } catch (e) {
        if (!cancelled) {
          setError(
            e instanceof Error ? e.message : "Could not load this chart."
          );
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
  }, [title, artist, lyricsUnavailable, isAuthenticated, authLoading]);

  const startEdit = useCallback(() => {
    if (!chart || !session?.access_token) return;
    setDraft(structuredClone(chart));
    setDirty(false);
    setEditSessionToken(session.access_token);
    setEditMode(true);
  }, [chart, session]);

  const cancelEdit = useCallback(() => {
    if (dirty && !window.confirm("Throw away your chord changes without saving?"))
      return;
    setEditMode(false);
    setEditSessionToken(null);
    setDraft(null);
    setEditTarget(null);
    setDirty(false);
  }, [dirty]);

  const applyChordEdit = useCallback(
    (chordName: string) => {
      if (!draft || !editTarget) return;
      const next = structuredClone(draft);
      const line =
        next.sections[editTarget.sectionIndex]?.lines[editTarget.lineIndex];
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
    const line =
      next.sections[editTarget.sectionIndex]?.lines[editTarget.lineIndex];
    if (line?.chords) line.chords.splice(editTarget.chordIndex, 1);
    setDraft(next);
    setDirty(true);
    setEditTarget(null);
  }, [draft, editTarget]);

  const saveEdits = useCallback(async () => {
    if (!draft || !session?.access_token) return;
    setSaving(true);
    try {
      await saveCorrection({
        title: draft.title || title,
        artist: draft.artist || artist,
        sections: draft.sections,
        musicalKey: draft.musicalKey,
        tempo: draft.tempo,
        capo: draft.capo,
      }, session.access_token);
      setChart({ ...draft, verified: true });
      setEditMode(false);
      setEditSessionToken(null);
      setDraft(null);
      setDirty(false);
    } catch (e) {
      alert(e instanceof Error ? e.message : "Could not save your corrections.");
    } finally {
      setSaving(false);
    }
  }, [draft, title, artist, session]);

  if (loading || authLoading) return <main />;

  if (gated) return <FreeGateModal />;

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

  const appMetadata = session?.user.app_metadata;
  const appRoles = [
    appMetadata?.role,
    ...(Array.isArray(appMetadata?.roles) ? appMetadata.roles : []),
  ];
  const canEdit = Boolean(
    session?.access_token &&
      appRoles.some(
        (role) =>
          typeof role === "string" &&
          ["chart_editor", "admin"].includes(role.toLowerCase())
      )
  );
  const editing = editMode && canEdit && session?.access_token === editSessionToken;
  const shown = editing && draft ? draft : chart;

  return (
    <main>
      <div className={`${styles.topbar} no-print`}>
        <Link href="/" className={styles.back}>
          ← Search
        </Link>
        <div className={styles.actions}>
          {editing ? (
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
              {canEdit && (
                <button className={styles.action} onClick={startEdit}>
                  Edit chords
                </button>
              )}
            </>
          )}
        </div>
      </div>

      {editing && (
        <p className={`${styles.editBanner} no-print`}>
          {dirty
            ? '⚠️ You have unsaved changes — press "Save chart" above to keep them!'
            : 'Tap a chord to change or remove it. Tap anywhere in the lyrics to add a chord at that spot.'}
        </p>
      )}

      {shown.warning && (
        <div className={`${styles.resultWarning} no-print`} role="status">
          <strong>{shown.partial ? "Partial result" : "Transcription note"}</strong>
          <span>{shown.warning}</span>
        </div>
      )}

      <ChartView
        chart={shown}
        editMode={editing}
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
