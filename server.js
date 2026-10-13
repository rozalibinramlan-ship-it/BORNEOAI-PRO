// ===============================================
// BPT — Borneo Pro Trade v3.8.1 FINAL
// Fix: Buang H4 dari bias — H1 primary
// Signal: M15 CLOSED (anti-repaint)
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
const COOLDOWN_MS = 15 * 60 * 1000;
const MAX_LOCK_MS = 30 * 60 * 1000;
const NEWS_AVOID_MS = 60 * 60 * 1000;
const SCORE_BOLEH = 65;
const MIN_CONFIDENCE = 70;
const SPREAD_LIMIT = { 'XAU/USD': 0.80, 'XAG/USD': 0.05, 'EUR/USD': 0.00025, 'GBP/USD': 0.00035, 'USD/JPY': 0.025, 'DEFAULT': 0.0010 };
const TWELVEDATA_KEYS = [process.env.TWELVEDATA_API_KEY||'',process.env.TWELVEDATA_API_KEY_2||'',process.env.TWELVEDATA_API_KEY_3||''].filter(k=>k.length>0);
let currentKeyIndex=0;
function getCurrentKey(){return TWELVEDATA_KEYS[currentKeyIndex]||TWELVEDATA_KEYS[0]||''}
function switchKey(){if(TWELVEDATA_KEYS.length>1)currentKeyIndex=(currentKeyIndex+1)%TWELVEDATA_KEYS.length}

console.log('╔══════════════════════════════════════╗');
console.log('║ BPT — BORNEO PRO TRADE v3.8.1 FINAL ║');
console.log('║ H1 primary · No H4 bias · No repaint║');
console.log('╚══════════════════════════════════════╝');

const DATA_DIR=path.join(__dirname,'data');
if(!fs.existsSync(DATA_DIR))fs.mkdirSync(DATA_DIR);
const FILES={mappings:path.join(DATA_DIR,'mappings.json'),history:path.join(DATA_DIR,'history.json'),trades:path.join(DATA_DIR,'trades.json'),signalHistory:path.join(DATA_DIR,'signal-history.json')};
let aiMappings={ASIA:null,LONDON:null,'NEW YORK':null,lastUpdate:0};
let newsCache={events:[],fetchedAt:0};
const NEWS_CACHE_MS=10*60*1000;
let messageHistory=[],signalHistory=[],tradeHistory=[];
const levelAlertCooldown=new Map(),newsAlertCooldown=new Map(),liquidityCooldown=new Map();

function loadJSON(file,def){try{if(fs.existsSync(file))return JSON.parse(fs.readFileSync(file,'utf8'))}catch(e){}return def}
function saveJSON(file,data){try{fs.writeFileSync(file,JSON.stringify(data,null,2))}catch(e){}}
function loadAllData(){aiMappings=loadJSON(FILES.mappings,{ASIA:null,LONDON:null,'NEW YORK':null,lastUpdate:0});messageHistory=loadJSON(FILES.history,[]);signalHistory=loadJSON(FILES.signalHistory,[]);tradeHistory=loadJSON(FILES.trades,[])}
function saveMappings(){saveJSON(FILES.mappings,aiMappings)} function saveHistory(){saveJSON(FILES.history,messageHistory.slice(0,100))} function saveSignalHistory(){saveJSON(FILES.signalHistory,signalHistory.slice(0,200))} function saveTradeHistory(){saveJSON(FILES.trades,tradeHistory.slice(0,200))}
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
  }catch(e){
    console.log('❌ [PARSE] FAIL:', e.message);
    return {};
  }
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
function isSessionActive(n){const c=getMarketSession();if(n==='NEW YORK')return c==='NEW YORK'||c==='LONDON';return c===n}

async function generateAIAnalysis(prompt,fallbackData){
  if(GEMINI_API_KEY){try{const r=await ai.models.generateContent({model:GEMINI_MODEL,contents:prompt});if(r&&r.text&&r.text.length>10)return r.text}catch(e){}}
  const {bias,confidence,entry,sl,tp1,tp2,mtf,levels}=fallbackData;
  let a='';
  if(bias==='WAIT')a=`⏳ <b>Setup belum jelas</b>\n• H1 belum confirm\n• MTF: ${mtf.agreement} (${mtf.consensus})\n• Tunggu close H1`;
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
function detectSNR(candles){if(!candles||candles.length<50)return{S1:null,S2:null,S3:null,R1:null,R2:null,R3:null,POC:0};const recent=candles.slice(-200);const lastPrice=recent[recent.length-1].close;let atrSum=0;for(let i=0;i<14;i++)atrSum+=(recent.slice(-14)[i].high-recent.slice(-14)[i].low);const ATR=atrSum/14;const tolerance=Math.max(lastPrice*0.002,ATR*0.4);let swingLows=[],swingHighs=[];for(let i=2;i<recent.length-2;i++){const isLow=recent[i].low<recent[i-1].low&&recent[i].low<recent[i-2].low&&recent[i].low<recent[i+1].low&&recent[i].low<recent[i+2].low;const isHigh=recent[i].high>recent[i-1].high&&recent[i].high>recent[i-2].high&&recent[i].high>recent[i+1].high&&recent[i].high>recent[i+2].high;if(isLow)swingLows.push({price:recent[i].low});if(isHigh)swingHighs.push({price:recent[i].high})}let supports=swingLows.filter(s=>s.price<lastPrice).sort((a,b)=>b.price-a.price);let resistances=swingHighs.filter(s=>s.price>lastPrice).sort((a,b)=>a.price-b.price);return{S1:supports[0]?.price||null,S2:supports[1]?.price||null,S3:supports[2]?.price||null,R1:resistances[0]?.price||null,R2:resistances[1]?.price||null,R3:resistances[2]?.price||null,POC:lastPrice}}
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
const signalLock=new Map(),signalCooldown=new Map();
function calculateSLTP(dir,entry,atr,symbol,atrProfile){if(!entry||!atr||atr<=0)return null;const slDist=atr*1.5;let tp1Mult=3.0,tp2Mult=6.0,tp3Mult=10.0;if(atrProfile){tp1Mult=atrProfile.tp1Mult;tp2Mult=atrProfile.tp2Mult;tp3Mult=atrProfile.tp3Mult}const dec=getDecimal(symbol);if(dir==='BUY')return{sl:(entry-slDist).toFixed(dec),tp1:(entry+atr*tp1Mult).toFixed(dec),tp2:(entry+atr*tp2Mult).toFixed(dec),tp3:(entry+atr*tp3Mult).toFixed(dec)};else return{sl:(entry+slDist).toFixed(dec),tp1:(entry-atr*tp1Mult).toFixed(dec),tp2:(entry-atr*tp2Mult).toFixed(dec),tp3:(entry-atr*tp3Mult).toFixed(dec)}}
function isSpreadOK(s,spread){return spread>0&&spread<=getSpreadLimit(s)}
async function fetchNews(){if(Date.now()-newsCache.fetchedAt<NEWS_CACHE_MS&&newsCache.events.length>0)return newsCache.events;try{const r=await axios.get(BIQUOTE_URL+'/calendar',{timeout:10000}).catch(()=>({data:{events:[]}}));let events=r.data.events||r.data.data||r.data.calendar||(Array.isArray(r.data)?r.data:[]);if(!Array.isArray(events))events=[];const usdEvents=events.filter(e=>String(e.currency||e.country||'').toUpperCase()==='USD'||String(e.currency||'').toUpperCase()==='US').slice(0,30).map(e=>({time:String(e.time||e.date||''),currency:'USD',impact:String(e.impact||'medium').toLowerCase(),event:String(e.event||e.title||''),actual:String(e.actual||'-'),forecast:String(e.forecast||'-'),previous:String(e.previous||'-')}));newsCache.events=usdEvents;newsCache.fetchedAt=Date.now();return usdEvents}catch(e){return[]}}
async function checkNewsBlock(){try{const events=await fetchNews();const now=Date.now();for(let ev of events){if(ev.impact!=='high')continue;const evTime=new Date(ev.time).getTime();if(isNaN(evTime))continue;if(Math.abs(evTime-now)<NEWS_AVOID_MS){const mins=Math.round((evTime-now)/60000);return{blocked:true,reason:'News '+ev.event+' ('+(mins>0?'in '+mins+' min':Math.abs(mins)+' min ago')+')'}}}return{blocked:false,reason:null}}catch(e){return{blocked:false,reason:null}}}

// ===============================================
// MAPPING — v3.8.1: H1 primary, no H4 bias
// ===============================================
async function generateSessionMapping(symbol, sessionName) {
  try {
    const decimal = getDecimal(symbol);
    const tick = await getTick(symbol);
    const tickHarga = tick.mid;

    console.log(`🔍 [${sessionName}] Step 1 — Mula. Tick harga=${tickHarga} source=${tick.source}`);
    if (!tickHarga || tickHarga <= 0) { console.log(`❌ [${sessionName}] skip: tickHarga=${tickHarga}`); return; }

    const candlesH1All = await getOHLC(symbol, '1h', 200);
    const candlesM30All = await getOHLC(symbol, '30min', 200);
    const candlesM15All = await getOHLC(symbol, '15min', 200);
    const candlesH4All = await getOHLC(symbol, '4h', 100); // H4 cuma untuk info

    const candlesH1 = candlesH1All.length > 1 ? candlesH1All.slice(0, -1) : candlesH1All;
    const candlesM30 = candlesM30All.length > 1 ? candlesM30All.slice(0, -1) : candlesM30All;
    const candlesM15 = candlesM15All.length > 1 ? candlesM15All.slice(0, -1) : candlesM15All;
    const candlesH4 = candlesH4All.length > 1 ? candlesH4All.slice(0, -1) : candlesH4All;

    console.log(`🔍 [${sessionName}] Step 2 — Candles CLOSED H1=${candlesH1.length} M30=${candlesM30.length} M15=${candlesM15.length} H4=${candlesH4.length}`);
    if (candlesH1.length < 50) { console.log(`❌ [${sessionName}] skip: candlesH1=${candlesH1.length}`); return; }

    const lastClosedM15 = candlesM15[candlesM15.length - 1];
    const hargaSignal = lastClosedM15.close;
    console.log(`🔍 [${sessionName}] Step 3 — Harga SIGNAL=${hargaSignal} (M15 closed) | Tick LIVE=${tickHarga}`);

    const h1SNR = detectSNR(candlesH1);
    const h1Liq = detectLiquidity(candlesH1);
    const h1Analysis = analyzeCandles(candlesH1, symbol, h1SNR, h1Liq);
    const m30Analysis = analyzeCandles(candlesM30, symbol, null, null);
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

    // 🔧 v3.8.1: H1 primary, H4 cuma info
    let bias = h1Analysis ? h1Analysis.signal : 'WAIT';
    let confidence = h1Analysis ? h1Analysis.confidence : 0;
    console.log(`🔍 [${sessionName}] Step 5 — H1 bias=${bias} conf=${confidence}%`);

    // Fallback ke M30
    if (bias === 'WAIT' && m30Analysis && m30Analysis.signal !== 'WAIT') {
      bias = m30Analysis.signal;
      confidence = Math.min(Math.round(m30Analysis.confidence * 0.85), 100);
      console.log(`🔍 [${sessionName}] Step 5b — M30 fallback → bias=${bias} conf=${confidence}%`);
    }

    // Fallback ke MTF
    if (bias === 'WAIT' && mtf.consensus !== 'WAIT') {
      bias = mtf.consensus;
      confidence = Math.min(Math.round((bias === 'BUY' ? mtf.buyCount : mtf.sellCount) / 4 * 100 * 0.75), 100);
      console.log(`🔍 [${sessionName}] Step 5c — MTF fallback → bias=${bias} conf=${confidence}%`);
    }

    const h4TrendInfo = h4Analysis ? h4Analysis.signal : 'WAIT';
    console.log(`🔍 [${sessionName}] Step 5d — H4 info (tak block): ${h4TrendInfo}`);

    if (confidence < MIN_CONFIDENCE) {
      console.log(`❌ [${sessionName}] skip: confidence ${confidence}% < ${MIN_CONFIDENCE}%`);
      return;
    }

    const MAX_JARAK = Math.max(atr * 1.5, 8);
    const entryPick = pickEntryByLevel(tickHarga, h1SNR, fvgs, poc, bias, MAX_JARAK);

    console.log(`🔍 [${sessionName}] Step 6 — RSI=${rsi.toFixed(1)} ST=${superTrend.trend} EMA=${emaDistance.strength} FVG=${fvgs.length} POC=${poc?.toFixed(2)}`);
    console.log(`🔍 [${sessionName}] Step 7 — entryPick=${entryPick ? entryPick.type + '@' + entryPick.level.toFixed(2) : 'NULL'}`);

    if (!entryPick) {
      console.log(`❌ [${sessionName}] skip: tiada SNR/FVG dekat dengan tick ${tickHarga.toFixed(decimal)}`);
      return;
    }

    const entryNum = entryPick.level;
    const entryType = entryPick.type;

    const buffer = Math.max(atr * 0.3, 3.0);
    const tp1Mult = 1.5, tp2Mult = 3.0, tp3Mult = 4.5;
    let slNum, tp1Num, tp2Num, tp3Num;
    if (bias === 'BUY') {
      slNum = entryNum - buffer;
      tp1Num = entryNum + (atr * tp1Mult);
      tp2Num = entryNum + (atr * tp2Mult);
      tp3Num = entryNum + (atr * tp3Mult);
    } else {
      slNum = entryNum + buffer;
      tp1Num = entryNum - (atr * tp1Mult);
      tp2Num = entryNum - (atr * tp2Mult);
      tp3Num = entryNum - (atr * tp3Mult);
    }

    if (!slNum || !tp1Num || slNum <= 0 || tp1Num <= 0) { console.log(`❌ [${sessionName}] skip: output invalid`); return; }

    const nowMYT = new Date(Date.now() + 8 * 60 * 60 * 1000);
    const dateStr = nowMYT.toISOString().split('T')[0];
    const timeStr = nowMYT.toTimeString().substring(0, 5);
    const dayName = ['Ahad', 'Isnin', 'Selasa', 'Rabu', 'Khamis', 'Jumaat', 'Sabtu'][nowMYT.getUTCDay()];

    let rsiStatus = 'NEUTRAL';
    if (rsi < 30) rsiStatus = 'OVERSOLD';
    else if (rsi > 70) rsiStatus = 'OVERBOUGHT';

    const prompt = `Mapping ${sessionName} ${symbol} harga signal ${hargaSignal.toFixed(decimal)} (M15 closed) tick live ${tickHarga.toFixed(decimal)} entry di ${entryType} ${entryNum.toFixed(decimal)} bias ${bias} ${confidence}% SL ${slNum.toFixed(decimal)} TP1 ${tp1Num.toFixed(decimal)} RSI ${rsi.toFixed(1)} SuperTrend ${superTrend.trend} EMA ${emaDistance.strength}`;

    console.log(`🔍 [${sessionName}] Step 8 — Panggil AI...`);
    const aiAnalysis = await generateAIAnalysis(prompt, { bias, confidence, harga: tickHarga, entry: entryNum, sl: slNum, tp1: tp1Num, tp2: tp2Num, mtf, levels: { r1: h1SNR.R1, s1: h1SNR.S1 }, session: sessionName });

    const sessionEmoji = sessionName === 'LONDON' ? '🇬🇧' : sessionName === 'NEW YORK' ? '🇺🇸' : '🇯🇵';
    const biasEmoji = bias === 'BUY' ? '📈' : bias === 'SELL' ? '📉' : '⏳';
    const entryNote = `📍 Entry: <b>${entryNum.toFixed(decimal)}</b> (${entryType})\n💰 Tick live: ${tickHarga.toFixed(decimal)}\n📊 Signal (M15 close): ${hargaSignal.toFixed(decimal)}\n`;

    let planText = bias === 'WAIT'
      ? `⚠️ <i>Setup belum jelas — fallback SELL:</i>\n\n${entryNote}🛑 SL: <b>${slNum.toFixed(decimal)}</b>\n✅ TP1: <b>${tp1Num.toFixed(decimal)}</b>\n✅ TP2: <b>${tp2Num.toFixed(decimal)}</b>\n✅ TP3: <b>${tp3Num.toFixed(decimal)}</b>\n`
      : `${entryNote}🛑 SL: <b>${slNum.toFixed(decimal)}</b>\n✅ TP1: <b>${tp1Num.toFixed(decimal)}</b>\n✅ TP2: <b>${tp2Num.toFixed(decimal)}</b>\n✅ TP3: <b>${tp3Num.toFixed(decimal)}</b>\n`;

    const indicatorText = `📊 <b>INDICATORS</b> (M15 closed)\n• RSI(14): ${rsi.toFixed(1)} (${rsiStatus})\n• SuperTrend: ${superTrend.trend} ${superTrend.trend === 'BULLISH' ? '🟢' : '🔴'}\n• EMA Distance: ${emaDistance.distance} (${emaDistance.strength})\n• FVG Fresh: ${Math.min(fvgs.length, 20)} zone\n• POC: ${poc ? poc.toFixed(decimal) : '-'}\n`;

    const trendInfoText = `📊 <b>TREND INFO</b>\n• H1 (primary): ${h1Analysis?.signal || 'WAIT'} (${h1Analysis?.confidence || 0}%)\n• M30: ${m30Analysis?.signal || 'WAIT'}\n• H4 (info): ${h4TrendInfo}\n`;

    const msg = `${sessionEmoji} <b>MAPPING ${sessionName}</b>\n⏰ ${timeStr} MYT | 📅 ${dayName} ${dateStr}\n━━━━━━━━━━━━━━━━\n\n💰 <b>${symbol}: ${tickHarga.toFixed(decimal)}</b> (${tick.source})\n📊 ${sessionStatus}\n🔒 Signal guna M15 CLOSED (anti-repaint)\n🎯 Bias primary: H1\n\n${biasEmoji} <b>Bias: ${bias}</b> (${confidence}%) ✅\n\n━━━━━━━━━━━━━━━━\n🎯 <b>PLAN ENTRY</b>\n\n${planText}\n━━━━━━━━━━━━━━━━\n${indicatorText}\n━━━━━━━━━━━━━━━━\n${trendInfoText}\n━━━━━━━━━━━━━━━━\n📊 <b>KEY LEVELS (H1)</b>\n• R1: ${h1SNR.R1 ? h1SNR.R1.toFixed(decimal) : '-'}\n• R2: ${h1SNR.R2 ? h1SNR.R2.toFixed(decimal) : '-'}\n• S1: ${h1SNR.S1 ? h1SNR.S1.toFixed(decimal) : '-'}\n• S2: ${h1SNR.S2 ? h1SNR.S2.toFixed(decimal) : '-'}\n\n━━━━━━━━━━━━━━━━\n🤖 ${aiAnalysis}\n\n📈 MTF: ${mtf.agreement} (${mtf.consensus})\n📊 ATR ${atrSource}: ${atr.toFixed(2)}\n🔒 <i>Signal stabil — tiada repaint</i>\n⚠️ <i>Set limit order di ${entryType}!</i>`;

    console.log(`🔍 [${sessionName}] Step 9 — Hantar Telegram...`);
    const sent = await sendTelegram(msg);
    console.log(`🔍 [${sessionName}] Step 10 — Telegram result: ${sent}`);

    aiMappings[sessionName] = {
      session: sessionName, timeStr, dateStr, dayName, symbol,
      harga: parseFloat(tickHarga.toFixed(decimal)),
      harga_signal: parseFloat(hargaSignal.toFixed(decimal)),
      harga_source: tick.source,
      signal_source: 'M15_CLOSED',
      bias_primary: 'H1',
      entry_type: entryType,
      session_status: sessionStatus,
      ai_analysis: aiAnalysis,
      mtf_agreement: mtf.agreement,
      mtf_consensus: mtf.consensus,
      atr: parseFloat(atr.toFixed(2)),
      atr_source: atrSource,
      h1_signal: h1Analysis?.signal || 'WAIT',
      h1_confidence: h1Analysis?.confidence || 0,
      m30_signal: m30Analysis?.signal || 'WAIT',
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
        r1: h1SNR.R1 ? parseFloat(h1SNR.R1.toFixed(decimal)) : null,
        r2: h1SNR.R2 ? parseFloat(h1SNR.R2.toFixed(decimal)) : null,
        s1: h1SNR.S1 ? parseFloat(h1SNR.S1.toFixed(decimal)) : null,
        s2: h1SNR.S2 ? parseFloat(h1SNR.S2.toFixed(decimal)) : null
      }
    };
    aiMappings.lastUpdate = Date.now();
    saveMappings();

    messageHistory.unshift({
      id: Date.now(), type: 'mapping', timestamp: Date.now(),
      data: { session: sessionName, symbol, harga: tickHarga, harga_signal: hargaSignal, source: tick.source, signal_source: 'M15_CLOSED', bias_primary: 'H1', entry_type: entryType, bias, confidence, entry: entryNum, sl: slNum, tp1: tp1Num, tp2: tp2Num, tp3: tp3Num, indicators: aiMappings[sessionName].indicators, telegram_msg: msg }
    });
    if (messageHistory.length > 100) messageHistory.pop();
    saveHistory();

    console.log(`✅ [${sessionName}] Step 11 — SELESAI. mapping ${bias} ${confidence}% | Entry ${entryType}@${entryNum.toFixed(decimal)} | H1:${h1Analysis?.signal} H4-info:${h4TrendInfo}`);
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

    const candlesAll=await getOHLC(symbol,'5min',300);
    const candlesM15All=await getOHLC(symbol,'15min',200);
    const candlesH1All=await getOHLC(symbol,'1h',200);

    const candles = candlesAll.length > 1 ? candlesAll.slice(0, -1) : candlesAll;
    const candlesM15 = candlesM15All.length > 1 ? candlesM15All.slice(0, -1) : candlesM15All;
    const candlesH1 = candlesH1All.length > 1 ? candlesH1All.slice(0, -1) : candlesH1All;

    if(candles.length<50) return res.json({symbol,harga:parseFloat(tickHarga.toFixed(decimal)),harga_source:tick.source,signal:'WAIT',score:0,session:getMarketSession()});

    const snr=detectSNR(candlesH1);
    const liq=detectLiquidity(candlesH1);
    const analysis=analyzeCandles(candlesH1,symbol,snr,liq);
    const mtf=await checkMultiTimeframe(symbol);
    const atr=calculateATR(candles,14);
    const atrProfile=getATRProfile(candles);

    const rsi = calculateRSI(candlesM15, 14);
    const superTrend = calculateSuperTrend(candlesM15, 10, 3.0);
    const emaDistance = calculateEMADistance(candlesM15);
    const fvgs = detectFVG(candlesM15);
    const poc = detectPOC(candlesM15);

    let rsiStatus = 'NEUTRAL';
    if (rsi < 30) rsiStatus = 'OVERSOLD';
    else if (rsi > 70) rsiStatus = 'OVERBOUGHT';

    if (analysis && analysis.signal !== 'WAIT' && analysis.confidence < MIN_CONFIDENCE) {
      return res.json({
        symbol, harga: parseFloat(tickHarga.toFixed(decimal)), harga_source: tick.source,
        signal: 'WAIT', score: analysis.score, confidence: 0,
        entry: null, sl: null, tp1: null, tp2: null, tp3: null,
        session: getMarketSession(), reason: `Signal lemah (${analysis.confidence}% < ${MIN_CONFIDENCE}%)`,
        mtf, snr,
        signal_source: 'H1_CLOSED',
        indicators: {
          rsi: parseFloat(rsi.toFixed(1)), rsi_status: rsiStatus,
          supertrend: superTrend.trend,
          supertrend_value: parseFloat((superTrend.value || 0).toFixed(decimal)),
          ema_distance: emaDistance.distance, ema_strength: emaDistance.strength,
          fvg_count: Math.min(fvgs.length, 20),
          poc: poc ? parseFloat(poc.toFixed(decimal)) : null
        }
      });
    }

    const MAX_JARAK_SIGNAL = Math.max(atr * 1.5, 8);
    const entryPickSignal = pickEntryByLevel(tickHarga, snr, fvgs, poc, analysis ? analysis.signal : 'WAIT', MAX_JARAK_SIGNAL);

    if (!entryPickSignal) {
      return res.json({
        symbol, harga: parseFloat(tickHarga.toFixed(decimal)), harga_source: tick.source,
        signal: 'WAIT', score: 0, confidence: 0,
        entry: null, sl: null, tp1: null, tp2: null, tp3: null,
        session: getMarketSession(), reason: 'Tiada SNR/FVG/POC dekat',
        mtf, snr,
        signal_source: 'H1_CLOSED',
        indicators: {
          rsi: parseFloat(rsi.toFixed(1)), rsi_status: rsiStatus,
          supertrend: superTrend.trend,
          supertrend_value: parseFloat((superTrend.value || 0).toFixed(decimal)),
          ema_distance: emaDistance.distance, ema_strength: emaDistance.strength,
          fvg_count: Math.min(fvgs.length, 20),
          poc: poc ? parseFloat(poc.toFixed(decimal)) : null
        }
      });
    }

    const finalEntry = entryPickSignal.level;
    const entryType = entryPickSignal.type;
    const sltpFinal = analysis && analysis.signal !== 'WAIT' && atr > 0
      ? calculateSLTP(analysis.signal, finalEntry, atr, symbol, atrProfile)
      : null;

    res.json({
      symbol, harga: parseFloat(tickHarga.toFixed(decimal)), harga_source: tick.source,
      signal: analysis ? analysis.signal : 'WAIT',
      score: analysis ? analysis.score : 0,
      confidence: analysis ? analysis.confidence : 0,
      entry: parseFloat(finalEntry.toFixed(decimal)), entry_type: entryType,
      sl: sltpFinal ? parseFloat(sltpFinal.sl) : null,
      tp1: sltpFinal ? parseFloat(sltpFinal.tp1) : null,
      tp2: sltpFinal ? parseFloat(sltpFinal.tp2) : null,
      tp3: sltpFinal ? parseFloat(sltpFinal.tp3) : null,
      session: getMarketSession(), mtf, snr,
      signal_source: 'H1_CLOSED',
      indicators: {
        rsi: parseFloat(rsi.toFixed(1)), rsi_status: rsiStatus,
        supertrend: superTrend.trend,
        supertrend_value: parseFloat((superTrend.value || 0).toFixed(decimal)),
        ema_distance: emaDistance.distance, ema_strength: emaDistance.strength,
        fvg_count: Math.min(fvgs.length, 20),
        poc: poc ? parseFloat(poc.toFixed(decimal)) : null
      }
    });
  }catch(e){
    console.log(`❌ [SIGNAL] ${symbol} error:`, e.message);
    res.status(500).json({error:e.message, signal:'WAIT', score:0});
  }
});

app.get('/api/mapping',(req,res)=>{res.json({status:'OK',mappings:aiMappings,current_session:getMarketSession(),timestamp:Date.now()})});
app.get('/api/market',async(req,res)=>{const symbol=req.query.symbol||'XAU/USD';const decimal=getDecimal(symbol);try{const tick=await getTick(symbol);const candlesAll=await getOHLC(symbol,'1h',200);const candles = candlesAll.length > 1 ? candlesAll.slice(0, -1) : candlesAll;const harga=tick.mid||(candles.length?candles[candles.length-1].close:0);if(!harga)return res.status(503).json({error:'No price data'});const snr=detectSNR(candles);const liq=detectLiquidity(candles);res.json({symbol,harga:parseFloat(harga.toFixed(decimal)),harga_source:tick.source,spread:parseFloat(tick.spread.toFixed(decimal)),spread_ok:isSpreadOK(symbol,tick.spread),POC:snr.POC?parseFloat(snr.POC.toFixed(decimal)):null,R1:snr.R1?parseFloat(snr.R1.toFixed(decimal)):null,R2:snr.R2?parseFloat(snr.R2.toFixed(decimal)):null,R3:snr.R3?parseFloat(snr.R3.toFixed(decimal)):null,S1:snr.S1?parseFloat(snr.S1.toFixed(decimal)):null,S2:snr.S2?parseFloat(snr.S2.toFixed(decimal)):null,S3:snr.S3?parseFloat(snr.S3.toFixed(decimal)):null,liquidity:liq,session:getMarketSession()})}catch(e){res.status(500).json({error:e.message})}});
app.get('/api/messages',(req,res)=>{const limit=parseInt(req.query.limit)||50;const type=req.query.type;let filtered=messageHistory;if(type&&type!=='all'){const types=type.split(',').map(t=>t.trim());filtered=messageHistory.filter(m=>types.includes(m.type))}const stats={signal:messageHistory.filter(m=>m.type==='signal').length,mapping:messageHistory.filter(m=>m.type==='mapping').length,asia_breakout:messageHistory.filter(m=>m.type==='asia_breakout').length,level_alert:messageHistory.filter(m=>m.type==='level_alert').length,news_alert:messageHistory.filter(m=>m.type==='news_alert').length,daily_outlook:messageHistory.filter(m=>m.type==='daily_outlook').length,pre_market:messageHistory.filter(m=>m.type==='pre_market').length,liquidity_sweep:messageHistory.filter(m=>m.type==='liquidity_sweep').length};res.json({status:'OK',messages:filtered.slice(0,limit),stats})});
app.get('/api/news',async(req,res)=>{const events=await fetchNews();res.json({status:'success',events})});
app.get('/api/health',(req,res)=>{res.json({status:'OK',version:'3.8.1',session:getMarketSession(),myt:new Date(Date.now()+8*60*60*1000).toISOString(),mappings:Object.keys(aiMappings).filter(k=>aiMappings[k]&&k!=='lastUpdate').length,ea_online:(Date.now()-eaStatus.lastSeen)<30000,min_confidence:MIN_CONFIDENCE,min_entry_dist:2,signal_source:'M15_CLOSED',bias_primary:'H1',h4_role:'info_only',telegram_configured:!!(TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID)})});

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

const PORT=process.env.PORT||3000;
app.listen(PORT,()=>{console.log(`🚀 BPT v3.8.1 running on ${PORT} | MYT: ${new Date(Date.now()+8*60*60*1000).toISOString()} | Bias: H1 | H4: info only | Signal: M15 CLOSED`)});