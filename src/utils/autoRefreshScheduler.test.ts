import assert from "node:assert/strict";
import test from "node:test";

import {
  getNextAlignedRunAt,
  createAutoRefreshScheduler,
  type AutoRefreshSchedulerTask,
} from "./autoRefreshScheduler.ts";

test("getNextAlignedRunAt aligns to local 00:00:00 across standard intervals", () => {
  // 构造一个固定时间点：2026-09-11 14:23:45.500
  const baseDate = new Date(2026, 8, 11, 14, 23, 45, 500);
  const now = baseDate.getTime();

  // 10 分钟 (600,000 ms) 间隔 -> 下一个对齐时刻应为 14:30:00.000
  const tenMinutesMs = 10 * 60 * 1000;
  const next10m = getNextAlignedRunAt(tenMinutesMs, now);
  const next10mDate = new Date(next10m);
  assert.equal(next10mDate.getHours(), 14);
  assert.equal(next10mDate.getMinutes(), 30);
  assert.equal(next10mDate.getSeconds(), 0);
  assert.equal(next10mDate.getMilliseconds(), 0);

  // 5 分钟 (300,000 ms) 间隔 -> 下一个对齐时刻应为 14:25:00.000
  const fiveMinutesMs = 5 * 60 * 1000;
  const next5m = getNextAlignedRunAt(fiveMinutesMs, now);
  const next5mDate = new Date(next5m);
  assert.equal(next5mDate.getHours(), 14);
  assert.equal(next5mDate.getMinutes(), 25);
  assert.equal(next5mDate.getSeconds(), 0);
  assert.equal(next5mDate.getMilliseconds(), 0);

  // 15 分钟 (900,000 ms) 间隔 -> 下一个对齐时刻应为 14:30:00.000
  const fifteenMinutesMs = 15 * 60 * 1000;
  const next15m = getNextAlignedRunAt(fifteenMinutesMs, now);
  const next15mDate = new Date(next15m);
  assert.equal(next15mDate.getHours(), 14);
  assert.equal(next15mDate.getMinutes(), 30);
  assert.equal(next15mDate.getSeconds(), 0);
  assert.equal(next15mDate.getMilliseconds(), 0);

  // 60 分钟 (3,600,000 ms) 间隔 -> 下一个对齐时刻应为 15:00:00.000
  const oneHourMs = 60 * 60 * 1000;
  const next1h = getNextAlignedRunAt(oneHourMs, now);
  const next1hDate = new Date(next1h);
  assert.equal(next1hDate.getHours(), 15);
  assert.equal(next1hDate.getMinutes(), 0);
  assert.equal(next1hDate.getSeconds(), 0);
  assert.equal(next1hDate.getMilliseconds(), 0);
});

test("getNextAlignedRunAt correctly advances to next cycle when exactly on alignment point", () => {
  // 刚好在 14:30:00.000 整
  const exactDate = new Date(2026, 8, 11, 14, 30, 0, 0);
  const now = exactDate.getTime();
  const tenMinutesMs = 10 * 60 * 1000;

  const next = getNextAlignedRunAt(tenMinutesMs, now);
  const nextDate = new Date(next);
  assert.equal(nextDate.getHours(), 14);
  assert.equal(nextDate.getMinutes(), 40);
  assert.equal(nextDate.getSeconds(), 0);
  assert.equal(nextDate.getMilliseconds(), 0);
});

test("getNextAlignedRunAt aligns across midnight (cross-day)", () => {
  // 23:54:10.000
  const lateDate = new Date(2026, 8, 11, 23, 54, 10, 0);
  const now = lateDate.getTime();
  const tenMinutesMs = 10 * 60 * 1000;

  const next = getNextAlignedRunAt(tenMinutesMs, now);
  const nextDate = new Date(next);
  assert.equal(nextDate.getDate(), 12);
  assert.equal(nextDate.getHours(), 0);
  assert.equal(nextDate.getMinutes(), 0);
  assert.equal(nextDate.getSeconds(), 0);
  assert.equal(nextDate.getMilliseconds(), 0);
});

test("createAutoRefreshScheduler schedules tasks with aligned initial times", () => {
  const tenMinutesMs = 10 * 60 * 1000;
  let executed = false;
  const task: AutoRefreshSchedulerTask = {
    key: "test:codex",
    label: "Codex Refresh",
    intervalMs: tenMinutesMs,
    run: async () => {
      executed = true;
    },
  };

  const scheduler = createAutoRefreshScheduler([task], { tickMs: 1000 });
  assert.ok(scheduler);
  scheduler.stop();
  assert.equal(executed, false);
});
