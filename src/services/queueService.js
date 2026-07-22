import { getDBCollections } from '../config/db.js';
import { sendMessageWithAntiBan } from './antibanService.js';
import { getSession, getConnectionStatus } from './whatsappService.js';

export async function queueOutboundMessage(sessionId, jid, content, customDelayMs = null) {
    const { queueCollection } = getDBCollections();

    let delayMs = 0;
    if (customDelayMs !== null && customDelayMs >= 0) {
        delayMs = customDelayMs;
    } else {
        const currentHour = new Date().getHours();
        const isNightTime = (currentHour >= 22 || currentHour < 7); // 10:00 PM to 7:00 AM

        if (isNightTime) {
            const minNightMs = 3 * 60 * 60 * 1000;  // 3 hours
            const maxNightMs = 4 * 60 * 60 * 1000;  // 4 hours
            delayMs = Math.floor(Math.random() * (maxNightMs - minNightMs + 1) + minNightMs);
        } else {
            const minDayMs = 5 * 60 * 1000;   // 5 minutes
            const maxDayMs = 15 * 60 * 1000;  // 15 minutes
            delayMs = Math.floor(Math.random() * (maxDayMs - minDayMs + 1) + minDayMs);
        }
    }

    const scheduledAt = new Date(Date.now() + delayMs);

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
        const delaySecs = (delayMs / 1000).toFixed(1);
        console.log(`[MongoDB Queue] Saved message for ${jid} to MongoDB queue. Scheduled in ${delaySecs}s at ${scheduledAt.toLocaleTimeString()} (Session: ${sessionId})`);
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
                    console.log(`[MongoDB Queue] Successfully delivered message ${item._id} to ${item.jid}`);
                } else {
                    await queueCollection.updateOne({ _id: item._id }, { $set: { status: 'blocked', error: sendResult.reason || 'Blocked by AntiBan' } });
                    console.warn(`[MongoDB Queue] Queued message ${item._id} blocked: ${sendResult.reason}`);
                }
            } catch (err) {
                console.error(`[MongoDB Queue Error for ${item._id}]:`, err);
                const attempts = (item.attempts || 0) + 1;
                if (attempts >= 3) {
                    await queueCollection.updateOne({ _id: item._id }, { $set: { status: 'failed', error: err.message, attempts } });
                } else {
                    await queueCollection.updateOne({
                        _id: item._id,
                        $set: {
                            status: 'pending',
                            scheduledAt: new Date(Date.now() + 5 * 60 * 1000),
                            attempts,
                            error: err.message
                        }
                    });
                }
            }
        }
    } catch (error) {
        console.error('[MongoDB Queue Poller Error]:', error);
    }
}
