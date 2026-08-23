/**
 * qr-server.js — Servidor local para GENERAR el QR y mostrar un LOG EN VIVO
 * de la conexión de WhatsApp (Baileys multi-dispositivo).
 *
 * - QR en ASCII en la terminal
 * - Página web (http://localhost:3000) con QR + log de actividad EN TIEMPO REAL
 * - Streaming por SSE: cada evento (QR, conexión, mensaje, error) se empuja al instante
 * - Guarda la sesión en ./auth y el historial de actividad en ./activity.log
 *
 * Uso:  npm run qr   (o: node qr-server.js)
 */
import http from 'http'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'
import pino from 'pino'
import QRCode from 'qrcode'
import {
  makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
} from '@whiskeysockets/baileys'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PORT = process.env.PORT || 3000
const AUTH_DIR = path.join(__dirname, 'auth')
const ACTIVITY_FILE = path.join(__dirname, 'activity.log')

let qrString = null
let qrDataUrl = null
let status = 'connecting' // connecting | connected | disconnected
let meName = ''
let sockRef = null

const activity = []   // historial en memoria
const clients = new Set() // clientes SSE conectados

// ------------------------------------------------------------- log de actividad
function logActivity(type, msg) {
  const entry = { time: new Date().toISOString(), type, msg }
  activity.push(entry)
  if (activity.length > 500) activity.shift()
  try {
    fs.appendFileSync(ACTIVITY_FILE, JSON.stringify(entry) + '\n')
  } catch {
    /* no bloquea si no se puede escribir */
  }
  const hora = new Date().toLocaleTimeString('es-AR', { hour12: false })
  console.log(`[${hora}] ${type.toUpperCase()} · ${msg}`)
  broadcast()
}

function snapshot() {
  return JSON.stringify({
    status,
    me: meName,
    qr: qrDataUrl,
    activity: activity.slice(-60),
  })
}

function broadcast() {
  const data = 'data: ' + snapshot() + '\n\n'
  for (const c of clients) c.write(data)
}

// ------------------------------------------------------------- conexión Baileys
async function connect() {
  logActivity('info', 'Iniciando conexión…')
  // Modo "incógnito": cada arranque borra la sesión → QR nuevo siempre
  try {
    fs.rmSync(AUTH_DIR, { recursive: true, force: true })
    fs.mkdirSync(AUTH_DIR, { recursive: true })
  } catch {}
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR)

  let version
  try {
    ;({ version } = await fetchLatestBaileysVersion())
  } catch {
    version = undefined
  }

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    browser: ['WhatsBot', 'Chrome', '120.0.0'],
  })
  sockRef = sock

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', (u) => {
    const { connection, lastDisconnect, qr } = u

    if (qr) {
      qrString = qr
      status = 'connecting'
      QRCode.toDataURL(qr, { width: 320, margin: 1 })
        .then((d) => {
          qrDataUrl = d
        })
        .catch(() => {
          qrDataUrl = null
        })
        .finally(() => logActivity('qr', 'QR generado — esperando escaneo'))
      QRCode.toString(qr, { type: 'terminal' })
        .then((ascii) => console.log('\nEscaneá este QR con WhatsApp:\n\n' + ascii + '\n'))
        .catch(() => {})
    }

    if (connection === 'open') {
      status = 'connected'
      qrString = null
      qrDataUrl = null
      meName = (sock.user && sock.user.name) || 'WhatsApp'
      logActivity('conectado', 'Sesión vinculada como ' + meName)
    }

    if (connection === 'close') {
      status = 'disconnected'
      qrString = null
      qrDataUrl = null
      const code = lastDisconnect && lastDisconnect.error
        ? lastDisconnect.error.output && lastDisconnect.error.output.statusCode
        : null
      if (code !== DisconnectReason.loggedOut) {
        logActivity('reconectando', 'Conexión cerrada — reintentando en 3s…')
        setTimeout(connect, 3000)
      } else {
        logActivity('error', 'Sesión cerrada (logged out). Reiniciá para un QR nuevo.')
      }
    }
  })

  sock.ev.on('messages.upsert', ({ messages }) => {
    for (const m of messages) {
      if (m.key.fromMe) continue
      const text =
        (m.message && m.message.conversation) ||
        (m.message && m.message.extendedTextMessage && m.message.extendedTextMessage.text) ||
        (m.message && m.message.imageMessage && m.message.imageMessage.caption) ||
        ''
      if (!text) continue
      const from = m.pushName || String(m.key.remoteJid).split('@')[0]
      logActivity('mensaje', from + ': ' + text)
    }
  })
}

// ------------------------------------------------------------- página web
const HTML = `<!DOCTYPE html>
<html lang="es" data-theme="dark">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>WhatsBot · Conexión en vivo</title>
<style>
  :root { --bg:#0f1117; --surface:#181b24; --surface2:#1f2330; --text:#eef1f6; --muted:#8b93a7; --border:#2a2f3d; --green:#00d68f; --yellow:#ffc94d; --red:#ff6b6b; --accent:#6c5ce7; }
  [data-theme="light"] { --bg:#f4f5fa; --surface:#ffffff; --surface2:#eef0f7; --text:#191c28; --muted:#6b7280; --border:#e3e6f0; --green:#00b47a; --yellow:#c98a00; --red:#e5484d; --accent:#6c5ce7; }
  * { box-sizing:border-box; margin:0; padding:0; }
  body { font-family:'Inter',system-ui,sans-serif; background:var(--bg); color:var(--text); min-height:100vh; padding:24px; transition:background .3s,color .3s; }
  .wrap { max-width:760px; margin:0 auto; display:flex; flex-direction:column; gap:18px; }
  .card { background:var(--surface); border:1px solid var(--border); border-radius:22px; padding:26px; box-shadow:0 12px 34px rgba(0,0,0,.35); }
  .center { display:flex; flex-direction:column; align-items:center; gap:16px; text-align:center; }
  h1 { font-size:20px; font-weight:800; letter-spacing:-.02em; }
  .pill { font-size:12px; font-weight:700; padding:4px 14px; border-radius:999px; }
  .connecting { background:rgba(255,201,77,.15); color:var(--yellow); }
  .connected { background:rgba(0,214,143,.15); color:var(--green); }
  .disconnected { background:rgba(255,107,107,.15); color:var(--red); }
  #qrBox { background:#fff; padding:14px; border-radius:16px; }
  #qrBox img { width:230px; height:230px; display:block; }
  .muted { color:var(--muted); font-size:13px; }
  #t { border:1px solid var(--border); background:var(--surface); color:var(--text); width:42px; height:42px; border-radius:12px; font-size:18px; cursor:pointer; position:fixed; top:18px; right:18px; }
  .head { display:flex; align-items:center; justify-content:space-between; margin-bottom:10px; }
  .head h2 { font-size:15px; font-weight:700; }
  .dot { width:8px; height:8px; border-radius:50%; background:var(--green); display:inline-block; animation:pulse 1.4s infinite; }
  @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.3} }
  #log { list-style:none; max-height:340px; overflow-y:auto; display:flex; flex-direction:column; gap:6px; }
  #log .item { font-size:13px; padding:8px 12px; border-radius:12px; background:var(--surface2); border-left:3px solid var(--border); }
  #log .item .t { color:var(--muted); font-size:11px; margin-right:6px; }
  #log .item b { text-transform:uppercase; font-size:11px; letter-spacing:.03em; margin-right:4px; }
  #log .item.conectado { border-left-color:var(--green); }
  #log .item.conectado b { color:var(--green); }
  #log .item.error { border-left-color:var(--red); }
  #log .item.error b { color:var(--red); }
  #log .item.qr { border-left-color:var(--yellow); }
  #log .item.qr b { color:var(--yellow); }
  #log .item.mensaje { border-left-color:var(--accent); }
  #log .item.mensaje b { color:var(--accent); }
  #log .item.reconectando { border-left-color:var(--yellow); }
  #log .item.reconectando b { color:var(--yellow); }
</style>
</head>
<body>
<button id="t" onclick="toggleTheme()"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:20px;height:20px;display:block"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg></button>
<div class="wrap">

  <div class="card center">
    <h1><svg viewBox="0 0 24 24" fill="currentColor" stroke="none" style="width:22px;height:22px;vertical-align:-4px;margin-right:6px"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>WhatsBot · Conexión</h1>
    <span id="pill" class="pill connecting">Conectando…</span>
    <div id="qrBox" style="display:none"><img id="img" alt="QR" /></div>
    <p id="msg" class="muted">Escaneá el QR con WhatsApp → Ajustes &gt; Dispositivos vinculados &gt; Vincular dispositivo</p>
  </div>

  <div class="card">
    <div class="head"><h2>Registro en vivo</h2><span class="dot" title="transmisión activa"></span></div>
    <ul id="log"></ul>
  </div>

</div>
<script>
  function esc(s){ return String(s).replace(/[&<>"']/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
  var SUN='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:20px;height:20px;display:block"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>';
  var MOON='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:20px;height:20px;display:block"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';
  function toggleTheme(){ var r=document.documentElement; var n=r.getAttribute('data-theme')==='dark'?'light':'dark'; r.setAttribute('data-theme',n); document.getElementById('t').innerHTML=n==='dark'?SUN:MOON; }
  var labels={connecting:'Conectando…',connected:'Conectado',disconnected:'Desconectado'};
  function render(s){
    var pill=document.getElementById('pill');
    pill.textContent=labels[s.status]||s.status; pill.className='pill '+s.status;
    var box=document.getElementById('qrBox'); var msg=document.getElementById('msg');
    if(s.qr){ box.style.display='block'; msg.textContent='Escaneá el QR para vincular tu WhatsApp'; var img=document.getElementById('img'); if(img.src!==s.qr) img.src=s.qr; }
    else if(s.status==='connected'){ box.style.display='none'; msg.textContent='Conectado como '+(s.me||'WhatsApp'); }
    else { box.style.display='none'; msg.textContent='Desconectado'; }
    var ul=document.getElementById('log'); ul.innerHTML='';
    var arr=(s.activity||[]).slice().reverse();
    arr.forEach(function(e){
      var li=document.createElement('li'); li.className='item '+e.type;
      var t=new Date(e.time).toLocaleTimeString('es-AR');
      li.innerHTML='<span class="t">'+t+'</span><b>'+esc(e.type)+'</b> '+esc(e.msg);
      ul.appendChild(li);
    });
  }
  fetch('/state').then(function(r){return r.json()}).then(render).catch(function(){});
  var es=new EventSource('/events');
  es.onmessage=function(ev){ try{ render(JSON.parse(ev.data)); }catch(e){} };
</script>
</body>
</html>`

// ------------------------------------------------------------- servidor HTTP
http
  .createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost')

    if (url.pathname === '/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      })
      res.write('data: ' + snapshot() + '\n\n')
      clients.add(res)
      req.on('close', () => clients.delete(res))
      return
    }

    if (url.pathname === '/state') {
      res.setHeader('Content-Type', 'application/json')
      res.end(snapshot())
      return
    }

    if (url.pathname === '/activity') {
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify(activity))
      return
    }

    if (url.pathname === '/status') {
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ status, qr: qrDataUrl, me: meName }))
      return
    }

    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.end(HTML)
  })
  .listen(PORT, () => {
    console.log(`✔ Servidor corriendo en http://localhost:${PORT}`)
    console.log('  Escaneá el QR con WhatsApp → Dispositivos vinculados')
    connect()
  })
