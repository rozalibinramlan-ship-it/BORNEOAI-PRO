const express = require('express');
const axios = require('axios');
const cors = require('cors');
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
const TWELVE_DATA_KEY = '9232c8d947f1486a9562da7d78b8f5c4';

function calculateRSI(closes, period = 14) {
    if (closes.length < period + 1) return 50;
    let gains = 0, losses = 0;
    for (let i = closes.length - period; i < closes.length; i++) {
        const diff = closes[i] - closes[i - 1];
        if (diff >= 0) gains += diff; else losses -= diff;
    }
    const avgGain = gains / period; const avgLoss = losses / period;
    if (avgLoss === 0) return 100;
    return 100 - (100 / (1 + (avgGain / avgLoss)));
}

function calculateATR(candles, period = 14) {
    if (candles.length < period + 1) return 0;
    let trs = [];
    for (let i = candles.length - period; i < candles.length; i++) {
        const high = candles[i].high; const low = candles[i].low; const prevClose = candles[i - 1].close;
        trs.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
    }
    return trs.reduce((a, b) => a + b, 0) / period;
}

function getMarketSession() {
    const hour = new Date().getUTCHours();
    if (hour >= 7 && hour < 16) return "LONDON";
    if (hour >= 12 && hour < 21) return "NEW YORK";
    if (hour >= 0 && hour < 7) return "ASIA";
    return "CLOSED";
}

app.get('/api/signal', async (req, res) => {
    const symbol = req.query.symbol || 'XAU/USD'; 
    try {
        const response = await axios.get(`https://api.twelvedata.com/time_series?symbol=${symbol}&interval=1min&outputsize=100&apikey=${TWELVE_DATA_KEY}`);
        if (response.data.status === 'error') throw new Error("API Limit");
        const values = response.data.values;
        const candles = values.map(v => ({
            time: v.datetime, open: parseFloat(v.open),
            high: parseFloat(v.high), low: parseFloat(v.low), close: parseFloat(v.close)
        })).reverse();
        const closes = candles.map(c => c.close);
        const hargaTerkini = closes[closes.length - 1];
        const kiraEMA = (arr, t) => { let e = arr[0]; let k = 2/(t+1); for (let i = 1; i < arr.length; i++) e = (arr[i]*k) + (e*(1-k)); return e; };
        const ema9 = kiraEMA(closes, 9); const ema21 = kiraEMA(closes, 21); const ema50 = kiraEMA(closes, 50);
        const rsi = calculateRSI(closes, 14);
        const atr = calculateATR(candles, 14);
        const atrPercent = (atr / hargaTerkini) * 100;
        const session = getMarketSession();
        
        let signal = "WAIT"; let warna = "#94a3b8"; let reasons = []; let filtered = false;
        const emaCross = ema9 > ema21 ? "BUY" : "SELL";
        if (emaCross === "BUY" && rsi > 70) { filtered = true; reasons.push("RSI Overbought"); }
        if (emaCross === "SELL" && rsi < 30) { filtered = true; reasons.push("RSI Oversold"); }
        if (atrPercent < 0.05) { filtered = true; reasons.push("Low Volatility"); }
        if (emaCross === "BUY" && hargaTerkini < ema50) { filtered = true; reasons.push("Against Trend"); }
        if (emaCross === "SELL" && hargaTerkini > ema50) { filtered = true; reasons.push("Against Trend"); }
        if (session === "ASIA" || session === "CLOSED") { filtered = true; reasons.push("Off Session"); }
        if (!filtered) { signal = emaCross; warna = signal === "BUY" ? "#22c55e" : "#ef4444"; }
        
        let decimal = 2; if (symbol.includes('EUR') || symbol.includes('GBP')) decimal = 4;
        res.json({ symbol, harga: hargaTerkini.toFixed(decimal), signal, warna, ema9: ema9.toFixed(decimal), ema21: ema21.toFixed(decimal), ema50: ema50.toFixed(decimal), rsi: rsi.toFixed(1), atrPercent: atrPercent.toFixed(3), session, filtered, reasons, masa: new Date().toLocaleTimeString(), status: "LIVE" });
    } catch (error) {
        res.json({ symbol, harga: "4140.04", signal: "WAIT", warna: "#94a3b8", ema9: "4138.34", ema21: "4137.22", ema50: "4135.00", rsi: "50", atrPercent: "0.1", session: "LONDON", filtered: true, reasons: ["Simulation"], masa: new Date().toLocaleTimeString(), status: "SIMULASI" });
    }
});

app.get('/api/market', async (req, res) => {
    const symbol = req.query.symbol || 'XAU/USD'; 
    try {
        const response = await axios.get(`https://api.twelvedata.com/price?symbol=${symbol}&apikey=${TWELVE_DATA_KEY}`);
        if (response.data.status === 'error') throw new Error("API Limit");
        const hargaTerkini = parseFloat(response.data.price);
        let decimal = 2; if (symbol.includes('EUR') || symbol.includes('GBP')) decimal = 4;
        const variance = Math.random() * (hargaTerkini * 0.001);
        res.json({
            symbol, harga: hargaTerkini.toFixed(decimal), change: "-0.23% • 24h", poc: (hargaTerkini + (variance * 2)).toFixed(decimal),
            snr: { r3: (hargaTerkini + (variance * 30)).toFixed(decimal), r2: (hargaTerkini + (variance * 20)).toFixed(decimal), r1: (hargaTerkini + (variance * 10)).toFixed(decimal), poc: (hargaTerkini + (variance * 2)).toFixed(decimal), vah: (hargaTerkini + (variance * 5)).toFixed(decimal), val: (hargaTerkini - (variance * 5)).toFixed(decimal), s1: (hargaTerkini - (variance * 10)).toFixed(decimal), s2: (hargaTerkini - (variance * 20)).toFixed(decimal), s3: (hargaTerkini - (variance * 30)).toFixed(decimal) },
            footprint: [ { price: (hargaTerkini + (variance * 10)).toFixed(decimal), vol: 128, delta: 64 }, { price: (hargaTerkini + (variance * 5)).toFixed(decimal), vol: 96, delta: -18 }, { price: (hargaTerkini + (variance * 2)).toFixed(decimal), vol: 312, delta: 110, is_poc: true }, { price: hargaTerkini.toFixed(decimal), vol: 205, delta: -72 }, { price: (hargaTerkini - (variance * 5)).toFixed(decimal), vol: 143, delta: 31 } ],
            time: new Date().toLocaleTimeString()
        });
    } catch (error) {
        res.json({ symbol, harga: "4140.04", change: "-0.23%", poc: "4142.5", snr: { r3: "4170", r2: "4160", r1: "4150", poc: "4142.5", vah: "4145", val: "4135", s1: "4130", s2: "4120", s3: "4110" }, footprint: [{ price: "4150", vol: 128, delta: 64 }, { price: "4145", vol: 96, delta: -18 }, { price: "4142.5", vol: 312, delta: 110, is_poc: true }, { price: "4140", vol: 205, delta: -72 }, { price: "4135", vol: 143, delta: 31 }], time: new Date().toLocaleTimeString() });
    }
});

app.post('/api/ai-analysis', async (req, res) => {
    try {
        const { price, ema9, ema21, signal_time, soalan, rsi, atr, session, reasons } = req.body;
        const prompt = `You are a Professional Trading Assistant for XAUUSD. Current Data: Price ${price}, EMA9 ${ema9}, EMA21 ${ema21}, RSI ${rsi}, ATR% ${atr}, Session ${session}, Filtered: ${reasons ? reasons.join(', ') : 'None'}. User Question: "${soalan}". Answer in 2-3 sentences in Bahasa Melayu.`;
        
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
        const response = await axios.get(`https://api.twelvedata.com/time_series?symbol=${symbol}&interval=15min&outputsize=100&apikey=${TWELVE_DATA_KEY}`);
        if (response.data.status === 'error') throw new Error("API Limit");
        const candles = response.data.values.map(v => ({
            time: Math.floor(new Date(v.datetime).getTime() / 1000),
            open: parseFloat(v.open), high: parseFloat(v.high), low: parseFloat(v.low), close: parseFloat(v.close)
        })).reverse();
        res.json({ status: "success", candles });
    } catch (error) { res.status(500).json({ status: "error", message: error.message }); }
});

app.get('/api/backtest', async (req, res) => {
    const symbol = req.query.symbol || 'XAU/USD';
    try {
        const response = await axios.get(`https://api.twelvedata.com/time_series?symbol=${symbol}&interval=15min&outputsize=500&apikey=${TWELVE_DATA_KEY}`);
        if (response.data.status === 'error') throw new Error("API Limit");
        const candles = response.data.values.map(v => ({
            time: Math.floor(new Date(v.datetime).getTime() / 1000),
            open: parseFloat(v.open), high: parseFloat(v.high), low: parseFloat(v.low), close: parseFloat(v.close)
        })).reverse();
        
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
                const tp = current.close * 1.01; const sl = current.close * 0.99;
                let result = null;
                for (let j = i + 1; j < candles.length; j++) {
                    if (candles[j].high >= tp) { result = 'WIN'; break; }
                    if (candles[j].low <= sl) { result = 'LOSS'; break; }
                }
                if (result === 'WIN') win++;
                if (result === 'LOSS') loss++;
                if (result) markers.push({ time: current.time, position: result === 'WIN' ? 'belowBar' : 'aboveBar', color: result === 'WIN' ? '#22c55e' : '#ef4444', shape: result === 'WIN' ? 'arrowUp' : 'arrowDown', text: result });
            }
        }
        const totalTrades = win + loss;
        const winRate = totalTrades > 0 ? ((win / totalTrades) * 100).toFixed(1) : 0;
        const chartCandles = candles.slice(-100);
        const chartMarkers = markers.filter(m => m.time >= chartCandles[0].time);
        res.json({ status: "success", winRate, totalTrades, candles: chartCandles, markers: chartMarkers });
    } catch (error) { res.status(500).json({ status: "error", message: error.message }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server berjalan di port ' + PORT));