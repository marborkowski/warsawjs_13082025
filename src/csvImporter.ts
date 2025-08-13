import Papa from "papaparse";
import { db, type Row } from "./db";

/**
 * Configuration options for CSV import operation.
 */
export interface ImportOptions {
  /** AbortSignal to cancel the import operation */
  readonly signal?: AbortSignal;
  /** Callback to report import progress */
  readonly onProgress?: (rowsImported: number) => void;
  /** Custom batch size for database operations (default: 100) */
  readonly batchSize?: number;
  /** Custom chunk size for Papa Parse in bytes (default: 256KB) */
  readonly chunkSizeBytes?: number;
}

/**
 * Extended Papa Parse interface to access worker support flag.
 */
interface PapaParseWithWorkerSupport {
  WORKERS_SUPPORTED?: boolean;
}

/**
 * Global object interface with optional requestIdleCallback.
 */
interface GlobalWithIdleCallback {
  requestIdleCallback?: (
    callback: () => void,
    options?: { timeout?: number }
  ) => number;
}

/**
 * Internal configuration constants with clear rationale.
 */
const CONFIG = {
  /** Default batch size - balance between memory usage and transaction overhead */
  DEFAULT_BATCH_SIZE: 100,
  /** Default chunk size - keeps memory usage predictable while maintaining performance */
  DEFAULT_CHUNK_SIZE_BYTES: 256 * 1024, // 256KB
  /** Timeout to detect parsing issues and fallback to worker mode */
  PROGRESS_TIMEOUT_MS: 2000,
  /** Identifier for no-progress error handling */
  NO_PROGRESS_ERROR: "NO_PROGRESS" as const,
} as const;

/**
 * Custom error types for better error handling.
 */
class ImportError extends Error {
  readonly cause?: Error;

  constructor(message: string, cause?: Error) {
    super(message);
    this.name = "ImportError";
    this.cause = cause;
  }
}

class ImportAbortedError extends DOMException {
  constructor() {
    super("Import operation was aborted", "AbortError");
    Object.defineProperty(this, "name", {
      value: "ImportAbortedError",
      configurable: true,
    });
  }
}

/**
 * Progress tracking utility with throttling.
 */
class ProgressTracker {
  private lastReportTime = 0;
  private readonly throttleMs = 100; // Report progress at most every 100ms
  private readonly onProgress?: (count: number) => void;

  constructor(onProgress?: (count: number) => void) {
    this.onProgress = onProgress;
  }

  report(count: number): void {
    if (!this.onProgress) return;

    const now = Date.now();
    if (now - this.lastReportTime >= this.throttleMs) {
      this.onProgress(count);
      this.lastReportTime = now;
    }
  }

  reportFinal(count: number): void {
    if (this.onProgress) {
      this.onProgress(count);
    }
  }
}

/**
 * Utility to yield control back to the event loop for better responsiveness.
 */
function createMicroYield(): () => Promise<void> {
  const globalObj = globalThis as GlobalWithIdleCallback;
  const hasIdleCallback = typeof globalObj.requestIdleCallback === "function";

  return (): Promise<void> => {
    return new Promise<void>((resolve) => {
      if (hasIdleCallback && globalObj.requestIdleCallback) {
        globalObj.requestIdleCallback(resolve, { timeout: 16 });
      } else {
        setTimeout(resolve, 0);
      }
    });
  };
}

/**
 * Parser state management for cleaner error handling and resource cleanup.
 */
class ParserState {
  private parser: Papa.Parser | null = null;
  private isAborted = false;
  private hasStarted = false;
  private readonly progressTimer: number;
  private readonly abortHandler: () => void;
  private readonly signal: AbortSignal | undefined;
  private readonly onTimeout: () => void;

  constructor(signal: AbortSignal | undefined, onTimeout: () => void) {
    this.signal = signal;
    this.onTimeout = onTimeout;
    this.abortHandler = this.handleAbort.bind(this);

    this.progressTimer = window.setTimeout(
      this.handleTimeout.bind(this),
      CONFIG.PROGRESS_TIMEOUT_MS
    );

    if (this.signal) {
      this.signal.addEventListener("abort", this.abortHandler, { once: true });
    }
  }

  setParser(parser: Papa.Parser): void {
    this.parser = parser;
  }

  markStarted(): void {
    this.hasStarted = true;
    clearTimeout(this.progressTimer);
  }

  isOperationAborted(): boolean {
    return this.isAborted;
  }

  abort(): void {
    if (this.parser) {
      this.parser.abort();
    }
  }

  cleanup(): void {
    clearTimeout(this.progressTimer);
    if (this.signal) {
      this.signal.removeEventListener("abort", this.abortHandler);
    }
  }

  private handleAbort(): void {
    this.isAborted = true;
    this.abort();
  }

  private handleTimeout(): void {
    if (!this.hasStarted) {
      this.abort();
      this.onTimeout();
    }
  }
}

/**
 * CSV parsing attempt with either main thread or web worker.
 */
async function attemptParse(
  file: File,
  useWorker: boolean,
  options: Required<Pick<ImportOptions, "batchSize" | "chunkSizeBytes">>,
  signal: AbortSignal | undefined,
  progressTracker: ProgressTracker
): Promise<void> {
  // Clear existing data at the start
  await db.rows.clear();

  const microYield = createMicroYield();

  // Parsing state
  let columns: string[] = [];
  let buffer: Row[] = [];
  let totalRows = 0;
  let isMetaInitialized = false;

  return new Promise<void>((resolve, reject) => {
    let parserState: ParserState | null = null;

    const handleTimeout = (): void => {
      if (parserState) {
        parserState.cleanup();
      }
      reject(new ImportError(CONFIG.NO_PROGRESS_ERROR));
    };

    parserState = new ParserState(signal, handleTimeout);

    const flushBuffer = async (parser: Papa.Parser): Promise<void> => {
      if (buffer.length === 0) return;

      try {
        await db.rows.bulkAdd(buffer);
        totalRows += buffer.length;
        progressTracker.report(totalRows);
        buffer = [];

        if (parserState && parserState.isOperationAborted()) {
          throw new ImportAbortedError();
        }

        await microYield();
        parser.resume();
      } catch (error) {
        parser.abort();
        throw error instanceof ImportAbortedError
          ? error
          : new ImportError(
              "Failed to write batch to database",
              error as Error
            );
      }
    };

    Papa.parse(file, {
      header: true,
      worker: useWorker,
      skipEmptyLines: true,
      chunkSize: options.chunkSizeBytes,

      step: (results, parser) => {
        if (parserState) {
          parserState.setParser(parser);
        }

        if (parserState && parserState.isOperationAborted()) {
          parser.abort();
          return;
        }

        if (parserState && !parserState.isOperationAborted()) {
          parserState.markStarted();
        }

        // Initialize metadata on first valid row
        if (!isMetaInitialized && results.meta.fields) {
          columns = [...results.meta.fields];
          isMetaInitialized = true;
        }

        // Process current row
        const rowData = results.data as Record<string, string>;
        if (rowData && Object.keys(rowData).length > 0) {
          buffer.push({ data: rowData });
        }

        // Flush buffer when it reaches batch size
        if (buffer.length >= options.batchSize) {
          parser.pause();
          flushBuffer(parser).catch(reject);
        }
      },

      complete: async (): Promise<void> => {
        try {
          // Flush remaining buffer
          if (buffer.length > 0) {
            await db.rows.bulkAdd(buffer);
            totalRows += buffer.length;
          }

          // Update metadata
          await db.meta.put({
            key: "current",
            columns: columns.length > 0 ? columns : [],
            rowCount: totalRows,
          });

          if (parserState && parserState.isOperationAborted()) {
            reject(new ImportAbortedError());
            return;
          }

          progressTracker.reportFinal(totalRows);
          resolve();
        } catch (error) {
          reject(
            new ImportError(
              "Failed to complete import operation",
              error as Error
            )
          );
        } finally {
          if (parserState) {
            parserState.cleanup();
          }
        }
      },

      error: (error): void => {
        if (parserState) {
          parserState.cleanup();
        }
        reject(
          new ImportError(
            "CSV parsing failed",
            error instanceof Error ? error : new Error(String(error))
          )
        );
      },
    });
  });
}

/**
 * Checks if Papa Parse supports web workers in the current environment.
 */
function isWorkerSupported(): boolean {
  const papaWithWorker = Papa as unknown as PapaParseWithWorkerSupport;
  return (
    typeof Worker !== "undefined" && papaWithWorker.WORKERS_SUPPORTED !== false
  );
}

/**
 * Stream-parse CSV file and import into IndexedDB with optimal performance.
 *
 * Features:
 * - Streaming parsing with backpressure control
 * - Automatic fallback from main thread to web worker if needed
 * - Batch processing to maintain stable memory usage
 * - Progress reporting with throttling
 * - Proper cancellation support via AbortController
 * - Comprehensive error handling with custom error types
 *
 * @param file - The CSV file to import
 * @param options - Configuration options for the import operation
 * @throws {ImportError} When parsing or database operations fail
 * @throws {ImportAbortedError} When operation is cancelled via AbortSignal
 */
export async function importCsv(
  file: File,
  options: ImportOptions = {}
): Promise<void> {
  // Validate inputs
  if (!file) {
    throw new ImportError("File is required");
  }

  if (file.size === 0) {
    throw new ImportError("File is empty");
  }

  // Prepare configuration
  const config = {
    batchSize: options.batchSize ?? CONFIG.DEFAULT_BATCH_SIZE,
    chunkSizeBytes: options.chunkSizeBytes ?? CONFIG.DEFAULT_CHUNK_SIZE_BYTES,
  };

  if (config.batchSize <= 0) {
    throw new ImportError("Batch size must be positive");
  }

  if (config.chunkSizeBytes <= 0) {
    throw new ImportError("Chunk size must be positive");
  }

  const progressTracker = new ProgressTracker(options.onProgress);

  // Attempt main-thread parsing first, fallback to worker if needed
  try {
    await attemptParse(file, false, config, options.signal, progressTracker);
  } catch (error) {
    const isNoProgressError =
      error instanceof ImportError &&
      error.message === CONFIG.NO_PROGRESS_ERROR;

    if (isNoProgressError && isWorkerSupported()) {
      // Retry with web worker
      await attemptParse(file, true, config, options.signal, progressTracker);
    } else {
      // Re-throw original error
      throw error;
    }
  }
}
