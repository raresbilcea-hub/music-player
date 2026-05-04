import { StyleSheet, Text, View, TextInput, TouchableOpacity, FlatList, ActivityIndicator, Image, ScrollView } from 'react-native';
import { useState, useCallback } from 'react';
import { useRouter } from 'expo-router';
import { useFocusEffect } from 'expo-router';
import { addToHistory, getHistory, type HistorySong } from '@/lib/songHistory';
import { shouldShowGate, consumeFreeAction } from '@/lib/freeGate';
import { FreeGateModal } from '@/components/FreeGateModal';

type SearchSong = {
  title:    string;
  artist:   string;
  album?:   string;
  year?:    string;
  genre?:   string;
  artwork?: string;
  duration?: string;
};

export default function HomeScreen() {
  const [query, setQuery] = useState('');
  const [songs, setSongs] = useState<SearchSong[]>([]);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState('');
  const [gateVisible, setGateVisible] = useState(false);
  const [recentSongs, setRecentSongs] = useState<HistorySong[]>([]);
  const router = useRouter();

  useFocusEffect(useCallback(() => {
    getHistory().then(h => setRecentSongs(h.slice(0, 5)));
  }, []));

  async function searchSongs() {
    if (!query) return;

    // Gate check: show signup prompt if free action already used
    if (await shouldShowGate()) { setGateVisible(true); return; }

    setLoading(true);
    setStatus('Searching...');
    setSongs([]);
    try {
      const response = await fetch(`https://music-player-production-524a.up.railway.app/search?q=${encodeURIComponent(query)}`);
      const data = await response.json();
      setSongs(data.songs);
      setStatus(`${data.count} records found`);
      // Mark free action consumed after first successful search
      await consumeFreeAction();
    } catch (error) {
      setStatus('Connection error');
    }
    setLoading(false);
  }

  async function openSong(song: SearchSong | HistorySong) {
    await addToHistory({
      title:   song.title,
      artist:  song.artist,
      album:   song.album,
      year:    song.year,
      genre:   song.genre,
      artwork: song.artwork,
    });
    // navigate (not push) so the Songs tab gains focus and back goes to the history list
    router.navigate({
      pathname: '/(tabs)/song',
      params: {
        title:    song.title,
        artist:   song.artist,
        album:    song.album    ?? '',
        year:     song.year     ?? '',
        genre:    song.genre    ?? '',
        duration: ('duration' in song ? song.duration : undefined) ?? '',
        artwork:  song.artwork  ?? '',
      },
    });
  }

  const listHeader = (
    <View style={styles.header}>
      <FreeGateModal visible={gateVisible} />

      {/* ── Hero ── */}
      <Text style={styles.heroName}>Music Player 2.0</Text>
      <Text style={styles.heroTagline}>Identify songs. Learn chords. Play music.</Text>

      {/* ── Feature cards ── */}
      <View style={styles.featureRow}>
        <View style={styles.featureCard}>
          <Text style={styles.featureEmoji}>🎸</Text>
          <Text style={styles.featureLabel}>Learn{'\n'}Chords</Text>
        </View>
        <View style={styles.featureCard}>
          <Text style={styles.featureEmoji}>📚</Text>
          <Text style={styles.featureLabel}>Free{'\n'}Lessons</Text>
        </View>
      </View>
      <View style={[styles.featureRow, { marginBottom: 32 }]}>
        <View style={styles.featureCard}>
          <Text style={styles.featureEmoji}>🎓</Text>
          <Text style={styles.featureLabel}>Be a{'\n'}Student</Text>
        </View>
        <View style={styles.featureCard}>
          <Text style={styles.featureEmoji}>🏫</Text>
          <Text style={styles.featureLabel}>Be a{'\n'}Teacher</Text>
        </View>
      </View>

      {recentSongs.length > 0 && (
        <View style={styles.recentSection}>
          <Text style={styles.recentLabel}>RECENTLY VIEWED</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.recentScroll}>
            {recentSongs.map((song, i) => (
              <TouchableOpacity
                key={i}
                style={styles.recentCard}
                onPress={() => openSong(song)}
                activeOpacity={0.8}
              >
                {song.artwork ? (
                  <Image source={{ uri: song.artwork }} style={styles.recentArtwork} />
                ) : (
                  <View style={[styles.recentArtwork, styles.recentArtworkPlaceholder]} />
                )}
                <Text style={styles.recentTitle} numberOfLines={1}>{song.title}</Text>
                <Text style={styles.recentArtist} numberOfLines={1}>{song.artist}</Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
        </View>
      )}

      {/* ── Search ── */}
      <View style={styles.searchRow}>
        <TextInput
          style={styles.input}
          placeholder="Enter a song or artist..."
          placeholderTextColor="#6b6254"
          value={query}
          onChangeText={setQuery}
          onSubmitEditing={searchSongs}
        />
        <TouchableOpacity style={styles.button} onPress={searchSongs}>
          <Text style={styles.buttonText}>SEARCH</Text>
        </TouchableOpacity>
      </View>

      {status ? <Text style={styles.status}>— {status}</Text> : null}
      {loading ? <ActivityIndicator color="#c9a84c" style={{ marginBottom: 16 }} /> : null}
    </View>
  );

  return (
    <FlatList
      style={styles.container}
      data={songs}
      keyExtractor={(item, index) => index.toString()}
      ListHeaderComponent={listHeader}
      renderItem={({ item, index }) => (
        <TouchableOpacity style={styles.songCard} onPress={() => openSong(item)}>
          <Text style={styles.songNum}>{String(index + 1).padStart(2, '0')}</Text>
          {item.artwork ? (
            <Image source={{ uri: item.artwork }} style={styles.artwork} />
          ) : (
            <View style={styles.artworkPlaceholder} />
          )}
          <View style={styles.songInfo}>
            <Text style={styles.songTitle}>{item.title}</Text>
            <Text style={styles.songMeta}>{item.artist} · {item.album}</Text>
          </View>
          <Text style={styles.songYear}>{item.year}</Text>
        </TouchableOpacity>
      )}
      contentContainerStyle={styles.listContent}
      keyboardShouldPersistTaps="handled"
    />
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0e0c09',
  },
  listContent: {
    paddingHorizontal: 24,
    paddingTop: 24,
    paddingBottom: 32,
  },
  header: {
    // no extra styles needed; padding comes from listContent
  },
  heroName: {
    color: '#c9a84c',
    fontSize: 36,
    fontWeight: 'bold',
    letterSpacing: 0.5,
    marginBottom: 6,
  },
  heroTagline: {
    color: '#e8dfc8',
    fontSize: 14,
    lineHeight: 20,
    marginBottom: 28,
  },
  featureRow: {
    flexDirection: 'row',
    gap: 10,
    marginBottom: 10,
  },
  featureCard: {
    flex: 1,
    backgroundColor: '#16130e',
    borderWidth: 1,
    borderColor: '#2a2318',
    paddingVertical: 16,
    paddingHorizontal: 8,
    alignItems: 'center',
  },
  featureEmoji: {
    fontSize: 24,
    marginBottom: 8,
  },
  featureLabel: {
    color: '#e8dfc8',
    fontSize: 11,
    fontWeight: '600',
    textAlign: 'center',
    letterSpacing: 0.3,
    lineHeight: 16,
  },
  searchRow: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 16,
  },
  input: {
    flex: 1,
    backgroundColor: '#16130e',
    color: '#e8dfc8',
    padding: 14,
    fontSize: 16,
    borderWidth: 1,
    borderColor: '#2a2318',
  },
  button: {
    backgroundColor: '#c9a84c',
    padding: 14,
    justifyContent: 'center',
  },
  buttonText: {
    color: '#0e0c09',
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 2,
  },
  status: {
    color: '#6b6254',
    fontSize: 11,
    marginBottom: 16,
  },
  songCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#16130e',
    padding: 16,
    marginBottom: 2,
    borderWidth: 1,
    borderColor: '#2a2318',
  },
  songNum: {
    color: '#6b6254',
    fontSize: 11,
    width: 28,
  },
  artwork: {
    width: 44,
    height: 44,
    marginRight: 12,
    borderWidth: 1,
    borderColor: '#2a2318',
  },
  artworkPlaceholder: {
    width: 44,
    height: 44,
    marginRight: 12,
    backgroundColor: '#16130e',
    borderWidth: 1,
    borderColor: '#2a2318',
  },
  songInfo: {
    flex: 1,
  },
  songTitle: {
    color: '#e8dfc8',
    fontSize: 18,
  },
  songMeta: {
    color: '#6b6254',
    fontSize: 13,
    marginTop: 2,
  },
  songYear: {
    color: '#8a6f32',
    fontSize: 11,
  },
  recentSection: {
    marginBottom: 28,
  },
  recentLabel: {
    color: '#6b6254',
    fontSize: 10,
    letterSpacing: 2,
    fontWeight: '700',
    marginBottom: 12,
  },
  recentScroll: {
    gap: 10,
  },
  recentCard: {
    width: 88,
    backgroundColor: '#16130e',
    borderWidth: 1,
    borderColor: '#2a2318',
    padding: 8,
  },
  recentArtwork: {
    width: 72,
    height: 72,
    marginBottom: 8,
  },
  recentArtworkPlaceholder: {
    backgroundColor: '#2a2318',
  },
  recentTitle: {
    color: '#e8dfc8',
    fontSize: 11,
    fontWeight: '600',
    marginBottom: 2,
  },
  recentArtist: {
    color: '#6b6254',
    fontSize: 10,
  },
});
