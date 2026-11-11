// ==UserScript==
// @name         HackerTube 播放器 HUD 屏蔽
// @namespace    https://fjwangyantao.github.io/hackertube-zh/
// @version      1.2.0
// @description  在 HackerTube 中文站内屏蔽 YouTube 播放器原生界面（标题栏、水印、中央播放键、片尾推荐等），避免与站内自定义控制栏重合。仅作用于嵌入在本站的 YouTube 播放器。
// @match        https://www.youtube.com/embed/*
// @match        https://www.youtube-nocookie.com/embed/*
// @run-at       document-start
// @grant        none
// @updateURL    https://fjwangyantao.github.io/hackertube-zh/hackertube-hud-blocker.user.js
// @downloadURL  https://fjwangyantao.github.io/hackertube-zh/hackertube-hud-blocker.user.js
// ==/UserScript==

(function () {
  'use strict';

  // 只处理嵌入在 HackerTube 中文站（含本地开发地址）里的播放器，不影响其他网站的嵌入。
  var ref;
  try {
    ref = new URL(document.referrer);
  } catch (err) {
    return;
  }
  var host = ref.hostname;
  var isHackertube =
    (host === 'fjwangyantao.github.io' && ref.pathname.indexOf('/hackertube-zh') === 0) ||
    host === 'localhost' ||
    host === '127.0.0.1';
  if (!isHackertube || window.top === window.self) return;

  // 旧版（2026 前）与新版（ytw/ytm 前缀）类名都保留：YouTube 改版时两边兜底。
  // 站内 iframe pointer-events:none，这些元素均不可交互，隐藏无副作用。
  var selectors = [
    // —— 旧版类名（兜底）——
    '.ytp-chrome-top',
    '.ytp-gradient-top',
    '.ytp-gradient-bottom',
    '.ytp-watermark',
    '.ytp-impression-link',
    '.ytp-large-play-button',
    '.ytp-bezel',
    '.ytp-endscreen-content',
    '.ytp-ce-element',
    '.ytp-ce-covering-overlay',
    '.ytp-unmute',
    // —— 新版：顶部标题栏（视频标题 + 频道头像）——
    '.player-controls-top',
    '.ytwPlayerTopControlsHost',
    '.ytwPlayerTopControlsLeftContent',
    '.ytwPlayerTopControlsTitleWrapper',
    '.ytmVideoInfoHost',
    // —— 新版：暂停时的中央大播放键（cued overlay：封面 + 渐变 + 播放键）——
    '.ytmCuedOverlayHost',
    '.ytmVideoCoverHost',
    // —— 新版：快进快退箭头动画、教学气泡 ——
    '.ytwPlayerSeekOverlayHost',
    '.ytwPlayerUserEduTooltipHost',
    // —— 新版：底部时间胶囊 + Watch on YouTube 角标 ——
    '.ytwPlayerBottomControlsHost',
    'a[aria-label="Watch on YouTube"]',
    // —— 2026-11 改版：暂停态底部按钮（类名已换，旧选择器失效）——
    '.watch-on-youtube-button-wrapper',
    '.watch-on-youtube-button',
    '.fullscreen-watch-next-entrypoint-wrapper',
    // —— 2026-11 改版：左下角视频链接圆形按钮（旧版 .ytp-impression-link 兜底）——
    'ytm-button-renderer.icon-link',
    '.icon-link',
    // —— 原生 CC 字幕：站内有自己的双语字幕层，原生字幕属干扰 ——
    '.ytp-caption-window-container',
    '.caption-window',
    // —— 新版：全屏顶部标题与「更多视频」入口 ——
    '.ytwPlayerFullscreenTopControlsHost',
    '.ytmFullscreenRelatedVideosEntryPointViewModelHost',
  ];
  var css = selectors.join(',\n') + ' { display: none !important; }';
  var MARK = 'data-hackertube-hud-blocker';

  // document-start 注入的 <style> 在个别时序下可能随文档替换丢失：
  // 在关键节点反复确保样式存在（CSS 规则会自动套用到之后动态创建的元素）。
  var ensure = function () {
    if (document.querySelector('style[' + MARK + ']')) return true;
    var root = document.head || document.documentElement;
    if (!root) return false;
    var style = document.createElement('style');
    style.setAttribute(MARK, '1');
    style.textContent = css;
    root.appendChild(style);
    return true;
  };

  // 自检：样式真的生效（未被 CSP 拦截等）才通知站点关遮罩，失败则让站点继续用遮罩兜底。
  var notifyIfWorking = function () {
    if (!ensure()) return;
    var probe = document.createElement('div');
    probe.className = 'ytmVideoInfoHost';
    document.documentElement.appendChild(probe);
    var hidden = getComputedStyle(probe).display === 'none';
    probe.remove();
    if (!hidden) return;
    try {
      window.parent.postMessage({ source: 'ht-hud-blocker', active: true }, '*');
    } catch (err) { /* 父页面不可达时忽略 */ }
  };

  ensure();
  notifyIfWorking();
  document.addEventListener('readystatechange', notifyIfWorking);
  document.addEventListener('DOMContentLoaded', notifyIfWorking);
  window.addEventListener('load', notifyIfWorking);
})();
