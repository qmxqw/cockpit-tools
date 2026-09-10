import {
  isCodexApiKeyAccount,
  isCodexAgentIdentityAccount,
  isCodexEffectiveFreePlan,
  isCodexPendingOAuthAccount,
  isCodexWebSessionAccount,
  type CodexAccount,
} from '../types/codex.ts';
import {
  type CodexLocalAccessCustomRoutingRule,
  type CodexLocalAccessRoutingStrategy,
} from '../types/codexLocalAccess.ts';

const CHAT_COMPLETIONS_PROVIDER_HOSTS = [
  "api.deepseek.com",
  "api.moonshot.cn",
  "api.siliconflow.cn",
  "api.siliconflow.com",
  "open.bigmodel.cn",
  "api.z.ai",
  "volces.com",
  "bytepluses.com",
  "qianfan.baidubce.com",
  "dashscope.aliyuncs.com",
  "api.stepfun.com",
  "api.stepfun.ai",
  "modelscope.cn",
  "api.longcat.chat",
  "api.minimax.io",
  "api.mini-max.chat",
  "api.minimaxi.com",
  "api.tbox.cn",
  "api.mimo.dev",
  "api.xiaomimimo.com",
  "token-plan-cn.xiaomimimo.com",
  "api.novita.ai",
  "integrate.api.nvidia.com",
  "runapi.co",
  "www.relaxycode.com",
  "cp.compshare.cn",
  "api.lemondata.cc",
  "e-flowcode.cc",
  "cc-api.pipellm.ai",
  "openrouter.ai",
  "api.therouter.ai",
];

export type CodexLocalAccessAccountIneligibleReason =
  | "chat_completions_api_key"
  | "deepseek_unsupported"
  | "free_restricted"
  | "pending_oauth"
  | "web_session_quota_only";

function isDeepSeekApiServiceAccount(account: CodexAccount): boolean {
  const providerId = (account.api_provider_id || "").trim().toLowerCase();
  if (providerId === "deepseek") {
    return true;
  }
  const baseUrl = (account.api_base_url || "").trim().toLowerCase();
  return baseUrl.includes("api.deepseek.com");
}

export function isCodexChatCompletionsApiKeyAccount(account: CodexAccount): boolean {
  if (!isCodexApiKeyAccount(account)) {
    return false;
  }
  const wireApi = (account.api_wire_api || "").trim();
  if (wireApi === "chat_completions") {
    return true;
  }
  if (wireApi === "responses") {
    return false;
  }
  const baseUrl = (account.api_base_url || "").trim().toLowerCase();
  if (!baseUrl) {
    return false;
  }
  if (baseUrl.includes("/chat/completions")) {
    return true;
  }
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return CHAT_COMPLETIONS_PROVIDER_HOSTS.some((pattern) =>
      host.includes(pattern),
    );
  } catch {
    return false;
  }
}

export function getCodexLocalAccessAccountIneligibleReason(
  account: CodexAccount,
  restrictFreeAccounts: boolean,
): CodexLocalAccessAccountIneligibleReason | null {
  // Pending / incomplete OAuth accounts cannot serve API traffic.
  if (isCodexPendingOAuthAccount(account)) {
    return "pending_oauth";
  }
  // ChatGPT Web Session: quota view only, never join API service.
  if (isCodexWebSessionAccount(account)) {
    return "web_session_quota_only";
  }
  if (isCodexChatCompletionsApiKeyAccount(account)) {
    return "chat_completions_api_key";
  }
  if (isDeepSeekApiServiceAccount(account)) {
    return "deepseek_unsupported";
  }
  if (
    restrictFreeAccounts &&
    !isCodexAgentIdentityAccount(account) &&
    isCodexEffectiveFreePlan(account)
  ) {
    return "free_restricted";
  }
  return null;
}

export function isCodexLocalAccessEligibleAccount(
  account: CodexAccount,
  restrictFreeAccounts: boolean,
): boolean {
  return getCodexLocalAccessAccountIneligibleReason(
    account,
    restrictFreeAccounts,
  ) === null;
}

export function canAddCodexAccountToLocalAccess(
  account: CodexAccount,
  currentAccountIds: ReadonlySet<string>,
  restrictFreeAccounts: boolean,
): boolean {
  return (
    !currentAccountIds.has(account.id) &&
    isCodexLocalAccessEligibleAccount(account, restrictFreeAccounts)
  );
}

export function isCodexOAuthBindingEligibleAccount(
  account: CodexAccount,
): boolean {
  return (
    !isCodexApiKeyAccount(account) &&
    !isCodexAgentIdentityAccount(account) &&
    !isCodexWebSessionAccount(account) &&
    Boolean(account.tokens.refresh_token?.trim())
  );
}

export function filterCodexLocalAccessAccountIds(
  accountIds: string[],
  accounts: CodexAccount[],
  restrictFreeAccounts: boolean,
): string[] {
  const accountById = new Map(accounts.map((account) => [account.id, account]));
  const seen = new Set<string>();
  const next: string[] = [];

  for (const accountId of accountIds) {
    const account = accountById.get(accountId);
    if (!account || !isCodexLocalAccessEligibleAccount(account, restrictFreeAccounts)) {
      continue;
    }
    if (!seen.has(accountId)) {
      seen.add(accountId);
      next.push(accountId);
    }
  }

  return next;
}

export function resolveCodexLocalAccessInitialAccountIds(
  accountIds: string[],
  accounts: CodexAccount[],
  restrictFreeAccounts: boolean,
  accountsLoaded: boolean,
): string[] {
  if (!accountsLoaded) {
    return Array.from(new Set(accountIds));
  }
  return filterCodexLocalAccessAccountIds(
    accountIds,
    accounts,
    restrictFreeAccounts,
  );
}

export function resolveImportedCodexAccountIdsForLocalAccess(
  accounts: CodexAccount[],
  syncAllImportedAccounts: boolean,
  forceAgentIdentityAccounts: boolean,
): string[] {
  const eligible = accounts.filter((account) =>
    isCodexLocalAccessEligibleAccount(account, false),
  );
  if (syncAllImportedAccounts) {
    return eligible.map((account) => account.id);
  }
  if (!forceAgentIdentityAccounts) {
    return [];
  }
  return eligible
    .filter(isCodexAgentIdentityAccount)
    .map((account) => account.id);
}

function normalizePlanKey(planType?: string | null): string {
  const normalized = (planType || "").trim().toLowerCase();
  if (normalized.includes("enterprise")) return "enterprise";
  if (normalized.includes("edu")) return "edu";
  if (normalized.includes("health")) return "health";
  if (normalized.includes("gov")) return "gov";
  if (normalized.includes("teachers")) return "teachers";
  if (normalized.includes("business")) return "business";
  if (normalized.includes("team")) return "team";
  if (normalized.includes("plus")) return "plus";
  if (normalized.includes("pro")) return "pro";
  if (normalized.includes("go")) return "go";
  if (normalized.includes("free")) return "free";
  return normalized;
}

function normalizeAuthFilePlanType(planType?: string | null): string | null {
  if (!planType) return null;
  const normalized = planType.trim().toLowerCase().replace(/[_\s]+/g, "-");
  if (
    normalized === "prolite" ||
    normalized === "pro-lite" ||
    normalized === "pro-5x" ||
    normalized === "codex-pro-5x"
  ) {
    return "prolite";
  }
  if (
    normalized === "promax" ||
    normalized === "pro-max" ||
    normalized === "pro-20x" ||
    normalized === "codex-pro-20x"
  ) {
    return "promax";
  }
  return null;
}

export function resolveCodexPlanRank(account: CodexAccount): number {
  const planKey = normalizePlanKey(account.plan_type);
  const authFilePlanType =
    normalizeAuthFilePlanType(account.auth_file_plan_type) ||
    normalizeAuthFilePlanType(account.plan_type);

  switch (planKey) {
    case "enterprise":
    case "edu":
    case "health":
    case "gov":
    case "teachers":
      return 700;
    case "pro":
      if (authFilePlanType === "promax") return 600;
      if (authFilePlanType === "prolite") return 500;
      return 500;
    case "business":
    case "team":
    case "plus":
      return 300;
    case "go":
      return 200;
    case "free":
      return 100;
    default:
      return 0;
  }
}

export function resolveCodexRemainingQuota(account: CodexAccount): number | null {
  const quota = account.quota;
  if (!quota) return null;
  const percentages: number[] = [];
  if (quota.hourly_window_present ?? true) {
    if (typeof quota.hourly_percentage === "number") {
      percentages.push(Math.max(0, Math.min(100, quota.hourly_percentage)));
    }
  }
  if (quota.weekly_window_present ?? true) {
    if (typeof quota.weekly_percentage === "number") {
      percentages.push(Math.max(0, Math.min(100, quota.weekly_percentage)));
    }
  }
  if (percentages.length === 0) return null;
  const remaining = Math.min(...percentages);
  const hasCredits =
    (quota.reset_credits_available ?? 0) > 0 ||
    ((quota as unknown as { credits_usable?: number }).credits_usable ?? 0) > 0;
  if (remaining === 0 && hasCredits) {
    return 1;
  }
  return remaining;
}

export function resolveCodexSubscriptionExpiryMs(account: CodexAccount): number | null {
  const raw = account.subscription_active_until?.trim();
  if (!raw) return null;
  if (/^\d+$/.test(raw)) {
    let ts = parseInt(raw, 10);
    if (ts < 1_000_000_000_000) {
      ts *= 1000;
    }
    return Number.isFinite(ts) ? ts : null;
  }
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

export function resolveCodexQuotaResetAtMs(account: CodexAccount): number | null {
  const sec = account.quota?.hourly_reset_time;
  if (typeof sec === "number" && sec > 0) {
    return sec * 1000;
  }
  return null;
}

export function resolveCodexEffectiveExpiryMs(account: CodexAccount): number | null {
  if (isCodexEffectiveFreePlan(account)) {
    return resolveCodexQuotaResetAtMs(account);
  }
  return (
    resolveCodexSubscriptionExpiryMs(account) ??
    resolveCodexQuotaResetAtMs(account)
  );
}

export function isCodexAccountQuotaExhausted(account: CodexAccount): boolean {
  const remaining = resolveCodexRemainingQuota(account);
  return remaining === 0;
}

export function resolveCodexAccountUsageTier(
  accountId: string,
  rules?: CodexLocalAccessCustomRoutingRule[],
): number {
  if (!rules || rules.length === 0) return 1;
  const rule = rules.find((r) => r.accountId === accountId);
  if (!rule) return 1;
  if (rule.isPreferred) return 0;
  if (rule.isBackup) return 2;
  return 1;
}

export interface CompareCodexAccountRoutingOptions {
  strategy?: CodexLocalAccessRoutingStrategy;
  customRules?: CodexLocalAccessCustomRoutingRule[];
  leftOriginalIndex?: number;
  rightOriginalIndex?: number;
}

export function compareCodexAccountsByRoutingPriority(
  left: CodexAccount,
  right: CodexAccount,
  options: CompareCodexAccountRoutingOptions = {},
): number {
  const {
    strategy = "auto",
    customRules = [],
    leftOriginalIndex = 0,
    rightOriginalIndex = 0,
  } = options;

  // 0. 额度耗尽隔离：所有额度为 0 的排在最后，非 0 的账号按调度顺序排在前面
  const leftExhausted = isCodexAccountQuotaExhausted(left);
  const rightExhausted = isCodexAccountQuotaExhausted(right);
  if (leftExhausted !== rightExhausted) {
    return leftExhausted ? 1 : -1;
  }

  // 1. 全局层级：首选账号 (0) < 普通账号 (1) < 备用账号 (2)
  const leftTier = resolveCodexAccountUsageTier(left.id, customRules);
  const rightTier = resolveCodexAccountUsageTier(right.id, customRules);
  if (leftTier !== rightTier) {
    return leftTier - rightTier;
  }

  // 2. 自定义策略
  if (strategy === "custom") {
    const leftRule = customRules.find((r) => r.accountId === left.id);
    const rightRule = customRules.find((r) => r.accountId === right.id);
    const leftPriority = leftRule?.priority ?? 10;
    const rightPriority = rightRule?.priority ?? 10;
    if (leftPriority !== rightPriority) {
      return rightPriority - leftPriority; // 优先级高的排在前面
    }
    const leftWeight = leftRule?.weight ?? 1;
    const rightWeight = rightRule?.weight ?? 1;
    if (leftWeight !== rightWeight) {
      return rightWeight - leftWeight; // 权重高的排在前面
    }
    return leftOriginalIndex - rightOriginalIndex;
  }

  // 3. 固定首个账号或随机策略：直接保持原始集合顺序
  if (strategy === "single_account" || strategy === "random") {
    return leftOriginalIndex - rightOriginalIndex;
  }

  // 4. 数值比较辅助函数（降序/升序，支持 null 排序在后）
  const compareDesc = (a: number | null, b: number | null) => {
    if (a !== null && b !== null) return b - a;
    if (a !== null) return -1;
    if (b !== null) return 1;
    return 0;
  };
  const compareAsc = (a: number | null, b: number | null) => {
    if (a !== null && b !== null) return a - b;
    if (a !== null) return -1;
    if (b !== null) return 1;
    return 0;
  };

  const leftPlan = resolveCodexPlanRank(left);
  const rightPlan = resolveCodexPlanRank(right);
  const leftQuota = resolveCodexRemainingQuota(left);
  const rightQuota = resolveCodexRemainingQuota(right);
  const leftReset = resolveCodexQuotaResetAtMs(left);
  const rightReset = resolveCodexQuotaResetAtMs(right);

  let cmp = 0;

  switch (strategy) {
    case "quota_high_first": {
      cmp = compareDesc(leftQuota, rightQuota);
      if (cmp !== 0) return cmp;
      cmp = compareAsc(leftReset, rightReset);
      if (cmp !== 0) return cmp;
      cmp = compareDesc(leftPlan, rightPlan);
      if (cmp !== 0) return cmp;
      break;
    }
    case "quota_low_first": {
      cmp = compareAsc(leftQuota, rightQuota);
      if (cmp !== 0) return cmp;
      cmp = compareAsc(leftReset, rightReset);
      if (cmp !== 0) return cmp;
      cmp = compareDesc(leftPlan, rightPlan);
      if (cmp !== 0) return cmp;
      break;
    }
    case "plan_low_first": {
      cmp = compareAsc(leftPlan, rightPlan);
      if (cmp !== 0) return cmp;
      cmp = compareDesc(leftQuota, rightQuota);
      if (cmp !== 0) return cmp;
      break;
    }
    case "expiry_soon_first": {
      const leftExpiry = resolveCodexEffectiveExpiryMs(left);
      const rightExpiry = resolveCodexEffectiveExpiryMs(right);
      cmp = compareAsc(leftExpiry, rightExpiry);
      if (cmp !== 0) return cmp;
      cmp = compareDesc(leftPlan, rightPlan);
      if (cmp !== 0) return cmp;
      cmp = compareDesc(leftQuota, rightQuota);
      if (cmp !== 0) return cmp;
      break;
    }
    case "plan_high_first":
    case "auto":
    default: {
      cmp = compareDesc(leftPlan, rightPlan);
      if (cmp !== 0) return cmp;
      cmp = compareDesc(leftQuota, rightQuota);
      if (cmp !== 0) return cmp;
      break;
    }
  }

  return leftOriginalIndex - rightOriginalIndex;
}

