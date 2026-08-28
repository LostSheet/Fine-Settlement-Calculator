/* ---------------- 공유 주소가 가는 두 곳 ----------------
   OBS 브라우저 소스(window.obsstudio 주입됨) → 여기서 투명 오버레이를 그립니다.
   일반 브라우저 → 앱의 읽기 전용 화면으로 넘깁니다. 뷰어는 장부 관리자와 같은 3탭을 봐야 하고,
   그 화면은 앱이 이미 갖고 있으니 여기서 다시 그리지 않습니다. */

export const APP_URL = "https://lostsheet.github.io/Fine-Settlement-Calculator/";

export const PAGE_HTML = `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>벌금 현황판</title>
<style>
  :root{--ink:#f5f0e6; --gold:#e8c66a}
  *{margin:0; padding:0; box-sizing:border-box}
  html,body{background:transparent; overflow:hidden}
  body{font-family:'Segoe UI','Malgun Gothic',sans-serif; color:var(--ink)}

  .ov{width:fit-content; min-width:36vw; max-width:100vw; padding:1.2vw 1.9vw 1.2vw 1.6vw}
  /* 총액을 금액 열과 같은 선에 세웁니다 — 증감액 열 10.5 + 열 간격 1.6 + 줄 안쪽 여백 .4 */
  .ov-head{display:flex; align-items:baseline; gap:1.6vw; margin-bottom:.8vw; padding-right:12.5vw}
  .ov-name-t{font-size:4.2vw; font-weight:600; letter-spacing:.03em;
    overflow:hidden; text-overflow:ellipsis; white-space:nowrap}
  .ov-total{margin-left:auto; font-size:3.4vw; font-weight:600; color:var(--gold);
    font-variant-numeric:tabular-nums; white-space:nowrap}
  .ov-row{display:flex; align-items:baseline; gap:1.6vw; padding:.85vw .4vw;
    font-size:4.4vw; font-weight:500; line-height:1.2; border-radius:1vw;
    transition:transform .35s cubic-bezier(.22,1,.36,1)}
  /* 순위와 변동은 글자 크기가 달라서, 기준선 대신 줄 한가운데에 맞춥니다 */
  .ov-rank{width:5.2vw; font-size:3.6vw; opacity:.68; font-variant-numeric:tabular-nums;
    flex:none; align-self:center; text-align:center}
  /* 순위 변동 자리 — 비어 있어도 폭을 차지해서 이름 열이 밀리지 않습니다 */
  .ov-move{width:5.6vw; flex:none; font-size:2.9vw; font-weight:700; text-align:center;
    font-variant-numeric:tabular-nums; align-self:center}
  .ov-name{flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; padding-right:2.4vw}
  .ov-gold{font-variant-numeric:tabular-nums; color:var(--gold); flex:none}
  /* 증감액 — 금액 뒤의 고정폭 열. 판 안에 머물면서 금액 열의 오른쪽 끝은 안 밉니다 */
  .ov-delta{flex:none; width:10.5vw; padding-left:1.4vw; white-space:nowrap;
    font-size:3.4vw; font-weight:600; color:var(--gold)}
  .ov-delta.plus{color:#8fd89b}
  .ov-row.zero{opacity:.5}

  /* 1위 — 금색 순위와 살짝 밝은 이름으로 초점을 만듭니다 */
  .ov-row.top .ov-rank{color:var(--gold); opacity:1; font-weight:700}
  .ov-row.top .ov-name{font-weight:700}

  /* 방금 벌금이 붙은 줄 — 잠깐 번쩍이고 오른쪽에 증감이 떠올랐다 사라집니다 */
  .ov-row.hit{animation:ov-flash 1.6s ease-out}
  @keyframes ov-flash{
    from{background:rgba(232,198,106,.28)}
    to{background:transparent}
  }
  .ov-delta.plus,.ov-delta.minus{animation:ov-rise 4.2s ease-out forwards}
  .ov-delta.minus{color:#e0776b}
  @keyframes ov-rise{
    0%{opacity:0; transform:translateY(.7vw)}
    9%{opacity:1; transform:none}
    80%{opacity:1; transform:none}
    100%{opacity:0; transform:translateY(-.7vw)}
  }

  /* 순위 변동 — 몇 계단 올랐는지 잠깐 보여주고 지웁니다 */
  .ov-move.up,.ov-move.down{animation:ov-hold 6s ease-out forwards}
  .ov-move.up{color:#8fd89b}
  .ov-move.down{color:#e59a90}
  @keyframes ov-hold{0%,82%{opacity:1} 100%{opacity:0}}

  /* 투명 테마 — 글자 외곽을 여러 겹 눌러 게임 화면 위에서도 버팁니다 */
  html[data-t="clear"] .ov{text-shadow:
    0 0 12px rgba(0,0,0,.95), 0 0 5px rgba(0,0,0,1),
    0 2px 4px rgba(0,0,0,.95), 0 0 1px rgba(0,0,0,1)}
  html[data-t="cleardark"] .ov{--ink:#171310; --gold:#6d5210;
    text-shadow:
    0 0 12px rgba(255,255,255,.95), 0 0 5px rgba(255,255,255,1),
    0 2px 4px rgba(255,255,255,.95), 0 0 1px rgba(255,255,255,1)}
  html[data-t="dark"] .ov{background:rgba(20,17,14,var(--bg,.82));
    border-radius:max(12px, 1.4vw)}
  html[data-t="light"] .ov{--ink:#221c14; --gold:#8a6415;
    background:rgba(248,244,236,var(--bg,.88)); border-radius:max(12px, 1.4vw)}

  /* 미리보기 창에서만 — 투명한 자리를 체커보드로 표시합니다.
     중간 회색이라 밝은 글자·진한 글자 테마를 둘 다 판단할 수 있습니다. */
  /* overflow:hidden 의 잘라내는 기준이 html 박스라, 배율로 커진 판이 잘리지 않게 높이를 채웁니다 */
  html[data-preview="1"], html[data-preview="1"] body{height:100%}
  html[data-preview="1"] body{
    background-color:#8a8a8a;
    background-image:
      linear-gradient(45deg,#7b7b7b 25%,transparent 25%,transparent 75%,#7b7b7b 75%),
      linear-gradient(45deg,#7b7b7b 25%,transparent 25%,transparent 75%,#7b7b7b 75%);
    background-size:22px 22px;
    background-position:0 0,11px 11px;
  }

  /* 방송 중이 아님이 확인될 때만 JS가 켭니다 */
  .ov-notice{display:none; font-size:2.6vw; line-height:1.6; color:#f0b8b0; padding:1.2vw 1.6vw;
    text-shadow:0 1px 3px rgba(0,0,0,.9)}
  html[data-notice="1"] .ov-notice{display:block}

  @media (prefers-reduced-motion:reduce){ .ov-row{transition:none} }
</style>
</head>
<body><div id="app"></div>
<script>
(function () {
  var ROOM = "__ROOM__";
  /* 예시 방 — 서버에 방을 만들지 않고 페이지가 스스로 굴립니다. 지워질 일도, 만료될 일도 없어요. */
  var DEMO_ROOM = "CAFE22";
  var isDemo = ROOM === DEMO_ROOM;
  var q = new URLSearchParams(location.search);
  var forced = q.get("mode");
  var inOBS = forced === "overlay" || (forced !== "page" && !!window.obsstudio);

  /* 브라우저로 열었으면 앱의 읽기 전용 화면으로 넘깁니다 (예시도 같습니다).
     오버레이만 보고 싶으면 주소 뒤에 ?mode=overlay 를 붙이면 됩니다. */
  if (!inOBS) {
    var dest = "__APP__";
    if (location.hostname === "localhost" || location.hostname === "127.0.0.1")
      dest = "http://localhost:5175/";
    location.replace(dest + "#live=" + ROOM);
    return;
  }

  var root = document.documentElement;
  root.dataset.mode = "overlay";
  /* fit=1 이면 미리보기 창입니다. 진짜 OBS 안에서는 절대 켜지지 않게 한 번 더 막습니다 */
  var isPreview = q.get("fit") === "1" && !window.obsstudio;
  if (isPreview) root.dataset.preview = "1";
  /* 기본은 어디서든 읽히는 어두운 판. 주소에 직접 적은 테마가 있으면 그쪽이 우선 */
  var urlTheme = q.get("t");
  var urlBg = q.get("bg");
  root.dataset.t = urlTheme || "dark";
  var bg = parseInt(urlBg, 10);
  if (!isNaN(bg)) root.style.setProperty("--bg", Math.min(100, Math.max(0, bg)) / 100);

  /* 장부 관리자가 고른 테마가 상태에 실려 옵니다 — OBS 소스 URL을 안 바꿔도 즉시 갈아입습니다 */
  var applyLook = function (lk) {
    if (!lk || urlTheme) return;
    root.dataset.t = typeof lk.t === "string" ? lk.t : "dark";
    if (urlBg == null && lk.bg != null)
      root.style.setProperty("--bg", Math.min(100, Math.max(0, lk.bg)) / 100);
  };
  var s = parseInt(q.get("s"), 10);
  if (!isNaN(s)) document.body.style.fontSize = Math.min(300, Math.max(50, s)) + "%";

  var app = document.getElementById("app");
  var board = null;   // [{n,g}] — 앱이 계산해서 보내줍니다
  var prev = {};      // 이름 → {g, rank} — 증감과 순위 변동을 재는 기준점
  /* 이름 → 최근 변화와 그 시각. 다른 사람이 벌금을 먹어도 내 표시가 사라지지 않게
     렌더 횟수가 아니라 시간으로 유지하고, 표시가 살아 있는 동안 생긴 변화는 누적합니다.
     (5위→3위→2위면 ▲2 다음 ▲1 이 아니라 ▲3. 제자리로 돌아오면 표시를 끕니다) */
  var recent = {};
  var DELTA_MS = 4200, MOVE_MS = 6000;
  var name = "";
  var dead = false;

  /* 앱과 같은 만 단위 표기 */
  var man = function (g) {
    g = Math.round(g || 0);
    var neg = g < 0; g = Math.abs(g);
    var m = Math.floor(g / 10000), r = g % 10000;
    var c = function (x) { return x.toLocaleString("ko-KR"); };
    var out = m === 0 ? c(r) : r === 0 ? c(m) + "만" : c(m) + "만" + c(r);
    return (neg ? "\\u2212" : "") + out;
  };

  /* 순위: 금액 내림차순, 동률은 표에 적힌 순서 유지 */
  var ranked = function (rows) {
    return rows.map(function (r, i) { return { n: r.n, g: r.g || 0, i: i }; })
      .sort(function (a, b) { return b.g - a.g || a.i - b.i; });
  };

  var esc = function (t) {
    return String(t == null ? "" : t).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  };

  var rowsHtml = function (rows) {
    var list = ranked(rows);
    var now = Date.now();

    /* 이번 렌더에서 생긴 변화를 먼저 적어 둡니다 */
    list.forEach(function (r, i) {
      var was = prev[r.n];
      if (!was) return;
      var rank = i + 1;
      var rc = recent[r.n] || (recent[r.n] = {});

      if (r.g !== was.g) {
        // 표시가 꺼져 있었으면 지금 값을 기준점으로 새로 시작합니다
        if (rc.dAt == null || now - rc.dAt >= DELTA_MS) rc.dBase = was.g;
        rc.d = r.g - rc.dBase;
        rc.dAt = rc.d === 0 ? null : now;
      }
      /* 순위는 위로 갈수록 숫자가 작아지니, 기준 순위에서 뺀 값이 오른 계단 수입니다 */
      if (rank !== was.rank) {
        if (rc.mvAt == null || now - rc.mvAt >= MOVE_MS) rc.mvBase = was.rank;
        rc.mv = rc.mvBase - rank;
        rc.mvAt = rc.mv === 0 ? null : now;
      }
    });

    var html = list.map(function (r, i) {
      var was = prev[r.n];
      var justHit = !!was && r.g - was.g !== 0;   // 번쩍임은 바뀐 그 순간만
      var rc = recent[r.n] || {};
      var dAge = rc.dAt == null ? Infinity : now - rc.dAt;
      var mAge = rc.mvAt == null ? Infinity : now - rc.mvAt;
      var showD = dAge < DELTA_MS, showM = mAge < MOVE_MS;
      var cls = "ov-row" + (r.g ? "" : " zero") + (justHit ? " hit" : "") +
        (i === 0 && r.g ? " top" : "");
      /* 이미 흐르던 표시는 지난 만큼 앞당겨 이어 붙입니다 — 다시 처음부터 뜨지 않게 */
      var delay = function (age) { return ' style="animation-delay:-' + Math.round(age) + 'ms"'; };
      return '<div class="' + cls + '" data-k="' + esc(r.n) + '">' +
        '<span class="ov-rank">' + (i + 1) + '</span>' +
        '<span class="ov-move ' + (showM ? (rc.mv > 0 ? "up" : "down") : "") + '"' +
          (showM ? delay(mAge) : "") + '>' +
          (showM ? (rc.mv > 0 ? "▲" : "▼") + Math.abs(rc.mv) : "") + '</span>' +
        '<span class="ov-name">' + esc(r.n) + '</span>' +
        '<span class="ov-gold">' + man(r.g) + '</span>' +
        '<span class="ov-delta ' + (showD ? (rc.d > 0 ? "plus" : "minus") : "") + '"' +
          (showD ? delay(dAge) : "") + '>' +
          (showD ? (rc.d > 0 ? "+" : "−") + man(Math.abs(rc.d)) : "") + '</span></div>';
    }).join("");

    prev = {};
    list.forEach(function (r, i) { prev[r.n] = { g: r.g, rank: i + 1 }; });
    return html;
  };

  /* FLIP — 순위가 바뀌면 줄이 제자리에서 미끄러져 이동합니다 */
  var flip = function (box, draw) {
    var was = {};
    [].forEach.call(box.children, function (el) {
      if (el.dataset.k) was[el.dataset.k] = el.getBoundingClientRect().top;
    });
    draw();
    [].forEach.call(box.children, function (el) {
      var k = el.dataset.k;
      if (!k || was[k] == null) return;
      var d = was[k] - el.getBoundingClientRect().top;
      if (!d) return;
      el.style.transition = "none";
      el.style.transform = "translateY(" + d + "px)";
      void el.offsetHeight;
      el.style.transition = "";
      el.style.transform = "";
    });
  };

  var ovBoard = null;
  var render = function () {
    if (dead || !board || !board.length) {
      ovBoard = null;
      prev = {};
      recent = {};
      app.innerHTML = '<div class="ov-notice" id="notice"></div>';
      maybeNotice();
      return;
    }
    root.dataset.notice = "0";
    if (!ovBoard) {
      app.innerHTML = '<div class="ov"><div class="ov-head">' +
        '<span class="ov-name-t" id="ovname"></span>' +
        '<span class="ov-total" id="ovtotal"></span></div><div id="ovboard"></div></div>';
      ovBoard = document.getElementById("ovboard");
      ovBoard.innerHTML = rowsHtml(board);
    } else {
      flip(ovBoard, function () { ovBoard.innerHTML = rowsHtml(board); });
    }
    /* 오버레이 제목은 파티명이 아니라 '벌금표' — 방송 화면에 뜨는 건 표지판이지 명패가 아닙니다 */
    document.getElementById("ovname").textContent = "벌금표";
    document.getElementById("ovtotal").textContent =
      man(board.reduce(function (a, r) { return a + (r.g || 0); }, 0));
    fitPreview();
  };

  /* 미리보기 창 맞춤. 글자가 vw 기준이라 창을 좁히면 내용도 같이 줄어들어서,
     폭은 건드리지 않고 배율로 키웁니다. 폭만 채우면 높이가 넘쳐 잘리므로
     가로·세로 중 작은 배율을 써서 창 안에 통째로 넣고 가운데에 놓습니다.
     팝업이면 처음 한 번만 창 높이를 판에 맞춰 남는 여백을 없앱니다. */
  var fitted = false;
  var fitPreview = function () {
    if (!isPreview) return;
    var el = document.querySelector(".ov");
    if (!el) return;
    el.style.transform = "none";
    var r = el.getBoundingClientRect();
    if (!r.width || !r.height) return;
    var scale = Math.min(window.innerWidth / r.width, window.innerHeight / r.height);
    el.style.transformOrigin = "top left";
    el.style.transform =
      "translate(" + (window.innerWidth - r.width * scale) / 2 + "px," +
      (window.innerHeight - r.height * scale) / 2 + "px) scale(" + scale + ")";
    if (!fitted && window.opener) {
      fitted = true;
      var want = Math.round(r.height * (window.innerWidth / r.width));
      if (want > 0 && Math.abs(want - window.innerHeight) > 8)
        window.resizeBy(0, want - window.innerHeight);
    }
  };

  /* 방송 중이 아님이 확인될 때만 알립니다. 판별 실패는 침묵(안전한 쪽) */
  var maybeNotice = function () {
    if (!dead || !window.obsstudio || typeof window.obsstudio.getStatus !== "function") return;
    try {
      window.obsstudio.getStatus(function (st) {
        if (!st || st.streaming || st.recording) return;
        var el = document.getElementById("notice");
        if (!el) return;
        el.textContent = "이 주소는 더 이상 갱신되지 않아요. 장부 관리자에게 새 주소를 받아 URL만 바꿔주세요.";
        root.dataset.notice = "1";
      });
    } catch (e) { /* 권한 없음 → 침묵 */ }
  };

  /* 구독 — 접속 즉시 스냅샷 한 번, 이후 변경분. 끊기면 물러났다 다시 붙습니다 */
  var wait = 1000;
  var connect = function () {
    var ws;
    try {
      ws = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") +
        location.host + "/api/r/" + ROOM + "/live");
    } catch (e) { setTimeout(connect, wait); return; }
    var beat = setInterval(function () { if (ws.readyState === 1) ws.send("ping"); }, 50000);
    ws.onmessage = function (ev) {
      if (ev.data === "pong") return;
      try {
        var m = JSON.parse(ev.data);
        if (m.kind === "dead") { dead = true; board = null; }
        else if (m.kind === "state") {
          dead = false;
          board = m.state && m.state.board ? m.state.board : null;
          name = (m.state && m.state.name) || "";
          applyLook(m.state && m.state.look);
        } else return;
        wait = 1000;
        render();
      } catch (e) {}
    };
    ws.onclose = function () {
      clearInterval(beat);
      if (dead) return;            // 죽은 방은 다시 붙지 않습니다
      setTimeout(connect, wait);
      wait = Math.min(wait * 2, 15000);
    };
    ws.onerror = function () { try { ws.close(); } catch (e) {} };
  };

  /* 예시: 몇 초마다 한 사람에게 벌금이 붙고, 순위가 바뀌면 줄이 미끄러집니다 */
  var startDemo = function () {
    var BASE = [["주키니", 450000], ["팔복", 340000], ["읍지", 320000], ["이다", 180000],
                ["포셔", 170000], ["히휴", 110000], ["눈가루", 90000], ["티모", 60000]];
    var reset = function () {
      board = BASE.map(function (p) { return { n: p[0], g: p[1] }; });
    };
    reset();
    render();
    setInterval(function () {
      var total = board.reduce(function (a, r) { return a + r.g; }, 0);
      if (total > 4000000) reset();
      else board[Math.floor(Math.random() * board.length)].g +=
        [10000, 30000, 100000][Math.floor(Math.random() * 3)];
      render();
    }, 3200);
  };

  /* 창 크기를 바꾸면 vw 가 달라져 판 크기도 달라집니다 — 그 즉시 다시 맞춥니다 */
  if (isPreview) window.addEventListener("resize", fitPreview);

  if (isDemo) startDemo();
  else { render(); connect(); }
})();
</script>
</body>
</html>`;
