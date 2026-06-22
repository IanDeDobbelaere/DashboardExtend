(function() {
    window.DashboardExtend.UI = {
        buttons: [],
        
        registerButton: function(id, text, onClickCallback) {
            this.buttons.push({ id, text, onClickCallback });
        },

        initObserver: function() {
            setInterval(() => {
                const targetContainer = window.DashboardExtend.utils.findDeepNode(n => n.tagName === 'SC-ANNOTATION-DETAIL');
                if (!targetContainer) return; 
                if (window.DashboardExtend.utils.findDeepNode(n => n.id === 'sc-harvester-inline-panel', targetContainer)) return;

                this.injectPanel(targetContainer);
            }, 1000);
        },

        injectPanel: function(targetContainer) {
            const measurementsPanel = window.DashboardExtend.utils.findDeepNode(n => n.tagName === 'SC-MEASUREMENTS-PANEL');
            if (measurementsPanel) {
                measurementsPanel.style.height = '100%';
                measurementsPanel.style.marginBottom = '0px';
                measurementsPanel.style.display = 'flex';
                measurementsPanel.style.flexDirection = 'column';
            }

            targetContainer.style.height = '100%';
            targetContainer.style.display = 'flex';
            targetContainer.style.flexDirection = 'column';

            const panel = document.createElement("div");
            panel.id = "sc-harvester-inline-panel";
            Object.assign(panel.style, {
                marginTop: "auto", 
                marginBottom: "0px",
                paddingBottom: "5px", 
                fontFamily: "system-ui, -apple-system, sans-serif", 
                display: "flex", 
                flexDirection: "column"
            });

            this.buttons.forEach(btnConfig => {
                const btn = document.createElement("button");
                btn.id = btnConfig.id;
                btn.innerText = btnConfig.text;
                Object.assign(btn.style, {
                    width: "calc(100% - 10px)", margin: "5px", padding: "12px", 
                    backgroundColor: "#31323a", color: "#ffffff", border: "none", 
                    borderRadius: "4px", cursor: "pointer", fontWeight: "bold", 
                    fontSize: "13px", transition: "background-color 0.2s"
                });

                btn.onmouseover = () => btn.style.backgroundColor = "#454651";
                btn.onmouseout = () => btn.style.backgroundColor = "#31323a";
                btn.onclick = () => btnConfig.onClickCallback(btn); 
                
                panel.appendChild(btn);
            });

            if (targetContainer.shadowRoot) {
                targetContainer.shadowRoot.appendChild(panel);
            } else {
                targetContainer.appendChild(panel);
            }
        }
    };

    window.DashboardExtend.UI.initObserver();
})();