// イラストとアイコン。
// 配信された絵(SVG)があればそれを描き、無い記事(以前の配信分・圏外)にはジャンルの絵を代わりに置く。
import { h, svgFragment } from './util.js';
import { GENRES, CATS } from './config.js';
import { svgOf } from './store.js';

const NS = 'http://www.w3.org/2000/svg';

// 画面の部品に使う線のアイコン(24px)
const I = {
  x: '<path d="M5 5l14 14M19 5L5 19" stroke-width="2.3"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>',
  cards: '<rect x="4" y="7" width="13" height="13" rx="2.5"/><path d="M8 4h9.5A2.5 2.5 0 0 1 20 6.5V16"/>',
  me: '<path d="M5 19V9M12 19V5M19 19v-7"/>',
  save: '<path d="M7 4h10a1 1 0 0 1 1 1v15l-6-4-6 4V5a1 1 0 0 1 1-1z"/>',
  todo: '<rect x="4" y="4" width="16" height="16" rx="4"/><path d="M8.5 12.2l2.5 2.5 4.8-5.2"/>',
  memo: '<path d="M6 4h9l4 4v12H6z"/><path d="M9 11h7M9 15h5"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5" stroke-width="2.4"/>',
  left: '<path d="M14.5 5l-7 7 7 7"/>',
  right: '<path d="M9.5 5l7 7-7 7"/>',
  flame: '<path d="M12 3c1 3.5 5 5.5 5 10a5 5 0 0 1-10 0c0-2 1-3.2 2-4.2.4 1.4 1 2 1.6 2.2C10.200 8.500 11 5.500 12 3z"/>',
  talk: '<path d="M4 5h16v11H9l-5 4z"/>',
  flow: '<circle cx="6" cy="6" r="2.2"/><circle cx="6" cy="18" r="2.2"/><circle cx="18" cy="12" r="2.2"/><path d="M6 8.200v7.600M8 6.800l8 4M8 17.200l8-4"/>',
};
export function icon(name, size) {
  const s = size || 22;
  return h('span', {
    style: { display: 'inline-flex' },
    html: '<svg width="' + s + '" height="' + s + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + I[name] + '</svg>',
  }).firstChild;
}

// ジャンルの絵(雑学と同じ手描きの線。64px)
const K = 'stroke="#2a2a2a" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"';
const G = {
  food: '<path d="M14 26h30v9a15 15 0 0 1-30 0z" fill="#fde2c4" ' + K + '/><path d="M44 29h4a6 6 0 0 1 0 12h-5" fill="none" ' + K + '/><path d="M22 10q4 4 0 9M30 8q4 5 0 11M38 10q4 4 0 9" fill="none" ' + K + '/><path d="M10 54h38" ' + K + '/>',
  word: '<path d="M10 12h44v30H31l-11 10V42H10z" fill="#dfe3fb" ' + K + '/><path d="M22 23h20M22 31h13" ' + K + '/>',
  thing: '<path d="M32 8a16 16 0 0 0-9 29v7h18v-7a16 16 0 0 0-9-29z" fill="#d3efec" ' + K + '/><path d="M25 51h14M28 57h8" ' + K + '/><path d="M27 30l5-7 5 7" fill="none" ' + K + '/>',
  psych: '<path d="M32 54C14 42 8 32 8 23a11 11 0 0 1 24-5 11 11 0 0 1 24 5c0 9-6 19-24 31z" fill="#f9d9e3" ' + K + '/>',
  season: '<path d="M12 52C10 28 26 10 54 10c0 28-18 44-42 42z" fill="#dcedd3" ' + K + '/><path d="M12 52c8-16 20-28 34-34" fill="none" ' + K + '/>',
  history: '<path d="M18 8h28M18 56h28" ' + K + '/><path d="M21 8c0 14 22 16 22 24s-22 10-22 24h22c0-14-22-16-22-24S43 22 43 8z" fill="#efe0cf" ' + K + '/>',
  science: '<path d="M26 8h12M28 8v16L14 50a4 4 0 0 0 4 6h28a4 4 0 0 0 4-6L36 24V8" fill="#d6e6f8" ' + K + '/><path d="M20 42h24" ' + K + '/><circle cx="29" cy="48" r="1.6" fill="#2a2a2a"/><circle cx="36" cy="45" r="1.6" fill="#2a2a2a"/>',
  culture: '<circle cx="32" cy="32" r="23" fill="#e6dcf6" ' + K + '/><path d="M9 32h46M32 9c-9 7-9 39 0 46M32 9c9 7 9 39 0 46" fill="none" ' + K + '/>',
  sports: '<circle cx="32" cy="32" r="23" fill="#fbd9d5" ' + K + '/><path d="M14 18c8 6 8 22 0 28M50 18c-8 6-8 22 0 28M32 9v46" fill="none" ' + K + '/>',
  world: '<circle cx="32" cy="32" r="23" fill="#d3efec" stroke="#0f9b8e" stroke-width="2.6"/><path d="M9 32h46M32 9c-9 7-9 39 0 46M32 9c9 7 9 39 0 46" fill="none" stroke="#0f9b8e" stroke-width="2.6" stroke-linecap="round"/>',
  japan: '<rect x="8" y="14" width="48" height="36" rx="6" fill="#fff" stroke="#e8384f" stroke-width="2.6"/><circle cx="32" cy="32" r="10" fill="#e8384f"/>',
  ai: '<rect x="16" y="16" width="32" height="32" rx="8" fill="#e6dcfd" stroke="#7a55f0" stroke-width="2.6"/><path d="M24 8v8M32 8v8M40 8v8M24 48v8M32 48v8M40 48v8M8 24h8M8 32h8M8 40h8M48 24h8M48 32h8M48 40h8" stroke="#7a55f0" stroke-width="2.6" stroke-linecap="round"/><path d="M32 24l2.500 5.500L40 32l-5.500 2.500L32 40l-2.500-5.500L24 32l5.500-2.500z" fill="#7a55f0"/>',
};
export function glyph(key) {
  return h('span', {
    style: { display: 'contents' },
    html: '<svg viewBox="0 0 64 64" aria-hidden="true">' + (G[key] || G.word) + '</svg>',
  }).firstChild;
}

export function colorOf(it) {
  if (it.kind === 'news') return (CATS[it.data.cat] || CATS.world).color;
  return (GENRES[it.data.genre] || GENRES.word).color;
}

// 記事の絵。opts.thumb=小さい枠。絵が無いときはジャンルの絵＋キーワードを出す。
export function illust(it, opts) {
  const o = opts || {};
  const src = svgOf(it);
  const news = it.kind === 'news';
  if (src) {
    const parsed = svgFragment(src);
    if (parsed) {
      const svg = document.createElementNS(NS, 'svg');
      svg.setAttribute('class', 'ill');
      svg.setAttribute('viewBox', news ? '0 0 400 225' : '0 0 320 200');
      svg.setAttribute('role', 'img');
      svg.setAttribute('aria-label', parsed.label || (it.data.keyword || it.data.title || '') + 'のイラスト');
      if (news) {
        svg.append(parsed.frag);
      } else {
        svg.style.fontFamily = 'var(--f-zen)';
        const g = document.createElementNS(NS, 'g');
        g.setAttribute('filter', 'url(#hd)'); // 手描きのゆらぎ(全イラスト共通)
        g.append(parsed.frag);
        svg.append(g);
      }
      return svg;
    }
  }
  const word = news ? '' : it.data.keyword;
  const ph = h('div', { class: 'ph' + (news ? ' wide' : '') + (!o.thumb && !word ? ' slim' : ''), style: { '--c': colorOf(it) } });
  ph.append(glyph(news ? it.data.cat : it.data.genre));
  if (word && !o.thumb) ph.append(h('span', null, word));
  return ph;
}
