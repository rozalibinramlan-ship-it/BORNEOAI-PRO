// ========================================
// NEWS SERVICE — Borneo Pro Trade V3
// Handle semua logic news: countdown, bias, alert
// ========================================

const axios = require('axios');

const BIQUOTE_URL = 'https://biquote.io/api';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';

// ===== HELPER =====
function safeStr(v) { return v === null || v === undefined ? '' : String(v); }
function safeNum(v) {
    if (v === null || v === undefined) return 0;
    if (typeof v === 'number') return v;
    const n = parseFloat(String(v).replace(/[^0-9.-]/g, ''));
    return isNaN(n) ? 0 : n;
}

// ===== TELEGRAM SENDER =====
async function sendTelegram(message) {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return false;
    try {
        const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
        await axios.post(url, {
            chat_id: TELEGRAM_CHAT_ID,
            text: message,
            parse_mode: 'HTML'
        }, { timeout: 8000 });
        console.log("📱 Telegram news alert sent");
        return true;
    } catch (e) {
        console.log("❌ Telegram error:", e.message);
        return false;
    }
}

// ===== AMBIL SEMUA EVENT USD DARI BIQUOTE =====
async function getAllUsdEvents() {
    try {
        const response = await axios.get(`${BIQUOTE_URL}/calendar`, { timeout: 10000 })
            .catch(() => ({ data: { events: [] } }));
        const d = response.data;
        let events = d.events || d.data || d.calendar || (Array.isArray(d) ? d : []);
        if (!Array.isArray(events)) events = [];

        const now = Date.now();
        return events
            .filter(e => {
                const cur = safeStr(e.currency || e.country).toUpperCase();
                return cur === 'USD' || cur === 'US';
            })
            .map(e => {
                const timeStr = safeStr(e.time || e.date || e.datetime || '');
                const ts = new Date(timeStr).getTime();
                return {
                    time: timeStr,
                    timestamp: ts,
                    currency: safeStr(e.currency || 'USD'),
                    impact: safeStr(e.impact || 'medium').toLowerCase(),
                    event: safeStr(e.event || e.title || e.name || ''),
                    actual: safeStr(e.actual || '-'),
                    forecast: safeStr(e.forecast || e.estimate || '-'),
                    previous: safeStr(e.previous || e.prior || '-'),
                    minutesUntil: !isNaN(ts) ? Math.round((ts - now) / 60000) : null
                };
            })
            .filter(e => !isNaN(e.timestamp))
            .sort((a, b) => a.timestamp - b.timestamp);
    } catch (e) {
        console.error("getAllUsdEvents error:", e.message);
        return [];
    }
}

// ===== KIRA BIAS DARI FORECAST vs PREVIOUS =====
function calculateBias(event) {
    const forecastNum = safeNum(event.forecast);
    const previousNum = safeNum(event.previous);
    const actualNum = safeNum(event.actual);

    // Kalau dah ada actual (news sudah keluar)
    if (actualNum > 0 && forecastNum > 0) {
        if (actualNum > forecastNum) {
            return {
                bias: "BEARISH GOLD",
                setup: "SELL",
                reason: `Actual (${actualNum}) > Forecast (${forecastNum}) → USD kuat → Gold turun`,
                confidence: 75
            };
        }
        if (actualNum < forecastNum) {
            return {
                bias: "BULLISH GOLD",
                setup: "BUY",
                reason: `Actual (${actualNum}) < Forecast (${forecastNum}) → USD lemah → Gold naik`,
                confidence: 75
            };
        }
        return { bias: "NEUTRAL", setup: "WAIT", reason: "Actual = Forecast", confidence: 50 };
    }

    // Kalau belum ada actual — prediction guna forecast vs previous
    if (forecastNum > 0 && previousNum > 0) {
        if (forecastNum > previousNum) {
            return {
                bias: "BEARISH GOLD",
                setup: "SELL",
                reason: `Forecast (${forecastNum}) > Previous (${previousNum}) → USD kuat → Gold lemah`,
                confidence: 68
            };
        }
        if (forecastNum < previousNum) {
            return {
                bias: "BULLISH GOLD",
                setup: "BUY",
                reason: `Forecast (${forecastNum}) < Previous (${previousNum}) → USD lemah → Gold naik`,
                confidence: 68
            };
        }
        return { bias: "NEUTRAL", setup: "WAIT", reason: "Forecast = Previous", confidence: 50 };
    }

    return { bias: "NEUTRAL", setup: "WAIT", reason: "Data tak cukup", confidence: 30 };
}

// ===== AMBIL NEWS TERDEKAT (UNTUK COUNTDOWN) =====
async function getNextNews() {
    const events = await getAllUsdEvents();
    const now = Date.now();
    const upcoming = events.filter(e => e.timestamp > now && (e.impact === 'high' || e.impact === '3'));
    if (upcoming.length > 0) return upcoming[0];
    const past = events.filter(e => e.impact === 'high' || e.impact === '3');
    return past.length > 0 ? past[past.length - 1] : null;
}

// ===== NEWS DALAM 30 MINIT =====
async function getNewsWithin30Min() {
    const events = await getAllUsdEvents();
    const now = Date.now();
    return events.filter(e => {
        const diffMin = (e.timestamp - now) / 60000;
        return diffMin > 0 && diffMin <= 30 && (e.impact === 'high' || e.impact === '3');
    });
}

// ===== NEWS DALAM 5 MINIT =====
async function getNewsWithin5Min() {
    const events = await getAllUsdEvents();
    const now = Date.now();
    return events.filter(e => {
        const diffMin = (e.timestamp - now) / 60000;
        return diffMin > 0 && diffMin <= 5 && (e.impact === 'high' || e.impact === '3');
    });
}

// ===== FORMAT COUNTDOWN =====
function formatCountdown(minutes) {
    if (minutes === null || minutes === undefined) return "--:--";
    if (minutes < 0) return "SUDAH LEPAS";
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    if (h > 0) return `${h}j ${m}m`;
    return `${m} minit`;
}

// ===== BUILD RESPONSE UNTUK API =====
async function getNewsPrediction() {
    const nextEvent = await getNextNews();
    if (!nextEvent) {
        return { status: 'success', hasNews: false, message: 'Tiada news besar terdekat' };
    }

    const bias = calculateBias(nextEvent);
    const minutesUntil = nextEvent.minutesUntil;
    const countdown = formatCountdown(minutesUntil);

    // Action berdasarkan masa
    let action = "Monitor";
    if (minutesUntil > 30) action = "Prepare — news masih jauh";
    else if (minutesUntil > 5) action = "Standby — news hampir keluar";
    else if (minutesUntil > 0) action = "Get ready — news dalam beberapa minit";
    else action = "News sudah keluar — tunggu candle confirm";

    return {
        status: 'success',
        hasNews: true,
        event: {
            name: nextEvent.event,
            time: nextEvent.time,
            impact: nextEvent.impact,
            forecast: nextEvent.forecast,
            previous: nextEvent.previous,
            actual: nextEvent.actual,
            minutesUntil: minutesUntil,
            countdown: countdown
        },
        prediction: {
            bias: bias.bias,
            setup: bias.setup,
            confidence: bias.confidence,
            reason: bias.reason,
            action: action
        }
    };
}

// ===== TRACK ALERT (ELAK SPAM) =====
let alerted30Min = new Set();
let alerted5Min = new Set();

// ===== CHECK & HANTAR TELEGRAM =====
async function checkAndAlert() {
    try {
        // Alert 30 minit sebelum
        const news30 = await getNewsWithin30Min();
        for (const n of news30) {
            const key = `${n.event}_${n.timestamp}`;
            if (!alerted30Min.has(key) && n.minutesUntil >= 25 && n.minutesUntil <= 30) {
                alerted30Min.add(key);
                const bias = calculateBias(n);
                await sendTelegram(
                    `⏰ <b>NEWS ALERT — 30 MINIT</b>\n` +
                    `━━━━━━━━━━━━━━━━\n` +
                    `📊 ${n.event}\n` +
                    `🕐 ${n.time}\n\n` +
                    `🎯 Bias: <b>${bias.bias}</b>\n` +
                    `💪 Confidence: ${bias.confidence}%\n` +
                    `📝 ${bias.reason}\n\n` +
                    `💡 ${bias.setup === 'SELL' ? 'Bersedia untuk SELL' : bias.setup === 'BUY' ? 'Bersedia untuk BUY' : 'Tunggu confirm'}`
                );
            }
        }

        // Alert 5 minit sebelum
        const news5 = await getNewsWithin5Min();
        for (const n of news5) {
            const key = `${n.event}_${n.timestamp}`;
            if (!alerted5Min.has(key)) {
                alerted5Min.add(key);
                const bias = calculateBias(n);
                await sendTelegram(
                    `⚠️ <b>NEWS DALAM ${n.minutesUntil} MINIT</b>\n` +
                    `━━━━━━━━━━━━━━━━\n` +
                    `📊 ${n.event}\n` +
                    `🎯 Bias: <b>${bias.bias}</b>\n\n` +
                    `💡 Tunggu candle confirm selepas news!\n` +
                    `⏰ Standby — jangan entry dulu`
                );
            }
        }

        // Reset set (elak memory leak)
        if (alerted30Min.size > 100) alerted30Min.clear();
        if (alerted5Min.size > 100) alerted5Min.clear();
    } catch (e) {
        console.log("checkAndAlert error:", e.message);
    }
}

// ===== GET NEWS WITH FULL INFO (UNTUK API) =====
async function getNewsWithAlerts() {
    const within30 = await getNewsWithin30Min();
    const within5 = await getNewsWithin5Min();
    const next = await getNextNews();

    return {
        status: 'success',
        nextEvent: next,
        hasNews30Min: within30.length > 0,
        hasNews5Min: within5.length > 0,
        news30Min: within30,
        news5Min: within5
    };
}

// ===== EXPORT =====
module.exports = {
    getAllUsdEvents,
    getNextNews,
    getNewsWithin30Min,
    getNewsWithin5Min,
    getNewsPrediction,
    getNewsWithAlerts,
    calculateBias,
    checkAndAlert,
    sendTelegram
};