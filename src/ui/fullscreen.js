import {socketClient} from '../network/SocketClient.js';

const fsEl=()=>document.fullscreenElement||document.webkitFullscreenElement;
const root=()=>document.documentElement;
const canFs=()=>!!(root().requestFullscreen||root().webkitRequestFullscreen);
const standalone=()=>matchMedia('(display-mode: fullscreen)').matches||matchMedia('(display-mode: standalone)').matches||navigator.standalone===true;
const mobile=()=>(matchMedia('(pointer:coarse)').matches||navigator.maxTouchPoints>0)&&Math.min(innerWidth,innerHeight)<=600;

let gate,btn,note,attempting=false;
let gameStarted=false;

const showFallback=()=>{
 if(gameStarted&&!fsEl()&&!standalone()&&mobile()&&!document.body.classList.contains('in-lobby'))
  gate?.classList.add('show');
};

/** Attempt fullscreen and landscape immediately; call directly from a user click when available. */
export async function requestGameDisplayMode({allowContinue=false}={}){
 gameStarted=true;
 if(!mobile()||standalone()) return true;
 if(attempting) return false;
 if(fsEl()){
  try{await screen.orientation?.lock?.('landscape')}catch{}
  gate?.classList.remove('show');
  return true;
 }

 attempting=true;
 let enteredFullscreen=false;
 try{
  if(root().requestFullscreen){
   await root().requestFullscreen({navigationUI:'hide'});
   enteredFullscreen=Boolean(fsEl());
  }else if(root().webkitRequestFullscreen){
   root().webkitRequestFullscreen();
   enteredFullscreen=Boolean(fsEl());
  }
 }catch{}

 let lockedLandscape=false;
 try{
  await screen.orientation?.lock?.('landscape');
  lockedLandscape=screen.orientation?.type?.startsWith('landscape')===true;
 }catch{}
 attempting=false;

 if(enteredFullscreen){
  gate?.classList.remove('show');
  return true;
 }

 if(note){
  note.textContent=canFs()
   ? 'Browser memblokir layar penuh otomatis. Ketuk tombol di bawah satu kali untuk melanjutkan.'
   : 'Browser ini tidak mendukung layar penuh. Putar HP ke landscape, atau buka dari ikon layar utama untuk menyembunyikan bar browser.';
 }
 if(allowContinue){
  gate?.classList.remove('show');
  return lockedLandscape;
 }
 setTimeout(showFallback,0);
 return false;
}

export function checkFullscreenGate(){
 showFallback();
}

export function initFullscreen({client=socketClient}={}){
 gate=document.getElementById('fs-gate');
 btn=document.getElementById('fs-go');
 note=document.getElementById('fs-note');
 if(!gate||!btn) return ()=>{};

 btn.onclick=()=>requestGameDisplayMode({allowContinue:true});
 const onRoomStarted=()=>{
  gameStarted=true;
  requestGameDisplayMode();
 };
 const removeRoomStarted=client.on('room:started',onRoomStarted);

 const onChange=()=>{
  if(fsEl()) gate.classList.remove('show');
  else{
   try{screen.orientation?.unlock?.()}catch{}
   showFallback();
  }
 };
 document.addEventListener('fullscreenchange',onChange);
 document.addEventListener('webkitfullscreenchange',onChange);
 return ()=>{
  removeRoomStarted();
  document.removeEventListener('fullscreenchange',onChange);
  document.removeEventListener('webkitfullscreenchange',onChange);
 };
}
