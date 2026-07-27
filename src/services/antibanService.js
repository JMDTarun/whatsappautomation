import { getOrCreateAntiBan } from '../config/antibanConfig.js';
import { getDBCollections } from '../config/db.js';
import { contentVariator } from '../utils/contentVariator.js';
import { calculateScheduledTime, isNightTimeIST } from '../utils/timeUtils.js';
import { getSession } from './whatsappService.js';

export async function sendMessageWithAntiBan(sessionId, sock, jid, content, skipDelay = false) {
    const antiban = getOrCreateAntiBan(sessionId);
    const { authCollection } = getDBCollections();

    let finalContent = content;
    let textContent = '';

    if (typeof content === 'string') {
        textContent = contentVariator.vary(content);
        finalContent = textContent;
    } else if (content && typeof content === 'object') {
        if (content.text) {
            textContent = contentVariator.vary(content.text);
            finalContent = { ...content, text: textContent };
        } else if (content.caption) {
            textContent = contentVariator.vary(content.caption);
            finalContent = { ...content, caption: textContent };
        } else {
            textContent = content.fileName || 'media';
        }
    }

    const result = await antiban.beforeSend(jid, textContent);

    if (!result.allowed) {
        console.warn(`[AntiBan - Session ${sessionId}] Message blocked for ${jid}: ${result.reason || 'Blocked by health/limits'}`);
        if (!skipDelay) {
            return { allowed: false, reason: result.reason || 'Blocked by AntiBan' };
        }
    }

    if (!skipDelay && result.delayMs && result.delayMs > 0) {
        // Enforce light human delay if suggested by AntiBan engine (max 5s)
        const delay = Math.min(result.delayMs, 5000);
        await new Promise((resolve) => setTimeout(resolve, delay));
    }

    try {
        const activeSock = getSession(sessionId) || sock;
        if (!activeSock) {
            throw new Error(`Socket connection for session ${sessionId} is unavailable.`);
        }

        if (activeSock?.sendPresenceUpdate) {
            await activeSock.sendPresenceUpdate('available').catch(() => {});
            await activeSock.sendPresenceUpdate('composing', jid).catch(() => {});
        }

        let sentMsg;
        try {
            sentMsg = await activeSock.sendMessage(jid, finalContent, {});
        } catch (sendErr) {
            const errStr = String(sendErr?.message || sendErr);
            if (errStr.includes('Connection Closed') || errStr.includes('428')) {
                console.warn(`[AntiBan Outbound] Connection closed during send to ${jid}. Retrying in 2.5s with fresh socket...`);
                await new Promise(r => setTimeout(r, 2500));
                const freshSock = getSession(sessionId) || activeSock;
                sentMsg = await freshSock.sendMessage(jid, finalContent, {});
            } else {
                throw sendErr;
            }
        }

        antiban.afterSend(jid, textContent, sentMsg?.key?.id);

        const replySnippet = textContent || (typeof finalContent === 'string' ? finalContent : (finalContent?.text || finalContent?.caption || finalContent?.fileName || 'media'));
        console.log(`[AntiBan Outbound] 📤 Reply Sent to ${jid}: "${replySnippet}"`);

        // Human Presence Management: Go offline if no messages scheduled in the next 60 seconds
        if (sock?.sendPresenceUpdate) {
            await sock.sendPresenceUpdate('paused', jid).catch(() => {});
            setTimeout(async () => {
                try {
                    const { queueCollection } = getDBCollections();
                    if (queueCollection) {
                        const dueSoon = new Date(Date.now() + 60 * 1000);
                        const pendingCount = await queueCollection.countDocuments({
                            sessionId,
                            status: 'pending',
                            scheduledAt: { $lte: dueSoon }
                        });
                        if (pendingCount === 0) {
                            await sock.sendPresenceUpdate('unavailable').catch(() => {});
                            console.log(`[AntiBan Presence] 🌙 Presence set to offline for idle session ${sessionId}`);
                        }
                    } else {
                        await sock.sendPresenceUpdate('unavailable').catch(() => {});
                    }
                } catch (e) { }
            }, 4000);
        }

        if (authCollection) {
            authCollection.updateOne(
                { _id: `session_metadata_${sessionId}` },
                { $set: { antibanWarmUpState: antiban.exportWarmUpState() } },
                { upsert: true }
            ).catch(err => console.error(`[AntiBan] Error persisting warm-up state for session ${sessionId}:`, err));
        }

        return { allowed: true, sentMsg };
    } catch (err) {
        antiban.afterSendFailed(err?.message || String(err));
        throw err;
    }
}
