// Muse 邀请码自助共享站 — Cloudflare Worker
// 数据：Supabase (Postgres) via REST；限流：KV
// AI：Workers AI 每天生成一句推荐语（需绑定变量 AI + Cron Trigger: 0 1 * * *）
// Env: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, INVITE_KV, AI

const CODE_RE = /^[A-Z0-9]{6}$/;
const FLAG_HIDE = 3; // 被标记 3 次后隐藏
const EST_USES = 25; // 单个码预估可用次数（约 20-30 次），用于加权轮换

// 展示标记 KV：被标记 1 次即从跑马灯撤下展示（抽取池不受影响）；works 票可恢复展示
const pauseKey = (code) => `pause:${code}`;

// 加权轮换：被抽得越少的码权重越高（防烧码），新码权重最高；站长码额外加权
function weightOf(draws, isOwner) {
  return Math.max(1, EST_USES - (draws || 0)) * (isOwner ? OWNER_BOOST : 1);
}
function weightedPick(pool) {
  let total = 0;
  const ws = pool.map((c) => { const w = weightOf(c.draws, c.code === OWNER_CODE); total += w; return w; });
  let r = Math.random() * total;
  for (let i = 0; i < pool.length; i++) {
    r -= ws[i];
    if (r <= 0) return pool[i];
  }
  return pool[pool.length - 1];
}

// 站长的邀请码：融入网友码池一起抽取，但抽中权重更高（随被抽次数自然衰减，不会一直霸榜）
const OWNER_CODE = "J93R39";
const OWNER_BOOST = 5; // 站长码权重倍数

// 允许前端域名跨域调用
const ALLOWED_ORIGINS = [
  "https://muse-invite.styrigx.com",
];
function corsFor(req) {
  const origin = req.headers.get("Origin");
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGINS.includes(origin)
      ? origin
      : ALLOWED_ORIGINS[0],
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    Vary: "Origin",
  };
}

function sbHeaders(env) {
  return {
    apikey: env.SUPABASE_ANON_KEY,
    Authorization: "Bearer " + env.SUPABASE_ANON_KEY,
    "Content-Type": "application/json",
  };
}

// 留言写入走 service_role key（绕过 RLS）：anon key 是公开的，绝不能用于写入
function sbWriteHeaders(env) {
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  return {
    apikey: key,
    Authorization: "Bearer " + key,
    "Content-Type": "application/json",
  };
}

// 数据全部走 Supabase；KV 只保留做限流
async function getCodes(env) {
  const r = await fetch(
    env.SUPABASE_URL + "/rest/v1/codes?select=code,works,draws,flags,by,ts",
    { headers: sbHeaders(env) }
  );
  if (!r.ok) throw new Error("supabase read failed: " + r.status);
  return r.json();
}
async function sbInsertCode(env, code, by) {
  const r = await fetch(env.SUPABASE_URL + "/rest/v1/codes", {
    method: "POST",
    headers: { ...sbHeaders(env), Prefer: "return=minimal" },
    body: JSON.stringify({ code, by: by || "网友贡献" }),
  });
  return r.status; // 201 成功，409 已存在
}
// 站长码自举：库里没有就自动种入（仅首次触发一次），之后即融入码池参与加权抽取
// 署名已去除：站长码在展示层与网友贡献的码无区别
async function ensureOwnerCode(env) {
  const codes = await getCodes(env);
  const hit = codes.find((c) => c.code === OWNER_CODE);
  if (!hit) {
    await sbInsertCode(env, OWNER_CODE, "网友分享");
    return await getCodes(env);
  }
  if (hit.by !== "网友分享") {
    try { await sbPatchCode(env, OWNER_CODE, { by: "网友分享" }); hit.by = "网友分享"; } catch { /* 下次再试 */ }
  }
  return codes;
}
async function sbPatchCode(env, code, patch) {
  const r = await fetch(
    env.SUPABASE_URL + "/rest/v1/codes?code=eq." + encodeURIComponent(code),
    { method: "PATCH", headers: sbHeaders(env), body: JSON.stringify(patch) }
  );
  if (!r.ok) throw new Error("supabase write failed: " + r.status);
}
// 留言板：Supabase messages 表，一条一行（替代 KV 单个 JSON 数组的读-改-写）
async function getMessages(env) {
  const r = await fetch(
    env.SUPABASE_URL + "/rest/v1/messages?select=text,created_at&order=created_at.desc&limit=30",
    { headers: sbHeaders(env) }
  );
  if (!r.ok) throw new Error("supabase read failed: " + r.status);
  const rows = await r.json();
  return rows.map((m) => ({ text: m.text, ts: new Date(m.created_at).getTime() }));
}
async function sbInsertMessage(env, text) {
  const r = await fetch(env.SUPABASE_URL + "/rest/v1/messages", {
    method: "POST",
    headers: { ...sbWriteHeaders(env), Prefer: "return=minimal" },
    body: JSON.stringify({ text }),
  });
  if (!r.ok) throw new Error("supabase insert failed: " + r.status);
}

// 09-28 编码事故自修复：某次 dashboard 部署把 worker.js 的中文字符串弄成乱码，
// 导致 09-28 18:00 后提交的码 by 字段为乱码。这里幂等地修复，修完即空转。
async function fixByMojibake(env, codes) {
  const bad = codes.filter((c) => c.by !== "网友贡献" && c.by !== "网友分享");
  for (const c of bad) {
    try {
      await sbPatchCode(env, c.code, { by: "网友贡献" });
      c.by = "网友贡献";
    } catch { /* 下次再试 */ }
  }
}

// Workers AI：每天生成一句推荐语，存 KV
async function refreshTagline(env) {
  if (!env.AI) return;
  try {
    const r = await env.AI.run("@cf/meta/llama-3.1-8b-instruct", {
      prompt: "为一个\"Muse AI 邀请码共享站\"写一句 20 字以内的中文暖心推荐语，鼓励大家分享邀请码。只输出这一句话，不要引号和多余内容。",
      max_tokens: 64,
    });
    const text = String((r && r.response) || "").trim().slice(0, 60);
    if (text) await env.INVITE_KV.put("tagline", text);
  } catch (e) { /* 下次再试 */ }
}

// 简易限流：每个 IP 每 action 在 windowSec 内最多 max 次（KV 日限：submit/msg 专用；draw/vote 与每分钟限速叠加）
async function checkLimitKV(env, ip, action, max, windowSec) {
  const key = `rl:${action}:${ip}`;
  const n = parseInt((await env.INVITE_KV.get(key)) || "0", 10);
  if (n >= max) return false;
  await env.INVITE_KV.put(key, String(n + 1), { expirationTtl: windowSec });
  return true;
}

// 限流：Workers Rate Limiting 绑定（每分钟防刷，用于量大的 draw/vote）
// 每个 action 独立绑定，限额配在 wrangler.toml；binding 未配置或故障时放行，避免误伤正常用户
const RL_BINDINGS = { draw: "RL_DRAW", vote: "RL_VOTE" };
async function checkLimitRL(env, ip, action) {
  const limiter = env[RL_BINDINGS[action]];
  if (!limiter) return true;
  try {
    const { success } = await limiter.limit({ key: ip });
    return success;
  } catch {
    return true;
  }
}

// Turnstile 人机验证：提交邀请码时校验 token
async function verifyTurnstile(env, token, ip) {
  const secret = env.TURNSTILE_SECRET;
  if (!secret) return true; // 未配置密钥时放行，避免部署过渡期误伤正常提交
  try {
    const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ secret, response: token, remoteip: ip }),
    });
    const d = await r.json();
    return d.success === true;
  } catch { return false; }
}

function publicList(env, codes) {
  return (async () => {
    const vis = codes.filter((c) => c.flags < FLAG_HIDE);
    const paused = await Promise.all(vis.map((c) => env.INVITE_KV.get(pauseKey(c.code))));
    vis.forEach((c, i) => { c._paused = paused[i] === "1"; });
    return vis
      .sort((a, b) => b.works - a.works || b.ts - a.ts)
      .map(({ code, works, draws, flags, by, ts, _paused }) =>
        ({ code, works, draws, flags, by, ts, paused: _paused,
           estLeft: Math.max(0, EST_USES - (draws || 0)) }));
  })();
}

// 最近发放记录：KV 存最近 12 条 {code, ts}
const RECENT_KEY = "recent_draws";
async function logDraw(env, code) {
  try {
    const raw = await env.INVITE_KV.get(RECENT_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    arr.unshift({ code, ts: Date.now() });
    await env.INVITE_KV.put(RECENT_KEY, JSON.stringify(arr.slice(0, 12)));
  } catch { /* 记录失败不影响抽码 */ }
}
async function getRecent(env) {
  try {
    const raw = await env.INVITE_KV.get(RECENT_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

export default {
  async fetch(req, env) {
    const cors = corsFor(req); // 允许前端域名跨域调用
    const json = (obj, status = 200) =>
      new Response(JSON.stringify(obj), {
        status,
        headers: { "Content-Type": "application/json; charset=utf-8", ...cors },
      });
    try {
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }
    const url = new URL(req.url);
    const ip = req.headers.get("cf-connecting-ip") || "unknown";

    if (req.method === "GET" && url.pathname === "/api/codes") {
      const codes = await ensureOwnerCode(env);
      await fixByMojibake(env, codes);
      return json({
        codes: await publicList(env, codes),
        recent: await getRecent(env),
      });
    }

    // 留言板：Supabase messages 表；每 IP 限一条（KV 只做存在性检查）
    if (req.method === "GET" && url.pathname === "/api/messages") {
      const messages = await getMessages(env);
      return json({ messages });
    }

    if (req.method === "POST" && url.pathname === "/api/messages") {
      if (!env.SUPABASE_SERVICE_ROLE_KEY)
        return json({ error: "留言服务暂不可用" }, 503); // fail closed：缺 key 不退回 anon
      let body;
      try { body = await req.json(); } catch { return json({ error: "请求格式错误" }, 400); }
      const text = String(body.text || "").trim().slice(0, 200);
      if (text.length < 2) return json({ error: "留言太短了，多写几个字吧" }, 400);
      if (!(await checkLimitKV(env, ip, "msg", 5, 86400)))
        return json({ error: "今天留太多了，明天再来吧" }, 429);
      if (await env.INVITE_KV.get("msgip:" + ip))
        return json({ error: "每个 IP 只能留一条留言" }, 403);
      await sbInsertMessage(env, text);
      await env.INVITE_KV.put("msgip:" + ip, "1", { expirationTtl: 31536000 }); // 365 天后过期，避免永久残留
      return json({ ok: true });
    }

    if (req.method === "POST" && url.pathname === "/api/submit") {
      let body;
      try { body = await req.json(); } catch { return json({ error: "请求格式错误" }, 400); }
      const code = String(body.code || "").trim().toUpperCase();
      if (!CODE_RE.test(code)) return json({ error: "邀请码格式不对，应为 6 位字母/数字" }, 400);
      const token = String(body.token || "");
      if (!token) return json({ error: "请先完成人机验证" }, 403);
      if (!(await verifyTurnstile(env, token, ip)))
        return json({ error: "人机验证未通过，请重试" }, 403);
      if (!(await checkLimitKV(env, ip, "submit", 10, 86400)))
        return json({ error: "今天贡献太多了，明天再来吧" }, 429);
      const st = await sbInsertCode(env, code);
      if (st === 409) return json({ error: "这个邀请码已经在板子上了" }, 409);
      if (st !== 201) throw new Error("supabase insert failed: " + st);
      await env.INVITE_KV.delete(pauseKey(code)); // 新码清除历史暂停标记
      return json({ ok: true });
    }

    if (req.method === "POST" && url.pathname === "/api/draw") {
      if (!(await checkLimitRL(env, ip, "draw")))
        return json({ error: "抽太快了，稍后再来吧" }, 429);
      if (!(await checkLimitKV(env, ip, "draw", 30, 86400)))
        return json({ error: "今天抽太多了，明天再来吧" }, 429);
      const codes = await ensureOwnerCode(env);
      // 抽取池：只排除隐藏（3 次标记）的码；被标记的码仅撤下展示，仍可被抽到
      const pool = codes.filter((c) => c.flags < FLAG_HIDE);
      if (!pool.length) return json({ error: "码池里的码都被暂停或领完了，等网友贡献新的吧" }, 404);
      const pick = weightedPick(pool); // 加权轮换：被抽得少的优先
      await sbPatchCode(env, pick.code, { draws: pick.draws + 1 });
      await logDraw(env, pick.code); // 记一笔发放记录
      return json({ code: pick.code });
    }

    if (req.method === "POST" && url.pathname === "/api/vote") {
      let body;
      try { body = await req.json(); } catch { return json({ error: "请求格式错误" }, 400); }
      const code = String(body.code || "").trim().toUpperCase();
      const kind = body.kind;
      if (kind !== "works" && kind !== "flag") return json({ error: "参数错误" }, 400);
      if (!(await checkLimitRL(env, ip, "vote")))
        return json({ error: "点太快了，稍后再来吧" }, 429);
      if (!(await checkLimitKV(env, ip, "vote", 30, 86400)))
        return json({ error: "今天点太多了，明天再来吧" }, 429);
      const codes = await getCodes(env);
      const item = codes.find((c) => c.code === code);
      if (!item) return json({ error: "找不到这个邀请码" }, 404);
      if (kind === "works") {
        await sbPatchCode(env, code, { works: item.works + 1 });
        // 若该码曾被暂停，"能用"票可将其恢复发放（防恶意标记）
        const wasPaused = (await env.INVITE_KV.get(pauseKey(code))) === "1";
        if (wasPaused) await env.INVITE_KV.delete(pauseKey(code));
        return json({ ok: true, works: item.works + 1, flags: item.flags, unpaused: wasPaused });
      }
      if (code === OWNER_CODE) {
        // 站长码不吃标记：永远在池子里可抽
        return json({ ok: true, works: item.works, flags: item.flags, paused: false, ignored: true });
      }
      await sbPatchCode(env, code, { flags: item.flags + 1 });
      await env.INVITE_KV.put(pauseKey(code), "1"); // 1 次标记即撤下展示（仍在抽取池）
      return json({ ok: true, works: item.works, flags: item.flags + 1, paused: true });
    }

    return new Response("Not Found", { status: 404 });
    } catch (e) {
      return json({ error: "服务暂时不可用，请稍后再试" }, 500);
    }
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(refreshTagline(env));
  },
};