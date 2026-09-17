import React from 'react';
import {
  AbsoluteFill,
  Easing,
  Img,
  Sequence,
  interpolate,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';

const FONT = '"Noto Sans CJK SC", "Noto Sans CJK", sans-serif';
const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
const C = {
  bg: '#061224',
  bg2: '#0B2041',
  panel: 'rgba(13,34,67,.86)',
  panel2: 'rgba(255,255,255,.075)',
  blue: '#55A4FF',
  cyan: '#63E5FF',
  pink: '#FF5CB8',
  purple: '#A47BFF',
  green: '#5DE2A5',
  amber: '#FFD36B',
  white: '#F7FBFF',
  muted: '#A8BBD7',
  danger: '#FF718A',
};
const clamp = {extrapolateLeft: 'clamp' as const, extrapolateRight: 'clamp' as const};

const fade = (f:number,d:number) => interpolate(f,[0,12,d-12,d],[0,1,1,0],clamp);

const Grid = () => {
  const f = useCurrentFrame();
  return <AbsoluteFill style={{
    backgroundImage:'linear-gradient(rgba(99,229,255,.07) 1px,transparent 1px),linear-gradient(90deg,rgba(99,229,255,.07) 1px,transparent 1px)',
    backgroundSize:'62px 62px',
    backgroundPosition:`${interpolate(f,[0,300],[0,80],clamp)}px ${interpolate(f,[0,300],[0,-50],clamp)}px`,
    opacity:.72,
  }}/>;
};

const Glow = ({x,y,size,color,opacity=.22}:{x:number;y:number;size:number;color:string;opacity?:number}) =>
  <div style={{position:'absolute',left:x-size/2,top:y-size/2,width:size,height:size,borderRadius:'50%',background:color,filter:'blur(90px)',opacity}}/>;

const Shell:React.FC<React.PropsWithChildren<{duration:number;light?:boolean}>>=({duration,children,light})=>{
  const f=useCurrentFrame();
  return <AbsoluteFill style={{
    fontFamily:FONT,
    overflow:'hidden',
    color:light?'#0D2242':C.white,
    opacity:fade(f,duration),
    background:light
      ? 'radial-gradient(circle at 50% 30%,#FFFFFF 0%,#EDF6FF 54%,#DFECFA 100%)'
      : 'radial-gradient(circle at 50% 28%,#153D73 0%,#091D39 42%,#061224 100%)',
  }}>{!light&&<Grid/>}{children}</AbsoluteFill>;
};

const TopTag=({children}:{children:React.ReactNode})=><div style={{
  display:'inline-flex',padding:'10px 18px',borderRadius:999,
  border:'1px solid rgba(99,229,255,.28)',background:'rgba(7,25,49,.56)',
  color:C.cyan,fontWeight:800,fontSize:18,letterSpacing:3,
}}>{children}</div>;

const BlockWord=({text,color=C.white,delay=0,size=66}:{text:string;color?:string;delay?:number;size?:number})=>{
  const f=useCurrentFrame();
  const s=spring({fps:30,frame:Math.max(0,f-delay),config:{damping:15,stiffness:145,mass:.8}});
  return <div style={{
    display:'inline-flex',alignItems:'center',justifyContent:'center',
    padding:`${Math.round(size*.18)}px ${Math.round(size*.28)}px`,margin:'7px',
    borderRadius:Math.round(size*.2),fontSize:size,fontWeight:950,lineHeight:1,
    letterSpacing:-2,color,
    background:'linear-gradient(180deg,rgba(255,255,255,.18),rgba(255,255,255,.06))',
    border:'1px solid rgba(255,255,255,.16)',
    boxShadow:'inset 0 2px rgba(255,255,255,.20),0 14px 0 rgba(2,12,27,.34),0 28px 60px rgba(0,0,0,.22)',
    scale:s,translate:`0 ${interpolate(s,[0,1],[24,0])}px`,opacity:s,
  }}>{text}</div>;
};

const Panel:React.FC<React.PropsWithChildren<{style?:React.CSSProperties;delay?:number}>>=({children,style,delay=0})=>{
  const f=useCurrentFrame();
  const p=spring({fps:30,frame:Math.max(0,f-delay),config:{damping:18,stiffness:120}});
  return <div style={{
    position:'absolute',borderRadius:26,padding:26,
    background:C.panel,border:'1px solid rgba(116,196,255,.22)',
    boxShadow:'0 24px 70px rgba(0,0,0,.25),inset 0 1px rgba(255,255,255,.10)',
    opacity:p,scale:interpolate(p,[0,1],[.94,1]),translate:`0 ${interpolate(p,[0,1],[24,0])}px`,
    ...style,
  }}>{children}</div>;
};

const Pill=({text,color=C.blue,delay=0}:{text:string;color?:string;delay?:number})=>{
  const f=useCurrentFrame();
  const p=spring({fps:30,frame:Math.max(0,f-delay),config:{damping:18,stiffness:120}});
  return <div style={{padding:'12px 18px',borderRadius:16,background:'rgba(255,255,255,.08)',border:`1px solid ${color}66`,fontSize:22,fontWeight:800,color,opacity:p,scale:p}}>{text}</div>;
};

const PulseRing=({delay,color=C.cyan,size=180}:{delay:number;color?:string;size?:number})=>{
  const f=useCurrentFrame();
  const local=Math.max(0,f-delay);
  return <div style={{position:'absolute',left:'50%',top:'50%',width:size,height:size,borderRadius:'50%',border:`5px solid ${color}`,
    translate:'-50% -50%',scale:interpolate(local,[0,22],[.25,1.45],clamp),opacity:interpolate(local,[0,6,22],[0,.85,0],clamp)}}/>;
};

const DoubleTapScene=()=>{
  const f=useCurrentFrame();
  const handIn=spring({fps:30,frame:Math.max(0,f-32),config:{damping:16,stiffness:115}});
  const titleFade=interpolate(f,[4,18,72,86],[0,1,1,0],clamp);
  const boom=interpolate(f,[64,76,110],[0,1,0],clamp);
  return <Shell duration={150}>
    <Glow x={960} y={540} size={760} color={C.blue} opacity={.18}/><Glow x={960} y={540} size={470} color={C.pink} opacity={.12}/>
    <div style={{position:'absolute',left:0,right:0,top:160,textAlign:'center',opacity:titleFade}}>
      <TopTag>一个小互动</TopTag>
      <div style={{marginTop:28,fontSize:72,fontWeight:950,letterSpacing:-2}}>请在 <span style={{color:C.amber}}>两秒后</span> 双击屏幕</div>
      <div style={{marginTop:18,fontSize:28,color:C.muted}}>看看你会不会真的点一下</div>
    </div>
    <div style={{position:'absolute',left:0,right:0,top:410,textAlign:'center',fontSize:96,fontWeight:950,color:C.cyan,
      opacity:interpolate(f,[18,28,54,64],[0,1,1,0],clamp)}}>{f<42?'2':'1'}</div>
    <div style={{position:'absolute',left:720,top:455,width:480,height:350}}>
      <PulseRing delay={60}/><PulseRing delay={70} color={C.pink} size={220}/>
      <Img src={staticFile('hand.webp')} style={{position:'absolute',width:300,left:120,top:80,
        opacity:handIn,scale:interpolate(handIn,[0,1],[.6,1]),
        translate:`${interpolate(f,[32,60,68,76],['150px 150px','0px 0px','-4px -8px','0px 0px'],clamp)}`,
      }}/>
    </div>
    {[0,1,2,3,4,5,6,7].map(i=><div key={i} style={{position:'absolute',left:960,top:570,width:18+((i%3)*8),height:18+((i%3)*8),borderRadius:7,
      background:[C.pink,C.cyan,C.amber,C.purple][i%4],
      translate:`${interpolate(boom,[0,1],[0,Math.cos(i*.79)*(260+i*24)])}px ${interpolate(boom,[0,1],[0,Math.sin(i*.79)*(210+i*16)])}px`,
      rotate:`${interpolate(boom,[0,1],[0,180+i*35])}deg`,opacity:boom}}/>)}
    {[0,1,2,3,4].map(i=><Img key={i} src={staticFile('hearts.webp')} style={{position:'absolute',width:95,left:900+i*22,top:520,
      opacity:boom,scale:interpolate(boom,[0,1],[.45,.95]),
      translate:`${(i-2)*125}px ${-110-Math.abs(i-2)*60}px`,rotate:`${(i-2)*14}deg`}}/>)}
    <div style={{position:'absolute',left:0,right:0,bottom:145,textAlign:'center',fontSize:25,color:C.muted,
      opacity:interpolate(f,[88,108],[0,1],clamp)}}>双击完成，正式开始。</div>
  </Shell>;
};

const LaunchScene=()=>{
  const f=useCurrentFrame();
  return <Shell duration={180}>
    <Glow x={960} y={500} size={900} color={C.blue}/><Glow x={1200} y={550} size={650} color={C.pink} opacity={.10}/>
    <div style={{position:'absolute',left:150,right:150,top:135,textAlign:'center'}}><TopTag>OPEN SOURCE · DOUYIN LIVE · QIANCHUAN</TopTag></div>
    <div style={{position:'absolute',left:120,right:120,top:285,textAlign:'center'}}>
      <BlockWord text="我把我的" delay={12} size={54}/>
      <BlockWord text="抖音直播" delay={20} color={C.cyan} size={64}/>
      <BlockWord text="千川 AI 投流系统" delay={30} color={C.pink} size={64}/>
      <BlockWord text="开源了" delay={44} color={C.amber} size={72}/>
    </div>
    <div style={{position:'absolute',left:0,right:0,top:690,textAlign:'center',fontSize:30,color:C.muted,
      opacity:interpolate(f,[70,96],[0,1],clamp)}}>最开始不是为了做产品，只是想解决我们自己团队的盯盘问题。</div>
    <div style={{position:'absolute',left:0,right:0,top:775,display:'flex',justifyContent:'center',gap:18}}>
      <Pill text="本地运行" delay={90}/><Pill text="MCP" delay={98} color={C.cyan}/><Pill text="Decision Memory" delay={106} color={C.amber}/><Pill text="开源" delay={114} color={C.green}/>
    </div>
  </Shell>;
};

const WhyScene=()=>{
  const f=useCurrentFrame();
  return <Shell duration={210}>
    <Glow x={960} y={520} size={820} color={C.purple} opacity={.15}/>
    <div style={{position:'absolute',left:0,right:0,top:90,textAlign:'center'}}><TopTag>为什么会有这个系统</TopTag></div>
    <div style={{position:'absolute',left:0,right:0,top:170,textAlign:'center',fontSize:62,fontWeight:950}}>小团队，<span style={{color:C.pink}}>没有专门的人盯投放</span></div>
    <Panel delay={28} style={{left:210,top:350,width:410,height:260}}>
      <div style={{fontSize:24,color:C.cyan,fontWeight:850}}>主播</div><div style={{fontSize:40,fontWeight:950,marginTop:18}}>专注直播内容</div>
      <div style={{fontSize:24,color:C.muted,marginTop:18,lineHeight:1.55}}>节奏 · 话术 · 互动<br/>需要持续保持状态</div>
    </Panel>
    <Panel delay={42} style={{left:755,top:305,width:410,height:350,border:`2px solid ${C.pink}88`}}>
      <div style={{fontSize:24,color:C.pink,fontWeight:850}}>中控</div><div style={{fontSize:42,fontWeight:950,marginTop:18}}>一个人同时做很多事</div>
      <div style={{display:'flex',flexWrap:'wrap',gap:12,marginTop:28}}>
        {['控场','配合主播','看实时数据','盯计划','记变化'].map((t,i)=><Pill key={t} text={t} delay={62+i*7} color={i%2?C.purple:C.blue}/>) }
      </div>
    </Panel>
    <Panel delay={54} style={{right:210,top:350,width:410,height:260}}>
      <div style={{fontSize:24,color:C.amber,fontWeight:850}}>投放</div><div style={{fontSize:40,fontWeight:950,marginTop:18}}>会看 ≠ 会调</div>
      <div style={{fontSize:24,color:C.muted,marginTop:18,lineHeight:1.55}}>ROI 变化了怎么办？<br/>什么时候该等，什么时候该动？</div>
    </Panel>
    <div style={{position:'absolute',left:0,right:0,bottom:145,textAlign:'center',fontSize:42,fontWeight:950,
      opacity:interpolate(f,[118,148],[0,1],clamp)}}>所以我想，把 <span style={{color:C.green}}>盯盘 + 判断</span> 这件事交给 Agent。</div>
  </Shell>;
};

const Node=({x,y,title,sub,color,delay,w=270}:{x:number;y:number;title:string;sub:string;color:string;delay:number;w?:number})=><Panel delay={delay} style={{left:x,top:y,width:w,textAlign:'center',padding:'22px 24px'}}>
  <div style={{width:58,height:58,borderRadius:18,margin:'0 auto 13px',background:`linear-gradient(135deg,${color},#ffffff22)`,boxShadow:`0 0 35px ${color}66`}}/>
  <div style={{fontSize:30,fontWeight:950,color}}>{title}</div><div style={{fontSize:19,color:C.muted,marginTop:7}}>{sub}</div>
</Panel>;

const ArchitectureScene=()=>{
  const f=useCurrentFrame(); const draw=(d:number)=>interpolate(f,[d,d+28],[1,0],clamp);
  return <Shell duration={210}>
    <Glow x={960} y={515} size={980} color={C.blue} opacity={.17}/>
    <div style={{position:'absolute',left:0,right:0,top:70,textAlign:'center'}}><TopTag>真正的核心</TopTag></div>
    <div style={{position:'absolute',left:0,right:0,top:138,textAlign:'center',fontSize:58,fontWeight:950}}>不是这个网页，而是 <span style={{color:C.cyan}}>Agent + MCP</span></div>
    <Node x={825} y={270} title="AI Agent" sub="观察 · 查询 · 判断 · 复盘" color={C.purple} delay={20}/>
    <Node x={825} y={520} title="MCP" sub="把能力变成可调用工具" color={C.cyan} delay={48}/>
    <Node x={220} y={750} title="千川" sub="计划 / 消耗 / ROI" color={C.blue} delay={82}/>
    <Node x={640} y={750} title="罗盘" sub="直播 / 商品 / 订单" color={C.green} delay={90}/>
    <Node x={1060} y={750} title="本地数据库" sub="历史数据 / 素材 / 脚本" color={C.amber} delay={98}/>
    <Node x={1480} y={750} title="决策记忆" sub="判断 / 结果 / 回评" color={C.pink} delay={106}/>
    <svg width="1920" height="1080" style={{position:'absolute',inset:0}}>
      <path d="M960 455 L960 520" stroke={C.cyan} strokeWidth="5" pathLength="1" strokeDasharray="1" strokeDashoffset={draw(62)}/>
      <path d="M960 700 C760 720 520 720 355 750" stroke={C.blue} strokeWidth="4" fill="none" pathLength="1" strokeDasharray="1" strokeDashoffset={draw(110)}/>
      <path d="M960 700 C860 720 810 720 775 750" stroke={C.green} strokeWidth="4" fill="none" pathLength="1" strokeDasharray="1" strokeDashoffset={draw(118)}/>
      <path d="M960 700 C1070 720 1150 720 1195 750" stroke={C.amber} strokeWidth="4" fill="none" pathLength="1" strokeDasharray="1" strokeDashoffset={draw(126)}/>
      <path d="M960 700 C1240 720 1480 720 1615 750" stroke={C.pink} strokeWidth="4" fill="none" pathLength="1" strokeDasharray="1" strokeDashoffset={draw(134)}/>
    </svg>
  </Shell>;
};

const ToolCard=({label,value,color,delay}:{label:string;value:string;color:string;delay:number})=>{
  const f=useCurrentFrame(); const p=spring({fps:30,frame:Math.max(0,f-delay),config:{damping:18,stiffness:130}});
  return <div style={{height:86,borderRadius:20,padding:'16px 20px',background:'rgba(255,255,255,.07)',border:`1px solid ${color}55`,opacity:p,translate:`${interpolate(p,[0,1],[40,0])}px 0`}}>
    <div style={{fontSize:17,color:C.muted,fontWeight:750}}>{label}</div><div style={{fontSize:25,color,fontWeight:900,marginTop:5}}>{value}</div>
  </div>;
};

const AgentFlowScene=()=>{
  const f=useCurrentFrame();
  const phase=f<105?'query':f<220?'analysis':'decision';
  return <Shell duration={390}>
    <Glow x={960} y={530} size={900} color={phase==='decision'?C.green:phase==='analysis'?C.purple:C.blue} opacity={.16}/>
    <div style={{position:'absolute',left:0,right:0,top:54,textAlign:'center'}}><TopTag>模拟一轮真实的 Agent 工作</TopTag></div>
    <div style={{position:'absolute',left:240,right:240,top:115,textAlign:'center',fontSize:34,fontWeight:820,lineHeight:1.45,
      padding:'20px 30px',borderRadius:22,background:'rgba(255,255,255,.07)',border:'1px solid rgba(255,255,255,.15)'}}>
      当前直播在线上升，但成交没有同步起量，<span style={{color:C.amber}}>这一波要不要继续放量？</span>
    </div>
    <Panel delay={18} style={{left:130,top:320,width:360,height:500,textAlign:'center'}}>
      <div style={{width:118,height:118,borderRadius:36,margin:'10px auto',background:'linear-gradient(145deg,#EAF6FF,#7EC7FF)',boxShadow:'0 0 55px #55A4FF66',display:'grid',placeItems:'center',fontSize:58,fontWeight:950,color:'#0B2A52'}}>A</div>
      <div style={{fontSize:38,fontWeight:950,marginTop:22}}>Agent A</div>
      <div style={{fontSize:22,color:C.muted,marginTop:8}}>正在处理投放判断</div>
      <div style={{marginTop:34,padding:'12px 18px',borderRadius:16,background:phase==='query'?'#55A4FF22':phase==='analysis'?'#A47BFF22':'#5DE2A522',border:`1px solid ${phase==='query'?C.blue:phase==='analysis'?C.purple:C.green}66`,fontSize:23,fontWeight:900,color:phase==='query'?C.blue:phase==='analysis'?C.purple:C.green}}>{phase==='query'?'查询数据中…':phase==='analysis'?'分析中…':'形成决策'}</div>
    </Panel>
    <Panel delay={38} style={{left:560,top:315,width:470,height:510}}>
      <div style={{fontSize:24,fontWeight:900,color:C.cyan,marginBottom:16}}>MCP 工具调用</div>
      <div style={{display:'grid',gap:12}}>
        <ToolCard label="get_live_view" value="读取直播实时数据" color={C.blue} delay={58}/>
        <ToolCard label="delivery / ROI" value="读取计划消耗与 ROI" color={C.cyan} delay={70}/>
        <ToolCard label="decision_ledger" value="读取历史决策记录" color={C.pink} delay={82}/>
        <ToolCard label="local_history" value="查询本地历史数据" color={C.amber} delay={94}/>
      </div>
    </Panel>
    <Panel delay={118} style={{left:1100,top:315,width:690,height:510,border:`1px solid ${phase==='decision'?C.green:C.purple}66`}}>
      <div style={{fontSize:25,fontWeight:950,color:phase==='decision'?C.green:C.purple}}>{phase==='decision'?'决策建议':'分析结果'}</div>
      {phase!=='decision'?<div style={{marginTop:24,display:'grid',gap:17,fontSize:27,lineHeight:1.4}}>
        {['在线人数上升','成交转化未同步改善','当前 ROI 低于目标线','历史类似时段：盲目加量容易扩大低效消耗'].map((t,i)=><div key={t} style={{opacity:interpolate(f,[135+i*17,154+i*17],[0,1],clamp),display:'flex',gap:14,alignItems:'center'}}><span style={{width:12,height:12,borderRadius:4,background:[C.green,C.danger,C.amber,C.purple][i]}}/><span>{t}</span></div>)}
      </div>:<div style={{marginTop:24,display:'grid',gap:17,fontSize:28,lineHeight:1.4}}>
        {['暂不追加预算','保持当前投放节奏','10 分钟后复查','重点关注：转化率 / 停留 / 素材承接'].map((t,i)=><div key={t} style={{opacity:interpolate(f,[235+i*16,252+i*16],[0,1],clamp),display:'flex',gap:14,alignItems:'center'}}><span style={{width:26,height:26,borderRadius:8,display:'grid',placeItems:'center',background:C.green,color:'#052819',fontSize:17,fontWeight:950}}>✓</span><span>{t}</span></div>)}
      </div>}
      <div style={{position:'absolute',left:28,right:28,bottom:26,padding:'13px 18px',borderRadius:15,background:'rgba(93,226,165,.12)',border:'1px solid rgba(93,226,165,.40)',fontSize:21,fontWeight:850,color:C.green,
        opacity:interpolate(f,[300,324],[0,1],clamp)}}>✓ 已写入 Decision Ledger，等待下一次复查</div>
    </Panel>
    <svg width="1920" height="1080" style={{position:'absolute',inset:0,pointerEvents:'none'}}>
      <path d="M490 550 L560 550" stroke={C.cyan} strokeWidth="5"/><path d="M1030 550 L1100 550" stroke={phase==='decision'?C.green:C.purple} strokeWidth="5"/>
    </svg>
  </Shell>;
};

const Database=({x,y,delay}:{x:number;y:number;delay:number})=>{
  const f=useCurrentFrame(); const p=spring({fps:30,frame:Math.max(0,f-delay),config:{damping:18,stiffness:120}});
  return <div style={{position:'absolute',left:x,top:y,width:340,height:300,opacity:p,scale:p}}>
    {[0,1,2].map(i=><div key={i} style={{position:'absolute',left:25,top:55+i*70,width:290,height:82,borderRadius:'50%',background:`linear-gradient(180deg,#E9F5FF,${i===1?'#73BAFF':'#A9D8FF'})`,border:'4px solid #67B8FF',boxShadow:'0 12px 30px rgba(0,0,0,.20)'}}/>)}
    <div style={{position:'absolute',left:25,top:98,width:290,height:140,background:'linear-gradient(90deg,#A7D7FF,#E7F6FF 50%,#72BAFF)',borderLeft:'4px solid #67B8FF',borderRight:'4px solid #67B8FF'}}/>
    <div style={{position:'absolute',left:0,right:0,bottom:0,textAlign:'center',fontSize:29,fontWeight:950,color:C.amber}}>LOCAL DATA</div>
  </div>;
};

const MemoryScene=()=>{
  const f=useCurrentFrame();
  return <Shell duration={270}>
    <Glow x={960} y={530} size={900} color={C.pink} opacity={.12}/>
    <div style={{position:'absolute',left:0,right:0,top:72,textAlign:'center'}}><TopTag>为什么要把历史留在本地</TopTag></div>
    <div style={{position:'absolute',left:0,right:0,top:145,textAlign:'center'}}><BlockWord text="AI 可以换" delay={10} size={58}/><BlockWord text="历史决策不能丢" delay={24} color={C.pink} size={64}/></div>
    <Panel delay={45} style={{left:130,top:430,width:360,height:300,textAlign:'center'}}>
      <div style={{fontSize:78,fontWeight:950,color:C.blue}}>A</div><div style={{fontSize:34,fontWeight:950}}>Agent A</div><div style={{fontSize:21,color:C.muted,marginTop:12}}>今天做判断</div>
    </Panel>
    <Database x={790} y={430} delay={60}/>
    <Panel delay={120} style={{right:130,top:430,width:360,height:300,textAlign:'center'}}>
      <div style={{fontSize:78,fontWeight:950,color:C.pink}}>B</div><div style={{fontSize:34,fontWeight:950}}>Agent B</div><div style={{fontSize:21,color:C.muted,marginTop:12}}>以后继续接手</div>
    </Panel>
    <svg width="1920" height="1080" style={{position:'absolute',inset:0}}><path d="M490 575 C620 575 710 575 790 575" stroke={C.blue} strokeWidth="5"/><path d="M1130 575 C1260 575 1360 575 1430 575" stroke={C.pink} strokeWidth="5"/></svg>
    <div style={{position:'absolute',left:610,right:610,top:760,display:'flex',justifyContent:'center',gap:12,flexWrap:'wrap'}}>
      {['历史决策','历史直播','素材详情','脚本信息','结果回评'].map((t,i)=><Pill key={t} text={t} delay={140+i*8} color={[C.blue,C.cyan,C.green,C.amber,C.pink][i]}/>) }
    </div>
    <div style={{position:'absolute',left:0,right:0,bottom:100,textAlign:'center',fontSize:30,color:C.muted,opacity:interpolate(f,[170,200],[0,1],clamp)}}>换了新的 Agent，也能直接继承过去的判断和上下文。</div>
  </Shell>;
};

const FrontendScene=()=>{
  const f=useCurrentFrame();
  const zoom=interpolate(f,[0,240],[1.04,1.09],clamp);
  return <Shell duration={240} light>
    <div style={{position:'absolute',left:0,right:0,top:55,textAlign:'center'}}><TopTag>前端为什么存在</TopTag></div>
    <div style={{position:'absolute',left:0,right:0,top:120,textAlign:'center',fontSize:60,fontWeight:950,color:'#0D2242'}}>前端不是装饰，<span style={{color:'#267EF2'}}>它是我的验数工具</span></div>
    <div style={{position:'absolute',left:310,top:270,width:1300,height:675,borderRadius:30,overflow:'hidden',background:'white',border:'1px solid #CFE3F7',boxShadow:'0 34px 85px rgba(34,86,145,.20)'}}>
      <Img src={staticFile('workbench-day.webp')} style={{width:'100%',height:'100%',objectFit:'cover',scale:zoom}}/>
      <div style={{position:'absolute',left:0,right:0,top:0,height:80,background:'linear-gradient(180deg,rgba(255,255,255,.48),transparent)'}}/>
    </div>
    <Panel delay={54} style={{left:55,top:355,width:230,padding:18,background:'rgba(255,255,255,.92)',color:'#0D2242',border:'1px solid #CFE3F7'}}>
      <div style={{fontSize:26,fontWeight:950,color:'#267EF2'}}>数据真实吗？</div><div style={{fontSize:19,color:'#607A99',marginTop:8}}>和平台后台一致吗</div>
    </Panel>
    <Panel delay={72} style={{left:55,top:570,width:230,padding:18,background:'rgba(255,255,255,.92)',color:'#0D2242',border:'1px solid #CFE3F7'}}>
      <div style={{fontSize:26,fontWeight:950,color:'#6A53DD'}}>是实时的吗？</div><div style={{fontSize:19,color:'#607A99',marginTop:8}}>有没有延迟</div>
    </Panel>
    <Panel delay={90} style={{right:55,top:355,width:230,padding:18,background:'rgba(255,255,255,.92)',color:'#0D2242',border:'1px solid #CFE3F7'}}>
      <div style={{fontSize:26,fontWeight:950,color:'#00A870'}}>拉取准确吗？</div><div style={{fontSize:19,color:'#607A99',marginTop:8}}>口径和字段对吗</div>
    </Panel>
    <Panel delay={108} style={{right:55,top:570,width:230,padding:18,background:'rgba(255,255,255,.92)',color:'#0D2242',border:'1px solid #CFE3F7'}}>
      <div style={{fontSize:26,fontWeight:950,color:'#E99500'}}>历史好查吗？</div><div style={{fontSize:19,color:'#607A99',marginTop:8}}>直播 / 素材 / 脚本</div>
    </Panel>
    <div style={{position:'absolute',left:0,right:0,bottom:45,textAlign:'center',fontSize:25,color:'#607A99',opacity:interpolate(f,[125,150],[0,1],clamp)}}>把千川、罗盘、历史直播和本地数据放到一个地方，也方便我验证数据链路。</div>
  </Shell>;
};

const OutroScene=()=>{
  const f=useCurrentFrame();
  return <Shell duration={150}>
    <Glow x={960} y={500} size={860} color={C.blue}/><Glow x={960} y={620} size={540} color={C.pink} opacity={.10}/>
    <div style={{position:'absolute',left:0,right:0,top:115,textAlign:'center'}}><TopTag>FREE & OPEN SOURCE</TopTag></div>
    <div style={{position:'absolute',left:0,right:0,top:240,textAlign:'center'}}>
      <BlockWord text="给自己做" delay={12} size={58}/><BlockWord text="后来决定开源" delay={28} color={C.green} size={68}/>
    </div>
    <div style={{position:'absolute',left:0,right:0,top:555,textAlign:'center',fontSize:34,lineHeight:1.65,color:C.muted,
      opacity:interpolate(f,[52,78],[0,1],clamp)}}>如果你也在研究千川 Agent、MCP，或者自动化投流，<br/>希望这个项目能给你一点参考。</div>
    <div style={{position:'absolute',left:0,right:0,top:760,textAlign:'center',fontSize:46,fontWeight:950,color:C.white,
      opacity:interpolate(f,[82,105],[0,1],clamp)}}>qianchuan-workbench</div>
    <div style={{position:'absolute',left:0,right:0,top:825,textAlign:'center',fontFamily:MONO,fontSize:22,color:C.cyan,
      opacity:interpolate(f,[96,118],[0,1],clamp)}}>github.com/zhandaxian996-crypto/qianchuan-workbench</div>
  </Shell>;
};

export const QianchuanOpenSource:React.FC=()=>{
  const {fps}=useVideoConfig();
  return <AbsoluteFill style={{fontFamily:FONT,background:C.bg}}>
    <Sequence from={0} durationInFrames={5*fps}><DoubleTapScene/></Sequence>
    <Sequence from={5*fps} durationInFrames={6*fps}><LaunchScene/></Sequence>
    <Sequence from={11*fps} durationInFrames={7*fps}><WhyScene/></Sequence>
    <Sequence from={18*fps} durationInFrames={7*fps}><ArchitectureScene/></Sequence>
    <Sequence from={25*fps} durationInFrames={13*fps}><AgentFlowScene/></Sequence>
    <Sequence from={38*fps} durationInFrames={9*fps}><MemoryScene/></Sequence>
    <Sequence from={47*fps} durationInFrames={8*fps}><FrontendScene/></Sequence>
    <Sequence from={55*fps} durationInFrames={5*fps}><OutroScene/></Sequence>
  </AbsoluteFill>;
};
