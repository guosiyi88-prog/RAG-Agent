# Issue tracker: Local Markdown

Issues and specs for this repo live as markdown files in `.scratch/`.

> 为什么是本地文件：本仓库**不是 git 仓库**（无 `.git`、无 remote），没有 GitHub/GitLab Issues 可用。等接入远程后，把本文件换成 `issue-tracker-github.md` 的版本即可，其他技能的用法不变。

## Conventions

- One feature per directory: `.scratch/<feature-slug>/`
- The spec is `.scratch/<feature-slug>/spec.md`
- Implementation issues are one file per ticket at `.scratch/<feature-slug>/issues/<NN>-<slug>.md`, numbered from `01`, never a single combined tickets file
- Triage state is recorded as a `Status:` line near the top of each issue file
- Comments and conversation history append to the bottom of the file under a `## Comments` heading

## When a skill says "publish to the issue tracker"

Create a new file under `.scratch/<feature-slug>/` (creating the directory if needed).

## When a skill says "fetch the relevant ticket"

Read the file at the referenced path. The user will normally pass the path or the issue number directly.

## Wayfinding operations

Used by `/wayfinder`. The **map** is a file with one **child** file per ticket.

- **Map**: `.scratch/<effort>/map.md` (the Notes / Decisions-so-far / Fog body).
- **Child ticket**: `.scratch/<effort>/issues/NN-<slug>.md`, numbered from `01`, with the question in the body. A `Type:` line records the ticket type (`research`/`prototype`/`grilling`/`task`); a `Status:` line records `claimed`/`resolved`.
- **Blocking**: a `Blocked by: NN, NN` line near the top. A ticket is unblocked when every file it lists is `resolved`.
- **Frontier**: scan `.scratch/<effort>/issues/` for files that are open, unblocked, and unclaimed; first by number wins.
- **Claim**: set `Status: claimed` and save before any work.
- **Resolve**: append the answer under an `## Answer` heading, set `Status: resolved`, then append a context pointer (gist + link) to the map's Decisions-so-far in `map.md`.

## 本仓库的额外约定

| 目录 | 用途 | 谁写 |
|---|---|---|
| `.scratch/` | **待办与工单**（本文件管辖） | `to-spec` / `to-tickets` / `wayfinder` |
| `docs/prdv1.1/` | **产品规格**（18 个文件的 PRD，AI 可执行版） | 人 |
| `docs/output/` | 一次性产出：评测报告、审查记录、门禁日志 | 人 / AI |
| `docs/prd/`、`docs/output/PRD.md` | 历史版本，**已作废**，仅存档 | — |

**不要**把 `.scratch/` 里的工单与 `docs/prdv1.1/` 的 PRD 混写。PRD 是"要造什么"，`.scratch/` 是"谁在什么时候造哪一块"。
