-- kimi-code 0.26.0 removed the legacy kimi-cli model id "kimi-k2-thinking".
-- Sessions still pinning it would now fail session/set_model on every run,
-- so reset them to NULL (= follow Kimi's own default model). No rollback
-- needed: the old value is an invalid model id with no runtime meaning.
UPDATE sessions SET model = NULL WHERE backend = 'kimi' AND model = 'kimi-k2-thinking';
