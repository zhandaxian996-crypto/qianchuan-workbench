const fs = require('fs');
const file = 'src/Video.tsx';
let s = fs.readFileSync(file, 'utf8');

const replacements = [
  [
    "  const s=spring({fps:30,frame:Math.max(0,f-delay),config:{damping:15,stiffness:145,mass:.8}});",
    "  const p=interpolate(f,[delay,delay+18],[0,1],{...clamp,easing:Easing.bezier(.16,1,.3,1)});"
  ],
  [
    "    scale:s,translate:`0 ${interpolate(s,[0,1],[24,0])}px`,opacity:s,",
    "    opacity:p,transform:`translateY(${(1-p)*24}px) scale(${.82+p*.18})`,"
  ],
  [
    "const Pill=({text,color=C.blue,delay=0}:{text:string;color?:string;delay?:number})=>{\n  const f=useCurrentFrame();\n  const p=spring({fps:30,frame:Math.max(0,f-delay),config:{damping:18,stiffness:120}});\n  return <div style={{padding:'12px 18px',borderRadius:16,background:'rgba(255,255,255,.08)',border:`1px solid ${color}66`,fontSize:22,fontWeight:800,color,opacity:p,scale:p}}>{text}</div>;\n};",
    "const Pill=({text,color=C.blue,delay=0}:{text:string;color?:string;delay?:number})=>{\n  const f=useCurrentFrame();\n  const p=interpolate(f,[delay,delay+14],[0,1],{...clamp,easing:Easing.bezier(.16,1,.3,1)});\n  return <div style={{padding:'12px 18px',borderRadius:16,background:'rgba(255,255,255,.08)',border:`1px solid ${color}66`,fontSize:22,fontWeight:800,color,opacity:p,transform:`scale(${.86+p*.14})`}}>{text}</div>;\n};"
  ],
  [
    "const Database=({x,y,delay}:{x:number;y:number;delay:number})=>{\n  const f=useCurrentFrame(); const p=spring({fps:30,frame:Math.max(0,f-delay),config:{damping:18,stiffness:120}});\n  return <div style={{position:'absolute',left:x,top:y,width:340,height:300,opacity:p,scale:p}}>",
    "const Database=({x,y,delay}:{x:number;y:number;delay:number})=>{\n  const f=useCurrentFrame(); const p=interpolate(f,[delay,delay+18],[0,1],{...clamp,easing:Easing.bezier(.16,1,.3,1)});\n  return <div style={{position:'absolute',left:x,top:y,width:340,height:300,opacity:p,transform:`translateY(${(1-p)*24}px) scale(${.88+p*.12})`}}>"
  ]
];

for (const [from, to] of replacements) {
  if (!s.includes(from)) throw new Error('Expected source fragment not found: ' + from.slice(0, 80));
  s = s.replace(from, to);
}

fs.writeFileSync(file, s);
console.log('Applied Remotion V2 visibility fixes');
