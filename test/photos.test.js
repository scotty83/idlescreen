import { describe, it, expect } from 'vitest';
import { parseAlbumToken } from '../site/js/util.js';
import { mapPhotos, meta } from '../site/js/widgets/photos.js';

// F09: the photos cache fingerprint keys on the album, not the rotation cadence,
// so a swapped album is a cache miss but a change to `every` (presentation) is not.
describe('photos cache fingerprint inputs', () => {
  it('keys on the album, excluding the rotation cadence', () => {
    expect(meta.cacheInputs({ photos: { album: 'A', every: 30 } })).toEqual({ album: 'A' });
    expect(meta.cacheInputs({ photos: { album: 'A', every: 5 } })).toEqual({ album: 'A' });
    expect(meta.cacheInputs({ photos: { album: 'B', every: 30 } })).toEqual({ album: 'B' });
    expect(meta.cacheInputs({})).toEqual({ album: '' });
  });
});

describe('parseAlbumToken', () => {
  it('extracts the token from a full URL, a #fragment, or a bare token', () => {
    expect(parseAlbumToken('https://www.icloud.com/sharedalbum/#B1m5fk75vLWwX')).toBe('B1m5fk75vLWwX');
    expect(parseAlbumToken('#B1m5fk75vLWwX')).toBe('B1m5fk75vLWwX');
    expect(parseAlbumToken('  B1m5fk75vLWwX  ')).toBe('B1m5fk75vLWwX');
    expect(parseAlbumToken('https://www.icloud.com/sharedalbum/#B1m5fk75vLWwX/')).toBe('B1m5fk75vLWwX'); // trailing slash
  });
  it('preserves case and rejects junk', () => {
    expect(parseAlbumToken('AbCdEf12345')).toBe('AbCdEf12345');
    expect(parseAlbumToken('short')).toBeNull();
    expect(parseAlbumToken('')).toBeNull();
    expect(parseAlbumToken(null)).toBeNull();
  });
});

describe('mapPhotos', () => {
  it('maps the worker digest to a slideshow-shaped list', () => {
    const vm = mapPhotos({ updatedAt: 1, stale: false, photos: [
      { url: 'https://x/1.jpg', w: 2049, h: 1537, ar: 1.333, caption: 'Beach', date: '2026-02-24' },
    ] });
    expect(vm.photos[0]).toMatchObject({ img: 'https://x/1.jpg', ar: 1.333, title: 'Beach' });
    expect(vm.stale).toBe(false);
  });
  it('handles the unconfigured/empty digest', () => {
    expect(mapPhotos({ photos: [] }).photos).toEqual([]);
    expect(mapPhotos(null).photos).toEqual([]);
  });
});

describe('fetchData source routing (two widgets)', () => {
  const okNet = () => {
    const calls = [];
    return { calls, net: { fetchJSON: (u) => { calls.push(u); return Promise.resolve({ photos: [{ url: 'x', ar: 1, caption: '', date: '' }] }); } } };
  };
  it('the iCloud widget reads cfg.photos.album → /icloud/album', async () => {
    const { fetchData } = await import('../site/js/widgets/photos.js');
    const { calls, net } = okNet();
    const vm = await fetchData({ photos: { album: 'B1m5fk75vLWwX' } }, net);
    expect(calls[0]).toContain('/icloud/album?token=B1m5fk75vLWwX');
    expect(vm.photos).toHaveLength(1);
  });
  it('the GDrive widget reads cfg.gdrivephotos.album → /gdrive/album', async () => {
    const { fetchData } = await import('../site/js/widgets/gdrivephotos.js');
    const { calls, net } = okNet();
    const vm = await fetchData({ gdrivephotos: { album: '1RHow60mcBwzMturimQSbziK3hqCvP2lz' } }, net);
    expect(calls[0]).toContain('/gdrive/album?folder=1RHow60mcBwzMturimQSbziK3hqCvP2lz');
    expect(vm.photos).toHaveLength(1);
  });
  it('each returns empty without fetching when its block is unconfigured', async () => {
    const noFetch = { fetchJSON: () => { throw new Error('no fetch'); } };
    const ic = await import('../site/js/widgets/photos.js');
    const gd = await import('../site/js/widgets/gdrivephotos.js');
    expect((await ic.fetchData({ photos: { album: '' } }, noFetch)).photos).toEqual([]);
    expect((await gd.fetchData({ gdrivephotos: { album: '' } }, noFetch)).photos).toEqual([]);
  });
});
