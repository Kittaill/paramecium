// face-api.mjs — Claude.ai 风格前端（face/）的适配层
//
// 前端壳说的是 FastAPI 版后端的 /api 方言（named SSE events + Bearer token），
// 网关说的是 Anthropic 原生 SSE 方言。这个文件是两种方言之间的翻译官：
// 它不组装 prompt、不碰记忆、不管缓存——那些全是 gateway.mjs 的事。
// 它只做三件事：认证、静态文件、把 /api 契约翻译成 handleGatewaySend 调用。
//
// 设计约束：face/ 里的 index.html 一个字不改（除侧边栏/下拉菜单的增减项），
// 所以这里必须严格适配它既有的请求/事件形状，而不是反过来。

import { handleGatewaySend } from './gateway.mjs';
import {
  readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync,
  unlinkSync, statSync
} from 'fs';
import { createHmac, randomUUID, timingSafeEqual } from 'crypto';
import { basename, extname } from 'path';
import { fileURLToPath } from 'url';

const DATA = '/opt/chat-api/data';
const UPLOAD_ROOT = '/opt/chat-api/uploads';
const IMAGES_DIR = '/opt/chat-api/images';
const MEM_DIR = '/opt/raffaello/memory';
const MEMORIES_JSON = '/opt/memory-mcp/data/memories.json';
const FACE_DIR = fileURLToPath(new URL('../face/', import.meta.url));

const RESERVED_JSON = new Set(['settings.json', 'memory.json', 'gateway-stats.json', 'face-profile.json']);

// ============================================================
//  认证 — 与原后端 auth.py 同一套 HMAC token 方案
//  环境变量 FACE_PASSWORD / FACE_SECRET，或 settings.json 里的
//  facePassword / faceSecret。两者都没配时开放访问（打警告），
//  适用于已有 Cloudflare Access / nginx basic auth 兜底的部署。
// ============================================================

function faceCredentials() {
  let settings = {};
  try { settings = JSON.parse(readFileSync(DATA + '/settings.json', 'utf8')); } catch {}
  const password = process.env.FACE_PASSWORD || settings.facePassword || '';
  const secret = process.env.FACE_SECRET || settings.faceSecret || '';
  return { password, secret };
}

function expectedToken(secret) {
  return createHmac('sha256', secret).update('face-v1').digest('hex');
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a)), bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

let _warnedOpen = false;
function authOk(req) {
  const { password, secret } = faceCredentials();
  if (!password || !secret) {
    if (!_warnedOpen) { console.warn('[face] FACE_PASSWORD/FACE_SECRET 未配置——face 处于无认证开放模式，请确保有外层防护'); _warnedOpen = true; }
    return true;
  }
  const header = req.headers['authorization'] || '';
  const token = header.replace(/^Bearer\s+/i, '').trim();
  return token ? safeEqual(token, expectedToken(secret)) : false;
}

// ============================================================
//  小工具
// ============================================================

const json = (res, data, status = 200) => {
  if (res.headersSent) return;
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
  res.end(JSON.stringify(data));
};
const unauthorized = res => json(res, { detail: 'unauthorized' }, 401);
const readBody = req => new Promise(r => { let d = ''; req.on('data', c => d += c); req.on('end', () => r(d)); });
const readRawBody = req => new Promise(r => { const chunks = []; req.on('data', c => chunks.push(c)); req.on('end', () => r(Buffer.concat(chunks))); });

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8'
};
const mimeOf = f => MIME[extname(f).toLowerCase()] || 'application/octet-stream';

function serveFile(res, filepath, cache = 'no-cache') {
  if (!existsSync(filepath)) { json(res, { error: 'not found' }, 404); return; }
  res.writeHead(200, { 'Content-Type': mimeOf(filepath), 'Cache-Control': cache });
  res.end(readFileSync(filepath));
}

// 文件名/路径消毒：只允许落在指定目录内的直接子文件
function insideDir(dir, name) {
  if (!name || name.includes('/') || name.includes('\\') || name.includes('..')) return null;
  const p = dir + '/' + name;
  return existsSync(p) && statSync(p).isFile() ? p : null;
}

// ============================================================
//  对话文件（与 server.mjs / gateway.mjs 同一套 JSON 文件约定）
// ============================================================

function convFiles() {
  if (!existsSync(DATA)) return [];
  return readdirSync(DATA).filter(f => f.endsWith('.json') && !RESERVED_JSON.has(f));
}
function loadConv(id) {
  const p = insideDir(DATA, id + '.json');
  if (!p) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
}
function saveConv(conv) {
  writeFileSync(`${DATA}/${conv.id}.json`, JSON.stringify(conv, null, 2));
}

function lastTimestamp(conv) {
  const msgs = conv.messages || [];
  for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].timestamp) return msgs[i].timestamp;
  return conv.created_at || null;
}

function listSessions() {
  const sessions = convFiles().map(f => {
    try {
      const d = JSON.parse(readFileSync(`${DATA}/${f}`, 'utf8'));
      const upd = lastTimestamp(d);
      return {
        conv_id: d.id, session_id: d.id, title: d.title || '新对话',
        starred: !!d.starred, created_at: d.created_at || null,
        updated_at: upd, last_modified: upd, latest_session_id: d.id
      };
    } catch { return null; }
  }).filter(Boolean);
  sessions.sort((a, b) => (b.starred - a.starred) || (new Date(b.updated_at || 0) - new Date(a.updated_at || 0)));
  return sessions;
}

// 把网关侧的消息翻译成 face 期望的形状。id 用 1-based 数组下标：
// 前端只拿它做分页锚点和 edit/retry 定位，翻译回来时再减一即可。
function messageText(msg) {
  if (typeof msg.content === 'string') return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content.filter(b => b.type === 'text').map(b => b.text || '').join('\n');
  }
  return '';
}

function msgToFace(msg, idx) {
  const item = {
    id: idx + 1, role: msg.role, text: messageText(msg),
    thinking: msg.thinking || '', attachments: [], traces: [],
    edited: false, timestamp: msg.timestamp || null, branch_count: 0
  };
  // 图片：压缩后原件躺在 images/，路径存在 imageFiles 里
  for (const p of (msg.imageFiles || [])) {
    item.attachments.push({ name: basename(p), path: p, mime: mimeOf(p), size: 0, is_image: true });
  }
  if (msg.imageDescription && !item.text) item.text = '';
  // 工具轨迹：blocks 里的 tool_use（含就地执行的 result）
  for (const b of (msg.blocks || [])) {
    if (b.type === 'tool_use') {
      item.traces.push({ type: 'tool_use', id: b.id, name: b.name, input: b.input, text_offset: 0 });
      if (b.result !== undefined) {
        item.traces.push({ type: 'tool_result', tool_use_id: b.id, content: String(b.result).slice(0, 20000), is_error: false });
      }
    }
  }
  return item;
}

// ============================================================
//  SSE 翻译 — Anthropic 原生事件流 → face 的 named events
// ============================================================

function emitFace(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

// 一个假 res：接住 gateway 往下游写的 Anthropic SSE，逐事件翻译后
// 写进真正的 res。gateway 的 ': ping' 保活注释原样转发。
function makeTranslatingRes(realRes) {
  let buffer = '';
  const blocks = {}; // index -> {type, id, name, inputJson}
  let ended = false;
  const shimState = { sawError: false };

  function handleEvent(evt) {
    switch (evt.type) {
      case 'content_block_start': {
        const cb = evt.content_block || {};
        blocks[evt.index] = { type: cb.type || 'text', id: cb.id, name: cb.name, inputJson: '' };
        break;
      }
      case 'content_block_delta': {
        const d = evt.delta || {};
        if (d.type === 'text_delta' && d.text) emitFace(realRes, 'delta', { text: d.text });
        else if (d.type === 'thinking_delta' && d.thinking) emitFace(realRes, 'thinking', { text: d.thinking });
        else if (d.type === 'input_json_delta' && blocks[evt.index]) blocks[evt.index].inputJson += d.partial_json || '';
        break;
      }
      case 'content_block_stop': {
        const b = blocks[evt.index];
        if (b && b.type === 'tool_use') {
          let input = {};
          try { input = JSON.parse(b.inputJson || '{}'); } catch {}
          emitFace(realRes, 'tool_use', { id: b.id, name: b.name, input });
        }
        break;
      }
      case 'gateway_tool_result':
        emitFace(realRes, 'tool_result', { tool_use_id: evt.tool_use_id, content: evt.content || '', is_error: false });
        break;
      case 'error':
        shimState.sawError = true;
        emitFace(realRes, 'error', { message: evt.error?.message || 'gateway error' });
        break;
    }
  }

  function parse(text) {
    buffer += text;
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      if (line.startsWith(':')) { realRes.write(line + '\n\n'); continue; } // 保活注释直通
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6).trim();
      if (!data || data === '[DONE]') continue;
      try { handleEvent(JSON.parse(data)); } catch {}
    }
  }

  return {
    headersSent: true,
    state: shimState,
    get writableEnded() { return ended; },
    writeHead() {},
    write(chunk) { try { parse(chunk.toString()); } catch {} return true; },
    end(chunk) {
      if (ended) return;
      if (chunk) { try { parse(chunk.toString()); } catch {} }
      ended = true;
    },
    once() {}, on() {}
  };
}

// ============================================================
//  /api/chat — 契约翻译的主入口
// ============================================================

async function handleChat(req, res) {
  const body = JSON.parse(await readBody(req) || '{}');
  const message = (body.message || '').trim();

  res.writeHead(200, {
    'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache',
    'Connection': 'keep-alive', 'X-Accel-Buffering': 'no'
  });
  const fail = msg => { emitFace(res, 'error', { message: msg }); res.end(); };

  // 会话解析/创建（对话的唯一真相在网关侧的 JSON 文件里）
  let convId = body.conversation_id || body.session_id || null;
  let conv = convId ? loadConv(convId) : null;
  if (convId && !conv) { fail('会话不存在或已被删除'); return; }
  if (!conv) {
    convId = randomUUID();
    conv = { id: convId, title: (message || '新对话').slice(0, 50), created_at: new Date().toISOString(), starred: false, messages: [] };
    saveConv(conv);
  }

  // edit / retry → 网关的 edit_at 语义（截断到该下标后重发）
  let editAt;
  let sendMessage = message;
  if (body.edit_message_id != null && body.retry_message_id != null) { fail('一次只能执行一种分支操作'); return; }
  if (body.edit_message_id != null) {
    editAt = body.edit_message_id - 1;
    if (editAt < 0 || editAt >= (conv.messages || []).length) { fail('这条消息不能这样操作'); return; }
  } else if (body.retry_message_id != null) {
    const upto = Math.min(body.retry_message_id - 1, (conv.messages || []).length);
    let ui = -1;
    for (let i = upto - 1; i >= 0; i--) if (conv.messages[i].role === 'user') { ui = i; break; }
    if (ui < 0) { fail('这条消息不能这样操作'); return; }
    sendMessage = messageText(conv.messages[ui]);
    editAt = ui;
  }
  if (!sendMessage && !(body.attachments || []).length) { fail('消息或附件不能为空'); return; }

  // 附件：第一张图片走网关的 image_data 通道（原件落盘 + Haiku 转述都在网关侧），
  // 其余附件以文字注记进正文。非图片文件同理——recall/exec 都在服务端，模型看注记即可。
  let imageData, imageMediaType;
  const notes = [];
  for (const rawPath of (body.attachments || [])) {
    const name = basename(String(rawPath));
    const p = insideDir(`${UPLOAD_ROOT}/${convId}`, name);
    if (!p) continue;
    const isImage = ['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(extname(p).toLowerCase());
    if (isImage && !imageData) {
      imageData = readFileSync(p).toString('base64');
      imageMediaType = mimeOf(p);
    } else {
      notes.push(`[用户上传了文件：${name.split('_').slice(2).join('_') || name}（服务器路径 ${p}）]`);
    }
  }
  if (notes.length) sendMessage = (sendMessage ? sendMessage + '\n\n' : '') + notes.join('\n');

  // face 契约：先报会话身份，再开始流
  const baseLen = editAt !== undefined ? editAt : (conv.messages || []).length;
  emitFace(res, 'conversation', { conversation_id: convId, user_message_id: baseLen + 1 });

  const shim = makeTranslatingRes(res);

  // body.model 是 "渠道::模型" 复合键；旧的纯渠道名也兼容
  let accountName, modelOverride;
  if (body.model) {
    const sep = String(body.model).indexOf(MODEL_SEP);
    if (sep > 0) { accountName = body.model.slice(0, sep); modelOverride = body.model.slice(sep + MODEL_SEP.length); }
    else accountName = body.model;
  }

  try {
    // handleGatewaySend 内部会等 saveConv / checkCycle 全部做完才返回，
    // 所以 done 必须发在 await 之后——early emit 会读到落盘前的旧计数
    await handleGatewaySend({
      conversation_id: convId,
      message: sendMessage,
      image_data: imageData,
      image_media_type: imageMediaType,
      account: accountName,
      model: modelOverride,
      edit_at: editAt
    }, shim);
    if (!shim.state.sawError) {
      const saved = loadConv(convId) || conv;
      emitFace(res, 'done', {
        session_id: convId, conversation_id: convId,
        assistant_message_id: (saved.messages || []).length
      });
    }
  } catch (e) {
    emitFace(res, 'error', { message: e.message || 'gateway error' });
  }
  res.end();
}

// ============================================================
//  /api/upload — 最小 multipart 解析（零依赖）
// ============================================================

const ALLOWED_UPLOAD_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp',
  '.txt', '.md', '.csv', '.json', '.pdf',
  '.py', '.js', '.mjs', '.ts', '.html', '.css', '.c', '.cc', '.cpp', '.sh', '.yaml', '.yml', '.xml', '.log'
]);
const MAX_UPLOAD_BYTES = 60 * 1024 * 1024;

function safeName(name) {
  return String(name || 'file').replace(/[^\w.一-鿿-]+/g, '_').slice(-80) || 'file';
}

function parseMultipart(buf, boundary) {
  const parts = [];
  const sep = Buffer.from('--' + boundary);
  let pos = buf.indexOf(sep);
  while (pos !== -1) {
    const next = buf.indexOf(sep, pos + sep.length);
    if (next === -1) break;
    let part = buf.slice(pos + sep.length, next);
    // 去掉开头的 \r\n 和结尾的 \r\n
    if (part[0] === 0x0d && part[1] === 0x0a) part = part.slice(2);
    if (part[part.length - 2] === 0x0d && part[part.length - 1] === 0x0a) part = part.slice(0, -2);
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd !== -1) {
      const headers = part.slice(0, headerEnd).toString();
      const body = part.slice(headerEnd + 4);
      const nameM = headers.match(/name="([^"]*)"/);
      const fileM = headers.match(/filename="([^"]*)"/);
      parts.push({ name: nameM ? nameM[1] : '', filename: fileM ? fileM[1] : null, body });
    }
    pos = next;
  }
  return parts;
}

async function handleUpload(req, res) {
  const ct = req.headers['content-type'] || '';
  const bm = ct.match(/boundary=(?:"([^"]+)"|([^;]+))/);
  if (!bm) { json(res, { detail: 'bad multipart' }, 400); return; }
  const raw = await readRawBody(req);
  if (raw.length > MAX_UPLOAD_BYTES) { json(res, { detail: '超过 60MB' }, 413); return; }
  const parts = parseMultipart(raw, bm[1] || bm[2]);

  let convId = null;
  const files = [];
  for (const p of parts) {
    if (p.name === 'conversation_id' && !p.filename) convId = p.body.toString().trim() || null;
    if (p.name === 'files' && p.filename) files.push(p);
  }
  if (!files.length || files.length > 10) { json(res, { detail: '请选择 1 到 10 个文件' }, 400); return; }

  // 与 /api/chat 相同的会话创建语义
  let conv = convId ? loadConv(convId) : null;
  if (convId && !conv) { json(res, { detail: 'conversation not found' }, 404); return; }
  if (!conv) {
    convId = randomUUID();
    conv = { id: convId, title: '新对话', created_at: new Date().toISOString(), starred: false, messages: [] };
    saveConv(conv);
  }

  const dir = `${UPLOAD_ROOT}/${convId}`;
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const attachments = [];
  for (const f of files) {
    const ext = extname(f.filename).toLowerCase();
    if (!ALLOWED_UPLOAD_EXT.has(ext)) { json(res, { detail: `不支持的文件类型：${f.filename}` }, 415); return; }
    const ts = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 20);
    const stored = `${ts}_${randomUUID().slice(0, 8)}_${safeName(f.filename)}`;
    writeFileSync(`${dir}/${stored}`, f.body);
    attachments.push({
      name: safeName(f.filename), path: `${dir}/${stored}`, mime: mimeOf(stored),
      size: f.body.length, is_image: ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'].includes(ext)
    });
  }
  json(res, { conversation_id: convId, attachments });
}

// ============================================================
//  splash / models / diary / memory / profile
// ============================================================

function currentPeriod() {
  const hour = Number(new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, timeZone: 'Asia/Shanghai' }).format(new Date()));
  if (hour >= 5 && hour < 11) return 'morning';
  if (hour >= 11 && hour < 18) return 'afternoon';
  if (hour >= 18 && hour < 23) return 'evening';
  return 'latenight';
}

function splashLine(period) {
  try {
    const pool = JSON.parse(readFileSync(FACE_DIR + 'splash_lines.json', 'utf8'));
    const lines = (pool[period] || []).filter(l => String(l).trim());
    if (lines.length) return lines[Math.floor(Math.random() * lines.length)];
  } catch {}
  return "What's on your mind?";
}

// 渠道与模型解耦：accounts 是渠道（endpoint+key+models 列表），
// 下拉菜单展开渠道下的全部模型，id 用 "渠道::模型" 复合键。
// 兼容旧格式：没有 models 数组的渠道回落到单个 model 字段。
const MODEL_SEP = '::';

function channelModels(account) {
  const list = Array.isArray(account.models) && account.models.length
    ? account.models
    : (account.model ? [account.model] : []);
  return list.filter(Boolean);
}

function listModels() {
  let settings = {};
  try { settings = JSON.parse(readFileSync(DATA + '/settings.json', 'utf8')); } catch {}
  const accounts = settings.accounts || [];
  if (!accounts.length) {
    return [{ id: 'default', label: settings.model || 'Default', desc: settings.endpoint || '', thinking: 'adaptive', primary: true }];
  }
  const out = [];
  for (const a of accounts) {
    for (const m of channelModels(a)) {
      out.push({
        id: `${a.name}${MODEL_SEP}${m}`,
        label: m, desc: a.label || a.name,
        thinking: 'adaptive', primary: out.length < 4
      });
    }
  }
  return out.length ? out : [{ id: 'default', label: 'Default', desc: '渠道未配置模型', thinking: 'adaptive', primary: true }];
}

// 拉取渠道的可用模型列表（服务端代发，key 不出网关）
async function fetchChannelModels(account) {
  const base = (account.endpoint || '').replace(/\/+$/, '');
  if (!base) throw new Error('渠道没有配置 endpoint');
  const isAnthropic = (account.provider || '').toLowerCase() === 'anthropic' || base.includes('anthropic.com');
  const url = base.includes('/v1') ? base + '/models' : base + '/v1/models';
  const headers = isAnthropic
    ? { 'x-api-key': account.apiKey || '', 'anthropic-version': '2023-06-01' }
    : { 'Authorization': `Bearer ${account.apiKey || ''}` };
  const resp = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
  if (!resp.ok) throw new Error(`${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  const data = await resp.json();
  return (data.data || data.models || []).map(m => m.id || m.name).filter(Boolean);
}

function diaryEntries() {
  try {
    const all = JSON.parse(readFileSync(MEMORIES_JSON, 'utf8'));
    return all
      .filter(m => m.category === '日记' && m.content)
      .sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')))
      .map(m => ({ date: String(m.created_at || '').slice(0, 10), text: m.content }));
  } catch { return []; }
}

const FACE_PROFILE = DATA + '/face-profile.json';
function readFaceProfile() {
  try { return JSON.parse(readFileSync(FACE_PROFILE, 'utf8')); } catch {}
  return { fullName: '', nickname: '', savedMemories: [], preferences: {}, claudeExportImport: {}, updatedAt: null };
}

// ============================================================
//  老端点门锁 — 不依赖反代的路径过滤
//
//  cloudflared 直连 3800 时，/conversations /settings /gateway/* 这些
//  无认证的老端点会一起暴露在公网。判定标准：请求带反代转发头
//  （cf-connecting-ip / x-forwarded-for / x-real-ip）即视为外部流量，
//  要求 face 的 Bearer token；本机 cron 和网关的回环调用不带这些头，
//  照常放行。face 未配置密码时门锁不生效（整体开放模式）。
// ============================================================

export function guardLegacyRequest(req, res) {
  const { password, secret } = faceCredentials();
  if (!password || !secret) return false;
  const external = req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || req.headers['x-real-ip'];
  if (!external) return false;
  if (authOk(req)) return false;
  unauthorized(res);
  return true;
}

// ============================================================
//  路由入口 — server.mjs 把请求先递到这里，认领了返回 true
// ============================================================

export async function handleFaceRequest(req, res, url) {
  const path = url.pathname;
  const method = req.method;

  // --- 静态壳 ---
  if (method === 'GET' && path === '/') { serveFile(res, FACE_DIR + 'index.html'); return true; }
  if (method === 'GET' && path === '/marked.min.js') { serveFile(res, FACE_DIR + 'marked.min.js', 'public, max-age=86400'); return true; }
  if (method === 'GET' && path === '/static/design-system.css') { serveFile(res, FACE_DIR + 'design-system.css'); return true; }
  if (method === 'GET' && ['/favicon.ico', '/static/manifest.webmanifest', '/static/css/typography-locked.css'].includes(path)) {
    res.writeHead(204); res.end(); return true;
  }

  if (!path.startsWith('/api/')) return false;

  // --- 免认证端点 ---
  if (method === 'POST' && path === '/api/auth') {
    const body = JSON.parse(await readBody(req) || '{}');
    const { password, secret } = faceCredentials();
    if (!password || !secret) { json(res, { token: 'open' }); return true; }
    if (body.password && safeEqual(body.password, password)) json(res, { token: expectedToken(secret) });
    else json(res, { detail: 'unauthorized' }, 401);
    return true;
  }
  if (method === 'GET' && path === '/api/splash') {
    const period = currentPeriod();
    json(res, { period, line: splashLine(period) });
    return true;
  }
  if (method === 'GET' && path === '/api/models') { json(res, { models: listModels() }); return true; }

  // --- 以下全部需要认证 ---
  if (!authOk(req)) { unauthorized(res); return true; }

  // 聊天
  if (method === 'POST' && path === '/api/chat') { await handleChat(req, res); return true; }

  // 会话列表 / 消息 / 改名 / 星标 / 删除
  if (method === 'GET' && path === '/api/sessions') { json(res, { sessions: listSessions() }); return true; }

  let m;
  if (method === 'GET' && (m = path.match(/^\/api\/sessions\/([^/]+)\/messages$/))) {
    const conv = loadConv(decodeURIComponent(m[1]));
    if (!conv) { json(res, { detail: 'session not found' }, 404); return true; }
    const all = (conv.messages || []).map(msgToFace);
    const beforeId = url.searchParams.get('before_id');
    const limit = url.searchParams.get('limit');
    let items = beforeId ? all.filter(x => x.id < Number(beforeId)) : all;
    let hasMore = false, nextBeforeId = null;
    if (limit) {
      const n = Math.max(1, Math.min(Number(limit) || 0, 200));
      if (items.length > n) { hasMore = true; items = items.slice(-n); nextBeforeId = items[0].id; }
    }
    json(res, { messages: items, has_more: hasMore, next_before_id: nextBeforeId });
    return true;
  }
  if (method === 'PATCH' && (m = path.match(/^\/api\/sessions\/([^/]+)\/title$/))) {
    const conv = loadConv(decodeURIComponent(m[1]));
    if (!conv) { json(res, { detail: 'not found' }, 404); return true; }
    const body = JSON.parse(await readBody(req) || '{}');
    conv.title = String(body.title || '').slice(0, 120) || conv.title;
    saveConv(conv);
    json(res, { renamed: true });
    return true;
  }
  if (method === 'PATCH' && (m = path.match(/^\/api\/sessions\/([^/]+)\/star$/))) {
    const conv = loadConv(decodeURIComponent(m[1]));
    if (!conv) { json(res, { detail: 'not found' }, 404); return true; }
    const body = JSON.parse(await readBody(req) || '{}');
    conv.starred = !!body.starred;
    saveConv(conv);
    json(res, { starred: conv.starred });
    return true;
  }
  if (method === 'DELETE' && (m = path.match(/^\/api\/sessions\/([^/]+)$/))) {
    const id = decodeURIComponent(m[1]);
    const p = insideDir(DATA, id + '.json');
    if (p) unlinkSync(p);
    const updir = `${UPLOAD_ROOT}/${id}`;
    if (!id.includes('..') && !id.includes('/') && existsSync(updir)) {
      for (const f of readdirSync(updir)) { try { unlinkSync(`${updir}/${f}`); } catch {} }
    }
    json(res, { deleted: true });
    return true;
  }

  // 上传与取回
  if (method === 'POST' && path === '/api/upload') { await handleUpload(req, res); return true; }
  if (method === 'GET' && (m = path.match(/^\/api\/uploads\/([^/]+)\/([^/]+)$/))) {
    const convId = decodeURIComponent(m[1]), fname = decodeURIComponent(m[2]);
    let p = null;
    if (!convId.includes('..') && !convId.includes('/')) p = insideDir(`${UPLOAD_ROOT}/${convId}`, fname);
    // 网关压缩图片后原件存进 images/，文件名以 convId_ 开头
    if (!p && fname.startsWith(convId + '_')) p = insideDir(IMAGES_DIR, fname);
    if (!p) { json(res, { detail: 'not found' }, 404); return true; }
    serveFile(res, p, 'private, max-age=86400');
    return true;
  }

  // 记忆（L2 画像层 user.md 的在线编辑）与日记
  if (method === 'GET' && path === '/api/memory') {
    let content = '';
    try { content = readFileSync(MEM_DIR + '/profile/user.md', 'utf8'); } catch {}
    json(res, { content });
    return true;
  }
  if (method === 'PUT' && path === '/api/memory') {
    const body = JSON.parse(await readBody(req) || '{}');
    writeFileSync(MEM_DIR + '/profile/user.md', String(body.content || ''));
    json(res, { saved: true });
    return true;
  }
  if (method === 'GET' && path === '/api/diary') { json(res, { entries: diaryEntries() }); return true; }

  // 个性化档案（face 自己的偏好存储，与记忆系统无关）
  if (method === 'GET' && path === '/api/profile') {
    json(res, { profile: readFaceProfile(), importedCount: 0, foundCount: 0 });
    return true;
  }
  if (method === 'PUT' && path === '/api/profile') {
    const body = JSON.parse(await readBody(req) || '{}');
    const profile = { ...readFaceProfile(), ...body, updatedAt: Date.now() };
    writeFileSync(FACE_PROFILE, JSON.stringify(profile, null, 2));
    json(res, { saved: true, profile });
    return true;
  }
  if (method === 'POST' && path === '/api/profile/memory') {
    const body = JSON.parse(await readBody(req) || '{}');
    const content = String(body.content || '').trim();
    if (!content) { json(res, { saved: false, reason: 'empty content' }); return true; }
    const profile = readFaceProfile();
    if ((profile.savedMemories || []).some(x => x.content === content)) { json(res, { saved: false, reason: 'duplicate or limit reached' }); return true; }
    const memory = { id: randomUUID(), content, createdAt: Date.now() };
    profile.savedMemories = [...(profile.savedMemories || []), memory];
    writeFileSync(FACE_PROFILE, JSON.stringify(profile, null, 2));
    json(res, { saved: true, memory });
    return true;
  }

  // 网关设置（系统提示词 / 账号）——设置页的后端接口，走 face 认证
  if (method === 'GET' && path === '/api/settings') {
    let settings = {};
    try { settings = JSON.parse(readFileSync(DATA + '/settings.json', 'utf8')); } catch {}
    json(res, settings);
    return true;
  }
  if (method === 'PUT' && path === '/api/settings') {
    const body = JSON.parse(await readBody(req) || '{}');
    writeFileSync(DATA + '/settings.json', JSON.stringify(body, null, 2));
    json(res, { ok: true });
    return true;
  }

  // 拉取渠道可用模型（设置页的"获取模型列表"按钮）
  if (method === 'POST' && path === '/api/channel-models') {
    const body = JSON.parse(await readBody(req) || '{}');
    let settings = {};
    try { settings = JSON.parse(readFileSync(DATA + '/settings.json', 'utf8')); } catch {}
    // 优先用请求里带的渠道草稿（可能还没保存），否则按名字查已存渠道
    const account = body.account || (settings.accounts || []).find(a => a.name === body.name);
    if (!account) { json(res, { detail: 'channel not found' }, 404); return true; }
    try {
      const models = await fetchChannelModels(account);
      json(res, { models });
    } catch (e) {
      json(res, { detail: e.message }, 502);
    }
    return true;
  }

  // 轻量小模型加工的锦上添花端点：first cut 先返回空，前端自带降级路径
  if (method === 'POST' && path === '/api/thinking-summary') { json(res, { summary: '' }); return true; }
  if (method === 'POST' && path === '/api/tool-caption') { json(res, { caption: '' }); return true; }

  json(res, { detail: 'not found' }, 404);
  return true;
}
