// ===============================================
// BPT — Borneo Pro Trade v3.8.4 FINAL
// 4 Filter Signal · Asia Breakout + Telegram
// SNR Primary · H1 Fallback · Anti-repaint
// EA TIDAK DISENTUH
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
const SCORE_BOLEH = 65;
const MIN_CONFIDENCE = 70;
const SNR_CONFIDENCE = 75;
const SNR_PROXIMITY_MULT = 1.0;         // 🔧 v3.8.4: dari 1.5 ke 1.0
const MIN_ENTRY_DISTANCE = 3.0;         // 🔧 v3.8.4: minimum jarak entry
const ASIA_BREAKOUT_BODY_PCT = 0.60;    // 🔧 v3.8.4: body candle min
const ASIA_BREAKOUT_COOLDOWN_MS = 30 * 60 * 1000; // 🔧 30 min
const SPREAD_LIMIT = { 'XAU/USD': 0.80, 'XAG/USD': 0.05, 'EUR/USD': 0.00025, 'GBP/USD': 0.00035, 'USD/JPY': 0.025, 'DEFAULT': 0.0010 };
const TWELVEDATA_KEYS = [process.env.TWELVEDATA_API_KEY||'',process.env.TWELVEDATA_API_KEY_2||'',process.env.TWELVEDATA_API_KEY_3||''].filter(k=>k.length>0);
let currentKeyIndex=0;
function getCurrentKey(){return TWELVEDATA_KEYS[currentKeyIndex]||TWELVEDATA_KEYS[0]||''}
function switchKey(){if(TWELVEDATA_KEYS.length>1)currentKeyIndex=(currentKeyIndex+1)%TWELVEDATA_KEYS.length}

console.log('╔══════════════════════════════════════╗');
console.log('║ BPT — BORNEO PRO TRADE v3.8.4 FINAL ║');
console.log('║ 4 Filters · Asia Breakout · Telegram║');
console.log('╚══════════════════════════════════════╝');

const DATA_DIR=path.join(__dirname,'data');
if(!fs.existsSync(DATA_DIR))fs.mkdirSync(DATA_DIR);
const FILES={mappings:path.join(DATA_DIR,'mappings.json'),history:path.join(DATA_DIR,'history.json'),trades:path.join(DATA_DIR,'trades.json'),signalHistory:path.join(DATA_DIR,'signal-history.json'),asiaBreakouts:path.join(DATA_DIR,'asia-breakouts.json')};
let aiMappings={ASIA:null,LONDON:null,'NEW YORK':null,lastUpdate:0};
let newsCache={events:[],fetchedAt:0};
const NEWS_CACHE_MS=10*60*1000;
let messageHistory=[],signalHistory=[],tradeHistory=[];
let asiaBreakouts=[];
const levelAlertCooldown=new Map(),newsAlertCooldown=new Map(),liquidityCooldown=new Map();

const signalAlertState = new Map();
const asiaBreakoutCooldown = new Map();

function loadJSON(file,def){try{if(fs.existsSync(file))return JSON.parse(fs.readFileSync(file,'utf8'))}catch(e){}return def}
function saveJSON(file,data){try{fs.writeFileSync(file,JSON.stringify(data,null,2))}catch(e){}}
function loadAllData(){
  aiMappings=loadJSON(FILES.mappings,{ASIA:null,LONDON:null,'NEW YORK':null,lastUpdate:0});
  messageHistory=loadJSON(FILES.history,[]);
  signalHistory=loadJSON(FILES.signalHistory,[]);
  tradeHistory=loadJSON(FILES.trades,[]);
  asiaBreakouts=loadJSON(FILES.asiaBreakouts,[]);
}
function saveMappings(){saveJSON(FILES.mappings,aiMappings)}
function saveHistory(){saveJSON(FILES.history,messageHistory.slice(0,100))}
function saveSignalHistory(){saveJSON(FILES.signalHistory,signalHistory.slice(0,200))}
function saveTradeHistory(){saveJSON(FILES.trades,tradeHistory.slice(0,200))}
function saveAsiaBreakouts(){saveJSON(FILES.asiaBreakouts,asiaBreakouts.slice(0,100))}
loadAllData();

// ===============================================
// EA BRIDGE — JANGAN SENTUH
// ===============================================
let eaStatus={online:false,lastSeen:0,balance:0,equity:0,margin:0,freeMargin:0,profit:0,positions:[],prices:{},accountNumber:'',broker:'',leverage:0,currency:'USD'};
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

app.post('/api/ea/heartbeat', express.text({type:'*/*', limit:'10mb'}), (req, res) => {
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
    accountNumber: String(b.accountNumber || b.account || b.AccountNumber || b.login || ''),
    broker: String(b.broker || b.brokerName || b.Broker || ''),
    leverage: b.leverage || b.Leverage || 0,
    currency: b.currency || b.Currency || 'USD'
  };
  res.json({status:'OK'});
});

app.get('/api/ea/status',(req,res)=>{const on=(Date.now()-eaStatus.lastSeen)<30000;res.json({...eaStatus,online:on,secondsAgo:on?Math.round((Date.now()-eaStatus.lastSeen)/1000):null})});
app.get('/api/ea/commands',(req,res)=>{const p=tradeQueue.filter(c=>c.status==='pending');if(p.length>0){p[0].status='sent';p[0].sentAt=Date.now();res.json({command:p[0]})}else res.json({command:null})});
app.post('/api/ea/result',express.text({type:'*/*'}),(req,res)=>{const b=parseEAJson(req.body);const c=tradeQueue.find(x=>x.id===b.id);if(c){c.status=b.success?'executed':'failed';c.ticket=b.ticket;c.error=b.error||'';tradeHistory.push({...c});if(tradeHistory.length>200)tradeHistory.shift();saveTradeHistory()}res.json({status:'OK'})});

app.use(express.json({ strict: false, limit: '5mb' }));

app.post('/api/ea/execute',(req,res)=>{const b=req.body;if(!b.symbol||!b.action||!b.lot)return res.status(400).json({error:'Missing'});const cmd={id:Date.now()+Math.floor(Math.random()*1000),symbol:b.symbol,action:b.action,lot:parseFloat(b.lot),sl:parseFloat(b.sl||0),tp:parseFloat(b.tp||0),timestamp:Date.now(),status:'pending'};tradeQueue.push(cmd);res.json({status:'OK',id:cmd.id})});

// ===============================================
// SESSION
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

async function generateAIAnalysis(prompt,fallbackData){
  if(GEMINI_API_KEY){try{const r=await ai.models.generateContent({model:GEMINI_MODEL,contents:prompt});if(r&&r.text&&r.text.length>10)return r.text}catch(e){}}
  const {bias,confidence,entry,sl,tp1,tp2,mtf,levels}=fallbackData;
  let a='';
  if(bias==='WAIT')a=`⏳ <b>Setup belum jelas</b>\n• Harga tengah range\n• Tunggu dekat R1/S1`;
  else if(bias==='BUY')a=`📈 <b>Bias BUY (${confidence}%)</b>\n• Entry: ${entry}\n• TP1: ${tp1} | TP2: ${tp2}\n• Retest ${levels?.s1||'support'}`;
  else a=`📉 <b>Bias SELL (${confidence}%)</b>\n• Entry: ${entry}\n• TP1: ${tp1} | TP2: ${tp2}\n• Retest ${levels?.r1||'resistance'}`;
  return a+`\n\n⚙️ <i>Analysis manual — AI offline</i>`;
}

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
// HELPERS
// ===============================================
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
function detectSNR(candles){if(!candles||candles.length<50)return{S1:null,S2:null,S3:null,R1:null,R2:null,R3:null,POC:0};const recent=candles.slice(-200);const lastPrice=recent[recent.length-1].close;let swingLows=[],swingHighs=[];for(let i=2;i<recent.length-2;i++){const isLow=recent[i].low<recent[i-1].low&&recent[i].low<recent[i-2].low&&recent[i].low<recent[i+1].low&&recent[i].low<recent[i+2].low;const isHigh=recent[i].high>recent[i-1].high&&recent[i].high>recent[i-2].high&&recent[i].high>recent[i+1].high&&recent[i].high>recent[i+2].high;if(isLow)swingLows.push({price:recent[i].low});if(isHigh)swingHighs.push({price:recent[i].high})}let supports=swingLows.filter(s=>s.price<lastPrice).sort((a,b)=>b.price-a.price);let resistances=swingHighs.filter(s=>s.price>lastPrice).sort((a,b)=>a.price-b.price);return{S1:supports[0]?.price||null,S2:supports[1]?.price||null,S3:supports[2]?.price||null,R1:resistances[0]?.price||null,R2:resistances[1]?.price||null,R3:resistances[2]?.price||null,POC:lastPrice}}
function detectLiquidity(candles){if(!candles||candles.length<100)return null;const recent=candles.slice(-300);const yesterdayCandles=recent.slice(-288,-50);const asiaCandles=recent.slice(-96,-20);const londonCandles=recent.slice(-60);const yesterdayHigh=yesterdayCandles.length?Math.max(...yesterdayCandles.map(c=>c.high)):0;const yesterdayLow=yesterdayCandles.length?Math.min(...yesterdayCandles.map(c=>c.low)):0;const asiaHigh=asiaCandles.length?Math.max(...asiaCandles.map(c=>c.high)):0;const asiaLow=asiaCandles.length?Math.min(...asiaCandles.map(c=>c.low)):0;const londonHigh=londonCandles.length?Math.max(...londonCandles.map(c=>c.high)):0;const londonLow=londonCandles.length?Math.min(...londonCandles.map(c=>c.low)):0;const lastCandle=recent[recent.length-1];let sweep=null;if(lastCandle.high>yesterdayHigh&&lastCandle.close<yesterdayHigh)sweep={type:'SWEEP_HIGH',level:yesterdayHigh,source:'YESTERDAY_HIGH',bias:'SELL'};else if(lastCandle.high>asiaHigh&&lastCandle.close<asiaHigh)sweep={type:'SWEEP_HIGH',level:asiaHigh,source:'ASIA_HIGH',bias:'SELL'};else if(lastCandle.low<yesterdayLow&&lastCandle.close>yesterdayLow)sweep={type:'SWEEP_LOW',level:yesterdayLow,source:'YESTERDAY_LOW',bias:'BUY'};else if(lastCandle.low<asiaLow&&lastCandle.close>asiaLow)sweep={type:'SWEEP_LOW',level:asiaLow,source:'ASIA_LOW',bias:'BUY'};return{yesterdayHigh,yesterdayLow,asiaHigh,asiaLow,londonHigh,londonLow,sweep,currentPrice:recent[recent.length-1].close}}

function analyzeCandles(candles,symbol,snr,liquidity){
  if(!candles||candles.length<50)return null;
  const closes=candles.map(c=>c.close);
  const currentPrice=closes[closes.length-1];
  const ema9=calculateEMA(closes,9),ema21=calculateEMA(closes,21),ema50=calculateEMA(closes,50);
  const gap_9_21=Math.abs(ema9-ema21),gap_21_50=Math.abs(ema21-ema50);
  const lastCandle=candles[candles.length-1];
  const bodyRange=lastCandle.high-lastCandle.low,bodySize=Math.abs(lastCandle.close-lastCandle.open),bodyPct=bodyRange>0?bodySize/bodyRange:0,isBull=lastCandle.close>lastCandle.open;
  let buyScore=0,sellScore=0,buyReasons=[],sellReasons=[];
  if(ema9>ema21&&ema21>ema50){buyScore+=50;buyReasons.push('EMA BUY')}
  if(ema9<ema21&&ema21<ema50){sellScore+=50;sellReasons.push('EMA SELL')}
  if(ema9>ema21&&gap_9_21>0.25){buyScore+=20;buyReasons.push('Gap 9-21')}
  if(ema9>ema21&&gap_9_21>0.50){buyScore+=15;buyReasons.push('Gap besar')}
  if(ema9<ema21&&gap_9_21>0.25){sellScore+=20;sellReasons.push('Gap 9-21')}
  if(ema9<ema21&&gap_9_21>0.50){sellScore+=15;sellReasons.push('Gap besar')}
  if(gap_21_50>0.20){if(ema21>ema50){buyScore+=10;buyReasons.push('Trend kuat')}else{sellScore+=10;sellReasons.push('Trend kuat')}}
  if(bodyPct>=0.60){if(isBull){buyScore+=10;buyReasons.push('Body bull')}else{sellScore+=10;sellReasons.push('Body bear')}}
  if(bodyPct>=0.80){if(isBull){buyScore+=10;buyReasons.push('Body bull strong')}else{sellScore+=10;sellReasons.push('Body bear strong')}}
  if(snr){
    const tol=0.003;
    if(snr.R1&&Math.abs(currentPrice-snr.R1)/currentPrice<tol){sellScore+=15;sellReasons.push('Dekat R1')}
    if(snr.R2&&Math.abs(currentPrice-snr.R2)/currentPrice<tol){sellScore+=20;sellReasons.push('Dekat R2')}
    if(snr.S1&&Math.abs(currentPrice-snr.S1)/currentPrice<tol){buyScore+=15;buyReasons.push('Dekat S1')}
    if(snr.S2&&Math.abs(currentPrice-snr.S2)/currentPrice<tol){buyScore+=20;buyReasons.push('Dekat S2')}
  }
  if(liquidity&&liquidity.sweep){
    if(liquidity.sweep.bias==='SELL'){sellScore+=25;sellReasons.push('LIQUIDITY SWEEP')}
    else{buyScore+=25;buyReasons.push('LIQUIDITY SWEEP')}
  }
  let sig='WAIT',confidence=0,reasons=[];
  const diff=Math.abs(buyScore-sellScore);
  const winner=buyScore>sellScore?'BUY':sellScore>buyScore?'SELL':'WAIT';
  const winnerScore=Math.max(buyScore,sellScore);
  const maxScore=140;
  if(!(diff<10&&winnerScore>=SCORE_BOLEH)){
    if(winner==='BUY'&&buyScore>=SCORE_BOLEH){
      const conf=Math.min(Math.round((buyScore/maxScore)*100),100);
      if(conf >= MIN_CONFIDENCE){ sig='BUY';confidence=conf;reasons=buyReasons; }
    } else if(winner==='SELL'&&sellScore>=SCORE_BOLEH){
      const conf=Math.min(Math.round((sellScore/maxScore)*100),100);
      if(conf >= MIN_CONFIDENCE){ sig='SELL';confidence=conf;reasons=sellReasons; }
    }
  }
  return{signal:sig,confidence,score:winnerScore,ema9,ema21,ema50,buyScore,sellScore,reasons}
}

async function checkMultiTimeframe(symbol){
  const tfs=[{tf:'5min',label:'M5'},{tf:'15min',label:'M15'},{tf:'30min',label:'M30'},{tf:'1h',label:'H1'}];
  const results=await Promise.all(tfs.map(async t=>{
    try{
      const candlesAll=await getOHLC(symbol,t.tf,100);
      const candles = candlesAll.length > 1 ? candlesAll.slice(0, -1) : candlesAll;
      const r=analyzeCandles(candles,symbol,null,null);
      return{tf:t.tf,label:t.label,signal:r?r.signal:'WAIT',confidence:r?r.confidence:0}
    }catch(e){return{tf:t.tf,label:t.label,signal:'WAIT',confidence:0}}
  }));
  let buyCount=0,sellCount=0;
  for(let r of results){if(r.signal==='BUY')buyCount++;if(r.signal==='SELL')sellCount++;}
  const maxCount=Math.max(buyCount,sellCount),majoritySignal=buyCount>sellCount?'BUY':sellCount>buyCount?'SELL':'WAIT';
  return{timeframes:results,buyCount,sellCount,agreement:maxCount+'/4',consensus:majoritySignal}
}

// ===============================================
// 🔧 v3.8.4: SNR + 4 FILTERS
// ===============================================
function detectSNRSignal(tickHarga, snr, atr, rsi, superTrend, decimal) {
  const proximity = atr * SNR_PROXIMITY_MULT;
  const R1 = snr.R1, S1 = snr.S1, R2 = snr.R2, S2 = snr.S2;

  let candidate = null;

  if (R2 && Math.abs(tickHarga - R2) <= proximity) candidate = { bias: 'SELL', entry: R2, entryType: 'R2', reason: 'SNR R2 retest' };
  else if (R1 && Math.abs(tickHarga - R1) <= proximity) candidate = { bias: 'SELL', entry: R1, entryType: 'R1', reason: 'SNR R1 retest' };
  else if (S2 && Math.abs(tickHarga - S2) <= proximity) candidate = { bias: 'BUY', entry: S2, entryType: 'S2', reason: 'SNR S2 retest' };
  else if (S1 && Math.abs(tickHarga - S1) <= proximity) candidate = { bias: 'BUY', entry: S1, entryType: 'S1', reason: 'SNR S1 retest' };

  if (!candidate) return null;

  // 🔧 FILTER 1: Min distance dari market
  const dist = Math.abs(tickHarga - candidate.entry);
  if (dist < MIN_ENTRY_DISTANCE) {
    console.log(`⏸️ [FILTER] ${candidate.bias} ${candidate.entryType}@${candidate.entry.toFixed(decimal)} — jarak ${dist.toFixed(2)} < ${MIN_ENTRY_DISTANCE} pts — SKIP`);
    return null;
  }

  // 🔧 FILTER 2: RSI conflict
  if (candidate.bias === 'SELL' && rsi < 30) {
    console.log(`⏸️ [FILTER] SELL tapi RSI ${rsi.toFixed(1)} OVERSOLD — SKIP`);
    return null;
  }
  if (candidate.bias === 'BUY' && rsi > 70) {
    console.log(`⏸️ [FILTER] BUY tapi RSI ${rsi.toFixed(1)} OVERBOUGHT — SKIP`);
    return null;
  }

  // 🔧 FILTER 3: SuperTrend conflict
  if (candidate.bias === 'SELL' && superTrend.trend === 'BULLISH') {
    console.log(`⏸️ [FILTER] SELL tapi SuperTrend BULLISH — SKIP`);
    return null;
  }
  if (candidate.bias === 'BUY' && superTrend.trend === 'BEARISH') {
    console.log(`⏸️ [FILTER] BUY tapi SuperTrend BEARISH — SKIP`);
    return null;
  }

  // Lulus semua filter
  candidate.confidence = SNR_CONFIDENCE;
  console.log(`✅ [PASS] ${candidate.reason} → ${candidate.bias} ${SNR_CONFIDENCE}% @ ${candidate.entry.toFixed(decimal)}`);
  return candidate;
}

function pickEntryByLevel(harga, snr, fvgs, poc, bias, maxJarak) {
  const levels = [];
  if (snr.S1) levels.push({ level: snr.S1, type: 'S1', priority: 2 });
  if (snr.S2) levels.push({ level: snr.S2, type: 'S2', priority: 2 });
  if (snr.R1) levels.push({ level: snr.R1, type: 'R1', priority: 2 });
  if (snr.R2) levels.push({ level: snr.R2, type: 'R2', priority: 2 });
  if (Array.isArray(fvgs)) {
    fvgs.slice(-20).forEach((fvg) => {
      if (bias === 'BUY' && fvg.type !== 'BULLISH') return;
      if (bias === 'SELL' && fvg.type !== 'BEARISH') return;
      if (fvg.mid) levels.push({ level: fvg.mid, type: 'FVG-' + fvg.type, priority: 1 });
    });
  }
  if (poc) levels.push({ level: poc, type: 'POC', priority: 3 });
  const candidates = levels.filter(l => {
    const jarak = Math.abs(l.level - harga);
    if (jarak > maxJarak) return false;
    if (jarak < 2.0) return false;
    if (bias === 'BUY') return l.level < harga;
    if (bias === 'SELL') return l.level > harga;
    return false;
  });
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => {
    const jarakA = Math.abs(a.level - harga);
    const jarakB = Math.abs(b.level - harga);
    if (Math.abs(jarakA - jarakB) < 1.0) return a.priority - b.priority;
    return jarakA - jarakB;
  });
  return candidates[0];
}

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
async function getOHLC(symbol,interval,limit){interval=interval||'5min';limit=limit||300;const cacheKey=symbol+'_'+interval+'_'+limit;const cached=ohlcCache.get(cacheKey);if(cached&&Date.now()-cached.time<180000)return cached.data;const tdSymbol=toTwelveData(symbol);let attempts=0,maxAttempts=TWELVEDATA_KEYS.length*2||2;while(attempts<maxAttempts){attempts++;try{const url=TWELVEDATA_URL+'/time_series?symbol='+encodeURIComponent(tdSymbol)+'&interval='+interval+'&outputsize='+limit+'&apikey='+getCurrentKey();const r=await axios.get(url,{timeout:10000});const d=r.data;if(d.status==='error'||d.code){if(d.code===429){switchKey();continue}throw new Error(d.message)}if(!d.values||!Array.isArray(d.values))return[];const result=d.values.slice().reverse().map(c=>({open:parseFloat(c.open||0),high:parseFloat(c.high||0),low:parseFloat(c.low||0),close:parseFloat(c.close||0)})).filter(c=>c.close>0);ohlcCache.set(cacheKey,{data:result,time:Date.now()});return result}catch(e){if(e.message&&e.message.indexOf('429')>=0){switchKey();continue}if(attempts>=maxAttempts)throw e}}return[]}
function calculateSLTP(dir,entry,atr,symbol,atrProfile){if(!entry||!atr||atr<=0)return null;const slDist=atr*1.5;let tp1Mult=3.0,tp2Mult=6.0,tp3Mult=10.0;if(atrProfile){tp1Mult=atrProfile.tp1Mult;tp2Mult=atrProfile.tp2Mult;tp3Mult=atrProfile.tp3Mult}const dec=getDecimal(symbol);if(dir==='BUY')return{sl:(entry-slDist).toFixed(dec),tp1:(entry+atr*tp1Mult).toFixed(dec),tp2:(entry+atr*tp2Mult).toFixed(dec),tp3:(entry+atr*tp3Mult).toFixed(dec)};else return{sl:(entry+slDist).toFixed(dec),tp1:(entry-atr*tp1Mult).toFixed(dec),tp2:(entry-atr*tp2Mult).toFixed(dec),tp3:(entry-atr*tp3Mult).toFixed(dec)}}
function isSpreadOK(s,spread){return spread>0&&spread<=getSpreadLimit(s)}
async function fetchNews(){if(Date.now()-newsCache.fetchedAt<NEWS_CACHE_MS&&newsCache.events.length>0)return newsCache.events;try{const r=await axios.get(BIQUOTE_URL+'/calendar',{timeout:10000}).catch(()=>({data:{events:[]}}));let events=r.data.events||r.data.data||r.data.calendar||(Array.isArray(r.data)?r.data:[]);if(!Array.isArray(events))events=[];const usdEvents=events.filter(e=>String(e.currency||e.country||'').toUpperCase()==='USD'||String(e.currency||'').toUpperCase()==='US').slice(0,30).map(e=>({time:String(e.time||e.date||''),currency:'USD',impact:String(e.impact||'medium').toLowerCase(),event:String(e.event||e.title||''),actual:String(e.actual||'-'),forecast:String(e.forecast||'-'),previous:String(e.previous||'-')}));newsCache.events=usdEvents;newsCache.fetchedAt=Date.now();return usdEvents}catch(e){return[]}}

// ===============================================
// 🔧 v3.8.4: ASIA BREAKOUT DETECTION
// ===============================================
function detectAsiaBreakout(candlesM15, candlesH1, tickHarga) {
  if (!candlesM15 || candlesM15.length < 50) return null;
  if (!candlesH1 || candlesH1.length < 24) return null;

  // Kira Asia range dari H1 (candle 00:00-08:00 MYT)
  const recentH1 = candlesH1.slice(-24);
  const asiaRange = recentH1.filter(c => {
    const h = new Date(c.datetime || Date.now()).getUTCHours();
    return h >= 0 && h < 8; // ASIA session H1
  });

  if (asiaRange.length < 4) return null;

  const asiaHigh = Math.max(...asiaRange.map(c => c.high));
  const asiaLow = Math.min(...asiaRange.map(c => c.low));

  // Cek candle M15 terakhir (closed)
  const lastM15 = candlesM15[candlesM15.length - 1];
  const bodyRange = lastM15.high - lastM15.low;
  const bodySize = Math.abs(lastM15.close - lastM15.open);
  const bodyPct = bodyRange > 0 ? bodySize / bodyRange : 0;

  // Breakout HIGH (bullish)
  if (lastM15.close > asiaHigh && bodyPct >= ASIA_BREAKOUT_BODY_PCT) {
    return {
      type: 'BREAK_HIGH',
      bias: 'BUY',
      level: asiaHigh,
      breakPrice: lastM15.close,
      asiaHigh,
      asiaLow,
      bodyPct: parseFloat(bodyPct.toFixed(2)),
      tickHarga
    };
  }

  // Breakout LOW (bearish)
  if (lastM15.close < asiaLow && bodyPct >= ASIA_BREAKOUT_BODY_PCT) {
    return {
      type: 'BREAK_LOW',
      bias: 'SELL',
      level: asiaLow,
      breakPrice: lastM15.close,
      asiaHigh,
      asiaLow,
      bodyPct: parseFloat(bodyPct.toFixed(2)),
      tickHarga
    };
  }

  return null;
}

async function processAsiaBreakout(symbol, sessionName) {
  const decimal = getDecimal(symbol);
  try {
    const tick = await getTick(symbol);
    const tickHarga = tick.mid;
    if (!tickHarga || tickHarga <= 0) return;

    const candlesM15All = await getOHLC(symbol, '15min', 200);
    const candlesH1All = await getOHLC(symbol, '1h', 100);
    const candlesM15 = candlesM15All.length > 1 ? candlesM15All.slice(0, -1) : candlesM15All;
    const candlesH1 = candlesH1All.length > 1 ? candlesH1All.slice(0, -1) : candlesH1All;

    const breakout = detectAsiaBreakout(candlesM15, candlesH1, tickHarga);
    if (!breakout) {
      console.log(`⏸️ [ASIA BREAKOUT] ${sessionName} — tiada breakout`);
      return;
    }

    // Cooldown check
    const lastBreakout = asiaBreakoutCooldown.get(symbol);
    if (lastBreakout && (Date.now() - lastBreakout.time) < ASIA_BREAKOUT_COOLDOWN_MS) {
      const mins = Math.round((Date.now() - lastBreakout.time) / 60000);
      console.log(`⏸️ [ASIA BREAKOUT] Cooldown — ${mins} minit lepas breakout lepas`);
      return;
    }

    // Update cooldown
    asiaBreakoutCooldown.set(symbol, { time: Date.now(), type: breakout.type });

    const m15ATR = calculateATR(candlesM15, 14);
    const rsi = calculateRSI(candlesM15, 14);
    const superTrend = calculateSuperTrend(candlesM15, 10, 3.0);
    const emaDistance = calculateEMADistance(candlesM15);

    const nowMYT = new Date(Date.now() + 8 * 60 * 60 * 1000);
    const timeStr = nowMYT.toTimeString().substring(0, 5);
    const dateStr = nowMYT.toISOString().split('T')[0];
    const dayName = ['Ahad', 'Isnin', 'Selasa', 'Rabu', 'Khamis', 'Jumaat', 'Sabtu'][nowMYT.getUTCDay()];

    const breakoutEmoji = breakout.type === 'BREAK_HIGH' ? '🔺' : '🔻';
    const biasEmoji = breakout.bias === 'BUY' ? '📈' : '📉';

    // SL/TP
    const buffer = Math.max(m15ATR * 0.3, 3.0);
    let slNum, tp1Num, tp2Num, tp3Num;
    if (breakout.bias === 'BUY') {
      slNum = breakout.level - buffer;
      tp1Num = breakout.level + (m15ATR * 1.5);
      tp2Num = breakout.level + (m15ATR * 3.0);
      tp3Num = breakout.level + (m15ATR * 4.5);
    } else {
      slNum = breakout.level + buffer;
      tp1Num = breakout.level - (m15ATR * 1.5);
      tp2Num = breakout.level - (m15ATR * 3.0);
      tp3Num = breakout.level - (m15ATR * 4.5);
    }

    const msg = `${breakoutEmoji} <b>ASIA BREAKOUT</b>\n⏰ ${timeStr} MYT | 📅 ${dayName} ${dateStr}\n━━━━━━━━━━━━━━━━\n\n💰 <b>${symbol}: ${tickHarga.toFixed(decimal)}</b>\n${biasEmoji} <b>Breakout: ${breakout.bias}</b>\n📊 Type: ${breakout.type}\n\n━━━━━━━━━━━━━━━━\n🎯 <b>BREAKOUT LEVELS</b>\n\n• Asia High: <b>${breakout.asiaHigh.toFixed(decimal)}</b>\n• Asia Low: <b>${breakout.asiaLow.toFixed(decimal)}</b>\n• Break Level: <b>${breakout.level.toFixed(decimal)}</b>\n• Break Price: <b>${breakout.breakPrice.toFixed(decimal)}</b>\n• Body: <b>${(breakout.bodyPct * 100).toFixed(0)}%</b>\n\n━━━━━━━━━━━━━━━━\n🎯 <b>PLAN ENTRY</b>\n\n📍 Entry: <b>${breakout.level.toFixed(decimal)}</b>\n🛑 SL: <b>${slNum.toFixed(decimal)}</b>\n✅ TP1: <b>${tp1Num.toFixed(decimal)}</b>\n✅ TP2: <b>${tp2Num.toFixed(decimal)}</b>\n✅ TP3: <b>${tp3Num.toFixed(decimal)}</b>\n\n━━━━━━━━━━━━━━━━\n📊 <b>INDICATORS</b>\n• RSI: ${rsi.toFixed(1)}\n• SuperTrend: ${superTrend.trend}\n• EMA: ${emaDistance.distance} (${emaDistance.strength})\n\n━━━━━━━━━━━━━━━━\n⚠️ <i>Asia breakout — verifikasi sendiri</i>`;

    console.log(`📱 [ASIA BREAKOUT] ${breakout.type} — ${breakout.bias} @ ${breakout.level.toFixed(decimal)}`);
    await sendTelegram(msg);

    const entry = {
      id: Date.now(),
      type: 'asia_breakout',
      timestamp: Date.now(),
      data: {
        session: sessionName,
        symbol,
        tickHarga,
        bias: breakout.bias,
        breakoutType: breakout.type,
        level: parseFloat(breakout.level.toFixed(decimal)),
        asiaHigh: parseFloat(breakout.asiaHigh.toFixed(decimal)),
        asiaLow: parseFloat(breakout.asiaLow.toFixed(decimal)),
        breakPrice: parseFloat(breakout.breakPrice.toFixed(decimal)),
        bodyPct: breakout.bodyPct,
        sl: parseFloat(slNum.toFixed(decimal)),
        tp1: parseFloat(tp1Num.toFixed(decimal)),
        tp2: parseFloat(tp2Num.toFixed(decimal)),
        tp3: parseFloat(tp3Num.toFixed(decimal)),
        rsi: parseFloat(rsi.toFixed(1)),
        supertrend: superTrend.trend,
        telegram_msg: msg
      }
    };
    asiaBreakouts.unshift(entry);
    if (asiaBreakouts.length > 100) asiaBreakouts.pop();
    saveAsiaBreakouts();
    messageHistory.unshift(entry);
    if (messageHistory.length > 100) messageHistory.pop();
    saveHistory();

    console.log(`✅ [ASIA BREAKOUT] Tersimpan — ${breakout.type}`);
  } catch (e) {
    console.log(`❌ [ASIA BREAKOUT] Error: ${e.message}`);
  }
}

// ===============================================
// 🔧 v3.8.4: SIGNAL ALERT Telegram (bias berubah)
// ===============================================
async function sendSignalAlert(symbol, bias, confidence, tickHarga, entryNum, entryType, slNum, tp1Num, tp2Num, tp3Num, rsi, rsiStatus, superTrend, emaDistance, decimal) {
  const nowMYT = new Date(Date.now() + 8 * 60 * 60 * 1000);
  const timeStr = nowMYT.toTimeString().substring(0, 5);
  const biasEmoji = bias === 'BUY' ? '📈' : '📉';
  const stEmoji = superTrend.trend === 'BULLISH' ? '🟢' : '🔴';

  const msg = `🎯 <b>BPT SIGNAL</b>\n⏰ ${timeStr} MYT\n━━━━━━━━━━━━━━━━\n\n💰 <b>${symbol}: ${tickHarga.toFixed(decimal)}</b>\n${biasEmoji} <b>Signal: ${bias}</b> (${confidence}%)\n\n━━━━━━━━━━━━━━━━\n🎯 <b>PLAN ENTRY</b>\n\n📍 Entry: <b>${entryNum.toFixed(decimal)}</b> (${entryType})\n🛑 SL: <b>${slNum.toFixed(decimal)}</b>\n✅ TP1: <b>${tp1Num.toFixed(decimal)}</b>\n✅ TP2: <b>${tp2Num.toFixed(decimal)}</b>\n✅ TP3: <b>${tp3Num.toFixed(decimal)}</b>\n\n━━━━━━━━━━━━━━━━\n📊 <b>INDICATORS</b>\n• RSI: ${rsi.toFixed(1)} (${rsiStatus})\n• SuperTrend: ${superTrend.trend} ${stEmoji}\n• EMA: ${emaDistance.distance} (${emaDistance.strength})\n\n━━━━━━━━━━━━━━━━\n🔒 Signal M15 CLOSED\n⚠️ <i>Verifikasi sendiri sebelum entry</i>`;

  await sendTelegram(msg);
}

// ✅ BAHAGIAN 1/2 TAMAT — SAMBUNG BAHAGIAN 2/2// ===============================================
// MAPPING — v3.8.4 (KEKAL — hantar selalu 4x sehari)
// ===============================================
async function generateSessionMapping(symbol, sessionName) {
  try {
    const decimal = getDecimal(symbol);
    const tick = await getTick(symbol);
    const tickHarga = tick.mid;
    console.log(`🔍 [${sessionName}] Step 1 — Mula. Tick harga=${tickHarga} source=${tick.source}`);
    if (!tickHarga || tickHarga <= 0) { console.log(`❌ [${sessionName}] skip: tickHarga=${tickHarga}`); return; }

    const candlesH1All = await getOHLC(symbol, '1h', 200);
    const candlesM15All = await getOHLC(symbol, '15min', 200);
    const candlesH4All = await getOHLC(symbol, '4h', 100);

    const candlesH1 = candlesH1All.length > 1 ? candlesH1All.slice(0, -1) : candlesH1All;
    const candlesM15 = candlesM15All.length > 1 ? candlesM15All.slice(0, -1) : candlesM15All;
    const candlesH4 = candlesH4All.length > 1 ? candlesH4All.slice(0, -1) : candlesH4All;

    console.log(`🔍 [${sessionName}] Step 2 — Candles CLOSED H1=${candlesH1.length} M15=${candlesM15.length} H4=${candlesH4.length}`);
    if (candlesH1.length < 50) { console.log(`❌ [${sessionName}] skip: candlesH1=${candlesH1.length}`); return; }

    const lastClosedM15 = candlesM15[candlesM15.length - 1];
    const hargaSignal = lastClosedM15.close;
    console.log(`🔍 [${sessionName}] Step 3 — Signal harga=${hargaSignal} | Tick=${tickHarga}`);

    const h1SNR = detectSNR(candlesH1);
    const h1Liq = detectLiquidity(candlesH1);
    const h1Analysis = analyzeCandles(candlesH1, symbol, h1SNR, h1Liq);
    const h4Analysis = analyzeCandles(candlesH4, symbol, null, null);

    const m15ATR = calculateATR(candlesM15, 14);
    const h1ATR = calculateATR(candlesH1, 14);
    const atr = m15ATR > 0 ? m15ATR : h1ATR;
    const atrSource = m15ATR > 0 ? 'M15(closed)' : 'H1(closed)';
    console.log(`🔍 [${sessionName}] Step 4 — ATR=${atr.toFixed(2)} (${atrSource})`);
    if (!atr || atr <= 0) { console.log(`❌ [${sessionName}] skip: ATR=${atr}`); return; }

    const rsi = calculateRSI(candlesM15, 14);
    const superTrend = calculateSuperTrend(candlesM15, 10, 3.0);
    const emaDistance = calculateEMADistance(candlesM15);
    const fvgs = detectFVG(candlesM15);
    const poc = detectPOC(candlesM15);

    const mtf = await checkMultiTimeframe(symbol);
    const sessionStatus = getSessionStatus(sessionName);

    const proximity = atr * SNR_PROXIMITY_MULT;
    console.log(`🔍 [${sessionName}] Step 5 — Check SNR proximity (near=${proximity.toFixed(2)})`);
    console.log(`🔍 [${sessionName}] SNR: R2=${h1SNR.R2?.toFixed(decimal)||'-'} R1=${h1SNR.R1?.toFixed(decimal)||'-'} S1=${h1SNR.S1?.toFixed(decimal)||'-'} S2=${h1SNR.S2?.toFixed(decimal)||'-'}`);

    let bias = 'WAIT', confidence = 0, entryNum = null, entryType = null, signalSource = 'NONE';

    const snrSignal = detectSNRSignal(tickHarga, h1SNR, atr, rsi, superTrend, decimal);
    if (snrSignal) {
      bias = snrSignal.bias;
      confidence = snrSignal.confidence;
      entryNum = snrSignal.entry;
      entryType = snrSignal.entryType;
      signalSource = 'SNR';
      console.log(`✅ [${sessionName}] Step 5a — ${snrSignal.reason} → ${bias} ${confidence}% @ ${entryNum.toFixed(decimal)}`);
    }

    if (bias === 'WAIT' && h1Analysis && h1Analysis.signal !== 'WAIT' && h1Analysis.confidence >= MIN_CONFIDENCE) {
      // H1 fallback pun kena lulus filter
      const h1RSIOK = !(h1Analysis.signal === 'SELL' && rsi < 30) && !(h1Analysis.signal === 'BUY' && rsi > 70);
      const h1STOK = !(h1Analysis.signal === 'SELL' && superTrend.trend === 'BULLISH') && !(h1Analysis.signal === 'BUY' && superTrend.trend === 'BEARISH');
      if (h1RSIOK && h1STOK) {
        bias = h1Analysis.signal;
        confidence = h1Analysis.confidence;
        signalSource = 'H1';
        console.log(`✅ [${sessionName}] Step 5c — H1 fallback → ${bias} ${confidence}%`);
      } else {
        console.log(`⏸️ [${sessionName}] Step 5c — H1 fallback tapi filter block (RSI/ST)`);
      }
    }

    const h4TrendInfo = h4Analysis ? h4Analysis.signal : 'WAIT';
    console.log(`🔍 [${sessionName}] Step 5d — H4 info: ${h4TrendInfo}`);

    if (!entryNum) {
      if (h1SNR.S1 || h1SNR.R1) {
        const nearest = [h1SNR.S1, h1SNR.R1, h1SNR.S2, h1SNR.R2].filter(x => x).sort((a,b) => Math.abs(a - tickHarga) - Math.abs(b - tickHarga))[0];
        entryNum = nearest || tickHarga;
        entryType = 'WAIT-REF';
      } else {
        entryNum = tickHarga;
        entryType = 'MARKET';
      }
      console.log(`⏸️ [${sessionName}] Step 5e — WAIT state (hantar mapping sebagai nota)`);
    }

    const buffer = Math.max(atr * 0.3, 3.0);
    const tp1Mult = 1.5, tp2Mult = 3.0, tp3Mult = 4.5;
    let slNum, tp1Num, tp2Num, tp3Num;
    if (bias === 'BUY') {
      slNum = entryNum - buffer; tp1Num = entryNum + (atr * tp1Mult); tp2Num = entryNum + (atr * tp2Mult); tp3Num = entryNum + (atr * tp3Mult);
    } else if (bias === 'SELL') {
      slNum = entryNum + buffer; tp1Num = entryNum - (atr * tp1Mult); tp2Num = entryNum - (atr * tp2Mult); tp3Num = entryNum - (atr * tp3Mult);
    } else {
      slNum = entryNum - buffer; tp1Num = entryNum + (atr * tp1Mult); tp2Num = entryNum + (atr * tp2Mult); tp3Num = entryNum + (atr * tp3Mult);
    }

    const nowMYT = new Date(Date.now() + 8 * 60 * 60 * 1000);
    const dateStr = nowMYT.toISOString().split('T')[0];
    const timeStr = nowMYT.toTimeString().substring(0, 5);
    const dayName = ['Ahad', 'Isnin', 'Selasa', 'Rabu', 'Khamis', 'Jumaat', 'Sabtu'][nowMYT.getUTCDay()];

    let rsiStatus = 'NEUTRAL';
    if (rsi < 30) rsiStatus = 'OVERSOLD';
    else if (rsi > 70) rsiStatus = 'OVERBOUGHT';

    const prompt = `Mapping ${sessionName} ${symbol} tick ${tickHarga.toFixed(decimal)} bias ${bias} ${confidence}% source ${signalSource} SL ${slNum.toFixed(decimal)} TP1 ${tp1Num.toFixed(decimal)} RSI ${rsi.toFixed(1)} SuperTrend ${superTrend.trend}`;
    const aiAnalysis = await generateAIAnalysis(prompt, { bias, confidence, harga: tickHarga, entry: entryNum, sl: slNum, tp1: tp1Num, tp2: tp2Num, mtf, levels: { r1: h1SNR.R1, s1: h1SNR.S1 }, session: sessionName });

    const sessionEmoji = sessionName === 'LONDON' ? '🇬🇧' : sessionName === 'NEW YORK' ? '🇺🇸' : '🇯🇵';
    const biasEmoji = bias === 'BUY' ? '📈' : bias === 'SELL' ? '📉' : '⏳';
    const sourceEmoji = signalSource === 'SNR' ? '🎯' : signalSource === 'H1' ? '📊' : '⏸️';
    const entryNote = `${sourceEmoji} Entry: <b>${entryNum.toFixed(decimal)}</b> (${entryType})\n💰 Tick: ${tickHarga.toFixed(decimal)}\n📊 Signal: ${hargaSignal.toFixed(decimal)}\n📡 Source: <b>${signalSource}</b>\n`;

    const planText = `${entryNote}🛑 SL: <b>${slNum.toFixed(decimal)}</b>\n✅ TP1: <b>${tp1Num.toFixed(decimal)}</b>\n✅ TP2: <b>${tp2Num.toFixed(decimal)}</b>\n✅ TP3: <b>${tp3Num.toFixed(decimal)}</b>\n`;

    const indicatorText = `📊 <b>INDICATORS</b> (M15)\n• RSI: ${rsi.toFixed(1)} (${rsiStatus})\n• SuperTrend: ${superTrend.trend} ${superTrend.trend === 'BULLISH' ? '🟢' : '🔴'}\n• EMA: ${emaDistance.distance} (${emaDistance.strength})\n• FVG: ${Math.min(fvgs.length, 20)} zone\n• POC: ${poc ? poc.toFixed(decimal) : '-'}\n`;

    const trendInfoText = `📊 <b>TREND INFO</b>\n• H1: ${h1Analysis?.signal || 'WAIT'} (${h1Analysis?.confidence || 0}%)\n• H4 (info): ${h4TrendInfo}\n`;

    const msg = `${sessionEmoji} <b>MAPPING ${sessionName}</b>\n⏰ ${timeStr} MYT | 📅 ${dayName} ${dateStr}\n━━━━━━━━━━━━━━━━\n\n💰 <b>${symbol}: ${tickHarga.toFixed(decimal)}</b> (${tick.source})\n📊 ${sessionStatus}\n🎯 SNR Primary · M15 CLOSED\n\n${biasEmoji} <b>Bias: ${bias}</b> (${confidence}%)\n${sourceEmoji} Source: <b>${signalSource}</b>\n\n━━━━━━━━━━━━━━━━\n🎯 <b>PLAN ENTRY</b>\n\n${planText}\n━━━━━━━━━━━━━━━━\n${indicatorText}\n━━━━━━━━━━━━━━━━\n${trendInfoText}\n━━━━━━━━━━━━━━━━\n📊 <b>KEY LEVELS (H1)</b>\n• R2: ${h1SNR.R2 ? h1SNR.R2.toFixed(decimal) : '-'}\n• R1: ${h1SNR.R1 ? h1SNR.R1.toFixed(decimal) : '-'}\n• S1: ${h1SNR.S1 ? h1SNR.S1.toFixed(decimal) : '-'}\n• S2: ${h1SNR.S2 ? h1SNR.S2.toFixed(decimal) : '-'}\n\n━━━━━━━━━━━━━━━━\n🤖 ${aiAnalysis}\n\n📈 MTF: ${mtf.agreement} (${mtf.consensus})\n📊 ATR ${atrSource}: ${atr.toFixed(2)}\n🎯 Proximity: ${proximity.toFixed(2)} pts\n⚠️ <i>Nota belajar — bukan loceng signal</i>`;

    console.log(`🔍 [${sessionName}] Step 9 — Hantar mapping Telegram...`);
    const sent = await sendTelegram(msg);
    console.log(`🔍 [${sessionName}] Step 10 — Mapping Telegram: ${sent}`);

    aiMappings[sessionName] = {
      session: sessionName, timeStr, dateStr, dayName, symbol,
      harga: parseFloat(tickHarga.toFixed(decimal)),
      harga_signal: parseFloat(hargaSignal.toFixed(decimal)),
      harga_source: tick.source,
      signal_source: signalSource,
      entry_type: entryType,
      session_status: sessionStatus,
      ai_analysis: aiAnalysis,
      mtf_agreement: mtf.agreement,
      mtf_consensus: mtf.consensus,
      atr: parseFloat(atr.toFixed(2)),
      atr_source: atrSource,
      proximity: parseFloat(proximity.toFixed(2)),
      h1_signal: h1Analysis?.signal || 'WAIT',
      h1_confidence: h1Analysis?.confidence || 0,
      h4_info: h4TrendInfo,
      indicators: {
        rsi: parseFloat(rsi.toFixed(1)), rsi_status: rsiStatus,
        supertrend: superTrend.trend,
        supertrend_value: parseFloat((superTrend.value || 0).toFixed(decimal)),
        ema_distance: emaDistance.distance, ema_strength: emaDistance.strength,
        fvg_count: Math.min(fvgs.length, 20),
        poc: poc ? parseFloat(poc.toFixed(decimal)) : null
      },
      bias, confidence,
      entry: parseFloat(entryNum.toFixed(decimal)),
      sl: parseFloat(slNum.toFixed(decimal)),
      tp1: parseFloat(tp1Num.toFixed(decimal)),
      tp2: parseFloat(tp2Num.toFixed(decimal)),
      tp3: parseFloat(tp3Num.toFixed(decimal)),
      levels: {
        r2: h1SNR.R2 ? parseFloat(h1SNR.R2.toFixed(decimal)) : null,
        r1: h1SNR.R1 ? parseFloat(h1SNR.R1.toFixed(decimal)) : null,
        s1: h1SNR.S1 ? parseFloat(h1SNR.S1.toFixed(decimal)) : null,
        s2: h1SNR.S2 ? parseFloat(h1SNR.S2.toFixed(decimal)) : null
      }
    };
    aiMappings.lastUpdate = Date.now();
    saveMappings();

    messageHistory.unshift({
      id: Date.now(), type: 'mapping', timestamp: Date.now(),
      data: { session: sessionName, symbol, harga: tickHarga, harga_signal: hargaSignal, source: tick.source, signal_source: signalSource, entry_type: entryType, bias, confidence, entry: entryNum, sl: slNum, tp1: tp1Num, tp2: tp2Num, tp3: tp3Num, indicators: aiMappings[sessionName].indicators, telegram_msg: msg }
    });
    if (messageHistory.length > 100) messageHistory.pop();
    saveHistory();

    console.log(`✅ [${sessionName}] Step 11 — MAPPING SELESAI. ${bias} ${confidence}% (${signalSource}) | Entry ${entryType}@${entryNum.toFixed(decimal)}`);
  } catch (e) {
    console.log(`❌ [${sessionName}] CATCH ERROR: ${e.message}`);
  }
}

// ===================== API ROUTES =====================

app.get('/api/generate-mapping', async (req, res) => {
  const symbol = req.query.symbol || 'XAU/USD';
  const session = (req.query.session || 'LONDON').toUpperCase();
  console.log(`🚀 [GENERATE] Request masuk — session=${session} symbol=${symbol}`);
  try {
    await generateSessionMapping(symbol, session);
    console.log(`🚀 [GENERATE] Selesai — ${session}`);
    res.json({ status: 'OK', message: session + ' sent' });
  } catch (e) {
    console.log(`❌ [GENERATE] Error: ${e.message}`);
    res.json({ status: 'FAIL', error: e.message });
  }
});

app.get('/api/signal', async (req,res)=>{
  const symbol=req.query.symbol||'XAU/USD';
  const decimal=getDecimal(symbol);
  try{
    const tick=await getTick(symbol);
    const tickHarga=tick.mid;
    if(!tickHarga||tickHarga<=0) return res.status(503).json({error:'No price data', signal:'WAIT', score:0});

    const candlesM15All=await getOHLC(symbol,'15min',200);
    const candlesH1All=await getOHLC(symbol,'1h',200);
    const candlesM15 = candlesM15All.length > 1 ? candlesM15All.slice(0, -1) : candlesM15All;
    const candlesH1 = candlesH1All.length > 1 ? candlesH1All.slice(0, -1) : candlesH1All;

    if(candlesH1.length<50) return res.json({symbol,harga:parseFloat(tickHarga.toFixed(decimal)),harga_source:tick.source,signal:'WAIT',score:0,session:getMarketSession()});

    const snr=detectSNR(candlesH1);
    const liq=detectLiquidity(candlesH1);
    const h1Analysis=analyzeCandles(candlesH1,symbol,snr,liq);
    const mtf=await checkMultiTimeframe(symbol);
    const atr=calculateATR(candlesM15,14);
    const atrProfile=getATRProfile(candlesM15);

    const rsi = calculateRSI(candlesM15, 14);
    const superTrend = calculateSuperTrend(candlesM15, 10, 3.0);
    const emaDistance = calculateEMADistance(candlesM15);
    const fvgs = detectFVG(candlesM15);
    const poc = detectPOC(candlesM15);

    let rsiStatus = 'NEUTRAL';
    if (rsi < 30) rsiStatus = 'OVERSOLD';
    else if (rsi > 70) rsiStatus = 'OVERBOUGHT';

    // SNR dengan 4 filter
    const snrSignal = detectSNRSignal(tickHarga, snr, atr, rsi, superTrend, decimal);
    let bias = 'WAIT', confidence = 0, entryNum = null, entryType = null, signalSource = 'NONE';

    if (snrSignal) {
      bias = snrSignal.bias;
      confidence = snrSignal.confidence;
      entryNum = snrSignal.entry;
      entryType = snrSignal.entryType;
      signalSource = 'SNR';
    } else if (h1Analysis && h1Analysis.signal !== 'WAIT' && h1Analysis.confidence >= MIN_CONFIDENCE) {
      // H1 fallback pun kena lulus filter
      const h1RSIOK = !(h1Analysis.signal === 'SELL' && rsi < 30) && !(h1Analysis.signal === 'BUY' && rsi > 70);
      const h1STOK = !(h1Analysis.signal === 'SELL' && superTrend.trend === 'BULLISH') && !(h1Analysis.signal === 'BUY' && superTrend.trend === 'BEARISH');
      if (h1RSIOK && h1STOK) {
        bias = h1Analysis.signal;
        confidence = h1Analysis.confidence;
        signalSource = 'H1';
      }
    }

    // Signal Alert — hantar bila bias berubah
    if (bias === 'BUY' || bias === 'SELL') {
      if (!entryNum) {
        const MAX_JARAK_SIGNAL = Math.max(atr * 1.5, 8);
        const entryPick = pickEntryByLevel(tickHarga, snr, fvgs, poc, bias, MAX_JARAK_SIGNAL);
        if (entryPick) { entryNum = entryPick.level; entryType = entryPick.type; }
      }

      if (entryNum) {
        const lastState = signalAlertState.get(symbol);
        const lastBias = lastState?.bias || 'NONE';

        if (lastBias !== bias) {
          const sltp = calculateSLTP(bias, entryNum, atr, symbol, atrProfile);
          if (sltp) {
            console.log(`📱 [SIGNAL ALERT] ${bias} ${confidence}% — ${lastBias} → ${bias} (hantar Telegram)`);
            await sendSignalAlert(symbol, bias, confidence, tickHarga, entryNum, entryType, parseFloat(sltp.sl), parseFloat(sltp.tp1), parseFloat(sltp.tp2), parseFloat(sltp.tp3), rsi, rsiStatus, superTrend, emaDistance, decimal);
            signalAlertState.set(symbol, { bias, confidence, time: Date.now() });
          }
        } else {
          console.log(`⏸️ [SIGNAL ALERT] Skip — ${bias} kekal (last: ${lastBias})`);
        }
      }
    } else {
      const lastState = signalAlertState.get(symbol);
      if (lastState && lastState.bias !== 'WAIT') {
        console.log(`⏸️ [SIGNAL ALERT] Signal hilang → WAIT (reset state)`);
        signalAlertState.set(symbol, { bias: 'WAIT', confidence: 0, time: Date.now() });
      }
    }

    if (bias === 'WAIT') {
      return res.json({
        symbol, harga: parseFloat(tickHarga.toFixed(decimal)), harga_source: tick.source,
        signal: 'WAIT', score: 0, confidence: 0,
        entry: null, sl: null, tp1: null, tp2: null, tp3: null,
        session: getMarketSession(), reason: 'Harga tengah range atau filter block',
        signal_source: 'NONE', mtf, snr,
        indicators: { rsi: parseFloat(rsi.toFixed(1)), rsi_status: rsiStatus, supertrend: superTrend.trend, supertrend_value: parseFloat((superTrend.value||0).toFixed(decimal)), ema_distance: emaDistance.distance, ema_strength: emaDistance.strength, fvg_count: Math.min(fvgs.length,20), poc: poc?parseFloat(poc.toFixed(decimal)):null }
      });
    }

    const sltpFinal = calculateSLTP(bias, entryNum, atr, symbol, atrProfile);

    res.json({
      symbol, harga: parseFloat(tickHarga.toFixed(decimal)), harga_source: tick.source,
      signal: bias, score: confidence, confidence: confidence,
      entry: parseFloat(entryNum.toFixed(decimal)), entry_type: entryType,
      sl: sltpFinal ? parseFloat(sltpFinal.sl) : null,
      tp1: sltpFinal ? parseFloat(sltpFinal.tp1) : null,
      tp2: sltpFinal ? parseFloat(sltpFinal.tp2) : null,
      tp3: sltpFinal ? parseFloat(sltpFinal.tp3) : null,
      session: getMarketSession(), mtf, snr,
      signal_source: signalSource,
      indicators: { rsi: parseFloat(rsi.toFixed(1)), rsi_status: rsiStatus, supertrend: superTrend.trend, supertrend_value: parseFloat((superTrend.value||0).toFixed(decimal)), ema_distance: emaDistance.distance, ema_strength: emaDistance.strength, fvg_count: Math.min(fvgs.length,20), poc: poc?parseFloat(poc.toFixed(decimal)):null }
    });
  }catch(e){
    console.log(`❌ [SIGNAL] ${symbol} error:`, e.message);
    res.status(500).json({error:e.message, signal:'WAIT', score:0});
  }
});

// ===============================================
// 🔧 v3.8.4: ASIA BREAKOUT ENDPOINTS
// ===============================================
app.get('/api/asia-breakout', async (req, res) => {
  const symbol = req.query.symbol || 'XAU/USD';
  const session = (req.query.session || 'ASIA').toUpperCase();
  console.log(`🚀 [ASIA-BREAKOUT] Manual trigger — ${session}`);
  try {
    await processAsiaBreakout(symbol, session);
    res.json({ status: 'OK', message: 'Asia breakout processed' });
  } catch (e) {
    res.json({ status: 'FAIL', error: e.message });
  }
});

app.get('/api/asia-breakouts', (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  res.json({ status: 'OK', breakouts: asiaBreakouts.slice(0, limit), count: asiaBreakouts.length });
});

// ===============================================
// STANDARD ENDPOINTS
// ===============================================
app.get('/api/mapping',(req,res)=>{res.json({status:'OK',mappings:aiMappings,current_session:getMarketSession(),timestamp:Date.now()})});
app.get('/api/market',async(req,res)=>{const symbol=req.query.symbol||'XAU/USD';const decimal=getDecimal(symbol);try{const tick=await getTick(symbol);const candlesAll=await getOHLC(symbol,'1h',200);const candles = candlesAll.length > 1 ? candlesAll.slice(0, -1) : candlesAll;const harga=tick.mid||(candles.length?candles[candles.length-1].close:0);if(!harga)return res.status(503).json({error:'No price data'});const snr=detectSNR(candles);const liq=detectLiquidity(candles);res.json({symbol,harga:parseFloat(harga.toFixed(decimal)),harga_source:tick.source,spread:parseFloat(tick.spread.toFixed(decimal)),spread_ok:isSpreadOK(symbol,tick.spread),POC:snr.POC?parseFloat(snr.POC.toFixed(decimal)):null,R1:snr.R1?parseFloat(snr.R1.toFixed(decimal)):null,R2:snr.R2?parseFloat(snr.R2.toFixed(decimal)):null,R3:snr.R3?parseFloat(snr.R3.toFixed(decimal)):null,S1:snr.S1?parseFloat(snr.S1.toFixed(decimal)):null,S2:snr.S2?parseFloat(snr.S2.toFixed(decimal)):null,S3:snr.S3?parseFloat(snr.S3.toFixed(decimal)):null,liquidity:liq,session:getMarketSession()})}catch(e){res.status(500).json({error:e.message})}});
app.get('/api/messages',(req,res)=>{const limit=parseInt(req.query.limit)||50;const type=req.query.type;let filtered=messageHistory;if(type&&type!=='all'){const types=type.split(',').map(t=>t.trim());filtered=messageHistory.filter(m=>types.includes(m.type))}const stats={signal:messageHistory.filter(m=>m.type==='signal').length,mapping:messageHistory.filter(m=>m.type==='mapping').length,asia_breakout:messageHistory.filter(m=>m.type==='asia_breakout').length,level_alert:messageHistory.filter(m=>m.type==='level_alert').length,news_alert:messageHistory.filter(m=>m.type==='news_alert').length,daily_outlook:messageHistory.filter(m=>m.type==='daily_outlook').length,pre_market:messageHistory.filter(m=>m.type==='pre_market').length,liquidity_sweep:messageHistory.filter(m=>m.type==='liquidity_sweep').length};res.json({status:'OK',messages:filtered.slice(0,limit),stats})});
app.get('/api/news',async(req,res)=>{const events=await fetchNews();res.json({status:'success',events})});
app.get('/api/health',(req,res)=>{res.json({status:'OK',version:'3.8.4',session:getMarketSession(),myt:new Date(Date.now()+8*60*60*1000).toISOString(),mappings:Object.keys(aiMappings).filter(k=>aiMappings[k]&&k!=='lastUpdate').length,ea_online:(Date.now()-eaStatus.lastSeen)<30000,snr_confidence:SNR_CONFIDENCE,snr_proximity_mult:SNR_PROXIMITY_MULT,min_confidence:MIN_CONFIDENCE,min_entry_distance:MIN_ENTRY_DISTANCE,asia_breakouts_count:asiaBreakouts.length,signal_alert_state:Array.from(signalAlertState.entries()).map(([k,v])=>({symbol:k,bias:v.bias,conf:v.confidence})),features:{signal_alert:'bias_change_only',mapping:'always_send',filters:['proximity_1.0','min_distance_3','rsi_conflict','supertrend_conflict'],asia_breakout:'30min_cooldown'},telegram_configured:!!(TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID)})});

// ===============================================
// SCHEDULER
// ===============================================
function shouldRunScheduler(){const nowMYT=new Date(Date.now()+8*60*60*1000);if(nowMYT.getUTCDay()===0||nowMYT.getUTCDay()===6)return false;return true}

setInterval(async()=>{
  if(!shouldRunScheduler())return;
  const nowMYT=new Date(Date.now()+8*60*60*1000);
  const h=nowMYT.getUTCHours(),m=nowMYT.getUTCMinutes();
  if(h===7&&m===0)await generateSessionMapping('XAU/USD','ASIA');
  if(h===8&&m===0)await generateSessionMapping('XAU/USD','ASIA');
  if(h===15&&m===0)await generateSessionMapping('XAU/USD','LONDON');
  if(h===20&&m===0)await generateSessionMapping('XAU/USD','NEW YORK');
},60*1000);

// 🔧 v3.8.4: Asia Breakout check setiap 30 minit (07:00-15:00 MYT)
setInterval(async()=>{
  if(!shouldRunScheduler())return;
  const nowMYT=new Date(Date.now()+8*60*60*1000);
  const h=nowMYT.getUTCHours();
  // Asia session: 07:00-15:00 MYT
  if(h>=7 && h<15){
    await processAsiaBreakout('XAU/USD', 'ASIA');
  }
}, 30*60*1000);

// 🔧 v3.8.4: Auto-trigger signal alert setiap 30 saat
setInterval(async()=>{
  try{
    await axios.get('http://localhost:'+(process.env.PORT||3000)+'/api/signal?symbol=XAU/USD', {timeout:15000});
  }catch(e){}
}, 30*1000);

const PORT=process.env.PORT||3000;
app.listen(PORT,()=>{
  console.log(`🚀 BPT v3.8.4 running on ${PORT} | MYT: ${new Date(Date.now()+8*60*60*1000).toISOString()}`);
  console.log(`   Filters: proximity ${SNR_PROXIMITY_MULT} · min dist ${MIN_ENTRY_DISTANCE} · RSI · SuperTrend`);
  console.log(`   Signal Alert: >${MIN_CONFIDENCE}% · bias change only`);
  console.log(`   Mapping: 4x/day · Asia Breakout: 30min cooldown`);
});