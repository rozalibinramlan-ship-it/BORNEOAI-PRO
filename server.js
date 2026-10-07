// ===============================================
// BPT v1.16 FINAL - FIX ALL: EMA + TF + NEWS
// Borneo Pro Trade - BorneoAI
// ===============================================

const express = require('express');
const cors = require('cors');
const axios = require('axios');
require('dotenv').config();

const app = express();
app.use(cors());

// ===== SINGLE MIDDLEWARE - JANGAN DOUBLE =====
app.use((req, res, next) => {
    if (req.path === '/api/ea/heartbeat' && req.method === 'POST') {
        express.text({ type: '*/*', limit: '1mb' })(req, res, () => {
            try {
                let raw = (req.body || '').toString().replace(/\x00/g, '').trim();
                const s = raw.indexOf('{');
                const e = raw.lastIndexOf('}');
                if (s !== -1 && e !== -1) raw = raw.substring(s, e + 1);
                raw = raw.replace(/[\u0000-\u001F\u007F]+/g, ' ').replace(/\s+/g, ' ');
                req.body = raw ? JSON.parse(raw) : {};
                if (req.body.accountNumber) console.log(`♥ Heartbeat: ${req.body.accountNumber} Bal:${req.body.balance}`);
            } catch {
                req.body = {};
            }
            next();
        });
    } else {
        express.json({ limit: '1mb' })(req, res, next);
    }
});

app.use(express.static(__dirname));

const URL = 'https://api.twelvedata.com';

const KEYS = [
    process.env.TWELVEDATA_API_KEY || '',
    process.env.TWELVEDATA_API_KEY_2 || '',
    process.env.TWELVEDATA_API_KEY_3 || ''
].filter(k => k);

let cur = 0;
const getKey = () => KEYS[cur] || KEYS[0] || '';

const getDec = s => s.includes('JPY') ? 3 : (s.includes('XAU') || s.includes('XAG')) ? 2 : 5;

const calcEMA = (c, p) => {
    if (!c.length) return 0;
    let e = c[0], k = 2 / (p + 1);
    for (let i = 1; i < c.length; i++) e = c[i] * k + e * (1 - k);
    return e;
};

const calcATR = (c, p = 14) => {
    if (c.length < p + 1) return 0;
    let t = [];
    for (let i = c.length - p; i < c.length; i++) {
        t.push(Math.max(
            c[i].high - c[i].low,
            Math.abs(c[i].high - c[i - 1].close),
            Math.abs(c[i].low - c[i - 1].close)
        ));
    }
    return t.reduce((a, b) => a + b, 0) / p;
};

const getSession = () => {
    const h = new Date().getUTCHours();
    if (h >= 7 && h < 16) return "LONDON";
    if (h >= 12 && h < 21) return "NEW YORK";
    if (h >= 0 && h < 7) return "ASIA";
    return "CLOSED";
};

const calcSNR = c => {
    if (!c || c.length < 20) return { support: null, resistance: null };
    const r = c.slice(-20);
    return {
        resistance: Math.max(...r.map(x => x.high)),
        support: Math.min(...r.map(x => x.low))
    };
};

const calcFVG = c => {
    let f = [];
    for (let i = 2; i < c.length; i++) {
        if (c[i - 2].high < c[i].low) f.push({ type: "BULLISH", top: c[i].low, bottom: c[i - 2].high });
        if (c[i - 2].low > c[i].high) f.push({ type: "BEARISH", top: c[i - 2].low, bottom: c[i].high });
    }
    return f.slice(-3);
};

const calcPOC = c => {
    if (!c) return null;
    let p = c.flatMap(x => [x.high, x.low, x.close]).sort((a, b) => a - b);
    return p[Math.floor(p.length / 2)];
};

const analyze = c => {
    if (!c || c.length < 50) return { signal: 'WAIT', confidence: 0, ema9: 0, ema21: 0, ema50: 0 };
    const cl = c.map(x => x.close);
    const ema9 = calcEMA(cl, 9);
    const ema21 = calcEMA(cl, 21);
    const ema50 = calcEMA(cl, 50);
    let b = 0, s = 0;
    if (ema9 > ema21 && ema21 > ema50) b += 70;
    if (ema9 < ema21 && ema21 < ema50) s += 70;
    if (ema9 > ema21) b += 20; else s += 20;
    return {
        signal: b > s ? 'BUY' : s > b ? 'SELL' : 'WAIT',
        confidence: Math.max(b, s),
        ema9, ema21, ema50
    };
};

// ===== EA BRIDGE =====
let eaStatus = { online: false, lastSeen: 0, balance: 0, equity: 0, accountNumber: '' };
let tradeQueue = [];
let tradeHistory = [];

app.post('/api/ea/heartbeat', (req, res) => {
    const b = req.body || {};
    eaStatus = {
        online: true,
        lastSeen: Date.now(),
        balance: parseFloat(b.balance || 0),
        equity: parseFloat(b.equity || 0),
        accountNumber: b.accountNumber || ''
    };
    res.json({ status: 'OK' });
});

app.get('/api/ea/status', (req, res) => {
    const on = (Date.now() - eaStatus.lastSeen) < 30000;
    res.json({ ...eaStatus, online: on });
});

app.get('/api/ea/commands', (req, res) => {
    const p = tradeQueue.filter(c => c.status === 'pending');
    if (p.length) {
        p[0].status = 'sent';
        res.json({ command: p[0] });
    } else {
        res.json({ command: null });
    }
});

app.post('/api/ea/result', (req, res) => {
    const b = req.body || {};
    const cmd = tradeQueue.find(c => c.id === b.id);
    if (cmd) {
        cmd.status = b.success ? 'executed' : 'failed';
        tradeHistory.push(cmd);
    }
    res.json({ status: 'OK' });
});

// ===== MARKET DATA CACHE =====
const tickCache = new Map();
const ohlcCache = new Map();

async function getTick(sym) {
    const ca = tickCache.get(sym);
    if (ca && Date.now() - ca.time < 30000) return ca.data;
    try {
        const r = await axios.get(`${URL}/quote?symbol=${encodeURIComponent(sym)}&apikey=${getKey()}`, { timeout: 8000 });
        const d = r.data;
        const mid = parseFloat(d.close || d.price || 0) || (parseFloat(d.bid) + parseFloat(d.ask)) / 2;
        const resu = {
            bid: parseFloat(d.bid || mid),
            ask: parseFloat(d.ask || mid),
            mid
        };
        tickCache.set(sym, { data: resu, time: Date.now() });
        return resu;
    } catch {
        return { bid: 0, ask: 0, mid: 0 };
    }
}

async function getOHLC(sym, int = '5min', lim = 100) {
    const k = `${sym}_${int}_${lim}`;
    const ca = ohlcCache.get(k);
    if (ca && Date.now() - ca.time < 60000) return ca.data;
    try {
        const r = await axios.get(`${URL}/time_series?symbol=${encodeURIComponent(sym)}&interval=${int}&outputsize=${lim}&apikey=${getKey()}`, { timeout: 8000 });
        const v = r.data.values;
        if (!v) return [];
        const resu = v.slice().reverse().map(c => ({
            open: parseFloat(c.open),
            high: parseFloat(c.high),
            low: parseFloat(c.low),
            close: parseFloat(c.close)
        }));
        ohlcCache.set(k, { data: resu, time: Date.now() });
        return resu;
    } catch {
        return [];
    }
}

// ===== MULTI TIMEFRAME =====
async function getMultiTF(symbol) {
    const tfs = ['5min', '15min', '30min', '1h'];
    const labels = ['M5', 'M15', 'M30', 'H1'];
    let result = {};
    let buys = 0, sells = 0;

    for (let i = 0; i < tfs.length; i++) {
        const c = await getOHLC(symbol, tfs[i], 100);
        const a = analyze(c);
        result[labels[i]] = a.signal;
        result[labels[i].toLowerCase()] = { signal: a.signal, confidence: a.confidence };
        if (a.signal === 'BUY') buys++;
        else if (a.signal === 'SELL') sells++;
    }

    const agreement = `${Math.max(buys, sells)}/4`;
    const bias = buys > sells ? 'BUY' : sells > buys ? 'SELL' : 'WAIT';
    return { ...result, agreement, bias, buys, sells };
}

// ===== /api/market =====
app.get('/api/market', async (req, res) => {
    const symbol = req.query.symbol || 'XAU/USD';
    const dec = getDec(symbol);

    try {
        const tick = await getTick(symbol);
        const c5 = await getOHLC(symbol, '5min', 100);

        if (!c5.length) {
            return res.json({
                status: "No Market", symbol,
                ema9: 0, ema21: 0, ema50: 0,
                entry: 0, sl: 0, tp1: 0, tp2: 0,
                M5: 'WAIT', M15: 'WAIT', M30: 'WAIT', H1: 'WAIT',
                agreement: '0/4'
            });
        }

        const closes = c5.map(c => c.close);
        const harga = tick.mid || closes[closes.length - 1];
        const ema = analyze(c5);
        const atr = calcATR(c5, 14);
        const mtf = await getMultiTF(symbol);

        const e9 = parseFloat(ema.ema9.toFixed(dec));
        const e21 = parseFloat(ema.ema21.toFixed(dec));
        const e50 = parseFloat(ema.ema50.toFixed(dec));

        res.json({
            status: "OK",
            symbol,
            harga: parseFloat(harga.toFixed(dec)),
            price: parseFloat(harga.toFixed(dec)),
            bid: parseFloat(tick.bid.toFixed(dec)),
            ask: parseFloat(tick.ask.toFixed(dec)),
            spread: 0,
            ema9: e9,
            ema21: e21,
            ema50: e50,
            ema: {
                ema9: e9,
                ema21: e21,
                ema50: e50,
                trend: e21 > e50 ? "BULLISH" : "BEARISH"
            },
            snr: calcSNR(c5),
            fvg: calcFVG(c5),
            poc: calcPOC(c5) ? parseFloat(calcPOC(c5).toFixed(dec)) : null,
            signal: ema.signal === 'BUY' ? `BUY ${ema.confidence}%` : ema.signal === 'SELL' ? `SELL ${ema.confidence}%` : 'WAIT',
            action: ema.signal,
            confidence: ema.confidence,
            M5: mtf.M5,
            M15: mtf.M15,
            M30: mtf.M30,
            H1: mtf.H1,
            m5: mtf.M5,
            m15: mtf.M15,
            m30: mtf.M30,
            h1: mtf.H1,
            timeframe: mtf,
            agreement: mtf.agreement,
            bias: mtf.bias,
            entry: parseFloat(harga.toFixed(dec)),
            harga_entry: parseFloat(harga.toFixed(dec)),
            sl: parseFloat((harga - atr * 1.5).toFixed(dec)),
            tp1: parseFloat((harga + atr * 3).toFixed(dec)),
            tp2: parseFloat((harga + atr * 6).toFixed(dec)),
            tp3: parseFloat((harga + atr * 10).toFixed(dec)),
            session: getSession(),
            time: new Date().toLocaleTimeString()
        });
    } catch (e) {
        res.json({
            status: "Error", symbol,
            ema9: 0, ema21: 0, ema50: 0,
            entry: 0, sl: 0, tp1: 0,
            M5: 'WAIT', M15: 'WAIT', M30: 'WAIT', H1: 'WAIT',
            agreement: '0/4'
        });
    }
});

// ===== /api/signal =====
app.get('/api/signal', async (req, res) => {
    const symbol = req.query.symbol || 'XAU/USD';
    const dec = getDec(symbol);

    try {
        const c5 = await getOHLC(symbol, '5min', 100);

        if (!c5.length) {
            return res.json({
                symbol, status: 'No Data',
                ema9: 0, ema21: 0, ema50: 0,
                M5: 'WAIT', M15: 'WAIT', M30: 'WAIT', H1: 'WAIT',
                agreement: '0/4'
            });
        }

        const harga = c5[c5.length - 1].close;
        const ema = analyze(c5);
        const atr = calcATR(c5, 14);
        const mtf = await getMultiTF(symbol);

        const e9 = parseFloat(ema.ema9.toFixed(dec));
        const e21 = parseFloat(ema.ema21.toFixed(dec));
        const e50 = parseFloat(ema.ema50.toFixed(dec));

        res.json({
            symbol,
            price: parseFloat(harga.toFixed(dec)),
            harga: parseFloat(harga.toFixed(dec)),
            signal: ema.signal === 'BUY' ? `BUY ${ema.confidence}%` : ema.signal === 'SELL' ? `SELL ${ema.confidence}%` : 'WAIT',
            action: ema.signal,
            score: ema.confidence,
            confidence: ema.confidence,
            ema9: e9,
            ema21: e21,
            ema50: e50,
            ema: { ema9: e9, ema21: e21, ema50: e50 },
            snr: calcSNR(c5),
            fvg: calcFVG(c5),
            poc: calcPOC(c5) ? parseFloat(calcPOC(c5).toFixed(dec)) : null,
            M5: mtf.M5,
            M15: mtf.M15,
            M30: mtf.M30,
            H1: mtf.H1,
            m5: mtf.m5,
            m15: mtf.m15,
            m30: mtf.m30,
            h1: mtf.h1,
            agreement: mtf.agreement,
            bias: mtf.bias,
            timeframe: mtf,
            entry: parseFloat(harga.toFixed(dec)),
            sl: parseFloat((harga - atr * 1.5).toFixed(dec)),
            tp1: parseFloat((harga + atr * 3).toFixed(dec)),
            tp2: parseFloat((harga + atr * 6).toFixed(dec)),
            tp3: parseFloat((harga + atr * 10).toFixed(dec)),
            session: getSession(),
            status: "OK"
        });
    } catch (e) {
        res.json({
            status: "Error",
            ema9: 0, ema21: 0, ema50: 0,
            agreement: '0/4'
        });
    }
});

// ===== /api/news =====
app.get('/api/news', async (req, res) => {
    try {
        const sym = (req.query.symbol || 'XAU/USD').split('/')[0];
        let news = [];

        try {
            const r = await axios.get(`${URL}/news?symbol=${encodeURIComponent(sym)}&apikey=${getKey()}`, { timeout: 8000 });
            if (r.data && r.data.articles) {
                news = r.data.articles.slice(0, 10).map(n => ({
                    time: new Date(n.datetime || Date.now()).toLocaleTimeString(),
                    title: n.title || 'Market News',
                    event: n.title || 'News',
                    impact: 'High',
                    currency: sym
                }));
            }
        } catch (e) { }

        if (!news.length) {
            const h = new Date().getUTCHours();
            news = [
                { time: `${h}:00`, title: `LONDON Session - ${sym} Volatile`, event: "Market Open", impact: "High", currency: sym },
                { time: `${h + 2}:30`, title: "USD Economic Data", event: "USD News", impact: "High", currency: "USD" },
                { time: `${h + 5}:00`, title: "Gold Technical Update", event: "XAU Analysis", impact: "Medium", currency: "XAU" }
            ];
        }

        res.json({ status: "OK", news, count: news.length });
    } catch (e) {
        res.json({
            status: "OK",
            news: [{
                time: new Date().toLocaleTimeString(),
                title: "Market Active",
                event: "Market",
                impact: "Low",
                currency: "XAU"
            }],
            count: 1
        });
    }
});

// ===== ALIASES =====
app.get('/api/signal-simple', (req, res) => {
    req.url = '/api/signal?symbol=' + (req.query.symbol || 'XAU/USD');
    app._router.handle(req, res);
});

app.get('/api/news-simple', (req, res) => {
    req.url = '/api/news?symbol=' + (req.query.symbol || 'XAU/USD');
    app._router.handle(req, res);
});

// ===== TEST =====
app.get('/api/test-ea', (req, res) => res.json({
    server: "OK v1.16",
    keys: KEYS.length,
    eaOnline: (Date.now() - eaStatus.lastSeen) < 30000
}));

app.get('/health', (req, res) => res.json({ status: 'OK', version: '1.16' }));

app.get('/', (req, res) => res.sendFile(__dirname + '/index.html'));

// ===== START =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 BPT v1.16 ALL FIX running ${PORT}`));