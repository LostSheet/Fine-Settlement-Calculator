/* ---------------- 공유 주소가 가는 두 곳 ----------------
   OBS 브라우저 소스(window.obsstudio 주입됨) → 여기서 투명 오버레이를 그립니다.
   일반 브라우저 → 앱의 읽기 전용 화면으로 넘깁니다. 뷰어는 장부 관리자와 같은 3탭을 봐야 하고,
   그 화면은 앱이 이미 갖고 있으니 여기서 다시 그리지 않습니다.
   주소는 둘입니다: /r/방주소(초대 코드는 해시 #j=)와 /o/방송용토큰(계정이 지금 있는 방).
   같은 파일이 __ROOM__ / __OTOK__ 중 하나만 채워진 채로 서빙됩니다. */

export const APP_URL = "https://lostsheet.github.io/Fine-Settlement-Calculator/";

export const PAGE_HTML = `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>벌금 현황판</title>
<!-- 방송용 글꼴 (2026-09-08 사용자 확정) — 시스템 고딕으로는 어떤 형태를 씌워도
     방송 그래픽으로 안 읽힙니다. 못 받아오면 조용히 아래 폴백으로 떨어집니다(§0 침묵). -->
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Gothic+A1:wght@500;600;700;800&display=swap">
<style>
  :root{--ink:#f5f0e6; --gold:#e8c66a}
  *{margin:0; padding:0; box-sizing:border-box}
  /* 뷰포트에 고정해서 자릅니다 — 높이를 안 주면 overflow:hidden 이 확대 전 높이에서
     잘라, contain 으로 커진 판의 아래가 사라집니다 (OBS에서 그렇게 잘렸습니다) */
  html,body{background:transparent; overflow:hidden; width:100%; height:100%}
  body{font-family:'Gothic A1','Segoe UI','Malgun Gothic',sans-serif; color:var(--ink)}

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
  /* 이름과 순위는 어느 경우에도 또렷합니다 (2026-09-07 사용자). 흐림은 값 칸이 말합니다 —
     줄 전체를 흐리게 하면 "아직 안 낸 사람"이라는 말이 이름과 등수까지 지워 버립니다.
     (폐기 2026-09-07) 순위 opacity .68 · 줄 전체 .ov-row.zero 의 opacity .5
     — 이 파일은 통째로 템플릿 문자열이라 주석에도 백틱을 쓰면 거기서 문자열이 끊깁니다 */
  .ov-rank{width:5.2vw; font-size:3.6vw; font-variant-numeric:tabular-nums;
    flex:none; align-self:center; text-align:center}
  /* 순위 변동 자리 — 비어 있어도 폭을 차지해서 이름 열이 밀리지 않습니다 */
  .ov-move{width:5.6vw; flex:none; font-size:2.9vw; font-weight:700; text-align:center;
    font-variant-numeric:tabular-nums; align-self:center}
  /* min-width 는 setGoldW 가 이름을 굵게 재서 정합니다 (2026-09-08) — 1위가 굵어질 때
     칸이 늘어 판이 넓어지고, 그 폭으로 fitBoard 가 배율을 다시 잡던 밀림을 막습니다 */
  .ov-name{flex:1; min-width:var(--namew, 6vw); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; padding-right:1.6vw}
  /* 항목은 표의 열로 세웁니다 — 이름 밑에 늘어놓으면 방송에서 안 읽힙니다.
     열이 늘면 판이 가로로 넓어집니다 (width:fit-content) */
  .ov-cnum{width:6.4vw; flex:none; text-align:center; font-size:3.4vw;
    font-variant-numeric:tabular-nums; opacity:.9}
  .ov-cnum.rl{color:var(--ink)}
  .ov-cnum.z{opacity:.3} /* 0 은 흐리게 보이되 읽힙니다 (2026-09-06: 빈칸 → 0) */
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
    padding:.1vw .8vw; background:rgba(20,17,14,.72)} /* 각진 칩 (2026-09-08) — 판 위에 직접 얹히는 조각이라 막대와 같은 결로 */
  /* 밝은 판·진한 글자 테마에서는 칩도 밝게 */
  html[data-t="light"] .ov-delta, html[data-t="cleardark"] .ov-delta{background:rgba(248,244,236,.85)}
  .ov-delta.plus{color:#8fd89b}
  /* 비어 있을 때는 칩 배경만 남지 않도록 아예 감춥니다 */
  .ov-delta:empty{display:none}
  /* 순액이 꺼져 있으면 칩은 판 바깥(투명 영역)으로 나갑니다 — 카드를 넓히지 않으니
     판이 작아지지 않고, OBS 소스에 어차피 남던 여백을 대신 씁니다.
     잘리지 않게 fitBoard 가 그 튀어나온 만큼을 폭에 얹어서 배율을 잽니다. */
  /* 아직 아무것도 안 낸 줄 — 이름·등수는 그대로 두고 값 칸만 물러납니다 (2026-09-07 사용자) */
  .ov-row.zero .ov-gold{opacity:.5; --slop:.5}
  /* 슬라이드 모드 (2026-09-06 사용자 확정) — 항목 열과 순액을 늘어놓지 않고 합계 자리에서 번갈아 보여 줍니다.
     판이 절반 폭이 되어 같은 면적에서 글자가 두 배가 됩니다. 값은 왼쪽으로 나가고 오른쪽에서 들어옵니다
     (표의 자연스러운 순서 항목 → 합계 → 순액 방향 — 사용자). 줄마다 30ms 씩 늦춰 물결처럼 */
  /* --slop 은 "이 칸이 다 들어왔을 때의 밝기"입니다 (2026-09-07 사용자 지적).
     미끄러지는 애니메이션이 opacity:1 로 끝나던 동안에는 흐려야 할 값(0회·순액·항목)이
     진하게 들어왔다가 애니메이션이 걷히는 순간 제 밝기로 뚝 떨어졌습니다. 나갈 때도 한 번 밝아졌고요.
     그래서 끝점을 1 이 아니라 그 칸의 밝기로 잡습니다 — 흐린 값은 흐린 채로 들어오고 나갑니다. */
  .ov-gold.as-cnt{color:var(--ink); opacity:.92; --slop:.92}
  .ov-gold.as-cnt.z{opacity:.3; --slop:.3}
  .ov-gold.as-net{color:var(--ink); opacity:.5; --slop:.5}
  .ov-gold.as-net.plus{color:#6fb4ff; opacity:1; --slop:1}
  .ov-gold.as-net.minus{color:#ff7d6b; opacity:1; --slop:1}
  .ov-total.as-lab{color:var(--ink); opacity:.88; --slop:.88; font-weight:600; overflow:visible}
  .sl-out{animation:ov-sl-out 260ms cubic-bezier(.4,0,.8,.4) both}
  .sl-in{animation:ov-sl-in 260ms cubic-bezier(.2,.6,.3,1) both}
  @keyframes ov-sl-out{from{transform:translateX(0); opacity:var(--slop,1)} to{transform:translateX(-45%); opacity:0}}
  @keyframes ov-sl-in{from{transform:translateX(45%); opacity:0} to{transform:translateX(0); opacity:var(--slop,1)}}
  @media (prefers-reduced-motion:reduce){ .sl-out,.sl-in{animation:none} }

  /* 벌금 알림 — 룰렛과 같은 결의 카드. 원판과 달리 글자 두 줄뿐이라 크게 잡을 필요가
     없어서, 소스 크기를 재지 않고 내용에 맞춰 세웁니다. */
  /* 카드만 뜹니다 — 뒤를 어둡게 깔지 않습니다. 소스가 화면 모퉁이의 작은 상자라
     막을 깔면 그 상자 전체가 어두워질 뿐, 얻는 게 없습니다. */
  /* 카드는 한 칸에 겹쳐 쌓입니다(grid) — 다음 카드가 옛 카드 위에서 번져 나오고 옛 것은 그 뒤에 걷힙니다.
     (폐기 2026-09-07) 컨테이너를 비웠다가 다시 채우던 것 — 카드 사이 0.2초 동안 뒤의 벌금판 글자가 비쳐 보여 부자연스러웠다(사용자) */
  #ovfx:not(:empty){position:fixed; inset:0; z-index:3; display:grid;
    place-items:center; padding:2%;
    pointer-events:none; animation:ov-spin-in .18s ease-out}
  #ovfx > .ov-fx{grid-area:1/1}
  /* 평평하게 — 조명·광택 없이 색 하나와 얇은 테두리로만 */
  /* 룰렛 결과 카드 — 방금 본 바퀴의 것이라고 표시합니다 */
  /* 두 조각 카드 (2026-09-08 사용자 확정) — 머리 바와 같은 문법입니다: 먹색 이름 블록과
     금색 값 블록, 사이에 크림색 띠. 방송에서 정작 봐야 하는 건 아래 줄(항목 + 금액)이라
     그쪽이 제 블록을 갖습니다. (폐기) 둥근 상자 + 금색 얇은 테두리 — 판이 둥근 반투명이던 시절의 마감 */
  .ov-fx.roul{box-shadow:0 0 0 .26vw rgba(232,198,106,.85)}
  .ov-fx.roul b::before{content:"◎ "; color:#dcae5e}
  .ov-fx{max-width:86%; text-align:center; color:#ece4d6;
    animation:ov-fx-in .2s cubic-bezier(.2,1.3,.4,1);
    background:none; border:0; padding:0}
  /* 카드가 이어질 땐 카드 한 장을 그대로 두고 속만 바꿉니다 (2026-09-07 사용자 확정: 카드는 한 장, 대신 다른 사건임을 알린다).
     옛 글이 0.07초 사라진 뒤 새 글이 0.14초 나타나고(두 글이 겹치지 않음), 그 순간 카드가 4% 부풀며 테두리가 금색으로
     번쩍합니다 — 그것이 "다른 건"이라는 신호. 글은 움직이지 않습니다(사용자: 글이 흐를 이유가 없다).
     (폐기, 같은 날) 새 카드를 옛 카드 위에 내려앉히기 · 새 카드를 투명에서 겹치기 · 비웠다 채우기 — 겹치거나 판이 비쳤다 */
  .ov-fx-body{display:block}
  .ov-fx-body.fade{animation:ov-fx-fade .07s ease-in forwards}
  .ov-fx-body.rise{animation:ov-fx-rise .14s ease-out}
  @keyframes ov-fx-fade{to{opacity:0}}
  @keyframes ov-fx-rise{from{opacity:0}}
  .ov-fx.bump{animation:ov-fx-bump .28s ease-out}
  /* 각진 링으로 (2026-09-08) — 테두리가 없어져서 번쩍임은 바깥 그림자 하나가 맡습니다.
     연출 자체는 그대로입니다: 4% 부풀며 한 번 번쩍이는 것이 "다른 건"이라는 신호 */
  @keyframes ov-fx-bump{
    0%{transform:scale(1)} 35%{transform:scale(1.04); box-shadow:0 0 0 .6vw rgba(232,198,106,.34)}
    100%{transform:scale(1); box-shadow:0 0 0 0 rgba(232,198,106,0)}}
  .ov-fx b{display:block; font-size:6.4vw; font-weight:700; line-height:1.1;
    overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
    background:#17130e; padding:2.6vw 5vw}
  .ov-fx span{display:block; font-size:4.2vw; white-space:nowrap; font-weight:800;
    background:#e8c66a; color:#17130e; padding:1.5vw 5vw;
    border-top:.6vw solid rgba(245,240,230,.75)}
  /* 금색 바탕에서는 어두운 판의 청·녹·적이 떠 버립니다 — 밝은 판 테마에서 이미 검증한
     값을 그대로 씁니다(크림 바탕 명도대비 4.8~4.9). §4.4 밝은 판의 색과 같은 가족입니다 */
  .ov-fx em{font-style:normal; font-weight:800}
  .ov-fx.up em{color:#2f7a4d}
  .ov-fx.dn em{color:#b8462f}
  @keyframes ov-fx-in{from{opacity:0; transform:scale(.86)} to{opacity:1; transform:scale(1)}}
  /* 마지막 카드는 번져 사라집니다 — 뚝 꺼지지 않게 (2026-09-07) */
  .ov-fx.out{animation:ov-fx-out .17s ease-in forwards}
  @keyframes ov-fx-out{to{opacity:0; transform:scale(.94)}}

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
    .ov-fx,.ov-fx.out,.ov-fx.bump,.ov-fx-body.rise{animation:none}
    .ov-fx-body.fade{display:none}
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
  /* 룰렛은 카드 위입니다 (2026-09-08 사용자 지적 → 고침, §4.4 규칙 3).
     둘 다 z-index:3 이었고 #ovfx 가 DOM 에서 뒤라, 떠 있던 클릭 알림이 원판을 덮었습니다 */
  #ovspin:not(:empty){position:fixed; inset:0; z-index:4; display:flex;
    align-items:center; justify-content:center; padding:2%;
    animation:ov-spin-in .18s ease-out}
  @keyframes ov-spin-in{from{opacity:0} to{opacity:1}}
  /* 각진 평면 상자 (2026-09-08 사용자 확정) — 원판은 그대로 두고 담는 상자만 바꿉니다.
     (폐기) 둥근 모서리 · 방사형 그라데이션 · 안팎 그림자 — 조명과 광택이 있던 마감 */
  .ov-sp{position:relative; display:flex; width:96%; max-height:100%; text-align:center;
    color:#ece4d6; background:#17130e;
    border:calc(var(--u)*.4) solid rgba(232,198,106,.75)}
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
  /* 각진 칩 (2026-09-08). 점선 슬롯은 그대로 — 빈 칸이라는 뜻이 대기실 빈 자리와 같은 말입니다 */
  .ov-tchip,.ov-tslot{width:calc(var(--u)*11); height:calc(var(--u)*5.4);
    flex:none; display:flex; align-items:center; justify-content:center;
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
    overflow:hidden; background:#1b1611;
    border:calc(var(--u)*.4) solid rgba(232,198,106,.55);
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
    padding:calc(var(--u)*.7) calc(var(--u)*2.2)} /* 각진 알약 (2026-09-08) */
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
  /* 번쩍임은 배경을 갈아치우지 않고 그 위에 얹힙니다 (2026-09-08 사용자 지적 → 고침).
     옛 규칙은 to{background:transparent} 였는데, 줄이 제 배경을 갖는 막대 테마에서는
     1.6초 동안 막대가 통째로 사라졌다가 애니메이션이 끝나며 뚝 돌아왔습니다
     (실측: 검정 → 노랑 → 투명 → 검정). inset 그림자는 배경 위·글자 아래에 깔려서
     어느 테마든 줄의 제 배경을 안 건드립니다. 등수 블록은 반투명이라 같이 물듭니다 */
  @keyframes ov-flash{
    from{box-shadow:inset 0 0 0 100vmax rgba(232,198,106,.28)}
    to{box-shadow:inset 0 0 0 100vmax rgba(232,198,106,0)}
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
  /* 밝은 판의 청·적·녹 (2026-09-07 사용자 지적) — 어두운 판 것을 그대로 쓰던 색들은 크림색 바탕에서
     떠 버려 안 읽혔습니다. 개인 합계의 황색(--gold #8a6415)과 같은 무게로 낮춥니다 —
     셋 다 이 바탕에서 명도대비 4.8~4.9 로, 황색의 4.7 과 한 가족입니다 */
  html[data-t="light"]{--up:#2f7a4d; --dn:#b8462f; --net-up:#2c6ea4}
  html[data-t="light"] .ov-net.plus, html[data-t="light"] .ov-gold.as-net.plus{color:var(--net-up)}
  html[data-t="light"] .ov-net.minus, html[data-t="light"] .ov-gold.as-net.minus{color:var(--dn)}
  html[data-t="light"] .ov-delta.plus, html[data-t="light"] .ov-move.up,
  html[data-t="light"] .ov-mvreel.up > i.d{color:var(--up)}
  html[data-t="light"] .ov-delta.minus, html[data-t="light"] .ov-move.down,
  html[data-t="light"] .ov-mvreel.dn > i.d{color:var(--dn)}
  /* 줄 사이 실선은 판 테마의 기본입니다 (2026-09-07 사용자 확정) — 예전엔 테두리 테마에만 있었습니다.
     어두운 판엔 밝은 선, 밝은 판엔 어두운 선. 판 없는 테마엔 그을 판이 없어 안 그립니다 */
  html[data-t="dark"] .ov-row + .ov-row{border-top:max(1px, .1vw) solid rgba(245,240,230,.1)}
  html[data-t="light"] .ov-row + .ov-row{border-top:max(1px, .1vw) solid rgba(34,28,20,.12)}
  /* 헤어라인 (2026-09-06 사용자 확정) — 이제 판을 두르는 바깥 선만 맡습니다.
     그 이상은 없습니다(사용자: 과한 건 별로) */
  html[data-line="1"][data-t="dark"] .ov{border:max(1px, .14vw) solid rgba(232,198,106,.55)}
  html[data-line="1"][data-t="light"] .ov{border:max(1px, .14vw) solid rgba(34,28,20,.5)}

  /* ---- 기본 테마 = 막대 줄 (2026-09-08 사용자 확정) ----
     판을 버리고 줄마다 각진 막대를 세웁니다. 막대 사이로 게임 화면이 비쳐서
     불투명한데도 판보다 덜 가립니다. 머리는 두 조각 — 제목 블록과 금색 지표 블록.
     1위는 막대를 채우지 않고 등수·이름만 금색입니다(사용자 확정). */
  html[data-t="bars"] .ov{padding:0}
  html[data-t="bars"] .ov-head{background:rgba(23,19,14,var(--bg,.9));
    align-items:center; padding:1vw 1.6vw; margin-bottom:1.02vw}
  html[data-t="bars"] .ov-head::after{display:none}
  /* 제목을 판 왼쪽 끝으로 당기던 음수 여백은 블록 안에서는 제목을 바깥으로 밀어냅니다.
     빈 등수·변동 칸은 없앱니다 — 이름 열이 flex:1 이라 뒤의 열은 그대로 맞습니다 */
  html[data-t="bars"] .ov-head > .ov-rank,
  html[data-t="bars"] .ov-head > .ov-move{display:none}
  html[data-t="bars"] .ov-name-t, html[data-t="bars"] .ov-lobby-t{margin-left:0;
    font-size:3.3vw; font-weight:700; letter-spacing:.05em}
  /* 금색 블록 — 합계·지표 라벨·대기실 인원이 같은 자리에 섭니다. 왼쪽 크림색 띠는
     box-shadow 라 자리를 안 먹습니다: 열 간격을 그대로 덮어서 칸 정렬이 안 틀어집니다 */
  html[data-t="bars"] .ov-total, html[data-t="bars"] .ov-lobby-n{
    background:var(--gold); color:#17130e; opacity:1; font-weight:800;
    align-self:stretch; display:flex; align-items:center; justify-content:flex-end;
    margin:-1vw 0; padding:0; min-width:9.5vw;
    box-shadow:-1.6vw 0 0 0 rgba(245,240,230,.75)}
  /* 좌우 여백을 주면 안 됩니다 — 폭이 --goldw(테두리 기준)라 여백만큼 속이 좁아져서
     그 폭에 딱 맞는 값이 잘립니다(총액이 굴러갈 때의 증감 줄에서 봤습니다).
     --goldw 는 "999만"을 밑값으로 잡아 두어 보통은 글자보다 넓으니 여백 없이도 숨이 붙습니다 */
  html[data-t="bars"] .ov-total.as-lab{color:#17130e; opacity:1}
  /* 금색 블록 안의 증감은 어두운 짝으로 (2026-09-08 사용자 지적: 황색 띠에 녹색이 안 보인다).
     총액이 굴러갈 때 그 사이에 끼는 증감 한 줄(.ov-mvreel > i.d)이 금색 바탕에 떠 버립니다.
     녹색과 적색은 한 쌍이라 같이 내립니다 — 밝은 판 테마에서 크림 바탕에 대고 검증한 값
     (--up #2f7a4d / --dn #b8462f)을 그대로 씁니다. 어두운 막대 위의 밝은 짝은 그대로입니다 */
  html[data-t="bars"] .ov-total .ov-mvreel.up > i.d{color:#2f7a4d}
  html[data-t="bars"] .ov-total .ov-mvreel.dn > i.d{color:#b8462f}
  /* 오른쪽 끝까지 채우는 건 금색 블록이 머리줄의 마지막 칸일 때만입니다 (슬라이드 모드).
     순액 열이 켜진 나란히 모드에서는 순액 머리가 끝이라, 여기서 여백을 먹으면 머리줄 전체가
     1.6vw 밀려 열이 줄과 어긋납니다 (2026-09-08 실측: 머리 172만이 줄 금액보다 27px 오른쪽) */
  html[data-t="bars"] .ov-head > .ov-total:last-child,
  html[data-t="bars"] .ov-head > .ov-lobby-n:last-child{margin-right:-1.6vw;
    padding-right:1.6vw; box-sizing:content-box}
  /* 오른쪽 여백 1.6vw 는 줄의 오른쪽 안쪽 여백과 같은 값이라, 블록 안의 글자가 아래
     금액들과 같은 선에서 끝납니다. content-box 라 그 여백이 --goldw 를 안 먹습니다 —
     border-box 로 두면 그 폭에 딱 맞는 값이 잘립니다(총액이 굴러갈 때의 증감 줄에서 봤습니다).
     음수 바깥 여백이 그만큼을 도로 걷어서 뒤 칸의 자리는 그대로입니다 */
  html[data-t="bars"] .ov-chead, html[data-t="bars"] .ov-nethead{align-self:center}
  /* 줄 = 막대. 사이 간격이 판 노릇을 합니다 */
  html[data-t="bars"] .ov-row{background:rgba(20,17,14,var(--bg,.9)); border-radius:0;
    padding:.85vw 1.6vw .85vw 0}
  /* 간격은 막대 '사이'에만 둡니다 — 마지막 막대에 아래 여백을 달면 판(.ov)에 안쪽 여백이
     없어서 그 여백이 판 밖으로 빠져나가고(마진 상쇄), fitBoard 가 그만큼 짧게 재서
     맨 아래 막대가 잘렸습니다 (2026-09-08 실측: 836px 로 재고 실제는 840px) */
  html[data-t="bars"] .ov-row + .ov-row{border-top:none; margin-top:.34vw}
  html[data-t="bars"] .ov-rank{align-self:stretch; display:flex; align-items:center;
    justify-content:center; background:rgba(8,7,6,.55); width:6.4vw; margin:-.85vw 0}
  /* 대기실 빈 자리는 채우지 않고 점선만 — 이 앱에서 점선이 이미 뜻하는 것(빈 칸·빈 줄·
     아직 아무도 없는 자리)과 말이 맞습니다. outline 은 자리를 안 먹어 막대 크기가 그대로입니다 */
  html[data-t="bars"] .ov-lbrow.lb-empty{background:none;
    outline:max(1px, .2vw) dashed rgba(245,240,230,.34);
    outline-offset:calc(-1 * max(1px, .2vw))}
  html[data-t="bars"] .ov-lbrow.lb-empty .ov-rank{background:none}
  /* 점선은 막대당 하나입니다 — 테두리가 이미 '빈 자리'라고 말하는데 이름 칸에도 점선을 그으면
     한 줄에 점선이 둘입니다. 판 테마에서는 반대로 이름 칸 점선만 있습니다 */
  html[data-t="bars"] .ov-lbrow.lb-empty .ov-name::after{display:none}
  /* 이름이 없으면 줄 상자가 등수 글자 높이로 주저앉아 빈 막대만 낮아집니다 —
     보이지 않는 한 글자로 이름 칸의 줄 높이를 세웁니다 (2026-09-08 실측) */
  html[data-t="bars"] .ov-lbrow.lb-empty .ov-name::before{content:"\\00a0"}
  /* 대기실 줄은 번호·이름 두 칸뿐이라 벌금표보다 짧습니다 — 변동·금액 칸만큼 자리를 비워
     폭을 맞춥니다. 시작하는 순간 판이 옆으로 안 벌어집니다 (2026-09-08 사용자 확정) */
  html[data-t="bars"] .ov-lbrow::after{content:''; flex:none; width:16.7vw}
  /* 발치 문구도 막대 하나 — 판이 없어져서 맨 글자로 두면 밝은 화면에서 사라집니다 */
  html[data-t="bars"] .ov-lobby-note{background:rgba(23,19,14,var(--bg,.9));
    margin-top:1.02vw; padding:.85vw 1.6vw; opacity:1; color:rgba(245,240,230,.78)}

  /* ---- 밝은 판에서는 카드와 룰렛도 밝게 (2026-09-08 사용자 확정) ----
     형태(각진 블록)는 테마와 무관하게 한 벌이고, 뒤집는 것은 색뿐입니다.
     금색 값 블록은 양쪽에서 그대로 둡니다 — 채운 강조색이라 어느 바탕에서나 섭니다.
     기본·어두운 판·그 밖의 테마는 아래를 안 타서 어두운 카드 그대로입니다 */
  html[data-t="light"] .ov-fx b{background:#f8f4ec; color:#221c14}
  html[data-t="light"] .ov-fx span{border-top-color:rgba(34,28,20,.5)}
  html[data-t="light"] .ov-sp{background:#f8f4ec; border-color:rgba(34,28,20,.5)}
  html[data-t="light"] .ov-sp-who{color:#221c14}
  html[data-t="light"] .ov-sp-item,
  html[data-t="light"] .ov-sp-delta{color:#6b6154}
  html[data-t="light"] .ov-sp-delta b{color:#221c14}
  html[data-t="light"] .ov-sp-out{color:#8a6415}
  html[data-t="light"] .ov-sp-out em{color:#6b6154}
  html[data-t="light"] .ov-stage-out .ov-sp-out{color:#221c14;
    text-shadow:0 calc(var(--u)*.5) calc(var(--u)*2) rgba(255,255,255,.75)}
  html[data-t="light"] .ov-sp-gone{background:rgba(248,244,236,.92);
    border-color:rgba(34,28,20,.4); color:#8a6415}
  html[data-t="light"] .ov-tchip{background:#e9e2d4; border-color:rgba(34,28,20,.35); color:#221c14}
  html[data-t="light"] .ov-tchip.pass{color:#b8462f; border-color:#b8462f}
  html[data-t="light"] .ov-tchip.mult{color:#8a6415; border-color:#b97f37}
  html[data-t="light"] .ov-tslot{border-color:rgba(34,28,20,.3)}
  html[data-t="light"] .ov-tslot.next{border-color:rgba(34,28,20,.7)}
  html[data-t="light"] .ov-reel{background:#efe8da; border-color:rgba(34,28,20,.4)}
  html[data-t="light"] .ov-reel-n.big{color:#221c14; text-shadow:none}
  html[data-t="light"] .ov-reel-n.side{color:#221c14}
  html[data-t="light"] .ov-reel-line{border-color:rgba(34,28,20,.35)}

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

  /* 미리보기의 예시 리본 (§4.4) — 미리보기 창에만 존재하는 요소라 방송에는 못 샙니다 */
  .ov-sample{position:fixed; left:0; right:0; bottom:0; padding:10px 14px; font-size:13px; line-height:1.5;
    color:rgba(255,255,255,.92); background:rgba(20,20,20,.78); text-align:center; letter-spacing:.01em}
  /* 방송 중이 아님이 확인될 때만 JS가 켭니다 */
  .ov-notice{display:none; font-size:2.6vw; line-height:1.6; color:#f0b8b0; padding:1.2vw 1.6vw;
    text-shadow:0 1px 3px rgba(0,0,0,.9)}
  html[data-notice="1"] .ov-notice{display:block}

  /* /o/ 를 브라우저로 열었을 때의 한 줄 — 판별이 틀려 방송에 새더라도 이 한 줄이면 되게
     작고 낮은 채도로, 판 위에 얹기만 합니다 (§4.4). vw 가 아니라 px 이라 소스가 커져도
     같이 커지지 않습니다.
     색은 판의 테마를 안 따릅니다 — 이 줄이 앉는 자리는 판이 아니라 그 바깥(방송에서는
     게임 화면, 브라우저에서는 빈 바탕)이라, 어느 바탕에서도 읽히게 옅은 칩을 깔았습니다 */
  .ov-hint{position:fixed; left:0; right:0; bottom:0; z-index:9; pointer-events:none;
    text-align:center; padding:6px 10px}
  .ov-hint b{display:inline-block; font-weight:400; font-size:12px; line-height:1.5;
    padding:3px 10px; border-radius:99px;
    background:rgba(16,13,10,.5); color:rgba(240,235,225,.62)}
  /* 그 줄 안의 문 — 읽기 화면을 없애면 가입 없이 쓰는 사람이 정산 장부·보낼 우편을
     못 보게 되므로, 브라우저로 열린 이 자리에 길을 남깁니다 (§8) */
  .ov-hint a{pointer-events:auto; margin-left:8px; color:rgba(240,235,225,.9);
    text-decoration:underline; text-underline-offset:2px}

  /* 대기실 — 아직 판이 없으니 이름만 한 줄로 잇습니다. 표와 같은 판(.ov) 안에 앉습니다.
     제목은 .ov-name-t 를 안 씁니다 — 거기 붙은 음수 여백(순위·변동 열을 넘어가는 장치)이
     열 없는 대기실에서는 제목을 판 밖으로 밀어냅니다 */
  .ov-lobby-t{flex:1; min-width:6vw; font-size:4.2vw; font-weight:600; letter-spacing:.03em;
    overflow:hidden; text-overflow:ellipsis; white-space:nowrap}
  /* (폐기 2026-09-08) .ov-lobby — 이름을 한 줄로 잇던 자리 */
  .ov-lobby-n{font-size:3vw; font-weight:600; opacity:.8; font-variant-numeric:tabular-nums; flex:none}
  .ov-lobby-note{font-size:2.6vw; opacity:.66; padding:.5vw .4vw .1vw}
  /* 대기실 줄 — 벌금표의 .ov-row 를 그대로 쓰고, 빈 자리와 아직 안 들어온 사람만 다르게 (2026-09-08 사용자 확정 B안) */
  .ov-lbrow .ov-name{position:relative}
  .ov-lbrow.lb-typed .ov-name{opacity:.55}
  .ov-lbrow.lb-empty .ov-name::after{content:''; position:absolute; left:0; right:30%; top:50%;
    border-top:.18vw dashed currentColor; opacity:.28}
  .ov-lbrow.lb-empty .ov-rank{opacity:.34}
  /* 발치 문구 — 아래에서 올라오고 위로 걷힙니다. 점은 자리를 늘 차지해 글이 흔들리지 않습니다 */
  .ov-lobby-note{overflow:hidden}
  .ov-note-in{display:inline-block; transition:transform .24s ease, opacity .24s ease}
  .ov-note-in.out{transform:translateY(-.7em); opacity:0}
  .ov-note-in.in{animation:ov-note-up .28s ease-out}
  .ov-note-tx{font-weight:inherit}
  .ov-dots{font-style:normal; display:inline-block; width:1.6em; text-align:left}
  @keyframes ov-note-up{from{transform:translateY(.7em); opacity:0} to{transform:none; opacity:1}}
  @media (prefers-reduced-motion:reduce){ .ov-note-in{transition:none} .ov-note-in.in{animation:none} }

  @media (prefers-reduced-motion:reduce){ .ov-row{transition:none} }
</style>
</head>
<body><div id="app"></div>
<script>
(function () {
  /* 두 주소가 이 한 페이지로 옵니다. /r/방주소 면 ROOM 만, /o/방송용토큰 이면 OTOK 만 찹니다 */
  var ROOM = "__ROOM__";
  var OTOK = "__OTOK__";
  /* 초대 코드는 해시에 실려 옵니다 — 서버로 안 가는 자리라 방송 화면에 덜 남습니다 */
  var JCODE = (location.hash.match(/[#&]j=([A-Za-z0-9]+)/) || [])[1] || "";
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
  /* /o/ 는 판별하지 않습니다 (§4.4). 방송 프로그램은 종류가 많고(프리즘·vMix·트위치
     스튜디오…), 판별에 실패하면 방송에 앱 화면이 통째로 뜹니다. 이 주소의 임무는 하나
     (방송 소스)이므로 그것을 무조건 실행하고, ?mode=page 만 예외로 둡니다.
     /r/ 의 두 얼굴(브라우저→앱, 방송→오버레이)은 그대로입니다. */
  var inOBS = forced === "overlay" || (forced !== "page" && (!!OTOK || inCast));

  /* 브라우저로 열었으면 앱의 읽기 전용 화면으로 넘깁니다 (예시도 같습니다).
     오버레이만 보고 싶으면 주소 뒤에 ?mode=overlay 를 붙이면 됩니다. */
  if (!inOBS) {
    var dest = "__APP__";
    if (location.hostname === "localhost" || location.hostname === "127.0.0.1")
      dest = "http://localhost:5175/";
    /* 초대 코드는 그대로 앱에 넘깁니다 — 앱이 로그인 뒤 그 코드로 참여합니다 */
    location.replace(dest + (OTOK ? "#o=" + OTOK
      : "#live=" + ROOM + (JCODE ? "&j=" + JCODE : "")));
    return;
  }

  var root = document.documentElement;
  root.dataset.mode = "overlay";
  /* fit=1 이면 미리보기 창입니다. 진짜 OBS 안에서는 절대 켜지지 않게 한 번 더 막습니다 */
  var isPreview = q.get("fit") === "1" && !window.obsstudio;
  if (isPreview) root.dataset.preview = "1";
  /* 기본은 어디서든 읽히는 막대 줄(bars). 주소에 직접 적은 테마가 있으면 그쪽이 우선 */
  var urlTheme = q.get("t");
  var urlBg = q.get("bg");
  var urlS = q.get("s");
  var urlLine = q.get("line"); // 헤어라인 (2026-09-06) — 주소에 적으면 그쪽이 우선
  root.dataset.t = urlTheme || "bars";
  if (urlLine != null) root.dataset.line = urlLine === "1" ? "1" : "0";
  var bg = parseInt(urlBg, 10);
  if (!isNaN(bg)) root.style.setProperty("--bg", Math.min(100, Math.max(0, bg)) / 100);
  var s = parseInt(urlS, 10);
  if (!isNaN(s)) document.body.style.fontSize = Math.min(300, Math.max(50, s)) + "%";

  /* 외형이 오는 곳은 셋입니다: 주소 파라미터(t/bg/s) > 계정 외형(resolve.look) > 판의 look.
     계정 외형은 "OBS는 한 번만 넣는다"를 지키려고 서버에 둔 값이라(§4.4), 방장이 고른
     판의 look 보다 셉니다 — 오버레이 주소 하나가 사람 하나의 것이라서요. */
  var acctLook = null;
  /* 계정 외형 중 판 그림에 관한 것들 — 없으면(undefined) 판의 값을 씁니다 (2026-09-07).
     룰렛은 여기 없습니다: 원판·테마·감속은 방장 것이라 판이 정합니다 */
  var acctFlag = function (k) {
    if (!acctLook || acctLook[k] === undefined || acctLook[k] === null) return null;
    return !!acctLook[k];
  };
  var acctOff = function () {
    return acctLook && Object.prototype.toString.call(acctLook.off) === "[object Array]" ? acctLook.off : null;
  };
  var applyLook = function (lk, fromAcct) {
    if (!lk || typeof lk !== "object") return;
    if (fromAcct) acctLook = lk;
    else if (acctLook) return;
    if (!urlTheme) root.dataset.t = typeof lk.t === "string" ? lk.t : "bars";
    if (urlLine == null) root.dataset.line = lk.line ? "1" : "0";
    if (urlBg == null && lk.bg != null)
      root.style.setProperty("--bg", Math.min(100, Math.max(0, lk.bg)) / 100);
    if (urlS == null && lk.s != null) {
      var ls = parseInt(lk.s, 10);
      if (!isNaN(ls)) document.body.style.fontSize = Math.min(300, Math.max(50, ls)) + "%";
    }
  };

  /* 마지막으로 받은 판 그대로 — 외형이 바뀌면 이걸 다시 입혀서 그립니다 */
  var lastState = null;
  /* 판이 온 그대로가 아니라 "내 계정 설정을 입힌 판"을 그립니다 (2026-09-07).
     슬라이드·합계·순액은 내 값이 있으면 그걸로, 없으면 판의 값으로.
     끈 열은 열 머리와 각 줄의 숫자를 같은 자리에서 같이 빼야 표가 안 어긋납니다. */
  var viewOf = function (st) {
    if (!st) return null;
    var cols = st.cols || [];
    var board = st.board ? st.board : null;
    var off = acctOff();
    if (off && off.length && cols.length) {
      var keep = [];
      for (var i = 0; i < cols.length; i++)
        if (!(cols[i] && cols[i].id != null && off.indexOf(cols[i].id) >= 0)) keep.push(i);
      if (keep.length !== cols.length) {
        var src = cols;
        cols = [];
        for (var j = 0; j < keep.length; j++) cols.push(src[keep[j]]);
        if (board) {
          var rows = [];
          for (var r = 0; r < board.length; r++) {
            var row = board[r];
            if (!row || Object.prototype.toString.call(row.c) !== "[object Array]") { rows.push(row); continue; }
            var o = {}, k;
            for (k in row) if (Object.prototype.hasOwnProperty.call(row, k)) o[k] = row[k];
            o.c = [];
            for (var q = 0; q < keep.length; q++) o.c.push(row.c[keep[q]]);
            rows.push(o);
          }
          board = rows;
        }
      }
    }
    var sl = acctFlag("slide"), nn = acctFlag("net"), ns = acctFlag("sum");
    return {
      board: board,
      cols: cols,
      net: nn === null ? !(st.ovNet === false) : nn,
      sum: ns === null ? !(st.ovSum === false) : ns,
      slide: sl === null ? !(st.ovSlide === false) : sl, // 슬라이드 모드 — 기본 켬
    };
  };

  /* 사람 브라우저에서만 한 줄 얹습니다 — 판별은 마우스입니다 (2026-09-05): 송출
     프로그램의 소스 화면에는 마우스가 안 움직이므로, 처음 마우스가 움직일 때만
     띠를 만듭니다. UA·obsstudio 판별은 보조로 남깁니다(마이너 송출 프로그램은
     UA 로 못 걸러서, 옛 방식으로는 방송에 띠가 샜습니다).
     미리보기 창(?fit=1)은 앱이 그림을 확인하라고 여는 자리라 빼 둡니다. */
  if (OTOK && !inCast && !isPreview) {
    var hintOnce = function () {
      window.removeEventListener("mousemove", hintOnce);
      window.removeEventListener("touchstart", hintOnce);
      var hint = document.createElement("div");
      hint.className = "ov-hint";
      var hintText = document.createElement("b");
      hintText.textContent = "이 주소는 방송 프로그램에 넣는 주소예요.";
      /* 누를 수 있는 문 하나 — ?mode=page 로 다시 열면 앱의 읽기 화면으로 넘어갑니다 */
      var hintGo = document.createElement("a");
      hintGo.textContent = "현황판으로 보기";
      hintGo.href = location.pathname + "?mode=page" + location.hash;
      hintText.appendChild(hintGo);
      hint.appendChild(hintText);
      document.body.appendChild(hint);
    };
    window.addEventListener("mousemove", hintOnce);
    window.addEventListener("touchstart", hintOnce);
  }

  var app = document.getElementById("app");
  /* 예시 명단 — 예시 방(CAFE22)과 미리보기의 예시 판이 같이 씁니다 */
  var SAMPLE = [["주키니", 450000], ["팔복", 340000], ["읍지", 320000], ["이다", 180000],
                ["포셔", 170000], ["히휴", 110000], ["눈가루", 90000], ["티모", 60000]];
  var board = null;   // [{n,g,c}] — 앱이 계산해서 보내줍니다
  var cols = [];      // [{t,r}] — 항목 열 머리
  /* 슬라이드 모드 — 기본 켬(ovSlide === false 만 끔; 기존 사용자도 켜진 채 시작, 2026-09-06 사용자 확정).
     phase 는 phaseList() 의 자리: 0 = 합계, 그다음 항목들, 끝에 순액. 합계 8초, 나머지 4초 */
  var slideOn = true, phase = 0, slideTimer = null, sliding = false;
  var SLIDE_SUM = 8000, SLIDE_HOLD = 4000, SLIDE_DUR = 260, SLIDE_STAG = 30;
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
  /* (폐기 2026-09-08) settleNow — 룰렛 결과 뒤에 카드가 남아 있어도 판을 먼저 앉히던 예외.
     표는 모든 연출이 끝난 뒤 한 번만 움직입니다 (규칙 ⑤) */
  var fxBooted = false; // 첫 상태의 대기열은 '이미 흘러간 것'으로 봅니다
  var applying = false; // 판 반영(스와이프·순위 이동) 중
  var FX_HOLD = 1600;   // 카드가 머무는 시간
  var MV_DUR = 1120;    // 금액 스와이프 한 판
  var mvMode = "swipe"; // swipe | chip | off
  var spin = null;      // 앱이 보낸 판 (한 번에 통째로)
  var play = null;      // 방송이 제 시계로 재생하는 상태
  var spinTimer = null; // 도는 글자
  var stepTimer = null; // 다음 걸음
  /* 결과를 보여 주고 넘어가는 시간. 도는 시간(OV_ROLL)은 여기 없습니다 — 방장의 감속에서
     나와 판(cfg.roll)에 실려 옵니다 (2026-09-07). 앱·방송·파티원 화면이 같은 시간을 써야
     원판이 서는 순간과 결과가 뜨는 순간이 화면마다 안 어긋납니다. */
  var SPINS = {
    fast: { hold: 700, end: 1100 },
    normal: { hold: 1100, end: 1500 },
    slow: { hold: 1500, end: 1900 },
    epic: { hold: 1800, end: 2200 },
  };
  /* cfg.roll 이 안 왔다 = 아직 배포 전 앱이 민 판입니다. 그때는 옛 고정값 7초를 그대로 씁니다 —
     새 기본값을 끼워 넣으면 앱과 방송이 서로 다른 시간으로 돌아 결과 공개 시점이 어긋납니다.
     덕분에 워커를 앱보다 먼저 올려도 그 사이가 멀쩡합니다 (2026-09-07) */
  var OV_ROLL = 7000, OV_HOLD = 1200, OV_END = 1700;
  var useSpeed = function (sp) {
    var v = SPINS[(sp && sp.spd) || "normal"] || SPINS.normal;
    OV_HOLD = v.hold; OV_END = v.end;
  };
  var prev = {};      // 이름 → {g, rank} — 증감과 순위 변동을 재는 기준점
  /* 이름 → 최근 변화와 그 시각. 다른 사람이 벌금을 먹어도 내 표시가 사라지지 않게
     렌더 횟수가 아니라 시간으로 유지하고, 표시가 살아 있는 동안 생긴 변화는 누적합니다.
     (5위→3위→2위면 ▲2 다음 ▲1 이 아니라 ▲3. 제자리로 돌아오면 표시를 끕니다) */
  var recent = {};
  var DELTA_MS = 4200, MOVE_MS = 6000;
  var name = "";
  var dead = false;   // 판을 볼 수 없는 상태 — 침묵이 기본입니다
  var lobby = null;   // 로비가 열려 있는 동안만. 순위표 대신 대기실을 그립니다
  /* 대기실 발치 문구의 두 타이머 — 점(0.42초)과 말 바꾸기(4.2초). 대기실이 사라지면 스스로 멈춥니다 */
  var lobDotT = null, lobRotT = null, lobDot = 0, lobIdx = 0, lobList = [];
  function lobNoteStop() {
    clearInterval(lobDotT); clearInterval(lobRotT);
    lobDotT = null; lobRotT = null;
  }
  function lobNotes(list) {
    var same = lobList.length === list.length && lobList.every(function (x, i) { return x === list[i]; });
    if (same && lobDotT) return; // 판만 다시 그린 것 — 돌던 문구는 그대로
    lobNoteStop();
    lobList = list; lobIdx = 0; lobDot = 0;
    lobDotT = setInterval(function () {
      var d = document.querySelector(".ov-dots");
      if (!d) { lobNoteStop(); return; }
      lobDot = (lobDot + 1) % 4;
      d.textContent = new Array(lobDot + 1).join(".");
    }, 420);
    if (list.length < 2) return;
    lobRotT = setInterval(function () {
      var box = document.querySelector(".ov-note-in");
      if (!box) { lobNoteStop(); return; }
      box.classList.add("out");
      setTimeout(function () {
        var tx = box.querySelector(".ov-note-tx");
        if (!tx) return;
        lobIdx = (lobIdx + 1) % lobList.length;
        tx.textContent = lobList[lobIdx];
        box.classList.remove("out");
        box.classList.add("in");
        setTimeout(function () { box.classList.remove("in"); }, 280);
      }, 240);
    }, 4200);
  }

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
      return { n: r.n, k: r.k, g: r.g || 0, c: r.c || [], d: r.d || 0, i: i };
    })
      .sort(function (a, b) { return b.g - a.g || a.i - b.i; });
  };
  /* 줄의 열쇠 — 앱이 실어 주는 줄 고유번호가 있으면 그걸로, 없으면(옛 스냅샷) 이름으로.
     이름을 열쇠로 쓰면 닉이 겹칠 때 번쩍임·이동표시가 남의 줄에 붙습니다 (2026-09-05) */
  var rowKey = function (r) { return r.k != null ? "#" + r.k : r.n; };

  var esc = function (t) {
    return String(t == null ? "" : t).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  };

  /* 금액·순액 열 폭 — 예산("999만"/"−999만")으로 시작해, 실제 표기가 예산을 넘는
     순간 한 번만 넓어지고 다시는 안 좁아집니다(래칫). 모든 줄이 같은 폭을 쓰므로
     줄 사이가 어긋나지 않고, 숫자가 자라도 판이 축소되지 않습니다. */
  var goldHW = 0,
    netHW = 0,
    /* 이름 칸도 미리 잡아 둡니다 (2026-09-08 사용자 지적 → 고침). 1위 이름이 굵어질 때
       판의 max-content 폭이 늘고(실측 555 → 559px), .ov 가 fit-content 라 판이 넓어지고,
       fitBoard 가 배율을 다시 잡아 판 전체가 다시 앉았습니다 — 최초 클릭 때 제일 컸습니다.
       그때 .top 이 처음 생기기 때문입니다(그 전엔 모두 0원이라 어느 줄도 1위가 아닙니다) */
    nameHW = 0;
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
    /* 이름은 1위가 될 때의 굵기(700)로 잽니다 — 그래야 굵어져도 칸이 안 늘어납니다 */
    var mprobe = document.createElement("span");
    mprobe.className = "ov-name";
    mprobe.style.cssText = "flex:none; width:auto; min-width:0; font-weight:700";
    wrap.appendChild(probe);
    wrap.appendChild(nprobe);
    wrap.appendChild(mprobe);
    box.appendChild(wrap);
    var mw = function (el, t) {
      el.textContent = t;
      return el.offsetWidth;
    };
    /* 밑값은 manShort 가 만들어 낼 수 있는 **가장 넓은 꼴**로 잡습니다 (2026-09-08 사용자 지적:
       판이 조금씩 넓어지는데 되돌아오지 않는다). 옛 밑값 "999만"(실측 128px)은 실제로 나오는
       값들을 못 덮었습니다 — manShort 는 1만 미만이면 콤마를("3,750"=126), 100만 미만이면
       소수점을("99.9만"=145) 붙이고, 슬라이드는 순액을 같은 칸에 넣어 부호까지 답니다
       ("−99.9만"=176). 그래서 값이 그 꼴로 바뀔 때마다 열이 넓어졌고, 폭이 래칫이라
       되돌아오지 않았습니다(새로고침하면 다시 재서 줄어든 것이 그 증거입니다).
       이제 첫 그림부터 최대 폭이라 도중에 늘어날 일이 없습니다 */
    var WIDE = ["9999만", "99.9만", "9,999"];
    var WIDE_SIGNED = ["−9999만", "−99.9만", "−9,999"];
    var w = 0;
    WIDE.forEach(function (t) { w = Math.max(w, mw(probe, t)); });
    /* 슬라이드에서는 순액이 이 칸으로 들어옵니다 — 부호 붙은 꼴까지 미리 자리를 잡습니다 */
    if (slideOn) WIDE_SIGNED.forEach(function (t) { w = Math.max(w, mw(probe, t)); });
    var nw = 0;
    WIDE_SIGNED.forEach(function (t) { nw = Math.max(nw, mw(nprobe, t)); });
    var mwd = 0;
    var total = 0;
    rows.forEach(function (r) {
      mwd = Math.max(mwd, mw(mprobe, r.n || ""));
      total += r.g || 0;
      w = Math.max(w, mw(probe, manShort(r.g)));
      nw = Math.max(nw, mw(nprobe, (r.d > 0 ? "+" : "") + manShort(r.d || 0)));
      /* 슬라이드 모드는 횟수·순액도 같은 칸에 오므로 그 폭까지 처음부터 잽니다 — 판이 지표마다 숨 쉬지 않게 */
      if (slideOn) {
        (r.c || []).forEach(function (v) { if (v) w = Math.max(w, mw(probe, String(v))); });
        w = Math.max(w, mw(probe, (r.d > 0 ? "+" : "") + manShort(r.d || 0)));
      }
    });
    w = Math.max(w, mw(probe, manShort(total)));
    box.removeChild(wrap);
    /* 첫 그림에서 자가 0으로 나오는 때가 있습니다(레이아웃 전) — 0 을 못 박지 말고 다음 프레임에 다시 잽니다 (2026-09-06 하네스에서 봄) */
    if (!w) {
      if ((setGoldW.tries = (setGoldW.tries || 0) + 1) <= 3) requestAnimationFrame(function () { setGoldW(rows); });
      return;
    }
    setGoldW.tries = 0;
    /* vw 로 못 박습니다 — px 로 두면 창 크기가 바뀔 때 vw 글자만 커지고 칸은 그대로라 값이 판 밖으로 넘쳤습니다
       (2026-09-06 사용자 지적: 순액 단계에서 −19만이 잘림). 래칫(최대값 유지)은 그대로 */
    var vw1 = window.innerWidth / 100 || 1;
    goldHW = Math.max(goldHW, w / vw1);
    netHW = Math.max(netHW, nw / vw1);
    nameHW = Math.max(nameHW, mwd / vw1);
    box.style.setProperty("--goldw", goldHW.toFixed(3) + "vw");
    box.style.setProperty("--netw", netHW.toFixed(3) + "vw");
    box.style.setProperty("--namew", nameHW.toFixed(3) + "vw");
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
      var was = prev[rowKey(r)];
      if (!was) return;
      var rank = i + 1;
      var rc = recent[rowKey(r)] || (recent[rowKey(r)] = {});

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
      var was = prev[rowKey(r)];
      var justHit = !!was && r.g - was.g !== 0;   // 번쩍임은 바뀐 그 순간만
      var rc = recent[rowKey(r)] || {};
      var dAge = rc.dAt == null ? Infinity : now - rc.dAt;
      var mAge = rc.mvAt == null ? Infinity : now - rc.mvAt;
      var showD = mvMode === "chip" && dAge < DELTA_MS, showM = mAge < MOVE_MS;
      var cls = "ov-row" + (r.g || !anyPaid ? "" : " zero") + (justHit ? " hit" : "") +
        (i === 0 && r.g ? " top" : "");
      /* 이미 흐르던 표시는 지난 만큼 앞당겨 이어 붙입니다 — 다시 처음부터 뜨지 않게 */
      var delay = function (age) { return ' style="animation-delay:-' + Math.round(age) + 'ms"'; };
      return '<div class="' + cls + '" data-k="' + esc(rowKey(r)) + '">' +
        '<span class="ov-rank">' + (i + 1) + '</span>' +
        '<span class="ov-move ' + (showM ? (rc.mv > 0 ? "up" : "down") : "") + '"' +
          (showM ? delay(mAge) : "") + '>' +
          (showM ? (rc.mv > 0 ? "▲" : "▼") + Math.abs(rc.mv) : "") + '</span>' +
        '<span class="ov-name">' + esc(r.n) + '</span>' +
        (slideOn
          ? slotHtml(r, phaseAt(phase), rc, showD, dAge, delay)
          : cols.map(function (c, ci) {
              var v = (r.c || [])[ci] || 0;
              return '<span class="ov-cnum' + (c.r ? ' rl' : '') + (v ? '' : ' z') + '">' +
                esc(v) + '</span>'; // 0회도 0으로 — 흐리게만 (2026-09-06 사용자: 비워 두지 않는다)
            }).join('') +
            (showSum ? slotHtml(r, { k: "sum" }, rc, showD, dAge, delay) : "") +
            (showNet
              ? '<span class="ov-net ' + (r.d > 0 ? "plus" : r.d < 0 ? "minus" : "") + '">' +
                  (r.d > 0 ? "+" : "") + manShort(r.d) + '</span>'
              : '')) + '</div>';
    }).join("");

    prev = {};
    list.forEach(function (r, i) { prev[rowKey(r)] = { g: r.g, rank: i + 1 }; });
    return html;
  };

  /* ---- 슬라이드 모드 (2026-09-06 사용자 확정) ----
     합계 자리(.ov-gold)에서 합계 → 항목들 → 순액이 번갈아 나옵니다. 아무도 안 쓴 항목·전부 0인 순액은 건너뜁니다.
     값이 바뀌면 먼저 합계로 미끄러져 돌아온 뒤 스와이프·순위 이동이 붙습니다 — "움직일 땐 합계, 조용할 땐 디테일".
     카드·스와이프·룰렛·미착지 판이 있는 동안은 돌지 않습니다 */
  var phaseList = function () {
    var list = [{ k: "sum" }];
    if (!slideOn || !board) return list;
    cols.forEach(function (c, ci) {
      if (board.some(function (r) { return ((r.c || [])[ci] || 0) > 0; })) list.push({ k: "item", i: ci });
    });
    if (showNet && board.some(function (r) { return (r.d || 0) !== 0; })) list.push({ k: "net" });
    return list;
  };
  var phaseAt = function (i) { var l = phaseList(); return l[Math.min(i, l.length - 1)] || l[0]; };
  /* 한 줄의 값 칸 — 지표에 따라 합계(스와이프·증감 칩 그대로)·횟수·순액. 나란히 모드의 합계 칸도 이걸 씁니다 */
  var slotHtml = function (r, ph, rc, showD, dAge, delay) {
    if (ph.k === "item") {
      var v = (r.c || [])[ph.i] || 0;
      return '<span class="ov-gold as-cnt' + (v ? '' : ' z') + '">' + esc(v) + '</span>'; // 0회도 0으로 (사용자: 비워 두지 않는다)
    }
    if (ph.k === "net")
      return '<span class="ov-gold as-net ' + (r.d > 0 ? "plus" : r.d < 0 ? "minus" : "") + '">' +
        (r.d > 0 ? "+" : "") + manShort(r.d || 0) + '</span>';
    return '<span class="ov-gold">' + manShort(r.g) +
      '<span class="ov-delta ' + (showD ? (rc.d > 0 ? "plus" : "minus") : "") + '"' +
        (showD ? delay(dAge) : "") + '>' +
        (showD ? (rc.d > 0 ? "+" : "−") + manShort(Math.abs(rc.d)) : "") + '</span>' +
      '</span>';
  };
  /* 머리줄의 총액 자리 — 합계일 땐 총액, 항목일 땐 항목 이름, 순액일 땐 '순액' (사용자 확정: 총액 자리를 라벨 자리로) */
  var headSlot = function (ph) {
    if (ph.k === "item") {
      var c = cols[ph.i] || {};
      return '<span class="ov-total as-lab' + (c.r ? " rl" : "") + '">' +
        (c.r ? '<i class="ov-rlmk">◎</i>' : "") + esc(c.t) + '</span>';
    }
    if (ph.k === "net") return '<span class="ov-total as-lab">순액</span>';
    return '<span class="ov-total">' +
      manShort((board || []).reduce(function (a, r) { return a + (r.g || 0); }, 0)) + '</span>';
  };
  /* 라벨이 칸보다 길면 글자를 줄입니다 (2.0~3.4vw) — 칸을 넓히면 판이 넓어져 배율이 떨어집니다 */
  var fitLabel = function () {
    var el = document.querySelector(".ov-total.as-lab");
    if (!el) return;
    el.style.fontSize = "";
    var box = el.offsetWidth, need = el.scrollWidth; // 칸 폭은 실제 상자로 — --goldw 가 아직 없을 때도 맞습니다
    if (box && need > box) el.style.fontSize = Math.max(2.0, (3.4 * box) / need).toFixed(2) + "vw";
  };
  /* 지표를 바꿉니다 — 값이 왼쪽으로 나가고(줄마다 30ms 늦게) 새 값이 오른쪽에서 들어옵니다 */
  var slideTo = function (to, cb) {
    var rows = ovBoard ? ovBoard.querySelectorAll(".ov-row") : [];
    var n = rows.length;
    var span = SLIDE_DUR + n * SLIDE_STAG;
    sliding = true;
    [].forEach.call(rows, function (row, i) {
      var s0 = row.querySelector(".ov-gold");
      if (s0) { s0.style.animationDelay = i * SLIDE_STAG + "ms"; s0.classList.add("sl-out"); }
    });
    var hd0 = document.querySelector(".ov-total");
    if (hd0) hd0.classList.add("sl-out");
    setTimeout(function () {
      phase = to;
      var ph = phaseAt(phase);
      var byKey = {};
      (board || []).forEach(function (r) { byKey[rowKey(r)] = r; });
      var none = function () { return ""; };
      [].forEach.call(rows, function (row, i) {
        var r = byKey[row.getAttribute("data-k")];
        var s1 = row.querySelector(".ov-gold");
        if (!r || !s1) return;
        var tmp = document.createElement("span");
        tmp.innerHTML = slotHtml(r, ph, recent[rowKey(r)] || {}, false, Infinity, none);
        var ns = tmp.firstChild;
        ns.style.animationDelay = i * SLIDE_STAG + "ms";
        ns.classList.add("sl-in");
        s1.parentNode.replaceChild(ns, s1);
      });
      var old = document.querySelector(".ov-total");
      if (old) {
        var t2 = document.createElement("span");
        t2.innerHTML = headSlot(ph);
        var nh = t2.firstChild;
        nh.classList.add("sl-in");
        old.parentNode.replaceChild(nh, old);
        fitLabel();
      }
      setTimeout(function () {
        sliding = false;
        [].forEach.call(document.querySelectorAll(".sl-in"), function (el) {
          el.classList.remove("sl-in");
          el.style.animationDelay = "";
        });
        if (cb) cb();
      }, span);
    }, span);
  };
  /* 다음 지표로 갈 시계 — 합계는 8초, 나머지는 4초. 연출 중이면 0.7초 뒤 다시 봅니다 */
  var scheduleSlide = function () {
    clearTimeout(slideTimer);
    if (!slideOn || !ovBoard || !board || !board.length) return;
    if (phaseList().length < 2) { phase = 0; return; }
    var hold = phaseAt(phase).k === "sum" ? SLIDE_SUM : SLIDE_HOLD;
    var tick = function () {
      if (!slideOn || !ovBoard) return;
      if (applying || fxCard || play || sliding || next) { slideTimer = setTimeout(tick, 700); return; }
      var l2 = phaseList();
      if (l2.length < 2) { phase = 0; return; }
      slideTo((phase + 1) % l2.length, function () { pump(); scheduleSlide(); });
    };
    slideTimer = setTimeout(tick, hold);
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
  /* 원판이 실제로 서는 시각 (2026-09-08). 결과를 여는 타이머와 원판을 돌리는 CSS 전환은
     서로 다른 시계라, 전환이 한 프레임 늦게 시작하거나 소스가 눌려 밀리면 결과가
     원판이 서기 전에 열립니다. 전환을 거는 순간 여기 적어 두고 stepPlay 가 확인합니다 */
  var wheelStopAt = 0;
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
  /* 끝없이 돌던 원판을 지금 각도에 그대로 세웁니다 — 클래스만 벗기면 0도로 튑니다 */
  var holdFree = function () {
    var el = document.getElementById("ovdisc");
    if (!el || !el.classList.contains("ov-w-free")) return;
    var mm = new DOMMatrixReadOnly(getComputedStyle(el).transform);
    var deg = ((Math.atan2(mm.b, mm.a) * 180) / Math.PI + 360) % 360;
    el.classList.remove("ov-w-free");
    el.style.transition = "none";
    el.style.transform = "rotate(" + deg.toFixed(2) + "deg)";
    wheelRot = deg;
    wheelStopAt = 0; // 그 자리에 즉시 멈춥니다 — 기다릴 것이 없습니다
  };
  /* 건너뛰기 — 돌던 원판을 목표 자리에 짧게 세웁니다 (2026-09-05) */
  var snapWheel = function () {
    var el = document.getElementById("ovdisc");
    if (!el) return;
    if (el.classList.contains("ov-w-free")) { holdFree(); return; }
    el.style.transition = "transform 240ms ease-out";
    el.style.transform = "rotate(" + wheelRot.toFixed(2) + "deg)";
    wheelStopAt = performance.now() + 240;
  };
  /* fast(결과 화면 없이 바로 닫기)면 남은 박자를 짧게 — 서기 화면과 같이 닫힙니다 */
  var holdMs = function (ms) {
    return play && play.sp && play.sp.fast ? Math.min(ms, 320) : ms;
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
      /* 원판이 아직 서는 중이면 그만큼만 더 기다립니다 (2026-09-08 사용자 지적:
         결과가 정지 전에 공개된다). 결과를 여는 건 setTimeout 이고 원판을 돌리는 건 CSS
         전환이라 시계가 둘입니다 — 전환이 한 프레임 늦게 시작하거나 소스가 눌려 밀리면
         그 차이만큼 결과가 먼저 열립니다. 숫자만 모드는 전환이 없어 이 검사를 건너뜁니다 */
      if (play.sp.look !== "num") {
        var leftMs = wheelStopAt - performance.now();
        if (leftMs > 16) { stepTimer = setTimeout(stepPlay, leftMs); return; }
      }
      play.rolling = false;
      if (faceTimer) { clearInterval(faceTimer); faceTimer = null; }
      drawPlay();
      stepTimer = setTimeout(stepPlay, holdMs(OV_HOLD));
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
        stepTimer = setTimeout(stepPlay, holdMs(OV_HOLD));
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
      stepTimer = setTimeout(stepPlay, holdMs(OV_HOLD));
      return;
    }
    if (!play.over) {
      play.over = true;
      drawPlay();
      stepTimer = setTimeout(stepPlay, holdMs(OV_END));
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
      stepTimer = setTimeout(stepPlay, holdMs(OV_HOLD));
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
    /* 큐를 여기서 멈춥니다 (2026-09-08 사용자 규칙 3·4). 떠 있던 카드는 줄 맨 앞으로
       되돌려서, 룰렛이 끝난 뒤 pump 가 처음부터 다시 띄웁니다 — 예전엔 원판 아래에 깔린 채
       제 시계로 사라져서, 방금 뜬 카드를 아무도 못 읽고 지나갔습니다.
       룰렛 결과 카드는 ingestFx 가 unshift 하므로 되돌린 카드보다 앞에 섭니다(§4.4) */
    if (fxCard) {
      clearTimeout(fxTimer);
      fxQ.unshift(fxCard);
      fxCard = null;
      var fxHost = document.getElementById("ovfx");
      if (fxHost) fxHost.innerHTML = "";
    }
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
    /* (버그 기록 2026-09-05) 여기서 freeWheel(false) 로 클래스를 먼저 벗겼더니 spinTo 가 돌던 각도를 못 읽어
       원판이 0도로 튄 뒤 멈춘 상태에서 다시 돌기 시작했다 — STOP 을 누르면 "다시 돈다"로 보였다.
       클래스는 spinTo(원판)·holdFree(그 자리 멈춤)가 벗깁니다 */
    var sp = play.sp;
    /* 답 없이 사라진 판 — 돌던 자리에서 그냥 멈춥니다 */
    if (play.appGone && !(play.who === "roll" && sp.pass2 && sp.pass2.name)) {
      holdFree();
      /* 자유 회전은 아직 안 뽑힌 자리를 가리킵니다 — 마지막으로 뽑힌 걸음으로 돌려놓습니다 */
      play.i = Math.max(0, (sp.steps || []).length - 1);
      play.rolling = false;
      drawPlay();
      stepTimer = setTimeout(stepPlay, holdMs(OV_HOLD));
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
          if (rowKey(oldB[j]) === rowKey(newB[i])) { o = oldB[j]; break; }
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
  var OV_FACE_MS = 70;
  var useSpinCfg = function (sp) {
    var c = sp && sp.cfg;
    if (!c) return;
    if (c.free > 0) OV_FREE_MS = c.free;
    /* 도는 시간은 방장의 감속에서 나옵니다 (2026-09-07) — 룰렛은 방장 것이라
       내 계정 외형과 상관없이 이 값을 그대로 씁니다 */
    if (c.roll > 0) OV_ROLL = c.roll;
    if (c.face > 0) OV_FACE_MS = c.face;
  };
  /* 멈추는 동안 면이 바뀌는 간격 — 앱의 faceGap 과 같은 식입니다 (등감속의 역수) */
  var OV_FACE_CAP = 12;
  var faceGap = function (p) {
    return Math.round(OV_FACE_MS / Math.max(1 - Math.min(1, Math.max(0, p)), 1 / OV_FACE_CAP));
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
    /* 등감속이면 도는 거리는 "지금 속도로 그 시간 갔을 거리"의 절반입니다 (2026-09-07).
       칸 자리에 앉히려고 한 바퀴 단위로 스냅하고, 그 어긋남이 판마다 다르게 서는 맛이 됩니다.
       앱과 같은 씨앗·같은 식이라 두 화면이 같은 자리에 같은 시간에 섭니다. */
    var v0 = (360 / OV_FREE_MS) * OV_ROLL;
    var turns = Math.max(1, Math.round((v0 / 2 - (seat - from)) / 360));
    var target = seat + turns * 360;
    wheelRot = target;

    var D = Math.max(1, target - from);
    /* 등감속 곡선은 y = 2t − t², 3차 베지어로 (1/3, 2/3, 2/3, 1) 로 딱 떨어집니다.
       스냅 때문에 처음 기울기 s0 가 2 에서 조금 벗어나므로 x1 만 거기 맞춰 다시 잡습니다 —
       그래야 돌던 속도에서 이음매 없이 이어집니다. y1 은 2/3 라 되감길 일이 없습니다. */
    var s0 = v0 / D;
    var x1 = Math.min(0.9, Math.max(0.1, 0.667 / s0));
    var cz = wasFree
      ? "cubic-bezier(" + x1.toFixed(3) + ",.667,.667,1)"
      : "cubic-bezier(.35,0,.28,1)"; // 멈춰 있다 다시 도는 판

    /* 시작 각도를 전환 없이 먼저 못 박고, 강제로 한 번 계산시킨 뒤 목표를 줍니다.
       프레임 콜백을 기다리지 않아 OBS 브라우저 소스에서도 확실히 돕니다. */
    el.style.transition = "none";
    el.style.transform = "rotate(" + from.toFixed(2) + "deg)";
    void el.offsetWidth;
    el.style.transition = "transform " + OV_ROLL + "ms " + cz;
    el.style.transform = "rotate(" + target.toFixed(2) + "deg)";
    wheelStopAt = performance.now() + OV_ROLL;
  };

  /* 설정 — 앱이 상태에 실어 보냅니다 */
  var FX_HOLDS = { fast: 1000, norm: 1600, slow: 2400 };
  var fxOn = true;
  var applyFxCfg = function (st) {
    var sp = st.fxSpd;
    /* 알림을 켤지는 보는 계정이 정합니다 (2026-09-07) — 저장해 둔 값이 없을 때만 판의 값을 따릅니다.
       앱은 이제 알림을 꺼도 연출거리를 보냅니다. 켜 둔 파티원의 오버레이가 같이 조용해지지 않게요 */
    var mine = acctFlag("fx");
    fxOn = mine === null ? sp !== "off" : mine;
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

  var fxCls = function (e) { return (e.g > 0 ? "up" : "dn") + (e.k === "roul" ? " roul" : ""); };
  var fxBodyHtml = function (e, extra) {
    var up = e.g > 0;
    return '<div class="ov-fx-body' + (extra ? " " + extra : "") + '">' +
      "<b>" + esc(e.n) + "</b>" +
      "<span>" + (e.k === "cancel" || e.k === "sub" ? "정정 · " : "") + esc(e.t || "") + ' <em>' + (up ? "+" : "\u2212") +
      manShort(Math.abs(e.g)) + "</em></span></div>";
  };
  var fxCardHtml = function (e) { return '<div class="ov-fx ' + fxCls(e) + '">' + fxBodyHtml(e, "") + "</div>"; };

  var playCard = function (e) {
    fxShown[e.i] = 1;
    fxCard = e;
    /* 정정(취소·빼기)은 짧게 — 알리되 붙는 것만큼 크게 다루지 않습니다.
       그리고 밀리면 더 짧게: 다 보여 주되 속도만 올려 다음 판을 안 잡아먹습니다. */
    var hold = e.k === "add" || e.k === "roul" ? FX_HOLD : Math.round(FX_HOLD * 0.7);
    /* (폐기 2026-09-08 사용자 확정) 룰렛 결과 뒤에 판을 먼저 앉히던 settleNow.
       그 예외 때문에 룰렛이 낀 판에서만 표가 두 번 움직였습니다 — 룰렛 뒤에 한 번,
       큐가 끝나고 또 한 번. 예외를 없애면 어떤 판이든 표는 한 번만 움직입니다.
       예외를 넣었던 이유(바퀴 결과가 표에 늦게 뜬다)는 룰렛 결과 카드가 큐 맨 앞에
       서는 것(ingestFx 의 unshift)이 이미 답합니다 — 바퀴가 서면 그 결과가 곧바로 뜹니다 */
    if (fxQ.length > 4) hold = Math.round(hold * 0.5);
    var host = document.getElementById("ovfx");
    /* 카드는 벌금표에 대한 이야기라 표 소스에 뜹니다. 룰렛 소스는 룰렛만 —
       소스를 나눈 뜻이 "표는 작게, 룰렛은 크게"인데 거기에 카드가 끼면 화면 한복판을
       클릭마다 가립니다. 안 그리는 쪽도 시간은 똑같이 흘려서 두 소스의 판이
       같은 순간에 바뀌게 합니다. */
    if (host && TYPE !== "spin") {
      var cur = host.querySelector(".ov-fx:not(.out)");
      if (cur) {
        /* 카드는 한 장 — 옛 글을 지운 뒤 새 글을 넣고, 카드를 한 번 부풀려 "다른 건"임을 알립니다 (2026-09-07 사용자 확정) */
        var old = cur.querySelector(".ov-fx-body");
        if (old) old.classList.add("fade");
        setTimeout(function () {
          if (!cur.parentNode) return;
          cur.className = "ov-fx " + fxCls(e);
          cur.innerHTML = fxBodyHtml(e, "rise");
          void cur.offsetWidth; // 부풀림 애니메이션을 처음부터 다시
          cur.classList.add("bump");
        }, 70);
      } else host.innerHTML = fxCardHtml(e);
    }
    clearTimeout(fxTimer);
    fxTimer = setTimeout(function () {
      fxCard = null;
      var h = document.getElementById("ovfx");
      /* 다음 카드가 있으면 pump 가 그 위에 얹습니다. 없으면 마지막 카드를 번져 지웁니다 */
      if (h && !fxQ.length) {
        var last = h.lastElementChild;
        if (last) {
          last.classList.add("out");
          setTimeout(function () { if (!fxCard && last.parentNode) last.parentNode.removeChild(last); }, 180);
        }
      }
      pump();
    }, hold);
  };

  /* 굴릴 거리 — 금액이 바뀐 줄과 총액 */
  var swipePlan = function (oldB, newB) {
    /* 열쇠는 줄 고유번호(rowKey)입니다 — (버그 기록 2026-09-05) 이름을 열쇠로 남겨 둔 채 줄에는
       data-k 로 고유번호를 적어서, 굴릴 줄을 하나도 못 찾았습니다. 총액만 굴렀습니다 */
    var was = {}, out = [];
    oldB.forEach(function (r) { was[rowKey(r)] = r.g || 0; });
    var oldSum = 0, newSum = 0;
    oldB.forEach(function (r) { oldSum += r.g || 0; });
    newB.forEach(function (r) {
      newSum += r.g || 0;
      var k = rowKey(r);
      if (was[k] != null && was[k] !== (r.g || 0))
        out.push({ k: k, from: was[k], to: r.g || 0 });
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
          if (rows[i].getAttribute("data-k") === m.k) el = rows[i].querySelector(".ov-gold");
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
    if (sliding) return; // 지표가 미끄러지는 중 — 끝나면 pump 가 다시 부릅니다
    if (slideOn && phase !== 0 && ovBoard) {
      /* 값이 바뀌면 먼저 합계로 돌아옵니다 — 디테일 위에 스와이프가 얹히면 무엇이 바뀐 건지 안 읽힙니다 (2026-09-06 사용자 확정) */
      applying = true;
      clearTimeout(slideTimer);
      slideTo(0, function () { applying = false; settle(); });
      return;
    }
    var nb = next.board, nc = next.cols, nn = next.net, ns = next.sum, nsl = next.slide !== false;
    var sameCols = JSON.stringify(nc) === JSON.stringify(cols);
    var moves =
      mvMode === "swipe" && ovBoard && board && board.length && nb && nb.length &&
      sameCols && nn === showNet && ns === showSum && nsl === slideOn
        ? swipePlan(board, nb)
        : [];
    var done = function () {
      board = nb; cols = nc; showNet = nn; showSum = ns; slideOn = nsl;
      phase = 0; // 판이 앉으면 합계부터 다시 셉니다
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
    /* 룰렛은 즉시 (2026-09-05) — 카드가 떠 있거나 금액이 굴러가는 중이어도 그 위에 뜹니다.
       (버그 기록) 카드·스와이프 뒤로 밀려 STOP 을 누를 때쯤에야 원판이 떴다 */
    if (pendSpin && !play) {
      var sp2 = pendSpin;
      pendSpin = null;
      if (sp2.sid !== doneSid) { startPlay(sp2); return; }
    }
    if (applying || fxCard) return;
    if (play) return; // 판이 떠 있는 동안 큐는 멈춥니다. 쌓인 카드는 끝난 뒤에
    /* 큐가 다 빠진 뒤에야 표를 앉힙니다 (2026-09-08 사용자 확정 규칙 ⑤) —
       큐와 룰렛을 포함한 모든 동작이 끝나면 금액과 순위가 한 번에 반영됩니다 */
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
    /* 발치 문구 (2026-09-08 사용자): 점이 . .. ... 로 늘고, 몇 초마다 다음 말이 아래에서 올라옵니다.
       판을 다시 그릴 때마다 타이머를 새로 걸지 않도록 같은 말 묶음이면 그대로 둡니다 */
    /* 로비가 열려 있으면 대기실입니다 — 아직 판이 없으니 순위표를 그릴 게 없습니다 */
    if (lobby) {
      ovBoard = null;
      prev = {};
      recent = {};
      root.dataset.notice = "0";
      /* 줄을 정원만큼 미리 그립니다 (2026-09-08 사용자 확정 B안) — 빈 줄은 점선 자리, 이름만 적힌 줄은 흐리게,
         들어온 사람은 또렷하게. 뼈대(.ov-row + 번호 + 이름)와 판 테두리·머리줄 선·글자 크기는 벌금표와 같은 것을 씁니다 —
         시작하는 순간 판은 그대로 있고 줄 내용만 바뀝니다. 방장을 금색으로 따로 칠하지는 않습니다(사용자).
         (폐기 2026-09-08) 이름을 가운뎃점으로 이어 한 줄로 — 누가 들어왔고 몇 자리가 비었는지가 안 보였다 */
      var llist = lobby.names || [];
      var lcap = lobby.cap || 8;
      var ln = lobby.n != null ? lobby.n : llist.length;
      var lrows = "";
      for (var li = 0; li < lcap; li++) {
        var lx = llist[li];
        lrows +=
          '<div class="ov-row ov-lbrow' + (lx ? (lx.live ? "" : " lb-typed") : " lb-empty") + '">' +
          '<span class="ov-rank">' + (li + 1) + "</span>" +
          '<span class="ov-name">' + (lx && lx.n ? esc(lx.n) : "") + "</span></div>";
      }
      var lleft = lcap - llist.length;
      /* 두 말이 번갈아 섭니다 (2026-09-08 사용자) — 자리 수는 사실, 모이는 중은 상태. 꽉 차면 한 마디만 */
      var lnotes = lleft <= 0
        ? ["곧 시작해요"]
        : [!llist.length ? "파티원을 기다려요" : lleft + "자리 남았어요", "모이는 중이에요"];
      app.innerHTML =
        '<div class="ov"><div class="ov-head"><span class="ov-lobby-t">대기실</span>' +
        '<span class="ov-lobby-n">' + ln + "/" + lcap + "</span></div>" +
        lrows +
        '<div class="ov-lobby-note"><span class="ov-note-in"><b class="ov-note-tx">' + esc(lnotes[0]) +
        "</b><i class='ov-dots'></i></span></div></div>";
      lobNotes(lnotes);
      fitBoard();
      return;
    }
    lobNoteStop();
    /* 미리보기 창인데 그릴 판이 없습니다 (2026-09-05, §4.4) — 체커보드만 뜨면 "고장인가"가 되고,
       이 창은 테마를 고르는 자리이기도 해서 예시 판을 지금 외형으로 그립니다. 리본이 예시임을 말합니다.
       OBS 안(isPreview 거짓)에서는 절대 안 그립니다 — 방송에 예시가 새면 안 됩니다 */
    /* (폐기 2026-09-06) 예시 판 — 앱이 나가는 게 없으면 미리보기 칸을 아예 안 그립니다. 코드는 두되 켜지 않습니다 */
    if (false && isPreview && (dead || !board || !board.length)) {
      ovBoard = null;
      prev = {};
      recent = {};
      root.dataset.notice = "0";
      cols = [];
      var sample = SAMPLE.map(function (p) { return { n: p[0], g: p[1], c: [], d: 0 }; });
      app.innerHTML =
        '<div class="ov"><div class="ov-head">' +
        '<span class="ov-rank"></span><span class="ov-move"></span>' +
        '<span class="ov-name-t">벌금 순위</span>' +
        (showSum
          ? '<span class="ov-total">' +
            manShort(sample.reduce(function (a, r) { return a + r.g; }, 0)) + "</span>"
          : "") +
        (showNet ? '<span class="ov-nethead">순액</span>' : "") +
        '</div><div id="ovboard"></div></div>' +
        '<div class="ov-sample">예시 화면이에요 — 지금은 방송에 나가는 게 없어요. ' +
        '[시작]을 누르면 현황판이, 파티원을 모으면 대기실이 여기 떠요.</div>';
      var sb = document.getElementById("ovboard");
      setGoldW(sample);
      sb.innerHTML = rowsHtml(sample);
      prev = {};
      recent = {};
      fitBoard();
      return;
    }
    if (dead || !board || !board.length) {
      ovBoard = null;
      prev = {};
      recent = {};
      if (!dead) root.dataset.notice = "0";
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
      (slideOn
        ? headSlot(phaseAt(phase)) // 슬라이드 모드 — 총액 자리가 지표 라벨 자리
        : cols.map(function (c) {
            return '<span class="ov-chead' + (c.r ? " rl" : "") + '">' +
              (c.r ? '<i class="ov-rlmk">◎</i>' : "") + esc(c.t) + "</span>";
          }).join("") +
          (showSum
            ? '<span class="ov-total">' +
              manShort(board.reduce(function (a, r) { return a + (r.g || 0); }, 0)) + "</span>"
            : "") +
          (showNet ? '<span class="ov-nethead">순액</span>' : ""));
    fitCheads(); // 머리줄을 그린 뒤에 — 확대(fitBoard) 전에 크기를 정해야 합니다
    fitLabel();
    fitBoard();
    scheduleSlide();
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
  /* 옛 주소 안내 — 방에 방장이 없다는 답(denied gone)을 받았을 때만 (§4.4).
     초대가 없어서 막힌 사람에게는 "새 주소를 받아라"가 오답이라 문구를 가릅니다 */
  var NOTICE_GONE = "주소 체계가 바뀌었어요. 앱에서 새 주소를 받아 넣어주세요.";
  var NOTICE_HOME = OTOK
    ? "지금 들어가 있는 파티가 없어요. 초대를 받아 참여하면 다시 보여요."
    : "이 주소만으로는 판을 볼 수 없어요. 자수 화면의 '내 방송용 주소'를 넣어주세요.";
  var NOTICE = NOTICE_HOME;
  var maybeNotice = function () {
    if (!dead || !window.obsstudio || typeof window.obsstudio.getStatus !== "function") return;
    try {
      window.obsstudio.getStatus(function (st) {
        if (!st || st.streaming || st.recording) return;
        var el = document.getElementById("notice");
        if (!el) return;
        el.textContent = NOTICE;
        root.dataset.notice = "1";
      });
    } catch (e) { /* 권한 없음 → 침묵 */ }
  };

  /* 구독 — 접속 즉시 스냅샷 한 번, 이후 변경분. 끊기면 물러났다 다시 붙습니다.
     자격은 쿼리로 갑니다: 방송용 토큰(?o) 아니면 초대 코드(?j). 주소창에는 안 실립니다 */
  /* 받은 판 하나를 처리합니다 — 소켓과 예시 방(CAFE22)이 같은 길을 탑니다 (2026-09-08).
     예시가 render() 로 판만 갈아 끼우던 때에는 연출 큐도 룰렛도 안 돌아서, 방송에 실제로
     나가는 그림과 예시가 서로 달랐습니다 */
  var onState = function (st) {
    dead = false;
    lobby = st.lobby || null;
    /* 판은 바로 그리지 않고 담아 둡니다 — 연출이 다 끝나야 앉힙니다 */
    lastState = st;
    next = viewOf(st);
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
        /* 건너뛰기 (2026-09-05) — 서기가 도는 중에 세웠으면(skipAt) 여기서도 그 자리에 세우고,
           fast(결과 화면 없이 닫기)면 남은 박자를 줄입니다. 예전엔 둘 다 무시돼 방송만 느긋했습니다 */
        if (!play.over && play.rolling && spin.skipAt != null && play.skipDone !== spin.skipAt) {
          play.skipDone = spin.skipAt;
          snapWheel();
          clearTimeout(stepTimer);
          stepTimer = setTimeout(stepPlay, 240);
        } else if (spin.fast && !play.rolling && stepTimer) {
          clearTimeout(stepTimer);
          stepTimer = setTimeout(stepPlay, 0);
        }
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
      else if (!stepTimer) stepTimer = setTimeout(stepPlay, holdMs(OV_HOLD));
    }
    name = st.name || "";
    applyLook(st.look);
  };

  var wait = 1000;
  var CUR = ROOM;   // 지금 붙어 있는 방 (/o/ 는 resolve 로 알아냅니다)
  var authQ = function () {
    return OTOK ? "?o=" + encodeURIComponent(OTOK)
      : JCODE ? "?j=" + encodeURIComponent(JCODE) : "";
  };
  var connect = function () {
    var ws;
    try {
      ws = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") +
        location.host + "/api/r/" + CUR + "/live" + authQ());
    } catch (e) { setTimeout(connect, wait); return; }
    var beat = setInterval(function () { if (ws.readyState === 1) ws.send("ping"); }, 50000);
    ws.onmessage = function (ev) {
      if (ev.data === "pong") return;
      try {
        var m = JSON.parse(ev.data);
        /* 자격이 없다는 답 — 방송 화면에는 에러를 그리지 않습니다. 조용히 물러납니다 */
        if (m.kind === "denied") {
          dead = true; board = null; lobby = null; spin = null; play = null;
          next = null; fxQ = []; fxCard = null; clearTimeout(fxTimer);
          /* 방장이 없는 방 = 계정 이전의 옛 주소입니다. 초대가 없어서 막힌 것과 답이 달라요 */
          NOTICE = m.why === "gone" ? NOTICE_GONE : NOTICE_HOME;
        } else if (m.kind === "look") {
          /* 내 계정이 외형을 고쳤습니다 (2026-09-07) — 예전엔 붙을 때 한 번만 받아서
             OBS 소스를 새로고침해야 반영됐습니다. 판은 마지막 것을 그대로 다시 입힙니다 */
          applyLook(m.look, true);
          if (lastState) {
            applyFxCfg(lastState);
            next = viewOf(lastState);
            pump(); // 연출이 돌고 있으면 그게 끝난 뒤에 앉습니다 — 판 반영과 같은 길입니다
          }
          return;
        } else if (m.kind === "you") {
          /* 명단에서 빠졌습니다(내보내기·나가기). 이미 붙어 있는 줄은 서버가 안 끊으므로
             여기서 떼고 다시 물어봅니다 — 자격이 없으면 그 답이 denied 로 와서 침묵합니다 */
          if (!m.you) { try { ws.close(); } catch (e2) {} }
          return;
        } else if (m.kind === "state") {
          onState(m.state || {});
        } else return;
        wait = 1000;
        /* 대기실은 연출 큐를 안 탑니다 — 기다릴 판이 없으니 바로 그립니다 */
        if (dead || lobby) render();
        else pump();
      } catch (e) {}
    };
    ws.onclose = function () {
      clearInterval(beat);
      /* 자격이 없으면 다시 붙지 않습니다. 다만 방송용 주소는 방이 바뀌었을 수 있어
         1분마다 어느 방인지부터 다시 묻습니다 */
      if (dead) { if (OTOK) setTimeout(boot, bootWait()); return; }
      setTimeout(connect, wait);
      wait = Math.min(wait * 2, 15000);
    };
    ws.onerror = function () { try { ws.close(); } catch (e) {} };
  };

  /* 볼 것이 없을 때 다시 묻는 간격 — 처음 세 번은 1분(방장이 곧 [시작]을 누를 수
     있으니 빨리 붙어야 합니다), 그 뒤로는 물러나 5분 상한입니다.
     이 폴링이 유일한 복귀 수단이라 아예 끌 수는 없는데, 1분 고정으로 두면 켜 둔 채
     방치된 OBS 소스 하나가 하루 1,440번씩 서버를 두드립니다 */
  var bootTries = 0;
  var bootWait = function () {
    bootTries++;
    return bootTries <= 3 ? 60000 : Math.min(60000 * Math.pow(2, bootTries - 3), 300000);
  };
  /* /o/ 는 토큰이 가리키는 방을 먼저 물어봅니다 — 이 계정이 지금 들어가 있는 방입니다 */
  var boot = function () {
    if (!OTOK) { CUR = ROOM; connect(); return; }
    fetch("/api/o/" + encodeURIComponent(OTOK) + "/resolve")
      .then(function (r) { if (!r.ok) throw new Error("no room"); return r.json(); })
      .then(function (d) {
        if (!d || !d.roomId) throw new Error("no room");
        /* 이 계정이 저장해 둔 외형 — 주소를 안 고치고도 다음 접속부터 갈아입습니다 */
        if (d.look) applyLook(d.look, true);
        /* 붙었으니 물러남을 되돌립니다 — 다음에 끊기면 다시 1분부터 */
        CUR = d.roomId; dead = false; wait = 1000; bootTries = 0; connect();
      })
      .catch(function () { dead = true; render(); setTimeout(boot, bootWait()); });
  };

  /* 예시 방 — 서버에 방을 만들지 않고 페이지가 스스로 굴립니다 (2026-09-08 개편).
     소켓과 같은 길(onState)로 판을 밀어 넣어서, 실제 방송에 나가는 연출이 그대로 돕니다:
     대기실 → 시작 → 자수 카드 → 금액 스와이프·순위 이동 → 룰렛 → 표 반영, 그리고 슬라이드.
     예전에는 board 를 직접 갈고 render() 만 불러서 카드도 룰렛도 안 돌았습니다 — 예시를 보고
     "내 방송도 저렇겠구나" 할 수 없었습니다. 명단과 금액은 그대로 SAMPLE 을 씁니다 */
  var startDemo = function () {
    var COLS = [{ id: "c1", t: "잡힘" }, { id: "c2", t: "죽음" }];
    var FACES = ["1", "2", "3", "5", "-1", "x2"];
    var PRICE = [30000, 50000];
    var rows, feed, seq, spinNow, lobbyOn;
    var at = 0; /* 대본 커서 — reset 이 안 건드립니다 */

    var reset = function () {
      /* 줄 고유번호를 답니다 — 순위가 바뀔 때 FLIP 이 같은 줄을 따라가는 열쇠입니다 (§4.4) */
      rows = SAMPLE.map(function (p, i) {
        return { k: "r" + i, n: p[0], g: p[1],
                 c: [Math.round(p[1] / 150000), Math.round(p[1] / 260000)], d: 0 };
      });
      feed = [];
      seq = 0;
      spinNow = null;
      lobbyOn = true;
      /* at(대본 커서)은 여기서 안 건드립니다 — reset 이 커서까지 0 으로 되돌리면
         첫 걸음(대기실)만 무한히 되풀이합니다 (2026-09-08 실측) */
    };

    /* 순액 — 받을 몫에서 낸 벌금을 뺀 값. 슬라이드가 돌 것이 있어야 지표가 셋이 됩니다 */
    var reNet = function () {
      var tot = rows.reduce(function (a, r) { return a + r.g; }, 0);
      var share = Math.round(tot / rows.length / 10000) * 10000;
      rows.forEach(function (r) { r.d = share - r.g; });
    };

    var push = function () {
      reNet();
      var st = {
        name: "예시 파티",
        cols: COLS,
        board: rows.map(function (r) {
          return { k: r.k, n: r.n, g: r.g, c: r.c.slice(), d: r.d };
        }),
        fx: feed.slice(-6),
        spin: spinNow,
      };
      /* 대기실은 판 대신 그려집니다 — 정원만큼 줄을 미리 세우고 들어온 사람만 또렷하게 (§4.3) */
      if (lobbyOn) {
        st.lobby = { n: 4, cap: 8, names: [
          { n: rows[0].n, live: true, host: true },
          { n: rows[1].n, live: true },
          { n: rows[2].n, live: true },
          { n: rows[3].n, live: true },
          { n: rows[4].n, live: false },
        ] };
      }
      onState(st);
      /* 소켓 쪽 꼬리와 같은 줄입니다 — 대기실은 기다릴 판이 없으니 바로 그립니다 */
      if (dead || lobby) render();
      else pump();
    };

    /* 자수 한 번 — 카드가 뜨고, 카드가 지나간 뒤에 금액과 순위가 따라옵니다 */
    var confess = function () {
      var r = rows[Math.floor(Math.random() * rows.length)];
      var ci = Math.random() < 0.6 ? 0 : 1;
      r.c[ci] += 1;
      r.g += PRICE[ci];
      feed.push({ i: "f" + ++seq, k: "add", n: r.n, t: COLS[ci].t, g: PRICE[ci] });
      push();
    };

    /* 룰렛 한 판 — 판과 결과 카드를 한 번에 실어 보냅니다. 원판이 서면 결과 카드가 먼저 뜨고,
       그 뒤에 표가 앉습니다 (연출 순서 규칙 ③④⑤) */
    var roulette = function () {
      var r = rows[Math.floor(Math.random() * rows.length)];
      var k = FACES[Math.floor(Math.random() * 4)];
      var gold = Number(k) * 30000;
      r.c[1] += 1;
      r.g += gold;
      spinNow = {
        sid: "s" + ++seq,
        look: "wheel",
        theme: "satin",
        faces: FACES,
        w: {},
        steps: [{ k: k }],
        phase: "done",
        who: r.n,
        item: COLS[1].t,
        gold: gold,
        out: { name: r.n, g: gold, after: r.g, raw: gold },
        cfg: { roll: 4200, free: 260, face: 70 },
      };
      feed.push({ i: "f" + ++seq, k: "roul", n: r.n, t: COLS[1].t, g: gold });
      push();
    };

    /* 한 바퀴 — 대기실로 열고, 자수 몇 번에 룰렛 한 판을 끼우고, 다시 처음으로.
       [뒤 숫자는 그 걸음이 끝나고 다음 걸음까지 기다리는 밀리초] */
    var SCRIPT = [
      ["lobby", 7000],
      ["start", 2600],
      ["confess", 4200],
      ["confess", 4200],
      ["confess", 4200],
      ["roulette", 15000],
      ["confess", 4200],
      ["confess", 4200],
      ["confess", 6000],
      ["clear", 3000],
    ];

    var tick = function () {
      var s = SCRIPT[at % SCRIPT.length];
      at++;
      if (s[0] === "lobby") { reset(); push(); }
      else if (s[0] === "start") { lobbyOn = false; push(); }
      else if (s[0] === "confess") confess();
      else if (s[0] === "roulette") roulette();
      else if (s[0] === "clear") { spinNow = null; push(); }
      setTimeout(tick, s[1]);
    };

    reset();
    tick();
  };

  /* 창 크기를 바꾸면 vw 가 달라져 판 크기도 달라집니다 — 그 즉시 다시 맞춥니다 */
  window.addEventListener("resize", fitBoard);

  /* 방송용 글꼴은 네트워크로 옵니다 (2026-09-08) — 먼저 폴백 글꼴로 그려진 뒤 바뀌므로
     그때 폭이 달라집니다. 다 받고 나서 칸 글자 크기와 배율을 한 번 다시 잽니다.
     못 받으면 이 약속은 그냥 안 옵니다 — 화면은 폴백 글꼴 그대로입니다 */
  if (document.fonts && document.fonts.ready && document.fonts.ready.then) {
    document.fonts.ready.then(function () {
      /* 열 폭도 다시 잽니다 (2026-09-08) — 첫 그림은 폴백 글꼴로 쟀는데 방송용 글꼴이
         뒤늦게 오면 글자 폭이 달라집니다. 안 다시 재면 다음 판이 올 때 그때서야 재면서
         폭이 한 번 튀고, 래칫이라 그 자리에 눌러앉습니다 */
      if (board) setGoldW(board);
      fitCheads();
      fitLabel();
      fitBoard();
    });
  }

  if (isDemo) startDemo();
  else { render(); boot(); }
})();
</script>
</body>
</html>`;
