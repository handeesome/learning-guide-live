import { z } from "zod";
import type { SummaryStatus } from "../generated/prisma/enums";

export const generateSummaryInput = z.object({}).strict();

export type SummarySnapshot = {
  status: SummaryStatus;
  content: string | null;
  model: string | null;
  error: string | null;
  requestedAt: string | null;
  updatedAt: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  sourceMessageCount: number | null;
};
