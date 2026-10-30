'use strict';
// 真实 Chromium 输入序列；隐藏独立窗口、合成账号，不加载正式应用或管理凭据。
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
if(!process.versions.electron) {
  require('node:child_process').execFileSync(require('electron'),[__filename],{stdio:'inherit'});
} else {
  require('./test-window-policy.cjs').installTestWindowPolicy();
  const {app,BrowserWindow}=require('electron');
  const root=path.resolve(__dirname,'../..'),dir=fs.mkdtempSync('/tmp/whale-quota-menu-');
  app.setPath('userData',dir);
  const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  app.whenReady().then(async()=>{
    const win=new BrowserWindow({width:1280,height:800,show:false,webPreferences:{backgroundThrottling:false}});
    try {
      const html=fs.readFileSync(path.join(root,'src/ui/index.html'),'utf8')
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/g,'')
        .replace(/href="(style.css|quota-key.css)"/g,(_,file)=>`href="file://${root}/src/ui/${file}"`);
      fs.writeFileSync(path.join(dir,'index.html'),html);
      await win.loadFile(path.join(dir,'index.html'));
      const source=fs.readFileSync(path.join(root,'src/ui/quota-view.mjs'),'utf8').replace(/^import .*;\n/gm,'').replace('export function','function');
      const confirmation=fs.readFileSync(path.join(root,'src/ui/confirm-dialog.mjs'),'utf8').replace('export function','function');
      await win.webContents.executeJavaScript(`
        window.menuFixture={accounts:[{id:5,name:'missing-account',upstreamMissing:true,refreshEnabled:false}],removed:[]};
        window.whale={quota:async(name,id)=>{
          if(name==='remove-account'){menuFixture.removed.push(id);menuFixture.accounts=[];}
          return {value:{accounts:menuFixture.accounts,checkedAt:1,nextRefreshAt:8640000000000000}};
        }};
        function updateSidebarStatus(){}
        ${confirmation};${source};
        document.querySelectorAll('main > [id$="-view"]').forEach(el=>el.hidden=true);
        document.getElementById('quota-view').hidden=false;createQuotaView();
        document.getElementById('nav-quota').click();
      `);
      const evaluate=code=>win.webContents.executeJavaScript(code);
      const point=selector=>evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:Math.round(r.left+12),y:Math.round(r.top+12)}})()`);
      const click=async(selector,button='left')=>{
        const position=await point(selector);
        win.webContents.sendInputEvent({type:'mouseDown',button,clickCount:1,...position});
        win.webContents.sendInputEvent({type:'mouseUp',button,clickCount:1,...position});
        await delay(100);
      };
      const isOpen=()=>evaluate(`!!document.querySelector('.quota-account-menu:popover-open')`);
      const rightClick=()=>click('#quota-list .quota-account','right');
      await delay(150);
      await evaluate('window.scrollTo(0,180)');await delay(100);
      await rightClick();
      await delay(2200); // 覆盖 mouseUp 和页面的本地状态轮询。
      assert.equal(await isOpen(),true,'右键释放和本地轮询后菜单应持续显示');
      fs.writeFileSync('/tmp/whale-quota-account-menu-smoke.png',(await win.webContents.capturePage()).toPNG());
      await click('#quota-heading');assert.equal(await isOpen(),false,'点外部关闭');
      await rightClick();
      win.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'});
      win.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'});
      await delay(100);assert.equal(await isOpen(),false,'Esc 关闭');
      await rightClick();await click('.quota-account-menu button');
      assert.equal(await evaluate(`!!document.querySelector('dialog[open]')`),true,'删除前确认');
      assert.equal(await evaluate(`document.activeElement.textContent`),'取消','默认聚焦取消');
      await click('dialog[open] .outline');
      assert.equal(await evaluate('menuFixture.removed.length'),0,'取消不删除');
      await rightClick();await click('.quota-account-menu button');
      await click('dialog[open] .primary');
      assert.equal(await evaluate('menuFixture.removed.join()'),'5','明确确认后才删除');
      assert.equal(await evaluate(`document.querySelectorAll('#quota-list tr').length`),0);
      console.log('Quota account menu: real right-click, polling, outside click, Escape, cancel and confirmed removal OK');
    } finally {win.destroy();app.quit();}
  }).catch(error=>{console.error(error);app.exit(1);});
  app.on('quit',()=>fs.rmSync(dir,{recursive:true,force:true}));
}
