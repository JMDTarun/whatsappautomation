import 'dotenv/config';
import express from 'express';
import { makeWASocket, useMultiFileAuthState } from '@whiskeysockets/baileys';
import pino from 'pino';
import QRCode from 'qrcode';
import fs from 'fs';
import { MongoClient } from 'mongodb';
import useMongoDBAuthState from './useMongoDBAuthState.js';
import ExcelJS from 'exceljs';

const app = express();
app.use(express.json());

// Global state for multiple sessions
const sessions = new Map();
const qrs = new Map();
const connectionStatus = new Map();
const processedMessages = new Set(); // Prevent double replies
const sessionAutoReplies = new Map(); // Store dynamic replies per session

// Global variables for MongoDB
let mongoClient = null;
let authCollection = null;
let logsCollection = null;

const ADMIN_NUMBER = process.env.ADMIN_NUMBER;

async function generateExcelReport(sessionId, startDateString, endDateString) {
    if (!logsCollection) {
        throw new Error('Database is not connected. Reports are only available when using MongoDB.');
    }

    let query = {};

    // Filter by sessionId if provided
    if (sessionId) {
        query.sessionId = sessionId;
    }

    if (startDateString && endDateString) {
        query.dateString = {
            $gte: startDateString,
            $lte: endDateString
        };
    } else if (startDateString) {
        query.dateString = startDateString;
    } else {
        const today = new Date().toISOString().split('T')[0];
        query.dateString = today;
        startDateString = today;
    }

    const records = await logsCollection.find(query).toArray();

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Keyword Matches');

    worksheet.columns = [
        { header: 'Session ID', key: 'sessionId', width: 20 },
        { header: 'Date & Time', key: 'timestamp', width: 25 },
        { header: 'Phone Number', key: 'number', width: 20 },
        { header: 'Matched Keyword', key: 'keyword', width: 20 },
        { header: 'Message', key: 'message', width: 50 },
    ];

    records.forEach(record => {
        const plainNumber = record.number ? record.number.split('@')[0] : '';
        worksheet.addRow({
            sessionId: record.sessionId || 'default',
            timestamp: new Date(record.timestamp).toLocaleString(),
            number: plainNumber,
            keyword: record.keywordMatched,
            message: record.message
        });
    });

    return { buffer: await workbook.xlsx.writeBuffer(), count: records.length };
}

async function startWhatsApp(sessionId = 'default') {
    console.log(`Starting WhatsApp connection for session: ${sessionId}...`);

    let state, saveCreds;
    const mongoUri = process.env.MONGODB_URI;

    if (mongoUri) {
        try {
            if (!mongoClient) {
                mongoClient = new MongoClient(mongoUri);
                await mongoClient.connect();
                const db = mongoClient.db('whatsapp_bot');
                authCollection = db.collection('auth_session');
                logsCollection = db.collection('keyword_logs');
            }

            // Check if session is older than 30 days
            const metadataId = `session_metadata_${sessionId}`;
            const metadata = await authCollection.findOne({ _id: metadataId });
            const now = Date.now();
            if (metadata && metadata.createdAt) {
                const daysOld = (now - metadata.createdAt) / (1000 * 60 * 60 * 24);
                if (daysOld >= 30) {
                    console.log(`Session ${sessionId} is ${daysOld.toFixed(1)} days old (limit: 30 days). Forcing re-login...`);
                    // Delete keys for THIS session only
                    await authCollection.deleteMany({ _id: { $regex: new RegExp(`^${sessionId}-`) } });
                }
            }

            // If session was just cleared or is new, save the creation date
            const checkMetadata = await authCollection.findOne({ _id: metadataId });
            if (!checkMetadata) {
                await authCollection.updateOne({ _id: metadataId }, { $set: { createdAt: now } }, { upsert: true });
            }

            // Fetch any custom auto-reply message for this session
            const currentMetadata = await authCollection.findOne({ _id: metadataId });
            if (currentMetadata && currentMetadata.autoReplyMessage) {
                sessionAutoReplies.set(sessionId, currentMetadata.autoReplyMessage);
            }

            const mongoAuth = await useMongoDBAuthState(authCollection, sessionId);
            state = mongoAuth.state;
            saveCreds = mongoAuth.saveCreds;
        } catch (error) {
            console.error('Failed to connect to MongoDB:', error);
            return;
        }
    } else {
        const localAuth = await useMultiFileAuthState(`auth_info_${sessionId}`);
        state = localAuth.state;
        saveCreds = localAuth.saveCreds;
    }

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: true,
        logger: pino({ level: 'silent' }),
    });

    sessions.set(sessionId, sock);
    connectionStatus.set(sessionId, 'initializing');

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log(`New QR code for session ${sessionId}. Available at GET /api/qr/${sessionId}`);
            qrs.set(sessionId, qr);
            connectionStatus.set(sessionId, 'qr_ready');
        }

        if (connection === 'close') {
            connectionStatus.set(sessionId, 'disconnected');
            const shouldReconnect = (lastDisconnect.error)?.output?.statusCode !== 401;
            console.log(`Connection closed for session ${sessionId}. Reconnecting: ${shouldReconnect}`);

            if (shouldReconnect) {
                startWhatsApp(sessionId);
            } else {
                console.log(`Logged out from session ${sessionId}. Deleting old session...`);

                if (mongoUri && authCollection) {
                    await authCollection.deleteMany({ _id: { $regex: new RegExp(`^${sessionId}-`) } });
                } else {
                    try {
                        fs.rmSync(`auth_info_${sessionId}`, { recursive: true, force: true });
                    } catch (e) { }
                }
                startWhatsApp(sessionId);
            }
        } else if (connection === 'open') {
            console.log(`✅ Connected to WhatsApp (Session: ${sessionId})!`);
            connectionStatus.set(sessionId, 'connected');
            qrs.delete(sessionId);
        }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;

        for (const msg of messages) {
            if (!msg.message) continue;

            // Prevent double processing of the same message (common Baileys issue)
            const msgId = `${sessionId}-${msg.key.id}`;
            if (processedMessages.has(msgId)) continue;
            processedMessages.add(msgId);
            if (processedMessages.size > 10000) processedMessages.clear();

            const fromMe = msg.key.fromMe;
            const textMessage = msg.message.conversation || msg.message.extendedTextMessage?.text || "";

            if (!textMessage) continue;
            const textLower = textMessage.toLowerCase();
            const remoteJid = msg.key.remoteJid;

            const myJid = sock.user.id.replace(/:.*@/, '@');
            const isMessageToMyself = (remoteJid === myJid);

            if (fromMe && !textLower.startsWith('!') && !isMessageToMyself) continue;

            const effectiveJid = fromMe ? (ADMIN_NUMBER || myJid) : (msg.key.remoteJidAlt || remoteJid);

            // Admin commands
            if (ADMIN_NUMBER && (effectiveJid === ADMIN_NUMBER || remoteJid === ADMIN_NUMBER) && (textLower.startsWith('!report') || textLower.startsWith('!range'))) {
                let startDate = null;
                let endDate = null;

                const commandArgs = textLower.replace('!report', '').replace('!range', '').trim();
                if (commandArgs) {
                    if (commandArgs.includes(' to ')) {
                        const dates = commandArgs.split(' to ');
                        startDate = dates[0].trim();
                        endDate = dates[1].trim();
                    } else if (commandArgs.includes(':')) {
                        const dates = commandArgs.split(':');
                        startDate = dates[0].trim();
                        endDate = dates[1].trim();
                    } else {
                        startDate = commandArgs;
                    }
                }

                try {
                    const rangeText = endDate ? `${startDate} to ${endDate}` : (startDate || 'today');
                    console.log(`Generating report for admin on session ${sessionId}: ${rangeText}`);
                    await sock.sendMessage(remoteJid, { text: `Generating Excel report for session ${sessionId} (${rangeText})...` });

                    const { buffer, count } = await generateExcelReport(sessionId, startDate, endDate);

                    if (count === 0) {
                        await sock.sendMessage(remoteJid, { text: `No keyword matches found for session ${sessionId}: ${rangeText}` });
                        continue;
                    }

                    const fileNameDate = endDate ? `${startDate}_to_${endDate}` : (startDate || new Date().toISOString().split('T')[0]);

                    await sock.sendMessage(remoteJid, {
                        document: buffer,
                        mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                        fileName: `Report_${sessionId}_${fileNameDate}.xlsx`,
                        caption: `Keyword report for session ${sessionId} (${rangeText}). Total matches: ${count}`
                    });
                } catch (error) {
                    console.error('Error generating report:', error);
                    await sock.sendMessage(remoteJid, { text: 'Sorry, failed to generate the report.' });
                }

                continue;
            }

            if (fromMe && !isMessageToMyself) continue;

            console.log(`[${sessionId}] Received message from ${effectiveJid}: ${textMessage}`);

            let matchedKeyword = null;

            if (textLower.includes('hello! can i get more info on this?')) {
                matchedKeyword = 'Hello! Can I get more info on this?';
                console.log(`[${sessionId}] Sending auto-reply to ${remoteJid}...`);
                
                const pushName = msg.pushName || 'Sir/Madam';
                const defaultMsg = 'Hello {{name}}, Raghav this side. Which size are you looking for?';
                let replyText = sessionAutoReplies.get(sessionId) || process.env.AUTO_REPLY_MESSAGE || defaultMsg;
                replyText = replyText.replace(/{{name}}/g, pushName);
                
                await sock.sendMessage(remoteJid, { text: replyText });
            }

            if (matchedKeyword && logsCollection) {
                const now = new Date();
                const dateString = now.toISOString().split('T')[0];

                await logsCollection.insertOne({
                    sessionId: sessionId,
                    number: effectiveJid,
                    message: textMessage,
                    keywordMatched: matchedKeyword,
                    timestamp: now,
                    dateString: dateString
                });
            }
        }
    });
}

// API: Initialize a new session
app.post('/api/session', (req, res) => {
    const { sessionId } = req.body;
    if (!sessionId) {
        return res.status(400).json({ error: 'sessionId is required' });
    }

    if (sessions.has(sessionId)) {
        return res.status(400).json({ error: 'Session already exists' });
    }

    startWhatsApp(sessionId);
    res.json({ success: true, message: `Session ${sessionId} started. Get QR at /api/qr/${sessionId}` });
});

// API: Update auto-reply message for a specific session
app.post('/api/session/message', async (req, res) => {
    const { sessionId, message } = req.body;
    if (!sessionId || !message) {
        return res.status(400).json({ error: 'sessionId and message are required' });
    }

    sessionAutoReplies.set(sessionId, message);

    if (authCollection) {
        await authCollection.updateOne(
            { _id: `session_metadata_${sessionId}` },
            { $set: { autoReplyMessage: message } },
            { upsert: true }
        );
    }

    res.json({ success: true, message: `Auto reply message updated for session ${sessionId}` });
});

// API: Get active sessions
app.get('/api/sessions', (req, res) => {
    const result = {};
    for (const [id, status] of connectionStatus.entries()) {
        result[id] = status;
    }
    res.json({ sessions: result });
});

// API: Get QR code for a session
app.get('/api/qr/:sessionId', async (req, res) => {
    const { sessionId } = req.params;
    const status = connectionStatus.get(sessionId);

    if (!status) {
        return res.status(404).send('<h2>Session not found. Create it via POST /api/session</h2>');
    }
    if (status === 'connected') {
        return res.send(`<h2>Session ${sessionId} is already connected!</h2>`);
    }

    const currentQR = qrs.get(sessionId);
    if (!currentQR) {
        return res.send('<h2>QR code is not ready yet. Please refresh the page in a few seconds.</h2>');
    }

    try {
        const qrImage = await QRCode.toDataURL(currentQR);
        res.send(`
            <html>
                <head><title>Scan WhatsApp QR</title></head>
                <body style="display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; font-family: sans-serif;">
                    <h2>Scan this QR code for session: ${sessionId}</h2>
                    <img src="${qrImage}" alt="QR Code" style="width: 300px; height: 300px; border: 2px solid #ccc; border-radius: 10px; padding: 10px;" />
                    <p>The code refreshes automatically. If it doesn't work, refresh this page.</p>
                </body>
            </html>
        `);
    } catch (err) {
        res.status(500).send('Error generating QR code image');
    }
});

// Fallback old QR endpoint (for backward compatibility)
app.get('/api/qr', (req, res) => {
    res.redirect('/api/qr/default');
});

// API: Download Excel report
app.get('/api/report', async (req, res) => {
    try {
        const sessionId = req.query.sessionId || null; // Optional
        const startDate = req.query.startDate || req.query.date || null;
        const endDate = req.query.endDate || null;

        const { buffer, count } = await generateExcelReport(sessionId, startDate, endDate);

        const fileNameDate = endDate ? `${startDate}_to_${endDate}` : (startDate || new Date().toISOString().split('T')[0]);
        const prefix = sessionId ? `${sessionId}_` : 'All_';

        res.setHeader('Content-Disposition', `attachment; filename="Report_${prefix}${fileNameDate}.xlsx"`);
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.send(buffer);
    } catch (error) {
        console.error('Error in API report:', error);
        res.status(500).json({ error: error.message || 'Failed to generate report.' });
    }
});

// API: Send message
app.post('/api/send', async (req, res) => {
    try {
        const { sessionId = 'default', number, message } = req.body;

        if (!number || !message) {
            return res.status(400).json({ error: 'Please provide "number" and "message".' });
        }

        const sock = sessions.get(sessionId);
        if (!sock || connectionStatus.get(sessionId) !== 'connected') {
            return res.status(500).json({ error: `Session ${sessionId} is not connected.` });
        }

        const jid = number.includes('@s.whatsapp.net') ? number : `${number.replace(/\D/g, '')}@s.whatsapp.net`;

        await sock.sendMessage(jid, { text: message });

        console.log(`[${sessionId}] Message sent to ${jid} via API`);
        res.status(200).json({ success: true, message: 'Message sent successfully.' });
    } catch (error) {
        console.error('Error sending message via API:', error);
        res.status(500).json({ error: 'Failed to send message.' });
    }
});

async function startupAutoConnect() {
    console.log('Checking for existing sessions to auto-connect...');
    const mongoUri = process.env.MONGODB_URI;
    const sessionIds = new Set(['default']); // Always try default as fallback

    if (mongoUri) {
        try {
            if (!mongoClient) {
                mongoClient = new MongoClient(mongoUri);
                await mongoClient.connect();
                const db = mongoClient.db('whatsapp_bot');
                authCollection = db.collection('auth_session');
                logsCollection = db.collection('keyword_logs');
            }

            const metadataDocs = await authCollection.find({ _id: { $regex: /^session_metadata_/ } }).toArray();
            for (const doc of metadataDocs) {
                const id = doc._id.replace('session_metadata_', '');
                if (id) sessionIds.add(id);
            }
        } catch (error) {
            console.error('Failed to auto-connect via MongoDB:', error);
        }
    } else {
        try {
            const files = fs.readdirSync('./');
            for (const file of files) {
                if (file.startsWith('auth_info_')) {
                    const id = file.replace('auth_info_', '');
                    if (id) sessionIds.add(id);
                }
            }
        } catch (error) {
            console.error('Failed to auto-connect via local files:', error);
        }
    }

    console.log(`Found ${sessionIds.size} session(s) to connect: ${Array.from(sessionIds).join(', ')}`);
    for (const sessionId of sessionIds) {
        startWhatsApp(sessionId);
    }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
    console.log(`Server API is running on http://localhost:${PORT}`);
    await startupAutoConnect();
});
