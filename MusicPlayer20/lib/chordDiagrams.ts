// Full professional guitar chord library.
// positions: [E2, A2, D3, G3, B3, e4] — low string to high
// -1 = muted   0 = open   n = fret n
// baseFret: which fret the diagram starts on (auto-computed)

export type ChordShape = {
  positions: number[];
  baseFret?:  number;
};

// ─── Shape builders ───────────────────────────────────────────────────────────

function makeShape(positions: number[]): ChordShape {
  const fretted = positions.filter(p => p > 0);
  if (fretted.length === 0) return { positions };
  const minFret = Math.min(...fretted);
  return minFret <= 1 ? { positions } : { positions, baseFret: minFret };
}

// E-string barre shapes (root on string 6 at fret f)
function ePos(f: number, type: string): number[] {
  switch (type) {
    case 'major': return [f,   f+2, f+2, f+1, f,   f  ];
    case 'minor': return [f,   f+2, f+2, f,   f,   f  ];
    case '7':     return [f,   f+2, f,   f+1, f,   f  ];
    case 'maj7':  return [f,   f+2, f+1, f+1, f,   f  ];
    case 'min7':  return [f,   f+2, f,   f,   f,   f  ];
    case 'sus4':  return [f,   f+2, f+2, f+2, f,   f  ];
    case 'sus2':  return f === 0 ? [0,2,4,4,0,0] : [f, f+2, f+2, f-1, f, f];
    case 'aug':   return [f,   f+3, f+2, f+1, f+1, -1 ];
    case '5':     return [f,   f+2, f+2, -1,  -1,  -1 ];
    case '9':     return [f,   f+2, f,   f+1, f,   f+2];
    case 'maj9':  return [f,   f+2, f+1, f+1, f,   f+2];
    case 'min9':  return [f,   f+2, f,   f,   f,   f+2];
    case 'add9':  return [f,   f+2, f+2, f+1, f,   f+2];
    case '6':     return [f,   f+2, f+2, f+1, f+2, f  ];
    case 'min6':  return [f,   f+2, f+2, f,   f+2, f  ];
    case '11':    return [f,   f+2, f,   f+2, f,   f  ];
    case '13':    return [f,   f+2, f,   f+1, f+2, f+2];
    default:      return [f,   f+2, f+2, f+1, f,   f  ];
  }
}

// A-string barre shapes for dim / dim7 (root on string 5 at fret f)
function aPos(f: number, type: string): number[] {
  switch (type) {
    case 'dim':  return [-1, f, f+1, f+2, f+1, -1  ];
    case 'dim7': return [-1, f, f+1, f+2, f+1, f+2 ];
    default:     return [-1, f, f+2, f+2, f+1, -1  ];
  }
}

// ─── Root note table ──────────────────────────────────────────────────────────

const ROOTS: { names: string[]; ef: number; af: number }[] = [
  { names: ['C'],        ef: 8,  af: 3  },
  { names: ['C#','Db'],  ef: 9,  af: 4  },
  { names: ['D'],        ef: 10, af: 5  },
  { names: ['D#','Eb'],  ef: 11, af: 6  },
  { names: ['E'],        ef: 0,  af: 7  },
  { names: ['F'],        ef: 1,  af: 8  },
  { names: ['F#','Gb'],  ef: 2,  af: 9  },
  { names: ['G'],        ef: 3,  af: 10 },
  { names: ['G#','Ab'],  ef: 4,  af: 11 },
  { names: ['A'],        ef: 5,  af: 0  },
  { names: ['A#','Bb'],  ef: 6,  af: 1  },
  { names: ['B'],        ef: 7,  af: 2  },
];

const CHORD_TYPES: { type: string; suffix: string }[] = [
  { type: 'major', suffix: ''     },
  { type: 'minor', suffix: 'm'    },
  { type: '7',     suffix: '7'    },
  { type: 'maj7',  suffix: 'maj7' },
  { type: 'min7',  suffix: 'm7'   },
  { type: 'sus2',  suffix: 'sus2' },
  { type: 'sus4',  suffix: 'sus4' },
  { type: 'dim',   suffix: 'dim'  },
  { type: 'dim7',  suffix: 'dim7' },
  { type: 'aug',   suffix: 'aug'  },
  { type: '5',     suffix: '5'    },
  { type: '9',     suffix: '9'    },
  { type: 'maj9',  suffix: 'maj9' },
  { type: 'min9',  suffix: 'm9'   },
  { type: 'add9',  suffix: 'add9' },
  { type: '6',     suffix: '6'    },
  { type: 'min6',  suffix: 'm6'   },
  { type: '11',    suffix: '11'   },
  { type: '13',    suffix: '13'   },
];

// ─── Generate all 12 × 19 shapes ─────────────────────────────────────────────

function buildGenerated(): Record<string, ChordShape> {
  const dict: Record<string, ChordShape> = {};
  for (const root of ROOTS) {
    for (const { type, suffix } of CHORD_TYPES) {
      const useDim = type === 'dim' || type === 'dim7';
      const pos    = useDim ? aPos(root.af, type) : ePos(root.ef, type);
      const shape  = makeShape(pos);
      for (const name of root.names) {
        dict[name + suffix] = shape;
      }
    }
  }
  return dict;
}

// ─── Open-position overrides (better voicings than barre where available) ─────

const OPEN: Record<string, ChordShape> = {
  // C
  'C':      { positions: [-1, 3, 2, 0, 1, 0] },
  'Cm':     { positions: [-1, 3, 5, 5, 4, 3], baseFret: 3 },
  'C7':     { positions: [-1, 3, 2, 3, 1, 0] },
  'Cmaj7':  { positions: [-1, 3, 2, 0, 0, 0] },
  'Cm7':    { positions: [-1, 3, 5, 3, 4, 3], baseFret: 3 },
  'Csus2':  { positions: [-1, 3, 5, 5, 3, 3], baseFret: 3 },
  'Csus4':  { positions: [-1, 3, 3, 0, 1, 1] },
  'Cadd9':  { positions: [-1, 3, 2, 0, 3, 0] },
  'Caug':   { positions: [-1, 3, 2, 1, 1, 0] },
  'C6':     { positions: [-1, 3, 2, 2, 1, 0] },
  'Cm6':    { positions: [-1, 3, 5, 5, 4, 5], baseFret: 3 },

  // D
  'D':      { positions: [-1, -1, 0, 2, 3, 2] },
  'Dm':     { positions: [-1, -1, 0, 2, 3, 1] },
  'D7':     { positions: [-1, -1, 0, 2, 1, 2] },
  'Dmaj7':  { positions: [-1, -1, 0, 2, 2, 2] },
  'Dm7':    { positions: [-1, -1, 0, 2, 1, 1] },
  'Dsus2':  { positions: [-1, -1, 0, 2, 3, 0] },
  'Dsus4':  { positions: [-1, -1, 0, 2, 3, 3] },
  'Dadd9':  { positions: [-1, -1, 0, 2, 3, 0] },
  'D6':     { positions: [-1, -1, 0, 2, 0, 2] },

  // E
  'E':      { positions: [0, 2, 2, 1, 0, 0] },
  'Em':     { positions: [0, 2, 2, 0, 0, 0] },
  'E7':     { positions: [0, 2, 0, 1, 0, 0] },
  'Emaj7':  { positions: [0, 2, 1, 1, 0, 0] },
  'Em7':    { positions: [0, 2, 0, 0, 0, 0] },
  'Esus4':  { positions: [0, 2, 2, 2, 0, 0] },
  'Esus2':  { positions: [0, 2, 4, 4, 0, 0] },
  'Eadd9':  { positions: [0, 2, 2, 1, 0, 2] },
  'Eaug':   { positions: [0, 3, 2, 1, 1, 0] },
  'E6':     { positions: [0, 2, 2, 1, 2, 0] },
  'Em6':    { positions: [0, 2, 2, 0, 2, 0] },

  // F
  'F':      { positions: [1, 3, 3, 2, 1, 1] },
  'Fm':     { positions: [1, 3, 3, 1, 1, 1] },
  'F7':     { positions: [1, 3, 1, 2, 1, 1] },
  'Fmaj7':  { positions: [-1, -1, 3, 2, 1, 0] },
  'Fm7':    { positions: [1, 3, 1, 1, 1, 1] },
  'Fsus4':  { positions: [1, 3, 3, 3, 1, 1] },
  'Faug':   { positions: [1, 4, 3, 2, 2, -1] },

  // G
  'G':      { positions: [3, 2, 0, 0, 3, 3] },
  'Gm':     { positions: [3, 5, 5, 3, 3, 3], baseFret: 3 },
  'G7':     { positions: [3, 2, 0, 0, 0, 1] },
  'Gmaj7':  { positions: [3, 2, 0, 0, 0, 2] },
  'Gm7':    { positions: [3, 5, 3, 3, 3, 3], baseFret: 3 },
  'Gsus4':  { positions: [3, 3, 0, 0, 1, 1] },
  'Gadd9':  { positions: [3, 2, 0, 2, 3, 3] },
  'G6':     { positions: [3, 2, 0, 0, 0, 0] },

  // A
  'A':      { positions: [-1, 0, 2, 2, 2, 0] },
  'Am':     { positions: [-1, 0, 2, 2, 1, 0] },
  'A7':     { positions: [-1, 0, 2, 0, 2, 0] },
  'Amaj7':  { positions: [-1, 0, 2, 1, 2, 0] },
  'Am7':    { positions: [-1, 0, 2, 0, 1, 0] },
  'Asus2':  { positions: [-1, 0, 2, 2, 0, 0] },
  'Asus4':  { positions: [-1, 0, 2, 2, 3, 0] },
  'Aaug':   { positions: [-1, 0, 3, 2, 2, 1] },
  'Aadd9':  { positions: [-1, 0, 2, 2, 0, 0] },
  'A6':     { positions: [-1, 0, 2, 2, 2, 2] },
  'Am6':    { positions: [-1, 0, 2, 2, 1, 2] },

  // B
  'B':      { positions: [-1, 2, 4, 4, 4, 2] },
  'Bm':     { positions: [-1, 2, 4, 4, 3, 2] },
  'B7':     { positions: [-1, 2, 1, 2, 0, 2] },
  'Bmaj7':  { positions: [-1, 2, 4, 3, 4, 2] },
  'Bm7':    { positions: [-1, 2, 0, 2, 0, 2] },
  'Bsus2':  { positions: [-1, 2, 4, 4, 2, 2] },
  'Bsus4':  { positions: [-1, 2, 4, 4, 5, 2] },
  'Baug':   { positions: [-1, 2, 1, 0, 0, -1] },
  'Bdim':   { positions: [-1, 2, 3, 4, 3, -1] },
  'Bdim7':  { positions: [-1, 2, 3, 4, 3, 4] },

  // Additional well-known shapes
  'Bb':     { positions: [-1, 1, 3, 3, 3, 1] },
  'Bbm':    { positions: [-1, 1, 3, 3, 2, 1] },
  'Bb7':    { positions: [-1, 1, 3, 1, 3, 1] },
  'Bbmaj7': { positions: [-1, 1, 3, 2, 3, 1] },
  'Bbm7':   { positions: [-1, 1, 3, 1, 2, 1] },
  'Bbsus2': { positions: [-1, 1, 3, 3, 1, 1] },
  'Bbsus4': { positions: [-1, 1, 3, 3, 4, 1] },

  'F#m':    { positions: [2, 4, 4, 2, 2, 2] },
  'F#':     { positions: [2, 4, 4, 3, 2, 2] },
  'F#7':    { positions: [2, 4, 2, 3, 2, 2] },
  'F#m7':   { positions: [2, 4, 2, 2, 2, 2] },

  'Eb':     { positions: [-1, -1, 1, 3, 4, 3] },
  'Ebm':    { positions: [-1, -1, 1, 3, 4, 2] },
  'Eb7':    { positions: [-1, -1, 1, 3, 2, 3] },

  'Ab':     { positions: [4, 6, 6, 5, 4, 4], baseFret: 4 },
  'Abm':    { positions: [4, 6, 6, 4, 4, 4], baseFret: 4 },

  'C#m':    { positions: [-1, 4, 6, 6, 5, 4], baseFret: 4 },
  'C#':     { positions: [-1, 4, 6, 6, 6, 4], baseFret: 4 },
};

// ─── Final dictionary = generated + open overrides ───────────────────────────

const CHORDS: Record<string, ChordShape> = {
  ...buildGenerated(),
  ...OPEN,
};

// ─── Public API ───────────────────────────────────────────────────────────────

export function lookupChord(name: string): ChordShape | null {
  if (!name) return null;
  if (CHORDS[name]) return CHORDS[name];

  // Strip slash bass note (G/B → G)
  const base = name.split('/')[0];
  if (CHORDS[base]) return CHORDS[base];

  // Normalise Unicode accidentals
  const norm = name.replace(/♭/g, 'b').replace(/♯/g, '#').split('/')[0];
  if (CHORDS[norm]) return CHORDS[norm];

  return null;
}

// Returns all known chord names sorted (used for suggestions)
export function getAllChordNames(): string[] {
  return Object.keys(CHORDS).sort();
}
