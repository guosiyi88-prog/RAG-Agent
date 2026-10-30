/**
 * `GET /api/i18n/:lang` 的黑盒验收（`08-i18n-eval-handoff` #01 · `12-i18n.md` §2）。
 *
 * 只在本进程注册 `registerI18nRoutes`，**不**起 `buildApp()`（与 `assets.test.ts` 同一套做法）：
 * 这条路由只读一份 JSON，不碰 PG / Redis / MinIO，也不该为了答一份文案去连数据库。
 * 这样红了就知道是这一条路由的锅，而且测试不需要数据层在场。
 *
 * 两段断言：
 *   ① 五个语种各自 127 条、占位符**未被替换**（替换是前端 `t()` 的事：`引用 {i} / {n}` 原样下发，
 *      前端填数）；未知语种按 400 `VALIDATION` 报错，不静默给英文。
 *   ② 回落链 `请求语言 → en → 原始 key`：喂一张**测试内构造的最小表**直接调 `mergeMessages`，
 *      不改真表也能把这两格钉死（拿真表去造"某语缺某 key"是不可接受的）。
 */
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const LOCALES = ["zh", "en", "de", "nl", "es"] as const;
/** `12-i18n.md` §4 的算式：12+4+23+11+15+18+13+8+6+5+12 = 127（§4.10 拒答话术已移出）。 */
const EXPECTED_TOTAL = 127;

type Messages = Record<string, string>;
type Body = { ok: true; data: { lang: string; messages: Messages } };
type ErrorBody = { ok: false; error: { code: string; message: string; trace_id: string } };

let app: FastifyInstance | undefined;
let mergeMessages: (table: Record<string, Messages>, lang: string) => Messages;

before(async () => {
  const { registerI18nRoutes, mergeMessages: merge } = await import("../src/api/i18n.ts");
  const { toErrorBody } = await import("../src/errors.ts");
  const { default: Fastify } = await import("fastify");
  mergeMessages = merge as unknown as (table: Record<string, Messages>, lang: string) => Messages;

  const instance = Fastify({ logger: false });
  // 与 src/server.ts 同一个错误信封：400 的形状必须是线上那一个，不是测试自己另写的一份。
  instance.setErrorHandler((err, request, reply) => {
    const { status, body } = toErrorBody(err, String(request.id));
    return reply.code(status).send(body);
  });
  await registerI18nRoutes(instance);
  await instance.ready();
  app = instance;
});

after(async () => {
  if (app !== undefined) await app.close();
});

function instance(): FastifyInstance {
  assert.ok(app !== undefined, "app 未初始化");
  return app;
}

async function fetchLang(lang: string): Promise<{ status: number; body: unknown }> {
  const response = await instance().inject({ method: "GET", url: `/api/i18n/${lang}` });
  return { status: response.statusCode, body: response.json() };
}

function asBody(payload: unknown, label: string): Body {
  const body = payload as Body;
  assert.equal(body?.ok, true, `${label} 的 ok 必须是 true，实际 ${JSON.stringify(payload)}`);
  return body;
}

/* ───────────────────────────── 五个语种 ───────────────────────────── */

test("五语各 127 条：key 集合与 zh 完全一致，lang 原样回显", async () => {
  const bodies = new Map<string, Messages>();
  for (const lang of LOCALES) {
    const { status, body } = await fetchLang(lang);
    assert.equal(status, 200, `${lang} 期望 200，实际 ${status}`);
    const payload = asBody(body, lang);
    assert.equal(payload.data.lang, lang, "data.lang 要回显请求的语种（前端据此判断拿没拿到对的表）");
    const keys = Object.keys(payload.data.messages);
    assert.equal(keys.length, EXPECTED_TOTAL, `${lang} 应有 ${EXPECTED_TOTAL} 条，实际 ${keys.length}`);
    bodies.set(lang, payload.data.messages);
  }

  const master = [...Object.keys(bodies.get("zh") ?? {})].sort();
  for (const lang of LOCALES) {
    if (lang === "zh") continue;
    const own = [...Object.keys(bodies.get(lang) ?? {})].sort();
    assert.deepEqual(own, master, `${lang} 的 key 集合必须与 zh 完全一致（合并结果里不该多也不该少）`);
  }
});

test("占位符原样下发：{i} / {n} 不被服务端替换（替换是前端 t() 的事）", async () => {
  const { body } = await fetchLang("de");
  const messages = asBody(body, "de").data.messages;
  assert.equal(messages["cite.title"], "Quelle {i} / {n}");
  assert.equal(messages["cite.page"], "S. {page}");
  assert.ok(String(messages["chat.ticket.created"]).includes("{no}"));
  assert.ok(String(messages["me.version"]).includes("{v}"));
  assert.ok(String(messages["fault.notfound"]).includes("{code}"));
});

test("译文真的是译文：同一句话在五语里不相同，de/nl/es 里没有汉字", async () => {
  const values = new Map<string, string>();
  for (const lang of LOCALES) {
    const { body } = await fetchLang(lang);
    const messages = asBody(body, lang).data.messages;
    assert.equal(messages["chat.send"]?.trim(), messages["chat.send"], "值不该带首尾空白");
    assert.ok(String(messages["chat.send"]).length > 0, "chat.send 不能为空");
    values.set(lang, String(messages["chat.send"]));
  }
  assert.equal(values.get("zh"), "发送");
  assert.equal(values.get("de"), "Senden");
  assert.notEqual(values.get("nl"), values.get("de"), "荷兰语与德语不该是同一串（那就是没翻译）");
  assert.notEqual(values.get("es"), values.get("en"), "西班牙语与英语不该是同一串");

  const cjk = /[\u3400-\u4DBF\u4E00-\u9FFF]/u;
  for (const lang of ["de", "nl", "es"]) {
    const { body } = await fetchLang(lang);
    const messages = asBody(body, lang).data.messages;
    const dirty = Object.entries(messages).filter(([, value]) => cjk.test(String(value))).map(([key]) => key);
    assert.deepEqual(dirty, [], `${lang} 里有汉字残留：${dirty.join(", ")}`);
  }
});

test("下发内容里没有 refusal.* / console.*（拒答话术在 REFUSAL 常量，坐席端不进这张表）", async () => {
  for (const lang of LOCALES) {
    const { body } = await fetchLang(lang);
    const messages = asBody(body, lang).data.messages;
    const forbidden = Object.keys(messages).filter((key) => key.startsWith("refusal.") || key.startsWith("console."));
    assert.deepEqual(forbidden, [], `${lang} 下发了禁止的 key：${forbidden.join(", ")}`);
  }
});

test("这条路由不需要令牌（弱网下要先点亮界面、再拿会话）", async () => {
  const response = await instance().inject({ method: "GET", url: "/api/i18n/de" });
  assert.equal(response.statusCode, 200, "无 x-user-session 也必须是 200，否则页面在拿到令牌前没有文案");
  assert.match(String(response.headers["content-type"] ?? ""), /application\/json/, "响应必须是 JSON");
});

/* ───────────────────────────── 未知语种 ───────────────────────────── */

test("未知语种 → 400 VALIDATION（不静默回落英文）", async () => {
  for (const lang of ["fr", "de-DE", "zh-Hans-CN", "xx", "123"]) {
    const { status, body } = await fetchLang(encodeURIComponent(lang));
    assert.equal(status, 400, `${lang} 期望 400，实际 ${status}`);
    const error = (body as ErrorBody).error;
    assert.equal(error?.code, "VALIDATION", `${lang} 的 error.code 必须是 VALIDATION`);
    assert.ok(String(error?.message).includes("lang"), `${lang} 的 message 要说明是 lang 不合法：${error?.message}`);
    assert.ok(typeof error?.trace_id === "string" && error.trace_id.length > 0, "错误信封必须带 trace_id");
  }
});

test("大小写不敏感：/api/i18n/DE 命中 de 并回显小写", async () => {
  const { status, body } = await fetchLang("DE");
  assert.equal(status, 200);
  assert.equal(asBody(body, "DE").data.lang, "de");
});

/* ───────────────────────────── 回落链（纯函数） ───────────────────────────── */

test("回落链：请求语言 → en → 原始 key", () => {
  // 一张最小表：de 少 `b`，en 只有 `a`，`c` 谁都没有 —— 正好把三层各踩一脚。
  const table: Record<string, Messages> = {
    zh: { a: "甲", b: "乙", c: "丙" },
    en: { a: "A" },
    de: { a: "Aa", b: "Bb" },
  };

  // ① 请求语言有就用请求语言的
  assert.equal(mergeMessages(table, "de").a, "Aa");
  assert.equal(mergeMessages(table, "de").b, "Bb");

  // ② 请求语言缺 → 回落 en（§2 的中间一格）
  const de = mergeMessages(table, "de");
  assert.equal(de.c, "c", "en 也没有时，最后一格是 key 本身（开发期可见）");

  // nl 整门语言缺失 → 全部走 en，en 也没有的就是 key 原文
  const nl = mergeMessages(table, "nl");
  assert.equal(nl.a, "A", "整门语言缺失时回落 en");
  assert.equal(nl.b, "b", "en 里没有这条 → 原始 key");
  assert.equal(nl.c, "c");

  // ③ 请求语言就是 zh：直接读主源，不经过 en
  assert.deepEqual(mergeMessages(table, "zh"), { a: "甲", b: "乙", c: "丙" });

  // 合并结果以 zh 的 key 集合为准：多出来的 key 不下发（避免"表里有、页面没有"变成噪音）
  const extra = { ...table, de: { ...table.de, zombie: "不该出现" } };
  assert.equal(Object.hasOwn(mergeMessages(extra, "de"), "zombie"), false);
});

test("回落链在真表上不产生 key 原文（127 条都有译文）", async () => {
  const { body } = await fetchLang("nl");
  const messages = asBody(body, "nl").data.messages;
  const rawKeys = Object.entries(messages).filter(([key, value]) => key === value).map(([key]) => key);
  assert.deepEqual(rawKeys, [], `这些 key 回落到了 key 原文（说明 en 里也缺）：${rawKeys.join(", ")}`);
});
