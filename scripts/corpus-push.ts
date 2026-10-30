/**
 * 把本地 `corpus/` 推到对象存储（`${S3_BUCKET}/corpus/<相对路径>`）—— `09#05` 知识库 CRUD 的地基。
 *
 * 为什么要有这一步：容器化部署下宿主机目录不共享，上传/编辑的对象必须是对象存储里的文件。
 * 本地目录保留为开发回落 —— `scripts/ingest.ts --source=minio` 与 `--source=local` 走同一条
 * pipeline，`documents.object_key` 记的都是语料相对路径，所以"推到 MinIO 再灌"与"直接灌本地"
 * 落在同一批行上，不是又灌一份。
 *
 * 用法：
 *   node --env-file-if-exists=.env scripts/corpus-push.ts           # 默认推 ./corpus
 *   node --env-file-if-exists=.env scripts/corpus-push.ts corpus    # 显式给目录
 *
 * 幂等策略：**内容相同则跳过，不同才覆盖写**。
 * 判等靠 MD5/ETag —— MinIO 单段上传的 ETag 就是内容的 MD5（小写、无引号），本地算一遍一样便宜；
 * 大小不同直接判不一致（省一次读取）；复合上传的 ETag 带 `-<段数>` 后缀，没法和 MD5 比，
 * 一律按"不一致"处理 → 重传（宁可多传一次，也不留一个说不清的旧对象）。
 * 覆盖写是 `putObject` 的语义：同 key 覆盖，不会产生第二个对象。
 *
 * 失败隔离与入库一致：一个文件传不上去只记一条 failed，其余照传；有失败则退出码 1。
 */
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { extname, join, relative, sep } from "node:path";
import {
  CORPUS_PREFIX,
  corpusObjectKey,
  ensureBucket,
  isCorpusTextFile,
  putObject,
  statObject,
} from "../src/storage.ts";

/** 以 `.` 开头的文件/目录跳过：`.fixtures/` 是负例夹具，不该推到语料前缀里。 */
function isIgnored(name: string): boolean {
  return name.startsWith(".");
}

async function collectFiles(target: string): Promise<string[]> {
  const entries = await readdir(target, { withFileTypes: true });

  const files: string[] = [];
  // 与 ingest 同一口径：排序稳定，两次运行的输出才 diff 得动
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (isIgnored(entry.name)) continue;
    const full = join(target, entry.name);
    if (entry.isDirectory()) files.push(...(await collectFiles(full)));
    else if (isCorpusTextFile(entry.name)) files.push(full);
  }
  return files;
}

const MIME_BY_EXT: Record<string, string> = {
  ".md": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".json": "application/json",
};

type Action = "uploaded" | "skipped" | "failed";

interface PushResult {
  relPath: string;
  key: string;
  action: Action;
  bytes: number;
  message?: string;
}

/**
 * 本地字节 vs 远端 ETag：大小不同直接判不同（不读远端内容也不必算 MD5）；
 * 大小相同再比 MD5；ETag 带 `-N`（复合上传）或为空时按不同处理。
 */
function sameContent(size: number, md5: string, remote: { size: number; etag: string }): boolean {
  if (remote.size !== size) return false;
  if (remote.etag === "" || remote.etag.includes("-")) return false;
  return remote.etag === md5;
}

async function pushFile(target: string, file: string): Promise<PushResult> {
  const relPath = relative(target, file).split(sep).join("/");
  const key = corpusObjectKey(relPath);
  const buf = await readFile(file);
  const md5 = createHash("md5").update(buf).digest("hex");

  const remote = await statObject(key);
  if (remote !== null && sameContent(buf.length, md5, remote)) {
    return { relPath, key, action: "skipped", bytes: 0 };
  }

  // 同 key 覆盖：`putObject` 不会留下第二个对象，所以"重复执行"不会在桶里堆版本
  await putObject(key, buf, MIME_BY_EXT[extname(file).toLowerCase()] ?? "application/octet-stream");
  return { relPath, key, action: "uploaded", bytes: buf.length };
}

async function main(): Promise<void> {
  const target = process.argv[2]?.trim() === "" ? undefined : process.argv[2];
  const root = target ?? "corpus";

  let files: string[];
  try {
    files = await collectFiles(root);
  } catch (err) {
    process.stderr.write(
      `读取目录失败 ${root}：${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exitCode = 2;
    return;
  }

  await ensureBucket();
  process.stdout.write(`推送 ${files.length} 个文件：${root} → ${CORPUS_PREFIX}\n`);

  const results: PushResult[] = [];
  for (const file of files) {
    try {
      results.push(await pushFile(root, file));
    } catch (err) {
      // 一个文件传失败不影响其余文件；失败也要带上它的 key，排障才知道是哪一个
      results.push({
        relPath: relative(root, file).split(sep).join("/"),
        key: corpusObjectKey(relative(root, file)),
        action: "failed",
        bytes: 0,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  results.forEach((result, index) => {
    const tail =
      result.action === "failed" ? `failed: ${result.message ?? "unknown"}` : `${result.action}  ${result.bytes} B`;
    process.stdout.write(`[${index + 1}/${results.length}] ${result.key.padEnd(34)} ${tail}\n`);
  });

  const uploaded = results.filter((result) => result.action === "uploaded");
  const skipped = results.filter((result) => result.action === "skipped");
  const failed = results.filter((result) => result.action === "failed");
  const uploadedBytes = uploaded.reduce((sum, result) => sum + result.bytes, 0);

  process.stdout.write(
    `合计 ${results.length} 个文件：uploaded=${uploaded.length} skipped=${skipped.length} ` +
      `failed=${failed.length}，上传字节 ${uploadedBytes} B\n`,
  );
  process.exitCode = failed.length === 0 ? 0 : 1;
}

main().catch((err: unknown) => {
  process.stderr.write(`推送失败：${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
