/**
 * The SDP direction parser behind the spectator voice gate
 * (server/voice/sdpDirection.js): the effective direction of each active
 * audio/video section (media-level a= line, else session-level, else
 * sendrecv), port 0 and data sections ignored, bundle-only kept.
 *
 * The bodies below are shaped like what Chrome, Safari, Firefox and
 * libwebrtc (iOS) produce, with every credential-like value built from
 * obviously fake parts (an all-zero fingerprint, "fake" ufrag / pwd).
 */

const { sections, isListenOnly, summary } = require('../sdpDirection');

const FINGERPRINT = 'a=fingerprint:sha-256 ' + Array(32).fill('00').join(':');
const ICE = ['a=ice-ufrag:' + 'fake', 'a=ice-pwd:' + 'not-a-real-ice-pwd-' + 'x'.repeat(4), 'a=ice-options:trickle'];

function body({ session = [], media = [] }) {
    const head = ['v=0', 'o=- 4611731400430051336 2 IN IP4 127.0.0.1', 's=-', 't=0 0', 'a=group:BUNDLE 0', 'a=msid-semantic: WMS', ...session];
    const ms = media.map(({ kind = 'audio', port = 9, dir, extra = [] }, i) => [
        `m=${kind} ${port} UDP/TLS/RTP/SAVPF 111 63 9 0 8 13 110 126`,
        'c=IN IP4 0.0.0.0',
        'a=rtcp:9 IN IP4 0.0.0.0',
        ...ICE,
        FINGERPRINT,
        'a=setup:actpass',
        `a=mid:${i}`,
        ...(dir ? [`a=${dir}`] : []),
        'a=rtcp-mux',
        'a=rtpmap:111 opus/48000/2',
        ...extra,
    ]).flat();
    return [...head, ...ms, ''].join('\r\n');
}

describe('browser-shaped SDP', () => {
    test('Chrome: a sendrecv offer sends; a recvonly offer (addTransceiver recvonly) does not', () => {
        expect(isListenOnly(body({ media: [{ dir: 'sendrecv' }] }))).toBe(false);
        expect(isListenOnly(body({ media: [{ dir: 'recvonly' }] }))).toBe(true);
        expect(summary(body({ media: [{ dir: 'recvonly' }] }))).toBe('listen');
        expect(summary(body({ media: [{ dir: 'sendrecv' }] }))).toBe('send');
    });

    test('Safari / Firefox: an answer without a track is recvonly; sendonly and inactive', () => {
        expect(isListenOnly(body({ media: [{ dir: 'sendonly' }] }))).toBe(false);
        expect(isListenOnly(body({ media: [{ dir: 'inactive' }] }))).toBe(true);
        // Firefox puts the direction after other attributes; LF line ends
        const ff = body({ media: [{ dir: null, extra: ['a=extmap:1 urn:ietf:params:rtp-hdrext:ssrc-audio-level', 'a=recvonly'] }] }).replace(/\r\n/g, '\n');
        expect(isListenOnly(ff)).toBe(true);
    });

    test('libwebrtc (iOS) answer to a recvonly offer: sendonly, which sends', () => {
        expect(isListenOnly(body({ media: [{ dir: 'sendonly' }] }))).toBe(false);
    });
});

describe('the direction rules', () => {
    test('a session-level direction is the default of every section without its own', () => {
        expect(isListenOnly(body({ session: ['a=recvonly'], media: [{ dir: null }] }))).toBe(true);
        expect(isListenOnly(body({ session: ['a=recvonly'], media: [{ dir: 'sendrecv' }] }))).toBe(false);
        expect(isListenOnly(body({ session: ['a=sendonly'], media: [{ dir: null }] }))).toBe(false);
    });

    test('no direction anywhere is sendrecv', () => {
        expect(sections(body({ media: [{ dir: null }] }))[0].direction).toBe('sendrecv');
        expect(isListenOnly(body({ media: [{ dir: null }] }))).toBe(false);
    });

    test('a port-0 (rejected / stopped) section carries nothing; bundle-only keeps it active', () => {
        expect(isListenOnly(body({ media: [{ dir: 'recvonly' }, { port: 0, dir: 'sendrecv' }] }))).toBe(true);
        expect(isListenOnly(body({ media: [{ dir: 'recvonly' }, { port: 0, dir: 'sendrecv', extra: ['a=bundle-only'] }] }))).toBe(false);
    });

    test('a data section (m=application) is ignored; a video section counts', () => {
        expect(isListenOnly(body({ media: [{ dir: 'recvonly' }, { kind: 'application', dir: null }] }))).toBe(true);
        expect(isListenOnly(body({ media: [{ dir: 'recvonly' }, { kind: 'video', dir: 'sendrecv' }] }))).toBe(false);
    });

    test('every active audio section must be listen-only', () => {
        expect(isListenOnly(body({ media: [{ dir: 'recvonly' }, { dir: 'inactive' }] }))).toBe(true);
        expect(isListenOnly(body({ media: [{ dir: 'recvonly' }, { dir: 'sendonly' }] }))).toBe(false);
    });

    test('anything that is not an SDP string counts as sending (fails closed)', () => {
        for (const bad of [undefined, null, '', 42, {}]) expect(isListenOnly(bad)).toBe(false);
        expect(sections('')).toBeNull();
        // no media section at all: nothing is sent
        expect(isListenOnly('v=0\r\ns=-\r\n')).toBe(true);
    });
});
