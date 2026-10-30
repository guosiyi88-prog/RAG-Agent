#!/usr/bin/env bash
# ============================================================
# scripts/verify.sh —— 提交前门禁（`14-verification.md` §8 的四条命令 + §2 的 L1–L5 断言）
#
# 为什么需要这个脚本：门禁是"完成"的机器判据，它不能是四条要人记住的命令，也不能
# 假设宿主机装了 make / jq。本脚本只依赖 bash + curl + node（node 是项目自身的运行时），
# JSON 一律由 node 解析 —— 缺 jq 不失败，也**不允许**因此静默跳过检查。
#
# 九项检查（任一 fail → 退出码 1；skip = 未验证，不算通过）：
#   G1 类型检查      npx tsc --noEmit 零错误
#   G2 断言脚本      node --test --test-concurrency=1（**必须串行**：tests 共享一套数据层）
#   G3 文案校验      scripts/check-i18n.ts 全绿（五语 127/127）
#   G4 依赖审计      npm audit --omit=dev --audit-level=high 无 high/critical（**只读**）
#   L1 探活          /healthz 四项为真（pg/redis/minio/pi）
#   L2 数据          五语片段齐、无空向量、无超长块
#   L3 检索          正例有命中、反例融合分 < 0.30
#   L4 对话          SSE 有 meta / delta / done 三帧
#   L5 拒答          超纲题出 refusal 帧且工单 +1
#
# 用法：
#   bash scripts/verify.sh             # 全量（提交前就跑这个）
#   bash scripts/verify.sh --no-tests  # 跳过 G2 全量测试（其余八项照跑；多 agent 并行改库时用）
#   bash scripts/verify.sh --fast      # 再用一层：再跳过 L4/L5 对话流（改前端/文档时用）
#
# 关于 L1 的"冷启动"：`pi` 探的是"本进程至少装配过一次 AgentSession"（见 `src/routes.ts`），
# 所以刚起来的服务会报 pi=false。这不是故障，脚本会先把它记为待复检，等 L4 跑完一轮真实
# 对话后再看一次 —— 复检仍为 false 才算 fail。
# ============================================================
set -u
set -o pipefail

cd "$(dirname "$0")/.." || exit 2

API=${API:-http://127.0.0.1:8000}
FAST=0
NOTESTS=0
for arg in "$@"; do
  case "$arg" in
    --fast) FAST=1 ;;
    --no-tests) NOTESTS=1 ;;
    -h | --help)
      sed -n '2,32p' "$0"
      exit 0
      ;;
    *)
      printf '未知参数：%s（支持 --fast / --no-tests）\n' "$arg" >&2
      exit 2
      ;;
  esac
done
[ "$FAST" = 1 ] && NOTESTS=1

for bin in node npm curl; do
  command -v "$bin" >/dev/null 2>&1 || {
    printf '缺少依赖命令：%s\n' "$bin" >&2
    exit 2
  }
done

OK=0
FAIL=0
SKIP=0
FAILED_NAMES=()
SKIPPED_NAMES=()
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

pass() {
  printf '[ok]   %s\n' "$1"
  OK=$((OK + 1))
}

fail_check() {
  printf '[fail] %s\n' "$1"
  FAIL=$((FAIL + 1))
  FAILED_NAMES+=("$1")
}

skip_check() {
  printf '[skip] %s（未验证）\n' "$1"
  SKIP=$((SKIP + 1))
  SKIPPED_NAMES+=("$1")
}

section() { printf '\n== %s\n' "$1"; }

# 从 stdin 读 JSON，按点号路径取标量，写到 stdout（null/缺失 → 空串，非 JSON → 退出码 3）。
# 用 node 而不是 jq：本机不保证有 jq，而 node 是项目自身的运行时。
json_get() {
  node -e '
    const path = process.argv[1].split(".");
    let raw = "";
    process.stdin.on("data", (d) => (raw += d)).on("end", () => {
      let v;
      try { v = JSON.parse(raw); } catch { process.exit(3); }
      for (const k of path) { if (v === null || v === undefined) break; v = v[k]; }
      process.stdout.write(v === null || v === undefined ? "" : String(v));
    });
  ' "$1"
}

# 所有 SQL 统一走数据层的 psql（宿主不需要装 psql，也不用手工导 PGPASSWORD），
# 连接串变量名是 DATABASE_URL，不是 PG_URL（`13-ops.md` §2.3）。
q() { ./data/scripts/db.sh psql -tAc "$1" 2>/dev/null | tr -d '\r'; }

# ── 服务可用性（一次探测，多处复用）──────────────────────────
# HEALTH = up | ok | cold | down
#   up   服务起来了但四项未全真（cold 之外的情况）
#   ok   /healthz 返回 ok:true（四项全真）
#   cold pg/redis/minio 真、pi 假 —— "本进程还没装配过会话"，可复检
#   down 连不上（服务没起）
probe_healthz() {
  local out code body
  out=$(curl -s -m 5 -w '\n%{http_code}' "$API/healthz" 2>/dev/null) || {
    HEALTH=down
    HEALTH_BODY=""
    return
  }
  code=${out##*$'\n'}
  body=${out%$'\n'*}
  HEALTH_BODY=$body
  if [ "$code" = "000" ] || [ -z "$code" ]; then
    HEALTH=down
    return
  fi
  local ok pg redis minio pi
  ok=$(printf '%s' "$body" | json_get ok)
  pg=$(printf '%s' "$body" | json_get checks.pg)
  redis=$(printf '%s' "$body" | json_get checks.redis)
  minio=$(printf '%s' "$body" | json_get checks.minio)
  pi=$(printf '%s' "$body" | json_get checks.pi)
  if [ "$ok" = "true" ] && [ "$pg" = "true" ] && [ "$redis" = "true" ] && [ "$minio" = "true" ] && [ "$pi" = "true" ]; then
    HEALTH=ok
  elif [ "$pg" = "true" ] && [ "$redis" = "true" ] && [ "$minio" = "true" ] && [ "$pi" = "false" ]; then
    HEALTH=cold
  else
    HEALTH=up
  fi
}

# 取一个匿名会话令牌；失败输出空串（限流 429 也算失败 —— 那是环境问题，要看见）。
new_session() {
  local body token
  body=$(curl -s -m 10 -X POST "$API/api/session" 2>/dev/null) || return
  token=$(printf '%s' "$body" | json_get data.token)
  printf '%s' "$token"
}

# 打一轮对话，SSE 落到 $3。返回 0 = 拿到流；1 = 会话池满（重试 3 次仍 SESSION_BUSY）。
# 为什么要重试：单实例并发上限 5、闲置 10 分钟才回收（`16 §6` L2），而门禁自己每跑一次就占
# 一个槽位。这是容量现象，不是对话链路故障 —— 但也不能装成通过，所以重试失败后要报清楚。
run_chat() { # $1=token $2=body $3=outfile
  local attempt=0
  while [ "$attempt" -lt 3 ]; do
    attempt=$((attempt + 1))
    curl -sN -m 90 -X POST "$API/api/chat" -H 'content-type: application/json' \
      -H "X-User-Session: $1" -d "$2" >"$3" 2>/dev/null || true
    if grep -q '"code":"SESSION_BUSY"' "$3" 2>/dev/null; then
      printf '  （会话池已满，5s 后重试 %d/3）\n' "$attempt"
      sleep 5
      continue
    fi
    return 0
  done
  return 1
}

printf '提交前门禁 · %s\n' "$(date '+%Y-%m-%d %H:%M:%S')"
if [ "$FAST" = 1 ]; then
  MODE='fast（跳过 G2/L4/L5）'
elif [ "$NOTESTS" = 1 ]; then
  MODE='跳过 G2（只跑其余八项）'
else
  MODE='全量'
fi
printf 'API=%s  模式=%s\n' "$API" "$MODE"

# ────────────────────────── G1 类型检查 ──────────────────────────
section "G1 类型检查"
if npx tsc --noEmit >"$TMP/tsc.log" 2>&1; then
  pass "G1 tsc --noEmit 零错误"
else
  printf '%s\n' "$(tail -n 20 "$TMP/tsc.log")"
  fail_check "G1 tsc --noEmit 有错误（见上）"
fi

# ────────────────────────── G2 断言脚本 ──────────────────────────
section "G2 断言脚本（node:test，串行）"
if [ "$NOTESTS" = 1 ]; then
  skip_check "G2 node --test --test-concurrency=1（--no-tests/--fast 跳过；全量由主线统一跑）"
else
  # 串行是硬要求：tests 共享同一套数据层（pg/redis/minio），并发跑会互相污染计数。
  if node --test --test-concurrency=1 >"$TMP/test.log" 2>&1; then
    pass "G2 node --test 全过（$(grep -E '^# pass ' "$TMP/test.log" | tail -n 1 | tr -s ' ')）"
  else
    grep -E '^# (pass|fail|cancelled) ' "$TMP/test.log" | tail -n 3
    grep -E '^not ok ' "$TMP/test.log" | head -n 20
    fail_check "G2 node --test 有失败用例（见上）"
  fi
fi

# ────────────────────────── G3 文案校验 ──────────────────────────
section "G3 文案校验（五语 127/127）"
if node --env-file-if-exists=.env scripts/check-i18n.ts >"$TMP/i18n.log" 2>&1; then
  pass "G3 check-i18n 全绿（$(grep -E '^结论：' "$TMP/i18n.log" | tail -n 1)）"
else
  grep -E '^\[(fail|ok)\]   ?(summary|file)' "$TMP/i18n.log" | head -n 20
  tail -n 5 "$TMP/i18n.log"
  fail_check "G3 check-i18n 未通过（见上）"
fi

# ────────────────────────── G4 依赖审计 ──────────────────────────
section "G4 依赖审计（只读，不自动 fix）"
# `--audit-level=high` 只在出现 high/critical 时退出码非零；moderate/low 不拦。
# 这里**绝不**跑 `npm audit fix`：它会改 package-lock，把"门禁"变成"改依赖"。
if npm audit --omit=dev --audit-level=high >"$TMP/audit.log" 2>&1; then
  pass "G4 npm audit 无 high/critical"
else
  summary=$(grep -E '^[0-9]+ vulnerabilities?|^found [0-9]+' "$TMP/audit.log" | tail -n 1)
  if [ -z "$summary" ]; then
    # 没有漏洞汇总行 = 网络/registry 问题，不能当成"有漏洞"，也不能当成通过
    tail -n 5 "$TMP/audit.log"
    fail_check "G4 npm audit 跑不起来（网络或 registry 问题，见上）"
  else
    printf '  %s\n' "$summary"
    grep -E '^[[:space:]]*Severity: (high|critical)' -B 1 "$TMP/audit.log" | grep -vE '^--$' | sed 's/^/  /'
    fail_check "G4 npm audit 有 high/critical（$summary；不自动 fix，见 docs/output/gate.md）"
  fi
fi

# ────────────────────────── 服务探活（L1 的前半）──────────────────
probe_healthz
case "$HEALTH" in
  ok) ;;
  cold)
    printf '\n（/healthz pi=false：本进程还没装配过 AgentSession，L4 跑完一轮对话后复检）\n'
    ;;
  up)
    printf '\n（/healthz 四项未全真：%s）\n' "$HEALTH_BODY"
    ;;
esac
if [ "$HEALTH" = "down" ]; then
  printf '\n（连不上 %s：L1/L3/L4/L5 全部跳过并标"未验证"；先起服务再跑门禁）\n' "$API"
fi

# ────────────────────────── L1 探活 ──────────────────────────
section "L1 探活 /healthz"
L1_DEFERRED=0
case "$HEALTH" in
  ok) pass "L1 /healthz ok:true（pg/redis/minio/pi 四项为真）" ;;
  cold)
    L1_DEFERRED=1 # 复检在 L4 之后，见文件头
    printf '  pi=false：本进程还没装配过 AgentSession（冷启动），等 L4 跑完一轮对话后复检\n'
    ;;
  up) fail_check "L1 /healthz 未全真：$HEALTH_BODY" ;;
  down) skip_check "L1 /healthz（服务未启动）" ;;
esac

# ────────────────────────── L2 数据 ──────────────────────────
section "L2 数据（SQL 计数）"
if [ "$(q 'select 1')" != "1" ]; then
  skip_check "L2 数据层不可达（./data/scripts/db.sh psql 连不上）"
else
  l2_fail=0
  langs=$(q 'select count(distinct lang) from chunks')
  [ "$langs" = "5" ] || {
    printf '  五语片段：期望 5，实际 %s\n' "${langs:-<空>}"
    l2_fail=1
  }
  nulls=$(q 'select count(*) from chunks where embedding is null')
  [ "$nulls" = "0" ] || {
    printf '  空向量片段：期望 0，实际 %s\n' "${nulls:-<空>}"
    l2_fail=1
  }
  longs=$(q 'select count(*) from chunks where length(content) > 2000')
  [ "$longs" = "0" ] || {
    printf '  超长片段（>2000 字符）：期望 0，实际 %s\n' "${longs:-<空>}"
    l2_fail=1
  }
  if [ "$l2_fail" = 0 ]; then
    pass "L2 五语片段齐（langs=5）、无空向量、无超长块"
  else
    fail_check "L2 数据断言未过（见上；先跑 make ingest）"
  fi
fi

# ────────────────────────── L3 检索 ──────────────────────────
section "L3 检索（/internal/search 正例 + 反例）"
if [ "$HEALTH" = "down" ]; then
  skip_check "L3 检索（服务未启动）"
elif [ -z "${INTERNAL_TOKEN:-}" ] && [ -z "$(node --env-file-if-exists=.env -p 'process.env.INTERNAL_TOKEN ?? ""' 2>/dev/null)" ]; then
  skip_check "L3 检索（.env 里没有 INTERNAL_TOKEN）"
else
  IT=${INTERNAL_TOKEN:-$(node --env-file-if-exists=.env -p 'process.env.INTERNAL_TOKEN ?? ""' 2>/dev/null)}
  pos=$(curl -s -m 20 -X POST "$API/internal/search" -H "X-Internal-Token: $IT" \
    -H 'content-type: application/json' \
    -d '{"query":"E03 Netzspannung","lang":"de","top_k":5}' 2>/dev/null)
  pos_n=$(printf '%s' "$pos" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);console.log(Array.isArray(j.data&&j.data.chunks)?j.data.chunks.length:0)}catch{console.log(-1)}})')
  neg=$(curl -s -m 20 -X POST "$API/internal/search" -H "X-Internal-Token: $IT" \
    -H 'content-type: application/json' \
    -d '{"query":"今天天气怎么样","lang":"zh","top_k":5}' 2>/dev/null)
  neg_score=$(printf '%s' "$neg" | json_get data.topScore)
  neg_n=$(printf '%s' "$neg" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);console.log(Array.isArray(j.data&&j.data.chunks)?j.data.chunks.length:0)}catch{console.log(-1)}})')
  # 反例判据（14 §2 / §3）：要么没候选，要么融合分低于 0.30。
  # 只看"分低"不够：无向量命中的查询会走 fts 兜底，chunks 非空是正常的。
  neg_ok=$(awk -v s="$neg_score" -v n="$neg_n" 'BEGIN{ if (n==0 || (s!="" && s+0 < 0.30)) print "1"; else print "0" }')
  if [ "${pos_n:-0}" -ge 1 ] 2>/dev/null && [ "$neg_ok" = "1" ]; then
    pass "L3 正例 chunk=${pos_n}、反例 topScore=${neg_score:-n/a}/chunks=${neg_n}"
  else
    printf '  正例 chunks=%s（期望 ≥1）、反例 topScore=%s chunks=%s（期望空或 <0.30）\n' \
      "${pos_n:-?}" "${neg_score:-?}" "${neg_n:-?}"
    fail_check "L3 检索断言未过（见上）"
  fi
fi

# ────────────────────────── L4 对话 SSE ──────────────────────────
section "L4 对话流（/api/chat SSE）"
UT=""
CONV=""
if [ "$HEALTH" = "down" ]; then
  skip_check "L4 对话流（服务未启动）"
elif [ "$FAST" = 1 ]; then
  skip_check "L4 对话流（--fast 跳过：会真调模型）"
else
  UT=$(new_session)
  if [ -z "$UT" ]; then
    fail_check "L4 取不到会话令牌（POST /api/session 失败；看服务日志与 Redis）"
  else
    # 整条流落到临时文件再判定：`head -c` 截断会把 `done` 帧剪掉（德语的保修回答就有几 KB），
    # 那是断言口径的问题，不是服务故障。`-m 90` 兜住"流不结束"（CHAT_TIMEOUT_MS 默认 30s）。
    if ! run_chat "$UT" '{"text":"Garantie Batterie","lang":"de"}' "$TMP/chat4.sse"; then
      printf '  %s\n' "$(tail -c 300 "$TMP/chat4.sse")"
      fail_check "L4 会话池满（PARALLEL_LIMIT=5，闲置 10 分钟回收）：重启服务或等一会儿重跑；不是对话链路故障"
      UT=""
    else
      missing=""
      grep -q 'event: meta' "$TMP/chat4.sse" || missing="$missing meta"
      grep -q 'event: delta' "$TMP/chat4.sse" || missing="$missing delta"
      grep -q 'event: done' "$TMP/chat4.sse" || missing="$missing done"
      if [ -z "$missing" ]; then
        # 记下这条会话的 conv_id：L5 复用它，避免再向会话池要一个槽位。
        CONV=$(grep -m1 '^data: ' "$TMP/chat4.sse" | sed 's/^data: //' | json_get conv_id)
        pass "L4 SSE 三帧齐全（meta/delta/done，$(wc -c <"$TMP/chat4.sse" | tr -d ' ') 字节）"
      else
        printf '  缺少帧：%s\n' "$missing"
        tail -c 400 "$TMP/chat4.sse"
        printf '\n'
        fail_check "L4 对话流不完整（缺：$missing）"
      fi
    fi
  fi
fi

# ────────────────────────── L5 拒答 + 建单 ──────────────────────────
section "L5 拒答 + 建单（超纲题）"
if [ "$HEALTH" = "down" ]; then
  skip_check "L5 拒答（服务未启动）"
elif [ "$FAST" = 1 ]; then
  skip_check "L5 拒答（--fast 跳过：会真调模型）"
elif [ "$(q 'select 1')" != "1" ]; then
  skip_check "L5 拒答（数据层不可达，数不了工单）"
else
  [ -n "$UT" ] || UT=$(new_session)
  if [ -z "$UT" ]; then
    fail_check "L5 取不到会话令牌"
  else
    before=$(q 'select count(*) from tickets')
    # 复用 L4 的会话（同一个 conv_id → 同一个池槽位）。另起会话会在池接近上限时命中
    # SESSION_BUSY（503），那时红的是环境而不是拒答逻辑。
    body='{"text":"Kunnen jullie 20% korting geven?","lang":"nl"'
    [ -n "$CONV" ] && body="$body,\"conv_id\":\"$CONV\""
    body="$body}"
    if ! run_chat "$UT" "$body" "$TMP/chat5.sse"; then
      printf '  %s\n' "$(tail -c 300 "$TMP/chat5.sse")"
      fail_check "L5 会话池满（PARALLEL_LIMIT=5）：重启服务或等一会儿重跑；不是拒答链路故障"
    else
      after=$(q 'select count(*) from tickets')
      refused=no
      grep -q 'event: refusal' "$TMP/chat5.sse" && refused=yes
      if [ "$refused" = "yes" ] && [ -n "$before" ] && [ -n "$after" ] && [ "$after" -gt "$before" ] 2>/dev/null; then
        pass "L5 出 refusal 帧且工单 +$((after - before))（$before→$after）"
      else
        printf '  refusal 帧=%s、工单数 %s→%s\n' "$refused" "${before:-?}" "${after:-?}"
        tail -c 400 "$TMP/chat5.sse"
        printf '\n'
        fail_check "L5 拒答或建单断言未过（见上）"
      fi
    fi
  fi
fi

# ────────────────────────── L1 复检（冷启动的 pi）──────────────────
if [ "$L1_DEFERRED" = "1" ]; then
  section "L1 复检（首轮对话后）"
  probe_healthz
  if [ "$HEALTH" = "ok" ]; then
    pass "L1 /healthz ok:true（pi 在首轮对话后转 true）"
  elif [ "$HEALTH" = "cold" ]; then
    fail_check "L1 /healthz pi 仍为 false（一轮真实对话都没装配出会话，见服务日志）"
  else
    fail_check "L1 /healthz 复检未通过：$HEALTH_BODY"
  fi
fi

# ────────────────────────── 汇总 ──────────────────────────
printf '\n────────────────────────────────────────\n'
printf '门禁结果：ok=%d  fail=%d  skip=%d\n' "$OK" "$FAIL" "$SKIP"
if [ "$FAIL" -gt 0 ]; then
  printf '失败项：\n'
  for name in "${FAILED_NAMES[@]}"; do printf '  - %s\n' "$name"; done
fi
if [ "$SKIP" -gt 0 ]; then
  printf '跳过项（未验证，不等于通过）：\n'
  for name in "${SKIPPED_NAMES[@]}"; do printf '  - %s\n' "$name"; done
fi
if [ "$FAIL" -eq 0 ] && [ "$SKIP" -eq 0 ]; then
  printf '全部通过。\n'
  exit 0
fi
if [ "$FAIL" -gt 0 ]; then
  printf '门禁未通过（任一 fail → 不提交）。\n'
  exit 1
fi
printf '门禁未完整验证（有 %d 项跳过）：起服务后重跑，或用 --fast 明确接受这份子集。\n' "$SKIP"
exit 0
