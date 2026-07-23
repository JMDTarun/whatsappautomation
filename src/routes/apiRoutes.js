import express from 'express';
import QRCode from 'qrcode';
import { getDBCollections } from '../config/db.js';
import { getAntiBansMap } from '../config/antibanConfig.js';
import { sendMessageWithAntiBan } from '../services/antibanService.js';
import { generateExcelReport } from '../utils/reportGenerator.js';
import { extractPhoneNumber, buildSocietyQuery } from '../utils/phoneUtils.js';
import {
    getSession,
    getConnectionStatus,
    getQR,
    getAutoReply,
    setAutoReply,
    deleteQR,
    startWhatsApp
} from '../services/whatsappService.js';

const router = express.Router();

// API: Initialize a new session
router.post('/session', (req, res) => {
    const { sessionId } = req.body;
    if (!sessionId) {
        return res.status(400).json({ error: 'sessionId is required' });
    }

    const status = getConnectionStatus(sessionId);
    if (status === 'connected' || status === 'qr_ready' || status === 'initializing') {
        return res.json({
            success: true,
            sessionId,
            status,
            message: `Session ${sessionId} is already active (status: ${status}). Check QR at GET /api/qr/${sessionId}`
        });
    }

    startWhatsApp(sessionId);
    res.json({ success: true, message: `Session ${sessionId} started. Get QR at /api/qr/${sessionId}` });
});

// API: Update auto-reply message for a specific session
router.post('/session/message', async (req, res) => {
    const { sessionId, message } = req.body;
    if (!sessionId || !message) {
        return res.status(400).json({ error: 'sessionId and message are required' });
    }

    setAutoReply(sessionId, message);
    const { authCollection } = getDBCollections();

    if (authCollection) {
        try {
            await authCollection.updateOne(
                { _id: `session_metadata_${sessionId}` },
                { $set: { autoReplyMessage: message } },
                { upsert: true }
            );
        } catch (err) {
            console.error(`Failed to save auto reply for ${sessionId}:`, err);
        }
    }

    res.json({ success: true, message: `Auto reply message updated for session ${sessionId}` });
});

// API: Check session status
router.get('/status/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    const status = getConnectionStatus(sessionId) || 'not_found';
    res.json({ sessionId, status });
});

// API: Get QR Code as Image
router.get('/qr/:sessionId', async (req, res) => {
    const { sessionId } = req.params;
    const qr = getQR(sessionId);

    if (!qr) {
        return res.status(404).send('QR code not available or session already connected.');
    }

    try {
        const qrImageBuffer = await QRCode.toBuffer(qr);
        res.type('image/png');
        res.send(qrImageBuffer);
    } catch (err) {
        res.status(500).send('Failed to generate QR image.');
    }
});

// API: Configure Auto-Reply Message per session
router.post('/autoreply/:sessionId', async (req, res) => {
    const { sessionId } = req.params;
    const { message } = req.body;

    if (!message) {
        return res.status(400).json({ error: 'Please provide a "message" string.' });
    }

    setAutoReply(sessionId, message);
    const { authCollection } = getDBCollections();

    if (authCollection) {
        try {
            await authCollection.updateOne(
                { _id: `session_metadata_${sessionId}` },
                { $set: { autoReplyMessage: message } },
                { upsert: true }
            );
        } catch (err) {
            console.error(`Failed to save auto-reply message for session ${sessionId} to MongoDB:`, err);
        }
    }

    res.json({ success: true, message: `Auto-reply updated for session ${sessionId}.` });
});

// API: Get Auto-Reply Message per session
router.get('/autoreply/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    const message = getAutoReply(sessionId) || process.env.AUTO_REPLY_MESSAGE || 'Hello Sir/Mam, Raghav this side. Which size are you looking for?';
    res.json({ sessionId, message });
});

// API: Download Excel Report of Keyword Matches
router.get('/report', async (req, res) => {
    try {
        const { sessionId, startDate, endDate } = req.query;
        const { buffer, count } = await generateExcelReport(sessionId, startDate, endDate);

        if (count === 0) {
            return res.status(404).json({ message: 'No keyword matches found for the given criteria.' });
        }

        const dateSuffix = endDate ? `${startDate}_to_${endDate}` : (startDate || new Date().toISOString().split('T')[0]);
        const filename = `Keyword_Report_${sessionId || 'all'}_${dateSuffix}.xlsx`;

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

        res.send(buffer);
    } catch (error) {
        console.error('Error serving Excel report:', error);
        res.status(500).json({ error: error.message || 'Failed to generate report.' });
    }
});

// AntiBan REST API Endpoints
const antiBans = getAntiBansMap();

router.get('/antiban/stats/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    const antiban = antiBans.get(sessionId);
    if (!antiban) {
        return res.status(404).json({ error: `AntiBan instance for session ${sessionId} not found.` });
    }
    res.json({ sessionId, stats: antiban.getStats() });
});

// API: Get MongoDB Outbound Queue statistics
router.get('/queue', async (req, res) => {
    const { queueCollection } = getDBCollections();
    if (!queueCollection) {
        return res.status(500).json({ error: 'MongoDB queue collection is not connected' });
    }
    try {
        const pending = await queueCollection.countDocuments({ status: 'pending' });
        const processing = await queueCollection.countDocuments({ status: 'processing' });
        const delivered = await queueCollection.countDocuments({ status: 'delivered' });
        const blocked = await queueCollection.countDocuments({ status: 'blocked' });
        const failed = await queueCollection.countDocuments({ status: 'failed' });

        res.json({
            queue: {
                pending,
                processing,
                delivered,
                blocked,
                failed,
                total: pending + processing + delivered + blocked + failed
            }
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post('/antiban/pause/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    const antiban = antiBans.get(sessionId);
    if (!antiban) {
        return res.status(404).json({ error: `AntiBan instance for session ${sessionId} not found.` });
    }
    antiban.pause();
    res.json({ success: true, message: `AntiBan sending paused for session ${sessionId}.` });
});

router.post('/antiban/resume/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    const antiban = antiBans.get(sessionId);
    if (!antiban) {
        return res.status(404).json({ error: `AntiBan instance for session ${sessionId} not found.` });
    }
    antiban.resume();
    res.json({ success: true, message: `AntiBan sending resumed for session ${sessionId}.` });
});

router.post('/antiban/reset/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    const antiban = antiBans.get(sessionId);
    if (!antiban) {
        return res.status(404).json({ error: `AntiBan instance for session ${sessionId} not found.` });
    }
    antiban.reset();
    res.json({ success: true, message: `AntiBan state reset for session ${sessionId}.` });
});

router.get('/antiban/export/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    const antiban = antiBans.get(sessionId);
    if (!antiban) {
        return res.status(404).json({ error: `AntiBan instance for session ${sessionId} not found.` });
    }
    res.json({ sessionId, warmUpState: antiban.exportWarmUpState() });
});

// API: Send message
router.post('/send', async (req, res) => {
    try {
        const { sessionId = 'default', number, message } = req.body;

        if (!number || !message) {
            return res.status(400).json({ error: 'Please provide "number" and "message".' });
        }

        const sock = getSession(sessionId);
        if (!sock || getConnectionStatus(sessionId) !== 'connected') {
            return res.status(500).json({ error: `Session ${sessionId} is not connected.` });
        }

        const jid = number.includes('@s.whatsapp.net') ? number : `${number.replace(/\D/g, '')}@s.whatsapp.net`;

        const sendResult = await sendMessageWithAntiBan(sessionId, sock, jid, { text: message });

        if (!sendResult.allowed) {
            return res.status(429).json({ success: false, error: `Message blocked by AntiBan: ${sendResult.reason}` });
        }

        console.log(`[${sessionId}] Message sent to ${jid} via API`);
        res.status(200).json({ success: true, message: 'Message sent successfully.' });
    } catch (error) {
        console.error('Error sending message via API:', error);
        res.status(500).json({ error: 'Failed to send message.' });
    }
});

// API: Get societies (optional ?number= or ?sessionId= filter)
router.get('/societies', async (req, res) => {
    const { societiesCollection } = getDBCollections();
    if (!societiesCollection) {
        return res.status(500).json({ error: 'Database not connected' });
    }
    try {
        const { number, sessionId } = req.query;
        let query = {};
        if (number || sessionId) {
            query = buildSocietyQuery(number || sessionId, null, sessionId || '');
        }
        const societies = await societiesCollection.find(query).toArray();
        res.json({ success: true, count: societies.length, societies });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// API: Save / Upsert society with optional number / sessionId
router.post('/societies', async (req, res) => {
    const { societiesCollection } = getDBCollections();
    if (!societiesCollection) {
        return res.status(500).json({ error: 'Database not connected' });
    }
    try {
        const { name, options = [], brochure = null, number, sessionId = 'default' } = req.body;
        if (!name) {
            return res.status(400).json({ error: 'Society name is required.' });
        }
        const cleanNum = number ? extractPhoneNumber(number) : extractPhoneNumber(sessionId);
        await societiesCollection.updateOne(
            { name },
            { $set: { name, options, brochure, sessionId, number: cleanNum } },
            { upsert: true }
        );
        res.json({ success: true, message: `Society '${name}' saved successfully.` });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// API: Delete society by name
router.delete('/societies/:name', async (req, res) => {
    const { societiesCollection } = getDBCollections();
    if (!societiesCollection) {
        return res.status(500).json({ error: 'Database not connected' });
    }
    try {
        const name = req.params.name;
        const result = await societiesCollection.deleteOne({ name: { $regex: new RegExp(`^${name}$`, 'i') } });
        if (result.deletedCount > 0) {
            res.json({ success: true, message: `Society '${name}' deleted.` });
        } else {
            res.status(404).json({ error: `Society '${name}' not found.` });
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

export default router;
