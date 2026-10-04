/**
 * Builds a `javascript:` bookmarklet URL that saves the *live page DOM*
 * to this Readapaper instance.
 *
 * Why DOM instead of server fetch:
 * - Runs inside the page, so it inherits cookies / login sessions (paywalls),
 *   already-executed JS (SPA / lazy-loaded article bodies), and the exact HTML
 *   the reader sees (bot checks / WAFs only see a normal user, not a scraper).
 * - Server just re-runs the normal extract pipeline (Readability + sanitize)
 *   on the posted HTML via POST /api/articles { url, html }.
 *
 * Transport (relay-first):
 * - Primary path opens this instance's `/bookmarklet#autosave` in a new tab
 *   and `postMessage`s `{url, html}` to it. The save POST then runs
 *   *same-origin* from the Readapaper tab, so the article page never fetches
 *   the local network directly. That avoids Chrome's Local Network Access
 *   permission prompt (per-article-origin), `connect-src` CSP blocks, CORS,
 *   and mixed-content — including `*.ts.net` Tailscale URLs, which still
 *   resolve to 100.64/10 (local address space) and still trigger the prompt.
 * - Fallback is the legacy direct `fetch(BASE + '/api/articles')` (triggers
 *   the LNA prompt on new article origins), then clipboard + manual save.
 *
 * The server base is baked into the bookmarklet at install time (from
 * window.location.origin on /bookmarklet), so it works on any article origin.
 */

const PAYLOAD = `(function(){
var BASE='__BASE__'.replace(/\\/$/,'');
var TID='readapaper-save-toast';
function toast(html){
var el=document.getElementById(TID);
if(!el){
el=document.createElement('div');
el.id=TID;
el.setAttribute('style','position:fixed;right:16px;bottom:16px;z-index:2147483647;max-width:360px;background:#111827;color:#fff;font:14px/1.5 system-ui,sans-serif;padding:12px 14px;border-radius:10px;box-shadow:0 8px 30px rgba(0,0,0,.35);');
document.body.appendChild(el);
}
el.innerHTML=html;
return el;
}
function done(html,ms){
var el=toast(html);
if(ms!==0){setTimeout(function(){if(el&&el.parentNode){el.parentNode.removeChild(el);}},ms||8000);}
}
toast('Saving to Readapaper&hellip;');
try{
var html='<!DOCTYPE html>\\n'+document.documentElement.outerHTML;
if(!html||html.length<500){done('Could not read page DOM.',6000);return;}
if(html.length>9000000){done('Page too large ('+Math.round(html.length/1048576)+'MB). Try reader mode first.',8000);return;}
var pageUrl=location.href;
var finished=false;
function finish(html,ms){finished=true;done(html,ms);}
function directSave(){
var tas='local';
try{var hb=BASE.toLowerCase();if(hb.indexOf('localhost')>=0||hb.indexOf('127.')>=0||hb.indexOf('[::1]')>=0){tas='loopback';}}catch(_){}
var opts={method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url:pageUrl,html:html})};
try{opts.targetAddressSpace=tas;}catch(_){}
fetch(BASE+'/api/articles',opts)
.then(function(r){return r.json().catch(function(){return {};}).then(function(d){return {ok:r.ok,status:r.status,body:d};});})
.then(function(x){
if(finished){return;}
if(!x.ok){finish('Save failed: '+((x.body&&x.body.error)||('HTTP '+x.status))+'. <a href="'+BASE+'/bookmarklet" target="_blank" style="color:#93c5fd">Help</a>',10000);return;}
var id=x.body&&x.body.id;
var verb=(x.status===200)?'Already in':'Saved to';
var link=id?'<br><a href="'+BASE+'/a/'+id+'" target="_blank" style="color:#93c5fd;font-weight:700">Open in Readapaper &rarr;</a>':'';
finish(verb+' Readapaper.'+link,0);
})
.catch(function(e){
if(finished){return;}
var insecure=BASE.indexOf('http://')===0&&location.protocol==='https:';
var help='<br><a href="'+BASE+'/bookmarklet#manual" target="_blank" style="color:#93c5fd">Manual save help</a>';
function show(msg){finish(msg+help,15000);}
try{
if(navigator.clipboard&&navigator.clipboard.writeText){
navigator.clipboard.writeText(html).then(function(){
var m='Site blocked the direct save (local-network permission / CSP / mixed-content). Page HTML copied — paste it at '+BASE+'/bookmarklet (Manual save).';
if(insecure){m+=' Tip: your Readapaper is http but this page is https — browsers block that. Use an https Readapaper URL (tunnel/deploy) and reinstall.';}
show(m);
},function(){
var m2='Site blocked the direct save (local-network permission / CSP / mixed-content: '+(e&&e.message||e)+'). Paste the page HTML manually at '+BASE+'/bookmarklet (Manual save).';
if(insecure){m2+=' Tip: http Readapaper + https page is always blocked — use https.';}
show(m2);
});
return;
}
}catch(_){}
var m3='Site blocked the direct save (local-network permission / CSP / mixed-content: '+(e&&e.message||e)+'). Paste manually at '+BASE+'/bookmarklet (Manual save).';
if(insecure){m3+=' Your Readapaper is http but this page is https — browsers block that. Use an https Readapaper URL and reinstall.';}
show(m3);
});
}
function relay(){
var w=null;
try{w=window.open(BASE+'/bookmarklet#autosave','_blank');}catch(_){}
if(!w){directSave();return;}
var acked=false;
var tries=0;
var payload={type:'readapaper-save',url:pageUrl,html:html};
function send(){tries++;try{w.postMessage(payload,BASE);}catch(e){}}
function cleanup(){try{window.removeEventListener('message',onmsg);}catch(_){}}
function onmsg(ev){
try{
if(ev.origin!==BASE){return;}
var d=ev.data;
if(!d||typeof d!=='object'){return;}
if(d.type==='readapaper-ready'){send();return;}
if(d.type==='readapaper-saved'){
acked=true;clearInterval(iv);cleanup();
var id=d.id;
var verb=(d.status===200)?'Already in':'Saved to';
var link=id?'<br><a href="'+BASE+'/a/'+id+'" target="_blank" style="color:#93c5fd;font-weight:700">Open in Readapaper &rarr;</a>':'<br><a href="'+BASE+'" target="_blank" style="color:#93c5fd">Open Readapaper &rarr;</a>';
finish(verb+' Readapaper (new tab).'+link,0);
return;
}
if(d.type==='readapaper-error'){
acked=true;clearInterval(iv);cleanup();
finish('Save failed: '+(d.error||'unknown')+'. <a href="'+BASE+'/bookmarklet" target="_blank" style="color:#93c5fd">Help</a>',10000);
return;
}
}catch(_){}
}
window.addEventListener('message',onmsg);
send();
var iv=setInterval(function(){
if(acked||finished){clearInterval(iv);return;}
if(tries>=20){clearInterval(iv);cleanup();directSave();return;}
send();
},500);
setTimeout(function(){try{if(!acked&&!finished&&w&&w.closed){clearInterval(iv);cleanup();directSave();}}catch(_){}},1500);
done('Saving in Readapaper tab&hellip; <a href="'+BASE+'" target="_blank" style="color:#93c5fd">Open</a>',8000);
}
try{relay();}catch(_){directSave();}
}catch(e){done('Save failed: '+(e&&e.message||e),8000);}
})()`;

export function buildBookmarklet(baseUrl: string): string {
  const base = baseUrl.replace(/\/$/, "");
  const body = PAYLOAD.replace("__BASE__", base.replace(/'/g, "\\'"));
  return "javascript:" + body;
}
