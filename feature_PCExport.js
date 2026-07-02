(function() {
    const utils = window.DashboardExtend.utils;
    const state = window.DashboardExtend.state;
    const extensionResourceBase = (() => {
        const scriptSrc = document.currentScript && document.currentScript.src;
        if (!scriptSrc) return "";
        return scriptSrc.slice(0, scriptSrc.lastIndexOf("/") + 1);
    })();

    // --- MAIN THREAD NATIVE POLYGON UN-PROJECTION ---
    async function convertPointsViaNativeAPI(latLngAltArray, targetEpsg, sourceEpsg) {
        if (!state.globalAuthToken) throw new Error("No API Token available");
        let convertedPoints = [];
        const apiUrl = window.location.origin + "/api/v1/convertCoordinates";
        const res = await window.fetch(apiUrl, {
            method: "POST",
            headers: { "content-type": "application/json", "authorization": state.globalAuthToken, "accept": "application/json" },
            body: JSON.stringify({ from: sourceEpsg, to: targetEpsg, coordinates: latLngAltArray })
        });
        if (!res.ok) throw new Error(`API returned ${res.status}`);
        const data = await res.json();
        convertedPoints.push(...data.coordinates);
        return convertedPoints;
    }

    function cleanText(value) {
        return String(value || '').replace(/\s+/g, ' ').trim();
    }

    function getNodeText(node) {
        return cleanText(node && (node.innerText || node.textContent));
    }

    function sanitizeFilenamePart(value, fallback) {
        const cleaned = cleanText(value)
            .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
            .replace(/\.+$/g, '')
            .replace(/_+/g, '_')
            .trim();
        return cleaned || fallback;
    }

    function sanitizeFilenamePartWithHyphens(value, fallback) {
        const cleaned = cleanText(value)
            .replace(/\s+/g, '-')
            .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
            .replace(/\.+$/g, '')
            .replace(/-+/g, '-')
            .replace(/_+/g, '_')
            .trim();
        return cleaned || fallback;
    }

    function getCurrentTimestampForFilename() {
        const now = new Date();
        const pad = value => String(value).padStart(2, '0');
        return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
    }

    function getProjectName() {
        const nav = utils.findDeepNode(n => n.tagName === 'SC-PROJECT-VIEWER-NAV');
        if (nav) {
            const h3 = utils.findDeepNode(n => n.tagName === 'H3', nav);
            if (h3) {
                const spans = utils.findAllDeepNodes(n => n.tagName === 'SPAN', h3);
                if (spans[1] && getNodeText(spans[1])) return getNodeText(spans[1]);
                if (getNodeText(h3)) return getNodeText(h3);
            }
        }

        return document.title || 'Project';
    }

    function getPolygonName() {
        const detail = utils.findDeepNode(n => n.tagName === 'SC-ANNOTATION-DETAIL');
        if (detail) {
            const heading = utils.findDeepNode(n => n.tagName === 'H3', detail);
            if (heading && getNodeText(heading)) return getNodeText(heading);
        }

        return 'Polygon';
    }

    function getTimelineDate() {
        const timeline = utils.findDeepNode(n => n.tagName === 'CESIUM-TIMELINE') ||
            utils.findDeepNode(n => n.tagName === 'SC-TIMELINE');
        if (!timeline) return '';

        const divs = utils.findAllDeepNodes(n => n.tagName === 'DIV', timeline);
        for (let i = 0; i < divs.length; i++) {
            const text = getNodeText(divs[i]);
            if (text && /\d/.test(text) && text.length <= 120) return text;
        }

        return getNodeText(timeline);
    }

    function formatTimelineDateForFilename(value) {
        const text = cleanText(value);
        const monthMap = {
            jan: '01', january: '01',
            feb: '02', february: '02',
            mar: '03', march: '03',
            apr: '04', april: '04',
            may: '05',
            jun: '06', june: '06',
            jul: '07', july: '07',
            aug: '08', august: '08',
            sep: '09', sept: '09', september: '09',
            oct: '10', october: '10',
            nov: '11', november: '11',
            dec: '12', december: '12'
        };

        let match = text.match(/\b(\d{1,2})\s+([A-Za-z]{3,9}),?\s+(\d{4})\b/);
        if (match) {
            const day = match[1].padStart(2, '0');
            const month = monthMap[match[2].toLowerCase()];
            if (month) return `${match[3]}${month}${day}`;
        }

        match = text.match(/\b(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\b/);
        if (match) return `${match[1]}${match[2].padStart(2, '0')}${match[3].padStart(2, '0')}`;

        match = text.match(/\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})\b/);
        if (match) return `${match[3]}${match[2].padStart(2, '0')}${match[1].padStart(2, '0')}`;

        return '';
    }

    function buildExportFilename(extension) {
        const project = sanitizeFilenamePart(getProjectName(), 'Project');
        const polygon = sanitizeFilenamePartWithHyphens(getPolygonName(), 'Polygon');
        const timelineDate = formatTimelineDateForFilename(getTimelineDate());
        const date = sanitizeFilenamePart(timelineDate, getCurrentTimestampForFilename());
        return `${project}_${polygon}_${date}.${extension}`;
    }

    function extractPolygonData(calib) {
        const litComponent = utils.findDeepNode(n => n.tagName === "SC-BASIC-ANNOTATION-EDITOR");
        if (!litComponent || !litComponent._annotationState) throw new Error("Could not locate your polygon.");

        let rawCoords = null;
        const commonNames = ["coordinates", "positions", "polygonBoundary", "points", "vertices", "geometry"];
        for (let i = 0; i < commonNames.length; i++) {
            const value = litComponent._annotationState[commonNames[i]];
            if (Array.isArray(value) && value.length > 2) {
                rawCoords = value; break;
            }
        }
        if (!rawCoords) throw new Error("Could not extract coordinates from polygon.");

        const vertices = rawCoords.map(v => {
            if (Array.isArray(v)) return { source: "array", x: v[0], y: v[1], z: v[2] };
            if (v && v.lng !== undefined && v.lat !== undefined) return { source: "lnglat", lng: v.lng, lat: v.lat };
            if (v && v.east !== undefined && v.north !== undefined) return { source: "projected", east: v.east, north: v.north };
            if (v && v.x !== undefined && v.y !== undefined) return { source: "cartesian", x: v.x, y: v.y, z: v.z };
            return null;
        }).filter(v => v !== null);

        if (vertices.length < 3) throw new Error("Polygon has fewer than three vertices.");

        let mode = "unknown";
        let boundary = [];

        if (vertices.some(v => v.source === "lnglat")) {
            mode = "lnglat";
            boundary = vertices.filter(v => v.source === "lnglat").map(v => [v.lng, v.lat]);
        } else if (vertices.some(v => v.source === "projected")) {
            mode = "projected";
            boundary = vertices.filter(v => v.source === "projected").map(v => [v.east, v.north]);
        } else {
            const first = vertices[0];
            const ecefLike = vertices.every(v => {
                if (!Number.isFinite(v.x) || !Number.isFinite(v.y) || !Number.isFinite(v.z)) return false;
                const radius = Math.sqrt((v.x * v.x) + (v.y * v.y) + (v.z * v.z));
                return radius > 6000000 && radius < 7000000;
            });

            if (ecefLike) {
                mode = "ecef";
            } else if (Math.abs(first.x) > 180 || Math.abs(first.y) > 90) {
                mode = "projected";
            } else {
                mode = "lnglat";
            }
            boundary = vertices.map(v => mode === "ecef" ? [v.x, v.y, v.z] : [v.x, v.y]);
        }

        return { mode, boundary };
    }

   // --- 🚀 BACKGROUND WEB WORKER ENGINE ---
    function runExportWorker(payload, callback, btnEl) {
        const workerCode = `
            let proj4LoadAttempted = false;
            let proj4LoadSource = "none";

            function ensureProj4(extensionResourceBase) {
                if (proj4LoadAttempted) return;
                proj4LoadAttempted = true;

                if (typeof proj4 !== 'undefined') {
                    proj4LoadSource = "preloaded";
                    return;
                }

                const urls = [];
                if (extensionResourceBase) urls.push(extensionResourceBase + "proj4.js");
                urls.push("https://cdnjs.cloudflare.com/ajax/libs/proj4js/2.9.0/proj4.min.js");

                for (let i = 0; i < urls.length; i++) {
                    try {
                        importScripts(urls[i]);
                        if (typeof proj4 !== 'undefined') {
                            proj4LoadSource = urls[i];
                            return;
                        }
                    } catch(e) {}
                }
            }

            self.onmessage = async function(e) {
                let { cachedTiles, polygonBoundary, clipMode, globalTransformMatrix, activeLocalGrid, exportFormat, gridSize, extensionResourceBase } = e.data;
                ensureProj4(extensionResourceBase);
                const rows = []; let clippedCount = 0; let droppedCount = 0;

                if (exportFormat === 'dxf' || exportFormat === 'dxf-mesh') rows.push("0\\nSECTION\\n2\\nENTITIES");

                function applyMatrix(rawX, rawY, rawZ, m) {
                    return {
                        x: (m[0] * rawX) + (m[4] * rawY) + (m[8] * rawZ) + m[12],
                        y: (m[1] * rawX) + (m[5] * rawY) + (m[9] * rawZ) + m[13],
                        z: (m[2] * rawX) + (m[6] * rawY) + (m[10] * rawZ) + m[14]
                    };
                }

                function deg2rad(deg) { return deg * Math.PI / 180.0; }
                const geocentWgs84 = "+proj=geocent +datum=WGS84 +units=m +no_defs";

                function ecefToLngLatAltApprox(x, y, z) {
                    const a = 6378137.0; const e2 = 0.00669437999014;
                    const b = Math.sqrt(a * a * (1 - e2)); const ep2 = (a * a - b * b) / (b * b);
                    const p = Math.sqrt(x * x + y * y); const th = Math.atan2(a * z, b * p);
                    const lon = Math.atan2(y, x);
                    const lat = Math.atan2((z + ep2 * b * Math.pow(Math.sin(th), 3)), (p - e2 * a * Math.pow(Math.cos(th), 3)));
                    const sinLat = Math.sin(lat);
                    const N = a / Math.sqrt(1 - e2 * sinLat * sinLat);
                    const alt = (p / Math.cos(lat)) - N;
                    return { lng: lon * 180 / Math.PI, lat: lat * 180 / Math.PI, alt };
                }

                function ecefToLngLatAltPrecise(x, y, z) {
                    try {
                        const projected = proj4(geocentWgs84, "EPSG:4326", [x, y, z]);
                        return { lng: projected[0], lat: projected[1], alt: projected[2] || 0 };
                    } catch (err) {
                        return ecefToLngLatAltApprox(x, y, z);
                    }
                }

                function lngLatAltToEcef(lng, lat, alt) {
                    const a = 6378137.0; const e2 = 0.00669437999014;
                    const radLat = deg2rad(lat); const radLng = deg2rad(lng);
                    const N = a / Math.sqrt(1 - e2 * Math.sin(radLat) * Math.sin(radLat));
                    return { x: (N + alt) * Math.cos(radLat) * Math.cos(radLng), y: (N + alt) * Math.cos(radLat) * Math.sin(radLng), z: (N * (1 - e2) + alt) * Math.sin(radLat) };
                }

                // --- DYNAMIC PROJECTION ENGINE ---
                let dynamicProjString = null;
                let dynamicProjectionKind = null;
                if (activeLocalGrid && activeLocalGrid.projType) {
                    const pType = activeLocalGrid.projType.toLowerCase();
                    if (pType.includes("sterea") || pType.includes("stereographic")) {
                        dynamicProjectionKind = "sterea";
                        dynamicProjString = \`+proj=sterea +lat_0=\${activeLocalGrid.originLat} +lon_0=\${activeLocalGrid.originLng} +k=\${activeLocalGrid.scaleFactor || 1} +x_0=\${activeLocalGrid.originEasting} +y_0=\${activeLocalGrid.originNorthing} +datum=WGS84 +units=m +no_defs\`;
                    } else if (pType.includes("mercator")) {
                        dynamicProjectionKind = "tmerc";
                        dynamicProjString = \`+proj=tmerc +lat_0=\${activeLocalGrid.originLat} +lon_0=\${activeLocalGrid.originLng} +k=\${activeLocalGrid.scaleFactor || 1} +x_0=\${activeLocalGrid.originEasting} +y_0=\${activeLocalGrid.originNorthing} +datum=WGS84 +units=m +no_defs\`;
                    }
                }

                function projectToLocalSite(lng, lat, settings, rotSign = 1) {
                    let east, north;

                    if (typeof proj4 !== 'undefined' && dynamicProjString) {
                        const projected = proj4("EPSG:4326", dynamicProjString, [lng, lat]);
                        east = projected[0];
                        north = projected[1];
                    } else {
                        const originEcef = lngLatAltToEcef(settings.originLng, settings.originLat, 0);
                        const wgsEcef = lngLatAltToEcef(lng, lat, 0); 
                        const dx = wgsEcef.x - originEcef.x; const dy = wgsEcef.y - originEcef.y; const dz = wgsEcef.z - originEcef.z;
                        const radLat = deg2rad(settings.originLat); const radLng = deg2rad(settings.originLng);
                        const slong = Math.sin(radLng); const clong = Math.cos(radLng);
                        const slat = Math.sin(radLat); const clat = Math.cos(radLat);
                        
                        east = -slong * dx + clong * dy + (settings.originEasting || 0);
                        north = -slat * clong * dx - slat * slong * dy + clat * dz + (settings.originNorthing || 0);
                    }

                    if (settings.rotation) {
                        const dx = east - (settings.originEasting || 0);
                        const dy = north - (settings.originNorthing || 0);
                        const radRot = deg2rad(settings.rotation * rotSign);
                        const cosRot = Math.cos(radRot); const sinRot = Math.sin(radRot);
                        
                        east = (settings.originEasting || 0) + ((dx * cosRot) - (dy * sinRot));
                        north = (settings.originNorthing || 0) + ((dx * sinRot) + (dy * cosRot));
                    }

                    if (typeof proj4 === 'undefined' && settings.scaleFactor) {
                        const dx = east - (settings.originEasting || 0);
                        const dy = north - (settings.originNorthing || 0);
                        east = (settings.originEasting || 0) + (dx * settings.scaleFactor);
                        north = (settings.originNorthing || 0) + (dy * settings.scaleFactor);
                    }

                    return { easting: east, northing: north };
                }

                let selectedRotationSign = null;
                const inputClipMode = clipMode;

                if (clipMode === 'ecef' && activeLocalGrid) {
                    selectedRotationSign = -1;
                    polygonBoundary = polygonBoundary.map(pt => {
                        const wgs = ecefToLngLatAltPrecise(pt[0], pt[1], pt[2] || 0);
                        const local = projectToLocalSite(wgs.lng, wgs.lat, activeLocalGrid, selectedRotationSign);
                        return [local.easting, local.northing];
                    });
                    clipMode = 'projected';
                }

                function isPointInPolygon(point, polygon) {
                    let x = point[0], y = point[1], inside = false;
                    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
                        let xi = polygon[i][0], yi = polygon[i][1], xj = polygon[j][0], yj = polygon[j][1];
                        let intersect = ((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
                        if (intersect) inside = !inside;
                    }
                    return inside;
                }

                let finalPoints = [];
                let minX = Math.min(...polygonBoundary.map(p => p[0])); let maxX = Math.max(...polygonBoundary.map(p => p[0]));
                let minY = Math.min(...polygonBoundary.map(p => p[1])); let maxY = Math.max(...polygonBoundary.map(p => p[1]));
                let processedCount = 0;
                let bboxCandidateCount = 0;
                let projectedRange = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
                let wgsRange = { minLng: Infinity, maxLng: -Infinity, minLat: Infinity, maxLat: -Infinity };
                let transformSourceCounts = {};
                let rotationCandidateStats = {
                    positive: { sign: 1, bboxCandidateCount: 0, insideCount: 0, range: { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity } },
                    negative: { sign: -1, bboxCandidateCount: 0, insideCount: 0, range: { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity } },
                    none: { sign: 0, bboxCandidateCount: 0, insideCount: 0, range: { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity } }
                };

                function expandProjectedRange(x, y) {
                    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
                    projectedRange.minX = Math.min(projectedRange.minX, x);
                    projectedRange.maxX = Math.max(projectedRange.maxX, x);
                    projectedRange.minY = Math.min(projectedRange.minY, y);
                    projectedRange.maxY = Math.max(projectedRange.maxY, y);
                }

                function expandWgsRange(lng, lat) {
                    if (!Number.isFinite(lng) || !Number.isFinite(lat)) return;
                    wgsRange.minLng = Math.min(wgsRange.minLng, lng);
                    wgsRange.maxLng = Math.max(wgsRange.maxLng, lng);
                    wgsRange.minLat = Math.min(wgsRange.minLat, lat);
                    wgsRange.maxLat = Math.max(wgsRange.maxLat, lat);
                }

                function updateRotationCandidate(name, easting, northing) {
                    const stats = rotationCandidateStats[name];
                    if (!stats || !Number.isFinite(easting) || !Number.isFinite(northing)) return;

                    stats.range.minX = Math.min(stats.range.minX, easting);
                    stats.range.maxX = Math.max(stats.range.maxX, easting);
                    stats.range.minY = Math.min(stats.range.minY, northing);
                    stats.range.maxY = Math.max(stats.range.maxY, northing);

                    if (easting >= minX && easting <= maxX && northing >= minY && northing <= maxY) {
                        stats.bboxCandidateCount++;
                        if (isPointInPolygon([easting, northing], polygonBoundary)) stats.insideCount++;
                    }
                }

                for (const tile of cachedTiles) {
                    const tileTransform = tile.transform || globalTransformMatrix;
                    const transformSource = tile.transformSource || (tile.transform ? "tileset-content" : "global-fallback");
                    transformSourceCounts[transformSource] = (transformSourceCounts[transformSource] || 0) + 1;

                    for (let i = 0; i < tile.length; i++) {
                        if (tile.combineSurveys && tile.combineSurveys[i] === 160) { droppedCount++; continue; }
                        
                        const rx = tile.positions[i * 3];
                        const ry = tile.positions[i * 3 + 1];
                        const rz = tile.positions[i * 3 + 2];
                        // Ensures RTC center is applied safely per node to fix microscopic global shifts
                        const trueEcef = applyMatrix(rx + (tile.rtcCenter[0]||0), ry + (tile.rtcCenter[1]||0), rz + (tile.rtcCenter[2]||0), tileTransform);
                        
                        let testX, testY, localPt = null;
                        const wgs = ecefToLngLatAltPrecise(trueEcef.x, trueEcef.y, trueEcef.z);
                        processedCount++;
                        expandWgsRange(wgs.lng, wgs.lat);

                        if (clipMode === 'wgs84') {
                            testX = wgs.lng; testY = wgs.lat;
                        } else if (clipMode === 'projected' && activeLocalGrid) {
                            if (selectedRotationSign === null) {
                                const candidates = [
                                    { name: "positive", sign: 1, point: projectToLocalSite(wgs.lng, wgs.lat, activeLocalGrid, 1) },
                                    { name: "negative", sign: -1, point: projectToLocalSite(wgs.lng, wgs.lat, activeLocalGrid, -1) },
                                    { name: "none", sign: 0, point: projectToLocalSite(wgs.lng, wgs.lat, activeLocalGrid, 0) }
                                ];

                                let chosen = candidates[0];
                                for (let c = 0; c < candidates.length; c++) {
                                    const candidate = candidates[c];
                                    updateRotationCandidate(candidate.name, candidate.point.easting, candidate.point.northing);

                                    if (selectedRotationSign === null && isPointInPolygon([candidate.point.easting, candidate.point.northing], polygonBoundary)) {
                                        selectedRotationSign = candidate.sign;
                                        chosen = candidate;
                                    }
                                }

                                testX = chosen.point.easting;
                                testY = chosen.point.northing;
                            } else {
                                localPt = projectToLocalSite(wgs.lng, wgs.lat, activeLocalGrid, selectedRotationSign);
                                testX = localPt.easting; testY = localPt.northing;
                            }
                        } else {
                            testX = trueEcef.x; testY = trueEcef.y;
                        }

                        expandProjectedRange(testX, testY);
                        if (testX < minX || testX > maxX || testY < minY || testY > maxY) continue;
                        bboxCandidateCount++;

                        if (isPointInPolygon([testX, testY], polygonBoundary)) {
                            // 🔥 THE FIX: We are now pushing LOCAL Easting, Northing, and Z (Vertical Shift Applied) instead of ECEF!
                            let finalZ = wgs.alt + (activeLocalGrid && activeLocalGrid.verticalShift ? activeLocalGrid.verticalShift : 0);
                            let finalX = clipMode === 'projected' ? testX : wgs.lng;
                            let finalY = clipMode === 'projected' ? testY : wgs.lat;
                            
                            finalPoints.push({ x: finalX, y: finalY, z: finalZ });
                            clippedCount++;
                        }
                    }
                }

                if (exportFormat === 'dxf-mesh') {
                    self.postMessage({ status: "⚙️ Generating Grid Mesh..." });
                    const grid = new Map();
                    const gs = gridSize || 1.0;

                    for(let pt of finalPoints) {
                        let gx = Math.floor(pt.x / gs), gy = Math.floor(pt.y / gs);
                        let key = gx + "," + gy;
                        if(!grid.has(key)) grid.set(key, { x: gx*gs + gs/2, y: gy*gs + gs/2, zSum: 0, count: 0 });
                        let cell = grid.get(key);
                        cell.zSum += pt.z; cell.count++;
                    }

                    grid.forEach(cell => cell.z = cell.zSum / cell.count);

                    grid.forEach((cell, key) => {
                        let coords = key.split(",");
                        let gx = parseInt(coords[0]), gy = parseInt(coords[1]);
                        let c1 = cell, c2 = grid.get((gx+1) + "," + gy), c3 = grid.get((gx+1) + "," + (gy+1)), c4 = grid.get(gx + "," + (gy+1));

                        if(c2 && c3 && c4) {
                            rows.push(\`0\\n3DFACE\\n8\\nAutoHarvestedMesh\\n10\\n\${c1.x.toFixed(4)}\\n20\\n\${c1.y.toFixed(4)}\\n30\\n\${c1.z.toFixed(4)}\\n11\\n\${c2.x.toFixed(4)}\\n21\\n\${c2.y.toFixed(4)}\\n31\\n\${c2.z.toFixed(4)}\\n12\\n\${c3.x.toFixed(4)}\\n22\\n\${c3.y.toFixed(4)}\\n32\\n\${c3.z.toFixed(4)}\\n13\\n\${c4.x.toFixed(4)}\\n23\\n\${c4.y.toFixed(4)}\\n33\\n\${c4.z.toFixed(4)}\`);
                        }
                    });
                } else {
                    for (let pt of finalPoints) {
                        if (exportFormat === 'dxf') {
                            rows.push(\`0\\nPOINT\\n8\\nAutoHarvestedPoints\\n10\\n\${pt.x.toFixed(6)}\\n20\\n\${pt.y.toFixed(6)}\\n30\\n\${pt.z.toFixed(4)}\`);
                        } else {
                            rows.push(\`\${pt.x.toFixed(6)},\${pt.y.toFixed(6)},\${pt.z.toFixed(4)}\`);
                        }
                    }
                }

                if (exportFormat === 'dxf' || exportFormat === 'dxf-mesh') rows.push("0\\nENDSEC\\n0\\nEOF");

                self.postMessage({
                    rows: rows.join("\\n"),
                    clippedCount,
                    droppedCount,
                    exportFormat,
                    diagnostics: {
                        proj4Available: typeof proj4 !== 'undefined',
                        proj4LoadSource,
                        dynamicProjectionKind,
                        dynamicProjString,
                        inputClipMode,
                        effectiveClipMode: clipMode,
                        rotationApplied: !!(activeLocalGrid && activeLocalGrid.rotation),
                        lockedRotationSign: selectedRotationSign,
                        polygonRange: { minX, maxX, minY, maxY },
                        projectedRange,
                        wgsRange,
                        processedCount,
                        bboxCandidateCount,
                        transformSourceCounts,
                        rotationCandidateStats
                    }
                });
            };
        `;

        const blob = new Blob([workerCode], { type: 'application/javascript' });
        const worker = new Worker(URL.createObjectURL(blob));
        
        worker.onmessage = function(e) {
            if (e.data.status) { if (btnEl) btnEl.innerText = e.data.status; } 
            else { callback(e.data); worker.terminate(); }
        };
        worker.postMessage(payload);
    }

    async function executeDownload(btnEl, exportFormat, gridSize = 1.0) {
        const calib = utils.getCalibrationData();
        if (!state.globalTransformMatrix) return alert("Missing Global Matrix! Pan or zoom map slightly to capture the tileset.");
        
        let polygonData;
        try { polygonData = extractPolygonData(calib); } catch (error) { return alert(error.message); }

        let polygonBoundary = polygonData.boundary;
        let clipMode = polygonData.mode === "lnglat" ? "wgs84" : polygonData.mode;

        const originalText = btnEl.innerText;
        btnEl.disabled = true;

        if (calib.activeEpsg && polygonData.mode === "projected") {
            btnEl.innerText = "⏳ Un-Projecting Polygon Boundary...";
            if (!state.globalAuthToken) {
                btnEl.disabled = false; btnEl.innerText = originalText;
                return alert("Missing API Token! Please pan the map or click a layer to capture it.");
            }
            try {
                let apiPayload = polygonBoundary.map(pt => [pt[0], pt[1], 0]);
                let reversed = await convertPointsViaNativeAPI(apiPayload, "EPSG:4326", calib.activeEpsg);
                
                const firstX = reversed[0][0];
                if (Math.abs(firstX) <= 90 && Math.abs(reversed[0][1]) > 90) {
                     polygonBoundary = reversed.map(pt => [pt[1], pt[0]]);
                } else {
                     polygonBoundary = reversed.map(pt => [pt[0], pt[1]]);
                }
                clipMode = "wgs84";
            } catch (e) {
                console.error(e); btnEl.disabled = false; btnEl.innerText = originalText; return alert("Failed to un-project polygon using API.");
            }
        }

        const preloadedTileCount = state.cachedTiles.length;
        const preloadedPointCount = state.cachedTiles.reduce((sum, tile) => sum + (tile.length || 0), 0);
        state.totalPointsHarvested = preloadedPointCount;
        state.transformLookupHitSamples = [];
        state.transformLookupMissSamples = [];
        state.pointDecodeStats = {
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
        btnEl.innerText = "⏳ Auto-Reloading Data Layers...";
        
        setTimeout(() => {
            const svgPath = utils.findDeepNode(n => n.tagName === 'PATH' && n.getAttribute('d') && n.getAttribute('d').startsWith('M264.5'));
            let tabBtn = svgPath;
            while (tabBtn && tabBtn.tagName !== 'SC-TAB') { tabBtn = tabBtn.parentNode || (tabBtn.getRootNode && tabBtn.getRootNode().host); }
            if (tabBtn) tabBtn.click();

            setTimeout(() => {
                const asBuiltLayer = utils.findDeepNode(n => n.tagName === 'SC-AS-BUILT-LAYER');
                const surveyLayer = utils.findDeepNode(n => n.tagName === 'SC-SURVEY-LAYER');
                let togglesToClick = [];
                
                if (asBuiltLayer) {
                    const btn = utils.findDeepNode(n => n.tagName === 'BUTTON', utils.findDeepNode(n => n.tagName === 'SC-SHOW-TOGGLE', asBuiltLayer));
                    if (btn) togglesToClick.push(btn);
                }
                if (surveyLayer) {
                    const btn = utils.findDeepNode(n => n.tagName === 'BUTTON', utils.findDeepNode(n => n.tagName === 'SC-SHOW-TOGGLE', surveyLayer));
                    if (btn) togglesToClick.push(btn);
                }
                
                if (togglesToClick.length > 0) {
                    togglesToClick.forEach(btn => btn.click());
                    
                    setTimeout(() => {
                        togglesToClick.forEach(btn => btn.click());
                        btnEl.innerText = "⏳ Listening for Data...";
                        const pollIntervalMs = 500;
                        const minListenTicks = 24; // 12s minimum capture time for progressive LOD tiles.
                        const stableTicksRequired = 16; // 8s quiet period before export.
                        const maxListenTicks = 180; // 90s cap.
                        let lastCount = -1, silenceTicks = 0, elapsedTicks = 0;
                        let captureTiming = {
                            pollIntervalMs,
                            minListenSeconds: (minListenTicks * pollIntervalMs) / 1000,
                            stableSecondsRequired: (stableTicksRequired * pollIntervalMs) / 1000,
                            maxListenSeconds: (maxListenTicks * pollIntervalMs) / 1000,
                            elapsedListenSeconds: 0,
                            stableSeconds: 0
                        };
                        
                        const finishCapture = () => {
                            clearInterval(silencePoller);
                            btnEl.innerText = "⚙️ Crunching Math (Background)...";

                            runExportWorker({
                                cachedTiles: state.cachedTiles, polygonBoundary, clipMode,
                                globalTransformMatrix: state.globalTransformMatrix, activeLocalGrid: calib.activeLocalGrid,
                                exportFormat, gridSize, extensionResourceBase
                            }, (result) => {
                                if (result.diagnostics) {
                                    const diagnosticReport = {
                                        calibration: calib,
                                        polygonMode: polygonData.mode,
                                        clipMode,
                                        preloadedTileCount,
                                        preloadedPointCount,
                                        totalPointsHarvested: state.totalPointsHarvested,
                                        captureTiming,
                                        pointDecodeStats: state.pointDecodeStats,
                                        tilesetStats: state.lastTilesetStats,
                                        tilesetStatsHistory: state.tilesetStatsHistory,
                                        transformLookupHitSamples: state.transformLookupHitSamples,
                                        transformLookupMissSamples: state.transformLookupMissSamples,
                                        contentTransformMapSize: Object.keys(state.contentTransformByUrl || {}).length,
                                        externalTilesetTransformMapSize: Object.keys(state.externalTilesetTransformByUrl || {}).length,
                                        worker: result.diagnostics
                                    };
                                    console.log("Dashboard Extend PC export diagnostics:", diagnosticReport);
                                    console.log("Dashboard Extend PC export diagnostics JSON:\\n" + JSON.stringify(diagnosticReport, null, 2));
                                }

                                if (result.clippedCount === 0) {
                                    alert("0 points found inside your polygon. If the polygon is tight, try drawing a slightly larger one.");
                                } else {
                                    const extension = result.exportFormat === 'csv' ? 'csv' : 'dxf';
                                    const mimeType = result.exportFormat === 'csv' ? 'text/csv;charset=utf-8;' : 'application/dxf';
                                    const blob = new Blob([result.rows], { type: mimeType });
                                    const url = URL.createObjectURL(blob);
                                    const link = document.createElement("a"); link.href = url; link.download = buildExportFilename(extension); link.click(); URL.revokeObjectURL(url);

                                    console.log(`✅ Kept Local Coordinate Points: ${result.clippedCount} | 🗑️ Dropped: ${result.droppedCount}`);
                                }

                                state.totalPointsHarvested = state.cachedTiles.reduce((sum, tile) => sum + (tile.length || 0), 0);
                                btnEl.innerText = originalText; btnEl.disabled = false;
                            }, btnEl);
                        };

                        const silencePoller = setInterval(() => {
                            elapsedTicks++;
                            captureTiming.elapsedListenSeconds = (elapsedTicks * pollIntervalMs) / 1000;

                            if (state.totalPointsHarvested > 0 && state.totalPointsHarvested === lastCount) {
                                silenceTicks++;
                                captureTiming.stableSeconds = (silenceTicks * pollIntervalMs) / 1000;
                            } else {
                                lastCount = state.totalPointsHarvested; silenceTicks = 0; captureTiming.stableSeconds = 0;
                            }

                            const hasPoints = state.totalPointsHarvested > 0;
                            const quietEnough = elapsedTicks >= minListenTicks && silenceTicks >= stableTicksRequired;
                            const reachedMaxWait = elapsedTicks >= maxListenTicks;

                            if (hasPoints && (quietEnough || reachedMaxWait)) {
                                finishCapture();
                            } else if (!hasPoints && reachedMaxWait) {
                                clearInterval(silencePoller); btnEl.innerText = originalText; btnEl.disabled = false;
                                alert("Timeout: No data intercepted!");
                            }
                        }, pollIntervalMs);

                    }, 500);
                } else { btnEl.innerText = originalText; btnEl.disabled = false; }
            }, 1000); 
        }, 500);
    }

    window.DashboardExtend.UI.registerButton('sc-dashboardextend-csv-btn', 'Export Localized Selected Pointcloud (.csv)', (btnEl) => executeDownload(btnEl, 'csv'));
    window.DashboardExtend.UI.registerButton('sc-dashboardextend-dxf-btn', 'Export Localized Selected Pointcloud (.dxf)', (btnEl) => {
        let size = prompt("Enter grid size for mesh decimation (e.g., 1.0 for 1m/1ft cells):", "1.0");
        if (!size || isNaN(parseFloat(size))) return;
        executeDownload(btnEl, 'dxf-mesh', parseFloat(size));
    });
})();
