import pino from 'pino';
import { downloadMediaMessage } from '@whiskeysockets/baileys';
import { getDBCollections } from '../config/db.js';
import { sendMessageWithAntiBan } from '../services/antibanService.js';
import { compressPDF, uploadToCloudinary } from '../utils/mediaUtils.js';
import { generateExcelReport } from '../utils/reportGenerator.js';
import { buildSocietyQuery, getBotNumberInfo, extractPhoneNumber } from '../utils/phoneUtils.js';

const adminState = new Map();
const ADMIN_NUMBER = process.env.ADMIN_NUMBER;

export function isAdminUser(remoteJid, actualRemoteJid, sessionId = null, fromMe = false) {
    // If the message is sent directly from the active logged-in session account itself, it is authorized
    if (fromMe) return true;

    const adminConfig = process.env.ADMIN_NUMBER || '';
    const cleanJid = (actualRemoteJid || remoteJid || '').replace(/\D/g, '');
    if (!cleanJid) return false;

    // Support comma or whitespace separated list of admin phone numbers
    const adminList = adminConfig.split(/[\s,]+/).map(n => n.replace(/\D/g, '')).filter(Boolean);

    // Also authorize the current active session's own number as an admin
    if (sessionId) {
        const cleanSession = sessionId.replace(/\D/g, '');
        if (cleanSession && cleanSession.length >= 10) {
            adminList.push(cleanSession);
        }
    }

    if (adminList.length === 0) return false;

    for (const cleanAdmin of adminList) {
        if (cleanJid.includes(cleanAdmin) || cleanAdmin.includes(cleanJid)) return true;
        if (cleanJid.length >= 10 && cleanAdmin.length >= 10) {
            if (cleanJid.slice(-10) === cleanAdmin.slice(-10)) return true;
        }
    }
    return false;
}

export async function handleAdminMessage(sessionId, sock, msg, textMessage, textLower, remoteJid, actualRemoteJid) {
    const { societiesCollection } = getDBCollections();
    const cmd = textLower.trim();

    // Resolve target JID so outbound response is always delivered directly to the admin sender number
    const senderDigits = (actualRemoteJid || remoteJid || '').replace(/\D/g, '');
    const targetJid = senderDigits ? `${senderDigits}@s.whatsapp.net` : (remoteJid || actualRemoteJid);

    // Excel Reports Command (!report / !range)
    if (cmd.startsWith('!report') || cmd.startsWith('!range')) {
        let startDate = null;
        let endDate = null;

        const commandArgs = textLower.replace('!report', '').replace('!range', '').trim();
        if (commandArgs) {
            if (commandArgs === 'all' || commandArgs === 'total' || commandArgs === 'full') {
                startDate = 'all';
                endDate = null;
            } else if (commandArgs === 'today') {
                startDate = new Date().toISOString().split('T')[0];
                endDate = null;
            } else {
                const daysMatch = commandArgs.match(/^-?(\d+)\s*days?$/);
                if (daysMatch) {
                    const daysAgo = parseInt(daysMatch[1], 10);
                    const end = new Date();
                    const start = new Date();
                    start.setDate(end.getDate() - daysAgo);

                    startDate = start.toISOString().split('T')[0];
                    endDate = end.toISOString().split('T')[0];
                } else if (commandArgs.includes(' to ')) {
                    const dates = commandArgs.split(' to ');
                    startDate = dates[0].trim();
                    endDate = dates[1].trim();
                } else if (commandArgs.includes(':')) {
                    const dates = commandArgs.split(':');
                    startDate = dates[0].trim();
                    endDate = dates[1].trim();
                } else {
                    startDate = commandArgs;
                }
            }
        }

        try {
            const rangeText = endDate ? `${startDate} to ${endDate}` : (startDate || 'today');
            console.log(`Generating report for admin on session ${sessionId}: ${rangeText}`);
            await sendMessageWithAntiBan(sessionId, sock, targetJid, { text: `Generating Excel report for session ${sessionId} (${rangeText})...` }, true);

            const reportSession = (commandArgs.includes('all') || commandArgs.includes('full') || commandArgs.includes('total')) ? null : sessionId;
            const { buffer, count } = await generateExcelReport(reportSession, startDate, endDate);

            if (count === 0) {
                await sendMessageWithAntiBan(sessionId, sock, targetJid, { text: `No keyword matches found: ${rangeText}` }, true);
                return true;
            }

            const fileNameDate = endDate ? `${startDate}_to_${endDate}` : (startDate || new Date().toISOString().split('T')[0]);

            await sendMessageWithAntiBan(sessionId, sock, targetJid, {
                document: Buffer.from(buffer),
                mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                fileName: `Report_${fileNameDate}.xlsx`,
                caption: `Keyword report (${rangeText}). Total matches: ${count}`
            }, true);
        } catch (error) {
            console.error('Error generating report:', error);
            await sendMessageWithAntiBan(sessionId, sock, targetJid, { text: `Sorry, failed to generate the report: ${error.message}` }, true);
        }
        return true;
    }

    // Interactive Society Management Commands
    if (cmd === '!addsociety') {
        adminState.set(actualRemoteJid, { step: 'awaiting_name' });
        adminState.set(targetJid, { step: 'awaiting_name' });
        await sendMessageWithAntiBan(sessionId, sock, targetJid, { text: 'Starting society setup. Please reply with the Society Name:' }, true);
        return true;
    }

    if (cmd.startsWith('!listsocieties')) {
        if (societiesCollection) {
            const args = textMessage.substring('!listsocieties'.length).trim();
            const botInfo = getBotNumberInfo(sock, sessionId);
            const query = buildSocietyQuery(args, sock, sessionId);

            let headerText = '';
            if (args.toLowerCase() === 'all') {
                headerText = '*All Registered Societies (All Numbers):*\n\n';
            } else if (args.length > 0) {
                headerText = `*Registered Societies matching '${args}':*\n\n`;
            } else {
                headerText = `*Registered Societies for Number ${botInfo.cleanNumber || sessionId}:*\n\n`;
            }

            const list = await societiesCollection.find(query).toArray();
            if (list.length === 0) {
                const searchInfo = args ? ` matching '${args}'` : ` for number ${botInfo.cleanNumber || sessionId}`;
                const tipMessage = args.toLowerCase() === 'all' ? '' : '\n\n💡 *Tip:* Send `!listsocieties all` to view all registered societies across all numbers/sessions.';
                await sendMessageWithAntiBan(sessionId, sock, targetJid, { text: `No societies found${searchInfo}.${tipMessage}` }, true);
            } else {
                let msgText = headerText;
                list.forEach((s, idx) => {
                    const numberLabel = s.number || s.sessionId ? ` (Number: ${s.number || s.sessionId})` : ' (All / Unassigned)';
                    msgText += `${idx + 1}. *${s.name}*${numberLabel}\n   Options: ${s.options ? s.options.map(o => o.name).join(', ') : 'None'}\n   Brochure: ${s.brochure ? 'Yes' : 'No'}\n\n`;
                });
                await sendMessageWithAntiBan(sessionId, sock, targetJid, { text: msgText }, true);
            }
        }
        return true;
    }

    if (cmd.startsWith('!delsociety')) {
        const nameToDelete = textMessage.replace('!delsociety', '').trim();
        if (!nameToDelete) {
            await sendMessageWithAntiBan(sessionId, sock, targetJid, { text: 'Please provide the society name to delete. E.g., `!delsociety M3M Crown`' }, true);
        } else if (societiesCollection) {
            const res = await societiesCollection.deleteOne({ name: { $regex: new RegExp(`^${nameToDelete}$`, 'i') } });
            if (res.deletedCount > 0) {
                await sendMessageWithAntiBan(sessionId, sock, targetJid, { text: `Society '${nameToDelete}' deleted successfully.` }, true);
            } else {
                await sendMessageWithAntiBan(sessionId, sock, targetJid, { text: `Society '${nameToDelete}' not found.` }, true);
            }
        }
        return true;
    }

    // Step-by-Step Multi-step Admin State Flow
    const stateKey = adminState.has(actualRemoteJid) ? actualRemoteJid : (adminState.has(targetJid) ? targetJid : (adminState.has(remoteJid) ? remoteJid : null));
    if (stateKey) {
        const state = adminState.get(stateKey);

        if (cmd === 'cancel') {
            adminState.delete(actualRemoteJid);
            adminState.delete(targetJid);
            adminState.delete(remoteJid);
            await sendMessageWithAntiBan(sessionId, sock, targetJid, { text: 'Operation cancelled.' }, true);
            return true;
        }

        if (state.step === 'awaiting_name') {
            state.societyName = textMessage.trim();
            state.options = [];
            state.step = 'awaiting_brochure';
            await sendMessageWithAntiBan(sessionId, sock, targetJid, { text: `Society '${state.societyName}' initialized. Please send a PDF brochure document for this society, or type 'skip' to continue without one.` }, true);
            return true;
        } else if (state.step === 'awaiting_brochure') {
            if (cmd === 'skip') {
                state.brochure = null;
                state.step = 'awaiting_option_name';
                await sendMessageWithAntiBan(sessionId, sock, targetJid, { text: `Brochure skipped. Send an option name and price (e.g., '2BHK - 50 Lac'), or type 'done' to finish.` }, true);
            } else if (msg.message.documentMessage || msg.message.documentWithCaptionMessage) {
                let uploadInterval;
                try {
                    await sendMessageWithAntiBan(sessionId, sock, targetJid, { text: `Uploading brochure...` }, true);
                    console.log('Downloading document from WhatsApp...');

                    uploadInterval = setInterval(() => {
                        sendMessageWithAntiBan(sessionId, sock, targetJid, { text: `Still uploading, please wait...` }, true).catch(() => { });
                    }, 30000);

                    let mediaMsg = msg;
                    if (msg.message?.documentWithCaptionMessage) {
                        mediaMsg = {
                            ...msg,
                            message: msg.message.documentWithCaptionMessage.message
                        };
                    }

                    let buffer = await downloadMediaMessage(mediaMsg, 'buffer', {}, { logger: pino({ level: 'silent' }) });
                    console.log(`Document downloaded successfully, size: ${buffer.length} bytes`);

                    const docMsg = mediaMsg.message.documentMessage;
                    const mimetype = docMsg?.mimetype || 'application/pdf';
                    const filename = docMsg?.fileName || `brochure.pdf`;

                    if (mimetype === 'application/pdf') {
                        buffer = await compressPDF(buffer);
                    }

                    const url = await uploadToCloudinary(buffer, mimetype, filename);
                    state.brochure = url;
                    state.step = 'awaiting_option_name';
                    await sendMessageWithAntiBan(sessionId, sock, targetJid, { text: `Brochure uploaded successfully: ${url}\nNow, send an option name and price (e.g., '2BHK - 50 Lac'), or type 'done' to finish.` }, true);
                } catch (err) {
                    console.error('Upload error:', err);
                    await sendMessageWithAntiBan(sessionId, sock, targetJid, { text: `Failed to upload brochure: ${err.message}` }, true);
                } finally {
                    if (uploadInterval) clearInterval(uploadInterval);
                }
            } else {
                await sendMessageWithAntiBan(sessionId, sock, targetJid, { text: `Please send a PDF document, or type 'skip'.` }, true);
            }
            return true;
        } else if (state.step === 'awaiting_option_name') {
            if (cmd === 'done') {
                if (state.options.length > 0) {
                    if (societiesCollection) {
                        const botInfo = getBotNumberInfo(sock, sessionId);
                        await societiesCollection.updateOne(
                            { name: state.societyName },
                            {
                                $set: {
                                    name: state.societyName,
                                    options: state.options,
                                    brochure: state.brochure,
                                    sessionId: sessionId,
                                    number: botInfo.cleanNumber
                                }
                            },
                            { upsert: true }
                        );
                    }
                    await sendMessageWithAntiBan(sessionId, sock, targetJid, { text: `Society '${state.societyName}' saved successfully!` }, true);
                } else {
                    await sendMessageWithAntiBan(sessionId, sock, targetJid, { text: `No options added. Operation cancelled.` }, true);
                }
                adminState.delete(actualRemoteJid);
            } else {
                state.currentOption = { name: textMessage.trim(), images: [], videos: [] };
                state.step = 'awaiting_media';
                await sendMessageWithAntiBan(sessionId, sock, targetJid, { text: `Option '${state.currentOption.name}' created. Now, send all photos and videos for this option. Type 'done' when you have sent all media.` }, true);
            }
            return true;
        } else if (state.step === 'awaiting_media') {
            if (cmd === 'done') {
                state.options.push(state.currentOption);
                state.step = 'awaiting_option_name';
                await sendMessageWithAntiBan(sessionId, sock, targetJid, { text: `Media saved for '${state.currentOption.name}'. Send the next option (e.g., '3BHK - 80 Lac') or type 'done' to finish.` }, true);
            } else if (msg.message.imageMessage || msg.message.videoMessage) {
                let uploadInterval;
                try {
                    await sendMessageWithAntiBan(sessionId, sock, targetJid, { text: `Uploading media...` }, true);
                    uploadInterval = setInterval(() => {
                        sendMessageWithAntiBan(sessionId, sock, targetJid, { text: `Still uploading, please wait...` }, true).catch(() => { });
                    }, 30000);

                    const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: pino({ level: 'silent' }) });
                    const isImage = !!msg.message.imageMessage;
                    const mimetype = isImage ? msg.message.imageMessage.mimetype : msg.message.videoMessage.mimetype;
                    const ext = isImage ? 'jpeg' : 'mp4';
                    const filename = `upload.${ext}`;

                    const url = await uploadToCloudinary(buffer, mimetype, filename);
                    if (url && url.trim() !== '') {
                        if (isImage) {
                            state.currentOption.images.push(url.trim());
                        } else {
                            state.currentOption.videos.push(url.trim());
                        }
                    }
                    await sendMessageWithAntiBan(sessionId, sock, targetJid, { text: `Uploaded successfully: ${url}` }, true);
                } catch (err) {
                    console.error('Upload error:', err);
                    await sendMessageWithAntiBan(sessionId, sock, targetJid, { text: `Failed to upload media: ${err.message}` }, true);
                } finally {
                    if (uploadInterval) clearInterval(uploadInterval);
                }
            } else {
                await sendMessageWithAntiBan(sessionId, sock, targetJid, { text: `Please send an image or video, or type 'done'.` }, true);
            }
            return true;
        }
    }

    return false;
}
