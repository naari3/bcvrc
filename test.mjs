import { id3Timestamp, buildM3U8, extractTralbum, htmlDecode, normUrl, synchsafe, stripLeadingId3, parseRange } from './worker.js';

const hex = (u8) => Buffer.from(u8).toString('hex');
let ok = true;
const assert = (c, m) => { if(!c){ ok=false; console.log('  FAIL:', m);} else console.log('  ok:', m); };

// 1) ID3 timestamp bytes ----------------------------------
console.log('[ID3 timestamp]');
const id3 = id3Timestamp(123.5); // 123.5s * 90000 = 11,115,000
assert(id3[0]===0x49 && id3[1]===0x44 && id3[2]===0x33, 'starts with "ID3"');
assert(id3[3]===0x04, 'version 2.4');
const owner = 'com.apple.streaming.transportStreamTimestamp';
const ownerInTag = Buffer.from(id3.slice(20, 20+owner.length)).toString('latin1');
assert(ownerInTag===owner, 'owner string present ('+owner.length+' bytes)');
// PRIV id at offset 10
assert(Buffer.from(id3.slice(10,14)).toString('latin1')==='PRIV', 'PRIV frame id');
// timestamp = last 8 bytes, big-endian, low32 should be 11115000
const dv = new DataView(id3.buffer, id3.byteOffset + id3.length - 8, 8);
const lo = dv.getUint32(4), hi = dv.getUint32(0);
assert(hi===0 && lo===11115000, '90kHz ts low32 = 11115000 (got '+lo+')');
// size sanity: synchsafe of small numbers must have no byte >=0x80
const sizeBytes = id3.slice(6,10);
assert([...sizeBytes].every(b=>b<0x80), 'tag size synchsafe (no high bit)');
console.log('  tag len =', id3.length, 'hex head =', hex(id3.slice(0,14)));

// synchsafe edge: 200 -> should spread
assert(hex(synchsafe(200))==='00000148', 'synchsafe(200)=00 00 01 48');

// 2) extractTralbum (single-quote wrapped, raw JSON) ------
console.log('[extractTralbum single-quote]');
const tral = {trackinfo:[
  {title:"A", duration:10.5, file:{"mp3-128":"//t4.bcbits.com/stream/a/mp3-128/1?ts=1"}},
  {title:"B, with comma", duration:200.25, file:{"mp3-128":"https://t4.bcbits.com/stream/b"}},
  {title:"no-stream", duration:30, file:{}},      // dropped (no mp3-128)
  {title:"intro", duration:0, file:{"mp3-128":"x"}} // dropped (no duration)
]};
const htmlSingle = `<script data-tralbum='${JSON.stringify(tral)}' data-x='1'></script>`;
const p1 = extractTralbum(htmlSingle);
assert(p1 && p1.trackinfo.length===4, 'parsed, 4 raw entries');

// 3) extractTralbum (double-quote wrapped, entity-encoded)
console.log('[extractTralbum double-quote + entities]');
const enc = JSON.stringify(tral).replace(/&/g,'&amp;').replace(/"/g,'&quot;');
const htmlDouble = `<div data-tralbum="${enc}"></div>`;
const p2 = extractTralbum(htmlDouble);
assert(p2 && p2.trackinfo[1].title==="B, with comma", 'entity-decoded parse');
assert(p2.trackinfo[0].file["mp3-128"]==="//t4.bcbits.com/stream/a/mp3-128/1?ts=1", 'url survived decode');

// 4) buildM3U8 -------------------------------------------
console.log('[buildM3U8]');
const tracks = p1.trackinfo
  .filter(t=>t && t.duration && t.file && t.file['mp3-128'])
  .map(t=>({title:(t.title||'').replace(/[\r\n,]/g,' '), dur:Number(t.duration), mp3:normUrl(t.file['mp3-128'])}));
const m3u8 = buildM3U8(tracks, 'https://w.example.dev');
console.log(m3u8);
assert(/#EXT-X-TARGETDURATION:201/.test(m3u8), 'TARGETDURATION = ceil(max)=201');
assert(/#EXTINF:10.500,A/.test(m3u8), 'EXTINF track A');
assert(/ts=0.000&u=https%3A%2F%2Ft4/.test(m3u8), 'track A ts=0, https-normalized, encoded');
assert(/ts=10.500&/.test(m3u8), 'track B cumulative ts=10.5');
assert(/with comma/.test(m3u8) && !/B, with comma/.test(m3u8), 'comma stripped from title');
assert(/#EXT-X-ENDLIST/.test(m3u8), 'ENDLIST present');

// 5) misc
assert(normUrl('//x/y')==='https://x/y', 'normUrl protocol-relative');
assert(normUrl('http://x/y')==='https://x/y', 'normUrl http->https');
assert(htmlDecode('a&amp;b=&#39;c&#39;')==="a&b='c'", 'htmlDecode amp + numeric');

// 6) stripLeadingId3 ------------------------------------
console.log('[stripLeadingId3]');
// ID3v2 header (10B) + size=5 body + 3B mpeg-ish payload
const withId3 = new Uint8Array([0x49,0x44,0x33,0x04,0x00,0x00, 0,0,0,5, 1,2,3,4,5, 0xff,0xfb,0x90]);
const stripped = stripLeadingId3(withId3);
assert(stripped.length===3 && stripped[0]===0xff && stripped[1]===0xfb, 'strips 10+5 byte ID3, leaves frame sync');
const noId3 = new Uint8Array([0xff,0xfb,0x90,0x00]);
assert(stripLeadingId3(noId3).length===4, 'no ID3 -> unchanged');
assert(stripLeadingId3(new Uint8Array([0x49,0x44])).length===2, 'too short -> unchanged');

// 7) parseRange ----------------------------------------
console.log('[parseRange]');
const eq = (o,a,b)=>o&&o.start===a&&o.end===b;
assert(eq(parseRange('bytes=0-99',1000),0,99), 'bytes=0-99');
assert(eq(parseRange('bytes=100-',1000),100,999), 'bytes=100- open end -> total-1');
assert(eq(parseRange('bytes=-50',1000),950,999), 'bytes=-50 suffix');
assert(eq(parseRange('bytes=0-100000',1000),0,999), 'end clamped to total-1');
assert(parseRange('bytes=2000-3000',1000)===null, 'start past end -> unsatisfiable null');
assert(parseRange('bytes=abc',1000)===null, 'garbage -> null');
assert(parseRange('bytes=-0',1000)===null, 'zero suffix -> null');

console.log('\n' + (ok ? 'ALL PASS' : 'SOME FAILED'));
process.exit(ok?0:1);
