import { getOrCreateAntiBan } from '../config/antibanConfig.js';
import { getDBCollections } from '../config/db.js';
import { contentVariator } from '../utils/contentVariator.js';

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
        return { allowed: false, reason: result.reason || 'Blocked by AntiBan' };
    }

    if (!skipDelay) {
        const currentHour = new Date().getHours();
        const isNightTime = (currentHour >= 22 || currentHour < 7);

        let calculatedDelay = 0;
        if (isNightTime) {
            const minNightMs = 3 * 60 * 60 * 1000;  // 3 hours
            const maxNightMs = 4 * 60 * 60 * 1000;  // 4 hours
            calculatedDelay = Math.max(result.delayMs || 0, Math.floor(Math.random() * (maxNightMs - minNightMs + 1) + minNightMs));
        } else {
            const minDayMs = 5 * 60 * 1000;   // 5 minutes
            const maxDayMs = 15 * 60 * 1000;  // 15 minutes
            calculatedDelay = Math.max(result.delayMs || 0, Math.floor(Math.random() * (maxDayMs - minDayMs + 1) + minDayMs));
        }

        if (calculatedDelay > 0) {
            await new Promise((resolve) => setTimeout(resolve, calculatedDelay));
        }
    } else if (result.delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, result.delayMs));
    }

    try {
        const sentMsg = await sock.sendMessage(jid, finalContent);
        antiban.afterSend(jid, textContent, sentMsg?.key?.id);

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
