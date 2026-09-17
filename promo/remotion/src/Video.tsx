import React from 'react';
import {
  AbsoluteFill,
  Easing,
  Img,
  interpolate,
  Sequence,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';

const clamp = {extrapolateLeft: 'clamp' as const, extrapolateRight: 'clamp' as const};
const blue = '#4F8DFD';
const cyan = '#7ED6FF';
const green = '#48D69B';
const amber = '#F6C45B';
const navy = '#0B1832';
const muted = '#6D7F9F';

const bgLight: React.CSSProperties = {
  background: 'radial-gradient(circle at 80% 18%,rgba(126,214,255,.28),transparent 34%),linear-gradient(135deg,#F8FBFF,#EDF5FF 58%,#F8FBFF)',
  color: navy,
};
const bgDark: React.CSSProperties = {
  background: 'radial-gradient(circle at 72% 20%,rgba(79,141,253,.28),transparent 35%),linear-gradient(135deg,#071120,#0C1D39 58%,#122848)',
  color: '#F3F8FF',
};

const SceneFade: React.FC<React.PropsWithChildren<{duration:number; dark?:boolean}>> = ({duration,dark,children}) => {
  const frame = useCurrentFrame();
  return <AbsoluteFill style={{...(dark?bgDark:bgLight),opacity:interpolate(frame,[0,14,duration-14,duration],[0,1,1,0],clamp)}}>{children}</AbsoluteFill>;
};

const Grid: React.FC<{dark?:boolean}> = ({dark}) => {
  const frame = useCurrentFrame();
  return <AbsoluteFill style={{opacity:dark?.14:.18,backgroundImage:`linear-gradient(${dark?'rgba(130,180,255,.18)':'rgba(79,141,253,.12)'} 1px,transparent 1px),linear-gradient(90deg,${dark?'rgba(130,180,255,.18)':'rgba(79,141,253,.12)'} 1px,transparent 1px)`,backgroundSize:'58px 58px',backgroundPosition:`${interpolate(frame,[0,300],[0,120],clamp)}px 0`}}/>;
};

const Kicker: React.FC<{children:React.ReactNode; dark?:boolean}> = ({children,dark}) => <div style={{fontSize:22,fontWeight:800,letterSpacing:4,color:dark?'#9EC3FF':'#5E80B4'}}>{children}</div>;
const H1: React.FC<{children:React.ReactNode; dark?:boolean; size?:number}> = ({children,dark,size=76}) => <div style={{fontSize:size,lineHeight:1.14,fontWeight:950,letterSpacing:-2,color:dark?'#F5F9FF':navy}}>{children}</div>;
const P: React.FC<{children:React.ReactNode; dark?:boolean}> = ({children,dark}) => <div style={{fontSize:30,lineHeight:1.55,fontWeight:520,color:dark?'#BED0EA':muted}}>{children}</div>;

const Card: React.FC<React.PropsWithChildren<{x:number;y:number;w:number;delay:number;dark?:boolean}>> = ({x,y,w,delay,dark,children}) => {
  const frame = useCurrentFrame();
  const p = spring({frame:Math.max(0,frame-delay),fps:30,config:{damping:18,stiffness:120}});
  return <div style={{position:'absolute',left:x,top:y,width:w,padding:'28px 30px',borderRadius:28,background:dark?'rgba(255,255,255,.07)':'rgba(255,255,255,.94)',border:dark?'1px solid rgba(255,255,255,.13)':'1px solid rgba(79,141,253,.14)',boxShadow:dark?'0 20px 60px rgba(0,0,0,.18)':'0 22px 70px rgba(31,69,124,.12)',scale:p,opacity:p}}>{children}</div>;
};

const Badge: React.FC<{children:React.ReactNode;color?:string;dark?:boolean}> = ({children,color=blue,dark}) => <div style={{padding:'11px 18px',borderRadius:999,background:dark?'rgba(255,255,255,.07)':'rgba(255,255,255,.92)',border:dark?'1px solid rgba(255,255,255,.13)':'1px solid rgba(79,141,253,.14)',fontSize:21,fontWeight:850,color}}>{children}</div>;

const Scene1: React.FC = () => {
  const frame=useCurrentFrame();
  return <SceneFade duration={180}><Grid/>
    <div style={{position:'absolute',left:110,top:145,width:980,zIndex:2}}>
      <div style={{opacity:interpolate(frame,[0,20],[0,1],clamp)}}><Kicker>OPEN SOURCE · QIANCHUAN · AI AGENT</Kicker></div>
      <div style={{marginTop:22,opacity:interpolate(frame,[8,34],[0,1],clamp),translate:interpolate(frame,[8,34],['0px 42px','0px 0px'],{...clamp,easing:Easing.bezier(.16,1,.3,1)})}}><H1 size={88}>我把我的抖音直播<br/>千川 <span style={{color:blue}}>AI 投流系统</span>开源了</H1></div>
      <div style={{display:'flex',gap:14,marginTop:34,opacity:interpolate(frame,[38,66],[0,1],clamp)}}><Badge>本地运行</Badge><Badge color={green}>MCP</Badge><Badge color={amber}>Decision Memory</Badge></div>
    </div>
    <div style={{position:'absolute',right:70,top:120,width:920,height:575,borderRadius:36,overflow:'hidden',boxShadow:'0 35px 100px rgba(35,74,128,.24)',opacity:interpolate(frame,[22,52],[0,1],clamp),translate:interpolate(frame,[22,62],['120px 50px','0px 0px'],{...clamp,easing:Easing.bezier(.16,1,.3,1)}),rotate:interpolate(frame,[22,62],['2deg','0deg'],clamp)}}><Img src={staticFile('workbench-day.webp')} style={{width:'100%',height:'100%',objectFit:'cover'}}/></div>
    <div style={{position:'absolute',left:110,bottom:95,fontSize:27,color:muted,opacity:interpolate(frame,[76,105],[0,1],clamp)}}>它最开始不是产品，只是我给自己小团队做的一套工具。</div>
  </SceneFade>;
};

const Scene2: React.FC = () => {
  const frame=useCurrentFrame();
  return <SceneFade duration={240}><Grid/>
    <div style={{position:'absolute',left:110,top:78}}><Kicker>WHY I BUILT IT</Kicker><div style={{marginTop:14}}><H1 size={66}>我们没有专门的人负责投放和盯盘</H1></div></div>
    <div style={{position:'absolute',left:110,top:270,width:650}}><P>现场只有一个中控。一边配合主播，一边看数据，还要判断计划该不该调。</P></div>
    <Card x={860} y={230} w={330} delay={28}><div style={{fontSize:26,color:'#FF7184',fontWeight:900}}>主播</div><div style={{fontSize:31,fontWeight:900,marginTop:14}}>专注直播内容</div><div style={{fontSize:21,color:muted,marginTop:9}}>节奏、话术、互动</div></Card>
    <Card x={1240} y={230} w={410} delay={48}><div style={{fontSize:26,color:blue,fontWeight:900}}>中控</div><div style={{fontSize:31,fontWeight:900,marginTop:14}}>一个人同时做很多事</div><div style={{fontSize:21,color:muted,marginTop:9}}>控场 · 沟通 · 看数据 · 盯投放</div></Card>
    {['跟主播沟通','盯实时数据','看计划状态','判断要不要调','记录发生了什么'].map((t,i)=><div key={t} style={{position:'absolute',left:880+(i%2)*260,top:520+Math.floor(i/2)*86,padding:'15px 20px',borderRadius:18,background:'white',border:'1px solid #E1EAF8',boxShadow:'0 12px 30px rgba(30,65,115,.08)',fontSize:21,fontWeight:850,opacity:interpolate(frame,[75+i*9,104+i*9],[0,1],clamp),translate:interpolate(frame,[75+i*9,114+i*9],['0px 28px','0px 0px'],clamp)}}>{t}</div>)}
    <div style={{position:'absolute',left:110,bottom:112,fontSize:46,fontWeight:950,opacity:interpolate(frame,[135,166],[0,1],clamp)}}>人的精力有限，<span style={{color:'#FF7184'}}>会看数据 ≠ 会调投放</span></div>
    <div style={{position:'absolute',left:110,bottom:56,fontSize:29,color:muted,opacity:interpolate(frame,[160,190],[0,1],clamp)}}>所以我想，把“盯盘和判断”这件事交给 AI Agent。</div>
  </SceneFade>;
};

const FlowBox: React.FC<{x:number;y:number;w:number;title:string;sub:string;color:string;delay:number}> = ({x,y,w,title,sub,color,delay}) => <Card x={x} y={y} w={w} delay={delay} dark><div style={{fontSize:29,fontWeight:950,color}}>{title}</div><div style={{fontSize:19,lineHeight:1.45,color:'#B8CBE7',marginTop:8}}>{sub}</div></Card>;

const Scene3: React.FC = () => {
  const frame=useCurrentFrame();
  const path=(delay:number)=>interpolate(frame,[delay,delay+34],[1,0],clamp);
  return <SceneFade duration={270} dark><Grid dark/>
    <div style={{position:'absolute',left:105,top:72}}><Kicker dark>MCP IS THE CORE</Kicker><div style={{marginTop:14}}><H1 size={65} dark>真正的核心不是网页，是 <span style={{color:cyan}}>MCP 工具层</span></H1></div></div>
    <div style={{position:'absolute',left:105,top:235,width:630}}><P dark>让 Agent 不只是“聊天”，而是能读取账户、直播、素材和投放数据，并按真实结果继续下一步。</P></div>
    <FlowBox x={790} y={205} w={350} title="AI Agent" sub="观察 · 判断 · 复盘" color="#A9C9FF" delay={28}/>
    <FlowBox x={835} y={445} w={260} title="MCP" sub="统一工具入口 / next_step" color={cyan} delay={58}/>
    <FlowBox x={435} y={760} w={260} title="千川" sub="计划 / 消耗 / ROI" color={blue} delay={98}/>
    <FlowBox x={830} y={760} w={260} title="罗盘" sub="直播 / 商品 / 订单" color={green} delay={108}/>
    <FlowBox x={1225} y={760} w={300} title="本地数据" sub="历史 / 素材 / 复盘" color={amber} delay={118}/>
    <svg width="1920" height="1080" style={{position:'absolute',inset:0,pointerEvents:'none'}}>
      <path d="M965 365 L965 445" stroke={cyan} strokeWidth="4" fill="none" pathLength="1" strokeDasharray="1" strokeDashoffset={path(72)} />
      <path d="M900 615 C820 670 700 720 565 760" stroke={blue} strokeWidth="4" fill="none" pathLength="1" strokeDasharray="1" strokeDashoffset={path(122)} />
      <path d="M965 615 L965 760" stroke={green} strokeWidth="4" fill="none" pathLength="1" strokeDasharray="1" strokeDashoffset={path(132)} />
      <path d="M1030 615 C1120 670 1240 720 1375 760" stroke={amber} strokeWidth="4" fill="none" pathLength="1" strokeDasharray="1" strokeDashoffset={path(142)} />
    </svg>
    <div style={{position:'absolute',right:105,top:238,width:405,padding:'24px 26px',borderRadius:24,background:'rgba(4,14,32,.72)',border:'1px solid rgba(130,180,255,.18)',fontFamily:'monospace',fontSize:20,lineHeight:1.7,color:'#D7E7FF',opacity:interpolate(frame,[155,188],[0,1],clamp)}}><div style={{color:cyan}}>setup --check</div><div>✓ Node.js</div><div>✓ dependencies</div><div style={{marginTop:8,color:'#7DFFB5'}}>→ mcp endpoint</div><div style={{color:'#7DFFB5'}}>→ skill_entry</div><div style={{color:'#FFD77D'}}>→ next_step</div></div>
  </SceneFade>;
};

const Scene4: React.FC = () => {
  const frame=useCurrentFrame();
  return <SceneFade duration={270} dark><Grid dark/>
    <div style={{position:'absolute',left:105,top:72}}><Kicker dark>DECISION MEMORY</Kicker><div style={{marginTop:14}}><H1 size={64} dark>AI 可以换，但<span style={{color:amber}}>历史决策不能丢</span></H1></div></div>
    <div style={{position:'absolute',left:105,top:235,width:670}}><P dark>每次观察、判断、建议和结果回评，都写进本地 Decision Ledger。哪天换一个 Agent，也能继续读之前发生过什么。</P></div>
    <FlowBox x={180} y={520} w={310} title="Agent A" sub="今天做判断" color="#A9C9FF" delay={30}/>
    <FlowBox x={760} y={490} w={400} title="Decision Ledger" sub="rounds · snapshots · outcomes" color={amber} delay={70}/>
    <FlowBox x={1430} y={520} w={310} title="Agent B" sub="明天继续接手" color="#8DE8BA" delay={128}/>
    <svg width="1920" height="1080" style={{position:'absolute',inset:0}}><path d="M490 610 L760 610" stroke={amber} strokeWidth="4"/><path d="M1160 610 L1430 610" stroke={green} strokeWidth="4"/></svg>
    {['观察','判断','建议','结果','回评'].map((t,i)=><div key={t} style={{position:'absolute',left:700+i*132,top:760,padding:'12px 18px',borderRadius:999,background:'rgba(255,255,255,.07)',border:'1px solid rgba(255,255,255,.12)',fontSize:20,fontWeight:850,color:'#DCE8F8',opacity:interpolate(frame,[96+i*8,122+i*8],[0,1],clamp)}}>{t}</div>)}
    <div style={{position:'absolute',left:600,bottom:75,fontSize:38,fontWeight:950,color:'#F3F8FF',opacity:interpolate(frame,[172,205],[0,1],clamp)}}>模型可以替换，<span style={{color:amber}}>上下文继续存在</span></div>
  </SceneFade>;
};

const Scene5: React.FC = () => {
  const frame=useCurrentFrame();
  return <SceneFade duration={300}><Grid/>
    <div style={{position:'absolute',left:105,top:70}}><Kicker>LOCAL DATA LAYER</Kicker><div style={{marginTop:14}}><H1 size={61}>昨天已经发生的事，没必要每天重新从云端拉</H1></div></div>
    <div style={{position:'absolute',left:105,top:220,width:710}}><P>历史数据拉一次、确认一次，就沉淀到本地。后面查素材、查直播、做复盘，直接筛数据库。</P></div>
    <Card x={120} y={500} w={390} delay={34}><div style={{fontSize:58}}>☁</div><div style={{fontSize:31,fontWeight:950,marginTop:8}}>云端接口</div><div style={{fontSize:20,color:muted,marginTop:8}}>实时数据 / 新数据</div></Card>
    <div style={{position:'absolute',left:690,top:415,width:510,height:400,borderRadius:38,background:'#10264E',color:'white',boxShadow:'0 30px 90px rgba(20,45,90,.24)',padding:'38px 42px',opacity:interpolate(frame,[72,102],[0,1],clamp),scale:interpolate(frame,[72,112],[.92,1],clamp)}}><div style={{fontSize:27,color:'#80C6FF',fontWeight:900}}>SQLite · LOCAL</div><div style={{fontSize:43,fontWeight:950,marginTop:16}}>material_history.db</div><div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:14,marginTop:34,fontSize:21,color:'#C9D8F0'}}><div>素材日数据</div><div>盘中快照</div><div>素材脚本</div><div>创意信息</div><div>历史直播</div><div>复盘数据</div></div></div>
    {['按素材名称搜索','按日期 / 场次筛选','读取脚本与创意信息','历史直播快速回看'].map((t,i)=><div key={t} style={{position:'absolute',right:110,top:420+i*92,width:450,padding:'20px 24px',borderRadius:22,background:'white',border:'1px solid #DFE9F8',boxShadow:'0 12px 32px rgba(32,69,120,.08)',fontSize:23,fontWeight:850,opacity:interpolate(frame,[122+i*14,152+i*14],[0,1],clamp),translate:interpolate(frame,[122+i*14,164+i*14],['45px 0px','0px 0px'],clamp)}}>✓ {t}</div>)}
    <div style={{position:'absolute',left:105,bottom:62,fontSize:31,fontWeight:900,opacity:interpolate(frame,[210,240],[0,1],clamp)}}>数据库让查询和复盘变成<span style={{color:blue}}>可筛选、可追溯、可复用</span>。</div>
  </SceneFade>;
};

const Scene6: React.FC = () => {
  const frame=useCurrentFrame();
  return <SceneFade duration={270}>
    <div style={{position:'absolute',left:105,top:90,width:700}}><Kicker>WHY A FRONTEND?</Kicker><div style={{marginTop:15}}><H1 size={66}>那为什么我还要做前端？</H1></div></div>
    <div style={{position:'absolute',right:-20,top:130,width:1230,height:770,borderRadius:34,overflow:'hidden',boxShadow:'0 32px 90px rgba(33,73,128,.2)',opacity:interpolate(frame,[26,56],[0,1],clamp),translate:interpolate(frame,[26,72],['90px 20px','0px 0px'],clamp)}}><Img src={staticFile('workbench-day.webp')} style={{width:'100%',height:'100%',objectFit:'cover'}}/></div>
    <div style={{position:'absolute',left:105,top:355,width:610}}><div style={{fontSize:31,fontWeight:950,opacity:interpolate(frame,[62,92],[0,1],clamp)}}><span style={{color:green}}>01</span> 天天都要看，我想让它漂亮一点</div><div style={{fontSize:24,lineHeight:1.55,color:muted,marginTop:15,opacity:interpolate(frame,[78,108],[0,1],clamp)}}>自己用起来舒服一点，也更愿意每天打开。</div><div style={{fontSize:31,fontWeight:950,marginTop:42,opacity:interpolate(frame,[112,142],[0,1],clamp)}}><span style={{color:blue}}>02</span> 更重要：它是我的验数工具</div><div style={{fontSize:24,lineHeight:1.55,color:muted,marginTop:15,opacity:interpolate(frame,[128,158],[0,1],clamp)}}>Agent 拿到的数据到底是不是真的？是不是实时的？我必须能看见、能核对。</div></div>
    <div style={{position:'absolute',left:105,bottom:72,display:'flex',gap:14,opacity:interpolate(frame,[166,198],[0,1],clamp)}}><Badge color={blue}>source_at ✓</Badge><Badge color={green}>freshness ✓</Badge><Badge color={amber}>data_valid ✓</Badge></div>
  </SceneFade>;
};

const Scene7: React.FC = () => {
  const frame=useCurrentFrame();
  return <SceneFade duration={180} dark><Grid dark/>
    <div style={{position:'absolute',left:105,top:78}}><Kicker dark>ONE LOCAL SYSTEM</Kicker><div style={{marginTop:15}}><H1 size={63} dark>Agent、MCP、历史数据、前端验证，最后连成一套</H1></div></div>
    <div style={{position:'absolute',left:160,top:405,display:'flex',alignItems:'center',gap:28}}>{[['AI Agent','判断'],['MCP','工具'],['Local DB','记忆'],['Workbench','验证']].map(([a,b],i)=><React.Fragment key={a}><div style={{width:300,padding:'34px 28px',borderRadius:30,background:'rgba(255,255,255,.07)',border:'1px solid rgba(255,255,255,.14)',textAlign:'center',opacity:interpolate(frame,[24+i*17,54+i*17],[0,1],clamp),translate:interpolate(frame,[24+i*17,68+i*17],['0px 38px','0px 0px'],clamp)}}><div style={{fontSize:33,fontWeight:950,color:i===1?cyan:i===2?amber:'#F0F6FF'}}>{a}</div><div style={{fontSize:20,color:'#B8CBE7',marginTop:8}}>{b}</div></div>{i<3&&<div style={{fontSize:38,color:'#628FD2',opacity:interpolate(frame,[54+i*17,79+i*17],[0,1],clamp)}}>→</div>}</React.Fragment>)}</div>
    <div style={{position:'absolute',left:370,bottom:118,fontSize:36,fontWeight:950,opacity:interpolate(frame,[112,145],[0,1],clamp)}}>小团队不需要多一个复杂后台，<span style={{color:cyan}}>需要的是少一点重复劳动</span>。</div>
  </SceneFade>;
};

const Scene8: React.FC = () => {
  const frame=useCurrentFrame();
  return <SceneFade duration={90} dark><AbsoluteFill style={{justifyContent:'center',alignItems:'center',textAlign:'center'}}><div style={{opacity:interpolate(frame,[0,20],[0,1],clamp),scale:interpolate(frame,[0,30],[.94,1],{...clamp,easing:Easing.bezier(.16,1,.3,1)})}}><div style={{fontSize:24,letterSpacing:5,fontWeight:850,color:'#8FB9FF'}}>FREE & OPEN SOURCE</div><div style={{fontSize:72,fontWeight:950,marginTop:18}}>Qianchuan Workbench</div><div style={{fontSize:29,color:'#BCD0EE',marginTop:22}}>Agent · MCP · Local Data · Decision Memory</div><div style={{fontSize:27,color:'#8ED8FF',marginTop:42,fontFamily:'monospace'}}>github.com/zhandaxian996-crypto/qianchuan-workbench</div><div style={{fontSize:24,color:'#9FB0CA',marginTop:18}}>如果你也在折腾 Agent、MCP 或千川自动化，希望它能帮到你。</div></div></AbsoluteFill></SceneFade>;
};

export const QianchuanOpenSource: React.FC = () => {
  const {fps}=useVideoConfig();
  return <AbsoluteFill style={{fontFamily:'Inter,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif'}}>
    <Sequence from={0} durationInFrames={6*fps}><Scene1/></Sequence>
    <Sequence from={6*fps} durationInFrames={8*fps}><Scene2/></Sequence>
    <Sequence from={14*fps} durationInFrames={9*fps}><Scene3/></Sequence>
    <Sequence from={23*fps} durationInFrames={9*fps}><Scene4/></Sequence>
    <Sequence from={32*fps} durationInFrames={10*fps}><Scene5/></Sequence>
    <Sequence from={42*fps} durationInFrames={9*fps}><Scene6/></Sequence>
    <Sequence from={51*fps} durationInFrames={6*fps}><Scene7/></Sequence>
    <Sequence from={57*fps} durationInFrames={3*fps}><Scene8/></Sequence>
  </AbsoluteFill>;
};
