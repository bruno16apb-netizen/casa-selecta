/**
 * WhatsBot — Bot de WhatsApp con interfaz estilo WhatsApp Web
 * - Conexión por QR (multi-dispositivo) → pasa directo a la vista de chat
 * - Lista de conversaciones + ventana de chat en tiempo real (SSE)
 * - Bot integrable con una API externa (OpenAI-compatible) desde Configuración
 * - Auto-respuesta simple, mensajes programados y sesión persistente
 */
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'
import express from 'express'
import QRCode from 'qrcode'
import pino from 'pino'
import {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} from '@whiskeysockets/baileys'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const PORT = process.env.PORT || 3000
const AUTH_DIR = path.join(__dirname, 'auth')
const DATA_FILE = path.join(__dirname, 'data.json')

// ------------------------------------------------------------------ estado
const state = {
  status: 'disconnected', // disconnected | connecting | connected
  qr: null,
  me: null, // { name, number }
  error: null,
  migrated: null, // { from, to } migración de conversación @lid → número real
}
let sock = null
let qrDataUrl = null
const clients = new Set() // clientes SSE

// ------------------------------------------------------------------ persistencia
function readData() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'))
  } catch {
    return {
      settings: { autoReply: false, replyText: '' },
      bot: {
        enabled: false,
        endpoint: '',
        apiKey: '',
        model: 'gpt-4o-mini',
        systemPrompt: 'Sos un asistente útil y conciso. Respondé en el idioma del usuario.',
      },
      schedules: [],
      conversations: {},
      lidMap: {},
    }
  }
}
function saveData() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2))
  } catch {
    /* no bloquea */
  }
}
const data = readData()
data.lidMap = data.lidMap || {}

// ------------------------------------------------------------------ utilidades
function normalizeJid(number) {
  let n = String(number).replace(/\D/g, '')
  n = n.replace(/^0+/, '')
  return n + '@s.whatsapp.net'
}
function isLidJid(jid) {
  return /@lid$/.test(String(jid))
}
function numberFromJid(jid) {
  return String(jid).split('@')[0]
}
// Resuelve un jid a su dirección real de envío:
//  - @lid → se envía directo al LID (así enruta WhatsApp hoy, cross-user)
//  - número propio → PN @s.whatsapp.net (self-chat funciona por PN)
//  - número ajeno → su LID (onWhatsApp.lid) si está disponible; si no, el PN
async function resolveSendJid(target) {
  let jid = String(target || '')
  if (!jid) return null
  if (isLidJid(jid)) return jid
  try {
    const num = numberFromJid(jid)
    const meNum = String((state.me && state.me.number) || '').split(':')[0]
    const res = await sock.onWhatsApp(num)
    if (res && res[0]) {
      console.log('🔎 onWhatsApp', num, '→', JSON.stringify(res[0]))
      if (num !== meNum && res[0].lid) {
        const lid = String(res[0].lid).split('@')[0].split(':')[0]
        return lid + '@lid'
      }
      if (res[0].jid) return res[0].jid
    }
  } catch (e) {
    console.error('onWhatsApp error:', e.message)
  }
  return jid
}
function displayName(jid, fallback) {
  if (fallback) return fallback
  return '+' + numberFromJid(jid)
}
function extractText(msg) {
  const m = msg.message
  return (
    (m && m.conversation) ||
    (m && m.extendedTextMessage && m.extendedTextMessage.text) ||
    (m && m.imageMessage && m.imageMessage.caption) ||
    (m && m.videoMessage && m.videoMessage.caption) ||
    ''
  )
}

function ensureConv(jid, name) {
  if (!data.conversations[jid]) {
    data.conversations[jid] = { jid, name: name || '', messages: [], lastTime: 0 }
  } else if (name && name !== data.conversations[jid].name) {
    data.conversations[jid].name = name
  }
  return data.conversations[jid]
}

function addMessage(jid, name, fromMe, text) {
  const conv = ensureConv(jid, name)
  conv.messages.push({ fromMe, text, time: new Date().toISOString() })
  if (conv.messages.length > 200) conv.messages = conv.messages.slice(-200)
  conv.lastTime = Date.now()
  saveData()
  broadcast()
}

// ------------------------------------------------------------------ bot con API
async function callBot(jid) {
  const conv = data.conversations[jid]
  if (!conv) return ''
  const history = conv.messages.slice(-20)
  const url = String(data.bot.endpoint || '').replace(/\/+$/, '') + '/chat/completions'
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + data.bot.apiKey,
      },
      body: JSON.stringify({
        model: data.bot.model || 'gpt-4o-mini',
        messages: [
          { role: 'system', content: data.bot.systemPrompt || 'Sos un asistente útil.' },
          ...history.map((m) => ({ role: m.fromMe ? 'assistant' : 'user', content: m.text })),
        ],
        temperature: 0.7,
      }),
    })
    if (!res.ok) {
      console.error('API bot error:', res.status, await res.text())
      return ''
    }
    const json = await res.json()
    return (json && json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content) || ''
  } catch (e) {
    console.error('API bot exception:', e.message)
    return ''
  }
}

// ------------------------------------------------------------------ conexión
async function connect() {
  state.status = 'connecting'
  state.qr = null
  state.error = null
  broadcast()

  // Modo "incógnito": cada arranque borra la sesión → QR nuevo siempre
  try {
    fs.rmSync(AUTH_DIR, { recursive: true, force: true })
    fs.mkdirSync(AUTH_DIR, { recursive: true })
  } catch {}

  const { state: authState, saveCreds } = await useMultiFileAuthState(AUTH_DIR)

  let version
  try {
    ;({ version } = await fetchLatestBaileysVersion())
  } catch {
    version = undefined
  }

  sock = makeWASocket({
    version,
    auth: authState,
    logger: pino({ level: 'silent' }),
    browser: ['WhatsBot', 'Chrome', '120.0.0'],
  })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', (u) => {
    const { connection, lastDisconnect, qr } = u

    if (qr) {
      state.qr = qr
      state.status = 'connecting'
      QRCode.toDataURL(qr, { width: 320, margin: 1 })
        .then((d) => { qrDataUrl = d })
        .catch(() => { qrDataUrl = null })
        .finally(() => broadcast())
    }

    if (connection === 'open') {
      state.status = 'connected'
      state.qr = null
      qrDataUrl = null
      state.error = null
      state.me = {
        name: (sock.user && sock.user.name) || 'Mi WhatsApp',
        number: sock.user ? numberFromJid(sock.user.id) : '',
      }
      console.log('✔ WhatsApp conectado como', state.me.name)
      broadcast()
    }

    if (connection === 'close') {
      state.status = 'disconnected'
      state.qr = null
      qrDataUrl = null
      const code = lastDisconnect && lastDisconnect.error
        ? lastDisconnect.error.output && lastDisconnect.error.output.statusCode
        : null
      if (code !== DisconnectReason.loggedOut) {
        state.error = 'Conexión cerrada. Reintentando…'
        setTimeout(connect, 3000)
      } else {
        state.error = 'Sesión cerrada. Volvé a escanear el QR.'
      }
      broadcast()
    }
  })

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return
    for (const msg of messages) {
      if (msg.key.fromMe) continue
      const text = extractText(msg)
      if (!text) continue
      let from = msg.key.remoteJid
      // WhatsApp usa @lid (identificador de privacidad) que NO entrega envíos.
      // Con senderPn obtenemos el número real → guardamos y enviamos a @s.whatsapp.net
      if (isLidJid(from) && msg.key.senderPn) {
        const pn = String(msg.key.senderPn).replace(/@.*$/, '')
        const real = normalizeJid(pn)
        const lid = numberFromJid(from)
        data.lidMap[lid] = pn
        if (data.conversations[from]) {
          const conv = data.conversations[from]
          delete data.conversations[from]
          data.conversations[real] = conv
          conv.jid = real
          state.migrated = { from, to: real }
        }
        from = real
        saveData()
      }
      const sender = msg.pushName || ''
      addMessage(from, sender, false, text)

      // bot con API (prioridad) o auto-respuesta simple
      if (data.bot.enabled && data.bot.endpoint && data.bot.apiKey) {
        const reply = await callBot(from)
        if (reply && sock && state.status === 'connected') {
          const real = await resolveSendJid(from)
          if (real) {
            await sock.sendMessage(real, { text: reply })
            addMessage(from, sender, true, reply)
          }
        }
      } else if (data.settings.autoReply && data.settings.replyText) {
        if (sock && state.status === 'connected') {
          const real = await resolveSendJid(from)
          if (real) {
            await sock.sendMessage(real, { text: data.settings.replyText })
            addMessage(from, sender, true, data.settings.replyText)
          }
        }
      }
    }
  })
}

// ------------------------------------------------------------------ planificador
function schedulerTick() {
  const now = Date.now()
  let changed = false
  for (const s of data.schedules) {
    if (!s.enabled) continue
    const fireAt = new Date(s.datetime).getTime()
    if (now >= fireAt && s.lastFired !== s.datetime) {
      const jid = normalizeJid(s.number)
      if (sock && state.status === 'connected') {
        resolveSendJid(jid)
          .then((real) => (real ? sock.sendMessage(real, { text: s.message }) : Promise.reject(new Error('destino sin resolver'))))
          .then(() => addMessage(jid, null, true, s.message))
          .catch((e) => console.error('Programado falló:', e.message))
      }
      s.lastFired = s.datetime
      if (s.repeat === 'daily') {
        const d = new Date(s.datetime)
        d.setDate(d.getDate() + 1)
        s.datetime = d.toISOString()
        s.lastFired = null
      }
      changed = true
    }
  }
  if (changed) saveData()
}
setInterval(schedulerTick, 10000)

// ------------------------------------------------------------------ SSE
function conversationsSummary() {
  return Object.values(data.conversations)
    .sort((a, b) => (b.lastTime || 0) - (a.lastTime || 0))
    .map((c) => ({
      jid: c.jid,
      name: displayName(c.jid, c.name),
      lastMessage: c.messages.length ? c.messages[c.messages.length - 1].text : '',
      lastTime: c.lastTime,
      count: c.messages.length,
    }))
}
function broadcast() {
  const payload = 'data: ' + JSON.stringify({
    status: state.status,
    me: state.me,
    qr: qrDataUrl,
    conversations: conversationsSummary(),
    migrate: state.migrated || null,
  }) + '\n\n'
  state.migrated = null
  for (const c of clients) c.write(payload)
}

// ------------------------------------------------------------------ servidor
const app = express()
app.use(express.json({ limit: '2mb' }))
app.use(express.static(path.join(__dirname, 'public')))

app.get('/api/status', async (_req, res) => {
  let qrDataUrl = null
  if (state.qr) {
    try {
      qrDataUrl = await QRCode.toDataURL(state.qr, { width: 320, margin: 1 })
    } catch {
      qrDataUrl = null
    }
  }
  res.json({ status: state.status, qr: qrDataUrl, me: state.me, error: state.error })
})

app.get('/api/events', (_req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  })
  res.write('data: ' + JSON.stringify({ status: state.status, me: state.me, qr: qrDataUrl, conversations: conversationsSummary() }) + '\n\n')
  clients.add(res)
  _req.on('close', () => clients.delete(res))
})

app.get('/api/conversations', (_req, res) => res.json(conversationsSummary()))

app.get('/api/messages', (req, res) => {
  const jid = req.query.jid
  const conv = data.conversations[jid]
  if (!conv) return res.json({ jid, name: '', messages: [] })
  res.json({ jid, name: displayName(jid, conv.name), messages: conv.messages })
})

app.post('/api/send', async (req, res) => {
  const { jid, number, text } = req.body || {}
  const target = jid || (number ? normalizeJid(number) : null)
  if (!target || !text) return res.status(400).json({ ok: false, error: 'Faltan datos' })
  if (!sock || state.status !== 'connected') return res.status(409).json({ ok: false, error: 'Bot no conectado' })
  try {
    // Fix @lid: nunca enviar a un @lid (WhatsApp lo acepta pero no entrega)
    const real = await resolveSendJid(target)
    if (!real) {
      return res.status(422).json({ ok: false, error: 'Contacto sin resolver (LID). Esperá a que esa persona te escriba para activar el chat.' })
    }
    await sock.sendMessage(real, { text })
    addMessage(real, null, true, text)
    console.log('✔ enviado a', real, ':', String(text).slice(0, 40))
    res.json({ ok: true, jid: real })
  } catch (e) {
    console.error('✖ error al enviar a', target, ':', e.message)
    res.status(500).json({ ok: false, error: e.message })
  }
})

app.get('/api/bot', (_req, res) => res.json(data.bot))
app.post('/api/bot', (req, res) => {
  data.bot = { ...data.bot, ...(req.body || {}) }
  saveData()
  res.json({ ok: true, bot: data.bot })
})

app.get('/api/settings', (_req, res) => res.json(data.settings))
app.post('/api/settings', (req, res) => {
  data.settings = { ...data.settings, ...(req.body || {}) }
  saveData()
  res.json({ ok: true, settings: data.settings })
})

app.get('/api/schedules', (_req, res) => res.json(data.schedules))
app.post('/api/schedules', (req, res) => {
  const { number, message, datetime, repeat } = req.body || {}
  if (!number || !message || !datetime) return res.status(400).json({ ok: false, error: 'Faltan datos' })
  const schedule = { id: Date.now().toString(36), number, message, datetime, repeat: repeat === 'daily' ? 'daily' : 'once', enabled: true, lastFired: null }
  data.schedules.push(schedule)
  saveData()
  res.json({ ok: true, schedule })
})
app.delete('/api/schedules/:id', (req, res) => {
  data.schedules = data.schedules.filter((s) => s.id !== req.params.id)
  saveData()
  res.json({ ok: true })
})

app.post('/api/logout', async (_req, res) => {
  if (sock) {
    try {
      await sock.logout()
    } catch {
      /* ignore */
    }
  }
  state.status = 'disconnected'
  state.qr = null
  res.json({ ok: true })
})

app.listen(PORT, () => {
  console.log(`✔ WhatsBot corriendo en http://localhost:${PORT}`)
  connect()
})
