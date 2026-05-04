import {
  StyleSheet,
  Text,
  View,
  ScrollView,
  TouchableOpacity,
  Image,
  ActivityIndicator,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useState, useCallback } from 'react';
import { useFocusEffect } from 'expo-router';
import { useAuth } from '@/context/auth';
import { getHistory, getVerified, type VerifiedSong } from '@/lib/songHistory';

const GOLD     = '#c9a84c';
const GOLD_DIM = '#8a6f32';
const BG       = '#0e0c09';
const CREAM    = '#e8dfc8';
const MUTED    = '#6b6254';
const BORDER   = '#2a2318';
const CARD     = '#16130e';
const RED      = '#c0392b';

export default function ProfileScreen() {
  const { user, signOut } = useAuth();
  const router = useRouter();

  const [historyCount,   setHistoryCount]   = useState(0);
  const [verifiedSongs,  setVerifiedSongs]  = useState<VerifiedSong[]>([]);
  const [loading,        setLoading]        = useState(true);

  useFocusEffect(useCallback(() => {
    async function load() {
      setLoading(true);
      const [history, verified] = await Promise.all([getHistory(), getVerified()]);
      setHistoryCount(history.length);
      setVerifiedSongs(verified);
      setLoading(false);
    }
    load();
  }, []));

  async function handleSignOut() {
    await signOut();
    router.replace('/(tabs)');
  }

  return (
    <ScrollView style={s.root} contentContainerStyle={s.content}>
      {/* ── Header ── */}
      <Text style={s.screenTitle}>PROFILE</Text>

      {/* ── Account section ── */}
      <View style={s.section}>
        <Text style={s.sectionLabel}>ACCOUNT</Text>
        <View style={s.card}>
          <Text style={s.emailLabel}>EMAIL</Text>
          <Text style={s.emailValue}>{user?.email ?? '—'}</Text>
        </View>
      </View>

      {/* ── Stats section ── */}
      {loading ? (
        <ActivityIndicator color={GOLD} style={{ marginVertical: 24 }} />
      ) : (
        <View style={s.section}>
          <Text style={s.sectionLabel}>STATS</Text>
          <View style={s.statsRow}>
            <View style={s.statCard}>
              <Text style={s.statNum}>{historyCount}</Text>
              <Text style={s.statLabel}>Songs{'\n'}Viewed</Text>
            </View>
            <View style={s.statCard}>
              <Text style={s.statNum}>{verifiedSongs.length}</Text>
              <Text style={s.statLabel}>Charts{'\n'}Verified</Text>
            </View>
          </View>
        </View>
      )}

      {/* ── Verified songs ── */}
      {!loading && verifiedSongs.length > 0 && (
        <View style={s.section}>
          <Text style={s.sectionLabel}>YOUR VERIFIED SONGS</Text>
          {verifiedSongs.map((song, i) => (
            <View key={i} style={s.verifiedRow}>
              {song.artwork ? (
                <Image source={{ uri: song.artwork }} style={s.artwork} />
              ) : (
                <View style={[s.artwork, s.artworkPlaceholder]} />
              )}
              <View style={s.verifiedInfo}>
                <Text style={s.verifiedTitle} numberOfLines={1}>{song.title}</Text>
                <Text style={s.verifiedArtist} numberOfLines={1}>{song.artist}</Text>
              </View>
              <Text style={s.verifiedBadge}>✓</Text>
            </View>
          ))}
        </View>
      )}

      {!loading && verifiedSongs.length === 0 && (
        <View style={s.section}>
          <Text style={s.sectionLabel}>YOUR VERIFIED SONGS</Text>
          <View style={s.emptyCard}>
            <Text style={s.emptyText}>No verified charts yet. Edit a chord chart and tap SAVE & VERIFY to contribute.</Text>
          </View>
        </View>
      )}

      {/* ── Sign out ── */}
      <TouchableOpacity style={s.signOutBtn} onPress={handleSignOut} activeOpacity={0.85}>
        <Text style={s.signOutTxt}>SIGN OUT</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

const s = StyleSheet.create({
  root:         { flex: 1, backgroundColor: BG },
  content:      { padding: 24, paddingBottom: 48 },
  screenTitle:  { color: GOLD, fontSize: 11, fontWeight: '700', letterSpacing: 3, marginBottom: 32 },

  section:      { marginBottom: 28 },
  sectionLabel: { color: MUTED, fontSize: 10, letterSpacing: 2, fontWeight: '700', marginBottom: 10 },

  card:         { backgroundColor: CARD, borderWidth: 1, borderColor: BORDER, padding: 16 },
  emailLabel:   { color: MUTED, fontSize: 10, letterSpacing: 1.5, marginBottom: 6 },
  emailValue:   { color: CREAM, fontSize: 15 },

  statsRow:     { flexDirection: 'row', gap: 10 },
  statCard:     { flex: 1, backgroundColor: CARD, borderWidth: 1, borderColor: BORDER, padding: 20, alignItems: 'center' },
  statNum:      { color: GOLD, fontSize: 32, fontWeight: '700', marginBottom: 6 },
  statLabel:    { color: MUTED, fontSize: 11, textAlign: 'center', lineHeight: 16 },

  verifiedRow:         { flexDirection: 'row', alignItems: 'center', backgroundColor: CARD, borderWidth: 1, borderColor: BORDER, padding: 12, marginBottom: 2 },
  artwork:             { width: 44, height: 44, marginRight: 12 },
  artworkPlaceholder:  { backgroundColor: BORDER },
  verifiedInfo:        { flex: 1 },
  verifiedTitle:       { color: CREAM, fontSize: 14, fontWeight: '600' },
  verifiedArtist:      { color: MUTED, fontSize: 12, marginTop: 2 },
  verifiedBadge:       { color: GOLD, fontSize: 16, fontWeight: '700', marginLeft: 8 },

  emptyCard:    { backgroundColor: CARD, borderWidth: 1, borderColor: BORDER, padding: 20 },
  emptyText:    { color: MUTED, fontSize: 13, lineHeight: 20 },

  signOutBtn:   { backgroundColor: RED, padding: 16, alignItems: 'center', marginTop: 8 },
  signOutTxt:   { color: '#fff', fontSize: 11, fontWeight: '700', letterSpacing: 2 },
});
