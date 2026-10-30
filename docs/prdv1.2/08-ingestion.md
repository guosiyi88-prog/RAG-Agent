# 08 · 入库流水线（as-built）

> 覆盖 `src/core/ingest.ts`(645) + `chunk.ts`(290) + `clean.ts`(115) + `terms.ts`(303)
> + `scripts/ingest.ts`、`scripts/check-corpus.ts`、`scripts/check-terms.ts`。
> 一条命令：`node --env-file-if-exists=.env scripts/ingest.ts corpus`。

---

## 1. 流水线（顺序是契约）

```
文件（目录递归，跳过 `.` 开头）
  → 提取文本（pdf: pdftotext -layout / txt|md: 原文 / json: sections[]）
  → 无文本层判定（<100 字/页 ⇒ no_text_layer）
  → 清洗四步（页眉页脚 → 折叠空白 → 去孤立页码 → 全角转半角）
  → 分块（标题切章节 → 空行切段 → 累加到目标长度 → 回退句末 → 80 字重叠）
  → 批量嵌入（text_type=document，10 条/批）
  → 事务写入（删旧片段 → 100 条/批插入 → documents.status=indexed → 旧版本退场）
```

两类例外：

| 例外 | 行为 |
|---|---|
| `fault_codes.json` / `fault_codes.<lang>.json` | **改道 `fault_codes` 表**，不产生 `documents` 行、不产生 `chunks`。**09#02 起 `corpus/` 根下不再有这份文件**：6 条完整五语搬进 `sql/003_faults_seed.sql`，源文件移到 `corpus/.fixtures/`（以 `.` 开头被跳过），`scripts/export-faults.ts` 单向导出快照。改道逻辑保留给"重新导入一批码"的场合 |
| 不支持的后缀（不是 pdf/txt/md/json） | 直接跳过（不是失败，是"不归入库管"） |

---

## 2. 提取

| 类型 | 方式 | 备注 |
|---|---|---|
| `.pdf` | `pdftotext -layout <file> -`（`execFile`，`maxBuffer` 32MB） | 用系统 poppler，**不为解析 PDF 引入 JS 库**（ADR-0005）。容器里必须装 `poppler-data`，否则 CJK 输出空文本 |
| `.txt` / `.md` | 直接读 UTF-8，按 `\f` 分页 | 多页文本同样保住页码 |
| `.json` | `{ title?, lang?, sections: [{heading, body}] }` | 统一成 `## 标题 + 正文 + 空行`，分块器不为 JSON 开分支 |

**无文本层判定**：`总字符数 / 页数 < 100` → `no_text_layer`。扫描版 PDF 就在这一步失败，
不产出空片段（`ingest.ts:31`）。

---

## 3. 语言判定

| 顺序 | 来源 | 缺失后果 |
|---|---|---|
| 1 | 文件名里的 `.<lang>.`（`warranty.de.md` → `de`） | — |
| 2 | `.json` 自带的 `lang` 字段 | — |
| 3 | 都没有 | **`lang_unknown` 失败**，不默认 `en` |

**不从内容猜语言**：猜错一次，整篇文档的目标块长就是错的（中文 500 vs 西文 1200），且不可复现。

---

## 4. 清洗（`clean.ts`，四步顺序不可换）

| # | 动作 | 口径 |
|---|---|---|
| 1 | 去页眉页脚 | 同一行文本**连续出现在 ≥3 页**且 `length < 60` 才删（不是"第一行/最后一行"） |
| 2 | 折叠空白 | 多空白 → 单空格 |
| 3 | 去孤立页码行 | 纯数字行 |
| 4 | 全角转半角 | 数字/字母/标点 |
| — | 保留大小写与标点 | **不做**拼写纠正、不翻译、不去标点、不去 HTML |

已知代价：全角写的页码（`１２`）在第 3 步还认不出来会漏删——规格规定顺序，不许为了多删一行
把第 4 步挪到第 3 步前面（`clean.ts:4`）。

---

## 5. 分块（`chunk.ts`，参数是常量不是可调项）

| 常量 | 值 | 含义 |
|---|---|---|
| `TARGET_CHARS_ZH` | **500** | 中文目标块长 |
| `TARGET_CHARS_LATIN` | **1200** | 西文目标块长（按**文档语言**取，不按字符类型猜） |
| `OVERLAP_CHARS` | **80** | 相邻块重叠窗口，取尾部并对齐到句首（对齐后 <20 字则退回原窗口） |
| `MIN_CHUNK_CHARS` | **60** | 过短块并入上一块；没有上一块则丢弃 |
| `MAX_CHUNK_CHARS` | **2000** | 超长块直接抛错（分块逻辑缺陷，宁可整篇失败） |

**五条不变量**：

1. 正文（不含重叠前缀）不超过 target。
2. 块长 ≥ `MIN_CHUNK_CHARS`，否则并入上一块。
3. 相邻块以「前块尾部、句首对齐」开头。
4. **块不跨章节**（章节是天然语义边界；跨了 `section` 只能填一半，引用抽屉会显示错章节名）。
5. 表格**独立成块、块首重复表头、不做重叠**（`§4.3`）。

**断块点选择**：在 target 之内从后往前找句末（`。！？…；;.!?`）→ 找不到退到最近的空格/换行
→ 最后才硬切。标题行本身**不进正文**（它已是 `section` 元数据，塞进去会让每块都以标题开头、稀释向量）。

**页码语义**：`page` 是**该块正文**的起始页；重叠前缀来自上一块，不计入页码。

---

## 6. 写入与幂等

| 机制 | 实现 |
|---|---|
| 文档去重 | `documents.sha256` 唯一；重跑同一内容 → 复用 doc id、先删旧片段再插 |
| 幂等重索引 | 先 `delete from chunks where doc_id = $1`，再按 **100 条/批** `insert ... select from unnest(...)` |
| 状态机 | `pending` → `indexed`（成功）/ `failed` + `err`（失败码见下） |
| 旧版本退场 | 同一 `object_key` 的新版本写成功后，**同一事务**里删掉旧行（chunks 由外键 cascade 带走） |
| 失败不删已写片段 | 现场排查需要看到"上次灌进去的是什么"，下次重索引会自己先删 |

`documents.err` 的取值（一个码对应一个阶段）：`no_text_layer` / `empty_after_clean` /
`unsupported_type` / `lang_unknown` / `extract_failed` / `embed_unavailable` / `embed_timeout` /
`embed_dim_mismatch` / `db_failed` / `internal_error`。

`token_len` 用 `ceil(content.length / 3)` 估算，**不入库引分词器**。

---

## 7. 故障码改道（文件名即路由）

```
fault_codes.json / fault_codes.de.json  →  fault_codes 表（upsert，五语必齐）
其它 *.json                             →  documents + chunks（普通语料）
```

规则：

- 五语 `desc_*` / `act_*` **必须全给**，缺一门就整批失败（缺德语的码在德语用户那里等于不存在）。
- `severity` 只能是 `info|warn|fatal`。
- 文件内 `(code, product_line)` 重复 → 失败（否则 upsert 结果取决于顺序）。
- **不删"文件里没有的"故障码**：`tickets` / `qa_gold` 可能已引用，自动删除会让"昨天还能查到的 E03"
  今天凭空消失。

---

## 8. 质量门槛（`scripts/check-corpus.ts`）

阈值是**常量**不是命令行参数（能现场调阈值就等于没有阈值）。任一不达 → 退出码 1。

| 检查 | 阈值 | 当前实测 |
|---|---|---|
| 每语片段数 | ≥ 8 | zh 18 / en 18 / de 18 / nl 10 / es 10 |
| 合计片段 | ≥ 40 | **74** |
| 空向量 | = 0 | 0 |
| 超长块（>2000） | = 0 | 0 |
| 过短块（<60） | = 0 | 0 |
| `indexed` 文档 | ≥ 11 | **13** |
| `pending` / `failed` | = 0 / 0 | 0 / 0 |
| 同 `object_key` 多版本 | = 0 | 0 |
| 拉丁语片段含 CJK | = 0 | 0 |
| 故障码（≥3 且五语齐） | ≥ 3 | 6 条，五语齐 |

另有 `scripts/check-terms.ts`（`terms.ts`）：术语逐条对齐 + `de/nl/es` 片段不得含汉字。
**纯文件检查，不必起数据层**——所以它能在 CI 的第一秒就红。

---

## 9. 与 v1.1 的差异（本章）

| # | v1.1 | 实际 | 编号 |
|---|---|---|---|
| 1 | 未把"表格独立成块"写成硬规则 | 连续 ≥2 行含 `|` 即整表成块、块首重复表头、不做重叠 | E31 |
| 2 | 未规定超长块的处理 | 超过 2000 直接抛错让整篇失败（不写超长块） | E32 |
| 3 | 未规定批大小 | 插入 100 条/批、嵌入 10 条/批（`EMBED_BATCH_SIZE`） | E33 |
| 4 | 未规定"同 object_key 旧版本退场"的时机 | **新版本写成功之后**才删旧行（失败时旧版本仍是最好的数据） | E34 |
| 5 | 无 `.fixtures/` 跳过规则 | 以 `.` 开头的文件与目录一律跳过 | E35 |
