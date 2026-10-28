// Service Worker(手書き・ビルド不要)。全パスは相対。GitHub Pages のサブパス配信でも壊れないようにするため。
// アプリを更新して公開するたび、内容を問わず毎回 v を上げる(上げないと古い画面が出続ける)。
const CACHE_NAME = 'asayomi-v10';
const FONT_CACHE = 'asayomi-fonts';
const AUDIO_CACHE = 'asayomi-audio'; // ニュースの音声(listen.js が出し入れする)。更新しても消さない
const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './css/app.css',
  './src/main.js',
  './src/config.js',
  './src/util.js',
  './src/store.js',
  './src/art.js',
  './src/nav.js',
  './src/ui.js',
  './src/actions.js',
  './src/lookup.js',
  './src/trivia.js',
  './src/news.js',
  './src/review.js',
  './src/search.js',
  './src/me.js',
  './src/listen.js',
  './src/talk.js',
  './icons/icon-192.png',
  './icons/icon-180.png',
  './icons/favicon-32.png',
].map((p) => new URL(p, self.registration.scope).toString());

const INDEX_URL = new URL('./index.html', self.registration.scope).toString();

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => Promise.all(APP_SHELL.map((u) => cache.add(new Request(u, { cache: 'reload' })).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME && k !== FONT_CACHE && k !== AUDIO_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // 記事や記録のやりとり(Supabase)は、いつも通信に任せる
  if (url.hostname.endsWith('supabase.co')) return;

  // 文字のフォントは一度取ったら使い回す
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    event.respondWith(
      caches.open(FONT_CACHE).then((cache) => cache.match(req).then((hit) => hit || fetch(req).then((res) => {
        if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone());
        return res;
      }).catch(() => hit)))
    );
    return;
  }

  if (url.origin !== self.location.origin) return;

  // アプリ本体: まず手元の控えを出し、裏で新しいものに入れ替えておく
  event.respondWith(
    caches.match(req, { ignoreSearch: req.mode === 'navigate' }).then((cached) => {
      const fresh = fetch(req).then((res) => {
        if (res && res.ok) {
          const clone = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
        }
        return res;
      }).catch(() => cached || (req.mode === 'navigate' ? caches.match(INDEX_URL) : undefined));
      return cached || fresh;
    })
  );
});
