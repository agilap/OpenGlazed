CREATE TABLE IF NOT EXISTS request_traces (
  id uuid PRIMARY KEY,
  business_id bigint NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  session_id text NOT NULL,
  surface text NOT NULL,
  query text NOT NULL,
  source text,
  model text,
  duration_ms integer NOT NULL,
  token_usage jsonb NOT NULL DEFAULT '[]',
  stages jsonb NOT NULL DEFAULT '[]',
  retrievals jsonb NOT NULL DEFAULT '[]',
  final_context jsonb NOT NULL DEFAULT '[]',
  errors jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_request_traces_business_created
  ON request_traces(business_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_request_traces_created ON request_traces(created_at);
