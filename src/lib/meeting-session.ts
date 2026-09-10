import type { MediaGrant } from "./media-input";
import type { SeatStatus } from "./seat-input";

export interface MeetingApi {
  seat(): Promise<SeatStatus>;
  sync(): Promise<unknown>;
  reserve(previousReservationId: string | null): Promise<SeatStatus>;
  issue(reservationId: string, takeover: boolean): Promise<MediaGrant>;
  release(reservationId: string): Promise<unknown>;
}
export interface MeetingConnection {
  connect(grant: MediaGrant): Promise<void>;
  disconnect(): Promise<void>;
}
export class MeetingRequestError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
export function ownsMedia(seat: SeatStatus, reservationId: string) {
  return (
    seat.mediaHeld &&
    seat.reservation?.ownedByThisPage === true &&
    seat.reservation.id === reservationId
  );
}

/** The operation counter fences late connect/Token responses after leave or
 * unmount. Only explicit join can claim a seat or request a new Token. */
export class MeetingSession {
  private operation = 0;
  private connection: MeetingConnection | null = null;
  reservationId: string | null = null;
  constructor(readonly api: MeetingApi) {}

  async join(connection: MeetingConnection, observed: SeatStatus) {
    const operation = ++this.operation;
    this.connection = connection;
    const current = () => operation === this.operation;
    await this.api.sync();
    if (!current()) return false;
    let seat = await this.api.seat();
    if (!current()) return false;
    // Never silently take over a different generation than the button showed.
    if (
      seat.reservation?.id !== observed.reservation?.id &&
      seat.reservation &&
      !seat.reservation.ownedByThisPage
    ) {
      throw new MeetingRequestError(
        409,
        "SEAT_CHANGED",
        "Another page changed this seat. Refresh and choose again.",
      );
    }
    if (!seat.mediaHeld) {
      seat = await this.api.reserve(seat.reservation?.id ?? null);
      if (!current()) return false; // Plain reservations expire without a Token.
    }
    const reservation = seat.reservation;
    if (!reservation)
      throw new MeetingRequestError(
        409,
        "SEAT_CHANGED",
        "Refresh seats before connecting.",
      );
    if (reservation.ownedByThisPage) this.reservationId = reservation.id;
    const grant = await this.api.issue(
      reservation.id,
      !reservation.ownedByThisPage,
    );
    if (!current()) {
      // Generation-fenced release cannot remove another page's replacement.
      await this.api.release(grant.reservationId);
      return false;
    }
    this.reservationId = grant.reservationId;
    if (!ownsMedia(await this.api.seat(), grant.reservationId)) {
      throw new MeetingRequestError(
        409,
        "SEAT_CHANGED",
        "Another page took over. This page will not reconnect automatically.",
      );
    }
    if (!current()) return false;
    await connection.connect(grant);
    if (!current()) {
      await connection.disconnect();
      return false;
    }
    return true;
  }

  async stop(release: boolean) {
    ++this.operation;
    const connection = this.connection;
    this.connection = null;
    const reservation = this.reservationId;
    // Stop tracks locally even when the application or Cloud is unreachable.
    try {
      await connection?.disconnect();
    } finally {
      if (release && reservation) await this.api.release(reservation);
      this.reservationId = null;
    }
  }
}

export function meetingApi(roomId: string, clientId: string): MeetingApi {
  const base = `/api/rooms/${encodeURIComponent(roomId)}`;
  async function request<T>(
    path: string,
    method = "GET",
    body?: object,
  ): Promise<T> {
    const response = await fetch(`${base}/${path}`, {
      method,
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
      headers: {
        "Content-Type": "application/json",
        "X-Room-Client": clientId,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const result = await response.json();
    if (!response.ok)
      throw new MeetingRequestError(
        response.status,
        result.code,
        result.error ?? "The request failed. Try again.",
      );
    return result;
  }
  return {
    seat: () => request<SeatStatus>("seat"),
    sync: () => request("media-sync", "POST", {}),
    reserve: (previousReservationId) =>
      request<SeatStatus>("seat", "POST", { clientId, previousReservationId }),
    issue: (reservationId, takeover) =>
      request<MediaGrant>("token", "POST", {
        clientId,
        reservationId,
        takeover,
      }),
    release: (reservationId) =>
      request("token", "DELETE", { clientId, reservationId }),
  };
}
