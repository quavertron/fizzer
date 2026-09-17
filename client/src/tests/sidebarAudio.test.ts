import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { isMp3Link } from '../components/Sidebar';
import { ChatMediaEmbed } from '../components/ChatView';
import { chatMediaLink, twitterEmbedResizeHeight, youtubeVideoId } from '../mediaLinks';

describe('isMp3Link', () => {
  it('recognizes uploaded note assets by their visible filename', () => {
    expect(isMp3Link('field recording.mp3', '/api/notes/n1/assets/a1')).toBe(true);
  });

  it('recognizes chat data URLs and direct MP3 URLs', () => {
    expect(isMp3Link('audio', 'data:audio/mpeg;base64,AAAA')).toBe(true);
    expect(isMp3Link('track', 'https://example.test/music/song.mp3?download=1')).toBe(true);
  });

  it('does not intercept ordinary attachments', () => {
    expect(isMp3Link('notes.pdf', '/files/notes.pdf')).toBe(false);
  });
});

describe('youtubeVideoId', () => {
  it('recognizes share, watch, shorts, live, and embed URLs', () => {
    expect(youtubeVideoId('https://youtu.be/jK-tt-3XJ7c')).toBe('jK-tt-3XJ7c');
    expect(youtubeVideoId('https://www.youtube.com/watch?v=jK-tt-3XJ7c&t=12')).toBe('jK-tt-3XJ7c');
    expect(youtubeVideoId('https://youtube.com/shorts/jK-tt-3XJ7c')).toBe('jK-tt-3XJ7c');
    expect(youtubeVideoId('https://youtube.com/live/jK-tt-3XJ7c')).toBe('jK-tt-3XJ7c');
    expect(youtubeVideoId('https://youtube.com/embed/jK-tt-3XJ7c')).toBe('jK-tt-3XJ7c');
  });

  it('rejects lookalike hosts and malformed IDs', () => {
    expect(youtubeVideoId('https://youtube.example/watch?v=jK-tt-3XJ7c')).toBeNull();
    expect(youtubeVideoId('https://youtube.com/watch?v=no')).toBeNull();
  });
});

describe('chatMediaLink', () => {
  it('recognizes allow-listed social, music, and video providers', () => {
    expect(chatMediaLink('https://x.com/user/status/123456789')?.provider).toBe('twitter');
    expect(chatMediaLink('https://twitter.com/user/status/123456789')?.embedUrl).toContain('dnt=true');
    expect(chatMediaLink('https://twitter.com/user/status/123456789')?.embedUrl).toContain('theme=dark');
    expect(chatMediaLink('https://twitter.com/user/status/123456789')?.embedUrl).toContain('conversation=none');
    expect(chatMediaLink('https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC')?.provider).toBe('spotify');
    expect(chatMediaLink('https://vimeo.com/12345678')?.provider).toBe('vimeo');
    expect(chatMediaLink('https://www.tiktok.com/@creator/video/7401234567890123456')?.provider).toBe('tiktok');
  });

  it('rejects lookalike hosts, non-media paths, and insecure URLs', () => {
    expect(chatMediaLink('https://x.com.example/user/status/123456789')).toBeNull();
    expect(chatMediaLink('https://open.spotify.com/search/test')).toBeNull();
    expect(chatMediaLink('http://vimeo.com/12345678')).toBeNull();
  });
});

describe('twitterEmbedResizeHeight', () => {
  it('accepts the bounded resize message emitted by the X iframe', () => {
    expect(twitterEmbedResizeHeight({
      'twttr.embed': {
        method: 'twttr.private.resize',
        params: [{ width: 550, height: 321, data: { tweet_id: '123456789' } }],
      },
    })).toBe(321);
  });

  it('rejects unrelated or unsafe provider messages', () => {
    expect(twitterEmbedResizeHeight({ 'twttr.embed': { method: 'twttr.private.rendered', params: [{}] } })).toBeNull();
    expect(twitterEmbedResizeHeight({ 'twttr.embed': { method: 'twttr.private.resize', params: [{ height: 99 }] } })).toBeNull();
    expect(twitterEmbedResizeHeight({ 'twttr.embed': { method: 'twttr.private.resize', params: [{ height: 1601 }] } })).toBeNull();
    expect(twitterEmbedResizeHeight({ 'twttr.embed': { method: 'twttr.private.resize', params: [{ height: '321' }] } })).toBeNull();
  });
});

describe('ChatMediaEmbed', () => {
  it.each([
    { provider: 'youtube', href: 'https://youtu.be/jK-tt-3XJ7c', embed: 'youtube.com/embed/jK-tt-3XJ7c' },
    { provider: 'spotify', href: 'https://open.spotify.com/album/4aawyAB9vmqN3uQ7FjRGTy', embed: 'open.spotify.com/embed/album/' },
    { provider: 'twitter', href: 'https://x.com/user/status/123456789', embed: 'platform.twitter.com/embed/Tweet.html' },
  ])('loads $provider embeds without an extra click', ({ provider, href, embed }) => {
    const markup = renderToStaticMarkup(createElement(ChatMediaEmbed, { href, label: 'Media' }));
    expect(markup).toContain(`is-${provider}`);
    expect(markup).not.toContain('Load external embed');
    expect(markup).toContain('<iframe');
    expect(markup).toContain('loading="lazy"');
    expect(markup).toContain(embed);
  });
});
