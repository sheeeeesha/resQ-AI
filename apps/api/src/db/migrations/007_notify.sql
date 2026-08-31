-- 007_notify
--
-- Live incident updates for the console, via LISTEN/NOTIFY.
--
-- This is why the session pooler was chosen back in the infrastructure setup:
-- transaction-mode pooling does not preserve a LISTEN registration between
-- transactions, so the connection would stop receiving notifications with no
-- error anywhere. Port 5432, not 6543.
--
-- The console never connects to the database. The API holds one listening
-- connection and fans out over SSE, which keeps the rule that has shaped this
-- rebuild from the start: the API owns every read and write, and the browser
-- talks only to the API. The prototype had the browser writing to Firestore
-- directly, and that is the specific thing being engineered out.

CREATE OR REPLACE FUNCTION notify_incident_changed() RETURNS trigger AS $$
DECLARE
    payload text;
BEGIN
    -- Only identifiers and the handful of fields the queue renders.
    --
    -- Two reasons, and both matter. pg_notify silently fails above 8000 bytes,
    -- and an incident with a long transcript would exceed that — the
    -- notification would simply stop arriving for exactly the busiest calls.
    -- And a notification payload is not access-controlled the way a query is,
    -- so putting transcript text or a caller hash in it would leak personal
    -- data to every listener regardless of what they are entitled to read.
    --
    -- The console receives a signal that something changed and re-reads
    -- through the authenticated API.
    payload := json_build_object(
        'incident_id',   NEW.incident_id,
        'reference',     NEW.reference,
        'status',        NEW.status,
        'priority',      NEW.priority_code,
        'incident_type', NEW.incident_type_code,
        'version',       NEW.version,
        'escalated',     array_length(NEW.escalation_triggers, 1) IS NOT NULL,
        'degraded',      NEW.degraded_mode,
        'location_confirmed', (NEW.location ->> 'selected_index') IS NOT NULL,
        'op',            TG_OP
    )::text;

    PERFORM pg_notify('incident_changed', payload);
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- AFTER, and FOR EACH ROW. Firing before commit would announce changes that
-- may still roll back, and a console that showed a P0 which then vanished
-- would be worse than one that updated a second later.
CREATE TRIGGER incidents_notify_changed
    AFTER INSERT OR UPDATE ON incidents
    FOR EACH ROW
    EXECUTE FUNCTION notify_incident_changed();
