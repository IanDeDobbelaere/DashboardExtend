(function() {
    // --- 🌐 GLOBAL NAMESPACE & STATE ---
    window.DashboardExtend = {
        state: {
            cachedTiles: [],
            totalPointsHarvested: 0,
            globalTransformMatrix: null,
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

                const cleanNum = (str) => parseFloat(str.replace(/[^\d.-]/g, ''));
                let tempGrid = {};
                let tempEpsgCode = null;
                let foundLocal = false;

                spans.forEach(span => {
                    const label = span.getAttribute('data-label');
                    const text = span.innerText || span.textContent;
                    
                    if (label === 'Coordinate system') { 
                        const textStr = text.trim();
                        const match = textStr.match(/(EPSG:\d+)/i);
                        if (match) tempEpsgCode = match[1].toUpperCase();
                        if (textStr.includes("7953") || textStr.includes("OSTN15")) tempEpsgCode = "EPSG:27700";
                    } 
                    else if (label === 'Rotation') { tempGrid.rotation = cleanNum(text); foundLocal = true; }
                    else if (label === 'Origin easting') { tempGrid.originEasting = cleanNum(text); foundLocal = true; }
                    else if (label === 'Origin northing') { tempGrid.originNorthing = cleanNum(text); foundLocal = true; }
                    else if (label === 'Origin latitude') { tempGrid.originLat = cleanNum(text); foundLocal = true; }
                    else if (label === 'Origin longitude') { tempGrid.originLng = cleanNum(text); foundLocal = true; }
                    else if (label === 'Scale factor') { tempGrid.scaleFactor = cleanNum(text); foundLocal = true; }
                    else if (label === 'Vertical shift') { tempGrid.verticalShift = cleanNum(text); foundLocal = true; }
                });

                return {
                    activeLocalGrid: foundLocal ? tempGrid : null,
                    activeEpsg: foundLocal ? null : tempEpsgCode
                };
            }
        }
    };

    // --- 📡 API & NETWORK INTERCEPTORS ---
    function interceptTilesetJson(url, bufferOrText) {
        try {
            const data = typeof bufferOrText === 'string' ? JSON.parse(bufferOrText) : JSON.parse(new TextDecoder().decode(bufferOrText));
            if (data && data.root && data.root.transform) {
                window.DashboardExtend.state.globalTransformMatrix = data.root.transform;
            }
        } catch(e) {}
    }

    function parseAndExtractPnts(buffer) {
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

            let positions = ftJson.POSITION ? new Float32Array(buffer.slice(ftBinOffset + (ftJson.POSITION.byteOffset || 0), ftBinOffset + (ftJson.POSITION.byteOffset || 0) + (ftJson.POINTS_LENGTH * 12))) : null;
            let combineSurveys = (btJson.CombineSurveys && btJson.CombineSurveys.componentType === "UNSIGNED_SHORT") ? new Uint16Array(buffer.slice(btBinOffset + (btJson.CombineSurveys.byteOffset || 0), btBinOffset + (btJson.CombineSurveys.byteOffset || 0) + (ftJson.POINTS_LENGTH * 2))) : null;

            if (!positions) return;

            window.DashboardExtend.state.cachedTiles.push({
                positions: positions, combineSurveys: combineSurveys,
                length: ftJson.POINTS_LENGTH, rtcCenter: ftJson.RTC_CENTER || [0, 0, 0]
            });
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

        if (url.toLowerCase().includes('tileset.json')) {
            originalFetch(url, args[1]).then(res => res.clone().text()).then(text => interceptTilesetJson(url, text)).catch(()=>{});
        } else if (url.toLowerCase().includes('.pnts')) {
            originalFetch(url, args[1]).then(res => res.arrayBuffer()).then(buffer => parseAndExtractPnts(buffer)).catch(() => {});
        }
        return originalFetch.apply(this, args);
    };

    const originalOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(method, url, ...rest) {
        if (url && typeof url === 'string') {
            if (url.toLowerCase().includes('tileset.json') || url.toLowerCase().includes('.pnts')) window.fetch(url).catch(()=>{});
        }
        return originalOpen.apply(this, arguments);
    };
})();