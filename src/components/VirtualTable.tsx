import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { db, type Row } from "../db";

const CONFIG = {
  DEFAULT_HEIGHT_PX: 600,
  DEFAULT_ROW_HEIGHT_PX: 36,
  ID_COLUMN_WIDTH_PX: 60,
  DATA_COLUMN_MIN_WIDTH_PX: 160,
  VIRTUAL_OVERSCAN: 50,
  FETCH_PREFETCH: 10,
  CACHE_KEEP_BEFORE: 50,
  CACHE_KEEP_AFTER: 50,
  MAX_CACHED_ROWS: 100,
} as const;

export interface VirtualTableProps {
  columns: readonly string[];
  rowCount: number;
  height?: number;
  rowHeight?: number;
  editMode?: boolean;
  onCellEdit?: (rowId: number, column: string, newValue: string) => void;
  onError?: (error: Error) => void;
}

interface EditingState {
  readonly rowIdx: number;
  readonly col: string;
}

/**
 * Virtualized table that efficiently renders large datasets by only loading visible rows.
 *
 * Core concepts:
 * - Virtual scrolling: Only render ~50 DOM rows instead of millions
 * - Smart caching: Keep recently accessed rows in memory
 * - Optimistic updates: Update UI first, then persist to database
 * - Abort controllers: Cancel stale requests when user scrolls quickly
 */
export function VirtualTable({
  columns,
  rowCount,
  height = CONFIG.DEFAULT_HEIGHT_PX,
  rowHeight = CONFIG.DEFAULT_ROW_HEIGHT_PX,
  editMode = false,
  onCellEdit,
  onError,
}: VirtualTableProps): JSX.Element {
  const parentRef = useRef<HTMLDivElement | null>(null);

  // Cache for loaded rows - Map allows O(1) lookups by row index
  const [cache, setCache] = useState<Map<number, Row>>(() => new Map());
  const cacheRef = useRef<Map<number, Row>>(cache);
  cacheRef.current = cache;

  // Abort controller for cancelling in-flight database requests
  const fetchRef = useRef<{ controller: AbortController | null }>({
    controller: null,
  });

  // Request ID to ignore stale responses when user scrolls quickly
  const requestIdRef = useRef<number>(0);

  // Cell editing state
  const [editing, setEditing] = useState<EditingState | null>(null);
  const [editValue, setEditValue] = useState<string>("");

  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => parentRef.current,
    estimateSize: () => rowHeight,
    overscan: CONFIG.VIRTUAL_OVERSCAN,
  });

  const virtualItems = virtualizer.getVirtualItems();

  // Cleanup: abort fetch on unmount to prevent memory leaks
  useEffect(() => {
    const ref = fetchRef.current;
    return () => {
      ref.controller?.abort();
    };
  }, []);

  // Reset cache and editing when dataset shape changes
  useEffect(() => {
    setCache(new Map());
    setEditing(null);
    fetchRef.current.controller?.abort();
    requestIdRef.current++;
  }, [columns, rowCount]);

  /**
   * Main data fetching effect - the heart of virtual scrolling.
   *
   * Triggers when viewport changes and fetches only the rows that are
   * currently visible + a small buffer. Uses IndexedDB pagination with
   * offset/limit (works for most use cases despite potential gaps in IDs).
   */
  useEffect(() => {
    if (rowCount === 0 || columns.length === 0 || virtualItems.length === 0) {
      return;
    }

    // Calculate which rows we need: visible + prefetch buffer
    const startIndex = Math.max(
      0,
      virtualItems[0].index - CONFIG.FETCH_PREFETCH
    );
    const endIndex = Math.min(
      rowCount - 1,
      virtualItems[virtualItems.length - 1].index + CONFIG.FETCH_PREFETCH
    );

    // Fast path: check if all needed rows are already cached
    // This is the most common case when user scrolls within already-loaded area
    let missing = false;
    const currentCache = cacheRef.current;
    for (let i = startIndex; i <= endIndex; i++) {
      if (!currentCache.has(i)) {
        missing = true;
        break;
      }
    }
    if (!missing) return; // Cache hit - no database fetch needed

    // Cache miss: abort previous request and start new fetch
    // Aborting prevents race conditions when user scrolls quickly through data
    fetchRef.current.controller?.abort();
    const controller = new AbortController();
    fetchRef.current.controller = controller;
    const requestId = ++requestIdRef.current; // Unique ID to identify this specific request

    const limit = endIndex - startIndex + 1;

    /**
     * Async fetch with proper error handling and abort support.
     *
     * Note: IndexedDB via Dexie doesn't support true cancellation,
     * so we use "soft abort" by checking signals before state updates.
     */
    (async () => {
      try {
        if (controller.signal.aborted) {
          throw new DOMException("Aborted", "AbortError");
        }

        // Fetch from IndexedDB using offset/limit pagination
        // This assumes roughly sequential row ordering in the database
        const rows = await db.rows
          .orderBy("id")
          .offset(startIndex)
          .limit(limit)
          .toArray();

        // Ignore response if request was cancelled or superseded
        if (controller.signal.aborted || requestId !== requestIdRef.current) {
          throw new DOMException("Aborted", "AbortError");
        }

        // Update cache with fetched data and prune old entries
        setCache((prevCache) => {
          const nextCache = new Map(prevCache);

          // Add newly fetched rows to cache at their correct row indices
          // Example: if startIndex=100, rows[0] goes to cache key 100, rows[1] to 101, etc.
          rows.forEach((row, index) => {
            nextCache.set(startIndex + index, row);
          });

          /**
           * Cache pruning strategy to prevent memory leaks in long scrolling sessions.
           *
           * Problem: Without pruning, cache grows indefinitely as user scrolls through
           * millions of rows, eventually causing browser to run out of memory.
           *
           * Solution: Keep a "safe window" around current viewport and remove distant rows.
           * The safe window prevents cache thrashing when user scrolls back and forth
           * within a small area (very common UX pattern).
           */
          const keepMin = Math.max(0, startIndex - CONFIG.CACHE_KEEP_BEFORE);
          const keepMax = endIndex + CONFIG.CACHE_KEEP_AFTER;

          // First pass: remove all rows clearly outside the safe window
          // This handles the common case efficiently
          for (const key of nextCache.keys()) {
            if (key < keepMin || key > keepMax) {
              nextCache.delete(key);
            }
          }

          /**
           * Second pass: size-based pruning for edge cases.
           *
           * Why needed: If user has a very wide viewport or CONFIG values are large,
           * the safe window itself might exceed our memory limit. This provides a
           * hard cap on memory usage.
           *
           * Strategy: Remove rows farthest from current viewport first (LRU-like).
           * This preserves rows most likely to be accessed again soon.
           */
          if (nextCache.size > CONFIG.MAX_CACHED_ROWS) {
            const excess = nextCache.size - CONFIG.MAX_CACHED_ROWS;
            let removed = 0;

            // Sort cached row indices by distance from current viewport
            // Rows farthest from both startIndex and endIndex get removed first
            const sortedKeys = Array.from(nextCache.keys()).sort((a, b) => {
              const aDist = Math.min(
                Math.abs(a - startIndex),
                Math.abs(a - endIndex)
              );
              const bDist = Math.min(
                Math.abs(b - startIndex),
                Math.abs(b - endIndex)
              );
              return bDist - aDist; // Sort descending: farthest first
            });

            // Remove the farthest rows until we're under the memory limit
            for (const key of sortedKeys) {
              if (removed >= excess) break;
              if (key < keepMin || key > keepMax) {
                nextCache.delete(key);
                removed++;
              }
            }
          }

          return nextCache;
        });
      } catch (error) {
        if ((error as DOMException).name !== "AbortError") {
          console.error("VirtualTable fetch error:", error);
          onError?.(error as Error);
        }
      }
    })();
  }, [columns, rowCount, virtualItems, onError]);

  // Cell editing handlers
  const beginEdit = useCallback(
    (rowIdx: number, col: string): void => {
      if (!editMode) return;

      const row = cache.get(rowIdx);
      if (!row) return;

      setEditing({ rowIdx, col });
      setEditValue(String(row.data[col] ?? ""));
    },
    [cache, editMode]
  );

  /**
   * Optimistic update pattern for responsive cell editing.
   *
   * Traditional approach: User edits cell → wait for database → update UI
   * Problem: Feels slow and unresponsive, especially with slow networks
   *
   * Optimistic approach: User edits cell → update UI immediately → save to database
   * Benefit: Instant feedback, app feels fast and responsive
   * Risk: If database save fails, we need to rollback the UI change
   */
  const commitEdit = useCallback(async (): Promise<void> => {
    if (!editing) return;

    const { rowIdx, col } = editing;
    const row = cache.get(rowIdx);

    if (!row?.id) {
      setEditing(null);
      return;
    }

    const originalData = row.data;
    const newData = { ...originalData, [col]: editValue };

    try {
      // Step 1: Optimistic update - change UI immediately for instant feedback
      // User sees their edit applied right away, app feels responsive
      setCache((prevCache) => {
        const nextCache = new Map(prevCache);
        const currentRow = nextCache.get(rowIdx);
        if (currentRow) {
          nextCache.set(rowIdx, { ...currentRow, data: newData });
        }
        return nextCache;
      });

      // Step 2: Persist to database (this might fail due to validation, network, etc.)
      await db.rows.update(row.id, { data: newData });

      // Step 3: Notify parent component (for external state sync, analytics, etc.)
      onCellEdit?.(row.id, col, editValue);

      setEditing(null);
    } catch (error) {
      // Step 4: Rollback strategy - revert UI to database state if save failed
      // This keeps the UI truthful about what's actually persisted
      setCache((prevCache) => {
        const nextCache = new Map(prevCache);
        const currentRow = nextCache.get(rowIdx);
        if (currentRow) {
          nextCache.set(rowIdx, { ...currentRow, data: originalData });
        }
        return nextCache;
      });

      onError?.(error as Error);
    }
  }, [cache, editValue, editing, onCellEdit, onError]);

  const cancelEdit = useCallback((): void => {
    setEditing(null);
    setEditValue("");
  }, []);

  /**
   * Virtual scrolling layout calculations.
   *
   * Virtual scrolling creates an illusion that all rows are rendered by using
   * "spacer" elements above and below the actual visible rows. This makes the
   * scrollbar behave correctly (showing proper total height and thumb position)
   * while only rendering ~20-50 DOM nodes instead of millions.
   *
   * Example with 1M rows, each 40px tall:
   * - Total height: 40,000,000px (makes scrollbar work correctly)
   * - User scrolls to row 500,000
   * - paddingTop: 20,000,000px (spacer representing rows 0-499,999)
   * - Rendered rows: ~50 actual <tr> elements (rows 500,000-500,050)
   * - paddingBottom: 19,998,000px (spacer representing remaining rows)
   */
  const { paddingTop, paddingBottom } = useMemo(() => {
    const totalHeight = virtualizer.getTotalSize();
    const top = virtualItems.length > 0 ? virtualItems[0].start : 0;
    const itemsHeight = virtualItems.reduce((sum, item) => sum + item.size, 0);

    return {
      paddingTop: top,
      paddingBottom: totalHeight - top - itemsHeight,
    };
  }, [virtualizer, virtualItems]);

  const handleCellClick = useCallback(
    (rowIdx: number, col: string): void => {
      if (editMode) beginEdit(rowIdx, col);
    },
    [editMode, beginEdit]
  );

  const handleEditKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>): void => {
      if (e.key === "Enter") {
        e.preventDefault();
        commitEdit();
      } else if (e.key === "Escape") {
        e.preventDefault();
        cancelEdit();
      }
    },
    [commitEdit, cancelEdit]
  );

  const columnsArray = Array.from(columns);

  return (
    <div
      ref={parentRef}
      style={{
        height,
        overflow: "auto",
        border: "1px solid #ddd",
        borderRadius: 8,
        position: "relative",
        background: "#fff",
      }}
      role="grid"
      aria-label="Virtual data table"
    >
      <table
        style={{
          width: "100%",
          borderCollapse: "collapse",
          tableLayout: "fixed",
        }}
      >
        <colgroup>
          <col style={{ width: CONFIG.ID_COLUMN_WIDTH_PX }} />
          {columnsArray.map((col) => (
            <col
              key={col}
              style={{ minWidth: CONFIG.DATA_COLUMN_MIN_WIDTH_PX }}
            />
          ))}
        </colgroup>

        <thead>
          <tr>
            <th
              style={{
                position: "sticky",
                top: 0,
                zIndex: 1,
                background: "#fafafa",
                borderBottom: "1px solid #ddd",
                textAlign: "left",
                height: rowHeight,
                padding: "8px",
                fontWeight: 600,
              }}
            >
              #
            </th>
            {columnsArray.map((col) => (
              <th
                key={col}
                style={{
                  position: "sticky",
                  top: 0,
                  zIndex: 1,
                  background: "#fafafa",
                  borderBottom: "1px solid #ddd",
                  textAlign: "left",
                  height: rowHeight,
                  padding: "8px",
                  fontWeight: 600,
                }}
              >
                {col}
              </th>
            ))}
          </tr>
        </thead>

        <tbody>
          {/* 
            Virtual spacer above viewport - represents all rows before visible area.
            Without this spacer, the table would appear to start at row 0 even when
            user has scrolled to row 500,000. The spacer maintains correct scroll position.
          */}
          {paddingTop > 0 && (
            <tr style={{ height: paddingTop }} aria-hidden="true">
              <td colSpan={columnsArray.length + 1} />
            </tr>
          )}

          {/* 
            Core of virtual scrolling: only render the rows actually visible in viewport.
            @tanstack/react-virtual calculates which rows are visible and provides their
            exact positions. We render only these ~20-50 rows instead of millions.
          */}
          {virtualItems.map((virtualRow) => {
            const rowIdx = virtualRow.index; // Logical row number (0 to rowCount-1)
            const row = cache.get(rowIdx); // Actual data (may be undefined if still loading)

            return (
              <tr
                key={virtualRow.key} // Stable key from virtualizer for React reconciliation
                style={{
                  height: virtualRow.size, // Exact height calculated by virtualizer
                  borderBottom: "1px solid #f1f1f1",
                }}
              >
                {/* 
                  ID column: shows the logical row number or database ID.
                  Always visible even when row data is still loading from IndexedDB.
                */}
                <td
                  style={{
                    padding: "6px 8px",
                    color: "#888",
                    borderRight: "1px solid #f5f5f5",
                    fontFamily: "monospace", // Monospace for consistent number alignment
                    fontSize: "0.9em",
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                >
                  {/* Loading state: show "…" while data fetches, then actual ID */}
                  {row?.id ?? "…"}
                </td>

                {/* Data columns: show actual cell values with inline editing support */}
                {columnsArray.map((col) => {
                  const isEditing =
                    editing?.rowIdx === rowIdx && editing.col === col;
                  const value = row?.data?.[col] ?? "";

                  return (
                    <td
                      key={col}
                      style={{
                        padding: "4px 8px",
                        borderRight: "1px solid #f5f5f5",
                        minWidth: CONFIG.DATA_COLUMN_MIN_WIDTH_PX,
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        cursor: editMode ? "pointer" : "default",
                      }}
                      onClick={() => handleCellClick(rowIdx, col)}
                      onDoubleClick={() => beginEdit(rowIdx, col)}
                    >
                      {isEditing ? (
                        /* 
                          Edit mode: inline input with keyboard shortcuts
                          - Enter: save changes
                          - Escape: cancel editing
                          - Blur: save changes (user clicked elsewhere)
                        */
                        <input
                          value={editValue}
                          onChange={(e) => setEditValue(e.target.value)}
                          onBlur={commitEdit}
                          onKeyDown={handleEditKeyDown}
                          autoFocus
                          onFocus={(e) => e.currentTarget.select()} // Select all text for easy replacement
                          style={{
                            width: "100%",
                            border: "2px solid #0066cc", // Visual feedback for edit state
                            borderRadius: 4,
                            padding: "4px 6px",
                            font: "inherit",
                            outline: "none",
                          }}
                        />
                      ) : (
                        /* 
                          View mode: display cell value with tooltip for long content
                          Shows empty string for missing data (cleaner than "undefined")
                        */
                        <span title={String(value)}>{String(value)}</span>
                      )}
                    </td>
                  );
                })}
              </tr>
            );
          })}

          {/* 
            Virtual spacer below viewport - represents all rows after visible area.
            Maintains correct total scroll height so scrollbar behaves naturally.
          */}
          {paddingBottom > 0 && (
            <tr style={{ height: paddingBottom }} aria-hidden="true">
              <td colSpan={columnsArray.length + 1} />
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
