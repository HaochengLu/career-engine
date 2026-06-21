import { config } from "../config.js";
import type { Tier } from "../types.js";

export interface QuotaDecision {
  allowed: boolean;
  used: number;
  limit: number;
  remaining: number;
  mode: "off" | "redis" | "memory" | "durable_object";
  key?: string;
  reason?: string;
}

const memoryCounters = new Map<string, number>();

function dayKey(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: config.quota.timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function quotaKey(): string {
  return `quota:report:${dayKey()}`;
}

function redisConfigured(): boolean {
  return Boolean(config.quota.redisRestUrl && config.quota.redisRestToken);
}

async function redisCommand<T>(command: string, ...args: string[]): Promise<T> {
  const base = config.quota.redisRestUrl.replace(/\/+$/, "");
  const path = [command, ...args].map(encodeURIComponent).join("/");
  const res = await fetch(`${base}/${path}`, {
    headers: { Authorization: `Bearer ${config.quota.redisRestToken}` },
  });
  if (!res.ok) throw new Error(`Redis quota command failed: ${res.status}`);
  const data = (await res.json()) as { result: T };
  return data.result;
}

async function reserveWithRedis(key: string, limit: number): Promise<QuotaDecision> {
  const used = Number(await redisCommand<number>("incr", key));
  if (used === 1) {
    // Keep the counter long enough to survive timezone/day-boundary skew.
    try {
      await redisCommand<number>("expire", key, String(60 * 60 * 36));
    } catch (e) {
      console.error("[quota] Redis 过期时间设置失败：", e instanceof Error ? e.message : e);
    }
  }
  const cappedUsed = Math.min(used, limit);
  return {
    allowed: used <= limit,
    used: cappedUsed,
    limit,
    remaining: Math.max(0, limit - cappedUsed),
    mode: "redis",
    key,
    reason: used <= limit ? undefined : "今日生成名额已用完。",
  };
}

function reserveWithMemory(key: string, limit: number): QuotaDecision {
  const used = (memoryCounters.get(key) ?? 0) + 1;
  memoryCounters.set(key, used);
  const cappedUsed = Math.min(used, limit);
  return {
    allowed: used <= limit,
    used: cappedUsed,
    limit,
    remaining: Math.max(0, limit - cappedUsed),
    mode: "memory",
    key,
    reason: used <= limit ? undefined : "今日生成名额已用完。",
  };
}

async function refundWithRedis(key: string, limit: number): Promise<QuotaDecision> {
  const used = Number(await redisCommand<number>("decr", key));
  if (used < 0) {
    try {
      await redisCommand<unknown>("set", key, "0");
    } catch (e) {
      console.error("[quota] Redis 退款归零失败：", e instanceof Error ? e.message : e);
    }
  }
  return usageFromCount(Math.max(0, used), limit, "redis", key);
}

function refundWithMemory(key: string, limit: number): QuotaDecision {
  const used = Math.max(0, (memoryCounters.get(key) ?? 0) - 1);
  memoryCounters.set(key, used);
  return usageFromCount(used, limit, "memory", key);
}

function usageFromCount(usedRaw: number, limit: number, mode: QuotaDecision["mode"], key: string): QuotaDecision {
  const used = Math.max(0, Math.floor(usedRaw || 0));
  const cappedUsed = Math.min(used, limit);
  return {
    allowed: used < limit,
    used: cappedUsed,
    limit,
    remaining: Math.max(0, limit - cappedUsed),
    mode,
    key,
    reason: used < limit ? undefined : "今日生成名额已用完。",
  };
}

async function usageWithRedis(key: string, limit: number): Promise<QuotaDecision> {
  const used = Number((await redisCommand<number | null>("get", key)) ?? 0);
  return usageFromCount(used, limit, "redis", key);
}

function usageWithMemory(key: string, limit: number): QuotaDecision {
  return usageFromCount(memoryCounters.get(key) ?? 0, limit, "memory", key);
}

export async function reserveReportQuota(tier: Tier): Promise<QuotaDecision> {
  void tier;

  const limit = Math.floor(config.quota.dailyLimit);
  if (!Number.isFinite(limit) || limit <= 0) {
    return { allowed: true, used: 0, limit: 0, remaining: 0, mode: "off" };
  }

  const key = quotaKey();
  if (!redisConfigured()) return reserveWithMemory(key, limit);

  try {
    return await reserveWithRedis(key, limit);
  } catch (e) {
    console.error("[quota] Redis 计数失败，降级为内存计数：", e instanceof Error ? e.message : e);
    return reserveWithMemory(key, limit);
  }
}

export async function getReportQuotaUsage(): Promise<QuotaDecision> {
  const limit = Math.floor(config.quota.dailyLimit);
  if (!Number.isFinite(limit) || limit <= 0) {
    return { allowed: true, used: 0, limit: 0, remaining: 0, mode: "off" };
  }

  const key = quotaKey();
  if (!redisConfigured()) return usageWithMemory(key, limit);

  try {
    return await usageWithRedis(key, limit);
  } catch (e) {
    console.error("[quota] Redis 查询失败，降级为内存计数：", e instanceof Error ? e.message : e);
    return usageWithMemory(key, limit);
  }
}

export async function refundReportQuota(): Promise<QuotaDecision> {
  const limit = Math.floor(config.quota.dailyLimit);
  if (!Number.isFinite(limit) || limit <= 0) {
    return { allowed: true, used: 0, limit: 0, remaining: 0, mode: "off" };
  }

  const key = quotaKey();
  if (!redisConfigured()) return refundWithMemory(key, limit);

  try {
    return await refundWithRedis(key, limit);
  } catch (e) {
    console.error("[quota] Redis 退回计数失败，降级为内存计数：", e instanceof Error ? e.message : e);
    return refundWithMemory(key, limit);
  }
}
