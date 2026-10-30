/**
 * 语料入库命令行（08-ingestion.md §8）。只做三件事：取参数、打印、设退出码。
 * 清洗 / 分块 / 写入逻辑一律在 `src/core/*` 里 —— 命令里复制一份就是两套规格的开始。
 *
 * 用法（Makefile 的 `make ingest` 就是这个）：
 *   node --env-file-if-exists=.env scripts/ingest.ts corpus                    # 本地目录（默认源）
 *   node --env-file-if-exists=.env scripts/ingest.ts corpus/warranty.zh.md    # 单个文件
 *   node --env-file-if-exists=.env scripts/ingest.ts --source=minio corpus    # 对象存储的 corpus/ 前缀
 *
 * `--source` 默认 `local`（开发回落）。两种源走同一条 pipeline，产出同一批 documents 行
 * （`object_key` 是语料相对路径，与源无关），所以换源重跑是幂等的、不是"再灌一份"。
 */
import { pool } from "../src/db.ts";
import { ingestPath, ingestSource, minioSource } from "../src/core/ingest.ts";
import { embedBackend } from "../src/core/embed.ts";
import { CORPUS_PREFIX } from "../src/storage.ts";

const NAME_WIDTH = 32;
const SOURCES = ["local", "minio"] as const;
type SourceKind = (typeof SOURCES)[number];

interface ParsedArgs {
  source: SourceKind;
  /** 本地源：目录或文件；minio 源：只用来核对用户指的就是 corpus/ */
  target: string | undefined;
}

function parseArgs(argv: readonly string[]): ParsedArgs | { error: string } {
  let source: SourceKind = "local";
  const positional: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? "";
    if (arg === "--source" || arg.startsWith("--source=")) {
      const value = arg === "--source" ? argv[(index += 1)] : arg.slice("--source=".length);
      if (value === undefined || !(SOURCES as readonly string[]).includes(value)) {
        return { error: `未知的 --source：${value ?? "(空)"}（可用：${SOURCES.join("|")}）` };
      }
      source = value as SourceKind;
      continue;
    }
    if (arg.startsWith("-")) return { error: `未知参数：${arg}` };
    positional.push(arg);
  }

  if (positional.length > 1) return { error: `多余的参数：${positional.slice(1).join(" ")}` };
  return { source, target: positional[0] };
}

/**
 * minio 源只认 `corpus/` 前缀（语料布局只有这一处）：位置参数可省略，给了就必须指向 corpus/ ——
 * 否则"以为在灌别的目录、其实灌的是 corpus/"是必然的误会。
 */
function targetProblem(source: SourceKind, target: string | undefined): string | null {
  if (source === "local") {
    return target === undefined || target.trim() === "" ? "本地源必须给目录或文件" : null;
  }
  if (target === undefined) return null;
  const normalized = target.split("\\").join("/").replace(/\/+$/, "");
  const name = normalized.split("/").pop();
  if (name === "corpus") return null;
  return `minio 源只读 ${CORPUS_PREFIX} 前缀：位置参数要么省略，要么指向 corpus/（收到 "${target}"）`;
}

function main(): void {
  const parsed = parseArgs(process.argv.slice(2));
  if ("error" in parsed) {
    process.stderr.write(`${parsed.error}\n`);
    process.stderr.write("用法: node scripts/ingest.ts [--source=local|minio] <目录或文件>\n");
    process.exitCode = 2;
    return;
  }

  const { source, target } = parsed;
  const problem = targetProblem(source, target);
  if (problem !== null) {
    process.stderr.write(`${problem}\n`);
    process.exitCode = 2;
    return;
  }

  const where = source === "minio" ? `${CORPUS_PREFIX} 前缀（对象存储）` : String(target);
  process.stdout.write(`读取源: ${source}（${where}）\n`);

  const backend = embedBackend();
  process.stdout.write(
    `嵌入后端: ${backend}${backend === "hash" ? "（本地 FNV-1a 兜底，不调用外部服务）" : "（DashScope text-embedding-v3）"}\n`,
  );

  const run =
    source === "minio" ? ingestSource(minioSource(CORPUS_PREFIX)) : ingestPath(String(target));

  run
    .then(
      (summary) => {
        const total = summary.results.length;
        if (total === 0) {
          process.stdout.write(`没有可入库的文件：${where}\n`);
        }
        summary.results.forEach((result, index) => {
          const name = result.relPath.padEnd(NAME_WIDTH);
          const lang = (result.lang ?? "??").padEnd(2);
          const tail = result.ok ? "ok" : `failed: ${result.err ?? "unknown"}`;
          process.stdout.write(
            `[${index + 1}/${total}] ${name} ${lang}  chunks=${String(result.chunkCount).padEnd(3)} ${tail}\n`,
          );
        });

        process.stdout.write(
          `合计 ${total} 个文件：ok=${summary.okCount} failed=${summary.failedCount}\n`,
        );
        // 有失败就 1：CI/演示脚本靠退出码判断，不能让人肉读日志
        process.exitCode = summary.failedCount === 0 ? 0 : 1;
      },
      (err: unknown) => {
        process.stderr.write(`入库失败：${err instanceof Error ? err.message : String(err)}\n`);
        process.exitCode = 1;
      },
    )
    // 命令行要自己收尾连接池：不关的话进程会被 pool 的空闲计时器拖住 30s 才退出，
    // `make ingest` 看起来像卡死。库里的 ingest 模块不碰连接池，那是进程宿主的事。
    .finally(() => pool.end().catch(() => undefined));
}

main();
