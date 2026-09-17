import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { createLocalAudioTrack, Room, RoomEvent, Track } from 'livekit-client';
import { Headphones, HeadphoneOff, Mic, MicOff, PhoneOff, Volume2 } from 'lucide-react';
import { api, ApiError, snapshotVaultApi, type ApiOptions } from '../api';
import './VoiceRoom.css';

type Peer = { identity: string; name: string; muted: boolean; deafened: boolean; speaking?: boolean; avatarUrl?: string };
type Destination = { id: string; title: string };
type Source = { vaultId: string; vaultName: string; options: ApiOptions };
type Session = { room: Room; endpoint: string; identity?: string; source: Source; cancelPoll?: () => void };
const endpoint = (vault: string, channel: string) => `/api/vaults/${encodeURIComponent(vault)}/channels/${encodeURIComponent(channel)}/voice`;

const sameApi = (a: ApiOptions, b: ApiOptions) => a.origin === b.origin && a.token === b.token;
// Only retain omitted fields for the exact SFU identity within this source room.
export function mergeRoster(prior: Peer[], peers: Peer[]): Peer[] {
  return peers.map(peer => {
    const profile = prior.find(p => p.identity === peer.identity);
    return { ...profile, ...peer, name: peer.name?.trim() || profile?.name?.trim() || 'Participant' };
  });
}
function pollRoster(path: string, options: ApiOptions, receive: (peers: Peer[]) => void, failed: (error: unknown) => void) {
  let disposed = false;
  let timer: ReturnType<typeof setTimeout>;
  const poll = async () => {
    try {
      const result = await api<{ participants: Peer[] }>(`${path}/participants`, options);
      if (!disposed) receive(result.participants);
    } catch (error) { if (!disposed) failed(error); }
    if (!disposed) timer = setTimeout(() => void poll(), 5000);
  };
  void poll();
  return () => { disposed = true; clearTimeout(timer); };
}

/** One session per app. Every async continuation is fenced against leave/switch/unmount. */
export function useVoiceSession(vaultId: string | null, userId?: number, vaultName = vaultId || '', authEpoch = 0) {
  const [channel, setChannel] = useState<Destination | null>(null);
  const [source, setSource] = useState<Source | null>(null);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [participants, setParticipants] = useState<Peer[]>([]);
  const [muted, setMuted] = useState(false);
  const [deafened, setDeafened] = useState(false);
  const [changing, setChanging] = useState(false);
  const active = useRef<Session | null>(null);
  const generation = useRef(0);
  const disconnecting = useRef(Promise.resolve());
  const audio = useRef<HTMLDivElement>(null);
  const preferences = useRef({ muted: false, deafened: false });
  const changingRef = useRef(false);
  const leave = useCallback(() => {
    generation.current++;
    const session = active.current;
    active.current = null;
    let disconnected = disconnecting.current;
    if (session) {
      session.cancelPoll?.();
      session.room.removeAllListeners();
      session.room.localParticipant.trackPublications.forEach(p => p.track?.stop());
      disconnected = Promise.all([disconnected, session.room.disconnect(true)]).then(() => {}, () => {});
      disconnecting.current = disconnected;
      const identity = session.identity || session.room.localParticipant.identity;
      if (identity) void api(`${session.endpoint}/leave`, { ...session.source.options, method: 'POST', body: JSON.stringify({ identity }) }).catch(() => {});
    }
    audio.current?.replaceChildren();
    setChannel(null); setSource(null); setStatus(''); setParticipants([]);
    changingRef.current = false; setChanging(false);
    return disconnected;
  }, []);
  useEffect(() => {
    void leave(); setError(''); setMuted(false); setDeafened(false);
    preferences.current = { muted: false, deafened: false };
    return () => { void leave(); };
  }, [userId, authEpoch, leave]);

  const setMicrophone = useCallback(async (session: Session, enabled: boolean) => {
    const participant = session.room.localParticipant;
    if (!enabled) { await participant.setMicrophoneEnabled(false); return; }
    let track = participant.getTrackPublication(Track.Source.Microphone)?.track;
    if (!track) {
      // Own capture separately from publication: a late permission result must
      // remain reachable even when the room disconnected while the prompt was open.
      track = await createLocalAudioTrack();
      if (active.current !== session) { track.stop(); return; }
      try {
        await participant.publishTrack(track, { source: Track.Source.Microphone, stopMicTrackOnMute: false });
      } catch (error) { track.stop(); throw error; }
    } else {
      try { await track.unmute(); }
      finally { if (active.current !== session) track.stop(); }
    }
    if (active.current !== session) track.stop();
  }, []);

  const join = useCallback(async (destination: Destination) => {
    if (!vaultId || userId === undefined) return;
    const source = { vaultId, vaultName, options: snapshotVaultApi(vaultId) };
    if (active.current?.endpoint === endpoint(vaultId, destination.id) && sameApi(active.current.source.options, source.options)) return;
    const disconnected = leave();
    const revision = generation.current;
    setChannel(destination); setSource(source); setError(''); setStatus('Connecting');
    const room = new Room({ adaptiveStream: true, disconnectOnPageLeave: true });
    const session: Session = { room, source, endpoint: endpoint(vaultId, destination.id), identity: '' };
    active.current = session;
    const current = () => active.current === session && generation.current === revision;
    let profiles: Peer[] = [];
    const update = () => {
      if (!current()) return;
      setParticipants(mergeRoster(profiles, [room.localParticipant, ...room.remoteParticipants.values()].map(p => ({
        identity: p.identity, name: p.name || '', muted: !p.isMicrophoneEnabled,
        speaking: p.isSpeaking, deafened: p.attributes['fizzer.deafened'] === 'true',
      }))));
    };
    room.on(RoomEvent.TrackSubscribed, track => {
      if (!current()) return;
      if (track.kind === Track.Kind.Audio) {
        const element = track.attach(); element.muted = preferences.current.deafened;
        audio.current?.appendChild(element);
      }
      update();
    });
    room.on(RoomEvent.TrackUnsubscribed, track => { track.detach().forEach(e => e.remove()); update(); });
    for (const event of [RoomEvent.ParticipantConnected, RoomEvent.ParticipantDisconnected,
      RoomEvent.TrackMuted, RoomEvent.TrackUnmuted, RoomEvent.LocalTrackPublished,
      RoomEvent.LocalTrackUnpublished, RoomEvent.ActiveSpeakersChanged, RoomEvent.ParticipantAttributesChanged]) room.on(event, update);
    room.on(RoomEvent.Reconnecting, () => { if (current()) setStatus('Reconnecting'); });
    room.on(RoomEvent.SignalReconnecting, () => { if (current()) setStatus('Reconnecting'); });
    room.on(RoomEvent.Reconnected, () => { if (current()) { setStatus('Connected'); update(); } });
    room.on(RoomEvent.Disconnected, () => {
      if (current()) { leave(); setError('Voice disconnected. Check your connection and channel access, then click the room to rejoin.'); }
    });
    room.on(RoomEvent.MediaDevicesError, () => { if (current()) setError('Microphone unavailable. Check your device and browser permission.'); });
    try {
      await disconnected;
      if (!current()) return;
      const token = await api<{ url: string; token: string; identity: string }>(`${session.endpoint}/join`, { ...source.options, method: 'POST', body: '{}' });
      session.identity = token.identity;
      if (!current()) {
        void api(`${session.endpoint}/leave`, { ...source.options, method: 'POST', body: JSON.stringify({ identity: token.identity }) }).catch(() => {});
        return;
      }
      await room.connect(token.url, token.token);
      if (!current()) { await room.disconnect(true); return; }
      await setMicrophone(session, !preferences.current.muted && !preferences.current.deafened);
      if (!current()) { room.localParticipant.trackPublications.forEach(p => p.track?.stop()); await room.disconnect(true); return; }
      if (preferences.current.deafened) {
        await api(`${session.endpoint}/deafen`, { ...session.source.options, method: 'POST', body: JSON.stringify({ identity: session.identity, deafened: true }) });
      }
      if (!current()) return;
      await room.startAudio();
      if (!current()) return;
      setStatus('Connected'); update();
      session.cancelPoll = pollRoster(session.endpoint, source.options, peers => {
        if (!current()) return;
        profiles = mergeRoster(profiles, peers); update();
      }, error => {
        if (!current()) return;
        profiles = []; update();
        if (error instanceof ApiError && [401, 403, 404].includes(error.status)) {
          void leave(); setError('Voice access ended. Sign in and check channel access before rejoining.');
        }
      });
    } catch (e) {
      if (current()) {
        leave();
        setError(e instanceof Error ? `${e.name}: ${e.message}. Click the room to retry.` : 'Unable to join voice. Click the room to retry.');
      }
    }
  }, [vaultId, vaultName, userId, leave, setMicrophone]);

  const change = async (kind: 'muted' | 'deafened') => {
    const session = active.current;
    if (!session || changingRef.current || status !== 'Connected') return;
    const revision = generation.current;
    changingRef.current = true; setChanging(true); setError('');
    const next = { ...preferences.current, [kind]: !preferences.current[kind] };
    try {
      await setMicrophone(session, !next.muted && !next.deafened);
      if (active.current !== session || generation.current !== revision) {
        session.room.localParticipant.trackPublications.forEach(p => p.track?.stop());
        await session.room.disconnect(true);
        return;
      }
      // Apply local privacy state even if publishing the status fails.
      preferences.current = next; setMuted(next.muted); setDeafened(next.deafened);
      audio.current?.querySelectorAll('audio').forEach(e => { e.muted = next.deafened; });
      if (kind === 'deafened') await api(`${session.endpoint}/deafen`, { ...session.source.options, method: 'POST', body: JSON.stringify({ identity: session.identity, deafened: next.deafened }) });
    } catch (e) {
      if (active.current === session) setError(e instanceof Error ? e.message : 'Unable to change voice controls');
    } finally {
      if (generation.current === revision) { changingRef.current = false; setChanging(false); }
    }
  };
  const isCurrent = (channelId: string) => Boolean(source && channel?.id === channelId && source.vaultId === vaultId && sameApi(source.options, snapshotVaultApi(vaultId!)));
  return { vaultId, source, isCurrent, channel, status, error, participants, muted, deafened, changing, audio, join, leave, change, clearError: () => setError('') };
}

export const VoiceContext = createContext<ReturnType<typeof useVoiceSession> | null>(null);
export const useVoice = () => useContext(VoiceContext);

export function VoiceControls() {
  const voice = useVoice();
  if (!voice) return null;
  return <>
    {(voice.channel || voice.error) && <section className="voice-controls" aria-label="Voice controls">
      {voice.channel && <>
        <div className="voice-connection"><Volume2 size={18} aria-hidden="true" /><div><strong>{voice.channel.title}</strong><small>{voice.source?.vaultName}</small><span role="status">{voice.status}</span></div></div>
        <div className="voice-buttons">
          <button type="button" aria-label={voice.muted ? 'Unmute' : 'Mute'} title={voice.muted ? 'Unmute' : 'Mute'} aria-pressed={voice.muted} disabled={voice.changing || voice.status !== 'Connected'} onClick={() => void voice.change('muted')}>{voice.muted ? <MicOff size={18} /> : <Mic size={18} />}</button>
          <button type="button" aria-label={voice.deafened ? 'Undeafen' : 'Deafen'} title={voice.deafened ? 'Undeafen' : 'Deafen'} aria-pressed={voice.deafened} disabled={voice.changing || voice.status !== 'Connected'} onClick={() => void voice.change('deafened')}>{voice.deafened ? <HeadphoneOff size={18} /> : <Headphones size={18} />}</button>
          <button type="button" aria-label="Disconnect voice" title="Disconnect voice" onClick={voice.leave}><PhoneOff size={18} /></button>
        </div>
      </>}
      {voice.error && <div className="voice-error"><p role="alert">{voice.error}</p><button type="button" onClick={voice.clearError}>Dismiss</button></div>}
    </section>}
  </>;
}

export function VoiceParticipants({ channelId }: { channelId: string }) {
  const voice = useVoice();
  const [roster, setRoster] = useState<{ key: string; peers: Peer[] }>({ key: '', peers: [] });
  const [unavailable, setUnavailable] = useState(false);
  const connected = voice?.isCurrent(channelId);
  const vaultId = voice?.vaultId;
  const options = vaultId ? snapshotVaultApi(vaultId) : {};
  const rosterKey = JSON.stringify([vaultId, channelId, options.origin, options.token]);
  useEffect(() => {
    setRoster({ key: rosterKey, peers: [] }); setUnavailable(false);
    if (!vaultId || connected) return;
    return pollRoster(endpoint(vaultId, channelId), options, peers => {
      setRoster(prior => ({ key: rosterKey, peers: mergeRoster(prior.key === rosterKey ? prior.peers : [], peers) })); setUnavailable(false);
    }, () => { setRoster({ key: rosterKey, peers: [] }); setUnavailable(true); });
  }, [vaultId, channelId, connected, rosterKey]);
  const peers = connected && voice ? voice.participants : roster.key === rosterKey ? roster.peers : [];
  if (!peers.length) return unavailable && !connected ? <span className="voice-roster-status">Room status unavailable</span> : null;
  return <ul className="voice-participants" aria-label="Voice participants">{peers.map(p => <li key={p.identity} className={p.speaking && !p.muted ? 'is-speaking' : ''}>
    <span className="voice-avatar" aria-hidden="true">{p.avatarUrl ? <img src={p.avatarUrl} alt="" /> : p.name.slice(0, 1).toUpperCase()}</span>
    <span className="voice-peer-name">{p.name}</span>
    {p.speaking && !p.muted && <span className="sr-only">Speaking</span>}
    {p.muted && <span title="Muted"><MicOff size={13} aria-label="Muted" /></span>}
    {p.deafened && <span title="Deafened"><HeadphoneOff size={13} aria-label="Deafened" /></span>}
  </li>)}</ul>;
}

/** Navigation can reveal a room, but only this button (or its sidebar row) joins. */
export function VoiceChannelView({ channel }: { channel: Destination }) {
  const voice = useVoice();
  return <section className="voice-channel-view" aria-label={channel.title}>
    <Volume2 size={32} aria-hidden="true" />
    <h1>{channel.title}</h1>
    <p>Join the conversation. Your voice stays connected while you browse.</p>
    <button type="button" disabled={voice?.isCurrent(channel.id)} onClick={() => void voice?.join(channel)}>
      {voice?.isCurrent(channel.id) ? 'Voice connected' : 'Join voice'}
    </button>
    <VoiceParticipants channelId={channel.id} />
  </section>;
}
