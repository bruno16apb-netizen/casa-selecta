/**
 * WhatsBot — Backend con la API OFICIAL de WhatsApp (Meta Cloud API)
 * Reemplaza a server.js (whatsapp-web.js) para evitar restricciones.
 *
 * Configuración: editar meta-config.json (o variables de entorno):
 *   META_TOKEN, META_PHONE_NUMBER_ID, META_WABA_ID, META_VERIFY_TOKEN
 *
 * Arranque: node server-meta.js  (o npm run meta)
 */
import path from 'path'
import fs from 'fs'
import { execFile } from 'child_process'
import { fileURLToPath } from 'url'
import express from 'express'
import multer from 'multer'
import ffmpegStatic from 'ffmpeg-static'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const PORT = process.env.PORT || 3000
const API_VERSION = process.env.META_API_VERSION || 'v25.0'
const GRAPH_BASE = `https://graph.facebook.com/${API_VERSION}`
const DATA_FILE = path.join(__dirname, 'data.json')
const CONFIG_FILE = path.join(__dirname, 'meta-config.json')

// ------------------------------------------------------------------ config
function readConfig() {
  let fileCfg = {}
  try {
    fileCfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))
  } catch {
    /* usa solo env */
  }
  return {
    token: process.env.META_TOKEN || fileCfg.token || '',
    phoneNumberId: process.env.META_PHONE_NUMBER_ID || fileCfg.phoneNumberId || '',
    wabaId: process.env.META_WABA_ID || fileCfg.wabaId || '',
    verifyToken: process.env.META_VERIFY_TOKEN || fileCfg.verifyToken || 'whatsbot-verify-token',
    displayNumber: process.env.META_DISPLAY_NUMBER || fileCfg.displayNumber || '',
  }
}
const cfg = readConfig()

const state = {
  status: cfg.token && cfg.phoneNumberId ? 'connected' : 'disconnected',
  qr: null,
  me: cfg.displayNumber ? { name: 'WhatsApp Business', number: cfg.displayNumber } : null,
  error: null,
}
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

// ------------------------------------------------------------------ utilidades
function normalizeTo(number) {
  let n = String(number || '').replace(/\D/g, '')
  n = n.replace(/^0+/, '')
  return n
}
function jidFromWaId(waId) {
  return normalizeTo(waId) + '@c.us'
}
// Los mensajes entrantes de Meta pueden llegar con un LID (identificador ligero)
// en vez del número de teléfono (por privacidad del usuario). Para no crear chats
// duplicados, mapeamos el LID al número real usando data.lidMap.
function canonicalJid(waId) {
  const n = normalizeTo(waId)
  const map = data.lidMap || {}
  if (map[n]) return normalizeTo(map[n]) + '@c.us'
  return n + '@c.us'
}
function numberFromJid(jid) {
  return String(jid).split('@')[0]
}
function displayName(jid, fallback) {
  if (fallback) return fallback
  return '+' + numberFromJid(jid)
}

const MEDIA_DIR = path.join(__dirname, 'media')
function saveMediaFile(buffer, mimetype) {
  try {
    fs.mkdirSync(MEDIA_DIR, { recursive: true })
    let ext = (String(mimetype || '').split('/')[1] || 'bin').split(';')[0]
    if (ext === 'ogg' || ext === 'mp4' || ext === 'webp') ext = ext
    const name = Date.now().toString(36) + Math.random().toString(36).slice(2, 8) + '.' + ext
    fs.writeFileSync(path.join(MEDIA_DIR, name), buffer)
    return '/media/' + name
  } catch (e) {
    console.error('saveMediaFile:', e.message)
    return null
  }
}

function detectMimeType(buf, fallback) {
  if (!buf || buf.length < 4) return fallback || 'application/octet-stream'
  const b = buf
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png'
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif'
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46) {
    if (b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp'
    if (b[8] === 0x57 && b[9] === 0x41 && b[10] === 0x56 && b[11] === 0x45) return 'audio/wav'
  }
  if (b[0] === 0x42 && b[1] === 0x4d) return 'image/bmp'
  if (b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) return 'audio/mpeg'
  if (b[0] === 0xff && (b[1] & 0xe0) === 0xe0) return 'audio/mpeg'
  if (b[0] === 0x4f && b[1] === 0x67 && b[2] === 0x67 && b[3] === 0x53) return 'audio/ogg'
  if (b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) return 'audio/mp4'
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return 'audio/webm'
  return fallback || 'application/octet-stream'
}

// Convierte audio a OGG/Opus (nota de voz nativa de WhatsApp)
const FFMPEG = ffmpegStatic || 'ffmpeg'
function convertToVoiceNote(srcPath, destPath) {
  return new Promise((resolve, reject) => {
    execFile(
      FFMPEG,
      ['-y', '-i', srcPath, '-vn', '-ac', '1', '-ar', '48000', '-c:a', 'libopus', '-b:a', '48k', '-application', 'voip', '-f', 'ogg', destPath],
      { timeout: 60000 },
      (err) => (err ? reject(err) : resolve())
    )
  })
}

// ------------------------------------------------------------------ Graph API
function authHeaders(extra) {
  return { Authorization: 'Bearer ' + cfg.token, ...(extra || {}) }
}

async function graphGet(pathAndQuery) {
  const res = await fetch(GRAPH_BASE + pathAndQuery, { headers: authHeaders() })
  const body = await res.text()
  let json
  try { json = JSON.parse(body) } catch { json = null }
  if (!res.ok) {
    const err = (json && json.error && json.error.message) || body.slice(0, 200)
    throw new Error(err)
  }
  return json
}

async function graphPost(pathAndQuery, payload) {
  const res = await fetch(GRAPH_BASE + pathAndQuery, {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(payload),
  })
  const body = await res.text()
  let json
  try { json = JSON.parse(body) } catch { json = null }
  if (!res.ok) {
    const err = (json && json.error && json.error.message) || body.slice(0, 200)
    throw new Error(err)
  }
  return json
}

// Sube un archivo a Meta y devuelve el media id
async function uploadMediaToMeta(buffer, filename, mimeType) {
  const form = new FormData()
  form.append('messaging_product', 'whatsapp')
  form.append('file', new Blob([buffer], { type: mimeType }), filename)
  const res = await fetch(`${GRAPH_BASE}/${cfg.phoneNumberId}/media`, {
    method: 'POST',
    headers: authHeaders(),
    body: form,
  })
  const json = await res.json()
  if (!res.ok) throw new Error((json && json.error && json.error.message) || 'subida de media falló')
  return json.id
}

// Descarga un media entrante (por media id) y devuelve { buffer, mimetype }
async function downloadMediaFromMeta(mediaId) {
  const meta = await graphGet(`/${mediaId}`)
  const url = meta && meta.url
  if (!url) throw new Error('media sin url')
  const res = await fetch(url, { headers: authHeaders() })
  if (!res.ok) throw new Error('descarga de media falló: ' + res.status)
  const buffer = Buffer.from(await res.arrayBuffer())
  return { buffer, mimetype: meta.mime_type || 'application/octet-stream' }
}

// Envía texto
async function sendText(to, text) {
  await graphPost(`/${cfg.phoneNumberId}/messages`, {
    messaging_product: 'whatsapp',
    to,
    type: 'text',
    text: { body: String(text) },
  })
}

// Envía imagen
async function sendImage(to, mediaId, caption) {
  const payload = {
    messaging_product: 'whatsapp',
    to,
    type: 'image',
    image: { id: mediaId },
  }
  if (caption) payload.image.caption = String(caption)
  await graphPost(`/${cfg.phoneNumberId}/messages`, payload)
}

// Envía audio (nota de voz)
async function sendAudio(to, mediaId) {
  await graphPost(`/${cfg.phoneNumberId}/messages`, {
    messaging_product: 'whatsapp',
    to,
    type: 'audio',
    audio: { id: mediaId },
  })
}

// ------------------------------------------------------------------ conversaciones
function ensureConv(jid, name) {
  if (!data.conversations[jid]) {
    data.conversations[jid] = { jid, name: name || '', messages: [], lastTime: 0 }
  } else if (name && name !== data.conversations[jid].name) {
    data.conversations[jid].name = name
  }
  return data.conversations[jid]
}

function addMessage(jid, name, fromMe, text, media) {
  const conv = ensureConv(jid, name)
  const m = { fromMe, text: text || '', time: new Date().toISOString() }
  if (media) m.media = media
  conv.messages.push(m)
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
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + data.bot.apiKey },
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

// ------------------------------------------------------------------ SSE
function conversationsSummary() {
  return Object.values(data.conversations)
    .sort((a, b) => (b.lastTime || 0) - (a.lastTime || 0))
    .map((c) => {
      const last = c.messages.length ? c.messages[c.messages.length - 1] : null
      let preview = ''
      if (last) {
        if (last.media) preview = last.media.type === 'audio' ? 'Audio' : last.media.type === 'video' ? 'Video' : 'Foto'
        else preview = last.text || ''
      }
      return {
        jid: c.jid,
        name: displayName(c.jid, c.name),
        lastMessage: preview,
        lastTime: c.lastTime,
        count: c.messages.length,
        presence: 'unavailable',
        isOnline: false,
        isBlocked: false,
        isTyping: false,
      }
    })
}
function broadcast() {
  const payload =
    'data: ' +
    JSON.stringify({ status: state.status, me: state.me, qr: state.qr, conversations: conversationsSummary() }) +
    '\n\n'
  for (const c of clients) c.write(payload)
}

// ------------------------------------------------------------------ servidor
const app = express()
app.use(express.json({ limit: '2mb' }))
app.use(express.static(path.join(__dirname, 'public')))
app.use('/media', express.static(MEDIA_DIR))

const upload = multer({
  dest: path.join(__dirname, 'uploads'),
  limits: { fileSize: 25 * 1024 * 1024 },
})

app.get('/api/status', (_req, res) => {
  res.json({ status: state.status, qr: state.qr, me: state.me, error: state.error })
})

app.get('/api/events', (_req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
  res.write(
    'data: ' +
      JSON.stringify({ status: state.status, me: state.me, qr: state.qr, conversations: conversationsSummary() }) +
      '\n\n'
  )
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
  const target = jid || (number ? jidFromWaId(number) : null)
  const to = target ? numberFromJid(target) : null
  if (!to || !text) return res.status(400).json({ ok: false, error: 'Faltan datos' })
  if (state.status !== 'connected') return res.status(409).json({ ok: false, error: 'API no configurada' })
  try {
    await sendText(to, text)
    addMessage(target, null, true, text)
    console.log('✔ enviado a', to, ':', String(text).slice(0, 40))
    res.json({ ok: true, jid: target })
  } catch (e) {
    console.error('✖ error al enviar:', e.message)
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
  const schedule = {
    id: Date.now().toString(36),
    number,
    message,
    datetime,
    repeat: repeat === 'daily' ? 'daily' : 'once',
    enabled: true,
    lastFired: null,
  }
  data.schedules.push(schedule)
  saveData()
  res.json({ ok: true, schedule })
})
app.delete('/api/schedules/:id', (req, res) => {
  data.schedules = data.schedules.filter((s) => s.id !== req.params.id)
  saveData()
  res.json({ ok: true })
})

// ------------------------------------------------------------------ media (foto / audio)
app.post('/api/send-media', upload.single('file'), async (req, res) => {
  const { jid, number, type, caption } = req.body || {}
  const target = jid || (number ? jidFromWaId(number) : null)
  const to = target ? numberFromJid(target) : null
  const file = req.file
  const cleanup = () => {
    if (file && file.path) {
      try { fs.unlinkSync(file.path) } catch { /* ignore */ }
    }
  }
  if (!to || !file) {
    cleanup()
    return res.status(400).json({ ok: false, error: 'Faltan datos (jid y archivo)' })
  }
  if (state.status !== 'connected') {
    cleanup()
    return res.status(409).json({ ok: false, error: 'API no configurada' })
  }
  try {
    const isAudio = type === 'audio'
    let buf
    let mime
    let filename

    if (isAudio) {
      const outPath = file.path + '.ogg'
      try {
        await convertToVoiceNote(file.path, outPath)
        buf = fs.readFileSync(outPath)
        mime = 'audio/ogg'
        filename = 'nota-de-voz.ogg'
      } catch (convErr) {
        console.error('✖ conversión a ogg falló, se envía original:', convErr.message)
        buf = fs.readFileSync(file.path)
        mime = detectMimeType(buf, file.mimetype || 'audio/ogg')
        const ext = (String(mime).split('/')[1] || 'bin').split(';')[0]
        filename = /\.[a-z0-9]+$/i.test(file.originalname || '') ? file.originalname : 'audio.' + ext
      } finally {
        try { fs.unlinkSync(outPath) } catch { /* ignore */ }
      }
    } else {
      buf = fs.readFileSync(file.path)
      mime = detectMimeType(buf, file.mimetype || 'image/jpeg')
      const ext = (String(mime).split('/')[1] || 'bin').split(';')[0]
      filename = /\.[a-z0-9]+$/i.test(file.originalname || '') ? file.originalname : 'imagen.' + ext
    }

    const mediaId = await uploadMediaToMeta(buf, filename, mime)
    if (isAudio) await sendAudio(to, mediaId)
    else await sendImage(to, mediaId, caption)

    const url = saveMediaFile(buf, mime)
    addMessage(target, null, true, caption || '', url ? { type: isAudio ? 'audio' : 'image', url, mimetype: mime } : null)
    console.log('✔ media enviado a', to, '(', mime, ')')
    res.json({ ok: true, jid: target })
  } catch (e) {
    console.error('✖ error al enviar media:', e.message)
    res.status(500).json({ ok: false, error: e.message })
  } finally {
    cleanup()
  }
})

// ------------------------------------------------------------------ webhook (recibir mensajes)
// Verificación del webhook: GET /webhook?hub.mode=subscribe&hub.verify_token=...&hub.challenge=...
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode']
  const token = req.query['hub.verify_token']
  const challenge = req.query['hub.challenge']
  if (mode === 'subscribe' && token === cfg.verifyToken) {
    console.log('✔ webhook verificado')
    return res.status(200).send(challenge)
  }
  res.sendStatus(403)
})

// Recepción de mensajes: POST /webhook
app.post('/webhook', async (req, res) => {
  res.sendStatus(200) // responder rápido, procesamos después
  try {
    const entries = req.body && req.body.entry
    if (!entries) return
    for (const entry of entries) {
      for (const change of entry.changes || []) {
        const value = change.value || {}
        if (value.messaging_product !== 'whatsapp') continue
        const contacts = value.contacts || []
        const messages = value.messages || []
        for (const msg of messages) {
          await handleIncoming(msg, contacts)
        }
      }
    }
  } catch (e) {
    console.error('webhook error:', e.message)
  }
})

async function handleIncoming(msg, contacts) {
  const from = msg.from
  if (!from) return
  const jid = canonicalJid(from)
  let name = ''
  const contact = contacts.find((c) => String(c.wa_id) === String(from))
  if (contact && contact.profile && contact.profile.name) name = contact.profile.name

  let text = ''
  let mediaInfo = null

  if (msg.type === 'text' && msg.text && msg.text.body) {
    text = msg.text.body
  } else if (msg.type === 'image' && msg.image && msg.image.id) {
    try {
      const { buffer, mimetype } = await downloadMediaFromMeta(msg.image.id)
      const url = saveMediaFile(buffer, mimetype)
      if (url) mediaInfo = { type: 'image', url, mimetype }
    } catch (e) {
      console.error('descarga imagen entrante:', e.message)
    }
  } else if (msg.type === 'audio' && msg.audio && msg.audio.id) {
    try {
      const { buffer, mimetype } = await downloadMediaFromMeta(msg.audio.id)
      const url = saveMediaFile(buffer, mimetype || 'audio/ogg')
      if (url) mediaInfo = { type: 'audio', url, mimetype: mimetype || 'audio/ogg' }
    } catch (e) {
      console.error('descarga audio entrante:', e.message)
    }
  } else if (msg.type === 'video' && msg.video && msg.video.id) {
    try {
      const { buffer, mimetype } = await downloadMediaFromMeta(msg.video.id)
      const url = saveMediaFile(buffer, mimetype)
      if (url) mediaInfo = { type: 'video', url, mimetype }
    } catch (e) {
      console.error('descarga video entrante:', e.message)
    }
  } else {
    // sticker, documento, etc. — lo registramos como texto de aviso
    text = '[mensaje no soportado: ' + msg.type + ']'
  }

  if (!text && !mediaInfo) return
  addMessage(jid, name, false, text, mediaInfo)

  // bot con API o auto-respuesta
  if (data.bot.enabled && data.bot.endpoint && data.bot.apiKey) {
    const reply = await callBot(jid)
    if (reply) {
      await sendText(from, reply)
      addMessage(jid, name, true, reply)
    }
  } else if (data.settings.autoReply && data.settings.replyText) {
    await sendText(from, data.settings.replyText)
    addMessage(jid, name, true, data.settings.replyText)
  }
}

// ------------------------------------------------------------------ planificador
function schedulerTick() {
  const now = Date.now()
  let changed = false
  for (const s of data.schedules) {
    if (!s.enabled) continue
    const fireAt = new Date(s.datetime).getTime()
    if (now >= fireAt && s.lastFired !== s.datetime) {
      const to = normalizeTo(s.number)
      if (state.status === 'connected' && to) {
        sendText(to, s.message)
          .then(() => addMessage(to + '@c.us', null, true, s.message))
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

app.listen(PORT, () => {
  console.log(`✔ WhatsBot (Meta Cloud API) corriendo en http://localhost:${PORT}`)
  if (state.status === 'connected') {
    console.log('✔ API configurada. Número de negocio:', cfg.displayNumber || '(no definido)')
  } else {
    console.log('⚠ API NO configurada. Completá meta-config.json (token + phoneNumberId).')
  }
})
