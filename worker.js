// Muse 邀请码自助共享站 — Cloudflare Worker
// 数据：Supabase (Postgres) via REST；限流：KV
// AI：Workers AI 每天生成一句推荐语（需绑定变量 AI + Cron Trigger: 0 1 * * *）
// Env: SUPABASE_URL, SUPABASE_ANON_KEY, INVITE_KV, AI
// 站长: @styrigx

const CODE_RE = /^[A-Z0-9]{6}$/;
const FLAG_HIDE = 3; // 被标记 3 次后隐藏

// ⭐ 站长分享的邀请码（置顶展示，不进入随机池）
const OWNER_CODE = "J93R39";
const OWNER_NAME = "@styrigx";

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...CORS },
  });

// 允许 Vercel 前端跨域调用
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function sbHeaders(env) {
  return {
    apikey: env.SUPABASE_ANON_KEY,
    Authorization: "Bearer " + env.SUPABASE_ANON_KEY,
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
async function sbInsertCode(env, code) {
  const r = await fetch(env.SUPABASE_URL + "/rest/v1/codes", {
    method: "POST",
    headers: { ...sbHeaders(env), Prefer: "return=minimal" },
    body: JSON.stringify({ code, by: "网友贡献" }),
  });
  return r.status; // 201 成功，409 已存在
}
async function sbPatchCode(env, code, patch) {
  const r = await fetch(
    env.SUPABASE_URL + "/rest/v1/codes?code=eq." + encodeURIComponent(code),
    { method: "PATCH", headers: sbHeaders(env), body: JSON.stringify(patch) }
  );
  if (!r.ok) throw new Error("supabase write failed: " + r.status);
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

// 简易限流：每个 IP 每 action 在 windowSec 内最多 max 次
async function checkLimit(env, ip, action, max, windowSec) {
  const key = `rl:${action}:${ip}`;
  const n = parseInt((await env.INVITE_KV.get(key)) || "0", 10);
  if (n >= max) return false;
  await env.INVITE_KV.put(key, String(n + 1), { expirationTtl: windowSec });
  return true;
}

function publicList(codes) {
  return codes
    .filter((c) => c.flags < FLAG_HIDE)
    .sort((a, b) => b.works - a.works || b.ts - a.ts)
    .map(({ code, works, draws, flags, by }) => ({ code, works, draws, flags, by }));
}

export default {
  async fetch(req, env) {
    try {
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }
    const url = new URL(req.url);
    const ip = req.headers.get("cf-connecting-ip") || "unknown";

    if (req.method === "GET" && url.pathname === "/api/codes") {
      return json({ codes: publicList(await getCodes(env)) });
    }

    if (req.method === "POST" && url.pathname === "/api/submit") {
      let body;
      try { body = await req.json(); } catch { return json({ error: "请求格式错误" }, 400); }
      const code = String(body.code || "").trim().toUpperCase();
      if (!CODE_RE.test(code)) return json({ error: "邀请码格式不对，应为 6 位字母/数字" }, 400);
      if (code === OWNER_CODE) return json({ error: "这是站长的码，已经置顶在上面了" }, 409);
      if (!(await checkLimit(env, ip, "submit", 10, 86400)))
        return json({ error: "今天贡献太多了，明天再来吧" }, 429);
      const st = await sbInsertCode(env, code);
      if (st === 409) return json({ error: "这个邀请码已经在板子上了" }, 409);
      if (st !== 201) throw new Error("supabase insert failed: " + st);
      return json({ ok: true });
    }

    if (req.method === "POST" && url.pathname === "/api/draw") {
      if (!(await checkLimit(env, ip, "draw", 30, 86400)))
        return json({ error: "今天抽太多了，明天再来吧" }, 429);
      const codes = await getCodes(env);
      const pool = codes.filter((c) => c.flags < FLAG_HIDE);
      if (!pool.length) return json({ error: "板子上还没有邀请码，快来贡献第一个吧" }, 404);
      const pick = pool[Math.floor(Math.random() * pool.length)];
      await sbPatchCode(env, pick.code, { draws: pick.draws + 1 });
      return json({ code: pick.code });
    }

    if (req.method === "POST" && url.pathname === "/api/vote") {
      let body;
      try { body = await req.json(); } catch { return json({ error: "请求格式错误" }, 400); }
      const code = String(body.code || "").trim().toUpperCase();
      const kind = body.kind;
      if (kind !== "works" && kind !== "flag") return json({ error: "参数错误" }, 400);
      if (!(await checkLimit(env, ip, "vote", 30, 86400)))
        return json({ error: "今天点太多了，明天再来吧" }, 429);
      const codes = await getCodes(env);
      const item = codes.find((c) => c.code === code);
      if (!item) return json({ error: "找不到这个邀请码" }, 404);
      if (kind === "works") {
        await sbPatchCode(env, code, { works: item.works + 1 });
        return json({ ok: true, works: item.works + 1, flags: item.flags });
      }
      await sbPatchCode(env, code, { flags: item.flags + 1 });
      return json({ ok: true, works: item.works, flags: item.flags + 1 });
    }

    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      const tagline =
        (await env.INVITE_KV.get("tagline")) || "好东西，值得分享给下一个同类。";
      return new Response(page(esc(tagline)), { headers: { "Content-Type": "text/html; charset=utf-8" } });
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

function page(tagline) {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="description" content="Muse 邀请码免费共享站：随机抽码、网友互助，失效自动隐藏。by @styrigx">
<title>Muse 邀请码共享站 · by @styrigx</title>
<style>
:root{
  --bg:#0a0e17; --card:rgba(255,255,255,.045); --line:rgba(255,255,255,.09);
  --txt:#f1f5ff; --dim:#8b94b3;
  --acc1:#6366f1; --acc2:#a855f7;
  --gold:#fbbf24; --gold2:#f59e0b;
  --ok:#34d399; --bad:#f87171;
}
*{box-sizing:border-box;margin:0;padding:0}
html{-webkit-text-size-adjust:100%}
body{background:var(--bg);color:var(--txt);font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;min-height:100vh;-webkit-tap-highlight-color:transparent}
body::before{content:"";position:fixed;inset:0;pointer-events:none;z-index:0;background:
  radial-gradient(620px 320px at 12% -4%, rgba(99,102,241,.20), transparent 62%),
  radial-gradient(520px 300px at 92% 8%, rgba(168,85,247,.15), transparent 62%),
  radial-gradient(720px 420px at 50% 112%, rgba(56,189,248,.07), transparent 60%)}
.wrap{max-width:660px;margin:0 auto;padding:20px 16px 70px;position:relative;z-index:1}
/* ---------- hero ---------- */
.hero{text-align:center;padding:30px 8px 20px}
.hero .ticket{font-size:48px;display:inline-block;filter:drop-shadow(0 6px 18px rgba(168,85,247,.45));animation:float 3.4s ease-in-out infinite}
@keyframes float{0%,100%{transform:translateY(0) rotate(-5deg)}50%{transform:translateY(-9px) rotate(5deg)}}
.hero h1{font-size:25px;font-weight:800;letter-spacing:1px;margin-top:12px;background:linear-gradient(120deg,#fff 30%,#c7d2fe);-webkit-background-clip:text;background-clip:text;color:transparent}
.hero .sub{color:var(--dim);font-size:13.5px;margin-top:10px;line-height:1.8}
.hero .tagline{margin-top:10px;color:#e8c15a;font-size:13px;font-style:italic}
.hero .sub b{color:#c7d2fe;font-weight:600}
.stats{display:flex;gap:10px;margin:18px 0 2px}
.stat{flex:1;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:12px 6px;backdrop-filter:blur(8px)}
.stat b{display:block;font-size:20px;font-weight:800;font-variant-numeric:tabular-nums}
.stat span{font-size:11.5px;color:var(--dim)}
/* ---------- panels & cards ---------- */
.panel{background:var(--card);border:1px solid var(--line);border-radius:18px;padding:20px;margin-top:14px;backdrop-filter:blur(8px)}
.panel h2{font-size:14px;margin-bottom:14px;color:var(--dim);font-weight:600;letter-spacing:.5px}
/* 站长置顶卡 */
.featured{position:relative;border:0;padding:1.5px;background:linear-gradient(135deg,var(--gold),var(--gold2) 40%,#fde68a 60%,var(--gold2));border-radius:20px;box-shadow:0 8px 32px rgba(251,191,36,.18);overflow:hidden}
.featured .inner{background:#141021;border-radius:18.5px;padding:22px 20px;text-align:center;position:relative;overflow:hidden}
.featured .inner::before{content:"";position:absolute;inset:0;background:radial-gradient(400px 160px at 50% -20%,rgba(251,191,36,.16),transparent 70%);pointer-events:none}
.f-badge{display:inline-block;font-size:12px;font-weight:800;letter-spacing:1px;color:#1a1207;background:linear-gradient(120deg,var(--gold),#fde68a);padding:5px 14px;border-radius:999px;margin-bottom:12px}
.f-code{font-size:44px;font-weight:800;letter-spacing:8px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:#fff;text-shadow:0 2px 20px rgba(251,191,36,.35);margin:4px 0 8px;text-indent:8px}
.f-by{color:var(--dim);font-size:13px;margin-bottom:16px}
.f-by b{color:var(--gold);font-weight:700}
/* 按钮 */
button{border:0;border-radius:13px;padding:14px;font-size:15px;font-weight:700;cursor:pointer;color:#fff;background:linear-gradient(135deg,var(--acc1),var(--acc2));box-shadow:0 4px 16px rgba(99,102,241,.35);transition:transform .08s,box-shadow .2s}
button:active{transform:scale(.97)}
button.ghost{background:rgba(255,255,255,.06);border:1px solid var(--line);box-shadow:none;flex:0 0 auto;padding:14px 18px;font-weight:600}
button.btn-gold{background:linear-gradient(135deg,var(--gold2),var(--gold));color:#1a1207;box-shadow:0 4px 18px rgba(251,191,36,.4);width:100%}
.row{display:flex;gap:10px}
.row button:first-child{flex:1}
input{flex:1;min-width:0;background:rgba(0,0,0,.3);border:1px solid var(--line);border-radius:13px;padding:14px;color:#fff;font-size:16px;letter-spacing:2px;text-transform:uppercase;font-family:ui-monospace,Menlo,monospace;outline:none;transition:border .2s}
input:focus{border-color:var(--acc1)}
input::placeholder{letter-spacing:0;color:var(--dim);font-family:inherit}
/* 抽码 */
.draw-code{font-size:42px;font-weight:800;letter-spacing:8px;text-align:center;padding:20px 0 22px;font-family:ui-monospace,Menlo,monospace;color:#fff;text-indent:8px}
.draw-code:empty::before{content:"??????";color:#3a4560}
/* 列表 */
.grid{display:grid;gap:10px}
.card{background:var(--card);border:1px solid var(--line);border-radius:15px;padding:15px 16px;backdrop-filter:blur(8px)}
.card .top{display:flex;align-items:center;justify-content:space-between;gap:10px}
.card .code{font-size:22px;font-weight:800;letter-spacing:3px;font-family:ui-monospace,Menlo,monospace}
.card .meta{color:var(--dim);font-size:12px;margin:9px 0 12px;line-height:1.7}
.card .meta b{color:var(--ok)}
.card .meta .fl{color:var(--bad)}
.card .acts{display:flex;gap:8px}
.card .acts button{font-size:13px;padding:10px 0;font-weight:600;box-shadow:none;flex:1}
.card .acts .w{background:rgba(52,211,153,.13);color:var(--ok);border:1px solid rgba(52,211,153,.25)}
.card .acts .f{background:rgba(248,113,113,.10);color:var(--bad);border:1px solid rgba(248,113,113,.22)}
.card .acts button:disabled{opacity:.5}
.empty{text-align:center;color:var(--dim);padding:32px 0;font-size:14px;line-height:2}
/* 步骤 */
.steps{display:flex;gap:8px;margin-top:2px}
.step{flex:1;text-align:center;font-size:12px;color:var(--dim);line-height:1.7}
.step .n{display:flex;align-items:center;justify-content:center;width:26px;height:26px;margin:0 auto 8px;border-radius:50%;background:linear-gradient(135deg,var(--acc1),var(--acc2));color:#fff;font-size:13px;font-weight:800}
/* toast & footer */
.toast{position:fixed;left:50%;bottom:32px;transform:translateX(-50%);background:#1c2540;border:1px solid var(--line);padding:13px 22px;border-radius:14px;font-size:14px;display:none;z-index:9;max-width:92vw;text-align:center;box-shadow:0 8px 28px rgba(0,0,0,.5)}
footer{text-align:center;color:var(--dim);font-size:12px;margin-top:26px;line-height:2}
footer a{color:#a5b4fc;text-decoration:none}
/* 桌面端微调 */
@media(min-width:560px){.hero h1{font-size:28px}.f-code{font-size:48px}}
</style>
</head>
<body>
<div class="wrap">

<div class="hero">
  <span class="ticket">🎟️</span>
  <h1>Muse 邀请码共享站</h1>
  <p class="sub">Muse 注册需要邀请码<br>这里<b>免费领码</b> · 网友互助 · 失效自动隐藏</p>
  <p class="tagline">💬 ${tagline}</p>
  <div class="stats">
    <div class="stat"><b id="stCodes">–</b><span>码池邀请码</span></div>
    <div class="stat"><b id="stDraws">–</b><span>累计抽取</span></div>
    <div class="stat"><b id="stWorks">–</b><span>人说能用 👍</span></div>
  </div>
</div>

<div class="featured">
  <div class="inner">
    <span class="f-badge">⭐ 站长分享</span>
    <div class="f-code">${OWNER_CODE}</div>
    <div class="f-by">by <b>${OWNER_NAME}</b> · 站长自留，先到先得</div>
    <button class="btn-gold" onclick="copy('${OWNER_CODE}')">复制邀请码</button>
  </div>
</div>

<div class="panel">
  <h2>🎲 随机抽一个</h2>
  <div class="draw-code" id="drawCode"></div>
  <div class="row">
    <button id="drawBtn">抽一个邀请码</button>
    <button class="ghost" id="copyDrawBtn">复制</button>
  </div>
</div>

<div class="panel">
  <h2>💝 贡献邀请码</h2>
  <div class="row">
    <input id="codeInput" maxlength="6" placeholder="输入6位邀请码" autocomplete="off">
    <button id="submitBtn" style="flex:0 0 104px">提交</button>
  </div>
</div>

<div class="panel">
  <h2>📋 全部邀请码（按 👍 排序）</h2>
  <div class="grid" id="list"><div class="empty">加载中…</div></div>
</div>

<div class="panel">
  <h2>📖 怎么用</h2>
  <div class="steps">
    <div class="step"><span class="n">1</span>抽一个<br>或复制站长分享的码</div>
    <div class="step"><span class="n">2</span>去 Muse App<br>里兑换注册</div>
    <div class="step"><span class="n">3</span>回来点 👍<br>或标记失效</div>
  </div>
</div>

<footer>邀请码由网友自发贡献 · 失效达 3 次标记自动隐藏<br>站长 <a href="https://x.com/styrigx" target="_blank" rel="noopener">@styrigx</a> · 领到能用的欢迎回来点 👍</footer>
</div>
<div class="toast" id="toast"></div>
<script>
const $=id=>document.getElementById(id);
function toast(m){const t=$('toast');t.textContent=m;t.style.display='block';clearTimeout(t._h);t._h=setTimeout(()=>t.style.display='none',2200)}
async function copy(t){try{await navigator.clipboard.writeText(t);toast('已复制：'+t)}catch{const i=document.createElement('input');i.value=t;document.body.appendChild(i);i.select();document.execCommand('copy');i.remove();toast('已复制：'+t)}}
async function load(){
 const r=await fetch('/api/codes');const d=await r.json();
 const box=$('list');
 const cs=d.codes||[];
 $('stCodes').textContent=cs.length;
 $('stDraws').textContent=cs.reduce((s,c)=>s+(c.draws||0),0);
 $('stWorks').textContent=cs.reduce((s,c)=>s+(c.works||0),0);
 if(!cs.length){box.innerHTML='<div class="empty">板子还是空的<br>来贡献第一个吧 👆</div>';return}
 box.innerHTML=cs.map(c=>
 \`<div class="card">
   <div class="top"><span class="code">\${c.code}</span><button class="ghost" style="padding:9px 16px;font-size:13px" onclick="copy('\${c.code}')">复制</button></div>
   <div class="meta">\${c.by} · 👍 <b>\${c.works}</b>人说能用 · 已抽\${c.draws}次 · <span class="fl">\${c.flags}</span>人标记</div>
   <div class="acts">
     <button class="w" onclick="vote('\${c.code}','works',this)">👍 能用</button>
     <button class="f" onclick="vote('\${c.code}','flag',this)">标记失效</button>
   </div>
 </div>\`).join('');
}
async function vote(code,kind,btn){
 btn.disabled=true;
 const r=await fetch('/api/vote',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code,kind})});
 const d=await r.json();
 if(!r.ok)toast(d.error||'操作失败');else{toast(kind==='works'?'感谢反馈！':'已标记，谢谢');load()}
}
$('drawBtn').onclick=async()=>{
 const r=await fetch('/api/draw',{method:'POST'});const d=await r.json();
 if(!r.ok){toast(d.error||'抽取失败');return}
 $('drawCode').textContent=d.code;copy(d.code);
};
$('copyDrawBtn').onclick=()=>{const c=$('drawCode').textContent;if(/^[A-Z0-9]{6}$/.test(c))copy(c);else toast('先抽一个吧')};
$('submitBtn').onclick=async()=>{
 const code=$('codeInput').value.trim().toUpperCase();
 if(!/^[A-Z0-9]{6}$/.test(code)){toast('格式不对，应为6位字母/数字');return}
 const r=await fetch('/api/submit',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code})});
 const d=await r.json();
 if(!r.ok)toast(d.error||'提交失败');else{toast('贡献成功，感谢！');$('codeInput').value='';load()}
};
load();
</script>
</body>
</html>`;
}
