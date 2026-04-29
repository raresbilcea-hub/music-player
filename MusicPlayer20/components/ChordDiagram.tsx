import { View, Text, StyleSheet, Modal, TouchableOpacity, ScrollView } from 'react-native';
import { lookupChord, type ChordShape } from '@/lib/chordDiagrams';

// ─── Design tokens ────────────────────────────────────────────────────────────

const GOLD     = '#c9a84c';
const GOLD_DIM = '#8a6f32';
const BG       = '#0e0c09';
const CREAM    = '#e8dfc8';
const MUTED    = '#6b6254';
const BORDER   = '#2a2318';
const RED      = '#c0392b';

// ─── Diagram constants ────────────────────────────────────────────────────────

const SG        = 30;   // gap between strings (px)
const FH        = 36;   // height of each fret row (px)
const FR        = 4;    // number of frets to show
const DOT_R     = 10;   // dot radius
const PAD_H     = 20;   // horizontal padding inside diagram
const PAD_TOP   = 30;   // space above nut for open/muted symbols
const PAD_BOT   = 12;   // space below last fret

const DIAG_W = SG * 5 + PAD_H * 2;        // 190
const DIAG_H = PAD_TOP + FH * FR + PAD_BOT; // 202

const STRING_LABELS = ['E', 'A', 'D', 'G', 'B', 'e'];

// ─── Fretboard renderer ───────────────────────────────────────────────────────

function Fretboard({ shape }: { shape: ChordShape }) {
  const { positions, baseFret = 1 } = shape;

  // Effective base: if chord doesn't start at fret 1, show fret number
  const frettedPositions = positions.filter(p => p > 0);
  const minFret = frettedPositions.length > 0 ? Math.min(...frettedPositions) : 1;
  const base = baseFret > 1 ? baseFret : minFret > FR ? minFret : 1;
  const showFretNum = base > 1;

  return (
    <View style={{ width: DIAG_W, height: DIAG_H + (showFretNum ? 16 : 0) }}>

      {/* ── String labels ── */}
      {STRING_LABELS.map((label, si) => (
        <Text
          key={si}
          style={[
            dg.stringLabel,
            { left: PAD_H + si * SG - 5, top: 0 },
          ]}
        >
          {label}
        </Text>
      ))}

      {/* ── Open / Mute indicators ── */}
      {positions.map((pos, si) => {
        if (pos === 0)  return (
          <Text key={si} style={[dg.openMark,  { left: PAD_H + si * SG - 6, top: 13 }]}>○</Text>
        );
        if (pos === -1) return (
          <Text key={si} style={[dg.muteMark,  { left: PAD_H + si * SG - 5, top: 13 }]}>✕</Text>
        );
        return null;
      })}

      {/* ── Nut (thick bar at fret 0 if starting at fret 1) ── */}
      <View style={[
        dg.nut,
        { top: PAD_TOP, width: SG * 5, left: PAD_H },
        showFretNum ? { backgroundColor: BORDER, height: 1.5 } : {},
      ]} />

      {/* ── Fret lines ── */}
      {Array.from({ length: FR }).map((_, fi) => (
        <View
          key={fi}
          style={[dg.fretLine, { top: PAD_TOP + (fi + 1) * FH, left: PAD_H, width: SG * 5 }]}
        />
      ))}

      {/* ── String lines ── */}
      {Array.from({ length: 6 }).map((_, si) => (
        <View
          key={si}
          style={[dg.stringLine, { left: PAD_H + si * SG, top: PAD_TOP, height: FH * FR }]}
        />
      ))}

      {/* ── Dots ── */}
      {positions.map((pos, si) => {
        if (pos <= 0) return null;
        const row = pos - base; // 0-based row index
        if (row < 0 || row >= FR) return null;
        const cx = PAD_H + si * SG;
        const cy = PAD_TOP + row * FH + FH / 2;
        return (
          <View
            key={si}
            style={[
              dg.dot,
              {
                left: cx - DOT_R,
                top:  cy - DOT_R,
                width:  DOT_R * 2,
                height: DOT_R * 2,
                borderRadius: DOT_R,
              },
            ]}
          />
        );
      })}

      {/* ── Fret number indicator ── */}
      {showFretNum && (
        <Text style={[dg.fretNum, { top: PAD_TOP + FH / 2 - 7, left: PAD_H + SG * 5 + 6 }]}>
          {base}fr
        </Text>
      )}
    </View>
  );
}

const dg = StyleSheet.create({
  stringLabel: { position: 'absolute', color: MUTED, fontSize: 9, letterSpacing: 0.5, width: 12, textAlign: 'center' },
  openMark:    { position: 'absolute', color: GOLD,  fontSize: 12 },
  muteMark:    { position: 'absolute', color: RED,   fontSize: 11, fontWeight: '600' },
  nut:         { position: 'absolute', height: 4, backgroundColor: CREAM },
  fretLine:    { position: 'absolute', height: 1, backgroundColor: '#302a1e' },
  stringLine:  { position: 'absolute', width: 1, backgroundColor: '#302a1e' },
  dot:         { position: 'absolute', backgroundColor: GOLD },
  fretNum:     { position: 'absolute', color: MUTED, fontSize: 10 },
});

// ─── Inline chord preview (no modal) ─────────────────────────────────────────

export function ChordPreview({ chordName }: { chordName: string }) {
  if (!chordName?.trim()) return null;
  const shape = lookupChord(chordName);
  if (!shape) return (
    <View style={cp.wrap}>
      <Text style={cp.notFoundTxt}>♩  Not in chord library yet</Text>
    </View>
  );
  return (
    <View style={cp.wrap}>
      <Fretboard shape={shape} />
    </View>
  );
}

const cp = StyleSheet.create({
  wrap:        { alignItems: 'center', paddingVertical: 12 },
  notFoundTxt: { color: MUTED, fontSize: 11, letterSpacing: 0.5, fontStyle: 'italic' },
});

// ─── Chord diagram modal ──────────────────────────────────────────────────────

export function ChordDiagramModal({
  chordName,
  onClose,
}: {
  chordName: string | null;
  onClose:   () => void;
}) {
  const visible = !!chordName;
  const shape   = chordName ? lookupChord(chordName) : null;

  return (
    <Modal
      transparent
      visible={visible}
      animationType="fade"
      onRequestClose={onClose}
    >
      <TouchableOpacity style={md.overlay} activeOpacity={1} onPress={onClose}>
        <TouchableOpacity activeOpacity={1} onPress={() => {}}>
          <View style={md.box}>

            {/* Header */}
            <View style={md.header}>
              <Text style={md.chordName}>{chordName}</Text>
              <TouchableOpacity onPress={onClose} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
                <Text style={md.closeBtn}>✕</Text>
              </TouchableOpacity>
            </View>

            {shape ? (
              <>
                <Fretboard shape={shape} />
                <View style={md.legend}>
                  <Text style={md.legendItem}><Text style={{ color: GOLD }}>○</Text> open string</Text>
                  <Text style={md.legendItem}><Text style={{ color: RED }}>✕</Text> muted</Text>
                  <Text style={md.legendItem}><Text style={{ color: GOLD }}>●</Text> fret position</Text>
                </View>
              </>
            ) : (
              <View style={md.notFound}>
                <Text style={md.notFoundSym}>♩</Text>
                <Text style={md.notFoundTxt}>Not in chord library yet</Text>
                <Text style={md.notFoundSub}>We're adding new shapes regularly.</Text>
              </View>
            )}

          </View>
        </TouchableOpacity>
      </TouchableOpacity>
    </Modal>
  );
}

const md = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.82)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  box: {
    backgroundColor: '#131007',
    borderWidth: 1,
    borderColor: BORDER,
    padding: 24,
    paddingBottom: 20,
    width: DIAG_W + 48,
    alignItems: 'center',
  },
  header: {
    width: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 20,
  },
  chordName: {
    color: GOLD,
    fontSize: 28,
    fontWeight: '700',
    letterSpacing: 1,
  },
  closeBtn: {
    color: MUTED,
    fontSize: 18,
  },
  legend: {
    flexDirection: 'row',
    gap: 16,
    marginTop: 16,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: BORDER,
  },
  legendItem: {
    color: MUTED,
    fontSize: 10,
    letterSpacing: 0.3,
  },
  notFound: {
    alignItems: 'center',
    paddingVertical: 24,
  },
  notFoundSym: {
    color: GOLD_DIM,
    fontSize: 32,
    marginBottom: 12,
  },
  notFoundTxt: {
    color: CREAM,
    fontSize: 14,
    fontWeight: '600',
    marginBottom: 6,
  },
  notFoundSub: {
    color: MUTED,
    fontSize: 12,
    textAlign: 'center',
  },
});
