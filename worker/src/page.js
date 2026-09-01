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
  /* position:relative — 밑의 구분선(::after)이 판 전체가 아니라 이 줄에 붙게 */
  .ov-head{display:flex; align-items:baseline; gap:1.6vw; margin-bottom:.5vw; padding:0 .4vw;
    position:relative}
  /* 제목은 이름 열이 아니라 판 왼쪽 끝에서 시작합니다 — 한 열의 머리글로 보이지 않게.
     flex:1 이라 음수 여백만큼 왼쪽으로 늘어날 뿐, 뒤의 항목 열은 밀리지 않습니다.
     덤으로 머리줄이 판 폭을 정하지 않게 되어 판이 좁아지고, 그만큼 확대 배율이 올라
     방송에 나오는 글자가 전부 커집니다. */
  .ov-name-t{flex:1; min-width:6vw; padding-right:1.6vw; margin-left:-14vw}
  /* 머리줄과 표를 가르는 선 — currentColor 라 네 가지 테마에서 알아서 맞습니다 */
  .ov-head::after{content:''; position:absolute; left:0; right:0; bottom:-.34vw;
    height:.32vw; background:currentColor; opacity:.34}
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
  /* 글자 크기는 fitCheads 가 칸에 맞춰 정합니다 (1.6~2.6vw). 여기 값은 그 전의 밑값 */
  .ov-chead{width:6.4vw; flex:none; text-align:center; font-size:1.6vw; opacity:.8;
    overflow:hidden; text-overflow:ellipsis; white-space:nowrap}
  .ov-chead.rl{opacity:.9}
  /* 룰렛 표시는 작게 — ◎ 가 글자 한 칸을 통째로 먹으면 정작 항목 이름이 손해입니다 */
  .ov-rlmk{font-size:.7em; font-style:normal; opacity:.85; margin-right:.05em}
  /* 순액 — 받을 몫에서 낸 벌금을 뺀 값. 받는 쪽은 파랑, 보내는 쪽은 빨강 */
  /* 폭은 금액 열과 같은 예산·래칫 변수 — 커진 순액이 잘리는 일이 없습니다 */
  .ov-net{flex:none; width:var(--netw, 11.5vw); text-align:right; font-size:2.9vw; font-weight:700;
    font-variant-numeric:tabular-nums; opacity:.5; white-space:nowrap; overflow:hidden}
  .ov-net.plus{color:#6fb4ff; opacity:1}
  .ov-net.minus{color:#ff7d6b; opacity:1}
  .ov-nethead{flex:none; width:var(--netw, 11.5vw); text-align:right; font-size:1.6vw; opacity:.8}
  /* 폭은 렌더마다 실측한 --goldw 를 전 줄이 공유 — 줄마다 제 금액대로 늘면 열이 어긋납니다 */
  .ov-gold{font-variant-numeric:tabular-nums; color:var(--gold); flex:none;
    text-align:right; min-width:9.5vw; width:var(--goldw, auto); white-space:nowrap;
    position:relative}
  /* 증감액 — 개인 벌금(합계) 바로 오른쪽에 붙습니다. 줄 오른쪽 끝에 걸어 두면
     순액이 꺼져 있을 때 정작 벌금을 덮어 버립니다. 순액은 덮여도 되는 값이라
     켜져 있을 때는 그 열 위에 얹힙니다. */
  .ov-delta{position:absolute; left:100%; margin-left:.6vw; top:50%;
    transform:translateY(-50%); white-space:nowrap;
    font-size:3.4vw; font-weight:600; color:var(--gold);
    padding:.1vw .8vw; border-radius:99px; background:rgba(20,17,14,.72)}
  /* 밝은 판·진한 글자 테마에서는 칩도 밝게 */
  html[data-t="light"] .ov-delta, html[data-t="cleardark"] .ov-delta{background:rgba(248,244,236,.85)}
  .ov-delta.plus{color:#8fd89b}
  /* 비어 있을 때는 칩 배경만 남지 않도록 아예 감춥니다 */
  .ov-delta:empty{display:none}
  /* 순액이 꺼져 있으면 칩은 판 바깥(투명 영역)으로 나갑니다 — 카드를 넓히지 않으니
     판이 작아지지 않고, OBS 소스에 어차피 남던 여백을 대신 씁니다.
     잘리지 않게 fitBoard 가 그 튀어나온 만큼을 폭에 얹어서 배율을 잽니다. */
  .ov-row.zero{opacity:.5}

  /* 벌금 알림 — 룰렛과 같은 결의 카드. 원판과 달리 글자 두 줄뿐이라 크게 잡을 필요가
     없어서, 소스 크기를 재지 않고 내용에 맞춰 세웁니다. */
  /* 카드만 뜹니다 — 뒤를 어둡게 깔지 않습니다. 소스가 화면 모퉁이의 작은 상자라
     막을 깔면 그 상자 전체가 어두워질 뿐, 얻는 게 없습니다. */
  #ovfx:not(:empty){position:fixed; inset:0; z-index:3; display:flex;
    align-items:center; justify-content:center; padding:2%;
    pointer-events:none; animation:ov-spin-in .18s ease-out}
  /* 평평하게 — 조명·광택 없이 색 하나와 얇은 테두리로만 */
  /* 룰렛 결과 카드 — 방금 본 바퀴의 것이라고 표시합니다 */
  .ov-fx.roul{border-color:rgba(220,174,94,.85)}
  .ov-fx.roul b::before{content:"◎ "; color:#dcae5e}
  .ov-fx{max-width:86%; text-align:center; color:#ece4d6; padding:3.4vw 6vw;
    border-radius:1.4vw; animation:ov-fx-in .2s cubic-bezier(.2,1.3,.4,1);
    background:#1b1611; border:.26vw solid rgba(220,174,94,.55)}
  .ov-fx b{display:block; font-size:6.4vw; font-weight:700; line-height:1.1;
    overflow:hidden; text-overflow:ellipsis; white-space:nowrap}
  .ov-fx span{display:block; margin-top:1.2vw; font-size:4.2vw; opacity:.92;
    white-space:nowrap}
  .ov-fx em{font-style:normal; font-weight:700}
  .ov-fx.up em{color:#8fd89b}
  .ov-fx.dn em{color:#e59a90}
  @keyframes ov-fx-in{from{opacity:0; transform:scale(.86)} to{opacity:1; transform:scale(1)}}

  /* 금액 스와이프 — 오르면 위로, 깎이면 아래로. 가운데에 증감을 한 번 보여 주고 멈춥니다 */
  /* 두루마리 창 — 한 줄 높이만 남기고 나머지는 잘라 냅니다.
     overflow 만으로는 애니메이션 중인(합성된) 자식이 새어 나가서 clip-path 로 못 박고,
     릴은 절대 배치해 줄 높이(strut)에 밀리지 않게 위에 딱 붙입니다.
     폭은 금액 열이 이미 --goldw 로 정해 두었으니 그대로 채웁니다. */
  /* 이름은 ov-mv* 로 — .ov-reel 은 룰렛 슬롯이 이미 쓰고 있습니다(가운데 정렬·고정 크기).
     같은 이름을 쓰면 그 규칙이 덮어써서 금액이 반 칸씩 어긋납니다. */
  .ov-mvbox{position:relative; display:inline-block; width:100%; height:1.16em;
    overflow:hidden; clip-path:inset(0); vertical-align:bottom; line-height:0}
  .ov-mvreel{position:absolute; top:0; left:0; right:0; display:flex; flex-direction:column}
  .ov-mvreel > i{font-style:normal; display:block; height:1.16em; line-height:1.16em}
  .ov-mvreel.up > i.d{color:#8fd89b}
  .ov-mvreel.dn > i.d{color:#e59a90}
  .ov-mvreel.up{animation:ov-mv-up var(--mvdur,1120ms) cubic-bezier(.3,0,.2,1) forwards}
  .ov-mvreel.dn{animation:ov-mv-dn var(--mvdur,1120ms) cubic-bezier(.3,0,.2,1) forwards}
  @keyframes ov-mv-up{
    0%{transform:translateY(0)} 25%{transform:translateY(-33.333%)}
    75%{transform:translateY(-33.333%)} 100%{transform:translateY(-66.666%)}}
  @keyframes ov-mv-dn{
    0%{transform:translateY(-66.666%)} 25%{transform:translateY(-33.333%)}
    75%{transform:translateY(-33.333%)} 100%{transform:translateY(0)}}
  @media (prefers-reduced-motion:reduce){
    .ov-mvreel.up,.ov-mvreel.dn{animation-duration:1ms}
    .ov-fx{animation:none}
  }

  /* 1위 — 금색 순위와 살짝 밝은 이름으로 초점을 만듭니다 */
  .ov-row.top .ov-rank{color:var(--gold); opacity:1; font-weight:700}
  .ov-row.top .ov-name{font-weight:700}

  /* 방금 벌금이 붙은 줄 — 잠깐 번쩍이고 오른쪽에 증감이 떠올랐다 사라집니다 */
  .ov-row.hit{animation:ov-flash 1.6s ease-out}
  /* 룰렛 — 보드가 아니라 소스(뷰포트) 전체를 덮습니다. 보드가 좁고 길어도
     원판은 소스 크기로 큽니다 */
  /* 뒤를 어둡게 깔지 않습니다 — 소스가 화면 모퉁이의 작은 상자라, 막은 게임이 아니라
     우리 판만 덮습니다. 나눈 소스(룰렛 전용)에서는 아예 검은 사각형으로 보이고요.
     판(.ov-sp)이 이미 불투명해서 원판 뒤는 그것으로 가려집니다. */
  #ovspin:not(:empty){position:fixed; inset:0; z-index:3; display:flex;
    align-items:center; justify-content:center; padding:2%;
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
  /* 답이 없는 동안 끝없이 도는 원판 */
  /* from 을 반드시 적습니다 — to 만 쓰면 시작값이 .ov-w-disc 의 translateZ(0),
     즉 함수 목록이 달라 행렬 보간으로 떨어지고, 항등행렬끼리라 한 바퀴가 제자리입니다 */
  @keyframes ov-w-free{from{transform:rotate(0deg)} to{transform:rotate(360deg)}}
  .ov-w-free{animation:ov-w-free 260ms linear infinite}
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
  /* 사람 이름은 숫자보다 훨씬 길어서, 숫자 기준 크기로 두면 허브를 덮고 안쪽에 뭉칩니다.
     글자 끝을 림에 붙이는 규칙은 그대로 두고, 크기와 뻗는 길이만 줄입니다 */
  .ov-wheel-who .ov-w-lab i{font-size:calc(var(--u)*2.3*var(--wu,1));
    max-width:calc(var(--u)*13*var(--wu,1))}
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
  var showSum = true; // 합계 열을 켤지 (기본 켬). 끄면 증감 칩도 같이 빠집니다 —
                      // 금액을 안 보여 주면서 증감만 띄우면 읽을 수가 없어서요
  /* 마지막으로 받은 판. 연출(카드·룰렛)이 다 끝나야 화면에 앉힙니다 —
     연출 중에 숫자가 먼저 바뀌면 답이 새어 나가고, 무엇 때문에 바뀐 건지도 안 보입니다.
     여러 번 받아도 최신 것 하나만 남으니 밀릴 일이 없습니다. */
  var next = null;
  /* 연출 대기열 — 항목 카드와 룰렛이 도착 순서대로 한 줄에 섭니다.
     그래서 '항목 → 룰렛 → 항목'이 그 순서 그대로 나갑니다. */
  var fxQ = [];
  var fxSeen = {};    // 큐에 넣은 적 있는 id — 상태를 다시 받아도 두 번 안 넣습니다
  var fxShown = {};   // 실제로 화면에 띄운 카드 id — 취소가 카드를 띄울지 가릅니다
  var fxCard = null;  // 지금 떠 있는 카드
  var fxTimer = null;
  var pendSpin = null;   // 큐 위로 올라갈 판
  var settleNow = false; // 룰렛 결과 뒤에는 카드가 남아 있어도 판을 먼저 앉힙니다
  var fxBooted = false; // 첫 상태의 대기열은 '이미 흘러간 것'으로 봅니다
  var applying = false; // 판 반영(스와이프·순위 이동) 중
  var FX_HOLD = 1600;   // 카드가 머무는 시간
  var MV_DUR = 1120;    // 금액 스와이프 한 판
  var mvMode = "swipe"; // swipe | chip | off
  var spin = null;      // 앱이 보낸 판 (한 번에 통째로)
  var play = null;      // 방송이 제 시계로 재생하는 상태
  var spinTimer = null; // 도는 글자
  var stepTimer = null; // 다음 걸음
  /* 속도는 판마다 옵니다. 앱·방송·파티원 화면이 같은 속도로 돌아야 따로 놀지 않습니다 */
  var SPINS = {
    fast: { roll: 2200, hold: 700, end: 1100 },
    normal: { roll: 4200, hold: 1100, end: 1500 },
    slow: { roll: 7000, hold: 1500, end: 1900 },
    epic: { roll: 10000, hold: 1800, end: 2200 },
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

  /* 항목명 크기 — 칸(6.4vw)에 들어가는 최대 크기를 이름마다 재서 정합니다.
     칸을 넓히는 건 답이 아닙니다: 판이 가로로 커지면 contain 확대 배율이 그만큼
     떨어져 결국 제자리라서요. 늘릴 수 있는 건 다른 글자 대비 비율뿐입니다.
     짧은 이름은 커지고, 긴 이름만 지금 크기(1.6vw)로 남습니다 — 손해 보는 열은 없습니다. */
  var fitCheads = function () {
    var MAXV = 2.6, MINV = 1.6;
    var box = 6.4 * (window.innerWidth / 100); // 칸 폭(px). 배율 전 레이아웃 기준
    if (!box) return;
    [].forEach.call(document.querySelectorAll(".ov-chead"), function (el) {
      /* 잘린 채로 재면 칸 폭이 그대로 나옵니다 — 잠깐 풀어서 진짜 폭을 잽니다.
         offsetWidth 는 확대(transform) 전 값이라 box 와 같은 자로 잽니다 */
      el.style.fontSize = MAXV + "vw";
      el.style.width = "auto";
      el.style.overflow = "visible";
      var need = el.offsetWidth;
      el.style.width = "";
      el.style.overflow = "";
      el.style.fontSize =
        (need > box ? Math.max(MINV, (MAXV * box) / need) : MAXV).toFixed(2) + "vw";
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

    /* 0원을 흐리게 하는 건 "아직 안 낸 사람"을 가리려는 것이라, 모두가 0이면 뜻이 없습니다.
       단가를 0으로 두고 횟수만 세는 판이 그렇습니다 — 그때는 아무도 안 흐리게 둡니다. */
    var anyPaid = list.some(function (r) { return (r.g || 0) !== 0; });
    var html = list.map(function (r, i) {
      var was = prev[r.n];
      var justHit = !!was && r.g - was.g !== 0;   // 번쩍임은 바뀐 그 순간만
      var rc = recent[r.n] || {};
      var dAge = rc.dAt == null ? Infinity : now - rc.dAt;
      var mAge = rc.mvAt == null ? Infinity : now - rc.mvAt;
      var showD = mvMode === "chip" && dAge < DELTA_MS, showM = mAge < MOVE_MS;
      var cls = "ov-row" + (r.g || !anyPaid ? "" : " zero") + (justHit ? " hit" : "") +
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
        (showSum
          ? '<span class="ov-gold">' + manShort(r.g) +
              '<span class="ov-delta ' + (showD ? (rc.d > 0 ? "plus" : "minus") : "") + '"' +
                (showD ? delay(dAge) : "") + '>' +
                (showD ? (rc.d > 0 ? "+" : "−") + manShort(Math.abs(rc.d)) : "") + '</span>' +
            '</span>'
          : "") +
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
  /* 릴도 원판과 같은 규칙으로 — 답이 없는 동안은 같은 속도로, 멈추는 동안은
     간격이 늘어나며 감속을 보여 줍니다. 원판만 감속하고 릴은 툭 서면 같은 판인데
     하나만 고장 난 것처럼 보입니다. */
  var rollFace = function (pl) {
    if (faceTimer) { clearTimeout(faceTimer); faceTimer = null; }
    if (!pl || pl.sp.look !== "num" || !pl.rolling) return;
    var t = 0;
    var free = !!pl.free;
    var t0 = Date.now();
    var fs2 = pl.sp.faces && pl.sp.faces.length ? pl.sp.faces : ["1"];
    var step = function () {
      var el = document.getElementById("ovface");
      if (!el) { faceTimer = null; return; }
      var i = t++ % fs2.length;
      el.textContent = faceLabel(fs2[i]);
      var pv = document.getElementById("ovprev");
      var nx = document.getElementById("ovnext");
      if (pv) pv.textContent = faceLabel(fs2[(i - 1 + fs2.length) % fs2.length]);
      if (nx) nx.textContent = faceLabel(fs2[(i + 1) % fs2.length]);
      if (free) { faceTimer = setTimeout(step, OV_FACE_MS); return; }
      var el2 = Date.now() - t0;
      var gap = faceGap(el2 / OV_ROLL);
      /* 마지막 한 칸은 결과가 차지합니다 — 끝나기 직전에 한 번 더 넘기면
         엉뚱한 면이 스쳤다가 곧바로 결과로 바뀌어 두 번 바뀝니다 */
      if (OV_ROLL - el2 < gap * 1.35) { faceTimer = null; return; }
      faceTimer = setTimeout(step, gap);
    };
    faceTimer = setTimeout(step, OV_FACE_MS);
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
    var st0 = (play.sp.steps || [])[play.i];
    if (!st0) return; // 아직 안 뽑힌 자리 — 보여 줄 값이 없습니다
    var txt = faceLabel(st0.k);
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
          var k = ((sp.steps || [])[play.i] || {}).k;
          if (k == null) return;
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
  /* 답이 없는 동안 원판을 끝없이 돌립니다 — CSS 애니메이션에 맡기면
     프레임마다 계산할 게 없어서 OBS 소스에서도 가볍습니다 */
  var freeWheel = function (on) {
    var el = document.getElementById("ovdisc");
    if (!el) return;
    if (on) {
      el.style.transition = "none";
      el.style.transform = "";
      el.style.animationDuration = OV_FREE_MS + "ms";
      el.classList.add("ov-w-free");
    }
    else el.classList.remove("ov-w-free");
  };

  var rollStep = function () {
    if (!play) return;
    if (play.sp.look === "num") rollFace(play);
    else if (play.free) freeWheel(true);
    else spinTo(poolAt(play.sp, play.i), play.sp.w, (play.sp.steps[play.i] || {}).k);
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
      wrap.outerHTML = wheelHtml(sp.pass2.faces, {}, sp.theme, true);
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
    /* 다음 면은 앱이 정합니다 — 여기서 앞서가면 아직 안 뽑힌 면을 보여 주게 됩니다.
       서기가 다시 STOP 을 누르면 상태가 오고, 그때 enterFree / leaveFree 가 잇습니다.
       단, 판이 사라졌으면 기다릴 상대가 없으니 그대로 마무리합니다. */
    if (!play.appGone && (play.sp.phase === "roll" || spFree(play.sp))) {
      /* 표시를 남깁니다 — 기다리다 상태가 오면 이걸 보고 깨워야 합니다.
         타이머는 이미 터진 뒤라 id 만 보고는 기다리는 중인지 알 수 없습니다. */
      play.waiting = true;
      return;
    }
    play.waiting = false;
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
      if (!play.sp.pass2 || !play.sp.pass2.name) {
        /* 서기가 뽑기 전에 판을 닫았습니다 — 이름 없이 그대로 넘어갑니다 */
        stepTimer = setTimeout(stepPlay, OV_HOLD);
        return;
      }
      if (play.sp.look === "num") {
        /* 이름 릴 정지 — 가운데에 뽑힌 이름, 위아래엔 이웃 */
        if (faceTimer) { clearTimeout(faceTimer); faceTimer = null; }
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
    /* 적용 결과(out)나 새 표(next)가 아직이면 결과 화면을 붙잡습니다 — 앱 탭이
       느려져(백그라운드 스로틀 등) 오버레이가 먼저 끝나면 벌금 변화가 못 뜹니다 */
    if (spin && spin.sid === play.sp.sid && !play.sp.out && !next) {
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
    pump(); // 다음 연출로, 큐가 비었으면 판을 앉힙니다
  };

  /* 답이 아직 없는 상태 — 숫자 판이든 사람 판이든 같은 규칙입니다 */
  var spFree = function (sp) { return !!sp && (sp.phase === "free" || !!sp.whoFree); };

  /* 후보가 줄면(양도권이 빠지면) 칸 수가 달라져서 원판을 새로 그려야 합니다 */
  var refitWheel = function () {
    if (!play || play.sp.look === "num" || play.who) return;
    var pool = poolAt(play.sp, play.i);
    if (play.poolN != null && pool.length !== play.poolN) {
      var box = document.querySelector("#ovspin .ov-wheel");
      if (box) {
        box.outerHTML = wheelHtml(pool, play.sp.w, play.sp.theme);
        wheelRot = 0;
        hitKey = null;
      }
    }
    play.poolN = pool.length;
  };

  var startPlay = function (sp) {
    clearPlayTimers();
    useSpeed(sp);
    useSpinCfg(sp);
    var free = spFree(sp);
    play = {
      sp: sp,
      i: free ? (sp.steps || []).length : Math.max(0, (sp.steps || []).length - 1),
      rolling: true,
      over: false,
      free: free,
    };
    if (sp.whoFree) play.who = "roll";
    drawPlay();
    refitWheel();
    rollStep();
    /* 답이 없는 판은 걸음을 안 셉니다 — 서기가 멈춰 답이 올 때 그때부터 셉니다 */
    if (!play.free) stepTimer = setTimeout(stepPlay, OV_ROLL);
  };

  /* 다음 면을 뽑을 차례 — 답이 올 때까지 다시 끝없이 돕니다.
     ×2 나 양도권이 나오면 앱이 여기로 되돌아옵니다. */
  var enterFree = function () {
    if (!play || play.free) return;
    play.free = true;
    clearTimeout(stepTimer);
    stepTimer = null;
    if (faceTimer) { clearInterval(faceTimer); faceTimer = null; }
    var steps = play.sp.steps || [];
    if (play.sp.whoFree) {
      /* 사람 원판 — 후보 이름으로 판을 갈아 끼우고 답 없이 돌립니다 */
      play.who = "roll";
      whoWheel(play);
    } else {
      play.i = steps.length;
      play.rolling = true;
      drawPlay();
      refitWheel();
    }
    rollStep();
  };

  /* 답이 도착했습니다 — 돌던 자리에서 이어서 감속으로 넘어갑니다 */
  var leaveFree = function () {
    if (!play || !play.free) return;
    play.free = false;
    freeWheel(false);
    var sp = play.sp;
    /* 답 없이 사라진 판 — 돌던 자리에서 그냥 멈춥니다 */
    if (play.appGone && !(play.who === "roll" && sp.pass2 && sp.pass2.name)) {
      /* 자유 회전은 아직 안 뽑힌 자리를 가리킵니다 — 마지막으로 뽑힌 걸음으로 돌려놓습니다 */
      play.i = Math.max(0, (sp.steps || []).length - 1);
      play.rolling = false;
      drawPlay();
      stepTimer = setTimeout(stepPlay, OV_HOLD);
      return;
    }
    /* 사람 원판이면 뽑힌 이름으로 세웁니다 */
    if (play.who === "roll" && sp.pass2 && sp.pass2.name) {
      if (sp.look !== "num") spinTo(sp.pass2.faces, {}, sp.pass2.name);
      stepTimer = setTimeout(stepPlay, OV_ROLL);
      return;
    }
    play.i = Math.max(0, (sp.steps || []).length - 1);
    play.rolling = true;
    /* 클래스는 spinTo 가 벗깁니다 — 여기서 먼저 벗기면 돌던 각도를 못 읽어
       원판이 0도로 튄 뒤에 감속을 시작합니다 */
    drawPlay();
    refitWheel();
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
  var wheelHtml = function (faces, weights, theme, who) {
    var segs = wheelArcs(faces, weights, theme);
    var labs = segs.map(function (x) {
      return '<span class="ov-w-lab" style="transform:rotate(' + x.mid.toFixed(2) + 'deg)">' +
        "<i>" + esc(faceLabel(x.k)) + "</i></span>";
    }).join("");
    return '<div class="ov-wheel' + (who ? " ov-wheel-who" : "") +
      '"><div class="ov-w-disc" id="ovdisc" style="background:' +
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

  /* 결과 줄 — 실제 깎이거나 붙은 값은 표(next)와의 차로 잽니다. 잘린 감면이면
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
    var newB = next && next.board ? next.board : null;
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

  /* 판 번호에서 뽑는 씨앗 — 같은 판이면 어느 소스에서 보든 같은 각도로 돌아야 해서
     난수 대신 이걸 씁니다. 결과는 앱이 정해 보내므로 흔드는 건 연출뿐입니다. */
  var seedOf = function (v) {
    var t = String(v || ""), h = 0;
    for (var i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) >>> 0;
    return h;
  };

  /* 자유 회전 한 바퀴에 걸리는 시간. 앱의 FREE_MS 와 같은 값이어야
     서기 화면과 방송 화면이 같은 속도로 돕니다. */
  var OV_FREE_MS = 260;
  /* 도는 규칙 — 앱이 판에 실어 보냅니다. 여기 있는 값은 그게 안 왔을 때의 기본값이고,
     오면 갈아 끼웁니다. 복사본을 들고 있으면 한쪽만 고쳐도 눈치채기 어렵습니다. */
  var OV_SPIN_AIM = 1.7, OV_TAIL = 0.72, OV_FACE_MS = 70;
  var useSpinCfg = function (sp) {
    var c = sp && sp.cfg;
    if (!c) return;
    if (c.free > 0) OV_FREE_MS = c.free;
    if (c.aim > 0) OV_SPIN_AIM = c.aim;
    if (c.tail > 0) OV_TAIL = c.tail;
    if (c.face > 0) OV_FACE_MS = c.face;
  };
  /* 멈추는 동안 면이 바뀌는 간격 — 앱의 faceGap 과 같은 식입니다 */
  var faceGap = function (p) {
    return Math.round(OV_FACE_MS * Math.pow(6, Math.min(1, Math.max(0, p))));
  };

  /* 당첨 칸이 12시 바늘 아래로 오도록 원판을 돌립니다.
     진짜 원판은 곡선 하나로 섭니다 — 등감속이면 처음 속도가 평균의 딱 두 배라서,
     timing-function 의 처음 기울기를 "돌던 속도 / 평균 속도"에 맞추면 멈추기 시작하는
     순간에 이음매가 없습니다. 곡선 두 개를 이어 붙이면 그 이음매에서 속도가 툭 바뀌어
     고장 난 것처럼 보였습니다.
     매번 다르게 서는 맛은 곡선이 아니라 바퀴 수로 냅니다 — 같은 시간에 더 많이 돌면
     제동이 세고, 적게 돌면 길게 미끄러집니다. */
  var spinTo = function (faces, weights, k) {
    var el = document.getElementById("ovdisc");
    if (!el) return;
    var segs = wheelArcs(faces, weights);
    var seg = null;
    for (var i = 0; i < segs.length; i++) if (segs[i].k === k) seg = segs[i];
    if (!seg) seg = segs[0];
    /* 끝없이 돌던 중이면 그 각도를 이어받습니다 — 안 그러면 멈추는 순간 튑니다 */
    var wasFree = el.classList.contains("ov-w-free");
    if (wasFree) {
      var mm = new DOMMatrixReadOnly(getComputedStyle(el).transform);
      el.classList.remove("ov-w-free");
      wheelRot = ((Math.atan2(mm.b, mm.a) * 180) / Math.PI + 360) % 360;
    }
    var from = wheelRot;
    /* 늘 칸 한가운데에 서면 짜인 것처럼 보입니다 — 칸 안에서 서는 자리를 흔들되
       가장자리는 피합니다. 앱과 같은 씨앗이라 같은 자리에 섭니다. */
    var seed = seedOf((play && play.sp.sid) + ":" + (play ? play.i : 0));
    var arc = Math.max(1, seg.to - seg.from);
    var off = (((seed >>> 7) % 1000) / 1000 - 0.5) * arc * 0.72;
    /* 이 자리가 바늘 밑으로 오는, 지금보다 앞에 있는 첫 각도 */
    var seat = from + ((((-(seg.mid + off) - from) % 360) + 360) % 360);
    /* 목표 배속에서 나오는 바퀴 수 — 판마다 ±1 바퀴 흔듭니다 */
    var v0 = (360 / OV_FREE_MS) * OV_ROLL;
    var base = Math.max(1, Math.round(v0 / (OV_SPIN_AIM * 360)));
    var turns = Math.max(1, base + ((seed % 3) - 1));
    var target = seat + turns * 360;
    wheelRot = target;

    var D = Math.max(1, target - from);
    /* 처음 기울기 s0 를 갖고 끝에서 0 이 되는 곡선 (x1, s0·x1, x2, 1).
       x1 을 줄여야 s0 를 3 넘게 키울 수 있습니다 — y1 이 1 을 넘으면 목표를 지나쳤다
       되돌아오고, 그건 원판이 뒤로 감기는 것으로 보입니다. */
    var s0 = Math.min(2.4, Math.max(1.3, v0 / D));
    var x1 = Math.min(0.5, 0.96 / s0);
    var cz = wasFree
      ? "cubic-bezier(" + x1.toFixed(3) + "," + (s0 * x1).toFixed(3) + "," + OV_TAIL + ",1)"
      : "cubic-bezier(.35,0,.28,1)"; // 멈춰 있다 다시 도는 판

    /* 시작 각도를 전환 없이 먼저 못 박고, 강제로 한 번 계산시킨 뒤 목표를 줍니다.
       프레임 콜백을 기다리지 않아 OBS 브라우저 소스에서도 확실히 돕니다. */
    el.style.transition = "none";
    el.style.transform = "rotate(" + from.toFixed(2) + "deg)";
    void el.offsetWidth;
    el.style.transition = "transform " + OV_ROLL + "ms " + cz;
    el.style.transform = "rotate(" + target.toFixed(2) + "deg)";
  };

  /* 설정 — 앱이 상태에 실어 보냅니다 */
  var FX_HOLDS = { fast: 1000, norm: 1600, slow: 2400 };
  var fxOn = true;
  var applyFxCfg = function (st) {
    var sp = st.fxSpd;
    /* 앱이 알림을 끄면 연출거리를 아예 안 보내지만, 받는 쪽에서도 한 번 더 겁니다 */
    fxOn = sp !== "off";
    FX_HOLD = FX_HOLDS[sp] || FX_HOLDS.norm;
    MV_DUR = Math.round(FX_HOLD * 0.7);
    mvMode = st.mvMode === "chip" || st.mvMode === "off" ? st.mvMode : "swipe";
  };

  /* 받은 연출거리를 큐에 세웁니다 */
  var ingestFx = function (list) {
    if (!list) list = [];
    for (var i = 0; i < list.length; i++) {
      var e = list[i];
      if (!e || !e.i || fxSeen[e.i]) continue;
      fxSeen[e.i] = 1;
      if (!fxBooted || !fxOn) continue; // 붙기 전에 있었던 일과, 알림을 끈 판은 지나갑니다
      if (e.k === "cancel") {
        /* 아직 안 뜬 카드를 취소했으면 그 카드를 큐에서 빼고 끝냅니다 —
           아무도 못 봤으니 없던 일입니다. 오입력이 방송에 아예 안 나갑니다. */
        var hit = -1;
        for (var j = 0; j < fxQ.length; j++) if (fxQ[j].i === e.ref) hit = j;
        if (hit >= 0) { fxQ.splice(hit, 1); continue; }
        /* 이미 뜬 뒤라면 본 사람에게 정정을 알려야 합니다 — 짧게 띄웁니다 */
        if (!fxShown[e.ref]) continue;
      }
      /* 룰렛 결과는 방금 본 판의 것이라 줄 맨 앞으로 — 밀린 카드 뒤에 서면
         바퀴가 선 한참 뒤에야 그 결과가 나옵니다 */
      if (e.k === "roul") fxQ.unshift(e);
      else fxQ.push(e);
    }
    fxBooted = true;
    var ks = Object.keys(fxSeen);
    if (ks.length > 300) for (var k = 0; k < 150; k++) delete fxSeen[ks[k]];
    var hs = Object.keys(fxShown);
    if (hs.length > 300) for (var h = 0; h < 150; h++) delete fxShown[hs[h]];
  };

  var fxCardHtml = function (e) {
    var up = e.g > 0;
    return '<div class="ov-fx ' + (up ? "up" : "dn") + (e.k === "roul" ? " roul" : "") + '">' +
      "<b>" + esc(e.n) + "</b>" +
      "<span>" + esc(e.t || "") + ' <em>' + (up ? "+" : "\u2212") +
      manShort(Math.abs(e.g)) + "</em></span></div>";
  };

  var playCard = function (e) {
    fxShown[e.i] = 1;
    fxCard = e;
    /* 정정(취소·빼기)은 짧게 — 알리되 붙는 것만큼 크게 다루지 않습니다.
       그리고 밀리면 더 짧게: 다 보여 주되 속도만 올려 다음 판을 안 잡아먹습니다. */
    var hold = e.k === "add" || e.k === "roul" ? FX_HOLD : Math.round(FX_HOLD * 0.7);
    /* 룰렛 결과가 지나가면 판을 바로 앉힙니다 — 밀린 카드를 다 볼 때까지
       바퀴의 결과가 표에 안 뜨면, 방금 본 것과 표가 따로 놉니다 */
    if (e.k === "roul") settleNow = true;
    if (fxQ.length > 4) hold = Math.round(hold * 0.5);
    var host = document.getElementById("ovfx");
    /* 카드는 벌금표에 대한 이야기라 표 소스에 뜹니다. 룰렛 소스는 룰렛만 —
       소스를 나눈 뜻이 "표는 작게, 룰렛은 크게"인데 거기에 카드가 끼면 화면 한복판을
       클릭마다 가립니다. 안 그리는 쪽도 시간은 똑같이 흘려서 두 소스의 판이
       같은 순간에 바뀌게 합니다. */
    if (host && TYPE !== "spin") host.innerHTML = fxCardHtml(e);
    clearTimeout(fxTimer);
    fxTimer = setTimeout(function () {
      fxCard = null;
      var h = document.getElementById("ovfx");
      if (h) h.innerHTML = "";
      pump();
    }, hold);
  };

  /* 굴릴 거리 — 금액이 바뀐 줄과 총액 */
  var swipePlan = function (oldB, newB) {
    var was = {}, out = [];
    oldB.forEach(function (r) { was[r.n] = r.g || 0; });
    var oldSum = 0, newSum = 0;
    oldB.forEach(function (r) { oldSum += r.g || 0; });
    newB.forEach(function (r) {
      newSum += r.g || 0;
      if (was[r.n] != null && was[r.n] !== (r.g || 0))
        out.push({ n: r.n, from: was[r.n], to: r.g || 0 });
    });
    if (oldSum !== newSum) out.push({ total: 1, from: oldSum, to: newSum });
    return out;
  };

  /* 금액 칸 안에서 굴립니다 — 오르면 위로, 깎이면 아래로.
     판 밖으로 나가는 게 없어서 소스를 좁게 잘라도 안 사라집니다. */
  var paintSwipe = function (moves) {
    var box = document.querySelector(".ov");
    if (box) box.style.setProperty("--mvdur", MV_DUR + "ms");
    var rows = document.querySelectorAll(".ov-row");
    moves.forEach(function (m) {
      var el = null;
      if (m.total) el = document.querySelector(".ov-total");
      else
        for (var i = 0; i < rows.length; i++)
          if (rows[i].getAttribute("data-k") === m.n) el = rows[i].querySelector(".ov-gold");
      if (!el) return;
      var up = m.to > m.from;
      var mid = (up ? "+" : "\u2212") + manShort(Math.abs(m.to - m.from));
      var a = manShort(m.from), c = manShort(m.to);
      /* 아래로 굴릴 때는 순서를 뒤집고 반대 방향으로 — 둘 다 새 값에서 멈춥니다 */
      var items = up ? [a, mid, c] : [c, mid, a];
      el.innerHTML =
        '<span class="ov-mvbox"><span class="ov-mvreel ' + (up ? "up" : "dn") + '">' +
        '<i>' + items[0] + '</i><i class="d">' + items[1] + '</i><i>' + items[2] + "</i>" +
        "</span></span>";
    });
  };

  /* 큐가 다 끝난 뒤 한 번에 — 금액이 굴러가고, 그다음 순위가 움직입니다.
     둘 다 세로 움직임이라 겹치면 무엇이 무엇인지 안 읽힙니다. */
  var settle = function () {
    if (!next) return;
    var nb = next.board, nc = next.cols, nn = next.net, ns = next.sum;
    var sameCols = JSON.stringify(nc) === JSON.stringify(cols);
    var moves =
      mvMode === "swipe" && ovBoard && board && board.length && nb && nb.length &&
      sameCols && nn === showNet && ns === showSum
        ? swipePlan(board, nb)
        : [];
    var done = function () {
      board = nb; cols = nc; showNet = nn; showSum = ns;
      next = null;
      applying = false;
      render();
      pump();
    };
    if (!moves.length) { done(); return; }
    applying = true;
    paintSwipe(moves);
    setTimeout(done, MV_DUR + 150); // 숨 고르고 나서 순위를 옮깁니다
  };

  /* 연출 한 줄 세우기 — 재생 중이면 기다리고, 큐가 비면 판을 앉힙니다 */
  /* 룰렛은 큐에 서지 않고 그 위에 뜹니다. 길이가 사람 손에 달려 있어서(STOP 대기),
     줄에 세우면 뒤에 선 카드들이 인질이 됩니다. 대신 재생 중인 카드 한 장은
     끝까지 보여 주고 — 뜨자마자 지우면 그 클릭은 아무도 못 본 것이 됩니다. */
  var pump = function () {
    if (applying || fxCard) return;
    if (pendSpin) {
      var sp2 = pendSpin;
      pendSpin = null;
      if (sp2.sid !== doneSid) { startPlay(sp2); return; }
    }
    if (play) return; // 판이 떠 있는 동안 큐는 멈춥니다. 쌓인 카드는 끝난 뒤에
    if (next && settleNow) { settleNow = false; settle(); return; }
    if (fxQ.length) { playCard(fxQ.shift()); return; }
    if (next) settle();
  };

  var render = function () {
    /* 룰렛 전용 소스 — 보드도 알림도 안 그립니다. 판이 없으면 그냥 투명입니다 */
    if (TYPE === "spin") {
      if (!document.getElementById("ovspin")) app.innerHTML = '<div id="ovspin"></div>';
      if (play && spin && spin.sid === play.sp.sid) {
        play.sp = spin; // 시작은 연출 큐가 맡습니다
        var nf1 = spFree(spin);
        if (nf1 && !play.free) enterFree();
        else if (!nf1 && play.free) leaveFree();
      }
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
        '<div id="ovboard"></div></div><div id="ovspin"></div><div id="ovfx"></div>';
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
      if (play && spin && spin.sid === play.sp.sid) {
        play.sp = spin; // 양도 대기 여부만 갱신. 시작은 연출 큐가 맡습니다
        var nf2 = spFree(spin);
        if (nf2 && !play.free) enterFree();
        else if (!nf2 && play.free) leaveFree();
      }
      drawPlay();
    }
    /* 오버레이 제목은 파티명이 아니라 '벌금 순위' — 방송 화면에 뜨는 건 표지판이지 명패가 아닙니다.
       금액 내림차순으로 서는 판이라 '표'보다 '순위'가 화면이 하는 일을 그대로 말합니다 */
    /* 항목 이름은 머리줄에 한 번만 — 줄마다 되뇌면 방송에서 읽히지 않습니다.
       칸 구성은 본문 줄과 하나하나 같아야 열이 맞습니다 */
    document.getElementById("ovhead").innerHTML =
      '<span class="ov-rank"></span><span class="ov-move"></span>' +
      '<span class="ov-name-t">벌금 순위</span>' +
      cols.map(function (c) {
        return '<span class="ov-chead' + (c.r ? " rl" : "") + '">' +
          (c.r ? '<i class="ov-rlmk">\u25ce</i>' : "") + esc(c.t) + "</span>";
      }).join("") +
      (showSum
        ? '<span class="ov-total">' +
          manShort(board.reduce(function (a, r) { return a + (r.g || 0); }, 0)) + "</span>"
        : "") +
      (showNet ? '<span class="ov-nethead">순액</span>' : "");
    fitCheads(); // 머리줄을 그린 뒤에 — 확대(fitBoard) 전에 크기를 정해야 합니다
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
        if (m.kind === "dead") {
          dead = true; board = null; spin = null; play = null;
          next = null; fxQ = []; fxCard = null; clearTimeout(fxTimer);
        } else if (m.kind === "state") {
          dead = false;
          var st = m.state || {};
          /* 판은 바로 그리지 않고 담아 둡니다 — 연출이 다 끝나야 앉힙니다 */
          next = {
            board: st.board ? st.board : null,
            cols: st.cols || [],
            net: !(st.ovNet === false),
            sum: !(st.ovSum === false),
          };
          applyFxCfg(st);
          ingestFx(st.fx);
          /* 룰렛도 같은 줄에 세웁니다 — 도착한 자리에서 차례를 기다립니다 */
          var sp = st.spin || null;
          if (sp && sp.sid !== doneSid && !fxSeen["S" + sp.sid] && (!play || play.sp.sid !== sp.sid)) {
            fxSeen["S" + sp.sid] = 1;
            pendSpin = sp; // 큐가 아니라 위층
          }
          spin = sp;
          /* 재생 중에는 pump 가 일찍 빠져나가 render 가 안 돕니다 —
             돌고 있는 판의 최신 상태(양도 대기·답 도착)는 여기서 직접 이어 줍니다 */
          /* 지금 돌고 있는 그 판일 때만 갱신합니다 — 다음 판이 먼저 도착해도
             재생 중인 판을 덮어쓰면 엉뚱한 결과로 멈춥니다 */
          if (play && spin && spin.sid === play.sp.sid) {
            play.sp = spin;
            var nf = spFree(spin);
            if (nf && !play.free) enterFree();
            else if (!nf && play.free) leaveFree();
            else {
              drawPlay();
              /* 다음 면을 기다리다 답이 왔습니다 — 안 깨우면 판이 안 끝납니다 */
              if (play.waiting) {
                play.waiting = false;
                clearTimeout(stepTimer);
                stepTimer = setTimeout(stepPlay, 0);
              }
            }
          } else if (play && !spin) {
            /* 서기가 판을 닫았습니다 — 다음 면을 기다리던 것을 풀고 제 시계로 끝냅니다.
               안 그러면 오지 않을 답을 영원히 기다리며 표까지 붙잡고 있습니다. */
            play.appGone = true;
            if (play.free) leaveFree();
            else if (!stepTimer) stepTimer = setTimeout(stepPlay, OV_HOLD);
          }
          name = st.name || "";
          applyLook(st.look);
        } else return;
        wait = 1000;
        if (dead) render();
        else pump();
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
