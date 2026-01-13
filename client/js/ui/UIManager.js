/**
 * Manages DOM element lifecycle to prevent duplicates and memory leaks
 * Centralizes all DOM manipulation with proper cleanup
 */
class UIManager {
    constructor() {
        this.elements = new Map();      // id -> element
        this.eventCleanups = [];        // cleanup functions for event listeners
        this.activeModals = new Set();  // track open modals
    }

    /**
     * Create or get existing element
     * @param {string} id - Element ID
     * @param {string} tagName - HTML tag name
     * @param {HTMLElement} parent - Parent element
     * @returns {HTMLElement}
     */
    getOrCreate(id, tagName, parent = document.body) {
        let element = this.elements.get(id);

        if (!element || !document.contains(element)) {
            element = document.createElement(tagName);
            element.id = id;
            parent.appendChild(element);
            this.elements.set(id, element);
        }

        return element;
    }

    /**
     * Create element with class
     * @param {string} id - Element ID
     * @param {string} tagName - HTML tag name
     * @param {string} className - CSS class name
     * @param {HTMLElement} parent - Parent element
     * @returns {HTMLElement}
     */
    createWithClass(id, tagName, className, parent = document.body) {
        const element = this.getOrCreate(id, tagName, parent);
        element.className = className;
        return element;
    }

    /**
     * Get element by ID
     * @param {string} id - Element ID
     * @returns {HTMLElement|undefined}
     */
    get(id) {
        return this.elements.get(id);
    }

    /**
     * Remove element by ID
     * @param {string} id - Element ID
     */
    remove(id) {
        const element = this.elements.get(id);
        if (element) {
            element.remove();
            this.elements.delete(id);
        }
    }

    /**
     * Add event listener with automatic cleanup tracking
     * @param {HTMLElement} element - Target element
     * @param {string} event - Event name
     * @param {Function} handler - Event handler
     * @returns {Function} - Cleanup function
     */
    addEventListener(element, event, handler) {
        element.addEventListener(event, handler);

        const cleanup = () => {
            element.removeEventListener(event, handler);
        };

        this.eventCleanups.push(cleanup);
        return cleanup;
    }

    /**
     * Show element
     * @param {string} id - Element ID
     */
    show(id) {
        const element = this.elements.get(id);
        if (element) {
            element.style.display = '';
            element.classList.remove('hidden');
        }
    }

    /**
     * Hide element
     * @param {string} id - Element ID
     */
    hide(id) {
        const element = this.elements.get(id);
        if (element) {
            element.style.display = 'none';
            element.classList.add('hidden');
        }
    }

    /**
     * Toggle element visibility
     * @param {string} id - Element ID
     * @returns {boolean} - New visibility state
     */
    toggle(id) {
        const element = this.elements.get(id);
        if (element) {
            const isHidden = element.style.display === 'none';
            element.style.display = isHidden ? '' : 'none';
            return isHidden;
        }
        return false;
    }

    /**
     * Set element text content
     * @param {string} id - Element ID
     * @param {string} text - Text content
     */
    setText(id, text) {
        const element = this.elements.get(id);
        if (element) {
            element.textContent = text;
        }
    }

    /**
     * Set element HTML content
     * @param {string} id - Element ID
     * @param {string} html - HTML content
     */
    setHTML(id, html) {
        const element = this.elements.get(id);
        if (element) {
            element.innerHTML = html;
        }
    }

    /**
     * Show a modal dialog
     * @param {string} id - Modal ID
     * @param {string} content - HTML content
     * @param {Object} options - Modal options
     * @returns {HTMLElement}
     */
    showModal(id, content, options = {}) {
        const modal = this.createWithClass(id, 'div', 'modal-overlay');
        modal.innerHTML = `
            <div class="modal-content ${options.className || ''}">
                ${options.closable !== false ? '<button class="modal-close">&times;</button>' : ''}
                ${content}
            </div>
        `;

        if (options.closable !== false) {
            const closeBtn = modal.querySelector('.modal-close');
            this.addEventListener(closeBtn, 'click', () => this.closeModal(id));

            // Close on overlay click
            this.addEventListener(modal, 'click', (e) => {
                if (e.target === modal) {
                    this.closeModal(id);
                }
            });
        }

        this.activeModals.add(id);
        return modal;
    }

    /**
     * Close modal
     * @param {string} id - Modal ID
     */
    closeModal(id) {
        this.remove(id);
        this.activeModals.delete(id);
    }

    /**
     * Close all modals
     */
    closeAllModals() {
        for (const id of this.activeModals) {
            this.remove(id);
        }
        this.activeModals.clear();
    }

    /**
     * Show error toast
     * @param {string} message - Error message
     * @param {number} duration - Display duration in ms
     */
    showError(message, duration = 3000) {
        const toast = this.createWithClass('error-toast', 'div', 'error-toast');
        toast.textContent = message;

        setTimeout(() => {
            toast.classList.add('fade-out');
            setTimeout(() => this.remove('error-toast'), 300);
        }, duration);
    }

    /**
     * Show success toast
     * @param {string} message - Success message
     * @param {number} duration - Display duration in ms
     */
    showSuccess(message, duration = 3000) {
        const toast = this.createWithClass('success-toast', 'div', 'success-toast');
        toast.textContent = message;

        setTimeout(() => {
            toast.classList.add('fade-out');
            setTimeout(() => this.remove('success-toast'), 300);
        }, duration);
    }

    /**
     * Clean up specific category of elements
     * @param {string} prefix - ID prefix to match
     */
    cleanupByPrefix(prefix) {
        for (const [id, element] of this.elements) {
            if (id.startsWith(prefix)) {
                element.remove();
                this.elements.delete(id);
            }
        }
    }

    /**
     * Clean up all game-related UI elements
     */
    cleanupGameUI() {
        const gamePrefixes = ['bid-', 'score-', 'trick-', 'player-', 'turn-'];
        gamePrefixes.forEach(prefix => this.cleanupByPrefix(prefix));
    }

    /**
     * Clean up all tracked elements and listeners
     */
    cleanup() {
        // Remove event listeners
        this.eventCleanups.forEach(cleanup => cleanup());
        this.eventCleanups = [];

        // Remove all elements
        for (const element of this.elements.values()) {
            element.remove();
        }
        this.elements.clear();
        this.activeModals.clear();
    }

    /**
     * Get count of tracked elements (for debugging)
     * @returns {number}
     */
    getElementCount() {
        return this.elements.size;
    }
}

// Singleton instance
const uiManager = new UIManager();
export default uiManager;
