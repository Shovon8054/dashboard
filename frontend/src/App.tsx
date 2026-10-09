import { useState, useEffect, useCallback, useId } from 'react';
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

export default function App() {
  // Filters & Toggles
  const [sourceIdFilter, setSourceIdFilter] = useState('');
  const [activeTab, setActiveTab] = useState<'pending' | 'exceptions'>('pending');
  const [autoRefresh, setAutoRefresh] = useState(true);

  // Data states
  const [summary, setSummary] = useState<StateSummary>({
    net_total: 0,
    processed_events: 0,
    pending_ack: 0,
    unresolved: 0,
    duplicates: 0,
    conflicts: 0,
  });
  const [pendingList, setPendingList] = useState<PendingEvent[]>([]);
  const [exceptionsList, setExceptionsList] = useState<ExceptionItem[]>([]);
  const [mqttStatus, setMqttStatus] = useState<MqttStatusResponse | null>(null);

  // UI / Selection states
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [isAcking, setIsAcking] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  // Ingestion form states
  const [jsonInput, setJsonInput] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submissionResults, setSubmissionResults] = useState<EventSubmissionResult[]>([]);
  const [jsonParseError, setJsonParseError] = useState<string | null>(null);

  // Generate unique IDs for testing
  const filterInputId = useId();

  // Fetch all state data
  const fetchData = useCallback(async () => {
    setIsLoading(true);
    setErrorMessage(null);
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
      if (mqttData) {
        setMqttStatus(mqttData);
      }
    } catch (err: any) {
      setErrorMessage(err.message || 'Failed to fetch dashboard data');
    } finally {
      setIsLoading(false);
    }
  }, [sourceIdFilter]);

  // Periodic Auto-refresh
  useEffect(() => {
    fetchData();
    if (!autoRefresh) return;
    const interval = setInterval(fetchData, 5000);
    return () => clearInterval(interval);
  }, [fetchData, autoRefresh]);

  // Handle Event Ingestion Submit
  const handleEventSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setJsonParseError(null);
    setSubmissionResults([]);
    setSuccessMessage(null);

    const trimmed = jsonInput.trim();
    if (!trimmed) {
      setJsonParseError('Please enter a JSON payload to submit.');
      return;
    }

    let parsedPayload: any;
    try {
      parsedPayload = JSON.parse(trimmed);
    } catch {
      setJsonParseError('Invalid JSON format. Please verify brackets, quotes, and commas.');
      return;
    }

    if (
      typeof parsedPayload !== 'object' ||
      parsedPayload === null ||
      (Array.isArray(parsedPayload) && parsedPayload.length === 0)
    ) {
      setJsonParseError('Payload must be a JSON event object or a non-empty array of events.');
      return;
    }

    setIsSubmitting(true);
    try {
      const res = await submitEvents(parsedPayload);
      setSubmissionResults(res.results || []);
      setSuccessMessage(`Processed ${res.results.length} item(s)`);
      fetchData(); // Refresh summary and lists
    } catch (err: any) {
      setJsonParseError(err.message || 'Error occurred during submission.');
    } finally {
      setIsSubmitting(false);
    }
  };

  // Sample Loaders for user convenience
  const loadSampleCount = () => {
    const id = `evt-${Date.now()}`;
    const payload = {
      source_id: 'sewing-line-1',
      event_id: id,
      type: 'COUNT',
      quantity: 25,
      event_time: new Date().toISOString(),
    };
    setJsonInput(JSON.stringify(payload, null, 2));
    setJsonParseError(null);
  };

  const loadSampleVoid = () => {
    const id = `void-${Date.now()}`;
    const targetId = pendingList.length > 0 ? pendingList[0].event_id : `evt-${Date.now() - 1000}`;
    const payload = {
      source_id: 'sewing-line-1',
      event_id: id,
      type: 'VOID',
      target_event_id: targetId,
      event_time: new Date().toISOString(),
    };
    setJsonInput(JSON.stringify(payload, null, 2));
    setJsonParseError(null);
  };

  const loadSampleBatch = () => {
    const c1 = `c-${Date.now()}`;
    const c2 = `c-${Date.now() + 1}`;
    const v1 = `v-${Date.now() + 2}`;
    const payload = [
      {
        source_id: 'cutting-section',
        event_id: c1,
        type: 'COUNT',
        quantity: 50,
        event_time: new Date().toISOString(),
      },
      {
        source_id: 'cutting-section',
        event_id: c2,
        type: 'COUNT',
        quantity: 30,
        event_time: new Date().toISOString(),
      },
      {
        source_id: 'cutting-section',
        event_id: v1,
        type: 'VOID',
        target_event_id: c1,
        event_time: new Date().toISOString(),
      },
    ];
    setJsonInput(JSON.stringify(payload, null, 2));
    setJsonParseError(null);
  };

  // Checkbox multi-select helpers
  const handleToggleSelect = (eventId: string) => {
    const next = new Set(selectedIds);
    if (next.has(eventId)) {
      next.delete(eventId);
    } else {
      next.add(eventId);
    }
    setSelectedIds(next);
  };

  const handleSelectAll = () => {
    if (selectedIds.size === pendingList.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(pendingList.map((p) => p.event_id)));
    }
  };

  // Acknowledge Selected
  const handleAcknowledgeSelected = async () => {
    if (selectedIds.size === 0) return;
    setIsAcking(true);
    setErrorMessage(null);
    try {
      const ids = Array.from(selectedIds);
      const res = await acknowledgeEvents(ids);
      const ackedCount = res.results.filter((r) => r.status === 'ACKED').length;
      setSuccessMessage(`Successfully acknowledged ${ackedCount} event(s).`);
      setSelectedIds(new Set());
      await fetchData();
    } catch (err: any) {
      setErrorMessage(err.message || 'Failed to acknowledge events');
    } finally {
      setIsAcking(false);
    }
  };

  return (
    <div className="dashboard-container">
      {/* Header */}
      <header className="dashboard-header">
        <div className="brand-section">
          <h1 className="brand-title">NorthBridge Garments</h1>
          <p className="brand-subtitle">
            Production Event Processing & MQTT Device Integration
          </p>
        </div>

        <div className="header-controls">
          <label htmlFor={filterInputId} style={{ display: 'none' }}>
            Filter by Source ID
          </label>
          <input
            id={filterInputId}
            type="text"
            className="input-filter"
            placeholder="Filter by Source ID..."
            value={sourceIdFilter}
            onChange={(e) => setSourceIdFilter(e.target.value)}
          />

          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => setAutoRefresh(!autoRefresh)}
          >
            {autoRefresh ? 'Auto-refresh: ON (5s)' : 'Auto-refresh: OFF'}
          </button>

          <button
            type="button"
            className="btn btn-primary"
            onClick={fetchData}
            disabled={isLoading}
          >
            {isLoading ? 'Refreshing...' : 'Manual Refresh'}
          </button>
        </div>
      </header>

      {/* Global Alerts */}
      {errorMessage && (
        <div className="alert-box alert-error">
          ⚠️ <strong>Error:</strong> {errorMessage}
        </div>
      )}
      {successMessage && (
        <div className="alert-box alert-success">
          ✅ {successMessage}
        </div>
      )}

      {/* Six Indicator Cards */}
      <section className="indicators-grid">
        <div className="indicator-card">
          <span className="indicator-label">Net Total</span>
          <span className="indicator-value val-emerald">
            {summary.net_total.toLocaleString()}
          </span>
        </div>
        <div className="indicator-card">
          <span className="indicator-label">Processed Events</span>
          <span className="indicator-value val-cyan">
            {summary.processed_events.toLocaleString()}
          </span>
        </div>
        <div className="indicator-card">
          <span className="indicator-label">Pending Ack</span>
          <span className="indicator-value val-amber">
            {summary.pending_ack.toLocaleString()}
          </span>
        </div>
        <div className="indicator-card">
          <span className="indicator-label">Unresolved</span>
          <span className="indicator-value val-purple">
            {summary.unresolved.toLocaleString()}
          </span>
        </div>
        <div className="indicator-card">
          <span className="indicator-label">Duplicates</span>
          <span className="indicator-value val-slate">
            {summary.duplicates.toLocaleString()}
          </span>
        </div>
        <div className="indicator-card">
          <span className="indicator-label">Conflicts</span>
          <span className="indicator-value val-rose">
            {summary.conflicts.toLocaleString()}
          </span>
        </div>
      </section>

      {/* Middle Split: Ingestion Form & MQTT Panel */}
      <section className="content-grid">
        {/* Ingestion Form */}
        <div className="card">
          <div className="card-title">
            <span>Ingest Production Events</span>
            <div className="sample-buttons">
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={loadSampleCount}
              >
                + COUNT
              </button>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={loadSampleVoid}
              >
                + VOID
              </button>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={loadSampleBatch}
              >
                + Batch
              </button>
            </div>
          </div>

          <form onSubmit={handleEventSubmit}>
            <textarea
              className="textarea-json font-mono"
              placeholder='Paste single event or array: {"source_id":"line-1","event_id":"ev-01","type":"COUNT","quantity":10,"event_time":"2026-10-09T06:00:00Z"}'
              value={jsonInput}
              onChange={(e) => {
                setJsonInput(e.target.value);
                setJsonParseError(null);
              }}
            />

            {jsonParseError && (
              <div className="alert-box alert-error" style={{ marginTop: '0.5rem' }}>
                {jsonParseError}
              </div>
            )}

            <div className="form-actions" style={{ marginTop: '0.75rem' }}>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => {
                  setJsonInput('');
                  setJsonParseError(null);
                  setSubmissionResults([]);
                }}
              >
                Clear
              </button>

              <button
                type="submit"
                className="btn btn-primary"
                disabled={isSubmitting || !jsonInput.trim()}
              >
                {isSubmitting ? 'Submitting...' : 'Submit Events'}
              </button>
            </div>
          </form>

          {/* Submission Results Display */}
          {submissionResults.length > 0 && (
            <div style={{ marginTop: '0.5rem' }}>
              <div style={{ fontSize: '0.8rem', fontWeight: 600, marginBottom: '0.4rem', color: 'var(--text-muted)' }}>
                Submission Results ({submissionResults.length}):
              </div>
              <div className="results-container">
                {submissionResults.map((r, idx) => (
                  <div key={`${r.event_id}-${idx}`} className="result-item">
                    <span className="font-mono">{r.event_id}</span>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                      {r.message && (
                        <span style={{ color: 'var(--text-muted)', fontSize: '0.75rem' }}>
                          {r.message}
                        </span>
                      )}
                      <span className={`badge badge-${r.status}`}>{r.status}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* MQTT Device Integration Panel */}
        <div className="card">
          <div className="card-title">
            <span>MQTT Device Integration</span>
            <span
              className={`badge ${
                mqttStatus?.connected ? 'badge-ONLINE' : 'badge-OFFLINE'
              }`}
            >
              {mqttStatus?.connected ? 'CONNECTED' : 'DISCONNECTED'}
            </span>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <div className="mqtt-row">
              <span className="mqtt-label">Candidate ID</span>
              <span className="font-mono">
                {mqttStatus?.candidate_id || 'Not configured'}
              </span>
            </div>

            <div className="mqtt-row">
              <span className="mqtt-label">Client ID</span>
              <span className="font-mono" style={{ fontSize: '0.75rem' }}>
                {mqttStatus?.client_id || '—'}
              </span>
            </div>

            <div className="mqtt-row">
              <span className="mqtt-label">Last Challenge ID</span>
              <span className="font-mono">
                {mqttStatus?.last_challenge_id || 'None yet'}
              </span>
            </div>

            <div className="mqtt-row">
              <span className="mqtt-label">Last Challenge Time</span>
              <span>
                {mqttStatus?.last_challenge_time
                  ? new Date(mqttStatus.last_challenge_time).toLocaleTimeString()
                  : '—'}
              </span>
            </div>

            <div className="mqtt-row">
              <span className="mqtt-label">Last Response Status</span>
              {mqttStatus?.last_response_status ? (
                <span className={`badge badge-${mqttStatus.last_response_status}`}>
                  {mqttStatus.last_response_status}
                </span>
              ) : (
                <span>—</span>
              )}
            </div>

            <div className="mqtt-row">
              <span className="mqtt-label">Challenge Stats</span>
              <span>
                Completed:{' '}
                <strong style={{ color: 'var(--color-success)' }}>
                  {mqttStatus?.challenge_counts?.completed ?? 0}
                </strong>{' '}
                | Failed:{' '}
                <strong style={{ color: 'var(--color-danger)' }}>
                  {mqttStatus?.challenge_counts?.failed ?? 0}
                </strong>{' '}
                | Total:{' '}
                <strong>{mqttStatus?.challenge_counts?.total ?? 0}</strong>
              </span>
            </div>

            {mqttStatus?.last_error && (
              <div
                className="alert-box alert-error"
                style={{ marginTop: '0.75rem', fontSize: '0.75rem' }}
              >
                ⚠️ Last MQTT Error: {mqttStatus.last_error}
              </div>
            )}
          </div>
        </div>
      </section>

      {/* Tables Section: Pending vs Exceptions */}
      <section className="table-panel">
        <div className="table-header-tabs">
          <div className="tabs-group">
            <button
              type="button"
              className={`tab-btn ${activeTab === 'pending' ? 'active' : ''}`}
              onClick={() => setActiveTab('pending')}
            >
              Pending Acknowledgements (COUNT only) ({pendingList.length})
            </button>
            <button
              type="button"
              className={`tab-btn ${activeTab === 'exceptions' ? 'active' : ''}`}
              onClick={() => setActiveTab('exceptions')}
            >
              Exceptions & Unresolved ({exceptionsList.length})
            </button>
          </div>

          {activeTab === 'pending' && pendingList.length > 0 && (
            <button
              type="button"
              className="btn btn-primary"
              onClick={handleAcknowledgeSelected}
              disabled={selectedIds.size === 0 || isAcking}
            >
              {isAcking
                ? 'Acknowledging...'
                : `Acknowledge Selected (${selectedIds.size})`}
            </button>
          )}
        </div>

        {/* Tab 1: Pending Table */}
        {activeTab === 'pending' && (
          <div className="table-wrapper">
            <table>
              <thead>
                <tr>
                  <th style={{ width: '40px' }}>
                    <input
                      type="checkbox"
                      checked={
                        pendingList.length > 0 &&
                        selectedIds.size === pendingList.length
                      }
                      onChange={handleSelectAll}
                    />
                  </th>
                  <th>Event ID</th>
                  <th>Source ID</th>
                  <th>Type</th>
                  <th>Quantity</th>
                  <th>Event Time</th>
                  <th>Received At</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {pendingList.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="empty-state">
                      No pending COUNT events awaiting acknowledgement.
                    </td>
                  </tr>
                ) : (
                  pendingList.map((item) => (
                    <tr key={item.event_id}>
                      <td>
                        <input
                          type="checkbox"
                          checked={selectedIds.has(item.event_id)}
                          onChange={() => handleToggleSelect(item.event_id)}
                        />
                      </td>
                      <td className="font-mono">{item.event_id}</td>
                      <td>{item.source_id}</td>
                      <td>
                        <span className="badge badge-ACCEPTED">{item.type}</span>
                      </td>
                      <td style={{ fontWeight: 600 }}>{item.quantity ?? '—'}</td>
                      <td>{new Date(item.event_time).toLocaleTimeString()}</td>
                      <td>{new Date(item.received_at).toLocaleTimeString()}</td>
                      <td>
                        <span className={`badge badge-${item.status}`}>
                          {item.status}
                        </span>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        )}

        {/* Tab 2: Exceptions Table */}
        {activeTab === 'exceptions' && (
          <div className="table-wrapper">
            <table>
              <thead>
                <tr>
                  <th>Event ID</th>
                  <th>Source ID</th>
                  <th>Classification / Type</th>
                  <th>Reason / Error</th>
                  <th>Target Event ID</th>
                </tr>
              </thead>
              <tbody>
                {exceptionsList.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="empty-state">
                      No exceptions or unresolved reference events found.
                    </td>
                  </tr>
                ) : (
                  exceptionsList.map((item, idx) => (
                    <tr key={`${item.event_id || 'no-id'}-${idx}`}>
                      <td className="font-mono">{item.event_id || '—'}</td>
                      <td>{item.source_id || '—'}</td>
                      <td>
                        <span className={`badge badge-${item.type}`}>
                          {item.type}
                        </span>
                      </td>
                      <td style={{ color: 'var(--color-danger)' }}>
                        {item.reason || 'Pending reference target resolution'}
                      </td>
                      <td className="font-mono">
                        {item.target_event_id || '—'}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
