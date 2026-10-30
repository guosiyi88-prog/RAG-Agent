import pino from "pino";
import { config } from "./config.ts";

// 日志会被贴进评审记录与工单复盘，所以脱敏放在 logger 一处，而不是指望每个调用点自觉。
// 只记"发生了什么"，不记消息原文与邮箱明文（02-architecture.md §2 的 logger 职责）。
const REDACT_PATHS = [
  "password",
  "*.password",
  "token",
  "*.token",
  "apiKey",
  "*.apiKey",
  "headers.authorization",
  "headers['x-staff-session']",
  "headers['x-internal-token']",
  "req.headers.authorization",
  "req.headers['x-staff-session']",
  "req.headers['x-internal-token']",
  "email",
  "*.email",
  "requester",
  "*.requester",
];

export const logger = pino({
  level: config.nodeEnv === "production" ? "info" : "debug",
  base: { service: "wt-agent", version: config.version },
  redact: { paths: REDACT_PATHS, censor: "[redacted]" },
});

/** 邮箱在进日志前先打码：`installer@example.com` → `i***@e***.com`。 */
export function maskEmail(email: string): string {
  const at = email.indexOf("@");
  if (at <= 0) return "***";
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const dot = domain.lastIndexOf(".");
  const tld = dot > 0 ? domain.slice(dot) : "";
  return `${local.slice(0, 1)}***@${domain.slice(0, 1)}***${tld}`;
}
