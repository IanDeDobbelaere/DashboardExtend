(function() {
    const hostDom = window.DashboardExtend.hostDom;
    const state = window.DashboardExtend.state;
    const extensionResourceBase = (() => {
        const scriptSrc = document.currentScript && document.currentScript.src;
        if (!scriptSrc) return "";
        return scriptSrc.slice(0, scriptSrc.lastIndexOf("/") + 1);
    })();

    // --- MAIN THREAD NATIVE POLYGON UN-PROJECTION ---

    // Maps non-projected transformation EPSG codes to their target projected CRS.
    // EPSG:7953 is an ETRS89 → OSGB36 transformation, not a projected CRS.
    // The actual projected CRS is EPSG:27700 (British National Grid).
    const CRS_NORMALIZATION_MAP = {
        7953: 27700
    };

    function getCoordinateConversionApiUrl() {
        return window.location.origin + "/api/v1/convertCoordinates";
    }

    function supportsLocalProjectionEpsg(epsgCode, label) {
        const match = String(epsgCode || "").trim().match(/EPSG[:\s-]*(\d+)/i);
        if (!match) return false;

        let code = parseInt(match[1], 10);
        if (CRS_NORMALIZATION_MAP[code]) code = CRS_NORMALIZATION_MAP[code];

        if (code === 27700) return true;
        if (code >= 31466 && code <= 31469) return true;
        if (code >= 25828 && code <= 25838) return true;
        if (code >= 32601 && code <= 32660) return true;
        if (code >= 32701 && code <= 32760) return true;

        const zoneMatch = String(label || "").match(/UTM\s+zone\s+(\d{1,2})([NS])?/i);
        return !!(zoneMatch && code >= 20000 && code <= 39999);
    }

    async function convertPointsViaNativeAPI(latLngAltArray, targetEpsg, sourceEpsg) {
        if (!state.globalAuthToken) throw new Error("No API Token available");
        let convertedPoints = [];
        const apiUrl = getCoordinateConversionApiUrl();
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
            const planarActiveEpsgProjected = !!(calib && calib.activeEpsg) && vertices.every(v => {
                if (!Number.isFinite(v.x) || !Number.isFinite(v.y)) return false;
                const planarZ = v.z === undefined || v.z === null || !Number.isFinite(v.z) || Math.abs(v.z) < 100000;
                return planarZ && (Math.abs(v.x) > 180 || Math.abs(v.y) > 90);
            });
            const ecefLike = vertices.every(v => {
                if (!Number.isFinite(v.x) || !Number.isFinite(v.y) || !Number.isFinite(v.z)) return false;
                const radius = Math.sqrt((v.x * v.x) + (v.y * v.y) + (v.z * v.z));
                return radius > 6000000 && radius < 7000000;
            });

            if (planarActiveEpsgProjected) {
                mode = "projected";
            } else if (ecefLike) {
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
                try {
                    let {
                        cachedTiles,
                        polygonBoundary,
                        clipMode,
                        globalTransformMatrix,
                        activeLocalGrid,
                        exportFormat,
                        gridSize,
                        extensionResourceBase,
                        outputProjectionEpsg,
                        outputProjectionLabel,
                        coordinateConversionApiUrl,
                        coordinateConversionAuthToken,
                        projectionBatchSize
                    } = e.data;
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

                function normalizeEpsgCode(value) {
                    const text = String(value || "").trim();
                    if (!text) return null;

                    const epsgMatch = text.match(/EPSG[:\\s-]*(\\d+)/i);
                    if (epsgMatch) return "EPSG:" + epsgMatch[1];

                    const numericMatch = text.match(/^(\\d+)$/);
                    if (numericMatch) return "EPSG:" + numericMatch[1];

                    return text.toUpperCase();
                }

                const CRS_NORMALIZATION_MAP = {
                    7953: 27700
                };

                function normalizeCrsToProjected(epsgCode) {
                    if (!epsgCode) return epsgCode;
                    const match = epsgCode.match(/^EPSG:(\\d+)$/);
                    if (!match) return epsgCode;
                    const code = parseInt(match[1], 10);
                    const normalized = CRS_NORMALIZATION_MAP[code];
                    return normalized ? "EPSG:" + normalized : epsgCode;
                }

                const rawNormalizedEpsg = normalizeEpsgCode(outputProjectionEpsg);
                const normalizedOutputProjectionEpsg = normalizeCrsToProjected(rawNormalizedEpsg);
                const crsWasNormalized = rawNormalizedEpsg !== normalizedOutputProjectionEpsg;
                const shouldConvertOutputProjection = !!normalizedOutputProjectionEpsg && normalizedOutputProjectionEpsg !== "EPSG:4326";
                let outputProjectionMethod = shouldConvertOutputProjection ? "api" : "none";
                let outputProjectionLocalDef = null;
                let outputProjectionApiCallCount = 0;
                let outputProjectionConvertedCount = 0;
                let outputProjectionRetryCount = 0;
                let outputProjectionMaxBatchSize = 0;
                let outputProjectionLastError = null;
                let localOutputProjectionDefinition = null;
                let localOutputProjectionReady = false;

                function buildUtmProjectionDefinition(epsgCode, label) {
                    const match = String(epsgCode || "").match(/^EPSG:(\\d+)$/);
                    if (!match) return null;

                    const code = parseInt(match[1], 10);
                    const labelText = String(label || "");

                    if (code >= 31466 && code <= 31469) {
                        const zone = code - 31464;
                        return {
                            code: epsgCode,
                            kind: "dhdn-gauss-kruger",
                            proj4String: "+proj=tmerc +lat_0=0 +lon_0=" + (zone * 3) + " +k=1 +x_0=" + ((zone * 1000000) + 500000) + " +y_0=0 +ellps=bessel +datum=potsdam +units=m +no_defs"
                        };
                    }

                    if (code === 27700) {
                        return {
                            code: epsgCode,
                            kind: "osgb36-british-national-grid",
                            proj4String: "+proj=tmerc +lat_0=49 +lon_0=-2 +k=0.9996012717 +x_0=400000 +y_0=-100000 +ellps=airy +towgs84=446.448,-125.157,542.06,0.15,0.247,0.842,-20.489 +units=m +no_defs"
                        };
                    }

                    if (code >= 25828 && code <= 25838) {
                        return {
                            code: epsgCode,
                            kind: "etrs89-utm",
                            proj4String: "+proj=utm +zone=" + (code - 25800) + " +ellps=GRS80 +units=m +no_defs"
                        };
                    }

                    if (code >= 32601 && code <= 32660) {
                        return {
                            code: epsgCode,
                            kind: "wgs84-utm-north",
                            proj4String: "+proj=utm +zone=" + (code - 32600) + " +datum=WGS84 +units=m +no_defs"
                        };
                    }

                    if (code >= 32701 && code <= 32760) {
                        return {
                            code: epsgCode,
                            kind: "wgs84-utm-south",
                            proj4String: "+proj=utm +zone=" + (code - 32700) + " +south +datum=WGS84 +units=m +no_defs"
                        };
                    }

                    const zoneMatch = labelText.match(/UTM\\s+zone\\s+(\\d{1,2})([NS])?/i);
                    if (zoneMatch && code >= 20000 && code <= 39999) {
                        const zone = parseInt(zoneMatch[1], 10);
                        if (zone >= 1 && zone <= 60) {
                            const hemisphere = String(zoneMatch[2] || "N").toUpperCase();
                            return {
                                code: epsgCode,
                                kind: "label-utm",
                                proj4String: "+proj=utm +zone=" + zone + (hemisphere === "S" ? " +south" : "") + " +datum=WGS84 +units=m +no_defs"
                            };
                        }
                    }

                    return null;
                }

                function activateLocalOutputProjection() {
                    if (!shouldConvertOutputProjection || typeof proj4 === "undefined") return false;

                    if (!localOutputProjectionDefinition) {
                        localOutputProjectionDefinition = buildUtmProjectionDefinition(normalizedOutputProjectionEpsg, outputProjectionLabel);
                    }
                    if (!localOutputProjectionDefinition) return false;
                    if (localOutputProjectionReady) return true;

                    try {
                        if (proj4.defs && !proj4.defs(localOutputProjectionDefinition.code)) {
                            proj4.defs(localOutputProjectionDefinition.code, localOutputProjectionDefinition.proj4String);
                        }
                        outputProjectionMethod = "proj4-local";
                        outputProjectionLocalDef = {
                            kind: localOutputProjectionDefinition.kind,
                            proj4String: localOutputProjectionDefinition.proj4String
                        };
                        localOutputProjectionReady = true;
                        return true;
                    } catch (error) {
                        outputProjectionLastError = error && error.message ? error.message : String(error || "Local projection setup failed.");
                        return false;
                    }
                }

                function projectWithLocalOutputProjection(lng, lat) {
                    if (!activateLocalOutputProjection()) return null;

                    const projected = proj4("EPSG:4326", localOutputProjectionDefinition.code, [lng, lat]);
                    const x = Number(projected[0]);
                    const y = Number(projected[1]);
                    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("Local projection returned invalid coordinates.");

                    return { easting: x, northing: y };
                }

                function createLocalProjectionWriter(baseWriter) {
                    if (!activateLocalOutputProjection()) return null;

                    return {
                        writePoint(lng, lat, z) {
                            const projected = projectWithLocalOutputProjection(lng, lat);
                            baseWriter.writePoint(projected.easting, projected.northing, z);
                            outputProjectionConvertedCount++;
                            return null;
                        }
                    };
                }

                function createOutputProjectionWriter(baseWriter) {
                    let pending = [];
                    const batchSize = Math.max(1, parseInt(projectionBatchSize, 10) || 250);

                    async function readErrorBody(response) {
                        try {
                            if (response && typeof response.text === "function") {
                                const text = await response.text();
                                return String(text || "").replace(/\\s+/g, " ").trim().slice(0, 240);
                            }
                        } catch (e) {}
                        return "";
                    }

                    async function convertBatch(batch) {
                        outputProjectionMaxBatchSize = Math.max(outputProjectionMaxBatchSize, batch.length);

                        try {
                            const coordinates = batch.map(point => [point.lng, point.lat, 0]);
                            const response = await fetch(coordinateConversionApiUrl, {
                                method: "POST",
                                headers: {
                                    "content-type": "application/json",
                                    "authorization": coordinateConversionAuthToken,
                                    "accept": "application/json"
                                },
                                body: JSON.stringify({ from: "EPSG:4326", to: normalizedOutputProjectionEpsg, coordinates })
                            });
                            outputProjectionApiCallCount++;

                            if (!response.ok) {
                                const errorBody = await readErrorBody(response);
                                const firstCoordinate = coordinates[0] || [];
                                const sample = firstCoordinate.map(value => Number.isFinite(value) ? Number(value.toFixed(8)) : value).join(",");
                                const message = "Projection conversion API returned " + response.status + " for " + batch.length + " point(s) to " + normalizedOutputProjectionEpsg + " sample [" + sample + "]" + (errorBody ? ": " + errorBody : "");
                                const error = new Error(message);
                                error.status = response.status;
                                error.batchSize = batch.length;
                                throw error;
                            }

                            const data = await response.json();
                            const converted = data && Array.isArray(data.coordinates) ? data.coordinates : [];
                            if (converted.length !== batch.length) throw new Error("Projection conversion returned an unexpected point count.");

                            return converted;
                        } catch (error) {
                            outputProjectionLastError = error && error.message ? error.message : String(error || "Projection conversion failed.");

                            if (batch.length > 1 && (!error.status || error.status >= 500 || error.status === 413)) {
                                outputProjectionRetryCount++;
                                const splitAt = Math.ceil(batch.length / 2);
                                const left = await convertBatch(batch.slice(0, splitAt));
                                const right = await convertBatch(batch.slice(splitAt));
                                return left.concat(right);
                            }

                            throw error;
                        }
                    }

                    async function flushPending() {
                        if (pending.length === 0) return;
                        if (typeof fetch !== "function") throw new Error("Projection conversion is unavailable in this worker.");
                        if (!coordinateConversionApiUrl || !coordinateConversionAuthToken) throw new Error("Projection conversion is missing API access.");

                        const batch = pending;
                        pending = [];
                        const converted = await convertBatch(batch);

                        for (let i = 0; i < converted.length; i++) {
                            const projected = converted[i] || [];
                            const x = Number(projected[0]);
                            const y = Number(projected[1]);
                            if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("Projection conversion returned invalid coordinates.");

                            baseWriter.writePoint(x, y, batch[i].z);
                            outputProjectionConvertedCount++;
                        }
                    }

                    return {
                        writePoint(lng, lat, z) {
                            pending.push({ lng, lat, z });
                            if (pending.length >= batchSize) return flushPending();
                            return null;
                        },
                        flushPending
                    };
                }

                const meshWriter = exportFormat === 'dxf-mesh' ? createMeshWriter(gridSize) : null;
                const basePointWriter = meshWriter || createPointWriter(exportFormat);
                const localProjectionWriter = createLocalProjectionWriter(basePointWriter);
                const pointWriter = shouldConvertOutputProjection
                    ? (localProjectionWriter || createOutputProjectionWriter(basePointWriter))
                    : basePointWriter;

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
	                        let clippedInOutputProjection = false;
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
	                        } else if (clipMode === 'projected') {
	                            localPt = projectWithLocalOutputProjection(wgs.lng, wgs.lat);
	                            if (localPt) {
	                                testX = localPt.easting; testY = localPt.northing;
	                                clippedInOutputProjection = true;
	                            } else {
	                                testX = trueEcef.x; testY = trueEcef.y;
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
                            
	                            if (clippedInOutputProjection) {
	                                basePointWriter.writePoint(finalX, finalY, finalZ);
	                                outputProjectionConvertedCount++;
	                            } else {
	                                const pendingWrite = pointWriter.writePoint(finalX, finalY, finalZ);
	                                if (pendingWrite && typeof pendingWrite.then === "function") await pendingWrite;
	                            }
	                            clippedCount++;
	                        }
                    }
                }

                if (pointWriter.flushPending) await pointWriter.flushPending();

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
                        outputProjectionEpsg: normalizedOutputProjectionEpsg,
                        outputProjectionEpsgRaw: crsWasNormalized ? rawNormalizedEpsg : undefined,
                        crsWasNormalized,
                        outputProjectionMethod,
                        outputProjectionLocalDef,
                        outputProjectionConvertedCount,
                        outputProjectionApiCallCount,
                        outputProjectionRetryCount,
                        outputProjectionMaxBatchSize,
                        outputProjectionLastError,
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
                } catch (error) {
                    self.postMessage({
                        error: error && error.message ? error.message : String(error || "Export failed."),
                        exportFormat: e && e.data ? e.data.exportFormat : undefined,
                        clippedCount: 0,
                        droppedCount: 0
                    });
                }
            };
        `;
    }

    function runExportWorker(payload, callback, btnEl, onStatus) {
        const workerCode = createExportWorkerCode();

        const blob = new Blob([workerCode], { type: 'application/javascript' });
        const worker = new Worker(URL.createObjectURL(blob));
        
        worker.onmessage = function(e) {
            if (e.data.status) {
                if (btnEl) btnEl.innerText = e.data.status;
                if (typeof onStatus === 'function') onStatus(e.data.status);
            }
            else { callback(e.data); worker.terminate(); }
        };
        worker.onerror = function(error) {
            const message = error && error.message ? error.message : "Worker failed.";
            callback({
                error: message,
                exportFormat: payload && payload.exportFormat,
                clippedCount: 0,
                droppedCount: 0
            });
            worker.terminate();
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

    function validateDxfExportSettings(settings) {
        const exportType = settings && settings.exportType ? String(settings.exportType) : 'fast-mesh';
        if (exportType !== 'fast-mesh') {
            return {
                ok: false,
                error: 'TIN Surface is not available yet. Use Fast Mesh for this export.'
            };
        }

        const rawGridSize = settings && settings.gridSize !== undefined ? String(settings.gridSize).trim() : '';
        const gridSize = rawGridSize ? Number(rawGridSize) : NaN;
        if (!Number.isFinite(gridSize) || gridSize <= 0) {
            return {
                ok: false,
                error: 'Grid size must be a number greater than 0.'
            };
        }

        return {
            ok: true,
            exportFormat: 'dxf-mesh',
            exportType,
            gridSize
        };
    }

    function describeDxfProjection(calib) {
        const label = cleanText(calib && calib.coordinateSystemLabel);
        const epsg = cleanText(calib && calib.activeEpsg);

        if (epsg && label && label !== epsg) return epsg + ' - ' + label;
        if (epsg) return epsg;
        if (label) return label;
        if (calib && calib.activeLocalGrid) return 'Local grid';
        return 'Dashboard coordinates';
    }

    function describeDxfPointCount(captureState) {
        const progress = getTileCaptureProgress(captureState || state);
        if (progress.pointCount > 0) return progress.pointCount.toLocaleString() + ' captured points';
        if (progress.tileCount > 0) return progress.tileCount.toLocaleString() + ' cached tiles';
        return 'Capture on export';
    }

    function appendText(parent, text) {
        const node = document.createElement('span');
        node.innerText = text;
        node.textContent = text;
        parent.appendChild(node);
        return node;
    }

    function removeElement(element) {
        if (!element) return;
        if (typeof element.remove === 'function') {
            element.remove();
            return;
        }

        const parent = element.parentNode;
        if (!parent || !parent.children) return;
        const index = parent.children.indexOf(element);
        if (index !== -1) parent.children.splice(index, 1);
        if (parent.childNodes === parent.children) return;
        if (parent.childNodes) {
            const childNodeIndex = parent.childNodes.indexOf(element);
            if (childNodeIndex !== -1) parent.childNodes.splice(childNodeIndex, 1);
        }
    }

    function createDxfField(labelText, control) {
        const field = document.createElement('label');
        Object.assign(field.style, {
            display: 'flex',
            flexDirection: 'column',
            gap: '6px',
            color: '#f7f7f8',
            fontSize: '12px',
            fontWeight: '700'
        });

        appendText(field, labelText);
        field.appendChild(control);
        return field;
    }

    function styleDxfControl(control) {
        Object.assign(control.style, {
            width: '100%',
            boxSizing: 'border-box',
            border: '1px solid #f5f5ff33',
            borderRadius: '4px',
            backgroundColor: '#17171a',
            color: '#ffffff',
            fontSize: '13px',
            padding: '10px'
        });
    }

    function createDxfExportModal(btnEl, options = {}) {
        const rootDocument = options.document || document;
        const rootBody = rootDocument.body || rootDocument.documentElement;
        const modalState = {
            isOpen: false
        };

        if (!rootBody || typeof rootBody.appendChild !== 'function') return null;

        hostDom.invalidateCache();
        const calib = hostDom.getCalibrationData();

        const overlay = rootDocument.createElement('div');
        overlay.id = 'sc-dashboardextend-dxf-modal';
        Object.assign(overlay.style, {
            position: 'fixed',
            inset: '0',
            zIndex: '2147483647',
            backgroundColor: 'rgba(15, 17, 22, 0.58)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '16px',
            boxSizing: 'border-box',
            fontFamily: 'system-ui, -apple-system, sans-serif'
        });

        const dialog = rootDocument.createElement('div');
        dialog.setAttribute('role', 'dialog');
        dialog.setAttribute('aria-modal', 'true');
        dialog.setAttribute('aria-labelledby', 'sc-dashboardextend-dxf-title');
        Object.assign(dialog.style, {
            width: 'min(420px, 100%)',
            backgroundColor: '#17171a',
            color: '#ffffff',
            border: '1px solid #f5f5ff33',
            borderRadius: '6px',
            boxShadow: '0 18px 60px rgba(0, 0, 0, 0.35)',
            padding: '18px',
            boxSizing: 'border-box'
        });

        const header = rootDocument.createElement('div');
        Object.assign(header.style, {
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '12px',
            marginBottom: '14px'
        });

        const title = rootDocument.createElement('h2');
        title.id = 'sc-dashboardextend-dxf-title';
        title.innerText = 'DXF Export';
        title.textContent = 'DXF Export';
        Object.assign(title.style, {
            margin: '0',
            fontSize: '18px',
            lineHeight: '1.2',
            fontWeight: '800'
        });

        const closeButton = rootDocument.createElement('button');
        closeButton.type = 'button';
        closeButton.id = 'sc-dashboardextend-dxf-close';
        closeButton.innerText = 'x';
        closeButton.textContent = 'x';
        closeButton.setAttribute('aria-label', 'Close DXF export');
        Object.assign(closeButton.style, {
            width: '32px',
            height: '32px',
            border: '1px solid #5c5f69',
            borderRadius: '4px',
            backgroundColor: '#31323a',
            color: '#ffffff',
            cursor: 'pointer',
            fontSize: '16px',
            lineHeight: '1'
        });

        header.appendChild(title);
        header.appendChild(closeButton);

        const form = rootDocument.createElement('div');
        Object.assign(form.style, {
            display: 'flex',
            flexDirection: 'column',
            gap: '12px'
        });

        const exportType = rootDocument.createElement('select');
        exportType.id = 'sc-dashboardextend-dxf-export-type';
        styleDxfControl(exportType);

        const fastMeshOption = rootDocument.createElement('option');
        fastMeshOption.value = 'fast-mesh';
        fastMeshOption.innerText = 'Fast Mesh - averaged grid cells';
        fastMeshOption.textContent = 'Fast Mesh - averaged grid cells';
        exportType.appendChild(fastMeshOption);

        const tinOption = rootDocument.createElement('option');
        tinOption.value = 'tin-surface';
        tinOption.disabled = true;
        tinOption.innerText = 'TIN Surface - coming later';
        tinOption.textContent = 'TIN Surface - coming later';
        exportType.appendChild(tinOption);

        const gridInput = rootDocument.createElement('input');
        gridInput.id = 'sc-dashboardextend-dxf-grid-size';
        gridInput.type = 'number';
        gridInput.min = '0.001';
        gridInput.step = '0.1';
        gridInput.value = '1.0';
        gridInput.inputMode = 'decimal';
        styleDxfControl(gridInput);

        const projection = rootDocument.createElement('input');
        projection.id = 'sc-dashboardextend-dxf-projection';
        projection.type = 'text';
        projection.readOnly = true;
        projection.value = describeDxfProjection(calib);
        styleDxfControl(projection);
        projection.style.color = '#d7dae2';

        const pointCount = rootDocument.createElement('input');
        pointCount.id = 'sc-dashboardextend-dxf-point-count';
        pointCount.type = 'text';
        pointCount.readOnly = true;
        pointCount.value = describeDxfPointCount();
        styleDxfControl(pointCount);
        pointCount.style.color = '#d7dae2';

        const errorMessage = rootDocument.createElement('div');
        errorMessage.id = 'sc-dashboardextend-dxf-error';
        errorMessage.setAttribute('role', 'alert');
        Object.assign(errorMessage.style, {
            display: 'none',
            border: '1px solid #c45c5c',
            borderRadius: '4px',
            backgroundColor: '#3a2024',
            color: '#ffd7d7',
            fontSize: '12px',
            lineHeight: '1.35',
            padding: '10px'
        });

        const statusMessage = rootDocument.createElement('div');
        statusMessage.id = 'sc-dashboardextend-dxf-status';
        statusMessage.setAttribute('aria-live', 'polite');
        Object.assign(statusMessage.style, {
            minHeight: '18px',
            color: '#d7dae2',
            fontSize: '12px',
            lineHeight: '1.35'
        });

        const actions = rootDocument.createElement('div');
        Object.assign(actions.style, {
            display: 'flex',
            justifyContent: 'flex-end',
            gap: '8px',
            marginTop: '2px'
        });

        const cancelButton = rootDocument.createElement('button');
        cancelButton.type = 'button';
        cancelButton.id = 'sc-dashboardextend-dxf-cancel';
        cancelButton.innerText = 'Cancel';
        cancelButton.textContent = 'Cancel';
        Object.assign(cancelButton.style, {
            border: '1px solid #5c5f69',
            borderRadius: '4px',
            backgroundColor: '#2d3038',
            color: '#ffffff',
            cursor: 'pointer',
            fontWeight: '700',
            padding: '10px 14px'
        });

        const submitButton = rootDocument.createElement('button');
        submitButton.type = 'button';
        submitButton.id = 'sc-dashboardextend-dxf-submit';
        submitButton.innerText = 'Export DXF';
        submitButton.textContent = 'Export DXF';
        Object.assign(submitButton.style, {
            border: 'none',
            borderRadius: '4px',
            backgroundColor: '#006dcc',
            color: '#ffffff',
            cursor: 'pointer',
            fontWeight: '800',
            padding: '10px 14px'
        });

        actions.appendChild(cancelButton);
        actions.appendChild(submitButton);

        form.appendChild(createDxfField('Export type', exportType));
        form.appendChild(createDxfField('Grid size', gridInput));
        form.appendChild(createDxfField('Projection', projection));
        form.appendChild(createDxfField('Point count', pointCount));
        form.appendChild(errorMessage);
        form.appendChild(statusMessage);
        form.appendChild(actions);

        dialog.appendChild(header);
        dialog.appendChild(form);
        overlay.appendChild(dialog);

        function setError(message) {
            const text = cleanText(message);
            errorMessage.innerText = text;
            errorMessage.textContent = text;
            errorMessage.style.display = text ? 'block' : 'none';
        }

        function setStatus(message) {
            const text = cleanText(message);
            statusMessage.innerText = text;
            statusMessage.textContent = text;
        }

        function setBusy(isBusy) {
            exportType.disabled = isBusy;
            gridInput.disabled = isBusy;
            submitButton.disabled = isBusy;
            cancelButton.disabled = isBusy;
            closeButton.disabled = isBusy;
            submitButton.innerText = isBusy ? 'Exporting...' : 'Export DXF';
            submitButton.textContent = submitButton.innerText;
            submitButton.style.opacity = isBusy ? '0.72' : '1';
            cancelButton.style.opacity = isBusy ? '0.72' : '1';
            closeButton.style.opacity = isBusy ? '0.72' : '1';
        }

        function close() {
            if (!modalState.isOpen) return;
            modalState.isOpen = false;
            removeElement(overlay);
        }

        function submitExport() {
            const validation = validateDxfExportSettings({
                exportType: exportType.value,
                gridSize: gridInput.value
            });

            if (!validation.ok) {
                setStatus('');
                setError(validation.error);
                return false;
            }

            setError('');
            setStatus('Preparing DXF export...');
            setBusy(true);

            return executeDownload(btnEl, validation.exportFormat, validation.gridSize, {
                onError(message) {
                    setError(message);
                    setBusy(false);
                },
                onStatus: setStatus,
                onFinish(success) {
                    if (success) close();
                    else setBusy(false);
                }
            });
        }

        closeButton.onclick = close;
        cancelButton.onclick = close;
        gridInput.oninput = () => setError('');
        submitButton.onclick = submitExport;

        rootBody.appendChild(overlay);
        modalState.isOpen = true;

        if (typeof gridInput.focus === 'function') {
            try {
                gridInput.focus();
                if (typeof gridInput.select === 'function') gridInput.select();
            } catch (e) {}
        }

        return {
            overlay,
            exportType,
            gridInput,
            projection,
            pointCount,
            errorMessage,
            statusMessage,
            submitButton,
            cancelButton,
            closeButton,
            close,
            setError,
            setStatus,
            setBusy,
            submitExport,
            isOpen: () => modalState.isOpen
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

    async function executeDownload(btnEl, exportFormat, gridSize = 1.0, options = {}) {
        const originalText = btnEl ? btnEl.innerText : '';
        const usesInlineErrors = typeof options.onError === 'function';
        const reportError = usesInlineErrors ? options.onError : message => alert(message);
        const reportStatus = typeof options.onStatus === 'function' ? options.onStatus : function() {};
        const finish = typeof options.onFinish === 'function' ? options.onFinish : function() {};

        function setStatus(text) {
            if (btnEl) btnEl.innerText = text;
            reportStatus(text);
        }

        function resetButton() {
            if (!btnEl) return;
            btnEl.innerText = originalText;
            btnEl.disabled = false;
        }

        function fail(message, error) {
            if (error) console.error(error);
            resetButton();
            reportError(message);
            finish(false);
        }

        hostDom.invalidateCache();
        const calib = hostDom.getCalibrationData();
        if (!state.globalTransformMatrix) {
            fail("Missing Global Matrix! Pan or zoom map slightly to capture the tileset.");
            return;
        }
        
        let polygonData;
        try {
            polygonData = extractPolygonData(calib);
        } catch (error) {
            fail(error.message);
            return;
        }

        let polygonBoundary = polygonData.boundary;
        let clipMode = polygonData.mode === "lnglat" ? "wgs84" : polygonData.mode;

        if (btnEl) btnEl.disabled = true;
        const outputProjectionEpsg = calib.activeEpsg || null;
        const canUseLocalProjection = supportsLocalProjectionEpsg(outputProjectionEpsg, calib.coordinateSystemLabel);

        if (outputProjectionEpsg && !canUseLocalProjection && !state.globalAuthToken) {
            fail("Missing API Token! Please pan the map or click a layer to capture it.");
            return;
        }

        if (outputProjectionEpsg && polygonData.mode === "projected" && !canUseLocalProjection) {
            setStatus("⏳ Un-Projecting Polygon Boundary...");
            try {
                let apiPayload = polygonBoundary.map(pt => [pt[0], pt[1], 0]);
                let reversed = await convertPointsViaNativeAPI(apiPayload, "EPSG:4326", outputProjectionEpsg);
                
                const firstX = reversed[0][0];
                if (Math.abs(firstX) <= 90 && Math.abs(reversed[0][1]) > 90) {
                     polygonBoundary = reversed.map(pt => [pt[1], pt[0]]);
                } else {
                     polygonBoundary = reversed.map(pt => [pt[0], pt[1]]);
                }
                clipMode = "wgs84";
            } catch (e) {
                fail("Failed to un-project polygon using API.", e);
                return;
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
                exportFormat, gridSize, extensionResourceBase,
                outputProjectionEpsg,
                outputProjectionLabel: calib.coordinateSystemLabel || null,
                coordinateConversionApiUrl: outputProjectionEpsg ? getCoordinateConversionApiUrl() : null,
                coordinateConversionAuthToken: outputProjectionEpsg ? state.globalAuthToken : null
            }, (result) => {
                if (result.error) {
                    console.error("Dashboard Extend PC export failed:", result.error);
                    state.totalPointsHarvested = state.cachedTiles.reduce((sum, tile) => sum + (tile.length || 0), 0);
                    resetButton();
                    reportError("Export failed: " + result.error);
                    finish(false);
                    return;
                }

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

                let success = false;
                if (result.clippedCount === 0) {
                    reportError("0 points found inside your polygon. If the polygon is tight, try drawing a slightly larger one.");
                } else {
                    const extension = result.exportFormat === 'csv' ? 'csv' : 'dxf';
                    const mimeType = result.exportFormat === 'csv' ? 'text/csv;charset=utf-8;' : 'application/dxf';
                    const blob = new Blob([result.rows], { type: mimeType });
                    const url = URL.createObjectURL(blob);
                    const link = document.createElement("a"); link.href = url; link.download = buildExportFilename(extension); link.click(); URL.revokeObjectURL(url);

                    console.log(`✅ Kept Local Coordinate Points: ${result.clippedCount} | 🗑️ Dropped: ${result.droppedCount}`);
                    success = true;
                }

                state.totalPointsHarvested = state.cachedTiles.reduce((sum, tile) => sum + (tile.length || 0), 0);
                resetButton();
                finish(success);
            }, btnEl, reportStatus);
        };

        createCaptureSession({
            btnEl,
            originalText,
            onStatus: reportStatus,
            alertFn: reportError,
            onTimeout: () => finish(false),
            onNoLayerToggles: () => {
                if (usesInlineErrors) reportError("Could not find point cloud layer toggles. Open Data Layers and try again.");
                finish(false);
            },
            onCaptureReady: launchExport
        }).start();
    }

    window.DashboardExtend.testHooks = window.DashboardExtend.testHooks || {};
    window.DashboardExtend.testHooks.pcExport = {
        createExportWorkerCode,
        createCaptureSession,
        getTileCaptureProgress,
        validateDxfExportSettings,
        describeDxfProjection,
        describeDxfPointCount,
        createDxfExportModal,
        extractPolygonData,
        supportsLocalProjectionEpsg
    };

    window.DashboardExtend.UI.registerButton('sc-dashboardextend-csv-btn', 'Export Selected Pointcloud (.csv)', (btnEl) => executeDownload(btnEl, 'csv'));
    window.DashboardExtend.UI.registerButton('sc-dashboardextend-dxf-btn', 'Export Selected Pointcloud (.dxf)', (btnEl) => {
        createDxfExportModal(btnEl);
    });
})();
