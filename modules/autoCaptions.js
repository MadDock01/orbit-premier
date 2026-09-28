/**
 * autoCaptions.js - Auto Captions module
 * Transcribes audio via Whisper and creates caption clips in Premiere.
 */

(function (global) {
  'use strict';
  if (global.__orbitAutoCaptionsLoaded) { return; }
  global.__orbitAutoCaptionsLoaded = true;

  // Use the unified PanelSwitcher utility if available, otherwise use fallback
  function switchToCaptionsPanel() {
    if (typeof global.PanelSwitcher === 'object' && typeof global.PanelSwitcher.switchTo === 'function') {
      return global.PanelSwitcher.switchTo('captions');
    }

    // Fallback to manual implementation if PanelSwitcher is not available
    // Try OrbitRailRouter first (preferred method)
    if (typeof global.OrbitRailRouter === 'object' && typeof global.OrbitRailRouter.open === 'function') {
      try {
        global.OrbitRailRouter.open('captions');
        return true;
      } catch (e) {
        console.warn('OrbitRailRouter.open failed:', e);
      }
    }

    // Try legacy _showService method
    if (typeof global._showService === 'function') {
      try {
        global._showService('auto-captions');
        return true;
      } catch (e) {
        console.warn('_showService failed:', e);
      }
    }

    // Manual DOM manipulation as last fallback
    try {
      var captionsView = document.getElementById('autoCaptionsView');
      var allViews = document.querySelectorAll('.orbit-view-panel');

      // Hide all views first
      for (var i = 0; i < allViews.length; i++) {
        allViews[i].style.display = 'none';
        allViews[i].classList.remove('orbit-route-active');
        allViews[i].classList.add('orbit-route-hidden');
        allViews[i].setAttribute('aria-hidden', 'true');
      }

      // Show captions view
      if (captionsView) {
        captionsView.style.display = 'block';
        captionsView.classList.add('orbit-route-active');
        captionsView.classList.remove('orbit-route-hidden');
        captionsView.setAttribute('aria-hidden', 'false');
      }

      // Update shelf buttons
      var shelves = document.querySelectorAll('.shelf');
      for (var j = 0; j < shelves.length; j++) {
        shelves[j].classList.toggle('active', shelves[j].getAttribute('data-type') === 'captions');
      }

      return true;
    } catch (e) {
      console.error('Manual panel switching failed:', e);
      return false;
    }
  }

  // ── State ──────────────────────────────────────────────────────────────────
  var generatedCaptions = [];   // grouped captions (normal mode)
  var originalCaptions  = [];   // Whisper's default grouping (before slider adjustments)
  var generatedWords    = [];   // per-word captions (word-by-word mode)
  var captionSeqStart   = 0;
  var captionSeqW       = 1920; // sequence dimensions at generation time
  var captionSeqH       = 1080;
  var selectedWord      = null; // { blockIdx, wordIdx }
  var textDirection     = localStorage.getItem('machicut_direction') || 'ltr';
  // Audio source captured at generation time. Persisted with the caption
  // blob so the per-caption editor popup can play the right slice on any
  // launch - we'd otherwise have to re-extract via ffmpeg every time the
  // panel reopens.
  var _captionWavPath   = '';
  var _captionClipMap   = null; // [{ concatStart, concatEnd, timelineStart }]
  var _captionSourceMeta = null; // { kind, name, cueCount, start, end }
  // Last successful styled Apply - enables "Apply this caption" without
  // rebuilding the whole Orbit nested sequence.
  var _lastStyledApply = null;
  var _styledApplyOpts = { onlyCaptionIndex: null };
  try {
    _lastStyledApply = JSON.parse(localStorage.getItem('orbit_last_styled_apply_v1') || 'null');
  } catch (_) { _lastStyledApply = null; }

  // Restore captions saved from a previous session
  (function restoreState() {
    try {
      var saved = localStorage.getItem('machicut_captions');
      if (saved) {
        var parsed = JSON.parse(saved);
        generatedCaptions = parsed.captions  || [];
        originalCaptions  = parsed.originals || [];
        generatedWords    = parsed.words     || [];
        captionSeqStart   = parsed.seqStart  || 0;
        _captionWavPath   = parsed.wavPath   || '';
        _captionClipMap   = parsed.clipMap   || null;
        _captionSourceMeta = parsed.source   || null;
        if (parsed.seqW && parsed.seqH) {
          captionSeqW = parsed.seqW;
          captionSeqH = parsed.seqH;
        } else if (generatedCaptions.length > 0) {
          // Old format - no seqW/seqH saved. Fetch from host now and persist.
          CEP.evalScript('getSequenceInfo', [], 5000).then(function (si) {
            try {
              if (si && si.width  && !si.error) captionSeqW = si.width;
              if (si && si.height && !si.error) captionSeqH = si.height;
              persistCaptions(); // re-save with seqW/seqH so next restore has it
            } catch (_) {}
          }).catch(function () {});
        }
      }
    } catch (_) {}
  }());

  // ── DOM refs ───────────────────────────────────────────────────────────────
  var trackSelectEl     = document.getElementById('ac-track-select');
  var refreshTracksBtn  = document.getElementById('ac-refresh-tracks'); // may be null
  var maxLinesSelectEl  = document.getElementById('ac-max-lines-select');
  var maxCharsInputEl   = document.getElementById('ac-max-chars-input');
  var langSelect        = document.getElementById('ac-language');
  var transcriptionModeSelect = document.getElementById('ac-transcription-mode');
  var localModelSelect         = document.getElementById('ac-local-model-select');
  var localTranslateToggle     = document.getElementById('ac-local-translate');
  var localModelRow            = document.getElementById('ac-local-model-row');
  var localOptionsRow          = document.getElementById('ac-local-options-row');
  var engineHint               = document.getElementById('ac-engine-hint');
  var maxCharsSlider    = document.getElementById('ac-max-chars');
  var maxLinesSlider    = document.getElementById('ac-max-lines');
  var gapSlider         = document.getElementById('ac-gap');
  var gapVal            = document.getElementById('ac-gap-val');
  var generateBtn       = document.getElementById('ac-generate-btn');
  var applySrtBtn       = document.getElementById('ac-apply-srt-btn');
  var placeEditableBtn  = document.getElementById('ac-place-editable-btn');
  // Keep applySrtBtn.* references valid even if the Edit-tab button is missing.
  if (!applySrtBtn) {
    applySrtBtn = document.createElement('button');
    applySrtBtn.id = 'ac-apply-srt-btn';
    applySrtBtn.style.display = 'none';
    applySrtBtn.disabled = true;
    document.body.appendChild(applySrtBtn);
  }
  var captionsPreview   = document.getElementById('captions-preview');
  var captionCount      = document.getElementById('ac-count');
  var progressWrap      = document.getElementById('ac-progress');
  var progressLabel     = document.getElementById('ac-progress-label');

  // Local AI dependency manager (gear button in the Generate popup).
  var depsOpenBtn       = document.getElementById('ac-deps-open');
  var depsPanel         = document.getElementById('ac-deps-panel');
  var depsRefreshBtn    = document.getElementById('ac-deps-refresh');
  var depsModelSelect   = document.getElementById('ac-deps-model');
  var depsInstallBtn    = document.getElementById('ac-deps-install');
  var depsFolderBtn     = document.getElementById('ac-deps-folder');
  var depsProgress      = document.getElementById('ac-deps-progress');
  var depsProgressLabel = document.getElementById('ac-deps-progress-label');
  var depsProgressPct   = document.getElementById('ac-deps-progress-percent');
  var depsProgressFill  = document.getElementById('ac-deps-progress-fill');
  var depsRoot          = document.getElementById('ac-deps-root');

  // Observable generation pipeline. This remains visible while work is active
  // so a long CPU transcription never looks like a frozen Generate button.
  var livePipeline      = document.getElementById('ac-live-pipeline');
  var liveCurrent       = document.getElementById('ac-live-current');
  var liveDetail        = document.getElementById('ac-live-detail');
  var liveElapsed       = document.getElementById('ac-live-elapsed');
  var liveProgressFill  = document.getElementById('ac-live-progress-fill');
  var _liveStageOrder   = ['track', 'ffmpeg', 'audio', 'whisper', 'captions'];
  var _liveStageIndex   = -1;
  var _liveStartedAt    = 0;
  var _liveTimer        = null;

  // Direction toggle - postgen bar only (popup auto-sets from language)
  // dir buttons removed - direction is now auto-detected from caption text

  // Popup refs
  var genPopup        = document.getElementById('ac-gen-popup');
  // Lift the popup out of #panel-auto-captions and attach it directly
  // to <body>. The panel itself is display:none whenever the user
  // isn't on the Auto-Captions service (e.g. they're on Home or
  // Settings), and a display:none parent removes its children from
  // the render tree - so leaving the popup nested makes it invisible
  // when opened from Home. Moving it to <body> lets it overlay any
  // page; we also flip its CSS to position: fixed so it covers the
  // viewport instead of just the (now-irrelevant) panel's area.
  if (genPopup && genPopup.parentNode !== document.body) {
    document.body.appendChild(genPopup);
  }
  var openGenPopupBtn = document.getElementById('ac-open-gen-popup');
  var popupCloseBtn   = document.getElementById('ac-popup-close');

  // Tracks whether a Modal warm ping is currently in flight. Stops the
  // popup from firing back-to-back warm requests if the user closes and
  // reopens it within seconds (which would queue a redundant cold-start
  // request on Modal).
  var _warmInflight = false;

  // Captions footer buttons
  var captionsGotoApplyBtn  = document.getElementById('ac-goto-apply-btn');
  var clearCaptionsBtnAlt   = document.getElementById('ac-clear-captions-btn'); // re-declared below for compat
  var exportCaptionsBtn     = document.getElementById('ac-export-captions-btn');
  var importCaptionsBtn     = document.getElementById('ac-import-captions-btn');
  var createChaptersBtn     = document.getElementById('ac-create-chapters-btn');
  var textEditBtn           = document.getElementById('ac-text-edit-btn');
  var cleanTextBtn          = document.getElementById('ac-clean-text-btn');
  var subtitleExportBar     = document.getElementById('ac-subtitle-export-bar');

  // Main postgen bar refs
  var maxLinesSelectMainEl = document.getElementById('ac-max-lines-select-main');
  var maxCharsInputMainEl  = document.getElementById('ac-max-chars-input-main');

  function _isLocalTranscription() {
    return !transcriptionModeSelect || transcriptionModeSelect.value !== 'cloud';
  }

  function _selectedLocalModel() {
    return localModelSelect ? localModelSelect.value : 'base';
  }

  function _shortDependencyPath(value) {
    var full = String(value || '');
    if (!full) return 'Not installed';
    var normalized = full.replace(/\\/g, '/');
    var parts = normalized.split('/');
    return parts.length > 4 ? '.../' + parts.slice(-4).join('/') : normalized;
  }

  function _setDependencyRow(name, item) {
    var dot = document.getElementById('ac-deps-' + name + '-dot');
    var state = document.getElementById('ac-deps-' + name + '-state');
    var pathEl = document.getElementById('ac-deps-' + name + '-path');
    var ready = !!(item && item.ready);
    if (dot) dot.classList.toggle('ready', ready);
    if (state) {
      state.textContent = ready ? 'Ready' : 'Missing';
      state.classList.toggle('ready', ready);
    }
    if (pathEl) {
      var fullPath = item && item.path ? item.path : '';
      pathEl.textContent = _shortDependencyPath(fullPath);
      pathEl.title = fullPath;
    }
  }

  function _renderDependencyStatus() {
    if (!depsPanel || !global.WhisperLocalAPI || !global.WhisperLocalAPI.getDependencyStatus) return null;
    var model = depsModelSelect ? depsModelSelect.value : _selectedLocalModel();
    var status = global.WhisperLocalAPI.getDependencyStatus(model);
    if (depsRoot) {
      depsRoot.textContent = status.root ? 'Install folder: ' + status.root : (status.reason || 'Local runtime unavailable');
      depsRoot.title = status.root || '';
    }
    if (!status.available || !status.runtime || !status.ffmpeg || !status.selectedModel) {
      _setDependencyRow('runtime', null);
      _setDependencyRow('ffmpeg', null);
      _setDependencyRow('model', null);
      if (depsInstallBtn) {
        depsInstallBtn.disabled = true;
        depsInstallBtn.textContent = status.reason || 'Unavailable on this computer';
      }
      return status;
    }
    _setDependencyRow('runtime', status.runtime);
    _setDependencyRow('ffmpeg', status.ffmpeg);
    _setDependencyRow('model', status.selectedModel);
    var modelName = document.getElementById('ac-deps-model-name');
    if (modelName) {
      var option = depsModelSelect && depsModelSelect.options[depsModelSelect.selectedIndex];
      modelName.textContent = option ? option.textContent.split(' - ')[0] + ' model' : model + ' model';
    }
    var allReady = status.runtime.ready && status.ffmpeg.ready && status.selectedModel.ready;
    if (depsInstallBtn && depsInstallBtn.getAttribute('data-busy') !== '1') {
      depsInstallBtn.disabled = allReady;
      depsInstallBtn.textContent = allReady
        ? 'Installed - ready'
        : 'Download missing files (' + Math.ceil(status.totalDownloadMB || 0) + ' MB)';
    }
    return status;
  }

  function _setDependencyProgress(label, percent) {
    var pct = Math.max(0, Math.min(100, Number(percent) || 0));
    if (depsProgress) depsProgress.classList.remove('hidden');
    if (depsProgressLabel) depsProgressLabel.textContent = label || 'Preparing...';
    if (depsProgressPct) depsProgressPct.textContent = Math.round(pct) + '%';
    if (depsProgressFill) depsProgressFill.style.width = pct + '%';
  }

  function _downloadSelectedDependencies() {
    if (!global.WhisperLocalAPI || !global.WhisperLocalAPI.ensureRuntime || !depsInstallBtn) return;
    var model = depsModelSelect ? depsModelSelect.value : _selectedLocalModel();
    depsInstallBtn.setAttribute('data-busy', '1');
    depsInstallBtn.disabled = true;
    depsInstallBtn.textContent = 'Downloading...';
    _setDependencyProgress('Checking required files...', 0);
    global.WhisperLocalAPI.ensureRuntime(model, function (progress) {
      _setDependencyProgress(progress && progress.label, progress && progress.percent);
    }).then(function () {
      _setDependencyProgress('All dependency files are ready.', 100);
      depsInstallBtn.removeAttribute('data-busy');
      _renderDependencyStatus();
      _updateEngineHint();
      setStatus('success', 'Local AI files are installed and ready.');
    }).catch(function (err) {
      var message = err && err.message ? err.message : String(err);
      _setDependencyProgress('Download failed: ' + message, 0);
      depsInstallBtn.removeAttribute('data-busy');
      depsInstallBtn.disabled = false;
      depsInstallBtn.textContent = 'Retry download';
      setStatus('error', 'Dependency download failed: ' + message);
    });
  }

  function _formatPipelineElapsed(seconds) {
    seconds = Math.max(0, Math.floor(seconds || 0));
    var minutes = Math.floor(seconds / 60);
    var remainder = seconds % 60;
    return (minutes < 10 ? '0' : '') + minutes + ':' + (remainder < 10 ? '0' : '') + remainder;
  }

  function _updatePipelineClock() {
    if (liveElapsed && _liveStartedAt) {
      liveElapsed.textContent = _formatPipelineElapsed((Date.now() - _liveStartedAt) / 1000);
    }
  }

  function _pipelineStart(detail) {
    if (!livePipeline) return;
    if (_liveTimer) clearInterval(_liveTimer);
    _liveStartedAt = Date.now();
    _liveStageIndex = -1;
    livePipeline.classList.remove('hidden', 'success', 'failed');
    var stages = livePipeline.querySelectorAll('[data-ac-stage]');
    for (var i = 0; i < stages.length; i++) stages[i].classList.remove('active', 'done', 'failed');
    if (liveProgressFill) liveProgressFill.style.width = '0%';
    if (liveElapsed) liveElapsed.textContent = '00:00';
    _liveTimer = setInterval(_updatePipelineClock, 1000);
    _pipelineStage('track', 'Reading Premiere track', detail || 'Waiting for the selected audio track...');
  }

  function _pipelineStage(stage, title, detail, percent) {
    if (!livePipeline) return;
    livePipeline.classList.remove('hidden', 'success', 'failed');
    var nextIndex = _liveStageOrder.indexOf(stage);
    if (nextIndex < 0) nextIndex = _liveStageIndex;
    _liveStageIndex = Math.max(_liveStageIndex, nextIndex);
    var stages = livePipeline.querySelectorAll('[data-ac-stage]');
    for (var i = 0; i < stages.length; i++) {
      var index = _liveStageOrder.indexOf(stages[i].getAttribute('data-ac-stage'));
      stages[i].classList.toggle('done', index < _liveStageIndex);
      stages[i].classList.toggle('active', index === _liveStageIndex);
      stages[i].classList.remove('failed');
    }
    if (liveCurrent) liveCurrent.textContent = title || 'Working...';
    if (liveDetail && detail) {
      liveDetail.textContent = detail;
      liveDetail.title = detail;
    }
    var defaults = [8, 22, 42, 72, 92];
    var value = typeof percent === 'number' ? percent : defaults[Math.max(0, _liveStageIndex)];
    if (liveProgressFill) liveProgressFill.style.width = Math.max(0, Math.min(98, value)) + '%';
  }

  function _pipelineProgressDetail(detail) {
    if (liveDetail && detail) {
      liveDetail.textContent = detail;
      liveDetail.title = detail;
    }
  }

  function _pipelineFinish(success, title, detail) {
    if (!livePipeline) return;
    if (_liveTimer) clearInterval(_liveTimer);
    _liveTimer = null;
    _updatePipelineClock();
    _liveStartedAt = 0;
    livePipeline.classList.toggle('success', !!success);
    livePipeline.classList.toggle('failed', !success);
    var stages = livePipeline.querySelectorAll('[data-ac-stage]');
    for (var i = 0; i < stages.length; i++) {
      stages[i].classList.remove('active', 'failed');
      if (success) stages[i].classList.add('done');
    }
    if (!success && _liveStageIndex >= 0 && stages[_liveStageIndex]) {
      stages[_liveStageIndex].classList.remove('done');
      stages[_liveStageIndex].classList.add('failed');
    }
    if (liveCurrent) liveCurrent.textContent = title || (success ? 'Captions ready' : 'Generation stopped');
    if (liveDetail) liveDetail.textContent = detail || '';
    if (success && liveProgressFill) liveProgressFill.style.width = '100%';
  }

  function _pipelineReset() {
    if (!livePipeline || _liveStartedAt) return;
    livePipeline.classList.add('hidden');
    livePipeline.classList.remove('success', 'failed');
  }

  function _updateEngineHint() {
    if (!engineHint) return;
    if (!_isLocalTranscription()) {
      engineHint.textContent = 'Cloud uses your signed-in transcription quota and is usually faster.';
      return;
    }
    if (!global.WhisperLocalAPI || !global.WhisperLocalAPI.getStatus) {
      engineHint.textContent = 'Local Whisper is unavailable. Use Cloud mode.';
      return;
    }
    var status = global.WhisperLocalAPI.getStatus(_selectedLocalModel());
    if (!status.available) {
      engineHint.textContent = status.reason || 'Local Whisper is unavailable.';
      return;
    }
    var banglaNote = langSelect && langSelect.value === 'bn' && _selectedLocalModel() !== 'large-v3'
      ? ' Bangla works best with Large v3.' : '';
    engineHint.textContent = status.installed
      ? 'Installed locally - private and no per-minute AI charge.' + banglaNote
      : 'One-time download: about ' + Math.ceil(status.downloadMB || 0) + ' MB. No per-minute AI charge.' + banglaNote;
  }

  function _syncTranscriptionModeUI() {
    var local = _isLocalTranscription();
    if (localModelRow) localModelRow.style.display = local ? '' : 'none';
    if (localOptionsRow) localOptionsRow.style.display = local ? '' : 'none';
    var usage = document.getElementById('ac-popup-usage');
    var upgrade = document.getElementById('ac-popup-upgrade');
    var limit = document.getElementById('ac-popup-limit-banner');
    if (local) {
      if (usage) usage.classList.add('hidden');
      if (upgrade) upgrade.classList.add('hidden');
      if (limit) limit.classList.add('hidden');
      if (generateBtn && _popupViewMode !== 'preview') generateBtn.disabled = false;
    } else {
      _preflightUsage();
    }
    try { localStorage.setItem('orbit_caption_engine', local ? 'local' : 'cloud'); } catch (_) {}
    _updateEngineHint();
  }

  if (transcriptionModeSelect) {
    try {
      var savedEngine = localStorage.getItem('orbit_caption_engine');
      var localSupported = false;
      try {
        localSupported = !!(global.WhisperLocalAPI && global.WhisperLocalAPI.getStatus &&
          global.WhisperLocalAPI.getStatus(_selectedLocalModel()).available);
      } catch (_) {}
      // Local Whisper currently ships a Windows-only runtime. Never leave a
      // Mac on the unsupported default; Cloud is the working cross-platform
      // engine and still uses the same FFmpeg audio preparation pipeline.
      transcriptionModeSelect.value = (savedEngine === 'cloud' || !localSupported) ? 'cloud' : 'local';
    } catch (_) {}
    transcriptionModeSelect.addEventListener('change', _syncTranscriptionModeUI);
  }
  if (localModelSelect) {
    try {
      var savedLocalModel = localStorage.getItem('orbit_local_whisper_model');
      if (savedLocalModel && localModelSelect.querySelector('option[value="' + savedLocalModel + '"]')) {
        localModelSelect.value = savedLocalModel;
      }
    } catch (_) {}
    localModelSelect.addEventListener('change', function () {
      try { localStorage.setItem('orbit_local_whisper_model', localModelSelect.value); } catch (_) {}
      if (depsModelSelect && depsModelSelect.querySelector('option[value="' + localModelSelect.value + '"]')) {
        depsModelSelect.value = localModelSelect.value;
      }
      _updateEngineHint();
      _renderDependencyStatus();
    });
  }
  if (localTranslateToggle) {
    try { localTranslateToggle.checked = localStorage.getItem('orbit_local_translate') === '1'; } catch (_) {}
    localTranslateToggle.addEventListener('change', function () {
      try { localStorage.setItem('orbit_local_translate', localTranslateToggle.checked ? '1' : '0'); } catch (_) {}
    });
  }
  if (langSelect) langSelect.addEventListener('change', _updateEngineHint);

  if (depsModelSelect) {
    if (depsModelSelect.querySelector('option[value="' + _selectedLocalModel() + '"]')) {
      depsModelSelect.value = _selectedLocalModel();
    }
    depsModelSelect.addEventListener('change', function () {
      if (localModelSelect && localModelSelect.querySelector('option[value="' + depsModelSelect.value + '"]')) {
        localModelSelect.value = depsModelSelect.value;
      }
      try { localStorage.setItem('orbit_local_whisper_model', depsModelSelect.value); } catch (_) {}
      _updateEngineHint();
      _renderDependencyStatus();
    });
  }
  if (depsOpenBtn) {
    depsOpenBtn.addEventListener('click', function () {
      if (!depsPanel) return;
      var opening = depsPanel.classList.contains('hidden');
      depsPanel.classList.toggle('hidden', !opening);
      depsOpenBtn.classList.toggle('active', opening);
      if (opening) {
        if (depsModelSelect && localModelSelect) depsModelSelect.value = localModelSelect.value;
        _renderDependencyStatus();
      }
    });
  }
  if (depsRefreshBtn) depsRefreshBtn.addEventListener('click', _renderDependencyStatus);
  if (depsInstallBtn) depsInstallBtn.addEventListener('click', _downloadSelectedDependencies);
  if (depsFolderBtn) {
    depsFolderBtn.addEventListener('click', function () {
      try {
        if (!global.WhisperLocalAPI || !global.WhisperLocalAPI.openRuntimeFolder ||
            !global.WhisperLocalAPI.openRuntimeFolder()) {
          throw new Error('The local AI folder is unavailable on this computer.');
        }
      } catch (err) {
        setStatus('error', err && err.message ? err.message : String(err));
      }
    });
  }

  _syncTranscriptionModeUI();
  // ── Popup helpers ──────────────────────────────────────────────────────────
  var _popupTplPicked = false; // true when user picks a template inside the gen popup
  var _popupTplIntervals = []; // separate from strip intervals

  function _renderPopupTplGrid() {
    var grid = document.getElementById('ac-gen-popup-tpl-grid');
    if (!grid) return;
    _popupTplIntervals.forEach(function(id) { clearInterval(id); });
    _popupTplIntervals = [];
    grid.innerHTML = '';
    // Match Style strip: drop soft-deleted bundled templates and templates
    // whose language the user has hidden in Settings.
    var templates = _m4LoadTemplates().filter(function(t) {
      return !t.hidden && _m4TplLangAllowed(t);
    });
    if (!templates.length) {
      var hint = document.createElement('span');
      hint.className = 'gen-popup-tpl-empty';
      hint.textContent = 'No styles saved yet - create one in the Editor.';
      grid.appendChild(hint);
      return;
    }
    function _pickPopupTpl(t, card) {
      grid.querySelectorAll('.m4-tpl-card').forEach(function(c) { c.classList.remove('active'); });
      card.classList.add('active');
      _popupTplPicked = true;
      _m4ActiveTplId = t.id;
      try { localStorage.setItem('ae_m4_active_tpl', t.id); } catch (_) {}
      _m4SavingFromTpl = true;
      _m4ApplySettings(t.settings);
      _m4FontPickerSetValue(t.settings.fontFamily || M4_DEFAULTS.fontFamily);
      _m4SyncPickrColors();
      _m4StartPreview();
      _m4SaveSettings();
      _m4SavingFromTpl = false;
      // Sync active state on Apply page strip without re-rendering (avoids loop)
      if (_m4TplStrip) _m4TplStrip.querySelectorAll('.m4-tpl-card').forEach(function(c) {
        c.classList.toggle('active', c.dataset.tplId === t.id);
      });
    }

    // If the user already has an active template that's still visible,
    // highlight it instead of force-picking template[0] - picking would
    // overwrite their current settings on every popup open.
    var hasActive = templates.some(function(t) { return t.id === _m4ActiveTplId; });

    templates.forEach(function(t, idx) {
      var card = document.createElement('div');
      card.className = 'm4-tpl-card';
      card.dataset.tplId = t.id;
      var cv = document.createElement('canvas');
      cv.width = 160; cv.height = 79;
      card.appendChild(cv);
      card.addEventListener('click', function() { _pickPopupTpl(t, card); });
      grid.appendChild(card);
      // Animate
      var _fi = 0;
      var _iv = setInterval(function() { _m4DrawTplFrame(cv, t.settings, _fi++); }, 500);
      _popupTplIntervals.push(_iv);
      _m4DrawTplFrame(cv, t.settings, 0);

      if (hasActive) {
        // Visual highlight only - don't reapply settings or flip picked flag.
        if (t.id === _m4ActiveTplId) {
          card.classList.add('active');
          _popupTplPicked = true; // existing choice counts as picked
        }
      } else if (idx === 0) {
        // No prior choice -> fall back to template[0] (applies its settings).
        _pickPopupTpl(t, card);
      }
    });
  }

  var _popupMode = 'home'; // 'home' | 'regen'
  var _tplSection = document.querySelector('.gen-popup-tpl-section');

  // Live usage preflight - runs on every popup open. Fetches the
  // signed-in user's month/day consumption via get_my_usage and drives
  // the usage meter (and, at 100%, the limit banner + disabled
  // Generate). On any failure (offline, RPC down) we stay silent and
  // let Modal enforce on the actual transcribe POST.
  function _preflightUsage() {
    if (!global.AuthAPI || !global.AuthAPI.getAccessToken) return;
    if (!global.SupabaseAPI || !global.SupabaseAPI.getCaptionStatus) return;

    var dev = '';
    try { if (global.FFmpegAPI && FFmpegAPI.getDeviceId) dev = FFmpegAPI.getDeviceId(); } catch (_) {}

    global.AuthAPI.getAccessToken().then(function (authToken) {
      if (!authToken) { _renderSignedOutMeter(); return null; }
      return global.SupabaseAPI.getCaptionStatus(authToken, dev);
    }).then(function (s) {
      if (!s) return;
      _renderUsage(s.used, s.limit, s.tier);
    }).catch(function () { /* silent - Modal will catch it server-side */ });
  }

  // Signed-out state in the popup: no meter numbers, just a nudge that
  // AI captions need sign-in and come with free minutes. (Silence
  // cutting + manual captions don't hit this path at all.)
  function _renderSignedOutMeter() {
    var wrap = document.getElementById('ac-popup-usage');
    var fill = document.getElementById('ac-popup-usage-fill');
    var text = document.getElementById('ac-popup-usage-text');
    if (!wrap || !fill || !text) return;
    wrap.classList.remove('hidden');
    fill.style.width = '0%';
    fill.className = 'gen-popup-usage-fill';
    text.textContent = 'Sign in to use AI captions - 10 minutes free.';
  }

  // Open the subscribe/checkout flow in the browser. Pricing section on
  // the public site is the lowest-friction path; the buyer's email is
  // prefilled by checkout when they're signed into the site.
  function _openCheckout() {
    var url = 'https://machicut.store/#pricing';
    if (window.UX) UX.track('checkout_opened', {});
    try {
      if (typeof window.openExternal === 'function') { window.openExternal(url); return; }
      var _r = (typeof require !== 'undefined') ? require : (window.require || null);
      if (_r) {
        var cp = _r('child_process');
        if (process.platform === 'darwin') cp.spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
        else if (process.platform === 'win32') cp.spawn('cmd', ['/c', 'start', '""', url], { detached: true, stdio: 'ignore' }).unref();
        else cp.spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
      }
    } catch (_) {}
  }

  // Reveal the free-exhausted upgrade card in the popup and lock Generate.
  function _showUpgradeCard() {
    var card = document.getElementById('ac-popup-upgrade');
    if (card) card.classList.remove('hidden');
    if (_popupViewMode !== 'preview' && generateBtn) generateBtn.disabled = true;
    if (window.UX) UX.track('upgrade_shown', { where: 'generate_popup' });
  }
  (function _wireUpgradeButton() {
    var btn = document.getElementById('ac-popup-upgrade-btn');
    if (btn) btn.addEventListener('click', function () {
      if (window.UX) UX.track('upgrade_click', { from: 'popup_card' });
      _openCheckout();
    });
  })();

  // Drive the monthly usage meter + gate Generate at 100%.
  //
  // Always visible (was: hidden <50% - flipped per user preference so
  // the allowance is discoverable from day one). Color ladder:
  //   < 80%  - blue
  //   ≥ 80%  - amber
  //   ≥ 100% - red, Generate disabled, limit banner explains reset
  function _renderUsage(used, limit, tier) {
    var wrap = document.getElementById('ac-popup-usage');
    var fill = document.getElementById('ac-popup-usage-fill');
    var text = document.getElementById('ac-popup-usage-text');
    if (!wrap || !fill || !text || !(limit > 0)) return;

    used = Math.max(0, Number(used) || 0);
    var frac = used / limit;

    wrap.classList.remove('hidden');
    fill.style.width = Math.min(100, frac * 100) + '%';
    fill.className = 'gen-popup-usage-fill' +
      (frac >= 1 ? ' is-full' : frac >= 0.8 ? ' is-warn' : '');

    if (tier === 'free') {
      // One-time free allowance - show remaining + an upgrade link.
      var remain = Math.max(0, limit - used);
      text.innerHTML = 'Free  -  ' + (remain < 1 ? remain.toFixed(1) : Math.round(remain)) +
                       ' of ' + Math.round(limit) + ' min left ' +
                       '<a href="#" id="ac-usage-upgrade" class="ac-usage-upgrade">Upgrade</a>';
      var up = document.getElementById('ac-usage-upgrade');
      if (up) up.addEventListener('click', function (e) { e.preventDefault(); if (window.UX) UX.track('upgrade_click', { from: 'meter_link' }); _openCheckout(); });
      if (frac >= 1) _showUpgradeCard();
    } else {
      text.textContent = Math.round(used) + ' of ' + Math.round(limit) +
                         ' min used this month';
      if (frac >= 1) {
        _showLimitBanner('Monthly limit reached (' + Math.round(limit) +
                         ' min). Resets on the 1st.');
      }
    }
  }

  // Fill + reveal the limit banner and disable Generate (unless the
  // popup is in preview mode, where the button is "Apply" and reuses
  // existing captions without touching quota).
  function _showLimitBanner(msg) {
    var banner = document.getElementById('ac-popup-limit-banner');
    var bMsg   = document.getElementById('ac-popup-limit-msg');
    if (!banner || !bMsg) return;
    bMsg.textContent = msg;
    banner.classList.remove('hidden');
    if (_popupViewMode !== 'preview' && generateBtn) generateBtn.disabled = true;
  }

  // Copy the action-bar Position values INTO the popup inputs, and
  // vice versa. The action bar (ac-bar-pos-x / ac-bar-pos-y) is the
  // single source of truth - its 'change' listener fans the value
  // out to the hidden m4-pos-x/y inputs, localStorage, and the live
  // preview. The popup inputs are just a second surface that reads
  // from / writes to the bar.
  function _popupPosLoadFromBar() {
    var pX = document.getElementById('ac-popup-pos-x');
    var pY = document.getElementById('ac-popup-pos-y');
    var bX = document.getElementById('ac-bar-pos-x');
    var bY = document.getElementById('ac-bar-pos-y');
    if (pX && bX) pX.value = bX.value;
    if (pY && bY) pY.value = bY.value;
  }
  function _popupPosCommitToBar() {
    var pX = document.getElementById('ac-popup-pos-x');
    var pY = document.getElementById('ac-popup-pos-y');
    var bX = document.getElementById('ac-bar-pos-x');
    var bY = document.getElementById('ac-bar-pos-y');
    if (!bX || !bY) return;
    function _clamp(v) {
      v = parseInt(v, 10);
      if (isNaN(v)) return 50;
      return Math.max(0, Math.min(100, v));
    }
    if (pX) bX.value = _clamp(pX.value);
    if (pY) bY.value = _clamp(pY.value);
    // Dispatch the bar's existing change handler - it owns the
    // cascade into the hidden m4-pos-x/y inputs, localStorage, and
    // the preview redraw. Doing it that way means there's still
    // exactly one place that knows how to fan a position change out.
    bX.dispatchEvent(new Event('change', { bubbles: true }));
    bY.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function openPopup(mode) {
    if (!genPopup) return;
    _popupMode = mode || 'home';
    _popupTplPicked = false;
    // Sync popup Position inputs with whatever the action bar
    // currently shows, so opening the popup never silently disagrees
    // with the bar's value.
    _popupPosLoadFromBar();
    // Reset any stale limit banner + upgrade card + re-enable Generate.
    var _limitBanner = document.getElementById('ac-popup-limit-banner');
    if (_limitBanner) _limitBanner.classList.add('hidden');
    var _upgradeCard = document.getElementById('ac-popup-upgrade');
    if (_upgradeCard) _upgradeCard.classList.add('hidden');
    if (generateBtn) generateBtn.disabled = false;
    genPopup.classList.remove('hidden');
    _pipelineReset();
    if (depsPanel && !depsPanel.classList.contains('hidden')) _renderDependencyStatus();
    _syncTranscriptionModeUI();
    // Template grid is rendered for any view that includes it; the
    // actual visibility (preview + generate vs hidden in regenerate)
    // is owned by _setPopupViewMode below.
    _renderPopupTplGrid();
    // Pre-fill with numbered defaults immediately - no evalScript on open.
    // User can refresh with the button. This keeps CEP queue free for Generate.
    if (trackSelectEl) {
      var hasRealTracks = trackSelectEl.options.length > 0 &&
                          trackSelectEl.options[0].value !== '';
      if (!hasRealTracks) {
        trackSelectEl.innerHTML =
          '<option value="audio:0">A1</option>' +
          '<option value="audio:1">A2</option>' +
          '<option value="audio:2">A3</option>';
      }
    }
    // Replace numbered placeholders with the real Premiere audio tracks.
    // This used to happen only from a refresh button that is no longer in the
    // markup, leaving Generate permanently pointed at guessed A1/A2/A3 values.
    loadTrackList();
    _refreshExistingBanner();

    // Wake the Modal transcription container in the background. The 5-15s
    // the user spends filling out the form overlaps with Modal's cold
    // start (~12-40s), so by the time they hit "Generate" the GPU is
    // usually warm. Fire-and-forget - the real transcribe POST surfaces
    // any errors that matter; we don't block the popup or show UI here.
    if (!_isLocalTranscription() && !_warmInflight) {
      _warmInflight = true;
      FFmpegAPI.warmServer()
        .catch(function () { /* silent; transcribe POST will surface real errors */ })
        .then(function () { _warmInflight = false; });
    }
  }

  // ── Generate-popup view state ─────────────────────────────────────────
  // Four modes inside the popup. The first three are entered from Home
  // Quick Generate (full "transcribe + apply" pipeline, templates matter).
  // The fourth is entered from the Edit-tab Regenerate button - just a
  // re-transcribe that keeps the existing template style untouched.
  //
  //   'preview'         - captions exist, opened from Home. Shows the
  //                       preview card + templates. Bottom button reads
  //                       "Apply" -> applies current captions with the
  //                       currently picked template (no re-transcription).
  //   'generate'        - no captions yet, opened from Home. Fresh
  //                       transcription with all settings: form + Place
  //                       on track + Position + templates. Bottom
  //                       button reads "Generate Captions".
  //   'regenerate-home' - user clicked Regenerate from inside the
  //                       preview card. Wants a fresh transcription but
  //                       on top of existing captions, so home-only
  //                       fields (track / position) are hidden - they
  //                       stay where they were. Templates remain
  //                       visible. Bottom button reads "Regenerate
  //                       Captions".
  //   'regenerate-edit' - Edit-tab Regenerate button. Just re-transcribes;
  //                       the user is already in the editor with a
  //                       style they've chosen. Form only, no templates,
  //                       no home-only fields. Bottom button reads
  //                       "Regenerate".
  var _popupViewMode = 'generate';

  function _setPopupViewMode(mode) {
    _popupViewMode = mode;
    var previewCard = document.getElementById('ac-popup-preview-card');
    var formWrap    = document.getElementById('ac-popup-form');
    var tplSection  = document.getElementById('ac-popup-tpl-section');
    var labelEl     = generateBtn ? generateBtn.querySelector('.ac-generate-btn-label') : null;

    var showPreview   = (mode === 'preview');
    var showForm      = (mode === 'generate' || mode === 'regenerate-home' || mode === 'regenerate-edit');
    var showTemplates = (mode === 'preview'  || mode === 'generate' || mode === 'regenerate-home');
    var showHomeOnly  = (mode === 'generate');

    if (previewCard) previewCard.style.display = showPreview ? '' : 'none';
    if (formWrap)    formWrap.style.display    = showForm    ? '' : 'none';
    if (tplSection)  tplSection.style.display  = showTemplates ? '' : 'none';
    genPopup.querySelectorAll('.gen-popup-home-only').forEach(function (el) {
      el.style.display = showHomeOnly ? '' : 'none';
    });
    // regenerate-edit is "just re-transcribe" - the user is already in the
    // editor with positioning decided, so Place on + Position aren't
    // actionable in that flow. Hide them there but keep them in every
    // other form mode.
    var hideForEdit = (mode === 'regenerate-edit');
    genPopup.querySelectorAll('.gen-popup-edit-hidden').forEach(function (el) {
      el.style.display = hideForEdit ? 'none' : '';
    });

    if (labelEl) {
      labelEl.textContent =
          (mode === 'preview')         ? 'Apply'
        : (mode === 'generate')        ? 'Generate Captions'
        : (mode === 'regenerate-home') ? 'Regenerate Captions'
        :                                'Regenerate';
    }

    // The button switches role on every mode flip. preview = Apply (no
    // quota), everything else transcribes. If the limit banner is up,
    // disable the button only for the quota-spending modes; otherwise
    // restore it (so a flip back to preview re-enables Apply).
    var limitBanner = document.getElementById('ac-popup-limit-banner');
    var bannerShown = limitBanner && !limitBanner.classList.contains('hidden');
    if (generateBtn) {
      generateBtn.disabled = bannerShown && mode !== 'preview';
    }
  }

  // Build a single flat paragraph from the existing captions for the
  // preview card. CSS handles the 3-line clamp + fade - we just need
  // the raw text. Strips newlines so it reads as continuous prose.
  function _buildPreviewText() {
    if (!generatedCaptions.length) return '';
    return generatedCaptions
      .map(function (c) { return (c.text || '').replace(/\s+/g, ' ').trim(); })
      .filter(Boolean)
      .join(' ');
  }

  // Picks the right popup mode based on the entry point + caption state.
  // Called from openPopup() and after any external mutation (caption
  // edits, regen completion) via window._refreshAcExistingBanner.
  //
  //   _popupMode = 'home' + captions exist -> preview (user landed on Home
  //                                          and may not have seen the
  //                                          current captions - show them)
  //   _popupMode = 'home' + no captions    -> generate (fresh transcription)
  //   _popupMode = 'regen'                 -> regenerate (Edit-tab button:
  //                                          user is already in the editor,
  //                                          knows what they have, wants
  //                                          to re-transcribe directly)
  function _refreshExistingBanner() {
    var previewCard = document.getElementById('ac-popup-preview-card');
    var countEl     = document.getElementById('ac-popup-existing-count');
    var textEl      = document.getElementById('ac-popup-preview-text');
    var moreBtn     = document.getElementById('ac-popup-preview-more');
    var n           = generatedCaptions.length;

    if (!previewCard) return;

    // Edit-tab Regenerate button always goes to the settings-only view
    // (no preview card, no templates - user knows what they have).
    if (_popupMode === 'regen') {
      _setPopupViewMode('regenerate-edit');
      return;
    }

    // Home Quick Generate: branch on whether captions already exist.
    if (n === 0) {
      _setPopupViewMode('generate');
      return;
    }
    if (countEl) countEl.textContent = String(n);
    if (textEl)  textEl.textContent  = _buildPreviewText();
    // Reset the show-more toggle to the collapsed state each refresh.
    previewCard.classList.remove('expanded');
    if (moreBtn) {
      var lbl = moreBtn.querySelector('.ac-preview-more-label');
      if (lbl) lbl.textContent = 'Show more';
    }
    _setPopupViewMode('preview');
  }
  // Re-export for external callers (e.g. after caption edits)
  window._refreshAcExistingBanner = _refreshExistingBanner;
  window._openAcPopup = openPopup;
  function closePopup() {
    if (genPopup) genPopup.classList.add('hidden');
    _popupTplIntervals.forEach(function(id) { clearInterval(id); });
    _popupTplIntervals = [];
  }
  function updatePostgenBar() {
    var bar = document.getElementById('ac-postgen-bar');
    if (bar) bar.classList.toggle('disabled', generatedCaptions.length === 0);
  }
  function _updateCaptionsFooter() {
    var hasCaption = generatedCaptions.length > 0;
    if (openGenPopupBtn) openGenPopupBtn.textContent = hasCaption ? '\u25B6 Regenerate' : '\u25B6 Generate';
    if (captionsGotoApplyBtn) captionsGotoApplyBtn.disabled = !hasCaption;
    if (applySrtBtn) applySrtBtn.disabled = !hasCaption;
    if (placeEditableBtn) placeEditableBtn.disabled = !hasCaption;
    if (clearCaptionsBtnAlt)  clearCaptionsBtnAlt.disabled  = !hasCaption;
    if (exportCaptionsBtn)    exportCaptionsBtn.disabled    = !hasCaption;
  }

  function setDirection(dir) {
    textDirection = dir;
    localStorage.setItem('machicut_direction', dir);
    if (generatedCaptions.length > 0) renderCaptionList(generatedCaptions);
  }

  // Auto-detect direction from caption text content
  function _autoDetectDirection() {
    if (!generatedCaptions.length) return;
    var sample = generatedCaptions.slice(0, 5).map(function(c) { return c.text || ''; }).join(' ');
    setDirection(/[֑-߿יִ-﷽ﹰ-ﻼ]/.test(sample) ? 'rtl' : 'ltr');
  }

  // Init: auto-detect from restored captions, or default ltr
  if (generatedCaptions.length > 0) _autoDetectDirection(); else setDirection(textDirection);

  // ── Popup open / close wiring ──────────────────────────────────────────────
  if (openGenPopupBtn) openGenPopupBtn.addEventListener('click', function() { openPopup('regen'); });
  if (popupCloseBtn)   popupCloseBtn.addEventListener('click', closePopup);

  // ── Preview-card buttons ────────────────────────────────────────────────
  // Open editor: close popup, ensure user is on the Edit captions tab so
  // they can see the captions list (and the per-row edit pencil opens the
  // detailed timeline editor for any specific caption).
  var openEditorBtn = document.getElementById('ac-popup-open-editor');
  if (openEditorBtn) {
    openEditorBtn.addEventListener('click', function () {
      closePopup();
      switchAcTab('captions');
    });
  }
  // Regenerate (from preview): flip to the home-regenerate view -
  // settings form + templates, no preview card. Home-only fields
  // (Place on / Position) stay hidden since we're replacing in place,
  // not creating fresh. Templates remain so the user can swap style
  // as part of the same "transcribe + apply" pipeline.
  var regenFromPreviewBtn = document.getElementById('ac-popup-regenerate-from-preview');
  if (regenFromPreviewBtn) {
    regenFromPreviewBtn.addEventListener('click', function () {
      _setPopupViewMode('regenerate-home');
    });
  }
  // Show more / Show less toggle on the preview text.
  var previewMoreBtn = document.getElementById('ac-popup-preview-more');
  if (previewMoreBtn) {
    previewMoreBtn.addEventListener('click', function () {
      var card = document.getElementById('ac-popup-preview-card');
      if (!card) return;
      var expanded = card.classList.toggle('expanded');
      var lbl = previewMoreBtn.querySelector('.ac-preview-more-label');
      if (lbl) lbl.textContent = expanded ? 'Show less' : 'Show more';
    });
  }

  // Footer: Apply -> switch to Apply tab
  if (captionsGotoApplyBtn) {
    captionsGotoApplyBtn.addEventListener('click', function () {
      var applyTab = document.querySelector('.ac-sub-tab[data-ac-tab="apply"]');
      if (applyTab) applyTab.click();
    });
  }
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && genPopup && !genPopup.classList.contains('hidden')) closePopup();
  });

  // ── Persist / restore grouping prefs ──────────────────────────────────────
  function persistGroupingPrefs() {
    try {
      localStorage.setItem('machicut_grouping', JSON.stringify({
        maxLines: maxLinesSelectMainEl ? maxLinesSelectMainEl.value : '2',
        maxChars: maxCharsInputMainEl  ? maxCharsInputMainEl.value  : '80'
      }));
    } catch (_) {}
  }

  (function restoreGroupingPrefs() {
    try {
      var saved = localStorage.getItem('machicut_grouping');
      if (!saved) return;
      var prefs = JSON.parse(saved);
      var lines = parseInt(prefs.maxLines, 10) || 1;
      var chars = parseInt(prefs.maxChars, 10) || 20;
      if (maxLinesSelectMainEl) maxLinesSelectMainEl.value = lines;
      if (maxCharsInputMainEl)  maxCharsInputMainEl.value  = chars;
      // update stepper displays after restore (refs not yet created, use IDs directly)
      var ld = document.getElementById('ac-lines-display');
      var cd = document.getElementById('ac-chars-display');
      if (ld && prefs.maxLines) ld.textContent = lines;
      if (cd && prefs.maxChars) cd.textContent = chars;
    } catch (_) {}
  }());

  // ── Main postgen bar steppers ──────────────────────────────────────────────
  var DEFAULT_LINES = '1';
  var DEFAULT_CHARS = '20';
  var _lastRegroupLines = maxLinesSelectMainEl ? maxLinesSelectMainEl.value : DEFAULT_LINES;
  var _lastRegroupChars = maxCharsInputMainEl  ? maxCharsInputMainEl.value  : DEFAULT_CHARS;

  var linesDisplay = document.getElementById('ac-lines-display');
  var charsDisplay = document.getElementById('ac-chars-display');

  function _getCurrentLines() { return parseInt(maxLinesSelectMainEl ? maxLinesSelectMainEl.value : '1', 10); }
  function _getCurrentChars() { return parseInt(maxCharsInputMainEl  ? maxCharsInputMainEl.value  : '20', 10); }

  function _setLines(v) {
    v = Math.max(1, Math.min(3, v));
    if (maxLinesSelectMainEl) maxLinesSelectMainEl.value = v;
    if (linesDisplay) linesDisplay.textContent = v;
    if (String(v) === _lastRegroupLines) return;
    _lastRegroupLines = String(v);
    persistGroupingPrefs();
    regroupCaptions();
  }
  function _setChars(v) {
    v = Math.max(5, Math.min(500, v));
    // round to nearest 5 for clean UX
    v = Math.round(v / 5) * 5;
    if (maxCharsInputMainEl) maxCharsInputMainEl.value = v;
    if (charsDisplay) charsDisplay.textContent = v;
    if (String(v) === _lastRegroupChars) return;
    _lastRegroupChars = String(v);
    persistGroupingPrefs();
    regroupCaptions();
  }

  // init displays
  if (linesDisplay) linesDisplay.textContent = _getCurrentLines();
  if (charsDisplay) charsDisplay.textContent = _getCurrentChars();

  var linesDecBtn = document.getElementById('ac-lines-dec');
  var linesIncBtn = document.getElementById('ac-lines-inc');
  var charsDecBtn = document.getElementById('ac-chars-dec');
  var charsIncBtn = document.getElementById('ac-chars-inc');

  if (linesDecBtn) linesDecBtn.addEventListener('click', function () { _setLines(_getCurrentLines() - 1); });
  if (linesIncBtn) linesIncBtn.addEventListener('click', function () { _setLines(_getCurrentLines() + 1); });
  if (charsDecBtn) charsDecBtn.addEventListener('click', function () { _setChars(_getCurrentChars() - 5); });
  if (charsIncBtn) charsIncBtn.addEventListener('click', function () { _setChars(_getCurrentChars() + 5); });

  // Silence gap stepper (captions footer)
  var GAP_KEY_MAIN = 'machicut_silence_gap';
  var gapDisplay = document.getElementById('ac-gap-display');
  var gapDecBtn  = document.getElementById('ac-gap-dec');
  var gapIncBtn  = document.getElementById('ac-gap-inc');
  function _setGapMain(v) {
    v = Math.max(0.1, Math.min(3.0, Math.round(v * 10) / 10));
    if (gapSlider) gapSlider.value = v;
    if (gapDisplay) gapDisplay.textContent = v.toFixed(1) + 's';
    var popupEl = document.getElementById('ac-popup-gap-val');
    if (popupEl) popupEl.textContent = v.toFixed(1) + 's';
    localStorage.setItem(GAP_KEY_MAIN, v);
    regroupCaptions();
  }
  // init from saved value
  var _initGap = parseFloat(localStorage.getItem(GAP_KEY_MAIN));
  if (!isNaN(_initGap) && gapSlider) {
    gapSlider.value = _initGap;
    if (gapDisplay) gapDisplay.textContent = _initGap.toFixed(1) + 's';
  } else if (gapSlider && gapDisplay) {
    gapDisplay.textContent = parseFloat(gapSlider.value).toFixed(1) + 's';
  }
  if (gapDecBtn) gapDecBtn.addEventListener('click', function () { _setGapMain(parseFloat(gapSlider.value) - 0.1); });
  if (gapIncBtn) gapIncBtn.addEventListener('click', function () { _setGapMain(parseFloat(gapSlider.value) + 0.1); });

  // ── Auto Captions inner sub-tab switching ─────────────────────────────────
  var acSubTabs   = document.querySelectorAll('#ac-sub-tabs .ac-sub-tab');
  var acTabPanels = document.querySelectorAll('.ac-tab-panel');

  function switchAcTab(name) {
    acSubTabs.forEach(function (t) {
      var isActive = t.dataset.acTab === name;
      t.classList.toggle('active', isActive);
      t.setAttribute('aria-selected', isActive ? 'true' : 'false');
    });
    acTabPanels.forEach(function (p) { p.classList.toggle('active', p.id === 'ac-tab-' + name); });
    // A canvas painted while its tab is hidden has a zero CSS size in CEP.
    // Repaint after Style becomes visible and keep the motion preview running.
    if (name === 'apply') {
      setTimeout(function () {
        try {
          // Always reseed/repaint here: a user can open Style before creating
          // captions, and the gallery must still show every bundled template.
          if (typeof _m4SeedDefaultTemplates === 'function') _m4SeedDefaultTemplates();
          if (typeof _m4RenderTplStrip === 'function') _m4RenderTplStrip();
          if (typeof _m4UpdatePreviewNavVisibility === 'function') _m4UpdatePreviewNavVisibility();
          if (typeof _m4StartPreview === 'function') _m4StartPreview();
          else if (typeof _m4DrawPreview === 'function') _m4DrawPreview();
        } catch (_) {}
      }, 0);
    }
  }

  // Default: show Captions tab
  switchAcTab('captions');

  acSubTabs.forEach(function (tab) {
    tab.addEventListener('click', function () {
      switchAcTab(tab.dataset.acTab);
    });
  });

  // ── Track selector ─────────────────────────────────────────────────────────
  function getSelectedTrack() {
    if (trackSelectEl && trackSelectEl.value) {
      var parts = trackSelectEl.value.split(':');
      return { type: parts[0], index: parseInt(parts[1], 10) };
    }
    return { type: 'audio', index: 0 };
  }

  var _trackListPromise = Promise.resolve([]);
  function loadTrackList() {
    if (!trackSelectEl) return _trackListPromise;

    // Show fallbacks immediately, then update with real track names once
    // Premiere responds. Called whenever the Generate popup opens.
    var cur = trackSelectEl.value || '';
    var hasRealTracks = trackSelectEl.options.length > 0 &&
                        trackSelectEl.options[0].value !== '';
    if (!hasRealTracks) {
      trackSelectEl.innerHTML =
        '<option value="audio:0">A1</option>' +
        '<option value="audio:1">A2</option>' +
        '<option value="audio:2">A3</option>';
      cur = trackSelectEl.value;
    }

    _trackListPromise = CEP.evalScript('orbitGetTrackList', [], 8000)
      .then(function (result) {
        if (result && result.error) throw new Error(result.error);
        var tracks = Array.isArray(result) ? result : (result && Array.isArray(result.tracks) ? result.tracks : []);
        var audioTracks = Array.isArray(tracks) ? tracks.filter(function (t) { return t.type === 'audio'; }) : [];
        if (audioTracks.length === 0) {
          trackSelectEl.innerHTML = '<option value="">No audio clips found</option>';
          setStatus('error', 'No audio clips found in the active sequence.');
          return [];
        }

        trackSelectEl.innerHTML = '';
        audioTracks.forEach(function (t, idx) {
          var val = t.type + ':' + t.index;
          var opt = document.createElement('option');
          opt.value = val;
          opt.textContent = t.name;
          if (cur ? val === cur : idx === 0) opt.selected = true;
          trackSelectEl.appendChild(opt);
        });
        return audioTracks;
      })
      .catch(function (err) {
        trackSelectEl.innerHTML = '<option value="">Could not load audio tracks</option>';
        setStatus('error', (err && err.message) || 'Could not read tracks from Premiere.');
        return [];
      });
    return _trackListPromise;
  }

  if (refreshTracksBtn) refreshTracksBtn.addEventListener('click', loadTrackList);
  window.addEventListener('compx:rail-route', function (event) {
    if (event && event.detail && event.detail.type === 'captions') loadTrackList();
  });

  // ── Re-group existing captions with new slider settings ────────────────────
  function regroupCaptions() {
    if (generatedCaptions.length === 0) return;
    // Flatten all words from the current caption blocks
    var allWords = [];
    for (var ci = 0; ci < generatedCaptions.length; ci++) {
      var wds = generatedCaptions[ci].words;
      if (wds) allWords = allWords.concat(wds);
    }
    if (allWords.length === 0) return;
    var maxChars = maxCharsInputMainEl  ? (parseInt(maxCharsInputMainEl.value,  10) || 80) :
                   maxCharsInputEl      ? (parseInt(maxCharsInputEl.value,      10) || 80) :
                   parseInt(maxCharsSlider.value, 10);
    var maxLines = maxLinesSelectMainEl ? (parseInt(maxLinesSelectMainEl.value, 10) || 2)  :
                   maxLinesSelectEl     ? (parseInt(maxLinesSelectEl.value,     10) || 2)  :
                   parseInt(maxLinesSlider.value, 10);
    var maxGap   = gapSlider ? parseFloat(gapSlider.value) : 0.2;
    generatedCaptions = groupWords(allWords, 999, maxGap, maxChars, maxLines);
    selectedWord = null;
    _autoDetectDirection();
    persistCaptions();
    renderCaptionList(generatedCaptions);
    applySrtBtn.disabled   = generatedCaptions.length === 0;
    if (applyModel4Btn)  applyModel4Btn.disabled  = generatedCaptions.length === 0;
  }

  // ── Clear all captions ─────────────────────────────────────────────────────
  var clearCaptionsBtn = document.getElementById('ac-clear-captions-btn');
  if (clearCaptionsBtn) {
    clearCaptionsBtn.addEventListener('click', function () {
      generatedCaptions = [];
      originalCaptions  = [];
      generatedWords    = [];
      selectedWord      = null;
      _captionSourceMeta = null;
      localStorage.removeItem('machicut_captions');
      renderCaptionList([]);
      applySrtBtn.disabled   = true;
      if (applyModel4Btn)  applyModel4Btn.disabled  = true;
      updatePostgenBar();
      _updateCaptionsFooter();
    });
  }

  function _chapterTitle(text, index) {
    var clean = String(text || '').replace(/\s+/g, ' ').trim();
    var words = clean.split(' ').slice(0, 7).join(' ');
    if (!words) return 'Chapter ' + (index + 1);
    return words.length > 52 ? words.slice(0, 49) + '...' : words;
  }

  function _buildChapterMarkers() {
    var markers = [];
    var last = -Infinity;
    for (var i = 0; i < generatedCaptions.length; i++) {
      var cap = generatedCaptions[i];
      var start = Number(cap.start || 0);
      var prev = i > 0 ? generatedCaptions[i - 1] : null;
      var gap = prev ? start - Number(prev.end || start) : Infinity;
      if (i === 0 || gap >= 1.8 || start - last >= 60) {
        markers.push({ time: start, name: _chapterTitle(cap.text, markers.length), comment: String(cap.text || '').replace(/\s+/g, ' ').trim() });
        last = start;
      }
    }
    return markers;
  }

  if (createChaptersBtn) createChaptersBtn.addEventListener('click', function () {
    var markers = _buildChapterMarkers();
    if (!markers.length) return setStatus('error', 'Generate or import captions first.');
    createChaptersBtn.disabled = true;
    CEP.evalScript('createCaptionChapterMarkers', [JSON.stringify(markers)], 30000)
      .then(function (result) {
        if (result && result.error) throw new Error(result.error);
        setStatus('success', 'Created ' + ((result && result.created) || markers.length) + ' chapter marker(s).');
      })
      .catch(function (err) { setStatus('error', (err && err.message) || 'Could not create chapter markers.'); })
      .then(function () { createChaptersBtn.disabled = false; }, function () { createChaptersBtn.disabled = false; });
  });

  function _cleanupCandidates() {
    var fillers = { um:1, uh:1, erm:1, er:1, ah:1, basically:1, literally:1, actually:1 };
    var profanity = { damn:1, shit:1, fuck:1, fucking:1, bitch:1, asshole:1 };
    var out = [];
    for (var ci = 0; ci < generatedCaptions.length; ci++) {
      var words = generatedCaptions[ci].words || [];
      var previous = '';
      for (var wi = 0; wi < words.length; wi++) {
        var raw = String(words[wi].word || '');
        var normalized = raw.toLowerCase().replace(/^[^a-z0-9']+|[^a-z0-9']+$/g, '');
        var type = '';
        if (fillers[normalized]) type = 'Filler';
        else if (profanity[normalized]) type = 'Profanity';
        else if (normalized && normalized === previous) type = 'Repeated';
        if (type) {
          out.push({
            key: ci + ':' + wi,
            captionIndex: ci,
            wordIndex: wi,
            label: raw,
            type: type,
            start: Number(words[wi].start) || 0,
            end: Number(words[wi].end) || 0
          });
        }
        if (normalized) previous = normalized;
      }
    }
    return out;
  }

  function _applyCleanup(selected, cutTimeline, safetyReady) {
    if (!selected.length) return setStatus('error', 'Select at least one word.');
    if (cutTimeline && !safetyReady) {
      setStatus('working', 'Creating safety sequence copy...');
      return CEP.evalScript('ppro_duplicateActiveSequence', [], 15000)
        .then(function (copyResult) {
          if (!copyResult || copyResult.success === false) throw new Error((copyResult && copyResult.message) || 'Could not create safety sequence copy.');
          return _applyCleanup(selected, true, true);
        })
        .catch(function (err) { setStatus('error', (err && err.message) || 'Timeline cleanup was cancelled before making changes.'); });
    }
    var previousCaptions = JSON.parse(JSON.stringify(generatedCaptions));
    var previousWords = JSON.parse(JSON.stringify(generatedWords));
    var remove = {};
    var ranges = [];
    selected.forEach(function (item) {
      remove[item.key] = true;
      if (item.end > item.start) ranges.push({ start: item.start, end: item.end });
    });

    var cleaned = [];
    for (var ci = 0; ci < generatedCaptions.length; ci++) {
      var cap = generatedCaptions[ci];
      if (!cap.words || !cap.words.length) { cleaned.push(cap); continue; }
      var kept = cap.words.filter(function (_, wi) { return !remove[ci + ':' + wi]; });
      if (!kept.length) continue;
      cap.words = kept;
      cap.start = kept[0].start;
      cap.end = kept[kept.length - 1].end;
      cap.text = rebuildCaptionText(kept);
      cleaned.push(cap);
    }
    generatedCaptions = cleaned;
    generatedWords = [];
    generatedCaptions.forEach(function (cap) {
      (cap.words || []).forEach(function (word) {
        generatedWords.push({ text: word.word, start: word.start, end: word.end });
      });
    });
    persistCaptions();
    renderCaptionList(generatedCaptions);
    _updateCaptionsFooter();

    if (!cutTimeline || !ranges.length) {
      setStatus('success', 'Removed ' + selected.length + ' flagged word(s) from captions.');
      return Promise.resolve();
    }

    setStatus('working', 'Cleaning timeline...');
    return CEP.evalScript('removeSilenceRanges', [JSON.stringify(ranges), '[]', 'ripple'], 120000)
      .then(function (result) {
        if (result && result.error) throw new Error(result.error);
        setStatus('success', 'Removed ' + selected.length + ' word(s) from captions and timeline. Safety copy created.');
      })
      .catch(function (err) {
        generatedCaptions = previousCaptions;
        generatedWords = previousWords;
        persistCaptions();
        renderCaptionList(generatedCaptions);
        _updateCaptionsFooter();
        setStatus('error', ((err && err.message) || 'Timeline cleanup failed.') + ' Caption edits were rolled back.');
      });
  }

  function _openCleanupReview() {
    var candidates = _cleanupCandidates();
    if (!candidates.length) return setStatus('success', 'No filler, profanity, or repeated words found.');

    var overlay = document.createElement('div');
    overlay.className = 'gen-popup';
    overlay.style.display = 'flex';
    overlay.style.position = 'fixed';
    overlay.style.inset = '0';
    overlay.style.zIndex = '10020';
    overlay.style.background = 'rgba(0,0,0,.72)';
    overlay.style.alignItems = 'center';
    overlay.style.justifyContent = 'center';

    var card = document.createElement('div');
    card.style.cssText = 'width:min(520px,90vw);max-height:78vh;overflow:hidden;background:#17181b;border:1px solid #34363c;border-radius:12px;padding:16px;display:flex;flex-direction:column;gap:12px;';
    var title = document.createElement('div');
    title.style.cssText = 'font-size:15px;font-weight:700;color:#fff;';
    title.textContent = 'Review ' + candidates.length + ' flagged word(s)';
    var hint = document.createElement('div');
    hint.className = 'track-list-hint';
    hint.textContent = 'Uncheck anything you want to keep. Timeline cleanup always creates a safety copy.';
    var list = document.createElement('div');
    list.style.cssText = 'overflow:auto;display:flex;flex-direction:column;gap:6px;';

    candidates.forEach(function (item, index) {
      var row = document.createElement('label');
      row.style.cssText = 'display:flex;align-items:center;gap:9px;padding:8px;border-radius:7px;background:#22242a;color:#eee;';
      var box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = true;
      box.setAttribute('data-clean-index', index);
      var word = document.createElement('span');
      word.style.cssText = 'flex:1;';
      word.textContent = item.label;
      var badge = document.createElement('span');
      badge.style.cssText = 'font-size:11px;color:#aeb2bc;';
      badge.textContent = item.type;
      row.appendChild(box); row.appendChild(word); row.appendChild(badge);
      list.appendChild(row);
    });

    var actions = document.createElement('div');
    actions.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;';
    function button(label, primary) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = primary ? 'btn btn-primary' : 'btn btn-secondary';
      btn.textContent = label;
      return btn;
    }
    var cancel = button('Cancel', false);
    var captionsOnly = button('Captions only', false);
    var timeline = button('Captions + timeline', true);
    function selectedItems() {
      var selected = [];
      list.querySelectorAll('input[data-clean-index]').forEach(function (box) {
        if (box.checked) selected.push(candidates[parseInt(box.getAttribute('data-clean-index'), 10)]);
      });
      return selected;
    }
    cancel.addEventListener('click', function () { if (overlay.parentNode) overlay.parentNode.removeChild(overlay); });
    captionsOnly.addEventListener('click', function () {
      var picked = selectedItems();
      if (!picked.length) return setStatus('error', 'Select at least one word.');
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      _applyCleanup(picked, false);
    });
    timeline.addEventListener('click', function () {
      var picked = selectedItems();
      if (!picked.length) return setStatus('error', 'Select at least one word.');
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      _applyCleanup(picked, true);
    });
    actions.appendChild(cancel); actions.appendChild(captionsOnly); actions.appendChild(timeline);
    card.appendChild(title); card.appendChild(hint); card.appendChild(list); card.appendChild(actions);
    overlay.appendChild(card);
    document.body.appendChild(overlay);
  }

  if (cleanTextBtn) cleanTextBtn.addEventListener('click', _openCleanupReview);
  function _openTextEditReview() {
    var words = [];
    for (var ci = 0; ci < generatedCaptions.length; ci++) {
      var list = generatedCaptions[ci].words || [];
      for (var wi = 0; wi < list.length; wi++) words.push({ key:ci+':'+wi, captionIndex:ci, wordIndex:wi, label:String(list[wi].word||''), type:'Word', start:Number(list[wi].start)||0, end:Number(list[wi].end)||0 });
    }
    if (!words.length) return setStatus('error', 'Generate or import timed captions first.');
    var overlay=document.createElement('div'); overlay.className='gen-popup'; overlay.style.cssText='display:flex;position:fixed;inset:0;z-index:10020;background:rgba(0,0,0,.72);align-items:center;justify-content:center';
    var card=document.createElement('div'); card.style.cssText='width:min(620px,92vw);max-height:82vh;background:#17181b;border:1px solid #34363c;border-radius:12px;padding:16px;display:flex;flex-direction:column;gap:10px';
    card.innerHTML='<strong style="color:#fff">Text-based timeline edit</strong><span class="track-list-hint">Click words to mark them for removal. Applying creates a safety sequence copy, then ripple-deletes their timed ranges.</span>';
    var listEl=document.createElement('div'); listEl.style.cssText='overflow:auto;line-height:2.2;padding:8px;background:#111216;border-radius:8px';
    words.forEach(function(item,index){var b=document.createElement('button');b.type='button';b.textContent=item.label;b.setAttribute('data-word-index',index);b.style.cssText='margin:2px;padding:4px 7px;border:1px solid #34363c;border-radius:5px;background:#24262c;color:#eee;cursor:pointer';b.addEventListener('click',function(){var on=b.getAttribute('aria-pressed')==='true';b.setAttribute('aria-pressed',on?'false':'true');b.style.background=on?'#24262c':'#8b2635';});listEl.appendChild(b);});
    var actions=document.createElement('div');actions.style.cssText='display:flex;gap:8px;justify-content:flex-end';var cancel=document.createElement('button');cancel.className='btn btn-secondary';cancel.textContent='Cancel';var apply=document.createElement('button');apply.className='btn btn-primary';apply.textContent='Remove from captions + timeline';actions.appendChild(cancel);actions.appendChild(apply);card.appendChild(listEl);card.appendChild(actions);overlay.appendChild(card);document.body.appendChild(overlay);
    cancel.onclick=function(){overlay.parentNode.removeChild(overlay);};apply.onclick=function(){var picked=[];listEl.querySelectorAll('[aria-pressed="true"]').forEach(function(b){picked.push(words[parseInt(b.getAttribute('data-word-index'),10)]);});if(!picked.length)return setStatus('error','Select at least one word.');overlay.parentNode.removeChild(overlay);_applyCleanup(picked,true);};
  }
  if (textEditBtn) textEditBtn.addEventListener('click', _openTextEditReview);
  // ── Export captions as JSON ────────────────────────────────────────────────
  if (exportCaptionsBtn) {
    exportCaptionsBtn.addEventListener('click', function () {
      if (!generatedCaptions.length) return;
      var json = JSON.stringify(generatedCaptions, null, 2);
      CEP.evalScript('exportCaptionsJson', [json], 15000).catch(function () {});
    });
  }

  // ── Import captions from JSON ──────────────────────────────────────────────
  if (importCaptionsBtn) {
    importCaptionsBtn.addEventListener('click', function () {
      CEP.evalScript('importCaptionsJson', [], 15000).then(function (content) {
        if (!content) return;
        try {
          var data = Array.isArray(content) ? content : JSON.parse(content);
          if (!Array.isArray(data)) throw new Error('Not an array');
          generatedCaptions = data;
          originalCaptions  = JSON.parse(JSON.stringify(data));
          selectedWord = null;
          _captionSourceMeta = {
            kind: 'json',
            name: 'Imported captions JSON',
            cueCount: data.length,
            start: data.length ? Number(data[0].start || 0) : 0,
            end: data.length ? Number(data[data.length - 1].end || 0) : 0
          };
          persistCaptions();
          renderCaptionList(generatedCaptions);
          applySrtBtn.disabled = generatedCaptions.length === 0;
          if (applyModel4Btn) applyModel4Btn.disabled = generatedCaptions.length === 0;
          _updateCaptionsFooter();
        } catch (_) {
          showAlert('Invalid captions file.');
        }
      }).catch(function () {});
    });
  }

  // ── Reset to original Whisper grouping ─────────────────────────────────────
  var resetGroupingBtn = document.getElementById('ac-reset-grouping-btn');
  if (resetGroupingBtn) {
    resetGroupingBtn.addEventListener('click', function () {
      if (originalCaptions.length === 0) return;
      generatedCaptions = JSON.parse(JSON.stringify(originalCaptions));
      selectedWord = null;
      persistCaptions();
      renderCaptionList(generatedCaptions);
      applySrtBtn.disabled   = generatedCaptions.length === 0;
      if (applyModel4Btn)  applyModel4Btn.disabled  = generatedCaptions.length === 0;
    });
  }

  // Position no longer lives in the popup. It's on the action bar and
  // persists via _m4InitActionBarPos (further down). The old popup
  // sync block was deleted along with the popup's X/Y inputs.

  // ── Popup steppers for Lines and Chars ────────────────────────────────────
  (function() {
    var LINES_KEY = 'machicut_popup_lines';
    var CHARS_KEY = 'machicut_popup_chars';

    // Restore persisted values
    var savedLines = parseInt(localStorage.getItem(LINES_KEY), 10) || 1;
    var savedChars = parseInt(localStorage.getItem(CHARS_KEY), 10) || 20;
    if (maxLinesSelectEl) maxLinesSelectEl.value = savedLines;
    if (maxCharsInputEl)  maxCharsInputEl.value  = savedChars;
    var linesValEl = document.getElementById('ac-max-lines-val');
    var charsValEl = document.getElementById('ac-max-chars-val');
    if (linesValEl) linesValEl.textContent = savedLines;
    if (charsValEl) charsValEl.textContent = savedChars;

    function setLines(v) {
      v = Math.max(1, Math.min(3, v));
      if (maxLinesSelectEl) maxLinesSelectEl.value = v;
      if (linesValEl) linesValEl.textContent = v;
      if (maxLinesSlider) maxLinesSlider.value = v;
      localStorage.setItem(LINES_KEY, v);
    }
    function setChars(v) {
      v = Math.max(5, Math.min(500, v));
      if (maxCharsInputEl) maxCharsInputEl.value = v;
      if (charsValEl) charsValEl.textContent = v;
      if (maxCharsSlider) maxCharsSlider.value = Math.min(v, 120);
      localStorage.setItem(CHARS_KEY, v);
    }

    var decL = document.getElementById('ac-popup-lines-dec');
    var incL = document.getElementById('ac-popup-lines-inc');
    var decC = document.getElementById('ac-popup-chars-dec');
    var incC = document.getElementById('ac-popup-chars-inc');
    if (decL) decL.addEventListener('click', function() { setLines(parseInt(maxLinesSelectEl.value, 10) - 1); });
    if (incL) incL.addEventListener('click', function() { setLines(parseInt(maxLinesSelectEl.value, 10) + 1); });
    if (decC) decC.addEventListener('click', function() { setChars(parseInt(maxCharsInputEl.value,  10) - 5); });
    if (incC) incC.addEventListener('click', function() { setChars(parseInt(maxCharsInputEl.value,  10) + 5); });

    // Silence gap stepper (drives the hidden #ac-gap slider)
    var GAP_KEY = 'machicut_silence_gap';
    var gapValEl = document.getElementById('ac-popup-gap-val');
    function setGap(v) {
      v = Math.max(0.1, Math.min(3.0, Math.round(v * 10) / 10));
      if (gapSlider) gapSlider.value = v;
      if (gapValEl) gapValEl.textContent = v.toFixed(1) + 's';
      var mainEl = document.getElementById('ac-gap-display');
      if (mainEl) mainEl.textContent = v.toFixed(1) + 's';
      localStorage.setItem(GAP_KEY, v);
      if (typeof regroupCaptions === 'function') regroupCaptions();
    }
    var _savedGap = parseFloat(localStorage.getItem(GAP_KEY));
    if (!isNaN(_savedGap)) setGap(_savedGap);
    var decG = document.getElementById('ac-popup-gap-dec');
    var incG = document.getElementById('ac-popup-gap-inc');
    if (decG) decG.addEventListener('click', function() { setGap(parseFloat(gapSlider.value) - 0.1); });
    if (incG) incG.addEventListener('click', function() { setGap(parseFloat(gapSlider.value) + 0.1); });
  })();

  if (gapSlider) {
    gapSlider.addEventListener('input', function () {
      if (gapVal) gapVal.textContent = parseFloat(this.value).toFixed(1) + ' s';
      regroupCaptions();
    });
  }

  // ── Generate captions ──────────────────────────────────────────────────────
  // Dialog bridge kept inside this module so generation never depends on
  // the licensed shell exporting legacy callback globals.
  function _confirmAction(message, onConfirm, onCancel) {
    if (typeof global.showConfirm === 'function') {
      try {
        global.showConfirm(message, onConfirm, onCancel);
        return;
      } catch (err) {
        console.warn('[Confirm] shared callback dialog failed:', err);
      }
    }
    if (typeof global.showModal === 'function') {
      try {
        global.showModal({
          title: 'Confirm',
          message: String(message || ''),
          okText: 'Continue',
          cancelText: 'Cancel'
        }).then(function (confirmed) {
          if (confirmed) { if (typeof onConfirm === 'function') onConfirm(); }
          else if (typeof onCancel === 'function') onCancel();
        }).catch(function () {
          if (typeof onCancel === 'function') onCancel();
        });
        return;
      } catch (err2) {
        console.warn('[Confirm] shared Promise dialog failed:', err2);
      }
    }
    var confirmed = false;
    try { confirmed = global.confirm(String(message || '')); }
    catch (err3) { console.warn('[Confirm] native dialog failed:', err3); }
    if (confirmed) { if (typeof onConfirm === 'function') onConfirm(); }
    else if (typeof onCancel === 'function') onCancel();
  }

  generateBtn.addEventListener('click', function () {
    if (window.UX && _popupViewMode !== 'preview') UX.track('generate_click', {});
    // In preview mode the bottom button reads "Apply" and runs the
    // Model-4 apply-to-timeline flow (render PNGs + place clips). No
    // transcription happens - we reuse the existing captions verbatim.
    // Delegates to the Style-page Apply button so the heavy logic stays
    // in one place.
    if (_popupViewMode === 'preview') {
      _popupPosCommitToBar();
      // If the popup was launched from Home, switch to the AC panel so
      // the user sees the timeline + editor after Apply runs. From
      // regen-edit the panel is already active.
      if (_popupMode === 'home') {
        switchToCaptionsPanel();
      }
      closePopup();
      var applyBtn = document.getElementById('ac-apply-model4-btn');
      if (applyBtn && !applyBtn.disabled) applyBtn.click();
      return;
    }

    // Generate / Regenerate: commit popup Position to the action bar
    // so the value the user just picked drives this run (and persists
    // for the next one via the bar's existing localStorage cascade).
    _popupPosCommitToBar();
    if (_isLocalTranscription()) {
      _setBtnLoading(generateBtn, true, 'Checking local model...');
      if (!global.WhisperLocalAPI || !global.WhisperLocalAPI.getStatus) {
        _setBtnLoading(generateBtn, false);
        setStatus('error', 'Local Whisper is unavailable. Switch Engine to Cloud.');
        return;
      }
      var localStatus = global.WhisperLocalAPI.getStatus(_selectedLocalModel());
      if (!localStatus.available) {
        _setBtnLoading(generateBtn, false);
        setStatus('error', localStatus.reason || 'Local Whisper is unavailable. Switch Engine to Cloud.');
        return;
      }
      function proceedWithLocalEngine() {
        _proceedWithToken(null);
      }
      if (localStatus.installed) {
        proceedWithLocalEngine();
      } else {
        _setBtnLoading(generateBtn, false);
        if (depsPanel && depsInstallBtn) {
          depsPanel.classList.remove('hidden');
          if (depsOpenBtn) depsOpenBtn.classList.add('active');
          if (depsModelSelect) depsModelSelect.value = _selectedLocalModel();
          _renderDependencyStatus();
          setStatus('error', 'Download the missing Local AI files first, then click Generate again.');
          try { depsPanel.scrollIntoView(false); } catch (_) {}
        } else {
          setStatus('error', 'This model needs a one-time dependency download of about ' +
            Math.ceil(localStatus.downloadMB || 0) + ' MB.');
        }
      }
      return;
    }
    // Async refresh - returns a fresh, non-expired JWT (or null if the
    // refresh_token itself is dead, in which case getAccessToken has
    // also flipped state to 'locked' so authGate re-appears).
    var _tokenPromise = (global.AuthAPI && global.AuthAPI.getAccessToken)
      ? global.AuthAPI.getAccessToken()
      : Promise.resolve(null);

    _setBtnLoading(generateBtn, true, 'Preparing...');

    _tokenPromise.then(function (licenseKey) {
      if (licenseKey) { _proceedWithToken(licenseKey); return; }

      // Freemium: AI captions need an account (silence cutting + manual
      // captions don't and never reach here). Instead of erroring, run
      // the sign-in flow and continue once a token lands. First use gets
      // 10 free minutes; the backend meters the rest.
      if (!(window.LoginFlow && window.LoginFlow.startLogin)) {
        _setBtnLoading(generateBtn, false);
        showAlert('Sign in to use AI captions (10 minutes free).');
        return;
      }
      _setBtnLoading(generateBtn, true, 'Waiting for sign-in...');
      setStatus('working', 'Opening sign-in in your browser...');
      window.LoginFlow.startLogin()
        .then(function () { return global.AuthAPI.getAccessToken(); })
        .then(function (tok) {
          if (tok) { _proceedWithToken(tok); }
          else { _setBtnLoading(generateBtn, false); setStatus('error', 'Sign-in didn\'t complete. Try Generate again.'); }
        })
        .catch(function (err) {
          _setBtnLoading(generateBtn, false);
          if (err && err.cancelled) { setStatus('', ''); return; }  // user cancelled - quiet
          setStatus('error', 'Sign-in failed. Try Generate again.');
        });
    });
  });

  // Post-token generate path: place-on-track conflict check, then run.
  // Shared by the signed-in path and the just-signed-in retry.
  function _proceedWithToken(licenseKey) {
    var _placeVal = (_popupMode === 'home' && popupPlaceTrack) ? popupPlaceTrack.value : '';
    console.log('[Generate] mode=' + _popupMode + ' placeVal=' + _placeVal);
    if (_placeVal && _placeVal !== 'new') {
      var _placeNum = parseInt(_placeVal, 10) || 2;
      CEP.evalScript('checkTrackEmpty', [String(_placeNum)], 5000)
        .then(function (res) {
          console.log('[Generate] checkTrackEmpty ->', res);
          if (res && res.empty === false) {
            _confirmAction(
              'V' + _placeNum + ' already has clips.\nProceeding will place the caption sequence on top.\nContinue?',
              function () { runGeneration(licenseKey); },
              function () { _setBtnLoading(generateBtn, false); } // user cancelled
            );
          } else {
            runGeneration(licenseKey);
          }
        })
        .catch(function (err) {
          console.warn('[Generate] checkTrackEmpty failed:', err);
          _confirmAction(
            'Could not verify V' + _placeNum + ' is empty.\n' +
            'Proceeding will place the caption sequence on top of whatever is there.\nContinue?',
            function () { runGeneration(licenseKey); },
            function () { _setBtnLoading(generateBtn, false); }
          );
        });
    } else {
      runGeneration(licenseKey);
    }
  }

  function runGeneration(licenseKey) {
    _setBtnLoading(generateBtn, true, 'Generating...');
    // FFmpeg runs in-process (bundled or a detected macOS installation).
    // _runGenerationInner validates it and sets its own status on entry.
    _runGenerationInner(licenseKey);
  }

  function _runGenerationInner(licenseKey) {
    setStatus('working', 'Loading track info...');
    setWorking(true, 'Loading track info...');
    _pipelineStart('Loading the selected Premiere audio track...');
    generatedCaptions = [];
    _captionSourceMeta = null;
    localStorage.removeItem('machicut_captions');
    renderCaptionList([]);
    applySrtBtn.disabled = true;
    if (applyModel4Btn)  applyModel4Btn.disabled  = true;

    var language  = langSelect.value;
    var transcriptionEngine = _isLocalTranscription() ? 'local' : 'cloud';
    var localModel = _selectedLocalModel();
    var localTranslate = transcriptionEngine === 'local' && localTranslateToggle && localTranslateToggle.checked;
    var modelSel  = document.getElementById('ac-model-select');
    var whisperModel = transcriptionEngine === 'local'
      ? localModel
      : (modelSel ? modelSel.value : 'turbo');
    var maxChars  = maxCharsInputEl ? (parseInt(maxCharsInputEl.value, 10) || 80) : parseInt(maxCharsSlider.value, 10);
    var maxLines  = maxLinesSelectEl ? (parseInt(maxLinesSelectEl.value, 10) || 2) : parseInt(maxLinesSlider.value, 10);
    var maxGap    = gapSlider ? parseFloat(gapSlider.value) : 0.2;
    var wavPath   = '';
    var clipMap   = null;

    var selectedTrack = null;

    // Capture sequence dimensions at generation time (parallel, non-blocking)
    CEP.evalScript('getSequenceInfo', [], 5000).then(function (si) {
      try {
        if (si && si.width  && !si.error) captionSeqW = si.width;
        if (si && si.height && !si.error) captionSeqH = si.height;
      } catch (_) {}
    }).catch(function () {});

    // Step 1: wait for the real track list, validate FFmpeg, then get every
    // clip segment from the selected track. This makes Mac failures explicit
    // instead of silently continuing with a guessed A1 placeholder.
    _trackListPromise
      .then(function () {
        if (!trackSelectEl || !trackSelectEl.value) {
          throw new Error('No audio track with clips was found in the active sequence.');
        }
        selectedTrack = getSelectedTrack();
        _pipelineStage('ffmpeg', 'Checking FFmpeg', 'Verifying the audio processing dependency...');
        if (!global.FFmpegAPI || !FFmpegAPI.checkFFmpeg) {
          throw new Error('Audio preparation is unavailable.');
        }
        return FFmpegAPI.checkFFmpeg();
      })
      .then(function () {
        _pipelineStage('audio', 'Preparing audio', 'Reading clips from ' + (selectedTrack.label || 'the selected track') + '...');
        return CEP.evalScript('getAudioTrackClips', [selectedTrack.type, selectedTrack.index], 45000);
      })
      .then(function (clips) {
        if (!clips || !clips.length) throw new Error('No readable audio clips found on the selected track.');
        progressLabel.textContent = 'Preparing audio...';
        setStatus('working', 'Preparing ' + clips.length + ' clip(s)...');
        _pipelineStage('audio', 'Preparing audio', 'Extracting and joining ' + clips.length + ' clip(s)...', 48);

        return CEP.evalScript('getTempDir', [], 10000)
          .then(function (tmpDir) {
            wavPath = (tmpDir + '/machicut_caption_audio.mp3').replace(/\\/g, '/');
            return FFmpegAPI.extractSegments(clips, wavPath);
          });
      })
      .then(function (result) {
        clipMap = result.clipMap;
        // Persist the concat wav + clipMap so the caption editor popup can
        // play back the right slice across panel reloads.
        _captionWavPath = wavPath;
        _captionClipMap = clipMap;
        // Record where A2 starts on the timeline so the SRT can be placed there
        captionSeqStart = (clipMap && clipMap.length > 0) ? clipMap[0].timelineStart : 0;
        progressLabel.textContent = 'Generating captions...';
        setStatus('working', 'Generating captions...');
        _pipelineStage('whisper', 'Running Whisper', transcriptionEngine === 'local'
          ? 'The local model is transcribing on this computer. CPU models can take several minutes.'
          : 'Audio was uploaded; waiting for the cloud transcription result...');

        // Snap-to-silence is now always-on. The previous Settings-page
        // toggle was removed (the description in the UI was misleading
        // anyway - it sounded like a render-time hold, not a Whisper
        // timing correction). Leaving the localStorage read in place
        // as a hidden escape hatch: set machicut_snap_silence=0 to
        // disable for debugging.
        var snapEnabled = (localStorage.getItem('machicut_snap_silence') !== '0');

        // Run silence detection in parallel with Whisper. Both operate on
        // the same wav so they share a time space; we can apply the snap
        // before extractWords. If the silence call fails, we just skip
        // the snap - degrades gracefully to raw Whisper timing.
        return Promise.all([
          transcriptionEngine === 'local'
            ? global.WhisperLocalAPI.transcribeAudio(wavPath, language, localModel, {
                translate: !!localTranslate,
                onProgress: function (progress) {
                  var label = progress && progress.label ? progress.label : 'Running local Whisper...';
                  progressLabel.textContent = label;
                  setStatus('working', label);
                  _pipelineProgressDetail(label);
                }
              })
            : FFmpegAPI.transcribeAudio(wavPath, language, licenseKey, whisperModel),
          snapEnabled
            ? FFmpegAPI.detectSilence(wavPath, -30, 0.1).catch(function () { return []; })
            : Promise.resolve([])
        ]);
      })
      .then(function (results) {
        progressLabel.textContent = 'Almost there...';
        _pipelineStage('captions', 'Building captions', 'Grouping transcript words into timed caption blocks...');
        var whisperResponse = results[0];
        var silences        = results[1] || [];
        // Every transcribe response carries the fresh monthly totals -
        // keep the meter current without an extra round-trip.
        if (typeof whisperResponse.used_minutes === 'number' &&
            typeof whisperResponse.limit_minutes === 'number') {
          try { _renderUsage(whisperResponse.used_minutes, whisperResponse.limit_minutes); } catch (_) {}
        }
        if (silences.length) snapWhisperWordsToSilence(whisperResponse, silences);
        if (window.UX) UX.track('transcribe_result', {
          outcome: 'ok',
          tier: transcriptionEngine === 'local' ? 'local' : (whisperResponse.tier || (whisperResponse.free_tier ? 'free' : null))
        });
        _completeGeneration(whisperResponse, clipMap, maxChars, maxLines, maxGap);
      })
      .catch(function (err) {
        _setBtnLoading(generateBtn, false);
        setWorking(false);
        // applySrtBtn stays disabled (no captions on error)
        var msg = err.message || String(err);
        _pipelineFinish(false, 'Generation stopped', msg);
        var body = err && err.body;
        var lowerMsg = msg.toLowerCase();
        if (transcriptionEngine === 'local') {
          if (window.UX) UX.track('transcribe_result', { outcome: 'error', tier: 'local' });
          setStatus('error', 'Local transcription failed: ' + msg);
          return;
        }
        // Free tier exhausted (server 402) - show the upgrade card, not
        // the generic limit banner. Check FIRST since the 402 also sets
        // limit_reached.
        var isFreeExhausted = err && (err.status === 402 ||
                              (body && (body.free_exhausted || body.needs_subscription)));
        var isLimit = err && (err.status === 429 || (body && body.limit_reached)) ||
                      lowerMsg.indexOf('limit')   !== -1 ||
                      lowerMsg.indexOf('quota')   !== -1 ||
                      msg.indexOf('429') !== -1;
        if (window.UX) UX.track('transcribe_result', {
          outcome: isFreeExhausted ? 'free_exhausted'
                 : isLimit         ? 'limit'
                 : (lowerMsg.indexOf('license') !== -1 || msg.indexOf('401') !== -1) ? 'session'
                 : 'error'
        });
        if (isFreeExhausted) {
          _showUpgradeCard();
          if (generateBtn) generateBtn.disabled = true;
          setStatus('error', (body && body.error) || 'Free minutes used.');
        } else if (lowerMsg.indexOf('license') !== -1 || msg.indexOf('401') !== -1) {
          setStatus('error', 'Session expired. Reopen the panel to sign in again.');
        } else if (isLimit) {
          // Persistent banner inside the popup so the message survives the
          // status-bar auto-dismiss and isn't hidden behind the popup card.
          var banner = document.getElementById('ac-popup-limit-banner');
          var bMsg   = document.getElementById('ac-popup-limit-msg');
          if (banner && bMsg) {
            var used      = body && typeof body.used_minutes      === 'number' ? body.used_minutes      : null;
            var limit     = body && typeof body.limit_minutes     === 'number' ? body.limit_minutes     : null;
            var remaining = body && typeof body.remaining_minutes === 'number' ? body.remaining_minutes : null;
            // Modal's 429 error string already names the binding cap
            // ("Monthly limit reached (300 min)." / "Daily limit
            // reached (120 min)."). Prefer it, enriched with the
            // remaining-budget detail when the request only PARTLY
            // fit; hand-rolled fallbacks otherwise.
            var serverMsg = (body && body.error) ? String(body.error) : '';
            var text;
            if (serverMsg && remaining !== null && remaining > 0) {
              text = serverMsg + ' Only ' + remaining.toFixed(1) +
                     ' minute(s) of budget left - trim the timeline to fit.';
            } else if (serverMsg) {
              text = serverMsg;
            } else if (used !== null && limit !== null) {
              text = 'Limit reached - ' + used.toFixed(1) + ' of ' + limit +
                     ' minutes used.';
            } else {
              text = msg;
            }
            bMsg.textContent = text;
            banner.classList.remove('hidden');
          }
          // Lock Generate so a second click can't re-trigger the V2 prompt +
          // audio extraction. The user has to close the popup (or change the
          // selection / wait for reset) to retry - openPopup re-runs preflight.
          if (generateBtn) generateBtn.disabled = true;
          setStatus('error', msg);
        } else if (lowerMsg.indexOf('premiere') !== -1 || lowerMsg.indexOf('extendscript') !== -1 ||
                   lowerMsg.indexOf('sequence') !== -1 || lowerMsg.indexOf('ffmpeg') !== -1 ||
                   lowerMsg.indexOf('audio track') !== -1 || lowerMsg.indexOf('audio clip') !== -1 ||
                   lowerMsg.indexOf('audio preparation') !== -1) {
          setStatus('error', msg);
        } else {
          // ONLY genuinely unexpected errors reach console.error (and
          // thus the Supabase error log). Everything handled above -
          // free-tier 402, quota 429, session, no-sequence - is expected
          // UX, not a bug, so it must not inflate the error signal or
          // make the paywall look like a failure.
          setStatus('error', 'Something went wrong. Try again.');
          console.error('AutoCaptions error:', err);
        }
      });
  }

  // ── Shared generation completer ───────────────────────────────────────────
  // Everything downstream of "we have a whisper-SHAPED response": word
  // extraction, grouping, persist, UI sync. Fed by three producers -
  // real Whisper, SRT import, and manual text - so captions behave
  // identically no matter where they came from.
  function _completeGeneration(whisperLike, clipMapArg, maxChars, maxLines, maxGap) {
    var words    = extractWords(whisperLike, clipMapArg);
    var captions = groupWords(words, 999, maxGap, maxChars, maxLines);
    generatedCaptions = captions;
    // Deep-copy as the canonical default (used by Reset button)
    originalCaptions  = JSON.parse(JSON.stringify(captions));
    generatedWords = words.map(function (w) {
      return { text: w.word, start: w.start, end: w.end, segIdx: w.segIdx };
    });
    // Persist so the panel survives reloads
    _autoDetectDirection();
    persistCaptions();
    renderCaptionList(captions);
    // Restore apply buttons (setWorking disabled them; re-enable based on state)
    applySrtBtn.disabled    = captions.length === 0;
    if (applyModel4Btn)  applyModel4Btn.disabled  = captions.length === 0;
    if (typeof _m4StartPreview === 'function') _m4StartPreview();
    // Sync popup values -> main postgen bar, steppers, and persist
    if (maxLinesSelectMainEl) maxLinesSelectMainEl.value = maxLines;
    if (maxCharsInputMainEl)  maxCharsInputMainEl.value  = maxChars;
    if (linesDisplay) linesDisplay.textContent = maxLines;
    if (charsDisplay) charsDisplay.textContent = maxChars;
    _lastRegroupLines = String(maxLines);
    _lastRegroupChars = String(maxChars);
    persistGroupingPrefs();
    updatePostgenBar();
    var _gotoApply = _popupTplPicked && _popupMode === 'home';
    _popupTplPicked = false;
    var _isSubtitleImport = _captionSourceMeta && _captionSourceMeta.kind === 'subtitle';
    _pipelineFinish(
      true,
      _isSubtitleImport ? 'Subtitles imported' : 'Captions ready',
      (_isSubtitleImport ? 'Loaded ' : 'Created ') + captions.length + ' timed caption blocks.'
    );
    closePopup();
    _setBtnLoading(generateBtn, false);
    setWorking(false);
    setStatus(
      'success',
      _isSubtitleImport
        ? 'Imported ' + captions.length + ' timed cues from ' +
          (_captionSourceMeta.name || 'subtitle file') + '.'
        : 'Done! ' + captions.length + ' captions generated.'
    );
    // If the popup was launched from Home we stayed on Home during
    // the run - flip to the AC panel now that there's a result the
    // user wants to see. From regen-edit the panel is already
    // active so we leave it alone.
    if (_popupMode === 'home') {
      switchToCaptionsPanel();
    }
    switchAcTab(_gotoApply ? 'apply' : 'captions');
    if (_gotoApply) {
      setTimeout(function() {
        var applyBtn = document.getElementById('ac-apply-model4-btn');
        if (applyBtn && !applyBtn.disabled) applyBtn.click();
      }, 100);
    }
  }

  // ── Bring-your-own-captions: SRT import + manual text ─────────────────
  // Both bypass transcription entirely (no auth, no quota minutes) and
  // produce a whisper-shaped {segments:[{text,start,end}]} in concat-time.
  // extractWords' segment-level fallback distributes word timings evenly
  // inside each segment, and groupWords' segIdx break keeps each SRT cue
  // (or typed line) as its own caption unless it exceeds maxChars.

  // Parses SubRip (.srt). Returns [{text, start, end}] (seconds).
  function parseSrt(raw) {
    var text = String(raw || '')
      .replace(/^/, '')
      .replace(/\u0000/g, '')
      .replace(/\r\n?/g, '\n');
    // VTT is intentionally unsupported in Orbit Premiere's SRT-only flow.
    if (/^\s*WEBVTT\b/i.test(text)) return [];
    var cues = [];
    // Fractional seconds are optional in real-world SRT exports. Scan timing
    // lines instead of relying on blank blocks; several editors omit the blank
    // line between cues, which made the old parser see only the first cue.
    var TIME = /(?:(\d{1,2}):)?(\d{1,2}):(\d{2})(?:[.,](\d{1,3})|:(\d{2}))?/;
    var lines = text.split('\n');
    for (var i = 0; i < lines.length; i++) {
      // Accept the standard arrow plus the Unicode arrow emitted by a few
      // mobile subtitle editors. Whitespace around it is optional.
      if (!/(?:-->|->)/.test(lines[i])) continue;
      var parts = lines[i].split(/\s*(?:-->|->)\s*/);
      var m1 = TIME.exec(parts[0]); var m2 = TIME.exec(parts[1] || '');
      if (!m1 || !m2) continue;
      function toSec(m) {
        var h = parseInt(m[1] || '0', 10), mn = parseInt(m[2], 10), s = parseInt(m[3], 10);
        // Premiere exports HH:MM:SS:FF. A comma/dot triple is milliseconds.
        if (m[5] !== undefined) return h * 3600 + mn * 60 + s + parseInt(m[5], 10) / 30;
        var ms = parseInt(((m[4] || '0') + '00').slice(0, 3), 10);
        return h * 3600 + mn * 60 + s + ms / 1000;
      }
      var bodyLines = [];
      for (var j = i + 1; j < lines.length; j++) {
        var trimmed = lines[j].trim();
        if (!trimmed || /(?:-->|->)/.test(lines[j])) break;
        if (/^\d+$/.test(trimmed) && j + 1 < lines.length && /(?:-->|->)/.test(lines[j + 1])) break;
        bodyLines.push(lines[j]);
      }
      var body = bodyLines.join('\n')
        .replace(/<[^>]+>/g, '')          // strip styling tags
        .replace(/\{\\[^}]*\}/g, '')      // strip ASS-style overrides
        .trim();
      if (!body) continue;
      var cueStart = toSec(m1), cueEnd = toSec(m2);
      if (cueEnd > cueStart) cues.push({ text: body, start: cueStart, end: cueEnd });
    }
    // Script/lead-sheet fallback: files saved as .srt that carry only start
    // stamps ("START: 00:26:17" / bare "00:26:22") with the spoken line
    // underneath. No arrow means the standard scan above finds nothing, so
    // derive each cue's end from the next stamp instead of rejecting the file.
    if (!cues.length) {
      var STAMP = /^\W*(?:START|END|IN|OUT)?\s*:?\s*(\d{1,2}):(\d{1,2})(?::(\d{2}))?(?:[.,](\d{1,3}))?\s*$/i;
      var markers = [];
      for (var k = 0; k < lines.length; k++) {
        var stamp = STAMP.exec(lines[k].trim());
        if (stamp && /\d/.test(lines[k])) {
          var h2 = 0, mn2 = 0, s2 = 0;
          if (stamp[3] !== undefined) { h2 = parseInt(stamp[1], 10); mn2 = parseInt(stamp[2], 10); s2 = parseInt(stamp[3], 10); }
          else { mn2 = parseInt(stamp[1], 10); s2 = parseInt(stamp[2], 10); }
          var ms2 = parseInt(((stamp[4] || '0') + '00').slice(0, 3), 10);
          markers.push({ at: h2 * 3600 + mn2 * 60 + s2 + ms2 / 1000, text: [] });
        } else if (markers.length && lines[k].trim()) {
          markers[markers.length - 1].text.push(lines[k].trim());
        }
      }
      if (markers.length >= 2) {
        for (var q = 0; q < markers.length; q++) {
          var scriptBody = markers[q].text.join('\n')
            .replace(/<[^>]+>/g, '')
            .replace(/^["\u201C\u201D]+|["\u201C\u201D]+$/g, '')
            .trim();
          if (!scriptBody) continue;
          var scriptEnd = q + 1 < markers.length ? markers[q + 1].at : markers[q].at + 4;
          if (scriptEnd > markers[q].at) cues.push({ text: scriptBody, start: markers[q].at, end: scriptEnd });
        }
      }
    }
    cues.sort(function (a, b) { return a.start - b.start; });
    return cues;
  }

  // Slide SRT times onto the clip that is actually on the timeline.
  // Premiere and script exports often keep program TC (01:00:00:00 or
  // 00:26:17) while the clip starts at 00:00:00 - those cues land minutes
  // past the video, so word animation can never match the spoken line.
  function fitCuesToMedia(cues, mediaStart, mediaEnd) {
    if (!cues || !cues.length) return cues;
    var start0 = Number(mediaStart) || 0;
    var end0 = Number(mediaEnd);
    if (!(end0 > start0)) end0 = start0 + 86400;
    var dur = end0 - start0;
    var first = cues[0].start, last = cues[cues.length - 1].end;
    function shift(delta) {
      if (!delta) return;
      for (var i = 0; i < cues.length; i++) {
        cues[i].start -= delta;
        cues[i].end -= delta;
      }
      first = cues[0].start;
      last = cues[cues.length - 1].end;
    }
    var hour = Math.floor(first / 3600) * 3600;
    if (hour >= 3600 && (first - hour) < dur + 2) shift(hour);
    var span = Math.max(0.001, last - first);
    // Script / program TC (e.g. 00:26:17): cue span is minutes but timestamps
    // are wall-clock. A long empty sequence duration must not block this shift.
    if (first > Math.max(60, span * 1.5)) shift(first - start0);
    else if (first >= end0 - 0.04 || (first > 1.25 && first > dur)) shift(first - start0);
    else if (first < start0 - 0.25 && last <= start0 + 0.05) shift(first - start0);
    else if (Math.abs(first - start0) > 0.25 && first < 1.25) shift(first - start0);
    return cues;
  }

  function mediaWindowFromHost(seqInfo, clips) {
    var mediaStart = 0, mediaEnd = 0;
    if (seqInfo && Number(seqInfo.duration) > 0) mediaEnd = Number(seqInfo.duration);
    if (clips && clips.length) {
      for (var i = 0; i < clips.length; i++) {
        var s = Number(clips[i].timelineStart) || 0;
        var e = s + Math.max(0, (Number(clips[i].srcOut) || 0) - (Number(clips[i].srcIn) || 0));
        if (i === 0 || s < mediaStart) mediaStart = s;
        if (e > mediaEnd) mediaEnd = e;
      }
    }
    return { start: mediaStart, end: mediaEnd };
  }

  function applyFitToCaptionList(captions, mediaStart, mediaEnd) {
    if (!captions || !captions.length) return 0;
    var proxy = [];
    for (var i = 0; i < captions.length; i++) proxy.push({ start: captions[i].start, end: captions[i].end });
    fitCuesToMedia(proxy, mediaStart, mediaEnd);
    var delta = captions[0].start - proxy[0].start;
    if (Math.abs(delta) < 0.02) return 0;
    for (var c = 0; c < captions.length; c++) {
      captions[c].start -= delta;
      captions[c].end -= delta;
      var words = captions[c].words || [];
      for (var w = 0; w < words.length; w++) {
        words[w].start -= delta;
        words[w].end -= delta;
        if (words[w].startConcat != null) words[w].startConcat -= delta;
        if (words[w].endConcat != null) words[w].endConcat -= delta;
        if (words[w].timelineStart != null) words[w].timelineStart -= delta;
        if (words[w].timelineEnd != null) words[w].timelineEnd -= delta;
      }
    }
    return delta;
  }

  function _hostMediaWindow() {
    return CEP.evalScript('getTimelineVideoMediaWindow', [], 15000)
      .catch(function () { return null; })
      .then(function (win) {
        if (win && !win.error && Number(win.end) > Number(win.start)) {
          return { start: Number(win.start) || 0, end: Number(win.end) || 0 };
        }
        var track = (typeof getSelectedTrack === 'function') ? getSelectedTrack() : null;
        var trackType = (track && track.type) || 'video';
        var trackIndex = (track && typeof track.index === 'number') ? track.index : 0;
        return Promise.all([
          CEP.evalScript('getSequenceInfo', [], 8000).catch(function () { return null; }),
          CEP.evalScript('getAudioTrackClips', [trackType, trackIndex], 20000).catch(function () { return null; })
        ]).then(function (pair) {
          return mediaWindowFromHost(pair[0], pair[1]);
        });
      });
  }

  // Commit already-timed SRT cues directly to the editor. Subtitle import is
  // deliberately independent from Premiere track discovery, audio extraction,
  // transcription and the generation popup: once parseSrt succeeds the cue
  // list must appear immediately, even on an empty sequence.
  function _commitSrtImport(cues, sourceMeta) {
    console.log('[SRT Commit] _commitSrtImport called with', cues.length, 'cues');
    console.log('[SRT Commit] Source meta:', sourceMeta);
    var captions = [];
    var flatWords = [];

    (cues || []).forEach(function (cue, cueIdx) {
      console.log('[SRT Commit] Processing cue', cueIdx, ':', cue.text);
      var cueText = String(cue.text || '').trim();
      var tokens = cueText.match(/\S+/g) || [];
      var start = Number(cue.start) || 0;
      var end = Number(cue.end) || start;
      var duration = Math.max(0.001, end - start);
      var totalWeight = 0;
      var weights = tokens.map(function (token) {
        // Longer words receive slightly more of the cue duration without
        // making punctuation-heavy tokens dominate the timing.
        var weight = Math.max(1, String(token).replace(/\s/g, '').length);
        totalWeight += weight;
        return weight;
      });
      var cursor = start;
      var words = tokens.map(function (token, wordIdx) {
        var wordEnd = wordIdx === tokens.length - 1
          ? end
          : cursor + duration * (weights[wordIdx] / Math.max(1, totalWeight));
        var word = {
          word: token,
          text: token,
          start: cursor,
          end: wordEnd,
          startConcat: cursor,
          endConcat: wordEnd,
          timelineStart: cursor,
          timelineEnd: wordEnd,
          segIdx: cueIdx
        };
        cursor = wordEnd;
        flatWords.push(word);
        return word;
      });
      captions.push({ text: cueText, start: start, end: end, words: words });
    });

    generatedCaptions = captions;
    originalCaptions = JSON.parse(JSON.stringify(captions));
    generatedWords = flatWords;
    _captionSourceMeta = sourceMeta || null;
    _captionClipMap = [];
    _captionWavPath = '';
    captionSeqStart = 0;

    console.log('[SRT Commit] Caption generation complete:', captions.length, 'captions');
    console.log('[SRT Commit] First caption:', captions[0]);
    console.log('[SRT Commit] calling _autoDetectDirection...');
    _autoDetectDirection();
    console.log('[SRT Commit] calling persistCaptions...');
    persistCaptions();
    console.log('[SRT Commit] calling renderCaptionList...');
    renderCaptionList(captions);
    console.log('[SRT Commit] renderCaptionList completed');
    if (applySrtBtn) applySrtBtn.disabled = captions.length === 0;
    if (applyModel4Btn) applyModel4Btn.disabled = captions.length === 0;
    updatePostgenBar();
    _updateCaptionsFooter();
    if (typeof _m4StartPreview === 'function') _m4StartPreview();
    setWorking(false);
    switchAcTab('captions');
    setStatus(
      'success',
      'Imported ' + captions.length + ' timed cue(s) from ' +
        ((sourceMeta && sourceMeta.name) || 'subtitle file') + '.'
    );
    console.log('[SRT Commit] Import process completed successfully');

    // Sequence dimensions only affect the later style/apply stage. Refresh
    // them best-effort after rendering, never as a prerequisite for import.
    console.log('[SRT Commit] Fetching sequence info...');
    CEP.evalScript('getSequenceInfo', [], 5000).then(function (si) {
      console.log('[SRT Commit] Sequence info:', si);
      try {
        if (si && si.width && !si.error) captionSeqW = si.width;
        if (si && si.height && !si.error) captionSeqH = si.height;
        persistCaptions();
        console.log('[SRT Commit] Sequence dimensions updated:', captionSeqW, 'x', captionSeqH);
      } catch (e) {
        console.error('[SRT Commit] Error updating sequence dimensions:', e);
      }
    }).catch(function (e) {
      console.error('[SRT Commit] Error fetching sequence info:', e);
    });
    return captions;
  }

  // Decode subtitle files by BOM/content rather than forcing UTF-8. Premiere,
  // Subtitle Edit and macOS tools commonly export UTF-16LE SRT files; reading
  // those as UTF-8 inserts NULs between every character and yields zero cues.
  function decodeSubtitleBuffer(buffer) {
    var bytes = new Uint8Array(buffer || new ArrayBuffer(0));
    var enc = 'utf-8'; var offset = 0;
    if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) { enc = 'utf-16le'; offset = 2; }
    else if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) { enc = 'utf-16be'; offset = 2; }
    else if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) { offset = 3; }
    else {
      var evenNul = 0, oddNul = 0, sample = Math.min(bytes.length, 200);
      for (var ni = 0; ni < sample; ni++) {
        if (bytes[ni] === 0) { if (ni % 2) oddNul++; else evenNul++; }
      }
      if (oddNul > sample / 8) enc = 'utf-16le';
      else if (evenNul > sample / 8) enc = 'utf-16be';
    }
    if (typeof TextDecoder !== 'undefined') {
      try { return new TextDecoder(enc).decode(bytes.subarray(offset)); } catch (_) {}
    }
    if (enc === 'utf-16le' || enc === 'utf-16be') {
      var out = '';
      for (var ui = offset; ui + 1 < bytes.length; ui += 2) {
        out += String.fromCharCode(enc === 'utf-16le'
          ? bytes[ui] | (bytes[ui + 1] << 8)
          : (bytes[ui] << 8) | bytes[ui + 1]);
      }
      return out;
    }
    var binary = '';
    for (var bi = offset; bi < bytes.length; bi += 0x8000) {
      binary += String.fromCharCode.apply(null, bytes.subarray(bi, Math.min(bytes.length, bi + 0x8000)));
    }
    try { return decodeURIComponent(escape(binary)); } catch (_) { return binary; }
  }

  // Estimate how long a piece of text takes to *speak*, in seconds. Used
  // to time typed captions: raw character count is a poor proxy ("strength"
  // is 8 letters but ~1 syllable and quick; "area" is 4 letters but ~3
  // syllables and slower). Spoken duration tracks SYLLABLES, which we
  // estimate from each word's letters, convert at a natural narration pace,
  // and pad with a small per-word onset for the gap between words.
  var SYLLABLES_PER_SEC = 4.2;   // ~250 syllables/min - relaxed speech
  var WORD_ONSET_SEC    = 0.12;  // inter-word articulation gap
  var MIN_TEXT_SEC      = 0.7;   // floor so a caption never flashes too fast

  function _countSyllables(word) {
    // Digits are spoken too, so they must add time - otherwise a caption
    // like "In 2024 we grew 300%" counts as almost nothing and flashes by.
    // ~one syllable per digit (a fair middle between digit-by-digit and
    // grouped readings). Covers Latin 0-9, Arabic-Indic ٠-٩, Persian ۰-۹.
    var digits = (word.match(/[0-9٠-٩۰-۹]/g) || []).length;

    // Arabic (and other Arabic-script) text is normally written without
    // short-vowel marks, so the letter count is itself a decent syllable
    // proxy - roughly one syllable per two letters.
    if (/[؀-ۿݐ-ݿ]/.test(word)) {
      var arLetters = (word.match(/[ء-يٱ-ۓ]/g) || []).length;
      var arSyl = arLetters ? Math.max(1, Math.round(arLetters * 0.5)) : 0;
      return arSyl + digits;
    }
    // Latin: each contiguous run of vowels ≈ one syllable, minus a silent
    // trailing "e". Clamped to at least 1 for any word with letters.
    var w = word.toLowerCase().replace(/[^a-z]/g, '');
    var n = 0;
    if (w) {
      var groups = w.match(/[aeiouy]+/g);
      n = groups ? groups.length : 0;
      if (n > 1 && /e$/.test(w)) n--;
      n = Math.max(1, n);
    }
    return n + digits;
  }

  function estimateTextSeconds(text) {
    var words = String(text == null ? '' : text).trim().split(/\s+/);
    var secs = 0;
    for (var i = 0; i < words.length; i++) {
      var syl = _countSyllables(words[i]);
      if (syl > 0) secs += WORD_ONSET_SEC + syl / SYLLABLES_PER_SEC;
    }
    return Math.max(secs, MIN_TEXT_SEC);
  }

  // Distributes typed lines across detected speech regions, weighted by
  // each line's estimated spoken duration. Returns whisper-shaped segments
  // in concat-time.
  function allocateLinesToSpeech(lines, silences, totalDur) {
    var regions = []; var cur = 0;
    (silences || []).forEach(function (s) {
      if (s.start > cur) regions.push({ start: cur, end: s.start });
      cur = Math.max(cur, s.end);
    });
    if (cur < totalDur) regions.push({ start: cur, end: totalDur });
    if (!regions.length) regions = [{ start: 0, end: totalDur }];
    var speechTotal = 0;
    regions.forEach(function (r) { speechTotal += (r.end - r.start); });
    function mapOff(off) {
      for (var i = 0; i < regions.length; i++) {
        var d = regions[i].end - regions[i].start;
        if (off <= d) return regions[i].start + off;
        off -= d;
      }
      return regions[regions.length - 1].end;
    }
    // Give each line its ESTIMATED spoken length and lay them out back-to-back
    // from the start of the speech - do NOT stretch a short phrase to fill the
    // whole clip (that's what made a few typed words span the entire 24s).
    // Only compress (never inflate) when the text genuinely can't fit the
    // available speech; the user drags them to the exact spot afterwards.
    var weights = lines.map(function (l) { return estimateTextSeconds(l); });
    var estTotal = weights.reduce(function (a, b) { return a + b; }, 0) || MIN_TEXT_SEC;
    var scale = estTotal > speechTotal ? (speechTotal / estTotal) : 1;
    var segs = []; var cursor = 0;
    lines.forEach(function (l, i) {
      var dur = weights[i] * scale;
      segs.push({ text: l, start: mapOff(cursor), end: mapOff(Math.min(cursor + dur, speechTotal)) });
      cursor += dur;
    });
    return segs;
  }

  // Shared runner: same clip/audio prep as _runGenerationInner, then the
  // source-specific segment builder instead of Whisper.
  // kind: 'srt' (payload = cues) | 'text' (payload = lines)
  function _runManualFlow(kind, payload, sourceMeta) {
    setStatus('working', 'Loading track info...');
    setWorking(true, 'Preparing...');
    generatedCaptions = [];
    _captionSourceMeta = sourceMeta || null;
    localStorage.removeItem('machicut_captions');
    renderCaptionList([]);
    applySrtBtn.disabled = true;
    if (applyModel4Btn) applyModel4Btn.disabled = true;

    var maxChars = maxCharsInputEl ? (parseInt(maxCharsInputEl.value, 10) || 80) : parseInt(maxCharsSlider.value, 10);
    var maxLines = maxLinesSelectEl ? (parseInt(maxLinesSelectEl.value, 10) || 2) : parseInt(maxLinesSlider.value, 10);
    var maxGap   = gapSlider ? parseFloat(gapSlider.value) : 0.2;
    var wavPath  = '';
    var clipMap  = null;

    CEP.evalScript('getSequenceInfo', [], 5000).then(function (si) {
      try {
        if (si && si.width  && !si.error) captionSeqW = si.width;
        if (si && si.height && !si.error) captionSeqH = si.height;
      } catch (_) {}
    }).catch(function () {});

    // Clips are OPTIONAL for typed/imported captions - they only refine
    // WHERE captions land and (for typed text) let us time to speech.
    // A blank timeline is fine: you can type captions with no footage at
    // all and place them afterwards. So resolve clips best-effort and
    // never throw when there are none.
    var clipsPromise;
    if (kind === 'srt') {
      // Imported subtitles already contain sequence timings. Parsing and
      // editing them must not depend on Premiere audio-track detection.
      clipsPromise = Promise.resolve([]);
    } else if (trackSelectEl && trackSelectEl.value) {
      var sel = getSelectedTrack();
      clipsPromise = CEP.evalScript('getAudioTrackClips', [sel.type, sel.index], 45000)
        .catch(function () { return []; });
    } else {
      clipsPromise = CEP.evalScript('orbitGetTrackList', [], 10000)
        .then(function (result) {
          if (result && result.error) throw new Error(result.error);
          var tracks = Array.isArray(result) ? result : (result && Array.isArray(result.tracks) ? result.tracks : []);
          if (!Array.isArray(tracks) || tracks.length === 0) return [];
          var pick = null;
          for (var i = 0; i < tracks.length && !pick; i++) {
            if (tracks[i].type === 'audio') pick = tracks[i];
          }
          if (!pick) pick = tracks[0];
          return CEP.evalScript('getAudioTrackClips', [pick.type, pick.index], 45000);
        })
        .catch(function () { return []; });
    }

    clipsPromise
      .then(function (clips) {
        clips = clips || [];
        // Pure map (no ffmpeg). Empty when there's no footage -> identity
        // mapping (concatToTimeline returns times unchanged), so captions
        // land from 0s and the user drags them into place.
        clipMap = clips.length ? buildClipMap(clips) : [];
        _captionClipMap = clipMap;
        captionSeqStart = clipMap.length ? clipMap[0].timelineStart : 0;

        // SRT carry their own timings - done, no audio ever.
        if (kind === 'srt') {
          // Imported subtitle timestamps already belong to the sequence. Do
          // not map them through audio clips a second time or add the first
          // audio clip's timeline offset.
          clipMap = [];
          _captionClipMap = [];
          captionSeqStart = 0;
          return { segments: payload };
        }

        // Duration to spread typed lines over: the footage span when we
        // have it, else the sum of each line's ESTIMATED spoken duration
        // (from word length + letters) so a blank timeline yields
        // sensibly-paced, draggable captions - long lines get more time,
        // short ones less, instead of a flat per-line guess.
        var totalDur = clipMap.length
          ? clipMap[clipMap.length - 1].concatEnd
          : payload.reduce(function (a, l) { return a + estimateTextSeconds(l); }, 0);
        if (!(totalDur > 0)) totalDur = MIN_TEXT_SEC;

        // No footage -> even spacing, zero ffmpeg.
        if (!clips.length) {
          return { segments: allocateLinesToSpeech(payload, [], totalDur) };
        }

        // Footage present -> best-effort speech timing; fall back to even
        // spacing if the track has no usable audio or ffmpeg fails.
        setStatus('working', 'Placing captions...');
        return CEP.evalScript('getTempDir', [], 10000)
          .then(function (tmpDir) {
            var wp = (tmpDir + '/machicut_caption_audio.mp3').replace(/\\/g, '/');
            return FFmpegAPI.extractSegments(clips, wp)
              .then(function () { return FFmpegAPI.detectSilence(wp, -35, 0.35); })
              .then(function (silences) {
                _captionWavPath = wp;
                return { segments: allocateLinesToSpeech(payload, silences || [], totalDur) };
              });
          })
          .catch(function () {
            setStatus('working', 'Placing captions evenly...');
            return { segments: allocateLinesToSpeech(payload, [], totalDur) };
          });
      })
      .then(function (whisperLike) {
        _completeGeneration(whisperLike, clipMap, maxChars, maxLines, maxGap);
      })
      .catch(function (err) {
        setWorking(false);
        var msg = (err && err.message) || 'Could not build captions.';
        setStatus('error', msg);
        // The status bar auto-dismisses - surface it where it stays.
        if (typeof window.showAlert === 'function') window.showAlert(msg);
      });
  }

  // Pure clip-time -> timeline-time map. Mirrors the arithmetic inside
  // FFmpegAPI.extractSegments EXACTLY, but does no audio work - so
  // typed/imported captions never touch ffmpeg. Fields come from
  // getAudioTrackClips (srcIn/srcOut/timelineStart).
  function buildClipMap(clips) {
    var map = [];
    var concatOffset = 0;
    for (var i = 0; i < clips.length; i++) {
      var clip = clips[i];
      if (i > 0) {
        var prev    = clips[i - 1];
        var prevEnd = prev.timelineStart + (prev.srcOut - prev.srcIn);
        var gap     = clip.timelineStart - prevEnd;
        if (gap > 0.001) concatOffset += gap;
      }
      var segDuration = clip.srcOut - clip.srcIn;
      map.push({
        concatStart:   concatOffset,
        concatEnd:     concatOffset + segDuration,
        timelineStart: clip.timelineStart
      });
      concatOffset += segDuration;
    }
    return map;
  }

  // UI wiring - entry points live on the CAPTIONS (edit) page:
  //   • empty state: "Import SRT" + "Type manually" action buttons
  //   • postgen toolbar: SRT icon button (redo path when captions exist)
  //   • "Type manually" opens a dedicated gen-popup-styled modal
  (function _initManualCaptionUI() {
    var manualPopup = document.getElementById('ac-manual-popup');
    var manualClose = document.getElementById('ac-manual-close');
    var manualInput = document.getElementById('ac-manual-input');
    var manualGo    = document.getElementById('ac-manual-go');
    var manualCount = document.getElementById('ac-manual-count');
    var srtToolBtn  = document.getElementById('ac-import-srt-btn');
    if (!manualPopup || !manualGo) return;

    // Same trick as the generate popup: hoist to <body> so the fixed
    // overlay renders above everything regardless of active panel.
    if (manualPopup.parentNode !== document.body) {
      document.body.appendChild(manualPopup);
    }

    // Browser fallback input. Premiere's embedded CEP browser can silently
    // ignore a programmatic input.click(), so the native CEP picker below is
    // the primary path; this input keeps plain-browser previews working.
    var srtFile = document.createElement('input');
    srtFile.type = 'file';
    srtFile.accept = '.srt,.SRT,application/x-subrip,text/srt';
    srtFile.style.display = 'none';
    document.body.appendChild(srtFile);
    var srtPickerBusy = false;
    var srtPickerStartedAt = 0;

    function consumeSubtitleData(data, sourceName) {
      try {
        console.log('[SRT Import] Starting import for:', sourceName);
        console.log('[SRT Import] Data type:', typeof data);
        console.log('[SRT Import] Data length:', data ? data.length : 0);

        if (sourceName && !/\.srt$/i.test(String(sourceName))) throw new Error('Only .srt subtitle files are supported.');
        var subtitleText = typeof data === 'string' ? data : decodeSubtitleBuffer(data);
        console.log('[SRT Import] Decoded text length:', subtitleText.length);
        console.log('[SRT Import] First 200 chars:', subtitleText.substring(0, 200));

        var cues = parseSrt(subtitleText);
        console.log('[SRT Import] Parsed cues count:', cues.length);
        if (!cues.length) {
          throw new Error('No captions found in ' + (sourceName || 'that file') + '. Check that it is a valid SRT file.');
        }
        console.log('[SRT Import] First cue:', cues[0]);

        var cleanName = sourceName || 'subtitle file';
        setStatus('working', 'Importing ' + cues.length + ' cue(s)...');
        setWorking(true, 'Importing SRT...');
        _hostMediaWindow()
          .then(function (win) {
            if (win && win.end > win.start) fitCuesToMedia(cues, win.start, win.end);
          })
          .catch(function () {})
          .then(function () {
            var sourceMeta = {
              kind: 'subtitle',
              name: cleanName,
              cueCount: cues.length,
              start: cues[0].start,
              end: cues[cues.length - 1].end
            };
            _commitSrtImport(cues, sourceMeta);
          });
        return;
      } catch (err) {
        console.error('[SRT Import] Error:', err);
        setWorking(false);
        var message = err && err.message ? err.message : String(err);
        setStatus('error', message);
        if (typeof global.showAlert === 'function') global.showAlert(message);
      } finally {
        srtPickerBusy = false;
        srtPickerStartedAt = 0;
      }
    }

    function readNativeSubtitlePath(filePath) {
      try {
        console.log('[SRT Read] readNativeSubtitlePath called with:', filePath);
        var normalizedPath = String(filePath || '');
        console.log('[SRT Read] Initial path:', normalizedPath);
        // Some CEP builds return a file:// URL instead of a POSIX path.
        if (/^file:\/\//i.test(normalizedPath)) {
          normalizedPath = decodeURIComponent(normalizedPath.replace(/^file:\/\/(?:localhost)?/i, ''));
          console.log('[SRT Read] Decoded file:// URL:', normalizedPath);
        }
        // Node on Windows does not consistently accept /C:/... in older CEP
        // runtimes, although CEP itself often returns that form for file URLs.
        if (/^\/[A-Za-z]:[\\/]/.test(normalizedPath)) {
          normalizedPath = normalizedPath.slice(1);
          console.log('[SRT Read] Removed leading slash:', normalizedPath);
        }
        var sourceName = normalizedPath.split(/[\\/]/).pop();
        console.log('[SRT Read] Source name:', sourceName);
        if (!normalizedPath) throw new Error('The subtitle chooser returned an empty path.');

        // Read bytes first so the BOM-aware decoder preserves UTF-16 subtitles.
        if (typeof require === 'function') {
          var subtitleBytes = null;
          try { subtitleBytes = require('fs').readFileSync(normalizedPath); } catch (_) {}
          if (subtitleBytes !== null) {
            consumeSubtitleData(subtitleBytes, sourceName);
            return true;
          }
        }
        // Use CEP's own filesystem as a fallback. It understands paths returned
        // by showOpenDialogEx and gives us decoded text directly. Node remains
        // a fallback for hosts where cep.fs.readFile is unavailable.
        var cepFs = global.cep && global.cep.fs;
        console.log('[SRT Read] CEP FS available:', !!cepFs);
        if (cepFs && typeof cepFs.readFile === 'function') {
          console.log('[SRT Read] Attempting CEP readFile...');
          var result = cepFs.readFile(normalizedPath);
          if (result && result.err === 0 && result.data != null) {
            console.log('[SRT Read] CEP read successful, data length:', result.data.length);
            consumeSubtitleData(result.data, sourceName);
            return true;
          } else {
            console.log('[SRT Read] CEP read failed, err:', result ? result.err : 'unknown');
          }
        }
        if (typeof require === 'function') {
          console.log('[SRT Read] Attempting Node.js require fallback...');
          var nativeFs = require('fs');
          var nodeData = nativeFs.readFileSync(normalizedPath);
          console.log('[SRT Read] Node.js read successful, data length:', nodeData.length);
          consumeSubtitleData(nodeData, sourceName);
          return true;
        }
        throw new Error('Local file access is unavailable or the selected file could not be read.');
      } catch (err) {
        srtPickerBusy = false;
        srtPickerStartedAt = 0;
        var message = 'Could not read subtitle file: ' + (err && err.message ? err.message : String(err));
        setStatus('error', message);
        if (typeof global.showAlert === 'function') global.showAlert(message);
        return false;
      }
    }

    function openSrtPicker(event) {
      console.log('[SRT Picker] openSrtPicker called');
      if (event) {
        if (event.preventDefault) event.preventDefault();
        if (event.stopPropagation) event.stopPropagation();
      }
      // CEP sometimes dispatches a second click while the OS chooser is
      // active. One lock and one picker path means one user click = one dialog.
      // Recover automatically if CEP swallowed a previous chooser callback.
      if (srtPickerBusy && Date.now() - srtPickerStartedAt < 3000) {
        console.log('[SRT Picker] Picker busy, ignoring click');
        return;
      }
      srtPickerBusy = true;
      srtPickerStartedAt = Date.now();
      console.log('[SRT Picker] Opening file picker...');
      var cepFs = global.cep && global.cep.fs;
      console.log('[SRT Picker] CEP FS available:', !!cepFs);
      if (cepFs && typeof cepFs.showOpenDialogEx === 'function') {
        try {
          var picked = cepFs.showOpenDialogEx(
            false, false, 'Import subtitle file (SRT)', '', ['srt']
          );
          console.log('[SRT Picker] Picker result:', picked);
          if (picked && picked.err === 0 && picked.data && picked.data.length) {
            console.log('[SRT Picker] File selected:', picked.data[0]);
            var pickedPath = picked.data;
            // CEP has returned a real Array, an array-like host object and a
            // plain string across different Premiere releases.
            if (typeof pickedPath !== 'string' && pickedPath.length != null) pickedPath = pickedPath[0];
            console.log('[SRT Picker] Final path to read:', pickedPath);
            readNativeSubtitlePath(pickedPath);
          } else if (picked && picked.err && picked.err !== 0) {
            throw new Error('Subtitle chooser failed (code ' + picked.err + ').');
          }
        } catch (nativeErr) {
          var nativeMessage = 'Could not open the subtitle chooser: ' +
            (nativeErr && nativeErr.message ? nativeErr.message : String(nativeErr));
          setStatus('error', nativeMessage);
          if (typeof global.showAlert === 'function') global.showAlert(nativeMessage);
        } finally {
          srtPickerBusy = false;
          srtPickerStartedAt = 0;
        }
        return; // Never open the browser picker after CEP already attempted one.
      }

      console.log('[SRT Picker] CEP not available, using browser fallback');
      srtFile.value = '';
      console.log('[SRT Picker] Using browser fallback, clicking file input...');
      srtFile.click();
      // Browser fallback has no cancel callback; short debounce prevents a
      // second dialog while still allowing a retry after a cancelled chooser.
      setTimeout(function () {
        srtPickerBusy = false;
        srtPickerStartedAt = 0;
        console.log('[SRT Picker] Browser fallback timeout released');
      }, 1200);
    }

    srtFile.addEventListener('change', function () {
      console.log('[SRT Picker] Browser file input change event');
      srtPickerBusy = false;
      srtPickerStartedAt = 0;
      var f = srtFile.files && srtFile.files[0];
      console.log('[SRT Picker] Selected file:', f ? f.name : 'none');
      if (!f) return;
      var reader = new FileReader();
      reader.onload = function () {
        console.log('[SRT Picker] File read complete, size:', reader.result.length);
        consumeSubtitleData(reader.result, f.name);
      };
      reader.onerror = function () {
        console.error('[SRT Picker] File read error');
        var message = 'Could not read the selected subtitle file.';
        setStatus('error', message);
        if (typeof global.showAlert === 'function') global.showAlert(message);
      };
      reader.readAsArrayBuffer(f);
    });

    // Exposed for diagnostics and any future toolbar entry points.
    global.OrbitSubtitleImport = {
      open: openSrtPicker,
      parse: parseSrt,
      decode: decodeSubtitleBuffer,
      importData: consumeSubtitleData
    };

    // Direction toggle - typing comfort only (caption direction is still
    // auto-detected from the text downstream). Placeholder doubles as an
    // example and follows the chosen script.
    var MANUAL_DIR_KEY = 'machicut_manual_dir';
    var rtlBtn = document.getElementById('ac-manual-rtl');
    var ltrBtn = document.getElementById('ac-manual-ltr');
    var PLACEHOLDER_RTL = 'مرحباً بكم في هذا الفيديو\nاليوم راح نتعلم شيء جديد\nلا تنسى الاشتراك';
    var PLACEHOLDER_LTR = 'Welcome to this video\nToday we learn something new\nDon\'t forget to subscribe';
    function _setManualDir(dir) {
      try { localStorage.setItem(MANUAL_DIR_KEY, dir); } catch (_) {}
      if (manualInput) {
        manualInput.dir = dir;
        manualInput.placeholder = (dir === 'rtl') ? PLACEHOLDER_RTL : PLACEHOLDER_LTR;
      }
      if (rtlBtn) rtlBtn.classList.toggle('active', dir === 'rtl');
      if (ltrBtn) ltrBtn.classList.toggle('active', dir !== 'rtl');
    }
    if (rtlBtn) rtlBtn.addEventListener('click', function () { _setManualDir('rtl'); });
    if (ltrBtn) ltrBtn.addEventListener('click', function () { _setManualDir('ltr'); });
    // Default: last choice, else the panel-wide caption direction pref.
    _setManualDir((function () {
      try { return localStorage.getItem(MANUAL_DIR_KEY) || (textDirection === 'rtl' ? 'rtl' : 'ltr'); }
      catch (_) { return 'rtl'; }
    })());

    function openManualPopup() {
      manualPopup.classList.remove('hidden');
      _updateManualCount();
      setTimeout(function () { if (manualInput) manualInput.focus(); }, 50);
    }
    function closeManualPopup() {
      manualPopup.classList.add('hidden');
    }
    function _manualLines() {
      return (manualInput && manualInput.value || '').split('\n')
        .map(function (l) { return l.trim(); })
        .filter(function (l) { return l.length > 0; });
    }
    function _updateManualCount() {
      if (!manualCount) return;
      var n = _manualLines().length;
      manualCount.textContent = n + (n === 1 ? ' line' : ' lines');
      manualGo.disabled = (n === 0);
    }

    if (manualClose) manualClose.addEventListener('click', closeManualPopup);
    manualPopup.addEventListener('click', function (e) {
      if (e.target === manualPopup) closeManualPopup();   // click outside card
    });
    if (manualInput) manualInput.addEventListener('input', _updateManualCount);
    manualGo.addEventListener('click', function () {
      var lines = _manualLines();
      if (!lines.length) return;
      closeManualPopup();
      _runManualFlow('text', lines);
    });

    // One capture listener handles both the static toolbar button and the
    // empty-state button that renderCaptionList recreates. Mark the event so
    // no legacy/bubbled listener can open a second chooser.
    if (!document.__orbitSrtClickBound) {
      document.__orbitSrtClickBound = true;
      document.addEventListener('click', function (e) {
        var node = e.target;
        while (node && node !== document && node.tagName !== 'BUTTON') node = node.parentNode;
        if (!node || node === document) return;
        if (node.id === 'ac-empty-import-srt' || node.id === 'ac-import-srt-btn') {
          if (e.stopImmediatePropagation) e.stopImmediatePropagation();
          openSrtPicker(e);
        } else if (node.id === 'ac-empty-manual') openManualPopup();
        else if (node.id === 'ac-empty-srt-animator') {
          // Use one SRT path: it preserves timing, shows the cue list, then
          // lets the user choose the normal Caption Style templates before Apply.
          if (global.OrbitSubtitleImport && typeof global.OrbitSubtitleImport.open === 'function') {
            global.OrbitSubtitleImport.open(e);
          } else {
            console.error('OrbitSubtitleImport is not available');
          }
        }
        else if (node.id === 'ac-empty-generate') {
          var genOpen = document.getElementById('ac-open-gen-popup');
          if (genOpen) genOpen.click();
        }
      }, true);
    }
  })();

  // ── Parse Whisper verbose_json -> caption segments ─────────────────────────

  // Whisper's DTW-based word timestamps absorb adjacent silence into the
  // word boundaries. Two patterns:
  //
  //   1. Word starts: silence preceding a word gets pulled into that word's
  //      start. e.g. "interesting" in "I find it quite ... interesting" gets
  //      start = inside the 2-second pause, so the highlight jumps to it
  //      before the speaker actually says it.
  //
  //   2. Word ends: silence following a word gets pulled into that word's
  //      end. Most common on the last word of a phrase or the very last
  //      word of the clip. The previous-word highlight lingers past the
  //      moment the speaker stopped.
  //
  // Fix: detect real silence regions on the same audio via FFmpeg, then for
  // each Whisper word:
  //   - If word.start lies inside a silence -> snap forward to silence end.
  //   - If word.end   lies inside a silence -> snap back to silence start.
  // Mutates seg.words in place; safe because nothing else reads those
  // values before extractWords runs.
  function snapWhisperWordsToSilence(whisperData, silences) {
    if (!silences || !silences.length || !whisperData.segments) return whisperData;
    whisperData.segments.forEach(function (seg) {
      if (!seg.words) return;
      seg.words.forEach(function (w) {
        // ── Pick a snap target for word.start ──
        // Two situations both mean "real speech starts later than reported":
        //   A. word.start lies INSIDE a silence
        //      [silence) [..word..)         <- start in silence
        //      DTW pulled the start a bit into a leading silence.
        //   B. silence lies fully INSIDE word's reported window
        //      [..word.... [silence) ....)  <- silence sandwiched
        //      DTW pulled start way back, sometimes into the previous
        //      word's speech region. The actual phoneme onset is
        //      after the silence ends.
        //
        // In both cases we want word.start = silence.end. If multiple
        // silences qualify (rare), take the LATEST end - the actual
        // speech can't precede the most recent qualifying silence.
        var bestStart = w.start;
        for (var i = 0; i < silences.length; i++) {
          var s = silences[i];
          var startInSilence    = (w.start >= s.start && w.start < s.end);
          var silenceInsideWord = (s.start >  w.start && s.end   <  w.end);
          if (startInSilence || silenceInsideWord) {
            if (s.end > bestStart) bestStart = s.end;
          }
        }
        if (bestStart > w.start) {
          if (bestStart >= w.end - 0.05) bestStart = w.end - 0.05;
          if (bestStart > w.start) w.start = bestStart;
        }

        // ── Snap end backward if it sits inside a silence ─────────────
        // Catches words whose tail extends into the silence that follows
        // them - typical for last-of-phrase and last-of-clip words.
        for (var j = 0; j < silences.length; j++) {
          var s2 = silences[j];
          if (w.end > s2.start && w.end <= s2.end) {
            var snappedEnd = s2.start;
            if (snappedEnd <= w.start + 0.05) snappedEnd = w.start + 0.05;
            if (snappedEnd < w.end) w.end = snappedEnd;
            break; // end can only be in one silence
          }
        }
      });
    });
    return whisperData;
  }

  // Converts a timestamp in the concatenated audio -> timeline position using the clipMap.
  // Concat audio includes silence pads matching timeline gaps, but those silences are
  // NOT in clipMap entries. If a Whisper word boundary lands in a silence pad (rare,
  // but can happen due to VAD ε), snap it forward to the next clip's start so the
  // caption doesn't end up rendered in the gap.
  function concatToTimeline(t, clipMap) {
    if (!clipMap || clipMap.length === 0) return t;
    for (var i = 0; i < clipMap.length; i++) {
      if (t < clipMap[i].concatStart) {
        // Falls in silence pad before this clip -> snap to clip start
        return clipMap[i].timelineStart;
      }
      if (t <= clipMap[i].concatEnd) {
        var local = t - clipMap[i].concatStart;
        var concatLen = clipMap[i].concatEnd - clipMap[i].concatStart;
        var tlDur = clipMap[i].timelineDur != null ? clipMap[i].timelineDur : concatLen;
        if (concatLen > 0 && Math.abs(concatLen - tlDur) > 0.05) {
          return clipMap[i].timelineStart + local * (tlDur / concatLen);
        }
        return clipMap[i].timelineStart + local;
      }
    }
    // Past the last clip's end - clamp to last clip's timeline end
    var last = clipMap[clipMap.length - 1];
    return last.timelineStart + (last.concatEnd - last.concatStart);
  }

  // Extracts flat word array from Whisper verbose_json.
  // Each word is tagged with segIdx so groupWords can force a caption break
  // at every Whisper segment boundary (segments reflect real speech regions).
  // First/last words of each segment are clamped to segment timings - those
  // are accurate, while word-level timestamps inside a segment are compressed.
  function extractWords(whisperData, clipMap) {
    var words = [];
    if (!whisperData.segments) return words;
    whisperData.segments.forEach(function (seg, segIdx) {
      if (seg.words && seg.words.length > 0) {
        seg.words.forEach(function (w, idx) {
          var rawStart = w.start;
          var rawEnd   = w.end;
          if (idx === 0)                       rawStart = Math.max(rawStart, seg.start);
          if (idx === seg.words.length - 1)    rawEnd   = Math.max(rawEnd,   seg.end);
          words.push({
            word:   w.word.trim(),
            start:  concatToTimeline(rawStart, clipMap),
            end:    concatToTimeline(rawEnd,   clipMap),
            segIdx: segIdx
          });
        });
      } else {
        // Segment-level fallback (no word timestamps)
        var segWords = seg.text.trim().split(/\s+/);
        var segDur   = (seg.end - seg.start) / segWords.length;
        segWords.forEach(function (w, idx) {
          words.push({
            word:   w,
            start:  concatToTimeline(seg.start + idx * segDur,       clipMap),
            end:    concatToTimeline(seg.start + (idx + 1) * segDur, clipMap),
            segIdx: segIdx
          });
        });
      }
    });
    return words;
  }

  // Groups words into caption segments
  function groupWords(words, maxWords, maxGap, maxChars, maxLines) {
    if (words.length === 0) return [];
    var captions = [];
    var group    = [];
    var groupCharCount = 0;
    for (var i = 0; i < words.length; i++) {
      var w = words[i];
      var addedChars  = (group.length > 0 ? 1 : 0) + w.word.length; // space + word
      var prev        = group.length > 0 ? group[group.length - 1] : null;
      var gapExceeded = prev && (w.start - prev.end) > maxGap;
      var segChanged  = prev && w.segIdx !== undefined && prev.segIdx !== undefined && w.segIdx !== prev.segIdx;
      var groupFull   = group.length >= maxWords;
      var charsFull   = maxChars > 0 && group.length > 0 && (groupCharCount + addedChars) > maxChars;
      if ((gapExceeded || segChanged || groupFull || charsFull) && group.length > 0) {
        captions.push(groupToCaption(group, maxLines));
        group = [];
        groupCharCount = 0;
        addedChars = w.word.length;
      }
      group.push(w);
      groupCharCount += addedChars;
    }
    if (group.length > 0) captions.push(groupToCaption(group, maxLines));
    return captions;
  }

  function groupToCaption(group, maxLines) {
    var wordStrings = group.map(function (w) { return w.word; });
    var text;
    if (maxLines && maxLines >= 2 && wordStrings.length > maxLines) {
      var wordsPerLine = Math.ceil(wordStrings.length / maxLines);
      var lines = [];
      for (var i = 0; i < wordStrings.length; i += wordsPerLine) {
        lines.push(wordStrings.slice(i, i + wordsPerLine).join(' '));
      }
      text = lines.join('\n');
    } else {
      text = wordStrings.join(' ');
    }
    return {
      text:  text,
      start: group[0].start,
      end:   group[group.length - 1].end,
      words: group.map(function (w) {
        return { word: w.word, start: w.start, end: w.end, segIdx: w.segIdx };
      })
    };
  }

  // ── Rebuild caption text from word objects (respects current maxLines) ─────
  function rebuildCaptionText(wordObjects) {
    var ml = maxLinesSelectMainEl ? (parseInt(maxLinesSelectMainEl.value, 10) || 2)
           : maxLinesSelectEl     ? (parseInt(maxLinesSelectEl.value, 10) || 2)
           : parseInt(maxLinesSlider.value, 10);
    var ws = wordObjects.map(function (w) { return w.word; });
    if (ml >= 2 && ws.length > ml) {
      var perLine = Math.ceil(ws.length / ml);
      var lines = [];
      for (var i = 0; i < ws.length; i += perLine) {
        lines.push(ws.slice(i, i + perLine).join(' '));
      }
      return lines.join('\n');
    }
    return ws.join(' ');
  }

  // ── Persist captions to localStorage ───────────────────────────────────────
  function persistCaptions() {
    console.log('[SRT Persist] persistCaptions called');
    console.log('[SRT Persist] Caption count:', generatedCaptions.length);
    try {
      var dataToSave = {
        captions:  generatedCaptions,
        originals: originalCaptions,
        words:     generatedWords,
        seqStart:  captionSeqStart,
        seqW:      captionSeqW,
        seqH:      captionSeqH,
        wavPath:   _captionWavPath,
        clipMap:   _captionClipMap,
        source:    _captionSourceMeta
      };
      console.log('[SRT Persist] Data to save size:', JSON.stringify(dataToSave).length);
      localStorage.setItem('machicut_captions', JSON.stringify(dataToSave));
      console.log('[SRT Persist] Successfully saved to localStorage');
    } catch (e) {
      console.error('[SRT Persist] Error saving to localStorage:', e);
    }
  }

  function _renderCaptionSourceSummary(captions) {
    var summary = document.getElementById('ac-import-summary');
    var hasSource = !!(_captionSourceMeta && captions && captions.length);
    if (!summary) return;
    summary.style.display = hasSource ? 'flex' : 'none';
    summary.innerHTML = '';
    if (!hasSource) return;

    var sourceType = _captionSourceMeta.kind === 'json'
      ? 'JSON'
      : 'SRT';
    var count = Number(_captionSourceMeta.cueCount || captions.length);
    var start = Number(_captionSourceMeta.start);
    var end = Number(_captionSourceMeta.end);
    if (!isFinite(start)) start = Number(captions[0].start || 0);
    if (!isFinite(end)) end = Number(captions[captions.length - 1].end || 0);

    var badge = document.createElement('span');
    badge.className = 'ac-import-summary-badge';
    badge.textContent = sourceType + ' loaded';
    var name = document.createElement('span');
    name.className = 'ac-import-summary-name';
    name.textContent = _captionSourceMeta.name || 'Imported subtitles';
    name.title = name.textContent;
    var timing = document.createElement('span');
    timing.className = 'ac-import-summary-timing';
    timing.textContent = count + (count === 1 ? ' cue' : ' cues') +
      '  •  ' + fmtTime(start) + ' -> ' + fmtTime(end);
    summary.appendChild(badge);
    summary.appendChild(name);
    summary.appendChild(timing);
  }

  // ── Render captions preview ────────────────────────────────────────────────
  function renderCaptionList(captions) {
    // Refresh image preview with the first new caption
    captionCount.textContent = captions.length;
    var editBar = document.getElementById('ac-word-edit-bar');
    if (subtitleExportBar) subtitleExportBar.style.display = captions.length ? 'flex' : 'none';
    _updateCaptionsFooter();
    _renderCaptionSourceSummary(captions);
    // Apply-page preview nav arrows depend on caption count
    if (typeof _m4UpdatePreviewNavVisibility === 'function') {
      _m4UpdatePreviewNavVisibility();
    }

    if (captions.length === 0) {
      captionsPreview.innerHTML =
        '<div class="captions-empty-state">' +
          '<div class="captions-empty-icon">Aa</div>' +
          '<div class="captions-empty-title">No captions yet</div>' +
          '<div class="captions-empty-sub">Import a timed SRT subtitle file</div>' +
          '<div class="captions-empty-actions">' +
            '<button class="btn btn-primary" id="ac-empty-import-srt">' +
              '<span class="cea-icon">SRT</span>Upload SRT</button>' +
          '</div>' +
        '</div>';
      if (editBar) editBar.style.display = 'none';
      return;
    }

    if (editBar) editBar.style.display = 'flex';

    captionsPreview.innerHTML = captions.map(function (c, bi) {
      var wordsHtml;
      if (c.words && c.words.length > 0) {
        // Determine per-line word groups from \n in c.text so Lines setting is visible
        var lineGroups = [];   // lineGroups[li] = array of word indices on that line
        if (c.text && c.text.indexOf('\n') !== -1) {
          var textLines = c.text.split('\n');
          var wi2 = 0;
          for (var tli = 0; tli < textLines.length; tli++) {
            var lineWordCount = textLines[tli].trim().split(/\s+/).filter(Boolean).length;
            var grp = [];
            for (var k = 0; k < lineWordCount && wi2 < c.words.length; k++) {
              grp.push(wi2++);
            }
            if (grp.length) lineGroups.push(grp);
          }
          // Safety: any leftover words go to last line
          while (wi2 < c.words.length) {
            lineGroups[lineGroups.length - 1].push(wi2++);
          }
        } else {
          lineGroups = [c.words.map(function (_, i) { return i; })];
        }

        wordsHtml = lineGroups.map(function (group) {
          return group.map(function (wi) {
            var w    = c.words[wi];
            var isSel = selectedWord && selectedWord.blockIdx === bi && selectedWord.wordIdx === wi;
            return '<span class="caption-word' + (isSel ? ' selected' : '') + '" data-block="' + bi + '" data-word="' + wi + '">' + escapeHtml(w.word) + '</span>';
          }).join(' ');
        }).join('<br>');
      } else {
        wordsHtml = escapeHtml(c.text || '').replace(/\n/g, '<br>');
      }
      // Pencil icon opens the advanced per-caption editor popup. Hidden
      // when we don't have the source audio cached (e.g. captions imported
      // from JSON) - the popup is useless without playable audio.
      var canEdit = !!(_captionWavPath && c.words && c.words.length);
      var editBtn = canEdit
        ? '<button class="caption-edit-btn" data-edit-caption="' + bi + '" title="Edit caption">&#x270E;</button>'
        : '';
      return (
        '<div class="caption-item" dir="' + textDirection + '">' +
          '<div class="caption-words">' + wordsHtml + '</div>' +
          '<div class="caption-row-foot">' +
            '<div class="caption-time">' + fmtTime(c.start) + ' -> ' + fmtTime(c.end) + '</div>' +
            editBtn +
          '</div>' +
        '</div>'
      );
    }).join('');

    // Wire the pencil -> open the editor popup. Stop propagation so the
    // word-select handlers on the words above don't also fire.
    captionsPreview.querySelectorAll('.caption-edit-btn').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        var idx = parseInt(btn.getAttribute('data-edit-caption'), 10);
        if (typeof _openCaptionEditor === 'function') _openCaptionEditor(idx);
      });
    });

    captionsPreview.querySelectorAll('.caption-word').forEach(function (span) {
      var _clickTimer = null;

      span.addEventListener('click', function () {
        clearTimeout(_clickTimer);
        _clickTimer = setTimeout(function () {
          _clickTimer = null;
          var bi = parseInt(span.dataset.block, 10);
          var wi = parseInt(span.dataset.word,  10);
          if (selectedWord && selectedWord.blockIdx === bi && selectedWord.wordIdx === wi) {
            selectedWord = null;
          } else {
            selectedWord = { blockIdx: bi, wordIdx: wi };
          }
          updateWordEditButtons();
          renderCaptionList(generatedCaptions);
        }, 220);
      });

      span.addEventListener('dblclick', function (e) {
        e.stopPropagation();
        clearTimeout(_clickTimer);
        _clickTimer = null;
        var bi  = parseInt(span.dataset.block, 10);
        var wi  = parseInt(span.dataset.word,  10);
        var w   = generatedCaptions[bi].words[wi];
        var inp = document.createElement('input');
        inp.className   = 'caption-word-edit-input';
        inp.value       = w.word;
        inp.style.width = Math.max(span.offsetWidth, 40) + 'px';
        span.replaceWith(inp);
        inp.focus();
        inp.select();

        function _commit() {
          var val = inp.value.trim();
          if (val && val !== w.word) {
            w.word = val;
            var c = generatedCaptions[bi];
            c.text = _buildTextFromBounds(c.words, _getLineBoundaries(c));
            persistCaptions();
          }
          renderCaptionList(generatedCaptions);
        }
        inp.addEventListener('blur', _commit);
        inp.addEventListener('keydown', function (ke) {
          if (ke.key === 'Enter')  { inp.blur(); }
          if (ke.key === 'Escape') { inp.removeEventListener('blur', _commit); renderCaptionList(generatedCaptions); }
        });
      });
    });
  }

  // ── Word edit toolbar ──────────────────────────────────────────────────────
  var wordUpBtn    = document.getElementById('ac-word-up');
  var wordDownBtn  = document.getElementById('ac-word-down');
  var wordSplitBtn = document.getElementById('ac-word-split');
  var wordHint     = document.getElementById('ac-word-edit-hint');

  function updateWordEditButtons() {
    if (!selectedWord) {
      wordUpBtn.disabled   = true;
      wordDownBtn.disabled = true;
      if (wordSplitBtn) wordSplitBtn.disabled = true;
      wordHint.textContent = 'Click a word to select';
      return;
    }
    var bi     = selectedWord.blockIdx;
    var wi     = selectedWord.wordIdx;
    var block  = generatedCaptions[bi];
    var bounds = _getLineBoundaries(block);
    var lineIdx = _lineOfWord(bounds, wi);
    // ^ disabled only when on first line of first block
    // v disabled only when on last line of last block
    wordUpBtn.disabled   = (bi === 0 && lineIdx === 0);
    wordDownBtn.disabled = (bi >= generatedCaptions.length - 1 && lineIdx === bounds.length - 1);
    // split: disabled only when the word is the only word in the caption (nothing to split off)
    if (wordSplitBtn) wordSplitBtn.disabled = (generatedCaptions[bi].words.length <= 1);
    wordHint.textContent = block.words[wi] ? block.words[wi].word : '';
  }

  // ── Line boundary helpers ─────────────────────────────────────────────────
  // Returns [{start, end}] per line, derived from \n in c.text.
  function _getLineBoundaries(c) {
    if (!c.text || c.text.indexOf('\n') === -1) {
      return [{ start: 0, end: c.words.length - 1 }];
    }
    var textLines = c.text.split('\n');
    var bounds = [], wi = 0;
    for (var li = 0; li < textLines.length; li++) {
      var cnt = textLines[li].trim().split(/\s+/).filter(Boolean).length;
      if (cnt > 0) { bounds.push({ start: wi, end: wi + cnt - 1 }); wi += cnt; }
    }
    // absorb any leftover words into last line
    if (wi < c.words.length && bounds.length > 0) bounds[bounds.length - 1].end = c.words.length - 1;
    if (bounds.length === 0) bounds = [{ start: 0, end: c.words.length - 1 }];
    return bounds;
  }

  function _buildTextFromBounds(words, bounds) {
    return bounds.map(function (b) {
      return words.slice(b.start, b.end + 1).map(function (w) { return w.word; }).join(' ');
    }).join('\n');
  }

  function _lineOfWord(bounds, wi) {
    for (var li = 0; li < bounds.length; li++) {
      if (wi >= bounds[li].start && wi <= bounds[li].end) return li;
    }
    return 0;
  }

  // ^ - within block: shift selected word (and words before it on same line) to
  //      previous line. At first line of block: move words[0..wi] to previous block.
  wordUpBtn.addEventListener('click', function () {
    if (!selectedWord) return;
    var bi = selectedWord.blockIdx;
    var wi = selectedWord.wordIdx;
    var cur    = generatedCaptions[bi];
    var bounds = _getLineBoundaries(cur);
    var lineIdx = _lineOfWord(bounds, wi);

    if (lineIdx > 0) {
      // ── Within-block: extend previous line through wi, shrink current line ──
      var newBounds = [];
      for (var li = 0; li < bounds.length; li++) {
        if (li === lineIdx - 1) {
          newBounds.push({ start: bounds[li].start, end: wi });
        } else if (li === lineIdx) {
          if (wi + 1 <= bounds[li].end) newBounds.push({ start: wi + 1, end: bounds[li].end });
          // else line is now empty - omit it
        } else {
          newBounds.push(bounds[li]);
        }
      }
      if (newBounds.length === 0) newBounds = [{ start: 0, end: cur.words.length - 1 }];
      cur.text = _buildTextFromBounds(cur.words, newBounds);
      selectedWord = { blockIdx: bi, wordIdx: wi };
    } else {
      // ── First line of block: move words[0..wi] to previous block ────────────
      if (bi === 0) return;
      var prev    = generatedCaptions[bi - 1];
      var moving    = cur.words.slice(0, wi + 1);
      var remaining = cur.words.slice(wi + 1);
      var prevLen   = prev.words.length;

      prev.words = prev.words.concat(moving);
      prev.end   = moving[moving.length - 1].end;
      prev.text  = rebuildCaptionText(prev.words);

      if (remaining.length === 0) {
        generatedCaptions.splice(bi, 1);
      } else {
        cur.words = remaining;
        cur.start = remaining[0].start;
        cur.end   = remaining[remaining.length - 1].end;
        cur.text  = rebuildCaptionText(remaining);
      }
      selectedWord = { blockIdx: bi - 1, wordIdx: prevLen + wi };
    }

    persistCaptions();
    updateWordEditButtons();
    renderCaptionList(generatedCaptions);
  });

  // v - within block: shift selected word (and words after it on same line) to
  //      next line. At last line of block: move words[wi..end] to next block.
  wordDownBtn.addEventListener('click', function () {
    if (!selectedWord) return;
    var bi = selectedWord.blockIdx;
    var wi = selectedWord.wordIdx;
    var cur    = generatedCaptions[bi];
    var bounds = _getLineBoundaries(cur);
    var lineIdx = _lineOfWord(bounds, wi);

    if (lineIdx < bounds.length - 1) {
      // ── Within-block: shrink current line to wi-1, extend next line from wi ─
      var newBounds = [];
      for (var li = 0; li < bounds.length; li++) {
        if (li === lineIdx) {
          if (wi > bounds[li].start) newBounds.push({ start: bounds[li].start, end: wi - 1 });
          // else line is now empty - omit it
        } else if (li === lineIdx + 1) {
          newBounds.push({ start: wi, end: bounds[li].end });
        } else {
          newBounds.push(bounds[li]);
        }
      }
      if (newBounds.length === 0) newBounds = [{ start: 0, end: cur.words.length - 1 }];
      cur.text = _buildTextFromBounds(cur.words, newBounds);
      selectedWord = { blockIdx: bi, wordIdx: wi };
    } else {
      // ── Last line of block: move words[wi..end] to next block ────────────────
      if (bi >= generatedCaptions.length - 1) return;
      var next      = generatedCaptions[bi + 1];
      var moving    = cur.words.slice(wi);
      var remaining = cur.words.slice(0, wi);

      next.words = moving.concat(next.words);
      next.start = moving[0].start;
      next.text  = rebuildCaptionText(next.words);

      var newBi = bi + 1;
      if (remaining.length === 0) {
        generatedCaptions.splice(bi, 1);
        newBi = bi;
      } else {
        cur.words = remaining;
        cur.end   = remaining[remaining.length - 1].end;
        cur.text  = rebuildCaptionText(remaining);
      }
      selectedWord = { blockIdx: newBi, wordIdx: 0 };
    }

    persistCaptions();
    updateWordEditButtons();
    renderCaptionList(generatedCaptions);
  });

  // ↵ - split current caption at selected word: move words[wi..end] into a new caption below
  if (wordSplitBtn) {
    wordSplitBtn.addEventListener('click', function () {
      if (!selectedWord) return;
      var bi = selectedWord.blockIdx;
      var wi = selectedWord.wordIdx;
      var cur = generatedCaptions[bi];
      if (cur.words.length <= 1) return;

      var moving    = cur.words.slice(wi);
      var remaining = cur.words.slice(0, wi);

      var newCaption = {
        words: moving,
        start: moving[0].start,
        end:   moving[moving.length - 1].end,
        text:  rebuildCaptionText(moving)
      };

      if (remaining.length === 0) {
        // selected word is first - whole caption becomes the new one, insert empty above? No:
        // just move it as-is, nothing changes. Prevent via disabled state (words.length <= 1 check above covers wi===0 edge case for single-word captions)
        return;
      }

      cur.words = remaining;
      cur.end   = remaining[remaining.length - 1].end;
      cur.text  = rebuildCaptionText(remaining);

      generatedCaptions.splice(bi + 1, 0, newCaption);
      selectedWord = { blockIdx: bi + 1, wordIdx: 0 };

      persistCaptions();
      updateWordEditButtons();
      renderCaptionList(generatedCaptions);
    });
  }

  // ── Apply: editable Premiere caption track ────────────────────────────────
  // Native caption track = easy text/timing edits in Premiere Captions.
  // Styled PNG path stays on the Style tab (Apply styled).
  function placeEditableCaptions() {
    if (generatedCaptions.length === 0) {
      _announceApply('error', 'Import or generate captions first.');
      return;
    }
    var busyBtns = [applySrtBtn, placeEditableBtn].filter(Boolean);
    busyBtns.forEach(function (btn) { _setBtnLoading(btn, true, 'Placing...'); });
    setWorking(true, 'Placing editable captions...');
    setStatus('working', 'Aligning SRT to the timeline video...');

    _hostMediaWindow()
      .catch(function () { return { start: 0, end: 0 }; })
      .then(function (media) {
        var start = Number(media && media.start) || 0;
        var end = Number(media && media.end) || 0;
        if (end > start) {
          var fitDelta = applyFitToCaptionList(generatedCaptions, start, end);
          if (Math.abs(fitDelta) > 0.02) persistCaptions();
        }
        captionSeqStart = start;
        return CEP.evalScript('createCaptionClips', [
          JSON.stringify(generatedCaptions),
          String(captionSeqStart)
        ], 30000);
      })
      .then(function (result) {
        busyBtns.forEach(function (btn) { _setBtnLoading(btn, false); });
        setWorking(false);
        _updateCaptionsFooter();
        if (applyModel4Btn) applyModel4Btn.disabled = generatedCaptions.length === 0;
        if (result && result.error) {
          _announceApply('error', result.error);
          return;
        }
        var count = (result && result.created) || generatedCaptions.length;
              var msg = 'Editable captions placed - ' + count +
          ' cue(s). Open Window -> Text -> Captions to edit text & timing. Mute this Subtitle track before Apply styled if both would show.';
        if (result && result.note) msg += ' ' + result.note;
        _announceApply('success', msg);
      })
      .catch(function () {
        busyBtns.forEach(function (btn) { _setBtnLoading(btn, false); });
        setWorking(false);
        _updateCaptionsFooter();
        if (applyModel4Btn) applyModel4Btn.disabled = generatedCaptions.length === 0;
        _announceApply('error', 'Couldn\'t place editable captions. Save the project and try again.');
      });
  }

  applySrtBtn.addEventListener('click', placeEditableCaptions);
  if (placeEditableBtn) placeEditableBtn.addEventListener('click', placeEditableCaptions);


  // ── Model 4: Pre / Current / Post PNG nested sequence ─────────────────────
  var applyModel4Btn    = document.getElementById('ac-apply-model4-btn');
  var m4TrackSelect     = document.getElementById('m4-track');
  var popupPlaceTrack   = document.getElementById('ac-popup-place-track');

  // Keep popup "Place on" and apply footer track in sync
  if (popupPlaceTrack && m4TrackSelect) {
    popupPlaceTrack.addEventListener('change', function () {
      m4TrackSelect.value = popupPlaceTrack.value;
    });
    m4TrackSelect.addEventListener('change', function () {
      popupPlaceTrack.value = m4TrackSelect.value;
    });
  }
  var m4FontSizeEl      = document.getElementById('m4-fontsize');
  // fill/stroke/shadow now managed via state model (no per-state DOM vars needed)
  var m4PosYEl          = document.getElementById('m4-pos-y');
  var m4PosYValEl       = document.getElementById('m4-pos-y-val');
  var m4PosXEl          = document.getElementById('m4-pos-x');
  var m4PosXValEl       = document.getElementById('m4-pos-x-val');
  var m4AnimateEl       = document.getElementById('m4-animate');
  var m4WrapBtns        = document.querySelectorAll('.m4-wrap-btn');

  var m4CurInCtxBtns    = document.querySelectorAll('.m4-cur-in-ctx-btn');
  var m4BakeBtns        = document.querySelectorAll('.m4-bake-btn');
  var m4ShadowOnBtns    = document.querySelectorAll('.m4-shadow-on-btn');
  // Advanced toggle: where the drop shadow comes from.
  //   'fill'   -> shadow follows the fill silhouette (Canvas/CSS default).
  //              Thin stroke barely matters; thick stroke covers most of it.
  //   'stroke' -> shadow follows the stroked outer outline. A thick stroke
  //              + small offset produces a clean outline-shaped shadow.
  //   'both'   -> shadow applied to both the stroke pass AND the fill pass.
  //              The two layers cast shadows independently, producing a
  //              "filled" shadow that wraps the whole visible glyph
  //              instead of just an outline echo. Current default.
  var _m4ShadowFollow = 'both';
  var m4FrameWidthEl    = document.getElementById('m4-frame-width');
  var m4FrameWidthRowEl = document.getElementById('m4-frame-width-row');
  var m4LineGapEl       = document.getElementById('m4-line-gap');
  var m4LineGapValEl    = document.getElementById('m4-line-gap-val');
  // Highlight box
  var m4HlEnableEl      = document.getElementById('m4-hl-enable');
  var m4HlColorEl       = document.getElementById('m4-hl-color');
  var m4HlColor2El      = document.getElementById('m4-hl-color2');
  var m4HlFillTypeEl    = document.getElementById('m4-hl-fill-type');
  var m4HlFillAngleEl   = document.getElementById('m4-hl-fill-angle');
  var m4HlOpacityEl     = document.getElementById('m4-hl-opacity');
  var m4HlOpacityValEl  = document.getElementById('m4-hl-opacity-val');
  var m4HlRadiusEl      = document.getElementById('m4-hl-radius');
  var m4HlRadiusValEl   = document.getElementById('m4-hl-radius-val');
  var m4HlPadTopEl      = document.getElementById('m4-hl-pad-top');
  var m4HlPadTopValEl   = document.getElementById('m4-hl-pad-top-val');
  var m4HlPadBotEl      = document.getElementById('m4-hl-pad-bottom');
  var m4HlPadBotValEl   = document.getElementById('m4-hl-pad-bottom-val');
  var m4HlPadLftEl      = document.getElementById('m4-hl-pad-left');
  var m4HlPadLftValEl   = document.getElementById('m4-hl-pad-left-val');
  var m4HlPadRgtEl      = document.getElementById('m4-hl-pad-right');
  var m4HlPadRgtValEl   = document.getElementById('m4-hl-pad-right-val');
  // Caption BG (whole-phrase BG box)
  var m4CbgEnableEl     = document.getElementById('m4-cbg-enable');
  var m4CbgColorEl      = document.getElementById('m4-cbg-color');
  var m4CbgColor2El     = document.getElementById('m4-cbg-color2');
  var m4CbgFillTypeEl   = document.getElementById('m4-cbg-fill-type');
  var m4CbgFillAngleEl  = document.getElementById('m4-cbg-fill-angle');
  var m4CbgOpacityEl    = document.getElementById('m4-cbg-opacity');
  var m4CbgOpacityValEl = document.getElementById('m4-cbg-opacity-val');
  var m4CbgRadiusEl     = document.getElementById('m4-cbg-radius');
  var m4CbgRadiusValEl  = document.getElementById('m4-cbg-radius-val');
  var m4CbgPadTopEl     = document.getElementById('m4-cbg-pad-top');
  var m4CbgPadTopValEl  = document.getElementById('m4-cbg-pad-top-val');
  var m4CbgPadBotEl     = document.getElementById('m4-cbg-pad-bottom');
  var m4CbgPadBotValEl  = document.getElementById('m4-cbg-pad-bottom-val');
  var m4CbgPadLftEl     = document.getElementById('m4-cbg-pad-left');
  var m4CbgPadLftValEl  = document.getElementById('m4-cbg-pad-left-val');
  var m4CbgPadRgtEl     = document.getElementById('m4-cbg-pad-right');
  var m4CbgPadRgtValEl  = document.getElementById('m4-cbg-pad-right-val');
  var m4CbgModeEl       = document.getElementById('m4-cbg-mode');
  var m4CbgCornerEl     = document.getElementById('m4-cbg-corner');
  var m4CbgCornerRow    = document.getElementById('m4-cbg-corner-row');
  // Animation type
  var m4AnimTypeEl      = document.getElementById('m4-anim-type');
  var m4AnimBoxTypeEl   = document.getElementById('m4-anim-box-type');
  // Wrap is permanently 'fixed' - the Auto/Fixed toggle was removed
  // from the UI. Kept as a constant so the rest of the render
  // pipeline (style.wrapMode etc.) still has the field it expects.
  var _m4WrapMode       = 'fixed';
  var _m4CurInCtx       = 'off';   // 'pre' | 'post' | 'off'
  var _m4BakeCurWB      = false;   // bake cur+WB into single clip
  var _m4SeqW           = 1920;  // cached from last getSequenceInfo - used by preview
  var _m4SeqH           = 1080;
  var _m4PreviewZoom    = 0.5;
  var _m4ZoomStep       = 1.4;
  var _m4ActiveMode     = 'word'; // 'word' | 'line' | 'off' | 'solo'
  var _m4HoldSilence    = true;  // true = extend active clip to fill silence gap

  // ── Direction-dial helpers ─────────────────────────────────────────────────
  // Sets both the data-angle (read by other code) and the CSS custom
  // property --angle (used by the dial's tick to rotate visually).
  function _m4SetDial(btn, angle) {
    if (!btn) return;
    var a = ((parseInt(angle, 10) || 0) % 360 + 360) % 360;
    btn.dataset.angle = a;
    btn.style.setProperty('--angle', a + 'deg');
  }
  // Wires a circular-knob interaction onto a direction button. Click
  // anywhere inside to jump the angle, press-and-drag to rotate
  // continuously (snaps to 15° while dragging). Calls onChange(angle)
  // every time the value updates so the caller can persist the new
  // angle and re-render. 0° = up, matching CSS linear-gradient(<a>deg).
  function _m4AttachDial(btn, onChange) {
    if (!btn || btn._m4DialBound) return;
    btn._m4DialBound = true;
    function angleFromPoint(clientX, clientY) {
      var rect = btn.getBoundingClientRect();
      var dx = clientX - (rect.left + rect.width  / 2);
      var dy = clientY - (rect.top  + rect.height / 2);
      var deg = Math.atan2(dx, -dy) * 180 / Math.PI;
      return (deg + 360) % 360;
    }
    function commit(a, snap) {
      if (snap) a = Math.round(a / 15) * 15;
      a = (a + 360) % 360;
      _m4SetDial(btn, a);
      try { onChange(a); } catch (_) {}
    }
    var dragging = false;
    btn.addEventListener('mousedown', function (e) {
      // Skip when the dial is collapsed (solid mode) - width:0 children
      // can still receive events depending on browser; guard explicitly.
      var row = btn.closest('.m4-fill-row');
      if (row && !row.classList.contains('gradient')) return;
      dragging = true;
      btn.classList.add('is-dragging');
      commit(angleFromPoint(e.clientX, e.clientY), false);
      e.preventDefault();
    });
    document.addEventListener('mousemove', function (e) {
      if (!dragging) return;
      commit(angleFromPoint(e.clientX, e.clientY), true);
    });
    document.addEventListener('mouseup', function () {
      if (!dragging) return;
      dragging = false;
      btn.classList.remove('is-dragging');
    });
  }

  // ── Defaults + persist ────────────────────────────────────────────────────
  var M4_SETTINGS_KEY = 'ae_m4_settings';
  var M4_DEFAULTS = {
    fontFamily: 'Arial', fontStyle: 'bold', fontSize: 24,
    preFill:  { type: 'solid', color: '#ffffff', color2: '#aaaaaa', opacity: 100 },
    curFill:  { type: 'solid', color: '#ffe44d', color2: '#ff8800', opacity: 100 },
    postFill: { type: 'solid', color: '#ffffff', color2: '#aaaaaa', opacity: 50  },
    fillLink: 'none',
    activeMode: 'word',
    strokeLink: 'none',
    strokeCur:  { color: '#000000', opacity: 100 },
    strokePre:  { color: '#000000', opacity: 100 },
    strokePost: { color: '#000000', opacity: 100 },
    // legacy keys kept for backward-compat reads of old saves
    preColor: '#ffffff', currentColor: '#ffe44d', postColor: '#ffffff',
    postOpacity: 50, strokeColor: '#000000', strokeWidth: 0,
    posY: 70, posX: 50, animate: false, animType: 'pop',
    letterSpacing: 0, textTransform: 'none',
    typoOverrides: { pre: {}, cur: {}, post: {} },
    wrapMode: 'auto', frameWidth: 84, lineGap: 4,
    // Word Box (cur word BG)
    showHL: false, hlColor: '#ffe44d', hlOpacity: 80, hlRadius: 8,
    hlPadTop: 8, hlPadBottom: 8, hlPadLeft: 8, hlPadRight: 8,
    // Caption BG (whole-phrase)
    showCBG: false, cbgColor: '#000000', cbgOpacity: 60, cbgRadius: 12,
    cbgPadTop: 8, cbgPadBottom: 8, cbgPadLeft: 12, cbgPadRight: 12,
    cbgMode: 'full', cbgCorner: 'separate'
  };

  function _m4GetSettings() {
    return {
      fontFamily:      _m4TypoAll.fontFamily,
      fontStyle:       _m4TypoAll.fontStyle,
      fontSize:        _m4TypoAll.fontSize,
      letterSpacing:   m4LetterSpacingEl  ? parseInt(m4LetterSpacingEl.value, 10)  : M4_DEFAULTS.letterSpacing,
      textTransform:   m4TextTransformEl  ? m4TextTransformEl.value                : M4_DEFAULTS.textTransform,
      typoOverrides:   { pre: _m4TypoOverrides.pre, cur: _m4TypoOverrides.cur, post: _m4TypoOverrides.post },
      activeMode: _m4ActiveMode,
      holdSilence: _m4HoldSilence,
      fillAll: _m4FillAll,
      fillOv:  { pre: _m4FillOv.pre, cur: _m4FillOv.cur, post: _m4FillOv.post },
      preFill:  _readFill('pre'),
      curFill:  _readFill('cur'),
      postFill: _readFill('post'),
      strokeEnable: document.getElementById('m4-stroke-enable') ? document.getElementById('m4-stroke-enable').checked : true,
      shadowEnable: document.getElementById('m4-shadow-enable') ? document.getElementById('m4-shadow-enable').checked : true,
      strokeAll: _m4StrkAll,
      strokeOv:  { pre: _m4StrkOv.pre, cur: _m4StrkOv.cur, post: _m4StrkOv.post },
      strokeCur:    _readStroke('cur'),
      strokePre:    _readStroke('pre'),
      strokePost:   _readStroke('post'),
      strokeWidth:  _m4StrkAll.width,
      strokePosition: _m4StrokePos,
      // posY / posX intentionally NOT saved here. Position is a placement
      // decision (handled by the action bar) - templates carry style only.
      animate:      m4AnimateEl       ? m4AnimateEl.checked                   : M4_DEFAULTS.animate,
      animType:     m4AnimTypeEl      ? m4AnimTypeEl.value                    : M4_DEFAULTS.animType,
      animBoxType:  m4AnimBoxTypeEl   ? m4AnimBoxTypeEl.value                 : 'none',
      direction:    'auto',
      wrapMode:     _m4WrapMode,
      curInCtx:     _m4CurInCtx,
      bakeCurWB:    _m4BakeCurWB,
      shadowFollow: _m4ShadowFollow,
      frameWidth:   m4FrameWidthEl    ? parseInt(m4FrameWidthEl.value, 10)   : M4_DEFAULTS.frameWidth,
      lineGap:      m4LineGapEl       ? parseInt(m4LineGapEl.value, 10)       : M4_DEFAULTS.lineGap,
      // Highlight
      showHL:       m4HlEnableEl      ? m4HlEnableEl.checked                 : M4_DEFAULTS.showHL,
      hlFill: {
        type:   m4HlFillTypeEl  ? m4HlFillTypeEl.value                           : 'solid',
        color:  m4HlColorEl     ? m4HlColorEl.value                               : M4_DEFAULTS.hlColor,
        color2: m4HlColor2El    ? m4HlColor2El.value                              : '#ff8800',
        angle:  m4HlFillAngleEl ? (parseInt(m4HlFillAngleEl.value, 10) || 0)     : 0,
        opacity: m4HlOpacityEl  ? parseInt(m4HlOpacityEl.value, 10)              : M4_DEFAULTS.hlOpacity
      },
      hlColor:      m4HlColorEl       ? m4HlColorEl.value                    : M4_DEFAULTS.hlColor,
      hlOpacity:    m4HlOpacityEl     ? parseInt(m4HlOpacityEl.value, 10)    : M4_DEFAULTS.hlOpacity,
      hlRadius:     m4HlRadiusEl      ? parseInt(m4HlRadiusEl.value, 10)     : M4_DEFAULTS.hlRadius,
      hlPadTop:     m4HlPadTopEl  ? parseInt(m4HlPadTopEl.value, 10)  : M4_DEFAULTS.hlPadTop,
      hlPadBottom:  m4HlPadBotEl  ? parseInt(m4HlPadBotEl.value, 10)  : M4_DEFAULTS.hlPadBottom,
      hlPadLeft:    m4HlPadLftEl  ? parseInt(m4HlPadLftEl.value, 10)  : M4_DEFAULTS.hlPadLeft,
      hlPadRight:   m4HlPadRgtEl  ? parseInt(m4HlPadRgtEl.value, 10)  : M4_DEFAULTS.hlPadRight,
      // Caption BG
      showCBG:      m4CbgEnableEl     ? m4CbgEnableEl.checked                : M4_DEFAULTS.showCBG,
      cbgMode:      m4CbgModeEl      ? m4CbgModeEl.value                    : M4_DEFAULTS.cbgMode,
      cbgCorner:    m4CbgCornerEl    ? m4CbgCornerEl.value                  : M4_DEFAULTS.cbgCorner,
      cbgFill: {
        type:   m4CbgFillTypeEl  ? m4CbgFillTypeEl.value                          : 'solid',
        color:  m4CbgColorEl     ? m4CbgColorEl.value                              : M4_DEFAULTS.cbgColor,
        color2: m4CbgColor2El    ? m4CbgColor2El.value                             : '#333333',
        angle:  m4CbgFillAngleEl ? (parseInt(m4CbgFillAngleEl.value, 10) || 0)    : 0,
        opacity: 100
      },
      cbgColor:     m4CbgColorEl      ? m4CbgColorEl.value                   : M4_DEFAULTS.cbgColor,
      cbgOpacity:   m4CbgOpacityEl    ? parseInt(m4CbgOpacityEl.value, 10)   : M4_DEFAULTS.cbgOpacity,
      cbgRadius:    m4CbgRadiusEl     ? parseInt(m4CbgRadiusEl.value, 10)    : M4_DEFAULTS.cbgRadius,
      cbgPadTop:    m4CbgPadTopEl  ? parseInt(m4CbgPadTopEl.value, 10)  : M4_DEFAULTS.cbgPadTop,
      cbgPadBottom: m4CbgPadBotEl  ? parseInt(m4CbgPadBotEl.value, 10)  : M4_DEFAULTS.cbgPadBottom,
      cbgPadLeft:   m4CbgPadLftEl  ? parseInt(m4CbgPadLftEl.value, 10)  : M4_DEFAULTS.cbgPadLeft,
      cbgPadRight:  m4CbgPadRgtEl  ? parseInt(m4CbgPadRgtEl.value, 10)  : M4_DEFAULTS.cbgPadRight,
      // Shadow
      shadowAll: _m4ShadAll,
      shadowOv:  { pre: _m4ShadOv.pre, cur: _m4ShadOv.cur, post: _m4ShadOv.post },
      shadowCur:    _readShadow('cur'),
      shadowPre:    _readShadow('pre'),
      shadowPost:   _readShadow('post'),
      hlStroke:         _readBoxStroke('hl'),
      cbgStroke:        _readBoxStroke('cbg'),
      hlStrokeEnable:   (function(){ var e=document.getElementById('m4-hl-stroke-enable');  return e ? e.checked : false; })(),
      cbgStrokeEnable:  (function(){ var e=document.getElementById('m4-cbg-stroke-enable'); return e ? e.checked : false; })(),
      hlShadow:         _readBoxShadow('hl'),
      cbgShadow:        _readBoxShadow('cbg'),
      hlShadowEnable:   (function(){ var e=document.getElementById('m4-hl-shadow-enable');  return e ? e.checked : false; })(),
      cbgShadowEnable:  (function(){ var e=document.getElementById('m4-cbg-shadow-enable'); return e ? e.checked : false; })()
    };
  }

  var _m4SavingFromTpl = false;
  function _m4SaveSettings() {
    if (!_m4SavingFromTpl) {
      // User changed something manually - deselect active template
      if (_m4ActiveTplId !== null) {
        _m4ActiveTplId = null;
        try { localStorage.removeItem('ae_m4_active_tpl'); } catch (_) {}
        if (_m4TplStrip) _m4TplStrip.querySelectorAll('.m4-tpl-card').forEach(function(c) { c.classList.remove('active'); });
      }
    }
    try { localStorage.setItem(M4_SETTINGS_KEY, JSON.stringify(_m4GetSettings())); } catch(_) {}
  }

  function _m4ApplySettings(s) {
    // Restore All typography base
    _m4TypoAll.fontFamily = s.fontFamily || M4_DEFAULTS.fontFamily;
    _m4TypoAll.fontStyle  = s.fontStyle  || M4_DEFAULTS.fontStyle;
    _m4TypoAll.fontSize   = s.fontSize   || M4_DEFAULTS.fontSize;

    // Restore per-state overrides
    var ov = s.typoOverrides || M4_DEFAULTS.typoOverrides;
    _m4TypoOverrides.pre  = ov.pre  ? { fontFamily: ov.pre.fontFamily  || null, fontStyle: ov.pre.fontStyle  || null, fontSize: ov.pre.fontSize  || null } : {};
    _m4TypoOverrides.cur  = ov.cur  ? { fontFamily: ov.cur.fontFamily  || null, fontStyle: ov.cur.fontStyle  || null, fontSize: ov.cur.fontSize  || null } : {};
    _m4TypoOverrides.post = ov.post ? { fontFamily: ov.post.fontFamily || null, fontStyle: ov.post.fontStyle || null, fontSize: ov.post.fontSize || null } : {};

    // Letter spacing + text transform
    if (m4LetterSpacingEl) {
      var ls = s.letterSpacing != null ? s.letterSpacing : M4_DEFAULTS.letterSpacing;
      m4LetterSpacingEl.value = ls;
      if (m4LetterSpacingVal) m4LetterSpacingVal.textContent = ls + 'px';
    }
    if (m4TextTransformEl) {
      var ttVal = s.textTransform || M4_DEFAULTS.textTransform;
      m4TextTransformEl.value = ttVal;
      document.querySelectorAll('.m4-case-btn').forEach(function(b) {
        b.classList.toggle('active', b.getAttribute('data-case') === ttVal);
      });
    }

    // Sync font controls to "All" tab (reset to All state on restore)
    _m4TypoState = 'all';
    _m4TypoSyncControls();

    // ── Fill: restore state model (new format) or migrate from old per-state format ──
    var _defFill = M4_DEFAULTS.curFill;
    if (s.fillAll) {
      _m4FillAll = { type: s.fillAll.type || 'solid', color: s.fillAll.color || _defFill.color, color2: s.fillAll.color2 || _defFill.color2, angle: s.fillAll.angle || 0, opacity: s.fillAll.opacity != null ? s.fillAll.opacity : 100 };
      var _fov = s.fillOv || {};
      ;['pre','cur','post'].forEach(function(st) {
        var o = _fov[st] || {}; _m4FillOv[st] = { type: o.type !== undefined ? o.type : null, color: o.color !== undefined ? o.color : null, color2: o.color2 !== undefined ? o.color2 : null, angle: o.angle !== undefined ? o.angle : null, opacity: o.opacity !== undefined ? o.opacity : null };
      });
    } else {
      // Old format: derive All from curFill, set pre/post as per-state overrides
      if (!s.preFill  && s.preColor)     s.preFill  = { type: 'solid', color: s.preColor,     color2: '#aaaaaa', opacity: 100 };
      if (!s.curFill  && s.currentColor) s.curFill  = { type: 'solid', color: s.currentColor, color2: '#ff8800', opacity: 100 };
      if (!s.postFill && s.postColor)    s.postFill = { type: 'solid', color: s.postColor,    color2: '#aaaaaa', opacity: s.postOpacity != null ? s.postOpacity : 50 };
      var _cf = s.curFill  || M4_DEFAULTS.curFill;
      var _pf = s.preFill  || M4_DEFAULTS.preFill;
      var _pof= s.postFill || M4_DEFAULTS.postFill;
      _m4FillAll = { type: _cf.type || 'solid', color: _cf.color || _defFill.color, color2: _cf.color2 || _defFill.color2, angle: _cf.angle || 0, opacity: _cf.opacity != null ? _cf.opacity : 100 };
      ;['pre','cur','post'].forEach(function(st) { _m4FillOv[st] = { type: null, color: null, color2: null, angle: null, opacity: null }; });
      // Set pre overrides if different from cur
      if (_pf.color   !== _m4FillAll.color)   _m4FillOv.pre.color   = _pf.color   || '#ffffff';
      if (_pf.color2  !== _m4FillAll.color2)  _m4FillOv.pre.color2  = _pf.color2  || '#aaaaaa';
      if ((_pf.opacity != null ? _pf.opacity : 100) !== _m4FillAll.opacity) _m4FillOv.pre.opacity = _pf.opacity != null ? _pf.opacity : 100;
      if ((_pf.type || 'solid') !== _m4FillAll.type) _m4FillOv.pre.type = _pf.type || 'solid';
      // Set post overrides if different from cur
      if (_pof.color  !== _m4FillAll.color)   _m4FillOv.post.color  = _pof.color  || '#ffffff';
      if (_pof.color2 !== _m4FillAll.color2)  _m4FillOv.post.color2 = _pof.color2 || '#aaaaaa';
      if ((_pof.opacity != null ? _pof.opacity : 50) !== _m4FillAll.opacity) _m4FillOv.post.opacity = _pof.opacity != null ? _pof.opacity : 50;
      if ((_pof.type || 'solid') !== _m4FillAll.type) _m4FillOv.post.type = _pof.type || 'solid';
    }
    _m4FillTab = 'all';
    document.querySelectorAll('[data-fill-tab]').forEach(function(b) { b.classList.toggle('active', b.getAttribute('data-fill-tab') === 'all'); });
    _m4FillSyncControls(); _m4FillUpdateTabs();

    // ── Stroke: restore state model ──
    var _defStrkColor = s.strokeColor || '#000000';
    if (s.strokeAll) {
      _m4StrkAll = { type: s.strokeAll.type || 'solid', color: s.strokeAll.color || _defStrkColor, color2: s.strokeAll.color2 || '#888888', angle: s.strokeAll.angle || 0, opacity: s.strokeAll.opacity != null ? s.strokeAll.opacity : 100, width: s.strokeAll.width != null ? s.strokeAll.width : 0 };
      var _sov = s.strokeOv || {};
      ;['pre','cur','post'].forEach(function(st) {
        var o = _sov[st] || {}; _m4StrkOv[st] = { type: o.type !== undefined ? o.type : null, color: o.color !== undefined ? o.color : null, color2: o.color2 !== undefined ? o.color2 : null, angle: o.angle !== undefined ? o.angle : null, opacity: o.opacity !== undefined ? o.opacity : null, width: o.width !== undefined ? o.width : null };
      });
    } else {
      // Old format: derive All from strokeCur, set pre/post as overrides
      var _sc = s.strokeCur  || { color: _defStrkColor, opacity: 100, width: 0 };
      var _sp = s.strokePre  || { color: _defStrkColor, opacity: 100, width: 0 };
      var _spost = s.strokePost || { color: _defStrkColor, opacity: 100, width: 0 };
      _m4StrkAll = { type: _sc.type || 'solid', color: _sc.color || _defStrkColor, color2: _sc.color2 || '#888888', angle: _sc.angle || 0, opacity: _sc.opacity != null ? _sc.opacity : 100, width: _sc.width != null ? _sc.width : (s.strokeWidth || 0) };
      ;['pre','cur','post'].forEach(function(st) { _m4StrkOv[st] = { type: null, color: null, color2: null, angle: null, opacity: null, width: null }; });
      if (_sp.color   !== _m4StrkAll.color)   _m4StrkOv.pre.color   = _sp.color;
      if ((_sp.opacity != null ? _sp.opacity : 100) !== _m4StrkAll.opacity) _m4StrkOv.pre.opacity = _sp.opacity != null ? _sp.opacity : 100;
      if ((_sp.width   != null ? _sp.width   : 0)   !== _m4StrkAll.width)   _m4StrkOv.pre.width   = _sp.width   != null ? _sp.width   : 0;
      if (_spost.color !== _m4StrkAll.color)  _m4StrkOv.post.color  = _spost.color;
      if ((_spost.opacity != null ? _spost.opacity : 100) !== _m4StrkAll.opacity) _m4StrkOv.post.opacity = _spost.opacity != null ? _spost.opacity : 100;
      if ((_spost.width   != null ? _spost.width   : 0)   !== _m4StrkAll.width)   _m4StrkOv.post.width   = _spost.width   != null ? _spost.width   : 0;
    }
    _m4StrkTab = 'all';
    document.querySelectorAll('[data-stroke-tab]').forEach(function(b) { b.classList.toggle('active', b.getAttribute('data-stroke-tab') === 'all'); });
    _m4StrkSyncControls(); _m4StrkUpdateTabs();
    _m4StrokePos = s.strokePosition || 'outside';
    if (m4StrokePosEl) m4StrokePosEl.value = _m4StrokePos;
    document.querySelectorAll('.m4-stroke-pos-btn').forEach(function(b) {
      b.classList.toggle('active', b.getAttribute('data-pos') === _m4StrokePos);
    });
    // Position intentionally NOT restored from template settings. Position
    // is a placement decision owned by the action bar; templates carry
    // look only. Bar's current X/Y stays exactly where the user left it
    // regardless of which template they pick.
    if (m4AnimateEl)     { m4AnimateEl.checked    = !!s.animate; }
    if (m4AnimTypeEl)    { m4AnimTypeEl.value     = s.animType    || M4_DEFAULTS.animType; }
    if (m4AnimBoxTypeEl) { m4AnimBoxTypeEl.value  = s.animBoxType || 'none'; }
    // Restore section enable checkboxes
    var _seChk = document.getElementById('m4-stroke-enable');
    if (_seChk && s.strokeEnable != null) _seChk.checked = !!s.strokeEnable;
    var _shadChk = document.getElementById('m4-shadow-enable');
    if (_shadChk && s.shadowEnable != null) _shadChk.checked = !!s.shadowEnable;

    // Highlight
    if (m4HlEnableEl) { m4HlEnableEl.checked = !!s.showHL; }
    var _hlF = s.hlFill || { type: 'solid', color: s.hlColor || M4_DEFAULTS.hlColor, color2: '#ff8800', angle: 0, opacity: s.hlOpacity != null ? s.hlOpacity : M4_DEFAULTS.hlOpacity };
    var _hlIsGrad = _hlF.type === 'gradient';
    if (m4HlColorEl)      m4HlColorEl.value  = _hlF.color  || M4_DEFAULTS.hlColor;
    if (m4HlColor2El)     m4HlColor2El.value = _hlF.color2 || '#ff8800';
    if (m4HlFillTypeEl)   m4HlFillTypeEl.value = _hlF.type || 'solid';
    var _hlAngle = _hlF.angle || 0;
    if (m4HlFillAngleEl)  m4HlFillAngleEl.value = _hlAngle;
    _m4SetDial(document.getElementById('m4-hl-fill-dir'), _hlAngle);
    var _hlSolidBtn = document.getElementById('m4-hl-fill-solid');
    var _hlGradBtn  = document.getElementById('m4-hl-fill-grad');
    var _hlRow      = document.getElementById('m4-hl-fill-row');
    if (_hlSolidBtn) _hlSolidBtn.classList.toggle('active', !_hlIsGrad);
    if (_hlGradBtn)  _hlGradBtn.classList.toggle('active',   _hlIsGrad);
    if (_hlRow)      _hlRow.classList.toggle('gradient',     _hlIsGrad);
    if (m4HlColorEl) { m4HlColorEl.value = _hlF.color || M4_DEFAULTS.hlColor; }
    if (m4HlOpacityEl)    { var hlov = s.hlOpacity != null ? s.hlOpacity : M4_DEFAULTS.hlOpacity;
                             m4HlOpacityEl.value = hlov;
                             if (m4HlOpacityValEl) m4HlOpacityValEl.textContent = hlov + '%'; }
    if (m4HlRadiusEl)     { var hlrv = s.hlRadius != null ? s.hlRadius : M4_DEFAULTS.hlRadius;
                             m4HlRadiusEl.value = hlrv;
                             if (m4HlRadiusValEl) m4HlRadiusValEl.textContent = hlrv + 'px'; }
    if (m4HlPadTopEl) { var _hpt = s.hlPadTop    != null ? s.hlPadTop    : M4_DEFAULTS.hlPadTop;    m4HlPadTopEl.value = _hpt; if (m4HlPadTopValEl) m4HlPadTopValEl.textContent = _hpt + 'px'; }
    if (m4HlPadBotEl) { var _hpb = s.hlPadBottom != null ? s.hlPadBottom : M4_DEFAULTS.hlPadBottom; m4HlPadBotEl.value = _hpb; if (m4HlPadBotValEl) m4HlPadBotValEl.textContent = _hpb + 'px'; }
    if (m4HlPadLftEl) { var _hpl = s.hlPadLeft   != null ? s.hlPadLeft   : M4_DEFAULTS.hlPadLeft;   m4HlPadLftEl.value = _hpl; if (m4HlPadLftValEl) m4HlPadLftValEl.textContent = _hpl + 'px'; }
    if (m4HlPadRgtEl) { var _hpr = s.hlPadRight  != null ? s.hlPadRight  : M4_DEFAULTS.hlPadRight;  m4HlPadRgtEl.value = _hpr; if (m4HlPadRgtValEl) m4HlPadRgtValEl.textContent = _hpr + 'px'; }

    // Caption BG
    if (m4CbgEnableEl) { m4CbgEnableEl.checked = !!s.showCBG; }
    var _cbgF = s.cbgFill || { type: 'solid', color: s.cbgColor || M4_DEFAULTS.cbgColor, color2: '#333333', angle: 0, opacity: 100 };
    var _cbgIsGrad = _cbgF.type === 'gradient';
    if (m4CbgColorEl)     m4CbgColorEl.value  = _cbgF.color  || M4_DEFAULTS.cbgColor;
    if (m4CbgColor2El)    m4CbgColor2El.value = _cbgF.color2 || '#333333';
    if (m4CbgFillTypeEl)  m4CbgFillTypeEl.value = _cbgF.type || 'solid';
    var _cbgAngle = _cbgF.angle || 0;
    if (m4CbgFillAngleEl) m4CbgFillAngleEl.value = _cbgAngle;
    _m4SetDial(document.getElementById('m4-cbg-fill-dir'), _cbgAngle);
    var _cbgSolidBtn = document.getElementById('m4-cbg-fill-solid');
    var _cbgGradBtn  = document.getElementById('m4-cbg-fill-grad');
    var _cbgRow      = document.getElementById('m4-cbg-fill-row');
    if (_cbgSolidBtn) _cbgSolidBtn.classList.toggle('active', !_cbgIsGrad);
    if (_cbgGradBtn)  _cbgGradBtn.classList.toggle('active',   _cbgIsGrad);
    if (_cbgRow)      _cbgRow.classList.toggle('gradient',     _cbgIsGrad);
    if (m4CbgColorEl) { m4CbgColorEl.value = _cbgF.color || M4_DEFAULTS.cbgColor; }
    if (m4CbgOpacityEl)   { var cbgov = s.cbgOpacity != null ? s.cbgOpacity : M4_DEFAULTS.cbgOpacity;
                             m4CbgOpacityEl.value = cbgov;
                             if (m4CbgOpacityValEl) m4CbgOpacityValEl.textContent = cbgov + '%'; }
    if (m4CbgRadiusEl)    { var cbgrv = s.cbgRadius != null ? s.cbgRadius : M4_DEFAULTS.cbgRadius;
                             m4CbgRadiusEl.value = cbgrv;
                             if (m4CbgRadiusValEl) m4CbgRadiusValEl.textContent = cbgrv + 'px'; }
    if (m4CbgPadTopEl) { var _cpt = s.cbgPadTop != null ? s.cbgPadTop : M4_DEFAULTS.cbgPadTop; m4CbgPadTopEl.value = _cpt; if (m4CbgPadTopValEl) m4CbgPadTopValEl.textContent = _cpt + 'px'; }
    if (m4CbgPadBotEl) { var _cpb = s.cbgPadBottom != null ? s.cbgPadBottom : M4_DEFAULTS.cbgPadBottom; m4CbgPadBotEl.value = _cpb; if (m4CbgPadBotValEl) m4CbgPadBotValEl.textContent = _cpb + 'px'; }
    if (m4CbgPadLftEl) { var _cpl = s.cbgPadLeft != null ? s.cbgPadLeft : M4_DEFAULTS.cbgPadLeft; m4CbgPadLftEl.value = _cpl; if (m4CbgPadLftValEl) m4CbgPadLftValEl.textContent = _cpl + 'px'; }
    if (m4CbgPadRgtEl) { var _cpr = s.cbgPadRight != null ? s.cbgPadRight : M4_DEFAULTS.cbgPadRight; m4CbgPadRgtEl.value = _cpr; if (m4CbgPadRgtValEl) m4CbgPadRgtValEl.textContent = _cpr + 'px'; }
    // CBG mode + corner
    var _cbgMode = s.cbgMode || 'full';
    var _cbgCorner = s.cbgCorner || 'separate';
    if (m4CbgModeEl) m4CbgModeEl.value = _cbgMode;
    if (m4CbgCornerEl) m4CbgCornerEl.value = _cbgCorner;
    document.querySelectorAll('.m4-cbg-mode-btn').forEach(function(b) { b.classList.toggle('active', b.dataset.cbgMode === _cbgMode); });
    document.querySelectorAll('.m4-cbg-corner-btn').forEach(function(b) { b.classList.toggle('active', b.dataset.corner === _cbgCorner); });
    if (m4CbgCornerRow) m4CbgCornerRow.style.display = _cbgMode === 'line' ? '' : 'none';

    // Shadow state model restore
    var _defSh = { color: '#000000', opacity: 0, blur: 4, x: 0, y: 2 };
    var _defBoxSh = { color: '#000000', opacity: 0, blur: 8, x: 0, y: 2 };
    if (s.shadowAll) {
      var _sa = s.shadowAll;
      _m4ShadAll = { color: _sa.color || '#000000', opacity: _sa.opacity != null ? _sa.opacity : 0, blur: _sa.blur != null ? _sa.blur : 4, x: _sa.x != null ? _sa.x : 0, y: _sa.y != null ? _sa.y : 2 };
      var _shov = s.shadowOv || {};
      ;['pre','cur','post'].forEach(function(st) {
        var o = _shov[st] || {}; _m4ShadOv[st] = { color: o.color !== undefined ? o.color : null, opacity: o.opacity !== undefined ? o.opacity : null, blur: o.blur !== undefined ? o.blur : null, x: o.x !== undefined ? o.x : null, y: o.y !== undefined ? o.y : null };
      });
    } else {
      // Old format: derive All from shadowCur, set pre/post as overrides if different
      var _shc = s.shadowCur  || _defSh;
      var _shp = s.shadowPre  || _defSh;
      var _shpo= s.shadowPost || _defSh;
      _m4ShadAll = { color: _shc.color || '#000000', opacity: _shc.opacity != null ? _shc.opacity : 0, blur: _shc.blur != null ? _shc.blur : 4, x: _shc.x != null ? _shc.x : 0, y: _shc.y != null ? _shc.y : 2 };
      ;['pre','cur','post'].forEach(function(st) { _m4ShadOv[st] = { color: null, opacity: null, blur: null, x: null, y: null }; });
      ;['color','opacity','blur','x','y'].forEach(function(f) {
        if (_shp[f]  !== _m4ShadAll[f]) _m4ShadOv.pre[f]  = _shp[f]  != null ? _shp[f]  : _defSh[f];
        if (_shpo[f] !== _m4ShadAll[f]) _m4ShadOv.post[f] = _shpo[f] != null ? _shpo[f] : _defSh[f];
      });
    }
    _m4ShadTab = 'all';
    document.querySelectorAll('[data-shadow-tab]').forEach(function(b) { b.classList.toggle('active', b.getAttribute('data-shadow-tab') === 'all'); });
    _m4ShadSyncControls(); _m4ShadUpdateTabs();

    ;[['hl', s.hlShadow, _defBoxSh], ['cbg', s.cbgShadow, _defBoxSh]].forEach(function(triple) {
      var prefix = triple[0], sh = triple[1] || triple[2];
      var g = function(f) { return document.getElementById('m4-' + prefix + '-shadow-' + f); };
      var cEl = g('color'), oEl = g('opacity'), bEl = g('blur'), xEl = g('x'), yEl = g('y');
      if (cEl) cEl.value = sh.color || '#000000';
      if (oEl) { oEl.value = sh.opacity || 0; var ov = g('opacity-val'); if (ov) ov.textContent = (sh.opacity || 0) + '%'; }
      if (bEl) { bEl.value = sh.blur != null ? sh.blur : 8; var bv = g('blur-val'); if (bv) bv.textContent = (sh.blur != null ? sh.blur : 8) + 'px'; }
      if (xEl) { xEl.value = sh.x || 0; var xv = g('x-val'); if (xv) xv.textContent = (sh.x || 0) + 'px'; }
      if (yEl) { yEl.value = sh.y != null ? sh.y : 2; var yv = g('y-val'); if (yv) yv.textContent = (sh.y != null ? sh.y : 2) + 'px'; }
    });
    // Active mode (solo is now a first-class mode, not a separate toggle)
    _m4ActiveMode = s.activeMode || (s.solo ? 'solo' : 'word'); // backward-compat: old solo:true -> 'solo'
    document.querySelectorAll('.m4-active-btn').forEach(function(b) {
      b.classList.toggle('active', b.getAttribute('data-active') === _m4ActiveMode);
    });
    _m4HoldSilence = s.holdSilence !== undefined ? s.holdSilence : true;
    var _holdEl = document.getElementById('m4-hold-silence');
    if (_holdEl) _holdEl.checked = _m4HoldSilence;
    _m4SyncActiveUI();

    // Wrap mode
    // Wrap is permanently fixed now; ignore any saved 'auto' value
    // from older settings so the renderer always treats it the same.
    _m4WrapMode = 'fixed';
    m4WrapBtns.forEach(function(b) { b.classList.toggle('active', b.getAttribute('data-wrap') === _m4WrapMode); });
    _m4SyncWrapUI();

    // Cur clip mode

    // Bake cur+WB
    _m4CurInCtx  = s.curInCtx || 'off';
    m4CurInCtxBtns.forEach(function(b) { b.classList.toggle('active', b.getAttribute('data-cur-in-ctx') === _m4CurInCtx); });
    _m4BakeCurWB = !!s.bakeCurWB;
    m4BakeBtns.forEach(function(b) { b.classList.toggle('active', (b.getAttribute('data-bake') === 'on') === _m4BakeCurWB); });

    // Missing field = stroke (new default). Only an explicit 'fill' opts out.
    // Default to 'both' (new default) for templates that pre-date the
    // tri-state field; only an explicit 'fill' / 'stroke' opts out.
    _m4ShadowFollow = (s.shadowFollow === 'fill' || s.shadowFollow === 'stroke')
      ? s.shadowFollow
      : 'both';
    m4ShadowOnBtns.forEach(function(b) {
      b.classList.toggle('active', b.getAttribute('data-shadow-on') === _m4ShadowFollow);
    });

    // Frame width
    if (m4FrameWidthEl) {
      m4FrameWidthEl.value = s.frameWidth != null ? s.frameWidth : M4_DEFAULTS.frameWidth;
      var fwvEl = document.getElementById('m4-frame-width-val');
      if (fwvEl) fwvEl.textContent = (s.frameWidth != null ? s.frameWidth : M4_DEFAULTS.frameWidth) + '%';
    }

    // Line gap
    if (m4LineGapEl) {
      var lg = s.lineGap != null ? s.lineGap : M4_DEFAULTS.lineGap;
      m4LineGapEl.value = lg;
      if (m4LineGapValEl) m4LineGapValEl.textContent = lg + 'px';
    }
    // Restore box stroke
    var _defBoxSk = { fill: { type: 'solid', color: '#ffffff', color2: '#aaaaaa', angle: 0, opacity: 100 }, opacity: 100, width: 2, position: 'center' };
    ;[['hl', s.hlStroke, _defBoxSk], ['cbg', s.cbgStroke, _defBoxSk]].forEach(function(triple) {
      var prefix = triple[0], sk = triple[1] || triple[2];
      var g = function(f) { return document.getElementById('m4-' + prefix + '-stroke-' + f); };
      var ftEl = g('fill-type'), faEl = g('fill-angle'), oEl = g('opacity'), wEl = g('width'), pEl = g('position');
      var c1El = g('color'), c2El = g('color2');
      var f = sk.fill || _defBoxSk.fill;
      if (ftEl) ftEl.value = f.type || 'solid';
      if (faEl) faEl.value = f.angle || 0;
      if (c1El) c1El.value = f.color || '#ffffff';
      if (c2El) c2El.value = f.color2 || '#aaaaaa';
      if (oEl) { oEl.value = sk.opacity != null ? sk.opacity : 100; var ov = g('opacity-val'); if (ov) ov.textContent = (sk.opacity != null ? sk.opacity : 100) + '%'; }
      if (wEl) { wEl.value = sk.width != null ? sk.width : 2;       var wv = g('width-val');   if (wv) wv.textContent = (sk.width != null ? sk.width : 2) + 'px'; }
      if (pEl) pEl.value = sk.position || 'center';
      // Sync stroke position toggle buttons
      var _posVal = sk.position || 'center';
      document.querySelectorAll('.m4-' + prefix + '-stroke-pos-btn').forEach(function(b) {
        b.classList.toggle('active', b.getAttribute('data-pos') === _posVal);
      });
      // Sync solid/grad buttons + row class
      var solidBtn = document.getElementById('m4-' + prefix + '-stroke-fill-solid');
      var gradBtn  = document.getElementById('m4-' + prefix + '-stroke-fill-grad');
      var row      = document.getElementById('m4-' + prefix + '-stroke-fill-row');
      var dirBtn   = document.getElementById('m4-' + prefix + '-stroke-fill-dir');
      var isGrad   = (f.type === 'gradient');
      if (solidBtn) solidBtn.classList.toggle('active', !isGrad);
      if (gradBtn)  gradBtn.classList.toggle('active',  isGrad);
      if (row)      row.classList.toggle('gradient', isGrad);
      if (dirBtn) {
        _m4SetDial(dirBtn, f.angle || 0);
      }
      // Sync pickr if already initialized
      ;[['color', f.color || '#ffffff'], ['color2', f.color2 || '#aaaaaa']].forEach(function(pair) {
        var inputId = 'm4-' + prefix + '-stroke-' + pair[0];
        var val = pair[1];
        if (val && /^#[0-9a-fA-F]{3,8}$/.test(val)) {
          try { _m4Syncing = true; _m4PickrMap[inputId].setColor(val, false); } catch(_) {} finally { _m4Syncing = false; }
        }
      });
    });

    // Restore sub-section enables
    var _hlSkChk = document.getElementById('m4-hl-stroke-enable');
    if (_hlSkChk && s.hlStrokeEnable != null) _hlSkChk.checked = !!s.hlStrokeEnable;
    var _cbgSkChk = document.getElementById('m4-cbg-stroke-enable');
    if (_cbgSkChk && s.cbgStrokeEnable != null) _cbgSkChk.checked = !!s.cbgStrokeEnable;
    // Restore sub-shadow enables
    var _hlShChk = document.getElementById('m4-hl-shadow-enable');
    if (_hlShChk && s.hlShadowEnable != null) _hlShChk.checked = !!s.hlShadowEnable;
    var _cbgShChk = document.getElementById('m4-cbg-shadow-enable');
    if (_cbgShChk && s.cbgShadowEnable != null) _cbgShChk.checked = !!s.cbgShadowEnable;
    // Sync all enable sections (accordion + sub-shadows) via change events
    ['m4-stroke-enable','m4-shadow-enable','m4-hl-enable','m4-cbg-enable','m4-animate',
     'm4-hl-stroke-enable','m4-cbg-stroke-enable',
     'm4-hl-shadow-enable','m4-cbg-shadow-enable'].forEach(function(id) {
      var el = document.getElementById(id);
      if (el) el.dispatchEvent(new Event('change'));
    });
  }

  // ── Per-state typography ──────────────────────────────────────────────────
  var _m4TypoState = 'all'; // 'all' | 'pre' | 'cur' | 'post'

  // "All" base values - source of truth for the typography controls
  var _m4TypoAll = {
    fontFamily: M4_DEFAULTS.fontFamily,
    fontStyle:  M4_DEFAULTS.fontStyle,
    fontSize:   M4_DEFAULTS.fontSize
  };

  // Per-state overrides - null fields inherit from _m4TypoAll
  var _m4TypoOverrides = {
    pre:  { fontFamily: null, fontStyle: null, fontSize: null },
    cur:  { fontFamily: null, fontStyle: null, fontSize: null },
    post: { fontFamily: null, fontStyle: null, fontSize: null }
  };

  // Effective value for a state (override ?? All)
  function _m4TypoEff(state, field) {
    if (state === 'all') return _m4TypoAll[field];
    var ov = _m4TypoOverrides[state];
    return (ov && ov[field] != null) ? ov[field] : _m4TypoAll[field];
  }

  // Does this state have at least one active override?
  function _m4TypoHasOverride(state) {
    var ov = _m4TypoOverrides[state];
    return !!(ov && (ov.fontFamily != null || ov.fontStyle != null || ov.fontSize != null));
  }

  // Update tab active state + override dots + reset button + global extras visibility
  function _m4TypoUpdateTabs() {
    var isAll = (_m4TypoState === 'all');
    m4TypoTabs.forEach(function(t) {
      var s = t.getAttribute('data-typo');
      t.classList.toggle('active', s === _m4TypoState);
      if (s !== 'all') t.classList.toggle('has-override', _m4TypoHasOverride(s));
    });
    if (m4TypoResetBtn) {
      var canReset = !isAll && _m4TypoHasOverride(_m4TypoState);
      m4TypoResetBtn.disabled = !canReset;
    }
    if (m4TypoGlobalExtras) m4TypoGlobalExtras.style.display = isAll ? '' : 'none';
  }

  // Push the current tab's effective typography into the DOM controls
  function _m4TypoSyncControls() {
    var ff  = _m4TypoEff(_m4TypoState, 'fontFamily');
    var fs  = _m4TypoEff(_m4TypoState, 'fontStyle');
    var fsz = _m4TypoEff(_m4TypoState, 'fontSize');
    _m4FontPickerSetValue(ff, true);            // true = skip saving (avoid recursion)
    if (m4FontStyleEl) m4FontStyleEl.value = fs;
    if (m4FontSizeEl) {
      m4FontSizeEl.value = fsz;
      if (m4FontSizeValEl) m4FontSizeValEl.textContent = fsz + 'px';
    }
    _m4TypoUpdateTabs();
  }

  // Save current control values into the right bucket (All or override)
  function _m4TypoSaveControls() {
    var ff  = _m4FontFamily;
    var fs  = m4FontStyleEl ? m4FontStyleEl.value : M4_DEFAULTS.fontStyle;
    var fsz = m4FontSizeEl  ? parseInt(m4FontSizeEl.value, 10) : M4_DEFAULTS.fontSize;
    if (_m4TypoState === 'all') {
      _m4TypoAll.fontFamily = ff;
      _m4TypoAll.fontStyle  = fs;
      _m4TypoAll.fontSize   = fsz;
    } else {
      var ov = _m4TypoOverrides[_m4TypoState];
      ov.fontFamily = (ff  !== _m4TypoAll.fontFamily) ? ff  : null;
      ov.fontStyle  = (fs  !== _m4TypoAll.fontStyle)  ? fs  : null;
      ov.fontSize   = (fsz !== _m4TypoAll.fontSize)   ? fsz : null;
    }
  }

  // ── Font picker state ─────────────────────────────────────────────────────
  var _m4FontFamily  = M4_DEFAULTS.fontFamily;
  var _m4AllFonts    = []; // full sorted list, populated after scan
  // Per-family weight + italic info read out of each font file at scan time.
  //   _m4FontMeta[family] = { weights: {100:true,...}, italic: bool, vfMin, vfMax }
  // Drives Style-dropdown filtering - fonts only list the weights they ship.
  var _m4FontMeta    = {};

  // RTL Unicode detection (always auto)
  function _isRTL(text) {
    return /[\u0591-\u07FF\uFB1D-\uFDFD\uFE70-\uFEFC]/.test(text);
  }
  function _resolveDir(words) {
    return _isRTL(words.join(' ')) ? 'rtl' : 'ltr';
  }

  var m4StrokeColorEl    = null; // legacy ref - stroke now in state model
  var m4StrokePosEl      = document.getElementById('m4-stroke-position');
  var _m4StrokePos       = 'outside'; // 'outside' | 'center' | 'inside'

  // Stroke position buttons
  document.querySelectorAll('.m4-stroke-pos-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
      _m4StrokePos = btn.getAttribute('data-pos');
      if (m4StrokePosEl) m4StrokePosEl.value = _m4StrokePos;
      document.querySelectorAll('.m4-stroke-pos-btn').forEach(function(b) {
        b.classList.toggle('active', b.getAttribute('data-pos') === _m4StrokePos);
      });
      _m4DrawPreview(); _m4SaveSettings();
    });
  });

  // HL stroke position buttons
  document.querySelectorAll('.m4-hl-stroke-pos-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var val = btn.getAttribute('data-pos');
      var hidEl = document.getElementById('m4-hl-stroke-position');
      if (hidEl) hidEl.value = val;
      document.querySelectorAll('.m4-hl-stroke-pos-btn').forEach(function(b) {
        b.classList.toggle('active', b.getAttribute('data-pos') === val);
      });
      _m4DrawPreview(); _m4SaveSettings();
    });
  });

  // CBG mode buttons (Full / Line)
  document.querySelectorAll('.m4-cbg-mode-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var val = btn.dataset.cbgMode;
      if (m4CbgModeEl) m4CbgModeEl.value = val;
      document.querySelectorAll('.m4-cbg-mode-btn').forEach(function(b) { b.classList.toggle('active', b.dataset.cbgMode === val); });
      if (m4CbgCornerRow) m4CbgCornerRow.style.display = val === 'line' ? '' : 'none';
      _m4DrawPreview(); _m4SaveSettings();
    });
  });

  // CBG corner buttons (Separate / Merge)
  document.querySelectorAll('.m4-cbg-corner-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var val = btn.dataset.corner;
      if (m4CbgCornerEl) m4CbgCornerEl.value = val;
      document.querySelectorAll('.m4-cbg-corner-btn').forEach(function(b) { b.classList.toggle('active', b.dataset.corner === val); });
      _m4DrawPreview(); _m4SaveSettings();
    });
  });

  // CBG stroke position buttons
  document.querySelectorAll('.m4-cbg-stroke-pos-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var val = btn.getAttribute('data-pos');
      var hidEl = document.getElementById('m4-cbg-stroke-position');
      if (hidEl) hidEl.value = val;
      document.querySelectorAll('.m4-cbg-stroke-pos-btn').forEach(function(b) {
        b.classList.toggle('active', b.getAttribute('data-pos') === val);
      });
      _m4DrawPreview(); _m4SaveSettings();
    });
  });
  var m4FontSizeValEl    = document.getElementById('m4-fontsize-val');
  var m4FontStyleEl      = document.getElementById('m4-font-style');

  // ── Style dropdown filtering - by-family ──────────────────────────────
  // Each Style option carries a numeric weight (100..900) and italic flag,
  // so we can rebuild the option list from the picked font's actual
  // weights instead of the static 18-option markup.
  var _M4_STYLE_OPTS = [
    { value: '100',          label: 'Thin',             weight: 100, italic: false },
    { value: 'italic 100',   label: 'Thin Italic',      weight: 100, italic: true  },
    { value: '200',          label: 'Extra Light',      weight: 200, italic: false },
    { value: 'italic 200',   label: 'Extra Light Italic', weight: 200, italic: true },
    { value: '300',          label: 'Light',            weight: 300, italic: false },
    { value: 'italic 300',   label: 'Light Italic',     weight: 300, italic: true  },
    { value: 'normal',       label: 'Regular',          weight: 400, italic: false },
    { value: 'italic',       label: 'Italic',           weight: 400, italic: true  },
    { value: '500',          label: 'Medium',           weight: 500, italic: false },
    { value: 'italic 500',   label: 'Medium Italic',    weight: 500, italic: true  },
    { value: '600',          label: 'Semi Bold',        weight: 600, italic: false },
    { value: 'italic 600',   label: 'Semi Bold Italic', weight: 600, italic: true  },
    { value: 'bold',         label: 'Bold',             weight: 700, italic: false },
    { value: 'italic bold',  label: 'Bold Italic',      weight: 700, italic: true  },
    { value: '800',          label: 'Extra Bold',       weight: 800, italic: false },
    { value: 'italic 800',   label: 'Extra Bold Italic', weight: 800, italic: true },
    { value: '900',          label: 'Black',            weight: 900, italic: false },
    { value: 'italic 900',   label: 'Black Italic',     weight: 900, italic: true  }
  ];

  function _m4StyleSupported(opt, meta) {
    if (!meta) return true; // unknown family -> show everything (failsafe)
    // Variable fonts: any weight inside [vfMin, vfMax] is reachable.
    if (meta.vfMin != null && meta.vfMax != null) {
      if (opt.weight < meta.vfMin || opt.weight > meta.vfMax) return false;
    } else {
      if (!meta.weights[opt.weight]) return false;
    }
    if (opt.italic && !meta.italic) return false;
    return true;
  }

  // Picks the closest supported option to a given (weight, italic) pair.
  // Used when the user switches font and their previous Style isn't
  // shipped by the new family - we snap to the nearest weight.
  function _m4ClosestStyle(weight, italic, meta) {
    var avail = _M4_STYLE_OPTS.filter(function (o) { return _m4StyleSupported(o, meta); });
    if (!avail.length) return null;
    // Prefer same italic-ness; if none, fall back to opposite.
    var sameIt = avail.filter(function (o) { return o.italic === italic; });
    var pool = sameIt.length ? sameIt : avail;
    var best = pool[0];
    var bestDelta = Math.abs(pool[0].weight - weight);
    for (var i = 1; i < pool.length; i++) {
      var d = Math.abs(pool[i].weight - weight);
      if (d < bestDelta) { best = pool[i]; bestDelta = d; }
    }
    return best;
  }

  // Parses the existing CSS-style fontStyle string (eg "italic 600",
  // "bold", "normal") back into { weight, italic } so we can re-match
  // it after rebuilding the dropdown for a new family.
  function _m4ParseFontStyle(s) {
    var match = _M4_STYLE_OPTS.filter(function (o) { return o.value === s; })[0];
    if (match) return { weight: match.weight, italic: match.italic };
    return { weight: 400, italic: false };
  }

  // Rebuild the <select> options to reflect the new family. Snaps the
  // current selection to the nearest available weight if needed and
  // returns the value that ended up selected (so callers can persist).
  function _m4RefreshFontStyleDropdown(family) {
    if (!m4FontStyleEl) return null;
    var meta = _m4FontMeta[family] || null;
    var prev = _m4ParseFontStyle(m4FontStyleEl.value);
    var html = [];
    _M4_STYLE_OPTS.forEach(function (o) {
      if (_m4StyleSupported(o, meta)) {
        html.push('<option value="' + o.value + '">' + o.label + '</option>');
      }
    });
    // Defensive: if a font's metadata is empty AND it's not VF, show all.
    if (!html.length) {
      _M4_STYLE_OPTS.forEach(function (o) {
        html.push('<option value="' + o.value + '">' + o.label + '</option>');
      });
    }
    m4FontStyleEl.innerHTML = html.join('');
    var snap = _m4ClosestStyle(prev.weight, prev.italic, meta);
    m4FontStyleEl.value = snap ? snap.value : 'normal';
    return m4FontStyleEl.value;
  }
  var m4LetterSpacingEl  = document.getElementById('m4-letter-spacing');
  var m4LetterSpacingVal = document.getElementById('m4-letter-spacing-val');
  var m4TextTransformEl  = document.getElementById('m4-text-transform');
  var m4TypoTabs         = document.querySelectorAll('.m4-typo-tab[data-typo]');
  var m4TypoResetBtn     = document.getElementById('m4-typo-reset-tab');
  var m4TypoGlobalExtras = document.getElementById('m4-typo-global-extras');
  var m4PreviewCanvas    = document.getElementById('m4-preview');

  // ── Typography tab switching ───────────────────────────────────────────────
  m4TypoTabs.forEach(function(tab) {
    tab.addEventListener('click', function() {
      // Commit current controls before switching
      _m4TypoSaveControls();
      _m4TypoState = tab.getAttribute('data-typo');
      _m4TypoSyncControls();
      _m4DrawPreview(); _m4SaveSettings();
    });
  });

  if (m4TypoResetBtn) {
    m4TypoResetBtn.addEventListener('click', function() {
      if (_m4TypoState === 'all') return;
      _m4TypoOverrides[_m4TypoState] = { fontFamily: null, fontStyle: null, fontSize: null };
      _m4TypoSyncControls();
      _m4DrawPreview(); _m4SaveSettings();
    });
  }

  // Per-state save for font style + font size (intercept before generic _m4StyleEls loop)
  if (m4FontStyleEl) {
    m4FontStyleEl.addEventListener('change', function() {
      if (_m4TypoState === 'all') {
        _m4TypoAll.fontStyle = m4FontStyleEl.value;
      } else {
        var v = m4FontStyleEl.value;
        _m4TypoOverrides[_m4TypoState].fontStyle = (v !== _m4TypoAll.fontStyle) ? v : null;
        _m4TypoUpdateTabs();
      }
    });
  }
  if (m4FontSizeEl) {
    m4FontSizeEl.addEventListener('input', function() {
      var v = parseInt(m4FontSizeEl.value, 10);
      if (m4FontSizeValEl) m4FontSizeValEl.textContent = v + 'px';
      if (_m4TypoState === 'all') {
        _m4TypoAll.fontSize = v;
      } else {
        _m4TypoOverrides[_m4TypoState].fontSize = (v !== _m4TypoAll.fontSize) ? v : null;
        _m4TypoUpdateTabs();
      }
    });
  }

  // ── Fill state model ─────────────────────────────────────────────────────────
  var _m4FillAll = { type: 'solid', color: '#ffe44d', color2: '#ff8800', angle: 0, opacity: 100 };
  var _m4FillOv  = {
    pre:  { type: null, color: null, color2: null, angle: null, opacity: null },
    cur:  { type: null, color: null, color2: null, angle: null, opacity: null },
    post: { type: null, color: null, color2: null, angle: null, opacity: null }
  };
  var _m4FillTab = 'all';

  function _fillEff(state, field) {
    if (state === 'all') return _m4FillAll[field];
    var ov = _m4FillOv[state];
    return (ov && ov[field] != null) ? ov[field] : _m4FillAll[field];
  }

  function _readFill(state) {
    return { type: _fillEff(state,'type'), color: _fillEff(state,'color'), color2: _fillEff(state,'color2'), angle: _fillEff(state,'angle'), opacity: _fillEff(state,'opacity') };
  }

  function _m4FillUpdateTabs() {
    document.querySelectorAll('[data-fill-tab]').forEach(function(btn) {
      var st = btn.getAttribute('data-fill-tab');
      if (st === 'all') return;
      var dot = btn.querySelector('.m4-typo-dot');
      if (!dot) return;
      var ov = _m4FillOv[st];
      dot.style.display = (ov && Object.keys(ov).some(function(k) { return ov[k] != null; })) ? 'inline-block' : 'none';
    });
    var resetBtn = document.getElementById('m4-fill-tab-reset');
    if (resetBtn) {
      var isAll = (_m4FillTab === 'all');
      var ov = !isAll ? _m4FillOv[_m4FillTab] : null;
      resetBtn.disabled = isAll || !(ov && Object.keys(ov).some(function(k) { return ov[k] != null; }));
    }
  }

  function _m4FillSyncControls() {
    var st = _m4FillTab;
    var type = _fillEff(st,'type'), color = _fillEff(st,'color'), color2 = _fillEff(st,'color2');
    var angle = _fillEff(st,'angle'), opacity = _fillEff(st,'opacity');
    var isGrad = type === 'gradient';
    var solidBtn = document.getElementById('m4-fill-solid'), gradBtn = document.getElementById('m4-fill-grad');
    var row = document.getElementById('m4-fill-row');
    if (solidBtn) solidBtn.classList.toggle('active', !isGrad);
    if (gradBtn)  gradBtn.classList.toggle('active',   isGrad);
    if (row)      row.classList.toggle('gradient', isGrad);
    var colorEl = document.getElementById('m4-fill-color');
    if (colorEl) { colorEl.value = color; var pk = _m4PickrMap && _m4PickrMap['m4-fill-color']; if (pk) try { _m4Syncing = true; pk.setColor(color, false); } catch(_) {} finally { _m4Syncing = false; } }
    var color2El = document.getElementById('m4-fill-color2');
    if (color2El) { color2El.value = color2; var pk2 = _m4PickrMap && _m4PickrMap['m4-fill-color2']; if (pk2) try { _m4Syncing = true; pk2.setColor(color2, false); } catch(_) {} finally { _m4Syncing = false; } }
    var dirBtn = document.getElementById('m4-fill-dir'), angleEl = document.getElementById('m4-fill-angle');
    if (angleEl) angleEl.value = angle;
    _m4SetDial(dirBtn, angle);
    var opEl = document.getElementById('m4-fill-opacity'), opValEl = document.getElementById('m4-fill-opacity-val');
    if (opEl) opEl.value = opacity;
    if (opValEl) opValEl.textContent = opacity + '%';
  }

  function _m4FillWrite(field, value) {
    if (_m4FillTab === 'all') {
      _m4FillAll[field] = value;
    } else {
      _m4FillOv[_m4FillTab][field] = (value !== _m4FillAll[field]) ? value : null;
    }
    _m4FillUpdateTabs();
    _m4DrawPreview(); _m4SaveSettings();
  }

  // Fill tab clicks
  document.querySelectorAll('[data-fill-tab]').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var st = btn.getAttribute('data-fill-tab');
      _m4FillTab = st;
      document.querySelectorAll('[data-fill-tab]').forEach(function(b) { b.classList.toggle('active', b.getAttribute('data-fill-tab') === st); });
      _m4FillSyncControls(); _m4FillUpdateTabs();
    });
  });
  var _m4FillResetBtn = document.getElementById('m4-fill-tab-reset');
  if (_m4FillResetBtn) {
    _m4FillResetBtn.addEventListener('click', function() {
      if (_m4FillTab === 'all') return;
      var ov = _m4FillOv[_m4FillTab]; Object.keys(ov).forEach(function(k) { ov[k] = null; });
      _m4FillSyncControls(); _m4FillUpdateTabs(); _m4DrawPreview(); _m4SaveSettings();
    });
  }
  // Fill control events
  var _m4FillSolidBtn = document.getElementById('m4-fill-solid');
  var _m4FillGradBtn  = document.getElementById('m4-fill-grad');
  if (_m4FillSolidBtn) _m4FillSolidBtn.addEventListener('click', function() { _m4FillWrite('type', 'solid');    _m4FillSyncControls(); });
  if (_m4FillGradBtn)  _m4FillGradBtn.addEventListener('click',  function() { _m4FillWrite('type', 'gradient'); _m4FillSyncControls(); });
  _m4AttachDial(document.getElementById('m4-fill-dir'), function (angle) {
    _m4FillWrite('angle', angle); _m4FillSyncControls();
  });
  var _m4FillOpacityEl = document.getElementById('m4-fill-opacity');
  if (_m4FillOpacityEl) {
    _m4FillOpacityEl.addEventListener('input', function() {
      var v = parseInt(_m4FillOpacityEl.value, 10);
      var opValEl = document.getElementById('m4-fill-opacity-val'); if (opValEl) opValEl.textContent = v + '%';
      _m4FillWrite('opacity', v);
    });
  }

  // ── Stroke state model ───────────────────────────────────────────────────────
  var _m4StrkAll = { type: 'solid', color: '#000000', color2: '#888888', angle: 0, opacity: 100, width: 0 };
  var _m4StrkOv  = {
    pre:  { type: null, color: null, color2: null, angle: null, opacity: null, width: null },
    cur:  { type: null, color: null, color2: null, angle: null, opacity: null, width: null },
    post: { type: null, color: null, color2: null, angle: null, opacity: null, width: null }
  };
  var _m4StrkTab = 'all';

  function _strkEff(state, field) {
    if (state === 'all') return _m4StrkAll[field];
    var ov = _m4StrkOv[state];
    return (ov && ov[field] != null) ? ov[field] : _m4StrkAll[field];
  }

  function _readStroke(state) {
    return { type: _strkEff(state,'type'), color: _strkEff(state,'color'), color2: _strkEff(state,'color2'), angle: _strkEff(state,'angle'), opacity: _strkEff(state,'opacity'), width: _strkEff(state,'width') };
  }

  function _m4StrkUpdateTabs() {
    document.querySelectorAll('[data-stroke-tab]').forEach(function(btn) {
      var st = btn.getAttribute('data-stroke-tab');
      if (st === 'all') return;
      var dot = btn.querySelector('.m4-typo-dot');
      if (!dot) return;
      var ov = _m4StrkOv[st];
      dot.style.display = (ov && Object.keys(ov).some(function(k) { return ov[k] != null; })) ? 'inline-block' : 'none';
    });
    var resetBtn = document.getElementById('m4-stroke-tab-reset');
    if (resetBtn) {
      var isAll = (_m4StrkTab === 'all');
      var ov = !isAll ? _m4StrkOv[_m4StrkTab] : null;
      resetBtn.disabled = isAll || !(ov && Object.keys(ov).some(function(k) { return ov[k] != null; }));
    }
  }

  function _m4StrkSyncControls() {
    var st = _m4StrkTab;
    var type = _strkEff(st,'type'), color = _strkEff(st,'color'), color2 = _strkEff(st,'color2');
    var angle = _strkEff(st,'angle'), opacity = _strkEff(st,'opacity'), width = _strkEff(st,'width');
    var isGrad = type === 'gradient';
    var solidBtn = document.getElementById('m4-stroke-solid'), gradBtn = document.getElementById('m4-stroke-grad');
    var row = document.getElementById('m4-stroke-row'), typeEl = document.getElementById('m4-stroke-type');
    if (typeEl)   typeEl.value = type;
    if (solidBtn) solidBtn.classList.toggle('active', !isGrad);
    if (gradBtn)  gradBtn.classList.toggle('active',   isGrad);
    if (row)      row.classList.toggle('gradient', isGrad);
    var colorEl = document.getElementById('m4-stroke-color');
    if (colorEl) { colorEl.value = color; var pk = _m4PickrMap && _m4PickrMap['m4-stroke-color']; if (pk) try { _m4Syncing = true; pk.setColor(color, false); } catch(_) {} finally { _m4Syncing = false; } }
    var color2El = document.getElementById('m4-stroke-color2');
    if (color2El) { color2El.value = color2; var pk2 = _m4PickrMap && _m4PickrMap['m4-stroke-color2']; if (pk2) try { _m4Syncing = true; pk2.setColor(color2, false); } catch(_) {} finally { _m4Syncing = false; } }
    var dirBtn = document.getElementById('m4-stroke-dir'), angleEl = document.getElementById('m4-stroke-angle');
    if (angleEl) angleEl.value = angle;
    _m4SetDial(dirBtn, angle);
    var opEl = document.getElementById('m4-stroke-opacity'), opValEl = document.getElementById('m4-stroke-opacity-val');
    if (opEl) opEl.value = opacity; if (opValEl) opValEl.textContent = opacity + '%';
    var wEl = document.getElementById('m4-stroke-width'), wValEl = document.getElementById('m4-stroke-width-val');
    if (wEl) wEl.value = width; if (wValEl) wValEl.textContent = width + 'px';
  }

  function _m4StrkWrite(field, value) {
    if (_m4StrkTab === 'all') {
      _m4StrkAll[field] = value;
    } else {
      _m4StrkOv[_m4StrkTab][field] = (value !== _m4StrkAll[field]) ? value : null;
    }
    _m4StrkUpdateTabs();
    _m4DrawPreview(); _m4SaveSettings();
  }

  // Stroke tab clicks
  document.querySelectorAll('[data-stroke-tab]').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var st = btn.getAttribute('data-stroke-tab');
      _m4StrkTab = st;
      document.querySelectorAll('[data-stroke-tab]').forEach(function(b) { b.classList.toggle('active', b.getAttribute('data-stroke-tab') === st); });
      _m4StrkSyncControls(); _m4StrkUpdateTabs();
    });
  });
  var _m4StrkResetBtn = document.getElementById('m4-stroke-tab-reset');
  if (_m4StrkResetBtn) {
    _m4StrkResetBtn.addEventListener('click', function() {
      if (_m4StrkTab === 'all') return;
      var ov = _m4StrkOv[_m4StrkTab]; Object.keys(ov).forEach(function(k) { ov[k] = null; });
      _m4StrkSyncControls(); _m4StrkUpdateTabs(); _m4DrawPreview(); _m4SaveSettings();
    });
  }
  // Stroke control events
  var _m4StrkSolidBtn = document.getElementById('m4-stroke-solid');
  var _m4StrkGradBtn  = document.getElementById('m4-stroke-grad');
  if (_m4StrkSolidBtn) _m4StrkSolidBtn.addEventListener('click', function() { _m4StrkWrite('type', 'solid');    _m4StrkSyncControls(); });
  if (_m4StrkGradBtn)  _m4StrkGradBtn.addEventListener('click',  function() { _m4StrkWrite('type', 'gradient'); _m4StrkSyncControls(); });
  _m4AttachDial(document.getElementById('m4-stroke-dir'), function (angle) {
    _m4StrkWrite('angle', angle); _m4StrkSyncControls();
  });
  var _m4StrkOpEl = document.getElementById('m4-stroke-opacity');
  if (_m4StrkOpEl) {
    _m4StrkOpEl.addEventListener('input', function() {
      var v = parseInt(_m4StrkOpEl.value, 10);
      var valEl = document.getElementById('m4-stroke-opacity-val'); if (valEl) valEl.textContent = v + '%';
      _m4StrkWrite('opacity', v);
    });
  }
  var _m4StrkWidthEl = document.getElementById('m4-stroke-width');
  if (_m4StrkWidthEl) {
    _m4StrkWidthEl.addEventListener('input', function() {
      var v = parseFloat(_m4StrkWidthEl.value) || 0;
      var valEl = document.getElementById('m4-stroke-width-val'); if (valEl) valEl.textContent = v + 'px';
      _m4StrkWrite('width', v);
    });
  }

  // Caption BG S/G toggle + direction button
  (function() {
    var solidBtn = document.getElementById('m4-cbg-fill-solid');
    var gradBtn  = document.getElementById('m4-cbg-fill-grad');
    var row      = document.getElementById('m4-cbg-fill-row');
    if (solidBtn && gradBtn) {
      solidBtn.addEventListener('click', function() {
        if (m4CbgFillTypeEl) m4CbgFillTypeEl.value = 'solid';
        solidBtn.classList.add('active'); gradBtn.classList.remove('active');
        if (row) row.classList.remove('gradient');
        _m4DrawPreview(); _m4SaveSettings();
      });
      gradBtn.addEventListener('click', function() {
        if (m4CbgFillTypeEl) m4CbgFillTypeEl.value = 'gradient';
        gradBtn.classList.add('active'); solidBtn.classList.remove('active');
        if (row) row.classList.add('gradient');
        _m4DrawPreview(); _m4SaveSettings();
      });
    }
    _m4AttachDial(document.getElementById('m4-cbg-fill-dir'), function (next) {
      if (m4CbgFillAngleEl) m4CbgFillAngleEl.value = next;
      _m4DrawPreview(); _m4SaveSettings();
    });
  }());

  // Highlight box S/G toggle + direction button
  (function() {
    var solidBtn = document.getElementById('m4-hl-fill-solid');
    var gradBtn  = document.getElementById('m4-hl-fill-grad');
    var row      = document.getElementById('m4-hl-fill-row');
    if (solidBtn && gradBtn) {
      solidBtn.addEventListener('click', function() {
        if (m4HlFillTypeEl) m4HlFillTypeEl.value = 'solid';
        solidBtn.classList.add('active'); gradBtn.classList.remove('active');
        if (row) row.classList.remove('gradient');
        _m4DrawPreview(); _m4SaveSettings();
      });
      gradBtn.addEventListener('click', function() {
        if (m4HlFillTypeEl) m4HlFillTypeEl.value = 'gradient';
        gradBtn.classList.add('active'); solidBtn.classList.remove('active');
        if (row) row.classList.add('gradient');
        _m4DrawPreview(); _m4SaveSettings();
      });
    }
    _m4AttachDial(document.getElementById('m4-hl-fill-dir'), function (next) {
      if (m4HlFillAngleEl) m4HlFillAngleEl.value = next;
      _m4DrawPreview(); _m4SaveSettings();
    });
  }());

  // ── Shadow state model ───────────────────────────────────────────────────────
  var _m4ShadAll = { color: '#000000', opacity: 0, blur: 4, x: 0, y: 2 };
  var _m4ShadOv  = {
    pre:  { color: null, opacity: null, blur: null, x: null, y: null },
    cur:  { color: null, opacity: null, blur: null, x: null, y: null },
    post: { color: null, opacity: null, blur: null, x: null, y: null }
  };
  var _m4ShadTab = 'all';

  function _shadEff(state, field) {
    if (state === 'all') return _m4ShadAll[field];
    var ov = _m4ShadOv[state];
    return (ov && ov[field] != null) ? ov[field] : _m4ShadAll[field];
  }

  function _readShadow(state) {
    return { color: _shadEff(state,'color'), opacity: _shadEff(state,'opacity'), blur: _shadEff(state,'blur'), x: _shadEff(state,'x'), y: _shadEff(state,'y') };
  }

  function _m4ShadUpdateTabs() {
    document.querySelectorAll('[data-shadow-tab]').forEach(function(btn) {
      var st = btn.getAttribute('data-shadow-tab');
      if (st === 'all') return;
      var dot = btn.querySelector('.m4-typo-dot');
      if (!dot) return;
      var ov = _m4ShadOv[st];
      dot.style.display = (ov && Object.keys(ov).some(function(k) { return ov[k] != null; })) ? 'inline-block' : 'none';
    });
    var resetBtn = document.getElementById('m4-shadow-tab-reset');
    if (resetBtn) {
      var isAll = (_m4ShadTab === 'all');
      var ov = !isAll ? _m4ShadOv[_m4ShadTab] : null;
      resetBtn.disabled = isAll || !(ov && Object.keys(ov).some(function(k) { return ov[k] != null; }));
    }
  }

  function _m4ShadSyncControls() {
    var st = _m4ShadTab;
    var color = _shadEff(st,'color'), opacity = _shadEff(st,'opacity');
    var blur = _shadEff(st,'blur'), x = _shadEff(st,'x'), y = _shadEff(st,'y');
    var colorEl = document.getElementById('m4-shadow-color');
    if (colorEl) { colorEl.value = color; var pk = _m4PickrMap && _m4PickrMap['m4-shadow-color']; if (pk) try { _m4Syncing = true; pk.setColor(color, false); } catch(_) {} finally { _m4Syncing = false; } }
    var opEl = document.getElementById('m4-shadow-opacity'), opValEl = document.getElementById('m4-shadow-opacity-val');
    if (opEl) opEl.value = opacity; if (opValEl) opValEl.textContent = opacity + '%';
    var blurEl = document.getElementById('m4-shadow-blur'), blurValEl = document.getElementById('m4-shadow-blur-val');
    if (blurEl) blurEl.value = blur; if (blurValEl) blurValEl.textContent = blur + 'px';
    var xEl = document.getElementById('m4-shadow-x'), xValEl = document.getElementById('m4-shadow-x-val');
    if (xEl) xEl.value = x; if (xValEl) xValEl.textContent = x + 'px';
    var yEl = document.getElementById('m4-shadow-y'), yValEl = document.getElementById('m4-shadow-y-val');
    if (yEl) yEl.value = y; if (yValEl) yValEl.textContent = y + 'px';
  }

  function _m4ShadWrite(field, value) {
    if (_m4ShadTab === 'all') {
      _m4ShadAll[field] = value;
    } else {
      _m4ShadOv[_m4ShadTab][field] = (value !== _m4ShadAll[field]) ? value : null;
    }
    _m4ShadUpdateTabs();
    _m4DrawPreview(); _m4SaveSettings();
  }

  // Shadow tab clicks
  document.querySelectorAll('[data-shadow-tab]').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var st = btn.getAttribute('data-shadow-tab');
      _m4ShadTab = st;
      document.querySelectorAll('[data-shadow-tab]').forEach(function(b) { b.classList.toggle('active', b.getAttribute('data-shadow-tab') === st); });
      _m4ShadSyncControls(); _m4ShadUpdateTabs();
    });
  });
  var _m4ShadResetBtn = document.getElementById('m4-shadow-tab-reset');
  if (_m4ShadResetBtn) {
    _m4ShadResetBtn.addEventListener('click', function() {
      if (_m4ShadTab === 'all') return;
      var ov = _m4ShadOv[_m4ShadTab]; Object.keys(ov).forEach(function(k) { ov[k] = null; });
      _m4ShadSyncControls(); _m4ShadUpdateTabs(); _m4DrawPreview(); _m4SaveSettings();
    });
  }
  // Shadow control events
  ;['opacity','blur','x','y'].forEach(function(f) {
    var el  = document.getElementById('m4-shadow-' + f);
    var vEl = document.getElementById('m4-shadow-' + f + '-val');
    if (!el) return;
    el.addEventListener('input', function() {
      var v = parseInt(el.value, 10);
      if (vEl) vEl.textContent = v + (f === 'opacity' ? '%' : 'px');
      _m4ShadWrite(f, v);
    });
  });

  function _readBoxShadow(prefix) {
    var g = function(f) { var e = document.getElementById('m4-' + prefix + '-shadow-' + f); return e ? e.value : null; };
    return {
      color:   g('color')   || '#000000',
      opacity: parseInt(g('opacity') || '0',  10),
      blur:    parseInt(g('blur')    || '8',  10),
      x:       parseInt(g('x')       || '0',  10),
      y:       parseInt(g('y')       || '2',  10)
    };
  }

  function _readBoxStroke(prefix) {
    var g = function(f) { var e = document.getElementById('m4-' + prefix + '-stroke-' + f); return e ? e.value : null; };
    var enEl = document.getElementById('m4-' + prefix + '-stroke-enable');
    return {
      enable:   enEl ? enEl.checked : false,
      fill: {
        type:   g('fill-type')  || 'solid',
        color:  g('color')      || '#ffffff',
        color2: g('color2')     || '#aaaaaa',
        angle:  parseInt(g('fill-angle') || '0', 10),
        opacity: 100
      },
      opacity:  parseInt(g('opacity') || '100', 10),
      width:    parseInt(g('width')   || '2',   10),
      position: g('position') || 'center'
    };
  }

  // Shadow sliders (hl + cbg)
  ;['hl', 'cbg'].forEach(function(prefix) {
    ;['opacity', 'blur', 'x', 'y'].forEach(function(f) {
      var el  = document.getElementById('m4-' + prefix + '-shadow-' + f);
      var vEl = document.getElementById('m4-' + prefix + '-shadow-' + f + '-val');
      if (!el) return;
      el.addEventListener('input', function() {
        if (vEl) vEl.textContent = el.value + (f === 'opacity' ? '%' : 'px');
        _m4DrawPreview(); _m4SaveSettings();
      });
    });
  });

  // Stroke sliders + position (hl + cbg)
  ;['hl', 'cbg'].forEach(function(prefix) {
    ;['opacity', 'width'].forEach(function(f) {
      var el  = document.getElementById('m4-' + prefix + '-stroke-' + f);
      var vEl = document.getElementById('m4-' + prefix + '-stroke-' + f + '-val');
      if (!el) return;
      el.addEventListener('input', function() {
        if (vEl) vEl.textContent = el.value + (f === 'opacity' ? '%' : 'px');
        _m4DrawPreview(); _m4SaveSettings();
      });
    });
    var posEl = document.getElementById('m4-' + prefix + '-stroke-position');
    if (posEl) posEl.addEventListener('change', function() { _m4DrawPreview(); _m4SaveSettings(); });
  });

  // Stroke fill-type toggle + direction (hl + cbg)
  ;['hl', 'cbg'].forEach(function(prefix) {
    (function() {
      var solidBtn  = document.getElementById('m4-' + prefix + '-stroke-fill-solid');
      var gradBtn   = document.getElementById('m4-' + prefix + '-stroke-fill-grad');
      var row       = document.getElementById('m4-' + prefix + '-stroke-fill-row');
      var typeInput = document.getElementById('m4-' + prefix + '-stroke-fill-type');
      if (solidBtn && gradBtn) {
        solidBtn.addEventListener('click', function() {
          if (typeInput) typeInput.value = 'solid';
          solidBtn.classList.add('active'); gradBtn.classList.remove('active');
          if (row) row.classList.remove('gradient');
          _m4DrawPreview(); _m4SaveSettings();
        });
        gradBtn.addEventListener('click', function() {
          if (typeInput) typeInput.value = 'gradient';
          gradBtn.classList.add('active'); solidBtn.classList.remove('active');
          if (row) row.classList.add('gradient');
          _m4DrawPreview(); _m4SaveSettings();
        });
      }
      var dirBtn    = document.getElementById('m4-' + prefix + '-stroke-fill-dir');
      var angleInput = document.getElementById('m4-' + prefix + '-stroke-fill-angle');
      _m4AttachDial(dirBtn, function (next) {
        if (angleInput) angleInput.value = next;
        _m4DrawPreview(); _m4SaveSettings();
      });
    }());
  });
  // ── Active mode + Solo ───────────────────────────────────────────────────────
  function _m4SyncActiveUI() {
    var isOff  = (_m4ActiveMode === 'off');
    var isSolo = (_m4ActiveMode === 'solo');
    var _holdRow = document.getElementById('m4-hold-silence-row');
    if (_holdRow) _holdRow.style.display = isOff ? 'none' : '';
    var wbAccord = document.querySelector('.m4-accord-wbsection');
    if (wbAccord) wbAccord.style.display = isOff ? 'none' : '';
    // Disable Cur tab when off; disable Pre/Post tabs when solo
    ;['fill','stroke','shadow'].forEach(function(sect) {
      document.querySelectorAll('[data-' + sect + '-tab]').forEach(function(btn) {
        var st = btn.getAttribute('data-' + sect + '-tab');
        if (st === 'all') return;
        var disable = (st === 'cur' && isOff) || ((st === 'pre' || st === 'post') && isSolo);
        btn.disabled = disable;
        if (disable && (sect === 'fill' ? _m4FillTab : sect === 'stroke' ? _m4StrkTab : _m4ShadTab) === st) {
          // Auto-switch to All if active tab is now disabled
          if (sect === 'fill')   { _m4FillTab = 'all'; document.querySelectorAll('[data-fill-tab]').forEach(function(b)   { b.classList.toggle('active', b.getAttribute('data-fill-tab')   === 'all'); }); _m4FillSyncControls(); _m4FillUpdateTabs(); }
          if (sect === 'stroke') { _m4StrkTab = 'all'; document.querySelectorAll('[data-stroke-tab]').forEach(function(b) { b.classList.toggle('active', b.getAttribute('data-stroke-tab') === 'all'); }); _m4StrkSyncControls(); _m4StrkUpdateTabs(); }
          if (sect === 'shadow') { _m4ShadTab = 'all'; document.querySelectorAll('[data-shadow-tab]').forEach(function(b) { b.classList.toggle('active', b.getAttribute('data-shadow-tab') === 'all'); }); _m4ShadSyncControls(); _m4ShadUpdateTabs(); }
        }
      });
    });
  }

  document.querySelectorAll('.m4-active-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
      document.querySelectorAll('.m4-active-btn').forEach(function(b) { b.classList.remove('active'); });
      btn.classList.add('active');
      _m4ActiveMode = btn.getAttribute('data-active');
      var modeEl = document.getElementById('m4-active-mode');
      if (modeEl) modeEl.value = _m4ActiveMode;
      _m4SyncActiveUI();
      _m4DrawPreview(); _m4SaveSettings();
    });
  });

  (function() {
    var _holdEl = document.getElementById('m4-hold-silence');
    if (_holdEl) {
      _holdEl.addEventListener('change', function() {
        _m4HoldSilence = _holdEl.checked;
        _m4SaveSettings();
      });
    }
  }());

  // Wrap mode toggle
  function _m4SyncWrapUI() {
    if (m4FrameWidthRowEl) m4FrameWidthRowEl.style.display = (_m4WrapMode === 'auto') ? '' : 'none';
  }
  m4WrapBtns.forEach(function (btn) {
    btn.addEventListener('click', function () {
      m4WrapBtns.forEach(function (b) { b.classList.remove('active'); });
      btn.classList.add('active');
      _m4WrapMode = btn.getAttribute('data-wrap');
      _m4SyncWrapUI();
      _m4SaveSettings();
      _m4DrawPreview();
    });
  });



  // Cur in context buttons
  m4CurInCtxBtns.forEach(function(btn) {
    btn.addEventListener('click', function() {
      m4CurInCtxBtns.forEach(function(b) { b.classList.remove('active'); });
      btn.classList.add('active');
      _m4CurInCtx = btn.getAttribute('data-cur-in-ctx');
      _m4SaveSettings();
    });
  });

  // Bake cur+WB toggle
  m4BakeBtns.forEach(function (btn) {
    btn.addEventListener('click', function () {
      m4BakeBtns.forEach(function (b) { b.classList.remove('active'); });
      btn.classList.add('active');
      _m4BakeCurWB = (btn.getAttribute('data-bake') === 'on');
      _m4SaveSettings();
    });
  });

  // Shadow source toggle: fill / stroke / both. Live-redraws the preview
  // so the user sees the swap immediately without scrubbing through captions.
  m4ShadowOnBtns.forEach(function (btn) {
    btn.addEventListener('click', function () {
      m4ShadowOnBtns.forEach(function (b) { b.classList.remove('active'); });
      btn.classList.add('active');
      _m4ShadowFollow = btn.getAttribute('data-shadow-on') || 'both';
      _m4SaveSettings();
      _m4DrawPreview();
    });
  });

  // Language toggle - picks the language baked onto the next saved
  // template. Already-saved templates keep their own language and are
  // unaffected by this selector.
  (function () {
    var row = document.getElementById('m4-tpl-lang-row');
    if (!row) return;
    var btns = row.querySelectorAll('.m4-tpl-lang-btn');
    var cur = _m4GetSelectedLang();
    btns.forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-tpl-lang') === cur);
      b.addEventListener('click', function () {
        var lang = b.getAttribute('data-tpl-lang') || 'en';
        try { localStorage.setItem(M4_TPL_LANG_KEY, lang); } catch (_) {}
        btns.forEach(function (x) { x.classList.remove('active'); });
        b.classList.add('active');
      });
    });
  }());

  // Frame width slider
  if (m4FrameWidthEl) {
    m4FrameWidthEl.addEventListener('input', function () {
      var fwvEl = document.getElementById('m4-frame-width-val');
      if (fwvEl) fwvEl.textContent = m4FrameWidthEl.value + '%';
      _m4DrawPreview();
      _m4SaveSettings();
    });
  }

  // Zoom buttons
  function _m4SetZoom(z) {
    _m4PreviewZoom = Math.max(0.05, Math.min(3.0, z));
    var lbl = document.getElementById('m4-zoom-label');
    if (lbl) {
      var pct = Math.round(_m4PreviewZoom * 100);
      lbl.textContent = (pct >= 100 ? pct + '%' : _m4PreviewZoom.toFixed(2) + 'x');
    }
    _m4DrawPreview();
  }
  var _m4ZoomInBtn  = document.getElementById('m4-zoom-in');
  var _m4ZoomOutBtn = document.getElementById('m4-zoom-out');
  if (_m4ZoomInBtn)  _m4ZoomInBtn.addEventListener('click',  function() { _m4SetZoom(_m4PreviewZoom * _m4ZoomStep); });
  if (_m4ZoomOutBtn) _m4ZoomOutBtn.addEventListener('click', function() { _m4SetZoom(_m4PreviewZoom / _m4ZoomStep); });

  // Caption navigation on the Apply-page preview. Steps through captions
  // with wraparound; hidden entirely when there's nothing to navigate.
  var _m4PreviewPrevBtn = document.getElementById('m4-preview-prev');
  var _m4PreviewNextBtn = document.getElementById('m4-preview-next');
  function _m4UpdatePreviewNavVisibility() {
    var enough = generatedCaptions && generatedCaptions.length >= 2;
    if (_m4PreviewPrevBtn) _m4PreviewPrevBtn.hidden = !enough;
    if (_m4PreviewNextBtn) _m4PreviewNextBtn.hidden = !enough;
    // Edit button is disabled when there are no captions to edit.
    var editBtn = document.getElementById('m4-preview-edit');
    if (editBtn) editBtn.disabled = !(generatedCaptions && generatedCaptions.length);
  }
  function _m4StepPreviewCap(delta) {
    if (!generatedCaptions || !generatedCaptions.length) return;
    var n = generatedCaptions.length;
    _m4PreviewCapIdx = ((_m4PreviewCapIdx + delta) % n + n) % n;
    _m4PreviewWordIdx = 0; // restart cycling from word 0 of the new caption
    _m4PreviewAnimProgress = 0;
    _m4PreviewCycleStart = Date.now();
    _m4DrawPreview();
  }
  if (_m4PreviewPrevBtn) _m4PreviewPrevBtn.addEventListener('click', function () { _m4StepPreviewCap(-1); });
  if (_m4PreviewNextBtn) _m4PreviewNextBtn.addEventListener('click', function () { _m4StepPreviewCap(+1); });
  // Edit button on the Style preview -> opens the popup focused on the
  // caption currently being previewed.
  var _m4PreviewEditBtn = document.getElementById('m4-preview-edit');
  if (_m4PreviewEditBtn) {
    _m4PreviewEditBtn.addEventListener('click', function () {
      if (!generatedCaptions || !generatedCaptions.length) return;
      var idx = Math.max(0, Math.min(generatedCaptions.length - 1, _m4PreviewCapIdx));
      if (typeof _openCaptionEditor === 'function') _openCaptionEditor(idx);
    });
  }
  // Pin button - toggles position:sticky on the preview wrap so the
  // canvas stays in view while the user scrolls the settings below.
  // State persists across panel reloads so a "pinned" user doesn't lose
  // their preference on every restart.
  var _m4PreviewPinBtn  = document.getElementById('m4-preview-pin');
  var _m4PreviewWrapEl  = document.getElementById('m4-preview-wrap');
  var M4_PREVIEW_PIN_KEY = 'ae_m4_preview_pinned';
  function _m4ApplyPreviewPin(pinned) {
    if (_m4PreviewWrapEl) _m4PreviewWrapEl.classList.toggle('pinned', !!pinned);
    if (_m4PreviewPinBtn) {
      _m4PreviewPinBtn.classList.toggle('active', !!pinned);
      _m4PreviewPinBtn.setAttribute('aria-pressed', pinned ? 'true' : 'false');
      _m4PreviewPinBtn.title = pinned ? 'Unpin preview' : 'Pin preview';
    }
  }
  if (_m4PreviewPinBtn && _m4PreviewWrapEl) {
    var _wasPinned = false;
    try { _wasPinned = localStorage.getItem(M4_PREVIEW_PIN_KEY) === '1'; } catch (_) {}
    _m4ApplyPreviewPin(_wasPinned);
    _m4PreviewPinBtn.addEventListener('click', function () {
      var next = !_m4PreviewWrapEl.classList.contains('pinned');
      _m4ApplyPreviewPin(next);
      try { localStorage.setItem(M4_PREVIEW_PIN_KEY, next ? '1' : '0'); } catch (_) {}
    });
  }
  _m4UpdatePreviewNavVisibility();

  // ── Templates ───────────────────────────────────────────────────────────────
  var M4_TEMPLATES_KEY = 'ae_m4_templates';
  // Dev-only: language baked into the next saved template. The selector in
  // Advanced sets this; on Save Template the value is copied onto the new
  // template so its card always renders in that script regardless of the
  // current selector position.
  var M4_TPL_LANG_KEY  = 'ae_m4_tpl_lang';

  // Two-line variant - used when the template's active mode is `line`
  // or `off` (the user wants to see how multi-line captions stack).
  var M4_TPL_PHRASE_EN = ['make', 'it', 'count', 'today'];
  var M4_TPL_LINES_EN  = [[0, 1], [2, 3]];
  // RTL: line indices are reversed so the reading-first word ends up on
  // the visual right (e.g. line 1 draws word 1 at smaller x and word 0
  // at larger x - read right-to-left as 0, 1).
  // 4 words, 2 + 2 split. Line 2 uses longer words on purpose so the
  // template card shows a visibly asymmetric layout (line 1 narrower
  // than line 2) - useful for spotting tight horizontal fits.
  var M4_TPL_PHRASE_AR = ['نص', 'جميل', 'للترجمة', 'العربية'];
  var M4_TPL_LINES_AR  = [[1, 0], [3, 2]];

  // One-line variant - used when the template's active mode is `word`
  // or `solo`. Three words; fits because _m4DrawTplFrame measures the
  // actual phrase width and zooms the font down whenever the line
  // would otherwise overflow the card.
  var M4_TPL_PHRASE_EN_1L = ['make', 'it', 'count'];
  var M4_TPL_LINES_EN_1L  = [[0, 1, 2]];
  var M4_TPL_PHRASE_AR_1L = ['نص', 'جميل', 'للعربية'];
  var M4_TPL_LINES_AR_1L  = [[2, 1, 0]];

  // Module-level fallback used by code paths that don't carry a per-template
  // language (e.g. anything outside the strip). Always English, 2-line.
  var M4_TPL_PHRASE    = M4_TPL_PHRASE_EN;
  var M4_TPL_LINES     = M4_TPL_LINES_EN;

  function _m4GetSelectedLang() {
    try { return localStorage.getItem(M4_TPL_LANG_KEY) || 'en'; } catch (_) { return 'en'; }
  }
  // Returns { phrase, lines } for a given language tag. Defaults to English
  // when the tag is missing, unknown, or null - so existing untagged
  // templates keep their current preview.
  function _m4PhraseFor(lang, activeMode) {
    // Two-line phrases for line/off modes; single-line for word/solo
    // (single-word highlight reads cleaner when there's no second row
    // competing for attention).
    var isAr     = (lang === 'ar');
    var oneLine  = (activeMode === 'word' || activeMode === 'solo');
    if (oneLine) {
      return isAr
        ? { phrase: M4_TPL_PHRASE_AR_1L, lines: M4_TPL_LINES_AR_1L }
        : { phrase: M4_TPL_PHRASE_EN_1L, lines: M4_TPL_LINES_EN_1L };
    }
    return isAr
      ? { phrase: M4_TPL_PHRASE_AR, lines: M4_TPL_LINES_AR }
      : { phrase: M4_TPL_PHRASE_EN, lines: M4_TPL_LINES_EN };
  }
  var _m4TplStrip      = document.getElementById('m4-tpl-strip');
  var _m4SaveTplBtn    = document.getElementById('m4-save-tpl-btn');
  var _m4TplIntervals  = [];
  var _m4ActiveTplId   = (function () {
    try { return localStorage.getItem('ae_m4_active_tpl') || null; }
    catch (_) { return null; }
  }());

  // Set of bundled (default) template IDs - populated by _m4SeedDefaultTemplates.
  // A template's ID being in here is the source of truth for "is this a default?",
  // which decides whether delete soft-hides (defaults) or hard-removes (user-saved).
  var _m4BundledIds    = {};

  // Templates carry an explicit `order` field (integer, low -> first). It's
  // the source of truth for strip / popup grid display order. The array
  // position in storage is kept aligned to make exports + diffs readable,
  // but anywhere we read templates we sort by `order` first. Entries
  // without an `order` (older storage, migrating users) fall back to
  // their insertion index - stable, monotonic - so existing tester
  // installs don't reshuffle on the upgrade.
  function _m4LoadTemplates() {
    var arr;
    try { arr = JSON.parse(localStorage.getItem(M4_TEMPLATES_KEY) || '[]'); } catch(_) { return []; }
    if (!Array.isArray(arr)) return [];
    return arr.slice().sort(function (a, b) {
      var ao = (a && typeof a.order === 'number') ? a.order : arr.indexOf(a);
      var bo = (b && typeof b.order === 'number') ? b.order : arr.indexOf(b);
      return ao - bo;
    });
  }
  function _m4PersistTemplates(arr) {
    if (!Array.isArray(arr)) return;
    // `order` is authoritative. Persist NEVER overwrites an existing
    // numeric order - that way the seeding pass can refresh a template's
    // settings without clobbering the user's drag-reorder. Only entries
    // without an `order` get one assigned (next available index), which
    // covers freshly-saved user templates + new bundled defaults.
    var maxOrder = -1;
    for (var j = 0; j < arr.length; j++) {
      if (arr[j] && typeof arr[j].order === 'number' && arr[j].order > maxOrder) {
        maxOrder = arr[j].order;
      }
    }
    for (var i = 0; i < arr.length; i++) {
      if (arr[i] && typeof arr[i].order !== 'number') {
        maxOrder += 1;
        arr[i].order = maxOrder;
      }
    }
    try { localStorage.setItem(M4_TEMPLATES_KEY, JSON.stringify(arr)); } catch(_) {}
  }

  // ── Template language visibility ─────────────────────────────────────────
  // User picks which languages to surface in the picker grids from Settings.
  // Default is English only; Arabic is opt-in. Untagged templates fall through
  // to 'en' so the legacy set keeps showing.
  var TPL_LANGS_KEY = 'machicut_tpl_langs';
  function _m4LoadAllowedLangs() {
    try {
      var raw = localStorage.getItem(TPL_LANGS_KEY);
      if (raw) {
        var arr = JSON.parse(raw);
        if (Array.isArray(arr)) return arr;
      }
    } catch (_) {}
    // MUST match the Settings checkboxes' first-run default (main.js). It
    // used to be ['en'] while Settings showed Arabic ticked and only wrote
    // localStorage when a box was TOGGLED - so on a fresh install Arabic
    // looked enabled but its templates were filtered out, and the only cure
    // was unticking + reticking Arabic. Reported by users repeatedly.
    return ['en', 'ar'];
  }
  function _m4TplLangAllowed(t) {
    var allowed = _m4LoadAllowedLangs();
    var lang = (t && t.settings && t.settings.language) || 'en';
    return allowed.indexOf(lang) !== -1;
  }
  // Exposed so the settings UI can trigger a re-render on toggle.
  window._m4RefreshTplVisibility = function () {
    if (typeof _m4RenderTplStrip === 'function') _m4RenderTplStrip();
  };
  function _m4IsBundled(id) {
    return !!_m4BundledIds[id];
  }

  // Sync default templates from the bundled file on every panel launch.
  //   - Bundled template the user has -> overwrite settings (refresh fixes/updates).
  //     The user-only `hidden` flag is preserved so prior soft-deletes stick,
  //     and the user's chosen list order is preserved.
  //   - Bundled template the user doesn't have -> append with hidden:false
  //     (newly added defaults appear at the end of the strip).
  //   - User-saved templates (ID not in bundle) -> never touched.
  function _m4SeedDefaultTemplates() {
    try {
      var fs = require('fs');
      var path = require('path');
      var ext = CEP.getExtensionPath();
      var tplPath = path.join(ext, 'default-templates.json');
      if (!fs.existsSync(tplPath)) tplPath = path.join(ext, 'client', 'default-templates.json');
      if (!fs.existsSync(tplPath)) return;
      var raw  = fs.readFileSync(tplPath, 'utf8');
      var data = JSON.parse(raw);

      // Backward compat: file used to be a plain array. New format wraps
      // templates and adds an optional force_remove list of IDs that the
      // dev has retired - testers' panels drop those from localStorage so
      // soft-deleted bundled templates actually disappear from the grid.
      var bundled, forceRemove;
      if (Array.isArray(data)) {
        bundled = data;
        forceRemove = [];
      } else {
        bundled = data.templates || [];
        forceRemove = data.force_remove || [];
      }
      if (!bundled.length && !forceRemove.length) return;

      var removeIds = {};
      forceRemove.forEach(function(id) { if (id) removeIds[id] = true; });

      // Refresh the bundled-IDs lookup (used by delete handler + restore button)
      _m4BundledIds = {};
      var bundledById = {};
      bundled.forEach(function(t) {
        if (t && t.id) { _m4BundledIds[t.id] = true; bundledById[t.id] = t; }
      });

      var existing = _m4LoadTemplates();
      var merged = [];
      var emitted = {};

      // Walk user's existing list - preserves their drag-reorder and the
      // position of user-saved templates relative to bundled ones.
      existing.forEach(function(t) {
        if (!t || !t.id) return;
        if (removeIds[t.id]) return; // force-removed -> drop from user's panel
        if (bundledById[t.id]) {
          // Bundled template refresh: pull NEW settings from disk but
          // preserve the user's `order` and `hidden` so a settings
          // update never undoes a drag-reorder or a soft-delete.
          merged.push({
            id:       t.id,
            settings: bundledById[t.id].settings,
            hidden:   !!t.hidden,
            order:    (typeof t.order === 'number') ? t.order : undefined
          });
        } else {
          merged.push(t); // user-saved, pass through (order already present)
        }
        emitted[t.id] = true;
      });

      // Append any bundled IDs the user has never seen (genuine new defaults)
      bundled.forEach(function(b) {
        if (!emitted[b.id]) {
          merged.push({ id: b.id, settings: b.settings, hidden: false });
        }
      });

      _m4PersistTemplates(merged);
    } catch (_) { /* missing/invalid file - skip silently */ }
  }
  _m4SeedDefaultTemplates();

  // ── Style page tab switching (Templates / Settings) ───────────────────────
  (function () {
    var STYLE_TAB_KEY = 'ae_m4_style_tab';
    var tabs   = document.querySelectorAll('.m4-style-tab[data-style-tab]');
    var panels = document.querySelectorAll('.m4-style-panel[data-style-tab]');
    if (!tabs.length || !panels.length) return;

    function setActive(name) {
      tabs.forEach(function (t) {
        t.classList.toggle('active', t.getAttribute('data-style-tab') === name);
      });
      panels.forEach(function (p) {
        p.classList.toggle('hidden', p.getAttribute('data-style-tab') !== name);
      });
      try { localStorage.setItem(STYLE_TAB_KEY, name); } catch (_) {}
    }

    tabs.forEach(function (t) {
      t.addEventListener('click', function () {
        setActive(t.getAttribute('data-style-tab'));
      });
    });

    // Restore last-active tab on load. Defaults to "templates" when nothing
    // is stored - matches the HTML's initial class state.
    try {
      var saved = localStorage.getItem(STYLE_TAB_KEY);
      if (saved === 'templates' || saved === 'custom') setActive(saved);
    } catch (_) {}
  }());

  // Draw one animation frame on a template card canvas using saved settings + fixed phrase
  function _m4DrawTplFrame(cv, settings, curIdx) {
    var W = cv.width, H = cv.height;
    var c = cv.getContext('2d');
    // Per-template "Shadow on" preference (set via Advanced before saving).
    // Closure-captured by _drawW below. Default = 'both'; older templates
    // without the field follow the new default automatically.
    var _tplShadowFollow = (settings && (settings.shadowFollow === 'fill' ||
                                         settings.shadowFollow === 'stroke'))
      ? settings.shadowFollow
      : 'both';
    // Per-template language tag drives which placeholder phrase is shown.
    // The activeMode picks between the 2-line variant (line/off modes,
    // where stacked captions matter) and the 1-line variant (word/solo
    // modes, where the highlight reads cleaner on a single line).
    // Untagged templates fall through to English.
    var _phr   = _m4PhraseFor(
      settings && settings.language,
      settings && settings.activeMode
    );
    var _basePhrase = _phr.phrase;
    var _baseLines  = _phr.lines;
    // Solo mode: cycle through the words but render only the current one
    var _tplSolo = (settings.activeMode === 'solo');
    var TPL_PHRASE = _tplSolo ? [_basePhrase[curIdx % _basePhrase.length]] : _basePhrase;
    var TPL_LINES  = _tplSolo ? [[0]] : _baseLines;
    if (_tplSolo) curIdx = 0;
    else curIdx = ((curIdx % TPL_PHRASE.length) + TPL_PHRASE.length) % TPL_PHRASE.length;

    var baseFF = settings.fontFamily || 'Arial';
    var baseFS = settings.fontStyle  || 'bold';
    var baseFZ = settings.fontSize   || 24;
    var ov = settings.typoOverrides || {};
    function _ff(s)  { return (ov[s] && ov[s].fontFamily) || baseFF; }
    function _fst(s) { return (ov[s] && ov[s].fontStyle)  || baseFS; }
    function _fz(s)  { return (ov[s] && ov[s].fontSize)   || baseFZ; }

    var ls = settings.letterSpacing || 0;
    var tt = settings.textTransform || 'none';
    function _tr(w) {
      if (tt === 'uppercase') return w.toUpperCase();
      if (tt === 'lowercase') return w.toLowerCase();
      return w;
    }
    var dW = TPL_PHRASE.map(_tr);

    // Auto-fit zoom: pick the tightest constraint between vertical and
    // horizontal. Vertical estimate uses the largest font size across
    // pre/cur/post states (so Active=75 with base=24 doesn't blow the
    // card top). Horizontal estimate measures the actual widest line
    // at unit zoom - the previous constant `W / 360` over-estimated
    // for short phrases and under-estimated for long ones (3-word
    // one-line previews on heavy fonts overflowed).
    var _maxFZ       = Math.max(_fz('pre'), _fz('cur'), _fz('post'));
    var _approxLineH = _maxFZ + (settings.lineGap || 4);
    var _zoomByH     = (H * 0.62) / (TPL_LINES.length * _approxLineH);

    // Measure widest line at unit (zoom=1) using the largest per-state
    // font size as a safe upper bound. Per-state size overrides (Active
    // bigger than Pre/Post) would otherwise make our zoom guess too
    // optimistic; using _maxFZ guarantees the visible line will fit.
    c.font = baseFS + ' ' + Math.round(_maxFZ) + 'px ' + baseFF;
    c.letterSpacing = ls ? ls + 'px' : '0px';
    var _spW1      = c.measureText(' ').width;
    var _maxLineW1 = 0;
    for (var _li1 = 0; _li1 < TPL_LINES.length; _li1++) {
      var _row = TPL_LINES[_li1];
      var _lw  = 0;
      for (var _wi1 = 0; _wi1 < _row.length; _wi1++) {
        _lw += c.measureText(dW[_row[_wi1]]).width;
      }
      _lw += _spW1 * Math.max(0, _row.length - 1);
      if (_lw > _maxLineW1) _maxLineW1 = _lw;
    }
    // 0.82 leaves clear horizontal breathing room on both sides so the
    // line doesn't visually touch (or come close to) the card edges -
    // bumped from 0.92 because the 8% margin still felt cramped on
    // one-line previews with the 3-word phrase.
    var _zoomByW = (W * 0.82) / (_maxLineW1 || 1);
    var zoom = Math.min(_zoomByW, _zoomByH);
    var _tplIsOff  = (settings.activeMode === 'off');
    var _tplIsLine = (settings.activeMode === 'line');
    // For line mode: find which line curIdx is on
    var _curLine = 0;
    for (var _tli = 0; _tli < TPL_LINES.length; _tli++) {
      if (TPL_LINES[_tli].indexOf(curIdx) >= 0) { _curLine = _tli; break; }
    }
    function _tplLineOf(i) {
      for (var _l = 0; _l < TPL_LINES.length; _l++) {
        if (TPL_LINES[_l].indexOf(i) >= 0) return _l;
      }
      return 0;
    }
    function _tplState(i) {
      if (_tplIsOff) return 'pre';
      if (_tplIsLine) {
        var _li = _tplLineOf(i);
        return _li < _curLine ? 'pre' : _li === _curLine ? 'cur' : 'post';
      }
      return i < curIdx ? 'pre' : i === curIdx ? 'cur' : 'post';
    }

    function _fm(ff, fst, fz) {
      c.font = fst + ' ' + Math.round(fz * zoom) + 'px ' + ff;
      c.letterSpacing = '0px';
      var m = c.measureText('Ag');
      return { a: Math.ceil(m.actualBoundingBoxAscent  || fz * zoom * 0.8),
               d: Math.ceil(m.actualBoundingBoxDescent || fz * zoom * 0.2) };
    }
    var mPre = _fm(_ff('pre'), _fst('pre'), _fz('pre'));
    var mCur = _fm(_ff('cur'), _fst('cur'), _fz('cur'));
    var mPst = _fm(_ff('post'), _fst('post'), _fz('post'));
    var asc   = Math.max(mPre.a, mCur.a, mPst.a);
    var des   = Math.max(mPre.d, mCur.d, mPst.d);
    var gap   = (settings.lineGap || 4) * zoom;
    var lineH = asc + des + gap;

    c.letterSpacing = ls ? ls + 'px' : '0px';
    function _ww(ff, fst, fz, w) {
      c.font = fst + ' ' + Math.round(fz * zoom) + 'px ' + ff;
      return c.measureText(w).width;
    }
    var wW = TPL_PHRASE.map(function(_, i) {
      var s = _tplState(i);
      return _ww(_ff(s), _fst(s), _fz(s), dW[i]);
    });
    c.font = _fst('cur') + ' ' + Math.round(_fz('cur') * zoom) + 'px ' + _ff('cur');
    var spW = c.measureText(' ').width;

    var wX = [];
    for (var li = 0; li < TPL_LINES.length; li++) {
      var lw = TPL_LINES[li].reduce(function(s, i) { return s + wW[i]; }, 0) + spW * (TPL_LINES[li].length - 1);
      var x0 = (W - lw) / 2;
      TPL_LINES[li].forEach(function(i) { wX[i] = x0; x0 += wW[i] + spW; });
    }
    var tplPad = 8; // vertical breathing room
    var totalH = TPL_LINES.length * lineH - gap;
    // Clamp baseY so the first line's top never goes above the card top -
    // the auto-fit above should keep totalH within bounds, but if it
    // doesn't (extreme override values), pinning to tplPad + asc is
    // better than rendering glyphs outside the canvas.
    var baseY  = Math.max(tplPad + asc, tplPad + (H - tplPad * 2 - totalH) / 2 + asc);

    function _hA(hex, a) {
      var h = (hex || '#000').replace('#', '');
      if (h.length === 3) h = h[0]+h[0]+h[1]+h[1]+h[2]+h[2];
      return 'rgba('+parseInt(h.slice(0,2),16)+','+parseInt(h.slice(2,4),16)+','+parseInt(h.slice(4,6),16)+','+a+')';
    }
    function _mkFill(fill, x, w, y, h) {
      var a = (fill.opacity != null ? fill.opacity : 100) / 100;
      if (fill.type === 'gradient') {
        // CSS gradient angle convention: 0° = up, 90° = right.
        var angle = (fill.angle || 0) * Math.PI / 180;
        var dx = Math.sin(angle);
        var dy = -Math.cos(angle);
        var cx = x + w / 2, cy = (y || 0) + (h || 0) / 2;
        var len = Math.max(Math.abs(w / 2 * dx) + Math.abs((h || 0) / 2 * dy), 1);
        var g = c.createLinearGradient(cx - dx * len, cy - dy * len,
                                       cx + dx * len, cy + dy * len);
        g.addColorStop(0, _hA(fill.color, a));
        g.addColorStop(1, _hA(fill.color2 || fill.color, a));
        return g;
      }
      return _hA(fill.color, a);
    }
    var strokePos = settings.strokePosition || 'outside';
    function _drawW(stroke, fillS, text, x, y, strokeFillS, shadow, phase) {
      var sw = stroke ? (stroke.width || 0) : 0;
      var _hasSh = !!(shadow && (shadow.opacity || 0) > 0);
      var _shOnStroke = _hasSh &&
                        (_tplShadowFollow === 'stroke' || _tplShadowFollow === 'both') &&
                        (strokePos === 'outside' || strokePos === 'center');
      var _shOnFill   = _hasSh &&
                        (_tplShadowFollow === 'fill'   || _tplShadowFollow === 'both');
      function _applySh() {
        if (!_hasSh) return;
        c.shadowColor   = _hA(shadow.color || '#000', (shadow.opacity || 100) / 100);
        c.shadowBlur    = (shadow.blur || 0) * zoom;
        c.shadowOffsetX = (shadow.x    || 0) * zoom;
        c.shadowOffsetY = (shadow.y    || 0) * zoom;
      }
      function _clearSh() {
        c.shadowColor = 'transparent';
        c.shadowBlur = 0;
        c.shadowOffsetX = 0;
        c.shadowOffsetY = 0;
      }

      // STROKE-ONLY pass for outside/center - strokes form a background
      // layer behind every fill in the phrase. Inside falls back to 'both'.
      if (phase === 'stroke') {
        if (sw <= 0) return;
        if (strokePos === 'inside') return;
        c.lineWidth = sw * zoom * 2;
        c.strokeStyle = strokeFillS || _hA(stroke.color || '#000', (stroke.opacity || 100) / 100);
        c.lineJoin = 'round';
        if (_shOnStroke) { _applySh(); c.strokeText(text, x, y); _clearSh(); }
        else             { c.strokeText(text, x, y); }
        return;
      }
      // FILL-ONLY pass - drawn on top of all strokes.
      if (phase === 'fill') {
        c.fillStyle = fillS;
        if (_shOnFill) { _applySh(); c.fillText(text, x, y); _clearSh(); }
        else           { c.fillText(text, x, y); }
        return;
      }

      // BOTH-PHASES (single-pass) - for inside strokePos or direct callers.
      c.fillStyle = fillS;
      if (sw > 0) {
        c.lineWidth = sw * zoom * 2;
        c.strokeStyle = strokeFillS || _hA(stroke.color || '#000', (stroke.opacity || 100) / 100);
        c.lineJoin = 'round';
        if (strokePos === 'outside') {
          if (_shOnStroke) {
            _applySh(); c.strokeText(text, x, y); _clearSh();
            if (_shOnFill) { _applySh(); c.fillText(text, x, y); _clearSh(); }
            else           { c.fillText(text, x, y); }
          } else {
            if (_shOnFill) { _applySh(); c.fillText(text, x, y); _clearSh(); }
            else           { c.fillText(text, x, y); }
            c.strokeText(text, x, y);
            c.fillText(text, x, y);
          }
        } else if (strokePos === 'center') {
          if (_shOnStroke) {
            _applySh(); c.strokeText(text, x, y); _clearSh();
            if (_shOnFill) { _applySh(); c.fillText(text, x, y); _clearSh(); }
            else           { c.fillText(text, x, y); }
          } else {
            if (_shOnFill) { _applySh(); c.fillText(text, x, y); _clearSh(); }
            else           { c.fillText(text, x, y); }
            c.strokeText(text, x, y);
          }
        } else {
          // 'inside' - stroke clipped via source-atop, single shadow on fill
          if (_shOnFill) { _applySh(); c.fillText(text, x, y); _clearSh(); }
          else           { c.fillText(text, x, y); }
          c.globalCompositeOperation = 'source-atop';
          c.strokeText(text, x, y);
          c.globalCompositeOperation = 'source-over';
        }
      } else {
        if (_shOnFill) { _applySh(); c.fillText(text, x, y); _clearSh(); }
        else           { c.fillText(text, x, y); }
      }
    }

    // Rounded rect path helper (local)
    function _rr(x, y, w, h, r) {
      var rad = Math.min(r, w / 2, h / 2);
      c.beginPath();
      c.moveTo(x + rad, y);
      c.lineTo(x + w - rad, y); c.quadraticCurveTo(x + w, y, x + w, y + rad);
      c.lineTo(x + w, y + h - rad); c.quadraticCurveTo(x + w, y + h, x + w - rad, y + h);
      c.lineTo(x + rad, y + h); c.quadraticCurveTo(x, y + h, x, y + h - rad);
      c.lineTo(x, y + rad); c.quadraticCurveTo(x, y, x + rad, y);
      c.closePath();
    }
    function _tplBoxStroke(x, y, w, h, rad, sk) {
      if (!sk || !sk.enable || (sk.width || 0) <= 0) return;
      var sw = (sk.width || 2) * zoom;
      var pos = sk.position || 'center';
      var alpha = (sk.opacity != null ? sk.opacity : 100) / 100;
      c.save();
      if (pos === 'inside') {
        _rr(x, y, w, h, rad); c.clip();
        _rr(x, y, w, h, rad); c.lineWidth = sw * 2;
      } else if (pos === 'outside') {
        _rr(x - sw / 2, y - sw / 2, w + sw, h + sw, rad + sw / 2); c.lineWidth = sw;
      } else {
        _rr(x, y, w, h, rad); c.lineWidth = sw;
      }
      c.strokeStyle = _mkFill(sk.fill || { type: 'solid', color: '#ffffff', opacity: 100 }, x, w, y, h);
      c.globalAlpha = alpha;
      c.stroke();
      c.restore();
    }

    c.clearRect(0, 0, W, H);
    c.fillStyle = '#262a36'; c.fillRect(0, 0, W, H);

    // Caption BG
    if (settings.showCBG) {
      var _cbgPadT = (settings.cbgPadTop    != null ? settings.cbgPadTop    : 8)  * zoom;
      var _cbgPadB = (settings.cbgPadBottom != null ? settings.cbgPadBottom : 8)  * zoom;
      var _cbgPadL = (settings.cbgPadLeft   != null ? settings.cbgPadLeft   : 12) * zoom;
      var _cbgPadR = (settings.cbgPadRight  != null ? settings.cbgPadRight  : 12) * zoom;
      var _cbgRad  = (settings.cbgRadius || 12) * zoom;
      var _cbgOp   = (settings.cbgOpacity != null ? settings.cbgOpacity / 100 : 0.6);
      var _cbgF    = settings.cbgFill || { type: 'solid', color: settings.cbgColor || '#000000', color2: '#333333', angle: 0, opacity: 100 };
      var _cbgModeT   = settings.cbgMode   || 'full';
      var _cbgCornerT = settings.cbgCorner || 'separate';
      var lineH_inner = asc + des + gap;

      // Build boxes
      var _tplBoxes = TPL_LINES.map(function(lineIdxs, li) {
        var lw = lineIdxs.reduce(function(s, i) { return s + wW[i]; }, 0) + spW * (lineIdxs.length - 1);
        return { x: (W - lw) / 2 - _cbgPadL, y: (baseY - asc) + li * lineH_inner - _cbgPadT,
                 w: lw + _cbgPadL + _cbgPadR,  h: (asc + des) + _cbgPadT + _cbgPadB };
      });
      if (_cbgModeT === 'full') {
        var _tmaxLW = 0;
        _tplBoxes.forEach(function(b) { var tw = b.w - _cbgPadL - _cbgPadR; if (tw > _tmaxLW) _tmaxLW = tw; });
        _tplBoxes = [{ x: (W - _tmaxLW) / 2 - _cbgPadL, y: (baseY - asc) - _cbgPadT,
                       w: _tmaxLW + _cbgPadL + _cbgPadR, h: totalH + _cbgPadT + _cbgPadB }];
      }

      var _isTplMerge = (_cbgModeT === 'line' && _cbgCornerT === 'merge');

      // Draw fills
      c.save();
      c.globalAlpha = _cbgOp;
      if (_isTplMerge) {
        var _tbx0 = Math.min.apply(null, _tplBoxes.map(function(b){return b.x;}));
        var _tbx1 = Math.max.apply(null, _tplBoxes.map(function(b){return b.x+b.w;}));
        var _tby0 = _tplBoxes[0].y, _tby1 = _tplBoxes[_tplBoxes.length-1].y + _tplBoxes[_tplBoxes.length-1].h;
        _buildMergedBgPath(c, _tplBoxes, _cbgRad);
        c.fillStyle = _mkFill(_cbgF, _tbx0, _tbx1 - _tbx0, _tby0, _tby1 - _tby0);
        c.fill();
      } else {
        _tplBoxes.forEach(function(b) {
          _rr(b.x, b.y, b.w, b.h, _cbgRad);
          c.fillStyle = _mkFill(_cbgF, b.x, b.w, b.y, b.h);
          c.fill();
        });
      }
      c.restore();
      // Strokes
      if (_isTplMerge) {
        var _tsk = settings.cbgStroke;
        if (_tsk && _tsk.enable && (_tsk.width || 0) > 0) {
          var _tsw = (_tsk.width || 2) * zoom, _tpos = _tsk.position || 'center';
          var _tsa = (_tsk.opacity != null ? _tsk.opacity : 100) / 100;
          c.save();
          if (_tpos === 'inside') {
            _buildMergedBgPath(c, _tplBoxes, _cbgRad); c.clip();
            _buildMergedBgPath(c, _tplBoxes, _cbgRad); c.lineWidth = _tsw * 2;
          } else if (_tpos === 'outside') {
            var _tsexp = _tplBoxes.map(function(b){return{x:b.x-_tsw/2,y:b.y-_tsw/2,w:b.w+_tsw,h:b.h+_tsw};});
            _buildMergedBgPath(c, _tsexp, _cbgRad + _tsw / 2); c.lineWidth = _tsw;
          } else {
            _buildMergedBgPath(c, _tplBoxes, _cbgRad); c.lineWidth = _tsw;
          }
          c.strokeStyle = _mkFill(_tsk.fill || {type:'solid',color:'#ffffff',opacity:100}, _tbx0, _tbx1-_tbx0, _tby0, _tby1-_tby0);
          c.globalAlpha = _tsa; c.stroke(); c.restore();
        }
      } else {
        _tplBoxes.forEach(function(b) { _tplBoxStroke(b.x, b.y, b.w, b.h, _cbgRad, settings.cbgStroke); });
      }
    }

    // Word box highlight
    if (settings.showHL && !_tplIsOff) {
      var hlPadT = (settings.hlPadTop    != null ? settings.hlPadTop    : 8) * zoom;
      var hlPadB = (settings.hlPadBottom != null ? settings.hlPadBottom : 8) * zoom;
      var hlPadL = (settings.hlPadLeft   != null ? settings.hlPadLeft   : 8) * zoom;
      var hlPadR = (settings.hlPadRight  != null ? settings.hlPadRight  : 8) * zoom;
      var hlRad  = (settings.hlRadius || 8) * zoom;
      var curLine = _curLine;
      var _hlX, _hlW;
      if (_tplIsLine) {
        var _llx0 = Infinity, _llx1 = -Infinity;
        TPL_LINES[_curLine].forEach(function(i) { _llx0 = Math.min(_llx0, wX[i]); _llx1 = Math.max(_llx1, wX[i] + wW[i]); });
        _hlX = _llx0 - hlPadL; _hlW = (_llx1 - _llx0) + hlPadL + hlPadR;
      } else {
        _hlX = wX[curIdx] - hlPadL; _hlW = wW[curIdx] + hlPadL + hlPadR;
      }
      var _tplBaseY = baseY + curLine * lineH;
      var _hlY = Math.round(_tplBaseY - asc) - hlPadT;
      var _hlH = (asc + des) + hlPadT + hlPadB;
      var _hlR = Math.min(hlRad, _hlW / 2, _hlH / 2);
      var _tHlF = settings.hlFill || { type: 'solid', color: settings.hlColor || '#ffe44d', color2: '#ff8800', angle: 0, opacity: 100 };
      c.save();
      c.globalAlpha = (settings.hlOpacity || 80) / 100;
      c.fillStyle = _mkFill(_tHlF, _hlX, _hlW, _hlY, _hlH);
      _rr(_hlX, _hlY, _hlW, _hlH, _hlR);
      c.fill();
      c.restore();
      _tplBoxStroke(_hlX, _hlY, _hlW, _hlH, _hlR, settings.hlStroke);
    }

    c.globalAlpha = 1; c.textBaseline = 'alphabetic'; c.direction = 'ltr';

    var preFill  = settings.preFill  || M4_DEFAULTS.preFill;
    var curFill  = settings.curFill  || M4_DEFAULTS.curFill;
    var postFill = settings.postFill || M4_DEFAULTS.postFill;
    var _strokeOn = settings.strokeEnable !== false;
    var _shadowOn = settings.shadowEnable !== false;
    var _noStroke = { color: '#000', opacity: 0, width: 0 };
    var _noShadow = { color: '#000', opacity: 0, blur: 0, x: 0, y: 0 };
    var sCur = _strokeOn ? (settings.strokeCur  || _noStroke) : _noStroke;
    var sPre = _strokeOn ? (settings.strokePre  || _noStroke) : _noStroke;
    var sPst = _strokeOn ? (settings.strokePost || _noStroke) : _noStroke;
    var shCur = _shadowOn ? (settings.shadowCur  || _noShadow) : _noShadow;
    var shPre = _shadowOn ? (settings.shadowPre  || _noShadow) : _noShadow;
    var shPst = _shadowOn ? (settings.shadowPost || _noShadow) : _noShadow;

    // Two-pass per line (when strokePos !== 'inside') so all strokes form
    // a background layer behind all fills - no word's stroke can cover a
    // neighbour's fill, even across pre/cur/post boundaries.
    var _twoPass = (strokePos !== 'inside');
    for (var li2 = 0; li2 < TPL_LINES.length; li2++) {
      var y = baseY + li2 * lineH;
      var lx0 = Infinity, lx1 = -Infinity;
      TPL_LINES[li2].forEach(function(i) { lx0 = Math.min(lx0, wX[i]); lx1 = Math.max(lx1, wX[i] + wW[i]); });
      function _renderTplWord(i, phase) {
        var s = _tplState(i);
        c.font = _fst(s) + ' ' + Math.round(_fz(s) * zoom) + 'px ' + _ff(s);
        c.letterSpacing = ls ? ls + 'px' : '0px';
        var fill2   = s === 'pre' ? preFill  : s === 'cur' ? curFill  : postFill;
        var stroke2 = s === 'pre' ? sPre : s === 'cur' ? sCur : sPst;
        var shadow2 = s === 'pre' ? shPre : s === 'cur' ? shCur : shPst;
        c.textAlign = 'left';
        var _lineTop = y - asc;
        var _curPerWord = (s === 'cur' && !_tplIsLine);
        var _fx = _curPerWord ? wX[i]            : lx0;
        var _fw = _curPerWord ? wW[i]            : (lx1 - lx0);
        var _fill2 = _mkFill(fill2, _fx, _fw, _lineTop, lineH);
        var _strokeFill2 = (stroke2 && stroke2.type === 'gradient') ? _mkFill(stroke2, _fx, _fw, _lineTop, lineH) : null;
        _drawW(stroke2, _fill2, dW[i], wX[i], y, _strokeFill2, shadow2, phase);
      }
      // Mirror the renderer's per-type layout: cur stays a separate layer
      // only when cur ITSELF will animate. WB animation alone doesn't
      // force cur off-ctx because the host stacks WB below ctx anyway.
      var _animateTpl = !!(settings && settings.animate);
      var _curAnimTpl = _animateTpl && ((settings && settings.animType)    !== 'none');
      var _separateCurTpl = _curAnimTpl;
      var _isCurWord = function (i) { return _tplState(i) === 'cur'; };
      var _isCtxWord = function (i) { return _tplState(i) !== 'cur'; };
      if (_twoPass) {
        if (_separateCurTpl) {
          // ctx layer: pre+post strokes -> pre+post fills, then cur on top
          TPL_LINES[li2].forEach(function (i) { if (_isCtxWord(i)) _renderTplWord(i, 'stroke'); });
          TPL_LINES[li2].forEach(function (i) { if (_isCtxWord(i)) _renderTplWord(i, 'fill'  ); });
          TPL_LINES[li2].forEach(function (i) { if (_isCurWord(i)) _renderTplWord(i, 'stroke'); });
          TPL_LINES[li2].forEach(function (i) { if (_isCurWord(i)) _renderTplWord(i, 'fill'  ); });
        } else {
          TPL_LINES[li2].forEach(function (i) { _renderTplWord(i, 'stroke'); });
          TPL_LINES[li2].forEach(function (i) { _renderTplWord(i, 'fill'  ); });
        }
      } else {
        if (_separateCurTpl) {
          TPL_LINES[li2].forEach(function (i) { if (_isCtxWord(i)) _renderTplWord(i, 'both'); });
          TPL_LINES[li2].forEach(function (i) { if (_isCurWord(i)) _renderTplWord(i, 'both'); });
        } else {
          TPL_LINES[li2].forEach(function (i) { _renderTplWord(i, 'both'); });
        }
      }
    }
  }

  // Builds a single unified Canvas path for N per-line CBG boxes (merge mode).
  // Adjacent box heights are extended to absorb the line gap.
  // ALL corners are rounded - outer corners convex, step-junction corners concave.
  function _buildMergedBgPath(oc, boxes, r) {
    var n = boxes.length;
    if (n === 0) return;
    var bs = boxes.map(function(b, i) {
      return { x: b.x, y: b.y, w: b.w, h: i < n - 1 ? boxes[i + 1].y - b.y : b.h };
    });
    var first = bs[0], last = bs[n - 1];
    var rad = Math.max(0, Math.min(r, first.w / 2, first.h / 2, last.w / 2, last.h / 2));
    oc.beginPath();
    // Top edge + top-right outer corner
    oc.moveTo(first.x + rad, first.y);
    oc.lineTo(first.x + first.w - rad, first.y);
    oc.quadraticCurveTo(first.x + first.w, first.y, first.x + first.w, first.y + rad);
    // Right side going DOWN
    for (var _i = 0; _i < n; _i++) {
      var _b = bs[_i], _jY = _b.y + _b.h, _cr = _b.x + _b.w;
      if (_i === n - 1) {
        oc.lineTo(_cr, _jY - rad);
        oc.quadraticCurveTo(_cr, _jY, _cr - rad, _jY);
      } else {
        var _nr = bs[_i + 1].x + bs[_i + 1].w;
        if (_nr < _cr) {
          var _sr = Math.min(rad, (_cr - _nr) / 2);
          oc.lineTo(_cr, _jY - _sr);
          oc.quadraticCurveTo(_cr, _jY, _cr - _sr, _jY);   // outer convex
          oc.lineTo(_nr + _sr, _jY);
          oc.quadraticCurveTo(_nr, _jY, _nr, _jY + _sr);   // inner concave
        } else if (_nr > _cr) {
          var _sr = Math.min(rad, (_nr - _cr) / 2);
          oc.lineTo(_cr, _jY - _sr);
          oc.quadraticCurveTo(_cr, _jY, _cr + _sr, _jY);   // inner concave
          oc.lineTo(_nr - _sr, _jY);
          oc.quadraticCurveTo(_nr, _jY, _nr, _jY + _sr);   // outer convex
        } else {
          oc.lineTo(_cr, _jY);
        }
      }
    }
    // Bottom edge + bottom-left outer corner
    oc.lineTo(last.x + rad, last.y + last.h);
    oc.quadraticCurveTo(last.x, last.y + last.h, last.x, last.y + last.h - rad);
    // Left side going UP
    for (var _i = n - 1; _i >= 0; _i--) {
      var _b = bs[_i], _cl = _b.x, _jY = _b.y;
      if (_i === 0) {
        oc.lineTo(_cl, _jY + rad);
        oc.quadraticCurveTo(_cl, _jY, _cl + rad, _jY);
      } else {
        var _pl = bs[_i - 1].x;
        if (_pl < _cl) {
          var _sv = Math.min(rad, (_cl - _pl) / 2);
          oc.lineTo(_cl, _jY + _sv);
          oc.quadraticCurveTo(_cl, _jY, _cl - _sv, _jY);   // outer convex
          oc.lineTo(_pl + _sv, _jY);
          oc.quadraticCurveTo(_pl, _jY, _pl, _jY - _sv);   // inner concave
        } else if (_pl > _cl) {
          var _sv = Math.min(rad, (_pl - _cl) / 2);
          oc.lineTo(_cl, _jY + _sv);
          oc.quadraticCurveTo(_cl, _jY, _cl + _sv, _jY);   // inner concave
          oc.lineTo(_pl - _sv, _jY);
          oc.quadraticCurveTo(_pl, _jY, _pl, _jY - _sv);   // outer convex
        } else {
          oc.lineTo(_cl, _jY);
        }
      }
    }
    oc.closePath();
  }

  // One-shot template cards (activeMode 'off') draw exactly once - if
  // their @font-face font hadn't finished loading at that moment they
  // keep the fallback face forever (animated cards self-heal via their
  // 700ms redraw interval). Re-render the strip once when ALL fonts
  // land. Canvas ctx.font usage triggers the lazy @font-face load, so
  // fonts.ready resolves after the first render kicked those loads off.
  var _m4FontsRefreshHooked = false;
  function _m4HookFontRefresh() {
    if (_m4FontsRefreshHooked) return;
    _m4FontsRefreshHooked = true;
    try {
      if (document.fonts && document.fonts.ready) {
        document.fonts.ready.then(function () {
          setTimeout(function () { _m4RenderTplStrip(); }, 50);
        });
        document.fonts.addEventListener('loadingdone', function () {
          _m4RenderTplStrip();
        });
      }
    } catch (_) {}
  }

  function _m4VisibleTemplates() {
    var all = _m4LoadTemplates();
    var visible = all.filter(function (t) {
      return t && !t.hidden && _m4TplLangAllowed(t);
    });
    if (visible.length) return visible;

    // A stale CEP localStorage record can hide every bundled card. Refresh
    // from the shipped template file first, then restore bundled defaults if
    // there is still no visible card. This never removes user templates.
    _m4SeedDefaultTemplates();
    all = _m4LoadTemplates();
    visible = all.filter(function (t) {
      return t && !t.hidden && _m4TplLangAllowed(t);
    });
    if (visible.length) return visible;

    var restored = false;
    all.forEach(function (t) {
      if (t && _m4IsBundled(t.id) && t.hidden) {
        t.hidden = false;
        restored = true;
      }
    });
    if (restored) {
      _m4PersistTemplates(all);
      visible = all.filter(function (t) {
        return t && !t.hidden && _m4TplLangAllowed(t);
      });
    }
    return visible;
  }

  function _m4RenderTplStrip() {
    if (!_m4TplStrip) return;
    _m4HookFontRefresh();
    _m4TplIntervals.forEach(function(id) { clearInterval(id); });
    _m4TplIntervals = [];
    _m4TplStrip.innerHTML = '';
    var visibleTemplates = _m4VisibleTemplates();
    if (!visibleTemplates.length) {
      _m4TplStrip.innerHTML = '<div class="m4-tpl-empty">Template library could not load. Reopen the panel.</div>';
      return;
    }
    visibleTemplates.forEach(function(t) {
      var card = document.createElement('div');
      card.className = 'm4-tpl-card' + (t.id === _m4ActiveTplId ? ' active' : '');
      card.dataset.tplId = t.id;

      var cv = document.createElement('canvas');
      cv.width = 160; cv.height = 79;

      var del = document.createElement('button');
      del.className = 'm4-tpl-del';
      del.title = 'Delete';
      del.innerHTML =
        '<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
          '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>' +
        '</svg>';
      del.addEventListener('click', function(e) {
        e.stopPropagation();
        _confirmAction('Delete this template?', function () {
          var arr = _m4LoadTemplates();
          if (_m4IsBundled(t.id)) {
            // Bundled default -> soft-hide (preserves the entry so future seeds
            // can keep refreshing settings, and "Restore" can bring it back)
            for (var i = 0; i < arr.length; i++) {
              if (arr[i].id === t.id) { arr[i].hidden = true; break; }
            }
          } else {
            // User-saved -> hard-remove
            arr = arr.filter(function(x) { return x.id !== t.id; });
          }
          _m4PersistTemplates(arr);
          _m4RenderTplStrip();
        });
      });

      function _selectTpl() {
        _m4ActiveTplId = t.id;
        try { localStorage.setItem('ae_m4_active_tpl', t.id); } catch (_) {}
        _m4SavingFromTpl = true;
        _m4ApplySettings(t.settings);
        _m4FontPickerSetValue(t.settings.fontFamily || M4_DEFAULTS.fontFamily);
        _m4SyncPickrColors();
        _m4StartPreview();
        _m4SaveSettings();
        _m4SavingFromTpl = false;
        _m4TplStrip.querySelectorAll('.m4-tpl-card').forEach(function(c) {
          c.classList.toggle('active', c.dataset.tplId === t.id);
        });
      }
      card.addEventListener('click', _selectTpl);

      // Edit affordance - hover reveals a pencil button in the top-left
      // corner (24px, inside the card). Click selects the template
      // (same as clicking the card) AND switches to the Custom tab so
      // the user can tweak the template's settings further. Stop
      // propagation so the click doesn't also fire the card's
      // plain-select handler.
      var edit = document.createElement('button');
      edit.className = 'm4-tpl-edit';
      edit.title = 'Edit in Custom';
      edit.innerHTML =
        '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
          '<path d="M12 20h9"/>' +
          '<path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z"/>' +
          '<path d="m15 5 3 3"/>' +
        '</svg>';
      edit.addEventListener('click', function (e) {
        e.stopPropagation();
        _selectTpl();
        var customTab = document.querySelector('.m4-style-tab[data-style-tab="custom"]');
        if (customTab) customTab.click();
      });

      // Dev-only: raw-JSON editor button. Sits to the right of the
      // pencil. Only attached when running from a dev checkout so testers
      // never see it. Lets the maintainer tweak a saved template's
      // settings directly without rebuilding default-templates.json.
      var devEdit = null;
      try {
        if (window.Updater && window.Updater.isDevInstall && window.Updater.isDevInstall()) {
          devEdit = document.createElement('button');
          devEdit.className = 'm4-tpl-dev-edit';
          devEdit.title = 'Edit JSON (dev only)';
          devEdit.innerHTML =
            '<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
              '<polyline points="16 18 22 12 16 6"/>' +
              '<polyline points="8 6 2 12 8 18"/>' +
            '</svg>';
          devEdit.addEventListener('click', function (e) {
            e.stopPropagation();
            if (typeof window._m4OpenTplDevEditor === 'function') {
              window._m4OpenTplDevEditor(t.id);
            }
          });
        }
      } catch (_) {}

      // Checkmark badge - informational, indicates the currently-applied
      // template. Sits in the same top-left slot as the edit pencil;
      // hover swaps it out for the pencil so the user always has a
      // re-edit entry point.
      var check = document.createElement('span');
      check.className = 'm4-tpl-check';
      check.setAttribute('aria-label', 'Selected');
      check.innerHTML =
        '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">' +
          '<path d="M20 6 9 17l-5-5"/>' +
        '</svg>';

      // Drag-to-reorder
      card.draggable = true;
      card.addEventListener('dragstart', function(e) {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', t.id);
        card.classList.add('dragging');
      });
      card.addEventListener('dragend', function() {
        card.classList.remove('dragging');
        _m4TplStrip.querySelectorAll('.m4-tpl-card').forEach(function(c) { c.classList.remove('drag-over'); });
      });
      card.addEventListener('dragover', function(e) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        _m4TplStrip.querySelectorAll('.m4-tpl-card').forEach(function(c) { c.classList.remove('drag-over'); });
        card.classList.add('drag-over');
      });
      card.addEventListener('drop', function(e) {
        e.preventDefault();
        var dragId = e.dataTransfer.getData('text/plain');
        if (dragId === t.id) return;
        var arr = _m4LoadTemplates();
        var fromIdx = arr.findIndex(function(x) { return x.id === dragId; });
        var toIdx   = arr.findIndex(function(x) { return x.id === t.id;   });
        if (fromIdx === -1 || toIdx === -1) return;
        var moved = arr.splice(fromIdx, 1)[0];
        arr.splice(toIdx, 0, moved);
        // Drag is the one operation that *legitimately* rewrites order.
        // Persist won't renumber on its own, so we set the new sequence
        // here based on the post-splice array position.
        for (var i = 0; i < arr.length; i++) {
          if (arr[i]) arr[i].order = i;
        }
        _m4PersistTemplates(arr);
        _m4RenderTplStrip();
      });

      card.appendChild(cv);
      card.appendChild(check);
      card.appendChild(edit);
      if (devEdit) card.appendChild(devEdit);
      card.appendChild(del);
      _m4TplStrip.appendChild(card);

      // Animate: cycle cur word through phrase at preview speed (static in off mode).
      // Phrase length is per-template - Arabic is 3 words, English is 4.
      var curIdx = 0;
      var _phrLen = _m4PhraseFor(
        t.settings && t.settings.language,
        t.settings && t.settings.activeMode
      ).phrase.length;
      _m4DrawTplFrame(cv, t.settings, curIdx);
      if (t.settings && t.settings.activeMode !== 'off') {
        var iv = setInterval(function() {
          curIdx = (curIdx + 1) % _phrLen;
          _m4DrawTplFrame(cv, t.settings, curIdx);
        }, 700);
        _m4TplIntervals.push(iv);
      }
    });
  }

  // ── Dev-only in-UI template editor ───────────────────────────────────────
  // Click yellow `< >` on a template card -> loads template into the
  // Custom UI (same as the regular pencil) + reveals a floating bar at
  // the bottom. While the bar is up, any edit the user makes in the UI
  // can be committed back to the template's JSON via Save changes.
  // Cancel just hides the bar - current working settings are kept as-is.
  var _m4DevEditingTplId = null;
  (function _m4InitTplDevBar() {
    var bar      = document.getElementById('m4-tpl-dev-bar');
    var idEl     = document.getElementById('m4-tpl-dev-bar-id');
    var saveBtn  = document.getElementById('m4-tpl-dev-bar-save');
    var cancelBtn= document.getElementById('m4-tpl-dev-bar-cancel');
    if (!bar || !saveBtn || !cancelBtn) return;

    function _hideBar() {
      bar.classList.add('hidden');
      _m4DevEditingTplId = null;
    }

    // Mirror a dev-edited template's settings into the bundled
    // client/default-templates.json. Without this, Save changes only
    // touches localStorage - and _m4SeedDefaultTemplates refreshes every
    // bundled ID's settings FROM DISK at each launch, silently reverting
    // the edit on restart. Only rewrites the one matching entry; templates
    // not present in the file (user-saved) don't need it, since seeding
    // never clobbers those.
    function _m4WriteTplToDefaultsFile(tplId, settings) {
      try {
        if (!(window.Updater && Updater.isDevInstall && Updater.isDevInstall())) return false;
        var fs   = require('fs');
        var path = require('path');
        var ext  = CEP.getExtensionPath();
        var p    = path.join(ext, 'default-templates.json');
        if (!fs.existsSync(p)) p = path.join(ext, 'client', 'default-templates.json');
        if (!fs.existsSync(p)) return false;
        var data = JSON.parse(fs.readFileSync(p, 'utf8'));
        var list = Array.isArray(data) ? data : (data.templates || []);
        for (var i = 0; i < list.length; i++) {
          if (list[i] && list[i].id === tplId) {
            list[i].settings = settings;
            fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf8');
            return true;
          }
        }
      } catch (_) {}
      return false;
    }

    // Sync the global Tpl Lang button to a specific language. Used when
    // dev-editing a template so the Advanced "Tpl Lang" toggle reflects
    // what the template is tagged as - and lets the dev change it.
    function _setTplLangSelector(lang) {
      try { localStorage.setItem(M4_TPL_LANG_KEY, lang || 'en'); } catch (_) {}
      var row = document.getElementById('m4-tpl-lang-row');
      if (!row) return;
      row.querySelectorAll('.m4-tpl-lang-btn').forEach(function (b) {
        b.classList.toggle('active', b.getAttribute('data-tpl-lang') === (lang || 'en'));
      });
    }

    window._m4OpenTplDevEditor = function (tplId) {
      var arr = _m4LoadTemplates();
      var tpl = arr.filter(function (x) { return x.id === tplId; })[0];
      if (!tpl) return;
      _m4DevEditingTplId = tplId;
      if (idEl) idEl.textContent = tplId;
      bar.classList.remove('hidden');
      // Same path as the pencil edit: select the template (which loads
      // its settings into the UI) and switch to the Custom tab so the
      // user actually sees the controls.
      _m4ActiveTplId = tplId;
      try { localStorage.setItem('ae_m4_active_tpl', tplId); } catch (_) {}
      _m4SavingFromTpl = true;
      try {
        _m4ApplySettings(tpl.settings || {});
        _m4FontPickerSetValue((tpl.settings && tpl.settings.fontFamily) || M4_DEFAULTS.fontFamily);
        _m4SyncPickrColors();
        _m4StartPreview();
        _m4SaveSettings();
      } finally { _m4SavingFromTpl = false; }
      // Sync the Tpl Lang toggle to whatever the template is tagged with
      // so the preview's language doesn't fall back to English on save.
      // The dev can still flip it if they're intentionally re-tagging.
      _setTplLangSelector((tpl.settings && tpl.settings.language) || 'en');
      if (_m4TplStrip) _m4TplStrip.querySelectorAll('.m4-tpl-card').forEach(function (c) {
        c.classList.toggle('active', c.dataset.tplId === tplId);
      });
      var customTab = document.querySelector('.m4-style-tab[data-style-tab="custom"]');
      if (customTab) customTab.click();
    };

    saveBtn.addEventListener('click', function () {
      if (!_m4DevEditingTplId) return;
      var arr = _m4LoadTemplates();
      var found = false;
      for (var i = 0; i < arr.length; i++) {
        if (arr[i].id === _m4DevEditingTplId) {
          var newSettings = _m4GetSettings();
          // _m4GetSettings doesn't carry the `language` field (it's
          // template metadata, not UI state). Re-stamp it from the Tpl
          // Lang button so dev-edits don't wipe Arabic templates back
          // to English. Mirror the Save Template behaviour - only set
          // the field when non-default to keep JSON tidy.
          var lang = _m4GetSelectedLang();
          if (lang && lang !== 'en') newSettings.language = lang;
          arr[i].settings = newSettings;
          found = true;
          break;
        }
      }
      if (!found) { _hideBar(); return; }
      _m4PersistTemplates(arr);
      // Bundled templates re-seed from disk every launch - without this
      // write-through the saved edit reverts on the next panel open.
      _m4WriteTplToDefaultsFile(_m4DevEditingTplId, newSettings);
      _m4RenderTplStrip();
      _hideBar();
    });

    cancelBtn.addEventListener('click', _hideBar);
  })();

  if (_m4SaveTplBtn) {
    _m4SaveTplBtn.addEventListener('click', function() {
      var settings = _m4GetSettings();
      // Bake the dev-selected language onto the template so its card always
      // renders in that script. Untagged templates default to English.
      // Only set the field when it's actually non-default - keeps saved
      // JSON clean for production templates.
      var lang = _m4GetSelectedLang();
      if (lang && lang !== 'en') settings.language = lang;
      var tpl = { id: 't' + Date.now(), settings: settings };
      var arr = _m4LoadTemplates();
      arr.push(tpl);
      _m4PersistTemplates(arr);
      _m4RenderTplStrip();
    });
  }

  // Settings -> "Restore hidden templates" button. Un-hides every bundled
  // default the user has soft-deleted. User-saved templates aren't affected.
  function _m4HiddenCount() {
    var n = 0;
    _m4LoadTemplates().forEach(function(t) { if (t.hidden && _m4IsBundled(t.id)) n++; });
    return n;
  }
  function _m4UpdateRestoreBtn() {
    var btn   = document.getElementById('restore-hidden-tpl-btn');
    var count = document.getElementById('restore-hidden-tpl-count');
    var card  = document.getElementById('settings-templates-card');
    if (!btn) return;
    var n = _m4HiddenCount();
    btn.disabled = (n === 0);
    if (count) count.textContent = n > 0 ? (n + ' hidden') : 'None hidden';
    // Auto-hide the whole settings card when there's nothing to restore.
    if (card) card.style.display = (n > 0) ? '' : 'none';
  }
  var _m4RestoreBtn = document.getElementById('restore-hidden-tpl-btn');
  if (_m4RestoreBtn) {
    _m4RestoreBtn.addEventListener('click', function() {
      var arr = _m4LoadTemplates();
      var changed = false;
      for (var i = 0; i < arr.length; i++) {
        if (arr[i].hidden && _m4IsBundled(arr[i].id)) {
          arr[i].hidden = false;
          changed = true;
        }
      }
      if (changed) {
        _m4PersistTemplates(arr);
        _m4RenderTplStrip();
        _m4UpdateRestoreBtn();
      }
    });
  }
  // Wrap the existing renderer so the settings button label stays accurate
  // whenever the template list mutates.
  var _m4RenderTplStripOrig = _m4RenderTplStrip;
  _m4RenderTplStrip = function() {
    _m4RenderTplStripOrig();
    _m4UpdateRestoreBtn();
  };
  _m4UpdateRestoreBtn();

  _m4RenderTplStrip();

  // ── Load system fonts from disk (no permission needed) ─────────────────────
  (function _m4LoadFonts() {
    if (typeof require !== 'function') return; // Bundled CSS fonts still work without Node.
    var _fs   = require('fs');
    var _path = require('path');
    var _fallback = ['Arial','Arial Black','Calibri','Cambria','Comic Sans MS',
      'Courier New','Georgia','Impact','Segoe UI','Tahoma',
      'Times New Roman','Trebuchet MS','Verdana'];

    // Returns { family, weight, italic, vfMin, vfMax } or null on parse failure.
    //   weight   - numeric usWeightClass (100..900) from OS/2 table
    //   italic   - bit 0 of fsSelection (or italicAngle from post if missing)
    //   vfMin/Max - weight-axis range from fvar (only set for variable fonts)
    function _fontMeta(filePath) {
      try {
        var fd = _fs.openSync(filePath, 'r');

        // Read first 4 KB - enough for sfnt header + up to 64 table records
        var hdr = Buffer.alloc(4096);
        _fs.readSync(fd, hdr, 0, 4096, 0);

        // TTC: jump to first font offset
        var start = 0;
        if (hdr.slice(0, 4).toString('ascii') === 'ttcf') start = hdr.readUInt32BE(12);

        // Index every table we care about
        var numTables = hdr.readUInt16BE(start + 4);
        var tables = {};
        for (var i = 0; i < numTables && i < 64; i++) {
          var td = start + 12 + i * 16;
          if (td + 16 > hdr.length) break;
          var tag = hdr.slice(td, td + 4).toString('ascii');
          if (tag === 'name' || tag === 'OS/2' || tag === 'fvar' || tag === 'post') {
            tables[tag] = { off: hdr.readUInt32BE(td + 8), len: hdr.readUInt32BE(td + 12) };
          }
        }
        if (!tables.name) { _fs.closeSync(fd); return null; }

        function _readTable(t) {
          if (!t) return null;
          var b = Buffer.alloc(t.len);
          var n = _fs.readSync(fd, b, 0, t.len, t.off);
          return n === t.len ? b : null;
        }

        // ── name table -> family
        var nameBuf = _readTable(tables.name);
        var family = null, preferred = null;
        if (nameBuf && nameBuf.length >= 6) {
          var count   = nameBuf.readUInt16BE(2);
          var strBase = nameBuf.readUInt16BE(4);
          for (var j = 0; j < count && j < 300; j++) {
            var r = 6 + j * 12;
            if (r + 12 > nameBuf.length) break;
            var pid = nameBuf.readUInt16BE(r);
            var eid = nameBuf.readUInt16BE(r + 2);
            var nid = nameBuf.readUInt16BE(r + 6);
            var len = nameBuf.readUInt16BE(r + 8);
            var off = nameBuf.readUInt16BE(r + 10);
            if (nid !== 1 && nid !== 16) continue;
            var so = strBase + off;
            if (so + len > nameBuf.length) continue;
            var str = '';
            if (pid === 3 && eid === 1) {
              for (var k = 0; k < len; k += 2) str += String.fromCharCode(nameBuf.readUInt16BE(so + k));
            } else if (pid === 1) {
              str = nameBuf.slice(so, so + len).toString('latin1');
            } else continue;
            if (nid === 16 && !preferred) preferred = str;
            if (nid === 1  && !family)    family    = str;
          }
        }
        family = preferred || family;
        if (!family) { _fs.closeSync(fd); return null; }

        // ── OS/2 -> weight (usWeightClass) + italic (fsSelection bit 0)
        var weight = 400, italic = false;
        var os2 = _readTable(tables['OS/2']);
        if (os2 && os2.length >= 64) {
          weight = os2.readUInt16BE(4) || 400;
          var fsSel = os2.readUInt16BE(62);
          italic = (fsSel & 0x01) !== 0;
        }

        // ── post -> italicAngle (fallback italic detection)
        if (!italic) {
          var postBuf = _readTable(tables.post);
          if (postBuf && postBuf.length >= 8) {
            // italicAngle is a Fixed16.16 starting at byte 4
            var italicAngle = postBuf.readInt32BE(4) / 65536;
            if (italicAngle !== 0) italic = true;
          }
        }

        // ── fvar -> variable-font weight-axis range
        var vfMin = null, vfMax = null;
        var fvarBuf = _readTable(tables.fvar);
        if (fvarBuf && fvarBuf.length >= 16) {
          var axesArrayOff = fvarBuf.readUInt16BE(4);
          var axisCount    = fvarBuf.readUInt16BE(8);
          var axisSize     = fvarBuf.readUInt16BE(10);
          for (var a = 0; a < axisCount && a < 32; a++) {
            var ax = axesArrayOff + a * axisSize;
            if (ax + 20 > fvarBuf.length) break;
            var axTag = fvarBuf.slice(ax, ax + 4).toString('ascii');
            if (axTag === 'wght') {
              // Each axis: tag(4) + minValue(Fixed) + defaultValue(Fixed) + maxValue(Fixed) ...
              vfMin = fvarBuf.readInt32BE(ax + 4)  / 65536;
              vfMax = fvarBuf.readInt32BE(ax + 12) / 65536;
              break;
            }
          }
        }

        _fs.closeSync(fd);
        return {
          family: family,
          weight: weight,
          italic: italic,
          vfMin:  vfMin,
          vfMax:  vfMax
        };
      } catch(_) { return null; }
    }

    function _populate(families) {
      _m4AllFonts = families;
      // Restore saved font if in list, else keep current or default
      var target = _m4FontFamily;
      _m4FontPickerSetValue(families.indexOf(target) >= 0 ? target : (families[0] || 'Arial'));
      _m4DrawPreview();
    }

    // Aggregate per-family weight + italic info from every scanned font file.
    // Exposed module-wide via _m4FontMeta - drives Style-dropdown filtering.
    function _registerFontMeta(meta) {
      if (!meta || !meta.family) return;
      var bucket = _m4FontMeta[meta.family];
      if (!bucket) {
        bucket = _m4FontMeta[meta.family] = {
          weights: {},   // map of int -> true
          italic:  false,
          vfMin:   null,
          vfMax:   null
        };
      }
      bucket.weights[meta.weight] = true;
      if (meta.italic) bucket.italic = true;
      if (meta.vfMin != null && (bucket.vfMin == null || meta.vfMin < bucket.vfMin)) bucket.vfMin = meta.vfMin;
      if (meta.vfMax != null && (bucket.vfMax == null || meta.vfMax > bucket.vfMax)) bucket.vfMax = meta.vfMax;
    }

    setTimeout(function() {
      var _os = require('os');
      var dirs = [];
      if (process.platform === 'win32') {
        dirs = ['C:\\Windows\\Fonts'];
        if (process.env.LOCALAPPDATA) dirs.push(process.env.LOCALAPPDATA + '\\Microsoft\\Windows\\Fonts');
      } else if (process.platform === 'darwin') {
        dirs = [
          '/System/Library/Fonts',
          '/Library/Fonts',
          _os.homedir() + '/Library/Fonts'
        ];
      } else {
        // Linux
        dirs = ['/usr/share/fonts', '/usr/local/share/fonts', _os.homedir() + '/.fonts'];
      }
      // Bundled fonts shipped with the plugin (loaded via @font-face in
      // index.html). Adding the directory here makes them appear in the
      // font picker dropdown alongside system fonts.
      try {
        var _ext = CEP.getExtensionPath();
        var _bundledFontsDir = _path.join(_ext, 'fonts');
        if (!_fs.existsSync(_bundledFontsDir)) _bundledFontsDir = _path.join(_ext, 'client', 'fonts');
        if (_fs.existsSync(_bundledFontsDir)) dirs.unshift(_bundledFontsDir);
      } catch(_) {}
      var seen = {}, list = [];
      function _scanDir(dir) {
        try {
          _fs.readdirSync(dir).forEach(function(f) {
            var full = _path.join(dir, f);
            try {
              if (_fs.statSync(full).isDirectory()) { _scanDir(full); return; }
            } catch(_) {}
            var ext = f.slice(-4).toLowerCase();
            if (ext !== '.ttf' && ext !== '.otf' && ext !== '.ttc') return;
            var meta = _fontMeta(full);
            if (!meta || !meta.family) return;
            _registerFontMeta(meta);
            if (!seen[meta.family]) { seen[meta.family] = true; list.push(meta.family); }
          });
        } catch(_) {}
      }
      dirs.forEach(_scanDir);
      list.sort(function(a, b) { return a.toLowerCase().localeCompare(b.toLowerCase()); });
      _populate(list.length ? list : _fallback);
    }, 50);
  }());

  // ── Font picker UI ─────────────────────────────────────────────────────────
  var _m4FontSearchEl   = document.getElementById('m4-font-search');
  var _m4FontDropdownEl = document.getElementById('m4-font-dropdown');

  // skipSave=true when called from _m4TypoSyncControls (just update UI, don't persist state)
  function _m4FontPickerSetValue(family, skipSave) {
    _m4FontFamily = family;
    if (_m4FontSearchEl) _m4FontSearchEl.value = family;
    if (_m4FontDropdownEl) {
      var items = _m4FontDropdownEl.querySelectorAll('.m4-font-option');
      items.forEach(function(el) { el.classList.toggle('active', el.dataset.font === family); });
    }
    // Reshape the Style dropdown for the new family. The function snaps
    // the current selection to the nearest available weight if needed -
    // its return value is the resulting fontStyle string (eg "bold").
    var snapped = _m4RefreshFontStyleDropdown(family);
    if (!skipSave) {
      // Commit value into the right bucket
      if (_m4TypoState === 'all') {
        _m4TypoAll.fontFamily = family;
        if (snapped) _m4TypoAll.fontStyle = snapped;
      } else {
        _m4TypoOverrides[_m4TypoState].fontFamily = (family !== _m4TypoAll.fontFamily) ? family : null;
        if (snapped) _m4TypoOverrides[_m4TypoState].fontStyle = (snapped !== _m4TypoAll.fontStyle) ? snapped : null;
        _m4TypoUpdateTabs();
      }
    }
  }

  function _m4FontRenderDropdown(query) {
    if (!_m4FontDropdownEl) return;
    var q = (query || '').toLowerCase().trim();
    var filtered = q
      ? _m4AllFonts.filter(function(f) { return f.toLowerCase().indexOf(q) !== -1; })
      : _m4AllFonts;
    // Cap render to 120 items for speed; filtering narrows it
    var slice = filtered.slice(0, 120);
    _m4FontDropdownEl.innerHTML = slice.map(function(f) {
      var isSel = f === _m4FontFamily;
      return '<div class="m4-font-option' + (isSel ? ' active' : '') + '" data-font="' + f.replace(/"/g, '&quot;') + '">' + f + '</div>';
    }).join('');
    _m4FontDropdownEl.querySelectorAll('.m4-font-option').forEach(function(el) {
      el.addEventListener('mousedown', function(e) {
        e.preventDefault(); // don't lose focus before we read value
        _m4FontPickerSetValue(el.dataset.font);
        _m4FontDropdownEl.classList.remove('open');
        _m4SaveSettings();
        _m4DrawPreview();
      });
    });
    // Scroll active item into view
    var active = _m4FontDropdownEl.querySelector('.m4-font-option.active');
    if (active) active.scrollIntoView({ block: 'nearest' });
  }

  if (_m4FontSearchEl) {
    _m4FontSearchEl.value = _m4FontFamily;

    _m4FontSearchEl.addEventListener('focus', function() {
      _m4FontRenderDropdown('');
      _m4FontDropdownEl.classList.add('open');
    });
    _m4FontSearchEl.addEventListener('input', function() {
      _m4FontRenderDropdown(_m4FontSearchEl.value);
      _m4FontDropdownEl.classList.add('open');
    });
    _m4FontSearchEl.addEventListener('blur', function() {
      // Small delay so mousedown on option fires first
      setTimeout(function() {
        _m4FontDropdownEl.classList.remove('open');
        // If user typed something but didn't pick, restore the current value
        _m4FontSearchEl.value = _m4FontFamily;
      }, 150);
    });
    _m4FontSearchEl.addEventListener('keydown', function(e) {
      if (e.key === 'Escape') { _m4FontDropdownEl.classList.remove('open'); _m4FontSearchEl.blur(); }
      if (e.key === 'Enter') {
        var active = _m4FontDropdownEl.querySelector('.m4-font-option');
        if (active) { _m4FontPickerSetValue(active.dataset.font); _m4FontDropdownEl.classList.remove('open'); _m4SaveSettings(); _m4DrawPreview(); }
      }
    });
  }

  // ── Live labels + save on change ───────────────────────────────────────────
  // Position lives on the action bar now, not on the template. The hidden
  // m4-pos-y / m4-pos-x inputs are kept as the existing "source of truth"
  // for renderer + preview code; the bar inputs drive them.
  (function _m4InitActionBarPos() {
    var barX = document.getElementById('ac-bar-pos-x');
    var barY = document.getElementById('ac-bar-pos-y');
    if (!barX || !barY) return;
    var POS_X_KEY = 'machicut_caption_pos_x';
    var POS_Y_KEY = 'machicut_caption_pos_y';
    function _clamp(v) {
      v = parseInt(v, 10);
      if (isNaN(v)) return 50;
      return Math.max(0, Math.min(100, v));
    }
    function _push(x, y) {
      if (m4PosXEl) m4PosXEl.value = x;
      if (m4PosYEl) m4PosYEl.value = y;
    }
    // Init from localStorage (else fall back to the HTML defaults 50/70).
    try {
      var sx = localStorage.getItem(POS_X_KEY);
      var sy = localStorage.getItem(POS_Y_KEY);
      if (sx !== null) barX.value = _clamp(sx);
      if (sy !== null) barY.value = _clamp(sy);
    } catch (_) {}
    _push(_clamp(barX.value), _clamp(barY.value));
    function _sync() {
      var x = _clamp(barX.value);
      var y = _clamp(barY.value);
      barX.value = x; barY.value = y;
      _push(x, y);
      try { localStorage.setItem(POS_X_KEY, String(x)); } catch (_) {}
      try { localStorage.setItem(POS_Y_KEY, String(y)); } catch (_) {}
      if (typeof _m4DrawPreview === 'function') _m4DrawPreview();
    }
    barX.addEventListener('input',  _sync);
    barY.addEventListener('input',  _sync);
    barX.addEventListener('change', _sync);
    barY.addEventListener('change', _sync);
  })();
  if (m4FontSizeEl && m4FontSizeValEl) {
    m4FontSizeEl.addEventListener('input', function () { m4FontSizeValEl.textContent = m4FontSizeEl.value + 'px'; });
  }
  // stroke width input is handled by _m4StrkWidthEl listener (state model)
  if (m4LineGapEl && m4LineGapValEl) {
    m4LineGapEl.addEventListener('input', function () { m4LineGapValEl.textContent = m4LineGapEl.value + 'px'; });
  }
  if (m4LetterSpacingEl && m4LetterSpacingVal) {
    m4LetterSpacingEl.addEventListener('input', function () { m4LetterSpacingVal.textContent = m4LetterSpacingEl.value + 'px'; });
  }
  if (m4HlOpacityEl && m4HlOpacityValEl) {
    m4HlOpacityEl.addEventListener('input', function () { m4HlOpacityValEl.textContent = m4HlOpacityEl.value + '%'; });
  }
  if (m4HlRadiusEl && m4HlRadiusValEl) {
    m4HlRadiusEl.addEventListener('input', function () { m4HlRadiusValEl.textContent = m4HlRadiusEl.value + 'px'; });
  }
  if (m4HlPadTopEl && m4HlPadTopValEl) { m4HlPadTopEl.addEventListener('input', function () { m4HlPadTopValEl.textContent = m4HlPadTopEl.value + 'px'; }); }
  if (m4HlPadBotEl && m4HlPadBotValEl) { m4HlPadBotEl.addEventListener('input', function () { m4HlPadBotValEl.textContent = m4HlPadBotEl.value + 'px'; }); }
  if (m4HlPadLftEl && m4HlPadLftValEl) { m4HlPadLftEl.addEventListener('input', function () { m4HlPadLftValEl.textContent = m4HlPadLftEl.value + 'px'; }); }
  if (m4HlPadRgtEl && m4HlPadRgtValEl) { m4HlPadRgtEl.addEventListener('input', function () { m4HlPadRgtValEl.textContent = m4HlPadRgtEl.value + 'px'; }); }
  if (m4CbgOpacityEl && m4CbgOpacityValEl) {
    m4CbgOpacityEl.addEventListener('input', function () { m4CbgOpacityValEl.textContent = m4CbgOpacityEl.value + '%'; });
  }
  if (m4CbgRadiusEl && m4CbgRadiusValEl) {
    m4CbgRadiusEl.addEventListener('input', function () { m4CbgRadiusValEl.textContent = m4CbgRadiusEl.value + 'px'; });
  }
  if (m4CbgPadTopEl && m4CbgPadTopValEl) { m4CbgPadTopEl.addEventListener('input', function () { m4CbgPadTopValEl.textContent = m4CbgPadTopEl.value + 'px'; }); }
  if (m4CbgPadBotEl && m4CbgPadBotValEl) { m4CbgPadBotEl.addEventListener('input', function () { m4CbgPadBotValEl.textContent = m4CbgPadBotEl.value + 'px'; }); }
  if (m4CbgPadLftEl && m4CbgPadLftValEl) { m4CbgPadLftEl.addEventListener('input', function () { m4CbgPadLftValEl.textContent = m4CbgPadLftEl.value + 'px'; }); }
  if (m4CbgPadRgtEl && m4CbgPadRgtValEl) { m4CbgPadRgtEl.addEventListener('input', function () { m4CbgPadRgtValEl.textContent = m4CbgPadRgtEl.value + 'px'; }); }

  // ── Preview canvas ─────────────────────────────────────────────────────────
  var _m4PreviewTimer   = null;
  var _m4PreviewWordIdx = 0;
  var _m4PreviewAnimProgress = 1;
  var _m4PreviewCycleStart   = 0;
  var _m4PreviewPlaying      = true;
  // Which caption the Apply-page preview is showing. Default 0; user can
  // cycle with the prev/next arrows. Reset to 0 whenever a fresh caption
  // list is generated.
  var _m4PreviewCapIdx  = 0;
  // Override hook - when set, _m4DrawPreview renders into the alternate
  // canvas with the given words + current index instead of the default
  // settings panel preview. Used by the caption editor popup to mirror
  // its working state through the M4 render pipeline.
  var _m4PreviewOverride = null; // { canvas, words, curIdx } | null

  function _m4DrawPreview() {
    var canvas = (_m4PreviewOverride && _m4PreviewOverride.canvas) || m4PreviewCanvas;
    if (!canvas) return;
    var ctx = canvas.getContext('2d');
    var cssW = canvas.offsetWidth;
    var cssH = canvas.offsetHeight;
    if (cssW > 0 && canvas.width  !== cssW) canvas.width  = cssW;
    if (cssH > 0 && canvas.height !== cssH) canvas.height = cssH;
    var W = canvas.width;
    var H = canvas.height;

    // Base All typography
    var fontFamily  = _m4TypoAll.fontFamily || 'Arial';
    var fontStyle   = _m4TypoAll.fontStyle  || 'bold';
    var fontSize    = _m4TypoAll.fontSize   || 24;
    var letterSpacing = m4LetterSpacingEl ? parseInt(m4LetterSpacingEl.value, 10) : 0;
    var textTransform = m4TextTransformEl ? m4TextTransformEl.value : 'none';
    // Per-state effective fonts (resolve override ?? All)
    function _typoEff(state, field) {
      var ov = _m4TypoOverrides[state];
      return (ov && ov[field] != null) ? ov[field] : (field === 'fontFamily' ? fontFamily : field === 'fontStyle' ? fontStyle : fontSize);
    }
    var preFontFamily = _typoEff('pre',  'fontFamily'), preFontStyle = _typoEff('pre',  'fontStyle'), preFontSize = _typoEff('pre',  'fontSize');
    var curFontFamily = _typoEff('cur',  'fontFamily'), curFontStyle = _typoEff('cur',  'fontStyle'), curFontSize = _typoEff('cur',  'fontSize');
    var pstFontFamily = _typoEff('post', 'fontFamily'), pstFontStyle = _typoEff('post', 'fontStyle'), pstFontSize = _typoEff('post', 'fontSize');

    // Apply text transform for display
    function _applyTT(w) {
      if (textTransform === 'uppercase')  return w.toUpperCase();
      if (textTransform === 'lowercase')  return w.toLowerCase();
      if (textTransform === 'capitalize') return w.replace(/\b\w/g, function(c) { return c.toUpperCase(); });
      return w;
    }

    var preFill  = _readFill('pre');
    var curFill  = _readFill('cur');
    var postFill = _readFill('post');
    var _strokeOn = document.getElementById('m4-stroke-enable') ? document.getElementById('m4-stroke-enable').checked : true;
    var _shadowOn = document.getElementById('m4-shadow-enable') ? document.getElementById('m4-shadow-enable').checked : true;
    var _noStr = { color: '#000', opacity: 0, width: 0 };
    var preStroke  = _strokeOn ? _readStroke('pre')  : _noStr;
    var curStroke  = _strokeOn ? _readStroke('cur')  : _noStr;
    var postStroke = _strokeOn ? _readStroke('post') : _noStr;
    var strokeWidth = _strokeOn ? Math.max(_readStroke('cur').width, _readStroke('pre').width, _readStroke('post').width) : 0;
    var fw          = m4FrameWidthEl  ? parseInt(m4FrameWidthEl.value, 10)          : 84;
    var posY        = m4PosYEl        ? (parseInt(m4PosYEl.value, 10) / 100)        : 0.70;
    var posX        = m4PosXEl        ? (parseInt(m4PosXEl.value, 10) / 100)        : 0.5;

    // Words: override (editor popup) takes priority, otherwise pull from
    // whichever caption the user has navigated to (_m4PreviewCapIdx),
    // otherwise fall back to the first caption then a placeholder.
    // We also collect any explicit line breaks the caption carries (via
    // "\n" in c.text) so the Settings preview respects them just like
    // the captions list does.
    var words;
    var _captionTextLB = [];
    if (_m4PreviewOverride && _m4PreviewOverride.words) {
      words = _m4PreviewOverride.words.slice();
    } else {
      words = ['This', 'is', 'fascinating', 'to', 'watch'];
      if (generatedCaptions && generatedCaptions.length > 0) {
        var _capIdx = Math.max(0, Math.min(generatedCaptions.length - 1, _m4PreviewCapIdx));
        var _ph = generatedCaptions[_capIdx];
        var _ws = (_ph && _ph.words && _ph.words.length) ? _ph.words : null;
        if (_ws) words = _ws.map(function(w) { return w.word || w.text || ''; }).filter(Boolean);
        else if (_ph && _ph.text) words = _ph.text.trim().split(/\s+/);
        // Extract line-break word indices from c.text - these are the
        // explicit breaks the editor / groupWords decided on. Preview
        // must respect them or the user sees a 1-line preview while
        // the caption is actually 2 lines in the captions list.
        if (_ph && _ph.text && _ph.text.indexOf('\n') !== -1) {
          var _txtLines = _ph.text.split('\n');
          var _twi = 0;
          for (var _ti = 0; _ti < _txtLines.length - 1; _ti++) {
            var _tc = _txtLines[_ti].trim().split(/\s+/).filter(Boolean).length;
            _twi += _tc;
            if (_twi > 0 && _twi < words.length) _captionTextLB.push(_twi);
          }
        }
      }
    }
    if (!words.length) words = [''];

    var curIdx = (_m4PreviewOverride && _m4PreviewOverride.curIdx != null)
      ? Math.max(0, Math.min(words.length - 1, _m4PreviewOverride.curIdx))
      : (_m4PreviewWordIdx % words.length);
    var dir    = _resolveDir(words);

    // Use sequence dims from generation time if captions exist, else live fallback
    var seqW = (generatedCaptions.length > 0 ? captionSeqW : _m4SeqW) || 1920;
    var seqH = (generatedCaptions.length > 0 ? captionSeqH : _m4SeqH) || 1080;
    // Zoom override lets the editor popup render at a smaller scale so
    // the preview text doesn't dominate the small popup pane.
    var zoom = (_m4PreviewOverride && typeof _m4PreviewOverride.zoom === 'number')
      ? _m4PreviewOverride.zoom
      : _m4PreviewZoom;

    var displayWords = words.map(_applyTT);

    var scaledFontSize = Math.max(1, Math.round(fontSize * zoom));
    var lineGap = m4LineGapEl ? parseInt(m4LineGapEl.value, 10) : 4;

    // ── Font metrics: max ascent/descent across all states (no-LS, for sizing) ─
    function _stateM(ff, fs, fz) {
      ctx.font = fs + ' ' + Math.max(1, Math.round(fz * zoom)) + 'px ' + ff;
      ctx.letterSpacing = '0px';
      var _m = ctx.measureText('Ay');
      return { a: Math.ceil(_m.actualBoundingBoxAscent  || fz * zoom * 0.8),
               d: Math.ceil(_m.actualBoundingBoxDescent || fz * zoom * 0.2) };
    }
    var _mPre = _stateM(preFontFamily, preFontStyle, preFontSize);
    var _mCur = _stateM(curFontFamily, curFontStyle, curFontSize);
    var _mPst = _stateM(pstFontFamily, pstFontStyle, pstFontSize);
    var ascentScaled    = Math.max(_mPre.a, _mCur.a, _mPst.a);
    var descentScaled   = Math.max(_mPre.d, _mCur.d, _mPst.d);
    var lineTextHScaled = ascentScaled + descentScaled;
    var lineHScaled     = lineTextHScaled + Math.round(lineGap * zoom);
    var curLineH        = _mCur.a + _mCur.d;

    // ── Measurement pass 1: All font, no-LS - for line-break only ────────────
    ctx.font          = fontStyle + ' ' + scaledFontSize + 'px ' + fontFamily;
    ctx.letterSpacing = '0px';
    ctx.direction     = dir;
    ctx.textAlign     = 'left';
    ctx.textBaseline  = 'alphabetic';
    var spWNoLS     = ctx.measureText(' ').width;
    var wWidthsNoLS = displayWords.map(function(w) { return ctx.measureText(w).width; });
    var spWNoLSU    = spWNoLS / zoom;
    var wWidthsU    = wWidthsNoLS.map(function(w) { return w / zoom; });

    // ── Word-wrap: uses NO-LS widths so LS never causes extra line breaks ─────
    // Must come before pass 2 so line-mode state assignment can use line indices.
    function _range(a, b) { var r = []; for (var k = a; k < b; k++) r.push(k); return r; }
    var lines = [];
    // Forced line breaks: editor override > c.text "\n" positions > none.
    // Either source means the preview should split at exactly those word
    // indices and skip the fixed/auto wrap logic below.
    var _forcedLB = (_m4PreviewOverride && _m4PreviewOverride.lineBreaks)
      ? _m4PreviewOverride.lineBreaks.slice()
      : (_captionTextLB.length ? _captionTextLB.slice() : null);
    if (_forcedLB) _forcedLB.sort(function (a, b) { return a - b; });
    if (_forcedLB && _forcedLB.length) {
      var lastIdx = 0;
      for (var fbi = 0; fbi < _forcedLB.length; fbi++) {
        var b = _forcedLB[fbi];
        if (b <= lastIdx || b >= words.length) continue;
        lines.push(_range(lastIdx, b));
        lastIdx = b;
      }
      lines.push(_range(lastIdx, words.length));
    } else if (_m4WrapMode === 'fixed') {
      var linesCount   = _getCurrentLines() || 2;
      var charsPerLine = (typeof _getCurrentChars === 'function' && _getCurrentChars()) || 80;
      // Lines is a MAX, not a force: only split when the joined text
      // wouldn't fit on a single line at the Chars limit. Previously
      // we always divided words evenly across linesCount, which split
      // 2-word captions across 2 lines even when both words would
      // comfortably share one - mismatching what groupWords decided
      // (and what the caption list / editor timeline display).
      var _joinedLen = words.join(' ').length;
      if (linesCount <= 1 || _joinedLen <= charsPerLine) {
        lines.push(_range(0, words.length));
      } else {
        var wordsPerLine = Math.ceil(words.length / linesCount);
        for (var fl = 0; fl < linesCount; fl++) {
          var fStart = fl * wordsPerLine, fEnd = Math.min(fStart + wordsPerLine, words.length);
          if (fStart < words.length) lines.push(_range(fStart, fEnd));
        }
      }
    } else {
      var maxLineW = Math.round(seqW * fw / 100);
      var line = [], lineW = 0;
      for (var i = 0; i < words.length; i++) {
        var extra = line.length ? spWNoLSU + wWidthsU[i] : wWidthsU[i];
        if (line.length && lineW + extra > maxLineW) {
          lines.push(line); line = [i]; lineW = wWidthsU[i];
        } else { line.push(i); lineW += extra; }
      }
      if (line.length) lines.push(line);
    }

    // Word->line map for line mode (pre-computed from wrap result above)
    var _wordLineMap = new Array(words.length);
    for (var _fliP = 0; _fliP < lines.length; _fliP++) {
      lines[_fliP].forEach(function(idx) { _wordLineMap[idx] = _fliP; });
    }
    var _previewCurLine = _wordLineMap[Math.min(curIdx, words.length - 1)] || 0;

    // ── Measurement pass 2: mixed per-state fonts with LS - for positions ─────
    // In line mode, all words on the active line use curFont so layout stays
    // stable as curIdx advances within a line.
    var wWidthsScaled = displayWords.map(function(w, i) {
      var state;
      if (_m4ActiveMode === 'line') {
        var wl = _wordLineMap[i] !== undefined ? _wordLineMap[i] : 0;
        state = (wl < _previewCurLine) ? 'pre' : (wl === _previewCurLine ? 'cur' : 'post');
      } else {
        state = (i < curIdx) ? 'pre' : (i === curIdx ? 'cur' : 'post');
      }
      var ff = (state === 'pre' ? preFontFamily : state === 'cur' ? curFontFamily : pstFontFamily);
      var fs = (state === 'pre' ? preFontStyle  : state === 'cur' ? curFontStyle  : pstFontStyle);
      var fz = (state === 'pre' ? preFontSize   : state === 'cur' ? curFontSize   : pstFontSize);
      ctx.font = fs + ' ' + Math.max(1, Math.round(fz * zoom)) + 'px ' + ff;
      ctx.letterSpacing = letterSpacing ? letterSpacing + 'px' : '0px';
      return ctx.measureText(w).width;
    });
    // Space: All font + LS
    ctx.font = fontStyle + ' ' + scaledFontSize + 'px ' + fontFamily;
    ctx.letterSpacing = letterSpacing ? letterSpacing + 'px' : '0px';
    ctx.direction = dir; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    var spWScaled = ctx.measureText(' ').width;

    // Cur word width + actual vertical bounds with cur font + LS (for HL box + solo centering)
    ctx.font = curFontStyle + ' ' + Math.max(1, Math.round(curFontSize * zoom)) + 'px ' + curFontFamily;
    ctx.letterSpacing = letterSpacing ? letterSpacing + 'px' : '0px';
    var _curWordM      = ctx.measureText(displayWords[curIdx] || '');
    var curWordWScaled = _curWordM.width;
    var _soloAsc = _curWordM.actualBoundingBoxAscent  || _mCur.a;
    var _soloDes = _curWordM.actualBoundingBoxDescent || _mCur.d;

    // ── Frame geometry ────────────────────────────────────────────────────────
    var frameW           = seqW * zoom;
    var frameH           = seqH * zoom;
    var capCenterInFrame = posY * frameH;
    var frameX           = (W - frameW) / 2;
    var frameY           = H / 2 - capCenterInFrame;

    // ── Background + frame ────────────────────────────────────────────────────
    ctx.fillStyle = '#262a36';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#5a5e6a';
    ctx.fillRect(frameX, frameY, frameW, frameH);
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth   = 1;
    ctx.strokeRect(Math.round(frameX) + 0.5, Math.round(frameY) + 0.5, Math.round(frameW), Math.round(frameH));
    ctx.restore();

    // ── Text block vertical geometry ──────────────────────────────────────────
    var totalTextH    = lines.length * lineHScaled - Math.round(lineGap * zoom);
    var textBlockTopY = H / 2 - totalTextH / 2;
    var baseY         = Math.round(textBlockTopY) + ascentScaled;

    // ── Absolute x positions - centered per line using LS-aware widths ────────
    // Mirrors renderer's wordXPos: computed once from base All font layout.
    var _phraseCenterX = Math.round(frameX + posX * frameW);
    var _wordX = new Array(words.length);
    for (var _li = 0; _li < lines.length; _li++) {
      var _lineIdxs = lines[_li];
      var _lw = _lineIdxs.reduce(function(a, _wi) { return a + wWidthsScaled[_wi]; }, 0)
                + spWScaled * (_lineIdxs.length - 1);
      var _x = (dir === 'rtl') ? Math.round(_phraseCenterX + _lw / 2) : Math.round(_phraseCenterX - _lw / 2);
      for (var _lj = 0; _lj < _lineIdxs.length; _lj++) {
        var _wi = _lineIdxs[_lj];
        if (dir === 'rtl') { _x -= wWidthsScaled[_wi]; _wordX[_wi] = _x; _x -= spWScaled; }
        else               { _wordX[_wi] = _x; _x += wWidthsScaled[_wi] + spWScaled; }
      }
    }


    function _drawPreviewMergedStroke(oc, boxes, r, sk, zoom) {
      if (!sk || !sk.enable || (sk.width || 0) <= 0) return;
      var sw  = (sk.width || 2) * zoom;
      var pos = sk.position || 'center';
      var alpha = (sk.opacity != null ? sk.opacity : 100) / 100;
      var bx0 = Math.min.apply(null, boxes.map(function(b) { return b.x; }));
      var bx1 = Math.max.apply(null, boxes.map(function(b) { return b.x + b.w; }));
      var by0 = boxes[0].y, by1 = boxes[boxes.length - 1].y + boxes[boxes.length - 1].h;
      var fillStyle = _previewGrad(oc, sk.fill || { type: 'solid', color: '#ffffff' }, bx0, bx1 - bx0, by0, by1 - by0, alpha);
      oc.save();
      if (pos === 'inside') {
        _buildMergedBgPath(oc, boxes, r); oc.clip();
        _buildMergedBgPath(oc, boxes, r); oc.lineWidth = sw * 2;
      } else if (pos === 'outside') {
        var _exp = boxes.map(function(b) { return { x: b.x - sw/2, y: b.y - sw/2, w: b.w + sw, h: b.h + sw }; });
        _buildMergedBgPath(oc, _exp, r + sw / 2); oc.lineWidth = sw;
      } else {
        _buildMergedBgPath(oc, boxes, r); oc.lineWidth = sw;
      }
      oc.strokeStyle = fillStyle;
      oc.globalAlpha = alpha;
      oc.stroke();
      oc.restore();
    }

    function _drawRoundRect(c, rx, ry, rw, rh, rr) {
      var r = Math.min(rr, rw / 2, rh / 2);
      c.beginPath();
      c.moveTo(rx + r, ry);
      c.lineTo(rx + rw - r, ry); c.quadraticCurveTo(rx + rw, ry, rx + rw, ry + r);
      c.lineTo(rx + rw, ry + rh - r); c.quadraticCurveTo(rx + rw, ry + rh, rx + rw - r, ry + rh);
      c.lineTo(rx + r, ry + rh); c.quadraticCurveTo(rx, ry + rh, rx, ry + rh - r);
      c.lineTo(rx, ry + r); c.quadraticCurveTo(rx, ry, rx + r, ry);
      c.closePath();
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // LAYERED DRAW - same stacking order as Premiere tracks (bottom -> top)
    // Tracks 0-1: Word Box (cur word highlight - bottommost)
    // Track  2  : Context (CBG + Pre text + Post text - one combined layer)
    // Tracks 3-4: Cur text (topmost)
    // ═══════════════════════════════════════════════════════════════════════════

    // ── Text layer helper - draws words in range [fromIdx, toIdx] ─────────────
    // fill: { type, color, color2, opacity }  stroke: { color, opacity } | null
    // Helper: hex color + alpha -> rgba string
    function _hexA(hex, a) {
      var h = (hex || '#000000').replace('#', '');
      if (h.length === 3) h = h[0]+h[0]+h[1]+h[1]+h[2]+h[2];
      return 'rgba(' + parseInt(h.slice(0,2),16) + ',' + parseInt(h.slice(2,4),16) + ',' + parseInt(h.slice(4,6),16) + ',' + a + ')';
    }

    // Compute fill/stroke style (solid or angle-aware gradient).
    // CSS gradient angle convention: 0° = up, 90° = right.
    function _previewGrad(c, fill, x, w, y, h, alpha) {
      if (fill.type === 'gradient') {
        var angle = (fill.angle || 0) * Math.PI / 180;
        var dx = Math.sin(angle);
        var dy = -Math.cos(angle);
        var cx = x + w / 2, cy = (y || 0) + (h || 0) / 2;
        var len = Math.max(Math.abs(w / 2 * dx) + Math.abs((h || 0) / 2 * dy), 1);
        var g = c.createLinearGradient(cx - dx * len, cy - dy * len,
                                       cx + dx * len, cy + dy * len);
        g.addColorStop(0, _hexA(fill.color, alpha));
        g.addColorStop(1, _hexA(fill.color2 || fill.color, alpha));
        return g;
      }
      return alpha < 1 ? _hexA(fill.color, alpha) : (fill.color || '#ffffff');
    }

    function _drawPreviewBoxStroke(c, bx, by, bw, bh, brad, sk, zoom) {
      if (!sk || !sk.enable || (sk.width || 0) <= 0) return;
      var sw  = (sk.width || 2) * zoom;
      var pos = sk.position || 'center';
      var alpha = (sk.opacity != null ? sk.opacity : 100) / 100;
      var fillStyle = _previewGrad(c, sk.fill || { type: 'solid', color: '#ffffff' }, bx, bw, by, bh, alpha);
      c.save();
      if (pos === 'inside') {
        _drawRoundRect(c, bx, by, bw, bh, brad); c.clip();
        _drawRoundRect(c, bx, by, bw, bh, brad);
        c.lineWidth = sw * 2;
      } else if (pos === 'outside') {
        _drawRoundRect(c, bx - sw / 2, by - sw / 2, bw + sw, bh + sw, brad + sw / 2);
        c.lineWidth = sw;
      } else {
        _drawRoundRect(c, bx, by, bw, bh, brad);
        c.lineWidth = sw;
      }
      c.strokeStyle = fillStyle;
      c.stroke();
      c.restore();
    }

    function _drawTextLayer(fromIdx, toIdx, fill, layerFF, layerFS, layerFZ, stroke, shadow, phase) {
      if (fromIdx > toIdx || fromIdx >= words.length) return;
      ctx.font          = layerFS + ' ' + Math.max(1, Math.round(layerFZ * zoom)) + 'px ' + layerFF;
      ctx.letterSpacing = letterSpacing ? letterSpacing + 'px' : '0px';
      ctx.direction     = dir;
      ctx.textAlign     = 'left';
      ctx.textBaseline  = 'alphabetic';
      ctx.globalAlpha   = 1; // fill + stroke each carry their own alpha baked in as rgba
      var fillAlpha = (fill.opacity != null ? fill.opacity : 100) / 100;
      // Shadow helpers - shadow applied to FIRST draw op so it renders behind stroke+fill
      var _hasShadow = _shadowOn && !!(shadow && shadow.opacity > 0);
      function _applyWordShadow() {
        if (!_hasShadow) return;
        ctx.shadowColor   = _hexA(shadow.color || '#000000', shadow.opacity / 100);
        ctx.shadowBlur    = (shadow.blur || 0) * zoom;
        ctx.shadowOffsetX = (shadow.x || 0) * zoom;
        ctx.shadowOffsetY = (shadow.y || 0) * zoom;
      }
      function _clearWordShadow() {
        ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0;
        ctx.shadowOffsetX = 0; ctx.shadowOffsetY = 0;
      }
      // Per-state width from stroke object; fall back to legacy global strokeWidth
      var _sW = stroke && stroke.width != null ? stroke.width : strokeWidth;
      _sW = _sW > 0 ? _sW : 0;
      if (_sW > 0 && stroke) {
        var _sAlpha = (stroke.opacity != null ? stroke.opacity : 100) / 100;
        ctx.lineWidth = Math.max(1, _sW * zoom * 2);
        ctx.lineJoin  = 'round';
        // strokeStyle gradient is set per-line inside the loop
        if (stroke.type !== 'gradient') ctx.strokeStyle = _hexA(stroke.color || '#000000', _sAlpha);
      }
      for (var li = 0; li < lines.length; li++) {
        var lineIdxs = lines[li];
        var y = baseY + li * lineHScaled;
        // Full line extent (for pre/post unified gradient across a line)
        var lx0 = Infinity, lx1 = -Infinity;
        // Gradient extent scoped to the drawn range [fromIdx..toIdx] only
        var gx0 = Infinity, gx1 = -Infinity;
        var _hasWord = false;
        for (var lj0 = 0; lj0 < lineIdxs.length; lj0++) {
          var wi0 = lineIdxs[lj0];
          lx0 = Math.min(lx0, _wordX[wi0]);
          lx1 = Math.max(lx1, _wordX[wi0] + wWidthsScaled[wi0]);
          if (wi0 >= fromIdx && wi0 <= toIdx) {
            _hasWord = true;
            gx0 = Math.min(gx0, _wordX[wi0]);
            gx1 = Math.max(gx1, _wordX[wi0] + wWidthsScaled[wi0]);
          }
        }
        if (!_hasWord) continue;
        var lineH = lineHScaled;
        var lineTop = y - ascentScaled;
        ctx.fillStyle = _previewGrad(ctx, fill, gx0, gx1 - gx0, lineTop, lineH, fillAlpha);
        if (_sW > 0 && stroke && stroke.type === 'gradient') {
          var _sAlpha2 = (stroke.opacity != null ? stroke.opacity : 100) / 100;
          ctx.strokeStyle = _previewGrad(ctx, stroke, gx0, gx1 - gx0, lineTop, lineH, _sAlpha2);
        }
        for (var lj = 0; lj < lineIdxs.length; lj++) {
          var wi = lineIdxs[lj];
          if (wi < fromIdx || wi > toIdx) continue;
          var wx = _wordX[wi], wy = y, wd = displayWords[wi];
          // Tri-state shadow source. 'both' applies shadow to BOTH passes
          // so the visible glyph silhouette (fill + stroke) all casts.
          var _shOnStroke = _hasShadow &&
                            (_m4ShadowFollow === 'stroke' || _m4ShadowFollow === 'both') &&
                            (_m4StrokePos === 'outside' || _m4StrokePos === 'center');
          var _shOnFill   = _hasShadow &&
                            (_m4ShadowFollow === 'fill'   || _m4ShadowFollow === 'both');

          // STROKE-ONLY: drawn during the phrase's first sweep so all
          // strokes form a single background layer behind every fill.
          if (phase === 'stroke') {
            if (_sW <= 0 || !stroke) continue;
            if (_m4StrokePos === 'inside') continue;
            if (_shOnStroke) { _applyWordShadow(); ctx.strokeText(wd, wx, wy); _clearWordShadow(); }
            else             { ctx.strokeText(wd, wx, wy); }
            continue;
          }
          // FILL-ONLY: drawn during the second sweep, on top of all strokes.
          if (phase === 'fill') {
            if (_shOnFill) {
              _applyWordShadow(); ctx.fillText(wd, wx, wy); _clearWordShadow();
            } else {
              ctx.fillText(wd, wx, wy);
            }
            continue;
          }

          // BOTH-PHASES (single-pass) - used for solo / inside / direct
          // callers. With shadowFollow='both' the stroke gets its shadow
          // and so does the fill on top, layering both casts.
          if (_sW > 0 && stroke) {
            if (_m4StrokePos === 'outside') {
              if (_shOnStroke) {
                _applyWordShadow(); ctx.strokeText(wd, wx, wy); _clearWordShadow();
                if (_shOnFill) { _applyWordShadow(); ctx.fillText(wd, wx, wy); _clearWordShadow(); }
                else           { ctx.fillText(wd, wx, wy); }
              } else {
                if (_shOnFill) { _applyWordShadow(); ctx.fillText(wd, wx, wy); _clearWordShadow(); }
                else           { ctx.fillText(wd, wx, wy); }
                ctx.strokeText(wd, wx, wy);
                ctx.fillText(wd, wx, wy);
              }
            } else if (_m4StrokePos === 'center') {
              if (_shOnStroke) {
                _applyWordShadow(); ctx.strokeText(wd, wx, wy); _clearWordShadow();
                if (_shOnFill) { _applyWordShadow(); ctx.fillText(wd, wx, wy); _clearWordShadow(); }
                else           { ctx.fillText(wd, wx, wy); }
              } else {
                if (_shOnFill) { _applyWordShadow(); ctx.fillText(wd, wx, wy); _clearWordShadow(); }
                else           { ctx.fillText(wd, wx, wy); }
                ctx.strokeText(wd, wx, wy);
              }
            } else {
              // 'inside' - stroke clipped to fill, single shadow on fill
              if (_shOnFill) { _applyWordShadow(); ctx.fillText(wd, wx, wy); _clearWordShadow(); }
              else           { ctx.fillText(wd, wx, wy); }
              ctx.globalCompositeOperation = 'source-atop';
              ctx.strokeText(wd, wx, wy);
              ctx.globalCompositeOperation = 'source-over';
            }
          } else {
            if (_shOnFill) { _applyWordShadow(); ctx.fillText(wd, wx, wy); _clearWordShadow(); }
            else           { ctx.fillText(wd, wx, wy); }
          }
        }
      }
      // shadow is cleared per-word inside the loop
    }

    // Resolve active line extents for 'line' mode
    var _curLine     = _previewCurLine;
    var _curLineIdxs = lines[_curLine] || [curIdx];
    var _curLineFirst = _curLineIdxs[0];
    var _curLineLast  = _curLineIdxs[_curLineIdxs.length - 1];
    var _isOff  = (_m4ActiveMode === 'off');
    var _isLine = (_m4ActiveMode === 'line');
    var _isSolo = (_m4ActiveMode === 'solo');

    // Caption center Y in canvas space (posY mapped into the preview canvas)
    var _capCY = H / 2;  // frameY + capCenterInFrame always equals H/2

    // Read shadow settings for preview
    var _preShadow  = _readShadow('pre');
    var _curShadow  = _readShadow('cur');
    var _postShadow = _readShadow('post');
    var _hlShadow   = _readBoxShadow('hl');
    var _cbgShadow  = _readBoxShadow('cbg');

    // Premiere applies a five-frame Impact transition to the active text and
    // active box clips. The old canvas preview advanced the active word but
    // never visualised that transition. Keep the preview transform isolated to
    // the same layers so the static context remains identical to the timeline.
    var _animate     = m4AnimateEl     ? m4AnimateEl.checked       : false;
    var _animType    = m4AnimTypeEl    ? m4AnimTypeEl.value        : 'none';
    var _animBoxType = m4AnimBoxTypeEl ? m4AnimBoxTypeEl.value     : 'none';
    var _curWillAnim = _animate && (_animType    !== 'none');
    var _wbWillAnim  = _animate && (_animBoxType !== 'none');
    function _m4ApplyPreviewAnim(type, cx, cy) {
      if (!_animate || !type || type === 'none') return;
      var rawP = (_m4PreviewOverride && typeof _m4PreviewOverride.animProgress === 'number')
        ? _m4PreviewOverride.animProgress
        : _m4PreviewAnimProgress;
      var p = Math.max(0, Math.min(1, rawP));
      // Ease-out cubic is a close visual match for Premiere's Impact family.
      var e = 1 - Math.pow(1 - p, 3);
      var alpha = 1;
      var scale = 1;
      var scaleX = 1;
      var shiftX = 0;
      var shiftY = 0;
      var rotate = 0;
      var blurPx = 0;
      if (type === 'pop') {
        // Small overshoot keeps Pop readable at compact panel sizes.
        scale = p < 0.72
          ? 0.62 + (1.10 - 0.62) * (1 - Math.pow(1 - p / 0.72, 3))
          : 1.10 - 0.10 * ((p - 0.72) / 0.28);
        alpha = Math.min(1, p * 4);
      } else if (type === 'push') {
        shiftX = -(1 - e) * Math.max(20, 46 * zoom);
        alpha = Math.min(1, p * 3);
      } else if (type === 'dissolve') {
        alpha = e;
      } else if (type === 'slide') {
        shiftY = (1 - e) * Math.max(22, 52 * zoom);
        alpha = Math.min(1, p * 3);
      } else if (type === 'zoom-blur') {
        scale = 1.58 - 0.58 * e;
        blurPx = (1 - e) * Math.max(2, 7 * zoom);
        alpha = Math.min(1, p * 2.5);
      } else if (type === 'spin-3d') {
        rotate = -(1 - e) * Math.PI * 0.42;
        scaleX = 0.18 + 0.82 * e;
        alpha = Math.min(1, p * 3);
      } else if (type === 'blur-dissolve') {
        blurPx = (1 - e) * Math.max(3, 10 * zoom);
        alpha = e;
      } else if (type === 'linear-wipe') {
        scaleX = Math.max(0.02, e);
        alpha = Math.min(1, p * 4);
      }
      ctx.globalAlpha *= alpha;
      if (blurPx && typeof ctx.filter !== 'undefined') ctx.filter = 'blur(' + blurPx.toFixed(2) + 'px)';
      if (shiftX || shiftY) ctx.translate(shiftX, shiftY);
      if (scale !== 1 || scaleX !== 1 || rotate) {
        ctx.translate(cx, cy);
        if (rotate) ctx.rotate(rotate);
        ctx.scale(scale * scaleX, scale);
        ctx.translate(-cx, -cy);
      }
    }

    // ── Tracks 0-1: Word Box (bottommost) - skip when mode is 'off' ──────────
    var showHL = !_isOff && (m4HlEnableEl ? m4HlEnableEl.checked : false);
    if (showHL && curIdx < words.length) {
      var hlOp   = m4HlOpacityEl ? (parseInt(m4HlOpacityEl.value, 10) / 100) : 0.8;
      var hlRad  = m4HlRadiusEl  ? parseInt(m4HlRadiusEl.value, 10) * zoom   : 8 * zoom;
      var hlPadT = (m4HlPadTopEl ? parseInt(m4HlPadTopEl.value, 10) : 8) * zoom;
      var hlPadB = (m4HlPadBotEl ? parseInt(m4HlPadBotEl.value, 10) : 8) * zoom;
      var hlPadL = (m4HlPadLftEl ? parseInt(m4HlPadLftEl.value, 10) : 8) * zoom;
      var hlPadR = (m4HlPadRgtEl ? parseInt(m4HlPadRgtEl.value, 10) : 8) * zoom;
      var _hlFill = { type: m4HlFillTypeEl ? m4HlFillTypeEl.value : 'solid',
                      color: m4HlColorEl ? m4HlColorEl.value : '#ffe44d',
                      color2: m4HlColor2El ? m4HlColor2El.value : '#ff8800',
                      angle: m4HlFillAngleEl ? (parseInt(m4HlFillAngleEl.value, 10) || 0) : 0,
                      opacity: 100 };
      ctx.save();
      var _hlShOn = (function(){ var e=document.getElementById('m4-hl-shadow-enable'); return !e || e.checked; })();
      if (_hlShOn && _hlShadow.opacity > 0) {
        ctx.shadowColor   = _hexA(_hlShadow.color, _hlShadow.opacity / 100);
        ctx.shadowBlur    = (_hlShadow.blur || 0) * zoom;
        ctx.shadowOffsetX = (_hlShadow.x || 0) * zoom;
        ctx.shadowOffsetY = (_hlShadow.y || 0) * zoom;
      }
      ctx.globalAlpha = hlOp;
      var _hlBx, _hlBy, _hlBw, _hlBh;
      if (_isSolo) {
        _hlBx = Math.round(_phraseCenterX - curWordWScaled / 2 - hlPadL);
        _hlBy = Math.round(_capCY - lineTextHScaled / 2 - hlPadT);
        _hlBw = Math.round(curWordWScaled + hlPadL + hlPadR);
        _hlBh = Math.round(lineTextHScaled + hlPadT + hlPadB);
      } else if (_isLine) {
        var _hlTopY = textBlockTopY + _curLine * lineHScaled;
        var _lineXLeft  = Math.min(_wordX[_curLineFirst], _wordX[_curLineLast]);
        var _lineXRight = Math.max(_wordX[_curLineFirst] + wWidthsScaled[_curLineFirst],
                                   _wordX[_curLineLast]  + wWidthsScaled[_curLineLast]);
        _hlBx = Math.round(_lineXLeft  - hlPadL);
        _hlBy = Math.round(_hlTopY - hlPadT);
        _hlBw = Math.round(_lineXRight - _lineXLeft + hlPadL + hlPadR);
        _hlBh = Math.round(lineTextHScaled + hlPadT + hlPadB);
      } else {
        var _wBaselineY = baseY + _curLine * lineHScaled;
        _hlBx = Math.round(_wordX[curIdx] - hlPadL);
        _hlBy = Math.round(_wBaselineY - ascentScaled - hlPadT);
        _hlBw = Math.round(curWordWScaled + hlPadL + hlPadR);
        _hlBh = Math.round(lineTextHScaled + hlPadT + hlPadB);
      }
      if (_wbWillAnim) _m4ApplyPreviewAnim(_animBoxType, _hlBx + _hlBw / 2, _hlBy + _hlBh / 2);
      _drawRoundRect(ctx, _hlBx, _hlBy, _hlBw, _hlBh, hlRad);
      ctx.fillStyle = _previewGrad(ctx, _hlFill, _hlBx, _hlBw, _hlBy, _hlBh, 1);
      ctx.fill();
      ctx.restore();
      // Stroke
      var _hlSkOn = (function(){ var e=document.getElementById('m4-hl-stroke-enable'); return e && e.checked; })();
      if (_hlSkOn) {
        var _hlSk = _readBoxStroke('hl');
        ctx.save();
        if (_wbWillAnim) _m4ApplyPreviewAnim(_animBoxType, _hlBx + _hlBw / 2, _hlBy + _hlBh / 2);
        _drawPreviewBoxStroke(ctx, _hlBx, _hlBy, _hlBw, _hlBh, hlRad, _hlSk, zoom);
        ctx.restore();
      }
    }

    // ── Track 2: Context (CBG + Pre + Post) - skipped entirely in solo ────────
    if (!_isSolo) {
      var showCBG = m4CbgEnableEl ? m4CbgEnableEl.checked : false;
      if (showCBG) {
        var cbgOp    = m4CbgOpacityEl ? (parseInt(m4CbgOpacityEl.value, 10) / 100) : 0.6;
        var cbgRad   = m4CbgRadiusEl  ? parseInt(m4CbgRadiusEl.value, 10) * zoom   : 12 * zoom;
        var _cbgPadT = (m4CbgPadTopEl ? parseInt(m4CbgPadTopEl.value, 10) : 8)  * zoom;
        var _cbgPadB = (m4CbgPadBotEl ? parseInt(m4CbgPadBotEl.value, 10) : 8)  * zoom;
        var _cbgPadL = (m4CbgPadLftEl ? parseInt(m4CbgPadLftEl.value, 10) : 12) * zoom;
        var _cbgPadR = (m4CbgPadRgtEl ? parseInt(m4CbgPadRgtEl.value, 10) : 12) * zoom;
        var _cbgFill = { type:   m4CbgFillTypeEl  ? m4CbgFillTypeEl.value                       : 'solid',
                         color:  m4CbgColorEl      ? m4CbgColorEl.value                           : '#000000',
                         color2: m4CbgColor2El     ? m4CbgColor2El.value                          : '#333333',
                         angle:  m4CbgFillAngleEl  ? (parseInt(m4CbgFillAngleEl.value, 10) || 0) : 0,
                         opacity: 100 };
        var _cbgMode   = m4CbgModeEl   ? m4CbgModeEl.value   : 'full';
        var _cbgCorner = m4CbgCornerEl ? m4CbgCornerEl.value : 'separate';
        var _cbgShOn = (function(){ var e=document.getElementById('m4-cbg-shadow-enable'); return !e || e.checked; })();
        var _cbgSkOn = (function(){ var e=document.getElementById('m4-cbg-stroke-enable'); return e && e.checked; })();
        var _cbgSk = _cbgSkOn ? _readBoxStroke('cbg') : null;

        // Build per-line boxes
        var _cbgBoxes = lines.map(function(lineIdxs, li) {
          var lw = lineIdxs.reduce(function(a, wi) { return a + wWidthsScaled[wi]; }, 0)
                   + spWScaled * (lineIdxs.length - 1);
          return {
            x: Math.round((W - lw) / 2 - _cbgPadL),
            y: Math.round(textBlockTopY + li * lineHScaled - _cbgPadT),
            w: Math.round(lw + _cbgPadL + _cbgPadR),
            h: Math.round(lineTextHScaled + _cbgPadT + _cbgPadB)
          };
        });
        // Full mode: one box spanning all lines
        if (_cbgMode === 'full') {
          var _maxLW = 0;
          lines.forEach(function(lineIdxs) {
            var lw = lineIdxs.reduce(function(a, wi) { return a + wWidthsScaled[wi]; }, 0) + spWScaled * (lineIdxs.length - 1);
            if (lw > _maxLW) _maxLW = lw;
          });
          _cbgBoxes = [{
            x: Math.round((W - _maxLW) / 2 - _cbgPadL),
            y: Math.round(textBlockTopY - _cbgPadT),
            w: Math.round(_maxLW + _cbgPadL + _cbgPadR),
            h: Math.round(totalTextH + _cbgPadT + _cbgPadB)
          }];
        }

        // Draw via offscreen canvas for correct group opacity
        var _cbgOff = document.createElement('canvas');
        _cbgOff.width = W; _cbgOff.height = H;
        var _cbgOc = _cbgOff.getContext('2d');

        // Shadow on offscreen
        if (_cbgShOn && _cbgShadow.opacity > 0) {
          _cbgOc.shadowColor   = _hexA(_cbgShadow.color, _cbgShadow.opacity / 100);
          _cbgOc.shadowBlur    = (_cbgShadow.blur || 0) * zoom;
          _cbgOc.shadowOffsetX = (_cbgShadow.x || 0) * zoom;
          _cbgOc.shadowOffsetY = (_cbgShadow.y || 0) * zoom;
        }

        var _isMerge = (_cbgMode === 'line' && _cbgCorner === 'merge');

        // Fills
        if (_isMerge) {
          var _mbx0 = Math.min.apply(null, _cbgBoxes.map(function(b){return b.x;}));
          var _mbx1 = Math.max.apply(null, _cbgBoxes.map(function(b){return b.x+b.w;}));
          var _mby0 = _cbgBoxes[0].y, _mby1 = _cbgBoxes[_cbgBoxes.length-1].y + _cbgBoxes[_cbgBoxes.length-1].h;
          _buildMergedBgPath(_cbgOc, _cbgBoxes, cbgRad);
          _cbgOc.fillStyle = _previewGrad(_cbgOc, _cbgFill, _mbx0, _mbx1 - _mbx0, _mby0, _mby1 - _mby0, 1);
          _cbgOc.fill();
        } else {
          _cbgBoxes.forEach(function(b) {
            _drawRoundRect(_cbgOc, b.x, b.y, b.w, b.h, cbgRad);
            _cbgOc.fillStyle = _previewGrad(_cbgOc, _cbgFill, b.x, b.w, b.y, b.h, 1);
            _cbgOc.fill();
          });
        }

        // Blit offscreen to main at CBG opacity
        ctx.save();
        ctx.globalAlpha = cbgOp;
        ctx.drawImage(_cbgOff, 0, 0);
        ctx.restore();

        // Strokes (after blit)
        if (_cbgSk) {
          if (_isMerge) {
            _drawPreviewMergedStroke(ctx, _cbgBoxes, cbgRad, _cbgSk, zoom);
          } else {
            _cbgBoxes.forEach(function(b) {
              _drawPreviewBoxStroke(ctx, b.x, b.y, b.w, b.h, cbgRad, _cbgSk, zoom);
            });
          }
        }
      }
      // Two layout modes:
      //   - animate=false (UNIFIED): the renderer auto-bakes; phrase is one
      //     canvas, drawn in phrase position order (pre -> cur -> post) with
      //     two-pass so all strokes sit behind all fills.
      //   - animate=true (SEPARATED): the renderer keeps cur on its own
      //     track. Mirror that here: draw all of pre+post as a "ctx layer"
      //     first (two-pass within, so its own strokes are unified), THEN
      //     draw cur on top as its own layer - its stroke/shadow can
      //     overlap into pre/post just like the on-timeline composite.
      var _twoPass = (_m4StrokePos !== 'inside');
      var _strokePhase = _twoPass ? 'stroke' : 'both';

      // Per-type gating mirrors the renderer: the host stacks WB BELOW
      // ctx (it places WB at the lowest tracks). So cur can render inline
      // with pre+post whenever it isn't animating - even if WB is animating
      // (the animating WB is at a lower track than the baked ctx anyway).
      // Only cur's own animation forces it onto a separate "cur layer".
      var _curInline = !_curWillAnim;

      // Pre stroke (always; the "ctx layer" starts here)
      if (_isLine) {
        _drawTextLayer(0, _curLineFirst - 1, preFill, preFontFamily, preFontStyle, preFontSize, preStroke, _preShadow, _strokePhase);
      } else if (_isOff) {
        // Off mode: all words same color (preFill), no cur highlight
        _drawTextLayer(0, words.length - 1, preFill, preFontFamily, preFontStyle, preFontSize, preStroke, _preShadow, _strokePhase);
      } else if (!_isSolo) {
        var _preToIdx  = (_m4CurInCtx === 'pre')  ? curIdx     : curIdx - 1;
        _drawTextLayer(0, _preToIdx, preFill, preFontFamily, preFontStyle, preFontSize, preStroke, _preShadow, _strokePhase);
      }
    }

    // ── Cur text - Solo always draws here (solo has no pre/post layers,
    // so the inline/separated distinction is moot). Non-solo cur is inline
    // ONLY when animations are off; otherwise the cur layer is drawn at
    // the very end on top of everything.
    if (!_isOff && (_isSolo || _curInline)) {
      if (_isSolo) {
        // Solo: draw single word centered at caption position, ignoring phrase layout
        ctx.save();
        if (_curWillAnim) _m4ApplyPreviewAnim(_animType, _phraseCenterX, _capCY);
        ctx.font = curFontStyle + ' ' + Math.max(1, Math.round(curFontSize * zoom)) + 'px ' + curFontFamily;
        ctx.letterSpacing = letterSpacing ? letterSpacing + 'px' : '0px';
        ctx.direction = dir; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
        var _soloBaseY = _capCY + (_soloAsc - _soloDes) / 2;
        var _soloAlpha = (curFill.opacity != null ? curFill.opacity : 100) / 100;
        var _soloSW = strokeWidth > 0 ? Math.max(1, Math.round(strokeWidth * zoom)) : 0;
        var _soloWord = displayWords[curIdx] || '';
        function _setSoloShadow() {
          if (!(_curShadow.opacity > 0)) return;
          ctx.shadowColor   = _hexA(_curShadow.color, _curShadow.opacity / 100);
          ctx.shadowBlur    = (_curShadow.blur || 0) * zoom;
          ctx.shadowOffsetX = (_curShadow.x || 0) * zoom;
          ctx.shadowOffsetY = (_curShadow.y || 0) * zoom;
        }
        function _clearSoloShadow() { ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; ctx.shadowOffsetX = 0; ctx.shadowOffsetY = 0; }
        if (curFill.type === 'gradient') {
          var _sg = ctx.createLinearGradient(W/2 - curWordWScaled/2, 0, W/2 + curWordWScaled/2, 0);
          _sg.addColorStop(0, 'rgba(' + parseInt(curFill.color.slice(1,3),16) + ',' + parseInt(curFill.color.slice(3,5),16) + ',' + parseInt(curFill.color.slice(5,7),16) + ',' + _soloAlpha + ')');
          _sg.addColorStop(1, 'rgba(' + parseInt((curFill.color2||curFill.color).slice(1,3),16) + ',' + parseInt((curFill.color2||curFill.color).slice(3,5),16) + ',' + parseInt((curFill.color2||curFill.color).slice(5,7),16) + ',' + _soloAlpha + ')');
          ctx.fillStyle = _sg;
        } else {
          ctx.fillStyle = 'rgba(' + parseInt(curFill.color.slice(1,3),16) + ',' + parseInt(curFill.color.slice(3,5),16) + ',' + parseInt(curFill.color.slice(5,7),16) + ',' + _soloAlpha + ')';
        }
        // Tri-state "Shadow on" (fill/stroke/both) - mirrors _drawWord in
        // captionRenderer.js so the preview matches the exported PNGs.
        var _soloHasSh   = (_curShadow.opacity > 0);
        var _soloShStk   = _soloHasSh &&
                           (_m4ShadowFollow === 'stroke' || _m4ShadowFollow === 'both') &&
                           (_m4StrokePos === 'outside' || _m4StrokePos === 'center');
        var _soloShFil   = _soloHasSh &&
                           (_m4ShadowFollow === 'fill'   || _m4ShadowFollow === 'both');
        if (_soloSW > 0 && curStroke) {
          var _sSA = (curStroke.opacity != null ? curStroke.opacity : 100) / 100;
          ctx.lineWidth   = _soloSW * 2;
          ctx.strokeStyle = 'rgba(' + parseInt(curStroke.color.slice(1,3),16) + ',' + parseInt(curStroke.color.slice(3,5),16) + ',' + parseInt(curStroke.color.slice(5,7),16) + ',' + _sSA + ')';
          ctx.lineJoin    = 'round';
          if (_m4StrokePos === 'outside') {
            if (_soloShStk) {
              _setSoloShadow(); ctx.strokeText(_soloWord, _phraseCenterX, _soloBaseY); _clearSoloShadow();
              if (_soloShFil) { _setSoloShadow(); ctx.fillText(_soloWord, _phraseCenterX, _soloBaseY); _clearSoloShadow(); }
              else            { ctx.fillText(_soloWord, _phraseCenterX, _soloBaseY); }
            } else {
              if (_soloShFil) { _setSoloShadow(); ctx.fillText(_soloWord, _phraseCenterX, _soloBaseY); _clearSoloShadow(); }
              else            { ctx.fillText(_soloWord, _phraseCenterX, _soloBaseY); }
              ctx.strokeText(_soloWord, _phraseCenterX, _soloBaseY);
              ctx.fillText(_soloWord, _phraseCenterX, _soloBaseY);
            }
          } else if (_m4StrokePos === 'center') {
            if (_soloShStk) {
              _setSoloShadow(); ctx.strokeText(_soloWord, _phraseCenterX, _soloBaseY); _clearSoloShadow();
              if (_soloShFil) { _setSoloShadow(); ctx.fillText(_soloWord, _phraseCenterX, _soloBaseY); _clearSoloShadow(); }
              else            { ctx.fillText(_soloWord, _phraseCenterX, _soloBaseY); }
            } else {
              if (_soloShFil) { _setSoloShadow(); ctx.fillText(_soloWord, _phraseCenterX, _soloBaseY); _clearSoloShadow(); }
              else            { ctx.fillText(_soloWord, _phraseCenterX, _soloBaseY); }
              ctx.strokeText(_soloWord, _phraseCenterX, _soloBaseY);
            }
          } else {
            // 'inside' - stroke clipped to fill, single shadow on fill
            if (_soloShFil) { _setSoloShadow(); ctx.fillText(_soloWord, _phraseCenterX, _soloBaseY); _clearSoloShadow(); }
            else            { ctx.fillText(_soloWord, _phraseCenterX, _soloBaseY); }
            ctx.globalCompositeOperation = 'source-atop';
            ctx.strokeText(_soloWord, _phraseCenterX, _soloBaseY);
            ctx.globalCompositeOperation = 'source-over';
          }
        } else {
          if (_soloShFil) { _setSoloShadow(); ctx.fillText(_soloWord, _phraseCenterX, _soloBaseY); _clearSoloShadow(); }
          else            { ctx.fillText(_soloWord, _phraseCenterX, _soloBaseY); }
        }
        ctx.restore();
      } else if (_isLine) {
        _drawTextLayer(_curLineFirst, _curLineLast, curFill, curFontFamily, curFontStyle, curFontSize, curStroke, _curShadow, _strokePhase);
      } else {
        // Word mode: draw at layout position (full-canvas, no ink-centering offset)
        _drawTextLayer(curIdx, curIdx, curFill, curFontFamily, curFontStyle, curFontSize, curStroke, _curShadow, _strokePhase);
      }
    }

    // ── Post text - stroke pass (drawn AFTER pre + cur strokes so order
    // matches phrase position; with two-pass enabled, fills run below).
    if (!_isOff && !_isSolo) {
      if (_isLine) {
        _drawTextLayer(_curLineLast + 1, words.length - 1, postFill, pstFontFamily, pstFontStyle, pstFontSize, postStroke, _postShadow, _strokePhase);
      } else {
        var _postFrIdx2 = (_m4CurInCtx === 'post') ? curIdx : curIdx + 1;
        _drawTextLayer(_postFrIdx2, words.length - 1, postFill, pstFontFamily, pstFontStyle, pstFontSize, postStroke, _postShadow, _strokePhase);
      }
    }

    // ── Fill pass - only runs when two-pass is active. Pre + Post fills
    // always; the cur fill is inline only in unified mode (mirrors the
    // stroke pass above).
    if (_twoPass) {
      if (!_isOff) {
        if (_isLine) {
          _drawTextLayer(0, _curLineFirst - 1, preFill, preFontFamily, preFontStyle, preFontSize, preStroke, _preShadow, 'fill');
        } else if (!_isSolo) {
          var _preToIdx3 = (_m4CurInCtx === 'pre') ? curIdx : curIdx - 1;
          _drawTextLayer(0, _preToIdx3, preFill, preFontFamily, preFontStyle, preFontSize, preStroke, _preShadow, 'fill');
        }
      } else {
        _drawTextLayer(0, words.length - 1, preFill, preFontFamily, preFontStyle, preFontSize, preStroke, _preShadow, 'fill');
      }
      if (!_isOff && !_isSolo && _curInline) {
        if (_isLine) {
          _drawTextLayer(_curLineFirst, _curLineLast, curFill, curFontFamily, curFontStyle, curFontSize, curStroke, _curShadow, 'fill');
        } else {
          _drawTextLayer(curIdx, curIdx, curFill, curFontFamily, curFontStyle, curFontSize, curStroke, _curShadow, 'fill');
        }
      }
      if (!_isOff && !_isSolo) {
        if (_isLine) {
          _drawTextLayer(_curLineLast + 1, words.length - 1, postFill, pstFontFamily, pstFontStyle, pstFontSize, postStroke, _postShadow, 'fill');
        } else {
          var _postFrIdx3 = (_m4CurInCtx === 'post') ? curIdx : curIdx + 1;
          _drawTextLayer(_postFrIdx3, words.length - 1, postFill, pstFontFamily, pstFontStyle, pstFontSize, postStroke, _postShadow, 'fill');
        }
      }
    }

    // ── Cur LAYER (separated mode) - drawn last, on top of the entire
    // ctx layer. Mirrors the on-timeline composite where cur sits on
    // track 3 over ctx on track 0. Its stroke/shadow naturally extends
    // into pre/post territory just like the real render.
    if (!_isOff && !_curInline) {
      var _curAnimCX = _phraseCenterX;
      var _curAnimCY = _isLine
        ? textBlockTopY + _curLine * lineHScaled + lineTextHScaled / 2
        : baseY + _curLine * lineHScaled - ascentScaled / 2 + descentScaled / 2;
      if (!_isLine) _curAnimCX = _wordX[curIdx] + curWordWScaled / 2;
      ctx.save();
      _m4ApplyPreviewAnim(_animType, _curAnimCX, _curAnimCY);
      if (_isSolo) {
        // Solo already draws cur as a standalone block above; nothing extra here.
      } else if (_isLine) {
        _drawTextLayer(_curLineFirst, _curLineLast, curFill, curFontFamily, curFontStyle, curFontSize, curStroke, _curShadow, _strokePhase);
        if (_twoPass) _drawTextLayer(_curLineFirst, _curLineLast, curFill, curFontFamily, curFontStyle, curFontSize, curStroke, _curShadow, 'fill');
      } else {
        _drawTextLayer(curIdx, curIdx, curFill, curFontFamily, curFontStyle, curFontSize, curStroke, _curShadow, _strokePhase);
        if (_twoPass) _drawTextLayer(curIdx, curIdx, curFill, curFontFamily, curFontStyle, curFontSize, curStroke, _curShadow, 'fill');
      }
      ctx.restore();
    }

    ctx.globalAlpha = 1;
  }

  function _m4StartPreview() {
    if (_m4PreviewTimer) clearInterval(_m4PreviewTimer);
    _m4PreviewWordIdx = 0;
    _m4PreviewAnimProgress = 0;
    _m4PreviewCycleStart = Date.now();
    _m4PreviewPlaying = true;
    var playBtn = document.getElementById('m4-preview-play');
    if (playBtn) { playBtn.textContent = '\u275a\u275a'; playBtn.title = 'Pause preview'; }
    _m4DrawPreview();
    _m4PreviewTimer = setInterval(function () {
      if (!_m4PreviewPlaying) return;
      var elapsed = Date.now() - _m4PreviewCycleStart;
      var cycleMs = 900;
      var nextWordIdx = Math.floor(elapsed / cycleMs);
      // Five Premiere frames are ~167 ms at 30 fps. Use 220 ms here so the
      // motion remains legible in the compact CEP preview.
      var nextProgress = Math.min(1, (elapsed % cycleMs) / 220);
      // The draw routine is sizeable. Repaint at 30 fps only during the
      // transition, then sleep until the next active word begins.
      if (nextWordIdx !== _m4PreviewWordIdx || nextProgress < 1 || _m4PreviewAnimProgress < 1) {
        _m4PreviewWordIdx = nextWordIdx;
        _m4PreviewAnimProgress = nextProgress;
        _m4DrawPreview();
      }
    }, 33);
  }

  var _m4PreviewPlayBtn = document.getElementById('m4-preview-play');
  if (_m4PreviewPlayBtn) {
    _m4PreviewPlayBtn.addEventListener('click', function () {
      _m4PreviewPlaying = !_m4PreviewPlaying;
      if (_m4PreviewPlaying) {
        _m4PreviewCycleStart = Date.now() - (_m4PreviewWordIdx * 900);
        _m4PreviewPlayBtn.textContent = '\u275a\u275a';
        _m4PreviewPlayBtn.title = 'Pause preview';
      } else {
        _m4PreviewAnimProgress = 1;
        _m4PreviewPlayBtn.textContent = '\u25b6';
        _m4PreviewPlayBtn.title = 'Play preview';
        _m4DrawPreview();
      }
    });
  }

  // Redraw + save on any style change
  // fontStyleEl + fontSizeEl handled by dedicated per-state listeners above - not in generic loop
  // pos X / Y are intentionally NOT in here - they live on the action
  // bar (placement, not style) and persist to their own localStorage key.
  var _m4StyleEls = [m4AnimateEl,
                     m4AnimTypeEl, m4AnimBoxTypeEl, m4LineGapEl, m4LetterSpacingEl,
                     m4HlEnableEl, m4HlColorEl, m4HlOpacityEl, m4HlRadiusEl,
                     m4HlPadTopEl, m4HlPadBotEl, m4HlPadLftEl, m4HlPadRgtEl,
                     m4CbgEnableEl, m4CbgColorEl, m4CbgOpacityEl, m4CbgRadiusEl,
                     m4CbgPadTopEl, m4CbgPadBotEl, m4CbgPadLftEl, m4CbgPadRgtEl];
  _m4StyleEls.forEach(function (el) {
    if (!el) return;
    el.addEventListener('input',  function() { _m4DrawPreview(); _m4SaveSettings(); });
    el.addEventListener('change', function() { _m4DrawPreview(); _m4SaveSettings(); });
  });

  // ── Case icon buttons ──────────────────────────────────────────────────────
  document.querySelectorAll('.m4-case-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var val = btn.getAttribute('data-case');
      if (m4TextTransformEl) m4TextTransformEl.value = val;
      document.querySelectorAll('.m4-case-btn').forEach(function(b) {
        b.classList.toggle('active', b === btn);
      });
      _m4DrawPreview(); _m4SaveSettings();
    });
  });

  // ── Accordion section toggles (header toggle -> prevent open when off) ────────
  (function() {
    var _accordSections = [
      { accordId: 'm4-stroke-accord',  chkId: 'm4-stroke-enable' },
      { accordId: 'm4-shadow-accord',  chkId: 'm4-shadow-enable' },
      { accordId: 'm4-hl-accord',      chkId: 'm4-hl-enable'     },
      { accordId: 'm4-cbg-accord',     chkId: 'm4-cbg-enable'    },
      { accordId: 'm4-animate-accord', chkId: 'm4-animate'       },
    ];
    _accordSections.forEach(function(cfg) {
      var accord  = document.getElementById(cfg.accordId);
      var chk     = document.getElementById(cfg.chkId);
      if (!accord || !chk) return;
      var summary = accord.querySelector('summary');
      // Prevent accordion opening when toggle is off
      if (summary) {
        summary.addEventListener('click', function(e) {
          if (e.target.closest('.m4-toggle')) return;
          if (!chk.checked) e.preventDefault();
        });
      }
      function _syncAccord() {
        accord.classList.toggle('m4-section-off', !chk.checked);
        if (!chk.checked && accord.open) accord.removeAttribute('open');
        if (chk.checked) accord.setAttribute('open', '');
      }
      _syncAccord();
      chk.addEventListener('change', function() {
        _syncAccord();
        _m4DrawPreview(); _m4SaveSettings();
      });
    });

    // Sub-section enable toggles (stroke + shadow inside HL and CBG bodies)
    var _subShadows = [
      { chkId: 'm4-hl-stroke-enable',  bodyId: 'm4-hl-stroke-body'  },
      { chkId: 'm4-cbg-stroke-enable', bodyId: 'm4-cbg-stroke-body' },
      { chkId: 'm4-hl-shadow-enable',  bodyId: 'm4-hl-shadow-body'  },
      { chkId: 'm4-cbg-shadow-enable', bodyId: 'm4-cbg-shadow-body' },
    ];
    _subShadows.forEach(function(s) {
      var chk  = document.getElementById(s.chkId);
      var body = document.getElementById(s.bodyId);
      if (!chk || !body) return;
      function _sync() { body.classList.toggle('m4-disabled', !chk.checked); }
      _sync();
      chk.addEventListener('change', function() { _sync(); _m4DrawPreview(); _m4SaveSettings(); });
    });
  })();

  // Restore saved settings before first draw
  (function() {
    try {
      var saved = localStorage.getItem(M4_SETTINGS_KEY);
      if (saved) {
        _m4ApplySettings(JSON.parse(saved));
      } else {
        // No saved settings - ensure default mode button is highlighted
        document.querySelectorAll('.m4-active-btn').forEach(function(b) {
          b.classList.toggle('active', b.getAttribute('data-active') === _m4ActiveMode);
        });
        _m4SyncActiveUI();
      }
    } catch(_) { _m4SyncActiveUI(); }
  }());

  // ── Pickr color picker init ─────────────────────────────────────────────────
  var _m4PickrMap = {}; // inputId -> Pickr instance
  var _m4Syncing  = false; // true while programmatically syncing - suppresses change handler
  (function _m4InitPickr() {
    if (typeof Pickr === 'undefined') return;
    document.querySelectorAll('.m4-pickr-btn').forEach(function(btn) {
      var inputId = btn.getAttribute('data-for');
      var input   = document.getElementById(inputId);
      if (!input) return;
      var _default = (input.value && /^#[0-9a-fA-F]{6}$/.test(input.value))
        ? input.value : '#000000';
      var p = Pickr.create({
        el: btn,
        theme: 'classic',
        default: _default,
        position: 'bottom-middle',
        adjustableNumbers: true,
        components: {
          preview: true,
          hue: true,
          // No Save button - colors apply live as the user drags. Picker
          // closes when the user clicks outside it or hits the same swatch
          // again. Standard color-picker UX.
          interaction: { hex: true, input: true, save: false }
        }
      });
      p.on('change', function(color) {
        if (_m4Syncing || !color) return;
        var hex = color.toHEXA().toString().slice(0, 7);
        input.value = hex;
        // Mirror the picked color onto the swatch button. Pickr only
        // refreshes the .pcr-button background on its 'save' event by
        // default; we disabled Save, so commit silently every drag tick
        // to keep the swatch in sync with what's drawn in the preview.
        try { p.applyColor(true); } catch (_) {}
        // Route state-model writes for fill/stroke/shadow. Each *Write
        // helper internally calls _m4DrawPreview + _m4SaveSettings, so
        // the live preview and persistence happen on every drag tick.
        if (inputId === 'm4-fill-color')    { _m4FillWrite('color',  hex); return; }
        if (inputId === 'm4-fill-color2')   { _m4FillWrite('color2', hex); return; }
        if (inputId === 'm4-stroke-color')  { _m4StrkWrite('color',  hex); return; }
        if (inputId === 'm4-stroke-color2') { _m4StrkWrite('color2', hex); return; }
        if (inputId === 'm4-shadow-color')  { _m4ShadWrite('color',  hex); return; }
        _m4DrawPreview(); _m4SaveSettings();
      });
      _m4PickrMap[inputId] = p;
    });
    // Sync button colors to restored settings values
    _m4SyncPickrColors();
  }());

  // Sync all Pickr button colors to current hidden input values
  function _m4SyncPickrColors() {
    _m4Syncing = true;
    try {
      Object.keys(_m4PickrMap).forEach(function(inputId) {
        var input = document.getElementById(inputId);
        var val = input && input.value;
        if (val && /^#[0-9a-fA-F]{3,8}$/.test(val)) {
          try { _m4PickrMap[inputId].setColor(val, false); } catch(_) {}
        }
      });
    } finally { _m4Syncing = false; }
  }

  if (m4PreviewCanvas) _m4StartPreview();

  if (applyModel4Btn) {
    applyModel4Btn.addEventListener('click', function () {
      if (generatedCaptions.length === 0) {
        _announceApply('error', 'Load or generate captions before applying a template.');
        return;
      }
      applyModel4Btn.disabled = true;
      _setBtnLoading(applyModel4Btn, true, 'Applying...');
      setWorking(true, 'Rendering captions...');
      setStatus('working', 'Building caption clips...');

      var _trackVal = m4TrackSelect ? m4TrackSelect.value : '2';

      // Resolve track index - handle "new" and non-empty track warning
      function _proceedWithTrack(trackIndex) {
        var _runSeqName = ''; // hoisted - set during render step, used in placement step
        var _runDir = '';     // hoisted - set during render step, used in clips.json write
        var _onlyCaptionIndex = _styledApplyOpts.onlyCaptionIndex;
        _styledApplyOpts.onlyCaptionIndex = null;
        var _patchMode = (_onlyCaptionIndex != null && _lastStyledApply && _lastStyledApply.seqName);
        if (_patchMode) {
          _runSeqName = String(_lastStyledApply.seqName);
          if (_lastStyledApply.trackIndex > 0) trackIndex = _lastStyledApply.trackIndex;
          setStatus('working', 'Updating caption ' + (_onlyCaptionIndex + 1) + '...');
          _setBtnLoading(applyModel4Btn, true, 'Updating...');
        }
        var _m4Animate      = m4AnimateEl     ? m4AnimateEl.checked    : false;
      var _m4AnimType     = m4AnimTypeEl    ? m4AnimTypeEl.value     : 'none';
      var _m4AnimBoxType  = m4AnimBoxTypeEl ? m4AnimBoxTypeEl.value  : 'none';
      var _m4CurTracks = 2; // internal: number of cur tracks (alternating to isolate IN transition)
      var _strokeOn = document.getElementById('m4-stroke-enable') ? document.getElementById('m4-stroke-enable').checked : true;
      var _shadowOn = document.getElementById('m4-shadow-enable') ? document.getElementById('m4-shadow-enable').checked : true;
      var _hlShOn   = document.getElementById('m4-hl-shadow-enable')  ? document.getElementById('m4-hl-shadow-enable').checked  : false;
      var _cbgShOn  = document.getElementById('m4-cbg-shadow-enable') ? document.getElementById('m4-cbg-shadow-enable').checked : false;
      var _noStroke = { color: '#000', opacity: 0, width: 0 };
      var _noShadow = { color: '#000000', opacity: 0, blur: 0, x: 0, y: 0 };
      var style = {
        fontFamily:    _m4TypoAll.fontFamily || 'Arial',
        fontStyle:     _m4TypoAll.fontStyle  || 'bold',
        fontSize:      _m4TypoAll.fontSize   || 24,
        letterSpacing: m4LetterSpacingEl ? parseInt(m4LetterSpacingEl.value, 10) : 0,
        textTransform: m4TextTransformEl ? m4TextTransformEl.value : 'none',
        typoOverrides: { pre: _m4TypoOverrides.pre, cur: _m4TypoOverrides.cur, post: _m4TypoOverrides.post },
        activeMode: _m4ActiveMode,
        holdSilence: _m4HoldSilence,
        preFill:  _readFill('pre'),
        curFill:  _readFill('cur'),
        postFill: _readFill('post'),
        strokeCur:      _strokeOn ? _readStroke('cur')  : _noStroke,
        strokePre:      _strokeOn ? _readStroke('pre')  : _noStroke,
        strokePost:     _strokeOn ? _readStroke('post') : _noStroke,
        strokeWidth:    0, // legacy - per-state widths now live in strokeCur/Pre/Post.width
        strokePosition: _m4StrokePos,
        direction:    'auto',
        positionY:    m4PosYEl ? (parseInt(m4PosYEl.value, 10) / 100) : 0.85,
        positionX:    m4PosXEl ? (parseInt(m4PosXEl.value, 10) / 100) : 0.5,
        wrapMode:     _m4WrapMode,                                          // 'auto' | 'fixed'
        curInCtx:     _m4CurInCtx,                                          // 'pre' | 'post' | 'off'
        bakeCurWB:    _m4BakeCurWB,                                         // bake cur+WB into one clip
        shadowFollow: _m4ShadowFollow,            // Advanced: shadow source for thick strokes
        // Animation flags - read by the renderer's auto-bake gate so cur
        // stays a separate clip when the host will animate it on the
        // timeline. The host gets the same values via evalScript below;
        // these must match or the visual + animation will desync.
        animate:      _m4Animate,
        animType:     _m4AnimType,
        animBoxType:  _m4AnimBoxType,
        frameWidth:   m4FrameWidthEl ? parseInt(m4FrameWidthEl.value, 10) : 84, // % of seqW (auto only)
        linesCount:   _getCurrentLines(),                                   // from Captions tab (fixed only - max, not force)
        charsPerLine: _getCurrentChars(),                                   // used to decide when to actually split (fits on one line -> keep as one)
        lineGap:      m4LineGapEl    ? parseInt(m4LineGapEl.value, 10)     : 4, // extra px between lines
        // Highlight (cur word/line BG box)
        showHL:       m4HlEnableEl   ? m4HlEnableEl.checked               : false,
        hlFill: { type:   m4HlFillTypeEl  ? m4HlFillTypeEl.value                          : 'solid',
                  color:  m4HlColorEl     ? m4HlColorEl.value                              : '#ffe44d',
                  color2: m4HlColor2El    ? m4HlColor2El.value                             : '#ff8800',
                  angle:  m4HlFillAngleEl ? (parseInt(m4HlFillAngleEl.value, 10) || 0)    : 0,
                  opacity: 100 },
        hlColor:      m4HlColorEl    ? m4HlColorEl.value                  : '#ffe44d',
        hlOpacity:    m4HlOpacityEl  ? (parseInt(m4HlOpacityEl.value, 10) / 100) : 0.8,
        hlRadius:     m4HlRadiusEl   ? parseInt(m4HlRadiusEl.value, 10)   : 8,
        hlPadTop:     m4HlPadTopEl ? parseInt(m4HlPadTopEl.value, 10) : 8,
        hlPadBottom:  m4HlPadBotEl ? parseInt(m4HlPadBotEl.value, 10) : 8,
        hlPadLeft:    m4HlPadLftEl ? parseInt(m4HlPadLftEl.value, 10) : 8,
        hlPadRight:   m4HlPadRgtEl ? parseInt(m4HlPadRgtEl.value, 10) : 8,
        // Caption BG (whole-phrase)
        showCBG:      m4CbgEnableEl  ? m4CbgEnableEl.checked              : false,
        cbgFill: { type:   m4CbgFillTypeEl  ? m4CbgFillTypeEl.value                         : 'solid',
                   color:  m4CbgColorEl      ? m4CbgColorEl.value                             : '#000000',
                   color2: m4CbgColor2El     ? m4CbgColor2El.value                            : '#333333',
                   angle:  m4CbgFillAngleEl  ? (parseInt(m4CbgFillAngleEl.value, 10) || 0)   : 0,
                   opacity: 100 },
        cbgColor:     m4CbgColorEl   ? m4CbgColorEl.value                 : '#000000',
        cbgOpacity:   m4CbgOpacityEl ? parseInt(m4CbgOpacityEl.value, 10) : 60,
        cbgRadius:    m4CbgRadiusEl  ? parseInt(m4CbgRadiusEl.value, 10)  : 12,
        cbgMode:      m4CbgModeEl    ? m4CbgModeEl.value                  : 'full',
        cbgCorner:    m4CbgCornerEl  ? m4CbgCornerEl.value                : 'separate',
        cbgPadTop:    m4CbgPadTopEl ? parseInt(m4CbgPadTopEl.value, 10) : 8,
        cbgPadBottom: m4CbgPadBotEl ? parseInt(m4CbgPadBotEl.value, 10) : 8,
        cbgPadLeft:   m4CbgPadLftEl ? parseInt(m4CbgPadLftEl.value, 10) : 12,
        cbgPadRight:  m4CbgPadRgtEl ? parseInt(m4CbgPadRgtEl.value, 10) : 12,
        // Text shadow per state
        shadowCur:    _shadowOn ? _readShadow('cur')   : _noShadow,
        shadowPre:    _shadowOn ? _readShadow('pre')   : _noShadow,
        shadowPost:   _shadowOn ? _readShadow('post')  : _noShadow,
        // Box shadows
        hlShadow:     _hlShOn  ? _readBoxShadow('hl')  : _noShadow,
        cbgShadow:    _cbgShOn ? _readBoxShadow('cbg') : _noShadow,
        hlStroke:     _readBoxStroke('hl'),
        cbgStroke:    _readBoxStroke('cbg')
      };
      if (_patchMode) style.onlyCaptionIndexes = [_onlyCaptionIndex];

      // ── FireCut-style XML flow ─────────────────────────────────────────────
      // 1. Render PNGs (client)
      // 2. Import PNGs into project (host) so they exist in the .prproj XML
      // 3. Save project (host) -> prproj on disk has PNG MasterClip entries
      // 4. Read prproj, inject AE_m4_N sequences, write temp prproj (client)
      // 5. Import temp prproj (host) -> sequences appear in project, NO tabs
      // 6. Place + animate via API (host)

      var _m4t0 = Date.now();
      function _m4log(msg) { console.log('[M4 ' + ((Date.now()-_m4t0)/1000).toFixed(1) + 's]', msg); }
      _m4log('START - clicking Apply');

      var pinnedSeqId = '';
      Promise.all([
        CEP.evalScript('getSequenceInfo', [], 5000),
        CEP.evalScript('getProjectPath',  [], 5000).catch(function() { return ''; }),
        CEP.evalScript('getActiveSeqId', [], 5000),
        CEP.evalScript('getTimelineVideoMediaWindow', [], 15000).catch(function () { return null; })
      ])
        .then(function (results) {
          var seqInfo  = results[0];
          pinnedSeqId = results[2] && results[2].id;
          if (!pinnedSeqId || !seqInfo || seqInfo.error || !(Number(seqInfo.width) > 0) || !(Number(seqInfo.height) > 0)) {
            throw new Error('Open an active Premiere sequence before applying SRT captions.');
          }
          var mediaWin = results[3];
          var media = (mediaWin && !mediaWin.error && Number(mediaWin.end) > Number(mediaWin.start))
            ? { start: Number(mediaWin.start) || 0, end: Number(mediaWin.end) || 0 }
            : mediaWindowFromHost(seqInfo, null);
          var fitDelta = applyFitToCaptionList(generatedCaptions, media.start, media.end);
          if (Math.abs(fitDelta) > 0.02) {
            persistCaptions();
            _m4log('Shifted caption times by ' + fitDelta.toFixed(2) + 's to match timeline video (' +
              media.start.toFixed(2) + '-' + media.end.toFixed(2) + 's)');
          }
          var projPath = (typeof results[1] === 'string' ? results[1] : '') .replace(/\\/g, '/');
          if (!projPath || projPath.lastIndexOf('/') < 0) throw new Error('Save the Premiere project first so caption images have a permanent media folder.');
          var seqW = 1920, seqH = 1080, seqTimebase = 0;
          try {
            if (seqInfo && seqInfo.width)    seqW        = seqInfo.width;
            if (seqInfo && seqInfo.height)   seqH        = seqInfo.height;
            if (seqInfo && seqInfo.timebase) seqTimebase = seqInfo.timebase;
          } catch (_) {}
          _m4SeqW = seqW; _m4SeqH = seqH; // cache for preview
          _m4log('getSequenceInfo OK - ' + seqW + 'x' + seqH + ' timebase=' + seqTimebase);

          // 1 - Render PNGs into a timestamped subfolder; same timestamp used as seq name
          var _now = new Date();
          var _ts = _now.getFullYear()
            + '-' + String(_now.getMonth() + 1).padStart(2, '0')
            + '-' + String(_now.getDate()).padStart(2, '0')
            + '_' + String(_now.getHours()).padStart(2, '0')
            + '-' + String(_now.getMinutes()).padStart(2, '0')
            + '-' + String(_now.getSeconds()).padStart(2, '0');
          if (!_patchMode) _runSeqName = 'Orbit_' + _ts + '_' + Date.now();
          var _projDir = projPath ? projPath.substring(0, projPath.lastIndexOf('/')) : '';
          var _baseDir = _projDir
            ? _projDir + '/Orbit Captions'
            : CEP.getExtensionPath().replace(/\\/g, '/') + '/output/captions';
          _runDir = _patchMode
            ? (_baseDir + '/' + _runSeqName + '_patch_' + Date.now())
            : (_baseDir + '/' + _runSeqName);

          setStatus('working', _patchMode
            ? ('Rendering caption ' + (_onlyCaptionIndex + 1) + '...')
            : 'Rendering captions...');
          return CaptionRenderer.renderPreCurrentPostPNGs(
            generatedCaptions, style, seqW, seqH, _runDir, seqTimebase,
            function(done, total) { setStatus('working', 'Rendering ' + done + '/' + total + '...'); }
          );
        })
        .then(function(renderResult) {
          var clips = renderResult.clips;
          if (!clips || clips.length === 0) {
            _setBtnLoading(applyModel4Btn, false);
            setWorking(false);
            applyModel4Btn.disabled = false;
            _announceApply('error', 'No clips to place - make sure captions have been generated.');
            return;
          }
          _m4log('PNGs rendered - ' + clips.length + ' clips');

          // Collect unique PNG paths
          var pngPaths = [], pngSeen = {};
          for (var pi = 0; pi < clips.length; pi++) {
            var pp = clips[pi].pngPath;
            if (pp && !pngSeen[pp]) { pngSeen[pp] = true; pngPaths.push(pp); }
          }
          _m4log('Unique PNG paths: ' + pngPaths.length);

          setStatus('working', 'Importing caption images...');

          // 2 - Pin main seq + import PNGs
          _m4log('-> getActiveSeqId (5s timeout)');
          return CEP.evalScript('getActiveSeqId', [], 5000)
            .then(function (seqInfo) {
              if (!seqInfo || String(seqInfo.id) !== String(pinnedSeqId)) throw new Error('The active sequence changed during rendering. Return to the original sequence and apply again.');
              _m4log('getActiveSeqId OK - ' + pinnedSeqId);
              _m4log('-> importModel4Pngs (90s timeout)');
              return CEP.evalScript('importModel4Pngs', [JSON.stringify(pngPaths), _runSeqName], 90000);
            })
            .then(function (importResult) {
              if (importResult && importResult.error) throw new Error(importResult.error);
              _m4log('importModel4Pngs OK');
              setStatus('working', 'Placing captions on timeline...');

              // Write clips JSON to disk - bypasses CEP evalScript string size limit
              // (6000+ clips with full paths can exceed the ~1MB bridge limit)
              var clipsJsonPath = (_runDir + '/clips.json').replace(/\\/g, '/');
              try {
                var _fs = require('fs');
                _fs.writeFileSync(clipsJsonPath, JSON.stringify(clips));
                _m4log('Wrote clips.json - ' + clips.length + ' clips');
              } catch (fsErr) {
                _m4log('WARN: could not write clips.json, falling back to inline - ' + fsErr.message);
                clipsJsonPath = '';
              }

              // 3 - Full apply builds nested seqs; single-caption revise patches the last apply.
              if (_patchMode) {
                _m4log('-> replaceModel4CaptionClips cap=' + _onlyCaptionIndex + ' (120s timeout)');
                return CEP.evalScript('replaceModel4CaptionClips', [
                  clipsJsonPath || JSON.stringify(clips),
                  _runSeqName,
                  String(_onlyCaptionIndex),
                  pinnedSeqId,
                  String(_m4Animate),
                  String(_m4CurTracks),
                  _m4AnimType,
                  _m4AnimBoxType
                ], 120000);
              }
              _m4log('-> buildAndPlaceModel4Captions (300s timeout)');
              return CEP.evalScript('buildAndPlaceModel4Captions', [
                clipsJsonPath || JSON.stringify(clips),
                _runSeqName,
                String(trackIndex),
                pinnedSeqId,
                String(_m4Animate),
                String(_m4CurTracks),
                _m4AnimType,
                _m4AnimBoxType
              ], 300000);
            })
            .then(function (result) {
              _m4log((_patchMode ? 'replaceModel4CaptionClips' : 'buildAndPlaceModel4Captions') +
                ' OK - placed=' + (result && result.placed));
              if (result && result.diagnostics) _m4log('host trace: ' + result.diagnostics.join(' | '));
              _setBtnLoading(applyModel4Btn, false);
              setWorking(false);
              applyModel4Btn.disabled = false;
              if (result && result.error) { _announceApply('error', result.error); return; }
              var placed = result && Number(result.placed);
              if (!(placed > 0)) throw new Error('Premiere did not confirm any placed caption clips. No successful Apply was reported.');
              if (!_patchMode) {
                _lastStyledApply = {
                  seqName: _runSeqName,
                  trackIndex: trackIndex,
                  animate: _m4Animate,
                  curTracks: _m4CurTracks,
                  animType: _m4AnimType,
                  animBoxType: _m4AnimBoxType
                };
                try { localStorage.setItem('orbit_last_styled_apply_v1', JSON.stringify(_lastStyledApply)); } catch (_) {}
              }
              var errs   = result && result.errors ? result.errors : [];
              var msg = _patchMode
                ? ('Updated caption ' + (_onlyCaptionIndex + 1) + ' - ' + placed + ' clip(s).')
                : ('Captions applied - ' + placed + ' clips on V' + trackIndex + '.');
              if (!_patchMode) {
                msg += ' If Premiere Subtitle text also shows, mute the Subtitle track.';
                CEP.evalScript('setCaptionTracksMuted', ['true'], 8000).catch(function () {});
              }
              if (errs.length) msg += ' | ' + errs.length + ' skipped: ' + errs.slice(0, 5).join(' | ');
              _announceApply(errs.length ? 'error' : 'success', msg);
            })
            .catch(function (err) {
              _m4log('CATCH: ' + err.message);
              _setBtnLoading(applyModel4Btn, false);
              setWorking(false); applyModel4Btn.disabled = false;
              _announceApply('error', err && err.message ? err.message : 'Caption placement failed.');
            });
        })
        .catch(function (err) {
          _m4log('CATCH (outer): ' + (err && err.message ? err.message : String(err)));
          _setBtnLoading(applyModel4Btn, false);
          setWorking(false);
          applyModel4Btn.disabled = false;
          _announceApply('error', err && err.message ? err.message : 'Something went wrong. Try again.');
        });
      } // end _proceedWithTrack

      function _abortApply() {
        _setBtnLoading(applyModel4Btn, false);
        setWorking(false);
        applyModel4Btn.disabled = false;
        setStatus('idle', '');
      }

      // Dispatch: "new" -> add track first; numeric -> check empty, warn on conflict
      if (_trackVal === 'new') {
        CEP.evalScript('addVideoTrack', [], 5000)
          .then(function (res) {
            if (res && res.error) {
              _setBtnLoading(applyModel4Btn, false);
              setWorking(false); applyModel4Btn.disabled = false;
              setStatus('error', 'Couldn\'t add a video track. Try again.');
              return;
            }
            var newIdx = res && res.trackIndex ? res.trackIndex : 1;
            // Update dropdown to reflect the newly created track
            if (m4TrackSelect) {
              var opt = document.createElement('option');
              opt.value = String(newIdx);
              opt.textContent = 'V' + newIdx;
              // Insert before the "new" option
              var newOpt = m4TrackSelect.querySelector('option[value="new"]');
              m4TrackSelect.insertBefore(opt, newOpt);
              m4TrackSelect.value = String(newIdx);
            }
            _proceedWithTrack(newIdx);
          })
          .catch(function (err) {
            _setBtnLoading(applyModel4Btn, false);
            setWorking(false); applyModel4Btn.disabled = false;
            setStatus('error', 'Couldn\'t add a video track. Try again.');
          });
      } else {
        var _trackNum = parseInt(_trackVal, 10) || 2;
        CEP.evalScript('checkTrackEmpty', [String(_trackNum)], 5000)
          .then(function (res) {
            if (res && res.empty === false) {
              _confirmAction(
                'V' + _trackNum + ' already has clips.\nProceeding will place the caption sequence on top.\nContinue?',
                function () { _proceedWithTrack(_trackNum); },
                _abortApply
              );
            } else {
              _proceedWithTrack(_trackNum);
            }
          })
          .catch(function () { _proceedWithTrack(_trackNum); });
      }
    });
  }

  // ── Helpers ────────────────────────────────────────────────────────────────
  function fmtTime(secs) {
    var safe = Math.max(0, Number(secs) || 0);
    var h = Math.floor(safe / 3600);
    var m = Math.floor((safe % 3600) / 60);
    var s = (safe % 60).toFixed(2);
    var mm = (m < 10 ? '0' : '') + m;
    var ss = (s < 10 ? '0' : '') + s;
    return h > 0 ? ((h < 10 ? '0' : '') + h + ':' + mm + ':' + ss) : (mm + ':' + ss);
  }

  function escapeHtml(str) {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  var progressFill = document.getElementById('ac-progress-fill');

  function _setBtnLoading(btn, isLoading, text) {
    if (!btn) return;
    if (isLoading) {
      if (!btn._origHTML) btn._origHTML = btn.innerHTML;
      btn.innerHTML = '<span class="btn-spinner"></span>' + (text || 'Working...');
    } else if (btn._origHTML) {
      btn.innerHTML = btn._origHTML;
    }
  }

  function setStatus(state, message) {
    var status = document.getElementById('ac-import-status');
    if (!status) {
      status = document.createElement('div');
      status.id = 'ac-import-status';
      status.setAttribute('role', 'status');
      status.setAttribute('aria-live', 'polite');
      status.style.cssText = 'padding:10px 12px;white-space:pre-wrap;font-size:12px;border:1px solid #28543d;border-radius:7px;margin:8px 0;';
      var panel = document.getElementById('autoCaptionsView');
      if (panel) panel.insertBefore(status, panel.firstChild);
    }
    status.textContent = String(message || '');
    status.dataset.state = state || '';
    status.style.color = state === 'error' ? '#ff929a' : '#b9efd1';
    status.hidden = !message;
  }

  // The status strip lives at the top of the Captions view, which is off
  // screen while the user is on the Style tab pressing Apply. Mirror the
  // outcome into a toast so Apply can never look like it did nothing.
  function _announceApply(state, message) {
    setStatus(state, message);
    if (typeof window.showToast === 'function') {
      try { window.showToast(String(message || ''), state === 'error'); } catch (_) {}
    }
  }

  function setWorking(isWorking, label) {
    if (generateBtn) generateBtn.disabled = isWorking;
    if (applySrtBtn) applySrtBtn.disabled = isWorking ? true : generatedCaptions.length === 0;
    if (placeEditableBtn) placeEditableBtn.disabled = isWorking ? true : generatedCaptions.length === 0;
    if (applyModel4Btn)  applyModel4Btn.disabled  = isWorking ? true : generatedCaptions.length === 0;
    if (progressWrap) progressWrap.classList.toggle('visible', isWorking);
    if (progressFill) progressFill.classList.toggle('indeterminate', isWorking);
    if (isWorking) {
      if (label && progressLabel) progressLabel.textContent = label;
      if (typeof window.showBusy === 'function') window.showBusy(label || 'Working...');
    } else {
      if (progressLabel) progressLabel.textContent = '';
      if (typeof window.hideBusy === 'function') window.hideBusy();
    }
  }

  // ── Restore UI from saved state ────────────────────────────────────────────
  if (generatedCaptions.length > 0) {
    renderCaptionList(generatedCaptions);
    applySrtBtn.disabled   = false;
    if (applyModel4Btn)  applyModel4Btn.disabled  = false;
    setWorking(false);
    updatePostgenBar();
    _updateCaptionsFooter();
  } else {
    setWorking(false);
    updatePostgenBar();
    _updateCaptionsFooter();
    // Popup used to auto-open here so first-time users had one-click
    // access to Generate. That also hid the home page (with its update
    // banner) on every panel reopen - users had to navigate to Settings
    // to see pending updates. Home is now the intentional landing view;
    // Generate is a single click away via the home card.
  }

  // Modal warming used to fire on screen mount, but that triggered a
  // cold GPU spin-up on every Auto Captions navigation - most of which
  // never led to a transcription. Warming now happens in openPopup()
  // (committed intent), where form-filling time overlaps with the cold
  // start.


  // ── Cleanup on close - stop all timers so the panel doesn't lag on close ───
  window.addEventListener('beforeunload', function () {
    if (_m4PreviewTimer) { clearInterval(_m4PreviewTimer); _m4PreviewTimer = null; }
    if (_m4TplIntervals) { _m4TplIntervals.forEach(function(id) { clearInterval(id); }); _m4TplIntervals = []; }
    if (_editAudioEl) { try { _editAudioEl.pause(); } catch (_) {} }
    if (_editRafId)   { cancelAnimationFrame(_editRafId); _editRafId = null; }
  });

  // ── Per-caption editor popup ──────────────────────────────────────────────
  // Continuous full-width timeline centered on the active caption. The zoom
  // slider controls how many seconds fit across the timeline width (NOT the
  // pixel width of the inner lane - there's no horizontal scroll). Neighbor
  // captions' words appear grayed for context. Prev/Next buttons swap which
  // caption is active without closing the popup.
  var _editPopupEl   = null, _editTimelineEl = null, _editWaveCv = null;
  var _editWordLane  = null, _editPlayheadEl = null, _editPlayBtn = null;
  var _editTimeEl    = null, _editZoomEl     = null, _editTextEl  = null;
  var _editPrevBtn   = null, _editNextBtn    = null, _editSpeedEl = null;
  // Playback speed remembered across opens of the editor - closing
  // and reopening on a different caption preserves the user's choice.
  var _editSpeed = 1.0;
  var _editRulerEl   = null;
  var _editScrollbarEl = null, _editScrollbarThumbEl = null;
  var _editAudioEl   = null;
  var _editRafId     = null;
  // Token bumped on each peaks fetch so out-of-order responses (slow request
  // then a fast one) don't overwrite newer state. Compare on resolve.
  var _editPeaksToken = 0;
  // Working state for the currently open caption - null when popup is closed.
  var _editState     = null;

  // Inverse of concatToTimeline: maps a timeline-time back into the concat
  // wav we have on disk. Used to seek HTML5 audio to the right offset.
  function timelineToConcat(timelineT, clipMap) {
    if (!clipMap || !clipMap.length) return timelineT;
    for (var i = 0; i < clipMap.length; i++) {
      var cm = clipMap[i];
      var tlDur = cm.timelineDur != null ? cm.timelineDur : (cm.concatEnd - cm.concatStart);
      var tEnd = cm.timelineStart + tlDur;
      if (timelineT < cm.timelineStart) return cm.concatStart;
      if (timelineT <= tEnd) {
        var concatLen = cm.concatEnd - cm.concatStart;
        if (concatLen > 0 && Math.abs(concatLen - tlDur) > 0.05) {
          return cm.concatStart + (timelineT - cm.timelineStart) * (concatLen / tlDur);
        }
        return cm.concatStart + (timelineT - cm.timelineStart);
      }
    }
    return clipMap[clipMap.length - 1].concatEnd;
  }

  // CEP runs file:// - encode for spaces / non-ASCII in the cached wav path.
  function _fileUrl(absPath) {
    return 'file:///' + absPath.replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/');
  }

  function _fmtMs(t) {
    if (!isFinite(t) || t < 0) t = 0;
    var m = Math.floor(t / 60);
    var s = Math.floor(t % 60);
    var ms = Math.floor((t - Math.floor(t)) * 10);
    return m + ':' + (s < 10 ? '0' : '') + s + '.' + ms;
  }

  var _editM4PreviewCv = null;
  function _editPopupGrabDom() {
    if (_editPopupEl) return;
    _editPopupEl    = document.getElementById('ac-edit-popup');
    _editTimelineEl = document.getElementById('ac-edit-timeline');
    _editWaveCv     = document.getElementById('ac-edit-waveform');
    _editWordLane   = document.getElementById('ac-edit-word-lane');
    _editPlayheadEl = document.getElementById('ac-edit-playhead');
    _editPlayBtn    = document.getElementById('ac-edit-play');
    _editTimeEl     = document.getElementById('ac-edit-time');
    _editZoomEl     = document.getElementById('ac-edit-zoom');
    _editTextEl     = document.getElementById('ac-edit-text-preview');
    _editPrevBtn    = document.getElementById('ac-edit-prev');
    _editNextBtn    = document.getElementById('ac-edit-next');
    _editSpeedEl    = document.getElementById('ac-edit-speed');
    _editRulerEl    = document.getElementById('ac-edit-timeline-ruler');
    _editScrollbarEl      = document.getElementById('ac-edit-scrollbar');
    _editScrollbarThumbEl = document.getElementById('ac-edit-scrollbar-thumb');
    _editM4PreviewCv = document.getElementById('ac-edit-m4-preview');
  }

  // Returns { words, curIdx, lineBreaks } for whichever caption should
  // be visible at concatT. Reuses the same hold-on-silence rules the
  // M4 renderer applies. Sources from workingCaptions so edits show up
  // immediately. lineBreaks is the per-caption line-break word indices
  // - passed through to _m4DrawPreview via override so dragging the
  // line-break handle is reflected in the preview.
  function _editCaptionAt(concatT) {
    if (!_editState) return null;
    var caps = _editState.workingCaptions;
    var lastCap = null;
    for (var ci = 0; ci < caps.length; ci++) {
      var cap = caps[ci];
      var ws  = cap.words;
      if (!ws || !ws.length) continue;
      var grpStart = ws[0].startConcat;
      var grpEnd   = ws[ws.length - 1].endConcat;
      if (concatT < grpStart) {
        if (lastCap && _m4HoldSilence) {
          return {
            words:      lastCap.ws.map(function (w) { return w.text; }),
            curIdx:     lastCap.ws.length - 1,
            lineBreaks: (lastCap.lineBreaks || []).slice()
          };
        }
        return null;
      }
      if (concatT >= grpEnd) {
        lastCap = { ws: ws, lineBreaks: cap.lineBreaks || [] };
        continue;
      }
      var _editCurIdx = _editCurWordIn(ws, concatT);
      var _editCurW = ws[Math.max(0, Math.min(ws.length - 1, _editCurIdx))];
      return {
        words:        ws.map(function (w) { return w.text; }),
        curIdx:       _editCurIdx,
        lineBreaks:   (cap.lineBreaks || []).slice(),
        animProgress: _editCurW ? Math.min(1, Math.max(0, (concatT - _editCurW.startConcat) / 0.22)) : 1
      };
    }
    return null;
  }

  // Render the M4 preview into the editor's canvas. Reuses _m4DrawPreview
  // via the override hook so any font / fill / mode / box change in
  // Settings is reflected here without duplicating render code. Between
  // captions the canvas clears to black - same as the final video.
  function _editDrawM4Preview() {
    if (!_editState || !_editM4PreviewCv) return;
    var concatT = _editAudioEl ? _editAudioEl.currentTime
                               : _editState.centerConcat;
    var info = _editCaptionAt(concatT);
    if (!info) {
      // No caption active at this moment - clear canvas, match real render.
      var c = _editM4PreviewCv.getContext('2d');
      var cssW = _editM4PreviewCv.offsetWidth;
      var cssH = _editM4PreviewCv.offsetHeight;
      if (cssW > 0 && _editM4PreviewCv.width  !== cssW) _editM4PreviewCv.width  = cssW;
      if (cssH > 0 && _editM4PreviewCv.height !== cssH) _editM4PreviewCv.height = cssH;
      c.fillStyle = '#0a0c12';
      c.fillRect(0, 0, _editM4PreviewCv.width, _editM4PreviewCv.height);
      return;
    }
    _m4PreviewOverride = {
      canvas:     _editM4PreviewCv,
      words:      info.words,
      curIdx:     info.curIdx,
      lineBreaks:   info.lineBreaks,
      animProgress: (typeof info.animProgress === 'number') ? info.animProgress : 1,
      // Editor preview renders text at ~60% of the Settings page zoom
      // so the text doesn't dominate the small preview pane. The number
      // is empirical - tweak if needed.
      zoom:       (typeof _m4PreviewZoom === 'number' ? _m4PreviewZoom : 1) * 0.6
    };
    try { _m4DrawPreview(); }
    finally { _m4PreviewOverride = null; }
  }

  // Returns the inner content width of the timeline (lane pixel width),
  // i.e. the timeline's clientWidth minus the horizontal padding on each side.
  function _editLaneWidth() {
    if (!_editTimelineEl) return 400;
    var cs = window.getComputedStyle(_editTimelineEl);
    var padL = parseFloat(cs.paddingLeft)  || 0;
    var padR = parseFloat(cs.paddingRight) || 0;
    return Math.max(50, _editTimelineEl.clientWidth - padL - padR);
  }

  // Rebuilds the timecode ruler above the waveform. Picks major + minor
  // tick intervals based on the visible duration so labels never crowd
  // each other (1s majors at deep zoom, 60s majors at zoom-out). Each
  // tick is positioned by left-% so the same DOM survives view changes.
  function _drawEditRuler() {
    if (!_editRulerEl || !_editState) return;
    var st = _editState;
    var viewDur = st.viewEndConcat - st.viewStartConcat;
    if (viewDur <= 0) { _editRulerEl.innerHTML = ''; return; }

    // Scale-adaptive intervals - keep ~6-12 majors visible across the view.
    var major, minor;
    if      (viewDur <=  3)  { major = 0.5; minor = 0.1; }
    else if (viewDur <=  8)  { major = 1;   minor = 0.2; }
    else if (viewDur <= 20)  { major = 2;   minor = 0.5; }
    else if (viewDur <= 60)  { major = 5;   minor = 1;   }
    else if (viewDur <= 180) { major = 15;  minor = 5;   }
    else                     { major = 60;  minor = 10;  }

    // Round-up the first tick so it lands on a clean interval.
    var first = Math.ceil(st.viewStartConcat / minor) * minor;
    var html  = '';
    for (var t = first; t <= st.viewEndConcat + 1e-6; t += minor) {
      var pct = (t - st.viewStartConcat) / viewDur * 100;
      // Floating-point safe major check (compare modulo against epsilon).
      var ratio = t / major;
      var isMajor = Math.abs(ratio - Math.round(ratio)) < 1e-6;
      html += '<span class="edit-popup-timeline-tick' + (isMajor ? ' is-major' : '') + '" style="left:' + pct.toFixed(2) + '%">';
      if (isMajor) {
        // Label rounded to 1 decimal at deep zoom, integer otherwise.
        var lbl = (major < 1) ? t.toFixed(1) : Math.round(t).toString();
        html += '<span class="edit-popup-timeline-label">' + lbl + 's</span>';
      }
      html += '</span>';
    }
    _editRulerEl.innerHTML = html;
  }

  // Returns the timeline's left content edge in CSS px, relative to the
  // timeline element itself. Used by click-to-seek and drag math.
  function _editLanePadLeft() {
    if (!_editTimelineEl) return 0;
    var cs = window.getComputedStyle(_editTimelineEl);
    return parseFloat(cs.paddingLeft) || 0;
  }

  function _drawEditWaveform(peaks) {
    // Ruler shares the same view-range trigger as the waveform; keep
    // them rebuilt together so they always stay in sync.
    _drawEditRuler();
    if (!_editWaveCv) return;
    var dpr = window.devicePixelRatio || 1;
    var cssW = _editWaveCv.clientWidth || 600;
    var cssH = _editWaveCv.clientHeight || 60;
    _editWaveCv.width  = Math.floor(cssW * dpr);
    _editWaveCv.height = Math.floor(cssH * dpr);
    var c = _editWaveCv.getContext('2d');
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, cssW, cssH);
    c.fillStyle = 'rgba(255,255,255,0.04)';
    c.fillRect(0, 0, cssW, cssH);
    if (!peaks || !peaks.length) return;

    var mid    = cssH / 2;
    var halfH  = cssH * 0.46;     // leave 4% margin top/bottom
    var step   = cssW / peaks.length;

    // Mirrored polygon - gives the classic "filled audio editor" silhouette
    // instead of thin bars that read as flat at narrow zooms.
    c.beginPath();
    c.moveTo(0, mid);
    for (var i = 0; i < peaks.length; i++) {
      c.lineTo(i * step, mid - Math.max(1, peaks[i] * halfH));
    }
    c.lineTo(cssW, mid);
    for (var j = peaks.length - 1; j >= 0; j--) {
      c.lineTo(j * step, mid + Math.max(1, peaks[j] * halfH));
    }
    c.closePath();

    // Subtle vertical gradient so the body has volume rather than reading
    // as a flat blue slab.
    var grad = c.createLinearGradient(0, 0, 0, cssH);
    grad.addColorStop(0,   'rgba(120, 165, 255, 0.95)');
    grad.addColorStop(0.5, 'rgba(99,  143, 255, 0.85)');
    grad.addColorStop(1,   'rgba(70,  108, 220, 0.95)');
    c.fillStyle = grad;
    c.fill();

    // Center axis line so the silhouette doesn't look like it's floating
    c.strokeStyle = 'rgba(255,255,255,0.06)';
    c.lineWidth   = 1;
    c.beginPath();
    c.moveTo(0, mid + 0.5);
    c.lineTo(cssW, mid + 0.5);
    c.stroke();
  }

  function _escHtml(s) {
    return (s || '').replace(/[&<>"]/g, function (ch) {
      return { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;' }[ch];
    });
  }

  // Renders every word from every caption that intersects the current
  // view window. The caption containing the playhead is the "active"
  // one - its words render at full saturation, with resize handles +
  // gap slots. Other captions render slightly muted but stay clickable
  // / editable (any word can be selected, dragged, dbl-click-edited).
  // Resize handles are hidden for word blocks narrower than 30px so
  // tiny words don't get cluttered with two big drag targets.
  function _layoutEditWordLane() {
    if (!_editState || !_editWordLane) return;
    var st = _editState;
    var laneW = st.laneWidthPx;
    var viewStart = st.viewStartConcat;
    var viewDur   = st.viewEndConcat - viewStart;
    if (viewDur <= 0) return;

    var concatT = _editAudioEl ? _editAudioEl.currentTime : viewStart;
    var activeCapIdx = _editEffectiveActiveCapIdx(concatT);

    var html = [];

    for (var ci = 0; ci < st.workingCaptions.length; ci++) {
      var ws = st.workingCaptions[ci].words;
      if (!ws.length) continue;
      var grpStart = ws[0].startConcat;
      var grpEnd   = ws[ws.length - 1].endConcat;
      if (grpEnd   <= viewStart) continue;
      if (grpStart >= st.viewEndConcat) break;

      // Visual: caption wrap - outline behind every word/pair of this
      // caption. Padded horizontally so the side borders extend a few
      // pixels past the first/last word instead of sitting flush with
      // them. Only drawn for the active caption now - boundary cues
      // for inactive captions come from the dashed separators below.
      // Cosmetic only; mechanics unchanged.
      if (ci === activeCapIdx) {
        var CAP_WRAP_PAD_PX = 5;
        var cwL = Math.max(grpStart, viewStart);
        var cwR = Math.min(grpEnd,   st.viewEndConcat);
        var cwx = (cwL - viewStart) / viewDur * laneW - CAP_WRAP_PAD_PX;
        var cww = (cwR - cwL)       / viewDur * laneW + CAP_WRAP_PAD_PX * 2;
        if (cww >= 2) {
          html.push(
            '<div class="edit-popup-cap-wrap active' +
            '" style="left:' + cwx.toFixed(1) + 'px; width:' + cww.toFixed(1) + 'px;"></div>'
          );
        }
      }

      for (var wi = 0; wi < ws.length; wi++) {
        var w = ws[wi];
        if (w.endConcat   <= viewStart) continue;
        if (w.startConcat >= st.viewEndConcat) break;
        var x  = (w.startConcat - viewStart) / viewDur * laneW;
        var ww = Math.max(6, (w.endConcat - w.startConcat) / viewDur * laneW);
        var isActive = (ci === activeCapIdx);
        var isSel = !!(st.selectedWord && st.selectedWord.capIdx === ci && st.selectedWord.wordIdx === wi);
        // Visual: pair wrap - only when this word has trailing silence
        // before the next word in the same caption. Frames (word + tail)
        // as a single visual unit. Cosmetic; mechanics unchanged.
        var pNext = ws[wi + 1];
        if (pNext && pNext.startConcat > w.endConcat) {
          var pwL = Math.max(w.startConcat,   viewStart);
          var pwR = Math.min(pNext.startConcat, st.viewEndConcat);
          if (pwR > pwL) {
            var pwx = (pwL - viewStart) / viewDur * laneW;
            var pww = (pwR - pwL)       / viewDur * laneW;
            if (pww >= 4) {
              var pwCls = 'edit-popup-pair-wrap' + (isActive ? '' : ' inactive');
              html.push(
                '<div class="' + pwCls +
                '" style="left:' + pwx.toFixed(1) + 'px; width:' + pww.toFixed(1) + 'px;"></div>'
              );
            }
          }
        }
        // Below 30px the inline flex-row handle layout has no room for
        // both handles + readable text. We tag the word with `.narrow`
        // and switch handle layout to absolute-positioned with negative
        // offsets - invisible by default, revealed when the word is
        // .selected (so picking a tiny word always gives the user a
        // grippable resize affordance). Non-selected narrow words rely
        // on the mousedown edge-snap zone for resize.
        var isNarrow = (ww < 30);
        var cls   = 'edit-popup-word'
                  + (isActive ? '' : ' inactive')
                  + (isSel    ? ' selected' : '')
                  + (isNarrow ? ' narrow'   : '');
        var text  = _escHtml(w.text);
        var inner =
          '<div class="edit-popup-word-handle handle-left"  data-handle="left"></div>' +
          '<span class="edit-popup-word-text" data-text>' + text + '</span>' +
          '<div class="edit-popup-word-handle handle-right" data-handle="right"></div>';
        html.push(
          '<div class="' + cls + '" data-cap-idx="' + ci + '" data-w-idx="' + wi +
          '" style="left:' + x.toFixed(1) + 'px; width:' + ww.toFixed(1) + 'px;"' +
          ' title="' + text + '">' + inner + '</div>'
        );

        // Gap "tail" - the silence between this word and the next within
        // the same caption is rendered as the current word's PNG by the M4
        // renderer (words tile to the next word's start). Draw a faint
        // gradient extending into the gap so the user can see that the
        // previous word "owns" that silence on the final timeline.
        var nextW = ws[wi + 1];
        if (nextW && nextW.startConcat > w.endConcat) {
          var tailStart = w.endConcat;
          var tailEnd   = nextW.startConcat;
          if (tailEnd > viewStart && tailStart < st.viewEndConcat) {
            var tailX = (Math.max(tailStart, viewStart) - viewStart) / viewDur * laneW;
            var tailW = (Math.min(tailEnd, st.viewEndConcat) - Math.max(tailStart, viewStart)) / viewDur * laneW;
            if (tailW >= 1) {
              var tailCls = 'edit-popup-word-tail' + (isActive ? '' : ' inactive');
              html.push(
                '<div class="' + tailCls +
                '" style="left:' + tailX.toFixed(1) + 'px; width:' + tailW.toFixed(1) + 'px;"></div>'
              );
            }
          }
        }
      }
    }

    // Visual: standalone "+" between consecutive captions. Marks unowned
    // silence between caption boundaries, styled the same as the in-caption
    // tail "+" so the lane reads consistently. Cosmetic only - no click,
    // no data change. Hidden when the gap on screen is too narrow to fit
    // the glyph cleanly.
    var GAP_PLUS_MIN_PX = 16;
    for (var gpi = 0; gpi < st.workingCaptions.length - 1; gpi++) {
      var gThis = st.workingCaptions[gpi];
      var gNext = st.workingCaptions[gpi + 1];
      if (!gThis.words.length || !gNext.words.length) continue;
      var gStart = gThis.words[gThis.words.length - 1].endConcat;
      var gEnd   = gNext.words[0].startConcat;
      if (gEnd <= gStart) continue;
      var gMid = (gStart + gEnd) / 2;
      if (gMid < viewStart || gMid > st.viewEndConcat) continue;
      var gWpx = (gEnd - gStart) / viewDur * laneW;
      if (gWpx < GAP_PLUS_MIN_PX) continue;
      var gx2 = (gMid - viewStart) / viewDur * laneW;
      html.push(
        '<div class="edit-popup-cap-gap-plus" style="left:' + gx2.toFixed(1) + 'px;"></div>'
      );
    }

    // Empty-space slots - only inside the ACTIVE caption. Slots add a
    // word to whichever caption is currently "live". Hidden when the
    // gap on screen is <28px (the affordance reads as noise otherwise).
    var SLOT_MIN_PX = 28;
    if (activeCapIdx != null) {
      var active = st.workingCaptions[activeCapIdx].words;
      if (active.length) {
        var prevCap = st.workingCaptions[activeCapIdx - 1];
        var nextCap = st.workingCaptions[activeCapIdx + 1];
        var insertMin = (prevCap && prevCap.words.length) ? prevCap.words[prevCap.words.length - 1].endConcat : 0;
        var insertMax = (nextCap && nextCap.words.length)
          ? nextCap.words[0].startConcat
          : (st.audioDuration || (active[active.length - 1].endConcat + 30));

        var slots = [];
        slots.push({ wi: 0, start: insertMin, end: active[0].startConcat });
        for (var k = 0; k < active.length - 1; k++) {
          slots.push({ wi: k + 1, start: active[k].endConcat, end: active[k + 1].startConcat });
        }
        slots.push({ wi: active.length, start: active[active.length - 1].endConcat, end: insertMax });

        for (var si = 0; si < slots.length; si++) {
          var s = slots[si];
          if (s.end <= s.start) continue;
          var clipStart = Math.max(s.start, viewStart);
          var clipEnd   = Math.min(s.end,   st.viewEndConcat);
          if (clipEnd <= clipStart) continue;
          var sx = (clipStart - viewStart) / viewDur * laneW;
          var sw = (clipEnd   - clipStart) / viewDur * laneW;
          if (sw < SLOT_MIN_PX) continue;
          html.push(
            '<div class="edit-popup-add-slot" data-cap-idx="' + activeCapIdx +
            '" data-slot-idx="' + s.wi +
            '" data-slot-start="' + s.start + '" data-slot-end="' + s.end +
            '" style="left:' + sx.toFixed(1) + 'px; width:' + sw.toFixed(1) +
            'px;" title="Insert word"></div>'
          );
        }

        // Line-break drag handles: one per existing line break in the
        // active caption. Hidden when the caption is single-line.
        var lb = (st.workingCaptions[activeCapIdx].lineBreaks || [])
          .slice().sort(function (a, b) { return a - b; });
        for (var lbi = 0; lbi < lb.length; lbi++) {
          var bIdx = lb[lbi];
          if (bIdx <= 0 || bIdx >= active.length) continue;
          var rightW = active[bIdx];
          // Position at the START of the word that begins the new line.
          // Reads as "this word starts the new line" instead of floating
          // in the middle of a wide silence between two words.
          var bT = rightW.startConcat;
          if (bT < viewStart || bT > st.viewEndConcat) continue;
          var bx = (bT - viewStart) / viewDur * laneW;
          html.push(
            '<div class="edit-popup-linebreak" data-lb-idx="' + lbi +
            '" style="left:' + bx.toFixed(1) + 'px;" title="Drag to move line break"></div>'
          );
        }
      }
    }
    _editWordLane.innerHTML = html.join('');
    if (typeof _editDrawM4Preview === 'function') _editDrawM4Preview();
    // Re-position the floating word-action bar: the selected word's
    // DOM node was just replaced and its x/width may have changed.
    if (typeof _editUpdateWordActionButtons === 'function') _editUpdateWordActionButtons();
    // Update the zoom scrollbar thumb to match the new view window.
    // Centralized here so every view-state mutation (zoom slider, auto
    // pan, manual pan, nav buttons, undo/redo, etc.) keeps the thumb
    // in sync without each caller having to remember to call it.
    if (typeof _editLayoutScrollbar === 'function') _editLayoutScrollbar();
  }

  // Pick a sensible initial zoom slider value so the active caption
  // occupies ~65% of the visible width. Used only on first open per
  // caption; nav between captions preserves whatever the user picked.
  // Inverse of: secondsVisible = 30 * 2^-(slider-1)
  function _editComputeDefaultZoom(capDur) {
    var target = Math.max(0.6, capDur / 0.65);
    var slider = 1 + Math.log(30 / target) / Math.log(2);
    if (slider < 1) slider = 1;
    if (slider > 8) slider = 8;
    return slider;
  }

  // Recompute the view window from the zoom slider. Centered on
  // `st.centerConcat` - set by _openCaptionEditor (focus caption) and
  // by _editNavStep (jumped caption). Clamps to audio bounds.
  function _editRecomputeView() {
    if (!_editState) return;
    var st = _editState;
    var slider = parseFloat(_editZoomEl.value) || 4;
    var secondsVisible = Math.max(0.2, 30 * Math.pow(2, -(slider - 1)));
    var half = secondsVisible / 2;
    var vs = st.centerConcat - half;
    var ve = st.centerConcat + half;
    var maxEnd = (_editAudioEl && _editAudioEl.duration) || st.audioDuration || (ve + 1);
    if (vs < 0)      { ve += -vs; vs = 0; }
    if (ve > maxEnd) { vs = Math.max(0, vs - (ve - maxEnd)); ve = maxEnd; }
    st.viewStartConcat = vs;
    st.viewEndConcat   = ve;
    st.laneWidthPx     = _editLaneWidth();
  }

  // Lightweight debounce so dragging the zoom slider doesn't fire 30
  // peak requests/sec. The waveform re-layout (CSS-positioned words)
  // is cheap and happens immediately; only the network call is debounced.
  var _editPeaksDebounce = null;
  function _editApplyZoom() {
    if (!_editState) return;
    var st = _editState;
    // Premiere-style zoom: the playhead's on-screen fraction stays
    // fixed across zoom changes. Playhead in the middle -> stays in the
    // middle; playhead near the right edge -> zoom-in converges there.
    // When the playhead is currently off-screen (because the user
    // panned away), the fraction is clamped to 0 or 1, so zoom-in
    // converges to whichever edge of the view the playhead lies past.
    var concatT = _editAudioEl ? _editAudioEl.currentTime : st.centerConcat;
    var oldDur  = st.viewEndConcat - st.viewStartConcat;
    var fraction = oldDur > 0 ? (concatT - st.viewStartConcat) / oldDur : 0.5;
    if (fraction < 0) fraction = 0;
    if (fraction > 1) fraction = 1;
    var slider = parseFloat(_editZoomEl.value) || 4;
    var newDur = Math.max(0.2, 30 * Math.pow(2, -(slider - 1)));
    // Setting centerConcat such that
    //   viewStart = center - newDur/2
    //   = concatT - fraction * newDur
    // keeps the playhead at the same screen fraction. Near the audio's
    // edges the clamp inside _editRecomputeView shifts the actual view,
    // which is unavoidable and matches Premiere's behavior near the
    // sequence start/end.
    st.centerConcat = concatT + (0.5 - fraction) * newDur;
    _editRecomputeView();
    _layoutEditWordLane();
    _drawEditWaveform(st.peaks);
    if (_editPlayheadEl) _editPlayheadEl.style.left = _editPlayheadX(concatT) + 'px';
    if (_editPeaksDebounce) clearTimeout(_editPeaksDebounce);
    _editPeaksDebounce = setTimeout(_editFetchPeaks, 120);
  }

  // Throttled wrapper for _editFetchPeaks. Used during continuous pan
  // (auto-pan + manual pan) so the waveform updates roughly every 200ms
  // instead of being frozen until release. The token mechanism inside
  // _editFetchPeaks discards out-of-order responses.
  var _editPeaksLastFetch = 0;
  function _editFetchPeaksThrottled() {
    var now = Date.now();
    if (now - _editPeaksLastFetch < 200) return;
    _editPeaksLastFetch = now;
    _editFetchPeaks();
  }

  // Re-fetch peaks for the current view window. Uses a token so a stale
  // response can't overwrite a newer view's peaks.
  function _editFetchPeaks() {
    if (!_editState) return;
    var st = _editState;
    var myToken = ++_editPeaksToken;
    FFmpegAPI.waveform(_captionWavPath, 600, {
      startSec: st.viewStartConcat,
      endSec:   st.viewEndConcat
    }).then(function (res) {
      if (!_editState || myToken !== _editPeaksToken) return;
      _editState.peaks = res.peaks || [];
      _drawEditWaveform(_editState.peaks);
    }).catch(function (err) {
      console.warn('[Edit] waveform fetch failed:', err && err.message);
    });
  }

  // Returns the playhead's current left offset (CSS px from the timeline's
  // left edge) given the audio's currentTime and the current view window.
  // Intentionally NOT clamped to [0, laneW] - when the user pans the view
  // away from the playhead, we want the playhead to slide naturally off
  // the visible area (timeline has overflow:hidden) instead of sticking
  // to whichever edge it would otherwise pass.
  function _editPlayheadX(concatT) {
    if (!_editState) return 0;
    var st = _editState;
    var viewDur = st.viewEndConcat - st.viewStartConcat;
    if (viewDur <= 0) return 0;
    // Playhead is inside .edit-popup-timeline-inner, which already sits
    // at the timeline's content area, so positions are inner-relative
    // (no need to add the timeline's padding offset).
    return (concatT - st.viewStartConcat) / viewDur * st.laneWidthPx;
  }

  // ── Zoom scrollbar ──────────────────────────────────────────────────
  // Premiere-style: a horizontal track at the bottom of the timeline
  // container, with a thumb whose width and position represent the
  // current view window relative to the full audio duration. Two side
  // handles resize the thumb (= zoom); the middle grip pans it. The
  // scrollbar writes directly to st.viewStartConcat / viewEndConcat,
  // bypassing _editRecomputeView so it does not have to round-trip
  // through the zoom-slider's seconds-visible formula. After every
  // change it nudges the zoom slider's value back into sync via the
  // inverse formula so the two controls stay coherent.

  // Scrollbar's data floor = the zoom slider's max-zoom step
  // (slider value 8 -> secondsVisible = 30 * 2^-(8-1) ≈ 0.234s).
  // Dragging a handle until it can't move further lands the view at
  // the SAME duration the slider's right-most stop produces - so
  // the visual minimum of the scrollbar coincides with the maximum
  // zoom level the controls can reach.
  var EDIT_SB_MIN_DUR_S = 30 * Math.pow(2, -(8 - 1));

  function _editSbAudioDuration() {
    if (!_editState) return 0;
    return _editState.audioDuration
        || (_editAudioEl && _editAudioEl.duration)
        || 0;
  }

  // Push the current viewStart/viewEnd back into the zoom slider.
  // Inverse of: secondsVisible = 30 * 2^-(slider-1)
  //   slider = 1 + log2(30 / secondsVisible)
  // Clamped to the slider's [1, 8] range. Silent - does NOT fire the
  // input event, since the scrollbar handler already performed the
  // redraw work an `input` listener would do.
  function _editSyncZoomSliderFromView() {
    if (!_editState || !_editZoomEl) return;
    var dur = _editState.viewEndConcat - _editState.viewStartConcat;
    if (dur <= 0) return;
    var slider = 1 + Math.log(30 / dur) / Math.log(2);
    if (slider < 1) slider = 1;
    if (slider > 8) slider = 8;
    _editZoomEl.value = String(slider);
  }

  // Visual minimum thumb width in pixels. The affine mapping below
  // stretches the linear width formula so it hits this floor exactly
  // when viewDur = EDIT_SB_MIN_DUR_S (= slider's max zoom). So the
  // visual minimum and max zoom coincide - drag the handle until the
  // thumb is 50px wide and the view is at max zoom, simultaneously.
  var EDIT_SB_MIN_THUMB_PX = 50;

  // Slope of the scrollbar's affine axis. visual_x = data * a + offset,
  // shared between position (visualLeft = vs * a) and width (visualWidth
  // = viewDur * a + c). Returns 0 if the audio is shorter than the max
  // zoom step or the scrollbar is too narrow - drag handlers treat 0
  // as "ignore the mousedown".
  function _editSbSlope() {
    var total = _editSbAudioDuration();
    if (total <= EDIT_SB_MIN_DUR_S) return 0;
    if (!_editScrollbarEl) return 0;
    var sbW = _editScrollbarEl.getBoundingClientRect().width;
    if (sbW <= EDIT_SB_MIN_THUMB_PX) return 0;
    return (sbW - EDIT_SB_MIN_THUMB_PX) / (total - EDIT_SB_MIN_DUR_S);
  }

  function _editLayoutScrollbar() {
    if (!_editState || !_editScrollbarEl || !_editScrollbarThumbEl) return;
    var total = _editSbAudioDuration();
    if (total <= 0) {
      _editScrollbarThumbEl.style.left  = '0%';
      _editScrollbarThumbEl.style.width = '100%';
      return;
    }
    var vs = Math.max(0, _editState.viewStartConcat);
    var ve = Math.min(total, _editState.viewEndConcat);
    var viewDur = Math.max(0, ve - vs);
    var a = _editSbSlope();
    if (a <= 0) {
      // Pathological audio/scrollbar dimensions - show a centered floor
      // pill so the control is still visible.
      _editScrollbarThumbEl.style.left  = '0%';
      _editScrollbarThumbEl.style.width = EDIT_SB_MIN_THUMB_PX + 'px';
      return;
    }
    // Affine mapping pinned at the two endpoints:
    //   viewDur = total   -> visual width = sbW
    //   viewDur = MIN_DUR -> visual width = MIN_PX
    // Decoupling falls out of the algebra: visualRight = ve*a + c
    // depends only on ve, visualLeft = vs*a only on vs. So dragging one
    // handle moves that side and only that side.
    var c = EDIT_SB_MIN_THUMB_PX - EDIT_SB_MIN_DUR_S * a;
    var visualLeftPx  = vs * a;
    var visualWidthPx = viewDur * a + c;
    _editScrollbarThumbEl.style.left  = visualLeftPx.toFixed(2)  + 'px';
    _editScrollbarThumbEl.style.width = visualWidthPx.toFixed(2) + 'px';
  }

  // After a scrollbar drag changes the view: redraw the lane, ruler,
  // and waveform (cached peaks for an immediate frame, then a fresh
  // fetch throttled so a 30-fps drag doesn't storm the peaks endpoint).
  // Also re-position the playhead and sync the zoom slider.
  function _editRedrawForScrollbar() {
    if (!_editState) return;
    _editState.laneWidthPx = _editLaneWidth();
    _layoutEditWordLane();
    _drawEditRuler();
    _drawEditWaveform(_editState.peaks);
    if (_editPlayheadEl && _editAudioEl) {
      _editPlayheadEl.style.left =
        _editPlayheadX(_editAudioEl.currentTime) + 'px';
    }
    _editLayoutScrollbar();
    _editSyncZoomSliderFromView();
    _editFetchPeaksThrottled();
  }

  function _editAttachScrollbar() {
    if (!_editScrollbarEl) return;

    // Slope of the same affine axis _editLayoutScrollbar draws on:
    // visual_x = data * a + offset. Mouse moving 1px corresponds to
    // (1/a) seconds of view change -> so the visual handle follows
    // the mouse 1:1 in pixels regardless of zoom level. Using a plain
    // sbW/total here would desync the visual from the data once the
    // affine layout starts inflating widths by the offset c.
    function trackPxPerSec() {
      return _editSbSlope();
    }

    _editScrollbarEl.addEventListener('mousedown', function (e) {
      if (!_editState) return;
      var total = _editSbAudioDuration();
      if (total <= 0) return;

      // ALWAYS stop propagation so the scrollbar's clicks/drags never
      // bubble to the timeline's click/mousedown handlers (which would
      // otherwise seek the playhead on every scrollbar interaction).
      // preventDefault suppresses text selection from starting on the
      // mousedown.
      e.preventDefault();
      e.stopPropagation();

      var handleEl = e.target.closest('[data-sb-handle]');
      var thumbEl  = e.target.closest('.edit-popup-scrollbar-thumb');
      var pxPerSec = trackPxPerSec();
      if (pxPerSec <= 0) return;

      var origVS = _editState.viewStartConcat;
      var origVE = _editState.viewEndConcat;
      var startX = e.clientX;

      // Click on the track outside the thumb -> jump-center the thumb
      // on that point, then return (no drag). Maps via the same affine
      // axis the layout uses, so the thumb lands exactly under the
      // click. Pixel-on-scrollbar = vs * a + offset -> invert for vs.
      if (!handleEl && !thumbEl) {
        var sbRect  = _editScrollbarEl.getBoundingClientRect();
        var clickPx = e.clientX - sbRect.left;
        var dur     = origVE - origVS;
        // visual center under the click point: clickPx = (vs + dur/2)*a + c/2_approx.
        // Invert by isolating vs around the click as the new center.
        var clickT  = clickPx / pxPerSec;
        var newStart = Math.max(0, Math.min(total - dur, clickT - dur / 2));
        _editState.viewStartConcat = newStart;
        _editState.viewEndConcat   = newStart + dur;
        _editRedrawForScrollbar();
        return;
      }

      _editScrollbarThumbEl.classList.add('is-dragging');

      // The thumb's CSS min-width (36px) keeps both handles plus a
      // grip clickable at every zoom level, so handle-resize works
      // even at max zoom-in. This 16px safety threshold only kicks
      // in if something pathological shrinks the thumb below where
      // the handles can be told apart - in that case, route every
      // thumb click to pan instead of resize.
      var SMALL_THUMB_PX = 16;
      var thumbW = _editScrollbarThumbEl.getBoundingClientRect().width;
      var mode;
      if (handleEl && thumbW >= SMALL_THUMB_PX) {
        mode = handleEl.getAttribute('data-sb-handle') === 'left'
             ? 'resize-left' : 'resize-right';
      } else {
        mode = 'pan';
      }

      function onMove(ev) {
        var dxSec = (ev.clientX - startX) / pxPerSec;
        var vs = origVS, ve = origVE;

        if (mode === 'pan') {
          var dur = origVE - origVS;
          vs = Math.max(0, Math.min(total - dur, origVS + dxSec));
          ve = vs + dur;
        } else if (mode === 'resize-left') {
          // Drag left handle: viewStart moves, viewEnd stays. Clamp so
          // viewStart can't cross within MIN of viewEnd. MIN equals
          // the slider's max-zoom step, so dragging to the limit lands
          // the view at max zoom - same as pushing the slider to 8.
          vs = Math.max(0, Math.min(origVE - EDIT_SB_MIN_DUR_S, origVS + dxSec));
          ve = origVE;
        } else { // resize-right
          ve = Math.min(total, Math.max(origVS + EDIT_SB_MIN_DUR_S, origVE + dxSec));
          vs = origVS;
        }

        if (vs === _editState.viewStartConcat &&
            ve === _editState.viewEndConcat) return;
        _editState.viewStartConcat = vs;
        _editState.viewEndConcat   = ve;
        _editRedrawForScrollbar();
      }

      function onUp() {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup',   onUp);
        _editScrollbarThumbEl.classList.remove('is-dragging');
        // Final unthrottled peaks fetch so the released view ends on
        // crisp peaks regardless of where the throttle landed.
        _editFetchPeaks();
      }

      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup',   onUp);
    });
  }

  function _editTick() {
    _editRafId = null;
    if (!_editState || !_editAudioEl) return;
    var concatT = _editAudioEl.currentTime;
    var st = _editState;

    // Auto-shift view if the playhead is about to exit the right edge so
    // playback stays visible. We pan by 80% of the view duration so there's
    // a clear "we moved" beat instead of a continuous tracking blur.
    var viewDur = st.viewEndConcat - st.viewStartConcat;
    if (concatT > st.viewEndConcat - viewDur * 0.05) {
      var maxEnd   = (_editAudioEl.duration || (st.viewEndConcat + viewDur));
      var newStart = Math.min(st.viewStartConcat + viewDur * 0.8, maxEnd - viewDur);
      // Only run the (expensive) layout + peaks fetch if the shift actually
      // moves the window. Without this guard we hit the audio's end, the
      // clamp pins viewStartConcat at its max, the condition stays true
      // every subsequent frame, and we storm the server with peak requests
      // + replace the word-lane DOM 60x/sec - the panel freezes.
      if (newStart > st.viewStartConcat + 0.001) {
        st.viewStartConcat = newStart;
        st.viewEndConcat   = newStart + viewDur;
        _layoutEditWordLane();
        _editFetchPeaksThrottled();
      }
    }

    _editPlayheadEl.style.left = _editPlayheadX(concatT) + 'px';
    // Drive the M4 preview from the playhead so the user sees the
    // final render shape (pre/cur/post styling, current word jumping)
    // in sync with playback.
    _editDrawM4Preview();

    // Time readout: absolute time within the audio file.
    _editTimeEl.textContent = _fmtMs(concatT) + ' / ' + _fmtMs(st.audioDuration || 0);

    // Re-layout periodically so the active-caption highlight follows
    // the playhead across caption boundaries during playback. We only
    // do this when the EFFECTIVE active caption actually changes - with
    // a word selected, the selection wins over the playhead, so this
    // check stays stable while the playhead drifts inside another caption.
    var newActive = _editEffectiveActiveCapIdx(concatT);
    if (newActive !== st._lastActiveCap) {
      st._lastActiveCap = newActive;
      _layoutEditWordLane();
    }

    // Keep ticking until the audio element itself stops (user-paused
    // or natural end). Previously this auto-paused at the end of the
    // *next* caption - felt like a freeze to the user because playback
    // only ran for ~1s and then halted with no obvious cause. The
    // browser fires 'ended' / 'pause' on the audio element which our
    // listener (set up in _openCaptionEditor) handles cleanly.
    if (!_editAudioEl.paused) _editRafId = requestAnimationFrame(_editTick);
  }

  function _editStartTick() {
    if (_editRafId) cancelAnimationFrame(_editRafId);
    _editRafId = requestAnimationFrame(_editTick);
  }

  // Inline SVG for the play/pause icon swap - sharper than unicode and
  // immune to font-fallback rendering oddities that were stretching the
  // round button vertically.
  var _PLAY_GLYPH = (
    '<svg width="12" height="14" viewBox="0 0 12 14" fill="currentColor" ' +
    'style="margin-left:2px">' +
    '<path d="M1 1l10 6-10 6z"/></svg>'
  );
  var _PAUSE_GLYPH = (
    '<svg width="12" height="14" viewBox="0 0 12 14" fill="currentColor">' +
    '<rect x="1"  y="1" width="3.5" height="12" rx="0.7"/>' +
    '<rect x="7.5" y="1" width="3.5" height="12" rx="0.7"/></svg>'
  );

  // Push the current _editSpeed onto the audio element and the
  // dropdown's displayed value. Safe to call before either exists
  // (no-op on the missing side) so it can run from open/load paths.
  function _editApplySpeed() {
    if (_editAudioEl) {
      // preservesPitch is the standard property; some Safari versions
      // need the webkit prefix. Best-effort either way.
      try { _editAudioEl.preservesPitch = true; } catch (_) {}
      try { _editAudioEl.webkitPreservesPitch = true; } catch (_) {}
      _editAudioEl.playbackRate = _editSpeed;
    }
    if (_editSpeedEl) {
      _editSpeedEl.value = String(_editSpeed);
      _editSpeedEl.classList.toggle('is-active', _editSpeed !== 1.0);
    }
  }

  function _editOnSpeedChange() {
    if (!_editSpeedEl) return;
    var v = parseFloat(_editSpeedEl.value);
    if (!isFinite(v) || v <= 0) v = 1.0;
    _editSpeed = v;
    _editApplySpeed();
  }

  function _editTogglePlay() {
    if (!_editState || !_editAudioEl) return;
    if (_editAudioEl.paused) {
      // If the user zoomed/panned the playhead off-screen, hitting Play
      // is the explicit "snap the view back to my playhead" gesture.
      // We re-center on the audio's current time (don't move the audio
      // to the view's center - that surprised the user before).
      var ct = _editAudioEl.currentTime;
      var inside = ct >= _editState.viewStartConcat && ct < _editState.viewEndConcat;
      if (!inside) {
        _editState.centerConcat = ct;
        _editRecomputeView();
        _layoutEditWordLane();
        _drawEditWaveform(_editState.peaks);
        _editFetchPeaks();
        if (_editPlayheadEl) _editPlayheadEl.style.left = _editPlayheadX(ct) + 'px';
      }
      var p = _editAudioEl.play();
      if (p && p.catch) p.catch(function () {});
      _editPlayBtn.innerHTML = _PAUSE_GLYPH;
      _editStartTick();
    } else {
      _editAudioEl.pause();
      _editPlayBtn.innerHTML = _PLAY_GLYPH;
    }
  }

  // Closes the popup. Edits commit live, so there's nothing to discard
  // and no prompt - close just tears down audio + clears state.
  function _editClose() {
    if (!_editPopupEl) return;
    if (_editAudioEl) { try { _editAudioEl.pause(); } catch (_) {} _editAudioEl = null; }
    if (_editRafId)   { cancelAnimationFrame(_editRafId); _editRafId = null; }
    _editPopupEl.classList.add('hidden');
    _editState = null;
  }

  // Convert a clientX into a concat-time within the visible view window.
  // Used by click-to-seek and the playhead drag handler.
  function _editClientXToConcatT(clientX) {
    if (!_editState) return 0;
    var rect = _editTimelineEl.getBoundingClientRect();
    var padL = _editLanePadLeft();
    var xInside = clientX - rect.left - padL;
    xInside = Math.max(0, Math.min(_editState.laneWidthPx, xInside));
    var viewDur = _editState.viewEndConcat - _editState.viewStartConcat;
    return _editState.viewStartConcat + (xInside / _editState.laneWidthPx) * viewDur;
  }
  function _editSeekToConcatT(concatT, syncPlayhead) {
    if (!_editState || !_editAudioEl) return;
    _editAudioEl.currentTime = Math.max(0, concatT);
    if (syncPlayhead) {
      _editPlayheadEl.style.left = _editPlayheadX(concatT) + 'px';
    }
    // Show absolute playback time / total audio duration. Per-caption
    // numbers no longer apply since we edit all captions together.
    _editTimeEl.textContent = _fmtMs(concatT) + ' / ' + _fmtMs(_editState.audioDuration || 0);
    _editUpdateNavDisabled();
    _editDrawM4Preview();
    // Re-layout when the EFFECTIVE active caption changes so the
    // visual highlight follows the playhead during scrubbing too. When
    // a word is selected, this stays pinned to the selection's caption
    // and the playhead can drift through other captions without
    // disturbing the active highlight.
    var newActive = _editEffectiveActiveCapIdx(concatT);
    if (newActive !== _editState._lastActiveCap) {
      _editState._lastActiveCap = newActive;
      _layoutEditWordLane();
    }
  }

  function _editWireOnce() {
    if (_editPopupEl._wired) return;
    _editPopupEl._wired = true;
    // Close / Cancel both just hide the popup - edits already commit live.
    document.getElementById('ac-edit-close') .addEventListener('click', _editClose);
    document.getElementById('ac-edit-cancel').addEventListener('click', _editClose);
    // Undo / redo buttons in the toolbar.
    var _undoBtn = document.getElementById('ac-edit-undo');
    var _redoBtn = document.getElementById('ac-edit-redo');
    if (_undoBtn) _undoBtn.addEventListener('click', _editUndo);
    if (_redoBtn) _redoBtn.addEventListener('click', _editRedo);

    // Word actions - same semantics as the captions-page word-edit-bar.
    var _wordUp    = document.getElementById('ac-edit-word-up');
    var _wordDown  = document.getElementById('ac-edit-word-down');
    var _wordSplit = document.getElementById('ac-edit-word-split');
    if (_wordUp)    _wordUp   .addEventListener('click', _editWordUp);
    if (_wordDown)  _wordDown .addEventListener('click', _editWordDown);
    if (_wordSplit) _wordSplit.addEventListener('click', _editWordSplit);

    // Lines / Chars / Gap steppers - same logic as the captions-page
    // postgen bar. Every click regroups in-place: we sync any pending
    // edits to generatedCaptions, run the existing regroup pipeline,
    // and rebuild workingCaptions from the new caption structure.
    function _bindStepper(decId, incId, displayId, delta, getter, setter) {
      var dec = document.getElementById(decId);
      var inc = document.getElementById(incId);
      var disp = document.getElementById(displayId);
      if (!dec || !inc) return;
      // Reflect current setting into the popup's display
      if (disp) disp.textContent = getter();
      dec.addEventListener('click', function () {
        setter(-delta);
        if (disp) disp.textContent = getter();
        _editApplyGroupingChange();
      });
      inc.addEventListener('click', function () {
        setter(+delta);
        if (disp) disp.textContent = getter();
        _editApplyGroupingChange();
      });
    }
    _bindStepper('ac-edit-lines-dec', 'ac-edit-lines-inc', 'ac-edit-lines-display',
      1,
      function () { return _getCurrentLines(); },
      function (d) { _setLines(_getCurrentLines() + d); }
    );
    _bindStepper('ac-edit-chars-dec', 'ac-edit-chars-inc', 'ac-edit-chars-display',
      5,
      function () { return _getCurrentChars(); },
      function (d) { _setChars(_getCurrentChars() + d); }
    );
    // Gap: original setter takes an absolute value; we delta the slider.
    var gapDecBtn2 = document.getElementById('ac-edit-gap-dec');
    var gapIncBtn2 = document.getElementById('ac-edit-gap-inc');
    var gapDispEd  = document.getElementById('ac-edit-gap-display');
    function _editGapValue() {
      var sl = document.getElementById('ac-gap');
      return sl ? parseFloat(sl.value) || 0.2 : 0.2;
    }
    function _editStepGap(d) {
      var v = Math.max(0.1, Math.min(3.0, Math.round((_editGapValue() + d) * 10) / 10));
      var sl = document.getElementById('ac-gap');
      if (sl) sl.value = v;
      var mainDisp = document.getElementById('ac-gap-display');
      if (mainDisp) mainDisp.textContent = v.toFixed(1) + 's';
      if (gapDispEd) gapDispEd.textContent = v.toFixed(1) + 's';
      try { localStorage.setItem('machicut_silence_gap', v); } catch (_) {}
      _editApplyGroupingChange();
    }
    if (gapDispEd) gapDispEd.textContent = _editGapValue().toFixed(1) + 's';
    if (gapDecBtn2) gapDecBtn2.addEventListener('click', function () { _editStepGap(-0.1); });
    if (gapIncBtn2) gapIncBtn2.addEventListener('click', function () { _editStepGap(+0.1); });

    // Gear button toggles the grouping popover. A document-level click
    // listener closes it when clicking outside; clicks inside the
    // popover or on the gear itself are absorbed.
    var _gearBtn   = document.getElementById('ac-edit-grouping-btn');
    var _gearPop   = document.getElementById('ac-edit-grouping-popover');
    function _editToggleGearPopover(force) {
      if (!_gearPop) return;
      var open = (force === true) ? true
               : (force === false) ? false
               : (_gearPop.style.display === 'none');
      _gearPop.style.display = open ? 'block' : 'none';
    }
    if (_gearBtn) _gearBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      _editToggleGearPopover();
    });
    if (_gearPop) _gearPop.addEventListener('mousedown', function (e) { e.stopPropagation(); });
    document.addEventListener('mousedown', function (e) {
      if (!_gearPop || _gearPop.style.display === 'none') return;
      if (e.target.closest('#ac-edit-grouping-popover')) return;
      if (e.target.closest('#ac-edit-grouping-btn')) return;
      _editToggleGearPopover(false);
    });
    // "Apply this caption" - patch only the focused cue into the last
    // Orbit styled apply. Falls back to full Apply styled when needed.
    document.getElementById('ac-edit-apply-one').addEventListener('click', function () {
      if (!_editState) return;
      var onlyIdx = (_editState.focusCaptionIdx != null)
        ? _editState.focusCaptionIdx
        : _editEffectiveActiveCapIdx(_editState.centerConcat);
      _editClose();
      var applyBtn = document.getElementById('ac-apply-model4-btn');
      if (!applyBtn || applyBtn.disabled) {
        _announceApply('error', 'Load captions and open Style before applying.');
        return;
      }
      _styledApplyOpts.onlyCaptionIndex = (onlyIdx == null || onlyIdx < 0) ? null : onlyIdx;
      applyBtn.click();
    });
    _editPlayBtn.addEventListener('click', _editTogglePlay);
    _editZoomEl.addEventListener('input', _editApplyZoom);
    _editAttachScrollbar();
    if (_editSpeedEl) {
      _editSpeedEl.addEventListener('change', _editOnSpeedChange);
    }
    document.addEventListener('keydown', _editKeydown);

    // Click anywhere on the timeline to seek. Clicks that land on an
    // active word select it; clicks on neighbor words / empty space just
    // seek. Playhead/nav/toolbar clicks are owned by their own handlers.
    _editTimelineEl.addEventListener('click', function (e) {
      if (!_editState || !_editAudioEl) return;
      var t = e.target;
      // Clicks inside a contenteditable text node belong to the browser
      // - they position the caret. Without this guard the click falls
      // through to the word-toggle path, schedules a 220ms selection
      // flip, which then re-renders the lane and tears the user out of
      // text-edit mode.
      if (t.isContentEditable || (t.closest && t.closest('[contenteditable="true"]'))) return;
      if (t.closest('.edit-popup-toolbar')) return;
      if (t.closest('.edit-popup-playhead')) return;
      if (t.closest('.edit-popup-nav-btn')) return;
      if (t.closest('.edit-popup-word-handle')) return; // owned by resize
      // Scrollbar owns its own click/drag -> don't seek the playhead when
      // the user clicks the scrollbar track or thumb. Without this guard
      // every scrollbar mouseup would bubble here and yank the playhead
      // to the scrollbar's x-position translated into wave time.
      if (t.closest('.edit-popup-scrollbar')) return;
      // Suppress click immediately after a resize drag - without this the
      // mouseup at the end of a drag fires a synthetic click that would
      // jump the playhead.
      if (_editJustDragged) { _editJustDragged = false; return; }
      // Slot click -> open inline input to add a new word in that gap
      var slotEl = t.closest('.edit-popup-add-slot');
      if (slotEl && !slotEl.classList.contains('editing')) {
        _editStartSlotInput(slotEl);
        return;
      }
      var wordEl = t.closest('.edit-popup-word');
      if (wordEl) {
        var ci = parseInt(wordEl.getAttribute('data-cap-idx'), 10);
        var wi = parseInt(wordEl.getAttribute('data-w-idx'),   10);
        // Defer so a dblclick (text edit) can cancel before the toggle
        // fires. Clicking the already-selected word deselects it; any
        // other word becomes the new selection and seeks to its start.
        if (_editClickTimer) clearTimeout(_editClickTimer);
        _editClickTimer = setTimeout(function () {
          _editClickTimer = null;
          if (!_editState) return;
          var sel = _editState.selectedWord;
          if (sel && sel.capIdx === ci && sel.wordIdx === wi) {
            _editSelectWord(null);
          } else {
            _editSelectWord(ci, wi);
            var w = _editState.workingCaptions[ci] && _editState.workingCaptions[ci].words[wi];
            if (w) _editSeekToConcatT(w.startConcat, true);
          }
        }, 220);
        return;
      }
      _editSelectWord(null);
      _editSeekToConcatT(_editClientXToConcatT(e.clientX), true);
    });

    // Double-click any word -> inline contenteditable text edit.
    // Cancels the pending single-click toggle so the user doesn't see
    // a deselect-then-reselect flash before edit mode kicks in.
    _editTimelineEl.addEventListener('dblclick', function (e) {
      if (!_editState) return;
      if (_editClickTimer) { clearTimeout(_editClickTimer); _editClickTimer = null; }
      var wordEl = e.target.closest('.edit-popup-word');
      if (!wordEl) return;
      var ci = parseInt(wordEl.getAttribute('data-cap-idx'), 10);
      var wi = parseInt(wordEl.getAttribute('data-w-idx'),   10);
      // The DOM was likely replaced between this dblclick's first
      // mousedown and now (the mousedown can trigger _editSelectWord,
      // which relayouts the entire word lane to refresh the active-
      // caption visuals). So `wordEl` may be a DETACHED node - its
      // text span exists in memory but isn't on screen, and
      // contenteditable on a detached node has no visible effect. Look
      // up the live element by data-attrs instead.
      var liveWordEl = _editWordLane && _editWordLane.querySelector(
        '.edit-popup-word[data-cap-idx="' + ci + '"][data-w-idx="' + wi + '"]'
      );
      if (!liveWordEl) return;
      var textEl = liveWordEl.querySelector('.edit-popup-word-text');
      if (!textEl) return;
      _editSelectWord(ci, wi);
      // _editSelectWord just rebuilt the lane AGAIN - re-resolve.
      var freshWordEl = _editWordLane.querySelector(
        '.edit-popup-word[data-cap-idx="' + ci + '"][data-w-idx="' + wi + '"]'
      );
      var freshTextEl = freshWordEl && freshWordEl.querySelector('.edit-popup-word-text');
      if (!freshTextEl) return;
      _editStartTextEdit(ci, wi, freshTextEl);
    });

    // Single mousedown router for everything that lives inside the timeline:
    //   • Resize handle on an active word    -> edge resize
    //   • Body of an active word             -> potential word-move drag
    //   • Slot (gap "+" affordance)          -> no-op here; click handler opens input
    //   • Waveform / word-lane empty space   -> potential timeline pan
    // The playhead's own head element has a separate mousedown listener
    // on _editPlayheadEl and is reached via event bubbling.
    _editTimelineEl.addEventListener('mousedown', function (e) {
      if (!_editState) return;
      // Skip if event came from chrome (toolbar / nav / playhead head)
      if (e.target.closest('.edit-popup-toolbar')) return;
      if (e.target.closest('.edit-popup-nav-btn')) return;
      // contenteditable text takes priority so the user can position the caret
      if (e.target.isContentEditable) return;

      // 1) Resize handle on any word
      var handle = e.target.closest('.edit-popup-word-handle');
      if (handle) {
        var wordEl = handle.parentNode;
        if (!wordEl) return;
        var ci   = parseInt(wordEl.getAttribute('data-cap-idx'), 10);
        var wi   = parseInt(wordEl.getAttribute('data-w-idx'),   10);
        var side = handle.getAttribute('data-handle');
        _editStartResize(ci, wi, side, e);
        return;
      }

      // 1b) Line-break drag handle on the active caption
      var lbEl = e.target.closest('.edit-popup-linebreak');
      if (lbEl) { _editStartLineBreakDrag(lbEl, e); return; }

      // 2) Slot -> defer to click handler (no drag semantics on a slot)
      if (e.target.closest('.edit-popup-add-slot')) return;

      // 3) Word body. Three sub-cases:
      //    a) Word is .narrow (no inline handle space): treat the click
      //       as a resize - left half = resize-left, right half =
      //       resize-right. The user doesn't have to select the word
      //       first to grab a missing handle.
      //    b) Word is wide BUT click landed within EDGE_SNAP_PX of an
      //       edge: also a resize. Covers near-miss clicks that landed
      //       just past the rendered 5px handle.
      //    c) Otherwise: word-move drag (click vs drag is disambiguated
      //       by the movement threshold inside the helper).
      var wordEl2 = e.target.closest('.edit-popup-word');
      if (wordEl2) {
        var ci2 = parseInt(wordEl2.getAttribute('data-cap-idx'), 10);
        var wi2 = parseInt(wordEl2.getAttribute('data-w-idx'),   10);
        var wrect = wordEl2.getBoundingClientRect();
        var offX  = e.clientX - wrect.left;
        if (wordEl2.classList.contains('narrow')) {
          _editStartResize(ci2, wi2,
            (offX < wrect.width / 2) ? 'left' : 'right', e);
          return;
        }
        var EDGE_SNAP_PX = 6;
        if (offX < EDGE_SNAP_PX) {
          _editStartResize(ci2, wi2, 'left',  e); return;
        }
        if (offX > wrect.width - EDGE_SNAP_PX) {
          _editStartResize(ci2, wi2, 'right', e); return;
        }
        _editStartWordMove(ci2, wi2, e);
        return;
      }

      // 4) Ruler / waveform / word-lane empty area -> potential
      //    timeline pan. The ruler counts as pan-area too so the user
      //    can drag from the time-label strip and not just the
      //    waveform; clicking a ruler tick should feel the same as
      //    clicking the waveform underneath it.
      if (e.target.closest('.edit-popup-timeline-ruler') ||
          e.target.closest('.edit-popup-waveform-wrap') ||
          e.target.closest('.edit-popup-word-lane') ||
          e.target === _editTimelineEl) {
        _editStartTimelinePan(e);
      }
    });

    // Playhead drag - grab the head and drag horizontally to scrub.
    // Auto-pauses playback during the drag and resumes if it was
    // playing when the drag started. While the mouse is past either
    // edge of the timeline, an rAF loop pans the view so the user
    // can keep dragging past the visible area.
    var dragState = null;
    var panAnimId = null;
    function _autoPanTick() {
      panAnimId = null;
      if (!dragState || !_editState || dragState.edgeDir === 0) return;
      var st = _editState;
      var viewDur = st.viewEndConcat - st.viewStartConcat;
      var maxEnd  = st.audioDuration || (st.viewEndConcat + viewDur);
      // Shift ~2% per frame - at 60fps that's a full view in ~0.8s.
      var step    = viewDur * 0.02 * dragState.edgeDir;
      var newStart = Math.max(0, Math.min(maxEnd - viewDur, st.viewStartConcat + step));
      if (newStart !== st.viewStartConcat) {
        st.viewStartConcat = newStart;
        st.viewEndConcat   = newStart + viewDur;
        dragState.didPan   = true;
        _layoutEditWordLane();
        _drawEditWaveform(st.peaks);
        // Fetch fresh peaks for the new window (throttled) so the
        // waveform doesn't lag behind during a long pan.
        _editFetchPeaksThrottled();
        // Drag the playhead/audio along to the edge we're pushing toward.
        var t = (dragState.edgeDir > 0) ? st.viewEndConcat - 0.01 : st.viewStartConcat;
        _editSeekToConcatT(t, true);
      }
      panAnimId = requestAnimationFrame(_autoPanTick);
    }
    _editPlayheadEl.addEventListener('mousedown', function (e) {
      if (!_editState || !_editAudioEl) return;
      e.preventDefault();
      e.stopPropagation();
      var wasPlaying = !_editAudioEl.paused;
      if (wasPlaying) _editAudioEl.pause();
      _editPlayheadEl.classList.add('dragging');
      _editTimelineEl.classList.add('dragging');
      dragState = { wasPlaying: wasPlaying, edgeDir: 0 };
      _editSeekToConcatT(_editClientXToConcatT(e.clientX), true);
    });
    document.addEventListener('mousemove', function (e) {
      if (!dragState) return;
      // Edge detection: if the mouse goes past the timeline content edges,
      // auto-pan the view (handled by the rAF loop). Otherwise just seek.
      var rect      = _editTimelineEl.getBoundingClientRect();
      var padL      = _editLanePadLeft();
      var leftEdge  = rect.left + padL;
      var rightEdge = rect.left + rect.width - padL;
      if (e.clientX > rightEdge) {
        dragState.edgeDir = 1;
        if (!panAnimId) panAnimId = requestAnimationFrame(_autoPanTick);
      } else if (e.clientX < leftEdge) {
        dragState.edgeDir = -1;
        if (!panAnimId) panAnimId = requestAnimationFrame(_autoPanTick);
      } else {
        dragState.edgeDir = 0;
        _editSeekToConcatT(_editClientXToConcatT(e.clientX), true);
      }
    });
    document.addEventListener('mouseup', function () {
      if (!dragState) return;
      _editPlayheadEl.classList.remove('dragging');
      _editTimelineEl.classList.remove('dragging');
      if (panAnimId) { cancelAnimationFrame(panAnimId); panAnimId = null; }
      // Final peak fetch if any panning happened - covers the case where
      // the user released while back inside the visible area (edgeDir = 0
      // at release moment) but the view had been shifted earlier.
      if (dragState.didPan) _editFetchPeaks();
      if (dragState.wasPlaying) {
        var p = _editAudioEl.play();
        if (p && p.catch) p.catch(function () {});
        _editPlayBtn.innerHTML = _PAUSE_GLYPH;
        _editStartTick();
      }
      dragState = null;
    });

    // Prev / Next caption nav - jump the playhead to the previous/next
    // caption's start. No state reload (the popup edits all captions).
    _editPrevBtn.addEventListener('click', function () { _editNavStep(-1); });
    _editNextBtn.addEventListener('click', function () { _editNavStep(+1); });

    // Keep the lane width / view in sync when the panel itself resizes
    // (the timeline width changes -> so does the per-pixel time scale).
    window.addEventListener('resize', function () {
      if (!_editState) return;
      _editState.laneWidthPx = _editLaneWidth();
      _layoutEditWordLane();
      _drawEditWaveform(_editState.peaks);
    });
  }

  // Nav now means "jump the playhead to the prev/next caption start".
  // No state reload - the popup edits all captions together; navigation
  // just moves the focus along the timeline. `dir` = -1 (prev) or +1 (next).
  function _editNavStep(dir) {
    if (!_editState || !_editAudioEl) return;
    var caps = _editState.workingCaptions;
    var concatT = _editAudioEl.currentTime;
    var target = null;
    if (dir > 0) {
      for (var i = 0; i < caps.length; i++) {
        if (caps[i].words.length && caps[i].words[0].startConcat > concatT + 0.05) {
          target = caps[i].words[0].startConcat;
          break;
        }
      }
    } else {
      for (var j = caps.length - 1; j >= 0; j--) {
        if (caps[j].words.length && caps[j].words[0].startConcat < concatT - 0.05) {
          target = caps[j].words[0].startConcat;
          break;
        }
      }
    }
    if (target == null) return;
    _editState.centerConcat = target;
    var jumped = _editActiveCapIdxAt(target);
    if (jumped != null) _editState.focusCaptionIdx = jumped;
    _editRecomputeView();
    _editSeekToConcatT(target, true);
    _layoutEditWordLane();
    _editFetchPeaks();
    _editUpdateNavDisabled();
  }
  function _editUpdateNavDisabled() {
    if (!_editState || !_editAudioEl) return;
    var caps = _editState.workingCaptions;
    var concatT = _editAudioEl.currentTime;
    var hasPrev = false, hasNext = false;
    for (var i = 0; i < caps.length; i++) {
      if (!caps[i].words.length) continue;
      var s = caps[i].words[0].startConcat;
      if (s < concatT - 0.05) hasPrev = true;
      if (s > concatT + 0.05) { hasNext = true; break; }
    }
    if (_editPrevBtn) _editPrevBtn.disabled = !hasPrev;
    if (_editNextBtn) _editNextBtn.disabled = !hasNext;
  }

  // Flag set during a resize drag so the mouseup-triggered click can be
  // ignored. Without this the playhead jumps to wherever you released
  // the resize, which is jarring.
  var _editJustDragged = false;
  // Click on a word is deferred ~220ms so the dblclick handler can
  // cancel it (otherwise dblclick -> text edit would also fire the
  // toggle-selection logic, briefly deselecting before the edit starts).
  var _editClickTimer = null;

  // Select a word by (capIdx, wordIdx). Pass null to deselect.
  // Toggles class in place so DOM identity survives between clicks
  // (otherwise dblclick wouldn't fire).
  function _editSelectWord(capIdx, wordIdx) {
    if (!_editState) return;
    _editState.selectedWord = (capIdx == null || wordIdx == null)
      ? null
      : { capIdx: capIdx, wordIdx: wordIdx };
    // Full relayout instead of an in-place class toggle: selection
    // changes which caption is "effective active", which in turn
    // changes the .inactive class on every word in the lane and the
    // visibility of slots / line-break handles. The cheap toggle was
    // fine when selection only flipped one node's .selected class -
    // it's not enough now that selection drives caption activeness.
    _layoutEditWordLane();
    if (typeof _editUpdateWordActionButtons === 'function') _editUpdateWordActionButtons();
  }

  // ── Undo / redo ───────────────────────────────────────────────────────────
  // Snapshot stack. Every edit operation runs through _editCommit, which
  // takes a deep copy of the relevant state BEFORE the change, pushes it
  // on undoStack, clears redoStack, then applies the change. Undo pops
  // from undoStack and pushes current -> redoStack. Redo mirrors.
  var EDIT_UNDO_LIMIT = 50;

  function _editSnapshot() {
    // workingCaptions + selectedWord are the only state that changes via
    // edit ops. View/zoom/audio are session UI state and don't undo.
    return {
      workingCaptions: JSON.parse(JSON.stringify(_editState.workingCaptions)),
      selectedWord:    _editState.selectedWord
        ? { capIdx: _editState.selectedWord.capIdx, wordIdx: _editState.selectedWord.wordIdx }
        : null
    };
  }

  function _editRestoreSnapshot(snap) {
    if (!snap || !_editState) return;
    _editState.workingCaptions = JSON.parse(JSON.stringify(snap.workingCaptions));
    _editState.selectedWord    = snap.selectedWord
      ? { capIdx: snap.selectedWord.capIdx, wordIdx: snap.selectedWord.wordIdx }
      : null;
    _editSyncToGenerated();
    persistCaptions();
    renderCaptionList(generatedCaptions);
    _layoutEditWordLane();
    _editUpdateUndoRedoButtons();
  }

  // Push a previously-taken snapshot onto undoStack and finalize the edit
  // (sync workingCaptions -> generatedCaptions, persist, re-render). The
  // caller is expected to have already mutated workingCaptions; snap is
  // the *pre-mutation* state used for undo.
  //
  // Usage:
  //   var snap = _editSnapshot();
  //   // ... mutate _editState.workingCaptions ...
  //   _editPushUndo(snap);
  function _editPushUndo(snap) {
    if (!_editState) return;
    _editState.undoStack.push(snap);
    if (_editState.undoStack.length > EDIT_UNDO_LIMIT) _editState.undoStack.shift();
    _editState.redoStack.length = 0;
    _editSyncToGenerated();
    persistCaptions();
    renderCaptionList(generatedCaptions);
    _editUpdateUndoRedoButtons();
  }

  function _editUndo() {
    if (!_editState || !_editState.undoStack.length) return;
    _editState.redoStack.push(_editSnapshot());
    if (_editState.redoStack.length > EDIT_UNDO_LIMIT) _editState.redoStack.shift();
    _editRestoreSnapshot(_editState.undoStack.pop());
  }
  function _editRedo() {
    if (!_editState || !_editState.redoStack.length) return;
    _editState.undoStack.push(_editSnapshot());
    if (_editState.undoStack.length > EDIT_UNDO_LIMIT) _editState.undoStack.shift();
    _editRestoreSnapshot(_editState.redoStack.pop());
  }

  function _editUpdateUndoRedoButtons() {
    if (!_editState) return;
    var undoBtn = document.getElementById('ac-edit-undo');
    var redoBtn = document.getElementById('ac-edit-redo');
    if (undoBtn) undoBtn.disabled = !_editState.undoStack.length;
    if (redoBtn) redoBtn.disabled = !_editState.redoStack.length;
    _editUpdateWordActionButtons();
  }

  // Up/down disabled at the absolute first/last word of the entire
  // caption set (no neighbor caption to spill into AND on the only line).
  // Split disabled when wi === 0 (nothing to split off) or caption has
  // only one word. Also positions+shows the floating word-action bar.
  function _editUpdateWordActionButtons() {
    var upBtn    = document.getElementById('ac-edit-word-up');
    var downBtn  = document.getElementById('ac-edit-word-down');
    var splitBtn = document.getElementById('ac-edit-word-split');
    var bar      = document.getElementById('ac-edit-word-actions');
    if (!upBtn || !downBtn || !splitBtn) return;
    if (!_editState || !_editState.selectedWord) {
      upBtn.disabled = downBtn.disabled = splitBtn.disabled = true;
      if (bar) bar.style.display = 'none';
      return;
    }
    var sel = _editState.selectedWord;
    var caps = _editState.workingCaptions;
    var cap = caps[sel.capIdx];
    if (!cap || !cap.words.length) {
      upBtn.disabled = downBtn.disabled = splitBtn.disabled = true;
      if (bar) bar.style.display = 'none';
      return;
    }
    var bounds = _editBoundariesOf(cap);
    var lineIdx = _editLineOfWord(bounds, sel.wordIdx);
    upBtn.disabled    = (sel.capIdx === 0 && lineIdx === 0);
    downBtn.disabled  = (sel.capIdx >= caps.length - 1 && lineIdx === bounds.length - 1);
    splitBtn.disabled = (cap.words.length <= 1 || sel.wordIdx === 0);

    // Position the floating bar above the selected word block. If the
    // word block isn't in the DOM right now (out of view), hide.
    if (!bar || !_editWordLane) return;
    var wordEl = _editWordLane.querySelector(
      '.edit-popup-word[data-cap-idx="' + sel.capIdx + '"][data-w-idx="' + sel.wordIdx + '"]'
    );
    if (!wordEl) { bar.style.display = 'none'; return; }
    var wordLeft = parseFloat(wordEl.style.left)  || 0;
    var wordW    = parseFloat(wordEl.style.width) || 0;
    var laneLeft = _editWordLane.offsetLeft;       // x of lane within timeline
    var laneTop  = _editWordLane.offsetTop;        // y of lane within timeline
    bar.style.display = 'flex';
    bar.style.left    = (laneLeft + wordLeft + wordW / 2) + 'px';
    // Sit just above the word lane (subtract 30px ≈ bar height + 4px gap).
    bar.style.top     = (laneTop - 30) + 'px';
  }

  // Pushes workingCaptions back into generatedCaptions. Preserves line
  // breaks by writing c.text as multi-line text (joining word ranges
  // between lineBreaks[] with "\n"). Captions with empty word arrays
  // are left alone (defensive).
  function _editSyncToGenerated() {
    if (!_editState) return;
    var caps = _editState.workingCaptions;
    // Adjust length too - handles ↩ split (caption inserted) and ^/v
    // cross-caption moves that may delete a now-empty caption.
    if (caps.length !== generatedCaptions.length) {
      generatedCaptions.length = caps.length;
    }
    for (var ci = 0; ci < caps.length; ci++) {
      var ws = caps[ci].words;
      if (!ws.length) continue;
      var newWords = ws.map(function (w) {
        return {
          word:  w.text,
          start: concatToTimeline(w.startConcat, _captionClipMap),
          end:   concatToTimeline(w.endConcat,   _captionClipMap)
        };
      });
      var c = generatedCaptions[ci] || {};
      c.words = newWords;
      c.start = newWords[0].start;
      c.end   = newWords[newWords.length - 1].end;
      // Build text with line breaks at lineBreaks positions
      var lb = (caps[ci].lineBreaks || []).slice().sort(function (a, b) { return a - b; });
      var parts = [], last = 0;
      for (var bi = 0; bi < lb.length; bi++) {
        if (lb[bi] <= last || lb[bi] >= newWords.length) continue;
        parts.push(newWords.slice(last, lb[bi]).map(function (w) { return w.word; }).join(' '));
        last = lb[bi];
      }
      parts.push(newWords.slice(last).map(function (w) { return w.word; }).join(' '));
      c.text = parts.join('\n');
      generatedCaptions[ci] = c;
    }
  }

  // Resize a word's left or right edge. Constrains:
  //   • In-caption neighbor word (prev/next within the same caption)
  //   • Cross-caption neighbor when at first/last word of a caption
  //   • Min duration 60ms
  function _editStartResize(capIdx, wi, side, mouseDownEv) {
    if (!_editState) return;
    mouseDownEv.preventDefault();
    mouseDownEv.stopPropagation();
    var st = _editState;
    var cap = st.workingCaptions[capIdx];
    if (!cap) return;
    _editSelectWord(capIdx, wi);
    var wasPlaying = _editAudioEl && !_editAudioEl.paused;
    if (wasPlaying) _editAudioEl.pause();
    _editTimelineEl.classList.add('dragging');
    // Snap pre-drag state for undo. Only pushed on mouseup IF the user
    // actually moved (i.e. mutated something).
    var preDragSnap = _editSnapshot();
    var moved = false;

    var minDur = 0.06;
    var prev   = cap.words[wi - 1];
    var cur    = cap.words[wi];
    var next   = cap.words[wi + 1];
    if (!cur) return;

    // Cross-caption neighbor edges - for first/last word of THIS caption.
    var prevCap = st.workingCaptions[capIdx - 1];
    var nextCap = st.workingCaptions[capIdx + 1];
    var neighborLeftBound  = (prevCap && prevCap.words.length)
      ? prevCap.words[prevCap.words.length - 1].endConcat : 0;
    var neighborRightBound = (nextCap && nextCap.words.length)
      ? nextCap.words[0].startConcat
      : (st.audioDuration || (cur.endConcat + 10));

    function onMove(ev) {
      var t = _editClientXToConcatT(ev.clientX);
      if (side === 'left') {
        var minL = prev ? prev.endConcat : neighborLeftBound;
        var maxL = cur.endConcat - minDur;
        cur.startConcat = Math.max(minL, Math.min(maxL, t));
        cur.timelineStart = concatToTimeline(cur.startConcat, _captionClipMap);
      } else {
        var minR = cur.startConcat + minDur;
        var maxR = next ? next.startConcat : neighborRightBound;
        cur.endConcat = Math.max(minR, Math.min(maxR, t));
      }
      moved = true;
      _editJustDragged = true;
      _layoutEditWordLane();
    }
    function onUp() {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup',   onUp);
      _editTimelineEl.classList.remove('dragging');
      if (moved) _editPushUndo(preDragSnap);
      if (wasPlaying && _editAudioEl) {
        var p = _editAudioEl.play();
        if (p && p.catch) p.catch(function () {});
        _editPlayBtn.innerHTML = _PAUSE_GLYPH;
        _editStartTick();
      }
      // Reset the suppress-click flag on the next tick so genuine clicks
      // a moment later are not eaten.
      setTimeout(function () { _editJustDragged = false; }, 50);
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup',   onUp);
  }

  // Mousedown-on-word-body: track until either (a) movement exceeds the
  // click/drag threshold -> translate the word's start+end together, or
  // (b) mouseup with no movement -> let the click handler run normally
  // (select + seek). Preserves dbl-click for text edit.
  function _editStartWordMove(capIdx, wi, mouseDownEv) {
    if (!_editState) return;
    var st = _editState;
    var cap = st.workingCaptions[capIdx];
    if (!cap) return;
    var cur = cap.words[wi];
    if (!cur) return;
    var startX  = mouseDownEv.clientX;
    var origStart = cur.startConcat;
    var origEnd   = cur.endConcat;
    var dur     = origEnd - origStart;
    var laneW   = st.laneWidthPx;
    var viewDur = st.viewEndConcat - st.viewStartConcat;
    var moved   = false;

    // Boundary references for the word's start position. In-caption
    // neighbor first, falling back to the adjacent *caption's* edge
    // when this word is at the start/end of its caption.
    var prev    = cap.words[wi - 1];
    var next    = cap.words[wi + 1];
    var prevCap = st.workingCaptions[capIdx - 1];
    var nextCap = st.workingCaptions[capIdx + 1];
    var leftBound  = prev ? prev.endConcat
                          : ((prevCap && prevCap.words.length)
                              ? prevCap.words[prevCap.words.length - 1].endConcat : 0);
    var rightBound = next ? next.startConcat
                          : ((nextCap && nextCap.words.length)
                              ? nextCap.words[0].startConcat
                              : (st.audioDuration || (origEnd + 30)));
    var minStart = leftBound;
    var maxStart = rightBound - dur;

    var wasPlaying = _editAudioEl && !_editAudioEl.paused;
    // Snap pre-drag state once we know the user is committing to a drag
    // (after the threshold check). Not at mousedown because a simple
    // click should never push an undo step.
    var preDragSnap = null;

    function onMove(ev) {
      var dx = ev.clientX - startX;
      if (!moved) {
        if (Math.abs(dx) < 3) return;
        moved = true;
        preDragSnap = _editSnapshot();
        if (wasPlaying) _editAudioEl.pause();
        _editTimelineEl.classList.add('dragging');
        _editSelectWord(capIdx, wi);
      }
      var dxSec   = (dx / laneW) * viewDur;
      var newStart = Math.max(minStart, Math.min(maxStart, origStart + dxSec));
      cur.startConcat   = newStart;
      cur.endConcat     = newStart + dur;
      cur.timelineStart = concatToTimeline(newStart, _captionClipMap);
      _editJustDragged = true;
      _layoutEditWordLane();
    }
    function onUp() {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup',   onUp);
      _editTimelineEl.classList.remove('dragging');
      if (moved && preDragSnap) {
        _editPushUndo(preDragSnap);
        if (wasPlaying && _editAudioEl) {
          var p = _editAudioEl.play();
          if (p && p.catch) p.catch(function () {});
          _editPlayBtn.innerHTML = _PAUSE_GLYPH;
          _editStartTick();
        }
        setTimeout(function () { _editJustDragged = false; }, 50);
      }
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup',   onUp);
  }

  // Mousedown on a line-break handle -> drag horizontally. While dragging,
  // the handle just slides visually (no commits). On release, snap to
  // the nearest word boundary in the active caption and update that
  // line break's index in lineBreaks. One undo step per drag.
  function _editStartLineBreakDrag(handleEl, mouseDownEv) {
    if (!_editState) return;
    mouseDownEv.preventDefault();
    mouseDownEv.stopPropagation();
    var lbi = parseInt(handleEl.getAttribute('data-lb-idx'), 10);
    var st  = _editState;
    var concatT0 = _editAudioEl ? _editAudioEl.currentTime : st.centerConcat;
    // Use the EFFECTIVE active caption (selection-aware) - the line-
    // break handles drawn on screen belong to whichever caption the
    // layout treats as active, so this must agree to operate on the
    // same caption the user is grabbing the handle from.
    var activeCapIdx = _editEffectiveActiveCapIdx(concatT0);
    if (activeCapIdx == null) return;
    var cap = st.workingCaptions[activeCapIdx];
    if (!cap || !cap.lineBreaks || lbi >= cap.lineBreaks.length) return;

    _editTimelineEl.classList.add('dragging');

    function onMove(ev) {
      var t = _editClientXToConcatT(ev.clientX);
      var viewDur = st.viewEndConcat - st.viewStartConcat;
      var x = (t - st.viewStartConcat) / viewDur * st.laneWidthPx;
      // Handle lives inside .edit-popup-timeline-inner - positions are
      // inner-relative now, no need for the padding offset.
      handleEl.style.left = x + 'px';
      _editJustDragged = true;
    }
    function onUp(ev) {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup',   onUp);
      _editTimelineEl.classList.remove('dragging');
      // Snap to nearest word's start - matches where the marker is
      // rendered (at the start of the next-line word) so visual and
      // logical positions are consistent.
      var t = _editClientXToConcatT(ev.clientX);
      var bestIdx = 1, bestDist = Infinity;
      for (var wi = 1; wi < cap.words.length; wi++) {
        var bndT = cap.words[wi].startConcat;
        var d = Math.abs(bndT - t);
        if (d < bestDist) { bestDist = d; bestIdx = wi; }
      }
      var oldIdx = cap.lineBreaks[lbi];
      if (oldIdx !== bestIdx) {
        var snap = _editSnapshot();
        cap.lineBreaks[lbi] = bestIdx;
        // Dedupe + sort (if user dragged onto another break's position
        // they collapse into one).
        cap.lineBreaks = cap.lineBreaks
          .filter(function (v, i, a) { return a.indexOf(v) === i; })
          .sort(function (a, b) { return a - b; });
        _editPushUndo(snap);
      }
      _layoutEditWordLane();
      setTimeout(function () { _editJustDragged = false; }, 50);
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup',   onUp);
  }

  // Mousedown on waveform/empty space: pan the view if the user drags;
  // pass through to the click-to-seek handler if they release without
  // moving (threshold = 3px).
  function _editStartTimelinePan(mouseDownEv) {
    if (!_editState) return;
    var st = _editState;
    var startX  = mouseDownEv.clientX;
    var origVS  = st.viewStartConcat;
    var origVE  = st.viewEndConcat;
    var viewDur = origVE - origVS;
    var laneW   = st.laneWidthPx;
    var maxEnd  = st.audioDuration || (origVE + 60);
    var moved   = false;

    function onMove(ev) {
      var dx = ev.clientX - startX;
      if (!moved) {
        if (Math.abs(dx) < 3) return;
        moved = true;
        _editTimelineEl.classList.add('dragging');
      }
      // Drag right -> pan view left (i.e. show earlier audio)
      var dxSec = -(dx / laneW) * viewDur;
      var newStart = origVS + dxSec;
      var newEnd   = origVE + dxSec;
      if (newStart < 0)      { newStart = 0;            newEnd = viewDur; }
      if (newEnd   > maxEnd) { newEnd   = maxEnd;       newStart = maxEnd - viewDur; }
      st.viewStartConcat = newStart;
      st.viewEndConcat   = newEnd;
      _layoutEditWordLane();
      _drawEditWaveform(st.peaks);
      // Throttled fetch so the waveform updates while dragging instead
      // of waiting for release.
      _editFetchPeaksThrottled();
      if (_editAudioEl) {
        _editPlayheadEl.style.left = _editPlayheadX(_editAudioEl.currentTime) + 'px';
      }
      _editJustDragged = true;
    }
    function onUp() {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup',   onUp);
      _editTimelineEl.classList.remove('dragging');
      if (moved) {
        _editFetchPeaks(); // refresh peaks for the panned-to window
        setTimeout(function () { _editJustDragged = false; }, 50);
      }
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup',   onUp);
  }

  function _editStartTextEdit(capIdx, wi, textEl) {
    if (!_editState) return;
    var st  = _editState;
    var cap = st.workingCaptions[capIdx];
    if (!cap) return;
    var w   = cap.words[wi];
    if (!w) return;
    textEl.setAttribute('contenteditable', 'true');
    textEl.spellcheck = false;
    textEl.focus();
    // Select all of the existing text so the user can just start typing
    var range = document.createRange();
    range.selectNodeContents(textEl);
    var sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);

    var original = w.text;
    function commit(saveValue) {
      if (saveValue) {
        var newText = (textEl.textContent || '').trim();
        if (newText && newText !== original) {
          var snap = _editSnapshot();
          w.text = newText;
          _editPushUndo(snap);
        }
      }
      textEl.removeAttribute('contenteditable');
      textEl.textContent = w.text;
      _layoutEditWordLane();
    }
    textEl.addEventListener('keydown', function onKey(e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        textEl.removeEventListener('keydown', onKey);
        commit(true);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        textEl.removeEventListener('keydown', onKey);
        commit(false);
      }
    });
    textEl.addEventListener('blur', function onBlur() {
      textEl.removeEventListener('blur', onBlur);
      // Treat blur as commit (matches most editors' behavior)
      if (textEl.hasAttribute('contenteditable')) commit(true);
    });
  }

  // Turn an empty-space slot into an inline input. Enter or blur with
  // non-empty text -> insert a new word in the slot's caption; Esc or
  // empty + blur -> cancel and restore the slot.
  function _editStartSlotInput(slotEl) {
    if (!_editState) return;
    var capIdx     = parseInt(slotEl.getAttribute('data-cap-idx'),    10);
    var insertAt   = parseInt(slotEl.getAttribute('data-slot-idx'),   10);
    var slotStart  = parseFloat(slotEl.getAttribute('data-slot-start'));
    var slotEnd    = parseFloat(slotEl.getAttribute('data-slot-end'));
    slotEl.classList.add('editing');
    slotEl.innerHTML = '<input class="edit-popup-add-slot-input" type="text" spellcheck="false" maxlength="60"/>';
    var input = slotEl.querySelector('.edit-popup-add-slot-input');
    input.focus();
    var done = false;
    function commit(useValue) {
      if (done) return; done = true;
      var text = (input.value || '').trim();
      if (useValue && text) {
        _editInsertWord(capIdx, insertAt, slotStart, slotEnd, text);
      } else {
        _layoutEditWordLane();
      }
    }
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); commit(true); }
      else if (e.key === 'Escape') { e.preventDefault(); commit(false); }
    });
    input.addEventListener('blur', function () { commit(true); });
  }

  // Insert a new word into the given caption's working buffer.
  function _editInsertWord(capIdx, insertAt, slotStart, slotEnd, text) {
    if (!_editState) return;
    var st = _editState;
    var cap = st.workingCaptions[capIdx];
    if (!cap) return;
    var minDur = 0.06;
    var start = slotStart;
    var end   = slotEnd;
    if (end - start < minDur) {
      var prev = (insertAt > 0) ? cap.words[insertAt - 1] : null;
      var next = (insertAt < cap.words.length) ? cap.words[insertAt] : null;
      end = start + minDur;
      if (next && end > next.startConcat) {
        end = next.startConcat;
        start = end - minDur;
        if (prev && start < prev.endConcat) start = prev.endConcat;
      }
    }
    var newWord = {
      text:          text,
      timelineStart: concatToTimeline(start, _captionClipMap),
      startConcat:   start,
      endConcat:     end
    };
    var snap = _editSnapshot();
    cap.words.splice(insertAt, 0, newWord);
    st.selectedWord = { capIdx: capIdx, wordIdx: insertAt };
    _editPushUndo(snap);
    _layoutEditWordLane();
  }

  // Line-break helpers for the editor's working buffers - equivalents of
  // _getLineBoundaries / _lineOfWord but reading from cap.lineBreaks
  // (the editor's source of truth) instead of cap.text.
  function _editBoundariesOf(cap) {
    if (!cap.words.length) return [{ start: 0, end: 0 }];
    var lb = (cap.lineBreaks || []).slice().sort(function (a, b) { return a - b; });
    var bounds = [], last = 0;
    for (var bi = 0; bi < lb.length; bi++) {
      if (lb[bi] <= last || lb[bi] >= cap.words.length) continue;
      bounds.push({ start: last, end: lb[bi] - 1 });
      last = lb[bi];
    }
    bounds.push({ start: last, end: cap.words.length - 1 });
    return bounds;
  }
  function _editLineOfWord(bounds, wi) {
    for (var li = 0; li < bounds.length; li++) {
      if (wi >= bounds[li].start && wi <= bounds[li].end) return li;
    }
    return 0;
  }
  // Build cap.lineBreaks from a set of {start,end} bounds.
  function _editBoundsToLineBreaks(bounds) {
    var lb = [];
    for (var li = 1; li < bounds.length; li++) lb.push(bounds[li].start);
    return lb;
  }

  // ^ - move selected word up by one line (within caption), OR if at
  // the first line, push words[0..wi] into the previous caption. Same
  // logic as the captions-page wordUpBtn handler but operates on
  // workingCaptions + the editor's selectedWord.
  function _editWordUp() {
    if (!_editState || !_editState.selectedWord) return;
    var sel = _editState.selectedWord;
    var ci  = sel.capIdx, wi = sel.wordIdx;
    var caps = _editState.workingCaptions;
    var cur  = caps[ci];
    if (!cur || !cur.words.length) return;
    var bounds  = _editBoundariesOf(cur);
    var lineIdx = _editLineOfWord(bounds, wi);
    var snap    = _editSnapshot();

    if (lineIdx > 0) {
      // Within-caption: extend prev line through wi, shrink current
      var newBounds = [];
      for (var li = 0; li < bounds.length; li++) {
        if (li === lineIdx - 1) newBounds.push({ start: bounds[li].start, end: wi });
        else if (li === lineIdx) {
          if (wi + 1 <= bounds[li].end) newBounds.push({ start: wi + 1, end: bounds[li].end });
        } else newBounds.push(bounds[li]);
      }
      if (newBounds.length === 0) newBounds = [{ start: 0, end: cur.words.length - 1 }];
      cur.lineBreaks = _editBoundsToLineBreaks(newBounds);
    } else {
      // First line: move words[0..wi] to previous caption
      if (ci === 0) return;
      var prev = caps[ci - 1];
      if (!prev) return;
      var moving    = cur.words.slice(0, wi + 1);
      var remaining = cur.words.slice(wi + 1);
      var prevLen   = prev.words.length;
      prev.words = prev.words.concat(moving);
      // Previous caption's lineBreaks unchanged (we appended; new words
      // join the last line).
      if (remaining.length === 0) {
        caps.splice(ci, 1);
        _editState.selectedWord = { capIdx: ci - 1, wordIdx: prevLen + wi };
      } else {
        cur.words = remaining;
        // Reset its line structure - line breaks indexed into the old
        // word array don't apply anymore.
        cur.lineBreaks = [];
        _editState.selectedWord = { capIdx: ci - 1, wordIdx: prevLen + wi };
      }
    }
    _editPushUndo(snap);
    _layoutEditWordLane();
  }

  // v - mirror of ^: move down a line within caption, or spill into the
  // next caption when on the last line.
  function _editWordDown() {
    if (!_editState || !_editState.selectedWord) return;
    var sel = _editState.selectedWord;
    var ci  = sel.capIdx, wi = sel.wordIdx;
    var caps = _editState.workingCaptions;
    var cur  = caps[ci];
    if (!cur || !cur.words.length) return;
    var bounds  = _editBoundariesOf(cur);
    var lineIdx = _editLineOfWord(bounds, wi);
    var snap    = _editSnapshot();

    if (lineIdx < bounds.length - 1) {
      var newBounds = [];
      for (var li = 0; li < bounds.length; li++) {
        if (li === lineIdx) {
          if (wi > bounds[li].start) newBounds.push({ start: bounds[li].start, end: wi - 1 });
        } else if (li === lineIdx + 1) {
          newBounds.push({ start: wi, end: bounds[li].end });
        } else newBounds.push(bounds[li]);
      }
      if (newBounds.length === 0) newBounds = [{ start: 0, end: cur.words.length - 1 }];
      cur.lineBreaks = _editBoundsToLineBreaks(newBounds);
    } else {
      if (ci >= caps.length - 1) return;
      var next = caps[ci + 1];
      if (!next) return;
      var moving    = cur.words.slice(wi);
      var remaining = cur.words.slice(0, wi);
      next.words = moving.concat(next.words);
      // Line breaks in `next` shift by `moving.length` since we prepended.
      next.lineBreaks = (next.lineBreaks || []).map(function (b) { return b + moving.length; });
      var newCi = ci + 1;
      if (remaining.length === 0) {
        caps.splice(ci, 1);
        newCi = ci;
      } else {
        cur.words = remaining;
        cur.lineBreaks = [];
      }
      _editState.selectedWord = { capIdx: newCi, wordIdx: 0 };
    }
    _editPushUndo(snap);
    _layoutEditWordLane();
  }

  // Regroup the captions using the current Lines/Chars/Gap setting,
  // preserving word-level edits (text + timings). Captures one undo
  // step so the user can Ctrl+Z back to the previous grouping.
  function _editApplyGroupingChange() {
    if (!_editState) return;
    var snap = _editSnapshot();
    // Make sure any pending workingCaptions state is flushed into
    // generatedCaptions before the regroup reads from it.
    _editSyncToGenerated();
    regroupCaptions(); // existing captions-page logic - flatten + groupWords
    // generatedCaptions is now reshuffled; rebuild workingCaptions to
    // match the new structure.
    _editState.workingCaptions = _editBuildWorkingCaptions();
    _editState.selectedWord    = null;
    _editPushUndo(snap);
    _layoutEditWordLane();
  }

  // ↩ - split current caption at the selected word: words[wi..end] become
  // a new caption inserted immediately after.
  function _editWordSplit() {
    if (!_editState || !_editState.selectedWord) return;
    var sel = _editState.selectedWord;
    var ci  = sel.capIdx, wi = sel.wordIdx;
    var caps = _editState.workingCaptions;
    var cur  = caps[ci];
    if (!cur || cur.words.length <= 1) return;
    if (wi === 0) return; // nothing meaningful to split off - whole caption stays
    var snap = _editSnapshot();
    var moving    = cur.words.slice(wi);
    var remaining = cur.words.slice(0, wi);
    cur.words      = remaining;
    cur.lineBreaks = []; // structure no longer valid
    caps.splice(ci + 1, 0, { words: moving, lineBreaks: [] });
    _editState.selectedWord = { capIdx: ci + 1, wordIdx: 0 };
    _editPushUndo(snap);
    _layoutEditWordLane();
  }

  function _editDeleteSelected() {
    if (!_editState) return;
    var st = _editState;
    if (!st.selectedWord) return;
    var ci = st.selectedWord.capIdx;
    var wi = st.selectedWord.wordIdx;
    var cap = st.workingCaptions[ci];
    if (!cap) return;
    // Refuse to delete the last word in a caption (caption would vanish).
    // To remove a whole caption the user can hide it from the captions list.
    if (cap.words.length <= 1) return;
    var snap = _editSnapshot();
    cap.words.splice(wi, 1);
    // Move selection: next word in same caption, else previous, else clear.
    if (wi >= cap.words.length) {
      st.selectedWord = cap.words.length ? { capIdx: ci, wordIdx: cap.words.length - 1 } : null;
    }
    _editPushUndo(snap);
    _layoutEditWordLane();
  }

  // Document-level keydown handler installed once. Active only while the
  // popup is open and the user isn't typing into an editable element.
  function _editKeydown(e) {
    if (!_editState || _editPopupEl.classList.contains('hidden')) return;
    var ae = document.activeElement;
    if (ae && (ae.isContentEditable || ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')) {
      return; // let the contenteditable / input handle it
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (!_editState.selectedWord) return;
      e.preventDefault();
      _editDeleteSelected();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      if (_editState.selectedWord) _editSelectWord(null);
      else _editClose();
    } else if (e.key === ' ') {
      // Space toggles play/pause - common in audio editors
      e.preventDefault();
      _editTogglePlay();
    } else if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) {
      // Ctrl+Shift+Z = redo (Mac/Linux convention), Ctrl+Z = undo
      e.preventDefault();
      if (e.shiftKey) _editRedo();
      else            _editUndo();
    } else if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || e.key === 'Y')) {
      e.preventDefault();
      _editRedo();
    }
  }

  // Build per-caption working buffers from generatedCaptions. Each
  // caption's words array is a fresh deep copy in concat-time terms;
  // lineBreaks is the word indices where line breaks live (extracted
  // from c.text's "\n" positions so we don't lose line structure on
  // the round-trip through workingCaptions -> generatedCaptions).
  function _editBuildWorkingCaptions() {
    var out = [];
    for (var ci = 0; ci < generatedCaptions.length; ci++) {
      var c = generatedCaptions[ci];
      var ws = (c && c.words) ? c.words.map(function (w) {
        return {
          text:          w.word,
          timelineStart: w.start,
          startConcat:   timelineToConcat(w.start, _captionClipMap),
          endConcat:     timelineToConcat(w.end,   _captionClipMap)
        };
      }) : [];
      out.push({ words: ws, lineBreaks: _editExtractLineBreaks(c, ws.length) });
    }
    return out;
  }

  // Returns the word indices where line breaks happen - i.e. the word
  // that *starts* each subsequent line. Line 1 starts at index 0 (not
  // included); breakpoints[k] is the index of the first word on line
  // k+1. Derived from c.text by counting words per "\n"-separated line.
  function _editExtractLineBreaks(c, wordCount) {
    if (!c || !c.text || c.text.indexOf('\n') === -1) return [];
    var lines = c.text.split('\n');
    var out = [], wi = 0;
    for (var li = 0; li < lines.length - 1; li++) {
      var cnt = lines[li].trim().split(/\s+/).filter(Boolean).length;
      wi += cnt;
      if (wi > 0 && wi < wordCount) out.push(wi);
    }
    return out;
  }

  // Which caption (by index) owns the time concatT? Returns the caption
  // whose [first.start, last.end] covers concatT. For gaps between
  // captions, returns the *previous* caption when _m4HoldSilence is on
  // (matches what the user perceives as "the caption that's currently
  // on screen") - otherwise null.
  // Selection takes precedence over the playhead when deciding which
  // caption is "active" in the per-caption editor. Reason: once the
  // user has picked a word, that word's caption should stay the focal
  // point even if they later scrub the playhead into a neighbouring
  // caption - otherwise the selected word ends up rendered with
  // .inactive styling on top of .selected (the "weird colors" the
  // user reported). Only when nothing is selected does the playhead
  // drive the active caption. All visual paths that previously called
  // _editActiveCapIdxAt directly go through this helper now.
  function _editEffectiveActiveCapIdx(concatT) {
    if (!_editState) return null;
    var sel = _editState.selectedWord;
    if (sel && sel.capIdx != null
        && _editState.workingCaptions
        && _editState.workingCaptions[sel.capIdx]
        && _editState.workingCaptions[sel.capIdx].words
        && _editState.workingCaptions[sel.capIdx].words.length) {
      return sel.capIdx;
    }
    return _editActiveCapIdxAt(concatT);
  }

  function _editActiveCapIdxAt(concatT) {
    if (!_editState) return null;
    var caps = _editState.workingCaptions;
    var lastIdx = -1;
    for (var ci = 0; ci < caps.length; ci++) {
      var ws = caps[ci].words;
      if (!ws.length) continue;
      var gs = ws[0].startConcat;
      var ge = ws[ws.length - 1].endConcat;
      if (concatT < gs) {
        return (lastIdx >= 0 && _m4HoldSilence) ? lastIdx : null;
      }
      // Use a half-open range [gs, ge): when two captions touch at gs===ge,
      // the boundary value belongs to the NEXT caption, not the one ending
      // there. Otherwise opening caption B (which seeks to B.start) would
      // light up caption A because the loop returns the first matching
      // entry and A.end === B.start === playhead.
      if (concatT >= ge) { lastIdx = ci; continue; }
      return ci;
    }
    return null;
  }

  // Returns the word index inside `words` (concat-time array) that is
  // "current" at concatT - i.e. the latest word whose start has been reached.
  function _editCurWordIn(ws, concatT) {
    if (!ws || !ws.length) return 0;
    var idx = 0;
    for (var i = 0; i < ws.length; i++) {
      if (ws[i].startConcat <= concatT) idx = i;
      else break;
    }
    return idx;
  }

  // Public entry point - wired from renderCaptionList's pencil button.
  // `captionIdx` is the caption to focus on (playhead seeks there).
  function _openCaptionEditor(captionIdx) {
    if (!_captionWavPath || !_captionClipMap) return;
    if (!generatedCaptions.length) return;
    var focusIdx = (captionIdx != null && generatedCaptions[captionIdx]) ? captionIdx : 0;

    _editPopupGrabDom();
    _editWireOnce();

    var workingCaptions = _editBuildWorkingCaptions();
    var focusCap = workingCaptions[focusIdx];
    var focusStart = (focusCap && focusCap.words.length) ? focusCap.words[0].startConcat : 0;
    var focusEnd   = (focusCap && focusCap.words.length)
      ? focusCap.words[focusCap.words.length - 1].endConcat
      : focusStart + 1;

    _editState = {
      workingCaptions: workingCaptions,
      selectedWord:    null,
      focusCaptionIdx: focusIdx,
      // Per-session undo / redo. Reset on each popup open - closing the
      // popup commits everything and discards history (matches the
      // user's mental model: "I open, I edit, I close, that's final").
      undoStack:       [],
      redoStack:       [],
      viewStartConcat: 0,
      viewEndConcat:   0,
      // Center reference for _editRecomputeView. Defaults to whichever
      // caption was passed in; updated whenever nav jumps the playhead.
      centerConcat:    (focusStart + focusEnd) / 2,
      laneWidthPx:     0,
      audioDuration:   0,
      peaks:           []
    };

    _editTextEl.textContent = '';
    _editPlayBtn.innerHTML  = _PLAY_GLYPH;
    _editPopupEl.classList.remove('hidden');

    // Zoom default frames the focus caption nicely on first open.
    _editZoomEl.value = _editComputeDefaultZoom(focusEnd - focusStart);

    _editAudioEl = new Audio(_fileUrl(_captionWavPath));
    _editAudioEl.preload = 'auto';
    // Carry the user's chosen playback speed across opens so the
    // setting doesn't reset every time they reopen the editor on a
    // new caption.
    _editApplySpeed();
    _editAudioEl.addEventListener('loadedmetadata', function () {
      if (!_editState) return;
      _editState.audioDuration = _editAudioEl.duration || 0;
      _editRecomputeView();
      _layoutEditWordLane();
      _editFetchPeaks();
      _editSeekToConcatT(focusStart, true);
    });
    _editAudioEl.addEventListener('error', function () {
      console.warn('[Edit] audio load failed:', _fileUrl(_captionWavPath));
    });
    _editAudioEl.addEventListener('pause', function () {
      if (!_editState) return;
      _editPlayBtn.innerHTML = _PLAY_GLYPH;
      if (_editRafId) { cancelAnimationFrame(_editRafId); _editRafId = null; }
    });
    _editAudioEl.addEventListener('ended', function () {
      if (!_editState) return;
      _editPlayBtn.innerHTML = _PLAY_GLYPH;
      if (_editRafId) { cancelAnimationFrame(_editRafId); _editRafId = null; }
    });
    _editAudioEl.addEventListener('play', function () {
      if (!_editState) return;
      _editPlayBtn.innerHTML = _PAUSE_GLYPH;
      _editStartTick();
    });

    _editRecomputeView();
    _layoutEditWordLane();
    _editFetchPeaks();
    _editSeekToConcatT(focusStart, true);
    _editUpdateNavDisabled();
    _editUpdateUndoRedoButtons();
  }
  // Expose so renderCaptionList can reach it via typeof check.
  global._openCaptionEditor = _openCaptionEditor; // for debugging from DevTools

  // ── Smart Caption Lab ─────────────────────────────────────────────────────
  // Local, deterministic enhancements for SRT/manual captions. These do not
  // call transcription or a network service, so timing and user text remain
  // under the editor's control.
  (function _initSmartCaptionLab() {
    var enhanceBtn = document.getElementById('ac-smart-enhance');
    if (!enhanceBtn) return;
    var undoBtn = document.getElementById('ac-smart-undo');
    var statusEl = document.getElementById('ac-smart-status');
    var presetEl = document.getElementById('ac-smart-preset');
    var presetBtn = document.getElementById('ac-smart-preset-apply');
    var brandSave = document.getElementById('ac-brand-save');
    var brandApply = document.getElementById('ac-brand-apply');
    var history = null;
    var BRAND_KEY = 'orbit_caption_brand_style_v1';
    var SPEAKER_COLORS = ['#7CE7FF', '#FFCF70', '#B8F28B', '#FF91C8', '#B9A0FF', '#FF9D72'];
    var STOP = {
      'the':1,'and':1,'that':1,'this':1,'with':1,'from':1,'have':1,'your':1,'you':1,'for':1,'are':1,'was':1,'were':1,'but':1,'not':1,'just':1,'into':1,'about':1,'what':1,'when':1,'where':1,'will':1,'can':1,'could':1,'would':1,
      'এই':1,'এবং':1,'আমি':1,'তুমি':1,'আপনি':1,'আমরা':1,'তারা':1,'করে':1,'করতে':1,'হবে':1,'হয়':1,'হয়ে':1,'একটা':1,'কিন্তু':1,'যদি':1,'যখন':1,'জন্য':1,'থেকে':1,'সাথে':1,'নিয়ে':1,'কি':1,'কী':1
    };
    var PROFANITY = ['fuck','fucking','shit','bitch','bastard','asshole','motherfucker','damn','হারামজাদা','শালা','চুদ','চোদ','মাদারচোদ'];
    var EMOJI = {
      'love':'❤️','ভালোবাসা':'❤️','happy':'😊','খুশি':'😊','laugh':'😂','funny':'😂','হাসি':'😂',
      'fire':'🔥','আগুন':'🔥','money':'💰','টাকা':'💰','win':'🏆','winner':'🏆','জয়':'🏆',
      'idea':'💡','tips':'💡','টিপস':'💡','warning':'⚠️','সাবধান':'⚠️','stop':'🛑','বন্ধ':'🛑',
      'subscribe':'🔔','সাবস্ক্রাইব':'🔔','like':'👍','লাইক':'👍','phone':'📱','video':'🎬','ভিডিও':'🎬',
      'secret':'🤫','গোপন':'🤫','wow':'😮','amazing':'🤯','অসাধারণ':'🤯','question':'❓','কেন':'❓'
    };

    function smartStatus(text, error) {
      if (!statusEl) return;
      statusEl.textContent = text || '';
      statusEl.style.color = error ? '#f27d78' : '#70d98b';
    }
    function normalizeWord(text) {
      return String(text || '').toLowerCase().replace(/^[^a-z0-9\u0980-\u09ff]+|[^a-z0-9\u0980-\u09ff]+$/g, '');
    }
    function rebuildSmartWords() {
      generatedWords = [];
      for (var i = 0; i < generatedCaptions.length; i++) {
        var words = generatedCaptions[i].words || [];
        for (var w = 0; w < words.length; w++) generatedWords.push(words[w]);
      }
    }
    function refreshSmartCaptions() {
      rebuildSmartWords(); persistCaptions(); renderCaptionList(generatedCaptions);
      if (applySrtBtn) applySrtBtn.disabled = !generatedCaptions.length;
      if (applyModel4Btn) applyModel4Btn.disabled = !generatedCaptions.length;
      _m4DrawPreview();
    }
    function balancedText(words, maxChars, maxLines) {
      if (!words.length) return '';
      maxLines = Math.max(1, Math.min(3, maxLines || 2));
      maxChars = Math.max(10, maxChars || 28);
      var plain = words.map(function(w) { return w.word; });
      var total = plain.join(' ').length;
      if (maxLines === 1 || total <= maxChars) return plain.join(' ');
      var lines = [], current = [], currentLen = 0;
      var target = Math.min(maxChars, Math.ceil(total / Math.min(maxLines, Math.ceil(total / maxChars))));
      for (var i = 0; i < plain.length; i++) {
        var add = plain[i].length + (current.length ? 1 : 0);
        var remainingWords = plain.length - i;
        var remainingLines = maxLines - lines.length;
        if (current.length && currentLen + add > target && remainingLines > 1 && remainingWords >= remainingLines - 1) {
          lines.push(current.join(' ')); current = []; currentLen = 0; add = plain[i].length;
        }
        current.push(plain[i]); currentLen += add;
      }
      if (current.length) lines.push(current.join(' '));
      while (lines.length > maxLines) lines[maxLines - 1] += ' ' + lines.splice(maxLines, 1)[0];
      return lines.join('\n');
    }
    function maskWord(text) {
      var raw = String(text || ''), norm = normalizeWord(raw), matched = false;
      for (var i = 0; i < PROFANITY.length; i++) {
        if (norm.indexOf(PROFANITY[i]) !== -1) { matched = true; break; }
      }
      if (!matched || raw.length < 2) return raw;
      return raw.charAt(0) + new Array(Math.max(2, raw.length)).join('＊');
    }
    function detectSpeaker(caption) {
      if (caption.speaker) return String(caption.speaker);
      var text = String(caption.text || '').replace(/\n/g, ' ').trim();
      var bracket = text.match(/^\[([^\]]{1,24})\]\s*/);
      if (bracket) return bracket[1].trim();
      var colon = text.match(/^([^:]{1,24}):\s+/);
      if (colon && colon[1].split(/\s+/).length <= 4) return colon[1].trim();
      return '';
    }
    function keywordSet() {
      var freq = {}, first = {};
      for (var c = 0; c < generatedCaptions.length; c++) {
        var words = generatedCaptions[c].words || [];
        for (var w = 0; w < words.length; w++) {
          var n = normalizeWord(words[w].word);
          if (!n || STOP[n] || n.length < (/^[\u0980-\u09ff]+$/.test(n) ? 5 : 6)) continue;
          freq[n] = (freq[n] || 0) + 1; if (first[n] == null) first[n] = c * 1000 + w;
        }
      }
      var ranked = Object.keys(freq).sort(function(a,b) {
        var sa = Math.min(a.length, 12) * 2 + Math.min(freq[a], 3) * 3;
        var sb = Math.min(b.length, 12) * 2 + Math.min(freq[b], 3) * 3;
        return sb - sa || first[a] - first[b];
      });
      var keep = Math.max(1, Math.min(24, Math.ceil(ranked.length * 0.28))), out = {};
      for (var i = 0; i < keep; i++) out[ranked[i]] = true;
      return out;
    }
    function repairCollisions() {
      var fixed = 0, frame = 1 / 30;
      generatedCaptions.sort(function(a,b) { return Number(a.start) - Number(b.start); });
      for (var i = 1; i < generatedCaptions.length; i++) {
        var prev = generatedCaptions[i - 1], cur = generatedCaptions[i];
        if (Number(prev.end) > Number(cur.start)) {
          var nextEnd = Math.max(Number(prev.start) + frame, Number(cur.start) - frame);
          prev.end = nextEnd;
          if (prev.words && prev.words.length) prev.words[prev.words.length - 1].end = Math.min(Number(prev.words[prev.words.length - 1].end), nextEnd);
          fixed++;
        }
      }
      return fixed;
    }
    function applySafePosition(name) {
      var map = { top: [50, 14], center: [50, 50], bottom: [50, 86] }, pos = map[name] || map.bottom;
      var x = document.getElementById('ac-bar-pos-x'), y = document.getElementById('ac-bar-pos-y');
      if (x) { x.value = pos[0]; x.dispatchEvent(new Event('input')); x.dispatchEvent(new Event('change')); }
      if (y) { y.value = pos[1]; y.dispatchEvent(new Event('input')); y.dispatchEvent(new Event('change')); }
      document.querySelectorAll('[data-ac-safe-pos]').forEach(function(b) { b.classList.toggle('active', b.dataset.acSafePos === name); });
      smartStatus('Safe position: ' + name + '.');
    }

    enhanceBtn.addEventListener('click', function() {
      if (!generatedCaptions.length) { smartStatus('Import an SRT first.', true); return; }
      history = JSON.stringify(generatedCaptions); if (undoBtn) undoBtn.disabled = false;
      var doLines = document.getElementById('ac-smart-lines').checked;
      var doKeywords = document.getElementById('ac-smart-keywords').checked;
      var doEmoji = document.getElementById('ac-smart-emoji').checked;
      var doSpeakers = document.getElementById('ac-smart-speakers').checked;
      var doProfanity = document.getElementById('ac-smart-profanity').checked;
      var doCollisions = document.getElementById('ac-smart-collisions').checked;
      var keywords = doKeywords ? keywordSet() : {}, speakers = {}, speakerCount = 0, emphasized = 0, emojis = 0, masked = 0;
      var maxChars = maxCharsInputMainEl ? (parseInt(maxCharsInputMainEl.value, 10) || 28) : 28;
      var maxLines = maxLinesSelectMainEl ? (parseInt(maxLinesSelectMainEl.value, 10) || 2) : 2;
      for (var c = 0; c < generatedCaptions.length; c++) {
        var cap = generatedCaptions[c], words = cap.words || [];
        for (var w = 0; w < words.length; w++) {
          var original = words[w].word, norm = normalizeWord(original);
          words[w].emphasis = !!(doKeywords && keywords[norm]);
          if (words[w].emphasis) emphasized++;
          if (doProfanity) { var clean = maskWord(words[w].word); if (clean !== words[w].word) { words[w].word = clean; masked++; } }
          // Keep emoji attached to its timed token. Adding a normal space
          // would create an extra rendered word without a timestamp.
          if (doEmoji && EMOJI[norm] && words[w].word.indexOf(EMOJI[norm]) === -1) { words[w].word += EMOJI[norm]; emojis++; }
        }
        if (!doKeywords) for (w = 0; w < words.length; w++) delete words[w].emphasis;
        if (doSpeakers) {
          var speaker = detectSpeaker(cap);
          if (speaker) {
            if (speakers[speaker] == null) speakers[speaker] = speakerCount++;
            cap.speaker = speaker; cap.speakerColor = SPEAKER_COLORS[speakers[speaker] % SPEAKER_COLORS.length];
          }
        } else { delete cap.speakerColor; }
        cap.text = doLines ? balancedText(words, maxChars, maxLines) : words.map(function(word) { return word.word; }).join(' ');
        if (words.length) { cap.start = Number(words[0].start); cap.end = Number(words[words.length - 1].end); }
      }
      var collisions = doCollisions ? repairCollisions() : 0;
      refreshSmartCaptions();
      smartStatus('Enhanced ' + generatedCaptions.length + ' captions  -  ' + emphasized + ' keywords  -  ' + emojis + ' emoji  -  ' + masked + ' masked  -  ' + collisions + ' collisions fixed.');
    });

    if (undoBtn) undoBtn.addEventListener('click', function() {
      if (!history) return;
      try { generatedCaptions = JSON.parse(history); history = null; undoBtn.disabled = true; refreshSmartCaptions(); smartStatus('Smart enhancement undone.'); }
      catch (_) { smartStatus('Undo data is unavailable.', true); }
    });

    var STYLE_PRESETS = {
      creator: { mode:'word', color:'#FFE44D', animate:true, anim:'pop', showHL:false, fontSize:42, cbg:false },
      karaoke: { mode:'word', color:'#63F58A', animate:true, anim:'pop', showHL:true, fontSize:40, cbg:false },
      clean:   { mode:'line', color:'#FFFFFF', animate:false, anim:'none', showHL:false, fontSize:34, cbg:false },
      podcast: { mode:'line', color:'#7CE7FF', animate:true, anim:'slide', showHL:false, fontSize:36, cbg:true }
    };
    if (presetBtn) presetBtn.addEventListener('click', function() {
      var p = STYLE_PRESETS[presetEl ? presetEl.value : 'creator'] || STYLE_PRESETS.creator;
      var s = _m4GetSettings();
      s.activeMode = p.mode; s.animate = p.animate; s.animType = p.anim; s.showHL = p.showHL; s.showCBG = p.cbg;
      s.fontSize = p.fontSize; s.typoOverrides = s.typoOverrides || {pre:{},cur:{},post:{}};
      s.fillOv = s.fillOv || {pre:{},cur:{},post:{}}; s.fillOv.cur = s.fillOv.cur || {}; s.fillOv.cur.color = p.color; s.fillOv.cur.type = 'solid'; s.fillOv.cur.opacity = 100;
      _m4ApplySettings(s); _m4SaveSettings(); _m4DrawPreview(); smartStatus('Applied ' + (presetEl.options[presetEl.selectedIndex].text || 'caption') + ' preset.');
      switchAcTab('apply');
    });

    document.querySelectorAll('[data-ac-safe-pos]').forEach(function(btn) {
      btn.addEventListener('click', function() { applySafePosition(btn.dataset.acSafePos); });
    });
    if (brandSave) brandSave.addEventListener('click', function() {
      var x = document.getElementById('ac-bar-pos-x'), y = document.getElementById('ac-bar-pos-y');
      try { localStorage.setItem(BRAND_KEY, JSON.stringify({ settings: _m4GetSettings(), x: x ? Number(x.value) : 50, y: y ? Number(y.value) : 86 })); smartStatus('Brand Caption Style saved.'); }
      catch (_) { smartStatus('Could not save Brand Style.', true); }
    });
    if (brandApply) brandApply.addEventListener('click', function() {
      try {
        var saved = JSON.parse(localStorage.getItem(BRAND_KEY) || 'null');
        if (!saved || !saved.settings) throw new Error('No saved Brand Style.');
        _m4ApplySettings(saved.settings); _m4SaveSettings(); _m4DrawPreview();
        var x = document.getElementById('ac-bar-pos-x'), y = document.getElementById('ac-bar-pos-y');
        if (x) { x.value = Math.max(10, Math.min(90, Number(saved.x) || 50)); x.dispatchEvent(new Event('change')); }
        if (y) { y.value = Math.max(10, Math.min(90, Number(saved.y) || 86)); y.dispatchEvent(new Event('change')); }
        smartStatus('Brand Caption Style applied.'); switchAcTab('apply');
      } catch (err) { smartStatus(err.message || 'Could not apply Brand Style.', true); }
    });
  })();

  // ── Public API ─────────────────────────────────────────────────────────────
  global.AutoCaptions = { init: function () { /* wired above */ } };

}(window));
