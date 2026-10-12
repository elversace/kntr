-- Run after migrations 001 and 002 with psql -v ON_ERROR_STOP=1.
-- Preserve duplicate/orphan and unsafe legacy URL metadata before normalization.
-- This migration never deletes physical files.
BEGIN;
LOCK TABLE driver_documents IN ACCESS EXCLUSIVE MODE;
ALTER TABLE driver_documents ADD COLUMN IF NOT EXISTS storage_filename VARCHAR(255);

CREATE TABLE IF NOT EXISTS driver_document_archive (
  original_id UUID PRIMARY KEY,
  document_data JSONB NOT NULL,
  archived_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
LOCK TABLE driver_document_archive IN SHARE ROW EXCLUSIVE MODE;

CREATE TEMP TABLE _kntr_document_archive_targets ON COMMIT DROP AS
SELECT d.id AS original_id, to_jsonb(d) AS document_data,
       (d.driver_id IS NULL
        OR NOT EXISTS (SELECT 1 FROM drivers WHERE user_id = d.driver_id)
        OR d.id IN (
          SELECT id FROM (
            SELECT id, ROW_NUMBER() OVER (
              PARTITION BY driver_id, document_type
              ORDER BY COALESCE(updated_at, created_at) DESC NULLS LAST,
                       created_at DESC NULLS LAST, id DESC
            ) AS position
            FROM driver_documents
          ) ranked WHERE position > 1
        )) AS remove_active
FROM driver_documents d
WHERE d.driver_id IS NULL
   OR NOT EXISTS (SELECT 1 FROM drivers WHERE user_id = d.driver_id)
   OR d.id IN (
     SELECT id FROM (
       SELECT id, ROW_NUMBER() OVER (
         PARTITION BY driver_id, document_type
         ORDER BY COALESCE(updated_at, created_at) DESC NULLS LAST,
                  created_at DESC NULLS LAST, id DESC
       ) AS position
       FROM driver_documents
     ) ranked WHERE position > 1
   )
   OR (
     NOT COALESCE(d.storage_filename ~* '^[A-Za-z0-9][A-Za-z0-9_-]{0,199}\.(jpg|jpeg|png|pdf)$', FALSE)
     AND NOT COALESCE(
       d.document_url LIKE '/uploads/%'
       AND substring(d.document_url FROM 10) ~* '^[A-Za-z0-9][A-Za-z0-9_-]{0,199}\.(jpg|jpeg|png|pdf)$',
       FALSE
     )
     AND d.document_url IS DISTINCT FROM ('/v1/drivers/documents/' || d.id::text || '/file')
   );

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM _kntr_document_archive_targets target
    JOIN driver_document_archive archived ON archived.original_id = target.original_id
    WHERE archived.document_data IS DISTINCT FROM target.document_data
  ) THEN
    RAISE EXCEPTION 'Document integrity migration blocked: an archive ID contains different historical metadata. No document history was overwritten.'
      USING HINT = 'Reconcile the conflicting archive and active document versions while preserving both histories, then rerun this migration.';
  END IF;
END $$;

INSERT INTO driver_document_archive (original_id, document_data)
SELECT original_id, document_data FROM _kntr_document_archive_targets
ON CONFLICT (original_id) DO NOTHING;

DELETE FROM driver_documents d
USING _kntr_document_archive_targets archived
WHERE d.id = archived.original_id AND archived.remove_active;

-- Unsafe unique rows remain active, but their original URL/metadata is archived
-- before replacing the URL. Already normalized rows are excluded on reruns.

-- Only a safe basename is mapped to local storage. Malformed legacy URLs get
-- no storage filename and the authenticated download endpoint returns 404.
UPDATE driver_documents
SET storage_filename = CASE
      WHEN storage_filename ~* '^[A-Za-z0-9][A-Za-z0-9_-]{0,199}\.(jpg|jpeg|png|pdf)$'
        THEN storage_filename
      WHEN document_url LIKE '/uploads/%'
       AND substring(document_url FROM 10) ~* '^[A-Za-z0-9][A-Za-z0-9_-]{0,199}\.(jpg|jpeg|png|pdf)$'
        THEN substring(document_url FROM 10)
      ELSE NULL
    END,
    document_url = '/v1/drivers/documents/' || id::text || '/file';

ALTER TABLE driver_documents ALTER COLUMN driver_id SET NOT NULL;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'driver_documents'::regclass
      AND conname = 'driver_documents_driver_type_unique'
  ) THEN
    ALTER TABLE driver_documents ADD CONSTRAINT driver_documents_driver_type_unique
      UNIQUE (driver_id, document_type);
  END IF;
END $$;
COMMIT;
