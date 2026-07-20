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

## 2. API Reference (cURL Commands)

The server exposes a REST API to manage your WhatsApp accounts, send messages, and configure dynamic settings.

### 1. Start a New WhatsApp Session
Initialize a new bot session (e.g., for a new phone number).
```bash
curl -X POST http://localhost:3000/api/session \
-H "Content-Type: application/json" \
-d '{"sessionId": "number2"}'
```

### 2. Get QR Code for a Session
After starting a session, fetch the QR code in your browser or via cURL and scan it with your phone.
```bash
curl -X GET http://localhost:3000/api/qr/number2
```

### 3. View All Active Sessions
Check the connection status of all your running bots.
```bash
curl -X GET http://localhost:3000/api/sessions
```

### 4. Remove a Session
Permanently log out a bot and delete its encryption keys from the database.
```bash
curl -X DELETE http://localhost:3000/api/session/number2
```

### 5. Set Dynamic Auto-Reply Message (Per-Session)
Configure a unique auto-reply message for a specific bot session. Use `{{name}}` to dynamically insert the user's WhatsApp name.
```bash
curl -X POST http://localhost:3000/api/session/message \
-H "Content-Type: application/json" \
-d '{
  "sessionId": "number2", 
  "message": "Hello {{name}}, welcome to our VIP support! How can we assist you today?"
}'
```

### 6. Set Custom Logout Time (Per-Session)
Configure how many days a session should stay logged in before forcefully requiring a new QR code (defaults to 30 days).
```bash
curl -X POST http://localhost:3000/api/session/logout-time \
-H "Content-Type: application/json" \
-d '{
  "sessionId": "number2", 
  "days": 45
}'
```

### 7. Send an Outbound Message
Send a message programmatically from a specific bot to any phone number.
```bash
curl -X POST http://localhost:3000/api/send \
-H "Content-Type: application/json" \
-d '{
  "sessionId": "number2",
  "number": "919876543210",
  "message": "Hello from the API!"
}'
```
*(If you omit `sessionId`, it defaults to the `default` session).*

### 8. Keep Server Alive (Ping)
Use this endpoint with services like UptimeRobot to prevent your free Render server from sleeping.
```bash
curl -X GET http://localhost:3000/ping
```

*Note: The server forces an automatic re-login every 30 days to ensure session stability. You will need to re-scan the QR codes when this happens.*

## 3. Auto-Reply Usage

The `server.js` script automatically listens for incoming messages.
- If a user sends a message containing "Hello! Can I get more info on this?", it replies automatically using the message configured via the API (or `.env`).
- The interaction is logged to MongoDB with the specific `sessionId` of the bot that received the message.

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

## 6. Admin Commands for Societies

From your `ADMIN_NUMBER` phone, you can manage the societies, their options, and media directly via WhatsApp by sending commands to the bot.

### Add a Society (`!addsociety`)
Send `!addsociety` to the bot to start the interactive setup flow:
1. The bot will ask for the **society name**.
2. The bot will ask you to upload a **Brochure PDF** (or type `skip`).
3. The bot will ask for an **option name and price** (e.g., `2BHK - 50 Lac`).
4. The bot will ask you to send all **images and videos** for that specific option. Wait for the success confirmation for each file.
5. Type `done` when finished uploading media for that option.
6. The bot will ask for the next option. Repeat, or type `done` again to finish and save the entire society.

### Delete a Society (`!delsociety`)
Send `!delsociety <Society Name>` to permanently delete a society from the database.
Example: `!delsociety Verona Heights`

### List Societies (`!listsocieties`)
Send `!listsocieties` to see a text list of all currently saved societies in your database.

### Cancel Operation (`cancel`)
At any point during the `!addsociety` setup flow, you can type `cancel` to immediately abort the process.

# kLMhAu4ML6mHnqK2 mongodb+srv://developertarun_db_user:kLMhAu4ML6mHnqK2@tbedi.abddfya.mongodb.net/
## mongodb+srv://developertarun_db_user:kLMhAu4ML6mHnqK2@tbedi.abddfya.mongodb.net/?appName=tbedi
## mongodb+srv://developertarun_db_user:<db_password>@tbedi.abddfya.mongodb.net/?appName=tbedi