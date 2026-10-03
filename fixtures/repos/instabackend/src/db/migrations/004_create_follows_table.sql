CREATE TABLE IF NOT EXISTS follows (
    follower_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    followee_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (follower_id, followee_id),
    CONSTRAINT no_self_follow CHECK (follower_id != followee_id)
);

-- the PK already indexes (follower_id, followee_id) for "who do I follow" lookups;
-- this covers the reverse direction, "who follows this user"
CREATE INDEX IF NOT EXISTS idx_follows_followee ON follows (followee_id);
