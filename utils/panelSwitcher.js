/**
 * panelSwitcher.js — Safe Panel Switching Utility
 * Provides a unified, safe way to switch between panels with multiple fallback methods
 */

(function (global) {
  'use strict';

  /**
   * Safely switches to a specific panel with multiple fallback methods
   * @param {string} panelType - The panel type to switch to (e.g., 'captions', 'library', 'silence')
   * @returns {boolean} - True if switch was successful, false otherwise
   */
  function switchToPanel(panelType) {
    if (!panelType) {
      console.error('panelSwitcher: panelType is required');
      return false;
    }

    // Map panel types to their corresponding view IDs
    var panelMap = {
      'captions': 'autoCaptionsView',
      'library': 'sfxMogrtView',
      'silence': 'silenceCutterView',
      'beat': 'beatView',
      'audio': 'audioView',
      'motion': 'motionView',
      'doctor': 'projectDoctorView'
    };

    var targetViewId = panelMap[panelType];
    if (!targetViewId) {
      console.error('panelSwitcher: Unknown panel type:', panelType);
      return false;
    }

    // Method 1: Try OrbitRailRouter (preferred)
    if (typeof global.OrbitRailRouter === 'object' && typeof global.OrbitRailRouter.open === 'function') {
      try {
        global.OrbitRailRouter.open(panelType);
        console.log('panelSwitcher: Successfully switched using OrbitRailRouter to', panelType);
        return true;
      } catch (e) {
        console.warn('panelSwitcher: OrbitRailRouter.open failed:', e);
      }
    }

    // Method 2: Try legacy _showService
    if (typeof global._showService === 'function') {
      try {
        // Map panel types to service names for legacy method
        var serviceMap = {
          'captions': 'auto-captions',
          'library': 'library',
          'silence': 'silence-cutter',
          'beat': 'beat-sync',
          'audio': 'audio-cleaner',
          'motion': 'motion-lab',
          'doctor': 'project-doctor'
        };
        var serviceName = serviceMap[panelType] || panelType;
        global._showService(serviceName);
        console.log('panelSwitcher: Successfully switched using _showService to', serviceName);
        return true;
      } catch (e) {
        console.warn('panelSwitcher: _showService failed:', e);
      }
    }

    // Method 3: Manual DOM manipulation (fallback)
    try {
      var targetView = document.getElementById(targetViewId);
      var allViews = document.querySelectorAll('.orbit-view-panel');
      var assetTypeRow = document.getElementById('assetTypeRow');

      if (!targetView) {
        console.error('panelSwitcher: Target view not found:', targetViewId);
        return false;
      }

      // Hide all views first
      for (var i = 0; i < allViews.length; i++) {
        allViews[i].style.display = 'none';
        allViews[i].classList.remove('orbit-route-active');
        allViews[i].classList.add('orbit-route-hidden');
        allViews[i].setAttribute('aria-hidden', 'true');
      }

      // Show target view
      targetView.style.display = 'block';
      targetView.classList.add('orbit-route-active');
      targetView.classList.remove('orbit-route-hidden');
      targetView.setAttribute('aria-hidden', 'false');

      // Update shelf buttons if assetTypeRow exists
      if (assetTypeRow) {
        var shelves = assetTypeRow.querySelectorAll('.shelf');
        for (var j = 0; j < shelves.length; j++) {
          shelves[j].classList.toggle('active', shelves[j].getAttribute('data-type') === panelType);
        }
      }

      // Dispatch custom event for other modules to react
      try {
        global.dispatchEvent(new CustomEvent('compx:panel-switched', {
          detail: { panelType: panelType, viewId: targetViewId }
        }));
      } catch (e) {
        // Ignore event dispatch errors
      }

      console.log('panelSwitcher: Successfully switched using manual DOM to', panelType);
      return true;
    } catch (e) {
      console.error('panelSwitcher: Manual panel switching failed:', e);
      return false;
    }
  }

  /**
   * Gets the currently active panel type
   * @returns {string|null} - The active panel type or null if none found
   */
  function getActivePanel() {
    try {
      var activeView = document.querySelector('.orbit-view-panel.orbit-route-active');
      if (activeView) {
        var viewId = activeView.id;
        // Reverse map view IDs to panel types
        var viewToPanel = {
          'autoCaptionsView': 'captions',
          'sfxMogrtView': 'library',
          'silenceCutterView': 'silence',
          'beatView': 'beat',
          'audioView': 'audio',
          'motionView': 'motion',
          'projectDoctorView': 'doctor'
        };
        return viewToPanel[viewId] || null;
      }

      // Fallback: check active shelf button
      var activeShelf = document.querySelector('.shelf.active');
      if (activeShelf) {
        return activeShelf.getAttribute('data-type');
      }

      return null;
    } catch (e) {
      console.error('panelSwitcher: Failed to get active panel:', e);
      return null;
    }
  }

  /**
   * Checks if a specific panel is currently active
   * @param {string} panelType - The panel type to check
   * @returns {boolean} - True if the panel is active
   */
  function isPanelActive(panelType) {
    return getActivePanel() === panelType;
  }

  // Export public API
  global.PanelSwitcher = {
    switchTo: switchToPanel,
    getActive: getActivePanel,
    isActive: isPanelActive
  };

  console.log('panelSwitcher: Utility loaded successfully');

})(typeof window !== 'undefined' ? window : global);