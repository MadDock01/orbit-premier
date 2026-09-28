/**
 * srtAnimatorUI.js — UI Controller for SRT Animator
 * Handles user interface for SRT import and animation style selection
 */

(function (global) {
  'use strict';

  // ── State ──────────────────────────────────────────────────────────────────
  var uiState = {
    currentStep: 'import', // import, settings, preview, export
    selectedFile: null,
    selectedStyle: 'fade',
    previewCaption: null,
    isProcessing: false
  };

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

  // ── DOM Elements ─────────────────────────────────────────────────────────────
  var srtPanel = null;
  var fileInput = null;
  var styleGrid = null;
  var previewCanvas = null;
  var importBtn = null;
  var exportBtn = null;
  var progressBar = null;

  // ── Initialize UI ───────────────────────────────────────────────────────────
  function initUI() {
    // Create SRT Animator panel if it doesn't exist
    if (!document.getElementById('srt-animator-panel')) {
      createSRTPanel();
    }
    
    srtPanel = document.getElementById('srt-animator-panel');
    fileInput = document.getElementById('srt-file-input');
    styleGrid = document.getElementById('style-grid');
    previewCanvas = document.getElementById('preview-canvas');
    importBtn = document.getElementById('srt-import-btn');
    exportBtn = document.getElementById('srt-export-btn');
    progressBar = document.getElementById('srt-progress-bar');
    
    bindEvents();
    renderStyleGrid();
  }

  function createSRTPanel() {
    var panelHTML = `
      <div id="srt-animator-panel" class="srt-animator-panel hidden">
        <div class="srt-header">
          <div class="srt-header-copy">
            <span class="srt-eyebrow">ORBIT STUDIO</span>
            <h2>SRT Animator</h2>
            <p>Import subtitles, choose motion, preview, then send to Premiere.</p>
          </div>
          <div class="srt-stepper" aria-label="SRT Animator progress">
            <span class="active" data-srt-step="import"><i>1</i>Import</span>
            <b></b>
            <span data-srt-step="styles"><i>2</i>Style</span>
            <b></b>
            <span data-srt-step="preview"><i>3</i>Preview</span>
          </div>
          <button type="button" class="srt-close-btn" id="srt-close-btn" title="Close" aria-label="Close">&times;</button>
        </div>
        
        <!-- Step 1: Import SRT -->
        <div class="srt-step" id="step-import">
          <div class="srt-section-head">
            <span>STEP 1</span>
            <h3>Import subtitle file</h3>
            <p>Choose a SubRip (.srt) file.</p>
          </div>
          <div class="srt-upload-zone" id="srt-upload-zone">
            <div class="upload-icon">
              <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/><path d="M12 18v-6"/><path d="m9 15 3-3 3 3"/></svg>
            </div>
            <strong>Drop your subtitle file here</strong>
            <p>SRT files are processed locally.</p>
            <input type="file" id="srt-file-input" accept=".srt" style="display: none;">
            <button type="button" class="btn btn-primary" id="srt-browse-btn">Browse files</button>
          </div>
          <div class="srt-file-info" id="srt-file-info" style="display: none;">
            <span class="srt-file-type">SRT</span>
            <span class="file-name" id="srt-file-name"></span>
            <span class="srt-file-ready">Ready</span>
            <button type="button" class="btn btn-small" id="srt-remove-file">Remove</button>
          </div>
        </div>

        <!-- Step 2: Animation Style -->
        <div class="srt-step hidden" id="step-styles">
          <div class="srt-section-head">
            <span>STEP 2</span>
            <h3>Select animation style</h3>
            <p>Pick the motion treatment that will be used for each caption.</p>
          </div>
          <div class="style-grid" id="style-grid"></div>
          <div class="style-details" id="style-details">
            <div class="srt-detail-label">Selected style</div>
            <h4 id="style-name">Style Name</h4>
            <p id="style-description">Style description</p>
          </div>
        </div>

        <!-- Step 3: Preview -->
        <div class="srt-step hidden" id="step-preview">
          <div class="srt-section-head">
            <span>STEP 3</span>
            <h3>Preview captions</h3>
            <p>Review the selected animation before exporting to Premiere.</p>
          </div>
          <div class="preview-container">
            <canvas id="preview-canvas" width="640" height="360"></canvas>
            <div class="preview-controls">
              <button type="button" class="btn btn-small" id="preview-prev">&#x2039; Previous</button>
              <span id="preview-counter">1 / 10</span>
              <button type="button" class="btn btn-small" id="preview-next">Next &#x203A;</button>
              <button type="button" class="btn btn-small" id="preview-play">&#x25B6; Play</button>
            </div>
          </div>
          <div class="preview-text" id="preview-text">
            <span>Caption text</span>
            <p id="preview-caption-text">Caption text will appear here</p>
          </div>
        </div>

        <!-- Navigation -->
        <div class="srt-nav">
          <button type="button" class="btn btn-secondary" id="srt-back-btn" style="display: none;">Back</button>
          <span class="srt-nav-hint">Files and previews stay on this computer.</span>
          <button type="button" class="btn btn-primary" id="srt-next-btn" disabled>Continue</button>
          <button type="button" class="btn btn-success" id="srt-export-btn" style="display: none;">Open in Caption Editor</button>
        </div>

        <!-- Progress -->
        <div class="srt-progress" id="srt-progress" style="display: none;">
          <div class="progress-bar">
            <div class="progress-fill" id="srt-progress-fill"></div>
          </div>
          <p class="progress-text" id="srt-progress-text">Processing...</p>
        </div>
      </div>
    `;

    // Append to body
    var tempDiv = document.createElement('div');
    tempDiv.innerHTML = panelHTML;
    document.body.appendChild(tempDiv.firstElementChild);
  }

  function updateStepIndicator(stepId) {
    var order = ['import', 'styles', 'preview'];
    var activeIndex = order.indexOf(stepId);
    var indicators = document.querySelectorAll('#srt-animator-panel [data-srt-step]');
    for (var i = 0; i < indicators.length; i++) {
      var index = order.indexOf(indicators[i].getAttribute('data-srt-step'));
      indicators[i].classList.toggle('active', index === activeIndex);
      indicators[i].classList.toggle('done', index < activeIndex);
    }
  }

  function renderStyleGrid() {
    if (!styleGrid || !global.SrtAnimator) return;
    
    var styles = global.SrtAnimator.getAnimationStyles();
    styleGrid.innerHTML = '';
    
    styles.forEach(function (style) {
      var card = document.createElement('div');
      card.className = 'style-card' + (style.id === uiState.selectedStyle ? ' selected' : '');
      card.dataset.styleId = style.id;
      card.innerHTML = `
        <div class="style-preview" id="preview-${style.id}"></div>
        <div class="style-info">
          <h4>${style.label}</h4>
          <p>${style.description}</p>
        </div>
      `;
      
      card.addEventListener('click', function () {
        selectStyle(style.id);
      });
      
      styleGrid.appendChild(card);
      
      // Generate mini preview
      generateMiniPreview(style.id);
    });
    var initialStyle = global.SrtAnimator.getAnimationStyle(uiState.selectedStyle);
    if (initialStyle) {
      document.getElementById('style-name').textContent = initialStyle.label;
      document.getElementById('style-description').textContent = initialStyle.description;
    }
  }

  function generateMiniPreview(styleId) {
    if (!global.SrtAnimator) return;
    
    var previewEl = document.getElementById('preview-' + styleId);
    if (!previewEl) return;
    
    var canvas = document.createElement('canvas');
    canvas.width = 160;
    canvas.height = 90;
    previewEl.appendChild(canvas);
    
    // Apply style and render sample text
    var style = global.SrtAnimator.getAnimationStyle(styleId);
    if (style) {
      global.SrtAnimator.applyAnimationStyle(styleId);
      // Render sample frame (simplified)
      var ctx = canvas.getContext('2d');
      ctx.fillStyle = '#1a1a1a';
      ctx.fillRect(0, 0, 160, 90);
      ctx.fillStyle = '#ffffff';
      ctx.font = '14px Arial';
      ctx.textAlign = 'center';
      ctx.fillText('Sample', 80, 45);
    }
  }

  function selectStyle(styleId) {
    uiState.selectedStyle = styleId;
    
    // Update visual selection
    var cards = styleGrid.querySelectorAll('.style-card');
    cards.forEach(function (card) {
      card.classList.toggle('selected', card.dataset.styleId === styleId);
    });
    
    // Update details
    var style = global.SrtAnimator.getAnimationStyle(styleId);
    if (style) {
      document.getElementById('style-name').textContent = style.label;
      document.getElementById('style-description').textContent = style.description;
    }
    
    // Enable next button
    document.getElementById('srt-next-btn').disabled = false;
  }

  function decodeNativeSubtitle(buffer) {
    if (!buffer || !buffer.length) return '';
    if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
      return buffer.slice(2).toString('utf16le');
    }
    if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
      var swapped = Buffer.alloc(buffer.length - 2);
      for (var i = 2, j = 0; i + 1 < buffer.length; i += 2, j += 2) {
        swapped[j] = buffer[i + 1]; swapped[j + 1] = buffer[i];
      }
      return swapped.toString('utf16le');
    }
    return buffer.toString('utf8').replace(/^\uFEFF/, '');
  }

  function applyNativeSubtitle(filePath) {
    try {
      if (typeof require !== 'function') throw new Error('Local file access is unavailable.');
      var fs = require('fs');
      var fileName = String(filePath).split(/[\\/]/).pop();
      var extension = fileName.substring(fileName.lastIndexOf('.')).toLowerCase();
      if (extension !== '.srt') throw new Error('Choose an SRT file.');
      uiState.selectedFile = { name: fileName, path: filePath };
      uiState.fileContent = decodeNativeSubtitle(fs.readFileSync(filePath));
      document.getElementById('srt-file-name').textContent = fileName;
      document.getElementById('srt-file-info').style.display = 'grid';
      document.getElementById('srt-upload-zone').style.display = 'none';
      document.getElementById('srt-next-btn').disabled = !uiState.fileContent;
    } catch (err) {
      var message = 'Could not read subtitle file: ' + (err && err.message ? err.message : String(err));
      if (typeof global.showAlert === 'function') global.showAlert(message);
      else alert(message);
    }
  }

  function openNativeSubtitlePicker() {
    try {
      var cepFs = global.cep && global.cep.fs;
      if (!cepFs || typeof cepFs.showOpenDialogEx !== 'function') return false;
      var picked = cepFs.showOpenDialogEx(
        false, false, 'Import SRT', '', ['srt']
      );
      if (picked && picked.err === 0 && picked.data && picked.data.length) {
        applyNativeSubtitle(picked.data[0]);
      }
      return true;
    } catch (err) {
      console.warn('[SRT Animator] Native picker failed; using browser fallback:', err);
      return false;
    }
  }

  function bindEvents() {
    // File input
    if (fileInput) {
      fileInput.addEventListener('change', handleFileSelect);
    }

    // Browse button
    var browseBtn = document.getElementById('srt-browse-btn');
    if (browseBtn) {
      browseBtn.addEventListener('click', function () {
        if (!openNativeSubtitlePicker()) fileInput.click();
      });
    }

    // Upload zone drag & drop
    var uploadZone = document.getElementById('srt-upload-zone');
    if (uploadZone) {
      uploadZone.addEventListener('dragover', function (e) {
        e.preventDefault();
        uploadZone.classList.add('drag-over');
      });
      
      uploadZone.addEventListener('dragleave', function () {
        uploadZone.classList.remove('drag-over');
      });
      
      uploadZone.addEventListener('drop', function (e) {
        e.preventDefault();
        uploadZone.classList.remove('drag-over');
        var files = e.dataTransfer.files;
        if (files.length > 0) {
          handleFile(files[0]);
        }
      });
    }

    // Navigation buttons
    var nextBtn = document.getElementById('srt-next-btn');
    if (nextBtn) {
      nextBtn.addEventListener('click', goToNextStep);
    }

    var backBtn = document.getElementById('srt-back-btn');
    if (backBtn) {
      backBtn.addEventListener('click', goToPreviousStep);
    }

    var exportBtn = document.getElementById('srt-export-btn');
    if (exportBtn) {
      exportBtn.addEventListener('click', exportToPremiere);
    }

    // Close button
    var closeBtn = document.getElementById('srt-close-btn');
    if (closeBtn) {
      closeBtn.addEventListener('click', closePanel);
    }

    // Remove file button
    var removeFileBtn = document.getElementById('srt-remove-file');
    if (removeFileBtn) {
      removeFileBtn.addEventListener('click', removeFile);
    }
  }

  function handleFileSelect(e) {
    var files = e.target.files;
    if (files.length > 0) {
      handleFile(files[0]);
    }
  }

  function handleFile(file) {
    if (!file) return;
    
    var validExtensions = ['.srt'];
    var fileExtension = file.name.substring(file.name.lastIndexOf('.')).toLowerCase();
    
    if (validExtensions.indexOf(fileExtension) === -1) {
      alert('Please select a valid SRT file.');
      return;
    }

    uiState.selectedFile = file;
    
    // Update UI
    document.getElementById('srt-file-name').textContent = file.name;
    document.getElementById('srt-file-info').style.display = 'grid';
    document.getElementById('srt-upload-zone').style.display = 'none';
    document.getElementById('srt-next-btn').disabled = false;
    
    // Read file content
    var reader = new FileReader();
    reader.onload = function (e) {
      uiState.fileContent = e.target.result;
    };
    reader.readAsText(file);
  }

  function removeFile() {
    uiState.selectedFile = null;
    uiState.fileContent = null;
    
    document.getElementById('srt-file-name').textContent = '';
    document.getElementById('srt-file-info').style.display = 'none';
    document.getElementById('srt-upload-zone').style.display = 'flex';
    document.getElementById('srt-next-btn').disabled = true;
    
    if (fileInput) {
      fileInput.value = '';
    }
  }

  function goToNextStep() {
    switch (uiState.currentStep) {
      case 'import':
        showStep('styles');
        uiState.currentStep = 'styles';
        break;
      case 'styles':
        showStep('preview');
        uiState.currentStep = 'preview';
        generatePreview();
        break;
      case 'preview':
        // Final step - show export button
        document.getElementById('srt-next-btn').style.display = 'none';
        document.getElementById('srt-export-btn').style.display = 'inline-block';
        break;
    }
    
    updateNavigation();
  }

  function goToPreviousStep() {
    switch (uiState.currentStep) {
      case 'styles':
        showStep('import');
        uiState.currentStep = 'import';
        break;
      case 'preview':
        showStep('styles');
        uiState.currentStep = 'styles';
        break;
    }
    
    updateNavigation();
  }

  function showStep(stepId) {
    // Hide all steps
    document.querySelectorAll('.srt-step').forEach(function (step) {
      step.classList.add('hidden');
    });
    
    // Show target step
    var targetStep = document.getElementById('step-' + stepId);
    if (targetStep) {
      targetStep.classList.remove('hidden');
    }
    updateStepIndicator(stepId);
  }

  function updateNavigation() {
    var backBtn = document.getElementById('srt-back-btn');
    var nextBtn = document.getElementById('srt-next-btn');
    
    backBtn.style.display = uiState.currentStep !== 'import' ? 'inline-block' : 'none';
    
    if (uiState.currentStep === 'preview') {
      nextBtn.style.display = 'none';
      document.getElementById('srt-export-btn').style.display = 'inline-block';
    } else {
      nextBtn.style.display = 'inline-block';
      nextBtn.textContent = uiState.currentStep === 'styles' ? 'Open preview' : 'Continue';
      document.getElementById('srt-export-btn').style.display = 'none';
    }
  }

  function generatePreview() {
    if (!global.SrtAnimator || !uiState.fileContent) return;
    
    try {
      // Apply selected style
      global.SrtAnimator.applyAnimationStyle(uiState.selectedStyle);
      
      // Process SRT
      var result = global.SrtAnimator.processSrtFile(uiState.fileContent, global.SrtAnimator.getSettings());
      
      if (result.success && result.results.length > 0) {
        uiState.previewCaption = result.results[0];
        renderPreviewFrame(uiState.previewCaption, 0);
        
        // Update caption text
        document.getElementById('preview-caption-text').textContent = uiState.previewCaption.text;
      }
    } catch (e) {
      console.error('Preview generation error:', e);
      alert('Error generating preview: ' + e.message);
    }
  }

  function renderPreviewFrame(captionData, frameIndex) {
    if (!previewCanvas || !captionData || !captionData.frames) return;
    
    var ctx = previewCanvas.getContext('2d');
    var img = new Image();
    
    img.onload = function () {
      ctx.clearRect(0, 0, previewCanvas.width, previewCanvas.height);
      ctx.drawImage(img, 0, 0, previewCanvas.width, previewCanvas.height);
    };
    
    img.src = captionData.frames[frameIndex];
  }

  // The old SRT Animator exporter sent browser-only canvas frames to a host
  // placeholder.  Route imported timed subtitles through the real Caption
  // Editor instead: it keeps each SRT timestamp, displays the cue list, and
  // uses the same template/timeline pipeline as all other Orbit captions.
  function exportToPremiere() {
    if (uiState.isProcessing) return;
    if (!uiState.fileContent) {
      alert('Choose an SRT file first.');
      return;
    }

    var importer = global.OrbitSubtitleImport;
    if (importer && typeof importer.importData === 'function') {
      uiState.isProcessing = true;
      showProgress(true, 'Importing timed captions…');
      try {
        var fileName = (uiState.selectedFile && uiState.selectedFile.name) || 'Imported subtitles';
        importer.importData(uiState.fileContent, fileName);
        // importData owns the actual async caption preparation. Switch to the
        // existing editor so the user can see timestamps, choose a template,
        // and Apply it to the selected Premiere track.
        switchToCaptionsPanel();
        closePanel();
      } catch (e) {
        alert('Could not import subtitles: ' + (e && e.message ? e.message : String(e)));
      }
      showProgress(false);
      uiState.isProcessing = false;
      return;
    }

    alert('Caption Editor is unavailable in this panel session. Reload the extension and try again; no timeline changes were made.');
  }
  function showProgress(show, text) {
    var progressEl = document.getElementById('srt-progress');
    var progressText = document.getElementById('srt-progress-text');
    
    if (show) {
      progressEl.style.display = 'block';
      if (text) progressText.textContent = text;
    } else {
      progressEl.style.display = 'none';
    }
  }

  function openPanel() {
    if (!srtPanel) {
      initUI();
    }
    
    srtPanel.classList.remove('hidden');
    uiState.currentStep = 'import';
    showStep('import');
    updateNavigation();
  }

  function closePanel() {
    if (srtPanel) {
      srtPanel.classList.add('hidden');
    }
    
    // Reset state
    uiState = {
      currentStep: 'import',
      selectedFile: null,
      selectedStyle: 'fade',
      previewCaption: null,
      isProcessing: false
    };
    
    removeFile();
  }

  // ── Public API ───────────────────────────────────────────────────────────────
  global.SrtAnimatorUI = {
    init: initUI,
    open: openPanel,
    close: closePanel,
    isOpen: function () { return srtPanel && !srtPanel.classList.contains('hidden'); }
  };

})(typeof window !== 'undefined' ? window : global);
