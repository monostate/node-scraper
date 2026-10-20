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
 * @property {string|null} vncUrl - vnc:// URL for a live view (null if unavailable)
 * @property {{ host: string, port: number, auth: 'none'|'password', loopbackOnly: boolean }|null} [vnc] - Connection metadata for attaching an authenticated viewer
 * @property {{width: number, height: number}} screenSize - Virtual display dimensions
 * @property {string} [display] - X display (e.g. ":12") when applicable
 * @property {string} [profileDir] - Browser profile directory in use
 */

/**
 * @typedef {Object} ProviderScreenshot
 * @property {string} screenshot - base64 data URL (data:image/png;base64,...)
 * @property {'desktop'|'page'} coordinateSpace - Which coordinates the pixels map to
 * @property {number} width
 * @property {number} height
 * @property {number} dpr - Device pixel ratio of the capture
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
   * Capture a screenshot. `space: 'desktop'` is the whole virtual display
   * (what mouse coordinates address); `space: 'page'` is the browser
   * viewport only. Implementations must report which one they returned.
   * @param {{ space?: 'desktop'|'page' }} [opts]
   * @returns {Promise<ProviderScreenshot>}
   */
  async screenshot({ space = 'desktop' } = {}) { // eslint-disable-line no-unused-vars
    throw new Error('ComputerUseProvider.screenshot() not implemented');
  }

  /**
   * What this provider can do. Sessions use it to pick screenshot spaces and
   * to produce actionable errors instead of silent fallbacks.
   * @returns {Promise<{ desktopScreenshot: boolean, pageScreenshot: boolean, vnc: boolean, nativeInput: boolean }>}
   */
  async getCapabilities() {
    return { desktopScreenshot: false, pageScreenshot: false, vnc: false, nativeInput: true };
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
   * Press a mouse button at (x, y) without releasing it.
   * @param {number} x
   * @param {number} y
   * @param {'left'|'right'|'middle'} [button='left']
   * @returns {Promise<CoordinateActionResult>}
   */
  async mouseDown(x, y, button = 'left') { // eslint-disable-line no-unused-vars
    throw new Error('ComputerUseProvider.mouseDown() not implemented');
  }

  /**
   * Release a mouse button.
   * @param {'left'|'right'|'middle'} [button='left']
   * @returns {Promise<CoordinateActionResult>}
   */
  async mouseUp(button = 'left') { // eslint-disable-line no-unused-vars
    throw new Error('ComputerUseProvider.mouseUp() not implemented');
  }

  /**
   * Drag from (startX, startY) to (endX, endY).
   *
   * Default implementation: move, press, interpolate `steps` moves with a
   * delay between them (HTML5 drag-and-drop needs intermediate motion and
   * time to fire dragstart/dragover), hold, release. Providers with a native
   * drag primitive may override.
   * @param {number} startX
   * @param {number} startY
   * @param {number} endX
   * @param {number} endY
   * @param {{ steps?: number, stepDelayMs?: number, holdMs?: number, button?: 'left'|'right'|'middle' }} [opts]
   * @returns {Promise<CoordinateActionResult>}
   */
  async mouseDrag(startX, startY, endX, endY, { steps = 12, stepDelayMs = 20, holdMs = 100, button = 'left' } = {}) {
    const n = Math.max(1, Math.floor(steps));
    await this.mouseMove(startX, startY);
    await this.mouseDown(startX, startY, button);
    if (holdMs > 0) await this.wait(holdMs);
    for (let i = 1; i <= n; i++) {
      const t = i / n;
      await this.mouseMove(Math.round(startX + (endX - startX) * t), Math.round(startY + (endY - startY) * t));
      if (stepDelayMs > 0) await this.wait(stepDelayMs);
    }
    await this.mouseUp(button);
    return { success: true };
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
   * Press a key or key combination on the DESKTOP (native input: reaches
   * native dialogs and whatever window has X focus). Implementations should
   * accept Puppeteer/W3C names and normalize them with normalizeXdoKey().
   * Page-level key input lives on BrowserSession.pressKey().
   * @param {string} key - e.g. 'Enter', 'ctrl+a', 'Control+Shift+ArrowLeft'
   * @returns {Promise<CoordinateActionResult>}
   */
  async pressKey(key) {
    throw new Error('ComputerUseProvider.pressKey() not implemented');
  }

  /**
   * Type text on the DESKTOP (native input). Page-level typing lives on
   * BrowserSession.typeText().
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
