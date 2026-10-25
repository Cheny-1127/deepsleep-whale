'use strict';

// 仅供测试 bootstrap 在加载应用之前安装，避免窗口先显示再隐藏造成闪烁。
function installTestWindowPolicy() {
  const Module=require('node:module'),electron=require('electron');
  const mode=process.env.WHALE_TEST_WINDOWS||'hidden';
  if(!['hidden','inactive'].includes(mode))throw Error('WHALE_TEST_WINDOWS 仅支持 hidden 或 inactive');
  const NativeWindow=electron.BrowserWindow,load=Module._load;
  const policy=global.testWindowPolicy={mode,events:[]};
  // macOS 测试进程不占用 Dock；窗口限制之外，也屏蔽应用主动激活。
  if(process.platform==='darwin')electron.app.setActivationPolicy('accessory');
  electron.app.focus=()=>{};

  function TestWindow(options={}) {
    // 保留原有 preload 和安全选项，只强制窗口静默并持续渲染，保证后台截图拿到新画面。
    const win=new NativeWindow({...options,show:false,focusable:false,alwaysOnTop:false,skipTaskbar:true,
      paintWhenInitiallyHidden:true,webPreferences:{...options.webPreferences,backgroundThrottling:false}});
    // 提前保存原生方法，观察模式走 showInactive，避免被下面的重写递归调用。
    const showInactive=win.showInactive.bind(win);
    const display=()=>{if(mode==='inactive')showInactive();};
    // 拦截应用自身的展示路径；DOM 聚焦和 Playwright 输入仍可使用。
    win.show=display;win.showInactive=display;win.focus=()=>{};win.moveTop=()=>{};
    win.webContents.focus=()=>{};
    const setFocusable=win.setFocusable.bind(win),setAlwaysOnTop=win.setAlwaysOnTop.bind(win);
    const setWorkspaces=win.setVisibleOnAllWorkspaces.bind(win);
    win.setFocusable=()=>setFocusable(false);
    win.setAlwaysOnTop=()=>setAlwaysOnTop(false);
    win.setVisibleOnAllWorkspaces=()=>setWorkspaces(false);
    for(const type of ['show','focus'])win.on(type,()=>{
      policy.events.push({type,id:win.id});
      // 原生路径若绕过测试封装，立即隐藏；断言仍会报告违规，不把它当作通过。
      if(mode==='hidden'&&type==='show')win.hide();
    });
    if(options.show!==false)win.once('ready-to-show',display);
    return win;
  }
  // 保留静态窗口查询及 instanceof 语义，应用和 Playwright 仍操作真实 BrowserWindow。
  Object.setPrototypeOf(TestWindow,NativeWindow);
  TestWindow.prototype=NativeWindow.prototype;
  const isolatedElectron=new Proxy(electron,{get(target,key){return key==='BrowserWindow'?TestWindow:Reflect.get(target,key);}});
  // 仅当前测试进程替换 electron 的窗口构造入口，覆盖后续模块加载，不修改正式应用源码。
  Module._load=function(request,parent,isMain){return request==='electron'?isolatedElectron:load.call(this,request,parent,isMain);};
}

module.exports={installTestWindowPolicy};
