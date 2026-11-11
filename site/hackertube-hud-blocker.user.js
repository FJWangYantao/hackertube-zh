// ==UserScript==
// @name         HackerTube 播放器 HUD 屏蔽
// @namespace    https://fjwangyantao.github.io/hackertube-zh/
// @version      1.3.0
// @description  在 HackerTube 中文站内屏蔽 YouTube 播放器原生界面（标题栏、水印、中央播放键、片尾推荐等），避免与站内自定义控制栏重合。支持在站内设置中启停。仅作用于嵌入在本站的 YouTube 播放器。
// @match        https://www.youtube.com/embed/*
// @match        https://www.youtube-nocookie.com/embed/*
// @run-at       document-start
// @grant        none
// @updateURL    https://fjwangyantao.github.io/hackertube-zh/hackertube-hud-blocker.user.js
// @downloadURL  https://fjwangyantao.github.io/hackertube-zh/hackertube-hud-blocker.user.js
// ==/UserScript==

(function () {
  'use strict';

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

  var selectors = [
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
    '.player-controls-top',
    '.ytwPlayerTopControlsHost',
    '.ytwPlayerTopControlsLeftContent',
    '.ytwPlayerTopControlsTitleWrapper',
    '.ytmVideoInfoHost',
    '.ytmCuedOverlayHost',
    '.ytmVideoCoverHost',
    '.ytwPlayerSeekOverlayHost',
    '.ytwPlayerUserEduTooltipHost',
    '.ytwPlayerBottomControlsHost',
    'a[aria-label="Watch on YouTube"]',
    '.watch-on-youtube-button-wrapper',
    '.watch-on-youtube-button',
    '.fullscreen-watch-next-entrypoint-wrapper',
    'ytm-button-renderer.icon-link',
    '.icon-link',
    '.ytp-caption-window-container',
    '.caption-window',
    '.ytwPlayerFullscreenTopControlsHost',
    '.ytmFullscreenRelatedVideosEntryPointViewModelHost',
  ];
  var css = selectors.join(',\n') + ' { display: none !important; }';
  var MARK = 'data-hackertube-hud-blocker';
  var VERSION = '1.3.0';
  var enabled = true;
  var styleNode = null;

  var ensure = function () {
    if (!enabled) return false;
    if (styleNode && document.documentElement.contains(styleNode)) return true;
    var root = document.head || document.documentElement;
    if (!root) return false;
    styleNode = document.createElement('style');
    styleNode.setAttribute(MARK, '1');
    styleNode.textContent = css;
    root.appendChild(styleNode);
    return true;
  };

  var removeStyle = function () {
    if (styleNode) {
      styleNode.remove();
      styleNode = null;
    }
  };

  var apply = function () {
    if (enabled) ensure();
    else removeStyle();
  };

  var notifyIfWorking = function () {
    var active = false;
    if (ensure()) {
      var probe = document.createElement('div');
      probe.className = 'ytmVideoInfoHost';
      document.documentElement.appendChild(probe);
      active = getComputedStyle(probe).display === 'none';
      probe.remove();
    }
    try {
      window.parent.postMessage({
        source: 'ht-hud-blocker',
        type: 'state',
        active: active,
        version: VERSION,
      }, ref.origin);
    } catch (err) { /* 父页面不可达时忽略 */ }
  };

  window.addEventListener('message', function (event) {
    if (event.origin !== ref.origin || event.source !== window.parent) return;
    var data = event.data;
    if (!data || data.source !== 'ht-hud-blocker-control' || data.type !== 'set-enabled') return;
    enabled = data.enabled !== false;
    apply();
    notifyIfWorking();
  });

  apply();
  notifyIfWorking();
  document.addEventListener('readystatechange', notifyIfWorking);
  document.addEventListener('DOMContentLoaded', notifyIfWorking);
  window.addEventListener('load', notifyIfWorking);
})();
