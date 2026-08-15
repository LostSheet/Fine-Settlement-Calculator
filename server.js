/* GoldSettlement.jsx 미리보기 서버
 *
 *   node server.js            기본 경로(아래 SRC)의 jsx 를 띄웁니다
 *   node server.js <파일경로>  다른 파일을 띄웁니다
 *
 * 요청마다 파일을 다시 읽으므로, 저장 후 브라우저 새로고침만 하면 반영됩니다.
 * 서버를 껐다 켤 필요 없습니다.
 */
const http = require("http");
const fs = require("fs");
const path = require("path");

const SRC = path.resolve(process.argv[2] || path.join(__dirname, "src", "GoldSettlement.jsx"));
const PORT = Number(process.env.PORT) || 5175;

const page = () => {
  const jsx = fs
    .readFileSync(SRC, "utf8")
    // import 문을 React 전역에서 꺼내 쓰는 형태로 바꿉니다 (번들러 없이 굴리기 위해)
    .replace(
      /^import\s+\{([^}]*)\}\s+from\s+"react";?\s*/m,
      (_m, names) => `const {${names.trim()}} = React;\n`
    )
    .replace(/^export default function (\w+)/m, "function $1");

  return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>GoldSettlement preview</title>
<style>html,body{margin:0;padding:0}</style>
<script src="https://unpkg.com/react@18/umd/react.development.js" crossorigin></script>
<script src="https://unpkg.com/react-dom@18/umd/react-dom.development.js" crossorigin></script>
<script src="https://unpkg.com/@babel/standalone@7/babel.min.js"></script>
</head><body><div id="root"></div>
<script type="text/babel" data-presets="react">
${jsx}
ReactDOM.createRoot(document.getElementById("root")).render(<GoldSettlement />);
</script>
</body></html>`;
};

http
  .createServer((req, res) => {
    if (req.url !== "/" && req.url !== "/index.html") {
      res.writeHead(404).end();
      return;
    }
    try {
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      });
      res.end(page());
    } catch (e) {
      res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      res.end(String((e && e.stack) || e));
    }
  })
  .listen(PORT, () => {
    console.log(`preview  http://localhost:${PORT}`);
    console.log(`source   ${SRC}`);
  });
