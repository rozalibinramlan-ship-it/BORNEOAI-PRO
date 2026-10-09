// ===============================================
// BPT — Borneo Pro Trade
// Server v3.0 — Full Notification + Persist
// ===============================================
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { GoogleGenAI } = require('@google/genai');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.static(__dirname));

// ===============================================
// CONFIG
// ===============================================
const TWELVEDATA_URL = 'https://api.twelvedata.com';
const BIQUOTE_URL = 'https://biquote.io/api';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';

const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
const GEMINI_MODEL = 'gemini-flash-latest';

const COOLDOWN_MS = 15 * 60 * 1000;
const MAX_LOCK_MS = 30 * 60 * 1000;
const NEWS_AVOID_MS = 60 * 60 * 1000;
const SCORE_BOLEH = 65;

const SPREAD_LIMIT = {
    'XAU/USD': 0.80, 'XAG/USD': 0.05,
    'EUR/USD': 0.00025, 'GBP/USD': 0.00035, 'USD/JPY': 0.025,
    'DEFAULT': 0.0010
};

const TWELVEDATA_KEYS = [
    process.env.TWELVEDATA_API_KEY || '',
    process.env.TWELVEDATA_API_KEY_2 || '',
    process.env.TWELVEDATA_API_KEY_3 || ''
].filter(function(k) { return k.length > 0; });

let currentKeyIndex = 0;
function getCurrentKey() { return TWELVEDATA_KEYS[currentKeyIndex] || TWELVEDATA_KEYS[0] || ''; }
function switchKey() { if (TWELVEDATA_KEYS.length > 1) { currentKeyIndex = (currentKeyIndex + 1) % TWELVEDATA_KEYS.length; } }

console.log('╔══════════════════════════════════════╗');
console.log('║   BPT — BORNEO PRO TRADE v3.0        ║');
console.log('╚══════════════════════════════════════╝');
console.log('TwelveData: ' + TWELVEDATA_KEYS.length + ' keys');
console.log('Telegram: ' + (TELEGRAM_BOT_TOKEN ? 'OK' : 'TAK SET'));
console.log('Gemini: ' + (GEMINI_API_KEY ? 'OK' : 'TAK SET'));

// ===============================================
// FILE PATHS — Persist Data
// ===============================================
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

const FILES = {
    mappings: path.join(DATA_DIR, 'mappings.json'),
    history: path.join(DATA_DIR, 'history.json'),
    trades: path.join(DATA_DIR, 'trades.json'),
    signalHistory: path.join(DATA_DIR, 'signal-history.json')
};

// ===============================================
// STORAGE
// ===============================================
let aiMappings = { ASIA: null, LONDON: null, 'NEW YORK': null, lastUpdate: 0 };
let newsCache = { events: [], fetchedAt: 0 };
const NEWS_CACHE_MS = 10 * 60 * 1000;
let messageHistory = [];
let signalHistory = [];
let tradeHistory = [];

const levelAlertCooldown = new Map();
const newsAlertCooldown = new Map();
const liquidityCooldown = new Map();

// ===============================================
// PERSIST FUNCTIONS
// ===============================================
function loadJSON(file, defaultVal) {
    try {
        if (fs.existsSync(file)) {
            const data = fs.readFileSync(file, 'utf8');
            return JSON.parse(data);
        }
    } catch (e) {
        console.log('⚠️ Load ' + path.basename(file) + ' error:', e.message);
    }
    return defaultVal;
}

function saveJSON(file, data) {
    try {
        fs.writeFileSync(file, JSON.stringify(data, null, 2));
    } catch (e) {
        console.log('⚠️ Save ' + path.basename(file) + ' error:', e.message);
    }
}

function loadAllData() {
    aiMappings = loadJSON(FILES.mappings, { ASIA: null, LONDON: null, 'NEW YORK': null, lastUpdate: 0 });
    messageHistory = loadJSON(FILES.history, []);
    signalHistory = loadJSON(FILES.signalHistory, []);
    tradeHistory = loadJSON(FILES.trades, []);
    
    console.log('📂 Data loaded:');
    console.log('   - Mappings: ' + Object.keys(aiMappings).filter(k => aiMappings[k] && k !== 'lastUpdate').length);
    console.log('   - Messages: ' + messageHistory.length);
    console.log('   - Signals: ' + signalHistory.length);
    console.log('   - Trades: ' + tradeHistory.length);
}

function saveMappings() { saveJSON(FILES.mappings, aiMappings); }
function saveHistory() { saveJSON(FILES.history, messageHistory.slice(0, 100)); }
function saveSignalHistory() { saveJSON(FILES.signalHistory, signalHistory.slice(0, 200)); }
function saveTradeHistory() { saveJSON(FILES.trades, tradeHistory.slice(0, 200)); }

loadAllData();

// ===============================================
// SESSION HELPERS
// ===============================================
function getMarketSession() {
    const dayOfWeek = new Date().getUTCDay();
    if (dayOfWeek === 0 || dayOfWeek === 6) return 'CLOSED';
    const h = new Date().getUTCHours();
    if (h >= 0 && h < 7) return 'ASIA';
    if (h >= 7 && h < 12) return 'LONDON';
    if (h >= 12 && h < 16) return 'LONDON';
    if (h >= 16 && h < 21) return 'NEW YORK';
    return 'CLOSED';
}

function getSessionStatus(session) {
    if (session === 'LONDON' || session === 'NEW YORK') return '🟢 PRIME';
    if (session === 'ASIA') return '🟡 SLOW';
    return '🔴 CLOSED';
}

function isSessionActive(sessionName) {
    const current = getMarketSession();
    if (sessionName === 'NEW YORK') return current === 'NEW YORK' || current === 'LONDON';
    return current === sessionName;
}

function isMappingValid(sessionName) {
    const mapping = aiMappings[sessionName];
    if (!mapping) return false;
    const nowMYT = new Date(Date.now() + 8 * 60 * 60 * 1000);
    const today = nowMYT.toISOString().split('T')[0];
    if (mapping.dateStr === today && isSessionActive(sessionName)) return true;
    return false;
}

// ===============================================
// SEND + SAVE
// ===============================================
async function sendAndSave(type, data) {
    try {
        if (data.telegram_msg) await sendTelegram(data.telegram_msg);
        
        const entry = {
            id: Date.now() + Math.floor(Math.random() * 1000),
            type: type,
            timestamp: Date.now(),
            data: data,
            telegram_sent: !!data.telegram_msg
        };
        
        messageHistory.unshift(entry);
        if (messageHistory.length > 100) messageHistory.pop();
        saveHistory();
        
        if (type === 'signal') {
            signalHistory.unshift(entry);
            if (signalHistory.length > 200) signalHistory.pop();
            saveSignalHistory();
        }
        
        console.log('✅ ' + type + ' saved');
    } catch (e) { 
        console.log('❌ sendAndSave error:', e.message); 
    }
}

// ===============================================
// TELEGRAM
// ===============================================
async function sendTelegram(message) {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
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
// EA BRIDGE
// ===============================================
let eaStatus = {
    online: false, lastSeen: 0, balance: 0, equity: 0, margin: 0,
    freeMargin: 0, profit: 0, positions: [], prices: {},
    accountNumber: '', broker: '', leverage: 0, currency: 'USD'
};
let tradeQueue = [];

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
    } else res.json({ command: null });
});

app.post('/api/ea/result', express.text({ type: '*/*' }), function(req, res) {
    const body = parseEAJson(req.body);
    const cmd = tradeQueue.find(function(c) { return c.id === body.id; });
    if (cmd) {
        cmd.status = body.success ? 'executed' : 'failed';
        cmd.ticket = body.ticket; 
        cmd.error = body.error || '';
        tradeHistory.push(Object.assign({}, cmd));
        if (tradeHistory.length > 200) tradeHistory.shift();
        saveTradeHistory();
    }
    res.json({ status: 'OK' });
});

app.use(express.json({ strict: false, limit: '5mb' }));

app.post('/api/ea/execute', function(req, res) {
    const body = req.body;
    if (!body.symbol || !body.action || !body.lot) 
        return res.status(400).json({ error: 'Missing fields' });
    
    const cmd = {
        id: Date.now() + Math.floor(Math.random() * 1000),
        symbol: body.symbol, 
        action: body.action, 
        lot: parseFloat(body.lot),
        sl: parseFloat(body.sl || 0), 
        tp: parseFloat(body.tp || 0),
        timestamp: Date.now(), 
        status: 'pending'
    };
    tradeQueue.push(cmd);
    res.json({ status: 'OK', id: cmd.id });
});

app.post('/api/ea/close', function(req, res) {
    const body = req.body;
    if (!body.ticket) return res.status(400).json({ error: 'Missing ticket' });
    tradeQueue.push({ 
        id: Date.now() + Math.floor(Math.random() * 1000), 
        type: 'CLOSE', 
        ticket: parseInt(body.ticket), 
        status: 'pending' 
    });
    res.json({ status: 'OK' });
});

app.post('/api/ea/close-all', function(req, res) {
    tradeQueue.push({ 
        id: Date.now() + Math.floor(Math.random() * 1000), 
        type: 'CLOSE_ALL', 
        status: 'pending' 
    });
    res.json({ status: 'OK' });
});

// ===============================================
// HELPERS
// ===============================================
const symbolMap = {
    'XAU/USD': 'XAU/USD', 'XAG/USD': 'XAG/USD', 'EUR/USD': 'EUR/USD',
    'GBP/USD': 'GBP/USD', 'USD/JPY': 'USD/JPY', 'AUD/USD': 'AUD/USD',
    'USD/CAD': 'USD/CAD', 'USD/CHF': 'USD/CHF'
};

function toTwelveData(s) { return symbolMap[s] || s; }

function getDecimal(s) {
    if (s.indexOf('JPY') >= 0) return 3;
    if (s.indexOf('XAU') >= 0 || s.indexOf('XAG') >= 0) return 2;
    return 5;
}

function getSpreadLimit(symbol) { return SPREAD_LIMIT[symbol] || SPREAD_LIMIT['DEFAULT']; }

function getPipSize(symbol) {
    if (symbol.indexOf('JPY') >= 0) return 0.01;
    if (symbol.indexOf('XAU') >= 0) return 0.10;
    if (symbol.indexOf('XAG') >= 0) return 0.01;
    return 0.0001;
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
    if (atrAvg === 0 || atrNow === 0) 
        return { atrNow: 0, ratio: 1, level: 'NORMAL', tp1Mult: 3.0, tp2Mult: 6.0, tp3Mult: 10.0 };
    
    const ratio = atrNow / atrAvg;
    let level, tp1Mult, tp2Mult, tp3Mult;
    
    if (ratio >= 1.5) { level = 'VOLATILE'; tp1Mult = 5.0; tp2Mult = 10.0; tp3Mult = 15.0; }
    else if (ratio >= 1.0) { level = 'NORMAL'; tp1Mult = 3.0; tp2Mult = 6.0; tp3Mult = 10.0; }
    else if (ratio >= 0.7) { level = 'SLOW'; tp1Mult = 2.0; tp2Mult = 4.0; tp3Mult = 6.0; }
    else { level = 'VERY_SLOW'; tp1Mult = 1.5; tp2Mult = 3.0; tp3Mult = 4.5; }
    
    return { atrNow, atrAvg, ratio, level, tp1Mult, tp2Mult, tp3Mult };
}

function detectSNR(candles) {
    if (!candles || candles.length < 50) 
        return { S1: null, S2: null, S3: null, R1: null, R2: null, R3: null, POC: 0 };
    
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
    supports = supports.filter(function(s, i) { 
        return i === 0 || Math.abs(s.price - supports[i - 1].price) > tolerance; 
    });
    
    let resistances = swingHighs.filter(function(s) { return s.price > lastPrice; });
    resistances.sort(function(a, b) { return a.price - b.price; });
    resistances = resistances.filter(function(s, i) { 
        return i === 0 || Math.abs(s.price - resistances[i - 1].price) > tolerance; 
    });
    
    return {
        S1: supports[0] ? supports[0].price : null,
        S2: supports[1] ? supports[1].price : null,
        S3: supports[2] ? supports[2].price : null,
        R1: resistances[0] ? resistances[0].price : null,
        R2: resistances[1] ? resistances[1].price : null,
        R3: resistances[2] ? resistances[2].price : null,
        POC: lastPrice
    };
}

function detectLiquidity(candles) {
    if (!candles || candles.length < 100) return null;
    
    const recent = candles.slice(-300);
    const currentPrice = recent[recent.length - 1].close;
    
    const yesterdayCandles = recent.slice(-288, -50);
    const yesterdayHigh = yesterdayCandles.length > 0 ? Math.max.apply(null, yesterdayCandles.map(c => c.high)) : 0;
    const yesterdayLow = yesterdayCandles.length > 0 ? Math.min.apply(null, yesterdayCandles.map(c => c.low)) : 0;
    
    const asiaCandles = recent.slice(-96, -20);
    const asiaHigh = asiaCandles.length > 0 ? Math.max.apply(null, asiaCandles.map(c => c.high)) : 0;
    const asiaLow = asiaCandles.length > 0 ? Math.min.apply(null, asiaCandles.map(c => c.low)) : 0;
    
    const londonCandles = recent.slice(-60);
    const londonHigh = londonCandles.length > 0 ? Math.max.apply(null, londonCandles.map(c => c.high)) : 0;
    const londonLow = londonCandles.length > 0 ? Math.min.apply(null, londonCandles.map(c => c.low)) : 0;
    
    const lastCandle = recent[recent.length - 1];
    let sweep = null;
    
    if (yesterdayHigh > 0 && lastCandle.high > yesterdayHigh && lastCandle.close < yesterdayHigh) {
        sweep = { type: 'SWEEP_HIGH', level: yesterdayHigh, source: 'YESTERDAY_HIGH', bias: 'SELL' };
    } else if (asiaHigh > 0 && lastCandle.high > asiaHigh && lastCandle.close < asiaHigh) {
        sweep = { type: 'SWEEP_HIGH', level: asiaHigh, source: 'ASIA_HIGH', bias: 'SELL' };
    } else if (londonHigh > 0 && lastCandle.high > londonHigh && lastCandle.close < londonHigh) {
        sweep = { type: 'SWEEP_HIGH', level: londonHigh, source: 'LONDON_HIGH', bias: 'SELL' };
    } else if (yesterdayLow > 0 && lastCandle.low < yesterdayLow && lastCandle.close > yesterdayLow) {
        sweep = { type: 'SWEEP_LOW', level: yesterdayLow, source: 'YESTERDAY_LOW', bias: 'BUY' };
    } else if (asiaLow > 0 && lastCandle.low < asiaLow && lastCandle.close > asiaLow) {
        sweep = { type: 'SWEEP_LOW', level: asiaLow, source: 'ASIA_LOW', bias: 'BUY' };
    } else if (londonLow > 0 && lastCandle.low < londonLow && lastCandle.close > londonLow) {
        sweep = { type: 'SWEEP_LOW', level: londonLow, source: 'LONDON_LOW', bias: 'BUY' };
    }
    
    return { 
        yesterdayHigh, yesterdayLow, 
        asiaHigh, asiaLow, 
        londonHigh, londonLow, 
        sweep, currentPrice 
    };
}

function analyzeCandles(candles, symbol, snr, liquidity) {
    if (!candles || candles.length < 50) return null;
    
    const closes = candles.map(c => c.close);
    const currentPrice = closes[closes.length - 1];
    
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
    let buyReasons = [], sellReasons = [];
    
    if (ema9 > ema21 && ema21 > ema50) { buyScore += 50; buyReasons.push('EMA BUY'); }
    if (ema9 < ema21 && ema21 < ema50) { sellScore += 50; sellReasons.push('EMA SELL'); }
    
    if (ema9 > ema21 && gap_9_21 > 0.25) { buyScore += 20; buyReasons.push('Gap 9-21'); }
    if (ema9 > ema21 && gap_9_21 > 0.50) { buyScore += 15; buyReasons.push('Gap besar'); }
    if (ema9 < ema21 && gap_9_21 > 0.25) { sellScore += 20; sellReasons.push('Gap 9-21'); }
    if (ema9 < ema21 && gap_9_21 > 0.50) { sellScore += 15; sellReasons.push('Gap besar'); }
    
    if (gap_21_50 > 0.20) {
        if (ema21 > ema50) { buyScore += 10; buyReasons.push('Trend kuat'); }
        else { sellScore += 10; sellReasons.push('Trend kuat'); }
    }
    
    if (bodyPct >= 0.60) {
        if (isBullCandle) { buyScore += 10; buyReasons.push('Body bull'); }
        else { sellScore += 10; sellReasons.push('Body bear'); }
    }
    if (bodyPct >= 0.80) {
        if (isBullCandle) { buyScore += 10; buyReasons.push('Body bull strong'); }
        else { sellScore += 10; sellReasons.push('Body bear strong'); }
    }
    
    if (snr) {
        const tol = 0.003;
        if (snr.R1 && Math.abs(currentPrice - snr.R1) / currentPrice < tol) { sellScore += 15; sellReasons.push('Dekat R1'); }
        if (snr.R2 && Math.abs(currentPrice - snr.R2) / currentPrice < tol) { sellScore += 20; sellReasons.push('Dekat R2'); }
        if (snr.R3 && Math.abs(currentPrice - snr.R3) / currentPrice < tol) { sellScore += 20; sellReasons.push('Dekat R3'); }
        if (snr.S1 && Math.abs(currentPrice - snr.S1) / currentPrice < tol) { buyScore += 15; buyReasons.push('Dekat S1'); }
        if (snr.S2 && Math.abs(currentPrice - snr.S2) / currentPrice < tol) { buyScore += 20; buyReasons.push('Dekat S2'); }
        if (snr.S3 && Math.abs(currentPrice - snr.S3) / currentPrice < tol) { buyScore += 20; buyReasons.push('Dekat S3'); }
    }
    
    if (liquidity && liquidity.sweep) {
        if (liquidity.sweep.bias === 'SELL') { sellScore += 25; sellReasons.push('LIQUIDITY SWEEP'); }
        else if (liquidity.sweep.bias === 'BUY') { buyScore += 25; buyReasons.push('LIQUIDITY SWEEP'); }
    }
    
    let sig = 'WAIT', confidence = 0, reasons = [];
    const diff = Math.abs(buyScore - sellScore);
    const winner = buyScore > sellScore ? 'BUY' : sellScore > buyScore ? 'SELL' : 'WAIT';
    const winnerScore = Math.max(buyScore, sellScore);
    const maxScore = 140;
    
    if (!(diff < 10 && winnerScore >= SCORE_BOLEH)) {
        if (winner === 'BUY' && buyScore >= SCORE_BOLEH) {
            sig = 'BUY';
            confidence = Math.min(Math.round((buyScore / maxScore) * 100 * 1.3), 100);
            reasons = buyReasons;
        } else if (winner === 'SELL' && sellScore >= SCORE_BOLEH) {
            sig = 'SELL';
            confidence = Math.min(Math.round((sellScore / maxScore) * 100 * 1.3), 100);
            reasons = sellReasons;
        }
    }
    
    return { 
        signal: sig, 
        confidence, 
        score: winnerScore, 
        ema9, ema21, ema50, 
        buyScore, sellScore, 
        reasons 
    };
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
            tfResult = analyzeCandles(candles, symbol, null, null);
        } catch (e) {}
        if (tfResult) 
            results.push({ tf: item.tf, label: item.label, signal: tfResult.signal, confidence: tfResult.confidence });
        else 
            results.push({ tf: item.tf, label: item.label, signal: 'WAIT', confidence: 0 });
    }
    
    let buyCount = 0, sellCount = 0;
    for (let i = 0; i < results.length; i++) {
        if (results[i].signal === 'BUY') buyCount++;
        if (results[i].signal === 'SELL') sellCount++;
    }
    const maxCount = Math.max(buyCount, sellCount);
    const majoritySignal = buyCount > sellCount ? 'BUY' : sellCount > buyCount ? 'SELL' : 'WAIT';
    
    return { 
        timeframes: results, 
        buyCount, sellCount, 
        agreement: maxCount + '/4', 
        consensus: majoritySignal 
    };
}

// ===============================================
// FETCH DATA
// ===============================================
const tickCache = new Map();

function toEASymbol(symbol) {
    const base = symbol.replace('/', '');
    const suffixes = ['.vxx', '.vx', '', 'm', '.', 'c', 'pro', 'ecn', 'raw'];
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
            if (mid > 0) 
                return { bid, ask: ask || bid, mid, spread: ask ? ask - bid : 0, source: 'MT4' };
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
            
            const result = { 
                bid: bid || mid, 
                ask: ask || mid, 
                mid, 
                spread: parseFloat(d.spread || (ask - bid) || 0), 
                source: 'TWELVEDATA' 
            };
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
            const url = TWELVEDATA_URL + '/time_series?symbol=' + encodeURIComponent(tdSymbol) + 
                        '&interval=' + interval + '&outputsize=' + limit + '&apikey=' + getCurrentKey();
            const response = await axios.get(url, { timeout: 10000 });
            const d = response.data;
            
            if (d.status === 'error' || d.code) {
                if (d.code === 429) { switchKey(); continue; }
                throw new Error(d.message || 'API error');
            }
            
            if (!d.values || !Array.isArray(d.values)) return [];
            
            const result = d.values.slice().reverse().map(c => ({
                open: parseFloat(c.open || 0), 
                high: parseFloat(c.high || 0),
                low: parseFloat(c.low || 0), 
                close: parseFloat(c.close || 0)
            })).filter(c => c.close > 0);
            
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
    if (atrProfile) { 
        tp1Mult = atrProfile.tp1Mult; 
        tp2Mult = atrProfile.tp2Mult; 
        tp3Mult = atrProfile.tp3Mult; 
    }
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

function isSpreadOK(symbol, spread) {
    const limit = getSpreadLimit(symbol);
    return spread > 0 && spread <= limit;
}

// ===============================================
// FETCH NEWS
// ===============================================
async function fetchNews() {
    if (Date.now() - newsCache.fetchedAt < NEWS_CACHE_MS && newsCache.events.length > 0) 
        return newsCache.events;
    
    try {
        const response = await axios.get(BIQUOTE_URL + '/calendar', { timeout: 10000 })
            .catch(function() { return { data: { events: [] } }; });
        const d = response.data;
        let events = d.events || d.data || d.calendar || (Array.isArray(d) ? d : []);
        if (!Array.isArray(events)) events = [];
        
        const usdEvents = events
            .filter(function(e) {
                const cur = String(e.currency || e.country || '').toUpperCase();
                return cur === 'USD' || cur === 'US';
            })
            .slice(0, 30)
            .map(function(e) {
                return {
                    time: String(e.time || e.date || e.datetime || ''),
                    currency: String(e.currency || 'USD'),
                    impact: String(e.impact || 'medium').toLowerCase(),
                    event: String(e.event || e.title || e.name || ''),
                    actual: String(e.actual || '-'),
                    forecast: String(e.forecast || e.estimate || '-'),
                    previous: String(e.previous || e.prior || '-')
                };
            });
        
        newsCache.events = usdEvents;
        newsCache.fetchedAt = Date.now();
        console.log('📰 News fetched: ' + usdEvents.length);
        return usdEvents;
    } catch (e) { return []; }
}

async function checkNewsBlock() {
    try {
        const events = await fetchNews();
        const now = Date.now();
        for (let i = 0; i < events.length; i++) {
            const ev = events[i];
            if (ev.impact !== 'high') continue;
            const evTime = new Date(ev.time).getTime();
            if (isNaN(evTime)) continue;
            const diff = Math.abs(evTime - now);
            if (diff < NEWS_AVOID_MS) {
                const mins = Math.round((evTime - now) / 60000);
                return { 
                    blocked: true, 
                    reason: 'News ' + ev.event + ' (' + (mins > 0 ? 'in ' + mins + ' min' : Math.abs(mins) + ' min ago') + ')' 
                };
            }
        }
        return { blocked: false, reason: null };
    } catch (e) { return { blocked: false, reason: null }; }
}

// ===============================================
// 1. SIGNAL — Real-time
// ===============================================
app.get('/api/signal', async function(req, res) {
    const symbol = req.query.symbol || 'XAU/USD';
    const decimal = getDecimal(symbol);
    
    try {
        const candles = await getOHLC(symbol, '5min', 300);
        if (candles.length < 50) throw new Error('Data tak cukup');
        
        const closes = candles.map(c => c.close);
        const tick = await getTick(symbol);
        const harga = tick.mid || closes[closes.length - 1];
        const spreadOK = isSpreadOK(symbol, tick.spread);
        const snr = detectSNR(candles);
        const liquidity = detectLiquidity(candles);
        const analysis = analyzeCandles(candles, symbol, snr, liquidity);
        if (!analysis) throw new Error('Analysis fail');
        
        const newsCheck = await checkNewsBlock();
        const atr = calculateATR(candles, 14);
        const atrProfile = getATRProfile(candles);
        const mtf = await checkMultiTimeframe(symbol);
        
        const now = Date.now();
        const cooldownData = signalCooldown.get(symbol);
        const isCooldown = cooldownData && (now - cooldownData.time) < COOLDOWN_MS;
        const existingLock = signalLock.get(symbol);
        let signal = 'WAIT', isLocked = false, lockedEntry = null, lockUntil = 0;
        let skipReason = null;
        
        if (!spreadOK) {
            skipReason = 'Spread tinggi (' + tick.spread.toFixed(decimal) + ')';
        } else if (newsCheck.blocked) {
            skipReason = '📰 ' + newsCheck.reason;
        } else if (!isCooldown) {
            if (existingLock) {
                const lockAge = Date.now() - existingLock.lockedAt;
                if (lockAge < MAX_LOCK_MS) {
                    signal = existingLock.direction;
                    lockedEntry = existingLock.entry;
                    lockUntil = existingLock.lockedAt + MAX_LOCK_MS;
                    isLocked = true;
                } else signalLock.delete(symbol);
            } else if (analysis.signal !== 'WAIT' && analysis.confidence >= SCORE_BOLEH) {
                signal = analysis.signal;
                const lockData = { direction: signal, entry: harga, lockedAt: Date.now() };
                signalLock.set(symbol, lockData);
                signalCooldown.set(symbol, { time: Date.now(), direction: signal });
                lockedEntry = harga;
                lockUntil = lockData.lockedAt + MAX_LOCK_MS;
                isLocked = true;
                
                try {
                    const sltpTg = calculateSLTP(signal, harga, atr, symbol, atrProfile);
                    const emoji = analysis.confidence >= 90 ? '🚀' : analysis.confidence >= 80 ? '⚡' : '📊';
                    const srcEmoji = tick.source === 'MT4' ? '💼' : '📡';
                    let confirmList = '';
                    analysis.reasons.forEach(function(r) { confirmList += '✅ ' + r + '\n'; });
                    
                    const msgTg = emoji + ' <b>SIGNAL ' + signal + '</b> (' + analysis.confidence + '%)\n' +
                                   '━━━━━━━━━━━━━━━━\n' +
                                   '📊 ' + symbol + '\n' +
                                   '🎯 Entry: ' + harga.toFixed(decimal) + ' ' + srcEmoji + '\n\n' +
                                   '🛑 SL: ' + sltpTg.sl + '\n' +
                                   '✅ TP1: ' + sltpTg.tp1 + '\n' +
                                   '✅ TP2: ' + sltpTg.tp2 + '\n' +
                                   '✅ TP3: ' + sltpTg.tp3 + '\n\n' +
                                   '━━━━━━━━━━━━━━━━\n' +
                                   '📊 CONFIRMATIONS:\n' + confirmList + '\n' +
                                   '📊 ATR: ' + atrProfile.level + '\n' +
                                   '⏰ ' + getMarketSession() + '\n' +
                                   '📈 MTF: ' + mtf.agreement;
                    
                    await sendAndSave('signal', {
                        symbol: symbol, telegram_msg: msgTg,
                        signal: signal, confidence: analysis.confidence,
                        harga: parseFloat(harga.toFixed(decimal)),
                        entry: parseFloat(harga.toFixed(decimal)),
                        sl: parseFloat(sltpTg.sl),
                        tp1: parseFloat(sltpTg.tp1),
                        tp2: parseFloat(sltpTg.tp2),
                        tp3: parseFloat(sltpTg.tp3),
                        reasons: analysis.reasons,
                        mtf_agreement: mtf.agreement
                    });
                } catch (e) {}
            }
        }
        
        const displayPrice = lockedEntry !== null ? lockedEntry : harga;
        const sltp = (signal === 'BUY' || signal === 'SELL') ? 
            calculateSLTP(signal, displayPrice, atr, symbol, atrProfile) : null;
        
        res.json({
            symbol, harga: parseFloat(harga.toFixed(decimal)),
            harga_source: tick.source || 'TWELVEDATA',
            signal, action: signal, bias: analysis.signal, score: analysis.confidence,
            entry: parseFloat(displayPrice.toFixed(decimal)),
            harga_entry: parseFloat(displayPrice.toFixed(decimal)),
            sl: sltp ? parseFloat(sltp.sl) : null,
            tp1: sltp ? parseFloat(sltp.tp1) : null,
            tp2: sltp ? parseFloat(sltp.tp2) : null,
            tp3: sltp ? parseFloat(sltp.tp3) : null,
            lockUntil, locked: isLocked, skip_reason: skipReason,
            spread: parseFloat(tick.spread.toFixed(decimal)),
            spread_ok: spreadOK, spread_limit: getSpreadLimit(symbol),
            news_blocked: newsCheck.blocked, news_reason: newsCheck.reason,
            reasons: analysis.reasons,
            ema9: parseFloat(analysis.ema9.toFixed(decimal)),
            ema21: parseFloat(analysis.ema21.toFixed(decimal)),
            ema50: parseFloat(analysis.ema50.toFixed(decimal)),
            R1: snr.R1 ? parseFloat(snr.R1.toFixed(decimal)) : null,
            R2: snr.R2 ? parseFloat(snr.R2.toFixed(decimal)) : null,
            R3: snr.R3 ? parseFloat(snr.R3.toFixed(decimal)) : null,
            S1: snr.S1 ? parseFloat(snr.S1.toFixed(decimal)) : null,
            S2: snr.S2 ? parseFloat(snr.S2.toFixed(decimal)) : null,
            S3: snr.S3 ? parseFloat(snr.S3.toFixed(decimal)) : null,
            liquidity: liquidity,
            mtf: { timeframes: mtf.timeframes, agreement: mtf.agreement, consensus: mtf.consensus },
            session: getMarketSession(),
            atr: parseFloat(atr.toFixed(decimal)),
            atrLevel: atrProfile.level
        });
    } catch (error) {
        res.json({ 
            symbol, signal: 'WAIT', action: 'WAIT', score: 0, 
            harga: 0, entry: 0, error: error.message 
        });
    }
});

// ===============================================
// 2. MAPPING — Asia/London/NY
// ===============================================
async function generateSessionMapping(symbol, sessionName) {
    try {
        // CHECK — kalau mapping dah ada & masih valid, SKIP
        if (isMappingValid(sessionName)) {
            console.log('⏭️ ' + sessionName + ' mapping dah ada & valid, skip');
            return;
        }
        
        console.log('🗺️ Mapping: ' + sessionName);
        const decimal = getDecimal(symbol);
        const tick = await getTick(symbol);
        const harga = tick.mid;
        const candlesH4 = await getOHLC(symbol, '4h', 100);
        const candlesH1 = await getOHLC(symbol, '1h', 200);
        const candlesM5 = await getOHLC(symbol, '5min', 300);
        
        if (candlesH4.length < 50) return;
        
        const h4SNR = detectSNR(candlesH4);
        const h4Liq = detectLiquidity(candlesH4);
        const h4Analysis = analyzeCandles(candlesH4, symbol, h4SNR, h4Liq);
        const h1Analysis = analyzeCandles(candlesH1, symbol, null, null);
        const m5Analysis = analyzeCandles(candlesM5, symbol, null, null);
        const h4ATR = calculateATR(candlesH4, 14);
        const mtf = await checkMultiTimeframe(symbol);
        const sessionStatus = getSessionStatus(sessionName);
        
        const bias = h4Analysis ? h4Analysis.signal : 'WAIT';
        const confidence = h4Analysis ? h4Analysis.confidence : 0;
        const entryNum = harga;
        const slDist = h4ATR * 1.5;
        const tp1Dist = h4ATR * 3.0;
        const tp2Dist = h4ATR * 6.0;
        const tp3Dist = h4ATR * 10.0;
        
        let slNum, tp1Num, tp2Num, tp3Num;
        if (bias === 'BUY') {
            slNum = entryNum - slDist;
            tp1Num = entryNum + tp1Dist;
            tp2Num = entryNum + tp2Dist;
            tp3Num = entryNum + tp3Dist;
        } else if (bias === 'SELL') {
            slNum = entryNum + slDist;
            tp1Num = entryNum - tp1Dist;
            tp2Num = entryNum - tp2Dist;
            tp3Num = entryNum - tp3Dist;
        } else {
            slNum = 0; tp1Num = 0; tp2Num = 0; tp3Num = 0;
        }
        
        const nowMYT = new Date(Date.now() + 8 * 60 * 60 * 1000);
        const dateStr = nowMYT.toISOString().split('T')[0];
        const timeStr = nowMYT.toTimeString().substring(0, 5);
        const dayName = ['Ahad','Isnin','Selasa','Rabu','Khamis','Jumaat','Sabtu'][nowMYT.getUTCDay()];
        
        let liqText = '';
        if (h4Liq) {
            liqText = 'Yesterday H: ' + h4Liq.yesterdayHigh.toFixed(decimal) + ' / L: ' + h4Liq.yesterdayLow.toFixed(decimal) + '\n' +
                      'Asia H: ' + h4Liq.asiaHigh.toFixed(decimal) + ' / L: ' + h4Liq.asiaLow.toFixed(decimal);
        }
        
        const prompt = `Kau trader professional. Buat SESSION MAPPING untuk ${sessionName}.

DATA:
- Pair: ${symbol}
- Harga: ${harga.toFixed(decimal)}
- Bias: ${bias} (${confidence}%)
- MTF: ${mtf.agreement}

Key Levels:
R2: ${h4SNR.R2 ? h4SNR.R2.toFixed(decimal) : '-'}
R1: ${h4SNR.R1 ? h4SNR.R1.toFixed(decimal) : '-'}
S1: ${h4SNR.S1 ? h4SNR.S1.toFixed(decimal) : '-'}
S2: ${h4SNR.S2 ? h4SNR.S2.toFixed(decimal) : '-'}

ENTRY PLAN (SUDAH DIKIRA):
Entry: ${entryNum.toFixed(decimal)}
SL: ${slNum.toFixed(decimal)}
TP1: ${tp1Num.toFixed(decimal)}
TP2: ${tp2Num.toFixed(decimal)}

FORMAT (Bahasa Melayu, padat, 3-4 ayat):
- Kenapa bias ni
- Apa yang perlu tunggu
- Risiko apa`;

        let aiAnalysis = 'AI analysis unavailable';
        try {
            const result = await ai.models.generateContent({ model: GEMINI_MODEL, contents: prompt });
            aiAnalysis = result.text;
        } catch (e) { console.log('AI error:', e.message); }
        
        const sessionEmoji = sessionName === 'LONDON' ? '🇬🇧' : sessionName === 'NEW YORK' ? '🇺🇸' : '🇯🇵';
        const biasEmoji = bias === 'BUY' ? '📈' : bias === 'SELL' ? '📉' : '⏳';
        
        const msg = `${sessionEmoji} <b>MAPPING ${sessionName}</b>\n` +
                    `⏰ ${timeStr} MYT | 📅 ${dayName} ${dateStr}\n` +
                    `━━━━━━━━━━━━━━━━\n\n` +
                    `💰 <b>${symbol}: ${harga.toFixed(decimal)}</b> (${tick.source})\n` +
                    `📊 ${sessionStatus}\n\n` +
                    `${biasEmoji} <b>Bias: ${bias}</b> (${confidence}%)\n\n` +
                    `━━━━━━━━━━━━━━━━\n` +
                    `🎯 <b>PLAN ENTRY</b>\n\n` +
                    `📍 Entry: <b>${entryNum.toFixed(decimal)}</b>\n` +
                    `🛑 SL: <b>${slNum.toFixed(decimal)}</b>\n` +
                    `✅ TP1: <b>${tp1Num.toFixed(decimal)}</b>\n` +
                    `✅ TP2: <b>${tp2Num.toFixed(decimal)}</b>\n\n` +
                    `━━━━━━━━━━━━━━━━\n` +
                    `📊 <b>KEY LEVELS</b>\n` +
                    `• R1: ${h4SNR.R1 ? h4SNR.R1.toFixed(decimal) : '-'}\n` +
                    `• S1: ${h4SNR.S1 ? h4SNR.S1.toFixed(decimal) : '-'}\n\n` +
                    `━━━━━━━━━━━━━━━━\n` +
                    `🤖 ${aiAnalysis}\n\n` +
                    `📈 MTF: ${mtf.agreement}\n` +
                    `⚠️ <i>Set limit order!</i>`;
        
        await sendTelegram(msg);
        
        aiMappings[sessionName] = {
            session: sessionName, timeStr, dateStr, dayName,
            symbol, harga: parseFloat(harga.toFixed(decimal)),
            harga_source: tick.source, session_status: sessionStatus,
            ai_analysis: aiAnalysis, mtf_agreement: mtf.agreement, mtf_consensus: mtf.consensus,
            bias: bias, confidence: confidence,
            entry: parseFloat(entryNum.toFixed(decimal)),
            sl: parseFloat(slNum.toFixed(decimal)),
            tp1: parseFloat(tp1Num.toFixed(decimal)),
            tp2: parseFloat(tp2Num.toFixed(decimal)),
            tp3: parseFloat(tp3Num.toFixed(decimal)),
            levels: {
                r1: h4SNR.R1 ? parseFloat(h4SNR.R1.toFixed(decimal)) : null,
                r2: h4SNR.R2 ? parseFloat(h4SNR.R2.toFixed(decimal)) : null,
                s1: h4SNR.S1 ? parseFloat(h4SNR.S1.toFixed(decimal)) : null,
                s2: h4SNR.S2 ? parseFloat(h4SNR.S2.toFixed(decimal)) : null
            }
        };
        aiMappings.lastUpdate = Date.now();
        saveMappings();
        
        messageHistory.unshift({
            id: Date.now() + Math.floor(Math.random() * 1000),
            type: 'mapping',
            timestamp: Date.now(),
            data: {
                session: sessionName, symbol: symbol, telegram_msg: msg,
                harga: parseFloat(harga.toFixed(decimal)),
                bias: bias, confidence: confidence,
                entry: parseFloat(entryNum.toFixed(decimal)),
                sl: parseFloat(slNum.toFixed(decimal)),
                tp1: parseFloat(tp1Num.toFixed(decimal)),
                tp2: parseFloat(tp2Num.toFixed(decimal)),
                tp3: parseFloat(tp3Num.toFixed(decimal)),
                ai_analysis: aiAnalysis, mtf_agreement: mtf.agreement
            },
            telegram_sent: true
        });
        if (messageHistory.length > 100) messageHistory.pop();
        saveHistory();
        
        console.log('✅ ' + sessionName + ' mapping saved');
    } catch (e) { 
        console.log('❌ ' + sessionName + ' error:', e.message); 
    }
}

// ===============================================
// 3. ASIA BREAKOUT
// ===============================================
async function checkAsiaBreakout(symbol) {
    try {
        const decimal = getDecimal(symbol);
        const tick = await getTick(symbol);
        const harga = tick.mid;
        const candles = await getOHLC(symbol, '5min', 300);
        
        if (candles.length < 100) return;
        
        const asiaCandles = candles.slice(-96, -20);
        if (asiaCandles.length < 20) return;
        
        const asiaHigh = Math.max.apply(null, asiaCandles.map(c => c.high));
        const asiaLow = Math.min.apply(null, asiaCandles.map(c => c.low));
        
        const lastCandle = candles[candles.length - 1];
        const prevCandle = candles[candles.length - 2];
        
        let breakout = null;
        
        if (lastCandle.close > asiaHigh && prevCandle.close <= asiaHigh) {
            breakout = { type: 'ASIA_BREAK_HIGH', level: asiaHigh, bias: 'BUY' };
        } else if (lastCandle.close < asiaLow && prevCandle.close >= asiaLow) {
            breakout = { type: 'ASIA_BREAK_LOW', level: asiaLow, bias: 'SELL' };
        }
        
        if (!breakout) return;
        
        const breakoutKey = symbol + '_' + breakout.type + '_' + Math.floor(Date.now() / (2 * 60 * 60 * 1000));
        if (liquidityCooldown.has(breakoutKey)) return;
        liquidityCooldown.set(breakoutKey, Date.now());
        
        const atr = calculateATR(candles, 14);
        const range = asiaHigh - asiaLow;
        const mtf = await checkMultiTimeframe(symbol);
        
        const entry = harga;
        let sl, tp1, tp2;
        
        if (breakout.bias === 'BUY') {
            sl = asiaLow;
            tp1 = asiaHigh + range * 0.5;
            tp2 = asiaHigh + range * 1.0;
        } else {
            sl = asiaHigh;
            tp1 = asiaLow - range * 0.5;
            tp2 = asiaLow - range * 1.0;
        }
        
        const emoji = breakout.bias === 'BUY' ? '🔺' : '🔻';
        
        const msg = `${emoji} <b>ASIA BREAKOUT — ${symbol}</b>\n` +
                    `━━━━━━━━━━━━━━━━\n` +
                    `💰 Harga: <b>${harga.toFixed(decimal)}</b>\n` +
                    `📍 ${breakout.type.replace(/_/g, ' ')}: ${breakout.level.toFixed(decimal)}\n\n` +
                    `📊 Bias: <b>${breakout.bias}</b>\n` +
                    `📊 MTF: ${mtf.agreement}\n\n` +
                    `🎯 <b>ENTRY:</b> ${entry.toFixed(decimal)}\n` +
                    `🛑 <b>SL:</b> ${sl.toFixed(decimal)}\n` +
                    `✅ <b>TP1:</b> ${tp1.toFixed(decimal)}\n` +
                    `✅ <b>TP2:</b> ${tp2.toFixed(decimal)}\n\n` +
                    `📊 Asia Range: ${asiaLow.toFixed(decimal)} - ${asiaHigh.toFixed(decimal)}`;
        
        await sendAndSave('asia_breakout', {
            symbol: symbol, type: breakout.type,
            level: parseFloat(breakout.level.toFixed(decimal)),
            bias: breakout.bias,
            harga: parseFloat(harga.toFixed(decimal)),
            entry: parseFloat(entry.toFixed(decimal)),
            sl: parseFloat(sl.toFixed(decimal)),
            tp1: parseFloat(tp1.toFixed(decimal)),
            tp2: parseFloat(tp2.toFixed(decimal)),
            asiaHigh: parseFloat(asiaHigh.toFixed(decimal)),
            asiaLow: parseFloat(asiaLow.toFixed(decimal)),
            mtf_agreement: mtf.agreement,
            telegram_msg: msg
        });
    } catch (e) { 
        console.log('Asia breakout error:', e.message); 
    }
}

// ===============================================
// 4. DAILY OUTLOOK
// ===============================================
async function generateDailyOutlook(symbol) {
    try {
        console.log('📅 Daily Outlook');
        const decimal = getDecimal(symbol);
        const tick = await getTick(symbol);
        const harga = tick.mid;
        const candlesH4 = await getOHLC(symbol, '4h', 100);
        const h4Analysis = analyzeCandles(candlesH4, symbol, null, null);
        const h4SNR = detectSNR(candlesH4);
        const mtf = await checkMultiTimeframe(symbol);
        const news = await fetchNews();
        
        const nowMYT = new Date(Date.now() + 8 * 60 * 60 * 1000);
        const dateStr = nowMYT.toISOString().split('T')[0];
        const dayName = ['Ahad','Isnin','Selasa','Rabu','Khamis','Jumaat','Sabtu'][nowMYT.getUTCDay()];
        const highNews = news.filter(n => n.impact === 'high').slice(0, 3);
        const newsText = highNews.length > 0 
            ? highNews.map(n => '• ' + n.event).join('\n') 
            : '• Takde news high impact';
        
        const bias = h4Analysis ? h4Analysis.signal : 'WAIT';
        const confidence = h4Analysis ? h4Analysis.confidence : 0;
        
        const msg = `📅 <b>DAILY OUTLOOK — ${symbol}</b>\n` +
                    `📆 ${dayName} ${dateStr}\n` +
                    `⏰ 5:00 AM MYT\n` +
                    `━━━━━━━━━━━━━━━━\n\n` +
                    `💰 <b>Harga: ${harga.toFixed(decimal)}</b>\n` +
                    `📊 Bias: <b>${bias}</b> (${confidence}%)\n` +
                    `📊 MTF: ${mtf.agreement}\n\n` +
                    `📍 <b>Key Levels:</b>\n` +
                    `• R1: ${h4SNR.R1 ? h4SNR.R1.toFixed(decimal) : '-'}\n` +
                    `• S1: ${h4SNR.S1 ? h4SNR.S1.toFixed(decimal) : '-'}\n\n` +
                    `📰 <b>News Today:</b>\n${newsText}\n\n` +
                    `💡 Prepare untuk hari ni!`;
        
        await sendAndSave('daily_outlook', {
            symbol: symbol, telegram_msg: msg,
            bias: bias, confidence: confidence,
            harga: parseFloat(harga.toFixed(decimal)),
            date: dateStr, dayName: dayName,
            mtf_agreement: mtf.agreement
        });
    } catch (e) { 
        console.log('Daily outlook error:', e.message); 
    }
}

// ===============================================
// 5. PRE-MARKET
// ===============================================
async function generatePreMarket(symbol, sessionName) {
    try {
        console.log('⏰ Pre-Market: ' + sessionName);
        const decimal = getDecimal(symbol);
        const tick = await getTick(symbol);
        const harga = tick.mid;
        const candlesH4 = await getOHLC(symbol, '4h', 100);
        const h4Analysis = analyzeCandles(candlesH4, symbol, null, null);
        const h4SNR = detectSNR(candlesH4);
        const mtf = await checkMultiTimeframe(symbol);
        
        const sessionEmoji = sessionName === 'LONDON' ? '🇬🇧' : sessionName === 'NEW YORK' ? '🇺🇸' : '🇯🇵';
        const sessionTime = sessionName === 'LONDON' ? '3:00 PM' : sessionName === 'NEW YORK' ? '8:00 PM' : '7:00 AM';
        const bias = h4Analysis ? h4Analysis.signal : 'WAIT';
        
        const msg = `${sessionEmoji} <b>PRE-${sessionName} — 30 MIN</b>\n` +
                    `⏰ Starts: ${sessionTime} MYT\n` +
                    `━━━━━━━━━━━━━━━━\n\n` +
                    `💰 ${symbol}: <b>${harga.toFixed(decimal)}</b>\n` +
                    `📊 Bias: <b>${bias}</b>\n` +
                    `📊 MTF: ${mtf.agreement}\n\n` +
                    `📍 <b>Key Levels:</b>\n` +
                    `• R1: ${h4SNR.R1 ? h4SNR.R1.toFixed(decimal) : '-'}\n` +
                    `• S1: ${h4SNR.S1 ? h4SNR.S1.toFixed(decimal) : '-'}\n\n` +
                    `⚠️ 30 minit lagi — prepare!`;
        
        await sendAndSave('pre_market', {
            symbol: symbol, session: sessionName, telegram_msg: msg,
            harga: parseFloat(harga.toFixed(decimal)),
            bias: bias, confidence: h4Analysis ? h4Analysis.confidence : 0,
            mtf_agreement: mtf.agreement
        });
    } catch (e) { 
        console.log('Pre-market error:', e.message); 
    }
}

// ===============================================
// 6. LEVEL ALERT
// ===============================================
async function checkLevelAlert(symbol) {
    try {
        const decimal = getDecimal(symbol);
        const tick = await getTick(symbol);
        const harga = tick.mid;
        const candles = await getOHLC(symbol, '5min', 300);
        const snr = detectSNR(candles);
        const mtf = await checkMultiTimeframe(symbol);
        
        const levels = [
            { name: 'R3', price: snr.R3 }, { name: 'R2', price: snr.R2 }, { name: 'R1', price: snr.R1 },
            { name: 'S1', price: snr.S1 }, { name: 'S2', price: snr.S2 }, { name: 'S3', price: snr.S3 }
        ];
        const pipSize = getPipSize(symbol);
        
        for (let i = 0; i < levels.length; i++) {
            const level = levels[i];
            if (!level.price) continue;
            const distancePips = Math.abs(harga - level.price) / pipSize;
            
            if (distancePips < 10 && distancePips > 3) {
                const alertKey = symbol + '_' + level.name;
                const lastAlert = levelAlertCooldown.get(alertKey);
                if (lastAlert && Date.now() - lastAlert < 30 * 60 * 1000) continue;
                levelAlertCooldown.set(alertKey, Date.now());
                
                const msg = `🚨 <b>LEVEL ALERT — ${symbol}</b>\n` +
                            `━━━━━━━━━━━━━━━━\n` +
                            `💰 Harga: <b>${harga.toFixed(decimal)}</b>\n` +
                            `📍 Level: <b>${level.name}</b> @ ${level.price.toFixed(decimal)}\n` +
                            `📏 ${distancePips.toFixed(1)} pips away\n\n` +
                            `📊 MTF: ${mtf.agreement}\n` +
                            `💡 Watch candle reject!`;
                
                await sendAndSave('level_alert', {
                    symbol: symbol, level: level.name,
                    level_price: parseFloat(level.price.toFixed(decimal)),
                    current_price: parseFloat(harga.toFixed(decimal)),
                    distance_pips: parseFloat(distancePips.toFixed(1)),
                    mtf_agreement: mtf.agreement,
                    telegram_msg: msg
                });
            }
        }
    } catch (e) { 
        console.log('Level alert error:', e.message); 
    }
}

// ===============================================
// 7. NEWS ALERT
// ===============================================
async function checkNewsAlert() {
    try {
        const news = await fetchNews();
        const now = Date.now();
        
        for (let i = 0; i < news.length; i++) {
            const event = news[i];
            if (event.impact !== 'high') continue;
            const eventTime = new Date(event.time).getTime();
            if (isNaN(eventTime)) continue;
            const minutesUntil = (eventTime - now) / 60000;
            
            if (minutesUntil > 0 && minutesUntil <= 15) {
                const alertKey = 'news_' + event.event + '_' + eventTime;
                if (newsAlertCooldown.has(alertKey)) continue;
                newsAlertCooldown.set(alertKey, Date.now());
                
                const msg = `📰 <b>NEWS ALERT — 15 MIN</b>\n` +
                            `━━━━━━━━━━━━━━━━\n` +
                            `📊 <b>${event.event}</b>\n` +
                            `💱 ${event.currency}\n` +
                            `⏰ ${new Date(eventTime).toLocaleTimeString('ms-MY', { hour: '2-digit', minute: '2-digit' })}\n\n` +
                            `⚠️ Jangan entry 15 min before!`;
                
                await sendAndSave('news_alert', {
                    event: event.event, currency: event.currency,
                    time: event.time, minutes_until: Math.round(minutesUntil),
                    telegram_msg: msg
                });
            }
        }
    } catch (e) { 
        console.log('News alert error:', e.message); 
    }
}

// ===============================================
// 8. LIQUIDITY SWEEP ALERT
// ===============================================
async function checkLiquiditySweep(symbol) {
    try {
        const decimal = getDecimal(symbol);
        const tick = await getTick(symbol);
        const harga = tick.mid;
        const candles = await getOHLC(symbol, '5min', 300);
        
        if (!candles || candles.length < 100) return;
        
        const liquidity = detectLiquidity(candles);
        if (!liquidity || !liquidity.sweep) return;
        
        const sweepKey = symbol + '_' + liquidity.sweep.type + '_' + liquidity.sweep.source;
        const lastAlert = liquidityCooldown.get(sweepKey);
        if (lastAlert && Date.now() - lastAlert < 60 * 60 * 1000) return;
        liquidityCooldown.set(sweepKey, Date.now());
        
        const biasEmoji = liquidity.sweep.bias === 'BUY' ? '📈' : '📉';
        const sweepEmoji = liquidity.sweep.type === 'SWEEP_HIGH' ? '🔺' : '🔻';
        const sourceText = liquidity.sweep.source.replace(/_/g, ' ');
        
        const msg = `${sweepEmoji} <b>LIQUIDITY SWEEP — ${symbol}</b>\n` +
                    `━━━━━━━━━━━━━━━━\n` +
                    `💰 Harga: <b>${harga.toFixed(decimal)}</b>\n` +
                    `📍 Type: <b>${liquidity.sweep.type}</b>\n` +
                    `📊 Source: <b>${sourceText}</b>\n` +
                    `📍 Level: <b>${liquidity.sweep.level.toFixed(decimal)}</b>\n\n` +
                    `${biasEmoji} <b>Bias: ${liquidity.sweep.bias}</b>\n\n` +
                    `━━━━━━━━━━━━━━━━\n` +
                    `💡 <i>Smart money manipulation detected!</i>\n` +
                    `⚠️ <i>Tunggu candle reject sebelum entry.</i>`;
        
        await sendAndSave('liquidity_sweep', {
            symbol: symbol,
            type: liquidity.sweep.type,
            source: liquidity.sweep.source,
            level: parseFloat(liquidity.sweep.level.toFixed(decimal)),
            bias: liquidity.sweep.bias,
            harga: parseFloat(harga.toFixed(decimal)),
            telegram_msg: msg
        });
        
        console.log('💧 Liquidity sweep: ' + liquidity.sweep.type);
    } catch (e) { 
        console.log('Liquidity sweep error:', e.message); 
    }
}

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
        const closes = candles.map(c => c.close);
        const harga = tick.mid || closes[closes.length - 1];
        const snr = detectSNR(candles);
        const liquidity = detectLiquidity(candles);
        
        res.json({
            symbol, harga: parseFloat(harga.toFixed(decimal)),
            harga_source: tick.source, 
            bid: parseFloat(tick.bid.toFixed(decimal)),
            ask: parseFloat(tick.ask.toFixed(decimal)), 
            spread: parseFloat(tick.spread.toFixed(decimal)),
            spread_ok: isSpreadOK(symbol, tick.spread),
            R1: snr.R1 ? parseFloat(snr.R1.toFixed(decimal)) : null,
            R2: snr.R2 ? parseFloat(snr.R2.toFixed(decimal)) : null,
            R3: snr.R3 ? parseFloat(snr.R3.toFixed(decimal)) : null,
            S1: snr.S1 ? parseFloat(snr.S1.toFixed(decimal)) : null,
            S2: snr.S2 ? parseFloat(snr.S2.toFixed(decimal)) : null,
            S3: snr.S3 ? parseFloat(snr.S3.toFixed(decimal)) : null,
            POC: parseFloat(harga.toFixed(decimal)),
            liquidity: liquidity,
            session: getMarketSession()
        });
    } catch (error) { 
        res.status(500).json({ error: error.message }); 
    }
});

// ===============================================
// API: MESSAGES
// ===============================================
app.get('/api/messages', function(req, res) {
    const limit = parseInt(req.query.limit) || 50;
    const type = req.query.type;
    
    let filtered = messageHistory;
    
    if (type && type !== 'all') {
        const types = type.split(',');
        filtered = messageHistory.filter(function(m) {
            return types.indexOf(m.type) >= 0;
        });
    }
    
    const stats = {
        total: messageHistory.length,
        signal: messageHistory.filter(m => m.type === 'signal').length,
        mapping: messageHistory.filter(m => m.type === 'mapping').length,
        asia_breakout: messageHistory.filter(m => m.type === 'asia_breakout').length,
        daily_outlook: messageHistory.filter(m => m.type === 'daily_outlook').length,
        pre_market: messageHistory.filter(m => m.type === 'pre_market').length,
        level_alert: messageHistory.filter(m => m.type === 'level_alert').length,
        news_alert: messageHistory.filter(m => m.type === 'news_alert').length,
        liquidity_sweep: messageHistory.filter(m => m.type === 'liquidity_sweep').length
    };
    
    res.json({ 
        status: 'OK', 
        messages: filtered.slice(0, limit), 
        total: filtered.length,
        stats: stats
    });
});

// ===============================================
// API: NEWS
// ===============================================
app.get('/api/news', async function(req, res) {
    try {
        const events = await fetchNews();
        res.json({ status: 'success', events });
    } catch (e) { 
        res.json({ status: 'success', events: [] }); 
    }
});

// ===============================================
// API: HEALTH & TEST
// ===============================================
app.get('/health', function(req, res) {
    res.json({ 
        status: 'OK', 
        version: '3.0', 
        messages: messageHistory.length, 
        timestamp: new Date().toISOString() 
    });
});

app.get('/api/test-ea', function(req, res) {
    res.json({
        ea_online: eaStatus.online, 
        prices_count: Object.keys(eaStatus.prices || {}).length,
        telegram_set: !!TELEGRAM_BOT_TOKEN && !!TELEGRAM_CHAT_ID,
        gemini_set: !!GEMINI_API_KEY, 
        version: '3.0', 
        messages_count: messageHistory.length
    });
});

app.get('/api/test-telegram', async function(req, res) {
    try { 
        await sendTelegram('🧪 <b>Test Telegram</b>\n\nBPT v3.0 ✅'); 
        res.json({ status: 'OK' }); 
    } catch (e) { 
        res.json({ status: 'FAIL', error: e.message }); 
    }
});

app.get('/api/test-asia-breakout', async function(req, res) {
    try { 
        await checkAsiaBreakout('XAU/USD'); 
        res.json({ status: 'OK' }); 
    } catch (e) { 
        res.json({ status: 'FAIL', error: e.message }); 
    }
});

app.get('/api/test-liquidity-sweep', async function(req, res) {
    try { 
        await checkLiquiditySweep('XAU/USD'); 
        res.json({ status: 'OK', message: 'Check complete' }); 
    } catch (e) { 
        res.json({ status: 'FAIL', error: e.message }); 
    }
});

app.get('/api/test-daily-outlook', async function(req, res) {
    try { 
        await generateDailyOutlook('XAU/USD'); 
        res.json({ status: 'OK' }); 
    } catch (e) { 
        res.json({ status: 'FAIL', error: e.message }); 
    }
});

app.get('/api/test-level-alert', async function(req, res) {
    try { 
        await checkLevelAlert('XAU/USD'); 
        res.json({ status: 'OK' }); 
    } catch (e) { 
        res.json({ status: 'FAIL', error: e.message }); 
    }
});

app.get('/api/test-news-alert', async function(req, res) {
    try { 
        await checkNewsAlert(); 
        res.json({ status: 'OK' }); 
    } catch (e) { 
        res.json({ status: 'FAIL', error: e.message }); 
    }
});

app.get('/', function(req, res) { 
    res.sendFile(__dirname + '/index.html'); 
});

// ===============================================
// SCHEDULE
// ===============================================
let lastSchedule = { 
    dailyOutlook: '', preAsia: '', mappingAsia: '', 
    preLondon: '', mappingLondon: '', 
    preNY: '', mappingNY: '' 
};

setInterval(function() {
    const now = new Date();
    const utcHour = now.getUTCHours();
    const utcMinute = now.getUTCMinutes();
    const today = now.toISOString().split('T')[0];
    
    // Daily Outlook — 5AM MYT (21:00 UTC)
    if (utcHour === 21 && utcMinute < 5 && lastSchedule.dailyOutlook !== today) {
        lastSchedule.dailyOutlook = today;
        generateDailyOutlook('XAU/USD').catch(e => console.log(e.message));
    }
    
    // Pre-Asia — 6:30AM MYT (22:30 UTC)
    if (utcHour === 22 && utcMinute >= 30 && utcMinute < 35 && lastSchedule.preAsia !== today) {
        lastSchedule.preAsia = today;
        generatePreMarket('XAU/USD', 'ASIA').catch(e => console.log(e.message));
    }
    
    // Mapping Asia — 7AM MYT (23:00 UTC)
    if (utcHour === 23 && utcMinute < 5 && lastSchedule.mappingAsia !== today) {
        lastSchedule.mappingAsia = today;
        generateSessionMapping('XAU/USD', 'ASIA').catch(e => console.log(e.message));
    }
    
    // Pre-London — 2:30PM MYT (06:30 UTC)
    if (utcHour === 6 && utcMinute >= 30 && utcMinute < 35 && lastSchedule.preLondon !== today) {
        lastSchedule.preLondon = today;
        generatePreMarket('XAU/USD', 'LONDON').catch(e => console.log(e.message));
    }
    
    // Mapping London — 3PM MYT (07:00 UTC)
    if (utcHour === 7 && utcMinute < 5 && lastSchedule.mappingLondon !== today) {
        lastSchedule.mappingLondon = today;
        generateSessionMapping('XAU/USD', 'LONDON').catch(e => console.log(e.message));
    }
    
    // Pre-NY — 7:30PM MYT (11:30 UTC)
    if (utcHour === 11 && utcMinute >= 30 && utcMinute < 35 && lastSchedule.preNY !== today) {
        lastSchedule.preNY = today;
        generatePreMarket('XAU/USD', 'NEW YORK').catch(e => console.log(e.message));
    }
    
    // Mapping NY — 8PM MYT (12:00 UTC)
    if (utcHour === 12 && utcMinute < 5 && lastSchedule.mappingNY !== today) {
        lastSchedule.mappingNY = today;
        generateSessionMapping('XAU/USD', 'NEW YORK').catch(e => console.log(e.message));
    }
}, 60000);

// Level Alert — setiap 5 minit
setInterval(function() { 
    checkLevelAlert('XAU/USD').catch(e => console.log(e.message)); 
}, 5 * 60 * 1000);

// News Alert — setiap 5 minit
setInterval(function() { 
    checkNewsAlert().catch(e => console.log(e.message)); 
}, 5 * 60 * 1000);

// Liquidity Sweep — setiap 5 minit
setInterval(function() { 
    checkLiquiditySweep('XAU/USD').catch(e => console.log(e.message)); 
}, 5 * 60 * 1000);

// Asia Breakout — setiap 2 min (masa Asia session)
setInterval(function() {
    const session = getMarketSession();
    if (session === 'ASIA') {
        checkAsiaBreakout('XAU/USD').catch(e => console.log(e.message));
    }
}, 2 * 60 * 1000);

// Fetch News — setiap 30 minit
setInterval(function() { 
    fetchNews().catch(e => console.log(e.message)); 
}, 30 * 60 * 1000);

// ===============================================
// START SERVER
// ===============================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, function() {
    console.log('🚀 BPT v3.0 running on port ' + PORT);
    console.log('📊 8 notification types aktif');
    console.log('   ✅ signal, mapping, asia_breakout');
    console.log('   ✅ daily_outlook, pre_market');
    console.log('   ✅ level_alert, news_alert, liquidity_sweep');
    fetchNews().catch(e => console.log(e.message));
});