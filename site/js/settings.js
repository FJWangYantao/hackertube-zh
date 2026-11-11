import { el, toast } from './ui.js';
import { store } from './data.js';
import { exportUserData, triggerImportUserData } from './user-data.js';

export const SETTINGS_EVENT = 'ht:settingschange';
export const BLOCKER_STATE_EVENT = 'ht:hud-blocker-state';
export const SETTINGS_IMPORT_EVENT = 'ht:settingsimport';

const SUBTITLE_OPTIONS = [
  ['off', '关闭'],
  ['zh', '中文'],
  ['both', '中英双语'],
  ['en', '英文'],
];
const SPEED_OPTIONS = [0.75, 1, 1.25, 1.35, 1.5, 1.75, 2]
  .map((value) => [String(value), `${value}x`]);
const SUB_SIZE_OPTIONS = [
  ['sm', '较小'],
  ['md', '标准'],
  ['lg', '较大'],
];
const SUB_ALPHA_OPTIONS = [
  ['0', '无底色'],
  ['0.42', '较浅'],
  ['0.68', '标准'],
  ['0.88', '较深'],
];
const HUD_MODE_OPTIONS = [
  ['auto', '自动（推荐）'],
  ['veil', '始终用临时遮罩'],
  ['off', '关闭屏蔽'],
];
const HUD_HIDE_OPTIONS = [
  ['1800', '1.8 秒'],
  ['3000', '3 秒'],
  ['5000', '5 秒'],
];
const THEME_OPTIONS = [
  ['auto', '跟随系统'],
  ['light', '浅色'],
  ['dark', '深色'],
];
const DEFAULT_SETTINGS = {
  hud_mode: 'auto',
  hud_blocker_enabled: true,
  hud_veil: true,
  hud_hide_ms: 3000,
  heatmap_enabled: true,
  remember_playback: true,
  subs_mode: 'zh',
  speed: 1,
  autoplay: false,
  skip_silence: false,
  sub_size: 'md',
  sub_alpha: 0.68,
  theme: 'auto',
};
const LATEST_BLOCKER_VERSION = '1.3.0';

export function emitSettingsChanged(key, value, origin = 'hud') {
  window.dispatchEvent(new CustomEvent(SETTINGS_EVENT, {
    detail: { key, value, origin },
  }));
}

export function emitBlockerState(detail) {
  window.dispatchEvent(new CustomEvent(BLOCKER_STATE_EVENT, {
    detail: {
      active: detail?.active === true,
      installed: detail?.installed === true,
      version: typeof detail?.version === 'string' ? detail.version : null,
    },
  }));
}

function boolPreference(key, fallback) {
  const value = store.get(key, fallback);
  return typeof value === 'boolean' ? value : fallback;
}

function choicePreference(key, allowed, fallback) {
  const value = String(store.get(key, fallback));
  return allowed.some((entry) => entry[0] === value) ? value : fallback;
}

function subtitleAlphaPreference() {
  const box = store.get('sub_box', null);
  const saved = store.get('sub_alpha', null);
  const value = saved !== null
    ? saved
    : box && typeof box === 'object' && !Array.isArray(box) ? box.alpha : 0.68;
  return SUB_ALPHA_OPTIONS.some((entry) => entry[0] === String(value))
    ? String(value)
    : '0.68';
}

function settingGroup(title, rows) {
  return el('section', { class: 'settings-group' },
    el('h3', { class: 'settings-group-title' }, title),
    ...rows,
  );
}

function settingRow(id, title, description, control) {
  return el('div', { class: 'settings-row' },
    el('div', { class: 'settings-copy' },
      el('label', { class: 'settings-label', for: id }, title),
      description ? el('p', {
        class: 'settings-desc',
        id: `${id}-desc`,
      }, description) : null,
    ),
    el('div', { class: 'settings-control' }, control),
  );
}

function toggleControl(id, checked, onChange) {
  return el('span', { class: 'settings-toggle' },
    el('input', {
      id,
      class: 'settings-toggle-input',
      type: 'checkbox',
      role: 'switch',
      checked,
      'aria-describedby': `${id}-desc`,
      on: { change: (event) => onChange(event.target.checked) },
    }),
    el('span', {
      class: 'settings-toggle-track',
      'aria-hidden': 'true',
    }),
  );
}

function selectControl(id, options, value, onChange) {
  return el('select', {
    id,
    class: 'settings-select',
    'aria-describedby': `${id}-desc`,
    on: { change: (event) => onChange(event.target.value) },
  }, ...options.map(([optionValue, label]) => el('option', {
    value: optionValue,
    selected: optionValue === value,
  }, label)));
}

function isOlderVersion(version) {
  if (!version) return true;
  const current = version.split('.').map(Number);
  const latest = LATEST_BLOCKER_VERSION.split('.').map(Number);
  for (let index = 0; index < latest.length; index += 1) {
    const left = current[index] || 0;
    if (left !== latest[index]) return left < latest[index];
  }
  return false;
}

export function createSettingsPanel({ trigger = null, onThemeChange = null } = {}) {
  let blockerActive = null;
  let blockerInstalled = false;
  let blockerVersion = null;
  let hudMode = choicePreference('hud_mode', HUD_MODE_OPTIONS, 'auto');
  let blockerEnabled = boolPreference('hud_blocker_enabled', true);
  let veilEnabled = boolPreference('hud_veil', true);

  const pluginStatus = el('span', { class: 'settings-status is-idle' }, '未检测到');
  const pluginAction = el('a', {
    class: 'settings-button is-primary',
    href: 'blocker.html',
    target: '_blank',
    rel: 'noopener',
  }, '安装插件');
  const pluginDescription = el('p', {
    class: 'settings-desc',
    id: 'settings-plugin-desc',
  }, '启动视频后自动检测；安装需要 Tampermonkey 等脚本管理器。');
  const protectionStatus = el('p', {
    class: 'settings-effective',
    role: 'status',
  });
  const hudModeSelect = selectControl(
    'settings-hud-mode',
    HUD_MODE_OPTIONS,
    hudMode,
    (value) => persist('hud_mode', value),
  );
  const hudHideSelect = selectControl(
    'settings-hud-hide-ms',
    HUD_HIDE_OPTIONS,
    choicePreference('hud_hide_ms', HUD_HIDE_OPTIONS, '3000'),
    (value) => persist('hud_hide_ms', Number(value)),
  );
  const heatmapToggleInput = toggleControl(
    'settings-heatmap-enabled',
    boolPreference('heatmap_enabled', true),
    (checked) => persist('heatmap_enabled', checked),
  ).querySelector('input');
  const pluginToggleInput = toggleControl(
    'settings-hud-blocker-enabled',
    blockerEnabled,
    (checked) => persist('hud_blocker_enabled', checked),
  ).querySelector('input');
  const veilToggleInput = toggleControl(
    'settings-hud-veil',
    veilEnabled,
    (checked) => persist('hud_veil', checked),
  ).querySelector('input');
  const bothOffWarning = el('p', {
    class: 'settings-warning',
    role: 'note',
  }, '当前没有生效的原生 HUD 屏蔽，可能显示 YouTube 标题、中央播放键、水印及链接。');
  const advancedDetails = el('details', { class: 'settings-advanced' },
    el('summary', {}, '高级：独立控制插件与遮罩'),
    settingRow(
      'settings-hud-blocker-enabled',
      '允许使用插件',
      '仅在自动模式下生效；新版插件支持站内启停。',
      pluginToggleInput.parentElement,
    ),
    settingRow(
      'settings-hud-veil',
      '允许内置临时遮罩',
      '仅在自动模式下生效；插件接管后遮罩自动待机。',
      veilToggleInput.parentElement,
    ),
  );

  const speedSelect = selectControl(
    'settings-speed',
    SPEED_OPTIONS,
    choicePreference('speed', SPEED_OPTIONS, '1'),
    (value) => persist('speed', Number(value)),
  );
  const rememberToggleInput = toggleControl(
    'settings-remember-playback',
    boolPreference('remember_playback', true),
    (checked) => persist('remember_playback', checked),
  ).querySelector('input');
  const autoplayToggleInput = toggleControl(
    'settings-autoplay',
    boolPreference('autoplay', false),
    (checked) => persist('autoplay', checked),
  ).querySelector('input');
  const skipSilenceToggleInput = toggleControl(
    'settings-skip-silence',
    boolPreference('skip_silence', false),
    (checked) => persist('skip_silence', checked),
  ).querySelector('input');

  const subtitleSelect = selectControl(
    'settings-subs-mode',
    SUBTITLE_OPTIONS,
    choicePreference('subs_mode', SUBTITLE_OPTIONS, 'zh'),
    (value) => persist('subs_mode', value),
  );
  const subSizeSelect = selectControl(
    'settings-sub-size',
    SUB_SIZE_OPTIONS,
    choicePreference('sub_size', SUB_SIZE_OPTIONS, 'md'),
    (value) => persist('sub_size', value),
  );
  const subAlphaSelect = selectControl(
    'settings-sub-alpha',
    SUB_ALPHA_OPTIONS,
    subtitleAlphaPreference(),
    (value) => persist('sub_alpha', Number(value)),
  );
  const themeSelect = selectControl(
    'settings-theme',
    THEME_OPTIONS,
    choicePreference('theme', THEME_OPTIONS, 'auto'),
    (value) => persist('theme', value),
  );

  const exportButton = el('button', {
    class: 'settings-button',
    type: 'button',
    on: { click: exportUserData },
  }, '导出备份');
  const importButton = el('button', {
    class: 'settings-button',
    type: 'button',
    on: {
      click: () => triggerImportUserData(({ settings }) => {
        applyPreferences(settings);
      }),
    },
  }, '导入恢复');
  const resetButton = el('button', {
    class: 'settings-reset',
    type: 'button',
    on: {
      click: () => {
        applyPreferences(DEFAULT_SETTINGS);
        toast('已恢复默认设置，个人数据未改动');
      },
    },
  }, '恢复默认设置');
  const closeButton = el('button', {
    class: 'settings-close',
    type: 'button',
    'aria-label': '关闭设置',
    autofocus: true,
    on: { click: () => dialog.close() },
  },
    el('span', { 'aria-hidden': 'true' }, '×'),
  );

  const dialog = el('dialog', {
    class: 'settings-dialog',
    'aria-labelledby': 'settings-title',
    closedby: 'any',
  },
    el('div', { class: 'settings-shell' },
      el('header', { class: 'settings-header' },
        el('div', {},
          el('h2', { class: 'settings-title', id: 'settings-title' }, '设置'),
          el('p', { class: 'settings-subtitle' }, '自动保存到当前浏览器'),
        ),
        closeButton,
      ),
      el('div', { class: 'settings-content' },
        settingGroup('播放器', [
          el('div', { class: 'settings-plugin-card' },
            el('div', { class: 'settings-plugin-head' },
              el('div', { class: 'settings-copy' },
                el('span', { class: 'settings-label' }, 'HUD 屏蔽插件'),
                pluginDescription,
              ),
              el('div', { class: 'settings-plugin-meta' }, pluginStatus, pluginAction),
            ),
            protectionStatus,
          ),
          settingRow(
            'settings-hud-mode',
            '原生 HUD 屏蔽',
            '自动模式优先使用插件，插件不可用时由内置遮罩接管。',
            hudModeSelect,
          ),
          settingRow(
            'settings-hud-hide-ms',
            '站内控制栏停留时间',
            '鼠标停止移动后自动隐藏；悬停控制栏时不会隐藏。',
            hudHideSelect,
          ),
          settingRow(
            'settings-heatmap-enabled',
            '内容热力',
            '在播放器下方显示语速密度、关键词和评论时间点。',
            heatmapToggleInput.parentElement,
          ),
          advancedDetails,
          bothOffWarning,
        ]),
        settingGroup('播放', [
          settingRow(
            'settings-speed',
            '默认播放速度',
            '打开新视频时使用的播放倍速。',
            speedSelect,
          ),
          settingRow(
            'settings-remember-playback',
            '将 HUD 调整保存为默认',
            '关闭后，控制栏和快捷键的倍速、字幕、连播与跳过空白调整只影响当前视频。',
            rememberToggleInput.parentElement,
          ),
          settingRow(
            'settings-autoplay',
            '自动连播',
            '播放结束后自动进入下一个推荐视频。',
            autoplayToggleInput.parentElement,
          ),
          settingRow(
            'settings-skip-silence',
            '跳过无语音片段',
            '自动略过较长的无台词停顿。',
            skipSilenceToggleInput.parentElement,
          ),
        ]),
        settingGroup('字幕', [
          settingRow(
            'settings-subs-mode',
            '默认字幕',
            '打开新视频时使用的字幕模式。',
            subtitleSelect,
          ),
          settingRow(
            'settings-sub-size',
            '字幕大小',
            '也可拖动字幕四角进行精细缩放。',
            subSizeSelect,
          ),
          settingRow(
            'settings-sub-alpha',
            '字幕底色',
            '调整字幕胶囊背景的明暗程度。',
            subAlphaSelect,
          ),
        ]),
        settingGroup('外观', [
          settingRow(
            'settings-theme',
            '主题',
            '“跟随系统”会随浏览器或系统的深浅色设置变化。',
            themeSelect,
          ),
        ]),
        settingGroup('数据', [
          el('p', { class: 'settings-desc settings-data-desc' },
            '备份包含收藏、浏览历史、播放进度、随手记和设置；导入会与现有数据合并，不会上传服务器。'),
          el('div', { class: 'settings-data-actions' }, exportButton, importButton),
        ]),
      ),
      el('footer', { class: 'settings-footer' }, resetButton),
    ),
  );

  function persist(key, value) {
    store.set(key, value);
    emitSettingsChanged(key, value, 'settings');
    if (key === 'theme') onThemeChange?.(value);
    syncControls();
  }

  function applyPreferences(preferences) {
    for (const [key, value] of Object.entries(preferences || {})) {
      if (!Object.hasOwn(DEFAULT_SETTINGS, key)) continue;
      store.set(key, value);
      emitSettingsChanged(key, value, 'settings');
      if (key === 'theme') onThemeChange?.(value);
    }
    syncControls();
  }

  function syncPlugin() {
    const supported = blockerInstalled && Boolean(blockerVersion);
    const automatic = hudMode === 'auto';
    pluginToggleInput.disabled = !supported || !automatic;
    pluginToggleInput.checked = blockerEnabled;
    veilToggleInput.disabled = !automatic;
    veilToggleInput.checked = veilEnabled;
    pluginStatus.classList.toggle('is-active', blockerInstalled && blockerActive === true);
    pluginStatus.classList.toggle('is-inactive', blockerInstalled && blockerActive === false);
    pluginStatus.classList.toggle('is-idle', !blockerInstalled);
    pluginStatus.textContent = !blockerInstalled
      ? '未检测到'
      : !blockerVersion
        ? '旧版插件'
        : blockerActive === true
          ? `已生效 · v${blockerVersion}`
          : `已停用 · v${blockerVersion}`;
    const needsUpdate = blockerInstalled && isOlderVersion(blockerVersion);
    pluginAction.textContent = !blockerInstalled
      ? '安装插件'
      : needsUpdate ? '更新插件' : '安装说明';
    pluginAction.href = needsUpdate
      ? './hackertube-hud-blocker.user.js'
      : 'blocker.html';
    pluginAction.classList.toggle('is-primary', !blockerInstalled || needsUpdate);
    pluginDescription.textContent = !blockerInstalled
      ? '启动视频后自动检测；安装需要 Tampermonkey 等脚本管理器。'
      : needsUpdate
        ? '更新后可使用版本识别和站内启停；安装页会由脚本管理器接管。'
        : '已识别插件，可在下方高级设置中调整自动模式的插件偏好。';
  }

  function syncProtection() {
    const automatic = hudMode === 'auto';
    const pluginInCharge = automatic && blockerEnabled && blockerActive === true;
    bothOffWarning.hidden = !(hudMode === 'off'
      || (automatic && !veilEnabled && (!blockerEnabled || blockerActive === false)));
    if (hudMode === 'off') {
      protectionStatus.textContent = '当前未屏蔽原生 HUD。';
    } else if (hudMode === 'veil') {
      protectionStatus.textContent = '当前使用内置临时遮罩，插件屏蔽已暂停。';
    } else if (pluginInCharge) {
      protectionStatus.textContent = '当前由插件屏蔽，内置临时遮罩已待机。';
    } else if (veilEnabled) {
      protectionStatus.textContent = blockerInstalled && !blockerEnabled
        ? '插件偏好已停用，当前由内置临时遮罩接管。'
        : '自动模式：优先插件，未生效时由内置临时遮罩兜底。';
    } else if (blockerEnabled) {
      protectionStatus.textContent = '等待插件生效；内置临时遮罩已关闭。';
    } else {
      protectionStatus.textContent = '当前未屏蔽原生 HUD。';
    }
    const veilDescription = dialog.querySelector('#settings-hud-veil-desc');
    if (veilDescription) {
      veilDescription.textContent = !automatic
        ? '切换到自动模式后可调整此偏好。'
        : pluginInCharge && veilEnabled
          ? '待机中：插件已接管原生 HUD 屏蔽。'
          : veilEnabled
            ? '插件未生效时接管；插件生效后自动待机。'
            : '已关闭；插件不可用时可能显示 YouTube 原生界面。';
    }
  }

  function syncControls() {
    hudMode = choicePreference('hud_mode', HUD_MODE_OPTIONS, 'auto');
    blockerEnabled = boolPreference('hud_blocker_enabled', true);
    veilEnabled = boolPreference('hud_veil', true);
    hudModeSelect.value = hudMode;
    hudHideSelect.value = choicePreference('hud_hide_ms', HUD_HIDE_OPTIONS, '3000');
    heatmapToggleInput.checked = boolPreference('heatmap_enabled', true);
    speedSelect.value = choicePreference('speed', SPEED_OPTIONS, '1');
    rememberToggleInput.checked = boolPreference('remember_playback', true);
    autoplayToggleInput.checked = boolPreference('autoplay', false);
    skipSilenceToggleInput.checked = boolPreference('skip_silence', false);
    subtitleSelect.value = choicePreference('subs_mode', SUBTITLE_OPTIONS, 'zh');
    subSizeSelect.value = choicePreference('sub_size', SUB_SIZE_OPTIONS, 'md');
    subAlphaSelect.value = subtitleAlphaPreference();
    themeSelect.value = choicePreference('theme', THEME_OPTIONS, 'auto');
    syncPlugin();
    syncProtection();
  }

  function syncFromPlayer(event) {
    const { key, value, origin } = event.detail || {};
    if (origin === 'settings') return;
    if (!boolPreference('remember_playback', true)) return;
    if (key === 'subs_mode') subtitleSelect.value = String(value);
    else if (key === 'speed') speedSelect.value = String(value);
    else if (key === 'autoplay') autoplayToggleInput.checked = value === true;
    else if (key === 'skip_silence') skipSilenceToggleInput.checked = value === true;
  }

  function syncBlocker(event) {
    const { active, installed, version } = event.detail || {};
    blockerActive = typeof active === 'boolean' ? active : null;
    blockerInstalled = installed === true;
    blockerVersion = version || null;
    syncPlugin();
    syncProtection();
  }

  window.addEventListener(SETTINGS_EVENT, syncFromPlayer);
  window.addEventListener(BLOCKER_STATE_EVENT, syncBlocker);
  window.addEventListener(SETTINGS_IMPORT_EVENT, (event) => {
    applyPreferences(event.detail);
  });

  dialog.addEventListener('close', () => {
    trigger?.setAttribute('aria-expanded', 'false');
  });

  if (!('closedBy' in HTMLDialogElement.prototype)) {
    const outside = (event) => {
      const rect = dialog.getBoundingClientRect();
      return event.clientX < rect.left
        || event.clientX > rect.right
        || event.clientY < rect.top
        || event.clientY > rect.bottom;
    };
    let pressedOutside = false;
    dialog.addEventListener('pointerdown', (event) => {
      pressedOutside = outside(event);
    });
    dialog.addEventListener('pointerup', (event) => {
      if (pressedOutside && outside(event)) dialog.close();
    });
  }

  document.body.append(dialog);
  syncControls();

  return {
    node: dialog,
    open() {
      if (dialog.open) return;
      syncControls();
      dialog.showModal();
      trigger?.setAttribute('aria-expanded', 'true');
    },
    close() {
      if (dialog.open) dialog.close();
    },
    toggle() {
      if (dialog.open) this.close();
      else this.open();
    },
    isOpen: () => dialog.open,
    syncTheme(value) {
      if (THEME_OPTIONS.some((entry) => entry[0] === value)) themeSelect.value = value;
    },
    notifyBlocker(detail) {
      emitBlockerState(detail);
    },
  };
}
