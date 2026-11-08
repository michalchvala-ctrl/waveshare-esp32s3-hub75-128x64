# LED Panel Hub (LAN)

Multi-user hub for Waveshare ESP32-S3 + 128×64 panels. Runs on your LAN 24/7 box. Internet/Nginx later — not required for MVP.

## Quick start

```bash
cd hub
npm install
npm run dev
```

Open http://localhost:3000  
Login: **admin / admin** (change ASAP)

Seeded panel: `192.168.1.52` with token `ledpanel-dev-token` (must match panel `API_TOKEN`).

## Features (MVP)

- Admin / user accounts (JWT cookie)
- Panel registry
- Reserved **notify strip** (default 16px) — admin can notify one panel or all
- **Layout editor** at `/editor?panel=1` — drag widgets (text/clock/date/temp/humidity/weather) below the strip; Save + push to panel
- Hub pushes to panels with `Authorization: Bearer <token>`

## Next

- Pixel brush
- Live SHTC3 temp/humidity + weather API
- Notification sounds / Gmail
- Nginx HTTPS when exposing beyond LAN
