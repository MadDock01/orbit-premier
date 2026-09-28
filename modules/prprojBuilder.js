/**
 * prprojBuilder.js — FireCut-style .prproj XML manipulation for Model 4
 *
 * Builds ONE "MachiCut_Captions" nested sequence containing ALL caption clips
 * pre-placed on 3 video tracks (V1=post, V2=current, V3=pre) with exact
 * Start/End ticks baked into the XML.
 *
 * Flow:
 *   1. Read + gunzip the live .prproj
 *   2. Extract ClassIDs from existing project elements
 *   3. Find each PNG's MasterClip ObjectUID + VideoMediaSource ObjectID
 *   4. Build ONE <Sequence> with 3 tracks and all clips pre-placed
 *   5. Inject into XML, write uncompressed temp .prproj
 *
 * The caller then does:
 *   ExtendScript: importFiles([tempPath])  → sequence in project panel
 *   ExtendScript: overwriteClip(seqItem, T=0) on main timeline  → ONE call
 */

'use strict';

var prprojBuilder = (function () {

    var fs   = require('fs');
    var path = require('path');
    var os   = require('os');
    var zlib = require('zlib');

    // ── Helpers ───────────────────────────────────────────────────────────────

    function readPrproj(prprojPath) {
        var data = fs.readFileSync(prprojPath);
        try { return zlib.gunzipSync(data).toString('utf8'); }
        catch (_) { return data.toString('utf8'); }
    }

    // Strip large binary/thumbnail blobs that bloat the file but aren't needed
    // for sequence injection. These elements store embedded media previews.
    var STRIP_TAGS = [
        'ThumbNail', 'Thumbnail', 'CustomData', 'MetaData',
        'PreviewFiles', 'CachedData', 'PeakData',
        'MasterClipMetadata', 'MediaLocatorFactory'
    ];

    function stripBlobTags(xmlStr) {
        for (var ti = 0; ti < STRIP_TAGS.length; ti++) {
            var tag = STRIP_TAGS[ti];
            // Remove <TagName ...>...</TagName> (possibly multiline, greedy per-block)
            // Use split/join to avoid regex catastrophic backtracking on huge strings
            var open = '<' + tag;
            var close = '</' + tag + '>';
            var parts = xmlStr.split(open);
            if (parts.length < 2) continue;
            var rebuilt = [parts[0]];
            for (var pi = 1; pi < parts.length; pi++) {
                var closeIdx = parts[pi].indexOf(close);
                if (closeIdx >= 0) {
                    rebuilt.push(parts[pi].slice(closeIdx + close.length));
                } else {
                    // self-closing: find end of tag
                    var selfEnd = parts[pi].indexOf('>');
                    if (selfEnd >= 0) rebuilt.push(parts[pi].slice(selfEnd + 1));
                    else rebuilt.push(parts[pi]);
                }
            }
            xmlStr = rebuilt.join('');
        }
        return xmlStr;
    }

    function writeTempPrproj(xmlStr) {
        var slim = stripBlobTags(xmlStr);
        var tmp = path.join(os.tmpdir(), 'ae_m4_captions.prproj');
        fs.writeFileSync(tmp, slim, 'utf8');
        return tmp;
    }

    function getNextObjectId(xmlStr) {
        var max = 0;
        var re = /ObjectID="(\d+)"/g, m;
        while ((m = re.exec(xmlStr))) {
            var n = parseInt(m[1], 10);
            if (n > max) max = n;
        }
        return max + 1;
    }

    function uuid() {
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
            var r = (Math.random() * 16) | 0;
            var v = c === 'x' ? r : ((r & 0x3) | 0x8);
            return v.toString(16).toUpperCase();
        });
    }

    function escapeRe(s) {
        return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    // ── ClassID extraction ────────────────────────────────────────────────────

    function extractClassIds(xmlStr) {
        function first(tag) {
            var re = new RegExp('<' + tag + '\\s[^>]*ClassID="([^"]+)"');
            var m = xmlStr.match(re);
            return m ? m[1] : null;
        }
        return {
            sequence:            first('Sequence'),
            sequenceProjectItem: first('SequenceProjectItem'),
            videoTrackGroup:     first('VideoTrackGroup'),
            videoClipTrack:      first('VideoClipTrack'),
            videoClipTrackItem:  first('VideoClipTrackItem'),
            videoComponentChain: first('VideoComponentChain'),
            subClip:             first('SubClip'),
            videoClip:           first('VideoClip'),
        };
    }

    // ── PNG media reference lookup ────────────────────────────────────────────

    function findPngMediaInfo(xmlStr, pngBasename) {
        var re = new RegExp('<FilePath>[^<]*' + escapeRe(pngBasename) + '[^<]*<\\/FilePath>');
        var m  = xmlStr.match(re);
        if (!m) return null;

        var before = xmlStr.slice(0, m.index);

        var vmsStart = before.lastIndexOf('<VideoMediaSource ');
        var vmsText  = vmsStart >= 0 ? xmlStr.slice(vmsStart, vmsStart + 300) : '';
        var vmsIdM   = vmsText.match(/ObjectID="(\d+)"/);
        var mediaSourceId = vmsIdM ? vmsIdM[1] : null;

        var mcStart = before.lastIndexOf('<MasterClip ');
        var mcText  = mcStart >= 0 ? xmlStr.slice(mcStart, mcStart + 300) : '';
        var mcUidM  = mcText.match(/ObjectUID="([^"]+)"/);
        var masterClipURef = mcUidM ? mcUidM[1] : null;

        return { mediaSourceId: mediaSourceId, masterClipURef: masterClipURef };
    }

    // ── SequenceProjectItem injection ─────────────────────────────────────────

    function buildSequenceProjectItemXml(cids, seqPIObjectId, seqPIUid, seqObjectId, seqName) {
        return [
            '<SequenceProjectItem ObjectID="' + seqPIObjectId + '" ClassID="' + cids.sequenceProjectItem + '" Version="2"',
            '                     ObjectUID="' + seqPIUid + '">',
            '  <ProjectItem Version="1">',
            '    <Name>' + seqName + '</Name>',
            '    <IsHidden>0</IsHidden>',
            '  </ProjectItem>',
            '  <Sequence ObjectRef="' + seqObjectId + '"/>',
            '</SequenceProjectItem>',
        ].join('\n');
    }

    function injectProjectItems(xmlStr, seqInfoList, cids) {
        var piXml = seqInfoList.map(function(info) {
            return buildSequenceProjectItemXml(cids, info.seqPIId, info.seqPIUid, info.seqId, info.seqName);
        }).join('\n');

        var insertPt = xmlStr.lastIndexOf('</PremiereData>');
        if (insertPt < 0) insertPt = xmlStr.lastIndexOf('</Project>');
        xmlStr = xmlStr.slice(0, insertPt)
            + '\n<!-- MachiCut Captions -->\n'
            + piXml + '\n'
            + xmlStr.slice(insertPt);

        var itemRefs = seqInfoList.map(function(info) {
            return '      <Item ObjectURef="' + info.seqPIUid + '"/>';
        }).join('\n');

        var firstBinStart = xmlStr.search(/<BinProjectItem\s/);
        if (firstBinStart < 0) firstBinStart = 0;
        var itemsCloseIdx = xmlStr.indexOf('</Items>', firstBinStart);
        if (itemsCloseIdx >= 0) {
            xmlStr = xmlStr.slice(0, itemsCloseIdx) + itemRefs + '\n' + xmlStr.slice(itemsCloseIdx);
        } else {
            var childrenCloseIdx = xmlStr.indexOf('</Children>');
            if (childrenCloseIdx >= 0) {
                var legacyRefs = seqInfoList.map(function(info) {
                    return '    <ProjectItemRef ObjectRef="' + info.seqPIId + '"/>';
                }).join('\n');
                xmlStr = xmlStr.slice(0, childrenCloseIdx) + legacyRefs + '\n' + xmlStr.slice(childrenCloseIdx);
            }
        }
        return xmlStr;
    }

    // ── ONE big captions sequence XML ─────────────────────────────────────────
    //
    // Builds a single <Sequence> with 3 video tracks and all clips pre-placed.
    // Each clip has its exact Start/End ticks baked in — no API trimming needed.
    // Track layout inside the nested sequence:
    //   V1 = Post  (dim text after current word)
    //   V2 = Current (highlighted word)
    //   V3 = Pre   (dim text before current word)

    function buildCaptionsSequenceXml(cids, nextId, seqName, seqUid, clipsByTrack, frameRect) {
        var fr  = frameRect || '0,0,1920,1080';
        var out = [];
        var id  = nextId;

        var seqId  = id++;
        var NTRACKS = 3;
        var vtgIds = [], vctIds = [];
        for (var t = 0; t < NTRACKS; t++) { vtgIds.push(id++); vctIds.push(id++); }

        // Assign ObjectIDs to every clip element up front
        for (var t = 0; t < NTRACKS; t++) {
            var tClips = clipsByTrack[t + 1] || [];
            for (var ci = 0; ci < tClips.length; ci++) {
                tClips[ci].vctiId = id++;
                tClips[ci].vccId  = id++;
                tClips[ci].scId   = id++;
                tClips[ci].vcId   = id++;
            }
        }

        // ── <Sequence> ───────────────────────────────────────────────────────
        out.push(
            '<Sequence ObjectID="' + seqId + '" ClassID="' + cids.sequence + '" Version="1"',
            '          ObjectUID="' + seqUid + '">',
            '  <Name>' + seqName + '</Name>',
            '  <VideoTracks>'
        );

        for (var t = 0; t < NTRACKS; t++) {
            out.push(
                '    <VideoTrackGroup ObjectID="' + vtgIds[t] + '" ClassID="' + cids.videoTrackGroup + '" Version="1">',
                '      <Second ObjectRef="' + vctIds[t] + '"/>',
                '    </VideoTrackGroup>'
            );
        }

        for (var t = 0; t < NTRACKS; t++) {
            var tClips = clipsByTrack[t + 1] || [];
            out.push(
                '    <VideoClipTrack ObjectID="' + vctIds[t] + '" ClassID="' + cids.videoClipTrack + '" Version="1">',
                '      <TrackItems Version="1">'
            );
            for (var ci = 0; ci < tClips.length; ci++) {
                out.push('        <TrackItem Index="' + ci + '" ObjectRef="' + tClips[ci].vctiId + '"/>');
            }
            out.push('      </TrackItems>', '    </VideoClipTrack>');
        }

        out.push('  </VideoTracks>', '  <AudioTracks/>', '</Sequence>');

        // ── Clip elements (VideoClipTrackItem + VideoComponentChain + SubClip + VideoClip) ──
        for (var t = 0; t < NTRACKS; t++) {
            var tClips = clipsByTrack[t + 1] || [];
            for (var ci = 0; ci < tClips.length; ci++) {
                var c  = tClips[ci];
                var ms = c.mediaInfo || {};
                out.push(
                    '<VideoClipTrackItem ObjectID="' + c.vctiId + '" ClassID="' + cids.videoClipTrackItem + '" Version="6">',
                    '  <ClipTrackItem Version="8">',
                    '    <ComponentOwner Version="1">',
                    '      <Components ObjectRef="' + c.vccId + '"/>',
                    '    </ComponentOwner>',
                    '    <TrackItem Version="3">',
                    '      <Start>' + c.startTicks + '</Start>',
                    '      <End>'   + c.endTicks   + '</End>',
                    '    </TrackItem>',
                    '    <SubClip ObjectRef="' + c.scId + '"/>',
                    '  </ClipTrackItem>',
                    '  <PixelAspectRatio>1,1</PixelAspectRatio>',
                    '  <FrameRect>' + fr + '</FrameRect>',
                    '</VideoClipTrackItem>',

                    '<VideoComponentChain ObjectID="' + c.vccId + '" ClassID="' + cids.videoComponentChain + '" Version="3">',
                    '  <ComponentChain Version="3">',
                    '    <Node Version="1">',
                    '      <Properties Version="1">',
                    '        <MZ.ComponentChain.ActiveComponentID>2</MZ.ComponentChain.ActiveComponentID>',
                    '        <MZ.ComponentChain.ActiveComponentParamIndex>4294967295</MZ.ComponentChain.ActiveComponentParamIndex>',
                    '      </Properties>',
                    '    </Node>',
                    '  </ComponentChain>',
                    '  <DefaultMotion>true</DefaultMotion>',
                    '  <DefaultOpacity>true</DefaultOpacity>',
                    '  <DefaultMotionComponentID>1</DefaultMotionComponentID>',
                    '  <DefaultOpacityComponentID>2</DefaultOpacityComponentID>',
                    '</VideoComponentChain>',

                    '<SubClip ObjectID="' + c.scId + '" ClassID="' + cids.subClip + '" Version="5">',
                    '  <Clip ObjectRef="' + c.vcId + '"/>',
                    '  <MasterClip ObjectURef="' + (ms.masterClipURef || '') + '"/>',
                    '  <Name>' + c.name + '</Name>',
                    '  <OrigChGrp>0</OrigChGrp>',
                    '</SubClip>',

                    '<VideoClip ObjectID="' + c.vcId + '" ClassID="' + cids.videoClip + '" Version="11">',
                    '  <Clip Version="18">',
                    '    <Node Version="1">',
                    '      <Properties Version="1">',
                    '        <BE.Prefs.StillImages.DefaultIsDropFrame>false</BE.Prefs.StillImages.DefaultIsDropFrame>',
                    '        <asl.clip.label.color>8359173</asl.clip.label.color>',
                    '      </Properties>',
                    '    </Node>',
                    '    <Source ObjectRef="' + (ms.mediaSourceId || '') + '"/>',
                    '    <ClipID>' + uuid() + '</ClipID>',
                    '    <InPoint>914457600000000</InPoint>',
                    '    <OutPoint>914965632000000</OutPoint>',
                    '  </Clip>',
                    '</VideoClip>'
                );
            }
        }

        return { xml: out.join('\n'), seqId: seqId, nextId: id };
    }

    // ── Main entry point ──────────────────────────────────────────────────────

    /**
     * buildCaptionsSequence(prprojPath, clips, frameRect)
     *
     * Builds ONE nested sequence with all caption clips pre-placed on 3 tracks.
     * All clips (pre/current/post) are PNG stills — no nested sequence per word.
     *
     * @param  {string}  prprojPath  – path to the live .prproj (already saved)
     * @param  {Array}   clips       – all clips: { pngPath, startTicks, endTicks, track }
     * @param  {string}  frameRect   – "0,0,W,H"
     * @returns {{ tempPath, seqName, errors }}
     */
    function buildCaptionsSequence(prprojPath, clips, frameRect) {
        var errors = [];

        // 1. Read prproj
        var xmlStr;
        try { xmlStr = readPrproj(prprojPath); }
        catch (e) { return { tempPath: null, errors: ['read: ' + e.message] }; }

        // 2. ClassIDs
        var cids = extractClassIds(xmlStr);
        if (!cids.sequence)             cids.sequence            = '{23e738ab-d8b8-4218-9a47-2ed7b24dad12}';
        if (!cids.sequenceProjectItem)  cids.sequenceProjectItem = '{ea3f6df1-f4a1-4a53-924b-f19e31390a59}';
        if (!cids.videoTrackGroup)      cids.videoTrackGroup     = '{b5b682c0-c5bf-4ee4-8e86-28aecc88c5ae}';
        if (!cids.videoClipTrack)       cids.videoClipTrack      = '{a85e4640-5ebc-40e8-bb11-3b92b4f9f1f3}';
        if (!cids.videoClipTrackItem)   cids.videoClipTrackItem  = '{61befb3e-58d2-41a0-9e11-7f7a4e37b7d7}';
        if (!cids.videoComponentChain)  cids.videoComponentChain = '{6ab42ff3-61ae-4e73-9a4a-9a7d22baebf3}';
        if (!cids.subClip)              cids.subClip             = '{8e0af0bc-02d1-4a1e-b99d-1ee19b4af3f3}';
        if (!cids.videoClip)            cids.videoClip           = '{5eb80e5e-72f0-4dd2-abb6-82fc2aad6ac5}';

        // 3. Next free ObjectID
        var nextId = getNextObjectId(xmlStr);

        // 4. Group clips by track, look up PNG media info
        var clipsByTrack = { 1: [], 2: [], 3: [] };

        for (var ci = 0; ci < clips.length; ci++) {
            var clip        = clips[ci];
            var pngBasename = (clip.pngPath || '').replace(/\\/g, '/').split('/').pop();
            var mediaInfo   = findPngMediaInfo(xmlStr, pngBasename);
            if (!mediaInfo || !mediaInfo.masterClipURef) {
                errors.push('PNG not in prproj: ' + pngBasename);
                continue;
            }
            var track = clip.track || 2;
            if (!clipsByTrack[track]) clipsByTrack[track] = [];
            clipsByTrack[track].push({
                startTicks: clip.startTicks,
                endTicks:   clip.endTicks,
                mediaInfo:  mediaInfo,
                name:       pngBasename.replace(/\.png$/i, '')
            });
        }

        var totalClips = (clipsByTrack[1] || []).length
                       + (clipsByTrack[2] || []).length
                       + (clipsByTrack[3] || []).length;
        if (totalClips === 0) {
            return { tempPath: null, errors: errors.concat(['no clips resolved']) };
        }

        // 5. Build ONE big sequence XML
        var seqName  = 'CompX_Captions';
        var seqUid   = uuid();
        var seqPIUid = uuid();

        var built  = buildCaptionsSequenceXml(cids, nextId, seqName, seqUid, clipsByTrack, frameRect);
        nextId     = built.nextId;
        var seqPIId = nextId++;

        // 6. Inject sequence + SequenceProjectItem into prproj XML
        var insertPt = xmlStr.lastIndexOf('</PremiereData>');
        if (insertPt < 0) insertPt = xmlStr.lastIndexOf('</Project>');
        if (insertPt < 0) {
            return { tempPath: null, errors: errors.concat(['</PremiereData> not found']) };
        }

        var newXml = xmlStr.slice(0, insertPt)
            + '\n<!-- MachiCut Captions captions -->\n'
            + built.xml + '\n'
            + xmlStr.slice(insertPt);

        newXml = injectProjectItems(newXml,
            [{ seqPIId: seqPIId, seqPIUid: seqPIUid, seqId: built.seqId, seqName: seqName }],
            cids);

        // 7. Write temp prproj
        var tempPath;
        try { tempPath = writeTempPrproj(newXml); }
        catch (e) { return { tempPath: null, errors: errors.concat(['write: ' + e.message]) }; }

        return { tempPath: tempPath, seqName: seqName, errors: errors };
    }

    return { buildCaptionsSequence: buildCaptionsSequence };

})();
