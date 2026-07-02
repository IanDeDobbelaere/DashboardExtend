(function() {
    const hostDom = window.DashboardExtend.hostDom;
    const STARTUP_DELAY_MS = 3500;
    const STARTUP_RETRY_MS = 1000;
    const STARTUP_RETRY_LIMIT_MS = 30000;

    let startupRetryTimer = null;
    let unsubscribeDomChanged = null;
    let syncQueued = false;
    let syncStarted = false;

    function now() {
        return Date.now ? Date.now() : new Date().getTime();
    }

    function setToolbarDisplay(toolbar, hidden) {
        const nextDisplay = hidden ? 'none' : '';
        if (toolbar.style.display !== nextDisplay) toolbar.style.display = nextDisplay;
    }

    function createToolbar(panelsContainer) {
        const toolbar = document.createElement('sc-simplemeasurements-toolbar');
        panelsContainer.appendChild(toolbar);
        hostDom.invalidateCache();
        console.log("Dashboard Extend: Measurements Toolbar injected.");
        return toolbar;
    }

    function syncMeasurementsToolbar() {
        const panelsContainer = hostDom.getDrawingGuidesPanel();
        if (!panelsContainer) return false;

        const toolbar = hostDom.getMeasurementsToolbar() || createToolbar(panelsContainer);
        setToolbarDisplay(toolbar, hostDom.isDrawingGuidesHidden());
        return true;
    }

    function scheduleMeasurementsToolbarSync() {
        if (syncQueued) return;
        syncQueued = true;

        const runSync = () => {
            syncQueued = false;
            syncMeasurementsToolbar();
        };

        if (window.requestAnimationFrame) window.requestAnimationFrame(runSync);
        else setTimeout(runSync, 0);
    }

    function stopMeasurementsToolbarSync() {
        if (startupRetryTimer) {
            clearInterval(startupRetryTimer);
            startupRetryTimer = null;
        }

        if (unsubscribeDomChanged) {
            unsubscribeDomChanged();
            unsubscribeDomChanged = null;
        }

        syncStarted = false;
        syncQueued = false;
    }

    function startMeasurementsToolbarSync() {
        if (syncStarted) return;
        syncStarted = true;

        const startedAt = now();
        if (hostDom.onDomChanged) unsubscribeDomChanged = hostDom.onDomChanged(scheduleMeasurementsToolbarSync);

        if (syncMeasurementsToolbar()) return;

        startupRetryTimer = setInterval(() => {
            const synced = syncMeasurementsToolbar();
            const timedOut = now() - startedAt >= STARTUP_RETRY_LIMIT_MS;
            if (synced || timedOut) {
                clearInterval(startupRetryTimer);
                startupRetryTimer = null;
            }
        }, STARTUP_RETRY_MS);
    }

    window.DashboardExtend.testHooks = window.DashboardExtend.testHooks || {};
    window.DashboardExtend.testHooks.measurementsToolbar = {
        syncMeasurementsToolbar,
        scheduleMeasurementsToolbarSync,
        startMeasurementsToolbarSync,
        stopMeasurementsToolbarSync
    };

    // Give the heavy 3D viewer a few seconds to breathe before touching its panels.
    setTimeout(startMeasurementsToolbarSync, STARTUP_DELAY_MS);

})();
