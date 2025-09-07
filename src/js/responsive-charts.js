/**
 * Responsive Charts Component
 * Makes Chart.js charts mobile-friendly with touch interactions
 */

class ResponsiveCharts {
    constructor() {
        this.charts = [];
        this.touchStartX = 0;
        this.touchStartY = 0;
        this.isPinching = false;
        this.lastTouchDistance = 0;
        this.init();
    }
    
    init() {
        // Wait for DOM and Chart.js to be ready
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', () => this.setup());
        } else {
            this.setup();
        }
    }
    
    setup() {
        // Find all chart canvases
        const canvases = document.querySelectorAll('canvas[data-chart]');
        canvases.forEach(canvas => {
            this.enhanceChart(canvas);
        });
        
        // Set up responsive options for Chart.js
        this.setGlobalChartOptions();
    }
    
    setGlobalChartOptions() {
        if (typeof Chart === 'undefined') return;
        
        // Set global defaults for mobile
        Chart.defaults.responsive = true;
        Chart.defaults.maintainAspectRatio = false;
        Chart.defaults.aspectRatio = window.innerWidth < 768 ? 1.5 : 2;
        
        // Mobile-friendly font sizes
        if (window.innerWidth < 768) {
            Chart.defaults.font.size = 10;
            Chart.defaults.plugins.legend.labels.font.size = 10;
            Chart.defaults.plugins.title.font.size = 14;
        }
        
        // Touch-friendly tooltips
        Chart.defaults.plugins.tooltip.enabled = true;
        Chart.defaults.plugins.tooltip.intersect = false;
        Chart.defaults.plugins.tooltip.mode = 'nearest';
        Chart.defaults.plugins.tooltip.cornerRadius = 4;
        Chart.defaults.plugins.tooltip.caretSize = 6;
        
        // Animation performance for mobile
        if (window.innerWidth < 768) {
            Chart.defaults.animation.duration = 500;
        }
    }
    
    enhanceChart(canvas) {
        const chartInstance = Chart.getChart(canvas);
        if (!chartInstance) return;
        
        // Store chart reference
        this.charts.push(chartInstance);
        
        // Add container wrapper for better control
        this.wrapChart(canvas);
        
        // Add touch interactions
        this.addTouchInteractions(canvas, chartInstance);
        
        // Add fullscreen button
        this.addFullscreenButton(canvas, chartInstance);
        
        // Make legend interactive on mobile
        this.enhanceLegend(chartInstance);
        
        // Add pan and zoom capabilities
        this.addPanZoom(chartInstance);
        
        // Optimize for mobile display
        this.optimizeForMobile(chartInstance);
    }
    
    wrapChart(canvas) {
        if (canvas.parentElement.classList.contains('chart-container')) return;
        
        const wrapper = document.createElement('div');
        wrapper.className = 'chart-container relative';
        
        // Set responsive height
        wrapper.style.position = 'relative';
        wrapper.style.height = window.innerWidth < 768 ? '300px' : '400px';
        wrapper.style.minHeight = '250px';
        wrapper.style.maxHeight = '500px';
        
        canvas.parentNode.insertBefore(wrapper, canvas);
        wrapper.appendChild(canvas);
    }
    
    addTouchInteractions(canvas, chart) {
        let touchTimeout;
        
        // Touch start
        canvas.addEventListener('touchstart', (e) => {
            if (e.touches.length === 1) {
                this.touchStartX = e.touches[0].clientX;
                this.touchStartY = e.touches[0].clientY;
                
                // Long press to show data
                touchTimeout = setTimeout(() => {
                    this.showDataAtPoint(chart, e.touches[0]);
                }, 500);
            } else if (e.touches.length === 2) {
                // Pinch zoom setup
                this.isPinching = true;
                this.lastTouchDistance = this.getTouchDistance(e.touches);
            }
        }, { passive: true });
        
        // Touch move
        canvas.addEventListener('touchmove', (e) => {
            clearTimeout(touchTimeout);
            
            if (this.isPinching && e.touches.length === 2) {
                this.handlePinchZoom(chart, e.touches);
            } else if (e.touches.length === 1) {
                this.handleSwipe(chart, e.touches[0]);
            }
        }, { passive: true });
        
        // Touch end
        canvas.addEventListener('touchend', (e) => {
            clearTimeout(touchTimeout);
            this.isPinching = false;
            this.lastTouchDistance = 0;
        }, { passive: true });
    }
    
    getTouchDistance(touches) {
        const dx = touches[0].clientX - touches[1].clientX;
        const dy = touches[0].clientY - touches[1].clientY;
        return Math.sqrt(dx * dx + dy * dy);
    }
    
    handlePinchZoom(chart, touches) {
        const currentDistance = this.getTouchDistance(touches);
        const scale = currentDistance / this.lastTouchDistance;
        
        if (scale > 1.1) {
            // Zoom in
            this.zoomChart(chart, 1.1);
        } else if (scale < 0.9) {
            // Zoom out
            this.zoomChart(chart, 0.9);
        }
        
        this.lastTouchDistance = currentDistance;
    }
    
    handleSwipe(chart, touch) {
        const deltaX = touch.clientX - this.touchStartX;
        const deltaY = touch.clientY - this.touchStartY;
        
        // Horizontal swipe for time series navigation
        if (Math.abs(deltaX) > Math.abs(deltaY) && Math.abs(deltaX) > 50) {
            if (chart.config.type === 'line' || chart.config.type === 'bar') {
                this.panChart(chart, deltaX > 0 ? 'left' : 'right');
            }
        }
    }
    
    showDataAtPoint(chart, touch) {
        const rect = chart.canvas.getBoundingClientRect();
        const x = touch.clientX - rect.left;
        const y = touch.clientY - rect.top;
        
        const canvasPosition = Chart.helpers.getRelativePosition({
            clientX: touch.clientX,
            clientY: touch.clientY
        }, chart);
        
        const datasetIndex = 0;
        const nearestPoints = chart.getElementsAtEventForMode(
            { clientX: touch.clientX, clientY: touch.clientY },
            'nearest',
            { intersect: false },
            false
        );
        
        if (nearestPoints.length > 0) {
            // Trigger tooltip
            chart.tooltip.setActiveElements(nearestPoints);
            chart.update();
            
            // Haptic feedback if available
            if (navigator.vibrate) {
                navigator.vibrate(10);
            }
        }
    }
    
    addFullscreenButton(canvas, chart) {
        const container = canvas.parentElement;
        
        const button = document.createElement('button');
        button.className = 'chart-fullscreen-btn absolute top-2 right-2 z-10 p-2 bg-white rounded-lg shadow-md hover:bg-gray-100';
        button.innerHTML = `
            <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4"></path>
            </svg>
        `;
        button.setAttribute('aria-label', 'View chart in fullscreen');
        
        button.addEventListener('click', () => {
            this.toggleFullscreen(container, chart);
        });
        
        container.appendChild(button);
    }
    
    toggleFullscreen(container, chart) {
        if (!document.fullscreenElement) {
            container.requestFullscreen().then(() => {
                // Resize chart for fullscreen
                container.style.height = '100vh';
                container.style.width = '100vw';
                chart.resize();
                
                // Add close button
                this.addFullscreenCloseButton(container);
            });
        } else {
            document.exitFullscreen().then(() => {
                // Restore original size
                container.style.height = window.innerWidth < 768 ? '300px' : '400px';
                container.style.width = '';
                chart.resize();
                
                // Remove close button
                const closeBtn = container.querySelector('.fullscreen-close');
                if (closeBtn) closeBtn.remove();
            });
        }
    }
    
    addFullscreenCloseButton(container) {
        const closeBtn = document.createElement('button');
        closeBtn.className = 'fullscreen-close absolute top-4 right-4 z-20 p-3 bg-red-600 text-white rounded-lg shadow-lg';
        closeBtn.innerHTML = `
            <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path>
            </svg>
        `;
        closeBtn.setAttribute('aria-label', 'Exit fullscreen');
        
        closeBtn.addEventListener('click', () => {
            document.exitFullscreen();
        });
        
        container.appendChild(closeBtn);
    }
    
    enhanceLegend(chart) {
        if (!chart.options.plugins) chart.options.plugins = {};
        if (!chart.options.plugins.legend) chart.options.plugins.legend = {};
        
        // Make legend more touch-friendly
        chart.options.plugins.legend.labels = {
            ...chart.options.plugins.legend.labels,
            padding: 15,
            boxWidth: window.innerWidth < 768 ? 12 : 15,
            font: {
                size: window.innerWidth < 768 ? 10 : 12
            }
        };
        
        // Position legend for mobile
        if (window.innerWidth < 768) {
            chart.options.plugins.legend.position = 'bottom';
            chart.options.plugins.legend.maxHeight = 60;
        }
        
        // Make legend items clickable with larger touch target
        chart.options.plugins.legend.onClick = function(e, legendItem, legend) {
            const index = legendItem.datasetIndex;
            const chart = legend.chart;
            const meta = chart.getDatasetMeta(index);
            
            // Toggle visibility
            meta.hidden = meta.hidden === null ? !chart.data.datasets[index].hidden : null;
            chart.update();
            
            // Haptic feedback
            if (navigator.vibrate) {
                navigator.vibrate(10);
            }
        };
        
        chart.update();
    }
    
    addPanZoom(chart) {
        // Simple pan/zoom for time series charts
        if (chart.config.type === 'line' || chart.config.type === 'bar') {
            if (!chart.options.scales) chart.options.scales = {};
            
            // Store original data
            if (!chart.originalData) {
                chart.originalData = JSON.parse(JSON.stringify(chart.data));
            }
            
            // Add reset button
            this.addResetButton(chart);
        }
    }
    
    addResetButton(chart) {
        const container = chart.canvas.parentElement;
        
        const button = document.createElement('button');
        button.className = 'chart-reset-btn absolute top-2 left-2 z-10 p-2 bg-white rounded-lg shadow-md hover:bg-gray-100 hidden';
        button.innerHTML = `
            <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path>
            </svg>
        `;
        button.setAttribute('aria-label', 'Reset chart view');
        
        button.addEventListener('click', () => {
            this.resetChart(chart);
            button.classList.add('hidden');
        });
        
        container.appendChild(button);
        chart.resetButton = button;
    }
    
    panChart(chart, direction) {
        // Simple pan implementation for demo
        const labels = chart.data.labels;
        const datasets = chart.data.datasets;
        
        if (direction === 'left' && labels.length > 5) {
            // Pan left - show earlier data
            chart.data.labels = labels.slice(0, -1);
            chart.data.datasets = datasets.map(dataset => ({
                ...dataset,
                data: dataset.data.slice(0, -1)
            }));
        } else if (direction === 'right' && labels.length > 5) {
            // Pan right - show later data
            chart.data.labels = labels.slice(1);
            chart.data.datasets = datasets.map(dataset => ({
                ...dataset,
                data: dataset.data.slice(1)
            }));
        }
        
        chart.update('none');
        
        // Show reset button
        if (chart.resetButton) {
            chart.resetButton.classList.remove('hidden');
        }
    }
    
    zoomChart(chart, scale) {
        // Simple zoom implementation
        const currentLength = chart.data.labels.length;
        const targetLength = Math.round(currentLength * scale);
        
        if (targetLength >= 3 && targetLength <= chart.originalData.labels.length) {
            const start = Math.floor((chart.originalData.labels.length - targetLength) / 2);
            const end = start + targetLength;
            
            chart.data.labels = chart.originalData.labels.slice(start, end);
            chart.data.datasets = chart.originalData.datasets.map(dataset => ({
                ...dataset,
                data: dataset.data.slice(start, end)
            }));
            
            chart.update('none');
            
            // Show reset button
            if (chart.resetButton) {
                chart.resetButton.classList.remove('hidden');
            }
        }
    }
    
    resetChart(chart) {
        if (chart.originalData) {
            chart.data = JSON.parse(JSON.stringify(chart.originalData));
            chart.update();
        }
    }
    
    optimizeForMobile(chart) {
        if (window.innerWidth >= 768) return;
        
        // Reduce data points for better performance
        if (chart.data.labels && chart.data.labels.length > 10) {
            const step = Math.ceil(chart.data.labels.length / 10);
            chart.data.labels = chart.data.labels.filter((_, i) => i % step === 0);
            chart.data.datasets = chart.data.datasets.map(dataset => ({
                ...dataset,
                data: dataset.data.filter((_, i) => i % step === 0)
            }));
        }
        
        // Simplify animations
        chart.options.animation = {
            duration: 500
        };
        
        // Hide grid lines for cleaner look
        if (chart.options.scales) {
            Object.values(chart.options.scales).forEach(scale => {
                if (scale.grid) {
                    scale.grid.display = false;
                }
            });
        }
        
        // Update chart
        chart.update();
    }
    
    // Handle orientation change
    handleOrientationChange() {
        this.charts.forEach(chart => {
            chart.resize();
            this.optimizeForMobile(chart);
        });
    }
}

// Auto-initialize
document.addEventListener('DOMContentLoaded', () => {
    window.responsiveCharts = new ResponsiveCharts();
    
    // Handle orientation changes
    window.addEventListener('orientationchange', () => {
        setTimeout(() => {
            window.responsiveCharts.handleOrientationChange();
        }, 200);
    });
});

// Export for module usage
if (typeof module !== 'undefined' && module.exports) {
    module.exports = ResponsiveCharts;
}