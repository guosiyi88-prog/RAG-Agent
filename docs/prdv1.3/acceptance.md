# v1.3 · 验收（每张卡的可执行判据）

> 通则（每张卡都要过，不分卡）：`npm run typecheck` 零错误 → `npm test`（串行，`--test-concurrency=1` 已内置）→ `bash scripts/verify.sh` 九项。服务没起时 L1/L3–L5 会标"未验证"，**那不算过**。
> 门禁口径一条都不许放松（提示词 §5 第 4 条）：不许 `skip`、不许为了让测试变绿改断言。

## S1 · 看板口径基线（`09#01`）

```bash
# 1) demo 工单不进默认口径
./data/scripts/db.sh psql -tAc "select count(*) from tickets where 'demo'=any(tags)"        # 期望 8
curl -s -H "x-admin-token: $TOKEN" http://127.0.0.1:8000/api/console/stats | node -e "..."   # total 不含那 8 张
curl -s -H "x-admin-token: $TOKEN" 'http://127.0.0.1:8000/api/console/stats?exclude_demo=false'  # total 含那 8 张
# 2) 幂等：同一时间窗连调两次，数字完全一致
# 3) 时间窗：today / week 两种取值，超范围参数 → 400（不是静默回落）
```

- [x] 新增单元测试：同一份库上 `exclude_demo=true` 与 `false` 的 `total` 之差 == demo 张数。（`tests/console-api.test.ts`「看板口径：exclude_demo=true|false 的 total 之差 == 库里 demo 工单张数」）
- [x] `ai_runs` 侧的拒答率口径写进响应注释：`ai_runs` 无 `demo` 标记，demo 会话的 run 只能按"demo 工单的 `conv_id` 反查"排除；反查不到就留在分母里，**这个差异必须写在文档里**，否则下一个人当 bug 修。

> **实测口径（`09#01`，2026-10-27）**：`ai_runs.conv_id` 与 `tickets.conv_id` **是**共同键，代码已按
> `not exists (select 1 from tickets t where t.conv_id = r.conv_id and 'demo' = any(t.tags))` 排除。
> 但 `scripts/demo.ts` 造的 8 张演示工单 `conv_id` **全是 `null`**（演示单没有真实会话），
> 所以这条反查**当前恒为空集**：演示会话若产生过 run，它仍留在分母里；`conv_id` 为 null 的 run 同理。
> 要让这条口径真正生效，得先给演示工单接一个真会话（数据层改动，不在 S1 范围）。

## S2 · 故障码真源与发布态（`09#02`）

```bash
# 1) 归档的码经 ingest 不复活
./data/scripts/db.sh psql -c "update fault_codes set status='archived' where code='F21'"
node --env-file-if-exists=.env scripts/ingest.ts corpus
./data/scripts/db.sh psql -tAc "select status from fault_codes where code='F21'"   # 期望 archived
# 2) 存在 draft 行时门禁仍绿
./data/scripts/db.sh psql -c "insert into fault_codes (code,product_line,desc_zh,desc_en,status) values ('X01','P1','草','draft','draft')"
node --env-file-if-exists=.env scripts/check-corpus.ts          # 期望 ok
# 3) 查询侧只认 published
curl -s 'http://127.0.0.1:8000/api/fault/X01'                    # 期望 found:false
./data/scripts/db.sh psql -c "update fault_codes set status='published', desc_de='', ... where code='X01'"  # 缺语不许发布
```

- [ ] `writeFaultCodes` 改 `do nothing`；`make export-faults` 能出快照；`corpus/fault_codes.json` 移到 `corpus/.fixtures/` 后 `ingest` 仍成功（种子已在 `sql/002_seed.sql`）。
- [ ] `tests/corpus-quality.test.ts` 与 `scripts/check-corpus.ts` 的 SQL 都加 `where status = 'published'`，并补"published 缺任一语 = 失败"的断言（D24）。
- [ ] 新增"ingest → 归档 → 再 ingest 状态不变"的测试（D25）。

## S3 · 真登录与角色门（`09#03`）✅

- [x] **前置人闸**：`docs/output/boundary-change-R2.md` 已签（沃泰，2026-10-27；§7 三格按默认值）
- [x] R2-1 登录：`POST /api/auth/login` / `logout` / `GET /api/console/me`；scrypt + 16 字节盐 + 常数时间比较；票据 32 字节，Redis 存快照、库只存 sha256（`tests/auth-login.test.ts` 3 条）
- [x] R2-2 角色门：`requireRole` + `ROUTE_MIN_ROLE`（28 条路由全入表）+ 启动断言（漏一条进程起不来，`tests/roles.test.ts` 3 条）
- [x] R2-3 队列可见性：`agent` → `assignee = 自己 or null`；`lead/admin` 全部；详情对他人工单 **403**（`tests/queue-visibility.test.ts` 4 条）
- [x] R2-4 派发权限：`assignee` 派给他人 / 清空 → 只有 `lead`/`admin`；`audit_log.actor` 是真实登录人
- [x] R2-5 `ADMIN_TOKEN` 退场、删 `X-Admin-Staff`（`grep src/` 零残留）；前端 `/console` 改成邮箱+口令登录，401 回 gate、403 只提示、5xx 只读降级不清票据（D31）

实测（2026-10-27）：`npm test` **423/423**、`npm run typecheck` 零错误、`bash scripts/verify.sh` **9/9**；旧 `x-admin-token` → 401；同一队列 `zhang.wei` total=145 / `li.na` total=146（差 1 张归李娜的单，过滤真实生效）。

```bash
# 旧令牌退场（保留作回归用）
curl -s -o /dev/null -w '%{http_code}' -H "x-admin-token: $OLD" http://127.0.0.1:8000/api/console/tickets   # 401
```

**未完成（已明确排期，不算漏）**：`PATCH` 仍不判可见性（agent 拿 id 能改他人工单）；`ROUTE_MIN_ROLE` 的 `lead`/`admin` 档位与团队看板分档留 `09#04`。

## S4 · 管理端面板（`09#04`）

- [x] 新增一条 draft（仅 zh+en）→ 用户侧 `GET /api/fault/:code` 查不到 → 发布后查得到。（`tests/admin-api.test.ts` ④ + 真服务实测）
- [x] 归档走 `status`，行不删；归档后列表默认不显示、筛选"已归档"能查到。
- [x] `fault_reports` 待审列表：每条都有"合并/忽略"，处置后从默认列表消失（R26 第 ① 条）。
- [x] 看板出现三个计数：new 数 / 24h 新增 / 合并率（R26 第 ② 条）。**缺一不算完成**。
- [x] 前端改动验收**换 origin**（`/assets/*` 带 `max-age`，旧模块会被缓存）。
- [x] `severity` 能清回 NULL（`09#04` 未做第 5 条，后端三态 + 前端显式发 `null`，`tests/admin-api.test.ts` ⑩⑪ / `tests/web-admin-faults.test.ts`）
- [x] 派发选人下拉（`09#04` 未做第 1 条）：`lead`/`admin` 详情里选人派单，`GET /api/admin/staff` 降到 `lead`（`tests/web-admin-kb.test.ts` 的派发一组）
- [ ] **团队看板分档**（`09#04` 未做第 3 条，**仍未做**）：`GET /api/console/stats` 仍是全量口径，`agent` 能从看板读到同事工单的数量与平均 SLA 剩余。要单独一张卡定 `scope=self|team` 的口径（会牵动 `09#01` 的 `exclude_demo` 基线）。

## S5 · 知识库 CRUD 与重建索引（`09#05`）✅

- [x] 改一篇文档 → 重建 → 旧引用仍能打开（快照在 `citations` 表，`chunk_id` 失效置 null 的路径已有）。
- [x] 重建中途失败 → 能回滚到上一版索引（不许留半个库）。
- [x] 重建后 `check-corpus` / `check-terms` 仍绿。

```bash
# 真服务实测（PORT=8011，2026-10-28）：201 → 202 → succeeded → indexed v1 → PATCH pending → v2
#   → rollback v1 → 再 rollback 409 → archive 200（chunks 留、检索排除）
#   角色：lead 读 200 / lead 写 403 / agent 403 / 无票据 401
```

## 全量回归

```bash
npm run typecheck && npm test && bash scripts/verify.sh
```

- [x] 三轮全绿，且测试总数**只增不减**（基线 403 → **595**；`typecheck` 零错误、`npm test` **595/595**、`verify.sh` **ok=9 fail=0 skip=0**，2026-10-28）。
- [x] `AGENTS.md` 里的"当前状态 / 验证"两行同步更新（测试数、能力面）。
