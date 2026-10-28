/**
 * Icon geometry: 24×24 viewBox, drawn as strokes in currentColor.
 * Drawn for this project, so there is no third-party icon licence to carry.
 */
const circle = (cx: number, cy: number, r: number): string =>
  `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0`;

const STAR = 'M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z';

export const ICON_PATHS = {
  check: ['M5 12.5l4.5 4.5L19 7.5'],
  x: ['M6 6l12 12M18 6L6 18'],
  plus: ['M12 5v14M5 12h14'],
  minus: ['M5 12h14'],
  star: [STAR],
  flag: ['M5.5 21V4M5.5 4h11l-2.5 4 2.5 4h-11'],
  image: ['M5.5 4.5h13a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2v-11a2 2 0 0 1 2-2z', circle(9, 9.5, 1.5), 'M3.5 16.5l5-4.5 4 3.5 3-2.5 5 4'],
  camera: ['M4 8.5a2 2 0 0 1 2-2h1.8l1.7-2.5h5l1.7 2.5H18a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z', circle(12, 13, 3.5)],
  sliders: ['M4 7h9M17 7h3M4 17h3M11 17h9', circle(15, 7, 2), circle(9, 17, 2)],
  sparkle: ['M12 3.5l1.9 5.1 5.1 1.9-5.1 1.9-1.9 5.1-1.9-5.1L5 10.5l5.1-1.9z', 'M18.5 16v4M16.5 18h4'],
  play: ['M8 5.5v13l10.5-6.5z'],
  stop: ['M7.5 6h9A1.5 1.5 0 0 1 18 7.5v9a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 6 16.5v-9A1.5 1.5 0 0 1 7.5 6z'],
  'chevron-left': ['M14.5 6l-6 6 6 6'],
  'chevron-right': ['M9.5 6l6 6-6 6'],
  'chevron-down': ['M6 9.5l6 6 6-6'],
  info: [circle(12, 12, 9), 'M12 11v5.5M12 7.8v.1'],
  alert: ['M12 4l9 15.5H3z', 'M12 10v4.5M12 17v.1'],
  'check-circle': [circle(12, 12, 9), 'M8 12.3l2.8 2.8L16.2 9.5'],
  grid: ['M4.5 4.5h6v6h-6zM13.5 4.5h6v6h-6zM4.5 13.5h6v6h-6zM13.5 13.5h6v6h-6z'],
  list: ['M9 6h11M9 12h11M9 18h11M4.5 6v.1M4.5 12v.1M4.5 18v.1'],
  upload: ['M12 15V4.5M7.5 9L12 4.5 16.5 9', 'M4.5 15v3.5a1.5 1.5 0 0 0 1.5 1.5h12a1.5 1.5 0 0 0 1.5-1.5V15'],
  download: ['M12 4.5V15M7.5 10.5L12 15l4.5-4.5', 'M4.5 15v3.5a1.5 1.5 0 0 0 1.5 1.5h12a1.5 1.5 0 0 0 1.5-1.5V15'],
  refresh: ['M19.5 12a7.5 7.5 0 1 1-2.2-5.3', 'M19.5 4.5v4.5H15'],
  search: [circle(11, 11, 6.5), 'M20 20l-4.3-4.3'],
  folder: ['M3.5 7a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v8.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z'],
  external: ['M13.5 4.5h6v6M19.5 4.5l-8.5 8.5', 'M17.5 14v4.5a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1v-11a1 1 0 0 1 1-1H10'],
  more: ['M6 12v.1M12 12v.1M18 12v.1'],
  sun: [circle(12, 12, 4), 'M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4'],
  moon: ['M19.5 14.5A7.5 7.5 0 0 1 9.5 4.5a7.5 7.5 0 1 0 10 10z'],
  trash: ['M4.5 7h15M9.5 7V4.5h5V7M6.5 7l1 12.5h9l1-12.5'],
  eye: ['M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z', circle(12, 12, 3)],
  settings: [circle(12, 12, 3), 'M12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M5.6 18.4l1.8-1.8M16.6 7.4l1.8-1.8'],
} as const satisfies Record<string, readonly string[]>;

/** Icons drawn filled instead of stroked. */
export const FILLED_ICONS: ReadonlySet<string> = new Set(['star-fill', 'play']);

export type IconName = keyof typeof ICON_PATHS | 'star-fill';
