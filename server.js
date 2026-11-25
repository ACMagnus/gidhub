'use strict';

/*
 * GidHub 私有后端
 * - GitHub token 只从服务端读取，绝不下发到浏览器
 * - 单站主密码登录，会话 Cookie，30 天
 * - /api/github/* 代理 GitHub REST API
 * - /api/asset?url= 代理私有仓库的 raw / release 资源
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';
const CONFIG_DIR = process.env.GIDHUB_CONFIG_DIR || path.join(os.homedir(), '.config', 'gidhub');
const AUTH_FILE = path.join(CONFIG_DIR, 'auth.json');
const PASSWORD_FILE = path.join(CONFIG_DIR, 'login.txt');
const VAULT_FILE = path.join(CONFIG_DIR, 'token.enc');
const VAULT_KEY_FILE = path.join(CONFIG_DIR, 'token.key');
const INDEX_FILE = path.join(__dirname, 'index.html');
const SESSION_TTL = 30 * 24 * 3600 * 1000;
const COOKIE = 'gidhub_sid';

const sessions = new Map();
const loginAttempts = new Map();

function ensureConfig() {
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  if (fs.existsSync(AUTH_FILE)) {
    const auth = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
    if (auth.salt && auth.hash) return auth;
  }
  const password = 'gidhub-' + crypto.randomBytes(4).toString('hex') + '-' + crypto.randomBytes(2).toString('hex');
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  const auth = { salt, hash, createdAt: new Date().toISOString() };
  fs.writeFileSync(AUTH_FILE, JSON.stringify(auth, null, 2), { mode: 0o600 });
  fs.writeFileSync(PASSWORD_FILE, password + '\n', { mode: 0o600 });
  console.log('[gidhub] generated owner password at ' + PASSWORD_FILE);
  return auth;
}

const AUTH = ensureConfig();

function readGitHubToken() {
  if (process.env.GITHUB_TOKEN && process.env.GITHUB_TOKEN.trim()) return process.env.GITHUB_TOKEN.trim();
  const ghHosts = path.join(os.homedir(), '.config', 'gh', 'hosts.yml');
  if (fs.existsSync(ghHosts)) {
    const text = fs.readFileSync(ghHosts, 'utf8');
    const m = text.match(/oauth_token:\s*(\S+)/);
    if (m && m[1]) return m[1].trim();
  }
  return '';
}

let cachedToken = '';

function vaultKey() {
  if (fs.existsSync(VAULT_KEY_FILE)) {
    const key = Buffer.from(fs.readFileSync(VAULT_KEY_FILE, 'utf8').trim(), 'base64');
    if (key.length !== 32) throw new Error('token.key 长度不对');
    return key;
  }
  const key = crypto.randomBytes(32);
  fs.writeFileSync(VAULT_KEY_FILE, key.toString('base64') + '\n', { mode: 0o600 });
  return key;
}

function encryptToken(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', vaultKey(), iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

function decryptToken(payload) {
  const raw = Buffer.from(String(payload || '').trim(), 'base64');
  if (raw.length < 28) throw new Error('token.enc 内容不完整');
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const enc = raw.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', vaultKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}

function loadToken() {
  if (cachedToken) return cachedToken;
  const envToken = (process.env.GITHUB_TOKEN || '').trim();
  if (envToken) {
    cachedToken = envToken;
    return cachedToken;
  }
  if (fs.existsSync(VAULT_FILE)) {
    try {
      cachedToken = decryptToken(fs.readFileSync(VAULT_FILE, 'utf8'));
      return cachedToken;
    } catch (e) {
      throw new Error('无法解密 token.enc：' + e.message);
    }
  }
  const plain = readGitHubToken();
  if (!plain) throw new Error('没有找到 GitHub token：请先 gh auth login，或在启动时设置 GITHUB_TOKEN');
  fs.writeFileSync(VAULT_FILE, encryptToken(plain) + '\n', { mode: 0o600 });
  cachedToken = plain;
  return cachedToken;
}

function token() {
  const t = loadToken();
  if (!t) throw new Error('没有找到 GitHub token：请先 gh auth login，或在启动时设置 GITHUB_TOKEN');
  return t;
}

function checkPassword(input) {
  const hash = crypto.scryptSync(String(input || ''), AUTH.salt, 64);
  const expected = Buffer.from(AUTH.hash, 'hex');
  if (hash.length !== expected.length) return false;
  return crypto.timingSafeEqual(hash, expected);
}

function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach(part => {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}

function getSession(req) {
  const sid = parseCookies(req)[COOKIE];
  if (!sid) return null;
  const s = sessions.get(sid);
  if (!s) return null;
  if (s.expires < Date.now()) { sessions.delete(sid); return null; }
  return s;
}

function newSession(user) {
  const sid = crypto.randomBytes(32).toString('hex');
  sessions.set(sid, { user, expires: Date.now() + SESSION_TTL });
  return sid;
}

function isHttps(req) {
  return req.socket.encrypted || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
}

function setSessionCookie(req, res, sid) {
  const parts = [COOKIE + '=' + sid, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=' + Math.floor(SESSION_TTL / 1000)];
  if (isHttps(req)) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

function clearSessionCookie(req, res) {
  const parts = [COOKIE + '=', 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (isHttps(req)) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

function send(res, status, body, headers) {
  res.writeHead(status, Object.assign({
    'Content-Type': 'text/plain; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY'
  }, headers || {}));
  res.end(body);
}

function sendJson(res, status, obj) {
  send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > (limit || 1e6)) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function clientIp(req) {
  return String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
}

function rateLimited(req) {
  const ip = clientIp(req);
  const now = Date.now();
  let a = loginAttempts.get(ip);
  if (!a || a.reset < now) { a = { count: 0, reset: now + 10 * 60 * 1000 }; loginAttempts.set(ip, a); }
  a.count += 1;
  return a.count > 5;
}

function resetRate(req) { loginAttempts.delete(clientIp(req)); }

function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const u = new URL(origin);
    return u.host === req.headers.host;
  } catch (_) { return false; }
}

function passAuth(req, res) {
  const s = getSession(req);
  if (!s) {
    if (req.url.startsWith('/api/')) sendJson(res, 401, { message: '请先登录' });
    else {
      res.writeHead(302, { Location: '/login' });
      res.end();
    }
    return null;
  }
  return s;
}

function loginPage(error) {
  const msg = error ? '<div class="err">' + escapeHtml(error) + '</div>' : '';
  return '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>GidHub · 私有控制台</title><style>' +
    ':root{color-scheme:light dark}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f6f8fa;color:#1f2328;font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans SC",sans-serif;padding:24px}' +
    '@media(prefers-color-scheme:dark){body{background:#0d1117;color:#e6edf3}.box{background:#161b22!important;border-color:#30363d!important}.muted{color:#8b949e!important}input{background:#0d1117!important;border-color:#30363d!important;color:#e6edf3!important}}' +
    '.box{width:100%;max-width:380px;background:#fff;border:1px solid #d8dee4;border-radius:12px;padding:28px;box-shadow:0 8px 24px rgba(140,149,159,.12)}' +
    '.mark{width:44px;height:44px;border-radius:10px;background:#1f883d;color:#fff;display:flex;align-items:center;justify-content:center;font:700 20px/1 ui-monospace,Consolas,monospace;margin-bottom:16px}' +
    'h1{font-size:20px;margin:0 0 6px}p{margin:0 0 18px;color:#59636e;font-size:13px}.muted{color:#59636e}' +
    'label{display:block;font-size:12px;font-weight:600;margin:0 0 6px}input{width:100%;height:40px;border:1px solid #d0d7de;border-radius:8px;padding:0 12px;font:14px ui-monospace,SFMono-Regular,Consolas,monospace;background:#fff;color:#1f2328;outline:none}' +
    'input:focus{border-color:#1f883d;box-shadow:0 0 0 3px rgba(31,136,61,.15)}button{width:100%;height:40px;margin-top:14px;border:0;border-radius:8px;background:#1f883d;color:#fff;font-weight:600;font-size:14px;cursor:pointer}button:hover{background:#1a7f37}' +
    '.err{margin:0 0 14px;padding:10px 12px;border:1px solid #ffcecb;background:#ffebe9;color:#cf222e;border-radius:8px;font-size:13px}' +
    '.foot{margin-top:20px;padding-top:14px;border-top:1px solid #d8dee4;font-size:11px;color:#8b949e;display:flex;justify-content:space-between;gap:8px}' +
    '</style></head><body><main class="box"><div class="mark">G</div><h1>GidHub 私有控制台</h1><p>站主的 GitHub key 存在服务端，浏览器不接触。登录后可使用全部仓库与建站功能。</p>' + msg +
    '<form method="POST" action="/login"><label for="p">站主密码</label><input id="p" name="password" type="password" autocomplete="current-password" required autofocus placeholder="输入密码">' +
    '<button type="submit">进入控制台</button></form><div class="foot"><span>仅站主可进入</span><span>GidHub</span></div></main></body></html>';
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

async function handleLogin(req, res) {
  if (req.method === 'GET') {
    send(res, 200, loginPage(''), { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return;
  }
  if (req.method !== 'POST') { send(res, 405, 'Method Not Allowed'); return; }
  if (rateLimited(req)) {
    send(res, 429, loginPage('尝试次数过多，请 10 分钟后再试。'), { 'Content-Type': 'text/html; charset=utf-8' });
    return;
  }
  let body;
  try { body = (await readBody(req, 32 * 1024)).toString('utf8'); } catch (_) { send(res, 400, 'Bad Request'); return; }
  const params = new URLSearchParams(body);
  const password = params.get('password') || '';
  if (!checkPassword(password)) {
    send(res, 401, loginPage('密码不对。'), { 'Content-Type': 'text/html; charset=utf-8' });
    return;
  }
  let user;
  try { user = await githubUser(); } catch (e) {
    send(res, 502, loginPage('服务端 GitHub token 不可用：' + e.message), { 'Content-Type': 'text/html; charset=utf-8' });
    return;
  }
  resetRate(req);
  const sid = newSession(user);
  setSessionCookie(req, res, sid);
  res.writeHead(302, { Location: '/' });
  res.end();
}

function githubUser() {
  return new Promise((resolve, reject) => {
    const req = https.request('https://api.github.com/user', {
      method: 'GET',
      headers: {
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'GidHub-Backend',
        'Authorization': 'Bearer ' + token()
      }
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode));
        try { const u = JSON.parse(data); resolve({ login: u.login, name: u.name, avatar_url: u.avatar_url, public_repos: u.public_repos, total_private_repos: u.total_private_repos }); }
        catch (e) { reject(new Error('bad JSON')); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function proxyGitHub(req, res) {
  if (!sameOrigin(req)) { send(res, 403, 'Forbidden'); return; }
  if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers['x-gidhub-csrf'] !== '1') {
    send(res, 403, 'Missing CSRF header'); return;
  }
  let rest = req.url.slice('/api/github'.length) || '/';
  if (!rest.startsWith('/')) rest = '/' + rest;
  if (rest.includes('..')) { send(res, 400, 'Bad path'); return; }
  const headers = {
    'Accept': req.headers.accept || 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'GidHub-Backend',
    'Authorization': 'Bearer ' + token()
  };
  if (req.headers['content-type']) headers['Content-Type'] = req.headers['content-type'];
  const upstream = https.request('https://api.github.com' + rest, { method: req.method, headers }, up => {
    const pass = {};
    ['content-type', 'content-length', 'content-disposition', 'link', 'etag', 'last-modified', 'cache-control',
      'x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset', 'x-ratelimit-used', 'x-ratelimit-resource',
      'x-oauth-scopes', 'x-accepted-oauth-scopes'].forEach(h => { if (up.headers[h]) pass[h] = up.headers[h]; });
    pass['Cache-Control'] = pass['cache-control'] || 'no-store';
    res.writeHead(up.statusCode || 502, pass);
    up.pipe(res);
  });
  upstream.on('error', e => sendJson(res, 502, { message: 'GitHub 连接失败：' + e.message }));
  req.pipe(upstream);
}

const ASSET_HOSTS = ['raw.githubusercontent.com', 'objects.githubusercontent.com', 'github.com', 'codeload.github.com'];

function allowedAsset(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return false;
    if (u.username || u.password) return false;
    return ASSET_HOSTS.some(h => u.hostname === h || u.hostname.endsWith('.' + h));
  } catch (_) { return false; }
}

function proxyAsset(req, res) {
  const u = new URL(req.url, 'http://localhost');
  const target = u.searchParams.get('url') || '';
  if (!allowedAsset(target)) { send(res, 400, 'Bad asset'); return; }
  let redirects = 0;
  const go = (url) => {
    if (redirects++ > 4 || !allowedAsset(url)) { send(res, 502, 'Too many redirects'); return; }
    const up = https.get(url, {
      headers: {
        'User-Agent': 'GidHub-Backend',
        'Authorization': 'Bearer ' + token(),
        'Accept': '*/*'
      }
    }, r => {
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) {
        r.resume();
        return go(new URL(r.headers.location, url).toString());
      }
      const pass = {};
      ['content-type', 'content-length', 'content-disposition', 'etag', 'last-modified', 'cache-control'].forEach(h => { if (r.headers[h]) pass[h] = r.headers[h]; });
      pass['Cache-Control'] = pass['cache-control'] || 'private, max-age=600';
      res.writeHead(r.statusCode || 502, pass);
      r.pipe(res);
    });
    up.on('error', e => send(res, 502, 'Asset error: ' + e.message));
  };
  go(target);
}

function serveIndex(req, res) {
  let html;
  try { html = fs.readFileSync(INDEX_FILE, 'utf8'); } catch (e) { send(res, 500, 'index.html missing'); return; }
  html = html.replace('<head>', '<head>\n<script>window.GIDHUB_BACKEND=true;</script>');
  send(res, 200, html, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/health') return sendJson(res, 200, { ok: true });
    if (url.pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
    if (url.pathname === '/login') return handleLogin(req, res);

    const session = getSession(req);
    if (!session) {
      if (url.pathname.startsWith('/api/')) return sendJson(res, 401, { message: '请先登录' });
      res.writeHead(302, { Location: '/login' });
      return res.end();
    }

    if (url.pathname === '/api/session') {
      return sendJson(res, 200, { authenticated: true, backend: true, me: session.user });
    }
    if (url.pathname === '/api/logout') {
      if (req.method !== 'POST' || req.headers['x-gidhub-csrf'] !== '1') return sendJson(res, 403, { message: 'Forbidden' });
      const sid = parseCookies(req)[COOKIE];
      if (sid) sessions.delete(sid);
      clearSessionCookie(req, res);
      return sendJson(res, 200, { ok: true });
    }
    if (url.pathname.startsWith('/api/github')) return proxyGitHub(req, res);
    if (url.pathname === '/api/asset') {
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method Not Allowed');
      return proxyAsset(req, res);
    }
    if (url.pathname === '/' || url.pathname === '/index.html') return serveIndex(req, res);
    return send(res, 404, 'Not found');
  } catch (e) {
    console.error('[gidhub]', e && e.stack ? e.stack : e);
    if (!res.headersSent) sendJson(res, 500, { message: '内部错误' });
  }
});

server.listen(PORT, HOST, () => {
  console.log('[gidhub] listening on http://' + HOST + ':' + PORT);
  console.log('[gidhub] owner password file: ' + PASSWORD_FILE);
});
