export function youtubeVideoId(href: string) {
  try {
    const url = new URL(href, 'http://localhost');
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    let id = '';
    if (host === 'youtu.be') id = url.pathname.split('/').filter(Boolean)[0] || '';
    else if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'music.youtube.com') {
      if (url.pathname === '/watch') id = url.searchParams.get('v') || '';
      else id = url.pathname.match(/^\/(?:embed|shorts|live)\/([^/?#]+)/)?.[1] || '';
    }
    return /^[A-Za-z0-9_-]{6,15}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

export const YOUTUBE_EMBED_STATE_EVENT = 'cascade:youtube-embed-state';
export const YOUTUBE_EMBED_CONTROL_EVENT = 'cascade:youtube-embed-control';

export type YouTubeEmbedStateDetail = {
  videoId: string;
  url: string;
  title: string;
  currentTime: number;
  state: number;
};

export type YouTubeEmbedControlDetail = {
  videoId: string;
  func: 'playVideo' | 'pauseVideo';
};

export type ChatMediaLink =
  | { provider: 'youtube'; embedUrl: string; title: string; aspect: 'video' }
  | { provider: 'twitter'; embedUrl: string; title: string; aspect: 'social' }
  | { provider: 'spotify'; embedUrl: string; title: string; aspect: 'spotify' }
  | { provider: 'vimeo'; embedUrl: string; title: string; aspect: 'video' }
  | { provider: 'tiktok'; embedUrl: string; title: string; aspect: 'social' };

/**
 * The X embed reports its rendered size to the containing page with this
 * private widget message. Treat it as untrusted even after its origin/source
 * have been checked by the caller, so an unexpected provider change cannot
 * make a chat message consume an arbitrary amount of vertical space.
 */
export function twitterEmbedResizeHeight(data: unknown): number | null {
  if (!data || typeof data !== 'object') return null;
  const embed = (data as { 'twttr.embed'?: unknown })['twttr.embed'];
  if (!embed || typeof embed !== 'object') return null;
  const rpc = embed as { method?: unknown; params?: unknown };
  if (rpc.method !== 'twttr.private.resize' || !Array.isArray(rpc.params)) return null;
  const details = rpc.params[0];
  if (!details || typeof details !== 'object') return null;
  const height = (details as { height?: unknown }).height;
  if (typeof height !== 'number' || !Number.isFinite(height) || height < 120 || height > 1600) return null;
  return Math.ceil(height);
}

/** Convert an allow-listed public media URL into a sandboxable player URL. */
export function chatMediaLink(href: string): ChatMediaLink | null {
  const youtubeId = youtubeVideoId(href);
  if (youtubeId) {
    return {
      provider: 'youtube',
      embedUrl: `https://www.youtube.com/embed/${youtubeId}?enablejsapi=1&playsinline=1&rel=0`,
      title: 'YouTube video',
      aspect: 'video',
    };
  }

  try {
    const url = new URL(href);
    if (url.protocol !== 'https:') return null;
    const host = url.hostname.toLowerCase().replace(/^www\./, '');

    if (host === 'twitter.com' || host === 'x.com' || host === 'mobile.twitter.com') {
      const id = url.pathname.match(/^\/(?:#!\/)?[^/]+\/status(?:es)?\/(\d+)/)?.[1];
      if (!id) return null;
      return {
        provider: 'twitter',
        embedUrl: `https://platform.twitter.com/embed/Tweet.html?id=${id}&dnt=true&theme=dark&conversation=none`,
        title: 'X post',
        aspect: 'social',
      };
    }

    if (host === 'open.spotify.com') {
      const match = url.pathname.match(/^\/(track|album|playlist|episode|show|artist)\/([A-Za-z0-9]+)\/?$/);
      if (!match) return null;
      return {
        provider: 'spotify',
        embedUrl: `https://open.spotify.com/embed/${match[1]}/${match[2]}?utm_source=generator&theme=0`,
        title: 'Spotify player',
        aspect: 'spotify',
      };
    }

    if (host === 'vimeo.com' || host === 'player.vimeo.com') {
      const id = url.pathname.match(/^\/(?:video\/)?(\d+)/)?.[1];
      if (!id) return null;
      return {
        provider: 'vimeo',
        embedUrl: `https://player.vimeo.com/video/${id}?dnt=1`,
        title: 'Vimeo video',
        aspect: 'video',
      };
    }

    if (host === 'tiktok.com' || host === 'm.tiktok.com') {
      const id = url.pathname.match(/^\/@[^/]+\/video\/(\d+)/)?.[1];
      if (!id) return null;
      return {
        provider: 'tiktok',
        embedUrl: `https://www.tiktok.com/player/v1/${id}?autoplay=0`,
        title: 'TikTok video',
        aspect: 'social',
      };
    }
  } catch {
    return null;
  }
  return null;
}
