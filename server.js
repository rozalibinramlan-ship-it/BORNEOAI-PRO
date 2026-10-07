const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { GoogleGenAI } = require('@google/genai');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// ===============================================
// CONFIG
// ===============================================
const TWELVEDATA_URL = 'https://api.twelvedata.com';
const EA_API_KEY = process.env.EA_API_KEY || 'ea-secret-2024';
const ACCOUNT_BALANCE = parseFloat(process.env.ACCOUNT_BALANCE || '1000');
const RISK_PERCENT = parseFloat(process.env.RISK_PERCENT || '1');

const USE_FIXED_LOT = process.env.USE_FIXED_LOT === 'true';
const FIXED_LOT = parseFloat(process.env.FIXED_LOT || '0.01');

const CANDLE_BODY_MIN = 0.30;
const SCORE_CUN = 90;
const SCORE_BOLEH = 70;
const SCORE_CHOPPY_DIFF = 10;
const ENTRY_ZONE_MULTIPLIER = 0.8;
const COOLDOWN_MS = 5 * 60 * 1000;
const MAX_LOCK_MS = 15 * 60 * 1000;

const TOUCH_THRESHOLD = {
    'XAU/USD': 0.0008, 'XAG/USD': 0.0010,
    'EUR/USD': 0.0003, 'GBP/USD': 0.0003, 'USD/JPY': 0.0003,
    'DEFAULT': 0.0005
};

// ===============================================
// TWELVEDATA KEYS
// ===============================================
const TWELVEDATA_KEYS = [
    process.env.TWELVEDATA_API_KEY || '',
    process.env.TWELVEDATA_API_KEY_2 || '',
    process.env.TWELVEDATA_API_KEY_3 || ''
].filter(k => k.length > 0);

let currentKeyIndex = 0;
function getCurrentKey() { return TWELVEDATA_KEYS[currentKeyIndex] || TWELVEDATA_KEYS[0] || ''; }
function switchKey() {
    if (TWELVEDATA_KEYS.length > 1) {
        currentKeyIndex = (currentKeyIndex + 1) % TWELVEDATA_KEYS.length;
    }
}
console.log(`✅ TwelveData: ${TWELVEDATA_KEYS.length} keys`);
console.log(`🔑 EA API Key: ${EA_API_KEY}`);

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
    if (s.includes('JPY')) return 3;
    if (s.includes('XAU') || s.includes('XAG')) return 2;
    return 5;
}

function calculateEMA(closes, period) {
    if (closes.length === 0) return 0;
    let e = closes[0], k = 2 / (period + 1);
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
    if (atrAvg === 0 || atrNow === 0) return { atrNow: 0, ratio: 1, level: 'NORMAL', tp1Mult: 3.0, tp2Mult: 6.0, tp3Mult: 10.0 };
    const ratio = atrNow / atrAvg;
    let level, tp1Mult, tp2Mult, tp3Mult;
    if (ratio >= 1.5) { level = 'VOLATILE'; tp1Mult = 5.0; tp2Mult = 10.0; tp3Mult = 15.0; }
    else if (ratio >= 1.0) { level = 'NORMAL'; tp1Mult = 3.0; tp2Mult = 6.0; tp3Mult = 10.0; }
    else if (ratio >= 0.7) { level = 'SLOW'; tp1Mult = 2.0; tp2Mult = 4.0; tp3Mult = 6.0; }
    else { level = 'VERY_SLOW'; tp1Mult = 1.5; tp2Mult = 3.0; tp3Mult = 4.5; }
    return { atrNow, atrAvg, ratio, level, tp1Mult, tp2Mult, tp3Mult };
}

function getMarketSession() {
    const h = new Date().getUTCHours();
    if (h >= 7 && h < 16) return "LONDON";
    if (h >= 12 && h < 21) return "NEW YORK";
    if (h >= 0 && h < 7) return "ASIA";
    return "CLOSED";
}

// ===============================================
// ✅ EA BRIDGE — ENDPOINT YANG KAU MISSING!
// ===============================================

let eaStatus = {
    online: false, lastSeen: 0, balance: 0, equity: 0, margin: 0,
    freeMargin: 0, profit: 0, positions: [], prices: {},
    accountNumber: '', broker: '', leverage: 0, currency: 'USD'
};

let tradeQueue = [];
let tradeHistory = [];

// ===== 1. EA HEARTBEAT — EA hantar status =====
app.post('/api/ea/heartbeat', (req, res) => {
    if (req.headers['x-api-key'] !== EA_API_KEY) {
        console.log('❌ Heartbeat unauthorized');
        return res.status(401).json({ error: 'Unauthorized' });
    }

    const { balance, equity, margin, freeMargin, profit, positions, prices, accountNumber, broker, leverage, currency } = req.body;

    eaStatus = {
        online: true, lastSeen: Date.now(),
        balance: parseFloat(balance || 0), equity: parseFloat(equity || 0),
        margin: parseFloat(margin || 0), freeMargin: parseFloat(freeMargin || 0),
        profit: parseFloat(profit || 0),
        positions: positions || [], prices: prices || {},
        accountNumber: accountNumber || '', broker: broker || '',
        leverage: leverage || 0, currency: currency || 'USD'
    };

    console.log(`♥ Heartbeat: ${accountNumber} | Balance: ${balance}`);
    res.json({ status: 'OK', timestamp: Date.now() });
});

// ===== 2. EA STATUS — app baca =====
app.get('/api/ea/status', (req, res) => {
    const isOnline = (Date.now() - eaStatus.lastSeen) < 30000;
    res.json({
        ...eaStatus,
        online: isOnline,
        secondsAgo: isOnline ? Math.round((Date.now() - eaStatus.lastSeen) / 1000) : null
    });
});

// ===== 3. EA COMMANDS — EA ambil command =====
app.get('/api/ea/commands', (req, res) => {
    if (req.headers['x-api-key'] !== EA_API_KEY) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    const pending = tradeQueue.filter(c => c.status === 'pending');
    if (pending.length > 0) {
        const cmd = pending[0];
        cmd.status = 'sent';
        cmd.sentAt = Date.now();
        console.log(`📨 Command sent: ${cmd.action} ${cmd.lot} ${cmd.symbol}`);
        res.json({ command: cmd });
    } else {
        res.json({ command: null });
    }
});

// ===== 4. EA RESULT — EA lapor result =====
app.post('/api/ea/result', (req, res) => {
    if (req.headers['x-api-key'] !== EA_API_KEY) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    const { id, success, ticket, error } = req.body;
    const cmd = tradeQueue.find(c => c.id === id);
    if (cmd) {
        cmd.status = success ? 'executed' : 'failed';
        cmd.ticket = ticket;
        cmd.error = error || '';
        cmd.executedAt = Date.now();
        tradeHistory.push({ ...cmd });
        if (tradeHistory.length > 100) tradeHistory.shift();
        console.log(`📊 Result: ${success ? '✅' : '❌'} ID ${id}`);
    }
    res.json({ status: 'OK' });
});

// ===== 5. EA EXECUTE — app suruh trade =====
app.post('/api/ea/execute', (req, res) => {
    const { symbol, action, lot, sl, tp } = req.body;

    if (!symbol || !action || !lot) {
        return res.status(400).json({ error: 'Missing fields' });
    }

    const cmd = {
        id: Date.now() + Math.floor(Math.random() * 1000),
        symbol, action, lot: parseFloat(lot),
        sl: parseFloat(sl || 0), tp: parseFloat(tp || 0),
        timestamp: Date.now(), status: 'pending'
    };

    tradeQueue.push(cmd);
    console.log(`📤 Trade queued: ${action} ${lot} ${symbol}`);
    res.json({ status: 'OK', id: cmd.id });
});

// ===== 6. EA CLOSE =====
app.post('/api/ea/close', (req, res) => {
    const { ticket } = req.body;
    if (!ticket) return res.status(400).json({ error: 'Missing ticket' });

    const cmd = {
        id: Date.now() + Math.floor(Math.random() * 1000),
        type: 'CLOSE', ticket: parseInt(ticket),
        timestamp: Date.now(), status: 'pending'
    };
    tradeQueue.push(cmd);
    console.log(`📤 Close: Ticket ${ticket}`);
    res.json({ status: 'OK', id: cmd.id });
});

// ===== 7. EA CLOSE ALL =====
app.post('/api/ea/close-all', (req, res) => {
    const cmd = {
        id: Date.now() + Math.floor(Math.random() * 1000),
        type: 'CLOSE_ALL', timestamp: Date.now(), status: 'pending'
    };
    tradeQueue.push(cmd);
    console.log(`📤 Close ALL`);
    res.json({ status: 'OK', id: cmd.id });
});

// ===== 8. EA HISTORY =====
app.get('/api/ea/history', (req, res) => {
    res.json({ history: tradeHistory.slice(-50).reverse() });
});

// ===============================================
// ANALYZE CANDLES (SCORING)
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

    let buyScore = 0, sellScore = 0, reasons = [];

    if (ema9 > ema21 && ema21 > ema50) { buyScore += 50; reasons.push('EMA selari BUY'); }
    if (ema9 > ema21 && gap_9_21 > 0.30) buyScore += 20;
    if (ema9 > ema21 && gap_9_21 > 0.50) buyScore += 15;
    if (ema9 > ema21 && gap_9_21 > 0.80) buyScore += 15;

    if (ema9 < ema21 && ema21 < ema50) { sellScore += 50; reasons.push('EMA selari SELL'); }
    if (ema9 < ema21 && gap_9_21 > 0.30) sellScore += 20;
    if (ema9 < ema21 && gap_9_21 > 0.50) sellScore += 15;
    if (ema9 < ema21 && gap_9_21 > 0.80) sellScore += 15;

    if (gap_21_50 > 0.20) { if (ema21 > ema50) buyScore += 10; else sellScore += 10; }
    if (gap_21_50 > 0.40) { if (ema21 > ema50) buyScore += 10; else sellScore += 10; }

    if (bodyPct >= 0.60) { if (isBullCandle) buyScore += 10; else sellScore += 10; }
    if (bodyPct >= 0.80) { if (isBullCandle) buyScore += 10; else sellScore += 10; }

    let sig = 'WAIT', confidence = 0, label = 'WAIT';
    const diff = Math.abs(buyScore - sellScore);
    const winner = buyScore > sellScore ? 'BUY' : sellScore > buyScore ? 'SELL' : 'WAIT';
    const winnerScore = Math.max(buyScore, sellScore);

    if (diff < SCORE_CHOPPY_DIFF && winnerScore >= SCORE_BOLEH) {
        sig = 'WAIT'; label = `CHOPPY (${buyScore}/${sellScore})`;
    } else if (winner === 'BUY' && buyScore >= SCORE_CUN) {
        sig = 'BUY'; confidence = Math.min(buyScore, 100); label = `BUY ${confidence}%`;
    } else if (winner === 'BUY' && buyScore >= SCORE_BOLEH) {
        sig = 'BUY'; confidence = Math.min(buyScore, 100); label = `BUY ${confidence}%`;
    } else if (winner === 'SELL' && sellScore >= SCORE_CUN) {
        sig = 'SELL'; confidence = Math.min(sellScore, 100); label = `SELL ${confidence}%`;
    } else if (winner === 'SELL' && sellScore >= SCORE_BOLEH) {
        sig = 'SELL'; confidence = Math.min(sellScore, 100); label = `SELL ${confidence}%`;
    }

    return { signal: sig, confidence, label, ema9, ema21, ema50, gap_9_21, gap_21_50, bodyPct, buyScore, sellScore, winner, diff, reasons };
}

// ===============================================
// CACHE & FETCH
// ===============================================
const tickCache = new Map();
async function getTick(symbol) {
    const cached = tickCache.get(symbol);
    if (cached && Date.now() - cached.time < 30000) return cached.data;

    const tdSymbol = toTwelveData(symbol);
    let attempts = 0;
    while (attempts < TWELVEDATA_KEYS.length * 2) {
        attempts++;
        try {
            const res = await axios.get(`${TWELVEDATA_URL}/quote?symbol=${encodeURIComponent(tdSymbol)}&apikey=${getCurrentKey()}`, { timeout: 10000 });
            const d = res.data;
            if (d.status === 'error' || d.code) {
                if (d.code === 429) { switchKey(); continue; }
                throw new Error(d.message);
            }
            const bid = parseFloat(d.bid || 0), ask = parseFloat(d.ask || 0);
            const price = parseFloat(d.close || d.price || 0);
            const mid = price || (bid + ask) / 2 || 0;
            if (mid === 0) throw new Error('Harga 0');
            const result = { bid: bid || mid, ask: ask || mid, mid, spread: parseFloat(d.spread || (ask - bid) || 0) };
            tickCache.set(symbol, { data: result, time: Date.now() });
            return result;
        } catch (e) {
            if (e.message && e.message.includes('429')) { switchKey(); continue; }
            if (attempts >= TWELVEDATA_KEYS.length * 2) throw e;
        }
    }
}

const ohlcCache = new Map();
async function getOHLC(symbol, interval = '5min', limit = 300) {
    const cacheKey = `${symbol}_${interval}_${limit}`;
    const cached = ohlcCache.get(cacheKey);
    if (cached && Date.now() - cached.time < 180000) return cached.data;

    const tdSymbol = toTwelveData(symbol);
    let attempts = 0;
    while (attempts < TWELVEDATA_KEYS.length * 2) {
        attempts++;
        try {
            const res = await axios.get(`${TWELVEDATA_URL}/time_series?symbol=${encodeURIComponent(tdSymbol)}&interval=${interval}&outputsize=${limit}&apikey=${getCurrentKey()}`, { timeout: 10000 });
            const d = res.data;
            if (d.status === 'error' || d.code) {
                if (d.code === 429) { switchKey(); continue; }
                throw new Error(d.message);
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
            if (attempts >= TWELVEDATA_KEYS.length * 2) throw e;
        }
    }
    return [];
}

// ===============================================
// SIGNAL LOCK
// ===============================================
const signalLock = new Map();
const signalCooldown = new Map();

// ===============================================
// SL/TP + LOT
// ===============================================
function calculateSLTP(direction, entry, atr, symbol, atrProfile = null) {
    const slDist = atr * 1.5;
    let tp1Mult = 3.0, tp2Mult = 6.0, tp3Mult = 10.0;
    if (atrProfile) { tp1Mult = atrProfile.tp1Mult; tp2Mult = atrProfile.tp2Mult; tp3Mult = atrProfile.tp3Mult; }
    const tp1Dist = atr * tp1Mult, tp2Dist = atr * tp2Mult, tp3Dist = atr * tp3Mult;
    const dec = getDecimal(symbol);

    if (direction === "BUY") {
        return {
            sl: (entry - slDist).toFixed(dec), tp1: (entry + tp1Dist).toFixed(dec),
            tp2: (entry + tp2Dist).toFixed(dec), tp3: (entry + tp3Dist).toFixed(dec),
            tp1Mult, tp2Mult, tp3Mult,
            rr_tp1: (tp1Dist / slDist).toFixed(2), rr_tp2: (tp2Dist / slDist).toFixed(2), rr_tp3: (tp3Dist / slDist).toFixed(2)
        };
    } else {
        return {
            sl: (entry + slDist).toFixed(dec), tp1: (entry - tp1Dist).toFixed(dec),
            tp2: (entry - tp2Dist).toFixed(dec), tp3: (entry - tp3Dist).toFixed(dec),
            tp1Mult, tp2Mult, tp3Mult,
            rr_tp1: (tp1Dist / slDist).toFixed(2), rr_tp2: (tp2Dist / slDist).toFixed(2), rr_tp3: (tp3Dist / slDist).toFixed(2)
        };
    }
}

function calculateAutoLot(symbol, entry, sl, balance, riskPct) {
    const riskAmount = balance * (riskPct / 100);
    const slDist = Math.abs(entry - sl);
    if (slDist === 0) return 0.01;
    let valPerPt = 100;
    if (symbol.includes('XAG')) valPerPt = 5000;
    else if (symbol.includes('JPY')) valPerPt = 1000;
    else if (!symbol.includes('XAU')) valPerPt = 100000;
    let lot = riskAmount / (slDist * valPerPt);
    lot = Math.round(lot * 100) / 100;
    return Math.max(0.01, Math.min(10, lot));
}

// ===============================================
// SIGNAL SIMPLE — untuk frontend
// ===============================================
app.get('/api/signal-simple', async (req, res) => {
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
        const ema9 = emaAnalysis ? emaAnalysis.ema9 : 0;
        const ema21 = emaAnalysis ? emaAnalysis.ema21 : 0;
        const ema50 = emaAnalysis ? emaAnalysis.ema50 : 0;

        const atr = calculateATR(candles, 14);
        const atrProfile = getATRProfile(candles);

        let signal = 'WAIT';
        let isLocked = false;
        let lockedEntry = null;
        let lockUntil = 0;

        const now = Date.now();
        const cooldownData = signalCooldown.get(symbol);
        const isCooldown = cooldownData && (now - cooldownData.time) < COOLDOWN_MS;
        const existingLock = signalLock.get(symbol);

        if (!isCooldown) {
            if (existingLock) {
                const lockAge = Date.now() - existingLock.lockedAt;
                if (lockAge < MAX_LOCK_MS) {
                    signal = existingLock.direction;
                    lockedEntry = existingLock.entry;
                    lockUntil = existingLock.lockedAt + MAX_LOCK_MS;
                    isLocked = true;
                } else {
                    signalLock.delete(symbol);
                }
            } else if (emaSignal !== 'WAIT') {
                signal = emaSignal;
                const lockData = { direction: signal, entry: harga, lockedAt: Date.now() };
                signalLock.set(symbol, lockData);
                signalCooldown.set(symbol, { time: Date.now(), direction: signal });
                lockedEntry = harga;
                lockUntil = lockData.lockedAt + MAX_LOCK_MS;
                isLocked = true;
            }
        }

        const displayPrice = lockedEntry !== null ? lockedEntry : harga;
        const sltp = (signal === 'BUY' || signal === 'SELL') ? calculateSLTP(signal, displayPrice, atr, symbol, atrProfile) : null;
        const zoneMult = ENTRY_ZONE_MULTIPLIER;

        res.json({
            symbol: symbol.replace('/', ''),
            action: signal,
            score: emaConfidence,
            entryZone: [
                parseFloat((displayPrice - atr * zoneMult).toFixed(decimal)),
                parseFloat((displayPrice + atr * zoneMult).toFixed(decimal))
            ],
            sl: sltp ? parseFloat(sltp.sl) : null,
            tp1: sltp ? parseFloat(sltp.tp1) : null,
            tp2: sltp ? parseFloat(sltp.tp2) : null,
            tp3: sltp ? parseFloat(sltp.tp3) : null,
            lockUntil: lockUntil,
            agreement: '4/4',
            ema9: parseFloat(ema9.toFixed(decimal)),
            ema21: parseFloat(ema21.toFixed(decimal)),
            harga: parseFloat(harga.toFixed(decimal)),
            ema50: parseFloat(ema50.toFixed(decimal)),
            atr: parseFloat(atr.toFixed(decimal)),
            atrLevel: atrProfile.level,
            locked: isLocked,
            session: getMarketSession()
        });
    } catch (error) {
        console.error("/api/signal-simple ERROR:", error.message);
        res.json({
            symbol: symbol.replace('/', ''), action: 'WAIT', score: 0,
            entryZone: [0, 0], sl: null, tp1: null, tp2: null, tp3: null,
            lockUntil: 0, agreement: '0/4', ema9: 0, ema21: 0, error: error.message
        });
    }
});

// ===============================================
// TEST ENDPOINTS
// ===============================================
app.get('/health', (req, res) => res.json({ status: 'OK', timestamp: new Date().toISOString() }));

app.get('/api/test-ea', (req, res) => {
    res.json({
        ea_api_key_set: !!EA_API_KEY,
        ea_api_key_length: EA_API_KEY.length,
        ea_online: eaStatus.online,
        ea_last_seen: eaStatus.lastSeen,
        queue_length: tradeQueue.length,
        endpoints: [
            'POST /api/ea/heartbeat',
            'GET  /api/ea/status',
            'GET  /api/ea/commands',
            'POST /api/ea/result',
            'POST /api/ea/execute',
            'POST /api/ea/close',
            'POST /api/ea/close-all'
        ]
    });
});

app.get('/', (req, res) => res.sendFile(__dirname + '/index.html'));

// ===============================================
// START
// ===============================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 BPT Server running on port ${PORT}`);
    console.log(`🔑 EA API Key: ${EA_API_KEY}`);
    console.log(`📡 EA Bridge endpoints ready`);
});