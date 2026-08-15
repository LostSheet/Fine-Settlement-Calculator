/* docs/index.html 한 파일로 빌드합니다 (GitHub Pages 가 docs/ 를 그대로 서빙).
   React 포함 전부 인라인이라 서버 없이 어디서든 열립니다. */
const esbuild = require("esbuild");
const fs = require("fs");
const path = require("path");

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
<style>
@font-face{font-family:'Cutive Mono';font-style:normal;font-weight:400;font-display:swap;src:url(data:font/woff2;base64,${font}) format('woff2')}
html,body{margin:0;padding:0;background:#c3a97f}
</style>
</head>
<body>
<div id="root"></div>
<script>${bundle}</script>
</body>
</html>
`;

fs.mkdirSync("docs", { recursive: true });
fs.writeFileSync(path.join("docs", "index.html"), html);
console.log("docs/index.html", (html.length / 1024).toFixed(0) + "KB");
