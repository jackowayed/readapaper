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
fetch(BASE+'/api/articles',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url:location.href,html:html})})
.then(function(r){return r.json().catch(function(){return {};}).then(function(d){return {ok:r.ok,status:r.status,body:d};});})
.then(function(x){
if(!x.ok){done('Save failed: '+((x.body&&x.body.error)||('HTTP '+x.status))+'. <a href="'+BASE+'/bookmarklet" target="_blank" style="color:#93c5fd">Help</a>',10000);return;}
var id=x.body&&x.body.id;
var verb=(x.status===200)?'Already in':'Saved to';
var link=id?'<br><a href="'+BASE+'/a/'+id+'" target="_blank" style="color:#93c5fd;font-weight:700">Open in Readapaper &rarr;</a>':'';
done(verb+' Readapaper.'+link,0);
})
.catch(function(e){done('Save failed: '+(e&&e.message||e),8000);});
}catch(e){done('Save failed: '+(e&&e.message||e),8000);}
})()`;

export function buildBookmarklet(baseUrl: string): string {
  const base = baseUrl.replace(/\/$/, "");
  const body = PAYLOAD.replace("__BASE__", base.replace(/'/g, "\\'"));
  return "javascript:" + body;
}
