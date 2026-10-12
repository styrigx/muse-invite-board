-- 留言板：messages 表，一条一行
-- 替换 KV 里单个 JSON 数组的读-改-写（并发会丢条）

CREATE TABLE IF NOT EXISTS messages (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  text TEXT NOT NULL CHECK (char_length(text) BETWEEN 2 AND 200),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS messages_created_at_idx ON messages (created_at DESC);

ALTER TABLE messages ENABLE ROW LEVEL SECURITY;

-- 公开读取：留言板是公开的
DROP POLICY IF EXISTS "messages_select_public" ON messages;
CREATE POLICY "messages_select_public" ON messages
  FOR SELECT TO anon USING (true);

-- 公开插入：长度由 CHECK 约束保证，频率由 Worker 限流
DROP POLICY IF EXISTS "messages_insert_public" ON messages;
CREATE POLICY "messages_insert_public" ON messages
  FOR INSERT TO anon WITH CHECK (char_length(text) BETWEEN 2 AND 200);

-- 不给 anon update/delete：留言不可改、不可删（由 service_role 清理）
