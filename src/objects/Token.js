import Phaser from 'phaser';
import {getPawnCoord} from '../board/geometry.js';
export function makeToken(scene,p,idx){
 const [x,y]=getPawnCoord(p.pos,idx,4);
 const hx=s=>Phaser.Display.Color.HexStringToColor(s).color;
 const c=scene.add.container(x,y);
 const sd=scene.add.graphics();
 const jumpGroup=scene.add.container(0,0);
 const b=scene.add.graphics();
 sd.fillStyle(0x000000,.3).fillEllipse(0,2,26,11);
 b.fillStyle(hx(p.color)).fillTriangle(-11,0,11,0,0,-28).fillEllipse(0,0,22,8);
 b.fillStyle(hx(p.dark),.75).fillTriangle(0,0,11,0,0,-28);
 b.fillStyle(hx(p.color)).fillCircle(0,-31,9);b.fillStyle(0xffffff,.55).fillCircle(-3,-34,3);
 jumpGroup.add(b);
 c.add([sd,jumpGroup]);
 c.setDepth(y+10);
 scene.tweens.add({targets:b,y:-4,duration:700+idx*90,yoyo:true,repeat:-1,ease:'Sine.easeInOut',delay:idx*120});

 c.slideTo=function(tx,ty,duration=220){
  c.setDepth(ty+10);
  return new Promise(resolve=>{
   scene.tweens.add({
    targets:c,
    x:tx,
    y:ty,
    duration,
    ease:'Quad.easeOut',
    onComplete:resolve
   });
  });
 };

 c.hopTo=function(targetTileIdx,slotIndex=0,totalOnTile=1,duration=130){
  return new Promise(resolve=>{
   const [tx,ty]=getPawnCoord(targetTileIdx,slotIndex,totalOnTile);
   const halfDur = Math.round(duration / 2);
   c.setDepth(ty+10);
   scene.tweens.add({
    targets:c,
    x:tx,
    y:ty,
    duration:duration,
    ease:'Linear'
   });
   scene.tweens.add({
    targets:jumpGroup,
    y:-22,
    duration:halfDur,
    ease:'Quad.easeOut',
    yoyo:true,
    onComplete:()=>{
     jumpGroup.y=0;
     resolve();
    }
   });
   scene.tweens.add({
    targets:sd,
    scaleX:0.65,
    scaleY:0.65,
    alpha:0.18,
    duration:130,
    ease:'Quad.easeOut',
    yoyo:true,
    onComplete:()=>{
     sd.setScale(1);
     sd.setAlpha(0.3);
    }
   });
  });
 };

 return c;
}

