'use strict';
// 小节目共用同一份清单：菜单、按钮、播放器和主进程计时保持一致。
// 全部来自 dsh-pet 固定提交；原视频均为 640×360、10.042 秒，保留透明通道。
const SPECIAL_ACTIONS = Object.freeze({
  lion: { label:'舞狮头', file:'lion-dance', duration:10042, phrase:'锣鼓响起来！看我耍个狮头。' },
  whale: { label:'蓝鲸现世', file:'blue-whale', duration:10042, phrase:'看，一只小蓝鲸游过来啦。' },
  cuteDance: { label:'可爱宅舞', file:'cute-dance', duration:10042, phrase:'这支舞，只跳给你看。' },
  swayDance: { label:'轻快摇摆舞', file:'sway-dance', duration:10042, phrase:'跟着节拍，晃一晃。' },
  spinningTop: { label:'抽陀螺', file:'spinning-top', duration:10042, phrase:'转起来！看谁转得更久。' },
  gaming: { label:'玩游戏气急败坏', file:'gamer-rage', duration:10042, phrase:'就差一点点！再来一局！' },
  petCat: { label:'撸猫', file:'pet-cat', duration:10042, phrase:'嘘，小猫愿意让我抱呢。' },
  fireworks: { label:'放烟花', file:'fireworks', duration:10042, phrase:'抬头看，烟花开啦！' }
});
// 同时供 Node 主进程和浏览器普通脚本使用，不向页面开放 Node 权限。
if (typeof module !== 'undefined') module.exports = SPECIAL_ACTIONS;
