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
  await step("invite: 30분짜리 8자 코드", async () => {
    const r = await api("POST", "/api/r/" + room + "/invite", { token: A.token });
    eq(r.status, 200, "status");
    expect(/^[ABCDEFGHJKMNPQRSTVWXYZ23456789]{8}$/.test(r.data.invite.code), "코드 8자: " + r.data.invite.code);
    const left = r.data.invite.exp - Date.now();
    expect(Math.abs(left - 30 * 60 * 1000) < 60000, "만료가 30분이 아님: " + left);
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
  await step("lobby: 정원 범위(2~16) 밖 → 400", async () => {
    eq(
      (await api("POST", "/api/r/" + room + "/lobby", { token: A.token, body: { open: true, cap: 17 } }))
        .status,
      400,
      "status"
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
  await step("join: 로비 열림 → 수락 없이 st ok", async () => {
    const r = await api("POST", "/api/r/" + room + "/join", { token: B.token, body: { j: invite } });
    eq(r.status, 200, "status");
    eq(r.data.st, "ok", "st");
    eq(r.data.you.nick, B.nick, "you.nick");
    eq(r.data.you.rowId, null, "아직 줄 없음");
  });
  await step("join: 정원 차면 409", async () => {
    await reg(C);
    const r = await api("POST", "/api/r/" + room + "/join", { token: C.token, body: { j: invite } });
    eq(r.status, 409, "status");
    eq(r.data.error, "full", "error");
  });
  await step("join: 정원을 늘리면 다시 들어옴", async () => {
    await api("POST", "/api/r/" + room + "/lobby", { token: A.token, body: { open: true, cap: 8 } });
    const r = await api("POST", "/api/r/" + room + "/join", { token: C.token, body: { j: invite } });
    eq(r.status, 200, "status");
    eq(r.data.st, "ok", "st");
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
  await step("join: 로비가 닫혀 있으면 st req (신청)", async () => {
    await reg(D);
    const r = await api("POST", "/api/r/" + room + "/join", { token: D.token, body: { j: invite } });
    eq(r.status, 200, "status");
    eq(r.data.st, "req", "st");
    const m = await scribe.want((x) => x.kind === "join");
    eq(m.acct, D.id, "acct");
    eq(m.nick, D.nick, "nick");
    eq(m.st, "req", "st");
  });
  await step("members: 신청자가 목록에 st req 로 보임", async () => {
    const r = await api("GET", "/api/r/" + room + "/members", { token: A.token });
    eq(r.status, 200, "status");
    const d = r.data.list.find((x) => x.acct === D.id);
    eq(d.st, "req", "st");
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
