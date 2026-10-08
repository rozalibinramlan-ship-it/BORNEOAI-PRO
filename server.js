// ===============================================
// BPT — Borneo Pro Trade
// Server v1.24.2 — UptimeRobot Fix + AI Mapping
// ===============================================
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { GoogleGenAI } = require('@google/genai');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.static(__dirname));

// ===============================================
// CONFIG
// ===============================================
const TWELVEDATA_URL = 'https://api.twelvedata.com';
const EA_API_KEY = process.env.EA_API_KEY || 'ea-secret-2024';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';

const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
const GEMINI_MODEL = 'gemini-flash-latest';

const CANDLE_BODY_MIN = 0.30;
const SCORE_CUN = 90;
const SCORE_BOLEH = 70;
const SCORE_CHOPPY_DIFF = 10;
const ENTRY_ZONE_MULTIPLIER = 0.8;
const COOLDOWN_MS = 5 * 60 * 1000;
const MAX_LOCK_MS = 15 * 60 * 1000;

const TWELVEDATA_KEYS = [
    process.env.TWELVEDATA_API_KEY || '',
    process.env.TWELVEDATA_API_KEY_2 || '',
    process.env.TWELVEDATA_API_KEY_3 || ''
].filter(function(k) { return k.length > 0; });

let currentKeyIndex = 0;
function getCurrentKey() { return TWELVEDATA_KEYS[currentKeyIndex] || TWELVEDATA_KEYS[0] || ''; }
function switchKey() { if (TWELVEDATA_KEYS.length > 1) { currentKeyIndex = (currentKeyIndex + 1) % TWELVEDATA_KEYS.length; } }

console.log('TwelveData: ' + TWELVEDATA_KEYS.length + ' keys');
console.log('EA API Key: ' + EA_API_KEY);
console.log('Telegram: ' + (TELEGRAM_BOT_TOKEN ? 'OK' : 'TAK SET'));
console.log('Gemini: ' + (GEMINI_API_KEY ? 'OK' : 'TAK SET'));

// ===============================================
// MAPPING STORAGE
// ===============================================
let aiMappings = { ASIA: null, LONDON: null, 'NEW YORK': null, lastUpdate: 0 };

// ===============================================
// TELEGRAM
// ===============================================
async function sendTelegram(message) {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
        console.log('⚠️ Telegram env tak set');
        return;
    }
    try {
        const url = 'https://api.telegram.org/bot' + TELEGRAM_BOT_TOKEN + '/sendMessage';
        await axios.post(url, {
            chat_id: TELEGRAM_CHAT_ID,
            text: message,
            parse_mode: 'HTML'
        }, { timeout: 8000 });
        console.log('📱 Telegram sent');
    } catch (e) {
        console.log('❌ Telegram error:', e.message);
    }
}

// ===============================================
// EA BRIDGE - ANTI 400
// ===============================================
let eaStatus = {
    online: false, lastSeen: 0, balance: 0, equity: 0, margin: 0,
    freeMargin: 0, profit: 0, positions: [], prices: {},
    accountNumber: '', broker: '', leverage: 0, currency: 'USD'
};
let tradeQueue = [];
let tradeHistory = [];

function parseEAJson(rawText) {
    try {
        let raw = (rawText || '').toString().replace(/\x00/g, '').trim();
        if (!raw) return {};
        if (raw.includes('}{')) raw = raw.split('}{')[0] + '}';
        let depth = 0, start = -1, first = null;
        for (let i = 0; i < raw.length; i++) {
            if (raw[i] === '{') { if (depth === 0) start = i; depth++; }
            else if (raw[i] === '}') { depth--; if (depth === 0 && start !== -1) { first = raw.substring(start, i + 1); break; } }
        }
        if (first) raw = first;
        return JSON.parse(raw);
    } catch (e) { return {}; }
}

app.post('/api/ea/heartbeat', express.text({ type: '*/*', limit: '5mb' }), function(req, res) {
    const body = parseEAJson(req.body);
    eaStatus = {
        online: true, lastSeen: Date.now(),
        balance: parseFloat(body.balance || 0),
        equity: parseFloat(body.equity || 0),
        margin: parseFloat(body.margin || 0),
        freeMargin: parseFloat(body.freeMargin || 0),
        profit: parseFloat(body.profit || 0),
        positions: body.positions || [],
        prices: body.prices || {},
        accountNumber: body.accountNumber || '',
        broker: body.broker || '',
        leverage: body.leverage || 0,
        currency: body.currency || 'USD'
    };
    console.log('♥ HB ' + eaStatus.accountNumber + ' | ' + Object.keys(eaStatus.prices).length + ' pairs');
    res.json({ status: 'OK' });
});

app.get('/api/ea/status', function(req, res) {
    const isOnline = (Date.now() - eaStatus.lastSeen) < 30000;
    res.json(Object.assign({}, eaStatus, {
        online: isOnline,
        secondsAgo: isOnline ? Math.round((Date.now() - eaStatus.lastSeen) / 1000) : null
    }));
});

app.get('/api/ea/commands', function(req, res) {
    const pending = tradeQueue.filter(function(c) { return c.status === 'pending'; });
    if (pending.length > 0) {
        const cmd = pending[0];
        cmd.status = 'sent';
        cmd.sentAt = Date.now();
        res.json({ command: cmd });
    } else {
        res.json({ command: null });
    }
});

app.post('/api/ea/result', express.text({ type: '*/*' }), function(req, res) {
    const body = parseEAJson(req.body);
    const cmd = tradeQueue.find(function(c) { return c.id === body.id; });
    if (cmd) {
        cmd.status = body.success ? 'executed' : 'failed';
        cmd.ticket = body.ticket;
        cmd.error = body.error || '';
        tradeHistory.push(Object.assign({}, cmd));
        if (tradeHistory.length > 100) tradeHistory.shift();
    }
    res.json({ status: 'OK' });
});

app.use(express.json({ strict: false, limit: '5mb' }));

app.post('/api/ea/execute', function(req, res) {
    const body = req.body;
    if (!body.symbol || !body.action || !body.lot) return res.status(400).json({ error: 'Missing fields' });
    const cmd = {
        id: Date.now() + Math.floor(Math.random() * 1000),
        symbol: body.symbol, action: body.action, lot: parseFloat(body.lot),
        sl: parseFloat(body.sl || 0), tp: parseFloat(body.tp || 0),
        timestamp: Date.now(), status: 'pending'
    };
    tradeQueue.push(cmd);
    res.json({ status: 'OK', id: cmd.id });
});

app.post('/api/ea/close', function(req, res) {
    const body = req.body;
    if (!body.ticket) return res.status(400).json({ error: 'Missing ticket' });
    tradeQueue.push({
        id: Date.now() + Math.floor(Math.random() * 1000),
        type: 'CLOSE', ticket: parseInt(body.ticket), status: 'pending'
    });
    res.json({ status: 'OK' });
});

app.post('/api/ea/close-all', function(req, res) {
    tradeQueue.push({
        id: Date.now() + Math.floor(Math.random() * 1000),
        type: 'CLOSE_ALL', status: 'pending'
    });
    res.json({ status: 'OK' });
});

// ===============================================
// HELPERS
// ===============================================
const symbolMap = {
    'XAU/USD': 'XAU/USD', 'XAG/USD': 'XAG/USD',
    'EUR/USD': 'EUR/USD', 'GBP/USD': 'GBP/USD', 'USD/JPY': 'USD/JPY',
    'AUD/USD': 'AUD/USD', 'USD/CAD': 'USD/CAD', 'USD/CHF': 'USD/CHF'
};
function toTwelveData(s) { return symbolMap[s] || s; }
function getDecimal(s) {
    if (s.indexOf('JPY') >= 0) return 3;
    if (s.indexOf('XAU') >= 0 || s.indexOf('XAG') >= 0) return 2;
    return 5;
}

function calculateEMA(closes, period) {
    if (closes.length === 0) return 0;
    let e = closes[0];
    let k = 2 / (period + 1);
    for (let i = 1; i < closes.length; i++) e = (closes[i] * k) + (e * (1 - k));
    return e;
}

function calculateATR(candles, period) {
    period = period || 14;
    if (candles.length < period + 1) return 0;
    let trs = [];
    for (let i = candles.length - period; i < candles.length; i++) {
        const h = candles[i].high, l = candles[i].low, pc = candles[i - 1].close;
        trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
    }
    let sum = 0;
    for (let i = 0; i < trs.length; i++) sum += trs[i];
    return sum / period;
}

function getATRProfile(candles) {
    const atrNow = calculateATR(candles, 14);
    const atrAvg = calculateATR(candles, 50);
    if (atrAvg === 0 || atrNow === 0) return { atrNow: 0, ratio: 1, level: 'NORMAL', tp1Mult: 3.0, tp2Mult: 6.0, tp3Mult: 10.0 };
    const ratio = atrNow / atrAvg;
    let level, tp1Mult, tp2Mult, tp3Mult;
    if (ratio >= 1.5) { level = 'VOLATILE'; tp1Mult = 5.0; tp2Mult = 10.0; tp3Mult = 15.0; }
    else if (ratio >= 1.0) { level = 'NORMAL'; tp1Mult = 3.0; tp2Mult = 6.0; tp3Mult = 10.0; }
    else if (ratio >= 0.7) { level = 'SLOW'; tp1Mult = 2.0; tp2Mult = 4.0; tp3Mult = 6.0; }
    else { level = 'VERY_SLOW'; tp1Mult = 1.5; tp2Mult = 3.0; tp3Mult = 4.5; }
    return { atrNow: atrNow, atrAvg: atrAvg, ratio: ratio, level: level, tp1Mult: tp1Mult, tp2Mult: tp2Mult, tp3Mult: tp3Mult };
}

function getMarketSession() {
    const dayOfWeek = new Date().getUTCDay();
    if (dayOfWeek === 0 || dayOfWeek === 6) return 'CLOSED';
    const h = new Date().getUTCHours();
    if (h >= 7 && h < 12) return 'LONDON';
    if (h >= 12 && h < 16) return 'LONDON';
    if (h >= 16 && h < 21) return 'NEW YORK';
    if (h >= 0 && h < 7) return 'ASIA';
    return 'CLOSED';
}

function getSessionStatus(session) {
    if (session === 'LONDON' || session === 'NEW YORK') return '🟢 PRIME';
    if (session === 'ASIA') return '🟡 SLOW';
    return '🔴 CLOSED';
}

function detectSNR(candles) {
    if (!candles || candles.length < 50) return { S1: null, S2: null, S3: null, R1: null, R2: null, R3: null, POC: 0, VAH: 0, VAL: 0 };
    const recent = candles.slice(-200);
    const lastPrice = recent[recent.length - 1].close;
    const atrSlice = recent.slice(-14);
    let atrSum = 0;
    for (let i = 0; i < atrSlice.length; i++) atrSum += (atrSlice[i].high - atrSlice[i].low);
    const ATR = atrSum / 14;
    const tolerance = Math.max(lastPrice * 0.002, ATR * 0.4);

    let swingLows = [], swingHighs = [];
    for (let i = 2; i < recent.length - 2; i++) {
        const isLow = recent[i].low < recent[i - 1].low && recent[i].low < recent[i - 2].low &&
                      recent[i].low < recent[i + 1].low && recent[i].low < recent[i + 2].low;
        const isHigh = recent[i].high > recent[i - 1].high && recent[i].high > recent[i - 2].high &&
                       recent[i].high > recent[i + 1].high && recent[i].high > recent[i + 2].high;
        if (isLow) swingLows.push({ price: recent[i].low, index: i });
        if (isHigh) swingHighs.push({ price: recent[i].high, index: i });
    }

    let supports = swingLows.filter(function(s) { return s.price < lastPrice; });
    supports.sort(function(a, b) { return b.price - a.price; });
    supports = supports.filter(function(s, i) { return i === 0 || Math.abs(s.price - supports[i - 1].price) > tolerance; });

    let resistances = swingHighs.filter(function(s) { return s.price > lastPrice; });
    resistances.sort(function(a, b) { return a.price - b.price; });
    resistances = resistances.filter(function(s, i) { return i === 0 || Math.abs(s.price - resistances[i - 1].price) > tolerance; });

    const prices = recent.map(function(c) { return c.close; });
    prices.sort(function(a, b) { return a - b; });
    const POC = prices[Math.floor(prices.length / 2)];
    const VAH = prices[Math.floor(prices.length * 0.8)];
    const VAL = prices[Math.floor(prices.length * 0.2)];

    return {
        S1: supports[0] ? supports[0].price : null,
        S2: supports[1] ? supports[1].price : null,
        S3: supports[2] ? supports[2].price : null,
        R1: resistances[0] ? resistances[0].price : null,
        R2: resistances[1] ? resistances[1].price : null,
        R3: resistances[2] ? resistances[2].price : null,
        POC: POC, VAH: VAH, VAL: VAL, atr: ATR
    };
}

function analyzeCandles(candles) {
    if (!candles || candles.length < 50) return null;
    const closes = candles.map(function(c) { return c.close; });
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

    let buyScore = 0, sellScore = 0;
    if (ema9 > ema21 && ema21 > ema50) buyScore += 50;
    if (ema9 > ema21 && gap_9_21 > 0.30) buyScore += 20;
    if (ema9 > ema21 && gap_9_21 > 0.50) buyScore += 15;
    if (ema9 > ema21 && gap_9_21 > 0.80) buyScore += 15;

    if (ema9 < ema21 && ema21 < ema50) sellScore += 50;
    if (ema9 < ema21 && gap_9_21 > 0.30) sellScore += 20;
    if (ema9 < ema21 && gap_9_21 > 0.50) sellScore += 15;
    if (ema9 < ema21 && gap_9_21 > 0.80) sellScore += 15;

    if (gap_21_50 > 0.20) { if (ema21 > ema50) buyScore += 10; else sellScore += 10; }
    if (gap_21_50 > 0.40) { if (ema21 > ema50) buyScore += 10; else sellScore += 10; }
    if (bodyPct >= 0.60) { if (isBullCandle) buyScore += 10; else sellScore += 10; }
    if (bodyPct >= 0.80) { if (isBullCandle) buyScore += 10; else sellScore += 10; }

    let sig = 'WAIT', confidence = 0;
    const diff = Math.abs(buyScore - sellScore);
    const winner = buyScore > sellScore ? 'BUY' : sellScore > buyScore ? 'SELL' : 'WAIT';
    const winnerScore = Math.max(buyScore, sellScore);

    if (!(diff < SCORE_CHOPPY_DIFF && winnerScore >= SCORE_BOLEH)) {
        if (winner === 'BUY' && buyScore >= SCORE_BOLEH) { sig = 'BUY'; confidence = Math.min(buyScore, 100); }
        else if (winner === 'SELL' && sellScore >= SCORE_BOLEH) { sig = 'SELL'; confidence = Math.min(sellScore, 100); }
    }

    return { signal: sig, confidence: confidence, ema9: ema9, ema21: ema21, ema50: ema50, buyScore: buyScore, sellScore: sellScore };
}

async function checkMultiTimeframe(symbol) {
    const timeframes = [
        { tf: '5min', label: 'M5' },
        { tf: '15min', label: 'M15' },
        { tf: '30min', label: 'M30' },
        { tf: '1h', label: 'H1' }
    ];
    const results = [];
    for (let i = 0; i < timeframes.length; i++) {
        const item = timeframes[i];
        let tfResult = null;
        try {
            const candles = await getOHLC(symbol, item.tf, 100);
            tfResult = analyzeCandles(candles);
        } catch (e) { console.log('TF ' + item.label + ' fail: ' + e.message); }
        if (tfResult) results.push({ tf: item.tf, label: item.label, signal: tfResult.signal, confidence: tfResult.confidence });
        else results.push({ tf: item.tf, label: item.label, signal: 'WAIT', confidence: 0 });
    }
    let buyCount = 0, sellCount = 0;
    for (let i = 0; i < results.length; i++) {
        if (results[i].signal === 'BUY') buyCount++;
        if (results[i].signal === 'SELL') sellCount++;
    }
    const maxCount = Math.max(buyCount, sellCount);
    const majoritySignal = buyCount > sellCount ? 'BUY' : sellCount > buyCount ? 'SELL' : 'WAIT';
    return { timeframes: results, buyCount: buyCount, sellCount: sellCount, agreement: maxCount + '/4', consensus: majoritySignal };
}

// ===============================================
// GET TICK
// ===============================================
const tickCache = new Map();

function toEASymbol(symbol) {
    const base = symbol.replace('/', '');
    const suffixes = ['.vx', '', 'm', '.', 'c', 'pro', 'ecn', 'raw'];
    if (eaStatus.prices) {
        for (let i = 0; i < suffixes.length; i++) {
            const test = base + suffixes[i];
            if (eaStatus.prices[test]) return test;
        }
    }
    return base;
}

async function getTick(symbol) {
    const isEAOnline = (Date.now() - eaStatus.lastSeen) < 30000;
    
    if (isEAOnline && eaStatus.prices) {
        const eaSymbol = toEASymbol(symbol);
        const p = eaStatus.prices[eaSymbol];
        
        if (p) {
            const bid = parseFloat(p.bid || p.price || 0);
            const ask = parseFloat(p.ask || 0);
            const mid = bid ? (ask ? (bid + ask) / 2 : bid) : 0;
            
            if (mid > 0) {
                return { bid: bid, ask: ask || bid, mid: mid, spread: ask ? ask - bid : 0, source: 'MT4' };
            }
        }
    }
    
    const cached = tickCache.get(symbol);
    if (cached && Date.now() - cached.time < 30000) return cached.data;
    
    const tdSymbol = toTwelveData(symbol);
    let attempts = 0;
    const maxAttempts = TWELVEDATA_KEYS.length * 2 || 2;
    
    while (attempts < maxAttempts) {
        attempts++;
        try {
            const url = TWELVEDATA_URL + '/quote?symbol=' + encodeURIComponent(tdSymbol) + '&apikey=' + getCurrentKey();
            const response = await axios.get(url, { timeout: 10000 });
            const d = response.data;
            
            if (d.status === 'error' || d.code) {
                if (d.code === 429) { switchKey(); continue; }
                throw new Error(d.message || 'API error');
            }
            
            const bid = parseFloat(d.bid || 0);
            const ask = parseFloat(d.ask || 0);
            const price = parseFloat(d.close || d.price || 0);
            const mid = price || (bid + ask) / 2 || 0;
            
            if (mid === 0) throw new Error('Harga 0');
            
            const result = { bid: bid || mid, ask: ask || mid, mid: mid, spread: parseFloat(d.spread || (ask - bid) || 0), source: 'TWELVEDATA' };
            tickCache.set(symbol, { data: result, time: Date.now() });
            return result;
        } catch (e) {
            if (e.message && e.message.indexOf('429') >= 0) { switchKey(); continue; }
            if (attempts >= maxAttempts) throw e;
        }
    }
    throw new Error('Semua API key gagal');
}

const ohlcCache = new Map();
async function getOHLC(symbol, interval, limit) {
    interval = interval || '5min';
    limit = limit || 300;
    const cacheKey = symbol + '_' + interval + '_' + limit;
    const cached = ohlcCache.get(cacheKey);
    if (cached && Date.now() - cached.time < 180000) return cached.data;
    const tdSymbol = toTwelveData(symbol);
    let attempts = 0;
    const maxAttempts = TWELVEDATA_KEYS.length * 2 || 2;
    while (attempts < maxAttempts) {
        attempts++;
        try {
            const url = TWELVEDATA_URL + '/time_series?symbol=' + encodeURIComponent(tdSymbol) + '&interval=' + interval + '&outputsize=' + limit + '&apikey=' + getCurrentKey();
            const response = await axios.get(url, { timeout: 10000 });
            const d = response.data;
            if (d.status === 'error' || d.code) {
                if (d.code === 429) { switchKey(); continue; }
                throw new Error(d.message || 'API error');
            }
            if (!d.values || !Array.isArray(d.values)) return [];
            const result = d.values.slice().reverse().map(function(c) {
                return { open: parseFloat(c.open || 0), high: parseFloat(c.high || 0), low: parseFloat(c.low || 0), close: parseFloat(c.close || 0) };
            }).filter(function(c) { return c.close > 0; });
            ohlcCache.set(cacheKey, { data: result, time: Date.now() });
            return result;
        } catch (e) {
            if (e.message && e.message.indexOf('429') >= 0) { switchKey(); continue; }
            if (attempts >= maxAttempts) throw e;
        }
    }
    return [];
}

const signalLock = new Map();
const signalCooldown = new Map();

function calculateSLTP(direction, entry, atr, symbol, atrProfile) {
    const slDist = atr * 1.5;
    let tp1Mult = 3.0, tp2Mult = 6.0, tp3Mult = 10.0;
    if (atrProfile) { tp1Mult = atrProfile.tp1Mult; tp2Mult = atrProfile.tp2Mult; tp3Mult = atrProfile.tp3Mult; }
    const dec = getDecimal(symbol);
    if (direction === 'BUY') {
        return {
            sl: (entry - slDist).toFixed(dec),
            tp1: (entry + atr * tp1Mult).toFixed(dec),
            tp2: (entry + atr * tp2Mult).toFixed(dec),
            tp3: (entry + atr * tp3Mult).toFixed(dec)
        };
    } else {
        return {
            sl: (entry + slDist).toFixed(dec),
            tp1: (entry - atr * tp1Mult).toFixed(dec),
            tp2: (entry - atr * tp2Mult).toFixed(dec),
            tp3: (entry - atr * tp3Mult).toFixed(dec)
        };
    }
}

// ===============================================
// AI SESSION MAPPING
// ===============================================
async function generateSessionMapping(symbol, sessionName) {
    try {
        console.log('🤖 AI mapping: ' + symbol + ' (' + sessionName + ')...');
        
        const decimal = getDecimal(symbol);
        const tick = await getTick(symbol);
        const harga = tick.mid;
        
        const candlesH4 = await getOHLC(symbol, '4h', 100);
        const candlesH1 = await getOHLC(symbol, '1h', 200);
        const candlesM15 = await getOHLC(symbol, '15min', 200);
        const candlesM5 = await getOHLC(symbol, '5min', 300);
        
        if (candlesH4.length < 50) { console.log('Data tak cukup'); return; }
        
        const h4Analysis = analyzeCandles(candlesH4);
        const h1Analysis = analyzeCandles(candlesH1);
        const m15Analysis = analyzeCandles(candlesM15);
        const m5Analysis = analyzeCandles(candlesM5);
        
        const h4SNR = detectSNR(candlesH4);
        const h4ATR = calculateATR(candlesH4, 14);
        
        const mtf = await checkMultiTimeframe(symbol);
        const sessionStatus = getSessionStatus(sessionName);
        
        const nowMYT = new Date(Date.now() + 8 * 60 * 60 * 1000);
        const dateStr = nowMYT.toISOString().split('T')[0];
        const timeStr = nowMYT.toTimeString().substring(0, 5);
        const dayName = ['Ahad','Isnin','Selasa','Rabu','Khamis','Jumaat','Sabtu'][nowMYT.getUTCDay()];
        
        const prompt = `Kau trader professional. Buat SESSION MAPPING untuk ${sessionName}.

DATA:
- Pair: ${symbol}
- Harga: ${harga.toFixed(decimal)} (${tick.source})
- Masa: ${timeStr} MYT, ${dayName} ${dateStr}
- Session: ${sessionName} (${sessionStatus})

ANALISIS TEKNIKAL:
H4 Bias: ${h4Analysis ? h4Analysis.signal : 'WAIT'} (${h4Analysis ? h4Analysis.confidence : 0}%)
EMA9: ${h4Analysis ? h4Analysis.ema9.toFixed(decimal) : '-'} | EMA21: ${h4Analysis ? h4Analysis.ema21.toFixed(decimal) : '-'} | EMA50: ${h4Analysis ? h4Analysis.ema50.toFixed(decimal) : '-'}
ATR H4: ${h4ATR.toFixed(decimal)}

Key Levels H4:
R2: ${h4SNR.R2 ? h4SNR.R2.toFixed(decimal) : '-'}
R1: ${h4SNR.R1 ? h4SNR.R1.toFixed(decimal) : '-'}
POC: ${h4SNR.POC ? h4SNR.POC.toFixed(decimal) : '-'}
S1: ${h4SNR.S1 ? h4SNR.S1.toFixed(decimal) : '-'}
S2: ${h4SNR.S2 ? h4SNR.S2.toFixed(decimal) : '-'}

MTF: M5=${m5Analysis ? m5Analysis.signal : 'WAIT'}, M15=${m15Analysis ? m15Analysis.signal : 'WAIT'}, H1=${h1Analysis ? h1Analysis.signal : 'WAIT'} (${mtf.agreement}, ${mtf.consensus})

FORMAT JAWAPAN (Bahasa Melayu, padat):

📉/📈 BIAS ${sessionName}: [BUY/SELL/WAIT] - [1 ayat reason]

🎯 KEY LEVEL:
• Resistance: X.XX
• Support: X.XX

📍 PLAN ENTRY:
• Entry: X.XX – X.XX
• SL: X.XX
• TP1: X.XX
• TP2: X.XX

⚠️ WHAT TO WATCH:
• [3-4 pointer]

💡 SESSION TIP:
[1-2 ayat]

Jangan panjang. Padat & actionable. Guna emoji.`;

        const result = await ai.models.generateContent({
            model: GEMINI_MODEL,
            contents: prompt
        });
        
        const aiAnalysis = result.text;
        const sessionEmoji = sessionName === 'LONDON' ? '🇬🇧' : sessionName === 'NEW YORK' ? '🇺🇸' : sessionName === 'ASIA' ? '🇯🇵' : '🌍';
        
        const msg = `${sessionEmoji} <b>SESSION ${sessionName}</b>\n` +
                    `⏰ ${timeStr} MYT | 📅 ${dayName} ${dateStr}\n` +
                    `━━━━━━━━━━━━━━━━\n\n` +
                    `💰 <b>${symbol}: ${harga.toFixed(decimal)}</b> (${tick.source})\n` +
                    `📊 ${sessionStatus}\n\n` +
                    `━━━━━━━━━━━━━━━━\n` +
                    `🤖 <b>AI ANALYSIS</b>\n` +
                    `━━━━━━━━━━━━━━━━\n\n` +
                    aiAnalysis + `\n\n` +
                    `━━━━━━━━━━━━━━━━\n` +
                    `📈 MTF: ${mtf.agreement} (${mtf.consensus})\n` +
                    `⚠️ <i>Auto mapping — bukan signal.</i>`;
        
        if (msg.length > 4000) {
            const parts = [];
            let current = '';
            const lines = msg.split('\n');
            for (const line of lines) {
                if ((current + line).length > 3900) {
                    parts.push(current);
                    current = line + '\n';
                } else {
                    current += line + '\n';
                }
            }
            if (current) parts.push(current);
            for (const part of parts) {
                await sendTelegram(part);
                await new Promise(r => setTimeout(r, 1000));
            }
        } else {
            await sendTelegram(msg);
        }
        
        aiMappings[sessionName] = {
            session: sessionName,
            time: nowMYT.toISOString(),
            timeStr: timeStr,
            dateStr: dateStr,
            dayName: dayName,
            symbol: symbol,
            harga: parseFloat(harga.toFixed(decimal)),
            harga_source: tick.source,
            session_status: sessionStatus,
            ai_analysis: aiAnalysis,
            mtf_agreement: mtf.agreement,
            mtf_consensus: mtf.consensus,
            h4_signal: h4Analysis ? h4Analysis.signal : 'WAIT',
            h4_confidence: h4Analysis ? h4Analysis.confidence : 0,
            levels: {
                r2: h4SNR.R2 ? parseFloat(h4SNR.R2.toFixed(decimal)) : null,
                r1: h4SNR.R1 ? parseFloat(h4SNR.R1.toFixed(decimal)) : null,
                poc: h4SNR.POC ? parseFloat(h4SNR.POC.toFixed(decimal)) : null,
                s1: h4SNR.S1 ? parseFloat(h4SNR.S1.toFixed(decimal)) : null,
                s2: h4SNR.S2 ? parseFloat(h4SNR.S2.toFixed(decimal)) : null
            }
        };
        aiMappings.lastUpdate = Date.now();
        
        console.log('✅ ' + sessionName + ' mapping sent & saved');
        
    } catch (e) {
        console.log('❌ ' + sessionName + ' error:', e.message);
    }
}

// ===============================================
// SCHEDULE
// ===============================================
let lastTrigger = { ASIA: '', LONDON: '', NY: '' };

setInterval(function() {
    const now = new Date();
    const utcHour = now.getUTCHours();
    const utcMinute = now.getUTCMinutes();
    const today = now.toISOString().split('T')[0];
    
    if (utcHour === 23 && utcMinute < 5 && lastTrigger.ASIA !== today) {
        lastTrigger.ASIA = today;
        generateSessionMapping('XAU/USD', 'ASIA').catch(e => console.log(e.message));
    }
    if (utcHour === 7 && utcMinute < 5 && lastTrigger.LONDON !== today) {
        lastTrigger.LONDON = today;
        generateSessionMapping('XAU/USD', 'LONDON').catch(e => console.log(e.message));
    }
    if (utcHour === 12 && utcMinute < 5 && lastTrigger.NY !== today) {
        lastTrigger.NY = today;
        generateSessionMapping('XAU/USD', 'NEW YORK').catch(e => console.log(e.message));
    }
}, 60000);

// ===============================================
// API: SIGNAL
// ===============================================
app.get('/api/signal', async function(req, res) {
    const symbol = req.query.symbol || 'XAU/USD';
    const decimal = getDecimal(symbol);
    try {
        const candles = await getOHLC(symbol, '5min', 300);
        if (candles.length < 50) throw new Error('Data tak cukup');
        const closes = candles.map(function(c) { return c.close; });
        
        const tick = await getTick(symbol);
        const harga = tick.mid || closes[closes.length - 1];
        
        const emaAnalysis = analyzeCandles(candles);
        const emaSignal = emaAnalysis ? emaAnalysis.signal : 'WAIT';
        const emaConfidence = emaAnalysis ? emaAnalysis.confidence : 0;
        const ema9 = emaAnalysis ? emaAnalysis.ema9 : 0;
        const ema21 = emaAnalysis ? emaAnalysis.ema21 : 0;
        const ema50 = emaAnalysis ? emaAnalysis.ema50 : 0;
        const atr = calculateATR(candles, 14);
        const atrProfile = getATRProfile(candles);
        const snr = detectSNR(candles);
        const mtf = await checkMultiTimeframe(symbol);

        const now = Date.now();
        const cooldownData = signalCooldown.get(symbol);
        const isCooldown = cooldownData && (now - cooldownData.time) < COOLDOWN_MS;
        const existingLock = signalLock.get(symbol);
        let signal = 'WAIT', isLocked = false, lockedEntry = null, lockUntil = 0;

        if (!isCooldown) {
            if (existingLock) {
                const lockAge = Date.now() - existingLock.lockedAt;
                if (lockAge < MAX_LOCK_MS) {
                    signal = existingLock.direction;
                    lockedEntry = existingLock.entry;
                    lockUntil = existingLock.lockedAt + MAX_LOCK_MS;
                    isLocked = true;
                } else signalLock.delete(symbol);
            } else if (emaSignal !== 'WAIT' && emaConfidence >= 70) {
                signal = emaSignal;
                const lockData = { direction: signal, entry: harga, lockedAt: Date.now() };
                signalLock.set(symbol, lockData);
                signalCooldown.set(symbol, { time: Date.now(), direction: signal });
                lockedEntry = harga;
                lockUntil = lockData.lockedAt + MAX_LOCK_MS;
                isLocked = true;
                
                try {
                    const sltpTg = calculateSLTP(signal, harga, atr, symbol, atrProfile);
                    const emoji = emaConfidence >= 90 ? '🚀' : '⚡';
                    const srcEmoji = tick.source === 'MT4' ? '💼' : '📡';
                    
                    const msgTg = emoji + ' <b>SIGNAL ' + signal + '</b> (' + emaConfidence + '%)\n' +
                                   '━━━━━━━━━━━━━━━━\n' +
                                   '📊 ' + symbol + '\n' +
                                   '🎯 Entry: ' + harga.toFixed(decimal) + ' ' + srcEmoji + '\n\n' +
                                   '🛑 SL: ' + sltpTg.sl + '\n' +
                                   '✅ TP1: ' + sltpTg.tp1 + '\n' +
                                   '✅ TP2: ' + sltpTg.tp2 + '\n' +
                                   '✅ TP3: ' + sltpTg.tp3 + '\n\n' +
                                   '📊 ATR: ' + atrProfile.level + '\n' +
                                   '⏰ ' + getMarketSession() + '\n' +
                                   '📈 MTF: ' + mtf.agreement;
                    
                    await sendTelegram(msgTg);
                } catch (e) { console.log('TG error:', e.message); }
            }
        }

        const displayPrice = lockedEntry !== null ? lockedEntry : harga;
        const sltp = (signal === 'BUY' || signal === 'SELL') ? calculateSLTP(signal, displayPrice, atr, symbol, atrProfile) : null;

        res.json({
            symbol: symbol,
            harga: parseFloat(harga.toFixed(decimal)),
            harga_source: tick.source || 'TWELVEDATA',
            signal: signal,
            action: signal,
            bias: emaSignal,
            score: emaConfidence,
            entry: parseFloat(displayPrice.toFixed(decimal)),
            harga_entry: parseFloat(displayPrice.toFixed(decimal)),
            entryZone: [
                parseFloat((displayPrice - atr * 0.8).toFixed(decimal)),
                parseFloat((displayPrice + atr * 0.8).toFixed(decimal))
            ],
            sl: sltp ? parseFloat(sltp.sl) : null,
            tp1: sltp ? parseFloat(sltp.tp1) : null,
            tp2: sltp ? parseFloat(sltp.tp2) : null,
            tp3: sltp ? parseFloat(sltp.tp3) : null,
            lockUntil: lockUntil,
            locked: isLocked,
            POC: snr.POC ? parseFloat(snr.POC.toFixed(decimal)) : null,
            VAH: snr.VAH ? parseFloat(snr.VAH.toFixed(decimal)) : null,
            VAL: snr.VAL ? parseFloat(snr.VAL.toFixed(decimal)) : null,
            R1: snr.R1 ? parseFloat(snr.R1.toFixed(decimal)) : null,
            R2: snr.R2 ? parseFloat(snr.R2.toFixed(decimal)) : null,
            R3: snr.R3 ? parseFloat(snr.R3.toFixed(decimal)) : null,
            S1: snr.S1 ? parseFloat(snr.S1.toFixed(decimal)) : null,
            S2: snr.S2 ? parseFloat(snr.S2.toFixed(decimal)) : null,
            S3: snr.S3 ? parseFloat(snr.S3.toFixed(decimal)) : null,
            snr: {
                poc: snr.POC ? parseFloat(snr.POC.toFixed(decimal)) : null,
                vah: snr.VAH ? parseFloat(snr.VAH.toFixed(decimal)) : null,
                val: snr.VAL ? parseFloat(snr.VAL.toFixed(decimal)) : null,
                r1: snr.R1 ? parseFloat(snr.R1.toFixed(decimal)) : null,
                r2: snr.R2 ? parseFloat(snr.R2.toFixed(decimal)) : null,
                r3: snr.R3 ? parseFloat(snr.R3.toFixed(decimal)) : null,
                s1: snr.S1 ? parseFloat(snr.S1.toFixed(decimal)) : null,
                s2: snr.S2 ? parseFloat(snr.S2.toFixed(decimal)) : null,
                s3: snr.S3 ? parseFloat(snr.S3.toFixed(decimal)) : null
            },
            mtf: {
                timeframes: mtf.timeframes,
                agreement: mtf.agreement,
                consensus: mtf.consensus,
                buyCount: mtf.buyCount,
                sellCount: mtf.sellCount
            },
            agreement: mtf.agreement,
            ema9: parseFloat(ema9.toFixed(decimal)),
            ema21: parseFloat(ema21.toFixed(decimal)),
            ema50: parseFloat(ema50.toFixed(decimal)),
            atr: parseFloat(atr.toFixed(decimal)),
            atrLevel: atrProfile.level,
            session: getMarketSession(),
            timeframe: '5min'
        });
    } catch (error) {
        console.error('/api/signal error:', error.message);
        res.json({
            symbol: symbol, signal: 'WAIT', action: 'WAIT', score: 0,
            harga: 0, entry: 0, sl: null, tp1: null,
            ema9: 0, ema21: 0, ema50: 0, error: error.message
        });
    }
});

// ===============================================
// API: MAPPING
// ===============================================
app.get('/api/mapping', function(req, res) {
    res.json({
        status: 'OK',
        mappings: aiMappings,
        current_session: getMarketSession(),
        timestamp: Date.now()
    });
});

app.get('/api/generate-mapping', async function(req, res) {
    const symbol = req.query.symbol || 'XAU/USD';
    const session = req.query.session || 'LONDON';
    try {
        await generateSessionMapping(symbol, session.toUpperCase());
        res.json({ status: 'OK', message: session + ' mapping sent' });
    } catch (e) {
        res.json({ status: 'FAIL', error: e.message });
    }
});

// ===============================================
// API: MARKET
// ===============================================
app.get('/api/market', async function(req, res) {
    const symbol = req.query.symbol || 'XAU/USD';
    const decimal = getDecimal(symbol);
    try {
        const tick = await getTick(symbol);
        const candles = await getOHLC(symbol, '5min', 300);
        const closes = candles.map(function(c) { return c.close; });
        const harga = tick.mid || closes[closes.length - 1];
        const emaAnalysis = analyzeCandles(candles);
        const ema9 = emaAnalysis ? emaAnalysis.ema9 : 0;
        const ema21 = emaAnalysis ? emaAnalysis.ema21 : 0;
        const ema50 = emaAnalysis ? emaAnalysis.ema50 : 0;
        const snr = detectSNR(candles);

        const poc = snr.POC ? parseFloat(snr.POC.toFixed(decimal)) : null;
        const vah = snr.VAH ? parseFloat(snr.VAH.toFixed(decimal)) : null;
        const val = snr.VAL ? parseFloat(snr.VAL.toFixed(decimal)) : null;
        const r1 = snr.R1 ? parseFloat(snr.R1.toFixed(decimal)) : null;
        const r2 = snr.R2 ? parseFloat(snr.R2.toFixed(decimal)) : null;
        const r3 = snr.R3 ? parseFloat(snr.R3.toFixed(decimal)) : null;
        const s1 = snr.S1 ? parseFloat(snr.S1.toFixed(decimal)) : null;
        const s2 = snr.S2 ? parseFloat(snr.S2.toFixed(decimal)) : null;
        const s3 = snr.S3 ? parseFloat(snr.S3.toFixed(decimal)) : null;

        res.json({
            symbol: symbol,
            harga: parseFloat(harga.toFixed(decimal)),
            harga_source: tick.source || 'TWELVEDATA',
            bid: parseFloat((tick.bid || harga).toFixed(decimal)),
            ask: parseFloat((tick.ask || harga).toFixed(decimal)),
            spread: parseFloat((tick.spread || 0).toFixed(decimal)),
            ema9: parseFloat(ema9.toFixed(decimal)),
            ema21: parseFloat(ema21.toFixed(decimal)),
            ema50: parseFloat(ema50.toFixed(decimal)),
            POC: poc, VAH: vah, VAL: val,
            R1: r1, R2: r2, R3: r3,
            S1: s1, S2: s2, S3: s3,
            poc: poc, vah: vah, val: val,
            r1: r1, r2: r2, r3: r3,
            s1: s1, s2: s2, s3: s3,
            snr: { poc: poc, vah: vah, val: val, r1: r1, r2: r2, r3: r3, s1: s1, s2: s2, s3: s3 },
            session: getMarketSession(),
            time: new Date().toLocaleTimeString()
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ===============================================
// API: TEST TWELVEDATA (untuk UptimeRobot)
// ===============================================
app.get('/api/test-twelvedata', async function(req, res) {
    try {
        const tick = await getTick('XAU/USD');
        res.json({ 
            status: 'OK', 
            keys_loaded: TWELVEDATA_KEYS.length,
            source: tick.source,
            harga: tick.mid,
            timestamp: new Date().toISOString()
        });
    } catch (e) {
        res.json({ status: 'FAIL', error: e.message });
    }
});

// ===============================================
// API: NEWS (placeholder)
// ===============================================
app.get('/api/news', function(req, res) {
    res.json({ status: 'success', events: [], note: 'News endpoint' });
});

// ===============================================
// HEALTH & TEST
// ===============================================
app.get('/health', function(req, res) {
    res.json({ status: 'OK', version: '1.24.2', timestamp: new Date().toISOString() });
});

app.get('/api/test-ea', function(req, res) {
    res.json({
        ea_api_key_set: !!EA_API_KEY,
        ea_online: eaStatus.online,
        queue_length: tradeQueue.length,
        prices_count: Object.keys(eaStatus.prices || {}).length,
        telegram_set: !!TELEGRAM_BOT_TOKEN && !!TELEGRAM_CHAT_ID,
        gemini_set: !!GEMINI_API_KEY,
        gemini_model: GEMINI_MODEL
    });
});

app.get('/api/test-telegram', async function(req, res) {
    try {
        await sendTelegram('🧪 <b>Test Telegram</b>\n\nBPT v1.24.2 ✅');
        res.json({ status: 'OK' });
    } catch (e) {
        res.json({ status: 'FAIL', error: e.message });
    }
});

app.get('/', function(req, res) {
    res.sendFile(__dirname + '/index.html');
});

// ===============================================
// START
// ===============================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, function() {
    console.log('BPT v1.24.2 running on port ' + PORT);
});