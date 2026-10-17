'use strict';
// Timing and interaction behavior adapted from rice-loving-whale/renderer.js (MIT).
// 单位为毫秒；吃饭展示约 9.8 秒（允许素材循环），不是单个 GIF 的原始时长。
const SPECIAL_ACTIONS = require('../shared/special-actions.js');
const isProgram = state => Object.hasOwn(SPECIAL_ACTIONS, state);
const isFullLength = state => state === 'feed' || isProgram(state);
const HOLD = { feed:9800, completed:9800, pat:4200, happy:4200, angry:4200, error:4200, approval:4200, question:4200,
  ...Object.fromEntries(Object.entries(SPECIAL_ACTIONS).map(([id, clip]) => [id, clip.duration])) };
const DEMO_STATES = ['idle','thinking','working','completed','error','pat','happy','angry','approval','question','sleep'];
class Behavior {
  constructor(clock = Date.now, random = Math.random) {
    // base 保存任务状态，overlay 保存短暂互动，demo 保存手动预览；
    // 分开记录才能在摸头、喂饭结束后恢复任务状态。注入时钟和随机数便于验证。
    this.clock=clock; this.random=random; this.base='idle'; this.idleSince=clock();
    this.overlay=null; this.demo=null; this.cycle=false; this.cycleIndex=0;
    this.nextAmbient=clock()+12000; this.lastTouch=-Infinity; this.touchCount=0;
    this.lastExpression=null; this.revision=0;
  }
  wake() { this.idleSince=this.clock(); this.nextAmbient=this.clock()+12000+this.random()*6000; }
  task(tasks) {
    const next=tasks.state;
    // 真实事件结束演示；批准请求可打断吃饭和小节目，其他任务允许它们播完。
    this.demo=null; this.cycle=false;
    if (next==='approval') this.overlay=null;
    else if (!isFullLength(this.overlay?.state)) this.overlay=null;
    if (next!==this.base) {
      this.base=next; this.baseSince=this.clock(); this.revision++; this.wake();
    } else if (next==='completed') { this.baseSince=this.clock(); this.revision++; }
  }
  interact(action) {
    const now=this.clock();
    if (this.base==='approval' || (isFullLength(this.overlay?.state) && this.overlay.until>now)) return false;
    let state=action;
    if (action==='touch') {
      // 1.5 秒内连续戳四次会生气；普通点击避开上一次表情，减少机械重复。
      this.touchCount=now-this.lastTouch<1500 ? this.touchCount+1 : 1;
      this.lastTouch=now;
      const pool=['pat','happy','angry'].filter(s=>s!==this.lastExpression);
      state=this.touchCount>=4 ? 'angry' : pool[Math.floor(this.random()*pool.length)];
      this.lastExpression=state;
    }
    if (!['feed','pat','happy','angry'].includes(state) && !isProgram(state)) return false;
    this.demo=null; this.cycle=false; this.wake();
    this.overlay={state,until:now+HOLD[state]}; this.revision++;
    return true;
  }
  showDemo(state) {
    if (!DEMO_STATES.includes(state)) return false;
    this.overlay=null; this.demo={state,until:this.clock()+(HOLD[state] || 5000)};
    this.revision++; this.wake(); return true;
  }
  setCycle(enabled) {
    this.cycle=enabled; this.cycleIndex=0;
    if (enabled) this.showDemo(DEMO_STATES[0]); else { this.demo=null; this.wake(); }
  }
  snapshot() {
    const now=this.clock();
    if (this.demo && now>=this.demo.until) {
      if (this.cycle) { this.cycleIndex=(this.cycleIndex+1)%DEMO_STATES.length; this.showDemo(DEMO_STATES[this.cycleIndex]); }
      else { this.demo=null; this.wake(); }
    }
    if (this.overlay && now>=this.overlay.until) {
      const ambient=this.overlay.ambient; this.overlay=null;
      if (!ambient) this.wake();
    }
    if (this.base==='completed' && now-this.baseSince>=HOLD.completed) { this.base='idle'; this.wake(); }
    let state=this.overlay?.state || this.base;
    if (!this.overlay && this.base==='idle' && !this.demo) {
      const idleMs=now-this.idleSince;
      if (idleMs>=45000) state='sleep';
      else if (idleMs>=30000) state='drowsy';
      else if (now>=this.nextAmbient) {
        // 自发小表情只表示陪伴，不冒充任务工作，也不重置入睡计时。
        this.overlay={state:'happy',until:now+HOLD.happy,ambient:true};
        this.nextAmbient=Infinity; this.revision++; state='happy';
      }
    }
    // revision 让相同动作再次触发时也能从头播放；定时广播本身不会递增它。
    return { state:this.demo?.state || state, demo:Boolean(this.demo), cycle:this.cycle, revision:this.revision };
  }
}
module.exports={Behavior,HOLD,DEMO_STATES};
