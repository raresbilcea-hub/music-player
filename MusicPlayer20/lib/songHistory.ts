import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase } from '@/lib/supabase';

export type HistorySong = {
  title:    string;
  artist:   string;
  album?:   string;
  year?:    string;
  genre?:   string;
  artwork?: string;
  viewedAt: number; // unix ms
};

const KEY = '@mp_song_history';
const MAX = 100;

// ── Local (AsyncStorage) helpers ──────────────────────────────────────────────

async function localGet(): Promise<HistorySong[]> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

async function localAdd(song: Omit<HistorySong, 'viewedAt'>, viewedAt: number): Promise<void> {
  try {
    const prev    = await localGet();
    const deduped = prev.filter(
      s => !(s.title.toLowerCase()  === song.title.toLowerCase() &&
             s.artist.toLowerCase() === song.artist.toLowerCase())
    );
    const updated = [{ ...song, viewedAt }, ...deduped].slice(0, MAX);
    await AsyncStorage.setItem(KEY, JSON.stringify(updated));
  } catch {}
}

async function localClear(): Promise<void> {
  try { await AsyncStorage.removeItem(KEY); } catch {}
}

// ── Supabase helpers ──────────────────────────────────────────────────────────

async function cloudUserId(): Promise<string | null> {
  const { data: { session } } = await supabase.auth.getSession();
  return session?.user?.id ?? null;
}

async function cloudAdd(userId: string, song: Omit<HistorySong, 'viewedAt'>, viewedAt: number): Promise<void> {
  try {
    await supabase.from('user_songs').upsert({
      user_id:   userId,
      title:     song.title,
      artist:    song.artist,
      album:     song.album    ?? null,
      year:      song.year     ?? null,
      genre:     song.genre    ?? null,
      artwork:   song.artwork  ?? null,
      viewed_at: new Date(viewedAt).toISOString(),
    }, { onConflict: 'user_id,title,artist' });
  } catch {}
}

async function cloudGet(userId: string): Promise<HistorySong[]> {
  try {
    const { data, error } = await supabase
      .from('user_songs')
      .select('*')
      .eq('user_id', userId)
      .order('viewed_at', { ascending: false })
      .limit(MAX);
    if (error || !data) return [];
    return data.map(r => ({
      title:    r.title,
      artist:   r.artist,
      album:    r.album    ?? undefined,
      year:     r.year     ?? undefined,
      genre:    r.genre    ?? undefined,
      artwork:  r.artwork  ?? undefined,
      viewedAt: new Date(r.viewed_at).getTime(),
    }));
  } catch { return []; }
}

async function cloudClear(userId: string): Promise<void> {
  try {
    await supabase.from('user_songs').delete().eq('user_id', userId);
  } catch {}
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function addToHistory(song: Omit<HistorySong, 'viewedAt'>): Promise<void> {
  const viewedAt = Date.now();
  const userId   = await cloudUserId();
  // Always write local — instant and offline-safe
  await localAdd(song, viewedAt);
  // Also write to cloud when signed in
  if (userId) cloudAdd(userId, song, viewedAt); // fire-and-forget
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
  await localClear();
  const userId = await cloudUserId();
  if (userId) cloudClear(userId); // fire-and-forget
}
