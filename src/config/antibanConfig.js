import { AntiBan, createJidCircuitBreaker } from 'baileys-antiban';

const antiBans = new Map();
const circuitBreakers = new Map();

export function getOrCreateCircuitBreaker(sessionId) {
    if (!circuitBreakers.has(sessionId)) {
        circuitBreakers.set(sessionId, createJidCircuitBreaker({
            failureThreshold: 2,             // Early cooldown after 2 consecutive errors to a recipient
            resetTimeoutMs: 30 * 60 * 1000,  // 30-minute cooldown for problematic/failed recipient JIDs
        }));
    }
    return circuitBreakers.get(sessionId);
}

export function getOrCreateAntiBan(sessionId, warmUpState = null) {
    if (!antiBans.has(sessionId)) {
        const antiban = new AntiBan({
            maxPerMinute: 10,                 // Max 10 messages per minute
            maxPerHour: 100,                 // Max 100 messages per hour
            maxPerDay: 500,                  // Max 500 messages per day
            minDelayMs: 2500,                // 2.5s minimum human typing/reading delay
            maxDelayMs: 8000,                // 8s maximum human typing/reading delay
            newChatDelayMs: 12000,           // 12s extra delay for first-time contacts
            maxIdenticalMessages: 2,         // Maximum 2 identical message repetitions
            identicalMessageWindowMs: 15 * 60 * 1000, // 15-minute identical message window
            warmupDays: 3,                   // 3-day warm-up progression
            day1Limit: 200,                  // Day 1 limit: 200 messages
            warmUp: {
                day1Limit: 200,
                warmUpDays: 3,
                growthFactor: 1.5
            },
            growthFactor: 1.5,               // 1.5x daily volume growth
            autoPauseAt: 'high',             // Auto-pause when health risk hits high
            reconnectThrottle: {
                enabled: false,
            },
            presence: {
                enabled: true,
                typingProbability: 0.95,       // Send human typing status for 95% of messages
            },
            replyRatio: {
                enabled: true,                 // Monitor sent vs received message balance
                targetRatio: 0.6,
            },
            contactGraph: {
                enabled: true,
                maxColdContactsPerDay: 10,     // Ultra-safe: Max 10 new cold contacts/day
            },
            timelock: {
                enabled: true,                 // Detect reachout time-locks and 463 error codes
            },
            retryTracker: {
                enabled: true,                 // Track MAC errors and WA retry error codes
            },
            topologyThrottler: {
                enabled: true,                 // Differentiate rate limits between groups and individual DMs
            },
            sessionStability: {
                enabled: true,                 // Monitor session stability and disconnect classifications
            },
            logging: false,
        }, warmUpState);

        antiBans.set(sessionId, antiban);
    }
    return antiBans.get(sessionId);
}

export function getAntiBansMap() {
    return antiBans;
}

export function getCircuitBreakersMap() {
    return circuitBreakers;
}
