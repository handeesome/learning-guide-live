import "dotenv/config";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "../generated/prisma/client";

const globalDatabase = globalThis as unknown as { discussionDb?: PrismaClient };

export const db =
  globalDatabase.discussionDb ??
  new PrismaClient({
    adapter: new PrismaBetterSqlite3({
      url: process.env.DATABASE_URL ?? "file:./dev.db",
    }),
  });

if (process.env.NODE_ENV !== "production") globalDatabase.discussionDb = db;
