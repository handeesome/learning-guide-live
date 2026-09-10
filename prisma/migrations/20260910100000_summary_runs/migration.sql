-- Fence concurrent summary attempts and retain the provider usage needed for
-- a bounded-cost, auditable retry flow. Existing summary rows are preserved.
ALTER TABLE "session_summaries" ADD COLUMN "attemptId" TEXT;
ALTER TABLE "session_summaries" ADD COLUMN "promptTokens" INTEGER;
ALTER TABLE "session_summaries" ADD COLUMN "completionTokens" INTEGER;
ALTER TABLE "session_summaries" ADD COLUMN "sourceMessageCount" INTEGER;
