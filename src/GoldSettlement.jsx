import { useState, useMemo, useRef, useEffect, useLayoutEffect, Fragment } from "react";

/* ==================================================================
   벌금 정산 · 최소 송금 계산기

   계산은 전부 이 파일 안에서 끝납니다. 외부 호출·AI 없음.
     1) 벌금표에서 사람별 총 벌금을 구한다  (횟수 × 항목 단가 + 기타 벌금)
     2) 벌금 전액을 인원수로 균등 분배한다
        각자의 순액 = 받을 몫 − 자기 벌금
        (+)면 받는 쪽, (−)면 보내는 쪽. 많이 물린 사람이 적게 물린 사람에게 보낸다.
     3) 순액 합이 0인 부분집합으로 최대한 잘게 쪼갠다  (비트마스크 DP)
        → 최소 송금 횟수 = (순액 0이 아닌 인원) − (그룹 수), 이게 이론적 하한
     4) 그룹 안에서 큰 채무자 ↔ 큰 채권자를 붙인다  (그룹당 인원−1회, 최적)
   모든 송금이 보내는 사람 → 받는 사람 1홉이라 받는 쪽은 전원 정확히 (100−수수료)%.

   표 전체는 URL 해시 하나로 공유됩니다. 한글을 그대로 넣으면 퍼센트 인코딩으로
   글자당 9자까지 부풀기 때문에, 구분자 1바이트짜리 포맷으로 직렬화한 뒤
   UTF-8 → base64url로 접어서 싣습니다.
================================================================== */

const UNIT = 10000; // '만' 표기용

/* 간단 모드 — 항목 없이 이름과 금액만. 기존 모델을 그대로 쓰되
   '단가 = 입력 단위' 인 열 하나짜리 표로 취급합니다. */
const SIMPLE_ID = "simple";
const UNITS = [
  { v: "100000", label: "십만G" },
  { v: "10000", label: "만G" },
  { v: "1", label: "1G" },
];
/* 입력 단위 예시 — 친 숫자와 그게 되는 금액을 짝으로 보여 줍니다.
   문장 안에 점으로 늘어놓으면 어디까지가 한 짝인지 안 읽혀서 칩으로 끊었습니다. */
const UNIT_EX = {
  "100000": [["5", "50만"], ["1.5", "15만"]],
  "10000": [["5", "5만"], ["2.32", "2만 3,200"]],
  "1": [["50,000", "50,000"]],
};

/* 셋째 항목은 이름을 비워 둡니다 — 플레이스홀더가 "여기에 항목을 만드세요"를 말해 줍니다 */
/* 기본 항목 셋. 마지막은 룰렛입니다 — 비율은 안 적으면 기본 비율을 씁니다. */
/* 룰렛 항목의 기본 이름은 보통 항목과 갈라 둡니다 — 이름이 겹치면 자수 카드도
   aria 라벨도 같은 말이 둘이 되어 어느 쪽을 누르는지 못 가립니다. 화면에서는
   앞에 ◎ 가 붙어 `◎ 룰렛` 으로 읽힙니다 (§3.1). 이미 저장된 판의 이름은 안 건드립니다 */
const DEFAULT_COLS = [
  { id: "c1", name: "잡힘", price: "10,000" },
  { id: "c2", name: "죽음", price: "30,000" },
  { id: "c3", name: "룰렛", price: "10,000", type: "roulette" },
];

/* 예시 데이터는 한 벌입니다 — 같은 사람, 같은 금액을 두 모드가 각자의 방식으로 적습니다.
   모드를 바꿔도 장부·우편 숫자가 그대로라, '같은 장부를 다르게 적는 것'이 눈에 보입니다.
   카운터는 횟수(1만·3만·10만 항목), 메모장은 그 합계(만G)로. */
const DEFAULT_PEOPLE = [
  ["눈가루", 3, 2, 0], // 9만
  ["팔복", 11, 1, 2], // 34만
  ["읍지", 2, 10, 0], // 32만
  ["히휴", 8, 1, 0], // 11만
  ["주키니", 20, 5, 1], // 45만
  ["포셔", 5, 4, 0], // 17만
  ["티모", 0, 2, 0], // 6만
  ["이다", 5, 1, 1], // 18만
];
/* 항목 단가(1만·3만·10만)를 그대로 곱해 메모장 쪽 금액을 뽑습니다 — 두 예시가 어긋날 일이 없게 */
/* 기본 항목의 단가와 같아야 합니다 — 카운터와 메모장 예시가 어긋나지 않게 */
const peopleGold = (c1, c2, c3) => c1 * 10000 + c2 * 30000 + c3 * 10000;

const DEFAULT_ROWS = DEFAULT_PEOPLE.map(([name, c1, c2, c3], i) => ({
  id: "r" + (i + 1),
  name,
  counts: { c1: c1 ? String(c1) : "", c2: c2 ? String(c2) : "", c3: c3 ? String(c3) : "" },
  extras: [],
}));

/* 메모장 — 같은 사람의 같은 총액을 만G 로 (기본 입력 단위) */
const DEFAULT_ROWS_SIMPLE = DEFAULT_PEOPLE.map(([name, c1, c2, c3], i) => ({
  id: "r" + (i + 1),
  name,
  counts: { [SIMPLE_ID]: String(peopleGold(c1, c2, c3) / UNIT) },
  extras: [],
}));

/* 예시 표에 딸린 기록 — 이 표가 어떻게 채워졌는지 보여주는 한 판 분량입니다.
   숫자는 예시와 정확히 맞습니다. 잘못 눌러 취소한 한 줄은 취소가 상쇄하고,
   단가 변경은 '죽음'을 아무도 세기 전에 일어나서 지금 표(횟수 × 단가)와 어긋나지 않습니다. */
function demoLog(now) {
  const at = typeof now === "number" ? now : Date.now();
  const PRICE = { c1: 10000, c2: 30000, c3: 100000 };
  const ITEM = { c1: "잡힘", c2: "죽음", c3: "암살" };
  /* 매번 같은 기록이 나오도록 고정 씨앗을 씁니다 */
  let seed = 20250822;
  const rnd = (k) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % k);

  /* 누를 것을 전부 모아 한 번에 섞습니다 — 라운드로 돌리면 횟수 많은 사람만
     뒤에 몰려서, 마지막 열 줄이 한 사람으로 채워집니다 */
  const presses = [];
  DEFAULT_PEOPLE.forEach(([name, c1, c2, c3], i) => {
    const rowId = "r" + (i + 1);
    [["c1", c1], ["c2", c2], ["c3", c3]].forEach(([colId, cnt]) => {
      for (let k = 0; k < cnt; k++) presses.push({ rowId, name, colId });
    });
  });
  for (let i = presses.length - 1; i > 0; i--) {
    const j = rnd(i + 1);
    const tmp = presses[i];
    presses[i] = presses[j];
    presses[j] = tmp;
  }

  const out = [];
  const total = {};
  let t = at - 100 * 60 * 1000;
  let id = 1;
  const tick = () => (t += 20000 + rnd(80) * 1000); // 20초~100초 간격

  out.push({
    id: "x" + id++,
    t: tick(),
    kind: "price",
    colId: "c2",
    item: "죽음",
    from: 20000,
    to: 30000,
    mode: "forward",
  });

  const push = (x, extra) => {
    const g = PRICE[x.colId];
    total[x.rowId] = (total[x.rowId] || 0) + g;
    const en = {
      id: "x" + id++,
      t: tick(),
      kind: "press",
      rowId: x.rowId,
      colId: x.colId,
      n: 1,
      delta: g,
      name: x.name,
      item: ITEM[x.colId],
      after: total[x.rowId],
      ...extra,
    };
    out.push(en);
    return en;
  };

  /* 잘못 누르고 몇 번 뒤에 취소한 자리 — 기록이 어떻게 남는지 보이라고 한 줄 넣어 둡니다 */
  const OOPS = Math.floor(presses.length * 0.45);
  let oopsId = null;
  presses.forEach((x, i) => {
    if (i === OOPS) {
      oopsId = push({ rowId: "r6", name: "포셔", colId: "c1" }, { cancelled: true }).id;
    }
    if (i === OOPS + 3 && oopsId) {
      total.r6 -= PRICE.c1;
      out.push({
        id: "x" + id++,
        t: tick(),
        kind: "cancel",
        refId: oopsId,
        rowId: "r6",
        delta: -PRICE.c1,
        name: "포셔",
        item: "잡힘",
        after: total.r6,
      });
    }
    push(x);
  });
  return out;
}

const num = (v) => {
  const n = parseFloat(String(v ?? "").replace(/[,\s]/g, ""));
  return Number.isFinite(n) ? n : 0;
};

// 금액 입력. '10만' 처럼 적어도 100,000으로 읽습니다.
const goldOf = (v) => {
  const s = String(v ?? "").replace(/[,\s]/g, "");
  const m = /^(\d*\.?\d*)만$/.exec(s);
  if (m) return (parseFloat(m[1]) || 0) * UNIT;
  return num(s);
};

/* 칸에는 횟수만이 아니라 금액을 그대로 적는 사람도 있어서, 폭을 내용에 맞춰 늘립니다.
   대신 무한정 늘어나지 않게 상한을 둡니다. 콤마가 붙으므로 자릿수가 아니라
   실제 글자 수로 잽니다 (999,999,999 = 11자). */
const MAX_INPUT_CHARS = 12;
const MAX_COUNT = 999999999;
// 메모장 → 카운터로 넘어올 때 기타에 남기는 사유
const CARRY_REASON = "'메모장'에서 이관";
/* 시스템이 만드는 기타 차액(합계 직접 수정·메모장 수정분·취소 잔액)은 전부 이 한 단어로.
   기타 사유 칸은 암살·지각 같은 '왜'의 자리라, '어떻게'(경로)는 기록이 말하게 둡니다. */
const ADJUST_REASON = "조정";
const LOG_CAP = 200; // 기록은 최근 200줄만 남깁니다 (공유 링크엔 안 담김)
/* 방송에 실어 보내는 연출거리 개수 — 이보다 오래된 건 이미 흘러간 것으로 봅니다 */
const FX_CAP = 12;

/* 손대지 않은 예시 데이터인지. 맞으면 모드를 바꿀 때 조용히 상대 모드 예시로 갈아끼웁니다. */
function isPristine(rows) {
  const same = (def) =>
    rows.length === def.length &&
    rows.every((r, i) => {
      const d = def[i];
      if (r.name !== d.name || extrasOf(r).length) return false;
      const keys = new Set([...Object.keys(r.counts || {}), ...Object.keys(d.counts || {})]);
      return [...keys].every((k) => (r.counts?.[k] || "") === (d.counts?.[k] || ""));
    });
  return same(DEFAULT_ROWS) || same(DEFAULT_ROWS_SIMPLE);
}
const CHAT_LIMIT = 50; // 인게임 채팅 한 줄 제한
const CHAT_MIN_NAME = 2; // 이름을 줄이더라도 여기까지만

/* 채팅 줄의 숫자는 만 단위입니다. '만'을 떼고 숫자만 적되,
   딱 떨어지지 않으면 소수로 남겨서 금액이 틀어지지 않게 합니다. (12만8750 → 12.875) */
const chatNum = (v) => {
  const m = v / UNIT;
  return Number.isInteger(m) ? String(m) : String(Number(m.toFixed(4)));
};

/* 50자를 넘으면 이름을 한 글자씩 깎습니다. 전체 → n자 → n-1자 → … → 2자. */
function chatLineOf(entries) {
  const build = (cap) => entries.map((e) => (cap ? e.name.slice(0, cap) : e.name) + e.num).join("");
  let out = build(null);
  if (out.length <= CHAT_LIMIT) return out;
  const longest = entries.reduce((a, e) => Math.max(a, e.name.length), 0);
  for (let cap = longest - 1; cap >= CHAT_MIN_NAME; cap--) {
    out = build(cap);
    if (out.length <= CHAT_LIMIT) return out;
  }
  return out; // 2자까지 깎아도 넘으면 그대로 두고 카운터로 알립니다
}
const cntWidth = (v, min = 3) =>
  `calc(${Math.min(MAX_INPUT_CHARS, Math.max(min, String(v ?? "").length))}ch + 12px)`;

/* 입력칸 공통 정리 — 숫자가 아닌 글자는 버리고 천 단위 콤마를 붙입니다.
   소수점은 하나까지 남깁니다 (만G 단위에서 26.5 같은 값을 적을 수 있게).
   signed 를 켜면 맨 앞 빼기표 하나만 남깁니다 — 룰렛에 음수 면을 넣을 때 씁니다. */
function formatNumInput(raw, signed) {
  const neg = signed && /^\s*-/.test(String(raw ?? ""));
  let s = String(raw ?? "").replace(/[^\d.]/g, "");
  const dot = s.indexOf(".");
  if (dot !== -1) s = s.slice(0, dot + 1) + s.slice(dot + 1).replace(/\./g, "");
  if (s === "") return neg ? "-" : "";
  const [int, dec] = s.split(".");
  const head = int ? Number(int).toLocaleString("ko-KR") : "";
  const body = dec === undefined ? head : `${head}.${dec}`;
  return (neg ? "-" : "") + body;
}

// 콤마가 붙은 뒤에도 커서가 방금 친 숫자 뒤에 남도록 위치를 다시 잡습니다
function caretAfterDigits(text, digits) {
  if (digits <= 0) return 0;
  let seen = 0;
  for (let i = 0; i < text.length; i++) {
    if (/\d/.test(text[i]) && ++seen === digits) return i + 1;
  }
  return text.length;
}

/* ---------- 메모장 모드 ----------
   '로마러 25' 처럼 이름과 금액을 한 줄에 적습니다. 줄 끝의 숫자 덩어리를 금액으로,
   그 앞을 통째로 이름으로 봅니다. 이름에 공백이 있어도 됩니다. */
function parseMemoLine(line) {
  const s = line.trim();
  if (!s) return null;
  const m = /^(.*?)[\s,:\t]*([0-9][0-9,.]*)\s*$/.exec(s);
  if (!m) return { name: s, amount: "" };
  return { name: m[1].trim(), amount: formatNumInput(m[2]) };
}

/* 한 줄에 여러 사람이 붙어 있는 메모 — '눈가루5 팔복15 읍지14 …'. 실제 메모장이 이렇게 생겼습니다.
   공백으로 쪼개서 '이름+숫자' 토큰이 있고 토큰이 둘 이상이면 토큰마다 한 사람으로 읽습니다.
   '도읍지 25'처럼 띄어 쓴 기존 형식(이름+숫자 토큰이 없음)은 그대로 한 줄 한 사람입니다.
   섞여 있어도 됩니다: '눈가루5 팔복 15' → 눈가루/5, 팔복/15. */
function parseMemoEntries(line) {
  const s = line.trim();
  if (!s) return [];
  const toks = s.split(/\s+/);
  const GLUED = /^(.*?[^0-9,.\s])([0-9][0-9,.]*)$/; // 이름+숫자 (이름은 숫자로 안 끝남)
  const NUM = /^[0-9][0-9,.]*$/;
  const glued = toks.filter((t) => GLUED.test(t)).length;
  if (glued === 0 || toks.length < 2) return [parseMemoLine(s)].filter(Boolean);
  const out = [];
  let pending = null; // 숫자를 기다리는 이름
  toks.forEach((t, i) => {
    const next = toks[i + 1];
    const g = GLUED.exec(t);
    if (NUM.test(t)) {
      out.push({ name: pending || "", amount: formatNumInput(t) });
      pending = null;
    } else if (g && !(next && NUM.test(next))) {
      /* 뒤에 숫자 토큰이 따로 오면 이 토큰은 숫자로 끝나도 통째로 이름입니다 —
         '인기3 5'의 띄어쓰기가 곧 경계. 닉이 숫자로 끝날 때 쓰는 탈출구입니다. */
      if (pending) out.push({ name: pending, amount: "" });
      pending = null;
      out.push({ name: g[1], amount: formatNumInput(g[2]) });
    } else {
      pending = pending ? pending + " " + t : t;
    }
  });
  if (pending) out.push({ name: pending, amount: "" });
  return out;
}

const blankMemoRow = (x) =>
  !(x.name || "").trim() &&
  !(x.extras || []).length &&
  Object.values(x.counts || {}).every((v) => !parseFloat(String(v || "").replace(/[,\s]/g, "")));

function memoToRows(text, prev) {
  const made = text
    .split("\n")
    .flatMap(parseMemoEntries)
    .map((p, i) => ({
      id: prev[i] ? prev[i].id : "memo" + i,
      name: p.name,
      counts: { ...(prev[i] ? prev[i].counts : {}), [SIMPLE_ID]: p.amount },
      extras: (prev[i] && prev[i].extras) || [],
    }));
  /* 글에 안 잡힌 뒤쪽의 빈 슬롯 행은 남깁니다 — 초기화 직후의 빈 행들이 첫 타자에
     몽땅 사라지지 않게. 내용이 있던 행은 줄이 줄면 지워집니다(줄 삭제 = 사람 삭제). */
  for (let i = made.length; i < prev.length; i++) {
    if (blankMemoRow(prev[i])) made.push(prev[i]);
  }
  return made;
}

const rowsToMemo = (rows) =>
  rows
    /* 띄어쓰기는 안 해도 됩니다 — 표에서 만들어 줄 때도 붙여 써서 그걸 보여 줍니다.
       단, 이름이 숫자로 끝나면(인기3) 붙이면 금액과 섞이니 그때만 한 칸 띄웁니다. */
    .map((r) => {
      const raw = (r.name || "").trim();
      /* (이름입력n) 자리표시는 메모장에선 빈 줄입니다 */
      const name = isFillName(raw) ? "" : raw;
      const amt = r.counts?.[SIMPLE_ID] || "";
      /* 0골은 굳이 안 적습니다 — 명단만 채운 줄은 이름만 보이게 */
      const zero = !amt || num(amt) === 0;
      if (!name) return zero ? "" : amt;
      if (zero) return name;
      return /[0-9]$/.test(name) ? name + " " + amt : name + amt;
    })
    .join("\n")
    // 뒤쪽 빈 슬롯 행의 빈 줄은 메모에 안 적습니다 (위 보존 규칙과 왕복이 맞습니다)
    .replace(/\s+$/, "");

/* 표에 있는 줄은 전부 파티원입니다. 안 쓰는 줄은 지우면 되고, 벌금이 0인 사람도
   정산에서는 돈을 받는 쪽이라 인원에서 빼면 안 됩니다.
   이름은 빈 문자열로 두고 입력칸의 placeholder 로만 보여 줍니다 — 자리표시를
   실제 이름으로 저장하면 우편·오버레이·채팅으로 그대로 새어 나갑니다. */
/* 빈 자리는 "(모험가n)"이라는 실제 이름으로 채워 둡니다. 번호가 있어 장부·우편·
   오버레이에서 누구 줄인지 구분되고, 닫는 괄호가 이름과 금액의 경계라 메모장에서
   붙여 써도 안 섞입니다. 벌금이 0이어도 정산 인원입니다 (표에 있는 줄 = 사람). */
/* 송출 상태의 문장들 (§5.7·§8) — 공유 설정 창의 주소 밑 한 줄과 헤더 툴팁이 씁니다.
   라벨("판 없음" 따위)은 폐기 (2026-09-05) — 지어낸 두 글자 상태어는 아무 서비스에도
   없는 말이라 문장으로 말합니다. 주소는 "내가 있는 판"을 그대로 비추는 것이라,
   [시작] 같은 방장 전용 동사에 기대지 않습니다 (파티원도 이 창을 봅니다).
   계기판이라 "고치는 법"까지 말합니다 — 안 뜰 때 OBS 쪽을 볼지 앱 쪽을 볼지가
   한 줄로 갈려야 두 군데를 뒤지지 않습니다 */
const CAST_WHY = {
  none: "방송용 주소를 아직 안 받았어요. 받으면 이 자리에서 지금 뭐가 나가는지 알려줘요.",
  down: "서버와 연결이 끊겨서 갱신이 멈췄어요. 마지막으로 보낸 판이 그대로 떠 있어요.",
  /* (폐기 2026-09-05) idle `이 주소에는 내가 있는 판이 그대로 떠요. 지금은 판에 있지 않아요.` — 방장이 제
     시작 전 판을 보며 읽으면 틀린 말이었다. 이 문장들은 방장만 봅니다(파티원 툴팁은 따로) — [시작]을 써도 됩니다 */
  idle: "아직 시작 전이에요 — 지난 판이 있으면 그게 떠 있고, [시작]을 누르면 이 판이 나가요.",
  recruit: "대기실이 나가고 있어요 — 모이는 사람이 방송에 보여요. [시작]을 누르면 이 판이 나가요.",
  on: "이번 판이 이 주소에 나오고 있어요. 방송에 안 보이면 OBS 쪽 소스를 확인해 주세요.",
};
const FILL_NAME = (k) => "(모험가" + k + ")";
/* 예전 이름들도 자리표시로 알아봐야 합니다 — 저장된 표를 열었을 때 그대로 남으면
   지우지도 못하고 진짜 이름처럼 굴러다닙니다. */
const isFillName = (s) => /^\((이름(입력|없음)|모험가)\d+\)$/.test(s || "");
/* 이름 없는 자리는 화면에서도 판에서도 이 이름으로 부릅니다 (§3.1) — 괄호가
   "아직 이름을 안 정한 자리, 자동으로 차거나 나중에 고치는 칸"을 그 자리에서 말합니다.
   게임 캐릭터 이름을 빌리면 진짜 사람처럼 읽혀서 못 씁니다(실리안 여덟 명은 폐기). */
const ANON = (i) => FILL_NAME(i + 1);
const seatName = (row, i) => ((row && row.name) || "").trim() || ANON(i);
/* 판 기록에 적을 파티원 — 손으로 적은 이름만 남깁니다. 자리 채우는 기본 이름은
   누구인지 말해 주지 않아서 목록만 길어집니다 */
const realNames = (rws) =>
  (rws || []).map((r) => ((r && r.name) || "").trim()).filter((n) => n && !isFillName(n));
const noFine = (x) =>
  !(x.extras || []).length && Object.values(x.counts || {}).every((v) => !num(v));
/* 옛 규칙에서는 "(이름입력n) + 벌금 0" 행이 정산 인원에서 빠졌습니다. 그 행을 남긴 채
   이름만 비우면 인원수(n)가 늘어 예전 정산 금액이 바뀝니다. 그래서 이름을 실제로 넣어
   쓰던 표에서만 남은 자리표시 행을 지웁니다 — 그 표에서 그 행은 안 쓴 자리였으니까요.
   아무도 이름을 안 넣은 표는 아직 시작 안 한 표라, 줄을 그대로 두고 이름만 비웁니다.
   (여기서 지워 버리면 "이름은 아직, 벌금부터" 쓰던 표가 통째로 사라집니다.)
   지우는 것은 **옛 패턴만**입니다 — 지금 문법의 (모험가N) 줄은 "이름을 아직 안 적은
   참가자 칸"이라(§3.1: 빈 칸이 그 이름 그대로 판에 들어간다) 리로드에 살아남아야 합니다. */
const isOldFillName = (s) => /^\(이름(입력|없음)\d+\)$/.test(s || "");
const migrateRows = (rows) => {
  if (!Array.isArray(rows)) return rows;
  const named = rows.some((x) => (x.name || "").trim() && !isFillName(x.name));
  const kept = named ? rows.filter((x) => !(isOldFillName(x.name) && noFine(x))) : rows;
  /* 예전 자리표시는 새 이름으로 갈아 끼웁니다 — 안 그러면 예전에 만든 표에만
     "(이름입력3)" 이 남아 두 가지 이름이 섞여 보입니다. 뒤의 번호는 그대로 둡니다:
     그 번호가 줄을 가리키는 이름이라, 다시 매기면 지금까지 쓰던 호칭이 바뀝니다. */
  return kept.map((x) =>
    isFillName(x.name)
      ? { ...x, name: x.name.replace(/^\(이름(입력|없음)/, "(모험가") }
      : x
  );
};
/* 옛 [4인]·[8인]이 깔아 둔 채우기 이름들. 이제 빈 자리는 이름이 빈 채로 두고
   (모험가N) 자리표시로만 부르므로, 남아 있으면 진짜 사람처럼 자리를 차지합니다 —
   사람이 앉을 칸을 막지 않게 이름을 비웁니다. 손으로 친 이름(named)은 안 건드립니다. */
const OLD_FILL_NAMES = ["실리안", "니나브", "샨디", "웨이", "갈라투르", "아제나", "이난나", "카단"];
const migrateSeats = (list) =>
  (Array.isArray(list) ? list : []).map((s) =>
    s &&
    !s.acct &&
    ((!s.named && OLD_FILL_NAMES.includes((s.name || "").trim())) || isFillName(s.name))
      ? { ...s, name: "", named: false }
      : s
  );

/* ================= 룰렛 항목 =================
   면은 숫자 1~5·20, 그리고 양도권과 ×2 입니다. 숫자가 나오면 "단가 × 숫자"만큼
   벌금이 붙습니다. ×2 는 테이블에서 안 빠져서 곱이 계속 쌓이고, 양도권은 한 번
   나오면 그 판에서 빠집니다. 양도권이 나온 판의 금액은 서기가 고른 다른 사람에게
   갑니다. 비율은 열마다 따로 두고 고칠 수 있습니다. */
/* 예시에 쓰는 이름 — 파티원 이름을 빌려 쓰면 이름이 비었을 때 "(이름입력1)이(가)"
   가 되고, 이름이 차 있으면 실제로 있었던 일처럼 읽힙니다. 게임 사람 이름을 고정으로
   씁니다. 누가 봐도 파티원이 아니라 예시라는 게 보입니다. */
const EX_NAMES = ["샨디", "니나브"];
const ROULETTE_NUMS = [1, 2, 3, 4, 5, 20];
const PASS = "pass"; // 양도권
const X2 = "x2";
const ROULETTE_KEYS = [...ROULETTE_NUMS.map(String), PASS, X2];
/* 기본 비율 — 1~5 는 5, 20·양도권·×2 는 1 (합 28) */
const ROULETTE_W = { "1": 5, "2": 5, "3": 5, "4": 5, "5": 5, "20": 1, [PASS]: 1, [X2]: 1 };

/* 면 하나는 글자 하나로 적습니다 — 숫자면 "20", 곱하기면 "x3", 양도권은 "pass".
   열마다 면을 더하고 뺄 수 있어서, 목록도 비율처럼 열에 붙여 둡니다. */
const isMultKey = (k) => /^x\d+$/.test(k || "");
const faceMult = (k) => (isMultKey(k) ? Number(String(k).slice(1)) || 1 : 1);
const faceLabel = (k) =>
  k === PASS ? "양도권" : isMultKey(k) ? "×" + faceMult(k) : String(k).replace(/^-/, "−");
const faceNum = (k) => (k === PASS || isMultKey(k) ? 0 : Number(k) || 0);
const isNumKey = (k) => k !== PASS && !isMultKey(k);
/* 도는 속도. 방송은 뜸을 들여야 재미가 사는 쪽이라 기본을 넉넉히 잡았습니다.
   roll 은 한 번 도는 시간, hold 는 멈춘 값을 보여 주는 시간입니다. */
/* 결과를 보여 주고 넘어가는 시간. 도는 시간(roll)은 여기 없습니다 — 감속에서 나오니까요
   (2026-09-07). 표가 남은 건 옛 저장값 `spd` 를 아직 읽어서고, 고르는 UI 는 없습니다. */
const SPINS = {
  fast: { hold: 700, end: 1100, label: "빠르게" },
  normal: { hold: 1100, end: 1500, label: "보통" },
  slow: { hold: 1500, end: 1900, label: "느리게" },
  epic: { hold: 1800, end: 2200, label: "아주 느리게" },
};
/* 기본은 느리게 — 방송은 뜸을 들여야 재미가 삽니다 */
const spinSpeed = (k) => SPINS[k] || SPINS.slow;
/* 답을 기다리는 동안 한 바퀴 도는 시간. 숫자가 안 읽힐 만큼 빨라야 "멈춰!"가 성립합니다.
   감속 곡선은 이 속도에서 그대로 이어받게 계산하므로, 여기만 바꾸면 전체가 따라옵니다.
   방송(page.js)의 ov-w-free 와 같은 값이라 서기 화면과 오버레이가 같은 속도로 돕니다. */
const FREE_MS = 260;
/* 릴이 한 면을 보여 주는 시간. 멈추는 동안 이 간격이 늘어나며 감속을 보여 줍니다 */
const FACE_MS = 70;
/* 감속은 슬라이더 0~100 하나가 정합니다 (2026-09-07 사용자 확정, 규칙 재정립).
   도는 동안의 속도는 균일하고(FREE_MS) 커스텀이 없습니다 — 고를 수 있는 건 감속뿐입니다.
   **총 시간이라는 입력은 없습니다.** 서는 데 걸리는 시간도 바퀴 수도 감속에서 나오는 결과입니다.
   슬라이더는 서는 시간에 선형입니다 — 0 이 2.5초(감속 554°/s², 5바퀴), 100 이 25초(55°/s², 48바퀴).
   눈금이 고르게 느려지라고 시간 축에 선형으로 둡니다(감속도에 선형이면 오른쪽 끝만 폭발합니다).
   보통 10(4.8초) · 느긋하게 30(9.3초), 기본 30.
   (폐기 2026-09-07) 곡선 x2 를 지수로 흔들던 슬라이더(.62→.15)와 SPIN_AIM·SPIN_TAIL.
   7초 고정 안에서 배분만 바꾸던 것이라 오른쪽으로 갈수록 "느리게"가 아니라 "일찍 다 와서
   기어감"이 됐습니다 — 마지막 2초에 도는 각이 357°(왼쪽 끝)에서 68°(오른쪽 끝)로 줄었습니다.
   감속의 세기 자체는 못 바꾸는 축이었습니다. */
const GLIDE_NORMAL = 10;
const GLIDE_GENTLE = 30;
const GLIDE_DEFAULT = 30;
const GLIDE_MS_LO = 2500;
const GLIDE_MS_HI = 25000;
const spinGlideOf = (r) => (r && Number.isFinite(r.spinGlide) ? Math.max(0, Math.min(100, r.spinGlide)) : GLIDE_DEFAULT);
const isPresetGlide = (r) => spinGlideOf(r) === GLIDE_NORMAL || spinGlideOf(r) === GLIDE_GENTLE;
/* 슬라이더 값 → 서는 데 걸리는 시간. 판이 시작될 때 한 번 재서 판(spin.roll)에 얼려 싣습니다 —
   서기 원판·사람 원판·파티원 원판·방송 원판이 전부 이 한 값을 씁니다 (룰렛은 방장 것). */
const glideMs = (g) => Math.round(GLIDE_MS_LO + ((GLIDE_MS_HI - GLIDE_MS_LO) * Math.max(0, Math.min(100, g))) / 100);
const spinRoll = (sp) => (sp && sp.roll > 0 ? sp.roll : glideMs(GLIDE_DEFAULT));
/* 멈추는 동안 면이 바뀌는 간격 — 원판과 같은 등감속입니다. 속도가 (1−p) 로 줄어드니
   간격은 그 역수로 벌어집니다. 원판과 릴이 같은 판에서 같은 속도감으로 서야 해서요.
   끝에서 무한대로 가지 않게 상한을 둡니다(마지막 한 칸은 어차피 결과가 차지합니다).
   p 는 멈추기 시작한 뒤 흐른 비율입니다.
   (폐기 2026-09-07) 지수 6^p — 곡선이 지수였을 때 그 성격에 맞춘 것이었습니다 */
const FACE_CAP = 12;
const faceGap = (p) => Math.round(FACE_MS / Math.max(1 - Math.min(1, Math.max(0, p)), 1 / FACE_CAP));
/* 판 번호에서 뽑는 씨앗 — 같은 판이면 어느 화면에서 보든 같게 흔들려야 합니다 */
const seedOf = (v) => {
  const t = String(v || "");
  let h = 0;
  for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) >>> 0;
  return h;
};
/* 속도와 돌아가는 모습은 룰렛 열마다가 아니라 한 번만 정합니다 — 열마다 다른 속도로
   돌 이유가 없고, 어차피 방송에 보이는 것이라 OBS · 외형 설정에 함께 둡니다. */
/* 속도 고르기는 없앴습니다 — 멈추는 건 STOP 이 하니 도는 시간은 하나면 충분하고,
   예전에 저장해 둔 값이 남아 있으면 지운 설정이 계속 따라다닙니다 */
const spinSpd = () => "slow";

/* 벌금이 붙을 때의 연출 — 방송 화면에서만 쓰입니다.
   fxSpd: 알림 카드를 얼마나 오래 띄울지(끔 포함). mvMode: 금액이 바뀌는 걸 어떻게 보일지.
   둘은 하는 말이 다릅니다 — 카드는 "누가 무엇에", 금액 변동은 "그래서 얼마가 됐나". */
/* 알림은 켜고 끄기만 — 머무는 시간은 손볼 만한 값이 아니라서 하나로 고정했습니다 */
const fxOn = (r) => !(r && r.fx === "off");

/* 양도권이 나왔을 때 누가 무느냐 — 사람 원판을 한 번 더 돌리거나(랜덤, 기본),
   서기가 고르거나(지정). 랜덤일 때 돌린 사람도 후보에 넣는 게 기본입니다 —
   자기가 다시 걸릴 수 있어야 돌리는 맛이 삽니다. */
const passMode = (col) => ((col && col.passMode) === "pick" ? "pick" : "random");
const passSelf = (col) => (col && col.passSelf) !== false;

/* 돌아가는 모습 — 숫자만이 기본입니다. 원판은 고르면 씁니다 */
/* 기본은 원판입니다 — 슬롯은 고른 사람만 씁니다 */
const spinShape = (r) => ((r && r.spinLook) === "num" ? "num" : "wheel");
/* 원판 칸 색 — 글자를 안 쓰니 색으로 구분합니다. 양도권·곱하기는 고정색,
   숫자 면은 서로 다른 색을 돌려 씁니다. */
/* 원판 테마 — 새틴(기본)은 색으로 면을 구분하고, 카지노는 빨강·검정을 번갈아 칠합니다.
   새틴 팔레트는 예전 원색을 한 톤 가라앉힌 것 — 장난감이 아니라 도구로 보이게. */
const NUM_COLORS = [
  "#3c86ba", "#3f9c72", "#d9a83e", "#9a5fd0",
  "#3596bd", "#d97f75", "#5fae70", "#8e97d8",
];
const wheelTheme = (r) => ((r && r.wheelTheme) === "vegas" ? "vegas" : "satin");
const faceColor = (k, i, theme) => {
  if (theme === "vegas") {
    /* 카지노 — 숫자·곱하기는 빨강·검정 교대, 20은 초록(카지노의 0 자리), 양도권은 보라 */
    if (k === PASS) return "#5c1e66";
    if (k === "20") return "#146b3a";
    return i % 2 ? "#17171c" : "#a3202b";
  }
  return k === PASS ? "#c8493e" : isMultKey(k) ? "#cf7b16" : NUM_COLORS[i % NUM_COLORS.length];
};
/* 칸 사이 분리선까지 넣은 원뿔 그러데이션 문자열 — 앱·미리보기가 같은 걸 씁니다.
   아주 좁은 칸(3° 미만)엔 선을 안 넣습니다 — 칸보다 선이 굵어집니다. */
const wheelStops = (segs, theme) => {
  const sep = theme === "vegas" ? "#d4b25e" : "#2a1f16";
  const w = 0.8;
  return segs
    .map((x) => {
      const arc = x.to - x.from;
      if (arc < 3)
        return x.color + " " + x.from.toFixed(2) + "deg " + x.to.toFixed(2) + "deg";
      return (
        sep + " " + x.from.toFixed(2) + "deg " + (x.from + w).toFixed(2) + "deg," +
        x.color + " " + (x.from + w).toFixed(2) + "deg " + (x.to - w).toFixed(2) + "deg," +
        sep + " " + (x.to - w).toFixed(2) + "deg " + x.to.toFixed(2) + "deg"
      );
    })
    .join(",");
};
/* 무대 마감 겹 — 새틴은 숫자 밴드까지, 카지노는 광만 */
const wheelLayers = (stops, theme) =>
  (theme === "satin"
    ? "radial-gradient(circle, transparent 0 63%, rgba(18,12,8,.42) 66% 96%, transparent 97%)," 
    : "") +
  "radial-gradient(120% 90% at 32% 22%, rgba(255,255,255,.13), transparent 46%)," +
  "radial-gradient(circle, rgba(0,0,0,.36) 0 15%, rgba(0,0,0,.10) 34%, transparent 50% 72%, rgba(0,0,0,.20) 96%)," +
  "conic-gradient(" + stops + ")";
/* 칸을 비율만큼 나눕니다 — 잘 나오는 면이 넓어야 원판이 정직합니다 */
const wheelArcs = (faces, weights, theme) => {
  const ws = faces.map((k) => Math.max(0, num((weights || {})[k])) || 0);
  const tot = ws.reduce((x, y) => x + y, 0);
  let at = 0;
  return faces.map((k, i) => {
    const arc = tot > 0 ? (ws[i] / tot) * 360 : 360 / faces.length;
    const seg = { k, from: at, to: at + arc, mid: at + arc / 2, color: faceColor(k, i, theme) };
    at += arc;
    return seg;
  });
};
/* 양도권은 한 판에 한 번뿐입니다. 이미 나왔다면 그 뒤 회차의 원판에서는 빼야
   보는 사람이 "또 나올 수 있나?" 하고 헷갈리지 않습니다. */
const poolAt = (faces, steps, i) =>
  steps.slice(0, i).some((x) => x.k === PASS)
    ? faces.filter((f) => f !== PASS)
    : faces;
const passGone = (steps, i) => steps.slice(0, i).some((x) => x.k === PASS);
const PASS_GONE_MSG = "양도권은 한 판에 한 번이라 룰렛에서 빠졌어요";

const facesOf = (col) =>
  Array.isArray(col && col.faces) && col.faces.length ? col.faces : ROULETTE_KEYS;
const weightsOf = (col) => ({ ...ROULETTE_W, ...((col && col.w) || {}) });
/* 비율을 0 으로 적었으면 "이 면은 빼겠다"는 뜻입니다. 설정 표에는 그대로 남겨
   두되 원판과 추첨에서는 뺍니다. 전부 0 이면 뺄 게 없으니 그대로 둡니다. */
const liveFaces = (col) => {
  const w = weightsOf(col);
  return facesOf(col).filter((k) => Math.max(0, num(w[k])) > 0);
};
/* 판을 끝내는 건 숫자 면뿐입니다. 숫자가 하나도 안 남으면 양도권과 곱하기만
   끝없이 나와서 판이 안 끝납니다 — 돌리기 전에 막습니다. */
const canSpin = (col) => liveFaces(col).some(isNumKey);
const NO_NUM_MSG = "숫자 면이 전부 비율 0 이에요 — 하나는 비율을 넣어야 룰렛이 끝나요.";
const isRoulette = (col) => !!col && col.type === "roulette";

/* 비율대로 면 하나를 고릅니다. pool 에 든 면만 후보입니다. */
const drawFace = (weights, pool, rand) => {
  const w = (k) => Math.max(0, num(weights[k]));
  const tot = pool.reduce((a, k) => a + w(k), 0);
  if (tot <= 0) return pool[0];
  let r = rand() * tot;
  for (let i = 0; i < pool.length; i++) {
    r -= w(pool[i]);
    if (r < 0) return pool[i];
  }
  return pool[pool.length - 1];
};

/* 한 판을 끝까지 돌립니다. 화면이 순서대로 보여 줄 수 있게 나온 면을 차례로 남깁니다.
   ×2 는 안 빠지므로 이론상 끝이 없습니다 — 멈추지 않는 사고만 막는 안전선을 둡니다
   (비율이 정상이면 200번까지 갈 확률은 사실상 0입니다). */
const spinRoulette = (weights, rand, faces) => {
  const rnd = rand || Math.random;
  const steps = [];
  let pool = (faces && faces.length ? faces : ROULETTE_KEYS).slice();
  let mult = 1;
  let pass = false;
  let n = 0;
  for (let guard = 0; guard < 200; guard++) {
    const k = drawFace(weights, pool, rnd);
    if (isMultKey(k)) {
      mult *= faceMult(k);
      steps.push({ k, mult });
      continue;
    }
    if (k === PASS) {
      pass = true;
      pool = pool.filter((x) => x !== PASS);
      steps.push({ k, mult });
      continue;
    }
    n = faceNum(k);
    steps.push({ k, mult });
    break;
  }
  return { steps, n, mult, count: n * mult, pass };
};
/* 칸의 금액 — 누를 때마다 그 시점 단가로 굳혀 sums 에 쌓입니다.
   그래서 나중에 단가를 바꿔도 이미 센 것의 금액은 그대로입니다.
   sums 가 없는 칸(예전 저장분·메모장에서 온 표)은 예전처럼 횟수 × 단가로 봅니다. */
const cellGold = (row, colId, priceG) =>
  row.sums && row.sums[colId] != null
    ? Math.round(row.sums[colId])
    : Math.round(num(row.counts[colId]) * priceG);

/* 감면 규칙 — 빼기 면과 음수 기타는 "지금 벌금까지만" 깎습니다. 벌금표는 장부지
   지갑이 아니라서 0 밑으로는 안 내려가고, 깎고 남은 몫은 이월 없이 사라집니다.
   (이월 크레딧은 나중에 +5만을 눌렀는데 1만만 오르는 미스터리를 만듭니다.) */
const clampCut = (raw, total) =>
  raw < 0 ? -Math.min(-raw, Math.max(0, Math.round(total))) : raw;

const extrasOf = (row) => row.extras || [];
const extraSum = (row) => extrasOf(row).reduce((a, e) => a + Math.round(goldOf(e.amount)), 0);

const lowIdx = (low) => 31 - Math.clz32(low);

/* ---------- 공유 링크 인코딩 ---------- */
/* 구분자는 제어문자라 이름·사유에 섞일 일이 없고, UTF-8에서 1바이트입니다. */
const FIELD = "\u001f";
const ITEM = "\u001e";
const SECT = "\u001d";
const SUB = "\u001c";
const SHARE_KEY = "s";

const toB64Url = (str) => {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  bytes.forEach((b) => {
    bin += String.fromCharCode(b);
  });
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

const fromB64Url = (token) => {
  const b = token.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b.length % 4 ? "=".repeat(4 - (b.length % 4)) : "";
  const bin = atob(b + pad);
  return new TextDecoder().decode(Uint8Array.from(bin, (ch) => ch.charCodeAt(0)));
};

const tidy = (v) => String(v ?? "").replace(/[^\d.]/g, "");
// 링크에서 되살릴 때 금액은 기본값과 같은 '10,000' 꼴로 되돌려 놓습니다.
const commafy = (v) => {
  const n = Number(v);
  return v !== "" && Number.isFinite(n) ? n.toLocaleString("ko-KR") : v;
};

function encodeState(cols, rows, feePercent, mode = "items", unit = "10000") {
  const head = cols.map((c) => c.name + FIELD + tidy(goldOf(c.price))).join(ITEM);
  // 각 행의 마지막 칸은 간단 모드에서 적은 금액입니다 (항목 모드 숫자와 따로 보관)
  const body = rows
    .map((r) =>
      [
        r.name,
        ...cols.map((c) => {
          const cnt = tidy(r.counts[c.id]);
          if (!cnt) return cnt;
          const g = r.sums && r.sums[c.id] != null ? Math.round(r.sums[c.id]) : null;
          const plain = Math.round(num(r.counts[c.id]) * goldOf(c.price));
          return g != null && g !== plain ? cnt + ":" + g : cnt;
        }),
        tidy(r.counts[SIMPLE_ID]),
      ].join(FIELD)
    )
    .join(ITEM);
  const tail = rows
    .map((r) =>
      extrasOf(r)
        .map((e) => Math.round(goldOf(e.amount)) + SUB + (e.reason || ""))
        .join(FIELD)
    )
    .join(ITEM);
  const meta = ["1", tidy(feePercent), mode, unit].join(FIELD);
  return toB64Url([meta, head, body, tail].join(SECT));
}

function decodeState(token) {
  try {
    const [meta = "", head = "", body = "", tail = ""] = fromB64Url(token).split(SECT);
    const [ver, fee = "5", mode = "items", unit = "10000"] = meta.split(FIELD);
    if (ver !== "1") return null;

    const cols = head
      ? head.split(ITEM).map((s, i) => {
          const [name = "", price = ""] = s.split(FIELD);
          return { id: "c" + (i + 1), name, price: commafy(price) };
        })
      : [];

    const extraLists = tail ? tail.split(ITEM) : [];
    const rows = body
      ? body.split(ITEM).map((s, i) => {
          const parts = s.split(FIELD);
          const counts = {};
          const sums = {};
          cols.forEach((c, k) => {
            const raw = parts[k + 1];
            if (!raw) return;
            const [cnt, gold] = String(raw).split(":");
            counts[c.id] = cnt;
            if (gold !== undefined && gold !== "") sums[c.id] = num(gold);
          });
          if (parts[cols.length + 1]) counts[SIMPLE_ID] = parts[cols.length + 1];
          const extras = (extraLists[i] || "")
            .split(FIELD)
            .filter(Boolean)
            .map((chunk, k) => {
              const [amount = "", reason = ""] = chunk.split(SUB);
              return { id: `e${i + 1}_${k + 1}`, amount: commafy(amount), reason };
            });
          return { id: "r" + (i + 1), name: parts[0] || "", counts, sums, extras };
        })
      : [];

    if (cols.length === 0 && rows.length === 0) return null;
    return {
      cols,
      rows,
      feePercent: fee || "5",
      mode: mode === "simple" ? "simple" : "items",
      unit: UNITS.some((u) => u.v === unit) ? unit : "10000",
    };
  } catch (e) {
    return null;
  }
}

const MODE_KEY = "m";
const LIVE_KEY = "live"; // #live=ROOMID 로 들어오면 읽기 전용 뷰어
const JOIN_KEY = "j"; // #live=ID&j=CODE — 초대 코드. 읽기 권한까지만 나릅니다
const OBS_KEY = "o"; // #o=TOKEN — 내 방송용 주소. 지금 들어가 있는 방을 비춥니다
/* 예시 방 — 서버에 방이 없습니다. 앱이 예시 장부를 직접 비춰서, 실제 링크와 똑같이 동작합니다 */
const DEMO_ROOM = "CAFE22";
/* 지목 초대의 수명 — 서버와 같은 1분입니다 (§3.3). 알리는 배관이 없어서, 이 시간은
   "쏜 사람 화면의 `초대함…`을 언제 내리나"를 정하는 데 씁니다 */
const INV_MS = 60 * 1000;

/* ================= OBS 중계 =================
   방장의 앱만 상태를 밀어 올리고, OBS와 파티원은 읽기 전용으로 구독합니다.
   서버는 저장소가 아니라 릴레이입니다 — 진본은 이 브라우저에 있습니다.
   기록(로그)은 보내지 않습니다. */
const RELAY_BASE = (() => {
  if (typeof window === "undefined") return "https://live.lostark-sheet.workers.dev";
  const h = window.location.hostname;
  // 개발 중에는 같은 PC의 wrangler dev 를 봅니다
  if (h === "localhost" || h === "127.0.0.1") return "http://127.0.0.1:8787";
  return "https://live.lostark-sheet.workers.dev";
})();
const RELAY_KEY = "goldSettlement.relay";
const PARTY_REG_KEY = "goldSettlement.parties";
const partySlotKey = (name) => "goldSettlement.p." + name;
/* 파티 장부에 들어가는 필드 — 이 목록이 곧 "파티마다 따로"의 정의입니다 */
/* 판 이름 기본값 (§8) — 로비에서 고쳐 그 판의 이름이 되고, 결과지·판 기록에 남습니다.
   찾는 열쇠가 시각뿐이면 "9/3 20:26 ~ 20:27" 스무 줄에서 어느 것이 그 판인지 못 찾습니다 */
const defaultRoundName = (t) => {
  const d = t ? new Date(t) : new Date();
  return d.getMonth() + 1 + "월 " + d.getDate() + "일 벌금 파티";
};
const partyLedgerOf = (st) => ({
  rname: (st.rname || "").trim(),
  mode: st.mode,
  unit: st.unit,
  cols: st.cols,
  rows: st.rows,
  log: st.log || [],
  feePercent: st.feePercent,
  splitMode: st.splitMode === "solo" ? "solo" : "pot",
  memoFreeze: st.memoFreeze || null,
  undoSnap: st.undoSnap || null,
});

/* 파티원이 마지막으로 받은 판 — 정산은 판이 끝난 뒤에 하는데, 방장이 공유를 끄거나
   내보내면 그 순간 화면이 비어서 자기가 얼마 보내는지 못 보게 됩니다. 받을 때마다
   여기에 담아 두고, 연결이 끊기면 이것을 '끝난 판'으로 계속 보여 줍니다. */
const LAST_LIVE_KEY = "goldSettlement.lastlive";
function loadLastLive() {
  if (typeof window === "undefined") return null;
  try {
    const v = JSON.parse(window.localStorage.getItem(LAST_LIVE_KEY) || "null");
    if (v && v.room && v.full && Array.isArray(v.full.rows) && Array.isArray(v.full.cols)) return v;
  } catch (e) {}
  return null;
}
function saveLastLive(v) {
  if (typeof window === "undefined") return;
  try {
    if (!DEMO) window.localStorage.setItem(LAST_LIVE_KEY, JSON.stringify(v));
  } catch (e) {}
}

function loadPartyReg() {
  if (typeof window === "undefined") return null;
  if (DEMO) return DEMO_STORE.reg || null;
  try {
    const v = JSON.parse(window.localStorage.getItem(PARTY_REG_KEY) || "null");
    if (v && Array.isArray(v.list) && v.list.length && typeof v.active === "string") return v;
  } catch (e) {}
  return null;
}
function savePartyReg(reg) {
  if (typeof window === "undefined") return;
  try {
    if (DEMO) DEMO_STORE.reg = reg;
    else window.localStorage.setItem(PARTY_REG_KEY, JSON.stringify(reg));
  } catch (e) {}
}
function loadPartySlot(name) {
  if (typeof window === "undefined") return null;
  try {
    const v = DEMO ? DEMO_STORE["slot:" + name] || null : JSON.parse(window.localStorage.getItem(partySlotKey(name)) || "null");
    if (!v || !Array.isArray(v.rows) || !Array.isArray(v.cols)) return null;
    return { ...v, rows: migrateRows(v.rows) };
  } catch (e) {
    return null;
  }
}
function savePartySlot(name, data) {
  if (typeof window === "undefined") return;
  try {
    if (DEMO) DEMO_STORE["slot:" + name] = data;
    else window.localStorage.setItem(partySlotKey(name), JSON.stringify(data));
  } catch (e) {}
}
function dropPartySlot(name) {
  if (typeof window === "undefined") return;
  try {
    if (!DEMO) window.localStorage.removeItem(partySlotKey(name));
  } catch (e) {}
}
const DEFAULT_ROOM_LABEL = "기본"; // 옛 파티 시절의 기본 명단 이름 (저장 호환용)
/* 프리셋 — 시작 구성 템플릿(명단·항목·단가·수수료·단위) */
const PRESETS_KEY = "goldSettlement.presets";
const loadPresets = () => {
  try {
    const v = JSON.parse(window.localStorage.getItem(PRESETS_KEY) || "[]");
    return Array.isArray(v) ? v : [];
  } catch (e) {
    return [];
  }
};
const savePresets = (l) => {
  try {
    if (!DEMO) window.localStorage.setItem(PRESETS_KEY, JSON.stringify(l));
  } catch (e) {}
};

function loadRelay() {
  if (typeof window === "undefined") return { on: false };
  if (DEMO) return { on: false, look: { t: "dark", alpha: 25 } }; // 예시 앱엔 방이 없습니다
  try {
    const v = JSON.parse(window.localStorage.getItem(RELAY_KEY) || "null");
    if (!v || typeof v !== "object") throw 0;
    /* v1 의 rooms/active/rcode 는 읽어서 버립니다 — 방 열쇠 체계가 계정으로 바뀌었습니다.
       외형 취향만 그대로 이주합니다. */
    const out = {
      on: !!v.on,
      /* 내 방 — 계정당 하나. 서버가 처음 필요할 때 만들어 줍니다 */
      room: typeof v.room === "string" ? v.room : undefined,
      invite:
        v.invite && typeof v.invite.code === "string" ? { code: v.invite.code, exp: v.invite.exp } : undefined,
      /* 로비 초안 열은 없어졌습니다 — 로비가 홈이라 항목을 지금 판의 것으로 바로 고칩니다 */
      lobbyCap: v.lobbyCap >= 2 && v.lobbyCap <= 16 ? v.lobbyCap : undefined,
      /* 화면 취향들 — 여기서 안 받아 주면 새로고침마다 기본값으로 돌아갑니다 */
      ov: v.ov && typeof v.ov === "object" ? v.ov : undefined,
      fx: v.fx === "off" ? "off" : undefined,
      /* epic 이 빠져 있어서 '아주 느리게'를 골라도 새로고침하면 되돌아갔습니다 */
      spd: v.spd in SPINS ? v.spd : undefined,
      spinLook: v.spinLook === "num" || v.spinLook === "wheel" ? v.spinLook : undefined,
      spinGlide: Number.isFinite(v.spinGlide) ? Math.max(0, Math.min(100, v.spinGlide)) : undefined, // 감속 슬라이더 (2026-09-07)
      wheelTheme: v.wheelTheme === "vegas" ? "vegas" : undefined,
      ovsrc: v.ovsrc === "split" ? "split" : undefined,
      look:
        v.look && typeof v.look === "object" && typeof v.look.t === "string"
          ? { t: v.look.t, alpha: [0, 25, 50, 75, 100].includes(v.look.alpha) ? v.look.alpha : 25, line: v.look.line ? 1 : undefined }
          : { t: "dark", alpha: 25 },
      lookMig: v.lookMig ? 1 : undefined,
      lookMig2: v.lookMig2 ? 1 : undefined, // 2026-09-07 외형 기본값 강제 적용 표시
      /* 2026-09-06 모델 — 판 존재 표시, 프리셋 이름(시작 때 채움), 이어서 고른 판.
         (버그 기록) 여기서 안 받아 줘서 새로고침하면 판이 없는 걸로 돌아갔다 */
      boardOn: v.boardOn ? true : undefined,
      presetNames: Array.isArray(v.presetNames) ? v.presetNames.filter((x) => typeof x === "string") : undefined,
      resumeFrom: typeof v.resumeFrom === "string" && v.resumeFrom ? v.resumeFrom : undefined,
    };
    /* 기본을 원판으로 바꾸면서, 이미 쓰던 분들도 한 번은 원판으로 옮깁니다.
       그 뒤에 슬롯을 고르면 그대로 남습니다 — 표시를 남겨서 두 번 옮기지 않습니다. */
    if (!out.lookMig) {
      out.spinLook = undefined;
      out.lookMig = 1;
      try {
        window.localStorage.setItem(RELAY_KEY, JSON.stringify(out));
      } catch (e2) {}
    }
    /* 외형 기본값 강제 적용 (2026-09-07 사용자 확정: 다음 배포에 모든 사용자) — 슬라이드 켬 · 알림 켬 · 감속 느긋하게 · 원판 · 새틴.
       한 번만, 표시를 남깁니다. 그 뒤 고른 것은 그대로. 끈 항목(ov.off)·합계·순액은 건드리지 않습니다 */
    if (!out.lookMig2) {
      out.spinLook = undefined;
      out.wheelTheme = undefined;
      out.spinGlide = undefined;
      out.fx = undefined;
      if (out.ov) {
        const o = { ...out.ov };
        delete o.slide;
        out.ov = Object.keys(o).length ? o : undefined;
      }
      out.lookMig2 = 1;
      try {
        window.localStorage.setItem(RELAY_KEY, JSON.stringify(out));
      } catch (e2) {}
    }
    return out;
  } catch (e) {
    return { on: false, look: { t: "dark", alpha: 25 } };
  }
}
function saveRelay(v) {
  if (typeof window === "undefined") return;
  try {
    if (!DEMO) window.localStorage.setItem(RELAY_KEY, JSON.stringify(v));
  } catch (e) {
    /* 저장 불가 환경 */
  }
}

/* ---------- 예시 앱 (2026-09-06 사용자 확정: 완전한 더미) ----------
   처음부터 같이 해보기는 부모 앱이 이 앱을 #demo 로 iframe 에 한 번 더 띄워서 돕니다.
   예시 앱은 저장소를 읽지도 쓰지도 않고(화면 밝기 취향만 따름), 서버엔 한 번도 안 가고, 계정은 가짜입니다.
   iframe 은 주소를 못 가지므로(canOwnUrl) 화면 이동은 상태만 바뀝니다. 부모의 진짜 판·소켓·저장소는 그대로라
   진행 중이어도 언제든 열 수 있습니다 — (폐기 2026-09-06) 진짜 화면 위에서 장부·자리·명단을 바꿔치기했다 되돌리던 방식:
   판이 있으면 못 열었고(사용자: "판을 닫은 뒤 로비에서"는 이상하다), 진행 중엔 파티원 자수를 잃었다 */
const DEMO = (() => {
  try {
    return typeof window !== "undefined" && /(^|&)demo(=|&|$)/.test(window.location.hash.replace(/^#/, ""));
  } catch (e) {
    return false;
  }
})();
/* #demo&member — 예시의 뒷부분(2026-09-06 사용자 확정): 같은 앱을 파티원(뷰어) 모드로 한 번 더 띄워, 실리안의 자리에서
   자수 화면을 보여 줍니다. 예시 방(DEMO_ROOM)의 길을 타되 판은 방장 예시와 같은 넷이고 숫자는 움직이지 않습니다 */
const DEMO_MEMBER = DEMO && /(^|&)member(=|&|$)/.test(window.location.hash.replace(/^#/, ""));
/* 방장 튜토리얼의 8장(파티원 화면)으로 뜬 파티원 예시 앱 — 띠에 장 점을 그립니다. 없으면 독립 파티원 튜토리얼 */
/* 방장 튜토리얼 4장(파티원 화면)으로 뜬 파티원 예시 — 초대장부터 시작해 자수·정정까지만 보고 방장 예시로 돌아갑니다 (2026-09-06 낮 사용자 확정 "1안"; (폐기) ch8 = 맨 끝 8장) */
const DEMO_CH4 = DEMO_MEMBER && /(^|&)ch4(=|&|$)/.test(window.location.hash.replace(/^#/, ""));
/* 예시 앱의 판 기록·장부 슬롯 — 저장소 대신 메모리 (7장 끝내기가 결과지·판 기록을 여기서 읽습니다) */
const DEMO_STORE = {};
/* 진짜 계정의 닉 — 예시 판의 방장 이름에 씁니다(없으면 `방장`) */
const realNick = () => {
  try {
    const v = JSON.parse(window.localStorage.getItem("goldSettlement.auth") || "null");
    return (v && v.nick) || "";
  } catch (e) {
    return "";
  }
};

/* ---------- 계정 ----------
   사람의 신원은 계정입니다. URL 은 읽기까지만 나르고, 쓰기는 전부 이 세션 토큰입니다. */
const AUTH_KEY = "goldSettlement.auth";
function loadAuth() {
  if (typeof window === "undefined") return null;
  try {
    const v = JSON.parse(window.localStorage.getItem(AUTH_KEY) || "null");
    /* 예시 앱의 방장은 가짜 계정 — 닉만 진짜 계정 것을 빌립니다(없으면 `나`) */
    /* 주소(obsToken)는 없이 시작합니다 — 튜토리얼이 [내 방송용 주소 받기]를 누르게 하고 예시에서 바로 발급합니다 */
    if (DEMO_MEMBER) return { id: "silian", nick: "실리안", anon: false, token: "demo" };
    if (DEMO) return { id: "demo:me", nick: (v && v.nick) || "나", anon: !!(v && v.anon), token: "demo" };
    if (v && typeof v.id === "string" && typeof v.token === "string") return v;
  } catch (e) {}
  return null;
}
function saveAuth(v) {
  if (typeof window === "undefined") return;
  try {
    if (DEMO) return;
    if (v) window.localStorage.setItem(AUTH_KEY, JSON.stringify(v));
    else window.localStorage.removeItem(AUTH_KEY);
  } catch (e) {}
}

/* 비밀번호 원문은 서버에 도착하지 않습니다 — 브라우저가 먼저 갈아 둡니다.
   솔트에 id 를 섞어서, 같은 비밀번호를 쓴 두 계정의 선해시가 겹치지 않게 합니다. */
const PW_SALT = "gold-settlement/v1|";
const PW_ITER = 310000;
const hasSubtle = () =>
  typeof crypto !== "undefined" && !!crypto.subtle && typeof crypto.subtle.deriveBits === "function";
const SUBTLE_MSG =
  "이 주소에서는 로그인을 쓸 수 없어요 — 브라우저가 안전한 연결(https)에서만 비밀번호를 처리해요.";
async function preHash(id, pw) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(pw), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: enc.encode(PW_SALT + String(id || "").toLowerCase()),
      iterations: PW_ITER,
      hash: "SHA-256",
    },
    key,
    256
  );
  return [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/* 서버 응답 규칙 하나로 모읍니다 — 화면에 그대로 띄울 한국어 메시지를 붙여서 던집니다 */
const NET_MSG = "서버에 닿지 못했어요. 인터넷을 확인하고 다시 시도해 주세요.";
async function callApi(path, { method = "GET", body, token } = {}) {
  if (DEMO) return {}; // 예시 앱은 서버에 안 갑니다 — 빈 응답이면 부르는 쪽이 전부 조용히 지나갑니다
  const headers = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (token) headers.authorization = "Bearer " + token;
  let res;
  try {
    res = await fetch(RELAY_BASE + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (e) {
    const err = new Error(NET_MSG);
    err.offline = true;
    throw err;
  }
  let data = null;
  try {
    data = await res.json();
  } catch (e) {}
  if (!res.ok) {
    const err = new Error((data && data.msg) || apiMsg(res.status, data && data.error));
    err.status = res.status;
    err.code = data && data.error;
    throw err;
  }
  return data || {};
}
const apiMsg = (status, code) => {
  if (code === "scribe-off") return "방장이 자리를 비웠어요 — 돌아오면 다시 누를 수 있어요.";
  if (code === "paused") return "잠깐 멈췄어요 — 방장이 이어가면 다시 움직여요.";
  if (status === 401) return "아이디나 비밀번호가 맞지 않아요.";
  if (status === 403) return "권한이 없어요. 초대를 다시 받아 주세요.";
  if (status === 404) return "찾을 수 없어요 — 시간이 지났거나 새로 발급됐을 수 있어요.";
  if (status === 409) return "이미 있어요.";
  if (status === 429) return "잠시 뒤에 다시 시도해 주세요.";
  if (status === 400) return "입력한 내용을 다시 확인해 주세요.";
  return "실패했어요. 잠시 뒤에 다시 시도해 주세요.";
};

const authApi = {
  register: async (id, pw, nick) =>
    callApi("/api/auth/register", { method: "POST", body: { id, pw: await preHash(id, pw), nick } }),
  login: async (id, pw) =>
    callApi("/api/auth/login", { method: "POST", body: { id, pw: await preHash(id, pw) } }),
  logout: (token) => callApi("/api/auth/logout", { method: "POST", body: { token } }),
  me: (token) => callApi("/api/auth/me", { token }),
  nick: (token, nick) => callApi("/api/auth/nick", { method: "POST", body: { nick }, token }),
  obsReissue: (token) => callApi("/api/auth/obs-reissue", { method: "POST", body: {}, token }),
  /* 가입 없이 주소 받기 — 서버가 무작위 아이디·비밀번호로 계정 하나를 만들어 줍니다.
     비밀번호는 서버에서 만들고 알려 주지 않습니다. 정식 계정이 되는 길은 upgrade 하나입니다 */
  /* [게스트로 시작] — 닉 하나로 계정을 만듭니다. 아이디·비밀번호가 없을 뿐 가입과 같은
     계정이라 방송용 주소도 파티 참여도 그대로 됩니다 (§3.11) */
  anon: (nick) => callApi("/api/auth/anon", { method: "POST", body: nick ? { nick } : {} }),
  /* 익명 계정에 아이디·비밀번호·닉네임을 붙입니다. 같은 계정에 덧씌우는 것이라
     세션·방송용 주소·방·멤버십이 전부 그대로입니다 — 다시 로그인하지 않습니다 */
  upgrade: async (token, id, pw, nick) =>
    callApi("/api/auth/upgrade", {
      method: "POST",
      body: { id, pw: await preHash(id, pw), nick },
      token,
    }),
  /* 오버레이 외형은 계정마다 따로입니다 — 저장해 두면 OBS 주소를 안 고쳐도 다음 접속부터 반영됩니다 */
  look: (token, look) => callApi("/api/auth/look", { method: "POST", body: { look }, token }),
  /* 내 방송용 주소가 지금 어느 방을 비추는지 — OBS 조회도 활동으로 칩니다 */
  resolveObs: (t) => callApi("/api/o/" + encodeURIComponent(t) + "/resolve"),
  /* 지목 초대 — 함께한 사람에게만 갑니다. 자리는 보내는 쪽이 그때 정합니다 (§3.3).
     유효 1분짜리 실시간 악수라, 만료를 알리는 배관은 없습니다 */
  invite: (token, to, seat) =>
    callApi("/api/invite", { method: "POST", body: seat ? { to, seat } : { to }, token }),
};

const roomApi = {
  /* 계정당 방 하나 — 처음 필요할 때 서버가 만들어 줍니다 */
  myRoom: (token) => callApi("/api/my/room", { method: "POST", body: {}, token }),
  putState: (token, roomId, state, bindings) =>
    callApi(`/api/r/${roomId}/state`, {
      method: "PUT",
      body: bindings ? { state, bindings } : { state },
      token,
    }),
  read: (token, roomId) => callApi(`/api/r/${roomId}/read`, { token }),
  /* 서버는 {invite:{code,exp}} 로 감싸서 줍니다 — 호출한 쪽이 알맹이만 보게 풀어 둡니다 */
  invite: (token, roomId) =>
    callApi(`/api/r/${roomId}/invite`, { method: "POST", body: {}, token }).then(
      (r) => r.invite || r
    ),
  /* 지금 코드 (2026-09-06) — 살아 있으면 그대로, 죽었으면 null. 부팅과 새 판 만들기가 씁니다 */
  inviteNow: (token, roomId) => callApi(`/api/r/${roomId}/invite`, { token }).then((r) => r.invite || null),
  /* 정산 끝내기·해산 — 판이 없어집니다 (2026-09-06 모델) */
  end: (token, roomId) => callApi(`/api/r/${roomId}/end`, { method: "POST", body: {}, token }),
  lobby: (token, roomId, open, cap) =>
    callApi(`/api/r/${roomId}/lobby`, {
      method: "POST",
      body: cap != null ? { open, cap } : { open },
      token,
    }),
  members: (token, roomId) => callApi(`/api/r/${roomId}/members`, { token }),
  /* rowId 를 같이 보내면 그 자리에 앉힙니다 — [수락 ▾] 의 자리 지정이 이 길입니다 (§3.2) */
  member: (token, roomId, acct, action, rowId) =>
    callApi(`/api/r/${roomId}/member`, {
      method: "POST",
      body: rowId ? { acct, action, rowId } : { acct, action },
      token,
    }),
  /* 들어가는 길 셋 (§3.3) — 링크 코드, 지목 초대(inv), 코드 없는 노크.
     본문이 갈래를 정합니다: 코드가 있으면 신청, inv 면 즉시 입장, 빈 본문이면 노크 */
  join: (token, roomId, j) =>
    callApi(`/api/r/${roomId}/join`, { method: "POST", body: { j }, token }),
  joinInvited: (token, roomId) =>
    callApi(`/api/r/${roomId}/join`, { method: "POST", body: { inv: 1 }, token }),
  knock: (token, roomId) =>
    callApi(`/api/r/${roomId}/join`, { method: "POST", body: {}, token }),
  leave: (token, roomId) => callApi(`/api/r/${roomId}/leave`, { method: "POST", body: {}, token }),
  /* [중단]·[이어가기] — 아무것도 지우지 않고 얼렸다 풉니다 (§3.4) */
  pause: (token, roomId) => callApi(`/api/r/${roomId}/pause`, { method: "POST", body: {}, token }),
  resume: (token, roomId) => callApi(`/api/r/${roomId}/resume`, { method: "POST", body: {}, token }),
  confess: (token, roomId, rowId, colId, dir) =>
    callApi(`/api/r/${roomId}/confess`, { method: "POST", body: { rowId, colId, dir }, token }),
  /* 판 도중 합류자의 자리 고르기 (§3.2) — 본인이 고르고, 한 번 고르면 서버가 잠급니다.
     바꾸는 길은 방장의 [자리 바꾸기]뿐입니다 */
  seat: (token, roomId, rowId) =>
    callApi(`/api/r/${roomId}/seat`, { method: "POST", body: { rowId }, token }),
  /* 초대 링크는 방 주소 + 해시의 코드입니다 — 방 주소는 비밀이 아니고, 코드가 권한입니다 */
  inviteUrl: (roomId, code) => `${RELAY_BASE}/r/${roomId}#${JOIN_KEY}=${code}`,
  /* 내 방송용 주소 — 지금 들어가 있는 방을 비춥니다. 읽기 전용, 영구(재발급 전까지) */
  obsUrl: (obsToken) => `${RELAY_BASE}/o/${obsToken}`,
  roomUrl: (roomId) => `${RELAY_BASE}/r/${roomId}`,
  /* 코드 8자만으로 방을 찾습니다 (§4 보충 — 초대 코드 색인). 로비의 초대 입력칸이 씁니다 */
  resolveJoin: (code) => callApi(`/api/j/${code}/resolve`),
};
const WS_BASE = RELAY_BASE.replace(/^http/, "ws");

/* 뷰어로 들어왔는지 — #live=ROOMID (&j=CODE) */
function readLiveRoom() {
  const v = hashParams().get(LIVE_KEY) || "";
  return /^[ABCDEFGHJKMNPQRSTVWXYZ23456789]{4,16}$/.test(v) ? v : null;
}
function readJoinCode() {
  const v = (hashParams().get(JOIN_KEY) || "").toUpperCase();
  return /^[ABCDEFGHJKMNPQRSTVWXYZ23456789]{8}$/.test(v) ? v : null;
}
/* #o=TOKEN — 방을 모른 채 들어옵니다. 앱이 resolve 로 찾아서 뷰어를 엽니다 */
function readObsToken() {
  const v = hashParams().get(OBS_KEY) || "";
  return /^[A-Za-z0-9]{12,40}$/.test(v) ? v : null;
}
/* ---------- 화면 = 주소 (2026-09-05, 뒤로가기 표준화) ----------
   #lobby 로비 / #board 내 벌금판 / #gen=이름 판 기록 / #live=… 파티 판(부트가 읽음).
   화면을 바꾸는 문은 전부 go() 를 거쳐 history 에 한 장 얹고, hashchange 하나가 화면을 정합니다.
   주소가 비어 있을 때만 도착 규칙을 돌리고 결과를 replaceState 로 적습니다 — 새로고침이 화면을 지킵니다.
   모달·탭·확인창은 history 밖입니다(데스크톱 앱 — Esc 와 ×가 닫습니다) */
const VIEW_LOBBY = "lobby";
const VIEW_BOARD = "board";
const GEN_KEY = "gen";
function readRoute() {
  const p = hashParams();
  if (p.get(GEN_KEY)) return { view: "gen", gen: p.get(GEN_KEY) };
  if (p.has(VIEW_LOBBY)) return { view: VIEW_LOBBY, gen: null };
  if (p.has(VIEW_BOARD)) return { view: VIEW_BOARD, gen: null };
  return { view: null, gen: null };
}
/* 라우트 열쇠와 파티 열쇠(live·j·o)를 걷고 새 라우트를 적은 해시 — 나머지(#m= 등)는 그대로 */
/* URLSearchParams 는 값 없는 열쇠를 `lobby=` 로 적습니다 — 해시를 다시 쓰는 곳은 전부 이걸로 */
function hashText(p) {
  return p.toString().replace(/(^|&)(lobby|board)=(?=&|$)/g, "$1$2");
}
function routeHash(view, gen) {
  const p = hashParams();
  [VIEW_LOBBY, VIEW_BOARD, GEN_KEY, LIVE_KEY, JOIN_KEY, OBS_KEY].forEach((k) => p.delete(k));
  if (view === "gen") p.set(GEN_KEY, gen || "");
  else if (view === VIEW_LOBBY) p.set(VIEW_LOBBY, "");
  else if (view === VIEW_BOARD) p.set(VIEW_BOARD, "");
  return hashText(p);
}
/* 가림 — 비밀만 가립니다. ● 스물다섯 개는 아무 정보도 주지 않아서, 사람이 자기가 무엇을
   보고 있는지(주소가 맞는지, 어느 릴레이인지) 확인할 방법이 없었습니다.
   도메인과 경로는 남기고 토큰·초대 코드만 지웁니다 — 방송 화면에 새서 곤란한 것은 그 둘뿐입니다. */
const BULLET = "•".repeat(8);
const maskUrl = (u) => {
  const s = String(u || "");
  if (!s) return "";
  const bare = s.replace(/^https?:\/\//, "");
  // 초대 링크: .../r/ROOMID#j=CODE — 방 주소는 비밀이 아니고 코드가 권한입니다 (§1)
  const inv = bare.match(/^(.*#[a-z]+=)/);
  if (inv) return inv[1] + BULLET;
  // 방송용 주소: .../o/TOKEN — 마지막 조각만 가립니다
  const i = bare.lastIndexOf("/");
  return i < 0 ? BULLET : bare.slice(0, i + 1) + BULLET;
};

/* 디코용 복사 — 마스크드 링크 한 줄. 주소가 글자로 노출되지 않게 감싸 둡니다 */
const inviteMsg = (hostNick, url) =>
  `[🔔 ${hostNick}네 벌금 현황판 — 눌러서 참여](<${url}>)\n방송에 띄우려면 로그인해서 내 방송 주소를 OBS에 한 번만 넣어요.`; // 둘째 줄: 파티원이 링크를 열기 전에 봅니다 (2026-09-06 오후 사용자 확정)

/* 주소창이 우리 것인지. 아티팩트처럼 iframe 에 갇혀 있으면 바깥 주소를 만질 수 없어서
   URL 공유 대신 '공유 코드' 로 동작을 바꿉니다. */
const canOwnUrl = (() => {
  if (typeof window === "undefined") return false;
  try {
    if (window.self !== window.top) return false;
    window.history.replaceState(window.history.state, "", window.location.href);
    return true;
  } catch (e) {
    return false;
  }
})();

function hashParams() {
  if (typeof window === "undefined") return new URLSearchParams();
  return new URLSearchParams(window.location.hash.replace(/^#/, ""));
}

/* ---------- 금액만 모드의 읽히는 링크 ----------
   금액만 표는 이름+금액뿐이라 base64 로 접을 이유가 없습니다.
   #m=simple&d=도읍지25-리니링22-… 처럼 채팅 줄과 같은 꼴로 싣습니다.
   닉에 숫자가 섞여도('망치2호') 엔트리 사이 '-' 가 경계를 잡아 줍니다.
   단위(u)와 수수료(f)는 기본값(만G·5%)과 다를 때만 붙입니다. */
const DATA_KEY = "d";
const UNIT_LABEL = { 100000: "십만", 10000: "만", 1: "1" };
const LABEL_UNIT = { 십만: "100000", 만: "10000", 1: "1" };

/* 이름이 링크 문법과 부딪히면(공백·하이픈·언더스코어·URL 기호) base64 쪽으로 물러납니다.
   숫자로 끝나는 닉은 금액과 사이에 '_' 를 끼워서 처리합니다 (인기3_24). */
const simpleLinkable = (rows) =>
  rows.length > 0 && rows.every((x) => !/[\s\-_,&=#%?+/]/.test(x.name));

function encodeSimpleHash(rows, feePercent, unit) {
  const d = rows
    .map((x) => {
      const amt = tidy(x.counts?.[SIMPLE_ID]);
      const sep = /\d$/.test(x.name) ? "_" : ""; // 이름 끝 숫자와 금액의 경계
      return x.name + sep + amt;
    })
    .join("-");
  let h = `${MODE_KEY}=simple&${DATA_KEY}=${d}`;
  if (unit !== "10000") h += `&u=${UNIT_LABEL[unit] || "만"}`;
  if ((tidy(feePercent) || "5") !== "5") h += `&f=${tidy(feePercent)}`;
  return h;
}

function decodeSimpleShared(p) {
  const d = p.get(DATA_KEY);
  if (!d) return null;
  const rows = d
    .split("-")
    .filter(Boolean)
    .map((seg, i) => {
      // '_' 가 있으면 그게 이름/금액 경계입니다 (인기3_24). 없으면 끝 숫자 덩어리가 금액.
      const us = seg.lastIndexOf("_");
      const m =
        us !== -1
          ? { name: seg.slice(0, us), amount: formatNumInput(seg.slice(us + 1)) }
          : parseMemoLine(seg) || { name: seg, amount: "" };
      return {
        id: "r" + (i + 1),
        name: m.name,
        counts: m.amount ? { [SIMPLE_ID]: m.amount } : {},
        extras: [],
      };
    });
  if (rows.length === 0) return null;
  return {
    cols: DEFAULT_COLS,
    rows,
    feePercent: tidy(p.get("f") || "") || "5",
    mode: "simple",
    unit: LABEL_UNIT[p.get("u") || "만"] || "10000",
  };
}

function readShared() {
  const p = hashParams();
  const readable = decodeSimpleShared(p);
  if (readable) return readable;
  const token = p.get(SHARE_KEY);
  return token ? decodeState(token) : null;
}

// 주소에 적힌 모드. 공유 토큰이 없을 때 이걸로 시작합니다.
function readHashMode() {
  const m = hashParams().get(MODE_KEY);
  return m === "simple" || m === "items" ? m : null;
}

/* 두 모드가 각자의 주소를 갖도록 해시에 모드를 적어 둡니다.
   #m=simple / #m=items, 공유 토큰(s)이 있으면 그대로 유지합니다. */
function syncHashMode(mode) {
  if (!canOwnUrl) return;
  const p = hashParams();
  if (p.get(MODE_KEY) === mode) return;
  p.set(MODE_KEY, mode);
  const { pathname, search } = window.location;
  window.history.replaceState(null, "", `${pathname}${search}#${hashText(p)}`);
}

/* ---------- 새로고침해도 남도록 브라우저에 저장 ---------- */
const STORE_KEY = "goldSettlement.v1";
/* 이 브라우저가 앱을 연 적이 있는지 — 첫 실행 게이트를 다시 띄우지 않으려는 표시 하나입니다.
   뷰어는 남의 장부를 비추는 중이라 이 브라우저에 저장하지 않는데(§5.1), 저장본이 없다고
   처음 온 사람인 것은 아닙니다. 끝난 파티에서 [닫기]로 자기 앱에 돌아오는 길이 그 자리입니다 */
const SEEN_KEY = "goldSettlement.seen";
const markSeen = () => {
  try {
    if (!DEMO) window.localStorage.setItem(SEEN_KEY, "1");
  } catch (e) {
    /* 저장이 막힌 환경이면 표시만 못 남깁니다 */
  }
};
const wasSeen = () => {
  try {
    return window.localStorage.getItem(SEEN_KEY) === "1";
  } catch (e) {
    return false;
  }
};
/* 파티 카드에 적는 합계 — 정산과 같은 식으로 슬롯에서 바로 뽑습니다 */
/* 지난 판 라벨 — 기록 시간 범위로 부릅니다. 같은 날이면 날짜를 한 번만 적습니다 */
const fmtSpan = (from, to) => {
  const f = new Date(from);
  const t = new Date(to);
  const d = (x) => x.getMonth() + 1 + "/" + x.getDate();
  const hm = (x) =>
    String(x.getHours()).padStart(2, "0") + ":" + String(x.getMinutes()).padStart(2, "0");
  return d(f) + " " + hm(f) + " ~ " + (d(f) === d(t) ? "" : d(t) + " ") + hm(t);
};
/* 판 기록의 날짜 — 목록은 짧게(9/3 밤), 신분증 띠는 길게(9월 3일 22:10 ~ 4일 01:40).
   날짜보다 시간대가 기억에 남아서 목록에는 시간대 말을 붙입니다 */
const AT_WORD = (h) => (h < 6 ? "새벽" : h < 11 ? "아침" : h < 17 ? "낮" : h < 21 ? "저녁" : "밤");
const fmtWhenShort = (from) => {
  if (!from) return "";
  const f = new Date(from);
  return f.getMonth() + 1 + "/" + f.getDate() + " " + AT_WORD(f.getHours());
};
const fmtWhenLong = (from, to) => {
  if (!from) return "";
  const f = new Date(from);
  const t = new Date(to || from);
  const hm = (x) =>
    String(x.getHours()).padStart(2, "0") + ":" + String(x.getMinutes()).padStart(2, "0");
  const head = f.getMonth() + 1 + "월 " + f.getDate() + "일 " + hm(f);
  if (f.getMonth() === t.getMonth() && f.getDate() === t.getDate()) return head + " ~ " + hm(t);
  if (f.getMonth() === t.getMonth()) return head + " ~ " + t.getDate() + "일 " + hm(t);
  return head + " ~ " + (t.getMonth() + 1) + "월 " + t.getDate() + "일 " + hm(t);
};
/* 이주 판정 — 기록·벌금·직접 적은 이름 중 하나라도 있으면 남깁니다 */
const slotWorthKeeping = (slot) =>
  !!slot &&
  ((Array.isArray(slot.log) && slot.log.length > 0) ||
    slotGold(slot) > 0 ||
    (Array.isArray(slot.rows) && slot.rows.some((r) => r.name && !isFillName(r.name))));

function slotGold(slot) {
  if (!slot) return 0;
  const simple = slot.mode === "simple";
  const cols = simple ? [{ id: SIMPLE_ID, price: slot.unit || "10000" }] : slot.cols;
  const price = {};
  cols.forEach((c) => {
    price[c.id] = Math.round(goldOf(c.price));
  });
  return slot.rows.reduce(
    (a, r) =>
      a +
      Math.max(
        0,
        cols.reduce((x, c) => x + cellGold(r, c.id, price[c.id]), 0) + (simple ? 0 : extraSum(r))
      ),
    0
  );
}

/* 예시 표·기록이 든 파티 이름 — 로비와 파티 메뉴에서 만들 수 있습니다 */
const EXAMPLE_PARTY = "현자들";
/* 방금 누른 것 — 묶음 전체에 시계가 하나입니다. 누를 때마다 처음으로 돌아가고,
   손을 떼고 이만큼 조용하면 카드가 통째로 사라집니다. 한 번 기록하는 묶음(전멸 한 번)은
   몇 초 간격으로 이어지고 다음 묶음까지는 몇 분이라, 그 사이 어디쯤이면 됩니다. */
const BURST_MS = 60 * 1000;
/* 8인 파티가 전멸하면 여덟 줄입니다 — 그게 확인하고 싶은 묶음이라 그보다 적게 자르면 안 됩니다 */
const BURST_MAX = 8;
/* 파티원이 다른 탭에서 이만큼 아무 조작도 안 하면 자수 화면으로 돌아옵니다 */
const IDLE_BACK_MS = 30 * 1000;
/* 자수로 바뀐 칸이 번쩍이고 말풍선이 떠 있는 시간 */
const CONFESS_FX_MS = 2000;
/* 자수 되돌리기 창 — 서버의 CONFESS_UNDO_MS 와 같은 숫자 (§3.6). 카드의 되돌리기 칩이 이 창을 셉니다 (2026-09-07) */
const CONFESS_UNDO_MS = 30 * 1000;

function loadSaved() {
  if (typeof window === "undefined") return null;
  try {
    const s = JSON.parse(window.localStorage.getItem(STORE_KEY) || "null");
    if (!s || !Array.isArray(s.cols) || !Array.isArray(s.rows)) return null;
    return {
      cols: s.cols,
      rows: migrateRows(
        s.rows.map((x) => ({ ...x, counts: x.counts || {}, sums: x.sums || {}, extras: x.extras || [] }))
      ),
      feePercent: typeof s.feePercent === "string" ? s.feePercent : "5",
      splitMode: s.splitMode === "solo" ? "solo" : "pot",
      mode: s.mode === "simple" ? "simple" : "items",
      unit: UNITS.some((u) => u.v === s.unit) ? s.unit : "10000",
      memoFont: clampMemoFont(s.memoFont),
      view: s.view === "scroll" ? "scroll" : "tabs",
      tab: s.tab === "ledger" || s.tab === "mail" ? s.tab : "sheet",
      log: Array.isArray(s.log) ? s.log.slice(-LOG_CAP) : [],
      undoSnap:
        s.undoSnap && Array.isArray(s.undoSnap.cols) && Array.isArray(s.undoSnap.rows)
          ? s.undoSnap
          : null,
      memoFreeze:
        s.memoFreeze && Array.isArray(s.memoFreeze.people) ? s.memoFreeze : null,
      theme: s.theme === "light" || s.theme === "dark" ? s.theme : "system",
      /* 판이 살아 있는지 (§3.1). 이 값이 적혀 있지 않은 저장본은 개편 전의 것이라
         진행 중인 판으로 승격합니다 — 세던 판이 로비로 강등되는 일은 없어야 합니다 */
      roundLive: s.roundLive !== false,
      roundId: typeof s.roundId === "string" ? s.roundId : "",
      /* 판 이름 — 리로드해도 그 판의 이름이 그대로여야 정산 끝내기 때 제 이름으로 남습니다 */
      roundName: typeof s.roundName === "string" ? s.roundName : "",
      roundPaused: !!s.roundPaused,
      seats: Array.isArray(s.seats) ? s.seats.map(seatIn).filter(Boolean) : null,
    };
  } catch (e) {
    return null;
  }
}

/* 자리 = { 이름, 붙은 계정(빈 값 가능), 기억된 아이디 } (§3.2).
   자리 id 가 곧 판의 줄 id 입니다 — 연결이 판의 행이 아니라 자리에 살아서,
   판이 갈려도(줄 내용만 새로 만들어도) 연결이 안 끊어집니다.
   named 는 방장이 이름을 손댔는지입니다 — 손댄 이름은 파티원 닉 변경이 못 건드립니다 */
const seatIn = (s) => {
  if (!s || typeof s.id !== "string" || !s.id) return null;
  return {
    id: s.id,
    name: typeof s.name === "string" ? s.name : "",
    acct: typeof s.acct === "string" && s.acct ? s.acct : null,
    mem: typeof s.mem === "string" && s.mem ? s.mem : null,
    named: !!s.named,
    /* 진행 중에 나간 줄의 표시와 출처 (2026-09-06) — (버그 기록) 여기서 버려져 새로고침하면 퇴장 태그가 사라지고,
       돌아온 사람이 자기 줄을 못 찾았다 */
    left: !!s.left,
    who: typeof s.who === "string" && s.who ? s.who : null,
    /* 앉을 때의 계정 닉 (2026-09-06) — 명단이 오기 전과 방장 자기 줄(명단에 없음)에서 호버가 줄 이름 대신 이걸 씁니다 */
    nick: typeof s.nick === "string" ? s.nick : "",
  };
};
/* 개편 전 저장본에는 자리가 없습니다 — 지금 줄에서 그대로 뜹니다.
   방장이 손으로 적어 둔 이름들이라 named 로 둡니다(닉 변경이 덮지 않게) */
const seatsFromRows = (rws) =>
  (rws || []).map((x) => ({ id: x.id, name: x.name || "", acct: null, mem: null, named: true }));

/* 메모장 글자 크기. 기본은 오른쪽 표의 이름 글자와 같은 27px.
   방송 화면에서 확대 없이 읽히려면 25px 이상이 필요해서 상한을 40까지 엽니다. */
const MEMO_FONT_DEFAULT = 27;
const clampMemoFont = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(40, Math.max(12, Math.round(n))) : MEMO_FONT_DEFAULT;
};

function saveState(state) {
  if (typeof window === "undefined") return;
  try {
    if (!DEMO) window.localStorage.setItem(STORE_KEY, JSON.stringify(state));
  } catch (e) {
    /* 용량 초과·차단된 환경이면 저장만 건너뜁니다 */
  }
}

/* 불러온 id 와 새로 만들 id 가 겹치지 않도록 카운터를 뒤로 밀어 둡니다.
   자리도 같이 셉니다 — 자리 id 가 곧 판의 줄 id 라, 빼놓으면 새로 만든 자리가
   이미 있는 줄과 같은 id 를 받아 React key 가 충돌합니다 */
function nextSeq(data) {
  let m = 100;
  const scan = (id) => {
    const n = parseInt(String(id ?? "").replace(/^\D+/, ""), 10);
    if (Number.isFinite(n)) m = Math.max(m, n + 1);
  };
  (data.cols || []).forEach((c) => scan(c.id));
  (data.seats || []).forEach((s) => scan(s.id));
  (data.rows || []).forEach((x) => {
    scan(x.id);
    (x.extras || []).forEach((e) => scan(e.id));
  });
  // 기록 줄과 동결분의 기타 id 도 겹치면 안 됩니다 — 되감기·취소가 id 로 줄을 집기 때문
  (data.log || []).forEach((l) => scan(l.id));
  (((data.memoFreeze || {}).people) || []).forEach((p) =>
    (p.extras || []).forEach((e) => scan(e.id))
  );
  return m;
}

// 공유 데이터만 떼어냅니다. 모드(#m=)는 주소에 남겨 둡니다.
function clearHash() {
  if (!canOwnUrl || !window.location.hash) return;
  const p = hashParams();
  if (!p.has(SHARE_KEY) && !p.has(DATA_KEY)) return;
  [SHARE_KEY, DATA_KEY, "u", "f"].forEach((k) => p.delete(k));
  const { pathname, search } = window.location;
  const rest = hashText(p);
  window.history.replaceState(null, "", pathname + search + (rest ? "#" + rest : ""));
}

/* 붙여넣은 글에서 공유 링크·코드를 알아봅니다.
   전체 URL 이든 '#m=…&d=…' 코드만이든, d= 또는 s= 가 있으면 그 데이터를 돌려줍니다. */
function importShareText(text) {
  if (!/(^|[#&\s])[ds]=[^\s&]/.test(text)) return null;
  try {
    const frag = text.slice(text.lastIndexOf("#") + 1).trim();
    const p = new URLSearchParams(frag);
    const readable = decodeSimpleShared(p);
    if (readable) return readable;
    const token = p.get(SHARE_KEY);
    return token ? decodeState(token) : null;
  } catch (e) {
    return null;
  }
}

/* ---------- 3) 합이 0인 부분집합으로 최대 분할 (k ≤ 15) ---------- */
function maxZeroGroups(vals) {
  const k = vals.length;
  const size = 1 << k;
  const sum = new Float64Array(size);
  for (let m = 1; m < size; m++) {
    const low = m & -m;
    sum[m] = sum[m ^ low] + vals[lowIdx(low)];
  }
  const best = new Int32Array(size).fill(-1);
  const choice = new Int32Array(size);
  best[0] = 0;
  for (let m = 1; m < size; m++) {
    if (sum[m] !== 0) continue;
    const low = m & -m;
    const rest = m ^ low;
    let b = -1;
    let ch = low;
    for (let sub = rest; ; sub = (sub - 1) & rest) {
      const part = sub | low;
      if (sum[part] === 0) {
        const r = best[m ^ part];
        if (r >= 0 && r + 1 > b) {
          b = r + 1;
          ch = part;
        }
      }
      if (sub === 0) break;
    }
    best[m] = b;
    choice[m] = ch;
  }
  const out = [];
  let m = size - 1;
  while (m) {
    const p = choice[m];
    out.push(p);
    m ^= p;
  }
  return out;
}

/* ---------- 4) 그룹 내부 송금: 큰 채무자 → 큰 채권자 ---------- */
function greedyTransfers(members) {
  const debtors = members
    .filter((m) => m.net < 0)
    .map((m) => ({ i: m.i, amt: -m.net }))
    .sort((a, b) => b.amt - a.amt);
  const creditors = members
    .filter((m) => m.net > 0)
    .map((m) => ({ i: m.i, amt: m.net }))
    .sort((a, b) => b.amt - a.amt);

  const out = [];
  let d = 0;
  let c = 0;
  while (d < debtors.length && c < creditors.length) {
    const t = Math.min(debtors[d].amt, creditors[c].amt);
    if (t > 0) out.push({ from: debtors[d].i, to: creditors[c].i, amount: t });
    debtors[d].amt -= t;
    creditors[c].amt -= t;
    if (debtors[d].amt === 0) d++;
    if (creditors[c].amt === 0) c++;
  }
  return out;
}

/* ---------- 1)~4) 전체 ---------- */
/* 실수 몫을 정수 G로 떨어뜨리되 합이 정확히 target 이 되게 (최대잉여법).
   남는 1G 는 소수부가 큰 사람부터, 같으면 표 앞순서부터 갑니다. */
function allocate(raw, target) {
  const out = raw.map(Math.floor);
  let left = target - out.reduce((a, b) => a + b, 0);
  const order = raw
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let k = 0; left > 0 && order.length; k++, left--) out[order[k % order.length].i] += 1;
  return out;
}

/* method: "pot" = 전부 통에 넣고 전원 균등 / "solo" = 자기 벌금은 자기만 빼고 나눔 */
function computeSettlement(rows, cols, feePercent, withExtras = true, method = "pot") {
  const n = rows.length;
  if (n === 0) return null;

  const fee = Math.min(Math.max(num(feePercent), 0), 99) / 100;
  const priceGold = {};
  cols.forEach((c) => {
    priceGold[c.id] = Math.round(goldOf(c.price));
  });

  // 1) 사람별 총 벌금 (G)
  const fines = rows.map((r) =>
    Math.max(
      0,
      cols.reduce((a, c) => a + cellGold(r, c.id, priceGold[c.id]), 0) +
        (withExtras ? extraSum(r) : 0)
    )
  );
  const total = fines.reduce((a, b) => a + b, 0);

  /* 2) 받을 몫. 벌금통: 총액/n 전원 동일. 본인 제외: 남들 벌금만 (n−1)등분해 받음.
     어느 쪽이든 몫의 합이 총액과 정확히 같아야 순액 합이 0이 됩니다. */
  const shares = allocate(
    method === "solo" && n > 1
      ? fines.map((f) => (total - f) / (n - 1))
      : fines.map(() => total / n),
    total
  );
  // 순액 = 받을 몫 − 자기 벌금.  (+) 받는다 / (−) 보낸다.
  const nets = fines.map((v, i) => shares[i] - v);

  const active = [];
  for (let i = 0; i < n; i++) if (nets[i] !== 0) active.push(i);

  // 3) 상쇄 그룹 분할
  const exact = active.length <= 15;
  let groupLists = [];
  if (active.length > 0 && exact) {
    groupLists = maxZeroGroups(active.map((i) => nets[i])).map((mask) => {
      const arr = [];
      let m = mask;
      while (m) {
        const low = m & -m;
        arr.push(active[lowIdx(low)]);
        m ^= low;
      }
      return arr;
    });
  } else if (active.length > 0) {
    groupLists = [active.slice()];
  }

  // 4) 송금 생성
  const transfers = [];
  groupLists.forEach((list, g) => {
    greedyTransfers(list.map((i) => ({ i, net: nets[i] }))).forEach((t) => {
      const received = Math.floor(t.amount * (1 - fee));
      transfers.push({ ...t, group: g, received, fee: t.amount - received });
    });
  });
  transfers.sort((a, b) => b.amount - a.amount);

  const gotten = new Array(n).fill(0);
  transfers.forEach((t) => {
    gotten[t.to] += t.received;
  });

  const colTotals = {};
  cols.forEach((c) => {
    colTotals[c.id] = rows.reduce((a, r) => a + cellGold(r, c.id, priceGold[c.id]), 0);
  });
  const discTotal = rows.reduce((a, r) => a + extraSum(r), 0);

  /* 비교용: 총무 한 명이 다 모았다가 다시 나눠주는 방식을 그대로 흉내 냅니다.
     1단계 — 순액이 (−)인 사람들이 각자 부족분을 총무에게 보냅니다.
     2단계 — 총무는 '실제로 받은 만큼'을 (+)인 사람들에게 몫 비율대로 나눠 보냅니다.
     퍼센트로 어림하지 않고 실제 송금 건마다 수수료를 떼서 합산합니다. */
  const debts = nets.filter((v) => v < 0).map((v) => -v);
  const credits = nets.filter((v) => v > 0);
  const debtTotal = debts.reduce((a, v) => a + v, 0);
  const creditTotal = credits.reduce((a, v) => a + v, 0);

  const hubIn = debts.reduce((a, v) => a + Math.floor(v * (1 - fee)), 0);
  let hubSent = 0;
  let hubDelivered = 0;
  credits.forEach((v, k) => {
    // 마지막 사람이 나머지를 받아 총무 손에 잔돈이 남지 않게 합니다
    const part =
      k === credits.length - 1 ? hubIn - hubSent : Math.floor((hubIn * v) / (creditTotal || 1));
    hubSent += part;
    hubDelivered += Math.floor(part * (1 - fee));
  });

  return {
    n,
    fee,
    total,
    fines,
    shares,
    nets,
    transfers,
    gotten,
    colTotals,
    discTotal,
    moved: transfers.reduce((a, t) => a + t.amount, 0),
    feeTotal: transfers.reduce((a, t) => a + t.fee, 0),
    hubFee: debtTotal - hubDelivered,
    hubCount: debts.length + credits.length,
    activeCount: active.length,
    groupCount: groupLists.length,
    exact,
  };
}

const won = (v) => Math.round(v).toLocaleString("ko-KR");
const G = (v) => won(v) + "G";
/* 172만, 21만5,000 처럼 읽습니다. 1만 미만이면 0.63만 같은 소수 대신 정수만. */
/* 입력 단위가 1G면 앱 표기도 생숫자로 — "표시 단위 = 입력 단위" 원칙.
   렌더 때 본체 컴포넌트가 갱신합니다. 오버레이(방송)는 별도 표기라 무관합니다. */
let RAW_G = false;
const man = (v) => {
  const neg = v < 0;
  const a = Math.abs(Math.round(v));
  const c = (x) => x.toLocaleString("ko-KR");
  if (RAW_G) return (neg ? "−" : "") + c(a);
  const m = Math.floor(a / UNIT);
  const rest = a % UNIT;
  const s = m === 0 ? c(rest) : rest === 0 ? `${c(m)}만` : `${c(m)}만${c(rest)}`;
  return (neg ? "−" : "") + s;
};
const signedMan = (g) => (g < 0 ? "−" : "+") + man(Math.abs(g));
/* 받침에 따라 조사를 고릅니다 — 닉네임이 들어가는 안내문이 어색하지 않게 */
const josa = (word, withJong, noJong) => {
  const c = String(word || "").charCodeAt(String(word).length - 1);
  if (c >= 0xac00 && c <= 0xd7a3) return (c - 0xac00) % 28 ? withJong : noJong;
  return `${withJong}(${noJong})`; // 영문·숫자 끝이면 병기
};
const hhmm = (t) => {
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

/* ================================================================ */

export default function GoldSettlement() {
  /* 시작 상태: 공유 링크 > 브라우저에 저장된 것 > 기본값 */
  const boot = useRef(null);
  if (!boot.current) {
    /* #live=ROOMID 로 들어오면 읽기 전용 뷰어입니다. 이 브라우저에 저장된 장부는
       손대지 않고(저장도 안 하고), 방장이 밀어 주는 상태만 비춥니다.
       #o=TOKEN 은 방을 모른 채 들어오는 길입니다 — resolve 로 찾아 같은 뷰어를 엽니다. */
    const liveRoom = DEMO_MEMBER ? DEMO_ROOM : readLiveRoom(); // 파티원 예시는 예시 방의 뷰어로 뜹니다
    const obsToken = readObsToken();
    /* 단, 방장 본인이 자기 방 주소를 열었다면 — 쓰기 세션이 이 브라우저에 있으니
       구경꾼 화면 대신 자기 장부(입력 화면)로 들어갑니다 */
    const own = liveRoom && loadRelay().room === liveRoom && !!loadAuth();
    if (own && canOwnUrl && typeof window !== "undefined") {
      const hp = hashParams();
      hp.delete(LIVE_KEY);
      hp.delete(JOIN_KEY);
      const { pathname, search } = window.location;
      const rest = hashText(hp);
      window.history.replaceState(null, "", pathname + search + (rest ? "#" + rest : ""));
    }
    /* 방 하나 규칙 (2026-09-07 사용자 확정: 파티원은 [나가기], 방장은 [정산 끝내기]로만 판을 떠난다) — 이 브라우저에 내 판이 있으면
       남의 초대 링크를 뷰어로 열지 않습니다. 초대를 보관한 채 내 앱으로 들어가 시작 전이면 [해산하고 가기], 진행 중이면 [끝내러 가기]를 묻습니다.
       코드 사실: 남의 파티 화면에 들어가면 내 판의 서기 소켓이 끊겨 파티원 자수가 막히고, 계정의 현재 방이 바뀌어 방송용 주소가 남의 판을 비춘다 */
    let held = false;
    if (liveRoom && !own && !obsToken && !DEMO && canOwnUrl && typeof window !== "undefined") {
      const rel = loadRelay();
      const sv = loadSaved();
      const hasBoard = !!rel.boardOn || !!(sv && sv.roundLive && Array.isArray(sv.rows) && sv.rows.length);
      if (hasBoard) {
        try {
          localStorage.setItem("goldSettlement.pendingJoin", JSON.stringify({ room: liveRoom, code: readJoinCode() || "", t: Date.now() }));
        } catch (e) {}
        const hp = hashParams();
        hp.delete(LIVE_KEY);
        hp.delete(JOIN_KEY);
        const { pathname, search } = window.location;
        const rest = hashText(hp);
        window.history.replaceState(null, "", pathname + search + (rest ? "#" + rest : ""));
        held = true;
      }
    }
    if ((liveRoom && !own && !held) || obsToken) {
      /* 같은 방의 마지막 판이 담겨 있으면 그것으로 앉힙니다 — 새로고침했다고
         정산이 사라지면 안 됩니다. 연결이 살아 있으면 곧 새 판이 덮어씁니다. */
      const kept = liveRoom ? loadLastLive() : null;
      const seed = kept && kept.room === liveRoom ? kept.full : null;
      /* 뷰어로 연 것도 앱을 연 것입니다 — 저장은 못 해도 이 표시 하나는 남깁니다 (§3-17) */
      markSeen();
      boot.current = {
        cols: (seed && seed.cols) || DEFAULT_COLS,
        rows: (seed && migrateRows(seed.rows)) || [],
        feePercent: (seed && seed.feePercent) || "5",
        mode: (seed && seed.mode) || "items",
        unit: (seed && seed.unit) || "10000",
        splitMode: seed && seed.splitMode === "solo" ? "solo" : "pot",
        seq: 1000,
        view: "tabs",
        tab: "sheet",
        theme: (loadSaved() || {}).theme || "system",
        firstVisit: false,
        /* 뷰어에게는 로비도 자리도 없습니다 — 남의 판을 비추는 화면입니다 */
        roundLive: true,
        roundId: "",
        seats: [],
        liveRoom: liveRoom || null,
        joinCode: readJoinCode(),
        obsToken,
        /* 판 기록은 이 브라우저의 것이라 뷰어도 자기 기록을 그대로 봅니다.
           목록만 읽고 이주(활성 판 승격)는 하지 않습니다 — 뷰어에게는 활성 판이 없습니다 */
        partyReg: loadPartyReg() || { list: [{ name: DEFAULT_ROOM_LABEL, t: 0 }], active: DEFAULT_ROOM_LABEL },
      };
    }
  }
  if (!boot.current) {
    const hashMode = readHashMode();
    const shared = DEMO ? null : readShared();
    const stored = DEMO ? null : loadSaved(); // 예시 앱은 백지 판으로
    // 공유 링크로 열면 표는 링크 것을 쓰지만, 보기 방식(탭/세로)은 이 브라우저의 취향을 따릅니다
    const saved = shared ? null : stored;
    /* 처음 여는 사람은 빈 카운터 표로 바로 시작합니다 (새 파티 기본값과 동일).
       예시는 표를 채워두는 대신 파티 목록의 '현자들'과 첫 안내가 맡습니다. */
    const fallbackMode = hashMode || "items";
    const data = shared ||
      saved || {
        cols: DEFAULT_COLS,
        rows: Array.from({ length: 8 }, (_, i) => ({
          id: "r" + (i + 1),
          name: FILL_NAME(i + 1),
          counts: fallbackMode === "simple" ? { [SIMPLE_ID]: "" } : {},
          extras: [],
        })),
        feePercent: "5",
        mode: fallbackMode,
      };
    /* 파티 장부 — 공유 링크로 연 게 아니면, 활성 파티의 장부가 표를 정합니다.
       레지스트리가 없으면(기존 사용자·첫 방문) 지금 장부를 '기본' 파티로 승격합니다. */
    let partyReg = null;
    if (!shared && !DEMO) {
      partyReg = loadPartyReg() || { list: [{ name: "기본", t: Date.now() }], active: "기본" };
      if (!partyReg.list.some((x) => x.name === partyReg.active))
        partyReg.active = partyReg.list[0].name;
      /* 첫 방문자도 빈 판으로 시작합니다 — 예시는 튜토리얼을 고른 사람에게만 얹습니다.
         묻지 않고 예시 파티에 앉히면, 안 볼 사람까지 남의 데이터를 치우고 시작해야 합니다. */
      const slot = loadPartySlot(partyReg.active);
      if (slot) Object.assign(data, slot);
      else savePartySlot(partyReg.active, partyLedgerOf(data));
      /* 단일 장부 전환 이주 — 활성이 아닌 옛 파티는 전부 「지난 판」이 됩니다.
         데이터는 자리 그대로 두고 표시만 바꾸므로 손실이 없고, 빈 껍데기(기록도
         벌금도 없는 파티)는 목록에서만 뺍니다(저장소는 안 지웁니다 — 되돌릴 수 있게). */
      partyReg.list = partyReg.list.filter(
        (x) =>
          x.name === partyReg.active ||
          x.gen != null ||
          slotWorthKeeping(loadPartySlot(x.name))
      );
      partyReg.list = partyReg.list.map((x) =>
        x.name === partyReg.active || x.gen != null
          ? x
          : { ...x, gen: true, locked: true }
      );
      savePartyReg(partyReg);
    }

    /* 홈은 로비입니다 (§3.1) — 판은 [시작]으로만 생깁니다.
       판이 살아 있으면 열자마자 벌금표라, 매일 혼자 쓰는 사람은 로비를 볼 일이 드뭅니다.
       개편 전 저장본(roundLive 가 안 적힌 것)은 stored 안에서 이미 true 로 승격돼 있고,
       공유 링크로 연 표도 곧 판입니다. 저장된 것도 링크도 없을 때만 로비로 엽니다. */
    /* 자동 중단 폐지 (§3.4, 2026-09-05) — 옛 저장본의 얼린 판은 그냥 살아 있는 판으로 엽니다 */
    const roundLive = shared ? true : stored ? !!(stored.roundLive || stored.roundPaused) : false;
    /* 살아 있는 판의 자리는 그 판의 줄에서 뜹니다. 판이 없으면(첫 실행) 빈 명단으로
       시작합니다 — 로비에서 이름을 직접 적는 것이 첫 걸음이라, 자리표시를 미리 깔면
       "덜 차도 채워서 시작"이 안 됩니다 (§3.1) */
    const seats =
      stored && stored.seats && stored.seats.length
        ? stored.seats
        : roundLive
        ? seatsFromRows(data.rows)
        : [];

    // 주소에 적힌 모드가 저장된 모드보다 우선합니다 (모드별 주소를 열었을 때)
    boot.current = {
      ...data,
      partyReg,
      roundLive,
      roundId: (stored && stored.roundId) || "",
      roundPaused: false,
      seats,
      mode: hashMode || data.mode || "simple",
      seq: nextSeq({ ...data, seats }),
      view: stored ? stored.view : "tabs",
      tab: stored ? stored.tab : "sheet",
      // 화면 밝기 취향은 표와 무관하니 공유 링크로 들어와도 이 브라우저 것을 씁니다
      theme: stored ? stored.theme : DEMO ? (loadSaved() || {}).theme || "system" : "system",
      /* 저장된 장부도 공유 링크도 없으면 첫 방문입니다. 주소의 #m= 은 보지 않습니다 —
         앱이 제 주소에 그걸 적기 때문에, 조건에 넣으면 두 번째 방문처럼 보입니다.
         관문은 묻기만 하므로 해시를 달고 온 사람에게 떠도 아무것도 안 망가집니다.
         뷰어로만 열었던 브라우저에는 저장본이 없습니다 — 그때 남긴 표시를 같이 봅니다 */
      firstVisit: !DEMO && !shared && !stored && !wasSeen(),
      /* 로비(§3.0) 도착 규칙 — 주소에 화면이 적혀 있으면 그대로(새로고침·뒤로가기가 화면을 지킨다,
         2026-09-05). 비어 있으면 백지(내 판을 만든 적이 없음)면 로비, 아니면 판 — 결과는 마운트 때
         주소에 적는다. (폐기 2026-09-05) sessionStorage gs-home 표시 — 주소 #lobby 가 그 뜻을 말한다 */
      route: readRoute(),
      atLobby: (() => {
        const r = readRoute();
        if (r.view === VIEW_LOBBY) return true;
        if (r.view) return false;
        const made =
          roundLive ||
          (data.log || []).length > 0 ||
          (partyReg && partyReg.list.some((x) => x.gen && (!x.host || x.host === x.me))) ||
          (data.rows || []).some((x, i) => i > 0 && (x.name || "").trim() && !isFillName(x.name));
        return !made;
      })(),
    };
  }

  /* 뷰어(읽기 전용)인지 — 이 값이 참이면 어떤 조작도 이 브라우저의 장부를 바꾸지 못합니다.
     #o=TOKEN 은 방을 모르고 들어오므로, 뷰어 여부는 부트에서 정하고 방 id 는 나중에 채웁니다. */
  const viewer = !!boot.current.liveRoom || !!boot.current.obsToken;
  const [liveRoom, setLiveRoom] = useState(boot.current.liveRoom || null);
  const obsEntry = boot.current.obsToken || null;
  const joinCode = boot.current.joinCode || null;
  /* 지난 판 보기 — 읽기 전용. 지난 판은 들춰보는 것이고, 장부는 쓰는 것입니다 */
  const [genView, setGenView] = useState(null);
  const readOnly = viewer || !!genView;
  const [liveState, setLiveState] = useState(readOnly ? "connecting" : null); // connecting|on|empty|dead
  const [liveName, setLiveName] = useState("");
  const [liveTick, setLiveTick] = useState(0);   // 갱신이 올 때마다 +1 — 점이 깜빡입니다
  const [roPulse, setRoPulse] = useState(0);     // 뷰어가 뭘 누르면 배너가 한 번 꿈틀합니다
  /* 십자 하이라이트 — 마우스를 올린 칸의 (줄, 열). 이름과 항목을 같이 밝혀
     "이 사람 × 이 항목"을 눈이 두 번 되짚지 않게 합니다. 표를 벗어나면 지웁니다. */
  /* 시크릿 창인지 — 알려 주는 표준 API 는 없습니다. 크로뮴은 시크릿 창의 저장 한도를
     크게 줄여서, 한도가 유난히 작으면 시크릿이거나 디스크가 거의 찬 상태입니다.
     어느 쪽이든 "닫으면 날아갈 수 있다"는 말은 맞아서 둘 다 담아 적습니다.
     틀려도 손해가 없게, 알리기만 하고 아무것도 막지 않습니다. */
  const [privWarn, setPrivWarn] = useState(false);
  useEffect(() => {
    if (readOnly) return;
    let gone = false;
    try {
      navigator.storage
        .estimate()
        .then((e) => {
          if (!gone && e && e.quota && e.quota < 400 * 1024 * 1024) setPrivWarn(true);
        })
        .catch(() => {});
    } catch (e) {}
    return () => {
      gone = true;
    };
  }, [readOnly]);
  const [cross, setCross] = useState(null);
  /* 십자 하이라이트는 표 하나가 위임으로 받습니다. 칸마다 onMouseEnter 를 달면 두 군데서
     샙니다 — 새로 만든 칸에 안 달았을 때, 그리고 같은 줄 안에서 옮길 때(줄을 떠난 적이
     없어 줄 핸들러가 다시 안 울립니다). mouseover 는 거품이 올라와서 둘 다 덮습니다.
     줄은 data-row, 누를 수 있는 칸은 data-col 로 자기를 밝힙니다. 아무 표시도 없는 칸은
     "그 줄만" 또는 "아무것도"가 되고, 그게 이름·합계·도구·머리칸의 올바른 답입니다. */
  const hoverCell = (e) => {
    const cell = e.target.closest && e.target.closest("td,th");
    if (!cell) return;
    const tr = cell.closest("tr");
    const r = (tr && tr.dataset.row) || null;
    const c = cell.dataset.col || null;
    setCross((p) => {
      if (!r && !c) return p === null ? p : null;
      return p && p.r === r && p.c === c ? p : { r, c };
    });
  };
  /* 모달이 떠 있는 동안 뒤 페이지 스크롤을 잠급니다 — 창 바깥에 마우스를 두고 굴리면
     뒤가 밀려서, 창을 닫았을 때 엉뚱한 자리에 와 있습니다.
     창 종류가 여럿이라 상태를 일일이 세는 대신 화면에 창이 있는지로 봅니다. */
  /* 잠그면 스크롤바가 사라지고 그 폭만큼 화면이 옆으로 밀립니다. 사라진 만큼을
     오른쪽 여백으로 도로 채웁니다 — 폭을 미리 아는 방법이 없어서(브라우저·OS마다 다르고
     scrollbar-gutter 는 뷰포트에 안 먹습니다) 잠근 전후를 재서 그 차이를 씁니다.
     여닫는 순간에만 재야 합니다. 이 효과는 매 렌더 도는데, 이미 잠긴 상태에서 다시 재면
     차이가 0 이라 채워 둔 여백을 도로 걷어냅니다. */
  const lockRef = useRef(false);
  useEffect(() => {
    const open = !!document.querySelector(".gs-modal");
    if (open === lockRef.current) return;
    lockRef.current = open;
    const b = document.body;
    if (!open) {
      b.style.overflow = "";
      b.style.paddingRight = "";
      return;
    }
    const before = document.documentElement.clientWidth;
    b.style.overflow = "hidden";
    const gap = document.documentElement.clientWidth - before;
    if (gap > 0) b.style.paddingRight = gap + "px";
  });
  useEffect(
    () => () => {
      document.body.style.overflow = "";
      document.body.style.paddingRight = "";
    },
    []
  );
  /* 같은 이름이 둘이면 우편·장부가 사람을 못 가립니다. 치는 중에는 막지 않고(한 글자씩
     칠 때마다 걸리면 못 씁니다), 칸을 벗어날 때 되돌립니다. 알림은 토스트라 표가 안 밀립니다. */
  const dupName = (id, name) => {
    const t = (name || "").trim();
    if (!t) return false;
    return rows.some((x) => x.id !== id && (x.name || "").trim() === t);
  };
  /* 알림 한 줄. 룰렛을 우클릭했을 때처럼 "왜 안 되는지"를 그 자리에서 알려 줍니다 */
  const [toast, setToast] = useState(null);      // {t, msg}
  /* msg 는 글자여도 되고 조각(JSX)이어도 됩니다 — 안에 누를 것을 넣을 때가 있습니다 */
  const say = (msg, ms) => setToast({ t: Date.now(), msg, ms });
  /* 기록 버튼을 깜빡이게 하는 토스트 — 벌금이 장부에 적혔거나 장부에서 고쳐야 하는 말만.
     예전엔 모든 토스트가 깜빡여서, 시작 전 잠긴 칸을 눌러도 빈 기록이 빛났습니다 (2026-09-05) */
  const sayLog = (msg) => setToast({ t: Date.now(), msg, log: true });

  const [cols, setCols] = useState(boot.current.cols);
  const [rows, setRows] = useState(boot.current.rows);
  const [feePercent, setFeePercent] = useState(boot.current.feePercent);
  // 정산 방식도 수수료처럼 파티 장부에 붙어 다닙니다
  const [splitMode, setSplitMode] = useState(boot.current.splitMode === "solo" ? "solo" : "pot");
  const [showSplitHelp, setShowSplitHelp] = useState(false);
  /* 방금 누른 것 — 이번 묶음의 기록 id 들. 새것이 뒤에 붙고, 카드는 아래가 고정이라
     방금 누른 줄이 늘 같은 자리에 있습니다. 기록에서 다시 읽으므로 취소도 기록과 한 몸입니다. */
  const [burst, setBurst] = useState([]);
  const [burstKey, setBurstKey] = useState(0); // 시간 막대를 다시 채우는 열쇠
  const [burstHold, setBurstHold] = useState(false); // 올려 둔 동안은 시계가 멉니다
  const [burstNow, setBurstNow] = useState(0); // 초를 세는 눈금. 멈춘 동안은 안 움직입니다
  const notePress = (id) => {
    setBurst((prev) => {
      const next = [...prev, id];
      return next.length > BURST_MAX ? next.slice(next.length - BURST_MAX) : next;
    });
    setBurstKey((k) => k + 1);
  };

  /* 튜토리얼 중인지 — 예시 표는 화면에만 얹고 저장하지 않습니다. 저장하면 지난 판에
     남의 예시가 남고, 끝난 뒤 치우는 일이 사용자 몫이 됩니다. 끝나면 아래 장부로 돌아갑니다:
     첫 방문이면 빈 판, 나중에 다시 본 것이면 보던 장부(그래야 남의 장부를 안 덮습니다). */
  const [tutorial, setTutorial] = useState(DEMO); // 예시 앱은 처음부터 끝까지 tutorial 입니다
  const tutorialRef = useRef(DEMO); // 같이 해보기가 도는 중인지 — 낡은 클로저(타이머·putRelay)에서 봅니다
  tutorialRef.current = tutorial;

  /* 코치마크 진행 상태 — {kind:"course",step} | {kind:"obs"} | {kind:"hint"} */
  const [coach, setCoach] = useState(null);
  const obsCoachPending = useRef(false);

  const coachRef = useRef(null);
  coachRef.current = coach;
  if (DEMO) window.__gsDemo = { coach, sel: coach && coach.kind === "party" && TOUR_FLOW[coach.step] ? TOUR_FLOW[coach.step].sel : null }; // 예시 앱 검사용

  useEffect(() => {
    if (!burst.length || burstHold) return;
    const t = setTimeout(() => setBurst([]), BURST_MS);
    return () => clearTimeout(t);
  }, [burst, burstHold, burstKey]);

  /* 남은 초와 '몇 초 전'을 같은 눈금에서 읽습니다 — 두 시계가 따로 돌면 어긋나 보입니다 */
  useEffect(() => {
    if (!burst.length) return;
    setBurstNow(Date.now());
    if (burstHold) return;
    const t = setInterval(() => setBurstNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [burst, burstHold, burstKey]);

  /* 코스 진행 — 해당 조작이 실제로 일어났을 때만 다음으로 */
  /* 진짜 버튼을 눌러도 튜토리얼이 넘어갑니다 — 칸 누르기·탭·OBS 버튼이 부릅니다 */
  const courseHit = (what) => {
    if (tutorialRef.current) tutHit(what);
  };

  const [mode, setMode] = useState(boot.current.mode || "simple");
  const [unit, setUnit] = useState(boot.current.unit || "10000");
  /* 표기 방침을 렌더마다 못 박습니다 — 1G 입력자는 생숫자를 보고 그대로 칩니다 */
  RAW_G = unit === "1";
  const [memoFont, setMemoFont] = useState(clampMemoFont(boot.current.memoFont));
  const [flash, setFlash] = useState("");
  const [openRow, setOpenRow] = useState(null);
  const [ask, setAsk] = useState(null);
  const [share, setShare] = useState(null);
  /* [?] 팝오버 — 튜토리얼 둘 중 고르기 (2026-09-06 사용자 확정: 사용법 모달 폐기) */
  const [helpOpen, setHelpOpen] = useState(false);
  const [helpAuto, setHelpAuto] = useState(false); // 파티원 첫 방문에 저절로 열린 것 — 머리말이 다릅니다
  const helpWrapRef = useRef(null);
  useEffect(() => {
    if (!helpOpen) return;
    const h = (e) => {
      if (helpWrapRef.current && !helpWrapRef.current.contains(e.target)) setHelpOpen(false);
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [helpOpen]);
  const [showHub, setShowHub] = useState(false);
  /* 보기 방식 — 탭(한 카드만 크게, 방송용)과 세로(세 카드를 이어서). */
  const [view, setView] = useState(boot.current.view);
  const [tab, setTab] = useState(boot.current.tab);
  /* 기록 — 카운터의 ＋·직접 수정이 델타로 한 줄씩 쌓입니다. 영수증이지 원본이 아니라서
     정산·공유는 이 목록을 보지 않습니다. 취소는 줄을 지우지 않고 반대 기록을 덧붙입니다(역분개). */
  const [log, setLog] = useState(boot.current.log || []);
  /* 카드에 그릴 줄들. id 만 들고 있다가 기록에서 읽어 오므로, 어디서 취소하든
     (카드에서든 기록 창에서든) 같은 줄이 같이 사라집니다. */
  const burstRows = useMemo(() => {
    if (!burst.length) return [];
    const by = {};
    log.forEach((e) => {
      by[e.id] = e;
    });
    return burst.map((id) => by[id]).filter((e) => e && !e.cancelled);
  }, [burst, log]);

  const [showLog, setShowLog] = useState(false);
  /* 기록 모달의 사람 필터 — 이름 칸의 '기록'으로 들어오면 그 사람 것만 봅니다.
     벌금 시비는 사람 단위로 붙어서, 전체 로그를 훑는 것보다 이쪽이 빠릅니다. */
  const [logRow, setLogRow] = useState(null);
  /* 기타 — 셀에서 숫자만 치고 바로 등록. 사유는 선택이라 밑줄 버튼 → 작은 창으로 뺍니다. */
  const [discRow, setDiscRow] = useState(null);
  const [discAsk, setDiscAsk] = useState(null);
  /* 기타 편집칸은 바깥을 누르면 닫힙니다 (2026-09-05 ②) — 친 글자가 있으면 남깁니다 */
  useEffect(() => {
    if (discRow == null) return;
    const onDown = (e) => {
      if (e.target && e.target.closest && e.target.closest(".gs-disc, .gs-modal")) return;
      setDiscRow((v) => (v == null ? v : (discDraftRef.current[v] || "").trim() ? v : null));
    };
    document.addEventListener("mousedown", onDown, true);
    return () => document.removeEventListener("mousedown", onDown, true);
  }, [discRow]);
  /* 치던 숫자는 사람별로 부모가 들고 있습니다 — 다른 행에 갔다 와도 안 날아가게 */
  const [discDraft, setDiscDraft] = useState({});
  const discDraftRef = useRef({});
  discDraftRef.current = discDraft;
  /* 기타 편집기가 열려 있는 동안 바깥 어딘가를 클릭하면 닫습니다.
     편집기 내부는 stopPropagation 이라 여기 안 옵니다. */
  useEffect(() => {
    if (!discRow) return;
    const onDown = (e) => {
      if (e.target.closest && e.target.closest(".gs-disc")) return;
      setDiscRow(null);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [discRow]);
  /* 명단(프리셋) — 이름만 담아 두고 새 판에서 불러옵니다 */
  /* 실수 복구 — 인원·항목 삭제와 초기화 직전의 표를 한 슬롯 떠 둡니다.
     다음 편집 전까지만 유효하고(통짜 복원이라 그 사이 편집을 같이 날리지 않게),
     저장도 되어서 패닉 새로고침 후에도 편집 전이면 되돌릴 수 있습니다. */
  const [undoSnap, setUndoSnap] = useState(boot.current.undoSnap || null);
  const snapHold = useRef(false); // true 면 이번 rows/cols 변경은 스냅샷을 접지 않음
  const snapBooted = useRef(false);
  /* 첫 방문 관문 — "first"는 튜토리얼을 볼지 묻는 화면(닫을 수 없음),
     "guide"는 '자세히 보기'로 나중에 다시 연 모드 안내입니다.
     관문이 떠 있는 동안은 저장도, 주소 수정도 하지 않습니다 — 고르지 않고 새로고침하면
     관문이 다시 나와야 하는데, 그 사이 뭐라도 저장되면 두 번째 방문으로 잡힙니다. */
  /* (폐기 2026-09-06) 첫 방문 관문 "first" — 닫을 수 없는 모달이었고 새 판을 누른 뒤에야 떠서 처음 온 사람은 거기까지 못 갔다.
     로비 권유 줄과 화면별 사용법이 대신한다. "guide"(모드 안내)는 그대로 */
  const [intro, setIntro] = useState(null);
  /* 카운터 → 메모장으로 갈 때 동결해 두는 구성. 돌아올 때 이름으로 대조해 복원합니다. */
  const [memoFreeze, setMemoFreeze] = useState(boot.current.memoFreeze || null);
  /* 화면 밝기 — 기본은 시스템 설정을 따르고, 원하면 낮/밤으로 고정합니다.
     긴 방송에서 눈이 덜 아프게 밤 팔레트는 순검정 대신 어두운 갈색입니다. */
  const [theme, setTheme] = useState(boot.current.theme || "system");
  const [sysDark, setSysDark] = useState(
    () => typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: dark)").matches
  );
  useEffect(() => {
    const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
    if (!mq) return;
    const on = (e) => setSysDark(e.matches);
    mq.addEventListener ? mq.addEventListener("change", on) : mq.addListener(on);
    return () =>
      mq.removeEventListener ? mq.removeEventListener("change", on) : mq.removeListener(on);
  }, []);
  const dark = theme === "dark" || (theme === "system" && sysDark);
  // 가이드로 연 선택 화면은 Esc 로 닫습니다 (첫 방문 관문은 못 닫습니다)
  useEffect(() => {
    if (intro !== "guide") return;
    const onKey = (e) => {
      if (e.key === "Escape") setIntro(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [intro]);
  const seq = useRef(boot.current.seq);

  const simple = mode === "simple";
  /* 보기 방식은 탭으로 고정했습니다 — 스크롤 보기를 쓰던 브라우저도 조용히 탭으로 */
  const tabbed = true;
  /* 어느 탭을 그릴지는 파티원 자격을 알아야 정해집니다 — showSheet 들은 아래(guestPlaying 뒤)에서 셉니다 */
  const pickTab = (k) => {
    setTab(k);
    window.scrollTo(0, 0);
    courseHit("tab:" + k); // 튜토리얼 5장·파티원 3걸음
  };

  /* 금액만 모드는 왼쪽 메모장 ↔ 오른쪽 표가 같은 데이터를 봅니다.
     메모장에서 친 글자가 표를 덮어쓰고, 표에서 고친 값이 메모장 글로 돌아옵니다.
     한쪽이 방금 바꾼 건 되돌려 쓰지 않도록 깃발로 한 번 걸러 냅니다. */
  const [memoText, setMemoText] = useState("");
  const fromMemo = useRef(false);
  useEffect(() => {
    if (!simple) return;
    if (fromMemo.current) {
      fromMemo.current = false;
      return;
    }
    const t = rowsToMemo(rows);
    // 빈 행뿐이면 개행만 남는데, 그러면 플레이스홀더(입력 예시)가 안 보입니다. 빈 값으로.
    setMemoText(/^\s*$/.test(t) ? "" : t);
  }, [rows, simple]);

  /* 장부는 하나입니다. 모드를 바꾸는 것이 곧 변환이고, 두 벌의 숫자가 공존하지 않습니다.
     카운터 → 메모장은 그 순간의 구성(횟수·기타)을 동결해 두므로 잃는 것이 없고,
     돌아올 때 이름으로 대조해 복원합니다. 그래서 이제 아무것도 묻지 않습니다. */
  const itemGold = (row) =>
    cols.reduce((a, c) => a + cellGold(row, c.id, Math.round(goldOf(c.price))), 0) +
    extraSum(row);
  const simpleGold = (row) => Math.round(num(row.counts[SIMPLE_ID]) * goldOf(unit));

  /* 메모장 → 카운터. 동결해 둔 구성을 이름으로 대조해 살립니다.
     같은 이름·같은 합계 → 구성 그대로 복원 (무손실 왕복).
     같은 이름·다른 합계 → 구성 복원 + 차액만 기타 한 줄, 기록에도 인원당 한 줄.
     메모장에서 새로 적은 사람 → 기타 이관. 지운 사람 → 기록에 제외 한 줄.
     이름 대조인 이유: 메모장은 줄 순서가 곧 정체성이라, 위치로 맞추면
     중간 줄 하나만 지워도 아래 전원이 남의 횟수를 물려받습니다. */
  const fromMemoRows = () => {
    const frozen = (memoFreeze ? memoFreeze.people : []).map((p) => ({ ...p, used: false }));
    const claim = (row, total) => {
      let hit = frozen.find((p) => !p.used && p.name === row.name && p.total === total);
      if (!hit) hit = frozen.find((p) => !p.used && p.name === row.name);
      if (hit) hit.used = true;
      return hit;
    };
    const lines = [];
    /* i 는 기록에 적을 "모험가n" 의 번호입니다 */
    const nextRows = rows.map((x, i) => {
      const memoTotal = simpleGold(x);
      const { [SIMPLE_ID]: _drop, ...restCounts } = x.counts || {};
      const hit = claim(x, memoTotal);
      if (hit) {
        // 메모장에서 0으로 지웠으면 구성도 비운 것으로 봅니다
        if (memoTotal === 0) {
          if (hit.total !== 0)
            lines.push({ kind: "memo", rowId: x.id, delta: -hit.total, name: seatName(x, i), after: 0 });
          return { ...x, counts: restCounts, sums: {}, extras: [] };
        }
        const { [SIMPLE_ID]: _s, ...frozenCounts } = hit.counts || {};
        const diff = memoTotal - hit.total;
        let extras = hit.extras || [];
        if (diff !== 0) {
          extras = [
            ...extras,
            { id: "e" + seq.current++, amount: commafy(diff), reason: ADJUST_REASON },
          ];
          lines.push({ kind: "memo", rowId: x.id, delta: diff, name: seatName(x, i), after: memoTotal });
        }
        return { ...x, counts: frozenCounts, sums: hit.sums || {}, extras };
      }
      if (memoTotal <= 0) return { ...x, counts: restCounts, sums: {}, extras: [] };
      if (memoFreeze)
        lines.push({ kind: "memo-new", rowId: x.id, delta: memoTotal, name: seatName(x, i), after: memoTotal });
      return {
        ...x,
        counts: restCounts,
        sums: {},
        extras: [{ id: "e" + seq.current++, amount: commafy(memoTotal), reason: CARRY_REASON }],
      };
    });
    frozen
      .filter((p) => !p.used && p.total !== 0)
      .forEach((p) => lines.push({ kind: "memo-del", delta: -p.total, name: p.name, after: 0 }));
    setRows(nextRows);
    lines.forEach((l) => appendLog(l));
    setMemoFreeze(null);
  };

  /* 모드도 판의 일부입니다 (§3.4) — 계정 붙은 자리가 있으면 방장의 전환이 파티원 화면까지
     바꿉니다. 파티원의 숫자가 사라져 보이는 일이라 §8 확인창을 한 번 거칩니다 */
  const changeMode = (next) => {
    if (readOnly) return;
    if (next === mode) return;
    if (next === "simple" && seats.some((s) => s.acct))
      return setAsk({
        title: "메모장으로 바꿀까요?",
        body: "메모장으로 바꾸면 파티원 화면도 메모장으로 바뀌어요.",
        action: "메모장으로",
        onYes: () => applyMode(next),
      });
    applyMode(next);
  };
  const applyMode = (next) => {
    if (readOnly) return;
    if (next === mode) return;
    setOpenRow(null);
    // 모드는 '벌금을 어떻게 적을지'라서, 바꾼 결과는 적는 화면에서 보여 줍니다
    setTab("sheet");

    // 손 안 댄 예시면 상대 모드 예시로 조용히 갈아끼웁니다
    if (isPristine(rows)) {
      setRows(next === "simple" ? DEFAULT_ROWS_SIMPLE : DEFAULT_ROWS);
      if (next === "simple") setUnit("10000");
      setMemoFreeze(null);
      setMode(next);
      return;
    }
    if (next === "items") {
      fromMemoRows();
      setMode(next);
      return;
    }
    // 카운터 → 메모장: 구성을 통째로 동결해 두므로 잃는 게 없습니다.
    // 이름을 지운 줄은 "(이름입력n)"을 붙여 내보냅니다 — 메모장에선 이름이 정체성이라,
    // 숫자만 남은 줄은 돌아올 때 대조가 위험해집니다.
    const taken = new Set(rows.map((x) => x.name).filter(Boolean));
    let k = 1;
    const named = rows.map((x) => {
      if (x.name || itemGold(x) === 0) return x;
      while (taken.has(FILL_NAME(k))) k++;
      const nm = FILL_NAME(k);
      taken.add(nm);
      return { ...x, name: nm };
    });
    setMemoFreeze({
      people: named.map((x) => ({
        name: x.name,
        counts: x.counts,
        sums: x.sums || {},
        extras: extrasOf(x),
        total: itemGold(x),
      })),
      t: Date.now(),
    });
    const per = goldOf(unit) || 1;
    setRows(
      named.map((x) => {
        const g = itemGold(x);
        return {
          ...x,
          counts: { [SIMPLE_ID]: g > 0 ? formatNumInput(String(g / per)) : "" },
          sums: {},
          extras: [],
        };
      })
    );
    setMode(next);
  };

  const per = goldOf(unit) || 1;
  const unitLabel = (UNITS.find((u) => u.v === unit) || {}).label || "G";
  const shownLog = logRow ? log.filter((e) => e.rowId === logRow) : log;
  const logName = logRow
    ? (rows.find((x) => x.id === logRow) || {}).name ||
      (shownLog.length ? shownLog[shownLog.length - 1].name : "")
    : "";

  const openLog = (rowId) => {
    setLogRow(rowId);
    setShowLog(true);
  };
  const closeLog = () => {
    setShowLog(false);
    setLogRow(null);
  };

  const pickIntro = (next) => {
    setIntro(null);
    if (next !== mode) changeMode(next); // 손 안 댄 기본값이라 예시가 조용히 갈아끼워집니다
  };

  const onMemo = (e) => {
    if (readOnly) return;
    const text = e.target.value;

    // 공유 링크·코드를 통째로 붙여넣으면 그 표를 불러옵니다
    const shared = importShareText(text);
    if (shared) {
      setCols(shared.cols);
      setRows(shared.rows);
      setFeePercent(shared.feePercent);
      if (shared.unit) setUnit(shared.unit);
      if (shared.mode && shared.mode !== mode) setMode(shared.mode); // 불러오기라 변환 없이
      seq.current = Math.max(seq.current, nextSeq({ ...shared, seats: seatsRef.current }));
      setOpenRow(null);
      setMemoFreeze(null); // 표가 통째로 바뀌면 옛 동결은 남의 표 — 버립니다
      return; // 메모장 글은 rows 효과가 새로 써 줍니다
    }

    fromMemo.current = true;
    setMemoText(text);
    setRows((prev) => memoToRows(text, prev));
    setOpenRow(null);
  };

  /* 칸 이동 — 같은 열에서 위아래 사람으로. 여덟 명 숫자를 이어서 칠 때
     마우스를 다시 잡지 않아도 되게 합니다. */
  const focusCell = (rowIdx, colId) => {
    const el = document.querySelector(`[data-cell="${rowIdx}:${colId}"]`);
    if (!el) return false;
    el.focus();
    el.select?.();
    return true;
  };
  const cellKey = (e, rowIdx, colId) => {
    const down = e.key === "Enter" ? !e.shiftKey : e.key === "ArrowDown";
    const up = e.key === "Enter" ? e.shiftKey : e.key === "ArrowUp";
    if (!down && !up) return;
    if (focusCell(rowIdx + (down ? 1 : -1), colId)) e.preventDefault();
  };
  /* 간단 모드에서는 '단가 = 입력 단위' 인 열 하나로 계산합니다.
     칸 값은 counts.simple 에 따로 담겨서 항목 모드 숫자와 섞이지 않습니다. */
  const activeCols = useMemo(
    () => (simple ? [{ id: SIMPLE_ID, name: "금액", price: unit }] : cols),
    [simple, unit, cols]
  );

  /* 룰렛이 도는 상태. 오버레이 전송이 이걸 읽으므로 위쪽에 둡니다 */
  const [spin, setSpin] = useState(null);
  const picking = !!spin && spin.phase === "pick";

  /* --- 파티원 화면의 룰렛 ---
     방장이 판 전체를 한 번에 보내 주므로, 여기서도 제 시계로 돌립니다.
     오버레이와 같은 속도로 맞춰서, 방송과 파티원 화면이 따로 놀지 않게 합니다. */
  /* 파티원 화면도 그 판의 속도를 그대로 씁니다 — 방송과 따로 놀지 않게 */
  const [vplay, setVplay] = useState(null); // {sp, i, rolling, over}
  const [vin, setVin] = useState(null); // 마지막으로 받은 판 (없으면 서기 쪽이 끝난 것)
  const vpend = useRef(null); // 도는 동안 도착한 표 (끝나고 반영)

  /* ================= OBS 중계 ================= */
  const [relay, setRelay] = useState(loadRelay);
  const [obsOpen, setObsOpen] = useState(false);

  /* ---- 파티: 파티 하나 = 장부 하나 = 공유 주소 하나 ---- */
  const [partyReg, setPartyReg] = useState(
    boot.current.partyReg || { list: [{ name: "기본", t: 0 }], active: "기본" }
  );
  const [presetOpen, setPresetOpen] = useState(false); // 프리셋 창(로비 항목 카드에서 엽니다)

  /* ---------- 로비(홈)와 자리 ----------
     혼자와 파티가 같은 문법을 씁니다 (§3). 로컬 모드라는 것은 없고, 혼자는 자리에
     이름만 채운 로비입니다. 판은 [시작]으로만 생기고, 판이 없으면 홈은 로비입니다. */
  const [roundLive, setRoundLive] = useState(!!boot.current.roundLive);
  const [roundId, setRoundId] = useState(boot.current.roundId || "");
  /* 판 이름 (§3.1) — 로비 히어로에서 눌러 고치고, [시작] 때 그 판의 이름이 됩니다.
     결과지·판 기록에 이 이름으로 남고, 판을 닫으면 다시 그날 기본값으로 돌아갑니다 */
  const [roundName, setRoundName] = useState(boot.current.roundName || defaultRoundName());
  /* 얼어 있는 판 — {why:"host"|"idle"}. 서버가 원본이고, 이 브라우저에도 적어 둡니다
     (로그인 전에도 로비에 중단된 판 카드가 서야 해서요) */
  const [paused, setPaused] = useState(boot.current.roundPaused ? { why: "host" } : null);
  /* 자리 — 로비 소유입니다. 판의 줄은 자리에서 만들고, 줄 id 는 자리 id 그대로입니다 */
  const [seats, setSeats] = useState(() => migrateSeats(boot.current.seats || []));
  /* 자리는 판보다 위에서 만들어지고 아래에서 읽힙니다 — 선언 순서에 안 걸리게 거울을 둡니다 */
  const seatsRef = useRef(seats);
  seatsRef.current = seats;
  const newRoundId = () => "g" + Date.now().toString(36) + Math.floor(Math.random() * 1296).toString(36);
  /* 시작 시각은 roundId 안에 있습니다 — Date.now().toString(36)은 2059년까지 8자라 그대로 읽습니다 (§3.0 로비 카드) */
  const roundSinceMin = () => {
    const t = /^g[0-9a-z]{8}/.test(roundId || "") ? parseInt(roundId.slice(1, 9), 36) : NaN;
    return isNaN(t) ? null : Math.max(0, Math.floor((Date.now() - t) / 60000));
  };
  /* ---------- 계정·로비 ----------
     로비는 화면이 아니라 서버에 사는 상태입니다. 방장이 화면을 떠나도 유지되고,
     메인 상단의 상시 위젯으로 언제든 돌아옵니다. */
  const [auth, setAuth] = useState(loadAuth);
  /* 계정 창 — {tab, after, ctx}. after 는 로그인이 끝난 뒤 이어서 할 일입니다 */
  const [authOpen, setAuthOpen] = useState(null);
  /* 익명 계정에 아이디·비밀번호를 붙이는 창 — {after}. 같은 계정에 덧씌우므로 주소는 안 바뀝니다 */
  const [upOpen, setUpOpen] = useState(null);
  /* ---------- 함께한 사람과 지목 초대 (§3.3) ----------
     목록이 곧 방 찾기입니다 — 검색은 없습니다. 전달은 디스코드가 하고, 앱은 열 때와
     창에 초점이 돌아올 때만 /me 로 확인합니다. 폴링도 푸시도 깔지 않습니다. */
  const [mates, setMates] = useState([]); // [{id, nick, t, room}]
  const [invites, setInvites] = useState([]); // [{from, fromNick, room, seat}]
  const [meCur, setMeCur] = useState(null); // 서버가 아는 "지금 들어가 있는 방"
  const [invSent, setInvSent] = useState({}); // 쏜 시각 {acct: t} — 1분 지나면 원래대로
  const [mateSheet, setMateSheet] = useState(null); // 함께한 사람 시트 {id, nick, room}
  const [invHide, setInvHide] = useState({}); // 거절한 초대는 이 화면에서 지웁니다
  /* 서버 로비가 "모으는 중"인지 — 이 동안만 뷰어·오버레이가 대기실을 그립니다 (§4.3).
     로비 자체는 홈이라 늘 있습니다 (§1) */
  const [lobbyOn, setLobbyOn] = useState(false);
  const [lobbyCap, setLobbyCap] = useState(8); // 정원 2~16
  const [members, setMembers] = useState([]); // [{acct,nick,rowId,st,t}]
  const [joinAsk, setJoinAsk] = useState(null); // 합류 신청 카드 {acct,nick}
  /* [자리 바꾸기] — 파티 서랍에서 사람을 다른 자리로 옮깁니다. {acct, nick} */
  const [seatMove, setSeatMove] = useState(null);
  const [rowPerson, setRowPerson] = useState(null); // 줄의 사람 시트 — 자리 id (§3.2, 2026-09-05)
  /* 표 아래 사람의 [자리 정하기] 시트 {acct, nick, st} (2026-09-06 재정정) — 진행 중에 줄 없이 온 사람은 방장이 직접 줄을 고른다
     (빈 줄 · 퇴장한 사람 줄 · 새 줄). 사용자가 여러 번 말한 "직접 배치"다. (폐기, 같은 날) 이 시트를 "던전 중에 답해야 하는 괴물"이라며
     걷어내고 [받기]가 첫 빈 줄/새 줄에 앉히게 한 것 — 내 판단이었고 동의받은 적 없다 */
  const [waitPick, setWaitPick] = useState(null);
  /* 헤더의 초대 코드 팝오버 (2026-09-06 사용자: 공유 창 안은 숨겨져 있다) */
  const [invOpen, setInvOpen] = useState(false);
  const invWrapRef = useRef(null);
  useEffect(() => {
    if (!invOpen) return;
    const h = (e) => {
      if (invWrapRef.current && !invWrapRef.current.contains(e.target)) setInvOpen(false);
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [invOpen]);
  /* 지난 판 이어서 — 고르기 창 */
  const [resumePick, setResumePick] = useState(false);
  const [arrived, setArrived] = useState({}); // 방금 앉은 줄 {자리 id: 시각} — 10초 뒤 지워집니다 (§3.1)
  const [kickedOut, setKickedOut] = useState(false); // 내보내진 파티원 — 카드 하나로 (2026-09-05)
  /* 초대장은 로그인 여부와 무관하게 거칩니다 (§3.3, 2026-09-05 표준화) — [참여하기]를 눌러야 앉습니다.
     로비의 파티 참여 칸으로 온 사람은 그 자리에서 이미 눌렀으니 건너뜁니다(sessionStorage gs-joinok).
     (폐기, 당일) 로그인 상태의 링크 즉시 착석 — 디스코드도 로그인돼 있어도 초대장을 먼저 보여 준다 */
  const [joinOk, setJoinOk] = useState(() => {
    try {
      const v = sessionStorage.getItem("gs-joinok");
      if (v) sessionStorage.removeItem("gs-joinok");
      return !!v && v === (boot.current.liveRoom || "") + (boot.current.joinCode || "");
    } catch (e) {
      return false;
    }
  });
  const [inviteOpen, setInviteOpen] = useState(false); // 판 중 초대 링크 창 (옛 파티 서랍의 자리)
  const [scribeLive, setScribeLive] = useState(false); // 서기 소켓이 붙어 있는지
  /* --- 파티원 쪽 --- */
  const [you, setYou] = useState(DEMO_MEMBER && !DEMO_CH4 ? { nick: "실리안", rowId: "r2", st: "ok" } : null); // {nick, rowId, st} — 이 방에서의 나. 4장 예시는 초대장부터라 아직 없음
  /* rowId↔이름 + 계정 붙음 표시(a) — 판 도중 합류자가 고를 수 있는 줄을 가립니다 (§3.2) */
  const [rows2v, setRows2v] = useState([]);
  const [scribeOn, setScribeOn] = useState(true); // 방장 앱이 켜져 있는지
  const [denied, setDenied] = useState(null); // "invite" | "member"
  const [confessErr, setConfessErr] = useState("");
  /* 판이 다시 시작됐다는 카드 — 화면을 잡아채지 않고 [들어가기]를 기다립니다 (§8) */
  const [startCard, setStartCard] = useState(null);
  /* 같은 카드를 자기 앱 쪽에도 세웁니다 — 정산이 끝난 뒤 [닫기]로 나온 사람은 여전히
     그 방 명단에 있고(§1: 정산 끝내기는 아무도 안 내보냅니다), 그 방에서 판이 다시
     열리면 돌아갈 문이 있어야 합니다. {room} */
  const [backCard, setBackCard] = useState(null);
  /* 보관된 초대 (방 하나 규칙, 2026-09-07) — 내 판이 있을 때 받은 초대. 판을 끝내거나 해산한 뒤 허브에서 [참여하기] */
  const [pendingJoin, setPendingJoin] = useState(() => {
    try {
      const v = JSON.parse(localStorage.getItem("goldSettlement.pendingJoin") || "null");
      return v && v.room ? v : null;
    } catch (e) {
      return null;
    }
  });
  const dropPendingJoin = () => {
    setPendingJoin(null);
    try {
      localStorage.removeItem("goldSettlement.pendingJoin");
    } catch (e) {}
  };
  /* 보관된 초대로 갑니다 — 초대장을 거쳐 들어가게 gs-joinok 은 안 남깁니다 */
  const goPendingJoin = () => {
    const p = pendingJoin;
    if (!p || typeof window === "undefined") return;
    dropPendingJoin();
    saveLastLive(null);
    const h = LIVE_KEY + "=" + p.room + (p.code ? "&" + JOIN_KEY + "=" + p.code : "");
    if (canOwnUrl && window.location.hash.replace(/^#/, "") !== h) {
      window.location.hash = h;
      return;
    }
    const { pathname, search } = window.location;
    window.history.replaceState(null, "", pathname + search + "#" + h);
    window.location.reload();
  };
  /* 끝난 판 — 방장이 공유를 껐거나, 판이 새로 시작됐거나, 내가 빠졌습니다.
     화면을 비우지 않고 마지막으로 받은 판을 그대로 보여 줍니다(정산은 판이 끝난 뒤에 하니까). */
  const [ended, setEnded] = useState(false);
  /* 마지막으로 받은 판 — {full, host, mems, me, from, to}. 화면 갱신과 무관해 ref 입니다 */
  const lastLive = useRef(null);
  const liveBack = useRef(null); // 뷰어가 판 기록을 열었을 때 돌아올 자리
  const archiveRef = useRef(null); // 판 기록에 넣는 함수 (최신 값을 보게)
  const genViewRef = useRef(null);
  genViewRef.current = genView;
  /* 방 이름 기본값이 '벌금 현황판'이라 어느 방인지 알 수 없습니다 — 방장 닉으로 부릅니다 */
  const [ownerNick, setOwnerNick] = useState("");
  const [roomOpen, setRoomOpen] = useState(false); // 머리줄 방 표시 칩의 패널 = 파티 서랍
  const [whyOpen, setWhyOpen] = useState(false); // 왜 파티원은 남의 줄을 못 고치나요?
  /* 방 패널도 계정 드롭다운과 같은 규칙 — 바깥을 누르면 닫힙니다 */
  useEffect(() => {
    if (!roomOpen) return;
    const onDown = (e) => {
      if (e.target.closest && e.target.closest(".gs-roomdd")) return;
      setRoomOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [roomOpen]);
  /* 죽은 링크가 화면에 떠 있는 상태(`0분 남음`)를 아예 안 만듭니다 (§9) —
     초대를 보여 주는 자리(대기실·파티 서랍)를 여는 순간 만료돼 있으면 그때 새로 냅니다.
     복사는 복사만 하고, 새로 발급은 눌러야 한다는 규칙은 그대로입니다 */
  useEffect(() => {
    if (!(roomOpen || lobbyOn) || readOnly || !auth || !relay.room) return;
    /* 1분도 안 남은 것은 죽은 링크나 마찬가지입니다 — 분 단위로 적으니 화면에도
       `0분 남음`으로 뜨고, 그걸 복사해 올리면 파티원이 문 앞에서 막힙니다 */
    if (relay.invite && relay.invite.exp && relay.invite.exp - Date.now() > 60000) return;
    ensureInvite();
  }, [roomOpen, lobbyOn]);
  const [presets, setPresets] = useState(loadPresets);
  const savePresetNow = (name) => {
    const nm = (name || "").trim();
    if (!nm) return false;
    /* 로비에서는 지금 명단이 자리이고, 판에서는 줄입니다 — 판이 닫힌 뒤에도 줄이 남아
       있어서, 로비에서 고친 이름이 아니라 지난 판의 이름을 담는 일이 없게 갈라 씁니다 */
    const entry = {
      name: nm,
      cols,
      unit,
      feePercent,
      names: (ready ? seats : rows).map((x) => x.name),
    };
    const next = [...presets.filter((x) => x.name !== nm), entry];
    setPresets(next);
    savePresets(next);
    return true;
  };
  const putPartyReg = (reg) => {
    setPartyReg(reg);
    savePartyReg(reg);
  };
  const currentLedger = () =>
    partyLedgerOf({ rname: roundName, mode, unit, cols, rows, log, feePercent, splitMode, memoFreeze, undoSnap });
  /* 새 파티는 카운터 모드로 시작합니다 (사용자 결정) — 들어가서 바꿀 수 있습니다 */
  const blankPartyLedger = (size = 8) => ({
    mode: "items",
    unit,
    cols: DEFAULT_COLS,
    rows: Array.from({ length: size === 4 ? 4 : 8 }, (_, i) => ({
      id: "r" + seq.current++,
      name: FILL_NAME(i + 1),
      counts: {},
      extras: [],
    })),
    log: [],
    feePercent: "5",
    splitMode: "pot",
    memoFreeze: null,
    undoSnap: null,
  });
  /* 슬롯을 화면에 얹습니다 — 파티는 자기가 편집되던 모드를 기억합니다 */
  const applyLedger = (slot) => {
    snapHold.current = true;
    setTab("sheet"); // 파티에 들어가면 기록 화면(벌금표)부터 — 이전 탭을 끌고 가지 않습니다
    /* 이름도 판의 일부입니다 — 지난 판을 열거나 서버 판을 앉힐 때 그 판의 이름으로 */
    setRoundName(slot.rname || defaultRoundName());
    if (slot.mode && slot.mode !== mode) setMode(slot.mode);
    /* 메모장 숫자는 단위 기준 값이라, 단위가 함께 돌아와야 금액이 안 틀어집니다 */
    if (slot.unit && slot.unit !== unit) setUnit(slot.unit);
    setCols(slot.cols);
    setRows(slot.rows);
    setLog(slot.log || []);
    setFeePercent(slot.feePercent || "5");
    setSplitMode(slot.splitMode === "solo" ? "solo" : "pot");
    setMemoFreeze(slot.memoFreeze || null);
    setUndoSnap(slot.undoSnap || null);
    seq.current = Math.max(
      seq.current,
      nextSeq({
        cols: slot.cols,
        rows: slot.rows,
        log: slot.log || [],
        memoFreeze: slot.memoFreeze,
        seats: seatsRef.current,
      })
    );
    setOpenRow(null);
    setBurst([]); // 앞 판에서 누른 것이 새 표 위에 남으면 안 됩니다
    /* 뷰어의 주소에는 방이 적혀 있습니다 — 지우면 새로고침할 때 파티로 못 돌아옵니다 */
    if (!viewer) clearHash();
  };
  /* ---------- 지난 판 이름 짓기 ---------- */
  const uniquePartyName = (base, list) => {
    const l = list || partyReg.list;
    const root = (base || "").trim() || "불러온 파티";
    if (!l.some((x) => x.name === root)) return root;
    for (let i = 2; i < 99; i++) {
      const c = root + " (" + i + ")";
      if (!l.some((x) => x.name === c)) return c;
    }
    return root + " " + Date.now();
  };
  /* 서버 스냅샷 → 장부 한 벌. "지난 판 이어가기"가 이 길로 앉힙니다 */
  const ledgerFromSnapshot = (st) => {
    const f = (st && st.full) || {};
    if (!Array.isArray(f.cols) || !Array.isArray(f.rows)) return null;
    return {
      mode: f.mode || "items",
      unit: f.unit || unit,
      cols: f.cols,
      rows: migrateRows(f.rows),
      log: Array.isArray(f.log) ? f.log : [],
      feePercent: f.feePercent || "5",
      splitMode: f.splitMode === "solo" ? "solo" : "pot",
      memoFreeze: f.memoFreeze || null,
      undoSnap: null,
    };
  };
  const putRelay = (next) => {
    relayRef.current = next;
    setRelay(next);
    if (!tutorialRef.current) saveRelay(next); // 예시 파티(같이 해보기)는 남기지 않습니다 (2026-09-06)
  };
  /* 서버에서 돌아온 값을 얹는 자리는 낡은 클로저 안이라, 늘 최신 relay 를 봅니다 */
  const relayRef = useRef(relay);
  relayRef.current = relay;
  /* 열 켜고 끄기는 연달아 누를 수 있어서, 늘 최신 값에서 뒤집습니다.
     { ...relay } 를 쓰면 같은 틱의 앞 토글이 덮여 사라집니다. */
  /* 합계·순액 — 둘 다 켬이 기본이라 false 만 적어 둡니다 */
  const toggleOvCol = (key) =>
    setRelay((prev) => {
      const ov = { ...(prev.ov || {}) };
      ov[key] = ov[key] === false;
      const next = { ...prev, ov };
      saveRelay(next);
      return next;
    });
  /* 켬은 비움, 끔만 false — sum·net 과 같은 규칙. 슬라이드는 기본 켬이라 기존 사용자도 켜진 채 시작합니다 (2026-09-06 사용자 확정) */
  const setOvFlag = (key, on) =>
    setRelay((prev) => {
      const ov = { ...(prev.ov || {}) };
      if (on) delete ov[key];
      else ov[key] = false;
      const next = { ...prev, ov };
      saveRelay(next);
      return next;
    });
  /* 항목 열 하나 — 꺼진 것만 ov.off 에 적습니다. 옛 'items 한 덩어리로 끔' 설정이
     남아 있으면, 지금 열 전부를 꺼진 상태로 펼쳐 놓고 그 위에서 뒤집습니다. */
  const toggleOvItem = (colId) =>
    setRelay((prev) => {
      const ov = { ...(prev.ov || {}) };
      const off = { ...(ov.off || {}) };
      if (ov.items === false && !ov.off) activeCols.forEach((c) => (off[c.id] = true));
      delete ov.items;
      if (off[colId]) delete off[colId];
      else off[colId] = true;
      ov.off = off;
      const next = { ...prev, ov };
      saveRelay(next);
      return next;
    });
  /* 튜토리얼 시작 — 예시 표를 화면에만 얹습니다. 파티로 만들지 않으니 저장할 것도,
     끝나고 치울 것도 없습니다. 첫 방문이 아니면 보던 장부를 떠 뒀다가 끝날 때 돌려 놓습니다.
     예시도 판입니다 — 자리와 판 표시를 같이 세우지 않으면 홈이 로비로 떨어져서(§3.1)
     코스가 짚는 벌금표가 화면에 없습니다. 끝낼 때 원래 자리로 되돌립니다. */
  /* 같이 해보기 컨트롤러 (2026-09-06). 예시가 도는 동안은 tutorial 이 참이라 저장·밀기·자리·명단·로비 호출이 전부 멈추고,
     끝나면(다 봤든 ✕로 그만뒀든) 열기 전 상태로 돌아갑니다 */
  const partyTimers = useRef([]);
  const partyT = (fn, ms) => {
    const t = setTimeout(fn, ms);
    partyTimers.current.push(t);
    return t;
  };
  const partyStep = (i) => setCoach({ kind: "party", step: i });
  const [tutAsk, setTutAsk] = useState(() => !coachSeen("partyAsk") && !cameByInvite());
  /* 부모 앱: [같이 해보기]·[?] [시작]은 예시 앱을 전체 화면 iframe 으로 엽니다. 끝·그만두기는 예시 앱이 postMessage 로 알립니다 */
  const [demoOpen, setDemoOpen] = useState(false);
  const [demoReady, setDemoReady] = useState(false); // 예시 앱이 첫 그림을 그렸다고 알려 올 때까지 iframe 은 투명 — 흰 화면이 깜빡이지 않게
  const demoBase = typeof window !== "undefined" ? window.location.origin + window.location.pathname : "";
  const [demoSrc, setDemoSrc] = useState(""); // A: #demo(방장 1~3장·5~8장) / #demo&member(독립 파티원 튜토리얼)
  const [demoLoad, setDemoLoad] = useState("튜토리얼을 시작하는 중이에요."); // 사용자 지정 문구(2026-09-06); 4장으로 넘어갈 땐 실리안의 화면
  /* B: 4장 파티원 예시(#demo&member&ch4) — A 위에 얹혔다가 끝나면 걷힙니다. A 는 그동안 그대로 살아 있어 돌아오면 이어 갑니다
     (2026-09-06 낮 사용자 확정 "1안"; (폐기) 8장으로 갈아 끼우던 demoPrev — 옛 화면을 걷어 버려 돌아올 수 없었음) */
  const [demoTop, setDemoTop] = useState("");
  const [demoTopReady, setDemoTopReady] = useState(false);
  const demoARef = useRef(null);
  const demoBRef = useRef(null);
  /* 불러오는 문구의 규칙 (2026-09-06 낮 사용자 확정): 350ms 안에 예시 앱이 준비되면 문구를 아예 안 보이고 바로 번져 들어오고,
     문구가 떴으면 800ms 는 두고 걷습니다 — 읽히기 전에 사라지면 안내가 아니라 깜빡임. A(방장/독립 파티원)와 B(4장) 각각 */
  const [demoOn, setDemoOn] = useState(false); // A iframe 이 보이는지 (ready 와는 별개 — 문구 최소 유지 때문)
  const [demoLoadShown, setDemoLoadShown] = useState(false);
  const demoLoadAt = useRef(0);
  const demoReadyRef = useRef(false);
  demoReadyRef.current = demoReady;
  useEffect(() => {
    if (!demoOpen || !demoSrc) return;
    setDemoOn(false);
    setDemoLoadShown(false);
    demoLoadAt.current = 0;
    /* 예시 앱이 뜨는 동안 부모 스레드가 막혀 타이머가 늦게 깨는데, 그때 준비 알림도 같은 줄에 서 있습니다 — 40ms 만 더 두고
       그 사이 알림이 왔으면 문구 없이 (아니면 준비된 순간 문구가 떠서 800ms 를 괜히 붙듭니다) */
    let t2 = 0;
    const t = setTimeout(() => {
      if (demoReadyRef.current) return; // 이미 준비됐으면 문구 없이
      t2 = setTimeout(() => {
        if (demoReadyRef.current) return;
        setDemoLoadShown(true);
        demoLoadAt.current = Date.now();
      }, 40);
    }, 350);
    return () => {
      clearTimeout(t);
      clearTimeout(t2);
    };
  }, [demoOpen, demoSrc]);
  useEffect(() => {
    if (!demoOpen || !demoReady || demoOn) return;
    const wait = demoLoadAt.current ? Math.max(0, 800 - (Date.now() - demoLoadAt.current)) : 0;
    const t = setTimeout(() => setDemoOn(true), wait);
    return () => clearTimeout(t);
  }, [demoOpen, demoReady, demoOn]);
  const [demoTopOn, setDemoTopOn] = useState(false);
  const [demoTopLoadShown, setDemoTopLoadShown] = useState(false);
  const demoTopLoadAt = useRef(0);
  const demoTopReadyRef = useRef(false);
  demoTopReadyRef.current = demoTopReady;
  useEffect(() => {
    if (!demoTop) return;
    setDemoTopOn(false);
    setDemoTopLoadShown(false);
    demoTopLoadAt.current = 0;
    let t2 = 0;
    const t = setTimeout(() => {
      if (demoTopReadyRef.current) return;
      t2 = setTimeout(() => {
        if (demoTopReadyRef.current) return;
        setDemoTopLoadShown(true);
        demoTopLoadAt.current = Date.now();
      }, 40);
    }, 350);
    return () => {
      clearTimeout(t);
      clearTimeout(t2);
    };
  }, [demoTop]);
  useEffect(() => {
    if (!demoTop || !demoTopReady || demoTopOn) return;
    const wait = demoTopLoadAt.current ? Math.max(0, 800 - (Date.now() - demoTopLoadAt.current)) : 0;
    const t = setTimeout(() => setDemoTopOn(true), wait);
    return () => clearTimeout(t);
  }, [demoTop, demoTopReady, demoTopOn]);
  const startPartyCourse = () => {
    if (DEMO) return;
    setDemoReady(false);
    setDemoLoad("튜토리얼을 시작하는 중이에요.");
    setDemoTop("");
    setDemoTopReady(false);
    setDemoSrc(demoBase + "#demo&t=" + Date.now()); // t 는 같은 주소로 다시 열어도 새로 뜨게
    setDemoOpen(true);
  };
  /* 파티원 튜토리얼 — 파티원 예시 앱 하나로 (2026-09-06 사용자 확정: [?]에서 둘 중 고름, 어디서든) */
  const startMemberTour = () => {
    if (DEMO) return;
    setDemoReady(false);
    setDemoLoad("튜토리얼을 시작하는 중이에요.");
    setDemoTop("");
    setDemoTopReady(false);
    setDemoSrc(demoBase + "#demo&member&t=" + Date.now());
    setDemoOpen(true);
  };
  /* 예시 앱이 못 뜨더라도 갇히지 않게 — 8초 뒤엔 있는 그대로 보입니다 */
  useEffect(() => {
    if (!demoOpen || demoReady) return;
    const t = setTimeout(() => setDemoReady(true), 8000);
    return () => clearTimeout(t);
  }, [demoOpen, demoReady]);
  useEffect(() => {
    if (!demoTop || demoTopReady) return;
    const t = setTimeout(() => setDemoTopReady(true), 8000);
    return () => clearTimeout(t);
  }, [demoTop, demoTopReady]);
  const closeDemo = (done, kind) => {
    setDemoOpen(false);
    coachDone("partyAsk");
    setTutAsk(false);
    if (done) coachDone(kind === "member" ? "mtour" : "party");
  };
  useEffect(() => {
    if (!demoOpen) return;
    const el = document.documentElement;
    const prev = el.style.overflow;
    el.style.overflow = "hidden"; // 창이 떠 있는 동안 부모는 스크롤하지 않습니다 — 스크롤바가 둘 보였음
    return () => {
      el.style.overflow = prev;
    };
  }, [demoOpen]);
  useEffect(() => {
    if (DEMO) return;
    const on = (e) => {
      if (e.origin !== window.location.origin || !e.data) return;
      if (e.data.gs === "party-demo-ready") {
        /* 어느 예시 앱이 그렸는지는 보낸 창으로 가립니다 */
        /* ref 는 즉시 — 문구 타이머가 렌더보다 먼저 깰 수 있어서 */
        if (demoBRef.current && e.source === demoBRef.current.contentWindow) {
          demoTopReadyRef.current = true;
          setDemoTopReady(true);
        } else {
          demoReadyRef.current = true;
          setDemoReady(true);
        }
        return;
      }
      if (e.data.gs !== "party-demo") return;
      if (e.data.next === "member") {
        /* 3장이 끝났습니다 — 방장 예시(A)는 그대로 두고 그 위에 파티원 예시(B, 4장)를 얹습니다. 그릴 때까지 A 위에 작은 칩 */
        setDemoLoad("실리안의 화면을 불러오는 중이에요."); // 파티원 중 한 명의 화면이라 이름을 그대로 (2026-09-06 사용자)
        setDemoTopReady(false);
        setDemoTop(demoBase + "#demo&member&ch4&t=" + Date.now());
        return;
      }
      if (e.data.next === "host") {
        /* 4장이 끝났습니다 — B 를 번져 걷고 A 에게 이어 가라고 알립니다 */
        setDemoTopOn(false);
        setDemoTopReady(false);
        setTimeout(() => setDemoTop(""), 450);
        try {
          if (demoARef.current && demoARef.current.contentWindow) demoARef.current.contentWindow.postMessage({ gs: "party-demo-resume" }, window.location.origin);
        } catch (x) {}
        return;
      }
      closeDemo(!!e.data.done, e.data.kind);
    };
    window.addEventListener("message", on);
    return () => window.removeEventListener("message", on);
  }, []);
  /* 걸음의 표적이 같은 렌더에서 막 생기는 중이면(웨이 줄처럼 명단과 걸음이 한 틱에 바뀜) 그 렌더의
     querySelector 는 못 보고, 예시 앱은 서버 응답이 없어 다시 그려질 계기도 없습니다 — 표적이 보일 때까지 살핍니다 */
  useEffect(() => {
    if (!coach || coach.kind !== "party") return;
    const st = TOUR_FLOW[coach.step];
    if (!st) return;
    /* 표적이 있어도 이번 렌더가 못 봤으면(같은 커밋에 생김) 말풍선이 없습니다 — 그때도 다시 그립니다 */
    const drawn = () => !!document.querySelector(".gs-coach");
    if (document.querySelector(st.sel) && drawn()) return;
    const t = setInterval(() => {
      if (!document.querySelector(st.sel)) return;
      clearInterval(t);
      if (!drawn()) setCoach((c) => (c ? { ...c } : c));
    }, 150);
    return () => clearInterval(t);
  }, [coach]);
  /* 예시 앱: 첫 그림을 그린 뒤 부모에게 알리고(그때 iframe 이 보입니다), 곧 첫 걸음.
     알림은 타이머로 — rAF 는 탭이 안 보이면 아예 안 돌아서(2026-09-06 낮 운영 빌드 측정: 19.7초 뒤 도착, 그동안 8초 안전장치가 켬)
     부모의 문구가 8초 동안 남았습니다. 번짐(.35초)이 있어 첫 그림을 굳이 기다릴 필요가 없습니다 */
  useEffect(() => {
    if (!DEMO) return;
    const r = setTimeout(() => {
      try {
        if (window.parent && window.parent !== window) window.parent.postMessage({ gs: "party-demo-ready" }, window.location.origin);
      } catch (e) {}
    }, 0);
    const t = setTimeout(() => partyStep(0), 900);
    return () => {
      clearTimeout(r);
      clearTimeout(t);
    };
  }, []);
  /* newBoard 의 로컬 부분만 — 로비를 열지도 코드를 내지도 않습니다. 정원 4, 이름은 예시 파티 */
  const tutNewBoard = () => {
    setRoundName("예시 파티");
    setCols(DEFAULT_COLS.filter((c) => !isRoulette(c))); // 튜토리얼 판은 잡힘·죽음 둘로 시작 — 룰렛은 튜토리얼에서 뺌 (2026-09-06 낮 사용자)
    setLog([]);
    setUndoSnap(null);
    setMemoFreeze(null);
    setOpenRow(null);
    setRoundId("");
    setRoundLive(false);
    setPaused(null);
    setMembers([]);
    putSeats((prev) => prev.filter((s0, i) => i === 0 && !!s0.acct));
    setLobbyCap(4);
    setLobbyOn(true);
    boardOnRef.current = true;
    putRelay({ ...relayRef.current, boardOn: true, lobbyCap: 4 });
    go(VIEW_BOARD);
  };
  /* 더미 파티원 — 명단에 st:"ok"·rowId 없음으로 넣으면 시작 전 규칙대로 앱이 첫 빈 자리에 앉힙니다(앉음 강조·토스트 그대로).
     진행 중이면 표 아래에 서서 [받기]를 기다립니다 */
  const tutArrive = (i) => setMembers((p) => (p.some((m) => m.acct === TUT_MEMBERS[i].acct) ? p : [...p, { ...TUT_MEMBERS[i], st: "ok", rowId: null, on: true }]));
  const tutConfess = () => {
    const seat = seatsRef.current.find((k) => k.acct === TUT_MEMBERS[0].acct);
    const col = cols.find((c) => !isRoulette(c));
    if (!seat || !col) return;
    applyConfess(seat.id, col.id, 1);
    say(TUT_MEMBERS[0].nick + "이 자수했어요 — 파티원이 누른 건 이렇게 올라와요.", 8000);
  };
  const tutHit = (what) => {
    const c = coachRef.current;
    if (!tutorialRef.current || !c || c.kind !== "party") return;
    const st = TOUR_FLOW[c.step];
    if (!st || st.wait !== what) return;
    const next = c.step + 1;
    partyStep(next);
    if (what === "link") {
      partyT(() => tutArrive(0), 1800);
      partyT(() => tutArrive(1), 3400);
      partyT(() => setCoach((c) => (c && c.kind === "party" ? { ...c, ready: true } : c)), 4400); // 둘이 앉고 한 박자 → [다음] 등장 (자동 넘김 없음)
    }
    /* (폐기 2026-09-06 낮) "confess:c2" 2.2초 뒤 자동 — `방장 벌금판에 바로 올라갔어요.`는 다음 말풍선에 합쳤습니다 */
    /* (폐기 2026-09-06 낮) "press" 3초 뒤 실리안 자수 타이머 — 이제 실리안의 잡힘은 4장(파티원 화면)에서 누르고 방장 화면으로 돌아올 때 올라옵니다 */
  };
  /* 5장 머리 — 한 판 돌았다고 치고 표를 채웁니다. 숫자는 옛 벌금판 예시(DEFAULT_PEOPLE)를 이름만 바꿔 그대로:
     앞 넷은 방장·실리안·니나브·웨이(3·2 / 11·1 / 2·10 / 8·1), 뒤 넷(주키니·포셔·티모·이다)은 그 사이 들어온 것으로 새 줄에
     앉히고 채웁니다 — 정산 예시는 여덟 명 (2026-09-06 사용자). 셋째 열(옛 암살)은 지금은 룰렛이라 뺍니다.
     방장 줄은 진짜 누르기(pressCell), 파티원 줄은 자수(applyConfess)라 기록도 그대로 남습니다 */
  const tutSeed = () => {
    const c1 = cols.find((c) => c.id === "c1");
    const c2 = cols.find((c) => c.id === "c2");
    const c3 = cols.find((c) => c.id === "ctut"); // 2장에서 만든 암살 열 — 옛 예시의 셋째 열(10만)이라 숫자를 그대로 씁니다
    if (!c1 || !c2) return;
    const host = rows[0];
    const rowOf = (acct) => {
      const k = seatsRef.current.find((s0) => s0.acct === acct);
      return k && rows.find((r) => r.id === k.id);
    };
    const targets = [
      [host, null],
      [rowOf("silian"), "silian"],
      [rowOf("ninav"), "ninav"],
      [rowOf("wei"), "wei"],
    ];
    let t = 0;
    const tick = () => (t += 40);
    targets.forEach(([row, acct], i) => {
      if (!row) return;
      const [, want1, want2, want3] = DEFAULT_PEOPLE[i];
      const more1 = Math.max(0, want1 - num(row.counts.c1));
      const more2 = Math.max(0, want2 - num(row.counts.c2));
      const more3 = c3 ? Math.max(0, want3 - num(row.counts.ctut)) : 0;
      const hit = (col) => (acct ? () => applyConfess(row.id, col.id, 1) : () => pressCell(row, col, 1));
      for (let k = 0; k < more1; k++) partyT(hit(c1), tick());
      for (let k = 0; k < more2; k++) partyT(hit(c2), tick());
      for (let k = 0; k < more3; k++) partyT(hit(c3), tick());
    });
    /* 넷이 더 — 자리·줄·명단을 한 번에 함수형으로 더합니다. seatMember/applyConfess 는 이 렌더의 rows 를 닫아 둔 클로저라
       타이머에서 잇달아 부르면 서로를 덮습니다(첫 시도의 사고). 새 줄의 숫자는 바로 적습니다 — 캐시가 없어 표가 그대로 셉니다 */
    const extras = TUT_EXTRA.map((m, i) => ({ ...m, id: "r" + seq.current++, want: DEFAULT_PEOPLE[4 + i] }));
    partyT(() => {
      putSeats((prev) => [...prev, ...extras.map((e) => ({ id: e.id, name: e.nick, acct: e.acct, mem: e.acct, named: false, nick: e.nick }))]);
      setRows((prev) => [
        ...prev,
        ...extras.map((e) => ({ id: e.id, name: e.nick, counts: { c1: e.want[1] ? String(e.want[1]) : "", c2: e.want[2] ? String(e.want[2]) : "", ...(c3 && e.want[3] ? { ctut: String(e.want[3]) } : {}) }, extras: [] })),
      ]);
      setMembers((p) => [...p, ...extras.filter((e) => !p.some((x) => x.acct === e.acct)).map((e) => ({ acct: e.acct, nick: e.nick, st: "ok", rowId: e.id, on: true }))]);
    }, tick());
  };
  /* 걸음에 들어설 때 하는 일 — 웨이 도착(4장 사람 아이콘 걸음), 판 채우기(5장 머리) */
  const tutEntered = useRef(-1);
  useEffect(() => {
    if (!coach || coach.kind !== "party" || tutEntered.current === coach.step) return;
    tutEntered.current = coach.step;
    const st = TOUR_FLOW[coach.step];
    if (!st) return;
    /* 2장을 떠날 때 — 이름·단가를 안 적고 지나왔으면 암살·10만으로 채웁니다. 5장 채우기 직전에 하면 그 렌더의 타이머 클로저가
       옛 단가(1만)를 써서 실리안의 암살 2회가 2만으로 잡혔습니다(첫 시도의 사고) */
    if (st.enter === "colfix") setCols((prev) => prev.map((c) => (c.id === "ctut" ? { ...c, name: c.name || "암살", price: c.price === "10,000" ? "100,000" : c.price } : c)));
    /* (폐기 2026-09-06 낮) enter:"handoff" — 걸음에 들어서자마자 파티원 예시를 얹던 것. 지금은 [실리안의 화면 보기]를 눌러야(onNext) */
    if (st.enter === "wei") {
      tutArrive(2);
      say(TUT_MEMBERS[2].nick + "님이 들어왔어요 — 표 아래에서 받아 주세요.", 8000);
    }
    if (st.enter === "seed") {
      partyT(tutSeed, 300);
      partyT(() => setCoach((c) => (c && c.kind === "party" ? { ...c, ready: true } : c)), 4500); // 채우기 끝 → [다음] 등장 (서른여덟 번 누르는 데 1.5초, 넷 더 앉히고, 한 박자)
    }
  }, [coach]);
  /* 4장(파티원 예시)이 끝나 방장 예시로 돌아올 때 — 실리안이 거기서 누른 잡힘 1이 그제야 올라오고(토스트도 진짜처럼) 5장으로.
     리스너는 첫 렌더의 클로저라 최신 tutConfess·걸음은 ref 로 봅니다 */
  const resumeRef = useRef(null);
  resumeRef.current = () => {
    window.scrollTo(0, 0); // 돌아올 땐 맨 위부터 (2026-09-06 낮 사용자)
    tutConfess();
    partyStep((coachRef.current ? coachRef.current.step : 0) + 1);
  };
  useEffect(() => {
    if (!DEMO || DEMO_MEMBER) return;
    const on = (e) => {
      if (e.origin !== window.location.origin || !e.data || e.data.gs !== "party-demo-resume") return;
      resumeRef.current();
    };
    window.addEventListener("message", on);
    return () => window.removeEventListener("message", on);
  }, []);
  /* 예시 앱: 끝(다 봤든 ✕·Esc·[그만두기]든) — 부모에게 알리고 부모가 창을 닫습니다. 부모 없이 열렸으면 보통 앱으로 */
  const endPartyCourse = (done) => {
    partyTimers.current.forEach(clearTimeout);
    partyTimers.current = [];
    setCoach(null);
    if (window.parent && window.parent !== window) {
      try {
        /* done: true = 다 봄, "member" = 방장 부분 끝, 파티원 화면으로, false = 그만둠 */
        /* next: "member" = 방장 예시 3장 끝, 파티원 예시(4장)를 위에 얹어 달라 / "host" = 파티원 예시 4장 끝, 방장 예시로 돌아가 달라 */
        window.parent.postMessage({ gs: "party-demo", done: done === true, next: done === "member" ? "member" : done === "host" ? "host" : null, kind: DEMO_MEMBER && !DEMO_CH4 ? "member" : "host" }, window.location.origin);
      } catch (e) {}
      return;
    }
    window.location.replace(window.location.pathname + window.location.search);
  };
  /* (폐기 2026-09-06) startTutorial/endTutorial — 예시 표를 진짜 장부 위에 덮고 되돌리던 옛 코스 */

  // 고칠 때마다 저장해 두면 새로고침해도 그대로 돌아옵니다
  useEffect(() => {
    // 첫 선택 전엔 저장하지 않습니다 — 선택 없이 새로고침하면 선택 화면이 다시 나오게
    if (intro === "first") return;
    // 예시는 구경거리라 남기지 않습니다 — 저장하면 지난 판에 끼고, 치우는 건 사용자 몫이 됩니다
    if (tutorial) return;
    // 뷰어는 남의 장부를 비추는 중이라, 이 브라우저에 저장하면 내 장부를 덮어씁니다
    if (readOnly) return;
    markSeen();
    savePartySlot(partyReg.active, partyLedgerOf({ rname: roundName, mode, unit, cols, rows, log, feePercent, splitMode, memoFreeze, undoSnap }));
    saveState({
      roundName,
      cols,
      rows,
      feePercent,
      splitMode,
      mode,
      unit,
      memoFont,
      view,
      tab,
      log,
      undoSnap,
      memoFreeze,
      theme,
      roundLive,
      roundId,
      roundPaused: !!paused,
      seats,
    });
  }, [cols, rows, feePercent, splitMode, mode, unit, memoFont, view, tab, log, undoSnap, memoFreeze, theme, intro, tutorial, readOnly, partyReg.active, roundLive, roundId, paused, seats, roundName]);

  /* 방장으로서 밀어 올릴 수 있는 상태인지 — 로그인 + 내 방 */
  const canPush = !readOnly && !!auth && !!relay.room && !tutorial; // 예시 파티는 밀지 않습니다 (2026-09-06)
  /* 판의 준비 상태 (§3.1, 2026-09-05) — 시작 전 벌금표입니다. 옛 로비 화면(2열 벤토)은
     폐지됐고, 칸은 잠기고 [시작]이 유일한 채운 버튼이며 표 위에 모집 카드가 섭니다.
     홈은 §3.0 로비입니다 */
  const ready = !readOnly && !roundLive;
  /* 로비(홈, §3.0) — 라우트 상태. 브랜드 클릭·[나가기]·끝난 판 [닫기]가 문입니다 */
  const [atLobby, setAtLobby] = useState(!!boot.current.atLobby);
  /* 도착(주소가 비어 있던 부트)에서만 "앉은 파티 → 그 파티" 자동 입장을 합니다 (§3.0). 주소에 화면이
     적혀 있으면(새로고침·뒤로가기·브랜드로 온 로비) 그 화면을 지킵니다 — 옛 gs-home 표시의 자리 */
  const arrival = useRef(!(boot.current.route && boot.current.route.view));
  /* 판 존재 표시의 최신값 (2026-09-06 모델) — 화면 이동 판정이 렌더 밖에서 봅니다 */
  const boardOnRef = useRef(false);
  const [meSeat, setMeSeat] = useState(null); // 서버가 아는 내 자리 {st, live, round} — 로비 복귀 줄 (round = 진행 중, 2026-09-06)
  const showLobby = atLobby && !viewer && !genView;
  /* 판을 두고 나온 상태 (§3.0, 2026-09-05) — 헤더 칩과 로비 카드의 진행 중 얼굴이 이걸로 섭니다 */
  const liveAway = !readOnly && roundLive && (showLobby || !!genView);
  /* 시작 전 판을 두고 나온 상태 (2026-09-06) — 헤더 칩 `모집 중 · 대기실로` */
  const readyAway = !readOnly && !roundLive && !!(relay && relay.boardOn) && (showLobby || !!genView);
  /* 파티원도 자기가 방에 있다는 표시 (2026-09-06 사용자: 자동 복귀 대신) — 판 화면이 아닐 때 같은 칩 */
  const memberAway = !readOnly && (showLobby || !!genView) && !!meCur && !!(meSeat && meSeat.st === "ok");
  /* 서버가 아는 내 자리 — 남의 파티에 앉아 있는지 (2026-09-07: 허브·칩·새 판 만들기 물음이 씁니다) */
  const seatedNow = !!(meCur && meSeat && meSeat.st === "ok");
  const seatedName = (() => {
    const k = seatedNow ? loadLastLive() : null;
    return k && k.room === meCur && k.host ? k.host + "네 파티" : "참여 중인 파티";
  })();
  const memberPartyName = seatedName;
  /* 화면 이동은 전부 여기로 (2026-09-05) — 주소에 적고 history 에 한 장 얹으면 hashchange 가 화면을
     정합니다. 뷰어에서 로비·판으로 가면 파티 열쇠가 걷혀 모드가 갈리므로 그 핸들러가 다시 엽니다.
     주소를 못 가지는 환경(iframe)에서는 상태만 바꿉니다 */
  const applyRoute = (r) => {
    if (r.view === "gen") {
      if (r.gen && r.gen !== genView) openGenInner(r.gen);
      return;
    }
    if (genView) closeGenInner();
    if (r.view === VIEW_LOBBY) setAtLobby(true);
    /* 판이 없으면 판 화면도 없습니다 (2026-09-06 모델) — 로비로 */
    else if (r.view === VIEW_BOARD) setAtLobby(!boardOnRef.current && !readOnly);
  };
  const go = (view, gen, opts) => {
    if (!canOwnUrl || typeof window === "undefined") return applyRoute({ view, gen: gen || null });
    const next = routeHash(view, gen);
    const cur = window.location.hash.replace(/^#/, "");
    if (next === cur) return applyRoute({ view, gen: gen || null });
    if (opts && opts.replace) {
      const { pathname, search } = window.location;
      window.history.replaceState(null, "", pathname + search + (next ? "#" + next : ""));
      applyRoute({ view, gen: gen || null });
      return;
    }
    window.location.hash = next; // hashchange → applyRoute (뷰어면 모드가 갈려 리로드)
  };
  const goBoard = () => go(VIEW_BOARD);
  /* 뷰어에서 로비로 — 자리를 버리는 길(나가기·끝난 판 닫기·로그아웃)은 그 장소가 사라지는 것이라
     history 를 갈아 끼웁니다(replace): 뒤로가기가 없어진 파티로 돌아가지 않게. 뷰어인지는 부트가
     정하므로 다시 엽니다 */
  const leaveToLobby = () => {
    if (typeof window === "undefined") return;
    const { pathname, search } = window.location;
    window.history.replaceState(null, "", pathname + search + "#" + routeHash(VIEW_LOBBY));
    window.location.reload();
  };
  /* 로비 도착 한 줄 (§8 초안) — 나가기·끝남으로 돌아온 사람에게 */
  useEffect(() => {
    if (viewer) return;
    try {
      if (sessionStorage.getItem("gs-left") === "1") {
        sessionStorage.removeItem("gs-left");
        say("파티에서 나왔어요.");
      }
      const h = sessionStorage.getItem("gs-ended");
      if (h !== null) {
        sessionStorage.removeItem("gs-ended");
        say((h ? h + "네 파티가" : "파티가") + " 끝났어요 — 결과는 판 기록에 남았어요.");
      }
    } catch (e) {}
  }, []);
  const [nameEdit, setNameEdit] = useState(false); // 마스트의 판 이름 편집 중
  const [gensOpen, setGensOpen] = useState(false); // 판 기록 창
  const [revealInv, setRevealInv] = useState(false); // 모집 카드의 초대 링크 가림 해제
  const [capDraft, setCapDraft] = useState(null); // 인원 수 숫자 칸 — 떠날 때 확정
  const [justEnded, setJustEnded] = useState(null); // 방금 끝낸 판의 기록 이름 — 결과 화면 경유
  /* 인원 수 숫자 칸 — 치는 동안은 그대로 두고, 떠나거나 엔터일 때 확정합니다.
     칸에 두 자리를 치는 중간값(1)으로 명단이 출렁이면 안 됩니다 */
  const commitCap = () => {
    if (capDraft === null) return;
    putCap(capDraft);
    setCapDraft(null);
  };

  useEffect(() => {
    // 방을 이미 만들어 본 사람은 OBS 공유를 아는 사람입니다
    if (!readOnly && relay.room) coachDone("obsScribe");
  }, []);

  /* ================= 계정 ================= */
  /* 로그인 직후 이어서 할 일(after)은 로그인 전 클로저라 auth 가 낡아 있습니다 —
     거울을 하나 두고 그때그때 최신 계정을 봅니다 */
  const authRef = useRef(null);
  authRef.current = auth;
  const putAuth = (v) => {
    setAuth(v);
    saveAuth(v);
  };
  /* 로그인이 필요한 자리에서 부릅니다 — 끝나면 하려던 일을 이어서 합니다.
     ctx 는 "왜 지금 계정을 묻는지"입니다. 끼어든 창은 이유를 말해야 하고,
     헤더에서 스스로 연 창은 말할 이유가 없어서 비워 둡니다. */
  const openAuth = (tab, after, ctx) =>
    setAuthOpen({ tab: tab || "login", after: after || null, ctx: ctx || null });
  /* 방송용 주소를 받은 직후 — 방까지 같이 팝니다. 방이 없으면 그 주소는 비출 판이
     없어서 받자마자 검은 화면이 됩니다. "주소 받기"를 누른 사람이 바라는 것은 주소
     문자열이 아니라 방송에 뜨는 판입니다.
     계정을 만드는 일 자체는 게스트 문(AuthModal)이 합니다 (§3.11) — 예전에는 여기서
     조용히 만들어서 닉을 못 받았고, 그래서 모두가 `방장`이라는 이름으로 앉았습니다. */
  const [obsFresh, setObsFresh] = useState(false);
  const openMyRoom = async (done) => {
    const a = authRef.current;
    if (!a) return;
    /* "주소가 나왔어요"는 방금 만든 계정에만 — 로그인으로 돌아온 사람의 주소는
       나온 게 아니라 원래 있던 것입니다 */
    setObsFresh(!(done && done.via === "login"));
    const room = await roomApi.myRoom(a.token);
    putRelay({
      ...relayRef.current,
      room: room.roomId,
      invite:
        room.invite && room.invite.code
          ? { code: room.invite.code, exp: room.invite.exp }
          : relayRef.current.invite,
      on: true,
    });
  };
  /* 익명 계정에 진짜 아이디·비밀번호·닉네임을 붙입니다. 세션도 방송용 주소도 그대로라
     다시 로그인하지 않습니다 — 저장해 둔 계정의 id·nick 만 갈아 끼웁니다 (§3-11) */
  const doUpgrade = async (id, pw, nick) => {
    const a = authRef.current;
    if (!a) return;
    const r = await authApi.upgrade(a.token, id, pw, nick);
    putAuth({ ...a, id: r.id || id, nick: r.nick || nick, anon: false });
  };
  const doLogout = async (dropSeat) => {
    if (auth) {
      /* 게스트는 돌아올 길이 없어 자리도 함께 비웁니다 (§3.11) — 주인이 영영 못 오는 자리를
         남기지 않습니다. 정식 계정은 자리를 두고 나갑니다(아이디가 기억됩니다, §3.2) */
      const room = liveRoom || meCur;
      if (dropSeat && room) await roomApi.leave(auth.token, room).catch(() => {});
      await authApi.logout(auth.token).catch(() => {});
    }
    putAuth(null);
    setMembers([]);
    setLobbyOn(false);
    /* 자리에 붙어 있던 계정을 뗍니다 — 아이디는 남겨 두어 다시 로그인하면 그 자리로 돌아옵니다 */
    putSeats((prev) => prev.map((s) => (s.acct ? { ...s, acct: null } : s)));
    putRelay({ ...relay, room: undefined, invite: undefined, on: false });
    setBackCard(null);
    /* 로그아웃한 사람의 자리는 로비입니다 (§3.4 여정표) — 뷰어면 해시를 걷고 다시 엽니다 */
    if (viewer) {
      saveLastLive(null);
      leaveToLobby();
      return;
    }
    go(VIEW_LOBBY);
  };
  /* [로그아웃] — 게스트에겐 사실상 계정 버리기라 한 번 묻습니다 (§3.11, 2026-09-05).
     문구는 §8 초안 */
  const askLogout = () => {
    if (!auth) return;
    if (!auth.anon) return doLogout(false);
    setAsk({
      title: "게스트 계정은 로그아웃하면 다시 못 들어와요",
      body: "아이디를 정하면 어디서든 로그인할 수 있어요. 지금 로그아웃하면 이 계정과 파티 자리를 버려요.",
      action: "그래도 로그아웃",
      tone: "danger",
      alt: { label: "아이디 만들기", onPick: () => setUpOpen({}) },
      onYes: () => doLogout(true),
    });
  };
  /* /me 한 벌을 화면에 얹습니다 — 함께한 사람·대기 중인 지목 초대·지금 들어가 있는 방.
     같은 응답이 "내가 앉아 있는 방의 판이 다시 살아났는지"도 알려 줍니다 (§3.4).
     정산이 끝난 뒤 [닫기]로 자기 앱에 돌아온 사람은 그 방 명단에 그대로 남아 있어서,
     방장이 다시 시작하면 돌아갈 문이 필요합니다 — 화면을 잡아채지 않고 카드로 (§8) */
  const takeMe = (m) => {
    if (!m || !m.id) return;
    setMates(Array.isArray(m.mates) ? m.mates : []);
    setInvites(Array.isArray(m.invites) ? m.invites : []);
    setMeCur(m.cur || null);
    const seat = m.seat || null;
    setMeSeat(seat);
    /* 도착 규칙 (§3.0): 앉은 파티가 있으면 그 파티로. 브랜드로 일부러 로비에 온 세션은
       건너뛰고(§5.1), 그때는 아래 카드와 로비의 복귀 줄이 문입니다 */
    if (
      !viewer &&
      m.cur &&
      seat &&
      seat.st === "ok" &&
      arrival.current &&
      /* 내 판이 있으면 남의 파티로 잡아채지 않습니다 (방 하나 규칙, 2026-09-07) — 허브가 두 곳을 다 보여 줍니다 */
      !boardOnRef.current
    ) {
      arrival.current = false;
      /* 방장은 자기 방 명단(members)에 없어 seat 가 비므로, 이 조건은 남의 방에 앉은 사람만 통과합니다 —
         내 방 id(relay.room)를 모르는 새 기기·게스트에서도 그대로 맞습니다 */
      enterRoom(m.cur);
      return;
    }
    setBackCard(
      !viewer &&
        m.cur &&
        seat &&
        seat.st === "ok" &&
        seat.live &&
        relayRef.current.room !== m.cur
        ? { room: m.cur }
        : null
    );
  };
  /* 지금 한 번 더 봅니다 — 수락처럼 서버 쪽 관계가 방금 바뀐 자리에서 부릅니다 */
  const refreshMe = () => {
    const a = authRef.current;
    if (!a) return;
    authApi
      .me(a.token)
      .then(takeMe)
      .catch(() => {
        /* 못 읽어도 화면은 그대로 둡니다 */
      });
  };
  /* 세션은 90일이고 쓸 때마다 연장됩니다 — 열 때 한 번 확인해서 닉·OBS 토큰도 맞춥니다.
     같은 응답이 함께한 사람과 대기 중인 지목 초대를 실어 옵니다 (§3.3) — 그래서
     창에 초점이 돌아올 때도 한 번 더 봅니다("초대 쐈어, 받아" → 알트탭 → 그 순간).
     서버가 없거나 끊겨 있으면 조용히 지나갑니다(방송 화면에 에러를 그리지 않습니다). */
  useEffect(() => {
    if (!auth) {
      setMates([]);
      setInvites([]);
      return;
    }
    let gone = false;
    let lookedAt = 0;
    const look = () => {
      if (gone) return;
      /* 초점과 화면 복귀는 붙어서 오는 일이 잦습니다 — 한 번의 알트탭에 요청이 둘씩
         나가지 않게 잠깐 겹치는 것만 접습니다. 주기적으로 도는 것은 여전히 없습니다 */
      const now = Date.now();
      if (now - lookedAt < 1500) return;
      lookedAt = now;
      authApi
        .me(auth.token)
        .then((m) => {
          if (gone) return;
          takeMe(m);
        })
        .catch(() => {
          /* 못 읽어도 화면은 그대로 둡니다 — 다음 초점 때 다시 봅니다 */
        });
    };
    /* 창에 초점이 돌아올 때와 화면이 다시 보일 때 — 그 둘이 "지금 확인할 때"입니다.
       숨은 화면인지는 visibilitychange 만 따집니다: 초점이 왔다는 것은 이미 보고 있다는
       뜻이고, 여기서 한 번 더 물으면 확인해야 할 바로 그때를 놓칩니다 */
    const onFocus = () => look();
    const onVisible = () => {
      if (document.visibilityState !== "hidden") look();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);
    authApi
      .me(auth.token)
      .then((m) => {
        if (gone || !m || !m.id) return;
        putAuth({
          ...auth,
          id: m.id,
          nick: m.nick || auth.nick,
          obsToken: m.obsToken || auth.obsToken,
          anon: !!m.anon,
        });
        takeMe(m);
        /* 오버레이 외형은 계정에 저장돼 있습니다 — 새 기기에서 로그인해도 제 외형으로 돌아옵니다.
           저장해 둔 것이 없으면 이 브라우저 값을 그대로 두고, 아래 저장 효과가 올려 줍니다 */
        if (m.look && typeof m.look === "object" && typeof m.look.t === "string") {
          const lk = lookIn(m.look);
          lookSent.current = JSON.stringify(m.look);
          if (!sameLook(lk, relayRef.current.look)) putRelay({ ...relayRef.current, look: lk });
        }
      })
      .catch((e) => {
        /* 세션이 죽었을 때만 지웁니다 — 네트워크 사고로 로그아웃되면 안 됩니다 */
        if (!gone && e && e.status === 401) putAuth(null);
      });
    return () => {
      gone = true;
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [auth && auth.token]);

  /* 고른 외형을 계정에 저장합니다 (§4.1). 판 투명도를 연달아 누를 수 있어서 600ms 미룹니다 —
     누를 때마다 보내면 마지막 값만 쓸모 있는 요청을 여러 번 던지게 됩니다 */
  const lookSent = useRef(null);
  const lookTimer = useRef(null);
  useEffect(() => {
    if (!auth) return;
    const body = JSON.stringify(lookOut());
    if (lookSent.current === body) return;
    clearTimeout(lookTimer.current);
    lookTimer.current = setTimeout(() => {
      lookSent.current = body;
      authApi.look(auth.token, JSON.parse(body)).catch(() => {
        /* 못 올려도 이 브라우저의 외형은 그대로입니다 — 다음 변경 때 다시 시도합니다 */
        lookSent.current = null;
      });
    }, 600);
    return () => clearTimeout(lookTimer.current);
  }, [auth && auth.token, relay.look]);

  /* ================= 자리 (§3.2) =================
     자리 = { 이름, 붙은 계정, 기억된 아이디 }. 연결이 판의 행이 아니라 자리에 살아서
     판이 갈려도 연결이 안 끊어집니다. 닉네임 매칭 재연결은 폐기했습니다. */
  const putSeats = (next) => setSeats(typeof next === "function" ? next : () => next);
  /* ≡ 손잡이 — 이름 왼쪽을 끌어 줄 순서를 바꿉니다 (2026-09-06 오후 사용자 요청; 같은 날 실시간으로). 방장 줄(1번)은 손잡이도 없고 그 위로 놓을 수도 없습니다.
     파티원 화면엔 없습니다. 끄는 동안은 DOM 의 transform 만 만지고(다른 줄이 미끄러져 자리를 비킴), 놓을 때 한 번 상태를 바꿉니다 —
     포인터마다 다시 그리면 앱 전체가 다시 그려져 무겁습니다. 줄과 자리는 같은 id 라 둘 다 같은 순서로 돌립니다.
     (폐기, 같은 날) HTML5 draggable + 놓일 자리 금색 선 — 사용자: 투박하다 */
  const dragRef = useRef(null); // {id, from, to, y0, h, els, mid}
  const [dragTick, setDragTick] = useState(0); // 놓은 뒤 DOM 이 새 순서로 바뀌면 transform 을 걷는 신호
  const dragRows = () => (gridRef.current ? [...gridRef.current.querySelectorAll("tbody > tr[data-row]")] : []);
  const dragClear = () => {
    dragRows().forEach((el) => {
      el.style.transform = "";
      el.classList.remove("gs-dragging");
    });
    if (gridRef.current) gridRef.current.classList.remove("gs-drag-live");
  };
  const dragStart = (e, id) => {
    if (readOnly || (e.pointerType === "mouse" && e.button !== 0)) return;
    const els = dragRows();
    const from = els.findIndex((el) => el.dataset.row === id);
    if (from < 1) return;
    e.preventDefault();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch (x) {}
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); // 이름 칸 포커스가 따라오지 않게
    const h = els[from].getBoundingClientRect().height;
    /* 각 줄의 원래 가운데 — 끄는 동안 다른 줄은 transform 으로 움직이니 원래 자리를 기억해 둡니다 */
    const mid = els.map((el) => {
      const r = el.getBoundingClientRect();
      return r.top + r.height / 2;
    });
    dragRef.current = { id, from, to: from, y0: e.clientY, h, els, mid };
    gridRef.current.classList.add("gs-drag-live");
    els[from].classList.add("gs-dragging");
  };
  const dragMove = (e) => {
    const d = dragRef.current;
    if (!d) return;
    const dy = e.clientY - d.y0;
    d.els[d.from].style.transform = "translateY(" + dy + "px)";
    const center = d.mid[d.from] + dy;
    /* 잡은 줄의 가운데보다 위에 있는 다른 줄 수 + 1(방장 줄) = 놓일 자리 */
    let to = 1;
    for (let i = 1; i < d.els.length; i++) if (i !== d.from && d.mid[i] < center) to++;
    d.to = to;
    for (let i = 1; i < d.els.length; i++) {
      if (i === d.from) continue;
      const shift = d.from < i && i <= to ? -d.h : to <= i && i < d.from ? d.h : 0;
      d.els[i].style.transform = shift ? "translateY(" + shift + "px)" : "";
    }
  };
  const dragEnd = () => {
    const d = dragRef.current;
    if (!d) return;
    dragRef.current = null;
    if (d.to === d.from) return dragClear();
    const ids = d.els.map((el) => el.dataset.row);
    const [moved] = ids.splice(d.from, 1);
    ids.splice(d.to, 0, moved);
    /* 새 순서로 — 목록에 없는 것(자리 없는 줄 등)은 뒤에 원래 순서대로 */
    const byIds = (list) => {
      const pos = new Map(ids.map((k, i) => [k, i]));
      return list
        .map((x, i) => [x, pos.has(x.id) ? pos.get(x.id) : ids.length + i])
        .sort((a, b) => a[1] - b[1])
        .map(([x]) => x);
    };
    setRows(byIds);
    putSeats(byIds);
    setDragTick((t) => t + 1); // DOM 이 새 순서로 그려진 직후 transform 을 걷습니다(useLayoutEffect) — 그려지기 전에 걷으면 한 프레임 튑니다
  };
  useLayoutEffect(() => {
    dragClear();
  }, [dragTick]);
  const seatName2 = (s, i) => (s && (s.name || "").trim()) || ANON(i);
  /* 자리 하나 = 판의 줄 하나. 줄 id 가 자리 id 그대로라 판이 갈려도 자격이 따라옵니다 */
  const rowsFromSeats = (list) =>
    list.map((s, i) => ({
      id: s.id,
      name: (s.name || "").trim() || FILL_NAME(i + 1),
      counts: simple ? { [SIMPLE_ID]: "" } : {},
      extras: [],
    }));
  const bindingsFromSeats = (list) => {
    const out = {};
    list.forEach((s) => {
      if (s.acct) out[s.acct] = s.id;
    });
    return out;
  };
  const newSeat = (name) => ({
    id: "r" + seq.current++,
    name: name || "",
    acct: null,
    mem: null,
    named: !!name,
  });
  /* 이름을 방장이 고치면 그 자리는 '손댄 자리'가 됩니다 — 파티원이 닉을 바꿔도
     방장이 고쳐 둔 이름은 안 건드립니다 (§3.2) */
  const renameSeat = (id, name) =>
    putSeats((prev) => prev.map((s) => (s.id === id ? { ...s, name, named: true } : s)));
  const dropSeat = (id) => putSeats((prev) => prev.filter((s) => s.id !== id));
  /* 로비에 그릴 목록 — 첫 자리는 언제나 방장입니다 (§3.4) */
  const lobbySeats = seats;
  /* 로그인 상태면 1번 자리에 방장이 미리 앉습니다 (§3.1) — 로아 로비에서 파티장이
     1번 슬롯인 것과 같습니다. 방장이 명단에 들어가는 길이 없으면 자기 벌금을 못 셉니다.
     **내 계정이 붙은 자리**여야 자수 자격·바인딩이 맞습니다 (§3.2).
     이미 내 자리가 있으면 새로 만들지 않고, 자리가 있는 상태에서 로그인하면 1번에
     끼워 넣습니다(기존 자리는 밀립니다). [×]로 빼면 다시 만들지 않습니다 — 이 효과는
     로그인이 바뀌거나 닉이 바뀔 때만 다시 돕니다 */
  useEffect(() => {
    if (readOnly || !auth || roundLive) return;
    putSeats((prev) => {
      const i = prev.findIndex((s) => s.acct === auth.id);
      if (i >= 0) {
        /* 방장이 손으로 고쳐 둔 이름은 닉을 따라가지 않습니다 (§3.2) */
        const me = prev[i];
        const name = me.named ? me.name : auth.nick || me.name;
        if (i === 0 && name === me.name) return prev;
        return [{ ...me, name }, ...prev.filter((_, k) => k !== i)];
      }
      const seat = {
        id: "r" + seq.current++,
        name: auth.nick || "",
        acct: auth.id,
        mem: auth.id,
        named: false,
        nick: auth.nick || "",
      };
      /* 1번이 빈 줄이면 그 줄에 앉습니다 — 빈 줄을 남기고 밀어내면 명단에 구멍이 생깁니다 */
      const h = prev[0];
      if (h && !h.acct && !(h.name || "").trim())
        return [{ ...seat, id: h.id }, ...prev.slice(1)];
      return [seat, ...prev];
    });
  }, [auth && auth.id, auth && auth.nick, readOnly, roundLive]);
  /* 명단은 인원 수만큼의 칸입니다 (§3.1) — 빈 칸은 (모험가N) 자리표시로 서서
     "여기가 자동으로 차는구나"를 보여 줍니다. 모자라면 빈 칸을 채워 넣고, 남으면
     뒤에서부터 빈 칸만 걷습니다 — 사람과 이름은 절대 이 길로 안 지워집니다.
     판 도중에는 자리가 줄을 따라가므로(아래 효과) 여기서는 손대지 않습니다 */
  useEffect(() => {
    if (readOnly || roundLive) return;
    putSeats((prev) => {
      /* 판에서 돌아온 (모험가N) 이름은 자리표시로 되돌립니다 — 값으로 남으면
         진짜 이름처럼 칸을 차지해 다음 수락을 막습니다 */
      let base = prev;
      if (prev.some((s) => !s.acct && isFillName(s.name)))
        base = prev.map((s) =>
          !s.acct && isFillName(s.name) ? { ...s, name: "", named: false } : s
        );
      if (base.length < lobbyCap)
        return [
          ...base,
          ...Array.from({ length: lobbyCap - base.length }, () => ({
            id: "r" + seq.current++,
            name: "",
            acct: null,
            mem: null,
            named: false,
          })),
        ];
      if (base.length > lobbyCap) {
        const next = base.slice();
        while (
          next.length > lobbyCap &&
          !next[next.length - 1].acct &&
          !(next[next.length - 1].name || "").trim()
        )
          next.pop();
        if (next.length !== base.length) return next;
      }
      return base;
    });
  }, [lobbyCap, roundLive, readOnly, seats.length]);
  /* 준비 상태의 표는 자리 그대로입니다 (§3.1, 2026-09-05) — 줄 = 자리, 숫자는 0.
     자리가 바뀌면(수락·인원 수·이름) 줄을 다시 세우고, 끝낸 판의 숫자도 여기서 비워집니다.
     얼린 판은 건드리지 않습니다 — 그 숫자는 [이어가기]가 돌려줘야 합니다 */
  useEffect(() => {
    if (!ready || paused) return;
    const want = rowsFromSeats(seats);
    const sig = (l) => l.map((x) => x.id + ":" + (x.name || "").trim()).join("|");
    const clean = rows.every(noFine);
    if (sig(want) === sig(rows) && clean) return;
    setRows(want);
    if (!clean) {
      setLog([]);
      setUndoSnap(null);
      setMemoFreeze(null);
    }
  }, [ready, !!paused, seats.map((x) => x.id + ":" + (x.name || "")).join("|")]);
  /* 신청 — 방장이 수락/거절을 고릅니다 (§3.3) */
  const pending = members.filter((m) => m.st === "req");
  /* 명단이 바뀌었는지 한 줄로 — 인원 수가 같아도 사람이나 상태가 바뀌면 다시 밀어야 합니다 */
  const memberSig = members.map((m) => m.acct + ":" + m.st + ":" + (m.rowId || "")).join("|");

  const membersLoaded = useRef(false);
  const refreshMembers = async () => {
    const a = authRef.current;
    if (!a || !relay.room || tutorialRef.current) return; // 예시 파티의 명단은 서버 것이 아닙니다 (2026-09-06)
    try {
      const r = await roomApi.members(a.token, relay.room);
      if (Array.isArray(r.list)) setMembers(r.list);
      else if (Array.isArray(r)) setMembers(r);
      /* 명단을 한 번은 읽은 뒤에야 자리를 비웁니다 — 첫 렌더의 빈 명단을 "다 나갔다"로 읽으면 이름이 지워집니다 */
      membersLoaded.current = true;
    } catch (e) {
      /* 명단을 못 읽어도 화면은 그대로 둡니다 */
    }
  };

  /* [초대 링크 만들기] — 로비의 초대·신청 칸을 펴고, 서버 로비를 "모으는 중"으로 세웁니다.
     로비 자체는 홈이라 늘 있습니다 (§1) — 여는 것은 대기실 표시입니다.
     대기실이 열려 있는 동안만 오버레이가 순위표 대신 대기실을 그립니다 (§4.3) */
  const startParty = async () => {
    if (readOnly) return;
    const a = authRef.current;
    if (!a)
      /* 파티원을 처음 모으는 사람은 대개 계정도 처음이라 가입부터 엽니다 */
      return openAuth("register", startParty, {
        why: "파티원을 모으려면 계정이 필요해요. 닉네임이 벌금판에 올라가는 내 이름이에요.",
        loginVerb: "로그인하고 시작",
        joinVerb: "가입하고 시작",
      });
    /* (폐기 2026-09-05) 게스트에게 아이디 만들기를 먼저 요구하던 문턱 — 게스트도 닉 있는 진짜
       계정이라 파티를 열 수 있습니다 (§3.11). 브라우저에 묶인다는 걱정은 모집 카드의 한 줄이 말합니다 */
    try {
      const r = await roomApi.myRoom(a.token);
      const roomId = r.roomId;
      const cap = (r.lobby && r.lobby.cap) || relay.lobbyCap || 8;
      /* 로비를 열어도 명단은 그대로입니다 — 멤버십이 끊기는 길은 본인 [나가기]와
         방장 내보내기 둘뿐입니다 (§1·§3.4). 해산 동사는 없습니다 */
      await roomApi.lobby(a.token, roomId, true, cap);
      /* 코드의 생사는 서버가 압니다 (2026-09-06: 방장이 앱을 열어 둔 동안 살고 닫으면 10분 뒤 만료) —
         살아 있으면 그대로, 죽었으면 새로. 한 저녁에 판 둘이면 링크는 하나입니다 */
      let inv = null;
      try {
        inv = await roomApi.inviteNow(a.token, roomId);
      } catch (e2) {}
      if (!inv) {
        try {
          inv = await roomApi.invite(a.token, roomId);
        } catch (e2) {}
      }
      putRelay({
        ...relayRef.current,
        room: roomId,
        invite: inv ? { code: inv.code, exp: inv.exp } : relayRef.current.invite,
        lobbyCap: cap,
        on: true,
      });
      setLobbyCap(cap);
      setLobbyOn(true);
      refreshMembers();
    } catch (e) {
      say(e.message);
    }
  };
  /* [+ 새 판 만들기] (2026-09-06 모델: 판은 만들면 생기고 끝내면 없다) — 오늘 날짜 이름, 방장 줄과 빈 자리(정원은 빈 자리
     효과가 채움), 항목·단가·인원은 기본값 그대로. 로그인돼 있으면 로비를 열어 판 존재 표시를 켜고 코드가 없거나 죽었으면
     새로 냅니다(startParty). 비로그인은 이 브라우저만의 판입니다. 그리고 대기실로 */
  const newBoard = () => {
    if (readOnly) return;
    if (tutorialRef.current) {
      /* 같이 해보기 1걸음 — 진짜 판 대신 예시 판 */
      tutNewBoard();
      tutHit("newboard");
      return;
    }
    setRoundName(defaultRoundName());
    setLog([]);
    setUndoSnap(null);
    setMemoFreeze(null);
    setOpenRow(null);
    setRoundId("");
    setRoundLive(false);
    setPaused(null);
    setMembers([]);
    putSeats((prev) => prev.filter((s0, i) => i === 0 && !!s0.acct));
    boardOnRef.current = true;
    putRelay({ ...relayRef.current, boardOn: true });
    go(VIEW_BOARD);
    if (authRef.current) startParty();
  };
  /* [해산] — 시작 전 판을 없앱니다 (2026-09-06 모델). 앉아 있던 파티원은 나가고 남는 것은 기본값뿐입니다.
     진행 중의 끝은 [정산 끝내기] 하나입니다 */
  const disband = () => {
    if (readOnly) return;
    const a = authRef.current;
    if (a && relayRef.current.room) roomApi.end(a.token, relayRef.current.room).catch(() => {});
    setMembers([]);
    setLobbyOn(false);
    setRoundName(defaultRoundName());
    setLog([]);
    setUndoSnap(null);
    setMemoFreeze(null);
    setRoundId("");
    setRoundLive(false);
    setPaused(null);
    putSeats((prev) => prev.filter((s0, i) => i === 0 && !!s0.acct));
    boardOnRef.current = false;
    putRelay({ ...relayRef.current, boardOn: false });
    go(VIEW_LOBBY);
  };
  /* 방 하나 규칙 (2026-09-07 사용자 확정) — 보관된 초대로 가려면: 진행 중이면 [정산 끝내기]가 먼저(끝내러 가기), 시작 전이면 [해산하고 가기]. 문구 초안 */
  const askLeaveForJoin = () => {
    if (!pendingJoin) return;
    if (roundLive)
      return setAsk({
        title: "진행 중인 내 판을 끝내야 갈 수 있어요",
        body: "[정산 끝내기]를 누르면 결과지가 기록에 남고 판이 닫혀요. 초대는 파티 허브에 보관해 둘게요.",
        action: "끝내러 가기",
        onYes: () => go(VIEW_BOARD),
      });
    if (boardOn)
      return setAsk({
        title: "내 판을 해산하고 초대받은 파티로 갈까요?",
        body: "시작 전 판이 없어져요. 자리와 이름이 지워지고 항목과 단가만 남아요.",
        action: "해산하고 가기",
        tone: "danger",
        onYes: () => {
          disband();
          goPendingJoin();
        },
      });
    goPendingJoin();
  };
  /* 부팅 때 보관된 초대가 있으면 바로 묻습니다 — 링크를 눌렀는데 아무 일도 없으면 안 됩니다 */
  useEffect(() => {
    if (readOnly || tutorial || !pendingJoin) return;
    askLeaveForJoin();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  /* 남의 파티에 앉은 채 새 판을 만들면 먼저 나갑니다 (방 하나 규칙, 2026-09-07). 문구 초안 */
  const askNewBoard = () => {
    if (readOnly) return;
    if (!tutorialRef.current && seatedNow)
      return setAsk({
        title: seatedName + "에서 나가고 내 판을 만들까요?",
        body: meSeat && meSeat.round ? "그 파티의 내 자리가 비어요. 벌금은 줄에 남아요." : "그 파티의 내 자리가 비어요.",
        action: "나가고 만들기",
        tone: "danger",
        onYes: async () => {
          await leaveFromLobby();
          newBoard();
        },
      });
    newBoard();
  };
  /* 대기실에서는 남이 앉아 있을 때만 묻고 혼자면 바로. 로비에서는(always) 판을 안 보고 누르는 것이라 늘 묻습니다 (2026-09-07 사용자; 문구 초안) */
  const askDisband = (always) => {
    const others = seats.filter((s0, i) => i > 0 && s0.acct).length;
    if (!others && !always) return disband();
    setAsk({
      title: others ? "파티를 해산할까요?" : "판을 해산할까요?",
      body: others ? "앉아 있는 파티원이 나가요." : "시작 전 판이 없어져요. 자리와 이름이 지워지고 항목과 단가만 남아요.",
      action: "해산",
      tone: "danger",
      onYes: disband,
    });
  };
  /* 로비 모으기 열의 [로그인] — 버튼이 '로그인'이라 로그인 쪽으로 열고,
     끝나면 하려던 일(모으기)을 이어서 합니다. 가입은 창 아래 한 줄로 갈라져 있습니다 */
  const openLobbyLogin = () =>
    openAuth("login", startParty, {
      why: "파티원을 모으려면 계정이 필요해요. 닉네임이 벌금판에 올라가는 내 이름이에요.",
      loginVerb: "로그인하고 시작",
      joinVerb: "가입하고 시작",
    });
  /* 방은 처음 필요할 때 서버가 만들어 줍니다 — 로그인 직후·초대 발급 전에 부릅니다 */
  const ensureRoom = async () => {
    if (!auth) return null;
    if (relay.room) return relay.room;
    try {
      const r = await roomApi.myRoom(auth.token);
      putRelay({
        ...relay,
        room: r.roomId,
        invite: r.invite && r.invite.code ? { code: r.invite.code, exp: r.invite.exp } : relay.invite,
      });
      return r.roomId;
    } catch (e) {
      say(e.message);
      return null;
    }
  };
  const newInvite = async () => {
    if (!auth || !relay.room) return;
    try {
      const inv = await roomApi.invite(auth.token, relay.room);
      putRelay({ ...relayRef.current, invite: { code: inv.code, exp: inv.exp } });
    } catch (e) {
      say(e.message);
    }
  };
  /* 로비 밖에서도 초대를 낼 수 있습니다 — 방이 없으면 먼저 팝니다 */
  const ensureInvite = async () => {
    const room = await ensureRoom();
    if (!room || !auth) return;
    try {
      const inv = await roomApi.invite(auth.token, room);
      putRelay({ ...relay, room, invite: { code: inv.code, exp: inv.exp } });
    } catch (e) {
      say(e.message);
    }
  };
  /* 닉네임 변경 — 서버가 방장 앱에 알리고, 방장 앱이 그 줄 이름을 바꿉니다 */
  const changeNick = async (nm) => {
    if (!auth) return;
    await authApi.nick(auth.token, nm);
    putAuth({ ...auth, nick: nm });
  };
  /* 판 한 벌을 한 줄로 — 서버 장부와 이 기기의 장부가 같은 것인지만 가릅니다.
     같으면 물을 것도 앉힐 것도 없습니다 (늘 쓰던 기기에서 다시 로그인한 경우) */
  const ledgerSig = (l) =>
    ((l && l.rows) || [])
      .map((x) => x.id + ":" + (x.name || "") + ":" + JSON.stringify(x.counts || {}))
      .join("|") +
    "#" +
    (((l && l.log) || []).length + ":" + ((((l && l.log) || []).slice(-1)[0] || {}).id || ""));
  /* 로그인 직후 한 번. 하는 일이 둘입니다 —
     (a) 방 연결은 조건 없이 먼저 붙입니다. 초대·파티 서랍·오버레이가 전부 이 값 하나에
         달려 있어서, 장부를 앉히느냐와 상관없이 방부터 이어야 합니다 (§5.1).
     (b) 서버에 판이 있고 이 기기의 것과 다르면 — 손 안 댄 판이면 조용히 앉히고,
         진행 중인 판이 있으면 물어봅니다. 다른 기기에서 로그인하는 길이 이 길입니다 */
  const askResume = async (a) => {
    /* 뷰어는 남의 판을 보는 중입니다 — 여기서 내 방을 열면 방송용 주소가 남의 파티 대신
       내 빈 방을 가리키게 됩니다(서버의 `cur` 이 그때 옮겨갑니다, §4.1) */
    if (!a || readOnly) return;
    try {
      const r = await roomApi.myRoom(a.token);
      if (!r || !r.roomId) return;
      putRelay({
        ...relayRef.current,
        room: r.roomId,
        invite:
          r.invite && r.invite.code
            ? { code: r.invite.code, exp: r.invite.exp }
            : relayRef.current.invite,
      });
      const got = await roomApi.read(a.token, r.roomId);
      /* 살아 있는 판만 앉힙니다 (2026-09-06 모델) — 끝난 판(end)이나 시작 전 스냅샷을 진행 중으로 되살리면 안 됩니다.
         (버그 기록 2026-09-06) 해산 뒤 새로고침하니 옛 판이 `진행 중 · 1명 · 49분째`로 살아났다 */
      const st0 = got && got.state;
      if (!st0 || !st0.roundId || st0.end || st0.lobby) return;
      const led = ledgerFromSnapshot(st0);
      if (!led || !led.rows.length) return;
      if (ledgerSig(led) === ledgerSig({ rows, log })) return;
      const seat = () => {
        savePartySlot(partyReg.active, led);
        applyLedger(led);
        /* 서버에서 앉힌 판은 진행 중인 판입니다 — 로비로 강등되면 안 됩니다 */
        putSeats(seatsFromRows(led.rows));
        /* 같은 판 열쇠를 이어받습니다 — 끝낼 때 기록이 둘로 안 남게. 판 존재 표시도 켭니다 */
        setRoundId(st0.roundId);
        setRoundLive(true);
        boardOnRef.current = true;
        putRelay({ ...relayRef.current, boardOn: true });
      };
      /* 이 기기에 아직 아무것도 없으면 묻지 않습니다 — 고를 것이 하나뿐입니다.
         판을 연 적이 없고(로비), 기록도 숫자도 이름도 안 들어간 판이 '손 안 댄 판'입니다.
         처음 켠 기기에서 로그인하는 길이 그 자리입니다 */
      const blank =
        !log.length &&
        rows.every((x) => noFine(x) && (!(x.name || "").trim() || isFillName(x.name)));
      if (!roundLive && (blank || isPristine(rows))) return seat();
      setAsk({
        title: "서버에 저장된 판이 있어요",
        body: "이 기기의 판을 두고 그걸 열까요? 지금 화면의 판은 판 기록에 남아요.",
        action: "서버 판 열기",
        onYes: () => {
          closeRound();
          seat();
        },
      });
    } catch (e) {
      /* 서버가 없거나 판이 없으면 조용히 지나갑니다 */
    }
  };
  /* 인원 수 = 명단 칸 수입니다 (§3.1). 사람이 앉았거나 이름이 적힌 칸 아래로는 못
     줄입니다 — 숫자 하나로 사람을 지우는 문이 되면 안 됩니다 */
  const putCap = async (n) => {
    const used = seatsRef.current.filter((s) => s.acct || (s.name || "").trim()).length;
    const cap = Math.min(16, Math.max(1, used, Math.round(num(n)) || 0));
    setLobbyCap(cap);
    putRelay({ ...relay, lobbyCap: cap });
    if (auth && relay.room && lobbyOn && !tutorialRef.current)
      roomApi.lobby(auth.token, relay.room, true, cap).catch(() => {});
  };
  /* 모으기를 접습니다 — 대기실 표시만 내리고, 모인 사람은 그대로 남습니다 (§1) */
  const closeLobby = async () => {
    if (auth && relay.room) roomApi.lobby(auth.token, relay.room, false).catch(() => {});
    setLobbyOn(false);
  };
  /* [시작] (로비) — 자리·항목으로 판을 엽니다. 첫 줄은 언제나 방장입니다 (§3.4) */
  const startRound = async (nCols) => {
    if (readOnly) return;
    /* 자리는 로비가 보장합니다 (§3.1: 로그인하면 1번에 방장이 앉아 있습니다).
       여기 한 줄은 그래도 빈 판이 열리지 않게 남겨 둔 방어입니다 */
    const list = seats.length
      ? seats
      : [{ ...newSeat((auth && auth.nick) || ""), acct: auth ? auth.id : null, mem: auth ? auth.id : null }];
    if (!seats.length) putSeats(list);
    /* 앞 판을 결과지로 보냅니다. **얼어 있는 판도 포함입니다** — 중단된 판은 로비에
       있으므로 roundLive 가 거짓이라, 이 조건이 roundLive 뿐이면 [시작]이 그 판을
       기록에 남기지 않고 덮어써서 통째로 잃습니다(실제로 그랬습니다) */
    if (roundLive || paused) closeRound();
    /* 지난 판 이어서 (2026-09-06) — 그 판의 줄(이름·숫자·기타·기록)을 열고, 앉은 사람은 출처가 같은 줄로(자리 id 를
       그 줄 id 로 바꿔 잇습니다), 나머지 앉은 사람은 새 줄. 사람이 안 온 줄은 이름만 있는 장부 줄로 남습니다.
       지난 기록엔 출처가 없어 전부 새 줄입니다. 같은 판 열쇠(roundId)를 이어받아 끝낼 때 기록 한 줄이 갱신됩니다 */
    const resumeName = relayRef.current.resumeFrom || "";
    const slot = resumeName ? loadPartySlot(resumeName) : null;
    const entry = slot ? gensList().find((g) => g.name === resumeName) : null;
    if (resumeName) putRelay({ ...relayRef.current, resumeFrom: "" });
    const cCols = (slot && slot.cols.length ? slot.cols : nCols && nCols.length ? nCols : cols).map((c) => ({ ...c }));
    let list2 = list;
    let nRows;
    let nLog = [];
    if (slot) {
      const old = slot.rows.map((r) => ({ ...r, counts: { ...(r.counts || {}) }, extras: (r.extras || []).map((e) => ({ ...e })) }));
      const used = new Set();
      list2 = list
        .filter((s0) => s0.acct)
        .map((s0) => {
          const r = old.find((x) => x.who && x.who === s0.acct && !used.has(x.id));
          if (!r) return s0;
          used.add(r.id);
          return { ...s0, id: r.id };
        });
      const simpleSlot = slot.mode === "simple";
      const extra = list2
        .filter((s0) => !old.some((x) => x.id === s0.id))
        .map((s0, k) => ({
          id: s0.id,
          name: (s0.name || "").trim() || FILL_NAME(old.length + k + 1),
          counts: simpleSlot ? { [SIMPLE_ID]: "" } : {},
          extras: [],
          who: s0.acct,
        }));
      nRows = [...old, ...extra];
      nLog = Array.isArray(slot.log) ? slot.log : [];
      /* 자리 id 가 줄 id 를 따라갔으니 명단의 rowId 도 같이 — 안 그러면 명단→자리 효과가 사람을 떨어뜨립니다 */
      setMembers((prev) =>
        prev.map((m) => {
          const s0 = list2.find((x) => x.acct === m.acct);
          return s0 ? { ...m, rowId: s0.id } : m;
        })
      );
      putSeats(list2);
      if (slot.unit) setUnit(slot.unit);
      if (slot.feePercent) setFeePercent(slot.feePercent);
      if (slot.splitMode) setSplitMode(slot.splitMode === "solo" ? "solo" : "pot");
      setMode(simpleSlot ? "simple" : "items");
      setRoundName((entry && entry.rname) || slot.rname || defaultRoundName());
    } else {
      nRows = rowsFromSeats(list);
      /* 프리셋의 이름은 지금 빈 줄에 들어갑니다 (2026-09-06) — 앱을 안 쓰는 사람의 이름은 시작 뒤의 것입니다 */
      const pn = (relayRef.current.presetNames || []).slice();
      if (pn.length) {
        nRows.forEach((x) => {
          if (pn.length && isFillName(x.name)) x.name = pn.shift();
        });
        putRelay({ ...relayRef.current, presetNames: [] });
      }
    }
    const gid =
      entry && entry.round && entry.round.includes("/") ? entry.round.split("/").pop() : newRoundId();
    snapHold.current = true;
    setCols(cCols);
    setRows(nRows);
    setLog(nLog);
    setMemoFreeze(slot ? slot.memoFreeze || null : null);
    setUndoSnap(null);
    setOpenRow(null);
    setRoundId(gid);
    setRoundLive(true);
    setTab("sheet");
    setLobbyOn(false);
    setPaused(null);
    if (tutorialRef.current) {
      tutHit("start");
      return;
    }
    if (!auth || !relay.room) return;
    /* [시작]은 송출 토글을 건드리지 않습니다 (§5.7) — 방장이 일부러 꺼 뒀는데 판을
       연다고 방송에 다시 띄우면, 끈 것이 무슨 뜻인지 없어집니다. 주소를 받는 순간
       이미 켜져 있으므로 처음 쓰는 사람은 그대로 나갑니다 */
    try {
      /* 얼어 있던 표시가 남아 있으면 여기서 풉니다 — 새 판은 얼어 있지 않습니다 */
      await roomApi.resume(auth.token, relay.room).catch(() => {});
      await roomApi.putState(
        auth.token,
        relay.room,
        openSnapshot(cCols, nRows, gid, list2),
        bindingsFromSeats(list2)
      );
    } catch (e) {
      /* 못 밀어도 장부는 이 브라우저에 있습니다 — 다음 변경 때 다시 밀립니다 */
    }
    roomApi.lobby(auth.token, relay.room, false).catch(() => {});
  };
  /* 막 연 판은 전부 0 이라, 여기서 손으로 한 장 만들어 보냅니다.
     (React 상태는 아직 갱신 전이라 liveSnapshot 은 옛 판을 그립니다) */
  const openSnapshot = (nCols, nRows, gid, list) => {
    const acols = nCols.filter((c) => !ovShow().itemOff(c.id));
    return {
      v: 1,
      name: "벌금 현황판",
      roundId: gid,
      board: nRows.map((x, i) => ({ n: seatName(x, i), g: 0, c: acols.map(() => 0), d: 0 })),
      cols: acols.map((c) => ({ t: (c.name || "").trim() || "항목", r: isRoulette(c) ? 1 : 0 })),
      ovNet: ovShow().net,
      ovSum: ovShow().sum,
      ovSlide: ovShow().slide,
      fx: [],
      fxSpd: fxOn(relay) ? "norm" : "off",
      mvMode: "swipe",
      spin: null,
      full: { mode, cols: nCols, rows: nRows, feePercent, unit, splitMode, log: [], memoFreeze: null },
      rows2: nRows.map((x, i) => {
        const s = (list || []).find((k) => k.id === x.id);
        return { rowId: x.id, n: seatName(x, i), a: s && s.acct ? 1 : 0 };
      }),
      look: lookOut(),
      t: Date.now(),
    };
  };
  /* 내보내기 = 이 방에서 빠짐. 영구 차단은 없고, 다시 초대하면 됩니다.
     소속만 끊습니다 — 자리는 미연결로 남습니다(이름·아이디 기억·쌓인 벌금). 없어지는 것은
     "나가 있는 동안 안 보인다" 하나입니다 (§3.4) */
  const kickMember = (acct) => {
    if (!auth || !relay.room) return;
    setMembers((prev) => prev.filter((m) => m.acct !== acct));
    /* 내보낸 자리도 같은 규칙 — 시작 전엔 빈 자리, 진행 중엔 장부 줄에 `나감` (§3.4) */
    putSeats((prev) =>
      prev.map((s) =>
        s.acct !== acct
          ? s
          : roundLive
          ? { ...s, acct: null, mem: null, left: true, who: s.acct }
          : { ...s, acct: null, mem: null, name: "", named: false, left: false }
      )
    );
    roomApi.member(auth.token, relay.room, acct, "remove").catch(() => refreshMembers());
  };
  /* 명단이 바뀌면 자리를 맞춥니다 — 나간 사람의 자리는 미연결이 되고, 아이디는 남습니다.
     서버가 준 rowId 가 자리 id 라, 다른 기기에서 로그인해도 같은 그림이 됩니다 */
  useEffect(() => {
    if (readOnly || !auth) return;
    /* 서버 명단을 아직 못 읽었으면 판단하지 않습니다 (2026-09-05) — 빈 명단은 "아무도 없다"가 아니라 "모른다"입니다 */
    if (!membersLoaded.current) return;
    const ok = new Map();
    members.forEach((m) => {
      if (m.st === "ok" && m.rowId) ok.set(m.rowId, m);
    });
    /* 서버 명단이 원본입니다 — 그 자리에 앉은 사람으로만 acct 를 채우고, 나머지는 미연결로
       돌립니다. 아이디(mem)는 지우지 않습니다: 돌아오면 자기 자리를 되찾는 열쇠입니다.
       내 자리는 예외입니다 (§3.1): 방장은 자기 방의 명단(members)에 들어 있지 않아서,
       여기서 함께 쓸어 버리면 1번에 앉은 방장의 계정이 곧바로 떨어져 나갑니다 */
    putSeats((prev) => {
      let hit = false;
      const next = prev.map((s) => {
        const m = ok.get(s.id);
        const mine = s.acct === auth.id;
        const acct = m ? m.acct : mine ? s.acct : null;
        if (acct === s.acct) return s;
        hit = true;
        /* 사람이 떨어져 나간 자리 (§3.4, 2026-09-05 표준화): 시작 전엔 완전히 빈 자리로(이름도 지움),
           진행 중엔 줄이 장부라 이름은 남기고 `나감`만 표시. 자리 기억(mem)은 폐기 */
        if (!acct && s.acct)
          return roundLive
            ? { ...s, acct: null, mem: null, left: true, who: s.acct }
            : { ...s, acct: null, mem: null, name: "", named: false, left: false };
        /* 이름이 비어 있던 자리에 사람이 붙으면 닉으로 채웁니다 */
        return { ...s, acct, mem: acct, left: false, nick: (m && m.nick) || s.nick || "", name: (s.name || "").trim() ? s.name : (m && m.nick) || s.name };
      });
      return hit ? next : prev;
    });
    /* 자리 목록이 통째로 갈릴 때도 다시 맞춥니다 — 다른 기기에서 로그인해 서버 장부로
       자리를 새로 깔면(askResume) 그 자리들은 미연결로 태어나서, 명단이 이미 와 있어도
       아무도 안 앉은 것처럼 보입니다. 바뀔 것이 없으면 prev 를 돌려주므로 돌지 않습니다 */
  }, [memberSig, seats.map((s) => s.id + ":" + (s.acct || "")).join("|"), readOnly, !!auth, roundLive]);
  /* 빈 자리 = 계정이 안 붙은 자리. 첫 자리는 방장 것이라 남에게 안 넘깁니다 (§3.2) */
  const freeSeats = () => seats.filter((s, i) => i > 0 && !s.acct);
  /* 아이디를 기억하는 자리는 언제나 하나입니다 (§3.2) — 옮기면 옛 자리의 기억을 지웁니다.
     안 지우면 그 사람이 자리를 둘 기억해, 다음 수락 때 방금 떠난 자리로 되돌아갑니다 */
  const forgetElsewhere = (list, acct, keepId) =>
    list.map((s) =>
      s.id === keepId || (s.acct !== acct && s.mem !== acct)
        ? s
        : /* 닉이 채운 이름은 같이 비웁니다 (2026-09-05) — 안 그러면 옮긴 뒤 같은 사람 줄이 둘로 보입니다.
             방장이 지은 이름(named)은 남기고, 진행 중엔 줄→자리 동기화가 장부 줄의 이름을 되살립니다 */
          { ...s, acct: null, mem: null, name: s.named && !isFillName(s.name) ? s.name : "" }
    );
  /* 붙는 순간에 바로 앉힙니다 (§3.2, 2026-09-05 표준화 — 다음 빈 슬롯에 즉시 앉는 로비 문법):
     ① 닉과 똑같은 이름이 적힌 빈 자리가 하나면 거기 ② 아니면 첫 빈 칸(자리표시 칸) ③ 빈 칸이 없으면 null —
     시작 전엔 본인이 이름 적힌 줄 중에서 고르고, 진행 중엔 방장이 배치합니다(들어오려는 사람 목록).
     (폐기 2026-09-05, 당일) "이름 적힌 빈 줄이 있으면 문 앞에서 본인이 고른다" — 문 앞의 질문이었다. 앉은 뒤에
     옮기면 된다(시작 전 본인, 진행 중 방장). (폐기) 자리가 아이디를 기억해 자동 복귀 — 나간 자리는 빈다 */
  const isBlankSeat = (s) => !(s.name || "").trim() || isFillName(s.name);
  /* 시작 전의 자리: 첫 빈 자리. (폐기 2026-09-06) 닉과 같은 이름의 빈 자리 — 이름은 출처가 아니다 */
  const autoSeatFor = () => {
    const blank = freeSeats().find(isBlankSeat);
    return blank ? blank.id : null;
  };
  /* 앉힌 것을 방장에게 한 줄로 — 방장의 눈은 항목에 가 있어서 명단이 바뀐 걸 놓칩니다 (§3.2) */
  const sayJoin = (nick, seatId) => {
    const st = seats.find((k) => k.id === seatId);
    /* 맨 아래 새 줄은 이 렌더의 자리 목록에 아직 없습니다 */
    if (!st) return say((nick || "파티원") + "님이 새 줄에 앉았어요.", 8000);
    const i = seats.indexOf(st);
    const where = st && !isBlankSeat(st) ? "'" + (st.name || "").trim() + "' 줄" : i + 1 + "번 줄";
    say((nick || "파티원") + "님이 " + where + "에 앉았어요.", 8000);
  };
  /* 그 자리에 사람을 앉힙니다 — 서버 명단·자리·판의 줄 이름이 같이 움직입니다 */
  const seatMember = async (acct, nick, seatId, opts) => {
    if (!auth || (!relay.room && !tutorialRef.current)) return;
    const fresh = seatId === "new";
    let id = seatId;
    let next = seats;
    if (fresh) {
      const s = { id: "r" + seq.current++, name: nick || "", acct, mem: acct, named: false, nick: nick || "" };
      id = s.id;
      /* 사람 하나는 자리 하나입니다 — 앉아 있던 자리는 미연결로 돌아가고 기억도 놓습니다 */
      next = [...forgetElsewhere(seats, acct, id), s];
    } else {
      /* (모험가N) 자리표시는 방장이 지은 이름이 아닙니다 — 사람이 앉으면 닉이 이깁니다.
         줄→자리 동기화가 자리표시 줄에 named 를 세워 둘 수 있어 이름으로 다시 봅니다 */
      next = forgetElsewhere(seats, acct, id).map((s) =>
        s.id === id
          ? {
              ...s,
              acct,
              mem: acct,
              left: false,
              nick: nick || s.nick || "",
              name: s.named && !isFillName(s.name) ? s.name : nick || s.name,
            }
          : s
      );
    }
    putSeats(next);
    /* 방금 앉은 줄 표시 — 줄이 30초 동안 서서히 옅어지며 밝고, 자리 띠가 '방금 앉았어요'를 30초 말합니다
       (2026-09-06: 3초·10초는 게임을 보다 돌아오면 이미 지나 있었다) */
    if (acct !== auth.id) {
      setArrived((p) => ({ ...p, [id]: Date.now() }));
      setTimeout(
        () =>
          setArrived((p) => {
            const q = { ...p };
            delete q[id];
            return q;
          }),
        30000
      );
    }
    /* 지목 초대를 받아들인 사람은 서버 명단이 이미 ok 입니다 — 방장이 수락할 것이 없어서
       자리와 줄만 맞춥니다 (§3.3). opts.local 이 그 길입니다 */
    if (tutorialRef.current) {
      /* 예시 파티 — 서버엔 아무것도 안 갑니다 (2026-09-06) */
    } else if (opts && opts.local) {
      /* 이미 ok 인 사람(지목 초대·링크 착석)의 자리만 서버에 적어 둡니다 — 파티원 앱이 시작 전에도
         자기 줄(you.rowId)을 알아야 하고, 자리 기억(§3.2)도 서버에 남아야 합니다.
         실패해도 [시작]의 bindings 가 다시 적으므로 기다리지 않습니다 */
      roomApi.member(auth.token, relay.room, acct, "approve", id).catch(() => {});
    } else
      try {
        await roomApi.member(auth.token, relay.room, acct, "approve", id);
      } catch (e) {
        /* 정원은 서버가 수락 시점에 셉니다 — 방장이 고칠 수 있는 말로 바꿔 줍니다 */
        say(e && e.status === 409 ? "대기실이 가득 찼어요. 정원을 늘려야 앉힐 수 있어요." : e.message);
        putSeats(seats);
        return;
      }
    setMembers((prev) => prev.map((m) => (m.acct === acct ? { ...m, st: "ok", rowId: id } : m)));
    /* 수락하는 순간 함께한 사람 관계가 생깁니다 (§3.3) — 목록이 다음 알트탭까지 비어
       있으면 방금 받은 사람을 바로 다시 부를 길이 없습니다 */
    if (!tutorialRef.current) refreshMe();
    /* 판이 살아 있으면 그 자리의 줄도 지금 만듭니다 — 판 도중 [+ 인원 추가]와 같은 일입니다.
       판이 없으면(로비) 줄은 [시작]할 때 자리에서 한꺼번에 생깁니다 */
    if (roundLive) {
      const nRows = rows.some((x) => x.id === id)
        ? rows.map((x) => {
            if (x.id !== id) return x;
            const s2 = next.find((s) => s.id === id);
            /* (모험가N) 줄을 이어받으면 그 줄이 그 사람의 이름을 얻습니다 (§3.2) */
            return !s2.named || isFillName(x.name) ? { ...x, name: nick || x.name } : x;
          })
        : [...rows, { id, name: nick || "", counts: simple ? { [SIMPLE_ID]: "" } : {}, extras: [] }];
      setRows(nRows);
    }
    if (opts && opts.silent) return id;
    return id;
  };
  /* 판 도중 수락 — 자리는 들어오는 본인이 고릅니다 (§3.2). 줄마다 벌금이 이미 붙어
     있어서 어느 줄이 그 사람인지 앱도 방장도 짐작하지 않습니다. 고르기 전까지
     rowId 는 비어 있고, 그동안도 판은 볼 수 있습니다(자수만 잠김) */
  const approveLoose = async (acct) => {
    if (!auth || !relay.room) return;
    try {
      await roomApi.member(auth.token, relay.room, acct, "approve");
    } catch (e) {
      say(e && e.status === 409 ? "대기실이 가득 찼어요. 정원을 늘려야 앉힐 수 있어요." : e.message);
      return;
    }
    setMembers((prev) => prev.map((m) => (m.acct === acct ? { ...m, st: "ok" } : m)));
    refreshMe();
  };
  /* [수락] — 로비에서는 빈 칸에 자동으로 앉고(§3.2 ①~③), 판 도중에는 본인이 고릅니다.
     기억된 자리가 있으면 판 도중이라도 그 자리입니다 — 나갔다 돌아온 사람에게
     "어느 줄이 나예요?"를 다시 물을 이유가 없습니다 */
  /* [자리 만들어 앉히기]/[받기] (§3.3, 2026-09-05 표준화) — 빈 칸이 있으면 거기, 없으면 자리를 하나 만들어
     앉힙니다. 서버는 승인 때 정원을 세므로 정원부터 올립니다.
     (폐기) "빈 칸이 없으면 수락이 막힌다 — 방장이 칸을 비우거나 인원 수를 늘려서 푼다" */
  const growCap = async () => {
    const cap = Math.min(16, Math.max(lobbyCap, seatsRef.current.length) + 1);
    setLobbyCap(cap);
    putRelay({ ...relay, lobbyCap: cap });
    if (auth && relay.room && lobbyOn && !tutorialRef.current)
      await roomApi.lobby(auth.token, relay.room, true, cap).catch(() => {});
  };
  /* 앉히기 규칙 하나 (2026-09-06 확정). 출처(계정)가 같은 줄이 있으면 요청 줄의 [받기]가 그 줄로 보내고, 그 밖엔 여기서:
     시작 전은 첫 빈 자리(없으면 인원을 늘려), 진행 중은 첫 빈 줄(이름도 벌금도 없는 자리표시 줄), 없으면 맨 아래 새 줄.
     이름이 있거나 벌금이 있는 줄엔 앱이 절대 앉히지 않습니다 — 그건 옮기기뿐입니다.
     (폐기 2026-09-06) "진행 중엔 방장이 배치, 예외 없음" — 방장이 던전 중에 답해야 했다 */
  const emptyRowId = () => {
    const r = rows.find((x) => {
      const st = seats.find((k) => k.id === x.id);
      return st && !st.acct && !st.left && isFillName(x.name) && noFine(x);
    });
    return r ? r.id : null;
  };
  const placeAuto = async (acct, nick, opts) => {
    let id;
    if (roundLive) id = await seatMember(acct, nick, emptyRowId() || "new", opts);
    else {
      const free = autoSeatFor();
      if (free) id = await seatMember(acct, nick, free, opts);
      else {
        await growCap();
        id = await seatMember(acct, nick, "new", opts);
      }
    }
    if (id) sayJoin(nick, id);
    return id;
  };
  const approveMember = (acct, nick) => placeAuto(acct, nick);
  const placeMember = (acct, nick) => placeAuto(acct, nick, { local: true });
  const denyMember = (acct) => {
    kickMember(acct);
  };
  /* [자리 바꾸기] — 옮기면 자격이 따라갑니다 (§3.2) */
  const moveMember = (acct, nick, seatId) => seatMember(acct, nick, seatId);

  /* 자수로 바뀐 칸 — {rowId, colId, nick, t}. 잠깐 번쩍이고 말풍선이 떴다가 스스로 사라집니다 */
  const [confessFx, setConfessFx] = useState(null);
  useEffect(() => {
    if (!confessFx) return;
    const t = setTimeout(() => setConfessFx(null), CONFESS_FX_MS);
    return () => clearTimeout(t);
  }, [confessFx]);

  /* ---------- 자수 반영 (방장) ----------
     파티원이 누른 것을 방장 앱이 장부에 적습니다 — pressCell 과 같은 계산이고,
     기록만 kind:"confess" 로 남아 화면에 "자수"로 읽힙니다. 취소(역분개)는 그대로 됩니다. */
  const applyConfess = (rowId, colId, dir) => {
    const row = rows.find((x) => x.id === rowId);
    const col = cols.find((c) => c.id === colId);
    if (!row || !col || isRoulette(col)) return;
    const d = dir < 0 ? -1 : 1;
    const before = liveN(row, col.id);
    if (d > 0 ? before >= MAX_COUNT : before <= 0) return;
    const priceG = Math.round(goldOf(col.price));
    const lastPress =
      d < 0
        ? [...log].reverse().find(
            (e) =>
              (e.kind === "press" || e.kind === "confess") &&
              e.rowId === row.id &&
              e.colId === col.id &&
              e.n > 0 &&
              !e.cancelled
          )
        : null;
    const gold = d > 0 ? priceG : -(lastPress ? lastPress.delta : priceG);
    const after = liveTotal(row) + gold;
    live.current.n[row.id + ":" + col.id] = before + d;
    live.current.total[row.id] = after;
    bump(row.id, col.id, d, gold);
    const id = "L" + seq.current++;
    /* 자수도 '방금 바뀐' 카드에 섞습니다 — 되돌리는 자리가 이미 거기라서 새 장치를 안 만듭니다 */
    notePress(id);
    /* 방장의 눈은 판에 있으니 판에서도 알립니다 — 그 칸이 잠깐 금색으로 번쩍입니다 */
    setConfessFx({
      rowId: row.id,
      colId: col.id,
      nick: seatName(row, rows.indexOf(row)),
      d,
      t: Date.now(),
    });
    appendLog({
      id,
      kind: "confess",
      rowId: row.id,
      colId: col.id,
      n: d,
      delta: gold,
      name: seatName(row, rows.indexOf(row)),
      item: col.name,
      after,
    });
  };
  /* 소켓 핸들러는 한 번만 만들어지므로, 최신 함수를 거울로 들고 갑니다 */
  const scribeRef = useRef({});
  scribeRef.current = {
    confess: applyConfess,
    refresh: refreshMembers,
    lobbyOn,
    /* 판 도중 합류자가 자리를 골랐습니다 (§3.2) — 서버가 원본이고, 여기서는 자리와
       줄을 그 선택에 맞춥니다. 서버 왕복은 없습니다(local) — 이미 서버가 앉혔습니다 */
    seat: (acct, nick, rowId) => {
      seatMember(acct, nick, rowId, { local: true });
      sayJoin(nick || acct, rowId);
    },
    /* 닉 변경 — 표시 이름은 방장 장부의 것입니다 (§3.2). 방장이 손대지 않은 자리만
       따라 바뀌고, 방장이 고쳐 둔 이름은 안 건드립니다 */
    nick: (acct, nick) => {
      setMembers((prev) => prev.map((m) => (m.acct === acct ? { ...m, nick } : m)));
      const hit = seats.find((s) => s.acct === acct);
      if (!hit || hit.named) return;
      putSeats((prev) => prev.map((s) => (s.id === hit.id ? { ...s, name: nick } : s)));
      setRows((prev) => prev.map((x) => (x.id === hit.id ? { ...x, name: nick } : x)));
    },
    join: (m) => {
      if (!m || !m.acct) return refreshMembers();
      if (m.st === "req") {
        /* 표 아래 줄에 섭니다 (2026-09-06) — 카드는 폐기, 토스트 한 번(8초). 방장의 눈은 항목에 가 있어서 한 번은 말해 줍니다 */
        if (m.inv)
          say((m.nick || m.acct) + "님이 초대를 받고 왔는데 자리가 없어요 — 인원 수를 늘리면 앉아요.", 8000);
        else if (m.kicked) say((m.nick || m.acct) + "님이 다시 들어오려 해요 — 표 아래에서 받아 주세요.", 8000);
        else say((m.nick || m.acct) + "님이 들어오려는데 자리가 없어요 — 표 아래에서 받아 주세요.", 8000);
      } else if (m.st === "ok") {
        /* 시작 전엔 명단을 보는 효과가 앉힙니다 — 여기서도 앉히면 두 번 앉습니다. 진행 중엔 표 아래에 서니 한 번 말해 줍니다 (2026-09-06).
           (폐기 2026-09-06) 여기서 닉 일치·자리표시 줄에 바로 앉히던 것 */
        if (roundLive && !seats.some((k) => k.acct === m.acct) && !ownRowOf(m.acct))
          say((m.nick || m.acct) + "님이 들어왔어요 — 표 아래에서 받아 주세요.", 8000);
      }
      refreshMembers();
    },
    lobby: (lb) => {
      if (!lb) return;
      setLobbyOn(!!lb.open);
      if (lb.cap) setLobbyCap(lb.cap);
    },
    /* 중단·이어가기 — 다른 기기에서 눌렀거나 자동 중단이 걸렸을 때 여기로 옵니다 */
    paused: (p) => setPaused(p || null),
  };

  /* --- 서기 소켓: 로그인해서 방이 있는 동안 상시 연결 ---
     송출 토글과 상관없습니다 (§5.7). 이 소켓이 곧 "방장이 앉아 있다"이고 파티원의
     자수가 이걸 타고 옵니다 — 방송을 안 띄운다고 자수가 멈출 이유가 없습니다 */
  useEffect(() => {
    if (readOnly || !auth || !relay.room) return;
    let ws = null,
      beat = null,
      wait = 1000,
      stop = false;
    const connect = () => {
      if (stop) return;
      try {
        ws = new WebSocket(
          `${WS_BASE}/api/r/${relay.room}/scribe?s=${encodeURIComponent(auth.token)}`
        );
      } catch (e) {
        setTimeout(connect, wait);
        return;
      }
      ws.onopen = () => {
        setScribeLive(true);
        wait = 1000;
      };
      beat = setInterval(() => {
        if (ws && ws.readyState === 1) ws.send("ping");
      }, 50000);
      ws.onmessage = (ev) => {
        if (ev.data === "pong") return;
        let m = null;
        try {
          m = JSON.parse(ev.data);
        } catch (e) {
          return;
        }
        if (!m || !m.kind) return;
        if (m.kind === "members" && !tutorialRef.current) setMembers(Array.isArray(m.list) ? m.list : []);
        else if (m.kind === "join") scribeRef.current.join(m.member || m);
        else if (m.kind === "left") scribeRef.current.refresh();
        /* 파티원 소켓이 붙거나 끊겼습니다 — 표의 아이디 표시가 흐려지고 돌아옵니다 (§5.6) */
        else if (m.kind === "viewer")
          setMembers((prev) => prev.map((x) => (x.acct === m.acct ? { ...x, on: !!m.on } : x)));
        else if (m.kind === "nick") scribeRef.current.nick(m.acct, m.nick);
        else if (m.kind === "seat") scribeRef.current.seat(m.acct, m.nick, m.rowId);
        else if (m.kind === "lobby") scribeRef.current.lobby(m.lobby);
        else if (m.kind === "paused") scribeRef.current.paused(m.paused);
        else if (m.kind === "confess")
          scribeRef.current.confess(m.rowId, m.colId, m.dir != null ? m.dir : m.n);
      };
      ws.onclose = () => {
        clearInterval(beat);
        /* 우리가 갈아 끼우려고 닫은 소켓이면 여기서 상태를 건드리면 안 됩니다 —
           옛 소켓의 close 가 새 소켓의 open 보다 늦게 오면 방 칩이 '연결 끊김'에 눌어붙습니다 */
        if (stop) return;
        setScribeLive(false);
        setTimeout(connect, wait);
        /* 서기가 끊긴 동안은 파티원의 자수가 통째로 막힙니다 — 오래 기다리면 안 됩니다 */
        wait = Math.min(wait * 2, 4000);
      };
      ws.onerror = () => {
        try {
          ws.close();
        } catch (e) {}
      };
    };
    connect();
    return () => {
      stop = true;
      clearInterval(beat);
      setScribeLive(false);
      try {
        if (ws) {
          ws.onclose = null;
          ws.onerror = null;
          ws.onmessage = null;
          ws.close();
        }
      } catch (e) {}
    };
  }, [readOnly, auth && auth.token, relay.room]);

  /* 로그인해 두면 어느 기기든 로비·중단 상태가 따라옵니다 — 서버가 원본입니다 (§0-7) */
  useEffect(() => {
    if (readOnly || !auth || !relay.room) return;
    let gone = false;
    roomApi
      .myRoom(auth.token)
      .then((r) => {
        if (gone || !r) return;
        if (r.lobby && r.lobby.open) {
          setLobbyOn(true);
          if (r.lobby.cap) setLobbyCap(r.lobby.cap);
        }
        /* 자동 중단은 방장이 앱을 닫아 둔 사이에 걸립니다 — 다시 열 때 여기서 만납니다 */
        setPaused(r.paused || null);
        if (r.invite && r.invite.code)
          putRelay({ ...relayRef.current, invite: { code: r.invite.code, exp: r.invite.exp } });
        refreshMembers();
      })
      .catch(() => {});
    return () => {
      gone = true;
    };
    /* 방이 나중에 붙는 길이 있습니다 — 다른 기기에서 로그인하면 askResume 이 그때 잇습니다.
       방 id 를 안 보면 그 기기에서는 로비·중단·명단이 영영 안 실립니다 (§3-4) */
  }, [auth && auth.token, relay.room]);

  /* 오버레이가 그릴 순위표 — 금액 계산은 앱이 합니다. 서버에 그 로직을 또 두면
     단가 결정화(sums)까지 두 곳에서 관리하게 돼서요. */
  /* 정산에 잡히는 사람은 오버레이에도 나와야 합니다. 이름을 아직 안 넣었어도
     벌금이 있으면 정산 인원이라, 이름으로 거르면 화면이 통째로 비어 버립니다. */
  /* 오버레이는 정산 인원을 그대로 비춥니다 — 여기서 한 명이라도 빠지면 방송의 총액이
     장부와 안 맞습니다. 이름이 빈 사람이 둘 이상이면 줄 번호를 붙여 구분합니다
     (오버레이가 이름으로 순위 변동을 추적해서, 같은 이름이 겹치면 안 됩니다). */
  /* 오버레이 금액은 정산 장부와 같은 기준으로 더합니다. itemGold 는 카운터의 항목
     열(cols)만 보는데, 메모장 모드의 금액은 counts.simple 에 있어 늘 0이 됐습니다.
     activeCols 는 메모장이면 금액 열 하나, 카운터면 기존 항목 열입니다.
     기타 벌금을 메모장에서 빼는 것도 장부와 같은 규칙(withExtras = !simple)입니다. */
  const boardGold = (row) =>
    activeCols.reduce((a, c) => a + cellGold(row, c.id, Math.round(goldOf(c.price))), 0) +
    (simple ? 0 : extraSum(row));
  const boardOf = () => {
    /* 순액 = 받을 몫 − 낸 벌금. 방송에서 "지금 누가 얼마 뱉고 누가 얼마 받나"가
       한눈에 보이라고 정산 장부와 같은 값을 그대로 실어 보냅니다. */
    const nets = (r && r.nets) || [];
    return rows.map((x, i) => ({
      n: seatName(x, i),
      /* 줄 고유번호 — 오버레이가 줄을 이름으로 구분하면 닉이 겹칠 때 번쩍임·이동표시가
         남의 줄에 붙습니다 (2026-09-05 버그). 이름은 그리는 데만 쓰고 구분은 이걸로 */
      k: x.id,
      g: Math.max(0, boardGold(x)),
      /* 항목별 횟수. 이름은 위(cols)에 한 번만 적고 여기는 순서대로 숫자만 —
         오버레이가 표처럼 열을 맞춰 그립니다. 메모장 모드는 항목이 하나뿐이라 안 보냅니다 */
      c: ovCols().map((col) => num(x.counts[col.id])),
      d: Math.round(nets[i] || 0),
    }));
  };

  /* 방송 화면에 띄울 룰렛 상태. 도는 동안만 있고 끝나면 사라집니다. */
  /* 방송에는 판 전체를 한 번에 보냅니다. 오버레이가 제 시계로 돌려서,
     서기가 앱에서 건너뛰어도 방송의 속도감은 그대로 남습니다.
     걸음마다 보내면 건너뛰기가 그대로 방송에 튀어 버립니다. */
  const spinOut = () => {
    if (!spin) return null;
    return {
      sid: spin.sid,
      who: (spin.who || "").trim() || "이름 없음",
      item: spin.item || "룰렛",
      faces: spin.faces || [],
      w: spin.w || {},
      look: spin.look || "wheel",
      theme: spin.theme || "satin",
      spd: spin.spd || "slow",
      /* 감속 (2026-09-07) — 룰렛은 방장 것이라 파티원 화면도 이 값으로 돕니다.
         안 싣던 동안 파티원 원판만 기본 감속으로 돌았습니다 */
      roll: spinRoll(spin),
      /* 랜덤 양도면 사람 원판도 같이 — 방송과 파티원 화면이 같은 장면을 봅니다 */
      pass2: spin.pass2 ? { faces: spin.pass2.faces, name: spin.pass2.name } : null,
      /* free 일 때는 아직 답이 없습니다 — 받는 쪽은 끝없이 돌기만 합니다 */
      steps: (spin.steps || []).map((x) => ({ k: x.k, m: x.mult })),
      n: spin.res ? spin.res.n : 0,
      gold: spin.res ? Math.round(spin.priceG * spin.res.count) : 0,
      pass: !!(spin.res && spin.res.pass),
      phase: spin.phase,
      /* 서기의 손 (2026-09-05) — 도는 중 세움(rolling:false + skipAt)·결과 없이 닫기(fast). 방송이 같은 박자로
         따라옵니다. (버그 기록) 이 셋을 안 실어 건너뛰기가 방송에 반영되지 않았다 */
      rolling: !!spin.rolling,
      skipAt: spin.skipAt == null ? null : spin.skipAt,
      fast: !!spin.fast,
      /* 사람 원판이 아직 답 없이 도는 중인지 — 받는 쪽도 같이 기다려야 합니다 */
      whoFree: !!spin.whoFree,
      /* 도는 규칙 — 방송 화면이 제 복사본을 들고 있으면 언젠가 어긋납니다.
         한쪽만 고쳐도 눈치채기 어려워서, 출처를 여기 하나로 둡니다.
         판이 없을 때는 안 실리니 평소 크기는 그대로입니다. */
      cfg: { free: FREE_MS, roll: spinRoll(spin), face: FACE_MS },
      /* 적용 결과 — 오버레이가 표 도착을 기다리지 않고 수식·벌금 변화를 그립니다.
         (표 푸시는 재생 종료와 경합할 수 있어서 믿을 시계가 못 됩니다) */
      out: spin.out
        ? { g: spin.out.gold, raw: spin.out.raw, after: spin.out.after, name: spin.out.name }
        : null,
    };
  };

  /* 오버레이 생김새 — 상태에 실어 보내면 파라미터 없는 기본 주소의 OBS가 즉시 갈아입습니다.
     주소에 테마를 직접 적은 쪽(공유 받은 방송인)은 그 파라미터가 우선이라 영향이 없습니다. */
  /* 방송에 띄울 열 — 순위·변동·이름은 늘 나가고, 항목 열·합계·순액은 하나씩 끕니다.
     꺼진 항목 열만 ov.off 에 적어 둡니다(기본은 켬). 항목 id 는 장부마다 달라서
     다른 파티로 가면 저절로 다 켜집니다 — 그 파티의 항목이 아니니 그게 맞습니다.
     ov.items 는 항목 전체를 한 덩어리로 끄던 옛 설정입니다. 열을 하나라도 만지면
     off 집합으로 옮겨 가고, 그전까지는 전 열이 꺼진 것으로 읽습니다. */
  const ovShow = () => {
    const ov = relay.ov || {};
    const legacyOff = ov.items === false && !ov.off;
    const off = ov.off || {};
    return {
      itemOff: (id) => legacyOff || off[id] === true,
      sum: ov.sum !== false,
      net: ov.net !== false,
      slide: ov.slide !== false, // 슬라이드 모드 — 기본 켬, 기존 사용자도 (2026-09-06 사용자 확정)
    };
  };
  /* 머리(cols)와 줄(c)이 같은 목록을 써야 방송 표의 열이 안 어긋납니다 */
  const ovCols = () => (simple ? [] : activeCols.filter((c) => !ovShow().itemOff(c.id)));
  /* 방송에 보낼 연출거리 — 누른 순서대로 마지막 몇 개. 오버레이가 id 로 중복을 걸러
     자기가 아직 안 보여 준 것만 재생합니다. 상태를 통째로 다시 보내도(재접속·새로고침)
     같은 카드가 두 번 뜨지 않는 건 그 id 덕분입니다.
     룰렛은 제 연출이 따로 있어 빼고, 기타·합계 수정은 "누가 무엇에"가 없어 뺍니다. */
  const fxOut = () => {
    if (!fxOn(relay)) return [];
    const isPress = (id) => {
      const o = log.find((x) => x.id === id);
      return !!o && (o.kind === "press" || o.kind === "confess");
    };
    const out = [];
    for (let i = log.length - 1; i >= 0 && out.length < FX_CAP; i--) {
      const e = log[i];
      /* 자수도 누름과 같은 카드로 나갑니다 — 방송에서 "누가 무엇에"는 같은 이야기입니다 */
      if ((e.kind === "press" || e.kind === "confess") && e.n)
        out.push({ i: e.id, k: e.n > 0 ? "add" : "sub", n: e.name, t: e.item, g: e.delta });
      /* 룰렛 결과 — 판이 바뀌는 것을 한 건으로 떼어 내는 카드입니다.
         이게 없으면 룰렛이 닫히는 순간 밀려 있던 변화가 한꺼번에 반영돼서,
         방금 본 판의 줄이 다른 줄과 같이 뛰어 어느 게 그 결과인지 못 가립니다. */
      else if (e.kind === "roulette" && e.delta)
        out.push({ i: e.id, k: "roul", n: e.name, t: e.item, g: e.delta });
      /* 비움도 카드로 나갑니다 — 숫자가 통째로 0이 되는 것을 파티원이 못 보고 지나치면
         자기 자수가 사라진 줄 압니다 (§3.4) */
      else if (e.kind === "clear")
        out.push({ i: e.id, k: "clear", n: e.name || "전체", t: e.item ? "비움 " + e.item : "비움", g: e.delta });
      /* 취소는 원래 카드가 눌림이었을 때만 — 안 보여 준 것을 되돌리는 카드는 뜻이 없습니다 */
      else if (e.kind === "cancel" && e.refId && isPress(e.refId))
        out.push({ i: e.id, k: "cancel", ref: e.refId, n: e.name, t: e.item, g: e.delta });
    }
    return out.reverse();
  };

  const lookOut = () => {
    const lk = relay.look || { t: "dark", alpha: 25 };
    /* line(헤어라인)은 판 테마에만 실립니다 — 서버는 해석 없이 그대로 나릅니다 */
    return isPanelLook(lk) ? { t: lk.t, bg: 100 - (lk.alpha ?? 25), ...(lk.line ? { line: 1 } : {}) } : { t: lk.t };
  };

  /* 뷰어가 그대로 3탭을 그릴 수 있도록 표 전체를 보냅니다 (기록은 뺍니다) */
  const liveSnapshot = () => ({
    v: 1,
    name: partyReg.active === DEFAULT_ROOM_LABEL ? "벌금 현황판" : partyReg.active,
    /* 이 판의 표 — 자리 id 는 판이 갈려도 그대로라, 판이 갈린 것은 이 값이 말합니다 */
    roundId,
    board: boardOf(),
    /* 오버레이 표의 열 머리 */
    cols: ovCols().map((c) => ({
      t: (c.name || "").trim() || "항목",
      r: isRoulette(c) ? 1 : 0,
    })),
    ovNet: ovShow().net,
    ovSum: ovShow().sum,
    ovSlide: ovShow().slide, // 슬라이드 모드 (2026-09-06)
    /* 벌금이 붙을 때의 연출 — 카드 대기열과 그 설정 */
    fx: fxOut(),
    fxSpd: fxOn(relay) ? "norm" : "off",
    /* 금액 변동은 스와이프 하나로 갑니다 — 칩은 판 밖으로 나가서 소스를 자르면
       사라지는데, 잘렸다는 게 티가 안 나서 배우기 어려웠습니다 */
    mvMode: "swipe",
    spin: spinOut(),
    /* 복구·이어가기가 이 스냅샷을 통째로 앉힙니다 — 기록·모드·메모까지 있어야 완전한 복원입니다 */
    full: {
      mode,
      cols,
      rows,
      feePercent,
      unit,
      splitMode,
      log: (log || []).slice(-200),
      memoFreeze,
      /* 판 이름 — 파티원의 로컬 기록에도 같은 이름으로 남게 (§3.4 여정표) */
      rname: roundName,
    },
    /* rowId↔이름 — 파티원 앱이 자기 줄(you.rowId)을 찾는 데 씁니다.
       a 는 "계정이 붙은 줄" 표시 하나뿐입니다 — 판 도중 합류자가 고를 수 있는 줄을
       가리는 데 쓰고, 아이디 자체는 절대 싣지 않습니다(화면이 통째로 송출됩니다, §3.1) */
    rows2: rows.map((x, i) => {
      const s = seatsRef.current.find((k) => k.id === x.id);
      return { rowId: x.id, n: seatName(x, i), a: s && s.acct ? 1 : 0 };
    }),
    /* 판이 없이 모으는 중일 때만 — 뷰어·오버레이가 순위표 대신 대기실을 그립니다 (§4.3).
       판이 살아 있으면 오버레이는 그 판을 비춥니다 (§3.4) — 판 도중에 사람을 들인다고
       방송의 벌금판이 대기실로 바뀌면 안 됩니다 */
    lobby: lobbyOn && !roundLive && !paused
      ? {
          /* 빈 칸은 대기실에 안 내보냅니다 — 밖에서 보는 사람에게 (모험가N) 자리표시는
             있지도 않은 참가자로 읽힙니다. 모인 사람과 적힌 이름만 셉니다 (§3.1) */
          n: lobbySeats.filter((s) => s.acct || (s.name || "").trim()).length,
          cap: lobbyCap,
          names: lobbySeats
            .map((s, i) => ({ s, i }))
            .filter(({ s }) => s.acct || (s.name || "").trim())
            .map(({ s, i }) => ({
              n: seatName2(s, i),
              live: !!s.acct,
              host: i === 0,
            })),
        }
      : undefined,
    look: lookOut(),
    t: Date.now(),
  });

  /* --- 방장: 바뀔 때마다 밀어 올립니다 (디바운스 300ms) --- */
  const pushTimer = useRef(null);
  const pushRef = useRef(null);
  pushRef.current = liveSnapshot;
  useEffect(() => {
    /* 송출 토글은 폐지했습니다 (§5.7) — 판이 있으면 나가고 없으면 안 나갑니다 */
    if (!canPush) return;
    /* 판이 닫혔거나 얼어 있으면 밀지 않습니다 — 서버에 남은 마지막 한 장(끝난 판·굳은 판)이
       파티원 화면과 오버레이의 그림입니다 (§3.4). 모으는 중이면 대기실을 밉니다 */
    if (!roundLive && !lobbyOn) return;
    clearTimeout(pushTimer.current);
    pushTimer.current = setTimeout(() => {
      roomApi
        .putState(auth.token, relay.room, pushRef.current())
        .catch(() => {
          /* 인터넷이 끊겨도 기록은 계속됩니다. 다음 변경 때 다시 시도합니다. */
        });
    }, 300);
    return () => clearTimeout(pushTimer.current);
  }, [canPush, relay.room, lobbyOn, lobbyCap, cols, rows, feePercent, unit, splitMode, relay.look, relay.ov, relay.fx, relay.mv,
      /* 연출거리는 기록에서 나옵니다 — 표가 안 바뀌는 취소도 방송에는 알려야 해서 */
      log.length,
      /* 대기실이 차오르는 것도 방송에 그대로 나갑니다 — 수가 같아도 사람이 바뀌면 다시 밉니다 */
      memberSig, seats, roundLive, roundId, paused,
      /* 룰렛은 판이 시작·끝날 때, 양도 대기로 바뀔 때, 그리고 적용 결과(out)가 생길 때.
         out 을 안 걸면 종료 푸시에 합쳐져 오버레이 재생이 끝난 뒤에야 도착합니다. */
      spin && spin.sid, spin && spin.phase, spin && !!spin.out, !spin,
      /* 건너뛰기·fast 도 밀어야 방송이 따라옵니다 (2026-09-05) */
      spin && spin.rolling, spin && spin.skipAt, spin && !!spin.fast]);

  /* 내 방송용 주소 새로 발급 — 옛 주소는 즉시 무효라 한 번 물어봅니다 */
  const obsReissue = async () => {
    if (!auth) return;
    try {
      const r = await authApi.obsReissue(auth.token);
      putAuth({ ...auth, obsToken: r.obsToken });
      say("새 주소를 발급했어요 — OBS 소스의 주소도 새것으로 바꿔 주세요.");
    } catch (e) {
      say(e.message);
    }
  };
  /* 끄기는 방송에 바로 티가 나는 일이라 한 번 물어봅니다. 켜기는 그냥 켜집니다.
     끄기 전에 마지막 한 장을 '끝났어요' 표시(end)와 함께 보냅니다 — 안 보내면 파티원은
     방장이 잠깐 자리를 비운 줄 알고, 판이 끝났다는 것을 알 길이 없습니다. */
  /* [정산 끝내기] — 결과지를 판 기록에 남기고 판을 닫습니다. **아무도 내보내지 않습니다** —
     정산 직후 전광판이 꺼지면 이상하니까요 (§3.4). 공유도 안 끕니다: 파티원 화면과
     오버레이에는 끝난 판이 그대로 뜹니다. 방장은 홈(로비)으로 갑니다. */
  const endRound = () => {
    clearTimeout(pushTimer.current);
    /* 마지막 한 장을 '끝났어요' 표시와 함께 보냅니다 — 안 보내면 파티원은 방장이 잠깐
       자리를 비운 줄 알고, 판이 끝났다는 것을 알 길이 없습니다 */
    if (auth && relay.room)
      roomApi
        .putState(auth.token, relay.room, { ...liveSnapshot(), end: 1 })
        .catch(() => {
          /* 못 보내도 이 브라우저의 장부는 그대로입니다 */
        })
        /* 끝내기 = 해산 (2026-09-06 모델) — 결과지 한 장이 먼저 가고, 그 다음 판이 없어집니다 */
        .then(() => roomApi.end(auth.token, relay.room).catch(() => {}));
    const nm = closeRound();
    setRoundLive(false);
    setRoundId("");
    setPaused(null);
    /* 이름은 그 판과 함께 기록으로 갔습니다 — 다음 판은 다시 그날 기본값입니다 (§3.1) */
    setRoundName(defaultRoundName());
    setTab("sheet");
    /* 판이 없어집니다 (2026-09-06 모델) — 서버는 명단·내보냄 표시·판 존재 표시를 비우고(/end), 여기서는 자리를 방장 줄만
       남깁니다. 남는 것은 결과지와 기본값뿐입니다. (폐기 2026-09-05) 모으기만 접고 사람·이름은 다음 대기실로 남기던 규칙 —
       다음 대기실에 지난 사람의 글자 이름이 서는 그림이 됐다 */
    setMembers([]);
    setLobbyOn(false);
    putSeats((prev) => prev.filter((s0, i) => i === 0 && !!s0.acct));
    boardOnRef.current = false;
    putRelay({ ...relayRef.current, boardOn: false });
    /* 끝낸 직후의 일은 장부 읽기·우편 보내기입니다 (§3.4 여정표) — 로비 직행이 아니라
       결과 화면을 거칩니다. 판 기록에 막 들어간 그 판을 열고, [닫기]가 나가는 문입니다 */
    if (typeof nm === "string") {
      setJustEnded(nm);
      openGen(nm);
    }
    courseHit("ended"); // 튜토리얼 7장 — 결과지로
  };
  const askEndRound = () => {
    courseHit("endask"); // 튜토리얼 7장
    /* 기록이 없으면 남길 결과지도 없습니다 — 판을 접고 로비로 (2026-09-05 ⑤). 끝내기의 도착지는 언제나 로비 */
    return !log.length
      ? setAsk({
          /* (폐기 2026-09-06) `아직 기록이 없어요. / 이 판을 접고 로비로 갈까요? 이름과 항목은 그대로 남아요.` [접기] —
             접기라는 세 번째 동사. 기록 없는 끝은 해산입니다 (초안) */
          title: "기록이 없어요 — 해산할까요?",
          body: "판이 없어지고 로비로 가요. 항목·단가·인원은 그대로예요.",
          action: "해산",
          tone: "danger",
          onYes: () => {
            endRound();
            go(VIEW_LOBBY);
          },
        })
      : setAsk({
          title: "이 판을 마감할까요?",
          body: "결과지가 판 기록에 남아요.",
          action: "정산 끝내기",
          onYes: endRound,
        });
  };
  /* [중단] — 아무것도 지우지 않고 얼립니다. 사람·셈·연결 그대로이고 [이어가기]로 돌아옵니다.
     방장 화면은 홈(로비)으로 물러나고, 거기 중단된 판 카드가 섭니다 (§3.1) */
  /* 손으로 얼리는 [중단]은 폐지했습니다 (§3.4) — 브라우저를 닫아도 판은 살아 있고,
     파티원에게 가는 말도 '방장이 자리를 비웠어요'와 사실상 같았습니다. 얼리는 일은
     무활동 24시간 자동 중단이 맡고, 이 앱이 하는 일은 [이어가기]로 되돌리는 것뿐입니다. */
  /* [이어가기] — 표시를 내리고, 파티원에게는 `판이 시작됐어요.` 카드가 갑니다(잡아채지 않음) */
  const resumeRound = async () => {
    if (!auth || !relay.room) return;
    setPaused(null);
    setRoundLive(true);
    try {
      await roomApi.resume(auth.token, relay.room);
      await roomApi.putState(auth.token, relay.room, { ...liveSnapshot(), resumed: 1 });
    } catch (e) {
      say(e.message);
    }
  };
  /* 끄기 확인창은 폐지했습니다 (§5.7) — 파티원도 자수도 안 건드리니 물어볼 것이
     없습니다. 되돌리는 것도 같은 스위치를 다시 누르는 것뿐입니다 */
  const askObsReissue = () =>
    setAsk({
      /* "언제 쓰는 문인지"도 여기서 말합니다 — 창의 설명 줄을 걷고 링크만 남겨서
         (2026-09-05), 설명은 누른 사람에게 그 자리에서 합니다 */
      title: "내 방송용 주소를 새로 발급할까요?",
      body: "주소가 새어 나갔을 때 써요. 지금 주소는 바로 못 쓰게 되고, OBS 소스의 주소를 새것으로 바꿔야 해요.",
      action: "새로 발급",
      /* 옛 주소는 그 자리에서 죽고 되돌릴 길이 없습니다 (§9-4) */
      tone: "danger",
      onYes: obsReissue,
    });

  /* --- 예시 방: 서버에 붙지 않고 예시 장부를 비춥니다. 몇 초마다 벌금이 붙어서
         장부와 우편이 실제로 다시 계산되는 것까지 보여 줍니다 --- */
  useEffect(() => {
    if (!readOnly || liveRoom !== DEMO_ROOM) return;
    if (DEMO_MEMBER) {
      /* 파티원 예시 — 방장 예시와 같은 판(방장·실리안·니나브·웨이, 잡힘 1회씩), 숫자는 누른 만큼만 움직입니다.
         열은 방장이 2장에서 만든 뒤와 같게 잡힘·죽음·암살 — 룰렛 없음 (2026-09-06 낮 사용자) */
      setCols([...DEFAULT_COLS.filter((c) => !isRoulette(c)), { id: "ctut", name: "암살", price: "100,000" }]);
      /* 4장 예시는 막 시작한 판이라 숫자가 없고, 초대장엔 방장만 앉아 있습니다(실리안이 링크를 눌렀을 때의 모습) */
      setRows(DEMO_CH4 ? TUT_ROWS(realNick() || "방장").map((r) => ({ ...r, counts: {} })) : TUT_ROWS(realNick() || "방장"));
      setOwnerNick(realNick() || "방장");
      if (DEMO_CH4) setVlobby({ names: [{ n: realNick() || "방장", live: true }], cap: 4 });
      setFeePercent("5");
      setUnit("10000");
      setSplitMode("pot");
      setLiveName("예시 파티");
      setLiveState("on");
      return;
    }
    setCols(DEFAULT_COLS);
    setRows(DEFAULT_ROWS);
    setFeePercent("5");
    setUnit("10000");
    setSplitMode("pot");
    setLiveName("현자들 (예시)");
    setLiveState("on");
    const t = setInterval(() => {
      setRows((rs) =>
        rs.map((r, i) =>
          i !== Math.floor(Math.random() * rs.length)
            ? r
            : {
                ...r,
                counts: {
                  ...r.counts,
                  c1: String(num(r.counts.c1) + 1 + Math.floor(Math.random() * 3)),
                },
              }
        )
      );
      setLiveTick((x) => x + 1);
    }, 4000);
    return () => clearInterval(t);
  }, []);

  /* 파티원 화면에도 방송과 같은 카드. 판이 바뀌는 건 보이는데 누가 뭘 눌렀는지는
     안 보이면, 같은 판을 보면서 한쪽만 이야기를 못 듣습니다. 자리만 구석으로 옮깁니다. */
  const [vcard, setVcard] = useState(null);
  const [vfxTick, setVfxTick] = useState(0);
  const vfxQ = useRef([]);
  const vfxSeen = useRef({});
  const vfxBoot = useRef(false);

  /* 효과 안에서 최신 재생 상태를 읽어야 해서 거울을 둡니다 */
  const vplayRef = useRef(null);
  vplayRef.current = vplay;
  /* 한 걸음씩 굴립니다 — 오버레이와 같은 흐름입니다 */
  useEffect(() => {
    if (!vplay) return;
    /* 양도 대기 중에는 여기서 아무것도 안 합니다 — 서기가 고를 때까지 띄워 둡니다 */
    if (vplay.over && vplay.sp.phase === "pick" && !vplay.sp.pass2) return;
    /* 답이 아직 없는 판도 마찬가지입니다 — 걸음을 세면 없는 결과(0)를 띄우게 됩니다.
       서기가 STOP 을 눌러 phase 가 바뀌면 이 효과가 다시 돌면서 그때부터 셉니다.
       사람 원판도 같습니다. */
    if (vplay.sp.phase === "free" || vplay.sp.whoFree) return;
    const sp2 = spinSpeed(vplay.sp.spd);
    const ms = vplay.rolling || vplay.who === "roll" ? spinRoll(vplay.sp) : vplay.over ? sp2.end : sp2.hold;
    const t = setTimeout(() => {
      setVplay((x) => {
        if (!x) return x;
        if (x.rolling) return { ...x, rolling: false };
        if (x.i + 1 < x.sp.steps.length) return { ...x, i: x.i + 1, rolling: true };
        /* 랜덤 양도면 사람 원판을 한 번 더 */
        if (x.sp.pass2 && !x.who) return { ...x, who: "roll" };
        if (x.who === "roll") return { ...x, who: "land" };
        if (!x.over) return { ...x, over: true };
        return null;
      });
    }, ms);
    return () => clearTimeout(t);
  }, [vplay && vplay.i, vplay && vplay.rolling, vplay && vplay.who, vplay && vplay.over, vplay && vplay.sp.phase, vplay && vplay.sp.whoFree, !vplay]);

  /* 카드는 한 장씩. 룰렛이 떠 있는 동안은 쉽니다 — 위층이 끝나야 아래가 움직입니다 */
  useEffect(() => {
    if (!readOnly || vcard || vplay || !vfxQ.current.length) return;
    setVcard(vfxQ.current.shift());
  }, [readOnly, vcard, vplay, vfxTick]);
  useEffect(() => {
    if (!vcard) return;
    /* 정정은 짧게, 밀리면 더 짧게 — 다 보여 주되 다음 것을 안 잡아먹습니다 */
    let hold = vcard.k === "cancel" || vcard.k === "sub" ? 1100 : 1600;
    if (vfxQ.current.length > 4) hold = Math.round(hold * 0.5);
    const t = setTimeout(() => setVcard(null), hold);
    return () => clearTimeout(t);
  }, [vcard]);

  /* 서기가 양도를 끝내면(판이 사라지면) 파티원 화면도 잠깐 뒤 닫습니다 */
  useEffect(() => {
    if (!vplay || !vplay.over || vin) return;
    const t = setTimeout(() => setVplay(null), spinSpeed(vplay.sp.spd).end);
    return () => clearTimeout(t);
  }, [!vin, vplay && vplay.over]);

  /* 재생이 끝나면 미뤄 둔 표를 반영합니다 */
  useEffect(() => {
    /* 판 기록을 열어 둔 동안은 그 판이 화면입니다 — 들어온 표로 덮으면 안 됩니다 */
    if (vplay || genView || !vpend.current) return;
    const st = vpend.current;
    vpend.current = null;
    /* 모드도 판의 일부입니다 (§3.4) — 미뤄 둔 표를 얹을 때도 같이 따라갑니다 */
    setMode(st.full.mode === "simple" ? "simple" : "items");
    setCols(st.full.cols || DEFAULT_COLS);
    setRows(st.full.rows || []);
    setFeePercent(st.full.feePercent || "5");
    setUnit(st.full.unit || "10000");
    setSplitMode(st.full.splitMode === "solo" ? "solo" : "pot");
    setLiveName(st.name || "");
    setLiveTick((t) => t + 1);
  }, [!vplay, genView]);

  /* ---------- 파티원: 마지막으로 받은 판을 담아 둡니다 ----------
     정산은 판이 끝난 뒤에 합니다 — 그 순간 화면이 비면 자기가 얼마 보내는지 못 봅니다.
     받을 때마다 판 전체와 신분증(방장 닉·파티원 전부·기간)을 함께 담습니다. */
  const persistTimer = useRef(null);
  const keepRound = (st) => {
    const f = (st && st.full) || {};
    if (!Array.isArray(f.rows) || !Array.isArray(f.cols)) return null;
    const rws = f.rows;
    const ids = rws.map((r) => r.id);
    const gid = typeof st.roundId === "string" ? st.roundId : "";
    const ts = (Array.isArray(f.log) ? f.log : []).map((e) => e.t).filter(Boolean);
    const prev = lastLive.current;
    /* 판이 갈렸는지는 roundId 가 말합니다 — 줄 id 는 자리 id 라 새 판에서도 안 바뀝니다.
       (roundId 를 안 싣는 옛 방장 앱이면 예전처럼 줄 id 가 통째로 바뀐 것으로 봅니다) */
    const split = gid
      ? !!prev && !!prev.gid && prev.gid !== gid
      : prev &&
        prev.ids.length &&
        ids.length &&
        !ids.some((id) => prev.ids.indexOf(id) >= 0);
    if (prev && prev.room === liveRoom && split) {
      if (archiveRef.current) archiveRef.current(prev);
    }
    const mine = you && you.rowId ? rws.find((r) => r.id === you.rowId) : null;
    const next = {
      room: liveRoom,
      ids,
      gid,
      host: ownerNick || (prev && prev.room === liveRoom ? prev.host : "") || "",
      me: mine ? seatName(mine, rws.indexOf(mine)) : (you && you.nick) || (auth && auth.nick) || "",
      mems: realNames(rws),
      from: ts.length ? Math.min.apply(null, ts) : 0,
      to: ts.length ? Math.max.apply(null, ts) : 0,
      full: {
        mode: f.mode || "items",
        cols: f.cols,
        rows: rws,
        feePercent: f.feePercent || "5",
        unit: f.unit || "10000",
        splitMode: f.splitMode === "solo" ? "solo" : "pot",
        log: Array.isArray(f.log) ? f.log : [],
        memoFreeze: f.memoFreeze || null,
      },
      t: Date.now(),
    };
    lastLive.current = next;
    /* 판이 밀려 올 때마다 저장하면 손이 걸립니다 — 잠깐 모았다 한 번 씁니다 */
    clearTimeout(persistTimer.current);
    persistTimer.current = setTimeout(() => saveLastLive(lastLive.current), 1200);
    return next;
  };
  const keepRef = useRef(null);
  keepRef.current = keepRound;
  /* 판이 끝났습니다 — 화면은 그대로 두고 자수만 거둡니다. 그리고 판 기록에 넣습니다 */
  const finishRound = () => {
    const kept = lastLive.current;
    if (!kept || !kept.full || kept.room !== liveRoom) return;
    clearTimeout(persistTimer.current);
    saveLastLive(kept);
    if (archiveRef.current) archiveRef.current(kept);
    setVlobby(null);
    setStartCard(null); // 끝난 판에 '다시 시작됐어요' 카드가 남아 있으면 안 됩니다
    setEnded(true);
  };
  const finishRef = useRef(null);
  finishRef.current = finishRound;

  /* ================= 파티원 =================
     #o=TOKEN 은 방을 모른 채 들어옵니다 — resolve 로 지금 들어가 있는 방을 찾습니다.
     denied 로 닫히면 방이 바뀌었을 수 있으니 60초마다 처음부터 다시 봅니다. */
  useEffect(() => {
    if (!obsEntry) return;
    let gone = false;
    const find = () => {
      authApi
        .resolveObs(obsEntry)
        .then((r) => {
          if (gone || !r || !r.roomId) return;
          setLiveRoom(r.roomId);
          setDenied(null);
        })
        .catch(() => {
          /* 방송 화면에 에러를 그리지 않습니다 — 조용히 다시 봅니다 */
          if (!gone) setLiveState("empty");
        });
    };
    find();
    const t = setInterval(find, 60000);
    return () => {
      gone = true;
      clearInterval(t);
    };
  }, [obsEntry]);

  /* 서버에 붙을 때 쓸 자격 — 로그인 세션 > 내 방송용 주소 > 초대 코드 순.
     세션이 있으면 초대가 만료돼도 계속 보이고, 없으면 초대가 읽기 권한을 나릅니다. */
  /* 로그인 상태라도 초대 코드는 같이 보냅니다 (2026-09-05) — 초대장을 거치는 동안은 아직 멤버가 아니라,
     세션만으로는 소켓이 거절됩니다("권한이 없어요"). 코드가 읽기 권한을 나릅니다 */
  const wsCred = auth
    ? "s=" + encodeURIComponent(auth.token) + (joinCode ? "&j=" + joinCode : "")
    : obsEntry
    ? "o=" + encodeURIComponent(obsEntry)
    : joinCode
    ? "j=" + joinCode
    : "";
  /* 로비가 열려 있으면 대기실을 그립니다 (state.lobby) */
  const [vlobby, setVlobby] = useState(null);

  /* 자동 입장 — 로그인만 하면 수락 없이 대기실에 들어갑니다.
     스스로 나간 사람은 다시 안 넣습니다 — 안 그러면 [나가기]가 무슨 뜻인지 없어집니다. */
  const [left, setLeft] = useState(false);
  /* 판의 끝을 갈라 읽는 데 씁니다 (2026-09-06 모델) — 대기실이었으면 해산(로비+쪽지), 결과지면 띠 */
  const vlobbyRef = useRef(null);
  vlobbyRef.current = vlobby;
  const ownerNickRef = useRef("");
  ownerNickRef.current = ownerNick;
  const endedRef = useRef(false);
  endedRef.current = ended;
  /* 결과지를 켜 둔 채 방장이 새 판을 만들었을 때 — 띠의 두 번째 얼굴 [들어가기] */
  const [boardOpened, setBoardOpened] = useState(false);
  const [rejoinTick, setRejoinTick] = useState(0);
  const joinTried = useRef("");
  /* 입장이 서버에 닿기 전에 소켓이 먼저 닿으면 아직 멤버가 아니라 거절당합니다.
     그건 권한 문제가 아니라 순서 문제라, 거절을 붙잡아 두지 않고 다시 붙습니다. */
  const joining = useRef(false);
  /* 붙는 순간 서버가 최신 판을 한 장 보내 줍니다 — 자리에 앉자마자 한 번 다시 붙어서
     사이에 놓쳤을지 모르는 푸시를 메웁니다 */
  const [sockGen, setSockGen] = useState(0);
  useEffect(() => {
    if (!readOnly || !auth || !liveRoom || liveRoom === DEMO_ROOM || !joinCode || left || !joinOk) return;
    if (you || joinTried.current === liveRoom + joinCode) return;
    joinTried.current = liveRoom + joinCode;
    joining.current = true;
    roomApi
      .join(auth.token, liveRoom, joinCode)
      .then((r) => {
        joining.current = false;
        setDenied(null);
        /* 이 방의 코드를 기억합니다 (2026-09-06) — 로비에서 [돌아가기]로 올 때 주소에 실어, 판이 끝난 뒤에도 코드 뷰어로
           붙어 새 판 열림을 받고 [들어가기]가 같은 문을 지나게. (버그 기록) 코드 없이 돌아오면 끝난 뒤 소켓이 거절돼 띠가 안 바뀌었다 */
        try {
          localStorage.setItem("goldSettlement.joincode." + liveRoom, joinCode);
        } catch (e) {}
        const y = r.you || { nick: auth.nick, rowId: null, st: r.st || "ok" };
        setYou({
          nick: y.nick || auth.nick,
          rowId: y.rowId || null,
          st: y.st || r.st || "ok",
          kicked: !!y.kicked,
          full: !!y.full,
        });
        setSockGen((n) => n + 1);
      })
      .catch((e) => {
        joining.current = false;
        /* 문은 판이 있을 때만 (2026-09-06 모델) — 코드는 맞는데 판이 없으면 한 줄짜리 카드 */
        if (e && e.status === 409 && e.code === "no party") setDenied("noparty");
        else if (e && e.status === 409) say("대기실이 가득 찼어요. 방장에게 정원을 늘려 달라고 해주세요.");
        /* 코드가 지난 것과 애초에 안 맞는 것은 사람이 할 일이 같아도 말이 다릅니다 (§8) */
        else if (e && e.status === 403) setDenied(e.code === "expired" ? "expired" : "invite");
      });
  }, [readOnly, auth && auth.token, liveRoom, joinCode, !!you, left, joinOk, rejoinTick]);

  /* 나가기 = 탈퇴 → 로비 (§3.4 여정표). 화면만 벗어나는 길은 브랜드(goLobby)이고 그건 자리를
     건드리지 않습니다. 신청 중([신청 취소])은 물을 것이 없어 바로 물러납니다.
     (폐기 2026-09-05) 나간 뒤 "대기실에서 나왔어요 + [다시 참여]" 잔류 상태 — 시체 화면이었다 */
  const leaveNow = () => {
    roomApi.leave(auth.token, liveRoom).catch(() => {});
    joinTried.current = "";
    try {
      sessionStorage.setItem("gs-left", "1");
    } catch (e) {}
    saveLastLive(null);
    leaveToLobby();
  };
  const leaveRoom = () => {
    if (!auth || !liveRoom) return;
    /* 시작 전은 묻지 않습니다 (2026-09-06) — 링크로 다시 들어오면 그만. 진행 중은 방장 손 없이는 못 돌아오니 한 번 묻습니다 (초안).
       (폐기 2026-09-06) `다시 들어오려면 초대나 신청이 필요해요.` */
    if ((you && you.st === "req") || vlobby) return leaveNow();
    setAsk({
      title: "파티에서 나갈까요?",
      body: "벌금 기록은 남아요. 다시 들어오려면 방장이 앉혀 줘야 해요.",
      action: "나가기",
      tone: "danger",
      onYes: leaveNow,
    });
  };
  /* 로비의 [나가기] (2026-09-06) — 대기실·판 안의 [파티 나가기]와 같은 동사. 진행 중이면 한 번 묻습니다 */
  const leaveFromLobby = async () => {
    if (!auth || !meCur) return;
    await roomApi.leave(auth.token, meCur).catch(() => {});
    saveLastLive(null);
    setMeSeat(null);
    setMeCur(null);
  };
  const askLeaveFromLobby = () => {
    if (!(meSeat && meSeat.round)) return leaveFromLobby();
    setAsk({
      title: "파티에서 나갈까요?",
      body: "벌금 기록은 남아요. 다시 들어오려면 방장이 앉혀 줘야 해요.",
      action: "나가기",
      tone: "danger",
      onYes: leaveFromLobby,
    });
  };
  /* 시작 전에 해산당한 쪽지 (2026-09-06) — 로비 파티 카드에 ×로 지울 때까지 */
  const [disbandNote, setDisbandNote] = useState(() => {
    try {
      const v = JSON.parse(localStorage.getItem("goldSettlement.disbandNote") || "null");
      return v && typeof v === "object" ? v : null;
    } catch (e) {
      return null;
    }
  });
  const dropDisbandNote = () => {
    setDisbandNote(null);
    try {
      localStorage.removeItem("goldSettlement.disbandNote");
    } catch (e) {}
  };

  /* ---------- 함께한 사람·지목 초대·노크 (§3.3 라운드 B) ----------
     남의 판에 들어가는 것은 주소로 정해집니다 — 뷰어인지는 부트가 읽으므로
     주소에 방을 적고 다시 엽니다 (끝난 파티를 닫는 [닫기]와 같은 길입니다). */
  /* 도착(자동 입장)은 replace, 사람이 누른 문([돌아가기]·초대 수락)은 push — 뒤로가기가 로비로 돌아오게.
     뷰어인지는 부트가 정하므로 어느 쪽이든 다시 엽니다(push 는 hashchange 핸들러가 리로드) */
  const enterRoom = (room, opts) => {
    if (typeof window === "undefined" || !room) return;
    saveLastLive(null);
    /* 기억해 둔 코드가 있으면 같이 싣습니다 (2026-09-06) — 초대장은 이미 지났으니 건너뜁니다 */
    let code = "";
    try {
      code = localStorage.getItem("goldSettlement.joincode." + room) || "";
      if (code) sessionStorage.setItem("gs-joinok", room + code);
    } catch (e) {}
    const h = LIVE_KEY + "=" + room + (code ? "&" + JOIN_KEY + "=" + code : "");
    if (opts && opts.push && canOwnUrl && window.location.hash.replace(/^#/, "") !== h) {
      window.location.hash = h;
      return;
    }
    const { pathname, search } = window.location;
    window.history.replaceState(null, "", pathname + search + "#" + h);
    window.location.reload();
  };
  /* 브랜드 = 로비 문 (§3.0, 표준 홈 버튼 문법). 파티 화면(뷰어)에서는 해시를 걷고 다시 엽니다 —
     자리는 그대로고, 이 세션에선 자동 입장을 건너뛰게 표시를 남깁니다 (§5.1) */
  /* 화면 이동이라 push — 뒤로가기가 판으로 돌아옵니다. 뷰어면 파티 열쇠가 걷혀 hashchange 가 다시 엽니다 */
  const goLobby = () => go(VIEW_LOBBY);
  /* 초대 주소·코드로 들어갑니다 (§3.0 파티 카드 — 비밀 파티 입장 문법). 주소면 방과 코드가
     다 있고, 코드만이면 서버가 방을 찾아 줍니다(§4 보충 c: 색인). 로그인은 뷰어가 초대장에서
     받습니다 — 여기서 묻지 않습니다 */
  const joinByCode = async (raw, opts) => {
    const txt = String(raw || "").trim();
    if (!txt) return;
    /* 앉은 파티가 있으면 옮기는 것입니다 — 한 번 묻고 나간 뒤 갑니다 (방 하나 규칙, 2026-09-07; 문구 초안) */
    if (!readOnly && seatedNow && !(opts && opts.left))
      return setAsk({
        title: seatedName + "에서 나가고 옮길까요?",
        body: meSeat && meSeat.round ? "그 파티의 내 자리가 비어요. 벌금은 줄에 남아요." : "그 파티의 내 자리가 비어요.",
        action: "나가고 옮기기",
        tone: "danger",
        onYes: async () => {
          await leaveFromLobby();
          joinByCode(raw, { left: true });
        },
      });
    const m = txt.match(/\/r\/([A-Z0-9]{4,16})(?:.*?[#&?]j=([A-Z0-9]{8}))?/i);
    let room = m ? m[1].toUpperCase() : null;
    let code = m && m[2] ? m[2].toUpperCase() : null;
    if (!room) {
      const bare = txt.replace(/[\s-]/g, "").toUpperCase();
      if (!/^[A-Z0-9]{8}$/.test(bare)) return say("초대 코드나 초대 주소를 붙여넣어 주세요.");
      try {
        const r = await roomApi.resolveJoin(bare);
        room = r && r.roomId;
        code = bare;
      } catch (e) {
        return say("이 초대는 쓸 수 없어요 — 방장에게 새 초대를 받아 주세요.");
      }
    }
    if (!room || typeof window === "undefined") return;
    saveLastLive(null);
    const h = LIVE_KEY + "=" + room + (code ? "&" + JOIN_KEY + "=" + code : "");
    /* 로비에서 [참여하기]를 이미 눌렀습니다 — 초대장을 한 번 더 거치지 않게 표시 (§3.3) */
    try {
      sessionStorage.setItem("gs-joinok", room + (code || ""));
    } catch (e) {}
    /* 사람이 누른 문이라 push — 뒤로가기가 로비로 돌아옵니다. hashchange 핸들러가 뷰어로 다시 엽니다 */
    if (canOwnUrl && window.location.hash.replace(/^#/, "") !== h) {
      window.location.hash = h;
      return;
    }
    const { pathname, search } = window.location;
    window.history.replaceState(null, "", pathname + search + "#" + h);
    window.location.reload();
  };
  /* (폐기 2026-09-05) 지목 초대 보내기(sendInvite·inviteMate)와 노크(knockMate) — 함께한 사람 UI 를
     걷으면서 부르는 쪽 함수도 지웠다 (§3.3). 받는 쪽(takeInvite·InviteCard)은 서버 호환으로 남는다 */
  /* 받은 초대를 수락합니다 — 서버 명단이 바로 ok 라 방장 수락을 기다리지 않습니다.
     지난 초대는 여기서 403 으로 돌아오고, 그때 §8 만료 문구를 띄웁니다 */
  const takeInvite = async (iv, leaveFirst) => {
    if (!auth) return;
    if (leaveFirst && liveRoom) await roomApi.leave(auth.token, liveRoom).catch(() => {});
    let r;
    try {
      r = await roomApi.joinInvited(auth.token, iv.room);
    } catch (e) {
      setInvites((prev) => prev.filter((x) => x.from !== iv.from));
      say("초대 시간이 지났어요. 다시 초대해 달라고 해주세요.");
      return;
    }
    enterRoom(iv.room, { push: true });
    /* 부를 때는 자리가 있었는데 오는 사이 찼습니다 — 튕기지 않고 문 앞에 섰습니다 (§3.3).
       아무 말이 없으면 "수락했는데 왜 안 앉지"가 되므로 그 자리에서 알립니다 */
    if (r && r.st === "req")
      say("자리가 다 차서 문 앞에서 기다려요 — 방장이 자리를 만들면 들어가요.");
  };
  const acceptInvite = (iv) => {
    /* 이미 딴 파티에 있으면 수락은 곧 옮기는 것입니다 — 한 번 물어봅니다 (§8) */
    if (viewer && liveRoom && liveRoom !== iv.room && you)
      return setAsk({
        title: (iv.fromNick || iv.from) + "님의 파티로 옮길까요?",
        body: "지금 파티에서 나가고 옮겨요.",
        action: "옮기기",
        onYes: () => takeInvite(iv, true),
      });
    takeInvite(iv, false);
  };
  /* 거절은 기록도 차단도 아닙니다 — 이 화면에서 치우기만 합니다 (§3.3) */
  const denyInvite = (iv) => setInvHide((prev) => ({ ...prev, [iv.from]: iv.t || 1 }));
  /* 지금 보여 줄 초대 — 서버가 신선한 것만 싣고, 거절한 것은 여기서 뺍니다 */
  const liveInvites = invites.filter((x) => x && invHide[x.from] !== (x.t || 1));
  /* 되돌리기 칩 (2026-09-07 사용자 확정) — 항목마다 {n, t}: 서버가 200 을 준 순간 서버 규칙 그대로 적습니다.
     새로 누르면 t=지금(30초가 다시 차고), 창 안의 −1 은 n 을 하나 줄입니다. 칩은 n>0 이고 창 안일 때만 서고 0.5초마다 다시 셉니다 */
  const cfRef = useRef({});
  const [, setCfTick] = useState(0);
  const noteCf = (colId, dir) => {
    const now = Date.now();
    const cf = cfRef.current[colId] || { n: 0, t: 0 };
    cfRef.current[colId] =
      dir > 0 ? { n: (now - cf.t > CONFESS_UNDO_MS ? 0 : cf.n) + 1, t: now } : { n: Math.max(0, cf.n - 1), t: cf.t };
    setCfTick((t) => t + 1);
  };
  const cfLeft = (colId) => {
    const cf = cfRef.current[colId];
    if (!cf || cf.n <= 0) return 0;
    return Math.max(0, CONFESS_UNDO_MS - (Date.now() - cf.t));
  };
  /* 자수 — 낙관 갱신을 하지 않습니다. 방장이 장부에 적고 푸시로 돌아온 것만 화면에 뜹니다 */
  const sendConfess = (rowId, colId, dir) => {
    if (!auth || !liveRoom) return;
    /* 지금 판에 없는 항목으로는 안 보냅니다 — 방장 장부에 적힐 곳이 없는 자수는
       서버까지 갔다가 조용히 버려집니다(유령 자수) */
    if (!cols.some((c) => c.id === colId)) return;
    setConfessErr("");
    if (DEMO) {
      /* 파티원 예시 — 서버 없이 내 줄만 움직입니다. 같이 해보기 9걸음(누르기) */
      setRows((prev) => prev.map((r) => (r.id === rowId ? { ...r, counts: { ...r.counts, [colId]: String(Math.max(0, num(r.counts[colId]) + dir)) } } : r)));
      if (dir < 0) say("자수를 정정했어요 — 방금 것을 되돌렸어요.");
      noteCf(colId, dir);
      if (tutorialRef.current) tutHit((dir > 0 ? "confess:" : "unconfess:") + colId); // 파티원 튜토리얼 1·3·4걸음
      return;
    }
    roomApi
      .confess(auth.token, liveRoom, rowId, colId, dir)
      .then(() => {
        noteCf(colId, dir);
        /* 되돌린 본인에게도 한 줄 — 숫자만 줄면 "잘못 눌렀나"가 됩니다 (2026-09-05, §8 초안) */
        if (dir < 0) say("자수를 정정했어요 — 방금 것을 되돌렸어요.");
      })
      .catch((e) => {
      /* 되돌리기 창(30초)을 넘긴 −1 — 서버가 거릅니다 (§3.6, 2026-09-05). 문구는 §8 초안 */
      if (e && e.code === "late")
        /* 토스트로 (2026-09-07 사용자) — 쪽지로 띄우면 생겼다 사라지며 화면이 통째로 밀렸다 */
        return say("자수는 30초 안에만 되돌릴 수 있어요 — 그 뒤는 방장에게 말해 주세요.", 5000);
      if (e && (e.status === 409 || e.code === "scribe-off")) {
        setScribeOn(false);
        setConfessErr("방장이 자리를 비웠어요 — 돌아오면 다시 누를 수 있어요.");
      } else setConfessErr(e.message || "지금은 누를 수 없어요.");
    });
  };
  /* 판 도중 합류 — 어느 줄이 나인지 본인이 고릅니다 (§3.2). 계정 안 붙은 줄만
     후보이고, 고른 줄에 쌓인 벌금은 그대로 이어받습니다. 한 번 고르면 서버가
     잠그고, 바꾸는 길은 방장의 [자리 바꾸기]뿐입니다 */
  const [claimBusy, setClaimBusy] = useState(false);
  const freeRows = rows.filter((r) => {
    const m = rows2v.find((x) => x.rowId === r.id);
    return m && !m.a;
  });
  /* 이름 적힌 빈 줄과 자리표시 빈 줄 — 자리표시 줄은 [새 자리] 하나로 묶습니다 (§3.2, 2026-09-05) */
  const namedFree = freeRows.filter((r) => !isFillName(seatName(r, rows.indexOf(r))));
  const blankFree = freeRows.filter((r) => isFillName(seatName(r, rows.indexOf(r))));
  const claimRow = async (rowId) => {
    if (!auth || !liveRoom || claimBusy) return;
    setClaimBusy(true);
    setConfessErr("");
    try {
      const r = await roomApi.seat(auth.token, liveRoom, rowId);
      if (r && r.you) setYou(r.you);
    } catch (e) {
      setConfessErr(
        e && e.status === 409
          ? "그 줄은 방금 다른 사람이 가져갔어요 — 다른 줄을 골라 주세요."
          : (e && e.message) || "지금은 고를 수 없어요."
      );
    }
    setClaimBusy(false);
  };
  /* 파티원 화면의 갈래 — 배너와 표가 이 셋으로 갈립니다 */
  const demoRoom = liveRoom === DEMO_ROOM;
  const guestLobby = readOnly && !genView && !!vlobby;
  /* 무효·만료 초대 — 보여 줄 판이 아예 없습니다. 빈 벌금표 위에 배너를 얹으면 "표가 있는데
     안 보이는" 것처럼 읽히므로, 안내 화면 하나만 세웁니다 (§8) */
  /* 내보내진 사람 — you:null 이 오면 읽기 전용 표를 남기지 않고 카드 하나로 (2026-09-05, 사용자 제안:
     막힌 사람은 로비나 원래 파티로 돌려보내는 문이 있어야 한다) */
  const guestBlocked = readOnly && !genView && !!denied && (!ended || denied === "noparty");
  const blockedCard = guestBlocked || (kickedOut && readOnly && !genView);
  /* 초대장 (§5.3, 2026-09-05) — 코드 붙은 링크로 온 비로그인. 읽기 전용 벌금표 위의 배너 대신
     누가 부르는지와 문 하나. [참여하기] → 시작하기 랜딩 → 자동 착석(§3.3) */
  /* 끝난 판이 마지막 한 장이어도 초대장이 먼저입니다 — 초대받은 사람이 남의 끝난 정산표를 먼저 볼 이유가 없습니다 */
  const inviteGate =
    viewer &&
    (!!joinCode || DEMO_CH4) && // 4장 파티원 예시는 초대장부터 — 링크를 받은 사람이 보는 첫 화면 (2026-09-06 낮 사용자)
    (!demoRoom || DEMO_CH4) &&
    !denied &&
    !genView &&
    !joinOk &&
    !kickedOut &&
    !(you && you.st) &&
    /* 로그인 상태면 이미 멤버인지부터 — 소켓의 hello 가 답할 때까지 초대장을 번쩍이지 않습니다 */
    (!auth || liveState !== "connecting");
  const guestWaiting = !!you && you.st === "ok" && !!vlobby;
  /* 끝난 판에는 자수가 없습니다 — 더 셀 것이 없어서요. 표 세 장은 그대로 봅니다 */
  const guestPlaying = !!you && you.st === "ok" && !vlobby && !ended && !genView;
  /* (폐기 2026-09-06 밤) 파티원 OBS 코치마크 — 파티원 튜토리얼 4·5걸음이 대신합니다 */
  /* 앉는 순간 맨 위로 (2026-09-06 사용자 지적) — 초대장·닉 정하기에서 내려온 스크롤을 표가 물려받지 않게 */
  useEffect(() => {
    if (readOnly && you && you.st === "ok" && you.rowId) window.scrollTo(0, 0);
  }, [readOnly, you && you.st, you && you.rowId]);
  const guestSeated = guestWaiting;
  /* 메모장에는 보통 항목이 없습니다 (§3.4: 모드도 판의 일부) — 셀 칸이 없으니 자수 탭도
     서지 않습니다. 방장이 메모장으로 바꾸면 파티원은 벌금표에서 그 판을 그대로 봅니다 */
  const confessTab = guestPlaying && !simple;
  /* 되돌리기 칩의 시계 — confessTab 이 선 뒤에 걸어야 합니다 (버그 기록 2026-09-07: 선언 전에 의존성으로 읽어 TDZ 로 앱이 통째로 죽었다) */
  useEffect(() => {
    if (!confessTab) return;
    const id = setInterval(() => {
      if (Object.keys(cfRef.current).some((k) => cfLeft(k) > 0)) setCfTick((t) => t + 1);
    }, 500);
    return () => clearInterval(id);
  }, [confessTab]);
  /* 자수할 줄이 실제로 있을 때만 나머지 칸을 물러나게 합니다 */
  const confessMode = confessTab && !!you.rowId;
  const [showObs, setShowObs] = useState(false); // 내 방송용 주소 — 기본 가림
  /* 내 줄의 보통 항목 칸만 누를 수 있습니다 — 룰렛·기타·합계는 읽기 전용입니다 */
  const canConfess = (row, col) =>
    !!auth &&
    !!you &&
    you.st === "ok" &&
    !!you.rowId &&
    row.id === you.rowId &&
    !isRoulette(col) &&
    /* 메모장 칸은 자수 대상이 아닙니다 — 방장 장부에 그 항목이 없습니다 */
    !simple &&
    scribeOn &&
    /* 얼어 있는 판에는 아무것도 못 적습니다 — 서버도 같은 자리에서 막습니다 (§3.4) */
    !paused &&
    !vlobby;

  /* ---------- 자수 탭 ----------
     파티원에게만 있는 탭이고, 그 사람의 기본 화면입니다. 자격이 사라지면(내보내짐·대기실로
     되돌아감) 그릴 것이 없으니 벌금표로 돌려놓습니다 — 빈 화면이 남지 않게 여기서 셉니다. */
  const tabNow = tab === "confess" && !confessTab ? (ended ? "ledger" : "sheet") : tab;
  const showConfess = tabNow === "confess";
  const showSheet = !tabbed || tabNow === "sheet";
  const showLedger = !tabbed || tabNow === "ledger";
  const showMail = !tabbed || tabNow === "mail";
  /* 출발하면 자수 화면부터 — 파티원이 처음 볼 것은 자기 칸입니다 */
  const wasPlaying = useRef(false);
  useEffect(() => {
    if (confessTab && !wasPlaying.current) setTab("confess");
    if (!confessTab && wasPlaying.current && tab === "confess") setTab("sheet");
    wasPlaying.current = confessTab;
  }, [confessTab]);
  /* 판이 끝나면 정산 장부부터 — 끝난 뒤에 볼 것은 자기가 얼마 보내는지입니다 */
  const wasEnded = useRef(false);
  useEffect(() => {
    if (ended && !wasEnded.current) setTab("ledger");
    wasEnded.current = ended;
  }, [ended]);
  /* 30초 복귀 — 다른 탭에서 아무 조작이 없으면 자수 화면으로 돌아옵니다.
     어떤 조작에나 타이머가 처음으로 돌아가서, 읽는 중에는 끌려가지 않습니다. */
  /* 남은 초 — 글자로 보여야 "왜 화면이 바뀌었지"가 안 됩니다 (2026-09-05). 조작마다 30으로 돌아갑니다 */
  const [backIn, setBackIn] = useState(null);
  useEffect(() => {
    if (!confessTab || tab === "confess") {
      setBackIn(null);
      return;
    }
    let id = null;
    let due = 0;
    const arm = () => {
      clearTimeout(id);
      due = Date.now() + IDLE_BACK_MS;
      setBackIn(Math.ceil(IDLE_BACK_MS / 1000));
      id = setTimeout(() => setTab("confess"), IDLE_BACK_MS);
    };
    const tick = setInterval(() => setBackIn(Math.max(0, Math.ceil((due - Date.now()) / 1000))), 500);
    const kinds = ["pointerdown", "pointermove", "keydown", "wheel", "touchstart", "scroll"];
    kinds.forEach((k) => window.addEventListener(k, arm, { passive: true, capture: true }));
    arm();
    return () => {
      clearTimeout(id);
      clearInterval(tick);
      kinds.forEach((k) => window.removeEventListener(k, arm, { capture: true }));
    };
  }, [confessTab, tab]);
  /* 내 줄과 내 벌금 — 자수 카드 위에 적습니다 */
  const myRow = confessTab && you.rowId ? rows.find((x) => x.id === you.rowId) : null;
  const myGold = myRow ? itemGold(myRow) : 0;
  /* 자리 고르기 (§3.2, 2026-09-05) — 방장 앱이 확실히 앉힐 수 있는 경우(닉 일치·이름 적힌 빈 줄 없음)엔
     3초를 기다립니다: 그 사이 선택지가 번쩍였다 사라지지 않게. 방장이 없거나 3초가 지나면 본인이 고릅니다 */
  const myNick = ((you && you.nick) || "").trim();
  /* 즉시 착석 (2026-09-05 표준화): 빈 칸이 있거나 닉이 맞는 줄이 있으면 방장 앱이 바로 앉힙니다.
     고르기는 시작 전에 빈 칸이 하나도 없을 때만, 진행 중엔 방장이 배치합니다(§3.2) */
  const seatCertain =
    blankFree.length > 0 ||
    namedFree.filter((r) => seatName(r, rows.indexOf(r)).trim() === myNick).length === 1;
  const needPick = !!you && you.st === "ok" && !you.rowId && !myRow && freeRows.length > 0;
  const [pickWait, setPickWait] = useState(true);
  useEffect(() => {
    if (!needPick) return;
    setPickWait(true);
    const t = setTimeout(() => setPickWait(false), 3000);
    return () => clearTimeout(t);
  }, [needPick]);
  const showPick = needPick && guestLobby && (!seatCertain || !scribeOn || !pickWait);
  const seatClaimBlock = () => (
    <div className="gs-seatclaim">
      {/* (폐기 2026-09-05) `한 번 고르면 못 바꿔요` — 방장이 옮겨 줄 수 있게 되면서(줄의 사람 버튼) 겁만 주는 말이 됐다 */}
      <p className="gs-seatclaim-lead">
        어느 줄이 나예요? 앉은 뒤에도 빈 줄로 옮길 수 있어요.
      </p>
      <div className="gs-seatlist">
        {namedFree.map((r) => (
          <button key={r.id} className="gs-seatopt" disabled={claimBusy} onClick={() => claimRow(r.id)}>
            {seatName(r, rows.indexOf(r))}
            {!guestLobby && <em className="gs-seatopt-g">{man(itemGold(r))}</em>}
          </button>
        ))}
        {blankFree.length > 0 && (
          <button
            className="gs-seatopt gs-seatopt-new"
            disabled={claimBusy}
            onClick={() => claimRow(blankFree[0].id)}
          >
            새 자리
            <em className="gs-seatopt-g">{blankFree.length}칸 남음</em>
          </button>
        )}
      </div>
    </div>
  );

  /* ---------- 방 표시 칩 ----------
     "어느 방인가"와 "잘 붙어 있나"를 칩 하나가 같이 답합니다. 방장은 서기 소켓이 붙어 있어야
     자수를 받으므로, 끊긴 것을 자기 화면에서 알아야 고칠 수 있습니다. */
  /* 파티 서랍이 이 칩 안에 있으므로, 공유를 끈 뒤에도 파티원이 남아 있으면 칩은 남습니다 —
     안 그러면 [파티 끝내기] 를 누른 순간 신청·명단·초대로 가는 문이 통째로 사라집니다 */
  /* 판이 살아 있으면 늘 섭니다 — 파티를 여는 문이 이 서랍 하나뿐이라, 아직 아무도 없을 때도
     들어갈 자리가 있어야 합니다 (로비에서는 홈이 그 일을 합니다) */
  const hostChip = !readOnly && roundLive && !genView;
  const guestChip = readOnly && !genView && !demoRoom && guestPlaying;
  /* 파티 칩의 얼굴은 이제 하나입니다 — `내 파티 · n명 ●` (파티 서랍).
     판이 없으면 홈이 이미 로비라 문이 필요 없고, 판이 있을 때만 서랍이 섭니다.
     판 기록을 보는 중에는 문을 열 자리가 아닙니다. */
  const partyChip = readOnly ? (guestChip ? "party" : null) : hostChip ? "party" : null;
  /* 방송 상태는 방 칩이 함께 답합니다 — 칩과 공유 버튼에 점이 둘이면 뭐가 뭔지 모릅니다.
     "on" 방송에 나가는 중 · "down" 켜 뒀는데 서기가 끊김 · "off" 공유 꺼짐 */
  /* 계정도 방도 없으면 끊긴 것이 아니라 애초에 안 켠 것입니다 — 혼자 세는 화면에
     빨간 '연결 끊김'을 띄우면 없는 고장을 말하게 됩니다 */
  /* 방송에 지금 뭐가 나가는지 (§5.7) — 앱이 아는 만큼만 말합니다.
     "OBS 가 실제로 받고 있나"는 세지 않습니다: 붙어 있는 것이 본인 OBS 인지 브라우저
     탭인지 새어 나간 링크인지 구분할 수 없어서, 세어 봐야 틀린 말을 하게 됩니다.
       none  주소가 없다 (로그인 전)
       off   방장이 껐다
       down  서버와 끊겨 갱신이 멈췄다
       idle  판이 없다 (로비)
       on    이 판이 나가는 중 */
  const castState = !auth || !relay.room
    ? "none"
    : !scribeLive
    ? "down"
    : roundLive
    ? "on"
    : lobbyOn
    ? "recruit"
    : "idle";
  /* 상태 문장(CAST_WHY)은 모듈 위에 — 공유 설정 창(ObsShare)도 씁니다 */
  /* 공유 설정 창은 파티원도 엽니다 — 자기 방송용 주소·소스 나누기·외형은 각자 고르는 것이고,
     계정마다 주소가 하나씩이라 파티원도 자기 것을 챙길 자리가 있어야 합니다.
     지난 판 보기(genView)는 방장이 제 옛 판을 들추는 자리라 방장 화면 그대로입니다. */
  const shareGuest = readOnly && !genView && !!auth;
  /* 파티원의 송출 점 (§5.3) — 내 주소에는 내가 있는 판이 뜹니다: 앉아서 판이 살아 있으면 on,
     연결이 죽었으면 down, 그 외(대기·끝남)는 idle. 방장은 castState 그대로 */
  const dotState = shareGuest
    ? liveState === "dead"
      ? "down"
      : guestPlaying
      ? "on"
      : "idle"
    : castState;
  const roomCount = rows.length; // 인원 수는 판의 줄 수로 셉니다
  /* 계정 붙은 자리가 있어야 파티입니다 (§5.6) — 혼자 판에 '파티'라는 말을 쓰지 않습니다 */
  const hostParty = seats.some((s) => s.acct);
  const roomTitle = guestChip
    ? (ownerNick || "방장") + "네 파티"
    : hostParty
    ? "내 파티"
    : "파티원 모으기";
  const roomLive = guestChip ? scribeOn : scribeLive;
  /* 살아 있는 초대 하나 — 죽은 링크는 아예 안 보여 줍니다 (§9). 모으는 중인지와는
     상관없습니다: 모으기는 상설이고(§3.1), [시작]은 대기실 표시만 내립니다 */
  /* 코드의 생사는 서버가 압니다 (2026-09-06: 방장이 앱을 열어 둔 동안 살고 닫으면 10분 뒤 만료) — 앱은 시계를 안 봅니다.
     (폐기) 만료 시각으로 걸러 `m분 남음`을 세던 것 — 20분 모으다 보면 링크가 죽어 다시 붙여야 했다 */
  const hostInvite = (() => {
    /* 예시 파티의 문 — 진짜 코드를 내지 않습니다 (2026-09-06) */
    if (tutorial && auth) return { url: window.location.origin + window.location.pathname + "#live=EXAMPLE&j=TUTORIAL", code: "TUTORIAL" };
    if (readOnly || !auth || !relay.room || !relay.invite || !relay.invite.code) return null;
    return { url: roomApi.inviteUrl(relay.room, relay.invite.code), code: relay.invite.code };
  })();
  /* 부팅·로그인 때 코드를 서버와 맞춥니다 — 죽은 코드를 화면에 두지 않고, 판이 있는데 코드가 없으면 냅니다 */
  useEffect(() => {
    if (readOnly || !auth || !relay.room) return;
    let gone = false;
    roomApi
      .inviteNow(auth.token, relay.room)
      .then((inv) => {
        if (gone) return;
        if (inv) putRelay({ ...relayRef.current, invite: { code: inv.code, exp: inv.exp } });
        else if (boardOnRef.current) newInvite();
        else if (relayRef.current.invite) putRelay({ ...relayRef.current, invite: null });
      })
      .catch(() => {});
    return () => {
      gone = true;
    };
  }, [readOnly, auth && auth.id, relay.room]);

  /* --- 뷰어: 구독해서 방장 화면을 그대로 비춥니다 --- */
  useEffect(() => {
    if (!readOnly || !liveRoom || liveRoom === DEMO_ROOM) return;
    let ws = null,
      beat = null,
      wait = 1000,
      stop = false;
    const paint = (st) => {
      /* 모드도 판의 일부입니다 (§3.4) — 방장이 메모장으로 바꾸면 파티원 화면도 따라갑니다.
         안 따라가면 카운터 화면이 메모장 숫자를 읽어 전원이 0으로 보입니다 */
      setMode(st.full.mode === "simple" ? "simple" : "items");
      setCols(st.full.cols || DEFAULT_COLS);
      setRows(st.full.rows || []);
      setFeePercent(st.full.feePercent || "5");
      setUnit(st.full.unit || "10000");
      setSplitMode(st.full.splitMode === "solo" ? "solo" : "pot");
      setLiveName(st.name || "");
      setLiveState("on");
      setLiveTick((t) => t + 1);
      setRows2v(Array.isArray(st.rows2) ? st.rows2 : []);
      /* 로비가 열려 있는 동안만 실립니다 — 사라지면 출발한 것입니다 */
      setVlobby(st.lobby || null);
    };
    const apply = (st) => {
      if (!st || !st.full) return;
      /* 붙기 전에 있었던 일은 지나갑니다 — 들어오자마자 밀린 카드가 쏟아지면 안 됩니다 */
      let got = 0;
      (st.fx || []).forEach((e) => {
        if (!e || !e.i || vfxSeen.current[e.i]) return;
        vfxSeen.current[e.i] = 1;
        if (!vfxBoot.current || st.fxSpd === "off") return;
        /* 룰렛 결과는 방금 본 판의 것이라 줄 맨 앞으로 — 밀린 카드 뒤에 서면
           바퀴가 선 한참 뒤에 그 결과가 나옵니다 */
        if (e.k === "roul") vfxQ.current.unshift(e);
        else vfxQ.current.push(e);
        got++;
      });
      vfxBoot.current = true;
      if (got) setVfxTick((v) => v + 1);
      /* 새 판이 왔으면 재생을 시작합니다 */
      const sp = st.spin || null;
      setVin(sp);
      if (sp) {
        setVplay((x) =>
          x && x.sp.sid === sp.sid ? { ...x, sp } : { sp, i: 0, rolling: true, over: false }
        );
      }
      /* 결과지를 켜 둔 채 방장이 새 판을 만들었습니다 (2026-09-06) — 결과지를 덮지 않고 띠만 [들어가기]로 바꿉니다 */
      if (endedRef.current && !st.end && st.lobby) {
        setBoardOpened(true);
        return;
      }
      /* 받은 판을 담아 둡니다 — 판이 갈렸으면 여기서 옛 판이 판 기록으로 넘어갑니다 */
      keepRef.current(st);
      /* 돌고 있는 중이면 표는 나중에 — 바늘이 멈추기 전에 숫자가 먼저 바뀌면
         파티원 화면에서도 답이 새어 나갑니다.
         판 기록을 열어 둔 동안도 미뤄 둡니다 — 그 판이 지금 화면이니까요 */
      if (vplayRef.current || genViewRef.current) vpend.current = st;
      else { vpend.current = null; paint(st); }
      /* 방장이 [정산 끝내기]를 누르며 보낸 마지막 장 — 파티원에게는 판이 끝난 것입니다.
         내보내지는 않습니다: 결과지와 오버레이는 그대로 남습니다 (§3.4) */
      if (st.end) finishRef.current();
      else setEnded(false);
      /* 이어가기 — 잡아채지 않고 카드로 알립니다 (§8 `판이 시작됐어요.` + [들어가기]) */
      if (st.resumed) setStartCard(st.roundId || "1");
    };
    const connect = () => {
      if (stop) return;
      try {
        ws = new WebSocket(
          `${WS_BASE}/api/r/${liveRoom}/live` + (wsCred ? "?" + wsCred : "")
        );
      } catch (e) {
        setTimeout(connect, wait);
        return;
      }
      beat = setInterval(() => {
        if (ws && ws.readyState === 1) ws.send("ping");
      }, 50000);
      ws.onmessage = (ev) => {
        if (ev.data === "pong") return;
        try {
          const m = JSON.parse(ev.data);
          if (m.kind === "dead") {
            setLiveState("dead");
            /* 방이 사라져도 마지막 판은 남깁니다 — 정산은 아직 안 끝났을 수 있습니다 */
            finishRef.current();
          }
          else if (m.kind === "hello") {
            setDenied(null);
            setYou(m.you || null);
            if (m.ownerNick) setOwnerNick(m.ownerNick);
            if (m.scribeOn != null) setScribeOn(!!m.scribeOn);
            setPaused(m.paused || null);
          } else if (m.kind === "paused") {
            /* 얼림/풀림 — 판은 그대로 있고 띠 하나만 바뀝니다 (§3.4) */
            setPaused(m.paused || null);
          } else if (m.kind === "presence") {
            setScribeOn(!!m.scribeOn);
            if (m.scribeOn) setConfessErr("");
          }
          else if (m.kind === "you") {
            /* 내 자리가 바뀌었습니다. 새 자리는 그 자리에서 앉히고(출발 직후 자기 줄이
               잠깐 죽어 있지 않게), 자격은 붙었다 떼서 hello 로 다시 확인합니다 */
            setYou(m.you || null);
            /* you:null — 내보내기(카드) 또는 판의 끝(end:1, 2026-09-06 모델: 끝내기·해산은 전원 해제).
               시작 전 해산이면 대기실이 사라지니 로비로 가고 쪽지를 남깁니다. 결과지가 있는 끝은 띠 하나.
               (폐기 2026-09-05) you:null 은 내보내기뿐 */
            if (!m.you) {
              if (m.end) {
                if (vlobbyRef.current) {
                  try {
                    localStorage.setItem(
                      "goldSettlement.disbandNote",
                      JSON.stringify({ host: ownerNickRef.current || "", t: Date.now() })
                    );
                  } catch (e) {}
                  saveLastLive(null);
                  leaveToLobby();
                } else finishRef.current();
              } else setKickedOut(true);
            }
            /* (폐기 2026-09-05) 여기서 소켓을 닫았다 다시 붙던 것 — 다시 붙는 동안(백오프 최대 15초) 계정이 붙은
               소켓이 없어 그 사이의 내보내기 통지를 놓쳤다. 자격은 같은 계정이라 다시 확인할 것이 없다 */
          } else if (m.kind === "denied") {
            /* 입장이 아직 서버에 안 닿았을 뿐이면 권한 문제가 아닙니다 —
               붙잡아 두지 말고 닫았다가 다시 붙습니다 */
            if (joining.current) {
              try {
                ws.close();
              } catch (e2) {}
              return;
            }
            setDenied(m.why || "member");
            setYou(null);
            /* 마지막으로 받은 판이 있으면 화면을 비우지 않습니다 — 내보내진 순간이
               보통 정산하는 순간입니다. 자수만 사라지고 벌금표·정산 장부·보낼 우편은
               그대로 봅니다. 받은 적이 없으면(초대만 만료된 사람) 보여 줄 판도 없습니다. */
            if (lastLive.current && lastLive.current.room === liveRoom) {
              finishRef.current();
            } else {
              setRows([]);
              setVlobby(null);
              setLiveState("empty");
            }
            stop = true;
            try {
              ws.close();
            } catch (e2) {}
          } else if (m.kind === "lobby") {
            /* 서버가 로비를 닫았을 때(6시간 방치) 판으로 바로 돌아옵니다 */
            if (m.lobby && !m.lobby.open) setVlobby(null);
          } else if (m.kind === "state") {
            if (m.scribeOn != null) setScribeOn(!!m.scribeOn);
            if (m.paused !== undefined) setPaused(m.paused || null);
            if (m.state) apply(m.state);
            else {
              setLiveState("empty");
              setVlobby(null);
            }
          }
          wait = 1000;
        } catch (e) {}
      };
      ws.onclose = () => {
        clearInterval(beat);
        if (stop) return;
        setLiveState((v) => (v === "dead" ? v : "connecting"));
        setTimeout(connect, wait);
        wait = Math.min(wait * 2, 15000);
      };
      ws.onerror = () => {
        try {
          ws.close();
        } catch (e) {}
      };
    };
    connect();
    return () => {
      stop = true;
      clearInterval(beat);
      try {
        ws && ws.close();
      } catch (e) {}
    };
  }, [readOnly, liveRoom, wsCred, sockGen]);

  /* 복구 제안은 "다음 편집 전까지" — 표를 고치기 시작하면 조용히 접습니다 */
  useEffect(() => {
    if (!snapBooted.current) {
      snapBooted.current = true;
      return;
    }
    if (snapHold.current) {
      snapHold.current = false;
      return;
    }
    setUndoSnap((s) => (s ? null : s));
  }, [cols, rows]);

  const takeSnap = (label, msg) => {
    snapHold.current = true;
    // 예시 입력은 수수료·입력 단위까지 덮으므로 그 둘도 같이 떠 둡니다
    setUndoSnap({ cols, rows, log, feePercent, unit, label, msg, t: Date.now() });
  };
  const restoreSnap = () => {
    if (readOnly) return;
    if (!undoSnap) return;
    snapHold.current = true;
    setCols(undoSnap.cols);
    setRows(undoSnap.rows);
    setLog(undoSnap.log || []);
    if (undoSnap.feePercent != null) setFeePercent(undoSnap.feePercent);
    if (undoSnap.unit != null) setUnit(undoSnap.unit);
    seq.current = Math.max(
      seq.current,
      nextSeq({ cols: undoSnap.cols, rows: undoSnap.rows, log: undoSnap.log, seats: seatsRef.current })
    );
    setOpenRow(null);
    setMemoFreeze(null); // 표가 스냅샷 시점으로 바뀌므로 동결도 무효
    setUndoSnap(null);
  };

  // 모드마다 주소가 달라지도록 (#m=items / #m=simple)
  useEffect(() => {
    // 첫 선택 전엔 주소도 건드리지 않습니다 — 해시가 생기면 첫 방문 판정이 깨집니다
    if (intro === "first") return;
    /* 뷰어 주소는 남의 방을 가리키는 남의 주소입니다. 여기에 m= 을 얹으면 그 사람이
       주소를 다시 넘길 때 딸려 가고, 자기 장부를 쓰려고 #live= 만 지우면 m= 이 남습니다. */
    if (readOnly) return;
    syncHashMode(mode);
  }, [mode, intro, readOnly]);

  // 주소를 직접 고치거나 뒤로가기를 눌러도 모드가 따라오게
  useEffect(() => {
    const onHash = () => {
      /* 방·초대 코드가 바뀌면 화면의 갈래가 통째로 바뀝니다 (뷰어인지, 어느 방인지는
         부트가 한 번 읽습니다) — 다시 여는 것이 가장 짧고 확실한 길입니다.
         앱이 스스로 고치는 해시(#m=·공유 코드)는 replaceState 라 여기로 오지 않습니다 */
      if (
        readLiveRoom() !== (boot.current.liveRoom || null) ||
        readJoinCode() !== (boot.current.joinCode || null) ||
        readObsToken() !== (boot.current.obsToken || null)
      ) {
        window.location.reload();
        return;
      }
      const m = readHashMode();
      if (m) changeMode(m);
      /* 화면 = 주소 (2026-09-05) — 뒤로·앞으로·go() 가 전부 여기로 옵니다 */
      if (!viewer) applyRoute(readRoute());
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  });
  /* 주소가 비어 있었으면 도착 규칙의 결과를 주소에 적습니다 — 새로고침·뒤로가기가 그 화면으로 돌아오게.
     #gen= 로 왔으면 그 기록을 엽니다(없으면 판으로) */
  useEffect(() => {
    if (viewer || !canOwnUrl || typeof window === "undefined") return;
    /* 옛 주소의 `lobby=` 같은 꼬리를 한 번 다듬습니다 — 화면은 그대로, history 도 그대로(replace) */
    const cur = window.location.hash.replace(/^#/, "");
    const pretty = hashText(hashParams());
    if (cur && pretty !== cur) {
      const { pathname, search } = window.location;
      window.history.replaceState(null, "", pathname + search + (pretty ? "#" + pretty : ""));
    }
    const r = readRoute();
    if (r.view === "gen") {
      if (loadPartySlot(r.gen)) openGenInner(r.gen);
      else go(VIEW_BOARD, null, { replace: true });
      return;
    }
    if (!r.view) go(atLobby ? VIEW_LOBBY : VIEW_BOARD, null, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* 표에 있는 줄이 곧 파티원입니다. 벌금이 0인 사람도 받을 몫이 있어 인원에서 빼면
     정산이 통째로 틀리고, 이름을 아직 안 넣었다고 빼면 오버레이·우편과 어긋납니다.
     안 쓰는 줄은 사용자가 지웁니다(행의 ×). */
  const party = rows;

  const r = useMemo(
    () => computeSettlement(party, activeCols, feePercent, !simple, splitMode),
    [party, activeCols, feePercent, simple, splitMode]
  );

  /* 인게임 채팅에 그대로 붙일 한 줄. 개행이 안 먹고 50자 제한이 있어서
     여백도 콤마도 없이 이름+숫자만 잇습니다. 0원인 사람도 함께 적어요 — 안 낸 것도 정보라서. */
  const chatLine = useMemo(() => {
    if (!r) return "";
    const entries = party.map((row, i) => ({
      name: seatName(row, rows.indexOf(row)),
      num: chatNum(r.fines[i]),
      v: r.fines[i],
    }));
    return entries.length ? chatLineOf(entries) : "";
  }, [r, party]);

  // 우편은 보내는 사람 하나당 카드 하나. transfers 는 이미 금액 내림차순이라 그 순서가 유지됩니다.
  const mails = useMemo(() => {
    if (!r) return [];
    const bySender = new Map();
    r.transfers.forEach((t) => {
      if (!bySender.has(t.from)) bySender.set(t.from, []);
      bySender.get(t.from).push(t);
    });
    return [...bySender.entries()]
      .map(([from, items]) => ({
        from,
        items,
        total: items.reduce((a, t) => a + t.amount, 0),
        fee: items.reduce((a, t) => a + t.fee, 0),
      }))
      .sort((a, b) => b.total - a.total);
  }, [r]);

  /* 행 조작 — 표시 이름은 방장 장부의 것입니다 (§3.2). 방장이 사람 자리의 이름도
     고칠 수 있고, 고친 자리는 파티원 닉 변경이 안 건드립니다 */
  const patchRow = (id, key, value) => {
    if (readOnly) return;
    setRows((prev) => prev.map((x) => (x.id === id ? { ...x, [key]: value } : x)));
    if (key === "name") renameSeat(id, value);
  };
  const patchCount = (id, colId, value) => {
    if (readOnly) return;
    const capped = num(value) > MAX_COUNT ? formatNumInput(String(MAX_COUNT)) : value;
    const row = rows.find((x) => x.id === id);
    const col = cols.find((c) => c.id === colId);
    /* 셀 비우기 — 숫자가 있던 칸을 0으로 지우는 것도 '비움'입니다 (§3.4).
       굳혀 둔 금액(sums)도 같이 지웁니다 — 안 지우면 횟수만 0이 되고 돈이 남습니다 */
    const wipe =
      !!row && !!col && num(row.counts[colId]) > 0 && num(capped) === 0;
    const gone = wipe ? cellGold(row, colId, Math.round(goldOf(col.price))) : 0;
    setRows((prev) =>
      prev.map((x) => {
        if (x.id !== id) return x;
        const next = { ...x, counts: { ...x.counts, [colId]: capped } };
        if (wipe && x.sums) {
          const { [colId]: _drop, ...rest } = x.sums;
          next.sums = rest;
        }
        return next;
      })
    );
    if (!wipe) return;
    appendLog({
      id: "L" + seq.current++,
      kind: "clear",
      rowId: id,
      colId,
      n: 0,
      delta: -gone,
      name: seatName(row, rows.indexOf(row)),
      item: col.name,
      after: Math.max(0, liveTotal(row) - gone),
    });
  };
  // +/− 버튼. 0이 되면 빈 칸으로 되돌려 놓습니다 (0을 적어두는 것과 같은 뜻이라)
  /* 횟수와 금액을 함께 움직입니다. gold 를 안 주면 지금 단가로 계산합니다. */
  const bump = (id, colId, delta, gold) =>
    readOnly ? undefined :
    setRows((prev) =>
      prev.map((x) => {
        if (x.id !== id) return x;
        const cur = num(x.counts[colId]);
        const next = Math.min(MAX_COUNT, Math.max(0, cur + delta));
        const moved = next - cur;
        const priceG = Math.round(goldOf((cols.find((c) => c.id === colId) || {}).price));
        const dGold = gold != null ? gold : moved * priceG;
        const base = x.sums && x.sums[colId] != null ? x.sums[colId] : cur * priceG;
        /* 열 합계는 음수가 될 수 있습니다 — 감면이 다른 열의 벌금을 깎을 때
           이 열이 그 음수를 담습니다. 사람 합계는 clampCut 이 0 밑으로 안 보냅니다. */
        const sum = Math.round(base + dGold);
        const { [colId]: _drop, ...restSums } = x.sums || {};
        return {
          ...x,
          counts: { ...x.counts, [colId]: next === 0 ? "" : formatNumInput(String(next)) },
          sums: next === 0 ? restSums : { ...restSums, [colId]: sum },
        };
      })
    );
  /* ---------- 룰렛 ----------
     한 판의 결과는 누르는 순간 다 정해 놓고, 화면은 그 순서를 보여 주기만 합니다.
     그래야 중간에 새로고침이 나도 결과가 흔들리지 않습니다.
     phase: roll(도는 중) → pick(양도 대상 고르는 중) → done(끝) */
  /* 판마다 속도가 달라서 상수 대신 그 판의 값을 씁니다 */
  const spd = spinSpeed(spin && spin.spd);
  const ROLL_MS = spinRoll(spin);
  const HOLD_MS = spd.hold;
  const END_MS = spd.end;

  /* 판을 멈춥니다 — 결과는 이때 뽑습니다.
     미리 정해 놓고 돌리면 "언제 멈출지 모르는" 긴장이 안 생깁니다. 서기도 시청자도
     누르는 순간까지 답을 모르는 게 이 연출의 전부라서요. */
  /* 양도 후보와 그 이름표 — 뽑을 때와 원판을 그릴 때가 같은 목록이어야 합니다.
     이름이 겹치면 원판의 칸을 구분할 수 없어서 뒤에 번호를 붙입니다. */
  const passCands = (col, row) => rows.filter((x) => passSelf(col) || x.id !== row.id);
  const passFaces = (cands) => {
    const seen = {};
    return cands.map((r) => {
      const base = seatName(r, rows.indexOf(r));
      seen[base] = (seen[base] || 0) + 1;
      return seen[base] > 1 ? base + " " + seen[base] : base;
    });
  };

  /* 판을 멈춥니다 — 한 번 누르면 한 면만 뽑습니다.
     ×2 나 양도권이 나오면 판이 안 끝나는데, 다음 면까지 여기서 미리 뽑아 두면
     두 번째 STOP 은 이미 정해진 답을 보여 주는 시늉이 됩니다. 누르는 순간까지
     답을 모르는 게 이 연출의 전부라서, 면은 누를 때마다 하나씩만 뽑습니다. */
  const stopSpin = () => {
    setSpin((x) => {
      if (!x) return x;
      const col = cols.find((c) => c.id === x.colId);
      const row = rows.find((r) => r.id === x.rowId);
      if (!col || !row) return x;
      /* 사람 원판 — 누가 물지도 누를 때 뽑습니다 */
      if (x.phase === "who" && x.whoFree) {
        const faces = (x.pass2 && x.pass2.faces) || [];
        const cands = passCands(col, row);
        if (!faces.length || !cands.length) return { ...x, phase: "pick", whoFree: false };
        const k = Math.floor(Math.random() * cands.length);
        return {
          ...x,
          pass2: { faces, idx: k, rowId: cands[k].id, name: faces[k] },
          whoFree: false,
          whoRolling: true,
          tick: 0,
        };
      }
      if (x.phase !== "free") return x;
      const steps = x.steps || [];
      /* 양도권은 한 판에 한 번뿐이라, 이미 나왔으면 후보에서 뺍니다 */
      let pool = liveFaces(col);
      if (steps.some((st) => st.k === PASS)) pool = pool.filter((k2) => k2 !== PASS);
      const prev = steps.length ? steps[steps.length - 1].mult : 1;
      const k = drawFace(weightsOf(col), pool, Math.random);
      const mult = isMultKey(k) ? prev * faceMult(k) : prev;
      const next = [...steps, { k, mult }];
      const ends = !isMultKey(k) && k !== PASS;
      const pass = next.some((st) => st.k === PASS);
      const n = ends ? faceNum(k) : 0;
      const res = ends ? { steps: next, n, mult, count: n * mult, pass } : null;
      let pass2 = x.pass2;
      if (ends && pass && passMode(col) === "random" && !pass2) {
        const cands = passCands(col, row);
        pass2 = cands.length ? { faces: passFaces(cands) } : null;
      }
      return {
        ...x,
        steps: next,
        res,
        pass2,
        phase: "roll",
        i: next.length - 1,
        rolling: true,
        tick: 0,
        skipAt: null,
      };
    });
  };

  const startSpin = (row, col) => {
    if (readOnly || spin) return;
    if (!canSpin(col)) return say(NO_NUM_MSG);
    setSpin({
      pass2: null,
      sid: "s" + seq.current++, // 오버레이가 새 판인지 알아보는 표
      faces: liveFaces(col),
      w: weightsOf(col),
      look: spinShape(relay),
      theme: wheelTheme(relay),
      spd: spinSpd(relay),
      /* 감속을 시간으로 재서 얼려 둡니다 (2026-09-07) — 서기 원판·사람 원판·파티원 원판·방송
         원판이 전부 이 한 값을 씁니다. 도는 중에 슬라이더를 만져도 다음 판부터 듣습니다 */
      roll: glideMs(spinGlideOf(relay)),
      rowId: row.id,
      colId: col.id,
      who: seatName(row, rows.indexOf(row)),
      item: col.name,
      priceG: Math.round(goldOf(col.price)),
      /* 아직 답이 없습니다 — 멈출 때 뽑습니다 */
      steps: [],
      i: 0,
      rolling: true,
      tick: 0,
      res: null,
      phase: "free",
    });
  };

  /* 도는 동안 면이 빠르게 바뀝니다 */
  useEffect(() => {
    /* 숫자 판이 돌 때와 사람 릴이 돌 때 둘 다 시계가 필요합니다.
       free 는 답이 없는 채로 도는 상태라 여기도 시계가 있어야 글자가 바뀝니다 */
    const ticking =
      spin &&
      (spin.phase === "free" ||
        (spin.phase === "roll" && spin.rolling) ||
        (spin.phase === "who" && (spin.whoFree || spin.whoRolling)));
    if (!ticking) return;
    /* 답이 없는 동안은 같은 속도로 흐려 놓고, 멈추는 중에는 면이 바뀌는 간격을 늘립니다.
       원판만 감속하고 릴은 툭 서면, 같은 판인데 하나만 고장 난 것처럼 보입니다.
       간격을 지수로 늘리는 것은 속도가 지수로 줄어드는 것과 같습니다 — 앞은 빠르게
       느려지고 뒤는 길게 기어갑니다. 원판 곡선과 같은 성격입니다. */
    const free = spin.phase === "free" || !!spin.whoFree;
    const ms = spinRoll(spin);
    const t0 = Date.now();
    let id = null;
    const step = () => {
      setSpin((x) =>
        x && (x.phase === "free" || x.rolling || x.whoFree || x.whoRolling)
          ? { ...x, tick: x.tick + 1 }
          : x
      );
      if (free) { id = setTimeout(step, FACE_MS); return; }
      const el = Date.now() - t0;
      const gap = faceGap(el / ms);
      /* 마지막 한 칸은 결과가 차지합니다 — 끝나기 직전에 한 번 더 넘기면
         엉뚱한 면이 스쳤다가 곧바로 결과로 바뀌어 "따닥" 하고 두 번 바뀝니다 */
      if (ms - el < gap * 1.35) return;
      id = setTimeout(step, gap);
    };
    id = setTimeout(step, FACE_MS);
    return () => clearTimeout(id);
  }, [spin && spin.phase, spin && spin.rolling, spin && spin.whoFree, spin && spin.whoRolling, spin && spin.i]);

  /* 한 면에 멈췄다가 다음 면으로. 마지막 면에서 갈립니다 */
  useEffect(() => {
    if (!spin || spin.phase !== "roll") return;
    if (spin.rolling) {
      const t = setTimeout(
        () => setSpin((x) => (x ? { ...x, rolling: false } : x)),
        ROLL_MS
      );
      return () => clearTimeout(t);
    }
    const t = setTimeout(() => {
      setSpin((x) => {
        if (!x) return x;
        /* 아직 숫자가 안 나온 판(×2·양도권)은 자유 회전으로 돌아갑니다 — 다음 면도 STOP 으로 */
        if (!x.res) return {
          ...x,
          phase: "free",
          /* 다음에 뽑을 자리로 옮깁니다 — 안 옮기면 원판이 "양도권이 아직 안 나온 판"을
             계속 그립니다. 빠진 면을 가리는 기준이 이 자리라서요. */
          i: (x.steps || []).length,
          rolling: true,
          tick: 0,
          skipAt: null,
        };
        if (!x.res.pass) return { ...x, phase: "done" };
        /* 랜덤이면 사람 원판도 STOP 을 기다립니다 */
        return x.pass2
          ? { ...x, phase: "who", whoFree: true, tick: 0 }
          : { ...x, phase: "pick" };
      });
    }, HOLD_MS);
    return () => clearTimeout(t);
  }, [spin && spin.phase, spin && spin.rolling, spin && spin.i]);

  /* 사람 원판 — 한 바퀴 돌고 멈춘 뒤 그 사람에게 붙습니다 */
  useEffect(() => {
    if (!spin || spin.phase !== "who" || spin.whoFree) return;
    if (spin.whoRolling) {
      const t = setTimeout(
        () => setSpin((x) => (x ? { ...x, whoRolling: false } : x)),
        ROLL_MS
      );
      return () => clearTimeout(t);
    }
    const t = setTimeout(
      () => setSpin((x) => (x ? { ...x, phase: "done", target: x.pass2.rowId } : x)),
      HOLD_MS
    );
    return () => clearTimeout(t);
  }, [spin && spin.phase, spin && spin.whoFree, spin && spin.whoRolling, spin && spin.skipped]);

  /* 양도권이 안 나온 판은 돌린 사람에게 바로 붙습니다 */
  useEffect(() => {
    if (!spin || spin.phase !== "done") return;
    const out = applySpin(spin, spin.target || spin.rowId);
    /* 마지막 판을 클릭으로 끝냈으면 결과 화면 없이 바로 닫습니다 */
    if (spin.fast) {
      setSpin(null);
      return;
    }
    /* 실제 적용된 값(잘렸을 수도)과 그 사람의 새 합계 — 결과 줄이 씁니다 */
    setSpin((x) => (x && x.phase === "done" ? { ...x, out } : x));
    const t = setTimeout(() => setSpin(null), END_MS);
    return () => clearTimeout(t);
  }, [spin && spin.phase]);

  /* 벌금을 실제로 붙입니다. 양도면 target 이 다른 사람입니다 */
  const applySpin = (sp, targetId) => {
    const col = cols.find((c) => c.id === sp.colId);
    const row = rows.find((x) => x.id === targetId);
    if (!col || !row) return;
    /* 칸에 쌓이는 숫자는 "몇 번 돌렸나"입니다. 나온 숫자를 그대로 쌓으면 한 판에
       20이 나왔을 때 20회 돌린 것처럼 보입니다. 금액은 sums 에 따로 쌓여서
       횟수와 무관하게 정확합니다. */
    const cnt = sp.res.count;
    const raw = Math.round(sp.priceG * cnt);
    /* 빼기 면은 지금 벌금까지만 — 기록에는 나온 값과 실제 깎인 값을 둘 다 남깁니다 */
    const gold = clampCut(raw, liveTotal(row));
    const before = liveN(row, col.id);
    const after = liveTotal(row) + gold;
    live.current.n[row.id + ":" + col.id] = before + 1;
    live.current.total[row.id] = after;
    bump(row.id, col.id, 1, gold);
    appendLog({
      kind: "roulette",
      rowId: row.id,
      colId: col.id,
      n: 1, // 한 판 = 1회. 기록에서 취소할 때도 이 한 판만 되돌립니다
      delta: gold,
      name: seatName(row, rows.indexOf(row)),
      item: col.name,
      faces: sp.steps.map((x) => x.k).join(","),
      num: sp.res.n,
      mult: sp.res.mult,
      /* 잘렸을 때만 나온 값을 따로 — 기록이 "−3만 중 −2만 적용"을 보여 줍니다 */
      raw: raw !== gold ? raw : undefined,
      /* 양도면 누가 돌렸는지 남깁니다 — 나중에 읽을 때 이게 없으면 뜬금없습니다 */
      from: sp.res.pass && targetId !== sp.rowId ? sp.who : null,
      after,
    });
    /* 음수가 나오면 규칙을 그 자리에서 알려 줍니다 — 처음 보는 사람은 모릅니다 */
    if (raw < 0)
      sayLog(
        gold === 0
          ? "빼기 면이 나왔지만 깎을 벌금이 없어요 — 0 밑으로는 안 내려가요."
          : gold === raw
          ? "빼기 면 — 벌금에서 " + man(-gold) + " 깎였어요. 0 밑으로는 안 내려가요."
          : man(-raw) + " 중 벌금이 있는 " + man(-gold) + "만 깎였어요 — 남은 몫은 사라져요."
      );
    return { gold, raw, after, name: seatName(row, rows.indexOf(row)) };
  };

  /* 클릭 한 번 = 한 단계. 도는 중이면 그 자리에서 세우고, 서 있으면 다음 판.
     마지막 판 뒤의 클릭과 결과 화면의 클릭은 판을 닫습니다 — 적용은 이미 끝난 뒤라
     안전합니다 (fast: 적용만 하고 결과 화면 없이 바로 닫으라는 표시). */
  const skipSpin = () =>
    setSpin((x) => {
      if (!x) return x;
      if (x.phase === "done") return null;
      if (x.phase === "who") {
        /* 자유 회전은 STOP 으로만 멈춥니다 — 건너뛰기는 답이 있을 때 하는 일입니다 */
        if (x.whoFree) return x;
        if (x.whoRolling) return { ...x, whoRolling: false, skipAt: "who" };
        return { ...x, phase: "done", target: x.pass2.rowId, fast: true };
      }
      if (x.phase !== "roll") return x;
      if (x.rolling) return { ...x, rolling: false, skipAt: x.i };
      /* 아직 숫자가 안 나왔으면 다음 면을 뽑을 차례로 넘깁니다 */
      if (!x.res) return {
          ...x,
          phase: "free",
          /* 다음에 뽑을 자리로 옮깁니다 — 안 옮기면 원판이 "양도권이 아직 안 나온 판"을
             계속 그립니다. 빠진 면을 가리는 기준이 이 자리라서요. */
          i: (x.steps || []).length,
          rolling: true,
          tick: 0,
          skipAt: null,
        };
      if (!x.res.pass) return { ...x, phase: "done", fast: true };
      return x.pass2
        ? { ...x, phase: "who", whoFree: true, tick: 0, skipAt: null }
        : { ...x, phase: "pick" };
    });

  /* 양도 대상 고르기. 자기 자신을 고르면 한 번 물어봅니다 */
  const pickPassTarget = (row) => {
    if (!spin || spin.phase !== "pick") return;
    const sp = spin;
    const gold = Math.round(sp.priceG * sp.res.count);
    if (row.id === sp.rowId) {
      setAsk({
        title: "본인에게 붙일까요?",
        body:
          "양도하지 않고 " +
          (sp.who || "돌린 사람") +
          " 본인에게 " +
          man(gold) +
          "이 붙어요. 양도권을 쓰지 않는 셈이에요.",
        action: "본인에게",
        onYes: () => {
          applySpin(sp, row.id);
          setSpin(null);
        },
      });
      return;
    }
    applySpin(sp, row.id);
    setSpin(null);
  };

  /* 항목 추가 고르기 · 룰렛 설정 창 */
  const [addColOpen, setAddColOpen] = useState(false);
  const [rouletteCfg, setRouletteCfg] = useState(null);

  /* ---------- 기록(영수증) ---------- */
  const appendLog = (entry) =>
    setLog((prev) => {
      const next = [...prev, { t: Date.now(), ...entry, id: entry.id || "L" + seq.current++ }];
      return next.length > LOG_CAP ? next.slice(next.length - LOG_CAP) : next;
    });

  /* 연타가 한 틱에 몰리면 rows 가 아직 안 갱신된 채로 다음 클릭이 들어옵니다.
     기록의 누적액이 밀리지 않도록, 렌더 사이의 변화를 그림자 값으로 들고 갑니다. */
  const live = useRef(null);
  live.current = { total: {}, n: {} };
  const liveTotal = (row) => live.current.total[row.id] ?? itemGold(row);
  const liveN = (row, colId) => live.current.n[row.id + ":" + colId] ?? num(row.counts[colId]);

  /* 카운터 셀의 ＋/−. 횟수를 움직이고 한 줄 남깁니다. 이름·항목은 나중에 지워져도
     읽히도록 그 시점 글자를 같이 적어 둡니다. 왼클릭 +1, 우클릭 −1, 둘 다 기록됩니다. */
  const pressCell = (row, col, dir = 1) => {
    /* 준비 상태 — 칸은 잠겨 있습니다. 세기 시작하는 문은 [시작] 하나입니다 (§3.1) */
    if (ready) {
      say("[시작]을 누르면 세기 시작해요.");
      return;
    }
    if (readOnly) {
      /* 시작 전의 판 — 파티원의 칸도 잠겨 있습니다 (§5.3) */
      if (guestLobby) {
        say("방장이 시작하면 세어져요.");
        return;
      }
      /* 파티원은 자기 줄의 보통 항목만 — 서버로 보내고, 반영은 방장 푸시로만 옵니다 */
      if (canConfess(row, col)) {
        /* 0회에서 빼는 것은 방장 앱이 어차피 버립니다 (applyConfess) — 서버까지 갈 이유가
           없고, 분당 상한만 축냅니다. 벌금표와 자수 카드가 같은 규칙을 씁니다 */
        if (dir <= 0 && num(row.counts[col.id]) <= 0) return;
        sendConfess(row.id, col.id, dir > 0 ? 1 : -1);
        return;
      }
      setRoPulse(Date.now()); // "정적인 화면이구나"로 오해하지 않게, 배너가 반응합니다
      return;
    }
    /* 룰렛이 도는 동안에는 표를 못 건드립니다. 특히 양도 때는 행 전체가 "고르기"라,
       칸이 같이 눌리면 엉뚱한 항목의 횟수가 오릅니다. */
    if (spin) return;
    /* 룰렛 항목은 누르면 돌아갑니다. 빼기는 기록에서 취소로 합니다 —
       한 판이 여러 걸음(×2·양도)으로 이뤄져서 "1회 빼기"로는 되돌릴 수가 없습니다 */
    if (isRoulette(col)) {
      if (dir > 0) startSpin(row, col);
      else
        sayLog(
          <>
            {"오입력 방지를 위해 룰렛은 우클릭 감소가 금지되어 있어요. '"}
            <button
              className="gs-toast-link"
              onClick={() => {
                setToast(null);
                openLog(null);
              }}
            >
              기록
            </button>
            {"'에서 취소해주세요."}
          </>
        );
      return;
    }
    courseHit(dir > 0 ? "press" : "unpress");
    const before = liveN(row, col.id);
    if (dir > 0 ? before >= MAX_COUNT : before <= 0) return;
    const priceG = Math.round(goldOf(col.price));
    /* − 는 마지막으로 쌓인 건의 금액을 되돌립니다 — 단가가 바뀐 뒤라면
       지금 단가가 아니라 그때 넣었던 금액을 빼야 총액이 맞습니다. */
    const lastPress =
      dir < 0
        ? [...log].reverse().find(
            (e) =>
              (e.kind === "press" || e.kind === "confess") &&
              e.rowId === row.id &&
              e.colId === col.id &&
              e.n > 0 &&
              !e.cancelled
          )
        : null;
    const gold = dir > 0 ? priceG : -(lastPress ? lastPress.delta : priceG);
    const after = liveTotal(row) + gold;
    live.current.n[row.id + ":" + col.id] = before + dir;
    live.current.total[row.id] = after;
    bump(row.id, col.id, dir, gold);
    const id = "L" + seq.current++;
    notePress(id);
    appendLog({
      id,
      kind: "press",
      rowId: row.id,
      colId: col.id,
      n: dir,
      delta: gold,
      name: seatName(row, rows.indexOf(row)),
      item: col.name,
      after,
    });
  };

  /* 같은 사유의 기타 한 줄에 금액을 누적합니다. 0이 되면 줄 자체를 지웁니다. */
  const mergeExtra = (rowId, reason, diffG) =>
    readOnly ? undefined :
    setRows((prev) =>
      prev.map((x) => {
        if (x.id !== rowId) return x;
        const exs = extrasOf(x);
        const hit = exs.find((e) => e.reason === reason);
        const amt = (hit ? Math.round(goldOf(hit.amount)) : 0) + diffG;
        const rest = hit ? exs.filter((e) => e !== hit) : exs;
        return {
          ...x,
          extras:
            amt === 0
              ? rest
              : [
                  ...rest,
                  hit
                    ? { ...hit, amount: commafy(amt) }
                    : { id: "e" + seq.current++, amount: commafy(amt), reason },
                ],
        };
      })
    );

  /* 합계 직접 수정 — 차액이 기타 '직접 수정'으로 갑니다. 횟수는 건드리지 않습니다. */
  const editTotal = (row, targetG) => {
    if (readOnly) return;
    const target = Math.round(targetG);
    const diff = target - liveTotal(row);
    if (!diff) return;
    live.current.total[row.id] = target;
    mergeExtra(row.id, ADJUST_REASON, diff);
    appendLog({
      kind: "edit",
      rowId: row.id,
      delta: diff,
      name: seatName(row, rows.indexOf(row)),
      after: target,
    });
  };

  /* 취소(역분개) — 그 줄의 변화량만 반대로 적용합니다. 되감기가 아니라서 이후 줄들은
     그대로 살아 있습니다. 횟수로 되돌릴 수 있는 만큼은 횟수로, 못 덮는 차액
     (단가가 바뀌었거나 횟수를 이미 손댄 경우)은 기타로 보내 총액을 정확히 맞춥니다. */
  const cancelEntry = (en) => {
    if (readOnly) return;
    if (en.cancelled || en.kind === "cancel") return;
    const row = rows.find((x) => x.id === en.rowId);
    if (!row) return;
    let fromCounts = 0;
    if (en.colId && en.n) {
      const col = cols.find((c) => c.id === en.colId);
      if (col) {
        const priceG = Math.round(goldOf(col.price));
        const avail = liveN(row, en.colId);
        const next = Math.min(MAX_COUNT, Math.max(0, avail - en.n));
        if (next !== avail) {
          live.current.n[row.id + ":" + en.colId] = next;
          const back = next - avail;
          // 그 줄이 넣었던 금액만큼만 되돌립니다 (한 번에 여러 회를 넣었어도 비율대로)
          const goldBack = en.n ? Math.round((en.delta / en.n) * back) : back * priceG;
          bump(row.id, en.colId, back, goldBack);
          fromCounts = goldBack;
        }
      }
    }
    /* 기타 등록의 취소 — 그 줄이 아직 그대로면 줄 자체를 거둡니다 */
    let fromExtra = 0;
    if (en.kind === "extra" && en.exId) {
      const ex = extrasOf(row).find((e) => e.id === en.exId);
      if (ex && Math.round(goldOf(ex.amount)) === en.delta) {
        setRows((prev) =>
          prev.map((x) =>
            x.id === en.rowId
              ? { ...x, extras: extrasOf(x).filter((e) => e.id !== en.exId) }
              : x
          )
        );
        fromExtra = -en.delta;
      }
    }
    const rest = -en.delta - fromCounts - fromExtra;
    if (rest)
      mergeExtra(en.rowId, en.kind === "extra-del" ? en.reason || "" : ADJUST_REASON, rest);
    const after = liveTotal(row) - en.delta;
    live.current.total[row.id] = after;
    setLog((prev) => {
      const next = [
        ...prev.map((x) => (x.id === en.id ? { ...x, cancelled: true } : x)),
        {
          id: "L" + seq.current++,
          t: Date.now(),
          kind: "cancel",
          refId: en.id,
          rowId: en.rowId,
          delta: -en.delta,
          name: en.name,
          item: en.item,
          after,
        },
      ];
      return next.length > LOG_CAP ? next.slice(next.length - LOG_CAP) : next;
    });
  };

  /* 판 도중에도 [+ 인원 추가]는 자리 추가로 동작합니다 — 늦게 온 사람 자리입니다 (§3.2) */
  const addRow = () => {
    if (readOnly) return;
    const taken = new Set(rows.map((x) => x.name));
    let k = rows.length + 1;
    while (taken.has(FILL_NAME(k))) k++;
    const s = { id: "r" + seq.current++, name: "", acct: null, mem: null, named: false };
    putSeats((prev) => [...prev, s]);
    setRows((prev) => [
      ...prev,
      { id: s.id, name: FILL_NAME(k), counts: simple ? { [SIMPLE_ID]: "" } : {}, extras: [] },
    ]);
  };
  const delRow = (id) => {
    if (readOnly) return;
    const who = rows.find((x) => x.id === id);
    const nm = (who && who.name) || "이름 없는 인원";
    takeSnap("인원 삭제", `${nm}${josa(nm, "을", "를")} 지웠어요.`);
    setRows((prev) => prev.filter((x) => x.id !== id));
    dropSeat(id);
    setOpenRow((o) => (o === id ? null : o));
  };
  /* 판이 살아 있는 동안 자리와 줄은 id 로 1:1 입니다. 메모장 모드처럼 줄을 통째로
     다시 짜는 길이 있어서, 마지막에 한 번 맞춰 둡니다 — 표시 이름의 원본은 방장 장부라
     여기서는 줄 → 자리 한 방향으로만 흐릅니다 (§3.2) */
  useEffect(() => {
    if (readOnly || !roundLive) return;
    putSeats((prev) => {
      const by = new Map(prev.map((s) => [s.id, s]));
      let changed = prev.length !== rows.length;
      const next = rows.map((x) => {
        const s = by.get(x.id);
        if (!s) {
          changed = true;
          return { id: x.id, name: x.name || "", acct: null, mem: null, named: true };
        }
        if ((s.name || "") === (x.name || "")) return s;
        changed = true;
        return { ...s, name: x.name || "", named: true };
      });
      return changed ? next : prev;
    });
  }, [rows, roundLive, readOnly]);

  /* 기타 벌금 */
  const addExtra = (rowId, amount, reason) => {
    if (readOnly) return;
    const row = rows.find((x) => x.id === rowId);
    if (!row) return;
    /* 입력 단계에서 골 단위로 굳혀 둡니다. '10만' 은 여기서 100,000이 됩니다.
       음수(감면)는 지금 벌금까지만 — 기타는 저장식이라 그대로 두면 다음 벌금에서
       마저 깎이는 자동 이월이 됩니다. 넣는 순간 값을 굳혀야 이월이 안 생깁니다. */
    const want = Math.round(goldOf(amount));
    const g = clampCut(want, itemGold(row));
    if (want < 0 && g === 0) {
      /* 깎을 게 없으면 0짜리 줄을 남기지 않습니다 — 알림만 */
      sayLog("깎을 벌금이 없어요 — 감면은 지금 벌금까지만 깎여요.");
      return;
    }
    const exId = "e" + seq.current++;
    setRows((prev) =>
      prev.map((x) =>
        x.id === rowId
          ? { ...x, extras: [...extrasOf(x), { id: exId, amount: commafy(g), reason }] }
          : x
      )
    );
    const after = liveTotal(row) + g;
    live.current.total[row.id] = after;
    appendLog({
      kind: "extra",
      exId,
      rowId,
      delta: g,
      name: seatName(row, rows.indexOf(row)),
      item: reason ? "기타(" + reason + ")" : "기타",
      reason,
      after,
    });
    if (want < 0)
      sayLog(
        g === want
          ? "감면 " + man(-g) + " — 지금 벌금에서 깎였어요. 0 밑으로는 안 내려가요."
          : man(-want) + " 중 벌금이 있는 " + man(-g) + "만 깎였어요 — 남은 몫은 사라져요."
      );
  };
  const patchExtra = (rowId, exId, key, value) =>
    setRows((prev) =>
      prev.map((x) =>
        x.id === rowId
          ? {
              ...x,
              extras: extrasOf(x).map((e) => (e.id === exId ? { ...e, [key]: value } : e)),
            }
          : x
      )
    );
  const clampExtra = (rowId, exId) => {
    const row = rows.find((x) => x.id === rowId);
    const ex = row && extrasOf(row).find((e) => e.id === exId);
    if (!ex) return;
    const want = Math.round(goldOf(ex.amount));
    if (want >= 0) return;
    /* 이 건을 뺀 나머지 벌금까지가 감면 한도입니다 */
    const g = clampCut(want, itemGold(row) - want);
    if (g === want) return;
    patchExtra(rowId, exId, "amount", commafy(g));
    sayLog(man(-want) + " 중 벌금이 있는 " + man(-g) + "만 깎였어요 — 남은 몫은 사라져요.");
  };
  const delExtra = (rowId, exId) => {
    const row = rows.find((x) => x.id === rowId);
    const ex = row && extrasOf(row).find((e) => e.id === exId);
    if (!ex) return;
    setRows((prev) =>
      prev.map((x) =>
        x.id === rowId ? { ...x, extras: extrasOf(x).filter((e) => e.id !== exId) } : x
      )
    );
    const g = Math.round(goldOf(ex.amount));
    const after = liveTotal(row) - g;
    live.current.total[row.id] = after;
    appendLog({
      kind: "extra-del",
      exId,
      rowId,
      delta: -g,
      name: seatName(row, rows.indexOf(row)),
      item: ex.reason ? "기타(" + ex.reason + ")" : "기타",
      reason: ex.reason,
      after,
    });
  };

  /* 단가 변경 — 묻지 않습니다. 고치는 즉시 과거까지 새 단가로 계산되고(오타 정정이
     다수라서), 대신 쪽지가 떠서 "지금부터 1데스 10만!" 같은 규칙 변경이면 한 번의
     클릭으로 지난 횟수를 옛 단가 열로 분리할 수 있습니다. 기록에도 한 줄 남습니다. */

  /* 열 분리 — 이 항목은 옛 단가로 되돌리고, 같은 이름의 새 항목을 바로 옆에 만듭니다.
     헤더에 1회 단가가 찍히니 '죽음 3만'과 '죽음 10만'이 서로 구분됩니다. */
  /* 단가를 바꿀 때 — 이미 센 것을 어떻게 볼지 물어봅니다.
     '이제부터만'이면 그 칸들의 금액을 옛 단가로 굳혀 두고(sums), 새 누름부터 새 단가.
     '지금까지 전부'면 굳힌 금액을 풀어서 전부 새 단가로 다시 계산합니다. */
  const freezeCol = (colId, priceG) =>
    setRows((prev) =>
      prev.map((x) => {
        if (num(x.counts[colId]) <= 0) return x;
        return { ...x, sums: { ...(x.sums || {}), [colId]: cellGold(x, colId, priceG) } };
      })
    );
  const thawCol = (colId) =>
    setRows((prev) =>
      prev.map((x) => {
        if (!x.sums || x.sums[colId] == null) return x;
        const { [colId]: _drop, ...rest } = x.sums;
        return { ...x, sums: rest };
      })
    );

  /* 단가 창 — 센 기록이 있는 항목의 단가는 여기서 고칩니다.
     창을 여는 것 자체는 아무것도 바꾸지 않아서, 취소하면 되돌릴 것도 없습니다. */
  const [priceAsk, setPriceAsk] = useState(null);
  const applyPrice = (col, newG, retro) => {
    if (readOnly) return;
    const oldG = Math.round(goldOf(col.price));
    if (retro) thawCol(col.id);
    else freezeCol(col.id, oldG);
    patchCol(col.id, "price", commafy(newG));
    appendLog({
      kind: "price",
      colId: col.id,
      item: col.name,
      from: oldG,
      to: newG,
      mode: retro ? "retro" : "forward",
    });
    setPriceAsk(null);
  };

  /* 열 조작 */
  const patchCol = (id, key, value) =>
    readOnly ? undefined :
    setCols((prev) => prev.map((c) => (c.id === id ? { ...c, [key]: value } : c)));
  /* 항목 유형 — 보통(카운터)과 룰렛. 룰렛은 단가에 나온 숫자를 곱해 벌금이 붙습니다. */
  const addCol = (type) => {
    if (readOnly) return;
    /* 예시 앱에서 처음 더하는 열은 ctut — 튜토리얼이 그 열의 이름·단가 칸을 가리킵니다 */
    const id = tutorialRef.current && !cols.some((c) => c.id === "ctut") ? "ctut" : "c" + seq.current++;
    const col = { id, name: "", price: "10,000" };
    if (type === "roulette") {
      col.type = "roulette";
      col.faces = ROULETTE_KEYS.slice();
      col.w = { ...ROULETTE_W };
    }
    setCols((prev) => [...prev, col]);
    setAddColOpen(false);
    if (type === "roulette") setRouletteCfg(col.id);
    courseHit("addcol:done"); // 튜토리얼 2장
  };
  const delCol = (id) => {
    if (readOnly) return;
    const col = cols.find((c) => c.id === id);
    const cn = (col && col.name) || "이름 없는 항목";
    takeSnap("항목 삭제", `항목 '${cn}'${josa(cn, "을", "를")} 지웠어요.`);
    setCols((prev) => prev.filter((c) => c.id !== id));
    setRows((prev) =>
      prev.map((x) => {
        const { [id]: _drop, ...rest } = x.counts;
        const { [id]: _g, ...restSums } = x.sums || {};
        return { ...x, counts: rest, sums: restSums };
      })
    );
  };

  // 실제로 쓰기 시작할 때. 인원·숫자는 비우고 항목은 기본값으로 되돌립니다.
  /* 한 판 끝나고 같은 멤버로 또 한 판 — 이름과 항목은 두고 숫자만 비웁니다.
     손 안 댄 예시라면 남의 명단이니 이름까지 치웁니다. 행은 여덟 줄로 맞춥니다. */
  /* ---------- 판 기록 — [시작]과 [정산 끝내기] 사이의 한 판 ----------
     로컬 전용입니다. 읽기 조회만 있고, 잠금·복원·서버 보관은 없앴습니다.
     줄마다 판의 신분증(출처·이름·기간·총액·파티원 전부)을 함께 담습니다. */
  const GEN_KEEP = 20; // 최근 20판, 넘치면 오래된 것부터
  /* 판 기록의 배지는 '누구의 판'입니다 — `내 판` / `{방장닉}네 파티` (§3.5).
     혼자 센 판도 내 판이고, 로컬 기록·파티 기록이라는 종류 구분은 없습니다 */
  const GEN_LOCAL_TITLE = "내 판";
  const genEntries = () => partyReg.list.filter((x) => x.gen);
  /* 배지는 보는 사람 기준입니다 (§3.5) — 내가 방장이었던 판은 파티였어도 `내 판`이고,
     남의 파티에서 받은 판만 `{방장닉}네 파티`입니다. 기록할 때 방장과 나를 같은 이름으로
     적어 두므로(host === me), 둘이 같은지가 곧 "내가 방장이었나"입니다.
     저장된 title 을 안 보고 여기서 다시 짓습니다 — 옛 기록도 같은 규칙으로 읽히게 */
  const genBadge = (g) =>
    g && g.host && !(g.me && g.host === g.me) ? g.host + "네 파티" : GEN_LOCAL_TITLE;
  /* 옛 항목에는 신분증이 없습니다 — 없는 채로 들어오니 로컬·파티원 없음으로 채웁니다.
     파티원은 저장된 장부의 줄 이름에서 되살립니다(옛 판도 누구랑 했는지는 남아 있습니다) */
  const gensList = () =>
    genEntries()
      .slice()
      .sort((a, b) => (b.t || 0) - (a.t || 0))
      .map((g) => {
        const need = g.gold == null || g.n == null || !Array.isArray(g.mems);
        const slot = need ? loadPartySlot(g.name) : null;
        return {
          ...g,
          src: g.src === "party" ? "party" : "local",
          rname: g.rname || (slot && slot.rname) || "",
          title: genBadge(g),
          host: g.host || "",
          me: g.me || "",
          mems: Array.isArray(g.mems) ? g.mems : realNames((slot && slot.rows) || []),
          gold: g.gold != null ? g.gold : slotGold(slot),
          n: g.n != null ? g.n : ((slot && slot.rows) || []).length,
        };
      });
  /* 판이 있는가 (2026-09-06 모델: 판은 만들면 생기고 끝내면 없다) — [+ 새 판 만들기]가 켜고 정산 끝내기·해산이 끕니다.
     진행 중이면 언제나 있습니다. (폐기 2026-09-06) 기록·이름·로그로 "만든 적이 있는가"를 추정 — 한 번 만들면 영영 참이라
     백지 얼굴로 돌아올 길이 없었다 */
  const boardOn = roundLive || !!(relay && relay.boardOn);
  boardOnRef.current = boardOn;
  const boardMade = boardOn;
  /* 지금 화면 (2026-09-06) — 화면별 사용법과 [?] 메뉴의 "지금 이 화면"이 봅니다 */
  const recMember = readOnly && !genView;
  const recKey = recMember ? "member" : "host";
  const screenId = showLobby
    ? "lobby"
    : readOnly
      ? tab === "confess" && myRow
        ? "confess"
        : null
      : genView
        ? null
        : boardOn && !roundLive
          ? "ready"
          : roundLive
            ? "board"
            : null;
  /* 화면이 바뀌면 스크롤은 맨 위로 (2026-09-06 낮 사용자: 시작하기를 누를 때, 파티원 화면에서 돌아올 때 등 전환 전부).
     로비 · 결과지 · 파티원 탭 · 판(시작 전/진행 중) × 탭 — 이 열쇠가 바뀔 때만 */
  const screenKey = showLobby ? "lobby" : genView ? "gen:" + tab : readOnly ? "v:" + tab : boardOn ? (roundLive ? "board:" : "ready:") + tab : "none";
  const screenKeyRef = useRef(screenKey);
  useEffect(() => {
    if (screenKeyRef.current === screenKey) return;
    screenKeyRef.current = screenKey;
    window.scrollTo(0, 0);
  }, [screenKey]);
  /* 파티원 첫 방문 — 자수 화면에 처음 왔을 때 1.5초 뒤 [?] 팝오버가 저절로 한 번 열립니다(브라우저당) (2026-09-06 사용자 확정) */
  useEffect(() => {
    if (DEMO || !readOnly || screenId !== "confess" || tutorial || obsOpen) return;
    if (coachSeen("askMember")) return;
    const t = setTimeout(() => {
      coachDone("askMember");
      setHelpAuto(true);
      setHelpOpen(true);
    }, 1500);
    return () => clearTimeout(t);
  }, [readOnly, screenId, tutorial, obsOpen]);
  /* (폐기 2026-09-06 밤) 방장 OBS 코치마크 — 튜토리얼 6장이 대신합니다 */
  /* 판이 없는데 판 화면이면 로비로 — 부팅·옛 주소·끝낸 직후 */
  useEffect(() => {
    /* 막 끝낸 판은 결과지로 갑니다(justEnded) — 여기서 먼저 로비로 밀면 결과지가 안 열립니다 (버그 기록 2026-09-06) */
    if (readOnly || genView || atLobby || boardOn || justEnded) return;
    go(VIEW_LOBBY, null, { replace: true });
  }, [readOnly, !!genView, atLobby, boardOn, !!justEnded]);
  const askDropGen = (g) =>
    setAsk({
      title: "이 기록을 지울까요?",
      body: (g.title || g.name) + " — 이 브라우저에서 지워져요. 되돌릴 수 없어요.",
      action: "지우기",
      tone: "danger",
      onYes: () => {
        if (genView === g.name) closeGen();
        dropPartySlot(g.name);
        putPartyReg({
          ...partyReg,
          list: partyReg.list.filter((x) => x.name !== g.name),
        });
      },
    });
  /* 방장 쪽 신분증 — 파티원이 한 명이라도 붙어 있었으면 그 판은 파티입니다.
     배지는 그래도 `내 판`입니다 (§3.5): 이 기록을 보는 사람이 그 판의 방장이니까요.
     함께한 사람은 아래 칩으로 보입니다 */
  const hostRoundMeta = () => {
    const party = !!auth && members.some((m) => m.st === "ok" && m.acct !== auth.id);
    const nick = (auth && auth.nick) || "";
    return {
      src: party ? "party" : "local",
      title: GEN_LOCAL_TITLE,
      host: party ? nick : "",
      me: party ? nick : "",
      mems: realNames(rows),
      /* 판을 가리키는 열쇠는 roundId 입니다 — 줄 id 는 자리 id 라 판이 갈려도 그대로여서,
         그걸 쓰면 이 방의 모든 판이 기록 한 줄로 뭉칩니다 */
      round: party && relay.room && roundId ? relay.room + "/" + roundId : "",
    };
  };
  /* 지금 장부를 판 기록으로 닫습니다. 기록이 없으면 남길 것도 없습니다.
     넘치는 옛 판은 목록·저장소에서 걷어냅니다. */
  const closeRound = () => {
    const before = partyReg.list;
    /* 줄마다 출처(계정)를 남깁니다 (2026-09-06) — 이어가기가 사람을 자기 줄에 되돌리는 열쇠. 이름은 출처가 아닙니다 */
    const led = currentLedger();
    led.rows = led.rows.map((r) => {
      const s0 = seats.find((k) => k.id === r.id);
      return { ...r, who: (s0 && (s0.acct || s0.who)) || r.who || null };
    });
    const list = foldIntoGens(led, before, hostRoundMeta());
    if (list === before) return null;
    putPartyReg({ list, active: partyReg.active });
    /* 막 들어간(또는 갱신된) 줄의 이름 — [정산 끝내기]가 그 결과 화면을 바로 엽니다 (§3.4) */
    const entry = list.find((x) => x.gen && !before.includes(x));
    return entry ? entry.name : true;
  };
  /* 장부 하나를 판 기록으로 밀어 넣습니다 — 목록을 받아 갱신된 목록을 돌려줍니다.
     같은 판(round)이 이미 있으면 그 줄을 갱신합니다 — 끝났다 이어진 판이 둘로 남지 않게 */
  const foldIntoGens = (led, list, meta) => {
    const ts = ((led && led.log) || []).map((e) => e.t).filter(Boolean);
    if (!ts.length) return list;
    const info = meta || {};
    const from = Math.min.apply(null, ts);
    const to = Math.max.apply(null, ts);
    const old = info.round ? list.find((x) => x.gen && x.round === info.round) : null;
    const label = old ? old.name : uniquePartyName(fmtSpan(from, to), list);
    savePartySlot(label, led);
    const entry = {
      name: label,
      /* 보이는 이름은 방장이 지은 판 이름입니다 (§3.1). name 은 저장 열쇠라 시각 그대로
         두고(겹치면 안 됩니다), 화면에는 이것을 씁니다 — 없으면 옛 기록이라 name 으로 */
      rname: (led && led.rname) || "",
      t: Date.now(),
      gen: true,
      from,
      to,
      gold: slotGold(led),
      n: ((led && led.rows) || []).length,
      src: info.src === "party" ? "party" : "local",
      title: info.title || GEN_LOCAL_TITLE,
      host: info.host || "",
      me: info.me || "",
      mems: Array.isArray(info.mems) ? info.mems : realNames((led && led.rows) || []),
      round: info.round || "",
    };
    let out = old ? list.map((x) => (x.name === old.name ? entry : x)) : [...list, entry];
    const loose = out.filter((x) => x.gen);
    if (loose.length > GEN_KEEP) {
      const drop = loose
        .slice()
        .sort((a, b) => (a.t || 0) - (b.t || 0))
        .slice(0, loose.length - GEN_KEEP)
        .map((x) => x.name);
      drop.forEach((nm) => dropPartySlot(nm));
      out = out.filter((x) => !drop.includes(x.name));
    }
    return out;
  };
  /* 파티원이 받은 판을 그대로 판 기록에 넣습니다 — 서버는 건드리지 않습니다 */
  const genArchive = (kept) => {
    if (!kept || !kept.full) return;
    const f = kept.full;
    const led = {
      mode: f.mode || "items",
      unit: f.unit || "10000",
      cols: f.cols || [],
      rows: migrateRows(f.rows || []),
      log: f.log || [],
      feePercent: f.feePercent || "5",
      splitMode: f.splitMode === "solo" ? "solo" : "pot",
      memoFreeze: f.memoFreeze || null,
      undoSnap: null,
      rname: f.rname || "",
    };
    const before = partyReg.list;
    const list = foldIntoGens(led, before, {
      src: "party",
      title: (kept.host || "방장") + "네 파티",
      host: kept.host || "",
      me: kept.me || "",
      mems: kept.mems || [],
      round: kept.room + "/" + (kept.gid || (kept.ids && kept.ids[0]) || ""),
    });
    if (list === before) return;
    putPartyReg({ list, active: partyReg.active });
  };
  archiveRef.current = genArchive;
  /* 장부를 기록으로 갈아 끼웁니다 — 화면 이동(주소)은 openGen/go 가, 뒤로가기는 hashchange 가 여기로 옵니다 */
  const openGenInner = (name) => {
    const slot = loadPartySlot(name);
    if (!slot) return;
    /* 이미 보기 중이면 돌아올 자리는 처음 열 때 떠 놨습니다 — 다시 떠 두면
       보고 있던 판 내용으로 덮어써 버립니다 */
    if (!genView) {
      /* 뷰어는 남의 판을 비추는 중이라 이 브라우저에 저장하면 내 장부를 덮어씁니다 */
      if (viewer) liveBack.current = currentLedger();
      else savePartySlot(partyReg.active, currentLedger());
    }
    applyLedger(slot);
    setGenView(name);
    /* 결과지가 먼저입니다 (§3.5) — 누가 얼마 보내나·참여자 전부·기간·총액이 정산 장부와
       신분증 띠에 있고, 세부(벌금표 전체)는 탭을 펴야 보입니다 */
    setTab("ledger");
  };
  /* 기록 열기 = 화면 이동 (#gen=이름, 2026-09-05) — history 에 한 장 얹히고 뒤로가기가 접습니다.
     (폐기 2026-09-05) pushState({gsGen}) + popstate — 주소 없는 한 장이라 새로고침이 화면을 못 지켰다 */
  const openGen = (name) => {
    if (loadPartySlot(name)) go("gen", name);
  };
  /* 기록을 접고 원래 장부로 — 뷰어는 보고 있던 판으로, 방장은 자기 장부로 */
  const closeGenInner = () => {
    if (viewer) applyLedger(liveBack.current || blankPartyLedger());
    else applyLedger(loadPartySlot(partyReg.active) || blankPartyLedger());
    setGenView(null);
    setJustEnded(null);
    /* 끝난 판으로 돌아가면 볼 것은 정산 장부입니다 (applyLedger 는 벌금표로 엽니다) */
    if (ended) setTab("ledger");
  };
  /* [닫기]/[지금 판으로] — 화면 이동이라 주소로 갑니다. 막 끝낸 판이나 로비에서 연 기록은 로비로,
     판에서 들춰본 기록은 판으로 (§3.4). 뒤로가기는 hashchange 가 같은 closeGenInner 로 접습니다 */
  const closeGen = () => {
    courseHit("genclose"); // 튜토리얼 7장 — 로비의 판 기록으로
    go(genView === justEnded || atLobby ? VIEW_LOBBY : VIEW_BOARD);
  };
  /* [닫기] — 끝난 파티 화면을 접고 이 브라우저의 내 장부로 갑니다.
     뷰어인지는 부트에서 정해지므로 주소에서 방을 떼고 다시 엽니다 */
  /* [들어가기] — 같은 문을 다시 지납니다 (2026-09-06). 입장을 다시 걸면 앉는 순간 소켓이 새로 붙어 새 판을 받습니다 */
  const rejoinNow = () => {
    setEnded(false);
    setBoardOpened(false);
    setKickedOut(false);
    setDenied(null);
    joinTried.current = "";
    vpend.current = null;
    setJoinOk(true);
    setRejoinTick((n) => n + 1);
  };
  const leaveEnded = () => {
    if (typeof window === "undefined") return;
    /* 끝난 판 [닫기] → 로비 (§3.4 여정표). 도착지에서 한 줄 알립니다 — 결과는 판 기록에 남았습니다 */
    try {
      const k = lastLive.current || {};
      sessionStorage.setItem("gs-ended", String(k.host || ownerNick || ""));
    } catch (e) {}
    saveLastLive(null);
    leaveToLobby();
  };
  /* ---------- 판의 신분증 띠 ----------
     판 전체에 걸리는 정보라 카드(탭 내용) 안이 아니라 탭 위에 둡니다. 끝난 판·기록에서는
     마스트 왼쪽 버튼들이 어차피 쓸모없으니 그 자리를 이 띠가 씁니다. */
  const idBand = (() => {
    if (genView) {
      const g = partyReg.list.find((x) => x.gen && x.name === genView) || null;
      const need = !g || g.gold == null || !Array.isArray(g.mems);
      const slot = need ? loadPartySlot(genView) : null;
      return {
        src: g && g.src === "party" ? "party" : "local",
        /* 배지는 보는 사람 기준입니다 (§3.5) — 목록의 줄과 같은 규칙으로 짓습니다 */
        title: genBadge(g),
        when: g ? fmtWhenLong(g.from || g.t, g.to || g.t) : genView,
        gold: g && g.gold != null ? g.gold : slotGold(slot),
        host: (g && g.host) || "",
        me: (g && g.me) || "",
        mems: g && Array.isArray(g.mems) ? g.mems : realNames((slot && slot.rows) || []),
        /* 막 끝낸 판은 기록 열람이 아니라 정산의 마지막 장면입니다 (§3.4) — 말과 문이 다릅니다 */
        msg:
          genView === justEnded ? (
            <>
              <b>끝났어요.</b> 정산 결과는 계속 볼 수 있고, 판 기록에도 남았어요.
            </>
          ) : (
            <>
              <b>판 기록</b>을 보는 중이에요 — 여기서는 못 고쳐요.
            </>
          ),
        /* 로비에서 열었거나 막 끝낸 판이면 [닫기](로비로), 판에서 들춰봤으면 [지금 판으로] */
        act: {
          label: genView === justEnded || atLobby ? "닫기" : "지금 판으로",
          ghost: genView === justEnded || atLobby,
          on: closeGen,
        },
      };
    }
    if (ended) {
      const k = lastLive.current || {};
      return {
        src: "party",
        title: (k.host || ownerNick || "방장") + "네 파티",
        when: fmtWhenLong(k.from, k.to),
        gold: slotGold(currentLedger()),
        host: k.host || ownerNick || "",
        me: k.me || (auth && auth.nick) || "",
        mems: Array.isArray(k.mems) && k.mems.length ? k.mems : realNames(rows),
        /* 띠 하나, 얼굴 둘 (2026-09-06): 판이 없는 동안 [로비로]뿐, 방장이 새 판을 만들면 [들어가기]가 선다 (초안).
           (폐기 2026-09-06) `끝났어요. 정산 결과는 계속 볼 수 있고, 판 기록에도 남았어요.` [닫기] — 결과지가 이미 말한다 */
        msg: boardOpened ? (
          <>
            <em className="gs-livechip-dot" aria-hidden="true" /> <b>새 판이 열렸어요</b>
          </>
        ) : (
          <b>판이 끝났어요</b>
        ),
        act: boardOpened
          ? { label: "들어가기", ghost: false, on: rejoinNow }
          : { label: "로비로", ghost: true, on: leaveEnded },
        act2: boardOpened ? { label: "로비로", on: leaveEnded } : null,
      };
    }
    return null;
  })();
  /* [프리셋] 불러오기 — 로비에서만 엽니다 (§3.4). 판을 닫는 일이 아니라 로비의 항목과
     자리를 갈아끼우는 일이라, 결과지도 확인창도 없습니다. 판을 닫고 새로 여는 길은
     [정산 끝내기] → [시작] 하나뿐입니다 */
  const loadPreset = (pre) => {
    if (readOnly || !pre) return;
    const pc = Array.isArray(pre.cols) && pre.cols.length ? pre.cols : DEFAULT_COLS;
    setCols(pc.map((c) => ({ ...c })));
    if (pre.unit) setUnit(pre.unit);
    if (pre.feePercent) setFeePercent(pre.feePercent);
    const names = (Array.isArray(pre.names) ? pre.names : []).filter((n) => (n || "").trim());
    /* 이름은 [시작] 때 빈 줄에 채웁니다 (2026-09-06) — 시작 전 표는 사람만 앉는 자리라 글자 이름을 세우지 않습니다.
       (폐기) 프리셋이 이름 자리를 그 자리에서 세우던 것 */
    putRelay({ ...relayRef.current, presetNames: names });
  };
  /* [전부 비우기] — 판은 그대로 두고 숫자만 리셋합니다. 결과지에 무영향이고,
     장부 로그에 `비움` 한 줄이 남습니다 (§3.4). 파티원의 "방금 바뀐" 카드에도 뜹니다 */
  const wipeCounts = () => {
    if (readOnly) return;
    takeSnap("전부 비우기", "숫자만 비웠어요. 판은 그대로예요.");
    const before = rows.reduce((a, x) => a + itemGold(x), 0);
    /* sums 는 누를 때 굳혀 둔 금액입니다 — 같이 안 지우면 횟수만 0이 되고 돈은 남습니다 */
    setRows((prev) =>
      prev.map((x) => ({ ...x, counts: simple ? { [SIMPLE_ID]: "" } : {}, sums: {}, extras: [] }))
    );
    setOpenRow(null);
    setMemoFreeze(null);
    appendLog({
      id: "L" + seq.current++,
      kind: "clear",
      rowId: "",
      colId: "",
      n: 0,
      delta: -before,
      name: "",
      item: "",
      after: 0,
    });
  };
  const askWipeCounts = () =>
    setAsk({
      title: "숫자를 전부 비울까요?",
      body: "이름과 항목은 그대로 두고 숫자만 비워요. 판은 계속되고, 장부 기록에 `비움`으로 남아요.",
      action: "비우기",
      onYes: wipeCounts,
    });

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), (toast && toast.ms) || 3600);
    return () => clearTimeout(t);
  }, [toast && toast.t]);

  /* 되돌릴 수 없는 조작은 한 번 물어봅니다 — 이 셋만 위험 톤입니다 (§9-4) */
  const askDelRow = (row) =>
    setAsk({
      title: "이 인원을 삭제할까요?",
      // 모드마다 실제로 사라지는 게 다릅니다
      body:
        `${row.name || "이름 없는 인원"} — ` +
        (simple
          ? "적어둔 금액과 메모장의 해당 줄이 함께 지워져요."
          : "횟수와 기타 벌금이 함께 지워져요."),
      tone: "danger",
      onYes: () => delRow(row.id),
    });
  const askDelCol = (col) =>
    setAsk({
      title: "이 항목을 삭제할까요?",
      body: `${col.name || "이름 없는 항목"} 열과 모든 인원의 해당 횟수가 함께 지워져요.`,
      tone: "danger",
      onYes: () => delCol(col.id),
    });
  const askDelExtra = (row, ex) =>
    setAsk({
      title: "이 기타 벌금을 삭제할까요?",
      body: `${G(goldOf(ex.amount))} · ${ex.reason || "사유 없음"}`,
      tone: "danger",
      onYes: () => delExtra(row.id, ex.id),
    });

  /* 복사 */
  const fallbackCopy = (text, done) => {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand("copy");
      done();
    } catch (e) {
      /* 복사 불가 환경 */
    }
    document.body.removeChild(ta);
  };

  const copy = (text, tag) => {
    const done = () => {
      setFlash(tag);
      setTimeout(() => setFlash(""), 1800);
    };
    /* 주소를 가져간 적이 있는가 — 앱이 아는 유일한 신호 (2026-09-06). 파티원 코치마크가 이걸로 물러납니다 */
    if (tag === "obsurl")
      try {
        localStorage.setItem("goldSettlement.obsCopied", "1");
      } catch (e) {}
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(done, () => fallbackCopy(text, done));
    } else {
      fallbackCopy(text, done);
    }
  };

  /* 공유용은 '누가 누구에게 얼마 보내는지' 만. 벌금 내역은 표에서 보면 됩니다. */
  const mailText = () => {
    if (!r || r.transfers.length === 0) return "";
    return [
      `[벌금 정산] 총 ${G(r.total)} · ${r.n}인 · 1인당 몫 ${G(r.shares[0])}`,
      "",
      // 카드와 같게, 보내는 사람 단위로 묶어서 적습니다
      ...mails.flatMap((m) => [
        `${seatName(party[m.from], m.from)} — 우편 ${m.items.length}통 · ${G(m.total)}`,
        ...m.items.map(
          (t) => `  → ${seatName(party[t.to], t.to)}  ${G(t.amount)} (수령 ${G(t.received)})`
        ),
      ]),
      "",
      `송금 ${r.transfers.length}회 · 이동 ${G(r.moved)} · 수수료 ${G(r.feeTotal)}`,
    ].join("\n");
  };

  const openMail = () => {
    const text = mailText();
    if (text) setShare(text);
  };

  const copyChat = () => {
    if (chatLine) copy(chatLine, "chat");
  };

  const copyLink = () => {
    // 금액만 모드는 한글이 그대로 보이는 짧은 주소로, 안 되는 이름이 섞여 있으면 base64 로
    const hash =
      simple && simpleLinkable(rows)
        ? encodeSimpleHash(rows, feePercent, unit)
        : `${MODE_KEY}=${mode}&${SHARE_KEY}=${encodeState(cols, rows, feePercent, mode, unit)}`;
    if (canOwnUrl) {
      const { origin, pathname, search } = window.location;
      window.history.replaceState(null, "", `${pathname}${search}#${hash}`);
      copy(`${origin}${pathname}${search}#${hash}`, "link");
    } else {
      // 아티팩트처럼 주소가 우리 것이 아닌 환경 — 코드만 복사. 메모장에 붙여넣으면 열립니다.
      copy(`#${hash}`, "link");
    }
  };

  /* 준비 상태의 줄 분류 (§3.1, 2026-09-05 목업 확정) — on 앉음 / off 연결 끊김 / new 방금 앉음 / typed 직접 적은 이름 / empty 빈 자리.
     방장은 자리(seats)와 명단(members)으로, 파티원은 판에 실린 rows2(a: 계정 붙은 줄)로 봅니다 */
  const seatKind = (row, i) => {
    if (!readOnly) {
      const st = seats.find((k) => k.id === row.id);
      const acct = st && st.acct;
      const name = ((st ? st.name : row.name) || "").trim();
      if (acct) {
        const mem = members.find((k) => k.acct === acct);
        const host = i === 0 || (auth && acct === auth.id);
        /* 방금 앉은 사람은 들어오는 길에 소켓이 한 번 갈리곤 합니다(로그인 뒤 다시 엶) — 그 10초는 '방금 앉았어요'가 먼저 */
        if (!host && arrived[row.id])
          return { kind: "new", host, mine: false, nick: (mem && mem.nick) || name, masked: acct.slice(0, 2) + "••••" };
        if (!host && mem && mem.on === false) return { kind: "off", host, mine: false };
        return { kind: "on", host, mine: false };
      }
      return { kind: name && !isFillName(name) ? "typed" : "empty", host: false, mine: false };
    }
    const r2 = rows2v.find((x) => x.rowId === row.id);
    const name = seatName(row, i);
    /* 내 줄은 서버가 준 you.rowId 가 먼저입니다 — 방장이 새 판을 밀기 전에도 내 자리가 '나'로 보이게 */
    const mine = !!you && you.rowId === row.id;
    if ((r2 && r2.a) || mine) return { kind: "on", host: i === 0, mine };
    return { kind: isFillName(name) ? "empty" : "typed", host: false, mine: false };
  };
  const seatStrip = (row, i) => {
    const k = seatKind(row, i);
    const first = (kind) => rows.findIndex((r, j) => seatKind(r, j).kind === kind) === i;
    let body;
    if (k.kind === "on" || k.kind === "new")
      body = (
        <>
          <i className="gs-sdot" aria-hidden="true" />
          <b>{k.kind === "new" ? "방금 앉았어요" : "앉음"}</b>
          {k.host && <span className="gs-lb-tag gs-lb-tag-host">방장</span>}
          {k.mine && <span className="gs-lb-tag">나</span>}
          {k.kind === "new" && (
            <span className="gs-seatstrip-hint">
              {k.nick} {k.masked}
            </span>
          )}
        </>
      );
    else if (k.kind === "off")
      body = (
        <>
          <i className="gs-sdot off" aria-hidden="true" />
          연결 끊김
        </>
      );
    else if (k.kind === "typed")
      body = readOnly
        ? "방장이 적은 이름"
        : first("typed")
        ? "직접 적은 이름 — 이 사람이 초대로 들어오면 여기 앉아요"
        : "직접 적은 이름";
    else body = !readOnly && auth && first("empty") ? "빈 자리 — 초대 코드로 차요" : "빈 자리";
    /* 시작 전엔 본인이 빈 줄로 옮길 수 있습니다 (§3.2, 2026-09-05 표준화). 진행 중엔 방장만 */
    const canMove =
      readOnly &&
      guestLobby &&
      !!you &&
      you.st === "ok" &&
      !!you.rowId &&
      you.rowId !== row.id &&
      (k.kind === "typed" || k.kind === "empty");
    return (
      <td key="strip" className="gs-seatstripcell" colSpan={Math.max(1, activeCols.length)}>
        <div className={"gs-seatstrip gs-seatstrip-" + k.kind}>
          {body}
          {canMove && (
            <button className="gs-swaplink gs-strip-move" disabled={claimBusy} onClick={() => claimRow(row.id)}>
              이 줄로 옮기기
            </button>
          )}
        </div>
      </td>
    );
  };
  /* 도구줄의 자리 요약 — 띠를 훑지 않아도 한눈에 */
  const seatSum = seats.reduce(
    (a, x) => {
      if (x.acct) a.on++;
      else if ((x.name || "").trim() && !isFillName(x.name)) a.typed++;
      else a.empty++;
      return a;
    },
    { on: 0, typed: 0, empty: 0 }
  );
  /* 들어오려는 사람 (§3.3, 2026-09-05 표준화) — 정원이 차서 기다리는 사람, 내보냈다 다시 온 사람, 진행 중에
     들어왔는데 빈 줄이 없어 자리를 기다리는 사람. 모집 카드와 판 중 [초대 링크] 창이 같은 목록을 씁니다 */
  const waiting = members.filter(
    (m) => m.st === "ok" && !m.rowId && !seats.some((k) => k.acct === m.acct)
  );
  /* 표가 사람을 말합니다 (2026-09-06 모델) — 들어오려는 사람은 전부 표에 섭니다. 자기 줄(퇴장·내보냄으로 남은 장부 줄,
     계정 출처 who)이 있으면 그 줄 밑에 붙고, 없으면 표 맨 아래. 규칙이 자리로 읽히게 하는 것이 요지입니다 */
  const ownRowOf = (acct) => seats.find((k) => !k.acct && k.left && k.who === acct) || null;
  /* 표 아래 줄 — 신청(내보냈던 사람·정원 참)과, 진행 중에 처음 온 사람(`들어왔어요`, [받기]가 첫 빈 줄/새 줄에 앉힘).
     자기 줄이 남아 있는 사람은 그 줄 밑에 붙습니다. 시작 전에 처음 온 사람은 위 효과가 바로 앉혀 여기 서지 않습니다 */
  const waitAll = [...pending, ...waiting.filter((w) => !!ownRowOf(w.acct)).map((w) => ({ ...w, waiting: true }))];
  const waitBelow = [
    ...pending.filter((p) => !ownRowOf(p.acct)),
    ...(roundLive ? waiting.filter((w) => !ownRowOf(w.acct)).map((w) => ({ ...w, waiting: true })) : []),
  ];
  const waitWhy = (p) =>
    p.kicked ? "내보냈던 사람이에요" : p.inv ? "초대받고 왔는데 자리가 없었어요" : p.full ? "자리가 다 찼어요" : p.waiting ? "들어왔어요" : "자리가 없어요";
  /* 이/가 — 이름 끝 받침으로 (순두부가 · 감독이) */
  const ga = (w) => {
    const c = (w || "").trim().slice(-1).charCodeAt(0);
    if (!(c >= 0xac00 && c <= 0xd7a3)) return "가";
    return (c - 0xac00) % 28 ? "이" : "가";
  };
  const waitDeny = (p) => (p.st === "req" ? denyMember(p.acct) : kickMember(p.acct));
  /* [받기] — 신청은 승인, 진행 중에 들어온 사람은 첫 빈 줄(없으면 새 줄)에 앉힙니다. 자리를 고르는 시트는 없습니다 */
  const waitTake = (p) =>
    Promise.resolve(p.st === "req" ? approveMember(p.acct, p.nick || p.acct) : placeMember(p.acct, p.nick || p.acct)).then((id) => {
      if (tutorialRef.current) tutHit("take"); // 같이 해보기 5걸음
      return id;
    });
  const waitPlace = (p, seatId) =>
    Promise.resolve(seatMember(p.acct, p.nick || p.acct, seatId, p.st === "ok" ? { local: true } : undefined)).then((id) => {
      if (tutorialRef.current) tutHit("take"); // 같이 해보기 7걸음 — 고른 줄에 앉음
      return id;
    });
  /* 시작 전에 들어온 사람은 앱이 앉힙니다 — 첫 빈 자리. 방장 앱이 없던 사이 들어온 사람도 돌아오면 여기서 앉습니다.
     진행 중엔 앱이 앉히지 않습니다 — 표 아래에 서고 방장이 [자리 정하기] 시트에서 줄을 직접 고릅니다(빈 줄·퇴장 줄·새 줄).
     (기록 2026-09-06) 제가 규칙표를 새로 쓰며 진행 중도 자동 착석으로 바꿔 넣었고 그 지점의 동의를 받지 않았다 —
     사용자의 원래 말("id가 같으면 같은 자리로, 나머지는 자리 지정 필요")대로 되돌린다. (재정정, 같은 날) 되돌리면서도 [받기]가
     첫 빈 줄에 앉히게 두었는데 그것도 자동 배치다 — 사용자: "[받기]를 눌러서 바로 앉히는 게 아니지 않나요? 몇 번씩 얘기된 건데" → 시트로.
     자기 줄(출처)이 남아 있는 사람은 시작 전이든 진행 중이든 그 줄 밑 요청으로 [받기]를 기다립니다 */
  const placing = useRef(new Set());
  useEffect(() => {
    if (readOnly || !auth || (!tutorial && (!relay.room || !membersLoaded.current))) return;
    if (roundLive) return;
    waiting.forEach((m) => {
      if (placing.current.has(m.acct) || ownRowOf(m.acct)) return;
      placing.current.add(m.acct);
      Promise.resolve(placeMember(m.acct, m.nick || m.acct)).finally(() => placing.current.delete(m.acct));
    });
  }, [memberSig, roundLive, seats.length]);
  const reqList = (ghost) =>
    pending.length + waiting.length > 0 ? (
      <div className="gs-lbsec">
        <h5 className="gs-lbsec-h">
          들어오려는 사람<span className="gs-lbcnt">{pending.length + waiting.length}</span>
        </h5>
        {pending.map((p) => (
          <ReqRow
            key={p.acct}
            req={p}
            ghost={!!ghost}
            onDeny={denyMember}
            onApprove={() => approveMember(p.acct, p.nick || p.acct)}
          />
        ))}
        {waiting.map((p) => (
          <ReqRow
            key={p.acct}
            req={{ ...p, waiting: true }}
            ghost={!!ghost}
            onDeny={kickMember}
            onApprove={() => placeMember(p.acct, p.nick || p.acct)}
          />
        ))}
      </div>
    ) : null;
  /* 초대 링크 한 줄 (§3.1) — 모집 카드와 판 중 [초대 링크] 창이 같은 조각을 씁니다 (2026-09-05).
     살아 있는 초대만 옵니다 (§9) — 죽은 링크가 떠 있는 상태를 아예 안 만듭니다 */
  /* ── 파티 허브 (2026-09-07 사용자 확정) — 생성·참여·나가기·해산·초대가 한 곳. 헤더 칩의 팝오버와 로비 2열 카드가 같은 내용 ── */
  const seatNamesNow = seats.filter((s0) => s0.acct).map((s0) => s0.name || s0.nick || "").filter(Boolean);
  const seatedCount = seats.filter((s0) => s0.acct).length;
  const hasPartyNow = !!(auth && relay.room);
  /* 칩 얼굴 — 지금 내가 속한 방 하나. 뷰어(파티원)는 그 파티, 방장 앱은 앉은 남의 파티 > 내 판 > 없음 */
  /* A안 (2026-09-07 사용자 확정): 역할 한 마디가 앞에 — `● 방장 · 진행 중` / `● 방장 · 모집 중 n/정원` / `● 파티원 · {방장}네 파티`. 닉은 허브 머리가 맡는다.
     (폐기, 같은 날) `● 진행 중 · 내 판` · `● {방장}네 파티 · 진행 중` — 내가 누군지(신분)가 없었다 */
  const hubFace = viewer
    ? guestPlaying || guestWaiting
      ? { dot: true, text: "파티원 · " + (ownerNick ? ownerNick + "네 파티" : "파티") }
      : null
    : seatedNow && !boardOn
      ? { dot: true, text: "파티원 · " + seatedName }
      : roundLive
        ? { dot: true, text: (hasPartyNow ? "방장 · " : "") + "진행 중" + (hasPartyNow ? "" : " · 내 판") }
        : boardOn
          ? hasPartyNow
            ? { dot: true, text: "방장 · 모집 중 " + seatedCount + "/" + lobbyCap }
            : { dot: false, text: "시작 전 · 내 판" }
          : { dot: false, text: "파티 없음" };
  const partyHub = (where) => {
    const goBox = (cls, onGo, inner) => (
      <div
        className={"gs-lh-box gs-lh-go" + (cls ? " " + cls : "")}
        role="button"
        tabIndex={0}
        onClick={onGo}
        onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && onGo()}
      >
        {inner}
      </div>
    );
    const names = (list) => (list.length ? list.join(" · ") : "아직 아무도 없어요");
    /* 머리 (2026-09-07 사용자 확정) — 팝오버(판 화면)는 아바타·닉·역할 뱃지·상태 한 줄: 계정 카드가 없는 화면이라 내가 누군지 여기서 말한다.
       로비 카드는 역할·상태만 — 바로 옆 계정 카드가 나를 말하니 "나"는 한 화면에 한 번(사용자: 칩=허브인데 로비에선 중복) */
    const myNick = (viewer && you && you.nick) || (auth && auth.nick) || "";
    const head = (dot, text, role) =>
      where === "pop" && auth ? (
        <div className="gs-hub-me">
          <Ava id={auth.id} nick={myNick} size={30} host={role === "방장"} />
          <b>{myNick}</b>
          {role && <span className={"gs-rolebadge" + (role === "방장" ? "" : " gs-rolebadge-dim")}>{role}</span>}
          <span className="gs-hub-st">
            {dot && <em className="gs-livechip-dot" aria-hidden="true" />}
            {text}
          </span>
        </div>
      ) : (
        <h4 className={"gs-lbcard-h" + (dot ? " gs-lh-facet" : "")}>
          {dot && <em className="gs-livechip-dot" aria-hidden="true" />}
          {role ? role + " · " : ""}
          {text}
        </h4>
      );
    /* 보관된 초대 — 어느 얼굴에서든 맨 위 한 줄 (초안) */
    const pending =
      !viewer && pendingJoin ? (
        <div className="gs-hub-pending" role="status">
          <span>
            <b>받은 초대</b>가 기다려요.
          </span>
          <span className="gs-hub-pending-r">
            <button className="gs-btn gs-btn-sm gs-btn-ghost" onClick={dropPendingJoin}>
              지우기
            </button>
            <button className="gs-btn gs-btn-sm gs-lbstart" onClick={askLeaveForJoin}>
              참여하기
            </button>
          </span>
        </div>
      ) : null;
    if (viewer) {
      /* 파티원 — 앉은 사람·내 벌금·[파티 나가기]. (폐기 2026-09-07) 빵부스러기 줄의 [파티 나가기] */
      const list =
        vlobby && vlobby.names
          ? vlobby.names.filter((x) => x.live).map((x) => x.n)
          : rows.filter((r) => (rows2v.find((x) => x.rowId === r.id) || {}).a).map((r) => seatName(r, rows.indexOf(r)));
      return (
        <>
          {head(true, <>{ownerNick ? ownerNick + "네 파티" : "파티"} · {vlobby ? "시작 전" : "진행 중"}</>, "파티원")}
          <div className="gs-lh-box">
            <p className="gs-lh-facts">
              {list.length}명{myRow ? " · 내 벌금 " + man(myGold) : ""}
            </p>
            <p className="gs-lh-names">{names(list)}</p>
            <div className="gs-lh-acts">
              <button className="gs-btn gs-btn-sm gs-btn-ghost" onClick={leaveRoom}>
                파티 나가기
              </button>
            </div>
          </div>
        </>
      );
    }
    if (seatedNow && !boardOn) {
      /* 남의 파티에 앉은 채 (내 판 없음) — 돌아가기·나가기 */
      return (
        <>
          {pending}
          {head(true, <>{seatedName} · {meSeat.round ? "진행 중" : "시작 전"}</>, "파티원")}
          <div className="gs-lh-boxwrap">
            {goBox(
              "",
              () => enterRoom(meCur, { push: true }),
              <>
                <p className="gs-lh-sub">{meSeat.round ? "파티가 진행 중이에요." : "방장이 시작하길 기다려요."}</p>
                <span className="gs-lh-goto">돌아가기 ›</span>
              </>
            )}
            <button className="gs-lh-x" onClick={askLeaveFromLobby} aria-label="파티 나가기">
              나가기
            </button>
          </div>
          {/* 문 둘은 여기에도 — 누르면 방 하나 규칙이 먼저 묻습니다(나가고 만들기 / 나가고 옮기기) */}
          <div className="gs-lh-acts">
            <button className="gs-btn gs-btn-ghost gs-lifebtn gs-lh-newbtn" onClick={askNewBoard}>
              + 새 판 만들기
            </button>
          </div>
          <JoinBox onJoin={joinByCode} />
        </>
      );
    }
    if (!boardOn) {
      /* 판 없음 — 새 판 만들기와 참여 칸. 시작 전에 해산당한 쪽지도 여기 (초안) */
      return (
        <>
          {pending}
          {disbandNote && !seatedNow && (
            <div className="gs-note" role="status">
              <span>
                <b>{disbandNote.host ? disbandNote.host + "네 파티" : "파티"}</b>가 해산됐어요.
              </span>
              <button className="gs-note-x" onClick={dropDisbandNote} aria-label="닫기">
                ×
              </button>
            </div>
          )}
          {head(false, "파티 없음", null)}
          <div className="gs-lh-box empty">
            <p className="gs-lh-sub">{auth ? "내 판이 없어요." : "벌금을 셀 판을 만들어요 — 계정은 필요 없어요."}</p>
            <div className="gs-lh-acts">
              <button className={"gs-btn gs-lifebtn gs-lh-newbtn " + (auth ? "gs-btn-ghost" : "gs-lbstart")} onClick={askNewBoard}>
                + 새 판 만들기
              </button>
            </div>
          </div>
          {/* 비밀 파티 입장 문법 — 주소를 그대로 붙여넣어도, 코드 8자만 쳐도 들어가진다. 같은 말은 한 번만 (2026-09-07 사용자) */}
          <JoinBox onJoin={joinByCode} />
        </>
      );
    }
    const own = seatedNow ? (
      /* 규칙 이전에 생긴 상태(남의 파티 착석 + 내 판) — 판은 그대로 문이 있고, 파티 줄 하나만 덧붙입니다 */
      <p className="gs-hub-own">
        <em className="gs-livechip-dot" aria-hidden="true" />
        {seatedName} · {meSeat.round ? "진행 중" : "시작 전"}
        <button className="gs-auth-linkb" onClick={() => enterRoom(meCur, { push: true })}>
          돌아가기
        </button>
        <button className="gs-auth-linkb" onClick={askLeaveFromLobby}>
          나가기
        </button>
      </p>
    ) : null;
    if (roundLive) {
      const filled = seats.filter((x) => x.acct || ((x.name || "").trim() && !isFillName(x.name)));
      const sinceMin = roundSinceMin();
      return (
        <>
          {pending}
          {head(true, <>진행 중 · <b>{roundName || defaultRoundName()}</b></>, hasPartyNow ? "방장" : null)}
          {/* (폐기 2026-09-07 사용자) `판을 두고 나온 상태예요 — 파티원은 그대로 셀 수 있어요.` — 로비를 보는 건 나간 게 아니다 */}
          {goBox(
            "live",
            goBoard,
            <>
              <p className="gs-lh-facts">
                {filled.length}명 · 벌금 {man(rows.reduce((a, r) => a + itemGold(r), 0))}
                {sinceMin != null && (sinceMin < 1 ? " · 방금 시작" : " · " + sinceMin + "분째")}
              </p>
              {seatNamesNow.length > 0 && <p className="gs-lh-names">{seatNamesNow.join(" · ")}</p>}
              <span className="gs-lh-goto">벌금판으로 ›</span>
            </>
          )}
          {own}
          {hasPartyNow && where !== "board" && <div className="gs-hub-inv">{inviteLine()}</div>}
        </>
      );
    }
    /* 시작 전·모집 중 — 롤식 상자(상자 전체가 대기실 문, 우상단 [× 해산]) + 초대 한 덩이 */
    return (
      <>
        {pending}
        {head(hasPartyNow, hasPartyNow ? "모집 중" : "시작 전", hasPartyNow ? "방장" : null)}
        <div className="gs-lh-boxwrap">
          {goBox(
            "",
            goBoard,
            <>
              {/* `앉음` 라벨은 뺐습니다 (2026-09-07 사용자) */}
              <p className="gs-lh-facts">
                대기실 {seatedCount}/{lobbyCap}
              </p>
              <p className="gs-lh-names">{names(seatNamesNow)}</p>
              <span className="gs-lh-goto">대기실로 ›</span>
            </>
          )}
          <button className="gs-lh-x" onClick={() => askDisband(true)} aria-label="판 해산">
            <span aria-hidden="true">×</span> 해산
          </button>
        </div>
        {own}
        {hasPartyNow && <div className="gs-hub-inv">{inviteLine()}</div>}
      </>
    );
  };
  const inviteLine = () => (
    <>
      {!hostInvite ? (
        <div className="gs-lbinv">
          {/* 코드는 새 판 만들기가 냅니다 (2026-09-06) — 여기까지 오는 건 발급이 실패했을 때뿐. (폐기) [초대 링크 만들기] */}
          <button className="gs-btn gs-btn-sm" onClick={newInvite}>
            초대 코드 발급
          </button>
        </div>
      ) : (
        /* 코드가 주인공 (2026-09-05, ⑥) — 음성으로 불러 줄 수 있고 로비의 입력칸이 코드를 받습니다.
           화면은 통째로 방송에 잡히므로 코드는 가린 채 두고(눈으로 잠깐), 복사는 가린 채로도 됩니다.
           링크를 다시 내거나 나누는 순간이 곧 모으는 중입니다 — 끝낸 뒤 링크가 살아 있으면 [초대 링크 만들기]
           문이 안 서서 대기실 표시(lobby.open)를 켤 길이 여기 말고는 없습니다.
           (폐기 2026-09-05, 당일) 가린 주소 한 줄 + [디코용 복사] 하나 — 무엇을 어디에 붙이라는 건지 안 읽혔다 */
        <div className="gs-invcode">
          {/* 두 줄 고정 (2026-09-07 밤 사용자: 한 줄 flex-wrap 은 `새로 발급`이 혼자 다음 줄로 떨어졌다) — 1줄 코드 칩 + 새로 발급, 2줄 동작 셋(디코 메시지가 주 버튼).
              (폐기, 같은 날) 한 줄 [디코 메시지 복사][코드 칩][코드 복사][링크 복사] 새로 발급 — 좁으면 마지막 것만 떨어졌다.
              (폐기, 같은 날 낮) `초대 코드` 라벨 + 22px 코드 한 줄 + 아래 줄 [코드 복사][링크 복사] 디코 메시지 복사 … 새로 발급(오른쪽 끝) */}
          <div className="gs-invcode-l1">
            <span className="gs-invcode-chip">
              <b className="gs-invcode-b">
                {revealInv ? hostInvite.code.slice(0, 4) + " " + hostInvite.code.slice(4) : "•••• ••••"}
              </b>
              <button
                className="gs-btn gs-btn-sm gs-btn-ghost gs-eyebtn"
                onClick={() => setRevealInv((v) => !v)}
                aria-label={revealInv ? "가리기" : "보기"}
                title={revealInv ? "가리기" : "보기"}
              >
                <Eye on={revealInv} />
              </button>
            </span>
            <button
              className="gs-swaplink gs-invcode-renew"
              onClick={() => {
                newInvite();
                if (!lobbyOn) startParty();
              }}
            >
              새로 발급
            </button>
          </div>
          <div className="gs-invcode-l2">
            <button
              className="gs-btn gs-btn-sm gs-lbstart gs-invdiscbtn"
              onClick={() => {
                copy(inviteMsg(auth.nick, hostInvite.url), "inv");
                if (!lobbyOn) startParty();
              }}
            >
              {flash === "inv" ? "복사했어요" : "디코 메시지 복사"}
            </button>
            <button
              className="gs-btn gs-btn-sm gs-btn-ghost gs-invlinkbtn"
              onClick={() => {
                if (tutorialRef.current) {
                  /* 같이 해보기 2걸음 — 보내는 건 저희가 대신합니다 */
                  setFlash("invurl");
                  setTimeout(() => setFlash(""), 1500);
                  tutHit("link");
                  return;
                }
                copy(hostInvite.url, "invurl");
                if (!lobbyOn) startParty();
              }}
            >
              {flash === "invurl" ? "복사했어요" : "링크 복사"}
            </button>
            <button
              className="gs-btn gs-btn-sm gs-btn-ghost"
              onClick={() => {
                copy(hostInvite.code, "invcode");
                if (!lobbyOn) startParty();
              }}
            >
              {flash === "invcode" ? "복사했어요" : "코드 복사"}
            </button>
          </div>
        </div>
      )}
    </>
  );
  /* 표가 무대보다 넓어지면 카드가 표 폭만큼 커지고 스크롤은 창이 합니다 (2026-09-06 낮 사용자: 표 안 스크롤보다 알아보기 쉽다).
     CSS 만으론 안 됐습니다 — 크롬이 표의 고유 폭을 셀 min-width 없이 재서 max-content/fit-content 가 안 커졌고 인라인 width 도 안 먹었다.
     그래서 표를 잠깐 auto 로 두고 잰 폭을 카드의 min-width 로 줍니다. 열이 줄면 min-width 를 걷고 다시 잽니다 */
  const sheetBoxRef = useRef(null);
  const gridRef = useRef(null);
  useLayoutEffect(() => {
    const card = sheetBoxRef.current;
    const tbl = gridRef.current;
    if (!card || !tbl) return;
    const inner = tbl.parentElement && tbl.parentElement.parentElement; // .gs-scroll 의 부모 = 카드 안쪽 폭
    card.style.minWidth = "";
    tbl.style.width = "auto";
    const need = tbl.offsetWidth;
    tbl.style.width = "";
    const room = inner ? inner.clientWidth : card.clientWidth;
    if (need > room + 1) card.style.minWidth = need + (card.offsetWidth - room) + "px";
  }, [cols, simple, readOnly, tab, view, unit]);
  return (
    <div className={"gs" + (tabbed ? " gs-tabbed" : "") + (dark ? " gs-dark" : "") + (picking ? " gs-picking" : "") + (inviteGate ? " gs-invitegate" : "") + (!readOnly && burstRows.length > 0 ? " gs-pressing" : "") + (coach && coach.kind === "party" ? " gs-coaching" : "")}>
      {DEMO &&
        (() => {
          /* 진행 표시 (2026-09-06 사용자 확정) — 장 점을 선으로 잇고 지금 장은 크게, 옆에 `3장 파티원 모으기 · 2/4`.
             독립 파티원 튜토리얼은 걸음 점 여섯 개. [그만두기]는 없습니다 — ✕·Esc 가 나가는 길 */
          const st = coach && coach.kind === "party" ? TOUR_FLOW[coach.step] : null;
          const soloMember = DEMO_MEMBER && !DEMO_CH4;
          const ch = st ? st.ch : DEMO_CH4 ? 3 : DEMO_MEMBER ? 7 : 0;
          const inCh = TOUR_FLOW.filter((x) => x.ch === ch);
          const shown = inCh.filter((x) => x.wait !== "auto");
          const cur = st ? Math.max(1, shown.indexOf(st) + 1 || inCh.slice(0, inCh.indexOf(st) + 1).filter((x) => x.wait !== "auto").length) : 0;
          const dots = soloMember ? shown.length : TOUR_CHAPTERS.length;
          const now = soloMember ? cur - 1 : ch;
          return (
            <div className="gs-demoband" role="status" aria-label="튜토리얼 진행">
              <span className="gs-tourdots" aria-hidden="true">
                {Array.from({ length: dots }, (_, i) => (
                  <i key={i} className={"gs-tourdot" + (i < now ? " done" : i === now ? " now" : "")} />
                ))}
              </span>
              <span className="gs-tourlabel">
                {soloMember ? "파티원 튜토리얼" : ch + 1 + "장 " + TOUR_CHAPTERS[ch]}
                {st ? " · " + cur + "/" + shown.length : ""}
              </span>
              {/* 나가는 길을 띠에 명시 (2026-09-06 낮 사용자 지정 문구). ✕·Esc 도 그대로. 띠는 걸음 막 위라 늘 눌리고,
                  4장 파티원 예시에서 눌러도 부모가 전체를 닫습니다 */}
              <button className="gs-btn gs-btn-sm gs-btn-ghost gs-tourquit" onClick={() => endPartyCourse(false)}>
                튜토리얼 나가기
              </button>
            </div>
          );
        })()}
      <style>{CSS}</style>

      {/* ── 시스템 줄 — 뷰포트 맨 위에 딱 붙는 전폭 바. 안쪽 내용은 본문과 같은 열 ── */}
      <div className="gs-sysbar">
        <div className="gs-sysbar-in">
          {/* 브랜드 = 로비 문 (§3.0, 표준 홈 버튼 문법). 화면 이동은 멤버십을 건드리지 않습니다 */}
          <button className="gs-sysbrand" onClick={goLobby} aria-label="로비로">
            벌금 정산
          </button>
          {/* 지금 어느 화면인지 — 브랜드 옆 한 마디: 로비 / 벌금판 (2026-09-05) */}
          {!inviteGate && (
            <span className="gs-sysscreen">{genView ? "판 기록" : showLobby ? "로비" : "벌금판"}</span>
          )}
          {/* 파티 칩 하나 (2026-09-07 사용자 확정: 헤더 리뉴얼 — 방은 하나) — 지금 내가 속한 방 하나만 말하고, 누르면 파티 허브.
              로비에서는 없습니다(로비 2열이 같은 허브). (폐기, 같은 날) liveAway·memberAway·readyAway 세 칩 — 내 판 모집 중 + 남의 파티 착석이면 둘이 나란히 섰다.
              (폐기 2026-09-05) 파티 칩(`내 파티 · n명 ●`·`{방장}네 파티`)과 파티 서랍 */}
          {hubFace && !showLobby && !inviteGate && (
            <span className="gs-invwrap gs-hubwrap" ref={invWrapRef}>
              <button
                className={"gs-livechip gs-hubchip" + (hubFace.dot ? "" : " gs-hubchip-off") + (invOpen ? " on" : "")}
                onClick={() => setInvOpen((v) => !v)}
                aria-haspopup="dialog"
                aria-expanded={invOpen}
              >
                {hubFace.dot && <em className="gs-livechip-dot" aria-hidden="true" />}
                {hubFace.text}
              </button>
              {invOpen && (
                <div className="gs-invpop gs-hubpop" role="dialog" aria-label="파티 허브">
                  {partyHub("pop")}
                </div>
              )}
            </span>
          )}
          <div className="gs-sysbar-r">
            {/* (폐기 2026-09-07) 헤더 [초대 코드] 버튼과 팝오버 — 파티 허브로 흡수 (사용자 확정: 헤더는 허브 칩과 OBS 둘) */}
            {/* 방송 조작 — 어느 탭에 있든 항상 같은 자리. 버튼은 이것 하나고(§5.7)
                비로그인도 이 문으로 들어갑니다 — 주소 발급은 창 안 [내 방송용 주소
                받기]가 대문을 엽니다. 얼굴은 고정 라벨 + 송출 점: 상태어는 창 첫 줄과
                이 툴팁이 말합니다 */}
            {(!readOnly || shareGuest) && (
              <span className="gs-tip">
                <button
                  className={"gs-btn gs-btn-ghost gs-obsbtn" + (dotState === "on" ? " on" : "")}
                  onClick={() => {
                    courseHit("obs"); // 튜토리얼 6장·파티원 4걸음
                    setObsOpen(true);
                  }}
                >
                  {/* OBS 로고는 상표라 안 씁니다 — 이름을 글자로 쓰는 건 괜찮지만
                      마크를 넣으면 OBS 쪽이 만든 것처럼 보일 여지가 있습니다.
                      대신 송출을 뜻하는 모니터 아이콘을 답니다. */}
                  <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                    <g fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="1.6" y="2.6" width="12.8" height="8.6" rx="1.4" />
                      <path d="M5.6 14h4.8M8 11.2V14" />
                    </g>
                  </svg>
                  OBS 공유 설정
                  <em className={"gs-castdot gs-castdot-" + dotState} aria-hidden="true" />
                </button>
                <span className="gs-tip-body gs-tip-r" role="tooltip">
                  {shareGuest ? (
                    <>
                      <b>내 방송용 주소</b>와 오버레이 외형을 여기서 챙겨요. 주소는 사람마다
                      하나씩이에요.
                    </>
                  ) : (
                    <>
                      {CAST_WHY[castState]}
                      <br />
                      눌러서 주소와 오버레이 외형을 챙겨요.
                    </>
                  )}
                </span>
              </span>
            )}
            {/* [?] = 튜토리얼 고르기 팝오버 (2026-09-06 사용자 확정) — 방장·파티원 둘 다 늘 보이고, 이 화면에 맞는 쪽이 채운 [보기]와 `추천`.
                (폐기) 사용법 모달(화면별 사용법 목록). 점은 이 화면에 맞는 튜토리얼을 아직 안 봤을 때 */}
            <span className="gs-helpwrap" ref={helpWrapRef}>
              <button
                className={"gs-qm gs-helpbtn" + (helpOpen ? " gs-qm-on" : "")}
                onClick={() => {
                  if (DEMO) return;
                  setHelpAuto(false);
                  setHelpOpen((v) => !v);
                }}
                aria-haspopup="dialog"
                aria-label="튜토리얼"
              >
                ?
                {!DEMO && !coach && !coachSeen(recMember ? "mtour" : "party") && <i className="gs-qdot" aria-hidden="true" />}
              </button>
              {helpOpen && !DEMO && (
                <div className="gs-invpop gs-helppop" role="dialog" aria-label="튜토리얼">
                  <p className="gs-helppop-h">{helpAuto ? "처음이시죠? 튜토리얼을 볼까요?" : "튜토리얼을 볼까요?"}</p>
                  {/* 행 = 이름 + 칩(추천·봤어요) + 역할 한 줄 + 서브, 오른쪽에 [보기]/[다시 보기] (2026-09-06 낮 사용자: 시인성·역할 설명).
                      역할 문구 — 파티원은 사용자 지정, 방장은 초안. (폐기, 같은 날) 한 줄에 이름·서브·버튼 안 `추천` */}
                  {[
                    { k: "host", name: "방장 튜토리얼", role: "판을 열고 파티원을 부르는 사람", sub: TOUR_CHAPTERS.length + "장 · 판 만들기부터 끝내기까지", seen: coachSeen("party"), go: startPartyCourse },
                    { k: "member", name: "파티원 튜토리얼", role: "초대를 받은 사람", sub: MEMBER_STEPS.filter((x) => x.wait !== "auto").length + "걸음 · 자수와 내 방송 주소", seen: coachSeen("mtour"), go: startMemberTour },
                  ]
                    .sort((a, b) => (a.k === recKey ? -1 : b.k === recKey ? 1 : 0))
                    .map((r) => (
                      <div key={r.k} className={"gs-helprow" + (r.k === recKey ? " gs-helprow-rec" : "")}>
                        <div className="gs-helprow-main">
                          <div className="gs-helprow-top">
                            <b>{r.name}</b>
                            {r.k === recKey && <em className="gs-rec">추천</em>}
                            {r.seen && <span className="gs-helpseen">봤어요</span>}
                          </div>
                          <p className="gs-helprow-role">{r.role}</p>
                          <p className="gs-helprow-sub">{r.sub}</p>
                        </div>
                        <button
                          className={"gs-btn gs-btn-sm" + (r.k === recKey ? "" : " gs-btn-ghost")}
                          onClick={() => {
                            setHelpOpen(false);
                            r.go();
                          }}
                        >
                          {r.seen ? "다시 보기" : "보기"}
                        </button>
                      </div>
                    ))}
                  <p className="gs-guide-foot">OBS에 넣는 방법과 방송 주소 안내는 [OBS 공유 설정] 창에 있어요.</p>
                </div>
              )}
            </span>
            {/* 하는 일과 나를 가릅니다 — 왼쪽은 이 앱으로 하는 일, 오른쪽은 내 것입니다 */}
            <span className="gs-sysbar-sep" aria-hidden="true" />
            {/* 화면 밝기 — 시스템 → 밝게 → 어둡게 순으로 돕니다 */}
            <span className="gs-viewseg">
              <span className="gs-tip">
                <button
                  className={theme === "system" ? "" : "on"}
                  onClick={() =>
                    setTheme(theme === "system" ? "light" : theme === "light" ? "dark" : "system")
                  }
                  aria-label={`화면 밝기: ${
                    theme === "system" ? "시스템 설정" : theme === "light" ? "밝게" : "어둡게"
                  }`}
                >
                  {theme === "light" ? (
                    <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
                      <g fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
                        <circle cx="8" cy="8" r="3.1" />
                        <path d="M8 1.2v1.6M8 13.2v1.6M1.2 8h1.6M13.2 8h1.6M3.2 3.2l1.1 1.1M11.7 11.7l1.1 1.1M12.8 3.2l-1.1 1.1M4.3 11.7l-1.1 1.1" />
                      </g>
                    </svg>
                  ) : theme === "dark" ? (
                    <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
                      <path
                        d="M13 10.3A5.6 5.6 0 0 1 5.7 3a5.8 5.8 0 1 0 7.3 7.3z"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.4"
                        strokeLinejoin="round"
                      />
                    </svg>
                  ) : (
                    <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
                      <circle
                        cx="8"
                        cy="8"
                        r="6"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.4"
                      />
                      <path d="M8 2a6 6 0 0 1 0 12z" fill="currentColor" />
                    </svg>
                  )}
                </button>
                <span className="gs-tip-body gs-tip-r" role="tooltip">
                  <b>
                    {theme === "system"
                      ? "시스템 설정을 따라요"
                      : theme === "light"
                      ? "밝게 고정"
                      : "어둡게 고정"}
                    </b>{" "}
                  — 눌러서 {theme === "system" ? "밝게" : theme === "light" ? "어둡게" : "시스템"}
                  로 바꿔요.
                </span>
              </span>
            </span>
            {/* 계정 서랍은 폐지 — 닉·로그아웃·아이디 정하기는 전부 오버레이 공유 설정
                창 하단의 계정 섹션입니다 (§5.7). 헤더에 계정 버튼은 따로 없습니다 */}
          </div>
        </div>
      </div>

      {/* ── 내가 앉아 있는 방의 판이 다시 열렸어요 — 자기 앱에 돌아와 있는 사람에게
             화면을 잡아채지 않고 문 하나만 놓습니다 (§3.4·§8) ── */}
      {!viewer && backCard && !showLobby && (
        <div className="gs-guestbar">
          <div className="gs-slip gs-slip-green" role="status">
            <span className="gs-slip-msg">판이 시작됐어요.</span>
            <button
              className="gs-btn gs-btn-sm gs-slip-act"
              onClick={() => enterRoom(backCard.room, { push: true })}
            >
              들어가기
            </button>
          </div>
        </div>
      )}
      {/* ── 파티원 배너 — 화면 맨 위. 상태(초대·대기·판)에 따라 말이 바뀝니다.
             끝난 판·판 기록에서는 탭 위의 신분증 띠가 이 자리를 대신합니다 ── */}
      {readOnly && !genView && !ended && !blockedCard && !inviteGate && <div className="gs-guestbar">
      {/* (폐기 2026-09-05) 파티원 화면 맨 위의 내 방송용 주소 배너 — 주소 표면은 방장과 똑같이
          [오버레이 공유 설정] 창 하나입니다 (§5.3). 파티원만 주소가 세 군데 떠 있었습니다 */}
      {/* 읽기 전용 안내는 벌금표 카드 안으로 옮겼습니다 — 바깥 배너는 어느 탭에서나 봐야 하는
          것만 맡습니다(대기·거절·방장 부재·내 방송용 주소). 방장 부재도 자수 탭에서는 카드가
          말하므로 여기서는 뺍니다 — 같은 말이 화면에 둘이면 하나는 읽히지 않습니다. */}
      {/* 대기실엔 설명 슬립이 없습니다 (2026-09-06) — 칩 '시작 전'과 자리 띠가 말합니다. (폐기) `자리에 앉았어요 — 방장이 시작하면 함께 시작돼요.` */}
      {readOnly && !genView && !(guestPlaying && liveState !== "dead" && !left && !denied && (scribeOn || showConfess)) && !(guestWaiting && liveState !== "dead" && !denied) && (
        <div
          key={roPulse}
          className={
            "gs-slip gs-slip-live" +
            (liveState === "dead" ? " gs-slip-dead" : "") +
            (guestSeated ? " gs-slip-green" : "") +
            (roPulse ? " gs-slip-pulse" : "")
          }
          role="status"
        >
          <span className="gs-slip-msg">
            {liveState === "dead" ? (
              "이 주소는 더 이상 갱신되지 않아요. 방장에게 새 초대를 받아 주세요."
            ) : denied === "expired" ? (
              /* 판이 남아 있는 사람에게만 옵니다 — 볼 판이 없으면 안내 화면이 대신합니다 */
              "초대가 만료됐어요 — 방장에게 새 초대를 받아 주세요."
            ) : denied === "invite" ? (
              "이 초대는 쓸 수 없어요 — 방장에게 새 초대를 받아 주세요."
            ) : denied ? (
              "이 방을 볼 권한이 없어요 — 방장에게 초대를 받아 주세요."
            ) : demoRoom ? (
              <>
                <b>읽기 전용 화면</b>이에요 — 방장이 기록하면 <b>실시간으로 바뀌어요</b>.
                기록을 한 사람에게 맡기면 중복 입력 사고가 없어요.
              </>
            ) : !auth ? (
              <>
                <b>읽기 전용 화면</b>이에요 — 참여하려면 로그인이 필요해요.
              </>
            ) : you && you.st === "req" ? (
              /* 문 앞에 서 있는 상태입니다 — 노크든 링크 신청이든 기다리는 것은 같습니다.
                 취소는 본인 몫이라 옆에 [신청 취소]가 섭니다 (§3.3) */
              /* (폐기 2026-09-05) `참여를 신청했어요 — {닉}님이 수락하면 들어가요.` — 왜 기다리는지로 말합니다 */
              you.kicked
                ? "방장이 받아 주면 들어가요."
                : "자리가 다 찼어요 — 방장이 자리를 만들면 들어가요."
            ) : guestWaiting ? (
              <>
                <b>자리에 앉았어요</b> — 방장이 시작하면 함께 시작돼요.
              </>
            ) : guestPlaying ? (
              "방장이 자리를 비웠어요."
            ) : liveState === "on" ? (
              <>
                <b>읽기 전용 화면</b>이에요 — 참여하려면 초대가 필요해요.
              </>
            ) : liveState === "empty" ? (
              "아직 기록이 없어요. 장부가 채워지면 여기 실시간으로 보여요."
            ) : (
              "연결하는 중이에요…"
            )}
          </span>
          {/* 비로그인 파티원의 유일한 다음 걸음 — 배너 안에 둡니다 */}
          {!demoRoom && !auth && (
            <button
              className="gs-btn gs-btn-sm gs-slip-act"
              onClick={() =>
                /* 대문은 하나입니다 (§3.11) — 초대로 왔어도 같은 [계정 만들기] 화면이고,
                   게스트 문이 그 안에 있습니다. 진입점마다 화면을 갈아끼우지 않습니다 */
                openAuth("register")
              }
            >
              참여하기
            </button>
          )}
          {you && you.st === "req" && !left && (
            <button className="gs-btn gs-btn-sm gs-btn-ghost gs-slip-act" onClick={leaveRoom}>
              신청 취소
            </button>
          )}
          {guestWaiting && (
            <button className="gs-btn gs-btn-sm gs-btn-ghost gs-slip-act" onClick={leaveRoom}>
              나가기
            </button>
          )}
          {liveState === "on" && !guestWaiting && (
            <span className="gs-slip-who">
              {liveName}
              <em className="gs-live-dot" key={liveTick} aria-hidden="true" />
              실시간
            </span>
          )}
        </div>
      )}
      {/* (폐기 2026-09-06) 얼림 띠 `잠깐 멈췄어요 — 방장이 이어가면 다시 움직여요.` — 중단이라는 상태가 모델에 없다
          (자동 중단은 2026-09-05 폐기, 손 중단은 그 전에 폐기) */}
      {/* 다시 시작됐다는 카드 — 화면을 잡아채지 않고 [들어가기]를 기다립니다 */}
      {readOnly && !genView && startCard && !paused && (
        <div className="gs-slip gs-slip-green" role="status">
          <span className="gs-slip-msg">판이 시작됐어요.</span>
          <button
            className="gs-btn gs-btn-sm gs-slip-act"
            onClick={() => {
              setStartCard(null);
              setTab("confess");
            }}
          >
            들어가기
          </button>
        </div>
      )}
      {/* 자수가 막혔을 때의 한 줄 — 서버가 거절한 이유를 그 자리에서 알려 줍니다 */}
      {readOnly && confessErr && (
        <div className="gs-slip" role="status">
          <span className="gs-slip-msg">{confessErr}</span>
        </div>
      )}
      </div>}
      {/* ── 머리 ─────────────────────────────────────── */}
      {/* 대기실은 헤더 아래를 통째로 덮습니다 (§3-3) — 탭 줄과 마스트 버튼이 같이 보이면
          모이는 화면인지 벌금표인지 눈이 못 가릅니다.
          무효·만료 초대도 같습니다 — 볼 판이 없는데 탭 줄만 서 있으면 안 됩니다 */}
      {/* ── 로비 (홈, §3.0) ── */}
      {showLobby && (
        <LobbyHome
          auth={auth}
          obsUrl={auth && auth.obsToken ? roomApi.obsUrl(auth.obsToken) : ""}
          showObs={showObs}
          onToggleObs={() => setShowObs((v) => !v)}
          onCopy={copy}
          flash={flash}
          onSettings={() => setObsOpen(true)}
          onLogin={() => openAuth("register", () => setObsOpen(true))} // 로그인 뒤 OBS 창 — 거기서 주소를 받습니다 (2026-09-07 사용자)
          onUpgrade={() => setUpOpen({})}
          hub={partyHub("lobby")}
          tutLine={!readOnly && !boardOn && (!meCur || meCur === relay.room) && tutAsk && !tutorial}
          onTut={startPartyCourse}
          onDropTut={() => {
            coachDone("partyAsk");
            setTutAsk(false);
          }}
          gens={gensList()}
          onOpenGen={openGen}
          onDropGen={askDropGen}
          onAllGens={() => setGensOpen(true)}
        />
      )}
      {inviteGate && (
        <section className="gs-mail gs-invitesec">
          {/* 초대장은 문이지 화면이 아닙니다 (2026-09-06) — 헤더 없이 카드 하나만 가운데, 위에 앱 이름 작게 */}
          <div className="gs-invite-brand">벌금 정산</div>
          <div className="gs-card gs-invite">
            <svg viewBox="0 0 24 24" width="30" height="30" aria-hidden="true">
              <g fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="9" cy="8" r="3.2" />
                <path d="M2.8 19c.7-3.4 3-5.3 6.2-5.3s5.5 1.9 6.2 5.3" />
                <circle cx="17" cy="9" r="2.4" />
                <path d="M15.6 13.6c2.9 0 4.9 1.5 5.6 4.4" />
              </g>
            </svg>
            <h3 className="gs-invite-h">
              {ownerNick ? ownerNick + "님네 파티에 초대받았어요" : "파티에 초대받았어요"}
            </h3>
            {(() => {
              /* 사람 수는 계정이 붙은 자리만 셉니다 (2026-09-05 표준화) — 이름만 적힌 줄을 사람으로 세어
                 `4/8 모임`이 떴다. 초대받는 사람에게 필요한 건 "몇 명이 있고 자리가 남았나" */
              const list =
                vlobby && vlobby.names
                  ? vlobby.names.map((x) => ({ n: x.n, live: !!x.live }))
                  : rows
                      .map((r, i) => {
                        const r2 = rows2v.find((x) => x.rowId === r.id);
                        const n = seatName(r, i);
                        return { n, live: !!(r2 && r2.a), ph: isFillName(n) };
                      })
                      .filter((x) => !x.ph);
              const seated = list.filter((x) => x.live).length;
              const cap = vlobby && vlobby.cap ? vlobby.cap : rows.length;
              const empty = Math.max(0, cap - list.length);
              const running = !(vlobby && vlobby.cap);
              return (
                <>
                  <p className="gs-invite-sub">
                    {running ? "진행 중 · " : ""}
                    {seated}명 앉음 · 빈 자리 {empty}
                  </p>
                  {list.length > 0 && (
                    <p className="gs-invite-names">
                      {list.map((x, i) => (
                        <span key={x.n + i} className={x.live ? undefined : "gs-invite-typed"}>
                          {i > 0 ? " · " : ""}
                          {x.n}
                        </span>
                      ))}
                    </p>
                  )}
                </>
              );
            })()}
            <button
              className="gs-btn gs-lifebtn gs-lbstart gs-invite-go"
              onClick={() => {
                if (DEMO_CH4) {
                  /* 4장 파티원 예시 — 서버 없이 실리안 자리(r2)에 앉고 자수 화면으로 */
                  setVlobby(null);
                  setYou({ nick: "실리안", rowId: "r2", st: "ok" });
                  setJoinOk(true);
                  courseHit("join");
                  return;
                }
                setJoinOk(true);
                window.scrollTo(0, 0);
                if (!auth) openAuth("register");
              }}
            >
              참여하기
            </button>
            <p className="gs-invite-note">
              {auth ? (
                <>
                  <b>{auth.nick}</b> 계정으로 들어가요.
                </>
              ) : (
                "게스트로도 들어갈 수 있어요 — 닉네임만 정하면 돼요."
              )}
            </p>
          </div>
        </section>
      )}
      {!guestBlocked && !showLobby && !inviteGate && (
      <header className="gs-mast">
        {/* 판의 신분증 — 탭 위, 마스트 왼쪽 버튼들이 있던 자리입니다 */}
        {idBand && (
          <div className="gs-idbar" role="status">
            <div className="gs-idbar-t">
              <span className={"gs-idsrc" + (idBand.src === "party" ? "" : " gs-idsrc-local")}>
                {idBand.title}
              </span>
              {idBand.when && <h4 className="gs-idname">{idBand.when}</h4>}
              <span className="gs-idmsg">{idBand.msg}</span>
              <span className="gs-idbar-r">
                <span className="gs-idtot">{man(idBand.gold || 0)}</span>
                {idBand.act2 && (
                  <button className="gs-btn gs-btn-sm gs-btn-ghost" onClick={idBand.act2.on}>
                    {idBand.act2.label}
                  </button>
                )}
                <button
                  className={"gs-btn gs-btn-sm" + (idBand.act.ghost ? " gs-btn-ghost" : "")}
                  onClick={idBand.act.on}
                >
                  {idBand.act.label}
                </button>
              </span>
            </div>
            {/* 파티원은 줄이지 않습니다 — 날짜는 잘 잊어도 누구랑 했는지는 기억합니다 */}
            {idBand.mems.length > 0 && (
              <div className="gs-idmems">
                {idBand.mems.map((n, i) => (
                  <span
                    key={n + "@" + i}
                    className={
                      "gs-idmem" +
                      (idBand.host && n === idBand.host
                        ? " gs-idmem-host"
                        : idBand.me && n === idBand.me
                        ? " gs-idmem-me"
                        : "")
                    }
                  >
                    {n}
                  </span>
                ))}
              </div>
            )}
          </div>
        )}
        {/* 빵부스러기 (§3.0, 2026-09-05) — 판에서 로비로 가는 문이 브랜드 글자뿐이라 안 보였다.
            기록 보는 중엔 띠의 버튼이 문이라 안 세운다. 오른쪽은 파티원의 나가기(옛 파티 서랍에서 이사) */}
        {!genView && (
          <div className="gs-crumbrow">
            <button className="gs-crumb" onClick={goLobby}>
              <span aria-hidden="true">‹</span> 로비
            </button>
            {/* (폐기 2026-09-07) 빵부스러기 줄의 [파티 나가기] — 파티 허브(헤더 칩)가 나가기의 집 (사용자 확정: 탈퇴는 허브에) */}
          </div>
        )}
        <div className="gs-mastrow">
          {/* 탭 줄 왼쪽에는 [전부 비우기] 하나만 남습니다 (§3.4) — 판을 닫는 동사는
              우상단 모서리로 갔고, [처음부터]는 폐지했습니다(문이 둘이면 하나는 못 찾습니다).
              [파티 모드 시작하기]는 머리줄 파티 칩이 됐습니다(문과 상태가 한 자리). */}
          <div className="gs-mastleft">
            {/* 판 이름 — 글자 + 연필, 누르면 입력칸 (§3.1). 옛 로비 히어로에서 이사했습니다.
                [시작] 때 그 판의 이름이 되어 결과지·판 기록에 남습니다 */}
            {!readOnly &&
              (nameEdit ? (
                <input
                  className="gs-lbhero-name"
                  value={roundName}
                  placeholder={defaultRoundName()}
                  maxLength={24}
                  autoFocus
                  onFocus={(e) => e.target.select()}
                  onChange={(e) => setRoundName(e.target.value)}
                  onBlur={(e) => {
                    if (!e.target.value.trim()) setRoundName(defaultRoundName());
                    setNameEdit(false);
                  }}
                  onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
                  aria-label="판 이름"
                />
              ) : (
                <button
                  className={
                    "gs-lbhero-nameview" +
                    (ready && (!roundName || roundName === defaultRoundName()) ? " gs-lbhero-ph" : "")
                  }
                  onClick={() => setNameEdit(true)}
                >
                  <b>{roundName || defaultRoundName()}</b>
                  <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><g fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"><path d="m11.3 2.7 2 2L5 13l-2.6.6L3 11l8.3-8.3Z" /><path d="m9.8 4.2 2 2" /></g></svg>
                </button>
              ))}
            {/* 상태 칩 (§3.0, 2026-09-05) — 들어온 판이 시작 전인지 진행 중인지 이름 옆에서 말한다.
                로비 카드의 제목과 같은 말이라 들어오기 전과 후가 이어진다. 파티원도 같은 칩 */}
            {!readOnly && (
              <span
                className={
                  "gs-stchip" +
                  (ready ? (hostInvite ? " gs-stchip-rec" : " gs-stchip-ready") : " gs-stchip-live")
                }
              >
                {ready ? "시작 전" : "진행 중"}
              </span>
            )}
            {readOnly && !genView && (guestLobby || guestPlaying) && (
              <span className={"gs-stchip" + (guestLobby ? " gs-stchip-ready" : " gs-stchip-live")}>
                {guestLobby ? "시작 전" : "진행 중"}
              </span>
            )}
            {/* (2026-09-06) [전부 비우기]는 표 바로 위로 옮겼습니다 — 표와 가까울수록 */}
          </div>
          <div className="gs-mastside">
            {tabbed && !ready && !guestLobby && (
              <nav className="gs-tabs" aria-label="화면 선택">
                {[
                  /* 자수는 파티원의 기본 화면이라 맨 왼쪽입니다 — 다른 탭은 읽으러 가는 곳입니다 */
                  ...(confessTab
                    ? [
                        {
                          k: "confess",
                          label: "자수",
                          tip: "내 벌금을 직접 세는 화면이에요. 카드를 누르면 1회 쌓이고, 우클릭하면 1회 빠져요.",
                        },
                      ]
                    : []),
                  { k: "sheet", label: "벌금표", tip: "벌금을 입력하는 화면이에요. 정산 장부와 보낼 우편은 이 표를 기준으로 계산돼요." },
                  { k: "ledger", label: "정산 장부", tip: "각자 낸 벌금과 받을 몫, 실제 송금 금액을 보여줘요." },
                  { k: "mail", label: "보낼 우편", tip: "누가 누구에게 얼마를 보낼지, 우편 수수료까지 계산해요." },
                ].map((t) => (
                  <span className="gs-tip" key={t.k}>
                    <button
                      className={"gs-tab gs-tab-" + t.k + (tab === t.k ? " on" : "")}
                      onClick={() => pickTab(t.k)}
                      aria-current={tab === t.k ? "true" : undefined}
                    >
                      {t.label}
                      {t.k === "ledger" && r && <em>{r.fines.length}명</em>}
                      {/* 인게임에선 송금 1건 = 우편 1통 — 봉투(보내는 사람) 수가 아니라 송금 횟수 */}
                      {t.k === "mail" && r && r.transfers.length > 0 && (
                        <em>{r.transfers.length}통</em>
                      )}
                    </button>
                    <span
                      className={"gs-tip-body" + (t.k === "mail" ? " gs-tip-r" : "")}
                      role="tooltip"
                    >
                      {t.tip}
                    </span>
                  </span>
                ))}
              </nav>
            )}
            {/* 수명 동사는 상태가 바뀌어도 같은 자리입니다 (§3.4) — 로비에서 [시작]이 앉는
                우상단 모서리를 판에서는 [정산 끝내기]가 씁니다. 탭을 왼쪽 끝으로 보내지
                않고 탭 오른쪽에 이어 붙이되, 탭은 아래 카드로 이어지는 서류철이라 선에
                닿고 이건 버튼이라 선에서 떠 있습니다 — 머리를 탭과 맞추고 발치를 띄웁니다.
                파티원 화면에는 뜨지 않습니다.
                [중단]은 폐지했습니다: 브라우저를 닫아도 판은 살아 있고, 얼리는 일은
                무활동 24시간 자동 중단이 맡습니다 */}
            {!readOnly && (
              <div className="gs-mastverbs">
                {/* 판 기록 문 — 같은 목록을 로비도 연다 (§3.0·§5.4). 기록이 없으면 문도 없습니다 */}
                {gensList().length > 0 && (
                  <span className="gs-tip">
                    <button className="gs-lbgensbtn" onClick={() => setGensOpen(true)} aria-label="판 기록">
                      <IconHistory />
                      <b>{gensList().length}</b>
                    </button>
                    <span className="gs-tip-body gs-tip-l" role="tooltip">
                      판 기록
                    </span>
                  </span>
                )}
                {/* 준비 상태의 유일한 채운 버튼 — 판에 불을 켭니다 (§3.4). 빈 칸은 (모험가N)으로
                    판에 들어가니 이름이 없어도 시작할 수 있습니다 */}
                {ready ? (
                  <>
                    {/* [해산] (2026-09-06 모델) — 시작 전 판을 없애는 문. 남이 앉아 있으면 한 번 묻습니다 */}
                    <button className="gs-btn gs-btn-ghost gs-lifebtn gs-endbtn" onClick={() => askDisband()}>
                      해산
                    </button>
                    {/* [시작]은 3초 주기로 느리게 빛납니다 (2026-09-06) — 시작 전의 유일한 움직임 */}
                    <button className="gs-btn gs-lifebtn gs-lbstart gs-glow" onClick={() => startRound(cols)}>
                      시작하기
                    </button>
                  </>
                ) : (
                  <span className="gs-tip">
                    <button className="gs-btn gs-btn-ghost gs-lifebtn gs-endbtn" onClick={askEndRound}>
                      정산 끝내기
                    </button>
                    <span className="gs-tip-body gs-tip-r" role="tooltip">
                      결과지를 <b>판 기록</b>에 남기고 판을 닫아요.
                    </span>
                  </span>
                )}
              </div>
            )}
          </div>
        </div>
      </header>
      )}

      {/* ── 자수 — 파티원의 기본 화면. 항목마다 큰 카드 하나이고,
             누르면 +1회 · 우클릭하면 −1회입니다. 서버가 방장 앱에 넘겨 장부에 적히고,
             그 결과가 푸시로 돌아와야 숫자가 바뀝니다(낙관 갱신 없음) ── */}
      {showConfess && confessTab && !blockedCard && (
        <section className="gs-mail gs-confsec">
          <div className="gs-cardhead">
            <div className="gs-headleft">
              <h2 className="gs-h2">자수</h2>
            </div>
          </div>
          <div className="gs-card gs-confbox">
            {/* (폐기 2026-09-06) 얼림 띠 — 중단이라는 상태가 모델에 없다. 방장 부재는 앞 절만 (2026-09-06) */}
            {!scribeOn && (
              <div className="gs-slip" role="status">
                <span className="gs-slip-msg">
                  <b>방장이 자리를 비웠어요.</b>
                </span>
              </div>
            )}
            <div className="gs-conf-who">
              <b>{myRow ? seatName(myRow, rows.indexOf(myRow)) : you.nick || "나"}</b>
              <span className="gs-conf-tag">나</span>
              <span className="gs-conf-sum">
                내 벌금 <b>{man(myGold)}</b>
              </span>
            </div>
            {/* 자수 안내는 벌금표와 같은 문장·같은 마우스 아이콘 (2026-09-06 사용자 지적).
                (폐기 2026-09-06) `내 줄만 누를 수 있어요 — 칸 클릭 +1회 · 우클릭 −1회. 나머지는 읽기 전용이에요.` */}
            <p className="gs-cellnote gs-conf-howto">
              {/* 둘째 줄의 '되돌리기'와 같은 말 (2026-09-06 사용자). (폐기 당일) `우클릭하면 1회 빠져요.` — 벌금표 쪽 문장은 그대로 */}
              칸을 <MouseIcon side="left" /> 누르면 1회 쌓이고, <MouseIcon side="right" />{" "}
              우클릭하면 되돌려요.
            </p>
            {/* 둘째 줄은 첫 줄이 못 하는 말만 (2026-09-06 사용자: 우클릭이 두 번 나와 겹친다) — 30초는 서버의 되돌리기 창(§3.6)과 같은 숫자.
                (폐기 2026-09-06 당일, 사용자 지정 원문) `여기서 누르면 방장의 벌금판에 반영돼요. 30초 이내에 우클릭하면 취소할 수 있어요.` */}
            <p className="gs-conf-note">누른 건 방장 벌금판에 바로 올라가요. 되돌리기는 30초 안에만 돼요.</p>
            {showPick ? (
              seatClaimBlock()
            ) : needPick || (!!you && you.st === "ok" && !you.rowId && !myRow && roundLive) ? (
              <div className="gs-empty">
                <p>자리를 기다리는 중이에요</p>
                {/* (폐기 2026-09-06) `방장이 줄을 정해 줘요.` — 방장은 줄을 고르지 않고 [받기]만 누릅니다 */}
                <p className="gs-empty-sub">방장이 받아 주면 앉아요.</p>
              </div>
            ) : !myRow || cols.length === 0 ? (
              <div className="gs-empty">
                <p>아직 내 줄이 없어요.</p>
                <p className="gs-empty-sub">방장이 줄을 만들면 여기에 항목이 나와요.</p>
              </div>
            ) : (
              <div className="gs-confgrid">
                {cols.map((c) => {
                  const roul = isRoulette(c);
                  const lock = roul || !scribeOn || !!paused;
                  const n = num(myRow.counts[c.id]);
                  const nm = (c.name || "").trim() || "항목";
                  const priceG = Math.round(goldOf(c.price));
                  /* 칸에 굳힌 금액(sums) — 단가를 '이제부터만' 바꾼 뒤에도 방장 표와 같은 숫자입니다.
                     (버그 기록 2026-09-06) 횟수 × 지금 단가로 계산해 3만×3 + 5만×2 = 19만이 25만으로 보였다 */
                  const gold = cellGold(myRow, c.id, priceG);
                  return (
                    <button
                      key={c.id}
                      className={"gs-confcard gs-confcard-" + c.id + (lock ? " gs-confcard-off" : "")}
                      disabled={lock}
                      onClick={() => !lock && sendConfess(myRow.id, c.id, 1)}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        /* 0회에서 더 뺄 것은 없습니다 — 서버까지 갔다가 버려지는 요청입니다 */
                        if (!lock && n > 0) sendConfess(myRow.id, c.id, -1);
                      }}
                      aria-label={nm + " 1회 추가 (우클릭: 1회 빼기)"}
                    >
                      {/* 카드 B (2026-09-06 사용자 확정) — 이름 옆에 단가를 또렷하게, 회수가 주인공, 금액은 그 결과.
                          룩은 벌금표 칸의 결(가는 테두리, 둥근 금테 없음).
                          (폐기 2026-09-05 안) 금액 46px 이 주인공 · 회수와 단가는 11.5px 한 줄 — 사용자: 단가를 보이게 해 달란 것이지
                          회수를 줄이라는 뜻이 아니었고, 단가도 너무 작았다 */}
                      <span className="gs-confhead">
                        <span className="gs-confname">{roul ? "◎ " + nm : nm}</span>
                        <span className="gs-confunit">
                          <small>{roul ? "나온 숫자 ×" : "1회"}</small>
                          <u>{man(priceG)}</u>
                          <small>G</small>
                        </span>
                      </span>
                      {roul ? (
                        <>
                          <span className={"gs-confgold2" + (gold > 0 ? "" : " zero")}>{man(gold)}</span>
                          <span className="gs-conflock">룰렛은 방장이 돌려요</span>
                        </>
                      ) : (
                        <>
                          <span className={"gs-confn" + (n > 0 ? "" : " zero")}>
                            {commafy(n)}
                            <em>회</em>
                          </span>
                          <span className={"gs-confgold2" + (gold > 0 ? "" : " zero")}>{man(gold)}</span>
                          {/* 되돌리기 칩 (2026-09-07 사용자: 30초 타이머가 안 보이고, 연타를 정정할 수 있다는 걸 알려야 한다) —
                              되돌릴 수 있는 개수와 남은 초, 아래 막대. 새로 누르면 30초가 다시 찹니다(서버 규칙과 동일). 문구 초안 */}
                          {(() => {
                            const left = cfLeft(c.id);
                            if (!left) return null;
                            const cf = cfRef.current[c.id];
                            return (
                              <span className="gs-confundo" role="status">
                                <span aria-hidden="true">↶</span>
                                <b>+{cf.n}</b> 되돌리기 · {Math.ceil(left / 1000)}초
                                <i className="gs-confundo-bar" style={{ width: (left / CONFESS_UNDO_MS) * 100 + "%" }} aria-hidden="true" />
                              </span>
                            );
                          })()}
                        </>
                      )}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </section>
      )}

      {/* ── 모집 카드 — 준비 상태의 표 위 (§3.1, 2026-09-05). 옛 로비의 모으기 열이 가로로
             누운 것입니다: 초대 링크 · 함께한 사람(지목 초대) · 신청. [시작]하면 사라지고
             파티 서랍(방 칩)이 이어받습니다. 비로그인은 모을 수 없어 카드가 없습니다 ── */}
      {ready && auth && !showLobby && (
        <section className="gs-mail gs-recruitsec">
          <div className="gs-card gs-recruit">
            {/* 머리가 "초대를 냈는지"를 말합니다 (2026-09-05 목업 확정): 모집 중 · 남은 시간 · 앉은 수.
                (폐기, 당일) 제목 `파티원 모으기` + 이름 적힌 칸까지 센 수 — 초대가 나갔는지 안 읽혔다 */}
            <h4 className="gs-lbcard-h gs-recruit-head">
              {/* 남은 시간은 없습니다 (2026-09-06) — 코드는 방장이 앱을 열어 둔 동안 삽니다. `앉음` 라벨은 뺐습니다 (2026-09-07 사용자) */}
              <span className="gs-recruit-live">
                <i className="gs-livechip-dot" aria-hidden="true" /> 모집 중
              </span>
              <span className="gs-lbroster-n">
                {seatSum.on}/{lobbyCap}
              </span>
            </h4>
            {/* 대기실에 있는 사람은 이름으로 (2026-09-07 사용자: 1/8 이 아니라 사람을 보여 달라) */}
            <p className="gs-recruit-who">{seatNamesNow.length ? seatNamesNow.join(" · ") : "아직 아무도 없어요"}</p>
            {/* 읽는 순서: 머리 → 사람 → 초대 한 덩이. (폐기 2026-09-07) 카드 발치의 게스트 안내 — 로비 계정 카드로 */}
            <div className="gs-lbsec gs-recruit-code">{inviteLine()}</div>
          </div>
        </section>
      )}
      {/* 비로그인 방장의 시작 전 판 (2026-09-05 ③) — 모집 카드 대신 한 줄: 주소가 있어야 부르고 띄웁니다 */}
      {ready && !auth && !showLobby && (
        <section className="gs-mail gs-recruitsec">
          <div className="gs-card gs-recruit gs-recruit-live">
            <span className="gs-recruit-livehead">
              파티원을 부르거나 방송에 띄우려면 방송용 주소가 필요해요.
            </span>
            <span className="gs-recruit-liveacts">
              <button className="gs-btn gs-btn-sm" onClick={() => setObsOpen(true)}>
                주소 받기
              </button>
            </span>
          </div>
        </section>
      )}
      {/* (폐기 2026-09-06) 판 중의 파티 줄 `파티원 n · 모집 중 · m분 남음 [들어오려는 사람 k] [초대 링크]` — 진행 중엔
          "모집 중"이 상태가 아니고, 들어오려는 사람은 사건이라 표 아래 줄이 맡으며, 코드는 공유 창에 삽니다.
          진행 중 화면은 마스트와 표뿐입니다 */}
      {gensOpen && (
        <GenModal
          gens={gensList()}
          onOpen={(name) => {
            setGensOpen(false);
            openGen(name);
          }}
          onDrop={askDropGen}
          onClose={() => setGensOpen(false)}
        />
      )}
      {/* ── 벌금표 ───────────────────────────────────── */}
      {/* (폐기 2026-09-05) 파티원의 대기실 카드 — 파티원도 방장과 같은 판을 봅니다 (§5.3):
          준비 상태의 표(명단·항목, 잠긴 칸)가 곧 대기실이고, 시작하면 자기 줄 칸에 불이 들어옵니다.
          대기실 인원은 표 윗줄이 말합니다 */}
      {/* 무효·만료 초대 — 안내 화면 단독입니다 (§8). 빈 벌금표를 뒤에 깔지 않습니다 */}
      {blockedCard && (
        <section className="gs-mail">
          <div className="gs-card">
            <div className="gs-empty gs-blocked">
              {/* 막힌 까닭 한 줄 + 나가는 문 (2026-09-05) — (폐기) 빈 벌금표 위의 배너 "이 방을 볼 권한이 없어요 — 방장에게 초대를 받아 주세요." — 볼 것도 할 것도 없는 화면에 사람을 세워 뒀다 */}
              <p>
                {kickedOut && !denied
                  ? "파티에서 내보내졌어요."
                  : denied === "noparty"
                  ? "지금은 열린 판이 없어요."
                  : denied === "expired"
                  ? "초대가 만료됐어요 — 방장에게 새 초대를 받아 주세요."
                  : denied === "gone"
                  ? "이 주소의 파티는 이제 없어요 — 방장에게 새 초대를 받아 주세요."
                  : denied === "member"
                  ? "이 파티에 들어갈 초대가 없어요 — 방장에게 초대 링크를 받아 주세요."
                  : "이 초대는 쓸 수 없어요 — 방장에게 새 초대를 받아 주세요."}
              </p>
              {kickedOut && !denied && <p className="gs-empty-sub">방장이 다시 받으면 들어갈 수 있어요.</p>}
              <div className="gs-join-acts gs-blocked-acts">
                <button className="gs-btn gs-btn-sm gs-btn-ghost" onClick={goLobby}>
                  로비로
                </button>
                {meCur && meCur !== liveRoom && (
                  <button className="gs-btn gs-btn-sm gs-btn-ghost" onClick={() => enterRoom(meCur, { push: true })}>
                    내 파티로 돌아가기
                  </button>
                )}
                {kickedOut && !denied && joinCode && auth && (
                  <button
                    className="gs-btn gs-btn-sm"
                    onClick={() => {
                      /* 다시 들어가기 = 방장 승인 대기 (§3.3) — 서버가 내보낸 기록을 보고 req 로 세웁니다.
                         (버그 기록 2026-09-06) joinOk 가 이미 참이라 입장 효과가 다시 돌지 않았다 — 틱을 올려 깨웁니다 */
                      setKickedOut(false);
                      joinTried.current = "";
                      setJoinOk(true);
                      setRejoinTick((n) => n + 1);
                    }}
                  >
                    다시 들어가기
                  </button>
                )}
              </div>
            </div>
          </div>
        </section>
      )}
      {/* 준비 상태의 자리 고르기 (§3.2, 2026-09-05) — 자수 탭이 아직 없어서 표 위에 카드로 섭니다 */}
      {guestLobby && showPick && (
        <section className="gs-mail">
          <div className="gs-card gs-seatclaimcard">{seatClaimBlock()}</div>
        </section>
      )}
      {showSheet && !showLobby && !inviteGate && !blockedCard && (
      <section className="gs-mail gs-sheetsec">
        <div className="gs-cardhead">
          <div className="gs-headleft">
            <h2 className="gs-h2">벌금표</h2>
            {simple && <span className="gs-headnote">메모장이 오른쪽 표에 연동돼요</span>}
            {/* 파티원도 봅니다 (2026-09-06) — 기록은 이미 판과 함께 넘어오고, 단가 변경(`단가 3만 → 5만`)도 한 줄로 남아 있어
                단가 × 횟수와 금액이 다를 때 왜 그런지 여기서 읽힙니다. 취소는 방장만 */}
            {!simple && (
              <span className="gs-tip">
                <button
                  key={toast ? toast.t : 0}
                  className={
                    "gs-btn gs-btn-ghost gs-logbtn" +
                    (showLog ? " gs-logbtn-on" : "") +
                    (toast && toast.log ? " gs-logbtn-blink" : "")
                  }
                  onClick={() => openLog(null)}
                  aria-haspopup="dialog"
                >
                  기록
                  {log.length > 0 && <em>{log.length}</em>}
                </button>
                <span className="gs-tip-body" role="tooltip">
                  모든 입력과 수정이 <b>시각과 함께</b> 기록돼요. 어느 줄이든 취소할 수 있어요.
                </span>
              </span>
            )}
          </div>

          {/* 버튼은 성격끼리 묶고, 글자 수는 버튼 안으로 넣어 줄을 흐트러뜨리지 않습니다 */}
          <div className="gs-tools">
            {/* 준비 상태의 도구 — 인원 수(= 칸 수, §3.1)와 프리셋. 옛 로비의 명단 발치·항목 카드
                머리에서 이사했습니다. 사람·이름이 앉은 칸 아래로는 줄지 않습니다(putCap) */}
            {ready && (
              <div className="gs-modebar gs-readytools">
                <span className="gs-caplab">인원</span>
                <div className="gs-seg" role="group" aria-label="인원 수">
                  <button className={lobbyCap === 4 ? "on" : ""} onClick={() => putCap(4)}>
                    4인
                  </button>
                  <button className={lobbyCap === 8 ? "on" : ""} onClick={() => putCap(8)}>
                    8인
                  </button>
                </div>
                <label className="gs-lbcapin">
                  <input
                    type="number"
                    min={1}
                    max={16}
                    value={capDraft === null ? String(lobbyCap) : capDraft}
                    onChange={(e) => setCapDraft(e.target.value)}
                    onBlur={commitCap}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        commitCap();
                      }
                    }}
                    aria-label="인원 수"
                  />
                  인
                </label>
                <button className="gs-btn gs-btn-ghost gs-presetbtn" onClick={() => setPresetOpen(true)}>
                  프리셋
                </button>
                {/* 지난 판 이어서 (2026-09-06) — [시작] 때 그 판의 줄이 열립니다. 대기실은 사람만 앉는 자리라 여기서는 고르기만 */}
                {gensList().some((g) => g.gen && (!g.host || g.host === g.me)) && !relay.resumeFrom && (
                  <button className="gs-btn gs-btn-ghost gs-presetbtn" onClick={() => setResumePick(true)}>
                    지난 판 이어서…
                  </button>
                )}
                {relay.resumeFrom && (
                  <span className="gs-resumechip">
                    '{(gensList().find((g) => g.name === relay.resumeFrom) || {}).rname || relay.resumeFrom}' 이어서
                    <button
                      className="gs-x gs-resumechip-x"
                      onClick={() => putRelay({ ...relayRef.current, resumeFrom: "" })}
                      aria-label="이어서 취소"
                    >
                      ×
                    </button>
                  </span>
                )}
                {/* (폐기 2026-09-06) 자리 요약 `앉음 n · 직접 적음 n · 빈 자리 n` — 띠와 카드 머리가 이미 말한다 */}
              </div>
            )}
            {/* 모드는 벌금을 '어떻게 적는지'라서 벌금표에 삽니다 */}
            {!readOnly && (
            <div className="gs-modebar">
              <span className="gs-caplab">모드</span>
              {/* 설명은 옆의 ? 하나가 맡습니다 — 버튼마다 툴팁이 뜨면 누를 때마다 성가십니다 */}
              <div className="gs-seg" role="group" aria-label="모드">
                <button className={simple ? "on" : ""} onClick={() => changeMode("simple")}>
                  <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                    <g fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
                      <path d="M3 4.2h7M3 8h7M3 11.8h4.5" />
                    </g>
                  </svg>
                  메모장
                </button>
                <button className={simple ? "" : "on"} onClick={() => changeMode("items")}>
                  <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                    <g fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
                      <rect x="2.2" y="2.2" width="11.6" height="11.6" rx="1.6" />
                      <path d="M8 5.2v5.6M5.2 8h5.6" />
                    </g>
                  </svg>
                  카운터
                </button>
              </div>
              {/* 올리면 설명, 더 보고 싶을 때만 선택 화면으로 — 눌러서 화면이 튀지 않게 */}
              <span className="gs-tip gs-tip-act">
                <span className="gs-guide" role="button" tabIndex={0} aria-label="모드 설명">
                  ?
                </span>
                <span className="gs-tip-body gs-tip-r gs-tip-modes" role="tooltip">
                  <span className="gs-tip-sec">
                    <b>메모장 모드</b>
                    이름과 금액을 한 줄씩 입력하면 자동으로 표로 정리돼요. 쓰던 메모를
                    그대로 붙여넣어도 돼요.
                  </span>
                  <span className="gs-tip-sec">
                    <b>카운터 모드</b>
                    잡힘·죽음 같은 항목별로 ＋를 눌러 횟수를 세요. 단가는 항목마다 한 번만
                    설정하면 돼요.
                  </span>
                  <button
                    className="gs-tip-more"
                    onClick={() => {
                      // 포커스가 남으면 돌아왔을 때 툴팁이 열린 채입니다 (? 자체가 포커스일 수도)
                      document.activeElement?.blur?.();
                      setIntro("guide");
                    }}
                  >
                    자세히 보기 →
                  </button>
                </span>
              </span>
            </div>
            )}

          </div>
        </div>

        {/* 내용 상자 — 정산 장부·보낼 우편과 같은 뼈대입니다.
            머리줄(제목·모드)은 상자 밖에 두어 세 탭의 윗부분이 한 줄로 맞습니다 */}
        <div className="gs-card gs-sheetbox" ref={sheetBoxRef}>

        {/* 읽기 전용·복귀 안내는 카드 맨 위 한 줄로 — 표 아래에 두면 표가 길 때 화면 밖으로 밀립니다.
            방장이 메모장으로 바꾸면 자수 탭이 없어지므로(보통 항목이 없습니다) 뒷말도 같이
            내려놓고, 읽기 전용 표시만 남깁니다 (§3.4) */}
        {guestPlaying && (
          <div className="gs-slip gs-slip-back" role="status">
            {confessTab && <i className="gs-ring" aria-hidden="true" />}
            <span className="gs-slip-msg">
              {confessTab ? (
                <>
                  <b>읽기 전용</b>이에요 — 내 벌금은 <b>자수</b> 탭에서 세요. <b>{backIn == null ? 30 : backIn}초</b> 뒤
                  자수 화면으로 돌아가요 — 누르면 다시 30초.
                </>
              ) : (
                <>
                  <b>읽기 전용</b>이에요
                </>
              )}
            </span>
          </div>
        )}

        {privWarn && (
          <div className="gs-slip" role="status">
            <span className="gs-slip-msg">
              이 창은 기록을 못 지켜요 — 시크릿 창이거나 저장 공간이 부족해요.
              <b> 창을 닫으면 장부가 사라져요.</b>
            </span>
            <button
              className="gs-x gs-slip-x"
              onClick={() => setPrivWarn(false)}
              aria-label="알림 닫기"
            >
              ×
            </button>
          </div>
        )}

        {/* 사고 직후의 안내 쪽지 — 버튼 줄을 밀지 않도록 헤더 아래 한 줄로 붙습니다.
            표를 고치기 시작하면 조용히 사라집니다. */}
        {undoSnap && (
          <div className="gs-slip" role="status">
            <span className="gs-slip-msg">{undoSnap.msg || `${undoSnap.label} 했어요`}</span>
            <button className="gs-btn gs-btn-sm gs-undo" onClick={restoreSnap}>
              ↩ 되돌리기
            </button>
            {/* 되돌릴 생각이 없으면 바로 닫습니다 — 표를 고칠 때까지 기다릴 필요 없이 */}
            <button
              className="gs-x gs-slip-x"
              onClick={() => setUndoSnap(null)}
              aria-label="알림 닫기"
            >
              ×
            </button>
          </div>
        )}
        {/* 입력 단위는 두 모드가 같은 설정을 씁니다 — 메모장은 줄의 숫자, 카운터는 합계 수정 */}
        <div className="gs-unitbar">
          <span className="gs-caplab">입력 단위</span>
          {UNITS.map((u) => (
            <label key={u.v} className={unit === u.v ? "on" : ""}>
              <input
                type="radio"
                name="gs-unit"
                checked={unit === u.v}
                onChange={() => !readOnly && setUnit(u.v)}
              />
              {u.label}
            </label>
          ))}
          {/* 설명 문장은 뺐습니다 — 친 숫자 → 그 금액 칩이 이미 같은 말을 합니다 */}
          <span className="gs-unitnote">
            {(UNIT_EX[unit] || []).map(([typed, gold]) => (
              <b className="gs-unitex" key={typed}>
                <i>{typed}</i>
                <em aria-hidden="true">→</em>
                <span>{gold}</span>
              </b>
            ))}
          </span>
        </div>
        {/* 누르는 것(복사)은 왼쪽, 읽는 것(조작법)은 오른쪽 — 손이 가는 쪽에 버튼을 둡니다 */}
        {!simple && (
          <div className="gs-tablebar">
            {/* [전부 비우기] — 표 바로 위 (2026-09-06 사용자 지정). 숫자만 비웁니다. 판을 닫는 [정산 끝내기]와 층이 다릅니다 */}
            {/* [전부 비우기]와 [채팅 공유용 복사]는 왼쪽에 나란히, 마우스 안내는 오른쪽 (2026-09-06 사용자 지정 — 복사 버튼이 한가운데 떠 있던 것만 고침) */}
            <span className="gs-tablebar-l">
              {!readOnly && roundLive && (
                <span className="gs-tip">
                  <button className="gs-btn gs-btn-sm gs-btn-ghost gs-wipebtn" onClick={askWipeCounts}>
                    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                      <g fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M9.6 2.4l4 4-6.4 6.4H4.6L2.4 10.6l7.2-8.2z" />
                        <path d="M6.6 6.2l3.4 3.4" />
                        <path d="M7 13.6h7" />
                      </g>
                    </svg>
                    전부 비우기
                  </button>
                  <span className="gs-tip-body gs-tip-l" role="tooltip">
                    이름과 항목은 그대로 두고 <b>숫자만</b> 비워요. 장부 기록에 <b>비움</b>으로 남아요.
                  </span>
                </span>
              )}
              {!(ready || guestLobby) && <ChatCopyBtn line={chatLine} flash={flash} onCopy={copyChat} />}
            </span>
            {ready || guestLobby ? (
              /* 준비 상태 — 복사할 숫자가 없습니다. 방장의 안내는 자리 띠가 대신하고(2026-09-05), 파티원은 대기실 수 (§5.3) */
              ready && auth && !guestLobby ? null : (
              <p className="gs-cellnote">
                {guestLobby ? (
                  <>
                    {/* (폐기 2026-09-06) `대기실 n/m 모임` — 자리 띠가 이미 말한다. 접속 표시만 */}
                    <em className="gs-live-dot" key={liveTick} aria-hidden="true" /> 실시간
                  </>
                ) : (
                  /* (폐기 2026-09-05) 로그인 방장의 `초대 링크를 보내면 파티원이 빈 칸에 앉아요. …` — 자리 띠로 */
                  /* (폐기 2026-09-06) `이름을 적고 [시작]을 누르면 세기 시작해요.` — 시작 전 이름 칸은 잠겨 있어 앞절이 거짓 */
                  "[시작]을 누르면 세기 시작해요."
                )}
              </p>
              )
            ) : (
              <p className="gs-cellnote">
                칸을 <MouseIcon side="left" /> 누르면 1회 쌓이고, <MouseIcon side="right" />{" "}
                우클릭하면 1회 빠져요.
              </p>
            )}
          </div>
        )}

        {/* 사용법은 카드 안에서 펼치지 않고 팝업으로 띄웁니다 — 탭 화면에서 표가 밀리지 않게 */}

        <div className={simple ? "gs-split" : undefined}>
          {simple && (
            <div className="gs-memo">
              <div className="gs-memo-head">
                <span className="gs-memo-left">
                  <span className="gs-caplab">메모장</span>
                  <ChatCopyBtn line={chatLine} flash={flash} onCopy={copyChat} />
                </span>
                <span className="gs-fontctl" role="group" aria-label="메모장 글자 크기">
                  <button
                    onClick={() => setMemoFont((f) => clampMemoFont(f - 1))}
                    aria-label="글자 줄이기"
                  >
                    −
                  </button>
                  <b>{memoFont}</b>
                  <button
                    onClick={() => setMemoFont((f) => clampMemoFont(f + 1))}
                    aria-label="글자 키우기"
                  >
                    +
                  </button>
                </span>
              </div>
              <textarea
                className="gs-ta gs-memo-ta"
                style={{ fontSize: memoFont }}
                value={memoText}
                onChange={onMemo}
                spellCheck={false}
                placeholder={"쿼카 25\n순두부 30\nㅈ냥이 44"}
                aria-label="이름과 금액을 줄마다 적기"
              />
              <p className="gs-memo-note">한 줄에 한 사람 · 줄 끝 숫자가 금액</p>
            </div>
          )}

        {vplay && readOnly && <ViewSpinPanel pl={vplay} />}
        {spin && (
          <SpinPanel
            spin={spin}
            onStop={stopSpin}
            onSkip={skipSpin}
            onPickSelf={() => {
              const me = rows.find((x) => x.id === spin.rowId);
              if (me) pickPassTarget(me);
            }}
          />
        )}
        <div className="gs-scroll">
          <table
            ref={gridRef}
            className={"gs-grid" + (simple ? " gs-grid-narrow" : " gs-grid-count")}
            /* 이름 열 폭 — 여섯 글자를 기본으로 두고, 그보다 긴 이름이 있으면 거기 맞춥니다.
               한글은 글자 하나가 대략 1em 이라 글자 수를 그대로 폭으로 씁니다. */
            style={{
              "--namech": Math.max(
                6,
                ...rows.map((x, k) => (x.name || ANON(k)).length)
              ),
            }}
            onMouseOver={hoverCell}
            onMouseLeave={() => setCross(null)}
          >
            <thead>
              <tr>
                {simple ? (
                  <th className="gs-stick gs-l">
                    <span className="gs-caplab">이름</span>
                  </th>
                ) : (
                  <th className="gs-stick gs-l gs-corner">
                    <span className="gs-corner-col">항목</span>
                    <span className="gs-corner-row">이름</span>
                  </th>
                )}
                {simple && (
                  <th className="gs-colh gs-simpleh">
                    {/* 단위는 위 라디오에 이미 있으니 라벨 하나면 됩니다 */}
                    <div className="gs-disch-top gs-simple-lab">금액</div>
                  </th>
                )}
                {!simple &&
                  cols.map((c) => (
                  <th
                    key={c.id}
                    className={"gs-colh" + (cross && cross.c === c.id ? " gs-litcol" : "")}
                    data-col={c.id}
                  >
                    <div className="gs-colh-top">
                      <input
                        className="gs-in gs-in-col"
                        style={{ width: `${Math.max(3, (c.name || "항목명").length) + 0.4}em` }}
                        value={c.name}
                        placeholder="항목명"
                        onChange={(e) => patchCol(c.id, "name", e.target.value)}
                        aria-label="항목 이름"
                      />
                      {!readOnly && (
                      <button
                        className="gs-x"
                        onClick={() => askDelCol(c)}
                        aria-label={`${c.name || "항목"} 열 삭제`}
                      >
                        ×
                      </button>
                      )}
                    </div>
                    <div className="gs-colh-price">
                      {isRoulette(c) ? (
                        <button
                          className="gs-rcbtn"
                          onClick={() => !readOnly && setRouletteCfg(c.id)}
                          title="룰렛 항목 — 눌러서 비율을 고쳐요"
                        >
                          ◎ 룰렛 · {liveFaces(c).length}면 · 나온 숫자 ×{" "}
                          {man(Math.round(goldOf(c.price)))} <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><path fill="currentColor" d="M19.5 12c0-.34-.02-.67-.07-1l2.04-1.58a.5.5 0 0 0 .12-.65l-1.93-3.34a.5.5 0 0 0-.61-.22l-2.4.97c-.52-.4-1.09-.73-1.7-.98l-.37-2.56A.5.5 0 0 0 14.09 2h-3.86a.5.5 0 0 0-.5.43l-.36 2.57c-.62.25-1.19.58-1.71.98l-2.4-.97a.5.5 0 0 0-.6.22L2.72 8.57a.5.5 0 0 0 .12.65l2.04 1.58a7.9 7.9 0 0 0 0 2.02l-2.04 1.58a.5.5 0 0 0-.12.65l1.93 3.34c.12.22.38.31.6.22l2.4-.97c.53.4 1.1.73 1.72.98l.36 2.57a.5.5 0 0 0 .5.43h3.86a.5.5 0 0 0 .5-.43l.36-2.57c.62-.25 1.19-.58 1.71-.98l2.4.97c.23.09.49 0 .61-.22l1.93-3.34a.5.5 0 0 0-.12-.65L19.43 13c.05-.33.07-.66.07-1Zm-7.5 3.4a3.4 3.4 0 1 1 0-6.8 3.4 3.4 0 0 1 0 6.8Z"/></svg>
                        </button>
                      ) : (<>
                      <span>1회</span>
                      {rows.reduce((a, x) => a + num(x.counts[c.id]), 0) > 0 ? (
                        /* 센 기록이 있으면 창에서 — 지난 횟수를 어찌할지 골라야 해서 */
                        <span className="gs-pricewrap">
                          <button
                            className="gs-in gs-in-price gs-pricebtn"
                            onClick={() => !readOnly && setPriceAsk(c.id)}
                            aria-label="1회당 단가 고치기"
                          >
                            {formatNumInput(String(+(goldOf(c.price) / (goldOf(unit) || 1)).toFixed(4)))}
                          </button>
                          <span className="gs-price-suffix">
                            {(UNITS.find((u) => u.v === unit) || {}).label || "G"}
                          </span>
                        </span>
                      ) : (
                        /* 아직 안 센 항목은 물어볼 과거가 없으니 그냥 칩니다 */
                        <PriceFree
                          gold={goldOf(c.price)}
                          per={goldOf(unit) || 1}
                          suffix={(UNITS.find((u) => u.v === unit) || {}).label || "G"}
                          onChange={(g) => patchCol(c.id, "price", commafy(g))}
                        />
                      )}
                      </>)}
                    </div>
                  </th>
                ))}
                {!simple && !readOnly && (
                  <th className="gs-addcolh">
                    {/* 도움말을 따로 두지 않고 버튼 자체에 얹습니다 */}
                    <span className="gs-tip">
                      <button
                        className="gs-addcol"
                        onClick={() => {
                          courseHit("addcol:open"); // 튜토리얼 2장
                          setAddColOpen(true);
                        }}
                      >
                        + 항목
                      </button>
                      <span className="gs-tip-body" role="tooltip">
                        <b>항목</b>은 벌금 사유예요. 1회당 단가를 정해 두고, 칸을 눌러 횟수를
                        세요. 우클릭하면 1회 빠져요.
                      </span>
                    </span>
                  </th>
                )}
                {!simple && (
                  <th
                    className={"gs-colh gs-disch" + (cross && cross.c === "etc" ? " gs-litcol" : "")}
                    data-col="etc"
                  >
                    <div className="gs-disch-top">
                      기타
                      <span className="gs-tip">
                        <button className="gs-qm gs-qm-sm" aria-label="기타란">
                          ?
                        </button>
                        <span className="gs-tip-body gs-tip-r" role="tooltip">
                          항목에 없는 즉석 벌금이에요. 횟수 대신 금액을 그대로 입력하면 돼요.
                        </span>
                      </span>
                    </div>
                    <div className="gs-colh-price">금액 직접</div>
                  </th>
                )}
                <th className="gs-sumh">
                  <span className="gs-caplab">합계</span>
                </th>
                {/* 도구 열 — 이름을 붙이지 않습니다. 합계 오른쪽의 세로 선이
                    "여기부터는 숫자가 아니라 손잡이"라고 말해 줍니다 */}
                {!readOnly && <th className="gs-toolh" />}
              </tr>
            </thead>

            <tbody>
              {rows.map((row, i) => {
                const ex = extrasOf(row);
                const exSum = extraSum(row);
                const open = openRow === row.id;
                return (
                  <Fragment key={row.id}>
                    <tr
                      className={
                        (open ? "gs-rowopen" : "") +
                        (spin && spin.phase === "pick" ? " gs-pickable" : "") +
                        (spin && spin.phase === "pick" && spin.rowId === row.id ? " gs-pickself" : "") +
                        (cross && cross.r === row.id ? " gs-litrow" : "") +
                        /* 파티원 화면에서 내 줄 — 이름부터 금색이라 어디를 눌러야 하는지 바로 보입니다 */
                        (you && you.rowId === row.id && readOnly ? " gs-myrow" : "") +
                        /* 방금 앉은 줄 — 3초 금색 (§3.1, 2026-09-05) */
                        (ready && arrived[row.id] ? " gs-row-arrive" : "")
                      }
                      onClick={
                        spin && spin.phase === "pick" ? () => pickPassTarget(row) : undefined
                      }
                      data-row={row.id}
                    >
                      <th className="gs-stick gs-l">
                        <div className="gs-namecell">
                          {/* ≡ 손잡이 (2026-09-06 오후 사용자 요청) — 방장 줄과 파티원 화면엔 없습니다. 튜토리얼에선 설명하지 않습니다 */}
                          {!readOnly && i > 0 && (
                            <span
                              className="gs-drag"
                              title="끌어서 줄 순서 바꾸기"
                              aria-label="줄 순서 바꾸기"
                              onPointerDown={(e) => dragStart(e, row.id)}
                              onPointerMove={dragMove}
                              onPointerUp={dragEnd}
                              onPointerCancel={dragEnd}
                            >
                              ≡
                            </span>
                          )}
                          {/* 이름만 남깁니다 — 손잡이(기록·삭제)는 표 오른쪽 끝
                              도구 열로 나갔습니다. 이름이 옆 칸(횟수)에 바로 붙습니다. */}
                          {/* 비워 두면 어디서든 이 이름으로 불립니다 — 칸에도 같은 글자를 */}
                          {/* 사람이 앉은 줄인지 방장이 적은 이름인지 (§3.1·§3.2) — 표시는 이름 칸의 **왼쪽
                              빈자리**에 둡니다. 이름은 오른쫽 끝에 딱 붙어 있어야 n×m 탐색의 눈길이 이름에서
                              칸으로 바로 건너가는데, 이름 뒤에 칩을 달면 그 정렬이 흔들립니다.
                              방장에겐 가린 아이디(앞 두 글자 + 점 넷, 호버에 닉·아이디), 끊긴 사람은 흐려집니다.
                              파티원 화면엔 아이디가 안 오므로(§4.3) 방장·나 표시만 */}
                          {(() => {
                            if (!readOnly) {
                              const st = seats.find((k) => k.id === row.id);
                              /* 진행 중에 나간 사람의 줄 — 벌금이 붙은 장부 줄이라 남지만, 사람은 없습니다 (§3.4) */
                              if (st && !st.acct && st.left && roundLive)
                                return (
                                  <span className="gs-rowmeta">
                                    <span className="gs-lb-tag gs-lb-tag-left">퇴장</span>
                                  </span>
                                );
                              if (!st || !st.acct) return null;
                              const mem = members.find((k) => k.acct === st.acct);
                              const off = !!mem && mem.on === false;
                              const masked = st.acct.slice(0, 2) + "••••";
                              /* 글자(아이디)는 이름 칸을 너무 먹었습니다 — 표시는 i 하나, 내용은 호버에 (2026-09-05) */
                              /* 브라우저 title 은 늦고 못생겼습니다 — 앱의 툴팁(.gs-tip)으로 즉답 */
                              return (
                                <span className={"gs-tip gs-rowmeta" + (off ? " gs-rowmeta-off" : "")}>
                                  {/* 사람 아이콘 (2026-09-06 사용자 지정) — 이 줄의 사람. 누르면 시트(다른 줄로 옮기기 · 파티에서 내보내기).
                                      방장 줄(1번)은 표시만. (폐기) 파란 원의 i, 도구칸의 사람 버튼 */}
                                  <button
                                    type="button"
                                    className={"gs-rowi gs-rowi-ava" + (i === 0 ? " gs-rowi-host" : "")}
                                    aria-label={i === 0 ? "방장" : "이 줄의 사람"}
                                    aria-haspopup={i > 0 ? "dialog" : undefined}
                                    onClick={i > 0 && auth && relay.room ? () => setRowPerson(row.id) : undefined}
                                    style={{ "--h": avaHue(st.acct) }}
                                  >
                                    {/* 글자 원 (2026-09-07 사용자 확정 ③) — 로비·허브와 한 벌. (폐기) 사람 아이콘 svg */}
                                    {avaChar((mem && mem.nick) || st.nick || (auth && st.acct === auth.id ? auth.nick : ""))}
                                  </button>
                                  <span className="gs-tip-body gs-tip-l gs-rowtip" role="tooltip">
                                    {/* 계정 닉만 — 줄 이름은 방장 장부의 것이라 여기 안 옵니다 (2026-09-06 사용자 지적).
                                        라벨을 달아 두 줄로 (2026-09-07 사용자 지정 문구: `원래 닉네임:` / `ID:`; (폐기) `{닉} {아이디}` 한 줄 — 무엇이 닉이고 아이디인지 안 읽혔다) */}
                                    {/* 방장 줄은 첫 줄에 `방장` (2026-09-07 사용자: 금색은 좋은데 호버하면 방장이라고 떠야 한다) */}
                                    {i === 0 && (
                                      <span className="gs-tipline">
                                        <b>방장</b>
                                      </span>
                                    )}
                                    <span className="gs-tipline">
                                      <i>원래 닉네임:</i> <b>{(mem && mem.nick) || st.nick || (auth && st.acct === auth.id ? auth.nick : "") || ""}</b>
                                    </span>
                                    <span className="gs-tipline">
                                      <i>ID:</i> {masked}
                                    </span>
                                    {off && <span className="gs-tipline">연결 끊김</span>}
                                  </span>
                                </span>
                              );
                            }
                            const host = i === 0 && rows2v.some((k) => k.rowId === row.id && k.a);
                            const mine = !!you && you.rowId === row.id;
                            if (!host && !mine) return null;
                            return (
                              <span className="gs-rowmeta">
                                {host && <span className="gs-lb-tag">방장</span>}
                                {mine && <span className="gs-lb-tag">나</span>}
                              </span>
                            );
                          })()}
                          {/* 시작 전 이름 칸은 글자입니다 (2026-09-06) — 사람이 앉는 자리라 손으로 적지 않습니다. 누르면 한 줄 */}
                          {ready && !readOnly ? (
                            <button
                              type="button"
                              className="gs-in gs-in-name gs-name-ro"
                              onClick={() => say("이름은 [시작] 뒤에 적어요.")}
                            >
                              {(() => {
                                const nm = ((seats.find((k) => k.id === row.id) || {}).name || "").trim();
                                return nm ? nm : <span className="gs-name-ph">{ANON(i)}</span>;
                              })()}
                            </button>
                          ) : (
                          <input
                            className={"gs-in gs-in-name" + (dupName(row.id, row.name) ? " gs-dup" : "")}
                            size={Math.max(3, [...String((ready ? (seats.find((k) => k.id === row.id) || {}).name || "" : row.name) || ANON(i))].length + 1)}
                            /* 준비 상태에서는 자리의 이름이 원본입니다 (§3.1) — 빈 자리는 빈 칸으로
                               보여 자리표시가 뜨고, 고치면 자리에 적힙니다. 줄은 자리를 따라옵니다 */
                            value={ready ? (seats.find((k) => k.id === row.id) || {}).name || "" : row.name}
                            placeholder={ANON(i)}
                            onChange={(e) =>
                              ready
                                ? renameSeat(row.id, e.target.value)
                                : patchRow(row.id, "name", e.target.value)
                            }
                            /* 칸을 벗어날 때 판정 — 겹치면 적기 전 이름으로 되돌립니다 */
                            onFocus={(e) => (e.currentTarget.dataset.was = row.name || "")}
                            onBlur={(e) => {
                              if (!dupName(row.id, row.name)) return;
                              const back = e.currentTarget.dataset.was || "";
                              patchRow(row.id, "name", back);
                              say("'" + (row.name || "").trim() + "'은 이미 있어요. 다른 이름으로 적어 주세요.");
                            }}
                            aria-invalid={dupName(row.id, row.name) || undefined}
                            /* 탭은 아래 이름으로 — 이름은 위에서 아래로 죽 적는 칸이라,
                               기본 탭 순서(옆 칸 → 횟수)를 따라가면 매번 손이 끊깁니다.
                               첫·끝에서는 막지 않아 표 밖으로 빠져나갈 수 있습니다. */
                            onKeyDown={(e) => {
                              if (e.key !== "Tab") return;
                              const all = [...e.currentTarget.closest("table").querySelectorAll(".gs-in-name")];
                              const at = all.indexOf(e.currentTarget);
                              const to = all[at + (e.shiftKey ? -1 : 1)];
                              if (!to) return;
                              e.preventDefault();
                              to.focus();
                              to.select();
                            }}
                            aria-label="이름"
                          />
                          )}
                        </div>
                      </th>
                      {/* 준비 상태의 자리 띠 (§3.1, 2026-09-05 목업 확정) — 잠긴 벌금 칸 셋 자리에 "이 줄에 누가 있나".
                          [시작]을 누르면 이 자리가 그대로 벌금 칸이 됩니다 */}
                      {(ready || guestLobby) && seatStrip(row, i)}
                      {activeCols.map((c) => {
                        if (ready || guestLobby) return null;
                        const cnt = row.counts[c.id] ?? "";
                        const n = num(cnt);
                        if (!simple) {
                          return (
                            <td
                              key={c.id}
                              className={cross && cross.c === c.id ? "gs-litcol" : undefined}
                              data-col={c.id}
                            >
                              {/* 카운터 칸 — 왼클릭 = 1회, 우클릭 = 1회 빼기 (게임 인벤토리 문법).
                                  둘 다 기록에 남고, 실수는 반대 클릭이나 기록에서 바로잡습니다.
                                  보조 버튼을 칸 위에 겹치지 않아 오클릭 여지가 없습니다. */}
                              <div className="gs-hitwrap">
                                {/* 자수로 바뀐 칸 — 방장의 눈은 판에 있으니 판에서 알립니다 */}
                                {confessFx &&
                                  confessFx.rowId === row.id &&
                                  confessFx.colId === c.id && (
                                    <span className="gs-hovtip gs-conftip" role="status">
                                      <b>{confessFx.nick}</b> {confessFx.d < 0 ? "자수 정정" : "자수"}
                                    </span>
                                  )}
                                {/* 누르면 얼마가 붙는지 — 십자 하이라이트는 "어디"만 말하고
                                    금액은 안 말해 줍니다. 단가가 열마다 달라서 실수를 막습니다.
                                    첫 줄은 위가 머리줄이라 아래로 뒤집습니다. */}
                                {cross && cross.r === row.id && cross.c === c.id && (
                                  <span
                                    className="gs-hovtip"
                                    role="status"
                                  >
                                    <b>{seatName(row, i)}</b> · {(c.name || "").trim() || "항목"}{" "}
                                    <b>
                                      {isRoulette(c) ? "룰렛" : "+" + man(Math.round(goldOf(c.price)))}
                                    </b>
                                  </span>
                                )}
                                <button
                                  key={
                                    confessFx &&
                                    confessFx.rowId === row.id &&
                                    confessFx.colId === c.id
                                      ? "fx" + confessFx.t
                                      : "cell"
                                  }
                                  className={
                                    "gs-hit" +
                                    (ready || guestLobby ? " gs-hit-ready" : "") +
                                    (guestLobby && you && you.rowId === row.id ? " gs-hit-mine" : "") +
                                    (n > 0 ? " gs-hit-on" : "") +
                                    /* 자수할 수 있는 칸만 금색으로 — 나머지는 읽기 전용입니다 */
                                    (canConfess(row, c) ? " gs-hit-mine" : "") +
                                    (confessMode && !canConfess(row, c) ? " gs-hit-far" : "") +
                                    (confessFx &&
                                    confessFx.rowId === row.id &&
                                    confessFx.colId === c.id
                                      ? " gs-hit-conf"
                                      : "")
                                  }
                                  onClick={() => pressCell(row, c, 1)}
                                  onContextMenu={(e) => {
                                    e.preventDefault();
                                    pressCell(row, c, -1);
                                  }}
                                  aria-label={`${row.name || "이 사람"}의 ${c.name || "항목"} 1회 추가 (우클릭: 1회 빼기)`}
                                >
                                  {/* 숫자가 주인공 — 누르기 전엔 옅은 ＋만, 누른 뒤엔 가운데 큰 횟수 */}
                                  {n > 0 ? (
                                    <span className="gs-hit-num" key={n}>
                                      {commafy(n)}
                                      <em>회</em>
                                    </span>
                                  ) : (
                                    <span className="gs-hit-ghost" aria-hidden="true">
                                      {isRoulette(c) ? "◎" : "＋"}
                                    </span>
                                  )}
                                </button>
                              </div>
                            </td>
                          );
                        }
                        return (
                          <td key={c.id}>
                            {/* 칸 어디를 눌러도 입력이 잡히게 합니다 (+/− 는 제외) */}
                            <div
                              className="gs-cell"
                              onMouseDown={(e) => {
                                if (e.target.closest("button, input")) return;
                                e.preventDefault();
                                focusCell(i, c.id);
                              }}
                            >
                              <div className="gs-cnt">
                                <button
                                  className="gs-step"
                                  onClick={() => bump(row.id, c.id, -1)}
                                  tabIndex={-1}
                                  aria-label={`${c.name || "항목"} 1 줄이기`}
                                >
                                  −
                                </button>
                                <NumInput
                                  className="gs-in gs-in-cnt"
                                  style={{ width: cntWidth(cnt, 6) }}
                                  value={cnt}
                                  placeholder="0"
                                  data-cell={`${i}:${c.id}`}
                                  onChange={(v) => patchCount(row.id, c.id, v)}
                                  onKeyDown={(e) => cellKey(e, i, c.id)}
                                  onFocus={(e) => e.target.select()}
                                  aria-label={`${row.name || "이 사람"}의 ${c.name || "항목"} 횟수`}
                                />
                                <button
                                  className="gs-step"
                                  onClick={() => bump(row.id, c.id, 1)}
                                  tabIndex={-1}
                                  aria-label={`${c.name || "항목"} 1 늘리기`}
                                >
                                  +
                                </button>
                              </div>
                            </div>
                          </td>
                        );
                      })}
                      {!simple && !readOnly && <td className="gs-addcolcell" />}
                      {!simple && (
                      <td
                        className={
                          "gs-disc" + (cross && cross.c === "etc" ? " gs-litcol" : "") + (ready ? " gs-disc-ready" : "")
                        }
                        data-col="etc"
                        /* 눌러야 열립니다 (2026-09-05 ②) — 호버로 펴지면 지나가다 펴지고 줄 높이를 밀었습니다.
                           편집칸은 칸 위에 떠서 줄 높이를 안 바꾸고, 바깥을 누르면 닫힙니다. 시작 전엔 잠깁니다 */
                        onClick={() => !readOnly && !ready && discRow !== row.id && setDiscRow(row.id)}
                      >
                        {discRow === row.id ? (
                          <QuickExtra
                            unitLabel={unitLabel}
                            value={discDraft[row.id] || ""}
                            onChange={(v) => setDiscDraft((d) => ({ ...d, [row.id]: v }))}
                            summary={
                              ex.length ? `${man(exSum)} · ${ex.length}건` : ""
                            }
                            onAdd={(v) => {
                              addExtra(row.id, commafy(Math.round(v * per)), "");
                              setDiscDraft((d) => ({ ...d, [row.id]: "" }));
                            }}
                            onReason={(v) =>
                              setDiscAsk({ rowId: row.id, name: seatName(row, i), draft: v })
                            }
                            onList={ex.length ? () => setOpenRow(open ? null : row.id) : null}
                            onClose={() => setDiscRow(null)}
                          />
                        ) : (
                          /* 평소엔 금액만. 빈 칸이면 아무것도 두지 않습니다 — 올리면 입력이 나옵니다 */
                          <div className="gs-disc-view">
                            {ex.length > 0 && (
                              <>
                                <span className="gs-disc-amt">{man(exSum)}</span>
                                <span className="gs-disc-sub">{ex.length}건</span>
                              </>
                            )}
                          </div>
                        )}
                      </td>
                      )}
                      {/* 합계는 행에서 직접 계산합니다 — 정산(r)은 빈 슬롯을 뺀 목록이라
                          표의 행 번호와 어긋날 수 있어서요 */}
                      {simple ? (
                        <td className="gs-sumcell">
                          {won(Math.max(0, simpleGold(row)))}
                        </td>
                      ) : readOnly ? (
                        /* 파티원 화면의 합계는 읽기 전용입니다 — 눌러도 입력칸이 열리지
                           않아야 고칠 수 있는 칸처럼 보이지 않습니다 */
                        <td className="gs-sumcell">{man(Math.max(0, itemGold(row)))}</td>
                      ) : (
                        <td className="gs-sumcell gs-sumcell-edit">
                          <TotalEdit
                            display={Math.max(0, itemGold(row))}
                            base={itemGold(row)}
                            per={goldOf(unit) || 1}
                            suffix={(UNITS.find((u) => u.v === unit) || {}).label || "G"}
                            onCommit={(g) => editTotal(row, g)}
                          />
                        </td>
                      )}
                      {!readOnly && (
                        <td className="gs-toolcell">
                          <div className="gs-toolbtns">
                            {/* (폐기 2026-09-06) 도구칸의 사람 버튼 — 이름 옆 사람 아이콘이 그 문입니다 */}
                            {/* 기록 — 글자 '기록'은 표 안에서 숫자와 다투니
                                아이콘(되감는 시계)으로 둡니다 */}
                            {!simple && (
                              <button
                                className="gs-rowlog gs-rowdel"
                                onClick={() => openLog(row.id)}
                                aria-haspopup="dialog"
                                title="이 사람의 기록 보기"
                                aria-label={`${row.name || "이 사람"}의 기록 보기`}
                              >
                                <svg viewBox="0 0 16 16" width="17" height="17" aria-hidden="true">
                                  <g
                                    fill="none"
                                    stroke="currentColor"
                                    strokeWidth="1.4"
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                  >
                                    <path d="M6.65 3.18A5.2 5.2 0 1 1 3.5 5.6" />
                                    <path d="M1.3 6.6 3.5 5.6l.2 2.4" />
                                    <path d="M8 5.4v2.8l2.3 1.3" />
                                  </g>
                                </svg>
                              </button>
                            )}
                            {/* 파괴적인 ×는 늘 맨 끝에 */}
                            <button
                              className="gs-x gs-rowdel"
                              onClick={() => askDelRow(row)}
                              aria-label={`${row.name || "이 사람"} 삭제`}
                            >
                              ×
                            </button>
                          </div>
                        </td>
                      )}
                    </tr>

                    {!simple && open && (
                      <tr
                        className="gs-exrow"
                        data-row={row.id}
                      >
                        <td colSpan={cols.length + (readOnly ? 3 : 5)}>
                          <Discretion
                            who={seatName(row, i)}
                            extras={ex}
                            onAdd={(amount, reason) => addExtra(row.id, amount, reason)}
                            onPatch={(exId, key, v) => patchExtra(row.id, exId, key, v)}
                            onFix={(exId) => clampExtra(row.id, exId)}
                            onRemove={(ex) => askDelExtra(row, ex)}
                            onClose={() => setOpenRow(null)}
                          />
                        </td>
                      </tr>
                    )}
                    {/* 자기 줄이 있는 사람의 요청은 그 줄 밑에 붙습니다 (2026-09-06) — [받기] 한 번에 그 줄로 */}
                    {!readOnly &&
                      (() => {
                        const st = seats.find((k) => k.id === row.id);
                        const p = st && !st.acct && st.left && st.who ? waitAll.find((q) => q.acct === st.who) : null;
                        if (!p) return null;
                        const nick = p.nick || p.acct;
                        return (
                          <tr className="gs-subreq" data-row={row.id}>
                            <td colSpan={30}>
                              <div className="gs-subline">
                                <span className="gs-subarrow" aria-hidden="true">↳</span>
                                <span>
                                  {p.kicked ? "내보냈던 " : ""}
                                  <b>{nick}</b>
                                  {ga(nick)} 돌아오려 해요
                                </span>
                                <span className="gs-waitacts">
                                  <button className="gs-swaplink gs-swaplink-mute" onClick={() => waitDeny(p)}>
                                    거절
                                  </button>
                                  <button className="gs-btn gs-btn-sm" onClick={() => waitPlace(p, row.id)}>
                                    받기
                                  </button>
                                </span>
                              </div>
                            </td>
                          </tr>
                        );
                      })()}
                  </Fragment>
                );
              })}
              <tr className="gs-addrow">
                <th className="gs-stick gs-l">
                  {!readOnly && (
                    <button className="gs-add" onClick={addRow}>
                      + 인원 추가
                    </button>
                  )}
                </th>
                <td colSpan={simple ? 2 : cols.length + (readOnly ? 2 : 3)} />
                {/* 세로 선이 끊기지 않게 도구 열은 따로 둡니다 */}
                {!readOnly && <td className="gs-toolcell" />}
              </tr>
            </tbody>

            <tfoot>
              <tr>
                {/* 라벨은 왼쪽 끝이 아니라 실제 숫자 옆에 붙입니다 */}
                <th className="gs-stick gs-l" />
                {/* 열별 소계는 비웁니다 — 바닥줄은 최종 금액 하나만 말하게
                    (메모장은 열이 하나라 소계가 총합과 같은 숫자였습니다) */}
                {activeCols.map((c) => (
                  <td key={c.id} className="gs-foot" />
                ))}
                {!simple && !readOnly && <td className="gs-addcolcell" />}
                {!simple && (
                  <td className="gs-foot gs-foot-disc" />
                )}
                <td className="gs-foot gs-foot-grand">
                  <span className="gs-caplab gs-foot-lab">합계</span>
                  {r ? (simple ? won(r.total) : man(r.total)) : "0"}
                </td>
                {!readOnly && <td className="gs-foot gs-toolcell" />}
              </tr>
            </tfoot>
          </table>
        </div>
        {/* 줄이 없는 사람은 표 아래 (2026-09-06) — [받기]가 규칙대로 앉힙니다(시작 전은 신청만 서고, 진행 중은 처음 온 사람도 섭니다).
            표 밖에 둡니다 — 열이 많아 표가 가로로 스크롤되면 표 안의 줄은 [자리 정하기]가 오른쪽으로 밀려 잘렸다 (같은 날 사용자) */}
        {!readOnly && waitBelow.length > 0 && (
          <div className="gs-waitrows">
            {waitBelow.map((p) => {
              const nick = p.nick || p.acct;
              return (
                <div key={"w:" + p.acct} className="gs-waitrow">
                  <div className="gs-waitline">
                    <b>{nick}</b>
                    <span className="gs-lbreq-id">{p.acct.slice(0, 2) + "••••"}</span>
                    <span className="gs-waitwhy">{waitWhy(p)}</span>
                    <span className="gs-waitacts">
                      <button className="gs-swaplink gs-swaplink-mute" onClick={() => waitDeny(p)}>
                        거절
                      </button>
                      {/* 시작 전 신청은 [받기](첫 빈 자리, 정원 늘림). 진행 중에 줄 없이 온 사람은 [자리 정하기] — 방장이 직접 고릅니다
                          (2026-09-06 재정정; (폐기) [받기] 하나가 첫 빈 줄/새 줄에 앉히던 것) */}
                      {roundLive ? (
                        <button
                          className="gs-btn gs-btn-sm gs-waitpickbtn"
                          onClick={() => {
                            setWaitPick(p);
                            if (tutorialRef.current) tutHit("pick"); // 튜토리얼 4장
                          }}
                        >
                          자리 정하기
                        </button>
                      ) : (
                        <button className="gs-btn gs-btn-sm" onClick={() => waitTake(p)}>
                          받기
                        </button>
                      )}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
        </div>

        </div>
      </section>
      )}

      {/* ── 장부 ─────────────────────────────────────── */}
      {showLedger && !ready && !showLobby && !guestLobby && !guestBlocked && r && (
        <section className="gs-mail gs-ledgersec">
          {/* 보낼 우편 탭과 같은 뼈대 — 머리줄은 밖에, 내용 상자는 안에.
             탭을 바꿔도 정산 방식·수수료 칸이 같은 자리에 있습니다 */}
          <div className="gs-cardhead">
            <div className="gs-headleft">
              <h2 className="gs-h2">정산 장부</h2>
            </div>
            <div className="gs-tools">
              <SplitPick
                value={splitMode}
                onPick={setSplitMode}
                readOnly={readOnly}
                onHelp={() => setShowSplitHelp(true)}
              />
              <label className="gs-fee">
                <span>수수료</span>
                <NumInput
                  className="gs-in gs-in-fee"
                  value={feePercent}
                  onChange={setFeePercent}
                  readOnly={readOnly}
                  aria-label="우편 수수료 (%)"
                />
                <span>%</span>
              </label>
            </div>
          </div>
          <div className="gs-card gs-ledgerbox">
          {/* 장부는 원래 읽기만 하는 화면이라 복귀 안내만 남습니다 */}
          {confessTab && (
            <div className="gs-slip gs-slip-back" role="status">
              <i className="gs-ring" aria-hidden="true" />
              <span className="gs-slip-msg">
                <b>{backIn == null ? 30 : backIn}초</b> 뒤 <b>자수</b> 화면으로 돌아가요 — 누르면 다시 30초.
              </span>
            </div>
          )}
          <span className="gs-unit gs-unit-in">단위: G(골드)</span>
          <div className="gs-scroll">
            <table className="gs-ledger">
              <thead>
                <tr>
                  <th className="gs-l">이름</th>
                  <th>벌금</th>
                  <th>받을 몫</th>
                  <th>순액</th>
                  <th>실수령</th>
                </tr>
              </thead>
              <tbody>
                {/* 장부는 정산 인원(party)만 — 빈 슬롯 행은 여기 안 나옵니다 */}
                {party.map((row, i) => {
                  const net = r.nets[i];
                  return (
                    <tr key={row.id}>
                      <td className="gs-l gs-nm">{row.name || "—"}</td>
                      <Amount v={r.fines[i]} />
                      <Amount v={r.shares[i]} />
                      <Amount v={net} sign className={net > 0 ? "gs-pos" : net < 0 ? "gs-neg" : ""} />
                      {net > 0 ? (
                        <Amount v={r.gotten[i]} />
                      ) : (
                        <td>
                          <span className="gs-dim">{net < 0 ? "보내기만" : "해당 없음"}</span>
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {/* 접으면 표가 아래로 밀려서, 펼치는 대신 팝업으로 띄웁니다 (탭 화면 배려) */}
          <button className="gs-ask-open" onClick={() => setShowHub(true)}>
            총무한테 전부 보내고 나누면 안 되나요?
          </button>
          </div>
        </section>
      )}

      {/* 탭 화면에서 장부에 보여줄 사람이 아직 없을 때 */}
      {showLedger && !ready && !showLobby && !guestLobby && !guestBlocked && !r && tabbed && (
        <section className="gs-mail gs-ledgersec">
          <div className="gs-cardhead">
            <div className="gs-headleft">
              <h2 className="gs-h2">정산 장부</h2>
            </div>
          </div>
          <div className="gs-card gs-ledgerbox">
            {confessTab && (
              <div className="gs-slip gs-slip-back" role="status">
                <i className="gs-ring" aria-hidden="true" />
                <span className="gs-slip-msg">
                  <b>{backIn == null ? 30 : backIn}초</b> 뒤 <b>자수</b> 화면으로 돌아가요 — 누르면 다시 30초.
                </span>
              </div>
            )}
            <div className="gs-empty">
              <p>정산할 사람이 없어요.</p>
              <p className="gs-empty-sub">벌금표에 금액을 입력하면 장부가 여기에 만들어져요.</p>
            </div>
          </div>
        </section>
      )}

      {/* ── 우편 ─────────────────────────────────────── */}
      {showMail && !ready && !showLobby && !guestLobby && !guestBlocked && (
      <section className="gs-mail">
        <div className="gs-cardhead">
          <div className="gs-headleft">
            <h2 className="gs-h2">보낼 우편</h2>
            {r && r.transfers.length > 0 && (
              <button className="gs-btn" onClick={openMail}>
                디코 공유용 복사
              </button>
            )}
          </div>
          <div className="gs-tools">
            <SplitPick
              value={splitMode}
              onPick={setSplitMode}
              readOnly={readOnly}
              onHelp={() => setShowSplitHelp(true)}
            />
            <label className="gs-fee">
              <span>수수료</span>
              <NumInput
                className="gs-in gs-in-fee"
                value={feePercent}
                onChange={setFeePercent}
                readOnly={readOnly}
                aria-label="우편 수수료 (%)"
              />
              <span>%</span>
            </label>
          </div>
        </div>

        {/* 우편도 읽기만 하는 화면이라 복귀 안내만 — 맨 위 한 줄입니다 */}
        {confessTab && (
          <div className="gs-slip gs-slip-back" role="status">
            <i className="gs-ring" aria-hidden="true" />
            <span className="gs-slip-msg">
              <b>{backIn == null ? 30 : backIn}초</b> 뒤 <b>자수</b> 화면으로 돌아가요 — 누르면 다시 30초.
            </span>
          </div>
        )}

        {!r || r.transfers.length === 0 ? (
          <div className="gs-empty">
            <p>보낼 우편이 없어요.</p>
            <p className="gs-empty-sub">벌금표를 채우면 송금 조합이 여기에 만들어져요.</p>
          </div>
        ) : (
          <>
            <div className="gs-envs">
              {mails.map((m, k) => (
                <Envelope
                  key={m.from}
                  idx={k}
                  from={seatName(party[m.from], m.from)}
                  items={m.items.map((t) => ({
                    to: seatName(party[t.to], t.to),
                    amount: t.amount,
                    received: t.received,
                  }))}
                  total={m.total}
                  fee={m.fee}
                  feePct={feePercent}
                />
              ))}
            </div>
            <p className="gs-proof">
              {r.exact ? (
                <>
                  송금 <b>{r.transfers.length}회</b>. 더 줄일 수 없는 최소 횟수예요.
                </>
              ) : (
                <>송금 {r.transfers.length}회. 인원이 15명을 넘어 근사 계산이에요.</>
              )}{" "}
              이동 {G(r.moved)} · 수수료 {G(r.feeTotal)}.
            </p>
          </>
        )}
      </section>
      )}

      {/* ── 첫 방문 관문 — 튜토리얼을 볼지만 묻습니다 ─────────────
          모드는 여기서 안 묻습니다. 처음 온 사람은 두 모드의 차이를 아직 모르고,
          카운터로 시작해도 벌금표 위에서 언제든 바꿀 수 있습니다. */}
      {/* (폐기 2026-09-06) 첫 방문 관문 `처음 오셨나요?` [튜토리얼 해보기] [건너뛰기] — 위 intro 주석 참고 */}

      {/* ── 모드 안내 — '자세히 보기'로만 엽니다 ─────────────────── */}
      {intro === "guide" && (
        <div className="gs-intro" role="dialog" aria-modal="true" aria-label="모드 안내">
          <div className="gs-intro-in">
            <div className="gs-intro-top">
              <h1 className="gs-title">모드 안내</h1>
              <button className="gs-btn gs-btn-ghost" onClick={() => setIntro(null)}>
                닫기
              </button>
            </div>
            <p className="gs-intro-lead">
              벌금을 적으면 누가 누구에게 얼마를 보낼지, 우편 수수료까지 계산해요.
              <br />
              그냥 닫아도 지금 모드 그대로예요. 카드를 고르면 그 모드로 바뀌어요.
            </p>
            <div className="gs-intro-cards">
              <button className="gs-intro-card" onClick={() => pickIntro("simple")}>
                <span className="gs-intro-name">메모장</span>
                <span className="gs-io-vis">
                  <span className="gs-io-memo">{"쿼카 25\n순두부 30\nㅈ냥이 44"}</span>
                  <span className="gs-io-arr">→</span>
                  <span className="gs-io-rows">
                    <span>
                      <b>쿼카</b>
                      <i>25만</i>
                    </span>
                    <span>
                      <b>순두부</b>
                      <i>30만</i>
                    </span>
                    <span>
                      <b>ㅈ냥이</b>
                      <i>44만</i>
                    </span>
                  </span>
                </span>
                <span className="gs-intro-desc">
                  이미 메모장에 적고 계셨다면 그대로 붙여넣기만 하면 돼요. 기록은 하던 대로
                  하고 정산만 여기서 하는 방식이에요. 새로 적을 때도 이름과 금액만 한 줄씩
                  치면 표가 만들어져요.
                </span>
              </button>
              <button className="gs-intro-card" onClick={() => pickIntro("items")}>
                <span className="gs-intro-name">카운터</span>
                <span className="gs-io-vis">
                  <span className="gs-io-mini">
                    <span className="gs-io-cap" />
                    <span className="gs-io-cap">잡힘</span>
                    <span className="gs-io-cap">죽음</span>
                    <span className="gs-io-name">쿼카</span>
                    <span className="gs-io-cell on">
                      3<em>회</em>
                    </span>
                    <span className="gs-io-cell on">
                      2<em>회</em>
                    </span>
                    <span className="gs-io-name">순두부</span>
                    <span className="gs-io-cell">＋</span>
                    <span className="gs-io-cell on">
                      1<em>회</em>
                    </span>
                  </span>
                </span>
                <span className="gs-intro-desc">
                  잡힘·죽음 같은 항목을 정해 두고, 일이 생길 때마다 칸을 눌러요. 단가는
                  항목마다 한 번만 정하면 돼요.
                </span>
              </button>
            </div>
            <p className="gs-intro-foot">
              정산 장부와 보낼 우편은 벌금표를 따라 저절로 채워져요. 모드를 바꿔도 적어둔
              내용은 그대로 넘어가요.
            </p>
          </div>
        </div>
      )}

      {discAsk && (
        <ReasonAdd
          who={discAsk.name}
          draft={discAsk.draft}
          unitLabel={unitLabel}
          onClose={() => setDiscAsk(null)}
          onAdd={(v, reason) => {
            addExtra(discAsk.rowId, commafy(Math.round(v * per)), reason);
            setDiscAsk(null);
          }}
        />
      )}
      {/* [?] — 사용법 메뉴 (2026-09-06 사용자 확정): 지금 화면 것이 맨 위, 나머지 화면은 그 화면에서. 문서 둘은 공유 창에.
          (폐기 2026-09-06) 질문 답변 목록 아홉 개(잘못 눌렀어요 · 숫자를 직접 고치고 싶어요 · 단가를 중간에 바꿔야 해요 · 이미 메모장에 적고
          있었어요 · 같은 멤버로 한 판 더 해요 · 어제 판을 다시 보고 싶어요 · 파티원한테 보여주고 싶어요 · 벌금을 어떻게 나눌지 고르고 싶어요 ·
          채팅에 붙여넣고 싶어요)와 [튜토리얼 다시보기] — 답이 전부 코치마크 안으로 들어간다 */}
      {showLog && !simple && (
        <InfoModal
          title={logRow ? `${logName || "이 사람"} · 기록` : "기록"}
          wide
          onClose={closeLog}
        >
          <div className="gs-log-head">
            <p className="gs-log-note">
              최근 {LOG_CAP}줄 · 취소는 줄을 지우지 않고 반대 기록을 덧붙여요
            </p>
            {logRow && (
              <span className="gs-seg gs-seg-sm" role="group" aria-label="기록 범위">
                <button className="on">이 사람만</button>
                <button onClick={() => setLogRow(null)}>전체</button>
              </span>
            )}
          </div>
          {shownLog.length === 0 ? (
            <p>
              {logRow
                ? "이 사람의 기록이 없어요."
                : "아직 기록이 없어요. 칸의 ＋를 누르면 쌓여요."}
            </p>
          ) : (
            <ul className="gs-log-list">
              {[...shownLog].reverse().map((en) => (
                <li key={en.id} className={en.cancelled ? "gs-log-xed" : ""}>
                  <span className="gs-log-t">{hhmm(en.t)}</span>
                  <span
                    className={
                      "gs-log-nm" + (en.kind === "price" || en.kind === "clear" ? " gs-log-sys" : "")
                    }
                  >
                    {en.kind === "price"
                      ? en.item || "항목"
                      : en.kind === "clear"
                      ? en.name || "전체"
                      : en.name || "이름 없음"}
                  </span>
                  <span className="gs-log-what">
                    {en.kind === "price" &&
                      `단가 ${man(en.from)} → ${man(en.to)}${
                        en.mode === "forward" ? " (지금부터)" : ""
                      }`}
                    {en.kind === "press" && `${en.item || "항목"} ${signedMan(en.delta)}`}
                    {en.kind === "confess" && `${en.n < 0 ? "자수 정정" : "자수"} — ${en.item || "항목"} ${signedMan(en.delta)}`}
                    {en.kind === "extra" && `${en.item || "기타"} ${signedMan(en.delta)}`}
                    {en.kind === "extra-del" &&
                      `${en.item || "기타"} 삭제 ${signedMan(en.delta)}`}
                    {en.kind === "roulette" &&
                      `${en.item ? en.item + " " : ""}${/룰렛/.test(en.item || "") ? "" : "룰렛 "}` +
                        `${faceLabel(String(en.num))}${en.mult > 1 ? ` ×${en.mult}` : ""}` +
                        ` = ${signedMan(en.delta)}` +
                        `${en.raw != null ? ` (원래 ${man(en.raw)}, 벌금까지만)` : ""}` +
                        `${en.from ? ` (${en.from} 양도)` : ""}`}
                    {en.kind === "edit" && `직접 수정 ${signedMan(en.delta)}`}
                    {en.kind === "memo" && `메모장에서 수정 ${signedMan(en.delta)}`}
                    {en.kind === "memo-new" && `메모장에서 추가 ${signedMan(en.delta)}`}
                    {en.kind === "memo-del" && `메모장에서 제외 ${signedMan(en.delta)}`}
                    {en.kind === "cancel" &&
                      `취소 — ${en.item ? en.item + " " : ""}${signedMan(en.delta)}`}
                    {/* 판은 그대로 두고 숫자만 리셋한 자리 — 결과지에는 무영향입니다 (§3.4) */}
                    {en.kind === "clear" &&
                      `비움 ${en.item ? en.item + " " : ""}${signedMan(en.delta)}`}
                  </span>
                  {en.kind !== "price" && <span className="gs-log-after">→ {man(en.after)}</span>}
                  {en.kind !== "cancel" &&
                    !readOnly &&
                    !en.cancelled &&
                    rows.some((x) => x.id === en.rowId) && (
                      <button className="gs-log-cancel" onClick={() => cancelEntry(en)}>
                        취소
                      </button>
                    )}
                </li>
              ))}
            </ul>
          )}
        </InfoModal>
      )}
      {showSplitHelp && <SplitHelp onClose={() => setShowSplitHelp(false)} />}
      {demoOpen && (
        <div className="gs-demo" role="dialog" aria-label="처음부터 같이 해보기">
          {/* 문구는 350ms 뒤에야, 그리고 떴으면 800ms 는 (위 규칙). 그 전엔 창만 번져 들어옵니다 */}
          {demoLoadShown && !demoOn && !demoTop && <p className="gs-demo-load">{demoLoad}</p>}
          {/* 4장 파티원 예시를 얹는 동안엔 방장 예시 위에 작은 칩으로 */}
          {demoTop && demoTopLoadShown && !demoTopOn && <p className="gs-demo-load gs-demo-load-over">{demoLoad}</p>}
          {/* key — 해시만 바뀌면 같은 문서 안에서 이동할 뿐 다시 뜨지 않습니다. 새 iframe 이어야 예시가 새로 부팅합니다 */}
          <iframe key={demoSrc} ref={demoARef} className={"gs-demo-frame" + (demoOn ? " on" : "")} title="처음부터 같이 해보기" src={demoSrc} />
          {/* B — 방장 예시 위에 번져 나왔다가(4장) 끝나면 번져 사라집니다. A 는 그 밑에 그대로 */}
          {demoTop && <iframe key={demoTop} ref={demoBRef} className={"gs-demo-frame gs-demo-top" + (demoTopOn ? " on" : "")} title="파티원 화면" src={demoTop} />}
        </div>
      )}
      {/* 튜토리얼(예시 앱 안) — 표적이 아직 없으면 그리지 않습니다(화면이 바뀌는 사이; 살피는 효과가 곧 다시 그림).
          ✕·Esc 는 그만두기. 번호는 띠(스테퍼)가 말하므로 말풍선엔 없습니다 */}
      {coach &&
        coach.kind === "party" &&
        TOUR_FLOW[coach.step] &&
        document.querySelector(TOUR_FLOW[coach.step].sel) && (
          <CoachMark
            key={"party:" + coach.step}
            sel={TOUR_FLOW[coach.step].sel}
            text={TOUR_FLOW[coach.step].text}
            action={TOUR_FLOW[coach.step].action || (coach.ready ? TOUR_FLOW[coach.step].after : undefined)}
            block
            lock={!!TOUR_FLOW[coach.step].lock}
            center={!!TOUR_FLOW[coach.step].center}
            overModal={!!TOUR_FLOW[coach.step].top}
            clear={!!TOUR_FLOW[coach.step].clear}
            onNext={() => {
              const st = TOUR_FLOW[coach.step];
              if (st.exit === "closeObs") setObsOpen(false);
              if (st.exit === "handoff") {
                /* 3장 끝 [실리안의 화면 보기] — 부모가 파티원 예시 앱(4장)을 위에 얹고, 돌아오면(party-demo-resume) 다음 걸음.
                   부모 없이 열렸으면(개발용 #demo 단독) 그냥 다음 걸음 */
                if (window.parent && window.parent !== window) {
                  try {
                    window.parent.postMessage({ gs: "party-demo", done: false, next: "member", kind: "host" }, window.location.origin);
                  } catch (e) {}
                } else partyStep(coach.step + 1);
                return;
              }
              if (coach.step >= TOUR_FLOW.length - 1) endPartyCourse(DEMO_CH4 ? "host" : true); // 4장 파티원 예시는 방장 예시로 복귀, 나머지는 끝
              else partyStep(coach.step + 1);
            }}
            onClose={() => {
              if (document.querySelector(TOUR_FLOW[coach.step].sel)) endPartyCourse(false);
            }}
          />
        )}
      {coach && coach.kind === "obs" && (
        <CoachMark
          sel=".gs-obsbtn"
          text="OBS 공유는 여기서 언제든 다시 열 수 있어요."
          action="알겠어요"
          onNext={() => {
            coachDone("obsScribe");
            setCoach(null);
          }}
          onClose={() => {
            coachDone("obsScribe");
            setCoach(null);
          }}
        />
      )}
      {showHub && r && (
        <InfoModal title="총무한테 전부 보내고 나누면 안 되나요?" onClose={() => setShowHub(false)}>
          <table className="gs-vs">
            <tbody>
              <tr>
                <th>총무 방식</th>
                <td>송금 {r.hubCount}회</td>
                <td className="gs-vs-fee">수수료 {G(r.hubFee)}</td>
              </tr>
              <tr>
                <th>지금 방식</th>
                <td>송금 {r.transfers.length}회</td>
                <td className="gs-vs-fee">수수료 {G(r.feeTotal)}</td>
              </tr>
            </tbody>
          </table>
          <p>
            총무를 거치면 같은 돈이 우편을 두 번 타서 수수료를 두 번 떼여요.{" "}
            <b>{G(r.hubFee - r.feeTotal)}</b> 차이예요.
          </p>
        </InfoModal>
      )}
      {presetOpen && (
        <PresetModal
          presets={presets}
          onSave={savePresetNow}
          onLoad={(nm) => {
            const pre = presets.find((x) => x.name === nm);
            if (!pre) return;
            loadPreset(pre);
            setPresetOpen(false);
          }}
          onDelete={(nm) => {
            const next = presets.filter((x) => x.name !== nm);
            setPresets(next);
            savePresets(next);
          }}
          onClose={() => setPresetOpen(false)}
        />
      )}
      {/* 줄의 사람 시트 (§3.2, 2026-09-05) — 동사 라벨만: 다른 줄로 옮기기 · 파티에서 내보내기 · 여기 앉히기.
          (폐기) 파티 서랍의 파티원 목록([자리 바꾸기]·[내보내기]) — 표와 떨어져 "어느 줄"을 이름으로만 골랐다 */}
      {rowPerson &&
        (() => {
          const st = seats.find((k) => k.id === rowPerson);
          if (!st) return null;
          /* (폐기 2026-09-06) 계정 없는 줄의 '여기 앉힐 사람' — 합류는 규칙이 앉히고, 고치는 건 옮기기뿐 */
          if (!st.acct) return null;
          const i = seats.indexOf(st);
          const label = seatName2(st, i);
          const close = () => setRowPerson(null);
          if (st.acct) {
            const mem = members.find((m) => m.acct === st.acct);
            const nick = (mem && mem.nick) || st.nick || (auth && st.acct === auth.id ? auth.nick : "") || "";
            const off = !!mem && mem.on === false;
            return (
              <InfoModal title={label} onClose={close}>
                <div className="gs-key">
                  <p className="gs-ppl-who">
                    <b>{nick}</b> {st.acct.slice(0, 2) + "••••"} · {off ? "연결 끊김" : "연결됨"}
                  </p>
                  <div className="gs-seatlist">
                    <button
                      className="gs-seatopt"
                      onClick={() => {
                        close();
                        setSeatMove({ acct: st.acct, nick });
                      }}
                    >
                      다른 줄로 옮기기…
                    </button>
                    <button
                      className="gs-seatopt gs-seatopt-danger"
                      onClick={() => {
                        close();
                        setAsk({
                          title: nick + "님을 내보낼까요?",
                          body: "줄과 벌금은 그대로 남고, 다시 초대하면 돌아와요.",
                          action: "내보내기",
                          tone: "danger",
                          onYes: () => kickMember(st.acct),
                        });
                      }}
                    >
                      파티에서 내보내기
                    </button>
                  </div>
                  <div className="gs-obs-acts gs-acts-end">
                    <button className="gs-btn gs-btn-sm gs-btn-ghost" onClick={close}>
                      닫기
                    </button>
                  </div>
                </div>
              </InfoModal>
            );
          }
          /* 계정 없는 줄 — 여기 앉힐 사람: 앉아 있는 파티원(옮겨 옴)과 신청 중인 사람 */
          const cands = [
            ...members
              .filter((m) => m.st === "ok")
              .map((m) => {
                const cur = seats.find((k) => k.acct === m.acct);
                return {
                  ...m,
                  req: false,
                  where: cur ? "지금 '" + seatName2(cur, seats.indexOf(cur)) + "' 줄" : "자리 없음",
                };
              }),
            ...pending.map((m) => ({ ...m, req: true, where: "신청 중" })),
          ];
          return (
            <InfoModal title={label + " 줄"} onClose={close}>
              <div className="gs-key">
                <p className="gs-ppl-who">이 줄에 앉힐 사람을 골라요 — 옮겨 오는 사람의 자수 자격이 이 줄로 따라와요.</p>
                {cands.length === 0 ? (
                  <p className="gs-lb-note">아직 앉힐 사람이 없어요 — 초대 링크로 부르면 여기 떠요.</p>
                ) : (
                  <div className="gs-seatlist">
                    {cands.map((m) => (
                      <button
                        key={m.acct}
                        className="gs-seatopt"
                        onClick={() => {
                          close();
                          if (m.req) seatMember(m.acct, m.nick || m.acct, rowPerson);
                          else seatMember(m.acct, m.nick || m.acct, rowPerson, { local: true });
                        }}
                      >
                        {m.nick || m.acct}
                        <em className="gs-seatopt-g">{m.where}</em>
                      </button>
                    ))}
                  </div>
                )}
                <div className="gs-obs-acts gs-acts-end">
                  <button className="gs-btn gs-btn-sm gs-btn-ghost" onClick={close}>
                    닫기
                  </button>
                </div>
              </div>
            </InfoModal>
          );
        })()}
      {/* (폐기 2026-09-06) 판 중 초대 링크 창 — 코드는 공유 창(OBS 공유 설정)에, 들어오려는 사람은 표 아래 줄에 */}
      {/* (폐기 2026-09-06, 당일) [자리 정하기] 시트 */}
      {/* 지난 판 이어서 — 고르기 (2026-09-06). [시작] 때 그 판의 줄이 열립니다 */}
      {resumePick && !readOnly && (
        <InfoModal title="지난 판 이어서" onClose={() => setResumePick(false)}>
          <div className="gs-key">
            <p className="gs-ppl-who">[시작]을 누르면 고른 판의 줄·숫자·기록이 그대로 열려요. 앉은 사람은 자기 줄로 돌아가요.</p>
            <div className="gs-seatlist">
              {gensList()
                .filter((g) => g.gen && (!g.host || g.host === g.me))
                .map((g) => (
                  <button
                    key={g.name}
                    className="gs-seatopt"
                    onClick={() => {
                      putRelay({ ...relayRef.current, resumeFrom: g.name });
                      setResumePick(false);
                    }}
                  >
                    {g.rname || g.name}
                    <em className="gs-seatopt-g">
                      {g.n}명 · {man(g.gold || 0)}
                    </em>
                  </button>
                ))}
            </div>
            <div className="gs-obs-acts gs-acts-end">
              <button className="gs-btn gs-btn-sm gs-btn-ghost" onClick={() => setResumePick(false)}>
                닫기
              </button>
            </div>
          </div>
        </InfoModal>
      )}
      {/* 표 아래 사람의 [자리 정하기] (2026-09-06 재정정) — 빈 줄·퇴장한 사람 줄·새 줄 중에 방장이 고릅니다.
          퇴장 줄에 벌금이 남아 있으면 확인창(사용자: "퇴장 자리에도 채울 수 있어야… 대신 알림이 떠야겠죠"). 문구는 §8 초안 */}
      {waitPick &&
        !readOnly &&
        (() => {
          const p = waitPick;
          const nick = p.nick || p.acct;
          const close = () => setWaitPick(null);
          const opts = seats.map((s0, i) => ({ s: s0, i })).filter(({ s: s0, i }) => i > 0 && !s0.acct);
          const fineOf = (s0) => {
            const r = rows.find((x) => x.id === s0.id);
            return r ? liveTotal(r) : 0;
          };
          const pick = (id) => {
            close();
            waitPlace(p, id);
          };
          return (
            <InfoModal title={nick + " 자리 정하기"} onClose={close}>
              <div className="gs-key">
                <p className="gs-ppl-who">어느 줄에 앉힐까요? 퇴장한 사람 줄에 앉히면 남은 벌금도 그 사람 것이 돼요.</p>
                <div className="gs-seatlist gs-waitpick">
                  {opts.map(({ s: s0, i }) => {
                    const g = fineOf(s0);
                    const left = !!s0.left;
                    const label = seatName2(s0, i);
                    return (
                      <button
                        key={s0.id}
                        className="gs-seatopt"
                        onClick={() => {
                          if (left && g > 0) {
                            close();
                            setAsk({
                              title: label + "의 벌금 " + man(g) + "이 남아 있어요",
                              body: nick + "님이 이 줄에 앉으면 그 벌금도 " + nick + "님 것이 돼요.",
                              action: "이 줄에 앉히기",
                              onYes: () => waitPlace(p, s0.id),
                            });
                            return;
                          }
                          pick(s0.id);
                        }}
                      >
                        {label} 줄
                        <em className="gs-seatopt-g">{left ? "퇴장 · 벌금 " + man(g) : "빈 줄"}</em>
                      </button>
                    );
                  })}
                  <button className="gs-seatopt gs-seatopt-new" onClick={() => pick("new")}>
                    + 새 줄 만들기
                  </button>
                </div>
                <div className="gs-obs-acts gs-acts-end">
                  <button className="gs-btn gs-btn-sm gs-btn-ghost" onClick={close}>
                    닫기
                  </button>
                </div>
              </div>
            </InfoModal>
          );
        })()}
      {/* [자리 바꾸기] — 옮기면 자수 자격이 따라갑니다 */}
      {seatMove && (
        <SeatPick
          title="자리 바꾸기"
          nick={seatMove.nick}
          seats={seats}
          onPick={(id) => {
            moveMember(seatMove.acct, seatMove.nick, id);
            setSeatMove(null);
          }}
          onClose={() => setSeatMove(null)}
        />
      )}

      {obsOpen && (
        <ObsShare
          relay={relay}
          putRelay={putRelay}
          /* 예시 앱은 주소를 받기 전엔 계정 없는 사람의 창을 보여 줍니다 — [내 방송용 주소 받기]가 튜토리얼의 표적 (6장·파티원 5걸음) */
          auth={DEMO && !(auth && auth.obsToken) ? null : auth}
          onOpenAuth={(tab, wantAddr) => {
            /* 예시 앱 — 계정 창 없이 바로 주소가 생긴 것으로 (튜토리얼 6장·파티원 5걸음) */
            if (DEMO) {
              setAuth((a) => (a ? { ...a, obsToken: "EXAMPLE" } : a));
              courseHit("obsgot");
              return;
            }
            /* wantAddr = [내 방송용 주소 받기]로 들어온 경우 — 어느 문으로 끝내든
               방을 열고 다음 걸음 안내(주소가 나왔어요)를 띄웁니다. 이 창은 그대로
               열려 있다가 주소를 보여 줍니다.
               ctx 문구는 안 얹습니다 (§3.11) — 대문은 어디서 열든 같은 얼굴입니다 */
            openAuth(tab, wantAddr ? openMyRoom : null);
          }}
          onNick={changeNick}
          onLogout={() => {
            setObsOpen(false);
            askLogout();
          }}
          onUpgrade={() => {
            /* 아이디 정하기 창이 이 창 위에 겹치지 않게 — 하나씩 (§9-5) */
            setObsOpen(false);
            setUpOpen({ after: null });
          }}
          fresh={obsFresh}
          guest={shareGuest}
          ovCols={simple ? [] : activeCols}
          isOff={(id) => ovShow().itemOff(id)}
          sumOn={ovShow().sum}
          netOn={ovShow().net}
          slideOn={ovShow().slide}
          onOvSlide={(on) => setOvFlag("slide", on)}
          onOvItem={toggleOvItem}
          onOvKey={toggleOvCol}
          onAskReissue={askObsReissue}
          castState={dotState}
          inviteRow={null /* (2026-09-06) 초대 코드는 헤더 팝오버에 — 공유 창은 OBS 것만 */}
          onClose={() => {
            setObsOpen(false);
            /* 다음 걸음 안내는 받은 그 자리에서만 — 다시 열면 평소 화면입니다 */
            setObsFresh(false);
            if (obsCoachPending.current) {
              obsCoachPending.current = false;
              setCoach({ kind: "obs" });
            }
          }}
        />
      )}
      {authOpen && (
        <AuthModal
          tab={authOpen.tab}
          ctx={authOpen.ctx}
          onDone={(a) => {
            const after = authOpen.after;
            setAuthOpen(null);
            putAuth(a);
            /* 하려던 일이 있으면 그것부터 — 없을 때만 이어가기를 제안합니다 */
            if (after) setTimeout(() => after(a), 0);
            else askResume(a);
          }}
          onClose={() => setAuthOpen(null)}
        />
      )}
      {whyOpen && (
        <InfoModal title="왜 파티원은 남의 줄을 못 고치나요?" onClose={() => setWhyOpen(false)}>
          <p>
            벌금 기록은 방장 브라우저에서만 되고, 파티원은 자기 줄의 보통 항목만 눌러요.
            한 사람이 장부를 쥐고 있어야 중복 입력 사고가 없기 때문이에요.
          </p>
          <p>
            여러 명이 동시에 남의 줄을 고칠 수 있으면, 같은 벌금을 두 사람이 각각 넣거나 한쪽이
            방금 고친 숫자를 다른 쪽이 덮어쓰는 일이 생겨요. 정산이 끝난 뒤에는 어느 쪽이 맞는지
            확인할 방법도 없고요.
          </p>
          <p>
            대신 파티원은 벌금표·정산 장부·보낼 우편을 전부 볼 수 있어요. 자기가 얼마 냈고
            누구에게 얼마를 보내는지 직접 확인할 수 있으니, 못 보는 것은 없어요.
          </p>
        </InfoModal>
      )}
      {/* 익명 계정에 아이디·비밀번호를 붙이는 창 — 같은 계정이라 주소도 세션도 그대로입니다 */}
      {upOpen && (
        <UpgradeModal
          nick={auth ? auth.nick : ""}
          onRun={doUpgrade}
          onDone={() => {
            const after = upOpen.after;
            setUpOpen(null);
            if (after) setTimeout(() => after(), 0);
          }}
          onClose={() => setUpOpen(null)}
        />
      )}
      {/* 합류 신청 알림 — 카드는 "신청이 왔다"고 알리고 목록으로 데려가는 역할만 합니다 (§3-4).
          수락을 여기에만 두면 동시 신청이 덮어써지고, 놓치면 수락할 방법이 없어집니다.
          대기실을 보고 있으면 신청 카드가 이미 화면에 있으므로 알리지 않습니다. */}
      {/* (폐기 2026-09-06) `들어오려는 사람이 있어요 [보기]` 카드 — 사건이 카드로 눌어붙어 있었다. 토스트 한 번과 표 아래 줄 */}
      {/* 지목 초대 — 앱을 열 때와 창에 초점이 돌아올 때 확인한 것이 여기 뜹니다 (§3.3).
          어느 화면에 있든 보여야 해서 맨 바깥에 둡니다. 여럿이면 제일 최근 것 하나만 —
          1분짜리라 쌓아 두면 이미 스러진 초대에 손이 갑니다 */}
      {auth && !genView && liveInvites.length > 0 && (
        <InviteCard
          inv={liveInvites[liveInvites.length - 1]}
          onAccept={acceptInvite}
          onDeny={denyInvite}
        />
      )}
      {priceAsk && cols.some((c) => c.id === priceAsk) && (
        <PriceModal
          col={cols.find((c) => c.id === priceAsk)}
          rows={rows}
          per={goldOf(unit) || 1}
          unitLabel={unitLabel}
          onApply={applyPrice}
          onClose={() => setPriceAsk(null)}
        />
      )}
      {addColOpen && (
        <InfoModal title="어떤 항목을 더할까요?" onClose={() => setAddColOpen(false)}>
          <div className="gs-coltype">
            <button className="gs-coltype-pick" onClick={() => addCol()}>
              <b>보통 항목</b>
              <span>칸을 누른 횟수 × 단가로 벌금이 쌓여요. 잡힘·죽음 같은 것들이에요.</span>
            </button>
            <button className="gs-coltype-pick" onClick={() => addCol("roulette")}>
              <b>룰렛 항목</b>
              <span>
                칸을 누르면 룰렛이 돌아요. 나온 숫자 × 단가만큼 벌금이 붙고, ×2가 나오면
                곱해서 다시 돌아요. 양도권이 나오면 그 벌금을 다른 사람에게 넘겨요.
              </span>
            </button>
          </div>
        </InfoModal>
      )}
      {rouletteCfg && cols.some((c) => c.id === rouletteCfg && isRoulette(c)) && (
        <RouletteCfg
          col={cols.find((c) => c.id === rouletteCfg)}
          unitLabel={unitLabel}
          theme={wheelTheme(relay)}
          onOrder={(faces) =>
            setCols((prev) =>
              prev.map((c) => (c.id === rouletteCfg ? { ...c, faces } : c))
            )
          }
          onW={(k, v) =>
            setCols((prev) =>
              prev.map((c) =>
                c.id === rouletteCfg ? { ...c, w: { ...weightsOf(c), [k]: v } } : c
              )
            )
          }
          onPass={(v) =>
            setCols((prev) =>
              prev.map((c) => (c.id === rouletteCfg ? { ...c, passMode: v } : c))
            )
          }
          onPassSelf={(v) =>
            setCols((prev) =>
              prev.map((c) => (c.id === rouletteCfg ? { ...c, passSelf: v } : c))
            )
          }
          onToggleFace={(k) =>
            setCols((prev) =>
              prev.map((c) => {
                if (c.id !== rouletteCfg) return c;
                const cur = facesOf(c);
                if (cur.includes(k)) return { ...c, faces: cur.filter((x) => x !== k) };
                /* 되살릴 때는 맨 앞으로 — 꺼진 줄이 표 맨 위에 떠 있으니 켜도 그 자리
                   그대로고, 끌어 둔 나머지 순서도 안 흐트러집니다. */
                return { ...c, faces: [k, ...cur] };
              })
            )
          }
          onAddFace={(k, w) =>
            setCols((prev) =>
              prev.map((c) =>
                c.id === rouletteCfg && !facesOf(c).includes(k)
                  ? { ...c, faces: [...facesOf(c), k], w: { ...weightsOf(c), [k]: w } }
                  : c
              )
            )
          }
          onDelFace={(k) =>
            setCols((prev) =>
              prev.map((c) =>
                c.id === rouletteCfg
                  ? { ...c, faces: facesOf(c).filter((x) => x !== k) }
                  : c
              )
            )
          }
          onReset={() =>
            setCols((prev) =>
              prev.map((c) =>
                c.id === rouletteCfg
                  ? { ...c, faces: ROULETTE_KEYS.slice(), w: { ...ROULETTE_W } }
                  : c
              )
            )
          }
          onClose={() => setRouletteCfg(null)}
        />
      )}
      {readOnly && vcard && (
        <div
          className={
            "gs-fxcard" +
            (vcard.k === "roul" ? " roul" : "") +
            (vcard.g > 0 ? " up" : " dn")
          }
          role="status"
          key={vcard.i}
        >
          <b>{vcard.n}</b>
          <span>
            {vcard.t || ""}{" "}
            <em>{(vcard.g > 0 ? "+" : "−") + man(Math.abs(vcard.g))}</em>
          </span>
        </div>
      )}
      {/* 방금 누른 것 — 아래가 고정이고 위로 자랍니다. 새 줄이 맨 아래에 붙어서
          방금 누른 것은 늘 같은 자리에 있습니다. 올려 두면 시계가 멈춥니다. */}
      {!readOnly && burstRows.length > 0 && (
        <div
          className="gs-press"
          onMouseEnter={() => setBurstHold(true)}
          onMouseLeave={() => {
            setBurstHold(false);
            setBurstKey((k) => k + 1); // 손을 떼면 시계도 막대도 처음부터
          }}
        >
          <div className="gs-press-track">
            <i
              className="gs-press-bar"
              key={burstKey}
              style={{ animationDuration: BURST_MS + "ms" }}
              aria-hidden="true"
            />
          </div>
          <div className="gs-press-head">
            방금 바뀐 <b>{burstRows.length}건</b>
          </div>
          <ul className="gs-press-rows">
            {burstRows.map((e) => (
              /* 왼쪽 색 띠 — 늘면 붉게, 정정(줄면) 푸르게 (2026-09-07 사용자: 정정 칩과 부호 색만으로는 구분이 약하다) */
              <li key={e.id} className={e.delta < 0 ? "dn" : "up"}>
                {/* 왼쪽 눈금 — 위에서 아래로 시간이 흐릅니다. 방금 것과 아까 것이 한눈에 갈립니다 */}
                <span className="gs-press-ago">
                  {Math.max(0, Math.floor((burstNow - e.t) / 1000))}초 전
                </span>
                <b>{e.name}</b>
                {/* 파티원이 누른 것과 방장이 누른 것을 갈라 봅니다 — 안 그러면 "내가 저걸 눌렀나?"가 됩니다 */}
                {e.kind === "confess" && (
                  <span className="gs-press-conf">{e.n < 0 ? "자수 정정" : "자수"}</span>
                )}
                <i>{e.item}</i>
                <u className={e.delta < 0 ? "dn" : undefined}>
                  {(e.delta > 0 ? "+" : "−") + man(Math.abs(e.delta))}
                </u>
                <button
                  className="gs-press-x"
                  onClick={() => cancelEntry(e)}
                  aria-label={(e.name || "이 줄") + " " + (e.item || "항목") + " 취소"}
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {toast && (
        <div className="gs-toast" role="status" key={toast.t}>
          {toast.msg}
        </div>
      )}
      {ask && (
        <Confirm
          ask={ask}
          onCancel={() => {
            ask.onCancel?.();
            setAsk(null);
          }}
          onDone={() => setAsk(null)}
        />
      )}
      {share !== null && (
        <TextShare
          text={share}
          copied={flash === "text"}
          onCopy={(v) => copy(v, "text")}
          onClose={() => setShare(null)}
        />
      )}
    </div>
  );
}

/* 파티원이 보는 룰렛. 고를 게 없으니 누를 것도 없고, 양도 대기 중이라는 것만 알려 줍니다.
   (아무 말도 없으면 화면이 멈춘 줄 압니다) */
function ViewSpinPanel({ pl }) {
  const sp = pl.sp;
  const steps = sp.steps || [];
  /* 릴도 원판과 같은 규칙으로 돕니다 — 여기만 '?' 로 멈춰 있으면 같은 판인데
     파티원 화면만 고장 난 것처럼 보입니다. 간격은 앱과 같은 식을 씁니다. */
  const [tk, setTk] = useState(0);
  const vFree = sp.phase === "free" || !!sp.whoFree;
  const vRoll = !!pl.rolling || pl.who === "roll";
  useEffect(() => {
    if (!vFree && !vRoll) return;
    const ms = spinRoll(sp);
    const t0 = Date.now();
    let id = null;
    const step = () => {
      setTk((v) => v + 1);
      if (vFree) {
        id = setTimeout(step, FACE_MS);
        return;
      }
      const el = Date.now() - t0;
      const gap = faceGap(el / ms);
      if (ms - el < gap * 1.35) return; // 마지막 한 칸은 결과가 차지합니다
      id = setTimeout(step, gap);
    };
    id = setTimeout(step, FACE_MS);
    return () => clearTimeout(id);
  }, [vFree, vRoll, pl.i, pl.who, sp.sid]);
  const seen = steps.slice(0, pl.i + (pl.rolling ? 0 : 1));
  const passSeen = seen.some((x) => x.k === PASS);
  const mult = seen.length ? seen[seen.length - 1].m || 1 : 1;
  const cur = steps[pl.i] || {};
  const pool = poolAt(
    sp.faces && sp.faces.length ? sp.faces : ROULETTE_KEYS,
    steps.map((x) => ({ k: x.k })),
    pl.i
  );
  const landIdx = Math.max(0, pool.indexOf(cur.k));
  const asWheel = {
    sid: sp.sid,
    faces: sp.faces,
    theme: sp.theme,
    w: sp.w,
    steps: steps.map((x) => ({ k: x.k, mult: x.m })),
    i: pl.i,
    rolling: pl.rolling,
    spd: sp.spd,
    /* 감속은 방장 것 (2026-09-07 고침) — 안 받던 동안 파티원 원판만 기본값으로 돌았습니다 */
    roll: sp.roll,
    /* 서기가 아직 안 멈춘 판이면 여기서도 끝없이 돕니다 — 이게 없으면 답도 없는데
       감속 곡선을 타서 파티원 화면만 혼자 멈춥니다 */
    phase: sp.phase,
  };
  return (
    <div className="gs-spinwrap gs-spinwrap-view">
      <div className={"gs-spin" + (passSeen ? " gs-spin-pick" : "")}>
        <div className="gs-spin-who">
          <b>{sp.who}</b>
          <span>{pl.who ? "누가 물까요?" : sp.item}</span>
        </div>
        <div className="gs-spin-stage">
          {pl.who && sp.look === "num" ? (
            <div className="gs-reel">
              <span className="gs-reel-line" />
              <b className="gs-reel-n side" />
              <b
                className={
                  "gs-reel-n big" +
                  (pl.who === "land" && String(sp.pass2.name).length > 3
                    ? " longer"
                    : pl.who === "land" && String(sp.pass2.name).length > 2
                    ? " long"
                    : "") +
                  (pl.who === "roll" ? " gs-spin-rolling" : " gs-spin-land")
                }
              >
                {pl.who === "land"
                  ? sp.pass2.name
                  : sp.pass2.faces[tk % sp.pass2.faces.length]}
              </b>
              <b className="gs-reel-n side" />
            </div>
          ) : pl.who ? (
            <SpinWheel
              spin={{
                sid: sp.sid + ":who",
                faces: sp.pass2.faces,
                theme: sp.theme,
                w: {},
                steps: sp.pass2.name ? [{ k: sp.pass2.name }] : [],
                i: 0,
                rolling: pl.who === "roll",
                phase: sp.whoFree ? "free" : "roll",
                spd: sp.spd,
              }}
              landed={!sp.whoFree && pl.who === "land" ? sp.pass2.name : null}
            />
          ) : sp.look === "wheel" ? (
            <SpinWheel spin={asWheel} landed={!pl.rolling ? faceLabel(cur.k) : null} />
          ) : (
            <div className="gs-reel">
              <span className="gs-reel-line" />
              <b className="gs-reel-n side">
                {pl.rolling ? "" : faceLabel(pool[(landIdx - 1 + pool.length) % pool.length])}
              </b>
              <b
                className={"gs-reel-n big" + (pl.rolling ? " gs-spin-rolling" : " gs-spin-land")}
                key={pl.rolling ? "r" + tk : "l"}
              >
                {pl.rolling ? faceLabel(pool[tk % pool.length]) : faceLabel(cur.k)}
              </b>
              <b className="gs-reel-n side">
                {pl.rolling ? "" : faceLabel(pool[(landIdx + 1) % pool.length])}
              </b>
            </div>
          )}
          {mult > 1 && !pl.rolling && <span className="gs-spin-mult">×{mult}</span>}
        </div>
        {/* 이번 판 트랙 — 본 판과 같은 5칸 */}
        <div className="gs-spin-trail">
          {Array.from({ length: Math.max(5, seen.length) }, (_, j) =>
            seen[j] ? (
              <span
                key={j}
                className={
                  "gs-spin-tchip" +
                  (seen[j].k === PASS ? " pass" : isMultKey(seen[j].k) ? " mult" : "")
                }
              >
                {faceLabel(seen[j].k)}
              </span>
            ) : (
              <span
                key={j}
                className={
                  "gs-spin-slot" +
                  (j === seen.length && (pl.rolling || pl.who === "roll") ? " next" : "")
                }
              />
            )
          )}
        </div>
        <span className="gs-spin-gone">
          {!pl.who && passGone(steps, pl.i) ? PASS_GONE_MSG : ""}
        </span>
        <div className="gs-spin-out">
          {pl.over && (
            <>
              <b>
                {sp.n}
                {mult > 1 ? " × " + mult : ""} = {man(sp.gold)}
              </b>
              <span className="gs-spin-ask">
                {sp.pass2
                  ? sp.pass2.name + "에게 넘어갔어요."
                  : sp.phase === "pick"
                  ? "양도권이 나왔어요. 서기가 넘길 사람을 고르는 중이에요."
                  : (sp.who || "이 사람") + josa(sp.who || "이 사람", "이", "가") + " 물어요."}
              </span>
            </>
          )}
        </div>
        {/* 파티원은 멈출 수 없습니다 — 서기가 멈추길 같이 기다리는 화면입니다 */}
      <span className="gs-spin-skip">
        {sp.phase === "free" ? "돌고 있어요" : ""}
      </span>
      </div>
    </div>
  );
}

/* 물리 룰렛. 바늘은 12시에 고정이고 원판이 돌아 당첨 칸이 그 아래로 옵니다.
   걸음이 바뀔 때마다 몇 바퀴 더 얹어서, 멈추는 순간이 정확히 그 면이 되게 합니다. */
function SpinWheel({ spin, landed }) {
  const all = spin.faces && spin.faces.length ? spin.faces : ["1"];
  const faces = poolAt(all, spin.steps || [], spin.i || 0);
  const theme = spin.theme === "vegas" ? "vegas" : "satin";
  const segs = wheelArcs(faces, spin.w, theme);
  const free = spin.phase === "free";
  const k = ((spin.steps || [])[spin.i] || {}).k;
  const seg = segs.find((x) => x.k === k) || segs[0];
  const discRef = useRef(null);
  const rotRef = useRef(0);
  const sidRef = useRef(null);
  const [showHit, setShowHit] = useState(false);
  useEffect(() => {
    if (landed == null) {
      setShowHit(false);
      return;
    }
    const t = setTimeout(() => setShowHit(true), spin.skipped ? 0 : 200);
    return () => clearTimeout(t);
  }, [landed, spin.skipped]);
  /* 회전을 직접 겁니다. requestAnimationFrame 은 배경 탭에서 안 돌아서,
     그걸 기다리면 원판이 그대로 서 있는 일이 생깁니다. 지금 각도를 못 박고
     강제로 한 번 계산시킨 뒤 목표를 주면 프레임을 안 기다려도 돕니다. */
  useEffect(() => {
    const el = discRef.current;
    if (!el) return;
    if (sidRef.current !== spin.sid) {
      sidRef.current = spin.sid;
      rotRef.current = 0;
    }
    /* 답이 없는 동안은 끝없이 등속으로 — CSS 애니메이션에 맡깁니다.
       transform 을 직접 쓰면 매 프레임 리렌더가 필요해서 표까지 무거워집니다. */
    if (free) {
      el.style.transitionProperty = "none";
      el.style.transform = "";
      el.classList.add("gs-wheel-free");
      return;
    }
    /* 멈추는 순간 — 돌던 각도를 그대로 이어받아야 튀지 않습니다.
       애니메이션이 만든 지금 각도를 행렬에서 읽어 옵니다. */
    const wasFree = el.classList.contains("gs-wheel-free");
    if (wasFree) {
      const m = new DOMMatrixReadOnly(getComputedStyle(el).transform);
      const deg = (Math.atan2(m.b, m.a) * 180) / Math.PI;
      el.classList.remove("gs-wheel-free");
      rotRef.current = (deg + 360) % 360;
    }
    const from = rotRef.current;
    /* 늘 칸 한가운데에 서면 짜인 것처럼 보입니다 — 칸 안에서 서는 자리를 흔듭니다.
       다만 가장자리는 피합니다. 경계에 걸치면 어느 칸인지 눈으로 못 가립니다.
       판 번호에서 나온 씨앗이라 서기 화면·파티원 화면·방송이 같은 자리에 섭니다. */
    const seed = seedOf(spin.sid + ":" + spin.i);
    const arc = Math.max(1, seg.to - seg.from);
    const off = (((seed >>> 7) % 1000) / 1000 - 0.5) * arc * 0.72;
    /* 이 자리가 바늘 밑으로 오는, 지금보다 앞에 있는 첫 각도 */
    const seat = from + ((((-(seg.mid + off) - from) % 360) + 360) % 360);
    if (spin.skipped) {
      /* 건너뛰기 — 굴러가던 회전을 그 자리에서 끊고 결과로 붙입니다.
         시간만 0으로 바꾸면 이미 시작된 회전은 안 멈춥니다. */
      el.style.transitionProperty = 'none';
      el.style.transform = 'rotate(' + seat.toFixed(2) + 'deg)';
      rotRef.current = seat;
      return;
    }
    /* 진짜 원판은 곡선 하나로, 등감속으로 섭니다 (2026-09-07).
       등감속이면 처음 속도가 평균의 딱 두 배라, 곡선의 처음 기울기를 2 에 맞추면
       돌던 속도와 이음매가 없습니다. 그 곡선은 y = 2t − t² 이고 3차 베지어로 딱 떨어집니다:
       (1/3, 2/3, 2/3, 1). 두 곡선을 이어 붙이면 그 이음매에서 속도가 툭 바뀌어
       고장 난 것처럼 보였습니다 — 그래서 곡선은 늘 하나입니다.
       바퀴 수는 감속에서 나옵니다 — 약하게 세울수록 오래 돌고 많이 돕니다. */
    const ms = spinRoll(spin);
    const v0 = (360 / FREE_MS) * ms; // 지금 속도로 계속 돌면 갈 거리
    /* 등감속이면 실제로 도는 거리는 그 절반입니다. 칸 자리에 앉히려고 한 바퀴 단위로
       스냅하는데, 그 어긋남(최대 반 바퀴)이 판마다 다르게 서는 맛이 됩니다 */
    const turns = Math.max(1, Math.round((v0 / 2 - (seat - from)) / 360));
    const target = seat + turns * 360;
    const D = Math.max(1, target - from);
    /* 스냅 때문에 거리가 v0/2 에서 조금 어긋납니다. 그만큼 처음 기울기 s0 도 2 에서
       벗어나므로, 곡선의 x1 을 s0 에 맞춰 다시 잡습니다 — 그래야 돌던 속도에서
       그대로 이어집니다. y1 은 2/3 로 두므로 1 을 넘어 되감길 일이 없습니다. */
    const s0 = v0 / D;
    el.style.transitionProperty = 'none';
    el.style.transform = 'rotate(' + from.toFixed(2) + 'deg)';
    void el.offsetWidth;
    el.style.transitionProperty = 'transform';
    const x1 = Math.min(0.9, Math.max(0.1, 0.667 / s0));
    el.style.transitionTimingFunction = wasFree
      ? 'cubic-bezier(' + x1.toFixed(3) + ',.667,.667,1)'
      : /* 멈춰 있다 다시 도는 판 — 붙었다가 같은 성격으로 늘어지며 섭니다 */
        'cubic-bezier(.35,0,.28,1)';
    el.style.transitionDuration = ms + 'ms';
    el.style.transform = 'rotate(' + target.toFixed(2) + 'deg)';
    rotRef.current = target;
  }, [spin.sid, spin.i, spin.skipped, free]);
  const layers = wheelLayers(wheelStops(segs, theme), theme);
  return (
    <div className="gs-wheel">
      <div
        ref={discRef}
        className="gs-wheel-disc"
        style={{ background: layers }}
      >
        {/* 어느 칸이 무엇인지 — 진짜 룰렛처럼 칸을 따라 바깥으로 뻗게 적습니다 */}
        {segs.map((x) => (
          <span
            key={x.k}
            className={"gs-wheel-lab" + (x.k === PASS || isMultKey(x.k) ? " sp" : "")}
            style={{ transform: "rotate(" + x.mid.toFixed(2) + "deg)" }}
          >
            <i>{faceLabel(x.k)}</i>
          </span>
        ))}
      </div>
      {/* 중앙 허브 — 축은 늘 있고, 멈추면 그 안에 값이 뜹니다 */}
      <span className="gs-wheel-hub">
        {landed != null && showHit ? (
          <b
            className={"gs-wheel-hubv" + (String(landed).length > 2 ? " long" : "")}
            key={spin.i}
          >
            {landed}
          </b>
        ) : (
          <b className="gs-wheel-hubq">?</b>
        )}
      </span>
      <div className="gs-wheel-pin" />
    </div>
  );
}

/* 도는 중에 보여 주는 판. 결과는 이미 정해져 있고 여기서는 순서대로 보여 주기만 합니다.
   면이 바뀌는 건 tick 을 받아 돌아가는 글자뿐입니다. */
function SpinPanel({ spin, onStop, onSkip, onPickSelf }) {
  /* free — 아직 답이 없는 채로 도는 중입니다. 아래 계산들은 답이 있어야 하는 것이라
     이 상태에서는 빈 값으로 두고, 화면은 "돌고 있다 + 멈춰라"만 보여 줍니다.
     사람 원판(양도권 뒤)도 같은 상태를 씁니다 — 누가 물지도 STOP 때 뽑습니다. */
  const free = spin.phase === "free" || !!spin.whoFree;
  const cur = (spin.steps || [])[spin.i] || {};
  /* 릴과 돌림 글자는 이 판의 실제 면 목록에서 뽑습니다 — 기본 목록으로 돌리면
     면을 고친 룰렛에서 없는 면이 스쳐 지나갑니다 */
  const pool = poolAt(
    spin.faces && spin.faces.length ? spin.faces : ROULETTE_KEYS,
    spin.steps || [],
    spin.i
  );
  const rolling = free || spin.rolling;
  const idx = rolling
    ? spin.tick % pool.length
    : Math.max(0, pool.indexOf(cur.k));
  const shown = rolling ? pool[idx] : cur.k;
  const prevK = pool[(idx - 1 + pool.length) % pool.length];
  const nextK = pool[(idx + 1) % pool.length];
  const whoOn = spin.pass2 && (spin.phase === "who" || spin.target);
  /* 사람 원판도 답이 없는 동안은 자유 회전입니다 */
  const whoFree = !!spin.whoFree;
  /* 이번 판에 이미 나온 면들 — 도는 중인 면은 아직 안 나왔으니 뺍니다 */
  const chips = (spin.steps || []).slice(0, spin.i + (rolling ? 0 : 1));
  const gold = spin.res ? Math.round(spin.priceG * spin.res.count) : 0;
  const picking = spin.phase === "pick";
  const done = spin.phase === "done";
  /* 자리를 차지하지 않게 화면에 띄웁니다 — 표가 밀리면 누르던 칸이 달아납니다.
     도는 동안에는 뒤를 덮어 막고, 양도를 고를 때는 덮개를 걷어 표를 누르게 합니다. */
  return (
    <div
      /* 멈추기도 건너뛰기도 버튼으로만 합니다 — 아무 데나 눌러서 넘어가면
         화면을 스쳐 지나가는 손짓에도 판이 끝나 버립니다 */
      className={"gs-spinwrap" + (picking ? " gs-spinwrap-pick" : "")}
    >
    <div className={"gs-spin" + (picking ? " gs-spin-pick" : "")}>
      <div className="gs-spin-who">
        <b>{spin.who || "이름 없음"}</b>
        <span>
          {spin.pass2 && (spin.phase === "who" || spin.target)
            ? "누가 물까요?"
            : spin.item || "룰렛"}
        </span>
      </div>
      <div className="gs-spin-stage">
        {whoOn && spin.look === "num" ? (
          /* 숫자만 모드는 사람도 릴로 — 이름이 이웃과 함께 스칩니다 */
          (() => {
            const nm = spin.pass2.faces;
            /* 답이 없는 동안도 도는 중으로 칩니다 — 아니면 빈 이름을 띄웁니다 */
            const wroll = spin.whoRolling || whoFree;
            const wi = wroll
              ? spin.tick % nm.length
              : Math.max(0, nm.indexOf(spin.pass2.name));
            const cur2 = wroll ? nm[wi] : spin.pass2.name;
            return (
              <div className="gs-reel">
                <span className="gs-reel-line" />
                <b className="gs-reel-n side">{nm[(wi - 1 + nm.length) % nm.length]}</b>
                <b
                  className={
                    "gs-reel-n big" +
                    (String(cur2).length > 3 ? " longer" : String(cur2).length > 2 ? " long" : "") +
                    (wroll ? " gs-spin-rolling" : " gs-spin-land")
                  }
                  key={wroll ? "w" + spin.tick : "wl"}
                >
                  {cur2}
                </b>
                <b className="gs-reel-n side">{nm[(wi + 1) % nm.length]}</b>
              </div>
            );
          })()
        ) : whoOn ? (
          <SpinWheel
            spin={{
              sid: spin.sid + ":who",
              faces: spin.pass2.faces,
              theme: spin.theme,
              w: {},
              /* 답이 없으면 걸음도 없습니다 — 원판은 끝없이 돕니다 */
              steps: spin.pass2.name ? [{ k: spin.pass2.name }] : [],
              i: 0,
              rolling: !!spin.whoRolling,
              phase: whoFree ? "free" : "roll",
              spd: spin.spd,
              /* 사람 원판도 방장의 감속으로 (2026-09-07 고침) — 안 실어서 기본값으로 혼자 돌았습니다 */
              roll: spin.roll,
              skipped: spin.skipAt === "who",
            }}
            landed={!whoFree && !spin.whoRolling ? spin.pass2.name : null}
          />
        ) : spin.look === "wheel" && !picking ? (
          <SpinWheel
            spin={{ ...spin, skipped: spin.skipAt === spin.i }}
            landed={!spin.rolling ? faceLabel(cur.k) : null}
          />
        ) : (
          <div className="gs-reel">
            <span className="gs-reel-line" />
            <b className="gs-reel-n side">{faceLabel(prevK)}</b>
            <b
              className={
                "gs-reel-n big" + (spin.rolling ? " gs-spin-rolling" : " gs-spin-land")
              }
              key={spin.rolling ? "r" + spin.tick : "l" + spin.i}
            >
              {faceLabel(shown)}
            </b>
            <b className="gs-reel-n side">{faceLabel(nextK)}</b>
            <span className="gs-reel-notch l" />
            <span className="gs-reel-notch r" />
          </div>
        )}
        {(cur.mult || 1) > 1 && !spin.rolling && (
          <span className="gs-spin-mult">×{cur.mult || 1}</span>
        )}
      </div>
      {/* 이번 판 트랙 — 빈 슬롯 5개가 판 시작부터 있고 나온 면이 왼쪽부터 채웁니다.
         슬롯이 미리 있고 칩과 너비가 같아서, 무엇이 채워져도 아무것도 안 밀립니다.
         도는 동안에는 다음에 채워질 슬롯이 깜빡입니다. */}
      <div className="gs-spin-trail">
        {Array.from({ length: Math.max(5, chips.length) }, (_, j) =>
          chips[j] ? (
            <span
              key={j}
              className={
                "gs-spin-tchip" +
                (chips[j].k === PASS ? " pass" : isMultKey(chips[j].k) ? " mult" : "")
              }
            >
              {faceLabel(chips[j].k)}
            </span>
          ) : (
            <span
              key={j}
              className={
                "gs-spin-slot" +
                (j === chips.length &&
                (spin.rolling || (spin.phase === "who" && spin.whoRolling))
                  ? " next"
                  : "")
              }
            />
          )
        )}
      </div>
      <span className="gs-spin-gone">
        {!(spin.pass2 && (spin.phase === "who" || spin.target)) &&
        passGone(spin.steps, spin.i)
          ? PASS_GONE_MSG
          : ""}
      </span>

      {/* 결과 자리는 처음부터 잡아 둡니다 — 나중에 생기면 판이 늘어나 눈이 튑니다 */}
      <div
        className={
          "gs-spin-out" +
          (picking || done ? "" : " gs-spin-out-wait") +
          /* STOP 의 파동이 이 칸 밖으로 퍼집니다 — 결과가 없는 동안만 열어 둡니다 */
          (free ? " gs-spin-out-free" : "")
        }
      >
        {/* STOP 은 결과가 들어올 그 자리에 섭니다 — 따로 두면 누르는 순간 버튼이
            사라지면서 아래가 통째로 올라옵니다. 자리는 이미 잡혀 있으니 안 밀립니다. */}
        {free && (
          <button type="button" className="gs-spin-stop" onClick={onStop} autoFocus>
            STOP!
          </button>
        )}
        {!free && !(picking || done) && (
          <span className="gs-spin-status">
            {/* STOP 을 누른 뒤에는 답이 이미 정해져 있습니다 — 그때도 "뽑는 중"이라고
                하면 아직 안 정해진 것처럼 읽혀서, 하는 일 그대로 적습니다 */}
            {"멈추는 중이에요"}
          </span>
        )}
        {(picking || done) && (
          <>
          <b>
              {faceLabel(String(spin.res.n))}
              {spin.res.mult > 1 ? " ×" + spin.res.mult : ""} ={" "}
              {man(spin.out ? spin.out.gold : gold)}
              {spin.out && spin.out.raw !== spin.out.gold && <em>벌금까지만</em>}
          </b>
            {picking ? (
              <span className="gs-spin-ask">
                양도권이 나왔어요. <b>이 벌금을 넘길 사람의 줄</b>을 누르세요.{" "}
                <button className="gs-spin-self" onClick={onPickSelf}>
                  본인이 물기
                </button>
              </span>
            ) : (
              <span className="gs-spin-ask">
              {spin.target && spin.pass2
                ? spin.pass2.name + "에게 넘어갔어요."
                : (spin.who || "이 사람") + josa(spin.who || "이 사람", "이", "가") + " 물어요."}
            </span>
            )}
            <span className="gs-spin-delta">
              {spin.out && (
                <>
                  <b>{spin.out.name}</b> {man(spin.out.after - spin.out.gold)}{" "}
                  <span className={spin.out.gold >= 0 ? "up" : "dn"}>
                    → {man(spin.out.after)}
                  </span>
                </>
              )}
            </span>
          </>
        )}
      </div>
      {/* STOP 과 같은 자리, 같은 규칙 — 높이를 고정해서 상태가 바뀌어도 안 밀립니다 */}
      <div className="gs-spin-act">
        {free ? (
          <span className="gs-spin-skip">저절로 멈추지 않아요 — 눌러야 멈춰요</span>
        ) : picking ? (
          <span className="gs-spin-skip">줄을 누르면 그 사람에게 붙어요</span>
        ) : (
          <button type="button" className="gs-spin-skipbtn" onClick={onSkip}>
            {done ? "닫기" : "건너뛰기"}
          </button>
        )}
      </div>
    </div>
    </div>
  );
}

/* 눈 — 켜짐과 꺼짐 두 모양 */
function Eye({ on }) {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
      <g fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
        {on ? (
          <>
            <path d="M1.4 8S3.9 3.6 8 3.6 14.6 8 14.6 8 12.1 12.4 8 12.4 1.4 8 1.4 8Z" />
            <circle cx="8" cy="8" r="2.1" />
          </>
        ) : (
          <>
            <path d="M2.6 5.4C1.9 6.3 1.4 8 1.4 8s2.5 4.4 6.6 4.4c1 0 1.9-.2 2.7-.6" />
            <path d="M13 10.3c1.1-1.2 1.6-2.3 1.6-2.3S12.1 3.6 8 3.6c-.7 0-1.3.1-1.9.3" />
            <path d="M2.2 2.2l11.6 11.6" />
          </>
        )}
      </g>
    </svg>
  );
}

/* 방송에 나갈 열 고르기 — 예시 표가 곧 스위치입니다. 열 위의 눈을 누르면 그 열에
   빗금이 덮여, 켜 보고 OBS 로 건너가 확인하는 수고 없이 무엇이 빠지는지 그 자리에서 봅니다.
   순위·이름에는 눈이 없습니다 — 판을 판으로 만드는 뼈대라 끄면 남는 게 없습니다.
   항목 열은 예전에 한 덩어리로만 껐는데, 어느 항목을 방송에 띄울지는 서기가 정하는 게
   맞다고 보고 열마다 풀었습니다. */
function OvColsPreview({ cols, isOff, sumOn, netOn, slide, onItem, onKey }) {
  const [hint, setHint] = useState(null);
  /* 예시 숫자 — 실제 횟수가 아니라 "이 열이 이렇게 보인다"를 위한 자리표시입니다 */
  const EX = [
    { r: 1, n: "로마러", g: "13만", d: "−6.4만", neg: 1, c: [2, 1, 3], m: "▲1" },
    { r: 2, n: "조이냥", g: "9만", d: "−2.4만", neg: 1, c: [1, 1, 1], m: "" },
    { r: 3, n: "하늘", g: "3만", d: "+3.6만", neg: 0, c: [0, 0, 1], m: "▼1" },
  ];
  const zones = [
    ...cols.map((c, i) => ({
      k: "i" + c.id,
      label: (c.name || "").trim() || "항목",
      on: !isOff(c.id),
      why: "이 항목을 몇 번 했는지",
      hit: () => onItem(c.id),
      val: (ri) => EX[ri].c[i % 3], // 0회도 0으로 — 흐리게만 (2026-09-06 사용자: 비워 두지 않는다)
      cls: "gs-ovp-c",
    })),
    {
      k: "sum",
      label: "합계",
      head: "25만",
      on: sumOn,
      why: "그 사람이 낸 벌금 총액",
      hit: () => onKey("sum"),
      val: (ri) => EX[ri].g,
      cls: "gs-ovp-g",
    },
    {
      k: "net",
      label: "순액",
      on: netOn,
      why: "받을 몫에서 낸 벌금을 뺀 값 (파랑은 받고, 빨강은 내요)",
      hit: () => onKey("net"),
      val: (ri) => EX[ri].d,
      cls: "gs-ovp-d",
    },
  ];
  /* 격자 자리는 전부 못 박습니다 — 덮개(zone)가 표 위에 겹치는 격자라
     자동 배치에 맡기면 덮개가 칸을 밀어냅니다 */
  const at = (c, r, ce, re) => ({
    gridColumn: ce ? c + "/" + ce : String(c),
    gridRow: re ? r + "/" + re : String(r),
  });
  /* 슬라이드 모드 미리보기 (2026-09-06 사용자 확정) — 합계 자리에서 항목·순액이 번갈아 나오는 것을 2초 간격으로 돌려 보여 줍니다.
     끈 항목은 돌지 않아서, 눈을 끄면 그 자리가 빠지는 게 바로 보입니다. 합계는 늘 도는 자리라 눈이 없습니다 */
  const cyc = slide ? zones.filter((z) => z.k === "sum" || z.on) : [];
  const [ph, setPh] = useState(0);
  useEffect(() => {
    if (!slide || cyc.length < 2) return;
    const t = setInterval(() => setPh((p) => p + 1), 2000);
    return () => clearInterval(t);
  }, [slide, cyc.length]);
  if (slide) {
    const cur = cyc[ph % Math.max(1, cyc.length)] || zones.find((z) => z.k === "sum");
    const toggles = zones.filter((z) => z.k !== "sum");
    return (
      <div className="gs-ovprev gs-ovprev-slide" aria-label="방송 화면 예시">
        <div
          className="gs-ovp gs-ovp-slide"
          style={{ gridTemplateColumns: "16px 20px minmax(52px,1fr) minmax(76px,auto)", gridTemplateRows: "repeat(6, auto)" }}
        >
          <span className="gs-ovp-band gs-ovp-always" style={at(1, 1, 4)}>
            항상 나와요
          </span>
          <span className="gs-ovp-band gs-ovp-cyc" style={at(4, 1)}>
            {toggles.map((z) => (
              <button
                key={z.k}
                className={"gs-ovp-eye gs-ovp-eyel" + (z.on ? "" : " off")}
                onClick={z.hit}
                aria-pressed={z.on}
                title={z.why}
                aria-label={z.label + (z.on ? " 빼기" : " 넣기")}
              >
                <Eye on={z.on} />
                <span>{z.label}</span>
              </button>
            ))}
          </span>
          <span className="gs-ovp-cell gs-ovp-title" style={at(1, 2, 4)}>
            벌금 순위
          </span>
          <span key={"h" + ph} className={"gs-ovp-cell gs-ovp-h gs-ovp-sl" + (cur.k === "sum" ? " gs-ovp-g" : "")} style={at(4, 2)}>
            {cur.head || cur.label}
          </span>
          <span className="gs-ovp-rule" style={at(1, 3, 5)} />
          {EX.map((x, ri) => {
            const v = cur.val(ri);
            return (
              <Fragment key={x.r}>
                <span className={"gs-ovp-cell gs-ovp-rank" + (ri === 0 ? " top" : "")} style={at(1, 4 + ri)}>
                  {x.r}
                </span>
                <span className={"gs-ovp-cell gs-ovp-mv" + (x.m[0] === "▲" ? " up" : x.m ? " down" : "")} style={at(2, 4 + ri)}>
                  {x.m}
                </span>
                <span className={"gs-ovp-cell gs-ovp-nm" + (ri === 0 ? " top" : "")} style={at(3, 4 + ri)}>
                  {x.n}
                </span>
                <span
                  key={"v" + ph}
                  className={"gs-ovp-cell gs-ovp-sl " + cur.cls + (v ? "" : " gs-ovp-z") + (cur.k === "net" ? (x.neg ? " neg" : " pos") : "")}
                  style={at(4, 4 + ri)}
                >
                  {v}
                </span>
              </Fragment>
            );
          })}
        </div>
      </div>
    );
  }
  return (
    <div className="gs-ovprev" aria-label="방송 화면 예시">
      <div
        className="gs-ovp"
        style={{
          gridTemplateColumns:
            "16px 20px minmax(52px,1fr) repeat(" + zones.length + ", minmax(40px,auto))",
          gridTemplateRows: "repeat(6, auto)",
        }}
      >
        <span className="gs-ovp-band gs-ovp-always" style={at(1, 1, 4)}>
          항상 나와요
        </span>
        {zones.map((z, i) => (
          <span className="gs-ovp-band" key={z.k} style={at(4 + i, 1)}>
            <button
              className={"gs-ovp-eye" + (z.on ? "" : " off")}
              onClick={z.hit}
              onMouseEnter={() => setHint(z)}
              onMouseLeave={() => setHint(null)}
              onFocus={() => setHint(z)}
              onBlur={() => setHint(null)}
              aria-pressed={z.on}
              title={z.label}
              aria-label={z.label + (z.on ? " 숨기기" : " 보이기")}
            >
              <Eye on={z.on} />
            </button>
          </span>
        ))}

        {/* 제목은 이름 열이 아니라 판 왼쪽 끝에서 — 방송 화면과 같은 자리입니다 */}
        <span className="gs-ovp-cell gs-ovp-title" style={at(1, 2, 4)}>
          벌금 순위
        </span>
        {zones.map((z, i) => (
          <span
            key={z.k}
            className={"gs-ovp-cell gs-ovp-h " + z.cls + (z.on ? "" : " gs-ovp-dim")}
            style={at(4 + i, 2)}
          >
            {z.head || z.label}
          </span>
        ))}
        <span className="gs-ovp-rule" style={at(1, 3, zones.length + 4)} />

        {EX.map((x, ri) => (
          <Fragment key={x.r}>
            <span
              className={"gs-ovp-cell gs-ovp-rank" + (ri === 0 ? " top" : "")}
              style={at(1, 4 + ri)}
            >
              {x.r}
            </span>
            {/* 순위 변동 — 방송에서는 순위가 바뀐 뒤 잠깐 떴다 사라집니다.
                늘 자리를 차지하는 열이라 예시에도 그대로 둡니다 */}
            <span
              className={"gs-ovp-cell gs-ovp-mv" + (x.m[0] === "▲" ? " up" : x.m ? " down" : "")}
              style={at(2, 4 + ri)}
            >
              {x.m}
            </span>
            <span
              className={"gs-ovp-cell gs-ovp-nm" + (ri === 0 ? " top" : "")}
              style={at(3, 4 + ri)}
            >
              {x.n}
            </span>
            {zones.map((z, i) => {
              const v = z.val(ri);
              return (
                <span
                  key={z.k}
                  className={
                    "gs-ovp-cell " +
                    z.cls +
                    (v ? "" : " gs-ovp-z") +
                    (z.k === "net" ? (x.neg ? " neg" : " pos") : "") +
                    (z.on ? "" : " gs-ovp-dim")
                  }
                  style={at(4 + i, 4 + ri)}
                >
                  {v}
                </span>
              );
            })}
          </Fragment>
        ))}

        {zones.map((z, i) => (
          <span
            key={z.k}
            className={
              "gs-ovp-zone" +
              (z.on ? "" : " gs-ovp-dead") +
              (hint && hint.k === z.k && z.on ? " gs-ovp-hi" : "")
            }
            style={at(4 + i, 2, null, 7)}
          />
        ))}
      </div>
    </div>
  );
}

/* 룰렛 설정 — 면마다 몇 골드인지와 비율을 보여 줍니다. 비율은 "몇 칸을 차지하는가"라
   합이 얼마든 상관없고, 그 비율대로 나옵니다. */
/* 면과 비율의 실시간 미리보기 — 본 원판과 같은 규칙(테마·분리선·방사 라벨)으로 그립니다 */
function WheelPreview({ faces, weights, theme }) {
  const segs = wheelArcs(faces, weights, theme);
  return (
    <div className="gs-rc-pv">
      <div
        className="gs-rc-pvdisc"
        style={{ background: wheelLayers(wheelStops(segs, theme), theme) }}
      >
        {segs.map((x) => (
          <span
            key={x.k}
            className="gs-rc-pvlab"
            style={{ transform: "rotate(" + x.mid.toFixed(2) + "deg)" }}
          >
            <i>{faceLabel(x.k)}</i>
          </span>
        ))}
      </div>
      <span className="gs-rc-pvhub" />
    </div>
  );
}

function RouletteCfg({ col, unitLabel, theme, onW, onPass, onPassSelf, onToggleFace, onAddFace, onDelFace, onOrder, onReset, onClose }) {
  const [newFace, setNewFace] = useState("");
  const [addKind, setAddKind] = useState("n"); // n 더하기 · x 곱하기 · m 빼기
  const [dragK, setDragK] = useState(null);
  const [showEx, setShowEx] = useState(false);
  const w = weightsOf(col);
  const keys = facesOf(col);
  /* 친 수 하나로 두 가지 면을 만듭니다 — 버튼에 생길 면을 그대로 적어 둡니다 */
  /* 음수 면을 받습니다 — 0 은 아무 일도 안 하는 면이라 그대로 막습니다 */
  const v = Math.abs(Math.trunc(num(newFace)));
  /* 드롭다운이 종류를 정합니다 — 만들어질 면 글쇠를 여기서 확정 */
  const addKey = addKind === "x" ? "x" + v : addKind === "m" ? "-" + v : String(v);
  const addOk = (addKind === "x" ? v > 1 : v > 0) && !keys.includes(addKey);
  const addDup = v > 0 && keys.includes(addKey);
  const tot = keys.reduce((a, k) => a + Math.max(0, num(w[k])), 0);
  const priceG = Math.round(goldOf(col.price));
  /* 켜져 있으면 실제 원판 순서 그대로(드래그로 옮길 수 있게), 꺼져 있으면
     다시 켤 단추가 보이게 맨 위에 자리만 지킵니다. */
  const rowKeys = keys.includes(PASS) ? keys : [PASS, ...keys];
  /* 한 판이 어떻게 흘러가는지 — 설명 대신 지금 설정 그대로 한 판을 그려 보입니다.
     제일 안 읽히는 건 "몇 번 도느냐" 라서 원판이 도는 횟수를 끝에 적습니다. */
  /* 1 은 예시로 약합니다 — 곱한 값이 단가와 같아서 "숫자만큼 곱한다"가 안 보입니다.
     2 이상을 먼저 찾고, 그런 면이 없을 때만 아무 숫자나 씁니다. */
  const liveNum = (k) => isNumKey(k) && Math.max(0, num(w[k])) > 0;
  const exFace =
    keys.find((k) => liveNum(k) && faceNum(k) > 1) ||
    keys.find((k) => liveNum(k) && faceNum(k) > 0) ||
    keys.find(liveNum);
  const ex = (() => {
    if (!keys.includes(PASS) || !exFace) return null;
    const [a, b] = EX_NAMES;
    const g = man(priceG * faceNum(exFace));
    const lab = faceLabel(exFace);
    const rnd = passMode(col) === "random";
    return {
      steps: [
        a + josa(a, "이", "가") + " 돌렸는데 양도권이 나왔어요",
        "양도권이 원판에서 빠지고 다시 돌아요 — 이번엔 " + lab,
        rnd
          ? "사람 원판을 한 번 더 돌려요 — " + b + josa(b, "이", "가") + " 걸렸어요"
          : "서기가 표에서 " + b + "의 줄을 눌러요",
        g + josa(g, "은", "는") + " " + b + josa(b, "이", "가") + " 물어요",
      ],
      foot: rnd
        ? "원판이 세 번 돌아요(양도권, 숫자, 사람) — " +
          (passSelf(col)
            ? "포함이라 " + a + "도 사람 원판에 있어요. 자기가 다시 걸릴 수 있어요."
            : "미포함이라 " + a + josa(a, "은", "는") + " 사람 원판에서 빠져요.")
        : "원판은 두 번 돌아요(양도권, 숫자) — 넘길 사람은 서기가 골라요.",
    };
  })();
  return (
    <InfoModal title={(col.name || "룰렛") + " 설정"} onClose={onClose} wide>
      <p className="gs-rc-note">
        1회 단가는 <b>{man(priceG)}</b>이에요. 나온 숫자만큼 곱해서 벌금이 붙어요.
        비율은 룰렛에서 차지하는 칸 수예요 — 합이 얼마든 상관없어요.
      </p>
      <h5 className="gs-rc-sec">양도권</h5>
      <div className={"gs-rc-look" + (keys.includes(PASS) ? "" : " off")}>
        <span>규칙</span>
        {[
          ["pick", "지정"],
          ["random", "랜덤"],
        ].map(([v, label]) => (
          <button
            key={v}
            className={"gs-rc-lookbtn" + (passMode(col) === v ? " on" : "")}
            disabled={!keys.includes(PASS)}
            onClick={() => onPass(v)}
          >
            {label}
          </button>
        ))}
        <em className="gs-rc-hint">
          {!keys.includes(PASS)
            ? "면과 비율에서 양도권을 켜면 쓸 수 있어요"
            : passMode(col) === "random"
            ? "사람 원판을 한 번 더 돌려 정해요"
            : "서기가 넘길 사람의 줄을 눌러요"}
        </em>
      </div>
      <div
        className={
          "gs-rc-look" +
          (passMode(col) === "random" && keys.includes(PASS) ? "" : " off")
        }
      >
        <span>본인 포함</span>
        {[
          [true, "포함"],
          [false, "미포함"],
        ].map(([v, label]) => (
          <button
            key={label}
            className={"gs-rc-lookbtn" + (passSelf(col) === v ? " on" : "")}
            disabled={passMode(col) !== "random" || !keys.includes(PASS)}
            onClick={() => onPassSelf(v)}
          >
            {label}
          </button>
        ))}
        <em className="gs-rc-hint">
          {passMode(col) !== "random"
            ? "랜덤일 때 정하는 값이에요"
            : passSelf(col)
            ? "돌린 사람도 후보에 들어가요"
            : "돌린 사람은 후보에서 빠져요"}
        </em>
      </div>
      {ex && (
        <div className="gs-rc-ex">
          <button
            className="gs-rc-exbtn"
            onClick={() => setShowEx((v) => !v)}
            aria-expanded={showEx}
          >
            {showEx ? "예시 닫기" : "지금 설정으로 예시 보기"}
          </button>
          {showEx && (
            <>
              <ol className="gs-rc-exlist">
                {ex.steps.map((t, i) => (
                  <li key={i}>{t}</li>
                ))}
              </ol>
              <p className="gs-rc-exfoot">{ex.foot}</p>
            </>
          )}
        </div>
      )}
      <h5 className="gs-rc-sec">면과 비율</h5>
      <div className="gs-rc-body">
        <div className="gs-rc-left">
          {/* 실물과 같은 규칙으로 그린 미리보기 — 비율·순서·테마가 그대로 반영됩니다 */}
          <WheelPreview faces={keys} weights={w} theme={theme} />
          <p className="gs-rc-pvnote">비율을 고치거나 순서를 끌면 여기에 바로 반영돼요.</p>
          {theme === "vegas" && (
            <p className="gs-rc-vegas">
              카지노 테마를 쓰는 중이에요 — 빨강·검정이 번갈아 칠해져서{" "}
              <b>색이 같은 면이 생겨요</b>. 면 구분은 글자로 해요.
            </p>
          )}
        </div>
        <table className="gs-rc">
        <thead>
          <tr>
            <th />
            <th className="gs-l">면</th>
            <th>비율</th>
            <th>확률</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rowKeys.map((k) => {
            const passOff = k === PASS && !keys.includes(PASS);
            const wv = Math.max(0, num(w[k]));
            const pct = passOff || tot <= 0 ? 0 : (wv / tot) * 100;
            const ci = keys.indexOf(k);
            return (
              <tr
                key={k}
                className={
                  (k === PASS || isMultKey(k) ? "gs-rc-sp" : "") +
                  (dragK === k ? " gs-rc-drag" : "")
                }
                draggable={!passOff}
                onDragStart={(e) => {
                  if (passOff) return;
                  setDragK(k);
                  e.dataTransfer.effectAllowed = "move";
                }}
                onDragOver={(e) => {
                  e.preventDefault();
                  if (!dragK || dragK === k || passOff) return;
                  /* 순서는 그 자리에서 바로 바꿉니다 — 끌면서 결과를 봅니다 */
                  const cur = keys.slice();
                  const from = cur.indexOf(dragK);
                  const to = cur.indexOf(k);
                  if (from < 0 || to < 0) return;
                  cur.splice(to, 0, cur.splice(from, 1)[0]);
                  onOrder(cur);
                }}
                onDragEnd={() => setDragK(null)}
              >
                <td className="gs-rc-grip" aria-hidden="true">
                  {passOff ? "" : "⠿"}
                </td>
                <td className="gs-l gs-rc-face">
                  <i
                    className="gs-rc-dot"
                    style={{
                      background: passOff
                        ? faceColor(PASS, 0, theme)
                        : faceColor(k, ci, theme),
                    }}
                  />
                  {faceLabel(k)}
                  {/* 특수면은 병기 없이 — 문장이라 칸에서 접힙니다. 설명은 표 밑에 있어요 */}
                  {k !== PASS && !isMultKey(k) && (
                    <em className="gs-rc-goldem">{man(priceG * faceNum(k))}</em>
                  )}
                </td>
                <td>
                  <NumInput
                    className="gs-in gs-rc-w"
                    value={String(wv)}
                    onChange={(v2) => onW(k, Math.max(0, num(v2)))}
                    aria-label={faceLabel(k) + " 비율"}
                  />
                </td>
                <td className="gs-rc-pct">{pct.toFixed(1)}%</td>
                <td>
                  {k === PASS ? (
                    <button
                      className={"gs-rc-onoff" + (passOff ? "" : " on")}
                      onClick={() => onToggleFace(PASS)}
                      aria-pressed={!passOff}
                    >
                      {passOff ? "끔" : "켬"}
                    </button>
                  ) : (
                    keys.length > 2 && (
                      <button className="gs-rc-del" onClick={() => onDelFace(k)} aria-label="이 면 빼기">
                        ×
                      </button>
                    )
                  )}
                </td>
              </tr>
            );
          })}
          {/* 유령 행 — 새 면은 생길 자리에서 만듭니다 */}
          <tr className="gs-rc-ghost">
            <td className="gs-rc-grip gs-rc-plus" aria-hidden="true">＋</td>
            <td className="gs-l" colSpan={3}>
              <select
                className="gs-rc-kind"
                value={addKind}
                onChange={(e) => setAddKind(e.target.value)}
                aria-label="면 종류"
              >
                <option value="n">더하기</option>
                <option value="x">곱하기</option>
                <option value="m">빼기</option>
              </select>{" "}
              <NumInput
                className="gs-in gs-rc-new"
                value={newFace}
                onChange={setNewFace}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && addOk) {
                    onAddFace(addKey, 1);
                    setNewFace("");
                  }
                }}
                aria-label="더할 수"
              />{" "}
              <button
                className="gs-rc-addbtn"
                disabled={!addOk}
                onClick={() => {
                  onAddFace(addKey, 1);
                  setNewFace("");
                }}
              >
                {addDup ? faceLabel(addKey) + " 은 이미 있어요" : "+ " + (v > 0 ? faceLabel(addKey) : "면") + " 추가"}
              </button>
            </td>
            <td />
          </tr>
        </tbody>
        </table>
      </div>
      <p className="gs-rc-note">
        <b>양도권</b>은 한 번 나오면 그 판에서 빠지고 다시 돌아요 — 그때 나온 숫자를
        다른 사람에게 넘겨요.
        <br />
        <b>×2</b> 등은 빠지지 않아서 연달아 나올 수 있어요.
        {keys.some((k) => faceNum(k) < 0) && (
          <>
            {" "}
            <b>빼기 면</b>은 나온 순간의 벌금에서 깎여요 — 0 밑으로는 안 내려가고, 남은
            몫은 사라져요.
          </>
        )}
      </p>
      <button className="gs-rc-reset" onClick={onReset}>
        기본 비율로 되돌리기
      </button>
    </InfoModal>
  );
}

/* 채팅 공유용 복사 — 모드에 따라 툴바에도, 메모장 머리에도 올라갑니다 */
function ChatCopyBtn({ line, flash, onCopy }) {
  return (
    <span className="gs-tip">
      <button
        className={"gs-btn gs-btn-ghost gs-copybtn" + (flash === "chat" ? " is-copied" : "")}
        onClick={onCopy}
        disabled={!line}
      >
        <span className="gs-copy-idle">
          채팅 공유용 복사
          <em className={line.length > CHAT_LIMIT ? "gs-over" : ""}>
            {line.length}/{CHAT_LIMIT}
          </em>
        </span>
        <span className="gs-copy-done">복사됨</span>
      </button>
      {/* 이 버튼은 카운터·메모장 둘 다 왼쪽 끝에 섭니다 — 오른쪽에 붙이면(gs-tip-r)
          툴팁이 버튼의 오른쪽 끝에서 왼쪽으로 뻗어 화면 밖으로 나갑니다 */}
      <span className="gs-tip-body gs-tip-l" role="tooltip">
        이름과 벌금을 <b>만 단위 한 줄</b>로 만들어요. 인게임 채팅 한도가 {CHAT_LIMIT}자라,
        넘치면 이름을 한 글자씩 줄여요.
      </span>
    </span>
  );
}

/* 카운터의 합계 칸 — 표시는 '45만'처럼 만 표기, 눌러서 고칠 땐 입력 단위(라디오) 기준.
   현재 값이 미리 채워져 나오므로 단위 해석이 화면에서 바로 배워집니다.
   blur/Enter 에 확정, Esc 는 버립니다. 차액은 기타 '조정'으로. */
function TotalEdit({ display, base, per, suffix, onCommit }) {
  const [draft, setDraft] = useState(null); // null = 안 고치는 중
  const esc = useRef(false);
  if (draft === null)
    return (
      <button
        className="gs-sumedit"
        onClick={() =>
          setDraft(base > 0 ? formatNumInput(String(+(base / per).toFixed(4))) : "")
        }
        aria-label={`합계 직접 수정 (${suffix})`}
      >
        {man(display)}
      </button>
    );
  return (
    <span className="gs-sumedit-wrap">
      <input
        className="gs-in gs-sumedit-in"
        value={draft}
        autoFocus
        inputMode="decimal"
        onFocus={(e) => e.target.select()}
        onChange={(e) => setDraft(formatNumInput(e.target.value))}
        onBlur={() => {
          if (!esc.current) onCommit(Math.round(num(draft) * per));
          esc.current = false;
          setDraft(null);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.target.blur();
          if (e.key === "Escape") {
            esc.current = true;
            e.target.blur();
          }
        }}
        aria-label={`합계 (${suffix})`}
      />
      <em className="gs-sumedit-unit">{suffix}</em>
    </span>
  );
}

/* 돌아가는 모습 고르개 — "원판 / 숫자만" 이라고 글자로만 두면 뭐가 다른지 안 보입니다.
   캡처 그림 대신 그 자리에서 그립니다 — 면과 비율이 바뀌어도 그림이 같이 따라옵니다. */
function SpinLookPicker({ value, theme, onPick, onTheme }) {
  /* 카드마다 그 테마의 실제 색·마감으로 미니 원판을 그립니다 */
  const disc = (th) =>
    wheelLayers(wheelStops(wheelArcs(ROULETTE_KEYS, ROULETTE_W, th), th), th);
  const wheelOn = value === "wheel";
  return (
    <div className="gs-slook" role="group" aria-label="룰렛 외형">
      {/* 기본이 원판이라 원판을 먼저 놓습니다 — 고르는 자리와 기본값이 어긋나면
          "왼쪽이 기본"이라는 흔한 읽기와 부딪힙니다 */}
      {[
        ["wheel", "원판", "칸이 도는 원판이에요"],
        ["num", "슬롯", "슬롯처럼 위아래로 스쳐요"],
      ].map(([v, label, hint]) => (
        <button
          key={v}
          className={"gs-slook-c" + (value === v ? " on" : "")}
          onClick={() => onPick(v)}
          aria-pressed={value === v}
        >
          <span className="gs-slook-art">
            {v === "wheel" ? (
              <span
                className="gs-slook-disc"
                style={{ background: disc(theme) }}
              />
            ) : (
              <span className="gs-slook-reel">
                <i className="gs-slook-reel-line" />
                <b className="gs-slook-reel-side">3</b>
                <b className="gs-slook-reel-mid">4</b>
                <b className="gs-slook-reel-side">5</b>
              </span>
            )}
          </span>
          <b>{label}</b>
          <em>{hint}</em>
        </button>
      ))}
      {/* 원판 테마 — 늘 떠 있고, 슬롯을 쓰는 동안엔 잠깁니다.
          숨겨 두면 "원판을 고르면 테마가 열린다"는 걸 알 길이 없습니다. */}
      <div className={"gs-slook-themes" + (wheelOn ? "" : " off")}>
        {[
          ["satin", "새틴 · 금박", "면마다 고유색 — 색으로 면을 구분해요"],
          ["vegas", "카지노", "빨강·검정이 번갈아 칠해져요 — 색이 같은 면이 생겨요"],
        ].map(([v, label, hint]) => (
          <button
            key={v}
            className={"gs-slook-c sm" + (theme === v && wheelOn ? " on" : "")}
            disabled={!wheelOn}
            onClick={() => onTheme(v)}
            aria-pressed={theme === v}
          >
            <span className="gs-slook-art">
              <span className="gs-slook-disc" style={{ background: disc(v) }} />
            </span>
            <b>{label}</b>
            <em>{hint}</em>
          </button>
        ))}
        <em className="gs-slook-hint">
          {wheelOn ? "" : "원판을 고르면 원판 테마를 고를 수 있어요"}
        </em>
      </div>
    </div>
  );
}

/* OBS로 공유 — 방은 명단마다 하나이고, 주소는 재발급 전까지 영구입니다.
   쓰기 권한은 이 브라우저에만 있고 어떤 주소에도 실리지 않습니다.
   평소 쓰는 것(켜기·복사)만 겉에 두고, 가끔 쓰는 것은 접어 둡니다. */
/* 프리셋 — 명단·항목·단가·수수료·입력 단위 묶음. 로비의 항목 카드에서 엽니다 (§3.4).
   불러오기는 로비의 항목과 자리를 바꿀 뿐이라 판을 닫지 않습니다. 같은 이름은 덮어써요. */
function PresetModal({ presets, onSave, onLoad, onDelete, onClose }) {
  const [name, setName] = useState("");
  const [savedTick, setSavedTick] = useState(false);
  return (
    <InfoModal title="프리셋" onClose={onClose}>
      <div className="gs-key">
        <p>
          지금 명단·항목·단가·수수료·입력 단위를 프리셋으로 남겨요.
          {" '불러오기'를 누르면 로비의 항목과 자리가 그 구성으로 바뀌어요."}
        </p>
        <div className="gs-obs-acts">
          <input
            className="gs-in gs-obs-claim gs-preset-name"
            value={name}
            placeholder="프리셋 이름 (예: 우리 공대)"
            onChange={(e) => setName(e.target.value)}
            aria-label="프리셋 이름"
          />
          <button
            className="gs-btn gs-btn-sm"
            disabled={!name.trim()}
            onClick={() => {
              if (onSave(name)) {
                setName("");
                setSavedTick(true);
                setTimeout(() => setSavedTick(false), 2000);
              }
            }}
          >
            {savedTick ? "저장했어요" : "지금 구성을 저장"}
          </button>
        </div>
        {presets.length === 0 ? (
          <p className="gs-key-foot">아직 프리셋이 없어요.</p>
        ) : (
          presets.map((x) => (
            <div className="gs-genrow" key={x.name}>
              <b>{x.name}</b>
              <span className="gs-genrow-meta">
                {(x.names || []).length}명 · 항목 {(x.cols || []).length}
              </span>
              <span className="gs-genrow-r">
                <button className="gs-btn gs-btn-sm" onClick={() => onLoad(x.name)}>
                  불러오기
                </button>
                <button
                  className="gs-x"
                  onClick={() => onDelete(x.name)}
                  aria-label={x.name + " 프리셋 지우기"}
                >
                  ×
                </button>
              </span>
            </div>
          ))
        )}
        <div className="gs-obs-acts" style={{ marginTop: 12 }}>
          <button className="gs-btn gs-btn-sm" onClick={onClose}>
            닫기
          </button>
        </div>
      </div>
    </InfoModal>
  );
}

/* 외형 — 오버레이 테마·방송 열·벌금 알림·룰렛 외형.
   창을 따로 두면 "주소는 여기, 생김새는 저기"로 갈려서 한 번에 못 끝냅니다.
   그래서 껍데기 없이 몸통만 내주고, 오버레이 공유 설정 창이 이걸 안에 답니다. */
function LookBody({ relay, putRelay, ovCols, isOff, sumOn, netOn, slideOn, onOvSlide, onOvItem, onOvKey }) {
  /* [테마 미리보기] 버튼은 폐지 (2026-09-05) — 카드 머리의 [오버레이 미리보기]가
     같은 일을 하고, 미리보기 문이 둘이면 뭐가 다른지부터 묻게 됩니다 */
  const pickLook = (lk) => putRelay({ ...relay, look: lk });
  return (
    <>
      {/* 주소 아래는 전부 생김새 — 한 단 굵은 제목으로 갈라 둡니다.
          안 그러면 주소 설정과 외형 설정이 한 덩어리로 흘러내려 어디까지가
          "주소를 만드는 일"인지 안 보입니다. */}
      <h3 className="gs-obs-sub">오버레이 외형 설정</h3>
      <div className="gs-obs-look gs-obs-look-first">
        <div className="gs-obs-lookhead">
          <h4>오버레이 테마</h4>
        </div>
        <LookPicker look={relay.look} onPick={pickLook} />
      </div>
      <div className="gs-obs-sec">
        {/* 항목 표시 방식 (2026-09-06 사용자 확정) — 슬라이드가 기본. 슬라이드는 항목 열과 순액을 늘어놓지 않고
            합계 자리에서 번갈아 보여 줘서 판이 절반 폭이 됩니다. 라벨 '항목 표시 방식'은 사용자 지정, 선택지 이름 '슬라이드'·'나란히'는 초안 */}
        <div className="gs-obs-lookhead">
          <h4 className="gs-obs-h">방송 화면에 넣을 열</h4>
          <div className="gs-modebar">
            <span className="gs-caplab">항목 표시 방식</span>
            <div className="gs-seg" role="group" aria-label="항목 표시 방식">
              <button className={slideOn ? "on" : ""} onClick={() => onOvSlide(true)}>
                슬라이드
              </button>
              <button className={slideOn ? "" : "on"} onClick={() => onOvSlide(false)}>
                나란히
              </button>
            </div>
          </div>
        </div>
        <OvColsPreview
          cols={ovCols}
          isOff={isOff}
          sumOn={sumOn}
          netOn={netOn}
          slide={slideOn}
          onItem={onOvItem}
          onKey={onOvKey}
        />
        {slideOn && (
          <p className="gs-unitnote gs-obs-note">
            합계 8초, 항목과 순액 4초씩 번갈아 나와요. 판이 좁아지니 OBS에서 소스 크기를 한 번 다시 맞춰 주세요.
          </p>
        )}
      </div>
      <div className="gs-obs-sec">
        {/* 켬·끔을 제목 옆에 둡니다 — 그림이 곧 그 설정의 결과라, 스위치가 그림 아래에
            있으면 무엇을 켜고 끄는지 다 읽은 뒤에야 압니다. '알림'이라는 라벨은
            제목이 이미 말하고 있어서 지웁니다. */}
        <div className="gs-obs-lookhead">
          <h4 className="gs-obs-h">오버레이 클릭 알림</h4>
          <div className="gs-rc-look">
            {[
              ["on", "켬"],
              ["off", "끔"],
            ].map(([v, label]) => (
              <button
                key={v}
                className={"gs-rc-lookbtn" + (fxOn(relay) === (v === "on") ? " on" : "")}
                onClick={() => putRelay({ ...relay, fx: v })}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        {/* 벌금표에서 칸을 눌렀을 때 방송 화면에 뜨는 그림 — 글로 설명하는 대신 보여 줍니다.
            끄면 카드가 없어지고 판만 남습니다. 카드에 가릴 것이 없으니 판도 또렷해집니다 —
            그 차이가 "끄면 이렇게 된다"를 말로 안 하고 보여 줍니다. */}
        <div
          className={"gs-fxprev" + (fxOn(relay) ? "" : " off")}
          aria-label={fxOn(relay) ? "클릭 알림 켠 모습" : "클릭 알림 끈 모습"}
        >
          <div className="gs-fxprev-bg">
            <span>1 로마러</span>
            <span>2 조이냥</span>
            <span>3 하늘</span>
          </div>
          {fxOn(relay) && (
            <div className="gs-fxprev-card">
              <b>로마러</b>
              <span>죽음 <em>+3만</em></span>
            </div>
          )}
        </div>
      </div>
      <div className="gs-obs-sec">
        <h4 className="gs-obs-h">룰렛 외형</h4>
        {/* 룰렛만 방장 것을 따릅니다 (2026-09-07 사용자 확정) — 원판·감속은 판이 시작될 때
            방장 설정이 얼려 실려서 파티원 화면과 방송이 다 같은 것을 봅니다. 그래서 여기서
            고른 값은 내가 방장인 판에서만 나갑니다. 나머지 외형은 계정마다 제각각입니다.
            문구 초안 */}
        <p className="gs-unitnote gs-obs-note">룰렛은 방장 것을 따라가요 — 내가 방장일 때만 적용돼요.</p>
        {/* 감속 (2026-09-05) — 끝에서 꼬리를 길게 끌어 긴장을 늘립니다. 다음 판부터 적용.
            자리는 룰렛 외형 머리 바로 아래 (2026-09-06 사용자 지적 — 원판 고르기 밑에 붙어 있으면 딴 설정처럼 보였다).
            (폐기 2026-09-06) `느긋하게는 끝에서 오래 미적여요.` — 사용자: 워딩이 별로 */}
        {/* 감속 = 프리셋 둘 + 슬라이더 (2026-09-07 사용자 확정). 슬라이더는 끝에서 미끄러지는 길이, 프리셋은 그 위의 두 자리 */}
        <div className="gs-modebar gs-easebar">
          <span className="gs-caplab">감속</span>
          <div className="gs-seg" role="group" aria-label="감속 프리셋">
            <button
              className={spinGlideOf(relay) === GLIDE_NORMAL ? "on" : ""}
              onClick={() => putRelay({ ...relay, spinGlide: GLIDE_NORMAL })}
            >
              보통
            </button>
            <button
              className={spinGlideOf(relay) === GLIDE_GENTLE ? "on" : ""}
              onClick={() => putRelay({ ...relay, spinGlide: GLIDE_GENTLE })}
            >
              느긋하게
            </button>
            {/* 슬라이더를 만지면 저절로 여기로 옵니다 — 누르는 건 표시일 뿐 값을 바꾸지 않습니다 (2026-09-07 사용자 확정) */}
            <button type="button" className={isPresetGlide(relay) ? "" : "on"} aria-pressed={!isPresetGlide(relay)}>
              직접
            </button>
          </div>
          <label className="gs-glide">
            <span className="gs-glide-l">짧게</span>
            <input
              type="range"
              min="0"
              max="100"
              step="1"
              value={spinGlideOf(relay)}
              onChange={(e) => putRelay({ ...relay, spinGlide: Number(e.target.value) })}
              aria-label="감속"
            />
            <span className="gs-glide-l">길게</span>
          </label>
          {/* 문구 초안 (2026-09-07) — (폐기 같은 날) `끝에서 미끄러지는 길이예요.`
              곡선 배분만 바꾸던 시절의 말이라, 감속 자체가 약해지는 지금과 안 맞습니다 */}
          <span className="gs-unitnote">천천히 감속할수록 오래 돌아요. 다음 판부터.</span>
        </div>
        <SpinLookPicker
          value={spinShape(relay)}
          theme={wheelTheme(relay)}
          onPick={(v) => putRelay({ ...relay, spinLook: v })}
          onTheme={(v) => putRelay({ ...relay, wheelTheme: v })}
        />
      </div>
    </>
  );
}
/* 계정 창 — 로그인과 가입이 한 창에 있습니다. 파티원이 이 창을 처음 보는 자리는
   초대를 눌러 들어온 대기실이라, 표를 가리지 않게 작은 창으로 띄웁니다.
   비밀번호는 여기서 선해시되고, 원문은 서버에 도착하지 않습니다. */
/* 계정 창. ctx 가 있으면 끼어든 것이라 "왜 묻는지"와 "누르면 무엇이 이어지는지"를
   밝힙니다. 없으면 헤더에서 스스로 연 것이라 제목과 버튼만 담백하게 둡니다. */
/* 문 셋 — 로그인 · 가입 · **게스트로 시작** (§3.11). 게스트는 닉 한 줄이면 끝이고,
   아이디·비밀번호가 없을 뿐 가입과 같은 계정이라 방송용 주소도 파티 참여도 그대로
   됩니다. 나중에 가입하면(upgrade) 주소·방·관계가 전부 따라옵니다.
   어느 문으로 열지는 들어온 자리가 정합니다 — 초대를 받고 온 사람에겐 게스트가,
   헤더의 [로그인]에는 로그인이 먼저 섭니다. */
function AuthModal({ tab, ctx, onDone, onClose }) {
  /* 대문은 랜딩입니다 (2026-09-05 확정) — 문 셋(게스트·가입·로그인)의 분기는 랜딩이
     전담하고, 서브 화면은 ← 로 돌아옵니다. "register" 로 열어도 랜딩부터 —
     어디서 열든 같은 첫 화면이라야 다음에 알아봅니다 (§3.11) */
  const [mode, setMode] = useState(tab === "login" ? "login" : tab === "guest" ? "guest" : "land");
  const [showAcct, setShowAcct] = useState(false); // 아이디를 만들면 뭐가 달라져요? (2026-09-06 오후)
  const [id, setId] = useState("");
  const [pw, setPw] = useState("");
  const [nick, setNick] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const idRef = useRef(null);
  useEffect(() => {
    idRef.current && idRef.current.focus();
  }, []);
  useEffect(() => {
    const onKey = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const guest = mode === "guest";
  const land = mode === "land";
  const title = land ? "시작하기" : guest ? "게스트로 시작" : mode === "login" ? "로그인" : "계정 만들기";
  const okId = /^[A-Za-z0-9]{4,20}$/.test(id.trim());
  const okNick = [...nick.trim()].length >= 2 && [...nick.trim()].length <= 3;
  const ready = guest ? okNick : okId && pw.length > 0 && (mode === "login" || okNick);

  const submit = async () => {
    if (!ready || busy) return;
    /* 게스트는 비밀번호가 없어 선해시도 없습니다 — crypto.subtle 이 없는 자리에서도
       열리는 유일한 문이라, 여기서 막지 않습니다 */
    if (!guest && !hasSubtle()) return setErr(SUBTLE_MSG);
    setBusy(true);
    setErr("");
    try {
      const r = guest
        ? await authApi.anon(nick.trim())
        : mode === "login"
        ? await authApi.login(id.trim().toLowerCase(), pw)
        : await authApi.register(id.trim().toLowerCase(), pw, nick.trim());
      /* via — 어느 문으로 끝냈는지. 이어서 할 일(after)이 "방금 만든 계정"과
         "돌아온 계정"을 갈라야 할 때 씁니다(예: 주소 안내는 새 계정에만) */
      onDone({ id: r.id, nick: r.nick, token: r.token, obsToken: r.obsToken, anon: guest, via: mode });
    } catch (e) {
      setErr(
        e && e.status === 409
          ? "이미 있는 아이디예요. 다른 아이디로 해주세요."
          : e.message || "실패했어요"
      );
    }
    setBusy(false);
  };

  return (
    <div className="gs-modal" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="gs-dialog" role="dialog" aria-modal="true" aria-label={title}>
        <div className="gs-auth-head">
          {!land && (
            <button
              className="gs-auth-back"
              onClick={() => {
                setErr("");
                setMode("land");
              }}
              aria-label="뒤로"
            >
              ←
            </button>
          )}
          <h3>{title}</h3>
          <button className="gs-x gs-dialog-x" onClick={onClose} aria-label="닫기">
            ×
          </button>
        </div>
        {land ? (
          /* 랜딩 — 카드 두 장이 문이고, 로그인은 발치의 조용한 줄입니다 (2026-09-05).
             게스트가 왼쪽: 처음 온 사람 대부분이 이 문으로 들어갑니다 */
          <>
            <div className="gs-auth-pick">
              <button
                className="gs-auth-pcard"
                onClick={() => {
                  setErr("");
                  setMode("guest");
                }}
              >
                <svg viewBox="0 0 20 20" width="24" height="24" aria-hidden="true">
                  <g fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="10" cy="6.6" r="3.1" />
                    <path d="M3.8 17c.8-3.6 3.1-5.5 6.2-5.5s5.4 1.9 6.2 5.5" />
                  </g>
                </svg>
                <b>게스트로 시작</b>
                <em>이 브라우저에 저장되는 계정으로 바로 시작해요.</em>
              </button>
              <button
                className="gs-auth-pcard"
                onClick={() => {
                  setErr("");
                  setMode("register");
                }}
              >
                <svg viewBox="0 0 20 20" width="24" height="24" aria-hidden="true">
                  <g fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="7" cy="13" r="3.4" />
                    <path d="m9.6 10.4 6.6-6.6M13.5 6.5l2.3 2.3M11.4 8.6l1.7 1.7" />
                  </g>
                </svg>
                <b>계정 만들기</b>
                <em>어느 컴퓨터에서든 로그인해 같은 주소와 파티를 그대로 써요.</em>
              </button>
            </div>
            {/* 둘의 차이는 여기서도 (2026-09-06 오후 사용자 확정) */}
            <p className="gs-auth-line">
              <button className="gs-auth-linkb" onClick={() => setShowAcct(true)}>
                아이디를 만들면 뭐가 달라져요?
              </button>
            </p>
            {showAcct && <AcctGuide onClose={() => setShowAcct(false)} />}
            <p className="gs-auth-line">
              이미 계정이 있어요 ·{" "}
              <button
                className="gs-auth-linkb"
                onClick={() => {
                  setErr("");
                  setMode("login");
                }}
              >
                로그인
              </button>
            </p>
          </>
        ) : !guest && !hasSubtle() ? (
          /* 비보안 컨텍스트에는 crypto.subtle 이 없습니다 — 선해시를 못 하니 입구를 닫습니다 */
          <p className="gs-auth-warn">{SUBTLE_MSG}</p>
        ) : (
        <>
        {/* 이 창이 왜 떴는지. 헤더에서 스스로 연 사람은 이유를 모르니, 계정이
            어디 쓰이는지와 "벌금 세는 데는 필요 없다"를 대신 적어 둡니다 */}
        <p className="gs-auth-why">
          {guest ? (
            /* 게스트 칸은 질문 하나입니다 — 이 화면의 유일한 입력이 주인공이어야
               합니다. 게스트가 뭘 할 수 있는지는 대문의 상자가 이미 말했습니다 */
            <>벌금판에 올라갈 이름을 정해 주세요.</>
          ) : mode === "register" ? (
            /* 가입을 권하는 이유를 먼저 말합니다 — 전에는 "? 로그인하면 어떤 게
               좋나요?" 링크 뒤에 숨어 있었습니다 */
            (ctx && ctx.why) || (
              <>
                계정이 있으면 <b>두 컴퓨터에서 같은 방송 주소</b>를 쓰고, <b>파티를 열어</b>{" "}
                파티원이 자기 벌금을 직접 세게 할 수 있어요.
              </>
            )
          ) : (
            /* 로그인에도 안내는 남습니다 — 헤더에서 스스로 연 사람은 이유를 모릅니다.
               "로그인을 왜 해야 하는데?"에 대한 답이고, 대문의 권유("만들면 얻는 것")와
               역할이 다릅니다: 이건 용도 설명 + "세는 데는 필요 없다"는 안심입니다.
               한 번 걷었다가 되돌렸습니다 — 겹말의 주범은 패널의 권유 덩어리였지
               이 안내가 아니었습니다 */
            (ctx && ctx.why) || (
              <>
                계정은 <b>파티</b>와 <b>내 방송용 주소</b>에 써요.
                <br />
                벌금을 세고 정산하는 데는 계정이 필요 없어요.
              </>
            )
          )}
        </p>
        {!guest && (
        <label className="gs-field">
          아이디
          <input
            ref={idRef}
            className="gs-in gs-in-field"
            value={id}
            placeholder="영문·숫자 4~20자"
            autoComplete="username"
            onChange={(e) => setId(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
          />
        </label>
        )}
        {!guest && (
        <label className="gs-field">
          비밀번호
          <input
            className="gs-in gs-in-field"
            type="password"
            value={pw}
            autoComplete={mode === "login" ? "current-password" : "new-password"}
            onChange={(e) => setPw(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
          />
        </label>
        )}
        {mode === "register" && (
          <label className="gs-field">
            닉네임 <span className="gs-field-hint">(2~3글자 — 벌금판에 이 이름으로 올라요)</span>
            <input
              className="gs-in gs-in-field gs-in-nickbig"
              value={nick}
              maxLength={3}
              onChange={(e) => setNick(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && submit()}
            />
          </label>
        )}
        {guest && (
          /* 유일한 입력이라 크게, 가운데에 (§3.11 — 목업 ⓑ) */
          <>
            <input
              className="gs-in gs-in-nickxl"
              value={nick}
              maxLength={3}
              autoFocus
              onChange={(e) => setNick(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && submit()}
              aria-label="닉네임"
            />
            <p className="gs-auth-nickhint">2~3글자 · 이 브라우저에 저장돼요</p>
          </>
        )}
        {mode === "register" && (
          <>
            {/* 경고 셋을 작은 한 덩어리로 — 세 문단으로 흩어 두면 폼과 버튼 사이가
                글자 벽이 됩니다. 문구는 §8 그대로, 지울 때 알려 줄 방법이 없어(이메일을
                안 받아서) 미리 적는 것도 그대로입니다 */}
            <p className="gs-auth-fine">
              비밀번호를 잊으면 되찾을 방법이 없어요. 다른 곳에서 쓰는 비밀번호는 쓰지 마세요.
              <br />
              1년 넘게 한 번도 안 쓰면 계정이 지워질 수 있어요.
            </p>
          </>
        )}
        {err && <p className="gs-obs-err">{err}</p>}
        <button className="gs-btn gs-authgo" onClick={submit} disabled={!ready || busy}>
          {busy
            ? "잠시만요…"
            : guest
            ? "시작하기"
            : mode === "login"
            ? (ctx && ctx.loginVerb) || "로그인"
            : (ctx && ctx.joinVerb) || "가입하기"}
        </button>
        {/* 다른 문으로 가는 링크는 서브 화면에 없습니다 — 분기는 랜딩(←)이 전담합니다.
            (폐기 2026-09-05) 가입 밑 게스트 상자와 "또는" 버튼 두 벌 — 랜딩 카드가
            같은 일을 합니다 */}
        </>
        )}
      </div>
    </div>
  );
}

/* 익명 계정에 아이디·비밀번호·닉네임을 붙이는 창 (§3-11).
   가입이 아니라 덧씌우기입니다 — 세션·방송용 주소·방·멤버십이 그대로라 다시 로그인하지 않습니다.
   그래서 "가입했더니 OBS를 다시 세팅해야 함"이 생기지 않습니다. */
function UpgradeModal({ nick: nick0, onRun, onDone, onClose }) {
  const [id, setId] = useState("");
  const [pw, setPw] = useState("");
  const [nick, setNick] = useState(nick0 && [...nick0].length <= 3 ? nick0 : "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const idRef = useRef(null);
  useEffect(() => {
    idRef.current && idRef.current.focus();
  }, []);
  useEffect(() => {
    const onKey = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const okId = /^[A-Za-z0-9]{4,20}$/.test(id.trim());
  const okNick = [...nick.trim()].length >= 2 && [...nick.trim()].length <= 3;
  const ready = okId && pw.length > 0 && okNick;

  const submit = async () => {
    if (!ready || busy) return;
    if (!hasSubtle()) return setErr(SUBTLE_MSG);
    setBusy(true);
    setErr("");
    try {
      await onRun(id.trim().toLowerCase(), pw, nick.trim());
      onDone();
      return;
    } catch (e) {
      /* 409 는 둘입니다 — 아이디가 이미 있거나(taken), 이미 정식 계정이거나(not anon) */
      setErr(
        e && e.status === 409
          ? e.code === "not anon"
            ? "이미 아이디가 있는 계정이에요. 창을 닫고 다시 눌러 주세요."
            : "이미 있는 아이디예요. 다른 아이디로 해주세요."
          : (e && e.message) || "실패했어요"
      );
    }
    setBusy(false);
  };

  return (
    <div className="gs-modal" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="gs-dialog" role="dialog" aria-modal="true" aria-label="아이디 만들기">
        <div className="gs-auth-head">
          {/* "정하기"는 한국 서비스에서 안 쓰는 말이라 "만들기"로 (§8, 2026-09-05) */}
          <h3>아이디 만들기</h3>
          <button className="gs-x gs-dialog-x" onClick={onClose} aria-label="닫기">
            ×
          </button>
        </div>
        {!hasSubtle() ? (
          <p className="gs-auth-warn">{SUBTLE_MSG}</p>
        ) : (
          <>
            {/* (폐기 2026-09-05) `파티원을 모으려면 아이디와 비밀번호를 정해야 해요…` — 게스트도
                파티를 열게 되면서 거짓이 됐다. 문구는 §8 초안 */}
            <p className="gs-auth-why">
              아이디를 정하면 다른 컴퓨터에서도 로그인해 같은 주소와 파티를 그대로 써요. 지금
              주소는 바뀌지 않아요.
            </p>
            <label className="gs-field">
              아이디
              <input
                ref={idRef}
                className="gs-in gs-in-field"
                value={id}
                placeholder="영문·숫자 4~20자"
                autoComplete="username"
                onChange={(e) => setId(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && submit()}
              />
            </label>
            <label className="gs-field">
              비밀번호
              <input
                className="gs-in gs-in-field"
                type="password"
                value={pw}
                autoComplete="new-password"
                onChange={(e) => setPw(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && submit()}
              />
            </label>
            <label className="gs-field">
              닉네임 <span className="gs-field-hint">(2~3글자 — 벌금판에 이 이름으로 올라요)</span>
              <input
                className="gs-in gs-in-field gs-in-nickbig"
                value={nick}
                maxLength={3}
                onChange={(e) => setNick(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && submit()}
              />
            </label>
            <p className="gs-auth-warn">
              비밀번호를 잊으면 되찾을 방법이 없어요.
              <br />
              다른 곳에서 쓰는 비밀번호는 쓰지 마세요.
            </p>
            <p className="gs-auth-note">1년 넘게 한 번도 안 쓰면 계정이 지워질 수 있어요.</p>
            {err && <p className="gs-obs-err">{err}</p>}
            <button className="gs-btn gs-authgo" onClick={submit} disabled={!ready || busy}>
              {busy ? "잠시만요…" : "정하기"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

/* 로비(대기실) — 헤더 아래를 통째로 덮습니다 (§3-3). 표를 펼쳐 놓으면 벌금표와 구분이
   안 돼서, 카드 넷으로 나눕니다: 신청 · 파티원 · 초대 링크 · 항목.
   항목은 지금 판에서 복사한 초안이고, 시작 전까지 지금 판은 건드리지 않습니다. */
/* 신청 한 줄 — [수락] 하나입니다. 자리는 앱이 정합니다: 로비에서는 빈 칸에 자동으로
   앉고(§3.2 ①~③), 판 도중에는 들어오는 본인이 자기 줄을 고릅니다. 방장이 자리를
   지정하는 [수락 ▾]는 폐지 — 방장이 남의 이름을 짐작해 앉힐 이유가 없습니다 */
/* ghost 는 로비에서 씁니다 — 그 화면의 채운 버튼은 [시작] 하나여야 해서(§3.1·§9-2)
   여기서는 무게를 낮춥니다. 금테 줄 자체가 이미 눈을 끕니다 */
function ReqRow({ req, ghost, onDeny, onApprove }) {
  return (
    <div className="gs-lbreq">
      <b>{req.nick || req.acct}</b>
      {/* 아이디는 여기서도 앞 두 글자만 — 이 화면도 통째로 방송에 잡힙니다 (§3.1) */}
      <span className="gs-lbreq-id">({req.acct.slice(0, 2) + "••••"})</span>
      {/* 내가 부른 사람인데 오는 사이 자리가 없어 내려앉았습니다 (§3.3) — 그냥 신청과
          갈라 말해야 방장이 "인원 수를 늘려야겠구나"로 바로 잇습니다 */}
      {/* 왜 기다리는지 (§3.3, 2026-09-05 표준화) — 자리가 없어서 / 내보냈던 사람 / 진행 중에 빈 줄이 없어서 */}
      <span className="gs-lbreq-why">
        {req.waiting
          ? "들어왔는데 빈 줄이 없어요"
          : req.kicked
          ? "내보냈던 사람이에요"
          : req.inv
          ? "초대받고 왔는데 자리가 없었어요"
          : "자리가 없어요"}
      </span>
      <span className="gs-lbreq-r">
        <button className="gs-swaplink gs-swaplink-mute" onClick={() => onDeny(req.acct)}>
          {req.waiting ? "내보내기" : "거절"}
        </button>
        <button
          className={"gs-btn gs-btn-sm" + (ghost ? " gs-btn-ghost" : "")}
          onClick={onApprove}
        >
          {req.kicked ? "받기" : "자리 만들어 앉히기"}
        </button>
      </span>
    </div>
  );
}

/* 자리 고르기 창 — [자리 바꾸기]가 씁니다. 명단은 인원 수만큼의 칸이라 "새 자리"는
   없습니다 — 빈 칸이 곧 새 자리입니다 (§3.1) */
function SeatPick({ title, nick, seats, onPick, onClose }) {
  const free = seats
    .map((s, i) => ({ s, i }))
    .filter(({ s, i }) => i > 0 && !s.acct);
  return (
    <InfoModal title={title} onClose={onClose}>
      <div className="gs-key">
        <p>
          <b>{nick}</b> 님을 어느 자리에 앉힐까요? 자리를 옮기면 자수 자격도 따라가요.
        </p>
        <div className="gs-seatlist">
          {free.map(({ s, i }) => (
            <button key={s.id} className="gs-seatopt" onClick={() => onPick(s.id)}>
              {(s.name || "").trim() || ANON(i)} 자리에
            </button>
          ))}
        </div>
        <div className="gs-obs-acts gs-acts-end">
          <button className="gs-btn gs-btn-sm gs-btn-ghost" onClick={onClose}>
            닫기
          </button>
        </div>
      </div>
    </InfoModal>
  );
}

/* ---------- 함께한 사람 · 지목 초대 (§3.3 라운드 B) ----------
   셋 다 자기 안에서 끝나는 조각입니다 — 로비든 파티 서랍이든 붙이는 자리만 바꾸면 되게
   바깥에서 값을 받고 동작만 올려보냅니다. 로비 화면이 다시 짜여도 이 셋은 그대로 옮깁니다. */

/* (폐기 2026-09-05) MateChips · MateSheet — 함께한 사람 칩과 시트(지목 초대·노크). §3.3 */

/* 받은 지목 초대 (§8) — 수락하면 방장 수락 없이 바로 앉습니다.
   1분짜리라 알림을 쌓지 않습니다: 화면에 떠 있는 동안이 곧 유효 시간입니다 */
function InviteCard({ inv, onAccept, onDeny }) {
  return (
    <div className="gs-fxcard gs-invcard" role="status">
      <b>초대가 왔어요</b>
      <span className="gs-join-sub">
        {inv.fromNick || inv.from}
        {/* 받는 쪽 화면도 방송에 잡힙니다 — 부른 사람의 아이디도 앞 두 글자만 (§3.1) */}
        <span className="gs-join-id">({inv.from.slice(0, 2) + "••••"})</span>님이 파티에 초대했어요
      </span>
      <div className="gs-join-acts">
        <button className="gs-btn gs-btn-sm gs-btn-ghost" onClick={() => onDeny(inv)}>
          거절
        </button>
        <button className="gs-btn gs-btn-sm" onClick={() => onAccept(inv)}>
          수락하고 들어가기
        </button>
      </div>
    </div>
  );
}

/* 로비 = 홈 (§3.1). 2열 벤토입니다 — 왼쪽 열이 위가 명단, 아래가 항목이고,
   오른쪽 열이 파티원 모으기(상설)입니다. 첫 할 일이 읽기 시작점에 있어야 합니다.
   [시작]은 히어로 한 줄의 오른쪽 끝(무대 우상단 모서리)이고 이 화면에서 유일하게
   채운 버튼입니다. 판 기록은 히어로의 아이콘 하나로 열리는 창이고, 중단된 판 카드는
   히어로 아래·벤토 위에 섭니다. 모으기 열의 순서(신청 → 함께한 사람 → 처음 오는 사람)는
   판 중 파티 서랍이 그대로 다시 씁니다 — 표면이 이사해도 지도는 같습니다. */
/* (폐기 2026-09-05) LobbyScreen — 옛 로비 화면(2열 벤토). 준비 상태의 벌금표 + 모집 카드(§3.1)와
   로비(LobbyHome, §3.0)로 갈라져 이사했다. 이 자리의 CSS(.gs-lb*)는 모집 카드가 일부 이어 쓴다 */

/* 로비 — 홈 (§3.0, 2026-09-05). 나 | 파티 두 기둥: 왼쫽 카드 하나가 내 것(계정·주소·내 판),
   오른쪽이 남과 하는 것(파티·판 기록). 무게는 데이터가 정합니다 — 내 판이 백지면 만들기가
   조용한 문이고, 앉은 파티가 있으면 복귀 줄이 주인공입니다. 채우는 게 아니라 밀도입니다:
   카드 속은 실데이터 요약이고, 첫 방문(백지)은 문 둘만 크고 나머지는 비웁니다.
   문구는 §8 초안 — 화면에서 보고 확정합니다 */
/* 아바타 (2026-09-07 사용자 확정 ③) — 글자 원 + 계정마다 다른 색(아이디 해시 → 색상), 방장은 금테.
   로비 계정 카드(36px)·허브 머리(30px)·OBS 창 계정 줄(30px)·표의 줄(20px)이 한 벌. (폐기) 로비 30px 어두운 글자 원 .gs-acct-ava 와 표의 사람 아이콘 —
   같은 사람이 두 얼굴이었고, 큰 닉 옆에서 죽어 보였다(사용자). 로비 계정 카드의 아바타는 "나"라 역할을 달지 않는다 */
const avaHue = (id) => {
  let h = 7;
  for (const ch of String(id || "")) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h % 360;
};
const avaChar = (nick) => [...String(nick || "").trim()][0] || "?";
function Ava({ id, nick, size, host, className }) {
  return (
    <i
      className={"gs-ava" + (host ? " gs-ava-host" : "") + (className ? " " + className : "")}
      style={{ "--h": avaHue(id), width: size, height: size, fontSize: Math.round(size * 0.44) }}
      aria-hidden="true"
    >
      {avaChar(nick)}
    </i>
  );
}

/* 참여 칸 — 허브 안의 작은 부품 (입력값만 제 것) */
function JoinBox({ onJoin }) {
  const [code, setCode] = useState("");
  const submit = () => {
    if (code.trim()) onJoin(code);
  };
  return (
    <div className="gs-lh-join">
      <input
        className="gs-in gs-lh-in"
        value={code}
        placeholder="초대 코드나 초대 주소를 붙여넣어요"
        onChange={(e) => setCode(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && submit()}
        aria-label="초대 코드나 초대 주소"
      />
      <button className="gs-btn" onClick={submit} disabled={!code.trim()}>
        참여하기
      </button>
    </div>
  );
}

/* 로비 두 열 (2026-09-07 사용자 확정: 헤더 리뉴얼) — 1열은 계정 카드와 기록 카드가 위아래로, 2열은 파티 허브(헤더 칩과 같은 내용).
   (폐기, 같은 날) 왼쪽 한 카드에 계정·주소·내 판이 함께, 오른쪽에 `파티 참여` 카드와 기록 카드 — 아바타와 기록이 한 카드일 이유가 없었고(사용자),
   내 판·파티 참여·헤더 칩 셋이 같은 일을 따로 말했다. 기록은 없어도 카드가 선다(`아직 기록이 없어요`, 초안) */
function LobbyHome({
  auth,
  obsUrl,
  showObs,
  onToggleObs,
  onCopy,
  flash,
  onSettings,
  onLogin,
  onUpgrade,
  hub,
  gens,
  onOpenGen,
  onDropGen,
  onAllGens,
  tutLine,
  onTut,
  onDropTut,
}) {
  /* 누적 한 줄 — 기록 카드 발치, 로컬 집계 (§3.0) */
  const total = gens.reduce((a, g) => a + (g.gold || 0), 0);
  return (
    <section className="gs-lobbyhome" aria-label="로비">
      {/* 같이 해보기 권유 (2026-09-06 사용자 확정) — 초대 없이 들어온 모든 사용자에게 한 번, 헤더 아래·두 카드 위 띠.
          [됐어요]로 접으면 [?]에만 남습니다. 문구는 초안 */}
      {tutLine && (
        <div className="gs-tutline" role="status">
          <span>
            <b>리뉴얼됐어요.</b> 4인 파티를 예시로 처음부터 같이 열어 봐요.
          </span>
          <span className="gs-tutline-r">
            <button className="gs-btn gs-btn-sm gs-btn-ghost" onClick={onDropTut}>
              됐어요
            </button>
            <button className="gs-btn gs-btn-sm gs-lbstart" onClick={onTut}>
              같이 해보기
            </button>
          </span>
        </div>
      )}
      <div className="gs-lobbyhome-col">
        <div className="gs-card gs-lh-me">
          <h4 className="gs-lbcard-h">계정</h4>
          {auth ? (
            <>
              {/* 계정 줄 — 설정(닉·로그아웃·아이디 만들기)은 오버레이 공유 설정 창(§5.7)이 집이고, 로비는 진열대입니다 */}
              <div className="gs-lh-acct">
                <Ava id={auth.id} nick={auth.nick} size={36} />
                <b className="gs-lh-nick">{auth.nick}</b>
                {auth.anon ? (
                  <span className="gs-acct-badge">게스트</span>
                ) : (
                  <span className="gs-acct-idm">{(auth.id || "").slice(0, 2) + "••••"}</span>
                )}
                <button className="gs-auth-linkb gs-lh-set" onClick={onSettings}>
                  설정
                </button>
              </div>
              {obsUrl && (
                <div className="gs-lh-addr">
                  <span className="gs-caplab">내 방송용 주소</span>
                  <code className="gs-lh-url">{showObs ? obsUrl : maskUrl(obsUrl)}</code>
                  <button
                    className="gs-btn gs-btn-sm gs-btn-ghost gs-eyebtn"
                    onClick={onToggleObs}
                    aria-label={showObs ? "가리기" : "보기"}
                    title={showObs ? "가리기" : "보기"}
                  >
                    <Eye on={showObs} />
                  </button>
                  <button className="gs-btn gs-btn-sm" onClick={() => onCopy(obsUrl, "obsurl")}>
                    {flash === "obsurl" ? "복사했어요" : "복사"}
                  </button>
                </div>
              )}
              {/* 게스트 안내는 여기 (2026-09-07; (폐기) 대기실 모집 카드 발치) — 방장은 파티의 앵커라 브라우저 저장소를 잃으면 방을 되찾을 길이 없습니다 (§3.11) */}
              {auth.anon && (
                <p className="gs-lh-note">
                  게스트 계정은 이 브라우저에 묶여 있어요 —{" "}
                  <button className="gs-auth-linkb" onClick={onUpgrade}>
                    아이디를 정하면
                  </button>{" "}
                  어디서든 이어요.
                </p>
              )}
            </>
          ) : (
            <>
              {/* 문 하나 (2026-09-07 사용자 지정 라벨) — 시작하기 랜딩(게스트·가입·로그인)을 열고, 끝나면 OBS 공유 창이 떠서 거기서 주소를 받습니다.
                  (폐기, 같은 날) 안내 한 줄 + 글자 `로그인` — 문이 안 보였다. 버튼 밑에 따로 `로그인`을 두는 것도 폐기(사용자: 버튼이 곧 로그인인데 이상하다) */}
              <button className="gs-btn gs-lifebtn gs-lbstart gs-lh-getaddr" onClick={onLogin}>
                로그인하여 방송용 주소 받기
              </button>
              <p className="gs-lh-note gs-lh-loginnote">파티원을 부르거나 방송에 띄우려면 계정이 필요해요 — 게스트로도 돼요. 벌금만 셀 거면 필요 없어요.</p>
            </>
          )}
        </div>
        {/* 판 기록의 집 (§3.0) — 내 판과 참여한 판이 이름표를 달고 섭니다. 없어도 카드는 섭니다 (2026-09-07) */}
        <div className="gs-card gs-lh-recs">
          <h4 className="gs-lbcard-h">
            기록{gens.length > 0 && <span className="gs-lbroster-n">{gens.length}</span>}
          </h4>
          {gens.length > 0 ? (
            <>
              <GenList gens={gens.slice(0, 3)} onOpen={onOpenGen} onDrop={onDropGen} />
              <div className="gs-lh-recfoot">
                <span className="gs-lh-stat">
                  여태 <b>{gens.length}판</b> · 벌금 <b>{man(total)}</b>
                </span>
                {gens.length > 3 && (
                  <button className="gs-auth-linkb" onClick={onAllGens}>
                    전체 보기
                  </button>
                )}
              </div>
            </>
          ) : (
            <div className="gs-lh-box empty gs-lh-norec">
              <p className="gs-lh-sub">아직 기록이 없어요. 판을 끝내면 결과지가 여기 남아요.</p>
            </div>
          )}
        </div>
      </div>
      <div className="gs-lobbyhome-col">
        <div className="gs-card gs-lh-hub">
          <h4 className="gs-lbcard-h gs-lh-hubh">파티</h4>
          {hub}
        </div>
      </div>
    </section>
  );
}

/* 판 기록 아이콘 — 시계 문자판에 되돌아가는 화살표가 걸린 모양입니다 (§3.1).
   지나간 판을 되짚는 문이라, 목록도 달력도 아닌 이 글리프가 맞습니다 */
function IconHistory() {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
      <g
        fill="none"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M3 4v5h5" />
        <path d="M3.05 13A9 9 0 1 0 6 5.3L3 9" />
        <path d="M12 7.5v5l4 2" />
      </g>
    </svg>
  );
}

/* 판 기록 창 — 로비 히어로의 아이콘으로 엽니다 (§3.1). 헤더 드롭다운에 있던 내용
   그대로이고, 줄을 누르면 그 판의 결과지로 갑니다 */
function GenModal({ gens, onOpen, onDrop, onClose }) {
  return (
    <InfoModal title="판 기록" onClose={onClose}>
      <p className="gs-gens-lead">
        끝난 판이 여기 남아요. 보기만 할 수 있고, 최근 20판까지 남습니다.
      </p>
      <GenList gens={gens} onOpen={onOpen} onDrop={onDrop} />
      {/* 모달의 마무리는 오른쪽 하단입니다 (§9-6) */}
      <div className="gs-obs-acts gs-acts-end">
        <button className="gs-btn gs-btn-sm gs-btn-ghost" onClick={onClose}>
          닫기
        </button>
      </div>
    </InfoModal>
  );
}

/* 판 기록 목록 — 창과 목록을 따로 두어, 줄의 생김새를 한 군데서만 고칩니다.
   줄마다 판의 신분증입니다: 배지(누구의 판)·기간·인원·파티원 전부·총액·[×] */
function GenList({ gens, onOpen, onDrop }) {
  if (!gens.length) return <p className="gs-gens-empty">아직 끝난 판이 없어요.</p>;
  return (
    <>
      {gens.map((g) => (
        <div className="gs-hisrow" key={g.name}>
          {/* 배지가 '누구의 판'을 말합니다 — 제목을 따로 되풀이하지 않습니다 */}
          <span className={"gs-idsrc" + (g.src === "party" ? "" : " gs-idsrc-local")}>
            {g.title}
          </span>
          <button className="gs-hisbody" onClick={() => onOpen(g.name)}>
            {/* 방장이 지은 판 이름이 첫 줄입니다 (§3.1) — 찾는 열쇠가 시각뿐이면
                비슷한 시각 스무 줄에서 어느 것이 그 판인지 못 찾습니다.
                이름이 없는 옛 기록은 예전처럼 시각이 첫 줄입니다 */}
            <span className="gs-hist1">
              <b>{g.rname || fmtWhenShort(g.from || g.t)}</b>
              <span>{g.n}명</span>
              {g.rname && <span>{fmtWhenShort(g.from || g.t)}</span>}
            </span>
            {/* 파티원 전부 — "외 4명"으로 줄이지 않습니다 */}
            {g.mems.length > 0 && (
              <span className="gs-idmems">
                {g.mems.map((n, i) => (
                  <span
                    key={n + "@" + i}
                    className={
                      "gs-idmem" +
                      (g.host && n === g.host
                        ? " gs-idmem-host"
                        : g.me && n === g.me
                        ? " gs-idmem-me"
                        : "")
                    }
                  >
                    {n}
                  </span>
                ))}
              </span>
            )}
          </button>
          <span className="gs-hisgold">{man(g.gold || 0)}</span>
          <button className="gs-x" onClick={() => onDrop(g)} aria-label={g.title + " 기록 지우기"}>
            ×
          </button>
        </div>
      ))}
    </>
  );
}

/* 오버레이 공유 설정 — 방송에 나가는 것은 한 창에서 끝냅니다.
   로그인이 없으면 주소부터 주고(§5.2), 그다음이 내 방송용 주소·초대·명단, 마지막이 생김새입니다.
   guest 는 파티원이 연 창입니다 — 자기 주소·소스 나누기·외형만 남기고 방장 것은 뺍니다. */
function ObsShare({ relay, putRelay, auth, onOpenAuth, fresh, guest, onAskReissue, castState, onNick, onLogout, onUpgrade, ovCols, isOff, sumOn, netOn, slideOn, onOvSlide, onOvItem, onOvKey, onClose, inviteRow }) {
  const [err, setErr] = useState("");
  const [copied, setCopied] = useState(null);
  const [showGuide, setShowGuide] = useState(false);
  const [showGain, setShowGain] = useState(false); // 방송 주소, 한 번만 넣으면 돼요 (쓰는 방식 비교)
  const [showAcct, setShowAcct] = useState(false); // 아이디를 만들면 뭐가 달라져요? (2026-09-06 오후)
  const [showObs, setShowObs] = useState(false); // 방송 중 유출 방지 — 기본 가림
  const [busy, setBusy] = useState("");
  /* 닉 바꾸기 — 계정 서랍에서 이리로 옮겨 왔습니다 (§5.7). 칸은 접어 둡니다 (§9-7):
     늘 열려 있으면 자주 쓰는 로그아웃과 무게가 같아 보입니다 */
  const [nickOpen, setNickOpen] = useState(false);
  const [nickDraft, setNickDraft] = useState("");
  const [nickBusy, setNickBusy] = useState(false);
  const [nickErr, setNickErr] = useState("");
  const saveNick = async () => {
    const nm = nickDraft.trim();
    if (!nm) return;
    if (nm === auth.nick) {
      setNickOpen(false);
      return;
    }
    setNickBusy(true);
    setNickErr("");
    try {
      await onNick(nm);
      setNickOpen(false);
    } catch (e) {
      setNickErr((e && e.message) || "바꾸지 못했어요");
    }
    setNickBusy(false);
  };
  const obsUrl = auth && auth.obsToken ? roomApi.obsUrl(auth.obsToken) : "";
  const srcMode = relay.ovsrc === "split" ? "split" : "one";

  useEffect(() => {
    // 가이드 창이 위에 떠 있으면 Esc 는 그쪽 몫입니다 — 한 번에 하나씩 닫힙니다
    const onKey = (e) => e.key === "Escape" && !showGuide && !showGain && !showAcct && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, showGuide, showGain, showAcct]);

  const copy2 = (kind, text) =>
    navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopied(kind);
        setTimeout(() => setCopied(null), 2000);
      })
      .catch(() => setErr("복사하지 못했어요"));

  const guideImg = (k) =>
    (/^(localhost|127\.0\.0\.1)$/.test(window.location.hostname) ? "docs/" : "") +
    "obs-guide/obs-guide-" + k + ".png";

  /* 창 안 실시간 미리보기 (2026-09-05, ①) — 이 주소가 지금 내보내는 그림 그대로. ?fit=1 은 미리보기 표시
     (체커보드, 브라우저 안내 줄 없음). 지금 고른 외형을 주소에도 실어, 판을 민 적 없는 계정의 예시 판도
     제 테마로 뜹니다. (폐기 2026-09-05, 당일) 새 탭으로 여는 [오버레이 미리보기] — 새 탭·체커보드·예시 판이
     전부 "이게 방송에 나가는 건가"를 묻게 했다. 창이 열린 동안만 소켓 하나를 더 씁니다 */
  /* (폐기 2026-09-06 당일) previewSrc — 창 안 iframe 미리보기 주소. 미리보기 자체를 뺐습니다 */
  return (
    <div className="gs-modal" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="gs-dialog gs-dialog-wide" role="dialog" aria-modal="true" aria-label="OBS 공유 설정">
        <div className="gs-obs-head">
          <h3>OBS 공유 설정</h3>
          <div className="gs-obs-headr">
            {/* 송출 토글은 폐지했습니다 (§5.7) — OBS 에는 이미 소스를 껐다 켜는 눈알이
                있고 씬까지 나눠 쓰는데, 앱에 같은 스위치를 하나 더 두면 판이 안 뜰 때
                원인을 두 군데서 찾게 됩니다. 앱이 남길 것은 스위치가 아니라 계기판입니다.
                주소에 손대는 문은 [주소 새로 발급] 하나뿐입니다.
                도움말 둘을 머리에 나란히 두면 제목이 밀려 두 줄로 접힙니다 —
                각자 답하는 물음이 있는 자리로 내려보내고, 머리에는 제목만 둡니다 */}
            <button className="gs-x gs-dialog-x" onClick={onClose} aria-label="닫기">
              ×
            </button>
          </div>
        </div>

        {!auth ? (
          /* 문은 하나입니다 (§5.2). 어느 쪽으로 가든 결과는 "내 링크"인데 입구를 둘로 나누면
             "나는 어느 쪽인가"를 또 묻는 셈이라, 주소는 마찰 없이 주고 계정은 그 아래에서
             이득을 설명해 권합니다. 주소 자리는 로그인 뒤와 같은 카드입니다 —
             발급 전에도 "여기가 주소 자리"임이 보입니다 (2026-09-05 목업 확정) */
          <>
            <div className="gs-obs-card">
              <h4 className="gs-key-h">내 방송용 주소</h4>
              {/* 게스트 문으로 보냅니다 (§3.11) — 닉 한 줄을 받아야 벌금판에 오르는
                  이름이 생깁니다. 예전에는 조용히 만들어서 모두가 `방장`이 됐습니다 */}
              <button className="gs-btn gs-authgo" onClick={() => onOpenAuth("register", true)}>
                내 방송용 주소 받기
              </button>
              {/* (폐기 2026-09-05) "이 브라우저에 저장돼요." — 발급 문이 랜딩(가입 포함)으로
                  가게 되어 게스트 전용 안내는 오안내가 됐습니다. 브라우저 저장 이야기는
                  랜딩의 게스트 카드가 합니다 */}
              <p className="gs-obs-makenote">
                이미 계정이 있어요 ·{" "}
                <button className="gs-auth-linkb" onClick={() => onOpenAuth("login", true)}>
                  로그인
                </button>
              </p>
            </div>
            {/* 두 컴퓨터 함정 (§3.11) — 금지("또 받지 마세요")로 말하면 "주소를 두 개
                받으면 안 되나?"로 읽힙니다 (2026-09-05). 어디서 받으라는 안내로 뒤집고,
                가입하면 해당 없다는 것까지 답니다 */}
            <p className="gs-obs-warn2">
              주소는 <b>벌금판을 쓸 브라우저에서</b> 받으세요 — 게스트 주소는 받은
              브라우저에 묶여 있어요. 송출컴에는 주소만 복사해 넣으면 되고, 계정을
              만들면 어느 컴퓨터에서든 같은 주소를 써요.
            </p>
          </>
        ) : (
          <>
            {/* 계정 줄은 제목 바로 아래입니다 (2026-09-05 확정) — 맨 아래에 두면 아무도
                못 봅니다. 닉이 곧 벌금판의 내 이름이라 "내가 누구로 있는지"가 먼저입니다 */}
            <div className="gs-acct-row">
              <Ava id={auth.id} nick={auth.nick} size={30} />
              <b className="gs-acct-nick2">{auth.nick}</b>
              {auth.anon ? (
                <span className="gs-acct-badge">게스트</span>
              ) : (
                /* 아이디도 방송에 새면 좋을 게 없습니다 — 주소처럼 가려 둡니다 */
                <span className="gs-acct-idm">{auth.id.slice(0, 2) + "••••"}</span>
              )}
              {nickOpen ? (
                <span className="gs-acct-nick">
                  <input
                    className="gs-in gs-in-nick"
                    value={nickDraft}
                    placeholder="2~3글자"
                    autoFocus
                    onChange={(e) => setNickDraft(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && saveNick()}
                    aria-label="닉네임 바꾸기"
                  />
                  <button
                    className="gs-btn gs-btn-sm gs-btn-ghost"
                    onClick={() => {
                      setNickOpen(false);
                      setNickErr("");
                    }}
                  >
                    취소
                  </button>
                  <button
                    className="gs-btn gs-btn-sm"
                    onClick={saveNick}
                    disabled={nickBusy || !nickDraft.trim()}
                  >
                    {nickBusy ? "바꾸는 중…" : "바꾸기"}
                  </button>
                </span>
              ) : (
                <span className="gs-acct-acts">
                  <button
                    className="gs-btn gs-btn-sm gs-btn-ghost"
                    onClick={() => {
                      setNickDraft(auth.nick || "");
                      setNickErr("");
                      setNickOpen(true);
                    }}
                  >
                    닉 바꾸기
                  </button>
                  <button className="gs-btn gs-btn-sm gs-btn-ghost" onClick={onLogout}>
                    로그아웃
                  </button>
                </span>
              )}
            </div>
            {nickOpen && (
              <p className="gs-acct-note">닉네임은 벌금판에 올라가는 이름이에요.</p>
            )}
            {nickErr && <p className="gs-acct-err">{nickErr}</p>}
            {/* 익명 계정은 아이디·비밀번호가 없어서 이 브라우저에서만 쓸 수 있습니다 (§3-11) */}
            {auth.anon && (
              <div className="gs-obs-line gs-acct-upline">
                <span className="gs-obs-linetxt">
                  가입 없이 쓰는 중이에요 — 아이디를 정하면 다른 컴퓨터에서도 같은 주소를 쓸
                  수 있어요.{" "}
                  {/* 게스트에게 필요한 건 "아이디를 만들면 뭐가 다른가" — 쓰는 방식 비교 창은 주소 상자 아래로 갔습니다 (2026-09-06 오후 사용자 확정) */}
                  <button className="gs-auth-linkb" onClick={() => setShowAcct(true)}>
                    아이디를 만들면 뭐가 달라져요?
                  </button>
                </span>
                <button className="gs-btn gs-btn-sm gs-btn-ghost" onClick={onUpgrade}>
                  아이디 만들기
                </button>
              </div>
            )}

            {/* 방금 받은 사람에게는 주소를 보여 주는 것으로 부족합니다 — 다음 걸음을
                시켜야 합니다 (§3.11). 이 한 장은 발급 직후 한 번만 뜨고, 다음부터는
                아래 평소 화면입니다 */}
            {fresh && (
              <div className="gs-obs-fresh">
                <b>주소가 나왔어요.</b>
                <p>
                  이 주소를 복사해서 방송 프로그램(OBS·프리즘 등)의 <b>브라우저 소스</b>에
                  붙여넣으면 벌금판이 방송에 떠요.
                </p>
                <p className="gs-obs-fresh2">
                  <b>송출컴이 따로 있나요?</b> 여기서 복사해서 옮기세요 — 거기서 새로 받으면
                  다른 주소가 나와요.
                </p>
              </div>
            )}
            {/* 내 방송용 주소 — 영구(재발급 전까지), 읽기 전용. 창의 주인공이라
                금테 카드 하나에 담습니다 (2026-09-05 목업 확정) */}
            <div className="gs-obs-card">
              <div className="gs-obs-cardhead">
                <h4 className="gs-key-h">내 방송용 주소</h4>
              </div>
              {/* (폐기 2026-09-06 당일) 실시간 미리보기 iframe `지금 이 주소에 나가는 그림이에요.` — 사용자: 스크롤을 너무
                  잡아먹고 주소가 잘 안 보인다. 나가는 게 뭔지는 아래 상태 문장(CAST_WHY)이 말합니다 */}
              {/* 고르는 것이 먼저, 주소는 그 결과 (2026-09-05) — 선택이 주소를 한 줄/두 줄로
                  바꾸니, 바꾸는 손잡이가 주소 위에 서야 순서가 맞습니다.
                  머리말은 안 답니다: "룰렛을 크게"는 나눈 소스 카드가 제 입으로 말합니다 */}
              <div className="gs-obs-srcpick" role="group" aria-label="소스 구성">
                {[
                  ["one", "한 소스", "현황판과 룰렛이 한 주소에 같이 나와요"],
                  ["split", "나눈 소스", "룰렛을 화면 전체에 크게 띄울 수 있어요"],
                ].map(([v, label, hint]) => (
                  <button
                    key={v}
                    className={"gs-slook-c src" + (srcMode === v ? " on" : "")}
                    onClick={() => putRelay({ ...relay, ovsrc: v === "split" ? "split" : undefined })}
                    aria-pressed={srcMode === v}
                  >
                    <span className="gs-src-art" aria-hidden="true">
                      {v === "one" ? (
                        <span className="gs-src-scr">
                          <i className="gs-src-tbl" />
                          <i className="gs-src-disc mid" />
                        </span>
                      ) : (
                        <span className="gs-src-scr">
                          <i className="gs-src-tbl sm" />
                          <i className="gs-src-disc big" />
                        </span>
                      )}
                    </span>
                    <b>{label}</b>
                    <em>{hint}</em>
                  </button>
                ))}
              </div>
              {srcMode === "split" && (
                <p className="gs-obs-srcnote">
                  현황판 소스는 구석에 작게, 룰렛 소스는 화면 전체로 크게 잡아요. 룰렛
                  소스는 판이 돌 때만 나타나고 평소에는 아무것도 안 보여요. 룰렛 주소를
                  안 넣으면 룰렛 없이 현황판만 나와요.
                </p>
              )}
              {/* 나눠 쓰면 주소가 두 줄로 — 주소는 어떤 상태에서든 이 카드 안에 있습니다.
                  (폐기 2026-09-05) "주소 두 개를 각각 소스로 넣어요"라는 안내문만 남기고
                  실제 두 주소를 카드 밖 접기에 두던 배치 — 주소 카드에 주소가 없었습니다 */}
              {srcMode === "one" ? (
                /* 주소 상자 (2026-09-06 사용자 확정) — 주소가 카드의 주인공이라 금테 상자에 크게. 계정 줄은 그대로 위 */
                <div className="gs-obs-boxtop gs-obs-addrbox">
                  <span className="gs-obs-urltext">{showObs ? obsUrl : maskUrl(obsUrl)}</span>
                  <button
                    className="gs-btn gs-btn-sm gs-btn-ghost gs-eyebtn"
                    onClick={() => setShowObs((v) => !v)}
                    aria-label={showObs ? "가리기" : "보기"}
                    title={showObs ? "가리기" : "보기"}
                  >
                    <Eye on={showObs} />
                  </button>
                  <button className="gs-btn gs-btn-copy" onClick={() => copy2("url", obsUrl)}>
                    {copied === "url" ? "복사했어요" : "복사"}
                  </button>
                </div>
              ) : (
                <>
                  {/* 가려도 꼬리(?type=…)는 보입니다 — 비밀이 아닌 데다, 가리면 두 주소가
                      똑같아 보여서 뭐가 다른지 화면이 말을 못 했습니다 (2026-09-05) */}
                  <div className="gs-obs-srcrow gs-obs-addrbox gs-obs-addrbox-2">
                    <b>현황판</b>
                    <span className="gs-obs-urltext">
                      {(showObs ? obsUrl : maskUrl(obsUrl)) + "?type=board"}
                    </span>
                    <button
                      className="gs-btn gs-btn-sm gs-btn-ghost gs-eyebtn"
                      onClick={() => setShowObs((v) => !v)}
                      aria-label={showObs ? "가리기" : "보기"}
                      title={showObs ? "가리기" : "보기"}
                    >
                      <Eye on={showObs} />
                    </button>
                    <button
                      className="gs-btn gs-btn-sm"
                      onClick={() => copy2("burl", obsUrl + "?type=board")}
                    >
                      {copied === "burl" ? "복사했어요" : "복사"}
                    </button>
                  </div>
                  {/* 채운 버튼은 섹션에 하나입니다 (§9-2) — 현황판이 그 하나입니다.
                      룰렛 주소는 없어도 현황판만 나오므로(아래 안내) 무게를 낮춥니다 */}
                  <div className="gs-obs-srcrow gs-obs-addrbox gs-obs-addrbox-2">
                    <b>룰렛</b>
                    <span className="gs-obs-urltext">
                      {(showObs ? obsUrl : maskUrl(obsUrl)) + "?type=spin"}
                    </span>
                    <button
                      className="gs-btn gs-btn-sm gs-btn-ghost"
                      onClick={() => copy2("surl", obsUrl + "?type=spin")}
                    >
                      {copied === "surl" ? "복사했어요" : "복사"}
                    </button>
                  </div>
                </>
              )}
              {/* 이 주소에 지금 뭐가 나가는지 — 라벨 없이 문장으로 (§5.7·§8).
                  파티원 것은 아닙니다: 파티원 화면은 방장이 민 판을 비추기만 합니다 */}
              {!guest && castState && (
                <p className="gs-cast-line">
                  <em className={"gs-castdot gs-castdot-" + castState} aria-hidden="true" />
                  {CAST_WHY[castState]}
                </p>
              )}
              {/* 가장 안 눌러야 할 문이라 카드 발치의 조용한 링크입니다 — 언제 쓰는지는
                  누르면 뜨는 확인 창이 말합니다 (§9-4) */}
              <p className="gs-obs-cardfoot">
                <button className="gs-auth-linkb" onClick={onAskReissue}>
                  주소 새로 발급
                </button>
              </p>
            </div>

            {/* 방장의 문 둘 중 하나 (2026-09-06) — 초대 코드도 여기 삽니다. 시작 전 모집 카드는 같은 코드를 크게 비추는 자리 */}
            {inviteRow && (
              <div className="gs-obs-card gs-obs-invcard">{inviteRow()}</div>
            )}
            <div className="gs-obs-line">
              <span className="gs-obs-linetxt">
                OBS·XSplit·프리즘 등 어떤 방송 프로그램이든, 브라우저 소스에 이 주소를
                넣으면 돼요.
              </span>
              {/* 도움말은 링크 무게로 — 버튼으로 세우면 조작(복사·카드)과 같은 소리를 냅니다 */}
              <button className="gs-auth-linkb gs-obs-lineact" onClick={() => setShowGuide(true)}>
                OBS에 넣는 방법
              </button>
            </div>


          </>
        )}
        {/* 구 방식(방장 주소 하나를 파티원 OBS에 다 넣기) 방장에게 — 로그인·주소 유무와 상관없이 늘 (2026-09-06 오후 사용자 확정:
            두 창 모두 OBS 공유 설정 안에서, 자리는 달리). 문구 초안 */}
        <div className="gs-obs-line gs-obs-waysline">
          <span className="gs-obs-linetxt">
            파티원도 각자 로그인해서 자기 주소를 받아 넣어요. 방장 주소 하나를 다 같이 넣던 방식과 뭐가 다른지는 여기에.
          </span>
          <button className="gs-auth-linkb gs-obs-lineact" onClick={() => setShowGain(true)}>
            방송 주소, 한 번만 넣으면 돼요
          </button>
        </div>

        {/* 생김새도 여기서 — 주소와 생김새가 한 창에 있어야 한 번에 끝납니다.
            비로그인은 잠급니다 (2026-09-05 확정) — 주소가 없으면 꾸밀 화면도 아직
            없습니다. 어둡게 두면 "받으면 이걸 꾸민다"가 보입니다.
            (폐기) "미리보기가 예시 방을 쓰므로 로그인 없이도 조작" — 발급 전 조작은
            저장될 곳이 없어 헛손질이었습니다 */}
        <div className={auth ? undefined : "gs-obs-locked"} aria-disabled={!auth}>
          <LookBody
            relay={relay}
            putRelay={putRelay}
            ovCols={ovCols}
            isOff={isOff}
            sumOn={sumOn}
            netOn={netOn}
            slideOn={slideOn}
            onOvSlide={onOvSlide}
            onOvItem={onOvItem}
            onOvKey={onOvKey}
          />
        </div>


        {err && <p className="gs-obs-err">{err}</p>}
        {/* 발치의 [닫기]는 폐지 (2026-09-05) — 머리(제목·×)가 스크롤을 따라와서
            어디서든 닫힙니다. §9-6의 "손이 위로 올라가야" 문제가 그걸로 풀립니다 */}
      </div>
      {showGuide && (
        <InfoModal title="OBS에 넣는 방법" onClose={() => setShowGuide(false)} wide>
          <ol className="gs-obs-guide">
            <li>
              OBS의 <b>소스 목록</b>에서 <b>＋</b>를 눌러요.
              <img src={guideImg(1)} alt="OBS 소스 목록의 + 버튼" />
            </li>
            <li>
              <b>브라우저</b>를 고르고 새 소스를 만들어요.
              <img src={guideImg(2)} alt="소스 추가 창에서 브라우저 선택" />
            </li>
            <li>
              URL 칸에 복사한 주소를 붙여넣고 확인을 눌러요. 너비·높이는 대충 잡아도 돼요 —
              글자가 소스 크기에 맞춰 늘어나요.
              <img src={guideImg(3)} alt="브라우저 속성 창의 URL 칸" />
            </li>
            <li>
              현황판이 뜨면 미리보기에서 끌어서 위치와 크기를 맞춰요.
              <img src={guideImg(4)} alt="OBS에 현황판이 뜬 모습" />
            </li>
          </ol>
          <p className="gs-obs-guidefoot">
            XSplit 등 다른 방송 프로그램도 같은 방법이에요. 혹시 현황판 대신 다른 화면이
            뜨면 주소 뒤에 <b>?mode=overlay</b> 를 붙여 주세요.
          </p>
        </InfoModal>
      )}
      {showGain && <GainGuide onClose={() => setShowGain(false)} />}
      {showAcct && <AcctGuide onClose={() => setShowAcct(false)} />}
    </div>
  );
}

/* [방송 주소, 한 번만 넣으면 돼요] (문패 2026-09-06 사용자 확정 — (폐기) `주소와 계정, 어떻게 돌아가요?`)
   — 1인 1주소 머리 + '한 번만/팟마다' 두 장 + 게스트/아이디 비교.
   '옛 방식·새 방식'이라 부르지 않습니다 — 옛 방식이 있었다는 걸 알 필요가 없습니다. */
function GainGuide({ onClose }) {
  /* 첫 부분의 그림 셋 (2026-09-06 리뉴얼, 사용자 요청) — 글자 상자·화살표 대신 선으로 그립니다.
     왼쪽 두 장면: 방장 주소 하나를 모두의 OBS에 → 방장이 바뀌면 전원이 주소를 갈아 끼움.
     오른쪽 한 장면: 사람마다 주소→OBS 한 줄씩, 위의 파티가 바뀌어도 선은 그대로.
     이름은 예시 — 실리안·니나브·웨이 (사용자 지정). 색은 토큰이라 밝은 판에서도 읽힙니다 */
  const Bx = ({ x, y, w, h, t, src }) => (
    <g>
      <rect
        x={x}
        y={y}
        width={w}
        height={h}
        rx="3"
        strokeWidth="1"
        style={src ? { fill: "rgba(var(--gold-rgb),.14)", stroke: "var(--gold)" } : { fill: "rgba(var(--ink-rgb),.06)", stroke: "rgba(var(--ink-rgb),.45)" }}
      />
      <text x={x + w / 2} y={y + h / 2 + 4} textAnchor="middle" style={{ fill: src ? "var(--ink)" : "var(--ink-body)" }}>
        {t}
      </text>
    </g>
  );
  const Ln = ({ x1, y1, x2, y2, dash, dim, gold }) => (
    <line
      x1={x1}
      y1={y1}
      x2={x2}
      y2={y2}
      strokeWidth="1.2"
      strokeDasharray={dash ? "4 3" : undefined}
      style={{ stroke: gold ? "var(--gold)" : dim ? "rgba(var(--ink-rgb),.22)" : "rgba(var(--ink-rgb),.5)" }}
    />
  );
  const Xm = ({ x, y }) => (
    <path d={"M" + (x - 4) + " " + (y - 4) + " l8 8 M" + (x + 4) + " " + (y - 4) + " l-8 8"} strokeWidth="1.6" strokeLinecap="round" fill="none" style={{ stroke: "var(--red)" }} />
  );
  return (
    <InfoModal title="방송 주소, 한 번만 넣으면 돼요" onClose={onClose} wide>
      {/* 축이 바뀌었습니다 (2026-09-05) — 게스트도 자기 계정·자기 주소를 받으니
          "가입 없이 = 주소 하나 나눠쓰기" 비교는 없는 방식을 설명하는 글이었습니다.
          이제 말할 것은 둘: ① 1인 1주소 모델이 뭐가 좋은가 ② 아이디는 뭘 더 주는가 */}
      <p className="gs-gain-lead">
        게스트든 아이디든, 로그인하면 <b>내 방송용 주소</b>가 나와요 — 주소는{" "}
        <b>사람마다 하나씩</b>이에요. 내 주소에는 내가 있는 판이 떠서, OBS에{" "}
        <b>한 번만</b> 넣으면 파티가 바뀌어도 그대로예요. 벌금을 세고 정산하는 데는
        계정이 필요 없어요.
      </p>

      {/* 이 창의 본업 — 쓰는 방식 두 가지의 비교입니다 (2026-09-05 축 교정).
          예전엔 "가입 없이 vs 계정"이었는데, 주소 발급 = 로그인이 되면서 가입 여부는
          축이 아니게 됐습니다. 나눠쓰기는 지금도 되는 방식이라 지우지 않습니다 */}
      <h4 className="gs-gain-h">쓰는 방식은 두 가지예요</h4>
      <div className="gs-gain-cols">
        <div className="gs-gain-col">
          <h4>
            주소 하나 나눠쓰기 <span className="gs-gain-tag">기존 방식</span>
          </h4>
          <p className="gs-gain-sub">방장 주소를 전원이 같이 넣어요 — 지금도 돼요</p>
          <div className="gs-gain-scene" aria-hidden="true">
            <svg viewBox="0 0 240 118">
              <Bx x={80} y={8} w={80} h={24} t="실리안 주소" src />
              <Ln x1={120} y1={32} x2={40} y2={78} />
              <Ln x1={120} y1={32} x2={120} y2={78} />
              <Ln x1={120} y1={32} x2={200} y2={78} />
              <Bx x={8} y={78} w={64} h={24} t="실리안 OBS" />
              <Bx x={88} y={78} w={64} h={24} t="니나브 OBS" />
              <Bx x={168} y={78} w={64} h={24} t="웨이 OBS" />
            </svg>
            <p className="gs-gain-scenecap">
              방장 주소 하나를 <b>모두의 OBS</b>에
            </p>
          </div>
          <div className="gs-gain-scene" aria-hidden="true">
            <svg viewBox="0 0 240 118">
              <Bx x={20} y={8} w={80} h={24} t="실리안 주소" src />
              <Bx x={140} y={8} w={80} h={24} t="니나브 주소" src />
              <Ln x1={60} y1={32} x2={40} y2={78} dim />
              <Ln x1={60} y1={32} x2={120} y2={78} dim />
              <Ln x1={60} y1={32} x2={200} y2={78} dim />
              <Xm x={52} y={52} />
              <Xm x={88} y={52} />
              <Xm x={124} y={52} />
              <Ln x1={180} y1={32} x2={40} y2={78} dash gold />
              <Ln x1={180} y1={32} x2={120} y2={78} dash gold />
              <Ln x1={180} y1={32} x2={200} y2={78} dash gold />
              <Bx x={8} y={78} w={64} h={24} t="실리안 OBS" />
              <Bx x={88} y={78} w={64} h={24} t="니나브 OBS" />
              <Bx x={168} y={78} w={64} h={24} t="웨이 OBS" />
            </svg>
            <p className="gs-gain-scenecap">
              방장이 바뀌면 <b>전원이 주소를 갈아요</b>
            </p>
          </div>
          <ul className="gs-gain-list">
            <li className="yes">
              링크를 받은 사람은 <b>누구나</b> 자기 방송에 띄울 수 있어요
            </li>
            <li className="no">
              방장이 바뀔 때마다 <b>전원이</b> OBS 소스의 주소를 갈아야 해요
            </li>
            <li className="no">
              그 주소엔 그 방장의 판만 떠요 — 내가 딴 파티에 가도 안 따라와요
            </li>
          </ul>
        </div>
        <div className="gs-gain-col">
          <h4>사람마다 자기 주소</h4>
          <p className="gs-gain-sub">각자 로그인해서 자기 주소를 한 번씩 넣어요</p>
          <div className="gs-gain-scene" aria-hidden="true">
            <svg viewBox="0 0 240 118">
              <rect x="8" y="6" width="224" height="22" rx="3" strokeDasharray="3 3" style={{ fill: "rgba(var(--ink-rgb),.05)", stroke: "rgba(var(--ink-rgb),.25)" }} />
              <text x="120" y="21" textAnchor="middle" style={{ fill: "var(--ink-body)" }}>
                오늘은 실리안네 파티 → 내일은 니나브네 파티
              </text>
              <Bx x={8} y={44} w={64} h={22} t="실리안 주소" src />
              <Bx x={88} y={44} w={64} h={22} t="니나브 주소" src />
              <Bx x={168} y={44} w={64} h={22} t="웨이 주소" src />
              <Ln x1={40} y1={66} x2={40} y2={88} />
              <Ln x1={120} y1={66} x2={120} y2={88} />
              <Ln x1={200} y1={66} x2={200} y2={88} />
              <Bx x={8} y={88} w={64} h={22} t="실리안 OBS" />
              <Bx x={88} y={88} w={64} h={22} t="니나브 OBS" />
              <Bx x={168} y={88} w={64} h={22} t="웨이 OBS" />
            </svg>
            <p className="gs-gain-scenecap">
              파티가 바뀌어도 <b>선은 그대로</b> — 내 주소에 내가 있는 판이 떠요
            </p>
          </div>
          <ul className="gs-gain-list">
            <li className="yes">
              OBS에 <b>한 번만</b> 넣으면 돼요 — 주소가 안 바뀌어요
            </li>
            <li className="yes">
              누가 방장이든, <b>내가 들어간 파티</b>가 내 주소에 떠요
            </li>
            <li className="yes">파티에서 빠지면 내 화면은 저절로 비워져요</li>
          </ul>
        </div>
      </div>

      <h4 className="gs-gain-h">한 번만 하는 일과, 팟마다 하는 일</h4>
      <div className="gs-gain-cols">
        <div className="gs-gain-col">
          <span className="gs-gain-tag">처음 한 번</span>
          <p className="gs-gain-sub">내 주소를 OBS에 넣기</p>
          <div className="gs-gain-art" aria-hidden="true">
            <span className="gs-gain-src">내 방송용 주소</span>
            <span className="gs-gain-arrow">→</span>
            <span className="gs-gain-src">OBS 브라우저 소스</span>
          </div>
          <p className="gs-gain-note">
            넣고 나면 다시 안 건드려요. 방송을 안 하면 이 단계는 건너뛰어도 돼요.
          </p>
        </div>
        <div className="gs-gain-col">
          <span className="gs-gain-tag">팟마다</span>
          <p className="gs-gain-sub">초대 링크 누르고 [참여]</p>
          <div className="gs-gain-art" aria-hidden="true">
            <span className="gs-gain-src">초대 링크</span>
            <span className="gs-gain-arrow">→</span>
            <span className="gs-gain-src">참여</span>
            <span className="gs-gain-arrow">→</span>
            <span className="gs-gain-src">아까 그 주소에 이번 파티가 뜸</span>
          </div>
          <p className="gs-gain-note">
            주소를 다시 넣을 필요가 없어요. 들어간 파티가 그 주소에 저절로 나타나요.
          </p>
        </div>
      </div>
      <p className="gs-gain-foot">
        파티원이 할 일은 초대 링크를 누르는 것뿐이에요. OBS를 안 써도 벌금은 세어지고
        자수도 돼요.
      </p>

    </InfoModal>
  );
}

/* 게스트와 아이디의 차이 (2026-09-06 오후 사용자 확정: 한 창을 둘로 — 주소 하나의 장점은 게스트도 똑같이 누리니, 이 창은 "어디서 이어 쓰느냐"만).
   문은 둘 — OBS 공유 설정의 게스트 계정 줄, 랜딩(게스트/가입 고르기). 제목·머리말은 초안. (폐기) 방송 주소 창의 끝 절 */
function AcctGuide({ onClose }) {
  return (
    <InfoModal title="아이디를 만들면 뭐가 달라져요?" onClose={onClose} wide>
      <p className="gs-gain-lead">
        게스트든 아이디든 <b>내 방송용 주소</b>는 하나씩 나오고, 자수·참여·정산도 똑같아요.
        {/* (폐기 2026-09-06 오후) 뒷문장 `다른 건 어디서 이어 쓸 수 있느냐예요.` — 사용자: 빼자 */}
      </p>
      <div className="gs-gain-cols">
        <div className="gs-gain-col">
          <h4>게스트</h4>
          <p className="gs-gain-sub">이 브라우저에 저장되는 계정</p>
          <div className="gs-gain-art" aria-hidden="true">
            <span className="gs-gain-src">이 브라우저</span>
            <span className="gs-gain-arrow">→</span>
            <span className="gs-gain-src">내 주소</span>
          </div>
          <ul className="gs-gain-list">
            <li className="yes">내 방송용 주소·자수·참여, 다 돼요</li>
            <li className="no">이 브라우저에서만 로그인돼요 — 지우면 계정을 잃어요</li>
            <li className="no">파티를 열어 파티원을 모을 수는 없어요</li>
          </ul>
        </div>
        <div className="gs-gain-col">
          <h4>아이디를 만들면</h4>
          <p className="gs-gain-sub">어디서든 같은 계정</p>
          <div className="gs-gain-art" aria-hidden="true">
            <span className="gs-gain-outs">
              <i>게임컴</i>
              <i>송출컴</i>
            </span>
            <span className="gs-gain-arrow">→</span>
            <span className="gs-gain-src">내 주소</span>
          </div>
          <ul className="gs-gain-list">
            <li className="yes">어느 컴퓨터·브라우저에서든 같은 주소를 써요</li>
            <li className="yes">파티를 열어 파티원을 모아요</li>
            <li className="yes">
              게스트였다가 만들어도 <b>주소·파티가 그대로</b>예요
            </li>
          </ul>
        </div>
      </div>
    </InfoModal>
  );
}

/* 사유까지 적을 때만 열리는 작은 창 — 금액은 칸에서 치던 값을 그대로 받습니다 */
function ReasonAdd({ who, draft, unitLabel, onClose, onAdd }) {
  const [v, setV] = useState(draft || "");
  const [why, setWhy] = useState("");
  const ref = useRef(null);
  useEffect(() => {
    ref.current?.focus();
    const onKey = (e) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const submit = () => {
    if (num(v) !== 0) onAdd(num(v), why.trim());
  };
  return (
    <div
      className="gs-modal"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="gs-dialog" role="dialog" aria-modal="true" aria-label="기타 벌금 추가">
        <h3>{who || "이름 없음"} · 기타 벌금</h3>
        <div className="gs-ra">
          <span className="gs-caplab">금액</span>
          <input
            className="gs-in gs-ra-amt"
            value={v}
            inputMode="decimal"
            onChange={(e) => setV(formatNumInput(e.target.value, true))}
            onKeyDown={(e) => e.key === "Enter" && submit()}
            aria-label={`금액 (${unitLabel})`}
          />
          <em className="gs-qx-unit">{unitLabel}</em>
        </div>
        <div className="gs-ra">
          <span className="gs-caplab">사유</span>
          <input
            ref={ref}
            className="gs-in gs-ra-why"
            value={why}
            placeholder="암살, 지각 …"
            onChange={(e) => setWhy(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
            aria-label="사유"
          />
        </div>
        <div className="gs-dialog-btns">
          <button className="gs-btn gs-btn-ghost" onClick={onClose}>
            취소
          </button>
          <button className="gs-btn" onClick={submit}>
            등록
          </button>
        </div>
      </div>
    </div>
  );
}

/* 기타 빠른 등록 — 칸에서 숫자만 치고 Enter/등록. 사유는 선택이라 밑줄 버튼으로 빠집니다.
   사유 칸을 옆에 두면 폭이 두 배가 되고 탭 이동이 생겨서, 한 칸만 남겼습니다. */
function QuickExtra({ unitLabel, summary, value, onChange, onAdd, onReason, onList, onClose }) {
  const v = value;
  const setV = onChange;
  const ref = useRef(null);
  useEffect(() => {
    // 호버만으로 열리는 칸 — 다른 곳에 커서가 있으면 뺏지 않습니다
    const cur = document.activeElement;
    if (cur && cur !== document.body) return;
    ref.current?.focus();
    // 커서를 끝으로 — 돌아왔을 때 이어서 칠 수 있게
    const el = ref.current;
    if (el) el.setSelectionRange(el.value.length, el.value.length);
  }, []);
  const submit = () => {
    const g = num(v);
    if (g !== 0) onAdd(g);
    setV("");
    onClose(); // 등록이 곧 마무리 — 닫습니다
  };
  return (
    <div className="gs-qx" onMouseDown={(e) => e.stopPropagation()}>
      <div className="gs-qx-row">
        <input
          ref={ref}
          className="gs-in gs-qx-in"
          value={v}
          inputMode="decimal"
          placeholder="3"
          onChange={(e) => setV(formatNumInput(e.target.value, true))}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
            if (e.key === "Escape") onClose();
          }}
          aria-label={`기타 금액 (${unitLabel})`}
        />
        <em className="gs-qx-unit">{unitLabel}</em>
        <button className="gs-btn gs-btn-sm gs-qx-go" onClick={submit}>
          등록
        </button>
      </div>
      <div className="gs-qx-foot">
        {onList ? (
          <button className="gs-qx-why gs-qx-list" onClick={onList}>
            {summary}
          </button>
        ) : (
          <span />
        )}
        {/* 등록 바로 아래에 붙여, 숫자를 친 손이 그대로 내려오게 합니다 */}
        <button className="gs-qx-why" onClick={() => onReason(v)}>
          사유 추가
        </button>
      </div>
    </div>
  );
}

/* 항목 단가 — 입력 단위 기준으로 적고 보여 줍니다 (만G면 3 = 3만, 2.5 = 2만5,000).
   폭은 내용에 맞춰 줄어서, 단가 줄이 열 너비를 붙잡지 않습니다. */
/* 아직 센 기록이 없는 항목의 단가 — 항목명처럼 치는 대로 반영됩니다 */
function PriceFree({ gold, per, suffix, onChange }) {
  const [draft, setDraft] = useState(null);
  const shown = draft === null ? formatNumInput(String(+(gold / per).toFixed(4))) : draft;
  return (
    <span className="gs-pricewrap">
      <input
        className="gs-in gs-in-price"
        style={{ width: `calc(${Math.max(2, String(shown).length)}ch + 6px)` }}
        value={shown}
        inputMode="decimal"
        onFocus={(e) => {
          setDraft(shown);
          e.target.select();
        }}
        onChange={(e) => {
          const v = formatNumInput(e.target.value);
          setDraft(v);
          onChange(Math.round(num(v) * per));
        }}
        onBlur={() => setDraft(null)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === "Escape") e.target.blur();
        }}
        aria-label="1회당 단가"
      />
      <span className="gs-price-suffix">{suffix}</span>
    </span>
  );
}

/* 단가 창 — 값을 치면 두 선택지의 결과가 그 자리에서 갱신됩니다.
   '지금까지 N회는 얼마'라고 요약하지 않는 이유: 단가를 여러 번 바꿨다면 건마다 다른
   단가로 굳어 있어서, 보증할 수 있는 건 굳은 합(curG)과 새로 계산한 합(retroG)뿐입니다. */
function PriceModal({ col, rows, per, unitLabel, onApply, onClose }) {
  const oldG = Math.round(goldOf(col.price));
  const [draft, setDraft] = useState(formatNumInput(String(+(oldG / per).toFixed(4))));
  const ref = useRef(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
    const onKey = (e) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const n = rows.reduce((a, x) => a + num(x.counts[col.id]), 0);
  const curG = rows.reduce(
    (a, x) => (num(x.counts[col.id]) > 0 ? a + cellGold(x, col.id, oldG) : a),
    0
  );
  const newG = Math.round(num(draft) * per);
  const changed = draft.trim() !== "" && newG !== oldG;
  const retroG = n * newG;
  const item = col.name || "항목";
  return (
    <div
      className="gs-modal"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="gs-dialog gs-dialog-wide"
        role="dialog"
        aria-modal="true"
        aria-label={`${item} 1회 단가`}
      >
        <h3>{`'${item}' 1회 단가`}</h3>
        <div className="gs-pm-row">
          <span className="gs-pm-now">지금 {man(oldG)}</span>
          <span className="gs-pm-arrow" aria-hidden="true">→</span>
          <input
            ref={ref}
            className="gs-in gs-pm-in"
            value={draft}
            inputMode="decimal"
            onChange={(e) => setDraft(formatNumInput(e.target.value))}
            /* Enter 는 '이제부터'로 넣습니다 — 지난 횟수까지 바꾸는 건 되돌리기 어려워
               습관적인 Enter 로는 못 하게 합니다. 어느 쪽인지는 버튼에 적어 두었습니다. */
            onKeyDown={(e) => {
              if (e.key === "Enter" && changed) onApply(col, newG, false);
            }}
            aria-label={`1회당 단가 (${unitLabel})`}
          />
          <em className="gs-pm-unit">{unitLabel}</em>
        </div>
        <div className="gs-dialog-btns gs-pm-btns">
          <button
            className="gs-btn gs-btn-ghost"
            disabled={!changed}
            onClick={() => onApply(col, newG, true)}
          >
            지금까지 센 {commafy(n)}회도 {man(changed ? newG : oldG)}으로
            <em className={"gs-pm-sub" + (changed && retroG !== curG ? " on" : "")}>
              {changed && retroG !== curG ? `${man(curG)} → ${man(retroG)}` : ""}
            </em>
          </button>
          {/* Enter 가 누르는 버튼이라 그렇게 적어 둡니다 — 습관적으로 친 Enter 가
              무엇을 했는지 모르는 채로 지나가지 않게 */}
          <button className="gs-btn" disabled={!changed} onClick={() => onApply(col, newG, false)}>
            이제부터 세는 것만 {man(changed ? newG : oldG)}으로
            <em className="gs-pm-key">Enter</em>
          </button>
          <button className="gs-btn gs-btn-ghost" onClick={onClose}>
            취소
          </button>
        </div>
      </div>
    </div>
  );
}

/* 숫자 입력칸. 치는 대로 콤마가 붙고 커서는 방금 친 자리에 남습니다. */
function NumInput({ value, onChange, signed, ...rest }) {
  const ref = useRef(null);
  const caret = useRef(null);

  useEffect(() => {
    if (caret.current == null || !ref.current) return;
    const pos = caret.current;
    caret.current = null;
    try {
      ref.current.setSelectionRange(pos, pos);
    } catch (e) {
      /* number 타입 등 선택 범위를 못 잡는 환경 */
    }
  });

  const handle = (e) => {
    const raw = e.target.value;
    const sel = e.target.selectionStart ?? raw.length;
    const typed = raw.slice(0, sel).replace(/\D/g, "").length;
    const next = formatNumInput(raw, signed);
    caret.current = caretAfterDigits(next, typed);
    onChange(next);
  };

  return <input ref={ref} value={value} inputMode="decimal" onChange={handle} {...rest} />;
}

/* 송금 명세서 — 디스코드처럼 개행이 되는 곳에 붙일 용도.
   그대로 복사해도 되고, 창 안에서 고쳐서 복사해도 됩니다. */
function TextShare({ text, copied, onCopy, onClose }) {
  const ta = useRef(null);
  useEffect(() => {
    ta.current?.focus();
    ta.current?.select();
    const onKey = (e) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="gs-modal"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="gs-dialog gs-dialog-wide" role="dialog" aria-modal="true" aria-label="송금 명세서">
        <div className="gs-dialog-head">
          <h3>송금 명세서</h3>
          <button className="gs-x gs-dialog-x" onClick={onClose} aria-label="닫기">
            ×
          </button>
        </div>
        <p>디스코드 등에 붙여넣으세요. 고쳐서 복사해도 돼요.</p>
        <textarea ref={ta} className="gs-ta" defaultValue={text} spellCheck={false} />
        <div className="gs-dialog-btns">
          <button
            className={"gs-btn gs-copybtn" + (copied ? " is-copied" : "")}
            onClick={() => onCopy(ta.current.value)}
          >
            <span className="gs-copy-idle">복사</span>
            <span className="gs-copy-done">복사됨</span>
          </button>
        </div>
      </div>
    </div>
  );
}

/* 설명을 카드 안에서 펼치는 대신 띄우는 창 — 탭 화면에서 표가 밀리지 않게 팝업으로 봅니다 */
/* 정산 방식 고르기 — 벌금통(전부 모아 n빵) / 본인 제외(자기 벌금은 자기 빼고).
   '모드'와 같은 세그먼트 — 고르는 것들은 같은 얼굴을 하도록. */
function SplitPick({ value, onPick, readOnly, onHelp }) {
  return (
    <span className="gs-splitpick">
      <span className="gs-caplab">정산 방식</span>
      <div className="gs-seg" role="group" aria-label="정산 방식">
        {[
          ["pot", "벌금통", "전부 통에 넣고 전원이 똑같이 나눠요."],
          ["solo", "본인 제외", "자기 벌금은 자기만 빼고 나눠요. 낸 만큼 전부 잃어요."],
        ].map(([v, label, tip]) => (
          <button
            key={v}
            className={value === v ? "on" : ""}
            title={tip}
            onClick={() => !readOnly && onPick(v)}
          >
            {label}
          </button>
        ))}
      </div>
      <button className="gs-qm" onClick={onHelp} aria-label="정산 방식 설명" aria-haspopup="dialog">
        ?
      </button>
    </span>
  );
}

/* 정산 방식 설명 창 — 현재 표가 아니라 '현자들' 예시로 보여줍니다.
   실데이터는 극단값(한 명만 벌금)에서 그림이 안 서니까요. */
function SplitHelp({ onClose }) {
  const pot = computeSettlement(DEFAULT_ROWS, DEFAULT_COLS, "5", true, "pot");
  const solo = computeSettlement(DEFAULT_ROWS, DEFAULT_COLS, "5", true, "solo");
  return (
    <InfoModal title="정산 방식" onClose={onClose} wide>
      <p className="gs-split-lead">
        '현자들' 예시 표(8명, 벌금 합계 {man(pot.total)})로 두 방식을 비교해요. 누가 보내고
        누가 받는지는 두 방식이 같고, 금액만 달라져요.
      </p>
      <div className="gs-split-sec">
        <h4>벌금통</h4>
        <p>
          전원의 벌금을 통에 모아 전원이 똑같이 나눠요. 몫이 모두 {man(pot.shares[0])}으로
          같아서, 자기가 낸 벌금의 8분의 1은 자기에게 돌아와요.
        </p>
        <SplitViz fines={pot.fines} shares={pot.shares} total={pot.total} method="pot" />
      </div>
      <div className="gs-split-sec">
        <h4>본인 제외</h4>
        <p>
          자기 벌금은 자기만 빼고 나눠요. 낸 만큼 전부 잃고, 많이 낸 사람일수록 받는 몫이
          작아져요. 보내는 금액은 벌금통보다 조금 커져요.
        </p>
        <SplitViz fines={solo.fines} shares={solo.shares} total={solo.total} method="solo" />
      </div>
    </InfoModal>
  );
}

/* 정산 방식 그림 — 서로 다른 벌금이 통에 모여, 몫이 되어 돌아가는 흐름.
   막대 높이가 실제 금액입니다. */
function SplitViz({ fines, shares, total, method }) {
  if (!total) return null;
  const H = 34, W = 9, G = 5;
  const max = Math.max(...fines, ...shares, 1);
  const bars = (vals) =>
    vals.map((v, i) => {
      const h = Math.max(v > 0 ? 3 : 1.5, (v / max) * H);
      return (
        <rect
          key={i}
          x={i * (W + G)}
          y={H - h}
          width={W}
          height={h}
          rx={1.5}
          fill="currentColor"
          opacity={v > 0 ? 0.8 : 0.3}
        />
      );
    });
  const gw = fines.length * (W + G) - G;
  return (
    <div className="gs-splitviz">
      <span className="gs-sv-grp gs-sv-fines">
        <svg width={gw} height={H} aria-hidden="true">{bars(fines)}</svg>
        <em>낸 벌금</em>
      </span>
      <span className="gs-sv-arrow" aria-hidden="true">→</span>
      <span className="gs-sv-pot">
        <svg viewBox="0 0 26 28" width="23" height="25" aria-hidden="true">
          <path
            d="M8.5 2.5h9v3.4c3.9 2 6 5.4 6 10.1 0 6.1-4.6 9.5-10.5 9.5S2.5 22.1 2.5 16c0-4.7 2.1-8.1 6-10.1z"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
          />
        </svg>
        <em>벌금통 {man(total)}</em>
      </span>
      <span className="gs-sv-arrow" aria-hidden="true">→</span>
      <span className="gs-sv-grp gs-sv-shares">
        <svg width={gw} height={H} aria-hidden="true">{bars(shares)}</svg>
        <em>
          {method === "solo"
            ? "받을 몫 · 자기 벌금은 빼고"
            : `받을 몫 · 모두 ${man(shares[0])}`}
        </em>
      </span>
    </div>
  );
}

/* ---- 코치마크: 처음 한 번만 보여주는 안내 말풍선 ----
   규칙: 평생 1회 · 이미 그 기능을 써 본 사람에겐 안 띄움 · 클릭으로만 사라짐.
   배포 전부터 쓰던 사람도 플래그가 없으므로 한 번은 봅니다. */
const COACH_KEY = "goldSettlement.coach";
function coachSeen(k) {
  try {
    return !!JSON.parse(window.localStorage.getItem(COACH_KEY) || "{}")[k];
  } catch (e) {
    return true; // 저장이 안 되는 환경이면 아예 안 띄웁니다 (매번 뜨는 것보다 낫습니다)
  }
}
function coachDone(k) {
  try {
    const v = JSON.parse(window.localStorage.getItem(COACH_KEY) || "{}");
    v[k] = true;
    if (!DEMO) window.localStorage.setItem(COACH_KEY, JSON.stringify(v));
  } catch (e) {}
}

function coachReset(k) {
  try {
    const v = JSON.parse(window.localStorage.getItem(COACH_KEY) || "{}");
    delete v[k];
    if (!DEMO) window.localStorage.setItem(COACH_KEY, JSON.stringify(v));
  } catch (e) {}
}

/* 마우스 그림 — 눌러야 할 버튼 쪽이 칠해져 있습니다 */
function MouseIcon({ side }) {
  return (
    <svg className="gs-mouse" viewBox="0 0 14 20" width="13" height="18" aria-hidden="true">
      <rect x="1" y="1" width="12" height="18" rx="6" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <path d="M7 1 V9.5 M1 9.5 H13" stroke="currentColor" strokeWidth="1" fill="none" />
      {side === "left" ? (
        <path d="M7 1 A6 6 0 0 0 1 7 V9.5 H7 Z" fill="currentColor" />
      ) : (
        <path d="M7 1 A6 6 0 0 1 13 7 V9.5 H7 Z" fill="currentColor" />
      )}
    </svg>
  );
}

/* (폐기 2026-09-06) 옛 여섯 걸음 코스(COURSE_STEPS) — 예시 표를 진짜 장부에 덮고 되돌리던 방식. 원문은 OBS-SPEC §8 */

/* 화면별 사용법 (2026-09-06 사용자 요청) — 그 화면에 처음 왔을 때 1.5초 뒤 한 번(브라우저당), [?]에서 다시.
   한 화면에 하나, 모달이 열려 있으면 안 뜨고, 같이 해보기(예시) 중엔 안 뜹니다. 걸음은 전부 가리키기만([다음]) —
   진짜 판에서 뭔가를 누르게 하지 않습니다(칸 누르기는 같이 해보기가 예시 판에서 맡습니다). 문구는 전부 초안.
   (폐기 2026-09-06) 첫 방문 관문 `처음 오셨나요?`(닫을 수 없는 모달, 새 판을 누른 뒤에야 떴다) · [?]의 질문 답변 목록 ·
   옛 여섯 걸음 예시 코스(COURSE_STEPS — 위치 안내 둘을 빼고 단가·사람 아이콘을 넣어 아래 board 로 리뉴얼) */
/* (폐기 2026-09-06 밤, 사용자 확정) 화면별 사용법(GUIDES)·자수 사용법 — 방장 튜토리얼·파티원 튜토리얼(§3.9)로 통합. 원문은 OBS-SPEC §8 */

/* 튜토리얼 (2026-09-06 사용자 확정, 통합 가이드 — OBS-SPEC §3.9).
   방장 튜토리얼은 예시 앱(#demo)에서 1~7장, 8장은 파티원 예시 앱(#demo&member&ch8)이 이어받습니다.
   파티원 튜토리얼은 그 파티원 예시 앱 하나(#demo&member, 6걸음)이고 8장과 같은 걸음입니다.
   걸음 종류: wait(표적을 눌러야 넘어감) · action(가리키기, [다음]/[다음 장]) · wait:"auto"(기다림, 잠김).
   ch 는 장 번호(0부터). enter/exit 은 걸음에 들어설 때·나갈 때 하는 일. 문구는 전부 초안 */
/* 파티원 화면은 4장 — 파티원을 모은 직후, 벌금 세기 전에 (2026-09-06 낮 사용자 확정; (폐기) 맨 끝 8장) */
const TOUR_CHAPTERS = ["판 만들기", "항목과 단가", "파티원 모으기", "파티원 화면", "벌금 세기", "정산 보기", "방송에 띄우기", "끝내기와 기록"];
const HOST_STEPS = [
  /* 1장 */
  { ch: 0, sel: ".gs-lh-newbtn", text: "먼저 판을 만들어요. 파티원을 부르는 건 그다음이에요.", wait: "newboard" },
  /* 2장 — 가리키기만, 예시에서 고치게 하진 않습니다 */
  { ch: 1, sel: ".gs-grid thead .gs-colh-price", text: "1회 단가는 여기를 누르면 고쳐요. 항목 이름은 바로 위 글자를 누르면 되고요.", action: "다음", lock: true },
  /* 항목 추가는 직접 (2026-09-06 사용자 확정) — [+ 항목] → 보통 항목 → 새 열의 이름·단가를 적음. 새 열 id 는 예시에서 ctut 로 고정해 가리킵니다 */
  /* 더하는 항목은 암살 10만 (2026-09-06 낮 사용자; (폐기, 같은 날) 낙사 2만) — 옛 벌금판 예시의 셋째 열이라 5장 숫자가 그대로 맞습니다 */
  { ch: 1, sel: ".gs-addcol", text: "이번엔 암살도 세 볼까요? 항목을 하나 더 만들어요.", wait: "addcol:open" },
  { ch: 1, sel: ".gs-modal .gs-coltype .gs-coltype-pick:first-child", text: "보통 항목을 골라요.", wait: "addcol:done", top: true },
  { ch: 1, sel: ".gs-grid thead .gs-colh[data-col='ctut'] .gs-in-col", text: "새 열이 생겼어요. 이름 칸에 암살이라고 적고 [다음].", action: "다음" },
  { ch: 1, sel: ".gs-grid thead .gs-colh[data-col='ctut'] .gs-in-price", text: "1회 10만이면 10. 적고 [다음]. 항목 이름 옆 ×를 눌러, 항목을 삭제할 수도 있어요.", action: "다음" }, // 사용자 지정 문구 (2026-09-06 낮; (폐기) `지우는 건 항목 이름 옆 ×.`)
  { ch: 1, sel: ".gs-readytools .gs-seg", text: "인원은 여기서 정해요. 늦게 오는 사람은 나중에 줄을 늘려도 돼요.", action: "다음 장", lock: true, enter: "colfix" },
  /* 3장 */
  { ch: 2, sel: ".gs-invlinkbtn", text: "초대 링크를 복사해서 디코에 붙이면 돼요. 보내는 건 이번엔 저희가 대신할게요.", wait: "link" },
  { ch: 2, sel: ".gs-recruit", text: "보냈어요. 사람들이 들어올 거예요…", lock: true, wait: "auto", after: "다음" }, // 둘이 앉으면 [다음] — (폐기 2026-09-06 낮) 5.4초 뒤 자동
  { ch: 2, sel: ".gs-glow", text: "두 명 왔어요. 한 명은… 안 들어오네요. 그냥 시작해 보죠.", wait: "start" },
  /* 4장 파티원 화면 — 이 걸음에 들어서면 부모가 파티원 예시 앱을 위에 얹습니다. 돌아오면(party-demo-resume) 실리안의 잡힘 1이 올라오고 다음 걸음 */
  { ch: 3, sel: ".gs-grid", text: "시작했어요. 그런데 실리안 쪽에선 어떻게 보였을까요? 링크를 받았을 때부터 볼게요.", lock: true, action: "실리안의 화면 보기", exit: "handoff" }, // (폐기 2026-09-06 낮) `시작했어요. 이제 실리안의 화면으로 가 볼게요.` 자동 — 뜬금없다(사용자)
  /* 5장 벌금 세기 — 4장에서 실리안이 누른 잡힘 1이 올라온 채 시작합니다 (2026-09-06 낮 사용자 확정 "1안").
     (폐기, 같은 날) 방장이 먼저 누르고 3초 뒤 실리안 자수가 오던 두 걸음 `올라갔죠? 파티원은 자기 줄을 자수 탭에서 직접 눌러요. 실리안이 지금 누르는 중…` · `실리안이 자수했어요. 파티원이 누른 건 이렇게 올라와요.` */
  {
    ch: 4,
    /* 표적은 방장 줄 — 표 전체를 잡으면 말풍선이 표 아래로 가서 돌아온 직후 화면이 내려갑니다(2026-09-06 낮: 복귀는 맨 위부터) */
    sel: ".gs-grid tbody tr:first-child",
    text: (
      <>
        실리안이 자수한 잡힘 1회가 올라와 있죠? 방장은 칸을 직접 눌러요. <MouseIcon side="left" /> 누르면 1회, <MouseIcon side="right" /> 우클릭하면 되돌려요. 한번 눌러 보세요.
      </>
    ),
    wait: "press",
  },
  { ch: 4, sel: ".gs-grid", text: "올라갔죠? 파티원이 자수한 것과 방장이 누른 게 한 표에 쌓여요.", lock: true, action: "다음" },
  /* (폐기 2026-09-06 낮) 룰렛 머리 가리키기 `룰렛 항목은 방장이 칸을 눌러 돌려요. 나온 숫자 × 단가가 벌금이에요.` — 사용자: 튜토리얼에서 룰렛은 뺌 */
  { ch: 4, sel: ".gs-rowi", text: "이름 옆 사람 아이콘. 줄을 옮기거나 파티에서 내보낼 땐 여기예요.", action: "다음", lock: true },
  /* 웨이는 이 걸음에 들어설 때 옵니다 (2026-09-06 낮; (폐기) 사람 아이콘 걸음에서 — 가리키기와 더미 움직임이 섞였다) */
  { ch: 4, sel: ".gs-waitrow", text: "웨이가 늦게 왔어요. 진행 중에 들어온 사람은 방장이 직접 자리를 정해 줘야 해요. [자리 정하기]를 눌러요.", wait: "pick", enter: "wei" }, // (폐기 2026-09-06 낮) `…표 아래에 서 있죠? [자리 정하기]로 줄을 골라 앉혀요.` — 사용자: 이상함
  { ch: 4, sel: ".gs-modal .gs-waitpick .gs-seatopt:not(.gs-seatopt-new)", text: "빈 줄, 퇴장한 사람 줄, 새 줄 중에 골라요. (모험가4) 줄을 눌러 볼까요?", wait: "take", top: true },
  /* 5장 — 쌓인 데이터로 봅니다 */
  /* after — 채우기가 끝나면(4.5초) 그제야 [다음]이 나타나고, 넘어가는 건 사용자 몫 (2026-09-06 낮 사용자: 템포; (폐기) 4.5초 뒤 자동) */
  { ch: 5, sel: ".gs-grid", text: "한 판 돌았다고 칠게요… 넷이 더 들어와 여덟이 됐어요.", lock: true, wait: "auto", after: "다음", enter: "seed" },
  /* 정산 내역이 어두운 막에 가리면 안 됩니다 — 이 장은 막 없이 (2026-09-06 사용자) */
  { ch: 5, sel: ".gs-tab-ledger", text: "누른 게 사람별로 정산돼 있어요. 수수료와 나누는 방식도 여기서 정해요.", wait: "tab:ledger", clear: true },
  { ch: 5, sel: ".gs-tab-mail", text: "누가 누구에게 얼마 보낼지예요. 디코에 붙일 글도 여기서 복사해요.", wait: "tab:mail", clear: true },
  { ch: 5, sel: ".gs-tab-sheet", text: "벌금표로 돌아갈게요.", wait: "tab:sheet", clear: true },
  { ch: 5, sel: ".gs-logbtn", text: "누른 기록이 전부 남아요. 잘못 누른 건 여기서 취소해요.", action: "다음 장", lock: true, clear: true },
  /* 6장 — 발급까지 */
  { ch: 6, sel: ".gs-obsbtn", text: "방송에 띄우려면 여기예요.", wait: "obs" },
  { ch: 6, sel: ".gs-modal .gs-authgo", text: "주소는 계정마다 하나예요. 없으면 여기서 받아요. 게스트도 돼요.", wait: "obsgot", top: true },
  { ch: 6, sel: ".gs-modal .gs-obs-addrbox", text: "이게 내 방송용 주소예요. 파티가 바뀌어도 그대로. [복사]로 가져가요.", action: "다음", lock: true, top: true },
  { ch: 6, sel: ".gs-modal .gs-obs-lineact", text: "브라우저 소스로 넣는 법은 여기. 한 번만 넣으면 돼요.", action: "다음 장", lock: true, top: true, exit: "closeObs" },
  /* 7장 — 예시 안에서 진짜 끝내기 흐름 */
  { ch: 7, sel: ".gs-endbtn", text: "다 끝나면 여기예요.", wait: "endask" },
  { ch: 7, sel: ".gs-dialog .gs-btn:not(.gs-btn-ghost)", text: "결과지가 판 기록에 남아요. 끝낼게요.", wait: "ended", top: true },
  /* (폐기 2026-09-06, 같은 날) 결과지 머리 가리키기 `결과지예요. 파티원도 같은 걸 봐요.` — 사용자: 박스가 이상, 그냥 빼자 */
  { ch: 7, sel: ".gs-mast .gs-btn-ghost", text: "닫으면 로비로 가요. 이 판은 판 기록에 남아요.", wait: "genclose" }, // 기록 언급 (2026-09-06 낮 사용자; (폐기) `닫으면 로비로 가요.`)
  { ch: 7, sel: ".gs-lh-recs", text: "끝난 판은 여기 남아요. 결과지를 다시 볼 수 있어요. 여기까지예요.", action: "다 봤어요", lock: true }, // (폐기 2026-09-06 낮) `…이제 들어온 파티원이 보는 화면을 볼게요.` [다음 장] → 8장
];
/* 8장 = 파티원 튜토리얼 — 파티원 예시 앱에서 돕니다 */
const MEMBER_STEPS = [
  /* "이 화면"과 자수는 두 걸음 (2026-09-06 낮 사용자; (폐기) 한 걸음) */
  { ch: 7, sel: ".gs-confbox", text: "들어온 파티원은 이 화면을 봐요. 자기 줄만 있어요.", action: "다음", lock: true, clear: true },
  {
    ch: 7,
    sel: ".gs-confcard-c2",
    text: (
      <>
        이번 판에 죽었군요. 죽음 칸을 <MouseIcon side="left" /> 눌러 자수해 봐요.
      </>
    ),
    wait: "confess:c2",
  },
  /* (폐기 2026-09-06 낮) `방장 벌금판에 바로 올라갔어요.` 2.2초 자동 걸음 — 다음 말풍선에 합침 */
  {
    ch: 7,
    sel: ".gs-confcard-c2",
    text: (
      <>
        방장 벌금판에 바로 올라갔어요. 아, 그런데 잡힌 거였네요. 죽음 칸을 <MouseIcon side="right" /> 우클릭해서 되돌려요. 되돌리기는 30초 안에만 할 수 있어요.
      </>
    ),
    wait: "unconfess:c2",
  },
  {
    ch: 7,
    sel: ".gs-confcard-c1",
    text: (
      <>
        되돌렸어요. 이제 잡힘 칸을 <MouseIcon side="left" /> 눌러요.
      </>
    ),
    wait: "confess:c1",
  },
  { ch: 7, sel: ".gs-tab-sheet", text: "방장 표는 여기서 봐요. 정산 장부와 보낼 우편도 같이 보여요.", action: "다음", lock: true },
  { ch: 7, sel: ".gs-obsbtn", text: "내 방송에도 이 판을 띄울 수 있어요. 여기서요.", wait: "obs" },
  { ch: 7, sel: ".gs-modal .gs-authgo", text: "주소는 계정마다 하나예요. 없으면 여기서 받아요. 게스트도 돼요.", wait: "obsgot", top: true },
  { ch: 7, sel: ".gs-modal .gs-obs-addrbox", text: "이게 내 방송용 주소예요. OBS 브라우저 소스에 한 번만 넣으면 파티가 바뀌어도 그대로예요.", action: "알겠어요", lock: true, top: true, exit: "closeObs" },
];
/* 방장 튜토리얼 4장(파티원 화면) — 실리안이 링크를 눌렀을 때의 초대장부터, 자수와 정정까지만 (2026-09-06 낮 사용자: "초대의 룩 → 자수, 정정" 이 정도만).
   독립 파티원 튜토리얼(MEMBER_STEPS)과 달리 OBS 걸음이 없고, 끝나면 방장 예시로 돌아갑니다. 문구는 초안 */
const MEMBER_INHOST = [
  { ch: 3, sel: ".gs-invite", text: "실리안이 링크를 열었을 때 뜬 초대장이에요. 그땐 방장만 앉아 있었죠. [참여하기]를 눌러요.", wait: "join" },
  /* "이 화면"과 자수는 두 걸음 (2026-09-06 낮 사용자; (폐기) 한 걸음에 `…자기 줄만 있어요. 이번 판에 죽었군요. 죽음 칸을 눌러 자수해 봐요.`) */
  { ch: 3, sel: ".gs-confbox", text: "들어왔어요. 방장이 시작하면 이 화면이 떠요. 자기 줄만 있어요.", action: "다음", lock: true, clear: true },
  {
    ch: 3,
    sel: ".gs-confcard-c2",
    text: (
      <>
        이번 판에 죽었군요. 죽음 칸을 <MouseIcon side="left" /> 눌러 자수해 봐요.
      </>
    ),
    wait: "confess:c2",
  },
  /* (폐기 2026-09-06 낮) `방장 벌금판에 바로 올라갔어요.` 2.2초 자동 걸음 — 다음 말풍선에 합침 */
  {
    ch: 3,
    sel: ".gs-confcard-c2",
    text: (
      <>
        방장 벌금판에 바로 올라갔어요. 아, 그런데 잡힌 거였네요. 죽음 칸을 <MouseIcon side="right" /> 우클릭해서 되돌려요. 되돌리기는 30초 안에만 할 수 있어요.
      </>
    ),
    wait: "unconfess:c2",
  },
  {
    ch: 3,
    sel: ".gs-confcard-c1",
    text: (
      <>
        되돌렸어요. 이제 잡힘 칸을 <MouseIcon side="left" /> 눌러요.
      </>
    ),
    wait: "confess:c1",
  },
  { ch: 3, sel: ".gs-confcard-c1", text: "올라갔어요. 이제 방장 화면으로 돌아가서 볼게요.", lock: true, action: "방장 화면으로" },
];
const TOUR_FLOW = DEMO_CH4 ? MEMBER_INHOST : DEMO_MEMBER ? MEMBER_STEPS : HOST_STEPS;
/* 파티원 예시의 판 — 방장 예시가 끝난 시점 그대로 */
const TUT_ROWS = (host) => [
  { id: "r1", name: host, counts: { c1: "1" }, extras: [] },
  { id: "r2", name: "실리안", counts: { c1: "1" }, extras: [] },
  { id: "r3", name: "니나브", counts: {}, extras: [] },
  { id: "r4", name: "웨이", counts: {}, extras: [] },
];
const TUT_MEMBERS = [
  { acct: "silian", nick: "실리안" },
  { acct: "ninav", nick: "니나브" },
  { acct: "wei", nick: "웨이" },
];
/* 5장에 더 들어오는 넷 — 숫자는 옛 예시(DEFAULT_PEOPLE) 뒤 넷 그대로, 이름은 사용자 지정 8인 라벨(2026-09-06:
   니나브 웨이 실리안 샨디 아제나 이난나 바훈투르 카단)에서 아직 안 쓴 것 순서대로. 방장 줄까지 여덟이라 카단은 뺍니다(사용자 확정) */
const TUT_EXTRA = [
  { acct: "shandi", nick: "샨디" },
  { acct: "azena", nick: "아제나" },
  { acct: "inanna", nick: "이난나" },
  { acct: "bahuntur", nick: "바훈투르" },
];
/* 로비 권유 줄의 대상 — 초대 없이 들어온 사람. 초대 링크로 들어온 적이 있으면(코드 기억) 파티원이라 안 권합니다 */
const cameByInvite = () => {
  try {
    return Object.keys(window.localStorage).some((k) => k.startsWith("goldSettlement.joincode."));
  } catch (e) {
    return true;
  }
};

/* block: 대상 말고는 못 누르게 막고 나머지를 어둡게 덮습니다.
   lock: 대상까지 막습니다 — 말풍선의 버튼으로만 넘어가는 걸음용. */
function CoachMark({ sel, text, action, step, total, block, lock, center, overModal, clear, onNext, onClose }) {
  const [box, setBox] = useState(null);
  /* 그린 뒤에 실제 높이를 재서 다시 앉힙니다 — 어림값으로 두면 걸음마다 틈이 달라집니다 */
  const bubRef = useRef(null);
  const [bh, setBh] = useState(0);
  const doneRef = useRef(onClose);
  doneRef.current = onClose;
  const nextRef = useRef(onNext);
  nextRef.current = onNext;

  /* 안내 중에는 대상 밖이 안 눌립니다. 화면 위에 판을 덮는 대신 문서에서 가로채는데,
     그래야 대상이 표처럼 크거나 여러 개여도 구멍을 뚫을 필요가 없습니다.
     스크롤은 막지 않습니다 — 표가 화면보다 길면 내려서 봐야 합니다. */
  useEffect(() => {
    if (!block) return;
    const ok = (t) => {
      if (!t || !t.closest) return false;
      if (t.closest(".gs-coach")) return true; // 말풍선과 그 버튼은 늘 열려 있습니다
      if (t.closest(".gs-demoband")) return true; // 예시 띠의 [그만두기]도 — 걸음이 막고 있어도 나가는 길 (2026-09-06)
      return !lock && !!t.closest(sel);
    };
    const stop = (e) => {
      if (ok(e.target)) return;
      /* 보기 걸음(잠긴 표적 + [다음])에서 표적을 누르면 [다음]과 같습니다 — 누르고 싶은 본능을 벌하지 않습니다 (2026-09-06 낮 사용자 확정).
         원래 동작은 여전히 막힙니다 */
      if (lock && action && e.type === "click" && e.target && e.target.closest && e.target.closest(sel)) {
        e.preventDefault();
        e.stopPropagation();
        if (nextRef.current) nextRef.current();
        return;
      }
      e.preventDefault();
      e.stopPropagation();
    };
    const kinds = ["pointerdown", "mousedown", "mouseup", "click", "dblclick", "contextmenu"];
    kinds.forEach((k) => document.addEventListener(k, stop, true));
    return () => kinds.forEach((k) => document.removeEventListener(k, stop, true));
  }, [block, lock, sel, action]);

  useLayoutEffect(() => {
    const el = bubRef.current;
    if (el && el.offsetHeight && el.offsetHeight !== bh) setBh(el.offsetHeight);
  });

  /* Esc 도 X 와 같습니다 — 갇힌 느낌이 들지 않게 나가는 길을 둘 둡니다 */
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") doneRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    setBox(null);
    setBh(0);
    const first = document.querySelector(sel);
    /* 창만 세로로 움직입니다 — scrollIntoView 는 표 같은 안쪽 스크롤 상자까지 가로로 밀어서 채워지는 칸이 안 보였습니다 (2026-09-06 사용자).
       표적과 그 아래 말풍선 자리(약 130px)가 다 보이면 그대로 둡니다. (폐기, 같은 날) center 옵션 — 스크롤이 튄다(사용자) */
    if (first) {
      const r = first.getBoundingClientRect();
      /* 화면 아래 110px 은 토스트 자리 — 말풍선이 거기 앉으면 토스트에 가립니다(2026-09-06 낮 사용자). 토스트를 옮기는 대신 말풍선이 비킵니다 */
      const bottom = window.innerHeight - 110;
      const need = Math.min(r.height + 130, bottom - 32);
      let dy = 0;
      if (r.top < 16) dy = r.top - 16;
      else if (r.top + need > bottom) dy = Math.min(r.top - 16, r.top + need - bottom);
      if (dy) window.scrollBy(0, dy);
    }
    let raf = 0;
    let miss = 0;
    let last = "";
    /* 한 번 재고, 계속 따라다닐지를 돌려줍니다 */
    const look = () => {
      const el = document.querySelector(sel);
      if (!el) {
        /* 탭이 바뀌는 찰나처럼 잠깐 없을 수 있습니다. 바로 접으면 그 한 순간에
           안내가 통째로 끝나고, 코스는 본 것으로 기록됩니다. 한 박자 기다립니다. */
        if (++miss > 60) {
          doneRef.current();
          return false;
        }
        return true;
      }
      miss = 0;
      const r = el.getBoundingClientRect();
      /* 칸을 누르면 숫자가 바뀌며 열 너비가 움직입니다 — 창 크기와 스크롤만 봐서는
         테두리가 어긋난 채 남습니다. 값이 달라졌을 때만 다시 그립니다. */
      const key = r.left + "," + r.top + "," + r.width + "," + r.height;
      if (key !== last) {
        last = key;
        setBox({ x: r.left, y: r.top, w: r.width, h: r.height });
      }
      return true;
    };
    /* 첫 자리는 그 자리에서 잽니다. 프레임 콜백은 탭이 뒤로 가면 멈추는데,
       그때 안내가 뜨면 말풍선이 영영 안 나옵니다. 따라다니기만 프레임에 맡깁니다. */
    look();
    const loop = () => {
      if (look()) raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [sel]);
  if (!box) return null;
  const W = 300;
  const H = bh || 120; // 첫 그림만 어림값, 그다음부터는 잰 높이입니다
  const GAP = 14;
  /* 대상이 말풍선보다 넓으면 가운데에 맞춥니다 — 표처럼 넓은 것에 왼쪽 끝을 맞추면
     꼬리가 저 멀리 한쪽 끝을 가리켜 어디를 말하는지 알 수 없습니다. */
  const wide = box.w > W;
  const wantLeft = wide ? box.x + box.w / 2 - W / 2 : box.x - 8;
  const left = Math.max(10, Math.min(wantLeft, window.innerWidth - W - 10));
  /* 아래가 좁으면 위로 뒤집습니다. 잰 높이를 쓰니 어느 쪽이든 대상에서 딱 GAP 만큼
     떨어집니다. 위아래 어디에도 자리가 없을 때만 화면 안으로 가둡니다 —
     그때는 어두운 판 위에 얹히는데, 잘려서 안 보이는 것보다 낫습니다. */
  const below = box.y + box.h + GAP;
  const above = box.y - GAP - H;
  const up = below + H > window.innerHeight - 10 && above >= 10;
  const want = up ? above : below;
  const top = Math.max(10, Math.min(want, window.innerHeight - H - 10));
  /* 자리를 옮겼으면 꼬리는 대상을 안 가리킵니다 — 엉뚱한 데를 찌르느니 뗍니다 */
  const tail = top === want;
  return (
    <div className={"gs-coach" + (block ? " gs-coach-pass" : "") + (overModal ? " gs-coach-top" : "")}
      onMouseDown={(e) => !block && e.target === e.currentTarget && onClose()}
    >
      {/* 대상만 남기고 덮습니다 — 어두운 곳은 눌러도 안 되는 곳입니다 */}
      {block && (
        <div
          className={"gs-coach-hole" + (clear ? " gs-coach-hole-clear" : "")}
          style={{ left: box.x - 6, top: box.y - 6, width: box.w + 12, height: box.h + 12 }}
        />
      )}
      {/* 하기 걸음(표적을 눌러야 넘어감)만 테두리가 숨 쉽니다 — 보기·기다림 걸음은 가만히 (2026-09-06 낮 사용자 확정: 두 종류가 한눈에 갈리게) */}
      <div
        className={"gs-coach-ring" + (!lock && !action ? " gs-coach-ring-act" : "")}
        style={{ left: box.x - 5, top: box.y - 5, width: box.w + 10, height: box.h + 10 }}
      />
      <div ref={bubRef} className={"gs-coach-bubble" + (up ? " up" : "")} style={{ left, top }}>
        {tail && (
          <span
            className="gs-coach-tail"
            style={{ left: Math.max(14, Math.min(W - 26, box.x + box.w / 2 - left - 6)) }}
            aria-hidden="true"
          />
        )}
        <button className="gs-coach-x" onClick={onClose} aria-label="안내 끄기">
          ✕
        </button>
        <p>{text}</p>
        <div className="gs-coach-btns">
          {action && (
            <button className="gs-btn gs-btn-sm" onClick={onNext}>
              {action}
            </button>
          )}
          {/* 하기 걸음 — 버튼 자리에 옅은 글씨로 (2026-09-06 낮 사용자 확정) */}
          {!action && !lock && <em className="gs-coach-hint">직접 눌러 보세요</em>}
          {total && (
            <em className="gs-coach-step" aria-hidden="true">
              {step}/{total}
            </em>
          )}
        </div>
      </div>
    </div>
  );
}

/* 검증된 오버레이 조합 — 칩의 사선 배경(밝은/어두운 화면 반반) 위에 실제 모습을 미리 보여줍니다 */
/* 2×3 격자 — 윗줄은 어두운 계열(밝은 화면에 강함), 아랫줄은 밝은 계열(어두운 화면에 강함).
   열은 [반투명 판 | 판 | 판 없이]로 통일. 왼쪽 위가 기본값입니다. */
/* 앞의 둘만 펼쳐 두고 나머지는 접습니다. 판의 진하기는 아래 투명도가 맡으므로
   '판'과 '판·반투명'을 따로 두지 않습니다. */
const LOOK_PRESETS = [
  { id: "goat", name: "어두운 판 (추천)", look: { t: "dark", alpha: 25 } },
  { id: "light25", name: "밝은 판", look: { t: "light", alpha: 25 } },
  /* 헤어라인 (2026-09-06 사용자 확정) — 판 테두리 한 줄과 줄 사이 실선. 어두운 판엔 밝은 선, 밝은 판엔 어두운 선. 이름은 초안 */
  { id: "goatline", name: "어두운 판 · 테두리", look: { t: "dark", alpha: 25, line: 1 } },
  { id: "light25line", name: "밝은 판 · 테두리", look: { t: "light", alpha: 25, line: 1 } },
  { id: "clear", name: "판 없이 · 밝은 글자", look: { t: "clear" } },
  { id: "cleardark", name: "판 없이 · 진한 글자", look: { t: "cleardark" } },
];
const LOOK_OPEN = 2; // 처음부터 보이는 개수
const isPanelLook = (lk) => !!lk && (lk.t === "dark" || lk.t === "light");
/* 서버가 읽는 키는 t·bg·s 셋뿐입니다 — 앱이 쓰는 alpha(판 투명도)와 bg 는 서로 뒤집힌 값입니다 */
const lookIn = (srv) => {
  const a = srv && srv.bg != null ? 100 - Math.round(srv.bg) : 25;
  return { t: srv.t, alpha: [0, 25, 50, 75, 100].includes(a) ? a : 25, line: srv.line ? 1 : undefined };
};
const sameLook = (a, b) =>
  !!a && !!b && a.t === b.t && !!a.line === !!b.line && (!isPanelLook(a) || (a.alpha ?? 25) === (b.alpha ?? 25));

function LookPicker({ look, onPick }) {
  const [more, setMore] = useState(false);
  /* 접혀 있어도 지금 고른 테마는 늘 보입니다 — 현재 값이 안 보이면 안 되니까요 */
  const shown = more
    ? LOOK_PRESETS
    : LOOK_PRESETS.filter(
        (pr, i) => i < LOOK_OPEN || sameLook(look, pr.look)
      );
  return (
    <>
      <div className="gs-lookgrid" role="group" aria-label="오버레이 테마">
        {shown.map((pr) => (
          <button
            key={pr.id}
            className={"gs-lookchip" + (sameLook(look, pr.look) ? " on" : "")}
            onClick={() => onPick({ ...pr.look })}
          >
            <span className={"gs-lookswatch sw-" + pr.id} aria-hidden="true">
              <b>가나 12만</b>
            </span>
            {pr.name}
          </button>
        ))}
      </div>
      <button className="gs-lookmore" onClick={() => setMore((v) => !v)}>
        {more ? "접기" : "다른 테마와 투명도"}
      </button>
      {more && (
      <div className={"gs-lookalpha" + (isPanelLook(look) ? "" : " off")}>
        <span className="gs-caplab">배경 투명도</span>
        <div className="gs-seg gs-seg-sm" role="group" aria-label="배경 투명도">
          {[0, 25, 50, 75, 100].map((a) => (
            <button
              key={a}
              disabled={!isPanelLook(look)}
              className={isPanelLook(look) && (look.alpha ?? 25) === a ? "on" : ""}
              onClick={() => onPick({ ...look, alpha: a })}
            >
              {a}
            </button>
          ))}
        </div>
        {!isPanelLook(look) && <span className="gs-lookalpha-note">판이 있는 테마에서 조절돼요</span>}
      </div>
      )}
    </>
  );
}

function InfoModal({ title, onClose, children, wide, headExtra }) {
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="gs-modal"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className={"gs-dialog" + (wide ? " gs-dialog-wide" : "")}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="gs-dialog-head">
          <h3>{title}</h3>
          {headExtra}
          <button className="gs-x gs-dialog-x" onClick={onClose} aria-label="닫기">
            ×
          </button>
        </div>
        <div className="gs-dialog-body">{children}</div>
      </div>
    </div>
  );
}

/* 되돌릴 수 없는 조작 앞에 한 번 물어보는 창 */
function Confirm({ ask, onCancel, onDone }) {
  const yesRef = useRef(null);
  useEffect(() => {
    yesRef.current?.focus();
    const onKey = (e) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <div
      className="gs-modal"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div
        className={"gs-dialog" + (ask.alt ? " gs-dialog-wide" : "")}
        role="alertdialog"
        aria-modal="true"
        aria-label={ask.title}
      >
        <h3>{ask.title}</h3>
        {ask.body && <p>{ask.body}</p>}
        <div className="gs-dialog-btns">
          {/* 취소는 맨 왼쪽 — 주 동작이 오른쪽 끝에 앉습니다 (§9-3) */}
          <button className="gs-btn gs-btn-ghost" onClick={onCancel}>
            취소
          </button>
          {/* 선택지가 둘인 경우(단가 변경) — 되돌리기 어려운 쪽을 유령 버튼으로 둡니다 */}
          {ask.alt && (
            <button
              className="gs-btn gs-btn-ghost"
              onClick={() => {
                ask.alt.onPick();
                onDone();
              }}
            >
              {ask.alt.label}
              {ask.alt.sub && <em>{ask.alt.sub}</em>}
            </button>
          )}
          {/* 빨강은 되돌릴 수 없는 것에만입니다 (§9-4) — 나머지는 채운 금색입니다.
              물음이 무거워 보이는 것과 실제로 위험한 것은 다릅니다 */}
          <button
            ref={yesRef}
            className={"gs-btn" + (ask.tone === "danger" ? " gs-btn-danger" : "")}
            onClick={() => {
              ask.onYes();
              onDone();
            }}
          >
            {ask.action || "삭제"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* 장부 한 칸: '21만5000' 을 크게, 원래 숫자는 아래에 작고 흐리게 */
function Amount({ v, sign, className = "" }) {
  const plus = sign && v > 0 ? "+" : "";
  return (
    <td className={className}>
      <span className="gs-man">
        {plus}
        {man(v)}
      </span>
      <span className="gs-raw">
        {plus}
        {won(v)}
      </span>
    </td>
  );
}

/* 기타 벌금 편집기 — 표 안의 칸을 누르면 그 아래로 펼쳐집니다 */
function Discretion({ who, extras, onAdd, onPatch, onFix, onRemove, onClose }) {
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");

  const submit = () => {
    if (!Math.round(goldOf(amount))) return;
    onAdd(amount, reason.trim());
    setAmount("");
    setReason("");
  };
  const onKey = (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div className="gs-ex">
      <div className="gs-ex-head">
        <span className="gs-ex-who">{who || "이름 없음"}</span>
        <span className="gs-ex-cap">기타 벌금</span>
        <button className="gs-fold" onClick={onClose}>
          접기
        </button>
      </div>

      {extras.length > 0 && (
        <ul className="gs-ex-list">
          {extras.map((e) => (
            <li key={e.id}>
              <NumInput
                className="gs-in gs-ex-amt"
                value={e.amount}
                signed
                onChange={(v) => onPatch(e.id, "amount", v)}
                onBlur={() => onFix(e.id)}
                aria-label="기타 벌금 금액"
              />
              <span className="gs-ex-g">G</span>
              <input
                className="gs-in gs-ex-why"
                value={e.reason}
                placeholder="사유(ex. 암살 등. 비워두셔도 돼요.)"
                onChange={(ev) => onPatch(e.id, "reason", ev.target.value)}
                aria-label="기타 벌금 사유"
              />
              <button className="gs-x" onClick={() => onRemove(e)} aria-label="이 건 삭제">
                ×
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="gs-ex-add">
        <NumInput
          className="gs-in gs-ex-amt"
          value={amount}
          placeholder="100,000"
          signed
          onChange={setAmount}
          onKeyDown={onKey}
          aria-label="추가할 금액"
        />
        <span className="gs-ex-g">G</span>
        <input
          className="gs-in gs-ex-why"
          value={reason}
          placeholder="사유(ex. 암살 등. 비워두셔도 돼요.)"
          onChange={(e) => setReason(e.target.value)}
          onKeyDown={onKey}
          aria-label="추가할 사유"
        />
        <button className="gs-btn gs-btn-sm" onClick={submit}>
          추가
        </button>
      </div>

    </div>
  );
}

/* 보내는 사람 한 명 = 카드 한 장. 받는 사람은 카드 안에서 줄로 나뉩니다. */
/* 받는 사람 줄의 key 는 이름이 아니라 순번입니다 — 동명이인이면 이름이 겹쳐서
   줄이 빠지거나 섞입니다. 이름을 못 겹치게 막아 두었지만, 여기도 같이 받쳐 둡니다. */
function Envelope({ idx, from, items, total, fee, feePct }) {
  return (
    <article className="gs-env" style={{ "--i": idx }}>
      <div className="gs-env-air">
        <div className="gs-env-body">
          <div className="gs-env-main">
            <div className="gs-addr">
              <span className="gs-addr-lab">보내는 사람</span>
              <span className="gs-addr-nm">{from}</span>
            </div>

            <ul className="gs-lines">
              {items.map((t, i) => (
                <li key={i}>
                  <span className="gs-line-who">
                    <span className="gs-addr-lab">받는 사람</span>
                    <span className="gs-line-nm">{t.to}</span>
                  </span>
                  <span className="gs-line-money">
                    <span className="gs-line-amt">{won(t.amount)}</span>
                    <span className="gs-line-unit">G</span>
                    <em>받는 금액 {G(t.received)}</em>
                  </span>
                </li>
              ))}
            </ul>

            <div className="gs-env-foot">
              우편 {items.length}통 · 보낼 금액 <b>{G(total)}</b>
            </div>
          </div>
          <div className="gs-stamp" aria-hidden="true">
            <span className="gs-stamp-lab">수수료</span>
            <span className="gs-stamp-num">{won(fee)}</span>
            <span className="gs-stamp-pct">{feePct || 0}%</span>
          </div>
          <div className="gs-mark" aria-hidden="true">
            <span>정산</span>
          </div>
        </div>
      </div>
    </article>
  );
}

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Gowun+Batang:wght@400;700&family=IBM+Plex+Sans+KR:wght@400;500;600&family=Cutive+Mono&display=swap');

/* 낮 팔레트 — 크라프트 종이. 알파가 붙는 색은 삼원색만 변수로 두어
   어두운 팔레트에서 통째로 갈아끼울 수 있게 했습니다. */
.gs{
  --kraft:#c3a97f; --kraft-dk:#a2865a;
  --paper:#f1e9d9; --paper-2:#e4d7bd; --paper-3:#e8ddc6;
  --ink:#221d17; --ink-2:#6d6152; --ink-body:#4a4136; --ink-hover:#3a322a;
  --red:#9c2b22; --red-dk:#7d211a; --blue:#23486b; --gold:#8a6415;
  --chip-bg:#221d17; --chip-fg:#f1e9d9; --tip-em:#e8c98a;
  --ink-rgb:34,29,23;      /* 선·그림자처럼 잉크에 알파를 준 자리 */
  --lift-rgb:255,255,255;  /* 종이 위로 떠 보이게 하는 흰 기운 */
  --kraft-rgb:196,168,120; --kraftdk-rgb:162,134,90;
  --cell:rgba(255,255,255,.25); --cell-on:rgba(255,255,255,.5); --cell-hover:rgba(255,255,255,.6);
  --tex-rgb:90,60,20;      /* 종이결 무늬 */
  --shadow-rgb:60,40,15; --red-rgb:156,43,34; --gold-rgb:138,100,21; --blue-rgb:35,72,107;
  --mono:'Cutive Mono',monospace;
  /* 무대 폭 — 시스템 줄·마스트·카드·로비가 전부 이 한 줄을 씁니다. 수명 동사
     ([시작]과 [정산 끝내기]·[중단])가 같은 우상단 모서리에 서는 조건입니다 (§3.4) */
  --stage:1080px;
  font-family:'IBM Plex Sans KR',system-ui,sans-serif;
  color:var(--ink); background:var(--kraft);
  background-image:
    radial-gradient(120% 80% at 15% 0%, rgba(var(--lift-rgb),.16), transparent 55%),
    repeating-linear-gradient(92deg, rgba(var(--tex-rgb),.035) 0 1px, transparent 1px 5px),
    repeating-linear-gradient(4deg, rgba(var(--tex-rgb),.03) 0 1px, transparent 1px 7px);
  padding:20px 20px 60px; min-height:100vh; min-width:var(--stage); /* 안쪽 폭 = 무대(1080). 창이 1120보다 좁으면 표가 잘리는 대신 가로 스크롤 (2026-09-06) */
  -webkit-font-smoothing:antialiased;
  /* 한국어는 어절 안에서 끊지 않는 편이 자연스럽습니다 */
  word-break:keep-all; overflow-wrap:break-word;
}
/* 밤 팔레트 — 같은 종이를 어두운 책상에서 보는 느낌으로. 장시간 방송용이라
   순검정 대신 따뜻한 갈색 계열로 낮추고, 대비는 유지합니다. */
.gs-dark{
  --kraft:#241f19; --kraft-dk:#4a4036;
  --paper:#302a22; --paper-2:#3a3229; --paper-3:#413830;
  --ink:#ece4d6; --ink-2:#a1968a; --ink-body:#cabfae; --ink-hover:#6a5b49;
  --red:#e0776b; --red-dk:#c85a4e; --blue:#8db7e2; --gold:#dcae5e;
  --chip-bg:#574a3c; --chip-fg:#f4ece0; --tip-em:#e8c98a;
  --ink-rgb:236,228,214;
  --lift-rgb:0,0,0;        /* 밝은 기운 대신 어둡게 눌러서 칸을 파 보이게 */
  --kraft-rgb:120,104,84; --kraftdk-rgb:150,130,105;
  /* 밤에도 '센 칸'은 떠 보이게 — 어둡게 누르면 빈 칸과 구별이 흐려집니다 */
  --cell:rgba(255,255,255,.04); --cell-on:rgba(255,255,255,.1); --cell-hover:rgba(255,255,255,.14);
  --tex-rgb:0,0,0;
  --shadow-rgb:0,0,0; --red-rgb:224,119,107; --gold-rgb:220,174,94; --blue-rgb:141,183,226;
}
.gs *{box-sizing:border-box}
.gs p{text-wrap:pretty}
.gs :focus-visible{outline:2px solid var(--blue); outline-offset:2px}
/* 고정된 이름 열은 배경이 있어서 이웃 칸의 포커스 테두리를 덮습니다.
   포커스된 칸을 항상 맨 앞으로 올려 테두리가 네 면 다 보이게 합니다. */
.gs .gs-in:focus{position:relative; z-index:5}
.gs-stick:focus-within{z-index:6}
.gs-mast,.gs-card,.gs-mail{max-width:var(--stage); margin-left:auto; margin-right:auto}

/* 머리 — 방송 화면에선 세로가 금이라 낮게 갑니다 */
.gs-mast{margin-bottom:14px}
.gs-eyebrow{display:flex; align-items:center; gap:12px; font-family:var(--mono);
  font-size:10px; letter-spacing:.24em; text-transform:uppercase; color:var(--ink-2)}
.gs-eyebrow i{flex:1; height:1px; opacity:.5;
  background:repeating-linear-gradient(90deg,var(--ink-2) 0 4px,transparent 4px 8px)}
.gs-title{font-family:'Gowun Batang',serif; font-weight:700; letter-spacing:-.02em;
  font-size:clamp(24px,3.5vw,34px); line-height:1.1; margin:8px 0 0}

/* 제목 오른쪽 — 탭과 보기 전환. 탭일 때는 밑줄 하나가 탭의 바닥선이 됩니다 */
.gs-mastrow{position:relative; display:flex; align-items:flex-end; justify-content:space-between;
  gap:10px 14px; flex-wrap:wrap}
.gs-tabbed .gs-mastrow::after{content:''; position:absolute; left:0; right:0; bottom:0;
  height:1px; background:var(--kraft-dk)}
/* 탭과 수명 동사는 한 덩어리로 오른쪽 끝에 섭니다 (§3.4) — 탭을 왼쪽 끝까지 보내지
   않고, 그 오른쪽에 [정산 끝내기]·[중단]을 잇습니다. 마스트 왼쪽은 [전부 비우기]뿐입니다 */
.gs-mastside{display:flex; align-items:flex-end; gap:12px; margin-left:auto}
/* 제목 아래 모드 — 화면에서 가장 먼저 읽혀야 하는 상태라 크게, 아이콘까지 붙입니다 */
.gs-mastleft{display:flex; align-items:center; gap:9px; flex-wrap:wrap; padding-bottom:9px}
/* 수명 동사 — 무대 우상단 모서리. 로비 [시작]과 같은 좌표라, 판이 열려도 닫혀도
   손이 가는 자리가 안 바뀝니다 (§3.1·§3.4). 둘 다 유령 버튼입니다.
   탭과 같은 바닥선에 서야 나란히 선 것으로 읽힙니다 */
/* 판의 수명 동사는 탭 줄 오른쪽 끝에 섭니다 (§3.4). 탭은 아래 카드로 이어지는
   서류철이라 구분선에 닿는 것이 맞지만 이건 버튼이라 닿으면 안 됩니다 — 모서리가
   둥근 상자가 선에 얹히면 얹힌 것도 뜬 것도 아닌 모양이 됩니다.
   그래서 **머리는 탭과 같은 선에 맞추고 발치만 띄웁니다**: 탭보다 6px 낮게 만들고
   그만큼 올려서, 위로는 한 줄로 읽히고 아래로는 선과 떨어집니다 */
.gs-mastverbs{display:flex; align-items:flex-end; gap:8px; margin-bottom:6px}
.gs-mastverbs .gs-lifebtn{padding-top:5px; padding-bottom:5px}
.gs-presetbtn{display:inline-flex; align-items:center; gap:6px}
.gs-presetbtn svg{opacity:.85; flex:none}
/* 왼쪽 끝 버튼의 툴팁은 화면 밖으로 안 나가게 왼끝 정렬 */
.gs-tip-body.gs-tip-l{left:0; transform:none}
.gs-gens-empty{margin:2px; font-size:12px; color:var(--ink-2); line-height:1.65}
.gs-modebar{display:flex; align-items:center; gap:9px; flex-wrap:wrap}
.gs-seg-lg button{font-size:15px; padding:8px 15px; display:inline-flex; align-items:center; gap:7px}
.gs-seg-lg svg{opacity:.85}
.gs-seg-lg button.on{font-weight:600}
.gs-guide{width:26px; height:26px; border:1px solid rgba(var(--ink-rgb),.35); background:transparent;
  color:var(--ink-2); font:inherit; font-size:12px; line-height:1; cursor:help;
  border-radius:50%; padding:0; flex:none; display:grid; place-items:center}
.gs-guide:hover{border-color:var(--ink); color:var(--ink)}
/* 눌러야 하는 내용이 든 툴팁 — 마우스가 들어갈 수 있어야 하고, 8px 틈을 다리로 잇습니다 */
.gs-tip-act .gs-tip-body{pointer-events:auto}
.gs-tip-act .gs-tip-body::before{content:''; position:absolute; left:0; right:0; top:-9px; height:9px}
.gs-tip-act:focus-within .gs-tip-body{display:block}
/* 모드 설명 — 두 모드를 나란히 세워 비교되게. 기본 툴팁 폭 규칙을 이겨야 합니다 */
.gs-tip-act .gs-tip-modes{width:min(278px,78vw)}
.gs-tip-sec{display:block}
.gs-tip-sec + .gs-tip-sec{margin-top:10px}
.gs-tip-sec b{display:block; margin-bottom:1px}
.gs-tip-more{display:block; margin-top:11px; font:inherit; font-size:11.5px; cursor:pointer;
  color:var(--tip-em); background:transparent; border:0; border-top:1px solid rgba(255,255,255,.16);
  padding:7px 0 0; width:100%; text-align:left}
.gs-tip-more:hover{text-decoration:underline}
.gs-intro-top{display:flex; align-items:flex-end; justify-content:space-between; gap:14px}
.gs-tabs{display:flex; align-items:flex-end; gap:4px}
.gs-tab{font:inherit; font-size:14px; letter-spacing:.02em; cursor:pointer; color:var(--ink-body);
  padding:8px 13px 9px; border:1px solid rgba(var(--kraftdk-rgb),.75); border-bottom:none;
  border-radius:7px 7px 0 0; background:rgba(var(--ink-rgb),.06); white-space:nowrap}
.gs-tab:hover{background:rgba(var(--ink-rgb),.13)}
/* 열린 탭은 종이색으로 바닥선을 덮어서, 아래 카드로 이어진 서류철처럼 보입니다 */
.gs-tab.on{position:relative; z-index:1; background:var(--paper); border-color:var(--kraft-dk);
  color:var(--ink); font-weight:600; padding:10px 15px 11px}
.gs-tab em{font-style:normal; font-family:var(--mono); font-size:11px; color:var(--ink-2);
  margin-left:6px}
.gs-viewseg{display:inline-flex; border:1px solid rgba(var(--ink-rgb),.35); border-radius:2px;
  background:rgba(var(--lift-rgb),.22); margin-bottom:7px}
.gs-viewseg button{width:33px; height:32px; display:grid; place-items:center; border:none;
  padding:0; background:transparent; color:var(--ink-2); cursor:pointer}
.gs-viewseg button:hover{color:var(--ink); background:rgba(var(--ink-rgb),.07)}
.gs-viewseg button.on{background:var(--chip-bg); color:var(--chip-fg)}
.gs-viewseg .gs-tip + .gs-tip button{border-left:1px solid rgba(var(--ink-rgb),.3)}
/* 탭 화면은 카드가 하나뿐이라 사이 여백을 조금 좁힙니다 */
.gs-tabbed .gs-card,.gs-tabbed .gs-mail{margin-top:14px}
/* 카드 */
.gs-card{background:var(--paper); border:1px solid var(--kraft-dk); padding:20px 18px 22px;
  margin-top:22px; box-shadow:0 1px 0 rgba(var(--lift-rgb),.4) inset, 0 6px 18px rgba(var(--shadow-rgb),.13)}
.gs-mail{margin-top:26px}
.gs-cardhead{display:flex; align-items:center; justify-content:space-between; gap:14px;
  flex-wrap:wrap; margin-bottom:15px}
.gs-h2{font-family:'Gowun Batang',serif; font-size:19px; font-weight:700; margin:0; letter-spacing:.02em}
.gs-card > .gs-h2{margin-bottom:15px}
.gs-headnote{font-size:12px; color:var(--ink-2); letter-spacing:.01em}
.gs-headnote b{color:var(--ink); font-weight:600}
.gs-tools{display:flex; align-items:center; gap:8px; flex-wrap:wrap}
.gs-btn{font:inherit; font-size:12.5px; letter-spacing:.04em; cursor:pointer; padding:8px 14px;
  border:1px solid var(--chip-bg); background:var(--chip-bg); color:var(--chip-fg); border-radius:2px;
  white-space:nowrap}
.gs-btn:hover{background:var(--ink-hover)}
.gs-btn:disabled{opacity:.42; cursor:default}
.gs-btn:disabled:hover{background:var(--chip-bg)}
.gs-btn-ghost:disabled:hover{background:transparent}
.gs-btn-ghost{background:transparent; color:var(--ink)}
.gs-btn-ghost:hover{background:rgba(var(--ink-rgb),.08)}
.gs-btn-sm{padding:6px 11px; font-size:12px}
/* 수명 동사 한 벌 — 로비 [시작]과 판 [정산 끝내기]가 같은 룩입니다 (§3.4).
   글꼴·모서리·자간이 한 벌이라, 화면이 바뀌어도 같은 것이 같은 우상단 모서리에 섭니다.
   다른 것은 채움뿐입니다 — [시작]은 그 화면의 주 동작이라 금색이고, 판의 것은 유령입니다:
   벌금표에서 할 일은 칸을 세는 것이지 판을 닫는 것이 아니라, 닫는 문이 가장 큰 소리를
   내면 안 됩니다 (§9-2) */
.gs-lifebtn{font-size:14px; font-weight:600; letter-spacing:.08em; padding:8px 20px;
  border-radius:7px}
/* 판을 닫는 문 — 유령이되 보여야 합니다 (2026-09-05): 잉크 테두리·잉크 글자로 한 단 세움.
   기본 유령의 테두리(chip-bg)는 어두운 판 위에서 거의 사라졌습니다 */
.gs-endbtn{border-color:rgba(var(--ink-rgb),.55); color:var(--ink)}
.gs-endbtn:hover{border-color:var(--ink)}
.gs-btn-danger{background:var(--red); border-color:var(--red); color:var(--paper)}
.gs-btn-danger:hover{background:var(--red-dk); border-color:var(--red-dk)}

/* 첫 방문 모드 선택 — 앱과 같은 크라프트지 위에 카드 두 장 */
.gs-intro{position:fixed; inset:0; z-index:60; overflow:auto; background:var(--kraft);
  background-image:
    radial-gradient(120% 80% at 15% 0%, rgba(var(--lift-rgb),.16), transparent 55%),
    repeating-linear-gradient(92deg, rgba(var(--tex-rgb),.035) 0 1px, transparent 1px 5px),
    repeating-linear-gradient(4deg, rgba(var(--tex-rgb),.03) 0 1px, transparent 1px 7px);
  padding:42px 20px 60px}
.gs-intro-in{max-width:780px; margin:0 auto}
/* 첫 방문 관문 — 묻는 게 하나뿐이라 카드 격자 없이 좁게, 눈높이에 씁니다 */
.gs-ask-in{max-width:560px; margin:0 auto; padding-top:min(12vh,110px)}
.gs-ask-btns{display:flex; flex-wrap:wrap; gap:10px; margin-top:26px}
.gs-ask-go{font-size:15px; padding:12px 22px}
.gs-ask-note{margin:16px 0 0; font-size:12px; color:var(--ink-2)}
.gs-intro-lead{margin:16px 0 24px; font-size:14px; line-height:1.85; color:var(--ink-body)}
.gs-intro-cards{display:grid; grid-template-columns:repeat(auto-fit,minmax(280px,1fr)); gap:16px}
.gs-intro-card{font:inherit; text-align:left; cursor:pointer; background:var(--paper);
  border:1px solid var(--kraft-dk); padding:18px 18px 16px; display:flex; flex-direction:column;
  gap:12px; box-shadow:0 1px 0 rgba(var(--lift-rgb),.4) inset, 0 6px 18px rgba(var(--shadow-rgb),.13)}
.gs-intro-card:hover{border-color:var(--ink);
  box-shadow:0 1px 0 rgba(var(--lift-rgb),.4) inset, 0 8px 22px rgba(var(--shadow-rgb),.24)}
.gs-intro-name{font-family:'Gowun Batang',serif; font-size:21px; font-weight:700}
.gs-io-vis{display:flex; align-items:center; justify-content:center; gap:12px;
  background:var(--cell); border:1px dashed rgba(var(--kraftdk-rgb),.6); padding:14px 12px;
  min-height:104px}
.gs-io-memo{white-space:pre; font-family:var(--mono); font-size:12.5px; line-height:1.9;
  background:var(--cell-on); border:1px solid rgba(var(--ink-rgb),.25); padding:7px 10px}
.gs-io-arr{color:var(--ink-2)}
.gs-io-rows{display:flex; flex-direction:column; gap:5px; font-size:12.5px; min-width:96px}
.gs-io-rows > span{display:flex; gap:10px; justify-content:space-between;
  border-bottom:1px dotted rgba(var(--ink-rgb),.3); padding-bottom:2px}
.gs-io-rows b{color:var(--blue); font-weight:600}
.gs-io-rows i{font-style:normal; font-family:var(--mono); color:var(--gold)}
/* 카운터 축소판 — 이름 열 + 항목 두 열의 미니 표 */
.gs-io-mini{display:grid; grid-template-columns:auto 58px 58px; gap:6px 10px;
  align-items:center; justify-items:center}
.gs-io-cap{font-size:10.5px; letter-spacing:.08em; color:var(--ink-2); min-height:13px}
.gs-io-name{justify-self:start; font-family:'Gowun Batang',serif; font-weight:700;
  font-size:14px}
.gs-io-cell{display:flex; align-items:center; justify-content:center; width:58px; height:36px;
  border:1px dashed rgba(var(--kraftdk-rgb),.85); border-radius:3px; font-family:var(--mono);
  font-size:17px; color:var(--ink); justify-self:stretch}
.gs-io-cell.on{border-style:solid; background:var(--cell-on)}
.gs-io-cell em{font-style:normal; font-size:10px; color:var(--ink-2); margin-left:3px}
.gs-io-cell:not(.on){color:var(--ink-2)}
.gs-intro-desc{font-size:12.5px; line-height:1.75; color:var(--ink-body)}
.gs-intro-foot{margin-top:20px; font-size:12px; color:var(--ink-2)}

/* 확인 창 */
.gs-modal{position:fixed; inset:0; z-index:50; display:grid; place-items:center; padding:20px;
  background:rgba(var(--ink-rgb),.45); animation:gs-fade .14s ease-out}
@keyframes gs-fade{from{opacity:0} to{opacity:1}}
.gs-dialog{max-height:calc(100vh - 40px); overflow-y:auto; display:flex; flex-direction:column; width:100%; max-width:376px; background:var(--paper); border:1px solid var(--kraft-dk);
  padding:20px 20px 16px; box-shadow:0 16px 44px rgba(var(--shadow-rgb),.4)}
.gs-dialog h3{margin:0; font-family:'Gowun Batang',serif; font-size:17px; font-weight:700}
.gs-dialog p{margin:9px 0 0; font-size:12.5px; line-height:1.8; color:var(--ink-body)}
.gs-dialog-btns{display:flex; justify-content:flex-end; align-items:stretch; gap:8px;
  margin-top:18px; flex-wrap:wrap}
/* 결과 금액을 안고 있는 버튼 — 라벨 아래 한 줄. 옆 버튼들은 같은 높이로 맞춥니다 */
.gs-dialog-btns .gs-btn{display:flex; flex-direction:column; align-items:center;
  justify-content:center; gap:3px; line-height:1.35}
.gs-dialog-btns .gs-btn em{font-style:normal; font-family:var(--mono); font-size:11px;
  margin-left:0; opacity:.75; letter-spacing:.02em}
.gs-dialog-wide{max-width:560px}
.gs-ta{width:100%; margin-top:12px; min-height:230px; resize:vertical; box-sizing:border-box;
  padding:11px 12px; border:1px solid rgba(var(--ink-rgb),.3); border-radius:2px;
  background:rgba(var(--lift-rgb),.42); color:var(--ink);
  font-family:var(--mono); font-size:12.5px; line-height:1.7; white-space:pre; overflow:auto}
.gs-ta:focus{outline:2px solid var(--blue); outline-offset:1px}
/* 버튼 줄과 높이를 맞춥니다 (gs-btn 이 37px) */
.gs-qm{width:37px; height:37px; border:1px solid rgba(var(--ink-rgb),.35); background:transparent;
  color:var(--ink-2); font:inherit; font-size:13px; line-height:1; cursor:pointer;
  border-radius:50%; padding:0; flex:none}
.gs-qm:hover{border-color:var(--ink); color:var(--ink)}
.gs-qm-on{background:var(--chip-bg); border-color:var(--chip-bg); color:var(--chip-fg)}
.gs-qm-sm{width:17px; height:17px; font-size:10px; border-color:rgba(var(--ink-rgb),.3)}

/* 항목·기타 옆 물음표: 올리면 설명이 뜹니다 */
/* 목록을 여는 순간은 브라우저가 그립니다 — 우리 색이 아니라 OS 색으로요.
   판이 어두운데 그걸 안 알려 주면 밝은 목록에 밝은 글자가 얹혀 안 보입니다. */
.gs, .gs select, .gs input, .gs textarea{color-scheme:light}
.gs-dark, .gs-dark select, .gs-dark input, .gs-dark textarea{color-scheme:dark}
.gs-tip{position:relative; display:inline-flex; vertical-align:middle}
/* 숨김은 display:none 이어야 합니다 — visibility:hidden 은 absolute 요소여도
   문서 폭에 계산돼서, 좁은 화면에서 보이지 않는 가로 스크롤을 만듭니다. */
.gs-tip-body{display:none; position:absolute; top:calc(100% + 8px); left:50%;
  transform:translateX(-50%);
  width:240px; padding:10px 12px; background:var(--chip-bg); color:var(--chip-fg);
  font-family:'IBM Plex Sans KR',sans-serif; font-size:11.5px; font-weight:400; line-height:1.7;
  letter-spacing:0; text-align:left; border-radius:2px; box-shadow:0 6px 18px rgba(var(--shadow-rgb),.3);
  z-index:30; pointer-events:none}
.gs-tip-body b{color:var(--tip-em); font-weight:600}
.gs-tip-r{left:auto; right:-6px; transform:none}
/* 어느 쪽에 붙든 화면 밖으로는 안 나갑니다 — 넓은 툴팁이 오른쪽 끝에서 잘리던 것 */
.gs-tip-body{max-width:min(340px, calc(100vw - 28px))}
/* focus-within 을 쓰면 버튼을 클릭한 뒤에도(포커스가 남아) 툴팁이 안 사라집니다.
   키보드 포커스(focus-visible)에만 반응시키고, 마우스는 hover 로만 띄웁니다. */
.gs-tip:hover .gs-tip-body,.gs-tip:has(:focus-visible) .gs-tip-body{display:block;
  animation:gs-tipin .12s ease-out}
@keyframes gs-tipin{from{opacity:0} to{opacity:1}}
@media (prefers-reduced-motion:reduce){ .gs-tip-body{animation:none !important} }
/* 좁은 화면에서는 표가 가로로 잘리므로, 폭을 줄이고 잘리지 않는 쪽으로 폅니다 */

/* 항목 열과 기타 사이의 좁은 열. 아래쪽 '+ 인원 추가' 와 같은 조용한 텍스트 버튼입니다 */
.gs-addcolh{width:72px; padding:0 6px !important}
.gs-addcol{border:1px dashed rgba(var(--kraftdk-rgb),.9); border-radius:3px;
  background:rgba(var(--lift-rgb),.14); font:inherit; font-size:12px; color:var(--ink-2);
  cursor:pointer; padding:5px 4px; letter-spacing:.03em; white-space:nowrap; border-radius:2px}
.gs-addcol:hover{color:var(--ink); border-color:var(--ink); border-style:solid;
  background:rgba(var(--lift-rgb),.4)}
.gs-addcolcell{width:72px}

/* 코너 칸: 행은 이름, 열은 항목이라는 걸 사선으로 보여줍니다 */
.gs-corner{position:relative; height:48px}
.gs-corner::after{content:''; position:absolute; left:0; right:6px; top:2px; bottom:8px;
  background:linear-gradient(to top right, transparent calc(50% - .5px),
    rgba(var(--ink-rgb),.28) calc(50% - .5px), rgba(var(--ink-rgb),.28) calc(50% + .5px),
    transparent calc(50% + .5px));
  pointer-events:none}
.gs-corner-col,.gs-corner-row{position:absolute; font-size:10.5px; letter-spacing:.12em;
  color:var(--ink-2)}
.gs-corner-col{top:3px; right:10px}
.gs-corner-row{bottom:9px; left:0}
.gs-help{list-style:none; margin:0 0 15px; padding:12px 14px; border-left:2px solid var(--kraft-dk);
  background:rgba(var(--kraft-rgb),.22); font-size:12px; line-height:1.7; color:var(--ink-body)}
.gs-help li + li{margin-top:5px}
/* 사용법이 팝업으로 옮겨가서, 창 안에서는 제목과 붙습니다 */
.gs-dialog .gs-help{margin:12px 0 0}
.gs-help b{font-weight:600; color:var(--ink)}
/* 버튼 줄: 성격끼리 묶고, 글자 수는 버튼 안에 넣어 높이를 흐트러뜨리지 않습니다 */
.gs-grp{display:inline-flex; align-items:center; gap:6px}
.gs-tools{gap:14px}
/* 복사 버튼 — '복사됨'으로 바뀌어도 폭이 그대로여야 옆 버튼들이 안 밀립니다.
   두 라벨을 같은 그리드 칸에 겹쳐 두고 보이는 쪽만 바꿉니다. */
.gs-copybtn{display:inline-grid; place-items:center}
.gs-copybtn > span{grid-area:1/1; display:inline-flex; align-items:baseline; white-space:nowrap}
.gs-copybtn > .gs-copy-done{visibility:hidden}
.gs-copybtn.is-copied > .gs-copy-idle{visibility:hidden}
.gs-copybtn.is-copied > .gs-copy-done{visibility:visible}
/* 창 바닥 단추줄 안에서는 .gs-dialog-btns .gs-btn 이 두 단계라 위 한 단계를 이깁니다 —
   그러면 겹쳐 둔 두 라벨이 위아래로 쌓여서 단추가 두 줄 높이가 됩니다. 되돌립니다. */
.gs-dialog-btns .gs-copybtn{display:inline-grid; gap:0}
.gs-btn em{font-style:normal; font-family:var(--mono); font-size:10.5px; margin-left:7px;
  opacity:.55}
.gs-btn em.gs-over{color:var(--red); opacity:1}

/* 모드·규칙 전환 */
.gs-headleft{display:flex; align-items:center; gap:12px; flex-wrap:wrap}
/* overflow:hidden 을 두면 안쪽 툴팁이 잘립니다. 모서리는 2px 라 티가 안 나 그냥 뺍니다. */
.gs-seg{display:inline-flex; border:1px solid rgba(var(--ink-rgb),.3); border-radius:2px}
.gs-seg button{border:0; background:transparent; font:inherit; font-size:12px; cursor:pointer;
  padding:6px 12px; color:var(--ink-2); white-space:nowrap}
.gs-seg > .gs-tip + .gs-tip button,.gs-seg button + button{border-left:1px solid rgba(var(--ink-rgb),.3)}
.gs-seg .gs-tip-body{width:250px}
.gs-seg button:hover:not(:disabled){background:rgba(var(--ink-rgb),.07); color:var(--ink)}
.gs-seg button.on{background:var(--chip-bg); color:var(--chip-fg)}

/* 금액만 모드: 왼쪽 메모장 + 오른쪽 표 */
.gs-split{display:grid; grid-template-columns:minmax(210px,.85fr) minmax(0,1.15fr); gap:18px;
  align-items:start}
.gs-memo{display:flex; flex-direction:column; min-width:0}
.gs-memo-head{display:flex; align-items:center; justify-content:space-between; gap:8px;
  padding-bottom:8px; border-bottom:1.5px solid var(--ink); min-height:46px}
.gs-memo-left{display:inline-flex; align-items:center; gap:10px}
.gs-fontctl{display:inline-flex; align-items:center; gap:4px}
.gs-fontctl button{width:22px; height:22px; border:1px solid rgba(var(--ink-rgb),.35); background:transparent;
  color:var(--ink-2); font:inherit; font-size:14px; line-height:1; cursor:pointer;
  border-radius:2px; padding:0}
.gs-fontctl button:hover{border-color:var(--ink); color:var(--ink); background:rgba(var(--ink-rgb),.06)}
.gs-fontctl b{font-family:var(--mono); font-weight:400; font-size:11px; color:var(--ink-2);
  min-width:16px; text-align:center}
.gs-memo-note{margin:7px 0 0; font-size:10.5px; color:var(--ink-2); text-align:right}
/* 글자 크기는 인라인 스타일로 조절되고, 기본은 오른쪽 이름 글자 크기를 따릅니다.
   높이는 화면을 따라 늘어나 방송 중 전광판 역할을 합니다. */
.gs-memo-ta{margin-top:10px; min-height:max(460px, calc(100vh - 420px)); font-size:15px;
  line-height:2.06; white-space:pre-wrap}

/* 간단 모드 단위 라디오 */
.gs-unitbar{display:flex; align-items:center; gap:10px; flex-wrap:wrap; margin:0 0 15px;
  padding:10px 12px; border-left:2px solid var(--kraft-dk); background:rgba(var(--kraft-rgb),.22)}
.gs-unitbar label{display:inline-flex; align-items:center; gap:5px; font-size:12.5px;
  cursor:pointer; color:var(--ink-2)}
.gs-unitbar label.on{color:var(--ink); font-weight:600}
/* 카운터 조작법 — 입력 단위 상자 바로 아래, 표 머리 위 */
.gs-cellnote{margin:-9px 0 13px; padding-left:2px; font-size:11.5px; color:var(--ink-2);
  letter-spacing:.01em}
.gs-unitbar input{accent-color:var(--ink); margin:0}
.gs-unitnote{flex:1; min-width:180px; font-size:11.5px; color:var(--ink-2);
  display:flex; align-items:center; flex-wrap:wrap; gap:0 6px}
/* 친 숫자 → 그 금액. 한 짝이 한 칩이라 눈이 안 헤맵니다 */
.gs-unitex{display:inline-flex; align-items:baseline; gap:5px; font-weight:400;
  padding:2px 9px; border-radius:99px; white-space:nowrap;
  background:rgba(var(--lift-rgb),.32); border:1px solid rgba(var(--kraftdk-rgb),.45)}
.gs-unitex i{font-style:normal; font-family:var(--mono); color:var(--ink-body)}
.gs-unitex em{font-style:normal; font-size:10.5px; opacity:.55}
.gs-unitex span{color:var(--gold); font-weight:700}
.gs-simpleh{min-width:150px}
.gs-simple-lab{color:var(--ink) !important}
.gs-fee{display:flex; align-items:center; gap:7px; font-size:12.5px}
.gs-fee .gs-in-fee{width:48px; border-bottom:1.5px solid var(--ink); text-align:center; padding:4px 0}

/* 스크롤바 — 기본 두께는 이 화면(창 안의 창)에 비해 너무 굵습니다.
   라이브러리 없이 표준 속성으로 얇게 만듭니다. scrollbar-width 는 파이어폭스와
   최신 크로뮴이, ::-webkit-scrollbar 는 크로뮴·사파리가 읽습니다. */
html,body,.gs,.gs *{scrollbar-width:thin;
  scrollbar-color:rgba(var(--ink-rgb),.28) transparent}
html::-webkit-scrollbar,body::-webkit-scrollbar{width:9px; height:9px}
html::-webkit-scrollbar-track,body::-webkit-scrollbar-track{background:transparent}
html::-webkit-scrollbar-thumb,body::-webkit-scrollbar-thumb{
  background:rgba(var(--ink-rgb),.22); border-radius:99px}
html::-webkit-scrollbar-thumb:hover,body::-webkit-scrollbar-thumb:hover{
  background:rgba(var(--ink-rgb),.4)}
.gs *::-webkit-scrollbar{width:7px; height:7px}
.gs *::-webkit-scrollbar-track{background:transparent}
.gs *::-webkit-scrollbar-thumb{background:rgba(var(--ink-rgb),.24); border-radius:99px}
.gs *::-webkit-scrollbar-thumb:hover{background:rgba(var(--ink-rgb),.42)}
.gs *::-webkit-scrollbar-corner{background:transparent}

/* 입력 공통 */
.gs-in{border:0; background:transparent; font:inherit; color:var(--ink); padding:6px 2px;
  width:100%; border-radius:0}
.gs-in::placeholder{color:rgba(var(--ink-rgb),.28)}
.gs-x{border:0; background:transparent; color:rgba(var(--ink-rgb),.36); font-size:17px; line-height:1;
  cursor:pointer; padding:3px 5px; border-radius:2px}
.gs-x:hover{color:var(--red); background:rgba(var(--red-rgb),.1)}
.gs-caplab{font-size:10.5px; letter-spacing:.12em; color:var(--ink-2)}

/* 벌금표 */
/* 표는 제 폭대로 서고 스크롤은 뷰포트가 합니다 (2026-09-06 낮 사용자: 표 안 스크롤보다 창 가로 스크롤이 훨씬 알아보기 쉽다).
   열이 많아 표가 무대보다 넓어지면 카드(.gs-sheetbox)가 표 폭만큼 커지고 페이지가 가로로 넘칩니다. (폐기, 같은 날) .gs-scroll{overflow-x:auto; margin:-6px; padding:6px} — 표 안 가로 스크롤, 오른쪽 열·합이 잘려 보였다 */
.gs-scroll{overflow:visible}
.gs-grid{border-collapse:separate; border-spacing:0; width:100%; min-width:600px}
/* 금액만 모드는 3열뿐이라 가로 스크롤이 필요 없습니다 */
.gs-grid-narrow{min-width:0}
/* 금액만 모드는 시청자도 읽는 표라서 핵심(이름·금액) 27px, 서브도 한 단계씩 올립니다 */
.gs-grid-narrow .gs-in-name{font-size:27px; padding:12px 0}
.gs-grid-narrow .gs-in-cnt{font-size:27px}
.gs-grid-narrow .gs-sumcell{font-size:22px}
.gs-grid-narrow .gs-simple-lab{font-size:16px}
.gs-grid-narrow .gs-caplab{font-size:12px}
.gs-grid-narrow tfoot .gs-foot,.gs-grid-narrow .gs-foot-grand{font-size:20px !important}

/* 카운터 표 — 핵심(이름·×N·합계) 25px. 셀이 곧 버튼이라 큼직하게 둡니다.
   합계·기타 열도 최소 폭을 깔아 두어 자릿수가 늘어도 표가 안 밀립니다. */
.gs-grid-count .gs-in-name{font-size:25px; padding:10px 0}
/* width:1% 로 두면 표가 남는 폭을 이 열에 안 나눠 줍니다 — 이름 칸은 딱 제 몫만,
   남는 폭은 눌러야 하는 횟수 칸들이 가져갑니다 */
.gs-grid-count .gs-stick{width:1%}
/* 폭은 이름 입력칸에 직접 겁니다 — 셀에 걸면 em 이 셀 글꼴(15px) 기준이라
   정작 25px 로 그려지는 이름이 안 들어갑니다. 여섯 글자가 기본, 더 길면 그만큼. */
.gs-in-name{min-width:calc(var(--namech, 6) * 1.02em)}
.gs-grid-narrow .gs-stick{min-width:152px}
.gs-grid-count .gs-sumcell{font-size:25px; min-width:10ch}
.gs-grid-count td.gs-disc, .gs-grid-count th.gs-disch{width:140px; min-width:140px; max-width:140px}
/* 표는 카드 폭을 채우므로, 항목 열에 폭을 정해 두어야 실제로 좁아집니다.
   남는 자리는 이름·합계 열이 가져갑니다. */
.gs-grid-count .gs-colh,.gs-grid-count .gs-disch{width:auto; min-width:124px}
/* 항목명은 열이 무엇을 세는지 알리는 제목이라 크게. 단가는 그 아래 작게 남깁니다 */
.gs-grid-count .gs-in-col{font-size:25px; font-weight:700; padding:5px 0}
.gs-grid-count .gs-colh-top{max-width:none}
.gs-grid-count .gs-disch-top{font-size:19px}
.gs-grid-count .gs-colh-price{font-size:11px; margin-top:3px}
/* 바닥줄 — 항목별 소계는 비우고 최종 금액 하나만 크게 */
.gs-grid-count .gs-foot-grand{font-size:25px !important; color:var(--gold) !important}
.gs-hitwrap{position:relative; display:flex; padding:6px 4px}
/* 숫자 중심 셀 — 누르기 전엔 옅은 ＋, 누른 뒤엔 가운데 큰 횟수가 주인공입니다 */
.gs-hit{font:inherit; color:var(--ink); cursor:pointer; position:relative;
  display:flex; align-items:center; justify-content:center;
  width:100%; min-height:56px; padding:6px 10px; border-radius:3px;
  border:1px dashed rgba(var(--kraftdk-rgb),.85); background:var(--cell)}
.gs-hit:hover{background:var(--cell-hover); border-color:var(--ink)}
.gs-hit:active{transform:scale(.96)}
.gs-hit-on{border-style:solid; background:var(--cell-on)}
.gs-hit-ghost{font-size:18px; line-height:1; color:rgba(var(--kraftdk-rgb),.95)}
.gs-hit:hover .gs-hit-ghost{color:var(--ink-2)}
/* 폭 4ch 를 예약해 두면 가운데 숫자라 자릿수가 늘어도 표가 안 밀립니다 */
.gs-hit-num{min-width:5ch; text-align:center; white-space:nowrap; font-family:var(--mono);
  font-size:25px; line-height:1; color:var(--ink); animation:gs-npop .16s ease-out}
.gs-hit-num em{font-style:normal; font-size:12px; color:var(--ink-2); margin-left:5px}
@keyframes gs-npop{from{transform:scale(1.35)} to{transform:scale(1)}}

@media (prefers-reduced-motion:reduce){
  .gs-hit-num{animation:none}
}

/* 합계 직접 수정 — 글자를 누르면 입력칸으로 바뀝니다 */
.gs-sumedit{font:inherit; font-family:var(--mono); font-size:inherit; color:inherit;
  border:0; background:transparent; cursor:pointer; padding:9px 0; width:100%; text-align:right;
  border-bottom:1px dashed rgba(var(--gold-rgb),.35)}
.gs-sumedit:hover{border-bottom-color:var(--gold)}
.gs-sumedit-wrap{display:flex; align-items:baseline; gap:5px; justify-content:flex-end}
.gs-sumedit-in{font-family:var(--mono); font-size:inherit; color:var(--gold); text-align:right;
  width:100%; min-width:6ch; padding:9px 0}
.gs-sumedit-unit{flex:none; font-style:normal; font-size:12px; color:var(--ink-2)}

/* 기록 — 팝업 안에 영수증처럼 쌓입니다. 길어지면 창이 아니라 목록 안에서 스크롤됩니다. */
.gs-logbtn-on{background:var(--chip-bg); color:var(--chip-fg)}
/* 삭제·초기화 직후의 복구 버튼 — 사고용이라 빨간 유령 버튼 */
.gs-undo{border-color:var(--red); color:var(--red); background:transparent}
.gs-undo:hover{background:rgba(var(--red-rgb),.1)}
/* 사고 직후의 안내 쪽지 — 버튼 줄 대신 헤더 아래 한 줄을 차지합니다.
   가로로 밀리지 않으니 과녁이 안 움직이고, 무게는 더 실립니다. */
.gs-slip{display:flex; align-items:center; gap:12px; flex-wrap:wrap;
  margin:0 0 14px; padding:9px 13px; border-left:2px solid var(--red);
  background:rgba(var(--red-rgb),.09); animation:gs-slipin .16s ease-out}
@keyframes gs-slipin{from{opacity:0; transform:translateY(-3px)} to{opacity:1; transform:none}}
.gs-slip-msg{font-size:12.5px; color:var(--red); line-height:1.6}
.gs-slip .gs-undo{margin-left:auto}
.gs-slip-x{flex:none; color:var(--red); opacity:.7; font-size:15px}
.gs-slip-x:hover{opacity:1}
@media (prefers-reduced-motion:reduce){ .gs-slip{animation:none} }
/* 파괴적인 묶음과 자주 쓰는 묶음 사이를 벌립니다 */
.gs-tools .gs-grp-risky{margin-right:12px}
.gs-btn-warn{border-color:rgba(var(--red-rgb),.55); color:var(--red)}
.gs-btn-warn:hover{background:rgba(var(--red-rgb),.1); border-color:var(--red)}
.gs-dialog .gs-log-note{font-size:11.5px; color:var(--ink-2); margin:9px 0 0}
.gs-log-head{display:flex; align-items:center; justify-content:space-between; gap:12px;
  flex-wrap:wrap}
.gs-seg-sm button{font-size:11px; padding:5px 10px}
.gs-log-list{list-style:none; margin:12px 0 0; padding:0 2px 0 0;
  max-height:min(430px,58vh); overflow-y:auto; font-family:var(--mono)}
.gs-log-list li{display:flex; align-items:baseline; gap:10px; padding:6px 2px;
  border-bottom:1px dotted rgba(var(--ink-rgb),.22); font-size:13.5px}
.gs-log-t{color:var(--ink-2); font-size:12px; flex:none}
.gs-log-nm{color:var(--blue); flex:none; max-width:9em; overflow:hidden; text-overflow:ellipsis;
  white-space:nowrap}
/* 사람이 아니라 규칙이 바뀐 줄 (단가 변경) */
.gs-log-sys{color:var(--ink)}
.gs-log-what{white-space:nowrap}
.gs-log-after{margin-left:auto; color:var(--gold); white-space:nowrap}
.gs-log-cancel{flex:none; font:inherit; font-size:11px; color:var(--red); cursor:pointer;
  border:1px solid var(--red); background:transparent; border-radius:2px; padding:2px 8px}
.gs-log-cancel:hover{background:var(--red); color:var(--paper)}
.gs-log-xed .gs-log-what,.gs-log-xed .gs-log-after{text-decoration:line-through; opacity:.55}
.gs-grid th,.gs-grid td{padding:0; vertical-align:middle}
.gs-stick{position:sticky; left:0; z-index:2; background:var(--paper); min-width:104px;
  padding-right:10px !important; box-shadow:1px 0 0 rgba(var(--ink-rgb),.12)}
.gs-grid .gs-l{text-align:left}
.gs-grid thead th{border-bottom:1.5px solid var(--ink); padding-bottom:8px !important;
  vertical-align:bottom}
.gs-colh{min-width:104px; padding:0 6px !important}
/* 열이 넓어져도 항목명과 × 가 서로 떨어지지 않도록 묶어 둡니다 */
.gs-colh-top{display:flex; align-items:center; justify-content:center; gap:2px;
  max-width:132px; margin:0 auto}
.gs-in-col{font-size:13.5px; font-weight:600; text-align:center; padding:4px 0;
  min-width:3em; max-width:12em}
.gs-colh-price{display:flex; align-items:center; justify-content:center; gap:3px;
  font-size:10px; color:var(--ink-2); margin-top:1px; white-space:nowrap}
.gs-in-price{font-family:var(--mono); font-size:12.5px; min-width:2ch; text-align:center;
  padding:2px 0; border-bottom:1px dotted rgba(var(--ink-rgb),.5); color:var(--gold)}
.gs-pricewrap{display:inline-flex; align-items:center; gap:3px}
/* 센 기록이 있는 항목의 단가 — 버튼이지만 입력칸과 같은 얼굴 (버튼은 색을 상속하지 않아 명시) */
.gs-pricebtn{background:transparent; border:0; border-bottom:1px dotted rgba(var(--ink-rgb),.5);
  cursor:pointer; color:var(--gold); font-family:var(--mono); font-size:12.5px; padding:2px 0;
  min-width:2ch; text-align:center}
.gs-pricebtn:hover{border-bottom-style:solid}
/* 단가 창의 입력 줄 — '지금 3만 → [5] 만G' 가 한 문장으로 읽히게 가운데 배치 */
.gs-pm-row{display:flex; align-items:baseline; justify-content:center; gap:10px;
  margin:24px 0 8px}
.gs-pm-now{font-size:14px; color:var(--ink-2)}
.gs-pm-arrow{font-size:14px; color:var(--ink-2)}
.gs-pm-in{width:96px; font-family:var(--mono); font-size:22px; text-align:center; color:var(--gold);
  padding:4px 2px; border-bottom:2px solid rgba(var(--ink-rgb),.35)}
.gs-pm-in:focus{border-bottom-color:var(--gold)}
.gs-pm-unit{font-style:normal; font-size:12.5px; color:var(--ink-2)}
/* 결과 줄(78만 → 130만)은 흐름 밖(절대배치) — 라벨은 늘 제자리, 숫자만 바닥에 떠오릅니다 */
.gs-pm-btns .gs-btn{min-height:56px; position:relative}
.gs-pm-btns .gs-btn em.gs-pm-sub{position:absolute; left:0; right:0; bottom:4px;
  line-height:1; opacity:0; transition:opacity .15s ease}
.gs-pm-btns .gs-btn em.gs-pm-sub.on{opacity:.75}
.gs-disch{min-width:112px}
.gs-disch-top{display:flex; align-items:center; justify-content:center; gap:5px;
  font-size:13.5px; font-weight:600; padding:4px 0; color:var(--red)}
.gs-unit{font-size:12.5px; letter-spacing:.06em; color:var(--ink-2)}
/* 장부 상자 — 우편 봉투와 같은 자리에 서는 종이 상자. 단위는 상자 안 오른쪽 위 */
.gs-ledgersec .gs-ledgerbox{margin-top:0; position:relative}
/* 벌금표도 같은 뼈대 — 머리줄은 상자 밖, 내용은 상자 안 */
.gs-sheetsec .gs-sheetbox{margin-top:0}
.gs-unit-in{display:block; text-align:right; margin:0 0 10px}
/* 정산 방식 — 모드와 같은 세그먼트 */
.gs-splitpick{display:inline-flex; align-items:center; gap:10px}
/* 장부·우편 머리 높이를 못 박습니다 — 탭을 바꿔도 조절칸이 1px도 안 움직이게
   (37px = '디코 공유용 복사' 버튼이 있는 우편 머리의 실측 높이) */
.gs-mail .gs-cardhead{min-height:37px}
/* 방식 그림 — 막대 높이가 실제 금액. 왼쪽 벌금, 가운데 통, 오른쪽 몫 */
.gs-splitviz{display:flex; align-items:flex-end; gap:16px; flex-wrap:wrap;
  margin:2px 0 18px; color:var(--ink-2)}
.gs-sv-grp{display:inline-flex; flex-direction:column; align-items:center; gap:5px}
.gs-sv-fines svg{color:var(--kraft-dk)}
.gs-sv-shares svg{color:var(--blue)}
.gs-sv-grp em,.gs-sv-pot em{font-style:normal; font-size:11.5px; letter-spacing:.02em;
  white-space:nowrap}
.gs-sv-pot{display:inline-flex; flex-direction:column; align-items:center; gap:4px}
.gs-sv-pot svg{color:var(--gold)}
.gs-sv-arrow{align-self:center; font-size:14px; opacity:.55; padding-bottom:12px}
.gs-sumh{min-width:88px; text-align:right; padding-right:6px !important}

.gs-grid tbody tr th,.gs-grid tbody tr td{border-bottom:1px dotted rgba(var(--ink-rgb),.26)}
.gs-in-name{font-size:15px; font-family:'Gowun Batang',serif; font-weight:700; padding:9px 0;
  text-align:right}
.gs-in-cnt{font-family:var(--mono); font-size:16px; text-align:center; padding:9px 0}
.gs-sumcell{font-family:var(--mono); font-size:14px; text-align:right;
  padding-right:6px !important; color:var(--gold); white-space:nowrap}

/* 이름 칸은 이름만 — 손잡이는 오른쪽 끝 도구 열에 삽니다 */
.gs-namecell{display:flex; align-items:center; gap:4px; justify-content:flex-end;
  min-width:calc(var(--namech, 6) * 1.02 * 15px)} /* 열 폭은 셀이 — 입력칸은 글자만큼만 (2026-09-07) */
.gs-grid-count .gs-namecell{min-width:calc(var(--namech, 6) * 1.02 * 25px)}
.gs-grid-narrow .gs-namecell{min-width:calc(var(--namech, 6) * 1.02 * 27px)}
.gs-namecell .gs-drag{margin-right:auto} /* 레버는 왼쪽 끝 그대로 (사용자: 현행 유지) */
.gs-namecell .gs-name-ro{width:auto}
/* ≡ 손잡이 — 옅게 있다가 호버에 진해집니다. 끌고 지나는 줄엔 놓일 쪽에 금색 선 */
.gs-drag{cursor:grab; color:var(--ink-2); font-size:15px; line-height:1; padding:0 3px; user-select:none; opacity:.5; flex:none; touch-action:none}
.gs-drag:hover{opacity:1; color:var(--ink)}
.gs-drag:active{cursor:grabbing}
/* 끄는 동안 — 잡은 줄은 손을 따라오고(전환 없음, 위로 띄움), 다른 줄은 미끄러져 자리를 비킵니다 (2026-09-06 오후 실시간) */
.gs-grid.gs-drag-live tbody > tr{transition:transform .16s ease}
.gs-grid.gs-drag-live tbody > tr.gs-dragging{transition:none; position:relative; z-index:3}
/* 바깥 그림자는 안 됩니다 — 기타 칸(.gs-disc)이 position:relative 라 그 칸의 그림자만 이웃 위로 올라와 도드라졌다(2026-09-06 오후 사용자).
   칸마다 같은 불투명 배경 + 위아래 금색 선으로 띄웁니다 */
tr.gs-dragging > th,tr.gs-dragging > td{background:color-mix(in srgb, var(--paper) 88%, var(--gold)); box-shadow:inset 0 1px 0 rgba(var(--gold-rgb),.75), inset 0 -1px 0 rgba(var(--gold-rgb),.75)}
tr.gs-dragging .gs-drag{opacity:1; color:var(--gold); cursor:grabbing}
/* 줄의 신분 표시 — 이름 칸 왼쪽 빈자리 (§3.1). 이름은 오른쪽 끝에 그대로 붙습니다 */
.gs-rowmeta{margin-right:auto; flex:none; display:inline-flex; align-items:center; gap:4px; padding-left:4px}
/* i 하나 — 사람이 앉은 줄. 호버(title)에 닉 · 아이디. 끊긴 사람은 흐려집니다.
   (2026-09-06) 파란 테두리 → 잉크 톤. 이름 옆의 작은 표시가 표의 팔레트 밖 색을 쓰면 그것만 튄다 */
.gs-rowi{width:18px; height:18px; border-radius:50%; border:1px solid rgba(var(--ink-rgb),.3); color:var(--ink-2); padding:0; font:inherit;
  background:rgba(var(--ink-rgb),.05); display:inline-grid; place-items:center; cursor:pointer; line-height:0;
  transition:color .15s, border-color .15s}
.gs-rowi:not([aria-haspopup]){cursor:default}
.gs-rowmeta:hover .gs-rowi,.gs-rowi:focus-visible{color:var(--gold); border-color:rgba(var(--gold-rgb),.7)}
.gs-rowmeta-off .gs-rowi{opacity:.4; border-style:dashed}
.gs-rowi:focus-visible{outline:2px solid var(--gold); outline-offset:1px}
/* 툴팁은 위로 편다 — 아래로 펴면 뒤 줄(DOM 뒤, 같은 층)이 덮어 안 보였다. 앞 줄은 늘 아래에 깔리므로
   위로 넘치는 건 보인다 */
.gs-rowtip{white-space:nowrap; letter-spacing:0; top:auto; bottom:calc(100% + 6px); left:0; transform:none; width:auto}
.gs-stick:hover{z-index:3}
.gs-rowtip b{color:var(--gold)}
.gs-rowtip .gs-tipline{display:block; line-height:1.6}
.gs-rowtip .gs-tipline i{font-style:normal; color:var(--ink-2); margin-right:2px}
.gs-namecell .gs-in-name{margin-left:0; min-width:0; width:auto; flex:0 1 auto; field-sizing:content}
/* 아바타는 닉네임 바로 왼쪽에 (2026-09-07 사용자 확정) — 레버는 왼쪽 끝 그대로, 오른쪽 묶음(아바타·이름)이 이름 열 오른쪽에 붙습니다.
   방장 아바타는 금색으로 강조. (폐기) 아바타가 레버 옆에 서고 이름만 오른쪽으로 밀리던 배치 — 방장 줄엔 레버가 없어 아바타 열이 어긋났다 */
.gs-namecell .gs-rowmeta{margin:0} /* 옛 margin-right:auto 잔재가 아바타를 왼쪽 끝으로 밀었다 (실측 100px, 2026-09-07 밤) */
/* (폐기 2026-09-07 밤) .gs-rowmeta{margin-left:auto} + 입력칸 100% — 아바타가 입력칸 왼쪽 끝에, 글자는 오른쪽 끝에 서서 멀리 떨어졌다(사용자 재지적) */
.gs-rowi-host{border-color:var(--gold); color:var(--gold); box-shadow:0 0 0 2px rgba(var(--gold-rgb),.18)}
/* 도구 열 — [기록][삭제]. 합계 오른쪽에 세로 선을 세워 "여기부터는 숫자가 아니라
   손잡이"라고 가릅니다. 선은 머리줄부터 바닥줄까지 칸마다 왼쪽 테두리로 이어집니다.
   세는 손이 오가는 카운터 칸에서 가장 먼 자리라 오클릭 여지도 가장 적습니다. */
.gs-toolh,.gs-toolcell{border-left:1px solid rgba(var(--ink-rgb),.2);
  width:1%; white-space:nowrap; padding:0 4px 0 9px !important}
.gs-toolbtns{display:flex; align-items:center; justify-content:flex-end; gap:2px}
.gs-rowlog,.gs-rowppl{flex:none; display:inline-flex; align-items:center; justify-content:center;
  cursor:pointer; color:rgba(var(--ink-rgb),.4); background:transparent; border:0;
  border-radius:3px; padding:5px 6px; line-height:0}
.gs-toolcell .gs-x{font-size:22px; padding:3px 7px}
.gs-rowlog:hover,.gs-rowppl:hover{color:var(--ink); background:rgba(var(--lift-rgb),.5)}
/* 평소엔 숨기고 그 줄에 마우스를 올렸을 때만 — 방송에 잡히는 표라 평소엔 조용하게.
   숨겨도 자리는 그대로 차지하므로(opacity) 표가 흔들리지 않습니다. */
.gs-rowdel{flex:none; opacity:0; transition:opacity .12s}
.gs-grid tbody tr:hover .gs-rowdel,
.gs-toolcell:focus-within .gs-rowdel,
.gs-rowdel:focus-visible{opacity:1}

/* 십자 하이라이트 — 칸에 올리면 그 줄과 그 열에 옅은 금색 띠가 깔리고,
   이름·항목 이름이 금색으로 바뀝니다. 이름 칸은 sticky 라 제 배경(--paper)이
   불투명해야 해서, 색 대신 그림 한 겹을 덧대 배경을 살려 둡니다.
   메모장 모드에는 안 답니다 — 열이 금액 하나뿐이라 띠가 할 일이 없습니다. */
.gs-grid-count tbody tr.gs-litrow > th,
.gs-grid-count tbody tr.gs-litrow > td,
.gs-grid-count thead th.gs-litcol,
.gs-grid-count tbody td.gs-litcol{
  background-image:linear-gradient(rgba(var(--gold-rgb),.1),rgba(var(--gold-rgb),.1))}
.gs-grid-count tr.gs-litrow .gs-in-name,
.gs-grid-count th.gs-litcol .gs-in-col{color:var(--gold)}
.gs-in-name,.gs-in-col{transition:color .12s}
/* 누르면 얼마 — 그 칸 바로 위에 붙습니다. 꼬리가 어느 칸 이야기인지 가리켜서
   커서를 안 가리고도 대상이 분명합니다. 표는 안 밀립니다(절대 배치). */
.gs-hitwrap{position:relative}
/* 늘 위로 붙습니다 — 첫 줄만 아래로 뒤집으면 눈이 말풍선을 두 군데서 찾게 됩니다.
   첫 줄에서 머리줄을 좀 가리는 편이, 자리가 왔다 갔다 하는 것보다 낫습니다. */
.gs-hovtip{position:absolute; left:50%; bottom:calc(100% + 8px); transform:translateX(-50%);
  z-index:6; white-space:nowrap; pointer-events:none;
  font-size:15px; font-family:'IBM Plex Sans KR',system-ui,sans-serif; font-weight:400;
  padding:7px 15px; border-radius:5px; color:var(--ink);
  background:var(--paper-2); border:1px solid rgba(var(--gold-rgb),.55);
  box-shadow:0 5px 18px rgba(var(--shadow-rgb),.45)}
.gs-hovtip b{color:var(--gold); font-weight:700}
.gs-hovtip::after{content:''; position:absolute; left:50%; top:100%; margin-left:-6px;
  border:6px solid transparent; border-top-color:rgba(var(--gold-rgb),.55)}
@media (prefers-reduced-motion:reduce){ .gs-hovtip{box-shadow:none} }
/* 같은 이름 — 치는 동안 빨갛게 알리고, 칸을 벗어나면 되돌립니다. 표는 안 밀립니다 */
.gs-in-name.gs-dup{color:var(--red); box-shadow:inset 0 -2px 0 var(--red)}

/* 횟수 칸: +/− 는 숫자에 붙여 한 덩어리로 묶습니다.
   입력칸이 width:100% 면 버튼이 셀 양 끝으로 밀려나 옆 칸 버튼과 붙어 버립니다.
   폭은 내용에 맞춰 늘어나고(cntWidth), 아래에 그 칸의 금액이 붙습니다. */
.gs-cell{display:flex; flex-direction:column; align-items:center; padding:7px 0; cursor:text}
.gs-cnt{display:flex; align-items:center; justify-content:center; gap:0}
.gs-cnt .gs-in-cnt{flex:none; padding:2px}
.gs-cnt-amt{font-family:var(--mono); font-size:11px; color:var(--gold);
  min-height:15px; line-height:15px; white-space:nowrap}
.gs-step{flex:none; width:21px; border:0; background:transparent; cursor:pointer;
  font:inherit; font-size:15px; line-height:1; padding:7px 0; border-radius:2px;
  color:rgba(var(--ink-rgb),.4); opacity:0; transition:opacity .12s}
.gs-grid tbody tr:hover .gs-step,
.gs-cnt:focus-within .gs-step{opacity:1}
.gs-step:hover{color:var(--ink); background:rgba(var(--ink-rgb),.09)}
.gs-rowopen > th,.gs-rowopen > td{border-bottom:0 !important; background:rgba(var(--kraft-rgb),.16)}
.gs-rowopen > .gs-stick{background:var(--paper-3)}
.gs-addrow th,.gs-addrow td{border-bottom:0 !important}
/* 이름이 오른쪽 끝으로 갔으니 '+ 인원 추가'도 그 줄에 맞춥니다 — 새 줄이 생길 자리 바로 밑 */
.gs-addrow .gs-stick{text-align:right}
.gs-add{border:0; background:transparent; font:inherit; font-size:12.5px; color:var(--ink-2);
  cursor:pointer; padding:10px 0; letter-spacing:.03em}
.gs-add:hover{color:var(--ink)}

/* 기타 칸 */
.gs-disc{padding:0 6px !important; position:relative; cursor:pointer}
.gs-disc-ready{cursor:default}
/* 기타 편집칸은 칸 위에 뜹니다 — 줄 높이를 밀지 않게 (2026-09-05 ②) */
.gs-disc .gs-qx{position:absolute; right:4px; top:50%; transform:translateY(-50%); z-index:6; min-width:240px;
  background:var(--paper); border:1px solid rgba(var(--gold-rgb),.5); border-radius:6px; padding:8px 10px;
  box-shadow:0 10px 24px rgba(0,0,0,.35)}
.gs-disc-amt{display:block; font-family:var(--mono); font-size:15px; color:var(--red)}
.gs-disc-sub{display:block; font-size:10.5px; color:var(--ink-2); margin-top:2px;
  max-width:124px; margin-inline:auto; overflow:hidden; text-overflow:ellipsis; white-space:nowrap}

/* OBS로 공유 */
/* 아이콘 · 이름 · 점 — 셋이 붙으면 한 덩어리로 뭉쳐 보여서 사이를 띄웁니다 */
.gs-obsbtn{display:inline-flex; align-items:center; gap:7px}
.gs-obsbtn svg{flex:none; opacity:.75}
.gs-obs-room{display:flex; align-items:baseline; gap:9px; margin-top:14px; padding-bottom:11px;
  border-bottom:1px dotted rgba(var(--ink-rgb),.28)}
.gs-obs-label{font-size:11.5px; color:var(--ink-2)}
.gs-obs-room b{font-size:15px}
.gs-obs-on{margin-left:auto; font-size:11.5px; color:var(--ink-2)}
/* 주소 카드 — 창의 주인공이라 금테 상자 하나에 담습니다 (2026-09-05 목업 확정).
   비로그인 때는 같은 카드에 발급 버튼이 듭니다 — 자리가 같아야 "받으면 여기 뜬다"가 보입니다 */
.gs-obs-card{margin-top:16px; padding:13px 14px 12px;
  border:1px solid rgba(var(--gold-rgb),.42); background:rgba(var(--gold-rgb),.06)}
.gs-obs-card .gs-key-h{margin:0}
.gs-obs-cardhead{display:flex; align-items:center; gap:10px; margin-bottom:12px}
.gs-obs-cardhead .gs-btn{margin-left:auto; flex:none}
/* 카드 속 리듬 — 덩어리 사이가 다닥다닥 붙지 않게 */
.gs-obs-card .gs-obs-boxtop{margin-top:14px}
.gs-obs-card .gs-cast-line{margin-top:12px}
.gs-obs-newtab{display:inline-flex; align-items:center; gap:6px}
.gs-obs-newtab svg{flex:none; opacity:.7}
.gs-obs-cardfoot{margin:12px 0 0; padding-top:10px;
  border-top:1px solid rgba(var(--gold-rgb),.22); font-size:11.5px}
/* 비로그인 — 외형은 보이되 잠급니다: 주소를 받으면 꾸밀 화면이라는 예고입니다 */
.gs-obs-locked{opacity:.45; pointer-events:none; user-select:none}
.gs-obs-makenote{margin:8px 0 0; font-size:11.5px; color:var(--ink-2); line-height:1.7}
/* 두 컴퓨터 함정을 막는 한 줄 (§3.11) — 혜택이 아니라 경고라 금색으로 세웁니다 */
.gs-obs-warn2{margin:10px 0 0; font-size:12px; line-height:1.75; color:var(--ink-2);
  padding:9px 11px; border-radius:7px; background:rgba(var(--gold-rgb),.07);
  border:1px solid rgba(var(--gold-rgb),.32)}
.gs-obs-warn2 b{color:var(--gold)}
/* 주소를 방금 받은 사람에게만 뜨는 다음 걸음 (§3.11) */
.gs-obs-fresh{margin:0 0 14px; padding:12px 13px; border-radius:8px;
  background:rgba(var(--gold-rgb),.09); border:1px solid rgba(var(--gold-rgb),.42)}
.gs-obs-fresh > b{display:block; font-size:14px; color:var(--gold); margin-bottom:5px}
.gs-obs-fresh p{margin:0; font-size:12.5px; line-height:1.8; color:var(--ink-body)}
.gs-obs-fresh2{margin-top:7px !important; color:var(--ink-2) !important}
.gs-obs-url{display:flex; gap:8px; margin-top:14px}
.gs-obs-url input{flex:1; min-width:0; font-size:12px; font-family:var(--mono); padding:9px 10px;
  border:1px solid rgba(var(--ink-rgb),.25); border-radius:2px;
  background:rgba(var(--lift-rgb),.3); color:var(--ink)}
.gs-obs-acts{display:flex; align-items:center; gap:10px; flex-wrap:wrap; margin-top:11px}
.gs-obs-toggle{display:inline-flex; align-items:center; gap:6px; font-size:12.5px; color:var(--ink-2);
  cursor:pointer; margin-left:auto}
.gs-obs-toggle input{accent-color:var(--ink); margin:0}
.gs-obs-note{font-size:11.5px; color:var(--ink-2); margin-top:10px; line-height:1.7}
.gs-obs-sec{margin-top:18px; padding-top:14px; border-top:1px dotted rgba(var(--ink-rgb),.28)}
/* 생김새 묶음의 머리 — 점선보다 한 단 굵게 그어 "여기부터 다른 이야기"를 만듭니다 */
/* .gs-dialog h3 가 margin:0 으로 더 셉니다 — 여기서 이겨야 위쪽 여백이 생깁니다 */
.gs-dialog h3.gs-obs-sub{font-family:'Gowun Batang',serif; font-size:15px; font-weight:700; margin:30px 0 0;
  padding-top:20px; border-top:1px solid var(--kraft-dk); letter-spacing:.02em}
.gs-obs-sec h4{margin:0 0 6px; font-size:13px}
.gs-obs-sec p{margin:0; font-size:12px; color:var(--ink-2); line-height:1.7}
.gs-obs-claim{flex:1 1 220px; min-width:0; font-family:var(--mono); font-size:12px;
  padding:6px 8px; border-bottom:1px solid rgba(var(--ink-rgb),.35)}
.gs-obs-keycopy{border-color:var(--gold-ink); color:var(--ink)}
/* 프리셋 이름 칸 — 저장 버튼과 한 줄에 서게 기본 폭을 줄입니다 */
.gs-preset-name{flex-basis:120px}
/* 마스킹 보기/가리기 — 눈 아이콘 버튼 */
.gs-eyebtn{display:inline-flex; align-items:center; justify-content:center; padding:6px 9px}
.gs-eyebtn svg{display:block}
.gs-obs-keycopy:hover{background:rgba(var(--gold-rgb),.14)}
.gs-obs-err{margin-top:10px; font-size:12px; color:var(--red)}
/* 복사 상자 — 드래그 대신 버튼 복사 둘: OBS용 맨주소(주), 파티원 메시지(보조) */
.gs-obs-copybox{display:block; width:100%; text-align:left; cursor:pointer; margin-top:14px;
  padding:12px 14px; border:1px solid rgba(var(--ink-rgb),.3); border-radius:3px;
  background:rgba(var(--lift-rgb),.3); user-select:none; font:inherit}
.gs-obs-copybox{cursor:auto}
.gs-obs-copyrow{display:flex; align-items:center; gap:8px; flex-wrap:wrap; margin-top:11px}
/* 버튼은 오른쪽 끝 한 선에 섭니다 — 눈이 한 군데만 보게 */
.gs-obs-copyrow-r{justify-content:flex-end}
.gs-obs-rowr{margin-left:auto; display:flex; align-items:center; gap:10px}
.gs-obs-acctr{margin-left:auto; display:flex; align-items:center; gap:10px}
/* 버튼보다 가벼운 문 — 채운 버튼과 무게를 다투지 않게 밑줄 글자로 */
.gs-swaplink{font:inherit; font-size:12.5px; font-weight:600; color:var(--gold);
  background:none; border:0; cursor:pointer; padding:0; white-space:nowrap;
  text-decoration:underline; text-underline-offset:3px}
.gs-swaplink:hover{color:var(--ink)}
/* 되돌릴 수 없는 것은 눈에 띄되 손이 먼저 가지 않는 무게로 */
.gs-swaplink-mute{color:var(--ink-2); font-weight:400}
.gs-swaplink-mute:hover{color:var(--red)}
.gs-obs-copybox.copied{border-color:var(--gold); background:rgba(var(--gold-rgb),.08)}
.gs-obs-urltext{display:block; font-family:var(--mono); font-size:13px; color:var(--ink);
  overflow:hidden; text-overflow:ellipsis; white-space:nowrap}
.gs-obs-copyhint{display:block; margin-top:5px; font-size:11.5px; color:var(--ink-2)}
.gs-obs-copybox.copied .gs-obs-copyhint{color:var(--gold)}
/* 머리(제목·×)는 스크롤을 따라옵니다 (2026-09-05) — 긴 창 어디서든 닫혀야 해서.
   발치의 [닫기]는 그래서 폐지했습니다 */
.gs-obs-head{display:flex; align-items:center; gap:14px; position:sticky; top:-20px; z-index:6;
  background:var(--paper); margin:-20px -20px 0; padding:18px 20px 12px;
  border-bottom:1px solid rgba(var(--ink-rgb),.12)}
.gs-obs-head h3{margin:0}
.gs-obs-headr{margin-left:auto; display:flex; align-items:center; gap:16px}
/* 켜짐/꺼짐 슬라이드 스위치 */
.gs-switch{position:relative; display:inline-flex; align-items:center; gap:8px;
  font-size:12.5px; color:var(--ink-2); cursor:pointer; user-select:none}
.gs-switch input{position:absolute; opacity:0; width:0; height:0}
.gs-sw-track{width:34px; height:19px; border-radius:10px; flex:none;
  background:rgba(var(--ink-rgb),.28); position:relative; transition:background .15s}
.gs-sw-knob{position:absolute; top:2px; left:2px; width:15px; height:15px; border-radius:50%;
  background:var(--paper); transition:left .15s; box-shadow:0 1px 2px rgba(0,0,0,.35)}
.gs-switch input:checked ~ .gs-sw-track{background:var(--gold)}
.gs-switch input:checked ~ .gs-sw-track .gs-sw-knob{left:17px}
/* 마우스 아이콘 — 글줄에 얹혀 흐르되 살짝 내려 앉힙니다 */
.gs-mouse{vertical-align:-4px; margin:0 1px}
/* 코치마크 — 처음 한 번, 금테 말풍선이 자리를 가리킵니다 */
/* [?]의 점과 사용법 메뉴 (2026-09-06) */
/* 감속 슬라이더 (2026-09-07) — 프리셋 오른쪽, 안내문은 줄바꿈 */
.gs-easebar{flex-wrap:wrap}
.gs-glide{display:flex; align-items:center; gap:8px; flex:1 1 220px; min-width:220px}
.gs-glide input[type=range]{flex:1; min-width:120px; accent-color:var(--gold); cursor:pointer}
.gs-glide-l{font-size:11.5px; color:var(--ink-2); white-space:nowrap}
.gs-helpbtn{position:relative}
.gs-qdot{position:absolute; right:4px; top:4px; width:7px; height:7px; border-radius:50%; background:var(--gold)}
.gs-guide-list{display:flex; flex-direction:column}
.gs-guide-row{display:flex; align-items:center; gap:12px; padding:11px 0; border-top:1px dotted rgba(var(--ink-rgb),.2); font-size:13px}
.gs-guide-row:first-child{border-top:0; padding-top:2px}
.gs-guide-row b{font-family:'Gowun Batang',serif; font-size:14px; color:var(--ink)}
.gs-guide-n{font-size:11.5px; color:var(--ink-2)}
.gs-guide-now{font-size:10.5px; letter-spacing:.08em; color:var(--gold); border:1px solid rgba(var(--gold-rgb),.6); padding:1px 6px; border-radius:2px}
.gs-guide-seen{font-size:11px; color:var(--ink-2)}
.gs-guide-else{margin-left:auto}
.gs-guide-row .gs-btn{margin-left:auto}
.gs-guide-foot{margin:14px 0 0; padding-top:12px; border-top:1px solid rgba(var(--ink-rgb),.14); font-size:11.5px; color:var(--ink-2); line-height:1.7}
/* 로비 권유 줄 (2026-09-06) */
.gs-tutline{grid-column:1/-1; display:flex; align-items:center; gap:12px; margin:0; text-align:left; padding:10px 12px; border:1px solid rgba(var(--gold-rgb),.55); background:rgba(var(--gold-rgb),.07); font-size:12.5px; color:var(--ink-body); flex-wrap:wrap}
.gs-tutline b{color:var(--ink)}
.gs-tutline-r{margin-left:auto; display:flex; gap:8px}
/* 예시 앱 창(부모)과 예시 띠(예시 앱) (2026-09-06) */
.gs-demo{position:fixed; inset:0; z-index:60; background:var(--kraft); display:grid; place-items:center}
.gs-demo-load{margin:0; font-size:13px; color:var(--ink-2)}
.gs-demo-load-over{position:absolute; left:50%; top:50%; transform:translate(-50%,-50%); z-index:2; padding:10px 16px; border-radius:6px; background:var(--paper); color:var(--ink); border:1px solid rgba(var(--gold-rgb),.6); box-shadow:0 8px 26px rgba(0,0,0,.35)}
.gs-demo-frame{position:absolute; inset:0; width:100%; height:100%; border:0; display:block; opacity:0; transition:opacity .35s ease} /* .25 → .35 (2026-09-06 낮) */
.gs-demo{animation:gsDemoIn .2s ease} /* 창 자체도 번져 들어옵니다 — 문구 없이 열릴 때 빈 바탕이 툭 뜨지 않게 */
@keyframes gsDemoIn{from{opacity:0}to{opacity:1}}
.gs-demo-frame.on{opacity:1; z-index:3}
.gs-demo-frame.gs-demo-top{z-index:5} /* 4장 파티원 예시 — 방장 예시(3)와 칩(4) 위. 번져 사라질 때도 위에 있어야 밑이 비쳐 보입니다 */
.gs-demo-load-over{z-index:4}
/* (폐기 2026-09-06 낮) .gs-demo-prev — 8장으로 갈아 끼우던 옛 iframe */
/* 띠는 스크롤해도 늘 보입니다 — sticky, 걸음 막(48) 위·모달(50) 아래 (2026-09-06 낮 사용자: 상단 N장 인디케이터가 항상 보이게) */
.gs-demoband{position:sticky; top:0; z-index:49; margin:-20px -20px 0; padding:9px 20px; display:flex; align-items:center; justify-content:center; gap:18px; background:rgba(var(--gold-rgb),.16); border-bottom:1px solid rgba(var(--gold-rgb),.55); font-size:12.5px; color:var(--ink-body)}
.gs-tourdots{display:flex; align-items:center}
.gs-tourquit{position:absolute; right:14px; top:50%; transform:translateY(-50%); font-size:12px; padding:3px 10px} /* 띠 오른쪽 [튜토리얼 나가기] */
.gs-tourdot{position:relative; width:10px; height:10px; border-radius:50%; border:1.5px solid var(--gold); background:transparent; box-sizing:border-box}
.gs-tourdot + .gs-tourdot{margin-left:26px}
.gs-tourdot + .gs-tourdot::before{content:""; position:absolute; right:100%; top:50%; width:26px; height:1.5px; margin-top:-.75px; background:rgba(var(--gold-rgb),.55)}
.gs-tourdot.done{background:var(--gold)}
.gs-tourdot.now{width:16px; height:16px; background:var(--gold); box-shadow:0 0 0 3px rgba(var(--gold-rgb),.25)}
.gs-tourlabel{font-weight:600; color:var(--ink)}
/* [?] 팝오버 (2026-09-06 낮 손질) — 행마다 이름·칩·역할·서브를 세로로, 칩은 테두리 있는 라벨로 (사용자: 시인성) */
.gs-helppop{width:min(460px, 92vw)}
.gs-helppop-h{margin:0 0 6px; font-size:14.5px; color:var(--ink); font-weight:700}
.gs-helprow{display:flex; align-items:center; gap:14px; padding:12px 0; border-top:1px dotted rgba(var(--ink-rgb),.2)}
.gs-helprow-main{display:flex; flex-direction:column; gap:3px; min-width:0}
.gs-helprow-top{display:flex; align-items:center; gap:8px; flex-wrap:wrap}
.gs-helprow b{font-family:'Gowun Batang',serif; font-size:15px; color:var(--ink); white-space:nowrap}
.gs-helprow-role{margin:0; font-size:13px; color:var(--ink); line-height:1.5}
.gs-helprow-sub{margin:0; font-size:12.5px; color:var(--ink-body); line-height:1.5}
.gs-helprow .gs-btn{margin-left:auto; white-space:nowrap; flex:none}
.gs-rec{font-style:normal; font-size:11px; letter-spacing:.06em; color:var(--gold); border:1px solid rgba(var(--gold-rgb),.7); padding:1px 6px; border-radius:2px; line-height:1.5}
.gs-helpseen{font-size:11px; letter-spacing:.04em; color:var(--ink-body); border:1px solid rgba(var(--ink-rgb),.35); padding:1px 6px; border-radius:2px; line-height:1.5}
.gs-helppop .gs-guide-foot{font-size:12.5px; color:var(--ink-body)}
.gs-pressing{padding-bottom:300px}
.gs-coaching{padding-bottom:200px} /* 예시 앱 바닥 여백 — 표 아래 말풍선을 토스트 자리 위로 올릴 스크롤 여지 (2026-09-06 낮) */
.gs-coaching .gs-press{display:none} /* 같이 해보기 걸음이 떠 있는 동안 — 표 아래 줄의 [자리 정하기]를 덮었음 (2026-09-06) */ /* '방금 바뀐' 카드(고정, 아래 오른쪽)가 표 끝 줄의 버튼을 덮지 않게 내려 볼 여지 (2026-09-06) */
.gs-demoband ~ .gs-sysbar{margin-top:0} /* 시스템 줄의 위 당김(-20px)은 띠가 없을 때의 것 — 사이에 <style> 이 있어 형제 선택자는 ~ */
.gs-coach{position:fixed; inset:0; z-index:48} /* 모달(50)보다 아래 — 안내가 조작을 못 막습니다 */
.gs-coach.gs-coach-top{z-index:55} /* 같이 해보기가 시트 안을 가리킬 때만 (2026-09-06) */
.gs-coach-ring{position:fixed; border:2px solid var(--gold); border-radius:6px; pointer-events:none}
/* 하기 걸음만 숨 쉽니다 + 옅은 후광 (2026-09-06 낮; (폐기) 모든 걸음이 숨 쉼) */
.gs-coach-ring-act{animation:gs-coach-breathe 1.6s ease-in-out infinite; box-shadow:0 0 0 5px rgba(var(--gold-rgb),.16)}
.gs-coach-hint{font-style:normal; font-size:12px; color:var(--gold); letter-spacing:.02em; padding:6px 0}
@keyframes gs-coach-breathe{0%,100%{opacity:1} 50%{opacity:.45}}
.gs-coach-bubble{position:fixed; width:300px; background:var(--paper); border:1px solid var(--gold);
  border-radius:2px; padding:13px 15px; box-shadow:0 14px 34px rgba(var(--shadow-rgb),.4)}
.gs-coach-tail{position:absolute; top:-7px; width:12px; height:12px; background:var(--paper);
  border-left:1px solid var(--gold); border-top:1px solid var(--gold); transform:rotate(45deg)}
/* 위로 뒤집힌 말풍선 — 꼬리도 반대쪽 두 변을 씁니다 */
.gs-coach-bubble.up .gs-coach-tail{top:auto; bottom:-7px; border-left:0; border-top:0;
  border-right:1px solid var(--gold); border-bottom:1px solid var(--gold)}
.gs-coach-bubble p{margin:0 22px 10px 0; font-size:12.5px; line-height:1.7; color:var(--ink-body)}
/* 막는 일은 문서에서 가로채 하고, 이 층은 그리기만 합니다 */
.gs-coach-pass{pointer-events:none}
.gs-coach-pass .gs-coach-bubble{pointer-events:auto}
/* 대상만 남기고 덮는 그림자 — 어두운 곳은 눌러도 안 되는 곳입니다 */
.gs-coach-hole{position:fixed; border-radius:5px; pointer-events:none;
  box-shadow:0 0 0 9999px rgba(0,0,0,.36)} /* 2026-09-06 사용자: 어두운 막은 덜하게 (전 .58) */
.gs-coach-hole-clear{box-shadow:none} /* 정산 내역처럼 읽어야 하는 화면은 막을 씌우지 않습니다 (2026-09-06 사용자) */
/* 나가는 문 — 시선이 가 있는 말풍선 안에 둡니다 */
.gs-coach-x{position:absolute; top:7px; right:7px; width:24px; height:24px;
  display:grid; place-items:center; border:0; background:transparent; color:var(--ink-2);
  font-size:14px; line-height:1; border-radius:4px; cursor:pointer; padding:0}
.gs-coach-x:hover{background:rgba(var(--ink-rgb),.1); color:var(--ink)}
/* 카운터는 버튼 줄 오른쪽 끝 — 진행 표시이자, 다음과 건너뛰기를 양 끝으로 벌리는 칸막이 */
.gs-coach-step{margin-left:auto; font-style:normal; font-size:10.5px;
  color:var(--ink-2); font-family:var(--mono)}
.gs-coach-btns{display:flex; align-items:center; gap:14px}
.gs-coach-btns .gs-coach-step:first-child{margin-left:auto}
/* 오버레이 테마 — 사선 배경(밝은/어두운 화면 반반) 위에 실제 조합을 미리 보여줍니다 */
.gs-obs-ro{margin-top:12px; font-size:12.5px; color:var(--ink-2)}
.gs-obs-ro b{color:var(--ink)}
/* 물음은 경고가 아닙니다 — 빨강은 되돌릴 수 없는 것에만 씁니다 */
.gs-obs-why{border:0; background:transparent; font:inherit; font-size:12.5px; color:var(--gold);
  cursor:pointer; text-decoration:underline; text-underline-offset:3px; padding:0}
.gs-lookmore{display:block; margin-top:9px; border:0; background:transparent; font:inherit;
  font-size:12px; color:var(--ink-2); cursor:pointer; text-decoration:underline;
  text-underline-offset:3px; padding:2px 0}
.gs-lookmore:hover{color:var(--ink)}
/* 첫 칸에도 칸막이를 — 위 내용(주소·복사)과 붙어 있으면 어디부터가 생김새인지 안 보입니다 */
.gs-obs-look{margin-top:18px; padding-top:14px;
  border-top:1px dotted rgba(var(--ink-rgb),.28)}
/* 서브헤더 바로 밑은 선을 겹치지 않게 */
.gs-obs-look-first{margin-top:12px; padding-top:0; border-top:0}
.gs-obs-lookhead{display:flex; align-items:center; gap:12px; margin-bottom:4px}
.gs-obs-look h4{margin:0; font-size:13px}
.gs-obs-lookhead .gs-btn,.gs-obs-lookhead .gs-rc-look{margin-left:auto}
/* 제목 줄에 들어간 켬·끔은 라벨 자리를 안 씁니다 */
.gs-obs-lookhead .gs-rc-look > span{min-width:0}
.gs-obs-looknote{font-size:12px; color:var(--ink-2); margin:0 0 10px; line-height:1.65}
.gs-lookgrid{display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:8px}
.gs-lookchip{display:flex; flex-direction:column; gap:6px; font:inherit; font-size:11.5px;
  color:var(--ink-2); background:transparent; border:1px solid rgba(var(--ink-rgb),.25);
  border-radius:2px; padding:7px; cursor:pointer; text-align:center}
.gs-lookchip:hover{border-color:rgba(var(--ink-rgb),.55)}
.gs-lookchip.on{border-color:var(--gold); color:var(--ink)}
.gs-lookswatch{display:flex; align-items:center; justify-content:center; height:36px;
  border-radius:4px; overflow:hidden;
  background:linear-gradient(105deg, #b9c3a8 0 50%, #202b1c 50% 100%)}
.gs-lookswatch b{font-weight:600; font-size:11px; letter-spacing:.04em; padding:3px 10px;
  border-radius:6px; white-space:nowrap}
.sw-dark0 b{background:rgba(20,17,14,1); color:#f5f0e6}
.sw-goat b{background:rgba(20,17,14,.75); color:#f5f0e6}
.sw-light25 b{background:rgba(248,244,236,.75); color:#221c14}
.sw-goatline b{background:rgba(20,17,14,.75); color:#f5f0e6; box-shadow:0 0 0 1px rgba(232,198,106,.6)}
.sw-light25line b{background:rgba(248,244,236,.75); color:#221c14; box-shadow:0 0 0 1px rgba(34,28,20,.55)}
.sw-light0 b{background:rgba(248,244,236,1); color:#221c14}
.sw-clear b{color:#f5f0e6; text-shadow:0 0 5px rgba(0,0,0,.95), 0 1px 2px rgba(0,0,0,.95)}
.sw-cleardark b{color:#171310; text-shadow:0 0 5px rgba(255,255,255,.95), 0 1px 2px rgba(255,255,255,.95)}
.gs-lookalpha{display:flex; align-items:center; gap:10px; margin-top:10px}
.gs-lookalpha.off{opacity:.45}
.gs-lookalpha-note{font-size:11px; color:var(--ink-2)}
.gs-ro-look{flex:none}
/* 예시 줄 — 이름만 채우는 프리셋과 달리 표 전체 예시라는 구분선 */
.gs-crewdemo{border-top:1px dotted rgba(var(--ink-rgb),.3); margin-top:2px; padding-top:2px}
.gs-crewdemo + .gs-crewrow{border-top:1px dotted rgba(var(--ink-rgb),.3); margin-top:2px; padding-top:2px}
/* 접이 구역 */
/* 가이드는 이미지가 커서 목록만 스크롤 — 닫기 버튼은 항상 화면 안에 있습니다 */
.gs-obs-guide{margin:10px 0 0 18px; font-size:12.5px; color:var(--ink-body); line-height:1.8}
.gs-obs-guide li{margin-bottom:14px}
/* 그림은 폭 520·높이 380 안에 — 1번 그림(소스 목록)은 세로가 길어 폭만 묶으면 화면 한 장을 다 먹습니다 (2026-09-05) */
.gs-obs-guide img{display:block; width:auto; max-width:min(100%,520px); max-height:380px; margin-top:8px;
  border-radius:4px; border:1px solid rgba(var(--ink-rgb),.25)}
/* 주소와 계정 안내 창 — 두 칸을 나란히 놓고 같은 자리에서 비교합니다 */
.gs-gain-lead{margin:0 0 16px; font-size:13px; color:var(--ink-body); line-height:1.8}
/* 가이드 첫 부분의 그림 (2026-09-06 리뉴얼) — 선으로 그린 장면, 글자는 svg 안이라 크기를 여기서 */
.gs-gain-scene{margin:12px 0; padding:8px 6px 4px; border-radius:3px; background:rgba(var(--ink-rgb),.05)}
.gs-gain-scene svg{display:block; width:100%; height:auto}
.gs-gain-scene text{font-family:inherit; font-size:11px}
.gs-gain-scenecap{margin:6px 0 0; font-size:11px; color:var(--ink-2); text-align:center}
.gs-gain-scenecap b{color:var(--ink); font-weight:600}
.gs-gain-col h4 .gs-gain-tag{margin-left:6px; vertical-align:middle}
.gs-gain-cols{display:grid; grid-template-columns:1fr 1fr; gap:14px}
.gs-gain-col{border:1px solid rgba(var(--ink-rgb),.2); border-radius:4px; padding:14px;
  background:rgba(var(--lift-rgb),.28)}
.gs-gain-col h4{margin:0; font-size:14px; color:var(--ink); font-weight:700}
.gs-gain-tag{display:inline-block; font-size:10.5px; letter-spacing:.1em; color:var(--ink-2);
  border:1px solid rgba(var(--ink-rgb),.28); border-radius:2px; padding:2px 7px}
.gs-gain-sub{margin:7px 0 0; font-size:12px; color:var(--ink-2)}
.gs-gain-art{display:flex; align-items:center; justify-content:center; gap:8px; flex-wrap:wrap;
  margin:12px 0; padding:12px 8px; border-radius:3px; background:rgba(var(--ink-rgb),.05)}
.gs-gain-src{font-size:11px; color:var(--ink-body); border:1px solid rgba(var(--ink-rgb),.28);
  border-radius:2px; padding:4px 8px; background:var(--paper); text-align:center}
.gs-gain-outs{display:flex; flex-direction:column; gap:4px}
.gs-gain-outs i{font-style:normal; font-size:10.5px; color:var(--ink-2);
  border:1px solid rgba(var(--ink-rgb),.22); border-radius:2px; padding:3px 7px; background:var(--paper)}
.gs-gain-arrow{color:var(--ink-2); font-size:13px}
.gs-gain-list{margin:0; padding:0; list-style:none; font-size:12px; color:var(--ink-body);
  line-height:1.7; display:flex; flex-direction:column; gap:7px}
.gs-gain-list li{padding-left:18px; position:relative}
.gs-gain-list li::before{position:absolute; left:0; top:0}
.gs-gain-list li.yes::before{content:"✓"; color:var(--gold)}
.gs-gain-list li.no::before{content:"—"; color:var(--ink-2)}
.gs-dialog h4.gs-gain-h{margin:24px 0 12px; font-size:14px; color:var(--ink); font-weight:700}
.gs-gain-note{margin:10px 0 0; font-size:11.5px; color:var(--ink-2); line-height:1.7}
.gs-gain-foot{margin:20px 0 0; padding-top:14px; font-size:12.5px; color:var(--ink-body);
  line-height:1.8; border-top:1px dotted rgba(var(--ink-rgb),.28)}
/* 편집 권한 창 — OBS 설정에서 쓰던 줄 모양을 그대로 씁니다 */
.gs-key p{margin:0 0 8px; font-size:12.5px; color:var(--ink-2); line-height:1.8}
.gs-key-foot{margin-top:16px !important; padding-top:12px; font-size:11.5px !important;
  border-top:1px dotted rgba(var(--ink-rgb),.25)}
.gs-obs-warn{color:var(--red) !important; opacity:.9}
/* 공유 설정 창의 단 제목 */
.gs-key-h{margin:18px 0 6px; font-size:13.5px; color:var(--ink);
  display:flex; align-items:center; gap:10px}
.gs-key h4.gs-key-h:first-child{margin-top:0}
/* 문장 안에 버튼을 끼우면 줄바꿈에 따라 "두세요."만 남고 그 옆에 버튼이 붙어
   답답해 보입니다. 버튼은 제 줄에 세웁니다 */
.gs-obs-keysline{margin:16px 0 0}
.gs-obs-keysline p{margin:0 0 11px; font-size:12.5px; color:var(--ink-2); line-height:1.75}
.gs-acts-end{justify-content:flex-end; margin-top:16px}
.gs-fold{display:block; font:inherit; font-size:12px; color:var(--ink-2);
  background:transparent; border:0; cursor:pointer; padding:8px 2px 2px; text-align:left}
.gs-fold:hover{color:var(--ink)}
/* 지난 판 줄 */
.gs-genrow{display:flex; align-items:center; gap:9px; background:rgba(var(--ink-rgb),.05);
  border:1px solid rgba(var(--ink-rgb),.2); border-radius:7px; padding:8px 11px;
  margin-top:7px; font-size:12.5px}
.gs-genrow b{font-weight:600; color:var(--ink)}
.gs-genrow-meta{font-size:11px; color:var(--ink-2)}
.gs-genrow-r{margin-left:auto; display:flex; gap:7px; align-items:center}
.gs-genlock{font:inherit; font-size:11px; border:1px solid rgba(var(--ink-rgb),.35);
  background:transparent; color:var(--ink-2); border-radius:99px; padding:2px 9px;
  cursor:pointer}
.gs-genlock.on{border-color:rgba(var(--gold-rgb),.7); color:var(--gold)}
/* 판의 신분증 띠 — 탭 위. 끝난 판·판 기록에서 마스트 왼쪽 버튼들의 자리를 씁니다 */
.gs-idbar{border-left:3px solid var(--gold); background:rgba(var(--gold-rgb),.07);
  border-top:1px solid rgba(var(--gold-rgb),.24); border-right:1px solid rgba(var(--gold-rgb),.24);
  border-bottom:1px solid rgba(var(--gold-rgb),.24);
  border-radius:0 7px 7px 0; padding:11px 14px; margin-bottom:12px}
.gs-idbar-t{display:flex; align-items:baseline; gap:10px; flex-wrap:wrap}
.gs-idname{margin:0; font-family:'Gowun Batang',serif; font-size:17px; font-weight:700;
  color:var(--ink)}
.gs-idwhen{font-size:11.5px; color:var(--ink-2)}
.gs-idmsg{font-size:12.5px; color:var(--ink-body)}
.gs-idmsg b{color:var(--ink)}
.gs-idbar-r{margin-left:auto; display:flex; align-items:center; gap:10px}
.gs-idtot{font-family:var(--mono); font-size:18px; color:var(--gold)}
/* 출처 배지 — 파티는 금색, 로컬은 잉크 */
.gs-idsrc{flex:none; align-self:center; font-size:10px; letter-spacing:.1em;
  padding:3px 8px; border-radius:11px; border:1px solid rgba(var(--gold-rgb),.55);
  color:var(--gold); background:rgba(var(--gold-rgb),.1); white-space:nowrap}
.gs-idsrc-local{border-color:rgba(var(--ink-rgb),.32); color:var(--ink-2);
  background:rgba(var(--ink-rgb),.06)}
/* 파티원 칩 — 방장은 금색, 나는 파랑. 전부 적습니다 */
.gs-idmems{display:flex; flex-wrap:wrap; gap:5px; margin-top:9px}
.gs-idmem{font-size:11.5px; padding:3px 8px; border-radius:11px;
  background:rgba(var(--ink-rgb),.07); border:1px solid rgba(var(--ink-rgb),.16);
  color:var(--ink-body)}
.gs-idmem-host{border-color:rgba(var(--gold-rgb),.5); color:var(--gold)}
.gs-idmem-me{border-color:rgba(var(--blue-rgb),.5); color:var(--blue)}
/* 판 기록 목록의 한 줄 — 배지·이름·날짜·파티원 전부·총액·[×] */
.gs-hisrow{display:flex; align-items:flex-start; gap:10px; padding:10px 11px; margin-top:8px;
  border-radius:7px; background:rgba(var(--ink-rgb),.05);
  border:1px solid rgba(var(--ink-rgb),.18)}
.gs-hisbody{flex:1; min-width:0; font:inherit; text-align:left; background:none; border:0;
  padding:0; cursor:pointer; color:inherit; display:block}
.gs-hisbody:hover .gs-hist1 b{text-decoration:underline; text-underline-offset:3px}
.gs-hist1{display:flex; align-items:baseline; gap:7px}
.gs-hist1 b{font-family:'Gowun Batang',serif; font-weight:700; font-size:14.5px; color:var(--ink)}
.gs-hist1 span{font-size:11px; color:var(--ink-2)}
.gs-hisrow .gs-idmems{margin-top:7px}
.gs-hisrow .gs-idmem{font-size:11px; padding:2px 7px}
.gs-hisgold{font-family:var(--mono); font-size:14px; color:var(--gold); flex:none}
/* 방 생성 직후 복구 코드 안내 */
.gs-obs-fresh{margin-top:12px; padding:10px 12px; border:1px dashed rgba(var(--gold-rgb),.5);
  border-radius:6px; background:rgba(var(--gold-rgb),.06)}
.gs-obs-fresh p{margin:0 0 8px; font-size:12.5px; line-height:1.7; color:var(--ink-body)}
/* 시스템 줄 왼쪽 — 앱 이름 (워드프로세서의 앱 바 관행) */
.gs-sysbrand{font-size:14px; font-weight:800; letter-spacing:.04em; color:var(--ink);
  opacity:.92}
/* 지금 어느 화면인지 — 브랜드 옆 한 마디 (2026-09-05) */
.gs-sysscreen{font-size:12.5px; color:var(--ink-2); margin-left:11px; padding-left:13px;
  border-left:1px solid rgba(var(--ink-rgb),.22); letter-spacing:.03em; white-space:nowrap}
/* 소스 구성 — 카드 두 장의 그림이 "한 소스/나눈 소스"의 뜻을 말합니다.
   소스 나누기 문장 줄 바로 아래, 주소 카드 밖에 섭니다 (2026-09-05 재배치) */
.gs-obs-srcpick{display:flex; gap:10px; flex-wrap:wrap}
.gs-slook-c.src{flex:1 1 190px}
.gs-src-art{display:flex; align-items:center; justify-content:center; height:56px}
.gs-src-scr{position:relative; width:88px; height:52px; border-radius:5px;
  background:rgba(var(--ink-rgb),.08); border:1px solid rgba(var(--ink-rgb),.3);
  overflow:hidden; display:block}
/* 미니 현황판 — 가로줄 세 개짜리 판 */
.gs-src-tbl{position:absolute; left:7px; top:7px; width:36px; height:38px; border-radius:3px;
  background:
    linear-gradient(rgba(var(--gold-rgb),.55) 0 0) 4px 6px/28px 3px no-repeat,
    linear-gradient(rgba(var(--ink-rgb),.4) 0 0) 4px 15px/28px 3px no-repeat,
    linear-gradient(rgba(var(--ink-rgb),.4) 0 0) 4px 24px/28px 3px no-repeat,
    rgba(var(--ink-rgb),.1);
  border:1px solid rgba(var(--ink-rgb),.35)}
.gs-src-tbl.sm{width:26px; height:26px; left:5px; top:5px;
  background:
    linear-gradient(rgba(var(--gold-rgb),.55) 0 0) 3px 5px/20px 2px no-repeat,
    linear-gradient(rgba(var(--ink-rgb),.4) 0 0) 3px 11px/20px 2px no-repeat,
    linear-gradient(rgba(var(--ink-rgb),.4) 0 0) 3px 17px/20px 2px no-repeat,
    rgba(var(--ink-rgb),.1)}
/* 미니 원판 */
.gs-src-disc{position:absolute; border-radius:50%;
  background:conic-gradient(#3c86ba 0 90deg, #3f9c72 90deg 180deg,
    #d9a83e 180deg 270deg, #c8493e 270deg 360deg);
  box-shadow:0 0 0 1.5px rgba(var(--gold-rgb),.7)}
.gs-src-disc.mid{width:20px; height:20px; right:14px; top:16px}
.gs-src-disc.big{width:34px; height:34px; left:50%; top:50%; transform:translate(-50%,-50%)}
/* 나눈 소스의 주소 두 줄 */
.gs-obs-srcrow{display:flex; align-items:center; gap:8px; margin-top:8px}
.gs-obs-srcnote + .gs-obs-srcrow,.gs-obs-srcpick + .gs-obs-srcrow{margin-top:14px}
.gs-obs-srcrow > b{flex:0 0 44px; font-size:12.5px; color:var(--ink-body)}
.gs-obs-srcrow .gs-obs-urltext{flex:1; min-width:0}
/* .gs-dialog p 가 더 세서(선택자 무게) 창 안에서는 그쪽이 이깁니다 — 여기서 이겨야
   설명이 줄 목록과 같은 소리로 말합니다 */
.gs-dialog .gs-obs-srcnote{margin:6px 0 0; font-size:11.5px; color:var(--ink-2); line-height:1.7}
/* 주소 자리에 앉는 한글 안내 — 주소 글꼴(고정폭)을 쓰면 자간이 벌어져 늘어져 보입니다 */
.gs-obs-urlnote{flex:1 1 auto; min-width:0; font-size:12.5px; color:var(--ink-2);
  overflow:hidden; text-overflow:ellipsis; white-space:nowrap}
/* 주소 줄 아래 설명 한 줄 */
.gs-obs-oneline{margin:8px 0 0 !important; font-size:12.5px; color:var(--ink-2); line-height:1.75}
/* 설명은 왼쪽, 하는 것은 오른쪽 끝 — 한 줄 안 모양을 맞춥니다 (§9-1) */
.gs-obs-line{display:flex; align-items:center; gap:12px; flex-wrap:wrap; margin-top:14px}
.gs-obs-linetxt{flex:1 1 220px; min-width:0; font-size:11.5px; color:var(--ink-2); line-height:1.7}
.gs-obs-line .gs-btn,.gs-obs-line .gs-seg,.gs-obs-line .gs-obs-lineact{margin-left:auto; flex:none}
/* 주소 줄 — 주소가 남는 자리를 다 쓰고 새로 발급은 오른쪽 끝에 붙습니다.
   되돌릴 수 없는 단추라 복사 단추들과는 줄을 나눕니다. */
.gs-obs-boxtop{display:flex; align-items:center; gap:10px}
/* 주소 상자 (2026-09-06 사용자: 주소에 박스를 넣어 강조) — 나눈 소스는 줄마다 상자, 글자는 조금 작게 */
.gs-obs-addrbox{margin-top:12px; padding:9px 10px 9px 12px; border:1px solid rgba(var(--gold-rgb),.6); border-radius:3px; background:rgba(var(--lift-rgb),.35)}
.gs-obs-addrbox .gs-obs-urltext{font-size:17px; color:var(--gold); letter-spacing:.01em}
.gs-obs-addrbox-2 .gs-obs-urltext{font-size:14px}
.gs-obs-addrbox-2 + .gs-obs-addrbox-2{margin-top:8px}
.gs-btn-copy{padding:9px 16px; font-size:13px}
.gs-obs-boxtop .gs-obs-urltext{flex:1 1 auto; min-width:0}
.gs-obs-reissue{display:inline-flex; align-items:center; gap:6px; flex:0 0 auto}
/* 뷰어 배너 */
.gs-slip-live{border-left-color:var(--kraft-dk); background:rgba(var(--ink-rgb),.06)}
.gs-slip-live .gs-slip-msg{color:var(--ink-body)}
.gs-slip-dead{border-left-color:var(--red); background:rgba(var(--red-rgb),.09)}
.gs-slip-dead .gs-slip-msg{color:var(--red)}
.gs-slip-who{margin-left:auto; font-size:12.5px; color:var(--ink-2);
  display:inline-flex; align-items:center}
/* 초록 점 — 붙어 있다는 표시. 갱신이 올 때마다 한 번 퍼집니다 */
.gs-live-dot{display:inline-block; width:7px; height:7px; border-radius:50%;
  background:#6fbf73; margin:0 5px 0 11px; animation:gs-liveblink .8s ease}
@keyframes gs-liveblink{from{box-shadow:0 0 0 0 rgba(111,191,115,.65)}
  to{box-shadow:0 0 0 7px rgba(111,191,115,0)}}
/* 뷰어가 뭘 누르면 배너가 한 번 꿈틀 — "여긴 읽기 전용"의 무언의 대답 */
.gs-slip-pulse{animation:gs-ropulse .45s ease}
@keyframes gs-ropulse{30%{transform:scale(1.012);
  box-shadow:0 0 0 2px rgba(var(--gold-rgb),.45)}}
@media (prefers-reduced-motion:reduce){ .gs-live-dot,.gs-slip-pulse{animation:none} }

/* 명단 — 버튼 아래 작은 목록 */
/* 시스템 줄 — 컨테이너 여백을 상쇄해 뷰포트 위·양옆에 딱 붙습니다.
   안쪽 내용은 .gs-mast 와 같은 폭 규격이라 본문 오른쪽 끝과 열이 맞습니다 */
.gs-sysbar{margin:-20px -20px 18px; padding:7px 20px;
  background:rgba(var(--ink-rgb),.05); border-bottom:1px solid rgba(var(--ink-rgb),.14)}
.gs-sysbar-in{max-width:var(--stage); margin:0 auto; display:flex; align-items:center; gap:12px}
.gs-sysbar-r{display:flex; align-items:center; gap:10px; margin-left:auto}
/* 줄 안 컨트롤은 전부 32px 한 높이·같은 좌우 여백으로. 칩마다 높이와 여백이 다르면
   같은 줄에 선 것들이 저마다 다른 물건처럼 보입니다 */
.gs-sysbar .gs-btn{height:32px; padding-top:0; padding-bottom:0;
  display:inline-flex; align-items:center}
/* 테마·도움말은 테두리를 벗겨 아이콘만 남깁니다 — 평생 몇 번 안 누르는 것들이
   계정·오버레이와 같은 무게로 서 있으면 눈이 우선순위를 못 잡습니다 (§9) */
.gs-sysbar .gs-viewseg{margin-bottom:0; border-color:transparent}
.gs-sysbar .gs-viewseg button{height:30px; width:31px} /* 테두리 포함 32px — 줄 안 한 높이 */
.gs-sysbar .gs-qm{width:32px; height:32px; font-size:12px; border-color:transparent}
.gs-sysbar .gs-qm:hover,.gs-sysbar .gs-viewseg:hover{border-color:rgba(var(--ink-rgb),.3)}
/* 하는 일(왼쪽)과 나(오른쪽)를 가르는 실선 */
.gs-sysbar-sep{width:1px; height:18px; background:rgba(var(--ink-rgb),.18); flex:none}
.gs-sysbar .gs-roomchip{height:32px; padding:0 11px}
.gs-sysbar .gs-backrow{margin:0 0 0 -4px}
/* 제목 줄 — 파티명 상자와 높이가 맞도록, 제목의 옛 윗여백(장식 줄 시절)을 걷어냅니다 */
.gs-mastrow .gs-title{margin-top:0}
/* 뒤로가기 — 제목 위에 따로 두어 '목록으로 돌아간다'로 읽히게 */
.gs-backrow{display:inline-flex; align-items:center; gap:6px; border:0; background:transparent;
  font:inherit; font-size:12.5px; color:var(--ink-2); cursor:pointer; padding:3px 8px 3px 4px;
  border-radius:6px; margin:0 0 2px -4px}
.gs-backrow:hover{background:rgba(var(--ink-rgb),.08); color:var(--ink)}
.gs-backrow i{font-style:normal; font-size:16px; line-height:1}
/* 파티명 — 제목과 같은 서체라 '기본 벌금 정산'처럼 이어 읽힙니다 */
.gs-partysel{position:relative}
.gs-party-dd{display:inline-flex; align-items:stretch; gap:0; background:transparent;
  border:1px solid var(--chip-bg); border-radius:2px; overflow:hidden;
  font-family:'Gowun Batang',serif; font-weight:700; letter-spacing:-.02em; color:var(--ink);
  font-size:clamp(24px,3.5vw,34px); line-height:1.1; cursor:pointer;
  padding:0; max-width:44vw}
.gs-party-nm{padding:1px 10px 5px 10px; min-width:0; overflow:hidden;
  text-overflow:ellipsis; white-space:nowrap}
.gs-party-dd:hover .gs-party-nm{background:rgba(var(--ink-rgb),.06)}
/* 오른쪽 틴트 띠 — 여기가 드롭다운임을 알립니다. ▾ 는 띠의 정중앙 */
.gs-party-dd i{display:flex; align-items:center; justify-content:center; width:26px; flex:none;
  font-style:normal; font-size:12px; color:var(--ink-2);
  background:rgba(var(--ink-rgb),.09); border-left:1px solid var(--chip-bg)}
.gs-party-dd:hover i{background:rgba(var(--ink-rgb),.16); color:var(--ink)}
.gs-crewmenu.gs-partymenu{left:0; right:auto; top:calc(100% + 8px); width:min(320px,86vw);
  padding:7px}
.gs-partymenu .gs-crewload{font-family:'Gowun Batang',serif; font-weight:700; font-size:15.5px;
  padding:11px 26px 11px 12px; gap:9px}
.gs-partymenu .gs-crewload em{font-family:'IBM Plex Sans KR',system-ui,sans-serif;
  font-weight:500; font-size:11px}
.gs-partymenu .gs-crewdemo{margin-top:4px; padding-top:4px;
  border-top:1px dotted rgba(var(--ink-rgb),.3)}
.gs-partymenu .gs-crewsave{margin-top:4px; padding-top:9px}
.gs-ex-badge{font-style:normal; font-size:11px; color:var(--gold);
  font-family:'IBM Plex Sans KR',system-ui,sans-serif; font-weight:500}
.gs-crewload.gs-party-on{font-weight:700}
.gs-crewload.gs-party-on em{color:var(--gold-ink,var(--ink-2))}
/* 파티 로비 — 첫 방문 화면과 같은 종이 질감의 전체 화면 */
.gs-lobby{position:fixed; inset:0; z-index:45; overflow:auto; background:var(--kraft);
  background-image:
    radial-gradient(120% 80% at 15% 0%, rgba(var(--lift-rgb),.16), transparent 55%),
    repeating-linear-gradient(92deg, rgba(var(--tex-rgb),.035) 0 1px, transparent 1px 5px),
    repeating-linear-gradient(4deg, rgba(var(--tex-rgb),.03) 0 1px, transparent 1px 7px);
  padding:42px 20px 60px}
.gs-lobby-in{max-width:640px; margin:0 auto}
.gs-lobby-in > .gs-title{margin:14px 0 0}
.gs-lobby-lead{font-size:13px; color:var(--ink-2); margin:12px 0 26px; line-height:1.7}
.gs-lobby-list{display:flex; flex-direction:column; gap:12px}
.gs-lobby-card{display:flex; align-items:stretch; position:relative;
  border:1px solid var(--chip-bg); border-radius:2px; background:rgba(var(--lift-rgb),.05)}
.gs-lobby-card.on{border-color:var(--gold)}
.gs-lobby-open{flex:1; min-width:0; display:flex; flex-direction:column; gap:7px; border:0;
  background:transparent; font:inherit; color:var(--ink); cursor:pointer; text-align:left;
  padding:15px 44px 15px 18px}
.gs-lobby-open:hover{background:rgba(var(--ink-rgb),.06)}
.gs-lobby-name{display:flex; align-items:baseline; gap:12px}
.gs-lobby-name b{font-family:'Gowun Batang',serif; font-weight:700; font-size:21px;
  letter-spacing:-.01em}
.gs-lobby-name em{font-style:normal; font-size:11.5px; color:var(--gold)}
.gs-lobby-now{font-weight:600}
.gs-lobby-meta{display:flex; align-items:baseline; gap:7px; font-size:12.5px; color:var(--ink-2);
  line-height:1.5}
.gs-lobby-meta em{font-style:normal}
/* 모드 세그 — 툴바로 오면서 잃은 아이콘-글자 정렬을 되살립니다 */
.gs-modebar .gs-seg button{display:inline-flex; align-items:center; gap:6px}
.gs-modebar .gs-seg svg{opacity:.85; flex:none}
/* 표 윗줄 — 왼쪽 조작법, 오른쪽 채팅 복사 */
.gs-tablebar{display:flex; align-items:flex-end; justify-content:space-between; gap:12px;
  margin-bottom:16px}
.gs-tablebar .gs-cellnote{margin:0 0 8px}
/* 창 머리 — 제목은 왼쪽, X는 항상 오른쪽 위. 본문만 스크롤됩니다 */
/* 창 머리 한 벌 — 오버레이 공유 설정 창과 같은 얼굴입니다 (2026-09-05) */
.gs-dialog-head{display:flex; align-items:center; gap:14px; flex:none;
  margin:-20px -20px 14px; padding:18px 20px 12px; background:var(--paper);
  border-bottom:1px solid rgba(var(--ink-rgb),.12)}
.gs-dialog-head h3{margin:0}
.gs-dialog-x{margin-left:auto; font-size:22px; width:30px; height:30px; flex:none}
.gs-dialog-body{overflow-y:auto; min-height:0; margin:0 -4px; padding:0 4px}
/* 질문형 사용법 — 표제(질문)를 줄로 띄워 훑기 쉽게 */
.gs-help-qa li{margin-bottom:13px}
.gs-help-qa b{display:block; margin-bottom:3px}
/* 사용법 — 다시 보기는 머리 줄 오른쪽. 졸업 직후엔 금테로 숨쉬며 자리를 알립니다 */
.gs-help-replay{margin-left:auto}
.gs-help-sec{margin-top:14px}
.gs-help-sec:first-of-type{margin-top:16px}
.gs-help-sec h4{margin:0 0 2px; font-size:13px; letter-spacing:.04em}
/* 정산 방식 설명 창 */
.gs-split-lead{font-size:12.5px; color:var(--ink-2); margin:2px 0 4px; line-height:1.7}
.gs-split-sec{margin-top:16px}
.gs-split-sec h4{margin:0 0 6px; font-size:13.5px}
.gs-split-sec p{margin:0 0 10px; font-size:12.5px; line-height:1.7; color:var(--ink-body)}
/* 삭제·개명은 평소엔 옅게 — 카드에 올리면 또렷해집니다 */
.gs-lobby-card .gs-x{position:absolute; right:10px; top:50%; transform:translateY(-50%);
  opacity:.45; transition:opacity .12s}
.gs-lobby-card .gs-lobby-edit{right:40px; font-size:13px}
.gs-lobby-editrow{flex:1; display:flex; align-items:center; gap:8px; padding:12px 16px}
.gs-lobby-editrow .gs-in{flex:1; min-width:0; font-family:'Gowun Batang',serif; font-size:17px}
.gs-lobby-card:hover .gs-x, .gs-lobby-card .gs-x:focus-visible{opacity:1}
.gs-lobby-add{display:flex; align-items:center; gap:9px; margin-top:16px; padding:11px 14px;
  border:1px dashed rgba(var(--ink-rgb),.32); border-radius:2px}
.gs-lobby-add .gs-in{flex:1; min-width:0}
.gs-lobby-demo{display:flex; flex-direction:column; gap:7px; width:100%; margin-top:30px;
  border:1px dashed rgba(var(--ink-rgb),.32); border-radius:2px; background:transparent;
  font:inherit; color:var(--ink-2); text-align:left; padding:15px 18px; cursor:pointer;
  line-height:1.5}
.gs-lobby-demo:hover{border-color:rgba(var(--ink-rgb),.55); background:rgba(var(--ink-rgb),.04)}
.gs-lobby-demo .gs-lobby-name b{font-size:18px; color:var(--ink)}
.gs-crewwrap{position:relative}
.gs-crewmenu{position:absolute; top:calc(100% + 6px); right:0; z-index:60; width:min(262px,82vw);
  background:var(--paper); border:1px solid var(--kraft-dk); border-radius:2px;
  box-shadow:0 10px 26px rgba(var(--shadow-rgb),.32); padding:5px}
.gs-crewrow{display:flex; align-items:center; position:relative}
.gs-crewrow .gs-x{position:absolute; right:3px; top:50%; transform:translateY(-50%); opacity:0}
.gs-crewrow:hover .gs-x, .gs-crewrow .gs-x:focus-visible{opacity:1}
.gs-crewload{flex:1; min-width:0; display:flex; align-items:baseline; gap:10px; border:0;
  background:transparent; font:inherit; font-size:13.5px; color:var(--ink); cursor:pointer;
  text-align:left; padding:8px 24px 8px 8px; border-radius:2px}
.gs-crewload:hover{background:rgba(var(--ink-rgb),.08)}
.gs-crewload em{font-style:normal; font-size:11px; color:var(--ink-2); margin-left:auto}
.gs-crewsave{display:flex; align-items:center; gap:7px; margin-top:5px; padding:8px 8px 5px 8px;
  border-top:1px dotted rgba(var(--ink-rgb),.3)}
.gs-crewsave .gs-in{flex:1; min-width:0; font-size:12.5px; padding:4px 2px;
  border-bottom:1px solid rgba(var(--ink-rgb),.35)}
.gs-crewsave .gs-btn{flex:none}

/* 기타 빠른 등록 — 칸 안에 한 줄로 */
.gs-disc-view{min-height:52px; display:flex; flex-direction:column; align-items:center;
  justify-content:center; gap:2px}
.gs-qx{display:flex; flex-direction:column; gap:3px; padding:5px 2px; min-height:52px;
  justify-content:center}
.gs-qx-foot{display:flex; align-items:baseline; justify-content:space-between; gap:8px}
.gs-qx-foot > .gs-qx-why:last-child{margin-left:auto}
.gs-qx-list{color:var(--red); text-decoration:underline; white-space:nowrap}
.gs-qx-row{display:flex; align-items:center; gap:5px}
.gs-qx-in{flex:1; min-width:0; font-family:var(--mono); font-size:17px; text-align:right;
  padding:5px 4px; border:1px solid rgba(var(--ink-rgb),.35); border-radius:2px;
  background:rgba(var(--lift-rgb),.25); color:var(--red)}
.gs-qx-unit{flex:none; font-style:normal; font-size:10.5px; color:var(--ink-2)}
.gs-qx-go{flex:none; padding:5px 9px; font-size:11.5px}
.gs-qx-why{border:0; background:transparent; font:inherit; font-size:11px; cursor:pointer;
  color:var(--ink-2); text-decoration:underline; text-underline-offset:3px; padding:1px 0}
.gs-qx-why:hover{color:var(--red)}
/* 사유 창 */
.gs-ra{display:flex; align-items:center; gap:9px; margin-top:12px}
.gs-ra-amt{width:96px; font-family:var(--mono); font-size:16px; text-align:right;
  border-bottom:1px solid rgba(var(--ink-rgb),.35); padding:5px 2px; color:var(--red)}
.gs-ra-why{flex:1; min-width:0; font-size:14px; border-bottom:1px solid rgba(var(--ink-rgb),.35);
  padding:5px 2px}

/* 기타 편집기 */
.gs-exrow > td{background:rgba(var(--kraft-rgb),.16); padding:2px 14px 14px !important}
.gs-ex-head{display:flex; align-items:baseline; gap:9px; padding-bottom:9px;
  border-bottom:1px dashed rgba(var(--ink-rgb),.3)}
.gs-ex-who{font-family:'Gowun Batang',serif; font-size:15px; font-weight:700}
.gs-ex-cap{flex:1; font-size:10.5px; letter-spacing:.12em; color:var(--ink-2)}
.gs-fold{border:1px solid rgba(var(--ink-rgb),.3); background:transparent; font:inherit; font-size:11.5px;
  color:var(--ink-2); cursor:pointer; padding:4px 10px; border-radius:2px}
.gs-fold:hover{color:var(--ink); border-color:var(--ink); background:rgba(var(--ink-rgb),.06)}
.gs-ex-list{list-style:none; margin:0; padding:0}
.gs-ex-list li,.gs-ex-add{display:flex; align-items:center; gap:8px; padding:7px 0}
.gs-ex-list li{border-bottom:1px dotted rgba(var(--ink-rgb),.2)}
.gs-ex-add{padding-top:10px}
.gs-ex-amt{flex:none; width:92px; font-family:var(--mono); font-size:14px;
  text-align:right; color:var(--red); border-bottom:1px dotted rgba(var(--ink-rgb),.45); padding:3px 2px}
.gs-ex-g{flex:none; font-size:11px; color:var(--ink-2)}
.gs-ex-why{flex:1; min-width:0; font-size:13px;
  border-bottom:1px dotted rgba(var(--ink-rgb),.45); padding:3px 2px}

.gs-grid tfoot td{border-top:1.5px solid var(--ink); padding-top:9px !important;
  font-family:var(--mono); font-size:13px; text-align:center; color:var(--ink-2)}
.gs-grid tfoot th{border-top:1.5px solid var(--ink); padding-top:9px !important}
.gs-foot-disc{color:var(--red) !important; opacity:.75}
.gs-foot-lab{margin-right:10px; vertical-align:middle}
.gs-foot-grand{text-align:right !important; padding-right:6px !important;
  font-size:15px !important; color:var(--ink) !important; opacity:1}

/* 우편 */
.gs-envs{display:flex; flex-direction:column; gap:14px}
.gs-env{animation:gs-in .5s cubic-bezier(.2,.7,.3,1) backwards; animation-delay:calc(var(--i,0) * 65ms)}
@keyframes gs-in{from{opacity:0; transform:translateY(10px) rotate(-.4deg)} to{opacity:1; transform:none}}
.gs-env-air{padding:6px; box-shadow:0 6px 18px rgba(var(--shadow-rgb),.16);
  background:repeating-linear-gradient(45deg,
    var(--red) 0 9px, var(--paper) 9px 18px, var(--blue) 18px 27px, var(--paper) 27px 36px)}
.gs-env-body{position:relative; background:var(--paper); padding:18px 20px; display:flex;
  align-items:flex-start; justify-content:space-between; gap:16px; overflow:hidden}
.gs-env-body::after{content:''; position:absolute; inset:0; pointer-events:none;
  background:radial-gradient(90% 120% at 100% 0%, rgba(var(--kraft-rgb),.22), transparent 60%)}
.gs-env-main{min-width:0}
/* 우편 — 핵심(사람 이름·금액) 27px, 서브는 한 단계씩 */
.gs-addr{display:flex; align-items:baseline; gap:10px; padding:3px 0; max-width:430px;
  border-bottom:1px dotted rgba(var(--ink-rgb),.3)}
.gs-addr-lab{font-size:12px; letter-spacing:.1em; color:var(--ink-2); width:80px; flex:none}
.gs-addr-nm{font-family:'Gowun Batang',serif; font-size:27px; font-weight:700}

/* 카드 한 장 안의 받는 사람 줄들 */
.gs-lines{list-style:none; margin:10px 0 0; padding:0}
.gs-lines li{display:flex; align-items:baseline; justify-content:space-between; gap:14px;
  flex-wrap:wrap; padding:11px 0; border-bottom:1px dotted rgba(var(--ink-rgb),.28)}
.gs-line-who{display:flex; align-items:baseline; gap:10px; min-width:0}
.gs-line-nm{font-family:'Gowun Batang',serif; font-size:27px; font-weight:700; color:var(--blue)}
.gs-line-money{display:flex; align-items:baseline; gap:4px; white-space:nowrap}
.gs-line-amt{font-family:var(--mono); font-size:27px; line-height:1; color:var(--gold)}
.gs-line-unit{font-size:14px; color:var(--ink-2)}
.gs-line-money em{font-style:normal; font-family:var(--mono); font-size:14px;
  color:var(--ink-2); margin-left:9px}
.gs-env-foot{margin-top:12px; font-size:14px; letter-spacing:.04em; color:var(--ink-2)}
.gs-env-foot b{font-family:var(--mono); font-weight:400; font-size:17px; color:var(--ink)}
.gs-stamp{position:relative; z-index:1; flex:none; width:96px; text-align:center;
  padding:10px 5px 9px; border:2px dashed var(--red); background:var(--paper-2); color:var(--red);
  transform:rotate(-3.5deg); display:flex; flex-direction:column; gap:2px}
.gs-stamp-lab{font-size:10px; letter-spacing:.14em}
.gs-stamp-num{font-family:var(--mono); font-size:19px; line-height:1.1}
.gs-stamp-pct{font-family:var(--mono); font-size:11px; opacity:.75}
.gs-mark{position:absolute; right:62px; top:14px; width:56px; height:56px; border-radius:50%;
  border:1.5px solid var(--red); box-shadow:0 0 0 3px var(--paper), 0 0 0 4.5px var(--red);
  display:grid; place-items:center; transform:rotate(-14deg); opacity:.42;
  mix-blend-mode:multiply; pointer-events:none}
.gs-mark span{font-family:'Gowun Batang',serif; font-size:13px; color:var(--red); letter-spacing:.1em}

/* ---- 좁은 화면: 누르려고 옆으로 밀지 않게 ----
   벌금표에서 입력에 쓰는 열(이름 + 항목)만 한 화면에 넣습니다.
   합계와 기타는 파생·부가라서 스크롤 뒤에 있어도 입력에 지장이 없습니다.
   글씨가 작아지는 건 감수합니다 — 여기는 읽는 화면이 아니라 누르는 화면입니다. */

.gs-empty{background:var(--paper); border:1px dashed var(--kraft-dk); padding:34px 22px; text-align:center}
.gs-empty p{margin:0; font-family:'Gowun Batang',serif; font-size:17px}
.gs-empty-sub{margin-top:8px !important; font-family:'IBM Plex Sans KR',sans-serif !important;
  font-size:13px !important; color:var(--ink-2)}
.gs-proof{margin:15px 0 0; font-family:var(--mono); font-size:13.5px; line-height:1.8;
  color:var(--ink-body); border-left:2px solid var(--ink); padding-left:11px; max-width:70ch}
.gs-proof b{color:var(--red)}

/* 정산 장부 — 핵심(이름·만 표기 금액) 24px, 서브는 한 단계씩 */
.gs-ledger{width:100%; border-collapse:collapse; font-family:var(--mono);
  font-size:13.5px; min-width:520px}
.gs-ledger th{font-family:'IBM Plex Sans KR',sans-serif; font-size:12.5px; letter-spacing:.12em;
  color:var(--ink-2); font-weight:500; text-align:right; padding:0 10px 8px;
  border-bottom:1.5px solid var(--ink); white-space:nowrap}
.gs-ledger td{text-align:right; padding:12px 10px; white-space:nowrap;
  border-bottom:1px dotted rgba(var(--ink-rgb),.26)}
.gs-ledger .gs-l{text-align:left}
.gs-man{display:block; font-size:24px; line-height:1.25}
.gs-raw{display:block; font-size:13px; line-height:1.35; color:rgba(var(--ink-rgb),.42); margin-top:2px}
.gs-nm{font-family:'Gowun Batang',serif; font-size:24px; font-weight:700}
.gs-pos{color:var(--blue)}
.gs-neg{color:var(--red)}
.gs-ledger em{font-style:normal; font-size:13px; color:var(--ink-2); margin-left:9px;
  font-family:'IBM Plex Sans KR',sans-serif}
.gs-dim{color:rgba(var(--ink-rgb),.35); font-family:'IBM Plex Sans KR',sans-serif; font-size:14px}

/* 룰렛 열 머리 — 단가 자리에 설정 버튼이 앉습니다 */
.gs-rcbtn{border:1px solid rgba(var(--gold-rgb),.55); border-radius:3px; background:transparent;
  font:inherit; font-size:11px; color:var(--gold-ink); cursor:pointer; padding:2px 6px;
  white-space:nowrap; display:inline-flex; align-items:center; gap:4px}
.gs-rcbtn:hover{background:rgba(var(--gold-rgb),.12)}
/* 톱니 — "누르면 열리는 설정"임을 아이콘이 말합니다 (2026-09-05) */
.gs-rcbtn svg{flex:none; opacity:.75}

/* 도는 판 — 화면에 띄워서 표를 안 밉니다 */
/* 확인창(50)보다 아래여야 "본인이 물기"가 안 가립니다 */
.gs-spinwrap{position:fixed; inset:0; z-index:46; display:flex; align-items:center;
  justify-content:center; background:rgba(0,0,0,.5); cursor:pointer;
  animation:gs-spindim .18s ease-out}
@keyframes gs-spindim{from{opacity:0} to{opacity:1}}
/* 양도를 고를 때는 덮개를 걷습니다 — 표를 눌러야 하니까요 */
/* 넘길 사람을 고르는 동안에는 표를 봐야 합니다 — 화면 아래에 눕혀 붙입니다 */
/* 파티원 화면은 고를 게 없으니 누를 수도 없습니다 */
.gs-spinwrap-view{cursor:default}
.gs-spinwrap-view .gs-spin{cursor:default}
.gs-spinwrap-pick{background:transparent; pointer-events:none; align-items:flex-end;
  padding:0 0 max(12px,2vh)}
.gs-spinwrap-pick .gs-spin{pointer-events:auto; box-shadow:0 -8px 28px rgba(0,0,0,.4);
  display:flex; flex-direction:row; align-items:center; gap:10px 14px; flex-wrap:wrap;
  justify-content:center; padding:8px 16px; min-width:min(660px,96vw)}
.gs-spinwrap-pick .gs-spin-stage{min-height:0; min-width:0}
.gs-spinwrap-pick .gs-spin-face{font-size:26px}
.gs-spinwrap-pick .gs-spin-who{gap:5px}
.gs-spinwrap-pick .gs-spin-who b{font-size:14px}
.gs-spinwrap-pick .gs-spin-out{display:flex; align-items:center; gap:10px; flex-wrap:wrap;
  justify-content:center}
.gs-spinwrap-pick .gs-spin-out > b{font-size:16px}
.gs-spinwrap-pick .gs-spin-ask{font-size:12px}
/* 아래에 붙은 줄이 가리는 만큼 표 밑에 자리를 둡니다 — 스크롤로 피할 수 있게 */
.gs-picking .gs-card{margin-bottom:112px}

.gs-spin{margin:0; min-width:min(600px,94vw); padding:24px 32px 20px; cursor:default; border:1px solid rgba(var(--gold-rgb),.55);
  border-radius:6px; background:rgba(var(--gold-rgb),.07); display:grid; gap:9px;
  justify-items:center; text-align:center}
.gs-spin{--sp-ink:#ece4d6; --sp-ink2:#a89a88; --sp-gold:#dcae5e; color:var(--sp-ink);
  background:radial-gradient(120% 90% at 50% 12%, #322721 0%, #1d1712 58%, #17110d 100%);
  box-shadow:inset 0 0 60px rgba(0,0,0,.45), 0 18px 50px rgba(0,0,0,.55)}
.gs-spin .gs-spin-who{color:var(--sp-ink2)}
.gs-spin .gs-spin-who b{color:var(--sp-ink)}
.gs-spin .gs-spin-skip{color:var(--sp-ink2)}
.gs-spin .gs-spin-ask{color:#c9bda9}
.gs-spin .gs-spin-self{color:var(--sp-ink2)}
.gs-spin .gs-spin-self:hover{color:var(--sp-ink)}
.gs-spin .gs-spin-out > b{color:#fff}
.gs-spin .gs-spin-out > b em{font-style:normal; font-size:14px; font-weight:400;
  color:var(--sp-ink2); margin-left:7px}
.gs-spin-pick{border-color:var(--red); background:var(--paper,#2a2320)}
/* 안내 자리는 늘 잡아 둡니다 — 글자가 생기며 판이 커지면 눈이 튑니다 */
.gs-spin-gone{font-size:12.5px; color:#dcae5e; opacity:.9; min-height:18px}
.gs-spin-status{font-size:20px; color:var(--ink-body); letter-spacing:.02em}
.gs-spin .gs-spin-status{color:#c9bda9}
.gs-spin-skip{font-size:12px; color:var(--ink-2); opacity:.7; min-height:17px}
.gs-spin-skip.off{visibility:hidden}
/* 이름 줄도 높이를 못 박습니다 — 글자 크기가 다른 것이 섞이면 줄 높이가 달라집니다 */
.gs-spin-who{display:flex; gap:10px; align-items:center; justify-content:center; height:34px;
  overflow:hidden; font-size:16px; color:var(--ink-2)}
.gs-spin-who b{font-size:24px; color:var(--ink)}
.gs-spin-stage{position:relative; display:flex; align-items:center; justify-content:center;
  min-height:72px; min-width:150px}
/* 답이 없는 동안 끝없이 도는 원판 — 멈출 때 지금 각도를 이어받습니다 */
/* from 을 반드시 적습니다 — 시작값이 rotate() 가 아니면 행렬 보간으로 떨어져
   한 바퀴가 제자리가 됩니다 */
@keyframes gs-freespin{from{transform:rotate(0deg)} to{transform:rotate(360deg)}}
.gs-wheel-free{animation:gs-freespin var(--freems,260ms) linear infinite; transition:none !important}
/* STOP — 도는 동안 화면에서 제일 큰 것. 눌러야 멈춥니다.
   깜빡임을 밝기로 주면 버튼이 꺼져 보여서, 테두리에서 퍼지는 파동으로 줍니다 */
.gs-spin-stop{display:block; margin:0 auto; padding:9px 42px; border-radius:9px;
  font:800 27px/1 'IBM Plex Sans KR',system-ui,sans-serif; letter-spacing:.08em;
  color:var(--gold); background:rgba(var(--gold-rgb),.10);
  border:2px solid rgba(var(--gold-rgb),.7); cursor:pointer;
  animation:gs-stopblink 1.5s ease-out infinite}
.gs-spin-stop:hover{background:rgba(var(--gold-rgb),.2); animation:none}
.gs-spin-stop:active{transform:translateY(1px)}
.gs-spin-stop:focus-visible{outline:2px solid var(--gold); outline-offset:3px}
@keyframes gs-stopblink{
  0%{box-shadow:0 0 0 0 rgba(var(--gold-rgb),.45)}
  70%,100%{box-shadow:0 0 0 13px rgba(var(--gold-rgb),0)}}
@media (prefers-reduced-motion:reduce){
  .gs-wheel-free{animation-duration:900ms}
  .gs-spin-stop{animation:none; opacity:1}
}

/* 물리 룰렛 */
.gs-wheel{position:relative; width:380px; height:380px; margin:24px 0 18px}
.gs-wheel-disc{position:absolute; inset:0; border-radius:50%;
  transition-timing-function:cubic-bezier(.16,.9,.28,1);
  will-change:transform; backface-visibility:hidden;
  box-shadow:0 0 0 7px #3a2e25, 0 0 0 9px rgba(220,174,94,.75),
    0 10px 30px rgba(0,0,0,.55), inset 0 0 26px rgba(0,0,0,.28)}
/* 림 눈금 — 비율 1짜리 칸(12.857°)에 하나씩 맞는 금색 점 띠 */
.gs-wheel::before{content:""; position:absolute; inset:-15px; border-radius:50%;
  pointer-events:none;
  background:repeating-conic-gradient(rgba(220,174,94,.9) 0 1.1deg, transparent 1.1deg 12.857deg);
  -webkit-mask:radial-gradient(circle, transparent 0 199px, #000 199px 204px, transparent 204px);
          mask:radial-gradient(circle, transparent 0 199px, #000 199px 204px, transparent 204px)}
.gs-wheel-lab{position:absolute; inset:0; pointer-events:none}
/* 글자는 바큇살 방향 — 접선이 아니라 중심에서 바깥으로 읽힙니다 */
/* 글자 끝을 테두리 안쪽 12px에 못 박습니다 — 중심 거리로 놓으면 좁은 칸들이
   안쪽에서 겹칩니다. 바깥일수록 호가 길어서 같은 각도라도 여유가 생깁니다. */
.gs-wheel-lab i{position:absolute; right:50%; top:12px; font-style:normal;
  transform:rotate(-90deg); transform-origin:right center;
  font-family:'Gowun Batang',serif; font-size:18px; font-weight:800; color:#f4d98c;
  white-space:nowrap; max-width:130px; overflow:hidden; text-overflow:ellipsis;
  text-shadow:-1.5px 0 0 #241206, 1.5px 0 0 #241206, 0 -1.5px 0 #241206, 0 1.5px 0 #241206,
    -1px -1px 0 #241206, 1px -1px 0 #241206, -1px 1px 0 #241206, 1px 1px 0 #241206,
    0 2px 5px rgba(0,0,0,.45)}
.gs-wheel-lab.sp i{font-size:14px}
.gs-wheel-pin{position:absolute; left:50%; top:-15px; width:0; height:0;
  transform:translateX(-50%);
  border-left:15px solid transparent; border-right:15px solid transparent;
  border-top:30px solid #e8564a; filter:drop-shadow(0 2px 3px rgba(0,0,0,.5))}
/* 넘길 사람을 고를 때는 원판을 감춥니다 — 이미 끝난 판이라 볼 이유가 없습니다 */
.gs-spinwrap-pick .gs-spin-stage{display:none}
.gs-spinwrap-pick .gs-spin-out{height:auto}
.gs-spinwrap-pick .gs-spin-who{height:auto}

/* 돌아가는 모습 고르개 — 오버레이 테마 고르개와 같은 얼굴로 */
.gs-obs-spd{margin-top:12px}
.gs-slook{display:flex; gap:10px; margin-top:12px; flex-wrap:wrap}
.gs-slook-themes{flex-basis:100%; display:flex; gap:10px; flex-wrap:wrap;
  margin-top:2px}
.gs-slook-themes.off{opacity:.42}
.gs-slook-themes.off .gs-slook-c{cursor:default}
.gs-slook-c.sm{flex:1 1 130px; padding:9px 8px 8px}
.gs-slook-c.sm .gs-slook-art{height:46px}
.gs-slook-c.sm .gs-slook-disc{width:42px; height:42px}
.gs-slook-hint{flex-basis:100%; font-style:normal; font-size:11px; color:var(--ink-2);
  min-height:15px}
.gs-slook-c{flex:1 1 150px; display:flex; flex-direction:column; align-items:center;
  gap:5px; padding:12px 10px 10px; border:1px solid rgba(var(--ink-rgb),.25);
  border-radius:5px; background:rgba(var(--lift-rgb),.3); font:inherit;
  color:var(--ink-2); cursor:pointer}
.gs-slook-c:hover{border-color:var(--gold)}
.gs-slook-c.on{border-color:var(--gold); background:rgba(var(--gold-rgb),.12); color:var(--ink)}
.gs-slook-c b{font-size:12.5px; color:var(--ink)}
.gs-slook-c em{font-style:normal; font-size:11px; opacity:.8}
.gs-slook-art{display:grid; place-items:center; width:100%; height:58px}
.gs-slook-disc{width:52px; height:52px; border-radius:50%;
  border:2px solid rgba(var(--ink-rgb),.35)}
/* 숫자만 미리보기 — 실제 릴 창의 축소판. 이웃 값이 흐릿하게 스치는 모양 그대로 */
.gs-slook-reel{position:relative; width:58px; height:58px; border-radius:8px; overflow:hidden;
  display:flex; flex-direction:column; align-items:center; justify-content:center; gap:1px;
  background:linear-gradient(#151009, #241c14 30% 70%, #151009);
  border:1.5px solid #3a2e25; box-shadow:0 0 0 1px rgba(220,174,94,.7)}
.gs-slook-reel b{font-weight:800; line-height:1; font-family:'Gowun Batang',serif}
.gs-slook-reel-side{font-size:12px; color:#ece4d6; opacity:.25; filter:blur(.6px)}
.gs-slook-reel-mid{font-size:24px; color:#fff; text-shadow:0 0 8px rgba(220,174,94,.45)}
.gs-slook-reel-line{position:absolute; left:5px; right:5px; top:50%; height:24px;
  transform:translateY(-50%); pointer-events:none;
  border-top:1px solid rgba(220,174,94,.4); border-bottom:1px solid rgba(220,174,94,.4)}
/* 한 판 예시 — 눌러야 펼쳐집니다. 늘 떠 있으면 설정 줄이 멀어집니다 */
.gs-rc-ex{margin-top:10px}
.gs-rc-exbtn{border:1px dashed rgba(var(--ink-rgb),.35); border-radius:4px;
  background:transparent; font:inherit; font-size:11.5px; color:var(--ink-2);
  cursor:pointer; padding:5px 11px}
.gs-rc-exbtn:hover{border-color:var(--gold); color:var(--ink)}
.gs-rc-exlist{margin:9px 0 0; padding:11px 14px 11px 30px; border-radius:4px;
  background:rgba(var(--lift-rgb),.35); font-size:12px; color:var(--ink-body);
  line-height:1.85}
.gs-rc-exlist li{margin:0; padding-left:2px}
.gs-rc-exlist li::marker{color:var(--gold); font-weight:700}
.gs-rc-exfoot{margin:7px 2px 0; font-size:11.5px; color:var(--ink-2); line-height:1.7}
/* 면과 비율 — 왼쪽 미리보기 + 오른쪽 표 */
.gs-rc-body{display:flex; gap:16px; align-items:flex-start; margin-top:10px}
.gs-rc-left{flex:0 0 168px; display:flex; flex-direction:column; align-items:center; gap:9px}
.gs-rc-pv{position:relative; width:158px; height:158px}
.gs-rc-pvdisc{position:absolute; inset:0; border-radius:50%;
  box-shadow:0 0 0 3px #3a2e25, 0 0 0 4.5px rgba(220,174,94,.75),
    inset 0 0 12px rgba(0,0,0,.3)}
.gs-rc-pvlab{position:absolute; inset:0; pointer-events:none}
.gs-rc-pvlab i{position:absolute; right:50%; top:7px; font-style:normal;
  transform:rotate(-90deg); transform-origin:right center;
  font-family:'Gowun Batang',serif; font-size:10px; font-weight:800; color:#f4d98c;
  white-space:nowrap; max-width:56px; overflow:hidden; text-overflow:ellipsis;
  text-shadow:-1px 0 0 #241206, 1px 0 0 #241206, 0 -1px 0 #241206, 0 1px 0 #241206}
.gs-rc-pvhub{position:absolute; left:50%; top:50%; transform:translate(-50%,-50%);
  width:44px; height:44px; border-radius:50%; pointer-events:none;
  background:radial-gradient(circle at 34% 30%, #4a3c30, #241d17 70%);
  border:1.5px solid #dcae5e}
.gs-rc-pvnote{margin:0; font-size:10.5px; color:var(--ink-2); text-align:center;
  line-height:1.55}
.gs-rc-vegas{margin:0; font-size:11px; color:var(--gold); line-height:1.55;
  background:rgba(var(--gold-rgb),.08); border:1px dashed rgba(var(--gold-rgb),.4);
  border-radius:4px; padding:6px 9px}
.gs-rc-body .gs-rc{flex:1; min-width:0; margin-top:0}
.gs-rc-grip{width:18px; color:rgba(var(--ink-rgb),.35); cursor:grab; font-size:13px}
.gs-rc-plus{color:var(--gold); cursor:default}
.gs-rc-drag{outline:1.5px dashed var(--gold); outline-offset:-2px;
  background:rgba(var(--gold-rgb),.07)}
.gs-rc-dot{display:inline-block; width:11px; height:11px; border-radius:3px;
  margin-right:8px; vertical-align:-1px; box-shadow:inset 0 0 0 1px rgba(0,0,0,.3)}
.gs-rc-goldem{font-style:normal; font-size:11px; color:var(--ink-2); margin-left:7px}
.gs-rc-kind{font:inherit; font-size:12px; color:var(--ink);
  background:rgba(var(--ink-rgb),.06); border:1px solid rgba(var(--ink-rgb),.3);
  border-radius:4px; padding:3px 4px}
.gs-rc-ghost td{opacity:.9}
/* 묶음 이름 — 규칙과 꾸밈을 갈라 놓습니다 */
.gs-rc-sec{margin:18px 0 2px; font-size:12px; font-weight:700; color:var(--ink);
  letter-spacing:.02em; padding-bottom:5px;
  border-bottom:1px solid rgba(var(--ink-rgb),.16)}
.gs-rc-look{display:flex; gap:6px; align-items:center; flex-wrap:wrap; font-size:12px;
  color:var(--ink-2); margin-top:8px}
.gs-rc-look > span{min-width:74px}
.gs-rc-hint{font-style:normal; font-size:11.5px; opacity:.7; margin-left:2px}
.gs-rc-lookbtn{border:1px solid rgba(var(--ink-rgb),.28); border-radius:4px; background:transparent;
  font:inherit; font-size:12px; color:var(--ink-body); cursor:pointer; padding:4px 11px}
.gs-rc-lookbtn.on{border-color:var(--gold-ink); background:rgba(var(--gold-rgb),.14);
  color:var(--ink); font-weight:700}
/* 못 쓰는 줄도 자리는 지킵니다 — 어떤 설정이 있는지, 무엇과 한 세트인지 보이라고 */
.gs-rc-look.off{opacity:.42}
.gs-rc-lookbtn:disabled{cursor:default}
.gs-spin-face{font-size:48px; font-weight:800; line-height:1; color:var(--ink);
  font-family:'Gowun Batang',serif}
.gs-reel{position:relative; width:224px; height:224px; border-radius:12px; overflow:hidden;
  background:linear-gradient(#151009, #241c14 30% 70%, #151009);
  border:2px solid #3a2e25;
  box-shadow:0 0 0 1.5px rgba(220,174,94,.7), inset 0 0 26px rgba(0,0,0,.6);
  display:flex; flex-direction:column; align-items:center; justify-content:center; gap:6px}
.gs-reel-n{font-family:'Gowun Batang',serif; font-weight:800; line-height:1}
.gs-reel-n.side{font-size:30px; color:#ece4d6; opacity:.2; filter:blur(1.2px)}
.gs-reel-n.big{font-size:64px; color:#fff; max-width:94%; overflow:hidden;
  text-overflow:ellipsis; text-shadow:0 0 24px rgba(220,174,94,.4)}
.gs-reel-n.big.long{font-size:40px}
.gs-reel-n.big.longer{font-size:26px}
.gs-reel-n.side{max-width:90%; overflow:hidden; text-overflow:ellipsis}
.gs-reel-line{position:absolute; left:12px; right:12px; top:50%; height:60px;
  transform:translateY(-50%); pointer-events:none;
  border-top:1px solid rgba(220,174,94,.4); border-bottom:1px solid rgba(220,174,94,.4)}
.gs-reel-notch{position:absolute; top:50%; width:0; height:0; border:8px solid transparent}
.gs-reel-notch.l{left:0; transform:translateY(-50%); border-left:11px solid #dcae5e}
.gs-reel-notch.r{right:0; transform:translateY(-50%); border-right:11px solid #dcae5e}
.gs-spin-rolling{animation:gs-spinblur .07s linear; opacity:.55; filter:blur(.4px)}
.gs-spin-land{animation:gs-spinpop .3s cubic-bezier(.2,1.4,.4,1); color:#dcae5e}
@keyframes gs-spinblur{from{transform:translateY(-8px)} to{transform:translateY(0)}}
@keyframes gs-spinpop{from{transform:scale(.6)} to{transform:scale(1)}}
.gs-spin-mult{position:absolute; right:-4px; top:2px; font-size:22px; font-weight:800;
  color:var(--red)}
/* 중앙 허브 — 축은 늘 있고, 멈추면 값이 그 안에 뜹니다 */
.gs-wheel-hub{position:absolute; left:50%; top:50%; transform:translate(-50%,-50%);
  width:104px; height:104px; border-radius:50%; z-index:2; pointer-events:none;
  background:radial-gradient(circle at 34% 30%, #4a3c30, #241d17 70%);
  border:2.5px solid #dcae5e;
  box-shadow:0 3px 10px rgba(0,0,0,.5), inset 0 1px 2px rgba(255,255,255,.14);
  display:grid; place-items:center; overflow:hidden}
.gs-wheel-hubv{color:#fff; font-size:42px; font-weight:800; line-height:1;
  white-space:nowrap; animation:gs-hitpop .28s cubic-bezier(.2,1.5,.4,1)}
.gs-wheel-hubv.long{font-size:17px; max-width:92px; overflow:hidden; text-overflow:ellipsis}
.gs-wheel-hubq{color:#8a7a66; font-size:30px; font-weight:800; opacity:.4}
@keyframes gs-hitpop{from{transform:scale(.4); opacity:0} to{transform:scale(1); opacity:1}}
.gs-spin-trail{display:flex; gap:8px; align-items:center; justify-content:center;
  height:34px; overflow:hidden}
/* 칩과 슬롯은 너비가 같아야 합니다 — 다르면 넓은 칩이 채워질 때 뒷줄이 밀립니다 */
.gs-spin-tchip{width:52px; padding:3px 0; text-align:center; border-radius:99px;
  font-size:13px; font-weight:700; white-space:nowrap; overflow:hidden;
  flex:none; background:#241d18; border:1px solid rgba(220,174,94,.55); color:var(--sp-ink);
  animation:gs-chipin .22s cubic-bezier(.2,1.3,.4,1)}
.gs-spin-slot{width:52px; height:25px; border-radius:99px; flex:none;
  border:1px dashed rgba(220,174,94,.3)}
.gs-spin-slot.next{border-color:rgba(220,174,94,.8);
  animation:gs-slotpulse 1s ease-in-out infinite}
@keyframes gs-slotpulse{0%,100%{background:transparent}
  50%{background:rgba(220,174,94,.14)}}
.gs-spin-tchip.pass{color:#ff9d92; border-color:#a44f46}
.gs-spin-tchip.mult{color:#f7b458; border-color:#b97f37}
@keyframes gs-chipin{from{transform:scale(.6); opacity:0}}
/* 결과 두 줄이 들어갈 자리를 미리 비워 둡니다 (도는 동안엔 비어 있음) */
/* 결과 두 줄이 들어갈 자리를 미리 비워 둡니다 (도는 동안엔 비어 있음) */
.gs-spin-out{display:grid; gap:5px; height:98px; align-content:center; overflow:hidden}
/* STOP 의 파동은 칸 밖으로 퍼져야 합니다 — 잘리면 좌우가 각진 채로 끊깁니다 */
.gs-spin-out-free{overflow:visible}
/* 건너뛰기·닫기 — 자리를 고정해서 상태가 바뀌어도 판이 안 밀립니다 */
.gs-spin-act{min-height:30px; display:flex; align-items:center; justify-content:center}
.gs-spin-skipbtn{font:600 12.5px/1 'IBM Plex Sans KR',system-ui,sans-serif;
  padding:7px 16px; border-radius:5px; cursor:pointer; letter-spacing:.02em;
  color:var(--sp-ink2,#c9bda9); background:transparent;
  border:1px solid rgba(var(--gold-rgb),.32)}
.gs-spin-skipbtn:hover{border-color:rgba(var(--gold-rgb),.7); color:var(--gold)}
.gs-spin-skipbtn:focus-visible{outline:2px solid var(--gold); outline-offset:2px}
.gs-spin-delta{font-size:13.5px; color:var(--sp-ink2); min-height:19px}
.gs-spin-delta b{color:var(--sp-ink)}
.gs-spin-delta .up{color:#ff9d92; font-weight:700}
.gs-spin-delta .dn{color:#7fb8ff; font-weight:700}
.gs-spin-out > b{font-size:32px; color:var(--ink); letter-spacing:.01em}
.gs-spin-ask{font-size:14px; color:var(--ink-body); line-height:1.7}
.gs-spin-self{border:0; background:transparent; font:inherit; font-size:14px; color:var(--ink-2);
  cursor:pointer; text-decoration:underline; text-underline-offset:3px; padding:0}
.gs-spin-self:hover{color:var(--ink)}

/* 양도 대상 고르는 중 — 줄을 누를 수 있습니다 */
.gs-pickable{cursor:pointer}
.gs-pickable:hover{background:rgba(var(--gold-rgb),.14)}
.gs-pickself:hover{background:rgba(var(--ink-rgb),.08)}


/* 방송 화면 예시 — 실제 오버레이의 비율을 줄여 옮겼습니다 */
/* 방송 화면 예시 — 이 표가 곧 스위치입니다. 방송에 나가는 판이라 앱 테마와 무관하게
   늘 어두운 판으로 그립니다(테마를 따라가면 "이게 방송 화면"이라는 게 안 읽힙니다). */
.gs-ovprev{margin-top:12px; padding:9px 11px 11px; border-radius:6px; background:#241f1b;
  color:#f5f0e6; overflow-x:auto}
.gs-ovp{display:grid; align-items:center; position:relative; min-width:min(100%,300px)}
.gs-ovp-cell{padding:3px; font-size:15px; white-space:nowrap; text-align:center;
  font-variant-numeric:tabular-nums; position:relative; z-index:1}
.gs-ovp-rank{font-size:11px; opacity:.68}
/* 1위는 금색 순위에 굵은 이름 — 방송 판의 초점을 그대로 옮겨 왔습니다 */
.gs-ovp-rank.top{color:#e8c66a; opacity:1; font-weight:700}
.gs-ovp-nm.top{font-weight:700}
.gs-ovp-mv{font-size:9px; font-weight:700}
.gs-ovp-mv.up{color:#8fd89b}
.gs-ovp-mv.down{color:#e59a90}
/* 이름은 왼쪽 정렬 — 방송 판이 그렇습니다(벌금표와 반대라 헷갈리지 않게 여기서 맞춥니다) */
.gs-ovp-nm{text-align:left; padding-right:7px; overflow:hidden; text-overflow:ellipsis}
/* 제목도 방송 판과 같이 판 왼쪽 끝에서 시작합니다 */
.gs-ovp-title{text-align:left; font-size:13.5px; font-weight:700; padding-bottom:5px}
.gs-ovp-g{text-align:right; color:#e8c66a}
.gs-ovp-d{text-align:right; font-size:12px; font-weight:700}
.gs-ovp-d.pos{color:#6fb4ff}
.gs-ovp-d.neg{color:#ff7d6b}
.gs-ovp-h{font-size:10px; opacity:.55; padding-bottom:5px; letter-spacing:.02em;
  overflow:hidden; text-overflow:ellipsis}
.gs-ovp-h.gs-ovp-g{font-size:11.5px; opacity:.85}
.gs-ovp-h.gs-ovp-d{color:inherit; font-weight:400}
.gs-ovp-rule{height:1px; background:rgba(255,255,255,.14); margin-bottom:3px}
.gs-ovp-z{opacity:.18}
/* 슬라이드 모드 미리보기 (2026-09-06) — 눈은 값 칸 위에 이름과 함께 한 줄, 값은 오른쪽에서 들어옵니다 */
/* 슬라이드 미리보기는 가로로 안 굴립니다 — 값이 오른쪽에서 들어올 때 몇 px 넘쳐 스크롤바가 번쩍였다 (2026-09-06 사용자: 정신 사납다) */
.gs-ovprev-slide{overflow-x:hidden}
.gs-ovp-cyc{justify-content:flex-end; gap:5px; flex-wrap:wrap}
.gs-ovp-eyel{gap:4px; padding:2px 7px 2px 5px; line-height:1; font-size:10px}
.gs-ovp-eyel span{line-height:1}
.gs-ovp-slide .gs-ovp-c{text-align:right}
.gs-ovp-sl{animation:gs-ovp-sl .26s cubic-bezier(.2,.6,.3,1) both}
@keyframes gs-ovp-sl{from{transform:translateX(14px); opacity:0} to{transform:translateX(0); opacity:1}}
.gs-obs-note{margin:8px 0 0}
.gs-ovp-dim{opacity:.3}
/* 눈이 앉는 띠 — 열마다 하나씩, 못 끄는 자리에는 이유를 적어 둡니다 */
.gs-ovp-band{display:flex; align-items:center; justify-content:center; padding:1px 0 7px;
  position:relative; z-index:3; font-size:9.5px; letter-spacing:.02em; white-space:nowrap}
.gs-ovp-always{opacity:.32}
.gs-ovp-eye{display:inline-flex; align-items:center; justify-content:center; cursor:pointer;
  background:transparent; color:#f5f0e6; padding:3px 5px; border-radius:99px; line-height:0;
  border:1px solid rgba(255,255,255,.24); transition:background .14s, border-color .14s, color .14s}
.gs-ovp-eye:hover{background:rgba(255,255,255,.1); border-color:rgba(255,255,255,.55)}
.gs-ovp-eye.off{color:rgba(245,240,230,.4); border-color:rgba(255,255,255,.12)}
.gs-ovp-eye.off:hover{color:#f5f0e6}
/* 꺼진 열에 덮는 빗금 — 숫자가 비쳐 보여서 무엇이 빠지는지 계속 읽힙니다.
   눈에 올리기만 해도 그 열이 금색으로 밝아져, 누르기 전에 범위를 확인할 수 있어요. */
.gs-ovp-zone{pointer-events:none; z-index:2; border-radius:3px; align-self:stretch;
  opacity:0; transition:opacity .15s}
.gs-ovp-hi{opacity:1; background:rgba(232,198,106,.11);
  box-shadow:inset 0 0 0 1px rgba(232,198,106,.45)}
.gs-ovp-dead{opacity:1; box-shadow:inset 0 0 0 1px rgba(255,255,255,.2);
  background:repeating-linear-gradient(-45deg,
    rgba(255,255,255,.17) 0 3.5px, transparent 3.5px 8px)}
.gs-ovp-cap{font-size:11.5px; color:var(--ink-2); margin:10px 0 0; min-height:2.6em;
  line-height:1.65}
.gs-ovp-cap b{color:var(--ink-body)}
.gs-fx-hint{margin-top:9px}
/* 클릭 알림 예시 — 방송 판 위에 카드가 얹히는 모습 그대로 */
.gs-fxprev{position:relative; margin:10px 0 12px; padding:12px 14px; border-radius:6px;
  background:#241f1b; color:#f5f0e6; overflow:hidden}
.gs-fxprev-bg{display:flex; flex-direction:column; gap:7px; font-size:14px; opacity:.5;
  transition:opacity .18s}
/* 끄면 가릴 카드가 없으니 판을 흐릴 이유도 없습니다 */
.gs-fxprev.off .gs-fxprev-bg{opacity:.88}
.gs-fxprev-card{position:absolute; left:50%; top:50%; transform:translate(-50%,-50%);
  text-align:center; padding:10px 22px; border-radius:5px; background:#1b1611;
  border:1px solid rgba(220,174,94,.55)}
.gs-fxprev-card b{display:block; font-size:17px; font-weight:700; line-height:1.15}
.gs-fxprev-card span{display:block; margin-top:3px; font-size:12px; opacity:.92}
.gs-fxprev-card em{font-style:normal; font-weight:700; color:#8fd89b}
/* Enter 가 누르는 버튼임을 알리는 작은 글쇠 표시 */
.gs-pm-key{display:inline-block; margin-left:7px; font-style:normal; font-size:10px;
  letter-spacing:.04em; padding:1px 5px; border-radius:3px; vertical-align:middle;
  border:1px solid currentColor; opacity:.6}
@media (prefers-reduced-motion:reduce){ .gs-ovp-zone,.gs-ovp-eye{transition:none} }

/* 알림 한 줄 — 화면 아래에 잠깐 떴다 사라집니다. 누를 것이 없어 조작을 안 막습니다 */
/* 토스트 안에서 누를 수 있는 말 — 토스트는 클릭을 안 받게 두고(밑의 표를 가리면
   안 되니까) 이 조각만 되살립니다 */
/* (폐기 2026-09-06 낮, 몇 시간 만에) 걸음 중 토스트를 오른쪽 위로 옮기던 .gs-toast-coach — 사용자: 튜토리얼 하나 때문에 앱 동작을 바꾸는 건 주객전도, 앞으로도 지양.
   대신 말풍선이 토스트 자리에 안 앉게 걸음 스크롤이 화면 아래 110px 을 비워 둡니다 (CoachMark) */
.gs-toast-link{font:inherit; color:var(--gold); background:transparent; border:0;
  padding:0; cursor:pointer; pointer-events:auto; text-decoration:underline;
  text-underline-offset:3px; text-decoration-thickness:1px}
.gs-toast-link:hover{text-decoration-thickness:2px}
/* 파티원 화면의 알림 — 방송과 같은 카드, 자리만 구석으로. 읽는 화면이라 한가운데를
   가리면 안 되고, 같은 사건에 두 가지 말투를 쓰면 나중에 "내가 누른 게 갔나"를
   확인할 때 어느 쪽이 진짜인지 헷갈립니다. */
.gs-fxcard{position:fixed; right:18px; bottom:18px; z-index:44; pointer-events:none;
  padding:9px 15px; border-radius:5px; background:var(--paper-2);
  border:1px solid rgba(var(--gold-rgb),.5);
  box-shadow:0 6px 20px rgba(var(--shadow-rgb),.45); animation:gs-fxin .18s ease-out}
.gs-fxcard b{display:block; font-size:15px; font-weight:700; color:var(--ink)}
.gs-fxcard span{display:block; margin-top:2px; font-size:12px; color:var(--ink-2)}
.gs-fxcard em{font-style:normal; font-weight:700}
.gs-fxcard.up em{color:var(--red)}
.gs-fxcard.dn em{color:var(--blue)}
.gs-fxcard.roul{border-color:var(--gold)}
.gs-fxcard.roul b::before{content:'\u25ce '; color:var(--gold)}
@keyframes gs-fxin{from{opacity:0; transform:translateY(6px)} to{opacity:1; transform:none}}
@media (prefers-reduced-motion:reduce){ .gs-fxcard{animation:none} }
/* 방금 누른 것 — 장부 결로. 줄 사이는 점선, 숫자는 고정폭.
   취소는 올린 줄에만 나타나서 평소에는 읽기만 하는 카드입니다. */
.gs-press{position:fixed; right:18px; bottom:18px; z-index:45; width:360px;
  background:var(--paper-2); border:1px solid var(--kraft-dk); border-radius:4px;
  box-shadow:0 10px 30px rgba(var(--shadow-rgb),.45); overflow:hidden;
  animation:gs-press-in .16s ease-out}
/* 남은 시간 — 묶음 전체에 하나뿐인 시계입니다 */
.gs-press-track{height:2px; background:rgba(var(--ink-rgb),.09)}
.gs-press-bar{display:block; height:2px; background:rgba(var(--gold-rgb),.85);
  transform-origin:left; animation:gs-press-run linear forwards}
@keyframes gs-press-run{from{transform:scaleX(1)} to{transform:scaleX(0)}}
.gs-press:hover .gs-press-bar{animation-play-state:paused}
.gs-press-head{padding:9px 14px 8px; font-size:13px; color:var(--ink-2);
  border-bottom:1px solid rgba(var(--ink-rgb),.1)}
.gs-press-head{display:flex; align-items:baseline; gap:5px}
.gs-press-head b{color:var(--ink); font-weight:600; font-family:var(--mono); font-size:13.5px}
.gs-press-rows{list-style:none; margin:0; padding:0}
.gs-press-rows li{display:flex; align-items:center; gap:9px; padding:9px 14px 9px 11px; min-height:38px;
  border-left:3px solid var(--red)} /* 색 띠 — 늘면 붉게, 정정은 푸르게 (2026-09-07 사용자) */
.gs-press-rows li.dn{border-left-color:var(--blue)}
.gs-press-rows li + li{border-top:1px dotted rgba(var(--ink-rgb),.13)}
.gs-press-rows b{font-family:'Gowun Batang',serif; font-weight:700; font-size:16px; color:var(--ink)}
.gs-press-rows i{font-style:normal; font-size:14.5px; color:var(--ink-body)}
/* 왼쪽 눈금 — 자릿수가 늘어도 이름이 안 밀리게 폭을 잡아 둡니다 */
.gs-press-ago{flex:none; min-width:52px; text-align:right; font-family:var(--mono);
  font-size:12px; color:var(--ink-2); opacity:.8; white-space:nowrap}
.gs-press-rows u{text-decoration:none; margin-left:auto; font-family:var(--mono);
  font-size:15px; color:var(--red)}
.gs-press-rows u.dn{color:var(--blue)}
.gs-press-x{width:24px; height:24px; flex:none; display:grid; place-items:center; padding:0;
  border:1px solid transparent; background:transparent; color:var(--ink-2); font:inherit;
  font-size:12px; border-radius:3px; cursor:pointer; opacity:0}
.gs-press-rows li:hover .gs-press-x,.gs-press-x:focus-visible{opacity:1;
  border-color:rgba(var(--ink-rgb),.28)}
.gs-press-x:hover{color:var(--ink); background:rgba(var(--ink-rgb),.1)}
@keyframes gs-press-in{from{opacity:0; transform:translateY(6px)} to{opacity:1; transform:none}}
@media (prefers-reduced-motion:reduce){
  .gs-press{animation:none}
  .gs-press-bar{animation:none; transform:scaleX(1)}
}
.gs-toast{position:fixed; left:50%; bottom:max(18px,4vh); transform:translateX(-50%);
  z-index:70; max-width:min(560px,92vw); padding:12px 18px; border-radius:6px;
  background:var(--paper,#2a2320); color:var(--ink); font-size:13.5px; line-height:1.65;
  border:1px solid rgba(var(--gold-rgb),.6); box-shadow:0 8px 26px rgba(0,0,0,.45);
  pointer-events:none; text-align:center;
  animation:gs-toast-in .22s ease-out, gs-toast-out .4s ease-in 3.2s forwards}
@keyframes gs-toast-in{from{opacity:0; transform:translate(-50%,10px)}
  to{opacity:1; transform:translate(-50%,0)}}
@keyframes gs-toast-out{to{opacity:0; transform:translate(-50%,-6px)}}

/* 알림이 뜨는 동안 기록 버튼이 눈에 띄게 — 어디로 가야 하는지 가리킵니다 */
.gs-logbtn-blink{animation:gs-logblink 1s ease-in-out 3}
@keyframes gs-logblink{
  0%,100%{box-shadow:0 0 0 0 rgba(var(--gold-rgb),0)}
  50%{box-shadow:0 0 0 4px rgba(var(--gold-rgb),.55); border-color:var(--gold-ink)}
}

.gs-coltype{display:grid; gap:10px; margin-top:4px}
.gs-coltype-pick{display:block; width:100%; text-align:left; padding:13px 15px; cursor:pointer;
  border:1px solid rgba(var(--ink-rgb),.22); border-radius:5px; background:transparent; font:inherit}
.gs-coltype-pick:hover{border-color:var(--gold-ink); background:rgba(var(--gold-rgb),.07)}
.gs-coltype-pick b{display:block; font-size:15px; color:var(--ink); margin-bottom:4px}
.gs-coltype-pick span{display:block; font-size:12.5px; line-height:1.75; color:var(--ink-body)}

.gs-rc{width:100%; border-collapse:collapse; margin:12px 0}
.gs-rc th{font-size:11.5px; color:var(--ink-2); font-weight:400; text-align:right; padding:0 8px 6px}
.gs-rc th.gs-l{text-align:left}
.gs-rc td{padding:6px 8px; text-align:right; border-top:1px dotted rgba(var(--ink-rgb),.18)}
.gs-rc td.gs-l{text-align:left}
.gs-rc-face{font-size:17px; font-weight:700; color:var(--ink); white-space:nowrap}
.gs-rc-sp .gs-rc-face{color:var(--gold-ink); font-size:15px}
/* 그냥 숫자처럼 보여서 고칠 수 있는 줄 몰랐습니다 — 칸처럼 보이게 합니다 */
.gs-rc-w{width:58px; text-align:center; font-size:15px; font-weight:700;
  border:1px solid rgba(var(--ink-rgb),.35) !important; border-radius:4px;
  background:rgba(var(--ink-rgb),.06); padding:5px 4px}
.gs-rc-w:focus{border-color:var(--gold-ink) !important; background:rgba(var(--gold-rgb),.1)}
.gs-rc-pct{font-size:12px; color:var(--ink-2); width:64px}
.gs-rc-onoff{border:1px solid rgba(var(--ink-rgb),.3); border-radius:99px; background:transparent;
  font:inherit; font-size:11.5px; color:var(--ink-2); cursor:pointer; padding:3px 11px}
.gs-rc-onoff.on{border-color:var(--gold-ink); background:rgba(var(--gold-rgb),.14);
  color:var(--ink); font-weight:700}
.gs-rc-del{border:0; background:transparent; font:inherit; font-size:15px; color:var(--ink-2);
  cursor:pointer; padding:0 2px; line-height:1}
.gs-rc-del:hover{color:var(--red)}
.gs-rc-new{width:52px; text-align:center; font-size:14px;
  border:1px solid rgba(var(--ink-rgb),.35) !important; border-radius:4px;
  background:rgba(var(--ink-rgb),.06); padding:4px}
.gs-rc-addbtn{border:1px solid rgba(var(--ink-rgb),.3); border-radius:4px; background:transparent;
  font:inherit; font-size:12px; color:var(--ink-body); cursor:pointer; padding:4px 9px;
  font-variant-numeric:tabular-nums; min-width:62px}
.gs-rc-addbtn:hover:not(:disabled){border-color:var(--gold-ink); color:var(--ink)}
.gs-rc-addbtn:disabled{opacity:.4; cursor:default}
.gs-rc-note{margin:10px 0 0; font-size:12.5px; line-height:1.8; color:var(--ink-body)}
.gs-rc-reset{margin-top:12px; border:0; background:transparent; font:inherit; font-size:12px;
  color:var(--ink-2); cursor:pointer; text-decoration:underline; text-underline-offset:3px; padding:2px 0}
.gs-rc-reset:hover{color:var(--ink)}
.gs-note{margin:14px 0 0; font-size:12px; line-height:1.85; color:var(--ink-body); max-width:74ch}
.gs-note b{font-weight:600; color:var(--ink)}
/* 접히는 문답 */
/* 총무 질문 — 펼치는 대신 팝업을 여는 글줄 버튼 */
.gs-ask-open{margin:14px 0 0; border:none; border-left:2px solid var(--red); padding:2px 0 2px 11px;
  background:none; font:inherit; font-size:12.5px; color:var(--red); cursor:pointer;
  display:flex; align-items:baseline; gap:6px}
.gs-ask-open::before{content:'＋'; font-size:11px; opacity:.8}
.gs-ask-open:hover{text-decoration:underline}
.gs-vs{border-collapse:collapse; margin-top:12px; font-size:12px; color:var(--red)}
.gs-vs th{text-align:left; font-weight:500; padding:4px 16px 4px 0; white-space:nowrap}
.gs-vs td{padding:4px 16px 4px 0; font-family:var(--mono); white-space:nowrap}
.gs-vs-fee{font-size:13px}
.gs-vs tr:first-child{opacity:.72}

@media (prefers-reduced-motion:reduce){ .gs-env{animation:none} }

/* ================= 계정·로비 =================
   방송 가독성이 기준입니다 — 핵심 글자는 크게, 세로는 아낍니다. */

/* 파티원 배너 묶음 — 표 위, 본문과 같은 열 */
.gs-guestbar{max-width:1080px; margin:0 auto}
.gs-guestbar .gs-slip{margin-bottom:10px}
.gs-slip-calm{border-left-color:var(--gold); background:rgba(var(--gold-rgb),.08)}
.gs-slip-calm .gs-slip-msg,.gs-slip-green .gs-slip-msg{color:var(--ink-body)}
.gs-slip-green{border-left-color:#6fbf73; background:rgba(111,191,115,.1)}
.gs-slip-act{margin-left:auto}
.gs-slip-urlbox{flex:1; min-width:220px; display:flex; flex-direction:column; gap:3px}
.gs-urltext{font-family:var(--mono); font-size:12.5px; color:var(--ink-body);
  word-break:break-all; letter-spacing:.02em}

/* 판 기록 창 — 목록은 보기·삭제만 */
.gs-gens-lead{margin:0 0 4px; font-size:11.5px; line-height:1.75; color:var(--ink-2)}

/* 파티원 화면 — 내 줄만 금색, 나머지는 한 톤 물러납니다 */
.gs-myrow .gs-in-name{color:var(--gold); font-weight:700}
.gs-hit-mine{border-style:solid; border-color:var(--gold);
  box-shadow:0 0 0 1px rgba(var(--gold-rgb),.35); cursor:pointer}
.gs-hit-mine .gs-hit-ghost{color:var(--gold)}
.gs-hit-mine:hover{background:rgba(var(--gold-rgb),.12); border-color:var(--gold)}
.gs-hit-far{opacity:.55; cursor:default}
.gs-hit-far:hover{background:var(--cell); border-color:rgba(var(--kraftdk-rgb),.85)}
.gs-hit-far:active{transform:none}

/* ── 로비(홈) — 판이 없을 때의 화면이고 헤더 아래를 통째로 덮습니다. 바탕부터
      벌금표와 갈라 두어야 "지금 무슨 화면인가"를 글자로 안 읽어도 압니다 ── */
/* 위 여백 25px — 로비 [시작]과 판 [정산 끝내기]가 화면 전환에도 같은 y 에 서는 값 (2026-09-05) */
.gs-lobbyscr{margin:-20px -20px 0; padding:25px 20px 28px; min-height:calc(100vh - 104px);
  background:radial-gradient(120% 70% at 50% 0%, rgba(var(--gold-rgb),.09), transparent 62%)}
/* 머리 한 줄 — 왼쪽이 이 화면에서 일어나는 일, 오른쪽 끝이 [시작]입니다 (§3.1·§9-1).
   폭은 판 화면과 같은 무대라, [시작]과 [정산 끝내기]·[중단]이 같은 모서리에 섭니다 */
/* 로비 머리줄 — 판 화면의 탭 줄과 같은 해부입니다 (2026-09-05): 바닥에 같은 경계선,
   우상단 수명 동사([시작])는 mastverbs 한 벌로 [정산 끝내기]와 같은 몸·같은 들림 */
.gs-lbtop{max-width:var(--stage); margin:0 auto; display:flex; align-items:flex-end;
  gap:14px; min-height:41px; position:relative}
.gs-lbtop::after{content:''; position:absolute; left:0; right:0; bottom:0; height:1px;
  background:var(--kraft-dk)}
/* 히어로 (§3.1) — 여기가 어디인지 위에, 무엇을 시작하는지 아래에.
   제목은 작고 조용하게, 판 이름이 이 화면에서 가장 큰 글자입니다 */
.gs-lbhero{flex:1 1 auto; min-width:0; display:flex; flex-direction:column; gap:1px;
  padding-bottom:6px}
.gs-lbhero-h{margin:0; font-size:11px; letter-spacing:.12em; font-weight:600;
  color:var(--ink-2); text-transform:none}
/* 판 이름 — 눌러서 고칩니다. 칸처럼 안 보이다가 마우스를 올리면 고칠 수 있다는 것이
   드러납니다: 늘 테두리가 있으면 로비에 입력칸이 둘(이름·명단)이 되어 시끄럽습니다 */
.gs-lbhero-name{font:inherit; font-family:'Gowun Batang',serif; font-weight:700; font-size:21px;
  color:var(--ink); background:transparent; border:1px solid transparent; border-radius:6px;
  padding:2px 7px; margin-left:-8px; width:100%; max-width:19em; text-overflow:ellipsis}
.gs-lbhero-name::placeholder{color:rgba(var(--ink-rgb),.35); font-weight:400}
.gs-lbhero-namewrap{display:flex; align-items:center; gap:2px; min-width:0}
/* 읽기 얼굴 — 글자 + 연필이 한 몸입니다. 누르면 입력칸으로 바뀝니다 (표준 문법) */
.gs-lbhero-nameview{display:inline-flex; align-items:center; gap:8px; border:0;
  background:none; cursor:pointer; font:inherit; color:var(--ink); padding:2px 0;
  margin-left:0; min-width:0; max-width:100%; text-align:left}
.gs-lbhero-nameview b{font-family:'Gowun Batang',serif; font-weight:700; font-size:21px;
  overflow:hidden; text-overflow:ellipsis; white-space:nowrap}
.gs-lbhero-nameview svg{flex:none; color:var(--ink-2)}
.gs-lbhero-nameview:hover svg{color:var(--ink)}
.gs-lbhero-name:hover{border-color:rgba(var(--ink-rgb),.22)}
.gs-lbhero-name:focus{outline:0; border-color:var(--gold); background:rgba(var(--ink-rgb),.05)}
/* 2열 벤토 (§3.1). 왼쪽이 명단·항목, 오른쪽이 모으기입니다 — 첫 할 일이 읽기
   시작점에 있어야 합니다. 왼쪽을 조금 넓게 두어 이름 줄이 먼저 접히지 않게 합니다 */
.gs-bento{display:grid; grid-template-columns:minmax(0,1.18fr) minmax(0,1fr); gap:15px;
  align-items:start; max-width:var(--stage); margin:14px auto 0}
.gs-bento-l{display:flex; flex-direction:column; gap:15px; min-width:0}
.gs-lbcard{border:1px solid rgba(var(--ink-rgb),.2); border-radius:9px; background:var(--paper);
  padding:14px 15px 16px; box-shadow:0 6px 18px rgba(var(--shadow-rgb),.16)}
.gs-lbcard-h{margin:0 0 10px; font-size:12px; letter-spacing:.1em; color:var(--ink-2);
  font-weight:600; display:flex; align-items:center; gap:8px}
.gs-lbcnt{margin-left:auto; font-family:var(--mono); font-size:13px; color:var(--gold)}
.gs-lb-none{margin:0; font-size:12px; color:var(--ink-2); line-height:1.75;
  padding:10px 4px; text-align:center}
.gs-lb-note{margin:10px 0 0; font-size:11.5px; color:var(--ink-2); line-height:1.7}
.gs-lb-note b{color:var(--ink-body); font-weight:600}
/* 모으기 열 — 섹션 셋이 같은 리듬으로 섭니다. 이 순서가 곧 파티 서랍의 순서입니다 */
.gs-lbsec{margin-bottom:16px}
.gs-lbsec:last-child{margin-bottom:0}
/* 섹션 사이 구분선 (2026-09-05) — 비어 있을 때는 머리글만으로 어디까지가 한 덩어리인지
   안 보였습니다. 첫 섹션 위에는 선을 안 긋습니다 — 카드 머리가 그 역할을 합니다 */
.gs-lbsec + .gs-lbsec{border-top:1px solid rgba(var(--ink-rgb),.14); padding-top:14px}
.gs-lbsec-h{margin:0 0 8px; font-size:11px; letter-spacing:.1em; color:var(--ink-2);
  font-weight:400; display:flex; align-items:center; gap:7px}
.gs-lbsec-h .gs-lbcnt{margin-left:0; font-size:12px}
/* 비로그인 권유 — 조용한 한 장입니다. 파는 것은 기능이 아니라 명단의 빈 자리입니다 */
/* 비로그인 파티 판 — 빈 상태 판의 문법 (2026-09-05): 가운데 정렬, 큰 문 하나 */
.gs-lbjoin{display:flex; flex-direction:column; align-items:center; text-align:center;
  padding:20px 8px 8px; color:var(--ink-2)}
.gs-lbjoin > svg{opacity:.5}
.gs-lbjoin-h{margin:11px 0 0; font-family:'Gowun Batang',serif; font-size:16.5px;
  font-weight:700; color:var(--ink)}
.gs-lbjoin .gs-lbask-gains{display:inline-block; text-align:left; margin:12px auto 0}
.gs-lbjoin-go{margin-top:16px; min-width:200px; padding:10px 20px; font-size:13.5px}
.gs-lbjoin-more{margin:12px 0 0; font-size:12px}
.gs-lbask-gains{list-style:none; margin:10px 0 0; padding:0}
.gs-lbask-gains li{font-size:12px; color:var(--ink-body); line-height:1.8; padding-left:14px; position:relative}
.gs-lbask-gains li::before{content:"·"; position:absolute; left:3px; color:var(--gold)}
.gs-lbask-p{margin:2px 0 0; font-size:12.5px; color:var(--ink-body); line-height:1.85}
.gs-lbask-a{display:flex; margin-top:13px}
.gs-lbask-a .gs-btn{margin-left:auto}
/* 신청 한 줄 — 금테로 갈라 눈이 먼저 가게 (§3.1). 로비와 파티 서랍이 같은 모양입니다 */
.gs-lbreq{display:flex; align-items:center; gap:9px; padding:9px 11px; border-radius:7px;
  margin-bottom:6px; background:rgba(var(--gold-rgb),.07);
  border:1px solid rgba(var(--gold-rgb),.42)}
.gs-lbreq:last-child{margin-bottom:0}
.gs-lbreq > b{font-family:'Gowun Batang',serif; font-size:16px; font-weight:700}
.gs-lbreq-id{font-family:var(--mono); font-size:11px; color:var(--ink-2)}
/* 내려앉은 까닭 한 줄 — 금색이라 "고칠 것이 있다"가 읽힙니다 (§3.3) */
.gs-lbreq-why{font-size:11.5px; color:var(--gold); flex:0 1 auto; min-width:0}
.gs-lbreq-r{margin-left:auto; display:flex; align-items:center; gap:9px; flex:none}
/* 주소는 제 줄을 쓰고, 남은 시간과 버튼이 아랫줄에서 오른쪽 끝으로 몰립니다 (§9-1) —
   한 줄에 다 세우면 폭이 다른 버튼이 들쭉날쭉 접힙니다 */
.gs-lbinv{display:flex; align-items:center; justify-content:flex-end; gap:9px 10px; flex-wrap:wrap}
.gs-lbinv-u{flex:1 1 100%; min-width:0; font-family:var(--mono); font-size:12.5px;
  color:var(--ink-2); overflow:hidden; white-space:nowrap; text-overflow:ellipsis}
.gs-lbinv-left{margin-right:auto; font-size:11.5px; color:var(--ink-2); white-space:nowrap}
/* 정원은 자주 만지는 것이 아니라 링크 줄 밑에 작게 (§3.1) */
.gs-lbcap{display:flex; align-items:center; gap:8px; margin-top:10px;
  font-size:11.5px; color:var(--ink-2)}
.gs-lb-capctl{display:inline-flex; align-items:center; gap:5px}
.gs-lb-capctl button{font:inherit; font-size:12px; width:20px; height:20px; line-height:1;
  border:1px solid rgba(var(--ink-rgb),.3); background:transparent; color:var(--ink-2);
  border-radius:3px; cursor:pointer; display:grid; place-items:center}
.gs-lb-capctl button:hover:not(:disabled){color:var(--ink); border-color:var(--kraft-dk)}
.gs-lb-capctl button:disabled{opacity:.3; cursor:default}
.gs-lbcapn{font-family:var(--mono); font-size:12.5px; color:var(--ink-body);
  min-width:4ch; text-align:center}
.gs-lb-tag{font-size:10px; letter-spacing:.08em; padding:2px 6px; border-radius:99px;
  background:var(--chip-bg); color:var(--chip-fg); flex:none}
.gs-lb-dot{width:7px; height:7px; border-radius:50%; background:#6fbf73; flex:none}
.gs-lb-dot.none{background:rgba(var(--ink-rgb),.3)}
/* 명단 — 번호 + 인라인 입력(벌금표 이름 글꼴). 줄은 치는 만큼 생깁니다 (§3.1) */
.gs-lbroster-n{margin-left:auto; font-family:var(--mono); font-size:12.5px; color:var(--gold)}
.gs-lbrows{display:flex; flex-direction:column}
.gs-lbrow{display:flex; align-items:center; gap:11px; padding:7px 4px;
  border-bottom:1px dotted rgba(var(--ink-rgb),.22); border-radius:4px}
.gs-lbrow:last-child{border-bottom:0}
.gs-lbrow:focus-within{background:rgba(var(--ink-rgb),.05)}
.gs-lbrow-n{width:15px; flex:none; text-align:right; font-family:var(--mono); font-size:12px;
  color:rgba(var(--ink-rgb),.35)}
.gs-lbrow-in{flex:0 1 8.5em; min-width:3em; border:0; background:transparent; color:var(--ink);
  font-family:'Gowun Batang',serif; font-weight:700; font-size:17px; padding:2px 0}
.gs-lbrow-in::placeholder{color:rgba(var(--ink-rgb),.3); font-weight:400}
/* 이름 칸은 내용만큼만 — 아이디가 닉 바로 옆에 붙게. field-sizing 이 없는 브라우저는
   위의 고정폭으로 물러납니다 */
@supports (field-sizing: content){
  .gs-lbrow-in{field-sizing:content; flex:0 1 auto; width:auto; min-width:2.5em; max-width:13em}
}
.gs-lbrow-in:focus{outline:0}
/* 계정이 붙은 자리는 이름 옆에 파란 아이디 — 자리의 참고 정보입니다 (§3.2) */
/* 가린 아이디 — 10.5px 는 점인지 글자인지도 안 보였습니다. 확인용 표식이라 읽히는
   크기여야 하고, 전체는 title 로 봅니다 */
.gs-lbrow-id{font-family:var(--mono); font-size:12.5px; color:var(--blue); flex:none;
  letter-spacing:.04em}
.gs-lbrow{cursor:text}
.gs-lbrow-in,.gs-lbrow-id,.gs-lbslot-x{cursor:auto}
.gs-lbslot-x{border:0; background:transparent; cursor:pointer; flex:none; margin-left:auto;
  color:rgba(var(--ink-rgb),.34); font-size:15px; line-height:1; padding:2px 5px; border-radius:4px}
.gs-lbslot-x:hover{color:var(--red); background:rgba(var(--red-rgb),.1)}
/* 방금 앉은 줄 — 초대·신청으로 사람이 들어온 자리가 잠깐 밝아집니다 (§3.1).
   명단이 어떻게 차는지가 눈에 보여야 합니다 */
.gs-lbrow.sat{animation:gs-satflash 1.6s ease-out}
@keyframes gs-satflash{0%{background:rgba(var(--gold-rgb),.3)}
  70%{background:rgba(var(--gold-rgb),.12)} 100%{background:transparent}}
@media (prefers-reduced-motion:reduce){ .gs-lbrow.sat{animation:none;
  background:rgba(var(--gold-rgb),.12)} }
/* 명단 발치 — 왼쪽이 무엇을 하면 되는지, 오른쪽 끝이 채우는 문입니다 (§9-1) */
.gs-lbrosterfoot{display:flex; align-items:center; gap:12px; margin-top:11px;
  padding-top:10px; border-top:1px dotted rgba(var(--ink-rgb),.22)}
.gs-lbrosterhint{margin:0; flex:1 1 auto; min-width:0; font-size:11.5px; line-height:1.7;
  color:var(--ink-2)}
.gs-lbfill{margin-left:auto}
.gs-lbrosterhint + .gs-lbfill{margin-left:0}
/* 이 화면에서 할 일은 하나입니다 — 무대 우상단 모서리의 채운 금색 하나 (§3.1).
   크기는 .gs-lifebtn 한 벌이 정합니다 — 판의 [정산 끝내기]와 같은 룩이라야
   같은 모서리를 나눠 쓰는 것으로 읽힙니다 (§3.4) */
/* 글자는 종이색 — 밝은 테마의 금색은 어두워서, 검정 글자를 얹으면 죽습니다 (2026-09-05) */
.gs-lbstart{flex:none; margin-left:auto; background:var(--gold); border-color:var(--gold);
  color:var(--paper)}
.gs-lbstart:hover:not(:disabled){background:var(--gold); filter:brightness(1.07)}
.gs-lbstart:disabled:hover{background:var(--gold)}
.gs-lbcoledit{display:flex; flex-direction:column; gap:6px}
.gs-lbcolrow{display:flex; align-items:center; gap:8px}
.gs-lbcolrow .gs-in-col{flex:0 1 9em; min-width:4em; font-size:12.5px; text-align:left;
  padding-left:2px}
.gs-lbcolprice{display:inline-flex; align-items:center; gap:5px; font-size:11.5px;
  color:var(--ink-2); flex:none}
/* 만드는 문 둘은 발치 오른쪽 끝에 나란히 (§9-3) */
.gs-lbcolfoot{display:flex; align-items:center; justify-content:flex-end; gap:14px; margin-top:8px}
.gs-lbpreset{margin-left:auto}
/* 중단된 판 카드 — 벤토 위입니다. 잃은 것이 없다는 것을 수와 총액이 말합니다 */
.gs-lbresume{max-width:var(--stage); margin:14px auto 0; display:flex; align-items:center; gap:12px;
  padding:12px 15px; border-radius:9px; border:1px solid rgba(var(--gold-rgb),.5);
  background:rgba(var(--gold-rgb),.09); flex-wrap:wrap}
.gs-lbresume-l{flex:1 1 auto; min-width:0; font-size:13px; color:var(--ink-body)}
.gs-lbresume-meta{margin-left:9px; font-size:12px; color:var(--ink-2)}
.gs-lbresume .gs-btn{margin-left:auto}
/* 판 기록 — 히어로의 아이콘 하나입니다 (§3.1). 개수가 옆에 붙고, 누르면 목록이
   창으로 뜹니다. 지난 판은 가끔 들추는 것이라 로비의 줄을 먹지 않습니다 */
/* 초대장 (§5.3, 2026-09-05) — 코드 붙은 링크로 온 비로그인의 첫 화면 */
.gs-invitesec{display:flex; justify-content:center}
.gs-invite{width:420px; max-width:100%; text-align:center; padding:26px 24px 22px}
.gs-invite > svg{color:var(--gold)}
.gs-invite-h{margin:12px 0 0; font-family:'Gowun Batang',serif; font-size:19px; font-weight:700}
.gs-invite-sub{margin:8px 0 0; font-size:12.5px; color:var(--ink-body)}
.gs-invite-names{margin:6px 0 0; font-family:'Gowun Batang',serif; font-weight:700; font-size:13.5px}
.gs-invite .gs-invite-go{display:block; width:100%; margin:18px 0 0; padding:12px 14px; font-size:14px}
.gs-invite-note{margin:12px 0 0; font-size:11.5px; color:var(--ink-2)}
/* ── 로비 — 나 | 파티 두 기둥 (§3.0, 2026-09-05) ── */
.gs-lobbyhome{max-width:var(--stage); margin:18px auto 0; display:grid;
  grid-template-columns:minmax(0,1fr) minmax(0,1fr); gap:15px; align-items:start}
.gs-lobbyhome-col{display:flex; flex-direction:column; gap:15px; min-width:0}
.gs-lobbyhome .gs-card{margin:0; width:100%}
.gs-lh-acct{display:flex; align-items:center; gap:10px}
.gs-lh-nick{font-family:'Gowun Batang',serif; font-size:18px; font-weight:700}
.gs-lh-set{margin-left:auto}
.gs-lh-addr{display:flex; align-items:center; gap:9px; margin-top:14px; flex-wrap:nowrap}
.gs-lh-url{font-family:var(--mono); font-size:12.5px; letter-spacing:.06em; color:var(--ink-body);
  overflow:hidden; text-overflow:ellipsis; white-space:nowrap; min-width:0; flex:1 1 auto}
.gs-lh-login{margin:0}
.gs-lh-rule{border:0; border-top:1px solid rgba(var(--ink-rgb),.14); margin:16px 0 14px}
.gs-lh-live{font-size:10.5px; padding:2px 7px; border:1px solid rgba(var(--gold-rgb),.6); color:var(--gold);
  border-radius:2px; letter-spacing:.06em; margin-left:2px}
.gs-lh-pname{font-family:'Gowun Batang',serif; font-weight:700; font-size:21px; margin-top:2px}
.gs-lh-chips{display:flex; gap:6px; flex-wrap:wrap; margin-top:10px}
.gs-lh-chip{font-size:11.5px; padding:3px 9px; border:1px solid rgba(var(--ink-rgb),.28); border-radius:3px;
  color:var(--ink-body)}
.gs-lh-chip.r{border-color:rgba(var(--gold-rgb),.55)}
.gs-lh-seats{display:flex; gap:5px; flex-wrap:wrap; margin-top:12px; align-items:center}
.gs-lh-seat{font-family:'Gowun Batang',serif; font-weight:700; font-size:13px; padding:4px 9px;
  border-radius:14px; background:rgba(var(--ink-rgb),.08)}
.gs-lh-seat.ph{width:22px; height:22px; padding:0; border-radius:50%;
  border:1px dashed rgba(var(--kraftdk-rgb),.9); background:transparent}
.gs-lh-seatn{font-size:11.5px; color:var(--ink-2); margin-left:4px}
.gs-lh-chip-seat{border-style:dashed}
.gs-lh-foot{display:flex; justify-content:flex-end; margin-top:16px}
.gs-lh-foot .gs-lbstart,.gs-lh-box .gs-lbstart{margin-left:0}
/* 내 판 카드의 상자 — 네 얼굴이 같은 뼈대 (2026-09-06): 가운데 정렬, 사실 한 줄·설명 한 줄·버튼 줄.
   빈 판만 점선, 두고 나온 진행 중만 금테. (폐기) .gs-lh-empty 점선 상자는 백지에만 있었다 */
.gs-lh-box{border:1px solid rgba(var(--ink-rgb),.48); background:rgba(var(--ink-rgb),.035); border-radius:6px; padding:18px 16px 16px; text-align:center; /* 테두리를 또렷하게 — 상자 전체가 누르는 영역임을 알리는 선 (2026-09-07 사용자: 롤처럼 상자 안 우상단 ×까지는 말고 테두리로) */
  color:var(--ink-2); font-size:12.5px; line-height:1.7}
.gs-lh-box.empty{border:1px dashed var(--kraft-dk); border-radius:0}
.gs-lh-box.live{border-color:rgba(var(--gold-rgb),.55); box-shadow:inset 3px 0 0 var(--gold)}
.gs-lh-box .gs-lh-facts{margin:0}
.gs-lh-box .gs-lh-sub{margin:0}
.gs-lh-box .gs-lh-facts + .gs-lh-sub{margin-top:4px}
.gs-lh-acts{display:flex; justify-content:center; align-items:center; gap:10px; margin-top:14px; position:relative}
/* 롤 로비처럼 (2026-09-07 사용자 확정) — 제목 줄 오른쪽 끝 작은 [× 해산], 상자 전체가 문. (폐기) .gs-lh-side 왼쪽 유령 [해산] */
.gs-lh-boxwrap{position:relative}
.gs-lh-x{position:absolute; top:8px; right:10px; border:1px solid rgba(var(--ink-rgb),.42); background:transparent; font:inherit; font-size:12px; letter-spacing:0; color:var(--ink-2); cursor:pointer; padding:3px 9px; border-radius:4px} /* 테두리 있는 작은 버튼 — 상자 안에서 눌리는 것임을 보인다 (2026-09-07 사용자) */
.gs-lh-x span{font-size:14px; line-height:1; margin-right:2px}
.gs-lh-x:hover{color:#e59a90; border-color:rgba(229,154,144,.7); background:rgba(229,154,144,.1)}
.gs-lh-go{cursor:pointer; transition:border-color .15s, background .15s}
.gs-lh-go:hover{border-color:rgba(var(--gold-rgb),.75); background:rgba(var(--gold-rgb),.05)}
.gs-lh-go:focus-visible{outline:2px solid var(--gold); outline-offset:2px}
.gs-lh-names{margin:4px 0 0; font-size:13.5px; color:var(--ink); line-height:1.6}
.gs-lh-goto{display:inline-block; margin-top:12px; color:var(--gold); font-weight:600; font-size:12.5px; letter-spacing:.02em}
.gs-lh-back{margin-bottom:14px}
.gs-lh-join{display:flex; gap:8px; margin-top:8px}
/* 입력칸은 칸처럼 보여야 합니다 (2026-09-07 사용자: 어디가 텍스트 박스인지 안 보인다) — 표 안 .gs-in 과 달리 테두리·바탕·안쪽 여백 */
.gs-lh-in{flex:1 1 auto; min-width:0; border:1px solid rgba(var(--ink-rgb),.42); background:rgba(0,0,0,.18); border-radius:4px; padding:9px 12px; font-size:14px}
.gs-lh-in:focus{outline:none; border-color:var(--gold); background:rgba(0,0,0,.24)}
.gs-lh-in::placeholder{color:rgba(var(--ink-rgb),.45)}
.gs-lh-mates{display:flex; align-items:center; gap:6px; flex-wrap:wrap; margin-top:14px}
.gs-lh-mates .gs-caplab{margin-right:4px}
.gs-lh-mate{font:inherit; font-family:'Gowun Batang',serif; font-weight:700; font-size:12.5px; padding:3px 9px;
  border-radius:14px; border:1px solid rgba(var(--ink-rgb),.3); background:transparent; color:var(--ink); cursor:pointer}
.gs-lh-mate:hover{border-color:var(--gold)}
.gs-lh-note{margin:12px 0 0; font-size:11.5px; color:var(--ink-2); line-height:1.7}
.gs-lh-recfoot{display:flex; align-items:center; gap:12px; margin-top:10px; font-size:11.5px; color:var(--ink-2)}
.gs-lh-recfoot .gs-auth-linkb{margin-left:auto}
.gs-lh-stat b{color:var(--ink-body); font-weight:600}
/* 브랜드는 버튼입니다 (로비 문) — 글자 룩은 위 .gs-sysbrand 규칙 그대로 */
button.gs-sysbrand{background:none; border:0; padding:0; cursor:pointer; font-family:inherit; line-height:inherit}
button.gs-sysbrand:hover{opacity:1; color:var(--gold)}
/* 준비 상태의 표 — 칸은 잠겨 있고 ＋도 없습니다. 세기 시작하는 문은 [시작] 하나입니다 (§3.1) */
.gs-hit-ready{opacity:.55; cursor:default}
.gs-hit-ready .gs-hit-ghost{visibility:hidden}
/* 모집 카드 — 옛 모으기 열이 표 위에 가로로 누웠습니다 (§3.1, 2026-09-05). 시작하면 사라집니다 */
.gs-recruitsec{margin-top:14px}
.gs-recruit{padding:16px 18px 14px; border-color:rgba(var(--gold-rgb),.45)}
.gs-recruit .gs-lbsec{margin-bottom:12px}
.gs-recruit-guest{margin:12px 0 0}
/* 내 판 카드의 세 얼굴 (§3.0, 2026-09-05) — 상태가 제목 */
.gs-lh-facet{display:flex; align-items:center; gap:8px; flex-wrap:wrap}
.gs-lh-facet b{font-family:'Gowun Batang',serif; font-weight:700; font-size:19px; color:var(--ink); letter-spacing:0}
/* (폐기 2026-09-06 낮) .gs-lh-face-live — 진행 중 얼굴만 쓰던 금테 상자. 지금은 .gs-lh-box.live */
.gs-lh-facts{margin:8px 0 0; font-family:var(--mono); font-size:13px; color:var(--ink-body); letter-spacing:.02em}
.gs-lh-sub{margin:8px 0 0; font-size:12px; color:var(--ink-2); line-height:1.7}
.gs-livechip-dot{display:inline-block; width:7px; height:7px; border-radius:50%; background:#6fbf73; flex:none;
  animation:gs-livepulse 1.6s ease-out infinite}
@keyframes gs-livepulse{0%{box-shadow:0 0 0 0 rgba(111,191,115,.6)} 100%{box-shadow:0 0 0 7px rgba(111,191,115,0)}}
/* 헤더의 진행 중 칩 — 판을 두고 나온 동안만 (§3.0) */
.gs-livechip{display:inline-flex; align-items:center; gap:7px; margin-left:12px; height:26px; padding:0 11px;
  font:inherit; font-size:12px; letter-spacing:.03em; color:var(--ink); cursor:pointer; border-radius:13px;
  border:1px solid rgba(var(--gold-rgb),.6); background:rgba(var(--gold-rgb),.1); white-space:nowrap}
.gs-livechip:hover{background:rgba(var(--gold-rgb),.2)}
/* 빵부스러기와 상태 칩 (§3.0) */
.gs-crumbrow{display:flex; align-items:center; justify-content:space-between; margin:0 0 2px}
.gs-crumb{font:inherit; font-size:12px; color:var(--ink-2); background:none; border:0; padding:2px 0; cursor:pointer;
  letter-spacing:.03em; display:inline-flex; align-items:center; gap:3px}
.gs-crumb:hover{color:var(--gold)}
.gs-crumb span{font-size:16px; line-height:1}
.gs-stchip{font-size:10.5px; padding:2px 8px; border-radius:2px; letter-spacing:.06em; white-space:nowrap; flex:none}
.gs-stchip-ready{border:1px dashed rgba(var(--ink-rgb),.4); color:var(--ink-2)}
.gs-stchip-live{border:1px solid rgba(var(--gold-rgb),.6); color:var(--gold)}
/* 줄의 사람 시트 (§3.2) */
.gs-ppl-who{margin:0 0 10px; font-size:13px; color:var(--ink-body); line-height:1.7}
.gs-ppl-who b{color:var(--gold)}
.gs-seatopt-danger{color:var(--red)}
.gs-seatopt-new{border-style:dashed}
.gs-seatclaimcard{padding:14px 18px 16px}
.gs-seatclaimcard .gs-seatclaim-lead{margin-top:0}
/* 판 중 도구줄 — 채팅 복사와 초대 링크가 왼쪽에 나란히 */
.gs-tablebar-l{display:flex; align-items:center; gap:8px; flex-wrap:wrap}
.gs-invbtn-n{margin-left:6px; font-family:var(--mono); font-size:11.5px; color:var(--gold); font-weight:400}
.gs-invmodal .gs-lbsec{margin-top:12px}
.gs-easebar{margin-top:12px}
/* 초대 — 코드가 주인공 (⑥) */
/* 초대 한 덩이 (2안, 2026-09-07) — 주 버튼 · 코드 칩 · 유령 둘 · 작은 글자, 왼쪽에 모여 한 줄(좁으면 줄바꿈). (폐기) 라벨 줄 + 22px 코드 + 오른쪽 끝 글자 링크 */
.gs-invcode{display:flex; flex-direction:column; align-items:flex-start; gap:8px} /* 두 줄 고정 (2026-09-07 밤) */
.gs-invcode-l1,.gs-invcode-l2{display:flex; align-items:center; gap:8px; flex-wrap:wrap}
.gs-invcode-chip{display:inline-flex; align-items:center; gap:4px; padding:2px 4px 2px 12px; border:1px solid rgba(var(--gold-rgb),.5); border-radius:4px; background:rgba(0,0,0,.18)}
.gs-invcode-b{font-family:var(--mono); font-size:15px; letter-spacing:.2em; color:var(--gold); line-height:1}
.gs-invcode-renew{margin-left:2px; font-weight:400; color:var(--ink-2); text-decoration:underline}
.gs-invcode-renew:hover{color:var(--gold)}
.gs-invdiscbtn{white-space:nowrap}
.gs-recruit-who{margin:6px 0 12px; font-size:14px; color:var(--ink); line-height:1.6}
/* 파티 허브 (2026-09-07) — 헤더 칩의 팝오버와 로비 2열 카드 */
.gs-hubchip{margin-left:12px}
.gs-hubchip.on{background:rgba(var(--gold-rgb),.22)}
.gs-hubchip-off{border-color:rgba(var(--ink-rgb),.3); background:transparent; color:var(--ink-2)}
.gs-hubchip-off:hover{background:rgba(var(--ink-rgb),.06)}
.gs-hubpop{left:0; right:auto; width:min(480px, 92vw); padding:14px 16px 16px}
.gs-hubpop .gs-lbcard-h{margin-top:0}
.gs-hub-inv{margin-top:12px; padding-top:12px; border-top:1px dashed rgba(var(--ink-rgb),.18)}
.gs-hub-own{margin:10px 0 0; font-size:12.5px; color:var(--ink-body); display:flex; align-items:center; gap:8px; flex-wrap:wrap}
.gs-hub-pending{display:flex; align-items:center; gap:10px; padding:10px 12px; margin:0 0 12px; border:1px solid rgba(var(--gold-rgb),.5); background:rgba(var(--gold-rgb),.06); font-size:12.5px; color:var(--ink-body)}
.gs-hub-pending b{color:var(--ink)}
.gs-hub-pending-r{margin-left:auto; display:flex; gap:8px}
.gs-lh-norec{padding:16px}
.gs-lh-getaddr{width:100%; margin-top:2px}
/* 아바타 한 벌 (2026-09-07 ③) — 글자 원, 계정 색(--h), 방장 금테 */
.gs-ava{font-style:normal; border-radius:50%; display:inline-grid; place-items:center; flex:none; line-height:1;
  font-family:'Gowun Batang',serif; font-weight:700; color:#f3ece0; background:hsl(var(--h, 30) 38% 30%); border:1px solid rgba(var(--ink-rgb),.2)}
.gs-ava-host{border-color:var(--gold); box-shadow:0 0 0 2px rgba(var(--gold-rgb),.18)}
.gs-rowi-ava{width:20px; height:20px; font-family:'Gowun Batang',serif; font-weight:700; font-size:10px; line-height:1;
  color:#f3ece0; background:hsl(var(--h, 30) 38% 30%); border-color:rgba(var(--ink-rgb),.2)}
.gs-rowmeta:hover .gs-rowi-ava,.gs-rowi-ava:focus-visible{color:#fff; border-color:rgba(var(--gold-rgb),.9)}
.gs-rowi-ava.gs-rowi-host{border-color:var(--gold)} /* 글자 원 규칙이 방장 금테를 덮지 않게 (2026-09-07 밤 실측) */
/* 허브 머리 — 팝오버의 나 한 줄 */
.gs-hub-me{display:flex; align-items:center; gap:8px; margin:0 0 12px; padding-bottom:10px; border-bottom:1px solid rgba(var(--ink-rgb),.14)}
.gs-hub-me b{font-family:'Gowun Batang',serif; font-size:16px; font-weight:700}
.gs-rolebadge{font-size:11px; padding:2px 7px; border:1px solid rgba(var(--gold-rgb),.6); color:var(--gold); border-radius:3px; letter-spacing:.06em; flex:none}
.gs-rolebadge-dim{border-color:rgba(var(--ink-rgb),.3); color:var(--ink-2)}
.gs-hub-st{margin-left:auto; color:var(--ink-2); font-size:12.5px; display:inline-flex; align-items:center; gap:6px; text-align:right}
.gs-hub-st b{color:var(--ink); font-weight:600}
.gs-lh-hubh{margin-bottom:10px}
/* 판 중 파티 줄 (⑤) */
.gs-recruit-live{display:flex; align-items:center; gap:12px; padding:10px 16px}
.gs-recruit-livehead{font-size:13px; color:var(--ink-body)}
.gs-recruit-livehead b{font-family:var(--mono); color:var(--ink); font-weight:600}
.gs-recruit-on{font-style:normal; color:var(--ink-2); margin-left:8px; display:inline-flex; align-items:center; gap:6px}
.gs-recruit-liveacts{margin-left:auto; display:flex; align-items:center; gap:8px}
/* 창 안 실시간 미리보기 (①) */
  border-radius:6px; background:#8a8a8a}
/* 준비 상태의 자리 띠 (§3.1, 2026-09-05) — 잠긴 벌금 칸 자리에 "이 줄에 누가 있나" */
.gs-seatstripcell{padding:4px 6px}
.gs-seatstrip{display:flex; align-items:center; gap:8px; height:40px; padding:0 12px; border-radius:3px;
  border:1px dashed rgba(var(--kraftdk-rgb),.55); background:rgba(var(--ink-rgb),.04); font-size:12.5px; color:var(--ink-2)}
.gs-seatstrip b{font-weight:600; color:var(--ink)}
/* 띠는 왼쪽 구분선에서 한 뼘 떨어집니다 (2026-09-06 사용자 지적) */
.gs-seatstripcell .gs-seatstrip{margin-left:10px}
.gs-seatstrip-on{border-style:solid; border-color:rgba(111,191,115,.45); color:var(--ink-body)}
.gs-seatstrip-off{border-style:solid; border-color:rgba(var(--ink-rgb),.2)}
.gs-seatstrip-new{border:1px solid rgba(var(--gold-rgb),.85); background:rgba(var(--gold-rgb),.12); color:var(--ink)}
.gs-seatstrip-empty{opacity:.7}
.gs-sdot{width:7px; height:7px; border-radius:50%; background:#6fbf73; flex:none}
.gs-sdot.off{background:var(--ink-2); opacity:.6}
.gs-seatstrip-hint{margin-left:auto; font-size:11.5px; color:var(--ink-2)}
.gs-seatstrip .gs-lb-tag{margin-left:2px}
.gs-lb-tag-host{background:var(--chip-bg); color:var(--chip-fg); border-color:transparent}
/* 방금 앉은 줄 — 3초 금색으로 밝았다 가라앉습니다 */
tr.gs-row-arrive td,tr.gs-row-arrive th{animation:gs-arrive 30s ease-out forwards}
tr.gs-row-arrive th.gs-stick{box-shadow:inset 3px 0 0 var(--gold)}
@keyframes gs-arrive{0%{background-color:rgba(var(--gold-rgb),.18)} 100%{background-color:rgba(var(--gold-rgb),.05)}}
/* 모집 카드 머리 · 상태 칩 · 도구줄 요약 */
.gs-recruit-head{display:flex; align-items:center; gap:8px}
.gs-recruit-live{display:inline-flex; align-items:center; gap:7px; color:var(--ink); letter-spacing:.02em; font-size:13px; font-weight:600}
.gs-stchip-rec{border:1px solid rgba(var(--gold-rgb),.6); color:var(--gold)}
.gs-seatsum{margin-left:auto; font-size:12px; color:var(--ink-2)}
/* 물건 셋·상태 셋 (2026-09-06): 로비 얼굴 · 헤더 칩 · [시작] 글로우 · 시작 전 이름 칸 · 퇴장 태그 */
/* 2026-09-06 밤: 헤더 초대 코드 팝오버 · 전부 비우기 · 이어서 칩 */
.gs-invwrap{position:relative; display:inline-flex}
/* [?] 팝오버 감싸개 — 이게 없으면 팝오버 기준이 페이지 전체가 되어 맨 아래에 그려짐 (2026-09-06 운영에서 발견) */
.gs-helpwrap{position:relative; display:inline-flex}
.gs-invbtn{display:inline-flex; align-items:center; gap:6px; height:32px; padding-top:0; padding-bottom:0}
.gs-invbtn.on{border-color:rgba(var(--gold-rgb),.6); color:var(--gold)}
.gs-invpop{position:absolute; right:0; top:calc(100% + 8px); z-index:60; width:min(440px, 92vw); background:var(--paper);
  border:1px solid rgba(var(--gold-rgb),.5); border-radius:4px; padding:12px 14px 14px; box-shadow:0 12px 34px rgba(var(--shadow-rgb),.35); text-align:left}
.gs-wipebtn{display:inline-flex; align-items:center; gap:6px; margin-right:8px}
.gs-resumechip{display:inline-flex; align-items:center; gap:6px; font-size:12px; padding:3px 4px 3px 10px; border:1px solid rgba(var(--gold-rgb),.55); border-radius:3px; color:var(--ink-body)}
.gs-resumechip-x{font-size:16px; line-height:1; padding:0 4px}
/* 파티원 쪽 (2026-09-06): 초대장 정중앙 · 해산 쪽지 · 공유 창 초대 코드 */
.gs-invitegate .gs-sysbar{display:none}
.gs-invitegate{padding-top:0; padding-bottom:0; min-height:0}
.gs-invitegate .gs-invitesec{min-height:100vh; min-height:100dvh; margin-top:0; margin-bottom:0; display:flex; flex-direction:column; align-items:center; justify-content:center; padding-top:0; padding-bottom:0}
.gs-invite-brand{font-size:13px; font-weight:800; letter-spacing:.06em; opacity:.6; margin-bottom:14px}
.gs-note{display:flex; align-items:center; gap:12px; padding:10px 12px; margin-bottom:14px; border:1px solid rgba(var(--ink-rgb),.28); background:rgba(var(--ink-rgb),.05); font-size:12.5px; color:var(--ink-body)}
.gs-note b{color:var(--ink)}
.gs-note-x{margin-left:auto; font:inherit; font-size:16px; line-height:1; color:var(--ink-2); background:none; border:0; cursor:pointer; padding:0 2px}
.gs-obs-invcard{margin-top:14px}
/* 표 아래 사건 줄과 자기 줄 밑의 요청 줄 (2026-09-06) */
tr.gs-subreq td{padding:6px 6px 4px; border-bottom:1px dotted rgba(var(--ink-rgb),.2)}
.gs-waitrows{display:flex; flex-direction:column; gap:6px; margin:10px 0 0}
.gs-waitline{display:flex; align-items:center; gap:10px; padding:8px 12px; border:1px dashed rgba(var(--gold-rgb),.55); background:rgba(var(--gold-rgb),.06); font-size:12.5px; color:var(--ink-body)}
.gs-waitline b{font-family:'Gowun Batang',serif; font-weight:700; color:var(--ink); font-size:14px}
.gs-waitwhy{color:var(--ink-body)}
.gs-waitacts{margin-left:auto; display:flex; gap:10px; align-items:center}
.gs-placebtn{border-color:rgba(var(--gold-rgb),.7); color:var(--gold)}
.gs-subline{display:flex; align-items:center; gap:10px; margin-left:22px; padding:6px 12px; border:1px solid rgba(var(--gold-rgb),.55); border-left:3px solid var(--gold); background:rgba(var(--gold-rgb),.07); font-size:12.5px; color:var(--ink-body)}
.gs-subline b{font-family:'Gowun Batang',serif; font-weight:700; color:var(--ink)}
.gs-subarrow{font-family:var(--mono); color:var(--ink-2)}
.gs-lh-cnt{font-family:var(--mono); font-size:12.5px; color:var(--gold); letter-spacing:0; font-weight:400; margin-left:8px}
/* (폐기 2026-09-06 낮) .gs-lh-foot2 — 시작 전 얼굴의 버튼 줄. 지금은 .gs-lh-acts */
@keyframes gs-glow{0%,100%{box-shadow:0 0 0 0 rgba(var(--gold-rgb),0)}50%{box-shadow:0 0 0 7px rgba(var(--gold-rgb),.26)}}
.gs-glow{animation:gs-glow 3s ease-in-out infinite}
/* 글자 칸은 입력칸과 같은 글꼴·정렬(Gowun Batang, 오른쪽 맞춤)을 그대로 씁니다 — (버그 기록 2026-09-06) font:inherit·왼쪽 맞춤으로 덮어 이름 글꼴이 바뀌고 왼쪽에 붙었다 */
.gs-name-ro{cursor:default; background:transparent; border-color:transparent; color:var(--ink); display:block; width:100%}
.gs-name-ro:hover{border-color:transparent; background:transparent}
.gs-name-ro .gs-name-ph{color:rgba(var(--ink-rgb),.32); font-weight:400}
.gs-livechip-ready{border-color:rgba(var(--gold-rgb),.55)}
/* 표준화 (2026-09-05): 나감 태그 · 옮기기 · 초대장 이름 · 로비 비로그인 · 자리표시 이름 */
.gs-lb-tag-left{border-style:dashed; color:var(--ink-2)}
.gs-strip-move{margin-left:auto; font-size:12px}
.gs-invite-typed{color:var(--ink-2); font-weight:400}
.gs-lh-loginnote{margin-top:14px}
.gs-lbhero-ph b{color:var(--ink-2); font-weight:400}
.gs-invmodal-live{margin:0 0 2px}
.gs-blocked-acts{justify-content:center; margin-top:12px}
.gs-recruit-code{margin-top:4px}
.gs-recruit .gs-lbsec:last-child{margin-bottom:0}
.gs-recruit .gs-lbinv{justify-content:flex-start; flex-wrap:nowrap}
/* 주소·남은 시간은 왼쪽, 버튼들은 오른쪽 끝 — 한 줄에 섭니다 (§9-1). 옛 모으기 열은 폭이 좁아 주소가 한 줄을 다 먹었습니다 */
.gs-recruit .gs-lbinv-u{flex:0 1 auto; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap}
.gs-recruit .gs-lbinv .gs-eyebtn{margin-left:auto}
.gs-readytools{margin-right:auto}
.gs-lbgensbtn{flex:none; font:inherit; font-size:11.5px; cursor:pointer; padding:5px 9px;
  display:inline-flex; align-items:center; gap:5px; border-radius:7px;
  color:var(--ink-2); background:transparent; border:1px solid rgba(var(--ink-rgb),.2)}
.gs-lbgensbtn:hover{color:var(--ink); border-color:var(--kraft-dk);
  background:rgba(var(--ink-rgb),.05)}
.gs-lbgensbtn b{font-family:var(--mono); font-weight:700; color:var(--ink)}
.gs-seatlist{display:flex; flex-direction:column; gap:6px; margin:12px 0}
.gs-seatopt{font:inherit; text-align:left; cursor:pointer; padding:10px 13px; border-radius:7px;
  font-size:13.5px; color:var(--ink-body); background:rgba(var(--ink-rgb),.05);
  border:1px solid rgba(var(--ink-rgb),.16);
  display:flex; align-items:center; justify-content:space-between; gap:10px}
.gs-seatopt:hover{border-color:var(--gold)}
.gs-seatopt:disabled{opacity:.55; cursor:default}
/* 판 도중 합류자의 자리 고르기 — 고르는 줄의 벌금이 같이 보여야 "이어받는다"가 읽힙니다 */
.gs-seatclaim-lead{margin:10px 0 0; font-size:13px; line-height:1.7; color:var(--ink-body)}
.gs-seatopt-g{font-style:normal; font-family:var(--mono); font-size:12.5px; color:var(--gold)}
/* 인원 수 숫자 칸 — 4·8 빠른 문 옆의 직접 고치는 문입니다 (§3.1) */
.gs-lbcapin{display:inline-flex; align-items:center; gap:4px; font-size:12px; color:var(--ink-2)}
.gs-lbcapin input{font:inherit; font-family:var(--mono); font-size:12.5px; width:3.1em;
  text-align:right; padding:3px 5px; border-radius:6px; color:var(--ink);
  background:rgba(var(--ink-rgb),.05); border:1px solid rgba(var(--ink-rgb),.2)}
.gs-lbcapin input:focus{outline:none; border-color:var(--gold)}
.gs-mem-seat{font-size:11px; color:var(--gold); flex:none}
.gs-key-note{margin:8px 0 0; font-size:12.5px; color:var(--gold)}
/* 얼림 띠 — 굳었을 뿐 아무것도 지워지지 않았습니다 */
.gs-slip-hold{border-left-color:var(--gold); background:rgba(var(--gold-rgb),.1)}
.gs-hit-idle{cursor:default}
/* 파티원이 보는 대기실 — 표가 아니라 이름 목록입니다 */
.gs-lobbybox{padding-top:16px}
.gs-lb-head{display:flex; align-items:baseline; gap:12px; flex-wrap:wrap; margin-bottom:10px}
.gs-lb-title{margin:0}
.gs-lb-count{font-size:12.5px; color:var(--ink-2); display:inline-flex; align-items:center}
.gs-lb-count b{font-size:15px; color:var(--ink)}
.gs-lb-list{list-style:none; margin:0; padding:0; display:flex; flex-wrap:wrap; gap:8px}
.gs-lb-list li{display:inline-flex; align-items:center; gap:7px; padding:8px 13px;
  border:1px solid rgba(var(--ink-rgb),.2); background:rgba(var(--ink-rgb),.05);
  border-radius:99px; font-size:13px}
.gs-lb-list li b{font-family:'Gowun Batang',serif; font-weight:700; font-size:16px}
.gs-lb-list li.me{border-color:rgba(var(--gold-rgb),.7)}
.gs-lb-list li.me b{color:var(--gold)}

/* 합류 신청 알림 — 알리고 목록으로 데려가는 역할만 합니다 (§3-4) */
.gs-joincard{pointer-events:auto; max-width:330px}
.gs-join-sub{display:block; margin-top:5px; font-size:12.5px; color:var(--ink-body);
  line-height:1.6}
.gs-join-id{font-weight:400; color:var(--ink-2); font-size:12px}
.gs-join-more{margin-left:6px; font-size:11.5px; color:var(--gold)}
/* 버튼은 오른쪽 끝 한 선에 (§9-1) — 주 동작이 맨 오른쪽입니다 */
.gs-join-acts{display:flex; justify-content:flex-end; gap:8px; margin-top:11px}
/* 지목 초대 카드 — 신청 알림과 같은 자리, 같은 몸입니다. 다른 건 금테 하나뿐입니다:
   1분 안에 손이 가야 하는 카드라 눈에 먼저 걸려야 합니다 (§3.3) */
.gs-invcard{pointer-events:auto; max-width:330px; border-color:rgba(var(--gold-rgb),.5)}

/* 함께한 사람 칩 — 목록이 곧 방 찾기입니다 (§3.3). 얼굴 하나가 상태를 말합니다 */
.gs-mates{display:flex; gap:7px; flex-wrap:wrap}
.gs-mate{font:inherit; font-family:'Gowun Batang',serif; font-weight:700; font-size:13.5px;
  color:var(--ink); background:none; padding:4px 10px; cursor:pointer;
  border:1px solid rgba(var(--ink-rgb),.22); border-radius:7px}
.gs-mate:hover{border-color:rgba(var(--gold-rgb),.55)}
.gs-mate i{font-style:normal; font-family:inherit; font-weight:400; font-size:10.5px;
  color:var(--gold); margin-left:5px}
/* 이미 앉은 사람은 다시 부를 수 있습니다 — 누를 수는 있게 두고 얼굴만 가라앉힙니다 */
.gs-mate.on{color:var(--ink-2); border-color:rgba(var(--ink-rgb),.14)}
.gs-mate.on i{color:var(--ink-2)}

/* 계정 창 */
.gs-auth-head{display:flex; align-items:center; gap:10px}
.gs-auth-head h3{margin-right:auto}
/* 주 버튼은 폭을 다 씁니다 — 이 창에서 할 일이 하나라 고민할 자리가 없습니다 */
.gs-authgo{display:block; width:100%; margin-top:16px; padding:11px 14px; font-size:13.5px;
  font-weight:600; text-align:center}
/* 랜딩의 문 두 장 (§3.11, 2026-09-05) — 그림 대신 얼굴(아이콘·이름·한 줄)이 문입니다.
   ← 뒤로가 분기를 전담하므로 서브 화면에는 다른 문이 없습니다 */
.gs-auth-pick{display:grid; grid-template-columns:repeat(2, minmax(0, 1fr)); gap:10px; margin-top:14px}
.gs-auth-pcard{display:flex; flex-direction:column; align-items:center; gap:7px;
  padding:16px 12px 13px; font:inherit; cursor:pointer; text-align:center;
  border:1px solid rgba(var(--ink-rgb),.28); border-radius:3px;
  background:rgba(var(--ink-rgb),.04); color:var(--ink)}
.gs-auth-pcard:hover{border-color:var(--gold); background:rgba(var(--gold-rgb),.07)}
.gs-auth-pcard b{font-family:'Gowun Batang',serif; font-size:14.5px}
.gs-auth-pcard em{font-style:normal; font-size:11px; color:var(--ink-2); line-height:1.65}
.gs-auth-pcard svg{opacity:.8}
.gs-auth-back{border:0; background:none; color:var(--ink-2); cursor:pointer;
  font:inherit; font-size:15px; line-height:1; padding:2px 6px 2px 0}
.gs-auth-back:hover{color:var(--ink)}
/* 게스트 칸의 닉 입력 — 이 화면의 유일한 입력이라 크게, 가운데에 (§3.11 목업 ⓑ) */
.gs-in-nickxl{display:block; width:100%; margin-top:12px; font-family:'Gowun Batang',serif;
  font-weight:700; font-size:26px; text-align:center; letter-spacing:.06em; color:var(--ink);
  border:1px solid rgba(var(--ink-rgb),.28); border-radius:3px; padding:12px 14px;
  background:rgba(var(--ink-rgb),.04)}
.gs-auth-nickhint{margin:9px 0 0 !important; font-size:11.5px !important;
  color:var(--ink-2) !important; text-align:center}
.gs-auth-line{margin:14px 0 0 !important; text-align:center; font-size:12.5px !important;
  color:var(--ink-2) !important}
.gs-auth-linkb{font:inherit; font-size:12.5px; font-weight:600; color:var(--gold);
  background:none; border:0; cursor:pointer; padding:0;
  text-decoration:underline; text-underline-offset:3px}
.gs-auth-linkb:hover{color:var(--ink)}
/* 가입 경고 한 덩어리 — 겁주는 상자가 아니라 발치의 작은 글씨입니다 */
.gs-auth-fine{margin:10px 0 0 !important; font-size:11.5px !important; line-height:1.7;
  color:var(--ink-2) !important}
.gs-field{display:block; margin-top:12px; font-size:11px; letter-spacing:.1em;
  color:var(--ink-2)}
.gs-field-hint{letter-spacing:0; font-size:11px}
.gs-in-field{display:block; width:100%; margin-top:5px; font-size:14px;
  border:1px solid rgba(var(--ink-rgb),.28); border-radius:3px; padding:8px 10px;
  background:rgba(var(--ink-rgb),.04)}
.gs-in-nickbig{width:110px; font-family:'Gowun Batang',serif; font-weight:700; font-size:16px}
.gs-auth-warn{margin:12px 0 0; color:var(--red); font-size:11.5px; line-height:1.75}
/* 만료 안내는 경고가 아니라 사실이라, 빨강을 안 씁니다 */
.gs-auth-note{margin:6px 0 0; color:var(--ink-2); font-size:11.5px; line-height:1.75}
/* 끼어든 창이 스스로를 변명하는 줄 — 입력칸 위에 한 번만 */
.gs-auth-why{margin:10px 0 2px; font-size:12.5px; line-height:1.8; color:var(--ink-body);
  border-left:2px solid rgba(var(--gold-rgb),.6); background:rgba(var(--gold-rgb),.07);
  padding:8px 11px}

/* 오버레이 공유 설정 창의 계정 줄 — 제목 바로 아래 (§5.7, 2026-09-05 확정) */
.gs-acct-row{display:flex; align-items:center; gap:10px; margin-top:16px; flex-wrap:wrap}
.gs-acct-ava{font-style:normal; width:30px; height:30px; border-radius:50%; flex:none;
  display:inline-flex; align-items:center; justify-content:center;
  background:var(--chip-bg); color:var(--chip-fg); font-size:14px; font-weight:700;
  font-family:'Gowun Batang',serif}
.gs-acct-nick2{font-family:'Gowun Batang',serif; font-size:14.5px}
.gs-acct-badge{font-size:11px; color:var(--ink-2); padding:1px 6px; border-radius:2px;
  border:1px solid rgba(var(--ink-rgb),.28)}
.gs-acct-idm{font-family:var(--mono); font-size:11px; color:var(--ink-2)}
.gs-acct-row .gs-acct-acts,.gs-acct-row .gs-acct-nick{margin-left:auto}
.gs-acct-note{margin:7px 0 0; font-size:11.5px; line-height:1.7; color:var(--ink-2)}
/* 닉 바꾸기·로그아웃이 한 줄. 입력칸은 접혀 있다가 필요할 때만 열립니다 (§9-7) */
.gs-acct-acts{display:flex; align-items:center; gap:10px}
.gs-acct-nick{display:flex; align-items:center; gap:7px; flex-wrap:wrap}
.gs-acct-nick .gs-in-nick{flex:1 1 78px; min-width:0}
.gs-acct-err{margin:8px 0 0; font-size:11.5px; color:var(--red); line-height:1.6}
/* 아이디 정하기 줄 — 문장 왼쪽, 문 오른쪽 (재발급 줄과 같은 문법) */
.gs-acct-upline{margin-top:10px}

/* 공유 설정 창의 계정 줄·명단 */
.gs-obs-acct{display:flex; align-items:center; gap:8px; flex-wrap:wrap; margin-top:12px;
  padding:9px 12px; border:1px solid rgba(var(--ink-rgb),.18);
  background:rgba(var(--ink-rgb),.04); font-size:12.5px}
.gs-obs-acct > b{font-family:'Gowun Batang',serif; font-size:16px}
.gs-obs-acctid{color:var(--ink-2); font-size:11.5px}
.gs-in-nick{width:88px; border:1px solid rgba(var(--ink-rgb),.28); border-radius:3px;
  padding:5px 8px; font-size:12.5px}
.gs-obs-logout{margin-left:auto}
.gs-obs-invleft{font-size:11.5px; color:var(--ink-2); white-space:nowrap}
.gs-memlist{list-style:none; margin:8px 0 0; padding:0}
.gs-memlist li{display:flex; align-items:center; gap:8px; padding:7px 11px; font-size:12.5px;
  border:1px solid rgba(var(--ink-rgb),.18); border-radius:5px; margin-top:6px}
.gs-memlist li b{font-family:'Gowun Batang',serif; font-size:15px}
.gs-mem-id{color:var(--ink-2); font-size:11.5px}
.gs-mem-req{font-size:10.5px; letter-spacing:.08em; color:var(--gold)}
.gs-memlist li .gs-btn{margin-left:auto}

/* ── 방 표시 칩 — 머리줄 하나로 "어느 방인가"와 "잘 붙어 있나"를 같이 답합니다 ── */
.gs-roomdd{position:relative}
.gs-roomchip{font:inherit; font-size:12.5px; cursor:pointer; height:32px;
  display:inline-flex; align-items:center; gap:2px; padding:0 10px;
  border:1px solid rgba(var(--gold-rgb),.5); border-radius:7px;
  background:rgba(var(--gold-rgb),.06); color:var(--gold); white-space:nowrap}
.gs-roomchip b{font-family:'Gowun Batang',serif; font-weight:700; font-size:13.5px; color:var(--gold)}
.gs-roomchip:hover,.gs-roomchip.on{background:rgba(var(--gold-rgb),.14)}
/* 문일 때는 눌리는 것처럼 보여야 합니다 — 상태 칩과 같은 몸이되 테두리를 세웁니다 */
.gs-roomchip-go{gap:7px; color:var(--ink); border-color:var(--gold);
  box-shadow:0 0 0 2px rgba(var(--gold-rgb),.25)}
.gs-roomchip-go svg{flex:none; opacity:.8}
.gs-roomchip-go:hover{box-shadow:0 0 0 2px rgba(var(--gold-rgb),.45)}
/* 끊기면 표시합니다 — 방장이 자기 화면에서 알아야 고칠 수 있습니다.
   빨강은 아닙니다: 안내이지 되돌릴 수 없는 일이 아닙니다 (§5.6·§9-4) */
.gs-roomchip-down{border-color:rgba(var(--ink-rgb),.28); background:rgba(var(--ink-rgb),.06);
  color:var(--ink-2)}
.gs-roomchip-down b{color:var(--ink-2)}
.gs-roomchip-down:hover,.gs-roomchip-down.on{background:rgba(var(--ink-rgb),.12)}
/* 점 하나가 방송 상태를 말합니다 — 초록 나가는 중 · 속 빈 회색 끊김 · 빈 원 꺼짐 */
.gs-roomdot{display:inline-block; width:6px; height:6px; border-radius:50%; flex:none;
  background:#6fbf73; margin-left:6px}
/* 송출 상태 점 (§5.7) — 헤더 버튼과 공유 창이 같은 색을 씁니다.
   나가는 중만 초록이고, 나머지는 고장이 아니라 그냥 안 나가는 것이라 조용합니다 */
.gs-castdot{display:inline-block; width:6px; height:6px; border-radius:50%; flex:none;
  margin-left:7px; background:rgba(var(--ink-rgb),.32)}
.gs-castdot-on{background:#6fbf73}
.gs-castdot-down{background:var(--red)}
.gs-castdot-idle,.gs-castdot-recruit,.gs-castdot-none{background:transparent;
  box-shadow:inset 0 0 0 1px rgba(var(--ink-rgb),.45)}
/* 주소 밑 계기판 한 줄 (§5.7) — 점 하나 + 문장. 글줄에 흘려 써서 줄바꿈에도
   점이 문장 첫머리에 남습니다. 색은 점이 답합니다 */
.gs-cast-line{margin:10px 0 0; font-size:12.5px; line-height:1.8; color:var(--ink-body)}
.gs-cast-line .gs-castdot{margin:0 7px 2px 0; vertical-align:middle}
.gs-roomdot.warn{background:rgba(var(--ink-rgb),.42)}
.gs-roomdot.off{background:transparent; box-shadow:inset 0 0 0 1px rgba(var(--ink-rgb),.45)}
.gs-roompanel{position:absolute; top:calc(100% + 7px); left:0; z-index:30; width:262px;
  background:var(--paper); border:1px solid var(--kraft-dk); border-radius:8px; padding:12px 13px;
  box-shadow:0 14px 34px rgba(var(--shadow-rgb),.34)}
.gs-room-h{margin:0; font-family:'Gowun Batang',serif; font-size:16px; font-weight:700}
.gs-room-sub{margin:3px 0 0; font-size:11.5px; color:var(--ink-2)}
.gs-room-mem{margin:7px 0 0; font-size:12px; line-height:1.8; color:var(--ink-body)}
.gs-room-row{display:flex; align-items:center; gap:7px; margin:9px 0 0; padding-top:9px;
  font-size:12.5px; border-top:1px solid rgba(var(--ink-rgb),.14)}
.gs-room-row b{margin-left:auto; font-family:var(--mono); font-size:11.5px; color:var(--ink-2);
  font-weight:400; word-break:break-all; text-align:right}
.gs-room-btns{display:flex; align-items:center; gap:10px; margin-top:11px}
.gs-room-end{margin-left:auto}
/* ── 파티 서랍 — 신청·함께한 사람·초대 링크·파티원이 방 칩 안에 모입니다 (§3.1) ── */
.gs-roompanel-host{width:320px}
.gs-room-sec{margin-top:11px; padding-top:11px; border-top:1px solid rgba(var(--ink-rgb),.14)}
.gs-room-sech{margin:0 0 7px; font-size:11px; letter-spacing:.1em; color:var(--ink-2);
  font-weight:600; display:flex; align-items:center; gap:7px}
.gs-room-cnt{margin-left:auto; font-family:var(--mono); font-size:12px; color:var(--gold)}
.gs-room-sech .gs-obs-why{margin-left:auto; font-size:11px; letter-spacing:0; font-weight:400}
.gs-room-none{margin:0; font-size:11.5px; color:var(--ink-2); line-height:1.7}
.gs-room-sec .gs-lbreq{padding:7px 9px; gap:7px}
.gs-room-sec .gs-lbreq > b{font-size:15px}
.gs-room-sec .gs-memlist li{padding:6px 9px; margin-top:5px}
.gs-room-sec .gs-memlist li:first-child{margin-top:0}
/* 서랍은 좁아서 한 줄에 다 못 섭니다 — 주소는 제 줄을 쓰고, 남은 시간과 버튼이 아랫줄에서
   오른쪽 끝으로 몰립니다 (§9-1). 폭이 다른 버튼이 들쭉날쭉 쌓이지 않게 */
.gs-room-sec .gs-lbinv{gap:8px 10px}
.gs-room-sec .gs-lbinv-u{flex:1 1 100%}
.gs-room-sec .gs-lbinv-left{margin-right:auto}

/* ── 복귀 안내 줄 — 카드 맨 위. 왼쪽 고리가 돌아서 글자를 안 읽어도 흐르는 것이 보입니다 ── */
.gs-slip-back{border-left-color:var(--kraft-dk); background:rgba(var(--ink-rgb),.06)}
.gs-slip-back .gs-slip-msg{color:var(--ink-body)}
.gs-slip-back .gs-slip-msg b{color:var(--ink)}
.gs-ring{flex:none; width:16px; height:16px; border-radius:50%; display:inline-block;
  border:2px solid rgba(var(--gold-rgb),.5); border-top-color:transparent;
  animation:gs-ringspin 1.6s linear infinite}
@keyframes gs-ringspin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){ .gs-ring{animation:none} }

/* ── 자수 탭 — 항목마다 큰 카드 하나. 방송 화면에서도 읽히게 숫자를 크게 씁니다 ── */
.gs-conf-who{display:flex; align-items:baseline; gap:10px; flex-wrap:wrap; margin-bottom:6px}
.gs-conf-who > b{font-family:'Gowun Batang',serif; font-size:24px; font-weight:700; color:var(--gold)}
.gs-conf-tag{font-size:9.5px; letter-spacing:.1em; color:var(--gold); padding:1px 5px;
  border:1px solid rgba(var(--gold-rgb),.55); border-radius:4px}
.gs-conf-sum{margin-left:auto; font-size:12px; color:var(--ink-2)}
.gs-conf-sum b{font-family:var(--mono); font-size:28px; color:var(--gold); font-weight:400}
.gs-conf-howto{margin:0 0 14px; font-size:12px; line-height:1.75; color:var(--ink-2)}
.gs-conf-howto.gs-cellnote{margin:0 0 14px; text-align:left; margin-left:0}
.gs-conf-howto b{color:var(--ink-body); font-weight:600}
.gs-confgrid{display:grid; grid-template-columns:repeat(auto-fit,minmax(210px,1fr)); gap:12px}
/* 카드 B (2026-09-06) — 벌금표 칸의 결. (폐기) 둥근 금테 카드 */
.gs-confcard{font:inherit; cursor:pointer; color:var(--ink); text-align:center;
  display:flex; flex-direction:column; align-items:center; justify-content:center; gap:2px;
  min-height:120px; padding:14px 12px 12px; border-radius:3px;
  border:1px solid rgba(var(--ink-rgb),.28); background:rgba(var(--lift-rgb),.3)}
.gs-confcard:hover{background:rgba(var(--gold-rgb),.1); border-color:rgba(var(--gold-rgb),.7)}
.gs-confhead{display:flex; align-items:baseline; gap:8px; flex-wrap:wrap; justify-content:center}
/* 단가 — 벌금표 머리의 단가(.gs-in-price)와 같은 모양: 모노·금색·점선 밑줄. (폐기 2026-09-06 당일) 13.5px 평문 — 구분이 안 되고 작았다 */
.gs-confunit{display:inline-flex; align-items:baseline; gap:4px}
.gs-confunit small{font-size:11.5px; color:var(--ink-2)}
.gs-confunit u{text-decoration:none; font-family:var(--mono); font-size:15px; color:var(--gold); padding:0 1px} /* 밑줄 없음 — 고칠 수 있는 것처럼 보였다 (2026-09-06 사용자) */
.gs-confcard-off .gs-confunit u{color:var(--ink-2)}
.gs-confgold2{font-family:var(--mono); font-size:17px; color:var(--gold); margin-top:2px}
.gs-confgold2.zero{opacity:.4}
.gs-conf-note{margin:-8px 0 14px; font-size:12px; line-height:1.75; color:var(--ink-2)}
.gs-confcard:active{transform:translateY(1px)}
.gs-confcard-off{cursor:default; opacity:.62; border-color:rgba(var(--ink-rgb),.18);
  background:rgba(var(--ink-rgb),.05)}
.gs-confcard-off:hover{background:rgba(var(--ink-rgb),.05); border-color:rgba(var(--ink-rgb),.18)}
.gs-confcard-off:active{transform:none}
.gs-confname{font-family:'Gowun Batang',serif; font-size:19px; font-weight:700}
.gs-confcard-off .gs-confname{color:var(--ink-2)}
.gs-confprice{font-size:11.5px; color:var(--ink-2); margin-top:1px}
/* 내 벌금 — 카드의 주인공. 방송 화면에서도 읽히게 큽니다 */
.gs-confgold{font-family:var(--mono); font-size:46px; line-height:1.1; margin-top:8px; color:var(--gold)}
.gs-confgold.zero{color:rgba(var(--ink-rgb),.32)}
.gs-confcard .gs-confprice{margin-top:6px}
.gs-confn{font-family:var(--mono); font-size:34px; line-height:1.15; margin-top:6px}
.gs-confn em{font-style:normal; font-family:'IBM Plex Sans KR',sans-serif; font-size:13px;
  color:var(--ink-2); margin-left:3px}
.gs-confn.zero{color:rgba(var(--ink-rgb),.32)}
.gs-conflock{font-size:11px; color:var(--ink-2); margin-top:8px}
/* 되돌리기 칩 (2026-09-07) — 개수·남은 초·막대. 카드(버튼) 안의 표시일 뿐 따로 눌리지 않습니다 */
.gs-confundo{position:relative; display:inline-flex; align-items:center; gap:6px; margin-top:10px; padding:4px 10px 5px 8px;
  border:1px solid rgba(var(--gold-rgb),.6); border-radius:99px; font-size:12px; line-height:1.3; color:var(--ink);
  background:rgba(var(--gold-rgb),.08); overflow:hidden; white-space:nowrap}
.gs-confundo b{color:var(--gold); font-family:var(--mono); font-weight:600}
.gs-confundo-bar{position:absolute; left:0; bottom:0; height:2px; background:var(--gold)}
/* 자수 탭은 파티원의 기본 화면이라, 탭 줄에서도 금색으로 먼저 눈에 듭니다 */
.gs-tab-confess{border-color:rgba(var(--gold-rgb),.55)}
.gs-tab-confess.on{border-color:rgba(var(--gold-rgb),.7); color:var(--gold)}

/* ── 자수가 왔다는 표시 ── */
.gs-press-conf{flex:none; font-size:10px; letter-spacing:.08em; color:var(--gold);
  border:1px solid rgba(var(--gold-rgb),.5); border-radius:3px; padding:1px 4px}
/* 자수로 바뀐 칸이 잠깐 번쩍입니다 — 방장의 눈은 판에 있습니다 */
.gs-hit-conf{animation:gs-confflash 1.1s ease-out}
@keyframes gs-confflash{
  0%{background:rgba(var(--gold-rgb),.55); box-shadow:0 0 0 3px rgba(var(--gold-rgb),.4)}
  100%{background:var(--cell); box-shadow:0 0 0 0 rgba(var(--gold-rgb),0)}
}
.gs-conftip{border-color:rgba(var(--gold-rgb),.7)}
@media (prefers-reduced-motion:reduce){ .gs-hit-conf{animation:none} }
`;
