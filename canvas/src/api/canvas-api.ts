// High-Level Canvas API for Claude
// Provides simple async interface for spawning interactive canvases

import { createIPCServer } from "../ipc/server";
import { getSocketPath } from "../ipc/types";
import { spawnCanvas } from "../terminal";
import type { CanvasMessage, ControllerMessage } from "../ipc/types";
import type {
  MeetingPickerConfig,
  MeetingPickerResult,
  DocumentConfig,
  DocumentSelection,
} from "../scenarios/types";
import type { FlightConfig, FlightResult } from "../canvases/flight/types";
import {
  validateMeetingPickerConfig,
  validateDocumentConfig,
  validateFlightConfig,
  validateBaseCalendarConfig,
  formatValidationErrors,
} from "./validation";
import { timeout, connectionError, failedTo, getErrorMessage } from "../utils/errors";

// Re-export types for API consumers
export type { FlightConfig, FlightResult };

export interface CanvasResult<T = unknown> {
  success: boolean;
  data?: T;
  cancelled?: boolean;
  error?: string;
}

export interface SpawnOptions {
  timeout?: number; // ms, default 5 minutes for user selection
  connectionTimeout?: number; // ms, default 30 seconds for canvas to connect
  onReady?: () => void;
}

/**
 * Spawn an interactive canvas and wait for user selection
 */
export async function spawnCanvasWithIPC<TConfig, TResult>(
  kind: string,
  scenario: string,
  config: TConfig,
  options: SpawnOptions = {}
): Promise<CanvasResult<TResult>> {
  const { timeout: selectionTimeout = 300000, connectionTimeout = 30000, onReady } = options;
  const id = `${kind}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const socketPath = getSocketPath(id);

  let resolved = false;
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  let connectionTimeoutId: ReturnType<typeof setTimeout> | null = null;
  let clientConnected = false;
  let server: Awaited<ReturnType<typeof createIPCServer<CanvasMessage, ControllerMessage>>> | null = null;

  const cleanup = () => {
    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
    if (connectionTimeoutId) {
      clearTimeout(connectionTimeoutId);
      connectionTimeoutId = null;
    }
    if (server) {
      server.close();
    }
  };

  return new Promise((resolve) => {
    const initServer = async () => {
      try {
        // Server receives CanvasMessage from canvas, sends ControllerMessage to canvas
        server = await createIPCServer<CanvasMessage, ControllerMessage>({
          socketPath,
          onClientConnect() {
            // Canvas connected, clear connection timeout
            clientConnected = true;
            if (connectionTimeoutId) {
              clearTimeout(connectionTimeoutId);
              connectionTimeoutId = null;
            }
          },
          onMessage(msg) {
            if (resolved) return;

            switch (msg.type) {
              case "ready":
                onReady?.();
                break;

              case "selected":
                resolved = true;
                cleanup();
                resolve({
                  success: true,
                  data: msg.data as TResult,
                });
                break;

              case "cancelled":
                resolved = true;
                cleanup();
                resolve({
                  success: true,
                  cancelled: true,
                });
                break;

              case "error":
                resolved = true;
                cleanup();
                resolve({
                  success: false,
                  error: failedTo("canvas", "process request", scenario, msg.message),
                });
                break;

              case "pong":
                // Response to ping, ignore
                break;
            }
          },
          onClientDisconnect() {
            if (!resolved) {
              resolved = true;
              cleanup();
              resolve({
                success: false,
                error: connectionError("canvas", "disconnected unexpectedly"),
              });
            }
          },
          onError(error) {
            if (!resolved) {
              resolved = true;
              cleanup();
              resolve({
                success: false,
                error: failedTo("ipc", "communicate with canvas", undefined, error),
              });
            }
          },
        });

        // Set connection timeout - fires if canvas doesn't connect within connectionTimeout
        connectionTimeoutId = setTimeout(() => {
          if (!resolved && !clientConnected) {
            resolved = true;
            cleanup();
            resolve({
              success: false,
              error: timeout("connection", "Canvas connection", connectionTimeout),
            });
          }
        }, connectionTimeout);

        // Set overall timeout for user selection
        timeoutId = setTimeout(() => {
          if (!resolved) {
            resolved = true;
            const closeMsg: ControllerMessage = { type: "close" };
            server?.broadcast(closeMsg);
            cleanup();
            resolve({
              success: false,
              error: timeout("canvas", "User selection", selectionTimeout),
            });
          }
        }, selectionTimeout);

        // Spawn the canvas
        await spawnCanvas(kind, id, JSON.stringify(config), {
          socketPath,
          scenario,
        });
      } catch (err) {
        if (!resolved) {
          resolved = true;
          cleanup();
          resolve({
            success: false,
            error: failedTo("canvas", "spawn canvas", kind, err),
          });
        }
      }
    };

    initServer();
  });
}

/**
 * Spawn a meeting picker canvas
 * Convenience wrapper for the meeting-picker scenario
 */
export async function pickMeetingTime(
  config: MeetingPickerConfig,
  options?: SpawnOptions
): Promise<CanvasResult<MeetingPickerResult>> {
  // Validate config before spawning
  const validation = validateMeetingPickerConfig(config);
  if (!validation.valid) {
    return {
      success: false,
      error: formatValidationErrors(validation),
    };
  }

  return spawnCanvasWithIPC<MeetingPickerConfig, MeetingPickerResult>(
    "calendar",
    "meeting-picker",
    config,
    options
  );
}

/**
 * Display a calendar (non-interactive)
 * Convenience wrapper for the display scenario
 */
export async function displayCalendar(
  config: {
    title?: string;
    events?: Array<{
      id: string;
      title: string;
      startTime: string;
      endTime: string;
      color?: string;
      allDay?: boolean;
    }>;
  },
  options?: SpawnOptions
): Promise<CanvasResult<void>> {
  // Validate config before spawning
  const validation = validateBaseCalendarConfig(config);
  if (!validation.valid) {
    return {
      success: false,
      error: formatValidationErrors(validation),
    };
  }

  return spawnCanvasWithIPC("calendar", "display", config, options);
}

// ============================================
// Document Canvas API
// ============================================

/**
 * Display a document (read-only view)
 * Shows markdown-rendered content with optional diff highlighting
 */
export async function displayDocument(
  config: DocumentConfig,
  options?: SpawnOptions
): Promise<CanvasResult<void>> {
  // Validate config before spawning
  const validation = validateDocumentConfig(config);
  if (!validation.valid) {
    return {
      success: false,
      error: formatValidationErrors(validation),
    };
  }

  return spawnCanvasWithIPC("document", "display", config, options);
}

/**
 * Open a document for editing/selection
 * Returns the selected text when user makes a selection via click-and-drag
 * Selection is sent automatically as the user selects text
 */
export async function editDocument(
  config: DocumentConfig,
  options?: SpawnOptions
): Promise<CanvasResult<DocumentSelection>> {
  // Validate config before spawning
  const validation = validateDocumentConfig(config);
  if (!validation.valid) {
    return {
      success: false,
      error: formatValidationErrors(validation),
    };
  }

  return spawnCanvasWithIPC<DocumentConfig, DocumentSelection>(
    "document",
    "edit",
    config,
    options
  );
}

// ============================================
// Flight Canvas API
// ============================================

/**
 * Open flight booking canvas for flight selection and optional seat selection
 * Returns the selected flight and optional seat
 */
export async function bookFlight(
  config: FlightConfig,
  options?: SpawnOptions
): Promise<CanvasResult<FlightResult>> {
  // Validate config before spawning
  const validation = validateFlightConfig(config);
  if (!validation.valid) {
    return {
      success: false,
      error: formatValidationErrors(validation),
    };
  }

  return spawnCanvasWithIPC<FlightConfig, FlightResult>(
    "flight",
    "booking",
    config,
    options
  );
}
