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

/* 예시 데이터는 모드마다 따로 둡니다.
   카운터 — 인원별 총액은 처음 예시 그대로 두고, 횟수를 1만·3만·10만 항목으로 조합합니다. */
const DEFAULT_ROWS = [
  ["눈가루", 3, 2, 0], // 9만
  ["팔복", 11, 1, 2], // 34만
  ["읍지", 2, 10, 0], // 32만
  ["히휴", 8, 1, 0], // 11만
  ["주키니", 20, 5, 1], // 45만
  ["포셔", 5, 4, 0], // 17만
  ["티모", 0, 2, 0], // 6만
  ["이다", 5, 1, 1], // 18만
].map(([name, c1, c2, c3], i) => ({
  id: "r" + (i + 1),
  name,
  counts: { c1: c1 ? String(c1) : "", c2: c2 ? String(c2) : "", c3: c3 ? String(c3) : "" },
  extras: [],
}));

/* 금액만 — 이름과 금액만 적는 표 (기본 단위 만G) */
const DEFAULT_ROWS_SIMPLE = [
  ["도읍지", 26],
  ["리니링", 22],
  ["조이냥", 44],
  ["로마러", 33],
  ["호진", 43],
  ["쭈르야", 19],
  ["망치", 12],
  ["인기", 24],
].map(([name, amount], i) => ({
  id: "r" + (i + 1),
  name,
  counts: { [SIMPLE_ID]: String(amount) },
  extras: [],
}));

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
// 카운터 구성이 동결된 사람의 메모장 수정분이 기타로 들어올 때의 사유
const MEMO_REASON = "메모장에서 수정";
/* 카운터 카드에서 총액을 직접 고치면 차액이 기타 한 줄로 쌓입니다.
   취소(역분개)로 횟수가 못 덮는 차액도 기타로 갑니다. */
const EDIT_REASON = "직접 수정";
const CANCEL_REASON = "취소";
const LOG_CAP = 200; // 기록은 최근 200줄만 남깁니다 (공유 링크엔 안 담김)
/* ＋를 누른 직후 이 시간 안의 ↩는 기록까지 지우는 조용한 되돌리기입니다.
   바꾸면 CSS 의 gs-ring 애니메이션 시간(5s)도 같이 바꿔야 합니다. */
const GRACE_MS = 5000;

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

const blankMemoRow = (x) =>
  !(x.name || "").trim() &&
  !(x.extras || []).length &&
  Object.values(x.counts || {}).every((v) => !parseFloat(String(v || "").replace(/[,\s]/g, "")));

function memoToRows(text, prev) {
  const made = text
    .split("\n")
    .map(parseMemoLine)
    .filter(Boolean)
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
    .map((r) => [r.name, r.counts?.[SIMPLE_ID] || ""].filter(Boolean).join(" "))
    .join("\n")
    // 뒤쪽 빈 슬롯 행의 빈 줄은 메모에 안 적습니다 (위 보존 규칙과 왕복이 맞습니다)
    .replace(/\s+$/, "");

/* 빈 자리는 "(이름입력n)"이라는 실제 이름으로 채워 둡니다 — 메모장에도 줄로 보여서
   그대로 덮어 쓰면 되고, 끝의 닫는 괄호 덕에 숫자로 끝나도 금액으로 안 읽힙니다.
   이 이름에 벌금이 0이면 정산 인원에서 빠집니다. */
const FILL_NAME = (k) => `(이름입력${k})`;
const isFillName = (s) => /^\(이름입력\d+\)$/.test(s || "");

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
      [r.name, ...cols.map((c) => tidy(r.counts[c.id])), tidy(r.counts[SIMPLE_ID])].join(FIELD)
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
          cols.forEach((c, k) => {
            if (parts[k + 1]) counts[c.id] = parts[k + 1];
          });
          if (parts[cols.length + 1]) counts[SIMPLE_ID] = parts[cols.length + 1];
          const extras = (extraLists[i] || "")
            .split(FIELD)
            .filter(Boolean)
            .map((chunk, k) => {
              const [amount = "", reason = ""] = chunk.split(SUB);
              return { id: `e${i + 1}_${k + 1}`, amount: commafy(amount), reason };
            });
          return { id: "r" + (i + 1), name: parts[0] || "", counts, extras };
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

function loadSaved() {
  if (typeof window === "undefined") return null;
  try {
    const s = JSON.parse(window.localStorage.getItem(STORE_KEY) || "null");
    if (!s || !Array.isArray(s.cols) || !Array.isArray(s.rows)) return null;
    return {
      cols: s.cols,
      rows: s.rows.map((x) => ({ ...x, counts: x.counts || {}, extras: x.extras || [] })),
      feePercent: typeof s.feePercent === "string" ? s.feePercent : "5",
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

function computeSettlement(rows, cols, feePercent, withExtras = true) {
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
      cols.reduce((a, c) => a + Math.round(num(r.counts[c.id]) * priceGold[c.id]), 0) +
        (withExtras ? extraSum(r) : 0)
    )
  );
  const total = fines.reduce((a, b) => a + b, 0);

  /* 2) 걷은 벌금을 인원수로 균등 분배. 받을 몫은 전원 같습니다 (총액/n).
     몫의 합이 총액과 정확히 같아야 순액 합이 0이 됩니다. */
  const shares = allocate(
    fines.map(() => total / n),
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
    colTotals[c.id] = rows.reduce(
      (a, r) => a + Math.round(num(r.counts[c.id]) * priceGold[c.id]),
      0
    );
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
    const hashMode = readHashMode();
    const shared = readShared();
    const stored = loadSaved();
    // 공유 링크로 열면 표는 링크 것을 쓰지만, 보기 방식(탭/세로)은 이 브라우저의 취향을 따릅니다
    const saved = shared ? null : stored;
    const fallbackMode = hashMode || "simple"; // 처음 여는 사람은 금액만 모드로
    const data = shared ||
      saved || {
        cols: DEFAULT_COLS,
        rows: fallbackMode === "simple" ? DEFAULT_ROWS_SIMPLE : DEFAULT_ROWS,
        feePercent: "5",
        mode: fallbackMode,
      };
    // 주소에 적힌 모드가 저장된 모드보다 우선합니다 (모드별 주소를 열었을 때)
    boot.current = {
      ...data,
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

  const [cols, setCols] = useState(boot.current.cols);
  const [rows, setRows] = useState(boot.current.rows);
  const [feePercent, setFeePercent] = useState(boot.current.feePercent);
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
  /* 실수 복구 — 인원·항목 삭제와 초기화 직전의 표를 한 슬롯 떠 둡니다.
     다음 편집 전까지만 유효하고(통짜 복원이라 그 사이 편집을 같이 날리지 않게),
     저장도 되어서 패닉 새로고침 후에도 편집 전이면 되돌릴 수 있습니다. */
  const [undoSnap, setUndoSnap] = useState(boot.current.undoSnap || null);
  const snapHold = useRef(false); // true 면 이번 rows/cols 변경은 스냅샷을 접지 않음
  const snapBooted = useRef(false);
  /* 첫 방문 — 모드를 고르고 시작합니다. 한 번 저장되면 다시 안 나옵니다. */
  const [intro, setIntro] = useState(!!boot.current.firstVisit);
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
  const seq = useRef(boot.current.seq);

  const simple = mode === "simple";
  const tabbed = view === "tabs";
  const showSheet = !tabbed || tab === "sheet";
  const showLedger = !tabbed || tab === "ledger";
  const showMail = !tabbed || tab === "mail";
  const pickTab = (k) => {
    setTab(k);
    window.scrollTo(0, 0);
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
    cols.reduce((a, c) => a + Math.round(num(row.counts[c.id]) * goldOf(c.price)), 0) +
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
          return { ...x, counts: restCounts, extras: [] };
        }
        const { [SIMPLE_ID]: _s, ...frozenCounts } = hit.counts || {};
        const diff = memoTotal - hit.total;
        let extras = hit.extras || [];
        if (diff !== 0) {
          extras = [
            ...extras,
            { id: "e" + seq.current++, amount: commafy(diff), reason: MEMO_REASON },
          ];
          lines.push({ kind: "memo", rowId: x.id, delta: diff, name: x.name, after: memoTotal });
        }
        return { ...x, counts: frozenCounts, extras };
      }
      if (memoTotal <= 0) return { ...x, counts: restCounts, extras: [] };
      if (memoFreeze)
        lines.push({ kind: "memo-new", rowId: x.id, delta: memoTotal, name: x.name, after: memoTotal });
      return {
        ...x,
        counts: restCounts,
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
    if (next === mode) return;
    setOpenRow(null);

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
    // 이름 없는 사람은 "(이름입력n)"을 붙여 내보냅니다 — 메모장에선 이름이 정체성이라,
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
          extras: [],
        };
      })
    );
    setMode(next);
  };

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
    setIntro(false);
    if (next !== mode) changeMode(next); // 손 안 댄 기본값이라 예시가 조용히 갈아끼워집니다
  };

  const onMemo = (e) => {
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

  // 고칠 때마다 저장해 두면 새로고침해도 그대로 돌아옵니다
  useEffect(() => {
    // 모드를 고르기 전엔 저장하지 않습니다 — 선택 없이 새로고침하면 선택 화면이 다시 나오게
    if (intro) return;
    saveState({
      cols,
      rows,
      feePercent,
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
  }, [cols, rows, feePercent, mode, unit, memoFont, view, tab, log, undoSnap, memoFreeze, theme, intro]);

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
    clearGrace();
    setMemoFreeze(null); // 표가 스냅샷 시점으로 바뀌므로 동결도 무효
    setUndoSnap(null);
  };

  // 모드마다 주소가 달라지도록 (#m=items / #m=simple)
  useEffect(() => {
    // 선택 전엔 주소도 건드리지 않습니다 — 해시가 생기면 첫 방문 판정이 깨집니다
    if (intro) return;
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

  /* 정산은 '실제 인원'만 봅니다. 이름이 없거나 "(이름입력n)" 그대로면서 벌금도 없는
     빈 자리 행은 분배 인원수에 끼면 안 되니까요. 표와 메모장에는 그대로 보입니다. */
  const isBlankRow = (x) =>
    (!(x.name || "").trim() || isFillName(x.name)) &&
    !extrasOf(x).length &&
    Object.values(x.counts || {}).every((v) => !num(v));
  const party = useMemo(() => rows.filter((x) => !isBlankRow(x)), [rows]);

  const r = useMemo(
    () => computeSettlement(party, activeCols, feePercent, !simple),
    [party, activeCols, feePercent, simple]
  );

  /* 인게임 채팅에 그대로 붙일 한 줄. 개행이 안 먹고 50자 제한이 있어서
     여백도 콤마도 없이 이름+숫자만 잇습니다. 벌금이 0인 사람은 뺍니다. */
  const chatLine = useMemo(() => {
    if (!r) return "";
    const entries = party
      .map((row, i) => ({ name: row.name || "?", num: chatNum(r.fines[i]), v: r.fines[i] }))
      .filter((e) => e.v > 0);
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
    setRows((prev) => prev.map((x) => (x.id === id ? { ...x, [key]: value } : x)));
  const patchCount = (id, colId, value) => {
    const capped = num(value) > MAX_COUNT ? formatNumInput(String(MAX_COUNT)) : value;
    setRows((prev) =>
      prev.map((x) => (x.id === id ? { ...x, counts: { ...x.counts, [colId]: capped } } : x))
    );
  };
  // +/− 버튼. 0이 되면 빈 칸으로 되돌려 놓습니다 (0을 적어두는 것과 같은 뜻이라)
  const bump = (id, colId, delta) =>
    setRows((prev) =>
      prev.map((x) => {
        if (x.id !== id) return x;
        const next = Math.min(MAX_COUNT, Math.max(0, num(x.counts[colId]) + delta));
        return {
          ...x,
          counts: { ...x.counts, [colId]: next === 0 ? "" : formatNumInput(String(next)) },
        };
      })
    );
  /* ---------- 기록(영수증) ---------- */
  const appendLog = (entry) =>
    setLog((prev) => {
      const next = [...prev, { t: Date.now(), ...entry, id: entry.id || "L" + seq.current++ }];
      return next.length > LOG_CAP ? next.slice(next.length - LOG_CAP) : next;
    });

  /* 되돌리기 유예 — 방금 누른 칸의 연속 누름(버스트)을 부호와 함께 기억합니다.
     유예 중의 반대 버튼은 새로 적지 않고 마지막 누름을 기록까지 지우며 하나씩 되감습니다.
     ＋ 실수는 −로, − 실수는 ＋로 — 실수했을 때 손이 가는 그 버튼이 곧 조용한 복구입니다.
     시간이 다하면 두 버튼 다 평소처럼 기록되는 누름으로 돌아갑니다. */
  const [grace, setGrace] = useState(null); // {rowId, colId, dir, ids, until, key}
  /* 판단은 ref 로, 그림은 state 로 — 연타가 한 틱에 몰려도 되감기가 같은 줄을
     두 번 집지 않도록 유예 상태는 동기적으로 갱신해 둡니다 */
  const graceRef = useRef(null);
  const graceTimer = useRef(null);
  const putGrace = (g) => {
    graceRef.current = g;
    setGrace(g);
  };
  const startGrace = (rowId, colId, ids, dir) => {
    clearTimeout(graceTimer.current);
    graceTimer.current = setTimeout(() => putGrace(null), GRACE_MS);
    putGrace({
      rowId,
      colId,
      dir,
      ids,
      until: Date.now() + GRACE_MS,
      key: (graceRef.current ? graceRef.current.key : 0) + 1,
    });
  };
  const clearGrace = () => {
    clearTimeout(graceTimer.current);
    putGrace(null);
  };
  const graceActive = (row, colId) => {
    const g = graceRef.current;
    return (
      g && g.rowId === row.id && g.colId === colId && g.ids.length > 0 && Date.now() <= g.until
    );
  };

  /* 연타가 한 틱에 몰리면 rows 가 아직 안 갱신된 채로 다음 클릭이 들어옵니다.
     기록의 누적액이 밀리지 않도록, 렌더 사이의 변화를 그림자 값으로 들고 갑니다. */
  const live = useRef(null);
  live.current = { total: {}, n: {} };
  const liveTotal = (row) => live.current.total[row.id] ?? itemGold(row);
  const liveN = (row, colId) => live.current.n[row.id + ":" + colId] ?? num(row.counts[colId]);

  /* 유예 버스트의 마지막 누름을 기록까지 지우며 하나 되감습니다 */
  const undoLast = (row, col) => {
    const g = graceRef.current;
    const lastId = g.ids[g.ids.length - 1];
    const en = log.find((x) => x.id === lastId && !x.cancelled);
    if (!en) return false;
    live.current.n[row.id + ":" + col.id] = liveN(row, col.id) - en.n;
    live.current.total[row.id] = liveTotal(row) - en.delta;
    bump(row.id, col.id, -en.n);
    setLog((prev) => prev.filter((x) => x.id !== lastId));
    const ids = g.ids.slice(0, -1);
    if (ids.length) startGrace(row.id, col.id, ids, g.dir);
    else clearGrace();
    return true;
  };

  /* 카운터 셀의 ＋/−. 횟수를 움직이고 한 줄 남깁니다. 이름·항목은 나중에 지워져도
     읽히도록 그 시점 글자를 같이 적어 둡니다. 유예 중의 반대 버튼은 조용한 되감기. */
  const pressCell = (row, col, dir = 1) => {
    if (graceActive(row, col.id) && graceRef.current.dir === -dir && undoLast(row, col)) return;
    const before = liveN(row, col.id);
    if (dir > 0 ? before >= MAX_COUNT : before <= 0) return;
    const priceG = Math.round(goldOf(col.price));
    const after = liveTotal(row) + dir * priceG;
    live.current.n[row.id + ":" + col.id] = before + dir;
    live.current.total[row.id] = after;
    bump(row.id, col.id, dir);
    const id = "L" + seq.current++;
    appendLog({
      id,
      kind: "press",
      rowId: row.id,
      colId: col.id,
      n: dir,
      delta: dir * priceG,
      name: row.name,
      item: col.name,
      after,
    });
    const same = graceActive(row, col.id) && graceRef.current.dir === dir;
    startGrace(row.id, col.id, same ? [...graceRef.current.ids, id] : [id], dir);
  };

  /* 같은 사유의 기타 한 줄에 금액을 누적합니다. 0이 되면 줄 자체를 지웁니다. */
  const mergeExtra = (rowId, reason, diffG) =>
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
    const target = Math.round(targetG);
    const diff = target - liveTotal(row);
    if (!diff) return;
    live.current.total[row.id] = target;
    mergeExtra(row.id, EDIT_REASON, diff);
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
    if (en.cancelled || en.kind === "cancel") return;
    const row = rows.find((x) => x.id === en.rowId);
    if (!row) return;
    clearGrace(); // 유예 중인 줄을 모달에서 취소했을 때 이중 되감기를 막습니다
    let fromCounts = 0;
    if (en.colId && en.n) {
      const col = cols.find((c) => c.id === en.colId);
      if (col) {
        const priceG = Math.round(goldOf(col.price));
        const avail = liveN(row, en.colId);
        const next = Math.min(MAX_COUNT, Math.max(0, avail - en.n));
        if (next !== avail) {
          live.current.n[row.id + ":" + en.colId] = next;
          bump(row.id, en.colId, next - avail);
          fromCounts = (next - avail) * priceG;
        }
      }
    }
    const rest = -en.delta - fromCounts;
    if (rest) mergeExtra(en.rowId, en.kind === "edit" ? EDIT_REASON : CANCEL_REASON, rest);
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

  /* 새 행도 "(이름입력n)"으로 — 메모장에도 줄이 생기고, 카운터에도 이름 자리가 보입니다 */
  const addRow = () =>
    setRows((prev) => {
      const taken = new Set(prev.map((x) => x.name));
      let k = prev.length + 1;
      while (taken.has(FILL_NAME(k))) k++;
      return [
        ...prev,
        {
          id: "r" + seq.current++,
          name: FILL_NAME(k),
          counts: simple ? { [SIMPLE_ID]: "0" } : {},
          extras: [],
        },
      ];
    });
  const delRow = (id) => {
    const who = rows.find((x) => x.id === id);
    const nm = (who && who.name) || "이름 없는 인원";
    takeSnap("인원 삭제", `${nm}${josa(nm, "을", "를")} 지웠습니다.`);
    setRows((prev) => prev.filter((x) => x.id !== id));
    setOpenRow((o) => (o === id ? null : o));
  };

  /* 기타 벌금 */
  const addExtra = (rowId, amount, reason) =>
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

  /* 열 조작 */
  const patchCol = (id, key, value) =>
    setCols((prev) => prev.map((c) => (c.id === id ? { ...c, [key]: value } : c)));
  const addCol = () =>
    setCols((prev) => [...prev, { id: "c" + seq.current++, name: "", price: "10,000" }]);
  const delCol = (id) => {
    const col = cols.find((c) => c.id === id);
    const cn = (col && col.name) || "이름 없는 항목";
    takeSnap("항목 삭제", `항목 '${cn}'${josa(cn, "을", "를")} 지웠습니다.`);
    setCols((prev) => prev.filter((c) => c.id !== id));
    setRows((prev) =>
      prev.map((x) => {
        const { [id]: _drop, ...rest } = x.counts;
        return { ...x, counts: rest };
      })
    );
  };

  // 예시 데이터는 지금 보고 있는 모드의 것을 불러옵니다
  const reset = () => {
    takeSnap("예시 입력", "예시 데이터를 불러왔습니다.");
    setCols(DEFAULT_COLS);
    setRows(simple ? DEFAULT_ROWS_SIMPLE : DEFAULT_ROWS);
    setFeePercent("5");
    if (simple) setUnit("10000");
    setOpenRow(null);
    setLog([]); // 표가 새로 시작하니 영수증도 새로
    clearGrace();
    setMemoFreeze(null);
    clearHash();
  };

  // 실제로 쓰기 시작할 때. 인원·숫자는 비우고 항목은 기본값으로 되돌립니다.
  const clearAll = () => {
    takeSnap("초기화", "초기화했습니다.");
    setCols(DEFAULT_COLS);
    setRows(
      Array.from({ length: 4 }, (_, i) => ({
        id: "r" + seq.current++,
        name: FILL_NAME(i + 1),
        counts: { [SIMPLE_ID]: "0" },
        extras: [],
      }))
    );
    setOpenRow(null);
    setLog([]);
    clearGrace();
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
          ? "적어둔 금액과 메모장의 해당 줄이 함께 지워집니다."
          : "횟수와 기타 벌금이 함께 지워집니다."),
      onYes: () => delRow(row.id),
    });
  const askDelCol = (col) =>
    setAsk({
      title: "이 항목을 삭제할까요?",
      body: `${col.name || "이름 없는 항목"} 열과 모든 인원의 해당 횟수가 함께 지워집니다.`,
      onYes: () => delCol(col.id),
    });
  const askDelExtra = (row, ex) =>
    setAsk({
      title: "이 기타 벌금을 삭제할까요?",
      body: `${G(goldOf(ex.amount))} · ${ex.reason || "사유 없음"}`,
      onYes: () => delExtra(row.id, ex.id),
    });
  const askReset = () =>
    setAsk({
      title: "예시 데이터를 불러올까요?",
      body: "지금 적어둔 인원과 숫자가 모두 사라지고, 사용법을 보여주기 위한 예시 데이터로 바뀝니다.",
      action: "불러오기",
      onYes: reset,
    });
  const askClearAll = () =>
    setAsk({
      title: "표를 비울까요?",
      body: "인원과 숫자, 기타 벌금이 모두 지워집니다. 항목과 단가는 기본값으로 리셋됩니다.",
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

      {/* ── 머리 ─────────────────────────────────────── */}
      <header className="gs-mast">
        <div className="gs-eyebrow">
          <span>MAIL SETTLEMENT</span>
          <i />
        </div>
        <div className="gs-mastrow">
          <h1 className="gs-title">벌금 정산</h1>
          <div className="gs-mastside">
            {tabbed && (
              <nav className="gs-tabs" aria-label="화면 선택">
                {[
                  { k: "sheet", label: "벌금표" },
                  { k: "ledger", label: "정산 장부" },
                  { k: "mail", label: "보낼 우편" },
                ].map((t) => (
                  <button
                    key={t.k}
                    className={"gs-tab" + (tab === t.k ? " on" : "")}
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
                ))}
              </nav>
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
                  <b>탭으로 보기</b> — 한 번에 한 카드만 크게 봅니다.
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
                  <b>세로로 이어 보기</b> — 세 카드를 한 페이지에 잇습니다.
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
                      ? "시스템 설정을 따릅니다"
                      : theme === "light"
                      ? "밝게 고정"
                      : "어둡게 고정"}
                  </b>{" "}
                  — 눌러서 {theme === "system" ? "밝게" : theme === "light" ? "어둡게" : "시스템"}
                  로 바꿉니다.
                </span>
              </span>
            </span>
          </div>
        </div>
      </header>

      {/* ── 벌금표 ───────────────────────────────────── */}
      {showSheet && (
      <section className="gs-card">
        <div className="gs-cardhead">
          <div className="gs-headleft">
            <h2 className="gs-h2">벌금표</h2>
            <span className="gs-caplab">모드</span>
            <div className="gs-seg" role="group" aria-label="모드">
              <span className="gs-tip">
                <button className={simple ? "on" : ""} onClick={() => changeMode("simple")}>
                  메모장
                </button>
                <span className="gs-tip-body" role="tooltip">
                  '로마러 25'처럼 <b>한 줄에 한 사람씩</b> 적으면 표가 됩니다.
                </span>
              </span>
              <span className="gs-tip">
                <button className={simple ? "" : "on"} onClick={() => changeMode("items")}>
                  카운터
                </button>
                <span className="gs-tip-body" role="tooltip">
                  칸의 <b>＋를 눌러 셉니다.</b> 항목마다 1회당 단가를 정해 둡니다.
                </span>
              </span>
            </div>
            {!simple && (
              <button
                className={"gs-btn gs-btn-ghost" + (showLog ? " gs-logbtn-on" : "")}
                onClick={() => openLog(null)}
                aria-haspopup="dialog"
              >
                기록
                {log.length > 0 && <em>{log.length}</em>}
              </button>
            )}
          </div>

          {/* 버튼은 성격끼리 묶고, 글자 수는 버튼 안으로 넣어 줄을 흐트러뜨리지 않습니다 */}
          <div className="gs-tools">
            {/* 파괴적인 둘은 자주 쓰는 버튼과 사이를 벌려 둡니다 (오클릭 방지) */}
            <span className="gs-grp gs-grp-risky">
              <button className="gs-btn gs-btn-ghost gs-btn-warn" onClick={askClearAll}>
                초기화
              </button>
              <button className="gs-btn gs-btn-ghost" onClick={askReset}>
                예시 입력
              </button>
            </span>
            <span className="gs-grp">
              {/* 금액만 모드에서는 이 버튼이 메모장 머리로 올라갑니다 */}
              {!simple && chatLine && <ChatCopyBtn line={chatLine} flash={flash} onCopy={copyChat} />}
              <button className="gs-btn" onClick={copyLink}>
                {flash === "link" ? "복사됨" : canOwnUrl ? "공유 링크" : "공유 코드"}
              </button>
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

        {/* 사고 직후의 안내 쪽지 — 버튼 줄을 밀지 않도록 헤더 아래 한 줄로 붙습니다.
            표를 고치기 시작하면 조용히 사라집니다. */}
        {undoSnap && (
          <div className="gs-slip" role="status">
            <span className="gs-slip-msg">{undoSnap.msg || `${undoSnap.label} 했습니다`}</span>
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

        {simple && (
          <div className="gs-unitbar">
            <span className="gs-caplab">입력 단위</span>
            {UNITS.map((u) => (
              <label key={u.v} className={unit === u.v ? "on" : ""}>
                <input
                  type="radio"
                  name="gs-unit"
                  checked={unit === u.v}
                  onChange={() => setUnit(u.v)}
                />
                {u.label}
              </label>
            ))}
            <span className="gs-unitnote">칸에 적은 숫자 하나가 이 금액입니다.</span>
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
                {chatLine && <ChatCopyBtn line={chatLine} flash={flash} onCopy={copyChat} />}
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
                        value={c.name}
                        placeholder="항목명"
                        onChange={(e) => patchCol(c.id, "name", e.target.value)}
                        aria-label="항목 이름"
                      />
                      <button
                        className="gs-x"
                        onClick={() => askDelCol(c)}
                        aria-label={`${c.name || "항목"} 열 삭제`}
                      >
                        ×
                      </button>
                    </div>
                    <div className="gs-colh-price">
                      <span>1회</span>
                      <NumInput
                        className="gs-in gs-in-price"
                        value={c.price}
                        onChange={(v) => patchCol(c.id, "price", v)}
                        aria-label="1회당 단가 (G)"
                      />
                      <span>G</span>
                    </div>
                  </th>
                ))}
                {!simple && (
                  <th className="gs-addcolh">
                    {/* 도움말을 따로 두지 않고 버튼 자체에 얹습니다 */}
                    <span className="gs-tip">
                      <button className="gs-addcol" onClick={addCol}>
                        + 항목
                      </button>
                      <span className="gs-tip-body" role="tooltip">
                        <b>항목</b>은 벌금 사유입니다. 1회당 단가를 정해두고, 칸의 ＋를 누르면 1회씩
                        쌓입니다.
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
                          항목으로 쪼갤 수 없는 즉석 벌금입니다. 횟수가 아니라 금액을 그대로
                          적습니다.
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
                          {!simple && (
                            <button
                              className="gs-rowlog gs-rowdel"
                              onClick={() => openLog(row.id)}
                              aria-haspopup="dialog"
                              aria-label={`${row.name || "이 사람"}의 기록 보기`}
                            >
                              기록
                            </button>
                          )}
                          <button
                            className="gs-x gs-rowdel"
                            onClick={() => askDelRow(row)}
                            aria-label={`${row.name || "이 사람"} 삭제`}
                          >
                            ×
                          </button>
                        </div>
                      </th>
                      {activeCols.map((c) => {
                        const cnt = row.counts[c.id] ?? "";
                        const n = num(cnt);
                        if (!simple) {
                          /* ↩는 어느 쪽 실수든 항상 셀 오른쪽 같은 자리 — 방금 누른 것을
                             반대 방향으로 하나씩, 기록까지 지우며 되감습니다. */
                          const g0 = grace && grace.rowId === row.id && grace.colId === c.id;
                          return (
                            <td key={c.id}>
                              {/* 카운터 칸 — 누르는 게 곧 1회. 숫자 입력 대신 ＋와 ×N 만 둡니다.
                                  누른 직후의 −는 기록 없는 되돌리기(게이지가 남은 동안),
                                  그 뒤의 −는 기록되는 빼기입니다. */}
                              <div className="gs-hitwrap">
                                <button
                                  className={"gs-hit" + (n > 0 ? " gs-hit-on" : "")}
                                  onClick={() => pressCell(row, c, 1)}
                                  aria-label={`${row.name || "이 사람"}의 ${c.name || "항목"} 1회 추가`}
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
                                <button
                                  className="gs-step gs-hit-minus"
                                  tabIndex={-1}
                                  onClick={() => pressCell(row, c, -1)}
                                  aria-label={`${c.name || "항목"} 1 줄이기`}
                                >
                                  −
                                </button>
                                {g0 && (
                                  <button
                                    key={"u" + grace.key}
                                    className="gs-step gs-hit-undo"
                                    tabIndex={-1}
                                    onClick={() => pressCell(row, c, -grace.dir)}
                                    aria-label="방금 누른 것 되돌리기"
                                  >
                                    ↩
                                    <svg className="gs-grace-ring" viewBox="0 0 24 24" aria-hidden="true">
                                      {/* 12시에서 시작해 시계 방향으로 도는 경로 — 시계·쿨다운의 문법 */}
                                      <path
                                        d="M12 1 H20 A3 3 0 0 1 23 4 V20 A3 3 0 0 1 20 23 H4 A3 3 0 0 1 1 20 V4 A3 3 0 0 1 4 1 H12"
                                        pathLength="100"
                                      />
                                    </svg>
                                  </button>
                                )}
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
                      {!simple && <td className="gs-addcolcell" />}
                      {!simple && (
                      <td className="gs-disc">
                        <button
                          className="gs-disc-btn"
                          onClick={() => setOpenRow(open ? null : row.id)}
                          aria-expanded={open}
                          aria-label={`${row.name || "이 사람"}의 기타 벌금 ${
                            ex.length ? `${ex.length}건, ${won(exSum)}G` : "없음, 추가하기"
                          }`}
                        >
                          {ex.length === 0 ? (
                            <span className="gs-disc-add">＋ 금액</span>
                          ) : (
                            <>
                              <span className="gs-disc-amt">{won(exSum)}</span>
                              <span className="gs-disc-sub">
                                {ex.length === 1
                                  ? ex[0].reason || "사유 없음"
                                  : `${ex.length}건 ${open ? "접기" : "펼치기"}`}
                              </span>
                            </>
                          )}
                        </button>
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
                            onCommit={(g) => editTotal(row, g)}
                          />
                        </td>
                      )}
                    </tr>

                    {!simple && open && (
                      <tr className="gs-exrow">
                        <td colSpan={cols.length + 4}>
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
                  <button className="gs-add" onClick={addRow}>
                    + 인원 추가
                  </button>
                </th>
                <td colSpan={simple ? 2 : cols.length + 3} />
              </tr>
            </tbody>

            <tfoot>
              <tr>
                <th className="gs-stick gs-l">
                  <span className="gs-caplab">{simple ? "합계" : "항목 합계"}</span>
                </th>
                {activeCols.map((c) => (
                  <td key={c.id} className="gs-foot">
                    {r ? won(r.colTotals[c.id]) : "0"}
                  </td>
                ))}
                {!simple && <td className="gs-addcolcell" />}
                {!simple && (
                  <td className="gs-foot gs-foot-disc">{r ? won(r.discTotal) : "0"}</td>
                )}
                <td className="gs-foot gs-foot-grand">{r ? won(r.total) : "0"}</td>
              </tr>
            </tfoot>
          </table>
        </div>
        </div>

      </section>
      )}

      {/* ── 장부 ─────────────────────────────────────── */}
      {showLedger && r && (
        <section className="gs-card">
          <div className="gs-cardhead">
            <h2 className="gs-h2">정산 장부</h2>
            <span className="gs-unit">단위: G(골드)</span>
          </div>
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
        </section>
      )}

      {/* 탭 화면에서 장부에 보여줄 사람이 아직 없을 때 */}
      {showLedger && !r && tabbed && (
        <section className="gs-card">
          <div className="gs-cardhead">
            <h2 className="gs-h2">정산 장부</h2>
          </div>
          <div className="gs-empty">
            <p>정산할 사람이 없습니다.</p>
            <p className="gs-empty-sub">벌금표에 인원을 적으면 장부가 여기에 만들어집니다.</p>
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
            <label className="gs-fee">
              <span>수수료</span>
              <NumInput
                className="gs-in gs-in-fee"
                value={feePercent}
                onChange={setFeePercent}
                aria-label="우편 수수료 (%)"
              />
              <span>%</span>
            </label>
          </div>
        </div>

        {!r || r.transfers.length === 0 ? (
          <div className="gs-empty">
            <p>보낼 우편이 없습니다.</p>
            <p className="gs-empty-sub">벌금표를 채우면 송금 조합이 여기에 만들어집니다.</p>
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
                  송금 <b>{r.transfers.length}회</b>. 더 줄일 수 없는 최소 횟수입니다.
                </>
              ) : (
                <>송금 {r.transfers.length}회. 인원이 15명을 넘어 근사 계산입니다.</>
              )}{" "}
              이동 {G(r.moved)} · 수수료 {G(r.feeTotal)}.
            </p>
          </>
        )}
      </section>
      )}

      {/* ── 첫 방문: 모드 선택 ─────────────────────────── */}
      {intro && (
        <div className="gs-intro" role="dialog" aria-modal="true" aria-label="모드 선택">
          <div className="gs-intro-in">
            <div className="gs-eyebrow">
              <span>MAIL SETTLEMENT</span>
              <i />
            </div>
            <h1 className="gs-title">벌금 정산</h1>
            <p className="gs-intro-lead">
              걷은 벌금을 나누고 보낼 우편까지 계산해 주는 장부입니다.
              <br />
              표를 어떻게 적을지 골라 주세요. 나중에 언제든 바꿀 수 있습니다.
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
                  이름과 금액을 한 줄에 하나씩 적으면 표가 됩니다. 받아 적기가 빠를 때, 채팅을
                  붙여넣을 때.
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
                  잡힘·죽음처럼 항목과 단가를 정해두고, 사고가 날 때마다 칸의 ＋ 한 번. 방송
                  중 실시간으로 셀 때.
                </span>
              </button>
            </div>
            <p className="gs-intro-foot">
              정산 장부와 보낼 우편은 표에서 자동으로 만들어집니다. 두 모드는 서로 변환됩니다.
            </p>
          </div>
        </div>
      )}

      {showHelp && (
        <InfoModal title="사용법" onClose={() => setShowHelp(false)}>
          <ul className="gs-help">
            <li>
              <b>탭 · 세로 보기</b> — 제목 오른쪽 아이콘으로 바꿉니다.
            </li>
            <li>
              <b>앱으로 설치</b> — 주소창 오른쪽 설치 아이콘을 누르면 브라우저 껍데기 없는 창으로
              뜹니다. 방송 화면에 표만 잡히고, 인터넷이 끊겨도 열립니다.
            </li>
            <li>
              <b>메모장 ↔ 카운터</b> — 표가 그대로 변환됩니다. 카운터의 횟수 구성은 동결됐다가
              돌아올 때 이름으로 대조해 복원되고, 메모장에서 고친 차액만 기타·기록에 남습니다.
            </li>
            <li>
              <b>카운터</b> — 칸의 ＋가 1회, 올리면 나오는 −가 빼기. 누른 직후 5초는 반대
              버튼이 기록 없는 되돌리기입니다. 합계를 누르면 직접 수정(차액은 기타로).
            </li>
            <li>
              <b>기록</b> — ＋·수정이 한 줄씩 남고, 어떤 줄이든 취소하면 반대 기록이 붙습니다.
            </li>
            <li>
              <b>실수 복구</b> — 인원·항목 삭제, 초기화, 예시 입력 직후엔 ↩ 되돌리기가 떠
              있습니다. 표를 고치기 시작하면 사라집니다.
            </li>
            <li>
              <b>초기화</b> — 인원과 숫자를 비웁니다.
            </li>
            <li>
              <b>예시 입력</b> — 예시 데이터를 불러옵니다.
            </li>
            <li>
              <b>채팅 공유용 복사</b> — 이름과 벌금을 만 단위로 한 줄에 잇습니다. {CHAT_LIMIT}자가
              넘으면 이름을 줄입니다.
            </li>
            <li>
              <b>{canOwnUrl ? "공유 링크" : "공유 코드"}</b> — 표가 통째로 담긴{" "}
              {canOwnUrl ? "주소" : "코드"}입니다. 메모장에 붙여넣으면 열립니다.
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
              최근 {LOG_CAP}줄 · 취소는 줄을 지우지 않고 반대 기록을 덧붙입니다
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
                ? "이 사람의 기록이 없습니다."
                : "아직 기록이 없습니다. 칸의 ＋를 누르면 쌓입니다."}
            </p>
          ) : (
            <ul className="gs-log-list">
              {[...shownLog].reverse().map((en) => (
                <li key={en.id} className={en.cancelled ? "gs-log-xed" : ""}>
                  <span className="gs-log-t">{hhmm(en.t)}</span>
                  <span className="gs-log-nm">{en.name || "이름 없음"}</span>
                  <span className="gs-log-what">
                    {en.kind === "press" && `${en.item || "항목"} ${signedMan(en.delta)}`}
                    {en.kind === "edit" && `직접 수정 ${signedMan(en.delta)}`}
                    {en.kind === "memo" && `메모장에서 수정 ${signedMan(en.delta)}`}
                    {en.kind === "memo-new" && `메모장에서 추가 ${signedMan(en.delta)}`}
                    {en.kind === "memo-del" && `메모장에서 제외 ${signedMan(en.delta)}`}
                    {en.kind === "cancel" &&
                      `취소 — ${en.item ? en.item + " " : ""}${signedMan(en.delta)}`}
                  </span>
                  <span className="gs-log-after">→ {man(en.after)}</span>
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
            총무를 거치면 같은 돈이 우편을 두 번 타서 수수료를 두 번 떼입니다.{" "}
            <b>{G(r.hubFee - r.feeTotal)}</b> 차이입니다.
          </p>
        </InfoModal>
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
    <button className="gs-btn gs-btn-ghost" onClick={onCopy}>
      {flash === "chat" ? (
        "복사됨"
      ) : (
        <>
          채팅 공유용 복사
          <em className={line.length > CHAT_LIMIT ? "gs-over" : ""}>
            {line.length}/{CHAT_LIMIT}
          </em>
        </>
      )}
    </button>
  );
}

/* 카운터의 합계 칸 — 눌러서 고치고, blur/Enter 에 확정합니다. 차액은 기타 '직접 수정'으로.
   Esc 는 버립니다. */
function TotalEdit({ display, base, onCommit }) {
  const [draft, setDraft] = useState(null); // null = 안 고치는 중
  const esc = useRef(false);
  if (draft === null)
    return (
      <button
        className="gs-sumedit"
        onClick={() => setDraft(base > 0 ? formatNumInput(String(base)) : "")}
        aria-label="합계 직접 수정 (G)"
      >
        {won(display)}
      </button>
    );
  return (
    <input
      className="gs-in gs-sumedit-in"
      value={draft}
      autoFocus
      inputMode="numeric"
      onFocus={(e) => e.target.select()}
      onChange={(e) => setDraft(formatNumInput(e.target.value))}
      onBlur={() => {
        if (!esc.current) onCommit(Math.round(num(draft)));
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
      aria-label="합계 (G)"
    />
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
        <h3>송금 명세서</h3>
        <p>디스코드 등에 붙여넣으세요. 고쳐서 복사해도 됩니다.</p>
        <textarea ref={ta} className="gs-ta" defaultValue={text} spellCheck={false} />
        <div className="gs-dialog-btns">
          <button className="gs-btn gs-btn-ghost" onClick={onClose}>
            닫기
          </button>
          <button className="gs-btn" onClick={() => onCopy(ta.current.value)}>
            {copied ? "복사됨" : "복사"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* 설명을 카드 안에서 펼치는 대신 띄우는 창 — 탭 화면에서 표가 밀리지 않게 팝업으로 봅니다 */
function InfoModal({ title, onClose, children, wide }) {
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
        <h3>{title}</h3>
        {children}
        <div className="gs-dialog-btns">
          <button className="gs-btn gs-btn-ghost" onClick={onClose}>
            닫기
          </button>
        </div>
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
      <div className="gs-dialog" role="alertdialog" aria-modal="true" aria-label={ask.title}>
        <h3>{ask.title}</h3>
        {ask.body && <p>{ask.body}</p>}
        <div className="gs-dialog-btns">
          <button className="gs-btn gs-btn-ghost" onClick={onCancel}>
            취소
          </button>
          <button
            ref={yesRef}
            className="gs-btn gs-btn-danger"
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
                placeholder="사유(ex. 암살 등. 비워두셔도 됩니다.)"
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
          placeholder="사유(ex. 암살 등. 비워두셔도 됩니다.)"
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
.gs-tools{display:flex; align-items:center; gap:8px; flex-wrap:wrap}
.gs-btn{font:inherit; font-size:12.5px; letter-spacing:.04em; cursor:pointer; padding:8px 14px;
  border:1px solid var(--chip-bg); background:var(--chip-bg); color:var(--chip-fg); border-radius:2px;
  white-space:nowrap}
.gs-btn:hover{background:var(--ink-hover)}
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
.gs-dialog{width:100%; max-width:376px; background:var(--paper); border:1px solid var(--kraft-dk);
  padding:20px 20px 16px; box-shadow:0 16px 44px rgba(var(--shadow-rgb),.4)}
.gs-dialog h3{margin:0; font-family:'Gowun Batang',serif; font-size:17px; font-weight:700}
.gs-dialog p{margin:9px 0 0; font-size:12.5px; line-height:1.8; color:var(--ink-body)}
.gs-dialog-btns{display:flex; justify-content:flex-end; gap:8px; margin-top:18px}
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
.gs-addcol{border:0; background:transparent; font:inherit; font-size:12px; color:rgba(var(--ink-rgb),.42);
  cursor:pointer; padding:5px 4px; letter-spacing:.03em; white-space:nowrap; border-radius:2px}
.gs-addcol:hover{color:var(--ink); background:rgba(var(--ink-rgb),.07)}
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
.gs-grid-count .gs-sumcell{font-size:25px; min-width:10ch}
.gs-grid-count td.gs-disc{min-width:88px}
.gs-hitwrap{position:relative; display:flex; padding:6px 4px}
/* 숫자 중심 셀 — 누르기 전엔 옅은 ＋, 누른 뒤엔 가운데 큰 횟수가 주인공입니다 */
.gs-hit{font:inherit; color:var(--ink); cursor:pointer; display:flex; align-items:center; justify-content:center;
  width:100%; min-height:56px; padding:6px 10px; border-radius:3px;
  border:1px dashed rgba(var(--kraftdk-rgb),.85); background:var(--cell)}
.gs-hit:hover{background:var(--cell-hover); border-color:var(--ink)}
.gs-hit:active{transform:scale(.96)}
.gs-hit-on{border-style:solid; background:var(--cell-on)}
.gs-hit-ghost{font-size:18px; line-height:1; color:rgba(var(--kraftdk-rgb),.95)}
.gs-hit:hover .gs-hit-ghost{color:var(--ink-2)}
/* 폭 4ch 를 예약해 두면 가운데 숫자라 자릿수가 늘어도 표가 안 밀립니다 */
.gs-hit-num{min-width:4ch; text-align:center; white-space:nowrap; font-family:var(--mono);
  font-size:25px; line-height:1; color:var(--ink); animation:gs-npop .16s ease-out}
.gs-hit-num em{font-style:normal; font-size:12px; color:var(--ink-2); margin-left:5px}
@keyframes gs-npop{from{transform:scale(1.35)} to{transform:scale(1)}}
/* 빼기는 칸 왼쪽에 숨어 있다가 행에 올리면 나옵니다 (기존 gs-step 규칙이 보여줍니다) */
.gs-hit-minus{position:absolute; left:10px; top:50%; transform:translateY(-50%); z-index:1}
/* 되돌리기 ↩ — ＋든 −든 누른 직후 5초 동안 항상 셀 오른쪽 같은 자리에 나타나고,
   테두리를 도는 빨간 사각 링이 다 돌면 조용한 되돌리기 시간이 끝난 것입니다.
   .gs-step 기본 숨김(opacity:0)을 확실히 이기도록 겹친 선택자로 씁니다.
   시간은 GRACE_MS(5초)와 맞춥니다. */
.gs-step.gs-hit-undo{position:absolute; right:10px; top:50%; transform:translateY(-50%);
  z-index:1; opacity:1; color:var(--red); width:24px; height:24px; padding:0;
  border-radius:3px; font-size:13px; line-height:1}
.gs-grace-ring{position:absolute; inset:0; width:100%; height:100%; pointer-events:none}
/* 음수 offset 이라야 빈 부분이 경로 시작점(12시)에서 시계 방향으로 먹어 들어갑니다 */
.gs-grace-ring path{fill:none; stroke:var(--red); stroke-width:2;
  stroke-dasharray:100; stroke-dashoffset:0; animation:gs-ring 5s linear forwards}
@keyframes gs-ring{to{stroke-dashoffset:-100}}
@media (prefers-reduced-motion:reduce){
  .gs-hit-num{animation:none}
}

/* 합계 직접 수정 — 글자를 누르면 입력칸으로 바뀝니다 */
.gs-sumedit{font:inherit; font-family:var(--mono); font-size:inherit; color:inherit;
  border:0; background:transparent; cursor:pointer; padding:9px 0; width:100%; text-align:right;
  border-bottom:1px dashed rgba(var(--gold-rgb),.35)}
.gs-sumedit:hover{border-bottom-color:var(--gold)}
.gs-sumedit-in{font-family:var(--mono); font-size:inherit; color:var(--gold); text-align:right;
  width:100%; min-width:9ch; padding:9px 0}

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
.gs-colh{min-width:132px; padding:0 6px !important}
/* 열이 넓어져도 항목명과 × 가 서로 떨어지지 않도록 묶어 둡니다 */
.gs-colh-top{display:flex; align-items:center; justify-content:center; gap:2px;
  max-width:132px; margin:0 auto}
.gs-in-col{font-size:13.5px; font-weight:600; text-align:center; padding:4px 0}
.gs-colh-price{display:flex; align-items:center; justify-content:center; gap:3px;
  font-size:10px; color:var(--ink-2); margin-top:1px; white-space:nowrap}
.gs-in-price{font-family:var(--mono); font-size:12.5px; width:66px; text-align:center;
  padding:2px 0; border-bottom:1px dotted rgba(var(--ink-rgb),.5); color:var(--gold)}
.gs-disch{min-width:132px}
.gs-disch-top{display:flex; align-items:center; justify-content:center; gap:5px;
  font-size:13.5px; font-weight:600; padding:4px 0; color:var(--red)}
.gs-unit{font-size:12.5px; letter-spacing:.06em; color:var(--ink-2)}
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
.gs-disc-btn{width:100%; border:0; background:transparent; font:inherit; cursor:pointer;
  padding:7px 4px; border-radius:2px; display:block; text-align:center}
.gs-disc-btn:hover{background:rgba(var(--red-rgb),.08)}
/* 셀의 ＋(횟수)와 헷갈리지 않게 글자로 적습니다 — 여기는 금액을 그대로 넣는 곳 */
.gs-disc-add{font-size:12px; color:rgba(var(--ink-rgb),.38); white-space:nowrap}
.gs-disc-btn:hover .gs-disc-add{color:var(--red)}
.gs-disc-amt{display:block; font-family:var(--mono); font-size:15px; color:var(--red)}
.gs-disc-sub{display:block; font-size:10.5px; color:var(--ink-2); margin-top:2px;
  max-width:124px; margin-inline:auto; overflow:hidden; text-overflow:ellipsis; white-space:nowrap}

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
