-- 001_initial_schema.sql

-- 1. Production Sources table
CREATE TABLE IF NOT EXISTS production_sources (
    source_id VARCHAR(100) PRIMARY KEY,
    display_name VARCHAR(255) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. Production Events table
CREATE TABLE IF NOT EXISTS production_events (
    id BIGSERIAL PRIMARY KEY,
    event_id VARCHAR(100) NOT NULL UNIQUE,
    source_id VARCHAR(100) NOT NULL REFERENCES production_sources(source_id) ON DELETE RESTRICT,
    type VARCHAR(10) NOT NULL,
    quantity INTEGER,
    target_event_id VARCHAR(100),
    event_time TIMESTAMPTZ NOT NULL,
    status VARCHAR(30) NOT NULL,
    received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    acknowledged_at TIMESTAMPTZ,
    void_event_id VARCHAR(100),

    -- Constraint 1: Restricts event type to COUNT or VOID only.
    CONSTRAINT chk_event_type CHECK (type IN ('COUNT', 'VOID')),

    -- Constraint 2: Ensures COUNT events require positive quantity and prohibit target_event_id.
    CONSTRAINT chk_count_event CHECK (
        (type = 'COUNT' AND quantity IS NOT NULL AND quantity > 0 AND target_event_id IS NULL)
        OR (type != 'COUNT')
    ),

    -- Constraint 3: Ensures VOID events require target_event_id and prohibit quantity.
    CONSTRAINT chk_void_event CHECK (
        (type = 'VOID' AND target_event_id IS NOT NULL AND quantity IS NULL)
        OR (type != 'VOID')
    )
);

-- Partial index 1: Prevents multiple accepted VOIDs from referencing and reversing the same COUNT event.
CREATE UNIQUE INDEX IF NOT EXISTS idx_production_events_unique_accepted_void_target 
ON production_events (target_event_id) 
WHERE type = 'VOID' AND status = 'ACCEPTED';

-- Partial index 2: Prevents multiple COUNT events from being marked as voided by the same void_event_id.
CREATE UNIQUE INDEX IF NOT EXISTS idx_production_events_unique_void_ref 
ON production_events (void_event_id) 
WHERE void_event_id IS NOT NULL;

-- 3. Submission Attempts table (logs every raw attempt including duplicates, conflicts, and rejections)
CREATE TABLE IF NOT EXISTS submission_attempts (
    id BIGSERIAL PRIMARY KEY,
    source_id VARCHAR(100),
    event_id VARCHAR(100),
    raw_payload JSONB NOT NULL,
    payload_digest VARCHAR(64) NOT NULL,
    classification VARCHAR(30) NOT NULL,
    error TEXT,
    received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for lookup by event_id on attempts
CREATE INDEX IF NOT EXISTS idx_submission_attempts_event_id ON submission_attempts (event_id);

-- 4. MQTT Challenges table (persists challenge payloads, digests, and responses)
CREATE TABLE IF NOT EXISTS mqtt_challenges (
    id BIGSERIAL PRIMARY KEY,
    challenge_id VARCHAR(100) NOT NULL UNIQUE,
    request_digest VARCHAR(64) NOT NULL,
    request_body JSONB NOT NULL,
    response_body JSONB,
    status VARCHAR(30) NOT NULL,
    error_code VARCHAR(50),
    received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    responded_at TIMESTAMPTZ
);
