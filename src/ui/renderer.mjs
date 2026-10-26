'use strict';
import { createSidebarView, updateSidebarStatus } from './sidebar-view.mjs';
import { createHookSettingsView, showView } from './hooks-view.mjs';
import { createReminderView } from './reminders-view.mjs';
import { createWechatView } from './wechat-view.mjs';
import { createMessageSubscriptionsView } from './message-subscriptions-view.mjs';
import { createMailView } from './mail-view.mjs';
import { createArcheryView } from './archery-view.mjs';
import { createQuotaView } from './quota-view.mjs';
import { createGroupUsageView } from './quota-group-view.mjs';
import { createKeyUsageView } from './quota-key-view.mjs';
import { createPetHitTest } from './pet-hit-test.mjs';
import { createPetGestures } from './pet-gestures.mjs';
import { createShortcutsView } from './shortcuts-view.mjs';
import { createPetQuotaSettingsView } from './pet-quota-settings-view.mjs';
import { createPetQuotaView } from './pet-quota-view.mjs';
import { createPlannerView } from './planner-view.mjs';
import { createModulesView } from './modules-view.mjs';

const $ = id => document.getElementById(id);
const copy = {
  idle:['待机中','我在呢。今天也要记得吃饭。','你忙你的，我陪着。','才不是在等你摸头呢。'],
  thinking:['思考中','嗯……让我想一想。','别催，这题有点绕。'],
  working:['敲代码中','噼里啪啦！饭先替我留着。','正在认真干活，不许偷吃我的饭。'],
  approval:['权限检查','正在检查操作权限，可能需要你确认。'],
  question:['有个问题','喂，这里需要你回答一下。'],
  completed:['本轮回复结束','回复好啦，我先吃口饭。','结果等你过目，奖励一碗饭！'],
  pat:['摸摸头','就、就再摸一下。','嗯……摸头这件事，你还挺会的。','不许笑，我才没害羞。'],
  happy:['开心','好耶！今天也有人陪我！','现在心情超好，再来一碗！'],
  angry:['生气了','哼！再戳我要生气了！','人家也是有脾气的！'],
  error:['遇到报错','呜哇！出错了，快看看。'],
  feed:['开饭啦','白米饭！这一碗我就收下了。','吃完这碗再说，不许催。'],
  drowsy:['有点困了','哈啊……再陪你一小会儿。'],
  sleep:['睡着啦','呼……梦里也有大米饭。']
};
for (const [id, clip] of Object.entries(SPECIAL_ACTIONS)) copy[id]=[clip.label,clip.phrase];
const rice = {idle:'idle',thinking:'thinking',working:'coding',approval:'approval',question:'question',completed:'success',pat:'pat',happy:'happy',angry:'angry',error:'error',feed:'success',drowsy:'idle',sleep:'sleep'};
// 预加载本地动画，降低首次切换等待；实际播放仍使用完整动画文件。
for (const file of new Set(Object.values(rice))) { const image=new Image(); image.src=`../../assets/rice-rendered/${file}.webp`; }
let current='idle',visualKey='',speechUntil=0,phrase=0,lastData;
const floating=document.body.classList.contains('floating');
createPetHitTest();
createSidebarView();
const hooksView=createHookSettingsView({render});
const remindersView=createReminderView({render,action,floating});
const plannerView=createPlannerView({floating});
const wechatView=createWechatView();
createMailView();
const subscriptionsView=createMessageSubscriptionsView();
createArcheryView();
createQuotaView();
createGroupUsageView();
createKeyUsageView();
createPetQuotaSettingsView();
createPetQuotaView({say:text=>{
  $('speech').textContent=text;
  speechUntil=Date.now()+3600;
  $('speech').hidden=false;
  $('speech').classList.remove('quiet');
  $('speech').classList.add('quota-feedback');
}});
const shortcutsView=createShortcutsView();
const modulesView=createModulesView({render});
if ($('special-actions')) {
  for (const [id, clip] of Object.entries(SPECIAL_ACTIONS)) {
    const button=document.createElement('button');
    button.dataset.action=id; button.textContent=clip.label;
    $('special-actions').append(button);
  }
}
// 分类只切换按钮列表，不打断当前动作或连播；方向键也可切换分类。
const actionTabs=[...document.querySelectorAll('.action-tabs [role="tab"]')];
function selectActionTab(tab) {
  for(const item of actionTabs) {
    const selected=item===tab;
    item.setAttribute('aria-selected',String(selected));item.tabIndex=selected?0:-1;
    $(item.getAttribute('aria-controls')).hidden=!selected;
  }
}
actionTabs.forEach((tab,index)=>{
  tab.addEventListener('click',()=>selectActionTab(tab));
  tab.addEventListener('keydown',event=>{
    let next;
    if(event.key==='ArrowRight') next=(index+1)%actionTabs.length;
    else if(event.key==='ArrowLeft') next=(index+actionTabs.length-1)%actionTabs.length;
    else if(event.key==='Home') next=0;
    else if(event.key==='End') next=actionTabs.length-1;
    else return;
    event.preventDefault();selectActionTab(actionTabs[next]);actionTabs[next].focus();
  });
});
function render(data) {
  lastData=data;
  modulesView.render(data.modules);
  updateSidebarStatus('hooks',data);
  updateSidebarStatus('wechat',data.wechat);
  // 以原生窗口状态为准，托盘或右键隐藏桌宠后，小屋按钮也会同步。
  if($('pet-visibility-toggle'))$('pet-visibility-toggle').textContent=data.petVisible?'隐藏':'显示';
  hooksView.render(data);
  remindersView.render(data);
  plannerView.render(data.planner);
  wechatView.render(data.wechat);
  shortcutsView.render(data);
  subscriptionsView?.renderSummary(data.subscriptions);
  // 主进程频繁广播状态，只有动作或播放版本变化才重置动画与气泡。
  const nextKey=`${data.state}:${data.revision}:${data.demo}`;
  const previous=current;
  current=data.state;
  if (visualKey!==nextKey) {
    visualKey=nextKey;
    const words=copy[current] || copy.idle;
    $('speech').classList.remove('quota-feedback');
    $('speech').textContent=words[1+(phrase++%(words.length-1))];
    speechUntil=Date.now()+3600;
    // 用播放版本区分 URL，让重复摸头等同名动作也能从第一帧重新播放。
    const video=$('special-video');
    const clip=Object.hasOwn(SPECIAL_ACTIONS,current) ? SPECIAL_ACTIONS[current] : null;
    $('special-art').hidden=!clip;
    $('rice-image').hidden=Boolean(clip);
    if(clip) {
      // 原视频保留透明通道，只播放一次；普通任务事件不会重新开始节目。
      if(previous!==current) {
        video.src=`../../assets/dsh/${clip.file}.webm`;
        video.setAttribute('aria-label',clip.label);
        video.currentTime=0;
        video.play().catch(()=>{
          // 切换回普通动作时，浏览器会取消尚未完成的 play；不要覆盖新气泡。
          if(current===data.state) $('speech').textContent=`${clip.label}暂时无法播放，请再试一次。`;
        });
      }
    } else {
      video.pause();
      $('rice-image').src=`../../assets/rice-rendered/${rice[current] || 'idle'}.webp?play=${data.revision}-${current}-${data.demo}`;
    }
  }
  $('state-label').textContent=(data.demo?'演示 · ':'')+(copy[current] || copy.idle)[0];
  $('speech').hidden=floating&&current==='approval';
  $('speech').classList.toggle('quiet',floating && Date.now()>speechUntil && !['approval','question','error'].includes(current));
  $('speech').classList.toggle('attention',['approval','question','error'].includes(current));
  $('pet-art').dataset.state=current;
  $('prop').textContent=current==='pat'?'♡':['sleep','drowsy'].includes(current)?'💤':'';
  $('prop').classList.toggle('pop',['pat','feed','happy'].includes(current));
  if (!$('satiety')) return;
  for(const metric of ['satiety','affection']) {
    $(metric).value=data.nurture[metric];
    $(metric+'-value').textContent=`${data.nurture[metric]} / 100`;
  }
  $('growth-value').textContent=`${data.nurture.totalWorkSessions} 次回复`;
  $('notifications').checked=data.settings.notifications;
  $('sound').checked=data.settings.sound;
  $('show-panel-on-startup').checked=data.settings.showPanelOnStartup;
  $('demo-label').hidden=!data.demo;
  $('cycle').textContent=data.cycle?'■ 停止连播':'▶ 连播日常动作';
  $('cycle').setAttribute('aria-pressed',String(data.cycle));
  const status=$('connection-status');
  // 桥已启动与收到事件是两回事；演示按钮不会增加 activity.count。
  status.classList.toggle('live',data.activity.count>0);
  status.textContent=!data.bridge?'提醒桥不可用':data.activity.count?'已收到事件':'等待首次事件';
  $('connection-detail').textContent=data.bridgeError || (data.activity.count?`工作中 ${data.activity.working} 个 · 权限检查 ${data.activity.pending} 个`:'提醒桥已就绪，配置客户端 Hooks 后自动联动。');
  const last=data.activity.last;
  $('task-line').textContent=last?`最近事件：${last.hook_event_name} · 会话 ${last.session_id.slice(0,8)} · ${new Date(last.time).toLocaleTimeString('zh-CN')}`:'尚未收到 Hooks 事件；下方按钮仅演示动画。';
}
async function action(name,value) { try { render(await window.whale.action(name,value)); } catch { $('speech').textContent='操作没有保存，请重新试一下。'; } }
document.querySelectorAll('[data-action]').forEach(button=>button.addEventListener('click',()=>action(button.dataset.action)));
document.querySelectorAll('[data-demo]').forEach(button=>button.addEventListener('click',()=>action('demo',button.dataset.demo)));
if (floating) {
  createPetGestures({element:$('pet-art'),action,drag:(...args)=>window.whale.drag(...args),
    enabled:()=>lastData?.modules?.shortcuts!==false&&lastData?.shortcuts?.tripleClick!=='none'});
} else {
  $('pet-art').addEventListener('click',()=>action('touch'));
  $('pet-art').addEventListener('keydown',event=>{ if(event.key==='Enter'||event.key===' ') { event.preventDefault(); action('touch'); } });
}
if($('cycle')) {
  for(const setting of ['sound','notifications']) $(setting).addEventListener('change',event=>action(setting,event.target.checked));
  $('show-panel-on-startup').addEventListener('change',async event=>{
    const input=event.currentTarget,error=$('startup-settings-error');
    input.disabled=true;error.hidden=true;
    try {render(await window.whale.action('showPanelOnStartup',input.checked));}
    catch {input.checked=lastData.settings.showPanelOnStartup;error.textContent='启动设置保存失败，请重试。';error.hidden=false;}
    finally {input.disabled=false;}
  });
  $('cycle').addEventListener('click',()=>action('cycle',!lastData?.cycle));
}
window.whale.subscribe(render);
window.whale.showReminders(()=>{
  if($('reminders')) {
    showView('home');
    $('reminders').scrollIntoView({block:'center'});
    $('reminders').focus({preventScroll:true});
    $('chat-details').open=true;
  }
});
window.whale.snapshot().then(render);
window.whale.chime(()=>{
  const audio=new AudioContext();
  const tone=audio.createOscillator(),volume=audio.createGain();
  tone.type='sine'; tone.frequency.setValueAtTime(660,audio.currentTime);
  tone.frequency.setValueAtTime(880,audio.currentTime+.14);
  volume.gain.setValueAtTime(.06,audio.currentTime); volume.gain.exponentialRampToValueAtTime(.001,audio.currentTime+.4);
  tone.connect(volume).connect(audio.destination); tone.start(); tone.stop(audio.currentTime+.4);
  tone.onended=()=>audio.close();
});
