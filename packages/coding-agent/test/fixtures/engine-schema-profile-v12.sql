-- Frozen manual producer 0fcb057f: apply after engine-schema-v10.sql.
BEGIN;
ALTER TABLE engine_runtime_bindings ADD COLUMN conversation_identity_digest TEXT;
ALTER TABLE engine_attempts ADD COLUMN profile_route_state TEXT;
INSERT INTO engine_schema_migrations(version,checksum,applied_at) VALUES
 (11,'06f158eff443083af4c672f88c160e33a9485c92e27e10fa77e1048467370514',11),
 (12,'58ecc4286b7abca4b989f862ee125262b589033789a79da7d645e00c1c58b3c3',12);
INSERT INTO engine_metadata(key,value) VALUES ('profile-producer-sentinel','retained user state');
COMMIT;
