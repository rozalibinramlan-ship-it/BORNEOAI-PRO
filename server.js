// ===============================================
// BPT v1.18 FINAL - FIX SNR LEVELS R1-R3 S1-S3 VAH VAL
// ===============================================
const express = require('express');
const cors = require('cors');
const axios = require('axios');
require('dotenv').config();
const app = express();
app.use(cors());

app.use((req, res, next) => {
    if (req.path === '/api/ea/heartbeat' && req.method === 'POST') {
        express.text({ type: '*/*', limit: '1mb' })(req, res, () => {
            try {
                let raw = (req.body || '').toString().replace(/\x00/g, '').trim();
                const s = raw.indexOf('{'); const e = raw.lastIndexOf('}');
                if (s!== -1 && e!== -1) raw = raw.substring(s, e + 1);
                raw = raw.replace(/[\u0000-\u001F\u007F]+/g, ' ').replace(/\s+/g, ' ');
                req.body = raw? JSON.parse(raw) : {};
            } catch { req.body = {}; }
            next();
        });
    } else express.json({ limit: '1mb' })(req, res, next);
});
app.use(express.static(__dirname));

const URL = 'https://api.twelvedata.com';
const KEYS = [process.env.TWELVEDATA_API_KEY||'',process.env.TWELVEDATA_API_KEY_2||'',process.env.TWELVEDATA_API_KEY_3||''].filter(k=>k);
const getKey = () => KEYS[0]||'';
const getDec = s => s.includes('JPY')?3:(s.includes('XAU')||s.includes('XAG'))?2:5;
const calcEMA = (c,p)=>{if(!c.length)return 0; let e=c[0],k=2/(p+1); for(let i=1;i<c.length;i++)e=c[i]*k+e*(1-k); return e;};
const calcATR = (c,p=14)=>{if(c.length<p+1)return 0.5; let t=[]; for(let i=c.length-p;i<c.length;i++)t.push(Math.max(c[i].high-c[i].low,Math.abs(c[i].high-c[i-1].close),Math.abs(c[i].low-c[i-1].close))); return t.reduce((a,b)=>a+b,0)/p;};
const getSession = ()=>{const h=new Date().getUTCHours(); if(h>=7&&h<16)return"LONDON"; if(h>=12&&h<21)return"NEW YORK"; if(h>=0&&h<7)return"ASIA"; return"CLOSED";};

// SNR LEVELS CALCULATOR - FIX UNDEFINED
const calcSNRLevels = (c, poc, dec) => {
  const d = dec||2;
  if(!c || c.length<20){
    const h=poc||4122;
    return {R3:h+15, R2:h+10, R1:h+5, POC:h, VAH:h+3, VAL:h-3, S1:h-5, S2:h-10, S3:h-15, r3:h+15, r2:h+10, r1:h+5, poc:h, vah:h+3, val:h-3, s1:h-5, s2:h-10, s3:h-15, support:h-5, resistance:h+5};
  }
  const r=c.slice(-20);
  const hi=Math.max(...r.map(x=>x.high));
  const lo=Math.min(...r.map(x=>x.low));
  const range=hi-lo||10;
  const p=poc||(hi+lo)/2;
  return {
    R3: hi+range*0.5, R2: hi+range*0.25, R1: hi,
    POC: p, VAH: p+range*0.2, VAL: p-range*0.2,
    S1: lo, S2: lo-range*0.25, S3: lo-range*0.5,
    r3: hi+range*0.5, r2: hi+range*0.25, r1: hi,
    poc: p, vah: p+range*0.2, val: p-range*0.2,
    s1: lo, s2: lo-range*0.25, s3: lo-range*0.5,
    support: lo, resistance: hi
  };
};

const calcFVG = c=>{let f=[]; for(let i=2;i<c.length;i++){ if(c[i-2].high<c[i].low)f.push({type:"BULLISH",top:c[i].low,bottom:c[i-2].high}); if(c[i-2].low>c[i].high)f.push({type:"BEARISH",top:c[i-2].low,bottom:c[i].high}); } return f.slice(-3);};
const calcPOC = c=>{if(!c)return null; let p=c.flatMap(x=>[x.high,x.low,x.close]).sort((a,b)=>a-b); return p[Math.floor(p.length/2)];};
const analyze = c=>{if(!c||c.length<50)return{signal:'WAIT',confidence:0,ema9:0,ema21:0,ema50:0}; const cl=c.map(x=>x.close); const ema9=calcEMA(cl,9),ema21=calcEMA(cl,21),ema50=calcEMA(cl,50); let b=0,s=0; if(ema9>ema21&&ema21>ema50)b+=70; if(ema9<ema21&&ema21<ema50)s+=70; if(ema9>ema21)b+=20; else s+=20; return{signal:b>s?'BUY':s>b?'SELL':'WAIT',confidence:Math.max(b,s),ema9,ema21,ema50};};

let eaStatus={online:false,lastSeen:0,balance:0,equity:0,accountNumber:''}; let tradeQueue=[],tradeHistory=[];
app.post('/api/ea/heartbeat',(req,res)=>{ const b=req.body||{}; eaStatus={online:true,lastSeen:Date.now(),balance:parseFloat(b.balance||0),equity:parseFloat(b.equity||0),accountNumber:b.accountNumber||''}; res.json({status:'OK'}); });
app.get('/api/ea/status',(req,res)=>{ const on=(Date.now()-eaStatus.lastSeen)<30000; res.json({...eaStatus,online:on}); });
app.get('/api/ea/commands',(req,res)=>{ const p=tradeQueue.filter(c=>c.status==='pending'); if(p.length){p[0].status='sent'; res.json({command:p[0]});}else res.json({command:null}); });
app.post('/api/ea/result',(req,res)=>{ const b=req.body||{}; const cmd=tradeQueue.find(c=>c.id===b.id); if(cmd){cmd.status=b.success?'executed':'failed'; tradeHistory.push(cmd);} res.json({status:'OK'}); });

const tickCache=new Map(),ohlcCache=new Map();
async function getTick(sym){ const ca=tickCache.get(sym); if(ca&&Date.now()-ca.time<30000)return ca.data; try{ const r=await axios.get(`${URL}/quote?symbol=${encodeURIComponent(sym)}&apikey=${getKey()}`,{timeout:8000}); const d=r.data; const mid=parseFloat(d.close||d.price||0)||(parseFloat(d.bid)+parseFloat(d.ask))/2; const resu={bid:parseFloat(d.bid||mid),ask:parseFloat(d.ask||mid),mid}; tickCache.set(sym,{data:resu,[STRIPPED] return resu; }catch{ return{bid:0,ask:0,mid:0}; } }
async function getOHLC(sym,int='5min',lim=100){ const k=`${sym}_${int}_${lim}`; const ca=ohlcCache.get(k); if(ca&&Date.now()-ca.time<60000)return ca.data; try{ const r=await axios.get(`${URL}/time_series?symbol=${encodeURIComponent(sym)}&interval=${int}&outputsize=${lim}&apikey=${getKey()}`,{timeout:8000}); const v=r.data.values; if(!v)return []; const resu=v.slice().reverse().map(c=>({open:parseFloat(c.open),high:parseFloat(c.high),low:parseFloat(c.low),close:parseFloat(c.close)})); ohlcCache.set(k,{data:resu,[STRIPPED] return resu; }catch{ return []; } }

async function getMultiTF(symbol){
  const tfs=['5min','15min','30min','1h']; const labels=['M5','M15','M30','H1'];
  try{
    const all=await Promise.all(tfs.map(tf=>getOHLC(symbol,tf,80)));
    let result={}; let buys=0,sells=0;
    all.forEach((c,i)=>{
      const a=analyze(c);
      result[labels[i]]=a.signal;
      result[labels[i].toLowerCase()]={signal:a.signal,confidence:a.confidence};
      if(a.signal==='BUY')buys++; else if(a.signal==='SELL')sells++;
    });
    return{...result, agreement:`${Math.max(buys,sells)}/4`, bias:buys>sells?'BUY':sells>buys?'SELL':'WAIT', buys, sells};
  }catch{ return {M5:'WAIT',M15:'WAIT',M30:'WAIT',H1:'WAIT',m5:{signal:'WAIT'},m15:{signal:'WAIT'},m30:{signal:'WAIT'},h1:{signal:'WAIT'},agreement:'0/4',bias:'WAIT'}; }
}

app.get('/api/market',async(req,res)=>{
  const symbol=req.query.symbol||'XAU/USD'; const dec=getDec(symbol);
  try{
    const tick=await getTick(symbol); const c5=await getOHLC(symbol,'5min',100);
    if(!c5.length) return res.json({status:"No Market", symbol, ema9:0, ema_9:0, EMA9:0, M5:'WAIT', agreement:'0/4', entry:0, sl:0, tp1:0, R1:0, R2:0, R3:0, S1:0, S2:0, S3:0});
    const harga=tick.mid||c5[c5.length-1].close; const ema=analyze(c5); const atr=calcATR(c5,14); const mtf=await getMultiTF(symbol);
    const e9=parseFloat(ema.ema9.toFixed(dec)), e21=parseFloat(ema.ema21.toFixed(dec)), e50=parseFloat(ema.ema50.toFixed(dec));
    const pocRaw=calcPOC(c5)||harga;
    const levels=calcSNRLevels(c5, pocRaw, dec);

    const fix = v=>parseFloat(v.toFixed(dec));
    res.json({
      status:"OK", symbol, harga:fix(harga), price:fix(harga), bid:fix(tick.bid), ask:fix(tick.ask), spread:0,
      ema9:e9, ema21:e21, ema50:e50, ema_9:e9, ema_21:e21, ema_50:e50, ema9_value:e9, EMA9:e9, EMA21:e21, EMA50:e50,
      ema:{ema9:e9,ema21:e21,ema50:e50, ema_9:e9, trend:e21>e50?"BULLISH":"BEARISH"},
      support:fix(levels.S1), resistance:fix(levels.R1), snr:levels, levels:levels,
      // SNR ALL ALIAS - FIX UNDEFINED
      R3:fix(levels.R3), R2:fix(levels.R2), R1:fix(levels.R1),
      VAH:fix(levels.VAH), VAL:fix(levels.VAL),
      S1:fix(levels.S1), S2:fix(levels.S2), S3:fix(levels.S3),
      POC:fix(levels.POC), poc:fix(levels.POC),
      r3:fix(levels.R3), r2:fix(levels.R2), r1:fix(levels.R1),
      vah:fix(levels.VAH), val:fix(levels.VAL),
      s1:fix(levels.S1), s2:fix(levels.S2), s3:fix(levels.S3),
      fvg:calcFVG(c5),
      signal:ema.signal, action:ema.signal, confidence:ema.confidence,
      M5:mtf.M5, M15:mtf.M15, M30:mtf.M30, H1:mtf.H1, m5:mtf.M5, m15:mtf.M15, m30:mtf.M30, h1:mtf.H1, timeframe:mtf, agreement:mtf.agreement, bias:mtf.bias,
      entry:fix(harga), harga_entry:fix(harga), sl:fix(harga-atr*1.5), tp1:fix(harga+atr*3), tp2:fix(harga+atr*6), tp3:fix(harga+atr*10),
      session:getSession(), time:new Date().toLocaleTimeString()
    });
  }catch(e){ console.log(e); res.json({status:"Error", R1:0,R2:0,R3:0,S1:0,S2:0,S3:0,VAH:0,VAL:0,ema9:0, M5:'WAIT', agreement:'0/4', entry:0, sl:0, tp1:0}); }
});

app.get('/api/signal',async(req,res)=>{
  const symbol=req.query.symbol||'XAU/USD'; const dec=getDec(symbol);
  try{
    const c5=await getOHLC(symbol,'5min',100); if(!c5.length) return res.json({symbol,status:'No Data',ema9:0,R1:0,S1:0,agreement:'0/4'});
    const harga=c5[c5.length-1].close; const ema=analyze(c5); const atr=calcATR(c5,14); const mtf=await getMultiTF(symbol);
    const e9=parseFloat(ema.ema9.toFixed(dec)), e21=parseFloat(ema.ema21.toFixed(dec)), e50=parseFloat(ema.ema50.toFixed(dec));
    const pocRaw=calcPOC(c5)||harga; const levels=calcSNRLevels(c5,pocRaw,dec); const fix=v=>parseFloat(v.toFixed(dec));
    res.json({symbol, price:fix(harga), harga:fix(harga), signal:ema.signal, action:ema.signal, confidence:ema.confidence, ema9:e9, ema21:e21, ema50:e50, ema_9:e9, EMA9:e9, R3:fix(levels.R3), R2:fix(levels.R2), R1:fix(levels.R1), VAH:fix(levels.VAH), VAL:fix(levels.VAL), S1:fix(levels.S1), S2:fix(levels.S2), S3:fix(levels.S3), POC:fix(levels.POC), M5:mtf.M5, M15:mtf.M15, M30:mtf.M30, H1:mtf.H1, agreement:mtf.agreement, entry:fix(harga), sl:fix(harga-atr*1.5), tp1:fix(harga+atr*3), status:"OK"});
  }catch(e){ res.json({status:"Error",R1:0,S1:0}); }
});

app.get('/api/news',async(req,res)=>{
  try{
    const sym=(req.query.symbol||'XAU/USD').split('/')[0]; let news=[];
    try{ const r=await axios.get(`${URL}/news?symbol=${encodeURIComponent(sym)}&apikey=${getKey()}`,{timeout:8000}); if(r.data&&r.data.articles) news=r.data.articles.slice(0,10).map(n=>({time:new Date(n.datetime||Date.now()).toLocaleTimeString(),title:n.title||'Market News',event:n.title||'News',impact:'High',currency:sym})); }catch{}
    if(!news.length){ const h=new Date().getUTCHours(); news=[{time:`${h}:00`,title:`LONDON Session - ${sym} Volatile`,event:"Market Open",impact:"High",currency:sym}]; }
    res.json({status:"OK",news,count:news.length});
  }catch{ res.json({status:"OK",news:[{time:new Date().toLocaleTimeString(),title:"Market Active",event:"Market",impact:"Low"}],count:1}); }
});

app.get('/health',(req,res)=>res.json({status:'OK',version:'1.18'}));
app.get('/',(req,res)=>res.sendFile(__dirname+'/index.html'));
const PORT=process.env.PORT||3000;
app.listen(PORT,()=>console.log(`🚀 BPT v1.18 SNR FIX running ${PORT}`));