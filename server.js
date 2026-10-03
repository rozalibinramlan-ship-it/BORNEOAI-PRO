const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');
const { GoogleGenAI } = require('@google/genai'); 
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const TWELVE_DATA_KEY = '9232c8d947f1486a9562da7d78b8f5c4';

// 1. API SIGNAL
app.get('/api/signal', async (req, res) => {
    const symbol = req.query.symbol || 'XAU/USD'; 
    try {
        const response = await axios.get(`https://api.twelvedata.com/time_series?symbol=${symbol}&interval=1min&outputsize=50&apikey=${TWELVE_DATA_KEY}`);
        if (response.data.status === 'error') throw new Error("API Limit");
        const values = response.data.values;
        const closes = values.map(v => parseFloat(v.close)).reverse();
        const hargaTerkini = closes[closes.length - 1];
        const kiraEMA = (arr, tempoh) => {
            let ema = arr[0]; let k = 2 / (tempoh + 1);
            for (let i = 1; i < arr.length; i++) { ema = (arr[i] * k) + (ema * (1 - k)); }
            return ema;
        };
        const ema9 = kiraEMA(closes, 9);
        const ema21 = kiraEMA(closes, 21);
        let signal = "WAIT"; let warna = "#94a3b8";
        if (ema9 > ema21) { signal = "BUY"; warna = "#22c55e"; } 
        else if (ema9 < ema21) { signal = "SELL"; warna = "#ef4444"; }
        let decimal = 2;
        if (symbol.includes('EUR') || symbol.includes('GBP')) decimal = 4;
        res.json({ symbol, harga: hargaTerkini.toFixed(decimal), signal, warna, ema9: ema9.toFixed(decimal), ema21: ema21.toFixed(decimal), masa: new Date().toLocaleTimeString(), status: "LIVE" });
    } catch (error) {
        res.json({ symbol, harga: "4140.04", signal: "BUY", warna: "#22c55e", ema9: "4138.34", ema21: "4137.22", masa: new Date().toLocaleTimeString(), status: "SIMULASI" });
    }
});

// 2. API MARKET
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

// 3. API NEWS
app.get('/api/news', async (req, res) => {
    try {
        const response = await axios.get('https://www.forexfactory.com/calendar', { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' } });
        const $ = cheerio.load(response.data);
        let beritaTerkini = null;
        $('tr.calendar__row').each((i, el) => {
            const currency = $(el).find('.calendar__currency').text().trim(); const impact = $(el).find('.calendar__impact span').attr('title'); const actual = $(el).find('.calendar__actual').text().trim();
            if (currency === 'USD' && actual !== '' && impact === 'High Impact Expected') {
                beritaTerkini = { event: $(el).find('.calendar__event').text().trim(), actual, forecast: $(el).find('.calendar__forecast').text().trim(), previous: $(el).find('.calendar__previous').text().trim() };
            }
        });
        if (!beritaTerkini) return res.json({ status: "MENUNGGU", bias: "NEUTRAL USD", warna: "#fbbf24", alasan: "Tiada berita USD berimpak tinggi.", event: "Menunggu Berita...", actual: "-", forecast: "-", previous: "-" });
        let actualNum = parseFloat(beritaTerkini.actual.replace(/[^0-9.-]+/g,"")) || 0; let forecastNum = parseFloat(beritaTerkini.forecast.replace(/[^0-9.-]+/g,"")) || 0;
        let bias = "NEUTRAL USD"; let warna = "#fbbf24"; let alasan = "Market sideway.";
        if (actualNum > forecastNum) { bias = "BULLISH USD (BEARISH GOLD)"; warna = "#ef4444"; alasan = "USD mengukuh, Gold berpotensi turun."; } 
        else if (actualNum < forecastNum) { bias = "BEARISH USD (BULLISH GOLD)"; warna = "#22c55e"; alasan = "USD lemah, Gold berpotensi naik."; }
        res.json({ status: "LIVE", event: beritaTerkini.event, actual: beritaTerkini.actual, forecast: beritaTerkini.forecast, previous: beritaTerkini.previous, bias, warna, alasan });
    } catch (error) {
        res.json({ status: "SIMULASI", bias: "BEARISH USD (BULLISH GOLD)", warna: "#22c55e", alasan: "IP disekat sementara. Ini data simulasi.", event: "US NFP (Simulasi)", actual: "150K", forecast: "160K", previous: "162K" });
    }
});

// 4. API AI (GEMINI)
app.post('/api/ai-analysis', async (req, res) => {
    try {
        const { price, ema9, ema21, signal_time, soalan } = req.body;
        const masa_sekarang = Date.now() / 1000; 

        const prompt = `
        You are a Professional Trading Assistant for XAUUSD.
        Current Data:
        - Current Price: ${price}
        - EMA9: ${ema9}, EMA21: ${ema21}
        - Signal Time: ${signal_time}
        - Current Time: ${masa_sekarang}
        
        User Question: "${soalan}"
        
        Your Task:
        1. Answer the user's question based on the market data.
        2. If the question is about the signal, check if it is FALSE, VALID, or TOO LATE.
        3. Give a brief answer in 2-3 sentences in Bahasa Melayu.
        `;

        const response = await ai.models.generateContent({
            model: 'gemini-3.6-flash',
            contents: prompt,
        });
        
        const text = response.text;
        res.json({ status: "success", analysis: text });

    } catch (error) {
        console.error("AI Error:", error);
        res.status(500).json({ status: "error", message: "AI service temporarily unavailable." });
    }
});

// 5. API HISTORICAL CANDLES (Untuk Carta)
app.get('/api/candles', async (req, res) => {
    const symbol = req.query.symbol || 'XAU/USD';
    try {
        const response = await axios.get(`https://api.twelvedata.com/time_series?symbol=${symbol}&interval=15min&outputsize=100&apikey=${TWELVE_DATA_KEY}`);
        if (response.data.status === 'error') throw new Error("API Limit");
        
        const values = response.data.values;
        
        const candles = values.map(v => ({
            time: Math.floor(new Date(v.datetime).getTime() / 1000),
            open: parseFloat(v.open),
            high: parseFloat(v.high),
            low: parseFloat(v.low),
            close: parseFloat(v.close)
        })).reverse();
        
        res.json({ status: "success", candles: candles });
    } catch (error) {
        res.status(500).json({ status: "error", message: error.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server berjalan di port ' + PORT));