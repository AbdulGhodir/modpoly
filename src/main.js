import Phaser from 'phaser';
import './style.css';
import {GameScene} from './scenes/GameScene.js';
import './ui/hud.js';
import {initDice} from './ui/dice.js';
import {measureViewport} from './ui/viewport.js';
import {initFullscreen} from './ui/fullscreen.js';

initDice();
initFullscreen();

// Banner "putar layar" (portrait HP) – bisa ditutup, tidak memblokir game
document.getElementById('rotate-ok')?.addEventListener('click',()=>document.getElementById('rotate-hint')?.classList.add('dismissed'));

Promise.race([document.fonts.ready,new Promise(r=>setTimeout(r,1200))]).catch(()=>{}).then(()=>{
  const vp=measureViewport();
  // Canvas dibuat sebesar piksel FISIK (w*DPR) lalu ditampilkan 1/DPR via zoom → tidak ada upscale blur.
  const game=new Phaser.Game({
    type:Phaser.AUTO,
    parent:'g',
    transparent:true,
    scene:GameScene,
    scale:{mode:Phaser.Scale.NONE,width:Math.round(vp.w*vp.d),height:Math.round(vp.h*vp.d),zoom:1/vp.d},
    render:{antialias:true,antialiasGL:true,roundPixels:true,powerPreference:'high-performance'}
  });

  let last=`${vp.w}x${vp.h}@${vp.d}`,timer;
  const apply=()=>{
    const v=measureViewport(),key=`${v.w}x${v.h}@${v.d}`;
    if(key===last) return;
    last=key;
    const sm=game.scale;
    sm.setZoom(1/v.d);
    sm.resize(Math.round(v.w*v.d),Math.round(v.h*v.d)); // memicu event 'resize' → GameScene.fit()
    const c=game.canvas;
    c.style.width=v.w+'px';c.style.height=v.h+'px';
    sm.updateBounds();
  };
  // debounce: resize/rotasi memicu banyak event beruntun
  const schedule=()=>{clearTimeout(timer);timer=setTimeout(apply,90)};
  window.addEventListener('resize',schedule);
  window.addEventListener('orientationchange',()=>{schedule();setTimeout(schedule,350)});
  window.visualViewport?.addEventListener('resize',schedule);
  screen.orientation?.addEventListener?.('change',()=>{schedule();setTimeout(schedule,350)});
  document.addEventListener('fullscreenchange',()=>{schedule();setTimeout(schedule,300)});
});
