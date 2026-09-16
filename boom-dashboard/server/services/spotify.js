/**
 * Spotify Web API — Client Credentials service
 * Requires SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET env vars.
 * Uses client credentials flow (no user login needed — public data only).
 */

const TOKEN_URL = 'https://accounts.spotify.com/api/token';

let cachedToken = null;
let tokenExpiry = 0;

async function getAccessToken() {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;

  const clientId = process.env.SPOTIFY_CLIENT_ID;
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET must be set');
  }

  const resp = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64'),
    },
    body: 'grant_type=client_credentials',
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Spotify token request failed: ${resp.status} ${text}`);
  }

  const data = await resp.json();
  if (!data.access_token) throw new Error('No access_token in Spotify response');

  cachedToken = data.access_token;
  // Expire 60s early to avoid using a token that's about to die
  tokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
  return cachedToken;
}

/**
 * Parse a stored spotify_uri value into { type, id }. Accepts:
 *   - spotify:album:xxx / spotify:track:xxx (case-insensitive)
 *   - https://open.spotify.com/album/xxx  (with or without ?si= query)
 *   - http://... and protocol-less variants
 * Returns null for anything we can't confidently identify.
 */
function parseSpotifyRef(ref) {
  if (!ref) return null;
  const s = String(ref).trim();
  if (!s) return null;
  let m = s.match(/^spotify:(album|track):([A-Za-z0-9]+)/i);
  if (m) return { type: m[1].toLowerCase(), id: m[2] };
  m = s.match(/(?:https?:\/\/)?(?:open\.|play\.)?spotify\.com\/(album|track)\/([A-Za-z0-9]+)/i);
  if (m) return { type: m[1].toLowerCase(), id: m[2] };
  return null;
}

/**
 * Given a Spotify URI or URL, returns the URL of the largest available cover
 * art image, or null if the release definitively has no artwork on Spotify.
 * Throws on transient errors (rate-limit / 5xx / network) so callers can
 * distinguish and retry later instead of poisoning the row as 'not_found'.
 */
async function getArtworkUrl(spotifyUri) {
  const ref = parseSpotifyRef(spotifyUri);
  if (!ref) return null; // format we can't recognize — permanent

  const { type, id } = ref;
  const endpoint = type === 'album'
    ? `https://api.spotify.com/v1/albums/${id}`
    : `https://api.spotify.com/v1/tracks/${id}`;

  const token = await getAccessToken();
  const resp = await fetch(endpoint, {
    headers: { Authorization: `Bearer ${token}` },
  });

  // 404: Spotify doesn't know this id — treat as permanent not-found.
  if (resp.status === 404) return null;
  // Anything else non-2xx is transient (rate limit, 5xx, etc.). Throw so the
  // caller can leave cover_art_url as NULL and retry on the next sync.
  if (!resp.ok) {
    throw new Error(`Spotify API ${resp.status} for ${spotifyUri}`);
  }

  const data = await resp.json();
  const images = type === 'album' ? data.images : data.album?.images;
  if (!images || images.length === 0) return null;

  // Spotify returns images sorted largest → smallest; [0] is the biggest (640px)
  return images[0].url;
}

/**
 * Normalize a string for comparison: lowercase, strip punctuation, collapse
 * whitespace. "Oh Yeah!" and "oh yeah" both become "oh yeah".
 */
function normalize(s) {
  return (s || '')
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Does `candidate` match `wanted` strongly enough to trust the cover?
 * Exact after normalization, or one is a substring of the other AND the
 * shorter side has enough characters to be meaningful.
 */
function strongMatch(candidate, wanted, minLen) {
  const c = normalize(candidate);
  const w = normalize(wanted);
  if (!c || !w) return false;
  if (c === w) return true;
  if (w.length >= minLen && c.includes(w)) return true;
  if (c.length >= minLen && w.includes(c)) return true;
  return false;
}

/**
 * Search Spotify for a release by artist + title and return the cover art URL.
 * Only returns a URL when BOTH artist and title match confidently — otherwise
 * null, so callers (and the UI) fall back to the placeholder rather than
 * displaying an unrelated cover from Spotify's top search result.
 */
async function searchArtworkUrl(artist, title) {
  if (!artist || !title) return null;

  const token = await getAccessToken();
  const q = encodeURIComponent(`${title} ${artist}`);

  const pickAlbum = (items) => items.find(a => {
    const titleOk  = strongMatch(a.name, title, 4);
    const artistOk = a.artists?.some(ar => strongMatch(ar.name, artist, 3));
    return titleOk && artistOk;
  });

  const pickTrack = (items) => items.find(t => {
    const titleOk  = strongMatch(t.name, title, 4);
    const artistOk = t.artists?.some(ar => strongMatch(ar.name, artist, 3));
    return titleOk && artistOk;
  });

  // Album search first — wider limit so we don't miss the real release in a
  // sea of unrelated same-title albums from bigger artists.
  const albumResp = await fetch(
    `https://api.spotify.com/v1/search?q=${q}&type=album&limit=20`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!albumResp.ok) {
    // Transient (rate limit, 5xx) — throw so caller keeps the row NULL and
    // tries again next sync, rather than marking it as permanently not-found.
    throw new Error(`Spotify album search ${albumResp.status}`);
  }
  const albumData = await albumResp.json();
  const albumMatch = pickAlbum(albumData.albums?.items || []);
  if (albumMatch?.images?.[0]?.url) return albumMatch.images[0].url;

  // Fallback: track search (for singles released as tracks, not albums).
  const trackResp = await fetch(
    `https://api.spotify.com/v1/search?q=${q}&type=track&limit=20`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!trackResp.ok) {
    throw new Error(`Spotify track search ${trackResp.status}`);
  }
  const trackData = await trackResp.json();
  const trackMatch = pickTrack(trackData.tracks?.items || []);
  if (trackMatch?.album?.images?.[0]?.url) return trackMatch.album.images[0].url;

  // No confident match across either index — genuinely nothing to find.
  return null;
}

module.exports = { getArtworkUrl, searchArtworkUrl };
