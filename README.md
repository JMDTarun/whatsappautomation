# WhatsApp Automation & API

This project provides a robust solution for automating WhatsApp using Node.js and `@whiskeysockets/baileys`. 
It allows you to deploy the server directly, authenticate remotely via an API endpoint that serves the QR code, handle incoming messages (auto-reply), and send outbound messages via an API.

**This version supports MULTIPLE concurrent WhatsApp accounts (Multi-Session).** You can run as many bots on the same server as you want.

## 1. Setup & Deployment

1. Upload the project files to your server.
2. Install the dependencies on the server:
   ```bash
   npm install
   ```
3. Start the server:
   ```bash
   node server.js
   ```
4. The server will start and listen on port `3000`. By default, it will automatically spin up a session called `default`.

## 2. Remote Authentication & Multi-Account Support

The server exposes an API to manage multiple WhatsApp accounts.

1. **Start a new session**: 
   To add a new WhatsApp number, send a POST request to initialize a new bot session:
   ```bash
   curl -X POST http://localhost:3000/api/session \
   -H "Content-Type: application/json" \
   -d '{"sessionId": "number2"}'
   ```
2. **Scan the QR Code**:
   Go to your browser and fetch the QR code for that specific session:
   `http://<YOUR_SERVER_IP>:3000/api/qr/number2`
3. Scan it with your phone! You can repeat this process for `number3`, `number4`, etc.
4. **View Active Sessions**:
   You can check the connection status of all your bots by visiting:
   `http://<YOUR_SERVER_IP>:3000/api/sessions`

*Note: The server forces an automatic re-login every 30 days to ensure session stability. You will need to re-scan the QR codes when this happens.*

## 3. Usage

### Auto-Reply
The `server.js` script is pre-configured to listen for incoming messages.
- If a user sends a message containing "Hello! Can I get more info on this?", it replies automatically.
- The interaction is logged to MongoDB with the specific `sessionId` of the bot that received the message.

### Send Message API
You can send messages programmatically. You must specify which `sessionId` should send the message.

**Endpoint:** `POST http://<YOUR_SERVER_IP>:3000/api/send`

**Body (JSON):**
```json
{
  "sessionId": "number2",
  "number": "1234567890",
  "message": "Hello from the API!"
}
```
*(If you omit `sessionId`, it falls back to the `default` session).*

## 4. Docker, Render & MongoDB Setup

This project uses **MongoDB** to permanently save session data. This is CRITICAL if you are using Render free-tier, because Render frequently wipes the local filesystem.

**Environment Variables Required:**
- `MONGODB_URI`: Your MongoDB connection string.
- `ADMIN_NUMBER`: The WhatsApp number (e.g. `919876543210@s.whatsapp.net`) authorized to request Excel reports via WhatsApp commands.

## 5. Excel Reports & Keyword Tracking

Every time a user triggers an auto-reply, it is logged to MongoDB.

### Via WhatsApp Command
From your `ADMIN_NUMBER` phone, send the following message to any of your running bots:
- `!report` - Generates and sends an Excel file for today's interactions for THAT specific bot (`sessionId`).
- `!report 2026-07-19` - Generates report for a specific date.
- `!report 2026-07-01 to 2026-07-15` - Generates report for a date range.

### Via API Endpoint
You can download the report directly from your browser. You can optionally filter by `sessionId`.
- `GET http://<YOUR_SERVER_IP>:3000/api/report` (All sessions, today)
- `GET http://<YOUR_SERVER_IP>:3000/api/report?sessionId=number2&date=2026-07-19` (Specific session, specific date)
- `GET http://<YOUR_SERVER_IP>:3000/api/report?startDate=2026-07-01&endDate=2026-07-15` (Date range)

# kLMhAu4ML6mHnqK2 mongodb+srv://developertarun_db_user:kLMhAu4ML6mHnqK2@tbedi.abddfya.mongodb.net/
## mongodb+srv://developertarun_db_user:kLMhAu4ML6mHnqK2@tbedi.abddfya.mongodb.net/?appName=tbedi
## mongodb+srv://developertarun_db_user:<db_password>@tbedi.abddfya.mongodb.net/?appName=tbedi