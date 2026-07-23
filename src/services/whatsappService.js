import { makeWASocket, useMultiFileAuthState } from '@whiskeysockets/baileys';
import pino from 'pino';
import fs from 'fs';
import { wrapSocket } from 'baileys-antiban';

import useMongoDBAuthState from '../../useMongoDBAuthState.js';
import { getDBCollections, connectDB } from '../config/db.js';
import { getOrCreateAntiBan, getOrCreateCircuitBreaker } from '../config/antibanConfig.js';
import { handleIncomingMessage } from '../handlers/messageHandler.js';

// Session Maps
const sessions = new Map();
const qrs = new Map();
const connectionStatus = new Map();
const processedMessages = new Set();
const sessionAutoReplies = new Map();

export function getSession(sessionId) {
    return sessions.get(sessionId);
}

export function getConnectionStatus(sessionId) {
    return connectionStatus.get(sessionId);
}

export function getQR(sessionId) {
    return qrs.get(sessionId);
}

export function getAutoReply(sessionId) {
    return sessionAutoReplies.get(sessionId);
}

export function setAutoReply(sessionId, message) {
    sessionAutoReplies.set(sessionId, message);
}

export function deleteQR(sessionId) {
    qrs.delete(sessionId);
}

export async function startWhatsApp(sessionId = 'default') {
    console.log(`Starting WhatsApp connection for session: ${sessionId}...`);

    // Prevent 405 Connection Replaced conflict: destroy existing socket for this session if running
    const existingSock = sessions.get(sessionId);
    if (existingSock) {
        try {
            existingSock.ws?.close();
            existingSock.end?.(undefined);
        } catch (e) {}
        sessions.delete(sessionId);
    }

    let state, saveCreds;
    const mongoUri = process.env.MONGODB_URI;
    let warmUpState = null;

    const collections = await connectDB();
    const authCollection = collections?.authCollection;

    if (mongoUri && authCollection) {
        try {
            const metadataId = `session_metadata_${sessionId}`;
            const metadata = await authCollection.findOne({ _id: metadataId });
            const now = Date.now();
            if (metadata && metadata.createdAt) {
                const limitDays = metadata.logoutDays || 30;
                const daysOld = (now - metadata.createdAt) / (1000 * 60 * 60 * 24);
                if (daysOld >= limitDays) {
                    console.log(`Session ${sessionId} is ${daysOld.toFixed(1)} days old (limit: ${limitDays} days). Forcing re-login...`);
                    await authCollection.deleteMany({ _id: { $regex: new RegExp(`^${sessionId}-`) } });
                }
            }

            const checkMetadata = await authCollection.findOne({ _id: metadataId });
            if (!checkMetadata) {
                await authCollection.updateOne({ _id: metadataId }, { $set: { createdAt: now } }, { upsert: true });
            }

            const currentMetadata = await authCollection.findOne({ _id: metadataId });
            if (currentMetadata) {
                if (currentMetadata.autoReplyMessage) {
                    sessionAutoReplies.set(sessionId, currentMetadata.autoReplyMessage);
                }
                if (currentMetadata.antibanWarmUpState) {
                    warmUpState = currentMetadata.antibanWarmUpState;
                }
            }

            const mongoAuth = await useMongoDBAuthState(authCollection, sessionId);
            state = mongoAuth.state;
            saveCreds = mongoAuth.saveCreds;
        } catch (error) {
            console.error('Failed to connect to MongoDB in startWhatsApp:', error);
            return;
        }
    } else {
        const localAuth = await useMultiFileAuthState(`auth_info_${sessionId}`);
        state = localAuth.state;
        saveCreds = localAuth.saveCreds;
    }

    const antiban = getOrCreateAntiBan(sessionId, warmUpState);
    const circuitBreaker = getOrCreateCircuitBreaker(sessionId);

    const rawSock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        getMessage: async () => {
            return { conversation: 'unknown message' };
        }
    });

    const sock = wrapSocket(rawSock, antiban.config, warmUpState, {
        deafSession: {
            enabled: false,
        },
        groupOpGuard: {
            enabled: true,
            maxAddsPerMinute: 1,
            maxAddsPerHour: 6,
            maxAddsPerDay: 15,
        },
        legitimacySignals: {
            enabled: true,
            typoProbability: 0.08,
            typingPauseProbability: 0.15,
        },
        circuitBreaker: circuitBreaker,
    });

    sessions.set(sessionId, sock);
    connectionStatus.set(sessionId, 'initializing');

    sock.ev.on('messages.update', async (updates) => {
        for (const update of updates) {
            if (update.key?.id && update.update?.status) {
                if (update.update.status === 3 || update.update.status === 4) {
                    antiban.onDeliveryReceipt(update.key.id);
                }
            }
        }
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log(`New QR code for session ${sessionId}. Available at GET /api/qr/${sessionId}`);
            qrs.set(sessionId, qr);
            connectionStatus.set(sessionId, 'qr_ready');
        }

        if (connection === 'close') {
            const wasConnected = (connectionStatus.get(sessionId) === 'connected');
            connectionStatus.set(sessionId, 'disconnected');
            const reason = lastDisconnect?.error?.output?.statusCode || lastDisconnect?.error?.message || 'disconnect';
            antiban.onDisconnect(reason);

            const statusCode = (lastDisconnect?.error)?.output?.statusCode;
            const isUnauthorized = statusCode === 401;
            const isConflict = statusCode === 405;

            // Only auto-reconnect if session was actively connected, and not unauthorized/conflict
            const shouldReconnect = wasConnected && !isUnauthorized && !isConflict;
            console.log(`Connection closed for session ${sessionId} (Reason: ${reason}). Reconnecting: ${shouldReconnect}`);

            if (shouldReconnect) {
                setTimeout(() => {
                    startWhatsApp(sessionId);
                }, 5000);
            }
        } else if (connection === 'open') {
            if (connectionStatus.get(sessionId) !== 'connected') {
                console.log(`✅ Connected to WhatsApp (Session: ${sessionId})!`);
                connectionStatus.set(sessionId, 'connected');
                qrs.delete(sessionId);
                antiban.onReconnect();
            }
        }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;

        for (const msg of messages) {
            if (!msg.message) continue;

            const msgId = `${sessionId}-${msg.key.id}`;
            if (processedMessages.has(msgId)) continue;
            processedMessages.add(msgId);
            if (processedMessages.size > 10000) processedMessages.clear();

            await handleIncomingMessage(sessionId, sock, msg);
        }
    });
}

export async function startupAutoConnect() {
    console.log('Checking for existing authenticated sessions to auto-connect...');
    const mongoUri = process.env.MONGODB_URI;
    const sessionIds = new Set();

    const collections = await connectDB();
    const authCollection = collections?.authCollection;

    if (mongoUri && authCollection) {
        try {
            const credsDocs = await authCollection.find({ _id: { $regex: /-creds$/ } }).toArray();
            for (const doc of credsDocs) {
                const id = doc._id.replace('-creds', '');
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

    if (sessionIds.size === 0) {
        console.log('No authenticated sessions found to auto-connect. Start new sessions via POST /api/session.');
    } else {
        console.log(`Found ${sessionIds.size} authenticated session(s) to connect: ${Array.from(sessionIds).join(', ')}`);
        for (const sessionId of sessionIds) {
            startWhatsApp(sessionId);
            await new Promise(resolve => setTimeout(resolve, 2500));
        }
    }
}
