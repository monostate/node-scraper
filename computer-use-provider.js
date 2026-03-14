/**
 * Abstract base class for computer-use providers.
 *
 * A provider manages a display server (e.g. Xvfb), a browser (Chrome),
 * and optionally a VNC server. It exposes coordinate-based actions
 * (mouse, keyboard) and screenshots for AI computer-use agents.
 *
 * Open-source implementations:
 *   - LocalProvider: spawns Xvfb + Chrome + xdotool on the local machine
 *
 * To build your own provider (Docker, Kubernetes, cloud VMs, etc.),
 * extend this class and implement all methods.
 *
 * @example
 * import { ComputerUseProvider } from '@monostate/node-scraper';
 *
 * class MyCloudProvider extends ComputerUseProvider {
 *   async start() {
 *     // spin up a VM, return CDP URL
 *     return { cdpUrl: 'ws://...', vncUrl: 'https://...', screenSize: { width: 1280, height: 800 } };
 *   }
 *   // ... implement all other methods ...
 * }
 */

/**
 * @typedef {Object} ProviderInfo
 * @property {string} cdpUrl - WebSocket URL for Chrome DevTools Protocol (ws://...)
 * @property {string|null} vncUrl - noVNC URL for live browser view (null if unavailable)
 * @property {{width: number, height: number}} screenSize - Virtual display dimensions
 */

/**
 * @typedef {Object} CoordinateActionResult
 * @property {boolean} success
 * @property {string} [screenshot] - base64 data URL of screenshot after action (optional)
 * @property {string} [error] - error message if failed
 */

export class ComputerUseProvider {
  /**
   * Start the environment: display server, browser, VNC, etc.
   * @returns {Promise<ProviderInfo>}
   */
  async start() {
    throw new Error('ComputerUseProvider.start() not implemented');
  }

  /**
   * Stop the environment and release all resources.
   * @returns {Promise<void>}
   */
  async stop() {
    throw new Error('ComputerUseProvider.stop() not implemented');
  }

  /**
   * Capture a screenshot of the full virtual display.
   * @returns {Promise<{screenshot: string}>} base64 data URL (data:image/png;base64,...)
   */
  async screenshot() {
    throw new Error('ComputerUseProvider.screenshot() not implemented');
  }

  // ── Coordinate-based actions ──────────────────────────────

  /**
   * Move the mouse cursor to (x, y).
   * @param {number} x
   * @param {number} y
   * @returns {Promise<CoordinateActionResult>}
   */
  async mouseMove(x, y) {
    throw new Error('ComputerUseProvider.mouseMove() not implemented');
  }

  /**
   * Click at (x, y).
   * @param {number} x
   * @param {number} y
   * @param {'left'|'right'|'middle'} [button='left']
   * @returns {Promise<CoordinateActionResult>}
   */
  async mouseClick(x, y, button = 'left') {
    throw new Error('ComputerUseProvider.mouseClick() not implemented');
  }

  /**
   * Double-click at (x, y).
   * @param {number} x
   * @param {number} y
   * @param {'left'|'right'|'middle'} [button='left']
   * @returns {Promise<CoordinateActionResult>}
   */
  async mouseDoubleClick(x, y, button = 'left') {
    throw new Error('ComputerUseProvider.mouseDoubleClick() not implemented');
  }

  /**
   * Drag from (startX, startY) to (endX, endY).
   * @param {number} startX
   * @param {number} startY
   * @param {number} endX
   * @param {number} endY
   * @returns {Promise<CoordinateActionResult>}
   */
  async mouseDrag(startX, startY, endX, endY) {
    throw new Error('ComputerUseProvider.mouseDrag() not implemented');
  }

  /**
   * Scroll at (x, y) in a direction.
   * @param {number} x
   * @param {number} y
   * @param {'up'|'down'} direction
   * @param {number} [amount=3] - number of scroll steps
   * @returns {Promise<CoordinateActionResult>}
   */
  async scroll(x, y, direction, amount = 3) {
    throw new Error('ComputerUseProvider.scroll() not implemented');
  }

  /**
   * Press a key or key combination (e.g. 'Return', 'ctrl+c', 'alt+Tab').
   * @param {string} key - xdotool-compatible key name
   * @returns {Promise<CoordinateActionResult>}
   */
  async pressKey(key) {
    throw new Error('ComputerUseProvider.pressKey() not implemented');
  }

  /**
   * Type text character by character.
   * @param {string} text
   * @returns {Promise<CoordinateActionResult>}
   */
  async typeText(text) {
    throw new Error('ComputerUseProvider.typeText() not implemented');
  }

  /**
   * Wait for a duration.
   * @param {number} ms - milliseconds to wait
   * @returns {Promise<CoordinateActionResult>}
   */
  async wait(ms) {
    await new Promise(resolve => setTimeout(resolve, ms));
    return { success: true };
  }

  /**
   * Get the current cursor position.
   * @returns {Promise<{x: number, y: number}>}
   */
  async getCursorPosition() {
    throw new Error('ComputerUseProvider.getCursorPosition() not implemented');
  }

  /**
   * Get the virtual display dimensions.
   * @returns {Promise<{width: number, height: number}>}
   */
  async getScreenSize() {
    throw new Error('ComputerUseProvider.getScreenSize() not implemented');
  }
}

export default ComputerUseProvider;
