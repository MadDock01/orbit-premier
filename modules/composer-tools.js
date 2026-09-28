/**
 * Timeline and clip actions for Orbit Premiere, driven by #orbitRightDock.
 *
 * The Tools rail (#composerToolsView) was removed; its cut/trim/matte actions
 * live on the dock instead. Everything that only existed to render the old
 * panel — MOGRT parameter rows, diagnostics, the text generator — went with
 * it. Ripple Delete was dropped afterwards (its host endpoint is still in
 * jsx/hostscript.jsx). Align and Anchor were dropped too, then brought back on
 * the dock once Align measured the clip's real bounds instead of writing the
 * pad spot straight into Position.
 *
 * The dock itself has moved twice: a bar along the bottom, then that plus a
 * transform bar under the header, and now a single vertical rail down the
 * right-hand side. Hence DOCKS below rather than a hardcoded id.
 */
(function (global) {
  'use strict';
  var current = null;

  function $(id) { return document.getElementById(id); }

  function host(name, args, timeout) {
    if (global.OrbitCore && global.OrbitCore.host) return global.OrbitCore.host.call(name, args || [], { timeout: timeout || 15000 });
    if (!global.CEP || typeof global.CEP.evalScript !== 'function') return Promise.reject(new Error('CEP bridge unavailable'));
    return global.CEP.evalScript(name, args || [], timeout || 15000);
  }

  // One dock, on the right. The selector is still a list because the status
  // and busy helpers below fan out over it, and because a second dock has
  // been added and removed twice already.
  var DOCKS = '#orbitRightDock';

  function status(message, error) {
    var lines = document.querySelectorAll(DOCKS.replace(/(#[\w-]+)/g, '$1 .orbit-dock-status'));
    for (var i = 0; i < lines.length; i++) {
      lines[i].textContent = message || '';
      lines[i].classList.toggle('error', !!error);
    }
  }

  function busy(on) {
    var buttons = document.querySelectorAll(DOCKS.replace(/(#[\w-]+)/g, '$1 button'));
    for (var i = 0; i < buttons.length; i++) buttons[i].disabled = !!on;
  }

  // Kept so the dock can report "N selected clip(s)" and so ComposerTools.refresh
  // stays part of the public API that utils/orbitCore.js health-checks.
  function refresh() {
    return host('composerInspectSelection', [], 12000).then(function (res) {
      current = res || {};
      if (current.error) throw new Error(current.error);
      return current;
    }).catch(function (err) { current = null; status(err.message, true); return null; });
  }

  function timeline(action, sourceButton) {
    var labels = { 'cut-at-playhead': 'Cutting selected clips…', 'trim-before': 'Trimming before playhead…', 'trim-after': 'Trimming after playhead…' };
    var names = { 'cut-at-playhead': 'Cut at Playhead', 'trim-before': 'Trim Before Playhead', 'trim-after': 'Trim After Playhead' };
    busy(true); status(labels[action] || 'Updating timeline…');
    // Cut and trim are one Ctrl+Z away; a modal plus a whole duplicated
    // sequence per click made routine editing unusable. Nothing left on the
    // dock is destructive, so nothing here confirms.
    var destructive = false;
    var operation = global.OrbitCore ? global.OrbitCore.run({
      id: 'timeline-' + String(action || 'action'), title: names[action] || 'Timeline Action', button: sourceButton || null,
      busyLabel: 'Applying…', startMessage: labels[action] || 'Updating timeline…', confirm: destructive,
      danger: destructive, safetyCopy: destructive,
      preflight: function (context) { return context.host('composerInspectSelection', [], { timeout: 12000 }).then(function (selection) { if (!selection || !selection.count) throw new Error('Select one or more timeline clips first. No safety copy created.'); }); },
      preview: function () { var count = current && current.count ? current.count : 'the'; return (names[action] || 'Apply this action') + ' on ' + count + ' selected clip' + (count === 1 ? '' : 's') + '. Locked clips will be skipped.'; },
      execute: function (context) { return context.host('composerTimelineAction', [String(action || '')], { timeout: 30000 }); },
      successMessage: function (res) { return (res && res.message) || (((res && res.changed) || 0) + ' clip(s) updated.'); },
      toast: false, onStatus: function (phase, value, isError) { status(value, isError); }
    }) : host('composerTimelineAction', [String(action || '')], 30000);
    operation
      .then(function (res) {
        if (res && res.cancelled) return;
        if (!res || res.error) throw new Error((res && res.error) || 'Timeline action failed');
        var message = res.message || ((res.changed || 0) + ' clip' + (res.changed === 1 ? '' : 's') + ' updated.');
        var hasErrors = !!(res.errors && res.errors.length);
        if (hasErrors) message += ' · ' + res.errors.length + ' skipped';
        return refresh().then(function () { status(message, hasErrors); });
      })
      .catch(function (err) { status(err.message, true); })
      .then(function () { busy(false); });
  }

  function writeMattePng(spec, color) {
    var w = Math.max(16, Math.round(Number(spec.w) || 1920));
    var h = Math.max(16, Math.round(Number(spec.h) || 1080));
    var canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h;
    var context = canvas.getContext('2d'); context.fillStyle = color; context.fillRect(0, 0, w, h);
    var raw = canvas.toDataURL('image/png').split(',')[1];
    var req = global.require || (typeof require === 'function' ? require : null);
    if (!req) throw new Error('Local file access is unavailable.');
    var fs = req('fs'), path = req('path'), os = req('os'), BufferCtor = req('buffer').Buffer;
    // Imported media must survive OS temporary-file cleanup.
    var folder = path.join(os.homedir(), 'Documents', 'CompX-Orbit-Premiere', 'Generated Media', 'color-mattes');
    if (!fs.existsSync(folder)) fs.mkdirSync(folder, { recursive: true });
    var hex = String(color || '#000000').replace('#', '').toLowerCase();
    var filePath = path.join(folder, 'matte-' + hex + '-' + w + 'x' + h + '.png');
    fs.writeFileSync(filePath, BufferCtor.from(raw, 'base64'));
    return filePath;
  }

  function createMatte() {
    var swatch = $('ctMatteColor'), lengthInput = $('ctMatteDuration');
    var color = (swatch && swatch.value) || '#111111';
    var duration = Math.max(0.1, Math.min(3600, Number(lengthInput && lengthInput.value) || 5));
    busy(true); status('Preparing color matte…');
    host('getActiveSequenceSpec', [], 12000)
      .then(function (spec) {
        if (!spec || spec.error) throw new Error((spec && spec.error) || 'Open an active sequence first.');
        var filePath = writeMattePng(spec, color);
        status('Adding color matte at playhead…');
        return host('composerCreateColorMatte', [filePath, duration], 30000);
      })
      .then(function (res) {
        if (!res || res.error) throw new Error((res && res.error) || 'Color Matte creation failed');
        status('Color Matte created on V' + ((res.track || 0) + 1) + '.');
        return refresh();
      })
      .catch(function (err) { status(err.message, true); })
      .then(function () { busy(false); });
  }

  function createAdj() {
    var lengthInput = $('ctAdjDuration');
    var duration = Math.max(0.1, Math.min(3600, Number(lengthInput && lengthInput.value) || 5));
    busy(true); status('Creating adjustment layer...');
    host('composerCreateAdjustmentLayer', [duration], 30000)
      .then(function (res) {
        if (!res || res.error || res.ok === false) throw new Error((res && (res.error || res.message)) || 'Adjustment layer failed');
        status(res.message || 'Done.');
        return refresh();
      })
      .catch(function (err) { status(err.message, true); })
      .then(function () { busy(false); });
  }

  // One shape for every dock action that is a single host call: start message,
  // one endpoint, one sentence back. `done` turns the host result into that
  // sentence so each action reports what actually happened rather than "Done".
  function simpleAction(endpoint, args, starting, done, timeout) {
    busy(true); status(starting);
    return host(endpoint, args || [], timeout || 30000)
      .then(function (res) {
        if (!res || res.error) throw new Error((res && res.error) || 'The action failed.');
        var hadErrors = !!(res.errors && res.errors.length);
        var message = done(res);
        if (hadErrors) message += ' · ' + res.errors.length + ' skipped';
        return refresh().then(function () { status(message, hadErrors); return res; });
      })
      .catch(function (err) { status(err.message, true); return null; })
      .then(function (res) { busy(false); return res; });
  }

  var plural = function (n, word) { return n + ' ' + word + (n === 1 ? '' : 's'); };

  function nest() {
    return simpleAction('composerNest', [''], 'Nesting selected clips…', function (res) {
      return 'Nested ' + plural(res.nested || 0, 'clip') + (res.name ? ' into “' + res.name + '”.' : '.');
    });
  }

  /**
   * Unnest asks the host what it would do BEFORE it does anything, because the
   * one thing the user has to be warned about — effects applied inside the
   * nest, which no Premiere API can copy out — is only knowable by looking
   * inside, and a warning after the rebuild would be an apology.
   */
  function unnest(sourceButton) {
    var plan = null;
    if (!global.OrbitCore) {
      busy(true); status('Reading the nest…');
      return host('composerUnnest', ['inspect'], 30000)
        .then(function (res) {
          if (!res || res.error) throw new Error((res && res.error) || 'Unnest failed');
          if (!global.confirm(res.message + '\n\nContinue?')) return null;
          return host('composerUnnest', ['apply'], 60000);
        })
        .then(function (res) {
          if (res === null) { status('Unnest cancelled.'); return; }
          if (!res || res.error) throw new Error((res && res.error) || 'Unnest failed');
          status(unnestMessage(res), !!(res.errors && res.errors.length));
        })
        .catch(function (err) { status(err.message, true); })
        .then(function () { busy(false); });
    }
    return global.OrbitCore.run({
      id: 'timeline-unnest', title: 'Unnest', button: sourceButton || null,
      busyLabel: 'Unnesting…', startMessage: 'Reading the nest…',
      confirm: true, danger: true, safetyCopy: true,
      preflight: function (context) {
        return context.host('composerUnnest', ['inspect'], { timeout: 30000 }).then(function (res) {
          if (!res || res.error) throw new Error((res && res.error) || 'That is not a nested clip.');
          plan = res;
        });
      },
      preview: function () { return plan ? plan.message : 'Rebuild this nest on the timeline and delete the nest clip.'; },
      execute: function (context) { return context.host('composerUnnest', ['apply'], { timeout: 60000 }); },
      successMessage: unnestMessage,
      toast: false, onStatus: function (phase, value, isError) { status(value, isError); }
    }).then(function (res) {
      if (!res || res.cancelled) return;
      if (res.error) { status(res.error, true); return; }
      return refresh().then(function () { status(unnestMessage(res), !!(res.errors && res.errors.length)); });
    }).catch(function (err) { status(err.message, true); });
  }

  function unnestMessage(res) {
    var message = 'Unnested ' + plural(res.placed || 0, 'clip');
    if (res.total && res.placed !== res.total) message += ' of ' + res.total;
    message += '.';
    if (res.effectsLost) message += ' ' + plural(res.effectsLost, 'effect') + ' inside the nest could not be carried over.';
    return message;
  }

  function flip(axis) {
    var label = axis === 'vertical' ? 'Vertical' : 'Horizontal';
    return simpleAction('composerFlip', [axis], label + ' flip…', function (res) {
      var parts = [];
      if (res.applied) parts.push(label + ' flip on ' + plural(res.applied, 'clip'));
      if (res.removed) parts.push('removed from ' + plural(res.removed, 'clip'));
      return (parts.join(', ') || 'Flip updated') + '.';
    });
  }

  function fitToFrame(mode) {
    var labels = { fit: 'Fitting to frame…', fill: 'Filling the frame…', reset: 'Resetting scale…' };
    return simpleAction('composerFitToFrame', [mode], labels[mode] || 'Scaling…', function (res) {
      var what = mode === 'reset' ? 'Scale reset on ' : (mode === 'fill' ? 'Filled the frame on ' : 'Fitted to frame on ');
      return what + plural(res.changed || 0, 'clip') + '.';
    });
  }

  var PAD_NAMES = {
    'top-left': 'top left', 'top-center': 'top centre', 'top-right': 'top right',
    'middle-left': 'middle left', 'center': 'centre', 'middle-right': 'middle right',
    'bottom-left': 'bottom left', 'bottom-center': 'bottom centre', 'bottom-right': 'bottom right'
  };

  // Mark the last cell used on each pad so the user can see what they chose.
  function markPad(button) {
    var pad = button && button.closest ? button.closest('.orbit-dock-pad') : null;
    if (!pad) return;
    var cells = pad.querySelectorAll('button');
    for (var i = 0; i < cells.length; i++) cells[i].classList.toggle('is-last', cells[i] === button);
  }

  function align(mode) {
    var where = PAD_NAMES[mode] || mode;
    return simpleAction('composerAlignSelection', [mode], 'Aligning to ' + where + '…', function (res) {
      var parts = [];
      if (res.moved) parts.push('Aligned ' + plural(res.moved, 'clip') + ' to ' + where);
      if (res.alreadyThere) parts.push(plural(res.alreadyThere, 'clip') + ' already there');
      return (parts.join(' · ') || 'Nothing to align') + '.';
    });
  }

  function setAnchor(mode) {
    var where = PAD_NAMES[mode] || mode;
    return simpleAction('composerSetAnchorPoint', [mode], 'Moving the anchor to ' + where + '…', function (res) {
      return 'Anchor set to ' + where + ' on ' + plural(res.changed || 0, 'clip') + '.';
    });
  }

  function pasteImage() {
    if (!global.DockExtras) { status('Paste Image is unavailable: dock-extras.js did not load.', true); return Promise.resolve(); }
    busy(true); status('Reading the clipboard…');
    return global.DockExtras.clipboardImage()
      .then(function (found) {
        status('Inserting the image at the playhead…');
        return host('composerInsertImageAtPlayhead', [found.path, 5], 30000).then(function (res) {
          if (!res || res.error) throw new Error((res && res.error) || 'The image could not be inserted.');
          return refresh().then(function () {
            status('Pasted on V' + ((res.track || 0) + 1) + (found.from === 'file' ? ' from the copied file.' : '.'));
          });
        });
      })
      .catch(function (err) { status(err.message, true); })
      .then(function () { busy(false); });
  }

  function guides(aspectKey) {
    if (!global.DockExtras) { status('Guides are unavailable: dock-extras.js did not load.', true); return Promise.resolve(); }
    busy(true); status('Drawing the ' + global.DockExtras.aspects[aspectKey].label + ' guides…');
    // The overlay is drawn at the sequence's own frame size, so the sequence
    // has to answer before there is anything to draw.
    return host('getActiveSequenceSpec', [], 12000)
      .then(function (spec) {
        if (!spec || spec.error) throw new Error((spec && spec.error) || 'Open an active sequence first.');
        var file = global.DockExtras.writeGuidePng(spec, aspectKey);
        return host('composerInsertGuides', [file, global.DockExtras.aspects[aspectKey].label], 30000);
      })
      .then(function (res) {
        if (!res || res.error) throw new Error((res && res.error) || 'The guides could not be inserted.');
        return refresh().then(function () { status(res.aspect + ' guides on V' + ((res.track || 0) + 1) + '. Remove them before export.'); });
      })
      .catch(function (err) { status(err.message, true); })
      .then(function () { busy(false); });
  }

  function guidesOff() {
    return simpleAction('composerRemoveGuides', [], 'Removing guides…', function (res) {
      return res.removed ? ('Removed ' + plural(res.removed, 'guide clip') + '.') : 'No guide clips were on the timeline.';
    });
  }

  function createSequence(mode) {
    var names = { selection: 'CompX Sequence', '16x9': 'CompX 16x9', '9x16': 'CompX 9x16' };
    var starting = mode === 'selection' ? 'Creating a sequence from the selection…' : 'Creating a blank sequence…';
    return simpleAction('composerCreateSequence', [mode, names[mode]], starting, function (res) {
      if (mode === 'selection') return 'Created “' + res.name + '” from ' + plural(res.from || 0, 'clip') + '.';
      if (res.resized === false) return 'Created “' + res.name + '”, but Premiere kept its default frame size.';
      return 'Created “' + res.name + '” at ' + res.width + '×' + res.height + '.';
    });
  }

  /**
   * The rail starts where the panel's content does, not under the header.
   * A fixed top would only be right for one view at one width: the library's
   * toolbars alone range from 79px to 129px tall depending on how narrow the
   * panel is, and every view has its own chrome. So the rail is measured
   * against whatever the active view marks with data-dock-anchor, and falls
   * back to the view's own top, then to the header.
   */
  function railTopTarget() {
    var views = document.querySelectorAll('#panel-sfx > div');
    for (var i = 0; i < views.length; i++) {
      var view = views[i];
      if (!view.offsetParent && view.style.display === 'none') continue;
      var marked = view.hasAttribute && view.hasAttribute('data-dock-anchor')
        ? view : view.querySelector('[data-dock-anchor]');
      if (marked && marked.offsetParent) return marked;
      if (view.offsetParent) return view;
    }
    return null;
  }

  function syncRailTop() {
    var rail = $('orbitRightDock'), app = document.getElementById('app');
    if (!rail || !app) return;
    var target = railTopTarget();
    if (!target) return;
    var top = Math.round(target.getBoundingClientRect().top - app.getBoundingClientRect().top);
    // Never above the header, and never so far down that the rail has no room
    // left to draw itself in.
    var limit = Math.max(0, app.clientHeight - 90);
    top = Math.max(0, Math.min(top, limit));
    if (rail.getAttribute('data-rail-top') === String(top)) return;
    rail.setAttribute('data-rail-top', String(top));
    rail.style.top = top + 'px';
  }

  function watchRailTop() {
    syncRailTop();
    var panel = document.getElementById('panel-sfx');
    if (window.ResizeObserver && panel) {
      try { new ResizeObserver(syncRailTop).observe(panel); } catch (ignore) {}
    }
    window.addEventListener('resize', syncRailTop);
    // Switching rails swaps which view is displayed, which no resize fires for.
    if (window.MutationObserver && panel) {
      try {
        new MutationObserver(syncRailTop).observe(panel, {
          attributes: true, attributeFilter: ['style', 'class'], subtree: true
        });
      } catch (ignore) {}
    }
    // The library grid and its toolbars settle a frame or two after boot.
    setTimeout(syncRailTop, 120);
    setTimeout(syncRailTop, 600);
  }

  /**
   * Puts a pop to the LEFT of its rail button and centres it on that button,
   * then clamps it into the window. Both clamps matter: the rail runs the
   * full height of the panel, so its lowest buttons would open a pop off the
   * bottom, and a narrow panel has no room for a 168px pop beside a 32px
   * rail, where it has to sit over the content instead of off-screen.
   */
  function placePop(pop, button) {
    var rect = button.getBoundingClientRect();
    var width = pop.offsetWidth || 168, height = pop.offsetHeight || 96;
    var vw = window.innerWidth || document.documentElement.clientWidth || 0;
    var vh = window.innerHeight || document.documentElement.clientHeight || 0;

    var left = rect.left - width - 8;
    if (left < 6) left = Math.max(6, vw - width - 6);
    pop.style.left = Math.round(left) + 'px';

    var top = rect.top + rect.height / 2 - height / 2;
    top = Math.max(6, Math.min(top, vh - height - 6));
    pop.style.top = Math.round(top) + 'px';
    pop.style.bottom = 'auto';
    pop.style.transform = 'none';
  }

  function closeDockDrawers(except) {
    var drawers = document.querySelectorAll(DOCKS.replace(/(#[\w-]+)/g, '$1 .orbit-dock-drawer'));
    for (var i = 0; i < drawers.length; i++) {
      var on = drawers[i] === except;
      drawers[i].classList.toggle('open', on);
      var toggle = drawers[i].querySelector('[data-dock-drawer]');
      if (toggle) toggle.setAttribute('aria-expanded', on ? 'true' : 'false');
    }
  }

  function wireDock(dockId) {
    var dock = $(dockId);
    if (!dock || dock.getAttribute('data-orbit-wired') === '1') return;
    dock.setAttribute('data-orbit-wired', '1');
    dock.addEventListener('click', function (event) {
      var drawerBtn = event.target && event.target.closest ? event.target.closest('[data-dock-drawer]') : null;
      if (drawerBtn) {
        var wrap = drawerBtn.closest('.orbit-dock-drawer');
        var wasOpen = wrap && wrap.classList.contains('open');
        closeDockDrawers(wasOpen ? null : wrap);
        if (wrap && !wasOpen) {
          var pop = wrap.querySelector('.orbit-dock-pop');
          // closeDockDrawers has already displayed it, so it measures.
          if (pop) placePop(pop, drawerBtn);
        }
        return;
      }
      var btn = event.target && event.target.closest ? event.target.closest('[data-dock-action]') : null;
      if (!btn) return;
      closeDockDrawers(null);
      var action = btn.getAttribute('data-dock-action');
      if (action === 'cut-at-playhead' || action === 'trim-before' || action === 'trim-after') timeline(action, btn);
      else if (action === 'color-matte') createMatte();
      else if (action === 'adjustment-layer') createAdj();
      else if (action === 'nest') nest();
      else if (action === 'unnest') unnest(btn);
      else if (action === 'flip-h') flip('horizontal');
      else if (action === 'flip-v') flip('vertical');
      else if (action === 'fit') fitToFrame('fit');
      else if (action === 'fill') fitToFrame('fill');
      else if (action === 'scale-reset') fitToFrame('reset');
      else if (action === 'align') { markPad(btn); align(btn.getAttribute('data-mode')); }
      else if (action === 'anchor') { markPad(btn); setAnchor(btn.getAttribute('data-mode')); }
      else if (action === 'paste-image') pasteImage();
      else if (action === 'guides-16x9') guides('16x9');
      else if (action === 'guides-9x16') guides('9x16');
      else if (action === 'guides-off') guidesOff();
      else if (action === 'seq-selection') createSequence('selection');
      else if (action === 'seq-16x9') createSequence('16x9');
      else if (action === 'seq-9x16') createSequence('9x16');
    });
  }

  // Registered once for the page, not once per dock: a per-dock version would
  // have the transform dock close a drawer the timeline dock had just opened,
  // because its own handler runs after and sees a click outside itself.
  function wireOutsideClick() {
    if (document.documentElement.getAttribute('data-orbit-dock-outside') === '1') return;
    document.documentElement.setAttribute('data-orbit-dock-outside', '1');
    document.addEventListener('click', function (event) {
      var docks = document.querySelectorAll(DOCKS);
      for (var i = 0; i < docks.length; i++) if (docks[i].contains(event.target)) return;
      closeDockDrawers(null);
    });
  }

  wireDock('orbitRightDock');
  wireOutsideClick();
  watchRailTop();
  global.ComposerTools = {
    refresh: refresh, timeline: timeline, createMatte: createMatte, createAdj: createAdj,
    nest: nest, unnest: unnest, flip: flip, fitToFrame: fitToFrame, align: align, setAnchor: setAnchor,
    pasteImage: pasteImage, guides: guides, guidesOff: guidesOff, createSequence: createSequence,
    syncRailTop: syncRailTop
  };
}(window));
