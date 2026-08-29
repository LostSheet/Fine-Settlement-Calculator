/* 벌금 현황판 릴레이.
   장부 관리자의 로컬 앱이 상태를 밀어 올리면, OBS와 브라우저가 읽기 전용으로 구독합니다.
   방(Room)은 명단마다 하나이고, 주소는 장부 관리자가 재발급하기 전까지 영구입니다.
   서버는 저장소가 아니라 릴레이입니다 — 진본은 언제나 장부 관리자의 브라우저에 있습니다. */

import { PAGE_HTML, APP_URL } from "./page.js";

const ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789"; // 헷갈리는 글자(I,L,O,U,0,1) 제외
const rid = (n) =>
  Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => ALPHABET[b % ALPHABET.length]).join("");

const ID6 = "[ABCDEFGHJKMNPQRSTVWXYZ23456789]{6}";
const ID12 = "[ABCDEFGHJKMNPQRSTVWXYZ23456789]{12}";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,PUT,OPTIONS",
  "access-control-allow-headers": "content-type",
};
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...CORS },
  });

/* 상태 크기 상한 — 표에 더해 기록(최근 200건)까지 실립니다. 남용 방지용 */
const MAX_STATE_BYTES = 128 * 1024;
/* 90일 동안 갱신이 없으면 방을 통째로 지웁니다 (죽은 공대 청소).
   내용을 미리 지우지는 않습니다 — 링크가 살아 있는 한 이름이 보여야
   "이름이 보이면 정상"이라는 진단이 성립하니까요. */
const IDLE_WIPE_MS = 90 * 86400 * 1000;

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const p = url.pathname;
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });

    /* 방 만들기 — 주소와 쓰기 열쇠를 함께 발급합니다.
       6자 주소가 겹치면(희박) 몇 번 다시 뽑습니다. */
    if (p === "/api/rooms" && req.method === "POST") {
      for (let i = 0; i < 5; i++) {
        const roomId = rid(6);
        const key = rid(26);
        const stub = env.ROOM.get(env.ROOM.idFromName(roomId));
        const r = await stub.fetch("https://do/create", {
          method: "POST",
          body: JSON.stringify({ key }),
        });
        if (r.ok) return json({ roomId, key });
      }
      return json({ error: "could not allocate room" }, 503);
    }

    // 기기 이사·예비 열쇠 — 열쇠 꾸러미를 한 번 쓰는 6자리 코드로 옮깁니다
    // 복구 코드 — 같은 꾸러미를 오래 보관하는 12자리 코드. 재발급하면 옛 코드는 무효
    if (
      p === "/api/handoff" || new RegExp(`^/api/handoff/${ID6}$`).test(p) ||
      p === "/api/recovery" || p === "/api/recovery/revoke" ||
      new RegExp(`^/api/recovery/${ID12}$`).test(p)
    ) {
      const stub = env.HANDOFF.get(env.HANDOFF.idFromName("global"));
      return stub.fetch(req);
    }

    // 방 API — /api/r/:id/(state|live|kill|peek)
    const api = p.match(new RegExp(`^/api/r/(${ID6})/(state|live|kill|peek|read|archive)$`));
    if (api) {
      const stub = env.ROOM.get(env.ROOM.idFromName(api[1]));
      return stub.fetch(new Request("https://do/" + api[2], req));
    }

    // 공유 페이지 — OBS면 오버레이를 그리고, 브라우저면 앱의 읽기 전용 화면으로 넘깁니다
    const page = p.match(new RegExp(`^/r/(${ID6})$`));
    if (page) {
      return new Response(
        PAGE_HTML.replaceAll("__ROOM__", page[1]).replaceAll("__APP__", APP_URL),
        {
          headers: {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-cache",
          },
        }
      );
    }

    if (p === "/") {
      return new Response("벌금 현황판 릴레이입니다. 공유받은 /r/XXXXXX 주소로 접속하세요.", {
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
    return json({ error: "not found" }, 404);
  },
};

/* ---------------- 방 하나 = Durable Object 하나 ---------------- */

export class Room {
  constructor(ctx) {
    this.ctx = ctx;
    /* 구독자의 keepalive 는 DO를 깨우지 않고 런타임이 대신 답합니다 (하이버네이션 유지) */
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  async fetch(req) {
    const path = new URL(req.url).pathname;

    if (path === "/create") {
      if (await this.ctx.storage.get("key")) return json({ error: "exists" }, 409);
      const { key } = await req.json();
      if (typeof key !== "string" || key.length < 16) return json({ error: "bad key" }, 400);
      await this.ctx.storage.put("key", key);
      await this.ctx.storage.setAlarm(Date.now() + IDLE_WIPE_MS);
      return json({ ok: true });
    }

    // 장부 관리자의 앱이 미는 스냅샷. 열쇠가 맞아야만 씁니다
    if (path === "/state") {
      const body = await req.text();
      if (body.length > MAX_STATE_BYTES) return json({ error: "too big" }, 413);
      let key, state;
      try {
        ({ key, state } = JSON.parse(body));
      } catch (e) {
        return json({ error: "bad json" }, 400);
      }
      const real = await this.ctx.storage.get("key");
      if (!real || key !== real) return json({ error: "unauthorized" }, 403);
      if (await this.ctx.storage.get("dead")) return json({ error: "dead" }, 410);
      await this.ctx.storage.put("state", state);
      await this.ctx.storage.setAlarm(Date.now() + IDLE_WIPE_MS);
      const msg = JSON.stringify({ kind: "state", state });
      const socks = this.ctx.getWebSockets();
      for (const ws of socks) {
        try {
          ws.send(msg);
        } catch (e) {
          /* 끊긴 구독자는 무시 */
        }
      }
      return json({ ok: true, watchers: socks.length });
    }

    /* 열쇠를 가진 기기가 스냅샷을 통째로 읽습니다 — 복구·이어가기의 공통 기반.
       방이 만료돼 지워졌으면 열쇠 기록도 없으므로 410으로 구분해 줍니다. */
    if (path === "/read") {
      let key;
      try {
        ({ key } = await req.json());
      } catch (e) {
        return json({ error: "bad json" }, 400);
      }
      const real = await this.ctx.storage.get("key");
      if (!real) return json({ error: "gone" }, 410);
      if (key !== real) return json({ error: "unauthorized" }, 403);
      if (await this.ctx.storage.get("dead")) return json({ error: "dead" }, 410);
      const [state, prev] = await Promise.all([
        this.ctx.storage.get("state"),
        this.ctx.storage.get("prev"),
      ]);
      return json({ state: state ?? null, prev: prev ?? null });
    }

    /* 직전 회차 한 장 — 처음부터를 누를 때 앱이 밀어 둡니다. 최신 하나만 남습니다 */
    if (path === "/archive") {
      const body = await req.text();
      if (body.length > MAX_STATE_BYTES) return json({ error: "too big" }, 413);
      let key, state;
      try {
        ({ key, state } = JSON.parse(body));
      } catch (e) {
        return json({ error: "bad json" }, 400);
      }
      const real = await this.ctx.storage.get("key");
      if (!real || key !== real) return json({ error: "unauthorized" }, 403);
      await this.ctx.storage.put("prev", state);
      return json({ ok: true });
    }

    /* 주소 재발급의 뒷정리 — 옛 방을 닫습니다 (새 방 생성은 앱이 따로 합니다) */
    if (path === "/kill") {
      let key;
      try {
        ({ key } = await req.json());
      } catch (e) {
        return json({ error: "bad json" }, 400);
      }
      const real = await this.ctx.storage.get("key");
      if (!real || key !== real) return json({ error: "unauthorized" }, 403);
      await this.ctx.storage.put("dead", true);
      await this.ctx.storage.delete("state");
      const bye = JSON.stringify({ kind: "dead" });
      for (const ws of this.ctx.getWebSockets()) {
        try {
          ws.send(bye);
          ws.close(1000, "dead");
        } catch (e) {}
      }
      return json({ ok: true });
    }

    // 구독 — 읽기 전용 WebSocket. 접속 즉시 현재 상태 한 번, 이후 변경분
    if (path === "/live") {
      if (req.headers.get("Upgrade") !== "websocket") return json({ error: "upgrade required" }, 426);
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1]);
      const [dead, known, state] = await Promise.all([
        this.ctx.storage.get("dead"),
        this.ctx.storage.get("key"),
        this.ctx.storage.get("state"),
      ]);
      pair[1].send(
        JSON.stringify(dead || !known ? { kind: "dead" } : { kind: "state", state: state ?? null })
      );
      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    // 페이지 첫 렌더용 폴백
    if (path === "/peek") {
      const [dead, known, state] = await Promise.all([
        this.ctx.storage.get("dead"),
        this.ctx.storage.get("key"),
        this.ctx.storage.get("state"),
      ]);
      return json(dead || !known ? { dead: true } : { state: state ?? null });
    }

    return json({ error: "not found" }, 404);
  }

  webSocketMessage() {
    /* 구독자는 읽기 전용 — 어떤 메시지도 상태를 못 바꿉니다 */
  }
  webSocketClose() {}
  webSocketError() {}

  async alarm() {
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.close(1000, "expired");
      } catch (e) {}
    }
    await this.ctx.storage.deleteAll();
  }
}

/* -------- 기기 이사·예비 열쇠: 한 번 쓰는 6자리 코드 보관소 -------- */

const HANDOFF_TTL_MS = 5 * 60 * 1000;

export class Handoff {
  constructor(ctx) {
    this.ctx = ctx;
  }

  async fetch(req) {
    const url = new URL(req.url);

    // 코드 발급 — 열쇠 꾸러미를 5분간 맡아둡니다. 발급도 상한을 둡니다 (저장소 채우기 방지)
    if (url.pathname === "/api/handoff" && req.method === "POST") {
      const now = Date.now();
      let ig = (await this.ctx.storage.get("iguard")) || { n: 0, until: 0 };
      if (ig.until > now && ig.n >= 30) return json({ error: "slow down" }, 429);
      if (ig.until < now) ig = { n: 0, until: now + 10 * 60 * 1000 };
      ig.n++;
      await this.ctx.storage.put("iguard", ig);
      const body = await req.text();
      if (body.length > MAX_STATE_BYTES) return json({ error: "too big" }, 413);
      const code = rid(6);
      await this.ctx.storage.put("c:" + code, { body, exp: Date.now() + HANDOFF_TTL_MS });
      await this.ctx.storage.setAlarm(Date.now() + HANDOFF_TTL_MS + 60 * 1000);
      return json({ code, expiresIn: HANDOFF_TTL_MS / 1000 });
    }

    /* 복구 코드 발급 — 꾸러미를 기한 없이 맡아둡니다. 방 자체가 유휴 90일에
       만료되므로 코드만 영원해도 열 수 있는 건 살아 있는 방뿐입니다. */
    if (url.pathname === "/api/recovery" && req.method === "POST") {
      const now = Date.now();
      let ig = (await this.ctx.storage.get("riguard")) || { n: 0, until: 0 };
      if (ig.until > now && ig.n >= 30) return json({ error: "slow down" }, 429);
      if (ig.until < now) ig = { n: 0, until: now + 10 * 60 * 1000 };
      ig.n++;
      await this.ctx.storage.put("riguard", ig);
      const body = await req.text();
      if (body.length > MAX_STATE_BYTES) return json({ error: "too big" }, 413);
      const code = rid(12);
      await this.ctx.storage.put("r:" + code, { body });
      return json({ code });
    }

    // 복구 코드 무효화 — 재발급하거나 새어 나갔을 때 앱이 부릅니다
    if (url.pathname === "/api/recovery/revoke" && req.method === "POST") {
      let code;
      try {
        ({ code } = await req.json());
      } catch (e) {
        return json({ error: "bad json" }, 400);
      }
      if (typeof code === "string" && new RegExp(`^${ID12}$`).test(code))
        await this.ctx.storage.delete("r:" + code);
      return json({ ok: true });
    }

    // 복구 코드 수령 — 태우지 않습니다 (몇 번이고 같은 코드로 복구할 수 있게)
    const rtake = url.pathname.match(new RegExp(`^/api/recovery/(${ID12})$`));
    if (rtake && req.method === "GET") {
      const now = Date.now();
      let g = (await this.ctx.storage.get("rguard")) || { n: 0, until: 0 };
      if (g.until > now && g.n >= 30) return json({ error: "slow down" }, 429);
      const item = await this.ctx.storage.get("r:" + rtake[1]);
      if (!item) {
        if (g.until < now) g = { n: 0, until: now + 10 * 60 * 1000 };
        g.n++;
        await this.ctx.storage.put("rguard", g);
        return json({ error: "no such code" }, 404);
      }
      return new Response(item.body, {
        headers: { "content-type": "application/json; charset=utf-8", ...CORS },
      });
    }

    // 코드 수령 — 맞으면 꾸러미를 주고 즉시 태웁니다 (1회용)
    const take = url.pathname.match(new RegExp(`^/api/handoff/(${ID6})$`));
    if (take && req.method === "GET") {
      /* 무차별 대입 방지 — 10분 창에 실패 30번이면 잠급니다 */
      const now = Date.now();
      let guard = (await this.ctx.storage.get("guard")) || { n: 0, until: 0 };
      if (guard.until > now && guard.n >= 30) return json({ error: "slow down" }, 429);
      const item = await this.ctx.storage.get("c:" + take[1]);
      if (!item || item.exp < now) {
        if (guard.until < now) guard = { n: 0, until: now + 10 * 60 * 1000 };
        guard.n++;
        await this.ctx.storage.put("guard", guard);
        return json({ error: "no such code" }, 404);
      }
      await this.ctx.storage.delete("c:" + take[1]);
      return new Response(item.body, {
        headers: { "content-type": "application/json; charset=utf-8", ...CORS },
      });
    }

    return json({ error: "not found" }, 404);
  }

  // 만료된 코드 청소
  async alarm() {
    const now = Date.now();
    const all = await this.ctx.storage.list({ prefix: "c:" });
    for (const [k, v] of all) if (v.exp < now) await this.ctx.storage.delete(k);
  }
}

