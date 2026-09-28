import { supabase } from "./supabase";

const LOCAL_KEY = "@mp_song_history";
const MAX = 100;

export type HistorySong = {
  title: string;
  artist: string;
  album?: string;
  year?: string;
  genre?: string;
  artwork?: string;
  viewedAt: number; // unix ms
};

function localGet(): HistorySong[] {
  if (typeof window === "undefined") return [];
  try {
    return JSON.parse(localStorage.getItem(LOCAL_KEY) ?? "[]");
  } catch {
    return [];
  }
}

function localAdd(song: Omit<HistorySong, "viewedAt">, viewedAt: number): void {
  const deduped = localGet().filter(
    (s) =>
      !(
        s.title.toLowerCase() === song.title.toLowerCase() &&
        s.artist.toLowerCase() === song.artist.toLowerCase()
      )
  );
  localStorage.setItem(
    LOCAL_KEY,
    JSON.stringify([{ ...song, viewedAt }, ...deduped].slice(0, MAX))
  );
}

async function cloudUserId(): Promise<string | null> {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  return session?.user?.id ?? null;
}

async function cloudAdd(
  userId: string,
  song: Omit<HistorySong, "viewedAt">,
  viewedAt: number
): Promise<void> {
  try {
    await supabase.from("user_songs").upsert(
      {
        user_id: userId,
        title: song.title,
        artist: song.artist,
        album: song.album ?? null,
        year: song.year ?? null,
        genre: song.genre ?? null,
        artwork: song.artwork ?? null,
        viewed_at: new Date(viewedAt).toISOString(),
      },
      { onConflict: "user_id,title,artist" }
    );
  } catch {}
}

async function cloudGet(userId: string): Promise<HistorySong[]> {
  try {
    const { data, error } = await supabase
      .from("user_songs")
      .select("*")
      .eq("user_id", userId)
      .order("viewed_at", { ascending: false })
      .limit(MAX);
    if (error || !data?.length) return [];
    return data.map((r) => ({
      title: r.title,
      artist: r.artist,
      album: r.album ?? undefined,
      year: r.year ?? undefined,
      genre: r.genre ?? undefined,
      artwork: r.artwork ?? undefined,
      viewedAt: new Date(r.viewed_at).getTime(),
    }));
  } catch {
    return [];
  }
}

export async function addToHistory(
  song: Omit<HistorySong, "viewedAt">
): Promise<void> {
  const viewedAt = Date.now();
  localAdd(song, viewedAt);
  const userId = await cloudUserId();
  if (userId) void cloudAdd(userId, song, viewedAt);
}

export async function getHistory(): Promise<HistorySong[]> {
  const userId = await cloudUserId();
  if (userId) {
    const cloud = await cloudGet(userId);
    if (cloud.length > 0) return cloud;
  }
  return localGet();
}

export async function clearHistory(): Promise<void> {
  if (typeof window !== "undefined") localStorage.removeItem(LOCAL_KEY);
  const userId = await cloudUserId();
  if (userId)
    void supabase
      .from("user_songs")
      .delete()
      .eq("user_id", userId)
      .then(() => {});
}
