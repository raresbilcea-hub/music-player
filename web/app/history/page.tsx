"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { getHistory, clearHistory, type HistorySong } from "../../lib/songHistory";
import styles from "./page.module.css";

export default function HistoryPage() {
  const [songs, setSongs] = useState<HistorySong[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getHistory().then((h) => {
      setSongs(h);
      setLoading(false);
    });
  }, []);

  const handleClear = async () => {
    if (!window.confirm("Clear your entire song history?")) return;
    await clearHistory();
    setSongs([]);
  };

  if (loading) return <main />;

  return (
    <main>
      <div className={styles.topbar}>
        <Link href="/" className={styles.back}>
          ← Home
        </Link>
        {songs.length > 0 && (
          <button className={styles.clear} onClick={handleClear}>
            Clear history
          </button>
        )}
      </div>

      <h1 className={styles.title}>History</h1>

      {songs.length === 0 ? (
        <p className={styles.empty}>
          No songs yet. Search or record a song to get started.
        </p>
      ) : (
        <div className={styles.list}>
          {songs.map((song, i) => (
            <Link
              key={`${song.title}-${song.artist}-${i}`}
              href={`/song?title=${encodeURIComponent(song.title)}&artist=${encodeURIComponent(song.artist)}${song.artwork ? `&artwork=${encodeURIComponent(song.artwork)}` : ""}`}
              className={styles.row}
            >
              {song.artwork ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img className={styles.artwork} src={song.artwork} alt="" />
              ) : (
                <div className={styles.artworkPlaceholder} />
              )}
              <div className={styles.meta}>
                <div className={styles.songTitle}>{song.title}</div>
                <div className={styles.artist}>{song.artist}</div>
              </div>
              <span className={styles.chevron}>›</span>
            </Link>
          ))}
        </div>
      )}
    </main>
  );
}
