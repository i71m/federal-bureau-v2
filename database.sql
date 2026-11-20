
-- =========================================
-- FEDERAL BUREAU DATABASE
-- PostgreSQL
-- Safe schema update
-- =========================================

BEGIN;

-- 1. الضباط وحساباتهم
CREATE TABLE IF NOT EXISTS officers (
    id BIGSERIAL PRIMARY KEY,
    username VARCHAR(50) NOT NULL,
    password_hash TEXT NOT NULL,
    full_name VARCHAR(150) NOT NULL,
    rank VARCHAR(80) NOT NULL DEFAULT 'Officer',
    role VARCHAR(30) NOT NULL DEFAULT 'officer',
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS officers_username_unique
ON officers (LOWER(username));


-- 2. المطلوبون
CREATE TABLE IF NOT EXISTS wanted_persons (
    id BIGSERIAL PRIMARY KEY,
    full_name VARCHAR(150) NOT NULL,
    alias VARCHAR(150),
    description TEXT,
    charges TEXT,
    threat_level VARCHAR(30) DEFAULT 'Unknown',
    status VARCHAR(30) DEFAULT 'Wanted',
    created_by BIGINT REFERENCES officers(id),
    created_at TIMESTAMPTZ DEFAULT NOW()
);


-- 3. القضايا
CREATE TABLE IF NOT EXISTS cases (
    id BIGSERIAL PRIMARY KEY,
    case_number VARCHAR(50) UNIQUE NOT NULL,
    title VARCHAR(200) NOT NULL,
    description TEXT,
    status VARCHAR(30) DEFAULT 'Open',
    priority VARCHAR(30) DEFAULT 'Normal',
    assigned_to BIGINT REFERENCES officers(id),
    created_by BIGINT REFERENCES officers(id),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);


-- 4. التقارير
CREATE TABLE IF NOT EXISTS reports (
    id BIGSERIAL PRIMARY KEY,
    title VARCHAR(200) NOT NULL,
    content TEXT NOT NULL,
    report_type VARCHAR(80),
    case_id BIGINT REFERENCES cases(id),
    officer_id BIGINT REFERENCES officers(id),
    created_at TIMESTAMPTZ DEFAULT NOW()
);


-- 5. الأدلة
CREATE TABLE IF NOT EXISTS evidence (
    id BIGSERIAL PRIMARY KEY,
    case_id BIGINT REFERENCES cases(id),
    title VARCHAR(200) NOT NULL,
    description TEXT,
    file_url TEXT,
    uploaded_by BIGINT REFERENCES officers(id),
    created_at TIMESTAMPTZ DEFAULT NOW()
);


-- 6. شبكة العلاقات
CREATE TABLE IF NOT EXISTS relationships (
    id BIGSERIAL PRIMARY KEY,
    person_one VARCHAR(150) NOT NULL,
    person_two VARCHAR(150) NOT NULL,
    relationship_type VARCHAR(100),
    notes TEXT,
    created_by BIGINT REFERENCES officers(id),
    created_at TIMESTAMPTZ DEFAULT NOW()
);


-- 7. سجل العمليات
CREATE TABLE IF NOT EXISTS audit_logs (
    id BIGSERIAL PRIMARY KEY,
    officer_id BIGINT REFERENCES officers(id),
    action VARCHAR(150) NOT NULL,
    details TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


-- 8. سجل تاريخ المطلوبين
CREATE TABLE IF NOT EXISTS wanted_history (
    id BIGSERIAL PRIMARY KEY,
    wanted_id BIGINT NOT NULL
        REFERENCES wanted_persons(id) ON DELETE CASCADE,
    officer_id BIGINT
        REFERENCES officers(id) ON DELETE SET NULL,
    action VARCHAR(30) NOT NULL,
    details TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


-- 9. صور المطلوبين
CREATE TABLE IF NOT EXISTS wanted_images (
    id BIGSERIAL PRIMARY KEY,
    wanted_id BIGINT NOT NULL
        REFERENCES wanted_persons(id) ON DELETE CASCADE,
    image_name VARCHAR(255) NOT NULL,
    mime_type VARCHAR(100) NOT NULL,
    image_data BYTEA NOT NULL,
    file_size BIGINT NOT NULL,
    uploaded_by BIGINT
        REFERENCES officers(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


-- 10. سجل تاريخ القضايا
-- details موحد على JSONB
CREATE TABLE IF NOT EXISTS case_history (
    id BIGSERIAL PRIMARY KEY,
    case_id BIGINT NOT NULL
        REFERENCES cases(id) ON DELETE CASCADE,
    officer_id BIGINT
        REFERENCES officers(id) ON DELETE SET NULL,
    action VARCHAR(50) NOT NULL,
    details JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


-- 11. ملاحظات القضايا
CREATE TABLE IF NOT EXISTS case_notes (
    id BIGSERIAL PRIMARY KEY,
    case_id BIGINT NOT NULL
        REFERENCES cases(id) ON DELETE CASCADE,
    officer_id BIGINT
        REFERENCES officers(id) ON DELETE SET NULL,
    note TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


-- =========================================
-- SAFE MIGRATION
-- تحويل case_history.details من TEXT إلى JSONB
-- مع الاحتفاظ بمحتوى السجلات القديمة
-- =========================================

CREATE OR REPLACE FUNCTION pg_temp.safe_text_to_jsonb(input_text TEXT)
RETURNS JSONB
LANGUAGE plpgsql
IMMUTABLE
AS $$
BEGIN
    IF input_text IS NULL THEN
        RETURN NULL;
    END IF;

    BEGIN
        RETURN input_text::JSONB;
    EXCEPTION WHEN OTHERS THEN
        RETURN TO_JSONB(input_text);
    END;
END;
$$;


DO $$
DECLARE
    column_type TEXT;
BEGIN
    SELECT data_type
    INTO column_type
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'case_history'
      AND column_name = 'details';

    IF column_type = 'text' THEN
        ALTER TABLE public.case_history
        ALTER COLUMN details TYPE JSONB
        USING pg_temp.safe_text_to_jsonb(details);

    ELSIF column_type IS NULL THEN
        RAISE EXCEPTION
            'case_history.details column was not found';
    END IF;
END;
$$;


-- =========================================
-- INDEXES
-- =========================================

CREATE INDEX IF NOT EXISTS cases_status_idx
ON cases(status);

CREATE INDEX IF NOT EXISTS wanted_status_idx
ON wanted_persons(status);

CREATE INDEX IF NOT EXISTS reports_officer_idx
ON reports(officer_id);

CREATE INDEX IF NOT EXISTS audit_created_idx
ON audit_logs(created_at);

CREATE INDEX IF NOT EXISTS wanted_history_wanted_id_idx
ON wanted_history(wanted_id);

CREATE INDEX IF NOT EXISTS wanted_images_wanted_id_idx
ON wanted_images(wanted_id);

CREATE INDEX IF NOT EXISTS case_history_case_id_idx
ON case_history(case_id);

CREATE INDEX IF NOT EXISTS case_notes_case_id_idx
ON case_notes(case_id);


COMMIT;

-- =========================================
-- END OF DATABASE UPDATE
-- =========================================
