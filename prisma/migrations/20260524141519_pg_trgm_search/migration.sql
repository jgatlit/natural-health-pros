-- pg_trgm typo-tolerance for Practitioner search
-- Phase 1 (decisions-JSON YES row: pgtrgm)

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Trigram GIN index on denormalized searchText for ILIKE / similarity queries
CREATE INDEX IF NOT EXISTS "Practitioner_searchText_trgm_idx"
  ON "Practitioner"
  USING gin ("searchText" gin_trgm_ops);
