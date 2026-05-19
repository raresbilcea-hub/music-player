import {
  StyleSheet,
  Text,
  View,
  ScrollView,
  TouchableOpacity,
  Alert,
} from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';

// ─── Design tokens ────────────────────────────────────────────────────────────

const GOLD     = '#c9a84c';
const GOLD_DIM = '#8a6f32';
const BG       = '#0e0c09';
const CARD     = '#16130e';
const CREAM    = '#e8dfc8';
const MUTED    = '#6b6254';
const BORDER   = '#2a2318';

// ─── Honest placeholder card ─────────────────────────────────────────────────
// Used for sections that don't have real content yet. Instead of fake data we
// show what the section WILL be, and a small "notify me / be first" CTA.

function PlaceholderCard({
  icon,
  title,
  body,
  ctaLabel,
  onCta,
}: {
  icon:     keyof typeof Ionicons.glyphMap;
  title:    string;
  body:     string;
  ctaLabel: string;
  onCta:    () => void;
}) {
  return (
    <View style={pc.card}>
      <View style={pc.iconCircle}>
        <Ionicons name={icon} size={28} color={GOLD} />
      </View>
      <Text style={pc.title}>{title}</Text>
      <Text style={pc.body}>{body}</Text>
      <TouchableOpacity style={pc.cta} onPress={onCta} activeOpacity={0.85}>
        <Text style={pc.ctaTxt}>{ctaLabel}</Text>
      </TouchableOpacity>
    </View>
  );
}

const pc = StyleSheet.create({
  card:       { backgroundColor: CARD, borderWidth: 1, borderColor: BORDER, paddingVertical: 28, paddingHorizontal: 22, alignItems: 'center' },
  iconCircle: { width: 64, height: 64, borderRadius: 32, backgroundColor: '#1e1a0e', borderWidth: 1, borderColor: GOLD_DIM, justifyContent: 'center', alignItems: 'center', marginBottom: 16 },
  title:      { color: CREAM, fontSize: 16, fontWeight: '700', marginBottom: 8, textAlign: 'center' },
  body:       { color: MUTED, fontSize: 12, lineHeight: 18, textAlign: 'center', marginBottom: 18, paddingHorizontal: 4 },
  cta:        { borderWidth: 1, borderColor: GOLD_DIM, paddingHorizontal: 18, paddingVertical: 10 },
  ctaTxt:     { color: GOLD, fontSize: 10, fontWeight: '700', letterSpacing: 2 },
});

// ─── Section header ───────────────────────────────────────────────────────────

function SectionHeader({ title, sub }: { title: string; sub: string }) {
  return (
    <View style={sh.row}>
      <Text style={sh.title}>{title}</Text>
      <Text style={sh.sub}>{sub}</Text>
    </View>
  );
}

const sh = StyleSheet.create({
  row:   { marginBottom: 14 },
  title: { color: CREAM, fontSize: 18, fontWeight: '700', marginBottom: 4 },
  sub:   { color: MUTED, fontSize: 11 },
});

// ─── LessonsScreen ────────────────────────────────────────────────────────────

export default function LessonsScreen() {
  const router = useRouter();

  function notifyComingSoon(what: string) {
    Alert.alert(
      'Coming soon',
      `We're working on ${what}. We'll let you know when it's ready.`,
      [{ text: 'OK', style: 'default' }],
    );
  }

  return (
    <ScrollView
      style={s.container}
      contentContainerStyle={s.content}
      showsVerticalScrollIndicator={false}
    >
      {/* Hero */}
      <Text style={s.heroTitle}>Lessons &</Text>
      <Text style={s.heroAccent}>Community.</Text>
      <Text style={s.heroSub}>Learn, teach, and share your music journey.</Text>

      <View style={s.divider} />

      {/* ── Record a lesson — the only "live" feature today ── */}
      <View style={s.section}>
        <SectionHeader
          title="Record a lesson"
          sub="Sing or play — lyrics transcribed in any language"
        />
        <TouchableOpacity
          style={s.recordCard}
          onPress={() => router.push('/record-lesson')}
          activeOpacity={0.88}
        >
          <View style={s.recordIconWrap}>
            <Ionicons name="mic" size={32} color={GOLD} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={s.recordTitle}>Start recording</Text>
            <Text style={s.recordSub}>
              Tap to record a lesson or song idea. We'll transcribe the lyrics
              and save it locally so you can share it later.
            </Text>
          </View>
          <Ionicons name="chevron-forward" size={20} color={GOLD_DIM} />
        </TouchableOpacity>
      </View>

      {/* ── Community videos — honest placeholder ── */}
      <View style={s.section}>
        <SectionHeader
          title="Community videos"
          sub="Recordings shared by musicians like you"
        />
        <PlaceholderCard
          icon="videocam-outline"
          title="Community videos coming soon"
          body="Once people start recording and submitting lessons, your favourites will live here. Be the first."
          ctaLabel="RECORD ONE"
          onCta={() => router.push('/record-lesson')}
        />
      </View>

      {/* ── Lessons — honest placeholder ── */}
      <View style={s.section}>
        <SectionHeader
          title="Lessons"
          sub="Free guided lessons for every level"
        />
        <PlaceholderCard
          icon="school-outline"
          title="Free lessons coming soon"
          body="We're putting together honest, AI-tailored lessons for beginner guitar, music theory, rhythm, and more. No fake pricing, no filler."
          ctaLabel="NOTIFY ME"
          onCta={() => notifyComingSoon('the lesson library')}
        />
      </View>

      {/* ── Teachers — honest placeholder + signup CTA ── */}
      <View style={s.section}>
        <SectionHeader
          title="Teachers"
          sub="Verified music instructors"
        />
        <PlaceholderCard
          icon="ribbon-outline"
          title="Are you a music teacher?"
          body="We're opening sign-ups for the first cohort of verified teachers. Submit your background and we'll review it personally."
          ctaLabel="APPLY TO TEACH"
          onCta={() => notifyComingSoon('the teacher application')}
        />
      </View>

      <View style={{ height: 32 }} />
    </ScrollView>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: BG },
  content:   { paddingTop: 24, paddingHorizontal: 24, paddingBottom: 40 },

  heroTitle:  { color: CREAM, fontSize: 42, fontWeight: 'bold', lineHeight: 48 },
  heroAccent: { color: GOLD,  fontSize: 42, fontStyle: 'italic', lineHeight: 48, marginBottom: 10 },
  heroSub:    { color: MUTED, fontSize: 14, marginBottom: 28 },

  divider:    { height: 1, backgroundColor: BORDER, marginBottom: 32 },

  section:    { marginBottom: 36 },

  recordCard: {
    flexDirection: 'row',
    alignItems:    'center',
    backgroundColor: CARD,
    borderWidth:     1,
    borderColor:     GOLD_DIM,
    padding:         18,
    gap:             14,
  },
  recordIconWrap: {
    width:           54,
    height:          54,
    borderRadius:    27,
    backgroundColor: '#1e1a0e',
    borderWidth:     1,
    borderColor:     GOLD_DIM,
    justifyContent:  'center',
    alignItems:      'center',
  },
  recordTitle: { color: CREAM, fontSize: 15, fontWeight: '700', marginBottom: 4 },
  recordSub:   { color: MUTED, fontSize: 11, lineHeight: 16 },
});
