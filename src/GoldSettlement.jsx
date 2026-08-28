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
const DEFAULT_COLS = [
  { id: "c1", name: "잡힘", price: "10,000" },
  { id: "c2", name: "죽음", price: "30,000" },
  { id: "c3", name: "", price: "100,000" },
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
const peopleGold = (c1, c2, c3) => c1 * 10000 + c2 * 30000 + c3 * 100000;

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
   소수점은 하나까지 남깁니다 (만G 단위에서 26.5 같은 값을 적을 수 있게). */
function formatNumInput(raw) {
  let s = String(raw ?? "").replace(/[^\d.]/g, "");
  const dot = s.indexOf(".");
  if (dot !== -1) s = s.slice(0, dot + 1) + s.slice(dot + 1).replace(/\./g, "");
  if (s === "") return "";
  const [int, dec] = s.split(".");
  const head = int ? Number(int).toLocaleString("ko-KR") : "";
  return dec === undefined ? head : `${head}.${dec}`;
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
      /* (이름없음n) 자리표시는 메모장에선 빈 줄입니다 */
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

/* 빈 자리는 "(이름없음n)"이라는 실제 이름으로 채워 둡니다 — 메모장에도 줄로 보여서
   그대로 덮어 쓰면 되고, 끝의 닫는 괄호 덕에 숫자로 끝나도 금액으로 안 읽힙니다.
   이 이름에 벌금이 0이면 정산 인원에서 빠집니다. */
const FILL_NAME = (k) => `(이름없음${k})`;
// 옛 저장분의 (이름입력n)도 빈 자리로 인식해야 정산 인원에 끼지 않습니다
const isFillName = (s) => /^\(이름(입력|없음)\d+\)$/.test(s || "");

/* 칸의 금액 — 누를 때마다 그 시점 단가로 굳혀 sums 에 쌓입니다.
   그래서 나중에 단가를 바꿔도 이미 센 것의 금액은 그대로입니다.
   sums 가 없는 칸(예전 저장분·메모장에서 온 표)은 예전처럼 횟수 × 단가로 봅니다. */
const cellGold = (row, colId, priceG) =>
  row.sums && row.sums[colId] != null
    ? Math.round(row.sums[colId])
    : Math.round(num(row.counts[colId]) * priceG);

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
    return v && Array.isArray(v.rows) && Array.isArray(v.cols) ? v : null;
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
const DEFAULT_ROOM_LABEL = "기본"; // 프리셋 없이 쓸 때의 명단 이름

function loadRelay() {
  if (typeof window === "undefined") return { on: false, rooms: {}, active: DEFAULT_ROOM_LABEL };
  try {
    const v = JSON.parse(window.localStorage.getItem(RELAY_KEY) || "null");
    if (!v || typeof v !== "object") throw 0;
    return {
      on: !!v.on,
      rooms: v.rooms && typeof v.rooms === "object" ? v.rooms : {},
      active: typeof v.active === "string" ? v.active : DEFAULT_ROOM_LABEL,
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
      rows: s.rows.map((x) => ({ ...x, counts: x.counts || {}, sums: x.sums || {}, extras: x.extras || [] })),
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
const man = (v) => {
  const neg = v < 0;
  const a = Math.abs(Math.round(v));
  const m = Math.floor(a / UNIT);
  const rest = a % UNIT;
  const c = (x) => x.toLocaleString("ko-KR");
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
  const readOnly = !!liveRoom;
  const [liveState, setLiveState] = useState(readOnly ? "connecting" : null); // connecting|on|empty|dead
  const [liveName, setLiveName] = useState("");
  const [liveTick, setLiveTick] = useState(0);   // 갱신이 올 때마다 +1 — 점이 깜빡입니다
  const [roPulse, setRoPulse] = useState(0);     // 뷰어가 뭘 누르면 배너가 한 번 꿈틀합니다

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
  const tabbed = view === "tabs";
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
    const nextRows = rows.map((x) => {
      const memoTotal = simpleGold(x);
      const { [SIMPLE_ID]: _drop, ...restCounts } = x.counts || {};
      const hit = claim(x, memoTotal);
      if (hit) {
        // 메모장에서 0으로 지웠으면 구성도 비운 것으로 봅니다
        if (memoTotal === 0) {
          if (hit.total !== 0)
            lines.push({ kind: "memo", rowId: x.id, delta: -hit.total, name: x.name, after: 0 });
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
          lines.push({ kind: "memo", rowId: x.id, delta: diff, name: x.name, after: memoTotal });
        }
        return { ...x, counts: frozenCounts, sums: hit.sums || {}, extras };
      }
      if (memoTotal <= 0) return { ...x, counts: restCounts, sums: {}, extras: [] };
      if (memoFreeze)
        lines.push({ kind: "memo-new", rowId: x.id, delta: memoTotal, name: x.name, after: memoTotal });
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
    // 이름 없는 사람은 "(이름없음n)"을 붙여 내보냅니다 — 메모장에선 이름이 정체성이라,
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

  /* ================= OBS 중계 ================= */
  const [relay, setRelay] = useState(loadRelay);
  const [obsOpen, setObsOpen] = useState(false);

  /* ---- 파티: 파티 하나 = 장부 하나 = 공유 주소 하나 ---- */
  const [partyReg, setPartyReg] = useState(
    boot.current.partyReg || { list: [{ name: "기본", t: 0 }], active: "기본" }
  );
  const [partyDD, setPartyDD] = useState(false);
  const [lobby, setLobby] = useState(false);
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
  const boardOf = () =>
    rows
      .filter((x) => (x.name || "").trim() && !isFillName(x.name))
      .map((x) => ({ n: (x.name || "").trim(), g: Math.max(0, itemGold(x)) }));

  /* 오버레이 생김새 — 상태에 실어 보내면 파라미터 없는 기본 주소의 OBS가 즉시 갈아입습니다.
     주소에 테마를 직접 적은 쪽(공유 받은 방송인)은 그 파라미터가 우선이라 영향이 없습니다. */
  const lookOut = () => {
    const lk = relay.look || { t: "dark", alpha: 25 };
    return isPanelLook(lk) ? { t: lk.t, bg: 100 - (lk.alpha ?? 25) } : { t: lk.t };
  };

  /* 뷰어가 그대로 3탭을 그릴 수 있도록 표 전체를 보냅니다 (기록은 뺍니다) */
  const liveSnapshot = () => ({
    v: 1,
    name: partyReg.active === DEFAULT_ROOM_LABEL ? "벌금 현황판" : partyReg.active,
    board: boardOf(),
    full: { cols, rows, feePercent, unit, splitMode },
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
  }, [readOnly, relay.on, activeRoom && activeRoom.roomId, cols, rows, feePercent, unit, splitMode, relay.look, partyReg.active]);

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

  /* --- 뷰어: 구독해서 장부 관리자 화면을 그대로 비춥니다 --- */
  useEffect(() => {
    if (!readOnly || liveRoom === DEMO_ROOM) return;
    let ws = null,
      beat = null,
      wait = 1000,
      stop = false;
    const apply = (st) => {
      if (!st || !st.full) return;
      setCols(st.full.cols || DEFAULT_COLS);
      setRows(st.full.rows || []);
      setFeePercent(st.full.feePercent || "5");
      setUnit(st.full.unit || "10000");
      setSplitMode(st.full.splitMode === "solo" ? "solo" : "pot");
      setLiveName(st.name || "");
      setLiveState("on");
      setLiveTick((t) => t + 1);
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

  /* 정산은 '실제 인원'만 봅니다. 이름이 없거나 "(이름없음n)" 그대로면서 벌금도 없는
     빈 자리 행은 분배 인원수에 끼면 안 되니까요. 표와 메모장에는 그대로 보입니다. */
  const isBlankRow = (x) =>
    (!(x.name || "").trim() || isFillName(x.name)) &&
    !extrasOf(x).length &&
    Object.values(x.counts || {}).every((v) => !num(v));
  const party = useMemo(() => rows.filter((x) => !isBlankRow(x)), [rows]);

  const r = useMemo(
    () => computeSettlement(party, activeCols, feePercent, !simple, splitMode),
    [party, activeCols, feePercent, simple, splitMode]
  );

  /* 인게임 채팅에 그대로 붙일 한 줄. 개행이 안 먹고 50자 제한이 있어서
     여백도 콤마도 없이 이름+숫자만 잇습니다. 0원인 사람도 함께 적어요 — 안 낸 것도 정보라서. */
  const chatLine = useMemo(() => {
    if (!r) return "";
    const entries = party.map((row, i) => ({
      name: row.name || "?",
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
        const sum = Math.max(0, Math.round(base + dGold));
        const { [colId]: _drop, ...restSums } = x.sums || {};
        return {
          ...x,
          counts: { ...x.counts, [colId]: next === 0 ? "" : formatNumInput(String(next)) },
          sums: next === 0 ? restSums : { ...restSums, [colId]: sum },
        };
      })
    );
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
      name: row.name,
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
      name: row.name,
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
    const rest = -en.delta - fromCounts;
    if (rest) mergeExtra(en.rowId, ADJUST_REASON, rest);
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

  /* 새 행도 "(이름없음n)"으로 — 메모장에도 줄이 생기고, 카운터에도 이름 자리가 보입니다 */
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
  const addExtra = (rowId, amount, reason) =>
    readOnly ? undefined :
    setRows((prev) =>
      prev.map((x) =>
        x.id === rowId
          ? {
              ...x,
              // 입력 단계에서 골 단위로 굳혀 둡니다. '10만' 은 여기서 100,000이 됩니다.
              extras: [
                ...extrasOf(x),
                { id: "e" + seq.current++, amount: commafy(Math.round(goldOf(amount))), reason },
              ],
            }
          : x
      )
    );
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
  const delExtra = (rowId, exId) =>
    setRows((prev) =>
      prev.map((x) =>
        x.id === rowId ? { ...x, extras: extrasOf(x).filter((e) => e.id !== exId) } : x
      )
    );

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
  const addCol = () =>
    readOnly ? undefined :
    setCols((prev) => [...prev, { id: "c" + seq.current++, name: "", price: "10,000" }]);
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
  const clearAll = () => {
    if (readOnly) return;
    const demo = isPristine(rows);
    takeSnap(
      "처음부터",
      demo ? "예시를 치우고 빈 표로 시작해요." : "이름과 항목은 그대로 두고 숫자만 비웠어요."
    );
    if (demo) setCols(DEFAULT_COLS);
    setRows(() => {
      const keep = demo ? [] : rows.filter((x) => (x.name || "").trim() && !isFillName(x.name));
      return Array.from({ length: Math.max(8, keep.length) }, (_, i) => ({
        id: "r" + seq.current++,
        name: keep[i] ? keep[i].name : FILL_NAME(i + 1),
        counts: simple ? { [SIMPLE_ID]: "" } : {},
        extras: [],
      }));
    });
    setOpenRow(null);
    setLog([]);
    setMemoFreeze(null);
    clearHash();
  };

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
        `${party[m.from].name || "?"} — 우편 ${m.items.length}통 · ${G(m.total)}`,
        ...m.items.map(
          (t) => `  → ${party[t.to].name || "?"}  ${G(t.amount)} (수령 ${G(t.received)})`
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
    <div className={"gs" + (tabbed ? " gs-tabbed" : "") + (dark ? " gs-dark" : "")}>
      <style>{CSS}</style>

      {/* ── 시스템 줄 — 뷰포트 맨 위에 딱 붙는 전폭 바. 안쪽 내용은 본문과 같은 열 ── */}
      <div className="gs-sysbar">
        <div className="gs-sysbar-in">
          {!readOnly && (
            <button className="gs-backrow" onClick={() => setLobby(true)}>
              <i aria-hidden="true">‹</i> 파티 목록
            </button>
          )}
          <div className="gs-sysbar-r">
            {/* 방송 조작은 화면 최상단 — 어느 탭에 있든 항상 같은 자리 */}
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
                  {activeRoom
                    ? "OBS 공유 설정 · " + (relay.on ? "공유 중" : "공유 중단")
                    : "OBS 공유 설정"}
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
            <span className="gs-viewseg" role="group" aria-label="보기 방식">
              <span className="gs-tip">
                <button
                  className={tabbed ? "on" : ""}
                  onClick={() => setView("tabs")}
                  aria-label="탭으로 보기"
                >
                  <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
                    <path
                      d="M1.5 13.5v-10h4.2l1.2 2h7.6v8z"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.4"
                      strokeLinejoin="round"
                    />
                  </svg>
                </button>
                <span className="gs-tip-body gs-tip-r" role="tooltip">
                  <b>탭 보기</b> — 한 번에 한 화면씩 표시해요.
                </span>
              </span>
              <span className="gs-tip">
                <button
                  className={tabbed ? "" : "on"}
                  onClick={() => setView("scroll")}
                  aria-label="세로로 이어 보기"
                >
                  <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
                    <g fill="none" stroke="currentColor" strokeWidth="1.4">
                      <rect x="2" y="2" width="12" height="5" rx="1" />
                      <rect x="2" y="9" width="12" height="5" rx="1" />
                    </g>
                  </svg>
                </button>
                <span className="gs-tip-body gs-tip-r" role="tooltip">
                  <b>세로 보기</b> — 세 화면을 한 페이지에 이어서 표시해요.
                </span>
              </span>
            </span>
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

      {/* ── 머리 ─────────────────────────────────────── */}
      <header className="gs-mast">
        <div className="gs-mastrow">
          {/* 제목 오른쪽에 모드 — '지금 무엇을 하는 중인가'가 제목과 한 줄에서 읽힙니다 */}
          <div className="gs-mastleft">
            {/* 파티 하나 = 장부 하나 = 공유 주소 하나. 파티명이 제목처럼 이어 읽힙니다 */}
            {!readOnly && (
              <span className="gs-crewwrap gs-partysel">
                <button
                  className="gs-party-dd"
                  onClick={() => setPartyDD((v) => !v)}
                  aria-expanded={partyDD}
                >
                  <span className="gs-party-nm">{partyReg.active}</span>
                  <i aria-hidden="true">▾</i>
                </button>
                {partyDD && (
                  <PartyMenu
                    list={partyReg.list}
                    active={partyReg.active}
                    onPick={(name) => {
                      setPartyDD(false);
                      switchParty(name);
                    }}
                    onCreate={(name, size) => {
                      if (createParty(name, size)) setPartyDD(false);
                    }}
                    onClose={() => setPartyDD(false)}
                  />
                )}
              </span>
            )}
            <h1 className="gs-title">벌금 정산</h1>
          </div>
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
                  className={"gs-btn gs-btn-ghost" + (showLog ? " gs-logbtn-on" : "")}
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
                <button className="gs-btn gs-btn-ghost gs-btn-warn" onClick={askClearAll}>
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

        {readOnly && (
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
            {simple ? "칸에 적은 숫자 하나가 이 금액이에요." : "합계를 고칠 때 숫자 하나가 이 금액이에요."}
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
                    </div>
                  </th>
                ))}
                {!simple && !readOnly && (
                  <th className="gs-addcolh">
                    {/* 도움말을 따로 두지 않고 버튼 자체에 얹습니다 */}
                    <span className="gs-tip">
                      <button className="gs-addcol" onClick={addCol}>
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
                    <tr className={open ? "gs-rowopen" : ""}>
                      <th className="gs-stick gs-l">
                        <div className="gs-namecell">
                          <input
                            className="gs-in gs-in-name"
                            value={row.name}
                            placeholder="이름"
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
                                      ＋
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
                            onReason={(v) => setDiscAsk({ rowId: row.id, name: row.name, draft: v })}
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
                            who={row.name}
                            extras={ex}
                            onAdd={(amount, reason) => addExtra(row.id, amount, reason)}
                            onPatch={(exId, key, v) => patchExtra(row.id, exId, key, v)}
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
                  from={party[m.from].name || "이름 없음"}
                  items={m.items.map((t) => ({
                    to: party[t.to].name || "이름 없음",
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
              '‹ 파티 목록'에서 만들고 지워요. 거기 '튜토리얼'을 누르면 화면 안내를 다시 봐요.
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
      {lobby && !readOnly && (
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
      {obsOpen && (
        <ObsShare
          relay={relay}
          putRelay={putRelay}
          activeLabel={partyReg.active}
          snapshot={liveSnapshot}
          onAskReissue={askObsReissue}
          onAskShareOff={askShareOff}
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

/* OBS로 공유 — 방은 명단마다 하나이고, 주소는 재발급 전까지 영구입니다.
   쓰기 권한은 이 브라우저에만 있고 어떤 주소에도 실리지 않습니다.
   평소 쓰는 것(켜기·복사)만 겉에 두고, 가끔 쓰는 것은 접어 둡니다. */
function ObsShare({ relay, putRelay, activeLabel, snapshot, onAskReissue, onAskShareOff, onClose }) {
  const room = relay.rooms[activeLabel] || null;
  const label = activeLabel === DEFAULT_ROOM_LABEL ? "기본" : activeLabel;
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const [copied, setCopied] = useState(null); // "url" | "msg"
  const [showGuide, setShowGuide] = useState(false);
  const [showWhy, setShowWhy] = useState(false);
  const [code, setCode] = useState(null);
  const [codeShown, setCodeShown] = useState(false);
  const [claim, setClaim] = useState("");
  const previewRef = useRef(null);
  const [claimed, setClaimed] = useState(false);
  const url = room ? relayApi.shareUrl(room.roomId) : "";

  /* 테마 확인용 창 — 늘 예시 방을 씁니다. 내 방은 벌금이 바뀌기 전엔 정지 화면이라
     증감·순위 변동·1위 강조를 볼 수 없어서요. 칩을 누르면 열린 창을 그 자리에서 갈아끼웁니다. */
  const previewUrl = (lk) =>
    relayApi.shareUrl(DEMO_ROOM) +
    "?mode=overlay&fit=1&t=" + lk.t +
    (isPanelLook(lk) ? "&bg=" + (100 - (lk.alpha ?? 25)) : "");
  const openPreview = () => {
    const w = window.open(previewUrl(relay.look), "gsOverlayPreview", "width=560,height=640");
    previewRef.current = w;
    // 조용히 실패하는 게 제일 나쁩니다 — 막혔으면 그렇다고 알려 줍니다
    if (!w) setErr("브라우저가 팝업을 막았어요. 팝업을 허용하고 다시 눌러 주세요.");
  };
  const pickLook = (lk) => {
    putRelay({ ...relay, look: lk });
    const w = previewRef.current;
    if (w && !w.closed) w.location.replace(previewUrl(lk));
  };

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

  const makeRoom = async () => {
    setBusy("room");
    setErr("");
    try {
      const r = await relayApi.createRoom();
      putRelay({
        ...relay,
        on: true,
        rooms: { ...relay.rooms, [activeLabel]: { roomId: r.roomId, key: r.key } },
      });
      await relayApi.push(r.roomId, r.key, snapshot()).catch(() => {});
    } catch (e) {
      setErr(e.message || "실패했어요");
    }
    setBusy("");
  };

  const issueCode = async () => {
    setBusy("code");
    setErr("");
    try {
      const r = await relayApi.handoffIssue(relay);
      setCode(r.code);
      setCodeShown(false); // 방송에 잡히지 않게, 기본은 가림
    } catch (e) {
      setErr(e.message || "실패했어요");
    }
    setBusy("");
  };

  const takeCode = async () => {
    const c = claim.trim().toUpperCase();
    if (c.length !== 6) return;
    setBusy("claim");
    setErr("");
    try {
      const got = await relayApi.handoffClaim(c);
      putRelay({
        on: !!got.on,
        rooms: { ...relay.rooms, ...(got.rooms || {}) },
        active: got.active || relay.active,
        look: got.look || relay.look,
      });
      setClaim("");
      setClaimed(true);
      setTimeout(() => setClaimed(false), 2000);
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
      <div className="gs-dialog gs-dialog-wide" role="dialog" aria-modal="true" aria-label="OBS로 공유">
        <div className="gs-obs-head">
          <h3>OBS로 공유</h3>
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
            <span className="gs-obs-urltext">{url}</span>
            {/* 복사는 둘 — 관리자 자신의 OBS용 맨주소가 주, 파티원 메시지가 보조입니다 */}
            <div className="gs-obs-copyrow">
              <button className="gs-btn" onClick={() => copy2("url", url)}>
                {copied === "url" ? "복사됐어요 — OBS 소스 URL에 붙여넣으세요" : "OBS용 주소 복사"}
              </button>
              <button className="gs-btn gs-btn-ghost" onClick={() => copy2("msg", msg())}>
                {copied === "msg" ? "복사됐어요 — 디스코드에 붙여넣으세요" : "파티원 메시지 복사"}
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

        <div className="gs-obs-look">
          <div className="gs-obs-lookhead">
            <h4>오버레이 테마</h4>
            <button className="gs-btn gs-btn-sm gs-btn-ghost" onClick={openPreview}>
              테마 미리보기
            </button>
          </div>
          <p className="gs-obs-looknote">
            {room
              ? "고르면 방송 화면에 바로 반영돼요 — OBS의 주소는 그대로 두면 돼요."
              : "지금 골라 두면 주소를 만들 때 이 모습으로 시작해요."}
          </p>
          <LookPicker look={relay.look} onPick={pickLook} />
        </div>

        <div className="gs-obs-fold">
          {true && (
            <div className="gs-obs-admin">
              <h4>다른 기기에서도 쓰기</h4>
              <p>
                기록과 공유 관리는 지금 이 브라우저에서만 돼요. 다른 PC나 폰을 등록해 두면,
                브라우저 초기화나 PC 교체로 이 브라우저를 못 쓰게 돼도 거기서 이어서 할 수
                있어요.
              </p>
              <p className="gs-obs-warn">
                코드를 아는 사람은 5분 동안 이 브라우저의 기록 권한을 그대로 가져갈 수 있어요.
                코드는 한 번 쓰면 사라져요. 방송 화면이나 공개 채팅에 보이지 않게 조심하세요.
              </p>
              <div className="gs-obs-acts">
                <button className="gs-btn gs-btn-sm" onClick={issueCode} disabled={busy === "code"}>
                  {busy === "code" ? "만드는 중…" : "코드 발급"}
                </button>
                {code && (
                  <>
                    <button
                      className={"gs-obs-code" + (codeShown ? " shown" : "")}
                      onClick={() => setCodeShown((v) => !v)}
                      aria-label={codeShown ? "코드 가리기" : "코드 보기"}
                    >
                      {codeShown ? code : "●●●●●●"}
                    </button>
                    <span className="gs-obs-note">
                      {codeShown
                        ? "5분 안에 다른 기기에서 입력하세요"
                        : "방송에 보이지 않게 가려뒀어요 — 눌러서 확인"}
                    </span>
                  </>
                )}
              </div>
              <div className="gs-obs-acts">
                <input
                  className="gs-in gs-obs-claim"
                  value={claim}
                  maxLength={6}
                  placeholder="코드 입력"
                  onChange={(e) => setClaim(e.target.value.toUpperCase())}
                  aria-label="받을 코드"
                />
                <button
                  className="gs-btn gs-btn-sm"
                  onClick={takeCode}
                  disabled={busy === "claim" || claim.trim().length !== 6}
                >
                  {claimed ? "받았어요" : "코드로 열쇠 받기"}
                </button>
              </div>

              {room && (
                <div className="gs-obs-reissue">
                  <h4>주소 새로 발급</h4>
                  <p>주소가 새어 나갔거나 명단이 바뀌었을 때 써요. 지금 주소는 바로 못 쓰게 돼요.</p>
                  <button className="gs-btn gs-btn-sm gs-btn-warn2" onClick={onAskReissue}>
                    주소 새로 발급
                  </button>
                </div>
              )}
            </div>
          )}
        </div>

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
function PartyLobby({ list, active, rooms, onPick, onCreate, onDelete, onRename, onExample, onClose }) {
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
      cnt: slot.rows.filter((x) => (x.name || "").trim() && !isFillName(x.name)).length,
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
    if (num(v) > 0) onAdd(num(v), why.trim());
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
            onChange={(e) => setV(formatNumInput(e.target.value))}
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
    if (g > 0) onAdd(g);
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
          onChange={(e) => setV(formatNumInput(e.target.value))}
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
function NumInput({ value, onChange, ...rest }) {
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
    const next = formatNumInput(raw);
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
function Discretion({ who, extras, onAdd, onPatch, onRemove, onClose }) {
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");

  const submit = () => {
    if (goldOf(amount) <= 0) return;
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
                onChange={(v) => onPatch(e.id, "amount", v)}
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
.gs-obs-code{font-family:var(--mono); font-size:19px; letter-spacing:.18em; color:var(--gold)}
.gs-obs-claim{width:110px; font-family:var(--mono); font-size:14px; letter-spacing:.12em;
  text-align:center; padding:6px 4px; border-bottom:1px solid rgba(var(--ink-rgb),.35)}
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
.gs-obs-fold{margin-top:14px}
.gs-obs-foldbtn{font:inherit; font-size:12.5px; color:var(--ink-2); background:transparent;
  border:0; padding:4px 0; cursor:pointer; letter-spacing:.02em}
.gs-obs-foldbtn:hover{color:var(--ink)}
/* 가이드는 이미지가 커서 목록만 스크롤 — 닫기 버튼은 항상 화면 안에 있습니다 */
.gs-obs-guide{margin:10px 0 0 18px; font-size:12.5px; color:var(--ink-body); line-height:1.8;
  max-height:min(58vh, 560px); overflow-y:auto; padding-right:12px}
.gs-obs-guide li{margin-bottom:14px}
.gs-obs-guide img{display:block; max-width:100%; max-height:280px; width:auto; margin-top:7px;
  border-radius:4px; border:1px solid rgba(var(--ink-rgb),.25)}
.gs-obs-admin{margin-top:10px; padding:12px 14px; border:1px dotted rgba(var(--ink-rgb),.28);
  border-radius:3px}
.gs-obs-admin h4{margin:0 0 6px; font-size:13px}
.gs-obs-admin p{margin:0 0 8px; font-size:12px; color:var(--ink-2); line-height:1.7}
.gs-obs-warn{color:var(--red) !important; opacity:.9}
.gs-obs-reissue{margin-top:14px; padding-top:12px; border-top:1px dotted rgba(var(--ink-rgb),.25)}
.gs-btn-warn2{border-color:var(--red); color:var(--red); background:transparent}
.gs-btn-warn2:hover{background:rgba(var(--red-rgb),.1)}
/* 가려진 코드 — 누르면 보입니다 */
.gs-obs-code{font:inherit; font-family:var(--mono); font-size:15px; letter-spacing:.18em;
  color:var(--ink-2); background:rgba(var(--lift-rgb),.35); border:1px dashed rgba(var(--ink-rgb),.35);
  border-radius:3px; padding:6px 12px; cursor:pointer}
.gs-obs-code.shown{color:var(--gold); border-style:solid; border-color:var(--gold); font-size:18px}
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
