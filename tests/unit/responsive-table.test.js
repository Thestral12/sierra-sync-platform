/**
 * Responsive Table Component Tests
 */

describe('ResponsiveTable', () => {
    let table;
    let responsiveTable;
    
    beforeEach(() => {
        // Create a sample table
        document.body.innerHTML = `
            <table id="testTable" data-responsive="true">
                <thead>
                    <tr>
                        <th data-key="name" data-priority="high">Name</th>
                        <th data-key="email" data-priority="normal">Email</th>
                        <th data-key="role" data-priority="normal">Role</th>
                        <th data-key="status" data-priority="high">Status</th>
                        <th data-key="lastLogin" data-priority="low" data-sortable="true">Last Login</th>
                    </tr>
                </thead>
                <tbody>
                    <tr>
                        <td>John Doe</td>
                        <td>john@example.com</td>
                        <td>Admin</td>
                        <td><span class="badge badge-success">Active</span></td>
                        <td>2024-01-15</td>
                    </tr>
                    <tr>
                        <td>Jane Smith</td>
                        <td>jane@example.com</td>
                        <td>User</td>
                        <td><span class="badge badge-warning">Pending</span></td>
                        <td>2024-01-14</td>
                    </tr>
                    <tr>
                        <td>Bob Johnson</td>
                        <td>bob@example.com</td>
                        <td>Manager</td>
                        <td><span class="badge badge-success">Active</span></td>
                        <td>2024-01-16</td>
                    </tr>
                </tbody>
            </table>
        `;
        
        table = document.getElementById('testTable');
    });
    
    afterEach(() => {
        if (responsiveTable) {
            responsiveTable.destroy();
        }
        document.body.innerHTML = '';
        jest.clearAllMocks();
    });
    
    describe('Initialization', () => {
        test('should extract headers correctly', () => {
            responsiveTable = new ResponsiveTable(table);
            
            expect(responsiveTable.headers).toHaveLength(5);
            expect(responsiveTable.headers[0]).toEqual({
                text: 'Name',
                key: 'name',
                sortable: true,
                priority: 'high',
                type: 'text'
            });
        });
        
        test('should extract data correctly', () => {
            responsiveTable = new ResponsiveTable(table);
            
            expect(responsiveTable.data).toHaveLength(3);
            expect(responsiveTable.data[0].name.value).toBe('John Doe');
            expect(responsiveTable.data[0].email.value).toBe('john@example.com');
        });
        
        test('should create wrapper element', () => {
            responsiveTable = new ResponsiveTable(table);
            
            const wrapper = document.querySelector('.responsive-table-wrapper');
            expect(wrapper).toBeTruthy();
            expect(wrapper.contains(table)).toBe(true);
        });
        
        test('should add controls when enabled', () => {
            responsiveTable = new ResponsiveTable(table, {
                enableFilter: true,
                enableSort: true
            });
            
            const controls = document.querySelector('.table-controls');
            expect(controls).toBeTruthy();
            expect(controls.querySelector('.table-filter')).toBeTruthy();
        });
    });
    
    describe('Mobile Detection', () => {
        test('should detect mobile viewport', () => {
            // Mock mobile viewport
            global.innerWidth = 500;
            
            responsiveTable = new ResponsiveTable(table);
            expect(responsiveTable.isMobile).toBe(true);
        });
        
        test('should detect desktop viewport', () => {
            // Mock desktop viewport
            global.innerWidth = 1200;
            
            responsiveTable = new ResponsiveTable(table);
            expect(responsiveTable.isMobile).toBe(false);
        });
        
        test('should use custom breakpoint', () => {
            global.innerWidth = 900;
            
            responsiveTable = new ResponsiveTable(table, {
                breakpoint: 1024
            });
            
            expect(responsiveTable.isMobile).toBe(true);
        });
    });
    
    describe('Card Rendering', () => {
        beforeEach(() => {
            global.innerWidth = 500;
            responsiveTable = new ResponsiveTable(table);
        });
        
        test('should hide table and show cards on mobile', () => {
            expect(table.style.display).toBe('none');
            
            const cards = document.querySelector('.table-cards');
            expect(cards).toBeTruthy();
        });
        
        test('should create card for each data row', () => {
            const cards = document.querySelectorAll('.table-cards > div');
            expect(cards).toHaveLength(3);
        });
        
        test('should display high priority fields prominently', () => {
            const firstCard = document.querySelector('.table-cards > div');
            const prominentText = firstCard.querySelector('.font-semibold.text-lg');
            
            expect(prominentText).toBeTruthy();
            expect(prominentText.textContent).toContain('John Doe');
        });
        
        test('should group fields by priority', () => {
            const firstCard = document.querySelector('.table-cards > div');
            
            // Check for details element (low priority items)
            const details = firstCard.querySelector('details');
            expect(details).toBeTruthy();
            expect(details.querySelector('summary').textContent).toBe('More details');
        });
    });
    
    describe('Filtering', () => {
        beforeEach(() => {
            responsiveTable = new ResponsiveTable(table, {
                enableFilter: true
            });
        });
        
        test('should filter data based on search text', () => {
            const filterInput = document.querySelector('.table-filter');
            
            // Simulate typing "john"
            filterInput.value = 'john';
            filterInput.dispatchEvent(new Event('input'));
            
            const filteredData = responsiveTable.filterData();
            expect(filteredData).toHaveLength(2); // John Doe and Bob Johnson
        });
        
        test('should be case insensitive', () => {
            const filterInput = document.querySelector('.table-filter');
            
            filterInput.value = 'ADMIN';
            filterInput.dispatchEvent(new Event('input'));
            
            const filteredData = responsiveTable.filterData();
            expect(filteredData).toHaveLength(1);
            expect(filteredData[0].name.value).toBe('John Doe');
        });
        
        test('should show no results message when filter has no matches', () => {
            const filterInput = document.querySelector('.table-filter');
            
            filterInput.value = 'nonexistent';
            filterInput.dispatchEvent(new Event('input'));
            
            responsiveTable.render();
            
            const noResults = document.querySelector('.table-cards');
            expect(noResults.textContent).toContain('No results found');
        });
    });
    
    describe('Sorting', () => {
        beforeEach(() => {
            global.innerWidth = 1200; // Desktop view for header sorting
            responsiveTable = new ResponsiveTable(table);
        });
        
        test('should sort data by column', () => {
            responsiveTable.sortColumn = 'name';
            responsiveTable.sortData();
            
            expect(responsiveTable.data[0].name.value).toBe('Bob Johnson');
            expect(responsiveTable.data[1].name.value).toBe('Jane Smith');
            expect(responsiveTable.data[2].name.value).toBe('John Doe');
        });
        
        test('should toggle sort direction', () => {
            responsiveTable.sortColumn = 'name';
            responsiveTable.sortDirection = 'desc';
            responsiveTable.sortData();
            
            expect(responsiveTable.data[0].name.value).toBe('John Doe');
            expect(responsiveTable.data[2].name.value).toBe('Bob Johnson');
        });
        
        test('should sort numeric values correctly', () => {
            // Add numeric data
            responsiveTable.data = [
                { value: { value: '10' } },
                { value: { value: '2' } },
                { value: { value: '100' } }
            ];
            
            responsiveTable.sortColumn = 'value';
            responsiveTable.sortData();
            
            expect(responsiveTable.data[0].value.value).toBe('2');
            expect(responsiveTable.data[1].value.value).toBe('10');
            expect(responsiveTable.data[2].value.value).toBe('100');
        });
        
        test('should add sort indicators to headers', () => {
            const firstHeader = table.querySelector('thead th');
            firstHeader.click();
            
            responsiveTable.sortColumn = 'name';
            responsiveTable.render();
            
            const indicator = firstHeader.querySelector('.sort-indicator');
            expect(indicator).toBeTruthy();
            expect(indicator.textContent).toBe('↑');
        });
    });
    
    describe('Responsive Behavior', () => {
        test('should switch between table and cards on resize', () => {
            global.innerWidth = 1200;
            responsiveTable = new ResponsiveTable(table);
            
            // Start with desktop view
            expect(table.style.display).not.toBe('none');
            expect(document.querySelector('.table-cards')).toBeFalsy();
            
            // Resize to mobile
            global.innerWidth = 500;
            window.dispatchEvent(new Event('resize'));
            
            // Should show cards
            expect(table.style.display).toBe('none');
            expect(document.querySelector('.table-cards')).toBeTruthy();
            
            // Resize back to desktop
            global.innerWidth = 1200;
            window.dispatchEvent(new Event('resize'));
            
            // Should show table again
            expect(table.style.display).not.toBe('none');
            expect(document.querySelector('.table-cards')).toBeFalsy();
        });
    });
    
    describe('Touch Interaction', () => {
        test('should have touch-friendly controls on mobile', () => {
            global.innerWidth = 500;
            responsiveTable = new ResponsiveTable(table, {
                enableFilter: true,
                enableSort: true
            });
            
            const filterInput = document.querySelector('.table-filter');
            const sortSelect = document.querySelector('.table-sort');
            
            // Check minimum heights for touch targets
            expect(filterInput.classList.contains('py-2')).toBe(true); // 8px * 2 = 16px padding
            expect(sortSelect.classList.contains('py-2')).toBe(true);
        });
    });
    
    describe('Accessibility', () => {
        test('should have proper ARIA labels', () => {
            responsiveTable = new ResponsiveTable(table, {
                enableFilter: true
            });
            
            const filterInput = document.querySelector('.table-filter');
            expect(filterInput.getAttribute('aria-label')).toBe('Filter table data');
        });
        
        test('should maintain semantic structure in cards', () => {
            global.innerWidth = 500;
            responsiveTable = new ResponsiveTable(table);
            
            const cards = document.querySelectorAll('.table-cards > div');
            cards.forEach(card => {
                // Each card should be a proper container
                expect(card.className).toContain('bg-white');
                expect(card.className).toContain('rounded-lg');
            });
        });
    });
    
    describe('Destroy', () => {
        test('should restore original table', () => {
            const originalHTML = table.outerHTML;
            responsiveTable = new ResponsiveTable(table);
            
            responsiveTable.destroy();
            
            const wrapper = document.querySelector('.responsive-table-wrapper');
            expect(wrapper.innerHTML).toBe(originalHTML);
        });
    });
});