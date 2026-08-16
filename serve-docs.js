/* 빌드 결과(docs/)를 그대로 서빙합니다 — 설치형(PWA) 동작을 실제로 확인할 때 씁니다.
 * 서비스워커는 https 또는 localhost 에서만 도므로 이 서버로 열어야 검증됩니다.
 *
 *   node serve-docs.js        http://localhost:5180
 */
const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "docs");
const PORT = Number(process.env.PORT) || 5180;
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".png": "image/png",
};

http
  .createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split("?")[0]);
    const file = path.join(ROOT, rel === "/" ? "index.html" : rel);
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, {
      "content-type": TYPES[path.extname(file)] || "application/octet-stream",
      // 서비스워커가 캐시를 맡으므로 브라우저 캐시는 끕니다
      "cache-control": "no-store",
    });
    res.end(fs.readFileSync(file));
  })
  .listen(PORT, () => {
    console.log(`dist preview  http://localhost:${PORT}`);
    console.log(`serving       ${ROOT}`);
  });
