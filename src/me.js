// きろく・設定のページと、日付をえらぶカレンダー
import { h, clear, todayJST, addDays, dparts, mdDate, DOW } from './util.js';
import { VERSION, INTERVALS } from './config.js';
import { openSetup, voiceStatus } from './listen.js';
import * as store from './store.js';
import { icon } from './art.js';
import { replace, back } from './nav.js';
import { openSheet, toast, xButton } from './ui.js';

/* ---------- カレンダー(配信のあった日に点。ぜんぶ読んだ日は緑) ---------- */
export function openCalendar(kind, curDate) {
  const have = new Set(store.dates(kind));
  const all = store.dates(kind);
  if (!all.length) return;
  const minYm = all[all.length - 1].slice(0, 7);
  const maxYm = all[0].slice(0, 7);
  let ym = (curDate || all[0]).slice(0, 7);
  const today = todayJST();
  const shift = (s, n) => { const y = +s.slice(0, 4); const m = +s.slice(5, 7) - 1 + n; const d = new Date(Date.UTC(y, m, 1)); return d.toISOString().slice(0, 7); };

  openSheet((sheet, close) => {
    const body = h('div');
    sheet.append(body);
    const paint = () => {
      clear(body);
      const y = +ym.slice(0, 4);
      const m = +ym.slice(5, 7);
      const prev = h('button', { type: 'button', 'aria-label': '前の月', disabled: ym <= minYm, onclick: () => { ym = shift(ym, -1); paint(); } }, icon('left', 18));
      const next = h('button', { type: 'button', 'aria-label': '次の月', disabled: ym >= maxYm, onclick: () => { ym = shift(ym, 1); paint(); } }, icon('right', 18));
      body.append(h('div', { class: 'cal-h' }, prev, h('b', null, y + '年' + m + '月の' + (kind === 'trivia' ? '雑学' : 'ニュース')), next));
      const grid = h('div', { class: 'cal' });
      for (const w of DOW) grid.append(h('span', { class: 'w' }, w));
      const first = dparts(ym + '-01').w;
      const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
      for (let i = 0; i < first; i++) grid.append(h('span'));
      for (let d = 1; d <= last; d++) {
        const date = ym + '-' + String(d).padStart(2, '0');
        if (!have.has(date)) { grid.append(h('span', { class: 'd' }, d)); continue; }
        const items = store.itemsOf(kind, date);
        const done = items.length && store.readCount(kind, date) >= items.length;
        const cls = [done ? 'done' : '', date === curDate ? 'cur' : '', date === today ? 'today' : ''].join(' ').trim();
        grid.append(h('button', { type: 'button', class: cls, 'aria-label': mdDate(date) + (done ? '（読了）' : ''),
          onclick: () => { close(); replace('#/' + kind + (date === all[0] ? '' : '/' + date)); window.scrollTo(0, 0); } }, d));
      }
      body.append(grid, h('div', { class: 'cal-legend' }, h('span', null, h('i'), '配信あり'), h('span', null, h('i', { class: 'g' }), 'ぜんぶ読んだ')));
    };
    paint();
  });
}

/* ---------- きろく・設定 ---------- */
function ago(ts) {
  if (!ts) return 'まだ';
  const m = Math.round((Date.now() - ts) / 60000);
  if (m < 1) return 'たった今';
  if (m < 60) return m + '分前';
  if (m < 60 * 24) return Math.round(m / 60) + '時間前';
  return Math.round(m / 1440) + '日前';
}

export function mePage() {
  const root = h('div', { class: 'page' });
  const wrap = h('div', { class: 'wrap' });
  root.append(wrap);

  const paint = () => {
    clear(wrap);
    wrap.append(h('div', { class: 'pbar' }, h('h1', null, 'きろく'), xButton(() => back('#/'))));

    const streak = store.streak();
    const today = todayJST();
    const days = h('div', { class: 'me-days' });
    for (let i = 13; i >= 0; i--) {
      const a = store.activity(addDays(today, -i));
      const n = a ? (a.r || 0) + (a.q || 0) : 0;
      days.append(h('i', { class: n >= 10 ? 'a3' : n >= 4 ? 'a2' : n >= 1 ? 'a1' : '', title: mdDate(addDays(today, -i)) + '：' + n }));
    }
    wrap.append(h('div', { class: 'me-hero' },
      h('div', { class: 'fl' }, icon('flame', 34)),
      h('div', { style: { flex: '1', 'min-width': '0' } },
        h('b', null, String(streak), h('small', null, '日連続')),
        h('span', null, streak ? '開いて読んだ日が続いています。' : '今日ひとつ読むと、ここから数え始めます。'),
        days, h('div', { class: 'me-cap' }, h('span', null, '2週間前'), h('span', null, '今日')))));

    const cs = store.cardStats();
    const t = (num, unit, label) => h('div', { class: 'stat' }, h('b', null, String(num), h('small', null, unit)), h('span', null, label));
    wrap.append(h('div', { class: 'stats' },
      t(store.st.count('read:t:'), '本', '読んだ雑学'), t(store.st.count('read:n:'), '本', '読んだニュース'), t(cs.mastered, '個', '覚えた')));

    // 復習カードの段階
    const max = Math.max(1, ...cs.boxes);
    const bars = h('div', { class: 'lv-bars' });
    cs.boxes.forEach((n, i) => {
      bars.append(h('div', null, h('i', { style: { height: Math.round((n / max) * 100) + '%' } }), h('small', null, n)));
    });
    const labels = h('div', { class: 'me-cap' });
    INTERVALS.forEach((d, i) => labels.append(h('span', { style: { flex: '1', 'text-align': 'center' } }, i === 0 ? '新しい' : i >= 4 ? (i === 4 ? '覚えた' : '定着') : d + '日')));
    labels.style.display = 'flex';
    wrap.append(h('div', { class: 'sr-h' }, h('span', null, '復習カード（' + cs.total + '枚）'), h('span', null, '今日出るのは ' + store.dueCards().length + ' 問')),
      h('div', { class: 'me-sec', style: { padding: '10px 16px 12px' } }, bars, labels));

    // 設定
    const pref = store.pref();
    const sw = h('button', { class: 'sw', type: 'button', role: 'switch', 'aria-checked': String(!!pref.autoReview), 'aria-label': '読んだ雑学を自動で復習に入れる' });
    sw.addEventListener('click', () => { store.setPref({ autoReview: !store.pref().autoReview }); paint(); });
    const pick = h('div', { class: 'pick3' }, [5, 10, 20].map((n) =>
      h('button', { type: 'button', class: pref.quizSize === n ? 'on' : '', onclick: () => { store.setPref({ quizSize: n }); paint(); } }, n)));
    wrap.append(h('div', { class: 'sr-h' }, h('span', null, '復習の設定')),
      h('div', { class: 'me-sec' },
        h('div', { class: 'me-row' }, h('div', { class: 't' }, h('b', null, '読んだ雑学を自動で復習に入れる'), h('small', null, '記事を開いた次の日から、クイズで出し直します。')), sw),
        h('div', { class: 'me-row' }, h('div', { class: 't' }, h('b', null, '1回に出す数'), h('small', null, 'たまっていても、1回はここまで。')), pick)));

    // ニュースの読み上げ(Gemini のキーはサーバーに置く。ここでは登録の有無だけ見る)
    const vSmall = h('small', null, '確かめています…');
    const vRow = h('button', { class: 'me-row', type: 'button', onclick: () => openSetup(() => paint()) },
      h('div', { class: 't' }, h('b', null, 'Gemini のキー'), vSmall));
    voiceStatus().then((v) => {
      if (!v.ok) { vSmall.textContent = '通信できませんでした'; return; }
      let t = v.ready ? '登録ずみ(押すと登録し直せます)' : 'まだです。押して登録すると「まとめて聞く」が使えます';
      if (v.ready) t += '　今日の声 ' + v.made + '/' + store.itemsOf('news', store.latest('news')).length + '本';
      if (v.lastError) t += '　最後のエラー ' + new Date(v.lastError.at).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) + '(' + v.lastError.where + ')';
      vSmall.textContent = t;
    });
    wrap.append(h('div', { class: 'sr-h' }, h('span', null, 'ニュースの読み上げ')), h('div', { class: 'me-sec' }, vRow,
      h('div', { class: 'me-row' }, h('div', { class: 't' }, h('b', null, 'Claudeと話して聞く'), h('small', null, 'キーなしで使えます。ニュースのトップか記事の「Claudeと話して聞く」から、Claudeアプリの音声モードで。')))));

    // データ
    const S = store.S;
    const waiting = S.outbox.size;
    const state = S.status === 'offline' ? '圏外（端末の中身で動いています）' : S.status === 'error' ? 'クラウドに届きませんでした' : S.status === 'syncing' ? '確認中…' : '最新です';
    const refresh = h('button', { class: 'me-row', type: 'button' },
      h('div', { class: 't' }, h('b', null, '最新を取りに行く'),
        h('small', null, state + '　記事 ' + ago(S.meta.pulledAt) + '・きろく ' + ago(S.meta.stateSyncedAt) + (waiting ? '・送信待ち ' + waiting + '件' : ''))));
    refresh.addEventListener('click', async () => {
      refresh.disabled = true;
      await Promise.all([store.pull(), store.syncState({ full: true })]);
      toast(store.S.status === 'idle' ? '最新にしました' : '通信できませんでした');
      paint();
    });
    const exp = h('button', { class: 'me-row', type: 'button' },
      h('div', { class: 't' }, h('b', null, 'データを書き出す'), h('small', null, '既読・保存・復習の記録と記事を、1つのファイルにして手元に残します。')));
    exp.addEventListener('click', () => {
      const blob = new Blob([JSON.stringify(store.exportAll())], { type: 'application/json' });
      const a = h('a', { href: URL.createObjectURL(blob), download: 'asayomi-' + todayJST() + '.json' });
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    });
    const rebuild = h('button', { class: 'me-row', type: 'button' },
      h('div', { class: 't' }, h('b', null, '記事を取り込み直す'), h('small', null, '表示がおかしいときに。端末の記事の写しを捨てて、クラウドから入れ直します（きろくは消えません）。')));
    rebuild.addEventListener('click', async () => {
      rebuild.disabled = true;
      await store.rebuild();
      toast(store.S.status === 'idle' ? '取り込み直しました' : '通信できませんでした');
      paint();
    });
    wrap.append(h('div', { class: 'sr-h' }, h('span', null, 'データ')), h('div', { class: 'me-sec' }, refresh, exp, rebuild));

    wrap.append(h('div', { class: 'me-foot' },
      'あさよみ v' + VERSION, h('br'),
      '記事 ' + store.S.items.size + '本 ／ 雑学 ' + store.dates('trivia').length + '日分・ニュース ' + store.dates('news').length + '日分', h('br'),
      '毎朝7時ごろ、Claude が雑学5本とニュース8本を届けます'));
  };
  paint();
  // 開いている間に裏で取り込みや同期が進んだら、数字を新しくする(閉じたら聞くのをやめる)
  const again = () => {
    if (!root.isConnected) { store.off('content', again); store.off('status', again); return; }
    paint();
  };
  store.on('content', again);
  store.on('status', again);
  return root;
}
