import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parse } from "dotenv";

// This is a user-invoked local bootstrap, not a credential provisioning service.
// Exclusive creation preserves every existing .env and never prints the secret.
const destination = resolve(".env");
const template = await readFile(resolve(".env.example"), "utf8");
const contents = template.replace(
  "replace-with-a-random-secret-at-least-32-characters",
  randomBytes(48).toString("base64url"),
);
try {
  await writeFile(destination, contents, { flag: "wx", mode: 0o600 });
  console.log("Created local configuration with a unique session secret.");
} catch (error) {
  if (error.code !== "EEXIST") throw error;
  console.log("Keeping existing local configuration unchanged.");
}

// Prisma's Windows schema engine may fail when the SQLite file does not exist.
// Opening it through SQLite creates only a missing file; it never truncates data.
const configuration = parse(await readFile(destination, "utf8"));
const databaseUrl =
  process.env.DATABASE_URL ?? configuration.DATABASE_URL ?? "file:./dev.db";
if (!databaseUrl.startsWith("file:"))
  throw new Error("Local setup requires a file: SQLite DATABASE_URL.");
const database = new DatabaseSync(resolve(databaseUrl.slice(5)));
database.close();
console.log("Local database file is ready for migrations.");
