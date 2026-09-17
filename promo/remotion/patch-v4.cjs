const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, 'src', 'Video.tsx');
let src = fs.readFileSync(file, 'utf8');

const scene1 = String.raw`const Scene1Hook: React.FC = () => {
  const frame = useCurrentFrame();
  const tap1 = interpolate(frame, [75, 82, 87], [1, 0.82, 1], {...clamp, easing: ease});
  const tap2 = interpolate(frame, [91, 98, 103], [1, 0.82, 1], {...clamp, easing: ease});
  const handScale = frame < 90 ? tap1 : tap2;
  const boom = interpolate(frame, [92, 118], [0, 1], {...clamp, easing: ease});
  return (
    <FadeScene duration={120} glow={PINK}>
      <div style={{position:'absolute',left:0,right:0,top:66,textAlign:'center'}}>
        <Kicker color={PINK}>OPEN SOURCE · QIANCHUAN · AI AGENT</Kicker>
      </div>

      <div style={{position:'absolute',left:120,right:120,top:170,textAlign:'center'}}>
        <div><BlockWord color={PANEL_2} delay={0} size={46}>我把我的</BlockWord></div>
        <div style={{marginTop:5}}>
          <BlockWord color={BLUE} delay={5} size={74}>抖音直播</BlockWord>
          <BlockWord color={PINK} delay={10} size={74}>千川 AI 投流系统</BlockWord>
        </div>
        <div style={{marginTop:8}}><BlockWord color={GREEN} delay={17} size={90}>开源了</BlockWord></div>
      </div>

      <div style={{position:'absolute',left:0,right:0,top:690,textAlign:'center',fontSize:27,fontWeight:850,color:'#DDE9FA',opacity:interpolate(frame,[48,65,110,119],[0,1,1,0],clamp)}}>
        双击一下屏幕，看看它是怎么工作的
      </div>

      {[0,1].map((i) => {
        const start = i === 0 ? 78 : 94;
        return <div key={i} style={{position:'absolute',left:960-72-i*8,top:850-72-i*8,width:144+i*16,height:144+i*16,borderRadius:'50%',border:'4px solid '+(i===0?CYAN:PINK),opacity:interpolate(frame,[start,start+4,start+21],[0,.92,0],clamp),scale:interpolate(frame,[start,start+21],[.34,1.7],clamp),boxShadow:'0 0 44px '+(i===0?CYAN:PINK)+'55'}}/>;
      })}

      <div style={{position:'absolute',left:850,top:750,width:220,height:220,display:'flex',alignItems:'center',justifyContent:'center',fontSize:150,filter:'drop-shadow(0 20px 26px rgba(0,0,0,.34))',opacity:interpolate(frame,[60,74,108,120],[0,1,1,0],clamp),scale:handScale,translate:'0px '+interpolate(frame,[60,78],[70,0],{...clamp,easing:ease})+'px'}}>☝️</div>

      <div style={{position:'absolute',inset:0,opacity:boom*.9,pointerEvents:'none'}}>
        {[[-250,-85,46,PINK],[260,-105,36,CYAN],[-360,145,38,YELLOW],[330,180,44,PINK],[-110,250,28,CYAN],[130,255,32,PURPLE]].map((p,i)=><div key={i} style={{position:'absolute',left:960+(p[0] as number),top:820+(p[1] as number),fontSize:p[2] as number,color:p[3] as string,opacity:boom,scale:.5+boom*.8,translate:(p[0] as number)*boom*.14+'px '+(p[1] as number)*boom*.14+'px'}}>♥</div>)}
      </div>
    </FadeScene>
  );
};

const Scene2Reveal`;

const scene2 = String.raw`const Scene2Reveal: React.FC = () => {
  const frame = useCurrentFrame();
  return (
    <FadeScene duration={150} glow={CYAN}>
      <Img src={staticFile('elements-atlas.webp')} style={{position:'absolute',right:-80,top:90,width:830,opacity:.12,filter:'saturate(1.15)',scale:interpolate(frame,[0,150],[1,1.05],clamp)}} />
      <SectionTitle kicker="它为什么会存在" title={<>最开始不是为了做产品，<span style={{color:CYAN}}>是我自己真的需要</span></>} sub="小团队没有专职投手，现场的人已经够忙了。" />
      <div style={{position:'absolute',left:260,right:260,top:395,display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:18}}>
        <GlassCard accent={BLUE} delay={22} style={{textAlign:'center'}}><div style={{fontSize:34,fontWeight:1000}}>小团队</div><div style={{fontSize:18,color:MUTED,marginTop:9}}>人手紧张</div></GlassCard>
        <GlassCard accent={PINK} delay={34} style={{textAlign:'center'}}><div style={{fontSize:34,fontWeight:1000}}>中控很忙</div><div style={{fontSize:18,color:MUTED,marginTop:9}}>还要配合主播</div></GlassCard>
        <GlassCard accent={GREEN} delay={46} style={{textAlign:'center'}}><div style={{fontSize:34,fontWeight:1000}}>Agent</div><div style={{fontSize:18,color:MUTED,marginTop:9}}>辅助盯盘与判断</div></GlassCard>
        <GlassCard accent={YELLOW} delay={58} style={{textAlign:'center'}}><div style={{fontSize:34,fontWeight:1000}}>本地记忆</div><div style={{fontSize:18,color:MUTED,marginTop:9}}>历史不会丢</div></GlassCard>
      </div>
      <div style={{position:'absolute',left:0,right:0,top:740,textAlign:'center',fontSize:40,fontWeight:1000,opacity:interpolate(frame,[72,96],[0,1],clamp)}}>
        <span style={{color:GREEN}}>先确认目标和边界</span> → 再读取证据 → 再给判断
      </div>
      <div style={{position:'absolute',left:0,right:0,top:818,display:'flex',justifyContent:'center',gap:14,opacity:interpolate(frame,[88,108],[0,1],clamp)}}>
        <Chip color={BLUE}>本地运行</Chip><Chip color={GREEN}>MCP</Chip><Chip color={PURPLE}>Decision Memory</Chip><Chip color={YELLOW}>Open Source</Chip>
      </div>
    </FadeScene>
  );
};

const Scene3Pain`;

const scene5 = String.raw`const Scene5Agent: React.FC = () => {
  const frame = useCurrentFrame();
  const askPhase = frame < 145;
  const queryPhase = frame >= 145 && frame < 255;
  const analysis = frame >= 255 && frame < 365;
  const decision = frame >= 365;
  const qIndex = Math.min(3, Math.max(0, Math.floor((frame - 160) / 23)));
  const agentStatus = frame < 70 ? '识别问题' : frame < 145 ? '等待用户确认' : '只读分析 · MCP 已连接';
  return (
    <FadeScene duration={510} glow={GREEN}>
      <SectionTitle kicker="模拟一轮真实 Agent 工作" title={<>Agent A：<span style={{color:GREEN}}>先问清楚，再去跑</span></>} sub="Skill 会先补关键缺口和授权边界，再通过 MCP 读取证据" color={GREEN}/>

      <GlassCard x={245} y={225} w={1430} accent={CYAN} delay={10} style={{textAlign:'center'}}>
        <div style={{fontSize:17,color:CYAN,fontWeight:950,letterSpacing:2}}>用户提出任务</div>
        <div style={{fontSize:31,lineHeight:1.38,fontWeight:950,marginTop:8}}>帮我看看这场直播，今天要不要继续放量？</div>
      </GlassCard>

      <GlassCard x={145} y={420} w={345} accent={frame<145?YELLOW:BLUE} delay={24} style={{textAlign:'center'}}>
        <div style={{width:86,height:86,borderRadius:24,margin:'0 auto',display:'flex',alignItems:'center',justifyContent:'center',fontSize:44,fontWeight:1000,background:'linear-gradient(180deg,#ECF6FF,#A7D6FF)',color:'#0C315B',boxShadow:'0 12px 38px rgba(88,168,255,.28)'}}>A</div>
        <div style={{fontSize:34,fontWeight:1000,marginTop:14}}>Agent A</div>
        <div style={{fontSize:18,color:MUTED,marginTop:8}}>按 qianchuan-ops Skill 工作</div>
        <div style={{marginTop:18}}><Chip color={frame<145?YELLOW:GREEN}>{agentStatus}</Chip></div>
        {frame>=145 ? <div style={{marginTop:12}}><Chip color={PURPLE}>analysis_only</Chip></div> : null}
      </GlassCard>

      {askPhase ? <GlassCard x={555} y={420} w={1215} accent={YELLOW} delay={38}>
        <div style={{fontSize:25,fontWeight:1000,color:YELLOW}}>Agent A 先确认两个关键条件</div>
        <div style={{marginTop:20,fontSize:24,lineHeight:1.62,fontWeight:800}}>① 你今天采用的目标 ROI / CPA 和停止线是什么？</div>
        <div style={{marginTop:8,fontSize:24,lineHeight:1.62,fontWeight:800}}>② 这次只要分析建议，还是允许我执行调整？</div>
        <div style={{marginTop:26,padding:'19px 22px',borderRadius:18,background:'rgba(88,168,255,.09)',border:'1px solid rgba(88,168,255,.30)',opacity:interpolate(frame,[78,98],[0,1],clamp)}}>
          <div style={{fontSize:16,color:BLUE,fontWeight:950,letterSpacing:2}}>用户确认 · 示例条件</div>
          <div style={{fontSize:25,lineHeight:1.55,fontWeight:900,marginTop:7}}>ROI ≥ 3.5；跌破 3 连续 10 分钟停。<span style={{color:GREEN}}>这次先只给建议。</span></div>
        </div>
        <div style={{marginTop:20,fontSize:18,color:MUTED,fontWeight:700}}>已确认：目标线、停止条件、动作边界。现在才进入数据读取。</div>
      </GlassCard> : null}

      {queryPhase ? <>
        <GlassCard x={555} y={420} w={510} accent={CYAN} delay={0}>
          <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:16}}><div style={{fontSize:25,fontWeight:1000}}>MCP 工具调用</div><Chip color={CYAN}>Evidence First</Chip></div>
          <ToolRow label="读取直播实时数据" sub="live_view / freshness" color={CYAN} active={qIndex===0} done={qIndex>0} delay={0}/>
          <ToolRow label="读取计划消耗 / ROI" sub="delivery / current state" color={BLUE} active={qIndex===1} done={qIndex>1} delay={8}/>
          <ToolRow label="读取历史决策记录" sub="decision_ledger" color={PINK} active={qIndex===2} done={qIndex>2} delay={16}/>
          <ToolRow label="查询本地历史数据" sub="local history / DB" color={YELLOW} active={qIndex===3} done={qIndex>3 || frame>=248} delay={24}/>
        </GlassCard>
        <GlassCard x={1135} y={420} w={635} accent={GREEN} delay={10}>
          <div style={{fontSize:26,fontWeight:1000,color:GREEN}}>只读分析已开始</div>
          <div style={{marginTop:22,fontSize:21,lineHeight:1.7,color:MUTED}}>Agent 已拿到本轮用户确认的目标和边界，再把实时状态、计划表现、历史决策、本地历史拼成证据链。</div>
          <div style={{marginTop:26,display:'flex',gap:10,flexWrap:'wrap'}}><Chip color={GREEN}>目标已确认</Chip><Chip color={PURPLE}>不自动改投放</Chip><Chip color={CYAN}>实时证据</Chip><Chip color={PINK}>历史上下文</Chip></div>
        </GlassCard>
      </> : null}

      {analysis ? <GlassCard x={555} y={420} w={1215} accent={PURPLE} delay={0}>
        <div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}><div style={{fontSize:28,fontWeight:1000,color:PURPLE}}>分析结果</div><Chip color={PURPLE}>基于已确认目标</Chip></div>
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:'0 34px',marginTop:15}}>
          <Bullet text="当前在线人数上升" color={GREEN} delay={260}/>
          <Bullet text="成交转化未同步改善" color={RED} delay={275}/>
          <Bullet text="当前 ROI 低于用户给定目标线" color={YELLOW} delay={290}/>
          <Bullet text="历史类似时段，盲目加量容易放大低效消耗" color={PINK} delay={305}/>
        </div>
        <div style={{marginTop:25,padding:'18px 20px',borderRadius:16,background:'rgba(155,123,255,.09)',border:'1px solid rgba(155,123,255,.28)',fontSize:20,color:'#D9CFFF',fontWeight:800}}>观察、推断和建议分开；用户没授权的动作，不执行。</div>
      </GlassCard> : null}

      {decision ? <GlassCard x={555} y={420} w={1215} accent={GREEN} delay={0}>
        <div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}><div style={{fontSize:28,fontWeight:1000,color:GREEN}}>本轮建议</div><Chip color={GREEN}>recommendation only</Chip></div>
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:'0 34px',marginTop:15}}>
          <Bullet text="暂不追加预算" color={RED} delay={372}/>
          <Bullet text="保持当前投放节奏" color={GREEN} delay={387}/>
          <Bullet text="10 分钟后复查" color={BLUE} delay={402}/>
          <Bullet text="重点看转化率 / 停留 / 素材承接" color={YELLOW} delay={417}/>
        </div>
        <div style={{marginTop:26,padding:'16px 18px',borderRadius:15,background:'rgba(69,224,168,.10)',border:'1px solid rgba(69,224,168,.35)',fontSize:19,fontWeight:900,color:'#B9FFE6',opacity:interpolate(frame,[438,458],[0,1],clamp)}}>✓ 已记录到 Decision Ledger：用户条件、证据、判断与建议</div>
      </GlassCard> : null}

      <div style={{position:'absolute',left:0,right:0,top:945,textAlign:'center',fontSize:25,color:MUTED,fontWeight:700,opacity:interpolate(frame,[455,478],[0,1],clamp)}}>先确认目标 / 停止线 / 授权边界 → 再读数据 → 再给判断。</div>
    </FadeScene>
  );
};

const Packet`;

const replaceExact = (pattern, replacement, label) => {
  if (!pattern.test(src)) throw new Error('patch target not found: ' + label);
  src = src.replace(pattern, replacement);
};

replaceExact(/const Scene1Hook:[\s\S]*?\nconst Scene2Reveal/, scene1, 'Scene1Hook');
replaceExact(/const Scene2Reveal:[\s\S]*?\nconst Scene3Pain/, scene2, 'Scene2Reveal');
replaceExact(/const Scene5Agent:[\s\S]*?\nconst Packet/, scene5, 'Scene5Agent');

fs.writeFileSync(file, src, 'utf8');
console.log('Applied V4 video patch: direct open-source hook, no countdown, Agent asks before MCP/tool calls.');
