(function() {
    const utils = window.DashboardExtend.utils;

    function initMeasurementsToolbar() {
        // Run a gentle polling cycle to wait for the UI to build, 
        // and to keep visibility synced as the user interacts with the app.
        setInterval(() => {
            // 1. Locate the drawing guides component
            const guidesNode = utils.findDeepNode(n => n.tagName === 'SC-DRAWING-GUIDES');
            if (!guidesNode) return; // UI hasn't loaded yet

            // 2. Ensure we are in the "panels" wrapper
            const panelsContainer = guidesNode.parentElement;
            if (!panelsContainer || !panelsContainer.classList.contains('panels')) return;

            // 3. Look for our custom toolbar
            let toolbar = utils.findDeepNode(n => n.tagName === 'SC-SIMPLEMEASUREMENTS-TOOLBAR', panelsContainer);

            // 4. Inject if it doesn't exist yet
            if (!toolbar) {
                toolbar = document.createElement('sc-simplemeasurements-toolbar');
                panelsContainer.appendChild(toolbar);
                console.log("✅ Dashboard Extend: Measurements Toolbar injected.");
            }

            // 5. Sync visibility with sc-drawing-guides
            // Web components usually hide via the 'hidden' attribute or CSS display: none
            const guidesStyle = window.getComputedStyle(guidesNode);
            const isGuidesHidden = guidesNode.hasAttribute('hidden') || guidesStyle.display === 'none';

            if (isGuidesHidden) {
                toolbar.style.display = 'none';
            } else {
                toolbar.style.display = ''; // Reverts to the element's default display property
            }

        }, 2000); // Check every 2 seconds
    }

    // Give the heavy 3D viewer a few seconds to breathe before kicking off the DOM polling
    setTimeout(initMeasurementsToolbar, 3500);

})();