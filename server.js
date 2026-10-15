// ===============================================
// BPT — Borneo Pro Trade v3.8.4 FINAL
// EMA Ribbon · Signal Ringkas · 12-Jam
// SNR DIBUANG · TP/SL ATR · Anti-repaint
// EA: Hantar candle + volume dari MT4
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

// CONFIG — JANGAN UBAH
const TWELVEDATA_URL = 'https://api.twelvedata.com';
const BIQUOTE_URL = 'https://biquote.io/api';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
const GEMINI_MODEL = 'gemini-flash-latest';

const MIN_CONFIDENCE = 70;
const EMA_RETEST_ATR = 0.5;
const EMA_OVEREXTEND_ATR = 3.0;
const SPREAD_LIMIT = { 'XAU/USD': 0.80, 'XAG/USD': 0.05, 'EUR/USD': 0.00025, 'GBP/USD': 0.00035, 'USD/JPY': 0.025, 'DEFAULT': 0.0010 };
const TWELVEDATA_KEYS = [process.env.TWELVEDATA_API_KEY||'',process.env.TWELVEDATA_API_KEY_2||'',process.env.TWELVEDATA_API_KEY_3||''].filter(k=>k.length>0);
let currentKeyIndex=0;
function getCurrentKey(){return TWELVEDATA_KEYS[currentKeyIndex]||TWELVEDATA_KEYS[0]||''}
function switchKey(){if(TWELVEDATA_KEYS.length>1)currentKeyIndex=(currentKeyIndex+1)%TWELVEDATA_KEYS.length}

console.log('╔══════════════════════════════════════╗');
console.log('║ BPT — BORNEO PRO TRADE v3.8.4 FINAL ║');
console.log('║ EMA Ribbon · Ringkas · 12-Jam        ║');
console.log('╚══════════════════════════════════════╝');

const DATA_DIR=path.join(__dirname,'data');
if(!fs.existsSync(DATA_DIR))fs.mkdirSync(DATA_DIR);
const FILES={mappings:path.join(DATA_DIR,'mappings.json'),history:path.join(DATA_DIR,'history.json'),trades:path.join(DATA_DIR,'trades.json'),signalHistory:path.join(DATA_DIR,'signal-history.json')};
let aiMappings={ASIA:null,LONDON:null,'NEW YORK':null,lastUpdate:0};
let newsCache={events:[],fetchedAt:0};
const NEWS_CACHE_MS=10*60*1000;
let messageHistory=[],signalHistory=[],tradeHistory=[];

const signalAlertState = new Map();

function loadJSON(file,def){try{if(fs.existsSync(file))return JSON.parse(fs.readFileSync(file,'utf8'))}catch(e){}return def}
function saveJSON(file,data){try{fs.writeFileSync(file,JSON.stringify(data,null,2))}catch(e){}}
function loadAllData(){aiMappings=loadJSON(FILES.mappings,{ASIA:null,LONDON:null,'NEW YORK':null,lastUpdate:0});messageHistory=loadJSON(FILES.history,[]);signalHistory=loadJSON(FILES.signalHistory,[]);tradeHistory=loadJSON(FILES.trades,[])}
function saveMappings(){saveJSON(FILES.mappings,aiMappings)} function saveHistory(){saveJSON(FILES.history,messageHistory.slice(0,100))} function saveSignalHistory(){saveJSON(FILES.signalHistory,signalHistory.slice(0,200))} function saveTradeHistory(){saveJSON(FILES.trades,tradeHistory.slice(0,200))}
loadAllData();

// ===============================================
// EA BRIDGE — JANGAN SENTUH
// ===============================================
let eaStatus={online:false,lastSeen:0,balance:0,equity:0,margin:0,freeMargin:0,profit:0,positions:[],prices:{},candles:{},accountNumber:'',broker:'',leverage:0,currency:'USD'};
let tradeQueue=[];

function parseEAJson(rawText){
  try{
    if(typeof rawText === 'object' && rawText !== null) return rawText;
    let raw = (rawText||'').toString().replace(/\x00/g,'').replace(/^\uFEFF/,'').trim();
    if(!raw) return {};
    const firstBrace = raw.indexOf('{');
    if(firstBrace > 0) raw = raw.substring(firstBrace);
    if(raw.includes('}{')) raw = raw.split('}{')[0] + '}';
    let depth=0,start=-1,first=null;
    for(let i=0;i<raw.length;i++){
      if(raw[i]==='{'){if(depth===0)start=i;depth++;}
      else if(raw[i]==='}'){depth--;if(depth===0&&start!==-1){first=raw.substring(start,i+1);break;}}
    }
    if(first)raw=first;
    return JSON.parse(raw);
  }catch(e){ return {}; }
}

app.post('/api/ea/heartbeat', express.text({type:'*/*', limit:'20mb'}), (req, res) => {
  const b = parseEAJson(req.body);
  eaStatus = {
    online: true, lastSeen: Date.now(),
    balance: parseFloat(b.balance ?? b.Balance ?? b.bal ?? 0),
    equity: parseFloat(b.equity ?? b.Equity ?? b.eq ?? 0),
    margin: parseFloat(b.margin ?? b.Margin ?? 0),
    freeMargin: parseFloat(b.freeMargin ?? b.FreeMargin ?? b.free_margin ?? 0),
    profit: parseFloat(b.profit ?? b.Profit ?? b.floatingPL ?? b.pl ?? 0),
    positions: b.positions || b.Positions || [],
    prices: b.prices || b.Prices || {},
    candles: b.candles || b.Candles || eaStatus.candles || {},
    accountNumber: String(b.accountNumber || b.account || b.AccountNumber || b.login || ''),
    broker: String(b.broker || b.brokerName || b.Broker || ''),
    leverage: b.leverage || b.Leverage || 0,
    currency: b.currency || b.Currency || 'USD'
  };
  res.json({status:'OK'});
});

// ===============================================
// EA CANDLES — terima candle push dari MT4
// ===============================================
app.post('/api/ea/candles', express.text({type:'*/*', limit:'20mb'}), (req, res) => {
  try {
    const b = parseEAJson(req.body);
    if (b.candles && typeof b.candles === 'object') {
      if (!eaStatus.candles) eaStatus.candles = {};
      Object.assign(eaStatus.candles, b.candles);
      const keys = Object.keys(b.candles);
      console.log('📊 [EA CANDLES] Diterima ' + keys.length + ' TF: ' + keys.join(', '));
    }
    res.json({status:'OK'});
  } catch (e) {
    console.log('❌ [EA CANDLES] Error:', e.message);
    res.status(500).json({error: e.message});
  }
});

app.get('/api/ea/status',(req,res)=>{const on=(Date.now()-eaStatus.lastSeen)<30000;res.json({...eaStatus,online:on,secondsAgo:on?Math.round((Date.now()-eaStatus.lastSeen)/1000):null})});
app.get('/api/ea/commands',(req,res)=>{const p=tradeQueue.filter(c=>c.status==='pending');if(p.length>0){p[0].status='sent';p[0].sentAt=Date.now();res.json({command:p[0]})}else res.json({command:null})});
app.post('/api/ea/result',express.text({type:'*/*'}),(req,res)=>{const b=parseEAJson(req.body);const c=tradeQueue.find(x=>x.id===b.id);if(c){c.status=b.success?'executed':'failed';c.ticket=b.ticket;c.error=b.error||'';tradeHistory.push({...c});if(tradeHistory.length>200)tradeHistory.shift();saveTradeHistory()}res.json({status:'OK'})});

app.use(express.json({ strict: false, limit: '5mb' }));

app.post('/api/ea/execute',(req,res)=>{const b=req.body;if(!b.symbol||!b.action||!b.lot)return res.status(400).json({error:'Missing'});const cmd={id:Date.now()+Math.floor(Math.random()*1000),symbol:b.symbol,action:b.action,lot:parseFloat(b.lot),sl:parseFloat(b.sl||0),tp:parseFloat(b.tp||0),timestamp:Date.now(),status:'pending'};tradeQueue.push(cmd);res.json({status:'OK',id:cmd.id})});

// ===============================================
// SESSION + HELPERS
// ===============================================
function getMarketSession(){
  const nowMYT=new Date(Date.now()+8*60*60*1000);
  const dayOfWeek=nowMYT.getUTCDay();
  if(dayOfWeek===0||dayOfWeek===6)return 'CLOSED';
  const h=nowMYT.getUTCHours();
  if(h>=7&&h<15)return 'ASIA';
  if(h>=15&&h<20)return 'LONDON';
  if(h>=20||h<5)return 'NEW YORK';
  if(h>=5&&h<7)return 'ASIA';
  return 'CLOSED';
}
function getSessionStatus(s){if(s==='LONDON'||s==='NEW YORK')return '🟢 PRIME';if(s==='ASIA')return '🟡 SLOW';return '🔴 CLOSED'}

function format12Hour(date){
  let h = date.getUTCHours();
  const m = date.getUTCMinutes().toString().padStart(2, '0');
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12;
  if (h === 0) h = 12;
  return `${h}:${m} ${ampm}`;
}

const symbolMap={'XAU/USD':'XAU/USD','XAG/USD':'XAG/USD','EUR/USD':'EUR/USD','GBP/USD':'GBP/USD','USD/JPY':'USD/JPY','AUD/USD':'AUD/USD','USD/CAD':'USD/CAD','USD/CHF':'USD/CHF'};
function toTwelveData(s){return symbolMap[s]||s}
function getDecimal(s){if(s.indexOf('JPY')>=0)return 3;if(s.indexOf('XAU')>=0||s.indexOf('XAG')>=0)return 2;return 5}
function getSpreadLimit(s){return SPREAD_LIMIT[s]||SPREAD_LIMIT['DEFAULT']}
function calculateEMA(closes,period){if(closes.length===0)return 0;let e=closes[0];let k=2/(period+1);for(let i=1;i<closes.length;i++)e=(closes[i]*k)+(e*(1-k));return e}
function calculateATR(candles,period){period=period||14;if(candles.length<period+1)return 0;let trs=[];for(let i=candles.length-period;i<candles.length;i++){const h=candles[i].high,l=candles[i].low,pc=candles[i-1].close;trs.push(Math.max(h-l,Math.abs(h-pc),Math.abs(l-pc)))}return trs.reduce((a,b)=>a+b,0)/period}
function calculateRSI(candles, period) {period = period || 14;if (candles.length < period + 1) return 0;let gains = 0, losses = 0;const start = candles.length - period;for (let i = start; i < candles.length; i++) {const diff = candles[i].close - candles[i-1].close;if (diff > 0) gains += diff;else losses -= diff;}const avgGain = gains / period;const avgLoss = losses / period;if (avgLoss === 0) return 100;const rs = avgGain / avgLoss;return 100 - (100 / (1 + rs));}
function calculateSuperTrend(candles, period, multiplier) {period = period || 10;multiplier = multiplier || 3.0;if (candles.length < period + 1) return { trend: 'UNKNOWN', value: 0 };const atr = calculateATR(candles, period);if (atr <= 0) return { trend: 'UNKNOWN', value: 0 };const lastCandle = candles[candles.length - 1];const lastClose = lastCandle.close;const hl2 = (lastCandle.high + lastCandle.low) / 2;const upperBand = hl2 + (multiplier * atr);const lowerBand = hl2 - (multiplier * atr);let trend, value;if (lastClose > upperBand) {trend = 'BULLISH'; value = lowerBand;} else if (lastClose < lowerBand) {trend = 'BEARISH'; value = upperBand;} else {const closes = candles.map(c => c.close);const ema21 = calculateEMA(closes, 21);trend = lastClose > ema21 ? 'BULLISH' : 'BEARISH';value = trend === 'BULLISH' ? lowerBand : upperBand;}return { trend, value };}
function calculateEMADistance(candles) {if (candles.length < 21) return { distance: 0, strength: 'WEAK' };const closes = candles.map(c => c.close);const ema9 = calculateEMA(closes, 9);const ema21 = calculateEMA(closes, 21);const distance = Math.abs(ema9 - ema21);let strength = 'WEAK';if (distance >= 5) strength = 'STRONG';else if (distance >= 2) strength = 'MEDIUM';return { distance: parseFloat(distance.toFixed(2)), strength };}

function detectFVG(candles) {
  if (!candles || candles.length < 5) return [];
  const fvgs = [];
  const recent = candles.slice(-50);
  for (let i = 2; i < recent.length; i++) {
    const c1 = recent[i - 2];
    const c3 = recent[i];
    if (c1.high < c3.low) {
      const fvg = { type: 'BULLISH', top: c3.low, bottom: c1.high, mid: (c3.low + c1.high) / 2, index: i };
      const mitigated = recent.slice(i + 1).some(c => c.low <= fvg.bottom);
      if (!mitigated) fvgs.push(fvg);
    }
    if (c1.low > c3.high) {
      const fvg = { type: 'BEARISH', top: c1.low, bottom: c3.high, mid: (c1.low + c3.high) / 2, index: i };
      const mitigated = recent.slice(i + 1).some(c => c.high >= fvg.top);
      if (!mitigated) fvgs.push(fvg);
    }
  }
  return fvgs;
}

function detectPOC(candles) {
  if (!candles || candles.length < 50) return null;
  const recent = candles.slice(-100);
  const lastPrice = recent[recent.length - 1].close;
  const bucketSize = lastPrice * 0.0005;
  if (bucketSize <= 0) return null;
  const buckets = {};
  recent.forEach(c => {
    const bucket = Math.round(c.close / bucketSize) * bucketSize;
    buckets[bucket] = (buckets[bucket] || 0) + 1;
  });
  let maxCount = 0, pocLevel = null;
  for (const [level, count] of Object.entries(buckets)) {
    if (count > maxCount) { maxCount = count; pocLevel = parseFloat(level); }
  }
  return pocLevel;
}

function getATRProfile(candles){const atrNow=calculateATR(candles,14),atrAvg=calculateATR(candles,50);if(atrAvg===0||atrNow===0)return {atrNow:0,ratio:1,level:'NORMAL',tp1Mult:3.0,tp2Mult:6.0,tp3Mult:10.0};const ratio=atrNow/atrAvg;let level,tp1Mult,tp2Mult,tp3Mult;if(ratio>=1.5){level='VOLATILE';tp1Mult=5.0;tp2Mult=10.0;tp3Mult=15.0}else if(ratio>=1.0){level='NORMAL';tp1Mult=3.0;tp2Mult=6.0;tp3Mult=10.0}else if(ratio>=0.7){level='SLOW';tp1Mult=2.0;tp2Mult=4.0;tp3Mult=6.0}else{level='VERY_SLOW';tp1Mult=1.5;tp2Mult=3.0;tp3Mult=4.5}return{atrNow,atrAvg,ratio,level,tp1Mult,tp2Mult,tp3Mult}}

function detectLiquidity(candles){if(!candles||candles.length<100)return null;const recent=candles.slice(-300);const yesterdayCandles=recent.slice(-288,-50);const asiaCandles=recent.slice(-96,-20);const londonCandles=recent.slice(-60);const yesterdayHigh=yesterdayCandles.length?Math.max(...yesterdayCandles.map(c=>c.high)):0;const yesterdayLow=yesterdayCandles.length?Math.min(...yesterdayCandles.map(c=>c.low)):0;const asiaHigh=asiaCandles.length?Math.max(...asiaCandles.map(c=>c.high)):0;const asiaLow=asiaCandles.length?Math.min(...asiaCandles.map(c=>c.low)):0;const londonHigh=londonCandles.length?Math.max(...londonCandles.map(c=>c.high)):0;const londonLow=londonCandles.length?Math.min(...londonCandles.map(c=>c.low)):0;const lastCandle=recent[recent.length-1];let sweep=null;if(lastCandle.high>yesterdayHigh&&lastCandle.close<yesterdayHigh)sweep={type:'SWEEP_HIGH',level:yesterdayHigh,source:'YESTERDAY_HIGH',bias:'SELL'};else if(lastCandle.high>asiaHigh&&lastCandle.close<asiaHigh)sweep={type:'SWEEP_HIGH',level:asiaHigh,source:'ASIA_HIGH',bias:'SELL'};else if(lastCandle.low<yesterdayLow&&lastCandle.close>yesterdayLow)sweep={type:'SWEEP_LOW',level:yesterdayLow,source:'YESTERDAY_LOW',bias:'BUY'};else if(lastCandle.low<asiaLow&&lastCandle.close>asiaLow)sweep={type:'SWEEP_LOW',level:asiaLow,source:'ASIA_LOW',bias:'BUY'};return{yesterdayHigh,yesterdayLow,asiaHigh,asiaLow,londonHigh,londonLow,sweep,currentPrice:recent[recent.length-1].close}}

// ===============================================
// EMA RIBBON DETECTOR — ganti SNR
// ===============================================
function detectEMARibbon(candles, atr) {
  if (!candles || candles.length < 50) return null;

  const closes = candles.map(c => c.close);
  const lastCandle = candles[candles.length - 1];
  const price = lastCandle.close;

  const ema9  = calculateEMA(closes, 9);
  const ema21 = calculateEMA(closes, 21);
  const ema50 = calculateEMA(closes, 50);

  const emaMin = Math.min(ema9, ema21, ema50);
  const emaMax = Math.max(ema9, ema21, ema50);
  const ribbonWidth = emaMax - emaMin;

  let trend = 'NONE';
  if (ema9 > ema21 && ema21 > ema50) trend = 'BULLISH';
  else if (ema9 < ema21 && ema21 < ema50) trend = 'BEARISH';

  let pos = 'IN_RIBBON';
  if (price > emaMax) pos = 'ABOVE';
  else if (price < emaMin) pos = 'BELOW';

  let distToRibbon = 0;
  if (pos === 'ABOVE') distToRibbon = price - emaMax;
  else if (pos === 'BELOW') distToRibbon = emaMin - price;

  const overextended = distToRibbon > atr * EMA_OVEREXTEND_ATR;
  const inRetestZone = distToRibbon <= atr * EMA_RETEST_ATR;

  const body = Math.abs(lastCandle.close - lastCandle.open);
  const upperWick = lastCandle.high - Math.max(lastCandle.open, lastCandle.close);
  const lowerWick = Math.min(lastCandle.open, lastCandle.close) - lastCandle.low;

  const bullReject = lowerWick > body * 1.5 && lastCandle.close > lastCandle.open;
  const bearReject = upperWick > body * 1.5 && lastCandle.close < lastCandle.open;

  let status = 'WAIT', bias = 'WAIT', confidence = 0, reason = '';

  if (trend === 'NONE') {
    status = 'NO_TREND';
    reason = 'EMA bercampur — tunggu align';
  } else if (overextended) {
    status = 'OVEREXTENDED';
    reason = `Harga ${distToRibbon.toFixed(2)} pts dari ribbon — tunggu pullback`;
  } else if (trend === 'BULLISH' && inRetestZone && bullReject) {
    status = 'BUY_SETUP';
    bias = 'BUY';
    confidence = 80;
    reason = 'EMA ribbon retest + bullish rejection';
  } else if (trend === 'BEARISH' && inRetestZone && bearReject) {
    status = 'SELL_SETUP';
    bias = 'SELL';
    confidence = 80;
    reason = 'EMA ribbon retest + bearish rejection';
  } else if (inRetestZone) {
    status = 'RETEST_ZONE';
    reason = `Harga di ribbon (${trend}) — tunggu rejection candle`;
  } else {
    status = 'WAIT_PULLBACK';
    reason = `Harga ${distToRibbon.toFixed(2)} pts dari ribbon — tunggu retest`;
  }

  return {
    trend, pos, status, bias, confidence, reason,
    ema9, ema21, ema50,
    ribbonTop: emaMax,
    ribbonBot: emaMin,
    ribbonWidth,
    distToRibbon,
    overextended,
    inRetestZone,
    rejection: bullReject ? 'BULL' : bearReject ? 'BEAR' : 'NONE'
  };
}

// ===============================================
// SL/TP — ATR dengan validasi arah
// ===============================================
function validateDirection(bias, entry, sl, tp1, tp2, tp3) {
  if (!entry || !sl || !tp1) return { valid: false, reason: 'Missing SL/TP' };
  if (bias === 'BUY') {
    if (sl >= entry) return { valid: false, reason: `BUY: SL >= Entry` };
    if (tp1 <= entry) return { valid: false, reason: `BUY: TP1 <= Entry` };
    if (tp2 <= tp1) return { valid: false, reason: `BUY: TP2 <= TP1` };
  } else if (bias === 'SELL') {
    if (sl <= entry) return { valid: false, reason: `SELL: SL <= Entry` };
    if (tp1 >= entry) return { valid: false, reason: `SELL: TP1 >= Entry` };
    if (tp2 >= tp1) return { valid: false, reason: `SELL: TP2 >= TP1` };
  }
  return { valid: true };
}

function calculateSLTP(dir, entry, atr, symbol, atrProfile) {
  if (!entry || !atr || atr <= 0) return null;
  const slDist = atr * 1.5;
  let tp1Mult = 3.0, tp2Mult = 6.0, tp3Mult = 10.0;
  if (atrProfile) {
    tp1Mult = atrProfile.tp1Mult;
    tp2Mult = atrProfile.tp2Mult;
    tp3Mult = atrProfile.tp3Mult;
  }
  const dec = getDecimal(symbol);
  let sl, tp1, tp2, tp3;
  if (dir === 'BUY') {
    sl = entry - slDist;
    tp1 = entry + atr * tp1Mult;
    tp2 = entry + atr * tp2Mult;
    tp3 = entry + atr * tp3Mult;
  } else {
    sl = entry + slDist;
    tp1 = entry - atr * tp1Mult;
    tp2 = entry - atr * tp2Mult;
    tp3 = entry - atr * tp3Mult;
  }
  const result = {
    sl: parseFloat(sl.toFixed(dec)),
    tp1: parseFloat(tp1.toFixed(dec)),
    tp2: parseFloat(tp2.toFixed(dec)),
    tp3: parseFloat(tp3.toFixed(dec))
  };
  const check = validateDirection(dir, parseFloat(entry.toFixed(dec)), result.sl, result.tp1, result.tp2, result.tp3);
  if (!check.valid) {
    console.log(`❌ [SLTP] Invalid direction: ${check.reason}`);
    return null;
  }
  return result;
}

// ===============================================
// TELEGRAM
// ===============================================
async function sendTelegram(message){
  if(!TELEGRAM_BOT_TOKEN||!TELEGRAM_CHAT_ID){console.log('⚠️ [TELEGRAM] Token/ChatID kosong');return false;}
  for(let i=0;i<3;i++){
    try{
      const r=await axios.post('https://api.telegram.org/bot'+TELEGRAM_BOT_TOKEN+'/sendMessage',{chat_id:TELEGRAM_CHAT_ID,text:message,parse_mode:'HTML'},{timeout:15000});
      console.log('📱 [TELEGRAM] Sent OK — msg_id:',r.data?.result?.message_id);
      return true;
    }catch(e){
      console.log(`❌ [TELEGRAM] Retry ${i+1}: ${e.message}`);
      if(i<2)await new Promise(r=>setTimeout(r,2000*Math.pow(2,i)));
    }
  }
  return false;
}

// ===============================================
// TICK + OHLC
// ===============================================
const tickCache=new Map();
function toEASymbol(symbol){const base=symbol.replace('/','');const suffixes=['.vxx','.vx','','m','.','c','pro','ecn','raw'];if(eaStatus.prices){for(let s of suffixes){if(eaStatus.prices[base+s])return base+s}}return base}

async function getTick(symbol){
  const isEAOnline=(Date.now()-eaStatus.lastSeen)<30000;
  if(isEAOnline&&eaStatus.prices){
    const eaSymbol=toEASymbol(symbol);
    const p=eaStatus.prices[eaSymbol];
    if(p){
      const bid=parseFloat(p.bid||p.price||0),ask=parseFloat(p.ask||0),mid=bid?(ask?(bid+ask)/2:bid):0;
      if(mid>0)return{bid,ask:ask||bid,mid,spread:ask?ask-bid:0,source:'MT4'}
    }
  }
  const cached=tickCache.get(symbol);
  if(cached&&Date.now()-cached.time<30000)return cached.data;
  const tdSymbol=toTwelveData(symbol);
  let attempts=0,maxAttempts=TWELVEDATA_KEYS.length*2||2;
  while(attempts<maxAttempts){
    attempts++;
    try{
      const url=TWELVEDATA_URL+'/quote?symbol='+encodeURIComponent(tdSymbol)+'&apikey='+getCurrentKey();
      const r=await axios.get(url,{timeout:10000});
      const d=r.data;
      if(d.status==='error'||d.code){if(d.code===429){switchKey();continue}throw new Error(d.message||'API error')}
      const bid=parseFloat(d.bid||0),ask=parseFloat(d.ask||0),price=parseFloat(d.close||d.price||0),mid=price||(bid+ask)/2||0;
      if(mid===0)throw new Error('Harga 0');
      const result={bid:bid||mid,ask:ask||mid,mid,spread:parseFloat(d.spread||(ask-bid)||0),source:'TWELVEDATA'};
      tickCache.set(symbol,{data:result,time:Date.now()});
      return result
    }catch(e){
      const msg = e && e.message ? e.message : String(e);
      const isRateLimit = msg.includes('429') || msg.toLowerCase().includes('rate limit') || msg.toLowerCase().includes('too many');
      console.log(`❌ [TICK] ${symbol} attempt ${attempts}/${maxAttempts} fail: ${msg} ${isRateLimit ? '(RATE LIMIT -> switch key)' : ''}`);
      if(isRateLimit){ switchKey(); console.log(`🔑 [TICK] Switched to key index ${currentKeyIndex}`); continue; }
      if(attempts>=maxAttempts) throw e;
    }
  }
  throw new Error('API gagal')
}

const ohlcCache=new Map();

async function getOHLC(symbol, interval, limit) {
  interval = interval || '30min';
  limit = limit || 300;
  const cacheKey = symbol + '_' + interval + '_' + limit;
  const cached = ohlcCache.get(cacheKey);
  if (cached && Date.now() - cached.time < 180000) return cached.data;

  // === CUBA MT4 DULU ===
  const isEAOnline = (Date.now() - eaStatus.lastSeen) < 30000;
  if (isEAOnline && eaStatus.candles) {
    const eaSymbol = toEASymbol(symbol);
    const tfMap = { '5min': 'M5', '15min': 'M15', '30min': 'M30', '1h': 'H1', '4h': 'H4' };
    const key = eaSymbol + '_' + (tfMap[interval] || 'M30');
    const candles = eaStatus.candles[key];
    if (candles && Array.isArray(candles) && candles.length >= 50) {
      console.log(`📊 [OHLC] ${symbol} ${interval} — MT4 (${candles.length} candle)`);
      const result = candles.map(c => ({
        open: parseFloat(c.open || 0),
        high: parseFloat(c.high || 0),
        low: parseFloat(c.low || 0),
        close: parseFloat(c.close || 0),
        volume: parseFloat(c.volume || 0)
      })).filter(c => c.close > 0);
      ohlcCache.set(cacheKey, { data: result, time: Date.now() });
      return result;
    }
  }

  // === FALLBACK TWELVEDATA ===
  console.log(`⚠️ [OHLC] ${symbol} ${interval} — TwelveData (MT4 takde)`);
  const tdSymbol = toTwelveData(symbol);
  let attempts = 0, maxAttempts = TWELVEDATA_KEYS.length * 2 || 2;
  while (attempts < maxAttempts) {
    attempts++;
    try {
      const url = TWELVEDATA_URL + '/time_series?symbol=' + encodeURIComponent(tdSymbol) + '&interval=' + interval + '&outputsize=' + limit + '&apikey=' + getCurrentKey();
      const r = await axios.get(url, { timeout: 10000 });
      const d = r.data;
      if (d.status === 'error' || d.code) {
        if (d.code === 429) { switchKey(); continue; }
        throw new Error(d.message);
      }
      if (!d.values || !Array.isArray(d.values)) return [];
      const result = d.values.slice().reverse().map(c => ({
        open: parseFloat(c.open || 0),
        high: parseFloat(c.high || 0),
        low: parseFloat(c.low || 0),
        close: parseFloat(c.close || 0),
        volume: parseFloat(c.volume || 0)
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

function isSpreadOK(s,spread){return spread>0&&spread<=getSpreadLimit(s)}
async function fetchNews(){if(Date.now()-newsCache.fetchedAt<NEWS_CACHE_MS&&newsCache.events.length>0)return newsCache.events;try{const r=await axios.get(BIQUOTE_URL+'/calendar',{timeout:10000}).catch(()=>({data:{events:[]}}));let events=r.data.events||r.data.data||r.data.calendar||(Array.isArray(r.data)?r.data:[]);if(!Array.isArray(events))events=[];const usdEvents=events.filter(e=>String(e.currency||e.country||'').toUpperCase()==='USD'||String(e.currency||'').toUpperCase()==='US').slice(0,30).map(e=>({time:String(e.time||e.date||''),currency:'USD',impact:String(e.impact||'medium').toLowerCase(),event:String(e.event||e.title||''),actual:String(e.actual||'-'),forecast:String(e.forecast||'-'),previous:String(e.previous||'-')}));newsCache.events=usdEvents;newsCache.fetchedAt=Date.now();return usdEvents}catch(e){return[]}}

// ===============================================
// SIGNAL LOGIC (dikongsi oleh /api/signal + mapping)
// ===============================================
async function computeSignal(symbol) {
  const decimal = getDecimal(symbol);
  const tick = await getTick(symbol);
  const tickHarga = tick.mid;
  if (!tickHarga || tickHarga <= 0) return { error: 'No price data' };

  const candlesM30All = await getOHLC(symbol, '30min', 200);
  const candlesM15All = await getOHLC(symbol, '15min', 200);
  const candlesH1All = await getOHLC(symbol, '1h', 200);
  const candlesH4All = await getOHLC(symbol, '4h', 100);

  const candlesM30 = candlesM30All.length > 1 ? candlesM30All.slice(0, -1) : candlesM30All;
  const candlesM15 = candlesM15All.length > 1 ? candlesM15All.slice(0, -1) : candlesM15All;
  const candlesH1 = candlesH1All.length > 1 ? candlesH1All.slice(0, -1) : candlesH1All;
  const candlesH4 = candlesH4All.length > 1 ? candlesH4All.slice(0, -1) : candlesH4All;

  if (candlesM30.length < 50) return { error: 'Candles tak cukup', tick, decimal };

  const atr = calculateATR(candlesM30, 14);
  const atrProfile = getATRProfile(candlesM30);
  const rsi = calculateRSI(candlesM30, 14);
  const superTrend = calculateSuperTrend(candlesM30, 10, 3.0);
  const emaDistance = calculateEMADistance(candlesM30);
  const fvgs = detectFVG(candlesM30);
  const poc = detectPOC(candlesM30);

  const emaRibbon = detectEMARibbon(candlesM30, atr);

  let rsiStatus = 'NEUTRAL';
  if (rsi < 30) rsiStatus = 'OVERSOLD';
  else if (rsi > 70) rsiStatus = 'OVERBOUGHT';

  return {
    tick, tickHarga, decimal, atr, atrProfile, rsi, rsiStatus,
    superTrend, emaDistance, fvgs, poc, emaRibbon,
    candlesM15, candlesH1, candlesH4
  };
}

// ===============================================
// MAPPING — v3.8.4
// ===============================================
async function generateSessionMapping(symbol, sessionName) {
  try {
    const d = await computeSignal(symbol);
    if (d.error) { console.log(`❌ [${sessionName}] ${d.error}`); return; }

    const decimal = d.decimal;
    const tickHarga = d.tickHarga;
    const ema = d.emaRibbon;

    const nowMYT = new Date(Date.now() + 8 * 60 * 60 * 1000);
    const timeStr = format12Hour(nowMYT);
    const dayName = ['Ahad','Isnin','Selasa','Rabu','Khamis','Jumaat','Sabtu'][nowMYT.getUTCDay()];
    const dateStr = nowMYT.toISOString().split('T')[0];

    let bias = 'WAIT', confidence = 0, entryNum = null, status = 'WAIT';
    let slNum = null, tp1Num = null, tp2Num = null, tp3Num = null;

    if (ema && (ema.status === 'BUY_SETUP' || ema.status === 'SELL_SETUP')) {
      bias = ema.bias;
      confidence = ema.confidence;
      entryNum = tickHarga;
      status = ema.status;

      const sltp = calculateSLTP(bias, entryNum, d.atr, symbol, d.atrProfile);
      if (sltp) {
        slNum = sltp.sl; tp1Num = sltp.tp1; tp2Num = sltp.tp2; tp3Num = sltp.tp3;
      } else {
        console.log(`⏸️ [${sessionName}] SL/TP invalid — skip hantar`);
        return;
      }
    } else {
      status = ema ? ema.status : 'NO_DATA';
      console.log(`⏸️ [${sessionName}] ${status} — hantar nota WAIT`);
    }

    const sessionEmoji = sessionName === 'LONDON' ? '🇬🇧' : sessionName === 'NEW YORK' ? '🇺🇸' : '🇯🇵';
    let msg;
    if (bias === 'BUY') {
      msg = `📈 <b>${symbol} — BUY (${confidence}%)</b>\n\nEntry: <b>${entryNum.toFixed(decimal)}</b>\nSL:    <b>${slNum.toFixed(decimal)}</b>\nTP1:   <b>${tp1Num.toFixed(decimal)}</b>\nTP2:   <b>${tp2Num.toFixed(decimal)}</b>\nTP3:   <b>${tp3Num.toFixed(decimal)}</b>\n\n⏰ ${timeStr} MYT · ${sessionName}`;
    } else if (bias === 'SELL') {
      msg = `📉 <b>${symbol} — SELL (${confidence}%)</b>\n\nEntry: <b>${entryNum.toFixed(decimal)}</b>\nSL:    <b>${slNum.toFixed(decimal)}</b>\nTP1:   <b>${tp1Num.toFixed(decimal)}</b>\nTP2:   <b>${tp2Num.toFixed(decimal)}</b>\nTP3:   <b>${tp3Num.toFixed(decimal)}</b>\n\n⏰ ${timeStr} MYT · ${sessionName}`;
    } else {
      msg = `⏳ <b>${symbol} — WAIT</b>\n\nHarga: ${tickHarga.toFixed(decimal)}\nStatus: ${status}\n\n⏰ ${timeStr} MYT · ${sessionName}`;
    }

    console.log(`🔍 [${sessionName}] Hantar mapping...`);
    const sent = await sendTelegram(msg);
    console.log(`🔍 [${sessionName}] Telegram: ${sent}`);

    aiMappings[sessionName] = {
      session: sessionName, timeStr, dateStr, dayName, symbol,
      harga: parseFloat(tickHarga.toFixed(decimal)),
      harga_source: d.tick.source,
      bias, confidence, status,
      entry: entryNum ? parseFloat(entryNum.toFixed(decimal)) : null,
      sl: slNum, tp1: tp1Num, tp2: tp2Num, tp3: tp3Num,
      ema: ema ? {
        trend: ema.trend, ema9: parseFloat(ema.ema9.toFixed(decimal)),
        ema21: parseFloat(ema.ema21.toFixed(decimal)), ema50: parseFloat(ema.ema50.toFixed(decimal)),
        ribbonTop: parseFloat(ema.ribbonTop.toFixed(decimal)),
        ribbonBot: parseFloat(ema.ribbonBot.toFixed(decimal)),
        distToRibbon: parseFloat(ema.distToRibbon.toFixed(decimal)),
        rejection: ema.rejection
      } : null,
      atr: parseFloat(d.atr.toFixed(2)),
      telegram_msg: msg
    };
    aiMappings.lastUpdate = Date.now();
    saveMappings();

    messageHistory.unshift({
      id: Date.now(), type: 'mapping', timestamp: Date.now(),
      data: { session: sessionName, symbol, harga: tickHarga, bias, confidence, entry: entryNum, sl: slNum, tp1: tp1Num, tp2: tp2Num, tp3: tp3Num, telegram_msg: msg }
    });
    if (messageHistory.length > 100) messageHistory.pop();
    saveHistory();

    console.log(`✅ [${sessionName}] Selesai. ${bias} ${confidence}% (${status})`);
  } catch (e) {
    console.log(`❌ [${sessionName}] ERROR: ${e.message}`);
  }
}

// ===============================================
// SIGNAL ALERT
// ===============================================
async function sendSignalAlert(symbol, bias, confidence, entryNum, slNum, tp1Num, tp2Num, tp3Num, decimal) {
  const nowMYT = new Date(Date.now() + 8 * 60 * 60 * 1000);
  const timeStr = format12Hour(nowMYT);

  const msg = `🎯 <b>${symbol} — ${bias} (${confidence}%)</b>\n\nEntry: <b>${entryNum.toFixed(decimal)}</b>\nSL:    <b>${slNum.toFixed(decimal)}</b>\nTP1:   <b>${tp1Num.toFixed(decimal)}</b>\nTP2:   <b>${tp2Num.toFixed(decimal)}</b>\nTP3:   <b>${tp3Num.toFixed(decimal)}</b>\n\n⏰ ${timeStr} MYT`;

  await sendTelegram(msg);
}

app.get('/api/signal', async (req,res)=>{
  const symbol=req.query.symbol||'XAU/USD';
  const decimal=getDecimal(symbol);
  try{
    const d = await computeSignal(symbol);
    if (d.error) return res.status(503).json({error: d.error, signal: 'WAIT', score: 0});

    const ema = d.emaRibbon;
    const tickHarga = d.tickHarga;

    let bias = 'WAIT', confidence = 0, entryNum = null, status = ema ? ema.status : 'NO_DATA';
    let sltp = null;

    if (ema && (ema.status === 'BUY_SETUP' || ema.status === 'SELL_SETUP')) {
      bias = ema.bias;
      confidence = ema.confidence;
      entryNum = tickHarga;
      sltp = calculateSLTP(bias, entryNum, d.atr, symbol, d.atrProfile);
    }

    if ((bias === 'BUY' || bias === 'SELL') && sltp) {
      const lastState = signalAlertState.get(symbol);
      const lastBias = lastState?.bias || 'NONE';
      if (lastBias !== bias) {
        console.log(`📱 [SIGNAL ALERT] ${bias} ${confidence}% — ${lastBias} → ${bias}`);
        await sendSignalAlert(symbol, bias, confidence, entryNum, sltp.sl, sltp.tp1, sltp.tp2, sltp.tp3, decimal);
        signalAlertState.set(symbol, { bias, confidence, time: Date.now() });

        const resetTime = Date.now();
        setTimeout(() => {
          const s = signalAlertState.get(symbol);
          if (s && s.time === resetTime) {
            signalAlertState.set(symbol, { bias: 'WAIT', confidence: 0, time: Date.now() });
            console.log(`🔄 [SIGNAL] Reset state ${symbol} (expired 2h)`);
          }
        }, 2 * 60 * 60 * 1000);
      } else {
        console.log(`⏸️ [SIGNAL] Skip — ${bias} kekal`);
      }
    } else {
      const lastState = signalAlertState.get(symbol);
      if (lastState && lastState.bias !== 'WAIT') {
        console.log(`⏸️ [SIGNAL] WAIT — reset state`);
        signalAlertState.set(symbol, { bias: 'WAIT', confidence: 0, time: Date.now() });
      }
    }

    if (bias === 'WAIT') {
      return res.json({
        symbol,
        harga: parseFloat(tickHarga.toFixed(decimal)),
        harga_source: d.tick.source,
        signal: 'WAIT', score: 0, confidence: 0,
        entry: null, sl: null, tp1: null, tp2: null, tp3: null,
        status,
        ema: ema ? {
          trend: ema.trend,
          ema9: parseFloat(ema.ema9.toFixed(decimal)),
          ema21: parseFloat(ema.ema21.toFixed(decimal)),
          ema50: parseFloat(ema.ema50.toFixed(decimal)),
          ribbonTop: parseFloat(ema.ribbonTop.toFixed(decimal)),
          ribbonBot: parseFloat(ema.ribbonBot.toFixed(decimal)),
          distToRibbon: parseFloat(ema.distToRibbon.toFixed(decimal)),
          rejection: ema.rejection
        } : null,
        session: getMarketSession(),
        atr: parseFloat(d.atr.toFixed(2))
      });
    }

    res.json({
      symbol,
      harga: parseFloat(tickHarga.toFixed(decimal)),
      harga_source: d.tick.source,
      signal: bias,
      score: confidence,
      confidence,
      entry: parseFloat(entryNum.toFixed(decimal)),
      sl: sltp.sl, tp1: sltp.tp1, tp2: sltp.tp2, tp3: sltp.tp3,
      status,
      ema: ema ? {
        trend: ema.trend,
        ema9: parseFloat(ema.ema9.toFixed(decimal)),
        ema21: parseFloat(ema.ema21.toFixed(decimal)),
        ema50: parseFloat(ema.ema50.toFixed(decimal)),
        ribbonTop: parseFloat(ema.ribbonTop.toFixed(decimal)),
        ribbonBot: parseFloat(ema.ribbonBot.toFixed(decimal)),
        distToRibbon: parseFloat(ema.distToRibbon.toFixed(decimal)),
        rejection: ema.rejection
      } : null,
      session: getMarketSession(),
      atr: parseFloat(d.atr.toFixed(2))
    });
  }catch(e){
    console.log(`❌ [SIGNAL] ${symbol} error:`, e.message);
    res.status(500).json({error:e.message, signal:'WAIT', score:0});
  }
});

app.get('/api/mapping',(req,res)=>{res.json({status:'OK',mappings:aiMappings,current_session:getMarketSession(),timestamp:Date.now()})});
app.get('/api/market',async(req,res)=>{const symbol=req.query.symbol||'XAU/USD';const decimal=getDecimal(symbol);try{const tick=await getTick(symbol);const candlesAll=await getOHLC(symbol,'1h',200);const candles = candlesAll.length > 1 ? candlesAll.slice(0, -1) : candlesAll;const harga=tick.mid||(candles.length?candles[candles.length-1].close:0);if(!harga)return res.status(503).json({error:'No price data'});const liq=detectLiquidity(candles);res.json({symbol,harga:parseFloat(harga.toFixed(decimal)),harga_source:tick.source,spread:parseFloat(tick.spread.toFixed(decimal)),spread_ok:isSpreadOK(symbol,tick.spread),liquidity:liq,session:getMarketSession()})}catch(e){res.status(500).json({error:e.message})}});
app.get('/api/messages',(req,res)=>{const limit=parseInt(req.query.limit)||50;const type=req.query.type;let filtered=messageHistory;if(type&&type!=='all'){const types=type.split(',').map(t=>t.trim());filtered=messageHistory.filter(m=>types.includes(m.type))}const stats={signal:messageHistory.filter(m=>m.type==='signal').length,mapping:messageHistory.filter(m=>m.type==='mapping').length};res.json({status:'OK',messages:filtered.slice(0,limit),stats})});
app.get('/api/news',async(req,res)=>{const events=await fetchNews();res.json({status:'success',events})});

app.get('/api/check-volume', async (req, res) => {
  const symbol = req.query.symbol || 'XAU/USD';
  const candles = await getOHLC(symbol, '30min', 30);
  const withVol = candles.filter(c => c.volume > 0).length;
  res.json({
    symbol,
    total: candles.length,
    withVolume: withVol,
    sample: candles.slice(-5).map(c => ({ close: c.close, volume: c.volume })),
    source: (Date.now() - eaStatus.lastSeen) < 30000 && eaStatus.candles ? 'MT4' : 'TWELVEDATA'
  });
});

app.get('/api/health',(req,res)=>{res.json({status:'OK',version:'3.8.4',session:getMarketSession(),myt:new Date(Date.now()+8*60*60*1000).toISOString(),ea_online:(Date.now()-eaStatus.lastSeen)<30000,ea_has_candles:Object.keys(eaStatus.candles||{}).length>0,min_confidence:MIN_CONFIDENCE,ema_retest_atr:EMA_RETEST_ATR,ema_overextend_atr:EMA_OVEREXTEND_ATR,signal_alert_state:Array.from(signalAlertState.entries()).map(([k,v])=>({symbol:k,bias:v.bias,conf:v.confidence})),telegram_configured:!!(TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID)})});

// ===============================================
// SCHEDULER
// ===============================================
function shouldRunScheduler(){const nowMYT=new Date(Date.now()+8*60*60*1000);if(nowMYT.getUTCDay()===0||nowMYT.getUTCDay()===6)return false;return true}

setInterval(async()=>{
  if(!shouldRunScheduler())return;
  const nowMYT=new Date(Date.now()+8*60*60*1000);
  const h=nowMYT.getUTCHours(),m=nowMYT.getUTCMinutes();
  if(h===8&&m===0)await generateSessionMapping('XAU/USD','ASIA');
  if(h===15&&m===0)await generateSessionMapping('XAU/USD','LONDON');
  if(h===20&&m===0)await generateSessionMapping('XAU/USD','NEW YORK');
},60*1000);

// Auto signal update 30s
setInterval(async()=>{
  try{
    await axios.get('http://localhost:'+(process.env.PORT||3000)+'/api/signal?symbol=XAU/USD', {timeout:15000});
  }catch(e){}
}, 30*1000);

const PORT=process.env.PORT||3000;
app.listen(PORT,()=>{console.log(`🚀 BPT v3.8.4 running on ${PORT} | MYT: ${new Date(Date.now()+8*60*60*1000).toISOString()} | EMA Ribbon · M30 | Signal Alert: bias change only | Mapping: 3x/day`)});