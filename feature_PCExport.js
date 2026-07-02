(function() {
    const hostDom = window.DashboardExtend.hostDom;
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
        return hostDom.getProjectName();
    }

    function getPolygonName() {
        return hostDom.getPolygonName();
    }

    function getTimelineDate() {
        return hostDom.getTimelineDate();
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
        const litComponent = hostDom.getPolygonEditor();
        if (!litComponent || !litComponent._annotationState) throw new Error("Could not locate your polygon.");

        const rawCoords = hostDom.getPolygonCoordinates();
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
    function createExportWorkerCode() {
        return `
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

                function createPointWriter(format) {
                    if (format === 'dxf') {
                        return {
                            writePoint(x, y, z) {
                                rows.push(\`0\\nPOINT\\n8\\nAutoHarvestedPoints\\n10\\n\${x.toFixed(6)}\\n20\\n\${y.toFixed(6)}\\n30\\n\${z.toFixed(4)}\`);
                            }
                        };
                    }

                    return {
                        writePoint(x, y, z) {
                            rows.push(\`\${x.toFixed(6)},\${y.toFixed(6)},\${z.toFixed(4)}\`);
                        }
                    };
                }

                function createMeshWriter(rawGridSize) {
                    const grid = new Map();
                    const gs = rawGridSize || 1.0;

                    function getKey(gx, gy) {
                        return gx + "," + gy;
                    }

                    function getOrCreateCell(gx, gy) {
                        const key = getKey(gx, gy);
                        let cell = grid.get(key);
                        if (!cell) {
                            cell = { gx, gy, x: gx * gs + gs / 2, y: gy * gs + gs / 2, zSum: 0, count: 0 };
                            grid.set(key, cell);
                        }
                        return cell;
                    }

                    return {
                        writePoint(x, y, z) {
                            const gx = Math.floor(x / gs);
                            const gy = Math.floor(y / gs);
                            const cell = getOrCreateCell(gx, gy);
                            cell.zSum += z;
                            cell.count++;
                        },
                        flush() {
                            let faceCount = 0;

                            grid.forEach(cell => {
                                cell.z = cell.zSum / cell.count;
                            });

                            grid.forEach(cell => {
                                const c1 = cell;
                                const c2 = grid.get(getKey(cell.gx + 1, cell.gy));
                                const c3 = grid.get(getKey(cell.gx + 1, cell.gy + 1));
                                const c4 = grid.get(getKey(cell.gx, cell.gy + 1));

                                if (c2 && c3 && c4) {
                                    rows.push(\`0\\n3DFACE\\n8\\nAutoHarvestedMesh\\n10\\n\${c1.x.toFixed(4)}\\n20\\n\${c1.y.toFixed(4)}\\n30\\n\${c1.z.toFixed(4)}\\n11\\n\${c2.x.toFixed(4)}\\n21\\n\${c2.y.toFixed(4)}\\n31\\n\${c2.z.toFixed(4)}\\n12\\n\${c3.x.toFixed(4)}\\n22\\n\${c3.y.toFixed(4)}\\n32\\n\${c3.z.toFixed(4)}\\n13\\n\${c4.x.toFixed(4)}\\n23\\n\${c4.y.toFixed(4)}\\n33\\n\${c4.z.toFixed(4)}\`);
                                    faceCount++;
                                }
                            });

                            return { cellCount: grid.size, faceCount };
                        }
                    };
                }

                const meshWriter = exportFormat === 'dxf-mesh' ? createMeshWriter(gridSize) : null;
                const pointWriter = meshWriter || createPointWriter(exportFormat);

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

                function prepareRotation(rotation, sign) {
                    const radRot = deg2rad(rotation * sign);
                    return { sign, cos: Math.cos(radRot), sin: Math.sin(radRot) };
                }

                function prepareLocalGridContext(settings) {
                    if (!settings) return null;

                    if (settings.projType) {
                        const pType = settings.projType.toLowerCase();
                        if (pType.includes("sterea") || pType.includes("stereographic")) {
                            dynamicProjectionKind = "sterea";
                            dynamicProjString = "+proj=sterea +lat_0=" + settings.originLat + " +lon_0=" + settings.originLng + " +k=" + (settings.scaleFactor || 1) + " +x_0=" + settings.originEasting + " +y_0=" + settings.originNorthing + " +datum=WGS84 +units=m +no_defs";
                        } else if (pType.includes("mercator")) {
                            dynamicProjectionKind = "tmerc";
                            dynamicProjString = "+proj=tmerc +lat_0=" + settings.originLat + " +lon_0=" + settings.originLng + " +k=" + (settings.scaleFactor || 1) + " +x_0=" + settings.originEasting + " +y_0=" + settings.originNorthing + " +datum=WGS84 +units=m +no_defs";
                        }
                    }

                    const radLat = deg2rad(settings.originLat);
                    const radLng = deg2rad(settings.originLng);
                    const rotation = settings.rotation || 0;
                    const usesProj4Projection = typeof proj4 !== 'undefined' && !!dynamicProjString;

                    return {
                        originEasting: settings.originEasting || 0,
                        originNorthing: settings.originNorthing || 0,
                        originEcef: usesProj4Projection ? null : lngLatAltToEcef(settings.originLng, settings.originLat, 0),
                        slong: Math.sin(radLng),
                        clong: Math.cos(radLng),
                        slat: Math.sin(radLat),
                        clat: Math.cos(radLat),
                        scaleFactor: settings.scaleFactor,
                        applyFallbackScale: typeof proj4 === 'undefined' && settings.scaleFactor,
                        hasRotation: !!settings.rotation,
                        usesProj4Projection,
                        rotationsBySign: {
                            "1": prepareRotation(rotation, 1),
                            "-1": prepareRotation(rotation, -1),
                            "0": prepareRotation(rotation, 0)
                        }
                    };
                }

                const localGridContext = prepareLocalGridContext(activeLocalGrid);
                const rotationCandidateConfigs = [
                    { name: "positive", sign: 1 },
                    { name: "negative", sign: -1 },
                    { name: "none", sign: 0 }
                ];

                function projectToLocalSite(lng, lat, context, rotSign = 1) {
                    let east, north;

                    if (context.usesProj4Projection) {
                        const projected = proj4("EPSG:4326", dynamicProjString, [lng, lat]);
                        east = projected[0];
                        north = projected[1];
                    } else {
                        const wgsEcef = lngLatAltToEcef(lng, lat, 0); 
                        const dx = wgsEcef.x - context.originEcef.x; const dy = wgsEcef.y - context.originEcef.y; const dz = wgsEcef.z - context.originEcef.z;
                        
                        east = -context.slong * dx + context.clong * dy + context.originEasting;
                        north = -context.slat * context.clong * dx - context.slat * context.slong * dy + context.clat * dz + context.originNorthing;
                    }

                    if (context.hasRotation) {
                        const dx = east - context.originEasting;
                        const dy = north - context.originNorthing;
                        const rotation = context.rotationsBySign[String(rotSign)];
                        
                        east = context.originEasting + ((dx * rotation.cos) - (dy * rotation.sin));
                        north = context.originNorthing + ((dx * rotation.sin) + (dy * rotation.cos));
                    }

                    if (context.applyFallbackScale) {
                        const dx = east - context.originEasting;
                        const dy = north - context.originNorthing;
                        east = context.originEasting + (dx * context.scaleFactor);
                        north = context.originNorthing + (dy * context.scaleFactor);
                    }

                    return { easting: east, northing: north };
                }

                let selectedRotationSign = null;
                const inputClipMode = clipMode;

                if (clipMode === 'ecef' && localGridContext) {
                    selectedRotationSign = -1;
                    polygonBoundary = polygonBoundary.map(pt => {
                        const wgs = ecefToLngLatAltPrecise(pt[0], pt[1], pt[2] || 0);
                        const local = projectToLocalSite(wgs.lng, wgs.lat, localGridContext, selectedRotationSign);
                        return [local.easting, local.northing];
                    });
                    clipMode = 'projected';
                }

                function preparePolygon(polygon) {
                    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
                    const edges = [];

                    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
                        const xi = polygon[i][0], yi = polygon[i][1], xj = polygon[j][0], yj = polygon[j][1];
                        minX = Math.min(minX, xi);
                        maxX = Math.max(maxX, xi);
                        minY = Math.min(minY, yi);
                        maxY = Math.max(maxY, yi);
                        edges.push({ xi, yi, xj, yj, deltaX: xj - xi, deltaY: yj - yi });
                    }

                    return { minX, maxX, minY, maxY, edges };
                }

                function isWithinPreparedBounds(x, y, preparedPolygon) {
                    return x >= preparedPolygon.minX && x <= preparedPolygon.maxX && y >= preparedPolygon.minY && y <= preparedPolygon.maxY;
                }

                function isPointInPreparedPolygon(x, y, preparedPolygon) {
                    let inside = false;
                    const edges = preparedPolygon.edges;
                    for (let i = 0; i < edges.length; i++) {
                        const edge = edges[i];
                        const intersect = ((edge.yi > y) !== (edge.yj > y)) && (x < edge.deltaX * (y - edge.yi) / edge.deltaY + edge.xi);
                        if (intersect) inside = !inside;
                    }
                    return inside;
                }

                const preparedPolygon = preparePolygon(polygonBoundary);

                let minX = preparedPolygon.minX; let maxX = preparedPolygon.maxX;
                let minY = preparedPolygon.minY; let maxY = preparedPolygon.maxY;
                let processedCount = 0;
                let bboxCandidateCount = 0;
                let meshStats = null;
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
                    if (!stats || !Number.isFinite(easting) || !Number.isFinite(northing)) return false;

                    stats.range.minX = Math.min(stats.range.minX, easting);
                    stats.range.maxX = Math.max(stats.range.maxX, easting);
                    stats.range.minY = Math.min(stats.range.minY, northing);
                    stats.range.maxY = Math.max(stats.range.maxY, northing);

                    if (isWithinPreparedBounds(easting, northing, preparedPolygon)) {
                        stats.bboxCandidateCount++;
                        const inside = isPointInPreparedPolygon(easting, northing, preparedPolygon);
                        if (inside) stats.insideCount++;
                        return inside;
                    }

                    return false;
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
                        } else if (clipMode === 'projected' && localGridContext) {
                            if (selectedRotationSign === null) {
                                let chosenPoint = null;
                                for (let c = 0; c < rotationCandidateConfigs.length; c++) {
                                    const candidate = rotationCandidateConfigs[c];
                                    const candidatePoint = projectToLocalSite(wgs.lng, wgs.lat, localGridContext, candidate.sign);
                                    if (c === 0) chosenPoint = candidatePoint;

                                    const inside = updateRotationCandidate(candidate.name, candidatePoint.easting, candidatePoint.northing);
                                    if (selectedRotationSign === null && inside) {
                                        selectedRotationSign = candidate.sign;
                                        chosenPoint = candidatePoint;
                                    }
                                }

                                testX = chosenPoint.easting;
                                testY = chosenPoint.northing;
                            } else {
                                localPt = projectToLocalSite(wgs.lng, wgs.lat, localGridContext, selectedRotationSign);
                                testX = localPt.easting; testY = localPt.northing;
                            }
                        } else {
                            testX = trueEcef.x; testY = trueEcef.y;
                        }

                        expandProjectedRange(testX, testY);
                        if (!isWithinPreparedBounds(testX, testY, preparedPolygon)) continue;
                        bboxCandidateCount++;

                        if (isPointInPreparedPolygon(testX, testY, preparedPolygon)) {
                            // 🔥 THE FIX: We are now pushing LOCAL Easting, Northing, and Z (Vertical Shift Applied) instead of ECEF!
                            let finalZ = wgs.alt + (activeLocalGrid && activeLocalGrid.verticalShift ? activeLocalGrid.verticalShift : 0);
                            let finalX = clipMode === 'projected' ? testX : wgs.lng;
                            let finalY = clipMode === 'projected' ? testY : wgs.lat;
                            
                            pointWriter.writePoint(finalX, finalY, finalZ);
                            clippedCount++;
                        }
                    }
                }

                if (meshWriter) {
                    self.postMessage({ status: "⚙️ Generating Grid Mesh..." });
                    meshStats = meshWriter.flush();
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
                        clippedCount,
                        droppedCount,
                        rotationApplied: !!(activeLocalGrid && activeLocalGrid.rotation),
                        lockedRotationSign: selectedRotationSign,
                        polygonRange: { minX, maxX, minY, maxY },
                        projectedRange,
                        wgsRange,
                        processedCount,
                        bboxCandidateCount,
                        transformSourceCounts,
                        rotationCandidateStats,
                        meshStats
                    }
                });
            };
        `;
    }

    function runExportWorker(payload, callback, btnEl) {
        const workerCode = createExportWorkerCode();

        const blob = new Blob([workerCode], { type: 'application/javascript' });
        const worker = new Worker(URL.createObjectURL(blob));
        
        worker.onmessage = function(e) {
            if (e.data.status) { if (btnEl) btnEl.innerText = e.data.status; } 
            else { callback(e.data); worker.terminate(); }
        };
        worker.postMessage(payload);
    }

    function createPointDecodeStats() {
        return {
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

    function resetPointCaptureDiagnostics() {
        state.transformLookupHitSamples = [];
        state.transformLookupMissSamples = [];
        state.pointDecodeStats = createPointDecodeStats();
    }

    function countMapEntries(map) {
        return map ? Object.keys(map).length : 0;
    }

    function getTileCaptureProgress(captureState) {
        const sourceState = captureState || state;
        const decodeStats = sourceState.pointDecodeStats || {};
        const cachedTiles = sourceState.cachedTiles || [];
        const pointCount = Number.isFinite(sourceState.totalPointsHarvested)
            ? sourceState.totalPointsHarvested
            : cachedTiles.reduce((sum, tile) => sum + (tile.length || 0), 0);
        const tilesetHistory = sourceState.tilesetStatsHistory || [];
        const latestTilesetStats = sourceState.lastTilesetStats || {};
        const progressParts = [
            pointCount,
            cachedTiles.length,
            decodeStats.decodedTiles || 0,
            decodeStats.decodedPoints || 0,
            decodeStats.duplicateTiles || 0,
            decodeStats.duplicatePoints || 0,
            decodeStats.skippedTiles || 0,
            decodeStats.skippedPoints || 0,
            decodeStats.floatTiles || 0,
            decodeStats.quantizedTiles || 0,
            countMapEntries(sourceState.contentTransformByUrl),
            countMapEntries(sourceState.externalTilesetTransformByUrl),
            tilesetHistory.length,
            latestTilesetStats.pntsTransforms || 0,
            latestTilesetStats.externalTilesets || 0
        ];

        return {
            pointCount,
            tileCount: cachedTiles.length,
            decodedTiles: decodeStats.decodedTiles || 0,
            decodedPoints: decodeStats.decodedPoints || 0,
            duplicateTiles: decodeStats.duplicateTiles || 0,
            duplicatePoints: decodeStats.duplicatePoints || 0,
            skippedTiles: decodeStats.skippedTiles || 0,
            skippedPoints: decodeStats.skippedPoints || 0,
            tilesetCount: tilesetHistory.length,
            signature: progressParts.join('|'),
            hasPoints: pointCount > 0
        };
    }

    function cloneCaptureTiming(captureTiming) {
        return {
            pollIntervalMs: captureTiming.pollIntervalMs,
            minListenSeconds: captureTiming.minListenSeconds,
            stableSecondsRequired: captureTiming.stableSecondsRequired,
            stableThresholdSeconds: captureTiming.stableThresholdSeconds,
            maxListenSeconds: captureTiming.maxListenSeconds,
            elapsedListenSeconds: captureTiming.elapsedListenSeconds,
            stableSeconds: captureTiming.stableSeconds,
            finishReason: captureTiming.finishReason,
            timedOut: captureTiming.timedOut,
            latestProgress: captureTiming.latestProgress ? { ...captureTiming.latestProgress } : null
        };
    }

    function createCaptureSession(options) {
        const sessionHostDom = options.hostDom || hostDom;
        const sessionState = options.state || state;
        const btnEl = options.btnEl || null;
        const originalText = options.originalText || (btnEl ? btnEl.innerText : '');
        const setTimeoutFn = options.setTimeoutFn || setTimeout;
        const clearTimeoutFn = options.clearTimeoutFn || clearTimeout;
        const setIntervalFn = options.setIntervalFn || setInterval;
        const clearIntervalFn = options.clearIntervalFn || clearInterval;
        const pollIntervalMs = options.pollIntervalMs === undefined ? 500 : options.pollIntervalMs;
        const minListenMs = options.minListenMs === undefined ? 12000 : options.minListenMs;
        const stableThresholdMs = options.stableThresholdMs === undefined ? 8000 : options.stableThresholdMs;
        const maxListenMs = options.maxListenMs === undefined ? 90000 : options.maxListenMs;
        const minListenTicks = Math.ceil(minListenMs / pollIntervalMs);
        const stableTicksRequired = Math.ceil(stableThresholdMs / pollIntervalMs);
        const maxListenTicks = Math.ceil(maxListenMs / pollIntervalMs);
        const layerDiscoveryDelayMs = options.layerDiscoveryDelayMs === undefined ? 500 : options.layerDiscoveryDelayMs;
        const layerRefreshDelayMs = options.layerRefreshDelayMs === undefined ? 500 : options.layerRefreshDelayMs;
        const alertFn = options.alertFn || alert;
        const onCaptureReady = options.onCaptureReady || function() {};
        const onTimeout = options.onTimeout || function() {};
        const onNoLayerToggles = options.onNoLayerToggles || function() {};
        const getProgress = options.getProgress || (() => getTileCaptureProgress(sessionState));

        let layerDiscoveryTimer = null;
        let layerRestoreTimer = null;
        let progressPoller = null;
        let elapsedTicks = 0;
        let stableTicks = 0;
        let lastProgressSignature = null;
        let started = false;
        let stopped = false;
        const captureTiming = {
            pollIntervalMs,
            minListenSeconds: (minListenTicks * pollIntervalMs) / 1000,
            stableSecondsRequired: (stableTicksRequired * pollIntervalMs) / 1000,
            stableThresholdSeconds: (stableTicksRequired * pollIntervalMs) / 1000,
            maxListenSeconds: (maxListenTicks * pollIntervalMs) / 1000,
            elapsedListenSeconds: 0,
            stableSeconds: 0,
            finishReason: null,
            timedOut: false,
            latestProgress: null
        };

        function setStatus(text) {
            if (btnEl) btnEl.innerText = text;
            if (typeof options.onStatus === 'function') options.onStatus(text);
        }

        function resetButton() {
            if (!btnEl) return;
            btnEl.innerText = originalText;
            btnEl.disabled = false;
        }

        function safeClick(element) {
            try {
                if (element && typeof element.click === 'function') element.click();
            } catch (e) {}
        }

        function clearTimers() {
            if (layerDiscoveryTimer !== null) {
                clearTimeoutFn(layerDiscoveryTimer);
                layerDiscoveryTimer = null;
            }
            if (layerRestoreTimer !== null) {
                clearTimeoutFn(layerRestoreTimer);
                layerRestoreTimer = null;
            }
            if (progressPoller !== null) {
                clearIntervalFn(progressPoller);
                progressPoller = null;
            }
        }

        function stop() {
            stopped = true;
            clearTimers();
        }

        function finishCapture(reason) {
            if (stopped) return;
            captureTiming.finishReason = reason;
            stop();
            setStatus("⚙️ Crunching Math (Background)...");
            onCaptureReady(cloneCaptureTiming(captureTiming));
        }

        function timeoutCapture() {
            if (stopped) return;
            captureTiming.timedOut = true;
            captureTiming.finishReason = "no-data-timeout";
            stop();
            resetButton();
            onTimeout(cloneCaptureTiming(captureTiming));
            alertFn("Timeout: No data intercepted!");
        }

        function abortNoLayerToggles() {
            if (stopped) return;
            captureTiming.finishReason = "no-layer-toggles";
            stop();
            resetButton();
            onNoLayerToggles(cloneCaptureTiming(captureTiming));
        }

        function pollProgress() {
            if (stopped) return;

            elapsedTicks++;
            captureTiming.elapsedListenSeconds = (elapsedTicks * pollIntervalMs) / 1000;

            const progress = getProgress();
            captureTiming.latestProgress = {
                pointCount: progress.pointCount,
                tileCount: progress.tileCount,
                decodedTiles: progress.decodedTiles,
                decodedPoints: progress.decodedPoints,
                duplicateTiles: progress.duplicateTiles,
                duplicatePoints: progress.duplicatePoints,
                skippedTiles: progress.skippedTiles,
                skippedPoints: progress.skippedPoints,
                tilesetCount: progress.tilesetCount
            };

            if (progress.hasPoints && progress.signature === lastProgressSignature) {
                stableTicks++;
                captureTiming.stableSeconds = (stableTicks * pollIntervalMs) / 1000;
            } else {
                lastProgressSignature = progress.signature;
                stableTicks = 0;
                captureTiming.stableSeconds = 0;
            }

            const quietEnough = elapsedTicks >= minListenTicks && stableTicks >= stableTicksRequired;
            const reachedMaxWait = elapsedTicks >= maxListenTicks;

            if (progress.hasPoints && quietEnough) {
                finishCapture("quiet-period");
            } else if (progress.hasPoints && reachedMaxWait) {
                finishCapture("max-wait-with-data");
            } else if (!progress.hasPoints && reachedMaxWait) {
                timeoutCapture();
            }
        }

        function startListening() {
            if (stopped) return;
            setStatus("⏳ Listening for Data...");
            progressPoller = setIntervalFn(pollProgress, pollIntervalMs);
        }

        function refreshLayerToggles() {
            if (stopped) return;
            const togglesToClick = sessionHostDom.getPointCloudLayerToggles ? sessionHostDom.getPointCloudLayerToggles() : [];

            if (!togglesToClick || togglesToClick.length === 0) {
                abortNoLayerToggles();
                return;
            }

            togglesToClick.forEach(safeClick);
            layerRestoreTimer = setTimeoutFn(() => {
                togglesToClick.forEach(safeClick);
                startListening();
            }, layerRefreshDelayMs);
        }

        function start() {
            if (started) return;
            started = true;
            setStatus("⏳ Auto-Reloading Data Layers...");

            const tabBtn = sessionHostDom.getDataLayersTab ? sessionHostDom.getDataLayersTab() : null;
            safeClick(tabBtn);
            layerDiscoveryTimer = setTimeoutFn(refreshLayerToggles, layerDiscoveryDelayMs);
        }

        return {
            start,
            stop,
            getTiming: () => cloneCaptureTiming(captureTiming)
        };
    }

    async function executeDownload(btnEl, exportFormat, gridSize = 1.0) {
        const calib = hostDom.getCalibrationData();
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
        resetPointCaptureDiagnostics();

        const launchExport = (captureTiming) => {
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

        createCaptureSession({
            btnEl,
            originalText,
            onCaptureReady: launchExport
        }).start();
    }

    window.DashboardExtend.testHooks = window.DashboardExtend.testHooks || {};
    window.DashboardExtend.testHooks.pcExport = {
        createExportWorkerCode,
        createCaptureSession,
        getTileCaptureProgress
    };

    window.DashboardExtend.UI.registerButton('sc-dashboardextend-csv-btn', 'Export Selected Pointcloud (.csv)', (btnEl) => executeDownload(btnEl, 'csv'));
    window.DashboardExtend.UI.registerButton('sc-dashboardextend-dxf-btn', 'Export Selected Pointcloud (.dxf)', (btnEl) => {
        let size = prompt("Enter grid size for mesh decimation (e.g., 1.0 for 1m/1ft cells):", "1.0");
        if (!size || isNaN(parseFloat(size))) return;
        executeDownload(btnEl, 'dxf-mesh', parseFloat(size));
    });
})();
