import { MongoClient } from 'mongodb';

let mongoClient = null;
let db = null;
let authCollection = null;
let logsCollection = null;
let societiesCollection = null;
let queueCollection = null;
let activeListsCollection = null;

export async function connectDB() {
    const mongoUri = process.env.MONGODB_URI;
    if (!mongoUri) {
        return null;
    }

    if (!mongoClient) {
        mongoClient = new MongoClient(mongoUri);
        await mongoClient.connect();
        db = mongoClient.db('whatsapp_bot');
        authCollection = db.collection('auth_session');
        logsCollection = db.collection('keyword_logs');
        societiesCollection = db.collection('societies');
        queueCollection = db.collection('outbound_queue');
        activeListsCollection = db.collection('active_lists');
        console.log('✅ Connected to MongoDB successfully');
    }

    return {
        mongoClient,
        db,
        authCollection,
        logsCollection,
        societiesCollection,
        queueCollection,
        activeListsCollection
    };
}

export function getDBCollections() {
    return {
        mongoClient,
        db,
        authCollection,
        logsCollection,
        societiesCollection,
        queueCollection,
        activeListsCollection
    };
}
