// BojoCamReject QR reader. Uses native BarcodeDetector, or jsQR on Safari/iPhone.
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const dialog = $('qrScannerDialog'), video = $('qrScanVideo'), msg = $('qrScannerStatus');
  const openBtn = $('scanQrBtn');
  if (!dialog || !video || !openBtn) return;
  let stream = null, detector = null, running = false, busy = false, raf = 0, lastFrame = 0;
  let scanningSession = 0, loadingLibrary = null;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', {willReadFrequently:true});
  const validCode = raw => {
    if (typeof raw !== 'string') return '';
    let code = raw.trim();
    try {
      if (/^https?:\/\//i.test(code)) {
        const url = new URL(code);
        code = url.searchParams.get('room') || '';
      }
    } catch (_) { return ''; }
    code = code.replace(/[\s-]/g,'').toUpperCase();
    return /^[A-F0-9]{24}$/.test(code) ? code : '';
  };
  function status(text) { msg.textContent = text; }
  function close() {
    scanningSession++;
    running = false; busy = false;
    cancelAnimationFrame(raf); raf = 0;
    if (stream) stream.getTracks().forEach(t=>t.stop());
    stream = null;
    video.pause(); video.srcObject = null;
    dialog.classList.add('hidden');
    dialog.setAttribute('aria-hidden','true');
    $('qrImageInput').value = '';
    openBtn.focus();
  }
  function success(text) {
    const code = validCode(text);
    if (!code) { status('Това не е QR код за BojoCamReject. Насочи камерата към QR кода от компютъра.'); return false; }
    close();
    window.dispatchEvent(new CustomEvent('bojo:qr-read',{detail:{value:code}}));
    return true;
  }
  function parseCanvas() {
    if (typeof window.jsQR !== 'function' || !ctx) return '';
    const pixels = ctx.getImageData(0,0,canvas.width,canvas.height);
    return window.jsQR(pixels.data,pixels.width,pixels.height,{inversionAttempts:'attemptBoth'})?.data || '';
  }
  async function loadJsQR() {
    if (typeof window.jsQR === 'function') return true;
    if (!loadingLibrary) {
      loadingLibrary = new Promise(resolve => {
        const script = document.createElement('script');
        script.src = 'https://unpkg.com/jsqr@1.4.0/dist/jsQR.js';
        script.onload = ()=>resolve(typeof window.jsQR==='function');
        script.onerror = ()=>resolve(false);
        document.head.appendChild(script);
      });
    }
    return loadingLibrary;
  }
  function updateCanvas(videoSource) {
    const w = videoSource.videoWidth || videoSource.naturalWidth || videoSource.width;
    const h = videoSource.videoHeight || videoSource.naturalHeight || videoSource.height;
    if (!w || !h) return false;
    const ratio = Math.min(1, 720 / Math.max(w,h));
    canvas.width = Math.round(w*ratio); canvas.height = Math.round(h*ratio);
    ctx.drawImage(videoSource,0,0,canvas.width,canvas.height);
    return true;
  }
  async function scanFrame(t) {
    if (!running) return;
    raf = requestAnimationFrame(scanFrame);
    if (busy || t-lastFrame<230 || video.readyState<2) return;
    lastFrame=t; busy=true;
    try {
      let text = '';
      if (detector) {
        const codes = await detector.detect(video);
        text = codes.find(x => validCode(x.rawValue))?.rawValue || '';
      }
      if (!text && typeof window.jsQR === 'function' && updateCanvas(video)) text=parseCanvas();
      if (running && text) success(text);
    } catch (_) { /* Ignore a single frame failure; keep camera ready. */ }
    finally { busy=false; }
  }
  async function open() {
    if (running || !dialog.classList.contains('hidden')) return;
    if (openBtn.disabled || $('phoneRoom')?.disabled) { status('Спри излъчването, преди да сканираш нов QR код.'); return; }
    const session = ++scanningSession;
    dialog.classList.remove('hidden'); dialog.setAttribute('aria-hidden','false');
    status('Изчакване за разрешение за камерата...');
    $('closeQrScannerBtn').focus();
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      status('Отвори приложението през HTTPS, за да сканираш с камерата. Можеш и да въведеш кода ръчно.');
      return;
    }
    try {
      // The QR reader runs only after the user taps the camera button.
      const live = await navigator.mediaDevices.getUserMedia({audio:false,video:{facingMode:{ideal:'environment'},width:{ideal:1280},height:{ideal:720}}});
      if (session !== scanningSession) {live.getTracks().forEach(t=>t.stop());return;}
      stream=live; video.srcObject=stream;
      await video.play();
      if(session!==scanningSession)return;
      try {
        if ('BarcodeDetector' in window) {
          const formats = await window.BarcodeDetector.getSupportedFormats();
          if (formats.includes('qr_code')) detector = new window.BarcodeDetector({formats:['qr_code']});
        }
      } catch (_) { detector=null; }
      if (!detector && !(await loadJsQR())) {
        status('Не можа да се зареди QR четецът. Провери интернет или въведи кода ръчно.');
        return;
      }
      if (session !== scanningSession) return;
      status('Насочи към QR кода на компютъра — сканира се автоматично.');
      running=true; raf=requestAnimationFrame(scanFrame);
    } catch (error) {
      if(session===scanningSession)status(error?.name==='NotAllowedError'?'Дай разрешение за камерата в браузъра и опитай отново.':'Камерата не може да се включи. Провери дали не се използва от друго приложение.');
    }
  }
  async function decodeImage(file) {
    if (!file || !file.type.startsWith('image/')) return;
    status('Разчитане на QR кода от снимката...');
    const session=scanningSession;
    let bitmap=null, objectUrl='';
    try {
      let img;
      if (typeof createImageBitmap==='function') {bitmap=await createImageBitmap(file);img=bitmap;}
      else {
        objectUrl=URL.createObjectURL(file);
        img=new Image(); img.src=objectUrl; await img.decode();
      }
      if(session!==scanningSession)return;
      if (!updateCanvas(img)) throw new Error('Invalid picture');
      let text = '';
      if(detector) {
        const results=await detector.detect(canvas);
        text=results.find(x=>validCode(x.rawValue))?.rawValue||'';
      }
      if(!text) {
        if(typeof window.jsQR!=='function') await loadJsQR();
        text=parseCanvas();
      }
      if(!text || !success(text)) status('Не се откри код за BojoCamReject на снимката. Опитай друга снимка.');
    } catch(_){status('Снимката не можа да бъде прочетена. Опитай отново.');}
    finally {bitmap?.close?.();if(objectUrl)URL.revokeObjectURL(objectUrl);}
  }
  openBtn.addEventListener('click',open);
  $('closeQrScannerBtn').addEventListener('click',close);
  $('cancelQrScannerBtn').addEventListener('click',close);
  $('qrImageInput').addEventListener('change',e=>decodeImage(e.target.files?.[0]));
  document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!dialog.classList.contains('hidden'))close();});
  window.addEventListener('bojo:exit-phone-mode',close);
  window.addEventListener('pagehide',close);
})();
