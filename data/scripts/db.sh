#!/usr/bin/env bash
#
# 本地开发基础设施：PostgreSQL / Redis / MinIO 一键启停 + 连通性自检
# 用法见 ./db.sh help
#
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="$ROOT_DIR/.env"
ENV_EXAMPLE="$ROOT_DIR/.env.example"

cd "$ROOT_DIR"

C_RESET=''; C_RED=''; C_GREEN=''; C_YELLOW=''; C_CYAN=''; C_DIM=''
if [ -t 1 ]; then
  C_RESET=$'\033[0m'; C_RED=$'\033[31m'; C_GREEN=$'\033[32m'
  C_YELLOW=$'\033[33m'; C_CYAN=$'\033[36m'; C_DIM=$'\033[2m'
fi

info() { printf '%s\n' "$*"; }
ok()   { printf '%s✓%s %s\n' "$C_GREEN" "$C_RESET" "$*"; }
fail() { printf '%s✗%s %s\n' "$C_RED" "$C_RESET" "$*"; }
warn() { printf '%s!%s %s\n' "$C_YELLOW" "$C_RESET" "$*"; }
die()  { fail "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
本地开发基础设施脚本：PostgreSQL / Redis / MinIO

用法: ./db.sh <命令> [参数]

  up              启动全部服务，等待健康检查通过
  down            停止并删除容器（数据卷保留）
  destroy         停止并删除容器与数据卷（数据全部清空）
  restart [服务]   重启全部服务或指定服务
  status          查看容器状态
  check           连通性自检：容器状态 + 宿主机端口 + 真实读写探测
  env             打印应用可用的连接串（DATABASE_URL / REDIS_URL / S3_*）
  psql            进入 psql 交互终端（也可 ./db.sh psql -c 'select 1'）
  redis           进入 redis-cli 交互终端（也可 ./db.sh redis INFO server）
  mc [参数...]     在容器内执行 mc 命令（默认 mc ls local）
  logs [服务...]   跟踪日志，例如 ./db.sh logs postgres redis
  help            显示本帮助

服务名: postgres | redis | minio | minio-init
EOF
}

require_docker() {
  command -v docker >/dev/null 2>&1 || die "未找到 docker，请先安装 Docker Desktop"
  docker info >/dev/null 2>&1 || die "Docker 守护进程未运行，请启动 Docker Desktop 后重试"
  if docker compose version >/dev/null 2>&1; then
    DC=(docker compose)
  elif command -v docker-compose >/dev/null 2>&1; then
    DC=(docker-compose)
  else
    die "未找到 docker compose 插件或 docker-compose 命令"
  fi
}

ensure_env() {
  if [ ! -f "$ENV_FILE" ]; then
    [ -f "$ENV_EXAMPLE" ] || die "缺少 $ENV_EXAMPLE"
    cp "$ENV_EXAMPLE" "$ENV_FILE"
    warn "已根据 .env.example 生成 $ENV_FILE（开发默认口令，生产请修改）"
  fi
}

load_env() {
  ensure_env
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a

  : "${POSTGRES_USER:=wt}"
  : "${POSTGRES_PASSWORD:=wt_dev_pg_2024}"
  : "${POSTGRES_DB:=wt_dev}"
  : "${POSTGRES_PORT:=5432}"
  : "${REDIS_PASSWORD:=wt_dev_redis_2024}"
  : "${REDIS_PORT:=6379}"
  : "${MINIO_ROOT_USER:=wtadmin}"
  : "${MINIO_ROOT_PASSWORD:=wt_dev_minio_2024}"
  : "${MINIO_BUCKET:=wt-dev}"
  : "${MINIO_PORT:=9000}"
  : "${MINIO_CONSOLE_PORT:=9001}"
  : "${REGISTRY_MIRROR:=}"
  : "${POSTGRES_IMAGE:=postgres:16-alpine}"
  : "${REDIS_IMAGE:=redis:7-alpine}"
  : "${MINIO_IMAGE:=minio/minio:latest}"
  : "${MC_IMAGE:=minio/mc:latest}"

  apply_registry_mirror
}

# 给镜像加上加速地址前缀（留空则使用官方源），已带 registry 的镜像原样保留
mirror_ref() {
  local image="$1" mirror="$2"
  case "$image" in
    */*/*) printf '%s' "$image" ;;
    */*)   printf '%s/%s' "$mirror" "$image" ;;
    *)     printf '%s/library/%s' "$mirror" "$image" ;;
  esac
}

apply_registry_mirror() {
  local mirror="${REGISTRY_MIRROR%/}"
  [ -n "$mirror" ] || return 0
  export POSTGRES_IMAGE="$(mirror_ref "$POSTGRES_IMAGE" "$mirror")"
  export REDIS_IMAGE="$(mirror_ref "$REDIS_IMAGE" "$mirror")"
  export MINIO_IMAGE="$(mirror_ref "$MINIO_IMAGE" "$mirror")"
  export MC_IMAGE="$(mirror_ref "$MC_IMAGE" "$mirror")"
}

SERVICES=(postgres redis minio)

container_id() {
  "${DC[@]}" ps -a -q "$1" 2>/dev/null | tr -d '\r' | head -n1
}

# healthy / unhealthy / starting / running / exited / missing
service_state() {
  local cid
  cid="$(container_id "$1")"
  if [ -z "$cid" ]; then
    printf 'missing'
    return 0
  fi
  docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$cid" 2>/dev/null
}

wait_healthy() {
  local timeout="${1:-180}" elapsed=0 svc state pending
  info "${C_DIM}等待服务就绪（最多 ${timeout}s）...${C_RESET}"
  while :; do
    pending=""
    for svc in "${SERVICES[@]}"; do
      state="$(service_state "$svc")"
      case "$state" in
        healthy|running) : ;;
        *) pending="$pending $svc($state)" ;;
      esac
    done
    if [ -z "$pending" ]; then
      return 0
    fi
    if [ "$elapsed" -ge "$timeout" ]; then
      warn "等待超时，未就绪:$pending"
      return 1
    fi
    sleep 2
    elapsed=$((elapsed + 2))
  done
}

tcp_probe() {
  (exec 3<>"/dev/tcp/127.0.0.1/$1") >/dev/null 2>&1
}

# ---------- 真实读写探测（走容器自带的客户端，无需宿主机装 psql/redis-cli）----------

probe_postgres() {
  "${DC[@]}" exec -T postgres \
    psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -tAc 'select 1' 2>/dev/null \
    | tr -d '\r' | grep -qx '1'
}

probe_redis() {
  local out
  out="$("${DC[@]}" exec -T redis redis-cli --no-auth-warning -a "$REDIS_PASSWORD" \
    eval "redis.call('set', KEYS[1], 'ok'); return redis.call('get', KEYS[1])" 1 wt:healthcheck 2>/dev/null | tr -d '\r')"
  [ "$out" = "ok" ]
}

probe_minio() {
  "${DC[@]}" run --rm -T --no-deps minio-init >/dev/null 2>&1
}

cmd_up() {
  require_docker; load_env
  info "${C_CYAN}启动 PostgreSQL / Redis / MinIO ...${C_RESET}"
  "${DC[@]}" up -d --remove-orphans
  wait_healthy 180 || { "${DC[@]}" ps; return 1; }
  ok "全部服务已就绪"
  cmd_env
}

cmd_down() {
  require_docker; load_env
  "${DC[@]}" down
  ok "容器已停止（数据卷保留，如需清空请执行 ./db.sh destroy）"
}

cmd_destroy() {
  require_docker; load_env
  # `--yes` 给非交互调用方（`make reset`）。没有它时读一次确认：
  # 手工敲命令的人必须自己写 yes，脚本里漏传参数就会**取消**而不是删库 —— 失败方向安全。
  local assume_yes=0
  for arg in "$@"; do [ "$arg" = "--yes" ] && assume_yes=1; done
  if [ "$assume_yes" -ne 1 ]; then
    warn "将删除容器与全部数据卷，PostgreSQL / Redis / MinIO 数据都会丢失"
    printf '确认请输入 yes: '
    read -r answer || answer=""
    [ "$answer" = "yes" ] || { info "已取消"; return 0; }
  else
    warn "将删除容器与全部数据卷（--yes：非交互确认）"
  fi
  "${DC[@]}" down -v
  ok "容器与数据卷已删除"
}

cmd_restart() {
  require_docker; load_env
  if [ "$#" -eq 0 ]; then
    "${DC[@]}" restart
    wait_healthy 180 || return 1
  else
    "${DC[@]}" restart "$@"
  fi
  ok "重启完成"
}

cmd_status() {
  require_docker; load_env
  "${DC[@]}" ps -a
  printf '\n'
  local svc state
  for svc in "${SERVICES[@]}"; do
    state="$(service_state "$svc")"
    printf '  %-10s %s\n' "$svc" "$state"
  done
}

cmd_check() {
  require_docker; load_env
  local errors=0 svc state

  printf '\n%s\n' "== 容器状态 =="
  for svc in "${SERVICES[@]}"; do
    state="$(service_state "$svc")"
    if [ "$state" = "healthy" ] || [ "$state" = "running" ]; then
      ok "$svc ($state)"
    else
      fail "$svc ($state)"; errors=$((errors + 1))
    fi
  done

  printf '\n%s\n' "== 宿主机端口映射 =="
  local pair name port
  for pair in "postgres:$POSTGRES_PORT" "redis:$REDIS_PORT" "minio:$MINIO_PORT" "minio-console:$MINIO_CONSOLE_PORT"; do
    name="${pair%%:*}"; port="${pair##*:}"
    if tcp_probe "$port"; then
      ok "127.0.0.1:$port 可连接 ($name)"
    else
      fail "127.0.0.1:$port 不可连接 ($name)"; errors=$((errors + 1))
    fi
  done

  printf '\n%s\n' "== 读写探测 =="
  if probe_postgres; then
    ok "PostgreSQL 查询正常 ($POSTGRES_DB)"
  else
    fail "PostgreSQL 查询失败"; errors=$((errors + 1))
  fi
  if probe_redis; then
    ok "Redis 写入/读取正常 (SET/GET)"
  else
    fail "Redis 写入/读取失败"; errors=$((errors + 1))
  fi
  if probe_minio; then
    ok "MinIO 认证与 bucket 检查正常 ($MINIO_BUCKET)"
  else
    fail "MinIO 认证或 bucket 操作失败"; errors=$((errors + 1))
  fi

  printf '\n'
  if [ "$errors" -eq 0 ]; then
    ok "自检通过"
    return 0
  fi
  fail "自检发现 $errors 项异常，可用 ./db.sh logs <服务名> 查看原因"
  return 1
}

cmd_env() {
  load_env
  cat <<EOF

${C_CYAN}应用连接信息${C_RESET}
  PostgreSQL
    DATABASE_URL=postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@127.0.0.1:${POSTGRES_PORT}/${POSTGRES_DB}
    host=127.0.0.1 port=${POSTGRES_PORT} user=${POSTGRES_USER} db=${POSTGRES_DB} password=${POSTGRES_PASSWORD}
  Redis
    REDIS_URL=redis://:${REDIS_PASSWORD}@127.0.0.1:${REDIS_PORT}/0
  MinIO (S3 兼容)
    S3_ENDPOINT=http://127.0.0.1:${MINIO_PORT}
    S3_ACCESS_KEY=${MINIO_ROOT_USER}
    S3_SECRET_KEY=${MINIO_ROOT_PASSWORD}
    S3_BUCKET=${MINIO_BUCKET}
    S3_REGION=us-east-1
    控制台: http://127.0.0.1:${MINIO_CONSOLE_PORT}  (${MINIO_ROOT_USER} / ${MINIO_ROOT_PASSWORD})

${C_DIM}以上口令来自 $ENV_FILE${C_RESET}

EOF
}

tty_flags() {
  if [ -t 0 ] && [ -t 1 ]; then
    printf '%s' '-it'
  else
    printf '%s' '-T'
  fi
}

cmd_psql() {
  require_docker; load_env
  local flags; flags="$(tty_flags)"
  # shellcheck disable=SC2086
  exec "${DC[@]}" exec $flags postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" "$@"
}

cmd_redis() {
  require_docker; load_env
  local flags; flags="$(tty_flags)"
  # shellcheck disable=SC2086
  exec "${DC[@]}" exec $flags redis redis-cli --no-auth-warning -a "$REDIS_PASSWORD" "$@"
}

cmd_mc() {
  require_docker; load_env
  local flags args
  if [ "$#" -eq 0 ]; then
    args=(ls local)
  else
    args=("$@")
  fi
  flags="$(tty_flags)"
  # shellcheck disable=SC2086
  exec "${DC[@]}" run --rm $flags --no-deps --entrypoint sh minio-init -c \
    'mc alias set local http://minio:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null && exec mc "$@"' \
    sh "${args[@]}"
}

cmd_logs() {
  require_docker; load_env
  "${DC[@]}" logs -f --tail=100 "$@"
}

COMMAND="${1:-help}"
[ "$#" -gt 0 ] && shift

case "$COMMAND" in
  up)       cmd_up ;;
  down)     cmd_down ;;
  destroy)  cmd_destroy ;;
  restart)  cmd_restart "$@" ;;
  status)   cmd_status ;;
  check)    cmd_check ;;
  env)      cmd_env ;;
  psql)     cmd_psql "$@" ;;
  redis)    cmd_redis "$@" ;;
  mc)       cmd_mc "$@" ;;
  logs)     cmd_logs "$@" ;;
  help|-h|--help) usage ;;
  *)        fail "未知命令: $COMMAND"; printf '\n'; usage; exit 2 ;;
esac
