import { z } from "zod";

export const roomInput = z.object({
  title: z
    .string()
    .trim()
    .min(4, "Use at least 4 characters for the title.")
    .max(120, "Keep the title under 120 characters."),
  description: z
    .string()
    .trim()
    .min(10, "Add at least 10 characters about the discussion.")
    .max(1000, "Keep the description under 1,000 characters."),
  topic: z.enum(["PHILOSOPHY", "MATHEMATICAL_BIOLOGY", "GERMAN_HISTORY"], {
    error: "Choose a learning topic.",
  }),
});
