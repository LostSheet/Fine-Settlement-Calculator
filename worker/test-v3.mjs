/* §3.12 워커 검증 (OBS-SPEC §3.12.9). 쓰는 법: 다른 창에서 `npx wrangler dev --port 8787` 을 띄워 두고 `node test-v3.mjs`. — 코드 없는 입장, 판 경계, 자리 내주기, 접속 기반 송출, 요청자 판 가림 */
const B = process.env.BASE || "http://127.0.0.1:8787";
const WSB = B.replace(/^http/, "ws");
const J = { "content-type": "application/json" };
const api = async (method, path, token, body) => {
  const h = { ...J };
  if (token) h.authorization = "Bearer " + token;
  const r = await fetch(B + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  let d = null;
  try { d = await r.json(); } catch (e) {}
  return { status: r.status, ok: r.ok, data: d };
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const t = (name, cond, extra) => { if (cond) { pass++; console.log("PASS  " + name); } else { fail++; console.log("FAIL  " + name + (extra ? "  → " + extra : "")); } };
const openWs = (url) => new Promise((res, rej) => {
  const ws = new WebSocket(url);
  const got = [];
  ws.addEventListener("message", (e) => { try { got.push(JSON.parse(e.data)); } catch (x) {} });
  ws.addEventListener("open", () => res({ ws, got }));
  ws.addEventListener("error", (e) => rej(e));
  ws.addEventListener("close", () => { got.closed = true; });
});

const H = (await api("POST", "/api/auth/anon", null, {})).data;
const room = (await api("POST", "/api/my/room", H.token)).data;
const R = room.roomId || room.room || null;
t("방장 익명 계정 + 내 방", !!H.token && !!R, JSON.stringify(room).slice(0, 80));

const M = (await api("POST", "/api/auth/anon", null, {})).data;
const myRoomM = (await api("POST", "/api/my/room", M.token)).data;
const RM = myRoomM.roomId || myRoomM.room;
const j1 = await api("POST", `/api/r/${R}/join`, M.token, { ava: { id: "200", a: "h1" } });
t("코드 없는 링크 입장 → 요청(req)", j1.ok && j1.data.st === "req", JSON.stringify(j1.data));

const ml = await api("GET", `/api/r/${R}/members`, H.token);
t("방장 명단에 요청자 + roundAt 동봉", ml.ok && ml.data.list.some((m) => m.acct === M.id && m.st === "req") && "roundAt" in ml.data, JSON.stringify(ml.data).slice(0, 120));
t("명단에 초상화(ava) 실림", ml.data.list.find((m) => m.acct === M.id)?.ava?.id === "200");

/* 요청자에게는 판이 안 간다 */
{
  const { ws, got } = await openWs(`${WSB}/api/r/${R}/live?s=${M.token}`);
  await sleep(500);
  t("요청자 소켓: hello 는 오고 state 는 안 온다", got.some((m) => m.kind === "hello") && !got.some((m) => m.kind === "state"), got.map((m) => m.kind).join(","));
  ws.close();
  await sleep(200);
}

const rd = await api("POST", `/api/r/${R}/round`, H.token, {});
t("[비우기] 경계 /round", rd.ok && rd.data.roundAt > 0);

const ap = await api("POST", `/api/r/${R}/member`, H.token, { acct: M.id, action: "approve", rowId: "r2" });
t("[받기] rowId 로 착석", ap.ok && ap.data.member.st === "ok" && ap.data.member.rowId === "r2", JSON.stringify(ap.data));

/* 접속 → 송출 방 */
const app = await openWs(`${WSB}/api/r/${R}/live?s=${M.token}`);
await sleep(600);
t("착석자 소켓: state 도 온다", app.got.some((m) => m.kind === "state"));
const rs1 = await api("GET", `/api/o/${M.obsToken}/resolve`);
t("접속 중이면 주소가 방장 판을 가리킨다", rs1.ok && rs1.data.roomId === R, JSON.stringify(rs1));
const ml2 = await api("GET", `/api/r/${R}/members`, H.token);
const mm = ml2.data.list.find((m) => m.acct === M.id);
t("이번 판에 앱을 연 사람: seen > roundAt", mm && mm.seen > ml2.data.roundAt, JSON.stringify({ seen: mm && mm.seen, roundAt: ml2.data.roundAt }));

/* 오버레이 소켓 — 접속으로 세지 않고, 방이 바뀌면 다시 붙으라는 말을 듣는다 */
const ov = await openWs(`${WSB}/api/r/${R}/live?o=${M.obsToken}`);
await sleep(400);
t("오버레이 소켓 hello", ov.got.some((m) => m.kind === "hello"));

/* 자리 내주기 */
const M2 = (await api("POST", "/api/auth/anon", null, {})).data;
await api("POST", `/api/r/${R}/join`, M2.token, {});
const ap2 = await api("POST", `/api/r/${R}/member`, H.token, { acct: M2.id, action: "approve", rowId: "r2" });
await sleep(300);
const ml3 = await api("GET", `/api/r/${R}/members`, H.token);
const a1 = ml3.data.list.find((m) => m.acct === M.id), a2 = ml3.data.list.find((m) => m.acct === M2.id);
t("같은 줄에 [받기] → 먼저 있던 사람은 자리 없음(rowId null)", ap2.ok && a1 && a1.rowId === null && a1.st === "ok" && a2 && a2.rowId === "r2", JSON.stringify([a1, a2]));
t("자리를 내준 사람에게 you(rowId null) 통지", app.got.some((m) => m.kind === "you" && m.you && m.you.rowId === null), app.got.map((m) => m.kind).join(","));

/* 앱 닫힘 → 여유 뒤 송출이 내 판으로 */
app.ws.close();
await sleep(1500);
const rs2 = await api("GET", `/api/o/${M.obsToken}/resolve`);
t("끊긴 직후(여유 안)에는 아직 방장 판", rs2.ok && rs2.data.roomId === R, JSON.stringify(rs2));
console.log("... 20초 여유 대기");
await sleep(21000);
const rs3 = await api("GET", `/api/o/${M.obsToken}/resolve`);
t("여유 뒤에는 내 판(RM)", rs3.ok && rs3.data.roomId === RM, JSON.stringify(rs3) + " RM=" + RM);
t("오버레이 소켓이 다시 붙으라는 you:null 을 받는다 (페이지는 이걸 받고 스스로 닫고 주소를 다시 푼다)", ov.got.some((m) => m.kind === "you" && !m.you), ov.got.map((m) => m.kind).join(","));

/* 다시 접속 → 즉시 방장 판 */
const app2 = await openWs(`${WSB}/api/r/${R}/live?s=${M.token}`);
await sleep(600);
const rs4 = await api("GET", `/api/o/${M.obsToken}/resolve`);
t("다시 붙으면 즉시 방장 판", rs4.ok && rs4.data.roomId === R, JSON.stringify(rs4));
app2.ws.close();

/* 내보내기 → 다시 오면 요청부터 (kicked) */
await api("POST", `/api/r/${R}/member`, H.token, { acct: M2.id, action: "remove" });
const j3 = await api("POST", `/api/r/${R}/join`, M2.token, {});
t("내보낸 사람이 다시 오면 req + kicked", j3.ok && j3.data.st === "req" && j3.data.kicked === true, JSON.stringify(j3.data));

console.log(`\n${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
