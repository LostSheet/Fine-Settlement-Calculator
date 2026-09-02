/* 벌금 현황판 릴레이 v2 — 계정·로비.
   진본은 여전히 방장(서기) 브라우저의 localStorage 입니다. 서버는 릴레이 + 신원부입니다.
   주소(URL)는 읽기 권한까지만 나르고, 쓰기(장부 push·자수·수락)는 전부 로그인 세션입니다 —
   게임 화면에 찍히는 주소창에 실린 권한은 유출된 것으로 봅니다.
   Accounts DO 하나가 계정·세션·OBS 토큰을 갖고, 방 하나마다 Room DO 하나가 판과 명단을 갖습니다. */

import { PAGE_HTML, APP_URL } from "./page.js";

const ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789"; // 헷갈리는 글자(I,L,O,U,0,1) 제외
const CH = "[ABCDEFGHJKMNPQRSTVWXYZ23456789]";
const ID6 = CH + "{6}";
const TOK20 = CH + "{20}";
const rid = (n) =>
  Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => ALPHABET[b % ALPHABET.length]).join("");

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
const INVITE_MS = 30 * 60 * 1000;
const LOBBY_MS = 6 * 3600 * 1000;
const STATE_IDLE_MS = 90 * 86400 * 1000; // 판만 지웁니다 — 방·멤버십은 남습니다
const ACCT_IDLE_MS = 365 * 86400 * 1000;
const ACCT_SCAN_MS = 7 * 86400 * 1000;

/* 상태 크기 상한 — 표에 더해 기록(최근 200건)까지 실립니다. 남용 방지용 */
const MAX_STATE_BYTES = 128 * 1024;
const CONFESS_PER_MIN = 20;
const LOGIN_FAILS = 30;
const LOGIN_WINDOW_MS = 10 * 60 * 1000;

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

    /* 계정부 — Bearer 는 Accounts DO 가 직접 풉니다 (왕복 한 번으로 끝납니다) */
    if (p.startsWith("/api/auth/") || new RegExp(`^/api/o/${TOK20}/resolve$`).test(p))
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
      new RegExp(`^/api/r/(${ID6})/(state|read|invite|lobby|members|member|join|leave|confess)$`)
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
      return json({ id: u.id, nick: u.nick, obsToken: u.obsToken, cur: u.cur || null, seen: u.seen });
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

    // 방송용 주소가 가리키는 방 — 지금 들어가 있는 방입니다. 조회도 활동으로 칩니다
    const res = p.match(new RegExp(`^/api/o/(${TOK20})/resolve$`));
    if (res && req.method === "GET") {
      const id = await S.get("t:" + res[1]);
      const u = id ? await S.get("u:" + id) : null;
      if (!u || !u.cur) return json({ error: "not found" }, 404);
      u.seen = now;
      await S.put("u:" + id, u);
      return json({ roomId: u.cur });
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

  async freeToken() {
    for (let i = 0; i < 8; i++) {
      const t = rid(20);
      if (!(await this.ctx.storage.get("t:" + t))) return t;
    }
    return rid(20);
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
    const users = await S.list({ prefix: "u:" });
    const dead = [];
    for (const [k, u] of users) if (now - (u.seen || 0) >= ACCT_IDLE_MS) dead.push([k, u]);
    if (dead.length) {
      const sessions = await S.list({ prefix: "s:" });
      for (const [k, u] of dead) {
        const keys = [k];
        if (u.obsToken) keys.push("t:" + u.obsToken);
        if (u.room) keys.push("rm:" + u.room);
        keys.push("lg:" + u.id);
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
  constructor(ctx) {
    this.ctx = ctx;
    /* 구독자의 keepalive 는 DO를 깨우지 않고 런타임이 대신 답합니다 (하이버네이션 유지) */
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
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
      const [invite, lobby] = await Promise.all([S.get("invite"), S.get("lobby")]);
      return json({
        roomId,
        invite: invite || null,
        lobby: lobby || { open: false, cap: 8, since: 0 },
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
      /* 줄이 사라진 멤버는 같은 닉의 빈 줄로 다시 이어 줍니다 — '처음부터'나 프리셋으로
         판을 새로 짜면 rowId 가 통째로 바뀌는데, 같은 멤버끼리 다시 뛰는 재팟에서
         아무도 아무것도 안 해도 자수가 이어져야 해서요 (§3-9).
         로비가 열려 있는 동안은 건드리지 않습니다 — 그때 실린 rows2 는 아직 지금 판이라,
         대기실에 모인 사람을 지난 판의 줄에 붙여 버립니다. */
      const rows2 = state && Array.isArray(state.rows2) ? state.rows2 : null;
      const lob = await S.get("lobby");
      if (rows2 && !(lob && lob.open)) {
        const live = new Set(rows2.map((r) => r && r.rowId).filter(Boolean));
        const list = (await this.members()).filter((x) => x.st === "ok");
        const taken = new Set(list.map((x) => x.rowId).filter((id) => id && live.has(id)));
        for (const mem of list) {
          if (mem.rowId && live.has(mem.rowId)) continue;
          const hit = rows2.find((r) => r && r.rowId && r.n === mem.nick && !taken.has(r.rowId));
          const v = hit ? hit.rowId : null;
          if ((mem.rowId || null) === v) continue;
          const rec = await S.get("m:" + mem.acct);
          if (!rec) continue;
          rec.rowId = v;
          await S.put("m:" + mem.acct, rec);
          if (v) taken.add(v);
          moved.push([mem.acct, rec]);
        }
      }
      await S.put({ state, stateAt: now });
      await this.arm();
      const on = this.scribeOn();
      this.toViewers({ kind: "state", state, scribeOn: on });
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
      // 열려 있던 로비를 다시 열어도 6시간 시계는 처음 열린 때부터입니다
      const lobby = { open, cap, since: open ? (cur.open && cur.since ? cur.since : now) : 0 };
      await S.put("lobby", lobby);
      await this.arm();
      this.bcast({ kind: "lobby", lobby });
      return json({ lobby });
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
        m.st = "ok";
        m.t = now;
        await S.put("m:" + acct, m);
        this.toAcct(acct, { kind: "you", you: youOf(m) });
        return json({ ok: true, member: { acct, ...youOf(m) } });
      }
      if (b.action === "remove") {
        await S.delete("m:" + acct);
        this.toAcct(acct, { kind: "you", you: null });
        return json({ ok: true });
      }
      return json({ error: "bad action" }, 400);
    }

    // 초대로 들어오기 — 로비가 열려 있으면 수락 없이 바로 자리에 앉습니다
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
      const inv = await S.get("invite");
      const code = String(b.j || "").toUpperCase();
      if (!inv || !code || code !== inv.code || inv.exp < now) return json({ error: "invite" }, 403);
      const lobby = (await S.get("lobby")) || { open: false, cap: 8, since: 0 };
      let st = "req";
      if (lobby.open) {
        // 방장이 대기실 첫 자리를 차지합니다 (§3-2) — 정원에 같이 셉니다
        const seated = (await this.members()).filter((x) => x.st === "ok").length + 1;
        if (seated >= lobby.cap) return json({ error: "full" }, 409);
        st = "ok";
      }
      const m = { nick: me.nick, rowId: null, st, t: now };
      await S.put("m:" + me.id, m);
      this.toScribe({ kind: "join", acct: me.id, nick: me.nick, st });
      return json({ ok: true, st, you: youOf(m) });
    }

    if (path === "/leave" && req.method === "POST") {
      if (!me) return json({ error: "unauthorized" }, 401);
      if (await S.get("m:" + me.id)) {
        await S.delete("m:" + me.id);
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
    this.send(server, { kind: "hello", you, scribeOn: on });
    this.send(server, { kind: "state", state: (await S.get("state")) || null, scribeOn: on });
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

  /* 알람 하나로 다음 만료 시각을 관리합니다 — 로비 6시간과 판 90일이 같이 삽니다 */
  async arm() {
    const S = this.ctx.storage;
    const [lobby, stateAt] = await Promise.all([S.get("lobby"), S.get("stateAt")]);
    let at = 0;
    if (lobby && lobby.open && lobby.since) at = lobby.since + LOBBY_MS;
    if (stateAt) {
      const t = stateAt + STATE_IDLE_MS;
      if (!at || t < at) at = t;
    }
    if (at) await S.setAlarm(Math.max(at, Date.now() + 1000));
    else await S.deleteAlarm();
  }

  async alarm() {
    const now = Date.now();
    const S = this.ctx.storage;
    const lobby = await S.get("lobby");
    if (lobby && lobby.open && lobby.since + LOBBY_MS <= now) {
      const next = { open: false, cap: lobby.cap, since: 0 };
      await S.put("lobby", next);
      this.bcast({ kind: "lobby", lobby: next });
    }
    const stateAt = await S.get("stateAt");
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
