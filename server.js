// ===============================================
// BPT — Borneo Pro Trade
// Server v1.13 — Single Middleware + Full EA Bridge
// ===============================================

const express = require('express');
const cors = require('cors');
const axios = require('axios');
require('dotenv').config();

const app = express();
app.use(cors());

// ===============================================
// ✅ SINGLE MIDDLEWARE — tidak double baca
// Heartbeat → text parser + clean
// Lain → JSON biasa
// ===============================================
app.use((req, res, next) => {
    // EA heartbeat saja — baca sebagai text
    if (req.path === '/api/ea/heartbeat' && req.method === 'POST') {
        express.text({ type: '*/*', limit: '1mb' })(req, res, (err) => {
            if (err) {
                req.body = {};
                return next();
            }
            try {
                let raw = (req.body || '').toString();
                let clean = raw.replace(/\x00/g, '').trim();
                
                // Ambil {...} sahaja
                const s = clean.indexOf('{'), e = clean.lastIndexOf('}');
                if (s !== -1 && e !== -1) clean = clean.substring(s, e + 1);
                
                // Buang control char
                clean = clean.replace(/[\u0000-\u001F\u007F]+/g, ' ').replace(/\s+/g, ' ');
                
                req.body = clean ? JSON.parse(clean) : {};
                
                if (req.body.accountNumber) {
                    console.log(`♥ Heartbeat: ${req.body.accountNumber} Bal:${req.body.balance}`);
                }
            } catch (ex) {
                console.log(`⚠️ Heartbeat raw fail: ${String(req.body).substring(0, 120)}`);
                req.body = {};
            }
            next();
        });
    } else {
        // Endpoint lain — JSON biasa
        express.json({ limit: '1mb' })(req, res, next);
    }
});

app.use(express.static(__dirname));

// ===============================================
// CONFIG
// ===============================================
const TWELVEDATA_URL = 'https://api.twelvedata.com';
const EA_API_KEY = process.env.EA_API_KEY || 'ea-secret-2024';

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
    if (!closes.length) return 0;
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
    const atrNow = calculateATR(candles, 14), atrAvg = calculateATR(candles, 50);
    if (!atrAvg) return { level: 'NORMAL', tp1Mult: 3, tp2Mult: 6, tp3Mult: 10 };
    const ratio = atrNow / atrAvg;
    if (ratio >= 1.5) return { level: 'VOLATILE', tp1Mult: 5, tp2Mult: 10, tp3Mult: 15 };
    if (ratio >= 1.0) return { level: 'NORMAL', tp1Mult: 3, tp2Mult: 6, tp3Mult: 10 };
    if (ratio >= 0.7) return { level: 'SLOW', tp1Mult: 2, tp2Mult: 4, tp3Mult: 6 };
    return { level: 'VERY_SLOW', tp1Mult: 1.5, tp2Mult: 3, tp3Mult: 4.5 };
}

function getMarketSession() {
    const h = new Date().getUTCHours();
    if (h >= 7 && h < 16) return "LONDON";
    if (h >= 12 && h < 21) return "NEW YORK";
    if (h >= 0 && h < 7) return "ASIA";
    return "CLOSED";
}

function calcSNR(c) {
    if (!c || c.length < 20) return { support: null, resistance: null };
    const recent = c.slice(-20);
    return {
        resistance: Math.max(...recent.map(x => x.high)),
        support: Math.min(...recent.map(x => x.low))
    };
}

function calcFVG(c) {
    let f = [];
    for (let i = 2; i < c.length; i++) {
        if (c[i - 2].high < c[i].low) f.push({ type: "BULLISH", top: c[i].low, bottom: c[i - 2].high });
        if (c[i - 2].low > c[i].high) f.push({ type: "BEARISH", top: c[i - 2].low, bottom: c[i].high });
    }
    return f.slice(-3);
}

function calcPOC(c) {
    if (!c || c.length < 20) return null;
    const prices = c.flatMap(x => [x.high, x.low, x.close]).sort((a, b) => a - b);
    return prices[Math.floor(prices.length / 2)];
}

// ===============================================
// ✅ EA BRIDGE
// ===============================================
let eaStatus = {
    online: false, lastSeen: 0, balance: 0, equity: 0,
    accountNumber: '', broker: '', positions: [], prices: {}
};
let tradeQueue = [];
let tradeHistory = [];

// ===== EA HEARTBEAT =====
app.post('/api/ea/heartbeat', (req, res) => {
    // Heartbeat tak perlu API key check (untuk elak masalah EA)
    const b = req.body || {};
    
    eaStatus = {
        online: true,
        lastSeen: Date.now(),
        balance: parseFloat(b.balance || 0),
        equity: parseFloat(b.equity || 0),
        margin: parseFloat(b.margin || 0),
        freeMargin: parseFloat(b.freeMargin || 0),
        profit: parseFloat(b.profit || 0),
        accountNumber: b.accountNumber || '',
        broker: b.broker || '',
        leverage: b.leverage || 0,
        currency: b.currency || 'USD',
        positions: b.positions || [],
        prices: b.prices || {}
    };
    
    res.json({ status: 'OK', timestamp: Date.now() });
});

// ===== EA STATUS =====
app.get('/api/ea/status', (req, res) => {
    const on = (Date.now() - eaStatus.lastSeen) < 30000;
    res.json({
        ...eaStatus,
        online: on,
        secondsAgo: on ? Math.round((Date.now() - eaStatus.lastSeen) / 1000) : null
    });
});

// ===== EA COMMANDS =====
app.get('/api/ea/commands', (req, res) => {
    const p = tradeQueue.filter(c => c.status === 'pending');
    if (p.length) {
        p[0].status = 'sent';
        p[0].sentAt = Date.now();
        console.log(`📨 Command sent: ${p[0].action} ${p[0].lot} ${p[0].symbol}`);
        res.json({ command: p[0] });
    } else {
        res.json({ command: null });
    }
});

// ===== EA RESULT =====
app.post('/api/ea/result', (req, res) => {
    const b = req.body || {};
    const cmd = tradeQueue.find(c => c.id === b.id);
    if (cmd) {
        cmd.status = b.success ? 'executed' : 'failed';
        cmd.ticket = b.ticket;
        cmd.error = b.error || '';
        cmd.executedAt = Date.now();
        tradeHistory.push({ ...cmd });
        if (tradeHistory.length > 100) tradeHistory.shift();
        console.log(`📊 Result: ${b.success ? '✅' : '❌'} ID ${b.id}`);
    }
    res.json({ status: 'OK' });
});

// ===== EA EXECUTE =====
app.post('/api/ea/execute', (req, res) => {
    const { symbol, action, lot, sl, tp } = req.body || {};
    if (!symbol || !action || !lot) {
        return res.status(400).json({ error: 'Missing fields' });
    }
    const cmd = {
        id: Date.now() + Math.floor(Math.random() * 1000),
        symbol, action,
        lot: parseFloat(lot),
        sl: parseFloat(sl || 0),
        tp: parseFloat(tp || 0),
        status: 'pending',
        createdAt: Date.now()
    };
    tradeQueue.push(cmd);
    console.log(`📤 Queue: ${action} ${lot} ${symbol}`);
    res.json({ status: 'OK', id: cmd.id });
});

// ===== EA CLOSE =====
app.post('/api/ea/close', (req, res) => {
    const { ticket } = req.body || {};
    if (!ticket) return res.status(400).json({ error: 'Missing ticket' });
    const cmd = {
        id: Date.now() + Math.floor(Math.random() * 1000),
        type: 'CLOSE', ticket: parseInt(ticket), status: 'pending'
    };
    tradeQueue.push(cmd);
    res.json({ status: 'OK', id: cmd.id });
});

// ===== EA CLOSE ALL =====
app.post('/api/ea/close-all', (req, res) => {
    const cmd = {
        id: Date.now() + Math.floor(Math.random() * 1000),
        type: 'CLOSE_ALL', status: 'pending'
    };
    tradeQueue.push(cmd);
    res.json({ status: 'OK', id: cmd.id });
});

// ===== EA HISTORY =====
app.get('/api/ea/history', (req, res) => {
    res.json({ history: tradeHistory.slice(-50).reverse() });
});

// ===============================================
// CACHE & FETCH
// ===============================================
const tickCache = new Map(), ohlcCache = new Map();

async function getTick(symbol) {
    const ca = tickCache.get(symbol);
    if (ca && Date.now() - ca.time < 30000) return ca.data;
    try {
        const r = await axios.get(
            `${TWELVEDATA_URL}/quote?symbol=${encodeURIComponent(toTwelveData(symbol))}&apikey=${getCurrentKey()}`,
            { timeout: 8000 }
        );
        const d = r.data;
        const mid = parseFloat(d.close || d.price || 0) || (parseFloat(d.bid) + parseFloat(d.ask)) / 2;
        const result = {
            bid: parseFloat(d.bid || mid),
            ask: parseFloat(d.ask || mid),
            mid,
            spread: parseFloat(d.spread || 0)
        };
        tickCache.set(symbol, { data: result, time: Date.now() });
        return result;
    } catch (e) {
        return { bid: 0, ask: 0, mid: 0, spread: 0 };
    }
}

async function getOHLC(symbol, interval = '5min', limit = 100) {
    const key = `${symbol}_${interval}_${limit}`;
    const ca = ohlcCache.get(key);
    if (ca && Date.now() - ca.time < 60000) return ca.data;
    try {
        const r = await axios.get(
            `${TWELVEDATA_URL}/time_series?symbol=${encodeURIComponent(toTwelveData(symbol))}&interval=${interval}&outputsize=${limit}&apikey=${getCurrentKey()}`,
            { timeout: 8000 }
        );
        const vals = r.data.values;
        if (!vals) throw new Error("no values");
        const result = vals.slice().reverse().map(c => ({
            open: parseFloat(c.open),
            high: parseFloat(c.high),
            low: parseFloat(c.low),
            close: parseFloat(c.close)
        }));
        ohlcCache.set(key, { data: result, time: Date.now() });
        return result;
    } catch (e) {
        return [];
    }
}

function analyzeCandles(candles) {
    if (!candles || candles.length < 50) return null;
    const closes = candles.map(c => c.close);
    const ema9 = calculateEMA(closes, 9);
    const ema21 = calculateEMA(closes, 21);
    const ema50 = calculateEMA(closes, 50);
    
    let buy = 0, sell = 0;
    if (ema9 > ema21 && ema21 > ema50) buy += 50;
    if (ema9 < ema21 && ema21 < ema50) sell += 50;
    
    return {
        signal: buy > sell ? 'BUY' : sell > buy ? 'SELL' : 'WAIT',
        confidence: Math.max(buy, sell),
        ema9, ema21, ema50
    };
}

// ===============================================
// ✅ ENDPOINT MARKET — untuk app kau
// ===============================================
app.get('/api/market', async (req, res) => {
    const symbol = req.query.symbol || 'XAU/USD';
    const decimal = getDecimal(symbol);
    
    try {
        const tick = await getTick(symbol);
        const candles = await getOHLC(symbol, '5min', 100);
        
        if (!candles.length) {
            return res.json({ status: "No Market", symbol });
        }
        
        const closes = candles.map(c => c.close);
        const harga = tick.mid || closes[closes.length - 1];
        const ema = analyzeCandles(candles);
        
        // Detect SNR, FVG, POC
        const snr = calcSNR(candles);
        const fvg = calcFVG(candles);
        const poc = calcPOC(candles);
        
        // Signal dengan confidence
        let signalText = 'WAIT';
        if (ema && ema.signal === 'BUY') signalText = `BUY ${ema.confidence}%`;
        else if (ema && ema.signal === 'SELL') signalText = `SELL ${ema.confidence}%`;
        
        res.json({
            status: "OK",
            symbol,
            harga: parseFloat(harga.toFixed(decimal)),
            price: parseFloat(harga.toFixed(decimal)),
            bid: parseFloat(tick.bid.toFixed(decimal)),
            ask: parseFloat(tick.ask.toFixed(decimal)),
            spread: parseFloat(tick.spread.toFixed(decimal)),
            
            ema: {
                ema9: ema ? parseFloat(ema.ema9.toFixed(decimal)) : 0,
                ema21: ema ? parseFloat(ema.ema21.toFixed(decimal)) : 0,
                ema50: ema ? parseFloat(ema.ema50.toFixed(decimal)) : 0,
                trend: ema && ema.ema21 > ema.ema50 ? "BULLISH" : "BEARISH"
            },
            
            snr: snr,
            fvg: fvg,
            poc: poc ? parseFloat(poc.toFixed(decimal)) : null,
            
            signal: signalText,
            action: ema ? ema.signal : 'WAIT',
            confidence: ema ? ema.confidence : 0,
            
            session: getMarketSession(),
            time: new Date().toLocaleTimeString()
        });
    } catch (e) {
        console.error('/api/market ERROR:', e.message);
        res.json({ status: "Error", error: e.message });
    }
});

// ===============================================
// ✅ ENDPOINT SIGNAL
// ===============================================
app.get('/api/signal', async (req, res) => {
    const symbol = req.query.symbol || 'XAU/USD';
    const decimal = getDecimal(symbol);
    
    try {
        const candles = await getOHLC(symbol, '5min', 100);
        if (!candles.length) {
            return res.json({ status: "No Data", symbol });
        }
        
        const closes = candles.map(c => c.close);
        const harga = closes[closes.length - 1];
        const ema = analyzeCandles(candles);
        
        const snr = calcSNR(candles);
        const fvg = calcFVG(candles);
        const poc = calcPOC(candles);
        
        let signalText = 'WAIT';
        if (ema && ema.signal === 'BUY') signalText = `BUY ${ema.confidence}%`;
        else if (ema && ema.signal === 'SELL') signalText = `SELL ${ema.confidence}%`;
        
        res.json({
            symbol,
            price: parseFloat(harga.toFixed(decimal)),
            harga: parseFloat(harga.toFixed(decimal)),
            signal: signalText,
            action: ema ? ema.signal : 'WAIT',
            confidence: ema ? ema.confidence : 0,
            ema: {
                ema9: ema ? parseFloat(ema.ema9.toFixed(decimal)) : 0,
                ema21: ema ? parseFloat(ema.ema21.toFixed(decimal)) : 0,
                ema50: ema ? parseFloat(ema.ema50.toFixed(decimal)) : 0
            },
            snr: snr,
            fvg: fvg,
            poc: poc ? parseFloat(poc.toFixed(decimal)) : null,
            session: getMarketSession(),
            status: "OK"
        });
    } catch (e) {
        console.error('/api/signal ERROR:', e.message);
        res.json({ status: "Error", error: e.message });
    }
});

// ===============================================
// ✅ ENDPOINT SIGNAL-SIMPLE (untuk EA)
// ===============================================
app.get('/api/signal-simple', async (req, res) => {
    const symbol = req.query.symbol || 'XAU/USD';
    const decimal = getDecimal(symbol);
    
    try {
        const candles = await getOHLC(symbol, '5min', 300);
        if (candles.length < 50) throw new Error("Data tak cukup");
        
        const closes = candles.map(c => c.close);
        const harga = closes[closes.length - 1];
        const ema = analyzeCandles(candles);
        const atr = calculateATR(candles, 14);
        
        let signal = 'WAIT';
        if (ema && ema.signal) signal = ema.signal;
        
        // Kira SL/TP ikut ATR
        const slDist = atr * 1.5;
        const tp1Dist = atr * 3;
        const tp2Dist = atr * 6;
        const tp3Dist = atr * 10;
        
        let sl = null, tp1 = null, tp2 = null, tp3 = null;
        
        if (signal === 'BUY') {
            sl = (harga - slDist).toFixed(decimal);
            tp1 = (harga + tp1Dist).toFixed(decimal);
            tp2 = (harga + tp2Dist).toFixed(decimal);
            tp3 = (harga + tp3Dist).toFixed(decimal);
        } else if (signal === 'SELL') {
            sl = (harga + slDist).toFixed(decimal);
            tp1 = (harga - tp1Dist).toFixed(decimal);
            tp2 = (harga - tp2Dist).toFixed(decimal);
            tp3 = (harga - tp3Dist).toFixed(decimal);
        }
        
        res.json({
            symbol: symbol.replace('/', ''),
            action: signal,
            score: ema ? ema.confidence : 0,
            harga: parseFloat(harga.toFixed(decimal)),
            entry: parseFloat(harga.toFixed(decimal)),
            sl: sl ? parseFloat(sl) : null,
            tp1: tp1 ? parseFloat(tp1) : null,
            tp2: tp2 ? parseFloat(tp2) : null,
            tp3: tp3 ? parseFloat(tp3) : null,
            ema9: ema ? parseFloat(ema.ema9.toFixed(decimal)) : 0,
            ema21: ema ? parseFloat(ema.ema21.toFixed(decimal)) : 0,
            ema50: ema ? parseFloat(ema.ema50.toFixed(decimal)) : 0,
            atr: parseFloat(atr.toFixed(decimal)),
            session: getMarketSession()
        });
    } catch (error) {
        console.error("/api/signal-simple ERROR:", error.message);
        res.json({
            symbol: symbol.replace('/', ''), action: 'WAIT', score: 0,
            harga: 0, entry: 0, sl: null, tp1: null, tp2: null, tp3: null,
            error: error.message
        });
    }
});

// ===============================================
// TEST ENDPOINTS
// ===============================================
app.get('/health', (req, res) => res.json({ status: 'OK', timestamp: new Date().toISOString() }));

app.get('/api/test-ea', (req, res) => {
    res.json({
        ea_api_key: EA_API_KEY.substring(0, 4) + '***',
        ea_online: eaStatus.online,
        ea_last_seen: eaStatus.lastSeen,
        ea_account: eaStatus.accountNumber,
        ea_balance: eaStatus.balance,
        queue_length: tradeQueue.length,
        history_length: tradeHistory.length,
        endpoints: [
            'POST /api/ea/heartbeat',
            'GET  /api/ea/status',
            'GET  /api/ea/commands',
            'POST /api/ea/result',
            'POST /api/ea/execute',
            'POST /api/ea/close',
            'POST /api/ea/close-all',
            'GET  /api/ea/history',
            'GET  /api/signal',
            'GET  /api/signal-simple',
            'GET  /api/market'
        ]
    });
});

app.get('/', (req, res) => res.sendFile(__dirname + '/index.html'));

// ===============================================
// START
// ===============================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 BPT v1.13 running on port ${PORT}`);
    console.log(`🔑 EA API Key: ${EA_API_KEY}`);
    console.log(`📡 All endpoints ready`);
});