import 'dotenv/config';
import express from 'express';
import { makeWASocket, useMultiFileAuthState, downloadMediaMessage, decryptPollVote, getAggregateVotesInPollMessage } from '@whiskeysockets/baileys';
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
let societiesCollection = null;

const adminState = new Map(); // Maps remoteJid to state object
const pollCache = new Map(); // Store poll creation messages for decryption
const pollTimers = new Map(); // Store timeouts for poll responses

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
        { header: 'Society', key: 'societyName', width: 30 },
        { header: 'Selected Options', key: 'selectedOptions', width: 50 },
    ];

    records.forEach(record => {
        const plainNumber = record.number ? record.number.split('@')[0] : '';
        worksheet.addRow({
            sessionId: record.sessionId || 'default',
            timestamp: new Date(record.timestamp).toLocaleString(),
            number: plainNumber,
            societyName: record.societyName || 'N/A',
            selectedOptions: record.selectedOptions || 'None'
        });
    });

    return { buffer: await workbook.xlsx.writeBuffer(), count: records.length };
}

async function uploadToCatbox(buffer, mimetype, filename) {
    const blob = new Blob([buffer], { type: mimetype });
    const formData = new FormData();
    formData.append('reqtype', 'fileupload');
    formData.append('fileToUpload', blob, filename);
    const response = await fetch('https://catbox.moe/user/api.php', {
        method: 'POST',
        body: formData
    });
    if (!response.ok) {
        throw new Error(`Catbox upload failed: ${response.statusText}`);
    }
    return await response.text();
}

async function startWhatsApp(sessionId = 'default') {
    console.log(`Starting WhatsApp connection for session: ${sessionId}...`);

    let state, saveCreds;
    const mongoUri = process.env.MONGODB_URI;

    if (mongoUri) {
        try {
            if (!authCollection) {
                if (!mongoClient) mongoClient = new MongoClient(mongoUri);
                await mongoClient.connect();
                const db = mongoClient.db('whatsapp_bot');
                authCollection = db.collection('auth_session');
                logsCollection = db.collection('keyword_logs');
                societiesCollection = db.collection('societies');
            }

            // Check if session is older than the configured limit
            const metadataId = `session_metadata_${sessionId}`;
            const metadata = await authCollection.findOne({ _id: metadataId });
            const now = Date.now();
            if (metadata && metadata.createdAt) {
                const limitDays = metadata.logoutDays || 30; // Default to 30 days
                const daysOld = (now - metadata.createdAt) / (1000 * 60 * 60 * 24);
                if (daysOld >= limitDays) {
                    console.log(`Session ${sessionId} is ${daysOld.toFixed(1)} days old (limit: ${limitDays} days). Forcing re-login...`);
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
        getMessage: async (key) => {
            if (pollCache.has(key.id)) {
                return pollCache.get(key.id);
            }
            return { conversation: 'unknown message' };
        }
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
            const remoteJid = msg.key.remoteJid;
            const actualRemoteJid = msg.key.remoteJidAlt || remoteJid;
            const myJid = sock.user.id.replace(/:.*@/, '@');
            const isMessageToMyself = (actualRemoteJid === myJid);

            // Handle poll update messages first
            if (msg.message.pollUpdateMessage) {
                const pollUpdate = msg.message.pollUpdateMessage;
                const pollId = pollUpdate.pollCreationMessageKey.id;
                if (pollCache.has(pollId)) {
                    const cached = pollCache.get(pollId);

                    try {
                        // Decrypt the poll vote
                        const pollCreationMsg = cached.originalMessage;
                        const pollCreatorJid = pollCreationMsg.key.participant || pollCreationMsg.key.remoteJid;
                        const voterJid = msg.key.participant || msg.key.remoteJid;
                        const pollEncKey = pollCreationMsg.message.messageContextInfo.messageSecret;

                        const decryptedVote = decryptPollVote(pollUpdate.vote, {
                            pollCreatorJid,
                            pollMsgId: pollId,
                            pollEncKey,
                            voterJid
                        });

                        // Add decrypted update in the format expected by getAggregateVotesInPollMessage
                        cached.updates.push({
                            pollUpdateMessageKey: msg.key,
                            vote: decryptedVote,
                            senderTimestampMs: msg.messageTimestamp
                        });

                        const aggregated = getAggregateVotesInPollMessage({
                            message: cached.originalMessage.message,
                            pollUpdates: cached.updates
                        });

                        // Clear existing timer
                        if (pollTimers.has(pollId)) {
                            clearTimeout(pollTimers.get(pollId));
                        }

                        // Set new 4s timer
                        const timer = setTimeout(async () => {
                            pollTimers.delete(pollId);
                            const userJid = msg.key.participant || msg.key.remoteJid;
                            
                            const selectedOptionNames = aggregated
                                .filter(opt => opt.voters.includes(userJid))
                                .map(opt => opt.name);

                            if (selectedOptionNames.length > 0) {
                                console.log(`Sending media for selected options: ${selectedOptionNames.join(', ')} to ${userJid}`);
                                const society = await societiesCollection.findOne({ name: cached.societyName });
                                if (society) {
                                    for (const optionName of selectedOptionNames) {
                                        const opt = society.options.find(o => o.name === optionName);
                                        if (opt) {
                                            await sock.sendMessage(userJid, { text: `Here are the details for ${opt.name}:` });
                                            for (const img of opt.images) {
                                                await sock.sendMessage(userJid, { image: { url: img }, caption: opt.name });
                                            }
                                            for (const vid of opt.videos) {
                                                await sock.sendMessage(userJid, { video: { url: vid }, caption: opt.name });
                                            }
                                        }
                                    }
                                }
                                
                                if (logsCollection) {
                                    const now = new Date();
                                    const dateString = now.toISOString().split('T')[0];
                                    await logsCollection.updateOne(
                                        { number: userJid, dateString: dateString, societyName: cached.societyName },
                                        { $set: { selectedOptions: selectedOptionNames.join(', '), timestamp: now } },
                                        { upsert: true }
                                    );
                                }
                            }
                        }, 10000);

                        pollTimers.set(pollId, timer);
                    } catch (err) {
                        console.error('Error aggregating poll votes:', err);
                    }
                }
                continue;
            }

            // Extract text/caption
            const textMessage = msg.message.conversation || msg.message.extendedTextMessage?.text || msg.message.imageMessage?.caption || msg.message.videoMessage?.caption || "";
            const textLower = textMessage.toLowerCase();

            // Admin commands
            const isAdminCommand = isMessageToMyself;

            if (isAdminCommand) {
                let state = adminState.get(actualRemoteJid);
                const cmd = textLower.trim();

                if (cmd === '!addsociety') {
                    adminState.set(actualRemoteJid, { step: 'awaiting_name' });
                    await sock.sendMessage(remoteJid, { text: "What is the name of the society?" });
                    continue;
                } else if (cmd === '!listsocieties') {
                    const societies = await societiesCollection.find({}).toArray();
                    if (societies.length === 0) {
                        await sock.sendMessage(remoteJid, { text: "No societies found." });
                    } else {
                        const list = societies.map(s => s.name).join('\n');
                        await sock.sendMessage(remoteJid, { text: `Societies:\n${list}` });
                    }
                    continue;
                } else if (cmd.startsWith('!delsociety ')) {
                    const name = cmd.replace('!delsociety ', '').trim();
                    const result = await societiesCollection.deleteOne({ name });
                    if (result.deletedCount > 0) {
                        await sock.sendMessage(remoteJid, { text: `Society '${name}' deleted.` });
                    } else {
                        await sock.sendMessage(remoteJid, { text: `Society '${name}' not found.` });
                    }
                    continue;
                }

                if (state) {
                    if (cmd === 'cancel') {
                        adminState.delete(actualRemoteJid);
                        await sock.sendMessage(remoteJid, { text: "Operation cancelled." });
                        continue;
                    }

                    if (state.step === 'awaiting_name') {
                        state.societyName = cmd;
                        state.options = [];
                        state.step = 'awaiting_option_name';
                        await sock.sendMessage(remoteJid, { text: `Society '${state.societyName}' initialized. Send an option name and price (e.g., '2BHK - 50 Lac'), or type 'done' to finish.` });
                        continue;
                    } else if (state.step === 'awaiting_option_name') {
                        if (cmd === 'done') {
                            if (state.options.length > 0) {
                                await societiesCollection.updateOne({ name: state.societyName }, { $set: { name: state.societyName, options: state.options } }, { upsert: true });
                                await sock.sendMessage(remoteJid, { text: `Society '${state.societyName}' saved successfully!` });
                            } else {
                                await sock.sendMessage(remoteJid, { text: `No options added. Operation cancelled.` });
                            }
                            adminState.delete(actualRemoteJid);
                        } else {
                            state.currentOption = { name: textMessage.trim(), images: [], videos: [] };
                            state.step = 'awaiting_media';
                            await sock.sendMessage(remoteJid, { text: `Option '${state.currentOption.name}' created. Now, send all photos and videos for this option. Type 'done' when you have sent all media.` });
                        }
                        continue;
                    } else if (state.step === 'awaiting_media') {
                        if (cmd === 'done') {
                            state.options.push(state.currentOption);
                            state.step = 'awaiting_option_name';
                            await sock.sendMessage(remoteJid, { text: `Media saved for '${state.currentOption.name}'. Send the next option (e.g., '3BHK - 80 Lac') or type 'done' to finish.` });
                        } else if (msg.message.imageMessage || msg.message.videoMessage) {
                            try {
                                await sock.sendMessage(remoteJid, { text: `Uploading media...` });
                                const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: pino({ level: 'silent' }) });
                                const isImage = !!msg.message.imageMessage;
                                const mimetype = isImage ? msg.message.imageMessage.mimetype : msg.message.videoMessage.mimetype;
                                const ext = isImage ? 'jpeg' : 'mp4';
                                const filename = `upload.${ext}`;
                                
                                const url = await uploadToCatbox(buffer, mimetype, filename);
                                if (isImage) {
                                    state.currentOption.images.push(url);
                                } else {
                                    state.currentOption.videos.push(url);
                                }
                                await sock.sendMessage(remoteJid, { text: `Uploaded successfully: ${url}` });
                            } catch (err) {
                                console.error('Upload error:', err);
                                await sock.sendMessage(remoteJid, { text: `Failed to upload media: ${err.message}` });
                            }
                        } else {
                            await sock.sendMessage(remoteJid, { text: `Please send an image or video, or type 'done'.` });
                        }
                        continue;
                    }
                }
            }

            // Admin reports
            if (isAdminCommand && (textLower.startsWith('!report') || textLower.startsWith('!range'))) {
                let startDate = null;
                let endDate = null;

                const commandArgs = textLower.replace('!report', '').replace('!range', '').trim();
                if (commandArgs) {
                    const daysMatch = commandArgs.match(/^-(\d+)\s*days?$/);
                    if (daysMatch) {
                        const daysAgo = parseInt(daysMatch[1], 10);
                        const end = new Date();
                        const start = new Date();
                        start.setDate(end.getDate() - daysAgo);
                        
                        startDate = start.toISOString().split('T')[0];
                        endDate = end.toISOString().split('T')[0];
                    } else if (commandArgs.includes(' to ')) {
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

            console.log(`[${sessionId}] Received message from ${actualRemoteJid}: ${textMessage}`);

            let matchedKeyword = null;

            // Keyword Matching for Societies
            if (textLower && societiesCollection) {
                const societies = await societiesCollection.find({}).toArray();
                let matchedSociety = null;
                for (const soc of societies) {
                    // Check if the message contains the society name
                    if (textLower.includes(`hello! can i get more info on ${soc.name.toLowerCase()}`)) {
                        matchedSociety = soc;
                        break;
                    }
                }

                if (matchedSociety) {
                    matchedKeyword = `Hello! Can I get more info on ${matchedSociety.name}`;
                    
                    const pollName = `Select options for ${matchedSociety.name}`;
                    const pollValues = matchedSociety.options.map(o => o.name);
                    
                    const pollMsg = await sock.sendMessage(remoteJid, {
                        poll: {
                            name: pollName,
                            values: pollValues,
                            selectableCount: 0 // allow multiple
                        }
                    });

                    // Cache it for decryption
                    pollCache.set(pollMsg.key.id, {
                        originalMessage: pollMsg,
                        updates: [],
                        societyName: matchedSociety.name
                    });

                    console.log(`Sent poll for ${matchedSociety.name} to ${remoteJid}`);
                } else if (textLower.includes('hello! can i get more info on this?')) {
                    // Fallback to the old logic if no society was found but they used the generic prompt
                    matchedKeyword = 'Hello! Can I get more info on this?';
                    console.log(`[${sessionId}] Sending auto-reply to ${remoteJid}...`);
                    
                    const pushName = msg.pushName || 'Sir/Madam';
                    const defaultMsg = 'Hello {{name}}, Raghav this side. Which size are you looking for?';
                    let replyText = sessionAutoReplies.get(sessionId) || process.env.AUTO_REPLY_MESSAGE || defaultMsg;
                    replyText = replyText.replace(/{{name}}/g, pushName);
                    
                    await sock.sendMessage(remoteJid, { text: replyText });
                }
            }

            if (matchedKeyword && logsCollection) {
                const now = new Date();
                const dateString = now.toISOString().split('T')[0];
                const societyName = matchedSociety ? matchedSociety.name : 'Fallback / Generic';

                await logsCollection.insertOne({
                    sessionId: sessionId,
                    number: actualRemoteJid,
                    societyName: societyName,
                    selectedOptions: 'Pending / No Selection',
                    timestamp: now,
                    dateString: dateString
                });
            }
        }
    });

}

// API: Keep service alive
app.get('/ping', (req, res) => {
    res.status(200).send('pong');
});

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

// API: Remove a session
app.delete('/api/session/:sessionId', async (req, res) => {
    const { sessionId } = req.params;
    if (!sessionId) {
        return res.status(400).json({ error: 'sessionId is required' });
    }

    try {
        const sock = sessions.get(sessionId);
        if (sock) {
            sock.logout('Requested by API');
            sessions.delete(sessionId);
        }
        
        connectionStatus.delete(sessionId);
        qrs.delete(sessionId);
        sessionAutoReplies.delete(sessionId);

        if (authCollection) {
            await authCollection.deleteMany({ _id: { $regex: new RegExp(`^${sessionId}-`) } });
            await authCollection.deleteOne({ _id: `session_metadata_${sessionId}` });
        } else {
            const fs = require('fs');
            try {
                fs.rmSync(`auth_info_${sessionId}`, { recursive: true, force: true });
            } catch (e) { }
        }

        res.json({ success: true, message: `Session ${sessionId} has been completely removed.` });
    } catch (error) {
        console.error(`Error removing session ${sessionId}:`, error);
        res.status(500).json({ error: 'Failed to remove session' });
    }
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

// API: Update logout limit for a specific session
app.post('/api/session/logout-time', async (req, res) => {
    const { sessionId, days } = req.body;
    if (!sessionId || !days || isNaN(days)) {
        return res.status(400).json({ error: 'sessionId and a valid number of days are required' });
    }

    if (authCollection) {
        await authCollection.updateOne(
            { _id: `session_metadata_${sessionId}` },
            { $set: { logoutDays: Number(days) } },
            { upsert: true }
        );
        res.json({ success: true, message: `Logout time limit updated to ${days} days for session ${sessionId}` });
    } else {
        res.status(500).json({ error: 'MongoDB is not connected' });
    }
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
            if (!authCollection) {
                if (!mongoClient) mongoClient = new MongoClient(mongoUri);
                await mongoClient.connect();
                const db = mongoClient.db('whatsapp_bot');
                authCollection = db.collection('auth_session');
                logsCollection = db.collection('keyword_logs');
                societiesCollection = db.collection('societies');
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
