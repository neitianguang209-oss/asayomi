// 言葉を調べる。ニュースの本文を長押しすると、その言葉のシートが出る。
//  - わかる     : 用語帳(このアプリの用語メモ)にあればその説明。あわせて Wikipedia の冒頭を取ってくる。
//  - 深く調べる : 関連する言葉へ移る／このアプリの記事をさがす／Google・ニュース・Wikipedia・Claude へ飛ぶ。
// 用語メモ・用語帳・検索から開く「用語のシート」もこれ。
import { h, clear, norm, mdDate } from './util.js';
import { APP_URL } from './config.js';
import * as store from './store.js';
import { icon } from './art.js';
import { openSheet } from './ui.js';
import { go } from './nav.js';
import { sendMemo, sendError, linkOf } from './actions.js';

/* =====================================================================
   Wikipedia(日本語版)
   ===================================================================== */
const WIKI = 'https://ja.wikipedia.org/w/api.php?format=json&formatversion=2&origin=*&action=query';
const INTRO = '&prop=extracts%7Cinfo%7Cpageprops&exintro=1&explaintext=1&exlimit=max&inprop=url&ppprop=disambiguation';
const isDisambig = (p) => !!(p.pageprops && 'disambiguation' in p.pageprops); // 「いくつかの意味があります」のページ
const usable = (p) => !!(p && !p.missing && !p.invalid && !isDisambig(p) && p.extract);
const byIndex = (a, b) => a.index - b.index;

async function wikiQuery(query, ms) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms || 9000);
  try {
    const res = await fetch(WIKI + query, { signal: ctl.signal });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return (await res.json()).query || {};
  } finally {
    clearTimeout(timer);
  }
}
const wikiPages = async (query, ms) => (await wikiQuery(query, ms)).pages || [];
// 一度調べた言葉は覚えておく(前の言葉に戻ったときにすぐ出す)。失敗は覚えない。
function cached(map, key, load) {
  if (!map.has(key)) {
    const p = load();
    p.catch(() => map.delete(key));
    map.set(key, p);
  }
  return map.get(key);
}
const lookups = new Map();
const relateds = new Map();

// その名前そのままのページ(別名からの転送も含む)を、いくつかまとめて1回の通信で確かめる。無ければ null。
const exacts = new Map();
const titleOf = (t) => String(t).normalize('NFKC').replace(/[|[\]{}<>#_]/g, ' ').replace(/\s+/g, ' ').trim();
async function exactPages(terms) {
  const keys = terms.map(titleOf);
  const need = Array.from(new Set(keys.filter((k) => k && !exacts.has(k)))).slice(0, 20);
  if (need.length) {
    const q = await wikiQuery('&redirects=1&titles=' + encodeURIComponent(need.join('|')) + INTRO);
    const table = (list) => new Map((list || []).map((x) => [x.from, x.to]));
    const renamed = table(q.normalized);
    const moved = table(q.redirects);
    const byTitle = new Map((q.pages || []).map((p) => [p.title, p]));
    for (const k of need) {
      const t = renamed.get(k) || k;
      exacts.set(k, byTitle.get(moved.get(t) || t) || null);
    }
  }
  return keys.map((k) => exacts.get(k) || null);
}
// 言葉 → { page, exact, others }。同じ名前のページが無ければ、検索でいちばん近いページ(others はほかの候補)。
function wikiLookup(term) {
  return cached(lookups, norm(term), async () => {
    const exact = (await exactPages([term]))[0];
    if (usable(exact)) return { page: exact, exact: true, others: [] };
    // まずページの名前に含むもの(「ウォーシュ」→「ケビン・ウォーシュ」)。無ければ本文もふくめて探す
    const t = titleOf(term).replace(/"/g, ' ');
    const search = async (words) => (await wikiPages('&generator=search&gsrnamespace=0&gsrlimit=6&gsrsearch=' + encodeURIComponent(words) + INTRO))
      .filter(usable).sort(byIndex);
    const found = await search('intitle:"' + t + '"');
    if (found.length < 4) for (const p of await search(t)) if (!found.some((x) => x.title === p.title)) found.push(p);
    return { page: found[0] || null, exact: false, others: found.slice(1, 7).map((p) => p.title) };
  });
}
// そのページと内容の近いページの名前
function wikiRelated(title) {
  return cached(relateds, title, async () => {
    const found = await wikiPages('&generator=search&gsrnamespace=0&gsrlimit=9&gsrsearch=' + encodeURIComponent('morelike:' + title) +
      '&prop=pageprops&ppprop=disambiguation', 15000); // 大きなページは時間がかかる
    return found.filter((p) => !isDisambig(p) && !/^\d+(年|年代|世紀|月\d+日)$/.test(p.title)).sort(byIndex).map((p) => p.title); // 「2008年」のような年のページは外す
  });
}
// 長押しで読み取った言葉を、Wikipedia にページがある形に寄せる。
// 「トランプ大統領」の「トランプ」を押したら「トランプ大統領」、「中央銀行総裁」なら「中央銀行」。
// 押した所を含む言葉(cands)のうち、ページがあるいちばん長いものを返す。いまの言葉(main)のままでよければ null。
// found はページのあった言葉(長い順)。「区切りを変える」の候補に足す。
async function settlePick(main, cands) {
  try {
    const pages = await exactPages(cands.map((c) => c.term));
    const found = cands.filter((c, i) => usable(pages[i])).sort((a, b) => b.term.length - a.term.length);
    const best = found[0];
    // 短くなりすぎるとき(「東京市場」→「東京」)は寄せない。検索で近いページを出す方がよい
    return { best: best && best.term !== main && best.term.length >= main.length * 0.6 ? best : null, found };
  } catch (e) { /* 通信できなければ、読み取ったままで調べる */ }
  return null;
}
// 冒頭の2〜3文だけにする。かっこの中の「アラビア語: …」のような外国語の表記は読みにくいので外す(読みがなと英語は残す)
const FOREIGN = /^\s*(?!英)(?:[^:：]{0,10}(?:語|翻字|文字|発音)|[独仏露中韓朝泰伊西葡蘭羅希越印土亜]|IPA)\s*[:：]/;
function brief(text) {
  const s = String(text || '').replace(/\s*\n+\s*/g, ' ').trim()
    .replace(/\s*（([^（）]*)）/g, (m, inner) => {
      const keep = inner.split('、').filter((x) => !FOREIGN.test(x));
      return keep.length ? '（' + keep.join('、') + '）' : '';
    });
  let out = '';
  for (const part of s.match(/[^。]+。?/g) || []) {
    if (out && out.length + part.length > 230) break;
    out += part;
    if (out.length >= 120) break;
  }
  return out.length > 260 ? out.slice(0, 258) + '…' : out;
}

/* =====================================================================
   言葉のシート
   ===================================================================== */
function ext(label, url) {
  return h('a', { href: url, target: '_blank', rel: 'noopener noreferrer' }, h('span', null, label), icon('out', 15));
}
function askPrompt(term, it) {
  return '「' + term + '」について、初めて聞く人にもわかるように教えてください。' +
    (it ? '「' + it.data.title + '」というニュース（' + it.date + '）に出てきた言葉です。' : '') +
    '①ひとことで言うと ②しくみ・背景 ③' + (it ? 'このニュースとの関係' : 'ニュースでよく出る場面') +
    ' ④あわせて知っておくとよい言葉、の順でお願いします。';
}
// このアプリの記事のうち、その言葉が出てくるもの(新しい順)
function appHits(term, cur) {
  const k = norm(term).trim();
  if (!k) return [];
  const out = [];
  for (const x of store.searchIndex()) {
    if (x.it && x.it !== cur && (x.head.indexOf(k) >= 0 || x.rest.indexOf(k) >= 0)) out.push(x.it);
  }
  return out.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.n - b.n));
}

// ctx.it   : いま読んでいる記事(長押し・用語メモから開いたとき)
// ctx.picks: 長押しした所から読み取った言葉の候補 [{ term, range }]。先頭が name。
// ctx.cands: 押した所を含む言葉をもっと細かく並べたもの。Wikipedia にある形へ寄せるのに使う。
export function openTermSheet(name, ctx) {
  const o = ctx || {};
  const picks = o.picks && o.picks.length ? o.picks : [{ term: name }];
  const trail = []; // 関連する言葉をたどってきた道(前の言葉に戻れる)
  let seq = 0;
  openSheet((sheet, close) => {
    const body = h('div', { class: 'lk' });
    sheet.append(body);

    function show(term, settle) {
      const my = ++seq;
      const hop = (next) => { trail.push(term); show(next); };
      const pk = picks.find((p) => p.term === term);
      mark(pk && pk.range);
      clear(body);
      sheet.scrollTop = 0;
      const e = store.terms().get(norm(term)); // 用語帳にある言葉
      let page = null; // Wikipedia で見つけたページ(届いたら入る)

      // 言葉(区切りが違ったら、直して調べ直せる)
      const input = h('input', { type: 'text', value: term, 'aria-label': '調べる言葉', enterkeyhint: 'search',
        autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', maxlength: '60' });
      const again = h('button', { type: 'submit', hidden: true }, '調べる');
      const typed = () => input.value.trim().replace(/\s+/g, ' ');
      input.addEventListener('input', () => { again.hidden = !typed() || typed() === term; });
      body.append(h('form', { class: 'lk-in', onsubmit: (ev) => { ev.preventDefault(); if (typed() && typed() !== term) hop(typed()); } },
        icon('search', 18), input, again));

      const alt = h('div', { class: 'lk-alt' });
      if (trail.length) {
        alt.append(h('button', { class: 'chip', type: 'button', onclick: () => show(trail.pop()) }, '‹ ' + trail[trail.length - 1]));
      } else if (pk && picks.length > 1) {
        alt.append(h('small', null, '区切りを変える'), ...picks.map((p) =>
          h('button', { class: 'chip' + (p === pk ? ' on' : ''), type: 'button', onclick: () => { if (p !== pk) show(p.term); } }, p.term)));
      }
      if (alt.firstChild) body.append(alt);

      if (e) {
        body.append(h('div', { class: 'lk-card' },
          h('div', { class: 'lk-src' }, 'あさよみの用語メモ', h('small', null, e.uses.length + '回 · 最後 ' + mdDate(e.last))),
          h('p', null, e.desc)));
      }
      const wk = h('div', { class: 'lk-card wk wait' }, h('div', { class: 'lk-src' }, 'Wikipedia'), h('p', { class: 'lk-wait' }, '調べています…'));
      const rel = h('div', { class: 'lk-rel', hidden: true });
      body.append(wk, rel);

      const q = encodeURIComponent(term);
      const wikiA = ext('Wikipedia', 'https://ja.wikipedia.org/w/index.php?search=' + q);
      body.append(h('div', { class: 'sr-h' }, h('span', null, 'Webでもっと調べる')),
        h('div', { class: 'lk-web' },
          ext('Google', 'https://www.google.com/search?q=' + q),
          ext('最新ニュース', 'https://news.google.com/search?q=' + q + '&hl=ja&gl=JP&ceid=JP%3Aja'),
          wikiA,
          ext('Claudeに聞く', 'https://claude.ai/new?q=' + encodeURIComponent(askPrompt(term, o.it)))));

      if (e) {
        const cid = store.cardIdTerm(e.term);
        const rev = h('button', { class: 'sbtn', type: 'button' });
        const paintRev = () => {
          const c = store.st.get(cid);
          rev.className = 'sbtn' + (c ? ' done' : '');
          rev.replaceChildren(icon(c ? 'check' : 'cards', 20),
            h('span', null, c ? '復習に入っています' : '復習に入れる',
              h('small', null, c ? '次は ' + mdDate(c.due) + '。押すと外します' : 'あしたから、忘れかけた頃にクイズで出します')));
        };
        paintRev();
        rev.addEventListener('click', () => {
          if (store.st.has(cid)) store.removeCard(cid); else store.addCard(cid);
          paintRev();
        });
        body.append(rev);
      }

      const sid = 'sent:w:' + norm(term);
      const memo = h('button', { class: 'sbtn', type: 'button' });
      const paintMemo = (msg) => {
        const done = store.st.has(sid);
        memo.className = 'sbtn' + (done ? ' done' : '');
        memo.disabled = done;
        memo.replaceChildren(icon(done ? 'check' : 'memo', 20),
          h('span', null, done ? '思考メモに保存済み' : '思考メモに送る',
            h('small', null, msg || (e ? '用語と説明を「知識」タグで保存します' : '言葉と Wikipedia の説明を「知識」タグで保存します'))));
      };
      paintMemo();
      memo.addEventListener('click', async () => {
        memo.disabled = true;
        let seed;
        let text;
        if (e) {
          const first = e.uses[0];
          seed = 'term-' + e.key;
          text = e.term + '：' + e.desc + '\n\n詳しく：' + (first ? APP_URL + '#/news/' + first.date + '/' + first.n : APP_URL);
        } else {
          seed = 'lookup-' + norm(term);
          text = page ? term + '：' + brief(page.extract) + '（Wikipedia）\n\n詳しく：' + wikiA.href : term + '（あとで調べる言葉）';
          if (o.it) text += '\n出てきた記事：' + linkOf(o.it);
        }
        try {
          await sendMemo(seed, text);
          store.st.set(sid, { at: new Date().toISOString() });
          paintMemo();
        } catch (err) {
          memo.disabled = false;
          paintMemo(sendError(err));
        }
      });
      body.append(memo);

      const hits = appHits(term, o.it);
      if (hits.length) {
        const uses = h('ul', { class: 'uses' });
        for (const it of hits.slice(0, 4)) {
          uses.append(h('li', null, h('button', { type: 'button', onclick: () => { close(); go('#/' + it.kind + '/' + it.date + '/' + it.n); } },
            h('small', null, mdDate(it.date) + (it.kind === 'news' ? ' のニュース' : ' の雑学')), it.data.title)));
        }
        body.append(h('div', { class: 'sr-h' }, h('span', null, 'この言葉が出てくる記事'), h('span', null, hits.length + '件')), uses);
        if (hits.length > 4) {
          body.append(h('button', { class: 'bigbtn sub', type: 'button', onclick: () => { close(); go('#/search/all/-/' + q); } }, 'あさよみの中をさがす'));
        }
      }

      // Wikipedia の説明は、届いたら差し込む
      const head = (note) => h('div', { class: 'lk-src' }, 'Wikipedia', note ? h('small', null, note) : null);
      (settle || Promise.resolve(null)).then((s) => {
        if (my !== seq) return null;
        if (s) {
          const had = picks.length;
          if (s.best && !picks.some((p) => p.term === s.best.term)) picks.unshift(s.best);
          for (const c of s.found) if (picks.length < 4 && !picks.some((p) => p.term === c.term)) picks.push(c);
          if (s.best || picks.length !== had) { // もっと合う言葉・ほかの区切りが見つかった: 出し直す
            show(s.best ? s.best.term : term);
            return null;
          }
        }
        return wikiLookup(term);
      }).then((r) => {
        if (!r || my !== seq) return;
        clear(wk);
        wk.classList.remove('wait');
        if (!r.page) {
          wk.append(head(), h('p', { class: 'lk-wait' }, 'Wikipedia には見つかりませんでした。言葉を短くして調べ直すか、下のリンクからどうぞ。'));
          return;
        }
        page = r.page;
        if (/^https:\/\/ja\.wikipedia\.org\//.test(page.fullurl || '')) wikiA.href = page.fullurl;
        wk.append(head(r.exact ? '' : 'いちばん近いページ'));
        if (norm(page.title) !== norm(term)) wk.append(h('b', null, page.title));
        wk.append(h('p', null, brief(page.extract)),
          h('a', { class: 'lk-more', href: wikiA.href, target: '_blank', rel: 'noopener noreferrer' }, '続きを Wikipedia で読む', icon('out', 14)));
        // 関連する言葉は遅れて届くことがある。先に場所を取っておき、下のリンクが急に動かないようにする
        const chips = (label, titles) => {
          if (my !== seq) return;
          const list = titles.filter((t) => norm(t) !== norm(term)).slice(0, 6);
          rel.classList.remove('wait');
          rel.hidden = !list.length;
          rel.replaceChildren(h('small', null, label), ...list.map((t) => h('button', { class: 'chip', type: 'button', onclick: () => hop(t) }, t)));
        };
        if (r.others.length) {
          chips('ほかの候補', r.others);
        } else {
          rel.hidden = false;
          rel.classList.add('wait');
          rel.append(h('small', null, '関連する言葉'));
          wikiRelated(page.title).then((ts) => chips('関連する言葉', ts), () => chips('', []));
        }
      }, () => {
        if (my !== seq) return;
        clear(wk);
        wk.classList.remove('wait');
        wk.append(head(),
          h('p', { class: 'lk-wait' }, navigator.onLine === false ? '圏外のようです。つながると Wikipedia の説明が出ます。' : 'Wikipedia の説明を取ってこられませんでした。'),
          h('button', { class: 'lk-more', type: 'button', onclick: () => show(term) }, 'もう一度ためす'));
      });
    }
    // 用語帳にある言葉はそのまま。それ以外は、Wikipedia にある形へ寄せてから説明を取る
    const loose = o.cands && o.cands.length > 1 && !store.terms().has(norm(name));
    show(name, loose ? settlePick(name, o.cands) : null);
  }, () => mark(null));
}

/* =====================================================================
   長押しした所の言葉を読み取る
   ===================================================================== */
// 読み取った言葉に、本文の上で色をつける(対応していないブラウザでは何もしない)
function mark(range) {
  try {
    if (!window.Highlight || !window.CSS || !CSS.highlights) return;
    if (range) CSS.highlights.set('lookup', new Highlight(range));
    else CSS.highlights.delete('lookup');
  } catch (e) { /* 色がつかないだけ */ }
}

function inRects(rects, x, y, pad) {
  for (const q of rects) if (x >= q.left - 1 && x <= q.right + 1 && y >= q.top - pad && y <= q.bottom + pad) return true;
  return false;
}
// 段落のどの文字を押したか。文字ごとの位置を測って探す(文字選択を止めた本文でも使える)。
function charAt(block, x, y) {
  const nodes = [];
  let text = '';
  const tw = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  for (let n = tw.nextNode(); n; n = tw.nextNode()) { nodes.push([n, text.length]); text += n.data; }
  const r = document.createRange();
  for (const pad of [0, 7]) { // まずぴったり。行と行のすき間を押していたら、少し広げてもう一度
    for (const [node, base] of nodes) {
      r.selectNodeContents(node);
      if (!inRects(r.getClientRects(), x, y, pad)) continue;
      for (let i = 0; i < node.data.length; i++) {
        r.setStart(node, i);
        r.setEnd(node, i + 1);
        if (inRects(r.getClientRects(), x, y, pad)) return { text, i: base + i, nodes };
      }
    }
  }
  return null;
}
function rangeOf(nodes, a, b) {
  const r = document.createRange();
  let set = 0;
  for (const [node, base] of nodes) {
    const end = base + node.data.length;
    if (!(set & 1) && a >= base && a < end) { r.setStart(node, a - base); set |= 1; }
    if (!(set & 2) && b > base && b <= end) { r.setEnd(node, b - base); set |= 2; }
  }
  return set === 3 ? r : null;
}

// 文字の種類: K=漢字 T=カタカナ L=英数字 H=ひらがな
function cls(c) {
  if (!c) return '';
  if (/[㐀-䶿一-鿿豈-﫿々〆]/.test(c)) return 'K';
  if (/[ァ-ヺーｦ-ﾟ]/.test(c)) return 'T';
  if (/[A-Za-z0-9０-９Ａ-Ｚａ-ｚ]/.test(c)) return 'L';
  if (/[ぁ-ゖ]/.test(c)) return 'H';
  return '';
}
// i の文字から左右に伸ばした範囲。wide=false は同じ種類だけ(「大統領」)、true は漢字・カタカナ・英数字をまたぐ(「トランプ大統領」)。
// 「キング・ハーリド」「S&P500」のつなぎの記号は、両側が同じ種類なら中に入れる。
function run(s, i, wide) {
  const c = cls(s[i]);
  const ok = (j) => {
    const x = cls(s[j]);
    if (wide ? x === 'K' || x === 'T' || x === 'L' : x === c) return true;
    const mid = (cc) => (wide || c === cc) && cls(s[j - 1]) === cc && cls(s[j + 1]) === cc;
    return ((s[j] === '・' || s[j] === '＝') && mid('T')) || (/[.\-&+]/.test(s[j]) && mid('L'));
  };
  let a = i;
  let b = i + 1;
  while (a > 0 && ok(a - 1)) a--;
  while (b < s.length && ok(b)) b++;
  return [a, b];
}
let segmenter = null;
function segments(s) {
  try {
    if (segmenter === null) segmenter = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter('ja', { granularity: 'word' }) : false;
    if (segmenter) return Array.from(segmenter.segment(s));
  } catch (e) { /* 使えなければ文字の種類だけで決める */ }
  return [];
}

// 押した文字 i にかかる言葉の候補を、範囲 [開始, 終了] の並びで返す。
//  spans: 画面に出す候補(先頭がいちばんの候補)
//  subs : 押した単語とその前後をつないだ形(「中央」「中央銀行」「中央銀行総裁」)。Wikipedia にある形へ寄せるのに使う
function pick(text, i, known) {
  const spans = [];
  const subs = [];
  const push = (list, r) => {
    if (!r) return;
    const t = text.slice(r[0], r[1]);
    if (t.length > 30 || /^[\d０-９.,]*$/.test(t) || list.some((x) => x[0] === r[0] && x[1] === r[1])) return; // 数字だけは調べない
    list.push(r);
  };
  const add = (r) => push(spans, r);
  // 用語メモ・用語帳にある言葉がかかっていれば、それを先頭に(長い方)
  let best = null;
  for (const name of known) {
    for (let at = text.indexOf(name); at >= 0; at = text.indexOf(name, at + 1)) {
      if (at <= i && i < at + name.length && (!best || name.length > best[1] - best[0])) best = [at, at + name.length];
    }
  }
  add(best);
  const c = cls(text[i]);
  if (c) {
    const segs = segments(text);
    const k = segs.findIndex((x) => x.index <= i && i < x.index + x.segment.length);
    const w = k >= 0 && segs[k].isWordLike ? [segs[k].index, segs[k].index + segs[k].segment.length] : null;
    const r = c === 'H' ? null : run(text, i, false);
    // 同じ種類の文字の並びと単語の切れ目の、広い方をとる(「消費者物価指数」も「値下がり」も拾える)
    const main = r && w ? [Math.min(r[0], w[0]), Math.max(r[1], w[1])] : r || w;
    const digits = main && /^[\d０-９.,]*$/.test(text.slice(main[0], main[1])); // 「2926円」の数字のところ
    if (main && !digits && (c !== 'H' || main[1] - main[0] >= 2)) { // 数字と、ひらがな1文字(助詞)は調べない
      add(main);
      const nx = segs[k + 1];
      if (main[1] - main[0] === 1 && nx && nx.index === main[1] && nx.isWordLike && /[一-鿿]/.test(nx.segment)) {
        add([main[0], nx.index + nx.segment.length]); // 1文字だけになったら、次の単語とつないだ形も(「利」＋「上げ」)
      }
      if (c !== 'H') {
        const wide = run(text, i, true);
        add(wide);
        add(r);
        // 広い範囲を単語で区切り、押した単語から左に2つ・右に3つまでつないだ形を並べる
        const cuts = [wide[0], wide[1]];
        for (const x of segs) {
          for (const p of [x.index, x.index + x.segment.length]) if (p > wide[0] && p < wide[1] && cuts.indexOf(p) < 0) cuts.push(p);
        }
        cuts.sort((x, y) => x - y);
        const at = cuts.findIndex((p) => p > i) - 1;
        for (let a = Math.max(0, at - 2); a <= at; a++) {
          for (let b = at + 1; b <= Math.min(cuts.length - 1, at + 4); b++) push(subs, [cuts[a], cuts[b]]);
        }
      }
    }
  }
  const shown = spans.slice(0, 4);
  for (const r of shown) push(subs, r);
  return { spans: shown, subs: subs.slice(0, 18) };
}

const HOLD = 450; // 長押しとみなすまで(ミリ秒)
const SLOP = 9;   // これ以上指が動いたらスクロールとみなす(px)
const BLOCKS = 'h1, h2, p.lede, p.b, .life p';

// 記事の本文に「長押しで調べる」をつける。青い言葉(用語)はタップでも開く。
export function attachLookup(root, it) {
  let timer = 0;
  let sx = 0;
  let sy = 0;
  let block = null;
  let kw = null;
  let viaTouch = false;
  let held = false; // 長押しでシートを出した直後(指を離したときのタップを数えない)
  const stop = () => { clearTimeout(timer); timer = 0; };
  const known = () => {
    const out = new Set();
    for (const t of it.data.terms || []) if (Array.isArray(t) && t[0]) out.add(t[0]);
    for (const e of store.terms().values()) out.add(e.term);
    if (kw) out.add(kw.textContent);
    return out;
  };
  const fire = () => {
    stop();
    const hit = charAt(block, sx, sy);
    if (!hit) return;
    const found = pick(hit.text, hit.i, known());
    const named = ([a, b]) => ({ term: hit.text.slice(a, b), range: rangeOf(hit.nodes, a, b) });
    const picks = found.spans.map(named);
    if (!picks.length) return;
    held = true;
    try { if (navigator.vibrate) navigator.vibrate(8); } catch (e) { /* 震えなくてもよい */ }
    const sel = window.getSelection && window.getSelection();
    if (sel) sel.removeAllRanges();
    if (!viaTouch) { // マウスを押したまま動かしても、本文やシートの文字が選択されないようにする(離すまで)
      const body = document.body;
      const free = () => { body.classList.remove('lk-hold'); window.removeEventListener('pointerup', free, true); window.removeEventListener('pointercancel', free, true); };
      body.classList.add('lk-hold');
      window.addEventListener('pointerup', free, true);
      window.addEventListener('pointercancel', free, true);
    }
    openTermSheet(picks[0].term, { it, picks, cands: found.subs.map(named) });
  };
  root.addEventListener('pointerdown', (e) => {
    stop();
    held = false;
    if (!e.isPrimary || (e.pointerType === 'mouse' && e.button !== 0)) return;
    const t = e.target;
    block = t.closest && !t.closest('button, a') ? t.closest(BLOCKS) : null;
    if (!block || !root.contains(block)) return;
    kw = t.closest('em.kw');
    sx = e.clientX;
    sy = e.clientY;
    viaTouch = e.pointerType !== 'mouse';
    timer = setTimeout(fire, HOLD);
  });
  root.addEventListener('pointermove', (e) => { if (timer && Math.hypot(e.clientX - sx, e.clientY - sy) > SLOP) stop(); });
  for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) root.addEventListener(ev, stop);
  // Android は長押しで「OSのメニューを出す合図」が先に来ることがある。メニューは出さず、それも調べる合図に使う
  root.addEventListener('contextmenu', (e) => {
    if (!viaTouch || !(timer || held)) return;
    e.preventDefault();
    if (timer) fire();
  });
  root.addEventListener('click', (e) => {
    if (held) { held = false; return; }
    const k = e.target.closest && e.target.closest('em.kw');
    if (!k || !root.contains(k) || k.closest('button, a')) return;
    const range = document.createRange();
    range.selectNodeContents(k);
    openTermSheet(k.textContent, { it, picks: [{ term: k.textContent, range }] });
  });
}
