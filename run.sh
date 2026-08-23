#!/bin/bash
# Supervisor: mantiene el bot de WhatsApp corriendo.
# Si el proceso sale (p.ej. por el watchdog), lo reinicia limpio.
cd "$(dirname "$0")"
while true; do
  PORT=3001 node server.js >> app.log 2>&1
  code=$?
  echo "[$(date '+%H:%M:%S')] server salió con código $code — reiniciando en 3s…" >> app.log
  sleep 3
done
