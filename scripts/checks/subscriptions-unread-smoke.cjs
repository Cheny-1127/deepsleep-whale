'use strict';
// 隐藏独立窗口，使用真实订阅页面与合成快照，不访问账号或外部服务。
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
if(!process.versions.electron) {
  require('node:child_process').execFileSync(require('electron'),[__filename],{stdio:'inherit'});
} else {
  require('./test-window-policy.cjs').installTestWindowPolicy();
  const {app,BrowserWindow}=require('electron');
  const root=path.resolve(__dirname,'../..'),dir=fs.mkdtempSync('/tmp/whale-subscriptions-unread-');
  app.setPath('userData',dir);
  app.whenReady().then(async()=>{
    const win=new BrowserWindow({width:1060,height:770,show:false,webPreferences:{backgroundThrottling:false}});
    try {
      const html=fs.readFileSync(path.join(root,'src/ui/index.html'),'utf8')
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/g,'')
        .replace(/href="(style.css|quota-key.css)"/g,(_,file)=>`href="file://${root}/src/ui/${file}"`);
      fs.writeFileSync(path.join(dir,'index.html'),html);await win.loadFile(path.join(dir,'index.html'));
      const hooks=fs.readFileSync(path.join(root,'src/ui/hooks-view.mjs'),'utf8').split('export function createHookSettingsView')[0].replace(/^const \$ = .*;\n/m,'').replace('export function','function');
      const source=fs.readFileSync(path.join(root,'src/ui/message-subscriptions-view.mjs'),'utf8').replace(/^import .*;\n/gm,'').replace('export function','function');
      const evaluate=code=>win.webContents.executeJavaScript(code);
      await evaluate(`(()=>{
        window.fixture={calls:[],hold:false};
        fixture.data={revision:1,unread:2,busy:false,accountLimit:20,accounts:[{username:'fixture',enabled:true,unread:2}],posts:Array.from({length:20},(_,i)=>({username:'fixture',id:String(100-i),text:'合成消息 '+i,publishedAt:0,unread:i===6||i===12}))};
        window.whale={showSubscriptions:handler=>fixture.open=handler,subscriptions:async(name,value)=>{
          fixture.calls.push({name,value});
          if(fixture.hold&&name==='snapshot')await new Promise(resolve=>fixture.release=resolve);
          return {value:structuredClone(fixture.data)};
        }};
        function updateSidebarStatus(){}
        ${hooks};${source};
        fixture.view=createMessageSubscriptionsView();fixture.showView=showView;
      })()`);
      const settle=()=>evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
      const metrics=()=>evaluate(`(()=>{const target=[...document.querySelectorAll('.subscriptions-post')].find(el=>el.dataset.postId==='94');const r=target?.getBoundingClientRect();return {checked:document.getElementById('subscriptions-unread').checked,count:document.querySelectorAll('.subscriptions-post').length,top:r?.top,unread:document.querySelectorAll('.subscriptions-unread-dot').length}})()`);
      await evaluate('fixture.open()');await settle();
      let result=await metrics();
      assert.equal(result.checked,false,'提醒跳转不能自动勾选只看未读');
      assert.equal(result.count,20,'跳转保留已读消息作为上下文');
      assert.ok(Math.abs(result.top)<2,'定位到列表中第一条未读消息 '+JSON.stringify(result));
      assert.equal(result.unread,2,'定位不会把消息标为已读');
      // 重新点击同一提醒时，即便快照没有变化也应重新定位。
      await evaluate('window.scrollTo(0,0);fixture.open()');await settle();
      assert.ok(Math.abs((await metrics()).top)<2);
      // 尊重用户手动启用的未读筛选。
      await evaluate(`document.getElementById('subscriptions-unread').click();fixture.open()`);await settle();
      result=await metrics();assert.equal(result.checked,true);assert.equal(result.count,2);assert.ok(result.top>=0&&result.top<770,'短列表中未读消息保持可见');
      // 切换页面后等待新快照，不能先跳到旧缓存中的未读位置。
      await evaluate(`document.getElementById('subscriptions-unread').click();fixture.showView('home');fixture.hold=true;fixture.data.posts.forEach(post=>post.unread=post.id==='88');fixture.data.unread=1;fixture.data.revision++;fixture.open();`);
      await evaluate('fixture.hold=false;fixture.release()');await settle();
      const newTop=await evaluate(`document.querySelector('[data-post-id="88"]').getBoundingClientRect().top`);
      assert.ok(Math.abs(newTop)<2,'按最新快照中的第一条未读定位');
      // 后续快照更新保持当前阅读位置，不持续抢滚动。
      await evaluate('window.scrollTo(0,350);fixture.data.revision++;fixture.view.renderSummary(fixture.data)');await settle();
      assert.equal(await evaluate('window.scrollY'),350);
      assert.equal(await evaluate(`fixture.calls.some(call=>call.name!=='snapshot')`),false,'跳转只读取快照');
      console.log('Subscriptions unread navigation OK: filter preserved, first unread located, fresh snapshot, repeated clicks and no read mutation.');
    } finally {win.destroy();app.quit();}
  }).catch(error=>{console.error(error);app.exit(1);});
  app.on('quit',()=>fs.rmSync(dir,{recursive:true,force:true}));
}
