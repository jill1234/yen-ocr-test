'use strict';
const $=id=>document.getElementById(id);
const state={stream:null,worker:null,scanning:false,locked:false,busy:false,lastCandidate:null,streak:0,log:[],lastAt:0,seq:0,lastIncluded:null};
const setStatus=s=>{$('status').textContent=s};
const setNetwork=()=>{$('network').textContent=navigator.onLine?'● 已連網':'○ 離線'};
window.addEventListener('online',setNetwork);window.addEventListener('offline',setNetwork);setNetwork();
if('serviceWorker' in navigator){navigator.serviceWorker.register('./sw.js').catch(()=>{});}
$('start').onclick=async()=>{try{if(!navigator.mediaDevices?.getUserMedia)throw Error('瀏覽器不支援相機 API，請使用 HTTPS 或 Safari。');if(state.stream)state.stream.getTracks().forEach(t=>t.stop());state.stream=await navigator.mediaDevices.getUserMedia({audio:false,video:{facingMode:{ideal:'environment'},width:{ideal:1280},height:{ideal:720}}});$('video').srcObject=state.stream;await $('video').play();$('cameraBadge').textContent='相機已開啟';setStatus('相機正常。請載入 OCR 模型。');refresh();}catch(e){setStatus('相機無法啟動：'+e.message+'。請檢查 Safari 相機權限。');}};
$('ocr').onclick=async()=>{if(state.worker){setStatus('OCR 模型已載入');return}if(typeof Tesseract==='undefined'){setStatus('OCR 程式未載入，請連網重新整理。');return}const lang=$('language').value;$('ocr').disabled=true;setStatus('正在下載／載入 '+lang+' 模型，首次可能需要一些時間…');try{state.worker=await Tesseract.createWorker(lang,1,{logger:m=>{if(m.status==='loading language traineddata'||m.status==='initializing api')setStatus('載入模型：'+m.status+' '+Math.round((m.progress||0)*100)+'%')}});setStatus('OCR 模型已就緒，可開始掃描。');$('ocr').textContent='模型已就緒';refresh();}catch(e){setStatus('OCR 載入失敗：'+e.message);$('ocr').disabled=false;}};
$('language').onchange=()=>{if(state.worker)setStatus('已載入的模型不會自動更換；重新整理頁面後再選擇語言。')};
function refresh(){$('scan').disabled=!(state.stream&&state.worker);$('lock').disabled=!state.scanning;$('scan').textContent=state.scanning?'停止掃描':'開始掃描';$('lock').textContent=state.locked?'解除鎖定':'鎖定價格';}
$('scan').onclick=()=>{state.scanning=!state.scanning;state.locked=false;state.lastCandidate=null;state.lastIncluded=null;state.streak=0;refresh();if(state.scanning){setStatus('掃描中，請將價格對準中央框…');scanLoop();}else setStatus('掃描已停止');};
$('lock').onclick=()=>{state.locked=!state.locked;refresh();setStatus(state.locked?'價格已鎖定，辨識暫停':'已解除鎖定，繼續掃描');if(!state.locked&&state.scanning)scanLoop();};
// V0.2：依行判斷稅別，避免相鄰行的「税込」錯配到未稅價格。
function parsePrices(raw){
  const text=raw.normalize('NFKC').replace(/\\(?=\s*[0-9])/g,'¥').replace(/\bY\s*(?=\d)/gi,'¥');
  const found=[];
  const amountRe=/(?:[¥]\s*)?([0-9]{1,3}(?:,\s*[0-9]{3})+|[0-9]{2,7})(?:\s*(?:円|yen))?/gi;
  const lines=text.split(/\r?\n/);
  for(let lineIndex=0;lineIndex<lines.length;lineIndex++){
    const line=lines[lineIndex];let m;
    while((m=amountRe.exec(line))!==null){
      const amount=Number(m[1].replace(/[,\s]/g,''));
      if(!Number.isFinite(amount)||amount<10||amount>9999999)continue;
      const left=line.slice(0,m.index),right=line.slice(amountRe.lastIndex);
      // 先看價格左側最近的稅別；若沒有，才看同一行右側。
      const labelRe=/(税込|含税|含稅|総額|税抜|税別|本体価格|本体|免税|免稅|TAX\s*FREE)/gi;
      const labels=[...left.matchAll(labelRe)];
      let label=labels.length?labels[labels.length-1][0]:null;
      if(!label){const rightLabel=right.match(labelRe);if(rightLabel)label=rightLabel[0];}
      let type='unknown';
      if(label){if(/税込|含税|含稅|総額/i.test(label))type='included';else if(/税抜|税別|本体/i.test(label))type='excluded';else if(/免税|免稅|TAX\s*FREE/i.test(label))type='taxfree';}
      const explicitCurrency=/¥|円|JPY/i.test(m[0]);
      const score=(type==='included'?100:type==='excluded'?-40:type==='taxfree'?-20:0)+(explicitCurrency?5:0);
      found.push({amount,type,score,line:lineIndex+1,near:line.trim(),reason:type==='included'?'同一行含稅標示':type==='excluded'?'同一行未稅標示':type==='taxfree'?'同一行免稅標示':'未辨識到稅別'});
    }
    amountRe.lastIndex=0;
  }
  const taxPreferred=$('tax').checked;
  return found.sort((a,b)=>(taxPreferred?b.score-a.score:0)||a.line-b.line);
}
function selectCandidate(candidates){
  const current=Number($('price').dataset.value);
  const included=candidates.find(c=>c.type==='included');
  const previousIncluded=state.lastIncluded;
  if($('tax').checked&&included){state.lastIncluded={amount:included.amount,at:state.seq};return {...included,reason:'同一行含稅標示，優先選擇'};}
  // 前一輪已明確辨識含稅價時，短暫 OCR 漏字不應立即降為未稅價。
  if($('tax').checked&&previousIncluded&&state.seq-previousIncluded.at<=5){
    const matched=candidates.find(c=>c.amount===previousIncluded.amount);
    if(matched)return {...matched,reason:'延續近期確認的含稅價格'};
    return {amount:previousIncluded.amount,type:'included',score:100,reason:'短暫未辨識含稅價，暫時保留'};
  }
  return {...candidates[0],reason:candidates[0].reason};
}
function renderCandidates(candidates){const el=$('candidates');el.replaceChildren();const seen=new Set();for(const c of candidates){if(seen.has(c.amount))continue;seen.add(c.amount);const b=document.createElement('button');b.className='candidate'+(Number($('price').dataset.value)===c.amount?' active':'');b.textContent='¥'+c.amount.toLocaleString('en-US');b.onclick=()=>{state.locked=true;state.lastIncluded=null;$('price').dataset.value=c.amount;$('price').textContent='¥'+c.amount.toLocaleString('en-US');setStatus('已手動選擇並鎖定價格');refresh();renderCandidates(candidates)};el.appendChild(b);if(seen.size>=5)break;}}
function capture(){const v=$('video'),c=$('canvas');if(!v.videoWidth)throw Error('相機尚未取得影像');const x=Math.round(v.videoWidth*.15),y=Math.round(v.videoHeight*.30),w=Math.round(v.videoWidth*.70),h=Math.round(v.videoHeight*.40);c.width=Math.min(1000,w);c.height=Math.round(h*c.width/w);c.getContext('2d',{willReadFrequently:true}).drawImage(v,x,y,w,h,0,0,c.width,c.height);return c;}
async function scanLoop(){if(state.busy||!state.scanning||state.locked)return;state.busy=true;const started=performance.now();try{const result=await state.worker.recognize(capture());const raw=result.data.text||'';const candidates=parsePrices(raw);const elapsed=Math.round(performance.now()-started);state.seq++;let selected;$('raw').textContent=raw.trim()||'（未辨識到文字）';if(candidates.length){selected=selectCandidate(candidates);const chosen=selected.amount;if(chosen===state.lastCandidate)state.streak++;else{state.lastCandidate=chosen;state.streak=1}if(!$('stability').checked||state.streak>=2){$('price').dataset.value=chosen;$('price').textContent='¥'+chosen.toLocaleString('en-US');}renderCandidates(candidates);setStatus(`第 ${state.seq} 次辨識｜${elapsed} ms｜${state.streak>=2?'價格已穩定':'等待再次確認'}｜候選 ${candidates.length} 筆｜${selected.reason}`);}else{state.lastCandidate=null;state.streak=0;setStatus(`第 ${state.seq} 次辨識｜${elapsed} ms｜未找到價格，保留前次結果`);renderCandidates([]);}state.log.push({time:new Date().toISOString(),elapsed,raw:raw.replace(/\s+/g,' ').trim(),chosen:typeof selected!=='undefined'?selected.amount:'',reason:typeof selected!=='undefined'?selected.reason:'未找到價格',shown:$('price').dataset.value||'',count:candidates.length});$('stats').textContent=`辨識次數：${state.seq}｜最近一次：${elapsed} ms｜紀錄：${state.log.length} 筆`;}catch(e){setStatus('辨識錯誤：'+e.message)}finally{state.busy=false;if(state.scanning&&!state.locked)setTimeout(scanLoop,Number($('interval').value));}}
$('clear').onclick=()=>{state.log=[];state.seq=0;$('stats').textContent='辨識次數：0';$('raw').textContent='尚無辨識文字';};
$('export').onclick=()=>{if(!state.log.length){setStatus('尚無測試紀錄可匯出');return}const cols=['time','elapsed','raw','chosen','shown','count','reason'];const csv='\ufeff'+[cols.join(','),...state.log.map(r=>cols.map(k=>'"'+String(r[k]??'').replace(/"/g,'""')+'"').join(','))].join('\r\n');const a=document.createElement('a'),url=URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8'}));a.href=url;a.download='yen-ocr-test-'+new Date().toISOString().slice(0,10)+'.csv';a.click();setTimeout(()=>URL.revokeObjectURL(url),2000)};
document.addEventListener('visibilitychange',()=>{if(document.hidden&&state.scanning){state.scanning=false;refresh();setStatus('切換背景後已停止掃描，返回後請重新啟動。')}});
