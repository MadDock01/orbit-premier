/**
 * Premiere .prfpset catalog — expands pack files into named presets.
 * Apply payloads are rebuilt from the source file on demand (keeps localStorage light).
 */
(function (global) {
  'use strict';

  var TICKS_PER_SECOND = 254016000000;
  var SKIP_NAMES = { Root: 1, Presets: 1, Floc: 1 };

  function nodeRequire() {
    try {
      return (typeof require === 'function' ? require : null) || (global.require || null);
    } catch (_) {
      return null;
    }
  }

  function decodeXml(value) {
    return String(value || '')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'");
  }

  function parseObjects(xml) {
    var objs = {};
    var re = /<(BinTreeItem|TreeItem|FilterPresetItem|FilterPreset|VideoFilterComponent|AudioFilterComponent|EffectBinItem)\s+ObjectID="(\d+)"[^>]*>([\s\S]*?)<\/\1>/g;
    var m;
    while ((m = re.exec(xml))) {
      var tag = m[1];
      var id = m[2];
      var body = m[3];
      var nameMatch = body.match(/<TreeItemBase[\s\S]*?<Name>([^<]*)<\/Name>/) || body.match(/<Name>([^<]*)<\/Name>/);
      var name = decodeXml(nameMatch ? nameMatch[1] : '');
      var matchName = decodeXml(((body.match(/<FilterMatchName>([^<]*)<\/FilterMatchName>/) || [])[1] || ''));
      var display = decodeXml(((body.match(/<DisplayName>([^<]*)<\/DisplayName>/) || [])[1] || ''));
      var dataRef = ((body.match(/<Data ObjectRef="(\d+)"\s*\/>/) || [])[1]) || null;
      var presetRefs = [];
      var pr = body.match(/<FilterPresets[\s\S]*?<\/FilterPresets>/);
      if (pr) {
        var rm;
        var rr = /ObjectRef="(\d+)"/g;
        while ((rm = rr.exec(pr[0]))) presetRefs.push(rm[1]);
      }
      var componentRef = ((body.match(/<Component ObjectRef="(\d+)"\s*\/>/) || [])[1]) || null;
      var anchorIn = ((body.match(/<AnchorInPoint>([^<]*)<\/AnchorInPoint>/) || [])[1] || '').trim();
      objs[id] = {
        tag: tag,
        id: id,
        name: name,
        matchName: matchName,
        display: display,
        dataRef: dataRef,
        presetRefs: presetRefs,
        componentRef: componentRef,
        anchorIn: anchorIn,
        body: body
      };
    }
    return objs;
  }

  function parseParamBlocks(body) {
    var params = [];
    var re = /<(VideoComponentParam|PointComponentParam|ColorComponentParam)\b[^>]*>([\s\S]*?)<\/\1>/g;
    var m;
    while ((m = re.exec(body))) {
      var kind = m[1];
      var block = m[2];
      var name = decodeXml(((block.match(/<Name>([^<]*)<\/Name>/) || [])[1] || '')).trim();
      if (!name || name === ' ') continue;
      var current = ((block.match(/<CurrentValue>([^<]*)<\/CurrentValue>/) || [])[1] || '').trim();
      var varying = String(((block.match(/<IsTimeVarying>([^<]*)<\/IsTimeVarying>/) || [])[1] || '')).toLowerCase() === 'true';
      var keyframesRaw = ((block.match(/<Keyframes>([^<]*)<\/Keyframes>/) || [])[1] || '').trim();
      var keys = [];
      if (keyframesRaw) {
        var parts = keyframesRaw.split(';');
        for (var i = 0; i < parts.length; i++) {
          var piece = parts[i].trim();
          if (!piece) continue;
          var fields = piece.split(',');
          if (fields.length < 2) continue;
          keys.push({ tick: fields[0], value: fields.slice(1).join(',') });
        }
      }
      params.push({
        kind: kind,
        name: name,
        current: current,
        varying: varying,
        keys: keys
      });
    }
    return params;
  }

  function parseComponentParams(objs, componentId) {
    if (!componentId || !objs[componentId]) return [];
    // Component body only references Param ObjectRefs; params are siblings in the file.
    // Collect from the whole object map by scanning all param-bearing bodies that belong
    // to this component via Param Index refs when present; otherwise parse the filter
    // component's surrounding XML is incomplete. Fallback: parse every param object
    // referenced in the component Params block.
    var body = objs[componentId].body || '';
    var refs = [];
    var block = body.match(/<Params[\s\S]*?<\/Params>/);
    if (block) {
      var rm;
      var rr = /ObjectRef="(\d+)"/g;
      while ((rm = rr.exec(block[0]))) refs.push(rm[1]);
    }
    if (!refs.length) return parseParamBlocks(body);

    // Rebuild a synthetic body from referenced objects for param parsing.
    // Param objects are stored as top-level PremiereData children, so re-read from XML map:
    // We stored only selected tags. Re-parse from raw xml for param ObjectIDs.
    return null;
  }

  function decodePremiereColor64(raw) {
    try {
      var s = String(raw == null ? '' : raw).split('.')[0].trim();
      if (!/^\d+$/.test(s)) return null;
      if (typeof BigInt === 'undefined') return null;
      var hex = BigInt(s).toString(16);
      while (hex.length < 16) hex = '0' + hex;
      function ch(i) {
        return (parseInt(hex.substr(i, 4), 16) >> 8) & 255;
      }
      return [ch(0), ch(4), ch(8), ch(12)];
    } catch (_) {
      return null;
    }
  }

  function startKeyframeValue(block) {
    var raw = ((block.match(/<StartKeyframe>([^<]*)<\/StartKeyframe>/) || [])[1] || '').trim();
    if (!raw) return '';
    var fields = raw.split(',');
    return fields.length >= 2 ? String(fields[1] || '').trim() : '';
  }

  function extractParamsFromXml(xml, componentId) {
    if (!componentId) return [];
    var compRe = new RegExp(
      '<(?:VideoFilterComponent|AudioFilterComponent)\\s+ObjectID="' + componentId + '"[^>]*>([\\s\\S]*?)<\\/(?:VideoFilterComponent|AudioFilterComponent)>'
    );
    var comp = xml.match(compRe);
    if (!comp) return [];
    var refs = [];
    var paramsBlock = comp[1].match(/<Params[\s\S]*?<\/Params>/);
    if (paramsBlock) {
      var rm;
      var rr = /ObjectRef="(\d+)"/g;
      while ((rm = rr.exec(paramsBlock[0]))) refs.push(rm[1]);
    }
    var out = [];
    for (var i = 0; i < refs.length; i++) {
      var id = refs[i];
      var pref = new RegExp(
        '<(VideoComponentParam|PointComponentParam|ColorComponentParam)\\s+ObjectID="' + id + '"[^>]*>([\\s\\S]*?)<\\/\\1>'
      );
      var pm = xml.match(pref);
      if (!pm) continue;
      var block = pm[2];
      var name = decodeXml(((block.match(/<Name>([^<]*)<\/Name>/) || [])[1] || '')).trim();
      if (!name || name === ' ') continue;
      var current = ((block.match(/<CurrentValue>([^<]*)<\/CurrentValue>/) || [])[1] || '').trim();
      var varying = String(((block.match(/<IsTimeVarying>([^<]*)<\/IsTimeVarying>/) || [])[1] || '')).toLowerCase() === 'true';
      var controlType = ((block.match(/<ParameterControlType>([^<]*)<\/ParameterControlType>/) || [])[1] || '').trim();
      var startVal = startKeyframeValue(block);
      // Premiere .prfpset files often leave CurrentValue at 0 and store the
      // real static value in StartKeyframe (Deep Glow opacity/color/tint).
      if (!varying && startVal !== '') current = startVal;
      var isColor = controlType === '5' || pm[1] === 'ColorComponentParam' ||
        /color|map black|map white/i.test(name);
      if (isColor) {
        var rgba = decodePremiereColor64(current);
        if (rgba) current = rgba.join(',');
      }
      var keyframesRaw = ((block.match(/<Keyframes>([^<]*)<\/Keyframes>/) || [])[1] || '').trim();
      var keys = [];
      if (keyframesRaw) {
        var parts = keyframesRaw.split(';');
        for (var k = 0; k < parts.length; k++) {
          var piece = parts[k].trim();
          if (!piece) continue;
          var fields = piece.split(',');
          if (fields.length < 2) continue;
          keys.push({ tick: fields[0], raw: fields.slice(1).join(',') });
        }
      }
      out.push({
        kind: pm[1],
        name: name,
        current: current,
        varying: varying,
        keys: keys,
        isColor: !!isColor
      });
    }
    return out;
  }

  function listNamedPresets(filePath, xml) {
    var objs = parseObjects(xml);
    var presets = [];
    Object.keys(objs).forEach(function (id) {
      var o = objs[id];
      if (o.tag !== 'TreeItem' || !o.dataRef) return;
      if (!o.name || SKIP_NAMES[o.name]) return;
      var data = objs[o.dataRef];
      if (!data || data.tag !== 'FilterPresetItem') return;
      var filters = [];
      for (var i = 0; i < data.presetRefs.length; i++) {
        var f = objs[data.presetRefs[i]];
        if (!f || f.tag !== 'FilterPreset') continue;
        var display = f.display;
        if ((!display || !display.length) && f.componentRef && objs[f.componentRef]) {
          display = objs[f.componentRef].display || '';
        }
        filters.push({
          matchName: f.matchName,
          displayName: display || f.matchName,
          anchorIn: f.anchorIn,
          params: extractParamsFromXml(xml, f.componentRef)
        });
      }
      if (!filters.length) return;
      presets.push({ name: o.name, filters: filters });
    });
    return presets;
  }

  function walkPrfpsetFiles(rootDir) {
    var req = nodeRequire();
    if (!req) return [];
    var fs = req('fs');
    var path = req('path');
    if (!fs.existsSync(rootDir)) return [];
    var out = [];
    function walk(dir) {
      var entries;
      try { entries = fs.readdirSync(dir); } catch (_) { return; }
      for (var i = 0; i < entries.length; i++) {
        var full = path.join(dir, entries[i]);
        var st;
        try { st = fs.statSync(full); } catch (_) { continue; }
        if (st.isDirectory()) walk(full);
        else if (/\.prfpset$/i.test(entries[i])) out.push(full);
      }
    }
    walk(rootDir);
    return out;
  }

  function extensionPresetsRoot() {
    var req = nodeRequire();
    if (!req) return null;
    var path = req('path');
    var fs = req('fs');
    var candidates = [];
    try {
      var cs = global.csInterface || (typeof CSInterface !== 'undefined' ? new CSInterface() : null);
      if (cs && typeof SystemPath !== 'undefined') {
        candidates.push(path.join(cs.getSystemPath(SystemPath.EXTENSION), 'presets', 'prfpset'));
      }
    } catch (_) {}
    try {
      if (typeof __dirname !== 'undefined') {
        candidates.push(path.join(__dirname, '..', 'presets', 'prfpset'));
      }
    } catch (_) {}
    for (var i = 0; i < candidates.length; i++) {
      try {
        if (candidates[i] && fs.existsSync(candidates[i])) return candidates[i];
      } catch (_) {}
    }
    return candidates[0] || null;
  }

  function catalogFromFile(filePath) {
    var req = nodeRequire();
    if (!req) return [];
    var fs = req('fs');
    var path = req('path');
    if (!fs.existsSync(filePath)) return [];
    var xml = fs.readFileSync(filePath, 'utf8');
    var named = listNamedPresets(filePath, xml);
    var pack = path.basename(path.dirname(filePath));
    if (/^prfpset$/i.test(pack)) pack = path.basename(filePath, path.extname(filePath));
    return named.map(function (p) {
      return {
        name: p.name,
        path: filePath,
        pack: pack,
        folderPath: pack,
        filterCount: p.filters.length,
        filters: p.filters,
        preview: describePreview(p.name, p.filters)
      };
    });
  }

  function numParam(filters, names) {
    var want = {};
    for (var i = 0; i < names.length; i++) want[String(names[i]).toLowerCase()] = 1;
    for (var f = 0; f < (filters || []).length; f++) {
      var params = filters[f].params || [];
      for (var p = 0; p < params.length; p++) {
        if (!want[String(params[p].name || '').toLowerCase()]) continue;
        var n = parseFloat(params[p].current);
        if (!isNaN(n)) return n;
      }
    }
    return 0;
  }

  function hasMatch(filters, part) {
    var needle = String(part || '').toLowerCase();
    for (var i = 0; i < (filters || []).length; i++) {
      var hay = String((filters[i].matchName || '') + ' ' + (filters[i].displayName || '')).toLowerCase();
      if (hay.indexOf(needle) >= 0) return true;
    }
    return false;
  }

  function describePreview(name, filters) {
    var text = String(name || '').toLowerCase();
    var motion = 'pop';
    if (/flick|shake|camera/.test(text)) motion = 'flick';
    else if (/fade\s*out|disappear/.test(text)) motion = 'fade-out';
    else if (/fade|appear|in\b/.test(text)) motion = 'fade-in';
    else if (/down|drop/.test(text)) motion = 'slide-down';
    else if (/up|rise|pop/.test(text)) motion = 'slide-up';
    else if (/left/.test(text)) motion = 'slide-left';
    else if (/right/.test(text)) motion = 'slide-right';
    else if (/3d|swivel|tilt|rotate/.test(text)) motion = 'swivel';
    else if (/blur/.test(text) || hasMatch(filters, 'blur')) motion = 'blur';
    else if (/glow|shadow/.test(text) || hasMatch(filters, 'shadow')) motion = 'glow';
    else if (hasMatch(filters, 'transform') || hasMatch(filters, 'geometry')) motion = 'scale';
    return {
      motion: motion,
      label: hasMatch(filters, 'blur') ? 'BLUR' : (hasMatch(filters, 'shadow') || /glow/.test(text) ? 'GLOW' : 'FX'),
      glow: /glow|shadow/.test(text) || hasMatch(filters, 'shadow'),
      blur: Math.max(0, Math.min(18, numParam(filters, ['Blurriness']) / 4 || (/blur/.test(text) ? 8 : 0))),
      effects: (filters || []).map(function (f) { return f.displayName || f.matchName; }).filter(Boolean).slice(0, 3)
    };
  }

  function buildDefaultCatalog() {
    var root = extensionPresetsRoot();
    if (!root) return [];
    var files = walkPrfpsetFiles(root);
    var items = [];
    for (var i = 0; i < files.length; i++) {
      try {
        var part = catalogFromFile(files[i]);
        for (var j = 0; j < part.length; j++) items.push(part[j]);
      } catch (e) {
        try { console.warn('[PrfpsetCatalog] failed', files[i], e); } catch (_) {}
      }
    }
    return items;
  }

  function getApplyPayload(filePath, presetName) {
    var req = nodeRequire();
    if (!req) return null;
    var fs = req('fs');
    if (!fs.existsSync(filePath)) return null;
    var xml = fs.readFileSync(filePath, 'utf8');
    var named = listNamedPresets(filePath, xml);
    for (var i = 0; i < named.length; i++) {
      if (named[i].name === presetName) {
        return {
          name: named[i].name,
          path: filePath,
          ticksPerSecond: TICKS_PER_SECOND,
          filters: named[i].filters
        };
      }
    }
    return null;
  }

  global.PrfpsetCatalog = {
    buildDefaultCatalog: buildDefaultCatalog,
    catalogFromFile: catalogFromFile,
    walkPrfpsetFiles: walkPrfpsetFiles,
    getApplyPayload: getApplyPayload,
    describePreview: describePreview,
    extensionPresetsRoot: extensionPresetsRoot,
    TICKS_PER_SECOND: TICKS_PER_SECOND
  };
}(window));
