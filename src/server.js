#!/usr/bin/env node
/* ABU MASTER PC MANAGER — port 9100
 * Fuses: Microsoft PC Manager (health/boost/cleanup/storage/toolbox/startup)
 *      + Claude Code token dashboard (sessions/tokens/streak/favorite model/heatmap)
 *      + AI framework detection (Ollama, LM Studio, ComfyUI, F5-TTS, etc.)
 *      + Agentic framework detection (Claude Code, Hermes, Openclaw, OpenAI Codex)
 *      + Token spending + utilization (reads ./.shared/cost_log.sqlite)
 */
const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile, exec } = require('child_process');
const Database = require('better-sqlite3');

const app = express();
const PORT = process.env.ABU_PM_PORT || 9100;
const SHARED = './.shared';
const HOME = os.homedir();

app.use(express.static(path.join(__dirname, '..', 'public')));
app.use(express.json());

/* ─── helpers ─────────────────────────────────────────────── */
const psh = (cmd, timeout = 15000) => new Promise((resolve) => {
  execFile('powershell.exe', ['-NoProfile', '-Command', cmd], { timeout, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
    resolve({ err: err && err.message, out: (stdout || '').trim() });
  });
});
const curl = (url, timeoutMs = 3000) => new Promise((resolve) => {
  const http = url.startsWith('https') ? require('https') : require('http');
  const req = http.get(url, { timeout: timeoutMs }, (res) => {
    let body = ''; res.on('data', (c) => { body += c; }); res.on('end', () => resolve({ ok: res.statusCode < 400, status: res.statusCode, body }));
  });
  req.on('error', () => resolve({ ok: false }));
  req.on('timeout', () => { req.destroy(); resolve({ ok: false, timeout: true }); });
});
const exists = (p) => { try { fs.accessSync(p); return true; } catch { return false; } };
const safe = (fn, fallback = null) => { try { return fn(); } catch { return fallback; } };

/* ─── HEALTH ──────────────────────────────────────────────── */
app.get('/api/health', async (req, res) => {
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const uptime = os.uptime();
  const loadavg = os.loadavg();
  const cpus = os.cpus().length;
  const disks = await psh(`Get-PSDrive -PSProvider FileSystem | Select-Object Name,@{n='UsedGB';e={[math]::Round($_.Used/1GB,1)}},@{n='FreeGB';e={[math]::Round($_.Free/1GB,1)}} | ConvertTo-Json`);
  const tempSize = await psh(`$p = $env:TEMP; if (Test-Path $p) { '{0:N2}' -f ((Get-ChildItem -Path $p -Recurse -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum / 1GB) } else { '0' }`);
  const startupCount = await psh(`(Get-CimInstance Win32_StartupCommand | Measure-Object).Count`);
  res.json({
    memory: { totalGB: +(totalMem / 1e9).toFixed(1), usedPct: +(((totalMem - freeMem) / totalMem) * 100).toFixed(1), freeGB: +(freeMem / 1e9).toFixed(1) },
    uptime_hours: +(uptime / 3600).toFixed(1),
    loadavg_1m: loadavg[0],
    cpus,
    disks: safe(() => JSON.parse(disks.out), []),
    temp_files_gb: +tempSize.out || 0,
    startup_programs: +startupCount.out || 0,
    platform: os.platform(),
    host: os.hostname(),
    time: new Date().toISOString(),
  });
});

/* ─── STORAGE ─────────────────────────────────────────────── */
app.get('/api/storage', async (req, res) => {
  const r = await psh(`Get-PSDrive -PSProvider FileSystem | ForEach-Object { [pscustomobject]@{ Name=$_.Name; UsedGB=[math]::Round($_.Used/1GB,1); FreeGB=[math]::Round($_.Free/1GB,1); TotalGB=[math]::Round(($_.Used+$_.Free)/1GB,1) } } | ConvertTo-Json`);
  const bigDirs = await psh(`Get-ChildItem -Path 'E:\\','C:\\Users\\USER' -Directory -ErrorAction SilentlyContinue | ForEach-Object { [pscustomobject]@{ path=$_.FullName; sizeGB=[math]::Round((Get-ChildItem -Path $_.FullName -Recurse -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum/1GB,1) } } | Sort-Object -Property sizeGB -Descending | Select-Object -First 15 | ConvertTo-Json`, 40000);
  res.json({ drives: safe(() => JSON.parse(r.out), []), biggest_dirs: safe(() => JSON.parse(bigDirs.out), []) });
});

/* ─── AI FRAMEWORKS ──────────────────────────────────────── */
app.get('/api/ai-frameworks', async (req, res) => {
  const checks = await Promise.all([
    curl('http://127.0.0.1:11434/api/tags').then(r => ({ name: 'Ollama', port: 11434, alive: r.ok, models: safe(() => JSON.parse(r.body).models.map(m => ({ name: m.name, size_gb: +(m.size / 1e9).toFixed(1) })), []) })),
    curl('http://127.0.0.1:1234/v1/models').then(r => ({ name: 'LM Studio', port: 1234, alive: r.ok, models: safe(() => JSON.parse(r.body).data.map(m => m.id), []) })),
    curl('http://127.0.0.1:8188/system_stats').then(r => ({ name: 'ComfyUI', port: 8188, alive: r.ok, stats: safe(() => JSON.parse(r.body), {}) })),
    curl('http://127.0.0.1:7860/').then(r => ({ name: 'Automatic1111', port: 7860, alive: r.ok })),
    curl('http://127.0.0.1:5000/').then(r => ({ name: 'Postiz', port: 5000, alive: r.ok })),
    curl('http://127.0.0.1:7880/').then(r => ({ name: 'LiveKit', port: 7880, alive: r.ok })),
    curl('http://127.0.0.1:9090/').then(r => ({ name: 'Mission Control', port: 9090, alive: r.ok })),
    curl('http://127.0.0.1:18789/health').then(r => ({ name: 'Zait Gateway', port: 18789, alive: r.ok })),
  ]);
  res.json({ frameworks: checks, time: new Date().toISOString() });
});

/* ─── CLOUD PROVIDERS (auth + credit + model count) ────── */
function curlAuth(url, headers = {}, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const { hostname, pathname, search, protocol } = new URL(url);
    const lib = protocol === 'https:' ? require('https') : require('http');
    const req = lib.get({ hostname, path: pathname + (search || ''), headers, timeout: timeoutMs }, (res) => {
      let body = ''; res.on('data', c => body += c); res.on('end', () => resolve({ ok: res.statusCode < 400, status: res.statusCode, body }));
    });
    req.on('error', e => resolve({ ok: false, err: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, timeout: true }); });
  });
}
function loadKeys() {
  const keys = {};
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(HOME, '.openclaw', 'openclaw.json'), 'utf8'));
    const providers = (cfg.models && cfg.models.providers) || {};
    for (const [name, p] of Object.entries(providers)) if (p.apiKey) keys[name] = p.apiKey;
  } catch {}
  try {
    const codex = JSON.parse(fs.readFileSync(path.join(HOME, '.codex', 'auth.json'), 'utf8'));
    if (codex.tokens && codex.tokens.access_token) keys['codex-chatgpt'] = codex.tokens.access_token;
    else if (codex.auth_mode) keys['codex-chatgpt'] = 'oauth';
  } catch {}
  return keys;
}

app.get('/api/cloud-providers', async (req, res) => {
  const keys = loadKeys();
  const probes = [
    ['ChatGPT (Codex)', 'https://chatgpt.com/backend-api/codex/responses', keys['codex-chatgpt'], 'Bearer'],
    ['Google Gemini',   `https://generativelanguage.googleapis.com/v1beta/models?key=${keys['google-generative-ai']||''}`, null, null],
    ['Anthropic',       'https://api.anthropic.com/v1/models', keys.anthropic, 'x-api-key'],
    ['Nous',            'https://inference-api.nousresearch.com/v1/models', keys.nous, 'Bearer'],
    ['OpenRouter',      'https://openrouter.ai/api/v1/credits', keys.openrouter, 'Bearer'],
    ['OpenCode',        'https://opencode.ai/api/v1/models', keys.opencode, 'Bearer'],
    ['Kimi (Moonshot)', 'https://api.moonshot.cn/v1/models', keys.moonshot, 'Bearer'],
    ['xAI (Grok)',      'https://api.x.ai/v1/models', keys['x-ai'], 'Bearer'],
    ['Groq',            'https://api.groq.com/openai/v1/models', keys.groq, 'Bearer'],
    ['LLMAPI',          'https://api.llmapi.io/v1/models', keys.llmapi, 'Bearer'],
  ];
  const results = await Promise.all(probes.map(async ([name, url, key, scheme]) => {
    if (!key) return { name, status: 'no_key', alive: false };
    const headers = scheme === 'Bearer' ? { Authorization: `Bearer ${key}` }
                  : scheme === 'x-api-key' ? { 'x-api-key': key, 'anthropic-version': '2023-06-01' }
                  : {};
    const r = await curlAuth(url, headers, 6000);
    let models = 0, creditInfo = null;
    try {
      if (r.body) {
        const j = JSON.parse(r.body);
        models = (j.data || j.models || j.results || []).length || 0;
        if (j.data && typeof j.data.total_credits !== 'undefined') creditInfo = { credits: j.data.total_credits, used: j.data.total_usage };
      }
    } catch {}
    return { name, status: r.ok ? 'alive' : (r.status === 402 ? 'no_credits' : r.status === 401 || r.status === 403 ? 'auth_bad' : (r.status || 'down')), alive: r.ok, http: r.status, models, credit: creditInfo };
  }));
  res.json({ providers: results, time: new Date().toISOString() });
});

/* ─── AGENTIC FRAMEWORKS ─────────────────────────────────── */
app.get('/api/agents', async (req, res) => {
  const home = os.homedir();
  const frameworks = [
    { name: 'Claude Code',   path: path.join(home, '.claude'),    runtime: 'claude' },
    { name: 'Openclaw (Zait)', path: path.join(home, '.openclaw'), runtime: 'openclaw' },
    { name: 'Hermes (Qadir)',  path: '\\\\wsl$\\Ubuntu-24.04\\home\\abuz8\\.hermes', runtime: 'hermes' },
    { name: 'OpenAI Codex',    path: path.join(home, '.codex'),    runtime: 'codex' },
    { name: 'Cursor',          path: path.join(home, '.cursor'),   runtime: 'cursor' },
    { name: 'Antigravity',     path: path.join(home, '.antigravity'), runtime: 'antigravity' },
  ];
  const detected = frameworks.map(f => {
    const alive = exists(f.path);
    let skills = 0, memory_mb = 0;
    if (alive) {
      try {
        const skillsDir = path.join(f.path, 'skills');
        if (fs.existsSync(skillsDir)) skills = fs.readdirSync(skillsDir).length;
      } catch {}
      try {
        const memDir = path.join(f.path, 'memory');
        if (fs.existsSync(memDir)) {
          const files = fs.readdirSync(memDir);
          memory_mb = +(files.reduce((a, fn) => { try { return a + fs.statSync(path.join(memDir, fn)).size; } catch { return a; } }, 0) / 1e6).toFixed(1);
        }
      } catch {}
    }
    return { ...f, alive, skills, memory_mb };
  });
  // Windows scheduled tasks acting as agent watchdogs
  const tasks = await psh(`Get-ScheduledTask | Where-Object {$_.TaskName -match 'Zait|Qadir|Mission|Lazy|Avatar|Owner'} | Select-Object TaskName,State | ConvertTo-Json`);
  res.json({ frameworks: detected, scheduled_tasks: safe(() => JSON.parse(tasks.out), []) });
});

/* ─── TOKEN LEDGER (fusion with Claude-dashboard-style) ─── */
app.get('/api/tokens', (req, res) => {
  const dbPath = path.join(SHARED, 'cost_log.sqlite');
  let burn = [], totals = { sessions: 0, calls: 0, tokens: 0, cost_usd: 0, active_days: 0 }, heat = [], local_vs_cloud = [], tables = [];
  try {
    if (fs.existsSync(dbPath)) {
      const db = new Database(dbPath, { readonly: true });
      burn = db.prepare(`SELECT provider, model, agent, SUM(input_tokens+output_tokens) AS tokens, SUM(est_cost_usd) AS cost, COUNT(*) AS calls FROM burn_log GROUP BY provider, model, agent ORDER BY cost DESC`).all();
      totals = db.prepare(`SELECT COUNT(DISTINCT date(ts,'unixepoch')) AS active_days, COUNT(*) AS calls, SUM(input_tokens+output_tokens) AS tokens, SUM(est_cost_usd) AS cost_usd FROM burn_log`).get() || totals;
      heat = db.prepare(`SELECT date(ts,'unixepoch') AS d, COUNT(*) AS c FROM burn_log GROUP BY d ORDER BY d DESC LIMIT 90`).all();
      local_vs_cloud = db.prepare(`SELECT e.verdict, COUNT(*) AS n FROM eval_runs e GROUP BY verdict`).all();
      tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all().map(l => l.name);
      db.close();
    }
  } catch (e) { burn = [{ error: e.message }]; }
  res.json({ totals, burn, heatmap: heat, local_vs_cloud, tables });
});

/* ─── TOOLBOX (actions) ───────────────────────────────────── */
app.post('/api/action/cleanup-temp', async (req, res) => {
  const r = await psh(`Get-ChildItem -Path $env:TEMP -Recurse -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue; 'done'`, 60000);
  res.json(r);
});
app.post('/api/action/restart-service', (req, res) => {
  const { service } = req.body || {};
  const map = {
    'mission-control': 'schtasks /Run /TN "MissionControlWatchdog"',
    'zait':            'schtasks /Run /TN "ZaitWatchdog"',
    'lazy-protocol':   'schtasks /Run /TN "OwnerLazyProtocol"',
  };
  const cmd = map[service];
  if (!cmd) return res.status(400).json({ err: 'unknown service' });
  exec(cmd, (err, stdout) => res.json({ err: err && err.message, out: stdout }));
});
app.post('/api/action/pull-model', (req, res) => {
  const { model } = req.body || {};
  if (!/^[\w.:/-]+$/.test(model || '')) return res.status(400).json({ err: 'bad model name' });
  exec(`ollama pull ${model}`, { timeout: 600000 }, (err, stdout) => res.json({ err: err && err.message, out: stdout.slice(-2000) }));
});

/* ─── CLAWBOARD: Openclaw (Zait) + Hermes (Qadir) ──────── */
app.get('/api/clawboard', async (req, res) => {
  // Openclaw / Zait — Windows
  const zaitHealth = await curl('http://127.0.0.1:18789/health');
  const zaitProc = await psh(`(Get-CimInstance Win32_Process -Filter "name='node.exe'" | Where-Object { $_.CommandLine -match 'openclaw' } | Select-Object ProcessId,CommandLine | ConvertTo-Json) -replace '\\\\','/' `);
  const zaitTask = await psh(`Get-ScheduledTask -TaskName 'ZaitWatchdog' -ErrorAction SilentlyContinue | Select TaskName,State | ConvertTo-Json`);
  let zaitLog = '';
  try {
    const logDir = path.join(HOME, '.openclaw', 'logs');
    if (fs.existsSync(logDir)) {
      const files = fs.readdirSync(logDir).filter(f => f.endsWith('.log')).map(f => ({f, t: fs.statSync(path.join(logDir, f)).mtimeMs})).sort((a,b)=>b.t-a.t);
      if (files[0]) zaitLog = fs.readFileSync(path.join(logDir, files[0].f), 'utf8').split('\n').slice(-25).join('\n');
    }
  } catch (e) { zaitLog = e.message; }

  // Hermes / Qadir — WSL
  const hermesActive = await new Promise(ok => execFile('wsl.exe', ['-d','Ubuntu-24.04','--','bash','-lc','systemctl is-active hermes-qadir 2>/dev/null'], {timeout:5000}, (e,out)=>ok((out||'').trim())));
  const hermesHealth = hermesActive === 'active';
  const hermesProc = await new Promise(ok => execFile('wsl.exe', ['-d','Ubuntu-24.04','--','bash','-lc','pgrep -af hermes_cli 2>/dev/null | head -3'], {timeout:5000}, (e,out)=>ok(out||'')));
  const hermesLog = await new Promise(ok => execFile('wsl.exe', ['-d','Ubuntu-24.04','--','bash','-lc','tail -25 /home/user/.hermes/logs/gateway.log 2>/dev/null'], {timeout:5000, maxBuffer:1e6}, (e,out)=>ok(out||'')));

  res.json({
    openclaw: {
      alive: zaitHealth.ok,
      gateway_port: 18789,
      processes: safe(() => { const p = JSON.parse(zaitProc.out); return Array.isArray(p) ? p : (p ? [p] : []); }, []),
      watchdog: safe(() => JSON.parse(zaitTask.out), null),
      last_log: zaitLog,
    },
    hermes: {
      alive: hermesHealth,
      service: 'hermes-qadir',
      systemd_status: hermesActive,
      processes: hermesProc.trim().split('\n').filter(Boolean),
      last_log: hermesLog,
    },
    time: new Date().toISOString(),
  });
});

/* ─── CLAW ACTIONS ─────────────────────────────────────── */
// WSL sudo password is read from the environment — never hard-coded.
// Set ABU_WSL_SUDO_PASS in your shell/.env (see .env.example).
const WSL_SUDO_PASS = process.env.ABU_WSL_SUDO_PASS || '';
const WSL_SUDO_PREFIX = WSL_SUDO_PASS ? `echo '${WSL_SUDO_PASS}' | sudo -S ` : '';
app.post('/api/claw/openclaw/:cmd', (req, res) => {
  const cmd = req.params.cmd;
  let action;
  if (cmd === 'restart') {
    // kill existing openclaw node processes, then trigger ZaitWatchdog (revives in <60s) AND manually spawn
    action = `Get-CimInstance Win32_Process -Filter "name='node.exe'" | Where-Object { $_.CommandLine -match 'openclaw' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }; Start-Sleep -Seconds 2; schtasks.exe /Run /TN 'ZaitWatchdog'; 'restarted'`;
  } else if (cmd === 'start') {
    action = `schtasks.exe /Run /TN 'ZaitWatchdog'; 'started'`;
  } else if (cmd === 'stop') {
    action = `schtasks.exe /End /TN 'ZaitWatchdog' 2>$null; Get-CimInstance Win32_Process -Filter "name='node.exe'" | Where-Object { $_.CommandLine -match 'openclaw' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }; 'stopped'`;
  } else {
    return res.status(400).json({ err: 'unknown cmd' });
  }
  psh(action, 30000).then(r => res.json(r));
});

app.post('/api/claw/hermes/:cmd', (req, res) => {
  const cmd = req.params.cmd;
  if (!['start','stop','restart','status'].includes(cmd)) return res.status(400).json({ err: 'unknown cmd' });
  if (cmd !== 'status' && !WSL_SUDO_PASS) {
    return res.status(503).json({ err: 'ABU_WSL_SUDO_PASS is not set — cannot run privileged WSL command. See .env.example.' });
  }
  const bash = cmd === 'status'
    ? `systemctl is-active hermes-qadir; systemctl status hermes-qadir --no-pager | head -6`
    : `${WSL_SUDO_PREFIX}systemctl ${cmd} hermes-qadir && echo '${cmd} ok'`;
  execFile('wsl.exe', ['-d','Ubuntu-24.04','--','bash','-lc', bash], { timeout: 20000, maxBuffer: 1e6 }, (err, out) => {
    res.json({ err: err && err.message, out: (out || '').trim() });
  });
});

/* ─── SUMMARY (lightweight, no self-dispatch) ────────────── */
app.get('/api/summary', async (req, res) => {
  const [gw, ol] = await Promise.all([
    curl('http://127.0.0.1:18789/health'),
    curl('http://127.0.0.1:11434/api/tags'),
  ]);
  res.json({
    memory_pct: +(((os.totalmem() - os.freemem()) / os.totalmem()) * 100).toFixed(1),
    uptime_h: +(os.uptime() / 3600).toFixed(1),
    zait_gw: gw.ok,
    ollama: ol.ok,
    time: new Date().toISOString(),
  });
});

app.listen(PORT, '127.0.0.1', () => {
  console.log(`[ABU PM] http://127.0.0.1:${PORT}`);
});
