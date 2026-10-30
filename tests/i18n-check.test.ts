/**
 * 五语文案校验脚本的黑盒验收（`08-i18n-eval-handoff` #01 · spec 08「Testing Decisions」）。
 *
 * 只走**子进程 + 真实参数 + 真实退出码**：`scripts/check-i18n.ts` 是交付物的一部分，
 * 用户会怎么跑它（`npm run i18n:check` / `node scripts/check-i18n.ts`），这里就怎么跑它。
 * 断言的是"退出码 + `[fail]` 行的存在与指向"，不解析完整输出格式 —— 排版会改，语义不该改。
 *
 * **绝不动真表**：所有反向用例都把 `src/static/i18n.json` 复制到 `os.tmpdir()` 再改副本，
 * 用 `--file` 指过去。为了测试去改真文件是所有做法里最糟的一种：测试失败时仓库已被破坏，
 * 并行跑测试时还会互相污染。最后一条用例专门验这一点（真表字节没变）。
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const REAL_TABLE = join(repoRoot, "src", "static", "i18n.json");
const SCRIPT = join(repoRoot, "scripts", "check-i18n.ts");

/** 真表原文：开头记一份，末尾比对，证明整组反向用例没碰到它。 */
const realTableBefore = await readFile(REAL_TABLE, "utf8");

type Table = Record<string, Record<string, string>>;

let workDir = "";
/** 每个反向用例一个文件名：并行/重跑时互不覆盖，读失败时也能从路径看出是谁。 */
let seq = 0;

before(async () => {
  // 前缀带 "wt-i18n-" 与本仓库其他临时产物的命名习惯一致（并发跑测试时便于认领）
  workDir = await mkdtemp(join(tmpdir(), "wt-i18n-"));
});

after(async () => {
  if (workDir !== "") await rm(workDir, { recursive: true, force: true });
});

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** 跑脚本。`file === undefined` 时走默认路径（= 真表），这正是"全绿"那条用例。 */
function runCheck(file?: string): Promise<RunResult> {
  const args = [SCRIPT, ...(file === undefined ? [] : ["--file", file])];
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, args, { cwd: repoRoot });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", rejectPromise);
    child.on("close", (code) => resolvePromise({ code: code ?? -1, stdout, stderr }));
  });
}

/** 把真表复制到临时目录、按 `mutate` 改完再落盘，返回副本路径。真表只读不写。 */
async function mutateCopy(mutate: (table: Table) => void): Promise<string> {
  const table = JSON.parse(realTableBefore) as Table;
  mutate(table);
  seq += 1;
  const file = join(workDir, `i18n-${seq}.json`);
  await writeFile(file, `${JSON.stringify(table, null, 2)}\n`, "utf8");
  return file;
}

/** `[fail] <lang> <key>` 这一行必须出现：失败行要指出**语种 + key + 原因**（12-i18n.md §6.1）。 */
function hasFailLine(stdout: string, lang: string, key: string): boolean {
  return stdout
    .split("\n")
    .some((line) => line.startsWith("[fail]") && line.includes(lang) && line.includes(key));
}

/* ───────────────────────────── 正例：真表 ───────────────────────────── */

test("真表：五条断言全绿，退出码 0", async () => {
  const result = await runCheck();
  assert.equal(result.code, 0, `期望退出码 0，实际 ${result.code}\n${result.stdout}\n${result.stderr}`);
  // §6.1 的输出形状：`[ok]   keys: 127/127`（标签列有补齐，所以用正则吃掉空白）
  assert.match(result.stdout, /\[ok\]\s+keys\s+127\/127/, "必须打出一行 keys 127/127");
  assert.match(result.stdout, /\[ok\]\s+cjk/, "de/nl/es 无 CJK 这条要有一行结论");
  assert.ok(!result.stdout.includes("[fail]"), `真表不该出现 [fail] 行：${result.stdout}`);
});

test("脚本自己会在报告末尾写出验的是哪一份文件（--file 的副本尤其要看得出）", async () => {
  const file = await mutateCopy(() => {});
  const result = await runCheck(file);
  assert.equal(result.code, 0);
  assert.ok(result.stdout.includes(file), `输出必须点名被验的文件路径，实际：${result.stdout}`);
});

/* ───────────────────────────── 反例：每一类都退出 1 ───────────────────────────── */

test("反例 a：删掉一条德语 key → 退出 1，并指出 de 与那个 key", async () => {
  const file = await mutateCopy((table) => {
    delete table.de["chat.send"];
  });
  const result = await runCheck(file);
  assert.equal(result.code, 1, `期望退出码 1，实际 ${result.code}\n${result.stdout}`);
  assert.ok(hasFailLine(result.stdout, "de", "chat.send"), `缺少 de / chat.send 的失败行：\n${result.stdout}`);
});

test("反例 b：德语里塞一个汉字 → 退出 1，并指出该 key 与 CJK", async () => {
  const file = await mutateCopy((table) => {
    table.de["common.ok"] = "确定";
  });
  const result = await runCheck(file);
  assert.equal(result.code, 1, `期望退出码 1，实际 ${result.code}\n${result.stdout}`);
  assert.ok(hasFailLine(result.stdout, "de", "common.ok"), `缺少 de / common.ok 的失败行：\n${result.stdout}`);
  assert.match(result.stdout, /CJK/, "失败行要说明原因是 CJK 残留");
});

test("反例 c：荷兰语 cite.title 少一个 {n} → 退出 1，并指出缺的是哪个占位符", async () => {
  const file = await mutateCopy((table) => {
    table.nl["cite.title"] = "Bron {i}";
  });
  const result = await runCheck(file);
  assert.equal(result.code, 1, `期望退出码 1，实际 ${result.code}\n${result.stdout}`);
  assert.ok(hasFailLine(result.stdout, "nl", "cite.title"), `缺少 nl / cite.title 的失败行：\n${result.stdout}`);
  assert.match(result.stdout, /\{n\}/, "失败行要指出少的是 {n}");
});

test("反例 d：往副本里加 refusal.* → 退出 1（拒答话术只有一个真源）", async () => {
  const file = await mutateCopy((table) => {
    for (const lang of Object.keys(table)) table[lang]["refusal.zh"] = "抱歉，这个问题我答不了";
  });
  const result = await runCheck(file);
  assert.equal(result.code, 1, `期望退出码 1，实际 ${result.code}\n${result.stdout}`);
  assert.ok(hasFailLine(result.stdout, "zh", "refusal.zh"), `缺少 zh / refusal.zh 的失败行：\n${result.stdout}`);
  assert.match(result.stdout, /REFUSAL/, "失败行要说明真源在 src/core/refusal.ts 的 REFUSAL 常量");
});

test("反例 e：加 console.* → 退出 1（坐席端只做中文，不进用户端文案表）", async () => {
  const file = await mutateCopy((table) => {
    for (const lang of Object.keys(table)) table[lang]["console.queue.title"] = "队列";
  });
  const result = await runCheck(file);
  assert.equal(result.code, 1, `期望退出码 1，实际 ${result.code}\n${result.stdout}`);
  assert.ok(hasFailLine(result.stdout, "zh", "console.queue.title"), `缺少 console.queue.title 的失败行：\n${result.stdout}`);
});

test("反例 f：整门语言缺失 → 退出 1，而不是静默只验四门", async () => {
  const file = await mutateCopy((table) => {
    delete table.es;
  });
  const result = await runCheck(file);
  assert.equal(result.code, 1, `期望退出码 1，实际 ${result.code}\n${result.stdout}`);
  assert.ok(hasFailLine(result.stdout, "es", "es"), `缺少指名 es 的失败行：\n${result.stdout}`);
});

test("反例 g：空值也算失败（空白比 key 原文更难查）", async () => {
  const file = await mutateCopy((table) => {
    table.en["chat.send"] = "   ";
  });
  const result = await runCheck(file);
  assert.equal(result.code, 1, `期望退出码 1，实际 ${result.code}\n${result.stdout}`);
  assert.ok(hasFailLine(result.stdout, "en", "chat.send"), `缺少 en / chat.send 的失败行：\n${result.stdout}`);
});

test("参数与文件：路径不存在时退出 1，错误进 stderr（不装作全绿）", async () => {
  const result = await runCheck(join(workDir, "does-not-exist.json"));
  assert.equal(result.code, 1, `期望退出码 1，实际 ${result.code}`);
  assert.match(result.stderr, /文案校验失败/, `stderr 要有可读的失败原因：${result.stderr}`);
});

test("整组反向用例都没有改动真表（字节完全一致）", async () => {
  const realTableAfter = await readFile(REAL_TABLE, "utf8");
  assert.equal(realTableAfter, realTableBefore, "真表被改了：反向用例必须只动 os.tmpdir() 里的副本");
});
