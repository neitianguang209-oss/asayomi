// 画面の共通部品: 重ねる画面(記事・復習など)、下から出るシート、トースト、お知らせ、日付送り
import { h, jDate, mdDate, todayJST } from './util.js';
import { icon } from './art.js';
import * as store from './store.js';
import { go, replace } from './nav.js';

/* ---------- 重ねる画面 ---------- */
let layer = null;
let savedScroll = 0;
export function showLayer(el, anim) {
  const first = !layer;
  if (first) savedScroll = window.scrollY;
  if (layer) layer.remove();
  closeSheet();
  el.classList.add('layer');
  if (first && anim) el.classList.add(anim);
  document.getElementById('layers').append(el);
  layer = el;
  document.body.classList.add('locked');
  el.scrollTop = 0;
  return el;
}
export function closeLayer() {
  closeSheet();
  if (!layer) return false;
  layer.remove();
  layer = null;
  document.body.classList.remove('locked');
  window.scrollTo(0, savedScroll);
  return true;
}
export function hasLayer() { return !!layer; }
export function currentLayer() { return layer; }

/* ---------- 下から出るシート ---------- */
let sheetWrap = null;
export function openSheet(build) {
  closeSheet();
  const sheet = h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true' }, h('div', { class: 'grab' }));
  const wrap = h('div', { class: 'sheet-wrap', onclick: (e) => { if (e.target === wrap) closeSheet(); } }, sheet);
  build(sheet, closeSheet);
  document.body.append(wrap);
  sheetWrap = wrap;
  return sheet;
}
export function closeSheet() {
  if (sheetWrap) { sheetWrap.remove(); sheetWrap = null; }
}

/* ---------- トースト ---------- */
let toastTimer = 0;
export function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2400);
}

export function xButton(onclick, label) {
  return h('button', { class: 'xbtn', type: 'button', 'aria-label': label || '閉じる', onclick }, icon('x', 18));
}

/* ---------- 一覧の上に出すお知らせ ---------- */
// 今日の分がまだ届いていない／過去の日を見ている
export function dayNotice(kind, date) {
  const latest = store.latest(kind);
  const today = todayJST();
  if (date !== latest) {
    return h('div', { class: 'notice' },
      h('span', null, jDate(date) + 'の分を表示しています。'),
      h('button', { type: 'button', onclick: () => replace('#/' + kind) }, '最新へ'));
  }
  if (date < today) {
    const btn = h('button', { type: 'button' }, '確かめる');
    btn.addEventListener('click', async () => {
      btn.disabled = true; btn.textContent = '確認中…';
      const changed = await store.pull();
      if (!changed) { toast(store.S.status === 'idle' ? 'まだ届いていません' : '通信できませんでした'); btn.disabled = false; btn.textContent = '確かめる'; }
    });
    return h('div', { class: 'notice' },
      h('span', null, '今日（' + mdDate(today) + '）の分はまだ届いていません。届くまで ' + mdDate(date) + ' の分を出しています。'), btn);
  }
  return null;
}
// 復習がたまっているとき
export function reviewNudge() {
  const n = store.dueCards().length;
  if (!n) return null;
  return h('button', { class: 'nudge', type: 'button', onclick: () => go('#/review') },
    h('span', { class: 'ni' }, icon('cards', 22)),
    h('span', null, h('b', null, '復習が ' + n + ' 問たまっています'), h('small', null, '前に読んだ雑学と用語を、忘れかけた頃にもう一度。')),
    h('span', { class: 'go' }, 'はじめる'));
}
// 前の日・次の日
export function dayNav(kind, date) {
  const ds = store.dates(kind); // 新しい順
  const i = ds.indexOf(date);
  const older = i >= 0 ? ds[i + 1] : null;
  const newer = i > 0 ? ds[i - 1] : null;
  const b = (label, d) => {
    const btn = h('button', { type: 'button', disabled: !d }, label);
    if (d) btn.addEventListener('click', () => { replace('#/' + kind + '/' + d); window.scrollTo(0, 0); });
    return btn;
  };
  return h('div', { class: 'daynav' },
    b(older ? '‹ ' + mdDate(older) + ' の分' : '‹ 前の日', older),
    b(newer ? mdDate(newer) + ' の分 ›' : '次の日 ›', newer));
}
export function readMark() {
  return h('span', { class: 'readmark' }, icon('check', 13), '読んだ');
}
