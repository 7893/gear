-- Run separately, only after authorization and creation of the private bucket via Storage API.
-- Supply gear_storage_bucket privately with psql -v; never commit actual resource values.
BEGIN;
SET LOCAL lock_timeout = '5s';
-- Restrictive isolation also defeats unrelated permissive policies for this one new bucket.
-- All bytes go through the dedicated authenticated Edge function. Other buckets are unchanged.
CREATE POLICY gear_evidence_client_isolation ON storage.objects AS RESTRICTIVE
    FOR ALL TO anon, authenticated
    USING (bucket_id <> :'gear_storage_bucket')
    WITH CHECK (bucket_id <> :'gear_storage_bucket');
COMMIT;
