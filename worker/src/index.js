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
const INVITE_MS = 10 * 60 * 1000;
/* 판의 수명 판단(자동 중단 24시간·판 삭제 90일)은 round.js 가 갖고 있습니다 */
const ACCT_IDLE_MS = 365 * 86400 * 1000;
const ACCT_SCAN_MS = 7 * 86400 * 1000;

/* 상태 크기 상한 — 표에 더해 기록(최근 200건)까지 실립니다. 남용 방지용 */
const MAX_STATE_BYTES = 128 * 1024;
/* 계정부에 오는 본문은 전부 작습니다 — 외형(4KB)이 제일 큽니다 */
const MAX_AUTH_BYTES = 32 * 1024;
const LOOK_MAX_BYTES = 4 * 1024;
const CONFESS_PER_MIN = 20;
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
const ANON_NICK = "방장";

const RE_ID = /^[a-z0-9]{4,20}$/;
const RE_NICK = /^[가-힣a-zA-Z0-9]{2,3}$/;
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
  h.delete("upgrade");
  h.delete("connection");
  if (me) {
    h.set("x-acct", me.id);
    h.set("x-nick", encodeURIComponent(me.nick || ""));
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
      p === "/api/invite" ||
      new RegExp(`^/api/o/${TOK20}/resolve$`).test(p)
    )
      return accountsDO(env).fetch(new Request("https://do" + p, req));

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
        `^/api/r/(${ID6})/(state|read|invite|lobby|members|member|join|leave|confess|pause|resume|end)$`
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
        if (r.ok && r.data && r.data.roomId === roomId) me = { id: r.data.id, nick: r.data.nick };
      }
      const iu = new URL("https://do/" + kind);
      if (q.get("j")) iu.searchParams.set("j", q.get("j"));
      if (me) {
        iu.searchParams.set("acct", me.id);
        iu.searchParams.set("nick", me.nick || "");
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
      if (raw.length > MAX_AUTH_BYTES) return json({ error: "too big" }, 413);
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
    if (p === "/api/auth/anon" && req.method === "POST") {
      if (!(await this.regGuard(req, now))) return json({ error: "slow down" }, 429);
      const id = await this.freeId();
      if (!id) return json({ error: "could not allocate account" }, 503);
      const pw = hex(crypto.getRandomValues(new Uint8Array(32)));
      const salt = crypto.getRandomValues(new Uint8Array(16));
      const obsToken = await this.freeToken();
      const token = rid(32);
      const u = {
        id,
        nick: ANON_NICK,
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
      return json({ id, nick: ANON_NICK, token, obsToken });
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
      if (id !== old) await S.delete(["u:" + old, "lg:" + old]);
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
      };
      if (u.look) out.look = u.look;
      /* 함께한 사람과 대기 중인 지목 초대를 같이 싣습니다 (§4 라운드 B).
         전달 배관은 안 깝니다 — 앱이 열릴 때와 창에 초점이 돌아올 때 이 응답으로 확인합니다 */
      out.mates = await this.mateList(u.id);
      out.invites = await this.freshInvites(u.id, now);
      return json(out);
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
    if (p === "/api/auth/nick" && req.method === "POST") {
      const u = await this.session(req, now);
      if (!u) return json({ error: "unauthorized" }, 401);
      const nick = String(b.nick || "").trim();
      if (!RE_NICK.test(nick)) return json({ error: "bad nick" }, 400);
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
      if (!u || !u.cur) return json({ error: "not found" }, 404);
      u.seen = now;
      await S.put("u:" + id, u);
      // 외형이 저장돼 있으면 같이 보냅니다 — 오버레이가 주소를 안 고치고 갈아입습니다
      return u.look ? json({ roomId: u.cur, look: u.look }) : json({ roomId: u.cur });
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
      return json({ id: u.id, nick: u.nick });
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

    if (p === "/obs-verify") {
      const id = typeof b.token === "string" ? await S.get("t:" + b.token) : null;
      const u = id ? await S.get("u:" + id) : null;
      if (!u || !u.cur) return json({ error: "not found" }, 404);
      return json({ id: u.id, nick: u.nick, roomId: u.cur });
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
      u.cur = u.room;
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
        keys.push("lg:" + u.id, "f:" + u.id, "ig:" + u.id);
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
const youOf = (m) => (m ? { nick: m.nick, rowId: m.rowId || null, st: m.st } : null);

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
    return { id, nick: h ? decodeURIComponent(h) : "" };
  }
  whoQuery(url) {
    const id = url.searchParams.get("acct");
    if (!id) return null;
    return { id, nick: url.searchParams.get("nick") || "" };
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
  /* 옛 [파티 끝내기] 가 쓰던 전원 해제입니다. 해산(전원 킥) 동사는 폐기됐고 (§3.4)
     앱은 이 길을 부르지 않습니다 — 사람 정리는 본인 [나가기]와 방장 내보내기뿐입니다.
     라우트만 남겨 둡니다(옛 앱이 부를 수 있어서).
     통지 뒤 소켓을 닫는 것은 member remove 와 같은 이유입니다 (§4.2). */
  async clearMembers() {
    const list = await this.members();
    for (const m of list) {
      await this.ctx.storage.delete("m:" + m.acct);
      this.toAcct(m.acct, { kind: "you", you: null });
      this.dropAcct(m.acct);
    }
    return list.length;
  }

  scribeOn(except) {
    return this.ctx.getWebSockets().some((ws) => {
      if (ws === except) return false;
      const a = tagOf(ws);
      return !!a && a.k === "scribe";
    });
  }

  async members() {
    const out = [];
    for (const [k, v] of await this.ctx.storage.list({ prefix: "m:" }))
      out.push({ acct: k.slice(2), nick: v.nick, rowId: v.rowId || null, st: v.st, t: v.t });
    return out;
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

    // 닉 변경 통지 (Accounts DO → 방)
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
          moved.push([acct, m]);
        }
      }
      /* 닉네임 매칭 재연결은 폐기했습니다 (§3.2·§3.7). 연결은 판의 행이 아니라 로비의
         자리에 살아서, '처음부터'로 판이 갈려도 방장 앱이 자리에서 뽑은 bindings 를
         그대로 실어 보냅니다 — 서버가 이름을 보고 짐작할 일이 없습니다. */
      await S.put({ state, stateAt: now });
      await this.arm();
      const on = this.scribeOn();
      const paused = await S.get("paused");
      this.toViewers({ kind: "state", state, scribeOn: on, paused: paused ? { why: paused.why } : null });
      // 줄이 바뀐 사람은 자기 줄을 다시 알아야 자수를 누를 수 있습니다
      for (const [acct, m] of moved) this.toAcct(acct, { kind: "you", you: youOf(m) });
      return json({ ok: true, watchers: this.ctx.getWebSockets().length });
    }

    // 새 기기에 장부를 앉힐 때 한 장 통째로
    if (path === "/read" && req.method === "GET") {
      if (!(await this.isOwner(me))) return json({ error: "forbidden" }, 403);
      return json({ state: (await S.get("state")) || null });
    }

    // 초대 재발급 — 옛 코드는 그 자리에서 무효, 기존 멤버는 무영향
    if (path === "/invite" && req.method === "POST") {
      if (!(await this.isOwner(me))) return json({ error: "forbidden" }, 403);
      const invite = { code: rid(8), exp: now + INVITE_MS };
      await S.put("invite", invite);
      return json({ invite });
    }

    if (path === "/lobby" && req.method === "POST") {
      if (!(await this.isOwner(me))) return json({ error: "forbidden" }, 403);
      const cur = (await S.get("lobby")) || { open: false, cap: 8, since: 0 };
      let cap = cur.cap || 8;
      if (b.cap != null) {
        const c = Math.round(Number(b.cap));
        if (!(c >= 2 && c <= 16)) return json({ error: "bad cap" }, 400);
        cap = c;
      }
      const open = !!b.open;
      /* 로비를 열고 닫는 것은 "모으는 중"의 표시일 뿐입니다 — 멤버십은 건드리지 않습니다 (§1).
         멤버십이 끊기는 길은 본인 [나가기]와 방장 내보내기 둘뿐이고, 해산(전원 킥) 동사는
         없습니다 (§3.4). 로비 6시간 자동 닫힘도 폐기했습니다 — 로비는 영구입니다 (§1). */
      const lobby = { open, cap, since: open ? (cur.open && cur.since ? cur.since : now) : 0 };
      await S.put("lobby", lobby);
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

    /* [파티 끝내기] — 파티원 전부 해제. 파티원은 마지막으로 받은 판(정산 결과)을
       계속 보지만(§5.4), 그 뒤로는 아무것도 못 봅니다 */
    if (path === "/end" && req.method === "POST") {
      if (!(await this.isOwner(me))) return json({ error: "forbidden" }, 403);
      const cleared = await this.clearMembers();
      return json({ ok: true, cleared });
    }

    if (path === "/members" && req.method === "GET") {
      if (!(await this.isOwner(me))) return json({ error: "forbidden" }, 403);
      return json({ list: await this.members() });
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
        if (m.st !== "ok") {
          const lobby = (await S.get("lobby")) || { open: false, cap: 8, since: 0 };
          if (lobby.open) {
            const seated = (await this.members()).filter((x) => x.st === "ok").length + 1;
            if (seated >= lobby.cap) return json({ error: "full" }, 409);
          }
        }
        m.st = "ok";
        m.t = now;
        if (typeof b.rowId === "string" && b.rowId) m.rowId = b.rowId;
        await S.put("m:" + acct, m);
        /* 계정이 붙은 자리가 생겼습니다 — 이제부터 이 판은 자동 중단의 대상입니다 (§3.4) */
        await this.arm();
        /* 한 번 수락되면 함께한 사람 관계가 생겨 다음부터는 링크가 필요 없습니다 (§3.3) */
        await this.toAccounts("/mated", { a: me.id, b: acct });
        this.toAcct(acct, { kind: "you", you: youOf(m) });
        return json({ ok: true, member: { acct, ...youOf(m) } });
      }
      if (b.action === "remove") {
        await S.delete("m:" + acct);
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

    /* 들어오는 길 셋 (§3.3·§4.2 라운드 B).
       (a) 지목 초대 — 방장이 이미 고른 사람이라 방장 수락이 없습니다.
       (b) 코드 없음 — 노크. 방장의 함께한 사람만 문 앞에 설 수 있습니다.
       (c) 링크 — 소지자 표라 언제나 신청입니다. 초대 링크는 디코에도 방송 화면에도 새므로,
           낯선 사람이 자리를 먼저 차지한 뒤 빼내는 것보다 문 앞에서 기다리는 것이 맞습니다 */
    if (path === "/join" && req.method === "POST") {
      if (!me) return json({ error: "unauthorized" }, 401);
      const owner = await S.get("owner");
      if (!owner) return json({ error: "no room" }, 404);
      if (owner === me.id) return json({ ok: true, st: "ok", you: null });
      const cur = await S.get("m:" + me.id);
      if (cur) {
        if (cur.nick !== me.nick) {
          cur.nick = me.nick;
          await S.put("m:" + me.id, cur);
        }
        return json({ ok: true, st: cur.st, you: youOf(cur), already: true });
      }
      /* (a) 지목 초대 — 자리도 그때 정해져 있어서 그대로 앉히고, 서기에게 알려
         장부의 줄까지 잇게 합니다. 유효하지 않으면 여기서 끝입니다 (앱은 만료 문구를 띄웁니다) */
      if (b.inv) {
        const iv = await this.toAccounts("/inv-take", {
          to: me.id,
          from: owner,
          room: req.headers.get("x-room") || "",
        });
        if (!iv || !iv.ok) return json({ error: "invite" }, 403);
        const m = { nick: me.nick, rowId: iv.seat || null, st: "ok", t: now };
        await S.put("m:" + me.id, m);
        await this.arm();
        await this.toAccounts("/mated", { a: owner, b: me.id });
        this.toScribe({ kind: "join", acct: me.id, nick: me.nick, st: "ok", seat: iv.seat || null });
        return json({ ok: true, st: "ok", you: youOf(m), seat: iv.seat || null });
      }
      const code = String(b.j || "").toUpperCase();
      /* (b) 노크 — 문 앞에 서는 것이라 취소·거절 전까지 유지됩니다 (§3.3) */
      if (!code) {
        const r = await this.toAccounts("/mate-of", { a: owner, b: me.id });
        if (!r || !r.yes) return json({ error: "invite" }, 403);
        const m = { nick: me.nick, rowId: null, st: "req", t: now };
        await S.put("m:" + me.id, m);
        this.toScribe({ kind: "join", acct: me.id, nick: me.nick, st: "req", knock: 1 });
        return json({ ok: true, st: "req", you: youOf(m) });
      }
      // (c) 링크 신청
      const inv = await S.get("invite");
      if (!inv || code !== inv.code || inv.exp < now) return json({ error: "invite" }, 403);
      const st = "req";
      const m = { nick: me.nick, rowId: null, st, t: now };
      await S.put("m:" + me.id, m);
      this.toScribe({ kind: "join", acct: me.id, nick: me.nick, st });
      return json({ ok: true, st, you: youOf(m) });
    }

    /* [나가기]와 [신청 취소]가 같은 길입니다 — st:"req" 도 여기서 지워집니다 (§4.2 라운드 B).
       문 앞에 서 있던 사람이 물러나는 것이라, 방장 쪽 신청 칸에서도 그대로 사라집니다 */
    if (path === "/leave" && req.method === "POST") {
      if (!me) return json({ error: "unauthorized" }, 401);
      if (await S.get("m:" + me.id)) {
        await S.delete("m:" + me.id);
        await this.arm();
        this.toScribe({ kind: "left", acct: me.id });
        this.toAcct(me.id, { kind: "you", you: null });
      }
      return json({ ok: true });
    }

    /* 자수 — 서버는 적지 않고 서기에게 넘깁니다. 장부의 원본은 방장 앱입니다 */
    if (path === "/confess" && req.method === "POST") {
      if (!me) return json({ error: "unauthorized" }, 401);
      const m = await S.get("m:" + me.id);
      if (!m || m.st !== "ok") return json({ error: "forbidden" }, 403);
      const dir = Number(b.dir);
      const colId = String(b.colId == null ? "" : b.colId);
      if ((dir !== 1 && dir !== -1) || !colId || colId.length > 64)
        return json({ error: "bad request" }, 400);
      if (!m.rowId || b.rowId !== m.rowId) return json({ error: "not your row" }, 403);
      // 얼어 있는 판에는 아무것도 못 적습니다 — 방장이 이어가면 다시 눌립니다 (§3.4)
      if (await S.get("paused")) return json({ error: "paused" }, 409);
      let g = (await S.get("cg:" + me.id)) || { n: 0, until: 0 };
      if (g.until <= now) g = { n: 0, until: now + 60000 };
      g.n++;
      await S.put("cg:" + me.id, g);
      if (g.n > CONFESS_PER_MIN) return json({ error: "slow down" }, 429);
      if (!this.scribeOn()) return json({ error: "scribe-off" }, 409);
      this.toScribe({
        kind: "confess",
        acct: me.id,
        nick: m.nick,
        rowId: m.rowId,
        colId,
        dir,
        t: now,
      });
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
    if (!ok) {
      const inv = await S.get("invite");
      const j = String(url.searchParams.get("j") || "").toUpperCase();
      if (owner && inv && j && j === inv.code && inv.exp > Date.now()) ok = true;
    }
    if (!ok) return this.deny(client, server, me ? "member" : "invite");

    server.serializeAttachment({ k: "v", acct: me ? me.id : null });
    this.ctx.acceptWebSocket(server);
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

  webSocketMessage() {
    /* 구독자는 읽기 전용 — 어떤 메시지도 상태를 못 바꿉니다 */
  }
  webSocketClose(ws) {
    this.gone(ws);
  }
  webSocketError(ws) {
    this.gone(ws);
  }
  gone(ws) {
    const a = tagOf(ws);
    if (!a || a.k !== "scribe") return;
    if (!this.scribeOn(ws)) this.bcast({ kind: "presence", scribeOn: false }, (w) => w !== ws);
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
    // 판만 지웁니다 — 방·명단·방장은 남습니다
    if (stateAt && stateAt + STATE_IDLE_MS <= now) {
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
