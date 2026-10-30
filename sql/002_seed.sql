-- ============================================================
-- 沃泰储能多语种客服 Agent · 种子数据
-- 权威内容来源：docs/prdv1.1/04-db.md §3
--
-- 幂等要求：本文件是 `make reset` 与容器初始化都会执行的部分，可能被连跑多次，
-- 所以每条 insert 都带 on conflict do nothing —— 重复执行的结果必须与第一次一致
-- （坐席 2 行、settings 无重复键、产品线 3 条）。
-- on conflict 依赖唯一约束：staff(email)、product_lines(code)、settings(key)。
--
-- 故障码**不在这里**：6 条完整五语在 `sql/003_faults_seed.sql`（09#02 / D13）。
-- 分开的理由：这份文件是"环境要有哪些配置"，那份是"知识库的初始内容"，
-- 内容会随语料演进而配置不会；混在一起会让 diff 读不出"这次改的是哪一类"。
-- ============================================================

set client_min_messages = warning;

-- 坐席（演示用；09#03 起**有真口令**，口令明文 `wt-demo-2026`，部署前必须改）
-- 哈希是 scrypt(N=16384,r=8,p=1,keylen=64)，盐每账号独立 16 字节；
-- 参数与 `src/core/auth-login.ts` 的 SCRYPT 常量必须一致，改一处要改两处。
--
-- 三个账号覆盖三个角色（09#04 起角色是真的会挡人，缺一个就有一整组接口没人能验）：
--   张伟 agent —— 只能看自己的队列、只能编辑故障卡 draft 之外啥也不行；
--   李娜 lead  —— 故障卡查看/编辑/建 draft、产品线只读；
--   王强 admin —— 发布/归档/产品线 CRUD/人员列表。
-- **顺序有意义**：`scripts/demo.ts` 与部分用例取"最早创建的 active 坐席"当默认认领人，
-- 新增账号一律追加在末尾，插在中间会把那些路径的默认坐席换成别人。
insert into staff (name, email, role, org_unit, password_hash, password_salt) values
  ('张伟', 'zhang.wei@wotai.demo', 'agent', 'cs',
   '70c7f14c43cbc13273812936b7e5f02a5084769f3ab5e389c3222b5588e2a5a326d3df6e29f8a321813e38d83bab37b09063e79f6ee2bcf3f93b31ba96ab0002',
   '2c0ec5f4704ecae5d6d1bc3bc23a7214'),
  ('李娜', 'li.na@wotai.demo', 'lead', 'cs',
   '08323064e94b5e4ecc18b671102d0984adec758b3fd46f7058639e6d27fbc44bef05523a6afbfd7b88b7609dc8e8571c54edbfffad8904a92ea9279694295864',
   '4811c3a8e4dc6c4c1d2bfbf794f02093'),
  ('王强', 'admin@wotai.demo', 'admin', 'cs',
   'f0a2bda62a3642fa5a810a00986dd1c525b5904e9afcbbe431211ac37012c5650eb548dd7740150cdc7731ff8e06ed32129826f560d60dab0630bf9bd65261d6',
   'a5d58ac428c9100d5af527fc4a84959e')
on conflict (email) do nothing;

-- 单层组织（09#03 / D9）。不做多级树，避免把 SLA 计算绑到组织层级上
insert into org_units (code, name) values ('cs', '客服组')
on conflict (code) do nothing;

-- 运行参数默认值
-- 注意：这些是"运行时覆盖层"，不是默认值的唯一来源 ——
-- 缺省值在 src/config.ts 常量与环境变量里，本表只是让二期能不改代码调参。
-- jsonb 用的是 JSON 字面量：数字/布尔不加引号，字符串要带双引号（见 prompt.version）。
insert into settings (key, value) values
  ('retrieval.top_k',        '5'),
  ('retrieval.min_score',    '0.30'),
  ('retrieval.vec_weight',   '0.8'),
  ('retrieval.fts_weight',   '0.2'),
  ('refusal.enabled',        'true'),
  ('prompt.version',         '"v1"'),
  ('safe_mode',              'false'),
  ('night_autoreply',        'true'),
  ('sla.hours',              '4'),
  ('par.slimit',             '5')
on conflict (key) do nothing;

-- 产品线字典（09#02 / D21）：管理端下拉的唯一来源。
-- `name` 是展示名，业务方可在管理端改；先给能认出产线的写法。
-- 三个 code 来自语料里出现过的 product_line（balcony / residential / cni）。
insert into product_lines (code, name) values
  ('balcony',     '阳台光储'),
  ('residential', '户用储能'),
  ('cni',         'CNI 系列')
on conflict (code) do nothing;
