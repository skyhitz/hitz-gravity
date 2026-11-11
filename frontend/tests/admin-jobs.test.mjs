// Operator jobs: rows inserted into D1 by hand, run one at a time by the
// cron. There is no HTTP route that queues or runs one.

import assert from "node:assert/strict";
import { test } from "node:test";
import { runNextJob } from "../functions/_lib/admin-jobs.ts";
import { testDb } from "./helpers/d1.mjs";

const NOW = new Date("2026-11-11T00:00:00.000Z");
const queue = (db, command) =>
  Number(db.raw.prepare("INSERT INTO admin_jobs (command) VALUES (?)").run(typeof command === "string" ? command : JSON.stringify(command)).lastInsertRowid);
const job = (db, id) => ({ ...db.raw.prepare("SELECT * FROM admin_jobs WHERE id = ?").get(id) });

test("with nothing queued, nothing runs", async () => {
  let ran = 0;
  assert.equal(await runNextJob(testDb(), { ping: async () => ++ran }, NOW), null);
  assert.equal(ran, 0);
});

test("a queued job runs and its result is stored", async () => {
  const db = testDb();
  const id = queue(db, { type: "ping", n: 2 });
  const outcome = await runNextJob(db, { ping: async (command) => ({ pong: command.n * 2 }) }, NOW);
  assert.deepEqual(outcome, { id, type: "ping", status: "done" });
  const row = job(db, id);
  assert.equal(row.status, "done");
  assert.deepEqual(JSON.parse(row.result), { pong: 4 });
  assert.equal(row.started_at, NOW.toISOString());
  assert.ok(row.finished_at);
});

test("jobs run one per call, oldest first", async () => {
  const db = testDb();
  const first = queue(db, { type: "ping", n: 1 });
  const second = queue(db, { type: "ping", n: 2 });
  const seen = [];
  const handlers = { ping: async (c) => seen.push(c.n) };
  assert.equal((await runNextJob(db, handlers, NOW)).id, first);
  assert.deepEqual(seen, [1]);
  assert.equal(job(db, second).status, "pending");
  assert.equal((await runNextJob(db, handlers, NOW)).id, second);
  assert.deepEqual(seen, [1, 2]);
});

test("a finished job never runs again", async () => {
  const db = testDb();
  queue(db, { type: "ping" });
  let ran = 0;
  const handlers = { ping: async () => ++ran };
  await runNextJob(db, handlers, NOW);
  assert.equal(await runNextJob(db, handlers, NOW), null);
  assert.equal(ran, 1);
});

test("a job whose handler throws is marked failed, with the error", async () => {
  const db = testDb();
  const id = queue(db, { type: "boom" });
  const outcome = await runNextJob(db, { boom: async () => { throw new Error("no funds"); } }, NOW);
  assert.equal(outcome.status, "failed");
  assert.equal(job(db, id).status, "failed");
  assert.deepEqual(JSON.parse(job(db, id).result), { error: "no funds" });
});

test("an unknown command fails without running anything", async () => {
  const db = testDb();
  const id = queue(db, { type: "transfer-everything" });
  let ran = 0;
  assert.equal((await runNextJob(db, { ping: async () => ++ran }, NOW)).status, "failed");
  assert.equal(ran, 0);
  assert.match(JSON.parse(job(db, id).result).error, /unknown/);
});

test("a command that is not a JSON object with a type fails", async () => {
  const db = testDb();
  const a = queue(db, "{oops");
  const b = queue(db, JSON.stringify(["ping"]));
  assert.equal((await runNextJob(db, { ping: async () => 1 }, NOW)).status, "failed");
  assert.equal((await runNextJob(db, { ping: async () => 1 }, NOW)).status, "failed");
  assert.equal(job(db, a).status, "failed");
  assert.equal(job(db, b).status, "failed");
});

test("nothing starts while an earlier job is still marked running", async () => {
  const db = testDb();
  const stuck = queue(db, { type: "ping" });
  db.raw.prepare("UPDATE admin_jobs SET status = 'running' WHERE id = ?").run(stuck);
  const waiting = queue(db, { type: "ping" });
  let ran = 0;
  assert.equal(await runNextJob(db, { ping: async () => ++ran }, NOW), null);
  assert.equal(ran, 0);
  assert.equal(job(db, waiting).status, "pending");
});

test("big integers in a result are stored as strings", async () => {
  const db = testDb();
  const id = queue(db, { type: "ping" });
  await runNextJob(db, { ping: async () => ({ stroops: 10_000_000n }) }, NOW);
  assert.deepEqual(JSON.parse(job(db, id).result), { stroops: "10000000" });
});
