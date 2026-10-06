// ===============================================
// BPT — Borneo Pro Trade
// Versi D (FINAL): Fix Untested off-by-one
// ===============================================

const express = require('express');
const cors = require('cors');
const axios = require('axios');
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
const USE_FIXED_LOT = process.env.USE_FIXED_LOT !== 'false';

// ===== SETTINGS =====
const TOUCH_THRESHOLD = 0.0025;
const CANDLE_BODY_MIN = 0.30;

// ===============================================
// SPREAD INFO PER SIMBOL
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
// TELEGRAM
// ===============================================
async function sendTelegram(message) {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
    try {
        const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
        await axios.post(url, {
            chat_id: TELEGRAM_CHAT_ID,
            text: message,
            parse_mode: 'HTML'
        }, { timeout: 8000 });
        console.log("📱 Telegram sent");
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
// ✅ SNR DETECTION — FINAL (Versi D)
//    - Fractal 2-2
//    - Wick-based touches
//    - Full history
//    - Untested off-by-one FIXED
// ===============================================
function detectSNR(candles) {
    if (!candles || candles.length < 50) {
        return { support: 0, resistance: 0, poc: 0, S1: null, S2: null, R1: null, atr: 0, tolerance: 0 };
    }

    const recent = candles.slice(-200);
    const lastPrice = recent[recent.length - 1].close;

    // ATR untuk auto tolerance
    const atrPeriod = 14;
    const atrSlice = recent.slice(-atrPeriod);
    let atrSum = 0;
    for (let c of atrSlice) atrSum += (c.high - c.low);
    const ATR = atrSum / atrPeriod;
    const tolerance = Math.max(lastPrice * 0.002, ATR * 0.4);

    // ===========================================
    // Fractal 2-2 (kiri 2, kanan 2) — MT4 style
    // ===========================================
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

    // ===========================================
    // ✅ getZoneInfo — FINAL
    //    Origin (j === originIndex) DIPISAHKAN
    //    Untested = touchesAfter === 0
    // ===========================================
    function getZoneInfo(level, type, originIndex) {
        let touchesBefore = 0;
        let touchesAfter = 0;
        let originTouch = 0;

        for (let j = 0; j < recent.length; j++) {
            let hit = false;

            if (type === 'support') {
                // Support: tengok LOW (ekor bawah) sahaja
                hit = recent[j].low <= level + tolerance &&
                      recent[j].low >= level - tolerance;
            } else {
                // Resistance: tengok HIGH (ekor atas) sahaja
                hit = recent[j].high >= level - tolerance &&
                      recent[j].high <= level + tolerance;
            }

            if (hit) {
                if (j < originIndex) {
                    touchesBefore++;
                } else if (j > originIndex) {
                    touchesAfter++;      // ✅ skip origin
                } else {
                    originTouch++;        // ✅ kira origin berasingan
                }
            }
        }

        const totalTouches = touchesBefore + originTouch + touchesAfter;

        return {
            strength: Math.min(5, Math.max(1, totalTouches)),
            untested: touchesAfter === 0,   // ✅ betul sekarang
            touches: totalTouches,
            touchesBefore,
            touchesAfter,
            originTouch
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

    // Ambil S1, S2, R1 terdekat
    let supports = swingLows
        .filter(s => s.price < lastPrice)
        .sort((a, b) => b.price - a.price);
    supports = supports.filter((s, i) => i === 0 || Math.abs(s.price - supports[i - 1].price) > tolerance);

    let resistances = swingHighs
        .filter(s => s.price > lastPrice)
        .sort((a, b) => a.price - b.price);
    resistances = resistances.filter((s, i) => i === 0 || Math.abs(s.price - resistances[i - 1].price) > tolerance);

    let S1_info = supports[0] ? {
        mid: supports[0].price,
        ...getZoneInfo(supports[0].price, 'support', supports[0].index)
    } : null;

    let S2_info = supports[1] ? {
        mid: supports[1].price,
        ...getZoneInfo(supports[1].price, 'support', supports[1].index)
    } : null;

    let R1_info = resistances[0] ? {
        mid: resistances[0].price,
        ...getZoneInfo(resistances[0].price, 'resistance', resistances[0].index)
    } : null;

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

        if (c3.low > c1.high) {
            zones.push({ type: 'BULLISH', top: c3.low, bottom: c1.high, mid: (c3.low + c1.high) / 2 });
        }
        if (c3.high < c1.low) {
            zones.push({ type: 'BEARISH', top: c1.low, bottom: c3.high, mid: (c1.low + c3.high) / 2 });
        }
    }

    const lastPrice = candles[candles.length - 1].close;
    zones.sort((a, b) => Math.abs(a.mid - lastPrice) - Math.abs(b.mid - lastPrice));
    return { zones: zones.slice(0, 5) };
}

// ===============================================
// POC DETECTION (Clamped)
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

        for (let b = lowBin; b <= highBin; b++) {
            volumeMap[b]++;
        }
    });

    let maxVol = 0, pocBin = 0;
    for (let i = 0; i < volumeMap.length; i++) {
        if (volumeMap[i] > maxVol) {
            maxVol = volumeMap[i];
            pocBin = i;
        }
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
            bullishOBs.push({
                type: 'BULLISH_OB',
                top: prev.high,
                bottom: prev.low,
                mid: (prev.high + prev.low) / 2
            });
        }
        if (prevIsBullish && currIsBearish && currIsBig) {
            bearishOBs.push({
                type: 'BEARISH_OB',
                top: prev.high,
                bottom: prev.low,
                mid: (prev.high + prev.low) / 2
            });
        }
    }

    return {
        bullish: bullishOBs.slice(-3),
        bearish: bearishOBs.slice(-3)
    };
}

// ===============================================
// LEVEL TOUCH CHECK
// ===============================================
function checkLevelTouch(price, snr, fvgZones, pocData, obData, threshold = TOUCH_THRESHOLD) {
    const touched = [];
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
            if (price >= ob.bottom && price <= ob.top) {
                touched.push({ type: 'BULLISH_OB', level: ob.mid, strength: 3 });
                break;
            }
        }
        for (const ob of obData.bearish) {
            if (price >= ob.bottom && price <= ob.top) {
                touched.push({ type: 'BEARISH_OB', level: ob.mid, strength: 3 });
                break;
            }
        }
    }

    return {
        touched: touched.length > 0,
        levels: touched,
        tolerance: (tolerance * price).toFixed(2)
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
// ANALYZE CANDLES — 3 EMA
// ===============================================
function analyzeCandles(candles) {
    if (!candles || candles.length < 50) return null;
    const closes = candles.map(c => c.close);
    const ema9 = calculateEMA(closes, 9);
    const ema21 = calculateEMA(closes, 21);
    const ema50 = calculateEMA(closes, 50);

    let sig = 'WAIT';
    if (ema9 > ema21 && ema21 > ema50) sig = 'BUY';
    else if (ema9 < ema21 && ema21 < ema50) sig = 'SELL';

    return { signal: sig, ema9, ema21, ema50 };
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
        if (tfResult) results.push({ tf: item.tf, label: item.label, signal: tfResult.signal });
        else results.push({ tf: item.tf, label: item.label, signal: 'WAIT' });
    }

    const buyCount = results.filter(r => r.signal === 'BUY').length;
    const sellCount = results.filter(r => r.signal === 'SELL').length;
    const maxCount = Math.max(buyCount, sellCount);
    const majoritySignal = buyCount > sellCount ? 'BUY' : sellCount > buyCount ? 'SELL' : 'WAIT';

    return {
        timeframes: results,
        buyCount,
        sellCount,
        agreement: `${maxCount}/4`,
        consensus: majoritySignal,
        errors
    };
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

function calculateSLTP(direction, entry, atr, symbol) {
    const slDist = atr * 1.5;
    const tp1Dist = atr * 1.0;
    const tp2Dist = atr * 2.0;
    const tp3Dist = atr * 3.0;
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
            tp3Pips: Math.round(tp3Dist / pipSize)
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
            tp3Pips: Math.round(tp3Dist / pipSize)
        };
    }
}

function calculatePositionSize(entry, sl, symbol) {
    const balance = ACCOUNT_BALANCE;
    const riskAmount = balance * (RISK_PERCENT / 100);
    const pipSize = getPipSize(symbol);
    const slPips = Math.abs(entry - sl) / pipSize;
    const lotSize = USE_FIXED_LOT
        ? FIXED_LOT
        : Math.max(0.01, riskAmount / (slPips * 0.10));

    return {
        balance: balance.toFixed(2),
        riskPercent: RISK_PERCENT,
        riskAmount: riskAmount.toFixed(2),
        slPips: Math.round(slPips),
        lotSize: lotSize.toFixed(2),
        lotType: USE_FIXED_LOT ? 'FIXED' : 'DYNAMIC',
        potentialLoss: (lotSize * slPips * 0.10).toFixed(2)
    };
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

// ===== TEST ENDPOINTS (DILINDUNGI) =====
app.get('/api/test-ai', requireAdmin, async (req, res) => {
    try {
        const r = await ai.models.generateContent({
            model: AI_MODELS[0],
            contents: 'Reply with only: OK'
        });
        res.json({ status: 'OK', model: AI_MODELS[0], reply: r.text ? r.text.substring(0, 30) : '(empty)' });
    } catch (e) {
        res.json({ status: 'FAIL', error: (e.message || '').substring(0, 200) });
    }
});

app.get('/api/test-twelvedata', requireAdmin, async (req, res) => {
    try {
        const tick = await getTick('XAU/USD');
        res.json({ status: 'OK', keysLoaded: TWELVEDATA_KEYS.length, data: tick });
    } catch (e) {
        res.json({ status: 'FAIL', error: (e.message || '').substring(0, 200) });
    }
});

app.get('/api/test-telegram', requireAdmin, async (req, res) => {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
        return res.json({ status: 'FAIL', message: 'Telegram env tak diset' });
    }
    await sendTelegram('🧪 <b>Test Notification</b>\n\nBPT — Borneo Pro Trade\nTelegram berfungsi ✅');
    res.json({ status: 'OK', message: 'Telegram test dihantar' });
});

// ===== NEWS PREDICTION =====
app.get('/api/news-prediction', async (req, res) => {
    try {
        const result = await newsService.getNewsPrediction();
        res.json(result);
    } catch (e) {
        res.status(500).json({ status: 'error', message: e.message });
    }
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
    } catch (error) {
        res.status(500).json({ status: 'error', message: error.message });
    }
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

        // 3 EMA (M5)
        const emaAnalysis = analyzeCandles(candles);
        const emaSignal = emaAnalysis ? emaAnalysis.signal : 'WAIT';
        const ema9 = emaAnalysis ? emaAnalysis.ema9 : 0;
        const ema21 = emaAnalysis ? emaAnalysis.ema21 : 0;
        const ema50 = emaAnalysis ? emaAnalysis.ema50 : 0;

        // LEVELS
        const snr = detectSNR(candles);
        const fvgData = detectFVG(candles);
        const pocData = detectPOC(candles);
        const obData = detectOrderBlock(candles);
        const levelCheck = checkLevelTouch(harga, snr, fvgData.zones, pocData, obData, TOUCH_THRESHOLD);

        // CANDLE CONFIRM
        const confirmCheck = isCandleConfirm(candles, emaSignal);

        // MULTI-TF
        const mtf = await checkMultiTimeframe(symbol);

        // ATR / SESSION / SPREAD
        const atr = calculateATR(candles, 14);
        const atrPercent = (atr / harga) * 100;
        const sessionData = getSessionStatus();

        let spread = 0, bid = 0, ask = 0;
        try {
            const tick = await getTick(symbol);
            bid = tick.bid || harga;
            ask = tick.ask || harga;
            spread = tick.spread || 0;
        } catch (e) {
            console.log("Tick gagal:", e.message);
        }

        // ===========================================
        // SIGNAL DECISION
        // ===========================================
        let signal = 'WAIT';
        let warna = '#94a3b8';
        let reasons = [];
        let filtered = false;
        let isLocked = false;
        let lockedEntry = null;
        let lockAgeMin = 0;

        const now = Date.now();
        const cooldownData = signalCooldown.get(symbol);
        const isCooldown = cooldownData && (now - cooldownData.time) < COOLDOWN_MS;
        const cooldownRemain = isCooldown
            ? Math.ceil((COOLDOWN_MS - (now - cooldownData.time)) / 60000)
            : 0;
        const existingLock = signalLock.get(symbol);

        if (isCooldown) {
            reasons.push(`Cooldown: ${cooldownRemain} minit`);
            filtered = true;
        } else if (existingLock) {
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
        } else {
            if (emaSignal === 'WAIT') {
                filtered = true;
                reasons.push('EMA tak selari');
            } else if (!levelCheck.touched) {
                filtered = true;
                reasons.push('Tunggu sentuh level');
            } else if (!confirmCheck.confirm) {
                filtered = true;
                reasons.push(`Candle: ${confirmCheck.reason}`);
            } else {
                // SIGNAL BARU
                signal = emaSignal;
                warna = signal === 'BUY' ? '#22c55e' : '#ef4444';
                signalLock.set(symbol, {
                    direction: signal,
                    entry: harga,
                    lockedAt: Date.now()
                });
                signalCooldown.set(symbol, { time: Date.now(), direction: signal });

                lockedEntry = harga;
                isLocked = true;
                lockAgeMin = 0;

                const levelNames = levelCheck.levels.map(l => l.type).join(', ');
                reasons.push(`EMA ${signal} | ${levelNames}`);

                // Telegram
                try {
                    const sltpTg = calculateSLTP(signal, harga, atr, symbol);
                    const riskTg = calculatePositionSize(harga, parseFloat(sltpTg.sl), symbol);
                    const strongLevels = levelCheck.levels.filter(l => l.strength >= 2 || l.untested);
                    const strengthNote = strongLevels.length > 0
                        ? `💪 Strong: ${strongLevels.map(l => l.type).join(', ')}`
                        : '';

                    const msgTg = `🚀 <b>SIGNAL ${signal}</b>\n━━━━━━━━━━━━━━━━\n📊 ${symbol}\n🎯 Entry: ${harga.toFixed(decimal)}\n\n🛑 SL: ${sltpTg.sl} (${sltpTg.slPips} pips)\n✅ TP1: ${sltpTg.tp1} (${sltpTg.tp1Pips} pips)\n✅ TP2: ${sltpTg.tp2} (${sltpTg.tp2Pips} pips)\n\n📊 EMA (M5):\n EMA9: ${ema9.toFixed(decimal)}\n EMA21: ${ema21.toFixed(decimal)}\n EMA50: ${ema50.toFixed(decimal)}\n\n📍 Sentuh: ${levelNames}\n${strengthNote}\n✅ ${confirmCheck.reason}\n\n⏰ ${sessionData.name}\n💰 Lot: ${riskTg.lotSize}\n📈 MTF: ${mtf.agreement}`;

                    await sendTelegram(msgTg);
                } catch (e) {
                    console.log('Telegram error:', e.message);
                }
            }
        }

        const displayPrice = lockedEntry !== null ? lockedEntry : harga;

        // SL/TP hanya kira kalau ada signal
        let sltp = {
            sl: '-', tp1: '-', tp2: '-', tp3: '-',
            slPips: 0, tp1Pips: 0, tp2Pips: 0, tp3Pips: 0,
            valid: false
        };
        let riskMgmt = {
            balance: ACCOUNT_BALANCE.toFixed(2),
            riskPercent: RISK_PERCENT,
            riskAmount: '0.00',
            slPips: 0,
            lotSize: '-',
            lotType: USE_FIXED_LOT ? 'FIXED' : 'DYNAMIC',
            potentialLoss: '0.00'
        };

        if (signal === 'BUY' || signal === 'SELL') {
            const sltpCalc = calculateSLTP(signal, displayPrice, atr, symbol);
            const riskCalc = calculatePositionSize(displayPrice, parseFloat(sltpCalc.sl), symbol);
            sltp = { ...sltpCalc, valid: true };
            riskMgmt = riskCalc;
        }

        let displayStatus = 'WAIT';
        let displayMessage = 'Menunggu setup';

        if (signal === 'BUY' || signal === 'SELL') {
            displayStatus = 'SIGNAL';
            displayMessage = `${signal} @ ${displayPrice.toFixed(decimal)}`;
        } else if (emaSignal !== 'WAIT') {
            displayStatus = 'SETUP';
            displayMessage = `${emaSignal} bias`;
        } else if (isCooldown) {
            displayStatus = 'COOLDOWN';
            displayMessage = `Cooldown ${cooldownRemain}m`;
        }

        // Confidence ikut MTF
        let confidence = 50;
        if (signal !== 'WAIT') {
            const mtfScore = parseInt(mtf.agreement.split('/')[0]) / 4;
            confidence = Math.round(50 + mtfScore * 40);
        }

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
            lot_type: USE_FIXED_LOT ? 'FIXED' : 'DYNAMIC',

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
                    touchesBefore: snr.S2.touchesBefore,
                    touchesAfter: snr.S2.touchesAfter,
                    originTouch: snr.S2.originTouch,
                    label: snr.S2.label
                } : null,
                r1: snr.R1 ? {
                    mid: snr.R1.mid.toFixed(decimal),
                    top: snr.R1.top.toFixed(decimal),
                    bottom: snr.R1.bottom.toFixed(decimal),
                    strength: snr.R1.strength,
                    untested: snr.R1.untested,
                    touchesBefore: snr.R1.touchesBefore,
                    touchesAfter: snr.R1.touchesAfter,
                    originTouch: snr.R1.originTouch,
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
                bullish: obData.bullish.map(ob => ({
                    top: ob.top.toFixed(decimal),
                    bottom: ob.bottom.toFixed(decimal)
                })),
                bearish: obData.bearish.map(ob => ({
                    top: ob.top.toFixed(decimal),
                    bottom: ob.bottom.toFixed(decimal)
                }))
            },

            sltp: sltp,
            risk_mgmt: riskMgmt,
            filtered,
            reasons,
            masa: new Date().toLocaleTimeString(),
            status: "LIVE",
            confidence: confidence,

            entry_zone: {
                from: (displayPrice - atr * 0.3).toFixed(decimal),
                to: (displayPrice + atr * 0.3).toFixed(decimal),
                mid: displayPrice.toFixed(decimal)
            },

            strategy: signal === 'WAIT' ? 'Wait & See' : `EMA ${signal}`,
            rr_tp1: sltp.slPips > 0 ? (sltp.tp1Pips / sltp.slPips).toFixed(2) : '0.00',
            rr_tp2: sltp.slPips > 0 ? (sltp.tp2Pips / sltp.slPips).toFixed(2) : '0.00'
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
            time: c.timestamp,
            open: c.open,
            high: c.high,
            low: c.low,
            close: c.close
        }));
        res.json({ status: "success", candles: formatted });
    } catch (error) {
        res.status(500).json({ status: "error", message: error.message });
    }
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
    } catch (error) {
        res.json({ status: 'success', events: [], note: 'Simulasi' });
    }
});

// ===== SPREAD CHECK =====
app.get('/api/spread-check', async (req, res) => {
    const symbol = req.query.symbol || 'XAU/USD';
    try {
        const tick = await getTick(symbol);
        const info = getSpreadInfo(symbol, tick.spread);
        res.json({
            status: 'success',
            symbol,
            spread: tick.spread,
            bid: tick.bid,
            ask: tick.ask,
            ...info
        });
    } catch (e) {
        res.status(500).json({ status: 'error', message: e.message });
    }
});

// ===== START =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 BPT — Borneo Pro Trade (Versi D FINAL) berjalan di port ${PORT}`);
    console.log(`📊 Signal: 3 EMA (M5) + SNR Fractal 2-2 (wick-based) + Candle`);
    console.log(`📈 Multi-TF: M5, M15, M30, H1 (info)`);
    console.log(`✅ Telegram: ${TELEGRAM_BOT_TOKEN ? 'OK' : 'Belum set'}`);
    console.log(`✅ TwelveData: ${TWELVEDATA_KEYS.length} keys`);
    console.log(`🔒 Admin key: ${ADMIN_KEY === 'bpt-secret-2024' ? '⚠️ DEFAULT (tukar!)' : 'OK'}`);
});