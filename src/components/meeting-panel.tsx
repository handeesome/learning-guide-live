"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import {
  Room,
  RoomEvent,
  ConnectionState,
  Track,
  setLogLevel,
  LogLevel,
} from "livekit-client";
import {
  RoomContext,
  RoomAudioRenderer,
  VideoTrack,
  useTracks,
  useParticipants,
} from "@livekit/components-react";
import type { SeatStatus } from "@/lib/seat-input";
import {
  MeetingSession,
  MeetingRequestError,
  meetingApi,
  ownsMedia,
} from "@/lib/meeting-session";
import { meetingCopy as c, deviceError } from "@/lib/meeting-copy";
import { selectMeetingLayout } from "@/lib/meeting-layout";
import type { CollaborationSnapshot } from "@/lib/collaboration-input";
import { CollaborationPanel } from "./collaboration-panel";

type Phase = keyof typeof c.states;
// SDK errors can carry connection details; display only our bounded messages.
setLogLevel(LogLevel.silent);

function MediaView({ focusedIdentity }: { focusedIdentity: string | null }) {
  const participants = useParticipants();
  const cameraTracks = useTracks([Track.Source.Camera]);
  const screenTracks = useTracks([Track.Source.ScreenShare]).filter(
    (track) => !track.publication.isMuted,
  );
  const layout = selectMeetingLayout({
    screenShareIdentities: screenTracks.map(
      (track) => track.participant.identity,
    ),
    focusedIdentity,
    participantIdentities: participants.map((person) => person.identity),
  });
  const primaryShare =
    layout.mode === "screen-share"
      ? screenTracks.find(
          (track) => track.participant.identity === layout.primaryIdentity,
        )
      : undefined;
  const focusedParticipant =
    layout.mode === "focus"
      ? participants.find(
          (participant) => participant.identity === layout.primaryIdentity,
        )
      : undefined;
  const focusedTrack = focusedParticipant
    ? cameraTracks.find(
        (track) => track.participant.identity === focusedParticipant.identity,
      )
    : undefined;
  const orderedParticipants = [...participants].sort((left, right) => {
    if (left.isLocal !== right.isLocal) return left.isLocal ? -1 : 1;
    return left.identity.localeCompare(right.identity);
  });

  const gallery = (
    <div
      className={
        primaryShare || focusedParticipant
          ? "meeting-filmstrip"
          : "meeting-videos"
      }
      aria-label="Participant videos"
    >
      {orderedParticipants.map((person) => {
        const track = cameraTracks.find(
          (item) => item.participant.identity === person.identity,
        );
        return (
          <figure className="meeting-tile" key={person.identity}>
            {track && !track.publication.isMuted ? (
              <VideoTrack trackRef={track} />
            ) : (
              <div className="meeting-camera-off" aria-label="Camera off">
                <span aria-hidden="true">
                  {(person.name || "Participant").slice(0, 1).toUpperCase()}
                </span>
                Camera off
              </div>
            )}
            <figcaption>
              <strong>{person.name || "Participant"}</strong>
              <span>
                {person.isLocal ? "You" : "Participant"} ·{" "}
                {person.isMicrophoneEnabled ? "Mic on" : "Mic off"}
              </span>
            </figcaption>
          </figure>
        );
      })}
    </div>
  );

  return (
    <>
      <RoomAudioRenderer />
      <div className="meeting-roster-heading">
        <div>
          <p className="eyebrow">Live discussion</p>
          <h3>Participants ({participants.length})</h3>
        </div>
        <span className="meeting-layout-label" aria-live="polite">
          {primaryShare
            ? "Screen share view"
            : focusedParticipant
              ? "Focus view"
              : "Gallery view"}
        </span>
      </div>
      {primaryShare ? (
        <div className="meeting-share-layout">
          <figure className="meeting-share-stage">
            <VideoTrack trackRef={primaryShare} />
            <figcaption>
              <span className="meeting-live-dot" aria-hidden="true" />
              {primaryShare.participant.name || "Participant"}
              {primaryShare.participant.isLocal ? " (you)" : ""} is sharing
            </figcaption>
          </figure>
          {gallery}
        </div>
      ) : focusedParticipant ? (
        <div className="meeting-share-layout">
          <figure className="meeting-focus-stage">
            {focusedTrack && !focusedTrack.publication.isMuted ? (
              <VideoTrack trackRef={focusedTrack} />
            ) : (
              <div className="meeting-camera-off" aria-label="Camera off">
                <span aria-hidden="true">
                  {(focusedParticipant.name || "Participant")
                    .slice(0, 1)
                    .toUpperCase()}
                </span>
                Camera off
              </div>
            )}
            <figcaption>
              {focusedParticipant.name || "Participant"}
              {focusedParticipant.isLocal ? " (you)" : ""} is focused
            </figcaption>
          </figure>
          {gallery}
        </div>
      ) : (
        gallery
      )}
    </>
  );
}

export function MeetingPanel({ roomId }: { roomId: string }) {
  const [clientId, setClientId] = useState("");
  useEffect(() => setClientId(crypto.randomUUID()), []);
  return clientId ? (
    <MeetingDeviceSession
      key={`${roomId}:${clientId}`}
      roomId={roomId}
      clientId={clientId}
    />
  ) : (
    <section className="detail-panel meeting-panel" aria-busy="true">
      <h2>{c.title}</h2>
      <h3>Seat reservation</h3>
      <p>Loading meeting controls…</p>
    </section>
  );
}

function MeetingDeviceSession({
  roomId,
  clientId,
}: {
  roomId: string;
  clientId: string;
}) {
  const [session] = useState(
    () => new MeetingSession(meetingApi(roomId, clientId)),
  );
  const [seat, setSeat] = useState<SeatStatus | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [room, setRoom] = useState<Room | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [signIn, setSignIn] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [working, setWorking] = useState(false);
  const [deviceWorking, setDeviceWorking] = useState(false);
  const [mic, setMic] = useState(false);
  const [camera, setCamera] = useState(false);
  const [screenSharing, setScreenSharing] = useState(false);
  const [sharedByOther, setSharedByOther] = useState<string | null>(null);
  const [collaboration, setCollaboration] =
    useState<CollaborationSnapshot | null>(null);
  const [audioBlocked, setAudioBlocked] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [previewPending, setPreviewPending] = useState(false);
  const preview = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const previewGeneration = useRef(0);
  const mounted = useRef(false);
  const busy = useRef(false);
  const deniedAccess = useRef(false);
  const polling = useRef(false);
  const live = useRef<Room | null>(null);
  const verifiedAt = useRef(Date.now());

  function stopPreview() {
    ++previewGeneration.current;
    stream.current?.getTracks().forEach((track) => track.stop());
    stream.current = null;
    if (preview.current) preview.current.srcObject = null;
    if (mounted.current) {
      setPreviewing(false);
      setPreviewPending(false);
    }
  }
  async function localStop() {
    const current = live.current;
    live.current = null; // Ignore intentional disconnect events.
    if (mounted.current) {
      setRoom(null);
      setMic(false);
      setCamera(false);
      setScreenSharing(false);
      setSharedByOther(null);
    }
    try {
      await current?.disconnect(true);
    } catch {
      /* Best-effort track cleanup below. */
    }
    current?.localParticipant.trackPublications.forEach((pub) =>
      pub.track?.stop(),
    );
  }
  function handleError(reason: unknown, fallback: string) {
    if (!mounted.current) return;
    setError(reason instanceof MeetingRequestError ? reason.message : fallback);
    if (
      reason instanceof MeetingRequestError &&
      [401, 403, 404].includes(reason.status)
    ) {
      setSeat(null);
      setBlocked(true);
      deniedAccess.current = true;
      if (reason.status === 401) setSignIn(true);
    }
  }
  async function refresh() {
    if (busy.current || polling.current || deniedAccess.current) return;
    polling.current = true;
    try {
      // One Cloud reconciliation per refresh, never coupled to the host's 5s UI poll.
      await session.api.sync();
      const next = await session.api.seat();
      if (!mounted.current || busy.current) return;
      setSeat(next);
      verifiedAt.current = Date.now();
      setError(null);
      if (
        live.current &&
        session.reservationId &&
        !ownsMedia(next, session.reservationId)
      ) {
        await localStop();
        await session.stop(false);
        if (mounted.current) {
          setPhase("idle");
          setNotice(c.replaced);
        }
      }
    } catch (reason) {
      if (!mounted.current || busy.current) return;
      handleError(reason, c.refreshFailed);
      const denied =
        reason instanceof MeetingRequestError &&
        [401, 403, 404, 409].includes(reason.status);
      if (
        live.current &&
        (denied || Date.now() - verifiedAt.current > 45_000)
      ) {
        await localStop();
        await session.stop(false);
        if (mounted.current) {
          setPhase("idle");
          setNotice(denied ? c.replaced : c.stale);
        }
      }
    } finally {
      polling.current = false;
    }
  }

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible" || live.current)
        void refresh();
    }, 20_000);
    const hide = () => {
      stopPreview();
      void localStop();
      void session.stop(false).catch(() => {});
      setPhase("idle");
      setNotice(c.stopped);
    };
    window.addEventListener("pagehide", hide);
    return () => {
      mounted.current = false;
      clearInterval(timer);
      window.removeEventListener("pagehide", hide);
      stopPreview();
      void localStop();
      // Cloud absence/revocation, not an unreliable unload request, frees the seat.
      void session.stop(false).catch(() => {});
    };
  }, [session]);

  async function join() {
    if (!seat || busy.current || blocked) return;
    busy.current = true;
    setWorking(true);
    setError(null);
    setNotice("");
    setPhase("joining");
    stopPreview();
    const connection = new Room({
      adaptiveStream: true,
      dynacast: true,
      disconnectOnPageLeave: true,
      reconnectPolicy: {
        nextRetryDelayInMs: (context) =>
          context.elapsedMs < 20_000 ? 2000 : null,
      },
    });
    live.current = connection;
    const update = () => {
      if (!mounted.current || live.current !== connection) return;
      setMic(connection.localParticipant.isMicrophoneEnabled);
      setCamera(connection.localParticipant.isCameraEnabled);
      setScreenSharing(connection.localParticipant.isScreenShareEnabled);
      const remoteSharer = [...connection.remoteParticipants.values()]
        .filter((person) => {
          const publication = person.getTrackPublication(
            Track.Source.ScreenShare,
          );
          return publication && !publication.isMuted;
        })
        .sort((left, right) => left.identity.localeCompare(right.identity))[0];
      setSharedByOther(
        remoteSharer ? remoteSharer.name || "Another participant" : null,
      );
    };
    connection
      .on(RoomEvent.LocalTrackPublished, update)
      .on(RoomEvent.LocalTrackUnpublished, update)
      .on(RoomEvent.TrackMuted, update)
      .on(RoomEvent.TrackUnmuted, update)
      .on(RoomEvent.TrackPublished, update)
      .on(RoomEvent.TrackUnpublished, update)
      .on(RoomEvent.ParticipantConnected, update)
      .on(RoomEvent.ParticipantDisconnected, update)
      .on(RoomEvent.AudioPlaybackStatusChanged, () => {
        if (mounted.current && live.current === connection)
          setAudioBlocked(!connection.canPlaybackAudio);
      })
      .on(RoomEvent.Reconnecting, () => {
        if (mounted.current && live.current === connection)
          setPhase("reconnecting");
      })
      .on(RoomEvent.Reconnected, () => {
        if (mounted.current && live.current === connection) {
          setPhase("connected");
          void refresh();
        }
      })
      .on(RoomEvent.Disconnected, () => {
        if (!mounted.current || live.current !== connection) return;
        void localStop();
        void session.stop(false).catch(() => {});
        setPhase("idle");
        setNotice(c.stopped);
      });
    try {
      const joined = await session.join(
        {
          connect: (grant) =>
            connection.connect(grant.serverUrl, grant.token, {
              autoSubscribe: true,
            }),
          disconnect: () => connection.disconnect(true),
        },
        seat,
      );
      if (
        joined &&
        mounted.current &&
        live.current === connection &&
        connection.state === ConnectionState.Connected
      ) {
        setRoom(connection);
        setPhase("connected");
        verifiedAt.current = Date.now();
        setAudioBlocked(!connection.canPlaybackAudio);
      }
    } catch (reason) {
      await localStop();
      if (mounted.current) {
        setPhase("idle");
        handleError(reason, c.failed);
      }
      // A failed request may already have issued a grant; keep its hold visible.
    } finally {
      busy.current = false;
      if (mounted.current) {
        setWorking(false);
        try {
          setSeat(await session.api.seat());
        } catch {
          /* Preserve original failure. */
        }
        if (live.current) void refresh();
      }
    }
  }

  async function leave() {
    if (busy.current) return;
    busy.current = true;
    setWorking(true);
    setPhase("leaving");
    setError(null);
    stopPreview();
    const ownId =
      session.reservationId ??
      (seat?.reservation?.ownedByThisPage ? seat.reservation.id : null);
    await localStop();
    try {
      await session.stop(false);
      if (ownId) await session.api.release(ownId);
      if (mounted.current) setNotice(c.left);
    } catch (reason) {
      handleError(reason, c.releaseFailed);
    } finally {
      busy.current = false;
      if (mounted.current) {
        setWorking(false);
        setPhase("idle");
        try {
          setSeat(await session.api.seat());
        } catch {
          /* Retry remains visible. */
        }
      }
    }
  }

  async function previewCamera() {
    if (previewing || previewPending) {
      stopPreview();
      return;
    }
    const generation = ++previewGeneration.current;
    setPreviewPending(true);
    setError(null);
    try {
      const next = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: false,
      });
      if (!mounted.current || generation !== previewGeneration.current) {
        next.getTracks().forEach((track) => track.stop());
        return;
      }
      stream.current = next;
      next
        .getVideoTracks()
        .forEach((track) =>
          track.addEventListener("ended", stopPreview, { once: true }),
        );
      if (preview.current) preview.current.srcObject = next;
      setPreviewing(true);
    } catch (reason) {
      if (mounted.current && generation === previewGeneration.current)
        setError(deviceError(reason));
    } finally {
      if (mounted.current && generation === previewGeneration.current)
        setPreviewPending(false);
    }
  }
  async function toggleDevice(kind: "mic" | "camera") {
    const current = live.current;
    if (!current || deviceWorking) return;
    setDeviceWorking(true);
    setError(null);
    try {
      if (kind === "mic")
        await current.localParticipant.setMicrophoneEnabled(
          !current.localParticipant.isMicrophoneEnabled,
        );
      else
        await current.localParticipant.setCameraEnabled(
          !current.localParticipant.isCameraEnabled,
        );
      if (live.current !== current)
        current.localParticipant.trackPublications.forEach((pub) =>
          pub.track?.stop(),
        );
    } catch (reason) {
      if (mounted.current) setError(deviceError(reason));
    } finally {
      if (mounted.current) setDeviceWorking(false);
    }
  }

  async function toggleScreenShare() {
    const current = live.current;
    if (!current || deviceWorking || (!screenSharing && sharedByOther)) return;
    setDeviceWorking(true);
    setError(null);
    try {
      await current.localParticipant.setScreenShareEnabled(!screenSharing);
      if (mounted.current && live.current === current)
        setScreenSharing(current.localParticipant.isScreenShareEnabled);
    } catch {
      if (mounted.current) setError(c.shareFailed);
    } finally {
      if (mounted.current) setDeviceWorking(false);
    }
  }

  const connected = phase === "connected" || phase === "reconnecting";
  return (
    <section
      className="detail-panel meeting-panel"
      aria-labelledby="meeting-title"
    >
      <h2 id="meeting-title">{c.title}</h2>
      <p className="field-hint">{c.privacy}</p>
      <p role="status">{c.states[phase]}</p>
      {!connected && !blocked && (
        <>
          <h3>Seat reservation</h3>
          <p>
            {seat
              ? `${seat.occupied} / ${seat.capacity} seats held`
              : "Checking available seats…"}
          </p>
          {seat?.reservation && !seat.reservation.ownedByThisPage && (
            <p className="field-hint">{c.elsewhere}</p>
          )}
          <video
            className="meeting-preview"
            ref={preview}
            autoPlay
            muted
            playsInline
            hidden={!previewing}
            aria-label="Local camera preview"
          />
          <div className="meeting-controls">
            <button
              className="button button-secondary"
              disabled={working || deviceWorking || blocked}
              onClick={previewCamera}
            >
              {previewPending
                ? "Cancel device request"
                : previewing
                  ? c.stopPreview
                  : c.preview}
            </button>
            <button
              className="button"
              disabled={working || !seat || blocked || deviceWorking}
              onClick={join}
            >
              {working
                ? c.states[phase]
                : seat?.reservation && !seat.reservation.ownedByThisPage
                  ? c.takeover
                  : c.join}
            </button>
            {seat?.mediaHeld && seat.reservation?.ownedByThisPage && (
              <button
                className="button button-secondary"
                disabled={working}
                onClick={leave}
              >
                {c.release}
              </button>
            )}
          </div>
        </>
      )}
      {room && (
        <RoomContext.Provider value={room}>
          <MediaView
            focusedIdentity={
              collaboration?.members.find(
                (member) => member.userId === collaboration.focusedUserId,
              )?.mediaIdentity ?? null
            }
          />
          <CollaborationPanel
            roomId={roomId}
            room={room}
            onSnapshot={setCollaboration}
          />
        </RoomContext.Provider>
      )}
      {connected && (
        <div className="meeting-controls">
          <button
            className="button button-secondary"
            aria-pressed={mic}
            disabled={working || deviceWorking || phase !== "connected"}
            onClick={() => toggleDevice("mic")}
          >
            {mic ? "Mute microphone" : "Enable microphone"}
          </button>
          <button
            className="button button-secondary"
            aria-pressed={camera}
            disabled={working || deviceWorking || phase !== "connected"}
            onClick={() => toggleDevice("camera")}
          >
            {camera ? "Turn camera off" : "Enable camera"}
          </button>
          <button
            className="button button-secondary"
            aria-pressed={screenSharing}
            disabled={
              working ||
              deviceWorking ||
              phase !== "connected" ||
              (!screenSharing && Boolean(sharedByOther))
            }
            onClick={toggleScreenShare}
          >
            {screenSharing ? c.stopSharing : c.shareScreen}
          </button>
          {audioBlocked && (
            <button
              className="button button-secondary"
              onClick={() => {
                void live.current
                  ?.startAudio()
                  .catch(() => setError(c.audioFailed));
              }}
            >
              Enable sound
            </button>
          )}
          <button className="button" disabled={working} onClick={leave}>
            Leave discussion
          </button>
        </div>
      )}
      {connected && sharedByOther && !screenSharing && (
        <p className="field-hint" role="status">
          {sharedByOther}: {c.shareInProgress}
        </p>
      )}
      <button
        className="button button-secondary button-small"
        disabled={working || blocked}
        onClick={() => void refresh()}
      >
        Refresh connection status
      </button>
      {notice && (
        <p role="status" className="field-hint">
          {notice}
        </p>
      )}
      {error && (
        <p role="alert" className="error-message">
          {error}
        </p>
      )}
      {signIn && (
        <Link
          className="button button-secondary"
          href={`/sign-in?next=${encodeURIComponent(`/rooms/${roomId}`)}`}
        >
          Sign in
        </Link>
      )}
    </section>
  );
}
