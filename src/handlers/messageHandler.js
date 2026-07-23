import { getDBCollections } from '../config/db.js';
import { getOrCreateAntiBan } from '../config/antibanConfig.js';
import { queueOutboundMessage } from '../services/queueService.js';
import { getAutoReply } from '../services/whatsappService.js';
import { handleAdminMessage, isAdminUser } from './adminHandler.js';

const activeLists = new Map();

export async function handleIncomingMessage(sessionId, sock, msg) {
    const { societiesCollection, logsCollection, activeListsCollection } = getDBCollections();
    const antiban = getOrCreateAntiBan(sessionId);

    const fromMe = msg.key.fromMe;
    const rawRemoteJid = msg.key.remoteJid;

    // Resolve actual phone number JID (@s.whatsapp.net) instead of device @lid address
    let actualRemoteJid = msg.key.remoteJidAlt || rawRemoteJid;
    if (actualRemoteJid?.endsWith('@lid')) {
        if (msg.key.remoteJidAlt?.endsWith('@s.whatsapp.net')) {
            actualRemoteJid = msg.key.remoteJidAlt;
        } else if (msg.key.participant?.endsWith('@s.whatsapp.net')) {
            actualRemoteJid = msg.key.participant;
        } else if (rawRemoteJid?.endsWith('@s.whatsapp.net')) {
            actualRemoteJid = rawRemoteJid;
        }
    }

    const myJid = sock.user?.id ? sock.user.id.replace(/:.*@/, '@') : '';
    const isMessageToMyself = (actualRemoteJid === myJid);

    // Ignore group messages (@g.us), status updates (@status.us), and newsletters
    if (rawRemoteJid?.endsWith('@g.us') || rawRemoteJid?.endsWith('@status.us') || rawRemoteJid?.endsWith('@newsletter')) {
        return;
    }

    const textMessage = msg.message.conversation || msg.message.extendedTextMessage?.text || msg.message.imageMessage?.caption || msg.message.videoMessage?.caption || "";
    const textLower = textMessage.toLowerCase();

    if (!fromMe) {
        antiban.onIncomingMessage(actualRemoteJid, textMessage);
    }

    const isAdmin = isAdminUser(rawRemoteJid, actualRemoteJid, sessionId, fromMe);

    // If Admin, route to admin command handler
    if (isAdmin) {
        const handledByAdmin = await handleAdminMessage(sessionId, sock, msg, textMessage, textLower, rawRemoteJid, actualRemoteJid);
        if (handledByAdmin) return;
    }

    // Ignore self-sent messages to other users
    if (fromMe && !isMessageToMyself) return;

    // Handle number replies for active lists
    let listState = activeLists.get(actualRemoteJid);
    if (!listState && activeListsCollection) {
        listState = await activeListsCollection.findOne({ _id: actualRemoteJid });
        if (listState) activeLists.set(actualRemoteJid, listState);
    }

    const isNumberReply = /^\s*\d+(?:\s*,\s*\d+)*\s*$/.test(textMessage);
    if (isNumberReply && !isMessageToMyself && listState) {
        // Fast human response time (5 to 10 seconds) during active option menu choices
        const getFastDelay = () => Math.floor(Math.random() * (10000 - 5000 + 1) + 5000);

        const numbers = textMessage.split(',').map(n => parseInt(n.trim(), 10) - 1);
        const validNumbers = numbers.filter(n => n >= 0 && n < listState.options.length);

        if (validNumbers.length === 0) {
            console.log(`[${sessionId}] Invalid option choice '${textMessage}' from ${actualRemoteJid}. (Available options count: ${listState.options.length})`);
            await queueOutboundMessage(sessionId, actualRemoteJid, { text: `Please reply with a valid option number (1 to ${listState.options.length}).` }, getFastDelay());
            return;
        }

        if (societiesCollection) {
            const society = await societiesCollection.findOne({ name: listState.societyName });
            if (society) {
                if (society.brochure && society.brochure.trim() !== '' && !listState.brochureSent) {
                    console.log(`Queueing brochure for ${society.name} to ${actualRemoteJid} (fast 5-10s delay)`);
                    await queueOutboundMessage(sessionId, actualRemoteJid, {
                        document: { url: society.brochure },
                        mimetype: 'application/pdf',
                        fileName: `${society.name} Brochure.pdf`,
                        caption: `${society.name} Brochure`
                    }, getFastDelay());
                    listState.brochureSent = true;
                    if (activeListsCollection) {
                        await activeListsCollection.updateOne({ _id: actualRemoteJid }, { $set: { brochureSent: true } }).catch(() => { });
                    }
                }

                for (const selectedIndex of validNumbers) {
                    const selectedOptionName = listState.options[selectedIndex];
                    const opt = society.options.find(o => o.name === selectedOptionName);
                    if (opt) {
                        console.log(`Queueing media for selected option: ${selectedOptionName} to ${actualRemoteJid} (fast 5-10s delay)`);
                        
                        const images = (opt.images || []).filter(img => img && img.trim() !== '');
                        const videos = (opt.videos || []).filter(vid => vid && vid.trim() !== '');

                        // Send only images and videos with details attached as caption
                        for (const img of images) {
                            await queueOutboundMessage(sessionId, actualRemoteJid, { image: { url: img }, caption: opt.name }, getFastDelay());
                        }
                        for (const vid of videos) {
                            await queueOutboundMessage(sessionId, actualRemoteJid, { video: { url: vid }, caption: opt.name }, getFastDelay());
                        }

                        // Fallback if option has no images or videos uploaded
                        if (images.length === 0 && videos.length === 0) {
                            await queueOutboundMessage(sessionId, actualRemoteJid, { text: opt.name }, getFastDelay());
                        }

                        if (logsCollection) {
                            const now = new Date();
                            const dateString = now.toISOString().split('T')[0];

                            const existingLog = await logsCollection.findOne({ number: actualRemoteJid, dateString: dateString, societyName: listState.societyName });

                            let newOptions = [selectedOptionName];
                            if (existingLog && existingLog.selectedOptions && existingLog.selectedOptions !== 'Pending / No Selection') {
                                const prevOptions = existingLog.selectedOptions.split(', ').filter(Boolean);
                                if (!prevOptions.includes(selectedOptionName)) {
                                    newOptions = [...prevOptions, selectedOptionName];
                                } else {
                                    newOptions = prevOptions;
                                }
                            }

                            await logsCollection.updateOne(
                                { number: actualRemoteJid, dateString: dateString, societyName: listState.societyName },
                                { $set: { selectedOptions: newOptions.join(', '), timestamp: now } },
                                { upsert: true }
                            );
                        }
                    }
                }
            }
        }
        return;
    }

    console.log(`[${sessionId}] Received message from ${actualRemoteJid}: ${textMessage}`);

    let matchedKeyword = null;
    let matchedSociety = null;

    // Exact Pattern Matching: "hello! can i get more info on <society_name / this>?"
    if (textLower && societiesCollection) {
        const infoOnMatch = textLower.match(/hello!\s*can\s*i\s*get\s*more\s*info\s*on\s*(.+)/i);

        if (infoOnMatch) {
            const rawTarget = infoOnMatch[1].trim().replace(/\?$/, '').trim(); // e.g. "cherry county" or "this"

            const pushName = msg.pushName || 'Sir/Madam';
            const configuredMsg = getAutoReply(sessionId) || process.env.AUTO_REPLY_MESSAGE || 'Hello {{name}}, Which size are you looking for?';

            if (rawTarget === 'this') {
                matchedKeyword = 'Hello! Can I get more info on this?';
                console.log(`[${sessionId}] Matched exact keyword for ${actualRemoteJid}: "${textMessage}". Queueing auto-reply...`);

                let replyText = configuredMsg.replace(/{{name}}/g, pushName);
                await queueOutboundMessage(sessionId, actualRemoteJid, { text: replyText });
            } else {
                // Dynamically find society from DB matching extracted target for current session/number
                const currentBotNumber = sock.user?.id ? sock.user.id.replace(/\D/g, '') : sessionId.replace(/\D/g, '');
                const societies = await societiesCollection.find({
                    $or: [
                        { number: currentBotNumber },
                        { sessionId: sessionId },
                        { sessionId: currentBotNumber },
                        { number: { $exists: false } },
                        { sessionId: { $exists: false } }
                    ]
                }).toArray();
                matchedSociety = societies.find(s => s.name.toLowerCase() === rawTarget.toLowerCase() || rawTarget.toLowerCase().includes(s.name.toLowerCase()));

                const extractedSocietyName = matchedSociety ? matchedSociety.name : rawTarget;
                matchedKeyword = `Hello! Can I get more info on ${extractedSocietyName}`;

                if (matchedSociety) {
                    let greetingMsg = configuredMsg.replace(/{{name}}/g, pushName);

                    let combinedMsg = `${greetingMsg}\n\nSelect options for ${matchedSociety.name}:\n\n`;
                    matchedSociety.options.forEach((opt, index) => {
                        combinedMsg += `${index + 1}. ${opt.name}\n`;
                    });
                    combinedMsg += `\nPlease reply with the number of the option you want details for (e.g. 1 or 1, 2).`;

                    await queueOutboundMessage(sessionId, actualRemoteJid, { text: combinedMsg });

                    const activeListData = {
                        societyName: matchedSociety.name,
                        options: matchedSociety.options.map(o => o.name),
                        timestamp: Date.now(),
                        brochureSent: false
                    };
                    activeLists.set(actualRemoteJid, activeListData);

                    if (activeListsCollection) {
                        await activeListsCollection.updateOne(
                            { _id: actualRemoteJid },
                            { $set: { ...activeListData, updatedAt: new Date() } },
                            { upsert: true }
                        ).catch(err => console.error('Failed to persist activeList to MongoDB:', err));
                    }

                    console.log(`Queued numbered list for ${matchedSociety.name} to ${actualRemoteJid}`);
                } else {
                    // Extracted society name from message but not found in DB
                    console.log(`[${sessionId}] Extracted society "${rawTarget}" from message. Queueing auto-reply...`);
                    let replyText = configuredMsg.replace(/{{name}}/g, pushName);
                    await queueOutboundMessage(sessionId, actualRemoteJid, { text: replyText });
                }
            }
        }
    }

    if (matchedKeyword && logsCollection) {
        const now = new Date();
        const dateString = now.toISOString().split('T')[0];
        const societyName = matchedSociety ? matchedSociety.name : 'General / Info Inquiry';

        await logsCollection.insertOne({
            sessionId: sessionId,
            number: actualRemoteJid,
            textMessage: textMessage,
            societyName: societyName,
            keywordMatched: matchedKeyword,
            selectedOptions: 'Pending / No Selection',
            timestamp: now,
            dateString: dateString
        });
        console.log(`[MongoDB Log] Saved keyword match log for ${actualRemoteJid} (${matchedKeyword})`);
    }
}
