import "dotenv/config";
import { hashPassword } from "better-auth/crypto";
import { pathToFileURL } from "node:url";
import { db } from "../src/lib/db";

// Public, synthetic demo credentials only. Never run against production user data.
export const demoPassword = "LearnTogether!2026";
export const demoUsers = [
  { id: "demo-alex", name: "Alex Chen", email: "alex@guide.test" },
  { id: "demo-morgan", name: "Morgan Lee", email: "morgan@guide.test" },
  { id: "demo-taylor", name: "Taylor Park", email: "taylor@guide.test" },
];

export async function seedDemo() {
  if (process.env.NODE_ENV === "production") {
    throw new Error("Demo seed is for local development only.");
  }
  for (const entry of demoUsers) {
    const user = await db.user.upsert({
      where: { id: entry.id },
      update: {},
      create: entry,
    });
    const accountId = `credential-${entry.id}`;
    if (!(await db.account.findUnique({ where: { id: accountId } }))) {
      await db.account.create({
        data: {
          id: accountId,
          accountId: user.id,
          userId: user.id,
          providerId: "credential",
          password: await hashPassword(demoPassword),
        },
      });
    }
  }

  const roomSeeds = [
    {
      id: "demo-philosophy",
      topic: "PHILOSOPHY" as const,
      title: "What makes a good life?",
      description:
        "Read Epicurus through the lens of everyday choices. Where do pleasure, friendship, and peace of mind meet?",
      hostId: "demo-alex",
    },
    {
      id: "demo-biology",
      topic: "MATHEMATICAL_BIOLOGY" as const,
      title: "When does a population stop growing?",
      description:
        "Use a simple logistic model to explore carrying capacity, growth rates, and the limits of our assumptions.",
      hostId: "demo-morgan",
    },
    {
      id: "demo-history",
      topic: "GERMAN_HISTORY" as const,
      title: "Germany in 1848: a different turning point",
      description:
        "Consider the choices facing the Frankfurt Parliament. Which decisions might have changed the outcome?",
      hostId: "demo-taylor",
    },
    {
      id: "demo-past-philosophy",
      topic: "PHILOSOPHY" as const,
      title: "Pleasure, desire, and enough",
      description:
        "A small-group reading of Epicurus on natural desires and the meaning of a sufficient life.",
      hostId: "demo-alex",
    },
  ];
  for (const [index, room] of roomSeeds.entries()) {
    const ended = room.id === "demo-past-philosophy";
    await db.room.upsert({
      where: { id: room.id },
      update: {},
      create: {
        ...room,
        status: ended ? "ENDED" : "OPEN",
        createdAt: new Date(Date.UTC(2026, 8, 7, 6 - index)),
        endedAt: ended ? new Date("2026-09-07T04:00:00Z") : null,
        members: {
          create: { userId: room.hostId, role: "HOST", status: "LEFT" },
        },
      },
    });
  }
  for (const [userId, role] of [
    ["demo-morgan", "MODERATOR"],
    ["demo-taylor", "PARTICIPANT"],
  ] as const) {
    await db.roomMember.upsert({
      where: { roomId_userId: { roomId: "demo-past-philosophy", userId } },
      update: {},
      create: { roomId: "demo-past-philosophy", userId, role, status: "LEFT" },
    });
  }
  const messages = [
    {
      id: "demo-message-1",
      userId: "demo-alex",
      body: "Which desires does Epicurus consider necessary, and why does that distinction matter?",
    },
    {
      id: "demo-message-2",
      userId: "demo-morgan",
      body: "He separates basic needs from desires that keep expanding. The second kind makes it difficult to say we have enough.",
    },
    {
      id: "demo-message-3",
      userId: "demo-taylor",
      body: "Friendship seems different from status: it can make us more secure without an endless competition for more.",
    },
    {
      id: "demo-message-4",
      userId: "demo-alex",
      body: "For next time, let's each bring an example of a desire that looks necessary but might be learned.",
    },
  ];
  for (const [index, message] of messages.entries()) {
    await db.chatMessage.upsert({
      where: { id: message.id },
      update: {},
      create: {
        ...message,
        roomId: "demo-past-philosophy",
        createdAt: new Date(Date.UTC(2026, 8, 7, 3, 10 + index * 3)),
      },
    });
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  seedDemo()
    .then(() =>
      console.log(
        "Demo accounts, four rooms and message history are ready. Existing data was preserved.",
      ),
    )
    .catch(() => {
      console.error(
        "Demo seed failed. Check the database configuration and migrations; no existing data was reset.",
      );
      process.exitCode = 1;
    })
    .finally(() => db.$disconnect());
}
