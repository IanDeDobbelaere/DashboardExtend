'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { buildTinyPnts } = require('./fixtures/tinyPnts');

const repoRoot = path.resolve(__dirname, '..');
const tinyTileUrl = 'https://example.com/model/tiles/tiny.pnts?sig=1#first';
const equatorEcefX = 6378137;

function translationMatrix(x, y, z) {
    return [
        1, 0, 0, 0,
        0, 1, 0, 0,
        0, 0, 1, 0,
        x, y, z, 1
    ];
}

function deg2rad(deg) {
    return deg * Math.PI / 180;
}

function lngLatAltToEcefArray(lng, lat, alt = 0) {
    const a = 6378137.0;
    const e2 = 0.00669437999014;
    const radLat = deg2rad(lat);
    const radLng = deg2rad(lng);
    const sinLat = Math.sin(radLat);
    const n = a / Math.sqrt(1 - e2 * sinLat * sinLat);

    return [
        (n + alt) * Math.cos(radLat) * Math.cos(radLng),
        (n + alt) * Math.cos(radLat) * Math.sin(radLng),
        (n * (1 - e2) + alt) * sinLat
    ];
}

class FakeXMLHttpRequest {
    constructor() {
        this.status = 200;
        this.response = null;
        this.responseText = '';
        this.responseType = '';
        this._listeners = {};
        this._requestHeaders = {};
    }

    open(method, url) {
        this.method = method;
        this.url = url;
    }

    setRequestHeader(header, value) {
        this._requestHeaders[header] = value;
    }

    send() {}

    addEventListener(type, listener) {
        if (!this._listeners[type]) this._listeners[type] = [];
        this._listeners[type].push(listener);
    }

    dispatchLoad() {
        const event = { type: 'load', target: this };
        (this._listeners.load || []).forEach(listener => listener.call(this, event));
        if (typeof this.onload === 'function') this.onload(event);
    }
}

function createManualTimers() {
    let nextId = 1;
    const timeouts = new Map();
    const intervals = new Map();

    return {
        timeouts,
        intervals,
        setTimeout(callback, delay, ...args) {
            const id = nextId++;
            timeouts.set(id, { callback, delay, args });
            return id;
        },
        clearTimeout(id) {
            timeouts.delete(id);
        },
        setInterval(callback, delay, ...args) {
            const id = nextId++;
            intervals.set(id, { callback, delay, args });
            return id;
        },
        clearInterval(id) {
            intervals.delete(id);
        },
        runNextTimeout() {
            const entry = timeouts.entries().next();
            if (entry.done) return false;
            const [id, timer] = entry.value;
            timeouts.delete(id);
            timer.callback(...timer.args);
            return true;
        },
        runIntervals() {
            Array.from(intervals.values()).forEach(timer => timer.callback(...timer.args));
        }
    };
}

function createSandbox(options = {}) {
    const timers = options.timers || {};
    const document = {
        body: { children: [] },
        currentScript: { src: 'chrome-extension://dashboard-extend/feature_PCExport.js' },
        title: 'Performance Harness',
        createElement: () => ({ style: {}, click() {} }),
        head: { appendChild() {} },
        documentElement: { appendChild() {} }
    };

    const window = {
        location: {
            href: 'https://dashboard.smartconstruction.com/projects/harness',
            origin: 'https://dashboard.smartconstruction.com'
        },
        getComputedStyle(node) {
            return { display: node && node.style ? node.style.display || '' : '' };
        },
        fetch: options.fetch || (async () => {
            throw new Error('Network access is disabled in the performance harness.');
        })
    };
    window.window = window;
    window.document = document;

    const sandbox = {
        window,
        document,
        XMLHttpRequest: FakeXMLHttpRequest,
        Headers: globalThis.Headers,
        Request: globalThis.Request,
        Response: globalThis.Response,
        TextDecoder: globalThis.TextDecoder,
        TextEncoder: globalThis.TextEncoder,
        URL: globalThis.URL,
        Blob: class FakeBlob {},
        Worker: class FakeWorker {},
        console,
        alert(message) {
            throw new Error(`Unexpected alert: ${message}`);
        },
        prompt() {
            return null;
        },
        setInterval: timers.setInterval || setInterval,
        clearInterval: timers.clearInterval || clearInterval,
        setTimeout: timers.setTimeout || setTimeout,
        clearTimeout: timers.clearTimeout || clearTimeout
    };

    sandbox.globalThis = sandbox;
    return sandbox;
}

function runFileInSandbox(sandbox, fileName) {
    const filePath = path.join(repoRoot, fileName);
    const code = fs.readFileSync(filePath, 'utf8');
    vm.runInContext(code, sandbox, { filename: fileName });
}

function loadExtension(options = {}) {
    const sandbox = createSandbox(options);
    vm.createContext(sandbox);
    runFileInSandbox(sandbox, 'core.js');

    if (options.withPcExport) {
        sandbox.window.DashboardExtend.UI = {
            buttons: [],
            registerButton(id, text, onClickCallback) {
                this.buttons.push({ id, text, onClickCallback });
            }
        };
        runFileInSandbox(sandbox, 'feature_PCExport.js');
    }

    if (options.withMeasurementsToolbar) {
        runFileInSandbox(sandbox, 'feature_measurementsToolbar.js');
    }

    return {
        sandbox,
        dashboard: sandbox.window.DashboardExtend
    };
}

function registerTinyTileset(tileCapture, transform) {
    const tileset = {
        root: {
            transform,
            content: {
                uri: 'tiles/tiny.pnts'
            }
        }
    };

    tileCapture.interceptTilesetJson(
        'https://example.com/model/tileset.json?token=abc#ignored',
        JSON.stringify(tileset)
    );
}

function decodeTinyTile(dashboard, options = {}) {
    const transform = options.transform || translationMatrix(equatorEcefX, 0, 0);
    const pntsOptions = {};
    if (options.positions) pntsOptions.positions = options.positions;
    if (options.rtcCenter) pntsOptions.rtcCenter = options.rtcCenter;

    const tileCapture = dashboard.testHooks.tileCapture;
    registerTinyTileset(tileCapture, transform);
    tileCapture.parseAndExtractPnts(buildTinyPnts(pntsOptions), tinyTileUrl);
    return dashboard.state.cachedTiles[0];
}

function workerReadyTile(tile) {
    return {
        url: tile.url,
        tileKey: tile.tileKey,
        positions: Array.from(tile.positions),
        combineSurveys: tile.combineSurveys ? Array.from(tile.combineSurveys) : null,
        length: tile.length,
        rtcCenter: Array.from(tile.rtcCenter),
        positionEncoding: tile.positionEncoding,
        transform: tile.transform ? Array.from(tile.transform) : null,
        transformSource: tile.transformSource,
        transformMatchedKey: tile.transformMatchedKey
    };
}

async function runExportWorker(dashboard, payload, options = {}) {
    const messages = [];
    const workerSandbox = {
        self: {
            postMessage(message) {
                messages.push(message);
            }
        },
        console,
        importScripts() {},
        fetch: options.fetch,
        proj4: options.proj4
    };
    workerSandbox.globalThis = workerSandbox;

    vm.createContext(workerSandbox);
    vm.runInContext(
        dashboard.testHooks.pcExport.createExportWorkerCode(),
        workerSandbox,
        { filename: 'pc-export-worker.js' }
    );

    await workerSandbox.self.onmessage({ data: payload });
    const result = messages.find(message => !message.status);
    assert.ok(result, 'worker posted a final result');
    return result;
}

function baseExportPayload(tile, overrides = {}) {
    const transform = translationMatrix(equatorEcefX, 0, 0);

    return {
        cachedTiles: [workerReadyTile(tile)],
        polygonBoundary: [
            [-0.00005, -0.00005],
            [0.00005, -0.00005],
            [0.00005, 0.00005],
            [-0.00005, 0.00005]
        ],
        clipMode: 'wgs84',
        globalTransformMatrix: transform,
        activeLocalGrid: null,
        exportFormat: 'csv',
        gridSize: 1,
        extensionResourceBase: '',
        ...overrides
    };
}

const tests = [];

function test(name, fn) {
    tests.push({ name, fn });
}

function fetchInputUrl(input) {
    if (typeof input === 'string') return input;
    if (input && typeof input.url === 'string') return input.url;
    return String(input || '');
}

function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitFor(assertion, timeoutMs = 1000) {
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
        try {
            assertion();
            return;
        } catch (error) {
            await wait(0);
        }
    }

    assertion();
}

function createFakeNode(tagName, options = {}) {
    const attributes = { ...(options.attributes || {}) };
    if (options.className) attributes.class = options.className;

    const node = {
        tagName,
        id: options.id || '',
        className: attributes.class || '',
        hidden: Object.prototype.hasOwnProperty.call(attributes, 'hidden'),
        style: {},
        children: [],
        childNodes: [],
        parentNode: null,
        parentElement: null,
        shadowRoot: null,
        innerText: options.text || '',
        textContent: options.text || '',
        isConnected: false,
        clickCount: 0,
        classList: {
            contains(name) {
                return String(node.className || '').split(/\s+/).indexOf(name) !== -1;
            },
            add(name) {
                const classes = String(node.className || '').split(/\s+/).filter(Boolean);
                if (classes.indexOf(name) === -1) classes.push(name);
                node.className = classes.join(' ');
                attributes.class = node.className;
            },
            remove(name) {
                const classes = String(node.className || '').split(/\s+/).filter(value => value && value !== name);
                node.className = classes.join(' ');
                if (node.className) attributes.class = node.className;
                else delete attributes.class;
            }
        },
        getAttribute(name) {
            return Object.prototype.hasOwnProperty.call(attributes, name) ? attributes[name] : null;
        },
        hasAttribute(name) {
            return Object.prototype.hasOwnProperty.call(attributes, name);
        },
        setAttribute(name, value) {
            attributes[name] = String(value);
            if (name === 'class') node.className = String(value);
            if (name === 'hidden') node.hidden = true;
        },
        removeAttribute(name) {
            delete attributes[name];
            if (name === 'class') node.className = '';
            if (name === 'hidden') node.hidden = false;
        },
        appendChild(child) {
            return appendFakeChild(this, child);
        },
        click() {
            this.clickCount++;
        },
        getRootNode() {
            let current = this;
            while (current.parentNode) current = current.parentNode;
            return current;
        }
    };

    return node;
}

function setFakeConnected(node, isConnected) {
    if (!node) return;
    node.isConnected = isConnected;
    (node.children || []).forEach(child => setFakeConnected(child, isConnected));
    if (node.shadowRoot) setFakeConnected(node.shadowRoot, isConnected);
}

function appendFakeChild(parent, child) {
    if (!parent.children) parent.children = [];
    parent.children.push(child);
    parent.childNodes = parent.children;
    child.parentNode = parent;
    child.parentElement = parent.tagName === '#SHADOW-ROOT' ? parent.host : parent;
    setFakeConnected(child, parent.isConnected === true);
    return child;
}

function attachFakeShadow(host) {
    const shadow = createFakeNode('#SHADOW-ROOT');
    shadow.host = host;
    shadow.parentNode = host;
    shadow.parentElement = host;
    host.shadowRoot = shadow;
    setFakeConnected(shadow, host.isConnected === true);
    return shadow;
}

function resetFakeBody(document) {
    const body = createFakeNode('BODY');
    body.isConnected = true;
    document.body = body;
    return body;
}

test('host DOM adapter traverses shadow roots and invalidates cached dashboard nodes', () => {
    const { sandbox, dashboard } = loadExtension();
    const body = resetFakeBody(sandbox.document);
    const shell = appendFakeChild(body, createFakeNode('SC-SHELL'));
    const shellShadow = attachFakeShadow(shell);
    const firstDetail = appendFakeChild(shellShadow, createFakeNode('SC-ANNOTATION-DETAIL', { text: 'First polygon' }));

    assert.equal(dashboard.hostDom.getAnnotationDetail(), firstDetail);
    const generationBefore = dashboard.hostDom.getCacheStats().generation;

    const replacementDetail = createFakeNode('SC-ANNOTATION-DETAIL', { text: 'Replacement polygon' });
    setFakeConnected(firstDetail, false);
    firstDetail.parentNode = null;
    firstDetail.parentElement = null;
    shellShadow.children = [replacementDetail];
    shellShadow.childNodes = shellShadow.children;
    replacementDetail.parentNode = shellShadow;
    replacementDetail.parentElement = shell;
    setFakeConnected(replacementDetail, true);

    dashboard.hostDom.invalidateCache();

    assert.equal(dashboard.hostDom.getCacheStats().generation, generationBefore + 1);
    assert.equal(dashboard.hostDom.getAnnotationDetail(), replacementDetail);
});

test('host DOM adapter exposes export metadata, polygon coordinates, layer toggles, and calibration', () => {
    const { sandbox, dashboard } = loadExtension();
    const body = resetFakeBody(sandbox.document);
    const shell = appendFakeChild(body, createFakeNode('SC-SHELL'));
    const shellShadow = attachFakeShadow(shell);

    const nav = appendFakeChild(shellShadow, createFakeNode('SC-PROJECT-VIEWER-NAV'));
    const navHeading = appendFakeChild(nav, createFakeNode('H3'));
    appendFakeChild(navHeading, createFakeNode('SPAN', { text: 'Project' }));
    appendFakeChild(navHeading, createFakeNode('SPAN', { text: 'North Yard' }));

    const detail = appendFakeChild(shellShadow, createFakeNode('SC-ANNOTATION-DETAIL'));
    appendFakeChild(detail, createFakeNode('H3', { text: 'Stockpile Alpha' }));

    const timeline = appendFakeChild(shellShadow, createFakeNode('CESIUM-TIMELINE'));
    appendFakeChild(timeline, createFakeNode('DIV', { text: '2 July, 2026' }));

    const vertices = [
        { lng: 4.1, lat: 50.8 },
        { lng: 4.2, lat: 50.8 },
        { lng: 4.2, lat: 50.9 }
    ];
    const editor = appendFakeChild(shellShadow, createFakeNode('SC-BASIC-ANNOTATION-EDITOR'));
    editor._annotationState = { vertices };

    const tab = appendFakeChild(body, createFakeNode('SC-TAB'));
    appendFakeChild(tab, createFakeNode('PATH', { attributes: { d: 'M264.5 0 0' } }));

    const asBuiltLayer = appendFakeChild(body, createFakeNode('SC-AS-BUILT-LAYER'));
    const asBuiltToggle = appendFakeChild(attachFakeShadow(asBuiltLayer), createFakeNode('SC-SHOW-TOGGLE'));
    const asBuiltButton = appendFakeChild(asBuiltToggle, createFakeNode('BUTTON'));

    const surveyLayer = appendFakeChild(body, createFakeNode('SC-SURVEY-LAYER'));
    const surveyToggle = appendFakeChild(attachFakeShadow(surveyLayer), createFakeNode('SC-SHOW-TOGGLE'));
    const surveyButton = appendFakeChild(surveyToggle, createFakeNode('BUTTON'));

    function addCalibration(label, text) {
        appendFakeChild(shellShadow, createFakeNode('SPAN', {
            text,
            attributes: { 'data-label': label }
        }));
    }

    addCalibration('Coordinate system', 'Local grid');
    addCalibration('Projection type', 'Transverse Mercator');
    addCalibration('Rotation', '12.5');
    addCalibration('Origin easting', '1,234.50');
    addCalibration('Origin northing', '2 345,75');
    addCalibration('Origin latitude', '50.8');
    addCalibration('Origin longitude', '4.1');
    addCalibration('Scale factor', '1.0002');
    addCalibration('Vertical shift', '3.5');

    const hostDom = dashboard.hostDom;
    assert.equal(hostDom.getProjectName(), 'North Yard');
    assert.equal(hostDom.getPolygonName(), 'Stockpile Alpha');
    assert.equal(hostDom.getTimelineDate(), '2 July, 2026');
    assert.deepEqual(hostDom.getPolygonCoordinates(), vertices);
    assert.equal(hostDom.getDataLayersTab(), tab);
    const layerToggles = hostDom.getPointCloudLayerToggles();
    assert.equal(layerToggles.length, 2);
    assert.equal(layerToggles[0], asBuiltButton);
    assert.equal(layerToggles[1], surveyButton);

    const calibration = hostDom.getCalibrationData();
    assert.equal(calibration.activeEpsg, null);
    assert.equal(calibration.coordinateSystemLabel, 'Local grid');
    assert.equal(calibration.activeLocalGrid.projType, 'Transverse Mercator');
    assert.equal(calibration.activeLocalGrid.rotation, 12.5);
    assert.equal(calibration.activeLocalGrid.originEasting, 1234.5);
    assert.equal(calibration.activeLocalGrid.originNorthing, 2345.75);
    assert.equal(calibration.activeLocalGrid.originLat, 50.8);
    assert.equal(calibration.activeLocalGrid.originLng, 4.1);
    assert.equal(calibration.activeLocalGrid.scaleFactor, 1.0002);
    assert.equal(calibration.activeLocalGrid.verticalShift, 3.5);
});

test('host DOM adapter recognizes EPSG projection labels without a colon', () => {
    const { sandbox, dashboard } = loadExtension();
    const body = resetFakeBody(sandbox.document);
    const shell = appendFakeChild(body, createFakeNode('SC-SHELL'));
    const shellShadow = attachFakeShadow(shell);

    appendFakeChild(shellShadow, createFakeNode('SPAN', {
        text: 'Belgian Lambert 72 EPSG 31370',
        attributes: { 'data-label': 'Coordinate system' }
    }));

    const calibration = dashboard.hostDom.getCalibrationData();
    assert.equal(calibration.activeEpsg, 'EPSG:31370');
    assert.equal(calibration.activeLocalGrid, null);
    assert.equal(calibration.coordinateSystemLabel, 'Belgian Lambert 72 EPSG 31370');
});

test('point cloud export treats planar active EPSG cartesian polygon as projected', () => {
    const { sandbox, dashboard } = loadExtension({ withPcExport: true });
    const body = resetFakeBody(sandbox.document);
    const shell = appendFakeChild(body, createFakeNode('SC-SHELL'));
    const shellShadow = attachFakeShadow(shell);

    const vertices = [
        { x: 2603158.2459154516, y: 5691667.454321914, z: 0 },
        { x: 2603166.705254413, y: 5691667.454321914, z: 0 },
        { x: 2603166.705254413, y: 5691684.853699058, z: 0 },
        { x: 2603158.2459154516, y: 5691684.853699058, z: 0 }
    ];
    const editor = appendFakeChild(shellShadow, createFakeNode('SC-BASIC-ANNOTATION-EDITOR'));
    editor._annotationState = { vertices };

    const polygonData = dashboard.testHooks.pcExport.extractPolygonData({
        activeEpsg: 'EPSG:31466',
        coordinateSystemLabel: 'EPSG:31466 / DHDN / 3-degree Gauss-Kruger zone 2'
    });

    assert.equal(polygonData.mode, 'projected');
    assert.equal(JSON.stringify(polygonData.boundary), JSON.stringify(vertices.map(vertex => [vertex.x, vertex.y])));
});

test('DXF export settings validate Fast Mesh grid size and reserve TIN mode', () => {
    const { dashboard } = loadExtension({ withPcExport: true });
    const validate = dashboard.testHooks.pcExport.validateDxfExportSettings;
    const fastMesh = validate({ exportType: 'fast-mesh', gridSize: '2.5' });
    const invalidGrid = validate({ exportType: 'fast-mesh', gridSize: '0' });
    const partialGrid = validate({ exportType: 'fast-mesh', gridSize: '1abc' });
    const tinSurface = validate({ exportType: 'tin-surface', gridSize: '1' });

    assert.equal(fastMesh.ok, true);
    assert.equal(fastMesh.exportFormat, 'dxf-mesh');
    assert.equal(fastMesh.exportType, 'fast-mesh');
    assert.equal(fastMesh.gridSize, 2.5);

    assert.equal(invalidGrid.ok, false);
    assert.equal(invalidGrid.error, 'Grid size must be a number greater than 0.');
    assert.equal(partialGrid.ok, false);
    assert.equal(partialGrid.error, 'Grid size must be a number greater than 0.');

    assert.equal(tinSurface.ok, false);
    assert.equal(tinSurface.error, 'TIN Surface is not available yet. Use Fast Mesh for this export.');
});

test('DXF button opens modal, validates inline, and reports setup errors without prompt', async () => {
    const { sandbox, dashboard } = loadExtension({ withPcExport: true });
    sandbox.document.createElement = tagName => createFakeNode(String(tagName).toUpperCase());
    const body = resetFakeBody(sandbox.document);

    appendFakeChild(body, createFakeNode('SPAN', {
        text: 'Belgian Lambert 72 EPSG 31370',
        attributes: { 'data-label': 'Coordinate system' }
    }));

    dashboard.state.cachedTiles = [{ length: 12 }, { length: 8 }];
    dashboard.state.totalPointsHarvested = 20;

    let promptCalled = false;
    sandbox.prompt = () => {
        promptCalled = true;
        return '5';
    };

    const dxfButtonConfig = sandbox.window.DashboardExtend.UI.buttons.find(button => button.id === 'sc-dashboardextend-dxf-btn');
    assert.ok(dxfButtonConfig, 'DXF button is registered');

    const btn = createFakeNode('BUTTON', { text: 'Export Selected Pointcloud (.dxf)' });
    dxfButtonConfig.onClickCallback(btn);

    assert.equal(promptCalled, false);

    const modal = dashboard.hostDom.findDeepNode(node => node.id === 'sc-dashboardextend-dxf-modal', body);
    assert.ok(modal, 'DXF modal is appended to the document');

    const exportType = dashboard.hostDom.findDeepNode(node => node.id === 'sc-dashboardextend-dxf-export-type', modal);
    const gridInput = dashboard.hostDom.findDeepNode(node => node.id === 'sc-dashboardextend-dxf-grid-size', modal);
    const projection = dashboard.hostDom.findDeepNode(node => node.id === 'sc-dashboardextend-dxf-projection', modal);
    const pointCount = dashboard.hostDom.findDeepNode(node => node.id === 'sc-dashboardextend-dxf-point-count', modal);
    const submit = dashboard.hostDom.findDeepNode(node => node.id === 'sc-dashboardextend-dxf-submit', modal);
    const error = dashboard.hostDom.findDeepNode(node => node.id === 'sc-dashboardextend-dxf-error', modal);

    assert.equal(exportType.children[0].textContent, 'Fast Mesh - averaged grid cells');
    assert.equal(exportType.children[1].textContent, 'TIN Surface - coming later');
    assert.equal(exportType.children[1].disabled, true);
    assert.equal(gridInput.value, '1.0');
    assert.equal(projection.value, 'EPSG:31370 - Belgian Lambert 72 EPSG 31370');
    assert.equal(pointCount.value, '20 captured points');

    gridInput.value = '0';
    assert.equal(submit.onclick(), false);
    assert.equal(error.textContent, 'Grid size must be a number greater than 0.');
    assert.equal(error.style.display, 'block');

    gridInput.value = '2.5';
    await submit.onclick();

    assert.equal(promptCalled, false);
    assert.match(error.textContent, /Missing Global Matrix/);
    assert.equal(error.style.display, 'block');
    assert.equal(submit.disabled, false);
});

test('measurements toolbar injects once beside drawing guides and mirrors visibility through hostDom', () => {
    const timers = createManualTimers();
    const { sandbox, dashboard } = loadExtension({
        withMeasurementsToolbar: true,
        timers
    });
    sandbox.document.createElement = tagName => createFakeNode(String(tagName).toUpperCase());

    const body = resetFakeBody(sandbox.document);
    const shell = appendFakeChild(body, createFakeNode('SC-SHELL'));
    const shellShadow = attachFakeShadow(shell);
    const panels = appendFakeChild(shellShadow, createFakeNode('DIV', { className: 'panels' }));
    const guides = appendFakeChild(panels, createFakeNode('SC-DRAWING-GUIDES'));
    const toolbarHooks = dashboard.testHooks.measurementsToolbar;

    assert.equal(timers.timeouts.size, 1);
    assert.equal(timers.intervals.size, 0);
    assert.equal(dashboard.hostDom.getDrawingGuides(), guides);
    assert.equal(dashboard.hostDom.getDrawingGuidesPanel(), panels);

    assert.equal(toolbarHooks.syncMeasurementsToolbar(), true);
    let toolbars = dashboard.hostDom.findAllDeepNodes(n => n.tagName === 'SC-SIMPLEMEASUREMENTS-TOOLBAR', panels);
    assert.equal(toolbars.length, 1);
    assert.equal(toolbars[0].parentElement, panels);
    assert.equal(toolbars[0].style.display, '');

    assert.equal(toolbarHooks.syncMeasurementsToolbar(), true);
    toolbars = dashboard.hostDom.findAllDeepNodes(n => n.tagName === 'SC-SIMPLEMEASUREMENTS-TOOLBAR', panels);
    assert.equal(toolbars.length, 1);

    guides.setAttribute('hidden', '');
    dashboard.hostDom.invalidateCache();
    assert.equal(toolbarHooks.syncMeasurementsToolbar(), true);
    assert.equal(toolbars[0].style.display, 'none');

    guides.removeAttribute('hidden');
    guides.style.display = '';
    dashboard.hostDom.invalidateCache();
    assert.equal(toolbarHooks.syncMeasurementsToolbar(), true);
    assert.equal(toolbars[0].style.display, '');

    guides.style.display = 'none';
    dashboard.hostDom.invalidateCache();
    assert.equal(toolbarHooks.syncMeasurementsToolbar(), true);
    assert.equal(toolbars[0].style.display, 'none');

    assert.equal(timers.runNextTimeout(), true);
    assert.equal(timers.intervals.size, 0);
    toolbarHooks.stopMeasurementsToolbarSync();
});

test('capture session refreshes layers and finishes after quiet tile-capture progress', () => {
    const timers = createManualTimers();
    const { dashboard } = loadExtension({
        withPcExport: true,
        timers
    });
    const tab = createFakeNode('SC-TAB');
    const asBuiltToggle = createFakeNode('BUTTON');
    const surveyToggle = createFakeNode('BUTTON');
    const btn = createFakeNode('BUTTON', { text: 'Export' });
    const statuses = [];
    const alerts = [];
    let readyTiming = null;

    btn.disabled = true;
    dashboard.state.cachedTiles = [];
    dashboard.state.totalPointsHarvested = 0;
    dashboard.state.pointDecodeStats = {
        decodedTiles: 0,
        decodedPoints: 0,
        duplicateTiles: 0,
        duplicatePoints: 0,
        skippedTiles: 0,
        skippedPoints: 0
    };

    const session = dashboard.testHooks.pcExport.createCaptureSession({
        hostDom: {
            getDataLayersTab: () => tab,
            getPointCloudLayerToggles: () => [asBuiltToggle, surveyToggle]
        },
        state: dashboard.state,
        btnEl: btn,
        originalText: 'Export',
        pollIntervalMs: 10,
        minListenMs: 30,
        stableThresholdMs: 20,
        maxListenMs: 100,
        layerDiscoveryDelayMs: 1,
        layerRefreshDelayMs: 1,
        alertFn: message => alerts.push(message),
        onStatus: status => statuses.push(status),
        onCaptureReady: timing => {
            readyTiming = timing;
        }
    });

    session.start();
    assert.equal(tab.clickCount, 1);
    assert.equal(btn.innerText, '⏳ Auto-Reloading Data Layers...');

    assert.equal(timers.runNextTimeout(), true);
    assert.equal(asBuiltToggle.clickCount, 1);
    assert.equal(surveyToggle.clickCount, 1);

    assert.equal(timers.runNextTimeout(), true);
    assert.equal(asBuiltToggle.clickCount, 2);
    assert.equal(surveyToggle.clickCount, 2);
    assert.equal(timers.intervals.size, 1);
    assert.equal(btn.innerText, '⏳ Listening for Data...');

    timers.runIntervals();
    assert.equal(readyTiming, null);

    dashboard.state.cachedTiles.push({ length: 2 });
    dashboard.state.totalPointsHarvested = 2;
    dashboard.state.pointDecodeStats.decodedTiles = 1;
    dashboard.state.pointDecodeStats.decodedPoints = 2;

    timers.runIntervals();
    timers.runIntervals();
    assert.equal(readyTiming, null);
    assert.equal(session.getTiming().stableSeconds, 0.01);

    dashboard.state.pointDecodeStats.duplicateTiles = 1;
    dashboard.state.pointDecodeStats.duplicatePoints = 2;
    timers.runIntervals();
    assert.equal(readyTiming, null);
    assert.equal(session.getTiming().stableSeconds, 0);

    timers.runIntervals();
    timers.runIntervals();

    assert.ok(readyTiming, 'capture session launched export');
    assert.equal(readyTiming.finishReason, 'quiet-period');
    assert.equal(readyTiming.timedOut, false);
    assert.equal(readyTiming.elapsedListenSeconds, 0.06);
    assert.equal(readyTiming.stableSeconds, 0.02);
    assert.equal(readyTiming.minListenSeconds, 0.03);
    assert.equal(readyTiming.stableSecondsRequired, 0.02);
    assert.equal(readyTiming.stableThresholdSeconds, 0.02);
    assert.equal(readyTiming.maxListenSeconds, 0.1);
    assert.deepEqual(JSON.parse(JSON.stringify(readyTiming.latestProgress)), {
        pointCount: 2,
        tileCount: 1,
        decodedTiles: 1,
        decodedPoints: 2,
        duplicateTiles: 1,
        duplicatePoints: 2,
        skippedTiles: 0,
        skippedPoints: 0,
        tilesetCount: 0
    });
    assert.equal(btn.innerText, '⚙️ Crunching Math (Background)...');
    assert.equal(timers.intervals.size, 0);
    assert.deepEqual(alerts, []);
    assert.deepEqual(statuses, [
        '⏳ Auto-Reloading Data Layers...',
        '⏳ Listening for Data...',
        '⚙️ Crunching Math (Background)...'
    ]);
});

test('capture session times out without data and restores export button state', () => {
    const timers = createManualTimers();
    const { dashboard } = loadExtension({
        withPcExport: true,
        timers
    });
    const tab = createFakeNode('SC-TAB');
    const toggle = createFakeNode('BUTTON');
    const btn = createFakeNode('BUTTON', { text: 'Export' });
    const alerts = [];
    let timeoutTiming = null;

    btn.disabled = true;
    dashboard.state.cachedTiles = [];
    dashboard.state.totalPointsHarvested = 0;
    dashboard.state.pointDecodeStats = {
        decodedTiles: 0,
        decodedPoints: 0,
        duplicateTiles: 0,
        duplicatePoints: 0,
        skippedTiles: 0,
        skippedPoints: 0
    };

    const session = dashboard.testHooks.pcExport.createCaptureSession({
        hostDom: {
            getDataLayersTab: () => tab,
            getPointCloudLayerToggles: () => [toggle]
        },
        state: dashboard.state,
        btnEl: btn,
        originalText: 'Export',
        pollIntervalMs: 10,
        minListenMs: 30,
        stableThresholdMs: 20,
        maxListenMs: 30,
        layerDiscoveryDelayMs: 1,
        layerRefreshDelayMs: 1,
        alertFn: message => alerts.push(message),
        onTimeout: timing => {
            timeoutTiming = timing;
        }
    });

    session.start();
    assert.equal(timers.runNextTimeout(), true);
    assert.equal(timers.runNextTimeout(), true);
    assert.equal(timers.intervals.size, 1);

    timers.runIntervals();
    timers.runIntervals();
    assert.equal(timeoutTiming, null);

    timers.runIntervals();

    assert.ok(timeoutTiming, 'capture session reported timeout');
    assert.equal(timeoutTiming.finishReason, 'no-data-timeout');
    assert.equal(timeoutTiming.timedOut, true);
    assert.equal(timeoutTiming.elapsedListenSeconds, 0.03);
    assert.equal(timeoutTiming.stableSeconds, 0);
    assert.equal(btn.innerText, 'Export');
    assert.equal(btn.disabled, false);
    assert.equal(timers.intervals.size, 0);
    assert.deepEqual(alerts, ['Timeout: No data intercepted!']);
});

test('tile identity strips fragments while preserving query strings', () => {
    const { dashboard } = loadExtension();
    const tileCapture = dashboard.testHooks.tileCapture;

    assert.equal(
        tileCapture.canonicalTileKey('https://example.com/model/tile.pnts?sig=1#first'),
        'https://example.com/model/tile.pnts?sig=1'
    );
    assert.notEqual(
        tileCapture.canonicalTileKey('https://example.com/model/tile.pnts?sig=1'),
        tileCapture.canonicalTileKey('https://example.com/model/tile.pnts?sig=2')
    );
    assert.equal(
        tileCapture.canonicalTileKey('tiles/tile.pnts#fragment', 'https://example.com/model/tileset.json'),
        'https://example.com/model/tiles/tile.pnts'
    );
});

test('tiny PNTS tile decodes once, tracks duplicates, and keeps the tileset transform', () => {
    const { dashboard } = loadExtension();
    const tileCapture = dashboard.testHooks.tileCapture;
    const transform = translationMatrix(equatorEcefX, 0, 0);

    registerTinyTileset(tileCapture, transform);
    const pnts = buildTinyPnts();
    tileCapture.parseAndExtractPnts(pnts, tinyTileUrl);
    tileCapture.parseAndExtractPnts(pnts, tinyTileUrl.replace('#first', '#second'));

    const state = dashboard.state;
    const tile = state.cachedTiles[0];
    assert.equal(state.cachedTiles.length, 1);
    assert.equal(state.totalPointsHarvested, 2);
    assert.equal(state.pointDecodeStats.decodedTiles, 1);
    assert.equal(state.pointDecodeStats.decodedPoints, 2);
    assert.equal(state.pointDecodeStats.duplicateTiles, 1);
    assert.equal(state.pointDecodeStats.duplicatePoints, 2);
    assert.equal(tile.length, 2);
    assert.equal(tile.positionEncoding, 'POSITION');
    assert.equal(tile.transformSource, 'tileset-content');
    assert.deepEqual(Array.from(tile.transform), transform);
    assert.equal(state.transformLookupHitSamples.length, 1);
    assert.equal(state.transformLookupMissSamples.length, 0);
});

test('fetch capture inspects cloned responses without duplicate network requests', async () => {
    const transform = translationMatrix(equatorEcefX, 0, 0);
    const tilesetUrl = 'https://example.com/model/tileset.json?token=abc#ignored';
    const duplicateTinyTileUrl = tinyTileUrl.replace('#first', '#second');
    const tilesetBody = JSON.stringify({
        root: {
            transform,
            content: {
                uri: 'tiles/tiny.pnts'
            }
        }
    });
    const pntsBuffer = buildTinyPnts();
    const fetchCallUrls = [];

    const { sandbox, dashboard } = loadExtension({
        fetch: async input => {
            const url = fetchInputUrl(input);
            fetchCallUrls.push(url);

            if (url.toLowerCase().includes('tileset.json')) {
                return new Response(tilesetBody, { status: 200 });
            }

            if (url.toLowerCase().includes('.pnts')) {
                return new Response(pntsBuffer.slice(0), { status: 200 });
            }

            return new Response('', { status: 404 });
        }
    });

    const tilesetResponse = await sandbox.window.fetch(tilesetUrl);
    assert.equal(await tilesetResponse.text(), tilesetBody);

    const tileResponse = await sandbox.window.fetch(tinyTileUrl);
    assert.equal((await tileResponse.arrayBuffer()).byteLength, pntsBuffer.byteLength);

    const duplicateTileResponse = await sandbox.window.fetch(duplicateTinyTileUrl);
    assert.equal((await duplicateTileResponse.arrayBuffer()).byteLength, pntsBuffer.byteLength);

    await waitFor(() => {
        assert.deepEqual(Array.from(dashboard.state.globalTransformMatrix), transform);
        assert.equal(dashboard.state.cachedTiles.length, 1);
        assert.equal(dashboard.state.pointDecodeStats.decodedTiles, 1);
        assert.equal(dashboard.state.pointDecodeStats.duplicateTiles, 1);
    });

    const tile = dashboard.state.cachedTiles[0];
    assert.deepEqual(fetchCallUrls, [tilesetUrl, tinyTileUrl, duplicateTinyTileUrl]);
    assert.equal(dashboard.state.totalPointsHarvested, 2);
    assert.equal(dashboard.state.pointDecodeStats.duplicatePoints, 2);
    assert.equal(tile.transformSource, 'tileset-content');
    assert.deepEqual(Array.from(tile.transform), transform);
    assert.equal(dashboard.state.transformLookupHitSamples.length, 1);
    assert.equal(dashboard.state.transformLookupMissSamples.length, 0);
});

test('XHR capture inspects loaded responses without probe fetches', async () => {
    const transform = translationMatrix(equatorEcefX, 0, 0);
    const tilesetUrl = 'https://example.com/model/tileset.json?token=abc#ignored';
    const duplicateTinyTileUrl = tinyTileUrl.replace('#first', '#second');
    const tilesetBody = JSON.stringify({
        root: {
            transform,
            content: {
                uri: 'tiles/tiny.pnts'
            }
        }
    });
    const pntsBuffer = buildTinyPnts();
    const fetchCallUrls = [];

    const { sandbox, dashboard } = loadExtension({
        fetch: async input => {
            const url = fetchInputUrl(input);
            fetchCallUrls.push(url);

            if (url.toLowerCase().includes('.pnts')) {
                return new Response(pntsBuffer.slice(0), { status: 200 });
            }

            return new Response('', { status: 404 });
        }
    });

    const tilesetXhr = new sandbox.XMLHttpRequest();
    tilesetXhr.open('GET', tilesetUrl);
    tilesetXhr.setRequestHeader('Authorization', 'Bearer xhr-token');
    tilesetXhr.response = tilesetBody;
    tilesetXhr.responseText = tilesetBody;
    tilesetXhr.send();
    tilesetXhr.dispatchLoad();

    const tileXhr = new sandbox.XMLHttpRequest();
    tileXhr.open('GET', tinyTileUrl);
    tileXhr.responseType = 'arraybuffer';
    tileXhr.response = pntsBuffer.slice(0);
    tileXhr.send();
    tileXhr.dispatchLoad();

    await waitFor(() => {
        assert.deepEqual(Array.from(dashboard.state.globalTransformMatrix), transform);
        assert.equal(dashboard.state.cachedTiles.length, 1);
        assert.equal(dashboard.state.pointDecodeStats.decodedTiles, 1);
    });

    assert.deepEqual(fetchCallUrls, []);
    assert.equal(dashboard.state.globalAuthToken, 'Bearer xhr-token');

    const duplicateTileResponse = await sandbox.window.fetch(duplicateTinyTileUrl);
    assert.equal((await duplicateTileResponse.arrayBuffer()).byteLength, pntsBuffer.byteLength);

    await waitFor(() => {
        assert.equal(dashboard.state.cachedTiles.length, 1);
        assert.equal(dashboard.state.pointDecodeStats.duplicateTiles, 1);
    });

    const tile = dashboard.state.cachedTiles[0];
    assert.deepEqual(fetchCallUrls, [duplicateTinyTileUrl]);
    assert.equal(dashboard.state.totalPointsHarvested, 2);
    assert.equal(dashboard.state.pointDecodeStats.duplicatePoints, 2);
    assert.equal(tile.transformSource, 'tileset-content');
    assert.deepEqual(Array.from(tile.transform), transform);
    assert.equal(dashboard.state.transformLookupHitSamples.length, 1);
    assert.equal(dashboard.state.transformLookupMissSamples.length, 0);
});

test('export worker clips WGS84 points and formats CSV output', async () => {
    const { dashboard } = loadExtension({ withPcExport: true });
    const tile = decodeTinyTile(dashboard);

    const result = await runExportWorker(dashboard, baseExportPayload(tile));

    assert.equal(result.clippedCount, 1);
    assert.equal(result.droppedCount, 0);
    assert.equal(result.rows, '0.000000,0.000000,0.0000');
    assert.equal(result.diagnostics.effectiveClipMode, 'wgs84');
    assert.equal(result.diagnostics.processedCount, 2);
    assert.equal(result.diagnostics.bboxCandidateCount, 1);
    assert.equal(result.diagnostics.polygonRange.minX, -0.00005);
    assert.equal(result.diagnostics.polygonRange.maxX, 0.00005);
    assert.equal(result.diagnostics.polygonRange.minY, -0.00005);
    assert.equal(result.diagnostics.polygonRange.maxY, 0.00005);
    assert.equal(result.diagnostics.transformSourceCounts['tileset-content'], 1);
});

test('export worker converts accepted points to active EPSG projection before CSV output', async () => {
    const { dashboard } = loadExtension({ withPcExport: true });
    const ecef = lngLatAltToEcefArray(4, 50);
    const tile = decodeTinyTile(dashboard, {
        transform: translationMatrix(ecef[0], ecef[1], ecef[2]),
        positions: [[0, 0, 0]]
    });
    const projectionCalls = [];

    const result = await runExportWorker(dashboard, baseExportPayload(tile, {
        polygonBoundary: [
            [3.9999, 49.9999],
            [4.0001, 49.9999],
            [4.0001, 50.0001],
            [3.9999, 50.0001]
        ],
        outputProjectionEpsg: 'EPSG:25832',
        coordinateConversionApiUrl: 'https://dashboard.smartconstruction.com/api/v1/convertCoordinates',
        coordinateConversionAuthToken: 'Bearer projection-token',
        projectionBatchSize: 1
    }), {
        fetch: async (url, request) => {
            const body = JSON.parse(request.body);
            projectionCalls.push({ url, request, body });

            return {
                ok: true,
                status: 200,
                async json() {
                    return {
                        coordinates: body.coordinates.map(() => [123456.789, 987654.321, 0])
                    };
                }
            };
        }
    });

    assert.equal(projectionCalls.length, 1);
    assert.equal(projectionCalls[0].url, 'https://dashboard.smartconstruction.com/api/v1/convertCoordinates');
    assert.equal(projectionCalls[0].body.from, 'EPSG:4326');
    assert.equal(projectionCalls[0].body.to, 'EPSG:25832');
    assert.equal(projectionCalls[0].body.coordinates.length, 1);
    assert.ok(Math.abs(projectionCalls[0].body.coordinates[0][0] - 4) < 1e-8);
    assert.ok(Math.abs(projectionCalls[0].body.coordinates[0][1] - 50) < 1e-8);
    assert.equal(projectionCalls[0].body.coordinates[0][2], 0);
    assert.equal(result.clippedCount, 1);
    assert.match(result.rows, /^123456\.789000,987654\.321000,-?0\.0000$/);
    assert.equal(result.diagnostics.outputProjectionEpsg, 'EPSG:25832');
    assert.equal(result.diagnostics.outputProjectionConvertedCount, 1);
    assert.equal(result.diagnostics.outputProjectionApiCallCount, 1);
});

test('export worker uses local proj4 fast path for EPSG UTM projection output', async () => {
    const { dashboard } = loadExtension({ withPcExport: true });
    const ecef = lngLatAltToEcefArray(4, 50);
    const tile = decodeTinyTile(dashboard, {
        transform: translationMatrix(ecef[0], ecef[1], ecef[2]),
        positions: [[0, 0, 0]]
    });
    const defs = {};
    const projectionCalls = [];
    const fakeProj4 = function(from, to, point) {
        projectionCalls.push({ from, to, point });
        if (to === 'EPSG:4326') return [4, 50, 0];
        return [point[0] * 1000, point[1] * 1000, point[2] || 0];
    };
    fakeProj4.defs = function(code, definition) {
        if (arguments.length === 1) return defs[code];
        defs[code] = definition;
        return definition;
    };

    const result = await runExportWorker(dashboard, baseExportPayload(tile, {
        polygonBoundary: [
            [3.9999, 49.9999],
            [4.0001, 49.9999],
            [4.0001, 50.0001],
            [3.9999, 50.0001]
        ],
        outputProjectionEpsg: 'EPSG:25832',
        outputProjectionLabel: 'EPSG:25832 / ETRS89 / UTM zone 32N',
        coordinateConversionApiUrl: 'https://dashboard.smartconstruction.com/api/v1/convertCoordinates',
        coordinateConversionAuthToken: 'Bearer projection-token'
    }), {
        proj4: fakeProj4,
        fetch: async () => {
            throw new Error('projection API should not be called for local UTM projection');
        }
    });

    assert.equal(defs['EPSG:25832'], '+proj=utm +zone=32 +ellps=GRS80 +units=m +no_defs');
    const outputProjectionCall = projectionCalls.find(call => call.to === 'EPSG:25832');
    assert.ok(outputProjectionCall);
    assert.equal(outputProjectionCall.from, 'EPSG:4326');
    assert.ok(Math.abs(outputProjectionCall.point[0] - 4) < 1e-8);
    assert.ok(Math.abs(outputProjectionCall.point[1] - 50) < 1e-8);
    assert.match(result.rows, /^4000\.000000,50000\.000000,-?0\.0000$/);
    assert.equal(result.diagnostics.outputProjectionMethod, 'proj4-local');
    assert.equal(result.diagnostics.outputProjectionConvertedCount, 1);
    assert.equal(result.diagnostics.outputProjectionApiCallCount, 0);
    assert.equal(result.diagnostics.outputProjectionLocalDef.kind, 'etrs89-utm');
});

test('export worker uses local proj4 fast path for EPSG DHDN Gauss-Kruger output', async () => {
    const { dashboard } = loadExtension({ withPcExport: true });
    const ecef = lngLatAltToEcefArray(7.46, 51.35);
    const tile = decodeTinyTile(dashboard, {
        transform: translationMatrix(ecef[0], ecef[1], ecef[2]),
        positions: [[0, 0, 0]]
    });
    const defs = {};
    const projectionCalls = [];
    const fakeProj4 = function(from, to, point) {
        projectionCalls.push({ from, to, point });
        if (to === 'EPSG:4326') return [7.46, 51.35, 0];
        return [2601754.9218626632, 5691597.591214224, point[2] || 0];
    };
    fakeProj4.defs = function(code, definition) {
        if (arguments.length === 1) return defs[code];
        defs[code] = definition;
        return definition;
    };

    const result = await runExportWorker(dashboard, baseExportPayload(tile, {
        polygonBoundary: [
            [7.4599, 51.3499],
            [7.4601, 51.3499],
            [7.4601, 51.3501],
            [7.4599, 51.3501]
        ],
        outputProjectionEpsg: 'EPSG:31466',
        outputProjectionLabel: 'EPSG:31466 / DHDN / 3-degree Gauss-Kruger zone 2',
        coordinateConversionApiUrl: 'https://dashboard.smartconstruction.com/api/v1/convertCoordinates',
        coordinateConversionAuthToken: 'Bearer projection-token'
    }), {
        proj4: fakeProj4,
        fetch: async () => {
            throw new Error('projection API should not be called for local Gauss-Kruger projection');
        }
    });

    assert.equal(defs['EPSG:31466'], '+proj=tmerc +lat_0=0 +lon_0=6 +k=1 +x_0=2500000 +y_0=0 +ellps=bessel +datum=potsdam +units=m +no_defs');
    const outputProjectionCall = projectionCalls.find(call => call.to === 'EPSG:31466');
    assert.ok(outputProjectionCall);
    assert.equal(outputProjectionCall.from, 'EPSG:4326');
    assert.ok(Math.abs(outputProjectionCall.point[0] - 7.46) < 1e-8);
    assert.ok(Math.abs(outputProjectionCall.point[1] - 51.35) < 1e-8);
    assert.match(result.rows, /^2601754\.921863,5691597\.591214,-?0\.0000$/);
    assert.equal(result.diagnostics.outputProjectionMethod, 'proj4-local');
    assert.equal(result.diagnostics.outputProjectionConvertedCount, 1);
    assert.equal(result.diagnostics.outputProjectionApiCallCount, 0);
    assert.equal(result.diagnostics.outputProjectionLocalDef.kind, 'dhdn-gauss-kruger');
});

test('export worker clips projected EPSG polygon using local DHDN Gauss-Kruger projection', async () => {
    const { dashboard } = loadExtension({ withPcExport: true });
    const ecef = lngLatAltToEcefArray(7.46, 51.35);
    const tile = decodeTinyTile(dashboard, {
        transform: translationMatrix(ecef[0], ecef[1], ecef[2]),
        positions: [[0, 0, 0]]
    });
    const defs = {};
    const projectionCalls = [];
    const fakeProj4 = function(from, to, point) {
        projectionCalls.push({ from, to, point });
        if (to === 'EPSG:4326') return [7.46, 51.35, 0];
        return [2601754.9218626632, 5691597.591214224, point[2] || 0];
    };
    fakeProj4.defs = function(code, definition) {
        if (arguments.length === 1) return defs[code];
        defs[code] = definition;
        return definition;
    };

    const result = await runExportWorker(dashboard, baseExportPayload(tile, {
        polygonBoundary: [
            [2601750, 5691590],
            [2601760, 5691590],
            [2601760, 5691605],
            [2601750, 5691605]
        ],
        clipMode: 'projected',
        outputProjectionEpsg: 'EPSG:31466',
        outputProjectionLabel: 'EPSG:31466 / DHDN / 3-degree Gauss-Kruger zone 2',
        coordinateConversionApiUrl: 'https://dashboard.smartconstruction.com/api/v1/convertCoordinates',
        coordinateConversionAuthToken: 'Bearer projection-token'
    }), {
        proj4: fakeProj4,
        fetch: async () => {
            throw new Error('projection API should not be called for local projected clipping');
        }
    });

    assert.equal(defs['EPSG:31466'], '+proj=tmerc +lat_0=0 +lon_0=6 +k=1 +x_0=2500000 +y_0=0 +ellps=bessel +datum=potsdam +units=m +no_defs');
    assert.equal(result.clippedCount, 1);
    assert.equal(result.diagnostics.effectiveClipMode, 'projected');
    assert.equal(result.diagnostics.bboxCandidateCount, 1);
    assert.match(result.rows, /^2601754\.921863,5691597\.591214,-?0\.0000$/);
    assert.equal(result.diagnostics.outputProjectionMethod, 'proj4-local');
    assert.equal(result.diagnostics.outputProjectionConvertedCount, 1);
    assert.equal(result.diagnostics.outputProjectionApiCallCount, 0);
    assert.ok(projectionCalls.some(call => call.to === 'EPSG:31466'));
});

test('export worker splits active EPSG projection batches after API 500 responses', async () => {
    const { dashboard } = loadExtension({ withPcExport: true });
    const tile = decodeTinyTile(dashboard, {
        positions: [
            [0, 0, 0],
            [0, 0, 1]
        ]
    });
    const projectionCalls = [];

    const result = await runExportWorker(dashboard, baseExportPayload(tile, {
        outputProjectionEpsg: 'EPSG:31370',
        coordinateConversionApiUrl: 'https://dashboard.smartconstruction.com/api/v1/convertCoordinates',
        coordinateConversionAuthToken: 'Bearer projection-token',
        projectionBatchSize: 2
    }), {
        fetch: async (url, request) => {
            const body = JSON.parse(request.body);
            projectionCalls.push({ url, request, body });

            if (body.coordinates.length > 1) {
                return {
                    ok: false,
                    status: 500,
                    async text() {
                        return 'batch too large';
                    }
                };
            }

            return {
                ok: true,
                status: 200,
                async json() {
                    return {
                        coordinates: body.coordinates.map(() => [123456.789, 987654.321, 0])
                    };
                }
            };
        }
    });

    assert.equal(projectionCalls.length, 3);
    assert.equal(projectionCalls[0].body.coordinates.length, 2);
    assert.equal(projectionCalls[1].body.coordinates.length, 1);
    assert.equal(projectionCalls[2].body.coordinates.length, 1);
    assert.equal(result.clippedCount, 2);
    assert.equal(result.diagnostics.outputProjectionConvertedCount, 2);
    assert.equal(result.diagnostics.outputProjectionApiCallCount, 3);
    assert.equal(result.diagnostics.outputProjectionRetryCount, 1);
    assert.equal(result.diagnostics.outputProjectionMaxBatchSize, 2);
});

test('export worker streams CSV output while preserving dropped point diagnostics', async () => {
    const { dashboard } = loadExtension({ withPcExport: true });
    const tile = decodeTinyTile(dashboard);
    tile.combineSurveys = new Uint8Array([0, 160]);

    const result = await runExportWorker(dashboard, baseExportPayload(tile));

    assert.equal(result.clippedCount, 1);
    assert.equal(result.droppedCount, 1);
    assert.equal(result.rows, '0.000000,0.000000,0.0000');
    assert.equal(result.diagnostics.clippedCount, 1);
    assert.equal(result.diagnostics.droppedCount, 1);
    assert.equal(result.diagnostics.processedCount, 1);
});

test('export worker clips local-grid points and formats DXF point output', async () => {
    const { dashboard } = loadExtension({ withPcExport: true });
    const tile = decodeTinyTile(dashboard);

    const result = await runExportWorker(dashboard, baseExportPayload(tile, {
        polygonBoundary: [
            [-1, -1],
            [5, -1],
            [5, 5],
            [-1, 5]
        ],
        clipMode: 'projected',
        activeLocalGrid: {
            originLng: 0,
            originLat: 0,
            originEasting: 0,
            originNorthing: 0,
            rotation: 15,
            scaleFactor: 1,
            verticalShift: 10
        },
        exportFormat: 'dxf'
    }));

    const expectedDxf = [
        '0',
        'SECTION',
        '2',
        'ENTITIES',
        '0',
        'POINT',
        '8',
        'AutoHarvestedPoints',
        '10',
        '0.000000',
        '20',
        '0.000000',
        '30',
        '10.0000',
        '0',
        'ENDSEC',
        '0',
        'EOF'
    ].join('\n');

    assert.equal(result.clippedCount, 1);
    assert.equal(result.droppedCount, 0);
    assert.equal(result.rows, expectedDxf);
    assert.equal(result.diagnostics.effectiveClipMode, 'projected');
    assert.equal(result.diagnostics.clippedCount, 1);
    assert.equal(result.diagnostics.droppedCount, 0);
    assert.equal(result.diagnostics.processedCount, 2);
    assert.equal(result.diagnostics.bboxCandidateCount, 1);
    assert.equal(result.diagnostics.lockedRotationSign, 1);
    assert.equal(result.diagnostics.rotationApplied, true);
    assert.equal(result.diagnostics.polygonRange.minX, -1);
    assert.equal(result.diagnostics.polygonRange.maxX, 5);
    assert.equal(result.diagnostics.polygonRange.minY, -1);
    assert.equal(result.diagnostics.polygonRange.maxY, 5);
    assert.equal(result.diagnostics.rotationCandidateStats.positive.bboxCandidateCount, 1);
    assert.equal(result.diagnostics.rotationCandidateStats.positive.insideCount, 1);
    assert.equal(result.diagnostics.rotationCandidateStats.negative.bboxCandidateCount, 1);
    assert.equal(result.diagnostics.rotationCandidateStats.negative.insideCount, 1);
    assert.equal(result.diagnostics.rotationCandidateStats.none.bboxCandidateCount, 1);
    assert.equal(result.diagnostics.rotationCandidateStats.none.insideCount, 1);
});

test('export worker streams DXF mesh output through grid cells', async () => {
    const { dashboard } = loadExtension({ withPcExport: true });
    const tile = decodeTinyTile(dashboard, {
        positions: [
            [0, 0.25, 0.25],
            [0, 1.25, 0.25],
            [0, 1.25, 1.25],
            [0, 0.25, 1.25]
        ]
    });

    const result = await runExportWorker(dashboard, baseExportPayload(tile, {
        polygonBoundary: [
            [0, 0],
            [2, 0],
            [2, 2],
            [0, 2]
        ],
        clipMode: 'projected',
        activeLocalGrid: {
            originLng: 0,
            originLat: 0,
            originEasting: 0,
            originNorthing: 0,
            scaleFactor: 1
        },
        exportFormat: 'dxf-mesh',
        gridSize: 1
    }));

    const expectedDxf = [
        '0',
        'SECTION',
        '2',
        'ENTITIES',
        '0',
        '3DFACE',
        '8',
        'AutoHarvestedMesh',
        '10',
        '0.5000',
        '20',
        '0.5000',
        '30',
        '0.0000',
        '11',
        '1.5000',
        '21',
        '0.5000',
        '31',
        '0.0000',
        '12',
        '1.5000',
        '22',
        '1.5000',
        '32',
        '0.0000',
        '13',
        '0.5000',
        '23',
        '1.5000',
        '33',
        '0.0000',
        '0',
        'ENDSEC',
        '0',
        'EOF'
    ].join('\n');

    assert.equal(result.clippedCount, 4);
    assert.equal(result.droppedCount, 0);
    assert.equal(result.rows, expectedDxf);
    assert.equal(result.diagnostics.effectiveClipMode, 'projected');
    assert.equal(result.diagnostics.clippedCount, 4);
    assert.equal(result.diagnostics.droppedCount, 0);
    assert.equal(result.diagnostics.processedCount, 4);
    assert.equal(result.diagnostics.bboxCandidateCount, 4);
    assert.equal(result.diagnostics.meshStats.cellCount, 4);
    assert.equal(result.diagnostics.meshStats.faceCount, 1);
});

test('export worker converts ECEF polygon boundaries through the local grid once', async () => {
    const { dashboard } = loadExtension({ withPcExport: true });
    const tile = decodeTinyTile(dashboard);

    const result = await runExportWorker(dashboard, baseExportPayload(tile, {
        polygonBoundary: [
            lngLatAltToEcefArray(-0.00005, -0.00005),
            lngLatAltToEcefArray(0.00005, -0.00005),
            lngLatAltToEcefArray(0.00005, 0.00005),
            lngLatAltToEcefArray(-0.00005, 0.00005)
        ],
        clipMode: 'ecef',
        activeLocalGrid: {
            originLng: 0,
            originLat: 0,
            originEasting: 0,
            originNorthing: 0,
            scaleFactor: 1
        }
    }));

    assert.equal(result.clippedCount, 1);
    assert.equal(result.droppedCount, 0);
    assert.equal(result.rows, '0.000000,0.000000,0.0000');
    assert.equal(result.diagnostics.inputClipMode, 'ecef');
    assert.equal(result.diagnostics.effectiveClipMode, 'projected');
    assert.equal(result.diagnostics.lockedRotationSign, -1);
    assert.equal(result.diagnostics.processedCount, 2);
    assert.equal(result.diagnostics.bboxCandidateCount, 1);
});

test('main thread supportsLocalProjectionEpsg recognizes EPSG:27700 and normalized EPSG:7953', () => {
    const { dashboard } = loadExtension({ withPcExport: true });
    const supports = dashboard.testHooks.pcExport.supportsLocalProjectionEpsg;

    assert.equal(supports('EPSG:27700', ''), true);
    assert.equal(supports('EPSG:7953', ''), true);
    assert.equal(supports('EPSG:25832', ''), true);
    assert.equal(supports('EPSG:31466', ''), true);
    assert.equal(supports('EPSG:4326', ''), false);
    assert.equal(supports('EPSG:99999', ''), false);
    assert.equal(supports(null, ''), false);
});

test('export worker uses local proj4 fast path for EPSG:27700 British National Grid output', async () => {
    const { dashboard } = loadExtension({ withPcExport: true });
    const ecef = lngLatAltToEcefArray(-0.1, 51.5);
    const tile = decodeTinyTile(dashboard, {
        transform: translationMatrix(ecef[0], ecef[1], ecef[2]),
        positions: [[0, 0, 0]]
    });
    const defs = {};
    const projectionCalls = [];
    const fakeProj4 = function(from, to, point) {
        projectionCalls.push({ from, to, point });
        if (to === 'EPSG:4326') return [-0.1, 51.5, 0];
        return [530039.562, 180380.605, point[2] || 0];
    };
    fakeProj4.defs = function(code, definition) {
        if (arguments.length === 1) return defs[code];
        defs[code] = definition;
        return definition;
    };

    const result = await runExportWorker(dashboard, baseExportPayload(tile, {
        polygonBoundary: [
            [-0.1001, 51.4999],
            [-0.0999, 51.4999],
            [-0.0999, 51.5001],
            [-0.1001, 51.5001]
        ],
        outputProjectionEpsg: 'EPSG:27700',
        outputProjectionLabel: 'EPSG:27700 / OSGB36 / British National Grid',
        coordinateConversionApiUrl: 'https://dashboard.smartconstruction.com/api/v1/convertCoordinates',
        coordinateConversionAuthToken: 'Bearer projection-token'
    }), {
        proj4: fakeProj4,
        fetch: async () => {
            throw new Error('projection API should not be called for local British National Grid projection');
        }
    });

    assert.ok(defs['EPSG:27700']);
    assert.ok(defs['EPSG:27700'].includes('+proj=tmerc'));
    assert.ok(defs['EPSG:27700'].includes('+ellps=airy'));
    const outputCall = projectionCalls.find(call => call.to === 'EPSG:27700');
    assert.ok(outputCall);
    assert.equal(outputCall.from, 'EPSG:4326');
    assert.match(result.rows, /^530039\.562000,180380\.605000,-?0\.0000$/);
    assert.equal(result.diagnostics.outputProjectionMethod, 'proj4-local');
    assert.equal(result.diagnostics.outputProjectionConvertedCount, 1);
    assert.equal(result.diagnostics.outputProjectionApiCallCount, 0);
    assert.equal(result.diagnostics.outputProjectionLocalDef.kind, 'osgb36-british-national-grid');
    assert.equal(result.diagnostics.crsWasNormalized, false);
});

test('export worker normalizes EPSG:7953 to EPSG:27700 and uses local proj4 path', async () => {
    const { dashboard } = loadExtension({ withPcExport: true });
    const ecef = lngLatAltToEcefArray(-0.1, 51.5);
    const tile = decodeTinyTile(dashboard, {
        transform: translationMatrix(ecef[0], ecef[1], ecef[2]),
        positions: [[0, 0, 0]]
    });
    const defs = {};
    const projectionCalls = [];
    const fakeProj4 = function(from, to, point) {
        projectionCalls.push({ from, to, point });
        if (to === 'EPSG:4326') return [-0.1, 51.5, 0];
        return [530039.562, 180380.605, point[2] || 0];
    };
    fakeProj4.defs = function(code, definition) {
        if (arguments.length === 1) return defs[code];
        defs[code] = definition;
        return definition;
    };

    const result = await runExportWorker(dashboard, baseExportPayload(tile, {
        polygonBoundary: [
            [-0.1001, 51.4999],
            [-0.0999, 51.4999],
            [-0.0999, 51.5001],
            [-0.1001, 51.5001]
        ],
        outputProjectionEpsg: 'EPSG:7953',
        outputProjectionLabel: 'EPSG:7953 / ETRS89 to OSGB36',
        coordinateConversionApiUrl: 'https://dashboard.smartconstruction.com/api/v1/convertCoordinates',
        coordinateConversionAuthToken: 'Bearer projection-token'
    }), {
        proj4: fakeProj4,
        fetch: async () => {
            throw new Error('projection API should not be called for normalized British National Grid projection');
        }
    });

    assert.ok(defs['EPSG:27700'], 'EPSG:27700 definition should be registered after normalization from 7953');
    assert.ok(!defs['EPSG:7953'], 'EPSG:7953 should not be registered directly');
    const outputCall = projectionCalls.find(call => call.to === 'EPSG:27700');
    assert.ok(outputCall);
    assert.equal(outputCall.from, 'EPSG:4326');
    assert.match(result.rows, /^530039\.562000,180380\.605000,-?0\.0000$/);
    assert.equal(result.diagnostics.outputProjectionEpsg, 'EPSG:27700');
    assert.equal(result.diagnostics.outputProjectionEpsgRaw, 'EPSG:7953');
    assert.equal(result.diagnostics.crsWasNormalized, true);
    assert.equal(result.diagnostics.outputProjectionMethod, 'proj4-local');
    assert.equal(result.diagnostics.outputProjectionConvertedCount, 1);
    assert.equal(result.diagnostics.outputProjectionApiCallCount, 0);
    assert.equal(result.diagnostics.outputProjectionLocalDef.kind, 'osgb36-british-national-grid');
});

test('export worker clips projected polygon using normalized EPSG:7953 as EPSG:27700', async () => {
    const { dashboard } = loadExtension({ withPcExport: true });
    const ecef = lngLatAltToEcefArray(-0.1, 51.5);
    const tile = decodeTinyTile(dashboard, {
        transform: translationMatrix(ecef[0], ecef[1], ecef[2]),
        positions: [[0, 0, 0]]
    });
    const defs = {};
    const projectionCalls = [];
    const fakeProj4 = function(from, to, point) {
        projectionCalls.push({ from, to, point });
        if (to === 'EPSG:4326') return [-0.1, 51.5, 0];
        return [530039.562, 180380.605, point[2] || 0];
    };
    fakeProj4.defs = function(code, definition) {
        if (arguments.length === 1) return defs[code];
        defs[code] = definition;
        return definition;
    };

    const result = await runExportWorker(dashboard, baseExportPayload(tile, {
        polygonBoundary: [
            [530030, 180370],
            [530050, 180370],
            [530050, 180390],
            [530030, 180390]
        ],
        clipMode: 'projected',
        outputProjectionEpsg: 'EPSG:7953',
        outputProjectionLabel: 'EPSG:7953 / ETRS89 to OSGB36',
        coordinateConversionApiUrl: 'https://dashboard.smartconstruction.com/api/v1/convertCoordinates',
        coordinateConversionAuthToken: 'Bearer projection-token'
    }), {
        proj4: fakeProj4,
        fetch: async () => {
            throw new Error('projection API should not be called for local projected clipping');
        }
    });

    assert.equal(result.clippedCount, 1);
    assert.equal(result.diagnostics.effectiveClipMode, 'projected');
    assert.match(result.rows, /^530039\.562000,180380\.605000,-?0\.0000$/);
    assert.equal(result.diagnostics.crsWasNormalized, true);
    assert.equal(result.diagnostics.outputProjectionEpsg, 'EPSG:27700');
    assert.equal(result.diagnostics.outputProjectionMethod, 'proj4-local');
    assert.equal(result.diagnostics.outputProjectionApiCallCount, 0);
});

async function main() {
    for (const { name, fn } of tests) {
        await fn();
        console.log(`ok - ${name}`);
    }

    console.log(`\n${tests.length} performance harness checks passed.`);
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
