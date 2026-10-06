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

// ===== SETTINGS =====
const TOUCH_THRESHOLD = 0.0025;
const CANDLE_BODY_MIN = 0.30;

const SPREAD_INFO = {
    'XAU/USD': { ideal: 0.50, warn: 0.80, high: 1.20, extreme: 2.00 },
    'XAG/USD': { ideal: 0.02, warn: 0.03, high: 0.05, extreme: 0.10 },
    'EUR/USD': { ideal: 0.00015, warn: 0.00025, high: 0.00040, extreme: 0.00080 },
    'GBP/USD': { ideal: 0.00020, warn: 0.00035, high: 0.00050, extreme: 0.00100 },
    'USD/JPY': { ideal: 0.015, warn: 0.025, high: 0.040, extreme: 0.080 },
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
        console.log(`🔄 Switch ke API key #${currentKeyIndex + 1}`);
    }
}

console.log(`✅ TwelveData: ${TWELVEDATA_KEYS.length} API key dimuatkan`);

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
    let e = closes[0]; let k = 2 / (period + 1);
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

function safeStr(v) { return v === null || v === undefined ? '' : String(v); }

// ===== LEVEL DETECTION =====
function detectSNR(candles) {
    if (candles.length < 20) return { resistance: 0, support: 0, poc: 0 };
    const recent = candles.slice(-200);
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

function detectPOC(candles, bins = 20) {
    if (!candles || candles.length < 20) return null;
    const recent = candles.slice(-200);
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
            const distZone = Math.min(Math.abs(price - zone.top), Math.abs(price - zone.bottom)) / price;
            if (distZone < tolerance) { touched.push({ type: 'FVG_' + zone.type + '_NEAR', level: zone.mid }); break; }
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
    
    return { touched: touched.length > 0, levels: touched, tolerance: (tolerance * price).toFixed(2) };
}

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

// ===== ANALYZE CANDLES — 3 EMA =====
function analyzeCandles(candles) {
    if (!candles || candles.length < 50) return null;
    const closes = candles.map(c => c.close);
    const ema9 = calculateEMA(closes, 9);
    const ema21 = calculateEMA(closes, 21);
    const ema50 = calculateEMA(closes, 50);
    
    let sig = 'WAIT';
    if (ema9 > ema21 && ema21 > ema50) sig = 'BUY';
    else if (ema9 < ema21 && ema21 < ema50) sig = 'SELL';
    
    return { signal: sig };
}

// ===== MULTI-TIMEFRAME (INFO sahaja) =====
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
            const candles = await getOHLC(symbol, item.tf, 100);
            tfResult = analyzeCandles(candles);
        } catch (e) { console.log(`TF ${item.label} fail: ${e.message}`); }
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
        consensus: majoritySignal 
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

async function getOHLC(symbol, interval = '5min', limit = 300) {
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

// ===== SIGNAL LOCK =====
const signalLock = new Map();
const signalCooldown = new Map();
const COOLDOWN_MS = 5 * 60 * 1000;
const MAX_LOCK_MS = 15 * 60 * 1000;

function formatLockAge(minutes) {
    if (minutes < 60) return `${minutes} minit`;
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return m === 0 ? `${h} jam` : `${h}j ${m}m`;
}

function calculateSLTP(direction, entry, atr, symbol) {
    const slDist = atr * 1.5, tp1Dist = atr * 1.0, tp2Dist = atr * 2.0, tp3Dist = atr * 3.0;
    const pipSize = 0.01;
    if (direction === "BUY") {
        return { sl: (entry - slDist).toFixed(getDecimal(symbol)), tp1: (entry + tp1Dist).toFixed(getDecimal(symbol)), tp2: (entry + tp2Dist).toFixed(getDecimal(symbol)), tp3: (entry + tp3Dist).toFixed(getDecimal(symbol)), slPips: Math.round(slDist / pipSize), tp1Pips: Math.round(tp1Dist / pipSize), tp2Pips: Math.round(tp2Dist / pipSize), tp3Pips: Math.round(tp3Dist / pipSize) };
    } else {
        return { sl: (entry + slDist).toFixed(getDecimal(symbol)), tp1: (entry - tp1Dist).toFixed(getDecimal(symbol)), tp2: (entry - tp2Dist).toFixed(getDecimal(symbol)), tp3: (entry - tp3Dist).toFixed(getDecimal(symbol)), slPips: Math.round(slDist / pipSize), tp1Pips: Math.round(tp1Dist / pipSize), tp2Pips: Math.round(tp2Dist / pipSize), tp3Pips: Math.round(tp3Dist / pipSize) };
    }
}

function calculatePositionSize(entry, sl, symbol) {
    const balance = ACCOUNT_BALANCE;
    const riskAmount = balance * (RISK_PERCENT / 100);
    const slPips = Math.abs(entry - sl) / 0.01;
    const lotSize = USE_FIXED_LOT ? FIXED_LOT : Math.max(0.01, riskAmount / (slPips * 0.10));
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

// ===== API: TEST =====
app.get('/api/test-ai', async (req, res) => {
    try {
        const r = await ai.models.generateContent({ model: AI_MODELS[0], contents: 'Reply with only: OK' });
        res.json({ status: 'OK', model: AI_MODELS[0], reply: r.text ? r.text.substring(0, 30) : '(empty)' });
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
    await sendTelegram('🧪 <b>Test Notification</b>\n\nBPT — Borneo Pro Trade\nTelegram berfungsi ✅');
    res.json({ status: 'OK', message: 'Telegram test dihantar' });
});

app.get('/api/news-prediction', async (req, res) => {
    try {
        const result = await newsService.getNewsPrediction();
        res.json(result);
    } catch (e) { res.status(500).json({ status: 'error', message: e.message }); }
});

// ===== API: MARKET =====
app.get('/api/market', async (req, res) => {
    const symbol = req.query.symbol || 'XAU/USD';
    const decimal = getDecimal(symbol);
    try {
        const tick = await getTick(symbol);
        const harga = tick.mid;
        const candles = await getOHLC(symbol, '5min', 300);
        const snr = detectSNR(candles);
        const pocData = detectPOC(candles);
        const variance = harga * 0.001;
        const pocValue = pocData && pocData.poc ? pocData.poc : (harga + variance * 2);
        
        res.json({
            symbol, 
            harga: harga.toFixed(decimal),
            bid: tick.bid.toFixed(decimal), 
            ask: tick.ask.toFixed(decimal), 
            spread: tick.spread.toFixed(decimal),
            poc: pocValue.toFixed(decimal),
            snr: {
                r3: (snr.resistance + variance * 20).toFixed(decimal),
                r2: (snr.resistance + variance * 10).toFixed(decimal),
                r1: snr.resistance.toFixed(decimal),
                poc: pocValue.toFixed(decimal),
                vah: (harga + variance * 5).toFixed(decimal),
                val: (harga - variance * 5).toFixed(decimal),
                s1: snr.support.toFixed(decimal),
                s2: (snr.support - variance * 10).toFixed(decimal),
                s3: (snr.support - variance * 20).toFixed(decimal)
            },
            time: new Date().toLocaleTimeString()
        });
    } catch (error) {
        res.status(500).json({ status: 'error', message: error.message });
    }
});

// ===== API: SIGNAL =====
app.get('/api/signal', async (req, res) => {
    const symbol = req.query.symbol || 'XAU/USD';
    const decimal = getDecimal(symbol);
    try {
        // Get M5 candles (entry TF)
        const candles = await getOHLC(symbol, '5min', 300);
        if (candles.length < 50) throw new Error("Data tak cukup");
        
        const closes = candles.map(c => c.close);
        const harga = closes[closes.length - 1];
        
        // === 3 EMA (M5) ===
        const ema9 = calculateEMA(closes, 9);
        const ema21 = calculateEMA(closes, 21);
        const ema50 = calculateEMA(closes, 50);
        
        let emaSignal = 'WAIT';
        if (ema9 > ema21 && ema21 > ema50) emaSignal = 'BUY';
        else if (ema9 < ema21 && ema21 < ema50) emaSignal = 'SELL';
        
        // === LEVELS ===
        const snr = detectSNR(candles);
        const fvgData = detectFVG(candles);
        const pocData = detectPOC(candles);
        const obData = detectOrderBlock(candles);
        const levelCheck = checkLevelTouch(harga, snr, fvgData.zones, pocData, obData, TOUCH_THRESHOLD);
        
        // === CANDLE CONFIRM ===
        const confirmCheck = isCandleConfirm(candles, emaSignal);
        
        // === MULTI-TF (INFO sahaja) ===
        const mtf = await checkMultiTimeframe(symbol);
        
        // === ATR / SESSION / SPREAD ===
        const atr = calculateATR(candles, 14);
        const atrPercent = (atr / harga) * 100;
        const sessionData = getSessionStatus();
        
        let spread = 0, bid = 0, ask = 0;
        try {
            const tick = await getTick(symbol);
            bid = tick.bid || harga; ask = tick.ask || harga; spread = tick.spread || 0;
        } catch (e) { }
        
        // === SIGNAL DECISION ===
        let signal = 'WAIT';
        let warna = '#94a3b8';
        let reasons = [];
        let filtered = false;
        let isLocked = false;
        let lockedEntry = null;
        let lockAgeMin = 0;
        
        const cooldownData = signalCooldown.get(symbol);
        const now = Date.now();
        const isCooldown = cooldownData && (now - cooldownData.time) < COOLDOWN_MS;
        const cooldownRemain = isCooldown ? Math.ceil((COOLDOWN_MS - (now - cooldownData.time)) / 60000) : 0;
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
                signal = emaSignal;
                warna = signal === 'BUY' ? '#22c55e' : '#ef4444';
                signalLock.set(symbol, { direction: signal, entry: harga, lockedAt: Date.now() });
                lockedEntry = harga;
                isLocked = true;
                lockAgeMin = 0;
                const levelNames = levelCheck.levels.map(l => l.type).join(', ');
                reasons.push(`EMA ${signal} | ${levelNames}`);
                
                try {
                    const sltpTg = calculateSLTP(signal, harga, atr, symbol);
                    const riskTg = calculatePositionSize(harga, parseFloat(sltpTg.sl), symbol);
                    const msgTg = `🚀 <b>SIGNAL ${signal}</b>\n━━━━━━━━━━━━━━━━\n📊 ${symbol}\n🎯 Entry: ${harga.toFixed(decimal)}\n\n🛑 SL: ${sltpTg.sl}\n✅ TP1: ${sltpTg.tp1}\n✅ TP2: ${sltpTg.tp2}\n\n📊 EMA (M5):\n EMA9: ${ema9.toFixed(decimal)}\n EMA21: ${ema21.toFixed(decimal)}\n EMA50: ${ema50.toFixed(decimal)}\n\n📍 Sentuh: ${levelNames}\n✅ ${confirmCheck.reason}\n\n⏰ ${sessionData.name}\n💰 Lot: ${riskTg.lotSize}`;
                    await sendTelegram(msgTg);
                } catch (e) { console.log('Telegram error:', e.message); }
            }
        }
        
        const displayPrice = lockedEntry !== null ? lockedEntry : harga;
        const sltp = calculateSLTP(signal, displayPrice, atr, symbol);
        const riskMgmt = calculatePositionSize(displayPrice, parseFloat(sltp.sl), symbol);
        
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
            
            snr: { support: snr.support.toFixed(decimal), resistance: snr.resistance.toFixed(decimal), poc: snr.poc.toFixed(decimal) },
            fvg_zones: fvgData.zones.map(z => ({ type: z.type, top: z.top.toFixed(decimal), bottom: z.bottom.toFixed(decimal) })),
            poc_price: pocData ? pocData.poc.toFixed(decimal) : '-',
            order_blocks: { 
                bullish: obData.bullish.map(ob => ({ top: ob.top.toFixed(decimal), bottom: ob.bottom.toFixed(decimal) })), 
                bearish: obData.bearish.map(ob => ({ top: ob.top.toFixed(decimal), bottom: ob.bottom.toFixed(decimal) })) 
            },
            
            sltp: { 
                sl: sltp.sl, tp1: sltp.tp1, tp2: sltp.tp2, tp3: sltp.tp3, 
                slPips: sltp.slPips, tp1Pips: sltp.tp1Pips, tp2Pips: sltp.tp2Pips, tp3Pips: sltp.tp3Pips 
            },
            risk_mgmt: riskMgmt, 
            filtered, 
            reasons, 
            masa: new Date().toLocaleTimeString(), 
            status: "LIVE",
            confidence: signal !== 'WAIT' ? 70 : 50,
            
            entry_zone: { 
                from: (displayPrice - atr * 0.3).toFixed(decimal), 
                to: (displayPrice + atr * 0.3).toFixed(decimal), 
                mid: displayPrice.toFixed(decimal) 
            },
            strategy: signal === 'WAIT' ? 'Wait & See' : `EMA ${signal}`,
            rr_tp1: sltp.slPips > 0 ? (sltp.tp1Pips / sltp.slPips).toFixed(2) : '1.00',
            rr_tp2: sltp.slPips > 0 ? (sltp.tp2Pips / sltp.slPips).toFixed(2) : '2.00'
        });
        
    } catch (error) {
        console.error("/api/signal ERROR:", error.message);
        res.json({ 
            symbol, signal: "WAIT", warna: "#94a3b8", locked: false, 
            display_status: 'WAIT', display_message: 'Data error', confidence: 0,
            mtf: { timeframes: [], agreement: '0/4', consensus: 'WAIT' }, 
            filtered: true, reasons: ["Data Error"], status: "ERROR" 
        });
    }
});

// ===== API: CANDLES =====
app.get('/api/candles', async (req, res) => {
    const symbol = req.query.symbol || 'XAU/USD';
    const tf = req.query.tf || '5min';
    try {
        const candles = await getOHLC(symbol, tf, 100);
        const formatted = candles.map(c => ({ time: c.timestamp, open: c.open, high: c.high, low: c.low, close: c.close }));
        res.json({ status: "success", candles: formatted });
    } catch (error) { res.status(500).json({ status: "error", message: error.message }); }
});

// ===== API: NEWS =====
app.get('/api/news', async (req, res) => {
    try {
        const response = await axios.get(`${BIQUOTE_URL}/calendar`, { timeout: 10000 }).catch(() => ({ data: { events: [] } }));
        const d = response.data;
        let events = d.events || d.data || d.calendar || (Array.isArray(d) ? d : []);
        if (!Array.isArray(events)) events = [];
        const usdEvents = events
            .filter(e => { const cur = safeStr(e.currency || e.country).toUpperCase(); return cur === 'USD' || cur === 'US'; })
            .slice(0, 20)
            .map(e => ({ time: safeStr(e.time || e.date || e.datetime || ''), currency: safeStr(e.currency || 'USD'), impact: safeStr(e.impact || 'medium').toLowerCase(), event: safeStr(e.event || e.title || e.name || ''), actual: safeStr(e.actual || '-'), forecast: safeStr(e.forecast || e.estimate || '-'), previous: safeStr(e.previous || e.prior || '-') }));
        res.json({ status: 'success', events: usdEvents });
    } catch (error) {
        res.json({ status: 'success', events: [], note: 'Simulasi' });
    }
});

// ===== API: SPREAD CHECK =====
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
    console.log(`🚀 BPT — Borneo Pro Trade berjalan di port ${PORT}`);
    console.log(`📊 Signal: 3 EMA (M5) + Level + Candle`);
    console.log(`📈 Multi-TF: M5, M15, M30, H1 (info)`);
    console.log(`✅ Telegram: ${TELEGRAM_BOT_TOKEN ? 'OK' : 'Belum set'}`);
    console.log(`✅ TwelveData: ${TWELVEDATA_KEYS.length} keys`);
});