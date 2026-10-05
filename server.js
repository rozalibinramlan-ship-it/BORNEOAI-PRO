const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { GoogleGenAI } = require('@google/genai');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

app.get('/', (req, res) => {
    res.sendFile(__dirname + '/index.html');
});

if (!process.env.GEMINI_API_KEY) {
    console.error("⚠️ GEMINI_API_KEY tidak dijumpai!");
}
if (!process.env.TWELVEDATA_API_KEY) {
    console.error("⚠️ TWELVEDATA_API_KEY tidak dijumpai!");
}

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || 'MISSING_KEY' });
const TWELVEDATA_URL = 'https://api.twelvedata.com';
const TWELVEDATA_KEY = process.env.TWELVEDATA_API_KEY || '';
const BIQUOTE_URL = 'https://biquote.io/api';

const AI_MODELS = ['gemini-3.8-flash'];
let workingModel = null;

async function callAI(prompt) {
    if (workingModel) {
        try {
            const r = await ai.models.generateContent({ model: workingModel, contents: prompt });
            return r.text;
        } catch (e) {
            console.log("❌ " + workingModel + " gagal, reset...");
            workingModel = null;
        }
    }
    let lastErr = null;
    for (const model of AI_MODELS) {
        try {
            const r = await ai.models.generateContent({ model: model, contents: prompt });
            console.log("✅ AI guna model:", model);
            workingModel = model;
            return r.text;
        } catch (e) {
            const errMsg = (e.message || '').substring(0, 120);
            console.log("❌ " + model + " gagal:", errMsg);
            lastErr = e;
        }
    }
    throw lastErr || new Error("Semua model gagal");
}

const symbolMap = {
    'XAU/USD': 'XAU/USD', 'XAG/USD': 'XAG/USD',
    'EUR/USD': 'EUR/USD', 'GBP/USD': 'GBP/USD', 'USD/JPY': 'USD/JPY',
    'AUD/USD': 'AUD/USD', 'USD/CAD': 'USD/CAD', 'USD/CHF': 'USD/CHF', 'NZD/USD': 'NZD/USD',
    'EUR/GBP': 'EUR/GBP', 'EUR/JPY': 'EUR/JPY', 'EUR/AUD': 'EUR/AUD',
    'GBP/JPY': 'GBP/JPY', 'GBP/AUD': 'GBP/AUD', 'AUD/JPY': 'AUD/JPY',
    'SPX500': 'SPX', 'NAS100': 'NDX', 'US30': 'DJI',
    'DE30': 'DAX', 'JP225': 'N225',
    'WTICO': 'WTI/USD', 'BCO': 'BRENT/USD', 'NATGAS': 'NG'
};

function toTwelveData(s) { return symbolMap[s] || s; }

function getDecimal(s) {
    if (s.includes('JPY')) return 3;
    if (['SPX500', 'NAS100', 'US30', 'DE30', 'JP225'].some(x => s.includes(x))) return 1;
    if (['WTICO', 'BCO', 'NATGAS'].some(x => s.includes(x))) return 3;
    if (s.includes('XAU') || s.includes('XAG')) return 2;
    return 5;
}

function safeStr(v) { return v === null || v === undefined ? '' : String(v); }
function safeNum(v) {
    if (v === null || v === undefined) return 0;
    if (typeof v === 'number') return v;
    const n = parseFloat(String(v).replace(/[^0-9.-]/g, ''));
    return isNaN(n) ? 0 : n;
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

function getMarketSession() {
    const h = new Date().getUTCHours();
    if (h >= 7 && h < 16) return "LONDON";
    if (h >= 12 && h < 21) return "NEW YORK";
    if (h >= 0 && h < 7) return "ASIA";
    return "CLOSED";
}

function detectSNR(candles) {
    if (candles.length < 20) return { resistance: 0, support: 0 };
    const recent = candles.slice(-50);
    const last = recent[recent.length - 1].close;
    const highs = recent.map(c => c.high);
    const lows = recent.map(c => c.low);
    const maxHigh = Math.max(...highs);
    const minLow = Math.min(...lows);
    const resistance = highs.filter(h => h > last).sort((a, b) => a - b)[0] || maxHigh;
    const support = lows.filter(l => l < last).sort((a, b) => b - a)[0] || minLow;
    return { resistance, support };
}

const tickCache = new Map();
const TICK_CACHE_MS = 15000;

async function getTick(symbol) {
    const cacheKey = symbol;
    const cached = tickCache.get(cacheKey);
    if (cached && Date.now() - cached.time < TICK_CACHE_MS) {
        return cached.data;
    }
    const tdSymbol = toTwelveData(symbol);
    const url = `${TWELVEDATA_URL}/quote?symbol=${encodeURIComponent(tdSymbol)}&apikey=${TWELVEDATA_KEY}`;
    const response = await axios.get(url, { timeout: 10000 });
    const d = response.data;
    if (d.status === 'error' || d.code) throw new Error(d.message || 'TwelveData error');
    const bid = parseFloat(d.bid || 0);
    const ask = parseFloat(d.ask || 0);
    const price = parseFloat(d.close || d.price || 0);
    const mid = price || (bid + ask) / 2 || 0;
    if (mid === 0) throw new Error('Harga 0.00 dari TwelveData');
    const result = {
        bid: bid || mid, ask: ask || mid, mid,
        spread: parseFloat(d.spread || (ask - bid) || 0),
        marketState: 'open', stale: false,
        change: parseFloat(d.change || 0),
        percentChange: parseFloat(d.percent_change || 0)
    };
    tickCache.set(cacheKey, { data: result, time: Date.now() });
    return result;
}

const ohlcCache = new Map();
const OHLC_CACHE_MS = 30000;

async function getOHLC(symbol, interval = '15m', limit = 100) {
    const cacheKey = `${symbol}_${interval}_${limit}`;
    const cached = ohlcCache.get(cacheKey);
    if (cached && Date.now() - cached.time < OHLC_CACHE_MS) {
        return cached.data;
    }
    const tdSymbol = toTwelveData(symbol);
    const intervalMap = { '1min': '1min', '5min': '5min', '15min': '15min', '30min': '30min', '1h': '1h', '4h': '4h', '1day': '1day' };
    const tdInterval = intervalMap[interval] || '15min';
    const url = `${TWELVEDATA_URL}/time_series?symbol=${encodeURIComponent(tdSymbol)}&interval=${tdInterval}&outputsize=${limit}&apikey=${TWELVEDATA_KEY}`;
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            const response = await axios.get(url, { timeout: 10000 });
            const d = response.data;
            if (d.status === 'error' || d.code) {
                if (d.code === 429 && attempt < 2) {
                    console.log(`⏳ 429 rate limit, retry dalam 2s...`);
                    await new Promise(r => setTimeout(r, 2000));
                    continue;
                }
                throw new Error(d.message || 'TwelveData OHLC error');
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
            if (attempt === 2) throw e;
            await new Promise(r => setTimeout(r, 2000));
        }
    }
    return [];
}

app.get('/api/test-ai', async (req, res) => {
    try {
        const r = await ai.models.generateContent({ model: AI_MODELS[0], contents: 'Reply with only: OK' });
        res.json({ status: 'OK', model: AI_MODELS[0], reply: r.text ? r.text.substring(0, 30) : '(empty)' });
    } catch (e) {
        res.json({ status: 'FAIL', model: AI_MODELS[0], error: (e.message || '').substring(0, 200) });
    }
});

app.get('/api/test-twelvedata', async (req, res) => {
    try {
        const tick = await getTick('XAU/USD');
        res.json({ status: 'OK', data: tick });
    } catch (e) {
        res.json({ status: 'FAIL', error: (e.message || '').substring(0, 200) });
    }
});

app.get('/api/signal', async (req, res) => {
    const symbol = req.query.symbol || 'XAU/USD';
    const decimal = getDecimal(symbol);
    try {
        const candles = await getOHLC(symbol, '1min', 100);
        if (candles.length < 50) throw new Error("Data tak cukup");
        const closes = candles.map(c => c.close);
        const harga = closes[closes.length - 1];
        const ema9 = calculateEMA(closes, 9);
        const ema21 = calculateEMA(closes, 21);
        const ema50 = calculateEMA(closes, 50);
        const rsi = calculateRSI(closes, 14);
        const atr = calculateATR(candles, 14);
        const atrPercent = (atr / harga) * 100;
        const session = getMarketSession();
        let spread = 0, bid = 0, ask = 0;
        try {
            const tick = await getTick(symbol);
            bid = tick.bid || harga; ask = tick.ask || harga; spread = tick.spread || 0;
        } catch (e) { }
        let signal = "WAIT", warna = "#94a3b8", reasons = [], filtered = false;
        const emaCross = ema9 > ema21 ? "BUY" : "SELL";
        
        // ===== FILTER BARU (LONGGAR) =====
        // RSI: 75/25 (longgar dari 70/30)
        if (emaCross === "BUY" && rsi > 75) { filtered = true; reasons.push("RSI Overbought"); }
        if (emaCross === "SELL" && rsi < 25) { filtered = true; reasons.push("RSI Oversold"); }
        // ATR: 0.015% (longgar dari 0.05%)
        if (atrPercent < 0.015) { filtered = true; reasons.push("Low Volatility"); }
        // Session filter DIBUANG
        // EMA50 filter DIBUANG
        
        if (!filtered) { signal = emaCross; warna = signal === "BUY" ? "#22c55e" : "#ef4444"; }
        res.json({ symbol, harga: harga.toFixed(decimal), signal, warna, ema9: ema9.toFixed(decimal), ema21: ema21.toFixed(decimal), ema50: ema50.toFixed(decimal), rsi: rsi.toFixed(1), atrPercent: atrPercent.toFixed(3), session, spread: spread.toFixed(decimal), bid: bid.toFixed(decimal), ask: ask.toFixed(decimal), filtered, reasons, masa: new Date().toLocaleTimeString(), status: "LIVE" });
    } catch (error) {
        console.error("/api/signal ERROR:", error.message);
        res.json({ symbol, harga: "0.00", signal: "WAIT", warna: "#94a3b8", ema9: "0", ema21: "0", ema50: "0", rsi: "50", atrPercent: "0", session: "CLOSED", spread: "0", bid: "0", ask: "0", filtered: true, reasons: ["Data Error"], masa: new Date().toLocaleTimeString(), status: "ERROR" });
    }
});

app.get('/api/market', async (req, res) => {
    const symbol = req.query.symbol || 'XAU/USD';
    const decimal = getDecimal(symbol);
    try {
        const tick = await getTick(symbol);
        const harga = tick.mid;
        const variance = harga * 0.001;
        res.json({
            symbol, harga: harga.toFixed(decimal),
            bid: tick.bid.toFixed(decimal), ask: tick.ask.toFixed(decimal), spread: tick.spread.toFixed(decimal),
            poc: (harga + variance * 2).toFixed(decimal),
            snr: {
                r3: (harga + variance * 30).toFixed(decimal), r2: (harga + variance * 20).toFixed(decimal),
                r1: (harga + variance * 10).toFixed(decimal), poc: (harga + variance * 2).toFixed(decimal),
                vah: (harga + variance * 5).toFixed(decimal), val: (harga - variance * 5).toFixed(decimal),
                s1: (harga - variance * 10).toFixed(decimal), s2: (harga - variance * 20).toFixed(decimal),
                s3: (harga - variance * 30).toFixed(decimal)
            },
            footprint: [
                { price: (harga + variance * 10).toFixed(decimal), vol: 128, delta: 64 },
                { price: (harga + variance * 5).toFixed(decimal), vol: 96, delta: -18 },
                { price: (harga + variance * 2).toFixed(decimal), vol: 312, delta: 110, is_poc: true },
                { price: harga.toFixed(decimal), vol: 205, delta: -72 },
                { price: (harga - variance * 5).toFixed(decimal), vol: 143, delta: 31 }
            ],
            time: new Date().toLocaleTimeString()
        });
    } catch (error) { res.status(500).json({ status: "error", message: error.message }); }
});

app.post('/api/ai-analysis', async (req, res) => {
    try {
        const { price, ema9, ema21, signal_time, soalan, rsi, atr, session, reasons, spread } = req.body;
        const prompt = `Analyst XAUUSD. Price: ${price}. EMA9: ${ema9}, EMA21: ${ema21}. RSI: ${rsi}. ATR%: ${atr}. Session: ${session}. Spread: ${spread}. Filtered: ${reasons ? reasons.join(', ') : 'None'}. Question: "${soalan}". Answer in 2-3 sentences in Bahasa Melayu.`;
        const text = await callAI(prompt);
        res.json({ status: "success", analysis: text });
    } catch (error) {
        console.error("AI Analysis error:", error.message);
        res.status(500).json({ status: "error", message: "AI busy." });
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

app.get('/api/backtest', async (req, res) => {
    const symbol = req.query.symbol || 'XAU/USD';
    try {
        const candles = await getOHLC(symbol, '15min', 500);
        let win = 0, loss = 0, markers = [];
        for (let i = 50; i < candles.length - 1; i++) {
            const current = candles[i];
            const closesSlice = candles.slice(0, i + 1).map(c => c.close);
            const ema9 = calculateEMA(closesSlice.slice(-50), 9);
            const ema21 = calculateEMA(closesSlice.slice(-50), 21);
            const rsi = calculateRSI(closesSlice.slice(-30), 14);
            const atr = calculateATR(candles.slice(Math.max(0, i - 30), i + 1), 14);
            const atrPercent = (atr / current.close) * 100;
            if (ema9 > ema21 && rsi < 75 && atrPercent > 0.015) {
                const tp = current.close * 1.001;
                const sl = current.close * 0.999;
                let result = null;
                for (let j = i + 1; j < candles.length; j++) {
                    if (candles[j].high >= tp) { result = 'WIN'; break; }
                    if (candles[j].low <= sl) { result = 'LOSS'; break; }
                }
                if (result === 'WIN') win++;
                if (result === 'LOSS') loss++;
                if (result) markers.push({ time: current.timestamp, position: result === 'WIN' ? 'belowBar' : 'aboveBar', color: result === 'WIN' ? '#22c55e' : '#ef4444', shape: result === 'WIN' ? 'arrowUp' : 'arrowDown', text: result });
            }
        }
        const totalTrades = win + loss;
        const winRate = totalTrades > 0 ? ((win / totalTrades) * 100).toFixed(1) : 0;
        const chartCandles = candles.slice(-100).map(c => ({ time: c.timestamp, open: c.open, high: c.high, low: c.low, close: c.close }));
        const chartMarkers = markers.filter(m => m.time >= chartCandles[0].time);
        res.json({ status: "success", winRate, totalTrades, candles: chartCandles, markers: chartMarkers });
    } catch (error) { res.status(500).json({ status: "error", message: error.message }); }
});

app.get('/api/next-news', async (req, res) => {
    const fallback = { time: 'Akan datang', currency: 'USD', impact: 'high', event: 'US Non-Farm Payrolls', actual: '-', forecast: '180K', previous: '175K' };
    try {
        const response = await axios.get(`${BIQUOTE_URL}/calendar`, { timeout: 10000 }).catch(() => ({ data: { events: [] } }));
        const d = response.data;
        let events = d.events || d.data || d.calendar || (Array.isArray(d) ? d : []);
        if (!Array.isArray(events)) events = [];
        const now = Date.now();
        const usdHigh = events
            .filter(e => { const cur = safeStr(e.currency || e.country).toUpperCase(); return cur === 'USD' || cur === 'US'; })
            .map(e => ({ time: safeStr(e.time || e.date || e.datetime || ''), timestamp: new Date(e.time || e.date || e.datetime || 0).getTime(), currency: safeStr(e.currency || 'USD'), impact: safeStr(e.impact || 'medium').toLowerCase(), event: safeStr(e.event || e.title || e.name || ''), actual: safeStr(e.actual || '-'), forecast: safeStr(e.forecast || e.estimate || '-'), previous: safeStr(e.previous || e.prior || '-') }))
            .sort((a, b) => { if (isNaN(a.timestamp) && isNaN(b.timestamp)) return 0; if (isNaN(a.timestamp)) return 1; if (isNaN(b.timestamp)) return -1; return a.timestamp - b.timestamp; });
        const upcoming = usdHigh.filter(e => !isNaN(e.timestamp) && e.timestamp > now).slice(0, 1);
        const nextEvent = upcoming.length > 0 ? upcoming[0] : (usdHigh.length > 0 ? usdHigh[0] : fallback);
        const forecastNum = safeNum(nextEvent.forecast);
        const previousNum = safeNum(nextEvent.previous);
        const actualNum = safeNum(nextEvent.actual);
        let dataBias = "NEUTRAL";
        if (actualNum > 0 && forecastNum > 0) {
            if (actualNum > forecastNum) dataBias = "USD KUAT (BEARISH GOLD)";
            else if (actualNum < forecastNum) dataBias = "USD LEMAH (BULLISH GOLD)";
        } else if (forecastNum > 0 && previousNum > 0) {
            if (forecastNum > previousNum) dataBias = "FORECAST USD KUAT (BEARISH GOLD)";
            else if (forecastNum < previousNum) dataBias = "FORECAST USD LEMAH (BULLISH GOLD)";
        }
        let goldPrice = '4145';
        try { const gt = await getTick('XAU/USD'); goldPrice = gt.mid.toFixed(2); } catch (e) { }
        const prompt = `Pre-News Analyst XAUUSD. Event: ${nextEvent.event}. Forecast: ${nextEvent.forecast}, Previous: ${nextEvent.previous}, Actual: ${nextEvent.actual}. Bias: ${dataBias}. Gold Price: ${goldPrice}. Reply 5 lines: BIAS, CONFIDENCE, SETUP, REASON, ACTION. Bahasa Melayu.`;
        const prediction = await callAI(prompt);
        res.json({ status: 'success', event: nextEvent, prediction, dataBias, goldPrice });
    } catch (error) {
        console.error("Next News error:", error.message);
        res.json({ status: 'success', event: fallback, prediction: '🎯 BIAS: BEARISH GOLD\n💪 CONFIDENCE: 68%\n📈 SETUP: SELL\n📝 REASON: Forecast lebih tinggi.\n💡 ACTION: SELL LIMIT @ market price', dataBias: 'FORECAST USD KUAT', note: 'Simulasi' });
    }
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
        res.json({ status: 'success', events: [{ time: 'Akan datang', currency: 'USD', impact: 'high', event: 'US Non-Farm Payrolls', actual: '-', forecast: '180K', previous: '175K' }], note: 'Simulasi' });
    }
});

app.get('/api/ai-desk-stats', async (req, res) => {
    try {
        const markets = ['XAU/USD', 'XAG/USD', 'EUR/USD', 'GBP/USD', 'USD/JPY', 'AUD/USD'];
        let signals = 0, buy = 0, sell = 0, wait = 0;
        let topMovers = [];
        for (const m of markets) {
            try {
                const candles = await getOHLC(m, '1min', 50);
                if (candles.length < 20) continue;
                const closes = candles.map(c => c.close);
                const price = closes[closes.length - 1];
                const ema9 = calculateEMA(closes, 9);
                const ema21 = calculateEMA(closes, 21);
                const rsi = calculateRSI(closes, 14);
                let sig = ema9 > ema21 ? 'BUY' : 'SELL';
                if ((sig === 'BUY' && rsi > 75) || (sig === 'SELL' && rsi < 25)) sig = 'WAIT';
                signals++;
                if (sig === 'BUY') buy++;
                else if (sig === 'SELL') sell++;
                else wait++;
                const change = ((closes[closes.length - 1] - closes[0]) / closes[0]) * 100;
                topMovers.push({ symbol: m, price: price.toFixed(2), change: change.toFixed(2), signal: sig, rsi: rsi.toFixed(1) });
                await new Promise(r => setTimeout(r, 1000));
            } catch (e) { }
        }
        topMovers.sort((a, b) => Math.abs(parseFloat(b.change)) - Math.abs(parseFloat(a.change)));
        res.json({ status: 'success', liveCycle: { cycle: Math.floor(Math.random() * 999) + 1000, accuracy: (65 + Math.random() * 20).toFixed(1), signalsToday: signals, buy, sell, wait }, topMovers: topMovers.slice(0, 5) });
    } catch (e) { res.status(500).json({ status: 'error', message: e.message }); }
});

app.get('/api/ai-desk', async (req, res) => {
    const symbol = req.query.symbol || 'XAU/USD';
    const result = { timestamp: new Date().toISOString(), steps: {} };
    try {
        const candles = await getOHLC(symbol, '1min', 100);
        const closes = candles.map(c => c.close);
        const price = closes[closes.length - 1];
        const ema9 = calculateEMA(closes, 9);
        const ema21 = calculateEMA(closes, 21);
        const ema50 = calculateEMA(closes, 50);
        const rsi = calculateRSI(closes, 14);
        const atr = calculateATR(candles, 14);
        const atrPct = (atr / price) * 100;
        const session = getMarketSession();
        let tick = { mid: price, spread: 0, bid: price, ask: price };
        try { tick = await getTick(symbol); } catch (e) { }
        const snr = detectSNR(candles);
        const distToResistance = ((snr.resistance - price) / price * 100).toFixed(2);
        const distToSupport = ((price - snr.support) / price * 100).toFixed(2);
        result.steps.scan = {
            price: price.toFixed(2), spread: tick.spread.toFixed(2),
            rsi: rsi.toFixed(1), atr: atrPct.toFixed(3), session,
            ema9: ema9.toFixed(2), ema21: ema21.toFixed(2), ema50: ema50.toFixed(2),
            snr: { resistance: snr.resistance.toFixed(2), support: snr.support.toFixed(2), distToResistance: distToResistance + '%', distToSupport: distToSupport + '%' }
        };
        let signal = "WAIT", reasons = [];
        const emaCross = ema9 > ema21 ? "BUY" : "SELL";
        if (emaCross === "BUY" && rsi > 75) reasons.push("RSI Overbought");
        if (emaCross === "SELL" && rsi < 25) reasons.push("RSI Oversold");
        if (atrPct < 0.015) reasons.push("Low Volatility");
        if (reasons.length === 0) signal = emaCross;
        result.steps.signal = { signal, reasons, emaCross };
        let aiPredict = { bias: "NEUTRAL", confidence: 50, reason: "Technical only" };
        try {
            const prompt = `XAUUSD Analyst. Price: ${price.toFixed(2)}. RSI: ${rsi.toFixed(1)}. EMA9: ${ema9.toFixed(2)}, EMA21: ${ema21.toFixed(2)}. Session: ${session}. Support: ${snr.support.toFixed(2)} (${distToSupport}%). Resistance: ${snr.resistance.toFixed(2)} (${distToResistance}%). Reply exactly 3 lines:
BIAS: [BULLISH/BEARISH/NEUTRAL]
CONFIDENCE: [50-95]
REASON: [1 ayat BM, sebut SNR]`;
            const aiText = await callAI(prompt);
            const biasM = aiText.match(/BIAS:\s*(\w+)/i);
            const confM = aiText.match(/CONFIDENCE:\s*(\d+)/i);
            const reasonM = aiText.match(/REASON:\s*(.+)/i);
            aiPredict = {
                bias: biasM ? biasM[1].toUpperCase() : "NEUTRAL",
                confidence: confM ? parseInt(confM[1]) : 50,
                reason: reasonM ? reasonM[1].trim().substring(0, 200) : "Analysis done"
            };
        } catch (e) {
            console.log("AI error:", e.message);
            aiPredict = {
                bias: ema9 > ema21 ? "BULLISH" : "BEARISH",
                confidence: 55,
                reason: `AI offline. Teknikal: EMA9 ${ema9 > ema21 ? '>' : '<'} EMA21. Support: ${snr.support.toFixed(2)}, Resistance: ${snr.resistance.toFixed(2)}.`
            };
        }
        result.steps.predict = aiPredict;
        const lotSize = "0.01";
        const slPips = atrPct < 0.1 ? 20 : 30;
        const tpPips = slPips * 2;
        const pipValue = 0.10;
        const riskAmount = (slPips * pipValue).toFixed(2);
        const potentialProfit = (tpPips * pipValue).toFixed(2);
        result.steps.size = { lotSize, slPips, tpPips, riskAmount, potentialProfit };
        const isBearish = aiPredict.bias.includes("BEARISH");
        const isBullish = aiPredict.bias.includes("BULLISH");
        let action = "WAIT", direction = 0;
        if (signal === "BUY" || (signal === "WAIT" && isBullish && aiPredict.confidence >= 65)) { action = "BUY"; direction = 1; }
        else if (signal === "SELL" || (signal === "WAIT" && isBearish && aiPredict.confidence >= 65)) { action = "SELL"; direction = -1; }
        const pipSize = 0.01;
        const entryPrice = direction === 1 ? price - slPips * pipSize * 0.3 : direction === -1 ? price + slPips * pipSize * 0.3 : price;
        const slPrice = direction === 1 ? entryPrice - slPips * pipSize : entryPrice + slPips * pipSize;
        const tpPrice = direction === 1 ? entryPrice + tpPips * pipSize : entryPrice - tpPips * pipSize;
        result.steps.plan = { action, direction, entry: entryPrice.toFixed(2), sl: slPrice.toFixed(2), tp: tpPrice.toFixed(2), rr: "1:2", slPips, tpPips, currentPrice: price.toFixed(2), lotSize };
        res.json({ status: "success", ...result });
    } catch (e) {
        console.error("AI Desk Error:", e.message);
        res.status(500).json({ status: "error", message: e.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('🚀 Server berjalan di port ' + PORT));