// 復習: 読んだ雑学と「覚える」にした用語を、忘れかけた頃(1日→2日→5日→12日→30日→90日)に出し直す。
// クイズ付きの雑学と用語は3択、それ以外は「思い出す→答えを見る→自己採点」。
import { h, clear, shuffle, mdDate, addDays, todayJST } from './util.js';
import { GENRES, INTERVALS, MASTERED } from './config.js';
import * as store from './store.js';
import { icon, colorOf } from './art.js';
import { go, back } from './nav.js';
import { xButton, toast } from './ui.js';

let session = null; // { queue, idx, right, answered, random }

function targetsFromDue() {
  const size = store.pref().quizSize || 10;
  return store.dueCards().slice(0, size).map((x) => ({ id: x.id, target: store.cardTarget(x.id) }));
}
function targetsRandom(n) {
  const pool = store.allItems('trivia');
  return shuffle(pool).slice(0, n).map((it) => ({ id: store.cardIdOf(it), target: { type: 't', it } }));
}
function start(random) {
  const queue = random ? targetsRandom(5) : targetsFromDue();
  session = { queue, idx: 0, right: 0, answered: 0, random: !!random, done: false, day: todayJST() };
}

function question(target) {
  if (target.type === 't') {
    const d = target.it.data;
    const qz = d.quiz;
    if (qz && qz.q && Array.isArray(qz.choices) && qz.choices.length >= 2 && qz.choices[qz.answer] != null) {
      return { mode: 'choice', q: qz.q, choices: shuffle(qz.choices.map((t, i) => ({ t, ok: i === qz.answer }))), why: qz.why };
    }
    if (d.keyword) return { mode: 'recall', kw: d.keyword, sub: 'この言葉の雑学、どんな話だった？' };
    return { mode: 'recall', q: d.title, sub: 'この話のポイント、人に説明できる？' };
  }
  const e = target.term;
  const others = shuffle(Array.from(store.terms().values()).filter((x) => x.key !== e.key)).slice(0, 2);
  if (others.length === 2) {
    return { mode: 'choice', q: '「' + e.term + '」の意味は？', choices: shuffle([{ t: e.desc, ok: true }].concat(others.map((x) => ({ t: x.desc, ok: false })))) };
  }
  return { mode: 'recall', kw: e.term, sub: 'この用語の意味、説明できる？' };
}

function nextLabel(box) {
  const d = INTERVALS[Math.min(box, INTERVALS.length - 1)];
  return d === 1 ? 'あした' : d + '日後';
}

export function reviewPage() {
  // 「記事を読み直す」で記事へ行って戻ってきたときだけ途中から続ける。それ以外は、いま出すべき問題で始め直す
  if (!session || !session.resume || session.done || session.day !== todayJST()) start(false);
  session.resume = false;
  const root = h('div', { class: 'page' });
  const wrap = h('div', { class: 'wrap' });
  root.append(wrap);
  const paint = () => {
    clear(wrap);
    if (!session.queue.length) emptyView(wrap, paint);
    else if (session.idx >= session.queue.length) endView(wrap, paint);
    else cardView(wrap, paint);
    root.scrollTop = 0;
  };
  paint();
  return root;
}

function topBar(wrap, title) {
  const s = session;
  let mid;
  if (title) mid = h('h1', null, title);
  else {
    const pct = Math.round((s.idx / s.queue.length) * 100);
    mid = h('div', { class: 'rv-prog' }, h('i', null, h('b', { style: { width: pct + '%' } })), (s.idx + 1) + ' / ' + s.queue.length);
  }
  wrap.append(h('div', { class: 'pbar' }, mid, xButton(() => back('#/'))));
}

function cardView(wrap, paint) {
  const s = session;
  const cur = s.queue[s.idx];
  if (cur.settled) { s.idx++; paint(); return; } // 答えたあと記事へ行って戻ってきた
  const tg = cur.target;
  const card = store.st.get(cur.id);
  const q = cur.q || (cur.q = question(tg));
  topBar(wrap);

  const kind = h('div', { class: 'rv-kind' });
  if (tg.type === 't') {
    const d = tg.it.data;
    kind.append(h('span', { class: 'lab', style: { '--c': colorOf(tg.it) } }, h('i'), d.genreLabel || (GENRES[d.genre] || {}).label || '雑学'),
      h('span', null, mdDate(tg.it.date) + ' の雑学'));
  } else {
    kind.append(h('span', { class: 'lab', style: { '--c': 'var(--link)' } }, h('i'), 'ニュースの用語'));
  }
  if (card && !s.random) {
    const lv = h('span', { class: 'lv', title: '定着の段階' });
    for (let i = 0; i < MASTERED; i++) lv.append(h('i', { class: i < (card.box || 0) ? 'on' : '' }));
    kind.append(lv);
  }
  const box = h('div', { class: 'rv-card' }, kind);
  const qEl = h('h2', { class: 'rv-q' });
  if (q.kw) qEl.append(h('span', { class: 'kw' }, q.kw)); else qEl.append(q.q);
  box.append(qEl);
  if (q.sub) box.append(h('p', { class: 'rv-sub' }, q.sub));
  const body = h('div');
  const foot = h('div', { class: 'rv-foot' });
  box.append(body);
  wrap.append(box, foot);

  const advance = () => { s.idx++; paint(); };
  // 採点して次へ。まちがえた問題は、その回の最後にもう一度だけ出す。
  const settle = (result) => {
    cur.settled = true;
    s.answered++;
    if (result === 'ok') s.right++;
    if (!cur.retry) {
      if (s.random) {
        store.touchQuiz();
        if (result !== 'ok' && store.addCard(cur.id)) toast('復習に入れました（あした出ます）');
      } else {
        store.grade(cur.id, result);
      }
      if (result === 'ng') s.queue.push({ id: cur.id, target: tg, retry: true });
    }
  };

  const answer = (ok) => {
    const a = h('div', { class: 'rv-ans' });
    if (ok != null) a.append(h('p', { class: 'rv-res ' + (ok ? 'ok' : 'ng') }, ok ? '○ 正解！' : '× おしい…'));
    if (tg.type === 't') {
      const d = tg.it.data;
      if (q.kw || q.mode === 'choice') a.append(h('p', { class: 'why', style: { margin: '0 0 8px', 'font-weight': '700', color: 'var(--ink)' } }, d.title));
      if (d.gist) a.append(h('div', { class: 'gist' }, h('span', null, d.legacy ? 'この話のメモ' : 'ひとことで言うと'), h('p', null, d.gist)));
      if (q.why) a.append(h('p', { class: 'why' }, q.why));
      if (d.talk) a.append(h('div', { class: 'talkline' }, h('span', null, '会話で使える一言'), d.talk));
      else if (d.extra && d.extra.text) a.append(h('div', { class: 'talkline' }, h('span', null, d.extra.label || 'ひとこと'), d.extra.text));
      a.append(h('button', { class: 'reread', type: 'button', onclick: () => { s.resume = true; go('#/trivia/' + tg.it.date + '/' + tg.it.n); } }, '記事を読み直す ›'));
    } else {
      const e = tg.term;
      a.append(h('div', { class: 'gist' }, h('span', null, e.term), h('p', null, e.desc)));
      const u = e.uses[0];
      if (u) a.append(h('button', { class: 'reread', type: 'button', onclick: () => { s.resume = true; go('#/news/' + u.date + '/' + u.n); } }, 'この言葉が出てきた記事 ›'));
    }
    return a;
  };

  if (q.mode === 'choice') {
    const list = h('div', { class: 'rv-choices' });
    const btns = q.choices.map((c, i) => {
      const b = h('button', { class: 'rv-choice', type: 'button' }, h('span', { class: 'mk' }, 'ABC'[i] || '・'), h('span', null, c.t));
      b.addEventListener('click', () => {
        btns.forEach((x, k) => {
          x.disabled = true;
          if (q.choices[k].ok) x.classList.add('ok');
          else if (x === b) x.classList.add('ng');
          else x.classList.add('dim');
        });
        settle(c.ok ? 'ok' : 'ng');
        body.append(answer(c.ok));
        foot.append(h('button', { class: 'b-next', type: 'button', onclick: advance }, s.idx + 1 < s.queue.length ? '次へ' : '結果を見る'));
        foot.firstChild.focus();
      });
      return b;
    });
    list.append(...btns);
    body.append(list);
  } else {
    const reveal = h('button', { class: 'rv-reveal', type: 'button' }, '頭の中で思い出してから… 答えを見る');
    reveal.addEventListener('click', () => {
      reveal.remove();
      body.append(answer(null));
      const b = (cls, label, small, result) => h('button', { class: cls, type: 'button', onclick: () => { settle(result); advance(); } }, label, h('small', null, small));
      const cb = (card && card.box) || 0;
      foot.append(
        b('b-ng', '忘れてた', s.random ? '復習に入れる' : 'あした もう一度', 'ng'),
        b('b-mid', 'うろ覚え', s.random ? '復習に入れる' : 'あした もう一度', 'mid'),
        b('b-ok', '覚えてた', s.random || cur.retry ? 'OK' : '次は ' + nextLabel(cb + 1), 'ok'));
    });
    body.append(reveal);
  }
}

function statTiles() {
  const cs = store.cardStats();
  const t = (num, unit, label) => h('div', { class: 'stat' }, h('b', null, String(num), h('small', null, unit)), h('span', null, label));
  return h('div', { class: 'stats' }, t(store.streak(), '日', '続けて開いた'), t(cs.mastered, '個', '覚えた'), t(cs.learning, '個', '復習中'));
}

function endView(wrap, paint) {
  const s = session;
  s.done = true;
  topBar(wrap, '復習');
  const left = store.dueCards().length;
  wrap.append(h('div', { class: 'rv-end' },
    h('div', { class: 'big' }, icon('check', 40)),
    h('h2', null, s.random ? 'おつかれさま！' : left ? 'ひと区切り！' : '今日の復習、おわり'),
    h('p', null, s.answered ? s.answered + '問中 ' + s.right + '問を覚えていました。' : '')),
    statTiles());
  if (left) wrap.append(h('button', { class: 'bigbtn', type: 'button', onclick: () => { start(false); paint(); } }, '続きをやる（あと ' + left + ' 問）'));
  wrap.append(h('button', { class: 'bigbtn sub', type: 'button', onclick: () => { start(true); paint(); } }, 'これまでの雑学から、ランダムに5問'));
  wrap.append(h('button', { class: 'bigbtn sub', type: 'button', onclick: () => back('#/') }, 'とじる'));
}

function emptyView(wrap, paint) {
  topBar(wrap, '復習');
  const total = store.st.count('card:');
  let next = null;
  store.st.each('card:', (id, c) => { if (c && c.due && (!next || c.due < next)) next = c.due; });
  const msg = total
    ? '今日出す問題はありません。' + (next ? '次は ' + mdDate(next) + (next === addDays(todayJST(), 1) ? '（あした）' : '') + ' に出ます。' : '')
    : '雑学の記事を開くと、次の日から自動でここに出てきます。ニュースの用語は「覚える」を押したものだけ入ります。';
  wrap.append(h('div', { class: 'rv-end' },
    h('div', { class: 'big' }, icon('cards', 38)),
    h('h2', null, total ? '今日はぜんぶ済み' : 'まだ復習はありません'),
    h('p', null, msg)),
    statTiles());
  if (store.allItems('trivia').length >= 5) {
    wrap.append(h('button', { class: 'bigbtn', type: 'button', onclick: () => { start(true); paint(); } }, 'これまでの雑学から、ランダムに5問'));
  }
  wrap.append(h('button', { class: 'bigbtn sub', type: 'button', onclick: () => back('#/') }, 'とじる'));
}
