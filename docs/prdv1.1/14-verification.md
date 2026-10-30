# 14 · 验证与验收

> 所有断言必须**可执行**。手工检查单独标注。

## 1. 分层验证

| 层 | 方式 | 何时跑 |
|---|---|---|
| L1 启动 | `curl /healthz` | T01 之后每次改动 |
| L2 数据 | SQL 计数 | T03 之后 |
| L3 检索 | `/internal/search` curl | T04 之后 |
| L4 对话 | `curl -N /api/chat` | T05 之后 |
| L5 拒答 | curl + SQL 查工单 | T06 之后 |
| L6 界面 | 手工清单 | T07/T08 |
| L7 指标 | `make eval` | T10 |
| L8 交付 | `make reset && make up` | T11 |

---

## 2. L1–L5 可执行断言

```bash
#!/usr/bin/env bash
# scripts/verify.sh —— 提交前必跑
# 依赖：bash、curl、jq、./data/scripts/db.sh（宿主不需要装 psql，也不用手工导 PGPASSWORD）
set -e
API=http://localhost:8000
INT=${INTERNAL_TOKEN}

# 所有 SQL 统一走数据层的 psql；连接串变量名是 DATABASE_URL，不是 PG_URL
q() { ./data/scripts/db.sh psql -tAc "$1"; }

echo "== L1 healthz"
curl -sf $API/healthz | jq -e '.ok and .checks.pg and .checks.redis and .checks.minio' >/dev/null
echo "   ok"

echo "== L2 data"
q "select count(distinct lang) from chunks" | grep -q '^5$'    # 五语齐（08 §9）
q "select count(*) from chunks where embedding is null" | grep -q '^0$'
q "select count(*) from chunks where length(content)>2000" | grep -q '^0$'
echo "   ok"

echo "== L3 retrieval 正例"
curl -sf -X POST $API/internal/search -H "X-Internal-Token: $INT" \
  -H 'content-type: application/json' \
  -d '{"query":"E03 Netzspannung","lang":"de","top_k":5}' \
  | jq -e '.data.chunks | length >= 1' >/dev/null
echo "   ok"

echo "== L3 retrieval 反例（应空或低分）"
curl -sf -X POST $API/internal/search -H "X-Internal-Token: $INT" \
  -H 'content-type: application/json' \
  -d '{"query":"今天天气怎么样","lang":"zh","top_k":5}' \
  | jq -e '(.data.chunks|length)==0 or .data.topScore < 0.30' >/dev/null
echo "   ok"

echo "== L4 chat SSE"
UT=$(curl -sf -X POST $API/api/session | jq -r .data.token)
OUT=$(curl -sN -X POST $API/api/chat -H 'content-type: application/json' \
  -H "X-User-Session: $UT" -d '{"text":"Garantie Batterie","lang":"de"}' | head -c 4000)
echo "$OUT" | grep -q 'event: meta'      || { echo "缺 meta"; exit 1; }
echo "$OUT" | grep -q 'event: delta'     || { echo "缺 delta"; exit 1; }
echo "$OUT" | grep -q 'event: done'      || { echo "缺 done"; exit 1; }
echo "   ok"

echo "== L5 拒答 + 建单"
BEFORE=$(q "select count(*) from tickets")
OUT=$(curl -sN -X POST $API/api/chat -H 'content-type: application/json' \
  -H "X-User-Session: $UT" -d '{"text":"Kunnen jullie 20% korting geven?","lang":"nl"}')
echo "$OUT" | grep -q 'event: refusal'   || { echo "未拒答"; exit 1; }
AFTER=$(q "select count(*) from tickets")
[ "$AFTER" -gt "$BEFORE" ] || { echo "未建单"; exit 1; }
echo "   ok"

echo "== ALL PASS"
```

---

## 3. 关键断言说明（为什么这么写）

| 断言 | 防的是什么 |
|---|---|
| `count(distinct lang) = 5`（zh/en/de/nl/es 各 ≥8 块、合计 ≥40） | 语料只灌了一两种语言；五语评测题就有一半没有语料可命中。定稿口径以 `make corpus-check` 的"片段数"一行为准（`08` §10.1） |
| `embedding is null = 0` | 向量生成中断，检索全坏 |
| `length(content) > 2000 = 0` | 分块失败，整篇塞进一个 chunk |
| 反例 `topScore < 0.30` | 阈值写反（把 RRF 原始分、或单独归一化的 RRF 和 0.30 比，都会让反例也过线 → 永不拒答；现口径见 `07` §5.2 的融合分） |
| `event: refusal` 且 `tickets+1` | 拒答只改了话术没建单，或建单没走拒答 |
| `head -c 4000` | SSE 是长流，不加限制会挂住 |

---

## 4. 评测夹具 `corpus/qa_gold.json`

### 4.1 结构

```json
{
  "version": "1.0",
  "items": [
    { "lang": "de", "question": "...", "expect_doc_hint": "warranty.de",
      "should_refuse": false, "note": "保修期限" }
  ]
}
```

`expect_doc_hint` 用于人工对齐到 `documents.id`；`scripts/demo.ts` 会把 hint 解析成 `expect_doc_id` 写库。

### 4.2 30 题清单（权威内容）

| # | lang | question（要点） | expect_doc_hint | refuse |
|---|---|---|---|---|
| 1 | de | Wie lange gilt die Garantie auf den Wechselrichter? | warranty.de | 否 |
| 2 | de | Ist der Batteriespeicher in der Garantie enthalten? | warranty.de | 否 |
| 3 | de | Wie schließe ich den Wechselrichter am Netz an? | install.de | 否 |
| 4 | de | Was bedeutet Fehlercode E03? | fault | 否 |
| 5 | en | What is the rated output power of the 600W model? | spec.en | 否 |
| 6 | en | How long does the warranty last? | warranty.en | 否 |
| 7 | en | What are the grid voltage requirements? | install.en | 否 |
| 8 | en | What does error F21 mean? | fault | 否 |
| 9 | zh | 逆变器的保修期是多久？ | warranty.zh | 否 |
| 10 | zh | 电池在保修范围内吗？ | warranty.zh | 否 |
| 11 | zh | 安装时并网点电压要求是多少？ | install.zh | 否 |
| 12 | zh | E03 是什么故障？ | fault | 否 |
| 13 | nl | Hoe lang is de garantie op de omvormer? | warranty.nl | 否 |
| 14 | nl | Zit de batterij ook in de garantie? | warranty.nl | 否 |
| 15 | nl | Hoe sluit ik de omvormer aan? | install.nl | 否 |
| 16 | nl | Wat betekent foutcode E07? | fault | 否 |
| 17 | es | ¿Cuánto dura la garantía del inversor? | warranty.es | 否 |
| 18 | es | ¿Cómo conecto el inversor a la red? | install.es | 否 |
| 19 | de | Welcher Wechselrichter ist im Set enthalten? | spec.de | 否 |
| 20 | zh | 阳台储能的额定功率是多少？ | spec.zh | 否 |
| 21 | nl | Kunnen jullie 20% korting geven? | — | **是** |
| 22 | de | Ist euer Produkt besser als der Wettbewerb? | — | **是** |
| 23 | en | Can you sign a supply contract with us? | — | **是** |
| 24 | zh | 能给我打个八折吗？ | — | **是** |
| 25 | zh | 你们和华为比哪个好？ | — | **是** |
| 26 | de | Können Sie die Lieferzeit auf 2 Wochen garantieren? | — | **是** |
| 27 | es | ¿Pueden darme un precio especial? | — | **是** |
| 28 | en | What is the stock price of your company? | — | **是** |
| 29 | nl | Geven jullie juridisch advies over contracten? | — | **是** |
| 30 | zh | 帮我写一份采购合同的违约条款 | — | **是** |

### 4.3 多轮附加 5 题（不计入 30，单独跑）

| # | 第一步（de/en） | 第二步 | 考察 |
|---|---|---|---|
| M1 | Welcher Wechselrichter ist im Set enthalten? | Und wie viel Watt? | 指代拼接 |
| M2 | How long is the warranty? | And for the battery? | 指代拼接 |
| M3 | Was bedeutet E03? | Und was soll ich jetzt tun? | 上下文延续 |
| M4 | 保修期多久？ | 电池也一样吗？ | 中文指代 |
| M5 | Hoe sluit ik hem aan? | En welke spanning? | 荷兰语指代 |

---

## 5. 演示脚本（3 分钟，录屏照此）

| 时间 | 动作 | 预期现象 |
|---|---|---|
| 0:00 | 打开 `/` | 9:16 手机框，德语界面 |
| 0:10 | 输入 `E03` | 1s 内出故障码卡：含义 / 严重度 / 三步 / 来源行（故障码表，无角标） |
| 0:30 | 再问一句德语问题，点回答里的角标 | 抽屉滑出，见文档名 + 第 12 页 + 原文高亮 |
| 0:45 | 关闭，切到 NL | 全站文案变荷兰语 |
| 0:55 | 问 `Zit de batterij ook in de garantie?` | 荷兰语回答，逐字出现，带角标 |
| 1:20 | 问 `Kunnen jullie 20% korting geven?` | 固定拒答话术 + 工单号 `WT-2026-000X` |
| 1:40 | 打开 `/console` | 队列 5s 内出现该单，SLA 倒计时 |
| 1:55 | 点开详情 | 对话全文 + 「⚠ 本轮无检索证据」标记 |
| 2:10 | 点「认领」 | 指派列变「张伟」 |
| 2:20 | 填回复 → Ctrl+Enter | 消息追加，状态 processing |
| 2:35 | 填 resolution → 关单 | 状态变 closed，从待处理列表消失 |
| 2:50 | 回到用户端查工单 | 状态「已关闭」 |

---

## 6. 手工验收清单

### 6.1 用户端

- [ ] 桌面打开是 9:16 手机框，两侧深色，不变形
- [ ] 390×844 无横向滚动
- [ ] 键盘弹出时输入框贴键盘，消息不被遮挡
- [ ] 角标视觉 18px，能点中（44 命中区）
- [ ] 抽屉下滑关闭、Esc 关闭、蒙层点击关闭
- [ ] 抽屉关闭后焦点回到原角标
- [ ] 拒答后工单号可复制
- [ ] 切语言后整页文案变化，无需刷新
- [ ] `prefers-reduced-motion` 下无位移动画
- [ ] 深色模式正文对比度肉眼可读

### 6.2 坐席端

- [ ] 新单 5s 内出现
- [ ] SLA 倒计时用等宽字体，不抖动
- [ ] SLA <1h 变红
- [ ] 点行进详情，URL 变 `#/ticket/{id}`
- [ ] 刷新页面回到同一工单
- [ ] 关单不填 resolution 时按钮禁用
- [ ] 引用可点开看原文
- [ ] 1440×810 下主操作无需滚动
- [ ] 1280×720 无横向滚动
- [ ] Tab 顺序 = 视觉顺序

### 6.3 通用

- [ ] 断网时用户端顶部出现黄条
- [ ] 429 时按钮禁用并倒计时
- [ ] 所有图标按钮有 `aria-label`
- [ ] `<html lang>` 随语言变化
- [ ] 浏览器控制台无 error

---

## 7. 指标门槛与判定

| 指标 | 门槛 | 未达标处置 |
|---|---|---|
| hit@5 | ≥ 0.70 | 按 `07-retrieval.md` §10 调参；先查语言过滤与归一化 |
| 引用合法率 | **= 1.00** | 这不是"越高越好"的指标：非法角标会整条降级为拒答（`06` §5.1 ④），所以只能是 1。低于 1 就说明后端校验没生效 |
| 拒答准确率 | ≥ 0.90 | 检查 `NO_ANSWER` 判定 + 引用为空判定 |
| 误拒率 | ≤ 0.10 | `RETRIEVAL_MIN_SCORE` 降到 0.22 |
| 首字 P95 | < 3s | 查 embedding 延迟、`thinkingLevel` 是否被改回默认 |
| 单会话成本 | < $0.03 | 查是否误用 pro 模型 |

**判定纪律**：连续两次调参后指标不升 → 停止调参，回到 `07-retrieval.md` §11 的自测用例，定位是检索坏了还是评测集标注错了。

---

## 8. 提交前门禁

```bash
make typecheck           # tsc --noEmit 零错误
bash scripts/verify.sh   # L1–L5 全过
npm run i18n:check       # 127/127
npm audit --audit-level=high   # 无 high
```

四项全绿才算完成。任一项红 → 不提交。
