/**
 * Utility functions for handling WhatsApp phone numbers, JIDs, and society database queries.
 */

/**
 * Safely extracts a clean numeric phone number from a WhatsApp JID or number string.
 * Handles Baileys multi-device suffixes (e.g. :4), domain suffixes (@s.whatsapp.net, @lid), and non-digits.
 * E.g.: "919212345678:4@s.whatsapp.net" -> "919212345678"
 * 
 * @param {string} jidOrId 
 * @returns {string}
 */
export function extractPhoneNumber(jidOrId) {
    if (!jidOrId) return '';
    const base = String(jidOrId).split(':')[0].split('@')[0];
    return base.replace(/\D/g, '');
}

/**
 * Extracts bot number details including full numeric digits and last 10 digits (national format).
 * 
 * @param {object} sock Baileys socket object
 * @param {string} sessionId Active session ID
 * @returns {{ cleanNumber: string, last10: string, sessionId: string }}
 */
export function getBotNumberInfo(sock, sessionId) {
    const rawJid = sock?.user?.id || '';
    const cleanNumber = extractPhoneNumber(rawJid) || extractPhoneNumber(sessionId);
    const last10 = cleanNumber && cleanNumber.length >= 10 ? cleanNumber.slice(-10) : cleanNumber;
    return { cleanNumber, last10, sessionId };
}

/**
 * Builds a flexible MongoDB query for searching societies by bot number, session ID, or unassigned societies.
 * Supports matching 12-digit numbers, 10-digit numbers, partial regex, session IDs, and unassigned documents.
 * 
 * @param {string} searchArg User arguments passed to command (or empty string for default)
 * @param {object} sock Baileys socket object
 * @param {string} sessionId Active session ID
 * @returns {object} MongoDB query object
 */
export function buildSocietyQuery(searchArg = '', sock = null, sessionId = '') {
    const trimmedArg = searchArg ? String(searchArg).trim() : '';

    if (!trimmedArg) {
        const { cleanNumber, last10 } = getBotNumberInfo(sock, sessionId);
        const orConditions = [
            { number: { $exists: false } },
            { sessionId: { $exists: false } },
            { number: null },
            { sessionId: null },
            { number: '' },
            { sessionId: '' }
        ];

        if (sessionId) {
            orConditions.push({ sessionId: sessionId });
        }

        if (cleanNumber) {
            orConditions.push({ number: cleanNumber });
            orConditions.push({ sessionId: cleanNumber });
        }

        if (last10) {
            orConditions.push({ number: last10 });
            orConditions.push({ number: { $regex: last10, $options: 'i' } });
            orConditions.push({ sessionId: { $regex: last10, $options: 'i' } });
        }

        return { $or: orConditions };
    }

    if (trimmedArg.toLowerCase() === 'all') {
        return {};
    }

    const searchNum = extractPhoneNumber(trimmedArg);
    if (searchNum) {
        const last10 = searchNum.length >= 10 ? searchNum.slice(-10) : searchNum;
        return {
            $or: [
                { number: searchNum },
                { number: last10 },
                { number: { $regex: last10, $options: 'i' } },
                { sessionId: trimmedArg },
                { sessionId: searchNum },
                { sessionId: { $regex: trimmedArg, $options: 'i' } }
            ]
        };
    }

    return {
        $or: [
            { sessionId: trimmedArg },
            { sessionId: { $regex: trimmedArg, $options: 'i' } }
        ]
    };
}
