'use strict';

// BojoCamReject: one-way phone -> computer camera, WebRTC encrypted media with PeerJS signaling.
// PeerJS Cloud provides signaling; videos are not uploaded to or stored by this site.
(() => {
  const $ = (id) => document.getElementById(id);
  const modeButtons = { viewer: $('viewerTab'), phone: $('phoneTab') };
  const sections = { viewer: $('viewerMode'), phone: $('phoneMode') };
  let viewerPeer = null, viewerCall = null, viewerData = null, viewerRoom = '';
  let phonePeer = null, phoneCall = null, phoneData = null, phoneStream = null;
  let currentFacing = 'environment', torchEnabled = false, wakeLock = null;
  let toastTimer = 0, phoneStarting = false;
  const rtcConfig = { iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ] };

  const show = (id, yes) => $(id).classList.toggle('hidden', !yes);
  const status = (side, message, state = '') => {
    $(`${side}Status`).textContent = message;
    $(`${side}Dot`).className = `status-dot ${state}`;
  };
  function toast(text) {
    clearTimeout(toastTimer);
    $('toast').textContent = text;
    show('toast', true);
    toastTimer = setTimeout(() => show('toast', false), 3200);
  }
  const errorMessage = (error) => {
    const name = error?.name || error?.type || '';
    if (name === 'NotAllowedError' || name === 'PermissionDeniedError') return 'Нямаш разрешение за камерата. Разреши го в настройките на браузъра.';
    if (name === 'NotFoundError' || name === 'DevicesNotFoundError') return 'Не е открита камера на това устройство.';
    if (name === 'NotReadableError' || name === 'TrackStartError') return 'Камерата се използва от друго приложение.';
    if (name === 'peer-unavailable') return 'Компютърът не е намерен. Отвори сайта на компютъра и създай връзка.';
    if (name === 'unavailable-id') return 'Този код вече се използва. Генерирай нов.';
    if (name === 'network' || name === 'server-error' || name === 'socket-error') return 'Неуспешна мрежова връзка. Провери интернет и опитай пак.';
    return error?.message || 'Възникна грешка. Опитай отново.';
  };
  const isReady = () => typeof window.Peer === 'function';
  function newRoom() {
    const bytes = new Uint8Array(12);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, b => b.toString(16).padStart(2,'0')).join('').toUpperCase();
  }
  function normalizeRoom(raw) {
    let value = (raw || '').trim();
    try {
      if (value.startsWith('http://') || value.startsWith('https://')) value = new URL(value).searchParams.get('room') || '';
    } catch (_) { return ''; }
    return value.replace(/[^a-f\d]/gi, '').toUpperCase();
  }
  const peerId = (room) => `bojocamreject-${room.toLowerCase()}`;
  const isLocalViewer = ['localhost','127.0.0.1'].includes(window.location.hostname);
  let phonePublicOrigin = null;
  async function resolvePhoneOrigin() {
    if (!isLocalViewer) { phonePublicOrigin = new URL('./', window.location.href).href; return phonePublicOrigin; }
    try {
      const response = await fetch('/__camlink_public',{cache:'no-store'});
      if (!response.ok) throw new Error('No active public link');
      const value = (await response.text()).trim();
      const url = new URL(value);
      if (url.protocol !== 'https:' || !url.hostname.endsWith('.trycloudflare.com')) throw new Error('Invalid public link');
      phonePublicOrigin = url.origin + '/';
      return phonePublicOrigin;
    } catch (_) {
      toast('Няма публичен HTTPS адрес за телефона. Проверѝ черния прозорец.');
      return null;
    }
  }
  const phoneUrl = () => {
    const url = new URL(phonePublicOrigin || new URL('./', window.location.href).href);
    url.search = '';
    url.hash = '';
    url.searchParams.set('mode', 'phone');
    url.searchParams.set('room', viewerRoom);
    return url.href;
  };
  async function copy(text, description) {
    try {
      await navigator.clipboard.writeText(text);
      toast(`${description} е копиран`);
    } catch (_) {
      const el = document.createElement('textarea');
      el.value = text;
      el.style.position = 'fixed'; el.style.opacity = '0';
      document.body.appendChild(el); el.select();
      const ok = document.execCommand('copy');
      el.remove();
      toast(ok ? `${description} е копиран` : 'Неуспешно копиране. Избери и копирай текста ръчно.');
    }
  }

  function selectMode(mode, updateUrl = true) {
    document.body.classList.toggle('phone-selected',mode === 'phone');
    for (const name of ['viewer','phone']) {
      modeButtons[name].classList.toggle('active', name === mode);
      modeButtons[name].setAttribute('aria-selected', String(name === mode));
      sections[name].classList.toggle('hidden', name !== mode);
    }
    if (mode !== 'phone') window.dispatchEvent(new Event('bojo:exit-phone-mode'));
    if (updateUrl) {
      const url = new URL(location.href);
      url.searchParams.set('mode', mode);
      if (mode !== 'phone') url.searchParams.delete('room');
      history.replaceState(null, '', url);
    }
  }
  modeButtons.viewer.addEventListener('click', () => selectMode('viewer'));
  modeButtons.phone.addEventListener('click', () => selectMode('phone'));

  function viewerResetVideo() {
    const video = $('remoteVideo');
    video.pause(); video.srcObject = null;
    video.classList.remove('is-visible');
    show('viewerEmpty', true); show('viewerLiveBadge', false);
    window.dispatchEvent(new Event('bojo:viewer-video-stop'));
    $('snapshotBtn').disabled = true;
    $('fullscreenBtn').disabled = true;
    $('viewerQuality').textContent = 'HD · 720p';
  }
  function viewerSignalReady() {
    if ($('remoteVideo').srcObject && viewerData?.open) {
      try { viewerData.send({type:'video-ready'}); } catch (_) {}
    }
  }
  function stopViewer() {
    if (viewerCall) { try { viewerCall.close(); } catch (_) {} viewerCall = null; }
    if (viewerData) { try { viewerData.close(); } catch (_) {} viewerData = null; }
    if (viewerPeer) { try { viewerPeer.destroy(); } catch (_) {} viewerPeer = null; }
    viewerRoom = '';
    viewerResetVideo();
    show('viewerBefore', true); show('viewerPair', false);
    $('createViewerBtn').disabled = false;
    status('viewer', 'Готово за създаване на връзка');
  }
  function activateRemote(stream, call) {
    if (viewerCall !== call) return;
    const video = $('remoteVideo');
    video.srcObject = stream;
    video.classList.add('is-visible');
    show('viewerEmpty', false);
    show('viewerLiveBadge', true);
    $('snapshotBtn').disabled = false;
    $('fullscreenBtn').disabled = false;
    const track = stream.getVideoTracks()[0];
    const height = track?.getSettings?.().height;
    $('viewerQuality').textContent = height ? `${height}p · LIVE` : 'VIDEO · LIVE';
    video.play().catch(() => toast('Натисни върху видеото, за да го пуснеш.'));
    status('viewer', 'Свързано · камерата е на живо', 'ok');
    window.dispatchEvent(new Event('bojo:viewer-video-start'));
    viewerSignalReady();
    track?.addEventListener('ended', () => {
      if (viewerCall === call) { viewerResetVideo(); status('viewer','Камерата е спряна. Очакване...', 'busy'); }
    }, {once:true});
  }
  async function startViewer() {
    if (!(await resolvePhoneOrigin())) return;
    if (!isReady()) return toast('Библиотеката за връзка не се зареди. Провери интернет и презареди.');
    if (!window.crypto?.getRandomValues) return toast('Отвори сайта през HTTPS.');
    if (viewerPeer) stopViewer();
    viewerRoom = newRoom();
    $('createViewerBtn').disabled = true;
    status('viewer', 'Създаване на защитена връзка...', 'busy');
    const room = viewerRoom;
    try { viewerPeer = new Peer(peerId(room), {debug:0, config:rtcConfig}); }
    catch (err) { status('viewer',errorMessage(err),'bad'); $('createViewerBtn').disabled = false; return; }
    const peer = viewerPeer;
    peer.on('open', () => {
      if (peer !== viewerPeer) return;
      show('viewerBefore', false); show('viewerPair', true);
      $('roomCode').textContent = room.match(/.{1,4}/g).join(' ');
      $('qrCode').replaceChildren();
      if (typeof window.QRCode === 'function') {
        new QRCode($('qrCode'), {text:phoneUrl(),width:138,height:138,correctLevel:QRCode.CorrectLevel.M});
      } else {
        $('qrCode').innerHTML = '<span style="color:#15293f;font-weight:bold;text-align:center;font-size:12px">Използвай бутона „Копирай линка“</span>';
      }
      status('viewer', 'Готово · сканирай QR кода с телефона', 'busy');
    });
    peer.on('call', call => {
      if (peer !== viewerPeer) {call.close();return;}
      if (viewerCall) viewerCall.close();
      viewerCall = call;
      viewerResetVideo();
      status('viewer', 'Телефонът се свързва...', 'busy');
      call.on('stream', stream => activateRemote(stream, call));
      call.on('close', () => {
        if (viewerCall === call) {viewerCall=null;viewerResetVideo();status('viewer','Връзката прекъсна · очакване на камерата', 'busy');}
      });
      call.on('error', err => { if (viewerCall === call) status('viewer',errorMessage(err),'bad'); });
      try { call.answer(); } catch (err) {status('viewer',errorMessage(err),'bad');}
    });
    peer.on('connection', conn => {
      if (peer !== viewerPeer) { conn.close();return; }
      if (viewerData) viewerData.close();
      viewerData = conn;
      conn.on('open', () => {viewerSignalReady();window.dispatchEvent(new Event('bojo:viewer-data-open'));});
      conn.on('data', data => window.dispatchEvent(new CustomEvent('bojo:data-from-phone',{detail:data})));
      conn.on('close', () => { if (viewerData === conn) viewerData=null; });
    });
    peer.on('disconnected', () => {
      if (peer !== viewerPeer) return;
      status('viewer', 'Мрежата прекъсна. Опит за повторно свързване...', 'busy');
      setTimeout(() => {if (peer === viewerPeer && !peer.destroyed && peer.disconnected) {try{peer.reconnect();}catch(_) {}}}, 2200);
    });
    peer.on('error', err => {
      if (peer !== viewerPeer) return;
      status('viewer',errorMessage(err),'bad');
      if (err.type === 'unavailable-id') { stopViewer();toast('Кодът вече съществува. Натисни „Създай връзка“ отново.'); }
    });
  }
  $('createViewerBtn').addEventListener('click', startViewer);
  $('endViewerBtn').addEventListener('click', stopViewer);
  $('copyCodeBtn').addEventListener('click', () => viewerRoom && copy(viewerRoom,'Кодът'));
  $('copyLinkBtn').addEventListener('click', () => viewerRoom && copy(phoneUrl(),'Линкът'));
  $('snapshotBtn').addEventListener('click', () => {
    const v = $('remoteVideo');
    if (!v.videoWidth || !v.videoHeight) return toast('Няма картина за снимка.');
    const canvas = document.createElement('canvas');
    canvas.width = v.videoWidth; canvas.height = v.videoHeight;
    canvas.getContext('2d').drawImage(v,0,0);
    canvas.toBlob(blob => {
      if (!blob) return toast('Снимката не можа да се направи.');
      const url = URL.createObjectURL(blob), a = document.createElement('a');
      a.href = url; a.download = `bojocamreject-${new Date().toISOString().replace(/[:.]/g,'-')}.png`;
      document.body.appendChild(a);a.click();a.remove();
      setTimeout(()=>URL.revokeObjectURL(url),1000);
      toast('Снимката е запазена на компютъра');
    }, 'image/png');
  });
  $('fullscreenBtn').addEventListener('click', async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await $('viewerStage').requestFullscreen();
    } catch (_) {toast('Браузърът не разреши цял екран.');}
  });
  $('remoteVideo').addEventListener('click', () => $('remoteVideo').play().catch(()=>{}));

  function cameraConstraints() {
    const option = $('qualitySelect').value;
    const settings = option === 'fullhd' ? [1920,1080,30] : option === 'sd' ? [854,480,20] : [1280,720,24];
    return {audio:false,video:{facingMode:{ideal:currentFacing},width:{ideal:settings[0]},height:{ideal:settings[1]},frameRate:{ideal:settings[2],max:30}}};
  }
  async function acquirePhoneCamera() {
    if (!navigator.mediaDevices?.getUserMedia || !window.isSecureContext) {
      throw new Error('За камерата трябва да отвориш публикувания сайт през HTTPS (с катинар).');
    }
    phoneStream = await navigator.mediaDevices.getUserMedia(cameraConstraints());
    $('localVideo').srcObject = phoneStream;
    $('localVideo').classList.add('is-visible');
    show('phoneEmpty', false);
    show('phoneLiveBadge', true);
    $('localVideo').play().catch(()=>{});
    torchEnabled = false;
    updateTorchAvailability();
    await requestWakeLock();
  }
  function updateTorchAvailability() {
    const track = phoneStream?.getVideoTracks()[0];
    let supported = false;
    try { supported = Boolean(track?.getCapabilities?.()?.torch); } catch (_) {}
    $('torchBtn').disabled = !supported;
    $('torchBtn').querySelector('span').textContent = 'Светкавица';
  }
  async function requestWakeLock() {
    if (!('wakeLock' in navigator) || document.visibilityState !== 'visible') return;
    try { wakeLock = await navigator.wakeLock.request('screen'); } catch (_) {}
  }
  async function releaseWakeLock() {
    try {await wakeLock?.release();} catch (_) {}
    wakeLock = null;
  }
  function stopTracks() {
    if (phoneStream) phoneStream.getTracks().forEach(t => t.stop());
    phoneStream = null;
    const v=$('localVideo');v.pause();v.srcObject=null;v.classList.remove('is-visible');
    show('phoneEmpty', true);show('phoneLiveBadge',false);
  }
  function dialPhone() {
    if (!phonePeer?.open || !phoneStream) return;
    if (phoneCall) {try{phoneCall.close();}catch(_){} phoneCall=null;}
    const call = phonePeer.call(peerId(normalizeRoom($('phoneRoom').value)),phoneStream);
    if (!call) {status('phone','Неуспешно позвъняване към компютъра','bad');return;}
    phoneCall = call;
    call.on('close',()=>{
      if (phoneCall===call && phoneStream) status('phone','Връзката прекъсна. Провери компютъра.','bad');
    });
    call.on('error', err=> {if(phoneCall===call) status('phone',errorMessage(err),'bad');});
    status('phone','Изпращане на видео към компютъра...', 'busy');
  }
  function stopPhone() {
    phoneStarting=false;
    if (phoneCall) {try{phoneCall.close();}catch(_){}phoneCall=null;}
    if (phoneData) {try{phoneData.close();}catch(_){}phoneData=null;}
    if (phonePeer) {try{phonePeer.destroy();}catch(_){}phonePeer=null;}
    stopTracks();releaseWakeLock();
    $('startPhoneBtn').disabled=false;
    $('phoneRoom').disabled=false;
    show('startPhoneBtn',true);show('stopPhoneBtn',false);show('phoneTools',false);
    status('phone','Камерата е изключена');
  }
  async function startPhone() {
    if (phoneStarting || phonePeer || phoneStream) return;
    const room = normalizeRoom($('phoneRoom').value);
    if (!/^[A-F0-9]{24}$/.test(room)) {status('phone','Въведи правилния 24-символен код от компютъра.','bad');return;}
    if (!isReady()) {status('phone','Липсва библиотеката за връзка. Провери интернет.','bad');return;}
    $('phoneRoom').value=room;
    phoneStarting=true;$('startPhoneBtn').disabled=true;
    status('phone','Изчакване за достъп до камерата...', 'busy');
    try {
      await acquirePhoneCamera();
      if (!phoneStarting) return;
      phonePeer=new Peer(undefined,{debug:0,config:rtcConfig});
      const peer=phonePeer;
      peer.on('open',()=>{
        if(peer!==phonePeer)return;
        dialPhone();
        phoneData=peer.connect(peerId(room),{reliable:true});
        const conn=phoneData;
        conn.on('open',()=>{ if(peer===phonePeer){status('phone','Свързано · изчакване на видеото...', 'busy');window.dispatchEvent(new Event('bojo:phone-data-open'));} });
        conn.on('data', data=>{
          if (peer===phonePeer && data?.type==='video-ready') status('phone','На живо · компютърът получава видеото','ok');
          window.dispatchEvent(new CustomEvent('bojo:data-from-viewer',{detail:data}));
        });
        conn.on('error', err=>{if(peer===phonePeer) status('phone',errorMessage(err),'bad');});
      });
      peer.on('error',err=>{ if(peer===phonePeer)status('phone',errorMessage(err),'bad'); });
      peer.on('disconnected',()=>{
        if(peer!==phonePeer)return;
        status('phone','Връзката е прекъсната. Опит за свързване...', 'busy');
        setTimeout(()=>{if(peer===phonePeer && !peer.destroyed && peer.disconnected){try{peer.reconnect();}catch(_){}}},2200);
      });
      $('phoneRoom').disabled=true;
      show('startPhoneBtn',false);show('stopPhoneBtn',true);show('phoneTools',true);
    } catch(err) {
      stopPhone();
      status('phone',errorMessage(err),'bad');
    } finally {phoneStarting=false;$('startPhoneBtn').disabled=false;}
  }
  async function switchCamera() {
    if (!phoneStream || !phonePeer) return;
    $('switchCameraBtn').disabled=true;
    const oldFacing=currentFacing;
    currentFacing=oldFacing==='environment'?'user':'environment';
    if (phoneCall) {try{phoneCall.close();}catch(_){}phoneCall=null;}
    stopTracks();
    status('phone','Превключване на камерата...', 'busy');
    try {
      await acquirePhoneCamera();
      dialPhone();
      toast('Камерата е превключена');
    } catch (err) {
      currentFacing=oldFacing;
      try {await acquirePhoneCamera();dialPhone();}
      catch (_) {stopPhone();}
      toast(errorMessage(err));
    } finally {$('switchCameraBtn').disabled=false;}
  }
  async function toggleTorch() {
    const track=phoneStream?.getVideoTracks()[0];
    if (!track) return;
    try {
      torchEnabled=!torchEnabled;
      await track.applyConstraints({advanced:[{torch:torchEnabled}]});
      $('torchBtn').querySelector('span').textContent=torchEnabled?'Изключи светлина':'Светкавица';
    } catch (_) {torchEnabled=false;toast('Светкавицата не се поддържа от тази камера.');}
  }
  async function changeQuality() {
    const track=phoneStream?.getVideoTracks()[0];
    if(!track)return;
    const option=$('qualitySelect').value;
    const [w,h,fps]= option==='fullhd'?[1920,1080,30]:option==='sd'?[854,480,20]:[1280,720,24];
    try {await track.applyConstraints({width:{ideal:w},height:{ideal:h},frameRate:{ideal:fps,max:30}});toast('Качеството е обновено');}
    catch (_) {toast('Тази камера не поддържа избраното качество.');}
  }
  window.addEventListener('bojo:qr-read', (event) => {
    const room = normalizeRoom(event.detail?.value || '');
    if (!/^[A-F0-9]{24}$/.test(room)) return;
    $('phoneRoom').value = room;
    $('phoneRoom').dispatchEvent(new Event('input', {bubbles:true}));
    status('phone','QR кодът е прочетен. Натисни „Включи камерата“.','ok');
    toast('QR кодът е сканиран успешно!');
  });
  $('startPhoneBtn').addEventListener('click',startPhone);
  $('stopPhoneBtn').addEventListener('click',stopPhone);
  $('switchCameraBtn').addEventListener('click',switchCamera);
  $('torchBtn').addEventListener('click',toggleTorch);
  $('qualitySelect').addEventListener('change',changeQuality);
  document.addEventListener('visibilitychange',()=>{
    if(document.visibilityState==='visible' && phoneStream)requestWakeLock();
    else if (document.visibilityState==='hidden' && phoneStream)status('phone','Приложението е скрито. Възможно е камерата да спре.', 'busy');
  });
  window.addEventListener('pagehide',()=>{stopTracks();releaseWakeLock();phonePeer?.destroy();viewerPeer?.destroy();});

  // Bridge to the optional AI module; no changes to WebRTC camera streaming.
  window.BojoBridge={
    get online(){return Boolean(viewerData?.open||phoneData?.open);},
    sendToPhone(data){if(viewerData?.open){try{viewerData.send(data);return true;}catch(_){}}return false;},
    sendToViewer(data){if(phoneData?.open){try{phoneData.send(data);return true;}catch(_){}}return false;}
  };
  const params=new URLSearchParams(location.search);
  const urlRoom=normalizeRoom(params.get('room'));
  if (urlRoom) $('phoneRoom').value=urlRoom;
  selectMode(params.get('mode')==='phone'?'phone':'viewer',false);
})();
