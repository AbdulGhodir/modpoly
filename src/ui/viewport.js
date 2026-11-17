// Pengukuran viewport + DPR (dengan batas wajar agar HP tidak terbebani)
const MAX_DPR=3, MAX_PIXELS=6e6; // batas piksel fisik canvas

export function measureViewport(){
 const g=document.getElementById('g');
 const w=Math.max(1,g?.clientWidth||window.innerWidth);
 const h=Math.max(1,g?.clientHeight||window.innerHeight);
 let d=Math.min(window.devicePixelRatio||1,MAX_DPR);
 while(d>1&&w*h*d*d>MAX_PIXELS) d-=.25;
 d=Math.max(1,d);
 const landscape=w>h;
 return{w,h,d,landscape,phoneLandscape:landscape&&h<=500,compact:(landscape&&h<=500)||w<=700};
}

let probe;
// Safe-area (notch) dalam CSS px
export function safeInsets(){
 if(!probe){
  probe=document.createElement('div');
  probe.style.cssText='position:fixed;left:0;top:0;width:0;height:0;visibility:hidden;pointer-events:none;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)';
  document.body.appendChild(probe);
 }
 const c=getComputedStyle(probe);
 return{t:parseFloat(c.paddingTop)||0,r:parseFloat(c.paddingRight)||0,b:parseFloat(c.paddingBottom)||0,l:parseFloat(c.paddingLeft)||0};
}
