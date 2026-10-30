# 用 Pi SDK 作为 Agent 运行时，后端选 Node/TS

## 背景

需要一个能做多步工具调用、带流式、可二次开发的 agent 运行时，跑一个 RAG 客服。候选：自研状态机、LangGraph、CrewAI、Pi、Dify。

## 决定

用 `@earendil-works/pi-coding-agent` 1.4.0 的 **TypeScript SDK 进程内嵌模式**。因此后端语言定为 Node/TS（Fastify），Python 只保留离线语料与评测脚本。

配套三条硬约束，写进规格，谁都不能改：

1. 自定义工具**只能**经 extension 的 `pi.registerTool()` 注册，`tools:[]` 只做选择
2. **必须** `systemPromptOverride` + `appendSystemPromptOverride: () => []`
3. `SessionManager` 是上下文权威，**禁止**给 `session.agent.state.messages` 赋值

## 为什么不是别的

| 方案 | 否掉的原因 |
|---|---|
| 自研 40 行状态机 | 能用，但拿不到 `tool_call` / `tool_result` / `agent_settled` 这些钩子，而拒答兜底和引用落库全靠它们 |
| LangGraph | 状态机抽象很好，但要多写一层图定义，且它的 checkpointer 与会话池设计重复 |
| CrewAI / AutoGen | 面向多 agent 对话，本场景是单 agent + 工具，引入只有故障没有收益 |
| Dify | 会接管数据层，PG/Redis/MinIO 的自主权没了 |

## 代价

- **Python 退出请求链路**。团队若更熟 Python，这是实打实的成本。
- 依赖 22 个 npm 包，供应链面较大 → 版本精确锁 + `npm ci`。
- Pi 是 coding agent 出身，默认带 `read/bash/edit/write` → 必须 `tools:[]` 白名单 + `tool_call` 钩子双保险。

## 会怎么被推翻

如果团队坚持 Python，唯一出路是退回 `pi --mode rpc` 子进程模式。届时 `04-agent-design` 整章作废，重写成本约 1 天。
