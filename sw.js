/**
 * Service Worker — オフラインでも遊べるようにするためのファイル。
 *
 * CACHE 名に APP_VERSION を埋め込んである。script.js の APP_VERSION を上げたら
 * ここも同じ値に更新すること(値が変わることでブラウザが更新を検知し、古い
 * キャッシュを捨てて新しいファイルを取り直す)。
 */
const APP_VERSION = '0.18.0';
const CACHE = 'sakito-quiz-' + APP_VERSION;

// 起動に必要な一式。これだけあれば通信が無くても最初から最後まで遊べる
const ASSETS = [
  './',
  './index.html',
  './style.css',
  './data.js',
  './script.js',
  './manifest.webmanifest',
  './favicon.svg',
  './favicon-32.png',
  './apple-touch-icon.png',
  './icon-192.png',
  './icon-512.png',
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE)
      .then(cache => cache.addAll(ASSETS))
      // 1つでも欠けると install ごと失敗してオフライン化しないので、
      // 取得できなかったファイルがあっても残りは使えるようにしておく
      .catch(() => caches.open(CACHE).then(cache =>
        Promise.all(ASSETS.map(url => cache.add(url).catch(() => null)))
      ))
      .then(() => self.skipWaiting()) // 次の起動を待たずに新しい版へ入れ替える
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k.startsWith('sakito-quiz-') && k !== CACHE)
            .map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  // 自分のサイト以外(CDN等)は素通し。今は外部依存が無いが、将来足したときに
  // オフラインキャッシュへ巻き込まないようにしておく
  if (new URL(req.url).origin !== self.location.origin) return;

  // HTML はネットワーク優先。キャッシュ優先にすると、更新したのに
  // 古い画面が出続けることになるため
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then(res => {
          const copy = res.clone();
          caches.open(CACHE).then(cache => cache.put(req, copy));
          return res;
        })
        .catch(() => caches.match(req).then(hit => hit || caches.match('./index.html')))
    );
    return;
  }

  // CSS/JS/画像はキャッシュ優先(表示が速い)。裏で取り直して次回に備える
  event.respondWith(
    caches.match(req).then(hit => {
      const fetching = fetch(req).then(res => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then(cache => cache.put(req, copy));
        }
        return res;
      }).catch(() => hit);
      return hit || fetching;
    })
  );
});
