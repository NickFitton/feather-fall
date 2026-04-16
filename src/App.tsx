import {
  startTransition,
  useDeferredValue,
  useRef,
  useState,
  type ReactNode,
} from "react";
import "./App.css";
import {
  formatAxisOffset,
  formatClockTime,
  formatDuration,
  parseHarCapture,
  type ParsedCapture,
  type TimelineItem,
} from "./har";

const chartTickCount = 6;

function App() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [capture, setCapture] = useState<ParsedCapture | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [search, setSearch] = useState("");
  const [kindFilter, setKindFilter] = useState<"all" | "feathers" | "graphql">(
    "all",
  );
  const [connectionFilter, setConnectionFilter] = useState("all");
  const [selected, setSelected] = useState<TimelineItem | null>(null);

  const deferredSearch = useDeferredValue(search.trim().toLowerCase());

  async function analyzeFile(file: File) {
    setBusy(true);
    setError(null);

    try {
      const text = await file.text();
      const nextCapture = parseHarCapture(text, file.name);

      startTransition(() => {
        setCapture(nextCapture);
        setConnectionFilter("all");
        setKindFilter("all");
        setSearch("");
        setSelected(nextCapture.items[0] ?? null);
      });
    } catch (caughtError) {
      const message =
        caughtError instanceof Error
          ? caughtError.message
          : "The HAR file could not be parsed.";

      startTransition(() => {
        setCapture(null);
        setSelected(null);
        setError(message);
      });
    } finally {
      setBusy(false);
    }
  }

  function handleFiles(files: FileList | null) {
    const file = files?.[0];

    if (!file) {
      return;
    }

    void analyzeFile(file);
  }

  const allItems = capture?.items ?? [];
  const filteredItems = allItems.filter((item) => {
    if (kindFilter !== "all" && item.kind !== kindFilter) {
      return false;
    }

    if (connectionFilter !== "all" && item.connectionId !== connectionFilter) {
      return false;
    }

    if (!deferredSearch) {
      return true;
    }

    const haystack = [
      item.summary,
      item.responsePreview,
      item.connectionLabel,
      item.requestText,
      item.responseText,
    ]
      .join(" ")
      .toLowerCase();

    return haystack.includes(deferredSearch);
  });

  const chartStart =
    filteredItems.length > 0
      ? Math.min(...filteredItems.map((item) => item.startTime))
      : (capture?.spanStart ?? 0);
  const chartEnd =
    filteredItems.length > 0
      ? Math.max(...filteredItems.map((item) => item.endTime))
      : (capture?.spanEnd ?? chartStart + 0.001);
  const chartSpan = Math.max(chartEnd - chartStart, 0.001);

  const ticks = Array.from({ length: chartTickCount }, (_, index) => {
    const position = index / (chartTickCount - 1);

    return {
      position,
      label: formatAxisOffset(chartSpan * position),
    };
  });

  const feathersCount =
    capture?.items.filter((item) => item.kind === "feathers").length ?? 0;
  const graphqlCount =
    capture?.items.filter((item) => item.kind === "graphql").length ?? 0;

  return (
    <main className="app-shell">
      <input
        ref={fileInputRef}
        type="file"
        accept=".har,.json,application/json"
        className="sr-only"
        onChange={(event) => handleFiles(event.target.files)}
      />

      {/* ── Toolbar ── */}
      <header className="toolbar">
        <span className="toolbar-brand">
          <strong>feather-fall</strong>
        </span>
        <span className="toolbar-sep" />
        <button
          type="button"
          className="file-button"
          onClick={() => fileInputRef.current?.click()}
          disabled={busy}
        >
          {busy ? "Parsing…" : "Open HAR"}
        </button>

        {capture ? (
          <>
            <span className="toolbar-filename">{capture.fileName}</span>
            <span className="toolbar-sep" />
            <span className="toolbar-stat">
              <b>{capture.items.length}</b> pairs
            </span>
            <span className="toolbar-stat">
              <b>{feathersCount}</b> feathers
            </span>
            <span className="toolbar-stat">
              <b>{graphqlCount}</b> graphql
            </span>
            <span className="toolbar-stat">
              <b>{capture.totalWebSockets}</b> ws
            </span>
            <span className="toolbar-stat">
              <b>{capture.totalMessages}</b> frames
            </span>
          </>
        ) : null}
      </header>

      {error ? <p className="error-banner">{error}</p> : null}

      {!capture ? (
        <div
          className="dropzone-wrapper"
          onDragEnter={(event) => {
            event.preventDefault();
            setDragActive(true);
          }}
          onDragOver={(event) => {
            event.preventDefault();
            setDragActive(true);
          }}
          onDragLeave={(event) => {
            event.preventDefault();
            setDragActive(false);
          }}
          onDrop={(event) => {
            event.preventDefault();
            setDragActive(false);
            handleFiles(event.dataTransfer.files);
          }}
        >
          <div className={`dropzone ${dragActive ? "is-dragging" : ""}`}>
            <h2>Drop a HAR file to analyze</h2>
            <p>
              Pairs Feathers Socket.IO request/response frames and GraphQL
              execute/result events on a timeline.
            </p>
            <button
              type="button"
              className="primary-button"
              onClick={() => fileInputRef.current?.click()}
              disabled={busy}
            >
              Choose file
            </button>
          </div>
        </div>
      ) : (
        <>
          {/* ── Controls bar ── */}
          <div className="controls-bar">
            <input
              type="search"
              className="search-input"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Filter…"
            />

            <div
              className="filter-group"
              role="group"
              aria-label="Message kind"
            >
              {(["all", "feathers", "graphql"] as const).map((option) => (
                <button
                  key={option}
                  type="button"
                  className={kindFilter === option ? "is-active" : undefined}
                  onClick={() => setKindFilter(option)}
                >
                  {option}
                </button>
              ))}
            </div>

            <select
              className="connection-select"
              value={connectionFilter}
              onChange={(event) => setConnectionFilter(event.target.value)}
            >
              <option value="all">All connections</option>
              {capture.connections.map((connection) => (
                <option key={connection.id} value={connection.id}>
                  {connection.label} ({connection.pairedRequests})
                </option>
              ))}
            </select>

            <span className="controls-count">
              {filteredItems.length} / {allItems.length}
            </span>
          </div>

          {/* ── Chart ── */}
          <section
            className={`chart-area ${selected ? "has-details" : ""}`}
          >
            {filteredItems.length === 0 ? (
              <div className="empty-state">
                <h2>No matches</h2>
                <p>
                  Try clearing the search, switching the connection, or showing
                  all message kinds.
                </p>
              </div>
            ) : (
              <div className="chart-scroll">
                <div className="timeline-table">
                  <div className="timeline-header">
                    <div className="summary-cell-header">
                      <span>Request</span>
                      <span>{filteredItems.length} rows</span>
                    </div>

                    <div className="axis-cell">
                      {ticks.map((tick) => (
                        <div
                          key={tick.label}
                          className="axis-tick"
                          style={{ left: `${tick.position * 100}%` }}
                        >
                          <span>{tick.label}</span>
                        </div>
                      ))}
                    </div>
                  </div>

                  {filteredItems.map((item) => {
                    const startPercent =
                      ((item.startTime - chartStart) / chartSpan) * 100;
                    const widthPercent = Math.max(
                      ((item.endTime - item.startTime) / chartSpan) * 100,
                      0.3,
                    );
                    const isSelected = selected?.id === item.id;

                    return (
                      <div
                        key={item.id}
                        className={`timeline-row ${isSelected ? "is-selected" : ""}`}
                      >
                        <button
                          type="button"
                          className="summary-cell summary-button"
                          onClick={() => setSelected(item)}
                          title={`${item.summary}\n${item.connectionLabel}`}
                        >
                          <span
                            className={`row-kind kind-${item.kind}`}
                          />
                          <span className="summary-text">
                            {item.summary}
                          </span>
                        </button>

                        <button
                          type="button"
                          className="bar-cell"
                          onClick={() => setSelected(item)}
                        >
                          <span className="lane-grid" aria-hidden="true" />
                          <span
                            className={`request-bar kind-${item.kind} status-${item.status}`}
                            style={{
                              left: `${startPercent}%`,
                              width: `${widthPercent}%`,
                            }}
                          >
                            <span className="request-bar-label">
                              {formatDuration(item.durationMs)}
                            </span>
                          </span>
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {selected ? <DetailsPanel item={selected} /> : null}
          </section>
        </>
      )}
    </main>
  );
}

export default App;

function DetailsPanel({
  item: {
    summary,
    kind,
    connectionLabel,
    startTime,
    durationMs,
    requestText,
    responseText,
  },
}: {
  item: TimelineItem;
}): ReactNode {
  return (
    <aside className="details-panel">
      <div className="details-header">
        <span className="details-title">{summary}</span>
        <div className="detail-chips">
          <span>{kind}</span>
          <span>{connectionLabel}</span>
          <span>{formatClockTime(startTime)}</span>
          <span>{formatDuration(durationMs)}</span>
        </div>
      </div>

      <div className="details-grid">
        <section className="code-panel">
          <h3>Request</h3>
          <pre>{requestText}</pre>
        </section>

        <section className="code-panel">
          <h3>Response</h3>
          <pre>{responseText}</pre>
        </section>
      </div>
    </aside>
  );
}
