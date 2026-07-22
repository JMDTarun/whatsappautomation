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
    const remoteJid = msg.key.remoteJid;
    const actualRemoteJid = msg.key.remoteJidAlt || remoteJid;
    const myJid = sock.user?.id ? sock.user.id.replace(/:.*@/, '@') : '';
    const isMessageToMyself = (actualRemoteJid === myJid);

    const textMessage = msg.message.conversation || msg.message.extendedTextMessage?.text || msg.message.imageMessage?.caption || msg.message.videoMessage?.caption || "";
    const textLower = textMessage.toLowerCase();

    if (!fromMe) {
        antiban.onIncomingMessage(actualRemoteJid, textMessage);
    }

    const isAdmin = isAdminUser(remoteJid, actualRemoteJid);

    // If Admin, route to admin command handler
    if (isAdmin) {
        const handledByAdmin = await handleAdminMessage(sessionId, sock, msg, textMessage, textLower, remoteJid, actualRemoteJid);
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

        if (validNumbers.length > 0 && societiesCollection) {
            const society = await societiesCollection.findOne({ name: listState.societyName });
            if (society) {
                if (society.brochure && society.brochure.trim() !== '' && !listState.brochureSent) {
                    console.log(`Queueing brochure for ${society.name} to ${actualRemoteJid} (fast 5-10s delay)`);
                    await queueOutboundMessage(sessionId, remoteJid, {
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
                        await queueOutboundMessage(sessionId, remoteJid, { text: `Here are the details for ${opt.name}:` }, getFastDelay());
                        for (const img of opt.images) {
                            if (img && img.trim() !== '') {
                                await queueOutboundMessage(sessionId, remoteJid, { image: { url: img }, caption: opt.name }, getFastDelay());
                            }
                        }
                        for (const vid of opt.videos) {
                            if (vid && vid.trim() !== '') {
                                await queueOutboundMessage(sessionId, remoteJid, { video: { url: vid }, caption: opt.name }, getFastDelay());
                            }
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

    // Keyword Matching for Societies
    if (textLower && societiesCollection) {
        const societies = await societiesCollection.find({}).toArray();
        for (const soc of societies) {
            if (textLower.includes(`hello! can i get more info on ${soc.name.toLowerCase()}`)) {
                matchedSociety = soc;
                break;
            }
        }

        if (matchedSociety) {
            matchedKeyword = `Hello! Can I get more info on ${matchedSociety.name}`;

            const greetingMsg = `Hello Sir/Mam, Thank you for reaching out. Raghav this side, which size are you looking for ${matchedSociety.name}?`;
            await queueOutboundMessage(sessionId, remoteJid, { text: greetingMsg });

            let listText = `Select options for ${matchedSociety.name}:\n\n`;
            matchedSociety.options.forEach((opt, index) => {
                listText += `${index + 1}. ${opt.name}\n`;
            });
            listText += `\nPlease reply with the number of the option you want details for (e.g. 1 or 1, 2).`;

            await queueOutboundMessage(sessionId, remoteJid, { text: listText });

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

            console.log(`Queued numbered list for ${matchedSociety.name} to ${remoteJid}`);
        } else if (textLower.includes('hello! can i get more info on this?')) {
            matchedKeyword = 'Hello! Can I get more info on this?';
            console.log(`[${sessionId}] Queueing auto-reply to ${remoteJid}...`);

            const pushName = msg.pushName || 'Sir/Madam';
            const defaultMsg = 'Hello {{name}}, Raghav this side. Which size are you looking for?';
            let replyText = getAutoReply(sessionId) || process.env.AUTO_REPLY_MESSAGE || defaultMsg;
            replyText = replyText.replace(/{{name}}/g, pushName);

            await queueOutboundMessage(sessionId, remoteJid, { text: replyText });
        }
    }

    if (matchedKeyword && logsCollection) {
        const now = new Date();
        const dateString = now.toISOString().split('T')[0];
        const societyName = matchedSociety ? matchedSociety.name : 'Fallback / Generic';

        await logsCollection.insertOne({
            sessionId: sessionId,
            number: actualRemoteJid,
            societyName: societyName,
            selectedOptions: 'Pending / No Selection',
            timestamp: now,
            dateString: dateString
        });
    }
}
