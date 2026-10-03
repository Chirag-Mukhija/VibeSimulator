-- fan-out-on-write feed: one row per (recipient, post) pair, written at post-creation time
CREATE TABLE IF NOT EXISTS feed_items (
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    post_id UUID NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, post_id)
);

-- serves "this user's feed, newest first" — the only query the fan-out-on-write path needs
CREATE INDEX IF NOT EXISTS idx_feed_items_user_created ON feed_items (user_id, created_at DESC);
