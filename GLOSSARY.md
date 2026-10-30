# 沃泰储能多语种客服 Agent

面向欧洲安装商与终端业主的售后自助系统：五语种问答、每条结论可追溯到原文、答不了自动转人工。
本文件只定义**这个项目特有的词**。通用编程概念（超时、错误码、分页）不在此列。

## 语言

### 客服业务

**会话（conversation）**：
一段连续交流的整体，从第一条提问开始，到用户不再追问为止；数据库 `conversations` 一行。
_Avoid_: 对话轮次、聊天记录、session

**坐席（staff）**：
沃泰的人类客服人员。数据库 `staff` 一行。
_Avoid_: 客服、agent、用户

**Agent**：
大模型驱动的问答执行体，跑在 Pi SDK 里。**永远指 AI，不指人。**
_Avoid_: 机器人、助手、staff

**工单（ticket）**：
需要人介入时产生的单据，编号 `WT-YYYY-NNNN`；有 open / claimed / escalated / closed 四态。
_Avoid_: 单子、任务、issue

**拒答（refusal）**：
系统判定本轮没有证据支撑回答，于是强制下发固定话术并建单的行为。用户没有选择权。`reason ∈ {no_citation, low_conf}`。
_Avoid_: 不知道、失败、转人工

**转人工（handoff）**：
用户主动点「转人工」按钮要求人工介入。`reason = user_request`。
_Avoid_: 拒答、升级

> 拒答与转人工都会建单，但原因、SLA、统计口径不同。混用会让"AI 独立解决率"这个北极星指标失真。

**未命中池（no-hit pool）**：
所有 `reason ∈ {no_citation, out_of_scope}` 且未关单的问题的聚合视图 `v_no_hit`，用来发现知识缺口。
_Avoid_: 失败队列、待办

**知识草稿（kb draft）**：
从未命中问题生成、等待坐席审批的问答条目；审批通过后写进 `chunks` 成为可检索知识。
_Avoid_: FAQ、条目

**故障码快路（fault-code fast path）**：
输入匹配 `^[A-Za-z]\d{2,3}$` 时，绕过模型直接查 `fault_codes` 表返回结果的路径。目标 P95 < 1s。
_Avoid_: 快捷查询、预设答案

### 检索与回答

**片段（chunk）**：
入库切分后的最小检索单元，`chunks` 一行，带页码与章节。一段手册内容可能被切成多个 chunk。
_Avoid_: 块、文档、段落

**候选（candidate）**：
本轮 `kb_search` 召回的 top5 片段。只存在于后端，不下发前端。
_Avoid_: 引用、结果

**引用（citation）**：
答案正文里真的出现 `[n]` 角标、且 n 落在候选集内的那些片段；`citations` 表存快照。
_Avoid_: 来源、出处、参考

> 候选 ⊃ 引用。把所有候选都发给前端，就会出现"点开角标发现这段话没支持那句话"——信任立刻崩。

**命中（hit@5）**：
召回的 top5 片段里，至少有一条的 `doc_id` 等于 `qa_gold.expect_doc_id`。这是检索层的唯一指标，与答案质量无关。
_Avoid_: 准确率、召回率、命中率

**五语种（five locales）**：
`zh / en / de / nl / es`。不是"支持多语言"，而是这五个具体语种，其余一律回落 `en`。
_Avoid_: 多语言、国际化、i18n（i18n 指那套 142 个 key 的实现机制，不是语种本身）

### AI 运行时

**Pi（Pi SDK）**：
`@earendil-works/pi-coding-agent`，本项目的 agent 运行时。版本锁 `1.4.0`。
_Avoid_: 框架、引擎、pi 框架

**Extension**：
Pi 的 TypeScript 扩展模块，用 `pi.registerTool()` 注册工具、`pi.on()` 挂生命周期钩子。本项目只有一个：`ext/support.ts`。
_Avoid_: 插件、中间件

**Skill**：
`SKILL.md` 形式的按需加载指令包，走 Agent Skills 规范。**与本项目 PRD 文档无关**。
_Avoid_: 技能、SOP（SOP 是坐席端要编辑的业务话术，不是 Skill）

**安全模式（safe mode）**：
`SAFE_MODE=true` 时不调模型，只返回带引用的结果、其余一律拒答。用于答辩现场兜底。
_Avoid_: 调试模式、只读模式

### 研发流程

**闸门（gate）**：
人读代码的强制停顿点，G1–G5 共五个。过不了不许进下一张任务卡。
_Avoid_: 检查点、里程碑、评审

**断言（assertion）**：
AI 自己跑的自动化验证，一条命令或一条 `expect()`。
_Avoid_: 测试、用例

**验收（acceptance）**：
人工在闸门里逐条打勾的清单项。
_Avoid_: 断言、闸门

> 三者不可混称：断言机器跑，闸门人读代码，验收人打勾。

**任务卡（task card）**：
`prdv1.1/15-tasks.md` 里的一张卡，含目标、依赖、产出文件、验收断言。编号 T00–T11。
_Avoid_: 工单（工单是业务实体，不是开发任务）

**演示数据（demo data）**：
`make demo` 灌进去的样例工单与语料，仅供演示，非真实业务数据。接口返回时必须带 `demo: true`。
_Avoid_: 测试数据、mock（mock 特指 `LLM_PROVIDER=mock` 的降级实现）
