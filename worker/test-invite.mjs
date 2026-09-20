// 실행: node --test worker/test-invite.mjs (외부 서버 없이 실제 Room 요청 처리 검증)
import test from "node:test";
import assert from "node:assert/strict";
import { Room } from "./src/index.js";

test("초대: 발급부터 30분, 복사 시 고정, 만료·재발급·기존 멤버", async (t) => {
  let now = Date.UTC(2026, 8, 20, 14, 45);
  t.mock.method(Date, "now", () => now);
  const data = new Map([["owner", "host"], ["roomId", "TESTAA"]]);
  const storage = {
    get: async (key) => structuredClone(data.get(key)),
    put: async (key, value) => data.set(key, structuredClone(value)),
    delete: async (key) => data.delete(key),
    list: async ({ prefix }) => new Map([...data].filter(([key]) => key.startsWith(prefix))),
  };
  const makeRoom = () => {
    const room = Object.create(Room.prototype);
    room.ctx = { storage, getWebSockets: () => [] };
    room.toAccounts = async () => null;
    return room;
  };
  let room = makeRoom();
  const request = async (path, method = "GET", who = "host", body = {}) => {
    const response = await room.fetch(new Request("https://do" + path, {
      method, headers: { "x-acct": who, "x-room": "TESTAA" },
      ...(method === "GET" ? {} : { body: JSON.stringify(body) }),
    }));
    return { status: response.status, ...await response.json() };
  };
  assert.equal((await request("/invite", "POST", "stranger")).status, 403);
  const first = (await request("/invite", "POST")).invite;
  assert.equal(first.issuedAt, now);
  assert.equal(first.exp - first.issuedAt, 30 * 60 * 1000);
  assert.equal(first.armed, true);
  assert.deepEqual(data.get("invite"), first);

  now += 10 * 60 * 1000;
  room = makeRoom(); // 서버 객체가 다시 만들어져도 발급 기록 유지
  assert.deepEqual((await request("/invite")).invite, first);
  assert.deepEqual((await request("/invite-arm", "POST")).invite, first);

  now = first.exp - 1;
  assert.equal((await request("/join", "POST", "member", { j: first.code })).status, 200);
  now = first.exp;
  assert.equal((await request("/join", "POST", "newcomer", { j: first.code })).status, 410);
  assert.equal((await request("/invite")).invite, null);
  assert.equal((await request("/join", "POST", "member")).status, 200);
  assert.deepEqual((await request("/invite-arm", "POST")).invite, first);

  const fresh = (await request("/invite", "POST")).invite;
  assert.notEqual(fresh.code, first.code);
  assert.equal(fresh.issuedAt, now);
  assert.equal(fresh.exp, now + 30 * 60 * 1000);
  assert.equal((await request("/join", "POST", "newcomer", { j: first.code })).status, 403);
  assert.equal((await request("/join", "POST", "newcomer", { j: fresh.code })).status, 200);
});

test("옛 미활성 초대도 처음 활성화한 시각부터 30분", async () => {
  let invite = { code: "TESTCODE", armed: false, exp: 0 };
  const room = Object.create(Room.prototype);
  room.ctx = { storage: {
    get: async (key) => key === "owner" ? "host" : invite,
    put: async (_, value) => { invite = value; },
  } };
  const response = await room.fetch(new Request("https://do/invite-arm", {
    method: "POST", headers: { "x-acct": "host" }, body: "{}",
  }));
  assert.equal(response.status, 200);
  assert.ok(invite.issuedAt > 0);
  assert.equal(invite.exp - invite.issuedAt, 30 * 60 * 1000);
});
