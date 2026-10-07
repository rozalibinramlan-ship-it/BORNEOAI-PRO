const express = require('express');
const cors = require('cors');
const axios = require('axios');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf.toString();
  }
}));
app.use(express.static(__dirname));

// FIX 400 - Jangan reject kalau EA hantar null byte
app.use((err, req, res, next) => {
  if (err instanceof SyntaxError) {
    try {
      let clean = (req.rawBody || "").replace(/\x00/g, "").trim();
      console.log("⚠️ JSON Parse Error, cleaning:", clean.substring(0,200));
      req.body = clean ? JSON.parse(clean) : {};
      return next();
    } catch(e) {
      console.log("Still fail, force OK");
      req.body = {};
      return next();
    }
  }
  next();
});

// ===============================================
// CONFIG
// ===============================================
const TWELVEDATA_URL = 'https://api.twelvedata.com';
const EA_API_KEY = process.env.EA_API_KEY || 'ea-secret-2024';
const ACCOUNT_BALANCE = parseFloat(process.env.ACCOUNT_BALANCE || '1000');
const RISK_PERCENT = parseFloat(process.env.RISK_PERCENT || '1');
const USE_FIXED_LOT = process.env.USE_FIXED_LOT === 'true';
const FIXED_LOT = parseFloat(process.env.FIXED_LOT || '0.01');
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
].filter(k => k.length > 0);
let currentKeyIndex = 0;
function getCurrentKey() { return TWELVEDATA_KEYS[currentKeyIndex] || TWELVEDATA_KEYS[0] || ''; }
function switchKey() { if (TWELVEDATA_KEYS.length > 1) currentKeyIndex = (currentKeyIndex + 1) % TWELVEDATA_KEYS.length; }

console.log(`✅ TwelveData: ${TWELVEDATA_KEYS.length} keys`);
console.log(`🔑 EA API Key: ${EA_API_KEY}`);

function toTwelveData(s) {
  const map = {'XAU/USD':'XAU/USD','XAG/USD':'XAG/USD','EUR/USD':'EUR/USD','GBP/USD':'GBP/USD','USD/JPY':'USD/JPY','AUD/USD':'AUD/USD','USD/CAD':'USD/CAD','USD/CHF':'USD/CHF'};
  return map[s] || s;
}
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
// ✅ FUNGSI BARU — SNR, FVG, POC
// ===============================================
function calcSNR(candles) {
    if (!candles || candles.length < 20) return { support: null, resistance: null };
    let highs = candles.map(c => c.high);
    let lows = candles.map(c => c.low);
    return {
        resistance: Math.max(...highs.slice(-20)),
        support: Math.min(...lows.slice(-20))
    };
}

function calcFVG(candles) {
    let fvgs = [];
    for (let i = 2; i < candles.length; i++) {
        let c1 = candles[i - 2], c3 = candles[i];
        if (c1.high < c3.low) fvgs.push({ type: "BULLISH", top: c3.low, bottom: c1.high });
        if (c1.low > c3.high) fvgs.push({ type: "BEARISH", top: c1.low, bottom: c3.high });
    }
    return fvgs.slice(-3);
}

function calcPOC(candles) {
    if (!candles) return null;
    let prices = candles.flatMap(c => [c.high, c.low, c.close]);
    return prices.sort((a, b) => a - b)[Math.floor(prices.length / 2)];
}

// ===============================================
// EA BRIDGE
// ===============================================
let eaStatus = { online: false, lastSeen: 0, balance: 0, equity: 0, accountNumber: '' };
let tradeQueue = [];
let tradeHistory = [];

app.post('/api/ea/heartbeat', (req, res) => {
    const body = req.body || {};
    console.log(`♥ Heartbeat: ${body.accountNumber || '?'} Bal:${body.balance || 0}`);
    eaStatus = {
        online: true,
        lastSeen: Date.now(),
        balance: parseFloat(body.balance || 0),
        equity: parseFloat(body.equity || 0),
        accountNumber: body.accountNumber || ''
    };
    res.json({ status: 'OK', timestamp: Date.now() });
});

app.get('/api/ea/status', (req, res) => {
    const isOnline = (Date.now() - eaStatus.lastSeen) < 30000;
    res.json({
        ...eaStatus,
        online: isOnline,
        secondsAgo: isOnline ? Math.round((Date.now() - eaStatus.lastSeen) / 1000) : null
    });
});

app.get('/api/ea/commands', (req, res) => {
    const pending = tradeQueue.filter(c => c.status === 'pending');
    if (pending.length > 0) {
        const cmd = pending[0];
        cmd.status = 'sent';
        console.log(`📨 Send ID:${cmd.id} ${cmd.action || cmd.type}`);
        res.json(cmd);
    } else {
        res.json({});
    }
});

app.post('/api/ea/result', (req, res) => {
    const body = req.body || {};
    const cmd = tradeQueue.find(c => c.id === body.id);
    if (cmd) {
        cmd.status = body.success ? 'executed' : 'failed';
        cmd.ticket = body.ticket;
        tradeHistory.push({ ...cmd });
        console.log(`📊 Result ID ${body.id}: ${body.success ? '✅' : '❌'}`);
    }
    tradeQueue = tradeQueue.filter(c => c.status === 'pending' || c.status === 'sent');
    res.json({ status: 'OK' });
});

app.post('/api/ea/execute', (req, res) => {
    const { symbol, action, lot, sl, tp } = req.body;
    if (!symbol || !action || !lot) return res.status(400).json({ error: 'Missing fields' });
    const cmd = {
        id: Date.now(),
        symbol, action,
        lot: parseFloat(lot),
        sl: parseFloat(sl || 0),
        tp: parseFloat(tp || 0),
        timestamp: Date.now(),
        status: 'pending'
    };
    tradeQueue.push(cmd);
    console.log(`📤 Queued ${action} ${lot} ${symbol}`);
    res.json({ status: 'OK', id: cmd.id });
});

app.post('/api/ea/close', (req, res) => {
    const cmd = {
        id: Date.now(),
        type: 'CLOSE',
        ticket: parseInt(req.body.ticket),
        timestamp: Date.now(),
        status: 'pending'
    };
    tradeQueue.push(cmd);
    res.json({ status: 'OK', id: cmd.id });
});

app.post('/api/ea/close-all', (req, res) => {
    const cmd = {
        id: Date.now(),
        type: 'CLOSE_ALL',
        timestamp: Date.now(),
        status: 'pending'
    };
    tradeQueue.push(cmd);
    res.json({ status: 'OK', id: cmd.id });
});

app.get('/api/ea/history', (req, res) => {
    res.json({ history: tradeHistory.slice(-50).reverse() });
});

// ===============================================
// SIGNAL & CACHE
// ===============================================
const tickCache = new Map();
async function getTick(symbol) {
    const cached = tickCache.get(symbol);
    if (cached && Date.now() - cached.time < 30000) return cached.data;
    let attempts = 0;
    while (attempts < TWELVEDATA_KEYS.length * 2) {
        attempts++;
        try {
            const res = await axios.get(`${TWELVEDATA_URL}/quote?symbol=${encodeURIComponent(toTwelveData(symbol))}&apikey=${getCurrentKey()}`, { timeout: 10000 });
            const d = res.data;
            if (d.code === 429) { switchKey(); continue; }
            const mid = parseFloat(d.close || d.price || 0) || (parseFloat(d.bid) + parseFloat(d.ask)) / 2;
            const result = { bid: parseFloat(d.bid || mid), ask: parseFloat(d.ask || mid), mid };
            tickCache.set(symbol, { data: result, time: Date.now() });
            return result;
        } catch (e) { if (attempts >= TWELVEDATA_KEYS.length * 2) throw e; }
    }
}

const ohlcCache = new Map();
async function getOHLC(symbol, interval = '5min', limit = 300) {
    const key = `${symbol}_${interval}_${limit}`;
    const cached = ohlcCache.get(key);
    if (cached && Date.now() - cached.time < 180000) return cached.data;
    let attempts = 0;
    while (attempts < TWELVEDATA_KEYS.length * 2) {
        attempts++;
        try {
            const res = await axios.get(`${TWELVEDATA_URL}/time_series?symbol=${encodeURIComponent(toTwelveData(symbol))}&interval=${interval}&outputsize=${limit}&apikey=${getCurrentKey()}`, { timeout: 10000 });
            const d = res.data;
            if (d.code === 429) { switchKey(); continue; }
            const result = d.values.slice().reverse().map(c => ({
                time: c.datetime,
                timestamp: Math.floor(new Date(c.datetime).getTime() / 1000),
                open: parseFloat(c.open),
                high: parseFloat(c.high),
                low: parseFloat(c.low),
                close: parseFloat(c.close)
            })).filter(c => c.close > 0);
            ohlcCache.set(key, { data: result, time: Date.now() });
            return result;
        } catch (e) { if (attempts >= TWELVEDATA_KEYS.length * 2) throw e; }
    }
    return [];
}

function analyzeCandles(candles) {
    if (!candles || candles.length < 50) return null;
    const closes = candles.map(c => c.close);
    const ema9 = calculateEMA(closes, 9), ema21 = calculateEMA(closes, 21), ema50 = calculateEMA(closes, 50);
    let buy = 0, sell = 0;
    if (ema9 > ema21 && ema21 > ema50) buy += 50;
    if (ema9 < ema21 && ema21 < ema50) sell += 50;
    if (Math.abs(ema9 - ema21) > 0.3) { if (ema9 > ema21) buy += 20; else sell += 20; }
    const sig = buy > sell ? 'BUY' : sell > buy ? 'SELL' : 'WAIT';
    return { signal: sig, confidence: Math.max(buy, sell), ema9, ema21, ema50 };
}

const signalLock = new Map();
const signalCooldown = new Map();

function calculateSLTP(dir, entry, atr, sym, prof) {
    const slD = atr * 1.5;
    const dec = getDecimal(sym);
    let m1 = 3, m2 = 6, m3 = 10;
    if (prof) { m1 = prof.tp1Mult; m2 = prof.tp2Mult; m3 = prof.tp3Mult; }
    if (dir === "BUY") return {
        sl: (entry - slD).toFixed(dec),
        tp1: (entry + atr * m1).toFixed(dec),
        tp2: (entry + atr * m2).toFixed(dec),
        tp3: (entry + atr * m3).toFixed(dec)
    };
    else return {
        sl: (entry + slD).toFixed(dec),
        tp1: (entry - atr * m1).toFixed(dec),
        tp2: (entry - atr * m2).toFixed(dec),
        tp3: (entry - atr * m3).toFixed(dec)
    };
}

// ===============================================
// ENDPOINT: /api/signal-simple
// ===============================================
app.get('/api/signal-simple', async (req, res) => {
    const symbol = req.query.symbol || 'XAU/USD';
    try {
        const candles = await getOHLC(symbol, '5min', 300);
        const harga = candles[candles.length - 1].close;
        const ema = analyzeCandles(candles);
        const atr = calculateATR(candles, 14);
        const prof = getATRProfile(candles);
        let signal = ema ? ema.signal : 'WAIT';
        const sltp = (signal === 'BUY' || signal === 'SELL') ? calculateSLTP(signal, harga, atr, symbol, prof) : null;
        res.json({
            symbol: symbol.replace('/', ''),
            action: signal,
            score: ema?.confidence || 0,
            entryZone: [harga - atr * 0.8, harga + atr * 0.8],
            sl: sltp ? parseFloat(sltp.sl) : null,
            tp1: sltp ? parseFloat(sltp.tp1) : null,
            tp2: sltp ? parseFloat(sltp.tp2) : null,
            tp3: sltp ? parseFloat(sltp.tp3) : null,
            harga,
            atrLevel: prof.level,
            session: getMarketSession()
        });
    } catch (e) {
        res.json({ symbol, action: 'WAIT', score: 0, error: e.message });
    }
});

// ===============================================
// ENDPOINT: /api/signal (alias untuk app)
// ===============================================
app.get('/api/signal', async (req, res) => {
    const symbol = req.query.symbol || 'XAU/USD';
    const decimal = getDecimal(symbol);
    try {
        const candles = await getOHLC(symbol, '5min', 300);
        const harga = candles[candles.length - 1].close;
        const ema = analyzeCandles(candles);
        const atr = calculateATR(candles, 14);
        const prof = getATRProfile(candles);

        let signal = ema ? ema.signal : 'WAIT';
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
            } else if (signal !== 'WAIT') {
                const lockData = { direction: signal, entry: harga, lockedAt: Date.now() };
                signalLock.set(symbol, lockData);
                signalCooldown.set(symbol, { time: Date.now(), direction: signal });
                lockedEntry = harga;
                lockUntil = lockData.lockedAt + MAX_LOCK_MS;
                isLocked = true;
            }
        }

        const displayPrice = lockedEntry !== null ? lockedEntry : harga;
        const sltp = (signal === 'BUY' || signal === 'SELL') ? calculateSLTP(signal, displayPrice, atr, symbol, prof) : null;

        res.json({
            symbol: symbol.replace('/', ''),
            action: signal,
            score: ema?.confidence || 0,
            harga: parseFloat(harga.toFixed(decimal)),
            atr: parseFloat(atr.toFixed(decimal)),
            atrLevel: prof.level,
            session: getMarketSession(),
            signal: signal,
            bias: signal,
            entry: parseFloat(displayPrice.toFixed(decimal)),
            harga_entry: parseFloat(displayPrice.toFixed(decimal)),
            entryZone: [
                parseFloat((displayPrice - atr * ENTRY_ZONE_MULTIPLIER).toFixed(decimal)),
                parseFloat((displayPrice + atr * ENTRY_ZONE_MULTIPLIER).toFixed(decimal))
            ],
            sl: sltp ? parseFloat(sltp.sl) : null,
            tp1: sltp ? parseFloat(sltp.tp1) : null,
            tp2: sltp ? parseFloat(sltp.tp2) : null,
            tp3: sltp ? parseFloat(sltp.tp3) : null,
            lockUntil: lockUntil,
            locked: isLocked,
            agreement: '4/4',
            ema9: parseFloat((ema?.ema9 || 0).toFixed(decimal)),
            ema21: parseFloat((ema?.ema21 || 0).toFixed(decimal)),
            ema50: parseFloat((ema?.ema50 || 0).toFixed(decimal)),
            timeframe: '5min'
        });
    } catch (e) {
        res.json({
            symbol, signal: 'WAIT', action: 'WAIT', score: 0,
            harga: 0, entry: 0, sl: null, tp1: null, tp2: null, tp3: null,
            ema9: 0, ema21: 0, ema50: 0, error: e.message
        });
    }
});

// ===============================================
// ENDPOINT: /api/market (dengan SNR, FVG, POC)
// ===============================================
app.get('/api/market', async (req, res) => {
    const symbol = req.query.symbol || 'XAU/USD';
    const decimal = getDecimal(symbol);
    try {
        const tick = await getTick(symbol);
        const candles = await getOHLC(symbol, '5min', 100);
        const closes = candles.map(c => c.close);
        const harga = tick.mid || closes[closes.length - 1];
        const ema = analyzeCandles(candles);

        // SNR, FVG, POC
        const snr = calcSNR(candles);
        const fvg = calcFVG(candles);
        const poc = calcPOC(candles);

        res.json({
            symbol: symbol,
            harga: parseFloat(harga.toFixed(decimal)),
            bid: parseFloat((tick.bid || harga).toFixed(decimal)),
            ask: parseFloat((tick.ask || harga).toFixed(decimal)),
            spread: parseFloat((tick.spread || 0).toFixed(decimal)),
            ema9: parseFloat((ema?.ema9 || 0).toFixed(decimal)),
            ema21: parseFloat((ema?.ema21 || 0).toFixed(decimal)),
            ema50: parseFloat((ema?.ema50 || 0).toFixed(decimal)),
            ema: {
                ema9: ema?.ema9,
                ema21: ema?.ema21,
                ema50: ema?.ema50,
                trend: ema?.ema9 > ema?.ema50 ? "BULLISH" : "BEARISH"
            },
            snr: snr,
            fvg: fvg,
            poc: poc,
            status: "OK",
            signal: ema?.signal === "BUY" ? "BUY 90%" : ema?.signal === "SELL" ? "SELL 90%" : "WAIT",
            session: getMarketSession(),
            time: new Date().toLocaleTimeString()
        });
    } catch (e) {
        console.log("Market error:", e.message);
        res.status(500).json({ status: "Error", error: e.message, snr: null, fvg: [], poc: null });
    }
});

// ===============================================
// TEST & HEALTH
// ===============================================
app.get('/health', (req, res) => res.json({ status: 'OK' }));

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
            'POST /api/ea/close-all',
            'GET  /api/signal-simple',
            'GET  /api/signal',
            'GET  /api/market'
        ]
    });
});

app.get('/', (req, res) => res.sendFile(__dirname + '/index.html'));

// ===============================================
// START
// ===============================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 BPT v1.10 FINAL running on ${PORT}`));