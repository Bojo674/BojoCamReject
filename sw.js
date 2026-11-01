// BojoCamReject v2.0 - new releases update in-place when published to the same HTTPS origin.
const VERSION = '3.2.0-2026-10-31';
const CACHE = 'bojocamreject-ui-' + VERSION;
const ASSETS = ['./','./version.json','./index.html','./style.css','./app.js','./install.js','./scanner.js','./recognition.css','./recognition.js','./manifest.webmanifest','./favicon.svg','./icons/icon-192.png','./icons/icon-512.png','./icons/icon-180.png'];
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate',event=>{
  event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k.startsWith('bojocamreject-ui-')&&k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));
});
self.addEventListener('fetch', event => {
  const req=event.request;
  if(req.method!=='GET'||new URL(req.url).origin!==self.location.origin)return;
  const pathname=new URL(req.url).pathname;
  if(pathname.endsWith('/sw.js')||pathname.endsWith('/__camlink_health'))return;
  // Network-first: updates are downloaded while online, then saved for next launch.
  event.respondWith(fetch(req).then(async resp=>{
    if(resp.ok&&resp.type==='basic'){
      const cache=await caches.open(CACHE);
      await cache.put(req,resp.clone()).catch(()=>{});
    }
    return resp;
  }).catch(async()=>{
    const cache=await caches.open(CACHE);
    return (await cache.match(req))||(req.mode==='navigate'?await cache.match('./index.html'):Response.error());
  }));
});
