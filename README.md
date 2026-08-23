# 💬 WhatsBot Web

Bot de WhatsApp con **interfaz estilo WhatsApp Web**: conectás con un QR y pasás directo a la
vista de chats (lista de conversaciones + ventana de chat con globos, en tiempo real).

## Requisitos

- Node.js **18 o superior**
- Tu teléfono con WhatsApp para escanear el QR (solo la primera vez)

## Instalación y uso

```bash
cd whatsapp-bot
npm install
npm start
```

Abrí en el navegador: **http://localhost:3000**

> Si el puerto 3000 está ocupado, usá otro: `PORT=3001 npm start` y abrí http://localhost:3001

1. En la **pantalla de QR**, escaneá con tu teléfono (*WhatsApp → Dispositivos vinculados → Vincular dispositivo*).
2. Al conectar, la pantalla **cambia sola a la vista de WhatsApp Web**.
3. La sesión queda guardada en `auth/` (no re-escaneás en cada arranque).

## Funciones

| Función | Descripción |
| --- | --- |
| QR → Chat | Pantalla de QR que transiciona directo a la interfaz de chat |
| Chats en tiempo real | Lista de conversaciones y mensajes con globos, actualizados por streaming (SSE) |
| Enviar / recibir | Escribí y respondé como en WhatsApp Web |
| Bot con API | Conectá una API estilo OpenAI (OpenAI, OpenRouter, Groq, Ollama…) desde **Configuración** |
| Auto-respuesta | Respuesta fija para todos los mensajes (si el bot con API está apagado) |
| Mensajes programados | Endpoints de programación disponibles (`/api/schedules`) |
| Tema | Modo claro / oscuro (botón ☀️/🌙) |

## Bot con API (Configuración)

Entrá al engranaje **⚙** y configurá:

- **Endpoint**: URL base de la API, ej. `https://api.openai.com/v1`
- **API Key**: tu clave (`sk-...`)
- **Modelo**: ej. `gpt-4o-mini`
- **Instrucciones**: el *system prompt* que define cómo responde el bot

Cuando alguien te escriba, el bot arma el contexto con los últimos 20 mensajes y responde solo
usando esa API.

## Estructura

```
whatsapp-bot/
├── server.js          # backend: Baileys + Express + SSE + bot API
├── qr-server.js       # servidor mínimo solo de QR (opcional)
├── package.json
├── data.json          # conversaciones, bot, ajustes (se crea solo)
├── auth/              # credenciales de la sesión (se crea solo)
└── public/
    ├── index.html     # WhatsApp Web UI
    ├── style.css      # diseño WhatsApp Web (claro/oscuro)
    └── app.js         # lógica del frontend (SSE)
```

## Notas

- **Números**: escribí el número completo **con código de país** y sin `+` (ej. `595 981 123456`).
- **Sin API oficial**: usa [Baileys](https://github.com/WhiskeySockets/Baileys), que emula WhatsApp Web.
  Es para uso personal/educativo; el spam masivo puede hacer que **bloqueen tu número**.
