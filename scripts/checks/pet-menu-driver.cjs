'use strict';
// 操作真实自绘菜单窗口，避免把主进程回调当作用户点击来验证。
module.exports=function createPetMenuDriver(app,pet) {
  let page;
  const native=()=>app.evaluate(({BrowserWindow})=>{
    const win=BrowserWindow.getAllWindows().find(win=>win.webContents.getURL().endsWith('/pet-menu.html'));
    return win?{visible:win.isVisible(),bounds:win.getContentBounds()}:null;
  });
  return {
    async open(position) {
      const previous=page?await page.locator('#pet-menu').getAttribute('data-request'):null;
      if((await native())?.visible) {
        await page.keyboard.press('Escape');
        await app.evaluate(async({BrowserWindow})=>{
          const win=BrowserWindow.getAllWindows().find(win=>win.webContents.getURL().endsWith('/pet-menu.html'));
          for(let i=0;i<100&&win?.isVisible();i++)await new Promise(resolve=>setTimeout(resolve,10));
        });
      }
      await pet.locator('#pet-art').click({button:'right',...(position?{position}:{})});
      for(let i=0;i<100;i++) {
        page=app.windows().find(page=>page.url().endsWith('/pet-menu.html'));
        if(page)break;
        await new Promise(resolve=>setTimeout(resolve,50));
      }
      if(!page)throw Error('Custom pet menu window did not open');
      await page.waitForFunction(previous=>{
        const request=document.getElementById('pet-menu').dataset.request;
        return request&&request!==previous;
      },previous);
      await app.evaluate(async({BrowserWindow})=>{
        const win=BrowserWindow.getAllWindows().find(win=>win.webContents.getURL().endsWith('/pet-menu.html'));
        for(let i=0;i<100;i++){if(win?.isVisible())return;await new Promise(resolve=>setTimeout(resolve,10));}
        throw Error('Custom pet menu was not shown');
      });
      return page;
    },
    async geometry() {
      const state=await native();
      const panels=await page.locator('[role="menu"]:visible').evaluateAll(elements=>elements.map(element=>{
        const r=element.getBoundingClientRect();return {label:element.getAttribute('aria-label'),x:r.x,y:r.y,width:r.width,height:r.height};
      }));
      return {...state,panels:panels.map(panel=>({...panel,x:panel.x+state.bounds.x,y:panel.y+state.bounds.y}))};
    }
  };
};
