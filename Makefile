# 应用层的薄包装：数据层的一切都转发给 data/scripts/db.sh，不在这里重复实现（13-ops.md §5）。
DATA := ./data/scripts/db.sh
ENV  := --env-file-if-exists=.env

.PHONY: up down reset init status check env dev test typecheck build logs health ingest corpus-check corpus-terms export-faults seed-faults demo eval check-i18n verify

up:            ## 起数据层并等健康（数据层归 data/）
	$(DATA) up

down:          ## 停数据层（卷保留）
	$(DATA) down

reset:         ## 清空数据层 + 重建 + 重新建表（演示前必做；**会删数据卷**，先 make backup）
	$(DATA) destroy --yes
	$(DATA) up
	cat sql/001_init.sql sql/002_seed.sql sql/003_faults_seed.sql | $(DATA) psql -v ON_ERROR_STOP=1

backup:        ## 数据库备份（pg_dump -Fc 到 backup/，保留最近 7 份；每日 03:17 由 Windows 计划任务自动跑）
	bash scripts/backup.sh

init:          ## 只重建表（不清卷）
	cat sql/001_init.sql sql/002_seed.sql sql/003_faults_seed.sql | $(DATA) psql -v ON_ERROR_STOP=1

status:
	$(DATA) status

check:         ## 数据层连通性自检
	$(DATA) check

env:           ## 打印应用连接串（.env 由它派生，不要手写）
	$(DATA) env

dev:           ## 宿主直接跑 .ts，不产出 JS
	node $(ENV) src/server.ts

typecheck:
	npx tsc --noEmit

test:          ## node:test；不能用 `node --test tests/`：22.x 把位置参数当文件而非目录；必须串行（见 package.json）
	node --test --test-concurrency=1

build:         ## 应用进容器（external 接入数据层网络）
	docker compose -f docker-compose.app.yml up -d --build

logs:          ## 应用容器日志（json-file 10MB × 3）
	docker compose -f docker-compose.app.yml logs -f

health:
	@curl -s http://127.0.0.1:8000/healthz

ingest:        ## 灌语料目录（幂等；改完文件重跑，旧版本自动退场）
	node $(ENV) scripts/ingest.ts corpus

corpus-check:  ## 语料质量自检（08 §10）：片段数/块质量/文档状态/语种纯度/故障码，任一不达标退出 1
	node $(ENV) scripts/check-corpus.ts

export-faults: ## 故障码快照导出（09#02 / D13）：库 → corpus/.fixtures/fault_codes.json，只导出 published，单向
	node $(ENV) scripts/export-faults.ts

seed-faults:   ## 批量故障卡模拟数据（默认 1000 条五语 published、幂等；ARGS 透传，如 ARGS="--count 200 --status draft"）
	node $(ENV) scripts/seed-faults-bulk.ts $(ARGS)

corpus-terms:  ## 术语一致性（12-i18n §5）：术语逐条对齐 + de/nl/es 无汉字；纯文件检查，不必起数据层
	node $(ENV) scripts/check-terms.ts corpus

demo:          ## 演示数据（08#03）：qa_gold 对齐 + 8 张 demo 工单（幂等；不清库。语料为空时退出 1，先跑 make ingest）
	node $(ENV) scripts/demo.ts

eval:          ## 30 题评测跑分（08#02）：三行指标 + 写 eval_runs + 落 docs/output/*.md（--multi 跑多轮 5 题）
	node $(ENV) scripts/eval.ts

check-i18n:    ## 五语文案校验（12-i18n §6）：key 集合/总数 127/占位符/无 CJK 残留，任一不过退出 1
	node $(ENV) scripts/check-i18n.ts

verify:        ## 提交前门禁（14 §8 四命令 + 14 §2 L1–L5）：tsc / 串行测试 / 文案 / 依赖审计 / healthz / 检索 / 对话 / 拒答
	bash scripts/verify.sh
