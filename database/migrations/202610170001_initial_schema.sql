-- Gear foundation only: no business RPC, Auth configuration or Storage changes.
-- Execute once as the database owner. Any existing target namespace aborts.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE SCHEMA gear;
CREATE SCHEMA gear_private;
COMMENT ON SCHEMA gear IS 'Gear migration 202610170001: initial schema';
COMMENT ON SCHEMA gear_private IS 'Gear internal helpers; never expose through Data API';
REVOKE ALL ON SCHEMA gear, gear_private FROM PUBLIC, anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA gear REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA gear_private REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

CREATE TABLE gear.members (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    auth_user_id uuid UNIQUE REFERENCES auth.users(id) ON DELETE SET NULL,
    display_name text NOT NULL CHECK (btrim(display_name) <> ''),
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','rejected','disabled')),
    role text CHECK (role IN ('admin','operator','viewer')),
    party_id uuid UNIQUE,
    reviewed_by uuid REFERENCES gear.members(id) ON DELETE RESTRICT,
    reviewed_at timestamptz,
    review_note text CHECK (review_note IS NULL OR btrim(review_note) <> ''),
    version integer NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK ((status = 'active' AND role IS NOT NULL) OR (status <> 'active' AND role IS NULL)),
    CHECK ((reviewed_by IS NULL) = (reviewed_at IS NULL))
);

CREATE TABLE gear.parties (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    kind text NOT NULL CHECK (kind IN ('person','team','organization')),
    name text NOT NULL CHECK (btrim(name) <> ''),
    person_type text CHECK (person_type IN ('staff','seconded','attached','temporary','other')),
    organization_name text,
    contact text,
    note text,
    default_responsible_id uuid REFERENCES gear.parties(id) ON DELETE RESTRICT,
    is_active boolean NOT NULL DEFAULT true,
    created_by uuid NOT NULL REFERENCES gear.members(id) ON DELETE RESTRICT,
    version integer NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK (kind = 'person' OR person_type IS NULL),
    CHECK ((kind = 'team' AND default_responsible_id IS NOT NULL)
        OR (kind <> 'team' AND default_responsible_id IS NULL))
);
ALTER TABLE gear.members ADD FOREIGN KEY (party_id) REFERENCES gear.parties(id) ON DELETE RESTRICT;

CREATE SEQUENCE gear.asset_code_sequence AS bigint NO CYCLE;
CREATE TABLE gear.assets (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    asset_code text NOT NULL UNIQUE CHECK (btrim(asset_code) <> ''),
    legacy_code text,
    serial_number text,
    name text NOT NULL CHECK (btrim(name) <> ''),
    category text NOT NULL CHECK (btrim(category) <> ''),
    brand text,
    model text,
    location text,
    note text,
    management_status text NOT NULL DEFAULT 'managed'
        CHECK (management_status IN ('managed','returned_upstream','lost','scrapped')),
    condition text NOT NULL CHECK (condition IN ('normal','faulty')),
    last_flow_on date,
    invalidated_at timestamptz,
    invalidated_by uuid REFERENCES gear.members(id) ON DELETE RESTRICT,
    invalid_reason text,
    created_by uuid NOT NULL REFERENCES gear.members(id) ON DELETE RESTRICT,
    version integer NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK ((invalidated_at IS NULL AND invalidated_by IS NULL AND invalid_reason IS NULL)
        OR (invalidated_at IS NOT NULL AND invalidated_by IS NOT NULL
            AND invalid_reason IS NOT NULL AND btrim(invalid_reason) <> ''))
);

CREATE TABLE gear.documents (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    create_request_id uuid NOT NULL,
    kind text NOT NULL CHECK (kind IN ('receipt','issue','transfer','return')),
    transfer_mode text CHECK (transfer_mode IN ('holder','responsibility')),
    status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','confirmed','voided')),
    document_no text UNIQUE CHECK (document_no IS NULL OR btrim(document_no) <> ''),
    numbering_on date,
    number_value bigint CHECK (number_value > 0),
    handover_on date,
    from_kind text CHECK (from_kind IN ('inventory','party','external')),
    to_kind text CHECK (to_kind IN ('inventory','party','external')),
    from_party_id uuid REFERENCES gear.parties(id) ON DELETE RESTRICT,
    to_party_id uuid REFERENCES gear.parties(id) ON DELETE RESTRICT,
    from_person_id uuid REFERENCES gear.parties(id) ON DELETE RESTRICT,
    to_person_id uuid REFERENCES gear.parties(id) ON DELETE RESTRICT,
    from_label text,
    to_label text,
    sender_name text,
    receiver_name text,
    usage_kind text CHECK (usage_kind IN ('long_term','temporary')),
    due_on date,
    header_snapshot jsonb CHECK (jsonb_typeof(header_snapshot) = 'object'),
    parties_snapshot jsonb CHECK (jsonb_typeof(parties_snapshot) = 'object'),
    evidence_state text CHECK (evidence_state IN ('awaiting_upload','awaiting_review','archived')),
    created_by uuid NOT NULL REFERENCES gear.members(id) ON DELETE RESTRICT,
    confirmed_by uuid REFERENCES gear.members(id) ON DELETE RESTRICT,
    confirmed_at timestamptz,
    archived_by uuid REFERENCES gear.members(id) ON DELETE RESTRICT,
    archived_at timestamptz,
    voided_by uuid REFERENCES gear.members(id) ON DELETE RESTRICT,
    voided_at timestamptz,
    void_reason text,
    version integer NOT NULL DEFAULT 1 CHECK (version > 0),
    confirmed_revision integer CHECK (confirmed_revision > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (created_by, create_request_id),
    UNIQUE (numbering_on, number_value),
    CHECK ((kind = 'transfer' AND transfer_mode IS NOT NULL)
        OR (kind <> 'transfer' AND transfer_mode IS NULL)),
    CHECK ((status = 'draft' AND document_no IS NULL AND numbering_on IS NULL
        AND number_value IS NULL AND confirmed_by IS NULL AND confirmed_at IS NULL
        AND confirmed_revision IS NULL AND header_snapshot IS NULL AND parties_snapshot IS NULL
        AND evidence_state IS NULL AND archived_by IS NULL AND archived_at IS NULL)
        OR (status <> 'draft' AND document_no IS NOT NULL AND numbering_on IS NOT NULL
        AND number_value IS NOT NULL AND confirmed_by IS NOT NULL AND confirmed_at IS NOT NULL
        AND confirmed_revision IS NOT NULL AND header_snapshot IS NOT NULL AND parties_snapshot IS NOT NULL
        AND evidence_state IS NOT NULL AND handover_on IS NOT NULL
        AND from_kind IS NOT NULL AND to_kind IS NOT NULL
        AND from_label IS NOT NULL AND to_label IS NOT NULL
        AND sender_name IS NOT NULL AND receiver_name IS NOT NULL
        AND btrim(from_label) <> '' AND btrim(to_label) <> ''
        AND btrim(sender_name) <> '' AND btrim(receiver_name) <> ''
        AND numbering_on = (confirmed_at AT TIME ZONE 'Asia/Shanghai')::date
        AND handover_on <= numbering_on)),
    CHECK ((status <> 'voided' AND voided_by IS NULL AND voided_at IS NULL AND void_reason IS NULL)
        OR (status = 'voided' AND voided_by IS NOT NULL AND voided_at IS NOT NULL
        AND void_reason IS NOT NULL AND btrim(void_reason) <> '')),
    CHECK ((evidence_state IS DISTINCT FROM 'archived' AND archived_by IS NULL AND archived_at IS NULL)
        OR (evidence_state = 'archived' AND archived_by IS NOT NULL AND archived_at IS NOT NULL)),
    CHECK (status = 'draft' OR COALESCE(
        (kind = 'receipt' AND from_kind = 'external' AND to_kind = 'inventory')
        OR (kind = 'issue' AND from_kind = 'inventory' AND to_kind = 'party' AND to_party_id IS NOT NULL)
        OR (kind = 'transfer' AND from_kind = 'party' AND to_kind = 'party'
            AND from_party_id IS NOT NULL AND to_party_id IS NOT NULL
            AND ((transfer_mode = 'holder' AND from_party_id <> to_party_id)
                OR (transfer_mode = 'responsibility' AND from_party_id = to_party_id)))
        OR (kind = 'return' AND from_kind IN ('party','inventory')
            AND to_kind IN ('inventory','external') AND from_kind <> to_kind), false)),
    CHECK (status = 'draft' OR COALESCE(
        (kind = 'issue' OR (kind = 'transfer' AND transfer_mode = 'holder'))
            AND ((usage_kind = 'long_term' AND due_on IS NULL)
                OR (usage_kind = 'temporary' AND due_on IS NOT NULL AND due_on >= handover_on))
        OR (kind IN ('receipt','return') OR (kind = 'transfer' AND transfer_mode = 'responsibility'))
            AND usage_kind IS NULL AND due_on IS NULL, false))
);

CREATE TABLE gear.document_items (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id uuid NOT NULL REFERENCES gear.documents(id) ON DELETE CASCADE,
    line_no integer NOT NULL CHECK (line_no > 0),
    asset_id uuid REFERENCES gear.assets(id) ON DELETE RESTRICT,
    new_asset_data jsonb CHECK (jsonb_typeof(new_asset_data) = 'object'),
    expected_asset_version integer CHECK (expected_asset_version > 0),
    condition_on_handover text CHECK (condition_on_handover IN ('normal','faulty')),
    location text,
    note text,
    asset_snapshot jsonb CHECK (jsonb_typeof(asset_snapshot) = 'object'),
    state_before jsonb CHECK (jsonb_typeof(state_before) = 'object'),
    state_after jsonb CHECK (jsonb_typeof(state_after) = 'object'),
    confirmed_event_id bigint UNIQUE,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (document_id, line_no),
    UNIQUE (document_id, asset_id),
    CHECK (condition_on_handover IS DISTINCT FROM 'faulty' OR (note IS NOT NULL AND btrim(note) <> ''))
);

CREATE TABLE gear.events (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    scope text NOT NULL CHECK (scope IN ('asset','party','document','draft','member','settings')),
    event_type text NOT NULL CHECK (event_type IN (
        'asset_initialized','asset_updated','asset_fault_reported','asset_repaired',
        'asset_lost','asset_scrapped','asset_found','asset_invalidated','assignment_extended',
        'document_confirmed','document_voided','draft_created','draft_updated','draft_deleted',
        'party_created','party_updated','member_applied','member_reviewed','member_role_changed',
        'settings_updated','attachment_uploaded','attachment_reviewed','attachment_corrected')),
    asset_id uuid REFERENCES gear.assets(id) ON DELETE RESTRICT,
    document_id uuid REFERENCES gear.documents(id) ON DELETE RESTRICT,
    document_item_id uuid REFERENCES gear.document_items(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
    target_member_id uuid REFERENCES gear.members(id) ON DELETE RESTRICT,
    target_party_id uuid REFERENCES gear.parties(id) ON DELETE RESTRICT,
    occurred_on date,
    recorded_at timestamptz NOT NULL DEFAULT now(),
    actor_member_id uuid REFERENCES gear.members(id) ON DELETE RESTRICT,
    actor_label text NOT NULL CHECK (btrim(actor_label) <> ''),
    actor_source text NOT NULL CHECK (actor_source IN ('user','system','bootstrap')),
    affects_asset_state boolean NOT NULL DEFAULT false,
    before_data jsonb CHECK (jsonb_typeof(before_data) = 'object'),
    after_data jsonb CHECK (jsonb_typeof(after_data) = 'object'),
    reason text,
    reverses_event_id bigint UNIQUE REFERENCES gear.events(id) ON DELETE RESTRICT,
    request_id uuid UNIQUE,
    request_payload jsonb CHECK (jsonb_typeof(request_payload) = 'object'),
    CHECK (scope <> 'asset' OR asset_id IS NOT NULL),
    CHECK (NOT affects_asset_state OR asset_id IS NOT NULL),
    CHECK (actor_source <> 'user' OR actor_member_id IS NOT NULL),
    CHECK ((request_id IS NULL) = (request_payload IS NULL)),
    CHECK (reverses_event_id IS NULL OR reverses_event_id <> id),
    -- Draft identifiers belong in the snapshot, so deleting a draft retains its audit.
    CHECK (scope <> 'draft' OR (document_id IS NULL AND document_item_id IS NULL))
);
ALTER TABLE gear.document_items ADD FOREIGN KEY (confirmed_event_id)
    REFERENCES gear.events(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE gear.assignments (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    asset_id uuid NOT NULL REFERENCES gear.assets(id) ON DELETE RESTRICT,
    holder_party_id uuid NOT NULL REFERENCES gear.parties(id) ON DELETE RESTRICT,
    responsible_person_id uuid NOT NULL REFERENCES gear.parties(id) ON DELETE RESTRICT,
    usage_kind text NOT NULL CHECK (usage_kind IN ('long_term','temporary')),
    started_on date,
    due_on date,
    ended_on date,
    closed_at timestamptz,
    opened_event_id bigint NOT NULL REFERENCES gear.events(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
    closed_event_id bigint REFERENCES gear.events(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
    source_item_id uuid UNIQUE REFERENCES gear.document_items(id) ON DELETE RESTRICT,
    followup_member_id uuid NOT NULL REFERENCES gear.members(id) ON DELETE RESTRICT,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK ((usage_kind = 'long_term' AND due_on IS NULL)
        OR (usage_kind = 'temporary' AND due_on IS NOT NULL)),
    CHECK (started_on IS NULL OR due_on IS NULL OR due_on >= started_on),
    CHECK (started_on IS NULL OR ended_on IS NULL OR ended_on >= started_on),
    CHECK ((closed_at IS NULL AND closed_event_id IS NULL AND ended_on IS NULL)
        OR (closed_at IS NOT NULL AND closed_event_id IS NOT NULL))
);
CREATE UNIQUE INDEX assignments_one_current_asset ON gear.assignments(asset_id) WHERE closed_at IS NULL;
CREATE INDEX assignments_current_holder ON gear.assignments(holder_party_id) WHERE closed_at IS NULL;
CREATE INDEX assignments_current_due ON gear.assignments(due_on) WHERE closed_at IS NULL AND usage_kind = 'temporary';
CREATE INDEX assignments_asset_history ON gear.assignments(asset_id, created_at);

CREATE TABLE gear.attachments (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id uuid REFERENCES gear.documents(id) ON DELETE RESTRICT,
    event_id bigint REFERENCES gear.events(id) ON DELETE RESTRICT,
    storage_key text NOT NULL UNIQUE CHECK (btrim(storage_key) <> ''),
    original_name text NOT NULL CHECK (btrim(original_name) <> ''),
    media_type text CHECK (media_type IS NULL OR btrim(media_type) <> ''),
    size_bytes bigint CHECK (size_bytes > 0),
    page_count integer CHECK (page_count > 0),
    sha256 text CHECK (sha256 ~ '^[0-9a-f]{64}$'),
    upload_state text NOT NULL DEFAULT 'pending' CHECK (upload_state IN ('pending','ready','failed')),
    uploaded_by uuid NOT NULL REFERENCES gear.members(id) ON DELETE RESTRICT,
    uploaded_at timestamptz,
    ocr_state text NOT NULL DEFAULT 'none' CHECK (ocr_state IN ('none','queued','processing','succeeded','failed')),
    ocr_result jsonb CHECK (jsonb_typeof(ocr_result) = 'object'),
    ocr_error_code text,
    review_state text NOT NULL DEFAULT 'pending' CHECK (review_state IN ('pending','accepted','rejected')),
    reviewed_by uuid REFERENCES gear.members(id) ON DELETE RESTRICT,
    reviewed_at timestamptz,
    is_active boolean NOT NULL DEFAULT true,
    supersedes_id uuid REFERENCES gear.attachments(id) ON DELETE RESTRICT,
    correction_reason text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK ((document_id IS NULL) <> (event_id IS NULL)),
    CHECK (supersedes_id IS NULL OR supersedes_id <> id),
    CHECK (supersedes_id IS NULL OR (correction_reason IS NOT NULL AND btrim(correction_reason) <> '')),
    CHECK ((upload_state = 'ready' AND media_type IS NOT NULL AND size_bytes IS NOT NULL
            AND sha256 IS NOT NULL AND uploaded_at IS NOT NULL)
        OR (upload_state <> 'ready' AND media_type IS NULL AND size_bytes IS NULL
            AND page_count IS NULL AND sha256 IS NULL AND uploaded_at IS NULL)),
    CHECK ((review_state = 'pending' AND reviewed_by IS NULL AND reviewed_at IS NULL)
        OR (review_state <> 'pending' AND upload_state = 'ready'
            AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL)),
    CHECK (upload_state = 'ready' OR ocr_state = 'none')
);

CREATE TABLE gear.app_settings (
    id smallint PRIMARY KEY CHECK (id = 1),
    document_header text NOT NULL CHECK (btrim(document_header) <> ''),
    reminder_lead_days integer NOT NULL CHECK (reminder_lead_days >= 0),
    reminder_local_time time NOT NULL,
    outbound_mail_enabled boolean NOT NULL DEFAULT false,
    version integer NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO gear.app_settings (id, document_header, reminder_lead_days, reminder_local_time)
VALUES (1, '设备簿', 3, '09:00');

CREATE TABLE gear.document_counters (
    business_on date PRIMARY KEY,
    last_value bigint NOT NULL CHECK (last_value >= 0),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE gear.notification_outbox (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    dedup_key text NOT NULL UNIQUE CHECK (btrim(dedup_key) <> ''),
    notification_type text NOT NULL CHECK (notification_type IN ('application_pending','application_result','daily_due')),
    recipient_member_id uuid NOT NULL REFERENCES gear.members(id) ON DELETE RESTRICT,
    source_event_id bigint REFERENCES gear.events(id) ON DELETE RESTRICT,
    business_on date,
    payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','submitted','failed','unknown','cancelled')),
    available_at timestamptz NOT NULL DEFAULT now(),
    lease_until timestamptz,
    last_attempt_at timestamptz,
    submitted_at timestamptz,
    attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    provider_message_id text,
    error_code text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK ((status = 'processing' AND lease_until IS NOT NULL AND last_attempt_at IS NOT NULL AND attempt_count > 0)
        OR (status <> 'processing' AND lease_until IS NULL)),
    CHECK ((status = 'submitted' AND submitted_at IS NOT NULL AND provider_message_id IS NOT NULL)
        OR (status <> 'submitted' AND submitted_at IS NULL AND provider_message_id IS NULL))
);

CREATE INDEX members_pending ON gear.members(status, created_at);
CREATE INDEX events_asset_history ON gear.events(asset_id, id);
CREATE INDEX documents_confirmed ON gear.documents(confirmed_at);
CREATE INDEX attachments_document ON gear.attachments(document_id);
CREATE INDEX attachments_event ON gear.attachments(event_id);
CREATE INDEX outbox_available ON gear.notification_outbox(status, available_at);

-- Uniform normalization and optimistic version stamps. Callers must still lock
-- rows and compare expected versions in the future transaction RPCs.
CREATE FUNCTION gear_private.prepare_record() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE payload jsonb := to_jsonb(NEW); field record;
BEGIN
    FOR field IN SELECT key, value FROM jsonb_each(payload)
        WHERE jsonb_typeof(value) = 'string' AND value #>> '{}' ~ '^\s*$'
    LOOP
        payload := jsonb_set(payload, ARRAY[field.key], 'null'::jsonb);
    END LOOP;
    NEW := jsonb_populate_record(NEW, payload);
    IF TG_OP = 'UPDATE' THEN
        NEW.created_at := OLD.created_at;
        IF payload ? 'version' THEN
            NEW := jsonb_populate_record(NEW, jsonb_build_object('version', (to_jsonb(OLD)->>'version')::integer + 1));
        END IF;
    ELSIF payload ? 'version' THEN
        NEW := jsonb_populate_record(NEW, '{"version":1}'::jsonb);
    END IF;
    NEW.updated_at := clock_timestamp();
    RETURN NEW;
END;
$$;

CREATE FUNCTION gear_private.protect_record() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE protected_doc uuid;
BEGIN
    IF TG_TABLE_NAME = 'events' THEN RAISE EXCEPTION 'events are append only' USING ERRCODE = '23514'; END IF;
    IF TG_TABLE_NAME = 'assets' THEN
        IF TG_OP = 'DELETE' OR NEW.asset_code IS DISTINCT FROM OLD.asset_code THEN
            RAISE EXCEPTION 'asset identity is permanent' USING ERRCODE = '23514';
        END IF;
    END IF;
    IF TG_TABLE_NAME = 'parties' THEN
        IF NEW.kind IS DISTINCT FROM OLD.kind THEN
            RAISE EXCEPTION 'party kind is permanent' USING ERRCODE = '23514';
        END IF;
    END IF;
    IF TG_TABLE_NAME = 'documents' THEN
        IF OLD.status <> 'draft' THEN
            IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'formal document cannot be deleted' USING ERRCODE = '23514'; END IF;
            IF (OLD.status = 'voided' AND NEW.status <> 'voided') OR NEW.status = 'draft'
                OR (to_jsonb(NEW) - ARRAY['status','evidence_state','archived_by','archived_at','voided_by','voided_at','void_reason','version','updated_at'])
                    IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status','evidence_state','archived_by','archived_at','voided_by','voided_at','void_reason','version','updated_at']) THEN
                RAISE EXCEPTION 'formal document fields are frozen' USING ERRCODE = '23514';
            END IF;
        END IF;
    END IF;
    IF TG_TABLE_NAME = 'document_items' THEN
        IF TG_OP <> 'INSERT' THEN
            SELECT d.id INTO protected_doc FROM gear.documents d WHERE d.id = OLD.document_id AND d.status <> 'draft';
        END IF;
        IF protected_doc IS NOT NULL OR (TG_OP <> 'DELETE' AND EXISTS (
            SELECT 1 FROM gear.documents d WHERE d.id = NEW.document_id AND d.status <> 'draft')) THEN
            RAISE EXCEPTION 'formal document items are frozen' USING ERRCODE = '23514';
        END IF;
    END IF;
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
END;
$$;

-- Cross-row checks are deferred so a complete handover can change several rows
-- atomically. Fixed transaction RPCs will supply authorization and locking.
CREATE FUNCTION gear_private.check_relations() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
    IF EXISTS (SELECT 1 FROM gear.members m JOIN gear.parties p ON p.id = m.party_id WHERE p.kind <> 'person')
        OR EXISTS (SELECT 1 FROM gear.parties t JOIN gear.parties p ON p.id = t.default_responsible_id WHERE p.kind <> 'person') THEN
        RAISE EXCEPTION 'responsible party must be a person' USING ERRCODE = '23514';
    END IF;
    IF EXISTS (SELECT 1 FROM gear.assignments x
        JOIN gear.parties h ON h.id = x.holder_party_id JOIN gear.parties p ON p.id = x.responsible_person_id
        JOIN gear.assets a ON a.id = x.asset_id JOIN gear.events e ON e.id = x.opened_event_id
        LEFT JOIN gear.events z ON z.id = x.closed_event_id
        LEFT JOIN gear.document_items i ON i.id = x.source_item_id
        WHERE h.kind NOT IN ('person','team') OR p.kind <> 'person'
            OR (h.kind = 'person' AND h.id <> p.id)
            OR (x.closed_at IS NULL AND (a.management_status <> 'managed' OR a.invalidated_at IS NOT NULL))
            OR e.asset_id IS DISTINCT FROM a.id
            OR (z.id IS NOT NULL AND z.asset_id IS DISTINCT FROM a.id)
            OR (i.id IS NOT NULL AND i.asset_id IS DISTINCT FROM a.id)) THEN
        RAISE EXCEPTION 'invalid assignment relation' USING ERRCODE = '23514';
    END IF;
    IF EXISTS (SELECT 1 FROM gear.documents d WHERE d.status <> 'draft' AND NOT EXISTS (
        SELECT 1 FROM gear.document_items i WHERE i.document_id = d.id))
        OR EXISTS (SELECT 1 FROM gear.document_items i JOIN gear.documents d ON d.id = i.document_id
            LEFT JOIN gear.events e ON e.id = i.confirmed_event_id
            WHERE d.status <> 'draft' AND (i.asset_id IS NULL OR i.asset_snapshot IS NULL
                OR i.state_before IS NULL OR i.state_after IS NULL OR e.id IS NULL
                OR e.asset_id IS DISTINCT FROM i.asset_id OR e.document_id IS DISTINCT FROM d.id
                OR e.document_item_id IS DISTINCT FROM i.id)) THEN
        RAISE EXCEPTION 'formal document requires complete item events' USING ERRCODE = '23514';
    END IF;
    IF EXISTS (SELECT 1 FROM gear.attachments a JOIN gear.documents d ON d.id = a.document_id WHERE d.status = 'draft')
        OR EXISTS (SELECT 1 FROM gear.documents d WHERE d.evidence_state = 'archived' AND NOT EXISTS (
            SELECT 1 FROM gear.attachments a WHERE a.document_id = d.id AND a.is_active
                AND a.upload_state = 'ready' AND a.review_state = 'accepted')) THEN
        RAISE EXCEPTION 'document evidence is incomplete' USING ERRCODE = '23514';
    END IF;
    RETURN NULL;
END;
$$;

DO $$
DECLARE table_name text;
BEGIN
    FOREACH table_name IN ARRAY ARRAY['members','parties','assets','documents','document_items',
        'assignments','attachments','app_settings','notification_outbox'] LOOP
        EXECUTE format('CREATE TRIGGER prepare_record BEFORE INSERT OR UPDATE ON gear.%I FOR EACH ROW EXECUTE FUNCTION gear_private.prepare_record()', table_name);
    END LOOP;
    FOREACH table_name IN ARRAY ARRAY['members','parties','assets','assignments','documents','document_items','events','attachments'] LOOP
        EXECUTE format('CREATE CONSTRAINT TRIGGER check_relations AFTER INSERT OR UPDATE OR DELETE ON gear.%I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION gear_private.check_relations()', table_name);
    END LOOP;
END;
$$;
CREATE TRIGGER protect_asset BEFORE UPDATE OR DELETE ON gear.assets FOR EACH ROW EXECUTE FUNCTION gear_private.protect_record();
CREATE TRIGGER protect_party BEFORE UPDATE ON gear.parties FOR EACH ROW EXECUTE FUNCTION gear_private.protect_record();
CREATE TRIGGER protect_document BEFORE UPDATE OR DELETE ON gear.documents FOR EACH ROW EXECUTE FUNCTION gear_private.protect_record();
CREATE TRIGGER protect_items BEFORE INSERT OR UPDATE OR DELETE ON gear.document_items FOR EACH ROW EXECUTE FUNCTION gear_private.protect_record();
CREATE TRIGGER protect_events BEFORE UPDATE OR DELETE ON gear.events FOR EACH ROW EXECUTE FUNCTION gear_private.protect_record();

CREATE FUNCTION gear_private.current_member_id() RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
    SELECT m.id FROM gear.members m JOIN auth.users u ON u.id = m.auth_user_id
    WHERE u.id = (SELECT auth.uid()) AND u.email IS NOT NULL AND u.email_confirmed_at IS NOT NULL
        AND m.status = 'active';
$$;
CREATE FUNCTION gear_private.current_role() RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
    SELECT m.role FROM gear.members m WHERE m.id = (SELECT gear_private.current_member_id());
$$;

-- Owner-only primitive, not an exposed RPC. All kinds share one business-day counter.
CREATE FUNCTION gear_private.next_document_sequence(confirmed_at timestamptz) RETURNS bigint
LANGUAGE sql VOLATILE SET search_path = '' AS $$
    INSERT INTO gear.document_counters (business_on, last_value)
    VALUES ((confirmed_at AT TIME ZONE 'Asia/Shanghai')::date, 1)
    ON CONFLICT (business_on) DO UPDATE
        SET last_value = gear.document_counters.last_value + 1, updated_at = clock_timestamp()
    RETURNING last_value;
$$;

DO $$
DECLARE table_name text;
BEGIN
    FOREACH table_name IN ARRAY ARRAY['members','parties','assets','documents','document_items',
        'assignments','attachments','events','app_settings','document_counters','notification_outbox'] LOOP
        EXECUTE format('ALTER TABLE gear.%I ENABLE ROW LEVEL SECURITY', table_name);
    END LOOP;
END;
$$;
CREATE POLICY members_read ON gear.members FOR SELECT TO authenticated USING (
    auth_user_id = (SELECT auth.uid()) OR (SELECT gear_private.current_role()) = 'admin');
CREATE POLICY parties_read ON gear.parties FOR SELECT TO authenticated USING ((SELECT gear_private.current_role()) IS NOT NULL);
CREATE POLICY assets_read ON gear.assets FOR SELECT TO authenticated USING ((SELECT gear_private.current_role()) IS NOT NULL);
CREATE POLICY assignments_read ON gear.assignments FOR SELECT TO authenticated USING ((SELECT gear_private.current_role()) IS NOT NULL);
CREATE POLICY documents_read ON gear.documents FOR SELECT TO authenticated USING (
    (SELECT gear_private.current_role()) IS NOT NULL AND (status <> 'draft'
        OR (SELECT gear_private.current_role()) = 'admin'
        OR ((SELECT gear_private.current_role()) = 'operator' AND created_by = (SELECT gear_private.current_member_id()))));
CREATE POLICY document_items_read ON gear.document_items FOR SELECT TO authenticated USING (
    EXISTS (SELECT 1 FROM gear.documents d WHERE d.id = document_id));
CREATE POLICY events_read ON gear.events FOR SELECT TO authenticated USING (
    (SELECT gear_private.current_role()) = 'admin'
    OR ((SELECT gear_private.current_role()) IS NOT NULL AND scope IN ('asset','party','document'))
    OR (scope = 'draft' AND (SELECT gear_private.current_role()) = 'operator'
        AND actor_member_id = (SELECT gear_private.current_member_id())));
CREATE POLICY attachments_read ON gear.attachments FOR SELECT TO authenticated USING (
    (SELECT gear_private.current_role()) IS NOT NULL AND (
        (upload_state = 'ready' AND (
            EXISTS (SELECT 1 FROM gear.documents d WHERE d.id = document_id)
            OR EXISTS (SELECT 1 FROM gear.events e WHERE e.id = event_id)))
        OR (uploaded_by = (SELECT gear_private.current_member_id())
            AND (SELECT gear_private.current_role()) IN ('operator','admin'))));
CREATE POLICY settings_read ON gear.app_settings FOR SELECT TO authenticated USING ((SELECT gear_private.current_role()) IS NOT NULL);
CREATE POLICY outbox_read ON gear.notification_outbox FOR SELECT TO authenticated USING ((SELECT gear_private.current_role()) = 'admin');
-- No counter policy and no direct client writes.

CREATE VIEW gear.asset_ledger WITH (security_invoker = true) AS
SELECT a.*, x.id AS assignment_id, x.holder_party_id, x.responsible_person_id,
    x.usage_kind, x.started_on, x.due_on,
    CASE WHEN a.management_status <> 'managed' THEN a.management_status
        WHEN x.id IS NOT NULL THEN 'in_use'
        WHEN a.condition = 'faulty' THEN 'inventory_faulty'
        ELSE 'inventory_available' END AS display_status
FROM gear.assets a LEFT JOIN gear.assignments x ON x.asset_id = a.id AND x.closed_at IS NULL
WHERE a.invalidated_at IS NULL;

REVOKE ALL ON ALL TABLES IN SCHEMA gear FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA gear FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA gear_private FROM PUBLIC, anon, authenticated, service_role;
GRANT USAGE ON SCHEMA gear, gear_private TO authenticated;
GRANT EXECUTE ON FUNCTION gear_private.current_member_id(), gear_private.current_role() TO authenticated;
GRANT SELECT ON gear.members, gear.parties, gear.assets, gear.documents, gear.document_items,
    gear.assignments, gear.attachments, gear.events, gear.asset_ledger, gear.notification_outbox TO authenticated;
GRANT SELECT (id, document_header) ON gear.app_settings TO authenticated;
COMMIT;
