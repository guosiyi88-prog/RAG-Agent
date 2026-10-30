import { basename } from "node:path";
import { Client } from "minio";
import { config } from "./config.ts";

const endpoint = new URL(config.s3.endpoint);
const useSSL = endpoint.protocol === "https:";
const defaultPort = useSSL ? 443 : 80;

export const minioClient = new Client({
  endPoint: endpoint.hostname,
  port: endpoint.port ? Number(endpoint.port) : defaultPort,
  useSSL,
  accessKey: config.s3.accessKey,
  secretKey: config.s3.secretKey,
  region: config.s3.region,
});

const bucket = config.s3.bucket;

export async function ensureBucket(): Promise<void> {
  if (await minioClient.bucketExists(bucket)) return;
  await minioClient.makeBucket(bucket, config.s3.region);
}

export async function putObject(key: string, buf: Buffer, mime: string): Promise<void> {
  await minioClient.putObject(bucket, key, buf, buf.length, { "Content-Type": mime });
}

/**
 * 对象不存在。`getObject` 拿一个不存在的 key 时**不返回空 buffer**，而是抛这个类型 ——
 * 空 buffer 会一路走到"清洗后为空"与"文件真的 0 字节"混在一起，排障时分不清。
 * 调用方用 `isObjectNotFound(err)` 判断（别去比对 message，S3 的错误文案不稳定）。
 */
export class ObjectNotFoundError extends Error {
  readonly code = "OBJECT_NOT_FOUND";
  readonly key: string;

  constructor(key: string) {
    super(`对象不存在：${key}`);
    this.name = "ObjectNotFoundError";
    this.key = key;
  }
}

export function isObjectNotFound(err: unknown): err is ObjectNotFoundError {
  return err instanceof ObjectNotFoundError;
}

/**
 * S3 的"没有这个 key"：`statObject` 给 `NotFound`，`getObject` 的流给 `NoSuchKey`，两种都认。
 * 别的错误（NoSuchBucket / AccessDenied / 网络）不在这一支里，照常抛给调用方 —— 别把"桶没建"读成"文件不存在"。
 */
function isMissingKeyError(err: unknown): boolean {
  if (err === null || typeof err !== "object") return false;
  const code = (err as { code?: unknown }).code;
  if (typeof code === "string" && (code === "NoSuchKey" || code === "NotFound" || code === "NoSuchObject")) {
    return true;
  }
  const statusCode = (err as { statusCode?: unknown }).statusCode;
  return statusCode === 404;
}

/** ETag 统一成去引号的小写：单段上传时它就是内容 MD5，复合上传时会带 `-N` 后缀。 */
function normalizeEtag(raw: unknown): string {
  return typeof raw === "string" ? raw.replace(/"/g, "").toLowerCase() : "";
}

export async function getObject(key: string): Promise<Buffer> {
  let stream: AsyncIterable<Buffer | string>;
  try {
    stream = await minioClient.getObject(bucket, key);
  } catch (err) {
    throw isMissingKeyError(err) ? new ObjectNotFoundError(key) : err;
  }

  const chunks: Buffer[] = [];
  try {
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  } catch (err) {
    // 缺 key 的错误可能在流里才浮出来（响应头已回、正文报错），两支都要转成同一个类型
    throw isMissingKeyError(err) ? new ObjectNotFoundError(key) : err;
  }
  return Buffer.concat(chunks);
}

export async function presignedUrl(key: string, seconds = 900): Promise<string> {
  return minioClient.presignedGetObject(bucket, key, seconds);
}

export interface ObjectStat {
  size: number;
  /** 内容指纹：单段上传 = 内容 MD5（小写、无引号），复合上传带 `-<段数>` 后缀 */
  etag: string;
  lastModified: Date | null;
  metaData: Record<string, unknown>;
}

/**
 * 查对象元信息。**不存在的 key 返回 null**（不是抛错）：push/管理端里"先查后决定传不传"
 * 是正常分支，用异常表达会逼每处调用都写 try —— 与 `getObject` 的口径不同，是因为两者的
 * "拿不到"语义不同：取正文拿不到就是失败，查元信息拿不到只是"还没传过"。
 */
export async function statObject(key: string): Promise<ObjectStat | null> {
  try {
    const stat = await minioClient.statObject(bucket, key);
    return {
      size: stat.size,
      etag: normalizeEtag(stat.etag),
      lastModified: stat.lastModified ?? null,
      metaData: (stat.metaData ?? {}) as Record<string, unknown>,
    };
  } catch (err) {
    if (isMissingKeyError(err)) return null;
    throw err;
  }
}

export interface ObjectInfo {
  key: string;
  size: number;
  etag: string;
  lastModified: Date | null;
}

/**
 * 递归列前缀下的对象。目录占位对象（key 以 `/` 结尾、size 0）不算文件，直接跳过 ——
 * 它们会让调用方以为"这里有个叫 docs/ 的语料"。
 */
export async function listObjects(prefix = ""): Promise<ObjectInfo[]> {
  const stream = minioClient.listObjectsV2(bucket, prefix, true);
  return new Promise<ObjectInfo[]>((resolve, reject) => {
    const objects: ObjectInfo[] = [];
    stream.on("data", (item) => {
      const key = typeof item.name === "string" ? item.name : "";
      if (key === "" || key.endsWith("/")) return;
      objects.push({
        key,
        size: Number(item.size ?? 0),
        etag: normalizeEtag(item.etag),
        lastModified: item.lastModified ?? null,
      });
    });
    stream.on("error", (err: Error) => reject(err));
    stream.on("end", () => resolve(objects));
  });
}

// ─────────────────── 语料在对象存储里的布局（09#05 起） ───────────────────
//
// 为什么布局放在这一层：本地目录（开发回落）与对象存储（部署态）必须是同一套"哪些文件算语料、
// 相对路径怎么算"的规则，否则同一个文件从两个入口进来会变成两行 documents。
// 这里只放纯规则 + 列对象，不放解析/清洗 —— 那是 `src/core/ingest.ts` 的事。

/** 语料前缀：`wt-dev` bucket 下的 `corpus/`。 */
export const CORPUS_PREFIX = "corpus/";
/**
 * 对象存储侧能入库的后缀。**不含 `.pdf`**：`pdftotext` 要读真实文件，
 * 从对象存储拿到的字节没法直接抽文本（本地目录源仍然支持 PDF）。
 */
export const CORPUS_TEXT_EXTENSIONS: readonly string[] = [".md", ".txt", ".json"];

export function isCorpusTextFile(name: string): boolean {
  const lower = name.toLowerCase();
  return CORPUS_TEXT_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/** 语料相对路径 → 对象 key（`warranty.zh.md` → `corpus/warranty.zh.md`）。 */
export function corpusObjectKey(relPath: string): string {
  return `${CORPUS_PREFIX}${relPath.split("\\").join("/").replace(/^\/+/, "")}`;
}

/**
 * 对象 key → 语料相对路径（= `documents.object_key` 的口径）；**null 表示"不是要入库的语料"**。
 * 跳过规则与本地目录逐一对应：前缀之外不管；任一路径段以 `.` 开头就跳过（`corpus/.fixtures/`
 * 里是负例夹具，被当语料灌进去会让质量门禁与检索都变脏）；后缀不在白名单不管。
 */
export function corpusRelPathOf(key: string, prefix: string = CORPUS_PREFIX): string | null {
  const normalized = key.split("\\").join("/");
  if (!normalized.startsWith(prefix)) return null;
  const relPath = normalized.slice(prefix.length);
  if (relPath === "" || relPath.endsWith("/")) return null;
  const segments = relPath.split("/");
  if (segments.some((segment) => segment === "" || segment.startsWith("."))) return null;
  if (!isCorpusTextFile(relPath)) return null;
  return relPath;
}

export interface CorpusObject {
  /** 对象 key（`corpus/warranty.zh.md`） */
  key: string;
  /** 语料相对路径（`warranty.zh.md`）：`documents.object_key` 用这个，与本地源同口径 */
  relPath: string;
  /** 文件名（含后缀）：语言与默认标题看它 */
  name: string;
  size: number;
}

/** 列出前缀下的待入库语料，按相对路径排序（输出顺序要稳定，两次运行才 diff 得动）。 */
export async function listCorpusObjects(prefix: string = CORPUS_PREFIX): Promise<CorpusObject[]> {
  const objects = await listObjects(prefix);
  const corpus: CorpusObject[] = [];
  for (const object of objects) {
    const relPath = corpusRelPathOf(object.key, prefix);
    if (relPath === null) continue;
    corpus.push({ key: object.key, relPath, name: basename(relPath), size: object.size });
  }
  return corpus.sort((a, b) => a.relPath.localeCompare(b.relPath));
}
