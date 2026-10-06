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
const WICK_DOMINANCE = 3.0;
const ATR_MIN = 0.008;
const CANDLE_MATURITY_MIN = 0.15;

const CANDLE_COUNT = {
    SNR: 200,
    FVG: 100,
    POC: 200,
    OB: 100
};

const SPREAD_INFO = {
    'XAU/USD': { ideal: 0.50, warn: 0.80, high: 1.20, extreme: 2.00 },
    'XAG/USD': { ideal: 0.02, warn: 0.03, high: 0.05, extreme: 0.10 },
    'EUR/USD': { ideal: 0.00015, warn: 0.00025, high: 0.00040, extreme: 0.00080 },
    'GBP/USD': { ideal: 0.00020, warn: 0.00035, high: 0.00050, extreme: 0.00100 },
    'USD/JPY': { ideal: 0.015, warn: 0.025, high: 0.040, extreme: 0.080 },
    'GBP/JPY': { ideal: 0.020, warn: 0.030, high: 0.050, extreme: 0.100 },
    'AUD/USD': { ideal: 0.00020, warn: 0.00030, high: 0.00050, extreme: 0.00100 },
    'USD/CAD': { ideal: 0.00020, warn: 0.00030, high: 0.00050, extreme: 0.00100 },
    'USD/CHF': { ideal: 0.00020, warn: 0.00030, high: 0.00050, extreme: 0.00100 },
    'SPX500':  { ideal: 0.5, warn: 1.0, high: 1.5, extreme: 3.0 },
    'NAS100':  { ideal: 2.0, warn: 3.0, high: 5.0, extreme: 10.0 },
    'US30':    { ideal: 2.0, warn: 3.0, high: 5.0, extreme: 10.0 },
    'WTICO':   { ideal: 0.04, warn: 0.06, high: 0.10, extreme: 0.20 },
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
    'GBP/JPY': 'GBP/JPY',
    'AUD/USD': 'AUD/USD', 'USD/CAD': 'USD/CAD', 'USD/CHF': 'USD/CHF',
    'SPX500': 'SPX', 'NAS100': 'NDX', 'US30': 'DJI',
    'WTICO': 'WTI/USD'
};

function toTwelveData(s) { return symbolMap[s] || s; }

function getDecimal(s) {
    if (s.includes('JPY')) return 3;
    if (['SPX500', 'NAS100', 'US30'].some(x => s.includes(x))) return 1;
    if (['WTICO'].some(x => s.includes(x))) return 3;
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

function calculateMACD(closes) {
    if (!closes || closes.length < 26) return { macd: 0, signal: 0, histogram: 0, cross: 'NEUTRAL' };
    const ema12 = calculateEMA(closes, 12);
    const ema26 = calculateEMA(closes, 26);
    const macdLine = ema12 - ema26;
    const signalLine = macdLine * 0.85;
    let cross = 'NEUTRAL';
    if (macdLine > signalLine && macdLine > 0) cross = 'BULLISH CROSS';
    else if (macdLine > signalLine && macdLine < 0) cross = 'BULLISH WEAK';
    else if (macdLine < signalLine && macdLine < 0) cross = 'BEARISH CROSS';
    else if (macdLine < signalLine && macdLine > 0) cross = 'BEARISH WEAK';
    return { macd: parseFloat(macdLine.toFixed(3)), signal: parseFloat(signalLine.toFixed(3)), histogram: parseFloat((macdLine - signalLine).toFixed(3)), cross };
}

function calculateEMA200(closes) {
    if (!closes || closes.length < 20) return 0;
    return calculateEMA(closes, Math.min(200, closes.length));
}

function calculateConfidence(mtf, rsi, atrPercent, session, spread, signal, symbol) {
    let score = 50;
    if (mtf.grade === 'A+') score += 30;
    else if (mtf.grade === 'B') score += 20;
    if (signal === 'SELL' && rsi > 50 && rsi < 75) score += 10;
    else if (signal === 'BUY' && rsi > 25 && rsi < 50) score += 10;
    if (session === 'LONDON' || session === 'NEW YORK') score += 5;
    else if (session === 'ASIA') score -= 5;
    if (atrPercent >= 0.15 && atrPercent <= 0.8) score += 5;
    return Math.min(99, Math.max(50, score));
}

function getRiskLevel(atrPercent, spread, session) {
    let rs = 0;
    if (atrPercent > 0.4) rs += 2;
    else if (atrPercent > 0.15) rs += 1;
    if (spread > 0.5) rs += 1;
    if (session === 'ASIA') rs += 1;
    if (rs >= 3) return { level: 'HIGH', label: 'HIGH', color: '#ef4444' };
    if (rs >= 2) return { level: 'MEDIUM', label: 'MEDIUM', color: '#fbbf24' };
    return { level: 'LOW', label: 'LOW', color: '#22c55e' };
}

function getVolatilityLevel(atrPercent) {
    if (atrPercent > 0.8) return { level: 'HIGH', text: 'HIGH VOL', color: '#ef4444' };
    if (atrPercent > 0.4) return { level: 'MEDIUM', text: 'MEDIUM VOL', color: '#fbbf24' };
    if (atrPercent > 0.15) return { level: 'NORMAL', text: 'NORMAL VOL', color: '#22c55e' };
    return { level: 'LOW', text: 'LOW VOL', color: '#94a3b8' };
}

function calculateEntryZone(price, atr, direction, decimal) {
    const buffer = atr * 0.3;
    return {
        from: parseFloat((direction === 'SELL' ? price + buffer * 0.5 : price - buffer * 1.5).toFixed(decimal)),
        to: parseFloat((direction === 'SELL' ? price + buffer * 1.5 : price - buffer * 0.5).toFixed(decimal)),
        mid: parseFloat(price.toFixed(decimal))
    };
}

function generateSignalID(symbol) {
    const now = new Date();
    return `BPT-${symbol.replace('/', '')}-${now.getUTCFullYear()}${String(now.getUTCMonth()+1).padStart(2,'0')}${String(now.getUTCDate()).padStart(2,'0')}-${String(now.getUTCHours()).padStart(2,'0')}${String(now.getUTCMinutes()).padStart(2,'0')}`;
}

function getStrategyName(mtf, signal, session) {
    if (signal === 'WAIT') return 'Wait & See';
    if (signal === 'SELL') {
        if (mtf.grade === 'A+') return 'High Conviction Sell';
        if (session === 'LONDON' || session === 'NEW YORK') return 'Pullback Sell';
        return 'Reversal Sell';
    }
    if (signal === 'BUY') {
        if (mtf.grade === 'A+') return 'High Conviction Buy';
        if (session === 'LONDON' || session === 'NEW YORK') return 'Pullback Buy';
        return 'Reversal Buy';
    }
    return 'Trend Following';
}

function getTimeframeReason(tfSignal, tfRsi, candles) {
    if (!candles || candles.length < 20) return 'Data tidak cukup';
    const closes = candles.map(c => c.close);
    const ema50 = calculateEMA(closes, 50);
    const price = closes[closes.length - 1];
    const rsi = parseFloat(tfRsi) || 50;
    const reasons = [];
    if (price < ema50 && tfSignal === 'SELL') reasons.push('Below EMA-50');
    if (price > ema50 && tfSignal === 'BUY') reasons.push('Above EMA-50');
    if (rsi < 30) reasons.push('RSI oversold');
    else if (rsi > 70) reasons.push('RSI overbought');
    return reasons.slice(0, 2).join(', ') || 'Neutral';
}

function calculateRRRatio(entry, sl, tp) {
    const risk = Math.abs(entry - sl);
    const reward = Math.abs(tp - entry);
    return risk === 0 ? '0.00' : (reward / risk).toFixed(2);
}

function safeStr(v) { return v === null || v === undefined ? '' : String(v); }

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

function getMarketSession() {
    const h = new Date().getUTCHours();
    if (h >= 7 && h < 16) return "LONDON";
    if (h >= 12 && h < 21) return "NEW YORK";
    if (h >= 0 && h < 7) return "ASIA";
    return "CLOSED";
}

function detectSNR(candles) {
    if (candles.length < 20) return { resistance: 0, support: 0, poc: 0 };
    const count = Math.min(CANDLE_COUNT.SNR, candles.length);
    const recent = candles.slice(-count);
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
    const count = Math.min(CANDLE_COUNT.FVG, candles.length);
    const recent = candles.slice(-count);
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
    const count = Math.min(CANDLE_COUNT.POC, candles.length);
    const recent = candles.slice(-count);
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
    const count = Math.min(CANDLE_COUNT.OB, candles.length);
    const recent = candles.slice(-count);
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
    const upperWick = c.high - Math.max(c.open, c.close);
    const lowerWick = Math.min(c.open, c.close) - c.low;
    const isBullish = c.close > c.open;
    const isBearish = c.close < c.open;
    const bodyPct = range > 0 ? body / range : 0;
    const isWickDominant = (upperWick + lowerWick) > body * WICK_DOMINANCE;
    const isDoji = bodyPct < 0.10;
    const hasBody = bodyPct > CANDLE_BODY_MIN;
    const isSolid = !isWickDominant && !isDoji;
    
    if (signal === "SELL") {
        if (!isBearish) return { confirm: false, reason: "Candle live BUKAN merah" };
        if (!hasBody) return { confirm: false, reason: "Body kecil" };
        if (!isSolid) return { confirm: false, reason: "Candle wick/doji" };
        return { confirm: true, reason: "Candle merah solid" };
    }
    if (signal === "BUY") {
        if (!isBullish) return { confirm: false, reason: "Candle live BUKAN hijau" };
        if (!hasBody) return { confirm: false, reason: "Body kecil" };
        if (!isSolid) return { confirm: false, reason: "Candle wick/doji" };
        return { confirm: true, reason: "Candle hijau solid" };
    }
    return { confirm: false, reason: "Signal tidak jelas" };
}

function checkCandleAgainstSignal(candles, signal) {
    if (!candles || candles.length < 2) return { against: false };
    const last = candles[candles.length - 1];
    const isBullish = last.close > last.open;
    const isBearish = last.close < last.open;
    
    const lastBody = Math.abs(last.close - last.open);
    const lastRange = last.high - last.low;
    const lastBodyPct = lastRange > 0 ? lastBody / lastRange : 0;
    const isStrongCandle = lastBodyPct > 0.6;
    
    if (signal === "SELL" && isBullish) {
        return { against: true, strong: isStrongCandle, reason: `Candle live HIJAU${isStrongCandle ? ' kuat' : ' lemah'}` };
    }
    if (signal === "BUY" && isBearish) {
        return { against: true, strong: isStrongCandle, reason: `Candle live MERAH${isStrongCandle ? ' kuat' : ' lemah'}` };
    }
    return { against: false };
}

function detectCandlePattern(candle, prevCandle) {
    const body = Math.abs(candle.close - candle.open);
    const range = candle.high - candle.low;
    const upperWick = candle.high - Math.max(candle.open, candle.close);
    const lowerWick = Math.min(candle.open, candle.close) - candle.low;
    const isBullish = candle.close > candle.open;
    if (range === 0) return { pattern: "NONE", strength: 0, bias: "NEUTRAL", icon: "" };
    const bodyPct = body / range;
    if (bodyPct > 0.9) return { pattern: isBullish ? "BULLISH MARUBOZU" : "BEARISH MARUBOZU", strength: 80, bias: isBullish ? "BULLISH" : "BEARISH", icon: isBullish ? "🚀" : "💥" };
    if (lowerWick > body * 2 && upperWick < body * 0.5) return { pattern: "HAMMER", strength: 75, bias: "BULLISH", icon: "🔨" };
    if (upperWick > body * 2 && lowerWick < body * 0.5) return { pattern: "SHOOTING STAR", strength: 75, bias: "BEARISH", icon: "⭐" };
    if (prevCandle) {
        const prevIsBullish = prevCandle.close > prevCandle.open;
        if (!prevIsBullish && isBullish && candle.close > prevCandle.open && body > Math.abs(prevCandle.close - prevCandle.open)) return { pattern: "BULLISH ENGULFING", strength: 85, bias: "BULLISH", icon: "🟢" };
        if (prevIsBullish && !isBullish && candle.close < prevCandle.open && body > Math.abs(prevCandle.close - prevCandle.open)) return { pattern: "BEARISH ENGULFING", strength: 85, bias: "BEARISH", icon: "🔴" };
    }
    if (bodyPct < 0.12) return { pattern: "DOJI", strength: 50, bias: "NEUTRAL", icon: "⚖️" };
    return { pattern: "NONE", strength: 20, bias: "NEUTRAL", icon: "" };
}

function detectLastCandlePattern(candles) {
    if (candles.length < 2) return { pattern: "NONE", strength: 0, bias: "NEUTRAL", icon: "" };
    return detectCandlePattern(candles[candles.length - 1], candles[candles.length - 2]);
}

async function isNewsTime() {
    try {
        const response = await axios.get(`${BIQUOTE_URL}/calendar`, { timeout: 8000 }).catch(() => ({ data: { events: [] } }));
        const d = response.data;
        let events = d.events || d.data || d.calendar || (Array.isArray(d) ? d : []);
        if (!Array.isArray(events)) return false;
        const now = Date.now();
        const highImpact = events.filter(e => {
            const cur = safeStr(e.currency || e.country).toUpperCase();
            const imp = safeStr(e.impact || '').toLowerCase();
            return (cur === 'USD' || cur === 'US') && (imp === 'high' || imp === '3');
        });
        for (const ev of highImpact) {
            const evTime = new Date(ev.time || ev.date || ev.datetime || 0).getTime();
            if (isNaN(evTime)) continue;
            if (Math.abs(now - evTime) / 60000 <= 15) return true;
        }
        return false;
    } catch (e) { return false; }
}

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
    throw new Error(`Semua ${TWELVEDATA_KEYS.length} API key gagal`);
}

const ohlcCache = new Map();
const OHLC_CACHE_MS = 180000;

async function getOHLC(symbol, interval = '15m', limit = 300) {
    const cacheKey = `${symbol}_${interval}_${limit}`;
    const cached = ohlcCache.get(cacheKey);
    if (cached && Date.now() - cached.time < OHLC_CACHE_MS) return cached.data;
    const tdSymbol = toTwelveData(symbol);
    const intervalMap = { '1min': '1min', '5min': '5min', '15min': '15min', '30min': '30min', '1h': '1h', '4h': '4h', '1day': '1day' };
    const tdInterval = intervalMap[interval] || '15min';
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
    throw new Error(`Semua ${TWELVEDATA_KEYS.length} API key gagal`);
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
            const cacheKey = `${symbol}_${item.tf}_200`;
            const cached = ohlcCache.get(cacheKey);
            let candles;
            if (cached && Date.now() - cached.time < OHLC_CACHE_MS) {
                candles = cached.data;
            } else {
                await new Promise(r => setTimeout(r, 1200));
                candles = await getOHLC(symbol, item.tf, 200);
            }
            tfResult = analyzeCandles(candles);
        } catch (e) { console.log(`MTF ${item.label} fail: ${e.message}`); }
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
    return { timeframes: results, buyCount, sellCount, total: 4, consensus: majoritySignal, agreement: `${maxCount}/4`, grade };
}

const signalLock = new Map();
const signalCooldown = new Map();
const COOLDOWN_MS = 5 * 60 * 1000;
const MAX_LOCK_MS = 5 * 60 * 1000;
const patternHistory = [];
let lastNotifiedSignal = null;

function checkMomentumValid(lockData, ema9, ema21, rsi, currentPrice, atrPercent) {
    if (!lockData) return false;
    const { direction, entry, lockedAt } = lockData;
    const percentMove = Math.abs(currentPrice - entry) / entry * 100;
    const lockAge = Date.now() - lockedAt;
    if (lockAge > MAX_LOCK_MS) return false;
    if (percentMove > 5) return false;
    if (atrPercent < ATR_MIN) return false;
    if (direction === "SELL" && ema9 > ema21) return false;
    if (direction === "BUY" && ema9 < ema21) return false;
    return true;
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
    await sendTelegram('🧪 <b>Test Notification</b>\n\nBPT V4 UPDATED\nTelegram berfungsi ✅');
    res.json({ status: 'OK', message: 'Telegram test dihantar' });
});

app.get('/api/news-prediction', async (req, res) => {
    try {
        const result = await newsService.getNewsPrediction();
        res.json(result);
    } catch (e) { res.status(500).json({ status: 'error', message: e.message }); }
});

// ===== API: MARKET (SNR, POC, VAH, VAL) — BARU =====
app.get('/api/market', async (req, res) => {
    const symbol = req.query.symbol || 'XAU/USD';
    const decimal = getDecimal(symbol);
    try {
        const tick = await getTick(symbol);
        const harga = tick.mid;
        
        // Ambil candles untuk SNR & POC yang tepat
        const candles = await getOHLC(symbol, '15min', 300);
        const snr = detectSNR(candles);
        const pocData = detectPOC(candles);
        
        // Fallback kalau data tak cukup
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
        console.error('/api/market error:', error.message);
        // Fallback — return data asas
        try {
            const tick = await getTick(symbol);
            const harga = tick.mid;
            const variance = harga * 0.001;
            res.json({
                symbol,
                harga: harga.toFixed(decimal),
                bid: tick.bid.toFixed(decimal),
                ask: tick.ask.toFixed(decimal),
                spread: tick.spread.toFixed(decimal),
                poc: (harga + variance * 2).toFixed(decimal),
                snr: {
                    r3: (harga + variance * 30).toFixed(decimal),
                    r2: (harga + variance * 20).toFixed(decimal),
                    r1: (harga + variance * 10).toFixed(decimal),
                    poc: (harga + variance * 2).toFixed(decimal),
                    vah: (harga + variance * 5).toFixed(decimal),
                    val: (harga - variance * 5).toFixed(decimal),
                    s1: (harga - variance * 10).toFixed(decimal),
                    s2: (harga - variance * 20).toFixed(decimal),
                    s3: (harga - variance * 30).toFixed(decimal)
                },
                time: new Date().toLocaleTimeString()
            });
        } catch (e2) {
            res.status(500).json({ status: 'error', message: e2.message });
        }
    }
});

// ===== API: SIGNAL =====
app.get('/api/signal', async (req, res) => {
    const symbol = req.query.symbol || 'XAU/USD';
    const tf = req.query.tf || '5min';
    const decimal = getDecimal(symbol);
    try {
        const mtf = await checkMultiTimeframe(symbol);
        const candles = await getOHLC(symbol, tf, 300);
        if (candles.length < 50) throw new Error("Data tak cukup");
        const closes = candles.map(c => c.close);
        const harga = closes[closes.length - 1];
        const ema9 = calculateEMA(closes, 9);
        const ema21 = calculateEMA(closes, 21);
        const ema50 = calculateEMA(closes, 50);
        const ema200 = calculateEMA200(closes);
        const rsi = calculateRSI(closes, 14);
        const atr = calculateATR(candles, 14);
        const atrPercent = (atr / harga) * 100;
        const session = getMarketSession();
        const snr = detectSNR(candles);
        const fvgData = detectFVG(candles);
        const pocData = detectPOC(candles);
        const obData = detectOrderBlock(candles);
        const lastPattern = detectLastCandlePattern(candles);
        const macd = calculateMACD(closes);
        
        let spread = 0, bid = 0, ask = 0;
        try {
            const tick = await getTick(symbol);
            bid = tick.bid || harga; ask = tick.ask || harga; spread = tick.spread || 0;
        } catch (e) { }
        
        const cooldownData = signalCooldown.get(symbol);
        const now = Date.now();
        const isCooldown = cooldownData && (now - cooldownData.time) < COOLDOWN_MS;
        const cooldownRemain = isCooldown ? Math.ceil((COOLDOWN_MS - (now - cooldownData.time)) / 60000) : 0;
        const existingLock = signalLock.get(symbol);
        let signal = "WAIT", warna = "#94a3b8", reasons = [], filtered = false;
        let lockedEntry = null, isLocked = false, resetPattern = null, lockAgeMin = 0;
        let levelCheck = { touched: false, levels: [] };
        let confirmCheck = { confirm: false, reason: 'N/A' };

        if (isCooldown) {
            reasons.push(`Cooldown: ${cooldownRemain} minit`);
            filtered = true;
        } else if (existingLock) {
            const momentumValid = checkMomentumValid(existingLock, ema9, ema21, rsi, harga, atrPercent);
            const lockAge = Date.now() - existingLock.lockedAt;
            lockAgeMin = Math.round(lockAge / 60000);
            
            if (momentumValid) {
                const candleCheck = checkCandleAgainstSignal(candles, existingLock.direction);
                
                if (candleCheck.against && candleCheck.strong) {
                    signalLock.delete(symbol);
                    signalCooldown.set(symbol, { time: Date.now() });
                    resetPattern = candleCheck.reason;
                } else {
                    signal = existingLock.direction;
                    warna = signal === "BUY" ? "#22c55e" : "#ef4444";
                    lockedEntry = existingLock.entry;
                    isLocked = true;
                    reasons.push(`Locked ${formatLockAge(lockAgeMin)}`);
                }
            } else {
                signalLock.delete(symbol);
                signalCooldown.set(symbol, { time: Date.now() });
            }
        }

        if (!isLocked && !isCooldown) {
            const mtfSignal = mtf.consensus;
            const mtfGrade = mtf.grade;
            if (mtfGrade === 'SKIP') {
                filtered = true;
                reasons.push(`⚠️ Perlu ≥3/4 TF (${mtf.agreement})`);
            } else {
                levelCheck = checkLevelTouch(harga, snr, fvgData.zones, pocData, obData, TOUCH_THRESHOLD);
                
                if (!levelCheck.touched) {
                    filtered = true;
                    const distSNR = Math.min(Math.abs(harga - snr.support) / harga * 100, Math.abs(harga - snr.resistance) / harga * 100).toFixed(2);
                    reasons.push(`⏳ Tunggu sentuh level (SNR ${distSNR}% jauh)`);
                } else {
                    signal = mtfSignal;
                    warna = signal === "BUY" ? "#22c55e" : "#ef4444";
                    signalLock.set(symbol, { direction: signal, entry: harga, lockedAt: Date.now() });
                    lockedEntry = harga;
                    isLocked = true;
                    lockAgeMin = 0;
                    const levelNames = levelCheck.levels.map(l => l.type).join(', ');
                    reasons.push(`✅ Sentuh: ${levelNames}`);
                    
                    try {
                        const sltpTg = calculateSLTP(signal, harga, atr, symbol);
                        const riskTg = calculatePositionSize(harga, parseFloat(sltpTg.sl), symbol);
                        const tfLines = mtf.timeframes.map(t => ` ${t.label}: ${t.signal} (RSI ${t.rsi})`).join('\n');
                        const msgTg = `🚀 <b>SIGNAL ${mtf.grade} (${mtf.agreement})</b>\n━━━━━━━━━━━━━━━━\n📊 ${symbol} — <b>${signal}</b>\n🎯 Entry: ${harga.toFixed(decimal)}\n\n🛑 SL: ${sltpTg.sl}\n✅ TP1: ${sltpTg.tp1}\n✅ TP2: ${sltpTg.tp2}\n\n📊 4TF:\n${tfLines}\n\n📍 Sentuh: ${levelNames}\n\n📈 RSI: ${rsi.toFixed(1)} | ⏰ ${session}\n💰 Lot: ${riskTg.lotSize}`;
                        await sendTelegram(msgTg);
                    } catch (e) { console.log('Telegram error:', e.message); }
                }
            }
        }

        const displayPrice = lockedEntry !== null ? lockedEntry : harga;
        const sltp = calculateSLTP(signal, displayPrice, atr, symbol);
        const riskMgmt = calculatePositionSize(displayPrice, parseFloat(sltp.sl), symbol);
        
        const confidence = calculateConfidence(mtf, rsi, atrPercent, session, spread, signal, symbol);
        const riskLevel = getRiskLevel(atrPercent, spread, session);
        const volatility = getVolatilityLevel(atrPercent);
        const entryZone = calculateEntryZone(displayPrice, atr, signal, decimal);
        const signalID = generateSignalID(symbol);
        const strategy = getStrategyName(mtf, signal, session);
        const rrTP1 = calculateRRRatio(displayPrice, parseFloat(sltp.sl), parseFloat(sltp.tp1));
        const rrTP2 = calculateRRRatio(displayPrice, parseFloat(sltp.sl), parseFloat(sltp.tp2));
        
        let displayStatus = 'WAIT', displayMessage = 'Menunggu setup 3/4 TF';
        if (signal === 'BUY' || signal === 'SELL') {
            displayStatus = 'SIGNAL';
            displayMessage = `${signal} @ ${displayPrice.toFixed(decimal)}`;
        } else if (mtf.grade === 'A+' || mtf.grade === 'B') {
            displayStatus = 'SETUP';
            displayMessage = `Setup ${mtf.grade} (${mtf.agreement}) — Tunggu trigger`;
        } else if (isCooldown) {
            displayStatus = 'COOLDOWN';
            displayMessage = `Cooldown ${cooldownRemain} minit`;
        }
        
        const tfReasons = {};
        if (mtf.timeframes) {
            for (const t of mtf.timeframes) {
                const tfCandles = await getOHLC(symbol, t.tf, 50).catch(() => candles);
                tfReasons[t.label] = getTimeframeReason(t.signal, t.rsi, tfCandles);
            }
        }

        res.json({
            symbol, tf, harga: harga.toFixed(decimal), harga_entry: displayPrice.toFixed(decimal), signal, warna, locked: isLocked,
            display_status: displayStatus,
            display_message: displayMessage,
            lockAgeMin: lockAgeMin,
            lockAgeText: formatLockAge(lockAgeMin),
            mtf: { timeframes: mtf.timeframes, buyCount: mtf.buyCount, sellCount: mtf.sellCount, agreement: mtf.agreement, grade: mtf.grade, consensus: mtf.consensus },
            level_check: levelCheck,
            candle_confirm: confirmCheck,
            cooldown: { active: isCooldown, remainMin: cooldownRemain },
            ema9: ema9.toFixed(decimal), ema21: ema21.toFixed(decimal), ema50: ema50.toFixed(decimal),
            ema200: ema200.toFixed(decimal),
            rsi: rsi.toFixed(1), atrPercent: atrPercent.toFixed(3), session,
            spread: spread.toFixed(decimal), bid: bid.toFixed(decimal), ask: ask.toFixed(decimal),
            spread_info: getSpreadInfo(symbol, spread),
            lot_fixed: FIXED_LOT, lot_type: USE_FIXED_LOT ? 'FIXED' : 'DYNAMIC',
            macd: macd,
            snr: { support: snr.support.toFixed(decimal), resistance: snr.resistance.toFixed(decimal), poc: snr.poc.toFixed(decimal) },
            fvg_zones: fvgData.zones.map(z => ({ type: z.type, top: z.top.toFixed(decimal), bottom: z.bottom.toFixed(decimal) })),
            poc_price: pocData ? pocData.poc.toFixed(decimal) : '-',
            order_blocks: { bullish: obData.bullish.map(ob => ({ top: ob.top.toFixed(decimal), bottom: ob.bottom.toFixed(decimal) })), bearish: obData.bearish.map(ob => ({ top: ob.top.toFixed(decimal), bottom: ob.bottom.toFixed(decimal) })) },
            candle_pattern: { pattern: lastPattern.pattern, bias: lastPattern.bias, strength: lastPattern.strength, icon: lastPattern.icon },
            sltp: { sl: sltp.sl, tp1: sltp.tp1, tp2: sltp.tp2, tp3: sltp.tp3, slPips: sltp.slPips, tp1Pips: sltp.tp1Pips, tp2Pips: sltp.tp2Pips, tp3Pips: sltp.tp3Pips },
            risk_mgmt: riskMgmt, reset_pattern: resetPattern, filtered, reasons, masa: new Date().toLocaleTimeString(), status: "LIVE",
            confidence: confidence,
            risk_level: riskLevel,
            volatility: volatility,
            entry_zone: entryZone,
            signal_id: signalID,
            strategy: strategy,
            rr_tp1: rrTP1,
            rr_tp2: rrTP2,
            tf_reasons: tfReasons
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
            mtf: { timeframes: [], agreement: '0/4', grade: 'SKIP', consensus: 'WAIT' }, 
            filtered: true, 
            reasons: ["Data Error"], 
            status: "ERROR" 
        });
    }
});

app.get('/api/candles', async (req, res) => {
    const symbol = req.query.symbol || 'XAU/USD';
    const tf = req.query.tf || '15min';
    try {
        const candles = await getOHLC(symbol, tf, 100);
        const formatted = candles.map(c => ({ time: c.timestamp, open: c.open, high: c.high, low: c.low, close: c.close }));
        res.json({ status: "success", candles: formatted });
    } catch (error) { res.status(500).json({ status: "error", message: error.message }); }
});

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

app.get('/api/spread-check', async (req, res) => {
    const symbol = req.query.symbol || 'XAU/USD';
    try {
        const tick = await getTick(symbol);
        const info = getSpreadInfo(symbol, tick.spread);
        res.json({ status: 'success', symbol, spread: tick.spread, bid: tick.bid, ask: tick.ask, ...info });
    } catch (e) { res.status(500).json({ status: 'error', message: e.message }); }
});

// ===== BOUNCE ALERT =====
async function checkBounceAlert() {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
    try {
        const symbol = 'XAU/USD';
        const candles = await getOHLC(symbol, '5min', 100);
        if (candles.length < 50) return;
        
        const closes = candles.map(c => c.close);
        const harga = closes[closes.length - 1];
        const snr = detectSNR(candles);
        
        const distSupport = Math.abs(harga - snr.support) / harga;
        const distResistance = Math.abs(harga - snr.resistance) / harga;
        const BOUNCE_THRESHOLD = 0.003;
        
        const last = candles[candles.length - 1];
        const body = Math.abs(last.close - last.open);
        const range = last.high - last.low;
        const bodyPct = range > 0 ? body / range : 0;
        const isStrong = bodyPct > 0.6;
        const isBullish = last.close > last.open;
        const isBearish = last.close < last.open;
        
        if (distSupport < BOUNCE_THRESHOLD && isBullish && isStrong) {
            const key = `BOUNCE_SUP_${Math.floor(harga / 5) * 5}`;
            const lastB = signalCooldown.get(key);
            const now = Date.now();
            if (!lastB || (now - lastB.time) > 30 * 60 * 1000) {
                signalCooldown.set(key, { time: now });
                const msg = `⚡ <b>BOUNCE ALERT — BUY SETUP</b>\n━━━━━━━━━━━━━━━━\n📊 ${symbol}\n🎯 Harga: ${harga.toFixed(2)}\n\n📍 Support: ${snr.support.toFixed(2)}\n📍 Jarak: ${(distSupport * 100).toFixed(2)}%\n\n✅ Candle HIJAU kuat\n💡 <b>ACTION:</b> Standby untuk BUY`;
                await sendTelegram(msg);
            }
        }
        
        if (distResistance < BOUNCE_THRESHOLD && isBearish && isStrong) {
            const key = `BOUNCE_RES_${Math.floor(harga / 5) * 5}`;
            const lastB = signalCooldown.get(key);
            const now = Date.now();
            if (!lastB || (now - lastB.time) > 30 * 60 * 1000) {
                signalCooldown.set(key, { time: now });
                const msg = `⚡ <b>BOUNCE ALERT — SELL SETUP</b>\n━━━━━━━━━━━━━━━━\n📊 ${symbol}\n🎯 Harga: ${harga.toFixed(2)}\n\n📍 Resistance: ${snr.resistance.toFixed(2)}\n📍 Jarak: ${(distResistance * 100).toFixed(2)}%\n\n✅ Candle MERAH kuat\n💡 <b>ACTION:</b> Standby untuk SELL`;
                await sendTelegram(msg);
            }
        }
    } catch (e) { console.log('Bounce alert error:', e.message); }
}

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
    const lotDynamic = riskAmount / (slPips * 0.10);
    const lotSize = USE_FIXED_LOT ? FIXED_LOT : Math.max(0.01, lotDynamic);
    return { balance: balance.toFixed(2), riskPercent: RISK_PERCENT, riskAmount: riskAmount.toFixed(2), slPips: Math.round(slPips), lotSize: lotSize.toFixed(2), lotType: USE_FIXED_LOT ? 'FIXED' : 'DYNAMIC', potentialLoss: (lotSize * slPips * 0.10).toFixed(2) };
}

setInterval(() => { newsService.checkAndAlert(); }, 60000);
setInterval(() => { checkBounceAlert(); }, 60000);

console.log('✅ News alert (1 minit)');
console.log('✅ Bounce alert (1 minit)');
console.log('✅ Market endpoint /api/market ready');

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('🚀 BPT V4 berjalan di port ' + PORT));