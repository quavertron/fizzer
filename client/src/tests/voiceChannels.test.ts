import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CHAT_NOTE_MARKER, VOICE_NOTE_MARKER, isVoiceChannel } from '../chat/shared';
import { VoiceChannelView, VoiceContext, VoiceControls, VoiceParticipants, useVoiceSession } from '../components/VoiceRoom';

type Voice = ReturnType<typeof useVoiceSession>;
function session(overrides: Partial<Voice> = {}): Voice {
  return {
    vaultId: 'vault', channel: { id: 'room', title: 'Lounge' }, status: 'Connected', error: '',
    participants: [], muted: false, deafened: false, changing: false, audio: { current: null },
    join: vi.fn(), leave: vi.fn(), change: vi.fn(), clearError: vi.fn(), ...overrides,
  };
}
function render(value: Voice, child: ReturnType<typeof createElement>) {
  return renderToStaticMarkup(createElement(VoiceContext.Provider, { value }, child));
}

describe('dedicated voice channels', () => {
  it('keeps existing text and ordinary notes distinct from the persisted voice type', () => {
    expect(isVoiceChannel(CHAT_NOTE_MARKER)).toBe(false);
    expect(isVoiceChannel('Meeting notes')).toBe(false);
    expect(isVoiceChannel(`${VOICE_NOTE_MARKER}-lookalike`)).toBe(false);
    expect(isVoiceChannel(`  ${VOICE_NOTE_MARKER}\nshared_from=source`)).toBe(true);
  });

  it('navigation renders an explicit join button without starting a session', () => {
    const value = session({ channel: null, status: '' });
    const html = render(value, createElement(VoiceChannelView, { channel: { id: 'room', title: 'Lounge' } }));
    expect(html).toContain('Join voice</button>');
    expect(value.join).not.toHaveBeenCalled();
    expect(render(value, createElement(VoiceControls))).not.toContain('Voice controls');
  });

  it('retains an accessible disconnect while connecting and disables media toggles', () => {
    const html = render(session({ status: 'Connecting' }), createElement(VoiceControls));
    expect(html).toMatch(/aria-label="Mute"[^>]+disabled/);
    expect(html).toMatch(/aria-label="Deafen"[^>]+disabled/);
    expect(html).toMatch(/aria-label="Disconnect voice"[^>]*>/);
    expect(html).not.toMatch(/aria-label="Disconnect voice"[^>]+disabled/);
  });

  it('renders duplicate display names with individual speaking, mute and deafen states', () => {
    const html = render(session({ participants: [
      { identity: 'one', name: 'Alex', muted: false, deafened: false, speaking: true },
      { identity: 'two', name: 'Alex', muted: true, deafened: true, speaking: false },
    ] }), createElement(VoiceParticipants, { channelId: 'room' }));
    expect(html.match(/voice-peer-name/g)).toHaveLength(2);
    expect(html).toContain('is-speaking');
    expect(html).toContain('Speaking');
    expect(html).toContain('aria-label="Muted"');
    expect(html).toContain('aria-label="Deafened"');
  });
});
