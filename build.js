/* docs/index.html 한 파일로 빌드합니다 (GitHub Pages 가 docs/ 를 그대로 서빙).
   React 포함 전부 인라인이라 서버 없이 어디서든 열립니다. */
const esbuild = require("esbuild");
const fs = require("fs");
const path = require("path");
const { makeIcon } = require("./icon.js");

process.chdir(__dirname);

esbuild.buildSync({
  entryPoints: ["entry.jsx"],
  bundle: true,
  minify: true,
  jsx: "automatic",
  define: { "process.env.NODE_ENV": '"production"' },
  outfile: "bundle.tmp.js",
});

const bundle = fs
  .readFileSync("bundle.tmp.js", "utf8")
  // 인라인 <script> 안에서 조기 종료되지 않게
  .replace(/<\/script/gi, "<\\/script");
fs.rmSync("bundle.tmp.js");

// 숫자 서체는 즉시 뜨도록 인라인. 나머지 폰트는 컴포넌트의 @import 로 로드됩니다.
const font = fs.readFileSync(path.join("assets", "cutive.woff2")).toString("base64");

const html = `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>벌금 정산</title>
<meta name="description" content="벌금을 적으면 최소 송금 조합과 우편 수수료까지 계산합니다.">
<meta property="og:title" content="벌금 정산">
<meta property="og:description" content="벌금을 적으면 최소 송금 조합과 우편 수수료까지 계산합니다.">
<link rel="manifest" href="manifest.webmanifest">
<meta name="theme-color" media="(prefers-color-scheme: light)" content="#c3a97f">
<meta name="theme-color" media="(prefers-color-scheme: dark)" content="#241f19">
<link rel="icon" href="icon-192.png">
<link rel="apple-touch-icon" href="icon-192.png">
<style>
@font-face{font-family:'Cutive Mono';font-style:normal;font-weight:400;font-display:swap;src:url(data:font/woff2;base64,${font}) format('woff2')}
html,body{margin:0;padding:0;background:#c3a97f}
@media (prefers-color-scheme:dark){html,body{background:#241f19}}
</style>
</head>
<body>
<div id="root"></div>
<script>${bundle}</script>
<script>
if ("serviceWorker" in navigator && window.isSecureContext) {
  addEventListener("load", function () { navigator.serviceWorker.register("sw.js").catch(function () {}); });
}
</script>
</body>
</html>
`;

/* 설치형(PWA) 파일들 — 브라우저 껍데기 없는 창으로 띄우고, 오프라인에서도 열립니다 */
const manifest = {
  name: "벌금 정산",
  short_name: "벌금 정산",
  description: "벌금을 적으면 최소 송금 조합과 우편 수수료까지 계산합니다.",
  lang: "ko",
  start_url: "./",
  scope: "./",
  display: "standalone",
  orientation: "any",
  background_color: "#c3a97f",
  theme_color: "#c3a97f",
  icons: [
    { src: "icon-192.png", sizes: "192x192", type: "image/png" },
    { src: "icon-512.png", sizes: "512x512", type: "image/png" },
    { src: "icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
  ],
};

/* 페이지는 '온라인이면 항상 새로, 오프라인이면 캐시'.
   폰트는 반대로 '캐시 먼저' — 한 번 받아두면 오프라인에서도 글꼴이 유지됩니다. */
const sw = `const CACHE = "gs-v1";

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(["./", "manifest.webmanifest", "icon-192.png"]))
      .catch(() => {}).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  const isFont = url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com";

  if (isFont) {
    e.respondWith(
      caches.match(req).then((hit) =>
        hit ||
        fetch(req).then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
          return res;
        })
      )
    );
    return;
  }

  if (req.mode === "navigate" || url.origin === self.location.origin) {
    e.respondWith(
      fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => caches.match(req).then((hit) => hit || caches.match("./")))
    );
  }
});
`;

fs.mkdirSync("docs", { recursive: true });
fs.writeFileSync(path.join("docs", "index.html"), html);
fs.writeFileSync(path.join("docs", "manifest.webmanifest"), JSON.stringify(manifest, null, 2));
fs.writeFileSync(path.join("docs", "sw.js"), sw);
fs.writeFileSync(path.join("docs", "icon-192.png"), makeIcon(192));
fs.writeFileSync(path.join("docs", "icon-512.png"), makeIcon(512));
fs.writeFileSync(path.join("docs", "icon-maskable-512.png"), makeIcon(512, 0.8));
console.log("docs/index.html", (html.length / 1024).toFixed(0) + "KB");
console.log("docs/ + manifest.webmanifest, sw.js, icon-192/512, icon-maskable-512");
