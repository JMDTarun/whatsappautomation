export const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000; // 19800000 ms (+5:30)

/**
 * Returns a Date object shifted by +5:30 where UTC getters (getUTCHours, getUTCDate, etc.)
 * reflect the current date and time in IST (Asia/Kolkata).
 */
export function getISTDate(date = new Date()) {
    return new Date(date.getTime() + IST_OFFSET_MS);
}

/**
 * Checks if a given Date falls within Night Quiet Hours in IST (09:00 PM to 07:30 AM IST).
 */
export function isNightTimeIST(date = new Date()) {
    const ist = getISTDate(date);
    const hour = ist.getUTCHours();
    const minute = ist.getUTCMinutes();

    // Night quiet hours: 21:00 (09:00 PM IST) up to 07:30 AM IST
    if (hour >= 21 || hour < 7 || (hour === 7 && minute < 30)) {
        return true;
    }
    return false;
}

/**
 * Calculates scheduled delivery Date.
 * - During IST Night Hours (21:00 to 07:30 IST): Schedules for next morning between 07:30 AM and 08:30 AM IST.
 * - During Daytime (07:30 to 21:00 IST): Uses customDelayMs if provided, or defaults to 1-5 minutes randomized delay.
 */
export function calculateScheduledTime(customDelayMs = null, now = new Date()) {
    const isNight = isNightTimeIST(now);

    if (isNight) {
        const istNow = getISTDate(now);
        const istHour = istNow.getUTCHours();

        const targetIst = new Date(istNow);
        if (istHour >= 21) {
            // Message received after 9 PM IST -> schedule for tomorrow morning
            targetIst.setUTCDate(targetIst.getUTCDate() + 1);
        }
        // Set target time to 07:30:00.000 IST
        targetIst.setUTCHours(7, 30, 0, 0);

        // Add random offset between 0 and 60 minutes (07:30 AM to 08:30 AM IST)
        const randomMorningOffsetMs = Math.floor(Math.random() * (60 * 60 * 1000));
        const scheduledIstMs = targetIst.getTime() + randomMorningOffsetMs;

        // Convert IST timestamp back to true UTC Date
        return new Date(scheduledIstMs - IST_OFFSET_MS);
    } else {
        if (customDelayMs !== null && customDelayMs >= 0) {
            return new Date(now.getTime() + customDelayMs);
        }
        // Daytime (07:30 AM to 09:00 PM IST): 1 to 5 minutes randomized delay
        const minDayMs = 1 * 60 * 1000;   // 1 minute
        const maxDayMs = 5 * 60 * 1000;   // 5 minutes
        const delayMs = Math.floor(Math.random() * (maxDayMs - minDayMs + 1) + minDayMs);
        return new Date(now.getTime() + delayMs);
    }
}
