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
  /* 뷰포트에 고정해서 자릅니다 — 높이를 안 주면 overflow:hidden 이 확대 전 높이에서
     잘라, contain 으로 커진 판의 아래가 사라집니다 (OBS에서 그렇게 잘렸습니다) */
  html,body{background:transparent; overflow:hidden; width:100%; height:100%}
  body{font-family:'Segoe UI','Malgun Gothic',sans-serif; color:var(--ink)}

  /* 글자색은 판 안에서 다시 풉니다 — body 에서 굳히면 테마가 .ov 의 --ink 를
     바꿔도 이미 늦어서, 밝은 판이 밝은 글자(안 보임)로 나옵니다 */
  .ov{width:fit-content; min-width:36vw; max-width:100vw; padding:1.2vw 1.9vw 1.2vw 1.6vw;
    position:relative; will-change:transform; color:var(--ink)}
  /* 총액을 금액 열과 같은 선에 세웁니다 — 증감액 열 10.5 + 열 간격 1.6 + 줄 안쪽 여백 .4 */
  /* 총액도 금액 열과 같은 선에 — 줄 안쪽 여백(.4vw)만 빼면 됩니다 */
  .ov-head{display:flex; align-items:baseline; gap:1.6vw; margin-bottom:.5vw; padding:0 .4vw}
  .ov-name-t{flex:1; min-width:6vw; padding-right:1.6vw}
  .ov-name-t{font-size:4.2vw; font-weight:600; letter-spacing:.03em;
    overflow:hidden; text-overflow:ellipsis; white-space:nowrap}
  .ov-total{font-size:3.4vw; font-weight:600; color:var(--gold);
    font-variant-numeric:tabular-nums; white-space:nowrap; text-align:right;
    min-width:9.5vw; width:var(--goldw, auto); flex:none}
  .ov-row{display:flex; align-items:baseline; gap:1.6vw; padding:.85vw .4vw; position:relative;
    font-size:4.4vw; font-weight:500; line-height:1.2; border-radius:1vw;
    transition:transform .35s cubic-bezier(.22,1,.36,1)}
  /* 순위와 변동은 글자 크기가 달라서, 기준선 대신 줄 한가운데에 맞춥니다 */
  .ov-rank{width:5.2vw; font-size:3.6vw; opacity:.68; font-variant-numeric:tabular-nums;
    flex:none; align-self:center; text-align:center}
  /* 순위 변동 자리 — 비어 있어도 폭을 차지해서 이름 열이 밀리지 않습니다 */
  .ov-move{width:5.6vw; flex:none; font-size:2.9vw; font-weight:700; text-align:center;
    font-variant-numeric:tabular-nums; align-self:center}
  .ov-name{flex:1; min-width:6vw; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; padding-right:1.6vw}
  /* 항목은 표의 열로 세웁니다 — 이름 밑에 늘어놓으면 방송에서 안 읽힙니다.
     열이 늘면 판이 가로로 넓어집니다 (width:fit-content) */
  .ov-cnum{width:6.4vw; flex:none; text-align:center; font-size:3.4vw;
    font-variant-numeric:tabular-nums; opacity:.9}
  .ov-cnum.rl{color:var(--ink)}
  .ov-cnum.z{opacity:.16}
  .ov-chead{width:6.4vw; flex:none; text-align:center; font-size:1.6vw; opacity:.6;
    overflow:hidden; text-overflow:ellipsis; white-space:nowrap}
  .ov-chead.rl{opacity:.72}
  /* 순액 — 받을 몫에서 낸 벌금을 뺀 값. 받는 쪽은 파랑, 보내는 쪽은 빨강 */
  /* 폭은 금액 열과 같은 예산·래칫 변수 — 커진 순액이 잘리는 일이 없습니다 */
  .ov-net{flex:none; width:var(--netw, 11.5vw); text-align:right; font-size:2.9vw; font-weight:700;
    font-variant-numeric:tabular-nums; opacity:.5; white-space:nowrap; overflow:hidden}
  .ov-net.plus{color:#6fb4ff; opacity:1}
  .ov-net.minus{color:#ff7d6b; opacity:1}
  .ov-nethead{flex:none; width:var(--netw, 11.5vw); text-align:right; font-size:1.6vw; opacity:.6}
  /* 폭은 렌더마다 실측한 --goldw 를 전 줄이 공유 — 줄마다 제 금액대로 늘면 열이 어긋납니다 */
  .ov-gold{font-variant-numeric:tabular-nums; color:var(--gold); flex:none;
    text-align:right; min-width:9.5vw; width:var(--goldw, auto); white-space:nowrap}
  /* 증감액 — 금액 뒤의 고정폭 열. 판 안에 머물면서 금액 열의 오른쪽 끝은 안 밉니다 */
  /* 증감액은 이름과 금액 사이의 빈 자리에 붙습니다 — 어느 열도 밀지 않고 여백도 안 먹습니다 */
  /* 줄 전체를 기준으로 오른쪽 바깥에 답니다 — 순액 열을 덮지 않게 */
  .ov-delta{position:absolute; right:.4vw; top:50%; transform:translateY(-50%);
    white-space:nowrap;
    font-size:3.4vw; font-weight:600; color:var(--gold);
    padding:.1vw .8vw; border-radius:99px; background:rgba(20,17,14,.72)}
  /* 밝은 판·진한 글자 테마에서는 칩도 밝게 */
  html[data-t="light"] .ov-delta, html[data-t="cleardark"] .ov-delta{background:rgba(248,244,236,.85)}
  .ov-delta.plus{color:#8fd89b}
  /* 비어 있을 때는 칩 배경만 남지 않도록 아예 감춥니다 */
  .ov-delta:empty{display:none}
  .ov-row.zero{opacity:.5}

  /* 1위 — 금색 순위와 살짝 밝은 이름으로 초점을 만듭니다 */
  .ov-row.top .ov-rank{color:var(--gold); opacity:1; font-weight:700}
  .ov-row.top .ov-name{font-weight:700}

  /* 방금 벌금이 붙은 줄 — 잠깐 번쩍이고 오른쪽에 증감이 떠올랐다 사라집니다 */
  .ov-row.hit{animation:ov-flash 1.6s ease-out}
  /* 룰렛 — 보드가 아니라 소스(뷰포트) 전체를 덮습니다. 보드가 좁고 길어도
     원판은 소스 크기로 큽니다 */
  #ovspin:not(:empty){position:fixed; inset:0; z-index:3; display:flex;
    align-items:center; justify-content:center; padding:2%;
    background:rgba(12,10,8,.78);
    animation:ov-spin-in .18s ease-out}
  @keyframes ov-spin-in{from{opacity:0} to{opacity:1}}
  .ov-sp{position:relative; display:flex; width:96%; max-height:100%; text-align:center;
    border-radius:calc(var(--u)*2); color:#ece4d6;
    background:radial-gradient(120% 90% at 50% 12%, #322721 0%, #1d1712 58%, #17110d 100%);
    border:calc(var(--u)*.4) solid rgba(220,174,94,.8);
    box-shadow:inset 0 0 calc(var(--u)*8) rgba(0,0,0,.45),
      0 calc(var(--u)*2) calc(var(--u)*6) rgba(0,0,0,.5)}
  /* 늘 세로 한 줄 — 이름 줄, 원판 무대, 트랙 순서 */
  .ov-sp{flex-direction:column; align-items:center; justify-content:center;
    gap:calc(var(--u)*1.6); padding:calc(var(--u)*5) calc(var(--u)*2.4) calc(var(--u)*2.2)}
  .ov-sp-info{display:flex; flex-direction:row; align-items:baseline;
    justify-content:center; gap:calc(var(--u)*1.6); min-width:0; max-width:96%}
  /* 원판 무대 — 크기는 spinHtml 이 계산해 줍니다. 결과가 이 위에 겹칩니다 */
  .ov-stage{position:relative; flex:none; margin:calc(var(--u)*2.6) 0}
  .ov-stage-out{position:absolute; inset:0; z-index:4; display:none;
    flex-direction:column; align-items:center; justify-content:center;
    gap:calc(var(--u)*1.8); text-align:center}
  .ov-sp.over .ov-stage-out{display:flex}
  .ov-sp.over .ov-wheel,.ov-sp.over .ov-reel{opacity:.25; filter:blur(1px)}
  .ov-stage-out .ov-sp-out{height:auto; font-size:calc(var(--u)*9); color:#fff;
    text-shadow:0 calc(var(--u)*.5) calc(var(--u)*2) rgba(0,0,0,.65)}
  .ov-stage-out .ov-sp-out em{font-size:calc(var(--u)*3.4)}
  .ov-stage-out .ov-sp-delta{height:auto; font-size:calc(var(--u)*4.2)}
  .ov-sp-who{font-size:calc(var(--u)*6.2); font-weight:700; white-space:nowrap;
    overflow:hidden; text-overflow:ellipsis; max-width:100%}
  .ov-sp-item{font-size:calc(var(--u)*3.4); color:#a89a88; white-space:nowrap}
  .ov-sp-res{display:flex; flex-direction:column; align-items:center;
    gap:calc(var(--u)*1.2); min-width:0}
  /* 이번 판 트랙 — 앱과 같은 5칸. 칩과 슬롯 폭이 같아 채워져도 안 밀립니다 */
  .ov-sp-track{display:flex; gap:calc(var(--u)*1.4); justify-content:center}
  .ov-tchip,.ov-tslot{width:calc(var(--u)*11); height:calc(var(--u)*5.4);
    border-radius:99px; flex:none; display:flex; align-items:center; justify-content:center;
    font-size:calc(var(--u)*2.8); font-weight:700; overflow:hidden; white-space:nowrap}
  .ov-tchip{background:#241d18; border:1px solid rgba(220,174,94,.55)}
  .ov-tchip.pass{color:#ff9d92; border-color:#a44f46}
  .ov-tchip.mult{color:#f7b458; border-color:#b97f37}
  .ov-tslot{border:1px dashed rgba(220,174,94,.3)}
  .ov-tslot.next{border-color:rgba(220,174,94,.8);
    animation:ov-slotpulse 1s ease-in-out infinite}
  @keyframes ov-slotpulse{0%,100%{background:transparent}
    50%{background:rgba(220,174,94,.14)}}
  /* 물리 룰렛 — 바늘은 12시에 고정, 원판이 돌아 당첨 칸이 그 아래로 옵니다 */
  .ov-wheel{position:relative; width:100%; height:100%}
  /* 림 눈금 — 비율 1짜리 칸(12.857°)에 하나씩 맞는 금색 점 띠 */
  .ov-wheel::before{content:""; position:absolute; inset:calc(var(--u)*-1.8*var(--wu,1));
    border-radius:50%; pointer-events:none;
    background:repeating-conic-gradient(rgba(220,174,94,.9) 0 1.1deg,
      transparent 1.1deg 12.857deg);
    -webkit-mask:radial-gradient(circle, transparent 0 calc(var(--u)*24*var(--wu,1)),
      #000 calc(var(--u)*24*var(--wu,1)) calc(var(--u)*24.8*var(--wu,1)), transparent calc(var(--u)*24.8*var(--wu,1)));
    mask:radial-gradient(circle, transparent 0 calc(var(--u)*24*var(--wu,1)),
      #000 calc(var(--u)*24*var(--wu,1)) calc(var(--u)*24.8*var(--wu,1)), transparent calc(var(--u)*24.8*var(--wu,1)))}
  .ov-w-disc{position:absolute; inset:0; border-radius:50%;
    will-change:transform; backface-visibility:hidden; transform:translateZ(0);
    box-shadow:0 0 0 calc(var(--u)*.9*var(--wu,1)) #3a2e25, 0 0 0 calc(var(--u)*1.1*var(--wu,1)) rgba(220,174,94,.75),
      0 calc(var(--u)*1.2) calc(var(--u)*3.6) rgba(0,0,0,.55),
      inset 0 0 calc(var(--u)*3) rgba(0,0,0,.28)}
  .ov-w-pin{position:absolute; left:50%; top:calc(var(--u)*-1.7*var(--wu,1)); width:0; height:0;
    transform:translateX(-50%); z-index:2;
    border-left:calc(var(--u)*1.6*var(--wu,1)) solid transparent;
    border-right:calc(var(--u)*1.6*var(--wu,1)) solid transparent;
    border-top:calc(var(--u)*3.2*var(--wu,1)) solid #ff5a3c;
    filter:drop-shadow(0 .2vw .3vw rgba(0,0,0,.5))}
  /* 릴 창 — 숫자만 모드. 이웃 면이 위아래로 흐릿하게 스칩니다 */
  .ov-reel{position:absolute; left:50%; top:50%; transform:translate(-50%,-50%);
    width:calc(var(--u)*40*var(--wu,1)); height:calc(var(--u)*42*var(--wu,1));
    border-radius:calc(var(--u)*2);
    overflow:hidden; background:linear-gradient(#151009, #241c14 30% 70%, #151009);
    border:calc(var(--u)*.4) solid #3a2e25;
    box-shadow:0 0 0 calc(var(--u)*.3) rgba(220,174,94,.7),
      inset 0 0 calc(var(--u)*3) rgba(0,0,0,.6);
    display:flex; flex-direction:column; align-items:center; justify-content:center;
    gap:calc(var(--u)*.8)}
  .ov-reel-n{font-weight:800; line-height:1; white-space:nowrap}
  .ov-reel-n.side{font-size:calc(var(--u)*5*var(--wu,1)); color:#ece4d6; opacity:.2; filter:blur(1px)}
  .ov-reel-n.big.long{font-size:calc(var(--u)*6.5*var(--wu,1))}
  .ov-reel-n.big.longer{font-size:calc(var(--u)*4.2*var(--wu,1))}
  .ov-reel-n.big{max-width:94%; overflow:hidden; text-overflow:ellipsis;
    font-size:calc(var(--u)*11*var(--wu,1)); color:#fff;
    text-shadow:0 0 calc(var(--u)*3) rgba(220,174,94,.4)}
  .ov-reel-line{position:absolute; left:6%; right:6%; top:50%; height:calc(var(--u)*10*var(--wu,1));
    transform:translateY(-50%); pointer-events:none;
    border-top:1px solid rgba(220,174,94,.4); border-bottom:1px solid rgba(220,174,94,.4)}
  /* 안내·수식·변화 — 자리를 미리 잡아 둬 판이 안 출렁입니다 */
  .ov-sp-gone{position:absolute; left:50%; bottom:calc(var(--u)*2); z-index:5;
    transform:translateX(-50%); white-space:nowrap;
    font-size:calc(var(--u)*2.6); font-weight:700; color:#dcae5e;
    background:rgba(12,10,8,.85); border:1px solid rgba(220,174,94,.5);
    border-radius:99px; padding:calc(var(--u)*.7) calc(var(--u)*2.2)}
  .ov-sp-gone:empty{display:none}
  .ov-sp-out{font-size:calc(var(--u)*5); font-weight:800; color:#dcae5e;
    height:calc(var(--u)*6.4); display:flex; align-items:center; justify-content:center;
    overflow:hidden; white-space:nowrap}
  .ov-sp-out em{font-style:normal; font-size:calc(var(--u)*2.6); font-weight:400;
    color:#a89a88; margin-left:calc(var(--u)*1.2)}
  .ov-sp-delta{height:calc(var(--u)*3.6); font-size:calc(var(--u)*2.8); color:#a89a88;
    display:flex; align-items:center; justify-content:center; gap:calc(var(--u)*1);
    overflow:hidden; white-space:nowrap}
  .ov-sp-delta b{color:#ece4d6}
  .ov-sp-delta .up{color:#ff9d92; font-weight:700}
  .ov-sp-delta .dn{color:#7fb8ff; font-weight:700}
  /* 원판 라벨 — 원판과 함께 돕니다. 글자 끝은 림 안쪽에 고정, 방향은 중심→바깥 */
  .ov-w-lab{position:absolute; inset:0; pointer-events:none}
  .ov-w-lab i{position:absolute; right:50%; top:calc(var(--u)*1.4*var(--wu,1)); font-style:normal;
    transform:rotate(-90deg); transform-origin:right center;
    font-family:'Gowun Batang','Batang',serif; font-size:calc(var(--u)*3.4*var(--wu,1)); font-weight:800;
    color:#f4d98c; white-space:nowrap; max-width:calc(var(--u)*17*var(--wu,1));
    overflow:hidden; text-overflow:ellipsis;
    text-shadow:-1px 0 0 #241206, 1px 0 0 #241206, 0 -1px 0 #241206, 0 1px 0 #241206,
      0 1px 3px rgba(0,0,0,.4)}
  /* 중앙 허브 — 축은 늘 있고, 멈추면 값이 그 안에 뜹니다 */
  .ov-w-hub{position:absolute; left:50%; top:50%; transform:translate(-50%,-50%);
    width:calc(var(--u)*13*var(--wu,1)); height:calc(var(--u)*13*var(--wu,1)); border-radius:50%; z-index:2;
    pointer-events:none;
    background:radial-gradient(circle at 34% 30%, #4a3c30, #241d17 70%);
    border:calc(var(--u)*.35) solid #dcae5e;
    box-shadow:0 calc(var(--u)*.4) calc(var(--u)*1.2) rgba(0,0,0,.5);
    display:flex; align-items:center; justify-content:center; overflow:hidden}
  .ov-w-hit{color:#fff; font-size:calc(var(--u)*5.2*var(--wu,1)); font-weight:800; line-height:1;
    white-space:nowrap; max-width:92%; overflow:hidden; text-overflow:ellipsis; opacity:0}
  .ov-w-hit.q{opacity:.4; color:#8a7a66; font-size:calc(var(--u)*4*var(--wu,1))}
  .ov-w-hit.long{font-size:calc(var(--u)*2.4*var(--wu,1))}
  .ov-w-hit.on{animation:ov-hitpop .28s cubic-bezier(.2,1.5,.4,1) forwards}
  @keyframes ov-hitpop{from{transform:scale(.4); opacity:0}
    to{transform:scale(1); opacity:1}}
  @keyframes ov-flash{
    from{background:rgba(232,198,106,.28)}
    to{background:transparent}
  }
  .ov-delta.plus,.ov-delta.minus{animation:ov-rise 4.2s ease-out forwards}
  .ov-delta.minus{color:#e0776b}
  @keyframes ov-rise{
    0%{opacity:0; transform:translateY(calc(-50% + .7vw))}
    9%{opacity:1; transform:translateY(-50%)}
    80%{opacity:1; transform:translateY(-50%)}
    100%{opacity:0; transform:translateY(calc(-50% - .7vw))}
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
  /* 소스 나누기 — board 는 현황판만, spin 은 룰렛만 그립니다. 없으면 둘 다.
     파일은 하나고 분기만 다릅니다 — 소스마다 딴 페이지를 만들 이유가 없어요. */
  var TYPE = q.get("type") === "board" ? "board" : q.get("type") === "spin" ? "spin" : "all";
  /* 방송 프로그램 판별 — OBS 계열은 obsstudio 객체, 그 외에는 UA 토큰으로 잡습니다.
     (OBS·Streamlabs: " OBS/29.0.2" / XSplit: "XSplitBroadcaster/4.x").
     못 잡는 프로그램은 주소 뒤 ?mode=overlay 로 수동 강제합니다. */
  var ua = navigator.userAgent || "";
  var inCast = !!window.obsstudio || ua.indexOf(" OBS/") >= 0 || ua.indexOf("XSplitBroadcaster/") >= 0;
  var inOBS = forced === "overlay" || (forced !== "page" && inCast);

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
  var board = null;   // [{n,g,c}] — 앱이 계산해서 보내줍니다
  var cols = [];      // [{t,r}] — 항목 열 머리
  var showNet = true; // 순액 열을 켤지 (기본 켬)
  var pend = null;    // 룰렛이 도는 동안 도착한 표 (끝나고 반영)
  var spin = null;      // 앱이 보낸 판 (한 번에 통째로)
  var play = null;      // 방송이 제 시계로 재생하는 상태
  var spinTimer = null; // 도는 글자
  var stepTimer = null; // 다음 걸음
  /* 속도는 판마다 옵니다. 앱·방송·파티원 화면이 같은 속도로 돌아야 따로 놀지 않습니다 */
  var SPINS = {
    fast: { roll: 1200, hold: 700, end: 1100 },
    normal: { roll: 2200, hold: 1200, end: 1700 },
    slow: { roll: 3400, hold: 1700, end: 2200 },
  };
  var OV_ROLL = 2200, OV_HOLD = 1200, OV_END = 1700;
  var useSpeed = function (sp) {
    var v = SPINS[(sp && sp.spd) || "normal"] || SPINS.normal;
    OV_ROLL = v.roll; OV_HOLD = v.hold; OV_END = v.end;
  };
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

  /* 방송 표기 사다리 — 클수록 정밀도를 내려놓아 글자 수에 상한(5자)을 둡니다.
     5,000 / 2.5만 / 53.5만 / 532만 / 9999만 / 4.6억 / 12억.
     숫자가 자라도 열 폭이 못 자라게 하는 장치입니다 — 판 축소·잘림 방지 */
  var manShort = function (g) {
    g = Math.round(g || 0);
    var neg = g < 0;
    g = Math.abs(g);
    var out;
    if (g < 10000) out = g.toLocaleString("ko-KR");
    else if (g < 1000000) {
      var v = Math.round(g / 1000) / 10;
      out = (v % 1 === 0 ? String(v) : v.toFixed(1)) + "만";
    } else if (g < 100000000) {
      out = Math.floor(g / 10000) + "만"; // 소수점은 버림(532.5만 → 532만), 콤마 없이 — 9999만이 상한
    } else if (g < 1000000000) {
      var b = Math.round(g / 10000000) / 10;
      out = (b % 1 === 0 ? String(b) : b.toFixed(1)) + "억";
    } else {
      out = Math.floor(g / 100000000) + "억"; // 정수 단은 버림으로 통일
    }
    return (neg ? "\u2212" : "") + out;
  };

  /* 순위: 금액 내림차순, 동률은 표에 적힌 순서 유지 */
  var ranked = function (rows) {
    return rows.map(function (r, i) {
      return { n: r.n, g: r.g || 0, c: r.c || [], d: r.d || 0, i: i };
    })
      .sort(function (a, b) { return b.g - a.g || a.i - b.i; });
  };

  var esc = function (t) {
    return String(t == null ? "" : t).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  };

  /* 금액·순액 열 폭 — 예산("999만"/"−999만")으로 시작해, 실제 표기가 예산을 넘는
     순간 한 번만 넓어지고 다시는 안 좁아집니다(래칫). 모든 줄이 같은 폭을 쓰므로
     줄 사이가 어긋나지 않고, 숫자가 자라도 판이 축소되지 않습니다. */
  var goldHW = 0,
    netHW = 0;
  var setGoldW = function (rows) {
    var box = document.querySelector(".ov");
    if (!box) return;
    var wrap = document.createElement("div");
    wrap.className = "ov-row";
    wrap.style.cssText = "position:absolute; visibility:hidden; pointer-events:none";
    var probe = document.createElement("span");
    probe.className = "ov-gold";
    probe.style.cssText = "width:auto; min-width:0";
    var nprobe = document.createElement("span");
    nprobe.className = "ov-net";
    nprobe.style.cssText = "width:auto; min-width:0";
    wrap.appendChild(probe);
    wrap.appendChild(nprobe);
    box.appendChild(wrap);
    var mw = function (el, t) {
      el.textContent = t;
      return el.offsetWidth;
    };
    var w = mw(probe, "999만");
    var nw = mw(nprobe, "\u2212999만");
    var total = 0;
    rows.forEach(function (r) {
      total += r.g || 0;
      w = Math.max(w, mw(probe, manShort(r.g)));
      nw = Math.max(nw, mw(nprobe, (r.d > 0 ? "+" : "") + manShort(r.d || 0)));
    });
    w = Math.max(w, mw(probe, manShort(total)));
    box.removeChild(wrap);
    goldHW = Math.max(goldHW, w);
    netHW = Math.max(netHW, nw);
    box.style.setProperty("--goldw", goldHW + "px");
    box.style.setProperty("--netw", netHW + "px");
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
        cols.map(function (c, ci) {
          var v = (r.c || [])[ci] || 0;
          return '<span class="ov-cnum' + (c.r ? ' rl' : '') + (v ? '' : ' z') + '">' +
            (v ? esc(v) : '') + '</span>';
        }).join('') +
        '<span class="ov-gold">' + manShort(r.g) +
          '<span class="ov-delta ' + (showD ? (rc.d > 0 ? "plus" : "minus") : "") + '"' +
            (showD ? delay(dAge) : "") + '>' +
            (showD ? (rc.d > 0 ? "+" : "−") + manShort(Math.abs(rc.d)) : "") + '</span>' +
        '</span>' +
        (showNet
          ? '<span class="ov-net ' + (r.d > 0 ? "plus" : r.d < 0 ? "minus" : "") + '">' +
              (r.d > 0 ? "+" : "") + manShort(r.d) + '</span>'
          : '') + '</div>';
    }).join("");

    prev = {};
    list.forEach(function (r, i) { prev[r.n] = { g: r.g, rank: i + 1 }; });
    return html;
  };

  var faceTimer = null; // 숫자 모드에서 글자가 바뀌는 타이머
  /* 숫자만 보여주는 모드에서 면이 빠르게 바뀌게 합니다 */
  var rollFace = function (pl) {
    if (faceTimer) { clearInterval(faceTimer); faceTimer = null; }
    if (!pl || pl.sp.look !== "num" || !pl.rolling) return;
    var t = 0;
    var fs2 = pl.sp.faces && pl.sp.faces.length ? pl.sp.faces : ["1"];
    faceTimer = setInterval(function () {
      var el = document.getElementById("ovface");
      if (!el) { clearInterval(faceTimer); faceTimer = null; return; }
      var i = t++ % fs2.length;
      el.textContent = faceLabel(fs2[i]);
      var pv = document.getElementById("ovprev");
      var nx = document.getElementById("ovnext");
      if (pv) pv.textContent = faceLabel(fs2[(i - 1 + fs2.length) % fs2.length]);
      if (nx) nx.textContent = faceLabel(fs2[(i + 1) % fs2.length]);
    }, 80);
  };
  var playKey = null;   // 지금 그려 둔 판
  var doneSid = null;   // 이미 끝까지 재생한 판 — 늦게 온 푸시가 같은 판을 또 돌리지 않게
  var wheelRot = 0;     // 원판이 지금까지 돈 각도 (앞으로만 돕니다)
  var clearPlayTimers = function () {
    if (stepTimer) { clearTimeout(stepTimer); stepTimer = null; }
    if (faceTimer) { clearInterval(faceTimer); faceTimer = null; }
  };

  /* 판 전체를 새로 그리면 원판이 처음부터 다시 돕니다 — 새 판일 때만 다시 그리고,
     같은 판에서는 글자만 갈아 끼웁니다. */
  /* 멈춘 순간의 값을 원판 한가운데에 띄웁니다 (도는 동안엔 비웁니다) */
  var hitKey = null;
  /* 같은 걸음에서 다시 그릴 때 등장 동작을 또 태우면 숫자가 깜빡입니다.
     걸음이 바뀔 때만 새로 태웁니다. */
  var drawHit = function () {
    var el = document.getElementById("ovhit");
    if (!el || !play) return;
    if (play.who) return; // 사람 원판은 제 값을 따로 넣습니다
    var key = play.sp.sid + ":" + play.i + ":" + (play.rolling ? "r" : "s");
    if (key === hitKey) return;
    hitKey = key;
    if (play.rolling) { el.textContent = "?"; el.className = "ov-w-hit q"; return; }
    /* 원판이 완전히 멈춘 뒤에 띄웁니다 — 같이 띄우면 바늘과 숫자가 어긋나 보입니다 */
    var txt = faceLabel(play.sp.steps[play.i].k);
    setTimeout(function () {
      var e2 = document.getElementById("ovhit");
      if (!e2 || !play || play.rolling) return;
      e2.textContent = txt;
      e2.className = "ov-w-hit" + (String(txt).length > 2 ? " long" : "");
      void e2.offsetWidth;
      e2.classList.add("on");
    }, 200);
  };
  var drawPlay = function () {
    var sbox = document.getElementById("ovspin");
    if (!sbox) return;
    if (!play) { sbox.innerHTML = ""; playKey = null; return; }
    if (playKey !== play.sp.sid && !play.who) {
      playKey = play.sp.sid;
      wheelRot = 0;
      hitKey = null;
      sbox.innerHTML = spinHtml(play);
      drawHit();
    } else {
      var box = sbox.querySelector(".ov-sp");
      if (box) {
        var sp = play.sp;
        /* 결과 순간 — 원판이 뒤로 물러나고 결과가 무대 가운데에 뜹니다 */
        box.classList.toggle("over", !!play.over);
        /* 트랙 — 채워진 만큼 다시 그립니다 (슬롯 위치는 고정이라 안 밀립니다) */
        var tr = box.querySelector(".ov-sp-track");
        if (tr)
          tr.outerHTML = trackHtml(sp, play.i, !!play.rolling && !play.who, play.who === "roll");
        var it = document.getElementById("ovitem");
        if (it) it.textContent = play.who ? "누가 물까요?" : sp.item;
        var gone = document.getElementById("ovgone");
        if (gone)
          gone.textContent =
            !play.who && passGone(sp, play.i) ? "양도권은 한 판에 한 번이라 룰렛에서 빠졌어요" : "";
        /* 릴 — 멈추면 가운데에 나온 면, 위아래에 원판상의 이웃 면 */
        if (sp.look === "num" && !play.who && !play.rolling) {
          var f = document.getElementById("ovface");
          var pool = poolAt(sp, play.i);
          var k = sp.steps[play.i].k;
          var at = Math.max(0, pool.indexOf(k));
          if (f) f.textContent = faceLabel(k);
          var pv = document.getElementById("ovprev");
          var nx = document.getElementById("ovnext");
          if (pv) pv.textContent = faceLabel(pool[(at - 1 + pool.length) % pool.length]);
          if (nx) nx.textContent = faceLabel(pool[(at + 1) % pool.length]);
        }
        /* 결과 — 수식과 벌금 변화. 표가 아직 안 왔으면 원값으로 적고, 오면 채웁니다 */
        var out = document.getElementById("ovout");
        var dl = document.getElementById("ovdelta");
        if (play.over) {
          var info = outInfo(sp);
          var multF = 1;
          sp.steps.forEach(function (x) { if (x.m > 1) multF = x.m; });
          if (out)
            out.innerHTML =
              esc(faceLabel(String(sp.n))) +
              (multF > 1 ? " \u00d7" + esc(multF) : "") +
              " = " + man(info.applied) +
              (info.cut ? "<em>벌금까지만</em>" : "") +
              (info.target && info.target !== sp.who
                ? "<em>" + esc(info.target) + "에게</em>"
                : "");
          if (dl)
            dl.innerHTML =
              info.target != null && info.oldG != null
                ? "<b>" + esc(info.target) + "</b> " + man(info.oldG) +
                  ' <span class="' + (info.applied >= 0 ? "up" : "dn") + '">' +
                  "\u2192 " + man(info.newG) + "</span>"
                : "";
        } else {
          if (out) out.textContent = "";
          if (dl) dl.textContent = "";
        }
      }
      drawHit();
    }
  };

  /* 한 걸음 굴립니다. 원판은 앞으로만, 걸음마다 두 바퀴 넘게 더 돌게 목표를 올립니다 */
  var rollStep = function () {
    if (!play) return;
    if (play.sp.look === "num") rollFace(play);
    else spinTo(poolAt(play.sp, play.i), play.sp.w, play.sp.steps[play.i].k);
  };

  /* 양도권은 한 판에 한 번뿐 — 이미 나왔으면 그 뒤 회차의 원판에서 뺍니다 */
  var poolAt = function (sp, i) {
    var gone = sp.steps.slice(0, i).some(function (x) { return x.k === "pass"; });
    return gone ? sp.faces.filter(function (f) { return f !== "pass"; }) : sp.faces;
  };
  var passGone = function (sp, i) {
    return sp.steps.slice(0, i).some(function (x) { return x.k === "pass"; });
  };

  /* 랜덤 양도면 사람 원판을 한 번 더 돌립니다 */
  var whoWheel = function (pl) {
    var sp = pl.sp;
    var el = document.getElementById("ovspin");
    if (!el) return;
    var box = el.querySelector(".ov-sp");
    if (!box) return;
    var it = document.getElementById("ovitem");
    if (it) it.textContent = "누가 물까요?";
    if (sp.look === "num") {
      /* 숫자만 모드는 사람도 릴 — 이름이 이웃과 함께 스칩니다 */
      rollNames(sp.pass2.faces);
      return;
    }
    var wrap = box.querySelector(".ov-wheel") || box.querySelector(".ov-reel");
    if (wrap) {
      wrap.outerHTML = wheelHtml(sp.pass2.faces, {}, sp.theme);
      wheelRot = 0;
      hitKey = null;
    }
  };

  /* 릴에 아무 목록이나 돌립니다 — 사람 차례에는 이름 목록을 넣습니다 */
  var rollNames = function (list) {
    if (faceTimer) { clearInterval(faceTimer); faceTimer = null; }
    var t = 0;
    var fit = function (el, txt) {
      if (!el) return;
      el.textContent = txt;
      el.classList.remove("long", "longer");
      if (String(txt).length > 3) el.classList.add("longer");
      else if (String(txt).length > 2) el.classList.add("long");
    };
    faceTimer = setInterval(function () {
      var el = document.getElementById("ovface");
      if (!el) { clearInterval(faceTimer); faceTimer = null; return; }
      var i = t++ % list.length;
      fit(el, list[i]);
      fit(document.getElementById("ovprev"), list[(i - 1 + list.length) % list.length]);
      fit(document.getElementById("ovnext"), list[(i + 1) % list.length]);
    }, 80);
  };

  var stepPlay = function () {
    if (!play) return;
    if (play.rolling) {
      play.rolling = false;
      if (faceTimer) { clearInterval(faceTimer); faceTimer = null; }
      drawPlay();
      stepTimer = setTimeout(stepPlay, OV_HOLD);
      return;
    }
    if (play.i + 1 < play.sp.steps.length) {
      var was = poolAt(play.sp, play.i).length;
      play.i += 1;
      drawPlay();
      /* 후보가 줄었으면 원판을 새로 그립니다 (칸 수가 달라집니다) */
      if (poolAt(play.sp, play.i).length !== was) {
        var box = document.querySelector("#ovspin .ov-wheel");
        if (box) {
          box.outerHTML = wheelHtml(poolAt(play.sp, play.i), play.sp.w, play.sp.theme);
          wheelRot = 0;
          hitKey = null;
        }
      }
      play.rolling = true;
      rollStep();
      stepTimer = setTimeout(stepPlay, OV_ROLL);
      return;
    }
    /* 랜덤 양도 — 사람 원판을 한 번 더 */
    if (play.sp.pass2 && !play.who) {
      play.who = "roll";
      whoWheel(play);
      if (play.sp.look !== "num")
        spinTo(play.sp.pass2.faces, {}, play.sp.pass2.name);
      stepTimer = setTimeout(stepPlay, OV_ROLL);
      return;
    }
    if (play.who === "roll") {
      play.who = "land";
      if (play.sp.look === "num") {
        /* 이름 릴 정지 — 가운데에 뽑힌 이름, 위아래엔 이웃 */
        if (faceTimer) { clearInterval(faceTimer); faceTimer = null; }
        (function (sp) {
          var nm2 = sp.pass2.faces;
          var at = Math.max(0, nm2.indexOf(sp.pass2.name));
          var fit = function (el, txt) {
            if (!el) return;
            el.textContent = txt;
            el.classList.remove("long", "longer");
            if (String(txt).length > 3) el.classList.add("longer");
            else if (String(txt).length > 2) el.classList.add("long");
          };
          fit(document.getElementById("ovface"), sp.pass2.name);
          fit(document.getElementById("ovprev"), nm2[(at - 1 + nm2.length) % nm2.length]);
          fit(document.getElementById("ovnext"), nm2[(at + 1) % nm2.length]);
        })(play.sp);
      } else {
        (function (nm) {
          setTimeout(function () {
            var hit = document.getElementById("ovhit");
            if (!hit) return;
            hit.textContent = nm;
            hit.className = "ov-w-hit" + (String(nm).length > 2 ? " long" : "");
            void hit.offsetWidth;
            hit.classList.add("on");
          }, 200);
        })(play.sp.pass2.name);
      }
      stepTimer = setTimeout(stepPlay, OV_HOLD);
      return;
    }
    if (!play.over) {
      play.over = true;
      drawPlay();
      stepTimer = setTimeout(stepPlay, OV_END);
      return;
    }
    /* 양도 대기 중이면 서기가 고를 때까지 결과를 띄워 둡니다 */
    if (play.sp && play.sp.phase === "pick" && spin) {
      stepTimer = setTimeout(stepPlay, 400);
      return;
    }
    /* 적용 결과(out)나 새 표(pend)가 아직이면 결과 화면을 붙잡습니다 — 앱 탭이
       느려져(백그라운드 스로틀 등) 오버레이가 먼저 끝나면 벌금 변화가 못 뜹니다 */
    if (spin && spin.sid === play.sp.sid && !play.sp.out && !pend) {
      play.waited = true;
      stepTimer = setTimeout(stepPlay, 300);
      return;
    }
    /* 기다렸다 받았으면 채워진 결과를 한 박자 보여 주고 닫습니다 */
    if (play.waited && !play.lastHold) {
      play.lastHold = true;
      drawPlay();
      stepTimer = setTimeout(stepPlay, OV_HOLD);
      return;
    }
    doneSid = play.sp.sid;
    play = null;
    drawPlay();
    if (pend) {
      board = pend.board;
      cols = pend.cols;
      showNet = pend.net;
      pend = null;
      render();
    }
  };

  var startPlay = function (sp) {
    clearPlayTimers();
    useSpeed(sp);
    play = { sp: sp, i: 0, rolling: true, over: false };
    drawPlay();
    rollStep();
    stepTimer = setTimeout(stepPlay, OV_ROLL);
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
  /* 이 파일은 통째로 템플릿 문자열이라 홑백슬래시는 해석 단계에서 먹힙니다 —
     정규식의 \\d 처럼 두 겹으로 적어야 페이지에 \d 로 도착합니다. */
  var isMult = function (k) { return /^x\\d+$/.test(k || ""); };
  var faceLabel = function (k) {
    /* 음수 면은 앱과 같은 빼기표로 그립니다 */
    return k === "pass"
      ? "양도권"
      : isMult(k)
      ? "\u00d7" + String(k).slice(1)
      : String(k).replace(/^-/, "\u2212");
  };
  /* 칸 색 — 새틴(기본)은 면마다 고유색, 카지노는 빨강·검정 교대 (앱과 같은 규칙) */
  var NUM_COLORS = ["#3c86ba", "#3f9c72", "#d9a83e", "#9a5fd0",
                    "#3596bd", "#d97f75", "#5fae70", "#8e97d8"];
  var faceColor = function (k, i, theme) {
    if (theme === "vegas") {
      if (k === "pass") return "#5c1e66";
      if (k === "20") return "#146b3a";
      return i % 2 ? "#17171c" : "#a3202b";
    }
    if (k === "pass") return "#c8493e";
    if (isMult(k)) return "#cf7b16";
    return NUM_COLORS[i % NUM_COLORS.length];
  };
  /* 분리선 든 원뿔 그러데이션 + 새틴/광 겹 — 아주 좁은 칸(3° 미만)엔 선 생략 */
  var wheelStops2 = function (segs, theme) {
    var sep = theme === "vegas" ? "#d4b25e" : "#2a1f16";
    return segs.map(function (x) {
      var arc = x.to - x.from;
      if (arc < 3) return x.color + " " + x.from.toFixed(2) + "deg " + x.to.toFixed(2) + "deg";
      return sep + " " + x.from.toFixed(2) + "deg " + (x.from + 0.8).toFixed(2) + "deg," +
        x.color + " " + (x.from + 0.8).toFixed(2) + "deg " + (x.to - 0.8).toFixed(2) + "deg," +
        sep + " " + (x.to - 0.8).toFixed(2) + "deg " + x.to.toFixed(2) + "deg";
    }).join(",");
  };
  var wheelLayers2 = function (stops, theme) {
    return (theme === "satin"
      ? "radial-gradient(circle, transparent 0 63%, rgba(18,12,8,.42) 66% 96%, transparent 97%),"
      : "") +
      "radial-gradient(120% 90% at 32% 22%, rgba(255,255,255,.13), transparent 46%)," +
      "radial-gradient(circle, rgba(0,0,0,.36) 0 15%, rgba(0,0,0,.10) 34%, transparent 50% 72%, rgba(0,0,0,.20) 96%)," +
      "conic-gradient(" + stops + ")";
  };
  /* 칸을 비율만큼 나눕니다 — 잘 나오는 면이 넓어야 원판이 정직합니다 */
  var wheelArcs = function (faces, weights, theme) {
    weights = weights || {};
    var ws = faces.map(function (k) { return Math.max(0, Number(weights[k]) || 0); });
    var tot = ws.reduce(function (x, y) { return x + y; }, 0);
    var at = 0;
    return faces.map(function (k, i) {
      var arc = tot > 0 ? (ws[i] / tot) * 360 : 360 / faces.length;
      var seg = { k: k, from: at, to: at + arc, mid: at + arc / 2, color: faceColor(k, i, theme) };
      at += arc;
      return seg;
    });
  };

  /* 물리 룰렛 원판. 칸을 원뿔 그러데이션으로 그리고 글자는 칸 가운데에 세웁니다.
     바늘은 위(12시)에 고정이고, 원판이 돌아 그 아래로 당첨 칸이 옵니다. */
  var wheelHtml = function (faces, weights, theme) {
    var segs = wheelArcs(faces, weights, theme);
    var labs = segs.map(function (x) {
      return '<span class="ov-w-lab" style="transform:rotate(' + x.mid.toFixed(2) + 'deg)">' +
        "<i>" + esc(faceLabel(x.k)) + "</i></span>";
    }).join("");
    return '<div class="ov-wheel"><div class="ov-w-disc" id="ovdisc" style="background:' +
      wheelLayers2(wheelStops2(segs, theme), theme) + '">' + labs + "</div>" +
      '<span class="ov-w-hub"><span class="ov-w-hit q" id="ovhit">?</span></span>' +
      '<div class="ov-w-pin"></div></div>';
  };

  /* 도는 모습은 여기서 스스로 돌립니다 — 앱은 "도는 중인지"와 "선 면"만 보냅니다.
     그래야 70ms 마다 서버로 밀어 올리지 않아도 됩니다. */
  /* 방송에서는 한눈에 읽혀야 합니다 — 가운데는 지금 나온 면 하나,
     쌓인 배수는 모서리에 ×2 → ×4 → ×8 로, 양도권은 붉게. 지나온 면은 안 늘어놓습니다. */
  /* 재생 중인 한 판. 걸음은 오버레이가 셉니다 — 서기가 앱에서 건너뛰어도
     방송의 속도감은 그대로 남습니다. */
  /* 이번 판 트랙 — 앱과 같은 5칸. 나온 면이 왼쪽부터 채우고, 다음 칸이 깜빡입니다 */
  var trackHtml = function (sp, i, rolling, whoRolling) {
    var seen = sp.steps.slice(0, i + (rolling ? 0 : 1));
    var slots = Math.max(5, seen.length);
    var h = "";
    for (var j = 0; j < slots; j++) {
      if (seen[j]) {
        var k = seen[j].k;
        h += '<span class="ov-tchip' +
          (k === "pass" ? " pass" : isMult(k) ? " mult" : "") + '">' +
          esc(faceLabel(k)) + "</span>";
      } else {
        h += '<span class="ov-tslot' +
          (j === seen.length && (rolling || whoRolling) ? " next" : "") + '"></span>';
      }
    }
    return '<div class="ov-sp-track">' + h + "</div>";
  };

  /* 카드는 판 사각형 안에 앉습니다. 크기 단위 --u 는 판 짧은 변의 1% — 판이 contain 으로
     커지고 작아질 때 카드도 그대로 따라갑니다. 배치는 늘 세로 한 줄(이름·원판·트랙) —
     원판이 주인공이라, 이름 줄·트랙·여백을 뺀 나머지를 전부 원판에 줍니다(최대 72u). */
  var spinHtml = function (pl) {
    var sp = pl.sp;
    var bw = window.innerWidth || 400;
    var bh = window.innerHeight || 400;
    var u = Math.min(bw, bh) / 100;
    var W = bw / u, H = bh / u;
    var wu = Math.max(30, Math.min(72, H - 34, W - 10));
    var sz = (wu * u).toFixed(1);
    var stage = sp.look === "num"
      ? '<div class="ov-reel"><span class="ov-reel-line"></span>' +
        '<b class="ov-reel-n side" id="ovprev"></b>' +
        '<b class="ov-reel-n big" id="ovface">?</b>' +
        '<b class="ov-reel-n side" id="ovnext"></b></div>'
      : wheelHtml(poolAt(sp, pl.i), sp.w, sp.theme);
    return '<div class="ov-sp v' + (pl.over ? " over" : "") + '" style="--u:' + u.toFixed(2) + 'px">' +
      '<div class="ov-sp-info">' +
        '<span class="ov-sp-who" id="ovwho">' + esc(sp.who) + "</span>" +
        '<span class="ov-sp-item" id="ovitem">' + esc(sp.item) + "</span>" +
      "</div>" +
      '<div class="ov-stage" style="width:' + sz + "px; height:" + sz + 'px; --wu:' + (wu / 46).toFixed(3) + '">' +
        stage +
        /* 결과는 무대 위에 겹쳐 뜹니다 — 트랙을 밀거나 덮지 않습니다 */
        '<div class="ov-stage-out">' +
          '<div class="ov-sp-out" id="ovout"></div>' +
          '<div class="ov-sp-delta" id="ovdelta"></div>' +
        "</div>" +
        '<div class="ov-sp-gone" id="ovgone"></div>' +
      "</div>" +
      '<div class="ov-sp-res" id="ovres">' +
        trackHtml(sp, pl.i, pl.rolling, false) +
      "</div></div>";
  };

  /* 결과 줄 — 실제 깎이거나 붙은 값은 표(pend)와의 차로 잽니다. 잘린 감면이면
     "벌금까지만"을 덧붙입니다. 대상은 금액이 변한 줄에서 찾습니다(지정 양도 포함). */
  var outInfo = function (sp) {
    /* 앱이 적용 결과를 실어 보냈으면 그걸 씁니다 — 표 diff 는 그물일 뿐입니다 */
    if (sp.out) {
      return {
        target: sp.out.name,
        oldG: sp.out.after - sp.out.g,
        newG: sp.out.after,
        applied: sp.out.g,
        cut: sp.out.raw < 0 && sp.out.g !== sp.out.raw,
      };
    }
    var oldB = board || [];
    var newB = pend && pend.board ? pend.board : null;
    var target = null, oldG = null, newG = null;
    if (newB) {
      for (var i = 0; i < newB.length; i++) {
        var o = null;
        for (var j = 0; j < oldB.length; j++)
          if (oldB[j].n === newB[i].n) { o = oldB[j]; break; }
        if (o && o.g !== newB[i].g) { target = newB[i].n; oldG = o.g; newG = newB[i].g; break; }
      }
    }
    if (target == null && sp.pass2) target = sp.pass2.name;
    var applied = oldG != null && newG != null ? newG - oldG : sp.gold;
    return {
      target: target,
      oldG: oldG, newG: newG, applied: applied,
      cut: sp.gold < 0 && applied !== sp.gold,
    };
  };

  /* 당첨 칸이 12시 바늘 아래로 오도록 원판을 돌립니다. 걸음마다 몇 바퀴 더 얹습니다 */
  var spinTo = function (faces, weights, k) {
    var el = document.getElementById("ovdisc");
    if (!el) return;
    var segs = wheelArcs(faces, weights);
    var seg = null;
    for (var i = 0; i < segs.length; i++) if (segs[i].k === k) seg = segs[i];
    if (!seg) seg = segs[0];
    /* 지금 각도보다 항상 앞에 있는 목표를 고릅니다 — 뒤로 감기면 어색합니다 */
    var from = wheelRot;
    var target = wheelRot + 720 - seg.mid;
    while (target <= wheelRot + 360) target += 360;
    wheelRot = target;
    /* 시작 각도를 전환 없이 먼저 못 박고, 강제로 한 번 계산시킨 뒤 목표를 줍니다.
       프레임 콜백을 기다리지 않아 OBS 브라우저 소스에서도 확실히 돕니다. */
    el.style.transition = "none";
    el.style.transform = "rotate(" + from.toFixed(2) + "deg)";
    void el.offsetWidth;
    el.style.transition = "transform " + OV_ROLL + "ms cubic-bezier(.16,.9,.28,1)";
    el.style.transform = "rotate(" + target.toFixed(2) + "deg)";
  };

  var render = function () {
    /* 룰렛 전용 소스 — 보드도 알림도 안 그립니다. 판이 없으면 그냥 투명입니다 */
    if (TYPE === "spin") {
      if (!document.getElementById("ovspin")) app.innerHTML = '<div id="ovspin"></div>';
      if (spin && spin.sid !== doneSid && (!play || play.sp.sid !== spin.sid)) startPlay(spin);
      else if (play) play.sp = spin || play.sp;
      drawPlay();
      return;
    }
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
      app.innerHTML = '<div class="ov"><div class="ov-head" id="ovhead"></div>' +
        '<div id="ovboard"></div></div><div id="ovspin"></div>';
      ovBoard = document.getElementById("ovboard");
      setGoldW(board);
      ovBoard.innerHTML = rowsHtml(board);
    } else {
      setGoldW(board);
      flip(ovBoard, function () { ovBoard.innerHTML = rowsHtml(board); });
    }
    /* 룰렛 판 — 새 판이 오면 재생을 시작하고, 그 뒤로는 제 시계로 굴립니다.
       현황판 전용 소스는 판을 안 돌립니다 — 증감 칩이 표에서 결과를 대신 말해요 */
    if (TYPE !== "board") {
      if (spin && spin.sid !== doneSid && (!play || play.sp.sid !== spin.sid)) startPlay(spin);
      else if (play) play.sp = spin || play.sp; // 양도 대기 여부만 갱신
      drawPlay();
    }
    /* 오버레이 제목은 파티명이 아니라 '벌금표' — 방송 화면에 뜨는 건 표지판이지 명패가 아닙니다 */
    /* 항목 이름은 머리줄에 한 번만 — 줄마다 되뇌면 방송에서 읽히지 않습니다.
       칸 구성은 본문 줄과 하나하나 같아야 열이 맞습니다 */
    document.getElementById("ovhead").innerHTML =
      '<span class="ov-rank"></span><span class="ov-move"></span>' +
      '<span class="ov-name-t">벌금표</span>' +
      cols.map(function (c) {
        return '<span class="ov-chead' + (c.r ? " rl" : "") + '">' +
          (c.r ? "\u25ce" : "") + esc(c.t) + "</span>";
      }).join("") +
      '<span class="ov-total">' +
      manShort(board.reduce(function (a, r) { return a + (r.g || 0); }, 0)) + "</span>" +
      (showNet ? '<span class="ov-nethead">순액</span>' : "");
    fitBoard();
  };

  /* 판을 소스에 contain 으로 앉힙니다 — 비율을 지키며 먼저 닿는 쪽까지 확대하고
     가운데 정렬. 소스 사각형 = 판이라는 위젯의 관행을 따릅니다. 판의 원래 크기는
     transform 이 안 건드는 offset 치수로 잽니다. */
  var fitted = false;
  var fitBoard = function () {
    var el = document.querySelector(".ov");
    if (!el) return;
    var w = el.offsetWidth, h = el.offsetHeight;
    if (!w || !h) return;
    var scale = Math.min(window.innerWidth / w, window.innerHeight / h);
    el.style.transformOrigin = "top left";
    el.style.transform =
      "translate(" + (window.innerWidth - w * scale) / 2 + "px," +
      (window.innerHeight - h * scale) / 2 + "px) scale(" + scale + ")";
    /* 첫 배치는 튀지 않게 전환 없이, 그 뒤(인원·열 변경)부터 부드럽게 */
    /* 미리보기 팝업만: 처음 한 번 창 높이를 판에 맞춰 남는 여백을 없앱니다 */
    if (isPreview && !fitted && window.opener) {
      fitted = true;
      var want = Math.round(h * (window.innerWidth / w));
      if (want > 0 && Math.abs(want - window.innerHeight) > 8)
        window.resizeBy(0, want - window.innerHeight);
    }
  };
  var fitPreview = fitBoard;

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
        if (m.kind === "dead") { dead = true; board = null; spin = null; play = null; pend = null; }
        else if (m.kind === "state") {
          dead = false;
          var nb = m.state && m.state.board ? m.state.board : null;
          var nc = (m.state && m.state.cols) || [];
          var nn = !(m.state && m.state.ovNet === false);
          /* 도는 동안 온 표는 담아 두었다가 재생이 끝나고 보여 줍니다 — 안 그러면
             바늘이 멈추기 전에 뒤의 금액이 먼저 바뀌어 답이 새어 나갑니다 */
          if (play) pend = { board: nb, cols: nc, net: nn };
          else { board = nb; cols = nc; showNet = nn; pend = null; }
          spin = m.state && m.state.spin ? m.state.spin : null;
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
  window.addEventListener("resize", fitBoard);

  if (isDemo) startDemo();
  else { render(); connect(); }
})();
</script>
</body>
</html>`;
