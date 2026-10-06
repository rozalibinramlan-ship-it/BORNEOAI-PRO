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

app.get('/', (req, res) => {
    res.sendFile(__dirname + '/index.html');
});

app.get('/health', (req, res) => {
    res.status(200).json({ status: 'OK', timestamp: new Date().toISOString() });
});

if (!process.env.GEMINI_API_KEY) console.error("⚠️ GEMINI_API_KEY tidak dijumpai!");

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || 'MISSING_KEY' });
const TWELVEDATA_URL = 'https://api.twelvedata.com';
const BIQUOTE_URL = 'https://biquote.io/api';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const ACCOUNT_BALANCE = parseFloat(process.env.ACCOUNT_BALANCE || '1000');
const RISK_PERCENT = parseFloat(process.env.RISK_PERCENT || '1');

const FIXED_LOT = 0.01;
const USE_FIXED_LOT = true;

// ===== SETTINGS REALISTIC =====
const TOUCH_THRESHOLD = 0.0020;      // 0.20%
const CANDLE_BODY_MIN = 0.30;
const WICK_DOMINANCE = 3.0;
const ATR_MIN = 0.008;
const CANDLE_MATURITY_MIN = 0.15;

// Candle count (200/100)
const CANDLE_COUNT = {
    SNR: 200,
    FVG: 100,
    POC: 200,
    OB: 100
};

// Lock & Cooldown
const MAX_LOCK_MS = 15 * 60 * 1000;  // 15 minit
const COOLDOWN_MS = 15 * 60 * 1000;  // 15 minit
const TELEGRAM_COOLDOWN_MS = 15 * 60 * 1000;

// Signal check
const MIN_CHECK_PASS = 3;  // 3/5 minimum

const SPREAD_INFO = {
    'XAU/USD': { ideal: 0.50, warn: 0.80, high: 1.20, extreme: 2.00 },
    'XAG/USD': { ideal: 0.02, warn: 0.03, high: 0.05, extreme: 0.10 },
    'EUR/USD': { ideal: 0.00015, warn: 0.00025, high: 0.00040, extreme: 0.00080 },
    'GBP/USD': { ideal: 0.00020, warn: 0.00035, high: 0.00050, extreme: 0.00100 },
    'USD/JPY': { ideal: 0.015, warn: 0.025, high: 0.040, extreme: 0.080 },
    'GBP/JPY': { ideal: 0.020, warn: 0.030, high: 0.050, extreme: 0.100 },
    'AUD/USD': { ideal: 0.00020, warn: 0.00030, high: 0.00050, extreme: 0.00100 },
    'SPX500':  { ideal: 0.5, warn: 1.0, high: 1.5, extreme: 3.0 },
    'NAS100':  { ideal: 2.0, warn: 3.0, high: 5.0, extreme: 10.0 },
    'DEFAULT': { ideal: 0.0003, warn: 0.0005, high: 0.0010, extreme: 0.0020 }
};

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
        console.log(`🔄 Switch API key #${currentKeyIndex + 1}`);
    }
}

console.log(`✅ TwelveData: ${TWELVEDATA_KEYS.length} API key dimuatkan`);

const AI_MODELS = ['gemini-2.0-flash', 'gemini-1.5-flash', 'gemini-1.5-pro'];
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
            console.log("✅ AI guna:", model);
            workingModel = model;
            return r.text;
        } catch (e) {
            console.log("❌ " + model + " gagal");
            lastErr = e;
        }
    }
    throw lastErr || new Error("Semua model gagal");
}

async function sendTelegram(message) {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
    try {
        const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
        await axios.post(url, { chat_id: TELEGRAM_CHAT_ID, text: message, parse_mode: 'HTML' }, { timeout: 8000 });
        console.log("📱 Telegram sent");
    } catch (e) { console.log("❌ Telegram error:", e.message); }
}

const symbolMap = {
    'XAU/USD': 'XAU/USD', 'XAG/USD': 'XAG/USD',
    'EUR/USD': 'EUR/USD', 'GBP/USD': 'GBP/USD', 'USD/JPY': 'USD/JPY',
    'GBP/JPY': 'GBP/JPY',
    'AUD/USD': 'AUD/USD',
    'SPX500': 'SPX', 'NAS100': 'NDX', 'US30': 'DJI'
};

function toTwelveData(s) { return symbolMap[s] || s; }

function getDecimal(s) {
    if (s.includes('JPY')) return 3;
    if (['SPX500', 'NAS100', 'US30'].some(x => s.includes(x))) return 1;
    if (s.includes('XAU') || s.includes('XAG')) return 2;
    return 5;
}

// ===== MYT TIME (UTC+8) 12 JAM =====
function getMYTTime() {
    const now = new Date();
    return new Date(now.getTime() + (8 * 60 * 60 * 1000));
}

function formatMYT12Hour() {
    const myt = getMYTTime();
    let h = myt.getUTCHours();
    const m = String(myt.getUTCMinutes()).padStart(2, '0');
    const ampm = h >= 12 ? 'PM' : 'AM';
    h = h % 12;
    if (h === 0) h = 12;
    return `${h}:${m} ${ampm} MYT`;
}

function formatMYT12HourSeconds() {
    const myt = getMYTTime();
    let h = myt.getUTCHours();
    const m = String(myt.getUTCMinutes()).padStart(2, '0');
    const s = String(myt.getUTCSeconds()).padStart(2, '0');
    const ampm = h >= 12 ? 'PM' : 'AM';
    h = h % 12;
    if (h === 0) h = 12;
    return `${h}:${m}:${s} ${ampm} MYT`;
}

function formatMYTDate() {
    const myt = getMYTTime();
    const months = ['JAN','FEB','MAC','APR','MEI','JUN','JUL','OGO','SEP','OKT','NOV','DIS'];
    const d = String(myt.getUTCDate()).padStart(2, '0');
    const mo = months[myt.getUTCMonth()];
    const yr = myt.getUTCFullYear();
    return `${d} ${mo} ${yr}`;
}

function getSpreadInfo(symbol, spread) {
    const limit = SPREAD_INFO[symbol] || SPREAD_INFO['DEFAULT'];
    if (!spread || spread <= 0) return { level: 'UNKNOWN', icon: '❓', text: 'Takde data', color: '#94a3b8' };
    if (spread <= limit.ideal) return { level: 'IDEAL', icon: '✅', text: 'Spread bagus', color: '#22c55e' };
    if (spread <= limit.warn) return { level: 'NORMAL', icon: '👍', text: 'Spread normal', color: '#22c55e' };
    if (spread <= limit.high) return { level: 'WARN', icon: '⚠️', text: 'Spread tinggi', color: '#f59e0b' };
    return { level: 'HIGH', icon: '🔴', text: 'Spread melampau', color: '#ef4444' };
}

function calculateRSI(closes, period = 14) {
    if (closes.length < period + 1) return 50;
    let gains = 0, losses = 0;
    for (let i = closes.length - period; i < closes.length; i++) {
        const diff = closes[i] - closes[i - 1];
        if (diff >= 0) gains += diff; else losses -= diff;
    }
    const avgGain = gains / period, avgLoss = losses / period;
    if (avgLoss === 0) return 100;
    return 100 - (100 / (1 + (avgGain / avgLoss)));
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

function calculateEMA(closes, period) {
    if (closes.length === 0) return 0;
    let e = closes[0]; let k = 2 / (period + 1);
    for (let i = 1; i < closes.length; i++) e = (closes[i] * k) + (e * (1 - k));
    return e;
}

function calculateMACD(closes) {
    if (!closes || closes.length < 26) return { macd: 0, signal: 0, histogram: 0 };
    const ema12 = calculateEMA(closes, 12);
    const ema26 = calculateEMA(closes, 26);
    const macdLine = ema12 - ema26;
    const signalLine = macdLine * 0.85;
    return {
        macd: parseFloat(macdLine.toFixed(3)),
        signal: parseFloat(signalLine.toFixed(3)),
        histogram: parseFloat((macdLine - signalLine).toFixed(3))
    };
}

function getMarketSession() {
    const h = new Date().getUTCHours();
    if (h >= 7 && h < 16) return "LONDON";
    if (h >= 12 && h < 21) return "NEW YORK";
    if (h >= 0 && h < 7) return "ASIA";
    return "CLOSED";
}

// ===== SNR (200 candle dari candle CLOSE) =====
function detectSNR(candles) {
    if (candles.length < 20) return { resistance: 0, support: 0, poc: 0 };
    const closedCandles = candles.slice(0, -1);
    const count = Math.min(CANDLE_COUNT.SNR, closedCandles.length);
    const recent = closedCandles.slice(-count);
    const last = recent[recent.length - 1].close;
    const highs = recent.map(c => c.high);
    const lows = recent.map(c => c.low);
    const maxHigh = Math.max(...highs);
    const minLow = Math.min(...lows);
    const resistance = highs.filter(h => h > last).sort((a, b) => a - b)[0] || maxHigh;
    const support = lows.filter(l => l < last).sort((a, b) => b - a)[0] || minLow;
    const prices = recent.map(c => c.close).sort((a, b) => a - b);
    const poc = prices[Math.floor(prices.length / 2)];
    return { resistance, support, poc };
}

// ===== FVG (100 candle dari candle CLOSE) =====
function detectFVG(candles) {
    if (!candles || candles.length < 3) return { zones: [] };
    const zones = [];
    const closedCandles = candles.slice(0, -1);
    const count = Math.min(CANDLE_COUNT.FVG, closedCandles.length);
    const recent = closedCandles.slice(-count);
    for (let i = 1; i < recent.length - 1; i++) {
        const c1 = recent[i - 1];
        const c3 = recent[i + 1];
        if (c3.low > c1.high) zones.push({ type: 'BULLISH', top: c3.low, bottom: c1.high, mid: (c3.low + c1.high) / 2 });
        if (c3.high < c1.low) zones.push({ type: 'BEARISH', top: c1.low, bottom: c3.high, mid: (c1.low + c3.high) / 2 });
    }
    const lastPrice = closedCandles[closedCandles.length - 1].close;
    zones.sort((a, b) => Math.abs(a.mid - lastPrice) - Math.abs(b.mid - lastPrice));
    return { zones: zones.slice(0, 5) };
}

// ===== POC (200 candle dari candle CLOSE) =====
function detectPOC(candles, bins = 20) {
    if (!candles || candles.length < 20) return null;
    const closedCandles = candles.slice(0, -1);
    const count = Math.min(CANDLE_COUNT.POC, closedCandles.length);
    const recent = closedCandles.slice(-count);
    const highs = recent.map(c => c.high);
    const lows = recent.map(c => c.low);
    const maxPrice = Math.max(...highs);
    const minPrice = Math.min(...lows);
    const range = maxPrice - minPrice;
    const binSize = range / bins;
    const volumeMap = new Array(bins).fill(0);
    recent.forEach(c => {
        const midBin = Math.floor((c.close - minPrice) / binSize);
        if (midBin >= 0 && midBin < bins) volumeMap[midBin] += Math.abs(c.close - c.open) * 1000;
    });
    let maxVol = 0, pocBin = 0;
    for (let i = 0; i < volumeMap.length; i++) {
        if (volumeMap[i] > maxVol) { maxVol = volumeMap[i]; pocBin = i; }
    }
    return { poc: minPrice + (pocBin * binSize) + (binSize / 2) };
}

// ===== ORDER BLOCK (100 candle dari candle CLOSE) =====
function detectOrderBlock(candles) {
    if (!candles || candles.length < 5) return { bullish: [], bearish: [] };
    const closedCandles = candles.slice(0, -1);
    const count = Math.min(CANDLE_COUNT.OB, closedCandles.length);
    const recent = closedCandles.slice(-count);
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
    return { bullish: bullishOBs.slice(-5), bearish: bearishOBs.slice(-5) };
}

// ===== CHECK LEVEL TOUCH =====
function checkLevelTouch(price, snr, fvgZones, pocData, obData, threshold = TOUCH_THRESHOLD) {
    const touched = [];
    const tolerance = threshold * 1.5;
    
    const distSupport = Math.abs(price - snr.support) / price;
    const distResistance = Math.abs(price - snr.resistance) / price;
    
    if (distSupport < tolerance) touched.push({ type: 'SNR_SUPPORT', level: snr.support });
    if (distResistance < tolerance) touched.push({ type: 'SNR_RESISTANCE', level: snr.resistance });
    
    if (fvgZones && fvgZones.length > 0) {
        for (const zone of fvgZones) {
            if (price >= zone.bottom && price <= zone.top) { touched.push({ type: 'FVG_' + zone.type, level: zone.mid }); break; }
        }
    }
    
    if (pocData && pocData.poc) {
        if (Math.abs(price - pocData.poc) / price < tolerance) touched.push({ type: 'POC', level: pocData.poc });
    }
    
    if (obData) {
        for (const ob of obData.bullish) {
            if (price >= ob.bottom && price <= ob.top) { touched.push({ type: 'BULLISH_OB', level: ob.mid }); break; }
        }
        for (const ob of obData.bearish) {
            if (price >= ob.bottom && price <= ob.top) { touched.push({ type: 'BEARISH_OB', level: ob.mid }); break; }
        }
    }
    
    return { touched: touched.length > 0, levels: touched };
}

// ===== 5 CHECK SIGNAL =====
function checkSignal5(candles, mtf) {
    const closedCandles = candles.slice(0, -1);
    const lastClosed = candles[candles.length - 2];
    const liveCandle = candles[candles.length - 1];
    const closes = candles.map(c => c.close);
    
    const harga = lastClosed.close;
    
    // 1. Candle CLOSE arah
    const isBullishClose = lastClosed.close > lastClosed.open;
    const isBearishClose = lastClosed.close < lastClosed.open;
    const closeBody = Math.abs(lastClosed.close - lastClosed.open);
    const closeRange = lastClosed.high - lastClosed.low;
    const closeBodyPct = closeRange > 0 ? closeBody / closeRange : 0;
    const candleCloseValid = closeBodyPct > 0.30;
    
    // 2. Level touch
    const snr = detectSNR(candles);
    const fvgData = detectFVG(candles);
    const pocData = detectPOC(candles);
    const obData = detectOrderBlock(candles);
    const levelCheck = checkLevelTouch(harga, snr, fvgData.zones, pocData, obData, TOUCH_THRESHOLD);
    
    // 3. MTF
    const mtfValid = mtf.grade === 'A+' || mtf.grade === 'B';
    
    // 4. Momentum (EMA + RSI)
    const ema9 = calculateEMA(closes, 9);
    const ema21 = calculateEMA(closes, 21);
    const rsi = calculateRSI(closes, 14);
    const macd = calculateMACD(closes);
    
    // 5. Candle LIVE confirm
    const isBullishLive = liveCandle.close > liveCandle.open;
    const isBearishLive = liveCandle.close < liveCandle.open;
    
    // ===== CHECK SELL =====
    const sellChecks = {
        candleClose: isBearishClose && candleCloseValid,
        levelTouch: levelCheck.touched,
        mtf: mtfValid && mtf.consensus === 'SELL',
        momentum: ema9 < ema21 && rsi < 55 && macd.macd < macd.signal,
        candleLive: isBearishLive
    };
    
    const sellScore = Object.values(sellChecks).filter(v => v).length;
    
    // ===== CHECK BUY =====
    const buyChecks = {
        candleClose: isBullishClose && candleCloseValid,
        levelTouch: levelCheck.touched,
        mtf: mtfValid && mtf.consensus === 'BUY',
        momentum: ema9 > ema21 && rsi > 45 && macd.macd > macd.signal,
        candleLive: isBullishLive
    };
    
    const buyScore = Object.values(buyChecks).filter(v => v).length;
    
    return {
        sell: { valid: sellScore >= MIN_CHECK_PASS, score: sellScore, checks: sellChecks },
        buy: { valid: buyScore >= MIN_CHECK_PASS, score: buyScore, checks: buyChecks },
        harga: harga,
        snr: snr,
        fvgZones: fvgData.zones,
        pocData: pocData,
        obData: obData,
        levelCheck: levelCheck,
        ema9, ema21, rsi, macd
    };
}

// ===== CACHE =====
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
                if (d.code === 429 || (d.message && d.message.includes('429'))) { switchKey(); continue; }
                throw new Error(d.message || 'TwelveData error');
            }
            const bid = parseFloat(d.bid || 0);
            const ask = parseFloat(d.ask || 0);
            const price = parseFloat(d.close || d.price || 0);
            const mid = price || (bid + ask) / 2 || 0;
            if (mid === 0) throw new Error('Harga 0.00');
            const result = { bid: bid || mid, ask: ask || mid, mid, spread: parseFloat(d.spread || (ask - bid) || 0) };
            tickCache.set(cacheKey, { data: result, time: Date.now() });
            return result;
        } catch (e) {
            if (e.message && e.message.includes('429')) { switchKey(); continue; }
            if (attempts >= maxAttempts) throw e;
        }
    }
    throw new Error(`Semua API key gagal`);
}

const ohlcCache = new Map();
const OHLC_CACHE_MS = 180000;

async function getOHLC(symbol, interval = '5min', limit = 250) {
    const cacheKey = `${symbol}_${interval}_${limit}`;
    const cached = ohlcCache.get(cacheKey);
    if (cached && Date.now() - cached.time < OHLC_CACHE_MS) return cached.data;
    const tdSymbol = toTwelveData(symbol);
    const intervalMap = { '1min': '1min', '5min': '5min', '15min': '15min', '30min': '30min', '1h': '1h', '4h': '4h' };
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
                if (d.code === 429 || (d.message && d.message.includes('429'))) { switchKey(); continue; }
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
            if (e.message && e.message.includes('429')) { switchKey(); continue; }
            if (attempts >= maxAttempts) throw e;
        }
    }
    throw new Error(`Semua API key gagal`);
}

function analyzeCandles(candles) {
    if (!candles || candles.length < 20) return null;
    const closes = candles.map(c => c.close);
    const ema9 = calculateEMA(closes, 9);
    const ema21 = calculateEMA(closes, 21);
    const rsi = calculateRSI(closes, 14);
    let sig = ema9 > ema21 ? 'BUY' : 'SELL';
    if ((sig === 'BUY' && rsi > 75) || (sig === 'SELL' && rsi < 25)) sig = 'WAIT';
    return { signal: sig, rsi: rsi.toFixed(1) };
}

async function checkMultiTimeframe(symbol) {
    const timeframes = [
        { tf: '5min', label: 'M5' },
        { tf: '15min', label: 'M15' },
        { tf: '30min', label: 'M30' },
        { tf: '1h', label: 'H1' }
    ];
    const results = [];
    for (const item of timeframes) {
        let tfResult = null;
        try {
            const candles = await getOHLC(symbol, item.tf, 200);
            tfResult = analyzeCandles(candles);
        } catch (e) { }
        if (tfResult) results.push({ tf: item.tf, label: item.label, signal: tfResult.signal, rsi: tfResult.rsi });
        else results.push({ tf: item.tf, label: item.label, signal: 'WAIT', rsi: '-' });
    }
    const buyCount = results.filter(r => r.signal === 'BUY').length;
    const sellCount = results.filter(r => r.signal === 'SELL').length;
    const maxCount = Math.max(buyCount, sellCount);
    const majoritySignal = buyCount > sellCount ? 'BUY' : sellCount > buyCount ? 'SELL' : 'WAIT';
    let grade = 'SKIP';
    if (maxCount === 4) grade = 'A+';
    else if (maxCount === 3) grade = 'B';
    return { timeframes: results, buyCount, sellCount, consensus: majoritySignal, agreement: `${maxCount}/4`, grade };
}

function calculateSLTP(direction, entry, atr, symbol) {
    const slDist = atr * 1.5, tp1Dist = atr * 1.0, tp2Dist = atr * 2.0;
    const pipSize = 0.01;
    if (direction === "BUY") {
        return { sl: (entry - slDist).toFixed(getDecimal(symbol)), tp1: (entry + tp1Dist).toFixed(getDecimal(symbol)), tp2: (entry + tp2Dist).toFixed(getDecimal(symbol)), slPips: Math.round(slDist / pipSize), tp1Pips: Math.round(tp1Dist / pipSize), tp2Pips: Math.round(tp2Dist / pipSize) };
    } else {
        return { sl: (entry + slDist).toFixed(getDecimal(symbol)), tp1: (entry - tp1Dist).toFixed(getDecimal(symbol)), tp2: (entry - tp2Dist).toFixed(getDecimal(symbol)), slPips: Math.round(slDist / pipSize), tp1Pips: Math.round(tp1Dist / pipSize), tp2Pips: Math.round(tp2Dist / pipSize) };
    }
}

function calculatePositionSize(entry, sl, symbol) {
    const balance = ACCOUNT_BALANCE;
    const riskAmount = balance * (RISK_PERCENT / 100);
    const slPips = Math.abs(entry - sl) / 0.01;
    const lotDynamic = riskAmount / (slPips * 0.10);
    const lotSize = USE_FIXED_LOT ? FIXED_LOT : Math.max(0.01, lotDynamic);
    return { balance: balance.toFixed(2), lotSize: lotSize.toFixed(2), lotType: USE_FIXED_LOT ? 'FIXED' : 'DYNAMIC', riskAmount: riskAmount.toFixed(2), slPips: Math.round(slPips) };
}

// ===== STATE =====
const lastSignalSent = new Map();
const signalLock = new Map();

// ===== API: SIGNAL =====
app.get('/api/signal', async (req, res) => {
    const symbol = req.query.symbol || 'XAU/USD';
    const decimal = getDecimal(symbol);
    try {
        const mtf = await checkMultiTimeframe(symbol);
        const candles = await getOHLC(symbol, '5min', 250);
        if (candles.length < 50) throw new Error("Data tak cukup");
        
        const result = checkSignal5(candles, mtf);
        const harga = result.harga;
        const closes = candles.map(c => c.close);
        const atr = calculateATR(candles, 14);
        const atrPercent = (atr / harga) * 100;
        const session = getMarketSession();
        
        let spread = 0, bid = 0, ask = 0;
        try {
            const tick = await getTick(symbol);
            bid = tick.bid || harga; ask = tick.ask || harga; spread = tick.spread || 0;
        } catch (e) { }
        
        let signal = "WAIT", warna = "#94a3b8", reasons = [];
        let entryPrice = harga;
        let checkScore = 0;
        
        // Check kalau signal valid
        if (result.sell.valid && result.sell.score >= result.buy.score) {
            signal = "SELL";
            warna = "#ef4444";
            checkScore = result.sell.score;
            reasons.push(`✅ SELL ${result.sell.score}/5`);
        } else if (result.buy.valid) {
            signal = "BUY";
            warna = "#22c55e";
            checkScore = result.buy.score;
            reasons.push(`✅ BUY ${result.buy.score}/5`);
        } else {
            // Tak valid — tunjuk reasons
            if (!result.levelCheck.touched) reasons.push(`⏳ Tak sentuh level`);
            if (mtf.grade === 'SKIP') reasons.push(`⏳ MTF ${mtf.agreement}`);
            if (result.sell.score < MIN_CHECK_PASS && result.buy.score < MIN_CHECK_PASS) {
                reasons.push(`⏳ Check ${Math.max(result.sell.score, result.buy.score)}/5`);
            }
        }
        
        const sltp = calculateSLTP(signal, entryPrice, atr, symbol);
        const riskMgmt = calculatePositionSize(entryPrice, parseFloat(sltp.sl), symbol);
        
        // Display status
        let displayStatus = 'WAIT';
        let displayMessage = 'Menunggu setup';
        if (signal === 'BUY' || signal === 'SELL') {
            displayStatus = 'SIGNAL';
            displayMessage = `${signal} @ ${entryPrice.toFixed(decimal)}`;
        } else if (mtf.grade === 'A+' || mtf.grade === 'B') {
            displayStatus = 'SETUP';
            displayMessage = `Setup ${mtf.grade} — ${Math.max(result.sell.score, result.buy.score)}/5`;
        }
        
        res.json({
            symbol, harga: harga.toFixed(decimal), harga_entry: entryPrice.toFixed(decimal),
            signal, warna, checkScore,
            display_status: displayStatus,
            display_message: displayMessage,
            mtf: { timeframes: mtf.timeframes, agreement: mtf.agreement, grade: mtf.grade, consensus: mtf.consensus },
            level_check: result.levelCheck,
            ema9: result.ema9.toFixed(decimal),
            ema21: result.ema21.toFixed(decimal),
            rsi: result.rsi.toFixed(1),
            macd: result.macd,
            atrPercent: atrPercent.toFixed(3),
            session,
            spread: spread.toFixed(decimal), bid: bid.toFixed(decimal), ask: ask.toFixed(decimal),
            spread_info: getSpreadInfo(symbol, spread),
            snr: { support: result.snr.support.toFixed(decimal), resistance: result.snr.resistance.toFixed(decimal), poc: result.snr.poc.toFixed(decimal) },
            fvg_zones: result.fvgZones.map(z => ({ type: z.type, top: z.top.toFixed(decimal), bottom: z.bottom.toFixed(decimal) })),
            poc_price: result.pocData ? result.pocData.poc.toFixed(decimal) : '-',
            order_blocks: { bullish: result.obData.bullish.map(ob => ({ top: ob.top.toFixed(decimal), bottom: ob.bottom.toFixed(decimal) })), bearish: result.obData.bearish.map(ob => ({ top: ob.top.toFixed(decimal), bottom: ob.bottom.toFixed(decimal) })) },
            sltp: { sl: sltp.sl, tp1: sltp.tp1, tp2: sltp.tp2, slPips: sltp.slPips, tp1Pips: sltp.tp1Pips, tp2Pips: sltp.tp2Pips },
            risk_mgmt: riskMgmt, reasons, masa: formatMYT12Hour(), status: "LIVE",
            time_display: formatMYT12HourSeconds(),
            date_display: formatMYTDate()
        });
    } catch (error) {
        console.error("/api/signal ERROR:", error.message);
        res.json({ symbol, signal: "WAIT", warna: "#94a3b8", display_status: 'WAIT', display_message: 'Data error', reasons: ["Data Error"], status: "ERROR" });
    }
});

// ===== API: TEST =====
app.get('/api/test-ai', async (req, res) => {
    try {
        const r = await ai.models.generateContent({ model: AI_MODELS[0], contents: 'Reply with only: OK' });
        res.json({ status: 'OK', model: AI_MODELS[0] });
    } catch (e) { res.json({ status: 'FAIL', error: (e.message || '').substring(0, 200) }); }
});

app.get('/api/test-twelvedata', async (req, res) => {
    try {
        const tick = await getTick('XAU/USD');
        res.json({ status: 'OK', keysLoaded: TWELVEDATA_KEYS.length, data: tick });
    } catch (e) { res.json({ status: 'FAIL', error: (e.message || '').substring(0, 200) }); }
});

app.get('/api/test-telegram', async (req, res) => {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return res.json({ status: 'FAIL', message: 'Telegram env tak diset' });
    await sendTelegram(`🧪 <b>Test Notification</b>\n\nBPT V4 Realistic\n⏰ ${formatMYT12Hour()}`);
    res.json({ status: 'OK' });
});

// ===== CANDLE CLOSE CHECK — SEND TELEGRAM =====
async function checkSignalAndNotify() {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
    try {
        const symbol = 'XAU/USD';
        const mtf = await checkMultiTimeframe(symbol);
        if (mtf.grade === 'SKIP') return;
        
        const candles = await getOHLC(symbol, '5min', 250);
        if (candles.length < 50) return;
        
        const result = checkSignal5(candles, mtf);
        const harga = result.harga;
        
        // Kalau tak valid — skip
        if (!result.sell.valid && !result.buy.valid) return;
        
        const signalType = result.sell.valid && result.sell.score >= result.buy.score ? 'SELL' : 'BUY';
        const score = signalType === 'SELL' ? result.sell.score : result.buy.score;
        
        // Check kalau signal sama baru-baru ni
        const signalKey = `${symbol}_${signalType}_${Math.floor(harga)}`;
        const lastSent = lastSignalSent.get(symbol);
        const now = Date.now();
        
        if (lastSent) {
            // Signal sama + dalam cooldown
            if (lastSent.signal === signalType && (now - lastSent.time) < TELEGRAM_COOLDOWN_MS) {
                console.log(`🔒 Signal sama — skip Telegram`);
                return;
            }
            // Signal sama + entry hampir
            if (lastSent.signal === signalType && Math.abs(lastSent.entry - harga) < 3) {
                console.log(`🔒 Entry hampir sama — skip`);
                return;
            }
        }
        
        // Hantar Telegram
        const atr = calculateATR(candles, 14);
        const sltp = calculateSLTP(signalType, harga, atr, symbol);
        const risk = calculatePositionSize(harga, parseFloat(sltp.sl), symbol);
        
        const emoji = signalType === 'SELL' ? '🔴' : '🟢';
        const stars = '⭐'.repeat(score);
        
        const msg = `🚀 <b>${signalType} XAU/USD</b>

💰 Entry: <b>${harga.toFixed(2)}</b>
🛑 SL:    ${sltp.sl}
✅ TP1:   ${sltp.tp1}
✅ TP2:   ${sltp.tp2}

${stars} ${score}/5
💰 Lot: ${risk.lotSize}
⏰ ${formatMYT12Hour()}`;
        
        await sendTelegram(msg);
        
        // Simpan
        lastSignalSent.set(symbol, {
            signal: signalType,
            entry: harga,
            time: now,
            score: score
        });
        
        console.log(`📱 Signal ${signalType} ${score}/5 hantar — ${harga}`);
        
    } catch (e) {
        console.log("checkSignalAndNotify error:", e.message);
    }
}

// ===== SCHEDULE CHECK AT CANDLE CLOSE =====
function scheduleCheckAtCandleClose() {
    const now = Date.now();
    const candleMs = 5 * 60 * 1000;
    const nextCandle = Math.ceil(now / candleMs) * candleMs;
    const delay = nextCandle - now + 3000;  // +3 detik untuk pastikan candle close
    
    const secondsUntil = Math.round(delay / 1000);
    console.log(`⏰ Next check in ${secondsUntil} detik (${formatMYT12Hour()})`);
    
    setTimeout(async () => {
        console.log(`🔍 Checking signal @ ${formatMYT12Hour()}...`);
        await checkSignalAndNotify();
        scheduleCheckAtCandleClose();
    }, delay);
}

// ===== START =====
setInterval(() => { newsService.checkAndAlert(); }, 60000);

scheduleCheckAtCandleClose();

console.log('✅ News alert berjalan');
console.log('✅ Signal check sync dengan candle close (5 minit)');
console.log(`✅ Timezone: MYT (UTC+8) 12 jam`);
console.log(`✅ Min check: 3/5`);
console.log(`✅ Candle count: SNR 200, FVG 100, POC 200, OB 100`);
console.log(`✅ Lock: 15 minit | Cooldown: 15 minit`);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 BPT V4 berjalan di port ${PORT}`));