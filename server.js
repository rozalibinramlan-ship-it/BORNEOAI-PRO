// ===============================================
// BPT — Borneo Pro Trade
// Versi J: Logo + Auto TP + Auto Lot + Partial Close + Trailing + News Filter
// ===============================================

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const FormData = require('form-data');
const { GoogleGenAI } = require('@google/genai');
require('dotenv').config();

const newsService = require('./news-service');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// ===============================================
// CONFIG
// ===============================================
const TWELVEDATA_URL = 'https://api.twelvedata.com';
const BIQUOTE_URL = 'https://biquote.io/api';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const ACCOUNT_BALANCE = parseFloat(process.env.ACCOUNT_BALANCE || '1000');
const RISK_PERCENT = parseFloat(process.env.RISK_PERCENT || '1');
const ADMIN_KEY = process.env.ADMIN_KEY || 'bpt-secret-2024';

const FIXED_LOT = parseFloat(process.env.FIXED_LOT || '0.01');
const USE_FIXED_LOT = process.env.USE_FIXED_LOT === 'true';

// ===== SETTINGS =====
const CANDLE_BODY_MIN = 0.30;
const SCORE_CUN = 90;
const SCORE_BOLEH = 70;
const SCORE_CHOPPY_DIFF = 10;
const ENTRY_ZONE_MULTIPLIER = 0.8;

// ✅ PARTIAL CLOSE
const PARTIAL_CLOSE = {
    TP1: 40,
    TP2: 30,
    TP3: 30
};

// ✅ TRAILING STOP
const TRAILING_CONFIG = {
    enabled: true,
    breakevenAt: 2.0,
    lockAt: 4.0,
    trailStep: 1.0
};

// ✅ NEWS FILTER
const NEWS_FILTER = {
    enabled: true,
    minutesBefore: 15,
    minutesAfter: 15,
    minImpact: 'high'
};

// ===== TOUCH_THRESHOLD per-symbol =====
const TOUCH_THRESHOLD = {
    'XAU/USD': 0.0008,
    'XAG/USD': 0.0010,
    'EUR/USD': 0.0003,
    'GBP/USD': 0.0003,
    'USD/JPY': 0.0003,
    'AUD/USD': 0.0003,
    'USD/CAD': 0.0003,
    'USD/CHF': 0.0003,
    'SPX500': 0.0008,
    'NAS100': 0.0008,
    'US30': 0.0008,
    'DEFAULT': 0.0005
};

// ===============================================
// SPREAD INFO
// ===============================================
const SPREAD_INFO = {
    'XAU/USD': { ideal: 0.50, warn: 0.80, high: 1.20, extreme: 2.00 },
    'XAG/USD': { ideal: 0.02, warn: 0.03, high: 0.05, extreme: 0.10 },
    'EUR/USD': { ideal: 0.00015, warn: 0.00025, high: 0.00040, extreme: 0.00080 },
    'GBP/USD': { ideal: 0.00020, warn: 0.00035, high: 0.00050, extreme: 0.00100 },
    'USD/JPY': { ideal: 0.015, warn: 0.025, high: 0.040, extreme: 0.080 },
    'DEFAULT': { ideal: 0.0003, warn: 0.0005, high: 0.0010, extreme: 0.0020 }
};

// ===============================================
// TWELVEDATA KEY ROTATION
// ===============================================
const TWELVEDATA_KEYS = [
    process.env.TWELVEDATA_API_KEY || '',
    process.env.TWELVEDATA_API_KEY_2 || '',
    process.env.TWELVEDATA_API_KEY_3 || ''
].filter(k => k.length > 0);

let currentKeyIndex = 0;

function getCurrentKey() {
    return TWELVEDATA_KEYS[currentKeyIndex] || TWELVEDATA_KEYS[0] || '';
}

function switchKey() {
    if (TWELVEDATA_KEYS.length > 1) {
        currentKeyIndex = (currentKeyIndex + 1) % TWELVEDATA_KEYS.length;
        console.log(`🔄 Switch ke API key #${currentKeyIndex + 1}`);
    }
}

console.log(`✅ TwelveData: ${TWELVEDATA_KEYS.length} API key dimuatkan`);

// ===============================================
// AI (GEMINI)
// ===============================================
if (!process.env.GEMINI_API_KEY) console.error("⚠️ GEMINI_API_KEY tidak dijumpai!");

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || 'MISSING_KEY' });

const AI_MODELS = ['gemini-2.0-flash', 'gemini-1.5-flash'];
let workingModel = null;

async function callAI(prompt) {
    if (workingModel) {
        try {
            const r = await ai.models.generateContent({ model: workingModel, contents: prompt });
            return r.text;
        } catch (e) { workingModel = null; }
    }
    let lastErr = null;
    for (const model of AI_MODELS) {
        try {
            const r = await ai.models.generateContent({ model: model, contents: prompt });
            console.log("✅ AI guna model:", model);
            workingModel = model;
            return r.text;
        } catch (e) {
            console.log("❌ " + model + " gagal:", (e.message || '').substring(0, 120));
            lastErr = e;
        }
    }
    throw lastErr || new Error("Semua model gagal");
}

// ===============================================
// TELEGRAM — dengan logo.png
// ===============================================
const LOGO_PATH = path.join(__dirname, 'logo.png');

let logoBuffer = null;
let logoChecked = false;

function getLogoBuffer() {
    if (logoChecked) return logoBuffer;
    logoChecked = true;

    try {
        if (fs.existsSync(LOGO_PATH)) {
            logoBuffer = fs.readFileSync(LOGO_PATH);
            console.log(`✅ Logo loaded: ${(logoBuffer.length / 1024).toFixed(1)} KB`);
        } else {
            console.log(`⚠️ Logo tak jumpa: ${LOGO_PATH}`);
        }
    } catch (e) {
        console.log(`❌ Logo read error: ${e.message}`);
    }
    return logoBuffer;
}

async function sendTelegram(message, withLogo = true) {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;

    const logo = getLogoBuffer();

    // Cuba hantar dengan logo
    if (withLogo && logo) {
        try {
            const form = new FormData();
            form.append('chat_id', TELEGRAM_CHAT_ID);
            form.append('photo', logo, { filename: 'logo.png' });
            form.append('caption', message);
            form.append('parse_mode', 'HTML');

            const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendPhoto`;
            await axios.post(url, form, {
                headers: form.getHeaders(),
                timeout: 20000,
                maxContentLength: Infinity,
                maxBodyLength: Infinity
            });
            console.log("📱 Telegram sent (with logo)");
            return;
        } catch (e) {
            console.log("⚠️ Logo gagal, fallback ke text:", e.message);
        }
    }

    // Fallback — text saja
    try {
        const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
        await axios.post(url, {
            chat_id: TELEGRAM_CHAT_ID,
            text: message,
            parse_mode: 'HTML'
        }, { timeout: 8000 });
        console.log("📱 Telegram sent (text)");
    } catch (e) {
        console.log("❌ Telegram error:", e.message);
    }
}

// ===============================================
// HELPERS
// ===============================================
const symbolMap = {
    'XAU/USD': 'XAU/USD', 'XAG/USD': 'XAG/USD',
    'EUR/USD': 'EUR/USD', 'GBP/USD': 'GBP/USD', 'USD/JPY': 'USD/JPY',
    'AUD/USD': 'AUD/USD', 'USD/CAD': 'USD/CAD', 'USD/CHF': 'USD/CHF',
    'SPX500': 'SPX', 'NAS100': 'NDX', 'US30': 'DJI'
};

function toTwelveData(s) { return symbolMap[s] || s; }

function getDecimal(s) {
    if (s.includes('JPY')) return 3;
    if (['SPX500', 'NAS100', 'US30'].some(x => s.includes(x))) return 1;
    if (s.includes('XAU') || s.includes('XAG')) return 2;
    return 5;
}

function getPipSize(symbol) {
    if (symbol.includes('JPY')) return 0.01;
    if (symbol.includes('XAU')) return 0.10;
    if (symbol.includes('XAG')) return 0.01;
    if (['SPX500', 'NAS100', 'US30'].some(x => symbol.includes(x))) return 1.0;
    return 0.0001;
}

function getTouchThreshold(symbol) {
    return TOUCH_THRESHOLD[symbol] || TOUCH_THRESHOLD['DEFAULT'];
}

function getValuePerPointPerLot(symbol) {
    if (symbol.includes('XAU')) return 100;
    if (symbol.includes('XAG')) return 5000;
    if (symbol.includes('JPY')) return 1000;
    if (['SPX500', 'NAS100', 'US30'].some(x => symbol.includes(x))) return 1;
    return 100000;
}

function getSpreadInfo(symbol, spread) {
    const limit = SPREAD_INFO[symbol] || SPREAD_INFO['DEFAULT'];
    if (!spread || spread <= 0) return { level: 'UNKNOWN', icon: '❓', text: 'Takde data', color: '#94a3b8', advice: 'Berhati' };
    if (spread <= limit.ideal) return { level: 'IDEAL', icon: '✅', text: 'Spread bagus', color: '#22c55e', advice: 'Selamat' };
    if (spread <= limit.warn) return { level: 'NORMAL', icon: '👍', text: 'Spread normal', color: '#22c55e', advice: 'OK' };
    if (spread <= limit.high) return { level: 'WARN', icon: '⚠️', text: 'Spread tinggi sikit', color: '#f59e0b', advice: 'Profit kurang' };
    return { level: 'HIGH', icon: '🔴', text: 'Spread tinggi', color: '#ef4444', advice: 'Fikir dulu' };
}

function calculateEMA(closes, period) {
    if (closes.length === 0) return 0;
    let e = closes[0];
    let k = 2 / (period + 1);
    for (let i = 1; i < closes.length; i++) e = (closes[i] * k) + (e * (1 - k));
    return e;
}

function calculateATR(candles, period = 14) {
    if (candles.length < period + 1) return 0;
    let trs = [];
    for (let i = candles.length - period; i < candles.length; i++) {
        const h = candles[i].high, l = candles[i].low, pc = candles[i - 1].close;
        trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
    }
    return trs.reduce((a, b) => a + b, 0) / period;
}

function getATRProfile(candles) {
    const atrNow = calculateATR(candles, 14);
    const atrAvg = calculateATR(candles, 50);

    if (atrAvg === 0 || atrNow === 0) {
        return { atrNow: 0, atrAvg: 0, ratio: 1, level: 'NORMAL', tp1Mult: 3.0, tp2Mult: 6.0, tp3Mult: 10.0 };
    }

    const ratio = atrNow / atrAvg;
    let level, tp1Mult, tp2Mult, tp3Mult;

    if (ratio >= 1.5) {
        level = 'VOLATILE';
        tp1Mult = 5.0; tp2Mult = 10.0; tp3Mult = 15.0;
    } else if (ratio >= 1.0) {
        level = 'NORMAL';
        tp1Mult = 3.0; tp2Mult = 6.0; tp3Mult = 10.0;
    } else if (ratio >= 0.7) {
        level = 'SLOW';
        tp1Mult = 2.0; tp2Mult = 4.0; tp3Mult = 6.0;
    } else {
        level = 'VERY_SLOW';
        tp1Mult = 1.5; tp2Mult = 3.0; tp3Mult = 4.5;
    }

    return { atrNow, atrAvg, ratio, level, tp1Mult, tp2Mult, tp3Mult };
}

function getMarketSession() {
    const h = new Date().getUTCHours();
    if (h >= 7 && h < 16) return "LONDON";
    if (h >= 12 && h < 21) return "NEW YORK";
    if (h >= 0 && h < 7) return "ASIA";
    return "CLOSED";
}

function getSessionStatus() {
    const session = getMarketSession();
    const statusMap = {
        'LONDON': '🟢 Active',
        'NEW YORK': '🟢 Active',
        'ASIA': '🟡 Slow',
        'CLOSED': '🔴 Closed'
    };
    return { name: session, status: statusMap[session] || 'Unknown' };
}

function safeStr(v) {
    return v === null || v === undefined ? '' : String(v);
}

// ===============================================
// NEWS FILTER
// ===============================================
let newsCache = { events: [], fetchedAt: 0 };
const NEWS_CACHE_MS = 10 * 60 * 1000;

async function getUpcomingNews() {
    if (Date.now() - newsCache.fetchedAt < NEWS_CACHE_MS && newsCache.events.length > 0) {
        return newsCache.events;
    }

    try {
        const response = await axios.get(`${BIQUOTE_URL}/calendar`, { timeout: 10000 })
            .catch(() => ({ data: { events: [] } }));

        const d = response.data;
        let events = d.events || d.data || d.calendar || (Array.isArray(d) ? d : []);
        if (!Array.isArray(events)) events = [];

        newsCache.events = events;
        newsCache.fetchedAt = Date.now();
        return events;
    } catch (e) {
        console.log('News fetch error:', e.message);
        return [];
    }
}

async function checkNewsFilter() {
    if (!NEWS_FILTER.enabled) return { blocked: false, reason: null };

    try {
        const events = await getUpcomingNews();
        const now = new Date();
        const nowMs = now.getTime();

        for (const ev of events) {
            const impact = safeStr(ev.impact || 'medium').toLowerCase();
            if (impact !== NEWS_FILTER.minImpact) continue;

            const timeStr = safeStr(ev.time || ev.date || ev.datetime || '');
            if (!timeStr) continue;

            const evTime = new Date(timeStr).getTime();
            if (isNaN(evTime)) continue;

            const diffMin = (evTime - nowMs) / 60000;

            if (diffMin > 0 && diffMin <= NEWS_FILTER.minutesBefore) {
                return {
                    blocked: true,
                    reason: `News ${ev.event || 'High impact'} dalam ${Math.round(diffMin)} min`,
                    event: ev
                };
            }

            if (diffMin < 0 && Math.abs(diffMin) <= NEWS_FILTER.minutesAfter) {
                return {
                    blocked: true,
                    reason: `News ${ev.event || 'High impact'} baru lepas ${Math.round(Math.abs(diffMin))} min`,
                    event: ev
                };
            }
        }

        return { blocked: false, reason: null };
    } catch (e) {
        console.log('News filter error:', e.message);
        return { blocked: false, reason: null };
    }
}

// ===============================================
// ANALYZE CANDLES
// ===============================================
function analyzeCandles(candles) {
    if (!candles || candles.length < 50) return null;

    const closes = candles.map(c => c.close);
    const ema9 = calculateEMA(closes, 9);
    const ema21 = calculateEMA(closes, 21);
    const ema50 = calculateEMA(closes, 50);

    const gap_9_21 = Math.abs(ema9 - ema21);
    const gap_21_50 = Math.abs(ema21 - ema50);

    const lastCandle = candles[candles.length - 1];
    const bodyRange = lastCandle.high - lastCandle.low;
    const bodySize = Math.abs(lastCandle.close - lastCandle.open);
    const bodyPct = bodyRange > 0 ? bodySize / bodyRange : 0;
    const isBullCandle = lastCandle.close > lastCandle.open;

    let buyScore = 0;
    let sellScore = 0;
    let reasons = [];

    if (ema9 > ema21 && ema21 > ema50) { buyScore += 50; reasons.push('EMA selari BUY (+50)'); }
    if (ema9 > ema21 && gap_9_21 > 0.30) { buyScore += 20; reasons.push('Gap 9-21 > 0.30 (+20)'); }
    if (ema9 > ema21 && gap_9_21 > 0.50) { buyScore += 15; reasons.push('Gap 9-21 > 0.50 (+15)'); }
    if (ema9 > ema21 && gap_9_21 > 0.80) { buyScore += 15; reasons.push('Gap 9-21 > 0.80 (+15)'); }

    if (ema9 < ema21 && ema21 < ema50) { sellScore += 50; reasons.push('EMA selari SELL (+50)'); }
    if (ema9 < ema21 && gap_9_21 > 0.30) { sellScore += 20; reasons.push('Gap 9-21 > 0.30 (+20)'); }
    if (ema9 < ema21 && gap_9_21 > 0.50) { sellScore += 15; reasons.push('Gap 9-21 > 0.50 (+15)'); }
    if (ema9 < ema21 && gap_9_21 > 0.80) { sellScore += 15; reasons.push('Gap 9-21 > 0.80 (+15)'); }

    if (gap_21_50 > 0.20) {
        if (ema21 > ema50) { buyScore += 10; reasons.push('Gap 21-50 > 0.20 (+10)'); }
        else { sellScore += 10; reasons.push('Gap 21-50 > 0.20 (+10)'); }
    }
    if (gap_21_50 > 0.40) {
        if (ema21 > ema50) { buyScore += 10; reasons.push('Gap 21-50 > 0.40 (+10)'); }
        else { sellScore += 10; reasons.push('Gap 21-50 > 0.40 (+10)'); }
    }

    if (gap_21_50 < 0.10) {
        buyScore = Math.round(buyScore * 0.7);
        sellScore = Math.round(sellScore * 0.7);
        reasons.push('⚠️ Gap 21-50 kecil — score × 0.7');
    }

    if (bodyPct >= 0.60) {
        if (isBullCandle) { buyScore += 10; reasons.push('Body Bull ≥60% (+10)'); }
        else { sellScore += 10; reasons.push('Body Bear ≥60% (+10)'); }
    }
    if (bodyPct >= 0.80) {
        if (isBullCandle) { buyScore += 10; reasons.push('Body Bull ≥80% (+10)'); }
        else { sellScore += 10; reasons.push('Body Bear ≥80% (+10)'); }
    }

    let sig = 'WAIT';
    let confidence = 0;
    let label = 'WAIT - SCORE RENDAH';

    const diff = Math.abs(buyScore - sellScore);
    const winner = buyScore > sellScore ? 'BUY' : sellScore > buyScore ? 'SELL' : 'WAIT';
    const winnerScore = Math.max(buyScore, sellScore);

    if (diff < SCORE_CHOPPY_DIFF && winnerScore >= SCORE_BOLEH) {
        sig = 'WAIT'; confidence = 0;
        label = `WAIT - CHOPPY (BUY ${buyScore} vs SELL ${sellScore})`;
        reasons.push(`⚠️ Score rapat (diff ${diff}) — market choppy`);
    }
    else if (winner === 'BUY' && buyScore >= SCORE_CUN) {
        sig = 'BUY'; confidence = Math.min(buyScore, 100);
        label = `BUY ${confidence}% - CUN`;
    }
    else if (winner === 'BUY' && buyScore >= SCORE_BOLEH) {
        sig = 'BUY'; confidence = Math.min(buyScore, 100);
        label = `BUY ${confidence}% - BOLEH TAPI HATI-HATI`;
    }
    else if (winner === 'SELL' && sellScore >= SCORE_CUN) {
        sig = 'SELL'; confidence = Math.min(sellScore, 100);
        label = `SELL ${confidence}% - CUN`;
    }
    else if (winner === 'SELL' && sellScore >= SCORE_BOLEH) {
        sig = 'SELL'; confidence = Math.min(sellScore, 100);
        label = `SELL ${confidence}% - BOLEH TAPI HATI-HATI`;
    }

    return {
        signal: sig, confidence, label,
        ema9, ema21, ema50, gap_9_21, gap_21_50,
        bodyPct, isBullCandle,
        buyScore, sellScore, winner, diff, reasons
    };
}

// ===============================================
// SNR DETECTION
// ===============================================
function detectSNR(candles) {
    if (!candles || candles.length < 50) {
        return { support: 0, resistance: 0, poc: 0, S1: null, S2: null, R1: null, atr: 0, tolerance: 0 };
    }

    const recent = candles.slice(-200);
    const lastPrice = recent[recent.length - 1].close;

    const atrPeriod = 14;
    const atrSlice = recent.slice(-atrPeriod);
    let atrSum = 0;
    for (let c of atrSlice) atrSum += (c.high - c.low);
    const ATR = atrSum / atrPeriod;
    const tolerance = Math.max(lastPrice * 0.002, ATR * 0.4);

    let swingLows = [];
    let swingHighs = [];

    for (let i = 2; i < recent.length - 2; i++) {
        const isLow =
            recent[i].low < recent[i - 1].low &&
            recent[i].low < recent[i - 2].low &&
            recent[i].low < recent[i + 1].low &&
            recent[i].low < recent[i + 2].low;

        const isHigh =
            recent[i].high > recent[i - 1].high &&
            recent[i].high > recent[i - 2].high &&
            recent[i].high > recent[i + 1].high &&
            recent[i].high > recent[i + 2].high;

        if (isLow) swingLows.push({ price: recent[i].low, index: i });
        if (isHigh) swingHighs.push({ price: recent[i].high, index: i });
    }

    function getZoneInfo(level, type, originIndex) {
        let touchesBefore = 0;
        let touchesAfter = 0;
        let originTouch = 0;

        for (let j = 0; j < recent.length; j++) {
            let hit = false;
            if (type === 'support') {
                hit = recent[j].low <= level + tolerance && recent[j].low >= level - tolerance;
            } else {
                hit = recent[j].high >= level - tolerance && recent[j].high <= level + tolerance;
            }

            if (hit) {
                if (j < originIndex) touchesBefore++;
                else if (j > originIndex) touchesAfter++;
                else originTouch++;
            }
        }

        const totalTouches = touchesBefore + originTouch + touchesAfter;

        return {
            strength: Math.min(5, Math.max(1, totalTouches)),
            untested: touchesAfter === 0,
            touches: totalTouches,
            touchesBefore, touchesAfter, originTouch
        };
    }

    const boxSize = Math.max(tolerance * 0.8, lastPrice * 0.001);

    function makeBox(info) {
        if (!info) return null;
        const dynamicBox = boxSize * (1 + (info.strength - 1) * 0.2);
        return {
            mid: info.mid,
            top: info.mid + dynamicBox,
            bottom: info.mid - dynamicBox,
            strength: info.strength,
            untested: info.untested,
            touches: info.touches,
            touchesBefore: info.touchesBefore,
            touchesAfter: info.touchesAfter,
            originTouch: info.originTouch,
            label: `${info.mid.toFixed(2)} ${info.untested ? 'Untested' : 'x' + info.touches}`
        };
    }

    let supports = swingLows.filter(s => s.price < lastPrice).sort((a, b) => b.price - a.price);
    supports = supports.filter((s, i) => i === 0 || Math.abs(s.price - supports[i - 1].price) > tolerance);

    let resistances = swingHighs.filter(s => s.price > lastPrice).sort((a, b) => a.price - b.price);
    resistances = resistances.filter((s, i) => i === 0 || Math.abs(s.price - resistances[i - 1].price) > tolerance);

    let S1_info = supports[0] ? { mid: supports[0].price, ...getZoneInfo(supports[0].price, 'support', supports[0].index) } : null;
    let S2_info = supports[1] ? { mid: supports[1].price, ...getZoneInfo(supports[1].price, 'support', supports[1].index) } : null;
    let R1_info = resistances[0] ? { mid: resistances[0].price, ...getZoneInfo(resistances[0].price, 'resistance', resistances[0].index) } : null;

    return {
        support: S1_info ? S1_info.mid : 0,
        resistance: R1_info ? R1_info.mid : 0,
        poc: lastPrice,
        S1: makeBox(S1_info),
        S2: makeBox(S2_info),
        R1: makeBox(R1_info),
        atr: ATR,
        tolerance: tolerance
    };
}

// ===============================================
// FVG DETECTION
// ===============================================
function detectFVG(candles) {
    if (!candles || candles.length < 3) return { zones: [] };
    const zones = [];
    const recent = candles.slice(-100);

    for (let i = 1; i < recent.length - 1; i++) {
        const c1 = recent[i - 1];
        const c3 = recent[i + 1];
        if (c3.low > c1.high) zones.push({ type: 'BULLISH', top: c3.low, bottom: c1.high, mid: (c3.low + c1.high) / 2 });
        if (c3.high < c1.low) zones.push({ type: 'BEARISH', top: c1.low, bottom: c3.high, mid: (c1.low + c3.high) / 2 });
    }

    const lastPrice = candles[candles.length - 1].close;
    zones.sort((a, b) => Math.abs(a.mid - lastPrice) - Math.abs(b.mid - lastPrice));
    return { zones: zones.slice(0, 5) };
}

// ===============================================
// POC DETECTION
// ===============================================
function detectPOC(candles, bins = 20) {
    if (!candles || candles.length < 20) return null;
    const recent = candles.slice(-200);
    const maxPrice = recent.reduce((a, c) => Math.max(a, c.high), -Infinity);
    const minPrice = recent.reduce((a, c) => Math.min(a, c.low), Infinity);
    const range = maxPrice - minPrice;
    if (range === 0) return null;

    const binSize = range / bins;
    const volumeMap = new Array(bins).fill(0);

    recent.forEach(c => {
        let lowBin = Math.floor((c.low - minPrice) / binSize);
        let highBin = Math.floor((c.high - minPrice) / binSize);
        lowBin = Math.max(0, Math.min(bins - 1, lowBin));
        highBin = Math.max(0, Math.min(bins - 1, highBin));
        for (let b = lowBin; b <= highBin; b++) volumeMap[b]++;
    });

    let maxVol = 0, pocBin = 0;
    for (let i = 0; i < volumeMap.length; i++) {
        if (volumeMap[i] > maxVol) { maxVol = volumeMap[i]; pocBin = i; }
    }
    if (maxVol === 0) return null;
    return { poc: minPrice + (pocBin * binSize) + (binSize / 2) };
}

// ===============================================
// ORDER BLOCK DETECTION
// ===============================================
function detectOrderBlock(candles) {
    if (!candles || candles.length < 5) return { bullish: [], bearish: [] };
    const recent = candles.slice(-100);
    const bullishOBs = [];
    const bearishOBs = [];

    for (let i = 1; i < recent.length - 1; i++) {
        const prev = recent[i - 1];
        const curr = recent[i];
        const currBody = Math.abs(curr.close - curr.open);
        const currRange = curr.high - curr.low;
        const prevIsBullish = prev.close > prev.open;
        const prevIsBearish = prev.close < prev.open;
        const currIsBullish = curr.close > curr.open;
        const currIsBearish = curr.close < curr.open;
        const currBodyPct = currRange > 0 ? currBody / currRange : 0;
        const currIsBig = currBodyPct > 0.6 && currRange > 0;

        if (prevIsBearish && currIsBullish && currIsBig) {
            bullishOBs.push({ type: 'BULLISH_OB', top: prev.high, bottom: prev.low, mid: (prev.high + prev.low) / 2 });
        }
        if (prevIsBullish && currIsBearish && currIsBig) {
            bearishOBs.push({ type: 'BEARISH_OB', top: prev.high, bottom: prev.low, mid: (prev.high + prev.low) / 2 });
        }
    }

    return { bullish: bullishOBs.slice(-3), bearish: bearishOBs.slice(-3) };
}

// ===============================================
// LEVEL TOUCH CHECK
// ===============================================
function checkLevelTouch(price, symbol, snr, fvgZones, pocData, obData) {
    const touched = [];
    const threshold = getTouchThreshold(symbol);
    const tolerance = threshold * 1.5;

    if (snr.S1 && price >= snr.S1.bottom && price <= snr.S1.top) {
        touched.push({ type: 'S1', level: snr.S1.mid, strength: snr.S1.strength, untested: snr.S1.untested });
    }
    if (snr.S2 && price >= snr.S2.bottom && price <= snr.S2.top) {
        touched.push({ type: 'S2', level: snr.S2.mid, strength: snr.S2.strength, untested: snr.S2.untested });
    }
    if (snr.R1 && price >= snr.R1.bottom && price <= snr.R1.top) {
        touched.push({ type: 'R1', level: snr.R1.mid, strength: snr.R1.strength, untested: snr.R1.untested });
    }

    if (!snr.S1 && !snr.R1) {
        const distSupport = Math.abs(price - snr.support) / price;
        const distResistance = Math.abs(price - snr.resistance) / price;
        if (distSupport < tolerance) touched.push({ type: 'SNR_SUPPORT', level: snr.support, strength: 1 });
        if (distResistance < tolerance) touched.push({ type: 'SNR_RESISTANCE', level: snr.resistance, strength: 1 });
    }

    if (fvgZones && fvgZones.length > 0) {
        for (const zone of fvgZones) {
            if (price >= zone.bottom && price <= zone.top) {
                touched.push({ type: 'FVG_' + zone.type, level: zone.mid, strength: 2 });
                break;
            }
            const distZone = Math.min(Math.abs(price - zone.top), Math.abs(price - zone.bottom)) / price;
            if (distZone < tolerance) {
                touched.push({ type: 'FVG_' + zone.type + '_NEAR', level: zone.mid, strength: 1 });
                break;
            }
        }
    }

    if (pocData && pocData.poc && !isNaN(pocData.poc)) {
        if (Math.abs(price - pocData.poc) / price < tolerance) {
            touched.push({ type: 'POC', level: pocData.poc, strength: 2 });
        }
    }

    if (obData) {
        for (const ob of obData.bullish) {
            if (price >= ob.bottom && price <= ob.top) { touched.push({ type: 'BULLISH_OB', level: ob.mid, strength: 3 }); break; }
        }
        for (const ob of obData.bearish) {
            if (price >= ob.bottom && price <= ob.top) { touched.push({ type: 'BEARISH_OB', level: ob.mid, strength: 3 }); break; }
        }
    }

    return {
        touched: touched.length > 0,
        levels: touched,
        tolerance: (tolerance * price).toFixed(2),
        threshold_pct: (threshold * 100).toFixed(3) + '%'
    };
}

// ===============================================
// CANDLE CONFIRM
// ===============================================
function isCandleConfirm(candles, signal) {
    if (!candles || candles.length < 2) return { confirm: false, reason: "Data tak cukup" };
    const c = candles[candles.length - 1];
    const body = Math.abs(c.close - c.open);
    const range = c.high - c.low;
    const isBullish = c.close > c.open;
    const isBearish = c.close < c.open;
    const bodyPct = range > 0 ? body / range : 0;
    const hasBody = bodyPct > CANDLE_BODY_MIN;

    if (signal === "SELL") {
        if (!isBearish) return { confirm: false, reason: "Candle BUKAN merah" };
        if (!hasBody) return { confirm: false, reason: "Body kecil" };
        return { confirm: true, reason: "Candle merah solid" };
    }
    if (signal === "BUY") {
        if (!isBullish) return { confirm: false, reason: "Candle BUKAN hijau" };
        if (!hasBody) return { confirm: false, reason: "Body kecil" };
        return { confirm: true, reason: "Candle hijau solid" };
    }
    return { confirm: false, reason: "Signal tak jelas" };
}

// ===============================================
// MULTI-TIMEFRAME
// ===============================================
async function checkMultiTimeframe(symbol) {
    const timeframes = [
        { tf: '5min', label: 'M5' },
        { tf: '15min', label: 'M15' },
        { tf: '30min', label: 'M30' },
        { tf: '1h', label: 'H1' }
    ];
    const results = [];
    let errors = 0;

    for (const item of timeframes) {
        let tfResult = null;
        try {
            const candles = await getOHLC(symbol, item.tf, 100);
            tfResult = analyzeCandles(candles);
        } catch (e) {
            console.log(`TF ${item.label} fail: ${e.message}`);
            errors++;
        }
        if (tfResult) results.push({ tf: item.tf, label: item.label, signal: tfResult.signal, confidence: tfResult.confidence });
        else results.push({ tf: item.tf, label: item.label, signal: 'WAIT', confidence: 0 });
    }

    const buyCount = results.filter(r => r.signal === 'BUY').length;
    const sellCount = results.filter(r => r.signal === 'SELL').length;
    const maxCount = Math.max(buyCount, sellCount);
    const majoritySignal = buyCount > sellCount ? 'BUY' : sellCount > buyCount ? 'SELL' : 'WAIT';

    return { timeframes: results, buyCount, sellCount, agreement: `${maxCount}/4`, consensus: majoritySignal, errors };
}

// ===============================================
// CACHE
// ===============================================
const tickCache = new Map();
const TICK_CACHE_MS = 30000;

async function getTick(symbol) {
    const cacheKey = symbol;
    const cached = tickCache.get(cacheKey);
    if (cached && Date.now() - cached.time < TICK_CACHE_MS) return cached.data;

    const tdSymbol = toTwelveData(symbol);
    let attempts = 0;
    let maxAttempts = TWELVEDATA_KEYS.length * 2;

    while (attempts < maxAttempts) {
        attempts++;
        const key = getCurrentKey();
        const url = `${TWELVEDATA_URL}/quote?symbol=${encodeURIComponent(tdSymbol)}&apikey=${key}`;
        try {
            const response = await axios.get(url, { timeout: 10000 });
            const d = response.data;

            if (d.status === 'error' || d.code) {
                if (d.code === 429 || (d.message && d.message.includes('429'))) {
                    switchKey();
                    continue;
                }
                throw new Error(d.message || 'TwelveData error');
            }

            const bid = parseFloat(d.bid || 0);
            const ask = parseFloat(d.ask || 0);
            const price = parseFloat(d.close || d.price || 0);
            const mid = price || (bid + ask) / 2 || 0;

            if (mid === 0) throw new Error('Harga 0.00');

            const result = {
                bid: bid || mid,
                ask: ask || mid,
                mid,
                spread: parseFloat(d.spread || (ask - bid) || 0)
            };

            tickCache.set(cacheKey, { data: result, time: Date.now() });
            return result;
        } catch (e) {
            if (e.message && e.message.includes('429')) {
                switchKey();
                continue;
            }
            if (attempts >= maxAttempts) throw e;
        }
    }
    throw new Error(`Semua API key gagal`);
}

const ohlcCache = new Map();
const OHLC_CACHE_MS = 180000;

async function getOHLC(symbol, interval = '5min', limit = 300) {
    const cacheKey = `${symbol}_${interval}_${limit}`;
    const cached = ohlcCache.get(cacheKey);
    if (cached && Date.now() - cached.time < OHLC_CACHE_MS) return cached.data;

    const tdSymbol = toTwelveData(symbol);
    const intervalMap = {
        '1min': '1min', '5min': '5min', '15min': '15min',
        '30min': '30min', '1h': '1h', '4h': '4h'
    };
    const tdInterval = intervalMap[interval] || '5min';

    let attempts = 0;
    let maxAttempts = TWELVEDATA_KEYS.length * 2;

    while (attempts < maxAttempts) {
        attempts++;
        const key = getCurrentKey();
        const url = `${TWELVEDATA_URL}/time_series?symbol=${encodeURIComponent(tdSymbol)}&interval=${tdInterval}&outputsize=${limit}&apikey=${key}`;
        try {
            const response = await axios.get(url, { timeout: 10000 });
            const d = response.data;

            if (d.status === 'error' || d.code) {
                if (d.code === 429 || (d.message && d.message.includes('429'))) {
                    switchKey();
                    continue;
                }
                throw new Error(d.message || 'TwelveData error');
            }

            if (!d.values || !Array.isArray(d.values)) return [];

            const result = d.values.slice().reverse().map(c => ({
                time: c.datetime,
                timestamp: Math.floor(new Date(c.datetime).getTime() / 1000),
                open: parseFloat(c.open || 0),
                high: parseFloat(c.high || 0),
                low: parseFloat(c.low || 0),
                close: parseFloat(c.close || 0)
            })).filter(c => !isNaN(c.timestamp) && c.close > 0);

            ohlcCache.set(cacheKey, { data: result, time: Date.now() });
            return result;
        } catch (e) {
            if (e.message && e.message.includes('429')) {
                switchKey();
                continue;
            }
            if (attempts >= maxAttempts) throw e;
        }
    }
    throw new Error(`Semua API key gagal`);
}

// ===============================================
// SIGNAL LOCK & COOLDOWN
// ===============================================
const signalLock = new Map();
const signalCooldown = new Map();
const COOLDOWN_MS = 5 * 60 * 1000;
const MAX_LOCK_MS = 15 * 60 * 1000;

function formatLockAge(minutes) {
    if (minutes < 1) return 'Baru';
    if (minutes < 60) return `${minutes} minit`;
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return m === 0 ? `${h} jam` : `${h}j ${m}m`;
}

function calculateSLTP(direction, entry, atr, symbol, atrProfile = null) {
    const slDist = atr * 1.5;

    let tp1Mult, tp2Mult, tp3Mult;

    if (atrProfile) {
        tp1Mult = atrProfile.tp1Mult;
        tp2Mult = atrProfile.tp2Mult;
        tp3Mult = atrProfile.tp3Mult;
    } else {
        tp1Mult = 3.0; tp2Mult = 6.0; tp3Mult = 10.0;
    }

    const tp1Dist = atr * tp1Mult;
    const tp2Dist = atr * tp2Mult;
    const tp3Dist = atr * tp3Mult;

    const pipSize = getPipSize(symbol);
    const dec = getDecimal(symbol);

    if (direction === "BUY") {
        return {
            sl: (entry - slDist).toFixed(dec),
            tp1: (entry + tp1Dist).toFixed(dec),
            tp2: (entry + tp2Dist).toFixed(dec),
            tp3: (entry + tp3Dist).toFixed(dec),
            slPips: Math.round(slDist / pipSize),
            tp1Pips: Math.round(tp1Dist / pipSize),
            tp2Pips: Math.round(tp2Dist / pipSize),
            tp3Pips: Math.round(tp3Dist / pipSize),
            tp1Mult, tp2Mult, tp3Mult,
            atr_level: atrProfile ? atrProfile.level : 'N/A',
            atr_ratio: atrProfile ? atrProfile.ratio.toFixed(2) : '1.00',
            rr_tp1: (tp1Dist / slDist).toFixed(2),
            rr_tp2: (tp2Dist / slDist).toFixed(2),
            rr_tp3: (tp3Dist / slDist).toFixed(2)
        };
    } else {
        return {
            sl: (entry + slDist).toFixed(dec),
            tp1: (entry - tp1Dist).toFixed(dec),
            tp2: (entry - tp2Dist).toFixed(dec),
            tp3: (entry - tp3Dist).toFixed(dec),
            slPips: Math.round(slDist / pipSize),
            tp1Pips: Math.round(tp1Dist / pipSize),
            tp2Pips: Math.round(tp2Dist / pipSize),
            tp3Pips: Math.round(tp3Dist / pipSize),
            tp1Mult, tp2Mult, tp3Mult,
            atr_level: atrProfile ? atrProfile.level : 'N/A',
            atr_ratio: atrProfile ? atrProfile.ratio.toFixed(2) : '1.00',
            rr_tp1: (tp1Dist / slDist).toFixed(2),
            rr_tp2: (tp2Dist / slDist).toFixed(2),
            rr_tp3: (tp3Dist / slDist).toFixed(2)
        };
    }
}

function calculateAutoLot(symbol, entry, sl, accountBalance, riskPercent) {
    const riskAmount = accountBalance * (riskPercent / 100);
    const slDistance = Math.abs(entry - sl);
    if (slDistance === 0) return 0.01;

    const valuePerPointPerLot = getValuePerPointPerLot(symbol);
    const rawLot = riskAmount / (slDistance * valuePerPointPerLot);

    let lot = Math.round(rawLot * 100) / 100;
    lot = Math.max(0.01, Math.min(10, lot));
    return lot;
}

function calculatePositionSize(entry, sl, symbol, atr = null) {
    const balance = ACCOUNT_BALANCE;
    const riskAmount = balance * (RISK_PERCENT / 100);
    const pipSize = getPipSize(symbol);
    const slPips = Math.abs(entry - sl) / pipSize;

    let lotSize, lotMode;

    if (USE_FIXED_LOT) {
        lotSize = FIXED_LOT;
        lotMode = 'FIXED';
    } else if (atr) {
        lotSize = calculateAutoLot(symbol, entry, sl, balance, RISK_PERCENT);
        lotMode = 'AUTO';
    } else {
        lotSize = Math.max(0.01, riskAmount / (slPips * 0.10));
        lotMode = 'DYNAMIC';
    }

    const valuePerPointPerLot = getValuePerPointPerLot(symbol);
    const slDistance = Math.abs(entry - sl);
    const potentialLoss = (slDistance * valuePerPointPerLot * lotSize).toFixed(2);

    return {
        balance: balance.toFixed(2),
        riskPercent: RISK_PERCENT,
        riskAmount: riskAmount.toFixed(2),
        slPips: Math.round(slPips),
        lotSize: lotSize.toFixed(2),
        lotType: lotMode,
        potentialLoss: potentialLoss
    };
}

function calculatePartialClose(totalLot) {
    const lot1 = (totalLot * PARTIAL_CLOSE.TP1 / 100).toFixed(2);
    const lot2 = (totalLot * PARTIAL_CLOSE.TP2 / 100).toFixed(2);
    const lot3 = (totalLot * PARTIAL_CLOSE.TP3 / 100).toFixed(2);

    return {
        tp1_lot: lot1,
        tp2_lot: lot2,
        tp3_lot: lot3,
        tp1_pct: PARTIAL_CLOSE.TP1,
        tp2_pct: PARTIAL_CLOSE.TP2,
        tp3_pct: PARTIAL_CLOSE.TP3
    };
}

function calculateTrailingStop(direction, entry, currentPrice, atr) {
    if (!TRAILING_CONFIG.enabled) return null;

    const move = Math.abs(currentPrice - entry);
    const atrMultiplier = move / atr;

    let newSL = null;
    let status = null;

    if (direction === 'BUY') {
        if (atrMultiplier >= TRAILING_CONFIG.lockAt) {
            newSL = entry + (atr * 2);
            status = 'LOCKED_PROFIT';
        } else if (atrMultiplier >= TRAILING_CONFIG.breakevenAt) {
            newSL = entry;
            status = 'BREAKEVEN';
        }
    } else if (direction === 'SELL') {
        if (atrMultiplier >= TRAILING_CONFIG.lockAt) {
            newSL = entry - (atr * 2);
            status = 'LOCKED_PROFIT';
        } else if (atrMultiplier >= TRAILING_CONFIG.breakevenAt) {
            newSL = entry;
            status = 'BREAKEVEN';
        }
    }

    return newSL !== null ? { sl: newSL, status, atrMultiplier: atrMultiplier.toFixed(2) } : null;
}

// ===============================================
// MIDDLEWARE
// ===============================================
function requireAdmin(req, res, next) {
    if (req.query.key !== ADMIN_KEY) {
        return res.status(401).json({ status: 'FAIL', message: 'Unauthorized' });
    }
    next();
}

// ===============================================
// ROUTES
// ===============================================
app.get('/', (req, res) => {
    res.sendFile(__dirname + '/index.html');
});

app.get('/health', (req, res) => {
    res.status(200).json({ status: 'OK', timestamp: new Date().toISOString() });
});

app.get('/api/test-ai', requireAdmin, async (req, res) => {
    try {
        const r = await ai.models.generateContent({ model: AI_MODELS[0], contents: 'Reply with only: OK' });
        res.json({ status: 'OK', model: AI_MODELS[0], reply: r.text ? r.text.substring(0, 30) : '(empty)' });
    } catch (e) { res.json({ status: 'FAIL', error: (e.message || '').substring(0, 200) }); }
});

app.get('/api/test-twelvedata', requireAdmin, async (req, res) => {
    try {
        const tick = await getTick('XAU/USD');
        res.json({ status: 'OK', keysLoaded: TWELVEDATA_KEYS.length, data: tick });
    } catch (e) { res.json({ status: 'FAIL', error: (e.message || '').substring(0, 200) }); }
});

app.get('/api/test-telegram', requireAdmin, async (req, res) => {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
        return res.json({ status: 'FAIL', message: 'Telegram env tak diset' });
    }
    await sendTelegram('🧪 <b>Test Notification</b>\n\n🥇 BPT — Borneo Pro Trade\nTelegram berfungsi ✅', true);
    res.json({ status: 'OK', message: 'Telegram test dihantar (dengan logo)' });
});

// ===== DEBUG =====
app.get('/api/debug-ema', async (req, res) => {
    const symbol = req.query.symbol || 'XAU/USD';
    try {
        const candles = await getOHLC(symbol, '5min', 300);
        const result = analyzeCandles(candles);
        const atrProfile = getATRProfile(candles);
        res.json({
            symbol,
            harga: candles[candles.length - 1].close.toFixed(2),
            ema9: result.ema9.toFixed(2),
            ema21: result.ema21.toFixed(2),
            ema50: result.ema50.toFixed(2),
            gap_9_21: result.gap_9_21.toFixed(2),
            gap_21_50: result.gap_21_50.toFixed(2),
            bodyPct: (result.bodyPct * 100).toFixed(1) + '%',
            buyScore: result.buyScore,
            sellScore: result.sellScore,
            diff: result.diff,
            winner: result.winner,
            signal: result.signal,
            confidence: result.confidence,
            label: result.label,
            atr_profile: {
                atrNow: atrProfile.atrNow.toFixed(2),
                atrAvg: atrProfile.atrAvg.toFixed(2),
                ratio: atrProfile.ratio.toFixed(2),
                level: atrProfile.level,
                tp1Mult: atrProfile.tp1Mult,
                tp2Mult: atrProfile.tp2Mult,
                tp3Mult: atrProfile.tp3Mult
            },
            reasons: result.reasons
        });
    } catch (e) { res.json({ error: e.message }); }
});

app.get('/api/debug-tp', async (req, res) => {
    const symbol = req.query.symbol || 'XAU/USD';
    try {
        const candles = await getOHLC(symbol, '5min', 300);
        const closes = candles.map(c => c.close);
        const harga = closes[closes.length - 1];
        const atr = calculateATR(candles, 14);
        const atrProfile = getATRProfile(candles);

        const sltpBuy = calculateSLTP('BUY', harga, atr, symbol, atrProfile);
        const autoLot = calculateAutoLot(symbol, harga, parseFloat(sltpBuy.sl), ACCOUNT_BALANCE, RISK_PERCENT);
        const partialClose = calculatePartialClose(autoLot);

        res.json({
            symbol,
            harga: harga.toFixed(2),
            atr: atr.toFixed(2),
            balance: ACCOUNT_BALANCE.toFixed(2),
            risk_percent: RISK_PERCENT,
            atr_profile: {
                level: atrProfile.level,
                ratio: atrProfile.ratio.toFixed(2),
                tp1Mult: atrProfile.tp1Mult,
                tp2Mult: atrProfile.tp2Mult,
                tp3Mult: atrProfile.tp3Mult
            },
            auto_lot: autoLot.toFixed(2),
            partial_close: partialClose,
            buy: sltpBuy
        });
    } catch (e) { res.json({ error: e.message }); }
});

app.get('/api/debug-news', async (req, res) => {
    try {
        const news = await checkNewsFilter();
        const events = await getUpcomingNews();
        res.json({
            filter_enabled: NEWS_FILTER.enabled,
            filter_result: news,
            events_count: events.length,
            events_high: events.filter(e => safeStr(e.impact).toLowerCase() === 'high').length
        });
    } catch (e) { res.json({ error: e.message }); }
});

app.get('/api/debug-trailing', async (req, res) => {
    const symbol = req.query.symbol || 'XAU/USD';
    const direction = req.query.direction || 'BUY';
    const entry = parseFloat(req.query.entry || '0');
    const currentPrice = parseFloat(req.query.current || '0');

    try {
        const candles = await getOHLC(symbol, '5min', 300);
        const atr = calculateATR(candles, 14);
        const harga = currentPrice || candles[candles.length - 1].close;
        const entryPrice = entry || harga;

        const trailing = calculateTrailingStop(direction, entryPrice, harga, atr);

        res.json({
            symbol, direction,
            entry: entryPrice.toFixed(2),
            current: harga.toFixed(2),
            atr: atr.toFixed(2),
            move: Math.abs(harga - entryPrice).toFixed(2),
            atrMultiplier: (Math.abs(harga - entryPrice) / atr).toFixed(2),
            trailing
        });
    } catch (e) { res.json({ error: e.message }); }
});

// ===== NEWS PREDICTION =====
app.get('/api/news-prediction', async (req, res) => {
    try {
        const result = await newsService.getNewsPrediction();
        res.json(result);
    } catch (e) { res.status(500).json({ status: 'error', message: e.message }); }
});

// ===== MARKET =====
app.get('/api/market', async (req, res) => {
    const symbol = req.query.symbol || 'XAU/USD';
    const decimal = getDecimal(symbol);

    try {
        const tick = await getTick(symbol);
        const harga = tick.mid;
        const candles = await getOHLC(symbol, '5min', 300);
        const snr = detectSNR(candles);
        const pocData = detectPOC(candles);

        res.json({
            symbol,
            harga: harga.toFixed(decimal),
            bid: tick.bid.toFixed(decimal),
            ask: tick.ask.toFixed(decimal),
            spread: tick.spread.toFixed(decimal),
            snr: {
                s1: snr.S1 ? snr.S1.mid.toFixed(decimal) : '-',
                s1_info: snr.S1,
                s2: snr.S2 ? snr.S2.mid.toFixed(decimal) : '-',
                s2_info: snr.S2,
                r1: snr.R1 ? snr.R1.mid.toFixed(decimal) : '-',
                r1_info: snr.R1,
                atr: snr.atr ? snr.atr.toFixed(decimal) : '-',
                tolerance: snr.tolerance ? snr.tolerance.toFixed(decimal) : '-'
            },
            poc: pocData && pocData.poc ? pocData.poc.toFixed(decimal) : '-',
            time: new Date().toLocaleTimeString()
        });
    } catch (error) { res.status(500).json({ status: 'error', message: error.message }); }
});

// ===== SIGNAL (MAIN) =====
app.get('/api/signal', async (req, res) => {
    const symbol = req.query.symbol || 'XAU/USD';
    const decimal = getDecimal(symbol);

    try {
        const candles = await getOHLC(symbol, '5min', 300);
        if (candles.length < 50) throw new Error("Data tak cukup");

        const closes = candles.map(c => c.close);
        const harga = closes[closes.length - 1];

        const emaAnalysis = analyzeCandles(candles);
        const emaSignal = emaAnalysis ? emaAnalysis.signal : 'WAIT';
        const emaConfidence = emaAnalysis ? emaAnalysis.confidence : 0;
        const emaLabel = emaAnalysis ? emaAnalysis.label : 'WAIT';
        const ema9 = emaAnalysis ? emaAnalysis.ema9 : 0;
        const ema21 = emaAnalysis ? emaAnalysis.ema21 : 0;
        const ema50 = emaAnalysis ? emaAnalysis.ema50 : 0;
        const buyScore = emaAnalysis ? emaAnalysis.buyScore : 0;
        const sellScore = emaAnalysis ? emaAnalysis.sellScore : 0;
        const scoreDiff = emaAnalysis ? emaAnalysis.diff : 0;

        const snr = detectSNR(candles);
        const fvgData = detectFVG(candles);
        const pocData = detectPOC(candles);
        const obData = detectOrderBlock(candles);
        const levelCheck = checkLevelTouch(harga, symbol, snr, fvgData.zones, pocData, obData);

        const confirmCheck = isCandleConfirm(candles, emaSignal);
        const mtf = await checkMultiTimeframe(symbol);

        const atr = calculateATR(candles, 14);
        const atrProfile = getATRProfile(candles);
        const atrPercent = (atr / harga) * 100;
        const sessionData = getSessionStatus();

        let spread = 0, bid = 0, ask = 0;
        try {
            const tick = await getTick(symbol);
            bid = tick.bid || harga;
            ask = tick.ask || harga;
            spread = tick.spread || 0;
        } catch (e) { console.log("Tick gagal:", e.message); }

        const newsCheck = await checkNewsFilter();

        let signal = 'WAIT';
        let warna = '#94a3b8';
        let reasons = [...(emaAnalysis ? emaAnalysis.reasons : [])];
        let filtered = false;
        let isLocked = false;
        let lockedEntry = null;
        let lockAgeMin = 0;
        let warning = null;

        const now = Date.now();
        const cooldownData = signalCooldown.get(symbol);
        const isCooldown = cooldownData && (now - cooldownData.time) < COOLDOWN_MS;
        const cooldownRemain = isCooldown ? Math.ceil((COOLDOWN_MS - (now - cooldownData.time)) / 60000) : 0;
        const existingLock = signalLock.get(symbol);

        if (isCooldown) {
            reasons.push(`Cooldown: ${cooldownRemain} minit`);
            filtered = true;
        }
        else if (newsCheck.blocked) {
            reasons.push(`📰 ${newsCheck.reason}`);
            filtered = true;
            warning = `📰 ${newsCheck.reason}`;
        }
        else if (existingLock) {
            const lockAge = Date.now() - existingLock.lockedAt;
            lockAgeMin = Math.round(lockAge / 60000);

            if (lockAge < MAX_LOCK_MS) {
                signal = existingLock.direction;
                warna = signal === 'BUY' ? '#22c55e' : '#ef4444';
                lockedEntry = existingLock.entry;
                isLocked = true;
                reasons.push(`Locked ${formatLockAge(lockAgeMin)}`);
            } else {
                signalLock.delete(symbol);
                reasons.push('Lock expired');
            }
        }
        else {
            if (emaSignal === 'WAIT') {
                filtered = true;
                reasons.push(`Score rendah (BUY: ${buyScore}, SELL: ${sellScore}, diff: ${scoreDiff})`);
            } else {
                signal = emaSignal;
                warna = signal === 'BUY' ? '#22c55e' : '#ef4444';

                if (!levelCheck.touched) {
                    warning = '⚠️ Level tak sentuh — risiko tinggi';
                    reasons.push(warning);
                }

                if (!confirmCheck.confirm && emaConfidence < 90) {
                    warning = `⚠️ Candle: ${confirmCheck.reason}`;
                    reasons.push(warning);
                }

                signalLock.set(symbol, { direction: signal, entry: harga, lockedAt: Date.now() });
                signalCooldown.set(symbol, { time: Date.now(), direction: signal });

                lockedEntry = harga;
                isLocked = true;
                lockAgeMin = 0;

                const levelNames = levelCheck.touched ? levelCheck.levels.map(l => l.type).join(', ') : 'tak sentuh';
                reasons.push(`✅ ${emaLabel} | ${levelNames}`);

                if (emaConfidence >= 70) {
                    try {
                        const sltpTg = calculateSLTP(signal, harga, atr, symbol, atrProfile);
                        const riskTg = calculatePositionSize(harga, parseFloat(sltpTg.sl), symbol, atr);
                        const partialClose = calculatePartialClose(parseFloat(riskTg.lotSize));
                        const strongLevels = levelCheck.levels.filter(l => l.strength >= 2 || l.untested);
                        const strengthNote = strongLevels.length > 0 ? `💪 Strong: ${strongLevels.map(l => l.type).join(', ')}` : '';
                        const emoji = emaConfidence >= 90 ? '🚀' : '⚡';
                        const atrEmoji = atrProfile.level === 'VOLATILE' ? '🔥' : atrProfile.level === 'SLOW' ? '😴' : '📊';

                        const msgTg = `🥇 <b>BPT — BORNEO PRO TRADE</b>
━━━━━━━━━━━━━━━━
${emoji} <b>SIGNAL ${signal}</b> (${emaConfidence}%)
📊 <b>${symbol}</b>
🎯 Entry: <b>${harga.toFixed(decimal)}</b>

🛑 SL: ${sltpTg.sl} (${sltpTg.slPips} pips)
✅ TP1: ${sltpTg.tp1} (${sltpTg.tp1Pips} pips | RR ${sltpTg.rr_tp1})
✅ TP2: ${sltpTg.tp2} (${sltpTg.tp2Pips} pips | RR ${sltpTg.rr_tp2})
✅ TP3: ${sltpTg.tp3} (${sltpTg.tp3Pips} pips | RR ${sltpTg.rr_tp3})

${atrEmoji} ATR: ${atrProfile.level} (${sltpTg.atr_ratio}×)

💰 <b>Lot: ${riskTg.lotSize}</b> (${riskTg.lotType})
📊 Partial Close:
  • TP1 (${partialClose.tp1_pct}%): ${partialClose.tp1_lot} lot
  • TP2 (${partialClose.tp2_pct}%): ${partialClose.tp2_lot} lot
  • TP3 (${partialClose.tp3_pct}%): ${partialClose.tp3_lot} lot

🔄 Trailing Stop:
  • Breakeven @ ${TRAILING_CONFIG.breakevenAt}× ATR
  • Lock 2× ATR @ ${TRAILING_CONFIG.lockAt}× ATR

📊 EMA (M5):
 EMA9: ${ema9.toFixed(decimal)}
 EMA21: ${ema21.toFixed(decimal)}
 EMA50: ${ema50.toFixed(decimal)}

📍 Sentuh: ${levelNames}
${strengthNote}
✅ ${confirmCheck.reason}

⏰ ${sessionData.name}
📈 MTF: ${mtf.agreement}
🎯 Score: BUY ${buyScore} / SELL ${sellScore}`;

                        await sendTelegram(msgTg, true);
                    } catch (e) { console.log('Telegram error:', e.message); }
                }
            }
        }

        const displayPrice = lockedEntry !== null ? lockedEntry : harga;

        let sltp = { sl: '-', tp1: '-', tp2: '-', tp3: '-', slPips: 0, tp1Pips: 0, tp2Pips: 0, tp3Pips: 0, valid: false };
        let riskMgmt = {
            balance: ACCOUNT_BALANCE.toFixed(2),
            riskPercent: RISK_PERCENT,
            riskAmount: '0.00',
            slPips: 0,
            lotSize: '-',
            lotType: USE_FIXED_LOT ? 'FIXED' : 'AUTO',
            potentialLoss: '0.00'
        };
        let partialClose = null;
        let trailing = null;

        if (signal === 'BUY' || signal === 'SELL') {
            const sltpCalc = calculateSLTP(signal, displayPrice, atr, symbol, atrProfile);
            const riskCalc = calculatePositionSize(displayPrice, parseFloat(sltpCalc.sl), symbol, atr);
            sltp = { ...sltpCalc, valid: true };
            riskMgmt = riskCalc;
            partialClose = calculatePartialClose(parseFloat(riskMgmt.lotSize));
            trailing = calculateTrailingStop(signal, displayPrice, harga, atr);
        }

        let displayStatus = 'WAIT';
        let displayMessage = 'Menunggu setup';

        if (signal === 'BUY' || signal === 'SELL') {
            displayStatus = 'SIGNAL';
            displayMessage = `${signal} @ ${displayPrice.toFixed(decimal)} (${emaConfidence}%)`;
        } else if (buyScore >= 50 || sellScore >= 50) {
            displayStatus = 'SETUP';
            displayMessage = `Score: BUY ${buyScore} / SELL ${sellScore}`;
        } else if (isCooldown) {
            displayStatus = 'COOLDOWN';
            displayMessage = `Cooldown ${cooldownRemain}m`;
        } else if (newsCheck.blocked) {
            displayStatus = 'NEWS';
            displayMessage = `📰 News block`;
        }

        let confidence = 0;
        if (signal !== 'WAIT') {
            const mtfScore = parseInt(mtf.agreement.split('/')[0]) / 4;
            const emaScore = emaConfidence / 100;
            confidence = Math.round((emaScore * 0.7 + mtfScore * 0.3) * 100);
            confidence = Math.min(95, Math.max(50, confidence));
        }

        const zoneMult = ENTRY_ZONE_MULTIPLIER;

        res.json({
            symbol,
            tf: '5min',
            harga: harga.toFixed(decimal),
            harga_entry: displayPrice.toFixed(decimal),
            signal,
            warna,
            locked: isLocked,
            display_status: displayStatus,
            display_message: displayMessage,
            lockAgeMin: lockAgeMin,
            lockAgeText: formatLockAge(lockAgeMin),
            warning,

            score: {
                buyScore, sellScore,
                diff: scoreDiff,
                winner: emaAnalysis ? emaAnalysis.winner : 'WAIT',
                label: emaLabel,
                gap_9_21: emaAnalysis ? emaAnalysis.gap_9_21.toFixed(decimal) : 0,
                gap_21_50: emaAnalysis ? emaAnalysis.gap_21_50.toFixed(decimal) : 0,
                bodyPct: emaAnalysis ? (emaAnalysis.bodyPct * 100).toFixed(1) + '%' : '0%',
                reasons: emaAnalysis ? emaAnalysis.reasons : []
            },

            atr_profile: {
                atr_now: atrProfile.atrNow.toFixed(decimal),
                atr_avg: atrProfile.atrAvg.toFixed(decimal),
                ratio: atrProfile.ratio.toFixed(2),
                level: atrProfile.level,
                tp1Mult: atrProfile.tp1Mult,
                tp2Mult: atrProfile.tp2Mult,
                tp3Mult: atrProfile.tp3Mult
            },

            news: {
                filter_enabled: NEWS_FILTER.enabled,
                blocked: newsCheck.blocked,
                reason: newsCheck.reason
            },

            mtf: {
                timeframes: mtf.timeframes,
                agreement: mtf.agreement,
                consensus: mtf.consensus,
                buyCount: mtf.buyCount,
                sellCount: mtf.sellCount
            },

            level_check: levelCheck,
            candle_confirm: confirmCheck,
            cooldown: { active: isCooldown, remainMin: cooldownRemain },

            ema9: ema9.toFixed(decimal),
            ema21: ema21.toFixed(decimal),
            ema50: ema50.toFixed(decimal),
            session: sessionData.name,
            session_status: sessionData.status,
            atrPercent: atrPercent.toFixed(3),
            spread: spread.toFixed(decimal),
            bid: bid.toFixed(decimal),
            ask: ask.toFixed(decimal),
            spread_info: getSpreadInfo(symbol, spread),
            lot_fixed: FIXED_LOT,
            lot_type: USE_FIXED_LOT ? 'FIXED' : 'AUTO',

            snr: {
                support: snr.support ? snr.support.toFixed(decimal) : '-',
                resistance: snr.resistance ? snr.resistance.toFixed(decimal) : '-',
                poc: snr.poc ? snr.poc.toFixed(decimal) : '-',
                s1: snr.S1 ? {
                    mid: snr.S1.mid.toFixed(decimal),
                    top: snr.S1.top.toFixed(decimal),
                    bottom: snr.S1.bottom.toFixed(decimal),
                    strength: snr.S1.strength,
                    untested: snr.S1.untested,
                    touchesBefore: snr.S1.touchesBefore,
                    touchesAfter: snr.S1.touchesAfter,
                    originTouch: snr.S1.originTouch,
                    label: snr.S1.label
                } : null,
                s2: snr.S2 ? {
                    mid: snr.S2.mid.toFixed(decimal),
                    top: snr.S2.top.toFixed(decimal),
                    bottom: snr.S2.bottom.toFixed(decimal),
                    strength: snr.S2.strength,
                    untested: snr.S2.untested,
                    label: snr.S2.label
                } : null,
                r1: snr.R1 ? {
                    mid: snr.R1.mid.toFixed(decimal),
                    top: snr.R1.top.toFixed(decimal),
                    bottom: snr.R1.bottom.toFixed(decimal),
                    strength: snr.R1.strength,
                    untested: snr.R1.untested,
                    label: snr.R1.label
                } : null
            },

            fvg_zones: fvgData.zones.map(z => ({
                type: z.type,
                top: z.top.toFixed(decimal),
                bottom: z.bottom.toFixed(decimal)
            })),

            poc_price: pocData && pocData.poc ? pocData.poc.toFixed(decimal) : '-',

            order_blocks: {
                bullish: obData.bullish.map(ob => ({ top: ob.top.toFixed(decimal), bottom: ob.bottom.toFixed(decimal) })),
                bearish: obData.bearish.map(ob => ({ top: ob.top.toFixed(decimal), bottom: ob.bottom.toFixed(decimal) }))
            },

            sltp: sltp,
            risk_mgmt: riskMgmt,
            partial_close: partialClose,
            trailing: trailing,
            trailing_config: TRAILING_CONFIG,
            filtered,
            reasons,
            masa: new Date().toLocaleTimeString(),
            status: "LIVE",
            confidence: confidence,

            entry_zone: {
                from: (displayPrice - atr * zoneMult).toFixed(decimal),
                to: (displayPrice + atr * zoneMult).toFixed(decimal),
                mid: displayPrice.toFixed(decimal),
                size: (atr * zoneMult * 2).toFixed(decimal)
            },

            strategy: signal === 'WAIT' ? 'Wait & See' : `EMA ${signal}`,
            rr_tp1: sltp.slPips > 0 ? sltp.rr_tp1 : '0.00',
            rr_tp2: sltp.slPips > 0 ? sltp.rr_tp2 : '0.00',
            rr_tp3: sltp.slPips > 0 ? sltp.rr_tp3 : '0.00'
        });

    } catch (error) {
        console.error("/api/signal ERROR:", error.message);
        res.json({
            symbol,
            signal: "WAIT",
            warna: "#94a3b8",
            locked: false,
            display_status: 'WAIT',
            display_message: 'Data error',
            confidence: 0,
            mtf: { timeframes: [], agreement: '0/4', consensus: 'WAIT' },
            filtered: true,
            reasons: ["Data Error"],
            status: "ERROR"
        });
    }
});

// ===== CANDLES =====
app.get('/api/candles', async (req, res) => {
    const symbol = req.query.symbol || 'XAU/USD';
    const tf = req.query.tf || '5min';
    try {
        const candles = await getOHLC(symbol, tf, 100);
        const formatted = candles.map(c => ({
            time: c.timestamp, open: c.open, high: c.high, low: c.low, close: c.close
        }));
        res.json({ status: "success", candles: formatted });
    } catch (error) { res.status(500).json({ status: "error", message: error.message }); }
});

// ===== NEWS =====
app.get('/api/news', async (req, res) => {
    try {
        const response = await axios.get(`${BIQUOTE_URL}/calendar`, { timeout: 10000 })
            .catch(() => ({ data: { events: [] } }));
        const d = response.data;
        let events = d.events || d.data || d.calendar || (Array.isArray(d) ? d : []);
        if (!Array.isArray(events)) events = [];
        const usdEvents = events
            .filter(e => {
                const cur = safeStr(e.currency || e.country).toUpperCase();
                return cur === 'USD' || cur === 'US';
            })
            .slice(0, 20)
            .map(e => ({
                time: safeStr(e.time || e.date || e.datetime || ''),
                currency: safeStr(e.currency || 'USD'),
                impact: safeStr(e.impact || 'medium').toLowerCase(),
                event: safeStr(e.event || e.title || e.name || ''),
                actual: safeStr(e.actual || '-'),
                forecast: safeStr(e.forecast || e.estimate || '-'),
                previous: safeStr(e.previous || e.prior || '-')
            }));
        res.json({ status: 'success', events: usdEvents });
    } catch (error) { res.json({ status: 'success', events: [], note: 'Simulasi' }); }
});

// ===== SPREAD CHECK =====
app.get('/api/spread-check', async (req, res) => {
    const symbol = req.query.symbol || 'XAU/USD';
    try {
        const tick = await getTick(symbol);
        const info = getSpreadInfo(symbol, tick.spread);
        res.json({ status: 'success', symbol, spread: tick.spread, bid: tick.bid, ask: tick.ask, ...info });
    } catch (e) { res.status(500).json({ status: 'error', message: e.message }); }
});

// ===== START =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 BPT — Borneo Pro Trade (Versi J + LOGO) berjalan di port ${PORT}`);
    console.log(`📊 Scoring: ${SCORE_BOLEH}% / ${SCORE_CUN}%`);
    console.log(`🔥 TP: AUTO ikut ATR profile`);
    console.log(`💰 Lot: ${USE_FIXED_LOT ? 'FIXED ' + FIXED_LOT : 'AUTO (balance ' + ACCOUNT_BALANCE + ', risk ' + RISK_PERCENT + '%)'}`);
    console.log(`📊 Partial Close: ${PARTIAL_CLOSE.TP1}/${PARTIAL_CLOSE.TP2}/${PARTIAL_CLOSE.TP3}`);
    console.log(`🔄 Trailing: ${TRAILING_CONFIG.enabled ? 'ON' : 'OFF'}`);
    console.log(`📰 News Filter: ${NEWS_FILTER.enabled ? 'ON' : 'OFF'}`);
    console.log(`🖼️ Logo: ${fs.existsSync(LOGO_PATH) ? 'OK' : 'TAKDE'}`);
    console.log(`✅ Telegram: ${TELEGRAM_BOT_TOKEN ? 'OK' : 'Belum set'}`);
    console.log(`✅ TwelveData: ${TWELVEDATA_KEYS.length} keys`);
    console.log(`🔒 Admin key: ${ADMIN_KEY === 'bpt-secret-2024' ? '⚠️ DEFAULT' : 'OK'}`);
});