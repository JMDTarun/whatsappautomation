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
const reconnectAttempts = new Map();
const reconnectTimers = new Map();
const connectingSessions = new Set();

export async function resetSession(sessionId) {
    const sock = sessions.get(sessionId);
    if (sock) {
        try {
            sock.ev?.removeAllListeners();
            sock.ws?.close();
            sock.end?.(undefined);
        } catch (e) {}
        sessions.delete(sessionId);
    }
    connectionStatus.set(sessionId, 'logged_out');
    qrs.delete(sessionId);

    const collections = await connectDB();
    const authCollection = collections?.authCollection;
    if (authCollection) {
        await authCollection.deleteMany({ _id: { $regex: new RegExp(`^${sessionId}-`) } }).catch(() => {});
    }

    try {
        if (fs.existsSync(`./auth_info_${sessionId}`)) {
            fs.rmSync(`./auth_info_${sessionId}`, { recursive: true, force: true });
        }
    } catch (e) {}

    console.log(`🧹 Session ${sessionId} credentials cleared from database and memory. Ready for fresh QR scan.`);
}

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
    if (connectingSessions.has(sessionId)) {
        console.log(`[Session Lock] Connection attempt already in progress for session ${sessionId}. Skipping duplicate call.`);
        return;
    }
    connectingSessions.add(sessionId);

    // Clear any pending reconnect timer for this session
    if (reconnectTimers.has(sessionId)) {
        clearTimeout(reconnectTimers.get(sessionId));
        reconnectTimers.delete(sessionId);
    }

    console.log(`Starting WhatsApp connection for session: ${sessionId}...`);

    try {
        // Prevent 405 Connection Replaced conflict & double event listener leaks: destroy existing socket
        const existingSock = sessions.get(sessionId);
        if (existingSock) {
            try {
                existingSock.ev?.removeAllListeners();
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

                // Only force re-login if logoutDays is explicitly configured (e.g. > 0) by user
                if (metadata && metadata.logoutDays && metadata.createdAt) {
                    const limitDays = metadata.logoutDays;
                    const daysOld = (now - metadata.createdAt) / (1000 * 60 * 60 * 24);
                    if (daysOld >= limitDays) {
                        console.log(`Session ${sessionId} reached configured limit of ${limitDays} days. Resetting session...`);
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
            markOnlineOnConnect: false,
            keepAliveIntervalMs: 25000,
            connectTimeoutMs: 60000,
            defaultQueryTimeoutMs: 60000,
            retryRequestDelayMs: 500,
            maxMsgRetryCount: 5,
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
                connectingSessions.delete(sessionId);
                connectionStatus.set(sessionId, 'disconnected');
                const reason = lastDisconnect?.error?.output?.statusCode || lastDisconnect?.error?.message || 'disconnect';
                antiban.onDisconnect(reason);

                const statusCode = (lastDisconnect?.error)?.output?.statusCode;
                const isUnauthorized = statusCode === 401 || statusCode === 403;
                const isConflict = statusCode === 405 || statusCode === 440;

                const attempts = (reconnectAttempts.get(sessionId) || 0) + 1;
                reconnectAttempts.set(sessionId, attempts);

                // If persistent conflicts occur (3+ times), the session credentials are stale/invalid or unlinked on WhatsApp.
                // Reset session auth completely to stop infinite 405 loops and allow a clean fresh QR code scan.
                if (isConflict && attempts >= 3) {
                    console.warn(`⚠️ [Session Auth Expired - ${sessionId}] Session received ${attempts} consecutive StatusCode 440/405 Connection Replaced errors. The stored auth credentials are invalid or unlinked on WhatsApp. Clearing stale credentials...`);
                    await resetSession(sessionId);
                    return;
                }

                // Auto-reconnect on socket closes unless session was logged out (401/403)
                const shouldReconnect = !isUnauthorized;
                if (isConflict) {
                    console.warn(`⚠️ [Session Conflict - ${sessionId}] Connection closed (StatusCode 440/405: Connection Replaced). Scheduling reconnect attempt #${attempts}...`);
                } else {
                    console.log(`Connection closed for session ${sessionId} (StatusCode: ${statusCode || 'N/A'}, Reason: ${reason}). Reconnecting: ${shouldReconnect}`);
                }

                if (shouldReconnect) {
                    if (reconnectTimers.has(sessionId)) {
                        clearTimeout(reconnectTimers.get(sessionId));
                    }

                    // Anti-Ban Safe Exponential Backoff with Jitter (15s -> 30s -> 60s -> 2m -> 5m max; 45s base for conflicts)
                    const baseDelays = isConflict
                        ? [45000, 60000, 120000, 300000]
                        : [15000, 30000, 60000, 120000, 300000];
                    const baseDelay = baseDelays[Math.min(attempts - 1, baseDelays.length - 1)];

                    // Add ±20% randomized jitter to prevent fixed repetitive timing signatures
                    const jitter = Math.floor(Math.random() * (baseDelay * 0.4)) - (baseDelay * 0.2);
                    const backoffDelay = Math.max(10000, Math.floor(baseDelay + jitter));

                    console.log(`[AntiBan Safety] Reconnect attempt #${attempts} for session ${sessionId} scheduled in ${(backoffDelay / 1000).toFixed(1)}s`);

                    const timerId = setTimeout(() => {
                        reconnectTimers.delete(sessionId);
                        if (connectionStatus.get(sessionId) !== 'connected') {
                            console.log(`🔄 Attempting auto-reconnect (attempt #${attempts}) for session ${sessionId}...`);
                            startWhatsApp(sessionId);
                        }
                    }, backoffDelay);

                    reconnectTimers.set(sessionId, timerId);
                }
            } else if (connection === 'open') {
                connectingSessions.delete(sessionId);
                if (reconnectTimers.has(sessionId)) {
                    clearTimeout(reconnectTimers.get(sessionId));
                    reconnectTimers.delete(sessionId);
                }

                // Check for duplicate session connected to the same phone number
                const userJid = sock.user?.id ? sock.user.id.replace(/:.*@/, '@') : '';
                const userPhone = userJid.split('@')[0];

                if (userPhone) {
                    for (const [otherSessionId, otherSock] of sessions.entries()) {
                        if (otherSessionId !== sessionId) {
                            const otherJid = otherSock?.user?.id ? otherSock.user.id.replace(/:.*@/, '@') : '';
                            const otherPhone = otherJid.split('@')[0];
                            if (otherPhone && otherPhone === userPhone && connectionStatus.get(otherSessionId) === 'connected') {
                                console.warn(`⚠️ [Session Dup Safeguard] Session '${sessionId}' connected to phone ${userPhone}, but session '${otherSessionId}' is ALREADY active for this number. Disconnecting duplicate session '${sessionId}'.`);
                                try {
                                    sock.ev?.removeAllListeners();
                                    sock.ws?.close();
                                    sock.end?.(undefined);
                                } catch (e) {}
                                sessions.delete(sessionId);
                                connectionStatus.set(sessionId, 'duplicate_disabled');
                                return;
                            }
                        }
                    }
                }

                if (connectionStatus.get(sessionId) !== 'connected') {
                    console.log(`✅ Connected to WhatsApp (Session: ${sessionId}, Phone: ${userPhone || 'N/A'})!`);
                    connectionStatus.set(sessionId, 'connected');
                    qrs.delete(sessionId);
                    reconnectAttempts.set(sessionId, 0);
                    antiban.onReconnect();
                }
            }
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('messages.upsert', async ({ messages, type }) => {
            if (type !== 'notify' && type !== 'append') return;

            for (const msg of messages) {
                if (!msg.message) continue;

                const msgId = `${sessionId}-${msg.key.id}`;
                if (processedMessages.has(msgId)) continue;
                processedMessages.add(msgId);
                if (processedMessages.size > 10000) processedMessages.clear();

                await handleIncomingMessage(sessionId, sock, msg);
            }
        });
    } finally {
        connectingSessions.delete(sessionId);
    }
}

// Background watchdog interval to prevent silent zombie connection drops
let watchdogInterval = null;
const disconnectedSinceMap = new Map();

export function startConnectionWatchdog() {
    if (watchdogInterval) return;
    console.log('🛡️ WhatsApp Connection Watchdog started (polling every 60s)...');

    watchdogInterval = setInterval(async () => {
        const sessionKeys = Array.from(connectionStatus.keys());
        for (const sessionId of sessionKeys) {
            const status = connectionStatus.get(sessionId);
            const sock = sessions.get(sessionId);

            if (status === 'connected') {
                disconnectedSinceMap.delete(sessionId);
                const isWsOpen = sock && (sock.ws?.readyState === 1 || sock.ws === undefined);

                if (!isWsOpen) {
                    console.warn(`⚠️ [Watchdog] Session ${sessionId} status is 'connected' but WebSocket is closed/invalid (readyState: ${sock?.ws?.readyState}). Triggering reconnect...`);
                    connectionStatus.set(sessionId, 'disconnected');
                    startWhatsApp(sessionId);
                    continue;
                }
            } else if (status === 'disconnected') {
                // If a reconnect timer or connection attempt is ALREADY active, do not trigger watchdog reconnect
                if (reconnectTimers.has(sessionId) || connectingSessions.has(sessionId)) {
                    continue;
                }

                const since = disconnectedSinceMap.get(sessionId) || Date.now();
                if (!disconnectedSinceMap.has(sessionId)) {
                    disconnectedSinceMap.set(sessionId, since);
                }

                const elapsedSecs = (Date.now() - since) / 1000;
                if (elapsedSecs >= 90) {
                    console.warn(`⚠️ [Watchdog] Session ${sessionId} has been disconnected for ${elapsedSecs.toFixed(0)}s without active timer. Triggering auto-reconnect...`);
                    disconnectedSinceMap.set(sessionId, Date.now());
                    startWhatsApp(sessionId);
                }
            }
        }
    }, 60000);
}

export async function startupAutoConnect() {
    console.log('Checking for existing authenticated sessions to auto-connect...');
    startConnectionWatchdog();
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

