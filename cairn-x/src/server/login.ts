export const LOGIN_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Cairn 工作台 · 登录</title>
<link rel="icon" href="/static/favicon.svg" type="image/svg+xml">
<style>
  :root {
    /* 默认主题与工作台一致：pi-web 的 light（中性灰表面 + 蓝色强调色）。 */
    --bg: #ffffff;
    --panel: #ffffff;
    --line: #e0e0e0;
    --text: #1a1a1a;
    --muted: #515c6b;
    --accent: #245bce;
    --accent-strong: #1d4ed8;
    --on-accent: #ffffff;
    --brand-bg: #1a1a1a;
    --brand-text: #e8e8e8;
    --brand-muted: #a4a4a4;
    --brand-line: #5c5c5c;
    --brand-line-faint: #3d3d3d;
    --brand-node: #a4c2f4;
    --brand-node-dim: #93a7c8;
    --danger: #b4453c;
    color-scheme: light;
  }
  /* 未设置偏好（auto）时跟随系统。 */
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme]) {
      --bg: #1a1a1a;
      --panel: #1a1a1a;
      --line: #454545;
      --text: #e8e8e8;
      --muted: #b7b7b7;
      --accent: #a4c2f4;
      --accent-strong: #c3d8fa;
      --on-accent: #182234;
      --brand-bg: #111111;
      --brand-text: #e8e8e8;
      --brand-muted: #9a9a9a;
      --brand-line: #5c5c5c;
      --brand-line-faint: #3d3d3d;
      --brand-node: #a4c2f4;
      --brand-node-dim: #93a7c8;
      --danger: #f29489;
      color-scheme: dark;
    }
  }
  html[data-theme="light"] {
    --bg: #ffffff;
    --panel: #ffffff;
    --line: #e0e0e0;
    --text: #1a1a1a;
    --muted: #515c6b;
    --accent: #245bce;
    --accent-strong: #1d4ed8;
    --on-accent: #ffffff;
    --brand-bg: #1a1a1a;
    --brand-text: #e8e8e8;
    --brand-muted: #a4a4a4;
    --brand-line: #5c5c5c;
    --brand-line-faint: #3d3d3d;
    --brand-node: #a4c2f4;
    --brand-node-dim: #93a7c8;
    --danger: #b4453c;
    color-scheme: light;
  }
  html[data-theme="dark"] {
    --bg: #1a1a1a;
    --panel: #1a1a1a;
    --line: #454545;
    --text: #e8e8e8;
    --muted: #b7b7b7;
    --accent: #a4c2f4;
    --accent-strong: #c3d8fa;
    --on-accent: #182234;
    --brand-bg: #111111;
    --brand-text: #e8e8e8;
    --brand-muted: #9a9a9a;
    --brand-line: #5c5c5c;
    --brand-line-faint: #3d3d3d;
    --brand-node: #a4c2f4;
    --brand-node-dim: #93a7c8;
    --danger: #f29489;
    color-scheme: dark;
  }
  html[data-theme="mist"] {
    --bg: #f4f8f7;
    --panel: #f4f8f7;
    --line: #afc4ba;
    --text: #202e2b;
    --muted: #455f56;
    --accent: #1e6559;
    --accent-strong: #174f46;
    --on-accent: #ffffff;
    --brand-bg: #1c2b26;
    --brand-text: #e6ede8;
    --brand-muted: #9db3a8;
    --brand-line: #5c7f68;
    --brand-line-faint: #3c5344;
    --brand-node: #9fcaab;
    --brand-node-dim: #7e9a86;
    --danger: #b4453c;
    color-scheme: light;
  }
  /* rose（蔷薇）来自 pi-web，与工作台的同一套 token 对齐。 */
  html[data-theme="rose"] {
    --bg: #fcf7f8;
    --panel: #fcf7f8;
    --line: #cdb5bf;
    --text: #34282e;
    --muted: #65505a;
    --accent: #914360;
    --accent-strong: #76324d;
    --on-accent: #ffffff;
    --brand-bg: #2b1f24;
    --brand-text: #efe3e8;
    --brand-muted: #b394a0;
    --brand-line: #7d5c68;
    --brand-line-faint: #4e393f;
    --brand-node: #d3a4b5;
    --brand-node-dim: #a67f8e;
    --danger: #b4453c;
    color-scheme: light;
  }
  html[data-theme="pine"] {
    --bg: #19201f;
    --panel: #19201f;
    --line: #4a5f52;
    --text: #e6ede8;
    --muted: #c3d0c6;
    --accent: #acccb7;
    --accent-strong: #d0e2d3;
    --on-accent: #182b20;
    --brand-bg: #131a15;
    --brand-text: #d7e2d9;
    --brand-muted: #7e9285;
    --brand-line: #4c6654;
    --brand-line-faint: #35473c;
    --brand-node: #9fcaab;
    --brand-node-dim: #7e9a86;
    --danger: #f29489;
    color-scheme: dark;
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    margin: 0;
    font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
    color: var(--text);
    background: var(--bg);
  }
  .layout { display: flex; min-height: 100vh; }

  /* 左侧品牌区 */
  .brand {
    flex: 0 0 44%;
    max-width: 560px;
    background: var(--brand-bg);
    color: var(--brand-text);
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    padding: 48px 52px 40px;
    position: relative;
    overflow: hidden;
  }
  .brand::after {
    content: "";
    position: absolute;
    inset: 0;
    background-image: radial-gradient(rgba(255,255,255,0.055) 1px, transparent 1px);
    background-size: 22px 22px;
    pointer-events: none;
  }
  .brand-head { display: flex; align-items: center; gap: 10px; position: relative; z-index: 1; }
  .brand-head .mark { width: 26px; height: 26px; color: var(--brand-muted); flex: none; }
  .brand-head .mark path, .brand-head .mark circle {
    stroke: currentColor;
    stroke-dasharray: 120;
    stroke-dashoffset: 120;
    animation: draw 1.4s ease forwards;
  }
  .brand-head .mark circle { animation-delay: 0.55s; }
  .brand-head .mark path { animation-delay: 0.15s; }
  @keyframes draw { to { stroke-dashoffset: 0; } }
  .brand-head strong { font-size: 14px; font-weight: 600; letter-spacing: 0.02em; }
  .brand-mid { position: relative; z-index: 1; }
  .brand-mid svg.graph { width: 100%; max-width: 340px; height: auto; display: block; margin-bottom: 28px; }
  .brand-mid svg.graph path, .brand-mid svg.graph circle {
    stroke-dasharray: 220;
    stroke-dashoffset: 220;
    animation: draw 1.6s ease forwards;
  }
  .brand-mid svg.graph .p1 { animation-delay: 0.3s; }
  .brand-mid svg.graph .p2 { animation-delay: 0.55s; }
  .brand-mid svg.graph .n1 { animation-delay: 0.15s; }
  .brand-mid svg.graph .n2 { animation-delay: 0.85s; }
  .brand-mid svg.graph .n3 { animation-delay: 1s; }
  .brand-mid h1 {
    margin: 0 0 10px;
    font-size: 26px;
    font-weight: 600;
    letter-spacing: 0.01em;
    line-height: 1.3;
  }
  .brand-mid p { margin: 0; font-size: 13px; line-height: 1.7; color: var(--brand-muted); max-width: 340px; }
  .brand-foot { position: relative; z-index: 1; font-size: 11px; color: var(--brand-muted); }

  /* 右侧表单区 */
  .panel {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 40px 24px;
  }
  .form-wrap { width: 100%; max-width: 320px; }
  .form-wrap > .mark { display: none; }
  .form-wrap h2 { margin: 0 0 4px; font-size: 18px; font-weight: 600; letter-spacing: 0.01em; }
  .form-wrap .sub { margin: 0 0 28px; font-size: 12px; color: var(--muted); }
  form { display: flex; flex-direction: column; gap: 16px; }
  label.field { display: flex; flex-direction: column; gap: 6px; }
  label.field span { font-size: 12px; font-weight: 500; color: var(--muted); }
  input {
    height: 38px;
    padding: 0 11px;
    border: 1px solid var(--line);
    border-radius: 7px;
    background: var(--panel);
    color: var(--text);
    font-size: 13px;
    outline: none;
    transition: border-color 0.15s, box-shadow 0.15s;
  }
  input::placeholder { color: var(--muted); opacity: 0.6; }
  input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 18%, transparent); }
  p#error {
    margin: -4px 0 0;
    font-size: 12px;
    color: var(--danger);
    display: none;
  }
  p#error.show { display: block; }
  button[type="submit"] {
    height: 38px;
    margin-top: 4px;
    border: none;
    border-radius: 7px;
    background: var(--accent);
    color: var(--on-accent);
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    transition: background 0.15s, opacity 0.15s;
  }
  button[type="submit"]:hover { background: var(--accent-strong); }
  button[type="submit"]:disabled { opacity: 0.55; cursor: default; }
  button:focus-visible, input:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .hint { margin: 22px 0 0; font-size: 11px; color: var(--muted); text-align: center; }

  @media (max-width: 860px) {
    .brand { display: none; }
    .panel { align-items: flex-start; padding-top: 12vh; }
    .form-wrap { max-width: 340px; }
    .form-wrap > .mark {
      display: block;
      width: 34px; height: 34px;
      color: var(--accent);
      margin-bottom: 22px;
    }
    .form-wrap > .mark path, .form-wrap > .mark circle { stroke: currentColor; }
  }
</style>
<script>
  // 未登录页不加载 React，这里直接读工作台保存的主题偏好，避免登录前后跳色。
  // 与 useTheme 一致：auto 与「未设置」都显式解析成 light / dark 再写 data-theme。
  try {
    var stored = localStorage.getItem('cairn-theme');
    var dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    if (stored === 'auto' || stored === null) {
      document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    } else if (stored === 'light' || stored === 'dark' || stored === 'mist' || stored === 'rose' || stored === 'pine') {
      document.documentElement.dataset.theme = stored;
    }
  } catch (e) {}
</script>
</head>
<body>
  <div class="layout">
    <aside class="brand">
      <div class="brand-head">
        <svg class="mark" viewBox="0 0 64 64" fill="none" aria-hidden="true">
          <path d="M23.2 29.98 42.3 21.05" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>
          <path d="M23.2 34.02 42.3 42.95" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>
          <circle cx="18" cy="32" r="4.75" stroke-width="3.5"/>
          <circle cx="47" cy="18" r="4.75" stroke-width="3.5"/>
          <circle cx="47" cy="46" r="4.75" stroke-width="3.5"/>
        </svg>
        <strong>Cairn 工作台</strong>
      </div>
      <div class="brand-mid">
        <svg class="graph" viewBox="0 0 340 190" fill="none" aria-hidden="true">
          <path class="p1" d="M52 96 C 110 40, 150 34, 208 30" stroke="var(--brand-line)" stroke-width="2.5" stroke-linecap="round"/>
          <path class="p2" d="M52 100 C 120 120, 170 140, 258 150" stroke="var(--brand-line)" stroke-width="2.5" stroke-linecap="round"/>
          <path d="M208 30 C 240 60, 250 100, 258 150" stroke="var(--brand-line-faint)" stroke-width="2" stroke-linecap="round" stroke-dasharray="1 7"/>
          <circle class="n1" cx="48" cy="98" r="7" stroke="var(--brand-node)" stroke-width="3"/>
          <circle class="n2" cx="212" cy="29" r="6" stroke="var(--brand-node-dim)" stroke-width="2.5"/>
          <circle class="n3" cx="262" cy="151" r="6" stroke="var(--brand-node-dim)" stroke-width="2.5"/>
          <circle cx="236" cy="92" r="4" stroke="var(--brand-line-faint)" stroke-width="2"/>
        </svg>
        <h1>让探索留下路径</h1>
        <p>Dispatcher 规划目标与步骤，Execute 在独立沙箱中执行。每一步都沉淀为图谱上的事实，可回放、可追踪。</p>
      </div>
      <div class="brand-foot">基于 FGS 的探索编排器</div>
    </aside>
    <main class="panel">
      <div class="form-wrap">
        <svg class="mark" viewBox="0 0 64 64" fill="none" aria-hidden="true">
          <path d="M23.2 29.98 42.3 21.05" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>
          <path d="M23.2 34.02 42.3 42.95" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>
          <circle cx="18" cy="32" r="4.75" stroke-width="3.5"/>
          <circle cx="47" cy="18" r="4.75" stroke-width="3.5"/>
          <circle cx="47" cy="46" r="4.75" stroke-width="3.5"/>
        </svg>
        <h2>登录控制台</h2>
        <p class="sub">使用管理员账号进入工作台</p>
        <form id="login-form">
          <label class="field" for="username">
            <span>用户名</span>
            <input id="username" type="text" autocomplete="username" required autofocus placeholder="admin">
          </label>
          <label class="field" for="password">
            <span>密码</span>
            <input id="password" type="password" autocomplete="current-password" required placeholder="••••••••">
          </label>
          <p id="error" role="alert"></p>
          <button id="login-btn" type="submit">登录</button>
        </form>
        <p class="hint">登录状态仅对当前浏览器有效</p>
      </div>
    </main>
  </div>
<script>
  const form = document.getElementById('login-form');
  const err = document.getElementById('error');
  const btn = document.getElementById('login-btn');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.classList.remove('show');
    btn.disabled = true;
    btn.textContent = '正在登录…';
    try {
      const res = await fetch('/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: document.getElementById('username').value.trim(),
          password: document.getElementById('password').value,
        }),
      });
      if (res.ok) {
        window.location.href = '/';
        return;
      }
      err.textContent = res.status === 401 ? '用户名或密码错误' : '登录失败（' + res.status + '）';
      err.classList.add('show');
    } catch (e2) {
      err.textContent = '网络错误';
      err.classList.add('show');
    }
    btn.disabled = false;
    btn.textContent = '登录';
  });
</script>
</body>
</html>`;
