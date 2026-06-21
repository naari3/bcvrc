/**
 * bandcamp-hls-worker
 * --------------------
 * Bandcamp アルバムURL を HLS(.m3u8)に変換して、VRChat(AVProベースのプレイヤー)で
 * アルバムを通し再生できるようにする Cloudflare Worker.
 *
 *   VRChat に渡すURL:
 *     https://<your-worker>/album.m3u8?u=<bandcampのアルバムURL>
 *
 * 各トラック = HLS の1セグメント として並べ、packed-audio HLS の規約に従って
 * 各セグメント先頭に ID3 PRIV タイムスタンプ(com.apple.streaming.transportStreamTimestamp)を
 * 注入する。transcode は一切しない(バイト前置きのみ)ので Worker の CPU 予算に収まる。
 *
 * 注意:
 *  - AVPro ベースのプレイヤー(ProTV / VideoTXL 等)があるワールドで、
 *    "Allow Untrusted URLs" を ON にして使う。音声のみなので画面は黒。
 *  - Bandcamp の ToS 的にはグレー。自分のディグ/身内テスト用途を想定。
 */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0 Safari/537.36';

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: cors({}) });
    }

    try {
      if (url.pathname === '/album.m3u8') return await handleAlbum(url);
      if (url.pathname === '/seg') return await handleSegment(url, request);
      return new Response(USAGE, {
        status: url.pathname === '/' ? 200 : 404,
        headers: cors({ 'Content-Type': 'text/plain; charset=utf-8' }),
      });
    } catch (e) {
      return new Response('error: ' + (e && e.message), {
        status: 500,
        headers: cors({ 'Content-Type': 'text/plain; charset=utf-8' }),
      });
    }
  },
};

const USAGE =
  'bandcamp-hls-worker\n\n' +
  'GET /album.m3u8?u=<bandcamp album url>  -> HLS playlist\n' +
  'GET /seg?u=<mp3 url>&ts=<seconds>       -> mp3 segment (+ID3 ts)\n';

/* ---------- /album.m3u8 ---------- */

async function handleAlbum(url) {
  const album = url.searchParams.get('u');
  if (!album) return bad('missing ?u=<bandcamp album url>');

  let albumUrl;
  try {
    albumUrl = new URL(album);
  } catch {
    return bad('invalid url');
  }
  // bandcamp.com サブドメインのみ許可(オープンプロキシ化を防ぐ)
  if (!/(^|\.)bandcamp\.com$/i.test(albumUrl.hostname)) {
    return bad('only *.bandcamp.com is allowed');
  }

  const res = await fetch(albumUrl.toString(), { headers: { 'User-Agent': UA } });
  if (!res.ok) return upstream('album page fetch failed: ' + res.status);
  const html = await res.text();

  const tralbum = extractTralbum(html);
  if (!tralbum) return upstream('could not parse data-tralbum');

  const tracks = (tralbum.trackinfo || [])
    .filter((t) => t && t.duration && t.file && t.file['mp3-128'])
    .map((t) => ({
      title: (t.title || '').replace(/[\r\n,]/g, ' '),
      dur: Number(t.duration),
      mp3: normUrl(t.file['mp3-128']),
    }));

  if (!tracks.length) return notFound('no streamable tracks (preview-only / paid?)');

  const m3u8 = buildM3U8(tracks, url.origin);
  return new Response(m3u8, {
    headers: cors({
      'Content-Type': 'application/vnd.apple.mpegurl',
      // m3u8 内の bcbits 署名URLは数時間で失効するので短めキャッシュ
      'Cache-Control': 'public, max-age=300',
    }),
  });
}

function buildM3U8(tracks, origin) {
  let target = 0;
  for (const t of tracks) target = Math.max(target, Math.ceil(t.dur));

  const lines = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    '#EXT-X-PLAYLIST-TYPE:VOD',
    '#EXT-X-TARGETDURATION:' + target,
  ];

  let cum = 0;
  for (const t of tracks) {
    lines.push('#EXTINF:' + t.dur.toFixed(3) + ',' + t.title);
    lines.push(
      origin +
        '/seg?ts=' +
        cum.toFixed(3) +
        '&u=' +
        encodeURIComponent(t.mp3),
    );
    cum += t.dur;
  }
  lines.push('#EXT-X-ENDLIST');
  return lines.join('\n') + '\n';
}

/* ---------- /seg ---------- */

async function handleSegment(url, request) {
  const mp3 = url.searchParams.get('u');
  const ts = parseFloat(url.searchParams.get('ts') || '0');
  // skipid3=1 のとき Bandcamp 側が付けている先頭 ID3v2 タグをスキップする(リスク3対策)
  const skipId3 = url.searchParams.get('skipid3') === '1';
  if (!mp3) return bad('missing ?u=');

  const upstreamRes = await fetch(mp3, {
    headers: { 'User-Agent': UA, Referer: 'https://bandcamp.com/' },
  });
  if (!upstreamRes.ok || !upstreamRes.body) {
    return upstream('segment fetch failed: ' + upstreamRes.status);
  }

  const id3 = id3Timestamp(ts);
  const rangeHeader = request && request.headers && request.headers.get('Range');

  // /seg が返す論理リソースは「ID3 タイムスタンプ(73B)+ mp3 本体」。
  // Range が来たら "この論理リソース" をスライスする必要がある(upstream の Range を
  // そのまま透過すると ID3 前置きぶんオフセットがずれ、先頭セグメントの ts が壊れる)。
  // Range あり / skipid3 ありのときは全体をメモリに展開してから処理する。
  if (rangeHeader || skipId3) {
    let body = new Uint8Array(await upstreamRes.arrayBuffer());
    if (skipId3) body = stripLeadingId3(body);
    const full = concat(id3, body);
    return rangeHeader ? rangeResponse(full, rangeHeader) : fullResponse(full);
  }

  // 通常パス: バッファせず ID3 を先頭 enqueue してから body をパススルー。
  const reader = upstreamRes.body.getReader();
  const stream = new ReadableStream({
    async start(controller) {
      controller.enqueue(id3); // 先頭に ID3 タイムスタンプを前置き
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          controller.enqueue(value);
        }
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: cors({
      'Content-Type': 'audio/mpeg',
      'Cache-Control': 'public, max-age=3600',
      'Accept-Ranges': 'bytes',
    }),
  });
}

// 200 OK で論理リソース全体を返す(Content-Length 付き)。
function fullResponse(full) {
  return new Response(full, {
    headers: cors({
      'Content-Type': 'audio/mpeg',
      'Cache-Control': 'public, max-age=3600',
      'Accept-Ranges': 'bytes',
      'Content-Length': String(full.length),
    }),
  });
}

// Range ヘッダに従って論理リソース full をスライスして 206 を返す。
// パースできない / 充足不可なら素直に 200(全体)へフォールバック。
function rangeResponse(full, rangeHeader) {
  const total = full.length;
  const r = parseRange(rangeHeader, total);
  if (!r) return fullResponse(full);
  const { start, end } = r; // end は inclusive
  return new Response(full.subarray(start, end + 1), {
    status: 206,
    headers: cors({
      'Content-Type': 'audio/mpeg',
      'Cache-Control': 'public, max-age=3600',
      'Accept-Ranges': 'bytes',
      'Content-Range': 'bytes ' + start + '-' + end + '/' + total,
      'Content-Length': String(end - start + 1),
    }),
  });
}

// "bytes=start-end" / "bytes=start-" / "bytes=-suffix" をパース。
// 単一レンジのみ対応。inclusive な {start,end} を返す。
function parseRange(header, total) {
  const m = /^bytes=(\d*)-(\d*)$/.exec((header || '').trim());
  if (!m) return null;
  const hasStart = m[1] !== '';
  const hasEnd = m[2] !== '';
  let start;
  let end;
  if (hasStart) {
    start = parseInt(m[1], 10);
    end = hasEnd ? parseInt(m[2], 10) : total - 1;
  } else if (hasEnd) {
    // suffix range: 末尾 N バイト
    const suffix = parseInt(m[2], 10);
    if (suffix === 0) return null;
    start = Math.max(0, total - suffix);
    end = total - 1;
  } else {
    return null;
  }
  if (end > total - 1) end = total - 1;
  if (start > end || start < 0) return null; // 充足不可
  return { start, end };
}

// 先頭の ID3v2 タグ(あれば)を取り除いた Uint8Array を返す。
// ヘッダ = "ID3"(3) + version(2) + flags(1) + synchsafe size(4) = 10 バイト。
function stripLeadingId3(bytes) {
  if (bytes.length < 10) return bytes;
  if (!(bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33)) return bytes;
  const size =
    (bytes[6] << 21) | (bytes[7] << 14) | (bytes[8] << 7) | bytes[9];
  const skip = 10 + size;
  return skip >= bytes.length ? bytes.subarray(0, 0) : bytes.subarray(skip);
}

function concat(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/* ---------- Bandcamp パース ---------- */

function extractTralbum(html) {
  // yt-dlp と同じ: data-tralbum=(quote)({...})(quote) ; 末尾の quote が JSON 終端を固定する
  const m = html.match(/data-tralbum=(["'])(\{[\s\S]+?\})\1/);
  if (!m) return null;
  const raw = m[2];
  // ダブルクオート包みのときは中身が HTML エンティティ化されている
  const candidates = m[1] === '"' ? [htmlDecode(raw), raw] : [raw, htmlDecode(raw)];
  for (const c of candidates) {
    try {
      return JSON.parse(c);
    } catch {
      /* try next */
    }
  }
  return null;
}

function htmlDecode(s) {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&'); // &amp; は最後
}

function normUrl(u) {
  if (u.startsWith('//')) return 'https:' + u;
  return u.replace(/^http:/, 'https:');
}

/* ---------- ID3 PRIV timestamp (packed audio HLS) ---------- */

function id3Timestamp(seconds) {
  const owner = 'com.apple.streaming.transportStreamTimestamp';
  const ownerBytes = new TextEncoder().encode(owner);

  // frame body = owner + 0x00 + 8byte big-endian 90kHz timestamp
  const ts90k = Math.round(seconds * 90000); // <= ~2^32 for hours-long; safe
  const body = new Uint8Array(ownerBytes.length + 1 + 8);
  body.set(ownerBytes, 0);
  body[ownerBytes.length] = 0x00;
  const dv = new DataView(body.buffer, ownerBytes.length + 1, 8);
  dv.setUint32(0, Math.floor(ts90k / 0x100000000)); // high 32
  dv.setUint32(4, ts90k >>> 0); // low 32

  // PRIV frame (ID3v2.4: frame size は synchsafe)
  const frame = new Uint8Array(10 + body.length);
  frame.set([0x50, 0x52, 0x49, 0x56], 0); // "PRIV"
  frame.set(synchsafe(body.length), 4);
  // flags 6..7 = 0
  frame.set(body, 10);

  // ID3v2.4 tag header
  const tag = new Uint8Array(10 + frame.length);
  tag.set([0x49, 0x44, 0x33], 0); // "ID3"
  tag[3] = 0x04; // version 2.4
  tag[4] = 0x00;
  tag[5] = 0x00; // flags
  tag.set(synchsafe(frame.length), 6);
  tag.set(frame, 10);

  return tag;
}

function synchsafe(n) {
  return new Uint8Array([(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f]);
}

/* ---------- helpers ---------- */

function cors(h) {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    ...h,
  };
}
const bad = (m) => new Response(m, { status: 400, headers: cors({}) });
const upstream = (m) => new Response(m, { status: 502, headers: cors({}) });
const notFound = (m) => new Response(m, { status: 404, headers: cors({}) });

// テスト用にエクスポート(Worker 実行には影響なし)
export {
  id3Timestamp,
  buildM3U8,
  extractTralbum,
  htmlDecode,
  normUrl,
  synchsafe,
  stripLeadingId3,
  parseRange,
};
