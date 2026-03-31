// ═══════════════════════════════════════════════════════════════════════════════
//  SAGE — AI Tutor  |  Complete single-file package
// ═══════════════════════════════════════════════════════════════════════════════
//
//  HOW TO RUN:
//    1. Install Node.js from https://nodejs.org
//    2. Open Terminal / Command Prompt in this folder
//    3. Run:  node sage-complete.js
//    4. Open: http://localhost:3000
//
//  RENDER DEPLOYMENT:
//    - Upload this ONE file to a GitHub repo
//    - Connect to render.com → Web Service
//    - Build command:  npm install express dotenv
//    - Start command:  node sage-complete.js
//    - Add environment variables: ANTHROPIC_API_KEY, BRAVE_API_KEY, STABILITY_API_KEY
//
//  API KEYS:
//    Set these as environment variables, or create a .env file:
//      ANTHROPIC_API_KEY  = required  — https://console.anthropic.com
//      BRAVE_API_KEY      = optional  — https://api.search.brave.com  (free, enables web search)
//      STABILITY_API_KEY  = optional  — https://platform.stability.ai (free, enables images)
//
// ═══════════════════════════════════════════════════════════════════════════════

// ── Load .env if present (local dev) ─────────────────────────────────────────
try { require('dotenv').config(); } catch(_) {}

const http    = require('http');
const https   = require('https');
const fs      = require('fs');
const path    = require('path');

const PORT           = process.env.PORT || 3000;
const ANTHROPIC_KEY  = process.env.ANTHROPIC_API_KEY;
const BRAVE_KEY      = process.env.BRAVE_API_KEY      || '';
const STABILITY_KEY  = process.env.STABILITY_API_KEY  || '';

if (!ANTHROPIC_KEY) {
  console.error('\n❌  ANTHROPIC_API_KEY is not set.');
  console.error('    Add it to a .env file or set it as an environment variable.\n');
  process.exit(1);
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function parseBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 200000) reject(new Error('too large')); });
    req.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
    req.on('error', reject);
  });
}

function httpsPost(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('timeout')); });
    if (body) req.write(body);
    req.end();
  });
}

function httpsGet(options) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(body);
}

// ── Route handlers ────────────────────────────────────────────────────────────
async function handleChat(req, res) {
  let body;
  try { body = await parseBody(req); } catch(e) { return json(res, 400, { error: 'invalid JSON' }); }
  const { model, max_tokens, system, messages } = body;
  if (!messages?.length) return json(res, 400, { error: 'messages required' });

  const payload = JSON.stringify({ model, max_tokens, stream: true, system, messages });
  const options = {
    hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
    headers: {
      'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload),
      'anthropic-version': '2023-06-01', 'x-api-key': ANTHROPIC_KEY,
    },
  };

  const apiReq = https.request(options, apiRes => {
    res.writeHead(apiRes.statusCode, {
      'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache',
      'Connection': 'keep-alive', 'Access-Control-Allow-Origin': '*',
    });
    apiRes.on('data', c => res.write(c));
    apiRes.on('end',  () => res.end());
    apiRes.on('error', err => { console.error('stream:', err.message); res.end(); });
  });
  apiReq.on('error', err => { if (!res.headersSent) json(res, 502, { error: err.message }); });
  apiReq.setTimeout(180000, () => { apiReq.destroy(); if (!res.headersSent) json(res, 504, { error: 'timeout' }); });
  apiReq.write(payload);
  apiReq.end();
}

async function handleSearch(req, res) {
  let body;
  try { body = await parseBody(req); } catch(e) { return json(res, 400, { error: 'invalid JSON' }); }
  const { query } = body;
  if (!query) return json(res, 400, { error: 'query required' });
  if (!BRAVE_KEY) return json(res, 200, { results: [], unavailable: true });

  try {
    const result = await httpsGet({
      hostname: 'api.search.brave.com',
      path: `/res/v1/web/search?q=${encodeURIComponent(query)}&count=5&safesearch=strict`,
      method: 'GET',
      headers: { 'Accept': 'application/json', 'X-Subscription-Token': BRAVE_KEY },
    });
    if (result.status !== 200) return json(res, 200, { results: [] });
    const data = JSON.parse(result.body);
    const results = (data.web?.results || []).slice(0, 5).map(r => ({
      title: r.title, url: r.url, description: r.description,
    }));
    json(res, 200, { results });
  } catch(err) {
    console.error('search:', err.message);
    json(res, 200, { results: [] });
  }
}

async function handleImage(req, res) {
  let body;
  try { body = await parseBody(req); } catch(e) { return json(res, 400, { error: 'invalid JSON' }); }
  const { prompt } = body;
  if (!prompt) return json(res, 400, { error: 'prompt required' });
  if (!STABILITY_KEY) return json(res, 503, { error: 'Image generation not set up — add STABILITY_API_KEY to your environment variables.' });

  try {
    const payload = JSON.stringify({
      text_prompts: [{ text: prompt, weight: 1 }, { text: 'blurry, ugly, text, watermark', weight: -1 }],
      cfg_scale: 7, height: 512, width: 512, steps: 30, samples: 1,
    });
    const result = await httpsPost({
      hostname: 'api.stability.ai',
      path: '/v1/generation/stable-diffusion-v1-6/text-to-image',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload),
        'Authorization': `Bearer ${STABILITY_KEY}`, 'Accept': 'application/json',
      },
    }, payload);

    if (result.status !== 200) {
      const e = JSON.parse(result.body);
      return json(res, result.status, { error: e.message || 'Generation failed' });
    }
    const data = JSON.parse(result.body);
    const base64 = data.artifacts?.[0]?.base64;
    if (!base64) return json(res, 500, { error: 'No image returned' });
    json(res, 200, { image: `data:image/png;base64,${base64}` });
  } catch(err) {
    console.error('image:', err.message);
    json(res, 500, { error: err.message });
  }
}

// ── The entire frontend (inlined) ─────────────────────────────────────────────
const FRONTEND = `
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Sage — Your Study Companion</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Lora:ital,wght@0,400;0,600;1,400&family=DM+Sans:wght@300;400;500&display=swap" rel="stylesheet">
<style>
  :root {
    --sage: #7B9E87;
    --sage-light: #A8C4B0;
    --sage-pale: #EEF4F0;
    --sand: #F5F0E8;
    --warm-white: #FDFCF9;
    --ink: #1C2B1E;
    --ink-soft: #4A5E4D;
    --ink-muted: #8A9E8D;
    --amber: #D4935A;
    --amber-pale: #FBF3EB;
    --rose: #C97A7A;
    --sky: #7A9EC9;
    --violet: #9A7AC9;
    --radius: 16px;
    --radius-sm: 10px;
  }

  * { margin: 0; padding: 0; box-sizing: border-box; }

  body {
    font-family: 'DM Sans', sans-serif;
    background: var(--warm-white);
    color: var(--ink);
    min-height: 100vh;
    overflow-x: hidden;
  }

  /* ─── SCREENS ─── */
  .screen { display: none; min-height: 100vh; }
  .screen.active { display: flex; flex-direction: column; }

  /* ─── LANDING ─── */
  #screen-landing {
    background: var(--sand);
    align-items: center;
    justify-content: center;
    padding: 40px 24px;
    position: relative;
    overflow: hidden;
  }

  #screen-landing::before {
    content: '';
    position: absolute;
    width: 600px; height: 600px;
    border-radius: 50%;
    background: radial-gradient(circle, rgba(123,158,135,0.15) 0%, transparent 70%);
    top: -100px; right: -150px;
    pointer-events: none;
  }
  #screen-landing::after {
    content: '';
    position: absolute;
    width: 400px; height: 400px;
    border-radius: 50%;
    background: radial-gradient(circle, rgba(212,147,90,0.1) 0%, transparent 70%);
    bottom: -100px; left: -100px;
    pointer-events: none;
  }

  .landing-inner {
    max-width: 520px;
    width: 100%;
    text-align: center;
    position: relative;
    z-index: 1;
    animation: fadeUp 0.7s ease both;
  }

  .landing-logo {
    margin-bottom: 14px;
  }

  .logo-name-only {
    font-family: 'Lora', serif;
    font-size: 28px;
    font-weight: 600;
    color: var(--ink);
    letter-spacing: -0.5px;
    margin-bottom: 8px;
  }

  .logo {
    display: inline-flex;
    align-items: center;
    gap: 10px;
  }

  .logo-mark {
    width: 40px; height: 40px;
    border-radius: 12px;
    background: linear-gradient(160deg, #6EB5FF 0%, #7B6FD4 100%);
    display: flex; align-items: center; justify-content: center;
    overflow: hidden;
  }

  .logo-name {
    font-family: 'Lora', serif;
    font-size: 22px;
    font-weight: 600;
    color: var(--ink);
    letter-spacing: -0.3px;
  }

  .hero-heading {
    font-family: 'Lora', serif;
    font-size: clamp(32px, 6vw, 48px);
    font-weight: 600;
    line-height: 1.15;
    color: var(--ink);
    margin-bottom: 16px;
    letter-spacing: -0.5px;
  }

  .hero-heading em {
    color: var(--sage);
    font-style: italic;
  }

  .hero-sub {
    font-size: 16px;
    color: var(--ink-soft);
    line-height: 1.6;
    margin-bottom: 48px;
    font-weight: 300;
  }

  .age-card {
    background: white;
    border-radius: var(--radius);
    padding: 32px;
    box-shadow: 0 2px 24px rgba(28,43,30,0.07);
    text-align: left;
  }

  .age-card label {
    display: block;
    font-size: 13px;
    font-weight: 500;
    color: var(--ink-muted);
    text-transform: uppercase;
    letter-spacing: 0.8px;
    margin-bottom: 12px;
  }

  .age-input-row {
    display: flex;
    gap: 12px;
    align-items: center;
    margin-bottom: 20px;
  }

  .age-input {
    flex: 1;
    height: 52px;
    border: 1.5px solid #E0E8E2;
    border-radius: var(--radius-sm);
    padding: 0 16px;
    font-size: 18px;
    font-family: 'DM Sans', sans-serif;
    font-weight: 500;
    color: var(--ink);
    background: var(--sage-pale);
    outline: none;
    transition: border-color 0.2s;
  }
  .age-input:focus { border-color: var(--sage); }

  .age-hint {
    font-size: 12px;
    color: var(--ink-muted);
    margin-bottom: 20px;
  }

  .btn-primary {
    width: 100%;
    height: 52px;
    background: var(--ink);
    color: white;
    border: none;
    border-radius: var(--radius-sm);
    font-size: 15px;
    font-family: 'DM Sans', sans-serif;
    font-weight: 500;
    cursor: pointer;
    transition: background 0.2s, transform 0.1s;
    letter-spacing: 0.1px;
  }
  .btn-primary:hover { background: var(--ink-soft); }
  .btn-primary:active { transform: scale(0.99); }

  .subjects-preview {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    justify-content: center;
    margin-top: 36px;
  }

  .subject-pill {
    background: white;
    border: 1.5px solid #E0E8E2;
    border-radius: 100px;
    padding: 6px 14px;
    font-size: 13px;
    color: var(--ink-soft);
    font-weight: 400;
  }

  /* ─── SUBJECT PICKER ─── */
  #screen-subjects {
    background: var(--warm-white);
    padding: 0;
  }

  .topbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 20px 24px;
    border-bottom: 1px solid #EEF0EC;
    background: white;
    position: sticky;
    top: 0;
    z-index: 10;
  }

  .topbar-logo {
    font-family: 'Lora', serif;
    font-weight: 600;
    font-size: 18px;
    color: var(--ink);
    display: flex; align-items: center; gap: 8px;
  }

  .age-badge {
    background: var(--sage-pale);
    color: var(--sage);
    border-radius: 100px;
    padding: 4px 12px;
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    transition: background 0.2s;
  }
  .age-badge:hover { background: #D4E8DA; }

  .subjects-body {
    padding: 32px 24px;
    max-width: 640px;
    margin: 0 auto;
    flex: 1;
  }

  .section-title {
    font-family: 'Lora', serif;
    font-size: 24px;
    font-weight: 600;
    color: var(--ink);
    margin-bottom: 6px;
  }

  .section-sub {
    font-size: 14px;
    color: var(--ink-muted);
    margin-bottom: 28px;
    font-weight: 300;
  }

  .subject-grid {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 12px;
  }

  .subject-card {
    background: white;
    border: 1.5px solid #E8EDE9;
    border-radius: var(--radius);
    padding: 20px;
    cursor: pointer;
    transition: all 0.2s;
    position: relative;
    overflow: hidden;
  }

  .subject-card::before {
    content: '';
    position: absolute;
    inset: 0;
    opacity: 0;
    transition: opacity 0.2s;
  }

  .subject-card:hover {
    border-color: transparent;
    transform: translateY(-2px);
    box-shadow: 0 8px 24px rgba(28,43,30,0.1);
  }

  .subject-card:hover::before { opacity: 1; }

  .subject-card[data-color="green"]::before { background: linear-gradient(135deg, rgba(123,158,135,0.06), rgba(168,196,176,0.1)); }
  .subject-card[data-color="amber"]::before { background: linear-gradient(135deg, rgba(212,147,90,0.06), rgba(212,147,90,0.1)); }
  .subject-card[data-color="sky"]::before { background: linear-gradient(135deg, rgba(122,158,201,0.06), rgba(122,158,201,0.1)); }
  .subject-card[data-color="rose"]::before { background: linear-gradient(135deg, rgba(201,122,122,0.06), rgba(201,122,122,0.1)); }
  .subject-card[data-color="violet"]::before { background: linear-gradient(135deg, rgba(154,122,201,0.06), rgba(154,122,201,0.1)); }
  .subject-card[data-color="teal"]::before { background: linear-gradient(135deg, rgba(90,178,178,0.06), rgba(90,178,178,0.1)); }

  .subject-emoji { font-size: 28px; margin-bottom: 12px; display: block; }

  .subject-name {
    font-weight: 500;
    font-size: 15px;
    color: var(--ink);
    margin-bottom: 2px;
  }

  .subject-desc {
    font-size: 12px;
    color: var(--ink-muted);
    font-weight: 300;
  }

  /* ─── CHAT ─── */
  #screen-chat {
    background: var(--warm-white);
    height: 100vh;
    overflow: hidden;
  }

  .chat-topbar {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 14px 20px;
    border-bottom: 1px solid #EEF0EC;
    background: white;
  }

  .back-btn {
    width: 32px; height: 32px;
    border: none;
    background: var(--sage-pale);
    border-radius: 8px;
    cursor: pointer;
    display: flex; align-items: center; justify-content: center;
    font-size: 14px;
    color: var(--sage);
    transition: background 0.2s;
    flex-shrink: 0;
  }
  .back-btn:hover { background: #D4E8DA; }

  .chat-subject-info {
    flex: 1;
  }

  .chat-subject-name {
    font-weight: 500;
    font-size: 15px;
    color: var(--ink);
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .chat-age-tag {
    font-size: 12px;
    color: var(--ink-muted);
    font-weight: 300;
  }

  .messages-area {
    flex: 1;
    overflow-y: auto;
    padding: 24px 20px;
    display: flex;
    flex-direction: column;
    gap: 20px;
    height: calc(100vh - 130px);
  }

  .messages-area::-webkit-scrollbar { width: 4px; }
  .messages-area::-webkit-scrollbar-track { background: transparent; }
  .messages-area::-webkit-scrollbar-thumb { background: #D0D8D2; border-radius: 2px; }

  .msg {
    display: flex;
    gap: 12px;
    max-width: 680px;
    margin: 0 auto;
    width: 100%;
    animation: fadeUp 0.3s ease both;
  }

  .msg.user { flex-direction: row-reverse; }

  .msg-avatar {
    width: 36px; height: 36px;
    border-radius: 10px;
    background: linear-gradient(160deg, #6EB5FF 0%, #7B6FD4 100%);
    display: flex; align-items: center; justify-content: center;
    flex-shrink: 0;
    margin-top: 2px;
    overflow: hidden;
  }

  .msg.user .msg-avatar {
    background: var(--ink);
    font-size: 12px;
    color: white;
    font-weight: 600;
    font-family: 'DM Sans', sans-serif;
  }

  .msg-bubble {
    background: white;
    border: 1px solid #E8EDE9;
    border-radius: 16px;
    border-top-left-radius: 4px;
    padding: 14px 18px;
    font-size: 15px;
    line-height: 1.65;
    color: var(--ink);
    max-width: calc(100% - 48px);
  }

  .msg.user .msg-bubble {
    background: var(--ink);
    border-color: var(--ink);
    color: white;
    border-radius: 16px;
    border-top-right-radius: 4px;
  }

  .msg-bubble p { margin-bottom: 10px; }
  .msg-bubble p:last-child { margin-bottom: 0; }

  .msg-bubble .analogy-box {
    background: var(--sage-pale);
    border-left: 3px solid var(--sage);
    border-radius: 0 8px 8px 0;
    padding: 10px 14px;
    margin: 12px 0;
    font-size: 14px;
    color: var(--ink-soft);
    font-style: italic;
  }

  .msg-bubble .check-question {
    background: var(--amber-pale);
    border: 1px solid rgba(212,147,90,0.25);
    border-radius: 10px;
    padding: 12px 14px;
    margin: 14px 0 0;
    font-size: 14px;
    color: var(--ink);
    font-style: normal;
  }

  .check-question strong {
    display: block;
    font-size: 12px;
    font-weight: 500;
    color: var(--amber);
    text-transform: uppercase;
    letter-spacing: 0.5px;
    margin-bottom: 6px;
  }

  .msg-bubble ul, .msg-bubble ol {
    padding-left: 20px;
    margin: 8px 0;
  }
  .msg-bubble li {
    margin-bottom: 5px;
    line-height: 1.55;
  }
  .msg-bubble h3 {
    font-size: 15px;
    font-weight: 600;
    margin: 14px 0 6px;
    color: var(--ink);
  }
  .msg-bubble h3:first-child { margin-top: 0; }
  .msg-bubble code {
    background: var(--sage-pale);
    border-radius: 4px;
    padding: 1px 6px;
    font-family: 'Courier New', monospace;
    font-size: 13px;
    color: var(--ink-soft);
  }
  .msg.user .msg-bubble code {
    background: rgba(255,255,255,0.15);
    color: white;
  }
  .msg-bubble pre {
    background: var(--sage-pale);
    border-radius: 8px;
    padding: 12px 14px;
    margin: 10px 0;
    overflow-x: auto;
    font-family: 'Courier New', monospace;
    font-size: 13px;
    line-height: 1.5;
  }
  .msg-bubble .step-block {
    background: var(--sage-pale);
    border-radius: 10px;
    padding: 10px 14px;
    margin: 8px 0;
    font-size: 14px;
  }
  .msg-bubble .step-block strong {
    color: var(--sage);
  }
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 14px;
  }

  .error-bubble {
    background: #FFF5F5 !important;
    border-color: rgba(201,122,122,0.3) !important;
  }

  .retry-btn {
    display: inline-block;
    margin-top: 10px;
    background: none;
    border: 1.5px solid var(--rose);
    border-radius: 100px;
    padding: 5px 14px;
    font-size: 13px;
    color: var(--rose);
    cursor: pointer;
    font-family: 'DM Sans', sans-serif;
    transition: all 0.2s;
  }
  .retry-btn:hover { background: var(--rose); color: white; }

  .chip {
    background: var(--sage-pale);
    border: 1px solid rgba(123,158,135,0.3);
    border-radius: 100px;
    padding: 6px 14px;
    font-size: 13px;
    color: var(--sage);
    cursor: pointer;
    transition: all 0.2s;
    font-family: 'DM Sans', sans-serif;
  }
  .chip:hover { background: #D4E8DA; border-color: var(--sage); }

  .typing-indicator {
    display: flex;
    gap: 12px;
    max-width: 680px;
    margin: 0 auto;
    width: 100%;
  }

  .typing-dots {
    background: white;
    border: 1px solid #E8EDE9;
    border-radius: 16px;
    border-top-left-radius: 4px;
    padding: 14px 18px;
    display: flex;
    gap: 5px;
    align-items: center;
  }

  .dot {
    width: 6px; height: 6px;
    background: var(--ink-muted);
    border-radius: 50%;
    animation: bounce 1.2s ease-in-out infinite;
  }
  .dot:nth-child(2) { animation-delay: 0.2s; }
  .dot:nth-child(3) { animation-delay: 0.4s; }

  .input-bar {
    padding: 12px 16px;
    background: white;
    border-top: 1px solid #EEF0EC;
    display: flex;
    gap: 10px;
    align-items: flex-end;
  }

  .chat-input {
    flex: 1;
    background: var(--sage-pale);
    border: 1.5px solid transparent;
    border-radius: 12px;
    padding: 12px 16px;
    font-size: 15px;
    font-family: 'DM Sans', sans-serif;
    color: var(--ink);
    resize: none;
    min-height: 48px;
    max-height: 120px;
    outline: none;
    line-height: 1.5;
    transition: border-color 0.2s;
  }
  .chat-input:focus { border-color: var(--sage-light); }
  .chat-input::placeholder { color: var(--ink-muted); }

  .send-btn {
    width: 44px; height: 44px;
    background: var(--ink);
    border: none;
    border-radius: 10px;
    cursor: pointer;
    display: flex; align-items: center; justify-content: center;
    color: white;
    font-size: 18px;
    flex-shrink: 0;
    transition: background 0.2s, transform 0.1s;
    align-self: flex-end;
  }
  .send-btn:hover { background: var(--ink-soft); }
  .send-btn:active { transform: scale(0.95); }

  .img-btn {
    width: 44px; height: 44px;
    background: var(--sage-pale);
    border: 1.5px solid transparent;
    border-radius: 10px;
    cursor: pointer;
    display: flex; align-items: center; justify-content: center;
    font-size: 18px;
    flex-shrink: 0;
    transition: all 0.2s;
    align-self: flex-end;
  }
  .img-btn:hover { background: #D4E8DA; border-color: var(--sage-light); }
  .img-btn:disabled { opacity: 0.4; cursor: not-allowed; }

  .generated-image {
    max-width: 100%;
    border-radius: 12px;
    margin-top: 10px;
    display: block;
    box-shadow: 0 4px 16px rgba(28,43,30,0.12);
  }

  .search-indicator {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
    color: var(--ink-muted);
    padding: 6px 0 2px;
    font-style: italic;
  }
  .search-indicator::before {
    content: "🔍";
    font-style: normal;
  }

  /* ─── ANIMATIONS ─── */
  .cursor {
    display: inline-block;
    animation: blink 0.7s step-end infinite;
    color: var(--sage);
    font-weight: 300;
    margin-left: 1px;
  }

  @keyframes blink {
    0%, 100% { opacity: 1; }
    50% { opacity: 0; }
  }

  @keyframes fadeUp {
    from { opacity: 0; transform: translateY(12px); }
    to { opacity: 1; transform: translateY(0); }
  }

  @keyframes bounce {
    0%, 80%, 100% { transform: translateY(0); }
    40% { transform: translateY(-6px); }
  }

  /* ─── MESSAGE LIMIT ─── */
  .limit-banner {
    background: var(--amber-pale);
    border: 1.5px solid rgba(212,147,90,0.3);
    border-radius: 12px;
    padding: 14px 18px;
    margin: 0 20px 12px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    animation: fadeUp 0.3s ease both;
  }
  .limit-banner p {
    font-size: 13px;
    color: var(--ink-soft);
    line-height: 1.4;
  }
  .limit-banner strong { color: var(--amber); }
  .limit-count {
    font-size: 11px;
    color: var(--ink-muted);
    text-align: right;
    white-space: nowrap;
  }
  .limit-blocked {
    opacity: 0.5;
    pointer-events: none;
  }
  .limit-blocked .chat-input { background: #F0F0F0; }

  /* ─── MOBILE ─── */
  @media (max-width: 480px) {
    .subject-grid { grid-template-columns: 1fr 1fr; gap: 10px; }
    .age-card { padding: 24px; }
    .hero-heading { font-size: 28px; }
  }
</style>
</head>
<body>

<!-- ─── SCREEN 1: LANDING ─── -->
<div class="screen active" id="screen-landing">
  <div class="landing-inner">
    <div class="landing-logo">
      <svg width="56" height="56" viewBox="0 0 56 56" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <radialGradient id="lgFace" cx="42%" cy="38%" r="60%">
            <stop offset="0%" stop-color="#9DD3FF"/>
            <stop offset="100%" stop-color="#7B6FD4"/>
          </radialGradient>
        </defs>
        <circle cx="28" cy="28" r="28" fill="url(#lgFace)"/>
        <circle cx="20" cy="25" r="5" fill="white"/>
        <circle cx="36" cy="25" r="5" fill="white"/>
        <circle cx="21.5" cy="26.5" r="2.8" fill="#2C3E50"/>
        <circle cx="37.5" cy="26.5" r="2.8" fill="#2C3E50"/>
        <circle cx="22.5" cy="25.5" r="1.1" fill="white"/>
        <circle cx="38.5" cy="25.5" r="1.1" fill="white"/>
        <path d="M20 36 Q28 43 36 36" stroke="#2C3E50" stroke-width="2.5" fill="none" stroke-linecap="round"/>
      </svg>
    </div>
    <div class="logo-name-only">Sage</div>

    <h1 class="hero-heading">
      Every subject.<br>
      <em>Explained for you.</em>
    </h1>
    <p class="hero-sub">
      Ask anything — from long division to quantum physics.<br>
      Sage meets you exactly where you are.
    </p>

    <div class="age-card">
      <label>How old are you?</label>
      <div class="age-input-row">
        <input class="age-input" type="number" id="age-input" placeholder="e.g. 14" min="5" max="25">
      </div>
      <p class="age-hint">Your age helps Sage explain things at exactly the right level. No judgment, ever.</p>
      <button class="btn-primary" onclick="goToSubjects()">Let's start →</button>
    </div>

    <div class="subjects-preview">
      <span class="subject-pill">🔢 Maths</span>
      <span class="subject-pill">🧬 Biology</span>
      <span class="subject-pill">⚗️ Chemistry</span>
      <span class="subject-pill">📚 English</span>
      <span class="subject-pill">🌍 History</span>
      <span class="subject-pill">🌐 Geography</span>
      <span class="subject-pill">💻 CS</span>
      <span class="subject-pill">🧠 Philosophy</span>
    </div>
  </div>
</div>

<!-- ─── SCREEN 2: SUBJECT PICKER ─── -->
<div class="screen" id="screen-subjects">
  <div class="topbar">
    <div class="topbar-logo">
      <svg width="22" height="22" viewBox="0 0 36 36" xmlns="http://www.w3.org/2000/svg" style="border-radius:6px;overflow:hidden">
        <defs><radialGradient id="tg" cx="45%" cy="40%" r="55%"><stop offset="0%" stop-color="#8EC5FC"/><stop offset="100%" stop-color="#7B6FD4"/></radialGradient></defs>
        <circle cx="18" cy="18" r="18" fill="url(#tg)"/>
        <circle cx="13" cy="16" r="3" fill="white"/><circle cx="23" cy="16" r="3" fill="white"/>
        <circle cx="13.8" cy="16.5" r="1.5" fill="#2C3E50"/><circle cx="23.8" cy="16.5" r="1.5" fill="#2C3E50"/>
        <path d="M13 22 Q18 26 23 22" stroke="#2C3E50" stroke-width="1.5" fill="none" stroke-linecap="round"/>
      </svg>
      Sage
    </div>
    <div class="age-badge" onclick="changeAge()" id="age-display">Age: —</div>
  </div>

  <div class="subjects-body">
    <h2 class="section-title">What do you want to explore?</h2>
    <p class="section-sub" id="subjects-greeting">Pick a subject and ask anything.</p>

    <div class="subject-grid">
      <div class="subject-card" data-color="green" onclick="openChat('Maths', '🔢')">
        <span class="subject-emoji">🔢</span>
        <div class="subject-name">Maths</div>
        <div class="subject-desc">Numbers, algebra, calculus</div>
      </div>
      <div class="subject-card" data-color="sky" onclick="openChat('Biology', '🧬')">
        <span class="subject-emoji">🧬</span>
        <div class="subject-name">Biology</div>
        <div class="subject-desc">Life, cells, evolution</div>
      </div>
      <div class="subject-card" data-color="amber" onclick="openChat('Chemistry', '⚗️')">
        <span class="subject-emoji">⚗️</span>
        <div class="subject-name">Chemistry</div>
        <div class="subject-desc">Elements, reactions, bonds</div>
      </div>
      <div class="subject-card" data-color="rose" onclick="openChat('Physics', '⚛️')">
        <span class="subject-emoji">⚛️</span>
        <div class="subject-name">Physics</div>
        <div class="subject-desc">Forces, energy, the universe</div>
      </div>
      <div class="subject-card" data-color="violet" onclick="openChat('English', '📖')">
        <span class="subject-emoji">📖</span>
        <div class="subject-name">English</div>
        <div class="subject-desc">Literature, writing, language</div>
      </div>
      <div class="subject-card" data-color="amber" onclick="openChat('History', '🏛️')">
        <span class="subject-emoji">🏛️</span>
        <div class="subject-name">History</div>
        <div class="subject-desc">Events, people, causes</div>
      </div>
      <div class="subject-card" data-color="teal" onclick="openChat('Geography', '🌍')">
        <span class="subject-emoji">🌍</span>
        <div class="subject-name">Geography</div>
        <div class="subject-desc">Places, climate, landscapes</div>
      </div>
      <div class="subject-card" data-color="green" onclick="openChat('Computer Science', '💻')">
        <span class="subject-emoji">💻</span>
        <div class="subject-name">Computer Science</div>
        <div class="subject-desc">Code, logic, systems</div>
      </div>
      <div class="subject-card" data-color="violet" onclick="openChat('Philosophy', '🧠')">
        <span class="subject-emoji">🧠</span>
        <div class="subject-name">Philosophy</div>
        <div class="subject-desc">Arguments, ethics, big ideas</div>
      </div>
    </div>
  </div>
</div>

<!-- ─── SCREEN 3: CHAT ─── -->
<div class="screen" id="screen-chat">
  <div class="chat-topbar">
    <button class="back-btn" onclick="goBack()">←</button>
    <div class="chat-subject-info">
      <div class="chat-subject-name" id="chat-subject-title">🔢 Maths</div>
      <div class="chat-age-tag" id="chat-age-tag">Tuned for age —</div>
    </div>
    <div class="age-badge" onclick="changeAge()" style="font-size:12px;">Change age</div>
  </div>

  <div class="messages-area" id="messages-area">
    <!-- Messages injected here -->
  </div>

  <div id="limit-banner" class="limit-banner" style="display:none">
    <p>You've used all <strong>20 free messages</strong>. Upgrade to Pro for unlimited access.</p>
    <div class="limit-count" id="limit-count"></div>
  </div>
  <div class="input-bar">
    <button class="img-btn" onclick="requestImage()" title="Generate an image" id="img-btn">🎨</button>
    <textarea class="chat-input" id="chat-input" placeholder="Ask anything…" rows="1"
      onkeydown="handleKey(event)" oninput="autoResize(this)"></textarea>
    <button class="send-btn" onclick="sendMessage()">↑</button>
  </div>
</div>

<script>
  // All API calls go to the local Node server (server.js) which holds the keys.

  let userAge = null;
  let currentSubject = '';
  let currentEmoji = '';
  let conversationHistory = [];
  let isTyping = false;

  // ── Free tier message limit (20 per device) ────────────────────────────────
  const FREE_LIMIT = 20;
  const STORAGE_KEY = 'sage_message_count';

  function getMessageCount() {
    return parseInt(localStorage.getItem(STORAGE_KEY) || '0', 10);
  }

  function incrementMessageCount() {
    const count = getMessageCount() + 1;
    localStorage.setItem(STORAGE_KEY, count);
    return count;
  }

  function isAtLimit() {
    return getMessageCount() >= FREE_LIMIT;
  }

  function updateLimitUI() {
    const count = getMessageCount();
    const remaining = Math.max(0, FREE_LIMIT - count);
    const banner = document.getElementById('limit-banner');
    const inputBar = document.querySelector('.input-bar');
    const countEl = document.getElementById('limit-count');

    if (count >= FREE_LIMIT) {
      // Blocked — show banner, disable input
      if (banner) banner.style.display = 'flex';
      if (inputBar) inputBar.classList.add('limit-blocked');
    } else if (remaining <= 5) {
      // Getting close — show warning
      if (banner) {
        banner.style.display = 'flex';
        banner.querySelector('p').innerHTML = \`You have <strong>\${remaining} free message\${remaining === 1 ? '' : 's'}</strong> left today.\`;
      }
    } else {
      if (banner) banner.style.display = 'none';
    }

    if (countEl) countEl.textContent = \`\${count} / \${FREE_LIMIT} used\`;
  }

  const WELCOME_MESSAGES = {
    young: (subject) => \`Hi! I'm Sage 🌿 I love helping with \${subject}. What would you like to know? You can ask me anything at all — there are no silly questions here.\`,
    middle: (subject) => \`Hey! Ready to dive into \${subject}? Ask me anything — whether it's something you're stuck on, something confusing from class, or just something you're curious about.\`,
    older: (subject) => \`Good to meet you. I'm here for \${subject} — questions, explanations, worked examples, exam prep, whatever you need. What's on your mind?\`,
  };

  function getWelcomeMessage(age, subject) {
    if (age <= 10) return WELCOME_MESSAGES.young(subject);
    if (age <= 15) return WELCOME_MESSAGES.middle(subject);
    return WELCOME_MESSAGES.older(subject);
  }

  function goToSubjects() {
    const input = document.getElementById('age-input');
    const age = parseInt(input.value);
    if (!age || age < 5 || age > 25) {
      input.style.borderColor = 'var(--rose)';
      input.placeholder = 'Please enter an age (5–25)';
      setTimeout(() => { input.style.borderColor = ''; }, 1500);
      return;
    }
    userAge = age;
    document.getElementById('age-display').textContent = \`Age: \${age}\`;

    const greeting = age <= 10
      ? \`What would you like to learn today?\`
      : age <= 15
      ? \`What are you working on?\`
      : \`What do you want to explore?\`;
    document.getElementById('subjects-greeting').textContent = greeting;

    showScreen('screen-subjects');
  }

  function changeAge() {
    showScreen('screen-landing');
  }

  function openChat(subject, emoji) {
    currentSubject = subject;
    currentEmoji = emoji;
    conversationHistory = [];

    document.getElementById('chat-subject-title').textContent = \`\${emoji} \${subject}\`;
    document.getElementById('chat-age-tag').textContent = \`Tuned for age \${userAge}\`;

    const messagesArea = document.getElementById('messages-area');
    messagesArea.innerHTML = '';

    showScreen('screen-chat');
    updateLimitUI();

    const welcome = getWelcomeMessage(userAge, subject);
    appendMessage('sage', welcome);

    setTimeout(() => {
      document.getElementById('chat-input').focus();
    }, 300);
  }

  function goBack() {
    showScreen('screen-subjects');
  }

  function showScreen(id) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    document.getElementById(id).classList.add('active');
    window.scrollTo(0, 0);
  }

  function appendMessage(role, html, isHtml = false) {
    const area = document.getElementById('messages-area');
    const div = document.createElement('div');
    div.className = \`msg \${role === 'user' ? 'user' : 'sage'}\`;

    if (role === 'sage') {
      div.innerHTML = \`
        <div class="msg-avatar">\${sageSVG()}</div>
        <div class="msg-bubble">\${formatText(html)}</div>
      \`;
    } else {
      div.innerHTML = \`
        <div class="msg-avatar">\${getInitials()}</div>
        <div class="msg-bubble"><p>\${escapeHtml(html)}</p></div>
      \`;
    }

    area.appendChild(div);
    area.scrollTop = area.scrollHeight;
  }

  function getInitials() {
    return userAge ? userAge.toString() : 'U';
  }

  function escapeHtml(text) {
    return text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  function sageSVG() {
    return \`<svg width="36" height="36" viewBox="0 0 36 36" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <radialGradient id="faceGrad" cx="45%" cy="40%" r="55%">
          <stop offset="0%" stop-color="#8EC5FC"/>
          <stop offset="100%" stop-color="#7B6FD4"/>
        </radialGradient>
      </defs>
      <circle cx="18" cy="18" r="18" fill="url(#faceGrad)"/>
      <!-- eyes -->
      <circle cx="13" cy="16" r="3" fill="white"/>
      <circle cx="23" cy="16" r="3" fill="white"/>
      <circle cx="13.8" cy="16.5" r="1.5" fill="#2C3E50"/>
      <circle cx="23.8" cy="16.5" r="1.5" fill="#2C3E50"/>
      <circle cx="14.3" cy="16" r="0.5" fill="white"/>
      <circle cx="24.3" cy="16" r="0.5" fill="white"/>
      <!-- smile -->
      <path d="M13 22 Q18 26 23 22" stroke="#2C3E50" stroke-width="1.5" fill="none" stroke-linecap="round"/>
    </svg>\`;
  }

  function formatText(raw) {
    let text = raw;

    // Escape HTML entities first (but preserve our intentional tags)
    // We'll handle this by processing in blocks

    // Normalise line endings
    text = text.replace(/\\r\\n/g, '\\n').replace(/\\r/g, '\\n');

    // Code blocks (\`\`\` ... \`\`\`) — handle before other replacements
    text = text.replace(/\`\`\`[\\w]*\\n?([\\s\\S]*?)\`\`\`/g, (_, code) => {
      return \`\\x00PRE\\x00\${encodeURIComponent(code.trim())}\\x00ENDPRE\\x00\`;
    });

    // Inline code
    text = text.replace(/\`([^\`]+)\`/g, (_, code) => \`<code>\${escapeHtml(code)}</code>\`);

    // Headers ### ## #
    text = text.replace(/^### (.+)$/gm, '<h3>$1</h3>');
    text = text.replace(/^## (.+)$/gm, '<h3>$1</h3>');
    text = text.replace(/^# (.+)$/gm, '<h3>$1</h3>');

    // Bold and italic
    text = text.replace(/\\*\\*\\*(.+?)\\*\\*\\*/g, '<strong><em>$1</em></strong>');
    text = text.replace(/\\*\\*(.+?)\\*\\*/g, '<strong>$1</strong>');
    text = text.replace(/\\*([^*\\n]+?)\\*/g, '<em>$1</em>');

    // Split into blocks by double newline
    const blocks = text.split(/\\n{2,}/);
    const result = blocks.map(block => {
      block = block.trim();
      if (!block) return '';

      // Restore pre blocks
      if (block.startsWith('\\x00PRE\\x00')) {
        const code = decodeURIComponent(block.replace(/\\x00PRE\\x00/, '').replace(/\\x00ENDPRE\\x00/, ''));
        return \`<pre>\${escapeHtml(code)}</pre>\`;
      }

      // Already has block-level HTML tag
      if (/^<(h[1-6]|ul|ol|li|pre|blockquote)/.test(block)) return block;

      // Bullet list — lines starting with - or * or •
      const bulletLines = block.split('\\n');
      if (bulletLines.every(l => /^\\s*[-*•]\\s/.test(l) || !l.trim())) {
        const items = bulletLines
          .filter(l => l.trim())
          .map(l => \`<li>\${l.replace(/^\\s*[-*•]\\s/, '')}</li>\`)
          .join('');
        return \`<ul>\${items}</ul>\`;
      }

      // Numbered list — lines starting with 1. 2. etc
      if (bulletLines.every(l => /^\\s*\\d+[.)]\\s/.test(l) || !l.trim())) {
        const items = bulletLines
          .filter(l => l.trim())
          .map(l => \`<li>\${l.replace(/^\\s*\\d+[.)]\\s/, '')}</li>\`)
          .join('');
        return \`<ol>\${items}</ol>\`;
      }

      // Mixed block with some bullet lines
      const hasBullets = bulletLines.some(l => /^\\s*[-*•]\\s/.test(l));
      if (hasBullets) {
        // Split into sub-blocks
        let html = '';
        let listItems = [];
        for (const line of bulletLines) {
          if (/^\\s*[-*•]\\s/.test(line)) {
            listItems.push(\`<li>\${line.replace(/^\\s*[-*•]\\s/, '')}</li>\`);
          } else {
            if (listItems.length) { html += \`<ul>\${listItems.join('')}</ul>\`; listItems = []; }
            if (line.trim()) html += \`<p>\${line}</p>\`;
          }
        }
        if (listItems.length) html += \`<ul>\${listItems.join('')}</ul>\`;
        return html;
      }

      // Regular paragraph — join single newlines as <br>
      const inner = block.replace(/\\n/g, '<br>');
      return \`<p>\${inner}</p>\`;
    });

    return result.filter(Boolean).join('');
  }

  function showTyping() {
    const area = document.getElementById('messages-area');
    const div = document.createElement('div');
    div.className = 'typing-indicator';
    div.id = 'typing-indicator';
    div.innerHTML = \`
      <div class="msg-avatar">\${sageSVG()}</div>
      <div class="typing-dots">
        <div class="dot"></div>
        <div class="dot"></div>
        <div class="dot"></div>
      </div>
    \`;
    area.appendChild(div);
    area.scrollTop = area.scrollHeight;
  }

  function hideTyping() {
    const indicator = document.getElementById('typing-indicator');
    if (indicator) indicator.remove();
  }

  // Model: Haiku for ages ≤14 (fast), Sonnet for older (thorough)
  function getModel() {
    return userAge <= 14 ? 'claude-haiku-4-5-20251001' : 'claude-sonnet-4-20250514';
  }

  // Keep token budgets tight so responses come quickly
  function getMaxTokens() {
    if (userAge <= 10) return 280;
    if (userAge <= 14) return 450;
    if (userAge <= 17) return 650;
    return 850;
  }

  function showError(msg, retryable) {
    hideTyping();
    isTyping = false;
    const area = document.getElementById('messages-area');
    const div = document.createElement('div');
    div.className = 'msg sage';
    const retryBtn = retryable
      ? \`<button class="retry-btn" onclick="const t=lastUserText; conversationHistory.pop(); this.closest('.msg').remove(); sendMessage(t)">Try again →</button>\`
      : '';
    div.innerHTML = \`<div class="msg-avatar">\${sageSVG()}</div><div class="msg-bubble error-bubble"><p>\${msg}</p>\${retryBtn}</div>\`;
    area.appendChild(div);
    area.scrollTop = area.scrollHeight;
  }

  let lastUserText = '';
  let imageUsedToday = false;

  // ── Web search: fetch results then inject as context ──────────────────────
  async function searchWeb(query) {
    try {
      const r = await fetch('/api/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query }),
      });
      const data = await r.json();
      if (data.unavailable || !data.results?.length) return null;
      return data.results;
    } catch (_) { return null; }
  }

  function needsSearch(text) {
    const lower = text.toLowerCase();
    // Search if question seems to need current/factual info
    const searchTriggers = [
      /what is [a-z]/i, /who is/i, /who was/i, /how do(es)?/i,
      /what does .* stand for/i, /what are/i, /tell me about/i,
      /look up/i, /find/i, /search/i, /internet/i,
      /\\?$/, /meaning of/i, /definition/i,
    ];
    return searchTriggers.some(r => r.test(lower));
  }

  function buildSearchContext(results) {
    if (!results?.length) return '';
    const lines = results.map((r, i) =>
      \`[\${i+1}] \${r.title}\\n\${r.description || ''}\\nURL: \${r.url}\`
    ).join('\\n\\n');
    return \`\\n\\nWEB SEARCH RESULTS (use these to help answer if relevant):\\n\${lines}\\n\\nAnswer using these results where helpful. Cite sources naturally if you use them.\`;
  }

  // ── Image generation ───────────────────────────────────────────────────────
  async function requestImage() {
    if (isTyping) return;
    const input = document.getElementById('chat-input');
    const promptText = input.value.trim();

    // Ask what to draw if input is empty
    const prompt = promptText || await askImagePrompt();
    if (!prompt) return;

    const btn = document.getElementById('img-btn');
    btn.disabled = true;
    btn.textContent = '⏳';
    input.value = '';
    autoResize(input);

    appendMessage('user', \`🎨 Draw: \${prompt}\`);
    showTyping();

    try {
      const r = await fetch('/api/image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: \`Educational illustration: \${prompt}, clean, clear, friendly style\` }),
      });

      hideTyping();
      const data = await r.json();

      if (!r.ok || data.error) {
        appendMessage('sage', data.error || 'Image generation failed — try again.');
      } else {
        const area = document.getElementById('messages-area');
        const div = document.createElement('div');
        div.className = 'msg sage';
        div.innerHTML = \`
          <div class="msg-avatar">\${sageSVG()}</div>
          <div class="msg-bubble">
            <p>Here you go!</p>
            <img src="\${data.image}" class="generated-image" alt="\${prompt}">
            <p style="font-size:12px;color:var(--ink-muted);margin-top:8px">AI-generated illustration for: <em>\${prompt}</em></p>
          </div>\`;
        area.appendChild(div);
        area.scrollTop = area.scrollHeight;
        imageUsedToday = true;
      }
    } catch (err) {
      hideTyping();
      appendMessage('sage', "Couldn't generate an image right now. Try again in a moment.");
    }

    btn.disabled = false;
    btn.textContent = '🎨';
  }

  function askImagePrompt() {
    return new Promise(resolve => {
      const area = document.getElementById('messages-area');
      const div = document.createElement('div');
      div.className = 'msg sage';
      div.id = 'img-prompt-msg';
      div.innerHTML = \`
        <div class="msg-avatar">\${sageSVG()}</div>
        <div class="msg-bubble">
          <p>What would you like me to draw?</p>
          <div style="display:flex;gap:8px;margin-top:10px">
            <input id="img-prompt-input" type="text" placeholder="e.g. the water cycle"
              style="flex:1;padding:8px 12px;border:1.5px solid #E0E8E2;border-radius:8px;font-family:inherit;font-size:14px;outline:none"
              onkeydown="if(event.key==='Enter'){document.getElementById('img-prompt-go').click()}">
            <button id="img-prompt-go" style="padding:8px 16px;background:var(--ink);color:white;border:none;border-radius:8px;cursor:pointer;font-family:inherit">Draw</button>
          </div>
        </div>\`;
      area.appendChild(div);
      area.scrollTop = area.scrollHeight;
      setTimeout(() => document.getElementById('img-prompt-input')?.focus(), 100);

      document.getElementById('img-prompt-go').onclick = () => {
        const val = document.getElementById('img-prompt-input').value.trim();
        div.remove();
        resolve(val || null);
      };
    });
  }

  async function sendMessage(retryText) {
    if (isTyping) return;
    if (!retryText && isAtLimit()) return; // blocked by free limit
    const input = document.getElementById('chat-input');
    const raw = retryText || input.value.trim();
    if (!raw) return;

    const text = raw
      .replace(/‘|’/g, "'")
      .replace(/“|”/g, '"')
      .replace(/–|—/g, '-')
      .trim();

    lastUserText = text;
    if (!retryText) {
      appendMessage('user', text);
      input.value = '';
      autoResize(input);
    }

    isTyping = true;
    showTyping();

    // ── Web search if question seems to need it ──────────────────────────────
    let searchContext = '';
    if (needsSearch(text)) {
      const results = await searchWeb(text);
      if (results) {
        searchContext = buildSearchContext(results);
        // Show a subtle "searched the web" indicator
        const area = document.getElementById('messages-area');
        const ind = document.createElement('div');
        ind.className = 'search-indicator';
        ind.id = 'search-ind';
        ind.textContent = 'Searched the web';
        area.appendChild(ind);
        area.scrollTop = area.scrollHeight;
      }
    }

    // Build message with search context injected into last user message
    const messagesWithContext = [
      ...conversationHistory,
      { role: 'user', content: text + searchContext }
    ];

    conversationHistory.push({ role: 'user', content: text });

    if (!retryText) {
      incrementMessageCount();
      updateLimitUI();
    }

    const controller = new AbortController();
    const timeoutMs = userAge <= 14 ? 60000 : 180000;
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    // Remove search indicator once we start streaming
    const removeSearchInd = () => document.getElementById('search-ind')?.remove();

    let response;
    try {
      response = await fetch('/api/chat', {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: getModel(),
          max_tokens: getMaxTokens(),
          stream: true,
          system: buildSystemPrompt(),
          messages: messagesWithContext,
        })
      });
      clearTimeout(timeoutId);
    } catch (err) {
      clearTimeout(timeoutId);
      removeSearchInd();
      if (err.name === 'AbortError') {
        showError("That took too long — Sage timed out. Try a shorter question or ask again.", true);
      } else {
        showError("Sage lost connection. Check your internet and try again.", true);
      }
      return;
    }
    removeSearchInd();

    if (!response.ok) {
      const code = response.status;
      let msg = "Something went wrong connecting to Sage.";
      if (code === 429) msg = "Sage is a bit busy right now — give it a second and try again.";
      else if (code === 400) msg = "Sage couldn't read that message. Could you rephrase it?";
      else if (code >= 500) msg = "Sage had a hiccup on its end. Try again in a moment.";
      showError(msg, true);
      return;
    }

    hideTyping();

    const area = document.getElementById('messages-area');
    const div = document.createElement('div');
    div.className = 'msg sage';
    div.innerHTML = \`<div class="msg-avatar">\${sageSVG()}</div><div class="msg-bubble" id="stream-bubble"><span class="cursor">▍</span></div>\`;
    area.appendChild(div);
    area.scrollTop = area.scrollHeight;

    const bubble = document.getElementById('stream-bubble');
    let fullText = '';
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\\n');
        buffer = lines.pop();
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6).trim();
          if (!data || data === '[DONE]') continue;
          try {
            const json = JSON.parse(data);
            if (json.type === 'content_block_delta' && json.delta?.type === 'text_delta') {
              fullText += json.delta.text;
              bubble.innerHTML = formatText(fullText) + '<span class="cursor">▍</span>';
              area.scrollTop = area.scrollHeight;
            }
          } catch (_) {}
        }
      }
    } catch (streamErr) {
      bubble.innerHTML = formatText(fullText || '') + '<p style="color:var(--rose);font-size:13px;margin-top:8px">Connection dropped mid-reply. This is what Sage had so far.</p>';
      bubble.removeAttribute('id');
      isTyping = false;
      if (fullText) conversationHistory.push({ role: 'assistant', content: fullText });
      return;
    }

    bubble.innerHTML = formatText(fullText || "Hmm, I didn't get anything back. Could you ask again?");
    bubble.removeAttribute('id');
    isTyping = false;
    if (fullText) conversationHistory.push({ role: 'assistant', content: fullText });
  }

  function buildSystemPrompt() {
    const age = userAge;
    const subject = currentSubject;
    let levelDesc, toneDesc, lengthGuide;

    if (age <= 8) {
      levelDesc = 'primary school level — very simple words, short sentences, zero jargon, lots of everyday analogies (toys, food, animals, games)';
      toneDesc = 'warm and gentle, like a kind older sibling, encouraging without being over the top';
      lengthGuide = 'KEEP IT SHORT. 2–4 sentences maximum. Young children lose focus fast.';
    } else if (age <= 11) {
      levelDesc = 'upper primary — accessible language, relatable analogies from everyday life, introduce terms gently with immediate explanation';
      toneDesc = 'friendly and enthusiastic, like a good teacher, naturally encouraging';
      lengthGuide = 'Concise — 3–6 sentences. Cover the key idea clearly, then stop.';
    } else if (age <= 14) {
      levelDesc = 'lower secondary — proper terminology with clear explanations, step-by-step logic, can handle moderate complexity';
      toneDesc = 'friendly and direct, occasionally witty, treat them as intelligent, never patronising';
      lengthGuide = 'Medium — get to the point quickly. Thorough but not exhaustive.';
    } else if (age <= 17) {
      levelDesc = 'GCSE / A-level — proper academic language, nuance where relevant, assume they can handle complexity';
      toneDesc = 'respectful and collegiate, occasionally dry humour, treat them as near-equals';
      lengthGuide = 'Cover the concept well. Be thorough but stay focused — no padding.';
    } else {
      levelDesc = 'university level — full academic rigour, technical vocabulary, depth and complexity welcomed';
      toneDesc = 'collegial and precise, intellectually engaging, treat them as a capable peer';
      lengthGuide = 'Full depth when the topic demands it. Do not artificially shorten.';
    }

    return \`You are Sage, an AI tutor for \${subject}, speaking with a \${age}-year-old.

ACCURACY — THIS IS YOUR TOP PRIORITY:
Before writing your answer, silently verify it three ways:
1. Is this factually correct by the standard curriculum definition?
2. Does it hold up against a counterexample or edge case?
3. Would a qualified subject specialist agree with this explanation?
Only write your answer once all three checks pass. If genuinely uncertain, say so honestly — never guess and never bluff.

LEVEL: \${levelDesc}
TONE: \${toneDesc}
LENGTH: \${lengthGuide}

PERSONALITY:
- Warm and patient — never make the student feel bad for not understanding
- Smart but never show-offy
- Occasionally gently funny — but do not try too hard
- Never say "Great question!", "Absolutely!", "Certainly!" — these feel hollow
- Genuinely invested in helping them understand, not just finishing the reply

TEACHING APPROACH:
- Lead with the clearest, most age-appropriate explanation you can give
- Use a concrete analogy or real-world example naturally — don't announce you're doing it
- After explaining, check understanding with ONE gentle conversational question
- If they seem confused, try a completely different angle — never repeat the same explanation
- Offer practice questions only when it feels natural and they seem ready
- When marking answers, be kind about mistakes — explain the error without making them feel stupid

HANDLING TYPOS AND UNCLEAR QUESTIONS:
- If there is a typo or spelling mistake, figure out what they meant and answer it — do not mention the error
- If genuinely ambiguous, pick the most likely meaning, answer it, then ask if that is what they meant
- Never refuse to answer because of a typo, grammar issue, or odd phrasing

FORMAT:
- Conversational paragraphs. No bullet-point lectures.
- Numbered lists ONLY for steps where order genuinely matters.
- Bullet points ONLY for genuinely parallel items.
- Bold only for the first introduction of a key term.
- No markdown headers (## or ###).
- Line breaks between paragraphs are fine.\`;
  }
  function handleKey(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  }

  function autoResize(el) {
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 120) + 'px';
  }

  // Prefill demo on landing
  document.getElementById('age-input').addEventListener('keydown', function(e) {
    if (e.key === 'Enter') goToSubjects();
  });
</script>
</body>
</html>

`;

// ── HTTP server ───────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(200, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type' });
    return res.end();
  }

  // API routes
  if (req.method === 'POST' && req.url === '/api/chat')   return handleChat(req, res);
  if (req.method === 'POST' && req.url === '/api/search') return handleSearch(req, res);
  if (req.method === 'POST' && req.url === '/api/image')  return handleImage(req, res);

  // Serve frontend for everything else
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(FRONTEND);
});

server.listen(PORT, () => {
  console.log(`\n✅  Sage running at http://localhost:${PORT}`);
  console.log(`   Chat:   ✅`);
  console.log(`   Search: ${BRAVE_KEY     ? '✅' : '⚠️  No BRAVE_API_KEY — search disabled'}`);
  console.log(`   Images: ${STABILITY_KEY ? '✅' : '⚠️  No STABILITY_API_KEY — images disabled'}\n`);
});
