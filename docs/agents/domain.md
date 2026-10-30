# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- **`GLOSSARY.md`** at the repo root, or
- **`GLOSSARY-MAP.md`** at the repo root if it exists: it points at one `GLOSSARY.md` per context. Read each one relevant to the topic.
- **`docs/adr/`**: read ADRs that touch the area you're about to work in. In multi-context repos, also check `src/<context>/docs/adr/` for context-scoped decisions.

If any of these files don't exist, **proceed silently**. Don't flag their absence; don't suggest creating them upfront. The `/domain-modeling` skill (reached via `/grill-with-docs` and `/improve-codebase-architecture`) creates them lazily when terms or decisions actually get resolved.

## File structure

Single-context repo (most repos):

```
/
├── GLOSSARY.md
├── docs/adr/
│   ├── 0001-event-sourced-orders.md
│   └── 0002-postgres-for-write-model.md
└── src/
```

Multi-context repo (presence of `GLOSSARY-MAP.md` at the root):

```
/
├── GLOSSARY-MAP.md
├── docs/adr/                          ← system-wide decisions
└── src/
    ├── ordering/
    │   ├── GLOSSARY.md
    │   └── docs/adr/                  ← context-specific decisions
    └── billing/
        ├── GLOSSARY.md
        └── docs/adr/
```

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in `GLOSSARY.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal: either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0007 (event-sourced orders), but worth reopening because…_

---

## 本仓库布局：single-context

判定依据：无 `pnpm-workspace.yaml`、无 `package.json` workspaces、无多包 `packages/*`。**单上下文**。

因此：

- 术语表：根目录 `GLOSSARY.md`（尚未创建，按需由 `/grill-with-docs` 生成）
- 架构决策：根目录 `docs/adr/`（尚未创建，同上）

### 已存在的领域词汇（先按此用，别造同义词）

| 术语 | 含义 | 出处 |
|---|---|---|
| 会话 / conversation | 一次连续对话，`conversations` 一行 | `docs/prdv1.1/04-db.md` |
| 工单 / ticket | 转人工后产生的单据，`WT-YYYY-NNNN` | 同上 |
| 引用 / citation | 答案里 `[n]` 角标指向的原文片段 | `docs/prdv1.1/06-agent.md` |
| 拒答 / refusal | 无证据时的固定话术，**不经模型生成** | 同上 §5 |
| no_citation | 本轮无任何检索证据的工单原因 | `docs/prdv1.1/05-api.md` §4 |
| 闸门 / gate | 人读代码的强制停顿点（G1–G5） | `docs/prdv1.1/18-human-gates.md` |

真实术语表等 `GLOSSARY.md` 建立后以它为准。
