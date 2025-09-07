/**
 * Mobile Navigation Component for Sierra Sync Platform
 * Provides responsive navigation with hamburger menu for mobile devices
 */

class MobileNav {
    constructor() {
        this.isOpen = false;
        this.touchStartX = 0;
        this.touchEndX = 0;
        this.init();
    }

    init() {
        // Wait for DOM to be ready
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', () => this.setup());
        } else {
            this.setup();
        }
    }

    setup() {
        this.createMobileNavHTML();
        this.attachEventListeners();
        this.detectDevice();
    }

    createMobileNavHTML() {
        // Check if mobile nav already exists
        if (document.getElementById('mobileNavContainer')) return;

        const mobileNavHTML = `
            <!-- Mobile Navigation Container -->
            <div id="mobileNavContainer" class="lg:hidden">
                <!-- Hamburger Button -->
                <button id="mobileMenuBtn" 
                    class="fixed top-4 left-4 z-50 p-3 bg-white rounded-lg shadow-lg lg:hidden"
                    aria-label="Toggle menu">
                    <div class="w-6 h-5 flex flex-col justify-between">
                        <span class="hamburger-line block w-full h-0.5 bg-gray-800 transition-all duration-300"></span>
                        <span class="hamburger-line block w-full h-0.5 bg-gray-800 transition-all duration-300"></span>
                        <span class="hamburger-line block w-full h-0.5 bg-gray-800 transition-all duration-300"></span>
                    </div>
                </button>

                <!-- Mobile Sidebar Overlay -->
                <div id="mobileOverlay" 
                    class="fixed inset-0 bg-black bg-opacity-50 z-40 hidden transition-opacity duration-300"
                    aria-hidden="true"></div>

                <!-- Mobile Sidebar -->
                <nav id="mobileSidebar" 
                    class="fixed top-0 left-0 h-full w-72 bg-white shadow-xl z-50 transform -translate-x-full transition-transform duration-300 ease-in-out"
                    aria-label="Mobile navigation">
                    
                    <!-- Sidebar Header -->
                    <div class="p-6 border-b border-gray-200">
                        <div class="flex items-center justify-between">
                            <div class="flex items-center">
                                <div class="h-10 w-10 bg-gradient-to-r from-blue-500 to-purple-600 rounded-lg flex items-center justify-center">
                                    <span class="text-white font-bold text-xl">S</span>
                                </div>
                                <h2 class="ml-3 text-xl font-bold text-gray-800">Sierra Sync</h2>
                            </div>
                            <button id="closeMobileMenu" 
                                class="p-2 rounded-lg hover:bg-gray-100 transition-colors"
                                aria-label="Close menu">
                                <svg class="w-5 h-5 text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path>
                                </svg>
                            </button>
                        </div>
                    </div>

                    <!-- User Info -->
                    <div class="p-6 border-b border-gray-200">
                        <div class="flex items-center">
                            <div class="h-12 w-12 rounded-full bg-gradient-to-r from-blue-500 to-purple-600 flex items-center justify-center">
                                <span id="mobileUserInitial" class="text-white font-semibold text-lg">U</span>
                            </div>
                            <div class="ml-3">
                                <p id="mobileUserName" class="text-sm font-semibold text-gray-800">User Name</p>
                                <p id="mobileUserRole" class="text-xs text-gray-500">Role</p>
                            </div>
                        </div>
                    </div>

                    <!-- Navigation Links -->
                    <div class="p-6">
                        <ul class="space-y-2" id="mobileNavLinks">
                            <!-- Links will be dynamically inserted based on user role -->
                        </ul>
                    </div>

                    <!-- Bottom Actions -->
                    <div class="absolute bottom-0 left-0 right-0 p-6 border-t border-gray-200">
                        <button onclick="auth.logout()" 
                            class="w-full bg-red-600 text-white py-3 px-4 rounded-lg hover:bg-red-700 transition-colors flex items-center justify-center">
                            <svg class="w-5 h-5 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1"></path>
                            </svg>
                            Logout
                        </button>
                    </div>
                </nav>
            </div>

            <!-- Mobile Bottom Navigation Bar -->
            <nav id="mobileBottomNav" 
                class="fixed bottom-0 left-0 right-0 bg-white border-t border-gray-200 z-30 lg:hidden"
                aria-label="Mobile bottom navigation">
                <div class="grid grid-cols-4 gap-1">
                    <button class="mobile-bottom-nav-item py-2 px-3 flex flex-col items-center justify-center hover:bg-gray-50 transition-colors"
                        data-page="dashboard">
                        <svg class="w-6 h-6 mb-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6"></path>
                        </svg>
                        <span class="text-xs">Home</span>
                    </button>
                    <button class="mobile-bottom-nav-item py-2 px-3 flex flex-col items-center justify-center hover:bg-gray-50 transition-colors"
                        data-page="analytics">
                        <svg class="w-6 h-6 mb-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"></path>
                        </svg>
                        <span class="text-xs">Analytics</span>
                    </button>
                    <button class="mobile-bottom-nav-item py-2 px-3 flex flex-col items-center justify-center hover:bg-gray-50 transition-colors"
                        data-page="profile">
                        <svg class="w-6 h-6 mb-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"></path>
                        </svg>
                        <span class="text-xs">Profile</span>
                    </button>
                    <button class="mobile-bottom-nav-item py-2 px-3 flex flex-col items-center justify-center hover:bg-gray-50 transition-colors"
                        onclick="this.openMobileMenu()">
                        <svg class="w-6 h-6 mb-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h16"></path>
                        </svg>
                        <span class="text-xs">Menu</span>
                    </button>
                </div>
            </nav>
        `;

        // Insert the mobile nav at the beginning of body
        document.body.insertAdjacentHTML('afterbegin', mobileNavHTML);
    }

    attachEventListeners() {
        // Hamburger menu button
        const menuBtn = document.getElementById('mobileMenuBtn');
        if (menuBtn) {
            menuBtn.addEventListener('click', () => this.toggleMenu());
        }

        // Close button
        const closeBtn = document.getElementById('closeMobileMenu');
        if (closeBtn) {
            closeBtn.addEventListener('click', () => this.closeMenu());
        }

        // Overlay click
        const overlay = document.getElementById('mobileOverlay');
        if (overlay) {
            overlay.addEventListener('click', () => this.closeMenu());
        }

        // Swipe gestures
        this.addSwipeGestures();

        // Bottom nav items
        const bottomNavItems = document.querySelectorAll('.mobile-bottom-nav-item');
        bottomNavItems.forEach(item => {
            item.addEventListener('click', (e) => this.handleBottomNavClick(e));
        });

        // Handle window resize
        window.addEventListener('resize', () => this.handleResize());
    }

    toggleMenu() {
        this.isOpen ? this.closeMenu() : this.openMenu();
    }

    openMenu() {
        const sidebar = document.getElementById('mobileSidebar');
        const overlay = document.getElementById('mobileOverlay');
        const menuBtn = document.getElementById('mobileMenuBtn');

        if (sidebar && overlay) {
            sidebar.classList.remove('-translate-x-full');
            overlay.classList.remove('hidden');
            this.isOpen = true;

            // Animate hamburger to X
            if (menuBtn) {
                menuBtn.classList.add('menu-open');
                const lines = menuBtn.querySelectorAll('.hamburger-line');
                if (lines.length === 3) {
                    lines[0].style.transform = 'rotate(45deg) translateY(9px)';
                    lines[1].style.opacity = '0';
                    lines[2].style.transform = 'rotate(-45deg) translateY(-9px)';
                }
            }

            // Prevent body scroll when menu is open
            document.body.style.overflow = 'hidden';
        }
    }

    closeMenu() {
        const sidebar = document.getElementById('mobileSidebar');
        const overlay = document.getElementById('mobileOverlay');
        const menuBtn = document.getElementById('mobileMenuBtn');

        if (sidebar && overlay) {
            sidebar.classList.add('-translate-x-full');
            overlay.classList.add('hidden');
            this.isOpen = false;

            // Animate X back to hamburger
            if (menuBtn) {
                menuBtn.classList.remove('menu-open');
                const lines = menuBtn.querySelectorAll('.hamburger-line');
                if (lines.length === 3) {
                    lines[0].style.transform = '';
                    lines[1].style.opacity = '';
                    lines[2].style.transform = '';
                }
            }

            // Restore body scroll
            document.body.style.overflow = '';
        }
    }

    addSwipeGestures() {
        // Add swipe to open from left edge
        document.addEventListener('touchstart', (e) => {
            this.touchStartX = e.changedTouches[0].screenX;
        }, { passive: true });

        document.addEventListener('touchend', (e) => {
            this.touchEndX = e.changedTouches[0].screenX;
            this.handleSwipe();
        }, { passive: true });
    }

    handleSwipe() {
        const swipeDistance = this.touchEndX - this.touchStartX;
        const minSwipeDistance = 50;

        // Swipe right from left edge to open
        if (this.touchStartX < 20 && swipeDistance > minSwipeDistance && !this.isOpen) {
            this.openMenu();
        }
        // Swipe left to close
        else if (swipeDistance < -minSwipeDistance && this.isOpen) {
            this.closeMenu();
        }
    }

    handleBottomNavClick(e) {
        const button = e.currentTarget;
        const page = button.dataset.page;
        
        if (page === 'dashboard') {
            window.location.href = auth.currentUser ? auth.getDashboardUrl(auth.currentUser.role) : 'main-dashboard.html';
        } else if (page === 'analytics') {
            window.location.href = 'analytics-dashboard.html';
        } else if (page === 'profile') {
            window.location.href = 'profile.html';
        }
    }

    handleResize() {
        // Close menu if window is resized to desktop size
        if (window.innerWidth >= 1024 && this.isOpen) {
            this.closeMenu();
        }
    }

    detectDevice() {
        const userAgent = navigator.userAgent.toLowerCase();
        const isMobile = /mobile|android|iphone|ipad|ipod|blackberry|windows phone/.test(userAgent);
        
        if (isMobile) {
            document.body.classList.add('is-mobile-device');
        }

        // Add iOS-specific class for handling safe areas
        if (/iphone|ipad|ipod/.test(userAgent)) {
            document.body.classList.add('ios-device');
        }
    }

    updateUserInfo(user) {
        if (!user) return;

        const nameEl = document.getElementById('mobileUserName');
        const roleEl = document.getElementById('mobileUserRole');
        const initialEl = document.getElementById('mobileUserInitial');

        if (nameEl) nameEl.textContent = user.name || 'User';
        if (roleEl) roleEl.textContent = user.role || 'Guest';
        if (initialEl) initialEl.textContent = (user.name || 'U')[0].toUpperCase();

        // Update navigation links based on role
        this.updateNavLinks(user.role);
    }

    updateNavLinks(role) {
        const navLinks = document.getElementById('mobileNavLinks');
        if (!navLinks) return;

        let links = [
            { href: 'main-dashboard.html', icon: 'home', label: 'Operations Dashboard', roles: ['operations', 'admin', 'analytics'] },
            { href: 'analytics-dashboard.html', icon: 'chart', label: 'Analytics Dashboard', roles: ['analytics', 'admin'] },
            { href: 'dashboard.html', icon: 'settings', label: 'Admin Dashboard', roles: ['admin'] },
            { href: 'profile.html', icon: 'user', label: 'Profile', roles: ['operations', 'admin', 'analytics'] },
        ];

        const filteredLinks = links.filter(link => link.roles.includes(role));

        navLinks.innerHTML = filteredLinks.map(link => `
            <li>
                <a href="${link.href}" 
                   class="flex items-center px-4 py-3 text-gray-700 hover:bg-gray-100 rounded-lg transition-colors">
                    <svg class="w-5 h-5 mr-3 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        ${this.getIconPath(link.icon)}
                    </svg>
                    <span class="font-medium">${link.label}</span>
                </a>
            </li>
        `).join('');
    }

    getIconPath(icon) {
        const icons = {
            home: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6"></path>',
            chart: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"></path>',
            settings: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"></path><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"></path>',
            user: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"></path>'
        };
        return icons[icon] || icons.home;
    }
}

// Initialize mobile navigation
window.mobileNav = new MobileNav();

// Export for module usage
if (typeof module !== 'undefined' && module.exports) {
    module.exports = MobileNav;
}