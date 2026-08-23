const $ = (s) => document.querySelector(s)
const $$ = (s) => document.querySelectorAll(s)

let activeJid = null
let conversations = []

const SVG_SUN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="ic" aria-hidden="true"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>'
const SVG_MOON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="ic" aria-hidden="true"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>'
const SVG_CHAT_EMPTY = '<div class="empty-emoji"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg></div>'

/* ============ tema ============ */
const savedTheme = localStorage.getItem('theme') || 'dark'
document.documentElement.setAttribute('data-theme', savedTheme)
syncThemeUI()

function setTheme(t) {
  document.documentElement.setAttribute('data-theme', t)
  localStorage.setItem('theme', t)
  syncThemeUI()
}

function syncThemeUI() {
  const dark = document.documentElement.getAttribute('data-theme') === 'dark'
  $('#themeToggle').innerHTML = dark ? SVG_SUN : SVG_MOON
  $('#themeSwitch').checked = !dark
}
$('#themeToggle').addEventListener('click', () => {
  const cur = document.documentElement.getAttribute('data-theme')
  setTheme(cur === 'dark' ? 'light' : 'dark')
})
$('#themeSwitch').addEventListener('change', (e) => setTheme(e.target.checked ? 'light' : 'dark'))

/* ============ helpers ============ */
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}
function initials(name) {
  const parts = String(name).replace(/[^a-zA-Z0-9áéíóúÁÉÍÓÚñÑ ]/g, '').trim().split(/\s+/)
  if (!parts[0]) return '?'
  const a = parts[0][0] || ''
  const b = parts[1] ? parts[1][0] : ''
  return (a + b).toUpperCase()
}
function avatarColor(name) {
  const colors = ['#00a884', '#6c5ce7', '#e17055', '#0984e3', '#e84393', '#00b894', '#d63031', '#fdcb6e']
  let h = 0
  for (const ch of String(name)) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return colors[h % colors.length]
}
function timeShort(iso) {
  const d = new Date(iso)
  const today = new Date()
  const same = d.toDateString() === today.toDateString()
  return d.toLocaleTimeString('es-AR', same ? { hour: '2-digit', minute: '2-digit' } : { day: '2-digit', month: '2-digit', year: '2-digit' })
}

/* ============ vista (QR vs app) ============ */
function showView(status) {
  const connected = status === 'connected'
  $('#qrScreen').classList.toggle('hidden', connected)
  $('#app').classList.toggle('hidden', !connected)
}

function renderStatus(status, me, qr) {
  showView(status)
  const pill = $('#statusPill')
  const labels = { connecting: 'Conectando…', connected: 'Conectado', disconnected: 'Desconectado' }
  pill.textContent = labels[status] || status
  pill.className = 'pill ' + status

  if (status === 'connecting' && qr) {
    $('#qrBox').style.display = 'block'
    $('#qrLoading').style.display = 'none'
    const img = $('#qrImg')
    if (img.src !== qr) img.src = qr
  } else if (status === 'connecting') {
    $('#qrBox').style.display = 'none'
    $('#qrLoading').style.display = 'block'
  } else {
    $('#qrBox').style.display = 'none'
    $('#qrLoading').style.display = 'none'
  }

  if (me && me.name) {
    $('#meName').textContent = me.name
    $('#meNumber').textContent = me.number ? '+' + me.number : ''
    $('#meAvatar').textContent = initials(me.name)
    $('#meAvatar').style.background = avatarColor(me.name)
  }
}

/* ============ lista de chats ============ */
function renderChatList(filter) {
  const ul = $('#chatList')
  ul.innerHTML = ''
  const list = conversations.filter((c) => {
    if (!filter) return true
    const f = filter.toLowerCase()
    return (c.name + ' ' + c.lastMessage).toLowerCase().includes(f)
  })
  for (const c of list) {
    const li = document.createElement('li')
    li.className = 'chat-item' + (c.jid === activeJid ? ' active' : '')
    li.dataset.jid = c.jid
    const av = document.createElement('div')
    av.className = 'avatar'
    av.style.background = avatarColor(c.name)
    av.textContent = initials(c.name)
    // Punto verde si está en línea
    if (c.isOnline) {
      const dot = document.createElement('span')
      dot.className = 'online-dot'
      dot.title = 'en línea'
      av.appendChild(dot)
    }
    const body = document.createElement('div')
    body.className = 'body'
    // Si está escribiendo, mostrar "escribiendo…" en verde; si está bloqueado, mostrar badge
    let previewHTML = ''
    if (c.isBlocked) {
      previewHTML = '<span class="blocked-badge">bloqueado</span>'
    } else if (c.isTyping) {
      previewHTML = '<span class="typing-preview">escribiendo…</span>'
    } else {
      previewHTML = esc(c.lastMessage || '')
    }
    body.innerHTML =
      '<div class="top"><span class="name">' + esc(c.name) + '</span><span class="time">' + timeShort(c.lastTime || Date.now()) + '</span></div>' +
      '<div class="preview">' + previewHTML + '</div>'
    li.appendChild(av)
    li.appendChild(body)
    li.addEventListener('click', () => openChat(c.jid))
    ul.appendChild(li)
  }
}

/* ============ abrir chat ============ */
async function openChat(jid) {
  activeJid = jid
  $('#app').classList.add('chat-open')
  renderChatList($('#searchInput').value)
  $$('.chat-item').forEach((el) => el.classList.toggle('active', el.dataset.jid === jid))
  const r = await fetch('/api/messages?jid=' + encodeURIComponent(jid))
  const data = await r.json()
  $('#chatName').textContent = data.name || '+' + jid.split('@')[0]
  $('#chatAvatar').textContent = initials(data.name || '+')
  $('#chatAvatar').style.background = avatarColor(data.name || jid)
  $('#msgInput').disabled = false
  $('#sendBtn').disabled = false
  renderMessages(data.messages || [])
  $('#msgInput').focus()
  // Cargar presence del contacto al abrir el chat
  fetchPresence(jid)
}

// Estado de presence del chat activo
let activePresence = { state: 'unavailable', isOnline: false, isBlocked: false, isTyping: false }

async function fetchPresence(jid) {
  if (!jid) return
  try {
    const r = await fetch('/api/presence?jid=' + encodeURIComponent(jid))
    const j = await r.json()
    if (j.ok && j.presence) {
      activePresence = {
        state: j.presence.state || 'unavailable',
        isOnline: !!j.presence.isOnline,
        isBlocked: !!j.presence.isBlocked,
        isTyping: j.presence.state === 'composing',
      }
      renderChatStatus()
    }
  } catch { /* ignore */ }
}

function renderChatStatus() {
  const el = $('#chatStatus')
  if (!el) return
  if (!activeJid) { el.textContent = ''; return }
  // Prioridad: bloqueado > escribiendo > en línea > fuera de línea
  if (activePresence.isBlocked) {
    el.textContent = 'bloqueado'
    el.className = 'chat-status blocked'
  } else if (activePresence.isTyping || activePresence.state === 'composing') {
    el.innerHTML = '<span class="typing"><span class="dot"></span><span class="dot"></span><span class="dot"></span></span> escribiendo…'
    el.className = 'chat-status typing'
  } else if (activePresence.isOnline || activePresence.state === 'available') {
    el.textContent = 'en línea'
    el.className = 'chat-status online'
  } else {
    el.textContent = 'fuera de línea'
    el.className = 'chat-status offline'
  }
}

function closeChat() {
  activeJid = null
  $('#app').classList.remove('chat-open')
  renderChatList($('#searchInput').value)
}
$('#backBtn').addEventListener('click', closeChat)

function renderMessages(messages) {
  const box = $('#messages')
  box.innerHTML = ''
  if (!messages || !messages.length) {
    box.innerHTML = '<div class="empty-chat">' + SVG_CHAT_EMPTY + '<p>Sin mensajes todavía</p></div>'
    return
  }
  for (const m of messages) {
    const div = document.createElement('div')
    div.className = 'msg ' + (m.fromMe ? 'out' : 'in')
    let inner = ''
    if (m.media) {
      if (m.media.type === 'image') {
        inner += '<img class="msg-media" src="' + m.media.url + '" alt="Foto" loading="lazy" />'
      } else if (m.media.type === 'video') {
        inner += '<video class="msg-media" src="' + m.media.url + '" controls playsinline></video>'
      } else if (m.media.type === 'audio') {
        inner += '<audio class="msg-audio" src="' + m.media.url + '" controls></audio>'
      }
    }
    if (m.text) inner += '<div class="msg-text">' + esc(m.text) + '</div>'
    inner += '<span class="time">' + timeShort(m.time) + '</span>'
    div.innerHTML = inner
    box.appendChild(div)
  }
  box.scrollTop = box.scrollHeight
}

/* ============ enviar ============ */
async function sendMessage() {
  const text = $('#msgInput').value.trim()
  if (!text || !activeJid) return
  $('#msgInput').value = ''
  appendMessage(text, true) // mostrarlo al instante (optimista)
  try {
    const r = await fetch('/api/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jid: activeJid, text }),
    })
    const j = await r.json()
    if (!j.ok) {
      showToast('No se pudo enviar: ' + j.error)
    }
  } catch (e) {
    showToast('Error de red: ' + e.message)
  }
  refreshMessages()
}
$('#sendBtn').addEventListener('click', sendMessage)
$('#msgInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') sendMessage()
})

function appendMessage(text, fromMe) {
  const box = $('#messages')
  const empty = box.querySelector('.empty-chat')
  if (empty) empty.remove()
  const div = document.createElement('div')
  div.className = 'msg ' + (fromMe ? 'out' : 'in')
  div.innerHTML = esc(text) + '<span class="time">' + timeShort(new Date().toISOString()) + '</span>'
  box.appendChild(div)
  box.scrollTop = box.scrollHeight
}

function refreshMessages() {
  if (!activeJid) return
  fetch('/api/messages?jid=' + encodeURIComponent(activeJid))
    .then((r) => r.json())
    .then((d) => { if (d.jid === activeJid) renderMessages(d.messages || []) })
    .catch(() => {})
}

let toastTimer
function showToast(msg) {
  let t = $('#toast')
  if (!t) {
    t = document.createElement('div')
    t.id = 'toast'
    document.body.appendChild(t)
  }
  t.textContent = msg
  t.classList.add('show')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => t.classList.remove('show'), 4000)
}

/* ============ nuevo chat (modal) ============ */
const newChatModal = $('#newChatModal')
const openNewChat = () => {
  newChatModal.classList.remove('hidden')
  $('#newChatNumber').value = ''
  $('#newChatName').value = ''
  $('#newChatNumber').focus()
}
const closeNewChat = () => newChatModal.classList.add('hidden')
$('#newChatBtn').addEventListener('click', openNewChat)
$('#closeNewChatBtn').addEventListener('click', closeNewChat)
newChatModal.addEventListener('click', (e) => { if (e.target === newChatModal) closeNewChat() })

$('#startChatBtn').addEventListener('click', () => {
  const raw = $('#newChatNumber').value.trim()
  const name = $('#newChatName').value.trim()
  if (!raw) { showToast('Escribí un número'); return }
  let digits = raw.replace(/\D/g, '').replace(/^0+/, '')
  if (/^5950\d{9}$/.test(digits)) digits = '595' + digits.slice(4)
  if (!digits) { showToast('Número inválido'); return }
  activeJid = digits + '@c.us'
  $('#app').classList.add('chat-open')
  $('#chatName').textContent = name || '+' + digits
  $('#chatAvatar').textContent = initials(name || '+' + digits)
  $('#chatAvatar').style.background = avatarColor(name || digits)
  $('#msgInput').disabled = false
  $('#sendBtn').disabled = false
  renderMessages([])
  closeNewChat()
  $('#msgInput').focus()
})
$('#newChatNumber').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#startChatBtn').click() })
$('#newChatName').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#startChatBtn').click() })

/* ============ búsqueda ============ */
$('#searchInput').addEventListener('input', (e) => renderChatList(e.target.value))

/* ============ configuración ============ */
$('#settingsBtn').addEventListener('click', () => $('#settingsModal').classList.remove('hidden'))
$('#closeSettingsBtn').addEventListener('click', () => $('#settingsModal').classList.add('hidden'))
$('#settingsModal').addEventListener('click', (e) => {
  if (e.target === $('#settingsModal')) $('#settingsModal').classList.add('hidden')
})

async function loadSettings() {
  const b = await (await fetch('/api/bot')).json()
  $('#botEnabled').checked = !!b.enabled
  $('#botEndpoint').value = b.endpoint || ''
  $('#botApiKey').value = b.apiKey || ''
  $('#botModel').value = b.model || ''
  $('#botPrompt').value = b.systemPrompt || ''

  const s = await (await fetch('/api/settings')).json()
  $('#autoReplyToggle').checked = !!s.autoReply
  $('#autoReplyText').value = s.replyText || ''
}

$('#saveBotBtn').addEventListener('click', async () => {
  await fetch('/api/bot', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      enabled: $('#botEnabled').checked,
      endpoint: $('#botEndpoint').value.trim(),
      apiKey: $('#botApiKey').value.trim(),
      model: $('#botModel').value.trim(),
      systemPrompt: $('#botPrompt').value.trim(),
    }),
  })
  showToast('Bot guardado')
})

$('#saveSettingsBtn').addEventListener('click', async () => {
  await fetch('/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      autoReply: $('#autoReplyToggle').checked,
      replyText: $('#autoReplyText').value.trim(),
    }),
  })
  showToast('Guardado')
})

/* ============ logout ============ */
$('#logoutBtn').addEventListener('click', async () => {
  if (!confirm('¿Cerrar sesión de WhatsApp? Tendrás que escanear el QR de nuevo.')) return
  await fetch('/api/logout', { method: 'POST' })
  activeJid = null
})

/* ============ streaming (SSE) ============ */
async function initStatus() {
  const s = await (await fetch('/api/status')).json()
  renderStatus(s.status, s.me, s.qr)
}

function connectEvents() {
  const es = new EventSource('/api/events')
  es.onmessage = (ev) => {
    let d
    try {
      d = JSON.parse(ev.data)
    } catch {
      return
    }
    renderStatus(d.status, d.me, d.qr)
    conversations = d.conversations || []
    // Actualizar presence del chat activo si llegó data
    if (d.presence && activeJid && d.presence[activeJid]) {
      const p = d.presence[activeJid]
      activePresence = {
        state: p.state || 'unavailable',
        isOnline: !!p.isOnline,
        isBlocked: !!p.isBlocked,
        isTyping: p.state === 'composing',
      }
      renderChatStatus()
    }
    renderChatList($('#searchInput').value)
    if (activeJid && d.status === 'connected') {
      // refrescar mensajes del chat activo si llegó algo nuevo
      fetch('/api/messages?jid=' + encodeURIComponent(activeJid))
        .then((r) => r.json())
        .then((m) => {
          if (m.jid === activeJid) renderMessages(m.messages || [])
        })
        .catch(() => {})
    }
  }
  es.onerror = () => {
    /* el navegador reintenta automáticamente */
  }
}

/* ============ visor de fotos (lightbox) ============ */
$('#messages').addEventListener('click', (e) => {
  const img = e.target.closest('img.msg-media')
  if (!img) return
  $('#lightboxImg').src = img.src
  $('#lightbox').classList.remove('hidden')
})
$('#lightboxClose').addEventListener('click', () => $('#lightbox').classList.add('hidden'))
$('#lightbox').addEventListener('click', (e) => {
  if (e.target === $('#lightbox')) $('#lightbox').classList.add('hidden')
})

/* ============ grabación de audio en tiempo real ============ */
let mediaRecorder = null
let recChunks = []
let recTimer = null
let recSeconds = 0

function fmtRec(s) {
  const m = String(Math.floor(s / 60)).padStart(2, '0')
  const ss = String(s % 60).padStart(2, '0')
  return m + ':' + ss
}
function setRecordingUI(on) {
  $('#composer').classList.toggle('recording', on)
}

function pickAudioMime() {
  // Preferimos formatos que WhatsApp Web acepta como nota de voz nativa.
  const candidates = [
    'audio/mp4',
    'audio/mp4;codecs=mp4a.40.2',
    'audio/ogg;codecs=opus',
    'audio/webm;codecs=opus',
    'audio/webm',
  ]
  if (window.MediaRecorder && MediaRecorder.isTypeSupported) {
    for (const t of candidates) {
      try {
        if (MediaRecorder.isTypeSupported(t)) return t
      } catch {
        /* ignore */
      }
    }
  }
  return ''
}

$('#micBtn').addEventListener('click', async () => {
  if (!activeJid) {
    showToast('Abrí un chat primero')
    return
  }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    showToast('Este navegador no soporta grabación de audio')
    return
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    const recMime = pickAudioMime()
    mediaRecorder = new MediaRecorder(stream, recMime ? { mimeType: recMime } : undefined)
    recChunks = []
    recSeconds = 0
    $('#recTime').textContent = '00:00'
    mediaRecorder.ondataavailable = (ev) => {
      if (ev.data && ev.data.size) recChunks.push(ev.data)
    }
    mediaRecorder.onstop = () => {
      stream.getTracks().forEach((t) => t.stop())
      clearInterval(recTimer)
    }
    mediaRecorder.start()
    setRecordingUI(true)
    recTimer = setInterval(() => {
      recSeconds++
      $('#recTime').textContent = fmtRec(recSeconds)
    }, 1000)
  } catch (e) {
    showToast('Permiso de micrófono denegado: ' + e.message)
  }
})

$('#recCancelBtn').addEventListener('click', () => {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.onstop = () => {
      mediaRecorder.stream.getTracks().forEach((t) => t.stop())
      clearInterval(recTimer)
    }
    mediaRecorder.stop()
  }
  mediaRecorder = null
  recChunks = []
  setRecordingUI(false)
  showToast('Grabación cancelada')
})

$('#recSendBtn').addEventListener('click', async () => {
  if (!mediaRecorder || mediaRecorder.state === 'inactive') return
  const blob = await new Promise((resolve) => {
    const prev = mediaRecorder.onstop
    mediaRecorder.onstop = () => {
      prev && prev()
      resolve(new Blob(recChunks, { type: mediaRecorder.mimeType || 'audio/webm' }))
    }
    mediaRecorder.stop()
  })
  mediaRecorder = null
  recChunks = []
  setRecordingUI(false)
  if (!blob.size) {
    showToast('Grabación vacía')
    return
  }
  const recMime = mediaRecorder.mimeType || 'audio/webm'
  const recExt = recMime.includes('mp4') ? 'm4a' : recMime.includes('ogg') ? 'ogg' : 'webm'
  const fd = new FormData()
  fd.append('file', blob, 'nota-de-voz.' + recExt)
  fd.append('jid', activeJid)
  fd.append('type', 'audio')
  try {
    const r = await fetch('/api/send-media', { method: 'POST', body: fd })
    const j = await r.json()
    if (!j.ok) showToast('No se pudo enviar: ' + j.error)
    else refreshMessages()
  } catch (e) {
    showToast('Error: ' + e.message)
  }
})

/* ============ refresco de respaldo (polling) ============ */
// Si el SSE se corta o queda estancado en el navegador, este polling
// garantiza que el QR de la pantalla siempre esté fresco (cada 5s).
setInterval(async () => {
  try {
    const s = await (await fetch('/api/status', { cache: 'no-store' })).json()
    renderStatus(s.status, s.me, s.qr)
  } catch {
    /* sin servidor todavía */
  }
}, 5000)

/* ============ arranque ============ */
initStatus()
loadSettings()
connectEvents()

/* ============ adjuntar foto / audio ============ */
let pendingMediaType = 'photo'
$('#attachBtn').addEventListener('click', () => {
  $('#attachMenu').classList.toggle('hidden')
})
$('#sendPhotoBtn').addEventListener('click', () => {
  pendingMediaType = 'photo'
  $('#fileInput').accept = 'image/*'
  $('#fileInput').click()
  $('#attachMenu').classList.add('hidden')
})
$('#sendAudioBtn').addEventListener('click', () => {
  pendingMediaType = 'audio'
  $('#fileInput').accept = 'audio/*'
  $('#fileInput').click()
  $('#attachMenu').classList.add('hidden')
})
$('#fileInput').addEventListener('change', () => {
  const f = $('#fileInput').files[0]
  if (f) uploadMedia(f, pendingMediaType)
  $('#fileInput').value = ''
})

async function uploadMedia(file, type) {
  if (!activeJid) return
  const fd = new FormData()
  fd.append('file', file)
  fd.append('jid', activeJid)
  fd.append('type', type === 'audio' ? 'audio' : 'photo')
  try {
    const r = await fetch('/api/send-media', { method: 'POST', body: fd })
    const j = await r.json()
    if (!j.ok) {
      showToast('No se pudo enviar: ' + j.error)
    } else {
      refreshMessages()
    }
  } catch (e) {
    showToast('Error: ' + e.message)
  }
}

/* ============ menú del chat (bloquear / eliminar) ============ */
$('#chatMenuBtn').addEventListener('click', () => {
  $('#chatMenu').classList.toggle('hidden')
})
$('#blockBtn').addEventListener('click', async () => {
  if (!activeJid) return
  $('#chatMenu').classList.add('hidden')
  const j = await postJson('/api/block', { jid: activeJid })
  if (j.ok) {
    activePresence.isBlocked = true
    renderChatStatus()
    showToast('Contacto bloqueado')
  } else {
    showToast('Error: ' + (j.error || 'no disponible'))
  }
})
$('#unblockBtn').addEventListener('click', async () => {
  if (!activeJid) return
  $('#chatMenu').classList.add('hidden')
  const j = await postJson('/api/unblock', { jid: activeJid })
  if (j.ok) {
    activePresence.isBlocked = false
    renderChatStatus()
    showToast('Contacto desbloqueado')
  } else {
    showToast('Error: ' + (j.error || 'no disponible'))
  }
})
$('#deleteChatBtn').addEventListener('click', async () => {
  if (!activeJid) return
  $('#chatMenu').classList.add('hidden')
  if (!confirm('¿Eliminar este chat de WhatsApp?')) return
  const j = await postJson('/api/delete-chat', { jid: activeJid })
  showToast(j.ok ? 'Chat eliminado' : 'Error: ' + (j.error || 'no disponible'))
  if (j.ok) closeChat()
})

async function postJson(url, body) {
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    return await r.json()
  } catch (e) {
    return { ok: false, error: e.message }
  }
}

/* ============ grupo (modal) ============ */
const groupModal = $('#groupModal')
let gpSelected = [] // [{ jid, name, number }]
let gpSearchQuery = ''

const SVG_CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>'

function openGroup() {
  groupModal.classList.remove('hidden')
  $('#groupName').value = ''
  $('#gpManualNumber').value = ''
  $('#gpSearchInput').value = ''
  gpSelected = []
  gpSearchQuery = ''
  renderGpChips()
  renderGpContacts()
  $('#groupName').focus()
}
function closeGroup() { groupModal.classList.add('hidden') }
$('#groupBtn').addEventListener('click', openGroup)
$('#closeGroupBtn').addEventListener('click', closeGroup)
groupModal.addEventListener('click', (e) => { if (e.target === groupModal) closeGroup() })

/* chips de seleccionados */
function renderGpChips() {
  const box = $('#gpSelectedChips')
  box.innerHTML = ''
  for (const p of gpSelected) {
    const chip = document.createElement('div')
    chip.className = 'gp-chip'
    chip.innerHTML =
      '<span class="chip-name">' + esc(p.name) + '</span>' +
      '<span class="chip-num">' + esc(p.number) + '</span>' +
      '<button class="chip-x" data-jid="' + esc(p.jid) + '" title="Quitar">&times;</button>'
    chip.querySelector('.chip-x').addEventListener('click', () => {
      gpSelected = gpSelected.filter((x) => x.jid !== p.jid)
      renderGpChips()
      renderGpContacts()
    })
    box.appendChild(chip)
  }
}

/* lista de contactos filtrable */
function renderGpContacts() {
  const list = $('#gpContactList')
  list.innerHTML = ''
  const q = gpSearchQuery.toLowerCase()
  const contacts = conversations.filter((c) => {
    if (!c.jid || c.jid.includes('@g.us')) return false // solo chats individuales
    const num = c.jid.split('@')[0]
    if (!q) return true
    return (c.name + ' ' + num).toLowerCase().includes(q)
  })
  // también mostrar contactos ya seleccionados aunque no estén en conversations (agregados a mano)
  const selectedJids = new Set(gpSelected.map((p) => p.jid))
  for (const c of contacts) {
    const jid = c.jid
    const num = jid.split('@')[0]
    const isSelected = selectedJids.has(jid)
    const li = document.createElement('div')
    li.className = 'gp-contact' + (isSelected ? ' selected' : '')
    li.dataset.jid = jid
    li.innerHTML =
      '<div class="gp-avatar" style="background:' + avatarColor(c.name) + '">' + initials(c.name) + '</div>' +
      '<div class="gp-info"><div class="gp-name">' + esc(c.name) + '</div><div class="gp-number">' + esc(num) + '</div></div>' +
      '<div class="gp-check">' + SVG_CHECK + '</div>'
    li.addEventListener('click', () => toggleGpSelection(jid, c.name, num))
    list.appendChild(li)
  }
  if (!contacts.length) {
    list.innerHTML = '<div style="padding:16px;text-align:center;color:var(--muted);font-size:13px;">No hay contactos que coincidan</div>'
  }
}

function toggleGpSelection(jid, name, number) {
  const idx = gpSelected.findIndex((p) => p.jid === jid)
  if (idx >= 0) {
    gpSelected.splice(idx, 1)
  } else {
    gpSelected.push({ jid, name, number })
  }
  renderGpChips()
  renderGpContacts()
}

/* buscar en la lista de contactos */
$('#gpSearchInput').addEventListener('input', (e) => {
  gpSearchQuery = e.target.value
  renderGpContacts()
})

/* agregar número manualmente */
$('#gpAddManualBtn').addEventListener('click', () => {
  const raw = $('#gpManualNumber').value.trim()
  if (!raw) { showToast('Escribí un número'); return }
  const digits = raw.replace(/\D/g, '').replace(/^0+/, '')
  if (!digits) { showToast('Número inválido'); return }
  const jid = digits + '@c.us'
  if (gpSelected.some((p) => p.jid === jid)) {
    showToast('Ya está agregado')
    return
  }
  // usar el nombre del contacto si ya existe en conversations, sino el número
  const existing = conversations.find((c) => c.jid === jid)
  const name = existing ? existing.name : '+' + digits
  gpSelected.push({ jid, name, number: digits })
  $('#gpManualNumber').value = ''
  renderGpChips()
  renderGpContacts()
})

/* enter en el campo de número manual agrega */
$('#gpManualNumber').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); $('#gpAddManualBtn').click() }
})

/* crear grupo */
$('#createGroupBtn').addEventListener('click', async () => {
  const name = $('#groupName').value.trim()
  if (!name) { showToast('Escribí un nombre para el grupo'); return }
  if (!gpSelected.length) { showToast('Agregá al menos un participante'); return }
  const participants = gpSelected.map((p) => p.number)
  const j = await postJson('/api/group', { name, participants })
  if (j.ok) { showToast('Grupo creado'); closeGroup() }
  else showToast('Error: ' + (j.error || 'no disponible'))
})
