(function() {
    function createHostDomAdapter(rootDocument) {
        const cache = {};
        let cacheGeneration = 0;
        let observer = null;
        const domChangeListeners = [];
        const observedRoots = typeof WeakSet !== 'undefined' ? new WeakSet() : [];

        function getSearchRoot() {
            return rootDocument.body || rootDocument.documentElement || rootDocument;
        }

        function getMutationObserverCtor() {
            if (typeof window !== 'undefined' && window.MutationObserver) return window.MutationObserver;
            if (typeof MutationObserver !== 'undefined') return MutationObserver;
            return null;
        }

        function hasSetValue(set, value) {
            if (!value) return true;
            if (typeof set.has === 'function') return set.has(value);
            return set.indexOf(value) !== -1;
        }

        function addSetValue(set, value) {
            if (!value) return;
            if (typeof set.add === 'function') set.add(value);
            else set.push(value);
        }

        function invalidateCache() {
            Object.keys(cache).forEach(key => delete cache[key]);
            cacheGeneration++;
        }

        function notifyDomChanged() {
            domChangeListeners.slice().forEach(listener => {
                try {
                    listener();
                } catch (e) {}
            });
        }

        function observeRoot(root) {
            const ObserverCtor = getMutationObserverCtor();
            if (!root || !ObserverCtor || hasSetValue(observedRoots, root)) return;

            try {
                if (!observer) observer = new ObserverCtor(() => {
                    invalidateCache();
                    notifyDomChanged();
                });
                observer.observe(root, {
                    childList: true,
                    subtree: true,
                    attributes: true,
                    characterData: true
                });
                addSetValue(observedRoots, root);
            } catch (e) {}
        }

        function onDomChanged(listener) {
            if (typeof listener !== 'function') return function() {};

            domChangeListeners.push(listener);
            observeRoot(getSearchRoot());

            return function unsubscribeDomChanged() {
                const index = domChangeListeners.indexOf(listener);
                if (index !== -1) domChangeListeners.splice(index, 1);
            };
        }

        function markSeen(seen, value) {
            if (!value) return true;
            if (typeof seen.has === 'function') {
                if (seen.has(value)) return true;
                seen.add(value);
                return false;
            }

            if (seen.indexOf(value) !== -1) return true;
            seen.push(value);
            return false;
        }

        function getNodeChildren(node) {
            const children = (node && (node.children || node.childNodes)) || [];
            const result = [];
            for (let i = 0; i < children.length; i++) result.push(children[i]);
            return result;
        }

        function findDeepNode(predicate, root) {
            const searchRoot = root || getSearchRoot();
            if (!searchRoot) return null;

            observeRoot(searchRoot);
            const queue = [searchRoot];
            const seen = typeof WeakSet !== 'undefined' ? new WeakSet() : [];

            while (queue.length > 0) {
                const node = queue.shift();
                if (!node || markSeen(seen, node)) continue;

                try {
                    if (predicate(node)) return node;
                } catch (e) {}

                if (node.shadowRoot) {
                    observeRoot(node.shadowRoot);
                    queue.push(node.shadowRoot);
                }

                const children = getNodeChildren(node);
                for (let i = 0; i < children.length; i++) queue.push(children[i]);
            }

            return null;
        }

        function findAllDeepNodes(predicate, root) {
            const searchRoot = root || getSearchRoot();
            const results = [];
            if (!searchRoot) return results;

            observeRoot(searchRoot);
            const queue = [searchRoot];
            const seen = typeof WeakSet !== 'undefined' ? new WeakSet() : [];

            while (queue.length > 0) {
                const node = queue.shift();
                if (!node || markSeen(seen, node)) continue;

                try {
                    if (predicate(node)) results.push(node);
                } catch (e) {}

                if (node.shadowRoot) {
                    observeRoot(node.shadowRoot);
                    queue.push(node.shadowRoot);
                }

                const children = getNodeChildren(node);
                for (let i = 0; i < children.length; i++) queue.push(children[i]);
            }

            return results;
        }

        function isNodeConnected(node) {
            if (!node) return false;
            if (typeof node.isConnected === 'boolean') return node.isConnected;

            const searchRoot = getSearchRoot();
            let current = node;

            for (let i = 0; current && i < 1000; i++) {
                if (current === searchRoot || current === rootDocument || current === rootDocument.documentElement) return true;
                if (current.parentNode) {
                    current = current.parentNode;
                    continue;
                }
                if (current.host) {
                    current = current.host;
                    continue;
                }
                if (typeof current.getRootNode === 'function') {
                    const rootNode = current.getRootNode();
                    if (rootNode && rootNode !== current) {
                        current = rootNode.host || rootNode;
                        continue;
                    }
                }
                break;
            }

            return current === searchRoot;
        }

        function getCachedNode(key, finder) {
            const cached = cache[key];
            if (cached && cached.type === 'node' && cached.generation === cacheGeneration && isNodeConnected(cached.value)) {
                return cached.value;
            }

            if (cached) delete cache[key];

            const value = finder();
            if (value) cache[key] = { type: 'node', value, generation: cacheGeneration };
            return value || null;
        }

        function getCachedList(key, finder) {
            const cached = cache[key];
            if (cached && cached.type === 'list' && cached.generation === cacheGeneration && cached.value.every(isNodeConnected)) {
                return cached.value.slice();
            }

            if (cached) delete cache[key];

            const value = finder().filter(Boolean);
            if (value.length > 0) cache[key] = { type: 'list', value, generation: cacheGeneration };
            return value.slice();
        }

        function cleanText(value) {
            return String(value || '').replace(/\s+/g, ' ').trim();
        }

        function getNodeText(node) {
            return cleanText(node && (node.innerText || node.textContent));
        }

        function getAttribute(node, attribute) {
            return node && typeof node.getAttribute === 'function' ? node.getAttribute(attribute) : null;
        }

        function hasAttribute(node, attribute) {
            return node && typeof node.hasAttribute === 'function' && node.hasAttribute(attribute);
        }

        function hasClass(node, className) {
            if (!node) return false;
            if (node.classList && typeof node.classList.contains === 'function') return node.classList.contains(className);

            const classText = getAttribute(node, 'class') || node.className || '';
            return String(classText).split(/\s+/).indexOf(className) !== -1;
        }

        function getComputedDisplay(node) {
            try {
                if (typeof window !== 'undefined' && window.getComputedStyle) {
                    const style = window.getComputedStyle(node);
                    if (style) return style.display;
                }
            } catch (e) {}

            return node && node.style ? node.style.display : '';
        }

        function isElementHidden(node) {
            if (!node) return true;
            return node.hidden === true || hasAttribute(node, 'hidden') || getComputedDisplay(node) === 'none';
        }

        function getComposedParent(node) {
            if (!node) return null;
            if (node.parentNode) return node.parentNode;
            if (node.host) return node.host;
            if (typeof node.getRootNode === 'function') {
                const rootNode = node.getRootNode();
                if (rootNode && rootNode.host) return rootNode.host;
            }
            return null;
        }

        function closestComposed(node, predicate) {
            let current = node;
            while (current) {
                try {
                    if (predicate(current)) return current;
                } catch (e) {}
                current = getComposedParent(current);
            }
            return null;
        }

        function getAnnotationDetail() {
            return getCachedNode('annotationDetail', () => findDeepNode(n => n.tagName === 'SC-ANNOTATION-DETAIL'));
        }

        function getMeasurementsPanel() {
            return getCachedNode('measurementsPanel', () => findDeepNode(n => n.tagName === 'SC-MEASUREMENTS-PANEL'));
        }

        function getDrawingGuides() {
            return getCachedNode('drawingGuides', () => findDeepNode(n => n.tagName === 'SC-DRAWING-GUIDES'));
        }

        function getDrawingGuidesPanel() {
            const guides = getDrawingGuides();
            const panel = guides && guides.parentElement;
            return hasClass(panel, 'panels') ? panel : null;
        }

        function getMeasurementsToolbar() {
            const panel = getDrawingGuidesPanel();
            if (!panel) return null;
            return getCachedNode('measurementsToolbar', () => findDeepNode(n => n.tagName === 'SC-SIMPLEMEASUREMENTS-TOOLBAR', panel));
        }

        function isDrawingGuidesHidden() {
            return isElementHidden(getDrawingGuides());
        }

        function getProjectViewerNav() {
            return getCachedNode('projectViewerNav', () => findDeepNode(n => n.tagName === 'SC-PROJECT-VIEWER-NAV'));
        }

        function getTimeline() {
            return getCachedNode('timeline', () => findDeepNode(n => n.tagName === 'CESIUM-TIMELINE') || findDeepNode(n => n.tagName === 'SC-TIMELINE'));
        }

        function getPolygonEditor() {
            return getCachedNode('polygonEditor', () => findDeepNode(n => n.tagName === 'SC-BASIC-ANNOTATION-EDITOR'));
        }

        function getAsBuiltLayer() {
            return getCachedNode('asBuiltLayer', () => findDeepNode(n => n.tagName === 'SC-AS-BUILT-LAYER'));
        }

        function getSurveyLayer() {
            return getCachedNode('surveyLayer', () => findDeepNode(n => n.tagName === 'SC-SURVEY-LAYER'));
        }

        function getProjectName() {
            const nav = getProjectViewerNav();
            if (nav) {
                const h3 = findDeepNode(n => n.tagName === 'H3', nav);
                if (h3) {
                    const spans = findAllDeepNodes(n => n.tagName === 'SPAN', h3);
                    if (spans[1] && getNodeText(spans[1])) return getNodeText(spans[1]);
                    if (getNodeText(h3)) return getNodeText(h3);
                }
            }

            return rootDocument.title || 'Project';
        }

        function getPolygonName() {
            const detail = getAnnotationDetail();
            if (detail) {
                const heading = findDeepNode(n => n.tagName === 'H3', detail);
                if (heading && getNodeText(heading)) return getNodeText(heading);
            }

            return 'Polygon';
        }

        function getTimelineDate() {
            const timeline = getTimeline();
            if (!timeline) return '';

            const divs = findAllDeepNodes(n => n.tagName === 'DIV', timeline);
            for (let i = 0; i < divs.length; i++) {
                const text = getNodeText(divs[i]);
                if (text && /\d/.test(text) && text.length <= 120) return text;
            }

            return getNodeText(timeline);
        }

        function getPolygonCoordinates() {
            const editor = getPolygonEditor();
            const annotationState = editor && editor._annotationState;
            if (!annotationState) return null;

            const commonNames = ["coordinates", "positions", "polygonBoundary", "points", "vertices", "geometry"];
            for (let i = 0; i < commonNames.length; i++) {
                const value = annotationState[commonNames[i]];
                if (Array.isArray(value) && value.length > 2) return value;
            }

            return null;
        }

        function getDataLayersTab() {
            return getCachedNode('dataLayersTab', () => {
                const svgPath = findDeepNode(n => {
                    const pathData = getAttribute(n, 'd');
                    return n.tagName === 'PATH' && pathData && pathData.startsWith('M264.5');
                });
                return closestComposed(svgPath, n => n.tagName === 'SC-TAB');
            });
        }

        function getToggleButtonForLayer(layer) {
            if (!layer) return null;
            const showToggle = findDeepNode(n => n.tagName === 'SC-SHOW-TOGGLE', layer);
            return showToggle ? findDeepNode(n => n.tagName === 'BUTTON', showToggle) : null;
        }

        function getPointCloudLayerToggles() {
            return getCachedList('pointCloudLayerToggles', () => [
                getToggleButtonForLayer(getAsBuiltLayer()),
                getToggleButtonForLayer(getSurveyLayer())
            ]);
        }

        function getCalibrationSpans() {
            return getCachedList('calibrationSpans', () => findAllDeepNodes(n => n.tagName === 'SPAN' && hasAttribute(n, 'data-label')));
        }

        function cleanNum(str) {
            const match = String(str || '').match(/[-+]?\d[\d\s.,]*/);
            if (!match) return 0;

            let value = match[0].replace(/\s/g, '');
            const commaIndex = value.lastIndexOf(',');
            const dotIndex = value.lastIndexOf('.');

            if (commaIndex !== -1 && dotIndex !== -1) {
                const decimalSeparator = commaIndex > dotIndex ? ',' : '.';
                const thousandsSeparator = decimalSeparator === ',' ? /\./g : /,/g;
                value = value.replace(thousandsSeparator, '').replace(decimalSeparator, '.');
            } else if (commaIndex !== -1) {
                const parts = value.split(',');
                value = parts.length === 2 ? parts[0] + '.' + parts[1] : value.replace(/,/g, '');
            } else {
                const parts = value.split('.');
                if (parts.length > 2) value = parts.slice(0, -1).join('') + '.' + parts[parts.length - 1];
            }

            const parsed = parseFloat(value);
            return isNaN(parsed) ? 0 : parsed;
        }

        function getCalibrationData() {
            const spans = getCalibrationSpans();
            if (spans.length === 0) return { activeLocalGrid: null, activeEpsg: null };

            let tempGrid = {};
            let tempEpsgCode = null;
            let tempCoordinateSystem = null;
            let foundLocal = false;

            spans.forEach(span => {
                const label = getAttribute(span, 'data-label');
                const text = getNodeText(span);

                if (label === 'Coordinate system') {
                    const textStr = text.trim();
                    tempCoordinateSystem = textStr;
                    const match = textStr.match(/(EPSG:\d+)/i);
                    if (match) tempEpsgCode = match[1].toUpperCase();
                }
                else if (label === 'Projection type') { tempGrid.projType = text.trim(); }
                else if (label === 'Rotation') { tempGrid.rotation = cleanNum(text); foundLocal = true; }
                else if (label === 'Origin easting') { tempGrid.originEasting = cleanNum(text); foundLocal = true; }
                else if (label === 'Origin northing') { tempGrid.originNorthing = cleanNum(text); foundLocal = true; }
                else if (label === 'Origin latitude') { tempGrid.originLat = cleanNum(text); foundLocal = true; }
                else if (label === 'Origin longitude') { tempGrid.originLng = cleanNum(text); foundLocal = true; }
                else if (label === 'Scale factor') { tempGrid.scaleFactor = cleanNum(text); foundLocal = true; }
                else if (label === 'Vertical shift') { tempGrid.verticalShift = cleanNum(text); foundLocal = true; }
            });

            return {
                activeLocalGrid: (foundLocal && !tempEpsgCode) ? tempGrid : null,
                activeEpsg: tempEpsgCode,
                coordinateSystemLabel: tempCoordinateSystem
            };
        }

        function getCacheStats() {
            return {
                generation: cacheGeneration,
                keys: Object.keys(cache)
            };
        }

        return {
            findDeepNode,
            findAllDeepNodes,
            invalidateCache,
            onDomChanged,
            getCacheStats,
            getAnnotationDetail,
            getMeasurementsPanel,
            getDrawingGuides,
            getDrawingGuidesPanel,
            getMeasurementsToolbar,
            isDrawingGuidesHidden,
            getProjectViewerNav,
            getProjectName,
            getPolygonName,
            getTimeline,
            getTimelineDate,
            getPolygonEditor,
            getPolygonCoordinates,
            getAsBuiltLayer,
            getSurveyLayer,
            getDataLayersTab,
            getPointCloudLayerToggles,
            getCalibrationSpans,
            getCalibrationData
        };
    }

    // --- 🌐 GLOBAL NAMESPACE & STATE ---
    window.DashboardExtend = {
        state: {
            cachedTiles: [],
            cachedTileKeys: {},
            totalPointsHarvested: 0,
            globalTransformMatrix: null,
            contentTransformByUrl: {},
            externalTilesetTransformByUrl: {},
            lastTilesetStats: null,
            tilesetStatsHistory: [],
            transformLookupHitSamples: [],
            transformLookupMissSamples: [],
            pointDecodeStats: {
                decodedTiles: 0,
                decodedPoints: 0,
                floatTiles: 0,
                floatPoints: 0,
                quantizedTiles: 0,
                quantizedPoints: 0,
                skippedTiles: 0,
                skippedPoints: 0,
                duplicateTiles: 0,
                duplicatePoints: 0,
                duplicateSamples: [],
                skippedSamples: []
            },
            globalAuthToken: null
        },
        utils: {
            findDeepNode: function(predicate, root = document.body) {
                return window.DashboardExtend.hostDom.findDeepNode(predicate, root);
            },
            findAllDeepNodes: function(predicate, root = document.body) {
                return window.DashboardExtend.hostDom.findAllDeepNodes(predicate, root);
            },
            getCalibrationData: function() {
                return window.DashboardExtend.hostDom.getCalibrationData();
            }
        }
    };
    window.DashboardExtend.hostDom = createHostDomAdapter(document);

    // --- 📡 API & NETWORK INTERCEPTORS ---
    const IDENTITY_MATRIX = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

    function cloneMatrix(matrix) {
        return Array.isArray(matrix) && matrix.length === 16 ? matrix.slice() : IDENTITY_MATRIX.slice();
    }

    function multiplyMatrices(a, b) {
        const out = new Array(16);
        for (let col = 0; col < 4; col++) {
            for (let row = 0; row < 4; row++) {
                out[col * 4 + row] =
                    (a[0 * 4 + row] * b[col * 4 + 0]) +
                    (a[1 * 4 + row] * b[col * 4 + 1]) +
                    (a[2 * 4 + row] * b[col * 4 + 2]) +
                    (a[3 * 4 + row] * b[col * 4 + 3]);
            }
        }
        return out;
    }

    function normalizeResourceUrl(url, baseUrl) {
        try {
            const parsed = new URL(url, baseUrl || window.location.href);
            parsed.hash = "";
            return parsed.href;
        } catch(e) {
            return String(url || "");
        }
    }

    function resourceLookupKeys(url, baseUrl) {
        const href = normalizeResourceUrl(url, baseUrl);
        const keys = [href];

        try {
            const parsed = new URL(href);
            parsed.hash = "";
            parsed.search = "";
            keys.push(parsed.href);
            keys.push(parsed.origin + parsed.pathname);
            keys.push(parsed.pathname);

            try {
                const decodedPath = decodeURIComponent(parsed.pathname);
                keys.push(parsed.origin + decodedPath);
                keys.push(decodedPath);
            } catch(e) {}
        } catch(e) {}

        return Array.from(new Set(keys));
    }

    function canonicalTileKey(url, baseUrl) {
        try {
            const parsed = new URL(normalizeResourceUrl(url, baseUrl));
            parsed.hash = "";
            return parsed.href;
        } catch(e) {
            return String(url || "");
        }
    }

    function rememberTransform(map, url, baseUrl, transform) {
        resourceLookupKeys(url, baseUrl).forEach(key => {
            map[key] = cloneMatrix(transform);
        });
    }

    function findTransformRecord(map, url, baseUrl) {
        const keys = resourceLookupKeys(url, baseUrl);
        for (let i = 0; i < keys.length; i++) {
            if (map[keys[i]]) return { transform: cloneMatrix(map[keys[i]]), matchedKey: keys[i] };
        }
        return null;
    }

    function findTransform(map, url, baseUrl) {
        const record = findTransformRecord(map, url, baseUrl);
        return record ? record.transform : null;
    }

    function shouldInspectTilesetJson(url) {
        const lowerUrl = String(url || '').toLowerCase();
        return lowerUrl.includes('tileset.json') || !!findTransformRecord(window.DashboardExtend.state.externalTilesetTransformByUrl, url);
    }

    function addSample(listName, sample) {
        const list = window.DashboardExtend.state[listName];
        if (!Array.isArray(list)) return;
        if (list.some(item => item.url === sample.url)) return;
        list.push(sample);
        if (list.length > 8) list.shift();
    }

    function getPointDecodeStats() {
        if (!window.DashboardExtend.state.pointDecodeStats) {
            window.DashboardExtend.state.pointDecodeStats = {
                decodedTiles: 0,
                decodedPoints: 0,
                floatTiles: 0,
                floatPoints: 0,
                quantizedTiles: 0,
                quantizedPoints: 0,
                skippedTiles: 0,
                skippedPoints: 0,
                duplicateTiles: 0,
                duplicatePoints: 0,
                duplicateSamples: [],
                skippedSamples: []
            };
        }
        return window.DashboardExtend.state.pointDecodeStats;
    }

    function registerTilesetContentTransforms(tilesetUrl, rootTile, inheritedTransform, stats) {
        if (!rootTile) return;

        const tileTransform = Array.isArray(rootTile.transform) && rootTile.transform.length === 16
            ? multiplyMatrices(inheritedTransform, rootTile.transform)
            : cloneMatrix(inheritedTransform);

        const contents = [];
        if (rootTile.content) contents.push(rootTile.content);
        if (Array.isArray(rootTile.contents)) contents.push(...rootTile.contents);

        contents.forEach(content => {
            const contentUrl = content && (content.uri || content.url);
            if (!contentUrl) return;

            const absoluteUrl = normalizeResourceUrl(contentUrl, tilesetUrl);
            const lowerUrl = absoluteUrl.toLowerCase();

            if (lowerUrl.includes('.pnts')) {
                rememberTransform(window.DashboardExtend.state.contentTransformByUrl, absoluteUrl, tilesetUrl, tileTransform);
                stats.pntsTransforms++;
                if (stats.contentSamples.length < 6) stats.contentSamples.push({ type: 'pnts', url: absoluteUrl });
            } else if (lowerUrl.includes('.json')) {
                rememberTransform(window.DashboardExtend.state.externalTilesetTransformByUrl, absoluteUrl, tilesetUrl, tileTransform);
                stats.externalTilesets++;
                if (stats.contentSamples.length < 6) stats.contentSamples.push({ type: 'json', url: absoluteUrl });
            } else {
                stats.otherContent++;
                if (stats.contentSamples.length < 6) stats.contentSamples.push({ type: 'other', url: absoluteUrl });
            }
        });

        if (Array.isArray(rootTile.children)) {
            rootTile.children.forEach(child => registerTilesetContentTransforms(tilesetUrl, child, tileTransform, stats));
        }
    }

    function interceptTilesetJson(url, bufferOrText) {
        try {
            const data = typeof bufferOrText === 'string' ? JSON.parse(bufferOrText) : JSON.parse(new TextDecoder().decode(bufferOrText));
            if (data && data.root) {
                const tilesetUrl = normalizeResourceUrl(url);
                const inheritedTransform = findTransform(window.DashboardExtend.state.externalTilesetTransformByUrl, tilesetUrl) || IDENTITY_MATRIX;
                const rootTransform = Array.isArray(data.root.transform) && data.root.transform.length === 16
                    ? multiplyMatrices(inheritedTransform, data.root.transform)
                    : cloneMatrix(inheritedTransform);

                window.DashboardExtend.state.globalTransformMatrix = rootTransform;

                const stats = { tilesetUrl, pntsTransforms: 0, externalTilesets: 0, otherContent: 0, contentSamples: [] };
                registerTilesetContentTransforms(tilesetUrl, data.root, inheritedTransform, stats);
                stats.contentTransformMapSize = Object.keys(window.DashboardExtend.state.contentTransformByUrl).length;
                stats.externalTilesetTransformMapSize = Object.keys(window.DashboardExtend.state.externalTilesetTransformByUrl).length;
                window.DashboardExtend.state.lastTilesetStats = stats;

                window.DashboardExtend.state.tilesetStatsHistory.push(stats);
                if (window.DashboardExtend.state.tilesetStatsHistory.length > 12) {
                    window.DashboardExtend.state.tilesetStatsHistory.shift();
                }
            }
        } catch(e) {}
    }

    function parseAndExtractPnts(buffer, url) {
        try {
            const dataView = new DataView(buffer);
            const magic = String.fromCharCode(dataView.getUint8(0), dataView.getUint8(1), dataView.getUint8(2), dataView.getUint8(3));
            if (magic !== 'pnts') return;

            const ftJsonLen = dataView.getUint32(12, true), ftBinLen = dataView.getUint32(16, true);
            const btJsonLen = dataView.getUint32(20, true), btBinLen = dataView.getUint32(24, true);
            const ftJsonOffset = 28, ftBinOffset = ftJsonOffset + ftJsonLen;
            const btJsonOffset = ftBinOffset + ftBinLen, btBinOffset = btJsonOffset + btJsonLen;

            const decoder = new TextDecoder("utf-8");
            const ftJsonStr = decoder.decode(buffer.slice(ftJsonOffset, ftJsonOffset + ftJsonLen)).replace(/\0/g, '').trim();
            const btJsonStr = btJsonLen > 0 ? decoder.decode(buffer.slice(btJsonOffset, btJsonOffset + btJsonLen)).replace(/\0/g, '').trim() : "{}";
            
            const ftJson = JSON.parse(ftJsonStr), btJson = JSON.parse(btJsonStr);
            if (!ftJson.POINTS_LENGTH) return;

            const decodeStats = getPointDecodeStats();
            const normalizedUrl = normalizeResourceUrl(url);
            const tileKey = canonicalTileKey(url);

            if (window.DashboardExtend.state.cachedTileKeys[tileKey]) {
                decodeStats.duplicateTiles++;
                decodeStats.duplicatePoints += ftJson.POINTS_LENGTH;
                if (decodeStats.duplicateSamples.length < 8) {
                    decodeStats.duplicateSamples.push({
                        url: normalizedUrl,
                        tileKey,
                        points: ftJson.POINTS_LENGTH
                    });
                }
                return;
            }

            let positions = null;
            let positionEncoding = null;

            if (ftJson.POSITION) {
                const byteOffset = ftJson.POSITION.byteOffset || 0;
                positions = new Float32Array(buffer.slice(ftBinOffset + byteOffset, ftBinOffset + byteOffset + (ftJson.POINTS_LENGTH * 12)));
                positionEncoding = 'POSITION';
                decodeStats.floatTiles++;
                decodeStats.floatPoints += ftJson.POINTS_LENGTH;
            } else if (ftJson.POSITION_QUANTIZED && Array.isArray(ftJson.QUANTIZED_VOLUME_SCALE) && Array.isArray(ftJson.QUANTIZED_VOLUME_OFFSET)) {
                const byteOffset = ftJson.POSITION_QUANTIZED.byteOffset || 0;
                const quantized = new Uint16Array(buffer.slice(ftBinOffset + byteOffset, ftBinOffset + byteOffset + (ftJson.POINTS_LENGTH * 6)));
                const scale = ftJson.QUANTIZED_VOLUME_SCALE;
                const offset = ftJson.QUANTIZED_VOLUME_OFFSET;
                const divisor = 65535.0;

                positions = new Float32Array(ftJson.POINTS_LENGTH * 3);
                for (let i = 0; i < ftJson.POINTS_LENGTH; i++) {
                    const src = i * 3;
                    positions[src] = offset[0] + ((quantized[src] / divisor) * scale[0]);
                    positions[src + 1] = offset[1] + ((quantized[src + 1] / divisor) * scale[1]);
                    positions[src + 2] = offset[2] + ((quantized[src + 2] / divisor) * scale[2]);
                }

                positionEncoding = 'POSITION_QUANTIZED';
                decodeStats.quantizedTiles++;
                decodeStats.quantizedPoints += ftJson.POINTS_LENGTH;
            }

            let combineSurveys = (btJson.CombineSurveys && btJson.CombineSurveys.componentType === "UNSIGNED_SHORT") ? new Uint16Array(buffer.slice(btBinOffset + (btJson.CombineSurveys.byteOffset || 0), btBinOffset + (btJson.CombineSurveys.byteOffset || 0) + (ftJson.POINTS_LENGTH * 2))) : null;

            if (!positions) {
                decodeStats.skippedTiles++;
                decodeStats.skippedPoints += ftJson.POINTS_LENGTH;
                if (decodeStats.skippedSamples.length < 8) {
                    decodeStats.skippedSamples.push({
                        url: normalizeResourceUrl(url),
                        points: ftJson.POINTS_LENGTH,
                        featureTableKeys: Object.keys(ftJson)
                    });
                }
                return;
            }

            decodeStats.decodedTiles++;
            decodeStats.decodedPoints += ftJson.POINTS_LENGTH;

            const transformRecord = findTransformRecord(window.DashboardExtend.state.contentTransformByUrl, url);

            if (transformRecord) {
                addSample('transformLookupHitSamples', {
                    url: normalizedUrl,
                    matchedKey: transformRecord.matchedKey,
                    points: ftJson.POINTS_LENGTH
                });
            } else {
                addSample('transformLookupMissSamples', {
                    url: normalizedUrl,
                    points: ftJson.POINTS_LENGTH,
                    lookupKeys: resourceLookupKeys(url).slice(0, 5)
                });
            }

            window.DashboardExtend.state.cachedTiles.push({
                url: normalizedUrl,
                tileKey,
                positions: positions, combineSurveys: combineSurveys,
                length: ftJson.POINTS_LENGTH, rtcCenter: ftJson.RTC_CENTER || [0, 0, 0],
                positionEncoding,
                transform: transformRecord ? transformRecord.transform : null,
                transformSource: transformRecord ? 'tileset-content' : 'global-fallback',
                transformMatchedKey: transformRecord ? transformRecord.matchedKey : null
            });
            window.DashboardExtend.state.cachedTileKeys[tileKey] = true;
            window.DashboardExtend.state.totalPointsHarvested += ftJson.POINTS_LENGTH;
        } catch (e) {}
    }

    function getFetchUrl(input) {
        if (typeof input === 'string') return input;
        if (input && typeof input.url === 'string') return input.url;
        return String(input || '');
    }

    function isArrayBuffer(value) {
        return value && Object.prototype.toString.call(value) === '[object ArrayBuffer]';
    }

    function isArrayBufferLike(value) {
        return isArrayBuffer(value) || ArrayBuffer.isView(value);
    }

    function toArrayBuffer(value) {
        if (isArrayBuffer(value)) return value;
        if (ArrayBuffer.isView(value)) {
            return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
        }
        return null;
    }

    function inspectTileResponseBody(url, body, responseType) {
        try {
            const lowerUrl = String(url || '').toLowerCase();
            const shouldInspectTileset = shouldInspectTilesetJson(url);
            const shouldInspectPnts = lowerUrl.includes('.pnts');

            if (!shouldInspectTileset && !shouldInspectPnts) return false;

            if (shouldInspectTileset) {
                if (typeof body === 'string') {
                    interceptTilesetJson(url, body);
                    return true;
                }

                if (isArrayBufferLike(body)) {
                    interceptTilesetJson(url, toArrayBuffer(body));
                    return true;
                }

                if (body && responseType === 'json') {
                    interceptTilesetJson(url, JSON.stringify(body));
                    return true;
                }

                if (body && typeof body.text === 'function') {
                    return body.text()
                        .then(text => {
                            interceptTilesetJson(url, text);
                            return true;
                        })
                        .catch(() => false);
                }

                return false;
            }

            const buffer = toArrayBuffer(body);
            if (buffer) {
                parseAndExtractPnts(buffer, url);
                return true;
            }

            if (body && typeof body.arrayBuffer === 'function') {
                return body.arrayBuffer()
                    .then(buffer => {
                        parseAndExtractPnts(buffer, url);
                        return true;
                    })
                    .catch(() => false);
            }

            return false;
        } catch (e) {
            return false;
        }
    }

    function inspectFetchResponseFromClone(url, response) {
        try {
            const lowerUrl = String(url || '').toLowerCase();
            const shouldInspectTileset = shouldInspectTilesetJson(url);
            const shouldInspectPnts = lowerUrl.includes('.pnts');

            if (!shouldInspectTileset && !shouldInspectPnts) return Promise.resolve(false);
            if (!response || typeof response.clone !== 'function') return Promise.resolve(false);

            const responseClone = response.clone();

            if (shouldInspectTileset) {
                if (typeof responseClone.text !== 'function') return Promise.resolve(false);
                return responseClone.text()
                    .then(text => inspectTileResponseBody(url, text, 'text'))
                    .catch(() => false);
            }

            if (typeof responseClone.arrayBuffer !== 'function') return Promise.resolve(false);
            return responseClone.arrayBuffer()
                .then(buffer => inspectTileResponseBody(url, buffer, 'arraybuffer'))
                .catch(() => false);
        } catch (e) {
            return Promise.resolve(false);
        }
    }

    function getXhrResponseText(xhr) {
        try {
            return xhr.responseText;
        } catch (e) {
            return null;
        }
    }

    function inspectXhrResponse(xhr) {
        try {
            const url = xhr._dashboardExtendUrl || '';
            if (!url || xhr.status < 200 || xhr.status >= 300) return false;

            const responseType = xhr.responseType || '';
            if (xhr.response !== undefined && xhr.response !== null) {
                const result = inspectTileResponseBody(url, xhr.response, responseType);
                if (result) return result;
            }

            const responseText = getXhrResponseText(xhr);
            if (responseText) return inspectTileResponseBody(url, responseText, 'text');

            return false;
        } catch (e) {
            return false;
        }
    }

    window.DashboardExtend.testHooks = window.DashboardExtend.testHooks || {};
    window.DashboardExtend.testHooks.tileCapture = {
        IDENTITY_MATRIX,
        cloneMatrix,
        multiplyMatrices,
        normalizeResourceUrl,
        resourceLookupKeys,
        canonicalTileKey,
        rememberTransform,
        findTransformRecord,
        findTransform,
        shouldInspectTilesetJson,
        registerTilesetContentTransforms,
        interceptTilesetJson,
        parseAndExtractPnts,
        getFetchUrl,
        inspectTileResponseBody,
        inspectFetchResponseFromClone,
        inspectXhrResponse,
        getPointDecodeStats
    };

    const originalFetch = window.fetch;
    window.fetch = function(...args) {
        const url = getFetchUrl(args[0]);
        const options = args[1];

        try {
            let token = null;
            if (options && options.headers) {
                const h = new Headers(options.headers); token = h.get('authorization') || h.get('Authorization');
            } else if (args[0] instanceof Request) { token = args[0].headers.get('authorization') || args[0].headers.get('Authorization'); }
            if (token && token.toLowerCase().startsWith('bearer')) { window.DashboardExtend.state.globalAuthToken = token; }
        } catch(e) {}

        const fetchPromise = originalFetch.apply(this, args);
        fetchPromise.then(response => inspectFetchResponseFromClone(url, response)).catch(() => {});
        return fetchPromise;
    };

    const originalOpen = XMLHttpRequest.prototype.open;
    const originalSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
    const originalSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function(method, url, ...rest) {
        this._dashboardExtendUrl = (url && typeof url === 'string') ? url : '';
        return originalOpen.apply(this, arguments);
    };

    XMLHttpRequest.prototype.setRequestHeader = function(header, value) {
        try {
            if (header && typeof header === 'string' && header.toLowerCase() === 'authorization' && typeof value === 'string' && value.toLowerCase().startsWith('bearer')) {
                window.DashboardExtend.state.globalAuthToken = value;
            }
        } catch (e) {}
        return originalSetRequestHeader.apply(this, arguments);
    };

    XMLHttpRequest.prototype.send = function(...args) {
        if (!this._dashboardExtendListenerAttached) {
            this._dashboardExtendListenerAttached = true;
            this.addEventListener('load', function() {
                inspectXhrResponse(this);
            });
        }

        return originalSend.apply(this, args);
    };
})();
