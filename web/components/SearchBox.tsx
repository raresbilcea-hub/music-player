"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { searchSongs, type SearchSong } from "../lib/api";
import styles from "./SearchBox.module.css";

export function SearchBox() {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchSong[]>([]);
  const [searching, setSearching] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const q = query.trim();
    if (q.length < 2) {
      setResults([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    debounceRef.current = setTimeout(async () => {
      try {
        const songs = await searchSongs(q);
        setResults(songs);
      } catch {
        setResults([]);
      } finally {
        setSearching(false);
      }
    }, 400);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query]);

  return (
    <div>
      <input
        className={styles.box}
        type="search"
        placeholder="Search any song or artist..."
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        autoComplete="off"
      />
      {searching && <p className={styles.hint}>Searching...</p>}
      <div className={styles.list}>
        {results.map((song, i) => (
          <button
            key={`${song.title}-${song.artist}-${i}`}
            className={styles.row}
            onClick={() =>
              router.push(
                `/song?title=${encodeURIComponent(song.title)}&artist=${encodeURIComponent(song.artist)}`
              )
            }
          >
            {song.artwork ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img className={styles.artwork} src={song.artwork} alt="" />
            ) : (
              <div className={styles.artwork} />
            )}
            <div className={styles.meta}>
              <div className={styles.title}>{song.title}</div>
              <div className={styles.artist}>
                {song.artist}
                {song.year ? ` · ${song.year}` : ""}
              </div>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
