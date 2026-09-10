import { z } from "zod";

// These IDs fence commands within an authenticated membership, not bearer auth.
export const seatStatusInput = z.object({ clientId: z.uuid() }).strict();
export const reserveSeatInput = z
  .object({
    clientId: z.uuid(),
    previousReservationId: z.uuid().nullable(),
  })
  .strict();
export const releaseSeatInput = z
  .object({
    clientId: z.uuid(),
    reservationId: z.uuid(),
  })
  .strict();

export type SeatStatus = {
  capacity: number;
  occupied: number;
  available: number;
  active: boolean;
  mediaHeld: boolean;
  serverTime: string;
  reservation: {
    id: string;
    expiresAt: string;
    ownedByThisPage: boolean;
  } | null;
};
