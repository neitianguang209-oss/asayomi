// 画面の行き来。URLの # 以降で場所を表す(例: #/trivia/2026-10-09/2)。
// アプリの中で進んだ回数を覚えておき、×ボタンは「戻れるなら戻る・戻れないなら一覧へ」。
let router = () => {};
let depth = 0;

export function setRouter(fn) {
  router = fn;
  history.replaceState({ d: 0 }, '', location.hash || '#/');
  window.addEventListener('popstate', (e) => {
    depth = (e.state && e.state.d) || 0;
    router();
  });
}
export function go(hash) {
  depth++;
  history.pushState({ d: depth }, '', hash);
  router();
}
export function replace(hash) {
  history.replaceState({ d: depth }, '', hash);
  router();
}
export function back(fallback) {
  if (depth > 0) history.back();
  else replace(fallback || '#/');
}
