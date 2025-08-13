import { useEffect, useMemo, useRef, useState } from "react";
import { liveQuery } from "dexie";
import { db, type Meta } from "./db";
import { importCsv } from "./csvImporter";
import { VirtualTable } from "./components/VirtualTable";
import "./App.css";

function App() {
  const [columns, setColumns] = useState<string[]>([]);
  const [rowCount, setRowCount] = useState<number>(0);
  const [importing, setImporting] = useState<boolean>(false);
  // progress count is no longer surfaced incrementally
  const [error, setError] = useState<string | null>(null);
  const importAbortRef = useRef<AbortController | null>(null);
  const [editMode, setEditMode] = useState<boolean>(false);

  // Load meta on mount
  useEffect(() => {
    (async () => {
      const meta = await db.meta.get("current");
      if (meta) {
        setColumns(meta.columns);
        setRowCount(meta.rowCount);
      }
    })();
  }, []);

  // Reactively subscribe to meta changes (no polling)
  useEffect(() => {
    const subscription = liveQuery(() => db.meta.get("current")).subscribe({
      next: (meta) => {
        if (meta) {
          setColumns(meta.columns);
          setRowCount(meta.rowCount);
        }
      },
      error: (err) => {
        // Optional: surface error to UI if needed
        console.error(err);
      },
    });
    return () => subscription.unsubscribe();
  }, []);

  const onFileSelected = async (file: File) => {
    setError(null);
    setImporting(true);
    importAbortRef.current?.abort();
    const controller = new AbortController();
    importAbortRef.current = controller;

    try {
      await importCsv(file, {
        signal: controller.signal,
        // no incremental UI updates during import
        onProgress: () => {},
      });
      const meta = (await db.meta.get("current")) as Meta | undefined;
      if (meta) {
        setColumns(meta.columns);
        setRowCount(meta.rowCount);
      }
    } catch (e) {
      if ((e as DOMException)?.name === "AbortError") {
        setError("Import aborted");
      } else {
        setError((e as Error).message ?? "Import failed");
      }
    } finally {
      setImporting(false);
    }
  };

  const onPickFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) onFileSelected(file);
    e.currentTarget.value = "";
  };

  const formattedProgress = useMemo(() => {
    if (!importing) return "";
    return `Loading...`;
  }, [importing]);

  return (
    <>
      <h1>CSV → IndexedDB (Dexie) with Virtualized Table</h1>

      <div
        style={{
          display: "flex",
          gap: 8,
          alignItems: "center",
          marginBottom: 12,
        }}
      >
        <input
          type="file"
          accept=".csv,text/csv"
          onChange={onPickFile}
          disabled={importing}
        />
        <label style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <input
            type="checkbox"
            checked={editMode}
            onChange={(e) => setEditMode(e.target.checked)}
            disabled={importing}
          />
          Edit mode
        </label>
        <button
          onClick={() => {
            importAbortRef.current?.abort();
          }}
          disabled={!importing}
        >
          Abort import
        </button>
        {importing && <span>{formattedProgress}</span>}
        {error && <span style={{ color: "crimson" }}>{error}</span>}
      </div>

      <div style={{ marginBottom: 8, color: "#666" }}>
        {importing ? (
          <span>Loading...</span>
        ) : (
          <>
            <span>Columns: {columns.length}</span>
            <span style={{ marginLeft: 12 }}>
              Rows: {rowCount.toLocaleString()}
            </span>
          </>
        )}
      </div>

      {importing ? null : columns.length > 0 && rowCount > 0 ? (
        <VirtualTable
          columns={columns}
          rowCount={rowCount}
          height={600}
          rowHeight={36}
          editMode={editMode}
        />
      ) : (
        <div style={{ color: "#777" }}>Import a CSV file to begin...</div>
      )}
    </>
  );
}

export default App;
