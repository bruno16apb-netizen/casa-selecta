/**
 * WhatsBot — Bot de WhatsApp con interfaz estilo WhatsApp Web
 * Backend: whatsapp-web.js (automatiza WhatsApp Web real con Chrome/Puppeteer)
 * - Conexión por QR → pasa directo a la vista de chat
 * - Lista de conversaciones + ventana de chat en tiempo real (SSE)
 * - Bot integrable con una API externa (OpenAI-compatible) desde Configuración
 * - Auto-respuesta simple, mensajes programados y sesión persistente (LocalAuth)
 */
import path from 'path'
import fs from 'fs'
import { execFile } from 'child_process'
import { fileURLToPath } from 'url'
import express from 'express'
import QRCode from 'qrcode'
import multer from 'multer'
import pkg from 'whatsapp-web.js'
import ffmpegStatic from 'ffmpeg-static'

const { Client, LocalAuth, MessageMedia } = pkg

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const PORT = process.env.PORT || 3000
const AUTH_DIR = path.join(__dirname, 'wwebjs_auth')
const DATA_FILE = path.join(__dirname, 'data.json')
const CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

// ------------------------------------------------------------------ estado
const state = {
  status: 'disconnected', // disconnected | connecting | connected
  qr: null,
  me: null, // { name, number }
  error: null,
}
let qrDataUrl = null
const clients = new Set() // clientes SSE
// presence: { jid: { state, isOnline, lastSeen, isBlocked } }
let presenceMap = {}
// Debounce para broadcast
let broadcastTimer = null
function scheduleBroadcast() {
  if (broadcastTimer) return
  broadcastTimer = setTimeout(() => {
    broadcastTimer = null
    broadcast()
  }, 2000)
}

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
function normalizeJid(number) {
  let n = String(number).replace(/\D/g, '')
  n = n.replace(/^0+/, '')
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

// Detecta el mimetype real a partir de los primeros bytes (magic bytes).
// Importante: multer guarda los archivos SIN extensión, y MessageMedia.fromFilePath()
// infiere el mimetype por la extensión -> quedaría null y WhatsApp lo enviaría como documento.
function detectMimeType(buf, fallback) {
  if (!buf || buf.length < 4) return fallback || 'application/octet-stream'
  const b = buf
  // JPEG
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  // PNG
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png'
  // GIF
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif'
  // RIFF: WEBP o WAV
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46) {
    if (b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp'
    if (b[8] === 0x57 && b[9] === 0x41 && b[10] === 0x56 && b[11] === 0x45) return 'audio/wav'
  }
  // BMP
  if (b[0] === 0x42 && b[1] === 0x4d) return 'image/bmp'
  // MP3 (ID3 o sync)
  if (b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) return 'audio/mpeg'
  if (b[0] === 0xff && (b[1] & 0xe0) === 0xe0) return 'audio/mpeg'
  // OGG (Opus/Vorbis)
  if (b[0] === 0x4f && b[1] === 0x67 && b[2] === 0x67 && b[3] === 0x53) return 'audio/ogg'
  // MP4 / M4A (ftyp)
  if (b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) return 'audio/mp4'
  // WEBM (Matroska)
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return 'audio/webm'
  // AMR
  if (b[0] === 0x23 && b[1] === 0x21 && b[2] === 0x41 && b[3] === 0x4d && b[4] === 0x52) return 'audio/amr'
  // FLAC
  if (b[0] === 0x66 && b[1] === 0x4c && b[2] === 0x61 && b[3] === 0x43) return 'audio/flac'
  return fallback || 'application/octet-stream'
}

// Convierte cualquier audio (webm, mp3, m4a, wav, etc.) a OGG/Opus mono,
// que es el formato que WhatsApp Web acepta como nota de voz nativa.
const FFMPEG = ffmpegStatic || 'ffmpeg'
function convertToVoiceNote(srcPath, destPath) {
  return new Promise((resolve, reject) => {
    execFile(
      FFMPEG,
      [
        '-y',
        '-i', srcPath,
        '-vn',
        '-ac', '1',
        '-ar', '48000',
        '-c:a', 'libopus',
        '-b:a', '48k',
        '-application', 'voip',
        '-f', 'ogg',
        destPath,
      ],
      { timeout: 60000 },
      (err) => (err ? reject(err) : resolve())
    )
  })
}

// Ejecuta código en la página de WhatsApp Web.
// Usa client.pupPage (que es lo que ya funciona con el endpoint debug-eval).
// Si el frame está detached, el retryOp se encarga de reintentar.
async function evalOnActivePage(fn, ...args) {
  const page = client.pupPage
  if (!page) throw new Error('Página de WhatsApp Web no disponible')
  return page.evaluate(fn, ...args)
}

// Errores transitorios de Puppeteer: ocurren cuando WhatsApp Web recarga/navega
// su página en segundo plano y la operación en curso queda con un frame viejo.
function isTransientFrameError(e) {
  const msg = String((e && e.message) || e)
  return /detached frame|execution context was destroyed|cannot find context|session closed|node is detached|target closed|protocol error|Navigating frame was detached/i.test(msg)
}

// Reintenta una operación si falla por un error transitorio de frame.
// La clave: entre intentos, adquiere una referencia FRESCA al frame.
async function retryOp(fn, { retries = 5, delayMs = 1500 } = {}) {
  let lastErr
  for (let i = 0; i <= retries; i++) {
    try {
      return await fn()
    } catch (e) {
      lastErr = e
      if (!isTransientFrameError(e)) throw e
      if (i < retries) {
        const wait = delayMs * (i + 1)
        console.log(`↻ reintentando (${i + 1}/${retries}) en ${wait}ms:`, String(e.message).slice(0, 60))
        await new Promise((r) => setTimeout(r, wait))
      }
    }
  }
  throw lastErr
}

// Devuelve el estado de presencia de un contacto: available | unavailable | composing | etc.
// Usa la API interna de WhatsApp Web directamente.
async function getPresenceDirect(jid) {
  return evalOnActivePage(async (chatId) => {
    const createWid = window.require('WAWebWidFactory').createWid
    const wid = createWid(chatId)
    const presence = window.require('WAWebPresenceCache').getPresence(wid)
    // presence puede ser undefined si no hay datos
    if (!presence) return null
    const isAvailable = presence.isChatState && presence.isChatState()
    return {
      state: isAvailable ? 'available' : (presence.chatstate || 'unavailable'),
      isOnline: !!isAvailable,
      lastSeen: presence.lastSeen || null,
    }
  }, jid)
}

// Devuelve true/false si un contacto está bloqueado
async function getIsBlockedDirect(jid) {
  return evalOnActivePage(async (contactId) => {
    const createWid = window.require('WAWebWidFactory').createWid
    const wid = createWid(contactId)
    const contact = await window.require('WAWebCollections').Contact.find(wid)
    if (!contact) return false
    return !!contact.isBlocked
  }, jid)
}

// Devuelve el estado de presencia para todos los chats abiertos.
// Se usa para polling global cada 5s.
async function getAllPresence() {
  const jids = Object.keys(data.conversations)
  if (!jids.length) return {}
  const results = {}
  // Procesar en paralelo pero limitando concurrencia
  const BATCH = 8
  for (let i = 0; i < jids.length; i += BATCH) {
    const batch = jids.slice(i, i + BATCH)
    const settled = await Promise.allSettled(batch.map(async (jid) => {
      const p = await getPresenceDirect(jid)
      return [jid, p]
    }))
    for (const s of settled) {
      if (s.status === 'fulfilled' && s.value) results[s.value[0]] = s.value[1]
    }
  }
  return results
}

// ------------------------------------------------------------------
// Operaciones directas sobre el frame activo de WhatsApp Web.
// Bypassan los métodos de whatsapp-web.js que usan pupPage.evaluate()
// con una referencia stale, causando el error "detached Frame".
// ------------------------------------------------------------------

// Elimina un chat directamente con la API interna de WhatsApp Web
async function deleteChatDirect(jid) {
  return evalOnActivePage(async (chatId) => {
    const chat = await window.WWebJS.getChat(chatId, { getAsModel: false })
    if (chat !== undefined) {
      await window.require('WAWebDeleteChatAction').sendDelete(chat)
      return true
    }
    return false
  }, jid)
}

// Bloquea un contacto directamente
async function blockContactDirect(jid) {
  return evalOnActivePage(async (contactId) => {
    const createWid = window.require('WAWebWidFactory').createWid
    const wid = createWid(contactId)
    const contact = await window.require('WAWebCollections').Contact.find(wid)
    if (!contact) throw new Error('No se encontró el contacto')
    await window.require('WAWebBlockContactAction').blockContact({ contact, blockEntryPoint: 'ChatListBlock' })
    return true
  }, jid)
}

// Desbloquea un contacto directamente
async function unblockContactDirect(jid) {
  return evalOnActivePage(async (contactId) => {
    const createWid = window.require('WAWebWidFactory').createWid
    const wid = createWid(contactId)
    const contact = await window.require('WAWebCollections').Contact.find(wid)
    if (!contact) throw new Error('No se encontró el contacto')
    await window.require('WAWebBlockContactAction').unblockContact(contact, 'ChatListBlock')
    return true
  }, jid)
}

// Envía un mensaje de texto directamente
// Resuelve el LID del contacto antes de enviar para evitar "No LID for user"
async function sendTextDirect(jid, text) {
  return evalOnActivePage(async (chatId, content) => {
    try { await window.WWebJS.enforceLidAndPnRetrieval(chatId) } catch {}
    const chat = await window.WWebJS.getChat(chatId, { getAsModel: false })
    if (!chat) return null
    const msg = await window.WWebJS.sendMessage(chat, content, {})
    return msg ? window.WWebJS.getMessageModel(msg) : undefined
  }, jid, text)
}

// Envía media (foto/audio) directamente
// Resuelve el LID del contacto antes de enviar para evitar "No LID for user"
async function sendMediaDirect(jid, media, options) {
  return evalOnActivePage(async (chatId, mediaData, opts) => {
    try { await window.WWebJS.enforceLidAndPnRetrieval(chatId) } catch {}
    const chat = await window.WWebJS.getChat(chatId, { getAsModel: false })
    if (!chat) return null
    const msg = await window.WWebJS.sendMessage(chat, '', {
      media: mediaData,
      caption: opts.caption,
      sendAudioAsVoice: opts.sendAudioAsVoice,
    })
    return msg ? window.WWebJS.getMessageModel(msg) : undefined
  }, jid, { mimetype: media.mimetype, data: media.data, filename: media.filename }, options)
}

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

// ------------------------------------------------------------------ cliente WhatsApp
const client = new Client({
  authStrategy: new LocalAuth({ dataPath: AUTH_DIR }),
  puppeteer: {
    headless: false, // ventana visible: se ve dónde inicia sesión (web.whatsapp.com)
    executablePath: CHROME_PATH,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  },
})

client.on('loading_screen', (pct, msg) => {
  if (pct === 0 || pct === 100) console.log('⏳ cargando WhatsApp Web…', pct + '%', msg || '')
})
client.on('auth_failure', (msg) => {
  state.status = 'disconnected'
  state.error = 'Fallo de autenticación: ' + msg
  console.error('✖ auth_failure:', msg)
  broadcast()
})

client.on('qr', (qr) => {
  state.status = 'connecting'
  state.error = null
  state.qr = qr
  // qr puede venir como data URL (base64) o texto plano
  if (typeof qr === 'string' && qr.startsWith('data:image')) {
    qrDataUrl = qr
    broadcast()
  } else {
    QRCode.toDataURL(qr, { width: 320, margin: 1 })
      .then((d) => {
        qrDataUrl = d
      })
      .catch(() => {
        qrDataUrl = null
      })
      .finally(() => broadcast())
  }
  console.log('📱 QR generado — esperando escaneo')
})

client.on('authenticated', () => {
  state.error = null
  broadcast()
})

let bootAt = Date.now()

client.on('ready', async () => {
  bootAt = Date.now()
  state.status = 'connected'
  state.qr = null
  qrDataUrl = null
  state.error = null
  try {
    const info = client.info
    const wid = (info && (info.me || info.wid) && (info.me || info.wid)._serialized) || ''
    state.me = {
      name: (info && info.pushname) || 'Mi WhatsApp',
      number: numberFromJid(wid),
    }
  } catch {
    state.me = { name: 'Mi WhatsApp', number: '' }
  }
  console.log('✔ WhatsApp conectado como', state.me.name)
  broadcast()
})

// ------------------------------------------------------------------
// Fix descarga de media (whatsapp-web.js 1.34.7 + WhatsApp Web 2026-07):
// WhatsApp renombró id._serialized → id.$1. downloadMedia() pasa undefined
// como id y la página falla con "r: r". Normalizamos _serialized desde $1
// y, si la librería aún falla, hacemos descarga manual vía la página.
// ------------------------------------------------------------------
async function downloadMediaSafe(msg) {
  // backfill _serialized <- $1 (renombre de WhatsApp Web de julio 2026)
  if (msg.id && msg.id._serialized == null && msg.id.$1 != null) {
    try { msg.id._serialized = msg.id.$1 } catch { /* readonly */ }
  }
  try {
    const media = await msg.downloadMedia()
    if (media) return media
  } catch (e) {
    console.error('downloadMedia normal falló:', e.message)
  }
  // Fallback: resolver el mensaje en la página con el id completo
  try {
    const page = client.pupPage
    if (!page) return null
    const msgId = msg.id
    const result = await page.evaluate(async (id) => {
      const Msg = window.require('WAWebCollections').Msg
      const { createWid } = window.require('WAWebWidFactory')
      const candidates = []
      const add = (c) => candidates.push(c)
      if (id) {
        add(id)
        if (id._serialized) add(id._serialized)
        if (id.id) add(id.id)
        if (typeof id.remote === 'string') {
          add({
            ...id,
            remote: createWid(id.remote),
            participant: typeof id.participant === 'string' ? createWid(id.participant) : id.participant,
          })
        }
      }
      let m = null
      for (const c of candidates) {
        try { m = Msg.get(c); if (m) break } catch {}
      }
      if (!m) {
        try {
          const r = await Msg.getMessagesById([id._serialized || id.$1])
          m = r && r.messages && r.messages[0]
        } catch {}
      }
      if (!m) {
        const all = Msg.getModelsArray()
        const serial = id && (id._serialized || id.$1)
        m = all.find((x) => x.id && (x.id._serialized === serial || x.id.$1 === serial || x.id.id === id.id))
      }
      if (!m || !m.mediaData || m.mediaData.mediaStage === 'REUPLOADING') return null
      if (m.mediaData.mediaStage !== 'RESOLVED') {
        try {
          await m.downloadMedia({ downloadEvenIfExpensive: true, rmrReason: 1 })
        } catch {}
      }
      if (m.mediaData.mediaStage.includes('ERROR') || m.mediaData.mediaStage === 'FETCHING') return null
      const mockQpl = {
        addAnnotations() { return this },
        addPoint() { return this },
      }
      const decryptedMedia = await window
        .require('WAWebDownloadManager')
        .downloadManager.downloadAndMaybeDecrypt({
          directPath: m.directPath,
          encFilehash: m.encFilehash,
          filehash: m.filehash,
          mediaKey: m.mediaKey,
          mediaKeyTimestamp: m.mediaKeyTimestamp,
          type: m.type,
          signal: new AbortController().signal,
          downloadQpl: mockQpl,
        })
      const data = await window.WWebJS.arrayBufferToBase64Async(decryptedMedia)
      return { data, mimetype: m.mimetype, filename: m.filename, filesize: m.size }
    }, msgId)
    if (!result) return null
    return {
      data: result.data,
      mimetype: result.mimetype,
      filename: result.filename,
      filesize: result.filesize,
    }
  } catch (e) {
    console.error('downloadMedia fallback error:', e.message)
    return null
  }
}

client.on('message', async (msg) => {
  if (msg.fromMe) return
  const text = msg.body || ''
  const jid = msg.from // numero@c.us o grupo@g.us
  const isGroup = String(jid).endsWith('@g.us')
  let name = msg._data && msg._data.notifyName
  if (isGroup && !name) {
    try {
      const chat = await msg.getChat()
      name = chat.name || ''
    } catch {
      name = ''
    }
  }

  // descargar media (foto/audio/video/sticker) para mostrar preview
  let mediaInfo = null
  if (msg.hasMedia) {
    try {
      const media = await downloadMediaSafe(msg)
      if (media && media.data) {
        const buf = Buffer.from(media.data || '', 'base64')
        const type =
          msg.type === 'audio' || msg.type === 'ptt' || (media.mimetype && media.mimetype.startsWith('audio/'))
            ? 'audio'
            : msg.type === 'video' || (media.mimetype && media.mimetype.startsWith('video/'))
              ? 'video'
              : 'image'
        const url = saveMediaFile(buf, media.mimetype)
        if (url) mediaInfo = { type, url, mimetype: media.mimetype }
      }
    } catch (e) {
      console.error('downloadMedia error:', e.message)
    }
  }
  if (!text && !mediaInfo) return
  addMessage(jid, name || '', false, text, mediaInfo)

  // bot con API (prioridad) o auto-respuesta simple
  if (data.bot.enabled && data.bot.endpoint && data.bot.apiKey) {
    const reply = await callBot(jid)
    if (reply && state.status === 'connected') {
      await client.sendMessage(jid, reply)
      addMessage(jid, name || '', true, reply)
    }
  } else if (data.settings.autoReply && data.settings.replyText) {
    if (state.status === 'connected') {
      await client.sendMessage(jid, data.settings.replyText)
      addMessage(jid, name || '', true, data.settings.replyText)
    }
  }
})

client.on('disconnected', (reason) => {
  state.status = 'disconnected'
  state.error = 'Desconectado: ' + reason
  qrDataUrl = null
  console.log('✖ Desconectado:', reason)
  broadcast()
})

// ------------------------------------------------------------------
// Listeners de presencia (en línea / escribiendo)
// whatsapp-web.js emite 'message_ack' y cambios de presencia via
// eventos internos. Para presencia usamos polling + evento directo.
// ------------------------------------------------------------------
client.on('message_received', (msg) => {
  // Cuando llega un mensaje, refrescar presencia del remitente
  const jid = msg.from
  if (jid && !String(jid).endsWith('@g.us')) {
    getPresenceDirect(jid).then((p) => {
      if (p) {
        if (!presenceMap[jid]) presenceMap[jid] = {}
        presenceMap[jid].state = p.state
        presenceMap[jid].isOnline = !!p.isOnline
        scheduleBroadcast()
      }
    }).catch(() => {})
  }
})

// Polling de presence para todos los chats cada 5 segundos
setInterval(async () => {
  if (state.status !== 'connected') return
  try {
    const all = await getAllPresence()
    let changed = false
    for (const [jid, p] of Object.entries(all)) {
      const old = presenceMap[jid] || {}
      if (!p) continue
      if (old.state !== p.state || old.isOnline !== p.isOnline) {
        changed = true
      }
      if (!presenceMap[jid]) presenceMap[jid] = {}
      presenceMap[jid].state = p.state
      presenceMap[jid].isOnline = !!p.isOnline
    }
    if (changed) broadcast()
  } catch (e) {
    // errores de presencia no deben romper el server
  }
}, 5000)

// La sesión se guarda en wwebjs_auth/ y se reutiliza en cada arranque.
// Para forzar un QR nuevo: CLEAN_SESSION=1 npm start (o borrar wwebjs_auth/).
function resetSession() {
  try {
    fs.rmSync(AUTH_DIR, { recursive: true, force: true })
    fs.mkdirSync(AUTH_DIR, { recursive: true })
    console.log('🧹 Sesión anterior borrada — arranque limpio')
  } catch (e) {
    console.error('No se pudo limpiar la sesión:', e.message)
  }
}

function startClient() {
  if (process.env.CLEAN_SESSION === '1') resetSession()
  bootAt = Date.now()
  client.initialize().catch((e) => {
    state.status = 'disconnected'
    state.error = 'Error al iniciar: ' + e.message
    console.error('Error al iniciar cliente:', e.message)
    broadcast()
  })
}

startClient()

// ------------------------------------------------------------------ planificador
function schedulerTick() {
  const now = Date.now()
  let changed = false
  for (const s of data.schedules) {
    if (!s.enabled) continue
    const fireAt = new Date(s.datetime).getTime()
    if (now >= fireAt && s.lastFired !== s.datetime) {
      const jid = normalizeJid(s.number)
      if (state.status === 'connected') {
        client
          .sendMessage(jid, s.message)
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
    .map((c) => {
      const last = c.messages.length ? c.messages[c.messages.length - 1] : null
      let preview = ''
      if (last) {
        if (last.media) {
          preview = last.media.type === 'audio' ? 'Audio' : last.media.type === 'video' ? 'Video' : 'Foto'
        } else {
          preview = last.text || ''
        }
      }
      const p = presenceMap[c.jid] || {}
      return {
        jid: c.jid,
        name: displayName(c.jid, c.name),
        lastMessage: preview,
        lastTime: c.lastTime,
        count: c.messages.length,
        presence: p.state || 'unavailable',
        isOnline: !!p.isOnline,
        isBlocked: !!p.isBlocked,
        isTyping: p.state === 'composing',
      }
    })
}
function broadcast() {
  const payload =
    'data: ' +
    JSON.stringify({
      status: state.status,
      me: state.me,
      qr: qrDataUrl,
      conversations: conversationsSummary(),
      presence: presenceMap,
    }) +
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
  limits: { fileSize: 25 * 1024 * 1024 }, // 25 MB
})

app.get('/api/status', (_req, res) => {
  res.json({ status: state.status, qr: qrDataUrl, me: state.me, error: state.error, presence: presenceMap })
})

app.get('/api/events', (_req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  })
  res.write(
    'data: ' +
      JSON.stringify({ status: state.status, me: state.me, qr: qrDataUrl, conversations: conversationsSummary(), presence: presenceMap }) +
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
  const target = jid || (number ? normalizeJid(number) : null)
  if (!target || !text) return res.status(400).json({ ok: false, error: 'Faltan datos' })
  if (state.status !== 'connected') return res.status(409).json({ ok: false, error: 'Bot no conectado' })
  try {
    await retryOp(() => sendTextDirect(target, text))
    addMessage(target, null, true, text)
    console.log('✔ enviado a', target, ':', String(text).slice(0, 40))
    res.json({ ok: true, jid: target })
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

app.post('/api/logout', async (_req, res) => {
  try {
    await client.logout()
  } catch {
    /* ignore */
  }
  state.status = 'disconnected'
  state.qr = null
  qrDataUrl = null
  res.json({ ok: true })
  // volver a inicializar para mostrar QR nuevo
  setTimeout(() => client.initialize().catch(() => {}), 1000)
})

// ------------------------------------------------------------------ media (foto / audio)
app.post('/api/send-media', upload.single('file'), async (req, res) => {
  const { jid, number, type, caption } = req.body || {}
  const target = jid || (number ? normalizeJid(number) : null)
  const file = req.file
  const cleanup = () => {
    if (file && file.path) {
      try { fs.unlinkSync(file.path) } catch { /* ignore */ }
    }
  }
  if (!target || !file) {
    cleanup()
    return res.status(400).json({ ok: false, error: 'Faltan datos (jid y archivo)' })
  }
  if (state.status !== 'connected') {
    cleanup()
    return res.status(409).json({ ok: false, error: 'Bot no conectado' })
  }
  try {
    const isAudio = type === 'audio'
    let buf
    let mime
    let filename

    if (isAudio) {
      // Convertir SIEMPRE a OGG/Opus para que sea nota de voz nativa,
      // sin importar el formato que haya grabado/adjuntado el navegador.
      const outPath = file.path + '.ogg'
      try {
        await convertToVoiceNote(file.path, outPath)
        buf = fs.readFileSync(outPath)
        mime = 'audio/ogg'
        filename = 'nota-de-voz.ogg'
        console.log('✔ audio convertido a ogg/opus')
      } catch (convErr) {
        // Si la conversión falla, se envía el original con su mimetype detectado.
        console.error('✖ conversión a ogg falló, se envía el original:', convErr.message)
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

    const media = new MessageMedia(mime, buf.toString('base64'), filename, buf.length)
    const options = {}
    if (caption) options.caption = caption
    if (isAudio) options.sendAudioAsVoice = true
    await retryOp(() => sendMediaDirect(target, media, options))
    const url = saveMediaFile(buf, media.mimetype || mime)
    addMessage(target, null, true, caption || '', url ? { type: isAudio ? 'audio' : 'image', url, mimetype: media.mimetype || mime } : null)
    console.log('✔ media enviado a', target, '(', media.mimetype, ')')
    res.json({ ok: true, jid: target })
  } catch (e) {
    console.error('✖ error al enviar media:', e.message)
    res.status(500).json({ ok: false, error: e.message })
  } finally {
    cleanup()
  }
})

// ------------------------------------------------------------------ eliminar chat
app.post('/api/delete-chat', async (req, res) => {
  const { jid } = req.body || {}
  if (!jid) return res.status(400).json({ ok: false, error: 'Falta jid' })
  if (state.status !== 'connected') return res.status(409).json({ ok: false, error: 'Bot no conectado' })
  try {
    await retryOp(() => deleteChatDirect(jid))
    delete data.conversations[jid]
    saveData()
    broadcast()
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message })
  }
})

// ------------------------------------------------------------------ bloquear / desbloquear
app.post('/api/block', async (req, res) => {
  const { jid } = req.body || {}
  if (!jid) return res.status(400).json({ ok: false, error: 'Falta jid' })
  if (state.status !== 'connected') return res.status(409).json({ ok: false, error: 'Bot no conectado' })
  try {
    await retryOp(() => blockContactDirect(jid))
    // Actualizar presence
    if (!presenceMap[jid]) presenceMap[jid] = {}
    presenceMap[jid].isBlocked = true
    broadcast()
    res.json({ ok: true, blocked: true })
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message })
  }
})

app.post('/api/unblock', async (req, res) => {
  const { jid } = req.body || {}
  if (!jid) return res.status(400).json({ ok: false, error: 'Falta jid' })
  if (state.status !== 'connected') return res.status(409).json({ ok: false, error: 'Bot no conectado' })
  try {
    await retryOp(() => unblockContactDirect(jid))
    if (!presenceMap[jid]) presenceMap[jid] = {}
    presenceMap[jid].isBlocked = false
    broadcast()
    res.json({ ok: true, blocked: false })
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message })
  }
})

// ------------------------------------------------------------------ presence de un contacto
app.get('/api/presence', async (req, res) => {
  const jid = req.query.jid
  if (!jid) return res.status(400).json({ ok: false, error: 'Falta jid' })
  if (state.status !== 'connected') return res.status(409).json({ ok: false, error: 'Bot no conectado' })
  try {
    const [presence, blocked] = await Promise.all([
      retryOp(() => getPresenceDirect(jid)).catch(() => null),
      retryOp(() => getIsBlockedDirect(jid)).catch(() => false),
    ])
    const result = {
      jid,
      state: presence ? presence.state : 'unavailable',
      isOnline: presence ? !!presence.isOnline : false,
      lastSeen: presence ? presence.lastSeen : null,
      isBlocked: blocked,
    }
    // Actualizar cache
    presenceMap[jid] = result
    broadcast()
    res.json({ ok: true, presence: result })
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message })
  }
})

// ------------------------------------------------------------------ grupos
app.post('/api/group', async (req, res) => {
  const { name, participants } = req.body || {}
  if (!name || !Array.isArray(participants) || !participants.length) {
    return res.status(400).json({ ok: false, error: 'Faltan datos (nombre y participantes)' })
  }
  try {
    const jids = participants.map((p) => normalizeJid(p))
    const group = await client.createGroup(name, jids)
    const gid = (group && group.gid && group.gid._serialized) || (group && group.gid) || ''
    res.json({ ok: true, gid: String(gid) })
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message })
  }
})

app.post('/api/group/add', async (req, res) => {
  const { groupJid, participants } = req.body || {}
  if (!groupJid || !Array.isArray(participants) || !participants.length) {
    return res.status(400).json({ ok: false, error: 'Faltan datos (groupJid y participants)' })
  }
  try {
    const chat = await client.getChatById(groupJid)
    const jids = participants.map((p) => normalizeJid(p))
    await chat.addParticipants(jids)
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message })
  }
})

// debug temporal: inspeccionar API interna de WhatsApp Web
app.post('/api/debug-eval', async (req, res) => {
  const { code } = req.body || {}
  if (!code) return res.status(400).json({ ok: false })
  try {
    const out = await client.pupPage.evaluate((c) => {
      return new Function('return (async () => { ' + c + ' })()')()
    }, code)
    res.json({ ok: true, out })
  } catch (e) {
    res.json({ ok: false, error: e.message })
  }
})

app.listen(PORT, () => {
  console.log(`✔ WhatsBot (whatsapp-web.js) corriendo en http://localhost:${PORT}`)
})
