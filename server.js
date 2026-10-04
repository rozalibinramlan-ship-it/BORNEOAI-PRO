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

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const BIQUOTE_URL = 'https://biquote.io/api';

const symbolMap = {
    'XAU/USD': 'xauusd', 'XAG/USD': 'xagusd',
    'EUR/USD': 'eurusd', 'GBP/USD': 'gbpusd', 'USD/JPY': 'usdjpy',
    'AUD/USD': 'audusd', 'USD/CAD': 'usdcad', 'USD/CHF': 'usdchf', 'NZD/USD': 'nzdusd',
    'EUR/GBP': 'eurgbp', 'EUR/JPY': 'eurjpy', 'EUR/AUD': 'euraud',
    'GBP/JPY': 'gbpjpy', 'GBP/AUD': 'gbpaud', 'AUD/JPY': 'audjpy',
    'SPX500': 'spx500', 'NAS100': 'nas100', 'US30': 'us30',
    'DE30': 'de30', 'JP225': 'jp225',
    'WTICO': 'wtiusd', 'BCO': 'brentusd', 'NATGAS': 'natgas'
};

function toBiquote(s) { return symbolMap[s] || s.replace('/', '').toLowerCase(); }

function getDecimal(s) {
    if (s.includes('JPY')) return 3;
    if (['SPX500','NAS100','US30','DE30','JP225'].some(x => s.includes(x))) return 1;
    if (['WTICO','BCO','NATGAS'].some(x => s.includes(x))) return 3;
    if (s.includes('XAU') || s.includes('XAG')) return 2;
    return 5;
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
        const h = candles[i].high, l = candles[i].low, pc = candles[i-1].close;
        trs.push(Math.max(h-l, Math.abs(h-pc), Math.abs(l-pc)));
    }
    return trs.reduce((a,b) => a+b, 0) / period;
}

function getMarketSession() {
    const h = new Date().getUTCHours();
    if (h >= 7 && h < 16) return "LONDON";
    if (h >= 12 && h < 21) return "NEW YORK";
    if (h >= 0 && h < 7) return "ASIA";
    return "CLOSED";
}

async function getTick(symbol) {
    const url = `${BIQUOTE_URL}/${toBiquote(symbol)}`;
    const response = await axios.get(url, { timeout: 10000 });
    const d = response.data;
    const bid = parseFloat(d.bid || 0);
    const ask = parseFloat(d.ask || 0);
    const mid = parseFloat(d.mid || (bid + ask) / 2 || d.last || 0);
    const spread = parseFloat(d.spread || (ask - bid) || 0);
    return {
        bid, ask, mid, spread,
        marketState: d.marketState || 'unknown',
        stale: d.stale || false,
        timestamp: d.timestamp || d.lastQuoteAt,
        direction: d.direction || 'NEUTRAL',
        dayDiffPercent: d.dayDiffPercent || 0
    };
}

async function getOHLC(symbol, interval = '15m', limit = 100) {
    const url = `${BIQUOTE_URL}/${toBiquote(symbol)}/ohlc?interval=${interval}&limit=${limit}`;
    const response = await axios.get(url, { timeout: 10000 });
    const d = response.data;
    const bars = d.bars || d.data || (Array.isArray(d) ? d : []);
    return bars.map(c => ({
        time: c.openTime || c.time || c.timestamp,
        timestamp: Math.floor(new Date(c.openTime || c.time || c.timestamp).getTime() / 1000),
        open: parseFloat(c.open || 0),
        high: parseFloat(c.high || 0),
        low: parseFloat(c.low || 0),
        close: parseFloat(c.close || 0),
        isOpen: c.isOpen || false
    }));
}

app.get('/api/signal', async (req, res) => {
    const symbol = req.query.symbol || 'XAU/USD';
    const decimal = getDecimal(symbol);
    try {
        const candles = await getOHLC(symbol, '1m', 100);
        if (candles.length < 50) throw new Error("Data tak cukup");
        const closes = candles.map(c => c.close);
        const harga = closes[closes.length - 1];
        
        const kiraEMA = (arr, t) => { let e = arr[0]; let k = 2/(t+1); for (let i = 1; i < arr.length; i++) e = (arr[i]*k) + (e*(1-k)); return e; };
        const ema9 = kiraEMA(closes, 9), ema21 = kiraEMA(closes, 21), ema50 = kiraEMA(closes, 50);
        const rsi = calculateRSI(closes, 14);
        const atr = calculateATR(candles, 14);
        const atrPercent = (atr / harga) * 100;
        const session = getMarketSession();
        
        let spread = 0, bid = 0, ask = 0;
        try {
            const tick = await getTick(symbol);
            bid = tick.bid || harga;
            ask = tick.ask || harga;
            spread = tick.spread || 0;
        } catch (e) { console.log("Tick error:", e.message); }
        
        let signal = "WAIT", warna = "#94a3b8", reasons = [], filtered = false;
        const emaCross = ema9 > ema21 ? "BUY" : "SELL";
        if (emaCross === "BUY" && rsi > 70) { filtered = true; reasons.push("RSI Overbought"); }
        if (emaCross === "SELL" && rsi < 30) { filtered = true; reasons.push("RSI Oversold"); }
        if (atrPercent < 0.05) { filtered = true; reasons.push("Low Volatility"); }
        if (emaCross === "BUY" && harga < ema50) { filtered = true; reasons.push("Against Trend"); }
        if (emaCross === "SELL" && harga > ema50) { filtered = true; reasons.push("Against Trend"); }
        if (session === "ASIA" || session === "CLOSED") { filtered = true; reasons.push("Off Session"); }
        if (!filtered) { signal = emaCross; warna = signal === "BUY" ? "#22c55e" : "#ef4444"; }
        
        res.json({
            symbol, harga: harga.toFixed(decimal), signal, warna,
            ema9: ema9.toFixed(decimal), ema21: ema21.toFixed(decimal), ema50: ema50.toFixed(decimal),
            rsi: rsi.toFixed(1), atrPercent: atrPercent.toFixed(3), session,
            spread: spread.toFixed(decimal), bid: bid.toFixed(decimal), ask: ask.toFixed(decimal),
            filtered, reasons, masa: new Date().toLocaleTimeString(), status: "LIVE", source: "Biquote"
        });
    } catch (error) {
        console.error("Signal Error:", error.message);
        res.json({ symbol, harga: "0.00", signal: "WAIT", warna: "#94a3b8", ema9: "0", ema21: "0", ema50: "0", rsi: "50", atrPercent: "0", session: "CLOSED", spread: "0", bid: "0", ask: "0", filtered: true, reasons: ["Data Error"], masa: new Date().toLocaleTimeString(), status: "ERROR", source: "Biquote" });
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
            change: (tick.dayDiffPercent || 0).toFixed(2) + "%", poc: (harga + variance*2).toFixed(decimal),
            snr: {
                r3: (harga + variance*30).toFixed(decimal), r2: (harga + variance*20).toFixed(decimal),
                r1: (harga + variance*10).toFixed(decimal), poc: (harga + variance*2).toFixed(decimal),
                vah: (harga + variance*5).toFixed(decimal), val: (harga - variance*5).toFixed(decimal),
                s1: (harga - variance*10).toFixed(decimal), s2: (harga - variance*20).toFixed(decimal),
                s3: (harga - variance*30).toFixed(decimal)
            },
            footprint: [
                { price: (harga + variance*10).toFixed(decimal), vol: 128, delta: 64 },
                { price: (harga + variance*5).toFixed(decimal), vol: 96, delta: -18 },
                { price: (harga + variance*2).toFixed(decimal), vol: 312, delta: 110, is_poc: true },
                { price: harga.toFixed(decimal), vol: 205, delta: -72 },
                { price: (harga - variance*5).toFixed(decimal), vol: 143, delta: 31 }
            ],
            time: new Date().toLocaleTimeString()
        });
    } catch (error) {
        console.error("Market Error:", error.message);
        res.status(500).json({ status: "error", message: error.message });
    }
});

app.post('/api/ai-analysis', async (req, res) => {
    try {
        const { price, ema9, ema21, signal_time, soalan, rsi, atr, session, reasons, spread } = req.body;
        const prompt = `You are a Professional Trading Assistant for XAUUSD (Biquote data). Current Data: Price ${price}, EMA9 ${ema9}, EMA21 ${ema21}, RSI ${rsi}, ATR% ${atr}, Session ${session}, Spread ${spread}, Filtered: ${reasons ? reasons.join(', ') : 'None'}. User Question: "${soalan}". Answer in 2-3 sentences in Bahasa Melayu.`;
        const response = await ai.models.generateContent({ model: 'gemini-3.8-flash', contents: prompt });
        res.json({ status: "success", analysis: response.text });
    } catch (error) {
        console.error("AI Error:", error.message);
        res.status(500).json({ status: "error", message: "AI service temporarily unavailable." });
    }
});

app.get('/api/candles', async (req, res) => {
    const symbol = req.query.symbol || 'XAU/USD';
    try {
        const candles = await getOHLC(symbol, '15m', 100);
        const formatted = candles
            .filter(c => !isNaN(c.timestamp))
            .map(c => ({
                time: c.timestamp,
                open: c.open, high: c.high, low: c.low, close: c.close
            }));
        res.json({ status: "success", candles: formatted });
    } catch (error) { res.status(500).json({ status: "error", message: error.message }); }
});

app.get('/api/backtest', async (req, res) => {
    const symbol = req.query.symbol || 'XAU/USD';
    try {
        const candles = await getOHLC(symbol, '15m', 500);
        let win = 0, loss = 0, markers = [];
        for (let i = 50; i < candles.length - 1; i++) {
            const current = candles[i];
            const closesSlice = candles.slice(0, i + 1).map(c => c.close);
            const ema9 = (() => { let e = closesSlice[0]; let k = 2/10; for (let x = 1; x < closesSlice.length; x++) e = (closesSlice[x]*k)+(e*(1-k)); return e; })();
            const ema21 = (() => { let e = closesSlice[0]; let k = 2/22; for (let x = 1; x < closesSlice.length; x++) e = (closesSlice[x]*k)+(e*(1-k)); return e; })();
            const rsi = calculateRSI(closesSlice, 14);
            const atr = calculateATR(candles.slice(0, i + 1), 14);
            const atrPercent = (atr / current.close) * 100;
            if (ema9 > ema21 && rsi < 70 && atrPercent > 0.05) {
                const tp = current.close * 1.01, sl = current.close * 0.99;
                let result = null;
                for (let j = i + 1; j < candles.length; j++) {
                    if (candles[j].high >= tp) { result = 'WIN'; break; }
                    if (candles[j].low <= sl) { result = 'LOSS'; break; }
                }
                if (result === 'WIN') win++;
                if (result === 'LOSS') loss++;
                if (result) markers.push({
                    time: current.timestamp,
                    position: result === 'WIN' ? 'belowBar' : 'aboveBar',
                    color: result === 'WIN' ? '#22c55e' : '#ef4444',
                    shape: result === 'WIN' ? 'arrowUp' : 'arrowDown',
                    text: result
                });
            }
        }
        const totalTrades = win + loss;
        const winRate = totalTrades > 0 ? ((win / totalTrades) * 100).toFixed(1) : 0;
        const chartCandles = candles.slice(-100)
            .filter(c => !isNaN(c.timestamp))
            .map(c => ({ time: c.timestamp, open: c.open, high: c.high, low: c.low, close: c.close }));
        const chartMarkers = markers.filter(m => m.time >= chartCandles[0].time);
        res.json({ status: "success", winRate, totalTrades, candles: chartCandles, markers: chartMarkers });
    } catch (error) { res.status(500).json({ status: "error", message: error.message }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server berjalan di port ' + PORT));