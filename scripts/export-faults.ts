/**
 * 故障码快照导出（09#02 / D13 / D22）：库 → `corpus/.fixtures/fault_codes.json`。
 *
 * **方向是单向的**：库是唯一真源，文件只是快照。这条命令永远**不**回写库 ——
 * 一行能把管理端三天录入抹平的命令不值得存在（D22），所以刻意没有 `--force-sync` 反向开关。
 *
 * 为什么放 `.fixtures/`：以 `.` 开头的目录被 ingest 跳过（`src/core/ingest.ts` 的命名约定），
 * 所以快照不会被误当语料重新灌回去，也就不会出现"文件赢还是库赢"这个问题。
 *
 * 用法：node --env-file-if-exists=.env scripts/export-faults.ts [输出路径]
 * 默认输出：corpus/.fixtures/fault_codes.json
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pool, query } from "../src/db.ts";

const DEFAULT_OUT = "corpus/.fixtures/fault_codes.json";

interface Row {
  code: string;
  product_line: string;
  severity: string | null;
  status: string;
  desc_zh: string | null;
  desc_en: string | null;
  desc_de: string | null;
  desc_nl: string | null;
  desc_es: string | null;
  act_zh: string | null;
  act_en: string | null;
  act_de: string | null;
  act_nl: string | null;
  act_es: string | null;
}

const LANGS = ["zh", "en", "de", "nl", "es"] as const;

/**
 * 只导 `published`：快照的用途是"能重建一份可对外的最小语料"，
 * draft 是半成品、archived 是下令不许对外的东西，两者进快照只会误导下一个接手的人。
 * 需要审计全表时直接查库，不要靠快照。
 */
async function main(): Promise<void> {
  const outPath = resolve(process.argv[2] ?? DEFAULT_OUT);

  const rows = await query<Row>(
    `select code, product_line, severity, status,
            desc_zh, desc_en, desc_de, desc_nl, desc_es,
            act_zh,  act_en,  act_de,  act_nl,  act_es
       from fault_codes
      where status = 'published'
      order by code, product_line`,
  );

  const faultCodes = rows.map((row) => ({
    code: row.code,
    product_line: row.product_line,
    severity: row.severity,
    desc: Object.fromEntries(LANGS.map((lang) => [lang, row[`desc_${lang}` as keyof Row] ?? ""])),
    act: Object.fromEntries(LANGS.map((lang) => [lang, row[`act_${lang}` as keyof Row] ?? ""])),
  }));

  const payload = {
    title: "沃泰能源故障码表",
    version: "1.1",
    generated_at: new Date().toISOString(),
    source: "database:fault_codes (status = published)",
    fault_codes: faultCodes,
  };

  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  process.stdout.write(`已导出 ${faultCodes.length} 条 published 故障码 → ${outPath}\n`);
}

try {
  await main();
} catch (err) {
  process.stderr.write(`导出失败：${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
