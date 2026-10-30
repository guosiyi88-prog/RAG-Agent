# 07 · 检索算法

> 实现文件：`src/core/retrieval.ts`。本文件是**可直译的规格**，所有常量与分支必须照此实现。
> 依赖：`embed()` 与 `hashEmbed()` 分别来自 `src/core/embed.ts` / `src/core/hash-embed.ts`，**不要在 `retrieval.ts` 里重写一份**（`ingest.ts` 也用同一个 `embed()`）。

## 1. 输入输出

```ts
export async function retrieve(input: {
  query: string;          // 用户问题（可能含上一轮上下文）
  lang: Lang;             // zh|en|de|nl|es
  topK?: number;          // 默认 5
}): Promise<{
  chunks: RetrievedChunk[];
  topScore: number;       // 最高分，用于拒答阈值判断
  fallback: "none" | "fts_only" | "empty";
}>;

type RetrievedChunk = {
  idx: number;            // 1..n，角标编号
  chunk_id: number;
  doc_id: string;
  doc_title: string;
  doc_lang: Lang;
  page: number | null;
  section: string | null;
  content: string;        // 已截断至 600 字
  score: number;          // 0..1
};
```

---

## 2. 语言过滤（**这一步不能省**）

```ts
const LANG_SCOPE: Record<Lang, Lang[]> = {
  zh: ["zh", "en"],
  en: ["en"],
  de: ["de", "en"],
  nl: ["nl", "en"],
  es: ["es", "en"],
};
```

**为什么必须过滤**：同一段内容有 5 个语言副本，向量空间里挤在一起。不过滤会出现 top5 全是同一段的不同语言版本，等于只召回 1 条独立信息。

---

## 3. Query 构建（多轮指代处理）

```ts
function buildQuery(current: string, prevUser?: string): string {
  const cur = current.trim();
  if (!prevUser) return cur;

  // 只在当前问题"过短或无实词"时拼接上一轮
  if (cur.length <= 25 || !/[a-zA-Z\u4e00-\u9fa5]{3,}/.test(cur)) {
    return `${prevUser.trim()}\n${cur}`;
  }
  return cur;
}
```

| 场景 | 行为 |
|---|---|
| 首轮 | 直接用 `current` |
| `"Und wie viel Watt?"`（18 字符，含实词但短） | 拼上一轮 |
| `"Welcher Wechselrichter ist für eine 600W-Anlage mit Batteriespeicher im Keller geeignet?"`（>25 字符） | 直接用，不拼 |
| 中文 22 字（`"为什么太阳能板发烫正常吗这个问题我想确认一下"`） | **按规则拼接**：判据是字符数不是字数，中文 22 字仍 ≤25 |
| 上一轮不存在 | 直接用 |

**判据只有字符数**（`cur.length <= 25` 或无三个连续字母/汉字），所以中文问句很快触到上限：22 个汉字已经是"长问句"，但规则仍会拼接。这是刻意用**一条可测的判据**换掉"看着像短问题"这种主观判断——要改就只改 `QUERY_STITCH_MAX_CHARS`，改完本表跟着改；不要为此单独加"中文按字数折算"的分支（多一条分支就多一个测不到的角落）。

**不做**：不调模型改写 query（多 1.5s 延迟，且翻译错误会污染全链路）。

---

## 4. 两路召回

### 4.1 向量路

```ts
const vectorSql = `
  select c.id, c.doc_id, c.lang, c.section, c.content, c.page,
         d.title as doc_title, d.lang as doc_lang,
         1 - (c.embedding <=> $1::vector) as score
  from chunks c
  join documents d on d.id = c.doc_id
  where c.lang = any($2::char(2)[])
    and c.embedding is not null
  order by c.embedding <=> $1::vector
  limit ${VECTOR_CANDIDATES}   -- 20
`;
```

`VECTOR_CANDIDATES = 20`。
`$1` = `[${vec.join(",")}]`（1024 维 float 数组拼成的 pgvector 字面量）。

### 4.2 全文路

```ts
const ftsSql = `
  select c.id, c.doc_id, c.lang, c.section, c.content, c.page,
         d.title as doc_title, d.lang as doc_lang,
         ts_rank(c.tsv, plainto_tsquery('simple', $1)) as score
  from chunks c
  join documents d on d.id = c.doc_id
  where c.lang = any($2::char(2)[])
    and c.tsv @@ plainto_tsquery('simple', $1)
  order by score desc
  limit ${FTS_CANDIDATES}      -- 20
`;
```

**全文路的作用边界**：`to_tsvector('simple', …)` 不做词干化。德语 `Wechselrichter` 与 `Wechselrichters` 视为两个词，荷兰语复合词切不开。所以它**只负责**：
- 故障码：`E03`、`F21`
- 型号与规格：`600W`、`ESS-5000`
- 短术语精确命中

**不要指望它解决语义召回**，那是向量路的事。

---

## 5. RRF 融合（精确公式）

```ts
const RRF_K = 60;

function rrf(
  vecRank: Map<number, number>,   // chunk_id -> 0-based rank（未命中则不存在）
  ftsRank: Map<number, number>,
  vecWeight = 0.8,
  ftsWeight = 0.2,
): Array<{ chunk_id: number; score: number }> {
  const ids = new Set([...vecRank.keys(), ...ftsRank.keys()]);
  const out = [];
  for (const id of ids) {
    let s = 0;
    const vr = vecRank.get(id);
    if (vr !== undefined) s += vecWeight / (RRF_K + vr + 1);
    const fr = ftsRank.get(id);
    if (fr !== undefined) s += ftsWeight / (RRF_K + fr + 1);
    out.push({ chunk_id: id, score: s });
  }
  return out.sort((a, b) => b.score - a.score);
}
```

### 5.1 归一化（给拒答阈值用）

RRF 原始分在 `0 ~ 0.0133` 区间（`0.8/61 + 0.2/61 ≈ 0.0164` 为理论上限）。必须归一化后才能和 `RETRIEVAL_MIN_SCORE=0.30` 比较：

```ts
const maxPossible = vecWeight / (RRF_K + 1) + ftsWeight / (RRF_K + 1);  // ≈ 0.01639
const normalized = Math.min(1, rawScore / maxPossible);
```

**这是最容易写错的地方**：直接用原始 RRF 分数和 0.30 比，会导致 100% 拒答。

### 5.2 最终分（v1.1.5 勘误：归一化不等于相关性）

实现时发现上一条**只对了一半**：归一化防住了"量纲错"，但没解决"没有相关性含义"。
归一化是**纯排名信号** —— 向量路只要返回了行，第 1 名就存在，于是归一化必得 `0.8`（单路）
或 `1.0`（两路都第一），与问题是否相关完全无关。实测（五语语料、`text-embedding-v3`）：

| query | lang | 余弦 top1 | 归一化 RRF | 只看归一化会怎样 |
|---|---|---|---|---|
| `Wechselrichter Wirkungsgrad` | de | 0.650 | 0.997 | 相关 → 不拒答 ✓ |
| `Garantie Batterie` | de | 0.737 | 0.800 | 相关 → 不拒答 ✓ |
| `今天天气怎么样` | zh | 0.419 | 0.800 | **无关却同样 0.800 → 永不拒答 ✗** |
| `20% korting` | nl | 0.456 | 0.800 | **无关却同样 0.800 → 永不拒答 ✗** |

所以最终下发与阈值比较用的是**融合分**，RRF 只负责"两路证据是否一致"：

```ts
const normalized = Math.min(1, rawScore / maxPossible);
// 余弦缺失（全文路独有片段）按 1：字面命中精确术语本身就是相关
const similarity = cosine === undefined ? 1 : Math.min(1, Math.max(0, cosine));
const score = normalized * similarity ** 2;   // 0..1，topScore 就是它的最大值
```

**为什么平方**：多语嵌入的余弦有 ~0.4 的噪声地板（无关文本也能到 0.42–0.46），不压缩时
"0.42 的无关"与"0.65 的相关"只差 0.23；平方后是 0.18 与 0.42，`0.30` 正好落在两者之间。
实测同一批查询：正例 0.421 / 0.434 / 0.470，反例 0.140 / 0.166 —— 方向明确、余量够。

平方是**唯一一处分值整形**：要动它必须同时改 `14-verification.md` §3 的断言与本表；
不要在这里再叠第三层变换（每加一层就多一个测不到的角落）。

**已知边界（实测后确认暂不影响）**：只被全文路命中的片段没有余弦，最高只能拿到
`FTS_WEIGHT/(K+1) / maxPossible = 0.2`，低于 `0.30`。本语料里全文路的命中都同时在向量路
top20 内（`Netzspannung` / `Isolationswiderstand` / `600W` / `WT-ESS-5K` 实测 ftsOnly=0），
所以精确术语查询拿到的分是 0.32–0.37（带余弦），不会被拒。将来若出现纯全文命中，
要么在 `05` 的判定里对"字面命中"单独放行，要么调阈值——**不要**为此给融合分加第二层整形。

---

## 6. 后处理

```ts
// 6.1 按 doc_id 去重（同一文档最多保留 3 条，避免一份手册占据全部名额）
// 6.2 截断 content 至 600 字
// 6.3 不足 topK 时按现有数量返回（不补空）
// 6.4 分配 idx = 1..n（按 score 降序）
// 6.5 计算 topScore = normalized[0] ?? 0
```

---

## 7. 完整伪代码（按此实现）

```
retrieve({query, lang, topK=5}):
  1. query = buildQuery(query, prevUser)
  2. if !query.trim() → return {chunks:[], topScore:0, fallback:"empty"}
  3. scope = LANG_SCOPE[lang] ?? ["en"]
  4. try:
       vec = await embed(query)                    // 1024 维
     catch:
       vec = await hashEmbed(query)                // 降级
       fallback = "fts_only"
  5. vecRows = query(vectorSql, [vec, scope])     // ≤20
     ftsRows = query(ftsSql, [query, scope])      // ≤20
  6. if vecRows.length == 0 && ftsRows.length == 0:
       return {chunks:[], topScore:0, fallback:"empty"}
  7. ranks = rrf(rankOf(vecRows), rankOf(ftsRows), 0.8, 0.2)
  8. 取前 max(topK*3, 15) 条做去重与过滤
  9. 逐条归一化 score，按 doc_id 去重（每 doc ≤3）
 10. 取前 topK，分配 idx，截断 content
 11. return {chunks, topScore, fallback}
```

---

## 8. 拒答联动

`chat.ts` 在拿到结果后：

```ts
if (res.fallback === "empty" || res.topScore < RETRIEVAL_MIN_SCORE) {
  // 不进模型，直接拒答 + 建单
}
```

| 条件 | 动作 |
|---|---|
| `chunks.length === 0` | 拒答，`reason=no_citation` |
| `topScore < 0.30` | 拒答，`reason=low_conf` |
| 正常 | 进模型，把 chunks 塞进 prompt |

> `topScore` 是 §5.2 的**融合分**（归一化 RRF × 余弦²），不是 RRF 原始分、也不是单独归一化的 RRF。
> 实测锚点：正例 `Wechselrichter Wirkungsgrad` 0.42、`Garantie Batterie` 0.43、`保修期多久` 0.47；
> 反例 `今天天气怎么样` 0.14、`20% korting` 0.17。调阈值前先跑这五条，别凭感觉动 0.30。

---

## 9. 边界与异常

| 情况 | 处理 |
|---|---|
| query 全是空白 | 返回空，前端拦截，不请求 |
| query >2000 字符 | 截断至 2000 再检索 |
| embedding API 超时（5s） | 降级 hash，`fallback="fts_only"`，日志 warn |
| embedding 返回维度 ≠1024 | 抛 `EMBED_DIM_MISMATCH`，整个请求失败（不能静默） |
| PG 查询超时（3s） | 返回空 + `fallback="empty"` → 走拒答 |
| chunks 表为空 | 同上 |

---

## 10. 参数调优指南（只在 hit@5 不达标时动）

| 现象 | 调整 |
|---|---|
| 明显该命中却召回不到 | 先查语言过滤是否漏了 `lang`；再看 `VECTOR_CANDIDATES` 是否太小（20→40） |
| top5 全是同一文档的连续片段 | `per doc` 上限从 3 降到 2 |
| 术语类查询（型号）召不回 | `RETRIEVAL_FTS_WEIGHT` 从 0.2 提到 0.35 |
| 拒答过多 | `RETRIEVAL_MIN_SCORE` 从 0.30 降到 0.22 |
| 答错（该拒答却答了） | `RETRIEVAL_MIN_SCORE` 提到 0.38 |

**禁止**：检索不达标时靠改 prompt 掩盖。

---

## 11. 自测用例（写进 `scripts/eval.ts` 前的单元自检）

| # | query | lang | 期望 |
|---|---|---|---|
| 1 | `E03` | de | top1 是故障码相关 chunk |
| 2 | `Garantie Batterie` | de | top3 含保修文档 |
| 3 | `保修期多久` | zh | top3 含 zi 保修文档 |
| 4 | `Und wie viel Watt?` + prev=`Welcher Wechselrichter?` | de | top3 含型号参数 |
| 5 | `今天天气怎么样` | zh | 返回空或 topScore < 0.30 |
| 6 | `20% korting` | nl | 返回空或低分（无此内容） |

用例 5、6 是**反例**，用来验证拒答阈值没写反。

---

## 12. 性能预算

| 步骤 | 预算 |
|---|---|
| embed(query) | ≤ 250ms（网络） |
| 向量 SQL | ≤ 120ms |
| 全文 SQL | ≤ 60ms |
| RRF + 后处理 | ≤ 5ms |
| **合计** | **≤ 450ms**（目标 P95 < 300ms，首轮含冷启动可到 600ms） |

超预算优先怀疑：`chunks_lang_idx` 缺失、`ef_search` 过大、embedding 网络。
