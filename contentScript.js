const scriptsToInject = [
    'core.js',
    'ui.js',
    'feature_PCExport.js',
    'feature_measurementsToolbar.js'
];

function injectScript(index) {
    if (index >= scriptsToInject.length) return;
    
    const scriptNode = document.createElement('script');
    scriptNode.src = chrome.runtime.getURL(scriptsToInject[index]);
    scriptNode.onload = () => {
        scriptNode.remove();
        injectScript(index + 1); // Load next script after current finishes
    };
    (document.head || document.documentElement).appendChild(scriptNode);
}

injectScript(0);
