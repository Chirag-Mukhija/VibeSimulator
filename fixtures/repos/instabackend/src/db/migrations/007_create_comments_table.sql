CREATE TABLE IF NOT EXISTS comments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    post_id UUID NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body VARCHAR(2200) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- serves "comments on this post, oldest first" — a comment thread reads chronologically
CREATE INDEX IF NOT EXISTS idx_comments_post_created ON comments (post_id, created_at ASC);
