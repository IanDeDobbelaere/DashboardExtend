(function() {
    const utils = window.DashboardExtend.utils;
    const state = window.DashboardExtend.state;

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

    // --- 🚀 BACKGROUND WEB WORKER ENGINE ---
    function runExportWorker(payload, callback, btnEl) {
        const workerCode = `
            self.onmessage = async function(e) {
                const { cachedTiles, polygonBoundary, isPolygonLngLat, globalTransformMatrix, activeLocalGrid, activeEpsg, exportFormat, gridSize, authToken, origin } = e.data;
                const rows = []; 
                let clippedCount = 0;
                let droppedCount = 0;

                if (exportFormat === 'dxf' || exportFormat === 'dxf-mesh') rows.push("0\\nSECTION\\n2\\nENTITIES");

                function applyMatrix(rawX, rawY, rawZ, m) {
                    return {
                        x: (m[0] * rawX) + (m[4] * rawY) + (m[8] * rawZ) + m[12],
                        y: (m[1] * rawX) + (m[5] * rawY) + (m[9] * rawZ) + m[13],
                        z: (m[2] * rawX) + (m[6] * rawY) + (m[10] * rawZ) + m[14]
                    };
                }

                function deg2rad(deg) { return deg * Math.PI / 180.0; }
                function lngLatAltToEcef(lng, lat, alt) {
                    const a = 6378137.0; const e2 = 0.00669437999014;
                    const radLat = deg2rad(lat); const radLng = deg2rad(lng);
                    const N = a / Math.sqrt(1 - e2 * Math.sin(radLat) * Math.sin(radLat));
                    return { x: (N + alt) * Math.cos(radLat) * Math.cos(radLng), y: (N + alt) * Math.cos(radLat) * Math.sin(radLng), z: (N * (1 - e2) + alt) * Math.sin(radLat) };
                }
                function ecefToLngLatAlt(x, y, z) {
                    const a = 6378137.0; const e2 = 0.00669437999014;
                    const b = Math.sqrt(a * a * (1 - e2)); const ep2 = (a * a - b * b) / (b * b);
                    const p = Math.sqrt(x * x + y * y); const th = Math.atan2(a * z, b * p);
                    const lon = Math.atan2(y, x);
                    const lat = Math.atan2((z + ep2 * b * Math.pow(Math.sin(th), 3)), (p - e2 * a * Math.pow(Math.cos(th), 3)));
                    return { lng: lon * 180 / Math.PI, lat: lat * 180 / Math.PI, alt: z }; 
                }
                
                // Added rotSign parameter to allow testing both positive and negative rotations
                function ecefToLocalSite(x, y, z, settings, rotSign = 1) {
                    const originEcef = lngLatAltToEcef(settings.originLng, settings.originLat, 0);
                    const dx = x - originEcef.x; const dy = y - originEcef.y; const dz = z - originEcef.z;
                    const radLat = deg2rad(settings.originLat); const radLng = deg2rad(settings.originLng);
                    const slong = Math.sin(radLng); const clong = Math.cos(radLng);
                    const slat = Math.sin(radLat); const clat = Math.cos(radLat);
                    
                    const east = -slong * dx + clong * dy;
                    const north = -slat * clong * dx - slat * slong * dy + clat * dz;
                    const up = clat * clong * dx + clat * slong * dy + slat * dz;
                    
                    // 1. Rotate FIRST
                    const radRot = deg2rad((settings.rotation || 0) * rotSign); 
                    const cosRot = Math.cos(radRot); const sinRot = Math.sin(radRot);
                    const eRot = (east * cosRot) - (north * sinRot);
                    const nRot = (east * sinRot) + (north * cosRot);
                    
                    // 2. Scale SECOND
                    const eFinal = eRot * (settings.scaleFactor || 1);
                    const nFinal = nRot * (settings.scaleFactor || 1);
                    
                    return { easting: (settings.originEasting || 0) + eFinal, northing: (settings.originNorthing || 0) + nFinal, elevation: up + (settings.verticalShift || 0) };
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

                let validPointsWGS84 = [];
                let finalPoints = [];

                let minX = Math.min(...polygonBoundary.map(p => p[0]));
                let maxX = Math.max(...polygonBoundary.map(p => p[0]));
                let minY = Math.min(...polygonBoundary.map(p => p[1]));
                let maxY = Math.max(...polygonBoundary.map(p => p[1]));

                // State Tracker for the Invisible Rotation Hack
                let lockedRotationSign = 0; // 0 = unknown, 1 = positive, -1 = negative

                for (const tile of cachedTiles) {
                    for (let i = 0; i < tile.length; i++) {
                        if (tile.combineSurveys && tile.combineSurveys[i] === 160) { droppedCount++; continue; }
                        
                        const rx = tile.positions[i * 3] + tile.rtcCenter[0];
                        const ry = tile.positions[i * 3 + 1] + tile.rtcCenter[1];
                        const rz = tile.positions[i * 3 + 2] + tile.rtcCenter[2];
                        const trueEcef = applyMatrix(rx, ry, rz, globalTransformMatrix);
                        const wgs = ecefToLngLatAlt(trueEcef.x, trueEcef.y, trueEcef.z);
                        
                        let testX, testY, localPt = null;

                        if (activeEpsg) {
                            testX = wgs.lng; testY = wgs.lat; 
                            if (testX < minX || testX > maxX || testY < minY || testY > maxY) continue;
                            
                            if (isPointInPolygon([testX, testY], polygonBoundary)) {
                                validPointsWGS84.push({lat: wgs.lat, lng: wgs.lng, alt: wgs.alt || trueEcef.z});
                                clippedCount++;
                            }
                        } else if (activeLocalGrid) {
                            // THE DUAL-CALCULATION HACK (Runs until rotation sign is confirmed)
                            if (lockedRotationSign === 0) {
                                let ptPos = ecefToLocalSite(trueEcef.x, trueEcef.y, trueEcef.z, activeLocalGrid, 1);
                                let ptNeg = ecefToLocalSite(trueEcef.x, trueEcef.y, trueEcef.z, activeLocalGrid, -1);
                                
                                let txPos = isPolygonLngLat ? wgs.lng : ptPos.easting;
                                let tyPos = isPolygonLngLat ? wgs.lat : ptPos.northing;
                                
                                let txNeg = isPolygonLngLat ? wgs.lng : ptNeg.easting;
                                let tyNeg = isPolygonLngLat ? wgs.lat : ptNeg.northing;
                                
                                let posInside = isPointInPolygon([txPos, tyPos], polygonBoundary);
                                let negInside = isPointInPolygon([txNeg, tyNeg], polygonBoundary);
                                
                                if (posInside && !negInside) {
                                    lockedRotationSign = 1; 
                                    localPt = ptPos; testX = txPos; testY = tyPos;
                                } else if (negInside && !posInside) {
                                    lockedRotationSign = -1;
                                    localPt = ptNeg; testX = txNeg; testY = tyNeg;
                                } else {
                                    // If neither hit the polygon, drop the point and test the next one
                                    continue;
                                }
                            } else {
                                // Once locked, we only calculate the CORRECT rotation to save CPU
                                localPt = ecefToLocalSite(trueEcef.x, trueEcef.y, trueEcef.z, activeLocalGrid, lockedRotationSign);
                                testX = isPolygonLngLat ? wgs.lng : localPt.easting;
                                testY = isPolygonLngLat ? wgs.lat : localPt.northing;
                            }

                            if (testX < minX || testX > maxX || testY < minY || testY > maxY) continue;

                            if (isPointInPolygon([testX, testY], polygonBoundary)) {
                                finalPoints.push({ x: localPt.easting, y: localPt.northing, z: localPt.elevation });
                                clippedCount++;
                            }
                        }
                    }
                }

                if (activeEpsg && validPointsWGS84.length > 0) {
                    let apiPayload = validPointsWGS84.map(pt => [pt.lat, pt.lng, pt.alt]);
                    let convertedPoints = [];
                    const CHUNK_SIZE = 10000;
                    const apiUrl = origin + "/api/v1/convertCoordinates";
                    let totalChunks = Math.ceil(apiPayload.length / CHUNK_SIZE);

                    for (let i = 0; i < apiPayload.length; i += CHUNK_SIZE) {
                        let currentChunk = Math.floor(i / CHUNK_SIZE) + 1;
                        self.postMessage({ status: \`⏳ API Translating... (\${currentChunk}/\${totalChunks})\` });

                        const chunk = apiPayload.slice(i, i + CHUNK_SIZE);
                        const res = await fetch(apiUrl, {
                            method: "POST",
                            headers: { "content-type": "application/json", "authorization": authToken, "accept": "application/json" },
                            body: JSON.stringify({ from: "EPSG:4979", to: activeEpsg, coordinates: chunk })
                        });
                        if (res.ok) {
                            const data = await res.json();
                            convertedPoints.push(...data.coordinates);
                        }
                    }
                    finalPoints = convertedPoints.map(pt => ({ x: pt[0], y: pt[1], z: pt[2] }));
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

                    let faceCount = 0;
                    grid.forEach((cell, key) => {
                        let coords = key.split(",");
                        let gx = parseInt(coords[0]), gy = parseInt(coords[1]);

                        let c1 = cell, c2 = grid.get((gx+1) + "," + gy), c3 = grid.get((gx+1) + "," + (gy+1)), c4 = grid.get(gx + "," + (gy+1));

                        if(c2 && c3 && c4) {
                            rows.push(\`0\\n3DFACE\\n8\\nAutoHarvestedMesh\\n10\\n\${c1.x.toFixed(4)}\\n20\\n\${c1.y.toFixed(4)}\\n30\\n\${c1.z.toFixed(4)}\\n11\\n\${c2.x.toFixed(4)}\\n21\\n\${c2.y.toFixed(4)}\\n31\\n\${c2.z.toFixed(4)}\\n12\\n\${c3.x.toFixed(4)}\\n22\\n\${c3.y.toFixed(4)}\\n32\\n\${c3.z.toFixed(4)}\\n13\\n\${c4.x.toFixed(4)}\\n23\\n\${c4.y.toFixed(4)}\\n33\\n\${c4.z.toFixed(4)}\`);
                            faceCount++;
                        }
                    });
                    clippedCount = faceCount; 
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

                self.postMessage({ rows: rows.join("\\n"), clippedCount, droppedCount, exportFormat, rotationTested: lockedRotationSign });
            };
        `;

        const blob = new Blob([workerCode], { type: 'application/javascript' });
        const worker = new Worker(URL.createObjectURL(blob));
        
        worker.onmessage = function(e) {
            if (e.data.status) {
                if (btnEl) btnEl.innerText = e.data.status;
            } else {
                callback(e.data);
                worker.terminate(); 
            }
        };
        worker.postMessage(payload);
    }

    // --- ✂️ EXPORT HANDLER ---
    async function executeDownload(btnEl, exportFormat, gridSize = 1.0) {
        const calib = utils.getCalibrationData();
        if (!calib.activeLocalGrid && !calib.activeEpsg) {
            return alert("Missing Calibration! Please open the Project Information panel so the script can read the coordinates.");
        }

        if (calib.activeEpsg && !state.globalAuthToken) return alert("Missing API Token! Please pan the map or click a layer to capture it.");
        if (!state.globalTransformMatrix) return alert("Missing Global Matrix! Pan or zoom the map slightly to capture the tileset.json.");
        
        const litComponent = utils.findDeepNode(n => n.tagName === "SC-BASIC-ANNOTATION-EDITOR");
        if (!litComponent || !litComponent._annotationState) return alert("Could not locate your polygon.");

        let rawCoords = null;
        const commonNames = ["coordinates", "positions", "polygonBoundary", "points", "vertices", "geometry"];
        for (let name of commonNames) { 
            if (Array.isArray(litComponent._annotationState[name]) && litComponent._annotationState[name].length > 2) {
                rawCoords = litComponent._annotationState[name]; break;
            } 
        }
        if (!rawCoords) return alert("Could not extract coordinates from polygon.");

        let polygonBoundary = rawCoords.map(v => {
            if (Array.isArray(v)) return [v[0], v[1]];
            if (v.x !== undefined && v.y !== undefined) return [v.x, v.y];
            if (v.east !== undefined && v.north !== undefined) return [v.east, v.north];
            if (v.lng !== undefined && v.lat !== undefined) return [v.lng, v.lat];
            return null;
        }).filter(v => v !== null);

        let isPolygonLngLat = (Math.abs(polygonBoundary[0][0]) <= 180 && Math.abs(polygonBoundary[0][1]) <= 90);

        const originalText = btnEl.innerText;
        btnEl.disabled = true;

        if (calib.activeEpsg && !isPolygonLngLat) {
            btnEl.innerText = "⏳ Un-Projecting Polygon Boundary...";
            try {
                let apiPayload = polygonBoundary.map(pt => [pt[0], pt[1], 0]);
                let reversed = await convertPointsViaNativeAPI(apiPayload, "EPSG:4979", calib.activeEpsg);
                polygonBoundary = reversed.map(pt => [pt[1], pt[0]]); 
                isPolygonLngLat = true;
            } catch (e) {
                console.error(e);
                btnEl.disabled = false;
                btnEl.innerText = originalText;
                return alert("Failed to un-project polygon using API.");
            }
        }

        state.cachedTiles = [];
        state.totalPointsHarvested = 0;
        btnEl.innerText = "⏳ Auto-Reloading Data Layers...";
        
        setTimeout(() => {
            const svgPath = utils.findDeepNode(n => n.tagName === 'PATH' && n.getAttribute('d') && n.getAttribute('d').startsWith('M264.5'));
            let tabBtn = svgPath;
            while (tabBtn && tabBtn.tagName !== 'SC-TAB') {
                tabBtn = tabBtn.parentNode || (tabBtn.getRootNode && tabBtn.getRootNode().host);
            }
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
                        let lastCount = -1, silenceTicks = 0, maxTimeouts = 60; 
                        
                        const silencePoller = setInterval(() => {
                            maxTimeouts--;
                            if (maxTimeouts <= 0) {
                                clearInterval(silencePoller);
                                btnEl.innerText = originalText; btnEl.disabled = false;
                                if (state.totalPointsHarvested === 0) alert("Timeout: No data intercepted!");
                                return;
                            }
                            
                            if (state.totalPointsHarvested > 0 && state.totalPointsHarvested === lastCount) {
                                silenceTicks++;
                                if (silenceTicks >= 6) {
                                    clearInterval(silencePoller);
                                    btnEl.innerText = "⚙️ Crunching Math (Background)...";
                                    
                                    runExportWorker({
                                        cachedTiles: state.cachedTiles, 
                                        polygonBoundary, 
                                        isPolygonLngLat, 
                                        globalTransformMatrix: state.globalTransformMatrix, 
                                        activeLocalGrid: calib.activeLocalGrid, 
                                        activeEpsg: calib.activeEpsg, 
                                        exportFormat, 
                                        gridSize,
                                        authToken: state.globalAuthToken, 
                                        origin: window.location.origin
                                    }, (result) => {
                                        if (result.rows.length === 0) {
                                            console.warn(`[Dashboard Extend] 0 data found inside polygon. (Rotation Checked: ${result.rotationTested})`);
                                            alert("0 points found inside your polygon. If the polygon is tight, try drawing a slightly larger one.");
                                        } else {
                                            const extension = result.exportFormat === 'csv' ? 'csv' : 'dxf';
                                            const mimeType = result.exportFormat === 'csv' ? 'text/csv;charset=utf-8;' : 'application/dxf';
                                            const blob = new Blob([result.rows], { type: mimeType });
                                            const url = URL.createObjectURL(blob);
                                            const link = document.createElement("a");
                                            link.href = url; 
                                            link.download = `Final_Auto_Harvest_${Date.now()}.${extension}`; 
                                            link.click();
                                            URL.revokeObjectURL(url);
                                            
                                            const signStr = result.rotationTested === 1 ? 'Positive' : (result.rotationTested === -1 ? 'Negative' : 'N/A');
                                            if(result.exportFormat === 'dxf-mesh'){
                                                console.log(`✅ Faces Created: ${result.clippedCount} | 🗑️ Dropped: ${result.droppedCount} | Rotation Locked: ${signStr}`);
                                            } else {
                                                console.log(`✅ Kept Points: ${result.clippedCount} | 🗑️ Dropped: ${result.droppedCount} | Rotation Locked: ${signStr}`);
                                            }
                                        }
                                        
                                        state.cachedTiles = [];
                                        state.totalPointsHarvested = 0;
                                        btnEl.innerText = originalText;
                                        btnEl.disabled = false;
                                    }, btnEl);
                                }
                            } else {
                                lastCount = state.totalPointsHarvested;
                                silenceTicks = 0;
                            }
                        }, 500);

                    }, 500);
                } else {
                    btnEl.innerText = originalText; btnEl.disabled = false;
                }
            }, 1000); 
        }, 500);
    }

    // --- UI REGISTRATION ---
    window.DashboardExtend.UI.registerButton(
        'sc-dashboardextend-csv-btn', 
        'Export Selected Pointcloud (.csv)', 
        (btnEl) => executeDownload(btnEl, 'csv')
    );

    window.DashboardExtend.UI.registerButton(
        'sc-dashboardextend-dxf-btn', 
        'Export Selected Pointcloud (.dxf)', 
        (btnEl) => {
            let size = prompt("Enter grid size for mesh decimation (e.g., 1.0 for 1m/1ft cells):", "1.0");
            if (!size || isNaN(parseFloat(size))) return;
            executeDownload(btnEl, 'dxf-mesh', parseFloat(size));
        }
    );
})();