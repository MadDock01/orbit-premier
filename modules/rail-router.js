/** Single source of truth for Premiere rail navigation. */
(function (global) {
  'use strict';

  var row = document.getElementById('assetTypeRow');
  if (!row) return;

  // The eight shelves in #assetTypeRow. Tools and Punch were removed; their
  // timeline actions live on #orbitRightDock instead.
  //
  // SFX and MOGRT were a pair of tabs inside one library, then two rail
  // entries over that same view. SFX now has a view of its own — the studio,
  // which browses, shapes and inserts a sound — and #sfxMogrtView is MOGRT
  // alone. setLibraryType still runs for both, because the MOGRT view is the
  // old shared markup and still reads data-library-mode.
  var views = {
    silence: 'silenceCutterView',
    captions: 'autoCaptionsView',
    beat: 'beatView',
    audio: 'audioView',
    motion: 'motionView',
    sfx: 'sfxStudioView',
    mogrt: 'sfxMogrtView',
    doctor: 'projectDoctorView'
  };

  var doctorOpened = false;

  function libraryLabel(type) {
    if (type === 'mogrt') {
      return { search: 'Search MOGRT templates…', accept: '.mogrt', add: 'Add MOGRT files', empty: 'MOGRT',
        hint: 'Add .mogrt files with the + button or import a folder.' };
    }
    return { search: 'Search sound effects…', accept: '.mp3,.wav,.aiff,.aif,.m4a,.ogg', add: 'Add sound files', empty: 'SFX',
      hint: 'Add sound files with the + button or import a folder.' };
  }

  function setLibraryType(type) {
    if (type === 'prfpset') type = 'sfx';
    if (type !== 'mogrt' && type !== 'sfx') return false;
    global.__orbitLibraryType = type;
    var meta = libraryLabel(type);
    // The SFX|MOGRT tab pair inside the view is gone; the rail shelf is the
    // only thing that shows which library is open, and open() marks that.
    var view = document.getElementById('sfxMogrtView');
    if (view) view.setAttribute('data-library-mode', type);
    // The folder sidebar's heading said LIBRARY when there was one library
    // with two tabs. Now that the rail names it, this should agree with it.
    var sidebarTitle = document.querySelector('#sfxMogrtView .sidebar-header .title');
    if (sidebarTitle) sidebarTitle.textContent = meta.empty;
    var search = document.getElementById('search');
    if (search) search.setAttribute('placeholder', meta.search);
    var input = document.getElementById('fileInputFiles');
    if (input) input.setAttribute('accept', meta.accept);
    var add = document.getElementById('btnAddFiles');
    if (add) add.setAttribute('title', meta.add);
    // Rewrite the empty state when the grid holds nothing but a previous one.
    // Testing for "no children" alone skipped every switch after the first,
    // because the placeholder this writes is itself a child — so an empty
    // MOGRT library kept offering to add sound files.
    var grid = document.getElementById('library');
    var onlyFallback = grid && grid.children.length === 1 &&
      /(^|\s)orbit-library-fallback(\s|$)/.test(grid.children[0].className || '');
    if (grid && (!grid.children.length || onlyFallback)) {
      grid.innerHTML = '<div class="empty-state orbit-library-fallback"><span class="big">' + meta.empty + '</span><strong>' + meta.empty + ' Library</strong><span>' + meta.hint + '</span></div>';
    }
    try { localStorage.setItem('compXLibraryType', type); } catch (_) {}
    try { document.dispatchEvent(new CustomEvent('compx:library-type-request', { detail: { type: type } })); } catch (_) {}
    return true;
  }

  function findShelf(target) {
    while (target && target !== row) {
      if (/(^|\s)shelf(\s|$)/.test(target.className || '')) return target;
      target = target.parentNode;
    }
    return null;
  }

  function setViewState(view, active) {
    if (!view) return;
    view.classList.toggle('orbit-route-active', active);
    view.classList.toggle('orbit-route-hidden', !active);
    view.setAttribute('aria-hidden', active ? 'false' : 'true');
  }

  function open(type, options) {
    // 'library' is what builds before the split saved; it meant SFX.
    if (type === 'library') type = 'sfx';
    if (!views[type]) type = 'sfx';
    var selectedView = document.getElementById(views[type]);
    if (!selectedView) return false;

    var shelves = row.querySelectorAll('.shelf');
    for (var i = 0; i < shelves.length; i++) {
      shelves[i].classList.toggle('active', shelves[i].getAttribute('data-type') === type);
    }

    // Only MOGRT drives the old shared library view now. Calling this for
    // 'sfx' would relabel a view the SFX rail no longer opens — its search
    // box would say "sound effects" while showing MOGRT templates.
    if (type === 'mogrt') setLibraryType('mogrt');
    setViewState(document.getElementById('sfxMogrtView'), type === 'mogrt');
    var panels = document.querySelectorAll('.orbit-view-panel');
    for (var j = 0; j < panels.length; j++) setViewState(panels[j], panels[j] === selectedView);

    try { localStorage.setItem('compXLibraryShelf', type); } catch (_) {}

    if (!(options && options.silent)) {
      try {
        global.dispatchEvent(new CustomEvent('compx:rail-route', { detail: { type: type, viewId: views[type] } }));
      } catch (_) {}
      if (type === 'doctor' && !doctorOpened && global.ProjectDoctor && typeof global.ProjectDoctor.scan === 'function') {
        doctorOpened = true;
        setTimeout(function () { global.ProjectDoctor.scan(); }, 0);
      }
    }
    return true;
  }

  row.addEventListener('click', function (event) {
    var button = findShelf(event.target);
    if (!button) return;
    var type = button.getAttribute('data-type');
    if (!views[type]) return;
    event.preventDefault();
    open(type);
  }, true);

  var initial = 'sfx';
  try { initial = localStorage.getItem('compXLibraryShelf') || 'sfx'; } catch (_) {}
  // An older build could have saved 'library', or a shelf that has since been
  // retired. open() coerces both, and it sets the library mode itself now.
  open(initial, { silent: true });

  document.addEventListener('host-loader-ready', function () {
    var active = row.querySelector('.shelf.active');
    open(active ? active.getAttribute('data-type') : initial);
  });

  global.OrbitRailRouter = { open: open, setLibraryType: setLibraryType };
}(window));
