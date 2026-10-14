// ===============================================
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