import { useState, useMemo, useRef, useEffect, Fragment } from "react";

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

/* 셋째 항목은 이름을 비워 둡니다 — 플레이스홀더가 "여기에 항목을 만드세요"를 말해 줍니다 */
/* 기본 항목 셋. 마지막은 룰렛입니다 — 비율은 안 적으면 기본 비율을 씁니다. */
const DEFAULT_COLS = [
  { id: "c1", name: "잡힘", price: "10,000" },
  { id: "c2", name: "죽음", price: "30,000" },
  { id: "c3", name: "죽음", price: "10,000", type: "roulette" },
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
  const ITEM = { c1: "잡힘", c2: "죽음", c3: "" };
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
const FILL_NAME = (k) => "(모험가" + k + ")";
/* 예전 이름들도 자리표시로 알아봐야 합니다 — 저장된 표를 열었을 때 그대로 남으면
   지우지도 못하고 진짜 이름처럼 굴러다닙니다. */
const isFillName = (s) => /^\((이름(입력|없음)|모험가)\d+\)$/.test(s || "");
/* 이름을 지운 줄은 화면에서 "모험가n" 으로 부릅니다 — n 은 표에서 몇 번째 줄인지.
   "이름 없음" 이 여럿이면 우편에서 누구한테 보내야 할지 알 수가 없습니다. */
const ANON = (i) => "모험가" + (i + 1);
const seatName = (row, i) => ((row && row.name) || "").trim() || ANON(i);
const noFine = (x) =>
  !(x.extras || []).length && Object.values(x.counts || {}).every((v) => !num(v));
/* 옛 규칙에서는 "(이름입력n) + 벌금 0" 행이 정산 인원에서 빠졌습니다. 그 행을 남긴 채
   이름만 비우면 인원수(n)가 늘어 예전 정산 금액이 바뀝니다. 그래서 이름을 실제로 넣어
   쓰던 표에서만 남은 자리표시 행을 지웁니다 — 그 표에서 그 행은 안 쓴 자리였으니까요.
   아무도 이름을 안 넣은 표는 아직 시작 안 한 표라, 줄을 그대로 두고 이름만 비웁니다.
   (여기서 지워 버리면 "이름은 아직, 벌금부터" 쓰던 표가 통째로 사라집니다.) */
const migrateRows = (rows) => {
  if (!Array.isArray(rows)) return rows;
  const named = rows.some((x) => (x.name || "").trim() && !isFillName(x.name));
  const kept = named ? rows.filter((x) => !(isFillName(x.name) && noFine(x))) : rows;
  /* 예전 자리표시는 새 이름으로 갈아 끼웁니다 — 안 그러면 예전에 만든 표에만
     "(이름입력3)" 이 남아 두 가지 이름이 섞여 보입니다. 뒤의 번호는 그대로 둡니다:
     그 번호가 줄을 가리키는 이름이라, 다시 매기면 지금까지 쓰던 호칭이 바뀝니다. */
  return kept.map((x) =>
    isFillName(x.name)
      ? { ...x, name: x.name.replace(/^\(이름(입력|없음)/, "(모험가") }
      : x
  );
};

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
const SPINS = {
  fast: { roll: 1200, hold: 700, end: 1100, label: "빠르게" },
  normal: { roll: 2200, hold: 1200, end: 1700, label: "보통" },
  slow: { roll: 3400, hold: 1700, end: 2200, label: "느리게" },
};
/* 기본은 느리게 — 방송은 뜸을 들여야 재미가 삽니다 */
const spinSpeed = (k) => SPINS[k] || SPINS.slow;
/* 속도와 돌아가는 모습은 룰렛 열마다가 아니라 한 번만 정합니다 — 열마다 다른 속도로
   돌 이유가 없고, 어차피 방송에 보이는 것이라 OBS · 외형 설정에 함께 둡니다. */
const spinSpd = (r) => ((r && r.spd) in SPINS ? r.spd : "slow");

/* 양도권이 나왔을 때 누가 무느냐 — 사람 원판을 한 번 더 돌리거나(랜덤, 기본),
   서기가 고르거나(지정). 랜덤일 때 돌린 사람도 후보에 넣는 게 기본입니다 —
   자기가 다시 걸릴 수 있어야 돌리는 맛이 삽니다. */
const passMode = (col) => ((col && col.passMode) === "pick" ? "pick" : "random");
const passSelf = (col) => (col && col.passSelf) !== false;

/* 돌아가는 모습 — 숫자만이 기본입니다. 원판은 고르면 씁니다 */
const spinShape = (r) => ((r && r.spinLook) === "wheel" ? "wheel" : "num");
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
/* #k=CODE — 열쇠를 나르는 링크. 6자면 5분짜리 일회용 이사 코드, 12자면 오래 보관하는
   복구 코드입니다. 코드를 손으로 옮겨 적는 대신 링크를 보냅니다. */
const HANDOFF_KEY = "k";
const handoffUrl = (c) =>
  window.location.origin + window.location.pathname + "#" + HANDOFF_KEY + "=" + c;
/* 붙여넣은 게 링크든 코드든 코드만 뽑아냅니다 — 링크가 깨져서 오는 일이 있습니다 */
const codeFromText = (t) => {
  /* 복구 코드는 4자씩 끊어 보여 줍니다 — 붙여넣을 때 붙임표·공백은 걷어냅니다 */
  const v = (t || "").trim().toUpperCase().replace(/[\s-]/g, "");
  const m = v.match(/(?:^|[#&])K=([A-Z0-9]{12}|[A-Z0-9]{6})/);
  return m ? m[1] : /^(?:[A-Z0-9]{12}|[A-Z0-9]{6})$/.test(v) ? v : "";
};
/* 예시 방 — 서버에 방이 없습니다. 앱이 예시 장부를 직접 비춰서, 실제 링크와 똑같이 동작합니다 */
const DEMO_ROOM = "CAFE22";

/* ================= OBS 중계 =================
   장부 관리자의 앱만 상태를 밀어 올리고, OBS와 뷰어는 읽기 전용으로 구독합니다.
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
const partyLedgerOf = (st) => ({
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

function loadPartyReg() {
  if (typeof window === "undefined") return null;
  try {
    const v = JSON.parse(window.localStorage.getItem(PARTY_REG_KEY) || "null");
    if (v && Array.isArray(v.list) && v.list.length && typeof v.active === "string") return v;
  } catch (e) {}
  return null;
}
function savePartyReg(reg) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(PARTY_REG_KEY, JSON.stringify(reg));
  } catch (e) {}
}
function loadPartySlot(name) {
  if (typeof window === "undefined") return null;
  try {
    const v = JSON.parse(window.localStorage.getItem(partySlotKey(name)) || "null");
    if (!v || !Array.isArray(v.rows) || !Array.isArray(v.cols)) return null;
    return { ...v, rows: migrateRows(v.rows) };
  } catch (e) {
    return null;
  }
}
function savePartySlot(name, data) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(partySlotKey(name), JSON.stringify(data));
  } catch (e) {}
}
function dropPartySlot(name) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(partySlotKey(name));
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
    window.localStorage.setItem(PRESETS_KEY, JSON.stringify(l));
  } catch (e) {}
};

function loadRelay() {
  if (typeof window === "undefined") return { on: false, rooms: {}, active: DEFAULT_ROOM_LABEL };
  try {
    const v = JSON.parse(window.localStorage.getItem(RELAY_KEY) || "null");
    if (!v || typeof v !== "object") throw 0;
    return {
      on: !!v.on,
      rooms: v.rooms && typeof v.rooms === "object" ? v.rooms : {},
      active: typeof v.active === "string" ? v.active : DEFAULT_ROOM_LABEL,
      /* 화면 취향들 — 여기서 안 받아 주면 새로고침마다 기본값으로 돌아갑니다 */
      ov: v.ov && typeof v.ov === "object" ? v.ov : undefined,
      spd: v.spd === "fast" || v.spd === "normal" || v.spd === "slow" ? v.spd : undefined,
      spinLook: v.spinLook === "num" || v.spinLook === "wheel" ? v.spinLook : undefined,
      wheelTheme: v.wheelTheme === "vegas" ? "vegas" : undefined,
      ovsrc: v.ovsrc === "split" ? "split" : undefined,
      rcode: typeof v.rcode === "string" ? v.rcode : undefined,
      look:
        v.look && typeof v.look === "object" && typeof v.look.t === "string"
          ? { t: v.look.t, alpha: [0, 25, 50, 75, 100].includes(v.look.alpha) ? v.look.alpha : 25 }
          : { t: "dark", alpha: 25 },
    };
  } catch (e) {
    return { on: false, rooms: {}, active: DEFAULT_ROOM_LABEL, look: { t: "dark", alpha: 25 } };
  }
}
function saveRelay(v) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(RELAY_KEY, JSON.stringify(v));
  } catch (e) {
    /* 저장 불가 환경 */
  }
}

const relayApi = {
  createRoom: () =>
    fetch(RELAY_BASE + "/api/rooms", { method: "POST" }).then((r) => {
      if (!r.ok) throw new Error("방을 만들지 못했어요");
      return r.json();
    }),
  push: (roomId, key, state) =>
    fetch(`${RELAY_BASE}/api/r/${roomId}/state`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key, state }),
    }),
  kill: (roomId, key) =>
    fetch(`${RELAY_BASE}/api/r/${roomId}/kill`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key }),
    }),
  handoffIssue: (bundle) =>
    fetch(RELAY_BASE + "/api/handoff", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(bundle),
    }).then((r) => {
      if (!r.ok) throw new Error("코드를 만들지 못했어요");
      return r.json();
    }),
  handoffClaim: (code) =>
    fetch(`${RELAY_BASE}/api/handoff/${code}`).then((r) => {
      if (r.status === 404) throw new Error("그런 코드가 없어요. 시간이 지났거나 이미 쓴 코드예요.");
      if (!r.ok) throw new Error("코드를 받지 못했어요");
      return r.json();
    }),
  /* 열쇠를 가진 기기가 방의 스냅샷을 통째로 읽습니다 — 복구·이어가기의 공통 기반 */
  readState: (roomId, key) =>
    fetch(`${RELAY_BASE}/api/r/${roomId}/read`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key }),
    }).then((r) => {
      if (r.status === 410) {
        const e = new Error("방이 만료됐거나 닫혀 있어요");
        e.gone = true;
        throw e;
      }
      if (!r.ok) throw new Error("장부를 읽지 못했어요");
      return r.json();
    }),
  recoveryIssue: (bundle) =>
    fetch(RELAY_BASE + "/api/recovery", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(bundle),
    }).then((r) => {
      if (!r.ok) throw new Error("코드를 만들지 못했어요");
      return r.json();
    }),
  recoveryClaim: (code) =>
    fetch(`${RELAY_BASE}/api/recovery/${code}`).then((r) => {
      if (r.status === 404)
        throw new Error("그런 코드가 없어요. 새로 발급됐거나 잘못 적혔을 수 있어요.");
      if (!r.ok) throw new Error("코드를 받지 못했어요");
      return r.json();
    }),
  recoveryRevoke: (code) =>
    fetch(RELAY_BASE + "/api/recovery/revoke", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code }),
    }).catch(() => {}),
  /* 직전 회차 한 장을 방에 보관 — 복구 코드 복원 때 함께 돌아옵니다 */
  archive: (roomId, key, state) =>
    fetch(`${RELAY_BASE}/api/r/${roomId}/archive`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key, state }),
    }),
  shareUrl: (roomId) => `${RELAY_BASE}/r/${roomId}`,
};

/* 뷰어로 들어왔는지 — #live=ROOMID */
function readLiveRoom() {
  const v = hashParams().get(LIVE_KEY) || "";
  return /^[ABCDEFGHJKMNPQRSTVWXYZ23456789]{6}$/.test(v) ? v : null;
}

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
  window.history.replaceState(null, "", `${pathname}${search}#${p.toString()}`);
}

/* ---------- 새로고침해도 남도록 브라우저에 저장 ---------- */
const STORE_KEY = "goldSettlement.v1";
/* 파티 카드에 적는 합계 — 정산과 같은 식으로 슬롯에서 바로 뽑습니다 */
/* 회차 라벨 — 기록 시간 범위로 부릅니다. 같은 날이면 날짜를 한 번만 적습니다 */
const fmtSpan = (from, to) => {
  const f = new Date(from);
  const t = new Date(to);
  const d = (x) => x.getMonth() + 1 + "/" + x.getDate();
  const hm = (x) =>
    String(x.getHours()).padStart(2, "0") + ":" + String(x.getMinutes()).padStart(2, "0");
  return d(f) + " " + hm(f) + " ~ " + (d(f) === d(t) ? "" : d(t) + " ") + hm(t);
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
    };
  } catch (e) {
    return null;
  }
}

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
    window.localStorage.setItem(STORE_KEY, JSON.stringify(state));
  } catch (e) {
    /* 용량 초과·차단된 환경이면 저장만 건너뜁니다 */
  }
}

/* 불러온 id 와 새로 만들 id 가 겹치지 않도록 카운터를 뒤로 밀어 둡니다 */
function nextSeq(data) {
  let m = 100;
  const scan = (id) => {
    const n = parseInt(String(id ?? "").replace(/^\D+/, ""), 10);
    if (Number.isFinite(n)) m = Math.max(m, n + 1);
  };
  data.cols.forEach((c) => scan(c.id));
  data.rows.forEach((x) => {
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
  const rest = p.toString();
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
       손대지 않고(저장도 안 하고), 장부 관리자가 밀어 주는 상태만 비춥니다. */
    const liveRoom = readLiveRoom();
    /* 단, 장부 관리자 본인이 자기 공유 주소를 열었다면 — 쓰기 열쇠가 이 브라우저에 있으니
       구경꾼 화면 대신 그 파티의 장부(입력 화면)로 들어갑니다 */
    const ownLabel = liveRoom
      ? (Object.entries(loadRelay().rooms).find(([, r]) => r.roomId === liveRoom) || [null])[0]
      : null;
    if (ownLabel) {
      const reg = loadPartyReg();
      if (reg && reg.list.some((x) => x.name === ownLabel)) {
        reg.active = ownLabel;
        savePartyReg(reg);
      }
      if (canOwnUrl && typeof window !== "undefined") {
        const hp = hashParams();
        hp.delete(LIVE_KEY);
        const { pathname, search } = window.location;
        const rest = hp.toString();
        window.history.replaceState(null, "", pathname + search + (rest ? "#" + rest : ""));
      }
    }
    if (liveRoom && !ownLabel) {
      boot.current = {
        cols: DEFAULT_COLS,
        rows: [],
        feePercent: "5",
        mode: "items",
        unit: "10000",
        seq: 1000,
        view: "tabs",
        tab: "sheet",
        theme: (loadSaved() || {}).theme || "system",
        firstVisit: false,
        liveRoom,
      };
    }
  }
  if (!boot.current) {
    const hashMode = readHashMode();
    const shared = readShared();
    const stored = loadSaved();
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
    if (!shared) {
      partyReg = loadPartyReg() || { list: [{ name: "기본", t: Date.now() }], active: "기본" };
      if (!partyReg.list.some((x) => x.name === partyReg.active))
        partyReg.active = partyReg.list[0].name;
      /* 진짜 첫 방문은 현자들(튜토리얼 파티)로 들어갑니다 — 빈 표 대신 채워진 예시에서
         해보기 코스가 바로 시작되고, 기본 파티는 빈 표로 대기합니다 */
      if (!stored && !hashMode && !partyReg.list.some((x) => x.name === EXAMPLE_PARTY)) {
        savePartySlot(partyReg.active, partyLedgerOf(data));
        savePartySlot(EXAMPLE_PARTY, {
          mode: "items",
          unit: "10000",
          cols: DEFAULT_COLS,
          rows: DEFAULT_ROWS,
          log: demoLog(),
          feePercent: "5",
          splitMode: "pot",
          memoFreeze: null,
          undoSnap: null,
        });
        partyReg.list.push({ name: EXAMPLE_PARTY, t: Date.now() });
        partyReg.active = EXAMPLE_PARTY;
      }
      const slot = loadPartySlot(partyReg.active);
      if (slot) Object.assign(data, slot);
      else savePartySlot(partyReg.active, partyLedgerOf(data));
      /* 단일 장부 전환 이주 — 활성이 아닌 옛 파티는 전부 「잠긴 지난 회차」가 됩니다.
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

    // 주소에 적힌 모드가 저장된 모드보다 우선합니다 (모드별 주소를 열었을 때)
    boot.current = {
      ...data,
      partyReg,
      mode: hashMode || data.mode || "simple",
      seq: nextSeq(data),
      view: stored ? stored.view : "tabs",
      tab: stored ? stored.tab : "sheet",
      // 화면 밝기 취향은 표와 무관하니 공유 링크로 들어와도 이 브라우저 것을 씁니다
      theme: stored ? stored.theme : "system",
      // 저장도, 공유 링크도 없는 진짜 첫 방문에만 모드 선택 화면을 띄웁니다
      firstVisit: !shared && !stored && !hashMode,
    };
  }

  /* 뷰어(읽기 전용)인지 — 이 값이 참이면 어떤 조작도 상태를 바꾸지 못합니다 */
  const liveRoom = boot.current.liveRoom || null;
  /* 지난 회차 보기 — 읽기 전용. 회차는 들춰보는 것이고, 장부는 쓰는 것입니다 */
  const [genView, setGenView] = useState(null);
  const readOnly = !!liveRoom || !!genView;
  const [liveState, setLiveState] = useState(readOnly ? "connecting" : null); // connecting|on|empty|dead
  const [liveName, setLiveName] = useState("");
  const [liveTick, setLiveTick] = useState(0);   // 갱신이 올 때마다 +1 — 점이 깜빡입니다
  const [roPulse, setRoPulse] = useState(0);     // 뷰어가 뭘 누르면 배너가 한 번 꿈틀합니다
  /* 알림 한 줄. 룰렛을 우클릭했을 때처럼 "왜 안 되는지"를 그 자리에서 알려 줍니다 */
  const [toast, setToast] = useState(null);      // {t, msg}
  /* msg 는 글자여도 되고 조각(JSX)이어도 됩니다 — 안에 누를 것을 넣을 때가 있습니다 */
  const say = (msg) => setToast({ t: Date.now(), msg });

  const [cols, setCols] = useState(boot.current.cols);
  const [rows, setRows] = useState(boot.current.rows);
  const [feePercent, setFeePercent] = useState(boot.current.feePercent);
  // 정산 방식도 수수료처럼 파티 장부에 붙어 다닙니다
  const [splitMode, setSplitMode] = useState(boot.current.splitMode === "solo" ? "solo" : "pot");
  const [showSplitHelp, setShowSplitHelp] = useState(false);
  /* 코치마크 진행 상태 — {kind:"course",step} | {kind:"obs"} | {kind:"hint"} */
  const [coach, setCoach] = useState(null);
  const obsCoachPending = useRef(false);

  const coachRef = useRef(null);
  coachRef.current = coach;

  /* 코스 진행 — 해당 조작이 실제로 일어났을 때만 다음으로 */
  const courseHit = (what) => {
    const c = coachRef.current;
    if (!c || c.kind !== "course") return;
    const want = ["press", "unpress", "ledger", "mail", "obs"][c.step];
    if (what !== want) return;
    setCoach({ kind: "course", step: c.step + 1 }); // 5·6걸음은 버튼으로 넘깁니다
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
  const [showHelp, setShowHelp] = useState(false);
  const [showHub, setShowHub] = useState(false);
  /* 보기 방식 — 탭(한 카드만 크게, 방송용)과 세로(세 카드를 이어서). */
  const [view, setView] = useState(boot.current.view);
  const [tab, setTab] = useState(boot.current.tab);
  /* 기록 — 카운터의 ＋·직접 수정이 델타로 한 줄씩 쌓입니다. 영수증이지 원본이 아니라서
     정산·공유는 이 목록을 보지 않습니다. 취소는 줄을 지우지 않고 반대 기록을 덧붙입니다(역분개). */
  const [log, setLog] = useState(boot.current.log || []);
  const [showLog, setShowLog] = useState(false);
  /* 기록 모달의 사람 필터 — 이름 칸의 '기록'으로 들어오면 그 사람 것만 봅니다.
     벌금 시비는 사람 단위로 붙어서, 전체 로그를 훑는 것보다 이쪽이 빠릅니다. */
  const [logRow, setLogRow] = useState(null);
  /* 기타 — 셀에서 숫자만 치고 바로 등록. 사유는 선택이라 밑줄 버튼 → 작은 창으로 뺍니다. */
  const [discRow, setDiscRow] = useState(null);
  const [discAsk, setDiscAsk] = useState(null);
  /* 치던 숫자는 사람별로 부모가 들고 있습니다 — 다른 행에 갔다 와도 안 날아가게 */
  const [discDraft, setDiscDraft] = useState({});
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
  /* 첫 방문 — 모드를 고르고 시작합니다. 한 번 저장되면 다시 안 나옵니다. */
  /* 모드 선택 화면 — "first"는 첫 방문 관문(닫을 수 없음), "guide"는 나중에 다시 열어 본 것 */
  // 모드 안내는 첫 화면이 아니라 '자세히 보기'로만 엽니다 — 첫 안내는 코치마크가 맡습니다
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
  const showSheet = !tabbed || tab === "sheet";
  const showLedger = !tabbed || tab === "ledger";
  const showMail = !tabbed || tab === "mail";
  const pickTab = (k) => {
    setTab(k);
    window.scrollTo(0, 0);
    if (k === "ledger") courseHit("ledger");
    if (k === "mail") courseHit("mail");
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

  const changeMode = (next) => {
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
      seq.current = Math.max(seq.current, nextSeq(shared));
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
     장부 관리자가 판 전체를 한 번에 보내 주므로, 여기서도 제 시계로 돌립니다.
     오버레이와 같은 속도로 맞춰서, 방송과 파티원 화면이 따로 놀지 않게 합니다. */
  /* 파티원 화면도 그 판의 속도를 그대로 씁니다 — 방송과 따로 놀지 않게 */
  const [vplay, setVplay] = useState(null); // {sp, i, rolling, over}
  const [vin, setVin] = useState(null); // 마지막으로 받은 판 (없으면 서기 쪽이 끝난 것)
  const vpend = useRef(null); // 도는 동안 도착한 표 (끝나고 반영)

  /* ================= OBS 중계 ================= */
  const [relay, setRelay] = useState(loadRelay);
  const [obsOpen, setObsOpen] = useState(false);
  const [keyOpen, setKeyOpen] = useState(false);

  /* ---- 파티: 파티 하나 = 장부 하나 = 공유 주소 하나 ---- */
  const [partyReg, setPartyReg] = useState(
    boot.current.partyReg || { list: [{ name: "기본", t: 0 }], active: "기본" }
  );
  const [partyDD, setPartyDD] = useState(false);
  const [lobby, setLobby] = useState(false); // (로비 화면은 폐지 — 렌더 안 함)
  const [lookOpen, setLookOpen] = useState(false); // 외형 창
  const [resetOpen, setResetOpen] = useState(false); // 처음부터 창
  const [presets, setPresets] = useState(loadPresets);
  const savePresetNow = (name) => {
    const nm = (name || "").trim();
    if (!nm) return false;
    const entry = {
      name: nm,
      cols,
      unit,
      feePercent,
      names: rows.map((r) => r.name),
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
    partyLedgerOf({ mode, unit, cols, rows, log, feePercent, splitMode, memoFreeze, undoSnap });
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
      nextSeq({ cols: slot.cols, rows: slot.rows, log: slot.log || [], memoFreeze: slot.memoFreeze })
    );
    setOpenRow(null);
    clearHash();
  };
  const switchParty = (name) => {
    if (readOnly || name === partyReg.active) return;
    savePartySlot(partyReg.active, currentLedger());
    applyLedger(loadPartySlot(name) || blankPartyLedger());
    putPartyReg({
      list: partyReg.list.map((x) => (x.name === name ? { ...x, t: Date.now() } : x)),
      active: name,
    });
  };
  const createParty = (name, size = 8) => {
    const nm = (name || "").trim();
    if (readOnly || !nm || partyReg.list.some((x) => x.name === nm)) return false;
    savePartySlot(partyReg.active, currentLedger());
    const led = blankPartyLedger(size);
    savePartySlot(nm, led);
    applyLedger(led);
    putPartyReg({ list: [...partyReg.list, { name: nm, t: Date.now() }], active: nm });
    /* 첫 파티 — 파티에 공유 주소가 붙는다는 걸 이 순간 한 번 보여줍니다 */
    if (!coachSeen("obsScribe")) {
      obsCoachPending.current = true;
      setTimeout(() => setObsOpen(true), 400);
    }
    return true;
  };
  /* ---------- 복구·이어가기 — 서버 스냅샷을 파티로 앉힙니다 ---------- */
  const uniquePartyName = (base) => {
    const root = (base || "").trim() || "불러온 파티";
    if (!partyReg.list.some((x) => x.name === root)) return root;
    for (let i = 2; i < 99; i++) {
      const c = root + " (" + i + ")";
      if (!partyReg.list.some((x) => x.name === c)) return c;
    }
    return root + " " + Date.now();
  };
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
  /* 링크(6자)든 복구 코드(12자)든 같은 길: 방을 읽어 장부부터 앉히고, 그다음에야
     열쇠를 묶습니다 — 권한만 있고 장부는 빈 상태(빈 푸시로 방을 덮는 사고)를 봉쇄 */
  const seatFromBundle = async (got) => {
    const entries = Object.entries(got.rooms || {});
    const nextRooms = { ...relay.rooms };
    const seatedNames = [];
    const prevSeats = [];
    let refreshed = 0,
      gone = 0,
      failed = 0,
      firstName = null;
    for (const [label, bind] of entries) {
      if (!bind || !bind.roomId || !bind.key) continue;
      const bound = Object.keys(nextRooms).find(
        (nm) => nextRooms[nm] && nextRooms[nm].roomId === bind.roomId
      );
      if (bound) {
        /* 이미 이 방에 묶인 파티가 있음 — 데이터는 두고 열쇠만 새로 맞춥니다 */
        nextRooms[bound] = bind;
        refreshed++;
        continue;
      }
      let snap = null;
      try {
        snap = await relayApi.readState(bind.roomId, bind.key);
      } catch (e) {
        if (e && e.gone) gone++;
        else failed++;
        continue;
      }
      const led = ledgerFromSnapshot(snap && snap.state);
      if (!led) {
        failed++;
        continue;
      }
      const nm = uniquePartyName((snap.state && snap.state.name) || label);
      savePartySlot(nm, led);
      nextRooms[nm] = bind;
      seatedNames.push(nm);
      if (!firstName) firstName = nm;
      /* 방에 남은 직전 회차 한 장도 같이 — 잠기지 않은 지난 회차로 */
      const pled = ledgerFromSnapshot(snap && snap.prev);
      if (pled) {
        const pts = (pled.log || []).map((e) => e.t).filter(Boolean);
        const pname = uniquePartyName(
          pts.length ? fmtSpan(Math.min(...pts), Math.max(...pts)) : nm + " 직전 회차"
        );
        savePartySlot(pname, pled);
        prevSeats.push({
          name: pname,
          t: Date.now() - 1,
          gen: true,
          locked: false,
          gold: slotGold(pled),
          from: pts.length ? Math.min(...pts) : undefined,
          to: pts.length ? Math.max(...pts) : undefined,
        });
      }
    }
    if (seatedNames.length || refreshed) {
      if (seatedNames.length) {
        /* 교대 — 지금 장부는 지난 회차로 닫히고, 첫 복원분이 현재가 됩니다.
           나머지 복원분과 직전 회차는 지난 회차로 나란히 놓입니다. */
        const old = partyReg.active;
        const oldLed = currentLedger();
        let folded = foldIntoGens(oldLed, partyReg.list);
        folded = folded.filter((x) => x.name !== old);
        delete nextRooms[old];
        /* 활성 장부의 이름은 항상 '기본' */
        savePartySlot(DEFAULT_ROOM_LABEL, loadPartySlot(firstName));
        if (firstName !== DEFAULT_ROOM_LABEL) {
          dropPartySlot(firstName);
          nextRooms[DEFAULT_ROOM_LABEL] = nextRooms[firstName];
          delete nextRooms[firstName];
        }
        putPartyReg({
          list: [
            ...folded,
            ...prevSeats,
            ...seatedNames
              .filter((nm) => nm !== firstName)
              .map((nm) => ({
                name: nm,
                t: Date.now(),
                gen: true,
                locked: true,
                gold: slotGold(loadPartySlot(nm)),
              })),
            { name: DEFAULT_ROOM_LABEL, t: Date.now() },
          ],
          active: DEFAULT_ROOM_LABEL,
        });
        if (old !== DEFAULT_ROOM_LABEL) dropPartySlot(old);
        applyLedger(loadPartySlot(DEFAULT_ROOM_LABEL) || blankPartyLedger());
      }
      putRelay({
        ...relay,
        on: got.on != null ? !!got.on : relay.on,
        rooms: nextRooms,
        active: got.active || relay.active,
        look: got.look || relay.look,
        spd: got.spd || relay.spd,
        spinLook: got.spinLook || relay.spinLook,
        wheelTheme: got.wheelTheme || relay.wheelTheme,
      });
    }
    return { seated: seatedNames.length, refreshed, gone, failed, firstName };
  };
  const seatMsg = (r) => {
    if (r.seated)
      return "'" + r.firstName + "' 장부를 그대로 이어받았어요 — 기록 권한도 함께요.";
    if (r.refreshed) return "이미 연결돼 있던 파티예요 — 열쇠만 새로 맞췄어요.";
    if (r.gone) return "방이 만료됐거나 닫혀 있어요. 새 코드가 필요해요.";
    return "장부를 가져오지 못했어요. 인터넷을 확인하고 다시 시도해 주세요.";
  };
  /* ---------- 파일 백업 — 서버 수명과 무관하게 남는 층 ---------- */
  const exportPartyFile = () => {
    const data = { app: "gold-settlement", v: 1, name: partyReg.active, ledger: currentLedger() };
    const d = new Date();
    const stamp =
      d.getFullYear() +
      "-" +
      String(d.getMonth() + 1).padStart(2, "0") +
      "-" +
      String(d.getDate()).padStart(2, "0");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: "application/json" }));
    a.download = ("벌금표-" + stamp + ".json").replace(/[\\/:*?"<>|]/g, "-");
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  };
  const importPartyFile = (text) => {
    let data = null;
    try {
      data = JSON.parse(text);
    } catch (e) {
      return "파일을 읽지 못했어요 — 벌금표에서 내보낸 파일이 맞는지 확인해 주세요.";
    }
    const led = data && data.ledger;
    if (!led || !Array.isArray(led.cols) || !Array.isArray(led.rows))
      return "파일을 읽지 못했어요 — 벌금표에서 내보낸 파일이 맞는지 확인해 주세요.";
    /* 교대 — 지금 장부는 지난 회차로 닫히고, 불러온 것이 현재(이름은 늘 '기본')가 됩니다 */
    const old = partyReg.active;
    const oldLed = currentLedger();
    let list = foldIntoGens(oldLed, partyReg.list);
    list = list.filter((x) => x.name !== old);
    savePartySlot(DEFAULT_ROOM_LABEL, { ...led, rows: migrateRows(led.rows), undoSnap: null });
    if (old !== DEFAULT_ROOM_LABEL) dropPartySlot(old);
    putPartyReg({
      list: [...list, { name: DEFAULT_ROOM_LABEL, t: Date.now() }],
      active: DEFAULT_ROOM_LABEL,
    });
    const rooms = { ...relay.rooms };
    const cur = rooms[old];
    delete rooms[old];
    if (cur) rooms[DEFAULT_ROOM_LABEL] = cur;
    putRelay({ ...relay, rooms });
    applyLedger(loadPartySlot(DEFAULT_ROOM_LABEL) || blankPartyLedger());
    return "백업 파일을 현재 장부로 불러왔어요 — 이전 장부는 지난 회차로 남았어요.";
  };
  const askDeleteParty = (name) =>
    setAsk({
      title: `'${name}' 파티를 지울까요?`,
      body: "이 파티의 표와 기록, 공유 주소가 함께 사라져요. 되돌릴 수 없어요.",
      action: "지우기",
      onYes: () => {
        const rest = partyReg.list.filter((x) => x.name !== name);
        if (!rest.length) return;
        dropPartySlot(name);
        const room = relay.rooms[name];
        if (room) relayApi.kill(room.roomId, room.key).catch(() => {});
        const rooms = { ...relay.rooms };
        delete rooms[name];
        putRelay({ ...relay, rooms });
        if (name === partyReg.active) {
          applyLedger(loadPartySlot(rest[0].name) || blankPartyLedger());
          putPartyReg({ list: rest, active: rest[0].name });
        } else {
          putPartyReg({ ...partyReg, list: rest });
        }
      },
    });
  const putRelay = (next) => {
    setRelay(next);
    saveRelay(next);
  };
  /* 열 켜고 끄기는 연달아 누를 수 있어서, 늘 최신 값에서 뒤집습니다.
     { ...relay } 를 쓰면 같은 틱의 앞 토글이 덮여 사라집니다. */
  const toggleOvCol = (key) =>
    setRelay((prev) => {
      const ov = { ...(prev.ov || {}) };
      /* 항목은 켬이 기본이라 !== false 로, 순액은 끔이 기본이라 === true 로 읽습니다 */
      const on = ov[key] !== false;
      ov[key] = !on;
      const next = { ...prev, ov };
      saveRelay(next);
      return next;
    });
  /* 지금 어느 명단으로 나가는지 — 프리셋을 불러오면 그 이름, 아니면 '기본' */
  /* 파티 이름 바꾸기 — 이름이 곧 저장 열쇠라서, 장부와 공유 방을 새 이름으로 옮겨 답니다.
     현자들을 개명하면 보통 파티가 되고, 로비에 예시 만들기 카드가 다시 나타납니다. */
  const renameParty = (oldName, newName) => {
    const nm = (newName || "").trim();
    if (readOnly || !nm || nm === oldName || partyReg.list.some((x) => x.name === nm)) return false;
    const slot = loadPartySlot(oldName);
    if (slot) savePartySlot(nm, slot);
    dropPartySlot(oldName);
    if (relay.rooms[oldName]) {
      const rooms = { ...relay.rooms, [nm]: relay.rooms[oldName] };
      delete rooms[oldName];
      putRelay({ ...relay, rooms });
    }
    putPartyReg({
      list: partyReg.list.map((x) => (x.name === oldName ? { ...x, name: nm } : x)),
      active: partyReg.active === oldName ? nm : partyReg.active,
    });
    return true;
  };

  /* 해보기 코스 — 예시 파티에 처음 들어오면 시작합니다. 코치는 동시에 하나만 */
  useEffect(() => {
    if (readOnly || partyReg.active !== EXAMPLE_PARTY || coachSeen("course")) return;
    const t = setTimeout(() => {
      const cur = coachRef.current;
      if (!cur || cur.kind === "hint") {
        pickTab("sheet"); // 1단계 대상(칸)이 벌금표에 있습니다 — 다른 탭이면 시작부터 죽어요
        setCoach({ kind: "course", step: 0 });
      }
    }, 700);
    return () => clearTimeout(t);
  }, [partyReg.active]);

  /* 예시 파티 — 예시 표·기록이 든 파티를 만들어 그리로 갑니다.
     지금 표를 안 덮으니 확인창이 필요 없고, 다 보면 파티째 지우면 됩니다. */
  const openExampleParty = () => {
    if (readOnly) return;
    if (partyReg.list.some((x) => x.name === EXAMPLE_PARTY)) return switchParty(EXAMPLE_PARTY);
    savePartySlot(partyReg.active, currentLedger());
    const led = {
      mode: "items", // 새 파티 기본과 같게 — 예시도 카운터로 엽니다
      unit: "10000", // 예시 금액은 만G 기준으로 설계돼 있습니다
      cols: DEFAULT_COLS,
      rows: DEFAULT_ROWS,
      log: demoLog(),
      feePercent: "5",
      splitMode: "pot",
      memoFreeze: null,
      undoSnap: null,
    };
    savePartySlot(EXAMPLE_PARTY, led);
    applyLedger(led);
    putPartyReg({
      list: [...partyReg.list, { name: EXAMPLE_PARTY, t: Date.now() }],
      active: EXAMPLE_PARTY,
    });
  };

  // 고칠 때마다 저장해 두면 새로고침해도 그대로 돌아옵니다
  useEffect(() => {
    // 첫 선택 전엔 저장하지 않습니다 — 선택 없이 새로고침하면 선택 화면이 다시 나오게
    if (intro === "first") return;
    // 뷰어는 남의 장부를 비추는 중이라, 이 브라우저에 저장하면 내 장부를 덮어씁니다
    if (readOnly) return;
    savePartySlot(partyReg.active, partyLedgerOf({ mode, unit, cols, rows, log, feePercent, splitMode, memoFreeze, undoSnap }));
    saveState({
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
    });
  }, [cols, rows, feePercent, splitMode, mode, unit, memoFont, view, tab, log, undoSnap, memoFreeze, theme, intro, readOnly, partyReg.active]);

  const roomOf = (label) => relay.rooms[label] || null;
  const activeRoom = roomOf(partyReg.active);

  useEffect(() => {
    // 방을 이미 만들어 본 사람은 OBS 공유를 아는 사람입니다
    if (!readOnly && Object.keys(relay.rooms || {}).length) coachDone("obsScribe");
  }, []);

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
      g: Math.max(0, boardGold(x)),
      /* 항목별 횟수. 이름은 위(cols)에 한 번만 적고 여기는 순서대로 숫자만 —
         오버레이가 표처럼 열을 맞춰 그립니다. 메모장 모드는 항목이 하나뿐이라 안 보냅니다 */
      c: simple || !ovShow().items ? [] : activeCols.map((col) => num(x.counts[col.id])),
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
      /* 랜덤 양도면 사람 원판도 같이 — 방송과 파티원 화면이 같은 장면을 봅니다 */
      pass2: spin.pass2 ? { faces: spin.pass2.faces, name: spin.pass2.name } : null,
      steps: spin.steps.map((x) => ({ k: x.k, m: x.mult })),
      n: spin.res.n,
      gold: Math.round(spin.priceG * spin.res.count),
      pass: !!spin.res.pass,
      phase: spin.phase,
      /* 적용 결과 — 오버레이가 표 도착을 기다리지 않고 수식·벌금 변화를 그립니다.
         (표 푸시는 재생 종료와 경합할 수 있어서 믿을 시계가 못 됩니다) */
      out: spin.out
        ? { g: spin.out.gold, raw: spin.out.raw, after: spin.out.after, name: spin.out.name }
        : null,
    };
  };

  /* 오버레이 생김새 — 상태에 실어 보내면 파라미터 없는 기본 주소의 OBS가 즉시 갈아입습니다.
     주소에 테마를 직접 적은 쪽(공유 받은 방송인)은 그 파라미터가 우선이라 영향이 없습니다. */
  /* 방송에 띄울 열 — 항목 횟수는 한 덩어리로 켜고 끕니다(하나씩 고르면 방송마다
     열이 달라져 시청자가 헷갈립니다). 순위·변동·이름·금액은 늘 나옵니다. */
  const ovShow = () => ({
    items: (relay.ov || {}).items !== false,
    /* 순액은 켜고 싶은 사람만 켭니다 — 기본 화면은 벌금만 보여 주는 게 단순합니다 */
    net: (relay.ov || {}).net !== false,
  });
  const lookOut = () => {
    const lk = relay.look || { t: "dark", alpha: 25 };
    return isPanelLook(lk) ? { t: lk.t, bg: 100 - (lk.alpha ?? 25) } : { t: lk.t };
  };

  /* 뷰어가 그대로 3탭을 그릴 수 있도록 표 전체를 보냅니다 (기록은 뺍니다) */
  const liveSnapshot = () => ({
    v: 1,
    name: partyReg.active === DEFAULT_ROOM_LABEL ? "벌금 현황판" : partyReg.active,
    board: boardOf(),
    /* 오버레이 표의 열 머리 */
    cols: simple || !ovShow().items
      ? []
      : activeCols.map((c) => ({
          t: (c.name || "").trim() || "항목",
          r: isRoulette(c) ? 1 : 0,
        })),
    ovNet: ovShow().net,
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
    },
    look: lookOut(),
    t: Date.now(),
  });

  /* --- 장부 관리자: 바뀔 때마다 밀어 올립니다 (디바운스 300ms) --- */
  const pushTimer = useRef(null);
  const pushRef = useRef(null);
  pushRef.current = liveSnapshot;
  useEffect(() => {
    if (readOnly || !relay.on || !activeRoom) return;
    clearTimeout(pushTimer.current);
    pushTimer.current = setTimeout(() => {
      relayApi
        .push(activeRoom.roomId, activeRoom.key, pushRef.current())
        .catch(() => {
          /* 인터넷이 끊겨도 기록은 계속됩니다. 다음 변경 때 다시 시도합니다. */
        });
    }, 300);
    return () => clearTimeout(pushTimer.current);
  }, [readOnly, relay.on, activeRoom && activeRoom.roomId, cols, rows, feePercent, unit, splitMode, relay.look, relay.ov, partyReg.active,
      /* 룰렛은 판이 시작·끝날 때, 양도 대기로 바뀔 때, 그리고 적용 결과(out)가 생길 때.
         out 을 안 걸면 종료 푸시에 합쳐져 오버레이 재생이 끝난 뒤에야 도착합니다. */
      spin && spin.sid, spin && spin.phase, spin && !!spin.out, !spin]);

  /* 주소 새로 발급 — 새 방을 파고, 옛 방은 닫습니다. 되돌릴 수 없어서 한 번 물어봅니다 */
  const obsReissue = async () => {
    const label = partyReg.active;
    const old = relay.rooms[label];
    try {
      const r = await relayApi.createRoom();
      putRelay({
        ...relay,
        on: true,
        rooms: { ...relay.rooms, [label]: { roomId: r.roomId, key: r.key } },
      });
      relayApi.push(r.roomId, r.key, pushRef.current()).catch(() => {});
      if (old) relayApi.kill(old.roomId, old.key).catch(() => {});
    } catch (e) {
      /* 실패해도 옛 방은 그대로 — 모달에서 다시 시도하면 됩니다 */
    }
  };
  /* 끄기는 방송에 바로 티가 나는 일이라 한 번 물어봅니다. 켜기는 그냥 켜집니다. */
  const shareOff = () =>
    setRelay((prev) => {
      const next = { ...prev, on: false };
      saveRelay(next);
      return next;
    });
  const askShareOff = () =>
    setAsk({
      title: "공유를 끌까요?",
      body: "끄면 지금부터의 기록이 OBS와 파티원 화면에 반영되지 않아요. 마지막으로 보낸 상태는 화면에 남아 있어요.",
      action: "끄기",
      onYes: shareOff,
    });
  const askObsReissue = () =>
    setAsk({
      title: "주소를 새로 발급할까요?",
      body: "지금 주소는 바로 못 쓰게 돼요. 파티원들에게 새 주소를 다시 보내야 해요.",
      action: "새로 발급",
      onYes: obsReissue,
    });

  /* --- 예시 방: 서버에 붙지 않고 예시 장부를 비춥니다. 몇 초마다 벌금이 붙어서
         장부와 우편이 실제로 다시 계산되는 것까지 보여 줍니다 --- */
  useEffect(() => {
    if (!readOnly || liveRoom !== DEMO_ROOM) return;
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

  /* 효과 안에서 최신 재생 상태를 읽어야 해서 거울을 둡니다 */
  const vplayRef = useRef(null);
  vplayRef.current = vplay;
  /* 한 걸음씩 굴립니다 — 오버레이와 같은 흐름입니다 */
  useEffect(() => {
    if (!vplay) return;
    /* 양도 대기 중에는 여기서 아무것도 안 합니다 — 서기가 고를 때까지 띄워 둡니다 */
    if (vplay.over && vplay.sp.phase === "pick" && !vplay.sp.pass2) return;
    const sp2 = spinSpeed(vplay.sp.spd);
    const ms = vplay.rolling || vplay.who === "roll" ? sp2.roll : vplay.over ? sp2.end : sp2.hold;
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
  }, [vplay && vplay.i, vplay && vplay.rolling, vplay && vplay.who, vplay && vplay.over, vplay && vplay.sp.phase, !vplay]);

  /* 서기가 양도를 끝내면(판이 사라지면) 파티원 화면도 잠깐 뒤 닫습니다 */
  useEffect(() => {
    if (!vplay || !vplay.over || vin) return;
    const t = setTimeout(() => setVplay(null), spinSpeed(vplay.sp.spd).end);
    return () => clearTimeout(t);
  }, [!vin, vplay && vplay.over]);

  /* 재생이 끝나면 미뤄 둔 표를 반영합니다 */
  useEffect(() => {
    if (vplay || !vpend.current) return;
    const st = vpend.current;
    vpend.current = null;
    setCols(st.full.cols || DEFAULT_COLS);
    setRows(st.full.rows || []);
    setFeePercent(st.full.feePercent || "5");
    setUnit(st.full.unit || "10000");
    setSplitMode(st.full.splitMode === "solo" ? "solo" : "pot");
    setLiveName(st.name || "");
    setLiveTick((t) => t + 1);
  }, [!vplay]);

  /* --- 뷰어: 구독해서 장부 관리자 화면을 그대로 비춥니다 --- */
  useEffect(() => {
    if (!readOnly || !liveRoom || liveRoom === DEMO_ROOM) return;
    let ws = null,
      beat = null,
      wait = 1000,
      stop = false;
    const paint = (st) => {
      setCols(st.full.cols || DEFAULT_COLS);
      setRows(st.full.rows || []);
      setFeePercent(st.full.feePercent || "5");
      setUnit(st.full.unit || "10000");
      setSplitMode(st.full.splitMode === "solo" ? "solo" : "pot");
      setLiveName(st.name || "");
      setLiveState("on");
      setLiveTick((t) => t + 1);
    };
    const apply = (st) => {
      if (!st || !st.full) return;
      /* 새 판이 왔으면 재생을 시작합니다 */
      const sp = st.spin || null;
      setVin(sp);
      if (sp) {
        setVplay((x) =>
          x && x.sp.sid === sp.sid ? { ...x, sp } : { sp, i: 0, rolling: true, over: false }
        );
      }
      /* 돌고 있는 중이면 표는 나중에 — 바늘이 멈추기 전에 숫자가 먼저 바뀌면
         파티원 화면에서도 답이 새어 나갑니다 */
      if (vplayRef.current) vpend.current = st;
      else { vpend.current = null; paint(st); }
    };
    const connect = () => {
      if (stop) return;
      try {
        ws = new WebSocket(
          RELAY_BASE.replace(/^http/, "ws") + "/api/r/" + liveRoom + "/live"
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
          if (m.kind === "dead") setLiveState("dead");
          else if (m.kind === "state") {
            if (m.state) apply(m.state);
            else setLiveState("empty");
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
  }, [readOnly, liveRoom]);

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
      nextSeq({ cols: undoSnap.cols, rows: undoSnap.rows, log: undoSnap.log })
    );
    setOpenRow(null);
    setMemoFreeze(null); // 표가 스냅샷 시점으로 바뀌므로 동결도 무효
    setUndoSnap(null);
  };

  // 모드마다 주소가 달라지도록 (#m=items / #m=simple)
  useEffect(() => {
    // 첫 선택 전엔 주소도 건드리지 않습니다 — 해시가 생기면 첫 방문 판정이 깨집니다
    if (intro === "first") return;
    syncHashMode(mode);
  }, [mode, intro]);

  // 주소를 직접 고치거나 뒤로가기를 눌러도 모드가 따라오게
  useEffect(() => {
    const onHash = () => {
      const m = readHashMode();
      if (m) changeMode(m);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  });

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

  /* 행 조작 */
  const patchRow = (id, key, value) =>
    readOnly ? undefined :
    setRows((prev) => prev.map((x) => (x.id === id ? { ...x, [key]: value } : x)));
  const patchCount = (id, colId, value) => {
    if (readOnly) return;
    const capped = num(value) > MAX_COUNT ? formatNumInput(String(MAX_COUNT)) : value;
    setRows((prev) =>
      prev.map((x) => (x.id === id ? { ...x, counts: { ...x.counts, [colId]: capped } } : x))
    );
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
  const ROLL_MS = spd.roll;
  const HOLD_MS = spd.hold;
  const END_MS = spd.end;

  const startSpin = (row, col) => {
    if (readOnly || spin) return;
    if (!canSpin(col)) return say(NO_NUM_MSG);
    const res = spinRoulette(weightsOf(col), null, liveFaces(col));
    /* 랜덤 양도면 누가 물지도 지금 정해 둡니다 — 화면은 그걸 보여 주기만 합니다.
       이름이 겹치면 원판의 칸을 구분할 수 없어서 뒤에 번호를 붙입니다. */
    let pass2 = null;
    if (res.pass && passMode(col) === "random") {
      const cands = rows.filter((x) => passSelf(col) || x.id !== row.id);
      if (cands.length) {
        const seen = {};
        const faces = cands.map((x) => {
          const base = seatName(x, rows.indexOf(x));
          seen[base] = (seen[base] || 0) + 1;
          return seen[base] > 1 ? base + " " + seen[base] : base;
        });
        const k = Math.floor(Math.random() * cands.length);
        pass2 = { faces, idx: k, rowId: cands[k].id, name: faces[k] };
      }
    }
    setSpin({
      pass2,
      sid: "s" + seq.current++, // 오버레이가 새 판인지 알아보는 표
      faces: liveFaces(col),
      w: weightsOf(col),
      look: spinShape(relay),
      theme: wheelTheme(relay),
      spd: spinSpd(relay),
      rowId: row.id,
      colId: col.id,
      who: seatName(row, rows.indexOf(row)),
      item: col.name,
      priceG: Math.round(goldOf(col.price)),
      steps: res.steps,
      i: 0,
      rolling: true,
      tick: 0,
      res,
      phase: "roll",
    });
  };

  /* 도는 동안 면이 빠르게 바뀝니다 */
  useEffect(() => {
    /* 숫자 판이 돌 때와 사람 릴이 돌 때 둘 다 시계가 필요합니다 */
    const ticking =
      spin &&
      ((spin.phase === "roll" && spin.rolling) ||
        (spin.phase === "who" && spin.whoRolling));
    if (!ticking) return;
    const t = setInterval(
      () =>
        setSpin((x) =>
          x && (x.rolling || x.whoRolling) ? { ...x, tick: x.tick + 1 } : x
        ),
      70
    );
    return () => clearInterval(t);
  }, [spin && spin.phase, spin && spin.rolling, spin && spin.whoRolling, spin && spin.i]);

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
        if (x.i + 1 < x.steps.length) return { ...x, i: x.i + 1, rolling: true };
        if (!x.res.pass) return { ...x, phase: "done" };
        /* 랜덤이면 사람 원판을 한 번 더 돌립니다 */
        return x.pass2
          ? { ...x, phase: "who", whoRolling: true }
          : { ...x, phase: "pick" };
      });
    }, HOLD_MS);
    return () => clearTimeout(t);
  }, [spin && spin.phase, spin && spin.rolling, spin && spin.i]);

  /* 사람 원판 — 한 바퀴 돌고 멈춘 뒤 그 사람에게 붙습니다 */
  useEffect(() => {
    if (!spin || spin.phase !== "who") return;
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
  }, [spin && spin.phase, spin && spin.whoRolling, spin && spin.skipped]);

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
      say(
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
        if (x.whoRolling) return { ...x, whoRolling: false, skipAt: "who" };
        /* 사람 원판이 마지막 판 — 멈춘 뒤의 클릭은 판을 끝냅니다 */
        return { ...x, phase: "done", target: x.pass2.rowId, fast: true };
      }
      if (x.phase !== "roll") return x;
      if (x.rolling) return { ...x, rolling: false, skipAt: x.i };
      if (x.i + 1 < x.steps.length)
        return { ...x, i: x.i + 1, rolling: true, skipAt: null };
      /* 마지막 숫자 판 — 양도가 남았으면 다음 룰렛, 아니면 판을 끝냅니다 */
      if (!x.res.pass) return { ...x, phase: "done", fast: true };
      return x.pass2
        ? { ...x, phase: "who", whoRolling: true, skipAt: null }
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
    if (readOnly) {
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
        say(
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
            (e) => e.kind === "press" && e.rowId === row.id && e.colId === col.id && e.n > 0 && !e.cancelled
          )
        : null;
    const gold = dir > 0 ? priceG : -(lastPress ? lastPress.delta : priceG);
    const after = liveTotal(row) + gold;
    live.current.n[row.id + ":" + col.id] = before + dir;
    live.current.total[row.id] = after;
    bump(row.id, col.id, dir, gold);
    const id = "L" + seq.current++;
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

  const addRow = () =>
    readOnly ? undefined :
    setRows((prev) => {
      const taken = new Set(prev.map((x) => x.name));
      let k = prev.length + 1;
      while (taken.has(FILL_NAME(k))) k++;
      return [
        ...prev,
        {
          id: "r" + seq.current++,
          name: FILL_NAME(k),
          counts: simple ? { [SIMPLE_ID]: "" } : {},
          extras: [],
        },
      ];
    });
  const delRow = (id) => {
    if (readOnly) return;
    const who = rows.find((x) => x.id === id);
    const nm = (who && who.name) || "이름 없는 인원";
    takeSnap("인원 삭제", `${nm}${josa(nm, "을", "를")} 지웠어요.`);
    setRows((prev) => prev.filter((x) => x.id !== id));
    setOpenRow((o) => (o === id ? null : o));
  };

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
      say("깎을 벌금이 없어요 — 감면은 지금 벌금까지만 깎여요.");
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
      say(
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
    say(man(-want) + " 중 벌금이 있는 " + man(-g) + "만 깎였어요 — 남은 몫은 사라져요.");
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
    const col = { id: "c" + seq.current++, name: "", price: "10,000" };
    if (type === "roulette") {
      col.type = "roulette";
      col.faces = ROULETTE_KEYS.slice();
      col.w = { ...ROULETTE_W };
    }
    setCols((prev) => [...prev, col]);
    setAddColOpen(false);
    if (type === "roulette") setRouletteCfg(col.id);
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
  /* ---------- 회차 — 처음부터 사이의 한 세션 ---------- */
  const GEN_KEEP = 5; // 잠금 안 한 지난 회차는 최근 5개만
  const genEntries = () => partyReg.list.filter((x) => x.gen);
  /* 지금 장부를 「지난 회차」로 닫습니다. 기록이 없으면 남길 것도 없습니다.
     넘치는 옛 회차(잠금 제외)는 목록·저장소에서 걷어냅니다. */
  const closeRound = () => {
    const before = partyReg.list;
    const list = foldIntoGens(currentLedger(), before);
    if (list === before) return null;
    putPartyReg({ list, active: partyReg.active });
    /* 서버에도 직전 회차 한 장 — 복구 코드로 새 기기에서 직전까지 살릴 수 있게 */
    if (activeRoom)
      relayApi.archive(activeRoom.roomId, activeRoom.key, liveSnapshot()).catch(() => {});
    return true;
  };
  /* 장부 하나를 지난 회차로 밀어 넣습니다 — 목록을 받아 갱신된 목록을 돌려줍니다 */
  const foldIntoGens = (led, list) => {
    const ts = ((led && led.log) || []).map((e) => e.t).filter(Boolean);
    if (!ts.length) return list;
    const label = uniquePartyName(fmtSpan(Math.min(...ts), Math.max(...ts)));
    savePartySlot(label, led);
    let out = [
      ...list,
      {
        name: label,
        t: Date.now(),
        gen: true,
        locked: false,
        from: Math.min(...ts),
        to: Math.max(...ts),
        gold: slotGold(led),
      },
    ];
    const loose = out.filter((x) => x.gen && !x.locked);
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
  const openGen = (name) => {
    const slot = loadPartySlot(name);
    if (!slot) return;
    savePartySlot(partyReg.active, currentLedger());
    applyLedger(slot);
    setGenView(name);
    setKeyOpen(false);
  };
  const closeGen = () => {
    applyLedger(loadPartySlot(partyReg.active) || blankPartyLedger());
    setGenView(null);
  };
  /* 복원 = 교대 — 지금 장부가 지난 회차로 닫히고, 보고 있던 회차가 현재가 됩니다.
     물러나는 항목은 목록에서 빠지고(회차 사본이 대신함), 방송 주소는 새 활성을 따라갑니다
     — 주소 영속: 링크가 바뀌는 유일한 순간은 여전히 '주소 새로 발급'뿐입니다. */
  const restoreGen = () => {
    const name = genView;
    if (!name) return;
    const old = partyReg.active;
    const oldLed = loadPartySlot(old); // openGen 때 저장해 둔, 물러나는 장부
    let list = foldIntoGens(oldLed, partyReg.list);
    list = list.filter((x) => x.name !== old && x.name !== name);
    /* 활성 장부의 이름은 항상 '기본' — 회차 라벨이 파일명·메시지로 새지 않게 */
    const led2 = loadPartySlot(name);
    savePartySlot(DEFAULT_ROOM_LABEL, led2);
    if (name !== DEFAULT_ROOM_LABEL) dropPartySlot(name);
    if (old !== DEFAULT_ROOM_LABEL) dropPartySlot(old);
    putPartyReg({
      list: [...list, { name: DEFAULT_ROOM_LABEL, t: Date.now() }],
      active: DEFAULT_ROOM_LABEL,
    });
    const rooms = { ...relay.rooms };
    const keep = rooms[old] || rooms[name]; /* 주소 영속 — 현 주소 우선, 없으면 유산 */
    delete rooms[old];
    delete rooms[name];
    if (keep) rooms[DEFAULT_ROOM_LABEL] = keep;
    putRelay({ ...relay, rooms });
    setGenView(null);
    say("'" + name + "' 회차를 현재 장부로 복원했어요 — 이전 장부는 지난 회차로 남았어요.");
  };
  const askRestoreGen = () =>
    setAsk({
      title: "이 회차를 현재 장부로 복원할까요?",
      body: "지금 장부는 지난 회차로 닫혀요. 사라지는 것은 없어요.",
      action: "복원",
      onYes: restoreGen,
    });

  /* 초기화 — keep: 이름·항목 남기고 비우기 / full: 전부 비우기(프리셋 시작 가능) */
  const clearAll = (kind, preset) => {
    if (readOnly) return;
    closeRound();
    const full = kind === "full" || isPristine(rows);
    takeSnap(
      "처음부터",
      full ? "전부 비우고 새로 시작했어요." : "이름과 항목은 그대로 두고 숫자만 비웠어요."
    );
    if (full) {
      const pc = preset && Array.isArray(preset.cols) ? preset.cols : DEFAULT_COLS;
      setCols(pc);
      if (preset && preset.unit) setUnit(preset.unit);
      if (preset && preset.feePercent) setFeePercent(preset.feePercent);
    }
    /* 줄 수는 그대로 둡니다 — 줄이 곧 인원이라, 여기서 늘리면 정산 인원이 바뀝니다. */
    setRows(() =>
      full
        ? Array.from(
            { length: preset && Array.isArray(preset.names) && preset.names.length ? preset.names.length : 8 },
            (_, i) => ({
              id: "r" + seq.current++,
              name:
                preset && Array.isArray(preset.names) && preset.names[i]
                  ? preset.names[i]
                  : FILL_NAME(i + 1),
              counts: simple ? { [SIMPLE_ID]: "" } : {},
              extras: [],
            })
          )
        : rows.map((x) => ({
            id: "r" + seq.current++,
            name: x.name,
            counts: simple ? { [SIMPLE_ID]: "" } : {},
            extras: [],
          }))
    );
    setOpenRow(null);
    setLog([]);
    setMemoFreeze(null);
    clearHash();
  };

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3600);
    return () => clearTimeout(t);
  }, [toast && toast.t]);

  /* 편집 권한 링크(#k=)로 들어온 경우 — 열쇠를 받아 이 브라우저에 붙입니다.
     주소에 남겨 두면 뒤로 가기나 재공유로 또 흘러다니니 바로 지웁니다. */
  const tookKey = useRef(false);
  useEffect(() => {
    if (tookKey.current || typeof window === "undefined") return;
    const c = (hashParams().get(HANDOFF_KEY) || "").toUpperCase();
    if (!c) return;
    tookKey.current = true;
    if (canOwnUrl) {
      const hp = hashParams();
      hp.delete(HANDOFF_KEY);
      const rest = hp.toString();
      window.history.replaceState(
        null,
        "",
        window.location.pathname + window.location.search + (rest ? "#" + rest : "")
      );
    }
    /* 6자면 일회용 이사 링크, 12자면 복구 코드 — 어느 쪽이든 장부부터 앉힙니다 */
    (c.length >= 10 ? relayApi.recoveryClaim(c) : relayApi.handoffClaim(c))
      .then((got) => seatFromBundle(got))
      .then((r) => say(seatMsg(r)))
      .catch(() =>
        say("만료됐거나 이미 쓴 링크예요. 원래 기기에서 새로 만들어 주세요.")
      );
  }, []);

  /* 되돌릴 수 없는 조작은 한 번 물어봅니다 */
  const askDelRow = (row) =>
    setAsk({
      title: "이 인원을 삭제할까요?",
      // 모드마다 실제로 사라지는 게 다릅니다
      body:
        `${row.name || "이름 없는 인원"} — ` +
        (simple
          ? "적어둔 금액과 메모장의 해당 줄이 함께 지워져요."
          : "횟수와 기타 벌금이 함께 지워져요."),
      onYes: () => delRow(row.id),
    });
  const askDelCol = (col) =>
    setAsk({
      title: "이 항목을 삭제할까요?",
      body: `${col.name || "이름 없는 항목"} 열과 모든 인원의 해당 횟수가 함께 지워져요.`,
      onYes: () => delCol(col.id),
    });
  const askDelExtra = (row, ex) =>
    setAsk({
      title: "이 기타 벌금을 삭제할까요?",
      body: `${G(goldOf(ex.amount))} · ${ex.reason || "사유 없음"}`,
      onYes: () => delExtra(row.id, ex.id),
    });
  const askClearAll = () =>
    setAsk({
      title: "처음부터 다시 할까요?",
      body:
        (partyReg.active === EXAMPLE_PARTY
          ? "여기는 예시 파티예요 — 실사용은 새 파티로 시작하는 게 좋아요. "
          : "") +
        (isPristine(rows)
          ? "예시 데이터를 치우고 빈 표로 시작해요."
          : "이름과 항목·단가는 그대로 두고, 숫자와 기록만 비워요."),
      action: "비우기",
      onYes: clearAll,
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

  return (
    <div className={"gs" + (tabbed ? " gs-tabbed" : "") + (dark ? " gs-dark" : "") + (picking ? " gs-picking" : "")}>
      <style>{CSS}</style>

      {/* ── 시스템 줄 — 뷰포트 맨 위에 딱 붙는 전폭 바. 안쪽 내용은 본문과 같은 열 ── */}
      <div className="gs-sysbar">
        <div className="gs-sysbar-in">
          <span className="gs-sysbrand">벌금 정산</span>
          <div className="gs-sysbar-r">
            {/* 방송 조작 — 어느 탭에 있든 항상 같은 자리 */}
            {!readOnly && (
              <span className="gs-tip">
                <button
                  className={"gs-btn gs-btn-ghost gs-obsbtn" + (relay.on ? " on" : "")}
                  onClick={() => {
                    courseHit("obs"); // 5걸음에서 진짜 버튼을 눌러도 진행됩니다
                    setObsOpen(true);
                  }}
                >
                  {/* 상태는 방이 생긴 뒤에만 — 시작도 안 했는데 중단이라 하면 헷갈립니다 */}
                  {activeRoom ? "OBS 공유 · " + (relay.on ? "공유 중" : "중단") : "OBS 공유"}
                  {activeRoom && (
                    <em className={relay.on ? "" : "off"} aria-hidden="true">●</em>
                  )}
                </button>
                <span className="gs-tip-body gs-tip-r" role="tooltip">
                  벌금 현황을 <b>방송 화면에 실시간으로</b> 띄워요. 주소 하나를 OBS 브라우저
                  소스에 넣으면 돼요.
                </span>
              </span>
            )}
            {/* 외형 — 브라우저 전역 취향 (오버레이 테마·룰렛 외형·속도·열 토글) */}
            {!readOnly && (
              <span className="gs-tip">
                <button className="gs-btn gs-btn-ghost gs-keybtn" onClick={() => setLookOpen(true)}>
                  <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
                    <g
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M8 1.8a6.2 6.2 0 1 0 0 12.4c1 0 1.4-.6 1.1-1.3-.3-.8 0-1.7 1-1.7h1.7c1.5 0 2.4-1 2.4-2.6C14.2 4.4 11.4 1.8 8 1.8Z" />
                      <circle cx="5" cy="6.2" r=".4" />
                      <circle cx="8.2" cy="4.6" r=".4" />
                      <circle cx="11.2" cy="6.4" r=".4" />
                      <circle cx="4.9" cy="9.6" r=".4" />
                    </g>
                  </svg>
                  외형
                </button>
                <span className="gs-tip-body gs-tip-r" role="tooltip">
                  벌금표와 방송 화면의 <b>테마·룰렛 외형</b>을 정해요.
                </span>
              </span>
            )}
            {/* 백업 — 지키고 살리는 전부: 복구 코드·받기·파일·지난 회차 */}
            {!readOnly && (
              <span className="gs-tip">
                <button className="gs-btn gs-btn-ghost gs-keybtn" onClick={() => setKeyOpen(true)}>
                  <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
                    <g
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M2.2 5h11.6M3 5v7.6a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V5M2.8 5l.9-2.2a1 1 0 0 1 .9-.6h6.8a1 1 0 0 1 .9.6L13.2 5" />
                      <path d="M8 7.4v4M6.3 9.8 8 11.4l1.7-1.6" />
                    </g>
                  </svg>
                  백업
                </button>
                <span className="gs-tip-body gs-tip-r" role="tooltip">
                  <b>복구 코드·파일 백업·지난 회차</b> — 지키고, 살리고, 들춰보는 곳이에요.
                </span>
              </span>
            )}

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
            <button
              className={"gs-qm" + (showHelp ? " gs-qm-on" : "")}
              onClick={() => setShowHelp(true)}
              aria-haspopup="dialog"
              aria-label="사용법 보기"
            >
              ?
            </button>
          </div>
        </div>
      </div>

      {genView && (
        <div className="gs-genbar" role="status">
          <b>지난 회차 보기</b> — {genView} · 수정은 안 돼요.
          <span className="gs-genbar-r">
            <button className="gs-btn gs-btn-sm" onClick={askRestoreGen}>
              현재 장부로 복원
            </button>
            <button className="gs-btn gs-btn-sm gs-btn-ghost" onClick={closeGen}>
              닫기
            </button>
          </span>
        </div>
      )}
      {/* ── 머리 ─────────────────────────────────────── */}
      <header className="gs-mast">
        <div className="gs-mastrow">
          {/* 제목 오른쪽에 모드 — '지금 무엇을 하는 중인가'가 제목과 한 줄에서 읽힙니다 */}
          {/* 앱 이름은 시스템 줄에 한 번만 — 여기는 탭이 자리를 잡는 줄입니다 */}
          <div className="gs-mastleft" />
          <div className="gs-mastside">
            {tabbed && (
              <nav className="gs-tabs" aria-label="화면 선택">
                {[
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
                    <span className="gs-tip-body" role="tooltip">
                      {t.tip}
                    </span>
                  </span>
                ))}
              </nav>
            )}
          </div>
        </div>
      </header>

      {/* ── 벌금표 ───────────────────────────────────── */}
      {showSheet && (
      <section className="gs-card">
        <div className="gs-cardhead">
          <div className="gs-headleft">
            <h2 className="gs-h2">벌금표</h2>
            {simple && <span className="gs-headnote">메모장이 오른쪽 표에 연동돼요</span>}
            {!simple && !readOnly && (
              <span className="gs-tip">
                <button
                  key={toast ? toast.t : 0}
                  className={
                    "gs-btn gs-btn-ghost" +
                    (showLog ? " gs-logbtn-on" : "") +
                    (toast ? " gs-logbtn-blink" : "")
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
                <span className="gs-tip-body gs-tip-modes" role="tooltip">
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
            {/* 파괴적인 둘은 자주 쓰는 버튼과 사이를 벌려 둡니다 (오클릭 방지) */}
            {!readOnly && (
            <span className="gs-grp gs-grp-risky">
              <span className="gs-tip">
                <button className="gs-btn gs-btn-ghost gs-btn-warn" onClick={() => setResetOpen(true)}>
                  처음부터
                </button>
                <span className="gs-tip-body gs-tip-r" role="tooltip">
                  이름과 항목은 유지하고 <b>숫자와 기록만</b> 비워요. 같은 멤버로 한 판 더 할 때 사용해요.
                </span>
              </span>
            </span>
            )}
          </div>
        </div>

        {readOnly && !genView && (
          <div
            key={roPulse}
            className={
              "gs-slip gs-slip-live" +
              (liveState === "dead" ? " gs-slip-dead" : "") +
              (roPulse ? " gs-slip-pulse" : "")
            }
            role="status"
          >
            <span className="gs-slip-msg">
              {liveState === "dead" ? (
                "이 주소는 더 이상 갱신되지 않아요. 장부 관리자에게 새 주소를 받아 주세요."
              ) : liveState === "on" ? (
                <>
                  <b>읽기 전용 화면</b>이에요 — 장부 관리자가 기록하면 <b>실시간으로 바뀌어요</b>.
                  기록을 한 사람에게 맡기면 중복 입력 사고가 없어요.
                </>
              ) : liveState === "empty" ? (
                "아직 기록이 없어요. 장부가 채워지면 여기 실시간으로 보여요."
              ) : (
                "연결하는 중이에요…"
              )}
            </span>
            {liveState === "on" && (
              <span className="gs-slip-who">
                {liveName}
                <em className="gs-live-dot" key={liveTick} aria-hidden="true" />
                실시간
              </span>
            )}
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
          <span className="gs-unitnote">
            {(simple ? "칸에 적은 숫자가 " : "합계를 고칠 때 치는 숫자가 ") +
              (unit === "100000"
                ? "이 금액이에요 — 5 → 50만 · 1.5 → 15만"
                : unit === "1"
                ? "골드 그대로예요 — 50000 → 50,000"
                : "이 금액이에요 — 5 → 5만 · 2.32 → 2만3,200")}
          </span>
        </div>
        {/* 조작법은 왼쪽, 채팅 복사는 표 오른쪽 위 — 표에 딸린 것끼리 한 줄 */}
        {!simple && (
          <div className="gs-tablebar">
            <p className="gs-cellnote">
              칸을 <MouseIcon side="left" /> 누르면 1회 쌓이고, <MouseIcon side="right" />{" "}
              우클릭하면 1회 빠져요.
            </p>
            <ChatCopyBtn line={chatLine} flash={flash} onCopy={copyChat} />
          </div>
        )}

        {/* 사용법은 카드 안에서 펼치지 않고 팝업으로 띄웁니다 — 탭 화면에서 표가 밀리지 않게 */}

        <div className={simple ? "gs-split" : undefined}>
          {simple && (
            <div className="gs-memo">
              <div className="gs-memo-head">
                <span className="gs-memo-left">
                  <span className="gs-caplab">메모장</span>
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
                </span>
                <ChatCopyBtn line={chatLine} flash={flash} onCopy={copyChat} />
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
            onSkip={skipSpin}
            onPickSelf={() => {
              const me = rows.find((x) => x.id === spin.rowId);
              if (me) pickPassTarget(me);
            }}
          />
        )}
        <div className="gs-scroll">
          <table className={"gs-grid" + (simple ? " gs-grid-narrow" : " gs-grid-count")}>
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
                  <th key={c.id} className="gs-colh">
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
                          ◎ 룰렛 · 나온 숫자 × {man(Math.round(goldOf(c.price)))}
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
                      <button className="gs-addcol" onClick={() => setAddColOpen(true)}>
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
                  <th className="gs-colh gs-disch">
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
                        (spin && spin.phase === "pick" && spin.rowId === row.id ? " gs-pickself" : "")
                      }
                      onClick={
                        spin && spin.phase === "pick" ? () => pickPassTarget(row) : undefined
                      }
                    >
                      <th className="gs-stick gs-l">
                        <div className="gs-namecell">
                          {/* 비워 두면 어디서든 이 이름으로 불립니다 — 칸에도 같은 글자를 */}
                          <input
                            className="gs-in gs-in-name"
                            value={row.name}
                            placeholder={ANON(i)}
                            onChange={(e) => patchRow(row.id, "name", e.target.value)}
                            aria-label="이름"
                          />
                          {/* 사람별 기록 — 파괴적인 ×가 항상 맨 끝이도록 왼쪽에 둡니다 */}
                          {!simple && !readOnly && (
                            <button
                              className="gs-rowlog gs-rowdel"
                              onClick={() => openLog(row.id)}
                              aria-haspopup="dialog"
                              aria-label={`${row.name || "이 사람"}의 기록 보기`}
                            >
                              기록
                            </button>
                          )}
                          {!readOnly && (
                          <button
                            className="gs-x gs-rowdel"
                            onClick={() => askDelRow(row)}
                            aria-label={`${row.name || "이 사람"} 삭제`}
                          >
                            ×
                          </button>
                          )}
                        </div>
                      </th>
                      {activeCols.map((c) => {
                        const cnt = row.counts[c.id] ?? "";
                        const n = num(cnt);
                        if (!simple) {
                          return (
                            <td key={c.id}>
                              {/* 카운터 칸 — 왼클릭 = 1회, 우클릭 = 1회 빼기 (게임 인벤토리 문법).
                                  둘 다 기록에 남고, 실수는 반대 클릭이나 기록에서 바로잡습니다.
                                  보조 버튼을 칸 위에 겹치지 않아 오클릭 여지가 없습니다. */}
                              <div className="gs-hitwrap">
                                <button
                                  className={"gs-hit" + (n > 0 ? " gs-hit-on" : "")}
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
                        className="gs-disc"
                        onMouseEnter={() => !readOnly && setDiscRow(row.id)}
                        onMouseLeave={(e) => {
                          /* 한 글자라도 쳤으면 잠금 — 마우스가 나가도 타이핑이 안 끊깁니다.
                             스치기만 한 경우엔 바로 닫혀서 유령 패널이 안 남습니다. */
                          if ((discDraft[row.id] || "").trim()) return;
                          if (e.currentTarget.contains(document.activeElement))
                            document.activeElement.blur();
                          setDiscRow((v) => (v === row.id ? null : v));
                        }}
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
                        <td className="gs-sumcell">{won(Math.max(0, simpleGold(row)))}</td>
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
                    </tr>

                    {!simple && open && (
                      <tr className="gs-exrow">
                        <td colSpan={cols.length + (readOnly ? 3 : 4)}>
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
              </tr>
            </tfoot>
          </table>
        </div>
        </div>

      </section>
      )}

      {/* ── 장부 ─────────────────────────────────────── */}
      {showLedger && r && (
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
      {showLedger && !r && tabbed && (
        <section className="gs-mail gs-ledgersec">
          <div className="gs-cardhead">
            <div className="gs-headleft">
              <h2 className="gs-h2">정산 장부</h2>
            </div>
          </div>
          <div className="gs-card gs-ledgerbox">
            <div className="gs-empty">
              <p>정산할 사람이 없어요.</p>
              <p className="gs-empty-sub">벌금표에 금액을 입력하면 장부가 여기에 만들어져요.</p>
            </div>
          </div>
        </section>
      )}

      {/* ── 우편 ─────────────────────────────────────── */}
      {showMail && (
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

      {/* ── 첫 방문: 모드 선택 ─────────────────────────── */}
      {intro && (
        <div className="gs-intro" role="dialog" aria-modal="true" aria-label="모드 안내">
          <div className="gs-intro-in">
            <div className="gs-intro-top">
              <h1 className="gs-title">모드 안내</h1>
              {/* 나중에 다시 열어 본 것이면 그냥 닫고 하던 일로 돌아갈 수 있어야 합니다 */}
              {intro === "guide" && (
                <button className="gs-btn gs-btn-ghost" onClick={() => setIntro(null)}>
                  닫기
                </button>
              )}
            </div>
            <p className="gs-intro-lead">
              벌금을 적으면 누가 누구에게 얼마를 보낼지, 우편 수수료까지 계산해요.
              <br />
              {intro === "guide"
                ? "그냥 닫아도 지금 모드 그대로예요. 카드를 고르면 그 모드로 바뀌어요."
                : "벌금을 어떻게 적을지 고르세요. 나중에 언제든 바꿀 수 있어요."}
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
      {showHelp && (
        <InfoModal
          title="사용법"
          onClose={() => setShowHelp(false)}
          headExtra={
            !readOnly && (
              <button
                className="gs-btn gs-btn-ghost gs-help-replay"
                onClick={() => {
                  setShowHelp(false);
                  coachReset("course");
                  if (partyReg.active !== EXAMPLE_PARTY) openExampleParty();
                  pickTab("sheet");
                  setCoach({ kind: "course", step: 0 });
                }}
              >
                화면 안내 다시 보기
              </button>
            )
          }
        >
          {/* 사용법을 여는 순간은 대개 뭔가 막혔을 때라, 기능 이름이 아니라 그 질문을 표제로 씁니다 */}
          <ul className="gs-help gs-help-qa">
            <li>
              <b>잘못 눌렀어요</b>
              칸을 우클릭하면 1회가 빠져요. 기록에서 어떤 줄이든 취소할 수 있고, 인원·항목을
              지웠거나 '처음부터'를 눌렀다면 ↩ 되돌리기가 잠깐 떠 있어요.
            </li>
            <li>
              <b>숫자를 직접 고치고 싶어요</b>
              합계를 누르면 입력 단위 기준으로 바로 쳐 넣을 수 있어요. 차액은 기타 '조정'으로
              남아서 기록이 끊기지 않아요.
            </li>
            <li>
              <b>단가를 중간에 바꿔야 해요</b>
              단가를 누르면 '이제부터 세는 것만'과 '지금까지 센 횟수까지' 중에 골라요. 아직
              세지 않은 항목은 창 없이 바로 고쳐져요.
            </li>
            <li>
              <b>이미 메모장에 적고 있었어요</b>
              메모장 모드에 그대로 붙여넣으면 표가 만들어져요. 모드를 바꿔도 적어둔 내용은
              그대로 넘어가고, 카운터의 횟수 구성은 동결됐다가 돌아올 때 복원돼요.
            </li>
            <li>
              <b>같은 멤버로 한 판 더 해요</b>
              '처음부터'를 누르면 이름과 항목은 두고 숫자·기록만 비워요.
            </li>
            <li>
              <b>파티가 여럿이에요</b>
              파티마다 표·기록·공유 주소가 따로 살아요. 제목의 파티 이름으로 바꾸고, 화면 맨 위
              장부는 하나예요 — '처음부터'로 회차를 닫고 새로 시작해요. 지난 회차는 헤더의 '백업'에서 봐요.
            </li>
            <li>
              <b>파티원한테 보여주고 싶어요</b>
              화면 맨 위 'OBS 공유 설정'에서 주소를 만들면, 그 주소 하나로 방송 화면에 띄우고
              디스코드로도 공유해요. 파티원 화면은 읽기 전용이에요.
            </li>
            <li>
              <b>벌금을 어떻게 나눌지 고르고 싶어요</b>
              정산 장부의 '정산 방식'에서 골라요. 벌금통은 전부 모아 전원이 똑같이 나누고, 본인
              제외는 자기 벌금을 자기만 빼고 나눠요. 누가 보내고 받는지는 같고 금액만 달라져요.
            </li>
            <li>
              <b>채팅에 붙여넣고 싶어요</b>
              표 오른쪽 위 '채팅 공유용 복사'가 이름과 벌금을 한 줄로 만들어요. {CHAT_LIMIT}자가
              넘으면 이름을 줄여요.
            </li>
          </ul>
        </InfoModal>
      )}
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
                  <span className={"gs-log-nm" + (en.kind === "price" ? " gs-log-sys" : "")}>
                    {en.kind === "price" ? en.item || "항목" : en.name || "이름 없음"}
                  </span>
                  <span className="gs-log-what">
                    {en.kind === "price" &&
                      `단가 ${man(en.from)} → ${man(en.to)}${
                        en.mode === "forward" ? " (지금부터)" : ""
                      }`}
                    {en.kind === "press" && `${en.item || "항목"} ${signedMan(en.delta)}`}
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
                  </span>
                  {en.kind !== "price" && <span className="gs-log-after">→ {man(en.after)}</span>}
                  {en.kind !== "cancel" &&
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
      {false && !readOnly && (
        <PartyLobby
          list={partyReg.list}
          active={partyReg.active}
          rooms={relay.rooms}
          onPick={(name) => {
            setLobby(false);
            switchParty(name);
          }}
          onCreate={(name, size) => {
            const ok = createParty(name, size);
            if (ok) setLobby(false);
            return ok;
          }}
          onDelete={(name) => askDeleteParty(name)}
          onRestore={() => {
            setLobby(false);
            setKeyOpen(true);
          }}
          onRename={renameParty}
          onExample={() => {
            setLobby(false);
            coachReset("course");
            openExampleParty();
            pickTab("sheet");
            setCoach({ kind: "course", step: 0 });
          }}
          onClose={() => setLobby(false)}
        />
      )}
      {showSplitHelp && <SplitHelp onClose={() => setShowSplitHelp(false)} />}
      {coach && coach.kind === "course" && (
        <CoachMark
          sel={COURSE_STEPS[coach.step].sel}
          text={COURSE_STEPS[coach.step].text}
          action={COURSE_STEPS[coach.step].action}
          step={coach.step + 1}
          total={COURSE_STEPS.length}
          passive
          onSkip={() => setCoach({ kind: "hint", from: "course" })}
          onNext={() => {
            if (coach.step < COURSE_STEPS.length - 1) {
              setCoach({ kind: "course", step: coach.step + 1 });
            } else {
              /* 졸업 — 파티 목록에 내려 '튜토리얼' 카드를 한 번 짚어줍니다.
                 졸업 멘트가 권한 다음 행동(새 파티 만들기)도 바로 이 화면에 있습니다 */
              coachDone("course");
              setLobby(true);
              setCoach({ kind: "lobbyHint" });
            }
          }}
          onClose={() => {
            // 대상이 없을 때(세로 보기 등)는 조용히 마칩니다
            coachDone("course");
            setCoach(null);
          }}
        />
      )}
      {coach && coach.kind === "lobbyHint" && (
        <CoachMark
          sel=".gs-lobby-demo"
          text="안내를 다시 보고 싶으면 여기를 누르면 돼요."
          action="알겠어요"
          onNext={() => setCoach(null)}
          onClose={() => setCoach(null)}
        />
      )}
      {coach && coach.kind === "hint" && (
        <CoachMark
          sel=".gs-backrow"
          text="안내는 파티 목록의 '튜토리얼'에서 언제든 다시 볼 수 있어요."
          action="알겠어요"
          onNext={() => {
            coachDone(coach.from);
            setCoach(null);
          }}
          onClose={() => {
            coachDone(coach.from);
            setCoach(null);
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
      {resetOpen && (
        <ResetModal
          hasLog={log.length > 0}
          hasRoom={!!activeRoom}
          presets={presets}
          onSavePreset={savePresetNow}
          onDeletePreset={(nm) => {
            const next = presets.filter((x) => x.name !== nm);
            setPresets(next);
            savePresets(next);
          }}
          onExportFile={exportPartyFile}
          onRun={(kind, presetName) => {
            const pre = presets.find((x) => x.name === presetName) || null;
            clearAll(kind, pre);
            setResetOpen(false);
          }}
          onClose={() => setResetOpen(false)}
        />
      )}
      {lookOpen && (
        <LookModal
          relay={relay}
          putRelay={putRelay}
          toggleOvCol={toggleOvCol}
          onClose={() => setLookOpen(false)}
        />
      )}
      {keyOpen && (
        <KeyShare
          relay={relay}
          putRelay={putRelay}
          gens={genEntries()
            .slice()
            .sort((a, b) => (b.t || 0) - (a.t || 0))
            .map((g) =>
              g.gold != null ? g : { ...g, gold: slotGold(loadPartySlot(g.name)) }
            )}
          onGenView={openGen}
          onGenLock={(nm) =>
            putPartyReg({
              ...partyReg,
              list: partyReg.list.map((x) =>
                x.name === nm ? { ...x, locked: !x.locked } : x
              ),
            })
          }
          onGenDrop={(nm) =>
            setAsk({
              title: "이 지난 회차를 지울까요?",
              body: nm + " — 로컬 보관에서 지워져요. 파일로 남긴 게 없으면 되돌릴 수 없어요.",
              action: "지우기",
              onYes: () => {
                dropPartySlot(nm);
                putPartyReg({
                  ...partyReg,
                  list: partyReg.list.filter((x) => x.name !== nm),
                });
              },
            })
          }
          onSeatBundle={async (got) => ({ msg: seatMsg(await seatFromBundle(got)) })}
          onExportFile={exportPartyFile}
          onImportFile={importPartyFile}
          onClose={() => setKeyOpen(false)}
        />
      )}
      {obsOpen && (
        <ObsShare
          relay={relay}
          putRelay={putRelay}
          toggleOvCol={toggleOvCol}
          activeLabel={partyReg.active}
          snapshot={liveSnapshot}
          onAskReissue={askObsReissue}
          onAskShareOff={askShareOff}
          onOpenKeys={() => {
            setObsOpen(false);
            setKeyOpen(true);
          }}
          onOpenLook={() => {
            setObsOpen(false);
            setLookOpen(true);
          }}
          onClose={() => {
            setObsOpen(false);
            if (obsCoachPending.current) {
              obsCoachPending.current = false;
              setCoach({ kind: "obs" });
            }
          }}
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
                {pl.who === "land" ? sp.pass2.name : "?"}
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
                steps: [{ k: sp.pass2.name }],
                i: 0,
                rolling: pl.who === "roll",
                spd: sp.spd,
              }}
              landed={pl.who === "land" ? sp.pass2.name : null}
            />
          ) : sp.look === "wheel" ? (
            <SpinWheel spin={asWheel} landed={!pl.rolling ? faceLabel(cur.k) : null} />
          ) : (
            <div className="gs-reel">
              <span className="gs-reel-line" />
              <b className="gs-reel-n side">
                {pl.rolling ? "" : faceLabel(pool[(landIdx - 1 + pool.length) % pool.length])}
              </b>
              <b className={"gs-reel-n big" + (pl.rolling ? " gs-spin-rolling" : " gs-spin-land")}>
                {pl.rolling ? "?" : faceLabel(cur.k)}
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
        <span className="gs-spin-skip off">누르면 건너뛰어요</span>
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
  const k = (spin.steps[spin.i] || {}).k;
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
    const target = (4 + (spin.i || 0) * 2) * 360 - seg.mid;
    if (spin.skipped) {
      /* 건너뛰기 — 굴러가던 회전을 그 자리에서 끊고 결과로 붙입니다.
         시간만 0으로 바꾸면 이미 시작된 회전은 안 멈춥니다. */
      el.style.transitionProperty = 'none';
      el.style.transform = 'rotate(' + target.toFixed(2) + 'deg)';
      rotRef.current = target;
      return;
    }
    const ms = spinSpeed(spin.spd).roll;
    el.style.transitionProperty = 'none';
    el.style.transform = 'rotate(' + rotRef.current.toFixed(2) + 'deg)';
    void el.offsetWidth;
    el.style.transitionProperty = 'transform';
    el.style.transitionDuration = ms + 'ms';
    el.style.transform = 'rotate(' + target.toFixed(2) + 'deg)';
    rotRef.current = target;
  }, [spin.sid, spin.i, spin.skipped]);
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
function SpinPanel({ spin, onSkip, onPickSelf }) {
  const cur = spin.steps[spin.i] || {};
  /* 릴과 돌림 글자는 이 판의 실제 면 목록에서 뽑습니다 — 기본 목록으로 돌리면
     면을 고친 룰렛에서 없는 면이 스쳐 지나갑니다 */
  const pool = poolAt(
    spin.faces && spin.faces.length ? spin.faces : ROULETTE_KEYS,
    spin.steps,
    spin.i
  );
  const idx = spin.rolling
    ? spin.tick % pool.length
    : Math.max(0, pool.indexOf(cur.k));
  const shown = spin.rolling ? pool[idx] : cur.k;
  const prevK = pool[(idx - 1 + pool.length) % pool.length];
  const nextK = pool[(idx + 1) % pool.length];
  const whoOn = spin.pass2 && (spin.phase === "who" || spin.target);
  /* 이번 판에 이미 나온 면들 — 도는 중인 면은 아직 안 나왔으니 뺍니다 */
  const chips = spin.steps.slice(0, spin.i + (spin.rolling ? 0 : 1));
  const gold = Math.round(spin.priceG * spin.res.count);
  const picking = spin.phase === "pick";
  const done = spin.phase === "done";
  /* 자리를 차지하지 않게 화면에 띄웁니다 — 표가 밀리면 누르던 칸이 달아납니다.
     도는 동안에는 뒤를 덮어 막고, 양도를 고를 때는 덮개를 걷어 표를 누르게 합니다. */
  return (
    <div
      className={"gs-spinwrap" + (picking ? " gs-spinwrap-pick" : "")}
      onClick={picking ? undefined : onSkip}
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
            const wi = spin.whoRolling
              ? spin.tick % nm.length
              : Math.max(0, nm.indexOf(spin.pass2.name));
            const cur2 = spin.whoRolling ? nm[wi] : spin.pass2.name;
            return (
              <div className="gs-reel">
                <span className="gs-reel-line" />
                <b className="gs-reel-n side">{nm[(wi - 1 + nm.length) % nm.length]}</b>
                <b
                  className={
                    "gs-reel-n big" +
                    (String(cur2).length > 3 ? " longer" : String(cur2).length > 2 ? " long" : "") +
                    (spin.whoRolling ? " gs-spin-rolling" : " gs-spin-land")
                  }
                  key={spin.whoRolling ? "w" + spin.tick : "wl"}
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
              steps: [{ k: spin.pass2.name }],
              i: 0,
              rolling: !!spin.whoRolling,
              spd: spin.spd,
              skipped: spin.skipAt === "who",
            }}
            landed={!spin.whoRolling ? spin.pass2.name : null}
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
      <div className={"gs-spin-out" + (picking || done ? "" : " gs-spin-out-wait")}>
        {!(picking || done) && (
          <span className="gs-spin-status">
            {spin.phase === "who"
              ? "넘겨받을 사람을 뽑는 중이에요"
              : "숫자를 뽑는 중이에요"}
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
      <span className="gs-spin-skip">
        {done
          ? "누르면 닫혀요"
          : picking
          ? "줄을 누르면 그 사람에게 붙어요"
          : spin.phase === "who"
          ? spin.whoRolling
            ? "누르면 그 자리에 멈춰요"
            : "누르면 결과를 바로 붙여요"
          : spin.rolling
          ? "누르면 그 자리에 멈춰요"
          : spin.i + 1 < spin.steps.length
          ? "누르면 다음 판이 바로 돌아요"
          : !spin.res.pass
          ? "누르면 결과를 바로 붙여요"
          : spin.pass2
          ? "누르면 다음 판이 바로 돌아요"
          : "누르면 바로 넘어가요"}
      </span>
    </div>
    </div>
  );
}

/* 켜고 끌 때 방송 화면이 어떻게 되는지 그 자리에서 보여 줍니다 — 켜 보고 OBS 로
   건너가서 확인하는 수고를 없앱니다. */
function OvColsPreview({ items, net }) {
  const rows = [
    { r: 1, n: "로마러", c: [2, 1, 3], g: "13만", d: "−6.4만", neg: 1 },
    { r: 2, n: "조이냥", c: [1, 1, 1], g: "9만", d: "−2.4만", neg: 1 },
    { r: 3, n: "하늘", c: [0, 0, 1], g: "3만", d: "+3.6만", neg: 0 },
  ];
  return (
    <div className="gs-ovprev" aria-label="방송 화면 예시">
      <div className="gs-ovprev-row gs-ovprev-head">
        <span className="gs-ovprev-rank" />
        <span className="gs-ovprev-nm">벌금표</span>
        {items && ["잡힘", "죽음", "◎죽음"].map((t) => <span key={t} className="gs-ovprev-c">{t}</span>)}
        <span className="gs-ovprev-g">25만</span>
        {net && <span className="gs-ovprev-d">순액</span>}
      </div>
      {rows.map((x) => (
        <div className="gs-ovprev-row" key={x.r}>
          <span className="gs-ovprev-rank">{x.r}</span>
          <span className="gs-ovprev-nm">{x.n}</span>
          {items && x.c.map((v, i) => (
            <span key={i} className={"gs-ovprev-c" + (v ? "" : " z")}>{v || ""}</span>
          ))}
          <span className="gs-ovprev-g">{x.g}</span>
          {net && <span className={"gs-ovprev-d " + (x.neg ? "neg" : "pos")}>{x.d}</span>}
        </div>
      ))}
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
        다른 사람에게 넘겨요. <b>×2</b>는 빠지지 않아서 연달아 나올 수 있어요.
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
      <span className="gs-tip-body gs-tip-r" role="tooltip">
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
      {[
        ["num", "슬롯", "슬롯처럼 위아래로 스쳐요"],
        ["wheel", "원판", "칸이 도는 원판이에요"],
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
/* 처음부터 — 첫 문장은 목적만. 장치(전부 비우기·틀·파일)는 접힘 아래에서만 나옵니다 */
function ResetModal({ hasLog, hasRoom, presets, onSavePreset, onDeletePreset, onExportFile, onRun, onClose }) {
  const [more, setMore] = useState(false);
  const [presetName, setPresetName] = useState("");
  const [saveName, setSaveName] = useState("");
  const [savedTick, setSavedTick] = useState(false);
  return (
    <InfoModal title="처음부터" onClose={onClose}>
      <div className="gs-key">
        <p>
          {hasLog ? "지금 판은 남겨두고 새로 시작해요." : "새로 시작해요."}
          {hasRoom && <> 공유 주소·링크는 그대로예요.</>}
        </p>
        <button className="gs-btn gs-btn-big" onClick={() => onRun("keep", "")}>
          새로 시작
          <em>이름·항목은 그대로, 숫자·기록만 비워요</em>
        </button>
        <button className="gs-fold" onClick={() => setMore((v) => !v)} aria-expanded={more}>
          {more ? "▾" : "▸"} 다른 구성으로 시작…
        </button>
        {more && (
          <div className="gs-reset-preset">
            <div className="gs-obs-acts">
              <select
                className="gs-rc-kind"
                value={presetName}
                onChange={(e) => setPresetName(e.target.value)}
                aria-label="틀로 시작"
              >
                <option value="">빈 표</option>
                {presets.map((x) => (
                  <option key={x.name} value={x.name}>
                    틀: {x.name}
                  </option>
                ))}
              </select>
              {presetName && (
                <button
                  className="gs-x"
                  onClick={() => {
                    onDeletePreset(presetName);
                    setPresetName("");
                  }}
                  aria-label="이 틀 지우기"
                >
                  ×
                </button>
              )}
              <button className="gs-btn gs-btn-sm" onClick={() => onRun("full", presetName)}>
                전부 비우고 시작
              </button>
            </div>
            <div className="gs-obs-acts">
              <input
                className="gs-in gs-obs-claim"
                value={saveName}
                placeholder="지금 구성을 틀로 저장 — 이름"
                onChange={(e) => setSaveName(e.target.value)}
                aria-label="틀 이름"
              />
              <button
                className="gs-btn gs-btn-sm"
                disabled={!saveName.trim()}
                onClick={() => {
                  if (onSavePreset(saveName)) {
                    setSaveName("");
                    setSavedTick(true);
                    setTimeout(() => setSavedTick(false), 2000);
                  }
                }}
              >
                {savedTick ? "저장했어요" : "틀로 저장"}
              </button>
            </div>
            <p className="gs-key-foot">틀에는 명단·항목·단가·수수료·입력 단위가 담겨요.</p>
            {hasLog && (
              <div className="gs-obs-acts">
                <button className="gs-btn gs-btn-sm gs-btn-ghost" onClick={onExportFile}>
                  파일로도 남기기
                </button>
              </div>
            )}
          </div>
        )}
        <div className="gs-obs-acts" style={{ marginTop: 12 }}>
          <button className="gs-btn gs-btn-sm" onClick={onClose}>
            취소
          </button>
        </div>
      </div>
    </InfoModal>
  );
}

/* 외형 — 오버레이 테마·방송 열·룰렛 외형. 취향은 브라우저에 붙는 전역 설정이라
   헤더(전역 자리)에 있습니다. OBS 창에서는 「외형 설정 열기」 문으로 건너옵니다. */
function LookModal({ relay, putRelay, toggleOvCol, onClose }) {
  const [err, setErr] = useState("");
  const previewRef = useRef(null);
  /* 테마 확인용 창 — 늘 예시 방을 씁니다. 내 방은 벌금이 바뀌기 전엔 정지 화면이라
     증감·순위 변동·1위 강조를 볼 수 없어서요. */
  const previewUrl = (lk) =>
    relayApi.shareUrl(DEMO_ROOM) +
    "?mode=overlay&fit=1&t=" + lk.t +
    (isPanelLook(lk) ? "&bg=" + (100 - (lk.alpha ?? 25)) : "");
  const openPreview = () => {
    const w = window.open(previewUrl(relay.look), "gsOverlayPreview", "width=560,height=640");
    previewRef.current = w;
    if (!w) setErr("브라우저가 팝업을 막았어요. 팝업을 허용하고 다시 눌러 주세요.");
  };
  const pickLook = (lk) => {
    putRelay({ ...relay, look: lk });
    const w = previewRef.current;
    if (w && !w.closed) w.location.replace(previewUrl(lk));
  };
  return (
    <InfoModal title="외형" onClose={onClose} wide>
      <div className="gs-obs-look" style={{ marginTop: 0 }}>
        <div className="gs-obs-lookhead">
          <h4>오버레이 테마</h4>
          <button className="gs-btn gs-btn-sm gs-btn-ghost" onClick={openPreview}>
            테마 미리보기
          </button>
        </div>
        <p className="gs-obs-looknote">고르면 방송 화면에 바로 반영돼요 — OBS의 주소는 그대로 두면 돼요.</p>
        <LookPicker look={relay.look} onPick={pickLook} />
      </div>
      <div className="gs-obs-sec">
        <h4 className="gs-obs-h">방송 화면에 넣을 열</h4>
        <p className="gs-obs-note">둘 다 기본으로 켜져 있어요 — 여기서 끌 수 있어요.</p>
        <div className="gs-ovcols">
          {[
            ["items", "항목 횟수", "잡힘·죽음 같은 항목을 몇 번 했는지"],
            ["net", "순액", "받을 몫에서 낸 벌금을 뺀 값 (파랑은 받고, 빨강은 내요)"],
          ].map(([key, label, hint]) => {
            const on =
              key === "net"
                ? (relay.ov || {}).net !== false
                : (relay.ov || {})[key] !== false;
            return (
              <button
                key={key}
                className={"gs-ovcol" + (on ? " on" : "")}
                onClick={() => toggleOvCol(key)}
                aria-pressed={on}
              >
                <b>{label}</b>
                <span>{hint}</span>
                <em>{on ? "켬" : "끔"}</em>
              </button>
            );
          })}
        </div>
        <OvColsPreview
          items={(relay.ov || {}).items !== false}
          net={(relay.ov || {}).net !== false}
        />
      </div>
      <div className="gs-obs-sec">
        <h4 className="gs-obs-h">룰렛 외형</h4>
        <p className="gs-obs-note">
          벌금표와 방송 화면에 똑같이 적용돼요. 룰렛 항목이 여럿이어도 하나로 가요.
        </p>
        <div className="gs-rc-look gs-obs-spd">
          <span>도는 속도</span>
          {Object.keys(SPINS).map((k) => (
            <button
              key={k}
              className={"gs-rc-lookbtn" + (spinSpd(relay) === k ? " on" : "")}
              onClick={() => putRelay({ ...relay, spd: k })}
            >
              {SPINS[k].label}
            </button>
          ))}
        </div>
        <SpinLookPicker
          value={spinShape(relay)}
          theme={wheelTheme(relay)}
          onPick={(v) => putRelay({ ...relay, spinLook: v })}
          onTheme={(v) => putRelay({ ...relay, wheelTheme: v })}
        />
      </div>
      {err && <p className="gs-obs-err">{err}</p>}
    </InfoModal>
  );
}

/* 편집 권한 넘기기 — 이 브라우저의 열쇠를 다른 기기로 보냅니다.
   방송 송출과는 상관없는 일이라 헤더에 따로 두었습니다. OBS 설정 맨 밑에 두면
   정작 브라우저를 못 쓰게 된 뒤에 찾을 사람이 그때 가서 못 찾습니다. */
function KeyShare({ relay, putRelay, gens, onGenView, onGenLock, onGenDrop, onSeatBundle, onExportFile, onImportFile, onClose }) {
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const [copied, setCopied] = useState(""); // "code" | "link"
  /* 방송 화면에 코드가 새지 않게 — 기본은 가리고, 가린 채로도 복사는 됩니다 */
  const [revealed, setRevealed] = useState(false);
  const [claim, setClaim] = useState("");
  const [note, setNote] = useState("");
  const fileRef = useRef(null);
  const rcode = relay.rcode || null;
  /* 12자를 4자씩 끊어 보여 줍니다 — 옮겨 적기 좋게. 붙여넣을 땐 붙임표를 걷어냅니다 */
  const fmt = (c) => (c ? c.replace(/(.{4})(?=.)/g, "$1-") : "");

  /* 발급·재발급 — 옛 코드는 서버에서 지웁니다 */
  const issueRecovery = async () => {
    setBusy("issue");
    setErr("");
    try {
      const { rcode: drop, ...bundle } = relay;
      const r = await relayApi.recoveryIssue(bundle);
      if (rcode) relayApi.recoveryRevoke(rcode);
      putRelay({ ...relay, rcode: r.code });
      setCopied("");
    } catch (e) {
      setErr(e.message || "실패했어요");
    }
    setBusy("");
  };

  /* 링크만 덜렁 보내면 받은 사람이 이게 얼마나 센 코드인지 모르고 다시 퍼뜨립니다 —
     경고를 붙여서 내보냅니다. */
  const codeMsg = () =>
    "[벌금표 복구 코드] 이 링크를 열면 그 기기에서 장부를 그대로 이어받고 기록도 할 수 있어요.\n" +
    "오래 보관하는 열쇠예요 — 다른 사람에게 함부로 넘기지 마세요.\n" +
    handoffUrl(rcode);
  const copyIt = (kind) =>
    navigator.clipboard
      .writeText(kind === "link" ? codeMsg() : fmt(rcode))
      .then(() => {
        setCopied(kind);
        setTimeout(() => setCopied(""), 2500);
      })
      .catch(() => setErr("복사하지 못했어요"));

  const onFile = (e) => {
    const f = e.target.files && e.target.files[0];
    e.target.value = "";
    if (!f) return;
    const rd = new FileReader();
    rd.onload = () => setNote(onImportFile(String(rd.result || "")));
    rd.readAsText(f);
  };

  const takeCode = async () => {
    /* 링크째 붙여넣는 게 보통입니다 — 코드만 뽑아 씁니다 */
    const c = codeFromText(claim);
    if (!c) return;
    setBusy("claim");
    setErr("");
    setNote("");
    try {
      const got = await (c.length >= 10 ? relayApi.recoveryClaim(c) : relayApi.handoffClaim(c));
      const r = await onSeatBundle(got);
      setClaim("");
      setNote(r.msg);
    } catch (e) {
      setErr(e.message || "실패했어요");
    }
    setBusy("");
  };

  return (
    <InfoModal title="백업 · 복구" onClose={onClose}>
      <div className="gs-key">
        <h4 className="gs-key-h">복구 코드</h4>
        <p>
          <b>브라우저가 지워져도 장부를 되찾게 해 두는 곳이에요.</b> 코드 하나로
          표·기록·기록 권한을 다른 기기에서 그대로 불러와요 — 발급해서 안전한 곳에 적어
          두세요.
        </p>
        <div className="gs-obs-acts">
          {rcode ? (
            <>
              <span className="gs-key-code">{revealed ? fmt(rcode) : "••••-••••-••••"}</span>
              <button
                className="gs-btn gs-btn-sm gs-btn-ghost"
                onClick={() => setRevealed((v) => !v)}
              >
                {revealed ? "가리기" : "보기"}
              </button>
              <button className="gs-btn gs-btn-sm" onClick={() => copyIt("code")}>
                {copied === "code" ? "복사했어요" : "코드 복사"}
              </button>
              <button className="gs-btn gs-btn-sm gs-btn-ghost" onClick={() => copyIt("link")}>
                {copied === "link" ? "복사했어요" : "링크로 복사"}
              </button>
              <button
                className="gs-btn gs-btn-sm gs-btn-ghost"
                onClick={issueRecovery}
                disabled={busy === "issue"}
              >
                {busy === "issue" ? "만드는 중…" : "새로 발급"}
              </button>
            </>
          ) : (
            <button className="gs-btn gs-btn-sm" onClick={issueRecovery} disabled={busy === "issue"}>
              {busy === "issue" ? "만드는 중…" : "복구 코드 발급"}
            </button>
          )}
        </div>
        <p className="gs-obs-warn">
          이 코드는 <b>사실상 계정이에요 — 다른 사람에게 주지 마세요.</b> 새로 발급하면 옛
          코드는 바로 못 쓰게 되고, '주소 새로 발급'을 해도 같이 끊겨요.
        </p>
        <p className="gs-key-foot">
          파티를 90일 넘게 한 번도 안 열면 서버 보관이 만료돼서 코드로 못 살려요 — 오래 쉴
          땐 아래 파일 백업을 함께 써 주세요.
        </p>

        <h4 className="gs-key-h">받기 — 링크나 코드로 이어받기</h4>
        <div className="gs-obs-acts">
          <input
            className="gs-in gs-obs-claim"
            value={claim}
            placeholder="받은 링크나 복구 코드 붙여넣기"
            onChange={(e) => setClaim(e.target.value)}
            aria-label="받은 링크나 복구 코드"
          />
          <button
            className="gs-btn gs-btn-sm"
            onClick={takeCode}
            disabled={busy === "claim" || !codeFromText(claim)}
          >
            {busy === "claim" ? "가져오는 중…" : "불러오기"}
          </button>
        </div>
        <p className="gs-key-foot">
          장부(표·기록)까지 통째로 이어받고, 이 기기에서도 기록할 수 있게 돼요. 링크가
          깨져서 왔으면 받은 글을 통째로 붙여넣어도 돼요.
        </p>

        <h4 className="gs-key-h">파일 백업</h4>
        <p>
          서버 없이도 남는 백업이에요. 지금 장부 전체(표·기록·설정)를 파일 하나로
          저장했다가, 언제든 다시 불러와요. 서버 보관(90일)과 무관한 영구 보관이에요.
        </p>
        <div className="gs-obs-acts">
          <button className="gs-btn gs-btn-sm" onClick={onExportFile}>
            파일로 내보내기
          </button>
          <button
            className="gs-btn gs-btn-sm gs-btn-ghost"
            onClick={() => fileRef.current && fileRef.current.click()}
          >
            파일 가져오기
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            style={{ display: "none" }}
            onChange={onFile}
          />
        </div>

        <h5 className="gs-key-h">지난 회차</h5>
        <p>'처음부터'를 누르면 그때까지의 회차가 여기 남아요.</p>
        <p className="gs-key-foot">
          잠금 안 한 것은 최근 5개만 남아요. 보기는 읽기 전용이고, 이어서 쓰려면 보기
          화면의 '현재 장부로 복원'을 눌러요.
        </p>
        {gens.length === 0 && (
          <p className="gs-key-foot">아직 지난 회차가 없어요.</p>
        )}
        {gens.map((g) => (
          <div className="gs-genrow" key={g.name}>
            <b>{g.name}</b>
            <span className="gs-genrow-meta">{man(g.gold || 0)}</span>
            <span className="gs-genrow-r">
              <button
                className={"gs-genlock" + (g.locked ? " on" : "")}
                onClick={() => onGenLock(g.name)}
                aria-pressed={!!g.locked}
                title={g.locked ? "잠금을 풀면 자동 정리 대상이 돼요" : "잠그면 자동 정리에서 빠져요"}
              >
                {g.locked ? "잠김" : "잠금"}
              </button>
              <button className="gs-btn gs-btn-sm" onClick={() => onGenView(g.name)}>
                보기
              </button>
              <button
                className="gs-x"
                onClick={() => onGenDrop(g.name)}
                aria-label={g.name + " 지우기"}
              >
                ×
              </button>
            </span>
          </div>
        ))}

        {note && <p className="gs-key-note">{note}</p>}
        {err && <p className="gs-obs-err">{err}</p>}
      </div>
    </InfoModal>
  );
}

function ObsShare({ relay, putRelay, toggleOvCol, activeLabel, snapshot, onAskReissue, onAskShareOff, onOpenKeys, onOpenLook, onClose }) {
  const room = relay.rooms[activeLabel] || null;
  const label = activeLabel === DEFAULT_ROOM_LABEL ? "기본" : activeLabel;
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const [copied, setCopied] = useState(null); // "url" | "msg"
  const [showGuide, setShowGuide] = useState(false);
  const [showWhy, setShowWhy] = useState(false);
  const previewRef = useRef(null);
  const url = room ? relayApi.shareUrl(room.roomId) : "";
  const srcMode = relay.ovsrc === "split" ? "split" : "one";


  useEffect(() => {
    // 가이드 창이 위에 떠 있으면 Esc 는 그쪽 몫입니다 — 한 번에 하나씩 닫힙니다
    const onKey = (e) => e.key === "Escape" && !showGuide && !showWhy && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, showGuide, showWhy]);


  /* 복사물은 단 하나 — 파티원에게 보낼 메시지. 주소는 그 안에 한 줄로 들어 있습니다. */
  const msg = () =>
    "[벌금 현황판] " + label + "\n" +
    url + "\n" +
    "· OBS 브라우저 소스에 이 주소를 넣으면 오버레이가 떠요\n" +
    "· 브라우저로 열면 자세한 현황을 볼 수 있어요";

  const copy2 = (kind, text) =>
    navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopied(kind);
        setTimeout(() => setCopied(null), 2000);
      })
      .catch(() => setErr("복사하지 못했어요"));

  const [freshCode, setFreshCode] = useState(null); // 방금 자동 발급된 복구 코드
  const [showFresh, setShowFresh] = useState(false); // 방송 중 유출 방지 — 기본 가림
  const makeRoom = async () => {
    setBusy("room");
    setErr("");
    try {
      const r = await relayApi.createRoom();
      const next = {
        ...relay,
        on: true,
        rooms: { ...relay.rooms, [activeLabel]: { roomId: r.roomId, key: r.key } },
      };
      /* 공유를 처음 켠 순간 = 지킬 것이 생긴 순간 — 복구 코드를 같이 만들어 둡니다 */
      if (!relay.rcode) {
        try {
          const { rcode: drop, ...bundle } = next;
          const rc = await relayApi.recoveryIssue(bundle);
          next.rcode = rc.code;
          setFreshCode(rc.code);
        } catch (e2) {
          /* 코드 발급 실패는 공유를 막지 않습니다 — 백업 창에서 다시 만들 수 있어요 */
        }
      }
      putRelay(next);
      await relayApi.push(r.roomId, r.key, snapshot()).catch(() => {});
    } catch (e) {
      setErr(e.message || "실패했어요");
    }
    setBusy("");
  };


  const guideImg = (k) =>
    (/^(localhost|127\.0\.0\.1)$/.test(window.location.hostname) ? "docs/" : "") +
    "obs-guide/obs-guide-" + k + ".png";

  return (
    <div className="gs-modal" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="gs-dialog gs-dialog-wide" role="dialog" aria-modal="true" aria-label="OBS · 외형 설정">
        <div className="gs-obs-head">
          <h3>OBS · 외형 설정</h3>
          <div className="gs-obs-headr">
            {room && (
              <label className="gs-switch">
                공유 켜기
                <input
                  type="checkbox"
                  checked={!!relay.on}
                  onChange={(e) =>
                    e.target.checked ? putRelay({ ...relay, on: true }) : onAskShareOff()
                  }
                />
                <span className="gs-sw-track" aria-hidden="true">
                  <span className="gs-sw-knob" />
                </span>
              </label>
            )}
            <button className="gs-obs-guideopen" onClick={() => setShowGuide(true)}>
              <i aria-hidden="true">?</i> OBS에 넣는 방법
            </button>
            <button className="gs-x gs-dialog-x" onClick={onClose} aria-label="닫기">
              ×
            </button>
          </div>
        </div>
        <p>
          아래 주소를 <b>OBS 브라우저 소스에 붙여넣으면</b>, 벌금 현황이 방송 화면에
          실시간으로 떠요. 브라우저로 열면 정산 장부와 보낼 우편까지 볼 수 있어요.
        </p>


        {!room ? (
          <div className="gs-obs-make">
            <p>이 명단은 아직 공유 주소가 없어요.</p>
            <button className="gs-btn" onClick={makeRoom} disabled={busy === "room"}>
              {busy === "room" ? "만드는 중…" : "이 명단의 주소 만들기"}
            </button>
          </div>
        ) : (
          <div className="gs-obs-copybox">
            {/* 소스 구성 — 모드를 먼저 고르고, 주소는 고른 모드 것만 보여 줍니다 */}
            <div className="gs-obs-srcpick" role="group" aria-label="소스 구성">
              {[
                ["one", "한 소스", "현황판과 룰렛이 한 주소에 같이 나와요"],
                ["split", "나눈 소스", "룰렛이 따로 나와요 — 화면 전체에 크게 띄울 수 있어요"],
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
            <div className="gs-obs-boxtop">
              {srcMode === "one" ? (
                <span className="gs-obs-urltext">{url}</span>
              ) : (
                <span className="gs-obs-urltext gs-obs-urldim">주소 두 개를 각각 소스로 넣어요</span>
              )}
              <span className="gs-obs-reissue">
                <button className="gs-btn gs-btn-sm gs-btn-warn2" onClick={onAskReissue}>
                  주소 새로 발급
                </button>
                <span className="gs-tip">
                  <button className="gs-qm gs-qm-sm" aria-label="주소 새로 발급">
                    ?
                  </button>
                  <span className="gs-tip-body gs-tip-r" role="tooltip">
                    주소가 새어 나갔거나 명단이 바뀌었을 때 써요. 지금 주소는 바로 못 쓰게 돼요.
                  </span>
                </span>
              </span>
            </div>
            {srcMode === "one" ? (
              <div className="gs-obs-copyrow">
                <button className="gs-btn" onClick={() => copy2("url", url)}>
                  {copied === "url" ? "복사됐어요 — OBS 소스 URL에 붙여넣으세요" : "OBS용 주소 복사"}
                </button>
                <button className="gs-btn gs-btn-ghost" onClick={() => copy2("msg", msg())}>
                  {copied === "msg" ? "복사됐어요 — 디스코드에 붙여넣으세요" : "파티원 메시지 복사"}
                </button>
              </div>
            ) : (
              <>
                <div className="gs-obs-srcrow">
                  <b>현황판</b>
                  <span className="gs-obs-urltext">{url + "?type=board"}</span>
                  <button
                    className="gs-btn gs-btn-sm"
                    onClick={() => copy2("burl", url + "?type=board")}
                  >
                    {copied === "burl" ? "복사됐어요" : "복사"}
                  </button>
                </div>
                <div className="gs-obs-srcrow">
                  <b>룰렛</b>
                  <span className="gs-obs-urltext">{url + "?type=spin"}</span>
                  <button
                    className="gs-btn gs-btn-sm"
                    onClick={() => copy2("surl", url + "?type=spin")}
                  >
                    {copied === "surl" ? "복사됐어요" : "복사"}
                  </button>
                </div>
                <p className="gs-obs-srcnote">
                  현황판 소스는 구석에 작게, 룰렛 소스는 화면 전체로 크게 잡아요. 룰렛
                  소스는 판이 돌 때만 나타나고 평소에는 아무것도 안 보여요. 룰렛 주소를
                  안 넣으면 룰렛 없이 현황판만 나와요.
                </p>
                <div className="gs-obs-copyrow">
                  <button className="gs-btn gs-btn-ghost" onClick={() => copy2("msg", msg())}>
                    {copied === "msg" ? "복사됐어요 — 디스코드에 붙여넣으세요" : "파티원 메시지 복사"}
                  </button>
                </div>
              </>
            )}
          </div>
        )}

        {/* 이어가기·백업 안내 — 기능은 편집 권한 · 백업 창에 모여 있습니다 */}
        <p className="gs-obs-keysline">
          다른 환경에서 이어가거나 다른 사람에게 기록을 맡기고 싶으면 <b>복구 코드</b>를
          발급해서 적어 두세요.{" "}
          <button className="gs-btn gs-btn-sm gs-btn-ghost" onClick={onOpenKeys}>
            복구 코드·백업 관리
          </button>
        </p>
        {freshCode && (
          <div className="gs-obs-fresh">
            <p>
              <b>복구 코드도 같이 만들어 뒀어요.</b> 브라우저가 지워져도 이 코드만 있으면
              표·기록·권한을 그대로 되찾아요. 지금 적어 두세요 — 나중에 보려면 헤더의
              「백업」에서.
            </p>
            <div className="gs-obs-acts">
              <span className="gs-key-code">
                {showFresh ? freshCode.replace(/(.{4})(?=.)/g, "$1-") : "••••-••••-••••"}
              </span>
              <button
                className="gs-btn gs-btn-sm gs-btn-ghost"
                onClick={() => setShowFresh((v) => !v)}
              >
                {showFresh ? "가리기" : "보기"}
              </button>
              <button
                className="gs-btn gs-btn-sm"
                onClick={() => copy2("rcode", freshCode.replace(/(.{4})(?=.)/g, "$1-"))}
              >
                {copied === "rcode" ? "복사했어요" : "코드 복사"}
              </button>
            </div>
          </div>
        )}
        {/* 링크를 보내기 직전에 알아야 할 사실. 이유는 눌러서 봅니다 */}
        <p className="gs-obs-ro">
          파티원 화면은 <b>읽기 전용</b>이에요.{" "}
          <button className="gs-obs-why" onClick={() => setShowWhy(true)}>
            왜 그런가요?
          </button>
        </p>

        {/* 꾸미기는 헤더의 외형 창으로 — 여정을 위해 건너가는 문만 둡니다 */}
        <p className="gs-obs-keysline">
          방송 화면의 테마·룰렛 외형은{" "}
          <button className="gs-btn gs-btn-sm gs-btn-ghost" onClick={onOpenLook}>
            외형 설정 열기
          </button>
        </p>

        {err && <p className="gs-obs-err">{err}</p>}
      </div>
      {showWhy && (
        <InfoModal title="왜 파티원은 수정할 수 없나요?" onClose={() => setShowWhy(false)}>
          <p>
            벌금 기록은 이 브라우저(장부 관리자)에서만 되고, 파티원 화면은 읽기 전용이에요.
            한 사람이 기록해야 중복 입력 사고가 없기 때문이에요.
          </p>
          <p>
            여러 명이 동시에 고칠 수 있으면, 같은 벌금을 두 사람이 각각 넣거나 한쪽이 방금 고친
            숫자를 다른 쪽이 덮어쓰는 일이 생겨요. 정산이 끝난 뒤에는 어느 쪽이 맞는지 확인할
            방법도 없고요.
          </p>
          <p>
            대신 파티원은 벌금표·정산 장부·보낼 우편을 전부 볼 수 있어요. 자기가 얼마 냈고
            누구에게 얼마를 보내는지 직접 확인할 수 있으니, 못 보는 것은 없어요.
          </p>
        </InfoModal>
      )}
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
    </div>
  );
}

/* 파티 — 제목 왼쪽 드롭다운. 누르면 그 파티의 장부로 통째로 바뀝니다 */
function PartyMenu({ list, active, onPick, onCreate, onClose }) {
  const [label, setLabel] = useState("");
  const [size, setSize] = useState(8); // 파티 인원 — 만들고 나서도 인원 추가·삭제로 조절됩니다
  const boxRef = useRef(null);
  useEffect(() => {
    const onDown = (e) => {
      if (boxRef.current && !boxRef.current.parentElement.contains(e.target)) onClose();
    };
    const onKey = (e) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);
  const add = () => {
    if (!label.trim()) return;
    onCreate(label, size);
    setLabel("");
  };
  return (
    <div className="gs-crewmenu gs-partymenu" ref={boxRef} role="dialog" aria-label="파티">
      {list.map((x) => (
        <div className="gs-crewrow" key={x.name}>
          <button
            className={"gs-crewload" + (x.name === active ? " gs-party-on" : "")}
            onClick={() => onPick(x.name)}
          >
            {x.name}
            {x.name === EXAMPLE_PARTY && <i className="gs-ex-badge">예시</i>}
            {x.name === active && <em>지금</em>}
          </button>
        </div>
      ))}
      <div className="gs-crewsave">
        <div className="gs-seg gs-seg-sm" role="group" aria-label="인원">
          {[4, 8].map((v) => (
            <button key={v} className={size === v ? "on" : ""} onClick={() => setSize(v)}>
              {v}인
            </button>
          ))}
        </div>
        <input
          className="gs-in"
          value={label}
          placeholder="새 파티 이름"
          onChange={(e) => setLabel(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && add()}
          aria-label="새 파티 이름"
        />
        <button className="gs-btn gs-btn-sm" onClick={add} disabled={!label.trim()}>
          추가
        </button>
      </div>
    </div>
  );
}

/* 파티 로비 — 루트 화면. 파티 하나 = 장부 하나 = 공유 주소 하나가 한눈에 보입니다.
   삭제는 여기서만 됩니다. 마지막 하나는 못 지웁니다. */
function PartyLobby({ list, active, rooms, onPick, onCreate, onDelete, onRename, onExample, onRestore, onClose }) {
  const [label, setLabel] = useState("");
  const [size, setSize] = useState(8);
  const [editing, setEditing] = useState(null); // 이름 바꾸는 중인 파티
  const [editVal, setEditVal] = useState("");
  const commitRename = (old) => {
    if (onRename(old, editVal)) setEditing(null);
  };
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const add = () => {
    if (!label.trim()) return;
    if (onCreate(label, size)) setLabel("");
  };
  /* 카드 요약 — 이름이 채워진 줄만 세고, 합계는 정산과 같은 식으로 뽑습니다 */
  const cardInfo = (name) => {
    const slot = loadPartySlot(name);
    if (!slot) return { cnt: 0, total: 0 };
    return {
      cnt: migrateRows(slot.rows).length,
      total: slotGold(slot),
    };
  };
  return (
    <div className="gs-lobby" role="dialog" aria-modal="true" aria-label="파티 목록">
      <div className="gs-lobby-in">
        <button className="gs-backrow" onClick={onClose}>
          <i aria-hidden="true">‹</i> 돌아가기
        </button>
        <h1 className="gs-title">파티 목록</h1>
        <p className="gs-lobby-lead">
          파티마다 표와 기록, 공유 주소가 따로 있어요. 바꿔도 하던 장부는 그대로 남아요.
        </p>
        <div className="gs-lobby-list">
          {list.map((x) => {
            const info = cardInfo(x.name);
            return (
              <div className={"gs-lobby-card" + (x.name === active ? " on" : "")} key={x.name}>
                {editing === x.name ? (
                  <div className="gs-lobby-editrow">
                    <input
                      className="gs-in"
                      value={editVal}
                      autoFocus
                      onChange={(e) => setEditVal(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") commitRename(x.name);
                        if (e.key === "Escape") setEditing(null);
                      }}
                      aria-label="파티 이름 바꾸기"
                    />
                    <button className="gs-btn gs-btn-sm" onClick={() => commitRename(x.name)}>
                      저장
                    </button>
                    <button className="gs-btn gs-btn-sm gs-btn-ghost" onClick={() => setEditing(null)}>
                      취소
                    </button>
                  </div>
                ) : (
                  <button className="gs-lobby-open" onClick={() => onPick(x.name)}>
                    <span className="gs-lobby-name">
                      <b>{x.name}</b>
                      {x.name === EXAMPLE_PARTY && <em>예시</em>}
                      {x.name === active && <em className="gs-lobby-now">지금 열려 있어요</em>}
                    </span>
                    <span className="gs-lobby-meta">
                      {info.cnt === 0 ? "아직 비어 있어요" : `${info.cnt}명 · 벌금 ${man(info.total)}`}
                      {rooms[x.name] && <em className="gs-lobby-share">· 공유 주소 있음</em>}
                    </span>
                  </button>
                )}
                {editing !== x.name && (
                  <button
                    className="gs-x gs-lobby-edit"
                    onClick={() => {
                      setEditing(x.name);
                      setEditVal(x.name);
                    }}
                    aria-label={`${x.name} 이름 바꾸기`}
                  >
                    ✎
                  </button>
                )}
                {editing !== x.name && list.length > 1 && (
                  <button
                    className="gs-x"
                    onClick={() => onDelete(x.name)}
                    aria-label={`${x.name} 삭제`}
                  >
                    ×
                  </button>
                )}
              </div>
            );
          })}
        </div>
        <div className="gs-lobby-add">
          <div className="gs-seg gs-seg-sm" role="group" aria-label="인원">
            {[4, 8].map((v) => (
              <button key={v} className={size === v ? "on" : ""} onClick={() => setSize(v)}>
                {v}인
              </button>
            ))}
          </div>
          <input
            className="gs-in"
            value={label}
            placeholder="새 파티 이름"
            onChange={(e) => setLabel(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && add()}
            aria-label="새 파티 이름"
          />
          <button className="gs-btn gs-btn-sm" onClick={add} disabled={!label.trim()}>
            추가
          </button>
        </div>
        {/* 새 기기에서 들어오는 입구 — 복원은 가진 쪽이 아니라 받는 쪽 일입니다 */}
        <button className="gs-lobby-demo" onClick={onRestore}>
          <span className="gs-lobby-name">
            <b>↧ 불러오기</b>
          </span>
          <span className="gs-lobby-meta">
            복구 코드·편집 권한 링크·백업 파일로 파티를 이어받아요.
          </span>
        </button>
        <button className="gs-lobby-demo" onClick={onExample}>
          <span className="gs-lobby-name">
            <b>튜토리얼</b>
          </span>
          <span className="gs-lobby-meta">
            화면 안내를 처음부터 다시 봐요. 예시 파티 '현자들'에서 진행돼요.
          </span>
        </button>
      </div>
    </div>
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
          <button className="gs-btn" disabled={!changed} onClick={() => onApply(col, newG, false)}>
            이제부터 세는 것만 {man(changed ? newG : oldG)}으로
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
    window.localStorage.setItem(COACH_KEY, JSON.stringify(v));
  } catch (e) {}
}

function coachReset(k) {
  try {
    const v = JSON.parse(window.localStorage.getItem(COACH_KEY) || "{}");
    delete v[k];
    window.localStorage.setItem(COACH_KEY, JSON.stringify(v));
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

/* 튜토리얼 — 예시 파티에서만 도는 하나의 이야기, 여섯 걸음.
   1~4는 실조작(기록→정정→정산 확인→최종 출력), 5~6은 위치와 졸업.
   일반 파티에서는 어떤 안내도 자동으로 뜨지 않습니다. */
const COURSE_STEPS = [
  {
    sel: ".gs-hit",
    text: (
      <>
        아무 칸이나 <MouseIcon side="left" /> 눌러 보세요 — 1회가 쌓여요.
      </>
    ),
  },
  {
    sel: ".gs-hit",
    text: (
      <>
        이번엔 <MouseIcon side="right" /> 우클릭 — 1회가 빠져요.
      </>
    ),
  },
  { sel: ".gs-tab-ledger", text: "정산 장부 탭을 눌러 보세요 — 방금 누른 게 정산돼 있어요." },
  { sel: ".gs-tab-mail", text: "보낼 우편 탭도 눌러 보세요 — 누가 누구에게 얼마를 보낼지 나와 있어요." },
  { sel: ".gs-obsbtn", text: "이 현황을 방송 화면에 실시간으로 띄우려면 여기예요.", action: "다음" },
  {
    sel: ".gs-party-dd",
    text: "여기까지예요 — 이제 새 파티를 만들어 시작해 보세요.",
    action: "알겠어요",
  },
];

/* passive: 말풍선 밖 조작을 막지 않습니다 — 해보기 코스처럼 '직접 눌러야' 진행되는 단계용 */
function CoachMark({ sel, text, action, step, total, passive, onNext, onSkip, onClose }) {
  const [box, setBox] = useState(null);
  useEffect(() => {
    const measure = () => {
      const el = document.querySelector(sel);
      if (!el) return onClose();
      const r = el.getBoundingClientRect();
      setBox({ x: r.left, y: r.top, w: r.width, h: r.height });
    };
    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [sel]);
  if (!box) return null;
  const left = Math.max(10, Math.min(box.x - 8, window.innerWidth - 320));
  return (
    <div
      className={"gs-coach" + (passive ? " gs-coach-pass" : "")}
      onMouseDown={(e) => !passive && e.target === e.currentTarget && onClose()}
    >
      <div
        className="gs-coach-ring"
        style={{ left: box.x - 5, top: box.y - 5, width: box.w + 10, height: box.h + 10 }}
      />
      <div className="gs-coach-bubble" style={{ left, top: box.y + box.h + 14 }}>
        <span
          className="gs-coach-tail"
          style={{ left: Math.max(14, box.x + box.w / 2 - left - 6) }}
          aria-hidden="true"
        />
        <p>{text}</p>
        <div className="gs-coach-btns">
          {action && (
            <button className="gs-btn gs-btn-sm" onClick={onNext}>
              {action}
            </button>
          )}
          {total && (
            <em className="gs-coach-step" aria-hidden="true">
              {step}/{total}
            </em>
          )}
          {onSkip && (
            <button className="gs-coach-skip" onClick={onSkip}>
              다음에 보기
            </button>
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
  { id: "clear", name: "판 없이 · 밝은 글자", look: { t: "clear" } },
  { id: "cleardark", name: "판 없이 · 진한 글자", look: { t: "cleardark" } },
];
const LOOK_OPEN = 2; // 처음부터 보이는 개수
const isPanelLook = (lk) => !!lk && (lk.t === "dark" || lk.t === "light");
const sameLook = (a, b) =>
  !!a && !!b && a.t === b.t && (!isPanelLook(a) || (a.alpha ?? 25) === (b.alpha ?? 25));

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
          <button
            ref={yesRef}
            className={"gs-btn" + (ask.tone === "safe" ? "" : " gs-btn-danger")}
            onClick={() => {
              ask.onYes();
              onDone();
            }}
          >
            {ask.action || "삭제"}
          </button>
          {/* 취소는 맨 오른쪽 — 손이 실수로 닿아도 아무 일이 없는 쪽 */}
          <button className="gs-btn gs-btn-ghost" onClick={onCancel}>
            취소
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
              {items.map((t) => (
                <li key={t.to}>
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
  --shadow-rgb:60,40,15; --red-rgb:156,43,34; --gold-rgb:138,100,21;
  --mono:'Cutive Mono',monospace;
  font-family:'IBM Plex Sans KR',system-ui,sans-serif;
  color:var(--ink); background:var(--kraft);
  background-image:
    radial-gradient(120% 80% at 15% 0%, rgba(var(--lift-rgb),.16), transparent 55%),
    repeating-linear-gradient(92deg, rgba(var(--tex-rgb),.035) 0 1px, transparent 1px 5px),
    repeating-linear-gradient(4deg, rgba(var(--tex-rgb),.03) 0 1px, transparent 1px 7px);
  padding:20px 20px 60px; min-height:100vh;
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
  --shadow-rgb:0,0,0; --red-rgb:224,119,107; --gold-rgb:220,174,94;
}
.gs *{box-sizing:border-box}
.gs p{text-wrap:pretty}
.gs :focus-visible{outline:2px solid var(--blue); outline-offset:2px}
/* 고정된 이름 열은 배경이 있어서 이웃 칸의 포커스 테두리를 덮습니다.
   포커스된 칸을 항상 맨 앞으로 올려 테두리가 네 면 다 보이게 합니다. */
.gs .gs-in:focus{position:relative; z-index:5}
.gs-stick:focus-within{z-index:6}
.gs-mast,.gs-card,.gs-mail{max-width:1080px; margin-left:auto; margin-right:auto}

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
.gs-mastside{display:flex; align-items:flex-end; gap:12px; margin-left:auto}
/* 제목 아래 모드 — 화면에서 가장 먼저 읽혀야 하는 상태라 크게, 아이콘까지 붙입니다 */
.gs-mastleft{display:flex; align-items:center; gap:16px; flex-wrap:wrap; padding-bottom:9px}
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
@media (max-width:640px){
  .gs-tab{font-size:13px; padding:7px 10px 8px}
  .gs-tab.on{padding:9px 12px 10px}
  .gs-mastside{gap:8px}
}
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
/* focus-within 을 쓰면 버튼을 클릭한 뒤에도(포커스가 남아) 툴팁이 안 사라집니다.
   키보드 포커스(focus-visible)에만 반응시키고, 마우스는 hover 로만 띄웁니다. */
.gs-tip:hover .gs-tip-body,.gs-tip:has(:focus-visible) .gs-tip-body{display:block;
  animation:gs-tipin .12s ease-out}
@keyframes gs-tipin{from{opacity:0} to{opacity:1}}
@media (prefers-reduced-motion:reduce){ .gs-tip-body{animation:none !important} }
/* 좁은 화면에서는 표가 가로로 잘리므로, 폭을 줄이고 잘리지 않는 쪽으로 폅니다 */
@media (max-width:640px){
  .gs-tip-body{width:min(176px,54vw)}
  .gs-tip-body:not(.gs-tip-r){left:-6px; transform:none}
}

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
.gs-seg button:hover{background:rgba(var(--ink-rgb),.07); color:var(--ink)}
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
@media (max-width:820px){
  .gs-split{grid-template-columns:minmax(0,1fr)}
  .gs-memo-ta{min-height:180px}
}

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
.gs-unitnote{flex:1; min-width:180px; font-size:11.5px; color:var(--ink-2)}
.gs-simpleh{min-width:150px}
.gs-simple-lab{color:var(--ink) !important}
.gs-fee{display:flex; align-items:center; gap:7px; font-size:12.5px}
.gs-fee .gs-in-fee{width:48px; border-bottom:1.5px solid var(--ink); text-align:center; padding:4px 0}

/* 입력 공통 */
.gs-in{border:0; background:transparent; font:inherit; color:var(--ink); padding:6px 2px;
  width:100%; border-radius:0}
.gs-in::placeholder{color:rgba(var(--ink-rgb),.28)}
.gs-x{border:0; background:transparent; color:rgba(var(--ink-rgb),.36); font-size:17px; line-height:1;
  cursor:pointer; padding:3px 5px; border-radius:2px}
.gs-x:hover{color:var(--red); background:rgba(var(--red-rgb),.1)}
.gs-caplab{font-size:10.5px; letter-spacing:.12em; color:var(--ink-2)}

/* 벌금표 */
/* overflow-x:auto 는 세로도 함께 잘라내므로, 테두리가 들어갈 만큼 안쪽 여백을 둡니다 */
.gs-scroll{overflow-x:auto; margin:-6px; padding:6px}
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
/* 이름 네 글자 + 호버 버튼(기록·×)이 겹치지 않는 폭을 미리 확보합니다 */
.gs-grid-count .gs-stick{min-width:180px}
.gs-grid-narrow .gs-stick{min-width:152px}
.gs-grid-count .gs-sumcell{font-size:25px; min-width:10ch}
.gs-grid-count td.gs-disc, .gs-grid-count th.gs-disch{width:140px; min-width:140px; max-width:140px}
/* 표는 카드 폭을 채우므로, 항목 열에 폭을 정해 두어야 실제로 좁아집니다.
   남는 자리는 이름·합계 열이 가져갑니다. */
.gs-grid-count .gs-colh,.gs-grid-count .gs-disch{width:auto; min-width:124px}
/* 항목명은 열이 무엇을 세는지 알리는 제목이라 크게. 단가는 그 아래 작게 남깁니다 */
.gs-grid-count .gs-in-col{font-size:21px; font-weight:700; padding:5px 0}
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
.gs-in-name{font-size:15px; font-family:'Gowun Batang',serif; font-weight:700; padding:9px 0}
.gs-in-cnt{font-family:var(--mono); font-size:16px; text-align:center; padding:9px 0}
.gs-sumcell{font-family:var(--mono); font-size:14px; text-align:right;
  padding-right:6px !important; color:var(--gold); white-space:nowrap}

/* 이름 칸: 행 삭제·기록 버튼은 평소 숨기고 그 행에 마우스를 올렸을 때만.
   이름 열은 방송에서 제일 많이 읽히는 자리라 평소엔 글자만 남깁니다. */
.gs-rowlog{flex:none; font:inherit; font-size:10.5px; letter-spacing:.02em; cursor:pointer;
  color:var(--ink-2); background:transparent; border:1px solid rgba(var(--ink-rgb),.3);
  border-radius:2px; padding:2px 6px; white-space:nowrap}
.gs-rowlog:hover{color:var(--ink); border-color:var(--ink)}
.gs-namecell{display:flex; align-items:center; gap:4px}
.gs-rowdel{flex:none; opacity:0; transition:opacity .12s}
.gs-grid tbody tr:hover .gs-rowdel,
.gs-namecell:focus-within .gs-rowdel,
.gs-rowdel:focus-visible{opacity:1}

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
.gs-add{border:0; background:transparent; font:inherit; font-size:12.5px; color:var(--ink-2);
  cursor:pointer; padding:10px 0; letter-spacing:.03em}
.gs-add:hover{color:var(--ink)}

/* 기타 칸 */
.gs-disc{padding:0 6px !important}
.gs-disc-amt{display:block; font-family:var(--mono); font-size:15px; color:var(--red)}
.gs-disc-sub{display:block; font-size:10.5px; color:var(--ink-2); margin-top:2px;
  max-width:124px; margin-inline:auto; overflow:hidden; text-overflow:ellipsis; white-space:nowrap}

/* OBS로 공유 */
.gs-obsbtn em{font-style:normal; color:var(--red); margin-left:6px; font-size:9px; opacity:1}
.gs-obsbtn em.off{color:rgba(var(--ink-rgb),.32)}
.gs-obs-room{display:flex; align-items:baseline; gap:9px; margin-top:14px; padding-bottom:11px;
  border-bottom:1px dotted rgba(var(--ink-rgb),.28)}
.gs-obs-label{font-size:11.5px; color:var(--ink-2)}
.gs-obs-room b{font-size:15px}
.gs-obs-on{margin-left:auto; font-size:11.5px; color:var(--ink-2)}
.gs-obs-make{margin-top:14px; display:flex; align-items:center; gap:12px; flex-wrap:wrap}
.gs-obs-make p{margin:0; font-size:12.5px; color:var(--ink-2)}
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
.gs-obs-sec h4{margin:0 0 6px; font-size:13px}
.gs-obs-sec p{margin:0; font-size:12px; color:var(--ink-2); line-height:1.7}
.gs-obs-claim{flex:1 1 220px; min-width:0; font-family:var(--mono); font-size:12px;
  padding:6px 8px; border-bottom:1px solid rgba(var(--ink-rgb),.35)}
.gs-obs-keycopy{border-color:var(--gold-ink); color:var(--ink)}
.gs-obs-keycopy:hover{background:rgba(var(--gold-rgb),.14)}
.gs-obs-err{margin-top:10px; font-size:12px; color:var(--red)}
/* 복사 상자 — 드래그 대신 버튼 복사 둘: OBS용 맨주소(주), 파티원 메시지(보조) */
.gs-obs-copybox{display:block; width:100%; text-align:left; cursor:pointer; margin-top:14px;
  padding:12px 14px; border:1px solid rgba(var(--ink-rgb),.3); border-radius:3px;
  background:rgba(var(--lift-rgb),.3); user-select:none; font:inherit}
.gs-obs-copybox{cursor:auto}
.gs-obs-copyrow{display:flex; align-items:center; gap:8px; flex-wrap:wrap; margin-top:11px}
.gs-obs-copybox.copied{border-color:var(--gold); background:rgba(var(--gold-rgb),.08)}
.gs-obs-urltext{display:block; font-family:var(--mono); font-size:13px; color:var(--ink);
  overflow:hidden; text-overflow:ellipsis; white-space:nowrap}
.gs-obs-copyhint{display:block; margin-top:5px; font-size:11.5px; color:var(--ink-2)}
.gs-obs-copybox.copied .gs-obs-copyhint{color:var(--gold)}
.gs-obs-head{display:flex; align-items:center; gap:14px}
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
/* '? OBS에 넣는 방법' — 물음표 동그라미 + 라벨 */
.gs-obs-guideopen{display:inline-flex; align-items:center; gap:7px; font:inherit;
  font-size:12.5px; color:var(--ink-2); background:transparent; border:0; cursor:pointer;
  padding:2px 0}
.gs-obs-guideopen:hover{color:var(--ink)}
/* 마우스 아이콘 — 글줄에 얹혀 흐르되 살짝 내려 앉힙니다 */
.gs-mouse{vertical-align:-4px; margin:0 1px}
/* 코치마크 — 처음 한 번, 금테 말풍선이 자리를 가리킵니다 */
.gs-coach{position:fixed; inset:0; z-index:48} /* 모달(50)보다 아래 — 안내가 조작을 못 막습니다 */
.gs-coach-ring{position:fixed; border:2px solid var(--gold); border-radius:6px;
  pointer-events:none; animation:gs-coach-breathe 1.6s ease-in-out infinite}
@keyframes gs-coach-breathe{0%,100%{opacity:1} 50%{opacity:.45}}
.gs-coach-bubble{position:fixed; width:300px; background:var(--paper); border:1px solid var(--gold);
  border-radius:2px; padding:13px 15px; box-shadow:0 14px 34px rgba(var(--shadow-rgb),.4)}
.gs-coach-tail{position:absolute; top:-7px; width:12px; height:12px; background:var(--paper);
  border-left:1px solid var(--gold); border-top:1px solid var(--gold); transform:rotate(45deg)}
.gs-coach-bubble p{margin:0 0 10px; font-size:12.5px; line-height:1.7; color:var(--ink-body)}
/* 코스 단계는 화면 조작을 막지 않습니다 — 말풍선·건너뛰기만 만질 수 있게 */
.gs-coach-pass{pointer-events:none}
.gs-coach-pass .gs-coach-bubble{pointer-events:auto}
/* 카운터는 버튼 줄 오른쪽 끝 — 진행 표시이자, 다음과 건너뛰기를 양 끝으로 벌리는 칸막이 */
.gs-coach-step{margin-left:auto; font-style:normal; font-size:10.5px;
  color:var(--ink-2); font-family:var(--mono)}
.gs-coach-btns{display:flex; align-items:center; gap:14px}
.gs-coach-btns .gs-coach-skip:first-child, .gs-coach-btns .gs-coach-step:first-child{margin-left:auto}
.gs-coach-skip{border:0; background:transparent; font:inherit; font-size:11.5px;
  color:var(--ink-2); cursor:pointer; text-decoration:underline; text-underline-offset:3px;
  padding:2px 0}
.gs-coach-skip:hover{color:var(--ink)}
/* 오버레이 테마 — 사선 배경(밝은/어두운 화면 반반) 위에 실제 조합을 미리 보여줍니다 */
.gs-obs-ro{margin-top:12px; font-size:12.5px; color:var(--ink-2)}
.gs-obs-ro b{color:var(--ink)}
.gs-obs-why{border:0; background:transparent; font:inherit; font-size:12.5px; color:var(--red);
  cursor:pointer; text-decoration:underline; text-underline-offset:3px; padding:0}
.gs-lookmore{display:block; margin-top:9px; border:0; background:transparent; font:inherit;
  font-size:12px; color:var(--ink-2); cursor:pointer; text-decoration:underline;
  text-underline-offset:3px; padding:2px 0}
.gs-lookmore:hover{color:var(--ink)}
.gs-obs-look{margin-top:16px}
.gs-obs-lookhead{display:flex; align-items:center; gap:12px; margin-bottom:4px}
.gs-obs-look h4{margin:0; font-size:13px}
.gs-obs-lookhead .gs-btn{margin-left:auto}
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
.sw-light25 b{background:rgba(248,244,236,.75); color:#221c14}
.sw-light0 b{background:rgba(248,244,236,1); color:#221c14}
.sw-clear b{color:#f5f0e6; text-shadow:0 0 5px rgba(0,0,0,.95), 0 1px 2px rgba(0,0,0,.95)}
.sw-cleardark b{color:#171310; text-shadow:0 0 5px rgba(255,255,255,.95), 0 1px 2px rgba(255,255,255,.95)}
.gs-lookalpha{display:flex; align-items:center; gap:10px; margin-top:10px}
.gs-lookalpha.off{opacity:.45}
.gs-lookalpha-note{font-size:11px; color:var(--ink-2)}
.gs-ro-look{flex:none}
.gs-obs-guideopen i{font-style:normal; width:20px; height:20px; border-radius:50%;
  border:1px solid rgba(var(--ink-rgb),.45); display:inline-flex; align-items:center;
  justify-content:center; font-size:11px}
/* 예시 줄 — 이름만 채우는 프리셋과 달리 표 전체 예시라는 구분선 */
.gs-crewdemo{border-top:1px dotted rgba(var(--ink-rgb),.3); margin-top:2px; padding-top:2px}
.gs-crewdemo + .gs-crewrow{border-top:1px dotted rgba(var(--ink-rgb),.3); margin-top:2px; padding-top:2px}
/* 접이 구역 */
/* 가이드는 이미지가 커서 목록만 스크롤 — 닫기 버튼은 항상 화면 안에 있습니다 */
.gs-obs-guide{margin:10px 0 0 18px; font-size:12.5px; color:var(--ink-body); line-height:1.8;
  max-height:min(58vh, 560px); overflow-y:auto; padding-right:12px}
.gs-obs-guide li{margin-bottom:14px}
.gs-obs-guide img{display:block; max-width:100%; max-height:280px; width:auto; margin-top:7px;
  border-radius:4px; border:1px solid rgba(var(--ink-rgb),.25)}
/* 편집 권한 창 — OBS 설정에서 쓰던 줄 모양을 그대로 씁니다 */
.gs-key p{margin:0 0 8px; font-size:12.5px; color:var(--ink-2); line-height:1.8}
.gs-key-foot{margin-top:16px !important; padding-top:12px; font-size:11.5px !important;
  border-top:1px dotted rgba(var(--ink-rgb),.25)}
.gs-keybtn{display:inline-flex; align-items:center; gap:7px}
.gs-keybtn svg{flex:0 0 auto; opacity:.8}
.gs-keybtn:hover svg{opacity:1}
.gs-obs-warn{color:var(--red) !important; opacity:.9}
/* 권한 · 백업 창 — 세 단(코드·받기·파일) 제목과 코드 상자 */
.gs-key-h{margin:18px 0 6px; font-size:13.5px; color:var(--ink)}
.gs-key h4.gs-key-h:first-child{margin-top:0}
.gs-key-code{font-family:Consolas,monospace; font-size:15px; letter-spacing:.08em;
  color:var(--gold); background:rgba(var(--ink-rgb),.07);
  border:1px solid rgba(var(--gold-rgb),.55); border-radius:5px; padding:5px 10px}
.gs-key-note{margin:10px 0 0; font-size:12.5px; color:var(--ink-body)}
.gs-obs-keysline{margin:12px 0 0; font-size:12.5px; color:var(--ink-2); line-height:1.9}
/* 처음부터 — 주 버튼과 접힘 줄 */
.gs-btn-big{display:flex; flex-direction:column; align-items:center; gap:3px; width:100%;
  box-sizing:border-box; font:inherit; font-size:15px; font-weight:700; cursor:pointer;
  color:var(--gold-strong, var(--gold)); background:rgba(var(--gold-rgb),.09);
  border:1px solid rgba(var(--gold-rgb),.65); border-radius:8px; padding:12px 10px;
  margin:4px 0 2px}
.gs-btn-big em{font-style:normal; font-size:11.5px; font-weight:400; color:var(--ink-2)}
.gs-btn-big:hover{background:rgba(var(--gold-rgb),.15)}
.gs-fold{display:block; font:inherit; font-size:12px; color:var(--ink-2);
  background:transparent; border:0; cursor:pointer; padding:8px 2px 2px; text-align:left}
.gs-fold:hover{color:var(--ink)}
/* 백업 창의 지난 회차 줄 */
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
.gs-reset-preset{margin-top:10px; padding-top:8px;
  border-top:1px dashed rgba(var(--ink-rgb),.18)}
/* 지난 회차 보기 배너 — 화면 맨 위에 상시 */
.gs-genbar{display:flex; align-items:center; gap:10px; flex-wrap:wrap;
  margin:10px auto 0; max-width:var(--gs-w, 1080px); padding:9px 14px;
  border:1px solid rgba(var(--gold-rgb),.55); border-radius:8px;
  background:rgba(var(--gold-rgb),.08); font-size:13px; color:var(--ink-body)}
.gs-genbar b{color:var(--ink)}
.gs-genbar-r{margin-left:auto; display:flex; gap:6px}
/* 방 생성 직후 복구 코드 안내 */
.gs-obs-fresh{margin-top:12px; padding:10px 12px; border:1px dashed rgba(var(--gold-rgb),.5);
  border-radius:6px; background:rgba(var(--gold-rgb),.06)}
.gs-obs-fresh p{margin:0 0 8px; font-size:12.5px; line-height:1.7; color:var(--ink-body)}
/* 시스템 줄 왼쪽 — 앱 이름 (워드프로세서의 앱 바 관행) */
.gs-sysbrand{font-size:14px; font-weight:800; letter-spacing:.04em; color:var(--ink);
  opacity:.92}
/* 소스 구성 — 카드 두 장으로 고르고, 주소는 고른 모드 것만 보입니다 */
.gs-obs-srcpick{display:flex; gap:10px; margin-bottom:12px; flex-wrap:wrap}
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
.gs-obs-srcrow > b{flex:0 0 44px; font-size:12.5px; color:var(--ink-body)}
.gs-obs-srcrow .gs-obs-urltext{flex:1; min-width:0}
.gs-obs-srcnote{margin:8px 0 0; font-size:12px; color:var(--ink-2); line-height:1.7}
.gs-obs-urldim{opacity:.6}
/* 주소 줄 — 주소가 남는 자리를 다 쓰고 새로 발급은 오른쪽 끝에 붙습니다.
   되돌릴 수 없는 단추라 복사 단추들과는 줄을 나눕니다. */
.gs-obs-boxtop{display:flex; align-items:center; gap:10px}
.gs-obs-boxtop .gs-obs-urltext{flex:1 1 auto; min-width:0}
.gs-obs-reissue{display:inline-flex; align-items:center; gap:6px; flex:0 0 auto}
.gs-btn-warn2{border-color:var(--red); color:var(--red); background:transparent}
.gs-btn-warn2:hover{background:rgba(var(--red-rgb),.1)}
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
.gs-sysbar-in{max-width:1080px; margin:0 auto; display:flex; align-items:center; gap:12px}
.gs-sysbar-r{display:flex; align-items:center; gap:10px; margin-left:auto}
/* 줄 안 컨트롤은 전부 32px 한 높이로 */
.gs-sysbar .gs-btn{height:32px; padding-top:0; padding-bottom:0;
  display:inline-flex; align-items:center}
.gs-sysbar .gs-viewseg{margin-bottom:0}
.gs-sysbar .gs-viewseg button{height:30px; width:31px} /* 테두리 포함 32px — 줄 안 한 높이 */
.gs-sysbar .gs-qm{width:32px; height:32px; font-size:12px}
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
.gs-tablebar{display:flex; align-items:flex-end; justify-content:space-between; gap:12px}
.gs-tablebar .gs-cellnote{margin-bottom:8px}
/* 창 머리 — 제목은 왼쪽, X는 항상 오른쪽 위. 본문만 스크롤됩니다 */
.gs-dialog-head{display:flex; align-items:center; gap:14px; margin-bottom:12px; flex:none}
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
@media (max-width:520px){
  .gs-mark{display:none}
  .gs-env-body{padding:15px 14px}
  .gs-stamp{width:70px}
}

/* ---- 좁은 화면: 누르려고 옆으로 밀지 않게 ----
   벌금표에서 입력에 쓰는 열(이름 + 항목)만 한 화면에 넣습니다.
   합계와 기타는 파생·부가라서 스크롤 뒤에 있어도 입력에 지장이 없습니다.
   글씨가 작아지는 건 감수합니다 — 여기는 읽는 화면이 아니라 누르는 화면입니다. */
@media (max-width:560px){
  .gs-card{padding:13px 9px 15px}
  /* 이름 열 */
  .gs-stick{min-width:64px; padding-right:5px !important}
  .gs-nm{font-size:15px}
  .gs-grid .gs-stick .gs-in{font-size:14px}
  /* 항목 열 */
  .gs-colh{min-width:62px; padding:0 2px !important}
  .gs-colh-top{font-size:14px}
  .gs-colh-price{font-size:10px}
  .gs-hitwrap{padding:3px 2px}
  .gs-hit{min-height:46px; padding:4px 2px}
  .gs-hit-num{min-width:3ch; font-size:17px}
  .gs-hit-num em{font-size:10px; margin-left:2px}
  .gs-hit-ghost{font-size:15px}
  /* 파생·부가 열은 좁게 */
  .gs-sumh{min-width:52px; padding-right:2px !important}
  .gs-sumcell{font-size:12px}
  .gs-disc,.gs-disch{padding:0 3px !important}
  .gs-addcolh,.gs-addcolcell{padding:0 2px !important}
  /* 열 폭을 정하는 건 min-width 가 아니라 이 입력칸들입니다 */
  .gs-grid-count .gs-in-name{font-size:16px; padding:6px 0; width:62px}
  .gs-grid-narrow .gs-in-name{font-size:18px; padding:8px 0}
  .gs-grid-count .gs-in-col{font-size:15px; padding:3px 0}
  .gs-in-col{width:44px}
  .gs-namecell{gap:2px}
  /* 데스크톱에서 깔아 둔 최소 폭들이 좁은 화면에서는 표를 밀어냅니다 */
  .gs-grid{min-width:0}
  .gs-grid-count .gs-stick{min-width:96px}
  .gs-grid-count .gs-colh,.gs-grid-count .gs-disch{min-width:62px}
  .gs-grid-count .gs-sumcell{font-size:13px; min-width:5ch}
  .gs-grid-count td.gs-disc,.gs-grid-count th.gs-disch{width:76px; min-width:76px; max-width:76px}
  .gs-grid-count .gs-in-col{font-size:15px; font-weight:700; padding:3px 0}
  .gs-grid-count .gs-in-name{font-size:16px; width:52px}
  .gs-colh-price{font-size:9px}
  .gs-in-col{width:34px; min-width:0}
  /* 시스템 줄이 넘쳐서 사용법 물음표가 잘리던 것 — 넘치면 줄을 바꿉니다 */
  .gs-sysbar-in{flex-wrap:wrap; row-gap:6px}
  .gs-grid-count .gs-colh,.gs-grid-count .gs-disch{min-width:56px}
}

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
.gs-rcbtn{border:1px dashed rgba(var(--gold-rgb),.7); border-radius:3px; background:transparent;
  font:inherit; font-size:11px; color:var(--gold-ink); cursor:pointer; padding:2px 6px; white-space:nowrap}
.gs-rcbtn:hover{background:rgba(var(--gold-rgb),.12)}

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

.gs-ovcols{display:grid; gap:8px; margin-top:10px}
.gs-ovcol{display:grid; grid-template-columns:1fr auto; gap:2px 10px; text-align:left;
  padding:10px 13px; cursor:pointer; border:1px solid rgba(var(--ink-rgb),.22);
  border-radius:5px; background:transparent; font:inherit}
.gs-ovcol b{font-size:14px; color:var(--ink-2)}
.gs-ovcol span{grid-column:1; font-size:12px; color:var(--ink-body); opacity:.8; line-height:1.6}
.gs-ovcol em{grid-row:1/3; grid-column:2; align-self:center; font-style:normal; font-size:12px;
  color:var(--ink-2); border:1px solid rgba(var(--ink-rgb),.28); border-radius:99px; padding:3px 11px}
.gs-ovcol.on{border-color:var(--gold-ink); background:rgba(var(--gold-rgb),.08)}
.gs-ovcol.on b{color:var(--ink)}
.gs-ovcol.on em{color:var(--gold-ink); border-color:var(--gold-ink); font-weight:700}

/* 방송 화면 예시 — 실제 오버레이의 비율을 줄여 옮겼습니다 */
.gs-ovprev{margin-top:12px; padding:10px 12px; border-radius:6px; background:#241f1b;
  color:#f5f0e6; overflow-x:auto}
.gs-ovprev-row{display:flex; align-items:baseline; gap:9px; padding:3px 0;
  font-size:15px; white-space:nowrap}
.gs-ovprev-head{font-size:10px; opacity:.6; border-bottom:1px solid rgba(255,255,255,.14);
  margin-bottom:3px; padding-bottom:4px}
.gs-ovprev-head .gs-ovprev-nm{font-size:14px; font-weight:700; opacity:1}
.gs-ovprev-head .gs-ovprev-g{font-size:12px}
.gs-ovprev-rank{width:14px; flex:none; text-align:center; opacity:.7; font-size:12px}
.gs-ovprev-nm{flex:1; min-width:52px}
.gs-ovprev-c{width:26px; flex:none; text-align:center; font-variant-numeric:tabular-nums}
.gs-ovprev-c.z{opacity:.18}
.gs-ovprev-g{width:42px; flex:none; text-align:right; color:#e8c66a;
  font-variant-numeric:tabular-nums}
.gs-ovprev-d{width:48px; flex:none; text-align:right; font-size:12px; font-weight:700;
  font-variant-numeric:tabular-nums}
.gs-ovprev-d.pos{color:#6fb4ff}
.gs-ovprev-d.neg{color:#ff7d6b}
.gs-ovprev-head .gs-ovprev-d{color:inherit; font-weight:400}

/* 알림 한 줄 — 화면 아래에 잠깐 떴다 사라집니다. 누를 것이 없어 조작을 안 막습니다 */
/* 토스트 안에서 누를 수 있는 말 — 토스트는 클릭을 안 받게 두고(밑의 표를 가리면
   안 되니까) 이 조각만 되살립니다 */
.gs-toast-link{font:inherit; color:var(--gold); background:transparent; border:0;
  padding:0; cursor:pointer; pointer-events:auto; text-decoration:underline;
  text-underline-offset:3px; text-decoration-thickness:1px}
.gs-toast-link:hover{text-decoration-thickness:2px}
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
`;
