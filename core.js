(function() {
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
                const queue = [root];
                while (queue.length > 0) {
                    const node = queue.shift();
                    if (predicate(node)) return node;
                    if (node.shadowRoot) queue.push(node.shadowRoot);
                    if (node.children) {
                        for (let i = 0; i < node.children.length; i++) queue.push(node.children[i]);
                    }
                }
                return null;
            },
            findAllDeepNodes: function(predicate, root = document.body) {
                const results = [];
                const queue = [root];
                while (queue.length > 0) {
                    const node = queue.shift();
                    if (predicate(node)) results.push(node);
                    if (node.shadowRoot) queue.push(node.shadowRoot);
                    if (node.children) {
                        for (let i = 0; i < node.children.length; i++) queue.push(node.children[i]);
                    }
                }
                return results;
            },
            getCalibrationData: function() {
                const spans = window.DashboardExtend.utils.findAllDeepNodes(n => n.tagName === 'SPAN' && n.hasAttribute('data-label'));
                if (spans.length === 0) return { activeLocalGrid: null, activeEpsg: null };

                const cleanNum = (str) => {
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
                };
                
                let tempGrid = {};
                let tempEpsgCode = null;
                let tempCoordinateSystem = null;
                let foundLocal = false;

                spans.forEach(span => {
                    const label = span.getAttribute('data-label');
                    const text = span.innerText || span.textContent;
                    
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
                    // Smart Fallback: Only use the Local Grid math if there is NO EPSG code.
                    activeLocalGrid: (foundLocal && !tempEpsgCode) ? tempGrid : null,
                    activeEpsg: tempEpsgCode,
                    coordinateSystemLabel: tempCoordinateSystem
                };
            }
        }
    };

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

    const originalFetch = window.fetch;
    window.fetch = async function(...args) {
        const url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url ? args[0].url : '');
        const options = args[1];

        try {
            let token = null;
            if (options && options.headers) {
                const h = new Headers(options.headers); token = h.get('authorization') || h.get('Authorization');
            } else if (args[0] instanceof Request) { token = args[0].headers.get('authorization') || args[0].headers.get('Authorization'); }
            if (token && token.toLowerCase().startsWith('bearer')) { window.DashboardExtend.state.globalAuthToken = token; }
        } catch(e) {}

        if (shouldInspectTilesetJson(url)) {
            originalFetch(url, args[1]).then(res => res.clone().text()).then(text => interceptTilesetJson(url, text)).catch(()=>{});
        } else if (url.toLowerCase().includes('.pnts')) {
            originalFetch(url, args[1]).then(res => res.arrayBuffer()).then(buffer => parseAndExtractPnts(buffer, url)).catch(() => {});
        }
        return originalFetch.apply(this, args);
    };

    const originalOpen = XMLHttpRequest.prototype.open;
    const originalSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
    const originalSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function(method, url, ...rest) {
        if (url && typeof url === 'string') {
            const lowerUrl = url.toLowerCase();
            if (shouldInspectTilesetJson(url) || lowerUrl.includes('.pnts')) {
                window.fetch(url).catch(() => {});
            }
        }
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
                const url = this._dashboardExtendUrl || '';
                if (!url || this.status < 200 || this.status >= 300) return;

                const lowerUrl = url.toLowerCase();
                const responseType = this.responseType || '';
                const response = this.response;

                try {
                    if (shouldInspectTilesetJson(url)) {
                        if (typeof response === 'string') {
                            interceptTilesetJson(url, response);
                        } else if (response && responseType === 'json') {
                            interceptTilesetJson(url, JSON.stringify(response));
                        } else if (this.responseText) {
                            interceptTilesetJson(url, this.responseText);
                        }
                    } else if (lowerUrl.includes('.pnts')) {
                        if (response instanceof ArrayBuffer) {
                            parseAndExtractPnts(response, url);
                        } else if (response && typeof response.arrayBuffer === 'function') {
                            response.arrayBuffer().then(buffer => parseAndExtractPnts(buffer, url)).catch(() => {});
                        }
                    }
                } catch (e) {}
            });
        }

        return originalSend.apply(this, args);
    };
})();
