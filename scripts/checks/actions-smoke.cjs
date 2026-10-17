'use strict';
// 使用隔离数据验证分类切换和真实原生子菜单，不写入用户桌宠数据。
const {_electron:electron}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const programs=require('../../src/shared/special-actions.js');
const root=path.resolve(__dirname, '../..');
(async()=>{
  const app=await electron.launch({executablePath:require('electron'),args:[root],env:{...process.env,WHALE_DATA_DIR:fs.mkdtempSync('/tmp/whale-actions-')}});
  try {
    await app.firstWindow();
    let panel;
    for(let i=0;i<100;i++){
      panel=app.windows().find(page=>page.url().endsWith('/index.html'));
      if(panel)break;
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    assert.ok(panel);
    const errors=[];panel.on('pageerror',e=>errors.push(e.message));
    await panel.waitForSelector('#tab-daily');
    const tabs=['tab-daily','tab-emotions','tab-programs'];
    const counts=[8,3,8];
    for(let i=0;i<tabs.length;i++){
      await panel.locator('#'+tabs[i]).click();
      assert.equal(await panel.locator('[role="tabpanel"]:visible').count(),1);
      assert.equal(await panel.locator('[role="tabpanel"]:visible button').count(),counts[i]);
      assert.equal(await panel.locator('#'+tabs[i]).getAttribute('aria-selected'),'true');
      const layout=await panel.locator('[role="tabpanel"]:visible').evaluate(el=>{
        const boxes=[...el.children].map(b=>b.getBoundingClientRect());
        return {columns:getComputedStyle(el).gridTemplateColumns.split(' ').length,fits:boxes.every(b=>b.left>=el.getBoundingClientRect().left&&b.right<=el.getBoundingClientRect().right+1)};
      });
      assert.ok(layout.columns<=4&&layout.columns>=3&&layout.fits);
    }
    const before=await panel.evaluate(()=>window.whale.snapshot());
    await panel.locator('#tab-programs').press('ArrowRight');
    assert.equal(await panel.locator('#tab-daily').getAttribute('aria-selected'),'true');
    await panel.locator('#tab-daily').press('End');
    assert.equal(await panel.locator('#tab-programs').getAttribute('aria-selected'),'true');
    const after=await panel.evaluate(()=>window.whale.snapshot());
    assert.equal(after.revision,before.revision,'分类切换不能触发动作');
    assert.deepEqual(after.nurture,before.nurture);
    fs.mkdirSync(path.join(root,'out'),{recursive:true});
    await panel.locator('.action-library').evaluate(el=>el.scrollIntoView({block:'center'}));
    const clip=await panel.locator('.action-library').boundingBox();
    await panel.screenshot({path:path.join(root,'out/action-categories.png'),clip});
    await panel.locator('#tab-emotions').click();
    await panel.locator('[data-demo="happy"]').click();
    assert.equal(await panel.locator('#state-label').textContent(),'演示 · 开心');
    const pet=app.windows().find(page=>page.url().endsWith('/pet.html'));
    await app.evaluate(({Menu})=>{Menu.prototype.popup=function(){global.whaleActionMenu=this;};});
    await pet.locator('#pet-art').click({button:'right'});
    const menu=await app.evaluate(()=>global.whaleActionMenu.items.filter(i=>i.label).map(i=>({label:i.label,children:i.submenu?.items.map(c=>c.label)})));
    assert.deepEqual(menu.map(i=>i.label),['互动表情','小节目','打开小屋','隐藏桌宠','重启','退出']);
    assert.deepEqual(menu[0].children,['喂饭','摸头','开心','生气']);
    assert.deepEqual(menu[1].children,Object.values(programs).map(p=>p.label));
    await app.evaluate(()=>global.whaleActionMenu.items.find(i=>i.label==='小节目').submenu.items[0].click());
    await panel.waitForFunction(()=>document.querySelector('#state-label').textContent==='舞狮头');
    await panel.locator('#tab-programs').click();
    await panel.waitForFunction(()=>{const v=document.querySelector('#special-video');return !v.paused&&v.currentTime>.3;});
    await pet.locator('#pet-art').click({button:'right'});
    assert.equal(await app.evaluate(()=>global.whaleActionMenu.items.find(i=>i.label==='小节目').submenu.items.every(i=>!i.enabled)),true);
    assert.deepEqual(errors,[]);
    console.log(JSON.stringify({result:'passed',checks:['three-categories','single-visible-page','compact-grid','keyboard-navigation','switch-preserves-state','emotion-action','grouped-native-menu','all-programs-retained','native-program-playback','program-lock'],screenshot:path.join(root,'out/action-categories.png')}));
  } finally {await app.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
