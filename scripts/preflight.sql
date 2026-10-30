-- ============================================================
-- 数据层预检 —— 不参与 initdb，手动跑：
--   cat scripts/preflight.sql | ./data/scripts/db.sh psql
-- 目的：在任何代码落地前，一次问清"这套数据库能不能干活"
-- ============================================================

\echo '=== 1. PostgreSQL 版本（需 16.x） ==='
select version();

\echo '=== 2. pgvector 是否可用（阻断项，必须返回一行） ==='
select name,
       default_version,
       installed_version,
       case when installed_version is null then 'NOT INSTALLED（需 create extension vector）'
            else 'OK' end as verdict
from pg_available_extensions
where name = 'vector';

\echo '=== 3. 已装扩展 ==='
select extname, extversion from pg_extension order by extname;

\echo '=== 4. 排序规则（换基础镜像后要核对，不一致会导致索引损坏） ==='
select datname, datcollate, datctype
from pg_database
where datname = current_database();

\echo '=== 5. 时区（DB 内一律存 UTC，容器 TZ 只影响日志） ==='
show timezone;
select now() as db_now, now() at time zone 'UTC' as as_utc;

\echo '=== 6. 关键表是否已建（首次为空；建表后应见 18 张表 + 2 个视图） ==='
select table_type, count(*)
from information_schema.tables
where table_schema = 'public'
group by table_type
order by table_type;

\echo '=== 判定 ==='
\echo '第 2 项返回 0 行 → 镜像不对，换 pgvector/pgvector:pg16 后 destroy 重建'
\echo '第 4 项 collate 变化 → 必须 destroy，不要沿用旧 volume'
