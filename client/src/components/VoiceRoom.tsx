import { useEffect, useRef, useState } from 'react';
import { Room, RoomEvent, Track } from 'livekit-client';
import { api } from '../api';

/** No media capture until Join. Channel changes/unmount stop every local track. */
export function VoiceRoom({ vaultId, channelId }: { vaultId: string; channelId: string }) {
  const [status, setStatus] = useState('Not connected');
  const [error, setError] = useState('');
  const [joined, setJoined] = useState(false);
  const [busy, setBusy] = useState(false);
  const [muted, setMuted] = useState(false);
  const [deafened, setDeafened] = useState(false);
  const [participants, setParticipants] = useState<string[]>([]);
  const active = useRef<Room | null>(null);
  const generation = useRef(0);
  const audio = useRef<HTMLDivElement>(null);
  const deaf = useRef(false);
  const endpoint = `/api/vaults/${encodeURIComponent(vaultId)}/channels/${encodeURIComponent(channelId)}/voice`;
  const leave = () => {
    generation.current++;
    const room = active.current;
    active.current = null;
    if (room) {
      const identity = room.localParticipant.identity;
      room.localParticipant.trackPublications.forEach(p => p.track?.stop());
      void room.disconnect(true);
      if (identity) void api(`${endpoint}/leave`, { method: 'POST', body: JSON.stringify({ identity }) }).catch(() => {});
    }
    audio.current?.replaceChildren();
    setJoined(false); setBusy(false); setParticipants([]); setStatus('Not connected');
    setMuted(false); setDeafened(false); deaf.current = false;
  };
  useEffect(() => () => { leave(); }, [vaultId, channelId]);

  const join = async () => {
    if (active.current || busy) return;
    const revision = ++generation.current;
    setBusy(true); setError(''); setStatus('Connecting');
    const room = new Room({ adaptiveStream: true, disconnectOnPageLeave: true });
    active.current = room;
    const update = () => setParticipants([room.localParticipant, ...room.remoteParticipants.values()].map(p => `${p.name || p.identity}${p.isMicrophoneEnabled ? '' : ' (muted)'}`));
    room.on(RoomEvent.TrackSubscribed, (track) => {
      if (track.kind === Track.Kind.Audio) {
        const element = track.attach(); element.muted = deaf.current;
        audio.current?.appendChild(element);
      }
      update();
    });
    room.on(RoomEvent.TrackUnsubscribed, track => track.detach().forEach(e => e.remove()));
    for (const event of [RoomEvent.ParticipantConnected, RoomEvent.ParticipantDisconnected, RoomEvent.TrackMuted, RoomEvent.TrackUnmuted]) room.on(event, update);
    room.on(RoomEvent.Reconnecting, () => setStatus('Reconnecting'));
    room.on(RoomEvent.SignalReconnecting, () => setStatus('Reconnecting'));
    room.on(RoomEvent.Reconnected, () => { setStatus('Connected'); update(); });
    room.on(RoomEvent.Disconnected, () => {
      if (active.current === room) {
        leave();
        setError('Voice disconnected. Check your connection and channel access, then join again.');
      }
    });
    try {
      const session = await api<{ url: string; token: string }>(`${endpoint}/join`, { method: 'POST', body: '{}' });
      if (generation.current !== revision) return;
      await room.connect(session.url, session.token);
      if (generation.current !== revision) { await room.disconnect(true); return; }
      // Capture is exclusively behind this explicit user action, never mount/reconnect.
      await room.localParticipant.setMicrophoneEnabled(true);
      if (generation.current !== revision) { await room.disconnect(true); return; }
      await room.startAudio();
      setJoined(true); setStatus('Connected'); update();
    } catch (e) {
      if (generation.current === revision) {
        leave();
        setError(e instanceof Error ? `${e.name}: ${e.message}` : 'Unable to join voice');
      }
    } finally { if (generation.current === revision) setBusy(false); }
  };
  const changeMute = async (next: boolean, nextDeaf = deafened) => {
    try {
      await active.current?.localParticipant.setMicrophoneEnabled(!next && !nextDeaf);
      setMuted(next);
    } catch (e) { setError(e instanceof Error ? e.message : 'Microphone unavailable'); }
  };
  const changeDeaf = async () => {
    const next = !deafened;
    // Disable publication before declaring deafen; retain explicit mute choice.
    try {
      await active.current?.localParticipant.setMicrophoneEnabled(!muted && !next);
      deaf.current = next; setDeafened(next);
      audio.current?.querySelectorAll('audio').forEach(e => { e.muted = next; });
    } catch (e) { setError(e instanceof Error ? e.message : 'Unable to deafen'); }
  };
  return <section aria-label="Voice room" style={{ padding: '8px 12px', borderBottom: '1px solid var(--border)' }}>
    <strong>Voice</strong> <span role="status">{status}</span>{' '}
    {!joined && !busy ? <button onClick={() => void join()}>Join voice</button> : <>
      {joined && <><button aria-pressed={muted} onClick={() => void changeMute(!muted)}>{muted ? 'Unmute' : 'Mute'}</button>{' '}
      <button aria-pressed={deafened} onClick={() => void changeDeaf()}>{deafened ? 'Undeafen' : 'Deafen'}</button>{' '}</>}
      <button onClick={leave}>Leave voice</button>
    </>}
    {participants.length > 0 && <ul aria-label="Voice participants">{participants.map(p => <li key={p}>{p}</li>)}</ul>}
    {error && <p role="alert">{error}</p>}
    <div ref={audio} hidden />
  </section>;
}
