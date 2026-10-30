/**
 * 工具注册表（04#02）：恰好四个业务工具、名字与装配侧一致、实现只经内部 HTTP。
 *
 * 这里只做两件事：
 *   静态 —— 名字表、危险工具名、`tools:[]` 的写法、**不 import 核心模块**（防环）；
 *   行为 —— 用假 `pi` 拿到注册项与 hook，用假的 `fetch` 断言出站请求与降级文案。
 * 不连库、不起服务（`kb_search` 的检索路径不在本文件覆盖范围内，它已有独立用例）。
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/** 与 tests/run-log.test.ts 同一套 .env 解析：`config.ts` 缺键会直接退出进程。 */
async function loadDotEnv(): Promise<Record<string, string>> {
  let raw: string;
  try {
    raw = await readFile(join(repoRoot, ".env"), "utf8");
  } catch {
    return {};
  }
  const env: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
    if (!match) continue;
    const key = match[1] as string;
    const value = (match[2] as string).replace(/\s+#.*$/, "").replace(/^(['"])(.*)\1$/, "$2");
    if (value !== "") env[key] = value;
  }
  return env;
}

const dotenv = await loadDotEnv();
for (const [key, value] of Object.entries(dotenv)) {
  if (process.env[key] === undefined) process.env[key] = value;
}

// .env 灌进 process.env 之后再动态 import：config.ts 在模块求值期就会校验并可能 exit(1)。
const { config } = await import("../src/config.ts");
const { SUPPORT_TOOL_NAMES, supportExtension, toolExecutors, CODE_NOT_FOUND, LOOKUP_FAILED, CREATE_FAILED, TICKET_NOT_FOUND } =
  await import("../src/ext/support.ts");

/* ────────────────────────────── 测试脚手架 ────────────────────────────── */

type RegisteredTool = {
  name: string;
  label: string;
  description: string;
  parameters: { type?: string; properties?: Record<string, unknown>; required?: string[] };
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: unknown,
  ) => Promise<{ content: { type: string; text: string }[]; details: Record<string, unknown> }>;
};

type ToolCallHandler = (event: { toolName: string; input?: Record<string, unknown> }) => Promise<unknown>;

/**
 * 最小假 `pi`：`supportExtension()` 只用 `registerTool` 与 `on` 两个口子，
 * 所以不需要真的 ExtensionAPI，也不需要装配会话（`registerTool` 的真实现会碰资源加载器）。
 */
function fakePi(): { pi: ExtensionAPI; tools: Map<string, RegisteredTool>; hooks: Map<string, ToolCallHandler> } {
  const tools = new Map<string, RegisteredTool>();
  const hooks = new Map<string, ToolCallHandler>();
  const pi = {
    registerTool(tool: RegisteredTool) {
      tools.set(tool.name, tool);
    },
    on(name: string, handler: ToolCallHandler) {
      hooks.set(name, handler);
    },
  } as unknown as ExtensionAPI;
  return { pi, tools, hooks };
}

type FetchCall = { url: string; init: RequestInit };

/** 把 `globalThis.fetch` 换成可编程的假实现。**调用方必须在 finally 里 restore()**。 */
function stubFetch(respond: (call: FetchCall) => Response | Promise<Response>): {
  calls: FetchCall[];
  restore: () => void;
} {
  const original = globalThis.fetch;
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const call: FetchCall = { url: String(input), init: init ?? {} };
    calls.push(call);
    return await respond(call);
  }) as unknown as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

/** 每次 restore 后都断言复原：漏复原会让后续用例（或别的文件）拿到假 fetch。 */
function assertRestored(original: typeof fetch): void {
  assert.equal(globalThis.fetch, original, "globalThis.fetch 必须复原");
}

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const detailOf = (result: { details: Record<string, unknown> }) => result.details;
const textOf = (result: { content: { text: string }[] }): string => result.content[0]?.text ?? "";

/* ────────────────────────────── 静态断言 ────────────────────────────── */

test("SUPPORT_TOOL_NAMES 恰好四个业务工具，且不含读/写/命令/编辑类名字", () => {
  assert.deepEqual(
    [...SUPPORT_TOOL_NAMES],
    ["kb_search", "fault_code_lookup", "ticket_create", "ticket_lookup"],
    "四项且顺序稳定：装配侧 tools:[] 与白名单都读这一份",
  );

  // 04#02 的最后一条验收：不许出现内置的读文件 / 跑命令 / 编辑 / 写文件类工具名。
  const BUILTIN_DANGER = /^(read|write|edit|bash|shell|grep|glob|ls|find|task|web|mcp)/i;
  for (const name of SUPPORT_TOOL_NAMES) {
    assert.equal(BUILTIN_DANGER.test(name), false, `${name} 撞上了内置危险工具名前缀`);
  }
  assert.equal(new Set(SUPPORT_TOOL_NAMES).size, SUPPORT_TOOL_NAMES.length, "名字不许重复");
});

test("装配侧 tools:[] 只引用 SUPPORT_TOOL_NAMES，没有硬编码工具名", async () => {
  const agentText = await readFile(join(repoRoot, "src/core/agent.ts"), "utf8");

  assert.match(
    agentText,
    /tools: \[\.\.\.SUPPORT_TOOL_NAMES\]/,
    "tools 必须是 ...SUPPORT_TOOL_NAMES（改一处漏一处的经典死法）",
  );

  // 反过来查：tools 数组里不许出现字面工具名。改一行就得同时改白名单与注册，不能靠字面量绕过。
  const literalTools = /tools:\s*\[[^\]]*(kb_search|fault_code_lookup|ticket_create|ticket_lookup)[^\]]*\]/;
  assert.equal(literalTools.test(agentText), false, "tools:[] 里出现字面工具名，说明有一份名单分叉了");

  // 白名单的真源必须是 ext/support.ts（agent.ts 只转发导出）。
  assert.match(agentText, /SUPPORT_TOOL_NAMES[\s\S]{0,200}?from "\.\.\/ext\/support\.ts"/);
});

test("注册项齐活：四个工具各有 name / label / description / parameters（静态）", async () => {
  const supportText = await readFile(join(repoRoot, "src/ext/support.ts"), "utf8");

  // 字段顺序照 06 §3.0 的骨架写，所以可以按行做结构断言。
  const registrationShape =
    /name: "([a-z_]+)",\s*\n\s*label: "[^"]+",\s*\n\s*description: "[^"]+",\s*\n\s*parameters: Type\.Object\(/g;
  const registered = [...supportText.matchAll(registrationShape)].map((match) => match[1]);

  assert.deepEqual(
    registered.sort(),
    [...SUPPORT_TOOL_NAMES].sort(),
    "注册的四个工具必须与 SUPPORT_TOOL_NAMES 逐字一致（漏一个不报错，只会静默消失）",
  );
});

test("工具实现不 import 核心模块 / 数据库（防循环依赖，机器可查）", async () => {
  const supportText = await readFile(join(repoRoot, "src/ext/support.ts"), "utf8");

  // 只看 import / export ... from 的模块说明符：注释里提到这些文件名是允许的。
  const specifiers = [...supportText.matchAll(/^\s*(?:import|export)\b[^;\n]*?from\s+["']([^"']+)["']/gm)].map(
    (match) => match[1] as string,
  );
  assert.ok(specifiers.length > 0, "解析不到 import 说明符，断言会变成空转");

  const FORBIDDEN = [/(^|\/)ticket-store(\.ts)?$/, /(^|\/)fault-codes(\.ts)?$/, /(^|\/)db(\.ts)?$/];
  for (const specifier of specifiers) {
    for (const pattern of FORBIDDEN) {
      assert.equal(
        pattern.test(specifier),
        false,
        `ext/support.ts 不许 import ${specifier}：工具经内部 HTTP 回主进程，直连核心模块会造出 agent → ext → core → agent 的环`,
      );
    }
  }
});

/* ───────────────────────────── 行为断言（假 fetch） ───────────────────────────── */

test("fault_code_lookup 命中：含义 + 有序步骤，且出站请求是回环 + 内部令牌", async () => {
  const original = globalThis.fetch;
  const stub = stubFetch(() =>
    jsonResponse({
      ok: true,
      data: {
        found: true,
        code: "E03",
        severity: "warn",
        meaning: "Netzspannung außerhalb des Bereichs",
        actions: ["1. Netzspannung messen", "2. Klemmen prüfen", "3. Zurücksetzen"],
        doc_lang: "de",
      },
    }),
  );

  try {
    const slot = { buffer: undefined, lang: "de" };
    const result = await toolExecutors.fault_code_lookup({ code: "E03" }, slot);

    // 双编号必须被剥掉（词条正文自带 "1." 时不许渲染成 "1. 1."）。
    assert.equal(
      textOf(result),
      "Netzspannung außerhalb des Bereichs\n1. Netzspannung messen\n2. Klemmen prüfen\n3. Zurücksetzen",
    );
    assert.deepEqual(detailOf(result), {
      found: true,
      code: "E03",
      severity: "warn",
      doc_lang: "de",
      actions: ["1. Netzspannung messen", "2. Klemmen prüfen", "3. Zurücksetzen"],
    });

    assert.equal(stub.calls.length, 1);
    const call = stub.calls[0] as FetchCall;
    const url = new URL(call.url);
    assert.equal(url.protocol, "http:", "内部接口只走明文回环");
    assert.equal(url.hostname, "127.0.0.1", "必须走回环（内部接口的第一道门）");
    assert.equal(url.port, String(config.port), "端口取 config.port，不写死");
    assert.equal(url.pathname, "/internal/fault");
    assert.equal(url.searchParams.get("code"), "E03");
    assert.equal(url.searchParams.get("lang"), "de", "语言取会话语言（slot.lang），不是模型猜的");
    assert.equal(url.searchParams.get("product_line"), "balcony");
    assert.equal(call.init.method, "GET");

    const headers = call.init.headers as Record<string, string>;
    assert.equal(headers["X-Internal-Token"], config.internalToken, "第二道门：内部令牌必须带上");
  } finally {
    stub.restore();
    assertRestored(original);
  }
});

test("fault_code_lookup 未命中 → CODE_NOT_FOUND（不是 LOOKUP_FAILED）", async () => {
  const original = globalThis.fetch;
  const stub = stubFetch(() => jsonResponse({ ok: true, data: { found: false, code: "E99" } }));
  try {
    const result = await toolExecutors.fault_code_lookup({ code: "E99" }, { buffer: undefined, lang: "en" });
    assert.equal(textOf(result), CODE_NOT_FOUND);
    assert.deepEqual(detailOf(result), { found: false, code: "E99" });
  } finally {
    stub.restore();
    assertRestored(original);
  }
});

test("fault_code_lookup 请求失败 → LOOKUP_FAILED，绝不抛错", async () => {
  const original = globalThis.fetch;
  const stub = stubFetch(() => Promise.reject(new Error("connect ECONNREFUSED")));
  try {
    const result = await toolExecutors.fault_code_lookup({ code: "E03" }, { buffer: undefined, lang: "en" });
    assert.equal(textOf(result), LOOKUP_FAILED);
    assert.equal(detailOf(result).found, false);
    assert.equal(detailOf(result).code, "E03");
    assert.equal(typeof detailOf(result).error, "string", "失败原因留在 details（日志与排查用），不进正文");
  } finally {
    stub.restore();
    assertRestored(original);
  }
});

test("ticket_create 成功：POST 内部建单，reason 一律不发", async () => {
  const original = globalThis.fetch;
  const stub = stubFetch(() => jsonResponse({ ok: true, data: { no: "WT-2026-0031" } }, 200));
  try {
    const slot = { buffer: undefined, lang: "zh", convId: "conv-1" };
    const result = await toolExecutors.ticket_create(
      { reason: "no_citation", question: "E03 反复出现怎么办", requester: "installer@example.com" },
      slot,
    );

    assert.equal(textOf(result), "已创建工单 WT-2026-0031");
    // 内部接口没回 due_at 时显式给 null：形状固定，模型不会因为字段忽有忽无而编时间。
    assert.deepEqual(detailOf(result), { no: "WT-2026-0031", due_at: null });

    const call = stub.calls[0] as FetchCall;
    const url = new URL(call.url);
    assert.equal(url.hostname, "127.0.0.1");
    assert.equal(url.pathname, "/internal/ticket");
    assert.equal(call.init.method, "POST");
    assert.equal((call.init.headers as Record<string, string>)["X-Internal-Token"], config.internalToken);

    const body = JSON.parse(String(call.init.body)) as Record<string, unknown>;
    assert.deepEqual(body, {
      question: "E03 反复出现怎么办",
      conv_id: "conv-1",
      requester: "installer@example.com",
    });
    // 原因由后端固定写 user_request：模型说它是 no_citation 也不许影响工单原因。
    assert.equal("reason" in body, false, "reason 不许发给内部接口");
  } finally {
    stub.restore();
    assertRestored(original);
  }
});

test("ticket_create 把截止时间透出给模型（工单卡要求单号 + 截止时间）", async () => {
  const original = globalThis.fetch;
  const dueAt = "2026-10-27T11:02:43.000Z";
  const stub = stubFetch(() =>
    jsonResponse({ ok: true, data: { no: "WT-2026-0032", due_at: dueAt, status: "open" } }, 200),
  );
  try {
    const slot = { buffer: undefined, lang: "de", convId: "conv-2" };
    const result = await toolExecutors.ticket_create({ reason: "user_request", question: "Gerät startet nicht mehr" }, slot);
    assert.equal(textOf(result), "已创建工单 WT-2026-0032");
    // 模型据此回答"最迟什么时候联系我"；后端不给时间时它只能编。
    assert.equal((detailOf(result) as { due_at?: unknown }).due_at, dueAt);
  } finally {
    stub.restore();
    assertRestored(original);
  }
});

test("ticket_create 没有会话 id 时不编造 conv_id；requester 缺省或全空白都发 null", async () => {
  for (const requester of [undefined, "   "]) {
    const original = globalThis.fetch;
    const stub = stubFetch(() => jsonResponse({ no: "WT-2026-0032" })); // 也在测"不带 data 外壳"的响应
    try {
      const result = await toolExecutors.ticket_create({ reason: "user_request", question: "需要人工", requester }, {
        buffer: undefined,
        lang: "zh",
      });
      assert.equal(textOf(result), "已创建工单 WT-2026-0032");

      const body = JSON.parse(String((stub.calls[0] as FetchCall).init.body)) as Record<string, unknown>;
      assert.equal("conv_id" in body, false, "没有会话 id 就不带这个字段，绝不编一个假 id");
      assert.equal(body.requester, null, "匿名单显式发 null，让对面看到「没有」而不是「没传」");
    } finally {
      stub.restore();
      assertRestored(original);
    }
  }
});

test("ticket_create 内部接口 5xx → CREATE_FAILED，不抛错", async () => {
  const original = globalThis.fetch;
  const stub = stubFetch(() => jsonResponse({ ok: false, error: { code: "INTERNAL" } }, 500));
  try {
    const result = await toolExecutors.ticket_create({ reason: "low_conf", question: "风机会不会冻住" }, {
      buffer: undefined,
      lang: "zh",
    });
    assert.equal(textOf(result), CREATE_FAILED);
    assert.equal(detailOf(result).no, null);
    assert.equal(typeof detailOf(result).error, "string");
  } finally {
    stub.restore();
    assertRestored(original);
  }
});

test("ticket_lookup 命中：四态翻中文，URL 走 /internal/ticket/<no>", async () => {
  const cases = [
    ["open", "待处理"],
    ["claimed", "处理中"],
    ["escalated", "已升级"],
    ["closed", "已关闭"],
  ] as const;

  for (const [status, chinese] of cases) {
    const original = globalThis.fetch;
    const stub = stubFetch(() => jsonResponse({ found: true, status }));
    try {
      const result = await toolExecutors.ticket_lookup({ no: "WT-2026-0031" }, { buffer: undefined, lang: "zh" });
      assert.equal(textOf(result), `状态：${chinese}`);
      assert.deepEqual(detailOf(result), { found: true, no: "WT-2026-0031", status });

      const call = stub.calls[0] as FetchCall;
      const url = new URL(call.url);
      assert.equal(url.pathname, "/internal/ticket/WT-2026-0031");
      assert.equal(call.init.method, "GET");
      assert.equal((call.init.headers as Record<string, string>)["X-Internal-Token"], config.internalToken);
    } finally {
      stub.restore();
      assertRestored(original);
    }
  }
});

test("ticket_lookup 未找到（200 found:false 与 404 同口径）", async () => {
  for (const respond of [() => jsonResponse({ found: false }), () => jsonResponse({ ok: false }, 404)]) {
    const original = globalThis.fetch;
    const stub = stubFetch(respond);
    try {
      const result = await toolExecutors.ticket_lookup({ no: "WT-2099-9999" }, { buffer: undefined, lang: "zh" });
      assert.equal(textOf(result), TICKET_NOT_FOUND);
      assert.deepEqual(detailOf(result), { found: false, no: "WT-2099-9999" });
    } finally {
      stub.restore();
      assertRestored(original);
    }
  }
});

test("ticket_lookup 请求失败 → LOOKUP_FAILED，不抛错", async () => {
  const original = globalThis.fetch;
  const stub = stubFetch(() => Promise.reject(new Error("socket hang up")));
  try {
    const result = await toolExecutors.ticket_lookup({ no: "WT-2026-0031" }, { buffer: undefined, lang: "zh" });
    assert.equal(textOf(result), LOOKUP_FAILED);
    assert.equal(detailOf(result).found, false);
    assert.equal(typeof detailOf(result).error, "string");
  } finally {
    stub.restore();
    assertRestored(original);
  }
});

/* ────────────────────── 注册与 hook 的行为断言（假 pi） ────────────────────── */

test("supportExtension 注册恰好四个工具，参数 schema 与 06 §3 一致", () => {
  const { pi, tools } = fakePi();
  supportExtension(pi, { buffer: undefined, lang: "en" });

  assert.deepEqual([...tools.keys()].sort(), [...SUPPORT_TOOL_NAMES].sort());

  for (const tool of tools.values()) {
    assert.equal(typeof tool.label, "string");
    assert.ok(tool.label !== "", `${tool.name} 的 label 必填`);
    assert.equal(typeof tool.description, "string");
    assert.ok(tool.description !== "", `${tool.name} 的 description 必填`);
    assert.equal(tool.parameters.type, "object", `${tool.name} 的 parameters 必须是 TypeBox 对象`);
  }

  assert.deepEqual(Object.keys(tools.get("fault_code_lookup")?.parameters.properties ?? {}), ["code"]);
  assert.deepEqual(Object.keys(tools.get("ticket_create")?.parameters.properties ?? {}), [
    "reason",
    "question",
    "requester",
  ]);
  assert.deepEqual(Object.keys(tools.get("ticket_lookup")?.parameters.properties ?? {}), ["no"]);
});

test("注册项的 execute 是五个位置参数，且 signal 真的透给 fetch", async () => {
  const original = globalThis.fetch;
  const stub = stubFetch(() => jsonResponse({ ok: true, data: { found: false, code: "E03" } }));
  try {
    const { pi, tools } = fakePi();
    supportExtension(pi, { buffer: undefined, lang: "de" });
    const tool = tools.get("fault_code_lookup") as RegisteredTool;

    const controller = new AbortController();
    // 五个位置参数：第 2 个是已校验参数、第 3 个是取消信号。写成 (input, ctx) 的话
    // params 会拿到 toolCallId，这里会立刻失败。
    await tool.execute("call-1", { code: "E03" }, controller.signal, undefined, undefined);

    assert.equal(stub.calls.length, 1);
    assert.equal(new URL((stub.calls[0] as FetchCall).url).searchParams.get("lang"), "de", "lang 来自 slot");

    const forwarded = (stub.calls[0] as FetchCall).init.signal as AbortSignal;
    assert.equal(forwarded.aborted, false);
    controller.abort();
    assert.equal(forwarded.aborted, true, "工具入参的 signal 必须传到 fetch（取消要真的停掉内部请求）");
  } finally {
    stub.restore();
    assertRestored(original);
  }
});

test("tool_call hook：白名单 fail-closed + 两条参数校验", async () => {
  const { pi, hooks } = fakePi();
  supportExtension(pi, { buffer: undefined, lang: "en" });
  const handler = hooks.get("tool_call") as ToolCallHandler;
  assert.equal(typeof handler, "function", "tool_call hook 必须注册");

  // 白名单之外一律阻断（read/bash 这些根本不该存在）。
  for (const name of ["read", "bash", "edit", "write", "web_search"]) {
    assert.deepEqual(await handler({ toolName: name, input: {} }), {
      block: true,
      reason: "tool_not_allowed",
    });
  }

  // 名单内且参数合法 → 放行（undefined 表示"不拦"）。
  assert.equal(await handler({ toolName: "kb_search", input: { query: "E03" } }), undefined);
  assert.equal(
    await handler({ toolName: "fault_code_lookup", input: { code: "E03" } }),
    undefined,
  );
  assert.equal(
    await handler({ toolName: "ticket_create", input: { question: "E03 反复出现" } }),
    undefined,
  );

  // 全空格满足 schema 的 minLength 4，但没有任何信息 → 门口挡掉，别白烧一次内部调用。
  for (const question of ["   ", "abc", ""]) {
    assert.deepEqual(await handler({ toolName: "ticket_create", input: { question } }), {
      block: true,
      reason: "question_too_short",
    });
  }

  // 故障码先校验形状再放行（`e3333`、`E`、`E0333`、空串都不行）。
  for (const code of ["e3333", "E", "E0333", "", "03", "E03x"]) {
    assert.deepEqual(await handler({ toolName: "fault_code_lookup", input: { code } }), {
      block: true,
      reason: "bad_code",
    });
  }
});

test("support.ts 里没有 try/catch 包住 hook 本体（抛出必须保持 fail-closed）", async () => {
  const supportText = await readFile(join(repoRoot, "src/ext/support.ts"), "utf8");
  // 结构断言：从 tool_call 的注册处到 tool_result 的注册处之间不许出现 catch。
  const start = supportText.indexOf('pi.on("tool_call"');
  const end = supportText.indexOf('pi.on("tool_result"');
  assert.ok(start > 0 && end > start, "找不到两个 hook 的注册位置");
  const hookBody = supportText.slice(start, end);
  assert.equal(/catch\s*[({]/.test(hookBody), false, "hook 里吞异常等于把 fail-closed 改成 fail-open");
});
