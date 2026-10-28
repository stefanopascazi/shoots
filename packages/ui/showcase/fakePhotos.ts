/**
 * Stand-in photographs for the showcase: small SVG landscapes generated from a
 * seed, so the page needs no image files and carries no third-party pictures.
 */
const SCENES = [
  { sky: ['#f6c38b', '#e2785a'], sun: '#ffe7b0', land: ['#3b2a35', '#1d1620'] },
  { sky: ['#9fc6e8', '#d9ecf7'], sun: '#ffffff', land: ['#5d7d4f', '#2f4a2c'] },
  { sky: ['#1f2b4d', '#4c4f86'], sun: '#f2e7c9', land: ['#141a2a', '#0b0f19'] },
  { sky: ['#f2d6b3', '#c9a07a'], sun: '#fff3d6', land: ['#8a6a4a', '#4e3a28'] },
  { sky: ['#b9d7d3', '#e8f0ec'], sun: '#ffffff', land: ['#4d6e71', '#22393d'] },
  { sky: ['#e7a6a1', '#7a5a8c'], sun: '#ffd9c2', land: ['#2d2238', '#120d18'] },
  { sky: ['#cfd6dd', '#8f9aa6'], sun: '#f4f6f8', land: ['#5a6068', '#2b2f35'] },
  { sky: ['#ffd38a', '#ff9e5e'], sun: '#fff1c9', land: ['#6b3b2a', '#2e1a14'] },
] as const;

export function fakePhoto(seed: number, width = 300, height = 200): string {
  const s = SCENES[seed % SCENES.length];
  const sunX = 60 + ((seed * 47) % 180);
  const sunY = 50 + ((seed * 29) % 50);
  const ridge = 120 + ((seed * 13) % 30);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 300 200" preserveAspectRatio="xMidYMid slice">
<defs><linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${s.sky[0]}"/><stop offset="1" stop-color="${s.sky[1]}"/></linearGradient>
<linearGradient id="l" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${s.land[0]}"/><stop offset="1" stop-color="${s.land[1]}"/></linearGradient></defs>
<rect width="300" height="200" fill="url(#s)"/><circle cx="${sunX}" cy="${sunY}" r="18" fill="${s.sun}" opacity=".9"/>
<path d="M0 ${ridge} L60 ${ridge - 28} L110 ${ridge - 6} L170 ${ridge - 40} L230 ${ridge - 12} L300 ${ridge - 30} V200 H0Z" fill="url(#l)" opacity=".75"/>
<path d="M0 ${ridge + 22} Q80 ${ridge + 4} 150 ${ridge + 20} T300 ${ridge + 14} V200 H0Z" fill="url(#l)"/></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}
