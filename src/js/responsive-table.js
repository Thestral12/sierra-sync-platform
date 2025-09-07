/**
 * Responsive Table Component
 * Converts tables to card layout on mobile devices
 */

class ResponsiveTable {
    constructor(tableElement, options = {}) {
        this.table = typeof tableElement === 'string' 
            ? document.querySelector(tableElement) 
            : tableElement;
        
        this.options = {
            breakpoint: options.breakpoint || 768,
            cardClass: options.cardClass || 'table-card',
            enableSort: options.enableSort !== false,
            enableFilter: options.enableFilter !== false,
            stickyHeader: options.stickyHeader !== false,
            ...options
        };
        
        this.isMobile = window.innerWidth < this.options.breakpoint;
        this.originalHTML = this.table ? this.table.outerHTML : '';
        this.data = [];
        this.headers = [];
        this.sortColumn = null;
        this.sortDirection = 'asc';
        this.filterText = '';
        
        if (this.table) {
            this.init();
        }
    }
    
    init() {
        this.extractData();
        this.setupResponsive();
        this.attachEventListeners();
        this.render();
    }
    
    extractData() {
        // Extract headers
        const headerRow = this.table.querySelector('thead tr');
        if (headerRow) {
            this.headers = Array.from(headerRow.querySelectorAll('th')).map(th => ({
                text: th.textContent.trim(),
                key: th.dataset.key || th.textContent.trim().toLowerCase().replace(/\s+/g, '_'),
                sortable: th.dataset.sortable !== 'false',
                priority: th.dataset.priority || 'normal',
                type: th.dataset.type || 'text'
            }));
        }
        
        // Extract data rows
        const tbody = this.table.querySelector('tbody');
        if (tbody) {
            const rows = tbody.querySelectorAll('tr');
            this.data = Array.from(rows).map(row => {
                const cells = row.querySelectorAll('td');
                const rowData = {};
                
                cells.forEach((cell, index) => {
                    const header = this.headers[index];
                    if (header) {
                        rowData[header.key] = {
                            value: cell.textContent.trim(),
                            html: cell.innerHTML,
                            data: cell.dataset
                        };
                    }
                });
                
                return rowData;
            });
        }
    }
    
    setupResponsive() {
        // Add wrapper for better control
        const wrapper = document.createElement('div');
        wrapper.className = 'responsive-table-wrapper';
        this.table.parentNode.insertBefore(wrapper, this.table);
        wrapper.appendChild(this.table);
        this.wrapper = wrapper;
        
        // Add controls
        if (this.options.enableFilter || this.options.enableSort) {
            this.addControls();
        }
    }
    
    addControls() {
        const controls = document.createElement('div');
        controls.className = 'table-controls flex flex-col sm:flex-row gap-3 mb-4';
        
        if (this.options.enableFilter) {
            controls.innerHTML += `
                <div class="flex-1">
                    <input type="search" 
                        class="table-filter w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                        placeholder="Search..."
                        aria-label="Filter table data">
                </div>
            `;
        }
        
        if (this.options.enableSort && this.isMobile) {
            const sortOptions = this.headers
                .filter(h => h.sortable)
                .map(h => `<option value="${h.key}">${h.text}</option>`)
                .join('');
                
            controls.innerHTML += `
                <div class="flex gap-2">
                    <select class="table-sort px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500">
                        <option value="">Sort by...</option>
                        ${sortOptions}
                    </select>
                    <button class="sort-direction px-3 py-2 border border-gray-300 rounded-lg hover:bg-gray-50" aria-label="Toggle sort direction">
                        <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 16V4m0 0L3 8m4-4l4 4m6 0v12m0 0l4-4m-4 4l-4-4"></path>
                        </svg>
                    </button>
                </div>
            `;
        }
        
        this.wrapper.insertBefore(controls, this.table);
        this.controls = controls;
    }
    
    attachEventListeners() {
        // Window resize
        window.addEventListener('resize', () => {
            const wasMobile = this.isMobile;
            this.isMobile = window.innerWidth < this.options.breakpoint;
            
            if (wasMobile !== this.isMobile) {
                this.render();
            }
        });
        
        // Filter
        if (this.controls) {
            const filterInput = this.controls.querySelector('.table-filter');
            if (filterInput) {
                filterInput.addEventListener('input', (e) => {
                    this.filterText = e.target.value.toLowerCase();
                    this.render();
                });
            }
            
            // Sort
            const sortSelect = this.controls.querySelector('.table-sort');
            if (sortSelect) {
                sortSelect.addEventListener('change', (e) => {
                    this.sortColumn = e.target.value;
                    this.sortData();
                    this.render();
                });
            }
            
            const sortButton = this.controls.querySelector('.sort-direction');
            if (sortButton) {
                sortButton.addEventListener('click', () => {
                    this.sortDirection = this.sortDirection === 'asc' ? 'desc' : 'asc';
                    this.sortData();
                    this.render();
                });
            }
        }
        
        // Table header sort (desktop)
        if (!this.isMobile) {
            const headers = this.table.querySelectorAll('thead th');
            headers.forEach((header, index) => {
                if (this.headers[index] && this.headers[index].sortable) {
                    header.style.cursor = 'pointer';
                    header.addEventListener('click', () => {
                        const key = this.headers[index].key;
                        if (this.sortColumn === key) {
                            this.sortDirection = this.sortDirection === 'asc' ? 'desc' : 'asc';
                        } else {
                            this.sortColumn = key;
                            this.sortDirection = 'asc';
                        }
                        this.sortData();
                        this.render();
                    });
                }
            });
        }
    }
    
    sortData() {
        if (!this.sortColumn) return;
        
        this.data.sort((a, b) => {
            const aVal = a[this.sortColumn]?.value || '';
            const bVal = b[this.sortColumn]?.value || '';
            
            // Try to parse as number
            const aNum = parseFloat(aVal);
            const bNum = parseFloat(bVal);
            
            let comparison = 0;
            if (!isNaN(aNum) && !isNaN(bNum)) {
                comparison = aNum - bNum;
            } else {
                comparison = aVal.localeCompare(bVal);
            }
            
            return this.sortDirection === 'asc' ? comparison : -comparison;
        });
    }
    
    filterData() {
        if (!this.filterText) return this.data;
        
        return this.data.filter(row => {
            return Object.values(row).some(cell => {
                const value = cell.value || '';
                return value.toLowerCase().includes(this.filterText);
            });
        });
    }
    
    render() {
        if (this.isMobile) {
            this.renderCards();
        } else {
            this.renderTable();
        }
    }
    
    renderCards() {
        const filteredData = this.filterData();
        
        // Hide table, show cards
        this.table.style.display = 'none';
        
        // Remove existing cards container if any
        const existingCards = this.wrapper.querySelector('.table-cards');
        if (existingCards) {
            existingCards.remove();
        }
        
        // Create cards container
        const cardsContainer = document.createElement('div');
        cardsContainer.className = 'table-cards space-y-4';
        
        // Create cards
        filteredData.forEach(row => {
            const card = document.createElement('div');
            card.className = 'bg-white rounded-lg shadow-md p-4 border border-gray-200';
            
            // Build card content
            let cardHTML = '<div class="space-y-2">';
            
            // Group headers by priority
            const highPriority = this.headers.filter(h => h.priority === 'high');
            const normalPriority = this.headers.filter(h => h.priority === 'normal');
            const lowPriority = this.headers.filter(h => h.priority === 'low');
            
            // High priority items (shown prominently)
            highPriority.forEach(header => {
                const cell = row[header.key];
                if (cell) {
                    cardHTML += `
                        <div class="font-semibold text-lg text-gray-900">
                            ${cell.html}
                        </div>
                    `;
                }
            });
            
            // Normal priority items
            normalPriority.forEach(header => {
                const cell = row[header.key];
                if (cell && cell.value) {
                    cardHTML += `
                        <div class="flex justify-between items-center py-1">
                            <span class="text-sm text-gray-600">${header.text}:</span>
                            <span class="text-sm font-medium text-gray-900">${cell.html}</span>
                        </div>
                    `;
                }
            });
            
            // Low priority items (collapsible)
            if (lowPriority.length > 0) {
                cardHTML += `
                    <details class="mt-2">
                        <summary class="text-sm text-gray-500 cursor-pointer">More details</summary>
                        <div class="mt-2 space-y-1">
                `;
                
                lowPriority.forEach(header => {
                    const cell = row[header.key];
                    if (cell && cell.value) {
                        cardHTML += `
                            <div class="flex justify-between items-center py-1">
                                <span class="text-xs text-gray-600">${header.text}:</span>
                                <span class="text-xs text-gray-900">${cell.html}</span>
                            </div>
                        `;
                    }
                });
                
                cardHTML += '</div></details>';
            }
            
            cardHTML += '</div>';
            card.innerHTML = cardHTML;
            cardsContainer.appendChild(card);
        });
        
        // Add "no results" message if needed
        if (filteredData.length === 0) {
            cardsContainer.innerHTML = `
                <div class="text-center py-8 text-gray-500">
                    <svg class="w-12 h-12 mx-auto mb-4 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9.172 16.172a4 4 0 015.656 0M9 10h.01M15 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path>
                    </svg>
                    <p>No results found</p>
                </div>
            `;
        }
        
        this.wrapper.appendChild(cardsContainer);
    }
    
    renderTable() {
        // Show table, hide cards
        this.table.style.display = '';
        
        // Remove cards container if any
        const existingCards = this.wrapper.querySelector('.table-cards');
        if (existingCards) {
            existingCards.remove();
        }
        
        // Update table with filtered/sorted data
        const tbody = this.table.querySelector('tbody');
        if (tbody) {
            const filteredData = this.filterData();
            
            tbody.innerHTML = '';
            filteredData.forEach(row => {
                const tr = document.createElement('tr');
                tr.className = 'hover:bg-gray-50';
                
                this.headers.forEach(header => {
                    const cell = row[header.key];
                    const td = document.createElement('td');
                    td.className = 'px-6 py-4 whitespace-nowrap text-sm';
                    td.innerHTML = cell ? cell.html : '';
                    tr.appendChild(td);
                });
                
                tbody.appendChild(tr);
            });
            
            // Add "no results" row if needed
            if (filteredData.length === 0) {
                const tr = document.createElement('tr');
                tr.innerHTML = `
                    <td colspan="${this.headers.length}" class="px-6 py-8 text-center text-gray-500">
                        No results found
                    </td>
                `;
                tbody.appendChild(tr);
            }
        }
        
        // Update sort indicators
        if (!this.isMobile) {
            const headers = this.table.querySelectorAll('thead th');
            headers.forEach((header, index) => {
                const headerData = this.headers[index];
                if (headerData && headerData.sortable) {
                    // Remove existing indicators
                    const existingIndicator = header.querySelector('.sort-indicator');
                    if (existingIndicator) {
                        existingIndicator.remove();
                    }
                    
                    // Add new indicator if this column is sorted
                    if (this.sortColumn === headerData.key) {
                        const indicator = document.createElement('span');
                        indicator.className = 'sort-indicator ml-1';
                        indicator.innerHTML = this.sortDirection === 'asc' ? '↑' : '↓';
                        header.appendChild(indicator);
                    }
                }
            });
        }
    }
    
    destroy() {
        // Remove event listeners and restore original table
        if (this.wrapper && this.originalHTML) {
            this.wrapper.innerHTML = this.originalHTML;
        }
    }
}

// Auto-initialize tables with data-responsive attribute
document.addEventListener('DOMContentLoaded', () => {
    const tables = document.querySelectorAll('table[data-responsive="true"]');
    tables.forEach(table => {
        new ResponsiveTable(table);
    });
});

// Export for module usage
if (typeof module !== 'undefined' && module.exports) {
    module.exports = ResponsiveTable;
}

// Make available globally
window.ResponsiveTable = ResponsiveTable;