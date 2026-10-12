// 缺 SUPABASE_SERVICE_ROLE_KEY 时，POST /api/messages 必须 503 fail closed，
// 且不得访问 Supabase（fetch 不被调用），不退回 anon key。
// 运行：node --test tests/messages-503.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const workerSrc = readFileSync(join(here, "..", "worker.js"), "utf8");
// worker.js 是 Workers 入口（export default），拷一份 .mjs 后缀以便 Node 直接 import
const dir = mkdtempSync(join(tmpdir(), "invite-503-"));
const modPath = join(dir, "worker.mjs");
writeFileSync(modPath, workerSrc);
const worker = (await import(pathToFileURL(modPath).href)).default;

function makeEnv() {
  const kv = new Map();
  return {
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_ANON_KEY: "anon-key",
    // SUPABASE_SERVICE_ROLE_KEY 故意不给
    INVITE_KV: {
      get: async (k) => kv.get(k) ?? null,
      put: async (k, v) => { kv.set(k, v); },
      delete: async (k) => { kv.delete(k); },
    },
  };
}

test("POST /api/messages without SUPABASE_SERVICE_ROLE_KEY -> 503, no Supabase fetch", async () => {
  let fetchCalled = false;
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    fetchCalled = true;
    throw new Error("fetch must not be called");
  };
  try {
    const req = new Request("https://worker.test/api/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "hello world" }),
    });
    const res = await worker.fetch(req, makeEnv());
    assert.equal(res.status, 503);
    assert.equal(fetchCalled, false);
  } finally {
    globalThis.fetch = origFetch;
  }
});
