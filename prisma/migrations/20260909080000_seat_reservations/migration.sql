-- Nullable additions preserve membership history and existing lease timestamps.
ALTER TABLE "room_members" ADD COLUMN "seatOwnerId" TEXT;
ALTER TABLE "room_members" ADD COLUMN "seatReservationId" TEXT;
