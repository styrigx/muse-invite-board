-- 002：收紧 messages 写权限
-- 背景：anon key 是公开的；001 给了 anon INSERT 策略，任何人都能绕过 Worker
-- 直接 POST 到 Supabase REST 写入，绕过「每 IP 一条」和限流。
-- 改法：删掉 anon 插入策略并回收写权限；Worker 改用 SUPABASE_SERVICE_ROLE_KEY
-- （service_role 绕过 RLS）写入。留言仍公开可读（保留 messages_select_public）。
-- 注意：本迁移由站长在代码部署后手动执行（001 与旧留言导入已在生产跑过）。

DROP POLICY IF EXISTS "messages_insert_public" ON messages;
REVOKE INSERT, UPDATE, DELETE ON messages FROM anon, authenticated;
