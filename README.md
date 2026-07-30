# WhatsApp Automation & API Platform

A robust, enterprise-grade multi-session WhatsApp automation service built with Node.js, Express, `@whiskeysockets/baileys`, and `baileys-antiban`. 

It enables remote authentication via QR codes, intelligent auto-reply handling, scheduled outbound message queueing, admin society management, and session-isolated Excel reporting—optimized for hosted cloud environments like **Render**, **Heroku**, and **Docker**.

---

## Key Features

- **Multi-Session Architecture**: Run multiple independent WhatsApp accounts concurrently on a single server.
- **Self-Healing Connection Engine**: 
  - **25-Second Keep-Alive Heartbeat**: Prevents cloud proxies (Render/AWS) from terminating idle TCP sockets.
  - **Background Watchdog**: Audits socket health every 60 seconds to detect and revive silent/zombie connections.
  - **Automatic Stale Credential Reset**: Detects unlinked/invalid credentials after 3 consecutive `405/440 Connection Replaced` conflicts, automatically clearing stale MongoDB keys for clean QR code regeneration.
  - **Single-Instance Session Locks**: Eliminates race conditions and duplicate connection collisions.
- **Privacy-First Presence Management**:
  - Accounts stay **Offline** by default (`markOnlineOnConnect: false`).
  - Automatically switches to **Online** and **Typing** (`composing`) strictly while preparing and sending an auto-reply, then immediately returns **Offline** (`unavailable`).
- **Session-Isolated Excel Reporting**: Generate detailed keyword match reports filtered strictly for a specific requested session.
- **MongoDB Auth Persistence**: Authentication tokens, pre-keys, and active lists are stored in MongoDB, ensuring zero state loss during container redeployments.
- **Anti-Ban Safe Guarding**: Built-in human typing delays, rate limiters, circadian variations, and circuit breakers via `baileys-antiban`.

---

## 1. Setup & Environment Configuration

### Prerequisites
- Node.js (v18+ recommended)
- MongoDB Database (Atlas or local instance)

### Environment Variables (`.env`)
Create a `.env` file in the root directory:

```env
PORT=3000
MONGODB_URI=mongodb+srv://<username>:<password>@cluster.mongodb.net/whatsapp_bot
ADMIN_NUMBER=919876543210@s.whatsapp.net
AUTO_REPLY_MESSAGE="Hello Sir/Mam, Raghav this side. Which size are you looking for?"
RENDER_EXTERNAL_URL=https://your-app.onrender.com
```

### Installation & Launch

```bash
# Install dependencies
npm install

# Check file syntax
node --check server.js

# Start server
node server.js
```

---

## 2. API Reference & cURL Commands

### 1. View Interactive QR Code Page (Browser Friendly)
Open in any web browser to view a self-refreshing QR code scanning interface:
```http
GET http://localhost:3000/api/qr-page/:sessionId
```
*Example:* `https://your-app.onrender.com/api/qr-page/919891691510`

---

### 2. Fetch QR Code Image
Returns the QR code as a PNG image stream:
```bash
curl -X GET "http://localhost:3000/api/qr/919891691510" --output qr.png
```
*Force Fresh QR Code Generation:*
```bash
curl -X GET "http://localhost:3000/api/qr/919891691510?reset=true" --output qr.png
```

---

### 3. Initialize a Session
Spin up a new or existing session instance:
```bash
curl -X POST http://localhost:3000/api/session \
  -H "Content-Type: application/json" \
  -d '{"sessionId": "919891691510"}'
```

---

### 4. Reset Session & Clear Stale Auth Credentials
Wipes old or unlinked session keys from MongoDB/disk and starts a fresh instance for new QR scan:
```bash
curl -X POST http://localhost:3000/api/session/reset \
  -H "Content-Type: application/json" \
  -d '{"sessionId": "919891691510"}'
```
*Or via DELETE:*
```bash
curl -X DELETE http://localhost:3000/api/session/919891691510
```

---

### 5. Check Session Connection Status
Returns `connected`, `qr_ready`, `initializing`, `disconnected`, or `logged_out`:
```bash
curl -X GET http://localhost:3000/api/status/919891691510
```

---

### 6. Configure Auto-Reply Message (Per-Session)
Set a custom auto-reply string for a specific bot session. Supports `{{name}}` template tags:
```bash
curl -X POST http://localhost:3000/api/session/message \
  -H "Content-Type: application/json" \
  -d '{
    "sessionId": "919891691510",
    "message": "Hello {{name}}, Raghav this side. Which apartment layout are you looking for?"
  }'
```

---

### 7. Get Configured Auto-Reply Message
```bash
curl -X GET http://localhost:3000/api/autoreply/919891691510
```

---

### 8. Send Outbound Programmatic Message
Queue a message to any recipient JID / phone number:
```bash
curl -X POST http://localhost:3000/api/send \
  -H "Content-Type: application/json" \
  -d '{
    "sessionId": "919891691510",
    "number": "919876543210",
    "message": "Hello from the API!"
  }'
```

---

### 9. Download Excel Reports
Download session-isolated Excel keyword reports directly:
```bash
# Download today's report for a specific session
curl -X GET "http://localhost:3000/api/report?sessionId=919891691510" --output report.xlsx

# Download date range report for a specific session
curl -X GET "http://localhost:3000/api/report?sessionId=919891691510&startDate=2026-07-01&endDate=2026-07-30" --output report.xlsx

# Download today's report across ALL sessions
curl -X GET "http://localhost:3000/api/report?sessionId=all" --output report.xlsx
```

---

### 10. Server Keep-Alive & Health Ping
Endpoints for UptimeRobot, Render, or self-ping monitors:
```bash
curl -X GET http://localhost:3000/ping
```

---

## 3. WhatsApp Admin Commands

From the authorized `ADMIN_NUMBER` phone, send commands directly to any running WhatsApp bot:

| Command | Description | Example |
| :--- | :--- | :--- |
| `!report` | Generates and sends an Excel report for today for THAT specific session | `!report` |
| `!report YYYY-MM-DD` | Generates report for a specific date | `!report 2026-07-30` |
| `!report START to END` | Generates report for a date range | `!report 2026-07-01 to 2026-07-30` |
| `!addsociety` | Starts interactive setup flow to add a society, brochure PDF, options & media | `!addsociety` |
| `!delsociety <Name>` | Deletes a society from MongoDB | `!delsociety Verona Heights` |
| `!listsocieties` | Lists all saved societies in database | `!listsocieties` |
| `cancel` | Aborts an ongoing `!addsociety` flow | `cancel` |

---

## 4. Architecture & Self-Healing Reliability

### Connection Reliability
- **Render Keep-Alive**: Automatically self-pings `/ping` every 10 minutes when `RENDER_EXTERNAL_URL` is set.
- **WebSocket Keep-Alive**: Configured with `keepAliveIntervalMs: 25000` so cloud proxy routers do not drop silent TCP connections.
- **Watchdog Interval**: Runs every 60 seconds to detect closed WebSocket handles (`readyState !== 1`) and automatically revive them.
- **Race Condition Prevention**: `connectingSessions` lock set and `reconnectTimers` map prevent Watchdog and exponential backoff timeouts from colliding.
- **Stale Auth Recovery**: After 3 consecutive `405/440` stream replaced errors, the app wipes stale MongoDB session keys, preventing infinite login loops.

### Presence & Privacy Design
- **Offline By Default**: `markOnlineOnConnect: false` avoids showing account Online 24/7.
- **Transient Online Status**: Presence flips to `available` and `composing` strictly during auto-reply dispatch, and immediately resets to `unavailable` (Offline) upon delivery.

---

## 5. Project Directory Structure

```
whatsappautomation/
├── server.js                   # Express server entry point & background queue poller
├── useMongoDBAuthState.js      # MongoDB auth state adapter for Baileys
├── src/
│   ├── config/
│   │   ├── db.js               # MongoDB connection & collection getters
│   │   └── antibanConfig.js    # AntiBan and CircuitBreaker instances
│   ├── handlers/
│   │   ├── adminHandler.js     # WhatsApp admin commands & society wizard
│   │   └── messageHandler.js   # Incoming WhatsApp message router & auto-reply
│   ├── routes/
│   │   └── apiRoutes.js        # Express API endpoints for QR, sessions, reports
│   ├── services/
│   │   ├── antibanService.js   # Human presence & outbound message dispatch
│   │   ├── queueService.js     # MongoDB outbound queue poller & night hours
│   │   └── whatsappService.js  # Baileys socket manager, Watchdog & auto-reconnect
│   └── utils/
│       ├── contentVariator.js  # Text anti-ban variation helper
│       ├── mediaUtils.js       # Cloud media uploader (Telegra.ph / PixelDrain)
│       ├── phoneUtils.js       # Phone number canonicalization & DB queries
│       ├── reportGenerator.js  # Excel report generator (ExcelJS)
│       └── timeUtils.js        # IST timezone & night hours logic
└── README.md
```