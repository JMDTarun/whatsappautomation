import { getDBCollections } from '../config/db.js';
import { sendMessageWithAntiBan } from './antibanService.js';
import { getSession, getConnectionStatus } from './whatsappService.js';

export function calculateScheduledTime(customDelayMs = null) {
    if (customDelayMs !== null && customDelayMs >= 0) {
        return new Date(Date.now() + customDelayMs);
    }

    const now = new Date();
    const currentHour = now.getHours(); // 0-23
    const isNightTime = (currentHour >= 21 || currentHour < 7); // 09:00 PM to 07:00 AM

    if (isNightTime) {
        // Schedule for next morning between 07:00 AM and 08:30 AM
        const nextMorning = new Date(now);
        if (currentHour >= 21) {
            nextMorning.setDate(nextMorning.getDate() + 1);
        }
        nextMorning.setHours(7, 0, 0, 0);

        // Random offset between 0 and 90 minutes (07:00 AM to 08:30 AM)
        const randomMorningOffsetMs = Math.floor(Math.random() * (90 * 60 * 1000));
        return new Date(nextMorning.getTime() + randomMorningOffsetMs);
    } else {
        // Daytime (07:00 AM to 09:00 PM): 1 to 5 minutes randomized delay
        const minDayMs = 1 * 60 * 1000;   // 1 minute (60,000 ms)
        const maxDayMs = 5 * 60 * 1000;   // 5 minutes (300,000 ms)
        const delayMs = Math.floor(Math.random() * (maxDayMs - minDayMs + 1) + minDayMs);
        return new Date(now.getTime() + delayMs);
    }
}

export async function queueOutboundMessage(sessionId, jid, content, customDelayMs = null) {
    const { queueCollection } = getDBCollections();

    const scheduledAt = calculateScheduledTime(customDelayMs);
    const delayMs = scheduledAt.getTime() - Date.now();

    if (queueCollection) {
        await queueCollection.insertOne({
            sessionId,
            jid,
            content,
            scheduledAt,
            status: 'pending', // 'pending' | 'processing' | 'delivered' | 'failed' | 'blocked'
            createdAt: new Date(),
            attempts: 0,
            error: null
        });
        const textContent = typeof content === 'string' ? content : (content?.text || content?.caption || content?.fileName || 'media');
        const delaySecs = (delayMs / 1000).toFixed(1);
        console.log(`[MongoDB Queue] 📅 Scheduled message for ${jid} in ${delaySecs}s at ${scheduledAt.toLocaleTimeString()} (Session: ${sessionId}) | Content: "${textContent}"`);
    } else {
        console.log(`[Queue Fallback] MongoDB queue not connected, using in-memory delay (${(delayMs / 1000).toFixed(1)}s)...`);
        setTimeout(async () => {
            const sock = getSession(sessionId);
            if (sock) {
                await sendMessageWithAntiBan(sessionId, sock, jid, content, true).catch(e => console.error(e));
            }
        }, delayMs);
    }
}

export async function processOutboundQueue() {
    const { queueCollection } = getDBCollections();
    if (!queueCollection) return;

    // Strict night quiet hours: Do not process outbound queue between 09:00 PM (21) and 07:00 AM (7)
    const currentHour = new Date().getHours();
    if (currentHour >= 21 || currentHour < 7) {
        return;
    }

    try {
        const now = new Date();
        const pendingItems = await queueCollection.find({
            status: 'pending',
            scheduledAt: { $lte: now }
        }).limit(5).toArray();

        for (const item of pendingItems) {
            const sock = getSession(item.sessionId);
            if (!sock || getConnectionStatus(item.sessionId) !== 'connected') {
                continue;
            }

            const updateResult = await queueCollection.updateOne(
                { _id: item._id, status: 'pending' },
                { $set: { status: 'processing', updatedAt: new Date() } }
            );

            if (updateResult.modifiedCount === 0) continue;

            try {
                const sendResult = await sendMessageWithAntiBan(item.sessionId, sock, item.jid, item.content, true);
                if (sendResult.allowed) {
                    await queueCollection.updateOne({ _id: item._id }, { $set: { status: 'delivered', deliveredAt: new Date() } });
                    const replyText = typeof item.content === 'string' ? item.content : (item.content?.text || item.content?.caption || item.content?.fileName || 'media');
                    console.log(`[MongoDB Queue] 🚀 Delivered reply message to ${item.jid}: "${replyText}"`);
                } else {
                    // Reschedule for 45 seconds later instead of dropping if temporarily rate limited
                    const retryTime = new Date(Date.now() + 45 * 1000);
                    await queueCollection.updateOne(
                        { _id: item._id },
                        { $set: { status: 'pending', scheduledAt: retryTime, error: sendResult.reason || 'Rate limit pause' } }
                    );
                    console.warn(`[MongoDB Queue] Queued message ${item._id} rate limited (${sendResult.reason}). Rescheduled for ${retryTime.toLocaleTimeString()}`);
                }
            } catch (err) {
                const errorMessage = err?.message || String(err) || 'Unknown error';
                console.error(`[MongoDB Queue Error for ${item._id}]:`, errorMessage);
                const attempts = (item.attempts || 0) + 1;
                if (attempts >= 3) {
                    await queueCollection.updateOne(
                        { _id: item._id },
                        { $set: { status: 'failed', error: errorMessage, attempts } }
                    );
                } else {
                    await queueCollection.updateOne(
                        { _id: item._id },
                        {
                            $set: {
                                status: 'pending',
                                scheduledAt: new Date(Date.now() + 5 * 60 * 1000),
                                attempts,
                                error: errorMessage
                            }
                        }
                    );
                }
            }
        }
    } catch (error) {
        console.error('[MongoDB Queue Poller Error]:', error);
    }
}
