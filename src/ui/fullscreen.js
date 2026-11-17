// Mode layar penuh wajib di HP/tablet kecil: ketuk tombol → fullscreen + kunci landscape.
// (Browser mewajibkan gestur pengguna, jadi tidak bisa otomatis tanpa ketukan.)
const fsEl=()=>document.fullscreenElement||document.webkitFullscreenElement;
const root=document.documentElement;
const canFs=()=>!!(root.requestFullscreen||root.webkitRequestFullscreen);
const standalone=()=>matchMedia('(display-mode: fullscreen)').matches||matchMedia('(display-mode: standalone)').matches||navigator.standalone===true;
const mobile=()=>(matchMedia('(pointer:coarse)').matches||navigator.maxTouchPoints>0)&&Math.min(innerWidth,innerHeight)<=600;

export function initFullscreen(){
 const gate=document.getElementById('fs-gate'),btn=document.getElementById('fs-go'),note=document.getElementById('fs-note');
 if(!gate||!btn||!mobile()||standalone()) return;
 if(!canFs()){
  btn.textContent='▶ LANJUT';
  note.textContent='Browser ini tidak mendukung layar penuh otomatis. Di iPhone: ketuk Bagikan → "Tambah ke Layar Utama", lalu buka dari ikon agar tanpa bar URL.';
 }
 const show=()=>{if(!fsEl()&&!standalone())gate.classList.add('show')};
 btn.onclick=async()=>{
  try{
   if(root.requestFullscreen) await root.requestFullscreen({navigationUI:'hide'});
   else if(root.webkitRequestFullscreen) root.webkitRequestFullscreen();
  }catch(e){}
  try{await screen.orientation?.lock?.('landscape')}catch(e){} // hanya jalan saat fullscreen (Android Chrome)
  gate.classList.remove('show');
 };
 const onChange=()=>{
  if(fsEl()) gate.classList.remove('show');
  else if(canFs()){try{screen.orientation?.unlock?.()}catch(e){} show()}
 };
 document.addEventListener('fullscreenchange',onChange);
 document.addEventListener('webkitfullscreenchange',onChange);
 show();
}
