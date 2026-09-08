DROP TRIGGER IF EXISTS agents_set_updated_at ON agents;
DROP TRIGGER IF EXISTS users_set_updated_at ON users;
DROP TABLE IF EXISTS agents;
DROP TABLE IF EXISTS users;
DROP FUNCTION IF EXISTS aura_set_updated_at();
