/* 벌금 현황판 릴레이 v2 — 계정·로비.
   진본은 여전히 방장(서기) 브라우저의 localStorage 입니다. 서버는 릴레이 + 신원부입니다.
   주소(URL)는 읽기 권한까지만 나르고, 쓰기(장부 push·자수·수락)는 전부 로그인 세션입니다 —
   게임 화면에 찍히는 주소창에 실린 권한은 유출된 것으로 봅니다.
   Accounts DO 하나가 계정·세션·OBS 토큰을 갖고, 방 하나마다 Room DO 하나가 판과 명단을 갖습니다. */

import { PAGE_HTML, APP_URL } from "./page.js";
import { PAUSE_IDLE_MS, STATE_IDLE_MS, shouldAutoPause, nextRoomAlarm } from "./round.js";

const ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789"; // 헷갈리는 글자(I,L,O,U,0,1) 제외
const CH = "[ABCDEFGHJKMNPQRSTVWXYZ23456789]";
const ID6 = CH + "{6}";
const TOK20 = CH + "{20}";
const rid = (n) =>
  Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => ALPHABET[b % ALPHABET.length]).join("");
/* 익명 계정의 아이디 — 사람이 고를 리 없는 20자입니다. 저장 경로는 가입 계정과 같아서
   (계정 하나 = u:<id>) 인증 통로가 갈라지지 않습니다 (§3-11) */
const LOW = "abcdefghijklmnopqrstuvwxyz0123456789";
const anonId = () =>
  "a" + Array.from(crypto.getRandomValues(new Uint8Array(19)), (b) => LOW[b % LOW.length]).join("");

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,PUT,OPTIONS",
  "access-control-allow-headers": "authorization,content-type",
};
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...CORS },
  });

/* 수명 (§1) */
const SESSION_MS = 90 * 86400 * 1000;
/* 초대의 수명 (2026-09-20 사용자) — 만료는 "어제 파티와 오늘 파티"를 가르는 경계다. 한 판보다 길고 다음 날보다 짧아야 한다 */
const INVITE_MS = 12 * 3600 * 1000;
/* 코드 색인(계정부)은 방을 찾는 포인터일 뿐이고 유효는 방이 판단합니다 (2026-09-06) — 넉넉히 둡니다 */
const INVITE_INDEX_MS = 7 * 86400 * 1000;
/* 판의 수명 판단(자동 중단 24시간·판 삭제 90일)은 round.js 가 갖고 있습니다 */
const ACCT_IDLE_MS = 365 * 86400 * 1000;
const ACCT_SCAN_MS = 7 * 86400 * 1000;

/* 상태 크기 상한 — 표에 더해 기록(최근 200건)까지 실립니다. 남용 방지용 */
const MAX_STATE_BYTES = 128 * 1024;
/* 계정부에 오는 본문은 전부 작습니다 — 외형(4KB)이 제일 큽니다 */
const MAX_AUTH_BYTES = 32 * 1024;
/* 올린 초상화 (§3.12.3, 2026-09-16) — 128px JPEG 데이터 URL. 계정부 본문 상한과 별도로 이 길이만 받는다 */
const MAX_PIC_BYTES = 64 * 1024;
const LOOK_MAX_BYTES = 4 * 1024;
const CONFESS_PER_MIN = 20;
/* 자수 되돌리기 창 (§3.6, 2026-09-05) — 내가 방금 올린 것만 30초 안에 −1 로 되돌립니다.
   그 뒤의 조정은 방장의 일입니다. 자기 벌금을 나중에 슬쩍 깎는 길을 막습니다 */
const CONFESS_UNDO_MS = 30 * 1000;
/* 자수의 왕복이 방장 생사의 증거입니다 (LIVE-SPEC §2.4). 소켓이 열려 있다는 사실은
   증거가 못 됩니다 — 방장의 인터넷이나 PC 가 죽으면 닫힘 신호가 안 오고, ping 은
   런타임이 대신 답해서(하이버네이션 유지) 서버가 그것으로도 생사를 못 봅니다.
   자수를 서기에게 넘긴 뒤 이 시간 안에 판이 안 돌아오면 서기를 죽은 것으로 봅니다.
   왕복이 0.2~0.3초로 줄어든 뒤의 값이라 열 배 여유입니다 */
const SCRIBE_ACK_MS = 3000;
/* 지목 초대는 1분짜리 실시간 악수입니다 (§3.3) — 만료를 알리는 배관은 없고,
   지난 것은 읽을 때 버립니다. 다시 지목하면 그만입니다 */
const INV_MS = 60 * 1000;
const INVITE_PER_MIN = 10;
/* 함께한 사람 — 최근 함께한 순 30명, 넘치면 오래된 것부터 밀립니다 (§3.3) */
const MATES_MAX = 30;
const LOGIN_FAILS = 30;
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
/* 계정 만들기(가입·익명) 한 창 상한 — 익명이 가입보다 헐거운 구멍이 되지 않게 같이 셉니다 */
const REG_PER_WINDOW = 200;
/* seen 을 다시 적기까지 건너뛰는 시간 (§4.1) — 유휴 오버레이의 1분 폴링이 그대로
   스토리지 쓰기가 되지 않게 합니다. 계정 청소 기준이 1년이라 반나절이면 넉넉합니다 */
const SEEN_SKIP_MS = 12 * 3600 * 1000;
/* 방송용 주소 재발급 — 계정당 하루 몇 번 (§4.1). 주소가 샜을 때 쓰는 문이라 평생 몇
   번이면 충분하고, 반복 호출은 계정부(전역 DO 하나)에 쓰기를 몰아 다른 사람의
   로그인·참여까지 느리게 만듭니다 */
const REISSUE_WINDOW_MS = 24 * 3600 * 1000;
const REISSUE_PER_WINDOW = 5;
/* 게스트가 닉을 안 보냈을 때의 이름. 예전 값은 "방장"이었는데, 게스트로도 남의 파티에
   들어갈 수 있게 되면서 명단에 방장이 둘 앉는 그림이 됐습니다 (§3.11) */
const ANON_NICK = "손님";
/* 디스코드 연동 (§3.12.1·§3.12.9). 상태값 10분, 1회용 코드 2분. 범위는 identify 하나 */
const DS_MS = 10 * 60 * 1000;
const DCX_MS = 2 * 60 * 1000;
const DISCORD_AUTH = "https://discord.com/oauth2/authorize";
const DISCORD_TOKEN = "https://discord.com/api/oauth2/token";
const DISCORD_ME = "https://discord.com/api/users/@me";
/* 접속 기반 송출 (§3.12.6) — 마지막 앱 소켓이 끊기고 이만큼 지나야 "안 붙어 있음"으로 봅니다.
   새로고침 한 번에 방송이 내 판으로 깜빡였다 돌아오지 않게 하는 여유입니다 */
const PRESENCE_GRACE_MS = 20 * 1000;
/* 앱이 돌아갈 곳 — 운영은 page.js 의 APP_URL, 로컬 워커(127.0.0.1:8787)면 로컬 앱 */
const appOrigin = (req) => {
  const h = new URL(req.headers.get("x-origin") || req.url).hostname;
  return h === "127.0.0.1" || h === "localhost" ? "http://localhost:5175/" : APP_URL;
};

const RE_ID = /^[a-z0-9]{4,20}$/;
const RE_NICK = /^[가-힣a-zA-Z0-9]{2,3}$/;
/* Discord 사용자명은 앞 두 글자만 (2026-09-17). 전문은 계정부 밖으로 안 나간다 */
const maskUser = (u) => (u && u.dc && u.dc.user ? Array.from(u.dc.user).slice(0, 2).join("") + "••••" : "");
const RE_PW = /^[0-9a-f]{64}$/; // 클라이언트가 PBKDF2 로 미리 접은 32바이트
const DEMO_ROOM = "CAFE22"; // 페이지가 스스로 굴리는 예시 방 — 진짜 방에 내주지 않습니다

/* ---------------- 메인 fetch — 인증을 풀어 DO 로 넘깁니다 ---------------- */

const accountsDO = (env) => env.ACCOUNTS.get(env.ACCOUNTS.idFromName("global"));
const roomDO = (env, id) => env.ROOM.get(env.ROOM.idFromName(id));

const call = async (stub, path, body) => {
  const r = await stub.fetch("https://do" + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  const data = await r.json().catch(() => null);
  return { ok: r.ok, status: r.status, data };
};

const bearer = (req) => {
  const m = (req.headers.get("authorization") || "").match(/^Bearer\s+(\S+)$/i);
  return m ? m[1] : null;
};

/* 세션 → 계정. 방 API 의 x-acct 는 여기서만 붙습니다 (밖에서 들어온 건 지웁니다) */
const verify = async (env, token) => {
  if (!token) return null;
  const r = await call(accountsDO(env), "/verify", { token });
  return r.ok && r.data && r.data.id ? r.data : null;
};

const toRoom = async (env, roomId, path, req, me) => {
  const h = new Headers(req.headers);
  h.delete("x-acct");
  h.delete("x-nick");
  h.delete("x-dcu");
  h.delete("upgrade");
  h.delete("connection");
  if (me) {
    h.set("x-acct", me.id);
    h.set("x-nick", encodeURIComponent(me.nick || ""));
    h.set("x-dcu", encodeURIComponent(me.dcu || ""));
  }
  h.set("x-room", roomId);
  const body = req.method === "GET" || req.method === "HEAD" ? undefined : await req.text();
  return roomDO(env, roomId).fetch("https://do" + path, { method: req.method, headers: h, body });
};

const servePage = (roomId, otok) =>
  new Response(
    PAGE_HTML.replaceAll("__ROOM__", roomId).replaceAll("__OTOK__", otok).replaceAll("__APP__", APP_URL),
    { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" } }
  );

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const p = url.pathname;
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    /* 계정부 — Bearer 는 Accounts DO 가 직접 풉니다 (왕복 한 번으로 끝납니다).
       지목 초대도 계정부에 삽니다 — 함께한 사람이 계정에 붙어 있어서요 (§3.3) */
    if (
      p.startsWith("/api/auth/") ||
      p.startsWith("/api/pic/") ||
      p === "/api/invite" ||
      new RegExp(`^/api/o/${TOK20}/resolve$`).test(p) ||
      /^\/api\/j\/[A-Z0-9]{8}\/resolve$/i.test(p)
    )
    {
      /* 쿼리(디스코드 콜백의 code·state)와 공개 출처(콜백 주소·앱 주소 계산)를 DO 에 넘깁니다 (§3.12.9) */
      const fwd = new Request("https://do" + p + url.search, req);
      fwd.headers.set("x-origin", url.origin);
      return accountsDO(env).fetch(fwd);
    }

    // 내 방 — 계정마다 하나, 처음 필요할 때 만듭니다
    if (p === "/api/my/room" && req.method === "POST") {
      const me = await verify(env, bearer(req));
      if (!me) return json({ error: "unauthorized" }, 401);
      const own = await call(accountsDO(env), "/own-room", { id: me.id });
      if (!own.ok || !own.data || !own.data.roomId) return json({ error: "no room" }, 503);
      return toRoom(env, own.data.roomId, "/my-room", req, me);
    }

    // 방 API
    const api = p.match(
      new RegExp(
        `^/api/r/(${ID6})/(state|read|invite|lobby|members|member|seat|join|leave|confess|pause|resume|end|look|invite-arm|round|peek)$`
      )
    );
    if (api) {
      const me = await verify(env, bearer(req));
      const res = await toRoom(env, api[1], "/" + api[2], req, me);
      /* 참여는 활동입니다 — 그 계정의 방송용 주소가 이제 이 방을 비춥니다 */
      if (api[2] === "join" && res.ok && me)
        await call(accountsDO(env), "/touch", { id: me.id, roomId: api[1] });
      return res;
    }

    /* 구독 — 브라우저 WS 는 헤더를 못 실어서 쿼리로 자격을 받습니다.
       세션(?s)·OBS 토큰(?o)은 여기서 풀고, 초대 코드(?j)만 방이 직접 봅니다.
       DO 로 가는 주소는 내부 주소라, 푼 결과를 쿼리에 실어도 밖에 안 보입니다. */
    const ws = p.match(new RegExp(`^/api/r/(${ID6})/(live|scribe)$`));
    if (ws) {
      const [, roomId, kind] = ws;
      const q = url.searchParams;
      let me = null;
      if (q.get("s")) me = await verify(env, q.get("s"));
      else if (kind === "live" && q.get("o")) {
        const r = await call(accountsDO(env), "/obs-verify", { token: q.get("o") });
        // 토큰이 가리키는 방과 지금 방이 같을 때만 — 남의 방은 못 비춥니다
        if (r.ok && r.data && r.data.roomId === roomId) me = { id: r.data.id, nick: r.data.nick, dcu: r.data.dcu || "" };
      }
      const iu = new URL("https://do/" + kind);
      if (q.get("j")) iu.searchParams.set("j", q.get("j"));
      /* 오버레이 소켓(OBS 토큰으로 온 것)은 접속으로 세지 않습니다 (§3.12.6) */
      if (kind === "live" && q.get("o")) iu.searchParams.set("o", "1");
      if (me) {
        iu.searchParams.set("acct", me.id);
        iu.searchParams.set("nick", me.nick || "");
        iu.searchParams.set("dcu", me.dcu || "");
      }
      return roomDO(env, roomId).fetch(new Request(iu.toString(), req));
    }

    // 공유 페이지 — OBS면 오버레이를 그리고, 브라우저면 앱의 읽기 전용 화면으로 넘깁니다
    const rp = p.match(new RegExp(`^/r/(${ID6})$`));
    if (rp) return servePage(rp[1], "");
    const op = p.match(new RegExp(`^/o/(${TOK20})$`));
    if (op) return servePage("", op[1]);

    if (p === "/") {
      return new Response("벌금 현황판 릴레이입니다. 공유받은 주소로 접속하세요.", {
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
    return json({ error: "not found" }, 404);
  },
};

/* ---------------- 계정·세션·방송용 토큰 = Accounts DO 하나 ---------------- */

const hex = (buf) =>
  Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
const unhex = (s) => {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
};
/* 저장하는 건 SHA-256(무작위 솔트 ‖ 선해시)입니다. 비밀번호 원문은 서버에 오지 않습니다 —
   브라우저가 PBKDF2 로 한 번 접어서 보냅니다. */
const derive = async (salt, pw) => {
  const p = new TextEncoder().encode(pw);
  const buf = new Uint8Array(salt.length + p.length);
  buf.set(salt, 0);
  buf.set(p, salt.length);
  return hex(await crypto.subtle.digest("SHA-256", buf));
};
// 길이가 같은 hex 끼리 — 맞고 틀림이 시간으로 새지 않게 끝까지 셉니다
const same = (a, b) => {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
};

export class Accounts {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }

  async fetch(req) {
    const url = new URL(req.url);
    const p = url.pathname;
    const now = Date.now();
    let b = {};
    if (req.method === "POST") {
      const raw = await req.text();
      if (raw.length > (p === "/api/auth/avatar" ? MAX_PIC_BYTES + 256 : MAX_AUTH_BYTES)) return json({ error: "too big" }, 413);
      if (raw) {
        try {
          b = JSON.parse(raw);
        } catch (e) {
          return json({ error: "bad json" }, 400);
        }
      }
    }
    const S = this.ctx.storage;

    if (p === "/api/auth/register" && req.method === "POST") {
      const id = String(b.id || "").toLowerCase();
      const nick = String(b.nick || "").trim();
      const pw = String(b.pw || "").toLowerCase();
      if (!RE_ID.test(id) || !RE_NICK.test(nick) || !RE_PW.test(pw))
        return json({ error: "bad input" }, 400);
      if (!(await this.regGuard(req, now))) return json({ error: "slow down" }, 429);
      if (await S.get("u:" + id)) return json({ error: "taken" }, 409);
      const salt = crypto.getRandomValues(new Uint8Array(16));
      const obsToken = await this.freeToken();
      const token = rid(32);
      const u = {
        id,
        nick,
        salt: hex(salt),
        ph: await derive(salt, pw),
        created: now,
        seen: now,
        obsToken,
        cur: null,
        room: null,
      };
      await S.put({
        ["u:" + id]: u,
        ["t:" + obsToken]: id,
        ["s:" + token]: { id, exp: now + SESSION_MS },
      });
      await this.arm();
      return json({ id, nick, token, obsToken });
    }

    /* 가입 없이 주소 받기 (§3-11) — 앱이 부르면 서버가 무작위 아이디·비밀번호로 계정 하나를
       만들어 세션만 돌려줍니다. 사용자는 가입 화면을 본 적이 없고, 서버 쪽에서는 그냥 계정
       하나라 인증 경로가 하나로 유지됩니다. 비밀번호는 여기서 만들고 어디에도 안 알려 줍니다 —
       이 계정으로 다시 로그인할 일은 없고, 정식 계정이 되는 길은 /upgrade 하나뿐입니다. */
    /* [게스트로 시작] — 아이디·비밀번호 없이 닉 하나로 계정을 만듭니다 (§3.11).
       가입과 같은 계정이라 방송용 주소도 파티 참여도 그대로 되고, 나중에 upgrade 로
       아이디를 붙이면 주소·방·관계가 전부 따라옵니다. 닉은 벌금판에 오르는 이름이라
       가입과 같은 규칙(2~3자)을 씁니다 — 안 보내면 옛 호출부 호환으로 기본 이름입니다 */
    if (p === "/api/auth/anon" && req.method === "POST") {
      if (!(await this.regGuard(req, now))) return json({ error: "slow down" }, 429);
      const wantNick = String(b.nick || "").trim();
      if (wantNick && !RE_NICK.test(wantNick)) return json({ error: "bad input" }, 400);
      const id = await this.freeId();
      if (!id) return json({ error: "could not allocate account" }, 503);
      const pw = hex(crypto.getRandomValues(new Uint8Array(32)));
      const salt = crypto.getRandomValues(new Uint8Array(16));
      const obsToken = await this.freeToken();
      const token = rid(32);
      const u = {
        id,
        nick: wantNick || ANON_NICK,
        salt: hex(salt),
        ph: await derive(salt, pw),
        created: now,
        seen: now,
        obsToken,
        cur: null,
        room: null,
        anon: true,
      };
      await S.put({
        ["u:" + id]: u,
        ["t:" + obsToken]: id,
        ["s:" + token]: { id, exp: now + SESSION_MS },
      });
      await this.arm();
      return json({ id, nick: u.nick, token, obsToken });
    }

    /* 익명 계정에 아이디·비밀번호·닉네임을 붙입니다 (§3-11).
       새 계정을 만드는 게 아니라 같은 계정에 덧씌웁니다 — 방·방송용 주소·멤버십·세션이
       그대로 남는 것이 이 기능의 존재 이유입니다("가입했더니 OBS를 다시 세팅").
       계정의 저장 열쇠가 아이디라, 아이디를 갈면서 그 열쇠를 가리키던 것들을 같이 옮깁니다. */
    if (p === "/api/auth/upgrade" && req.method === "POST") {
      const u = await this.session(req, now);
      if (!u) return json({ error: "unauthorized" }, 401);
      const id = String(b.id || "").toLowerCase();
      const nick = String(b.nick || "").trim();
      const pw = String(b.pw || "").toLowerCase();
      if (!RE_ID.test(id) || !RE_NICK.test(nick) || !RE_PW.test(pw))
        return json({ error: "bad input" }, 400);
      if (!u.anon) return json({ error: "not anon" }, 409);
      const old = u.id;
      if (id !== old && (await S.get("u:" + id))) return json({ error: "taken" }, 409);
      const salt = crypto.getRandomValues(new Uint8Array(16));
      const next = { ...u, id, nick, salt: hex(salt), ph: await derive(salt, pw), seen: now };
      delete next.anon;
      const puts = { ["u:" + id]: next };
      if (u.obsToken) puts["t:" + u.obsToken] = id;
      if (u.room) puts["rm:" + u.room] = id;
      /* 앉아 있는 방 색인도 새 아이디로 옮깁니다 (§3.3) — 안 옮기면 그 사람이
         두 방에 앉을 수 있는 채로 남습니다 */
      const seatRoom = await S.get("rm:a:" + old);
      if (seatRoom) puts["rm:a:" + id] = seatRoom;
      await S.put(puts);
      /* 세션은 계정 이름을 들고 있습니다 — 지금 켜 둔 기기가 튕기지 않게 갈아 끼웁니다.
         한 번에 넣을 수 있는 열쇠 수가 정해져 있어서 나눠 씁니다 */
      let batch = {};
      let n = 0;
      for (const [k, v] of await S.list({ prefix: "s:" })) {
        if (!v || v.id !== old) continue;
        batch[k] = { id, exp: v.exp };
        if (++n === 100) {
          await S.put(batch);
          batch = {};
          n = 0;
        }
      }
      if (n) await S.put(batch);
      if (id !== old) await S.delete(["u:" + old, "lg:" + old, "rm:a:" + old]);
      // 방장 자리와 명단의 이름표도 같이 옮깁니다 — 안 옮기면 제 방을 잃습니다
      const rooms = [u.room, u.cur].filter((x, i, a) => x && a.indexOf(x) === i);
      for (const rm of rooms) {
        try {
          await this.env.ROOM.get(this.env.ROOM.idFromName(rm)).fetch("https://do/acct-renamed", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ from: old, to: id, nick }),
          });
        } catch (e) {
          /* 방이 없어졌어도 계정은 이미 정식입니다 */
        }
      }
      return json({ id, nick });
    }

    if (p === "/api/auth/login" && req.method === "POST") {
      const id = String(b.id || "").toLowerCase();
      const pw = String(b.pw || "").toLowerCase();
      if (!RE_ID.test(id) || !RE_PW.test(pw)) return json({ error: "bad input" }, 400);
      let g = (await S.get("lg:" + id)) || { n: 0, until: 0 };
      if (g.until > now && g.n >= LOGIN_FAILS) return json({ error: "slow down" }, 429);
      const u = await S.get("u:" + id);
      /* 계정이 없어도 한 번 접습니다 — 있고 없고가 응답 시간으로 새지 않게 */
      const ph = await derive(u ? unhex(u.salt) : new Uint8Array(16), pw);
      if (!u || !same(ph, u.ph)) {
        if (g.until <= now) g = { n: 0, until: now + LOGIN_WINDOW_MS };
        g.n++;
        await S.put("lg:" + id, g);
        return json({ error: "bad login" }, 401);
      }
      u.seen = now;
      const token = rid(32);
      await S.put({ ["u:" + id]: u, ["s:" + token]: { id, exp: now + SESSION_MS } });
      return json({ id, nick: u.nick, token, obsToken: u.obsToken });
    }

    if (p === "/api/auth/logout" && req.method === "POST") {
      if (typeof b.token === "string") await S.delete("s:" + b.token);
      return json({ ok: true });
    }

    /* ── 디스코드 연동 (§3.12.1·§3.12.9) ──
       begin: 세션이 있으면 그 계정(익명이든 옛 정식이든)에 붙입니다. 없으면 로그인/새 계정.
       callback: 디스코드가 돌아오는 곳. 코드→토큰→/users/@me 뒤 계정을 찾거나 만들거나 이관하고,
                 세션은 주소에 싣지 않고 2분짜리 1회용 코드로 앱에 넘깁니다(#dc=).
       finish: 앱이 그 코드로 세션을 받습니다. */
    if (p === "/api/auth/discord/begin" && (req.method === "POST" || req.method === "GET")) {
      const cid = this.env.DISCORD_CLIENT_ID;
      const fake = !!this.env.DISCORD_DEV_FAKE;
      if (!cid && !fake) return json({ error: "discord off" }, 503);
      const u = await this.session(req, now);
      const state = rid(24);
      const ret = typeof b.live === "string" && /^[A-Z0-9]{6}$/i.test(b.live) ? b.live.toUpperCase() : "";
      /* 로컬 앱은 localhost·127.0.0.1 두 출처를 오가며 검증한다 — 온 곳으로 돌려보낸다. 운영 주소는 APP_URL 하나라 무시한다 */
      const app = typeof b.app === "string" && /^http:\/\/(localhost|127\.0\.0\.1):\d{2,5}\/[A-Za-z0-9._\-\/]*$/.test(b.app) ? b.app : "";
      await S.put("ds:" + state, { t: now, link: u ? u.id : null, ret, app });
      const origin = req.headers.get("x-origin") || new URL(req.url).origin;
      const cb = origin + "/api/auth/discord/callback";
      if (fake) return json({ url: origin + "/api/auth/discord/fake?state=" + state });
      const q = new URLSearchParams({
        client_id: cid, response_type: "code", redirect_uri: cb, scope: "identify", state, prompt: "none",
      });
      return json({ url: DISCORD_AUTH + "?" + q.toString() });
    }
    /* 개발용 가짜 동의 창 — DISCORD_DEV_FAKE 가 .dev.vars 에 있을 때만 존재합니다. 운영에는 이 변수가 없습니다 */
    if (p === "/api/auth/discord/fake" && req.method === "GET") {
      if (!this.env.DISCORD_DEV_FAKE) return json({ error: "not found" }, 404);
      const state = url.searchParams.get("state") || "";
      /* 자주 쓰는 사람은 한 번에 (2026-09-20) — 디스코드 계정이 하나뿐이라 여럿을 시험하기 어렵다(사용자).
         테스N 을 누르면 그 사람으로 바로 들어간다. 아이디는 테스트용으로 고정이라 다시 눌러도 같은 계정이다 */
      const who = [2, 3, 4, 5, 6, 7, 8].map((n) => ({ n, fid: "4000000000000000" + n + n, nick: "테스" + n, user: "tes" + n + "x" }));
      const quick = who
        .map(
          (w) =>
            '<a href="/api/auth/discord/callback?code=fake&state=' + encodeURIComponent(state) +
            "&fid=" + w.fid + "&fname=" + encodeURIComponent(w.nick) + "&fuser=" + w.user +
            '&fava=" style="display:inline-block;margin:0 8px 8px 0;padding:10px 16px;border:1px solid #888;border-radius:6px;text-decoration:none;color:inherit;font-size:16px">' +
            w.nick + "</a>"
        )
        .join("");
      const html = `<!doctype html><meta charset="utf-8"><title>가짜 Discord</title>
<body style="font:15px system-ui;padding:32px;max-width:460px">
<h2>가짜 Discord 동의 창 (개발 전용)</h2>
<p style="color:#666;margin:0 0 10px">눌러서 바로 들어가기</p>
<div style="margin-bottom:22px">${quick}</div>
<details><summary style="cursor:pointer;color:#666">직접 적기</summary>
<form method="GET" action="/api/auth/discord/callback" style="margin-top:12px">
<input type="hidden" name="state" value="${state}">
<p><label>디스코드 아이디(숫자) <input name="fid" value="100000000000000001" style="width:100%"></label></p>
<p><label>표시 이름 <input name="fname" value="테스터" style="width:100%"></label></p>
<p><label>사용자명 <input name="fuser" value="tester" style="width:100%"></label></p>
<p><label>아바타 해시 <input name="fava" value="a1b2c3" style="width:100%"></label></p>
<button name="code" value="fake" type="submit" style="font-size:16px;padding:8px 16px">승인</button>
</form></details></body>`;
      return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
    }
    if (p === "/api/auth/discord/callback" && req.method === "GET") {
      const state = url.searchParams.get("state") || "";
      const code = url.searchParams.get("code") || "";
      const ds = state ? await S.get("ds:" + state) : null;
      if (ds) await S.delete("ds:" + state);
      const back = (frag) =>
        new Response(null, { status: 302, headers: { location: ((ds && ds.app) || appOrigin(req)) + "#" + frag } });
      if (!ds || ds.t + DS_MS < now || !code) return back("dcerr=state");
      let du = null;
      if (this.env.DISCORD_DEV_FAKE && code === "fake") {
        du = {
          id: String(url.searchParams.get("fid") || "").replace(/\D/g, "") || "1",
          global_name: url.searchParams.get("fname") || "테스터",
          username: url.searchParams.get("fuser") || "tester",
          avatar: url.searchParams.get("fava") || null,
        };
      } else {
        const cid = this.env.DISCORD_CLIENT_ID;
        const sec = this.env.DISCORD_CLIENT_SECRET;
        if (!cid || !sec) return back("dcerr=off");
        try {
          const tr = await fetch(DISCORD_TOKEN, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              client_id: cid, client_secret: sec, grant_type: "authorization_code", code,
              redirect_uri: (req.headers.get("x-origin") || new URL(req.url).origin) + "/api/auth/discord/callback",
            }),
          });
          const tk = tr.ok ? await tr.json() : null;
          if (!tk || !tk.access_token) return back("dcerr=token");
          const mr = await fetch(DISCORD_ME, { headers: { authorization: "Bearer " + tk.access_token } });
          du = mr.ok ? await mr.json() : null;
        } catch (e) {
          du = null;
        }
        if (!du || !du.id) return back("dcerr=me");
      }
      const did = String(du.id);
      /* user = Discord 사용자명(고유 핸들). 방 쪽으로는 앞 두 글자만 나간다 (2026-09-17 사용자: 방송 캡처에 전문이 찍히지 않게) */
      const dc = { id: did, avatar: du.avatar || null, name: String(du.global_name || du.username || "").slice(0, 32), user: String(du.username || "").slice(0, 32) };
      /* 별명 = Discord 표시 이름 (2026-09-17 확정: 앱에서 별명을 정하는 기능을 없앴다). 로그인할 때마다 따라간다 */
      const dcNick = dc.name || dc.user || "";
      let id = await S.get("d:" + did);
      let u = id ? await S.get("u:" + id) : null;
      if (u) {
        /* 이미 이 디스코드로 만든 계정이 있다. 지금 브라우저의 계정(link)이 다른 것이면 그리로 이관한다 (§3.12.1) */
        if (ds.link && ds.link !== u.id) await this.mergeInto(ds.link, u, req, now);
        u.dc = dc;
        u.seen = now;
        const was = u.nick;
        if (dcNick) u.nick = dcNick;
        await S.put("u:" + u.id, u);
        if (u.nick !== was) await this.nickToRooms(u);
      } else if (ds.link && (u = await S.get("u:" + ds.link))) {
        /* 이 브라우저의 계정이 디스코드 계정이 된다 — 표·방송 주소 그대로 (upgrade 문법) */
        u.dc = dc;
        u.seen = now;
        delete u.anon;
        const was = u.nick;
        if (dcNick) u.nick = dcNick;
        await S.put("u:" + u.id, u);
        await S.put("d:" + did, u.id);
        if (u.nick !== was) await this.nickToRooms(u);
      } else {
        /* 새 계정 — 별명은 Discord 표시 이름 (2026-09-17). (폐기) 연동 뒤 처음 한 번 직접 정하던 별명 */
        id = await this.freeId();
        if (!id) return back("dcerr=alloc");
        const pw = hex(crypto.getRandomValues(new Uint8Array(32)));
        const salt = crypto.getRandomValues(new Uint8Array(16));
        const obsToken = await this.freeToken();
        u = { id, nick: dcNick || ANON_NICK, nickSet: true, salt: hex(salt), ph: await derive(salt, pw), created: now, seen: now, obsToken, cur: null, room: null, dc };
        await S.put({ ["u:" + id]: u, ["t:" + obsToken]: id, ["d:" + did]: id });
        await this.arm();
      }
      const dcx = rid(24);
      await S.put("dcx:" + dcx, { id: u.id, t: now });
      return back("dc=" + dcx + (ds.ret ? "&live=" + ds.ret : ""));
    }
    if (p === "/api/auth/discord/finish" && req.method === "POST") {
      const code = String(b.code || "");
      const x = code ? await S.get("dcx:" + code) : null;
      if (x) await S.delete("dcx:" + code);
      if (!x || x.t + DCX_MS < now) return json({ error: "expired" }, 403);
      const u = await S.get("u:" + x.id);
      if (!u) return json({ error: "not found" }, 404);
      const token = rid(32);
      await S.put("s:" + token, { id: u.id, exp: now + SESSION_MS });
      return json({ id: u.id, nick: u.nick, token, obsToken: u.obsToken, dc: u.dc || null, nickSet: !!u.nickSet, pic: u.pic || null, cur: u.cur || null });
    }

    if (p === "/api/auth/me" && req.method === "GET") {
      const u = await this.session(req, now);
      if (!u) return json({ error: "unauthorized" }, 401);
      /* anon 은 앱이 [파티 모드 시작하기]에서 아이디·비밀번호를 받을지 가리는 데 씁니다 (§3-11).
         look 은 새 기기에서 로그인했을 때 제 오버레이 외형을 되찾는 자리입니다 */
      const out = {
        id: u.id,
        nick: u.nick,
        obsToken: u.obsToken,
        cur: u.cur || null,
        seen: u.seen,
        anon: !!u.anon,
        dc: u.dc || null,
        nickSet: !!u.nickSet,
        pic: u.pic || null,
      };
      if (u.look) out.look = u.look;
      /* 함께한 사람과 대기 중인 지목 초대를 같이 싣습니다 (§4 라운드 B).
         전달 배관은 안 깝니다 — 앱이 열릴 때와 창에 초점이 돌아올 때 이 응답으로 확인합니다 */
      out.mates = await this.mateList(u.id);
      out.invites = await this.freshInvites(u.id, now);
      /* 내가 앉아 있는 방이 지금 어떤지 — 정산이 끝난 뒤 [닫기]로 자기 앱에 돌아온 사람은
         명단에 그대로 남아 있습니다(§1). 그 방에서 판이 다시 열리면 앱이 카드 하나로
         알려야 해서, 열 때와 초점이 돌아올 때 이 응답이 그것을 싣습니다 (§3.4·§8) */
      /* 앉아 있는 방 (§3.12.5) — 마지막으로 앉은 방(rm:a:)이 진본이고, cur 는 앱이 마지막으로 연 방일 뿐이라 덮일 수 있다.
         앉아 있으면 그 방을 cur 로 돌려주어 앱이 그 자리로 간다 */
      const seatRoom = (await S.get("rm:a:" + u.id)) || u.cur || null;
      if (seatRoom) {
        const seat = await this.seatInfo(seatRoom, u.id);
        if (seat) {
          out.seat = seat;
          if (seat.st === "ok") out.cur = seatRoom;
        }
      }
      return json(out);
    }

    /* 초대 코드 색인 (§3.0·§4 보충, 2026-09-05) — 코드 8자만 치고 들어오는 로비 입력칸이 방을
       찾습니다. Room 이 초대를 발급할 때 /code-index 로 밀어 두고, 지난 것은 읽을 때 버립니다.
       주소 붙여넣기는 색인 없이 됩니다(주소에 방과 코드가 다 있습니다) */
    if (/^\/api\/j\/[A-Z0-9]{8}\/resolve$/i.test(p) && req.method === "GET") {
      const code = p.split("/")[3].toUpperCase();
      const c = await S.get("c:" + code);
      if (!c || (c.exp && c.exp < now)) {
        if (c) await S.delete("c:" + code);
        return json({ error: "not found" }, 404);
      }
      return json({ roomId: c.room });
    }
    if (p === "/code-index" && req.method === "POST") {
      const code = String(b.code || "").toUpperCase();
      if (!/^[A-Z0-9]{8}$/.test(code) || !b.room) return json({ error: "bad input" }, 400);
      await S.put("c:" + code, { room: String(b.room), exp: Number(b.exp) || now + 600000 });
      return json({ ok: true });
    }

    /* 지목 초대 — 함께한 사람에게만 쏩니다 (§3.3). 자리는 보내는 쪽이 그때 정하고,
       같은 (받는이, 보낸이)는 열쇠가 하나라 다시 지목하면 그대로 갱신입니다 */
    if (p === "/api/invite" && req.method === "POST") {
      const u = await this.session(req, now);
      if (!u) return json({ error: "unauthorized" }, 401);
      const to = String(b.to || "").toLowerCase();
      if (!to || to === u.id) return json({ error: "bad input" }, 400);
      if (!u.room) return json({ error: "no room" }, 409);
      const list = (await S.get("f:" + u.id)) || [];
      // 무지성 지목은 관계 문턱이 막습니다 — 목록에 없는 사람에게는 쏠 수 없습니다
      if (!list.some((x) => x && x.id === to)) return json({ error: "not mate" }, 403);
      if (!(await S.get("u:" + to))) return json({ error: "not found" }, 404);
      let g = (await S.get("ig:" + u.id)) || { n: 0, until: 0 };
      if (g.until <= now) g = { n: 0, until: now + 60000 };
      g.n++;
      await S.put("ig:" + u.id, g);
      if (g.n > INVITE_PER_MIN) return json({ error: "slow down" }, 429);
      const seat = typeof b.seat === "string" && b.seat ? b.seat.slice(0, 64) : null;
      await S.put("inv:" + to + ":" + u.id, { room: u.room, seat, t: now });
      return json({ ok: true, to, seat, exp: now + INV_MS });
    }

    // 닉을 바꾸면 지금 있는 방의 서기가 줄 이름을 따라 바꿔 줍니다
    /* 올린 초상화 (§3.12.3, 2026-09-16 사용자: 프로필 수동 설정 + 디스코드 프사 복원) — data URL 하나를 받아 pic:{id} 에 두고
       u.pic 에 판본(시각)을 적는다. 비우면 디스코드 초상화로 돌아간다. 앉아 있는 방·접속 방·내 방에 알려 명단의 ava 를 갱신한다 */
    if (p === "/api/auth/avatar" && req.method === "POST") {
      const u = await this.session(req, now);
      if (!u) return json({ error: "unauthorized" }, 401);
      if (b.clear) {
        await S.delete("pic:" + u.id);
        u.pic = null;
      } else {
        const m = new RegExp("^data:(image/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$").exec(String(b.data || ""));
        if (!m || m[2].length > MAX_PIC_BYTES) return json({ error: "bad image" }, 400);
        await S.put("pic:" + u.id, { ct: m[1], b64: m[2] });
        u.pic = now;
      }
      await S.put("u:" + u.id, u);
      const ava = this.avaOf(u);
      const rooms = new Set();
      for (const k of ["rm:a:" + u.id, "p:" + u.id]) {
        const v = await S.get(k);
        const r = v && typeof v === "object" ? v.room : v;
        if (typeof r === "string" && r) rooms.add(r);
      }
      if (u.cur) rooms.add(u.cur);
      if (u.room) rooms.add(u.room);
      for (const r of rooms) {
        try {
          await this.env.ROOM.get(this.env.ROOM.idFromName(r)).fetch("https://do/ava-changed", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ acct: u.id, ava }),
          });
        } catch (e) {}
      }
      return json({ ok: true, pic: u.pic || null, ava });
    }
    /* 공개 초상화 읽기 — <img> 가 부른다. 판본은 주소의 ?v= 라 오래 캐시해도 된다 */
    if (p.startsWith("/api/pic/") && req.method === "GET") {
      const id = p.slice("/api/pic/".length);
      const pic = /^[A-Za-z0-9_-]{1,40}$/.test(id) ? await S.get("pic:" + id) : null;
      if (!pic) return new Response(null, { status: 404, headers: CORS });
      const bin = Uint8Array.from(atob(pic.b64), (c) => c.charCodeAt(0));
      return new Response(bin, {
        status: 200,
        headers: { ...CORS, "content-type": pic.ct, "cache-control": "public, max-age=31536000, immutable" },
      });
    }
    if (p === "/api/auth/nick" && req.method === "POST") {
      /* (폐기 2026-09-17) 앱의 별명 창이 없어졌다 — 옛 앱을 위해 길만 남긴다. 연동한 계정은 Discord 표시 이름이 이긴다 */
      const u = await this.session(req, now);
      if (!u) return json({ error: "unauthorized" }, 401);
      const nick = String(b.nick || "").trim();
      if (!RE_NICK.test(nick)) return json({ error: "bad nick" }, 400);
      u.nickSet = true;
      u.nick = nick;
      await S.put("u:" + u.id, u);
      if (u.cur) {
        try {
          await this.env.ROOM.get(this.env.ROOM.idFromName(u.cur)).fetch("https://do/nick-changed", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ acct: u.id, nick }),
          });
        } catch (e) {
          /* 방이 없어졌어도 닉 변경 자체는 성공입니다 */
        }
      }
      return json({ ok: true, nick });
    }

    // 방송용 주소 재발급 — 옛 토큰은 그 자리에서 무효입니다
    if (p === "/api/auth/obs-reissue" && req.method === "POST") {
      const u = await this.session(req, now);
      if (!u) return json({ error: "unauthorized" }, 401);
      /* 계정당 창 하나 — 이 라우트만 리밋이 비어 있었습니다(초대·로그인·자수는 다
         걸려 있습니다). 사용량보다 전역 DO 점유가 문제라, 창은 넉넉하고 횟수는 빡빡하게 */
      if (!u.riT || now - u.riT > REISSUE_WINDOW_MS) {
        u.riT = now;
        u.riN = 0;
      }
      if (u.riN >= REISSUE_PER_WINDOW) return json({ error: "slow down" }, 429);
      u.riN = (u.riN || 0) + 1;
      const next = await this.freeToken();
      const old = u.obsToken;
      u.obsToken = next;
      await S.put({ ["u:" + u.id]: u, ["t:" + next]: u.id });
      if (old) await S.delete("t:" + old);
      return json({ obsToken: next });
    }

    /* 오버레이 외형은 계정마다 따로입니다 (§4.1). 주소 파라미터가 아니라 서버에 두는 이유는
       "OBS는 한 번만 넣는다"를 지키기 위해서입니다 — 외형을 바꿔도 소스 주소는 그대로입니다.
       서버는 look 을 해석하지 않고 그대로 실어 나릅니다 */
    if (p === "/api/auth/look" && req.method === "POST") {
      const u = await this.session(req, now);
      if (!u) return json({ error: "unauthorized" }, 401);
      const look = b.look === undefined || b.look === null ? null : b.look;
      if (look !== null && (typeof look !== "object" || Array.isArray(look)))
        return json({ error: "bad look" }, 400);
      if (look && new TextEncoder().encode(JSON.stringify(look)).length > LOOK_MAX_BYTES)
        return json({ error: "too big" }, 413);
      if (look) u.look = look;
      else delete u.look;
      await S.put("u:" + u.id, u);
      return json({ ok: true });
    }

    // 방송용 주소가 가리키는 방 — 지금 들어가 있는 방입니다. 조회도 활동으로 칩니다
    const res = p.match(new RegExp(`^/api/o/(${TOK20})/resolve$`));
    if (res && req.method === "GET") {
      const id = await S.get("t:" + res[1]);
      const u = id ? await S.get("u:" + id) : null;
      const at = u ? await this.roomOf(u) : null;
      if (!u || !at) return json({ error: "not found" }, 404);
      /* seen 은 "1년 미사용 계정 삭제"용이라 분 단위 정밀도가 필요 없습니다.
         오버레이가 볼 것이 없으면 이 주소를 1분마다 다시 묻는데, 그때마다 쓰면
         켜 둔 채 방치된 OBS 소스 하나가 하루 1,440번씩 이 DO(전역 하나)에
         쓰기를 만듭니다. 반나절에 한 번만 적어 두면 충분합니다 */
      if (now - (u.seen || 0) > SEEN_SKIP_MS) {
        u.seen = now;
        await S.put("u:" + id, u);
      }
      // 외형이 저장돼 있으면 같이 보냅니다 — 오버레이가 주소를 안 고치고 갈아입습니다
      return u.look ? json({ roomId: at, look: u.look }) : json({ roomId: at });
    }

    /* ---- 내부: 메인 fetch 전용 ---- */

    if (p === "/verify") {
      const s = typeof b.token === "string" ? await S.get("s:" + b.token) : null;
      if (!s) return json({ error: "unauthorized" }, 401);
      if (s.exp < now) {
        await S.delete("s:" + b.token);
        return json({ error: "expired" }, 401);
      }
      const u = await S.get("u:" + s.id);
      if (!u) return json({ error: "unauthorized" }, 401);
      u.seen = now;
      await S.put("u:" + s.id, u);
      // 쓸 때마다 연장하되, 하루쯤 지났을 때만 씁니다
      if (s.exp - now < SESSION_MS - 86400 * 1000)
        await S.put("s:" + b.token, { id: s.id, exp: now + SESSION_MS });
      return json({ id: u.id, nick: u.nick, dcu: maskUser(u) });
    }

    /* 함께한 사람이 생기는 순간 — 방이 알려 줍니다 (수락·지목 초대 수락 둘 다).
       양쪽에 같이 적습니다: 관계는 한쪽만 아는 것이 아닙니다 (§3.3) */
    if (p === "/mated") {
      if (typeof b.a !== "string" || typeof b.b !== "string" || !b.a || !b.b)
        return json({ error: "bad json" }, 400);
      await this.addMate(b.a, b.b, now);
      await this.addMate(b.b, b.a, now);
      return json({ ok: true });
    }

    // 노크가 문 앞에 설 수 있는지 — a 의 함께한 사람에 b 가 있는지 (§3.3)
    if (p === "/mate-of") {
      const list = (await S.get("f:" + b.a)) || [];
      return json({ yes: list.some((x) => x && x.id === b.b) });
    }

    /* 지목 초대를 집어 갑니다 — 한 번 쓰면 사라지고, 1분 지난 것은 읽는 김에 버립니다.
       만료를 알리는 배관을 따로 깔지 않는 것이 이 설계의 요점입니다 (§3.3) */
    if (p === "/inv-take") {
      const k = "inv:" + b.to + ":" + b.from;
      const iv = await S.get(k);
      if (!iv) return json({ error: "no invite" }, 404);
      await S.delete(k);
      if (now - (iv.t || 0) > INV_MS) return json({ error: "expired" }, 404);
      if (b.room && iv.room !== b.room) return json({ error: "other room" }, 404);
      return json({ ok: true, seat: iv.seat || null });
    }

    /* 파티 하나 규칙의 색인 (§3.3) — 계정이 지금 앉아 있는 방 하나를 계정부가 들고 있습니다.
       `rm:` 아래에 두되 방 색인(`rm:<ROOMID>` = 방장)과 열쇠가 겹치지 않게 `a:` 를 끼웁니다.
       어느 방에서든 st:"ok" 가 되는 순간 여기로 와서, 다른 방의 착석을 서버가 지웁니다 —
       클라이언트 보정에 기대지 않습니다(한 사람이 두 방에 동시에 앉는 구멍이 있었습니다) */
    if (p === "/seat-claim") {
      const acct = String(b.acct || "");
      const room = String(b.room || "");
      if (!acct || !room) return json({ error: "bad json" }, 400);
      /* (폐기 2026-09-15) 파티 하나 규칙 — 다른 방의 자리를 걷지 않습니다 (§3.12.5). 색인은 마지막 방으로만 남깁니다 */
      await S.put("rm:a:" + acct, room);
      return json({ ok: true, left: null });
    }
    /* 자리에서 빠졌습니다 (본인 [나가기]·방장 내보내기) — 색인도 같이 놓습니다 */
    if (p === "/seat-clear") {
      const acct = String(b.acct || "");
      if (!acct) return json({ error: "bad json" }, 400);
      const k = "rm:a:" + acct;
      const cur = await S.get(k);
      if (cur && (!b.room || cur === b.room)) await S.delete(k);
      return json({ ok: true });
    }

    if (p === "/obs-verify") {
      const id = typeof b.token === "string" ? await S.get("t:" + b.token) : null;
      const u = id ? await S.get("u:" + id) : null;
      const at = u ? await this.roomOf(u) : null;
      if (!u || !at) return json({ error: "not found" }, 404);
      return json({ id: u.id, nick: u.nick, roomId: at });
    }
    /* 접속 방 (§3.12.6) — Room 이 계정의 첫 앱 소켓·마지막 끊김을 알립니다.
       바뀌면 그 계정의 오버레이가 붙어 있을 방(전에 비추던 곳)에 다시 붙으라고 말합니다 */
    if (p === "/presence") {
      const acct = String(b.acct || "");
      const room = String(b.room || "");
      if (!acct || !room) return json({ error: "bad json" }, 400);
      const u = await S.get("u:" + acct);
      if (!u) return json({ error: "not found" }, 404);
      const k = "p:" + acct;
      const prev = await S.get(k);
      const before = (prev && prev.room) || u.room || null;
      if (b.on) {
        if (prev && prev.room === room) return json({ ok: true });
        await S.put(k, { room, t: now });
      } else {
        if (!prev || prev.room !== room) return json({ ok: true });
        await S.delete(k);
      }
      const after = b.on ? room : u.room || null;
      if (before && before !== after) this.ctx.waitUntil(this.rehome(before, acct));
      return json({ ok: true });
    }

    if (p === "/touch") {
      const u = await S.get("u:" + b.id);
      if (!u) return json({ error: "not found" }, 404);
      u.seen = now;
      if (typeof b.roomId === "string") u.cur = b.roomId;
      await S.put("u:" + b.id, u);
      return json({ ok: true });
    }

    /* 계정에 딸린 방 하나 — 없으면 그 자리에서 뽑습니다. rm: 은 겹침 방지 색인입니다 */
    if (p === "/own-room") {
      const u = await S.get("u:" + b.id);
      if (!u) return json({ error: "not found" }, 404);
      if (!u.room) {
        let roomId = null;
        for (let i = 0; i < 8 && !roomId; i++) {
          const c = rid(6);
          if (c === DEMO_ROOM || (await S.get("rm:" + c))) continue;
          roomId = c;
        }
        if (!roomId) return json({ error: "could not allocate room" }, 503);
        u.room = roomId;
        await S.put("rm:" + roomId, u.id);
      }
      if (!u.cur) u.cur = u.room; // 앉아 있는 남의 판(cur)을 내 방을 열었다고 덮지 않는다 (§3.12.5 — 앱을 열면 자기 자리로)
      u.seen = now;
      await S.put("u:" + u.id, u);
      return json({ roomId: u.room });
    }

    return json({ error: "not found" }, 404);
  }

  /* 함께한 사람 목록에 한 사람을 올립니다 — 최근 순 30, 넘치면 오래된 것부터 밀립니다.
     닉은 여기 안 적습니다: 닉은 바뀌는 값이라 베껴 두면 두 곳이 어긋납니다 (§4 라운드 B) */
  async addMate(a, b, now) {
    if (!a || !b || a === b) return;
    const list = (await this.ctx.storage.get("f:" + a)) || [];
    const next = [{ id: b, t: now }, ...list.filter((x) => x && x.id !== b)].slice(0, MATES_MAX);
    await this.ctx.storage.put("f:" + a, next);
  }

  /* 그 방에서 내가 어떤 상태인지 한 줄 — 방이 없어졌거나 못 닿으면 조용히 null 입니다 */
  /* 이 계정의 방송 주소가 비추는 방 — 접속 방, 없으면 내 방 (§3.12.6) */
  /* 초상화 묶음 (§3.12.3) — 디스코드(id·해시)와 올린 사진(판본 p, 계정 u). 앱의 DcAva 가 이 모양을 그린다 */
  avaOf(u) {
    const dc = u.dc || {};
    return { id: dc.id || null, a: dc.avatar || null, p: u.pic || null, u: u.pic ? u.id : undefined };
  }
  async roomOf(u) {
    const pr = await this.ctx.storage.get("p:" + u.id);
    return (pr && pr.room) || u.room || null;
  }
  async rehome(room, acct) {
    try {
      await this.env.ROOM.get(this.env.ROOM.idFromName(room)).fetch("https://do/obs-rehome", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ acct }),
      });
    } catch (e) {}
  }
  /* 이 브라우저의 계정(from)을 이미 있는 디스코드 계정(into)으로 이관 (§3.12.1).
     방송 주소는 별칭으로 옮겨 두 PC 의 OBS 가 다 돌고, 방이 있으면 방장 자격도 넘어갑니다 */
  async mergeInto(from, into, req, now) {
    const S = this.ctx.storage;
    const a = await S.get("u:" + from);
    if (!a || from === into.id) return;
    if (a.obsToken && a.obsToken !== into.obsToken) await S.put("t:" + a.obsToken, into.id);
    const rooms = [];
    if (a.room) {
      await S.put("rm:" + a.room, into.id);
      if (!into.room) into.room = a.room;
      rooms.push(a.room);
    }
    if (a.cur && !into.cur) into.cur = a.cur;
    if (a.cur && !rooms.includes(a.cur)) rooms.push(a.cur);
    if (a.look && !into.look) into.look = a.look;
    for (const room of rooms) {
      try {
        await this.env.ROOM.get(this.env.ROOM.idFromName(room)).fetch("https://do/acct-renamed", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ from, to: into.id, nick: into.nick }),
        });
      } catch (e) {}
    }
    for (const [k, v] of await S.list({ prefix: "s:" })) if (v && v.id === from) await S.put(k, { id: into.id, exp: v.exp });
    await S.delete(["u:" + from, "lg:" + from, "rm:a:" + from, "f:" + from, "p:" + from]);
  }

  async seatInfo(room, id) {
    try {
      const r = await this.env.ROOM.get(this.env.ROOM.idFromName(room)).fetch("https://do/seat-of", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ acct: id }),
      });
      return r.ok ? await r.json().catch(() => null) : null;
    } catch (e) {
      return null;
    }
  }

  /* 목록이 곧 방 찾기입니다 (§3.3) — 검색이 없으니 어느 방으로 노크할지를 여기서 답합니다.
     방 주소는 비밀이 아니고(§1), 한 번 함께한 사람에게만 나갑니다 */
  async mateList(id) {
    const list = (await this.ctx.storage.get("f:" + id)) || [];
    const out = [];
    for (const m of list) {
      if (!m || !m.id) continue;
      const u = await this.ctx.storage.get("u:" + m.id);
      if (!u) continue; // 지워진 계정은 조용히 빠집니다
      out.push({ id: m.id, nick: u.nick, t: m.t || 0, room: u.room || null });
    }
    return out;
  }

  // 대기 중인 지목 초대 — 신선한 것만. 1분 지난 것은 읽는 김에 버립니다
  async freshInvites(id, now) {
    const pre = "inv:" + id + ":";
    const out = [];
    const dead = [];
    for (const [k, v] of await this.ctx.storage.list({ prefix: pre })) {
      if (!v || now - (v.t || 0) > INV_MS) {
        dead.push(k);
        continue;
      }
      const from = k.slice(pre.length);
      const u = await this.ctx.storage.get("u:" + from);
      out.push({ from, fromNick: u ? u.nick : from, room: v.room, seat: v.seat || null, t: v.t });
    }
    if (dead.length) await this.ctx.storage.delete(dead);
    return out;
  }

  async freeToken() {
    for (let i = 0; i < 8; i++) {
      const t = rid(20);
      if (!(await this.ctx.storage.get("t:" + t))) return t;
    }
    return rid(20);
  }

  // 익명 계정의 빈 아이디 — 겹칠 일은 없지만 그래도 한 번 봅니다
  async freeId() {
    for (let i = 0; i < 8; i++) {
      const c = anonId();
      if (!(await this.ctx.storage.get("u:" + c))) return c;
    }
    return null;
  }

  /* 계정 만들기 상한 — 가입과 익명이 같은 통을 씁니다 (§4.1).
     사람 하나가 방송용 주소를 몇 개 받는 건 정상이라 넉넉하게 두고, 퍼 나르기만 막습니다 */
  async regGuard(req, now) {
    const k = "rg:" + (req.headers.get("cf-connecting-ip") || "local");
    let g = await this.ctx.storage.get(k);
    if (!g || g.until <= now) g = { n: 0, until: now + LOGIN_WINDOW_MS };
    g.n++;
    await this.ctx.storage.put(k, g);
    return g.n <= REG_PER_WINDOW;
  }

  /* 별명이 바뀌었다 — 내 방(방장 이름)과 들어가 있는 방(명단의 한 줄)에 알린다 */
  async nickToRooms(u) {
    const rooms = [...new Set([u.room, u.cur].filter(Boolean))];
    for (const r of rooms) {
      try {
        await this.env.ROOM.get(this.env.ROOM.idFromName(r)).fetch("https://do/nick-changed", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ acct: u.id, nick: u.nick }),
        });
      } catch (e) {
        /* 방이 없어졌어도 로그인은 성공입니다 */
      }
    }
  }

  // Bearer 하나로 세션을 풀고 활동 시각을 밀어 둡니다
  async session(req, now) {
    const m = (req.headers.get("authorization") || "").match(/^Bearer\s+(\S+)$/i);
    if (!m) return null;
    const s = await this.ctx.storage.get("s:" + m[1]);
    if (!s || s.exp < now) return null;
    const u = await this.ctx.storage.get("u:" + s.id);
    if (!u) return null;
    u.seen = now;
    await this.ctx.storage.put("u:" + s.id, u);
    if (s.exp - now < SESSION_MS - 86400 * 1000)
      await this.ctx.storage.put("s:" + m[1], { id: s.id, exp: now + SESSION_MS });
    return u;
  }

  async arm() {
    if (!(await this.ctx.storage.getAlarm()))
      await this.ctx.storage.setAlarm(Date.now() + ACCT_SCAN_MS);
  }

  // 주 1회 — 1년 동안 아무것도 안 한 계정과 그 세션·토큰·방을 걷어냅니다
  async alarm() {
    const now = Date.now();
    const S = this.ctx.storage;
    // 지난 창의 계정 만들기 기록은 걷어냅니다 — 안 지우면 주소마다 하나씩 쌓입니다
    const stale = [];
    for (const [k, g] of await S.list({ prefix: "rg:" }))
      if (!g || (g.until || 0) <= now) stale.push(k);
    if (stale.length) await S.delete(stale);
    const users = await S.list({ prefix: "u:" });
    const dead = [];
    for (const [k, u] of users) if (now - (u.seen || 0) >= ACCT_IDLE_MS) dead.push([k, u]);
    if (dead.length) {
      const sessions = await S.list({ prefix: "s:" });
      for (const [k, u] of dead) {
        const keys = [k];
        if (u.obsToken) keys.push("t:" + u.obsToken);
        if (u.room) keys.push("rm:" + u.room);
        keys.push("lg:" + u.id, "f:" + u.id, "ig:" + u.id, "rm:a:" + u.id);
        for (const [sk, sv] of sessions) if (sv.id === u.id) keys.push(sk);
        await S.delete(keys);
        if (u.room) {
          try {
            await this.env.ROOM.get(this.env.ROOM.idFromName(u.room)).fetch("https://do/wipe", {
              method: "POST",
            });
          } catch (e) {
            /* 방 청소는 실패해도 계정 삭제를 막지 않습니다 */
          }
        }
      }
    }
    await S.setAlarm(now + ACCT_SCAN_MS);
  }
}

/* ---------------- 방 하나 = Room DO 하나 ---------------- */

const tagOf = (ws) => {
  try {
    return ws.deserializeAttachment() || null;
  } catch (e) {
    return null;
  }
};
const youOf = (m) =>
  m ? { nick: m.nick, rowId: m.rowId || null, st: m.st, kicked: !!m.kicked, full: !!m.full } : null;

export class Room {
  constructor(ctx, env) {
    this.ctx = ctx;
    /* 계정부에 말을 걸 일이 생겼습니다 — 함께한 사람은 계정에 살고, 그 관계가 생기고
       쓰이는 순간(수락·지목 초대·노크)은 방이 압니다 (§3.3) */
    this.env = env;
    /* 구독자의 keepalive 는 DO를 깨우지 않고 런타임이 대신 답합니다 (하이버네이션 유지) */
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  // 계정부에 한마디. 실패해도 방의 일은 진행합니다 — 관계는 다음 수락 때 다시 생깁니다
  async toAccounts(path, body) {
    try {
      const r = await this.env.ACCOUNTS.get(this.env.ACCOUNTS.idFromName("global")).fetch(
        "https://do" + path,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body || {}),
        }
      );
      return r.ok ? await r.json().catch(() => null) : null;
    } catch (e) {
      return null;
    }
  }

  /* 계정은 메인 fetch 가 풀어서 붙여 줍니다. 두 통로를 섞지 않습니다 —
     일반 요청은 헤더(메인이 밖에서 온 x-acct 를 지우고 붙입니다),
     WS 는 내부 주소의 쿼리(업그레이드 요청은 헤더가 그대로 딸려 와서 헤더를 못 믿습니다). */
  whoHeader(req) {
    const id = req.headers.get("x-acct");
    if (!id) return null;
    const h = req.headers.get("x-nick");
    const u = req.headers.get("x-dcu");
    return { id, nick: h ? decodeURIComponent(h) : "", dcu: u ? decodeURIComponent(u) : "" };
  }
  whoQuery(url) {
    const id = url.searchParams.get("acct");
    if (!id) return null;
    return { id, nick: url.searchParams.get("nick") || "", dcu: url.searchParams.get("dcu") || "" };
  }

  send(ws, msg) {
    try {
      ws.send(JSON.stringify(msg));
    } catch (e) {
      /* 끊긴 구독자는 무시 */
    }
  }
  bcast(msg, pick) {
    const s = JSON.stringify(msg);
    for (const ws of this.ctx.getWebSockets()) {
      if (pick && !pick(ws)) continue;
      try {
        ws.send(s);
      } catch (e) {}
    }
  }
  toViewers(msg) {
    this.bcast(msg, (ws) => {
      const a = tagOf(ws);
      return !!a && a.k === "v";
    });
  }
  toAcct(acct, msg) {
    this.bcast(msg, (ws) => {
      const a = tagOf(ws);
      return !!a && a.k === "v" && a.acct === acct;
    });
  }
  toScribe(msg) {
    this.bcast(msg, (ws) => {
      const a = tagOf(ws);
      return !!a && a.k === "scribe";
    });
  }
  // 그 계정의 뷰어 소켓을 끊습니다. 보낸 메시지는 닫기 전에 나갑니다
  dropAcct(acct) {
    for (const ws of this.ctx.getWebSockets()) {
      const a = tagOf(ws);
      if (!a || a.k !== "v" || a.acct !== acct) continue;
      try {
        ws.close(1000, "removed");
      } catch (e) {}
    }
  }
  /* 끝내기 = 해산 (2026-09-06 모델). 파티원은 판에 속하니 판이 없어지면 전원 빠집니다 — 색인도 놓아
     파티원 로비의 복귀 줄이 같이 사라집니다. 통지에 end:1 을 실어 앱이 내보내짐과 가릅니다.
     통지 뒤 소켓을 닫는 것은 member remove 와 같은 이유입니다 (§4.2).
     (폐기 2026-09-05 "해산 동사 없음, 정산 끝내기는 아무도 안 내보냄" — 다음 대기실에 지난 사람이 남는 그림이 됐다) */
  async clearMembers(req) {
    const list = await this.members();
    for (const m of list) {
      await this.ctx.storage.delete("m:" + m.acct);
      await this.releaseSeat(m.acct, req);
      this.toAcct(m.acct, { kind: "you", you: null, end: 1 });
      this.dropAcct(m.acct);
    }
    return list.length;
  }
  /* 판을 없앱니다 — 명단·내보냄 표시·판 존재 표시가 비고 로비가 닫힙니다. 결과지(state, end:1)와
     방·방장·코드는 남습니다. 남는 것은 결과지와 기본값이라는 규칙이 여기 삽니다 */
  async endParty(req, now) {
    const S = this.ctx.storage;
    const cleared = await this.clearMembers(req);
    /* 내보냄 표시는 판의 것입니다 — 다음 판엔 일반 입장. 계속 막으려면 코드 새로 발급 */
    for (const [k] of await S.list({ prefix: "x:" })) await S.delete(k);
    const st = await S.get("state");
    if (st && st.roundId && !st.end) await S.put("state", { ...st, end: 1 });
    const cur = (await S.get("lobby")) || { open: false, cap: 8, since: 0 };
    const lobby = { open: false, cap: cur.cap || 8, since: 0 };
    await S.put("lobby", lobby);
    await S.delete("party");
    await this.arm();
    this.bcast({ kind: "lobby", lobby });
    return cleared;
  }

  /* 파티 하나 규칙 (§3.3) — 이 계정이 여기 앉는 순간, 계정부가 다른 방의 착석을 지웁니다.
     방 id 는 메인 fetch 가 헤더로 실어 줍니다(내 방 열 때는 저장해 둔 것도 있습니다) */
  async roomId(req) {
    return (req && req.headers.get("x-room")) || (await this.ctx.storage.get("roomId")) || "";
  }
  async claimSeat(acct, req) {
    const room = await this.roomId(req);
    if (!room || !acct) return;
    await this.toAccounts("/seat-claim", { acct, room });
  }
  /* 자리에서 빠졌습니다 — 색인도 같이 놓아야 다음에 다른 방에 앉을 때 헛일을 안 합니다 */
  async releaseSeat(acct, req) {
    const room = await this.roomId(req);
    if (!acct) return;
    await this.toAccounts("/seat-clear", { acct, room });
  }

  scribeOn(except) {
    return this.ctx.getWebSockets().some((ws) => {
      if (ws === except) return false;
      const a = tagOf(ws);
      return !!a && a.k === "scribe";
    });
  }
  /* 판이 있는가 (2026-09-06 모델: 판은 만들면 생기고 끝내면 없다) — 새 판 만들기가 로비를 열며 켠 표시,
     또는 아직 끝나지 않은 진행 중 판. 문은 판이 있을 때만 열립니다 */
  async hasParty() {
    const S = this.ctx.storage;
    if (await S.get("party")) return true;
    /* 열린 로비 = 시작 전 판 (표시가 없는 옛 방도 같은 뜻입니다) */
    const lb = await S.get("lobby");
    if (lb && lb.open) return true;
    const st = await S.get("state");
    return !!(st && st.roundId && !st.end);
  }
  /* 코드의 시계는 방장이 [디코 메시지 복사]를 누른 때부터 10분입니다 (2026-09-08 사용자 확정).
     방을 만든 순간이 아닙니다 — 방장은 항목을 정리하다 한참 뒤에 부르고, 그 사이가 깎이면 안 됩니다.
     아직 안 뿌린 코드(armed:false)는 아무도 모르므로 입장에도 안 씁니다.
     (폐기 2026-09-08) 서기 소켓이 붙어 있는 동안 무한 연장 — 방송 내내 안 죽어서 유출되면 그 판 내내 살아 있었다.
     (폐기 2026-09-06) 발급 뒤 10분 고정 — 20분 모으다 보면 링크가 죽어 다시 붙여야 했다 */
  inviteOk(inv, now) {
    return !!inv && !!inv.armed && (inv.exp || 0) > now;
  }

  /* 되돌리기 기억 cf:{acct}:{col} 은 줄이 아니라 사람·항목 단위라, 줄이 바뀐 뒤 되돌리면 새 줄에서 1회가 빠졌다 */
  async clearUndo(acct) {
    const S = this.ctx.storage;
    const keys = [...(await S.list({ prefix: "cf:" + acct + ":" })).keys()];
    if (keys.length) await S.delete(keys);
  }

  async members() {
    const out = [];
    for (const [k, v] of await this.ctx.storage.list({ prefix: "m:" }))
      /* inv — 지목 초대를 받고 왔는데 자리가 없어 내려앉은 신청입니다 (§3.3).
         방장의 신청 칸이 "그냥 신청"과 갈라 말해야 해서 목록에도 실어 보냅니다 */
      out.push({
        acct: k.slice(2),
        nick: v.nick,
        rowId: v.rowId || null,
        st: v.st,
        t: v.t,
        inv: !!v.inv,
        /* 왜 기다리는지 (§3.3, 2026-09-05 표준화) — 내보냈던 사람은 승인으로만 돌아옵니다 */
        kicked: !!v.kicked,
        full: !!v.full,
        /* 지금 붙어 있는지 — 방장 표의 아이디 표시가 이걸로 흐려집니다 (§5.6) */
        on: this.acctOn(k.slice(2)),
        /* 이번 판에 앱을 연 적이 있는지는 seen 과 round.at 을 견줘 앱이 압니다 (§3.12.3). 화면에는 안 그립니다 */
        seen: v.seen || 0,
        ava: v.ava || null,
        /* Discord 사용자명 앞 두 글자 + •••• (2026-09-17) — 자리 배치 창에서 같은 이름을 가리는 데만 */
        dcu: v.dcu || "",
      });
    return out;
  }
  /* 이 계정의 뷰어 소켓이 하나라도 붙어 있는지 (except 는 지금 닫히는 소켓) */
  acctOn(acct, except) {
    return this.ctx.getWebSockets().some((ws) => {
      if (ws === except) return false;
      const a = tagOf(ws);
      return !!a && a.k === "v" && a.acct === acct && !a.o;
    });
  }
  /* 접속 방 알림 (§3.12.6) — 첫 앱 소켓이 붙으면 바로, 마지막이 끊기면 여유 뒤에 */
  async presence(acct, on, req) {
    const room = await this.roomId(req);
    if (!room || !acct) return;
    await this.toAccounts("/presence", { acct, room, on: !!on });
  }

  async isOwner(me) {
    const owner = await this.ctx.storage.get("owner");
    return !!me && !!owner && me.id === owner;
  }

  /* 계정이 붙은 자리가 하나라도 있는지 — 자동 중단을 걸지 말지를 이것이 정합니다 (§3.4).
     멤버가 없는 방(혼자 판)에는 알람을 아예 걸지 않습니다 */
  async seated() {
    for (const [, v] of await this.ctx.storage.list({ prefix: "m:" }))
      if (v && v.st === "ok") return true;
    return false;
  }

  /* 중단 표시를 세우거나 내립니다. 아무것도 지우지 않습니다 —
     사람·셈·연결이 그대로 있고, 얼렸다는 표시 하나만 붙습니다 (§3.4) */
  async setPaused(on, why) {
    const S = this.ctx.storage;
    const cur = await S.get("paused");
    if (!!cur === !!on) return false;
    if (on) await S.put("paused", { t: Date.now(), why: why || "host" });
    else await S.delete("paused");
    await this.arm();
    this.bcast({ kind: "paused", paused: on ? { why: why || "host" } : null });
    return true;
  }

  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;
    const now = Date.now();
    const S = this.ctx.storage;

    if (path === "/live" || path === "/scribe")
      return this.socket(req, url, path === "/scribe", this.whoQuery(url));
    const me = this.whoHeader(req);

    // 계정이 사라졌습니다 (Accounts alarm) — 방도 통째로 비웁니다
    if (path === "/wipe") {
      for (const ws of this.ctx.getWebSockets()) {
        try {
          ws.close(1000, "gone");
        } catch (e) {}
      }
      await S.deleteAll();
      return json({ ok: true });
    }

    /* 이 계정이 이 방에서 어떤 상태인지 (Accounts /me → 방).
       `live` 는 "지금 판이 살아 있나"입니다 — 마지막으로 받은 판이 끝난 판(end)도
       얼어 있는 판(paused)도 아니어야 합니다 (§3.4). 시작 전(state.lobby)도 살아 있는 판입니다.
       `round` 는 그중 "진행 중"만 — 로비 복귀 줄의 `시작 전/진행 중` 과 [나가기] 확인창이 봅니다
       (2026-09-06 검증에서 고침: live 로 표시하니 시작 전 파티가 `진행 중` 이라 했고 나가기가 물었다) */
    if (path === "/seat-of") {
      const { acct } = await req.json().catch(() => ({}));
      if (typeof acct !== "string" || !acct) return json({ error: "bad json" }, 400);
      const m = await S.get("m:" + acct);
      if (!m) return json({ st: null, live: false });
      const [state, paused] = await Promise.all([S.get("state"), S.get("paused")]);
      const live = !!state && !state.end && !paused;
      return json({
        st: m.st,
        live,
        round: live && !state.lobby,
        ownerNick: (await S.get("ownerNick")) || "",
      });
    }

    /* 이 사람이 다른 방에 앉았습니다 (§3.3 파티 하나 규칙, Accounts → 방).
       내보내기와 같은 처리입니다 — 통지 뒤에 그 사람의 뷰어 소켓을 닫습니다 */
    if (path === "/seat-drop") {
      const { acct } = await req.json().catch(() => ({}));
      if (typeof acct !== "string" || !acct) return json({ error: "bad json" }, 400);
      if (!(await S.get("m:" + acct))) return json({ ok: true, dropped: false });
      await S.delete("m:" + acct);
      await this.arm();
      this.toScribe({ kind: "left", acct });
      this.toAcct(acct, { kind: "you", you: null });
      this.dropAcct(acct);
      return json({ ok: true, dropped: true });
    }

    // 닉 변경 통지 (Accounts DO → 방)
    /* 초상화가 바뀌었다 (Accounts /api/auth/avatar → 방) — 명단의 ava 를 갈고 방장 앱에 알린다 */
    if (path === "/ava-changed") {
      /* 본문 파싱 블록보다 앞이라 직접 읽는다 (nick-changed 와 같음) */
      const { acct, ava } = await req.json().catch(() => ({}));
      if (typeof acct !== "string" || !acct || !ava || typeof ava !== "object") return json({ error: "bad json" }, 400);
      const m = await S.get("m:" + acct);
      if (m) {
        m.ava = { id: ava.id || null, a: ava.a || null, p: ava.p || null, u: ava.u };
        await S.put("m:" + acct, m);
      }
      this.toScribe({ kind: "ava", acct, ava });
      return json({ ok: true });
    }
    if (path === "/nick-changed") {
      const { acct, nick } = await req.json().catch(() => ({}));
      if (typeof acct !== "string" || typeof nick !== "string") return json({ error: "bad json" }, 400);
      if ((await S.get("owner")) === acct) await S.put("ownerNick", nick);
      const m = await S.get("m:" + acct);
      if (m) {
        m.nick = nick;
        await S.put("m:" + acct, m);
        this.toAcct(acct, { kind: "you", you: youOf(m) });
      }
      this.toScribe({ kind: "nick", acct, nick });
      return json({ ok: true });
    }

    /* 익명 계정이 정식이 됐습니다 (Accounts /upgrade → 방).
       계정의 이름이 바뀌었을 뿐 같은 사람이라, 방장 자리도 명단의 한 줄도 그 자리에 둡니다 */
    if (path === "/acct-renamed") {
      const { from, to, nick } = await req.json().catch(() => ({}));
      if (typeof from !== "string" || typeof to !== "string" || !from || !to)
        return json({ error: "bad json" }, 400);
      if ((await S.get("owner")) === from) {
        await S.put("owner", to);
        if (typeof nick === "string" && nick) await S.put("ownerNick", nick);
      }
      const mm = await S.get("m:" + from);
      if (mm) {
        if (typeof nick === "string" && nick) mm.nick = nick;
        await S.put("m:" + to, mm);
        await S.delete("m:" + from);
      }
      // 붙어 있는 소켓의 이름표도 갈아 끼웁니다 — 안 그러면 you 통지가 옛 이름으로 갑니다
      for (const ws of this.ctx.getWebSockets()) {
        const a = tagOf(ws);
        if (!a || a.acct !== from) continue;
        try {
          ws.serializeAttachment({ ...a, acct: to });
        } catch (e) {}
      }
      return json({ ok: true });
    }

    let b = {};
    if (req.method !== "GET") {
      const raw = await req.text();
      if (raw.length > MAX_STATE_BYTES) return json({ error: "too big" }, 413);
      if (raw) {
        try {
          b = JSON.parse(raw);
        } catch (e) {
          return json({ error: "bad json" }, 400);
        }
      }
    }

    // 자기 방 열기 — 처음이면 여기서 방장이 정해집니다
    if (path === "/my-room") {
      if (!me) return json({ error: "unauthorized" }, 401);
      const roomId = req.headers.get("x-room");
      let owner = await S.get("owner");
      if (!owner) {
        owner = me.id;
        await S.put({ owner, roomId });
      }
      if (owner !== me.id) return json({ error: "forbidden" }, 403);
      await S.put("ownerNick", me.nick);
      const [invite, lobby, paused] = await Promise.all([
        S.get("invite"),
        S.get("lobby"),
        S.get("paused"),
      ]);
      /* 중단은 서버에 사는 상태입니다 — 다른 기기에서 열어도 얼어 있는 판을 얼어 있는
         채로 만나고, 자동 중단 카드도 그 기기에서 뜹니다 (§3.4) */
      return json({
        roomId,
        invite: invite || null,
        lobby: lobby || { open: false, cap: 8, since: 0 },
        paused: paused ? { why: paused.why, t: paused.t } : null,
      });
    }

    /* 방장 앱이 미는 스냅샷. 서버는 판을 해석하지 않고 그대로 나릅니다 —
       읽는 건 명단을 줄에 잇는 데 쓰는 rows2 하나뿐입니다 */
    if (path === "/state" && req.method === "PUT") {
      if (!(await this.isOwner(me))) return json({ error: "forbidden" }, 403);
      await this.doState(b, now);
      return json({ ok: true, watchers: this.ctx.getWebSockets().length });
    }

    // 새 기기에 장부를 앉힐 때 한 장 통째로
    if (path === "/read" && req.method === "GET") {
      if (!(await this.isOwner(me))) return json({ error: "forbidden" }, 403);
      return json({ state: (await S.get("state")) || null });
    }

    /* 지금 코드 (2026-09-06) — 새 판 만들기·새로고침이 있는 코드를 그대로 씁니다. 죽었으면 null */
    if (path === "/invite" && req.method === "GET") {
      if (!(await this.isOwner(me))) return json({ error: "forbidden" }, 403);
      const inv = await S.get("invite");
      /* 방장에게는 아직 안 뿌린 코드도 보여야 메시지를 만들 수 있습니다 (2026-09-08) —
         입장 판정만 inviteOk 가 맡습니다. 뿌린 뒤 죽은 코드는 null 로 줘서 새로 나게 합니다 */
      const live = !!inv && (!inv.armed || (inv.exp || 0) > now);
      return json({ invite: live ? inv : null });
    }
    // 초대 재발급 — 옛 코드는 그 자리에서 무효, 기존 멤버는 무영향
    if (path === "/invite" && req.method === "POST") {
      if (!(await this.isOwner(me))) return json({ error: "forbidden" }, 403);
      /* 발급하면 바로 시계가 돕니다 (2026-09-20 사용자: 발급과 복사가 한 단추) — 옛 코드는 이 줄에서 죽습니다.
         (폐기 2026-09-08) 복사할 때 /invite-arm 이 켜던 것 — 단추가 하나가 되면서 켤 자리가 없어졌습니다 */
      const invite = { code: rid(8), exp: now + INVITE_MS, armed: true };
      await S.put("invite", invite);
      /* "비우고 발급" (2026-09-20 사용자) — 새 사람들과 하는 다음 판. 방장 말고 다 내보냅니다.
         줄과 벌금 숫자는 방장의 표에 그대로 있고, 여기서는 이 방의 명단만 비웁니다 */
      if (b.wipe) {
        const owner0 = await S.get("owner");
        for (const [k] of await S.list({ prefix: "m:" })) {
          const acct = k.slice(2);
          if (acct === owner0) continue;
          await S.delete(k);
          await S.delete("x:" + acct);
          await this.clearUndo(acct);
          await this.releaseSeat(acct, req);
          this.toScribe({ kind: "left", acct });
        }
      }
      /* 코드만으로 찾아오는 길 (§3.0 로비 입장칸) — 계정부 색인에 한 줄. 유효는 방이 판단하므로 색인은 넉넉히 */
      try {
        await this.toAccounts("/code-index", { code: invite.code, room: await this.roomId(req), exp: now + INVITE_INDEX_MS });
      } catch (e) {
        /* 색인이 안 돼도 초대 자체는 살아 있습니다 — 주소 붙여넣기는 색인 없이 됩니다 */
      }
      return json({ invite });
    }

    /* 시계 켜기 (2026-09-08 사용자 확정) — 방장이 [디코 메시지 복사]를 누른 순간이 부르는 순간입니다.
       다시 누르면 다시 10분입니다: 늦게 오는 사람에게 다시 보내는 김에 되살아납니다.
       진짜 무효화는 [새로 발급](POST /invite)이 맡습니다 */
    if (path === "/invite-arm" && req.method === "POST") {
      if (!(await this.isOwner(me))) return json({ error: "forbidden" }, 403);
      let inv = await S.get("invite");
      if (!inv || !inv.code) {
        inv = { code: rid(8), exp: 0, armed: false };
        try {
          await this.toAccounts("/code-index", { code: inv.code, room: await this.roomId(req), exp: now + INVITE_INDEX_MS });
        } catch (e) {
          /* 색인이 안 돼도 링크로 들어오는 길은 삽니다 */
        }
      }
      const invite = { ...inv, armed: true, exp: now + INVITE_MS };
      await S.put("invite", invite);
      return json({ invite });
    }

    if (path === "/lobby" && req.method === "POST") {
      if (!(await this.isOwner(me))) return json({ error: "forbidden" }, 403);
      const cur = (await S.get("lobby")) || { open: false, cap: 8, since: 0 };
      let cap = cur.cap || 8;
      if (b.cap != null) {
        const c = Math.round(Number(b.cap));
        /* 1도 됩니다 — 혼자 한 줄 판. 인원 수 = 명단 칸 수라 아래로는 앱이 막습니다 (§3.1) */
        if (!(c >= 1 && c <= 16)) return json({ error: "bad cap" }, 400);
        cap = c;
      }
      const open = !!b.open;
      /* 로비를 열고 닫는 것은 "모으는 중"의 표시일 뿐입니다 — 멤버십은 건드리지 않습니다 (§1).
         멤버십이 끊기는 길은 본인 [나가기]와 방장 내보내기 둘뿐이고, 해산(전원 킥) 동사는
         없습니다 (§3.4). 로비 6시간 자동 닫힘도 폐기했습니다 — 로비는 영구입니다 (§1). */
      const lobby = { open, cap, since: open ? (cur.open && cur.since ? cur.since : now) : 0 };
      await S.put("lobby", lobby);
      /* 판 존재 표시 (2026-09-06 모델) — 새 판 만들기가 로비를 열며 켭니다. 끄는 것은 /end 뿐입니다 */
      if (open) await S.put("party", { at: now });
      this.bcast({ kind: "lobby", lobby });
      return json({ lobby });
    }

    /* [중단] — 아무것도 지우지 않고 얼립니다. 전 구독자에게 알려서 파티원 앱이
       얼림 띠를 그리게 합니다 (§3.4) */
    if (path === "/pause" && req.method === "POST") {
      if (!(await this.isOwner(me))) return json({ error: "forbidden" }, 403);
      await this.setPaused(true, "host");
      return json({ ok: true, paused: true });
    }

    // [이어가기] — 표시만 내립니다. 사람·셈·연결은 애초에 그대로였습니다
    if (path === "/resume" && req.method === "POST") {
      if (!(await this.isOwner(me))) return json({ error: "forbidden" }, 403);
      await this.setPaused(false);
      return json({ ok: true, paused: false });
    }

    /* [정산 끝내기]·[해산] — 판이 없어집니다 (2026-09-06 모델). 파티원은 마지막으로 받은 결과지를
       계속 보고, 방장이 새 판을 만들면 그 화면의 띠가 [들어가기]로 바뀝니다 */
    if (path === "/end" && req.method === "POST") {
      if (!(await this.isOwner(me))) return json({ error: "forbidden" }, 403);
      const cleared = await this.endParty(req, now);
      return json({ ok: true, cleared });
    }

    if (path === "/members" && req.method === "GET") {
      if (!(await this.isOwner(me))) return json({ error: "forbidden" }, 403);
      const round = (await S.get("round")) || null;
      return json({ list: await this.members(), roundAt: round ? round.at : 0 });
    }
    /* [비우기] = 판의 경계 (§3.12.2·§3.12.3). 그 뒤 앱을 연 사람만 "이번 판에 온 사람"입니다 */
    if (path === "/round" && req.method === "POST") {
      if (!(await this.isOwner(me))) return json({ error: "forbidden" }, 403);
      await S.put("round", { at: now });
      return json({ ok: true, roundAt: now });
    }
    /* 오버레이 다시 붙기 (§3.12.6) — 이 계정의 OBS 소켓만 닫습니다. 페이지는 닫히면 주소를 다시 풀어 새 방을 찾습니다 */
    if (path === "/obs-rehome") {
      /* 본문은 위에서 이미 b 로 읽었다 — req.json() 을 다시 부르면 빈 객체가 와서 400 으로 새고 오버레이가 영영 안 옮겨진다 (2026-09-16 실측) */
      const acct = b && b.acct;
      if (typeof acct !== "string" || !acct) return json({ error: "bad json" }, 400);
      for (const ws of this.ctx.getWebSockets()) {
        const a = tagOf(ws);
        if (!a || a.k !== "v" || a.acct !== acct || !a.o) continue;
        this.send(ws, { kind: "you", you: null });
        try {
          ws.close(1000, "rehome");
        } catch (e) {}
      }
      return json({ ok: true });
    }

    // 수락 / 내보내기·거절·해제 — 전부 이 방 범위이고 가역입니다
    if (path === "/member" && req.method === "POST") {
      if (!(await this.isOwner(me))) return json({ error: "forbidden" }, 403);
      const acct = String(b.acct || "");
      const m = await S.get("m:" + acct);
      if (!m) return json({ error: "no member" }, 404);
      if (b.action === "approve") {
        /* 정원은 여기서 셉니다 (§4.2). 문 앞에서 미리 막으면 방장이 신청을 보지도 못한 채
           거절되고, 자리를 하나 비운 뒤에도 그 사람은 다시 눌러야 합니다.
           방장이 대기실 첫 자리를 차지하므로 +1 합니다 (§3-2).
           로비가 닫힌 뒤(출발 후) 합류에는 정원이 없습니다 — 대기실 정원이지 파티 정원이 아닙니다 */
        /* 자리 내주기 (§3.12.4): 방장이 고른 줄에 다른 사람이 앉아 있으면 그 사람은 자리 없는 회원이 됩니다.
           벌금이 적힌 줄을 내주지 않는 판단은 표를 가진 앱이 합니다 */
        if (typeof b.rowId === "string" && b.rowId) {
          for (const [k, v] of await S.list({ prefix: "m:" })) {
            const other = k.slice(2);
            if (other === acct || !v || v.rowId !== b.rowId) continue;
            const nv = { ...v, rowId: null };
            await S.put(k, nv);
            await this.clearUndo(other);
            this.toAcct(other, { kind: "you", you: youOf(nv) });
          }
        }
        m.st = "ok";
        m.t = now;
        /* 앉았으니 "자리가 없어 내려앉은 신청" 표시는 걷습니다 — 내보냈던 기록도 여기서 지웁니다 (§3.3) */
        delete m.inv;
        delete m.kicked;
        delete m.full;
        await S.delete("x:" + acct);
        if (typeof b.rowId === "string" && b.rowId && m.rowId !== b.rowId) {
          if (m.rowId) await this.clearUndo(acct);
          m.rowId = b.rowId;
        }
        await S.put("m:" + acct, m);
        /* st:"ok" 가 되는 순간이 파티 하나 규칙이 걸리는 자리입니다 (§3.3) */
        await this.claimSeat(acct, req);
        /* 계정이 붙은 자리가 생겼습니다 — 이제부터 이 판은 자동 중단의 대상입니다 (§3.4) */
        await this.arm();
        /* 한 번 수락되면 함께한 사람 관계가 생겨 다음부터는 링크가 필요 없습니다 (§3.3) */
        await this.toAccounts("/mated", { a: me.id, b: acct });
        this.toAcct(acct, { kind: "you", you: youOf(m) });
        return json({ ok: true, member: { acct, ...youOf(m) } });
      }
      /* 줄에서 빼기 (2026-09-17 자리 배치 창) — 명단엔 남고 자리만 비운다. 창의 오른쪽 목록으로 돌아간 사람 */
      if (b.action === "unseat") {
        if (m.st !== "ok") return json({ error: "not seated" }, 409);
        if (m.rowId) {
          m.rowId = null;
          m.t = now;
          await S.put("m:" + acct, m);
          await this.clearUndo(acct);
        }
        this.toAcct(acct, { kind: "you", you: youOf(m) });
        return json({ ok: true, member: { acct, ...youOf(m) } });
      }
      if (b.action === "remove") {
        /* 내보낸 사람은 같은 링크로 와도 즉시 착석이 아니라 방장 승인입니다 (§3.3, 2026-09-05 표준화).
           표시는 승인 때 지워집니다 — 실수로 내보낸 경우의 복구 길이 그것입니다 */
        await S.put("x:" + acct, { t: now });
        await S.delete("m:" + acct);
        await this.clearUndo(acct);
        await this.releaseSeat(acct, req);
        // 마지막 파티원이 빠지면 혼자 판입니다 — 자동 중단 알람을 걷습니다
        await this.arm();
        this.toAcct(acct, { kind: "you", you: null });
        /* 통지 뒤에 그 사람의 뷰어 소켓을 닫습니다 (§4.2) — 안 닫으면 브라우저가 끊김을
           알아챌 때까지 2~3초 동안 못 보는 판이 화면에 남습니다 */
        this.dropAcct(acct);
        return json({ ok: true });
      }
      return json({ error: "bad action" }, 400);
    }

    /* 판 도중 합류자의 자리 고르기 (§3.2·§4.2) — 방장이 자리 없이 수락한(rowId 없는)
       멤버가 자기 줄을 고릅니다. 계정이 이미 붙은 줄은 못 고르고, 한 번 고르면
       잠깁니다 — 바꾸는 길은 방장의 [자리 바꾸기](bindings)뿐입니다. 벌금이 붙은
       줄을 누가 이어받는지는 사람이 정해야 해서, 서버는 선택을 지키기만 합니다 */
    if (path === "/seat" && req.method === "POST") {
      if (!me) return json({ error: "unauthorized" }, 401);
      const m = await S.get("m:" + me.id);
      if (!m || m.st !== "ok") return json({ error: "forbidden" }, 403);
      const st = await S.get("state");
      /* 시작 전(모집 중 = state.lobby 가 있음)에는 자리를 옮길 수 있습니다 (§3.2, 2026-09-05 표준화 — 빈 슬롯을
         누르면 옮겨 가는 로비 문법). 진행 중엔 줄에 벌금이 붙어 있어 방장이 배치합니다 */
      if (m.rowId && !(st && st.lobby)) return json({ error: "seated" }, 409);
      const rowId = typeof b.rowId === "string" ? b.rowId : "";
      if (!rowId) return json({ error: "bad row" }, 400);
      /* 줄이 실제로 있고 비어 있는지는 방장이 민 상태가 압니다 — 방장 줄(a:1)도
         멤버 목록에는 없어서, 상태의 표시가 문지기입니다 */
      const r2 = st && Array.isArray(st.rows2) ? st.rows2.find((x) => x.rowId === rowId) : null;
      if (st && Array.isArray(st.rows2) && !r2) return json({ error: "bad row" }, 400);
      if (r2 && r2.a) return json({ error: "taken" }, 409);
      const taken = (await this.members()).some((x) => x.st === "ok" && x.rowId === rowId);
      if (taken) return json({ error: "taken" }, 409);
      const from = m.rowId || null;
      if (from && from !== rowId) await this.clearUndo(me.id);
      m.rowId = rowId;
      m.t = now;
      await S.put("m:" + me.id, m);
      this.toScribe({ kind: "seat", acct: me.id, nick: me.nick, rowId, from });
      return json({ ok: true, you: youOf(m) });
    }

    /* 들어오는 길 셋 (§3.3·§4.2 라운드 B).
       (a) 지목 초대 — 방장이 이미 고른 사람이라 방장 수락이 없습니다.
       (b) 코드 없음 — 노크. 방장의 함께한 사람만 문 앞에 설 수 있습니다.
       (c) 링크 = 초대장 (2026-09-05 개정, §3.3) — 유효한 코드면 바로 앉습니다. 방장이 골라 보낸
           10분짜리 비밀 코드고, 새는 링크는 재발급·내보내기가 막습니다. 정원은 모집 중일 때만 세고,
           만석이면 지목 초대와 같은 갈래로 신청으로 내려앉힙니다.
           (폐기) "소지자 표라 언제나 신청" — 초대받고 왔는데 문 앞에 세워지는 게 낯설었습니다 */
    if (path === "/join" && req.method === "POST") {
      if (!me) return json({ error: "unauthorized" }, 401);
      const owner = await S.get("owner");
      if (!owner) return json({ error: "no room" }, 404);
      if (owner === me.id) return json({ ok: true, st: "ok", you: null });
      const cur = await S.get("m:" + me.id);
      if (cur) {
        if (cur.nick !== me.nick || (me.dcu && cur.dcu !== me.dcu)) {
          cur.nick = me.nick;
          if (me.dcu) cur.dcu = me.dcu;
          await S.put("m:" + me.id, cur);
        }
        return json({ ok: true, st: cur.st, you: youOf(cur), already: true });
      }
      /* 코드 없는 링크 (§3.12.5). 처음 온 사람은 늘 요청으로 서고 방장이 [받기]로 앉힙니다.
         내보냈던 사람도 같은 줄에 kicked 표시로 섭니다. 판이 있는지는 묻지 않습니다 — owner 가 있으면 열린 방입니다.
         (폐기 2026-09-15) 지목 초대(inv)·함께한 사람 노크(mate-of)·10분 코드·대기실 정원 */
      /* 초대가 살아 있어야 들어옵니다 (2026-09-20 사용자) — 만료가 어제 파티와 오늘 파티를 가릅니다.
         이미 명단에 있는 사람은 이 줄 위에서 돌아갑니다(자격은 명단에 있지 초대에 있지 않습니다).
         (폐기 2026-09-15) 코드 없는 링크 — 한 번 새면 영영 열린 문이었고, 어제 사람과 오늘 사람이 안 갈렸습니다 */
      const inv = await S.get("invite");
      const jcode = String(b.j || "").toUpperCase();
      if (!inv || !inv.code || jcode !== inv.code) return json({ error: "no invite" }, 403);
      if (!this.inviteOk(inv, now)) return json({ error: "invite expired" }, 410);
      const kicked = !!(await S.get("x:" + me.id));
      const m = { nick: me.nick, dcu: me.dcu || "", rowId: null, st: "req", t: now };
      if (kicked) m.kicked = 1;
      if (b.ava && typeof b.ava === "object")
        m.ava = { id: b.ava.id ? String(b.ava.id) : null, a: b.ava.a ? String(b.ava.a) : null, p: b.ava.p ? Number(b.ava.p) || null : null, u: b.ava.u ? String(b.ava.u) : undefined };
      await S.put("m:" + me.id, m);
      this.toScribe({ kind: "join", acct: me.id, nick: me.nick, st: "req", seat: null, link: 1, kicked: kicked ? 1 : 0, full: 0, ava: m.ava || null });
      return json({ ok: true, st: "req", you: youOf(m), full: false, kicked });
    }

    /* [나가기]와 [신청 취소]가 같은 길입니다 — st:"req" 도 여기서 지워집니다 (§4.2 라운드 B).
       문 앞에 서 있던 사람이 물러나는 것이라, 방장 쪽 신청 칸에서도 그대로 사라집니다 */
    if (path === "/leave" && req.method === "POST") {
      if (!me) return json({ error: "unauthorized" }, 401);
      if (await S.get("m:" + me.id)) {
        await S.delete("m:" + me.id);
        await this.clearUndo(me.id);
        await this.releaseSeat(me.id, req);
        await this.arm();
        this.toScribe({ kind: "left", acct: me.id });
        this.toAcct(me.id, { kind: "you", you: null });
      }
      return json({ ok: true });
    }

    /* 외형이 바뀌었다고 제 오버레이에 알립니다 (2026-09-07).
       계정 외형은 /api/auth/look 이 진본이고, 오버레이는 그걸 붙을 때 한 번만 받아 왔습니다 —
       그래서 테마를 고쳐도 OBS 소스를 새로고침해야 반영됐습니다(사용자 지적).
       서버는 여기서도 해석하지 않고 그 계정의 뷰어 소켓에만 그대로 넘깁니다. 폴링은 안 씁니다 —
       켜 둔 채 방치된 소스 하나가 하루 수천 번 서버를 두드리게 되니까요. */
    /* 들여다보기 (§3.12.5, 2026-09-16) — 링크로 온 사람이 아직 명단에 없어도 방장 별명은 알아야 옮기기 확인창에 이름을 적는다.
       세션만 있으면 되고, 별명 하나만 준다 */
    if (path === "/peek" && req.method === "GET") {
      if (!me) return json({ error: "unauthorized" }, 401);
      const owner = await S.get("owner");
      if (!owner) return json({ error: "gone" }, 404);
      return json({ ownerNick: (await S.get("ownerNick")) || null });
    }
    if (path === "/look" && req.method === "POST") {
      if (!me) return json({ error: "unauthorized" }, 401);
      const look = b && b.look && typeof b.look === "object" && !Array.isArray(b.look) ? b.look : null;
      if (look) this.toAcct(me.id, { kind: "look", look });
      return json({ ok: true });
    }

    /* 자수 — 서버는 적지 않고 서기에게 넘깁니다. 장부의 원본은 방장 앱입니다.
       소켓이 주 통로이고(LIVE-SPEC §2.1) 이 길은 소켓이 없을 때와 옛 앱을 위해 남습니다 */
    if (path === "/confess" && req.method === "POST") {
      if (!me) return json({ error: "unauthorized" }, 401);
      this.checkAck(now);
      const r = await this.doConfess(me, b, now);
      if (!r.ok) return json({ error: r.error }, r.status);
      return json({ ok: true });
    }

    return json({ error: "not found" }, 404);
  }

  /* 구독. 뷰어는 멤버십·초대·방송용 토큰 중 하나가 있어야 하고, 서기는 방장 세션만 */
  async socket(req, url, isScribe, me) {
    if (req.headers.get("Upgrade") !== "websocket") return json({ error: "upgrade required" }, 426);
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    const S = this.ctx.storage;
    const owner = await S.get("owner");

    if (isScribe) {
      if (!me || me.id !== owner) return this.deny(client, server, "member");
      const before = this.scribeOn();
      server.serializeAttachment({ k: "scribe", acct: me.id });
      this.ctx.acceptWebSocket(server);
      this.send(server, { kind: "members", list: await this.members() });
      // 0↔1 전환에서만 알립니다 — 기기를 두 대 켜도 방송이 깜빡이지 않게
      if (!before) this.bcast({ kind: "presence", scribeOn: true }, (ws) => ws !== server);
      return new Response(null, { status: 101, webSocket: client });
    }

    /* 방장이 없는 방 = 만들어진 적 없는 방이거나 계정 이전의 방입니다 (§4.4).
       옛 주소가 아직 OBS 에 꽂혀 있는 사람이 있어서, 초대가 없어서 막힌 것과 구분해 줍니다 —
       그 사람에게 맞는 답은 "새 주소를 받아 넣어라" 하나뿐입니다 */
    if (!owner) return this.deny(client, server, "gone");

    let you = null;
    let ok = false;
    if (me) {
      if (me.id === owner) {
        // 방장은 자기 방 명단에 없지만 자기 판은 봅니다 (방송용 주소가 이 경로입니다)
        you = { nick: (await S.get("ownerNick")) || me.nick, rowId: null, st: "ok" };
        ok = true;
      } else {
        const m = await S.get("m:" + me.id);
        if (m) {
          you = youOf(m);
          ok = true;
        }
      }
    }
    let why = me ? "member" : "invite";
    if (!ok) {
      const inv = await S.get("invite");
      const j = String(url.searchParams.get("j") || "").toUpperCase();
      if (owner && inv && j && j === inv.code) {
        if (this.inviteOk(inv, Date.now())) ok = true;
        /* 코드는 맞는데 시간이 지난 것입니다 — 문구가 다릅니다 (§8). 로그인 상태도 같습니다 (2026-09-05) */
        else why = "expired";
      }
    }
    if (!ok) return this.deny(client, server, why);

    const isObs = url.searchParams.get("o") === "1";
    const firstApp = !!me && !isObs && !this.acctOn(me.id);
    server.serializeAttachment({ k: "v", acct: me ? me.id : null, o: isObs ? 1 : 0 });
    this.ctx.acceptWebSocket(server);
    /* 파티원이 붙었습니다 — 방장 앱의 접속 표시 (§5.6) */
    if (me && !isObs) this.toScribe({ kind: "viewer", acct: me.id, on: true });
    if (me && !isObs && me.id !== owner) {
      /* 이번 판에 앱을 연 사람 (§3.12.3) — 화면엔 안 그리고 [받기]의 기본 자리에만 씁니다 */
      const mm = await S.get("m:" + me.id);
      if (mm) {
        mm.seen = Date.now();
        await S.put("m:" + me.id, mm);
      }
      /* 접속 방 (§3.12.6) — 방장 자신은 내 방이 기본이라 알릴 것이 없습니다 */
      if (firstApp && this.presTimers && this.presTimers[me.id]) {
        clearTimeout(this.presTimers[me.id]);
        delete this.presTimers[me.id];
      }
      if (firstApp) this.ctx.waitUntil(this.presence(me.id, true, req));
    }
    const on = this.scribeOn();
    const pz = await S.get("paused");
    const paused = pz ? { why: pz.why } : null;
    this.send(server, {
      kind: "hello",
      you,
      scribeOn: on,
      paused,
      ownerNick: (await S.get("ownerNick")) || "",
    });
    /* 요청 중인 사람에게는 판을 보내지 않습니다 (§3.12.5) — 받기 전에는 표를 못 봅니다 */
    if (!(you && you.st === "req"))
      this.send(server, { kind: "state", state: (await S.get("state")) || null, scribeOn: on, paused });
    return new Response(null, { status: 101, webSocket: client });
  }

  /* 거절도 101 로 받아서 이유를 한 줄 주고 닫습니다 — 오버레이가 조용히 물러날 수 있게 */
  deny(client, server, why) {
    server.accept();
    try {
      server.send(JSON.stringify({ kind: "denied", why }));
      server.close(1008, why);
    } catch (e) {}
    return new Response(null, { status: 101, webSocket: client });
  }

  /* ---------- 판 푸시와 자수의 몸통 ----------
     HTTP 와 소켓이 같은 함수를 부릅니다 (LIVE-SPEC §3). 검사를 두 벌로 만들면
     갈라지고, 갈라지면 소켓 쪽만 느슨해지는 사고가 납니다 */

  /* 방장 앱이 미는 스냅샷. 서버는 판을 해석하지 않고 그대로 나릅니다 —
     읽는 건 명단을 줄에 잇는 데 쓰는 bindings 하나뿐입니다 */
  async doState(b, now) {
    const S = this.ctx.storage;
    const state = b.state === undefined ? null : b.state;
    const moved = [];
    if (b.bindings && typeof b.bindings === "object") {
      for (const [acct, rowId] of Object.entries(b.bindings)) {
        const m = await S.get("m:" + acct);
        if (!m) continue;
        const v = typeof rowId === "string" && rowId ? rowId : null;
        if (m.rowId === v) continue;
        m.rowId = v;
        await S.put("m:" + acct, m);
        await this.clearUndo(acct);
        moved.push([acct, m]);
      }
    }
    /* 닉네임 매칭 재연결은 폐기했습니다 (§3.2·§3.7). 연결은 판의 행이 아니라 로비의
       자리에 살아서, '처음부터'로 판이 갈려도 방장 앱이 자리에서 뽑은 bindings 를
       그대로 실어 보냅니다 — 서버가 이름을 보고 짐작할 일이 없습니다. */
    await S.put({ state, stateAt: now });
    /* 판이 돌아왔습니다 — 서기가 살아 있다는 증거입니다 (LIVE-SPEC §2.4) */
    this.clearAck();
    await this.arm();
    const on = this.scribeOn();
    const paused = await S.get("paused");
    this.toViewers({ kind: "state", state, scribeOn: on, paused: paused ? { why: paused.why } : null });
    // 줄이 바뀐 사람은 자기 줄을 다시 알아야 자수를 누를 수 있습니다
    for (const [acct, m] of moved) this.toAcct(acct, { kind: "you", you: youOf(m) });
  }

  /* 자수 한 건. 통과하면 서기에게 넘기고 왕복 감시를 겁니다 */
  async doConfess(me, b, now, cid) {
    const S = this.ctx.storage;
    const m = await S.get("m:" + me.id);
    if (!m || m.st !== "ok") return { ok: false, error: "forbidden", status: 403 };
    const dir = Number(b.dir);
    const colId = String(b.colId == null ? "" : b.colId);
    if ((dir !== 1 && dir !== -1) || !colId || colId.length > 64)
      return { ok: false, error: "bad request", status: 400 };
    if (!m.rowId || b.rowId !== m.rowId) return { ok: false, error: "not your row", status: 403 };
    // 얼어 있는 판에는 아무것도 못 적습니다 — 방장이 이어가면 다시 눌립니다 (§3.4)
    if (await S.get("paused")) return { ok: false, error: "paused", status: 409 };
    let g = (await S.get("cg:" + me.id)) || { n: 0, until: 0 };
    if (g.until <= now) g = { n: 0, until: now + 60000 };
    g.n++;
    await S.put("cg:" + me.id, g);
    if (g.n > CONFESS_PER_MIN) return { ok: false, error: "slow down", status: 429 };
    if (!this.scribeOn()) return { ok: false, error: "scribe-off", status: 409 };
    /* 되돌리기는 방금(30초 안) 올린 만큼만 — 항목별로 올린 수와 마지막 시각을 기억합니다 */
    const ck = "cf:" + me.id + ":" + colId;
    const cf = (await S.get(ck)) || { n: 0, t: 0 };
    if (dir === -1) {
      if (cf.n <= 0 || now - cf.t > CONFESS_UNDO_MS) return { ok: false, error: "late", status: 409 };
      await S.put(ck, { n: cf.n - 1, t: cf.t });
    } else {
      await S.put(ck, { n: (now - cf.t > CONFESS_UNDO_MS ? 0 : cf.n) + 1, t: now });
    }
    this.toScribe({
      kind: "confess",
      acct: me.id,
      nick: m.nick,
      rowId: m.rowId,
      colId,
      dir,
      t: now,
    });
    this.waitAck(me.id, cid == null ? null : String(cid).slice(0, 40), now);
    return { ok: true };
  }

  /* ---------- 왕복 감시 (LIVE-SPEC §2.4) ----------
     기다리는 자수는 **메모리에만** 둡니다. 저장에 적으면 자수 한 번에 쓰기가 둘 늘어
     무료 플랜의 병목(하루 10만 줄)이 그만큼 깎입니다.
     DO 가 잠들어 이 값과 타이머를 잃어도 잃는 것이 거의 없습니다 — 다음 자수가 제 감시를
     새로 걸고, 그때 3초 뒤에 똑같이 잡힙니다. 늦어지는 것은 자수 한 번어치뿐입니다. */
  waitAck(acct, cid, now) {
    if (this.ackWait) return; // 먼저 기다리는 건이 있으면 그것이 대표합니다
    this.ackWait = { acct, cid, at: now };
    try {
      clearTimeout(this.ackTimer);
      this.ackTimer = setTimeout(() => {
        this.checkAck(Date.now());
      }, SCRIBE_ACK_MS + 100);
    } catch (e) {
      /* 타이머를 못 걸어도 다음 자수의 처음에서 걸립니다 */
    }
  }
  clearAck() {
    try {
      clearTimeout(this.ackTimer);
    } catch (e) {}
    this.ackTimer = null;
    this.ackWait = null;
  }
  checkAck(now) {
    const a = this.ackWait;
    if (!a) return;
    if ((now || Date.now()) - a.at < SCRIBE_ACK_MS) return;
    this.ackWait = null;
    /* 넘겼는데 답이 안 왔습니다 — 방장은 없는 것으로 봅니다.
       보낸 사람에게 한 줄 주고, 서기 소켓을 닫아 전원의 화면이 같이 잠기게 합니다 */
    this.toAcct(a.acct, { kind: "nope", cid: a.cid, why: "scribe-off", status: 409 });
    this.killScribe("no-ack");
  }
  /* 서기 소켓을 닫습니다. 방장이 살아 있었다면 곧 다시 붙고, 붙는 즉시 판을 한 장
     밀어서(LIVE-SPEC §2.2) 저절로 회복됩니다 */
  killScribe(why) {
    let had = false;
    for (const ws of this.ctx.getWebSockets()) {
      const a = tagOf(ws);
      if (!a || a.k !== "scribe") continue;
      had = true;
      try {
        ws.close(1011, why);
      } catch (e) {}
    }
    if (had) this.bcast({ kind: "presence", scribeOn: false });
  }

  /* 뷰어는 자수 하나만, 서기는 판 하나만 보낼 수 있습니다 (LIVE-SPEC §2.1·§2.2).
     그 밖의 메시지는 v2 §4.2 대로 전부 무시합니다. ping 은 런타임이 대신 답합니다 */
  async webSocketMessage(ws, msg) {
    if (typeof msg !== "string" || msg === "ping") return;
    if (msg.length > MAX_STATE_BYTES) return;
    const a = tagOf(ws);
    if (!a) return;
    let m = null;
    try {
      m = JSON.parse(msg);
    } catch (e) {
      return;
    }
    if (!m || typeof m !== "object") return;
    const now = Date.now();

    if (a.k === "scribe" && m.kind === "state") {
      // 서기 소켓은 붙을 때 방장임이 확인된 소켓입니다 (socket())
      await this.doState(m, now);
      return;
    }
    /* 방장 앱이 자수를 받았다고 답한 것입니다 (LIVE-SPEC §2.4). 판 푸시만으로는 모자랍니다 —
       방장 앱이 받은 자수를 조용히 버리는 길이 있어서(0회에서 빼기, 지금 판에 없는 항목)
       그때는 판이 안 바뀌고, 살아 있는 방장을 죽은 것으로 볼 뻔했습니다 */
    if (a.k === "scribe" && m.kind === "seen") {
      this.clearAck();
      return;
    }
    if (a.k === "v" && a.acct && m.kind === "confess") {
      this.checkAck(now);
      const cid = m.cid == null ? null : m.cid;
      const r = await this.doConfess({ id: a.acct }, m, now, cid);
      /* HTTP 의 200·에러와 같은 자리입니다 — 되돌리기 창의 셈은 서버가 받아 준 순간부터
         돕니다 (v2 §3.6). 소켓에는 응답이 없으니 한 줄을 따로 보냅니다 */
      if (r.ok) this.send(ws, { kind: "confess-ok", cid });
      else this.send(ws, { kind: "nope", cid, why: r.error, status: r.status });
      return;
    }
  }
  webSocketClose(ws) {
    this.gone(ws);
  }
  webSocketError(ws) {
    this.gone(ws);
  }
  async gone(ws) {
    const a = tagOf(ws);
    /* 파티원 소켓이 끊기면 방장에게 접속 표시를 내립니다 — 다른 탭이 남아 있으면 그대로 켜져 있습니다 */
    if (a && a.k === "v" && a.acct) {
      if (a.o) return;
      const still = this.acctOn(a.acct, ws);
      this.toScribe({ kind: "viewer", acct: a.acct, on: still });
      /* 마지막 앱 소켓이 끊겼다 — 여유 뒤에도 안 돌아오면 접속 방을 내립니다 (§3.12.6).
         DO 는 타이머가 걸린 동안 깨어 있지만 20초라 비용이 없습니다 */
      if (!still) {
        const owner = await this.ctx.storage.get("owner");
        if (a.acct === owner) return;
        this.presTimers = this.presTimers || {};
        if (this.presTimers[a.acct]) clearTimeout(this.presTimers[a.acct]);
        this.presTimers[a.acct] = setTimeout(() => {
          delete this.presTimers[a.acct];
          if (!this.acctOn(a.acct)) this.ctx.waitUntil(this.presence(a.acct, false, null));
        }, PRESENCE_GRACE_MS);
      }
      return;
    }
    if (!a || a.k !== "scribe") return;
    if (!this.scribeOn(ws)) {
      this.bcast({ kind: "presence", scribeOn: false }, (w) => w !== ws);
      /* (폐기 2026-09-08) 서기 소켓이 끊긴 시점부터 10분을 다시 세던 것 — 코드의 시계는 이제
         방장이 복사한 때부터만 돕니다. 앱을 닫는 것은 부르는 일과 상관이 없습니다 */
    }
  }

  /* 알람 하나로 다음 만료 시각을 관리합니다 — 자동 중단 24시간과 판 삭제 90일이 같이 삽니다.
     멤버가 없는 방(혼자 판)에는 자동 중단 알람을 걸지 않습니다 (§3.4) */
  async arm() {
    const S = this.ctx.storage;
    const [stateAt, paused] = await Promise.all([S.get("stateAt"), S.get("paused")]);
    const at = nextRoomAlarm({ stateAt, paused: !!paused, seated: await this.seated() });
    if (at) await S.setAlarm(Math.max(at, Date.now() + 1000));
    else await S.deleteAlarm();
  }

  async alarm() {
    const now = Date.now();
    const S = this.ctx.storage;
    const [stateAt, paused] = await Promise.all([S.get("stateAt"), S.get("paused")]);
    /* 무활동 24시간 — 잊힌 파티 판이 라이브로 남아 어제 파티원에게 오늘 셈이
       중계되지 않게 경계에서 얼립니다. 잃는 것은 없습니다 ([이어가기] 한 번이면 복귀) */
    if (shouldAutoPause({ stateAt, paused: !!paused, seated: await this.seated(), now }))
      await this.setPaused(true, "idle");
    /* 90일 무활동 — 판을 지웁니다. 판이 없어지는 것이니 해산과 같게 명단·표시도 비웁니다 (2026-09-06). 방·방장·코드는 남습니다 */
    if (stateAt && stateAt + STATE_IDLE_MS <= now) {
      await this.endParty(null, now);
      await S.delete(["state", "stateAt"]);
      this.toViewers({ kind: "state", state: null, scribeOn: this.scribeOn() });
    }
    await this.arm();
  }
}

/* -------- v1 의 기기 이사·복구 코드 보관소.
   이사는 이제 로그인이라 라우트를 뗐습니다. 클래스만 남깁니다 — 마이그레이션 안전용입니다. -------- */

export class Handoff {
  constructor(ctx) {
    this.ctx = ctx;
  }
  async fetch() {
    return json({ error: "gone" }, 410);
  }
}
