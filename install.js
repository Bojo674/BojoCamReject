/* BojoCamReject PWA installation, updates and safe refresh. */
(() => {
  'use strict';
  const $=id=>document.getElementById(id);
  const button=$('installAppBtn'), panel=$('installPanel'), help=$('installHelp');
  const checkBtn=$('checkUpdatesBtn'), updateBanner=$('updateBanner'), applyBtn=$('applyUpdateBtn');
  const ua=navigator.userAgent||'';
  const ios=/iPad|iPhone|iPod/.test(ua)||(navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1);
  const android=/Android/.test(ua);
  const standalone=matchMedia('(display-mode: standalone)').matches||navigator.standalone===true;
  let installPrompt=null, registration=null, updateReady=false;
  const hasLiveCamera=()=>['localVideo','remoteVideo'].some(id=>{
    const v=$(id);return v?.srcObject?.getVideoTracks?.().some(t=>t.readyState==='live');
  });
  if(standalone)panel?.classList.add('hidden');
  function showHelp(message){help.textContent=message;help.classList.remove('hidden');}
  function offerUpdate(){
    updateReady=true;
    if(!hasLiveCamera()) { reloadWhenSafe(); return; }
    updateBanner?.classList.remove('hidden');
  }
  function reloadWhenSafe(){
    if(hasLiveCamera()) {offerUpdate();return;}
    const phoneRoom=$('phoneRoom')?.value;
    if(phoneRoom && /^[A-F0-9]{24}$/.test(phoneRoom.replace(/\s+/g,''))){
      const url=new URL(location.href);
      if(url.searchParams.get('mode')==='phone'){
        url.searchParams.set('room',phoneRoom.replace(/\s+/g,''));
        history.replaceState(null,'',url);
      }
    }
    location.reload();
  }
  window.addEventListener('beforeinstallprompt',e=>{
    e.preventDefault();installPrompt=e;if(!standalone)button.textContent='Инсталирай сега';
  });
  window.addEventListener('appinstalled',()=>panel.classList.add('hidden'));
  button?.addEventListener('click',async()=>{
    if(installPrompt){installPrompt.prompt();await installPrompt.userChoice.catch(()=>{});installPrompt=null;}
    else if(ios)showHelp('iPhone: отвори HTTPS адреса в Safari → Споделяне → „Добави към началния екран“ → „Добави“.');
    else if(android)showHelp('Android: отвори HTTPS адреса в Chrome → меню ⋮ → „Инсталиране на приложението“.');
    else showHelp('Отвори HTTPS сайта на телефона: Android в Chrome, iPhone в Safari.');
  });
  applyBtn?.addEventListener('click',reloadWhenSafe);
  checkBtn?.addEventListener('click',async()=>{
    if(!registration){checkBtn.textContent='Няма връзка за проверка';return;}
    checkBtn.disabled=true;checkBtn.textContent='Проверявам...';
    try {
      await registration.update();
      checkBtn.textContent=updateReady?'Нова версия е налична':'Версията е актуална ✓';
    } catch(_){checkBtn.textContent='Проверете интернет връзката';}
    finally{checkBtn.disabled=false;setTimeout(()=>{checkBtn.textContent='↻ Провери за ъпдейт';},4000);}
  });
  if(!('serviceWorker'in navigator)||!window.isSecureContext)return;
  const existingController=Boolean(navigator.serviceWorker.controller);
  navigator.serviceWorker.addEventListener('controllerchange',()=>{
    // Initial installation is not an app update; do not disturb first-time users.
    if(!existingController)return;
    reloadWhenSafe();
  });
  function observe(reg){
    if(reg.waiting&&existingController)offerUpdate();
    reg.addEventListener('updatefound',()=>{
      const worker=reg.installing;
      worker?.addEventListener('statechange',()=>{
        if(worker.state==='installed'&&navigator.serviceWorker.controller)offerUpdate();
      });
    });
  }
  window.addEventListener('load',async()=>{
    try{
      registration=await navigator.serviceWorker.register('./sw.js',{updateViaCache:'none'});
      observe(registration);
      await registration.update().catch(()=>{});
    }catch(_){checkBtn.title='Неуспешна регистрация за обновяване';}
  });
  let lastCheck=0;
  async function checkPeriodically(){
    if(!registration||!navigator.onLine||Date.now()-lastCheck<15*60*1000)return;
    lastCheck=Date.now();registration.update().catch(()=>{});
  }
  document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')checkPeriodically();});
  window.addEventListener('online',checkPeriodically);
  setInterval(checkPeriodically,15*60*1000);
})();
