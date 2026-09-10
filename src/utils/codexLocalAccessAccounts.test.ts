import assert from "node:assert/strict";
import test from "node:test";

import {
  compareCodexAccountsByRoutingPriority,
  resolveCodexPlanRank,
} from "./codexLocalAccessAccounts.ts";
import type { CodexAccount } from "../types/codex.ts";
import type { CodexLocalAccessCustomRoutingRule } from "../types/codexLocalAccess.ts";

const createMockAccount = (
  id: string,
  overrides: Partial<CodexAccount> = {},
): CodexAccount =>
  ({
    id,
    auth_mode: "oauth",
    plan_type: "plus",
    ...overrides,
  }) as CodexAccount;

test("resolveCodexPlanRank correctly ranks tiers", () => {
  assert.equal(resolveCodexPlanRank(createMockAccount("1", { plan_type: "enterprise" })), 700);
  assert.equal(resolveCodexPlanRank(createMockAccount("2", { plan_type: "edu" })), 700);
  assert.equal(
    resolveCodexPlanRank(createMockAccount("3", { plan_type: "pro", auth_file_plan_type: "promax" })),
    600,
  );
  assert.equal(
    resolveCodexPlanRank(createMockAccount("4", { plan_type: "pro", auth_file_plan_type: "prolite" })),
    500,
  );
  assert.equal(resolveCodexPlanRank(createMockAccount("5", { plan_type: "team" })), 300);
  assert.equal(resolveCodexPlanRank(createMockAccount("6", { plan_type: "plus" })), 300);
  assert.equal(resolveCodexPlanRank(createMockAccount("7", { plan_type: "go" })), 200);
  assert.equal(resolveCodexPlanRank(createMockAccount("8", { plan_type: "free" })), 100);
});

test("Preferred account comes first and Backup account comes last regardless of strategy", () => {
  const acc1 = createMockAccount("acc-1", { plan_type: "free" });
  const acc2 = createMockAccount("acc-2", { plan_type: "pro" });
  const acc3 = createMockAccount("acc-3", { plan_type: "team" });

  const customRules: CodexLocalAccessCustomRoutingRule[] = [
    { accountId: "acc-1", priority: 10, weight: 1, isBackup: false, isPreferred: true },
    { accountId: "acc-2", priority: 10, weight: 1, isBackup: true, isPreferred: false },
    { accountId: "acc-3", priority: 10, weight: 1, isBackup: false, isPreferred: false },
  ];

  const sorted = [acc2, acc1, acc3].sort((left, right) =>
    compareCodexAccountsByRoutingPriority(left, right, {
      strategy: "auto",
      customRules,
    }),
  );

  assert.deepEqual(
    sorted.map((a) => a.id),
    ["acc-1", "acc-3", "acc-2"],
  );
});

test("quota_high_first: sorts high quota first, and on tie sorts earlier quota reset first", () => {
  const acc1 = createMockAccount("acc-1", {
    quota: {
      hourly_percentage: 80,
      weekly_percentage: 80,
      hourly_reset_time: 1700002000,
    } as any,
  });
  const acc2 = createMockAccount("acc-2", {
    quota: {
      hourly_percentage: 100,
      weekly_percentage: 100,
      hourly_reset_time: 1700003000,
    } as any,
  });
  const acc3 = createMockAccount("acc-3", {
    quota: {
      hourly_percentage: 100,
      weekly_percentage: 100,
      hourly_reset_time: 1700001000, // Same quota as acc2, but earlier reset
    } as any,
  });

  const sorted = [acc1, acc2, acc3].sort((left, right) =>
    compareCodexAccountsByRoutingPriority(left, right, {
      strategy: "quota_high_first",
    }),
  );

  assert.deepEqual(
    sorted.map((a) => a.id),
    ["acc-3", "acc-2", "acc-1"],
  );
});

test("quota_low_first: sorts low quota first, and on tie sorts earlier quota reset first", () => {
  const acc1 = createMockAccount("acc-1", {
    quota: {
      hourly_percentage: 50,
      weekly_percentage: 50,
      hourly_reset_time: 1700002000,
    } as any,
  });
  const acc2 = createMockAccount("acc-2", {
    quota: {
      hourly_percentage: 10,
      weekly_percentage: 10,
      hourly_reset_time: 1700003000,
    } as any,
  });
  const acc3 = createMockAccount("acc-3", {
    quota: {
      hourly_percentage: 10,
      weekly_percentage: 10,
      hourly_reset_time: 1700001000, // Same quota as acc2, earlier reset
    } as any,
  });

  const sorted = [acc1, acc2, acc3].sort((left, right) =>
    compareCodexAccountsByRoutingPriority(left, right, {
      strategy: "quota_low_first",
    }),
  );

  assert.deepEqual(
    sorted.map((a) => a.id),
    ["acc-3", "acc-2", "acc-1"],
  );
});

test("expiry_soon_first: sorts by effective expiry ascending", () => {
  const accPaidFar = createMockAccount("paid-far", {
    plan_type: "pro",
    subscription_active_until: "2026-10-01T00:00:00Z",
  });
  const accPaidSoon = createMockAccount("paid-soon", {
    plan_type: "pro",
    subscription_active_until: "2026-09-15T00:00:00Z",
  });
  const accFree = createMockAccount("free-account", {
    plan_type: "free",
    quota: {
      hourly_reset_time: Math.floor(new Date("2026-09-11T00:00:00Z").getTime() / 1000),
    } as any,
  });

  const sorted = [accPaidFar, accPaidSoon, accFree].sort((left, right) =>
    compareCodexAccountsByRoutingPriority(left, right, {
      strategy: "expiry_soon_first",
    }),
  );

  assert.deepEqual(
    sorted.map((a) => a.id),
    ["free-account", "paid-soon", "paid-far"],
  );
});

test("custom strategy sorts by priority descending then weight descending", () => {
  const acc1 = createMockAccount("acc-1");
  const acc2 = createMockAccount("acc-2");
  const acc3 = createMockAccount("acc-3");

  const customRules: CodexLocalAccessCustomRoutingRule[] = [
    { accountId: "acc-1", priority: 10, weight: 1, isBackup: false, isPreferred: false },
    { accountId: "acc-2", priority: 20, weight: 1, isBackup: false, isPreferred: false },
    { accountId: "acc-3", priority: 20, weight: 5, isBackup: false, isPreferred: false },
  ];

  const sorted = [acc1, acc2, acc3].sort((left, right) =>
    compareCodexAccountsByRoutingPriority(left, right, {
      strategy: "custom",
      customRules,
    }),
  );

  assert.deepEqual(
    sorted.map((a) => a.id),
    ["acc-3", "acc-2", "acc-1"],
  );
});

test("quota_low_first puts 0% quota accounts at the very end, non-zero accounts sorted by low quota", () => {
  const accZero1 = createMockAccount("zero-1", {
    quota: { hourly_percentage: 0, weekly_percentage: 0, hourly_reset_time: 1700003000 } as any,
  });
  const accZero2 = createMockAccount("zero-2", {
    quota: { hourly_percentage: 0, weekly_percentage: 0, hourly_reset_time: 1700001000 } as any,
  });
  const accLow = createMockAccount("low-10pct", {
    quota: { hourly_percentage: 10, weekly_percentage: 10, hourly_reset_time: 1700002000 } as any,
  });
  const accHigh = createMockAccount("high-80pct", {
    quota: { hourly_percentage: 80, weekly_percentage: 80, hourly_reset_time: 1700002000 } as any,
  });

  const sorted = [accZero1, accHigh, accZero2, accLow].sort((left, right) =>
    compareCodexAccountsByRoutingPriority(left, right, {
      strategy: "quota_low_first",
    }),
  );

  // 非 0 账号优先（10% < 80%），0% 账号排在最后（同为 0% 时较早重置的 zero-2 靠前）
  assert.deepEqual(
    sorted.map((a) => a.id),
    ["low-10pct", "high-80pct", "zero-2", "zero-1"],
  );
});

test("0% quota account is placed behind non-zero accounts even if marked preferred", () => {
  const accZeroPreferred = createMockAccount("zero-preferred", {
    quota: { hourly_percentage: 0, weekly_percentage: 0 } as any,
  });
  const accNormalNonZero = createMockAccount("normal-nonzero", {
    quota: { hourly_percentage: 50, weekly_percentage: 50 } as any,
  });

  const customRules: CodexLocalAccessCustomRoutingRule[] = [
    { accountId: "zero-preferred", priority: 10, weight: 1, isBackup: false, isPreferred: true },
    { accountId: "normal-nonzero", priority: 10, weight: 1, isBackup: false, isPreferred: false },
  ];

  const sorted = [accZeroPreferred, accNormalNonZero].sort((left, right) =>
    compareCodexAccountsByRoutingPriority(left, right, {
      strategy: "auto",
      customRules,
    }),
  );

  assert.deepEqual(
    sorted.map((a) => a.id),
    ["normal-nonzero", "zero-preferred"],
  );
});

