import {
  StyleSheet,
  Text,
  View,
  ScrollView,
  TouchableOpacity,
  FlatList,
  Platform,
} from 'react-native';

// ─── Design tokens ────────────────────────────────────────────────────────────

const GOLD     = '#c9a84c';
const GOLD_DIM = '#8a6f32';
const BG       = '#0e0c09';
const CARD     = '#16130e';
const CREAM    = '#e8dfc8';
const MUTED    = '#6b6254';
const BORDER   = '#2a2318';
const GREEN    = '#4caf76';

// ─── Mock data ────────────────────────────────────────────────────────────────
// Replace with real API calls once the backend is ready.

const VIDEOS = [
  { id: '1', emoji: '🎸', title: 'Playing Wonderwall Live',   author: 'Jake M.',  duration: '2:34' },
  { id: '2', emoji: '🎤', title: 'My First Song Cover',       author: 'Sarah K.', duration: '1:58' },
  { id: '3', emoji: '🎵', title: 'Fingerpicking Tutorial',    author: 'Mike R.',  duration: '4:12' },
  { id: '4', emoji: '🎼', title: 'Chord Transitions Tips',    author: 'Anna B.',  duration: '3:22' },
  { id: '5', emoji: '🥁', title: 'Drumming Along to Beatles', author: 'Leo P.',   duration: '5:01' },
];

const LESSONS = [
  { id: '1', emoji: '🎸', title: 'Beginner Guitar',        level: 'Beginner',     price: 'FREE',   count: 12 },
  { id: '2', emoji: '🎵', title: 'Music Theory 101',       level: 'Beginner',     price: 'FREE',   count: 8  },
  { id: '3', emoji: '🎼', title: 'Reading Sheet Music',    level: 'Intermediate', price: '$9.99',  count: 15 },
  { id: '4', emoji: '🥁', title: 'Rhythm & Timing',        level: 'All levels',   price: 'FREE',   count: 6  },
  { id: '5', emoji: '🎹', title: 'Piano Fundamentals',     level: 'Beginner',     price: '$4.99',  count: 20 },
  { id: '6', emoji: '🎙', title: 'Vocal Technique',        level: 'Intermediate', price: '$14.99', count: 10 },
];

const TEACHERS = [
  { id: '1', initial: 'A', name: 'Alex Rivera', specialty: 'Guitar · Songwriting', rating: 4.9, students: 124 },
  { id: '2', initial: 'M', name: 'Maya Chen',   specialty: 'Piano · Theory',       rating: 5.0, students: 89  },
  { id: '3', initial: 'T', name: 'Tom Walsh',   specialty: 'Drums · Percussion',   rating: 4.8, students: 67  },
  { id: '4', initial: 'D', name: 'Diana Park',  specialty: 'Vocals · Harmony',     rating: 4.7, students: 203 },
];

// ─── Section header ───────────────────────────────────────────────────────────

function SectionHeader({ title, sub }: { title: string; sub: string }) {
  return (
    <View style={sh.row}>
      <View>
        <Text style={sh.title}>{title}</Text>
        <Text style={sh.sub}>{sub}</Text>
      </View>
      <TouchableOpacity activeOpacity={0.7}>
        <Text style={sh.seeAll}>SEE ALL</Text>
      </TouchableOpacity>
    </View>
  );
}
const sh = StyleSheet.create({
  row:    { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 14 },
  title:  { color: CREAM, fontSize: 18, fontWeight: '700' },
  sub:    { color: MUTED, fontSize: 11, marginTop: 2 },
  seeAll: { color: GOLD_DIM, fontSize: 10, letterSpacing: 2 },
});

// ─── Video card ───────────────────────────────────────────────────────────────

function VideoCard({ item }: { item: typeof VIDEOS[0] }) {
  return (
    <TouchableOpacity style={vc.card} activeOpacity={0.8}>
      <View style={vc.thumb}>
        <Text style={vc.thumbEmoji}>{item.emoji}</Text>
        <View style={vc.playBadge}>
          <Text style={vc.playIcon}>▶</Text>
        </View>
        <View style={vc.duration}>
          <Text style={vc.durationTxt}>{item.duration}</Text>
        </View>
      </View>
      <Text style={vc.title} numberOfLines={2}>{item.title}</Text>
      <Text style={vc.author}>{item.author}</Text>
    </TouchableOpacity>
  );
}
const vc = StyleSheet.create({
  card:       { width: 160, marginRight: 12 },
  thumb:      { width: 160, height: 100, backgroundColor: '#1e1a0e', borderWidth: 1, borderColor: BORDER, marginBottom: 8, justifyContent: 'center', alignItems: 'center' },
  thumbEmoji: { fontSize: 36 },
  playBadge:  { position: 'absolute', top: 8, left: 8, backgroundColor: 'rgba(201,168,76,0.85)', width: 24, height: 24, borderRadius: 12, justifyContent: 'center', alignItems: 'center' },
  playIcon:   { color: BG, fontSize: 9, marginLeft: 2 },
  duration:   { position: 'absolute', bottom: 6, right: 8, backgroundColor: 'rgba(0,0,0,0.6)', paddingHorizontal: 5, paddingVertical: 2 },
  durationTxt:{ color: CREAM, fontSize: 10 },
  title:      { color: CREAM, fontSize: 13, fontWeight: '600', lineHeight: 18, marginBottom: 4 },
  author:     { color: MUTED, fontSize: 11 },
});

// ─── Lesson card ──────────────────────────────────────────────────────────────

function LessonCard({ item }: { item: typeof LESSONS[0] }) {
  const isFree = item.price === 'FREE';
  return (
    <TouchableOpacity style={lc.card} activeOpacity={0.8}>
      <Text style={lc.emoji}>{item.emoji}</Text>
      <Text style={lc.title} numberOfLines={2}>{item.title}</Text>
      <Text style={lc.level}>{item.level}</Text>
      <View style={lc.footer}>
        <Text style={lc.count}>{item.count} lessons</Text>
        <View style={[lc.priceBadge, isFree && lc.freeBadge]}>
          <Text style={[lc.priceText, isFree && lc.freeText]}>{item.price}</Text>
        </View>
      </View>
    </TouchableOpacity>
  );
}
const lc = StyleSheet.create({
  card:       { width: 148, backgroundColor: CARD, borderWidth: 1, borderColor: BORDER, padding: 14, marginRight: 12 },
  emoji:      { fontSize: 28, marginBottom: 10 },
  title:      { color: CREAM, fontSize: 14, fontWeight: '700', lineHeight: 18, marginBottom: 6 },
  level:      { color: MUTED, fontSize: 11, marginBottom: 12 },
  footer:     { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  count:      { color: GOLD_DIM, fontSize: 10 },
  priceBadge: { backgroundColor: '#1e1a0e', borderWidth: 1, borderColor: GOLD_DIM, paddingHorizontal: 7, paddingVertical: 2 },
  freeBadge:  { borderColor: GREEN, backgroundColor: 'rgba(76,175,118,0.1)' },
  priceText:  { color: GOLD, fontSize: 10, fontWeight: '700' },
  freeText:   { color: GREEN },
});

// ─── Teacher card ─────────────────────────────────────────────────────────────

function TeacherCard({ item }: { item: typeof TEACHERS[0] }) {
  const stars = '★'.repeat(Math.floor(item.rating)) + (item.rating % 1 >= 0.5 ? '½' : '');
  return (
    <TouchableOpacity style={tc.card} activeOpacity={0.8}>
      <View style={tc.avatar}>
        <Text style={tc.initial}>{item.initial}</Text>
      </View>
      <Text style={tc.name}>{item.name}</Text>
      <Text style={tc.specialty} numberOfLines={1}>{item.specialty}</Text>
      <View style={tc.statsRow}>
        <Text style={tc.rating}>{item.rating.toFixed(1)}</Text>
        <Text style={tc.stars}>{stars}</Text>
      </View>
      <Text style={tc.students}>{item.students} students</Text>
      <TouchableOpacity style={tc.hireBtn} activeOpacity={0.8}>
        <Text style={tc.hireTxt}>VIEW PROFILE</Text>
      </TouchableOpacity>
    </TouchableOpacity>
  );
}
const tc = StyleSheet.create({
  card:      { width: 148, backgroundColor: CARD, borderWidth: 1, borderColor: BORDER, padding: 14, marginRight: 12, alignItems: 'center' },
  avatar:    { width: 52, height: 52, borderRadius: 26, backgroundColor: '#2a2214', borderWidth: 1, borderColor: GOLD_DIM, justifyContent: 'center', alignItems: 'center', marginBottom: 10 },
  initial:   { color: GOLD, fontSize: 22, fontWeight: '700' },
  name:      { color: CREAM, fontSize: 14, fontWeight: '700', textAlign: 'center', marginBottom: 4 },
  specialty: { color: MUTED, fontSize: 11, textAlign: 'center', marginBottom: 10 },
  statsRow:  { flexDirection: 'row', alignItems: 'center', gap: 4, marginBottom: 2 },
  rating:    { color: GOLD, fontSize: 13, fontWeight: '700' },
  stars:     { color: GOLD, fontSize: 11 },
  students:  { color: MUTED, fontSize: 10, marginBottom: 12 },
  hireBtn:   { borderWidth: 1, borderColor: GOLD_DIM, paddingHorizontal: 12, paddingVertical: 6 },
  hireTxt:   { color: GOLD_DIM, fontSize: 9, fontWeight: '700', letterSpacing: 2 },
});

// ─── LessonsScreen ────────────────────────────────────────────────────────────

export default function LessonsScreen() {
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

      {/* ── Section 1: Community Videos ── */}
      <View style={s.section}>
        <SectionHeader
          title="Community Videos"
          sub="Recordings shared by musicians like you"
        />
        <FlatList
          data={VIDEOS}
          keyExtractor={i => i.id}
          renderItem={({ item }) => <VideoCard item={item} />}
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={s.hList}
        />
      </View>

      {/* ── Section 2: Lessons ── */}
      <View style={s.section}>
        <SectionHeader
          title="Lessons"
          sub="Free and premium courses for all levels"
        />
        <FlatList
          data={LESSONS}
          keyExtractor={i => i.id}
          renderItem={({ item }) => <LessonCard item={item} />}
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={s.hList}
        />
      </View>

      {/* ── Section 3: Teachers ── */}
      <View style={s.section}>
        <SectionHeader
          title="Teachers"
          sub="Connect with verified music instructors"
        />
        <FlatList
          data={TEACHERS}
          keyExtractor={i => i.id}
          renderItem={({ item }) => <TeacherCard item={item} />}
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={s.hList}
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

  divider:  { height: 1, backgroundColor: BORDER, marginBottom: 32 },

  section:  { marginBottom: 36 },
  hList:    { paddingRight: 24 },
});
