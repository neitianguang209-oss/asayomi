// 記事の下のボタン: 思考メモに送る・保存・ToDoに入れる・復習に入れる。(用語のシートは lookup.js)
import { h, stableUuid, todayJST, mdDate } from './util.js';
import { APP_URL, MEMO_TAG } from './config.js';
import * as store from './store.js';
import { icon } from './art.js';
import { openSheet, toast } from './ui.js';

export function linkOf(it) {
  return APP_URL + '#/' + it.kind + '/' + it.date + '/' + it.n;
}

/* ---------- 思考メモ ----------
   思考メモ本体と同じ入口(shikou_memo_sync)を通す。IDは記事ごとに固定なので、2回送っても増えない。 */
export async function sendMemo(seed, body) {
  const now = new Date().toISOString();
  const id = stableUuid(seed);
  const res = await store.rpc('shikou_memo_sync', {
    p_changes: [{
      id, kind: 'note', deleted: false, updatedAt: now,
      data: { id, body, tagIds: [MEMO_TAG], dateKey: todayJST(), createdAt: now, updatedAt: now },
    }],
    p_since: null,
    p_device: 'asayomi',
  });
  if (!res || !(res.applied >= 1)) throw new Error('unconfirmed');
}
function memoOf(it) {
  const d = it.data;
  if (it.kind === 'trivia') {
    // 以前のページから送った分と同じIDになるよう、種は「日付＋(番号-1)」
    const line = d.legacy ? d.title : d.gist || d.title;
    return { seed: 'trivia-' + it.date + '-' + (it.n - 1), body: line + '\n\n詳しく：' + linkOf(it) };
  }
  const line = d.gist || (d.title + '\n' + store.briefOf(it));
  return { seed: 'news-' + it.date + '-' + it.n, body: line + '\n\n詳しく：' + linkOf(it) };
}
export function sendError(e) {
  if (navigator.onLine === false) return '圏外のようです。つながってからもう一度どうぞ。';
  if (e && e.message === 'unconfirmed') return '保存を確認できませんでした。思考メモで届いているか確かめてください。';
  return '送れませんでした。少し待ってもう一度どうぞ。';
}

/* ---------- ToDo(Google ToDo の「To Doリスト」へ) ---------- */
function openTodoSheet(it, onDone) {
  const d = it.data;
  const isTry = it.kind === 'news' && d.cat === 'ai' && /技術|トレンド/.test(d.role || '');
  let prefix = isTry ? '試す' : '調べる';
  const subject = d.keyword || String(d.title || '').split(/[\u3000 ]/)[0] || d.title;
  openSheet((sheet, close) => {
    const ta = h('textarea', { rows: '3', 'aria-label': 'ToDoの内容' });
    ta.value = prefix + '：' + subject;
    const chips = ['調べる', '試す', '読む', '話す'].map((p) => {
      const c = h('button', { class: 'chip' + (p === prefix ? ' on' : ''), type: 'button' }, p);
      c.addEventListener('click', () => {
        ta.value = ta.value.replace(/^(調べる|試す|読む|話す)：/, '');
        ta.value = p + '：' + ta.value;
        prefix = p;
        chips.forEach((x) => x.classList.toggle('on', x === c));
      });
      return c;
    });
    const stt = h('p', { class: 'status', role: 'status' });
    const btn = h('button', { class: 'bigbtn', type: 'button' }, 'ToDoに入れる');
    btn.addEventListener('click', async () => {
      const title = ta.value.trim().replace(/\s+/g, ' ');
      if (!title) { ta.focus(); return; }
      btn.disabled = true; btn.textContent = '追加中…'; stt.className = 'status'; stt.textContent = '';
      try {
        const res = await store.rpc('asayomi_todo_add', { p_title: title, p_notes: d.title + '\n' + linkOf(it) });
        if (res && res.ok) {
          store.st.set(store.todoId(it), { at: new Date().toISOString(), title });
          close();
          toast(res.dup ? 'さっき入れたものと同じです' : 'ToDoに入れました（数分でGoogle ToDoに出ます）');
          if (onDone) onDone();
          return;
        }
        stt.className = 'status err';
        stt.textContent = res && res.reason === 'limit' ? '今日はたくさん入れたので、続きは明日にしましょう。' : '入れられませんでした。';
      } catch (e) {
        stt.className = 'status err';
        stt.textContent = navigator.onLine === false ? '圏外のようです。つながってからもう一度どうぞ。' : '入れられませんでした。少し待ってもう一度どうぞ。';
      }
      btn.disabled = false; btn.textContent = 'ToDoに入れる';
    });
    sheet.append(
      h('h3', null, 'ToDoに入れる'),
      h('p', { class: 'sd' }, 'Google ToDo の「To Doリスト」に入ります。メモ欄にこの記事へのリンクが付きます。'),
      h('div', { class: 'pre' }, chips), ta, btn, stt);
  });
}

/* ---------- 記事の下のボタン一式 ---------- */
export function actionBar(it) {
  const box = h('div', { class: 'actions' });
  const send = h('button', { class: 'send', type: 'button' });
  const stt = h('p', { class: 'status', role: 'status' });
  const paintSend = () => {
    if (store.st.has(store.sentId(it))) {
      send.className = 'send done'; send.disabled = true; send.textContent = '✓ 思考メモに保存済み';
    } else {
      send.className = 'send'; send.disabled = false; send.textContent = '思考メモに送る（要約だけ）';
    }
  };
  paintSend();
  send.addEventListener('click', async () => {
    const m = memoOf(it);
    send.disabled = true; send.textContent = '送信中…'; stt.className = 'status'; stt.textContent = '';
    try {
      await sendMemo(m.seed, m.body);
      store.st.set(store.sentId(it), { at: new Date().toISOString() });
      paintSend();
      stt.textContent = '要約と、この記事へのリンクを「知識」タグで保存しました。';
    } catch (e) {
      paintSend();
      stt.className = 'status err';
      stt.textContent = sendError(e);
    }
  });

  const save = h('button', { class: 'ghost', type: 'button' });
  const paintSave = () => {
    const on = store.isSaved(it);
    save.className = 'ghost' + (on ? ' on' : '');
    save.replaceChildren(icon('save', 17), on ? '保存済み' : '保存');
    save.setAttribute('aria-pressed', String(on));
  };
  paintSave();
  save.addEventListener('click', () => { const on = store.toggleSave(it); paintSave(); toast(on ? '保存しました（さがす → 保存 で見られます）' : '保存をやめました'); });

  const todo = h('button', { class: 'ghost', type: 'button' });
  const paintTodo = () => {
    const on = store.st.has(store.todoId(it));
    todo.className = 'ghost' + (on ? ' on b' : '');
    todo.replaceChildren(icon('todo', 17), on ? 'ToDo済み' : 'ToDoへ');
  };
  paintTodo();
  todo.addEventListener('click', () => openTodoSheet(it, paintTodo));

  const row = h('div', { class: 'act2' }, save, todo);
  if (it.kind === 'trivia') {
    const cid = store.cardIdOf(it);
    const rev = h('button', { class: 'ghost', type: 'button' });
    const paintRev = () => {
      const c = store.st.get(cid);
      rev.className = 'ghost' + (c ? ' on g' : '');
      rev.replaceChildren(icon('cards', 17), c ? '復習 ' + mdDate(c.due) : '復習へ');
      rev.title = c ? '次の復習は ' + mdDate(c.due) + '。押すと外します' : '復習に入れる';
    };
    paintRev();
    rev.addEventListener('click', () => {
      if (store.st.has(cid)) { store.removeCard(cid); toast('復習から外しました'); }
      else { store.addCard(cid); toast('復習に入れました（あした出ます）'); }
      paintRev();
    });
    row.append(rev);
  } else {
    row.style.gridTemplateColumns = '1fr 1fr';
  }
  box.append(send, row, stt);
  return box;
}

