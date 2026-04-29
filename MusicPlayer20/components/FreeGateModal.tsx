import { Modal, View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';

const GOLD     = '#c9a84c';
const GOLD_DIM = '#8a6f32';
const BG       = '#0e0c09';
const CREAM    = '#e8dfc8';
const MUTED    = '#6b6254';
const BORDER   = '#2a2318';

export function FreeGateModal({ visible }: { visible: boolean }) {
  const router = useRouter();

  return (
    <Modal visible={visible} transparent animationType="slide">
      <View style={s.overlay}>
        <View style={s.sheet}>

          <Text style={s.symbol}>✦</Text>
          <Text style={s.heading}>You've used your free preview.</Text>
          <Text style={s.sub}>
            Create a free account to keep searching, identifying songs,
            and building your chord library.
          </Text>

          <View style={s.features}>
            {[
              'Unlimited song searches',
              'Identify songs by recording',
              'Full chord charts & editing',
              'History synced across devices',
            ].map(f => (
              <Text key={f} style={s.featureItem}>✓  {f}</Text>
            ))}
          </View>

          <TouchableOpacity
            style={s.primaryBtn}
            onPress={() => router.replace('/register')}
            activeOpacity={0.85}
          >
            <Text style={s.primaryTxt}>CREATE FREE ACCOUNT</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={s.secondaryBtn}
            onPress={() => router.replace('/login')}
            activeOpacity={0.7}
          >
            <Text style={s.secondaryTxt}>I already have an account  →</Text>
          </TouchableOpacity>

        </View>
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.85)',
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: '#100e09',
    borderTopWidth: 1,
    borderTopColor: BORDER,
    paddingHorizontal: 28,
    paddingTop: 36,
    paddingBottom: 52,
  },
  symbol:  { color: GOLD, fontSize: 28, marginBottom: 20 },
  heading: { color: CREAM, fontSize: 24, fontWeight: 'bold', lineHeight: 30, marginBottom: 12 },
  sub:     { color: MUTED, fontSize: 14, lineHeight: 22, marginBottom: 28 },

  features:    { marginBottom: 32 },
  featureItem: { color: GOLD_DIM, fontSize: 13, lineHeight: 26, letterSpacing: 0.3 },

  primaryBtn: {
    backgroundColor: GOLD,
    paddingVertical: 16,
    alignItems: 'center',
    marginBottom: 14,
  },
  primaryTxt: { color: BG, fontSize: 12, fontWeight: '700', letterSpacing: 2 },

  secondaryBtn: { alignItems: 'center', paddingVertical: 8 },
  secondaryTxt: { color: MUTED, fontSize: 13 },
});
