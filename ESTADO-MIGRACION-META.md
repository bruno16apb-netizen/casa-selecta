# Estado de la migración a la API oficial de Meta (WhatsApp Cloud API)

Fecha: 22/08/2026

## Objetivo
Dejar de usar `whatsapp-web.js` (que emula WhatsApp Web y te restringió la cuenta)
y pasar a la **Graph API oficial de Meta**, que no se restringe.

## Motivo de la restricción (diagnóstico previo)
- WhatsApp restringió la cuenta en "dispositivos vinculados" por detectar
  "spam, mensajes automáticos o mensajería masiva".
- La captura del aviso confirmaba la restricción.
- No es un error de código ni del localhost: es el uso de una librería no oficial.

## Cuenta / datos de Meta
- Correo: casaselectapy@gmail.com
- Cuenta comercial: "Casa Selecta" (ID 1426958216155462)
- App creada: WhatsBotAPI (caso de uso: "Conectarte con los clientes a través de WhatsApp")
- Negocio: Casa Selecta (sin verificar todavía)

## Decisiones pendientes
- NÚMERO: falta decidir. El número actual del bot (595 984 982 315, perfil "Armando")
  está registrado en el WhatsApp normal. Para usarlo en la API oficial hay que
  QUITARLO del WhatsApp normal (irreversible), o usar un número nuevo (recomendado).
- Verificación del negocio: pendiente, no urgente para probar.

## Archivos del backend nuevo (ya creados y funcionando)
- `server-meta.js`  → backend con la Graph API de Meta (texto, foto, audio, webhook, bot API, programados)
- `meta-config.json` → donde van token + phoneNumberId + wabaId + verifyToken
- `package.json`    → agregado script `npm run meta`

## Cómo arrancar el backend nuevo
```bash
cd /Users/brunopenayo/AccioWork/2026-08-21-17-17-46-607-83d4d9d9/whatsapp-bot
npm run meta
```

## Túnel (URL pública temporal para el webhook)
- Herramienta: cloudflared (descargado en /tmp/cloudflared)
- URL actual: https://harbor-maria-printable-talks.trycloudflare.com
- ⚠️ Esta URL es TEMPORAL y cambia al reiniciar el túnel.
- Webhook endpoint: https://harbor-maria-printable-talks.trycloudflare.com/webhook
- Token de verificación: whatsbot-verify-token-2026

Para arrancar el túnel de nuevo:
```bash
/tmp/cloudflared tunnel --url http://localhost:3000
```

## Datos que faltan de Meta (para completar meta-config.json)
- "token" (Access Token) — lo da el Paso 1 (número de prueba) o el panel de la app
- "phoneNumberId" — ID del número de WhatsApp Business
- "wabaId" — ID de la cuenta de WhatsApp Business
- "displayNumber" — el número en formato con país (ej 595984982315)

## Formato de meta-config.json (plantilla)
```json
{
  "token": "EAAG...",
  "phoneNumberId": "123456789012345",
  "wabaId": "987654321098765",
  "verifyToken": "whatsbot-verify-token-2026",
  "displayNumber": "595984982315"
}
```

## Endpoints del backend nuevo (mismo contrato que el panel)
- GET  /api/status
- GET  /api/events  (SSE)
- GET  /api/conversations
- GET  /api/messages?jid=
- POST /api/send
- POST /api/send-media
- GET/POST /api/bot
- GET/POST /api/settings
- GET/POST/DELETE /api/schedules
- GET/POST /webhook  (recibir mensajes de Meta)

## Guía completa de configuración de Meta
Ver: /Users/brunopenayo/AccioWork/2026-08-22-21-41-52-288-a4260300/guia-whatsapp-meta-api.md

## Precios (resumen)
- Mensajes normales respondiendo dentro de 24 h: GRATIS
- Plantillas de marketing: se cobran (por mensaje, varía por país)
- Plantillas utilidad/autenticación fuera de ventana: se cobran con descuento por volumen
- Tarifas por país: https://business.whatsapp.com/products/platform-pricing

## Próximos pasos
1. Terminar el Paso 1 (número de prueba) en el panel de Meta → obtener token + phoneNumberId
2. Completar meta-config.json con esos datos
3. Reiniciar el backend nuevo (npm run meta)
4. Probar envío de mensaje desde el panel de Meta al número de prueba
5. Decidir número real (mismo vs nuevo) → Paso 2 de Meta
6. Para producción estable: cambiar el túnel temporal por una URL fija (dominio/HTTPS)
