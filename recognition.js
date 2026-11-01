/* BojoCamReject v3.1: all distinct faces seen during motion are locally captured on the viewer computer.
   Captured photos/events are kept in this browser IndexedDB and are NEVER sent to the phone.
   Explicitly added reference face descriptors may still synchronize between the paired devices. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const $all = sel => [...document.querySelectorAll(sel)];
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const MODEL_URL = 'https://cdn.jsdelivr.net/gh/justadudewhohacks/face-api.js@0.22.2/weights';
  const DETECTION_INTERVAL = 1100;
  const EVENT_COOLDOWN_MS = 18000;
  const MAX_EVENTS = 100;
  const nodes = { viewer: $('remoteVideo'), overlay: $('recognitionOverlay') };
  let dbPromise, faces = [], monitoring = false, busy = false, modelsPromise = null;
  let lastMotionFrame = null, motionUntil = 0, lastDetection = 0, timer = null;
  let detections = [], lastEventAt = new Map(), activeAlert = false;
  let faceTracks = [], nextTrackId = 1, alertQueue = [], displayedEvent = null;
  let aiEnabled = false;
  const status = text => { $('aiStatus').textContent = text; };
  const toast = text => {const out = $('aiToast');out.textContent=text;out.classList.remove('hidden');setTimeout(()=>out.classList.add('hidden'),4500);};

  function getDatabase() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve,reject) => {
      const req = indexedDB.open('BojoCamRejectAI_v3',1);
      req.onupgradeneeded = () => {
        const db=req.result;
        if (!db.objectStoreNames.contains('faces')) db.createObjectStore('faces',{keyPath:'id'});
        if (!db.objectStoreNames.contains('events')) db.createObjectStore('events',{keyPath:'id'});
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }
  async function allFrom(store) {
    const db=await getDatabase();
    return new Promise((resolve,reject)=>{const r=db.transaction(store,'readonly').objectStore(store).getAll();r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
  }
  async function saveTo(store,record) {
    const db=await getDatabase();
    return new Promise((resolve,reject)=>{const r=db.transaction(store,'readwrite').objectStore(store).put(record);r.onsuccess=()=>resolve();r.onerror=()=>reject(r.error);});
  }
  async function deleteFrom(store,id) {
    const db=await getDatabase();
    return new Promise((resolve,reject)=>{const r=db.transaction(store,'readwrite').objectStore(store).delete(id);r.onsuccess=()=>resolve();r.onerror=()=>reject(r.error);});
  }
  async function clearStore(store) {
    const db=await getDatabase();
    return new Promise((resolve,reject)=>{const r=db.transaction(store,'readwrite').objectStore(store).clear();r.onsuccess=()=>resolve();r.onerror=()=>reject(r.error);});
  }
  async function loadModels() {
    if (modelsPromise) return modelsPromise;
    if (!window.faceapi) throw Error('Библиотеката за лица не се зареди. Провери интернет и отвори сайта отново.');
    status('Зареждане на AI моделите — първото зареждане изисква интернет…');
    modelsPromise = Promise.all([
      faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL),
      faceapi.nets.faceLandmark68TinyNet.loadFromUri(MODEL_URL),
      faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL),
      faceapi.nets.faceExpressionNet.loadFromUri(MODEL_URL),
      faceapi.nets.ageGenderNet.loadFromUri(MODEL_URL)
    ]).catch(e => {modelsPromise=null;throw e;});
    await modelsPromise;
    aiEnabled=true;
    status('AI е готов · наблюдението е изключено');
    return true;
  }
  async function onAIEnable() {
    const btn=$('toggleRecognitionBtn');
    if (monitoring) {stop();return;}
    btn.disabled=true;
    try {
      await loadModels();
      monitoring=true;
      lastMotionFrame=null;
      motionUntil=0;
      faceTracks=[]; lastEventAt.clear(); alertQueue=[];
      btn.textContent='⏸ Спри наблюдението';
      btn.classList.add('is-on');
      status('AI наблюдение е включено · очаква движение и лице…');
      $('aiReadyBadge').textContent='AI АКТИВЕН';
      $('aiReadyBadge').classList.add('ready');
      tick();
      timer=setInterval(tick,DETECTION_INTERVAL);
    } catch (e) {
      status('Не мога да заредя AI моделите. Необходимо е интернет свързване.');
      toast(e.message||'Грешка при зареждането на AI');
    } finally { btn.disabled=false; }
  }
  function stop() {
    monitoring=false;busy=false;lastMotionFrame=null;motionUntil=0;detections=[];faceTracks=[];lastEventAt.clear();
    if(timer) clearInterval(timer);timer=null;
    $('toggleRecognitionBtn').textContent='▶ Включи AI наблюдение';
    $('toggleRecognitionBtn').classList.remove('is-on');
    $('aiReadyBadge').textContent='AI ИЗКЛЮЧЕН';
    $('aiReadyBadge').classList.remove('ready');
    status('Наблюдението е изключено');
    clearOverlay();
  }
  function resizedMotionFrame(v) {
    const c=$('motionCanvas'),ct=c.getContext('2d',{willReadFrequently:true});
    ct.drawImage(v,0,0,c.width,c.height);
    return ct.getImageData(0,0,c.width,c.height).data;
  }
  function detectedMotion(v) {
    const pixels=resizedMotionFrame(v), prev=lastMotionFrame;
    let changed=0, compared=0;
    if (prev) {
      for(let i=0;i<pixels.length;i+=16) {
        const lum=(pixels[i]*3+pixels[i+1]*6+pixels[i+2])/10;
        const before=(prev[i]*3+prev[i+1]*6+prev[i+2])/10;
        if(Math.abs(lum-before)>26) changed++;
        compared++;
      }
    }
    // Do not retain raw video frames beyond this lightweight motion sample.
    lastMotionFrame=new Uint8ClampedArray(pixels);
    const ratio=prev ? changed/Math.max(1,compared) : 0;
    $('motionLevel').textContent=prev?Math.round(ratio*100)+'%':'—';
    $('motionMeterFill').style.width=(Math.min(ratio*500,100))+'%';
    return ratio > Number($('sensitivitySlider').value)/100;
  }
  const faceOptions = () => new faceapi.TinyFaceDetectorOptions({inputSize:window.matchMedia('(max-width:700px)').matches?416:608,scoreThreshold:0.42});
  function approximateAge(age) {
    if (!Number.isFinite(age)) return 'Неопределена';
    const low=Math.max(0,Math.round(age/10)*10-5);
    return `${low}–${low+10} години (ориентировъчно)`;
  }
  function expressionOf(expr) {
    if (!expr) return 'Неопределено';
    const ordered=Object.entries(expr).sort((a,b)=>b[1]-a[1]);
    if (!ordered.length||ordered[0][1]<0.58) return 'Неясно изражение';
    const dictionary={happy:'Усмивка',sad:'Тъжно изражение',neutral:'Неутрално изражение',angry:'Намръщено изражение',surprised:'Изненадано изражение',fearful:'Напрегнато изражение',disgusted:'Гримаса'};
    return dictionary[ordered[0][0]]||'Неясно изражение';
  }
  function closestMatch(desc) {
    if (!faces.length) return {name:'Непознато лице',matched:false,distance:null};
    let chosen=null,best=Infinity;
    for(const f of faces) {
      const arr=f.descriptor;
      if(!arr||arr.length!==desc.length) continue;
      const distance=Math.sqrt(arr.reduce((sum,n,i)=>sum+(n-desc[i])**2,0));
      if(distance<best){best=distance;chosen=f;}
    }
    // Conservative threshold reduces (but never eliminates) false matches.
    return best<=0.48&&chosen ? {name:chosen.name,matched:true,distance:best} : {name:'Непознато лице',matched:false,distance:best};
  }
  // Assign a track to each visible face, including multiple unknown faces in the same frame.
  // A track is matched by descriptor AND position, and each detection gets a unique track.
  // This is a de-duplication heuristic, not a reliable identity classifier.
  function assignFaceTracks(items, video) {
    const now = Date.now(), alreadyUsed = new Set();
    faceTracks = faceTracks.filter(t => now-t.lastSeen < 25000);
    for (const item of items) {
      const box = item.result.detection.box;
      const cx = (box.x + box.width/2) / video.videoWidth;
      const cy = (box.y + box.height/2) / video.videoHeight;
      const desc = item.result.descriptor;
      let candidate = null, bestScore = Infinity;
      for (const track of faceTracks) {
        if (alreadyUsed.has(track.id)) continue;
        let squared = 0;
        for (let j=0;j<desc.length;j++) squared+=(desc[j]-track.descriptor[j])**2;
        const d=Math.sqrt(squared);
        const p=Math.hypot(cx-track.cx, cy-track.cy);
        if (d>0.52 || p>0.32) continue;
        const score=d+(p*0.5);
        if (score<bestScore) {candidate=track;bestScore=score;}
      }
      if (!candidate) {
        candidate={id:nextTrackId++,lastSeen:now,descriptor:Array.from(desc),cx,cy};
        faceTracks.push(candidate);
      } else {
        candidate.lastSeen=now; candidate.descriptor=Array.from(desc);
        candidate.cx=cx; candidate.cy=cy;
      }
      item.trackId=candidate.id;
      alreadyUsed.add(candidate.id);
    }
    for (const k of lastEventAt.keys()) {
      if (!faceTracks.some(t=>t.id===k)) lastEventAt.delete(k);
    }
  }
  async function tick() {
    const v=nodes.viewer;
    if(!monitoring||busy||!aiEnabled||!v||v.readyState<2||!v.videoWidth) return;
    if (document.visibilityState!=='visible') return;
    try {
      if(detectedMotion(v)) motionUntil=Date.now()+3500;
      if(Date.now()>motionUntil){detections=[];clearOverlay();status('Няма движение · наблюдението е активно');return;}
      if(Date.now()-lastDetection<800) return;
      busy=true; lastDetection=Date.now();
      status('Движение засечено · сканиране на лица…');
      const found=await faceapi.detectAllFaces(v,faceOptions())
        .withFaceLandmarks(true).withFaceExpressions().withAgeAndGender().withFaceDescriptors();
      detections=found.map(r=>({result:r,match:closestMatch(r.descriptor)}));
      assignFaceTracks(detections,v);
      drawOverlay();
      if(found.length) {
        status(`Движение · открити лица: ${found.length} · ${new Date().toLocaleTimeString('bg-BG')}`);
        for(const item of detections) await maybeCapture(v,item);
      } else status('Движение засечено, но няма ясно видимо лице');
    } catch(e){status('AI грешка: '+String(e.message||e).slice(0,160));}
    finally{busy=false;}
  }
  function displayGeometry(v,c) {
    const box=c.getBoundingClientRect(), ratio=Math.min(box.width/v.videoWidth,box.height/v.videoHeight);
    return {width:box.width,height:box.height,ratio,offsetX:(box.width-v.videoWidth*ratio)/2,offsetY:(box.height-v.videoHeight*ratio)/2};
  }
  function clearOverlay() {
    const canvas=nodes.overlay;
    if(canvas) canvas.getContext('2d').clearRect(0,0,canvas.width,canvas.height);
  }
  function drawOverlay() {
    const v=nodes.viewer,c=nodes.overlay;
    if(!v?.videoWidth||!c)return;
    const g=displayGeometry(v,c),pixelRatio=Math.min(window.devicePixelRatio||1,2);
    c.width=Math.round(g.width*pixelRatio);c.height=Math.round(g.height*pixelRatio);
    const ctx=c.getContext('2d');ctx.setTransform(pixelRatio,0,0,pixelRatio,0,0);
    ctx.clearRect(0,0,g.width,g.height);
    for(const item of detections){
      const b=item.result.detection.box,x=b.x*g.ratio+g.offsetX,y=b.y*g.ratio+g.offsetY,w=b.width*g.ratio,h=b.height*g.ratio;
      const corner=Math.min(25,w*0.23,h*0.23);
      ctx.lineWidth=3.6;ctx.strokeStyle='#fff451';ctx.shadowColor='#fffa80';ctx.shadowBlur=8;
      ctx.beginPath();ctx.moveTo(x+corner,y);ctx.lineTo(x,y);ctx.lineTo(x,y+corner);
      ctx.moveTo(x+w-corner,y);ctx.lineTo(x+w,y);ctx.lineTo(x+w,y+corner);
      ctx.moveTo(x,y+h-corner);ctx.lineTo(x,y+h);ctx.lineTo(x+corner,y+h);
      ctx.moveTo(x+w-corner,y+h);ctx.lineTo(x+w,y+h);ctx.lineTo(x+w,y+h-corner);ctx.stroke();ctx.shadowBlur=0;
      const points=item.result.landmarks?.positions||[];
      const coord=pos=>({x:pos.x*g.ratio+g.offsetX,y:pos.y*g.ratio+g.offsetY});
      ctx.strokeStyle='rgba(225,240,255,0.6)';ctx.lineWidth=0.8;
      const connect=(arr,closed=false)=>{if(!arr.length)return;ctx.beginPath();arr.forEach((p,i)=>{const z=coord(p);if(i)ctx.lineTo(z.x,z.y);else ctx.moveTo(z.x,z.y);});if(closed)ctx.closePath();ctx.stroke();};
      if(points.length===68){
        connect(points.slice(0,17));connect(points.slice(17,22));connect(points.slice(22,27));
        connect(points.slice(27,31));connect(points.slice(31,36));connect(points.slice(36,42),true);
        connect(points.slice(42,48),true);connect(points.slice(48,60),true);connect(points.slice(60,68),true);
        // Triangular facial mesh decoration, based on detected landmark positions.
        [[0,36],[36,27],[27,42],[42,16],[30,8],[39,31],[31,42],[39,33],[33,42],[21,27],[27,22],[4,48],[48,8],[8,54],[54,12]].forEach(([a,b])=>connect([points[a],points[b]]));
        ctx.fillStyle='#eaffff';for(const p of points){const z=coord(p);ctx.beginPath();ctx.arc(z.x,z.y,1.8,0,Math.PI*2);ctx.fill();}
      }
      const label=(item.match.matched?'ВЪЗМОЖНО: '+item.match.name:'НЕПОЗНАТО ЛИЦЕ');
      ctx.font='bold 12px system-ui, sans-serif';const tw=Math.min(ctx.measureText(label).width+19,g.width-12);
      const labelY=Math.max(5,y-29);ctx.fillStyle='#ffed65';ctx.fillRect(x,labelY,tw,23);ctx.fillStyle='#152334';ctx.fillText(label,x+8,labelY+16,tw-12);
    }
  }
  function faceThumbnail(v,box){
    const can=document.createElement('canvas');can.width=240;can.height=240;
    const p=box.width*0.22;
    const side=Math.max(box.width,box.height)+p*2;
    const cx=box.x+box.width/2,cy=box.y+box.height/2;
    const sx=Math.max(0,cx-side/2),sy=Math.max(0,cy-side/2);
    const size=Math.min(side,v.videoWidth-sx,v.videoHeight-sy);
    can.getContext('2d').drawImage(v,sx,sy,size,size,0,0,240,240);
    return can.toDataURL('image/jpeg',0.77);
  }
  function frameSnapshot(v) {
    const c=document.createElement('canvas');
    const maxW=850,scale=Math.min(1,maxW/v.videoWidth);
    c.width=Math.round(v.videoWidth*scale);c.height=Math.round(v.videoHeight*scale);
    const ctx=c.getContext('2d');ctx.drawImage(v,0,0,c.width,c.height);
    // Include the live face scan overlay (yellow corners and landmark mesh) in saved frames.
    const overlay=nodes.overlay;
    if(overlay?.width&&overlay?.height&&detections.length){
      const g=displayGeometry(v,overlay);
      const pix=overlay.width/g.width;
      try {ctx.drawImage(overlay,g.offsetX*pix,g.offsetY*pix,v.videoWidth*g.ratio*pix,v.videoHeight*g.ratio*pix,0,0,c.width,c.height);}catch(_){ }
    }
    return c.toDataURL('image/jpeg',0.72);
  }
  async function maybeCapture(v,item) {
    const b=item.result.detection.box;
    if(b.width<28||b.height<28) return;
    const key=item.trackId; // Each separately detected face gets its own cooldown, including unknown people.
    if(Date.now()-(lastEventAt.get(key)||0)<EVENT_COOLDOWN_MS)return;
    lastEventAt.set(key,Date.now());
    const event={id:crypto.randomUUID(),created:Date.now(), name:item.match.name,
      matched:item.match.matched,age:approximateAge(item.result.age),expression:expressionOf(item.result.expressions),
      faceImage:faceThumbnail(v,b),frameImage:frameSnapshot(v)};
    // Never send these photos or event metadata over the WebRTC data channel.
    await saveTo('events',event);
    const all=await allFrom('events');
    if(all.length>MAX_EVENTS){all.sort((a,b)=>a.created-b.created);for(const e of all.slice(0,all.length-MAX_EVENTS))await deleteFrom('events',e.id);}
    renderEvents();
    showEvent(event);
  }
  function showEvent(event) {
    if (document.body.classList.contains('phone-selected')) return;
    if (activeAlert) { alertQueue.push(event); return; }
    displayedEvent=event;
    $('aiAlertFace').src=event.faceImage;
    $('aiAlertFrame').src=event.frameImage;
    $('aiAlertName').textContent=event.matched?'Възможно съвпадение: '+event.name:'Непознато лице';
    $('aiAlertAge').textContent=event.age;
    $('aiAlertExpression').textContent=event.expression;
    $('aiAlertWhen').textContent=new Date(event.created).toLocaleString('bg-BG');
    $('aiEventAlert').classList.remove('hidden');activeAlert=true;
    if(Notification.permission==='granted'&&$('aiNotifyToggle').checked){
      try{new Notification('BojoCamReject · засечено лице',{body:event.matched?'Възможно съвпадение с '+event.name:'Непознато лице'});}catch(_){ }
    }
  }
  async function renderEvents() {
    const container=$('aiEvents');container.replaceChildren();
    const events=(await allFrom('events')).sort((a,b)=>b.created-a.created);
    $('aiEventsCount').textContent=`${events.length} записа`; 
    if(!events.length){container.textContent='Няма засичания. Включи наблюдението и камерата на телефона.';return;}
    for (const e of events.slice(0,18)){
      const item=document.createElement('button');item.type='button';item.className='ai-event-entry';
      const img=document.createElement('img');img.src=e.faceImage;img.alt='Снимка на засечено лице';
      const content=document.createElement('span');
      const strong=document.createElement('strong');strong.textContent=e.matched?'Вероятно: '+e.name:'Непознато лице';
      const small=document.createElement('small');small.textContent=new Date(e.created).toLocaleString('bg-BG')+' · '+e.age;
      content.append(strong,small);item.append(img,content);item.addEventListener('click',()=>showEvent(e));container.append(item);
    }
  }
  function renderFaces() {
    for(const id of ['aiFacesViewer','aiFacesPhone']) {
      const container=$(id);container.replaceChildren();
      if(!faces.length){container.textContent='Няма добавени лица.';continue;}
      for(const f of faces) {
        const card=document.createElement('div');card.className='ai-face-card';
        const pic=document.createElement('img');pic.alt='Снимка на '+f.name;pic.src=f.thumbnail;
        const name=document.createElement('span');name.textContent=f.name;
        const remove=document.createElement('button');remove.type='button';remove.textContent='✕';remove.title='Премахни лицето '+f.name;remove.setAttribute('aria-label','Премахни '+f.name);
        remove.addEventListener('click',async()=>{if(!confirm('Да премахна ли '+f.name+' от библиотеката на това устройство?'))return;await deleteFrom('faces',f.id);faces=faces.filter(a=>a.id!==f.id);renderFaces();syncRecord({kind:'face-remove',id:f.id});});
        card.append(pic,name,remove);container.append(card);
      }
    }
    $('aiFacesCount').textContent=faces.length+' лица в библиотеката на това устройство';
  }
  function syncRecord(record,scope) {
    if(!window.BojoBridge)return;
    if(scope==='viewer')window.BojoBridge.sendToPhone(record);
    else if(scope==='phone')window.BojoBridge.sendToViewer(record);
    else {window.BojoBridge.sendToPhone(record);window.BojoBridge.sendToViewer(record);}
  }
  async function syncAllFaces(scope) {
    for(const f of faces){
      syncRecord({kind:'face-library-entry',face:f},scope);
      await sleep(45);
    }
  }
  async function onPeerFaceData(data) {
    if(!data||typeof data!=='object')return;
    if(data.kind==='face-library-entry'){
      const f=data.face;
      if(!f||typeof f.id!=='string'||typeof f.name!=='string'||!Array.isArray(f.descriptor)||f.descriptor.length!==128||typeof f.thumbnail!=='string'||f.thumbnail.length>180000)return;
      if(faces.some(x=>x.id===f.id))return;
      const safe={id:f.id.slice(0,100),name:f.name.slice(0,80),thumbnail:f.thumbnail,descriptor:f.descriptor.map(Number),created:f.created||Date.now()};
      await saveTo('faces',safe);faces.push(safe);renderFaces();toast('Получено лице в библиотеката: '+safe.name);
    }else if(data.kind==='face-remove'&&typeof data.id==='string'){
      await deleteFrom('faces',data.id);faces=faces.filter(f=>f.id!==data.id);renderFaces();
    }
  }
  function readAsImage(file) {
    return new Promise((resolve,reject)=>{
      const img=new Image();const url=URL.createObjectURL(file);
      img.onload=()=>{URL.revokeObjectURL(url);resolve(img);};
      img.onerror=()=>{URL.revokeObjectURL(url);reject(Error('Не може да се отвори снимката.'));};img.src=url;
    });
  }
  function thumbnailOf(img,b) {
    const canvas=document.createElement('canvas');canvas.width=150;canvas.height=150;
    const p=Math.max(b.width,b.height)*0.32;
    const box=Math.max(b.width,b.height)+p*2;
    const x=Math.max(0,b.x+b.width/2-box/2),y=Math.max(0,b.y+b.height/2-box/2);
    const size=Math.min(box,img.naturalWidth-x,img.naturalHeight-y);
    canvas.getContext('2d').drawImage(img,x,y,size,size,0,0,150,150);
    return canvas.toDataURL('image/jpeg',0.68);
  }
  async function addFace(side) {
    const name=$('aiName'+side).value.trim().slice(0,80);
    const input=$('aiFile'+side),file=input.files?.[0];
    if(!name||!file){toast('Въведи име и избери снимка на лице.');return;}
    if(file.size>15*1024*1024){toast('Снимката трябва да е под 15 MB.');return;}
    const btn=$('aiAdd'+side);btn.disabled=true;btn.textContent='AI обработка…';
    try {
      await loadModels();const img=await readAsImage(file);
      const result=await faceapi.detectSingleFace(img,faceOptions()).withFaceLandmarks(true).withFaceDescriptor();
      if(!result)throw Error('Не открих ясно лице на снимката. Използвай снимка отпред и при добра светлина.');
      const face={id:crypto.randomUUID(),name,thumbnail:thumbnailOf(img,result.detection.box),descriptor:Array.from(result.descriptor),created:Date.now()};
      await saveTo('faces',face);faces.push(face);renderFaces();
      syncRecord({kind:'face-library-entry',face});
      input.value='';$('aiName'+side).value='';toast(`Лицето „${name}“ е добавено. ${window.BojoBridge?.online?'Изпраща се към другото устройство.':'Свържи устройствата за синхронизация.'}`);
    } catch(e){toast(e.message||'Неуспешно добавяне на лице');}
    finally{btn.disabled=false;btn.textContent='＋ Добави лице';}
  }

  function exportFaceLibrary() {
    const data=JSON.stringify({app:'BojoCamReject',version:3,exported:new Date().toISOString(),faces});
    const url=URL.createObjectURL(new Blob([data],{type:'application/json'}));
    const a=document.createElement('a');a.href=url;a.download='BojoCamReject-litsa-backup.json';
    document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),3000);
    toast('Архивът е изтеглен. Съхранявай го на защитено място.');
  }
  async function importFaceLibrary(file) {
    if(!file||file.size>15*1024*1024){toast('Архивът трябва да е под 15 MB.');return;}
    try {
      const data=JSON.parse(await file.text());
      if(data.app!=='BojoCamReject'||!Array.isArray(data.faces))throw Error('Невалиден архив на BojoCamReject.');
      let count=0;
      for(const f of data.faces){
        if(!f||typeof f.id!=='string'||typeof f.name!=='string'||!Array.isArray(f.descriptor)||f.descriptor.length!==128||typeof f.thumbnail!=='string'||!f.thumbnail.startsWith('data:image/jpeg;base64,')||f.thumbnail.length>180000)continue;
        if(faces.some(x=>x.id===f.id))continue;
        const safe={id:f.id.slice(0,100),name:f.name.slice(0,80),thumbnail:f.thumbnail,descriptor:f.descriptor.map(Number),created:f.created||Date.now()};
        if(safe.descriptor.some(n=>!Number.isFinite(n)))continue;
        await saveTo('faces',safe);faces.push(safe);count++;
        syncRecord({kind:'face-library-entry',face:safe});
      }
      renderFaces();toast('Импортирани лица: '+count);
    }catch(err){toast(err.message||'Неуспешно зареждане на архив');}
  }

  async function initialize() {
    try {faces=await allFrom('faces');renderFaces(); if(!document.body.classList.contains('phone-selected'))await renderEvents();}
    catch(e){status('Не мога да отворя локалната база: '+e.message);}
    $('toggleRecognitionBtn').addEventListener('click',onAIEnable);
    $('aiAddViewer').addEventListener('click',()=>addFace('Viewer'));
    $('aiAddPhone').addEventListener('click',()=>addFace('Phone'));
    for(const side of ['Viewer','Phone']){
      $('exportFaces'+side).addEventListener('click',exportFaceLibrary);
      $('importFaces'+side).addEventListener('click',()=>$('importFaceFile'+side).click());
      $('importFaceFile'+side).addEventListener('change',async e=>{await importFaceLibrary(e.target.files?.[0]);e.target.value='';});
    }
    const dismissAlert=()=>{
      $('aiEventAlert').classList.add('hidden'); activeAlert=false; displayedEvent=null;
      const next=alertQueue.shift(); if(next)showEvent(next);
    };
    $('aiAlertClose').addEventListener('click',dismissAlert);
    $('aiEventAlert').addEventListener('click',e=>{if(e.target===$('aiEventAlert'))dismissAlert();});
    $('aiDownloadPhoto').addEventListener('click',()=>{
      if(!displayedEvent) return;
      const anchor=document.createElement('a');
      anchor.href=displayedEvent.frameImage;
      anchor.download=`BojoCamReject-${new Date(displayedEvent.created).toISOString().replace(/[:.]/g,'-')}.jpg`;
      document.body.appendChild(anchor); anchor.click(); anchor.remove();
    });
    $('aiClearEvents').addEventListener('click',async()=>{if(!confirm('Изтриване на всички записи със засечени лица на този компютър?'))return;await clearStore('events');renderEvents();});
    $('aiNotifyToggle').addEventListener('change',async e=>{if(e.target.checked&&'Notification'in window&&Notification.permission==='default')await Notification.requestPermission();});
    window.addEventListener('bojo:viewer-data-open',()=>syncAllFaces('phone'));
    window.addEventListener('bojo:phone-data-open',()=>syncAllFaces('viewer'));
    window.addEventListener('bojo:data-from-phone',ev=>onPeerFaceData(ev.detail));
    window.addEventListener('bojo:data-from-viewer',ev=>onPeerFaceData(ev.detail));
    window.addEventListener('bojo:viewer-video-stop',()=>{lastMotionFrame=null;clearOverlay();});
    window.addEventListener('resize',()=>{if(detections.length&&monitoring)drawOverlay();});
  }
  initialize();
})();
