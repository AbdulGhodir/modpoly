// Ilustrasi SVG untuk menu utama & layar loading (tajam di semua ukuran layar, tanpa file gambar).
const PIPS = {
  1: [[50, 50]],
  2: [[28, 28], [72, 72]],
  3: [[28, 28], [50, 50], [72, 72]],
  4: [[28, 28], [72, 28], [28, 72], [72, 72]],
  5: [[28, 28], [72, 28], [50, 50], [28, 72], [72, 72]],
  6: [[28, 25], [72, 25], [28, 50], [72, 50], [28, 75], [72, 75]]
};

/** Satu dadu sebagai elemen <svg> mandiri. */
export function diceSvg(value = 6, size = 56) {
  const pips = (PIPS[value] || PIPS[6]).map(([x, y]) => `<circle cx="${x}" cy="${y}" r="8.5" fill="#c2410c"/>`).join('');
  return `<svg class="art-die" width="${size}" height="${size}" viewBox="0 0 100 100" aria-hidden="true">
    <rect x="6" y="10" width="88" height="88" rx="20" fill="#d9b88a"/>
    <rect x="6" y="4" width="88" height="88" rx="20" fill="#fffdf6" stroke="#ecd9b8" stroke-width="3"/>
    ${pips}</svg>`;
}

/** Satu pion bulat sebagai elemen <svg> mandiri. */
export function pawnSvg(color = '#ef4444', dark = '#b91c1c', size = 44) {
  return `<svg class="art-pawn" width="${size}" height="${size * 1.25}" viewBox="0 0 40 50" aria-hidden="true">
    <ellipse cx="20" cy="45" rx="14" ry="4.5" fill="rgba(60,30,10,.28)"/>
    <path d="M20 12c-6 6-12 18-12 29 0 2 4 4 12 4s12-2 12-4C32 30 26 18 20 12z" fill="${color}"/>
    <path d="M20 12c-6 6-12 18-12 29 0 2 4 4 12 4V12z" fill="${dark}" opacity=".35"/>
    <circle cx="20" cy="11" r="8.5" fill="${color}"/>
    <circle cx="17" cy="8.5" r="3" fill="#fff" opacity=".55"/></svg>`;
}

const EDGE_COLORS = [
  ['#9b6a4a', '#b9a38c', '#9b6a4a', '#6b7280', '#374151', '#6ec6f0', '#b9a38c', '#6ec6f0', '#6ec6f0'],
  ['#f48fb9', '#9ca3af', '#f48fb9', '#f48fb9', '#374151', '#ffa63d', '#ffa63d', '#b9a38c', '#ffa63d'],
  ['#ef5350', '#b9a38c', '#ef5350', '#ef5350', '#374151', '#ffd93b', '#ffd93b', '#6b7280', '#ffd93b'],
  ['#4cc66f', '#4cc66f', '#b9a38c', '#4cc66f', '#374151', '#b9a38c', '#4a6cf0', '#6b7280', '#4a6cf0']
];

const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
const pt = p => `${p[0].toFixed(1)},${p[1].toFixed(1)}`;

/** Papan isometrik dekoratif (versi mini papan di dalam game) lengkap dengan pion & dadu. */
export function heroBoardSvg() {
  const c = [160, 112];
  const outer = [[160, 24], [300, 104], [160, 184], [20, 104]]; // atas, kanan, bawah, kiri
  const inner = outer.map(v => lerp(v, [160, 104], 0.3));
  const rim = outer.map(([x, y]) => [x, y + 12]);
  let tiles = '';
  // urutan sisi: bawah->kiri, kiri->atas, atas->kanan, kanan->bawah
  const edges = [[2, 3], [3, 0], [0, 1], [1, 2]];
  edges.forEach(([a, b], edgeIdx) => {
    for (let i = 0; i < 9; i++) {
      const t0 = 0.1 + i * 0.1, t1 = t0 + 0.1;
      const o0 = lerp(outer[a], outer[b], t0), o1 = lerp(outer[a], outer[b], t1);
      const i0 = lerp(inner[a], inner[b], t0), i1 = lerp(inner[a], inner[b], t1);
      tiles += `<polygon points="${pt(o0)} ${pt(o1)} ${pt(i1)} ${pt(i0)}" fill="#fffaf0" stroke="#e3cba3" stroke-width="1"/>`;
      const e0 = lerp(i0, o0, 0.34), e1 = lerp(i1, o1, 0.34);
      const bandA = [i0, i1, e1, e0];
      tiles += `<polygon points="${bandA.map(pt).join(' ')}" fill="${EDGE_COLORS[edgeIdx][i]}" opacity=".95"/>`;
    }
  });
  const corner = (v, color) => {
    const i = lerp(v, c, 0.3);
    return `<polygon points="${pt(v)} ${pt(lerp(v, outer[(outer.indexOf(v) + 1) % 4], 0.1))} ${pt(lerp(i, inner[(outer.indexOf(v) + 1) % 4], 0.1))} ${pt(i)} ${pt(lerp(i, inner[(outer.indexOf(v) + 3) % 4], 0.1))} ${pt(lerp(v, outer[(outer.indexOf(v) + 3) % 4], 0.1))}" fill="${color}" stroke="#e3cba3" stroke-width="1"/>`;
  };
  const corners = [corner(outer[0], '#4fc3f7'), corner(outer[1], '#ef5350'), corner(outer[2], '#ff7043'), corner(outer[3], '#9aa3b2')].join('');
  return `<svg class="hero-board" viewBox="0 0 320 232" role="img" aria-label="Papan permainan ModPoly">
    <ellipse cx="160" cy="203" rx="118" ry="11" fill="rgba(60,20,10,.30)"/>
    <polygon points="${pt(outer[3])} ${pt(outer[2])} ${pt(outer[1])} ${pt(rim[1])} ${pt(rim[2])} ${pt(rim[3])}" fill="#9a5a2e"/>
    <polygon points="${pt(outer[3])} ${pt(outer[2])} ${pt(outer[1])} ${pt(outer[0])}" fill="#e9d3ad"/>
    <polygon points="${inner.map(pt).join(' ')}" fill="#f1dcb8" stroke="#dcc08f" stroke-width="1.5"/>
    ${tiles}${corners}
    <g class="hero-dice"><g transform="translate(120 70) rotate(-12)">${diceSvg(5, 44).replace('<svg', '<svg x="0" y="0"')}</g><g transform="translate(160 78) rotate(10)">${diceSvg(2, 44).replace('<svg', '<svg x="0" y="0"')}</g></g>
    <g class="hero-pawns">
      <g transform="translate(142 150)">${pawnSvg('#ef4444', '#b91c1c', 30).replace('<svg', '<svg x="0" y="0"')}</g>
      <g transform="translate(166 154)">${pawnSvg('#3b82f6', '#1d4ed8', 30).replace('<svg', '<svg x="0" y="0"')}</g>
      <g transform="translate(60 98)">${pawnSvg('#22c55e', '#15803d', 26).replace('<svg', '<svg x="0" y="0"')}</g>
    </g></svg>`;
}
