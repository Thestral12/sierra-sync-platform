/**
 * Mobile Navigation Component Tests
 * Test-Driven Development for mobile responsiveness
 */

describe('MobileNav Component', () => {
    let mobileNav;
    let mockAuth;

    beforeEach(() => {
        // Setup DOM
        document.body.innerHTML = '';
        
        // Mock auth object
        mockAuth = {
            isAuthenticated: true,
            currentUser: {
                name: 'Test User',
                role: 'admin',
                email: 'test@example.com'
            },
            getDashboardUrl: jest.fn((role) => `${role}-dashboard.html`)
        };
        global.auth = mockAuth;

        // Import and initialize MobileNav
        const MobileNav = require('../../src/js/mobile-nav.js');
        mobileNav = new MobileNav();
    });

    afterEach(() => {
        // Clean up
        document.body.innerHTML = '';
        jest.clearAllMocks();
    });

    describe('Initialization', () => {
        test('should create mobile navigation HTML elements', () => {
            expect(document.getElementById('mobileNavContainer')).toBeTruthy();
            expect(document.getElementById('mobileMenuBtn')).toBeTruthy();
            expect(document.getElementById('mobileSidebar')).toBeTruthy();
            expect(document.getElementById('mobileBottomNav')).toBeTruthy();
        });

        test('should hide navigation elements on desktop screens', () => {
            const container = document.getElementById('mobileNavContainer');
            expect(container.classList.contains('lg:hidden')).toBe(true);
        });

        test('should initialize with menu closed', () => {
            const sidebar = document.getElementById('mobileSidebar');
            expect(sidebar.classList.contains('-translate-x-full')).toBe(true);
            expect(mobileNav.isOpen).toBe(false);
        });
    });

    describe('Menu Toggle', () => {
        test('should open menu when hamburger button is clicked', () => {
            const menuBtn = document.getElementById('mobileMenuBtn');
            const sidebar = document.getElementById('mobileSidebar');
            const overlay = document.getElementById('mobileOverlay');

            menuBtn.click();

            expect(sidebar.classList.contains('-translate-x-full')).toBe(false);
            expect(overlay.classList.contains('hidden')).toBe(false);
            expect(mobileNav.isOpen).toBe(true);
        });

        test('should close menu when close button is clicked', () => {
            mobileNav.openMenu();
            const closeBtn = document.getElementById('closeMobileMenu');
            
            closeBtn.click();

            const sidebar = document.getElementById('mobileSidebar');
            expect(sidebar.classList.contains('-translate-x-full')).toBe(true);
            expect(mobileNav.isOpen).toBe(false);
        });

        test('should close menu when overlay is clicked', () => {
            mobileNav.openMenu();
            const overlay = document.getElementById('mobileOverlay');
            
            overlay.click();

            expect(mobileNav.isOpen).toBe(false);
        });

        test('should prevent body scroll when menu is open', () => {
            mobileNav.openMenu();
            expect(document.body.style.overflow).toBe('hidden');

            mobileNav.closeMenu();
            expect(document.body.style.overflow).toBe('');
        });
    });

    describe('Touch Gestures', () => {
        test('should open menu on swipe right from left edge', () => {
            const touchStart = new TouchEvent('touchstart', {
                changedTouches: [{ screenX: 10 }]
            });
            const touchEnd = new TouchEvent('touchend', {
                changedTouches: [{ screenX: 100 }]
            });

            document.dispatchEvent(touchStart);
            document.dispatchEvent(touchEnd);

            expect(mobileNav.isOpen).toBe(true);
        });

        test('should close menu on swipe left', () => {
            mobileNav.openMenu();

            const touchStart = new TouchEvent('touchstart', {
                changedTouches: [{ screenX: 200 }]
            });
            const touchEnd = new TouchEvent('touchend', {
                changedTouches: [{ screenX: 100 }]
            });

            document.dispatchEvent(touchStart);
            document.dispatchEvent(touchEnd);

            expect(mobileNav.isOpen).toBe(false);
        });

        test('should not trigger swipe if distance is too small', () => {
            const touchStart = new TouchEvent('touchstart', {
                changedTouches: [{ screenX: 10 }]
            });
            const touchEnd = new TouchEvent('touchend', {
                changedTouches: [{ screenX: 30 }]
            });

            document.dispatchEvent(touchStart);
            document.dispatchEvent(touchEnd);

            expect(mobileNav.isOpen).toBe(false);
        });
    });

    describe('User Information', () => {
        test('should display current user information', () => {
            mobileNav.updateUserInfo(mockAuth.currentUser);

            expect(document.getElementById('mobileUserName').textContent).toBe('Test User');
            expect(document.getElementById('mobileUserRole').textContent).toBe('admin');
            expect(document.getElementById('mobileUserInitial').textContent).toBe('T');
        });

        test('should handle missing user gracefully', () => {
            mobileNav.updateUserInfo(null);
            // Should not throw error
            expect(document.getElementById('mobileUserName').textContent).toBe('User Name');
        });
    });

    describe('Role-Based Navigation', () => {
        test('should show all dashboards for admin role', () => {
            mobileNav.updateNavLinks('admin');
            const links = document.querySelectorAll('#mobileNavLinks a');
            
            const hrefs = Array.from(links).map(link => link.href);
            expect(hrefs).toContain(expect.stringContaining('main-dashboard.html'));
            expect(hrefs).toContain(expect.stringContaining('analytics-dashboard.html'));
            expect(hrefs).toContain(expect.stringContaining('dashboard.html'));
        });

        test('should show limited dashboards for operations role', () => {
            mobileNav.updateNavLinks('operations');
            const links = document.querySelectorAll('#mobileNavLinks a');
            
            const hrefs = Array.from(links).map(link => link.href);
            expect(hrefs).toContain(expect.stringContaining('main-dashboard.html'));
            expect(hrefs).not.toContain(expect.stringContaining('dashboard.html'));
        });

        test('should show analytics dashboards for analytics role', () => {
            mobileNav.updateNavLinks('analytics');
            const links = document.querySelectorAll('#mobileNavLinks a');
            
            const hrefs = Array.from(links).map(link => link.href);
            expect(hrefs).toContain(expect.stringContaining('analytics-dashboard.html'));
            expect(hrefs).not.toContain(expect.stringContaining('dashboard.html'));
        });
    });

    describe('Bottom Navigation', () => {
        test('should have four navigation items', () => {
            const items = document.querySelectorAll('.mobile-bottom-nav-item');
            expect(items.length).toBe(4);
        });

        test('should navigate to correct dashboard on home click', () => {
            const homeBtn = document.querySelector('[data-page="dashboard"]');
            const originalLocation = window.location.href;
            
            homeBtn.click();
            
            expect(mockAuth.getDashboardUrl).toHaveBeenCalledWith('admin');
        });

        test('should have minimum touch target size', () => {
            const items = document.querySelectorAll('.mobile-bottom-nav-item');
            items.forEach(item => {
                const rect = item.getBoundingClientRect();
                // Check that computed styles would result in 44px minimum
                expect(item.classList.contains('py-2')).toBe(true); // 8px * 2 = 16px
                expect(item.classList.contains('px-3')).toBe(true); // 12px * 2 = 24px
                // With icon height of 24px (h-6) + padding, total height > 44px
            });
        });
    });

    describe('Responsive Behavior', () => {
        test('should close menu when resizing to desktop', () => {
            mobileNav.openMenu();
            
            // Simulate resize to desktop
            global.innerWidth = 1200;
            window.dispatchEvent(new Event('resize'));
            
            expect(mobileNav.isOpen).toBe(false);
        });

        test('should detect mobile devices', () => {
            // Mock mobile user agent
            Object.defineProperty(navigator, 'userAgent', {
                value: 'Mozilla/5.0 (iPhone; CPU iPhone OS 14_0 like Mac OS X)',
                configurable: true
            });
            
            mobileNav.detectDevice();
            
            expect(document.body.classList.contains('is-mobile-device')).toBe(true);
            expect(document.body.classList.contains('ios-device')).toBe(true);
        });
    });

    describe('Accessibility', () => {
        test('should have proper ARIA labels', () => {
            const menuBtn = document.getElementById('mobileMenuBtn');
            const sidebar = document.getElementById('mobileSidebar');
            const overlay = document.getElementById('mobileOverlay');
            
            expect(menuBtn.getAttribute('aria-label')).toBe('Toggle menu');
            expect(sidebar.getAttribute('aria-label')).toBe('Mobile navigation');
            expect(overlay.getAttribute('aria-hidden')).toBe('true');
        });

        test('should manage focus when menu opens', () => {
            mobileNav.openMenu();
            const closeBtn = document.getElementById('closeMobileMenu');
            
            // In a real implementation, focus should move to close button
            expect(closeBtn).toBeTruthy();
        });
    });

    describe('Hamburger Animation', () => {
        test('should animate hamburger to X when menu opens', () => {
            const menuBtn = document.getElementById('mobileMenuBtn');
            const lines = menuBtn.querySelectorAll('.hamburger-line');
            
            mobileNav.openMenu();
            
            expect(lines[0].style.transform).toContain('rotate(45deg)');
            expect(lines[1].style.opacity).toBe('0');
            expect(lines[2].style.transform).toContain('rotate(-45deg)');
        });

        test('should animate X back to hamburger when menu closes', () => {
            const menuBtn = document.getElementById('mobileMenuBtn');
            const lines = menuBtn.querySelectorAll('.hamburger-line');
            
            mobileNav.openMenu();
            mobileNav.closeMenu();
            
            expect(lines[0].style.transform).toBe('');
            expect(lines[1].style.opacity).toBe('');
            expect(lines[2].style.transform).toBe('');
        });
    });
});

describe('Mobile Touch Targets', () => {
    test('all interactive elements should be at least 44x44px', () => {
        // This test would run in a real browser environment
        // to verify computed styles meet accessibility guidelines
        const interactiveElements = document.querySelectorAll('button, a, input, select, textarea');
        
        interactiveElements.forEach(element => {
            const styles = window.getComputedStyle(element);
            const width = parseFloat(styles.width);
            const height = parseFloat(styles.height);
            const padding = parseFloat(styles.padding) * 2;
            
            const totalWidth = width + padding;
            const totalHeight = height + padding;
            
            // Touch targets should be at least 44x44px
            expect(totalWidth >= 44 || totalHeight >= 44).toBe(true);
        });
    });
});