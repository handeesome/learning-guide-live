-- Issued media access remains a held seat until Cloud revocation is confirmed.
ALTER TABLE "room_members" ADD COLUMN "mediaIdentity" TEXT;
ALTER TABLE "room_members" ADD COLUMN "mediaTokenExpiresAt" DATETIME;
ALTER TABLE "room_members" ADD COLUMN "mediaRevoking" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "room_members" ADD COLUMN "mediaAbsentSince" DATETIME;
