// 小さな道具: 日付(日本時間)・DOM・本文の強調・イラストの無害化・検索用の正規化

export const DOW = ['日', '月', '火', '水', '木', '金', '土'];
export const DOW_EN = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
export const MON_EN = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

/* ---------- 日付。すべて日本時間の "YYYY-MM-DD" で扱う ---------- */
export function todayJST() {
  return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}
export function parseDate(s) {
  const p = String(s).split('-').map(Number);
  return new Date(Date.UTC(p[0], p[1] - 1, p[2]));
}
export function addDays(s, n) {
  const d = parseDate(s);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
export function diffDays(a, b) {
  return Math.round((parseDate(a) - parseDate(b)) / 86400000);
}
export function dparts(s) {
  const d = parseDate(s);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(), w: d.getUTCDay() };
}
export function jDate(s) {
  const p = dparts(s);
  return p.m + '月' + p.d + '日（' + DOW[p.w] + '）';
}
export function mdDate(s) {
  const p = dparts(s);
  return p.m + '/' + p.d;
}
export function isDate(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(s || '');
}

/* ---------- DOM ---------- */
export function h(tag, props, ...kids) {
  const e = document.createElement(tag);
  if (props) {
    for (const k in props) {
      const v = props[k];
      if (v == null || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k === 'style') { for (const s in v) e.style.setProperty(s, v[s]); }
      else if (k === 'html') e.innerHTML = v; // アプリに埋め込んだアイコン専用。配信データには使わない
      else if (k.slice(0, 2) === 'on') e.addEventListener(k.slice(2), v);
      else if (v === true) e.setAttribute(k, '');
      else e.setAttribute(k, v);
    }
  }
  append(e, kids);
  return e;
}
export function append(e, kids) {
  for (const k of kids) {
    if (k == null || k === false) continue;
    if (Array.isArray(k)) append(e, k);
    else e.append(k.nodeType ? k : document.createTextNode(String(k)));
  }
  return e;
}
export function clear(e) {
  while (e.firstChild) e.removeChild(e.firstChild);
  return e;
}

/* ---------- 本文の強調 ----------
   ==ここ== 黄色マーカー / **ここ** 太字 / [[ここ]] 用語(青)。
   以前のページの <mark> <em class="kw"> <b> が混ざっていても同じ見た目になるよう読み替える。 */
const ENT = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ' };
export function plainMarkup(text) {
  let s = String(text == null ? '' : text);
  if (s.indexOf('<') >= 0) {
    s = s.replace(/<mark[^>]*>([\s\S]*?)<\/mark>/gi, '==$1==')
      .replace(/<em[^>]*>([\s\S]*?)<\/em>/gi, '[[$1]]')
      .replace(/<(b|strong)[^>]*>([\s\S]*?)<\/\1>/gi, '**$2**')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, '');
  }
  if (s.indexOf('&') >= 0) s = s.replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (m) => ENT[m]);
  return s;
}
export function rich(parent, text) {
  richInto(parent, plainMarkup(text), 0);
  return parent;
}
function richInto(parent, s, depth) {
  const re = /(==.+?==|\*\*.+?\*\*|\[\[.+?\]\])/g;
  let last = 0;
  let m;
  while ((m = re.exec(s))) {
    if (m.index > last) parent.append(document.createTextNode(s.slice(last, m.index)));
    const tok = m[0];
    const inner = tok.slice(2, -2);
    let node;
    if (tok[0] === '=') node = document.createElement('mark');
    else if (tok[0] === '*') node = document.createElement('strong');
    else { node = document.createElement('em'); node.className = 'kw'; }
    if (depth < 2 && tok[0] !== '[') richInto(node, inner, depth + 1);
    else node.textContent = inner;
    parent.append(node);
    last = m.index + tok.length;
  }
  if (last < s.length) parent.append(document.createTextNode(s.slice(last)));
}
// 記号を外した素の文(検索・要約・コピー用)
export function stripMarkup(text) {
  return plainMarkup(text).replace(/==|\*\*|\[\[|\]\]/g, '');
}

/* ---------- イラスト(配信データのSVG)を安全な形にして描く ----------
   AIが書いたSVGなので、決めた要素と属性だけを通す。script・イベント属性・外部参照は落とす。 */
const SVG_TAGS = new Set(['svg', 'g', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'text', 'tspan',
  'defs', 'lineargradient', 'radialgradient', 'stop', 'clippath', 'mask', 'pattern', 'title', 'desc']);
let svgSeq = 0;
export function svgFragment(src) {
  let s = String(src || '').trim();
  if (!s) return null;
  if (!/^<svg[\s>]/i.test(s)) s = '<svg>' + s + '</svg>';
  const tpl = document.createElement('template'); // template の中は動かない(scriptも読み込みも起きない)
  tpl.innerHTML = s;
  const root = tpl.content.querySelector('svg');
  if (!root) return null;
  const uid = 'a' + (++svgSeq) + '-';
  const ids = [];
  const walk = (node) => {
    for (const ch of Array.from(node.children)) {
      if (!SVG_TAGS.has(ch.localName.toLowerCase())) { ch.remove(); continue; }
      for (const at of Array.from(ch.attributes)) {
        const name = at.name.toLowerCase();
        const val = at.value;
        if (name.slice(0, 2) === 'on' || name === 'href' || name === 'xlink:href' || name === 'src' ||
            /javascript:|data:|@import|expression\(/i.test(val) ||
            (/url\(/i.test(val) && !/^\s*url\(\s*#[\w-]+\s*\)\s*$/i.test(val))) {
          ch.removeAttribute(at.name);
        }
      }
      if (ch.id) { ids.push(ch.id); ch.id = uid + ch.id; }
      walk(ch);
    }
  };
  walk(root);
  if (ids.length) { // 同じ画面に何枚も並ぶので、グラデーションなどのidがぶつからないよう付け替える
    for (const elx of root.querySelectorAll('*')) {
      for (const at of Array.from(elx.attributes)) {
        const mm = /^\s*url\(\s*#([\w-]+)\s*\)\s*$/.exec(at.value);
        if (mm && ids.indexOf(mm[1]) >= 0) elx.setAttribute(at.name, 'url(#' + uid + mm[1] + ')');
      }
    }
  }
  const frag = document.createDocumentFragment();
  for (const ch of Array.from(root.childNodes)) frag.append(ch);
  return { frag, label: root.getAttribute('aria-label') || '' };
}

/* ---------- 検索用: 全角半角・大文字小文字・ひらがなカタカナの違いをならす ---------- */
export function norm(s) {
  return String(s == null ? '' : s).normalize('NFKC').toLowerCase()
    .replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60))
    .replace(/\s+/g, ' ');
}

/* ---------- 思考メモ用: 同じ記事はいつも同じIDになる(二重登録しない) ---------- */
export function stableUuid(seed) {
  let hx = '';
  for (let r = 0; r < 4; r++) {
    let x = 2166136261 ^ r;
    for (let j = 0; j < seed.length; j++) { x ^= seed.charCodeAt(j); x = Math.imul(x, 16777619) >>> 0; }
    hx += ('00000000' + x.toString(16)).slice(-8);
  }
  return hx.slice(0, 8) + '-' + hx.slice(8, 12) + '-4' + hx.slice(13, 16) + '-a' + hx.slice(17, 20) + '-' + hx.slice(20, 32);
}

export function debounce(fn, ms) {
  let t = 0;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}
export function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}
