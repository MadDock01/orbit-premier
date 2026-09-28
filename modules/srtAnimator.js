/**
 * srtAnimator.js — Enhanced SRT to Text Animation Module
 * Imports SRT files and creates animated text sequences with multi-language support
 * Supports RTL/LTR text detection, multiple animation styles, and export to Premiere
 */

(function (global) {
  'use strict';

  // ── State ──────────────────────────────────────────────────────────────────
  var srtCaptions = [];
  var animationSettings = {
    style: 'fade',           // fade, slide-up, bounce, typewriter, glitch, karaoke
    fontFamily: 'Arial',
    fontSize: 72,
    fontWeight: 'bold',
    color: '#ffffff',
    bgColor: '#000000',
    bgOpacity: 0.75,
    positionY: 0.85,
    fps: 10,
    duration: 0.25,          // animation duration in seconds
    stroke: null,
    strokeWidth: 0,
    glow: false,
    glowColor: '#ffffff',
    glowSize: 0
  };

  var sequenceInfo = { width: 1920, height: 1080, timebase: 30 };
  var generatedPngs = [];
  var tempDir = '';

  // ── Animation Style Catalog ─────────────────────────────────────────────────
  var ANIMATION_STYLES = [
    {
      id: 'fade',
      label: 'Fade In/Out',
      description: 'Simple fade in and out animation',
      defaultSettings: {
        animation: 'fade',
        duration: 0.25,
        fps: 10,
        bgOpacity: 0.75
      }
    },
    {
      id: 'slide-up',
      label: 'Slide Up',
      description: 'Text slides up from bottom',
      defaultSettings: {
        animation: 'slide-up',
        duration: 0.3,
        fps: 12,
        bgOpacity: 0.88,
        bgColor: '#1a1a1a'
      }
    },
    {
      id: 'bounce',
      label: 'Bounce',
      description: 'Bouncy scale animation',
      defaultSettings: {
        animation: 'bounce',
        duration: 0.4,
        fps: 15,
        bgOpacity: 0,
        color: '#ffe44d',
        stroke: '#000000',
        strokeWidth: 6
      }
    },
    {
      id: 'typewriter',
      label: 'Typewriter',
      description: 'Text appears character by character',
      defaultSettings: {
        animation: 'typewriter',
        duration: 0.5,
        fps: 12,
        fontFamily: 'Courier New',
        bgOpacity: 0.9,
        bgColor: '#0d0d0d',
        color: '#e0ffe0'
      }
    },
    {
      id: 'glitch',
      label: 'Glitch',
      description: 'Digital glitch effect with RGB split',
      defaultSettings: {
        animation: 'glitch',
        duration: 0.35,
        fps: 15,
        bgOpacity: 0.88,
        bgColor: '#000000',
        color: '#00ffcc'
      }
    },
    {
      id: 'neon',
      label: 'Neon Glow',
      description: 'Neon-style glow effect',
      defaultSettings: {
        animation: 'fade',
        duration: 0.3,
        fps: 10,
        bgOpacity: 0,
        color: '#ff44dd',
        glow: true,
        glowColor: '#ff44dd',
        glowSize: 18
      }
    },
    {
      id: 'karaoke',
      label: 'Karaoke',
      description: 'Word-by-word highlight animation',
      defaultSettings: {
        animation: 'karaoke',
        duration: 0.2,
        fps: 15,
        bgOpacity: 0.85,
        bgColor: '#000000',
        highlightColor: '#ffe44d',
        dimColor: '#888888'
      }
    }
  ];

  // ── SRT Parser (Enhanced) ───────────────────────────────────────────────────
  function parseSrt(raw) {
    var text = String(raw || '').replace(/^﻿/, '').replace(/\r\n?/g, '\n');
    var cues = [];
    var TIME = /(?:(\d{1,2}):)?(\d{1,2}):(\d{2})[.,](\d{1,3})/;
    var blocks = text.split(/\n{2,}/);
    
    for (var b = 0; b < blocks.length; b++) {
      var lines = blocks[b].split('\n').filter(function (l) { return l.trim() !== ''; });
      if (!lines.length) continue;
      
      // Find timing line
      var ti = -1;
      for (var i = 0; i < lines.length && i < 3; i++) {
        if (lines[i].indexOf('-->') !== -1) { ti = i; break; }
      }
      if (ti === -1) continue;
      
      var parts = lines[ti].split('-->');
      var m1 = TIME.exec(parts[0]); 
      var m2 = TIME.exec(parts[1] || '');
      if (!m1 || !m2) continue;
      
      function toSec(m) {
        var h = parseInt(m[1] || '0', 10), 
            mn = parseInt(m[2], 10), 
            s = parseInt(m[3], 10);
        var ms = parseInt((m[4] + '00').slice(0, 3), 10);
        return h * 3600 + mn * 60 + s + ms / 1000;
      }
      
      var body = lines.slice(ti + 1).join('\n')
        .replace(/<[^>]+>/g, '')          // strip HTML tags
        .replace(/\{\\[^}]*\}/g, '')      // strip ASS-style overrides
        .trim();
      
      if (!body) continue;
      
      var start = toSec(m1), end = toSec(m2);
      if (end > start) {
        cues.push({
          text: body,
          start: start,
          end: end,
          id: cues.length + 1
        });
      }
    }
    
    cues.sort(function (a, b) { return a.start - b.start; });
    return cues;
  }

  // ── Multi-language Text Detection ────────────────────────────────────────────
  function detectTextDirection(text) {
    // RTL detection for Arabic, Hebrew, Persian, etc.
    var rtlChars = /[\u0591-\u07FF\uFB1D-\uFDFD\uFE70-\uFEFC]/;
    var rtlMatch = text.match(rtlChars);
    
    if (rtlMatch && rtlMatch.length / text.length > 0.3) {
      return 'rtl';
    }
    return 'ltr';
  }

  function detectLanguage(text) {
    // Basic language detection based on character ranges
    if (/[\u0600-\u06FF]/.test(text)) return 'arabic';
    if (/[\u4E00-\u9FFF]/.test(text)) return 'chinese';
    if (/[\u0400-\u04FF]/.test(text)) return 'russian';
    if (/[\u0590-\u05FF]/.test(text)) return 'hebrew';
    if (/[\u0900-\u097F]/.test(text)) return 'hindi';
    if (/[\u0E00-\u0E7F]/.test(text)) return 'thai';
    if (/[\uAC00-\uD7AF]/.test(text)) return 'korean';
    if (/[\u3040-\u309F]/.test(text)) return 'japanese';
    return 'latin';
  }

  // ── Canvas-based Text Renderer ───────────────────────────────────────────────
  function createCanvas(width, height) {
    var canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    return canvas;
  }

  function hexToRgb(hex) {
    var h = String(hex || '#000000').replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    if (!/^[0-9a-fA-F]{6}$/.test(h)) h = '000000';
    return {
      r: parseInt(h.slice(0, 2), 16),
      g: parseInt(h.slice(2, 4), 16),
      b: parseInt(h.slice(4, 6), 16)
    };
  }

  function wrapText(ctx, text, maxWidth) {
    var words = text.split(' ');
    var lines = [];
    var line = '';
    
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

  function renderAnimatedFrame(canvas, text, settings, progress, direction) {
    var ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    
    var s = animationSettings;
    var p = progress || 0;
    var fadeF = Math.max(0.01, Math.min(0.49, s.duration));
    
    // Animation calculations
    var alpha = 1;
    var slideY = 0;
    var scaleV = 1;
    
    if (s.animation === 'fade' || s.animation === 'typewriter' || s.animation === 'neon') {
      if (p < fadeF) alpha = p / fadeF;
      else if (p > 1 - fadeF) alpha = (1 - p) / fadeF;
      alpha = Math.max(0, Math.min(1, alpha));
    } else if (s.animation === 'slide-up') {
      var sp = Math.min(p / 0.28, 1);
      slideY = (1 - sp) * 32 * (canvas.height / 1080);
      if (p < fadeF) alpha = p / fadeF;
      else if (p > 1 - fadeF) alpha = (1 - p) / fadeF;
      alpha = Math.max(0, Math.min(1, alpha));
    } else if (s.animation === 'bounce') {
      var ep = Math.min(p / 0.32, 1);
      if (ep < 0.5) scaleV = ep / 0.5;
      else if (ep < 0.72) scaleV = 1 + (ep - 0.5) / 0.22 * 0.07;
      else scaleV = 1.07 - (ep - 0.72) / 0.28 * 0.07;
      if (p > 0.82) {
        var xp = (p - 0.82) / 0.18;
        scaleV *= (1 - xp * 0.6);
        alpha = Math.max(0, 1 - xp);
      }
      scaleV = Math.max(0, scaleV);
    } else if (s.animation === 'glitch') {
      if (p < 0.1) alpha = p / 0.1;
      else if (p > 0.9) alpha = (1 - p) / 0.1;
      alpha = Math.max(0, Math.min(1, alpha));
    }
    
    if (alpha < 0.01) return;
    
    ctx.save();
    ctx.globalAlpha = alpha;
    
    // Apply scale transform for bounce
    if (s.animation === 'bounce' && scaleV !== 1) {
      var centerY = s.positionY * canvas.height;
      ctx.translate(canvas.width / 2, centerY);
      ctx.scale(scaleV, scaleV);
      ctx.translate(-canvas.width / 2, -centerY);
    }
    
    // Text setup
    ctx.font = s.fontWeight + ' ' + s.fontSize + 'px "' + s.fontFamily + '"';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    
    var maxTextW = Math.floor(0.65 * canvas.width) - 64;
    var lines = wrapText(ctx, text, maxTextW);
    var lineH = s.fontSize * 1.3;
    
    var maxLineW = 0;
    for (var i = 0; i < lines.length; i++) {
      var lw = ctx.measureText(lines[i]).width;
      if (lw > maxLineW) maxLineW = lw;
    }
    
    var boxW = Math.min(maxLineW + 64, canvas.width * 0.65);
    var boxH = lines.length * lineH + 36;
    var boxX = (canvas.width - boxW) / 2;
    var boxCenterY = s.positionY * canvas.height;
    var boxY = boxCenterY - boxH / 2 + slideY;
    
    // Background
    if (s.bgOpacity > 0) {
      var bg = hexToRgb(s.bgColor);
      ctx.fillStyle = 'rgba(' + bg.r + ',' + bg.g + ',' + bg.b + ',' + s.bgOpacity + ')';
      roundRect(ctx, boxX, boxY, boxW, boxH, 16);
      ctx.fill();
    }
    
    // Glitch RGB split
    if (s.animation === 'glitch') {
      var gp = 0;
      if (p < 0.14) gp = 1 - p / 0.14;
      else if (p > 0.86) gp = (p - 0.86) / 0.14;
      var gOff = gp * 9 * (canvas.width / 1920);
      
      if (gOff > 0.5) {
        ctx.save();
        ctx.globalAlpha = alpha * 0.6;
        ctx.fillStyle = 'rgb(255,0,0)';
        for (var gi = 0; gi < lines.length; gi++) {
          var gly = boxY + 18 + lineH * (gi + 0.5);
          ctx.fillText(lines[gi], canvas.width / 2 - gOff, gly);
        }
        ctx.fillStyle = 'rgb(0,255,255)';
        for (var gi2 = 0; gi2 < lines.length; gi2++) {
          var gly2 = boxY + 18 + lineH * (gi2 + 0.5);
          ctx.fillText(lines[gi2], canvas.width / 2 + gOff, gly2);
        }
        ctx.restore();
      }
    }
    
    // Glow effect
    if (s.glow && s.glowSize > 0) {
      ctx.shadowColor = s.glowColor || s.color;
      ctx.shadowBlur = s.glowSize;
    }
    
    // Stroke
    if (s.stroke && s.strokeWidth > 0) {
      ctx.strokeStyle = s.stroke;
      ctx.lineWidth = s.strokeWidth;
      ctx.lineJoin = 'round';
      for (var si = 0; si < lines.length; si++) {
        ctx.strokeText(lines[si], canvas.width / 2, boxY + 18 + lineH * (si + 0.5));
      }
    }
    
    // Main text
    ctx.fillStyle = s.color;
    for (var fi = 0; fi < lines.length; fi++) {
      ctx.fillText(lines[fi], canvas.width / 2, boxY + 18 + lineH * (fi + 0.5));
    }
    
    ctx.restore();
  }

  // ── Generate PNG Sequence for Caption ─────────────────────────────────────────
  function generateCaptionPngs(caption, settings) {
    var duration = caption.end - caption.start;
    var fps = settings.fps || 10;
    var frameCount = Math.max(1, Math.ceil(duration * fps));
    
    var canvas = createCanvas(sequenceInfo.width, sequenceInfo.height);
    var direction = detectTextDirection(caption.text);
    var language = detectLanguage(caption.text);
    
    var frames = [];
    for (var f = 0; f < frameCount; f++) {
      var progress = frameCount > 1 ? f / (frameCount - 1) : 0.5;
      renderAnimatedFrame(canvas, caption.text, settings, progress, direction);
      frames.push(canvas.toDataURL('image/png'));
    }
    
    return {
      captionId: caption.id,
      text: caption.text,
      start: caption.start,
      end: caption.end,
      frames: frames,
      frameCount: frameCount,
      fps: fps,
      direction: direction,
      language: language
    };
  }

  // ── Process SRT File ─────────────────────────────────────────────────────────
  function processSrtFile(srtContent, settings) {
    var cues = parseSrt(srtContent);
    if (!cues.length) {
      throw new Error('No valid captions found in SRT file');
    }
    
    srtCaptions = cues;
    var results = [];
    
    for (var i = 0; i < cues.length; i++) {
      try {
        var captionPngs = generateCaptionPngs(cues[i], settings);
        results.push(captionPngs);
      } catch (e) {
        console.error('Error processing caption ' + (i + 1) + ':', e);
      }
    }
    
    generatedPngs = results;
    return {
      success: true,
      captionsProcessed: cues.length,
      totalFrames: results.reduce(function (sum, r) { return sum + r.frameCount; }, 0),
      results: results
    };
  }

  // ── Export to Premiere Format ───────────────────────────────────────────────
  function exportForPremiere() {
    if (!generatedPngs.length) {
      throw new Error('No generated PNGs to export. Process SRT file first.');
    }
    
    var exportData = {
      sequenceInfo: sequenceInfo,
      captions: generatedPngs.map(function (png) {
        return {
          id: png.captionId,
          text: png.text,
          start: png.start,
          end: png.end,
          frameCount: png.frameCount,
          fps: png.fps,
          direction: png.direction,
          language: png.language
        };
      }),
      settings: animationSettings,
      timestamp: new Date().toISOString()
    };
    
    return JSON.stringify(exportData, null, 2);
  }

  // ── Settings Management ───────────────────────────────────────────────────────
  function updateSettings(newSettings) {
    for (var key in newSettings) {
      if (newSettings.hasOwnProperty(key)) {
        animationSettings[key] = newSettings[key];
      }
    }
  }

  function getAnimationStyle(styleId) {
    return ANIMATION_STYLES.find(function (style) { return style.id === styleId; }) || ANIMATION_STYLES[0];
  }

  function applyAnimationStyle(styleId) {
    var style = getAnimationStyle(styleId);
    if (style) {
      updateSettings(style.defaultSettings);
      return style;
    }
    return null;
  }

  // ── Public API ───────────────────────────────────────────────────────────────
  global.SrtAnimator = {
    // Core functions
    parseSrt: parseSrt,
    processSrtFile: processSrtFile,
    exportForPremiere: exportForPremiere,
    
    // Settings
    updateSettings: updateSettings,
    getSettings: function () { return JSON.parse(JSON.stringify(animationSettings)); },
    getAnimationStyles: function () { return ANIMATION_STYLES.slice(); },
    applyAnimationStyle: applyAnimationStyle,
    
    // Language detection
    detectTextDirection: detectTextDirection,
    detectLanguage: detectLanguage,
    
    // State
    getCaptions: function () { return srtCaptions.slice(); },
    getGeneratedPngs: function () { return generatedPngs.slice(); },
    setSequenceInfo: function (info) { 
      sequenceInfo = info; 
      if (info.width) sequenceInfo.width = info.width;
      if (info.height) sequenceInfo.height = info.height;
      if (info.timebase) sequenceInfo.timebase = info.timebase;
    },
    
    // Utilities
    getAnimationStyle: getAnimationStyle
  };

})(typeof window !== 'undefined' ? window : global);