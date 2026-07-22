import 'dotenv/config';
import express from 'express';
import { connectDB } from './src/config/db.js';
import { startupAutoConnect } from './src/services/whatsappService.js';
import { processOutboundQueue } from './src/services/queueService.js';
import apiRoutes from './src/routes/apiRoutes.js';

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

    // Start background MongoDB outbound queue poller (runs every 30 seconds)
    setInterval(processOutboundQueue, 30000);
    console.log('🔄 MongoDB Outbound Queue background worker initialized (polling every 30s)...');
});
