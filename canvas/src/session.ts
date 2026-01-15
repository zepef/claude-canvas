/**
 * Session Manager for Canvas Virtual Desktop
 *
 * Handles the complete lifecycle of a canvas session:
 * - Creating dedicated virtual desktop
 * - Spawning and managing windows
 * - Persisting state for reconnection
 * - Cleanup on session end
 */

import * as vd from "./virtual-desktop";
import * as wm from "./window-manager";
import type { SessionState, CanvasWindow } from "./window-manager";

const DEFAULT_DESKTOP_NAME = "Canvas Session";

export interface SessionStartOptions {
  name?: string;           // Desktop name (default: "Canvas Session")
  windowCount?: number;    // Number of windows to create (default: 2)
  canvasConfigs?: Array<{  // Optional initial canvas configs for each window
    kind: string;
    config?: unknown;
  }>;
}

export interface SessionInfo {
  isRunning: boolean;
  desktopName?: string;
  desktopIndex?: number;
  mainDesktopIndex?: number;
  windowCount?: number;
  activeCanvases?: number;
  createdAt?: string;
}

/**
 * Check if the VirtualDesktop module is available
 */
export async function checkDependencies(): Promise<{
  moduleInstalled: boolean;
  platform: string;
  ready: boolean;
  error?: string;
}> {
  const platform = process.platform;

  if (platform !== "win32") {
    return {
      moduleInstalled: false,
      platform,
      ready: false,
      error: "Virtual desktop sessions are only supported on Windows",
    };
  }

  const moduleInstalled = await vd.isModuleInstalled();

  if (!moduleInstalled) {
    return {
      moduleInstalled: false,
      platform,
      ready: false,
      error: "VirtualDesktop PowerShell module is not installed. Run: Install-Module VirtualDesktop -Scope CurrentUser",
    };
  }

  return {
    moduleInstalled: true,
    platform,
    ready: true,
  };
}

/**
 * Get current session info
 */
export async function getSessionInfo(): Promise<SessionInfo> {
  const session = await wm.loadSession();

  if (!session) {
    return { isRunning: false };
  }

  // Verify the desktop still exists
  try {
    const desktops = await vd.listDesktops();
    const exists = desktops.some(d => d.index === session.desktopIndex);

    if (!exists) {
      // Desktop was removed externally
      await wm.deleteSession();
      return { isRunning: false };
    }

    // Get window status
    const status = await wm.getSessionStatus(session);

    return {
      isRunning: true,
      desktopName: session.desktopName,
      desktopIndex: session.desktopIndex,
      mainDesktopIndex: session.mainDesktopIndex,
      windowCount: status.windowCount,
      activeCanvases: status.activeCanvases,
      createdAt: session.createdAt,
    };
  } catch {
    return { isRunning: false };
  }
}

/**
 * Start a new canvas session
 */
export async function startSession(options: SessionStartOptions = {}): Promise<SessionState> {
  // Check if session already running
  const existing = await wm.loadSession();
  if (existing) {
    // Verify it's still valid
    const info = await getSessionInfo();
    if (info.isRunning) {
      throw new Error("A canvas session is already running. Stop it first with 'canvas session stop'");
    }
    // Stale session, clean up
    await wm.deleteSession();
  }

  // Check dependencies
  const deps = await checkDependencies();
  if (!deps.ready) {
    throw new Error(deps.error || "Dependencies not met");
  }

  const desktopName = options.name || DEFAULT_DESKTOP_NAME;
  const windowCount = options.windowCount || 2;

  // Remember current desktop
  const mainDesktopIndex = await vd.getCurrentDesktopIndex();

  // Check if canvas desktop already exists
  let desktopIndex = await vd.findDesktopByName(desktopName);

  if (desktopIndex === null) {
    // Create new desktop
    desktopIndex = await vd.createDesktop(desktopName);
    console.log(`Created virtual desktop "${desktopName}" at index ${desktopIndex}`);
  } else {
    console.log(`Found existing desktop "${desktopName}" at index ${desktopIndex}`);
  }

  // Create session state
  const session: SessionState = {
    desktopIndex,
    desktopName,
    mainDesktopIndex,
    windows: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  // Switch to canvas desktop
  await vd.switchToDesktop(desktopIndex);

  // Spawn windows
  const canvasConfigs = options.canvasConfigs || [];

  for (let i = 0; i < windowCount; i++) {
    const windowId = wm.generateWindowId();
    const config = canvasConfigs[i];

    let window: CanvasWindow;

    if (config) {
      // Spawn with initial canvas
      const configJson = config.config ? JSON.stringify(config.config) : undefined;
      window = await wm.spawnCanvasWindow(windowId, config.kind, configJson);
    } else {
      // Spawn empty window
      const { title } = await wm.spawnEmptyWindow(windowId);

      // Wait for handle
      const handle = await wm.waitForWindowHandle(title);
      if (!handle) {
        console.error(`Warning: Could not get handle for window ${windowId}`);
        continue;
      }

      window = {
        id: windowId,
        canvasId: null,
        canvasKind: null,
        windowHandle: handle,
        title,
        desktopIndex,
      };
    }

    // Move window to canvas desktop (in case it opened elsewhere)
    try {
      await vd.moveWindowToDesktop(window.windowHandle, desktopIndex);
      window.desktopIndex = desktopIndex;
    } catch (err) {
      console.error(`Warning: Could not move window ${windowId} to canvas desktop`);
    }

    session.windows.push(window);
    console.log(`  Created window ${i + 1}/${windowCount}: ${window.id}${window.canvasKind ? ` (${window.canvasKind})` : ""}`);
  }

  // Save session
  await wm.saveSession(session);

  return session;
}

/**
 * Stop the current session
 */
export async function stopSession(options: {
  removeDesktop?: boolean;
} = {}): Promise<void> {
  const session = await wm.loadSession();

  if (!session) {
    console.log("No active session to stop");
    return;
  }

  console.log("Stopping canvas session...");

  // Switch back to main desktop first
  try {
    await vd.switchToDesktop(session.mainDesktopIndex);
    console.log(`  Switched back to desktop ${session.mainDesktopIndex}`);
  } catch {
    // May fail if desktop no longer exists
  }

  // Close all windows
  for (const window of session.windows) {
    try {
      await wm.closeCanvasWindow(window);
      console.log(`  Closed window ${window.id}`);
    } catch {
      // Window may already be closed
    }
  }

  // Optionally remove the desktop
  if (options.removeDesktop !== false) {
    try {
      await vd.removeDesktop(session.desktopIndex);
      console.log(`  Removed desktop "${session.desktopName}"`);
    } catch (err) {
      console.log(`  Could not remove desktop: ${err}`);
    }
  }

  // Delete session file
  await wm.deleteSession();
  console.log("Session stopped");
}

/**
 * Add a window to the current session
 */
export async function addWindow(canvasKind?: string, config?: unknown): Promise<CanvasWindow> {
  const session = await wm.loadSession();
  if (!session) {
    throw new Error("No active session. Start one with 'canvas session start'");
  }

  const windowId = wm.generateWindowId();

  let window: CanvasWindow;

  if (canvasKind) {
    const configJson = config ? JSON.stringify(config) : undefined;
    window = await wm.spawnCanvasWindow(windowId, canvasKind, configJson);
  } else {
    const { title } = await wm.spawnEmptyWindow(windowId);
    const handle = await wm.waitForWindowHandle(title);

    if (!handle) {
      throw new Error("Could not get window handle");
    }

    window = {
      id: windowId,
      canvasId: null,
      canvasKind: null,
      windowHandle: handle,
      title,
      desktopIndex: session.desktopIndex,
    };
  }

  // Move to canvas desktop
  await vd.moveWindowToDesktop(window.windowHandle, session.desktopIndex);
  window.desktopIndex = session.desktopIndex;

  // Update session
  session.windows.push(window);
  await wm.saveSession(session);

  return window;
}

/**
 * Close a window from the current session
 */
export async function closeWindow(windowId: string): Promise<void> {
  const session = await wm.loadSession();
  if (!session) {
    throw new Error("No active session");
  }

  const window = session.windows.find(w => w.id === windowId);
  if (!window) {
    throw new Error(`Window not found: ${windowId}`);
  }

  await wm.closeCanvasWindow(window);

  // Remove from session
  session.windows = session.windows.filter(w => w.id !== windowId);
  await wm.saveSession(session);
}

/**
 * Assign a canvas to a window
 */
export async function assignCanvas(
  windowId: string,
  canvasKind: string,
  config?: unknown
): Promise<CanvasWindow> {
  const session = await wm.loadSession();
  if (!session) {
    throw new Error("No active session");
  }

  const windowIndex = session.windows.findIndex(w => w.id === windowId);
  if (windowIndex === -1) {
    throw new Error(`Window not found: ${windowId}`);
  }

  const window = session.windows[windowIndex];
  if (!window) {
    throw new Error(`Window at index ${windowIndex} not found`);
  }
  const configJson = config ? JSON.stringify(config) : undefined;

  const updated = await wm.assignCanvas(window, canvasKind, configJson);

  // Update session
  session.windows[windowIndex] = updated;
  await wm.saveSession(session);

  return updated;
}

/**
 * Swap canvases between two windows
 */
export async function swapCanvases(
  windowId1: string,
  windowId2: string
): Promise<void> {
  const session = await wm.loadSession();
  if (!session) {
    throw new Error("No active session");
  }

  const index1 = session.windows.findIndex(w => w.id === windowId1);
  const index2 = session.windows.findIndex(w => w.id === windowId2);

  if (index1 === -1) throw new Error(`Window not found: ${windowId1}`);
  if (index2 === -1) throw new Error(`Window not found: ${windowId2}`);

  const win1 = session.windows[index1];
  const win2 = session.windows[index2];
  if (!win1 || !win2) {
    throw new Error("Window not found at expected index");
  }

  const [updated1, updated2] = await wm.swapCanvases(win1, win2);

  session.windows[index1] = updated1;
  session.windows[index2] = updated2;
  await wm.saveSession(session);
}

/**
 * List all windows in the current session
 */
export async function listWindows(): Promise<CanvasWindow[]> {
  const session = await wm.loadSession();
  if (!session) {
    return [];
  }

  // Refresh handles to check which windows are still alive
  session.windows = await wm.refreshWindowHandles(session.windows);
  await wm.saveSession(session);

  return session.windows;
}

/**
 * Focus a specific window
 */
export async function focusWindow(windowId: string): Promise<void> {
  const session = await wm.loadSession();
  if (!session) {
    throw new Error("No active session");
  }

  const window = session.windows.find(w => w.id === windowId);
  if (!window) {
    throw new Error(`Window not found: ${windowId}`);
  }

  await wm.focusCanvasWindow(window);
}

/**
 * Switch to the canvas desktop
 */
export async function switchToCanvasDesktop(): Promise<void> {
  const session = await wm.loadSession();
  if (!session) {
    throw new Error("No active session");
  }

  await vd.switchToDesktop(session.desktopIndex);
}

/**
 * Switch to the main (original) desktop
 */
export async function switchToMainDesktop(): Promise<void> {
  const session = await wm.loadSession();
  if (!session) {
    throw new Error("No active session");
  }

  await vd.switchToDesktop(session.mainDesktopIndex);
}

/**
 * Reconnect to an existing session
 * Useful after restarting Claude Code
 */
export async function reconnectSession(): Promise<SessionState | null> {
  const session = await wm.loadSession();
  if (!session) {
    return null;
  }

  // Verify desktop exists
  const desktops = await vd.listDesktops();
  if (!desktops.some(d => d.index === session.desktopIndex)) {
    console.log("Canvas desktop no longer exists, cleaning up session");
    await wm.deleteSession();
    return null;
  }

  // Refresh window handles
  session.windows = await wm.refreshWindowHandles(session.windows);

  if (session.windows.length === 0) {
    console.log("No windows remaining, cleaning up session");
    await wm.deleteSession();
    return null;
  }

  await wm.saveSession(session);
  return session;
}

/**
 * Get detailed session status
 */
export async function getDetailedStatus(): Promise<{
  session: SessionState | null;
  status: Awaited<ReturnType<typeof wm.getSessionStatus>>;
} | null> {
  const session = await wm.loadSession();
  if (!session) {
    return null;
  }

  const status = await wm.getSessionStatus(session);
  return { session, status };
}
