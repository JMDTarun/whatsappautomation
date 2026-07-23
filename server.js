import 'dotenv/config';
import express from 'express';
import { connectDB } from './src/config/db.js';
import { startupAutoConnect } from './src/services/whatsappService.js';
import { processOutboundQueue } from './src/services/queueService.js';
import apiRoutes from './src/routes/apiRoutes.js';

// Filter out noisy internal Baileys Signal session decryption and antiban cleanup warnings from console
const origStderr = process.stderr.write;
process.stderr.write = function (chunk, encoding, fd) {
    const str = chunk ? chunk.toString() : '';
    if (str.includes('MessageCounterError') || str.includes('Failed to decrypt message') || str.includes('baileys-antiban') || str.includes('DEPRECATED')) {
        return true;
    }
    return origStderr.apply(this, arguments);
};

const origStdout = process.stdout.write;
process.stdout.write = function (chunk, encoding, fd) {
    const str = chunk ? chunk.toString() : '';
    if (str.includes('MessageCounterError') || str.includes('Failed to decrypt message') || str.includes('baileys-antiban') || str.includes('DEPRECATED')) {
        return true;
    }
    return origStdout.apply(this, arguments);
};

// Global process safety handlers to prevent server termination on unhandled socket rejections
process.on('unhandledRejection', (reason) => {
    console.warn('⚠️ [Server Safeguard] Caught unhandled promise rejection:', reason?.message || String(reason));
});

process.on('uncaughtException', (err) => {
    console.error('⚠️ [Server Safeguard] Caught uncaught exception:', err?.message || String(err));
});

const app = express();
app.use(express.json());

// Mount API routes
app.use('/api', apiRoutes);

const PORT = process.env.PORT || 3000;

app.listen(PORT, async () => {
    console.log(`🚀 Server API is running on http://localhost:${PORT}`);

    // Connect to MongoDB
    await connectDB();

    // Auto-connect WhatsApp sessions
    await startupAutoConnect();

    // Start background MongoDB outbound queue poller (runs every 10 seconds)
    setInterval(processOutboundQueue, 10000);
    console.log('🔄 MongoDB Outbound Queue background worker initialized (polling every 10s)...');
});
