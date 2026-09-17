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

const clamp = {
  extrapolateLeft: 'clamp' as const,
  extrapolateRight: 'clamp' as const,
};

const FONT = '"Noto Sans CJK SC","Microsoft YaHei",sans-serif';
const BG = '#071326';
const PANEL = '#0D213D';
const PANEL_2 = '#102A4B';
const TEXT = '#F6FAFF';
const MUTED = '#9FB5D3';
const BLUE = '#58A8FF';
const CYAN = '#5EE7FF';
const PINK = '#FF5CA8';
const PURPLE = '#9B7BFF';
const GREEN = '#45E0A8';
const YELLOW = '#FFD866';
const RED = '#FF6B82';

const ease = Easing.bezier(0.16, 1, 0.3, 1);

const FadeScene: React.FC<React.PropsWithChildren<{duration:number; glow?:string}>> = ({duration, glow = BLUE, children}) => {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill
      style={{
        fontFamily: FONT,
        color: TEXT,
        overflow: 'hidden',
        background:
          `radial-gradient(circle at 50% 42%, ${glow}22 0%, transparent 34%),` +
          'radial-gradient(circle at 85% 12%, rgba(94,231,255,.11), transparent 28%),' +
          'linear-gradient(145deg,#06101F 0%,#071326 48%,#0A1930 100%)',
        opacity: interpolate(frame, [0, 10, duration - 10, duration], [0, 1, 1, 0], clamp),
      }}
    >
      <Grid />
      <GlowOrbs />
      {children}
    </AbsoluteFill>
  );
};

const Grid: React.FC = () => {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill
      style={{
        opacity: 0.19,
        backgroundImage:
          'linear-gradient(rgba(121,175,255,.12) 1px,transparent 1px),linear-gradient(90deg,rgba(121,175,255,.12) 1px,transparent 1px)',
        backgroundSize: '56px 56px',
        backgroundPosition: `${interpolate(frame, [0, 300], [0, 84], clamp)}px 0px`,
      }}
    />
  );
};

const GlowOrbs: React.FC = () => {
  const frame = useCurrentFrame();
  const items = [
    {x: 86, y: 110, s: 16, c: PINK},
    {x: 1780, y: 160, s: 13, c: CYAN},
    {x: 1640, y: 860, s: 19, c: PURPLE},
    {x: 220, y: 820, s: 14, c: BLUE},
    {x: 1460, y: 310, s: 10, c: YELLOW},
    {x: 510, y: 210, s: 10, c: GREEN},
  ];
  return <>{items.map((it, i) => (
    <div
      key={i}
      style={{
        position: 'absolute',
        left: it.x,
        top: it.y,
        width: it.s,
        height: it.s,
        borderRadius: 5,
        background: it.c,
        boxShadow: `0 0 28px ${it.c}`,
        opacity: 0.62,
        translate: `0px ${Math.sin((frame + i * 12) / 22) * 10}px`,
        rotate: `${interpolate(frame, [0, 300], [0, 38 + i * 5], clamp)}deg`,
      }}
    />
  ))}</>;
};

const Kicker: React.FC<{children:React.ReactNode; color?:string}> = ({children, color = CYAN}) => (
  <div
    style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: 10,
      border: '1px solid rgba(255,255,255,.13)',
      background: 'rgba(255,255,255,.055)',
      borderRadius: 999,
      padding: '8px 16px',
      color,
      fontSize: 18,
      fontWeight: 900,
      letterSpacing: 2,
      boxShadow: 'inset 0 1px rgba(255,255,255,.08)',
    }}
  >
    {children}
  </div>
);

const BlockWord: React.FC<{children:React.ReactNode; color:string; delay?:number; size?:number}> = ({children, color, delay = 0, size = 72}) => {
  const frame = useCurrentFrame();
  const p = spring({frame: Math.max(0, frame - delay), fps: 30, config: {damping: 15, stiffness: 120}});
  return (
    <span
      style={{
        display: 'inline-block',
        margin: '0 8px 12px 0',
        padding: '7px 15px 10px',
        borderRadius: 13,
        background: `linear-gradient(180deg,${color},${color}CC)`,
        border: '2px solid rgba(255,255,255,.34)',
        boxShadow: `0 9px 0 ${color}66, 0 18px 42px ${color}22, inset 0 1px 0 rgba(255,255,255,.38)`,
        color: '#FFFFFF',
        fontSize: size,
        fontWeight: 1000,
        lineHeight: 1,
        letterSpacing: -2,
        scale: 0.78 + p * 0.22,
        translate: `0px ${22 * (1 - p)}px`,
        opacity: p,
        textShadow: '0 2px 0 rgba(0,0,0,.14)',
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </span>
  );
};

const GlassCard: React.FC<React.PropsWithChildren<{x?:number; y?:number; w?:number|string; pad?:number; accent?:string; delay?:number; style?:React.CSSProperties}>> = ({x, y, w, pad = 24, accent = BLUE, delay = 0, style, children}) => {
  const frame = useCurrentFrame();
  const p = spring({frame: Math.max(0, frame - delay), fps: 30, config: {damping: 18, stiffness: 110}});
  return (
    <div
      style={{
        position: x == null && y == null ? 'relative' : 'absolute',
        left: x,
        top: y,
        width: w,
        padding: pad,
        borderRadius: 24,
        background: 'linear-gradient(180deg,rgba(16,42,75,.92),rgba(10,28,51,.94))',
        border: `1px solid ${accent}55`,
        boxShadow: `0 20px 60px rgba(0,0,0,.22), inset 0 1px rgba(255,255,255,.06), 0 0 34px ${accent}12`,
        opacity: p,
        scale: 0.93 + p * 0.07,
        translate: `0px ${18 * (1 - p)}px`,
        ...style,
      }}
    >
      {children}
    </div>
  );
};

const Chip: React.FC<{children:React.ReactNode; color?:string}> = ({children, color = BLUE}) => (
  <span
    style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: 8,
      padding: '9px 14px',
      borderRadius: 12,
      background: `${color}17`,
      border: `1px solid ${color}3B`,
      color: '#EAF3FF',
      fontSize: 20,
      fontWeight: 850,
      whiteSpace: 'nowrap',
    }}
  >
    {children}
  </span>
);

const SectionTitle: React.FC<{kicker:string; title:React.ReactNode; sub?:string; color?:string}> = ({kicker, title, sub, color = CYAN}) => (
  <div style={{position: 'absolute', left: 120, right: 120, top: 62, textAlign: 'center', zIndex: 20}}>
    <Kicker color={color}>{kicker}</Kicker>
    <div style={{fontSize: 58, lineHeight: 1.16, fontWeight: 1000, marginTop: 14, letterSpacing: -1.4}}>{title}</div>
    {sub ? <div style={{fontSize: 24, color: MUTED, marginTop: 12, fontWeight: 650}}>{sub}</div> : null}
  </div>
);

const Scene1Hook: React.FC = () => {
  const frame = useCurrentFrame();
  const tap1 = interpolate(frame, [47, 54, 59], [1, 0.82, 1], {...clamp, easing: ease});
  const tap2 = interpolate(frame, [63, 70, 75], [1, 0.82, 1], {...clamp, easing: ease});
  const handScale = frame < 61 ? tap1 : tap2;
  const boom = interpolate(frame, [66, 93], [0, 1], {...clamp, easing: ease});
  const introOut = interpolate(frame, [82, 112], [1, 0], clamp);
  return (
    <FadeScene duration={120} glow={PINK}>
      <div style={{position: 'absolute', left: 0, right: 0, top: 112, textAlign: 'center', opacity: introOut}}>
        <Kicker color={PINK}>一个小互动</Kicker>
        <div style={{fontSize: 76, fontWeight: 1000, marginTop: 24, letterSpacing: -2}}>
          请在 <span style={{color: YELLOW}}>两秒后</span> 双击屏幕
        </div>
        <div style={{fontSize: 25, color: MUTED, marginTop: 16}}>看看你会不会真的点一下</div>
      </div>

      <div style={{position: 'absolute', left: 0, right: 0, top: 332, textAlign: 'center', opacity: interpolate(frame, [14, 30], [0, 1], clamp)}}>
        <div style={{fontSize: 44, color: CYAN, fontWeight: 1000}}>{frame < 44 ? '2' : frame < 61 ? '1' : ''}</div>
      </div>

      {[0,1].map((i) => {
        const start = i === 0 ? 50 : 66;
        return (
          <div
            key={i}
            style={{
              position: 'absolute',
              left: 960 - 95 - i * 10,
              top: 610 - 95 - i * 10,
              width: 190 + i * 20,
              height: 190 + i * 20,
              borderRadius: '50%',
              border: `4px solid ${i === 0 ? CYAN : PINK}`,
              opacity: interpolate(frame, [start, start + 4, start + 24], [0, .9, 0], clamp),
              scale: interpolate(frame, [start, start + 24], [.38, 1.8], clamp),
              boxShadow: `0 0 44px ${i === 0 ? CYAN : PINK}55`,
            }}
          />
        );
      })}

      <div
        style={{
          position: 'absolute',
          left: 820,
          top: 472,
          width: 280,
          height: 280,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 190,
          filter: 'drop-shadow(0 24px 28px rgba(0,0,0,.34))',
          opacity: interpolate(frame, [34, 48, 94, 112], [0, 1, 1, 0], clamp),
          scale: handScale,
          translate: `0px ${interpolate(frame, [34, 52], [90, 0], {...clamp, easing: ease})}px`,
        }}
      >☝️</div>

      <div style={{position: 'absolute', inset: 0, opacity: boom * 0.9, pointerEvents: 'none'}}>
        {[[-250,-85,52,PINK],[260,-105,38,CYAN],[-360,145,40,YELLOW],[330,180,48,PINK],[-110,250,30,CYAN],[130,255,34,PURPLE]].map((p, i) => (
          <div key={i} style={{position:'absolute', left:960+p[0] as number, top:560+p[1] as number, fontSize:p[2] as number, color:p[3] as string, opacity:boom, scale:.5+boom*.8, translate:`${(p[0] as number)*boom*.14}px ${(p[1] as number)*boom*.14}px`}}>♥</div>
        ))}
      </div>

      <div style={{position: 'absolute', left: 0, right: 0, top: 820, textAlign:'center', fontSize:28, fontWeight:800, color:'#DDE9FA', opacity:interpolate(frame,[78,92,106,118],[0,1,1,0],clamp)}}>
        真点了？那这个赞我先收下了。
      </div>
    </FadeScene>
  );
};

const Scene2Reveal: React.FC = () => {
  const frame = useCurrentFrame();
  return (
    <FadeScene duration={150} glow={CYAN}>
      <Img
        src={staticFile('elements-atlas.webp')}
        style={{
          position:'absolute',
          right:-90,
          top:120,
          width:850,
          opacity:.13,
          filter:'blur(.2px) saturate(1.2)',
          scale:interpolate(frame,[0,150],[1,1.06],clamp),
        }}
      />
      <div style={{position:'absolute', left:0, right:0, top:72, textAlign:'center'}}>
        <Kicker>OPEN SOURCE · QIANCHUAN · AI AGENT</Kicker>
      </div>
      <div style={{position:'absolute', left:155, right:155, top:215, textAlign:'center'}}>
        <div><BlockWord color={PANEL_2} delay={4} size={50}>我把我的</BlockWord></div>
        <div style={{marginTop:6}}>
          <BlockWord color={BLUE} delay={12} size={82}>抖音直播</BlockWord>
          <BlockWord color={PINK} delay={20} size={82}>千川 AI 投流系统</BlockWord>
        </div>
        <div style={{marginTop:10}}><BlockWord color={GREEN} delay={34} size={96}>开源了</BlockWord></div>
      </div>
      <div style={{position:'absolute', left:0, right:0, top:770, display:'flex', justifyContent:'center', gap:14, opacity:interpolate(frame,[52,76],[0,1],clamp)}}>
        <Chip color={BLUE}>本地运行</Chip><Chip color={GREEN}>MCP</Chip><Chip color={PURPLE}>Decision Memory</Chip><Chip color={YELLOW}>Open Source</Chip>
      </div>
      <div style={{position:'absolute', left:0, right:0, top:866, textAlign:'center', fontSize:24, color:MUTED, fontWeight:650, opacity:interpolate(frame,[78,102],[0,1],clamp)}}>
        它最开始不是产品，只是我给自己小团队做的一套工具。
      </div>
    </FadeScene>
  );
};

const Scene3Pain: React.FC = () => {
  const frame = useCurrentFrame();
  const tasks = [
    {t:'跟主播沟通',x:340,y:390,c:PINK},
    {t:'盯实时数据',x:1295,y:390,c:CYAN},
    {t:'看计划状态',x:245,y:615,c:BLUE},
    {t:'判断要不要调',x:1350,y:615,c:YELLOW},
    {t:'记下发生了什么',x:800,y:760,c:PURPLE},
  ];
  return (
    <FadeScene duration={210} glow={PURPLE}>
      <SectionTitle kicker="为什么做它" title={<>小团队，<span style={{color:PINK}}>没有专门的人盯投放</span></>} sub="直播现场只有一个中控，还得同时兼顾主播和数据" color={PINK}/>
      <GlassCard x={690} y={330} w={540} accent={PURPLE} delay={22} style={{textAlign:'center'}}>
        <div style={{fontSize:20,color:MUTED,fontWeight:800,letterSpacing:2}}>中控</div>
        <div style={{fontSize:52,fontWeight:1000,marginTop:10}}>一个人同时做很多事</div>
        <div style={{display:'flex',justifyContent:'center',gap:10,marginTop:18,flexWrap:'wrap'}}>
          <Chip color={PINK}>控场</Chip><Chip color={BLUE}>看数据</Chip><Chip color={YELLOW}>盯投放</Chip>
        </div>
      </GlassCard>
      {tasks.map((item,i)=><GlassCard key={item.t} x={item.x} y={item.y} w={310} pad={20} accent={item.c} delay={48+i*10} style={{textAlign:'center'}}><div style={{fontSize:27,fontWeight:950,color:'#F6FAFF'}}>{item.t}</div></GlassCard>)}
      <div style={{position:'absolute',left:0,right:0,top:885,textAlign:'center',fontSize:42,fontWeight:1000,opacity:interpolate(frame,[115,145],[0,1],clamp)}}>
        人的精力有限，<span style={{color:RED}}>会看数据 ≠ 会调投放</span>
      </div>
      <div style={{position:'absolute',left:0,right:0,top:952,textAlign:'center',fontSize:26,color:MUTED,fontWeight:700,opacity:interpolate(frame,[150,178],[0,1],clamp)}}>
        所以我想，把“盯盘和判断”交给 Agent。
      </div>
    </FadeScene>
  );
};

const NodeBox: React.FC<{x:number;y:number;w:number;title:string;sub:string;color:string;delay:number;big?:boolean}> = ({x,y,w,title,sub,color,delay,big}) => (
  <GlassCard x={x} y={y} w={w} accent={color} delay={delay} style={{textAlign:'center'}}>
    <div style={{fontSize:big?42:28,fontWeight:1000,color}}>{title}</div>
    <div style={{fontSize:18,lineHeight:1.45,color:MUTED,marginTop:8}}>{sub}</div>
  </GlassCard>
);

const Scene4Core: React.FC = () => {
  const frame=useCurrentFrame();
  const dash = interpolate(frame,[70,118],[1,0],clamp);
  return (
    <FadeScene duration={210} glow={CYAN}>
      <SectionTitle kicker="系统真正的核心" title={frame<84 ? <>不是这个网页</> : <>而是给 Agent 用的 <span style={{color:CYAN}}>MCP 工具层</span></>} sub="前端给人看，MCP 给智能体用" />
      <NodeBox x={760} y={275} w={400} title="AI Agent" sub="观察 · 判断 · 复盘" color={BLUE} delay={22} big/>
      <NodeBox x={800} y={505} w={320} title="MCP" sub="统一工具入口 · next_step" color={CYAN} delay={50} big/>
      <NodeBox x={250} y={755} w={280} title="千川" sub="计划 / 消耗 / ROI" color={BLUE} delay={88}/>
      <NodeBox x={580} y={755} w={280} title="罗盘" sub="直播 / 商品 / 订单" color={GREEN} delay={98}/>
      <NodeBox x={910} y={755} w={320} title="本地数据库" sub="历史 / 素材 / 复盘" color={YELLOW} delay={108}/>
      <NodeBox x={1280} y={755} w={320} title="决策记忆" sub="判断 / 结果 / 回评" color={PINK} delay={118}/>
      <svg width="1920" height="1080" style={{position:'absolute',inset:0,pointerEvents:'none'}}>
        <path d="M960 445 L960 505" stroke={CYAN} strokeWidth="4" pathLength="1" strokeDasharray="1" strokeDashoffset={dash} />
        <path d="M885 690 C760 710 560 730 390 755" stroke={BLUE} strokeWidth="3.5" fill="none" pathLength="1" strokeDasharray="1" strokeDashoffset={dash} />
        <path d="M930 690 C820 720 780 728 720 755" stroke={GREEN} strokeWidth="3.5" fill="none" pathLength="1" strokeDasharray="1" strokeDashoffset={dash} />
        <path d="M990 690 C1050 720 1070 730 1070 755" stroke={YELLOW} strokeWidth="3.5" fill="none" pathLength="1" strokeDasharray="1" strokeDashoffset={dash} />
        <path d="M1040 690 C1170 710 1300 730 1440 755" stroke={PINK} strokeWidth="3.5" fill="none" pathLength="1" strokeDasharray="1" strokeDashoffset={dash} />
      </svg>
    </FadeScene>
  );
};

const ToolRow: React.FC<{label:string; sub:string; color:string; active:boolean; done:boolean; delay:number}> = ({label,sub,color,active,done,delay}) => (
  <GlassCard w="100%" pad={15} accent={active?color:'#4B688F'} delay={delay} style={{marginBottom:12,boxShadow:active?`0 0 28px ${color}28`:'none'}}>
    <div style={{display:'flex',alignItems:'center',gap:12}}>
      <div style={{width:16,height:16,borderRadius:'50%',background:done?GREEN:active?color:'#39516F',boxShadow:active?`0 0 18px ${color}`:'none'}} />
      <div style={{flex:1}}><div style={{fontSize:22,fontWeight:950}}>{label}</div><div style={{fontSize:15,color:MUTED,marginTop:4}}>{sub}</div></div>
      <div style={{fontSize:18,color:done?GREEN:active?color:MUTED,fontWeight:900}}>{done?'✓':active?'读取中':'等待'}</div>
    </div>
  </GlassCard>
);

const Bullet: React.FC<{text:string;color:string;delay:number}> = ({text,color,delay}) => {
  const frame=useCurrentFrame();
  return <div style={{display:'flex',alignItems:'center',gap:13,fontSize:22,fontWeight:820,margin:'14px 0',opacity:interpolate(frame,[delay,delay+16],[0,1],clamp),translate:`${interpolate(frame,[delay,delay+16],[24,0],clamp)}px 0px`}}><span style={{width:11,height:11,borderRadius:3,background:color,boxShadow:`0 0 15px ${color}`}}/>{text}</div>;
};

const Scene5Agent: React.FC = () => {
  const frame=useCurrentFrame();
  const qIndex = Math.min(3, Math.max(0, Math.floor((frame-55)/28)));
  const analysis = frame >= 175 && frame < 315;
  const decision = frame >= 315;
  return (
    <FadeScene duration={510} glow={GREEN}>
      <SectionTitle kicker="模拟一轮真实 Agent 工作" title={<>Agent A：<span style={{color:GREEN}}>先问、再查、再判断</span></>} sub="不是“凭感觉回答”，而是先通过 MCP 拿证据" color={GREEN}/>

      <GlassCard x={255} y={230} w={1410} accent={CYAN} delay={12} style={{textAlign:'center'}}>
        <div style={{fontSize:17,color:CYAN,fontWeight:950,letterSpacing:2}}>用户问题</div>
        <div style={{fontSize:31,lineHeight:1.38,fontWeight:950,marginTop:8}}>
          当前直播在线上升，但成交没有同步起量，这一波要不要继续放量？
        </div>
      </GlassCard>

      <GlassCard x={150} y={425} w={340} accent={BLUE} delay={28} style={{textAlign:'center'}}>
        <div style={{width:86,height:86,borderRadius:24,margin:'0 auto',display:'flex',alignItems:'center',justifyContent:'center',fontSize:44,fontWeight:1000,background:'linear-gradient(180deg,#ECF6FF,#A7D6FF)',color:'#0C315B',boxShadow:'0 12px 38px rgba(88,168,255,.28)'}}>A</div>
        <div style={{fontSize:34,fontWeight:1000,marginTop:14}}>Agent A</div>
        <div style={{fontSize:18,color:MUTED,marginTop:8}}>正在处理投放判断</div>
        <div style={{marginTop:18}}><Chip color={frame>60?GREEN:BLUE}>{frame>60?'已连接 MCP':'等待任务'}</Chip></div>
      </GlassCard>

      <GlassCard x={560} y={425} w={500} accent={CYAN} delay={42}>
        <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:16}}><div style={{fontSize:25,fontWeight:1000}}>MCP 工具调用</div><Chip color={CYAN}>Evidence First</Chip></div>
        <ToolRow label="读取直播实时数据" sub="live_view / freshness" color={CYAN} active={qIndex===0 && frame<175} done={qIndex>0 || frame>=175} delay={52}/>
        <ToolRow label="读取计划消耗 / ROI" sub="delivery / current state" color={BLUE} active={qIndex===1 && frame<175} done={qIndex>1 || frame>=175} delay={62}/>
        <ToolRow label="读取历史决策记录" sub="decision_ledger" color={PINK} active={qIndex===2 && frame<175} done={qIndex>2 || frame>=175} delay={72}/>
        <ToolRow label="查询本地历史数据" sub="local history / DB" color={YELLOW} active={qIndex===3 && frame<175} done={frame>=175} delay={82}/>
      </GlassCard>

      <GlassCard x={1130} y={425} w={640} accent={analysis?PURPLE:GREEN} delay={88}>
        {!analysis && !decision ? <>
          <div style={{fontSize:26,fontWeight:1000,color:CYAN}}>正在拼证据链</div>
          <div style={{marginTop:28,fontSize:21,lineHeight:1.7,color:MUTED}}>实时状态、计划表现、历史判断和本地历史数据会一起进入这一轮分析。</div>
          <div style={{marginTop:28,display:'flex',gap:10,flexWrap:'wrap'}}><Chip color={CYAN}>实时</Chip><Chip color={PINK}>历史决策</Chip><Chip color={YELLOW}>本地历史</Chip></div>
        </> : null}
        {analysis ? <>
          <div style={{fontSize:27,fontWeight:1000,color:PURPLE}}>分析结果</div>
          <Bullet text="当前在线人数上升" color={GREEN} delay={182}/>
          <Bullet text="成交转化未同步改善" color={RED} delay={200}/>
          <Bullet text="当前 ROI 低于目标线" color={YELLOW} delay={218}/>
          <Bullet text="历史类似时段，盲目加量更容易放大低效消耗" color={PINK} delay={236}/>
        </> : null}
        {decision ? <>
          <div style={{fontSize:27,fontWeight:1000,color:GREEN}}>决策建议</div>
          <Bullet text="暂不追加预算" color={RED} delay={322}/>
          <Bullet text="保持当前投放节奏" color={GREEN} delay={340}/>
          <Bullet text="10 分钟后复查" color={BLUE} delay={358}/>
          <Bullet text="重点看转化率 / 停留 / 素材承接" color={YELLOW} delay={376}/>
          <div style={{marginTop:28,padding:'15px 18px',borderRadius:15,background:'rgba(69,224,168,.10)',border:'1px solid rgba(69,224,168,.35)',fontSize:19,fontWeight:900,color:'#B9FFE6',opacity:interpolate(frame,[420,442],[0,1],clamp)}}>✓ 已写入 Decision Ledger，等待下一次复查</div>
        </> : null}
      </GlassCard>

      <div style={{position:'absolute',left:0,right:0,top:950,textAlign:'center',fontSize:25,color:MUTED,fontWeight:700,opacity:interpolate(frame,[430,455],[0,1],clamp)}}>
        Agent 的价值不是“说得像”，而是每个判断都能追到数据和历史上下文。
      </div>
    </FadeScene>
  );
};

const Packet: React.FC<{fromX:number;toX:number;y:number;start:number;color:string}> = ({fromX,toX,y,start,color}) => {
  const frame=useCurrentFrame();
  return <div style={{position:'absolute',left:interpolate(frame,[start,start+42],[fromX,toX],clamp),top:y,width:16,height:16,borderRadius:5,background:color,boxShadow:`0 0 20px ${color}`,opacity:interpolate(frame,[start,start+5,start+37,start+42],[0,1,1,0],clamp)}}/>;
};

const Scene6Memory: React.FC = () => {
  const frame=useCurrentFrame();
  return (
    <FadeScene duration={270} glow={PINK}>
      <SectionTitle kicker="为什么要有历史记忆" title={<>AI 可以换，<span style={{color:PINK}}>历史决策不能丢</span></>} sub="Agent 不是记忆本体，记忆应该留在本地系统里" color={PINK}/>
      <NodeBox x={185} y={430} w={330} title="Agent A" sub="今天做判断" color={BLUE} delay={26} big/>
      <GlassCard x={690} y={360} w={540} accent={YELLOW} delay={52} style={{textAlign:'center'}}>
        <div style={{fontSize:19,color:YELLOW,fontWeight:950,letterSpacing:2}}>LOCAL MEMORY</div>
        <div style={{fontSize:48,fontWeight:1000,marginTop:10}}>Decision Ledger + 本地数据库</div>
        <div style={{display:'flex',justifyContent:'center',gap:10,marginTop:20,flexWrap:'wrap'}}>
          <Chip color={PINK}>历史决策</Chip><Chip color={BLUE}>历史直播</Chip><Chip color={GREEN}>素材详情</Chip><Chip color={PURPLE}>脚本信息</Chip><Chip color={YELLOW}>创意数据</Chip>
        </div>
      </GlassCard>
      <NodeBox x={1405} y={430} w={330} title="Agent B" sub="以后继续接手" color={PINK} delay={94} big/>
      {[0,1,2,3].map((i)=><Packet key={`a${i}`} fromX={515} toX={690} y={505+i*35} start={78+i*14} color={[BLUE,CYAN,PINK,YELLOW][i]}/>)}
      {[0,1,2,3].map((i)=><Packet key={`b${i}`} fromX={1230} toX={1405} y={505+i*35} start={142+i*14} color={[GREEN,PURPLE,CYAN,PINK][i]}/>)}
      <div style={{position:'absolute',left:0,right:0,top:805,textAlign:'center',fontSize:46,fontWeight:1000,opacity:interpolate(frame,[150,180],[0,1],clamp)}}>换 Agent，<span style={{color:YELLOW}}>不换上下文</span></div>
      <div style={{position:'absolute',left:0,right:0,top:878,textAlign:'center',fontSize:25,color:MUTED,fontWeight:700,opacity:interpolate(frame,[172,198],[0,1],clamp)}}>历史直播、素材、脚本和每一轮判断，都可以在本地继续查。</div>
    </FadeScene>
  );
};

const Callout: React.FC<{x:number;y:number;title:string;sub:string;color:string;delay:number}> = ({x,y,title,sub,color,delay}) => (
  <GlassCard x={x} y={y} w={285} pad={18} accent={color} delay={delay}>
    <div style={{fontSize:24,fontWeight:1000,color}}>{title}</div>
    <div style={{fontSize:16,color:MUTED,marginTop:6,lineHeight:1.4}}>{sub}</div>
  </GlassCard>
);

const Scene7Frontend: React.FC = () => {
  const frame=useCurrentFrame();
  const zoom=interpolate(frame,[0,240],[1,1.035],clamp);
  return (
    <FadeScene duration={240} glow={BLUE}>
      <SectionTitle kicker="那为什么还要做前端？" title={frame<90 ? <>第一，自己天天看，当然想让它<span style={{color:CYAN}}>舒服一点</span></> : <>第二，它其实是我的<span style={{color:CYAN}}>验数工具</span></>} sub={frame<90 ? '漂亮不是核心，但长期使用时它真的会影响心情。' : '我需要确认：Agent 拿到的，到底是不是对的。'} />
      <div style={{position:'absolute',left:360,top:300,width:1200,height:680,borderRadius:30,overflow:'hidden',border:'1px solid rgba(255,255,255,.18)',boxShadow:'0 34px 90px rgba(0,0,0,.34)',background:'#EEF5FF',scale:zoom,opacity:interpolate(frame,[15,35],[0,1],clamp)}}>
        <Img src={staticFile('workbench-day.webp')} style={{width:'100%',height:'100%',objectFit:'cover',objectPosition:'center top'}} />
        <div style={{position:'absolute',inset:0,boxShadow:'inset 0 0 0 1px rgba(255,255,255,.55)',pointerEvents:'none'}}/>
      </div>
      <div style={{position:'absolute',left:0,right:0,top:245,display:'flex',justifyContent:'center',gap:12,opacity:interpolate(frame,[74,100],[0,1],clamp)}}>
        <Chip color={BLUE}>千川</Chip><Chip color={GREEN}>罗盘</Chip><Chip color={YELLOW}>本地历史库</Chip><Chip color={PINK}>决策记录</Chip>
      </div>
      <Callout x={70} y={385} title="数据真实吗？" sub="和平台后台能不能对上" color={BLUE} delay={102}/>
      <Callout x={85} y={650} title="是实时的吗？" sub="有没有延迟、陈旧缓存" color={CYAN} delay={114}/>
      <Callout x={1570} y={385} title="口径对吗？" sub="字段和指标有没有错位" color={PINK} delay={126}/>
      <Callout x={1555} y={650} title="历史好查吗？" sub="复盘时能不能快速筛选" color={YELLOW} delay={138}/>
    </FadeScene>
  );
};

const Scene8Close: React.FC = () => {
  const frame=useCurrentFrame();
  return (
    <FadeScene duration={90} glow={GREEN}>
      <div style={{position:'absolute',left:0,right:0,top:165,textAlign:'center'}}><Kicker color={GREEN}>FREE & OPEN SOURCE</Kicker></div>
      <div style={{position:'absolute',left:170,right:170,top:285,textAlign:'center'}}>
        <div style={{fontSize:72,fontWeight:1000,letterSpacing:-2}}>给自己做，<span style={{color:GREEN}}>后来决定开源</span></div>
        <div style={{fontSize:34,color:MUTED,fontWeight:800,marginTop:24}}>抖音直播千川 AI 投流系统</div>
      </div>
      <GlassCard x={430} y={565} w={1060} accent={GREEN} delay={18} style={{textAlign:'center'}}>
        <div style={{fontSize:18,color:MUTED,fontWeight:900,letterSpacing:2}}>GITHUB SEARCH</div>
        <div style={{fontSize:48,fontWeight:1000,marginTop:10,color:'#EFFFF8'}}>qianchuan-workbench</div>
      </GlassCard>
      <div style={{position:'absolute',left:0,right:0,top:785,display:'flex',justifyContent:'center',gap:12,opacity:interpolate(frame,[28,52],[0,1],clamp)}}>
        <Chip color={BLUE}>Agent</Chip><Chip color={CYAN}>MCP</Chip><Chip color={YELLOW}>Local Data</Chip><Chip color={PINK}>Decision Memory</Chip>
      </div>
      <div style={{position:'absolute',left:0,right:0,top:910,textAlign:'center',fontSize:24,color:MUTED,fontWeight:700,opacity:interpolate(frame,[42,62],[0,1],clamp)}}>
        如果你也在折腾 Agent、MCP 或千川自动化，希望它能给你一点参考。
      </div>
    </FadeScene>
  );
};

export const QianchuanOpenSource: React.FC = () => {
  const {fps} = useVideoConfig();
  return (
    <AbsoluteFill style={{backgroundColor:BG}}>
      <Sequence from={0} durationInFrames={4*fps}><Scene1Hook/></Sequence>
      <Sequence from={4*fps} durationInFrames={5*fps}><Scene2Reveal/></Sequence>
      <Sequence from={9*fps} durationInFrames={7*fps}><Scene3Pain/></Sequence>
      <Sequence from={16*fps} durationInFrames={7*fps}><Scene4Core/></Sequence>
      <Sequence from={23*fps} durationInFrames={17*fps}><Scene5Agent/></Sequence>
      <Sequence from={40*fps} durationInFrames={9*fps}><Scene6Memory/></Sequence>
      <Sequence from={49*fps} durationInFrames={8*fps}><Scene7Frontend/></Sequence>
      <Sequence from={57*fps} durationInFrames={3*fps}><Scene8Close/></Sequence>
    </AbsoluteFill>
  );
};
