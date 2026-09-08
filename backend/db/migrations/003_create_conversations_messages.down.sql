DROP TRIGGER IF EXISTS messages_touch_conversation ON messages;
DROP FUNCTION IF EXISTS aura_touch_conversation_on_message();
DROP TABLE IF EXISTS messages;
DROP TRIGGER IF EXISTS conversations_set_updated_at ON conversations;
DROP TRIGGER IF EXISTS conversations_validate_agent ON conversations;
DROP FUNCTION IF EXISTS aura_validate_conversation_agent();
DROP TABLE IF EXISTS conversations;
