/**
 * captionRenderer.js — Canvas-based caption frame renderer
 * Draws styled caption text onto a transparent canvas.
 * Exports PNG frame sequences for FFmpeg → ProRes 4444 encoding.
 *
 * Animations: fade | slide-up | bounce | typewriter | glitch | karaoke
 * Features:   text stroke, glow/shadow, transparent background support
 */

(function (global) {
  'use strict';

  // Full-resolution canvas dimensions for export
  var CANVAS_W = 1920;
  var CANVAS_H = 1080;

  var DEFAULT_STYLE = {
    fontFamily:    'Arial',
    fontSize:      72,
    fontWeight:    'bold',
    color:         '#ffffff',
    stroke:        null,        // stroke/outline color, null = none
    strokeWidth:   0,           // px at 1080p
    glow:          false,
    glowColor:     '#ffffff',
    glowSize:      0,           // shadow blur radius
    bgColor:       '#000000',
    bgOpacity:     0.75,        // 0 = transparent, 1 = solid
    bgRadius:      16,          // corner radius px
    boxMaxWidth:   0.65,        // max text box width as fraction of canvas width
    boxPadX:       32,
    boxPadY:       18,
    positionY:     0.85,        // vertical center of box as fraction (0=top, 1=bottom)
    animation:     'fade',
    fadeDuration:  0.25,        // fraction of clip for fade in/out
    fps:           10,
    // karaoke-specific
    highlightColor: '#ffe44d',
    dimColor:       '#888888'
  };

  // ── Built-in style catalog ──────────────────────────────────────────────────
  var STYLES = [
    {
      id: 'clean', label: 'Clean',
      animation: 'fade', bgColor: '#000000', bgOpacity: 0.75,
      color: '#ffffff', fontSize: 72, bgRadius: 12, fadeDuration: 0.2, fps: 10
    },
    {
      id: 'bold', label: 'Bold',
      animation: 'bounce', bgOpacity: 0,
      color: '#ffe44d', fontSize: 88, fontWeight: 'bold',
      stroke: '#000000', strokeWidth: 6, fps: 15
    },
    {
      id: 'slide', label: 'Slide Up',
      animation: 'slide-up', bgColor: '#1a1a1a', bgOpacity: 0.88,
      color: '#ffffff', fontSize: 72, bgRadius: 8, fadeDuration: 0.15, fps: 12
    },
    {
      id: 'karaoke', label: 'Karaoke',
      animation: 'karaoke', bgColor: '#000000', bgOpacity: 0.85,
      color: '#ffffff', highlightColor: '#ffe44d', dimColor: '#888888',
      fontSize: 72, bgRadius: 10, fps: 15
    },
    {
      id: 'typewriter', label: 'Typewriter',
      animation: 'typewriter', bgColor: '#0d0d0d', bgOpacity: 0.9,
      color: '#e0ffe0', fontSize: 68, bgRadius: 4,
      fontFamily: 'Courier New', fadeDuration: 0.08, fps: 12
    },
    {
      id: 'glitch', label: 'Glitch',
      animation: 'glitch', bgColor: '#000000', bgOpacity: 0.88,
      color: '#00ffcc', fontSize: 76, bgRadius: 8, fps: 15
    },
    {
      id: 'neon', label: 'Neon',
      animation: 'fade', bgOpacity: 0,
      color: '#ff44dd', fontSize: 80,
      glow: true, glowColor: '#ff44dd', glowSize: 18, fadeDuration: 0.3, fps: 10
    },
    {
      id: 'minimal', label: 'Minimal',
      animation: 'fade', bgOpacity: 0,
      color: '#ffffff', fontSize: 72,
      stroke: '#000000', strokeWidth: 3, fadeDuration: 0.15, fps: 8
    }
  ];

  // ── Helpers ──────────────────────────────────────────────────────────────────

  function hexToRgb(hex) {
    return {
      r: parseInt(hex.slice(1, 3), 16),
      g: parseInt(hex.slice(3, 5), 16),
      b: parseInt(hex.slice(5, 7), 16)
    };
  }

  function roundRect(ctx, x, y, w, h, r) {
    var rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.lineTo(x + w - rr, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
    ctx.lineTo(x + w, y + h - rr);
    ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
    ctx.lineTo(x + rr, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
    ctx.lineTo(x, y + rr);
    ctx.quadraticCurveTo(x, y, x + rr, y);
    ctx.closePath();
  }

  function wrapText(ctx, text, maxWidth) {
    var words = text.split(' ');
    var lines = [];
    var line  = '';
    for (var i = 0; i < words.length; i++) {
      var candidate = line ? line + ' ' + words[i] : words[i];
      if (line && ctx.measureText(candidate).width > maxWidth) {
        lines.push(line);
        line = words[i];
      } else {
        line = candidate;
      }
    }
    if (line) lines.push(line);
    return lines.length ? lines : [''];
  }

  function merge(defaults, overrides) {
    var out = {};
    for (var k in defaults) { if (defaults.hasOwnProperty(k)) out[k] = defaults[k]; }
    if (overrides) {
      for (var k2 in overrides) { if (overrides.hasOwnProperty(k2)) out[k2] = overrides[k2]; }
    }
    return out;
  }

  /**
   * Scale style dimensions from 1920×1080 to a target canvas size.
   * Use this for preview canvases so font/padding/radius look correct.
   */
  function scaleStyleForCanvas(style, targetW, targetH) {
    var scale = targetH / CANVAS_H;
    // Also override positionY for preview so text is always centered and visible
    return merge(style, {
      fontSize:    Math.max(9, Math.round((style.fontSize || 72) * scale)),
      boxPadX:     Math.max(5, Math.round((style.boxPadX  || 32) * scale)),
      boxPadY:     Math.max(3, Math.round((style.boxPadY  || 18) * scale)),
      bgRadius:    Math.max(2, Math.round((style.bgRadius || 16) * scale)),
      strokeWidth: style.strokeWidth ? Math.max(1, Math.round(style.strokeWidth * scale)) : 0,
      glowSize:    style.glowSize    ? Math.max(3, Math.round(style.glowSize * scale))    : 0,
      positionY:   0.5,
      boxMaxWidth: 0.92
    });
  }

  // ── Core draw ────────────────────────────────────────────────────────────────

  /**
   * Draws one caption frame onto the canvas.
   * @param {HTMLCanvasElement} canvas
   * @param {string}            text
   * @param {object}            style   Merged with DEFAULT_STYLE
   * @param {number}            progress  0=start of clip, 1=end of clip
   */
  function drawFrame(canvas, text, style, progress) {
    var s   = merge(DEFAULT_STYLE, style);
    var ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    var p     = progress || 0;
    var fadeF = Math.max(0.01, Math.min(0.49, s.fadeDuration));

    // Typewriter: reveal text char by char
    var drawText = text;
    if (s.animation === 'typewriter') {
      var chars = Math.max(1, Math.round(p * text.length));
      drawText = text.slice(0, chars);
    }

    ctx.font         = s.fontWeight + ' ' + s.fontSize + 'px "' + s.fontFamily + '"';
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';

    var maxTextW = Math.floor(s.boxMaxWidth * canvas.width) - 2 * s.boxPadX;
    var lines    = wrapText(ctx, drawText, maxTextW);
    var lineH    = s.fontSize * 1.3;

    var maxLineW = 0;
    for (var i = 0; i < lines.length; i++) {
      var lw = ctx.measureText(lines[i]).width;
      if (lw > maxLineW) maxLineW = lw;
    }

    var boxW       = Math.min(maxLineW + 2 * s.boxPadX, canvas.width * s.boxMaxWidth);
    var boxH       = lines.length * lineH + 2 * s.boxPadY;
    var boxX       = (canvas.width - boxW) / 2;
    var boxCenterY = s.positionY * canvas.height;
    var boxY       = boxCenterY - boxH / 2;

    // ── Compute animation values ─────────────────────────────────────────────
    var alpha  = 1;
    var slideY = 0;
    var scaleV = 1;

    if (s.animation === 'fade' || s.animation === 'typewriter') {
      if (p < fadeF)       alpha = p / fadeF;
      else if (p > 1 - fadeF) alpha = (1 - p) / fadeF;
      alpha = Math.max(0, Math.min(1, alpha));

    } else if (s.animation === 'slide-up') {
      var sp = Math.min(p / 0.28, 1);
      slideY = (1 - sp) * 32 * (canvas.height / 1080);
      if (p < fadeF)       alpha = p / fadeF;
      else if (p > 1 - fadeF) alpha = (1 - p) / fadeF;
      alpha = Math.max(0, Math.min(1, alpha));

    } else if (s.animation === 'bounce') {
      var ep = Math.min(p / 0.32, 1);
      if (ep < 0.5)        scaleV = ep / 0.5;
      else if (ep < 0.72)  scaleV = 1 + (ep - 0.5) / 0.22 * 0.07;
      else                 scaleV = 1.07 - (ep - 0.72) / 0.28 * 0.07;
      if (p > 0.82) {
        var xp = (p - 0.82) / 0.18;
        scaleV *= (1 - xp * 0.6);
        alpha   = Math.max(0, 1 - xp);
      }
      scaleV = Math.max(0, scaleV);

    } else if (s.animation === 'glitch') {
      if (p < 0.1)       alpha = p / 0.1;
      else if (p > 0.9)  alpha = (1 - p) / 0.1;
      alpha = Math.max(0, Math.min(1, alpha));
    }

    if (alpha < 0.01) return; // fully transparent, skip draw

    // ── Draw ─────────────────────────────────────────────────────────────────
    ctx.save();
    ctx.globalAlpha = alpha;

    // Scale transform (bounce)
    if (s.animation === 'bounce' && scaleV !== 1) {
      ctx.translate(canvas.width / 2, boxCenterY);
      ctx.scale(scaleV, scaleV);
      ctx.translate(-canvas.width / 2, -boxCenterY);
    }

    var aBoxY = boxY + slideY;

    // Background box
    if (s.bgOpacity > 0) {
      var bg = hexToRgb(s.bgColor || '#000000');
      ctx.fillStyle = 'rgba(' + bg.r + ',' + bg.g + ',' + bg.b + ',' + s.bgOpacity + ')';
      roundRect(ctx, boxX, aBoxY, boxW, boxH, s.bgRadius);
      ctx.fill();
    }

    // Glitch RGB split
    if (s.animation === 'glitch') {
      var gp = 0;
      if (p < 0.14)      gp = 1 - p / 0.14;
      else if (p > 0.86) gp = (p - 0.86) / 0.14;
      var gOff = gp * 9 * (canvas.width / 1920);

      if (gOff > 0.5) {
        ctx.save();
        ctx.globalAlpha = alpha * 0.6;
        ctx.fillStyle = 'rgb(255,0,0)';
        ctx.shadowColor = 'transparent';
        ctx.shadowBlur  = 0;
        for (var gi = 0; gi < lines.length; gi++) {
          var gly = aBoxY + s.boxPadY + lineH * (gi + 0.5);
          ctx.fillText(lines[gi], canvas.width / 2 - gOff, gly);
        }
        ctx.fillStyle = 'rgb(0,255,255)';
        for (var gi2 = 0; gi2 < lines.length; gi2++) {
          var gly2 = aBoxY + s.boxPadY + lineH * (gi2 + 0.5);
          ctx.fillText(lines[gi2], canvas.width / 2 + gOff, gly2);
        }
        ctx.restore();
      }
    }

    // Glow (shadow)
    if (s.glow && s.glowSize > 0) {
      ctx.shadowColor = s.glowColor || s.color;
      ctx.shadowBlur  = s.glowSize;
    }

    // Stroke (outline — drawn before fill so fill goes on top)
    if (s.stroke && s.strokeWidth > 0) {
      ctx.strokeStyle = s.stroke;
      ctx.lineWidth   = s.strokeWidth;
      ctx.lineJoin    = 'round';
      for (var si = 0; si < lines.length; si++) {
        ctx.strokeText(lines[si], canvas.width / 2, aBoxY + s.boxPadY + lineH * (si + 0.5));
      }
    }

    // Main text
    ctx.fillStyle = s.color;
    for (var fi = 0; fi < lines.length; fi++) {
      ctx.fillText(lines[fi], canvas.width / 2, aBoxY + s.boxPadY + lineH * (fi + 0.5));
    }

    ctx.restore();
  }

  // ── Karaoke frame ────────────────────────────────────────────────────────────

  /**
   * Draws one karaoke frame with per-word color based on currentTime.
   * Uses clip-region sweep for the active word (precise left-to-right reveal).
   * @param {HTMLCanvasElement} canvas
   * @param {Array}  phraseWords  [{word, start, end}, ...]
   * @param {number} currentTime  Absolute timeline time
   * @param {object} style
   */
  function drawKaraokeFrame(canvas, phraseWords, currentTime, style) {
    var s   = merge(DEFAULT_STYLE, style);
    var ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    ctx.font         = s.fontWeight + ' ' + s.fontSize + 'px "' + s.fontFamily + '"';
    ctx.textBaseline = 'middle';

    var maxTextW = Math.floor(s.boxMaxWidth * canvas.width) - 2 * s.boxPadX;
    var spaceW   = ctx.measureText(' ').width;
    var lineH    = s.fontSize * 1.3;

    // Word-wrap while tracking original word indices
    var lines   = [];
    var curLine = [];
    var curW    = 0;
    for (var i = 0; i < phraseWords.length; i++) {
      var ww = ctx.measureText(phraseWords[i].word).width;
      if (curLine.length > 0 && curW + spaceW + ww > maxTextW) {
        lines.push({ words: curLine, width: curW });
        curLine = [{ idx: i, width: ww }];
        curW    = ww;
      } else {
        if (curLine.length > 0) curW += spaceW;
        curLine.push({ idx: i, width: ww });
        curW += ww;
      }
    }
    if (curLine.length > 0) lines.push({ words: curLine, width: curW });

    var maxLineW = 0;
    for (var li = 0; li < lines.length; li++) {
      if (lines[li].width > maxLineW) maxLineW = lines[li].width;
    }

    var boxW = maxLineW + 2 * s.boxPadX;
    var boxH = lines.length * lineH + 2 * s.boxPadY;
    var boxX = (canvas.width - boxW) / 2;
    var boxY = s.positionY * canvas.height - boxH / 2;

    // Background
    if (s.bgOpacity > 0) {
      var bg = hexToRgb(s.bgColor || '#000000');
      ctx.fillStyle = 'rgba(' + bg.r + ',' + bg.g + ',' + bg.b + ',' + s.bgOpacity + ')';
      roundRect(ctx, boxX, boxY, boxW, boxH, s.bgRadius);
      ctx.fill();
    }

    var hiColor  = s.highlightColor || '#ffe44d';
    var dimColor = s.dimColor       || '#888888';
    var doneColor = s.color;

    for (var li2 = 0; li2 < lines.length; li2++) {
      var line  = lines[li2];
      var lineY = boxY + s.boxPadY + lineH * (li2 + 0.5);
      var cx    = (canvas.width - line.width) / 2;

      for (var wi = 0; wi < line.words.length; wi++) {
        var entry = line.words[wi];
        var pw    = phraseWords[entry.idx];
        ctx.textAlign = 'left';

        if (currentTime >= pw.start && currentTime < pw.end) {
          // Active word: clip-region sweep
          var wordProg = (currentTime - pw.start) / Math.max(0.001, pw.end - pw.start);
          var sweepPx  = entry.width * wordProg;

          // Dim base
          ctx.fillStyle = dimColor;
          ctx.fillText(pw.word, cx, lineY);

          // Highlighted swept portion
          ctx.save();
          ctx.beginPath();
          ctx.rect(cx, boxY, sweepPx, canvas.height);
          ctx.clip();
          ctx.fillStyle = hiColor;
          ctx.fillText(pw.word, cx, lineY);
          ctx.restore();

        } else {
          ctx.fillStyle = (currentTime >= pw.end) ? doneColor : dimColor;
          ctx.fillText(pw.word, cx, lineY);
        }

        cx += entry.width + (wi < line.words.length - 1 ? spaceW : 0);
      }
    }
  }

  // ── Frame rendering (for export) ─────────────────────────────────────────────

  /**
   * Renders all frames for a standard caption clip (non-karaoke).
   * Returns base64 data-URL PNG array.
   */
  function renderFrames(text, style, durationSecs) {
    var s          = merge(DEFAULT_STYLE, style);
    var isStatic   = (s.animation === 'none' || s.animation === 'static');
    var fps        = isStatic ? 1 : (s.fps || 10);
    var frameCount = isStatic ? 1 : Math.max(1, Math.ceil(durationSecs * fps));

    var canvas    = document.createElement('canvas');
    canvas.width  = CANVAS_W;
    canvas.height = CANVAS_H;

    var frames = [];
    for (var f = 0; f < frameCount; f++) {
      var progress = (frameCount > 1) ? (f / (frameCount - 1)) : 0.5;
      drawFrame(canvas, text, s, progress);
      frames.push(canvas.toDataURL('image/png'));
    }
    return frames;
  }

  /**
   * Renders all frames for a karaoke caption clip.
   */
  function renderKaraokeFrames(phraseWords, phraseStart, phraseEnd, style) {
    var s          = merge(DEFAULT_STYLE, style);
    var fps        = s.fps || 15;
    var duration   = phraseEnd - phraseStart;
    var frameCount = Math.max(1, Math.ceil(duration * fps));

    var canvas    = document.createElement('canvas');
    canvas.width  = CANVAS_W;
    canvas.height = CANVAS_H;

    var frames = [];
    for (var f = 0; f < frameCount; f++) {
      var progress    = frameCount > 1 ? f / (frameCount - 1) : 0;
      var currentTime = phraseStart + progress * duration;
      drawKaraokeFrame(canvas, phraseWords, currentTime, s);
      frames.push(canvas.toDataURL('image/png'));
    }
    return frames;
  }

  /**
   * Renders a small preview frame onto a visible canvas (for panel preview).
   */
  function renderPreview(previewCanvas, text, style) {
    var offscreen    = document.createElement('canvas');
    offscreen.width  = CANVAS_W;
    offscreen.height = CANVAS_H;
    drawFrame(offscreen, text, style, 0.5);

    var pCtx = previewCanvas.getContext('2d');
    pCtx.fillStyle = '#1a1a1a';
    pCtx.fillRect(0, 0, previewCanvas.width, previewCanvas.height);
    pCtx.drawImage(offscreen, 0, 0, previewCanvas.width, previewCanvas.height);
  }

  // ── Model 4: Pre / Current / Post PNG renderer ───────────────────────────────

  /**
   * Renders Pre/Current/Post PNG clips for every word in every caption phrase.
   * Each PNG is phrase-sized (phraseW × lineH). The host positions it in the
   * sequence using seq.frameSizeHorizontal/Vertical and posYFraction.
   *
   * @param {Array}  captions  - generatedCaptions array (each has .text, .words[])
   * @param {Object} style     - { fontFamily, fontSize, fontWeight, preFill,
   *                             curFill, postFill, positionY }
   * @param {number} seqW      - unused (kept for API compat) — host uses real seq dims
   * @param {number} seqH      - unused (kept for API compat)
   * @param {string} tmpDir    - absolute path to write PNGs (Node fs)
   * @param {number} timebase  - ticks per frame from Premiere (seq.timebase); 0 = auto 30fps
   * @returns {{ clips, tmpDir }}
   *   clip fields: pngPath, startTicks, endTicks, track, posXFraction, posYFraction
   */
  function renderPreCurrentPostPNGs(captions, style, seqW, seqH, tmpDir, timebase, onProgress) {
    // Support legacy call without timebase: renderPreCurrentPostPNGs(..., tmpDir, onProgress)
    if (typeof timebase === 'function') { onProgress = timebase; timebase = 0; }

    var fs   = require('fs');
    var path = require('path');
    var os   = require('os');

    if (!tmpDir) {
      tmpDir = path.join(os.tmpdir(), 'machicut', 'captions',
        new Date().toISOString().replace(/T/, '_').replace(/:/g, '-').slice(0, 19));
    }
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

    var TICKS     = 254016000000;
    // ticks per frame — use actual sequence timebase if available, else assume 30fps
    var TPF       = (timebase && timebase > 0) ? timebase : Math.round(TICKS / 30);
    var MIN_TICKS = TPF; // minimum clip = 1 frame (avoids creating overlap with next clip)
    var clips     = [];

    // Snap seconds → ticks → nearest frame boundary
    function _toTicks(secs) {
      var raw = Math.round(secs * TICKS);
      return Math.round(raw / TPF) * TPF;
    }

    // Builds a single unified path for N touching CBG boxes (merge mode).
    // Adjacent box heights are extended to absorb the line gap.
    // ALL corners are rounded — outer corners convex, step-junction corners concave.
    function _buildMergedPath(oc, boxes, r) {
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
    function _drawMergedStroke(c, boxes, radius, sk) {
      if (!sk || !sk.enable || (sk.width || 0) <= 0) return;
      var sw  = sk.width || 2;
      var pos = sk.position || 'center';
      var alpha = (sk.opacity != null ? sk.opacity : 100) / 100;
      var bx0 = Math.min.apply(null, boxes.map(function(b) { return b.x; }));
      var bx1 = Math.max.apply(null, boxes.map(function(b) { return b.x + b.w; }));
      var by0 = boxes[0].y, by1 = boxes[boxes.length - 1].y + boxes[boxes.length - 1].h;
      var fillStyle = _makeFillStyle(c, sk.fill || { type: 'solid', color: '#ffffff', opacity: 100 }, bx0, bx1 - bx0, by0, by1 - by0);
      c.save();
      if (pos === 'inside') {
        _buildMergedPath(c, boxes, radius); c.clip();
        _buildMergedPath(c, boxes, radius); c.lineWidth = sw * 2;
      } else if (pos === 'outside') {
        var _exp = boxes.map(function(b) { return { x: b.x - sw / 2, y: b.y - sw / 2, w: b.w + sw, h: b.h + sw }; });
        _buildMergedPath(c, _exp, radius + sw / 2); c.lineWidth = sw;
      } else {
        _buildMergedPath(c, boxes, radius); c.lineWidth = sw;
      }
      c.strokeStyle = fillStyle;
      c.globalAlpha = alpha;
      c.stroke();
      c.restore();
    }

    function _roundRect(c, x, y, w, h, r) {
      var rad = Math.min(r, w / 2, h / 2);
      c.beginPath();
      c.moveTo(x + rad, y);
      c.lineTo(x + w - rad, y); c.quadraticCurveTo(x + w, y, x + w, y + rad);
      c.lineTo(x + w, y + h - rad); c.quadraticCurveTo(x + w, y + h, x + w - rad, y + h);
      c.lineTo(x + rad, y + h); c.quadraticCurveTo(x, y + h, x, y + h - rad);
      c.lineTo(x, y + rad); c.quadraticCurveTo(x, y, x + rad, y);
      c.closePath();
    }
    function _hexToRgba(hex, alpha) {
      var h = (hex && hex.length === 7) ? hex : '#000000';
      return 'rgba(' + parseInt(h.slice(1,3),16) + ',' + parseInt(h.slice(3,5),16) + ',' + parseInt(h.slice(5,7),16) + ',' + alpha + ')';
    }
    function _setShadow(c, sh) {
      if (!sh || (sh.opacity || 0) <= 0) return;
      c.shadowColor   = _hexToRgba(sh.color || '#000000', (sh.opacity || 0) / 100);
      c.shadowBlur    = sh.blur || 0;
      c.shadowOffsetX = sh.x   || 0;
      c.shadowOffsetY = sh.y   || 0;
    }
    function _clearShadow(c) {
      c.shadowColor   = 'transparent';
      c.shadowBlur    = 0;
      c.shadowOffsetX = 0;
      c.shadowOffsetY = 0;
    }
    // Draw stroke around a rounded rect box
    function _drawBoxStroke(c, x, y, w, h, radius, sk) {
      if (!sk || !sk.enable || (sk.width || 0) <= 0) return;
      var sw  = sk.width || 2;
      var pos = sk.position || 'center';
      var alpha = (sk.opacity != null ? sk.opacity : 100) / 100;
      var fillStyle = _makeFillStyle(c, sk.fill || { type: 'solid', color: '#ffffff', opacity: 100 }, x, w, y, h);
      c.save();
      if (pos === 'inside') {
        _roundRect(c, x, y, w, h, radius); c.clip();
        _roundRect(c, x, y, w, h, radius);
        c.lineWidth = sw * 2;
      } else if (pos === 'outside') {
        _roundRect(c, x - sw / 2, y - sw / 2, w + sw, h + sw, radius + sw / 2);
        c.lineWidth = sw;
      } else { // center
        _roundRect(c, x, y, w, h, radius);
        c.lineWidth = sw;
      }
      c.strokeStyle = fillStyle;
      c.globalAlpha = alpha;
      c.stroke();
      c.restore();
    }
    // Returns a fillStyle (solid rgba string or LinearGradient) for a fill object.
    // x, w = horizontal extent of the text being drawn (for gradient spread).
    function _makeFillStyle(ctx, fill, x, w, y, h) {
      var alpha = (fill.opacity != null ? fill.opacity : 100) / 100;
      if (fill.type === 'gradient') {
        // CSS linear-gradient angle convention: 0° = up, 90° = right,
        // 180° = down, 270° = left. Matches the dial's tick direction
        // so what the user sees in the dial = what the canvas renders.
        var angle  = (fill.angle || 0) * Math.PI / 180;
        var dx     = Math.sin(angle);
        var dy     = -Math.cos(angle);
        var cx     = x + w / 2;
        var cy     = (y != null ? y : 0) + (h != null ? h : 0) / 2;
        var len    = Math.max(Math.abs((w || 0) / 2 * dx) + Math.abs((h || 0) / 2 * dy), 1);
        var x1 = cx - dx * len;
        var y1 = cy - dy * len;
        var x2 = cx + dx * len;
        var y2 = cy + dy * len;
        var grad = ctx.createLinearGradient(x1, y1, x2, y2);
        grad.addColorStop(0, _hexToRgba(fill.color,  alpha));
        grad.addColorStop(1, _hexToRgba(fill.color2 || fill.color, alpha));
        return grad;
      }
      return _hexToRgba(fill.color, alpha);
    }

    var fontFamily  = style.fontFamily || 'Arial';
    var fontSize    = style.fontSize   || 24;
    var fontStyle   = style.fontStyle  || style.fontWeight || 'bold';
    // Fill objects (new); fall back to legacy flat keys if old style object passed in
    var _defPre  = { type: 'solid', color: style.preColor     || '#ffffff', color2: '#aaaaaa', opacity: 100 };
    var _defCur  = { type: 'solid', color: style.currentColor || '#ffe44d', color2: '#ff8800', opacity: 100 };
    var _defPost = { type: 'solid', color: style.postColor    || '#ffffff', color2: '#aaaaaa', opacity: (style.postOpacity !== undefined ? style.postOpacity * 100 : 50) };
    var preFill  = style.preFill  || _defPre;
    var curFill  = style.curFill  || _defCur;
    var postFill = style.postFill || _defPost;
    var _legacyStrokeW = style.strokeWidth || 0; // backward compat only
    var _defStroke   = { color: style.strokeColor || '#000000', opacity: 100, width: _legacyStrokeW };
    var strokeCur    = style.strokeCur  || _defStroke;
    var strokePre    = style.strokePre  || _defStroke;
    var strokePost   = style.strokePost || _defStroke;
    // Ensure each stroke object has a width (fall back to legacy global)
    if (strokeCur.width  == null) strokeCur  = Object.assign({}, strokeCur,  { width: _legacyStrokeW });
    if (strokePre.width  == null) strokePre  = Object.assign({}, strokePre,  { width: _legacyStrokeW });
    if (strokePost.width == null) strokePost = Object.assign({}, strokePost, { width: _legacyStrokeW });
    var strokePosition = style.strokePosition || 'outside'; // 'outside' | 'center' | 'inside'
    // Shadow per state
    var _defShadow = { color: '#000000', opacity: 0, blur: 4, x: 0, y: 2 };
    var shadowCur  = style.shadowCur  || _defShadow;
    var shadowPre  = style.shadowPre  || _defShadow;
    var shadowPost = style.shadowPost || _defShadow;
    var hlShadow   = style.hlShadow   || _defShadow;
    var cbgShadow  = style.cbgShadow  || _defShadow;
    var _defBoxStroke = { enable: false, fill: { type: 'solid', color: '#ffffff', color2: '#aaaaaa', opacity: 100 }, opacity: 100, width: 2, position: 'center' };
    var hlStroke   = style.hlStroke  || _defBoxStroke;
    var cbgStroke  = style.cbgStroke || _defBoxStroke;
    var strokeWidth  = Math.max(strokeCur.width || 0, strokePre.width || 0, strokePost.width || 0); // for padXY only
    var activeMode   = style.activeMode || 'word';   // 'word' | 'line' | 'off' | 'solo'
    var holdSilence  = style.holdSilence !== false;  // default true; false = clip ends at spoken end
    // Per-type animation gating: a layer only stays separate when it
    // actually needs to animate independently. Anything that's not
    // animating folds into ctx (drawn at its natural canvas position).
    //   curWillAnimate → cur word stays on track 3 (host can pop/scale)
    //   wbWillAnimate  → word-box stays on track 2 (host can animate it)
    //   neither        → everything baked into ctx, one clip per word
    // If only WB animates but cur doesn't, cur still has to stay separate
    // (else WB on track 2 would cover the baked cur on track 0).
    var animate        = !!style.animate;
    var curWillAnimate = animate && (style.animType    !== 'none');
    // wbWillAnimate depends on showHL too — declared right after showHL
    // (further down in this function); kept here just for documentation.
    var solo         = (activeMode === 'solo');
    var posY        = (style.positionY  !== undefined) ? style.positionY : 0.85;
    var posX        = (style.positionX  !== undefined) ? style.positionX : 0.5;
    var wrapMode    = style.wrapMode   || 'auto';   // 'auto' | 'fixed'
    var frameWidth  = style.frameWidth !== undefined ? style.frameWidth : 84; // % of seqW
    var linesCount  = style.linesCount || 2;        // used in fixed mode only
    var lineGap     = style.lineGap    !== undefined ? style.lineGap : 4;     // extra px between lines

    // Highlight / Word Box (cur word BG box)
    var showHL      = !!style.showHL;
    // See the per-type gating comment above.
    var wbWillAnimate = animate && (style.animBoxType !== 'none') && showHL;
    var hlFill      = style.hlFill || { type: 'solid', color: style.hlColor || '#ffe44d', color2: '#ff8800', angle: 0, opacity: 100 };
    var hlColor     = hlFill.color;
    var hlOpacity   = (style.hlOpacity !== undefined) ? style.hlOpacity : 0.8;
    var hlRadius    = (style.hlRadius  !== undefined) ? style.hlRadius  : 8;
    var hlPadTop    = (style.hlPadTop    !== undefined) ? style.hlPadTop    : 8;
    var hlPadBottom = (style.hlPadBottom !== undefined) ? style.hlPadBottom : 8;
    var hlPadLeft   = (style.hlPadLeft   !== undefined) ? style.hlPadLeft   : 8;
    var hlPadRight  = (style.hlPadRight  !== undefined) ? style.hlPadRight  : 8;

    // Caption BG (whole-phrase BG box)
    var showCBG     = !!style.showCBG;
    var cbgFill     = style.cbgFill || { type: 'solid', color: style.cbgColor || '#000000', color2: '#333333', angle: 0, opacity: 100 };
    var cbgOpacity  = (style.cbgOpacity !== undefined) ? style.cbgOpacity / 100 : 0.6;
    var cbgRadius   = (style.cbgRadius  !== undefined) ? style.cbgRadius  : 12;
    var cbgPadTop   = (style.cbgPadTop    !== undefined) ? style.cbgPadTop    : 8;
    var cbgPadBottom= (style.cbgPadBottom !== undefined) ? style.cbgPadBottom : 8;
    var cbgPadLeft  = (style.cbgPadLeft   !== undefined) ? style.cbgPadLeft   : 12;
    var cbgPadRight = (style.cbgPadRight  !== undefined) ? style.cbgPadRight  : 12;
    var cbgMode     = style.cbgMode   || 'full';
    var cbgCorner   = style.cbgCorner || 'separate';

    // Per-state typography + global typography extras
    var letterSpacing  = style.letterSpacing !== undefined ? style.letterSpacing : 0;
    var textTransform  = style.textTransform || 'none';
    var typoOverrides  = style.typoOverrides || {};

    function _resolveLayerFont(suffix) {
      var ov = typoOverrides[suffix] || {};
      return {
        fontFamily: ov.fontFamily || fontFamily,
        fontStyle:  ov.fontStyle  || fontStyle,
        fontSize:   ov.fontSize   || fontSize
      };
    }
    var preFont  = _resolveLayerFont('pre');
    var curFont  = _resolveLayerFont('cur');
    var postFont = _resolveLayerFont('post');

    function _applyTextTransform(w) {
      if (textTransform === 'uppercase')  return w.toUpperCase();
      if (textTransform === 'lowercase')  return w.toLowerCase();
      if (textTransform === 'capitalize') return w.replace(/\b\w/g, function(c) { return c.toUpperCase(); });
      return w;
    }

    function _isRTLText(text) {
      return /[\u0591-\u07FF\uFB1D-\uFDFD\uFE70-\uFEFC]/.test(text);
    }
    function _resolveDir(text) {
      var d = style.direction || 'auto';
      if (d !== 'auto') return d;
      return _isRTLText(text) ? 'rtl' : 'ltr';
    }

    var mCanvas    = document.createElement('canvas');
    mCanvas.width  = 4000; mCanvas.height = 200;
    var mCtx = mCanvas.getContext('2d');

    // Canvas sizing uses max ascent/descent across all state fonts
    function _fontM(ff, fs, fz) {
      mCtx.font = fs + ' ' + fz + 'px ' + ff;
      mCtx.letterSpacing = '0px';
      var fm = mCtx.measureText('Ag');
      return { a: Math.ceil(fm.actualBoundingBoxAscent  || fz * 0.8),
               d: Math.ceil(fm.actualBoundingBoxDescent || fz * 0.2) };
    }
    var _mPre = _fontM(preFont.fontFamily, preFont.fontStyle, preFont.fontSize);
    var _mCur = _fontM(curFont.fontFamily, curFont.fontStyle, curFont.fontSize);
    var _mPst = _fontM(postFont.fontFamily, postFont.fontStyle, postFont.fontSize);
    var ascent    = Math.max(_mPre.a, _mCur.a, _mPst.a);
    var descent   = Math.max(_mPre.d, _mCur.d, _mPst.d);
    var lineTextH = ascent + descent;
    var sw = Math.ceil(strokeWidth);
    var shadowPad = 0;
    [shadowCur, shadowPre, shadowPost].forEach(function(sh) {
      if ((sh.opacity || 0) > 0) {
        shadowPad = Math.max(shadowPad, (sh.blur || 0) + Math.abs(sh.x || 0), (sh.blur || 0) + Math.abs(sh.y || 0));
      }
    });
    // Extra ink overflow pad: Arabic diacritics and RTL connecting strokes can exceed
    // the measured advance width. Add fontSize*0.25 as safety margin.
    var inkPad = Math.ceil(fontSize * 0.25);
    // Extra pad for CBG box (padX/Y can exceed the text-only padXY) + stroke bleed
    var _cbgStrokeBleed = (showCBG && cbgStroke.enable && (cbgStroke.width || 0) > 0)
      ? (cbgStroke.position === 'inside' ? 0 : cbgStroke.position === 'outside' ? (cbgStroke.width || 0) : Math.ceil((cbgStroke.width || 0) / 2))
      : 0;
    var _hlStrokeBleed  = (showHL  && hlStroke.enable  && (hlStroke.width  || 0) > 0)
      ? (hlStroke.position  === 'inside' ? 0 : hlStroke.position  === 'outside' ? (hlStroke.width  || 0) : Math.ceil((hlStroke.width  || 0) / 2))
      : 0;
    var padXY = Math.max(
      12 + sw + inkPad,
      showHL  ? Math.max(hlPadLeft, hlPadRight, hlPadTop, hlPadBottom) + _hlStrokeBleed  : 0,
      showCBG ? Math.max(cbgPadLeft, cbgPadRight, cbgPadTop, cbgPadBottom) + _cbgStrokeBleed : 0,
      shadowPad + sw
    );
    var hlShadowPad = (hlShadow.opacity || 0) > 0
      ? Math.max((hlShadow.blur || 0) + Math.abs(hlShadow.x || 0), (hlShadow.blur || 0) + Math.abs(hlShadow.y || 0))
      : 0;

    // Returns the first word of the next non-empty caption after index ci,
    // skipping any captions whose words array is empty.
    function _nextPhraseFirstWord(ci) {
      for (var _ni = ci + 1; _ni < captions.length; _ni++) {
        var _nw = captions[_ni].words || [];
        if (_nw.length) return _nw[0];
      }
      return null;
    }

    var _clips = clips; // reference for async closure
    var _ci = 0;
    return new Promise(function(resolve, reject) {
      function _step() {
        try {
          if (_ci >= captions.length) { resolve({ clips: _clips, tmpDir: tmpDir }); return; }
          var ci = _ci;
          var onlyIdx = style && style.onlyCaptionIndexes;
          if (onlyIdx && onlyIdx.length && onlyIdx.indexOf(ci) === -1) {
            _ci++;
            if (onProgress) onProgress(_ci, captions.length);
            setTimeout(_step, 0);
            return;
          }
          {
      var cap   = captions[ci];
      var words = cap.words || [];
      if (!words.length) { _ci++; setTimeout(_step, 0); return; }

      var phraseWords = (cap.text || '').trim().split(/\s+/).filter(function(w) { return w.length > 0; })
                        .map(_applyTextTransform);
      if (!phraseWords.length) { _ci++; setTimeout(_step, 0); return; }

      // Explicit line breaks the caption carries via "\n" in c.text.
      // The editor / groupWords sets these to indicate the intended
      // line layout; we use them as forced breaks during line-wrap so
      // the render matches the captions list display.
      var _capTextLB = [];
      if (cap.text && cap.text.indexOf('\n') !== -1) {
        var _txtLines = cap.text.split('\n');
        var _twi = 0;
        for (var _ti = 0; _ti < _txtLines.length - 1; _ti++) {
          var _tc = _txtLines[_ti].trim().split(/\s+/).filter(function (w) { return w.length > 0; }).length;
          _twi += _tc;
          if (_twi > 0 && _twi < phraseWords.length) _capTextLB.push(_twi);
        }
      }

      var dir   = _resolveDir(cap.text || phraseWords.join(' '));
      var isRTL = (dir === 'rtl');
      var lineHInner = lineTextH + lineGap;

      // ── Measure pass 1: All font, no-LS → line-break decisions only ──────────
      mCtx.font = fontStyle + ' ' + fontSize + 'px ' + fontFamily;
      mCtx.letterSpacing = '0px';
      mCtx.direction = dir; mCtx.textAlign = 'left';
      var spaceWNoLS = mCtx.measureText(' ').width;
      var widthsNoLS = phraseWords.map(function(w) { return mCtx.measureText(w).width; });

      // ── Measure pass 2: per-state fonts with LS → positions ──────────────────
      function _mLS(ff, fs, fz) {
        mCtx.font = fs + ' ' + fz + 'px ' + ff;
        mCtx.letterSpacing = letterSpacing ? letterSpacing + 'px' : '0px';
        mCtx.direction = dir; mCtx.textAlign = 'left';
        return phraseWords.map(function(w) { return mCtx.measureText(w).width; });
      }
      var preWidths  = _mLS(preFont.fontFamily,  preFont.fontStyle,  preFont.fontSize);
      var curWidths  = _mLS(curFont.fontFamily,  curFont.fontStyle,  curFont.fontSize);
      var postWidths = _mLS(postFont.fontFamily, postFont.fontStyle, postFont.fontSize);
      // Space width: All font + LS
      mCtx.font = fontStyle + ' ' + fontSize + 'px ' + fontFamily;
      mCtx.letterSpacing = letterSpacing ? letterSpacing + 'px' : '0px';
      mCtx.direction = dir; mCtx.textAlign = 'left';
      var spaceWLS = mCtx.measureText(' ').width;

      // ── Line-break (All font, no-LS) ──────────────────────────────────────────
      var _seqW = seqW || 1920;
      var lines = [];
      // If cap.text has explicit "\n" breaks, those win — match what the
      // captions list and editor show. Otherwise fall through to fixed
      // or auto wrap.
      if (_capTextLB.length) {
        var _last = 0;
        for (var _li = 0; _li < _capTextLB.length; _li++) {
          var _b = _capTextLB[_li];
          if (_b <= _last || _b >= phraseWords.length) continue;
          var _ln = []; for (var _lk = _last; _lk < _b; _lk++) _ln.push(_lk);
          lines.push(_ln);
          _last = _b;
        }
        var _ln2 = []; for (var _lm = _last; _lm < phraseWords.length; _lm++) _ln2.push(_lm);
        lines.push(_ln2);
      } else if (wrapMode === 'fixed') {
        // Lines is a MAX, not a force: only split when the caption's
        // joined text wouldn't fit on a single line at the Chars limit.
        // Previously this always divided words evenly across linesCount,
        // producing forced 2-line output for short captions like "which
        // is" (8 chars) even though they fit comfortably on one line.
        var charsPerLine = style.charsPerLine || 80;
        var joinedLen = phraseWords.reduce(function (s, w) {
          return s + (w || '').length;
        }, 0) + Math.max(0, phraseWords.length - 1); // +spaces
        if (linesCount <= 1 || joinedLen <= charsPerLine) {
          var oneLine = [];
          for (var ol = 0; ol < phraseWords.length; ol++) oneLine.push(ol);
          lines.push(oneLine);
        } else {
          var wordsPerLine = Math.ceil(phraseWords.length / linesCount);
          for (var fl = 0; fl < linesCount; fl++) {
            var fStart = fl * wordsPerLine, fEnd = Math.min(fStart + wordsPerLine, phraseWords.length);
            if (fStart < phraseWords.length) {
              var fLine = []; for (var fk = fStart; fk < fEnd; fk++) fLine.push(fk); lines.push(fLine);
            }
          }
        }
      } else {
        var maxLineWNoLS = Math.round(_seqW * frameWidth / 100);
        var cLine = [], cLineW = 0;
        for (var wm = 0; wm < phraseWords.length; wm++) {
          var extra = cLine.length ? spaceWNoLS + widthsNoLS[wm] : widthsNoLS[wm];
          if (cLine.length && cLineW + extra > maxLineWNoLS) {
            lines.push(cLine); cLine = [wm]; cLineW = widthsNoLS[wm];
          } else { cLine.push(wm); cLineW += extra; }
        }
        if (cLine.length) lines.push(cLine);
      }
      var numLines = lines.length;

      // Pre-compute fixed word→line map from line-break result (used by line mode)
      var wordLineIdxFixed = new Array(phraseWords.length);
      for (var _fli = 0; _fli < numLines; _fli++) {
        lines[_fli].forEach(function(idx) { wordLineIdxFixed[idx] = _fli; });
      }

      // Per-state stroke helper — uses stroke.width (per-state), not global strokeWidth
      function _applyStroke(c, stroke, x, w, y, h) {
        var sw = stroke ? (stroke.width || 0) : 0;
        if (sw > 0) {
          var _sa = (stroke.opacity != null ? stroke.opacity : 100) / 100;
          c.lineWidth = sw * 2;
          c.lineJoin = 'round';
          if (stroke.type === 'gradient' && stroke.color2) {
            c.strokeStyle = _makeFillStyle(c, { type: 'gradient', color: stroke.color, color2: stroke.color2, angle: stroke.angle || 0, opacity: stroke.opacity }, x || 0, w || 1, y, h);
          } else {
            c.strokeStyle = _hexToRgba(stroke.color || '#000000', _sa);
          }
        }
      }
      // Draw a word in two phases:
      //   phase 'stroke' — emit only the stroke (with its shadow if
      //                    shadowFollow === 'stroke'). Used by the first
      //                    pass over a phrase so all strokes form a single
      //                    background layer behind all fills.
      //   phase 'fill'   — emit only the fill (with its shadow if
      //                    shadowFollow === 'fill'). Used by the second
      //                    pass so fills are on top of every other word's
      //                    stroke too — no "next word's stroke covers
      //                    previous word's fill" artifact.
      //   phase 'both' (default) — single-pass per-word draw. Used by
      //                    single-word canvases (cur clip in word mode)
      //                    where the cross-word concern doesn't apply, and
      //                    for strokePosition === 'inside' (stroke is
      //                    clipped to the fill area via source-atop, can
      //                    only be drawn AFTER the fill exists).
      // Tri-state: 'fill' | 'stroke' | 'both' (default). Anything outside
      // those three (missing field, old saves, typo) falls through to
      // 'both' so the new behaviour applies automatically.
      var _shadowFollow = (style.shadowFollow === 'fill' ||
                           style.shadowFollow === 'stroke')
        ? style.shadowFollow
        : 'both';
      function _drawWord(c, stroke, fillStyle, text, x, y, shadow, phase) {
        var sw = stroke ? (stroke.width || 0) : 0;
        var _hasSh = !!(shadow && (shadow.opacity || 0) > 0);
        var _shOnStroke = _hasSh &&
                          (_shadowFollow === 'stroke' || _shadowFollow === 'both') &&
                          (strokePosition === 'outside' || strokePosition === 'center');
        var _shOnFill   = _hasSh &&
                          (_shadowFollow === 'fill'   || _shadowFollow === 'both');

        // STROKE-ONLY PASS: draw the stroke ring for outside/center.
        // 'inside' strokes need an existing fill underneath (source-atop)
        // so they're deferred to the 'both' fallback below.
        if (phase === 'stroke') {
          if (sw <= 0) return;
          if (strokePosition === 'inside') return;
          if (_shOnStroke) { _setShadow(c, shadow); c.strokeText(text, x, y); _clearShadow(c); }
          else             { c.strokeText(text, x, y); }
          return;
        }

        // FILL-ONLY PASS: draw just the fill on top of any prior strokes.
        if (phase === 'fill') {
          c.fillStyle = fillStyle;
          if (_shOnFill) { _setShadow(c, shadow); c.fillText(text, x, y); _clearShadow(c); }
          else           { c.fillText(text, x, y); }
          return;
        }

        // BOTH-PHASES (single-pass) — original per-word stroke+fill+shadow.
        // For shadowFollow='both' both passes carry their shadow.
        c.fillStyle = fillStyle;
        if (sw > 0) {
          if (strokePosition === 'outside') {
            if (_shOnStroke) {
              _setShadow(c, shadow); c.strokeText(text, x, y); _clearShadow(c);
              if (_shOnFill) { _setShadow(c, shadow); c.fillText(text, x, y); _clearShadow(c); }
              else           { c.fillText(text, x, y); }
            } else {
              if (_shOnFill) { _setShadow(c, shadow); c.fillText(text, x, y); _clearShadow(c); }
              else           { c.fillText(text, x, y); }
              c.strokeText(text, x, y);
              c.fillText(text, x, y);
            }
          } else if (strokePosition === 'center') {
            if (_shOnStroke) {
              _setShadow(c, shadow); c.strokeText(text, x, y); _clearShadow(c);
              if (_shOnFill) { _setShadow(c, shadow); c.fillText(text, x, y); _clearShadow(c); }
              else           { c.fillText(text, x, y); }
            } else {
              if (_shOnFill) { _setShadow(c, shadow); c.fillText(text, x, y); _clearShadow(c); }
              else           { c.fillText(text, x, y); }
              c.strokeText(text, x, y);
            }
          } else { // inside
            if (_shOnFill) { _setShadow(c, shadow); c.fillText(text, x, y); _clearShadow(c); }
            else           { c.fillText(text, x, y); }
            c.globalCompositeOperation = 'source-atop';
            c.strokeText(text, x, y);
            c.globalCompositeOperation = 'source-over';
          }
        } else {
          if (_shOnFill) { _setShadow(c, shadow); c.fillText(text, x, y); _clearShadow(c); }
          else           { c.fillText(text, x, y); }
        }
      }

      // Shared canvas layout for a given pwi (phraseWord index acting as "current")
      function _buildLayout(mixedW) {
        var lwLS = [];
        for (var _li = 0; _li < numLines; _li++) {
          lwLS.push(lines[_li].reduce(function(s, i) { return s + mixedW[i]; }, 0) + spaceWLS * (lines[_li].length - 1));
        }
        var clW = wrapMode === 'fixed'
          ? Math.ceil(Math.max.apply(null, lwLS))
          : Math.max(Math.round(_seqW * frameWidth / 100), Math.ceil(Math.max.apply(null, lwLS)));
        var wLIdx = new Array(phraseWords.length);
        var wXPos = new Array(phraseWords.length);
        for (var _li2 = 0; _li2 < numLines; _li2++) {
          var _lw = lwLS[_li2];
          var _xs = isRTL ? padXY + clW / 2 + _lw / 2 : padXY + (clW - _lw) / 2;
          lines[_li2].forEach(function(idx) {
            wLIdx[idx] = _li2;
            if (isRTL) { _xs -= mixedW[idx]; wXPos[idx] = _xs; _xs -= spaceWLS; }
            else       { wXPos[idx] = _xs; _xs += mixedW[idx] + spaceWLS; }
          });
        }
        var ctxW = clW + padXY * 2, ctxH = numLines * lineHInner - lineGap + padXY * 2;
        var _le = {};
        for (var _ei = 0; _ei < phraseWords.length; _ei++) {
          var _el = wLIdx[_ei];
          if (!_le[_el]) _le[_el] = { x0: Infinity, x1: -Infinity };
          _le[_el].x0 = Math.min(_le[_el].x0, wXPos[_ei]);
          _le[_el].x1 = Math.max(_le[_el].x1, wXPos[_ei] + mixedW[_ei]);
        }
        return { lwLS: lwLS, clW: clW, wLIdx: wLIdx, wXPos: wXPos, ctxW: ctxW, ctxH: ctxH,
                 canvasCenterX: padXY + clW / 2, phraseCenterY: ctxH / 2, lineExt: _le };
      }

      // Draw a context PNG canvas.
      // preFrom..preTo drawn with preFill, postFrom..postTo with postFill.
      // If curPwi >= 0, that word is drawn with curFill (used in 'off' mode to fill the gap).
      // solo skips pre+post text (only CBG drawn).
      // curIdxs accepts either:
      //   - a single index (legacy 'off'-mode call: cur baked into ctx)
      //   - an array of indices (auto-bake when animations are off)
      //   - -1 / [] / undefined → no cur baking, caller emits a separate cur clip
      // wbBoxes (optional): array of { x, y, w, h } in ctx-canvas coords.
      // When supplied, each box is filled + stroked with the style's HL
      // settings between the CBG and the text words. Used when WB isn't
      // animating and we fold its visual into the ctx clip.
      function _drawCtxCanvas(lay, preFrom, preTo, postFrom, postTo, curIdxs, wbBoxes) {
        var curList = (curIdxs == null || curIdxs === -1)
                    ? []
                    : (Array.isArray(curIdxs) ? curIdxs : [curIdxs]);
        var cv = document.createElement('canvas');
        cv.width = lay.ctxW; cv.height = lay.ctxH;
        var c = cv.getContext('2d');
        c.clearRect(0, 0, lay.ctxW, lay.ctxH);
        c.direction = dir; c.textAlign = 'left'; c.textBaseline = 'alphabetic';
        if (showCBG) {
          // Build per-line boxes
          var _cbgBoxes = lay.lwLS.map(function(lw, li) {
            return {
              x: Math.round(padXY + (lay.clW - lw) / 2 - cbgPadLeft),
              y: Math.round(padXY + li * lineHInner - cbgPadTop),
              w: Math.round(lw + cbgPadLeft + cbgPadRight),
              h: Math.round(lineTextH + cbgPadTop + cbgPadBottom)
            };
          });
          if (cbgMode === 'full') {
            _cbgBoxes = [{
              x: padXY - cbgPadLeft,
              y: padXY - cbgPadTop,
              w: lay.clW + cbgPadLeft + cbgPadRight,
              h: numLines * lineHInner - lineGap + cbgPadTop + cbgPadBottom
            }];
          }
          var _isCbgMerge = (cbgMode === 'line' && cbgCorner === 'merge');

          // Draw via offscreen for correct group opacity
          var _cbgOff = document.createElement('canvas');
          _cbgOff.width = lay.ctxW; _cbgOff.height = lay.ctxH;
          var _cbgOc = _cbgOff.getContext('2d');

          _setShadow(_cbgOc, cbgShadow);
          if (_isCbgMerge) {
            var _mbx0 = Math.min.apply(null, _cbgBoxes.map(function(b){return b.x;}));
            var _mbx1 = Math.max.apply(null, _cbgBoxes.map(function(b){return b.x+b.w;}));
            var _mby0 = _cbgBoxes[0].y, _mby1 = _cbgBoxes[_cbgBoxes.length-1].y + _cbgBoxes[_cbgBoxes.length-1].h;
            _buildMergedPath(_cbgOc, _cbgBoxes, cbgRadius);
            _cbgOc.fillStyle = _makeFillStyle(_cbgOc, cbgFill, _mbx0, _mbx1 - _mbx0, _mby0, _mby1 - _mby0);
            _cbgOc.fill();
          } else {
            _cbgBoxes.forEach(function(b) {
              _roundRect(_cbgOc, b.x, b.y, b.w, b.h, cbgRadius);
              _cbgOc.fillStyle = _makeFillStyle(_cbgOc, cbgFill, b.x, b.w, b.y, b.h);
              _cbgOc.fill();
            });
          }
          // Blit at CBG opacity
          c.globalAlpha = cbgOpacity;
          c.drawImage(_cbgOff, 0, 0);
          c.globalAlpha = 1;
          // Strokes
          if (_isCbgMerge) {
            _drawMergedStroke(c, _cbgBoxes, cbgRadius, cbgStroke);
          } else {
            _cbgBoxes.forEach(function(b) { _drawBoxStroke(c, b.x, b.y, b.w, b.h, cbgRadius, cbgStroke); });
          }
        }
        // Word Box baked into ctx — sits behind the cur word, above CBG.
        // Caller decides whether to pass this in (only when WB is shown
        // AND not animating; otherwise WB rides on its own track).
        if (wbBoxes && wbBoxes.length) {
          wbBoxes.forEach(function (b) {
            _roundRect(c, b.x, b.y, b.w, b.h, hlRadius);
            c.fillStyle = _makeFillStyle(c, hlFill, b.x, b.w, b.y, b.h);
            c.globalAlpha = hlOpacity;
            _setShadow(c, hlShadow); c.fill(); _clearShadow(c);
            c.globalAlpha = 1;
            _drawBoxStroke(c, b.x, b.y, b.w, b.h, hlRadius, hlStroke);
          });
        }
        if (!solo) {
          // Phrase position order: pre → cur → post. The whole point of
          // baking onto one canvas is that the phrase is rendered as a
          // single unit — each word's shadow falls onto whatever's drawn
          // AFTER it, so a cur word with a right-extending shadow gets
          // its shadow covered by the subsequent post word's fill. No
          // visible "cur shadow on top of post" artifact.
          var _curSet = {};
          curList.forEach(function (cpi) { if (cpi >= 0 && cpi < phraseWords.length) _curSet[cpi] = true; });
          // Fast path when curList is empty: do the original pre then post
          // sweeps; saves the per-word state lookup.
          var _haveCur = curList.length > 0;

          // Helper: draws a single word in its assigned state, optionally
          // for a specific phase ('stroke', 'fill', or both).
          function _drawCtxWord(wi, state, phase) {
            // Smart Caption Lab can persist keyword and speaker metadata on
            // imported SRT captions. Emphasized keywords use the Active state
            // even while they are context; speaker color tints passive words.
            var isEmphasis = !!(words[wi] && words[wi].emphasis);
            if (isEmphasis) state = 'cur';
            var font   = state === 'pre' ? preFont   : state === 'cur' ? curFont   : postFont;
            var fill   = state === 'pre' ? preFill   : state === 'cur' ? curFill   : postFill;
            var stroke = state === 'pre' ? strokePre : state === 'cur' ? strokeCur : strokePost;
            var shadow = state === 'pre' ? shadowPre : state === 'cur' ? shadowCur : shadowPost;
            if (cap.speakerColor && state !== 'cur') {
              fill = { type: 'solid', color: cap.speakerColor, color2: cap.speakerColor,
                angle: 0, opacity: fill && fill.opacity != null ? fill.opacity : 100 };
            }
            c.font = font.fontStyle + ' ' + font.fontSize + 'px ' + font.fontFamily;
            c.letterSpacing = letterSpacing ? letterSpacing + 'px' : '0px';
            var _ext = lay.lineExt[lay.wLIdx[wi]];
            var _by  = padXY + lay.wLIdx[wi] * lineHInner + ascent;
            _applyStroke(c, stroke, _ext.x0, _ext.x1 - _ext.x0, _by - ascent, lineHInner);
            _drawWord(c, stroke, _makeFillStyle(c, fill, _ext.x0, _ext.x1 - _ext.x0), phraseWords[wi], lay.wXPos[wi], _by, shadow, phase);
          }

          // Collect every word in phrase position order with its state, so
          // we can sweep the same list twice (strokes, then fills).
          var _phraseOrder = [];
          if (_haveCur) {
            for (var wi = 0; wi < phraseWords.length; wi++) {
              if (_curSet[wi])                              _phraseOrder.push({ wi: wi, st: 'cur'  });
              else if (wi >= preFrom  && wi <= preTo)       _phraseOrder.push({ wi: wi, st: 'pre'  });
              else if (wi >= postFrom && wi <= postTo)      _phraseOrder.push({ wi: wi, st: 'post' });
            }
          } else {
            for (var pi = preFrom;  pi <= preTo;  pi++) _phraseOrder.push({ wi: pi, st: 'pre'  });
            for (var qi = postFrom; qi <= postTo; qi++) _phraseOrder.push({ wi: qi, st: 'post' });
          }

          // Two-pass to put all strokes BEHIND all fills, even across word
          // boundaries. For strokePosition === 'inside' the stroke is
          // clipped to the fill via source-atop, so it must run after its
          // own fill — _drawWord with phase=stroke returns early and the
          // fill pass does fill+inside-stroke together.
          var _twoPass = (strokePosition !== 'inside');
          if (_twoPass) {
            _phraseOrder.forEach(function (w) { _drawCtxWord(w.wi, w.st, 'stroke'); });
            _phraseOrder.forEach(function (w) { _drawCtxWord(w.wi, w.st, 'fill'  ); });
          } else {
            _phraseOrder.forEach(function (w) { _drawCtxWord(w.wi, w.st, 'both'); });
          }
        }
        return cv;
      }

      if (activeMode === 'off') {
        // ── Off mode: single static clip per caption ──────────────────────────
        // All words drawn in postFill (passive color). No per-word animation.
        var offStartTicks = _toTicks(words[0].start);
        var _offNextW0 = _nextPhraseFirstWord(ci);
        var offEndTicks = _toTicks(_offNextW0 ? _offNextW0.start : (cap.end || words[words.length - 1].end));
        if (offEndTicks - offStartTicks < MIN_TICKS) offEndTicks = offStartTicks + MIN_TICKS;
        var offWidths = phraseWords.map(function(_, idx) { return words[idx] && words[idx].emphasis ? curWidths[idx] : postWidths[idx]; });
        var offLay = _buildLayout(offWidths);
        var offCv = _drawCtxCanvas(offLay, 0, phraseWords.length - 1, phraseWords.length, phraseWords.length - 1, -1);
        var offPath = path.join(tmpDir, 'cap' + ci + '_off.png').replace(/\\/g, '/');
        fs.writeFileSync(offPath, Buffer.from(offCv.toDataURL('image/png').replace(/^data:image\/png;base64,/, ''), 'base64'));
        clips.push({ pngPath: offPath, startTicks: offStartTicks, endTicks: offEndTicks,
          track: 0, isContext: true, posXFraction: posX, posYFraction: posY,
          wordOffsetFromCenter: 0, wordLineYOffset: 0 });
      } else if (activeMode === 'line') {
        // ── Per-line loop ─────────────────────────────────────────────────────
        for (var li = 0; li < numLines; li++) {
          var _lFirst = lines[li][0], _lLast = lines[li][lines[li].length - 1];
          var _startW = words[Math.min(_lFirst, words.length - 1)];
          var _endW   = words[Math.min(_lLast,  words.length - 1)];
          var startTicks = _toTicks(_startW.start);
          // Extend end to next line's first word start (or phrase end) to eliminate inter-line gaps.
          // For the last line, also extend to next phrase's first word start to fill inter-phrase silence.
          var _nextCapW0Line = (li === numLines - 1) ? _nextPhraseFirstWord(ci) : null;
          var _lineRawEnd;
          if (li < numLines - 1) {
            // Within caption: always extend to next line's first word start
            _lineRawEnd = words[Math.min(lines[li + 1][0], words.length - 1)].start;
          } else if (holdSilence) {
            _lineRawEnd = _nextCapW0Line ? _nextCapW0Line.start : (cap.end || _endW.end);
          } else {
            _lineRawEnd = _endW.end;
          }
          var endTicks   = _toTicks(_lineRawEnd);
          if (endTicks <= startTicks) continue; // skip 0-frame line (see word loop comment)
          if (endTicks - startTicks < MIN_TICKS) endTicks = startTicks + MIN_TICKS;

          var mixedW = phraseWords.map(function(_, idx) {
            if (words[idx] && words[idx].emphasis) return curWidths[idx];
            var wl = wordLineIdxFixed[idx];
            return wl < li ? preWidths[idx] : wl === li ? curWidths[idx] : postWidths[idx];
          });
          var lay = _buildLayout(mixedW);
          var lCenterY = padXY + li * lineHInner + lineTextH / 2;
          var lineOffY = lCenterY - lay.phraseCenterY;

          // Find pre/post boundaries by line
          var preToIdx = -1, postFromIdx = phraseWords.length;
          for (var _pi = phraseWords.length - 1; _pi >= 0; _pi--) {
            if (wordLineIdxFixed[_pi] < li) { preToIdx = _pi; break; }
          }
          for (var _qi = 0; _qi < phraseWords.length; _qi++) {
            if (wordLineIdxFixed[_qi] > li) { postFromIdx = _qi; break; }
          }

          // Per-type auto-bake decision (line mode). The host stack is
          // WB (tracks 0/1) → ctx (track 2) → cur (tracks 3/4), so ctx
          // already sits above WB — cur can fold into ctx whenever it
          // isn't animating, even when WB is shown + animating.
          //   _bakeWBIntoCtx  → WB shown + not animating → into ctx
          //                     (saves the separate WB clip).
          //   _bakeCurIntoCtx → cur isn't animating → into ctx.
          var _bakeWBIntoCtx  = showHL && !wbWillAnimate;
          var _bakeCurIntoCtx = !curWillAnimate;

          // Context — solo mode: skip (only cur + WB emitted)
          if (!solo) {
            var _ctxCurIdxs = _bakeCurIntoCtx ? lines[li] : -1;
            // Build the WB box for this line (only when baking into ctx).
            var _ctxWbBoxes = null;
            if (_bakeWBIntoCtx) {
              var _wbLe = lay.lineExt[li] || { x0: padXY, x1: padXY + lay.clW };
              var _wbX  = _wbLe.x0 - hlPadLeft;
              var _wbY  = (padXY + li * lineHInner) - hlPadTop;
              var _wbW  = (_wbLe.x1 - _wbLe.x0) + hlPadLeft + hlPadRight;
              var _wbH  = lineTextH + hlPadTop + hlPadBottom;
              _ctxWbBoxes = [{ x: _wbX, y: _wbY, w: _wbW, h: _wbH }];
            }
            var ctxCv = _drawCtxCanvas(lay, 0, preToIdx, postFromIdx, phraseWords.length - 1, _ctxCurIdxs, _ctxWbBoxes);
            var ctxPath = path.join(tmpDir, 'cap' + ci + '_l' + li + '_ctx.png').replace(/\\/g, '/');
            fs.writeFileSync(ctxPath, Buffer.from(ctxCv.toDataURL('image/png').replace(/^data:image\/png;base64,/, ''), 'base64'));
            clips.push({ pngPath: ctxPath, startTicks: startTicks, endTicks: endTicks,
              track: 0, isContext: true, posXFraction: posX, posYFraction: posY,
              wordOffsetFromCenter: 0, wordLineYOffset: 0 });
          }

          // Cur: full context-size canvas, draw cur line words.
          // Skipped when we baked cur into ctx above (or in solo mode where
          // cur is the only thing visible and is handled separately).
          if (!_bakeCurIntoCtx) {
            var curCv = document.createElement('canvas');
            curCv.width = lay.ctxW; curCv.height = lay.ctxH;
            var curC = curCv.getContext('2d');
            curC.clearRect(0, 0, lay.ctxW, lay.ctxH);
            curC.font = curFont.fontStyle + ' ' + curFont.fontSize + 'px ' + curFont.fontFamily;
            curC.letterSpacing = letterSpacing ? letterSpacing + 'px' : '0px';
            curC.direction = dir; curC.textAlign = 'left'; curC.textBaseline = 'alphabetic';
            var _curLe = lay.lineExt[li] || { x0: padXY, x1: padXY + lay.clW };
            var _curLineY = padXY + li * lineHInner;
            _applyStroke(curC, strokeCur, _curLe.x0, _curLe.x1 - _curLe.x0, _curLineY, lineHInner);
            // Two-pass: all cur-line strokes first, then all fills, so a
            // word's stroke never covers a neighbour's fill. Inside mode
            // falls back to per-word draw via phase='both'.
            var _curTwoPass = (strokePosition !== 'inside');
            var _curBaseY = _curLineY + ascent;
            if (_curTwoPass) {
              lines[li].forEach(function(idx) {
                _drawWord(curC, strokeCur, _makeFillStyle(curC, curFill, _curLe.x0, _curLe.x1 - _curLe.x0, _curLineY, lineHInner), phraseWords[idx], lay.wXPos[idx], _curBaseY, shadowCur, 'stroke');
              });
              lines[li].forEach(function(idx) {
                _drawWord(curC, strokeCur, _makeFillStyle(curC, curFill, _curLe.x0, _curLe.x1 - _curLe.x0, _curLineY, lineHInner), phraseWords[idx], lay.wXPos[idx], _curBaseY, shadowCur, 'fill');
              });
            } else {
              lines[li].forEach(function(idx) {
                _drawWord(curC, strokeCur, _makeFillStyle(curC, curFill, _curLe.x0, _curLe.x1 - _curLe.x0, _curLineY, lineHInner), phraseWords[idx], lay.wXPos[idx], _curBaseY, shadowCur, 'both');
              });
            }
            var curPath = path.join(tmpDir, 'cap' + ci + '_l' + li + '_cur.png').replace(/\\/g, '/');
            fs.writeFileSync(curPath, Buffer.from(curCv.toDataURL('image/png').replace(/^data:image\/png;base64,/, ''), 'base64'));
            clips.push({ pngPath: curPath, startTicks: startTicks, endTicks: endTicks,
              track: 3, isCurrent: true, posXFraction: posX, posYFraction: posY,
              wordOffsetFromCenter: 0, wordLineYOffset: 0 });
          }

          // WB: small canvas sized to the box (not full-phrase canvas).
          // Skipped when WB is baked into ctx above.
          if (showHL && !_bakeWBIntoCtx) {
            var _lExt = lay.lineExt[li] || { x0: padXY, x1: padXY + lay.clW };
            var _lBoxX = _lExt.x0 - hlPadLeft;
            var _lBoxY = (padXY + li * lineHInner) - hlPadTop;
            var _lBoxW = (_lExt.x1 - _lExt.x0) + hlPadLeft + hlPadRight;
            var _lBoxH = lineTextH + hlPadTop + hlPadBottom;
            var _lWbOffX = (_lBoxX + _lBoxW / 2) - lay.canvasCenterX;
            var _lWbOffY = (_lBoxY + _lBoxH / 2) - lay.phraseCenterY;
            var hlCv = document.createElement('canvas');
            hlCv.width = Math.max(1, Math.ceil(_lBoxW) + hlShadowPad * 2); hlCv.height = Math.max(1, Math.ceil(_lBoxH) + hlShadowPad * 2);
            var hlC = hlCv.getContext('2d');
            hlC.clearRect(0, 0, hlCv.width, hlCv.height);
            _roundRect(hlC, hlShadowPad, hlShadowPad, Math.ceil(_lBoxW), Math.ceil(_lBoxH), hlRadius);
            hlC.fillStyle = _makeFillStyle(hlC, hlFill, hlShadowPad, Math.ceil(_lBoxW), hlShadowPad, Math.ceil(_lBoxH));
            hlC.globalAlpha = hlOpacity; _setShadow(hlC, hlShadow); hlC.fill(); _clearShadow(hlC); hlC.globalAlpha = 1;
            _drawBoxStroke(hlC, hlShadowPad, hlShadowPad, Math.ceil(_lBoxW), Math.ceil(_lBoxH), hlRadius, hlStroke);
            var hlPath = path.join(tmpDir, 'cap' + ci + '_l' + li + '_hl.png').replace(/\\/g, '/');
            fs.writeFileSync(hlPath, Buffer.from(hlCv.toDataURL('image/png').replace(/^data:image\/png;base64,/, ''), 'base64'));
            clips.push({ pngPath: hlPath, startTicks: startTicks, endTicks: endTicks,
              track: 2, isCurBg: true, posXFraction: posX, posYFraction: posY,
              wordOffsetFromCenter: _lWbOffX, wordLineYOffset: _lWbOffY });
          }
        }
      } else {
        // ── Per-word loop (word + solo modes) ────────────────────────────────
        for (var wi = 0; wi < words.length; wi++) {
          var wrd        = words[wi];
          var startTicks = _toTicks(wrd.start);
          var _nextCapW0 = (wi === words.length - 1) ? _nextPhraseFirstWord(ci) : null;
          var _rawEnd;
          if (wi < words.length - 1) {
            // Within caption: always extend to next word's start (no inner gaps)
            _rawEnd = words[wi + 1].start;
          } else if (holdSilence) {
            // Last word + hold ON: extend through silence to next caption start
            _rawEnd = _nextCapW0 ? _nextCapW0.start : (cap.end || wrd.end);
          } else {
            // Last word + hold OFF: end at spoken end, silence shows nothing
            _rawEnd = wrd.end;
          }
          var endTicks   = _toTicks(_rawEnd);
          // If this word would have 0 frames after snap (sub-frame Whisper
          // timestamps collapsing to the same frame as the next word), skip
          // it entirely. Otherwise MIN_TICKS extension would push end past
          // next word's start, causing the host to drop it inconsistently
          // (only ctx — cur/hl survive on alternating tracks → visual mismatch).
          if (endTicks <= startTicks) continue;
          if (endTicks - startTicks < MIN_TICKS) endTicks = startTicks + MIN_TICKS;
          var pwi = Math.min(wi, phraseWords.length - 1);

          var mixedWidths = phraseWords.map(function(_, idx) {
            if (words[idx] && words[idx].emphasis) return curWidths[idx];
            return idx < pwi ? preWidths[idx] : idx === pwi ? curWidths[idx] : postWidths[idx];
          });
          var lay = _buildLayout(mixedWidths);

          var wordCenterX = lay.wXPos[pwi] + curWidths[pwi] / 2;
          var wordOffsetX = wordCenterX - lay.canvasCenterX;
          var lineCenterY = padXY + lay.wLIdx[pwi] * lineHInner + lineTextH / 2;
          var wordOffsetY = lineCenterY - lay.phraseCenterY;

          // Measure cur word ink bounds (needed by the WB box, which we
          // may bake into ctx). Same math as the cur-draw step below.
          mCtx.font = curFont.fontStyle + ' ' + curFont.fontSize + 'px ' + curFont.fontFamily;
          mCtx.letterSpacing = letterSpacing ? letterSpacing + 'px' : '0px';
          mCtx.direction = dir; mCtx.textAlign = 'left'; mCtx.textBaseline = 'alphabetic';
          var _cmC = mCtx.measureText(phraseWords[pwi]);
          var _cHL  = Math.ceil(_cmC.actualBoundingBoxLeft    || 0);
          var _cHR  = Math.ceil(_cmC.actualBoundingBoxRight   || curWidths[pwi]);
          var _cAsc = Math.ceil(_cmC.actualBoundingBoxAscent  || _mCur.a);
          var _cDes = Math.ceil(_cmC.actualBoundingBoxDescent || _mCur.d);

          var _wbBaseline = padXY + lay.wLIdx[pwi] * lineHInner + ascent;
          var _wbBoxX = lay.wXPos[pwi] - _cHL - hlPadLeft;
          var _wbBoxY = _wbBaseline - ascent - hlPadTop;
          var _wbBoxW = _cHL + _cHR + hlPadLeft + hlPadRight;
          var _wbBoxH = lineTextH + hlPadTop + hlPadBottom;

          var doBake = !!style.bakeCurWB && showHL;
          // Solo: cur centered in canvas; recompute WB box around it.
          var _drawX  = solo ? (lay.canvasCenterX - curWidths[pwi] / 2) : lay.wXPos[pwi];
          var _drawBy = solo ? (lay.phraseCenterY + (ascent - descent) / 2) : _wbBaseline;
          if (solo) {
            _wbBoxX = _drawX - _cHL - hlPadLeft;
            _wbBoxY = _drawBy - ascent - hlPadTop;
          }

          // Per-type bake (word mode). The host places WB at tracks 0/1,
          // ctx at track 2, cur at tracks 3/4 — so ctx already sits above
          // WB in the stack. That means cur can fold into ctx whenever it
          // isn't animating, even when WB is shown + animating.
          //   _bakeWBIntoCtx  → WB shown + not animating → into ctx
          //                     (one less clip; visual unchanged).
          //   _bakeCurIntoCtx → cur not animating, no manual bakeCurWB,
          //                     not solo. WB layering is fine either way.
          var _bakeWBIntoCtx  = showHL && !wbWillAnimate && !doBake && !solo;
          var _bakeCurIntoCtx = !curWillAnimate && !doBake && !solo;

          // Context — off mode: include cur word in context (no separate cur clip)
          //           solo mode: skip context entirely (only cur/WB clips emitted)
          if (!solo) {
            var _curInCtx  = (activeMode === 'off' || _bakeCurIntoCtx) ? pwi : -1;
            var _curInCtxM = style.curInCtx || 'off';
            var _ctxPreTo  = (_curInCtxM === 'pre')  ? pwi     : pwi - 1;
            var _ctxPostFr = (_curInCtxM === 'post') ? pwi     : pwi + 1;
            var _ctxWbBoxes = _bakeWBIntoCtx
              ? [{ x: _wbBoxX, y: _wbBoxY, w: _wbBoxW, h: _wbBoxH }]
              : null;
            var ctxCv = _drawCtxCanvas(lay, 0, _ctxPreTo, _ctxPostFr, phraseWords.length - 1, _curInCtx, _ctxWbBoxes);
            var ctxPath = path.join(tmpDir, 'cap' + ci + '_w' + wi + '_ctx.png').replace(/\\/g, '/');
            fs.writeFileSync(ctxPath, Buffer.from(ctxCv.toDataURL('image/png').replace(/^data:image\/png;base64,/, ''), 'base64'));
            clips.push({ pngPath: ctxPath, startTicks: startTicks, endTicks: endTicks,
              track: 0, isContext: true, posXFraction: posX, posYFraction: posY,
              wordOffsetFromCenter: 0, wordLineYOffset: 0 });
          }

          {
            // Skip emitting the separate cur clip when we baked it into
            // ctx above. Measurement above is still needed because the
            // WB clip below uses _wbBoxX/Y/W/H derived from the cur ink.
            if (!_bakeCurIntoCtx) {
              var curCv = document.createElement('canvas');
              curCv.width = lay.ctxW; curCv.height = lay.ctxH;
              var curC = curCv.getContext('2d');
              curC.clearRect(0, 0, lay.ctxW, lay.ctxH);
              if (doBake) {
                _roundRect(curC, _wbBoxX, _wbBoxY, _wbBoxW, _wbBoxH, hlRadius);
                curC.fillStyle = _makeFillStyle(curC, hlFill, _wbBoxX, _wbBoxW, _wbBoxY, _wbBoxH);
                curC.globalAlpha = hlOpacity; _setShadow(curC, hlShadow); curC.fill(); _clearShadow(curC); curC.globalAlpha = 1;
                _drawBoxStroke(curC, _wbBoxX, _wbBoxY, _wbBoxW, _wbBoxH, hlRadius, hlStroke);
              }
              curC.font = curFont.fontStyle + ' ' + curFont.fontSize + 'px ' + curFont.fontFamily;
              curC.letterSpacing = letterSpacing ? letterSpacing + 'px' : '0px';
              curC.direction = dir; curC.textAlign = 'left'; curC.textBaseline = 'alphabetic';
              _applyStroke(curC, strokeCur, _drawX - _cHL, _cHL + _cHR, _drawBy - _cAsc, _cAsc + _cDes);
              _drawWord(curC, strokeCur, _makeFillStyle(curC, curFill, _drawX - _cHL, _cHL + _cHR, _drawBy - _cAsc, _cAsc + _cDes), phraseWords[pwi], _drawX, _drawBy, shadowCur);
              var _curOffX = 0, _curOffY = 0;

              curPath = path.join(tmpDir, 'cap' + ci + '_w' + wi + '_cur.png').replace(/\\/g, '/');
              fs.writeFileSync(curPath, Buffer.from(curCv.toDataURL('image/png').replace(/^data:image\/png;base64,/, ''), 'base64'));
              clips.push({ pngPath: curPath, startTicks: startTicks, endTicks: endTicks,
                track: 3, isCurrent: true, posXFraction: posX, posYFraction: posY,
                wordOffsetFromCenter: _curOffX, wordLineYOffset: _curOffY });
            }

            // Separate WB clip — small canvas sized to box. Skipped when
            // doBake (WB baked into cur) or _bakeWBIntoCtx (WB baked into ctx).
            if (showHL && !doBake && !_bakeWBIntoCtx) {
              // solo: WB should be centered on screen (word is centered), so offset = 0
              var _wbOffX = solo ? 0 : ((_wbBoxX + _wbBoxW / 2) - lay.canvasCenterX);
              var _wbOffY = solo ? 0 : ((_wbBoxY + _wbBoxH / 2) - lay.phraseCenterY);
              var hlCv = document.createElement('canvas');
              hlCv.width = Math.max(1, Math.ceil(_wbBoxW) + hlShadowPad * 2); hlCv.height = Math.max(1, Math.ceil(_wbBoxH) + hlShadowPad * 2);
              var hlC = hlCv.getContext('2d');
              hlC.clearRect(0, 0, hlCv.width, hlCv.height);
              _roundRect(hlC, hlShadowPad, hlShadowPad, Math.ceil(_wbBoxW), Math.ceil(_wbBoxH), hlRadius);
              hlC.fillStyle = _makeFillStyle(hlC, hlFill, hlShadowPad, Math.ceil(_wbBoxW), hlShadowPad, Math.ceil(_wbBoxH));
              hlC.globalAlpha = hlOpacity; _setShadow(hlC, hlShadow); hlC.fill(); _clearShadow(hlC); hlC.globalAlpha = 1;
              _drawBoxStroke(hlC, hlShadowPad, hlShadowPad, Math.ceil(_wbBoxW), Math.ceil(_wbBoxH), hlRadius, hlStroke);
              var hlPath = path.join(tmpDir, 'cap' + ci + '_w' + wi + '_hl.png').replace(/\\/g, '/');
              fs.writeFileSync(hlPath, Buffer.from(hlCv.toDataURL('image/png').replace(/^data:image\/png;base64,/, ''), 'base64'));
              clips.push({ pngPath: hlPath, startTicks: startTicks, endTicks: endTicks,
                track: 2, isCurBg: true, posXFraction: posX, posYFraction: posY,
                wordOffsetFromCenter: _wbOffX, wordLineYOffset: _wbOffY });
            }
          }
        }
      }
          } // end single-caption block
          _ci++;
          if (onProgress) onProgress(_ci, captions.length);
          setTimeout(_step, 0); // yield to UI between each phrase
        } catch(e) { reject(e); }
      }
      setTimeout(_step, 0);
    }); // end Promise
  }

  // ── Exports ──────────────────────────────────────────────────────────────────
  global.CaptionRenderer = {
    drawFrame:            drawFrame,
    renderFrames:         renderFrames,
    drawKaraokeFrame:     drawKaraokeFrame,
    renderKaraokeFrames:  renderKaraokeFrames,
    renderPreview:             renderPreview,
    scaleStyleForCanvas:       scaleStyleForCanvas,
    merge:                     merge,
    DEFAULT_STYLE:             DEFAULT_STYLE,
    STYLES:                    STYLES,
    CANVAS_W:                  CANVAS_W,
    CANVAS_H:                  CANVAS_H,
    renderPreCurrentPostPNGs:  renderPreCurrentPostPNGs
  };

}(window));
