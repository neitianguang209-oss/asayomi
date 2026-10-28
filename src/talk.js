// Claude と話して聞く: Claude アプリ(音声モード)に話し相手になってもらう。
//  - ニュースだけ・雑学だけ・「ニュース→雑学」「雑学→ニュース」の続けて、を選べる。
//  - 記事の本文ごとコピーするので、Claude が URL を読めなくても貼るだけで話せる。
//    「Claudeを開く」は短い頼む文＋記事を返す URL(関数 asayomi-voice の GET)を渡す。
import { h } from './util.js';
import { SB_URL, CATS, GENRES } from './config.js';
import { stripMarkup } from './util.js';
import * as store from './store.js';
import { icon } from './art.js';
import { openSheet, toast } from './ui.js';
import { pauseListening } from './listen.js';

const FN = SB_URL + '/functions/v1/asayomi-voice';
const NAME = { news: 'ニュース', trivia: '雑学' };
const other = (k) => (k === 'news' ? 'trivia' : 'news');
const md = (date) => Number(date.slice(5, 7)) + '月' + Number(date.slice(8, 10)) + '日';
const plain = (s) => stripMarkup(s || '').trim();
const paras = (p) => (Array.isArray(p) ? p : [p]).filter(Boolean).map(plain).join('');

function newsText(it) {
  const d = it.data;
  const out = ['■ ニュース' + it.n + '本目 [' + (d.catn || (CATS[d.cat] || {}).label || '') + '] ' + plain(d.title)];
  if (d.lede) out.push(plain(d.lede));
  for (const s of d.secs || d.sections || []) {
    if (Array.isArray(s)) out.push('【' + plain(s[0]) + '】' + plain(s[1]));
    else if (s) out.push('【' + plain(s.h) + '】' + paras(s.p));
  }
  if (d.life) out.push('【' + (d.lifeLabel || '暮らしに効く') + '】' + plain(d.life));
  for (const t of d.terms || []) if (Array.isArray(t) && t[0]) out.push('用語「' + plain(t[0]) + '」: ' + plain(t[1]));
  return out.join('\n');
}
function triviaText(it) {
  const d = it.data;
  const g = d.genreLabel || (GENRES[d.genre] || {}).label || '';
  const out = ['■ 雑学' + it.n + '本目 [' + g + '] ' + plain(d.title)];
  if (d.gist) out.push('ひとことで: ' + plain(d.gist));
  for (const s of d.sections || []) out.push((s.h ? '【' + plain(s.h) + '】' : '') + paras(s.p));
  if (d.talk) out.push('会話で使える一言: ' + plain(d.talk));
  if (d.extra && d.extra.text) out.push('【' + (d.extra.label || 'ひとこと') + '】' + plain(d.extra.text));
  const q = d.quiz;
  if (q && q.q && Array.isArray(q.choices)) {
    out.push('クイズ: ' + plain(q.q) + ' 選択肢: ' + q.choices.map((c, i) => (i + 1) + '.' + plain(c)).join(' ') +
      ' 答え: ' + (q.choices[q.answer] != null ? plain(q.choices[q.answer]) : '') + (q.why ? '(' + plain(q.why) + ')' : ''));
  }
  return out.join('\n');
}

// どの日の分を出すか: 押した画面の日付。続けてもう一方を聞くときは、
// 最新の日を見ていればもう一方も最新(片方だけ先に届いていても今日の分になる)、前の日を見ていればその日の分
function dayFor(kind, fromKind, date) {
  if (date === store.latest(fromKind)) return store.latest(kind);
  return store.itemsOf(kind, date).length ? date : store.latest(kind);
}
function plan(kind, date, n, both) {
  const kinds = n ? [kind] : both ? [kind, other(kind)] : [kind];
  return kinds.map((k) => {
    const d = k === kind ? date : dayFor(k, kind, date);
    const items = d ? store.itemsOf(k, d).filter((it) => !n || it.n === n).sort((x, y) => x.n - y.n) : [];
    return { kind: k, date: d, items };
  }).filter((p) => p.items.length);
}

function howTo(parts, n) {
  const say = [];
  say.push('私は通勤・通学中に、音声モードで歩きながら聞いています。記号や箇条書きは使わず、耳で聞いてわかる話し言葉でお願いします。');
  if (n) {
    say.push(parts[0].kind === 'news' ? 'このニュースを1分くらいで話して、' : 'この雑学を40秒くらいで話して、');
    say.push('「質問ある？」と聞いてください。わからない言葉を聞いたら、記事をふまえて短く答えてください。');
    return say.join('');
  }
  parts.forEach((p, i) => {
    const head = i === 0 ? 'まず' : 'それが終わったら「次は' + NAME[p.kind] + 'です」と言って、';
    if (p.kind === 'news') say.push(head + 'ニュース' + p.items.length + '本を1本ずつ、ニュースキャスターのように1本1分くらいで話して、1本ごとに「質問ある？それとも次へ？」と聞いてください。');
    else say.push(head + '雑学' + p.items.length + '本を1本ずつ、友だちに話すように1本40秒くらいで話して、最後に「会話で使える一言」を添え、1本ごとに「質問ある？それとも次へ？」と聞いてください。');
  });
  if (parts.some((p) => p.kind === 'trivia')) say.push('最後まで話し終えたら「雑学のクイズやる？」と聞いて、やるなら雑学の記事にあるクイズを1問ずつ出してください。');
  say.push('わからない言葉を聞いたら、記事をふまえて短く答えてください。「次」と言われたら次へ、「飛ばして」と言われたら次の話へ進んでください。');
  return say.join('');
}
function title(parts, n) {
  if (n) return 'あさよみの' + md(parts[0].date) + 'の' + NAME[parts[0].kind] + '(' + n + '本目)です。';
  return 'あさよみの' + parts.map((p) => md(p.date) + 'の' + NAME[p.kind] + p.items.length + '本').join('と') + 'です。';
}
function fullText(parts, n) {
  const body = parts.map((p) => p.items.map(p.kind === 'news' ? newsText : triviaText).join('\n\n')).join('\n\n');
  return title(parts, n) + '下の記事を読んでください。\n' + howTo(parts, n) + '\n\n' + body;
}
function shortText(parts, n) {
  const urls = parts.map((p) => FN + '?k=' + p.kind + '&d=' + p.date + (n ? '&n=' + n : ''));
  return title(parts, n) + 'まず ' + urls.join(' と ') + ' を開いて全部読んでください。\n' + howTo(parts, n);
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch (e) { /* 下のやり方で */ }
  try {
    const t = h('textarea', { style: { position: 'fixed', top: '-1000px', opacity: '0' } });
    t.value = text; document.body.append(t); t.select();
    const ok = document.execCommand('copy'); t.remove(); return ok;
  } catch (e) { return false; }
}

const BOTH_KEY = 'asayomi:talkBoth';
function wantBoth() { try { return localStorage.getItem(BOTH_KEY) !== '0'; } catch (e) { return true; } }
function setBoth(v) { try { localStorage.setItem(BOTH_KEY, v ? '1' : '0'); } catch (e) { /* 覚えなくても使える */ } }

export function openClaude(kind, date, n) {
  pauseListening();
  const canBoth = !n && !!store.latest(other(kind));
  let both = canBoth && wantBoth();
  let parts = plan(kind, date, n, both);
  if (!parts.length) { toast('話せる記事がありません'); return; }
  copyText(fullText(parts, n)); // 押したその場でコピーしておく(iPhone は押した直後しかコピーできない)

  openSheet((sheet) => {
    const what = h('p', { class: 'sd' });
    const open = h('a', { class: 'pbtn', target: '_blank', rel: 'noopener' }, 'Claudeを開く(文が入った状態で)');
    const paint = () => {
      what.textContent = (n ? 'この' + NAME[kind] : parts.map((p) => NAME[p.kind] + p.items.length + '本').join(' → ')) + 'と頼む文を、まとめてコピーしました。';
      open.href = 'https://claude.ai/new?q=' + encodeURIComponent(shortText(parts, n));
    };
    sheet.append(h('h3', null, 'Claudeと話して聞く'));
    if (canBoth) {
      const seg = h('div', { class: 'tseg', role: 'radiogroup', 'aria-label': '聞く順番' });
      const opts = [[true, NAME[kind] + ' → ' + NAME[other(kind)]], [false, NAME[kind] + 'だけ']];
      for (const [v, label] of opts) {
        const b = h('button', { type: 'button', role: 'radio', 'aria-checked': String(both === v) }, label);
        b.addEventListener('click', async () => {
          both = v; setBoth(v);
          parts = plan(kind, date, n, both);
          for (const x of seg.children) x.setAttribute('aria-checked', String(x === b));
          paint();
          toast((await copyText(fullText(parts, n))) ? 'コピーし直しました' : 'コピーできませんでした');
        });
        seg.append(b);
      }
      sheet.append(seg);
    }
    const again = h('button', { class: 'pbtn sub', type: 'button' }, 'もう一度コピーする');
    again.addEventListener('click', async () => { toast((await copyText(fullText(parts, n))) ? 'コピーしました' : 'コピーできませんでした'); });
    paint();
    sheet.append(what,
      h('ol', { class: 'csteps' },
        h('li', null, h('b', null, 'Claudeアプリ'), 'を開いて、新しいチャットに', h('b', null, '貼り付けて送る')),
        h('li', null, '右下の', h('b', null, '音声モード'), 'にする'),
        h('li', null, '「次」「それってなに？」「飛ばして」のように話しかける')),
      open,
      h('div', { class: 'qa-b', style: { marginTop: '8px' } }, again),
      h('p', { class: 'sd sm' }, '「Claudeを開く」はブラウザで開くことがあります。そのときは、Claudeアプリを開いて貼り付けるほうが確実です。'));
  });
}
export function claudeButton(kind, date, n) {
  return h('button', { class: 'lbtn cl', type: 'button', onclick: () => openClaude(kind, date, n) }, icon('talk', 16), n ? 'Claudeと話す' : 'Claudeと話して聞く');
}
