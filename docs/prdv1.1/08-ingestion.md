# 08 · 语料入库

> 实现文件：`src/core/ingest.ts`（可被 API 与 CLI 复用）+ `scripts/ingest.ts`（CLI 入口）。
> embedding 调用统一走 `src/core/embed.ts`，hash 兜底走 `src/core/hash-embed.ts`（见 §5）。
> 入库后的质量自检：`scripts/check-corpus.ts`（连库查数）与 `scripts/check-terms.ts`（纯文件查术语），见 §10。

## 1. 流水线

```
文件 → 提取文本 → 清洗 → 分块 → 生成 embedding（批量）→ 事务写入
                                                         ├─ documents.status
                                                         └─ chunks
```

---

## 2. 文本提取

| 输入 | 方法 | 说明 |
|---|---|---|
| `.pdf` | `pdftotext -layout in.pdf -` 走 `execFile` | Dockerfile 需 `apk add poppler-utils` |
| `.txt` / `.md` | 直接读 UTF-8 | |
| `.json` | 解析，字段 `{title, lang, sections:[{heading, body}]}` | 进 `documents`/`chunks` 的 JSON 用这个格式；故障码另有 `fault_codes[]` 格式并改道故障码表，见 §9.1 |
| 扫描版 PDF（提取结果 <100 字/页） | 判定失败，`status='failed'`，`err='no_text_layer'` | 前端给"粘贴文本入库" |

### 2.1 页码保留

`pdftotext -layout` 用 `\f`（form feed）分页。按 `\f` 切开，第 i 段对应第 i+1 页。

```ts
const pages = raw.split("\f");
```

---

## 3. 清洗规则

按顺序执行：

1. 去掉页眉页脚：连续 3 页出现且长度 <60 的行
2. 折叠空白：`\n{3,}` → `\n\n`，行尾空格删除
3. 去掉孤立的页码行：`^\s*\d{1,3}\s*$`
4. 全角转半角（仅数字与英文括号）
5. 保留原文大小写与标点（不要过度清洗，会破坏术语）

**不做**：不去 HTML 标签（源里没有）、不做拼写纠正、不翻译。

---

## 4. 分块算法（精确规格）

```ts
type Chunk = { seq: number; section: string | null; content: string; page: number | null };

const TARGET_CHARS = 500;   // 中文按字符，西文按字符（英文 500 字符 ≈ 80 词，偏短，故下方区分）
const TARGET_CHARS_LATIN = 1200;  // 西文按字符（≈200 词）
const OVERLAP_CHARS = 80;
const MIN_CHUNK_CHARS = 60;
```

### 4.1 切分优先级

```
1. 按标题切：正则 ^(#{1,3}\s+.+|\d+(\.\d+)*\s+[A-ZÄÖÜ].{0,60}|\d+(\.\d+)*\s+[\u4e00-\u9fa5].{0,30})$
   → 命中的行成为 section 名，其后内容归入该 section
2. 每个 section 内按空行切段落
3. 段落累加，超过 TARGET 则断块
4. 断块时回退到最近的句末（。[.!?]）
5. 相邻块保留 OVERLAP_CHARS 尾部字符（在句首对齐）
6. 块 < MIN_CHUNK_CHARS 时并入上一块（没有上一块则丢弃）
```

### 4.2 语言相关的目标长度

| 语种 | TARGET |
|---|---|
| `zh` | 500 字符 |
| `en/de/nl/es` | 1200 字符 |

理由：中文一个字信息量约等于西文 2–3 字符。

### 4.3 表格处理

- 连续 ≥2 行且含 `|` 或连续 `\t` → 判定为表格
- 表格独立成块，**块首重复表头**
- 表格块不做 overlap

### 4.4 分块产物

```ts
{
  doc_id, seq,           // seq 从 1 开始，按文档顺序
  lang,                  // 继承 document.lang
  section,               // 最近标题，无则 null
  content,               // 已 trim
  page,                  // 该块起始页码
  token_len              // content.length / 3 估算
}
```

---

## 5. Embedding

### 5.1 批量

| 项 | 值 |
|---|---|
| 批大小 | **10 条**（DashScope 硬上限；规格原写 16，2026-10-27 实测 API 返回 `batch size is invalid, it should not be larger than 10`，已改） |
| 重试 | 2 次，指数退避 500ms / 1500ms |
| 超时 | 单批 15s |
| 并发 | 1（串行批，避免限流） |

### 5.2 DashScope 调用

```http
POST https://dashscope.aliyuncs.com/api/v1/services/embeddings/text-embedding/text-embedding
Authorization: Bearer $DASHSCOPE_API_KEY
Content-Type: application/json

{ "model": "text-embedding-v3",
  "input": { "texts": ["…", "…"] },
  "parameters": { "dimension": 1024, "text_type": "document" } }
```

> 检索时的 `text_type` 用 `"query"`。两者不可混用，否则召回质量下降。

### 5.3 hash 兜底

`src/core/hash-embed.ts`（兜底向量的实现本体；自检走 `tests/ingest-pure.test.ts` 的"兜底向量"断言，不另设 CLI）：

```
对文本按空格/标点切 token
每个 token 做 FNV-1a 32bit → 映射到 1024 维中的一个下标，值 +1
可选：token 的 idf 加权（用全局计数近似）
L2 归一化
```

确定性的：同样输入永远同样向量，评测可复现。

---

## 6. 事务写入

```ts
// 先 upsert 文档行拿 doc id（状态置回 pending、清掉上次的 err），再在一个事务里写块
await tx(async (c) => {
  const doc = await c.query(
    `insert into documents (title, lang, object_key, sha256, status)
     values ($1,$2,$3,$4,'pending')
     on conflict (sha256) do update
       set title = excluded.title, lang = excluded.lang, object_key = excluded.object_key,
           status = 'pending', err = null
     returning id`, [...]);
  const docId = doc.rows[0].id;

  // 幂等：先删旧块
  await c.query(`delete from chunks where doc_id = $1`, [docId]);

  // 批量插入（100 条一批）
  for (const batch of chunks_(chunkList, 100)) {
    await c.query(
      `insert into chunks (doc_id, seq, lang, section, content, page, token_len, embedding)
       select * from unnest($1::uuid[], $2::int[], $3::char(2)[], $4::text[],
                            $5::text[], $6::int[], $7::int[], $8::vector[])`,
      [...]);
  }

  // 标题在这一步才最终确定：`.json` 自带的 title 提取阶段才知道
  await c.query(
    `update documents
        set title=$4, status='indexed', chunk_count=$2, pages=$3, err=null
      where id=$1`,
    [docId, chunkList.length, pages.length, docTitle]);

  // 同一 object_key 的旧版本退场（新版本已写成功；旧块由外键 cascade 带走）
  await c.query(`delete from documents where object_key = $1 and id <> $2`, [rel, docId]);
});
```

`documents` 只写 `title / lang / object_key / sha256 / status / chunk_count / pages / err`：`product_line`（balcony|residential|cni）**不由入库填**，本期的语料目录按语种分文件、不按产品线分目录，留空表示"通用于所有产品线"。

失败：`update documents set status='failed', err=$2`，**不删已写入的块**（下次重索引会先删）。

**改完文件再入库**（同一 `object_key` 换了 `sha256`）：新版本写成功后，在**同一个事务**里删掉同 `object_key` 的其余行（`chunks` 由外键 cascade 带走）。只在成功后删，所以新版本失败时旧版本仍是"最后一份好数据"，与"失败不删已写入的块"一致；不做这一步，库里会同时留着改前改后两版，检索引用到已被改掉的段落（`make corpus-check` 的"多版本"一项会当场抓出来）。

---

## 7. 幂等与重索引

| 场景 | 行为 |
|---|---|
| 同一文件上传两次 | `sha256` 冲突 → 复用 doc id，`delete chunks` 后重建 |
| 手动重索引 | 同上 |
| 文档内容变了 | `sha256` 变化 → 新文档；旧的保留（手动删） |

---

## 8. `scripts/ingest.ts` CLI

```bash
# 语料目录固定为仓库根下的 corpus/；只接一个参数（目录或单文件）；等价于 make ingest
node --env-file-if-exists=.env scripts/ingest.ts corpus
```

输出（示例为当前 `corpus/` 的实际形态：13 个 md + 1 个故障码 json，按文件名排序）：

```
嵌入后端: dashscope（DashScope text-embedding-v3）
[1/14] fault_codes.json                  ??  chunks=0   ok
[2/14] install.de.md                     de  chunks=5   ok
[3/14] install.en.md                     en  chunks=5   ok
...
[13/14] warranty.nl.md                   nl  chunks=5   ok
[14/14] warranty.zh.md                   zh  chunks=5   ok
合计 14 个文件：ok=14 failed=0
```

- 语言列取文件名里的 `.<lang>.`（`warranty.de.md` → `de`）；**不从内容里猜中文还是德文**，文件名没写语言、`.json` 也没有 `lang` 字段时报 `lang_unknown`
- 结构化语料没有语言，打印 `??`（见 §9.1）
- 失败行把 `ok` 换成 `failed: <err 码>`，码值见 `src/core/ingest.ts` 的 `IngestErrorCode`（`no_text_layer`、`empty_after_clean`、`lang_unknown`、`embed_*`、`db_failed` 等）
- 故障码文件只报 `chunks=0` 与 `ok`：它写的是 `fault_codes` 表，行数看 §10 的故障码检查项

退出码：全成功 0，有失败 1。

---

## 9. 语料清单（Plan C 最低要求）

目录位置：**仓库根下的 `corpus/`（应用层）**，不进 `data/`（一次 `destroy` 不能把语料卷走，见 `13-ops.md` §5）。语言写在文件名里（`<类>.<lang>.md`），入库时按文件名取语言，不从内容猜。

| 文件 | 语种 | 用途 | 必需 |
|---|---|---|---|
| `warranty.zh.md` | zh | 保修条款 | ✅ |
| `warranty.en.md` | en | 英文保修（en 同时是 de/nl/es 的兜底语种） | ✅ |
| `warranty.de.md` | de | 德语保修 | ✅ |
| `warranty.nl.md` | nl | 荷兰语保修 | ✅ |
| `warranty.es.md` | es | 西班牙语保修 | ✅ |
| `install.zh.md` | zh | 安装步骤 | ✅ |
| `install.en.md` | en | 英文安装 | ✅ |
| `install.de.md` | de | 德语安装 | ✅ |
| `install.nl.md` | nl | 荷兰语安装 | ✅ |
| `install.es.md` | es | 西班牙语安装 | ✅ |
| `spec.zh.md` / `spec.en.md` / `spec.de.md` | zh/en/de | 产品参数（**只有三语**：参数表是中/英/德，不设 nl/es；理由见 `16-risks-errata.md` §6 的 L3） | ✅ |
| `fault_codes.json` | — | 故障码，**结构化语料**：写 `fault_codes` 表，不进 `documents`/`chunks`（见 §9.1） | ✅ |

入库文件共 **14 个**（保修 5 + 安装 5 + 产品参数 3 + 故障码 1），对应 `documents` **13 行**（故障码不产生文档行）。`corpus/.fixtures/` 是测试夹具目录（如无文本层的扫描 PDF），**以 `.` 开头的文件与目录被入库跳过**，不会出现在 `make ingest` 的失败列表里。

### 9.1 故障码：结构化语料改道 `fault_codes` 表

故障码快路查的是"这个 code 属于哪条产品线、现象是什么、怎么处理"，一次**主键命中**就够；放进 `chunks` 会让同一份内容在向量空间里跟保修条款抢名额，五语描述还会被切成碎片。所以带这个文件名的 JSON 不走文档流水线：

- **路由靠文件名**：`/^fault_codes(\.[a-z]{2})?\.json$/i` → `fault_codes` 表；想让它回片段表就改名，这是刻意的显式开关，不看内容猜类型
- **格式**：`{title, version, fault_codes:[{code, product_line, severity, desc{zh,en,de,nl,es}, act{zh,en,de,nl,es}}]}`
- **入库期校验**（不合格整批失败，不写半条）：`severity` 只能是 `info|warn|fatal`；`desc` / `act` 的五语都必须是非空字符串（缺一门语言 = 那门语言的用户查不到这个码）；同一文件内 `(code, product_line)` 不许重复（主键重复会让结果取决于顺序）
- **写入**：一条 `insert ... on conflict (code, product_line) do update` 全表 upsert，幂等靠主键，重跑只更新不插新行
- **不删**文件里没有的故障码：`tickets` / `qa_gold` 可能已经引用了某个 code，删除要人确认
- **没有文档状态**：不写 `documents` 行，所以既没有 `pending/indexed/failed`，也没有 chunk；要么整批写进去，要么报错退出

`sql/002_seed.sql` 里已有 3 条演示码（E03 / E07 / F21）；`corpus/fault_codes.json` 现有 6 条（E03、E07、F05 属 balcony，F21、E11 属 residential，C02 属 cni），其中 3 条与 seed 主键重叠 → 最终表里 **6 行**，seed 重放仍幂等（`on conflict ... do nothing`）。

### 9.2 规模与语言要求

**规模目标**：`chunks` 里 `count(distinct lang)` 必须 ≥ 5，每种语言 ≥ 8 块，合计 ≥ 40 块，已索引文档 ≥ 11，保证 `14-verification.md` §4.2 的 30 题 `expect_doc_id` 都能命中。判定不用肉眼数，跑 §10 的 `make corpus-check`。

**为什么 en 是硬要求**：`LANG_SCOPE` 给 de/nl/es 的兜底语种是 `en`（`07-retrieval.md` §2），而且 §4.2 的第 5/6/7 题直接考 en 文档。缺 en 会让 hit@5 上限直接掉到 83%。

生成方式：中文写死（人工可控）→ LLM 译英/德/荷/西 → **术语表机检（`make corpus-terms`）** → 抽样人工。术语表见 `12-i18n.md` §5；机检口径见 §10.2。

---

## 10. 质量检查（入库后必跑）

**一条命令，两个脚本，任一 `[fail]` 退出码 1。** 人只读结论行，不读日志、不手抄 SQL；手查 SQL 降级为 §10.3 的附录（没有 `make` 时用）。

### 10.1 `make corpus-check` → `scripts/check-corpus.ts`

```bash
make corpus-check
# 等价：node --env-file-if-exists=.env scripts/check-corpus.ts
```

五条输出行覆盖下列全部阈值，全部写成脚本常量，**不做命令行参数**——能现场调阈值就等于没有阈值：

| 输出行 | 覆盖的阈值 | 不达标说明什么 |
|---|---|---|
| 片段数 | 五语**各 ≥ 8** 块、合计 **≥ 40** 块 | 该语种语料太少，评测 hit@5 只是抽样噪声 |
| 块质量 | 空向量（`embedding is null`）= **0**；超长块（`length(content) > 2000`）= **0**；空块/过短块（`length(trim(content)) < 60`）= **0** | 空向量等于该块永不被向量召回；超长块说明切分失败（整篇塞进一块）；短于 `MIN_CHUNK_CHARS` 的碎片正常分块时会被并进上一块，漏进库就是分块或写入出了问题 |
| 文档状态 | `indexed ≥ 11`、`pending = 0`、`failed = 0`、同一 `object_key` 多行（多版本）= **0** | 有文档没跑完或失败，评测基数不对；同一文件多行说明改完文件重跑入库后旧版本没退场，检索会引用到已被改掉的段落 |
| 语种纯度 | `lang in (de,nl,es)` 且 `content ~ '[一-龥]'` 的片段 = **0** | 机翻漏译或语料贴错文件（§10.2 查文件，这里查已入库的片段） |
| 故障码 | 五语齐全（`desc_*` / `act_*` 十列都不为空）的条数 **≥ 3**，且 **齐全 == 总数** | 结构化语料没灌进去，或某个码缺语（那门语言里等于查不到） |

输出形状（示例数字来自当前语料：zh/en/de 各 18 块、nl/es 各 10 块，合计 74，已索引 13 份）：

```
语料质量自检：每语片段 ≥8、合计 ≥40、空向量 0、超长块 0、过短块 0（<60 字符）、已索引文档 ≥11、失败文档 0、多版本 0
[ok  ] 片段数        zh=18 en=18 de=18 nl=10 es=10 合计=74（阈值 每语 ≥8、合计 ≥40）
[ok  ] 块质量        空向量=0（阈值 0）、超长块=0（>2000 字符，阈值 0）、过短块=0（<60 字符，阈值 0）
[ok  ] 文档状态      indexed=13 pending=0 failed=0 多版本=0（阈值 indexed ≥11、pending 0、failed 0、多版本 0）
[ok  ] 语种纯度      de/nl/es 含 CJK 的片段 0 条（阈值 0）
[ok  ] 故障码        共 6 条，五语齐全 6/6（阈值 ≥3 且无缺语）
结论：语料健康，可用于评测。
```

任一 `[fail]` → 不进入评测，先修语料。退出码 0 = 全绿、1 = 有项不达标（CI 与演示脚本靠退出码判断，不靠人读日志）。**`indexed ≥ 11` 是门槛不是目标**：当前语料对应 13 份文档（保修 5 + 安装 5 + 参数 3），故障码不产生文档行，正常就该是 13；低于 11 说明有文件没灌进去。

### 10.2 `make corpus-terms` → `scripts/check-terms.ts`

```bash
make corpus-terms
# 等价：node --env-file-if-exists=.env scripts/check-terms.ts [语料目录，默认 corpus]
```

把 `12-i18n.md` §5 的术语表当硬约束逐条对到**语料文件**上（不是对到 UI 文案上）。**纯文件检查、不连数据库**，所以入库之前就能跑：

| 检查项 | 口径 |
|---|---|
| 术语对齐 | 中文主源里出现过的术语，同一族（`warranty` / `install` / `spec` …）的 en/de/nl/es 文件里必须出现表里那一列的目标词（或该词在 `src/core/terms.ts` 里声明过的屈折形式），不得同义替换 |
| 机翻残中文 | de/nl/es 文件里不得出现 CJK，报告到行号（"荷兰语页面里蹦汉字"是用户直接能看见的缺陷） |
| 命名 | 每个文件名都要能读出语种（`<族>.<lang>.md`）；读不出的文件既分不了组也入不了库，直接判失败 |
| 空跑保护 | 语料目录为空、或目标语上一共查了 0 条术语、或术语表解析不出预期条数 → 一律失败，不允许"零条术语、零违规"地通过 |

术语表**从 `docs/prdv1.1/12-i18n.md` §5 现场解析**，代码里不留第二份；改术语先改那一张表，再改语料。某一族没有中文主源时该族跳过并打印原因（不是违规）——缺文件由 §10.1 的片段数与文档数负责。任一 `[fail]` → 退出码 1，按文件 + 术语逐条列出，不靠人眼抽查。

输出形状（当前语料三族全绿）：

```
术语一致性检查：术语表 docs/prdv1.1/12-i18n.md §5、语料目录 corpus、de/nl/es 不得含 CJK、每个文件名必须写明语种
[ok  ] 术语表      从 docs/prdv1.1/12-i18n.md §5 解析到 10 条（期望 10 条；表形状不对会直接抛错，不会静默通过）
[ok  ] install.zh  中文主源 1200 字符，术语基准 7 条
[ok  ] install.de  术语 7/7 对齐
...
[ok  ] warranty.es 术语 5/5 对齐
结论：3 族语料术语对齐，共查 64 处，可用于评测。
```

### 10.3 不想跑脚本时的手查（原始 SQL）

> 阈值与 §10.1 完全一致，只是判断与退出码要自己看。

```sql
-- 1. 每个语种都有块（每语 ≥8、合计 ≥40）
select lang, count(*) from chunks group by lang;

-- 2. 没有超长块（>2000 字符说明切分失败）
select count(*) from chunks where length(content) > 2000;

-- 3. 没有空块（短于 60 字符的碎片）
select count(*) from chunks where length(trim(content)) < 60;

-- 4. 向量都生成了
select count(*) from chunks where embedding is null;

-- 5. 文档状态（indexed ≥11、pending/failed 均 0）
select status, count(*) from documents group by status;

-- 5b. 同一文件多版本（应为 0 行；有行 = 改完文件重跑入库后旧版本没退场）
select object_key, count(*) from documents group by object_key having count(*) > 1;

-- 6. de/nl/es 里没有机翻残中文
select lang, count(*) from chunks
 where lang in ('de','nl','es') and content ~ '[一-龥]'
 group by lang;

-- 7. 故障码五语齐全（十列都非空）
select count(*) filter (
         where desc_zh <> '' and desc_en <> '' and desc_de <> '' and desc_nl <> '' and desc_es <> ''
           and act_zh  <> '' and act_en  <> '' and act_de  <> '' and act_nl  <> '' and act_es  <> ''
       ) as complete,
       count(*) as total
  from fault_codes;
```

任一数字越线 → 不能进入评测。

