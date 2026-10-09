import { useState, useEffect, useCallback, useRef } from 'react';
import {
  getStateSummary,
  getPendingEvents,
  getExceptions,
  acknowledgeEvents,
  submitEvents,
  getMqttStatus,
} from './api';
import {
  StateSummary,
  PendingEvent,
  ExceptionItem,
  MqttStatusResponse,
  EventSubmissionResult,
} from './types';
import './index.css';

// ─── Clock ────────────────────────────────────────────────────
function LiveClock() {
  const [t, setT] = useState(new Date());
  useEffect(() => {
    const id = setInterval(() => setT(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  return (
    <span className="header-time">
      {t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
    </span>
  );
}

// ─── KPI Card ─────────────────────────────────────────────────
interface KpiProps {
  label: string;
  value: number;
  accent: string;
  sub?: string;
}
function KpiCard({ label, value, accent, sub }: KpiProps) {
  return (
    <div className={`kpi-card ${accent}`}>
      <span className="kpi-label">{label}</span>
      <span className="kpi-value">{value.toLocaleString()}</span>
      {sub && <span className="kpi-sub">{sub}</span>}
    </div>
  );
}

// ─── Main App ─────────────────────────────────────────────────
export default function App() {
  const [sourceIdFilter, setSourceIdFilter] = useState('');
  const [activeTab, setActiveTab] = useState<'pending' | 'exceptions'>('pending');
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);

  const [summary, setSummary] = useState<StateSummary>({
    net_total: 0, processed_events: 0, pending_ack: 0,
    unresolved: 0, duplicates: 0, conflicts: 0,
  });
  const [pendingList, setPendingList] = useState<PendingEvent[]>([]);
  const [exceptionsList, setExceptionsList] = useState<ExceptionItem[]>([]);
  const [mqttStatus, setMqttStatus] = useState<MqttStatusResponse | null>(null);

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [isAcking, setIsAcking] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [globalError, setGlobalError] = useState<string | null>(null);
  const [globalSuccess, setGlobalSuccess] = useState<string | null>(null);

  const [jsonInput, setJsonInput] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submissionResults, setSubmissionResults] = useState<EventSubmissionResult[]>([]);
  const [jsonParseError, setJsonParseError] = useState<string | null>(null);

  const successTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showSuccess = (msg: string) => {
    setGlobalSuccess(msg);
    if (successTimer.current) clearTimeout(successTimer.current);
    successTimer.current = setTimeout(() => setGlobalSuccess(null), 4000);
  };

  // ── Fetch ──────────────────────────────────────────────────
  const fetchData = useCallback(async () => {
    setIsLoading(true);
    setGlobalError(null);
    try {
      const [sumData, pendData, excData, mqttData] = await Promise.all([
        getStateSummary(sourceIdFilter),
        getPendingEvents(sourceIdFilter),
        getExceptions(sourceIdFilter),
        getMqttStatus().catch(() => null),
      ]);
      setSummary(sumData);
      setPendingList(pendData);
      setExceptionsList(excData);
      if (mqttData) setMqttStatus(mqttData);
      setLastRefresh(new Date());
    } catch (err: any) {
      setGlobalError(err.message || 'Failed to fetch dashboard data');
    } finally {
      setIsLoading(false);
    }
  }, [sourceIdFilter]);

  useEffect(() => {
    fetchData();
    if (!autoRefresh) return;
    const interval = setInterval(fetchData, 5000);
    return () => clearInterval(interval);
  }, [fetchData, autoRefresh]);

  // ── Submit Events ──────────────────────────────────────────
  const handleEventSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setJsonParseError(null);
    setSubmissionResults([]);
    const trimmed = jsonInput.trim();
    if (!trimmed) { setJsonParseError('Enter a JSON event or array before submitting.'); return; }

    let parsed: any;
    try { parsed = JSON.parse(trimmed); }
    catch { setJsonParseError('Invalid JSON — check brackets, quotes, and commas.'); return; }

    if (!parsed || (Array.isArray(parsed) && parsed.length === 0)) {
      setJsonParseError('Payload must be a JSON object or a non-empty array.');
      return;
    }

    setIsSubmitting(true);
    try {
      const res = await submitEvents(parsed);
      setSubmissionResults(res.results || []);
      showSuccess(`Processed ${res.results.length} event(s) successfully`);
      fetchData();
    } catch (err: any) {
      setJsonParseError(err.message || 'Submission failed.');
    } finally {
      setIsSubmitting(false);
    }
  };

  // ── Sample loaders ─────────────────────────────────────────
  const loadCount = () => {
    setJsonInput(JSON.stringify({
      source_id: 'sewing-line-1',
      event_id: `evt-${Date.now()}`,
      type: 'COUNT',
      quantity: 25,
      event_time: new Date().toISOString(),
    }, null, 2));
    setJsonParseError(null);
    setSubmissionResults([]);
  };

  const loadVoid = () => {
    const target = pendingList[0]?.event_id ?? `evt-${Date.now() - 1000}`;
    setJsonInput(JSON.stringify({
      source_id: 'sewing-line-1',
      event_id: `void-${Date.now()}`,
      type: 'VOID',
      target_event_id: target,
      event_time: new Date().toISOString(),
    }, null, 2));
    setJsonParseError(null);
    setSubmissionResults([]);
  };

  const loadBatch = () => {
    const t = Date.now();
    setJsonInput(JSON.stringify([
      { source_id: 'cutting-section', event_id: `c-${t}`,   type: 'COUNT', quantity: 50, event_time: new Date().toISOString() },
      { source_id: 'cutting-section', event_id: `c-${t+1}`, type: 'COUNT', quantity: 30, event_time: new Date().toISOString() },
      { source_id: 'cutting-section', event_id: `v-${t+2}`, type: 'VOID', target_event_id: `c-${t}`, event_time: new Date().toISOString() },
    ], null, 2));
    setJsonParseError(null);
    setSubmissionResults([]);
  };

  // ── Select ─────────────────────────────────────────────────
  const toggleSelect = (id: string) => {
    const n = new Set(selectedIds);
    n.has(id) ? n.delete(id) : n.add(id);
    setSelectedIds(n);
  };

  const toggleAll = () =>
    setSelectedIds(
      selectedIds.size === pendingList.length
        ? new Set()
        : new Set(pendingList.map((p) => p.event_id))
    );

  // ── Acknowledge ────────────────────────────────────────────
  const handleAck = async () => {
    if (selectedIds.size === 0) return;
    setIsAcking(true);
    try {
      const res = await acknowledgeEvents(Array.from(selectedIds));
      const n = res.results.filter((r) => r.status === 'ACKED').length;
      showSuccess(`Acknowledged ${n} event(s)`);
      setSelectedIds(new Set());
      fetchData();
    } catch (err: any) {
      setGlobalError(err.message || 'Acknowledge failed');
    } finally {
      setIsAcking(false);
    }
  };

  // ── Badge color helper ─────────────────────────────────────
  const statusBadge = (status: string) => (
    <span className={`badge badge-${status}`}>{status}</span>
  );

  // ─────────────────────────────────────────────────────────
  return (
    <div className="app-layout">
      {/* ── Header ── */}
      <header className="app-header">
        <div className="header-brand">
          <div className="header-logo">🏭</div>
          <div>
            <div className="header-title">NorthBridge Garments</div>
            <div className="header-subtitle">Production Event Dashboard</div>
          </div>
        </div>

        <div className="header-controls">
          <LiveClock />
          <input
            type="text"
            className="input-filter"
            placeholder="Filter by Source ID…"
            value={sourceIdFilter}
            onChange={(e) => setSourceIdFilter(e.target.value)}
          />
          <button
            className={`btn btn-secondary btn-sm`}
            onClick={() => setAutoRefresh(!autoRefresh)}
          >
            {autoRefresh ? (
              <><span className="status-dot live" style={{display:'inline-block'}}/> Live</>
            ) : (
              <><span className="status-dot" style={{display:'inline-block'}}/> Paused</>
            )}
          </button>
          <button className="btn btn-secondary btn-sm" onClick={fetchData} disabled={isLoading}>
            {isLoading ? <><span className="spinner"/> Refreshing</> : '↻ Refresh'}
          </button>
          {lastRefresh && (
            <span className="header-time text-muted">
              Updated {lastRefresh.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'})}
            </span>
          )}
        </div>
      </header>

      <main className="main-content">
        {/* ── Alerts ── */}
        {globalError && (
          <div className="alert alert-error">
            <span className="alert-icon">⚠</span>
            <span>{globalError}</span>
          </div>
        )}
        {globalSuccess && (
          <div className="alert alert-success">
            <span className="alert-icon">✓</span>
            <span>{globalSuccess}</span>
          </div>
        )}

        {/* ── KPI Grid ── */}
        <section className="kpi-grid">
          <KpiCard label="Net Total" value={summary.net_total} accent="emerald" sub="accepted units" />
          <KpiCard label="Processed" value={summary.processed_events} accent="cyan" sub="events handled" />
          <KpiCard label="Pending Ack" value={summary.pending_ack} accent="amber" sub="awaiting sign-off" />
          <KpiCard label="Unresolved" value={summary.unresolved} accent="purple" sub="pending VOIDs" />
          <KpiCard label="Duplicates" value={summary.duplicates} accent="slate" sub="suppressed" />
          <KpiCard label="Conflicts" value={summary.conflicts} accent="rose" sub="payload mismatch" />
        </section>

        {/* ── Split: Ingest + MQTT ── */}
        <section className="split-grid">
          {/* Ingest Form */}
          <div className="card">
            <div className="card-header">
              <div className="card-title">
                <span className="card-title-icon icon-blue">📥</span>
                Ingest Production Events
              </div>
              <div className="sample-chips">
                <button className="btn btn-secondary btn-xs" onClick={loadCount}>+ COUNT</button>
                <button className="btn btn-secondary btn-xs" onClick={loadVoid}>+ VOID</button>
                <button className="btn btn-secondary btn-xs" onClick={loadBatch}>+ Batch</button>
              </div>
            </div>
            <div className="card-body">
              <form onSubmit={handleEventSubmit}>
                <textarea
                  className="textarea-json"
                  placeholder={`Paste a single event or array:\n{"source_id":"LINE-01","event_id":"evt-001","type":"COUNT","quantity":5,"event_time":"2026-10-09T10:00:00Z"}`}
                  value={jsonInput}
                  onChange={(e) => { setJsonInput(e.target.value); setJsonParseError(null); }}
                />
                {jsonParseError && (
                  <div className="alert alert-error" style={{ marginTop: '0.5rem' }}>
                    <span className="alert-icon">⚠</span>
                    <span>{jsonParseError}</span>
                  </div>
                )}
                <div className="form-actions">
                  <button type="button" className="btn btn-secondary btn-sm"
                    onClick={() => { setJsonInput(''); setJsonParseError(null); setSubmissionResults([]); }}>
                    Clear
                  </button>
                  <button type="submit" className="btn btn-primary"
                    disabled={isSubmitting || !jsonInput.trim()}>
                    {isSubmitting ? <><span className="spinner"/> Submitting…</> : '▶ Submit Events'}
                  </button>
                </div>
              </form>

              {submissionResults.length > 0 && (
                <>
                  <div className="text-sm text-muted" style={{ marginTop: '0.9rem', marginBottom: '0.4rem', fontWeight: 600 }}>
                    Results — {submissionResults.length} item(s)
                  </div>
                  <div className="results-list">
                    {submissionResults.map((r, i) => (
                      <div key={`${r.event_id}-${i}`} className="result-row">
                        <span className="result-row-id">{r.event_id}</span>
                        <div className="result-row-right">
                          {r.message && <span className="result-msg">{r.message}</span>}
                          {statusBadge(r.status)}
                        </div>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>
          </div>

          {/* MQTT Panel */}
          <div className="card">
            <div className="card-header">
              <div className="card-title">
                <span className="card-title-icon icon-orange">📡</span>
                MQTT Device Integration
              </div>
              {mqttStatus ? (
                <span className={`badge badge-${mqttStatus.connected ? 'ONLINE' : 'OFFLINE'}`}>
                  {mqttStatus.connected ? '● CONNECTED' : '○ DISCONNECTED'}
                </span>
              ) : (
                <span className="badge badge-OFFLINE">○ DISCONNECTED</span>
              )}
            </div>
            <div className="card-body">
              <div className="mqtt-rows">
                <div className="mqtt-row">
                  <span className="mqtt-key">Candidate ID</span>
                  <span className="mqtt-val">{mqttStatus?.candidate_id || '—'}</span>
                </div>
                <div className="mqtt-row">
                  <span className="mqtt-key">Client ID</span>
                  <span className="mqtt-val" style={{ fontSize: '0.68rem' }}>{mqttStatus?.client_id || '—'}</span>
                </div>
                <div className="mqtt-row">
                  <span className="mqtt-key">Last Challenge ID</span>
                  <span className="mqtt-val">{mqttStatus?.last_challenge_id || 'None yet'}</span>
                </div>
                <div className="mqtt-row">
                  <span className="mqtt-key">Last Challenge Time</span>
                  <span className="mqtt-val">
                    {mqttStatus?.last_challenge_time
                      ? new Date(mqttStatus.last_challenge_time).toLocaleString()
                      : '—'}
                  </span>
                </div>
                <div className="mqtt-row">
                  <span className="mqtt-key">Last Response</span>
                  {mqttStatus?.last_response_status
                    ? statusBadge(mqttStatus.last_response_status)
                    : <span className="mqtt-val">—</span>}
                </div>
                <div className="mqtt-row" style={{ border: 'none', paddingTop: '0.75rem' }}>
                  <span className="mqtt-key">Challenge Stats</span>
                  <div className="mqtt-stats">
                    <div className="mqtt-stat">
                      <span className="mqtt-stat-val" style={{ color: 'var(--accent-emerald)' }}>
                        {mqttStatus?.challenge_counts?.completed ?? 0}
                      </span>
                      <span className="mqtt-stat-lbl">Done</span>
                    </div>
                    <div className="mqtt-stat">
                      <span className="mqtt-stat-val" style={{ color: 'var(--accent-rose)' }}>
                        {mqttStatus?.challenge_counts?.failed ?? 0}
                      </span>
                      <span className="mqtt-stat-lbl">Failed</span>
                    </div>
                    <div className="mqtt-stat">
                      <span className="mqtt-stat-val" style={{ color: 'var(--text-primary)' }}>
                        {mqttStatus?.challenge_counts?.total ?? 0}
                      </span>
                      <span className="mqtt-stat-lbl">Total</span>
                    </div>
                  </div>
                </div>
              </div>
              {mqttStatus?.last_error && (
                <div className="alert alert-error" style={{ marginTop: '0.75rem', fontSize: '0.72rem' }}>
                  <span className="alert-icon">⚠</span>
                  <span>{mqttStatus.last_error}</span>
                </div>
              )}
            </div>
          </div>
        </section>

        {/* ── Tables ── */}
        <section className="table-section">
          <div className="tab-bar">
            <div className="tab-list">
              <button
                className={`tab-btn ${activeTab === 'pending' ? 'active' : ''}`}
                onClick={() => setActiveTab('pending')}
              >
                Pending Acknowledgements
                {pendingList.length > 0 && (
                  <span className="badge badge-PENDING_REFERENCE" style={{ marginLeft: '0.4rem' }}>
                    {pendingList.length}
                  </span>
                )}
              </button>
              <button
                className={`tab-btn ${activeTab === 'exceptions' ? 'active' : ''}`}
                onClick={() => setActiveTab('exceptions')}
              >
                Exceptions & Unresolved
                {exceptionsList.length > 0 && (
                  <span className="badge badge-CONFLICT" style={{ marginLeft: '0.4rem' }}>
                    {exceptionsList.length}
                  </span>
                )}
              </button>
            </div>
            <div className="tab-actions">
              {activeTab === 'pending' && (
                <button
                  className="btn btn-success btn-sm"
                  onClick={handleAck}
                  disabled={selectedIds.size === 0 || isAcking}
                >
                  {isAcking
                    ? <><span className="spinner"/> Acknowledging…</>
                    : `✓ Acknowledge (${selectedIds.size})`}
                </button>
              )}
            </div>
          </div>

          {/* Pending tab */}
          {activeTab === 'pending' && (
            <div className="table-wrapper">
              <table>
                <thead>
                  <tr>
                    <th style={{ width: 40 }}>
                      <input
                        type="checkbox"
                        checked={pendingList.length > 0 && selectedIds.size === pendingList.length}
                        onChange={toggleAll}
                      />
                    </th>
                    <th>Event ID</th>
                    <th>Source</th>
                    <th>Type</th>
                    <th>Qty</th>
                    <th>Event Time</th>
                    <th>Received</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {pendingList.length === 0 ? (
                    <tr>
                      <td colSpan={8} className="empty-state">
                        <span className="empty-icon">✅</span>
                        No COUNT events pending acknowledgement
                      </td>
                    </tr>
                  ) : (
                    pendingList.map((row) => (
                      <tr key={row.event_id}>
                        <td>
                          <input
                            type="checkbox"
                            checked={selectedIds.has(row.event_id)}
                            onChange={() => toggleSelect(row.event_id)}
                          />
                        </td>
                        <td className="mono">{row.event_id}</td>
                        <td>{row.source_id}</td>
                        <td>{statusBadge(row.type)}</td>
                        <td className="qty">{row.quantity ?? '—'}</td>
                        <td className="text-sm">{new Date(row.event_time).toLocaleString()}</td>
                        <td className="text-sm">{new Date(row.received_at).toLocaleString()}</td>
                        <td>{statusBadge(row.status)}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          )}

          {/* Exceptions tab */}
          {activeTab === 'exceptions' && (
            <div className="table-wrapper">
              <table>
                <thead>
                  <tr>
                    <th>Event ID</th>
                    <th>Source</th>
                    <th>Classification</th>
                    <th>Target Event ID</th>
                    <th>Reason / Error</th>
                  </tr>
                </thead>
                <tbody>
                  {exceptionsList.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="empty-state">
                        <span className="empty-icon">✅</span>
                        No exceptions or unresolved references
                      </td>
                    </tr>
                  ) : (
                    exceptionsList.map((row, i) => (
                      <tr key={`${row.event_id}-${i}`}>
                        <td className="mono">{row.event_id || '—'}</td>
                        <td>{row.source_id || '—'}</td>
                        <td>{statusBadge(row.type)}</td>
                        <td className="mono">{row.target_event_id || '—'}</td>
                        <td className="reason">{row.reason || 'Awaiting reference target'}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
