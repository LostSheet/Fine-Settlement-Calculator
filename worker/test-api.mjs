/* 워커 API 자동 검증 (OBS-SPEC §6.2·§6.3).
   쓰는 법: 다른 창에서 `npx wrangler dev --port 8787` 을 띄워 두고 `node test-api.mjs`.
   항목마다 PASS/FAIL 을 찍고, 하나라도 실패하면 종료 코드 1 입니다.
   전역 fetch·WebSocket 만 씁니다 (node 22+). */

const BASE = process.env.BASE || "http://127.0.0.1:8787";
const WSBASE = BASE.replace(/^http/, "ws");

/* ---------------- 뼈대 ---------------- */

let passN = 0;
let failN = 0;
const expect = (cond, msg) => {
  if (!cond) throw new Error(msg || "expected");
};
const eq = (got, want, what) =>
  expect(got === want, (what || "value") + ": " + JSON.stringify(got) + " ≠ " + JSON.stringify(want));

const step = async (name, fn) => {
  try {
    await fn();
    passN++;
    console.log("PASS  " + name);
  } catch (e) {
    failN++;
    console.log("FAIL  " + name + "  → " + (e && e.message ? e.message : e));
  }
};
const head = (t) => console.log("\n— " + t + " —");

const api = async (method, path, opt = {}) => {
  const headers = {};
  if (opt.token) headers.authorization = "Bearer " + opt.token;
  if (opt.body !== undefined) headers["content-type"] = "application/json";
  const r = await fetch(BASE + path, {
    method,
    headers,
    body: opt.body === undefined ? undefined : JSON.stringify(opt.body),
  });
  const text = await r.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch (e) {
      data = text;
    }
  }
  return { status: r.status, ok: r.ok, data };
};

/* 앱이 하는 선해시 그대로 — 서버에는 64자 hex 만 갑니다 */
const prehash = async (id, pw) => {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(pw),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: new TextEncoder().encode("gold-settlement/v1|" + id.toLowerCase()),
      iterations: 310000,
      hash: "SHA-256",
    },
    key,
    256
  );
  return Array.from(new Uint8Array(bits), (b) => b.toString(16).padStart(2, "0")).join("");
};

/* 소켓 하나 — 받은 메시지를 모아 두고, 기다리면 꺼내 줍니다 (한 번 꺼낸 건 사라집니다) */
const open = (path) =>
  new Promise((res, rej) => {
    const ws = new WebSocket(WSBASE + path);
    const box = { ws, msgs: [], waiters: [], closed: false, code: 0 };
    box.want = (pred, ms) =>
      new Promise((ok2, no) => {
        const i = box.msgs.findIndex(pred);
        if (i >= 0) return ok2(box.msgs.splice(i, 1)[0]);
        const w = {
          pred,
          ok: ok2,
          timer: setTimeout(() => {
            box.waiters = box.waiters.filter((x) => x !== w);
            no(new Error("메시지를 못 받음 (" + (ms || 4000) + "ms): " + JSON.stringify(box.msgs)));
          }, ms || 4000),
        };
        box.waiters.push(w);
      });
    box.close = () =>
      new Promise((done) => {
        if (box.closed) return done();
        ws.addEventListener("close", () => done(), { once: true });
        try {
          ws.close();
        } catch (e) {
          done();
        }
      });
    ws.addEventListener("message", (e) => {
      if (e.data === "pong") return;
      let m;
      try {
        m = JSON.parse(e.data);
      } catch (err) {
        return;
      }
      const w = box.waiters.find((x) => x.pred(m));
      if (w) {
        clearTimeout(w.timer);
        box.waiters = box.waiters.filter((x) => x !== w);
        w.ok(m);
      } else box.msgs.push(m);
    });
    ws.addEventListener("close", (e) => {
      box.closed = true;
      box.code = e.code;
    });
    ws.addEventListener("error", () => {});
    ws.addEventListener("open", () => res(box));
    setTimeout(() => rej(new Error("WS 접속 시간 초과: " + path)), 8000);
  });

/* 서버가 닫기 프레임을 보냈는지 — 받은 순간 readyState 가 CLOSING(2) 이 됩니다.
   여기까지가 서버 몫이고, 브라우저는 이걸 받은 즉시 그 판을 못 믿을 것으로 압니다 */
const waitClosing = (box, ms = 3000) =>
  new Promise((ok, no) => {
    const t0 = Date.now();
    const tick = () => {
      if (box.closed || box.ws.readyState >= 2) return ok(Date.now() - t0);
      if (Date.now() - t0 > ms) return no(new Error("서버가 " + ms + "ms 안에 안 닫음"));
      setTimeout(tick, 25);
    };
    tick();
  });

/* 손잡이가 실제로 놓일 때까지 — 로컬 wrangler 는 닫기 악수를 마치는 데 10초쯤 걸립니다
   (워커가 늦게 닫는 게 아니라 로컬 런타임이 TCP 를 늦게 놓습니다) */
const waitClosed = (box, ms = 4000) =>
  new Promise((ok, no) => {
    if (box.closed) return ok(true);
    const t = setTimeout(() => no(new Error("소켓이 " + ms + "ms 안에 안 닫힘")), ms);
    box.ws.addEventListener(
      "close",
      () => {
        clearTimeout(t);
        ok(true);
      },
      { once: true }
    );
  });

/* ---------------- 시나리오 ---------------- */

const S = Date.now().toString(36).slice(-6); // 다시 돌려도 안 겹치게
const acct = (p) => p + S;
const PW = "wolf-moon-8412";

const A = { id: acct("host"), nick: "냥슬" }; // 방장
const B = { id: acct("mate"), nick: "꿀멩" }; // 파티원
const C = { id: acct("more"), nick: "두부" }; // 정원 시험용
const D = { id: acct("late"), nick: "포셔" }; // 출발 후 합류
const R = { id: acct("rate"), nick: "리밋" }; // 로그인 리밋 시험용

const reg = async (u) => {
  const pw = await prehash(u.id, PW);
  const r = await api("POST", "/api/auth/register", { body: { id: u.id, pw, nick: u.nick } });
  expect(r.status === 200, "register " + u.id + " → " + r.status + " " + JSON.stringify(r.data));
  u.pw = pw;
  u.token = r.data.token;
  u.obsToken = r.data.obsToken;
  return r;
};

const main = async () => {
  let room = null;
  let invite = null;
  let vB = null;
  let vJ = null;
  let vD = null;
  let scribe = null;

  /* ---- 가입 ---- */
  head("가입");
  await step("가입: 닉네임 4자 → 400", async () => {
    const r = await api("POST", "/api/auth/register", {
      body: { id: acct("badn"), pw: "a".repeat(64), nick: "네글자닉" },
    });
    eq(r.status, 400, "status");
  });
  await step("가입: id 3자 → 400", async () => {
    const r = await api("POST", "/api/auth/register", {
      body: { id: "ab", pw: "a".repeat(64), nick: "두자" },
    });
    eq(r.status, 400, "status");
  });
  await step("가입: 선해시 아닌 pw → 400", async () => {
    const r = await api("POST", "/api/auth/register", {
      body: { id: acct("badp"), pw: "hunter2", nick: "두자" },
    });
    eq(r.status, 400, "status");
  });
  await step("가입: 정상 → 세션·OBS 토큰 발급", async () => {
    const r = await reg(A);
    eq(r.data.id, A.id, "id");
    eq(r.data.nick, A.nick, "nick");
    expect(/^[ABCDEFGHJKMNPQRSTVWXYZ23456789]{32}$/.test(r.data.token), "세션 토큰 32자: " + r.data.token);
    expect(/^[ABCDEFGHJKMNPQRSTVWXYZ23456789]{20}$/.test(r.data.obsToken), "OBS 토큰 20자: " + r.data.obsToken);
  });
  await step("가입: 같은 id 중복 → 409", async () => {
    const r = await api("POST", "/api/auth/register", {
      body: { id: A.id, pw: A.pw, nick: "다른" },
    });
    eq(r.status, 409, "status");
  });

  /* ---- 로그인 ---- */
  head("로그인");
  await step("로그인: 오답 → 401", async () => {
    const r = await api("POST", "/api/auth/login", { body: { id: A.id, pw: "f".repeat(64) } });
    eq(r.status, 401, "status");
  });
  await step("로그인: 정상 → 새 세션", async () => {
    const r = await api("POST", "/api/auth/login", { body: { id: A.id, pw: A.pw } });
    eq(r.status, 200, "status");
    eq(r.data.obsToken, A.obsToken, "obsToken 유지");
    expect(r.data.token && r.data.token !== A.token, "새 토큰이 나와야 함");
  });
  await step("로그아웃: 그 세션은 즉시 무효", async () => {
    const r = await api("POST", "/api/auth/login", { body: { id: A.id, pw: A.pw } });
    const t = r.data.token;
    eq((await api("GET", "/api/auth/me", { token: t })).status, 200, "로그아웃 전 me");
    await api("POST", "/api/auth/logout", { body: { token: t } });
    eq((await api("GET", "/api/auth/me", { token: t })).status, 401, "로그아웃 후 me");
  });
  await step("로그인 리밋: 10분 창 30회 실패 → 31번째 429", async () => {
    await reg(R);
    for (let i = 1; i <= 30; i++) {
      const r = await api("POST", "/api/auth/login", { body: { id: R.id, pw: "f".repeat(64) } });
      eq(r.status, 401, i + "번째 실패");
    }
    const r = await api("POST", "/api/auth/login", { body: { id: R.id, pw: "f".repeat(64) } });
    eq(r.status, 429, "31번째");
    const other = await api("POST", "/api/auth/login", { body: { id: A.id, pw: A.pw } });
    eq(other.status, 200, "다른 계정은 안 잠김");
  });

  /* ---- me ---- */
  head("me");
  await step("me: Bearer 로 계정 조회", async () => {
    const r = await api("GET", "/api/auth/me", { token: A.token });
    eq(r.status, 200, "status");
    eq(r.data.id, A.id, "id");
    eq(r.data.obsToken, A.obsToken, "obsToken");
    eq(r.data.cur, null, "아직 들어간 방 없음");
  });
  await step("me: 토큰 없으면 401", async () => {
    eq((await api("GET", "/api/auth/me")).status, 401, "status");
  });

  /* ---- 내 방 ---- */
  head("내 방·초대·로비");
  await step("my/room: 계정당 방 하나, 두 번 불러도 같은 방", async () => {
    const r = await api("POST", "/api/my/room", { token: A.token });
    eq(r.status, 200, "status");
    expect(/^[ABCDEFGHJKMNPQRSTVWXYZ23456789]{6}$/.test(r.data.roomId), "방 주소 6자: " + r.data.roomId);
    eq(r.data.lobby.open, false, "로비 기본 닫힘");
    eq(r.data.lobby.cap, 8, "정원 기본 8");
    room = r.data.roomId;
    const again = await api("POST", "/api/my/room", { token: A.token });
    eq(again.data.roomId, room, "두 번째 호출");
  });
  await step("my/room: 로그인 없으면 401", async () => {
    eq((await api("POST", "/api/my/room")).status, 401, "status");
  });
  await step("invite: 10분짜리 8자 코드", async () => {
    const r = await api("POST", "/api/r/" + room + "/invite", { token: A.token });
    eq(r.status, 200, "status");
    expect(/^[ABCDEFGHJKMNPQRSTVWXYZ23456789]{8}$/.test(r.data.invite.code), "코드 8자: " + r.data.invite.code);
    const left = r.data.invite.exp - Date.now();
    expect(Math.abs(left - 10 * 60 * 1000) < 60000, "만료가 10분이 아님: " + left);
    invite = r.data.invite.code;
  });
  await step("invite: 방장 아니면 403", async () => {
    await reg(B);
    eq((await api("POST", "/api/r/" + room + "/invite", { token: B.token })).status, 403, "status");
  });
  await step("lobby: 열기(정원 2) → since 기록", async () => {
    const r = await api("POST", "/api/r/" + room + "/lobby", {
      token: A.token,
      body: { open: true, cap: 2 },
    });
    eq(r.status, 200, "status");
    eq(r.data.lobby.open, true, "open");
    eq(r.data.lobby.cap, 2, "cap");
    expect(r.data.lobby.since > 0, "since 가 비었음");
  });
  await step("lobby: 정원 범위(1~16) 밖 → 400", async () => {
    eq(
      (await api("POST", "/api/r/" + room + "/lobby", { token: A.token, body: { open: true, cap: 17 } }))
        .status,
      400,
      "17"
    );
    eq(
      (await api("POST", "/api/r/" + room + "/lobby", { token: A.token, body: { open: true, cap: 0 } }))
        .status,
      400,
      "0"
    );
  });

  /* ---- 참여 ---- */
  head("참여(join)");
  await step("join: 초대 코드 없이 → 403", async () => {
    const r = await api("POST", "/api/r/" + room + "/join", { token: B.token, body: {} });
    eq(r.status, 403, "status");
    eq(r.data.error, "invite", "error");
  });
  await step("join: 재발급으로 죽은(만료된) 코드 → 403", async () => {
    const old = invite;
    const r2 = await api("POST", "/api/r/" + room + "/invite", { token: A.token });
    invite = r2.data.invite.code;
    expect(invite !== old, "새 코드가 같음");
    const r = await api("POST", "/api/r/" + room + "/join", { token: B.token, body: { j: old } });
    eq(r.status, 403, "status");
  });
  /* 링크는 초대장입니다 (§3.3, 2026-09-05) — 유효한 코드면 바로 앉고, 방장 수락이 없습니다 */
  await step("join: 유효한 링크면 바로 앉음(st ok)", async () => {
    const r = await api("POST", "/api/r/" + room + "/join", { token: B.token, body: { j: invite } });
    eq(r.status, 200, "status");
    eq(r.data.st, "ok", "st");
    eq(r.data.you.nick, B.nick, "you.nick");
    eq(r.data.you.rowId, null, "아직 줄 없음");
  });
  await step("member approve: 수락하면 자리에 앉음(st ok)", async () => {
    const r = await api("POST", "/api/r/" + room + "/member", {
      token: A.token,
      body: { acct: B.id, action: "approve" },
    });
    eq(r.status, 200, "status");
    eq(r.data.member.st, "ok", "st");
  });
  await step("join: 정원이 차 있으면 신청으로 내려앉고, 수락에서도 409", async () => {
    await reg(C);
    const j = await api("POST", "/api/r/" + room + "/join", { token: C.token, body: { j: invite } });
    eq(j.status, 200, "신청 자체는 됨");
    eq(j.data.st, "req", "st");
    eq(j.data.full, true, "full");
    const r = await api("POST", "/api/r/" + room + "/member", {
      token: A.token,
      body: { acct: C.id, action: "approve" },
    });
    eq(r.status, 409, "status");
    eq(r.data.error, "full", "error");
  });
  await step("join: 정원을 늘리면 수락됨", async () => {
    await api("POST", "/api/r/" + room + "/lobby", { token: A.token, body: { open: true, cap: 8 } });
    const r = await api("POST", "/api/r/" + room + "/member", {
      token: A.token,
      body: { acct: C.id, action: "approve" },
    });
    eq(r.status, 200, "status");
    eq(r.data.member.st, "ok", "st");
  });
  await step("join: 이미 멤버면 현 상태를 그대로 돌려줌", async () => {
    const r = await api("POST", "/api/r/" + room + "/join", { token: B.token, body: { j: "ZZZZZZZZ" } });
    eq(r.status, 200, "status");
    eq(r.data.st, "ok", "st");
    eq(r.data.already, true, "already");
  });

  await step("join: 밖에서 보낸 x-acct 헤더는 안 먹힘 (401)", async () => {
    const r = await fetch(BASE + "/api/r/" + room + "/join", {
      method: "POST",
      headers: { "content-type": "application/json", "x-acct": A.id, "x-nick": "abc" },
      body: JSON.stringify({ j: invite }),
    });
    eq(r.status, 401, "status");
  });

  /* ---- 뷰어 WS ---- */
  head("뷰어 구독(WS)");
  await step("WS ?s=: hello 에 you(멤버) + scribeOn", async () => {
    vB = await open("/api/r/" + room + "/live?s=" + B.token);
    const hello = await vB.want((m) => m.kind === "hello");
    eq(hello.you.nick, B.nick, "you.nick");
    eq(hello.you.st, "ok", "you.st");
    eq(hello.you.rowId, null, "you.rowId");
    eq(hello.scribeOn, false, "scribeOn");
    const st = await vB.want((m) => m.kind === "state");
    eq(st.state, null, "아직 판 없음");
  });
  await step("WS ?j=: 초대만 있으면 you 는 null (읽기 전용)", async () => {
    vJ = await open("/api/r/" + room + "/live?j=" + invite);
    const hello = await vJ.want((m) => m.kind === "hello");
    eq(hello.you, null, "you");
    eq((await vJ.want((m) => m.kind === "state")).state, null, "접속 직후 판");
  });
  await step("WS: 코드도 세션도 없으면 denied(invite) 후 닫힘", async () => {
    const bad = await open("/api/r/" + room + "/live?j=ZZZZZZZZ");
    const m = await bad.want((x) => x.kind === "denied");
    eq(m.why, "invite", "why");
    await bad.close();
    expect(bad.closed, "소켓이 안 닫힘");
  });

  /* ---- 출발(state) ---- */
  head("출발 — state 푸시와 줄 연결");
  await step("state PUT + bindings: 판 브로드캐스트 + 당사자에게 you", async () => {
    const state = {
      board: [
        { n: A.nick, g: 0 },
        { n: B.nick, g: 10000 },
        { n: C.nick, g: 0 },
      ],
      cols: [{ t: "지각", r: 0 }],
      rows2: [
        { rowId: "r1", n: B.nick },
        { rowId: "r2", n: C.nick },
      ],
      full: { log: [] },
    };
    const r = await api("PUT", "/api/r/" + room + "/state", {
      token: A.token,
      body: { state, bindings: { [B.id]: "r1", [C.id]: "r2" } },
    });
    eq(r.status, 200, "status");
    const st = await vB.want((m) => m.kind === "state");
    eq(st.state.cols[0].t, "지각", "판 내용");
    eq(st.scribeOn, false, "scribeOn 동봉");
    const you = await vB.want((m) => m.kind === "you");
    eq(you.you.rowId, "r1", "내 줄");
    const jst = await vJ.want((m) => m.kind === "state");
    expect(!!jst.state, "초대 뷰어도 판을 받아야 함");
  });
  await step("state PUT: 방장 아니면 403", async () => {
    eq(
      (await api("PUT", "/api/r/" + room + "/state", { token: B.token, body: { state: {} } })).status,
      403,
      "status"
    );
  });
  await step("state PUT: 128KB 넘으면 413", async () => {
    const r = await api("PUT", "/api/r/" + room + "/state", {
      token: A.token,
      body: { state: { pad: "x".repeat(140000) } },
    });
    eq(r.status, 413, "status");
  });
  await step("read: 방장이 판을 통째로 다시 받음", async () => {
    const r = await api("GET", "/api/r/" + room + "/read", { token: A.token });
    eq(r.status, 200, "status");
    eq(r.data.state.cols[0].t, "지각", "판 내용");
    eq((await api("GET", "/api/r/" + room + "/read", { token: B.token })).status, 403, "남이 읽으면 403");
  });

  /* ---- 자수: 서기가 없을 때 ---- */
  head("자수 — 방장 앱이 꺼져 있을 때");
  await step("confess: 서기 소켓이 없으면 409 scribe-off", async () => {
    const r = await api("POST", "/api/r/" + room + "/confess", {
      token: B.token,
      body: { rowId: "r1", colId: "c1", dir: 1 },
    });
    eq(r.status, 409, "status");
    eq(r.data.error, "scribe-off", "error");
  });

  /* ---- 로비 닫기 ---- */
  head("로비 닫기");
  await step("lobby 닫기 → 구독자에게 브로드캐스트", async () => {
    const r = await api("POST", "/api/r/" + room + "/lobby", { token: A.token, body: { open: false } });
    eq(r.status, 200, "status");
    eq(r.data.lobby.open, false, "open");
    const m = await vB.want((x) => x.kind === "lobby");
    eq(m.lobby.open, false, "브로드캐스트 내용");
  });

  /* ---- 서기 WS ---- */
  head("서기 채널(WS)");
  await step("scribe: 방장 세션으로 붙으면 members 목록", async () => {
    scribe = await open("/api/r/" + room + "/scribe?s=" + A.token);
    const m = await scribe.want((x) => x.kind === "members");
    expect(Array.isArray(m.list), "list 가 배열이 아님");
    eq(m.list.length, 2, "멤버 수");
    const mine = m.list.find((x) => x.acct === B.id);
    eq(mine.rowId, "r1", "B 의 줄");
  });
  await step("presence: 서기 0→1 전환을 구독자에게 알림", async () => {
    const m = await vB.want((x) => x.kind === "presence");
    eq(m.scribeOn, true, "scribeOn");
  });
  await step("scribe: 방장 아니면 denied", async () => {
    const bad = await open("/api/r/" + room + "/scribe?s=" + B.token);
    const m = await bad.want((x) => x.kind === "denied");
    eq(m.why, "member", "why");
    await bad.close();
  });

  /* ---- 출발 후 합류 ---- */
  head("출발 후 합류 — 신청과 수락");
  await step("join: 출발 후(로비 닫힘) 링크 합류는 정원 없이 바로 앉음(st ok)", async () => {
    await reg(D);
    const r = await api("POST", "/api/r/" + room + "/join", { token: D.token, body: { j: invite } });
    eq(r.status, 200, "status");
    eq(r.data.st, "ok", "st");
    eq(r.data.you.rowId, null, "줄은 본인이 고른다 (§3.2)");
    const m = await scribe.want((x) => x.kind === "join");
    eq(m.acct, D.id, "acct");
    eq(m.nick, D.nick, "nick");
    eq(m.st, "ok", "st");
    eq(m.link, 1, "link");
  });
  await step("members: 합류자가 목록에 st ok 로 보임", async () => {
    const r = await api("GET", "/api/r/" + room + "/members", { token: A.token });
    eq(r.status, 200, "status");
    const d = r.data.list.find((x) => x.acct === D.id);
    eq(d.st, "ok", "st");
    eq(d.nick, D.nick, "nick");
  });
  await step("member approve: 당사자 소켓에 you 통지", async () => {
    vD = await open("/api/r/" + room + "/live?s=" + D.token);
    await vD.want((m) => m.kind === "hello");
    const r = await api("POST", "/api/r/" + room + "/member", {
      token: A.token,
      body: { acct: D.id, action: "approve" },
    });
    eq(r.status, 200, "status");
    const m = await vD.want((x) => x.kind === "you");
    eq(m.you.st, "ok", "you.st");
  });
  /* ---- 판 도중 자리 고르기 (§3.2·§4.2 /seat) ----
     방장은 자리 없이 수락만 하고, 어느 줄이 자기인지는 들어온 본인이 고릅니다.
     계정 붙은 줄(a:1)은 못 고르고, 한 번 고르면 잠깁니다 */
  head("판 도중 자리 고르기 — 본인이 고르고, 고르면 잠긴다");
  await step("seat 준비: 빈 줄(a:0)과 잠긴 줄(a:1)이 있는 판", async () => {
    const state = {
      board: [
        { n: A.nick, g: 0 },
        { n: B.nick, g: 10000 },
        { n: C.nick, g: 0 },
        { n: "(모험가4)", g: 5000 },
      ],
      cols: [{ t: "지각", r: 0 }],
      rows2: [
        { rowId: "r0", n: A.nick, a: 1 },
        { rowId: "r1", n: B.nick, a: 1 },
        { rowId: "r2", n: C.nick, a: 1 },
        { rowId: "r3", n: "(모험가4)", a: 0 },
      ],
      full: { log: [] },
    };
    eq(
      (await api("PUT", "/api/r/" + room + "/state", { token: A.token, body: { state } })).status,
      200,
      "status"
    );
  });
  await step("seat: 계정 붙은 줄(a:1) → 409 taken", async () => {
    const r = await api("POST", "/api/r/" + room + "/seat", { token: D.token, body: { rowId: "r0" } });
    eq(r.status, 409, "status");
    eq(r.data.error, "taken", "error");
  });
  await step("seat: 판에 없는 줄 → 400", async () => {
    const r = await api("POST", "/api/r/" + room + "/seat", { token: D.token, body: { rowId: "zzz" } });
    eq(r.status, 400, "status");
    eq(r.data.error, "bad row", "error");
  });
  await step("seat: 빈 줄을 고르면 앉고, 서기에 seat 통지", async () => {
    const r = await api("POST", "/api/r/" + room + "/seat", { token: D.token, body: { rowId: "r3" } });
    eq(r.status, 200, "status");
    eq(r.data.you.rowId, "r3", "you.rowId");
    const m = await scribe.want((x) => x.kind === "seat");
    eq(m.acct, D.id, "acct");
    eq(m.rowId, "r3", "rowId");
  });
  await step("seat: 한 번 고르면 잠김 — 다시 고르면 409 seated", async () => {
    const r = await api("POST", "/api/r/" + room + "/seat", { token: D.token, body: { rowId: "r2" } });
    eq(r.status, 409, "status");
    eq(r.data.error, "seated", "error");
  });
  await step("seat: 로그인 없으면 401", async () => {
    eq(
      (await api("POST", "/api/r/" + room + "/seat", { body: { rowId: "r3" } })).status,
      401,
      "status"
    );
  });

  await step("member remove: 당사자 소켓에 you=null", async () => {
    const r = await api("POST", "/api/r/" + room + "/member", {
      token: A.token,
      body: { acct: D.id, action: "remove" },
    });
    eq(r.status, 200, "status");
    const m = await vD.want((x) => x.kind === "you");
    eq(m.you, null, "you");
    const list = (await api("GET", "/api/r/" + room + "/members", { token: A.token })).data.list;
    expect(!list.find((x) => x.acct === D.id), "명단에 아직 남아 있음");
    await vD.close();
  });
  /* A8 — 통지만 하고 소켓을 열어 두면, 브라우저가 끊김을 알아챌 때까지 2~3초 동안
     못 보는 판이 화면에 남습니다 (§4.2) */
  await step("member remove: 통지 뒤 그 계정의 뷰어 소켓을 닫음", async () => {
    const j = await api("POST", "/api/r/" + room + "/join", { token: D.token, body: { j: invite } });
    eq(j.status, 200, "다시 신청");
    /* 내보냈던 사람은 같은 링크로 와도 즉시 착석이 아니라 방장 승인입니다 (§3.3, 2026-09-05 표준화) */
    eq(j.data.st, "req", "내보냈던 사람은 승인 대기");
    eq(!!j.data.kicked, true, "kicked 표시");
    eq(!!j.data.you.kicked, true, "you.kicked");
    await scribe.want((x) => x.kind === "join");
    await api("POST", "/api/r/" + room + "/member", {
      token: A.token,
      body: { acct: D.id, action: "approve" },
    });
    const v = await open("/api/r/" + room + "/live?s=" + D.token);
    await v.want((m) => m.kind === "hello");
    const r = await api("POST", "/api/r/" + room + "/member", {
      token: A.token,
      body: { acct: D.id, action: "remove" },
    });
    eq(r.status, 200, "status");
    const m = await v.want((x) => x.kind === "you");
    eq(m.you, null, "you 통지가 먼저");
    const ms = await waitClosing(v, 3000); // 서버가 닫기 프레임을 보낸 시각
    expect(ms < 3000, "닫기까지 " + ms + "ms");
    await waitClosed(v, 20000); // 손잡이가 실제로 놓일 때까지
    expect(v.closed, "소켓이 안 닫힘");
  });

  /* ---- 자수 ---- */
  head("자수 — 서기로 전달");
  await step("confess: 내 줄이면 서기에게 그대로 전달", async () => {
    const r = await api("POST", "/api/r/" + room + "/confess", {
      token: B.token,
      body: { rowId: "r1", colId: "c1", dir: 1 },
    });
    eq(r.status, 200, "status");
    const m = await scribe.want((x) => x.kind === "confess");
    eq(m.acct, B.id, "acct");
    eq(m.nick, B.nick, "nick");
    eq(m.rowId, "r1", "rowId");
    eq(m.colId, "c1", "colId");
    eq(m.dir, 1, "dir");
    expect(typeof m.t === "number", "t 가 없음");
  });
  await step("confess: 우클릭(dir -1)도 전달", async () => {
    await api("POST", "/api/r/" + room + "/confess", {
      token: B.token,
      body: { rowId: "r1", colId: "c1", dir: -1 },
    });
    const m = await scribe.want((x) => x.kind === "confess");
    eq(m.dir, -1, "dir");
  });
  await step("confess: 남의 줄이면 403", async () => {
    const r = await api("POST", "/api/r/" + room + "/confess", {
      token: B.token,
      body: { rowId: "r2", colId: "c1", dir: 1 },
    });
    eq(r.status, 403, "status");
  });
  await step("confess: dir 이 ±1 이 아니면 400", async () => {
    const r = await api("POST", "/api/r/" + room + "/confess", {
      token: B.token,
      body: { rowId: "r1", colId: "c1", dir: 5 },
    });
    eq(r.status, 400, "status");
  });
  await step("confess: 멤버가 아니면 403", async () => {
    const r = await api("POST", "/api/r/" + room + "/confess", {
      token: D.token,
      body: { rowId: "r1", colId: "c1", dir: 1 },
    });
    eq(r.status, 403, "status");
  });
  await step("confess: 계정당 분당 20회 넘으면 429", async () => {
    let good = 0;
    let hit = 0;
    for (let i = 0; i < 25; i++) {
      const r = await api("POST", "/api/r/" + room + "/confess", {
        token: B.token,
        body: { rowId: "r1", colId: "c1", dir: 1 },
      });
      if (r.status === 200) good++;
      else if (r.status === 429) {
        hit = i + 1;
        break;
      } else throw new Error("뜻밖의 상태: " + r.status);
    }
    expect(hit > 0, "25번을 눌러도 429 가 안 나옴");
    expect(good >= 14, "너무 일찍 막힘 — 통과한 횟수 " + good);
  });

  /* ---- 닉네임 ---- */
  head("닉네임 변경");
  await step("nick: 서기에 통지 + 당사자에게 you", async () => {
    B.nick = "꿀떡";
    const r = await api("POST", "/api/auth/nick", { token: B.token, body: { nick: B.nick } });
    eq(r.status, 200, "status");
    const m = await scribe.want((x) => x.kind === "nick");
    eq(m.acct, B.id, "acct");
    eq(m.nick, B.nick, "nick");
    const y = await vB.want((x) => x.kind === "you");
    eq(y.you.nick, B.nick, "you.nick");
  });
  await step("nick: 2~3자가 아니면 400", async () => {
    eq(
      (await api("POST", "/api/auth/nick", { token: B.token, body: { nick: "네글자닉" } })).status,
      400,
      "status"
    );
  });

  /* ---- 방송용 주소 ---- */
  head("방송용 주소(OBS 토큰)");
  await step("resolve: 방장 토큰 → 자기 방", async () => {
    const r = await api("GET", "/api/o/" + A.obsToken + "/resolve");
    eq(r.status, 200, "status");
    eq(r.data.roomId, room, "roomId");
  });
  await step("resolve: 참여도 활동 — 파티원 토큰이 그 방을 가리킴", async () => {
    const r = await api("GET", "/api/o/" + B.obsToken + "/resolve");
    eq(r.status, 200, "status");
    eq(r.data.roomId, room, "roomId");
    const me = await api("GET", "/api/auth/me", { token: B.token });
    eq(me.data.cur, room, "me.cur");
  });
  await step("resolve: 없는 토큰 → 404", async () => {
    eq((await api("GET", "/api/o/" + "Z".repeat(20) + "/resolve")).status, 404, "status");
  });
  await step("obs-reissue: 새 토큰이 나오고 옛 토큰은 404", async () => {
    const old = A.obsToken;
    const r = await api("POST", "/api/auth/obs-reissue", { token: A.token });
    eq(r.status, 200, "status");
    expect(r.data.obsToken && r.data.obsToken !== old, "토큰이 안 바뀜");
    A.obsToken = r.data.obsToken;
    eq((await api("GET", "/api/o/" + old + "/resolve")).status, 404, "옛 토큰");
    eq((await api("GET", "/api/o/" + A.obsToken + "/resolve")).data.roomId, room, "새 토큰");
  });
  /* 이 라우트만 리밋이 비어 있었습니다 — 계정부는 전역 DO 하나라, 반복 호출이
     다른 사람의 로그인·참여까지 느리게 만듭니다 (§4.1) */
  await step("obs-reissue: 계정당 하루 5회, 넘으면 429", async () => {
    const R = { id: acct("reis"), nick: "재발" };
    await reg(R);
    /* 위 준비에서 이미 한 번도 안 썼으니 5번은 통과해야 합니다 */
    for (let i = 1; i <= 4; i++)
      eq((await api("POST", "/api/auth/obs-reissue", { token: R.token })).status, 200, i + "회");
    eq((await api("POST", "/api/auth/obs-reissue", { token: R.token })).status, 200, "5회");
    const over = await api("POST", "/api/auth/obs-reissue", { token: R.token });
    eq(over.status, 429, "6회");
    eq(over.data.error, "slow down", "error");
  });
  await step("resolve: 잦은 조회가 매번 쓰기를 만들지 않는다 (seen 은 반나절에 한 번)", async () => {
    /* 값이 아니라 동작을 봅니다 — 연속 조회가 전부 200 이고 방을 같게 가리키면
       충분합니다. 쓰기를 건너뛰어도 답이 달라지지 않아야 합니다 */
    for (let i = 0; i < 3; i++) {
      const r = await api("GET", "/api/o/" + A.obsToken + "/resolve");
      eq(r.status, 200, i + "번째");
      eq(r.data.roomId, room, "roomId");
    }
  });
  await step("WS ?o=: 방송용 토큰으로 구독", async () => {
    const ov = await open("/api/r/" + room + "/live?o=" + A.obsToken);
    const hello = await ov.want((m) => m.kind === "hello");
    eq(hello.scribeOn, true, "scribeOn");
    const st = await ov.want((m) => m.kind === "state");
    expect(!!st.state, "판이 안 옴");
    await ov.close();
  });
  await step("WS ?o=: 남의 방에는 못 붙음(denied)", async () => {
    const other = await api("POST", "/api/my/room", { token: C.token });
    const bad = await open("/api/r/" + other.data.roomId + "/live?o=" + A.obsToken);
    const m = await bad.want((x) => x.kind === "denied");
    expect(!!m.why, "why 가 없음");
    await bad.close();
  });

  /* ---- 나가기 ---- */
  head("나가기");
  await step("leave: 서기에 left, 당사자에게 you=null", async () => {
    const r = await api("POST", "/api/r/" + room + "/leave", { token: B.token });
    eq(r.status, 200, "status");
    const m = await scribe.want((x) => x.kind === "left");
    eq(m.acct, B.id, "acct");
    const y = await vB.want((x) => x.kind === "you");
    eq(y.you, null, "you");
  });
  await step("leave 후: 다시 붙으면 denied(member)", async () => {
    const bad = await open("/api/r/" + room + "/live?s=" + B.token);
    const m = await bad.want((x) => x.kind === "denied");
    eq(m.why, "member", "why");
    await bad.close();
  });
  await step("presence: 서기 1→0 전환도 알림", async () => {
    await scribe.close();
    const m = await vJ.want((x) => x.kind === "presence" && x.scribeOn === false);
    eq(m.scribeOn, false, "scribeOn");
  });

  await vB.close();
  await vJ.close();

  /* ---- 판의 수명 (§3.4) ----
     사람 정리는 본인 [나가기]와 방장 내보내기(개별)뿐입니다. 해산(전원 킥) 동사는 없고,
     로비를 열고 닫는 것도 [정산 끝내기]도 멤버십을 안 끊습니다 (§1). */
  head("판의 수명 — 멤버십은 나가기·내보내기로만 끊긴다");
  await step("member approve: rowId 를 같이 주면 그 자리에 앉음 ([수락 ▾])", async () => {
    // C 는 앞 단계에서 이미 멤버입니다 — 자리를 지정해 다시 앉혀 봅니다
    const vC = await open("/api/r/" + room + "/live?s=" + C.token);
    await vC.want((m) => m.kind === "hello");
    const r = await api("POST", "/api/r/" + room + "/member", {
      token: A.token,
      body: { acct: C.id, action: "approve", rowId: "s9" },
    });
    eq(r.status, 200, "status");
    eq(r.data.member.rowId, "s9", "지정한 자리");
    const y = await vC.want((x) => x.kind === "you");
    eq(y.you.rowId, "s9", "당사자에게 간 자리");
    await vC.close();
    const list = (await api("GET", "/api/r/" + room + "/members", { token: A.token })).data.list;
    eq(list.find((x) => x.acct === C.id).rowId, "s9", "명단의 자리");
  });
  await step("pause: 방장 아니면 403", async () => {
    eq((await api("POST", "/api/r/" + room + "/pause", { token: C.token })).status, 403, "status");
  });
  await step("pause: 얼리면 전 구독자에 통지 — 아무것도 안 지움", async () => {
    const before = (await api("GET", "/api/r/" + room + "/members", { token: A.token })).data.list;
    const vC = await open("/api/r/" + room + "/live?s=" + C.token);
    await vC.want((m) => m.kind === "hello");
    const r = await api("POST", "/api/r/" + room + "/pause", { token: A.token });
    eq(r.status, 200, "status");
    eq(r.data.paused, true, "paused");
    const p = await vC.want((x) => x.kind === "paused");
    expect(!!p.paused, "얼림 통지");
    eq(p.paused.why, "host", "why");
    await vC.close();
    const after = (await api("GET", "/api/r/" + room + "/members", { token: A.token })).data.list;
    eq(after.length, before.length, "중단이 사람을 지움");
  });
  await step("pause: 얼어 있는 판에는 자수가 안 들어감 (409 paused)", async () => {
    const r = await api("POST", "/api/r/" + room + "/confess", {
      token: C.token,
      body: { rowId: "s9", colId: "c1", dir: 1 },
    });
    eq(r.status, 409, "status");
    eq(r.data.error, "paused", "error");
  });
  await step("my/room: 방장이 다시 열면 얼어 있는 채로 만남", async () => {
    const r = await api("POST", "/api/my/room", { token: A.token, body: {} });
    eq(r.status, 200, "status");
    expect(!!r.data.paused, "paused 가 안 실림");
    eq(r.data.paused.why, "host", "why");
  });
  await step("resume: 표시가 내려가고 전 구독자에 통지", async () => {
    const vC = await open("/api/r/" + room + "/live?s=" + C.token);
    const hello = await vC.want((m) => m.kind === "hello");
    expect(!!hello.paused, "hello 에 얼림이 안 실림");
    const r = await api("POST", "/api/r/" + room + "/resume", { token: A.token });
    eq(r.status, 200, "status");
    eq(r.data.paused, false, "paused");
    const p = await vC.want((x) => x.kind === "paused");
    eq(p.paused, null, "풀림 통지");
    await vC.close();
    const r2 = await api("POST", "/api/my/room", { token: A.token, body: {} });
    eq(r2.data.paused, null, "my/room 에 얼림이 남음");
  });
  await step("lobby 열기: 멤버십을 안 지운다 (§1)", async () => {
    const before = (await api("GET", "/api/r/" + room + "/members", { token: A.token })).data.list;
    expect(before.some((x) => x.acct === C.id), "C 가 멤버가 아님");
    const vC = await open("/api/r/" + room + "/live?s=" + C.token);
    await vC.want((m) => m.kind === "hello");
    const r = await api("POST", "/api/r/" + room + "/lobby", {
      token: A.token,
      body: { open: true, cap: 8 },
    });
    eq(r.status, 200, "status");
    eq(r.data.cleared, undefined, "해산 동사가 아직 살아 있음");
    const lb = await vC.want((x) => x.kind === "lobby");
    eq(lb.lobby.open, true, "로비 열림 브로드캐스트");
    expect(!vC.closed, "로비를 열었다고 소켓이 닫힘");
    await vC.close();
    const after = (await api("GET", "/api/r/" + room + "/members", { token: A.token })).data.list;
    eq(after.length, before.length, "로비를 열었다고 파티원이 사라짐");
  });
  await step("lobby: 이미 열린 로비의 정원만 바꿔도 명단 그대로", async () => {
    const r = await api("POST", "/api/r/" + room + "/lobby", {
      token: A.token,
      body: { open: true, cap: 10 },
    });
    eq(r.status, 200, "status");
    eq(r.data.lobby.cap, 10, "cap");
    const after = (await api("GET", "/api/r/" + room + "/members", { token: A.token })).data.list;
    expect(after.some((x) => x.acct === C.id), "명단이 유지되지 않음");
  });
  await step("lobby 닫기 → 파티원은 그대로 (판을 몇 번 돌리든 재팟은 유지)", async () => {
    const r = await api("POST", "/api/r/" + room + "/lobby", { token: A.token, body: { open: false } });
    eq(r.status, 200, "status");
    const after = (await api("GET", "/api/r/" + room + "/members", { token: A.token })).data.list;
    expect(after.some((x) => x.acct === C.id), "로비를 닫았다고 파티원이 사라짐");
  });
  await step("내보내기만이 사람을 뺀다 — 그 자리에서 you=null + 소켓 닫힘", async () => {
    const vC = await open("/api/r/" + room + "/live?s=" + C.token);
    await vC.want((m) => m.kind === "hello");
    const r = await api("POST", "/api/r/" + room + "/member", {
      token: A.token,
      body: { acct: C.id, action: "remove" },
    });
    eq(r.status, 200, "status");
    const y = await vC.want((x) => x.kind === "you");
    eq(y.you, null, "you 통지가 먼저");
    await waitClosed(vC, 20000);
    expect(vC.closed, "소켓이 안 닫힘");
    const after = (await api("GET", "/api/r/" + room + "/members", { token: A.token })).data.list;
    expect(!after.some((x) => x.acct === C.id), "명단에서 안 빠짐");
  });
  /* ---- 끝내기 = 해산 (2026-09-06 모델: 판은 만들면 생기고 끝내면 없다) ---- */
  await step("end: 해산 — 명단이 비고 판이 없어진다", async () => {
    eq((await api("POST", "/api/r/" + room + "/end", { token: C.token })).status, 403, "남이 부르면 403");
    const r = await api("POST", "/api/r/" + room + "/end", { token: A.token });
    eq(r.status, 200, "status");
    const after = (await api("GET", "/api/r/" + room + "/members", { token: A.token })).data.list;
    eq(after.length, 0, "명단이 안 비었음");
  });
  await step("문은 판이 있을 때만 — 판이 없으면 코드가 맞아도 /join 은 409 no party", async () => {
    const j = await api("POST", "/api/r/" + room + "/join", { token: C.token, body: { j: invite } });
    eq(j.status, 409, "판 없는 방에 들어감");
    eq(j.data.error, "no party", "error");
  });
  await step("새 판(lobby open) 뒤엔 들어가고, 지난 판의 내보냄 표시는 사라져 즉시 착석", async () => {
    const lb = await api("POST", "/api/r/" + room + "/lobby", { token: A.token, body: { open: true, cap: 8 } });
    eq(lb.status, 200, "lobby");
    const j = await api("POST", "/api/r/" + room + "/join", { token: C.token, body: { j: invite } });
    eq(j.status, 200, "join");
    eq(j.data.st, "ok", "내보냄 표시가 판을 넘어 남아 req 가 됨");
  });
  await step("GET invite: 지금 코드를 그대로 준다", async () => {
    const r = await api("GET", "/api/r/" + room + "/invite", { token: A.token });
    eq(r.status, 200, "status");
    eq(r.data.invite && r.data.invite.code, invite, "code");
    eq((await api("GET", "/api/r/" + room + "/invite", { token: C.token })).status, 403, "남이 읽으면 403");
  });
  await step("정리: 다음 단계를 위해 다시 해산", async () => {
    eq((await api("POST", "/api/r/" + room + "/end", { token: A.token })).status, 200, "end");
  });

  /* ---- 자동 중단 폐지 (§3.4, 2026-09-05) ----
     판단 함수는 남았지만 언제나 "얼리지 않는다"를 답해야 합니다. 알람은 판 삭제(90일)만 봅니다 */
  head("자동 중단 — 폐지");
  const { PAUSE_IDLE_MS, autoPauseAt, shouldAutoPause, nextRoomAlarm } = await import(
    "./src/round.js"
  );
  await step("계정 붙은 자리가 있어도 얼리지 않는다", () => {
    const stateAt = 5_000_000;
    eq(autoPauseAt({ stateAt, paused: false, seated: true }), 0, "자동 중단 알람이 걸림");
    eq(
      shouldAutoPause({ stateAt, paused: false, seated: true, now: stateAt + PAUSE_IDLE_MS * 3 }),
      false,
      "24시간 뒤에 얼었음"
    );
    eq(
      nextRoomAlarm({ stateAt, paused: false, seated: true }),
      stateAt + 90 * 86400 * 1000,
      "판 90일 알람만 남아야 함"
    );
  });
  await step("판이 없으면 알람도 없다", () => {
    eq(nextRoomAlarm({ stateAt: 0, paused: false, seated: true }), 0, "판 없이 알람이 걸림");
  });

  /* ---- 가입 없이 주소 받기 (§3-11) ---- */
  head("가입 없이 주소 받기(anon)");
  const N = {}; // 익명으로 시작해서 정식이 되는 계정 하나
  await step("anon: 닉을 보내면 그 이름으로 시작한다 ([게스트로 시작])", async () => {
    const r = await api("POST", "/api/auth/anon", { body: { nick: "곰돌" } });
    eq(r.status, 200, "status");
    eq(r.data.nick, "곰돌", "nick");
    const me = await api("GET", "/api/auth/me", { token: r.data.token });
    eq(me.data.nick, "곰돌", "me.nick");
    eq(me.data.anon, true, "anon 표시");
  });
  await step("anon: 닉이 2~3자가 아니면 400", async () => {
    eq((await api("POST", "/api/auth/anon", { body: { nick: "네글자닉" } })).status, 400, "4자");
    eq((await api("POST", "/api/auth/anon", { body: { nick: "한" } })).status, 400, "1자");
  });
  await step("anon: 본문 없이 계정 하나 — 닉 기본값 손님", async () => {
    const r = await api("POST", "/api/auth/anon", { body: {} });
    eq(r.status, 200, "status");
    expect(/^[a-z0-9]{4,20}$/.test(r.data.id), "익명 id 형식: " + r.data.id);
    eq(r.data.nick, "손님", "nick");
    expect(/^[ABCDEFGHJKMNPQRSTVWXYZ23456789]{32}$/.test(r.data.token), "세션 토큰 32자");
    expect(/^[ABCDEFGHJKMNPQRSTVWXYZ23456789]{20}$/.test(r.data.obsToken), "OBS 토큰 20자");
    N.id = r.data.id;
    N.token = r.data.token;
    N.obsToken = r.data.obsToken;
  });
  await step("anon: me 로 확인 — 그 세션이 그 계정", async () => {
    const r = await api("GET", "/api/auth/me", { token: N.token });
    eq(r.status, 200, "status");
    eq(r.data.id, N.id, "id");
    eq(r.data.nick, "손님", "nick");
    eq(r.data.obsToken, N.obsToken, "obsToken");
    eq(r.data.cur, null, "아직 들어간 방 없음");
    eq(r.data.anon, true, "익명 표시 — 앱이 파티 모드에서 이걸 보고 아이디를 받습니다");
    eq((await api("GET", "/api/auth/me", { token: A.token })).data.anon, false, "가입 계정은 false");
  });
  await step("anon: 그 세션으로 my/room·invite 가 그대로 됨", async () => {
    const r = await api("POST", "/api/my/room", { token: N.token });
    eq(r.status, 200, "status");
    expect(/^[ABCDEFGHJKMNPQRSTVWXYZ23456789]{6}$/.test(r.data.roomId), "방 주소 6자");
    N.room = r.data.roomId;
    const iv = await api("POST", "/api/r/" + N.room + "/invite", { token: N.token });
    eq(iv.status, 200, "invite status");
    expect(/^[ABCDEFGHJKMNPQRSTVWXYZ23456789]{8}$/.test(iv.data.invite.code), "코드 8자");
  });
  await step("anon: 방송용 주소가 자기 방을 가리킴", async () => {
    const r = await api("GET", "/api/o/" + N.obsToken + "/resolve");
    eq(r.status, 200, "status");
    eq(r.data.roomId, N.room, "roomId");
  });

  /* ---- 계정별 오버레이 외형 (§4.1) ---- */
  head("계정별 오버레이 외형(look)");
  await step("look: 저장하면 resolve 응답에 실려 나옴", async () => {
    const r = await api("POST", "/api/auth/look", {
      token: N.token,
      body: { look: { t: "light", bg: 70, s: 120 } },
    });
    eq(r.status, 200, "status");
    const res = await api("GET", "/api/o/" + N.obsToken + "/resolve");
    eq(res.status, 200, "resolve status");
    eq(res.data.roomId, N.room, "roomId");
    eq(res.data.look.t, "light", "look.t");
    eq(res.data.look.bg, 70, "look.bg");
    eq(res.data.look.s, 120, "look.s");
  });
  await step("look: 4KB 넘으면 413 (옛 외형은 그대로)", async () => {
    const r = await api("POST", "/api/auth/look", {
      token: N.token,
      body: { look: { pad: "x".repeat(5000) } },
    });
    eq(r.status, 413, "status");
    const res = await api("GET", "/api/o/" + N.obsToken + "/resolve");
    eq(res.data.look.t, "light", "막힌 뒤에도 옛 외형");
  });
  await step("look: 로그인 없으면 401", async () => {
    eq(
      (await api("POST", "/api/auth/look", { body: { look: { t: "dark" } } })).status,
      401,
      "status"
    );
  });
  await step("look: null 이면 지워지고 resolve 에서 빠짐", async () => {
    eq(
      (await api("POST", "/api/auth/look", { token: N.token, body: { look: null } })).status,
      200,
      "status"
    );
    const res = await api("GET", "/api/o/" + N.obsToken + "/resolve");
    eq(res.data.look, undefined, "look 이 남아 있음");
    // 다시 세워 둡니다 — 아래 upgrade 가 외형까지 그대로 남는지 봅니다
    await api("POST", "/api/auth/look", { token: N.token, body: { look: { t: "clear" } } });
  });

  /* ---- 정식 계정으로 전환 (§3-11) ---- */
  head("정식 계정으로 전환(upgrade)");
  const U = { id: acct("grow"), nick: "두유" };
  await step("upgrade: 로그인 없으면 401", async () => {
    const r = await api("POST", "/api/auth/upgrade", {
      body: { id: U.id, pw: "a".repeat(64), nick: U.nick },
    });
    eq(r.status, 401, "status");
  });
  await step("upgrade: 형식 위반(닉 4자·id 3자·pw 원문) → 400", async () => {
    const pw = await prehash(U.id, PW);
    eq(
      (await api("POST", "/api/auth/upgrade", { token: N.token, body: { id: U.id, pw, nick: "네글자닉" } }))
        .status,
      400,
      "닉 4자"
    );
    eq(
      (await api("POST", "/api/auth/upgrade", { token: N.token, body: { id: "ab", pw, nick: U.nick } }))
        .status,
      400,
      "id 2자"
    );
    eq(
      (await api("POST", "/api/auth/upgrade", {
        token: N.token,
        body: { id: U.id, pw: "hunter2", nick: U.nick },
      })).status,
      400,
      "선해시 아닌 pw"
    );
  });
  await step("upgrade: 이미 쓰는 아이디면 409", async () => {
    const r = await api("POST", "/api/auth/upgrade", {
      token: N.token,
      body: { id: A.id, pw: await prehash(A.id, PW), nick: U.nick },
    });
    eq(r.status, 409, "status");
    eq(r.data.error, "taken", "error");
  });
  await step("upgrade: 방·방송용 주소·세션·외형이 그대로 (주소가 안 바뀜)", async () => {
    U.pw = await prehash(U.id, PW);
    const r = await api("POST", "/api/auth/upgrade", {
      token: N.token,
      body: { id: U.id, pw: U.pw, nick: U.nick },
    });
    eq(r.status, 200, "status");
    eq(r.data.id, U.id, "id");
    eq(r.data.nick, U.nick, "nick");
    // 켜 둔 기기가 튕기면 안 됩니다 — 익명일 때 받은 세션이 그대로 살아 있어야 합니다
    const me = await api("GET", "/api/auth/me", { token: N.token });
    eq(me.status, 200, "me status");
    eq(me.data.id, U.id, "me.id");
    eq(me.data.nick, U.nick, "me.nick");
    eq(me.data.obsToken, N.obsToken, "obsToken 유지");
    eq(me.data.anon, false, "이제 정식 계정");
    eq(me.data.look.t, "clear", "me 에도 외형이 따라옴");
    const rm = await api("POST", "/api/my/room", { token: N.token });
    eq(rm.data.roomId, N.room, "roomId 유지");
    const res = await api("GET", "/api/o/" + N.obsToken + "/resolve");
    eq(res.data.roomId, N.room, "resolve roomId 유지");
    eq(res.data.look.t, "clear", "외형 유지");
  });
  await step("upgrade: 새 아이디·비밀번호로 로그인됨", async () => {
    const r = await api("POST", "/api/auth/login", { body: { id: U.id, pw: U.pw } });
    eq(r.status, 200, "status");
    eq(r.data.nick, U.nick, "nick");
    eq(r.data.obsToken, N.obsToken, "obsToken");
    U.token = r.data.token;
  });
  await step("upgrade: 방장 자리도 새 아이디로 옮겨감", async () => {
    // 옮기지 않았으면 제 방에서 403 이 납니다
    eq(
      (await api("POST", "/api/r/" + N.room + "/invite", { token: U.token })).status,
      200,
      "새 세션으로 초대 발급"
    );
    eq(
      (await api("PUT", "/api/r/" + N.room + "/state", {
        token: U.token,
        body: { state: { board: [] } },
      })).status,
      200,
      "새 세션으로 state 푸시"
    );
  });
  await step("upgrade: 이미 정식 계정이면 409", async () => {
    const id2 = acct("agan");
    const r = await api("POST", "/api/auth/upgrade", {
      token: U.token,
      body: { id: id2, pw: await prehash(id2, PW), nick: "세번" },
    });
    eq(r.status, 409, "status");
    eq(r.data.error, "not anon", "error");
  });

  /* ---- 함께한 사람·지목 초대·노크 (§3.3 라운드 B) ---- */
  head("함께한 사람과 지목 초대");
  /* 여기서는 익명 계정을 씁니다 — 관계를 여럿 만들어야 하는데 선해시가 계정마다
     31만 번이라, 가입으로 서른 몇을 만들면 검사가 몇 분씩 걸립니다.
     서버 쪽에서는 익명도 그냥 계정 하나라 관계·초대 경로가 똑같습니다 (§3-11) */
  const MATES = 30;
  const anon = async () => {
    const r = await api("POST", "/api/auth/anon", { body: {} });
    expect(r.status === 200, "anon → " + r.status + " " + JSON.stringify(r.data));
    return r.data;
  };
  const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
  const roomOf = async (u) => (await api("POST", "/api/my/room", { token: u.token })).data.roomId;
  /* 코드 = 판이 열려 있다 (2026-09-06 모델: 문은 판이 있을 때만) — 앱의 새 판 만들기처럼 로비를 먼저 엽니다 */
  const codeOf = async (u, rm) => {
    await api("POST", "/api/r/" + rm + "/lobby", { token: u.token, body: { open: true, cap: 8 } });
    return (await api("POST", "/api/r/" + rm + "/invite", { token: u.token, body: {} })).data.invite.code;
  };

  const P = await anon(); // 방장
  const Q = await anon(); // 함께할 사람
  const Z = await anon(); // 관계가 없는 사람
  const pRoom = await roomOf(P);
  const pCode = await codeOf(P, pRoom);
  let qRoom = null;
  let pScribe = null;
  let expAt = 0; // 만료 검사용 — 초대를 쏜 시각
  let pInv = 0; // 방장이 이번 분에 쏜 초대 수 (리밋 검사용)

  await step("관계: 링크로 한 번 함께하면 양쪽 목록에 생긴다", async () => {
    const j = await api("POST", "/api/r/" + pRoom + "/join", { token: Q.token, body: { j: pCode } });
    eq(j.status, 200, "join");
    eq(j.data.st, "ok", "st"); // 링크 = 초대장 (§3.3, 2026-09-05) — 관계는 앉는 순간 생긴다
    const a = await api("POST", "/api/r/" + pRoom + "/member", {
      token: P.token,
      body: { acct: Q.id, action: "approve" },
    });
    eq(a.status, 200, "approve");
    const meP = await api("GET", "/api/auth/me", { token: P.token });
    const meQ = await api("GET", "/api/auth/me", { token: Q.token });
    expect((meP.data.mates || []).some((x) => x.id === Q.id), "방장 목록에 없음");
    const mine = (meQ.data.mates || []).find((x) => x.id === P.id);
    expect(mine, "파티원 목록에 없음: " + JSON.stringify(meQ.data.mates));
    eq(mine.room, pRoom, "함께한 사람의 방");
    eq(mine.nick, P.nick, "함께한 사람의 닉");
  });

  /* 만료는 60초를 실제로 기다려야 확인됩니다 — 여기서 하나 쏴 두고,
     나머지 검사를 다 돌린 뒤 이 절의 끝에서 남은 시간만 기다립니다 */
  await step("만료 준비: 함께한 사람에게 초대를 하나 쏴 둔다", async () => {
    qRoom = await roomOf(Q);
    const r = await api("POST", "/api/invite", { token: Q.token, body: { to: P.id } });
    eq(r.status, 200, "status");
    expAt = Date.now();
  });

  await step("나가도 관계는 남는다", async () => {
    eq(
      (await api("POST", "/api/r/" + pRoom + "/leave", { token: Q.token, body: {} })).status,
      200,
      "leave"
    );
    const meQ = await api("GET", "/api/auth/me", { token: Q.token });
    expect((meQ.data.mates || []).some((x) => x.id === P.id), "관계가 사라짐");
  });

  await step("초대: 함께한 사람에게 자리를 지정해 쏜다", async () => {
    const r = await api("POST", "/api/invite", { token: P.token, body: { to: Q.id, seat: "r7" } });
    pInv++;
    eq(r.status, 200, "status");
    eq(r.data.seat, "r7", "seat");
  });
  await step("초대: 함께한 사람이 아니면 403", async () => {
    const r = await api("POST", "/api/invite", { token: P.token, body: { to: Z.id } });
    eq(r.status, 403, "status");
    eq(r.data.error, "not mate", "error");
  });
  await step("/me: 대기 중인 지목 초대가 실린다", async () => {
    const me = await api("GET", "/api/auth/me", { token: Q.token });
    const iv = (me.data.invites || []).find((x) => x.from === P.id);
    expect(iv, "초대가 안 보임: " + JSON.stringify(me.data.invites));
    eq(iv.room, pRoom, "room");
    eq(iv.seat, "r7", "seat");
    eq(iv.fromNick, P.nick, "fromNick");
  });
  await step("수락: 방장 수락 없이 바로 자리에 앉고 서기에 통지된다", async () => {
    pScribe = await open("/api/r/" + pRoom + "/scribe?s=" + encodeURIComponent(P.token));
    await pScribe.want((x) => x.kind === "members");
    const r = await api("POST", "/api/r/" + pRoom + "/join", { token: Q.token, body: { inv: 1 } });
    eq(r.status, 200, "status");
    eq(r.data.st, "ok", "st");
    eq(r.data.you.rowId, "r7", "rowId");
    const j = await pScribe.want((x) => x.kind === "join");
    eq(j.st, "ok", "서기 통지 st");
    eq(j.seat, "r7", "서기 통지 seat");
  });
  await step("수락: 한 번 쓴 초대는 사라진다", async () => {
    const me = await api("GET", "/api/auth/me", { token: Q.token });
    expect(!(me.data.invites || []).some((x) => x.from === P.id), "초대가 남아 있음");
  });

  /* ---- 초대는 자리를 예약하지 않는다 — 문 앞에서 다시 센다 (§3.3) ----
     부를 때는 자리가 있었는데 오는 사이 찼으면 튕기지 않고 신청으로 내려앉힌다.
     방장이 콕 집어 부른 사람이라 조용히 돌려보내면 양쪽 다 왜 안 됐는지 모른다 */
  await step("가득 참 준비: 자리를 비우고 정원 1로 로비를 연다", async () => {
    eq(
      (await api("POST", "/api/r/" + pRoom + "/leave", { token: Q.token, body: {} })).status,
      200,
      "leave"
    );
    /* 정원 1 = 방장 한 자리 — 남은 빈 칸이 없다 */
    eq(
      (await api("POST", "/api/r/" + pRoom + "/lobby", { token: P.token, body: { open: true, cap: 1 } }))
        .status,
      200,
      "lobby"
    );
  });
  await step("수락: 그 사이 자리가 차면 신청으로 내려앉는다 (튕기지 않음)", async () => {
    const s = await api("POST", "/api/invite", { token: P.token, body: { to: Q.id, seat: "r7" } });
    pInv++;
    eq(s.status, 200, "초대 발송");
    const r = await api("POST", "/api/r/" + pRoom + "/join", { token: Q.token, body: { inv: 1 } });
    eq(r.status, 200, "튕기지 않고 200");
    eq(r.data.st, "req", "st");
    eq(r.data.full, true, "full");
    eq(r.data.you.rowId, null, "자리는 아직 없음");
  });
  await step("수락: 서기에 inv 표시가 붙은 신청으로 통지된다", async () => {
    const j = await pScribe.want((x) => x.kind === "join");
    eq(j.st, "req", "st");
    eq(j.inv, 1, "inv 표시");
  });
  await step("members: 내려앉은 신청은 inv 로 갈라 보인다", async () => {
    const list = (await api("GET", "/api/r/" + pRoom + "/members", { token: P.token })).data.list;
    const q = list.find((x) => x.acct === Q.id);
    eq(q.st, "req", "st");
    eq(q.inv, true, "inv");
  });
  await step("내려앉은 사람에겐 자리가 아직 없다", async () => {
    /* 관계는 여기서 볼 수 없다 — 지목 초대는 애초에 함께한 사람에게만 가므로
       P·Q 는 이미 관계가 있다. 볼 수 있는 것은 자리를 안 잡았다는 것 하나다 */
    const list = (await api("GET", "/api/r/" + pRoom + "/members", { token: P.token })).data.list;
    eq(list.find((x) => x.acct === Q.id).rowId, null, "rowId");
  });
  await step("인원 수를 늘려 수락하면 그대로 들어오고 inv 표시가 걷힌다", async () => {
    await api("POST", "/api/r/" + pRoom + "/lobby", { token: P.token, body: { open: true, cap: 4 } });
    const r = await api("POST", "/api/r/" + pRoom + "/member", {
      token: P.token,
      body: { acct: Q.id, action: "approve", rowId: "r7" },
    });
    eq(r.status, 200, "status");
    eq(r.data.member.st, "ok", "st");
    const list = (await api("GET", "/api/r/" + pRoom + "/members", { token: P.token })).data.list;
    eq(list.find((x) => x.acct === Q.id).inv, false, "inv 가 안 걷힘");
  });
  await step("가득 참 정리: 로비를 닫는다", async () => {
    eq(
      (await api("POST", "/api/r/" + pRoom + "/lobby", { token: P.token, body: { open: false } }))
        .status,
      200,
      "lobby"
    );
  });

  await step("노크 준비: 나갔다 다시 문 앞에 선다", async () => {
    eq(
      (await api("POST", "/api/r/" + pRoom + "/leave", { token: Q.token, body: {} })).status,
      200,
      "leave"
    );
  });
  await step("노크: 관계 없는 계정의 코드 없는 join → 403", async () => {
    const r = await api("POST", "/api/r/" + pRoom + "/join", { token: Z.token, body: {} });
    eq(r.status, 403, "status");
  });
  await step("노크: 함께한 사람의 코드 없는 join → 신청(req)", async () => {
    const r = await api("POST", "/api/r/" + pRoom + "/join", { token: Q.token, body: {} });
    eq(r.status, 200, "status");
    eq(r.data.st, "req", "st");
    const list = (await api("GET", "/api/r/" + pRoom + "/members", { token: P.token })).data.list;
    expect(
      list.some((m) => m.acct === Q.id && m.st === "req"),
      "신청 칸에 없음: " + JSON.stringify(list)
    );
  });
  await step("신청 취소: /leave 가 st:req 도 지운다", async () => {
    eq(
      (await api("POST", "/api/r/" + pRoom + "/leave", { token: Q.token, body: {} })).status,
      200,
      "leave"
    );
    const list = (await api("GET", "/api/r/" + pRoom + "/members", { token: P.token })).data.list;
    expect(!list.some((m) => m.acct === Q.id), "신청이 남아 있음");
  });

  await step("초대 리밋: 분당 10회를 넘기면 429", async () => {
    for (; pInv < 10; pInv++) {
      const r = await api("POST", "/api/invite", { token: P.token, body: { to: Q.id } });
      eq(r.status, 200, "리밋 안쪽 " + (pInv + 1) + "회");
    }
    const over = await api("POST", "/api/invite", { token: P.token, body: { to: Q.id } });
    eq(over.status, 429, "11회째");
  });

  await step("함께한 사람: 최근 순 30명, 넘치면 오래된 것부터 밀린다", async () => {
    const H = await anon();
    const hRoom = await roomOf(H);
    const code = await codeOf(H, hRoom);
    /* 정원은 대기실(로비 열림)의 것입니다 — 판을 시작해 로비를 닫으면 합류에 정원이 없습니다 (2026-09-06 모델) */
    await api("PUT", "/api/r/" + hRoom + "/state", { token: H.token, body: { state: { board: [], roundId: "m1" } } });
    await api("POST", "/api/r/" + hRoom + "/lobby", { token: H.token, body: { open: false } });
    const guests = [];
    for (let i = 0; i <= MATES; i++) {
      const g = await anon();
      guests.push(g);
      eq(
        (await api("POST", "/api/r/" + hRoom + "/join", { token: g.token, body: { j: code } })).status,
        200,
        "join " + i
      );
      eq(
        (await api("POST", "/api/r/" + hRoom + "/member", {
          token: H.token,
          body: { acct: g.id, action: "approve" },
        })).status,
        200,
        "approve " + i
      );
    }
    const me = await api("GET", "/api/auth/me", { token: H.token });
    const ids = (me.data.mates || []).map((x) => x.id);
    eq(ids.length, MATES, "목록 길이");
    expect(!ids.includes(guests[0].id), "제일 오래된 사람이 안 밀림");
    eq(ids[0], guests[MATES].id, "제일 최근 사람이 맨 앞");
  });

  await step("만료: 60초 지난 초대는 /me 에서 사라진다", async () => {
    const left = 61000 - (Date.now() - expAt);
    if (left > 0) await sleep(left);
    const me = await api("GET", "/api/auth/me", { token: P.token });
    expect(!(me.data.invites || []).some((x) => x.from === Q.id), "만료된 초대가 남아 있음");
  });
  await step("만료: 지난 초대로 수락하면 403", async () => {
    const r = await api("POST", "/api/r/" + qRoom + "/join", { token: P.token, body: { inv: 1 } });
    eq(r.status, 403, "status");
  });
  if (pScribe) await pScribe.close();

  /* ---- 파티 하나 규칙 (§3.3) ----
     어느 방에서든 st:"ok" 가 되는 순간 서버가 그 계정의 다른 방 착석을 지우고 그쪽에
     통지합니다. 클라이언트 보정에 기대지 않습니다 — 한 사람이 두 방에 동시에 앉는
     구멍이 실제로 있었습니다. */
  head("파티 하나 규칙 — 두 방에 동시에 못 앉는다");
  const H1 = await anon(); // 첫 방장
  const H2 = await anon(); // 둘째 방장
  const G1 = await anon(); // 옮겨 다니는 사람
  const r1 = await roomOf(H1);
  const r2 = await roomOf(H2);
  let s1 = null;

  await step("준비: 첫 방에 앉는다", async () => {
    const c1 = await codeOf(H1, r1);
    eq(
      (await api("POST", "/api/r/" + r1 + "/join", { token: G1.token, body: { j: c1 } })).status,
      200,
      "join"
    );
    eq(
      (await api("POST", "/api/r/" + r1 + "/member", {
        token: H1.token,
        body: { acct: G1.id, action: "approve", rowId: "r3" },
      })).status,
      200,
      "approve"
    );
    const list = (await api("GET", "/api/r/" + r1 + "/members", { token: H1.token })).data.list;
    expect(list.some((m) => m.acct === G1.id && m.st === "ok"), "첫 방에 안 앉음");
  });

  await step("둘째 방에 앉는 순간 첫 방 착석이 지워지고 양쪽에 통지된다", async () => {
    s1 = await open("/api/r/" + r1 + "/scribe?s=" + encodeURIComponent(H1.token));
    await s1.want((x) => x.kind === "members");
    const gv = await open("/api/r/" + r1 + "/live?s=" + encodeURIComponent(G1.token));
    await gv.want((x) => x.kind === "hello");
    const c2 = await codeOf(H2, r2);
    eq(
      (await api("POST", "/api/r/" + r2 + "/join", { token: G1.token, body: { j: c2 } })).status,
      200,
      "둘째 방 신청"
    );
    eq(
      (await api("POST", "/api/r/" + r2 + "/member", {
        token: H2.token,
        body: { acct: G1.id, action: "approve" },
      })).status,
      200,
      "둘째 방 수락"
    );
    const left = await s1.want((x) => x.kind === "left" && x.acct === G1.id);
    eq(left.acct, G1.id, "첫 방장에게 left 통지");
    const y = await gv.want((x) => x.kind === "you");
    eq(y.you, null, "본인 화면에 you=null");
    /* 통지 뒤에 소켓을 닫습니다 — 안 닫으면 못 보는 판이 화면에 몇 초 남습니다 (§4.2) */
    await waitClosing(gv, 20000);
    await gv.close();
    const l1 = (await api("GET", "/api/r/" + r1 + "/members", { token: H1.token })).data.list;
    expect(!l1.some((m) => m.acct === G1.id), "첫 방에 아직 앉아 있음: " + JSON.stringify(l1));
    const l2 = (await api("GET", "/api/r/" + r2 + "/members", { token: H2.token })).data.list;
    expect(l2.some((m) => m.acct === G1.id && m.st === "ok"), "둘째 방에 안 앉음");
  });

  await step("지목 초대 수락도 같은 규칙 — 앞 파티에서 자동으로 빠진다", async () => {
    const s2 = await open("/api/r/" + r2 + "/scribe?s=" + encodeURIComponent(H2.token));
    await s2.want((x) => x.kind === "members");
    eq(
      (await api("POST", "/api/invite", { token: H1.token, body: { to: G1.id, seat: "r5" } })).status,
      200,
      "지목 초대"
    );
    const j = await api("POST", "/api/r/" + r1 + "/join", { token: G1.token, body: { inv: 1 } });
    eq(j.status, 200, "수락");
    eq(j.data.st, "ok", "st");
    const left = await s2.want((x) => x.kind === "left" && x.acct === G1.id);
    eq(left.acct, G1.id, "둘째 방장에게 left 통지");
    await s2.close();
    const l2 = (await api("GET", "/api/r/" + r2 + "/members", { token: H2.token })).data.list;
    expect(!l2.some((m) => m.acct === G1.id), "둘째 방에 아직 앉아 있음: " + JSON.stringify(l2));
    const l1 = (await api("GET", "/api/r/" + r1 + "/members", { token: H1.token })).data.list;
    expect(l1.some((m) => m.acct === G1.id && m.st === "ok"), "첫 방에 안 앉음");
  });

  /* ---- /me 가 싣는 내 자리 (§3.4·§8) ----
     정산이 끝난 뒤 [닫기]로 자기 앱에 돌아온 사람은 명단에 그대로 남습니다.
     그 방의 판이 다시 살아나면 앱이 `판이 시작됐어요.` 카드를 세워야 하는데,
     그 근거가 이 응답입니다. */
  head("/me — 내가 앉아 있는 방의 판 상태");
  await step("/me: 살아 있는 판이면 seat.live 가 참", async () => {
    eq(
      (await api("PUT", "/api/r/" + r1 + "/state", {
        token: H1.token,
        body: { state: { board: [], roundId: "g1" } },
      })).status,
      200,
      "state"
    );
    const me = await api("GET", "/api/auth/me", { token: G1.token });
    eq(me.status, 200, "status");
    expect(me.data.seat, "seat 가 안 실림: " + JSON.stringify(me.data));
    eq(me.data.seat.st, "ok", "st");
    eq(me.data.seat.live, true, "live");
    eq(me.data.seat.round, true, "round");
    eq(me.data.seat.ownerNick, H1.nick, "ownerNick");
  });
  await step("/me: 시작 전(state.lobby)은 live 지만 round 는 아니다 (2026-09-06)", async () => {
    eq(
      (await api("PUT", "/api/r/" + r1 + "/state", {
        token: H1.token,
        body: { state: { board: [], roundId: "g1", lobby: { open: true } } },
      })).status,
      200,
      "state lobby"
    );
    const me = await api("GET", "/api/auth/me", { token: G1.token });
    eq(me.data.seat.live, true, "live");
    eq(me.data.seat.round, false, "round");
    eq(
      (await api("PUT", "/api/r/" + r1 + "/state", {
        token: H1.token,
        body: { state: { board: [], roundId: "g1" } },
      })).status,
      200,
      "state back"
    );
  });
  await step("/me: 정산이 끝난 판(end)은 live 가 아니다", async () => {
    eq(
      (await api("PUT", "/api/r/" + r1 + "/state", {
        token: H1.token,
        body: { state: { board: [], roundId: "g1", end: 1 } },
      })).status,
      200,
      "state end"
    );
    const me = await api("GET", "/api/auth/me", { token: G1.token });
    eq(me.data.seat.live, false, "live");
  });
  await step("/me: 얼어 있는 판도 live 가 아니다", async () => {
    eq(
      (await api("PUT", "/api/r/" + r1 + "/state", {
        token: H1.token,
        body: { state: { board: [], roundId: "g2" } },
      })).status,
      200,
      "state new"
    );
    eq((await api("POST", "/api/r/" + r1 + "/pause", { token: H1.token })).status, 200, "pause");
    const me = await api("GET", "/api/auth/me", { token: G1.token });
    eq(me.data.seat.live, false, "live");
  });
  await step("/me: 다시 시작하면 live 로 돌아온다 (카드를 세우는 순간)", async () => {
    eq((await api("POST", "/api/r/" + r1 + "/resume", { token: H1.token })).status, 200, "resume");
    const me = await api("GET", "/api/auth/me", { token: G1.token });
    eq(me.data.seat.live, true, "live");
  });
  await step("나가면 색인도 놓는다 — 그 뒤 /me 의 seat 는 자리 없음", async () => {
    eq(
      (await api("POST", "/api/r/" + r1 + "/leave", { token: G1.token, body: {} })).status,
      200,
      "leave"
    );
    const me = await api("GET", "/api/auth/me", { token: G1.token });
    eq(me.data.seat.st, null, "st");
    eq(me.data.seat.live, false, "live");
  });
  if (s1) await s1.close();

  /* ---- 초대의 두 실패 (§8) ----
     `이 초대는 쓸 수 없어요…` 와 `초대가 만료됐어요…` 는 사람이 할 일은 같아도 말이
     다릅니다. 서버가 갈라서 알려 줘야 앱이 그 둘을 가려 씁니다. */
  head("초대의 두 실패 — 무효와 만료");
  await step("join: 재발급으로 죽은 코드는 무효(invite)", async () => {
    const G2 = await anon();
    const old = await codeOf(H1, r1);
    await codeOf(H1, r1); // 재발급 — 옛 코드는 그 자리에서 무효
    const r = await api("POST", "/api/r/" + r1 + "/join", { token: G2.token, body: { j: old } });
    eq(r.status, 403, "status");
    eq(r.data.error, "invite", "error");
  });
  await step("join: 아무 코드나 넣어도 무효(invite)", async () => {
    const G3 = await anon();
    const r = await api("POST", "/api/r/" + r1 + "/join", { token: G3.token, body: { j: "ZZZZZZZZ" } });
    eq(r.status, 403, "status");
    eq(r.data.error, "invite", "error");
  });
  /* 만료는 10분을 실제로 기다려야 나오는 답이라, 갈라지는 자리가 코드에 있는지로 봅니다 */
  await step("코드: 만료는 expired 로 갈라져 나간다 (join · WS)", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("./src/index.js", import.meta.url), "utf8");
    expect(src.indexOf('json({ error: "expired" }, 403)') > 0, "join 의 만료 분기가 없음");
    expect(src.indexOf('why = "expired"') > 0, "WS 의 만료 분기가 없음");
  });

  /* ---- 옛 주소 (§4.4) ---- */
  head("옛 주소 안내(gone)");
  await step("WS: 방장이 없는 방(옛 주소) → denied gone", async () => {
    const bad = await open("/api/r/ZZZZZZ/live");
    const m = await bad.want((x) => x.kind === "denied");
    eq(m.why, "gone", "why");
    await bad.close();
    expect(bad.closed, "소켓이 안 닫힘");
  });
  await step("WS: 초대가 없어서 막힌 방은 gone 이 아니라 invite", async () => {
    const bad = await open("/api/r/" + room + "/live?j=ZZZZZZZZ");
    const m = await bad.want((x) => x.kind === "denied");
    eq(m.why, "invite", "why");
    await bad.close();
  });

  /* ---- 페이지 (§6.3) ---- */
  head("페이지");
  const pageOf = async (path) => {
    const r = await fetch(BASE + path);
    return { status: r.status, html: await r.text() };
  };
  await step("/r/:id — 200, 치환 자리 안 남음", async () => {
    const p = await pageOf("/r/" + room);
    eq(p.status, 200, "status");
    expect(p.html.indexOf("__ROOM__") < 0, "__ROOM__ 이 남아 있음");
    expect(p.html.indexOf("__OTOK__") < 0, "__OTOK__ 이 남아 있음");
    expect(p.html.indexOf("__APP__") < 0, "__APP__ 이 남아 있음");
    expect(p.html.indexOf('var ROOM = "' + room + '"') > 0, "방 주소가 안 박힘");
    expect(p.html.indexOf('var OTOK = ""') > 0, "OTOK 이 비어 있지 않음");
  });
  await step("/o/:token — 200, 토큰이 박히고 ROOM 은 빔", async () => {
    const p = await pageOf("/o/" + A.obsToken);
    eq(p.status, 200, "status");
    expect(p.html.indexOf("__OTOK__") < 0, "__OTOK__ 이 남아 있음");
    expect(p.html.indexOf('var OTOK = "' + A.obsToken + '"') > 0, "토큰이 안 박힘");
    expect(p.html.indexOf('var ROOM = ""') > 0, "ROOM 이 비어 있지 않음");
  });
  await step("페이지: 대기실 렌더와 §8 문구가 들어 있음", async () => {
    const p = await pageOf("/r/" + room);
    expect(p.html.indexOf("대기실 ") > 0, "대기실 제목이 없음");
    /* 방송 화면의 대기실 아래 한 줄 — 앱의 대기 배너와 달리 이건 방송용 문구입니다 */
    expect(p.html.indexOf("모이는 중이에요…") > 0, "대기실 오버레이 문구가 없음");
    expect(
      p.html.indexOf("이 주소만으로는 판을 볼 수 없어요. 자수 화면의 '내 방송용 주소'를 넣어주세요.") > 0,
      "/r/ 침묵 예외 문구가 없음"
    );
    expect(
      p.html.indexOf("지금 들어가 있는 파티가 없어요. 초대를 받아 참여하면 다시 보여요.") > 0,
      "/o/ 침묵 예외 문구가 없음"
    );
  });
  await step("/o/ — 판별 없이 오버레이 + 브라우저일 때만 한 줄 (§4.4)", async () => {
    const p = await pageOf("/o/" + A.obsToken);
    // OTOK 이 있으면 판별을 건너뜁니다 (?mode=page 만 예외)
    expect(p.html.indexOf("!!OTOK || inCast") > 0, "/o/ 무조건 오버레이 분기가 없음");
    expect(p.html.indexOf('forced !== "page"') > 0, "?mode=page 예외가 없음");
    expect(
      p.html.indexOf("이 주소는 방송 프로그램에 넣는 주소예요.") > 0,
      "브라우저로 열었을 때의 한 줄이 없음"
    );
    expect(p.html.indexOf("ov-hint") > 0, "한 줄을 얹을 자리가 없음");
  });
  await step("페이지: 옛 주소 안내 문구 (§8)", async () => {
    const p = await pageOf("/r/" + room);
    expect(
      p.html.indexOf("주소 체계가 바뀌었어요. 앱에서 새 주소를 받아 넣어주세요.") > 0,
      "옛 주소 안내 문구가 없음"
    );
    expect(p.html.indexOf('m.why === "gone"') > 0, "gone 분기가 없음");
  });
  await step("데모(/r/CAFE22)는 그대로", async () => {
    const p = await pageOf("/r/CAFE22");
    eq(p.status, 200, "status");
    expect(p.html.indexOf('var DEMO_ROOM = "CAFE22"') > 0, "데모 방이 없음");
    expect(p.html.indexOf("startDemo") > 0, "startDemo 가 없음");
  });

  /* ---- v1 흔적 ---- */
  head("v1 라우트 폐기");
  for (const [name, path, method] of [
    ["/api/rooms", "/api/rooms", "POST"],
    ["/api/handoff", "/api/handoff", "POST"],
    ["/api/recovery", "/api/recovery", "POST"],
    ["key 기반 kill", "/api/r/" + room + "/kill", "POST"],
    ["key 기반 peek", "/api/r/" + room + "/peek", "GET"],
    ["archive", "/api/r/" + room + "/archive", "POST"],
  ])
    await step("v1 " + name + " → 404", async () => {
      const r = await api(method, path, { body: method === "POST" ? {} : undefined });
      eq(r.status, 404, "status");
    });

  /* ---- CORS ---- */
  head("CORS");
  await step("OPTIONS: authorization 헤더 허용", async () => {
    const r = await fetch(BASE + "/api/auth/me", { method: "OPTIONS" });
    eq(r.headers.get("access-control-allow-origin"), "*", "origin");
    expect(
      (r.headers.get("access-control-allow-headers") || "").includes("authorization"),
      "allow-headers: " + r.headers.get("access-control-allow-headers")
    );
    expect(
      (r.headers.get("access-control-allow-methods") || "").includes("PUT"),
      "allow-methods: " + r.headers.get("access-control-allow-methods")
    );
  });
};

main()
  .catch((e) => {
    failN++;
    console.log("FAIL  (시나리오 중단) → " + (e && e.stack ? e.stack : e));
  })
  .then(() => {
    console.log("\n" + passN + " PASS / " + failN + " FAIL");
    process.exit(failN ? 1 : 0);
  });
