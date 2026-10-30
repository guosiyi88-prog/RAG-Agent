#!/usr/bin/env bash
# ============================================================
# scripts/backup.sh —— 数据库每日备份（PostgreSQL / wt_dev）
#
# 为什么必须有这个脚本：`make reset` 走 `db.sh destroy`，会连数据卷一起删；
# 而 `fault_codes` 里手工录的码、`fault_reports` 里积的待审、`tickets` 里的历史
# 都只活在 pgdata 那个卷里。没有 dump，误触一次就没了。
#
# 只备 Postgres。理由（写在二库分配方案里）：
#   - Redis 的内容本来就可丢（会话 / 限流 / 幂等），且有 AOF；
#   - MinIO 只存"原始文件"，它们本来就来自源码树（`corpus/`），真正不可恢复的是库。
# 反过来说：**检索不依赖 MinIO**（正文在 `chunks.content`），所以 MinIO 丢不影响问答。
#
# 用法：bash scripts/backup.sh
# 保留：最近 7 份（BACKUP_KEEP 可覆盖），按文件名时间戳排序删最旧的。
# 退出码：0 成功；1 备份失败；2 环境不对。
# ============================================================
set -uo pipefail
cd "$(dirname "$0")/.." || exit 2

CONTAINER=${BACKUP_CONTAINER:-wt-postgres}
DB=${POSTGRES_DB:-wt_dev}
PGUSER=${POSTGRES_USER:-wt}
KEEP=${BACKUP_KEEP:-7}
DIR=backup
STAMP=$(date +%Y%m%d_%H%M%S)
FILE="$DIR/wt_dev_$STAMP.dump"

mkdir -p "$DIR"

# 日志一行一条，带时间；同时打到 stdout，好让人手工跑时能看见。
log() {
  local line
  line="$(date '+%Y-%m-%d %H:%M:%S') $*"
  printf '%s\n' "$line" | tee -a "$DIR/backup.log"
}

if ! docker exec "$CONTAINER" pg_dump -U "$PGUSER" -d "$DB" -Fc >"$FILE" 2>>"$DIR/backup.log"; then
  log "FAIL pg_dump 失败（容器 $CONTAINER 在跑吗？先 ./data/scripts/db.sh up）"
  # 半截文件比没有文件更坏：恢复时会当成一份完整备份去试。
  rm -f "$FILE"
  exit 1
fi

if [ ! -s "$FILE" ]; then
  log "FAIL pg_dump 产出了空文件，已删除"
  rm -f "$FILE"
  exit 1
fi

# 保留策略：`ls -1t` 按 mtime 倒序，跳过最新 $KEEP 份，其余删掉。
# 用 mtime 而不是文件名比较：手工补跑会让时间戳顺序与"哪份最新"一致，不会误删。
REMOVED=0
while IFS= read -r old; do
  [ -n "$old" ] || continue
  rm -f "$old"
  REMOVED=$((REMOVED + 1))
done < <(ls -1t "$DIR"/wt_dev_*.dump 2>/dev/null | tail -n +$((KEEP + 1)))

SIZE=$(du -h "$FILE" | cut -f1)
log "OK $SIZE -> $FILE（保留最近 $KEEP 份，本次清理 $REMOVED 份）"

# 恢复方法（不许只写在 README 里，放这里让人在备份文件旁边就能看到）：
#   docker exec -i wt-postgres pg_restore -U wt -d wt_dev --clean --if-exists < backup/wt_dev_YYYYmmdd_HHMM.dump
exit 0
