import { getOrCreateAntiBan } from '../config/antibanConfig.js';
import { getDBCollections } from '../config/db.js';
import { contentVariator } from '../utils/contentVariator.js';
import { calculateScheduledTime, isNightTimeIST } from '../utils/timeUtils.js';

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

    if (!result.allowed && !skipDelay) {
        console.warn(`[AntiBan - Session ${sessionId}] Message blocked for ${jid}: ${result.reason || 'Blocked by health/limits'}`);
        return { allowed: false, reason: result.reason || 'Blocked by AntiBan' };
    }

    if (!skipDelay) {
        let calculatedDelay = 0;
        if (isNightTimeIST()) {
            const scheduledAt = calculateScheduledTime();
            calculatedDelay = scheduledAt.getTime() - Date.now();
        } else {
            const minDayMs = 1 * 60 * 1000;   // 1 minute
            const maxDayMs = 5 * 60 * 1000;   // 5 minutes
            calculatedDelay = Math.max(result.delayMs || 0, Math.floor(Math.random() * (maxDayMs - minDayMs + 1) + minDayMs));
        }

        if (calculatedDelay > 0) {
            await new Promise((resolve) => setTimeout(resolve, calculatedDelay));
        }
    }

    try {
        if (sock?.sendPresenceUpdate) {
            await sock.sendPresenceUpdate('available').catch(() => {});
            await sock.sendPresenceUpdate('composing', jid).catch(() => {});
        }

        const sentMsg = await sock.sendMessage(jid, finalContent, {});
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
