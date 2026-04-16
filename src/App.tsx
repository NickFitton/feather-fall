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

  const graphqlCount =
    capture?.items.filter((item) => item.kind === "graphql").length ?? 0;
  const feathersCount =
    capture?.items.filter((item) => item.kind === "feathers").length ?? 0;
  const longestRequest =
    capture?.items.reduce<TimelineItem | null>((currentLongest, item) => {
      if (!currentLongest || item.durationMs > currentLongest.durationMs) {
        return item;
      }

      return currentLongest;
    }, null) ?? null;

  return (
    <main className="app-shell">
      <div className="orb orb-a" aria-hidden="true" />
      <div className="orb orb-b" aria-hidden="true" />

      <section className="hero-panel">
        <div>
          <p className="eyebrow">HAR timeline for Feathers websocket traffic</p>
          <h1>See Socket.IO request pairs as a Gantt chart.</h1>
          <p className="hero-copy">
            Upload a HAR export, and the app will isolate websocket traffic,
            pair Feathers request and response frames, and line up GraphQL
            execute/result events on the same timeline.
          </p>
        </div>

        <div
          className={`dropzone ${dragActive ? "is-dragging" : ""}`}
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
          <input
            ref={fileInputRef}
            type="file"
            accept=".har,.json,application/json"
            className="sr-only"
            onChange={(event) => handleFiles(event.target.files)}
          />
          <p className="dropzone-label">
            {busy ? "Parsing HAR…" : "Drop a HAR file here"}
          </p>
          <p className="dropzone-copy">
            The sample `app.humaans.io.har` works as a reference upload.
          </p>
          <button
            type="button"
            className="primary-button"
            onClick={() => fileInputRef.current?.click()}
            disabled={busy}
          >
            {busy ? "Working…" : "Choose file"}
          </button>
        </div>
      </section>

      {error ? <p className="error-banner">{error}</p> : null}

      <section className="metrics-grid">
        <article className="metric-card">
          <span className="metric-label">Paired requests</span>
          <strong>{capture?.items.length ?? 0}</strong>
          <span className="metric-copy">
            Only request/response traffic is charted.
          </span>
        </article>

        <article className="metric-card">
          <span className="metric-label">Feathers / GraphQL</span>
          <strong>
            {feathersCount} / {graphqlCount}
          </strong>
          <span className="metric-copy">
            Socket pings and handshakes are filtered out.
          </span>
        </article>

        <article className="metric-card">
          <span className="metric-label">Websocket connections</span>
          <strong>{capture?.totalWebSockets ?? 0}</strong>
          <span className="metric-copy">
            {capture
              ? `${capture.totalMessages} total frames scanned.`
              : "Upload a HAR to inspect traffic."}
          </span>
        </article>

        <article className="metric-card">
          <span className="metric-label">Longest span</span>
          <strong>
            {longestRequest ? formatDuration(longestRequest.durationMs) : "—"}
          </strong>
          <span className="metric-copy">
            {longestRequest
              ? longestRequest.summary
              : "No requests loaded yet."}
          </span>
        </article>
      </section>

      <section className="controls-panel">
        <label className="field">
          <span>Search</span>
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Filter by service, operation, or payload"
          />
        </label>

        <div className="field">
          <span>Kind</span>
          <div
            className="segmented-control"
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
        </div>

        <label className="field">
          <span>Connection</span>
          <select
            value={connectionFilter}
            onChange={(event) => setConnectionFilter(event.target.value)}
            disabled={!capture}
          >
            <option value="all">All websocket streams</option>
            {capture?.connections.map((connection) => (
              <option key={connection.id} value={connection.id}>
                {connection.label} ({connection.pairedRequests})
              </option>
            ))}
          </select>
        </label>
      </section>

      {!capture ? (
        <section className="empty-panel">
          <p className="eyebrow">What the parser does</p>
          <h2>Upload a HAR to start.</h2>
          <p>
            Feathers Socket.IO requests like <code>42&lt;id&gt;[...]</code> are
            paired with <code>43&lt;id&gt;[...]</code> acknowledgements. GraphQL{" "}
            <code>@graphql/execute</code> frames are paired with{" "}
            <code>@graphql/result</code> messages using the GraphQL request id.
          </p>
        </section>
      ) : filteredItems.length === 0 ? (
        <section className="empty-panel">
          <p className="eyebrow">No matches</p>
          <h2>The current filters returned no request pairs.</h2>
          <p>
            Try clearing the search, switching the connection, or showing all
            message kinds.
          </p>
        </section>
      ) : (
        <section className="chart-panel">
          <div className="chart-frame">
            <div className="timeline-table">
              <div className="timeline-header">
                <div className="summary-cell summary-cell-header">
                  <span>Request summary</span>
                  <span>{filteredItems.length} visible rows</span>
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
                  0.8,
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
                      <strong>{item.summary}</strong>
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

          {selected ? <SelectedView item={selected} /> : null}
        </section>
      )}
    </main>
  );
}

export default App;

function SelectedView({
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
        <div>
          <p className="eyebrow">Selected request</p>
          <h2>{summary}</h2>
        </div>

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
