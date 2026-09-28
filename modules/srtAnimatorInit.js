/**
 * srtAnimatorInit.js — Initialization for SRT Animator
 * Initializes the SRT Animator system when the main app loads
 */

(function (global) {
  'use strict';

  function initSrtAnimator() {
    // Wait for DOM to be ready
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', initSrtAnimator);
      return;
    }

    // Check if dependencies are available
    if (typeof global.SrtAnimator === 'undefined') {
      console.warn('SrtAnimator not available - skipping initialization');
      return;
    }

    if (typeof global.SrtAnimatorUI === 'undefined') {
      console.warn('SrtAnimatorUI not available - skipping initialization');
      return;
    }

    // Initialize the UI
    try {
      global.SrtAnimatorUI.init();
      console.log('SRT Animator initialized successfully');
    } catch (e) {
      console.error('Failed to initialize SRT Animator:', e);
    }
  }

  // Auto-initialize when script loads
  initSrtAnimator();

  // Also expose manual initialization function
  global.initSrtAnimator = initSrtAnimator;

})(typeof window !== 'undefined' ? window : global);