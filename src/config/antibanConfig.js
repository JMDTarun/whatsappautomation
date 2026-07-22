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
            maxPerMinute: 3,                 // Ultra-safe: Max 3 messages per minute
            maxPerHour: 30,                  // Ultra-safe: Max 30 messages per hour
            maxPerDay: 250,                  // Ultra-safe: Max 250 messages per day
            minDelayMs: 2500,                // 2.5s minimum human typing/reading delay
            maxDelayMs: 8000,                // 8s maximum human typing/reading delay
            newChatDelayMs: 12000,           // 12s extra delay for first-time contacts
            maxIdenticalMessages: 2,         // Maximum 2 identical message repetitions
            identicalMessageWindowMs: 15 * 60 * 1000, // 15-minute identical message window
            warmupDays: 10,                  // Extended 10-day warm-up progression
            day1Limit: 10,                   // Day 1 limit: 10 messages max
            growthFactor: 1.2,               // Gradual 1.2x daily volume growth
            autoPauseAt: 'medium',           // Early auto-pause when health risk hits medium
            reconnectThrottle: {
                enabled: true,
                rampDurationMs: 10 * 60 * 1000, // 10 minutes (600,000ms) human ramp-up window after reconnection
                initialRateMultiplier: 0.05,    // Start at 5% rate multiplier immediately after reconnecting
                rampSteps: 10,                  // 10 gradual steps (1 min per step) back to full speed
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
