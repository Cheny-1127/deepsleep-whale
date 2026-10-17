'use strict';
// Optional UI verification: PLAYWRIGHT_MODULE can point at an existing Playwright install.
const { _electron: electron } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const programs = require('../../src/shared/special-actions.js');
const dir = fs.mkdtempSync('/tmp/whale-ui-');
// 旧版外观设置不应阻止启动，也不应丢失通知偏好。
fs.writeFileSync(path.join(dir,'settings.json'),JSON.stringify({skin:'legacy',sound:false,notifications:true}));
let app;
(async () => {
  app = await electron.launch({ executablePath: require('electron'), args: [root], env: { ...process.env, WHALE_DATA_DIR: dir } });
  const errors = [];
  const failedAssets=[];
  app.on('window', page => {
    page.on('pageerror', error => errors.push(error.message));
    page.on('requestfailed', request => failedAssets.push(request.url()));
  });
  await app.firstWindow();
  let panel;
  for(let i=0;i<100;i++) {
    panel=app.windows().find(page=>page.url().endsWith('/index.html'));
    if(panel) break;
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  if(!panel) throw new Error('Control panel did not open');
  async function captureScene(file) {
    // 动画页可能在后台被节流；直接采集相同区域，避免元素截图额外等待稳定帧。
    await panel.locator('.scene').evaluate(el=>el.scrollIntoView({block:'start',behavior:'instant'}));
    const clip=await panel.locator('.scene').boundingBox();
    assert.ok(clip);
    await panel.screenshot({path:file,clip});
  }

  await panel.waitForSelector('#satiety-value');
  await panel.waitForFunction(() => document.querySelector('#connection-status').textContent === '等待首次事件');
  assert.equal(await panel.locator('select, canvas').count(),0);
  const settings=await panel.evaluate(async()=>(await window.whale.snapshot()).settings);
  assert.equal(settings.sound,false);
  assert.equal(settings.notifications,true);
  await panel.locator('[data-action="feed"]').click();
  await panel.waitForFunction(() => document.querySelector('#satiety-value').textContent === '80 / 100');
  await panel.waitForTimeout(3600);
  assert.equal(await panel.locator('#state-label').textContent(),'开饭啦');
  await panel.waitForFunction(() => document.querySelector('#state-label').textContent === '待机中',null,{timeout:10000});
  await panel.locator('[data-action="pat"]').click();
  assert.equal(await panel.locator('#affection-value').textContent(), '14 / 100');
  await panel.waitForFunction(() => { const img = document.querySelector('#rice-image'); return !img.hidden && img.complete && img.naturalWidth > 0; });
  await panel.locator('[data-demo="completed"]').click();
  assert.equal(await panel.locator('#connection-status').textContent(), '等待首次事件');
  assert.equal(await panel.locator('#growth-value').textContent(), '0 次回复');
  fs.mkdirSync(path.join(root,'out/actions'),{recursive:true});
  const actions={idle:'idle',thinking:'thinking',working:'coding',completed:'success',error:'error',pat:'pat',happy:'happy',angry:'angry',approval:'approval',question:'question',sleep:'sleep'};
  for(const [state,file] of Object.entries(actions)) {
    await panel.locator(["pat","happy","angry"].includes(state)?"#tab-emotions":"#tab-daily").click();
    await panel.locator(`[data-demo="${state}"]`).click();
    await panel.waitForFunction(expected=>{const img=document.querySelector('#rice-image');return img.src.includes(`/${expected}.webp`)&&img.complete&&img.naturalWidth===300;},file);
    await captureScene(path.join(root,`out/actions/${state}.png`));
  }
  await panel.locator('#cycle').click();
  await panel.waitForFunction(()=>document.querySelector('#cycle').getAttribute('aria-pressed')==='true');
  const send = (name, session, turn) => {
    const res = spawnSync(process.execPath, [path.join(root,'scripts/codex-hook.cjs')], { env: { ...process.env, WHALE_DATA_DIR: dir }, input: JSON.stringify({ hook_event_name:name, session_id:session, turn_id:turn }), encoding:'utf8' });
    assert.equal(res.status,0); assert.equal(res.stdout,'{}\n');
  };
  const pet = app.windows().find(page => page.url().endsWith('/pet.html'));
  assert.ok(pet,'floating pet exists');
  // 真正右键人物，检查弹出的原生菜单，再执行其实际回调。
  await app.evaluate(({ Menu }) => {
    const popup = Menu.prototype.popup;
    Menu.prototype.popup = function(options) {
      global.whaleTestMenu = this;
      return popup.call(this, options);
    };
  });
  await pet.locator('#pet-art').click({button:'right'});
  const menuItems = await app.evaluate(() => global.whaleTestMenu.items.map(item => ({label:item.label,enabled:item.enabled})));
  assert.deepEqual(menuItems.filter(item => item.label).map(item => item.label),['互动表情','小节目','打开小屋','隐藏桌宠','重启','退出']);
  assert.ok(menuItems[0].enabled);
  await app.evaluate(() => {
    const menu = global.whaleTestMenu;
    menu.closePopup();
    menu.items.find(item => item.label === '小节目').submenu.items.find(item => item.label === '舞狮头').click();
  });
  await panel.waitForFunction(()=>{const v=document.querySelector('#special-video');return !v.paused&&v.currentTime>1&&v.videoWidth===640;});
  const beforeLion=await panel.evaluate(()=>window.whale.snapshot());
  const playback=await panel.locator('#special-video').evaluate(v=>v.currentTime);
  await pet.locator('#pet-art').click({button:'right'});
  assert.equal(await app.evaluate(() => global.whaleTestMenu.items.find(item=>item.label==='小节目').submenu.items[0].enabled),false,'dance cannot be restarted from the menu');
  await app.evaluate(() => global.whaleTestMenu.closePopup());
  send('UserPromptSubmit','smoke-lion','turn-lion');
  await panel.waitForTimeout(400);
  assert.equal(await panel.locator('#state-label').textContent(),'舞狮头');
  assert.ok(await panel.locator('#special-video').evaluate(v=>v.currentTime)>playback,'task changes do not restart the dance');
  await captureScene(path.join(root,'out/lion-dance.png'));
  await panel.waitForFunction(()=>document.querySelector('#state-label').textContent==='思考中',null,{timeout:12000});
  const afterLion=await panel.evaluate(()=>window.whale.snapshot());
  assert.deepEqual(afterLion.nurture,beforeLion.nurture,'dance does not change nurture stats');
  assert.equal(await panel.locator('#special-video').evaluate(v=>v.paused),true);
  await panel.locator('#tab-programs').click();
  await panel.locator('[data-action="lion"]').click();
  send('PermissionRequest','smoke-lion','turn-lion');
  await panel.waitForFunction(()=>document.querySelector('#state-label').textContent==='权限检查');
  assert.equal(await panel.locator('#special-video').evaluate(v=>v.paused),true);
  send('Interrupt','smoke-lion','turn-lion');
  await panel.waitForFunction(()=>document.querySelector('#state-label').textContent==='待机中');
  await panel.locator('#notifications').uncheck();
  const beforePrograms=await panel.evaluate(()=>window.whale.snapshot());
  for(const [id,clip] of Object.entries(programs).filter(([id])=>id!=='lion')) {
    await pet.locator('#pet-art').click({button:'right'});
    await app.evaluate(({},{label})=>{
      const menu=global.whaleTestMenu;
      const item=menu.items.find(item=>item.label==='小节目').submenu.items.find(item=>item.label===label);
      if(!item?.enabled) throw new Error('Program menu is unavailable: '+label);
      menu.closePopup();item.click();
    },{label:clip.label});
    for(const page of [panel,pet]) {
      await page.waitForFunction(file=>{const v=document.querySelector('#special-video');return !v.paused&&v.currentTime>.4&&v.videoWidth===640&&v.src.endsWith('/'+file+'.webm');},clip.file);
    }
    const duration=await panel.locator('#special-video').evaluate(v=>v.duration);
    assert.equal(Math.round(duration*1000),clip.duration);
    assert.equal(await pet.locator('#rice-image').isHidden(),true);
    const bounds=await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().endsWith('/pet.html')).getBounds());
    assert.equal(bounds.width,id==='fireworks'?340:220);
    assert.equal(await pet.locator('#pet-art').evaluate(el=>el.getBoundingClientRect().width),162,'character scale is unchanged');
    for(const page of [panel,pet]) {
      await page.locator('#special-video').evaluate(v=>new Promise(resolve=>{v.addEventListener('seeked',resolve,{once:true});v.currentTime=4.5;}));
    }
    await captureScene(path.join(root,`out/actions/${id}.png`));
    await pet.screenshot({path:path.join(root,`out/actions/${id}-floating.png`),omitBackground:true});
    await panel.waitForFunction(()=>document.querySelector('#state-label').textContent==='待机中',null,{timeout:12000});
    assert.equal(await pet.locator('#special-video').evaluate(v=>v.paused),true);
    assert.equal((await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().endsWith('/pet.html')).getBounds())).width,220);
    console.log('Program verified: '+clip.label);
  }
  const afterPrograms=await panel.evaluate(()=>window.whale.snapshot());
  assert.deepEqual(afterPrograms.nurture,beforePrograms.nurture);
  assert.equal(afterPrograms.activity.count,beforePrograms.activity.count);
  await panel.locator('#cycle').click();
  // Test notifications as events without emitting macOS banners during verification.
  await panel.locator('#notifications').uncheck();
  send('UserPromptSubmit','smoke-session-a','turn-a');
  await panel.waitForFunction(() => document.querySelector('#state-label').textContent === '思考中');
  assert.equal(await panel.locator('#cycle').getAttribute('aria-pressed'),'false');
  send('PreToolUse','smoke-session-a','turn-a');
  await panel.waitForFunction(() => document.querySelector('#state-label').textContent === '敲代码中');
  send('PermissionRequest','smoke-session-a','turn-a');
  await panel.waitForFunction(() => document.querySelector('#state-label').textContent === '权限检查');
  send('Stop','smoke-session-b','turn-b');
  await panel.waitForFunction(() => document.querySelector('#growth-value').textContent === '1 次回复');
  assert.equal(await panel.locator('#state-label').textContent(),'权限检查');
  send('Stop','smoke-session-b','turn-b');
  send('Stop','smoke-session-a','turn-a');
  await panel.waitForFunction(() => document.querySelector('#growth-value').textContent === '2 次回复');
  await panel.locator('[data-demo="idle"]').click();
  fs.mkdirSync(path.join(root,'out'),{recursive:true});
  await panel.screenshot({ path:path.join(root,'out/control-room.png'), fullPage:true });
  const beforeDrag=await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().endsWith('/pet.html')).getBounds());
  const art=await pet.locator('#pet-art').boundingBox();
  await pet.mouse.move(art.x+art.width/2,art.y+art.height/2);
  await pet.mouse.down();
  await pet.mouse.move(art.x+art.width/2-40,art.y+art.height/2-20,{steps:5});
  await pet.mouse.up();
  const afterDrag=await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().endsWith('/pet.html')).getBounds());
  assert.ok(afterDrag.x<beforeDrag.x-10,'dragging the character moves the window');
  assert.equal(afterDrag.width,220); assert.equal(afterDrag.height,320);
  await pet.screenshot({ path:path.join(root,'out/floating-pet.png'), omitBackground:true });
  const dimensions = await panel.evaluate(() => ({ scroll: document.documentElement.scrollHeight, height:innerHeight }));
  assert.deepEqual(errors,[]);
  assert.deepEqual(failedAssets,[]);
  console.log(JSON.stringify({ result:'passed', checks:['feed','pat','legacy-settings-and-rice-only','demo-is-not-live','working','approval','multi-chat','Stop-dedup','floating-window','no-renderer-errors','full-meal-duration','all-11-rice-actions','real-event-stops-demo','character-drag','compact-window','special-video-once','lion-resumes-task','lion-approval-interrupt','lion-no-growth','native-right-click-menu','menu-dance-lock','all-seven-extra-programs','fireworks-space-restores','programs-no-growth-or-events'], dimensions, dataDir:dir }));
})().catch(error => { console.error(error); process.exitCode=1; }).finally(async () => { if (app) await app.close(); });
