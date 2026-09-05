// Ambient manifest resolver for the photos screensaver source.
// Extracted from startSlideshow() in main.js so it can be unit-tested in
// isolation (main.js has module-level DOM handlers that block happy-dom import).

/**
 * Resolves the ambient-slideshow manifest for the photos source.
 * photoManifest() holds the last-rendered list; on a cold boot (widget fetch
 * not yet complete) it may be empty — in that case we fetch inline, mirroring
 * how the art branch self-fetches its manifest. Returning [] without locking
 * lets startSlideshow() bail without assigning `slideshow`, so the next
 * applyMode() retry can recover.
 *
 * A nonempty list is trusted only while it is FRESH (photoManifestAt within
 * maxAgeMs). The widget's own refresh keeps the list current while its card is
 * placed, but a manifest sitting since boot — or since a card that is no longer
 * refreshing — can hold expired signed (iCloud/Drive) URLs; a stale list is
 * refetched rather than reused. A failed refetch keeps the last good list rather
 * than blanking the screensaver.
 *
 * @param {object} cfg
 * @param {object} net
 * @param {object} photosModule  the photos widget module (explicit dep for testability)
 * @param {object} [opts]
 * @param {number} [opts.now]       clock, injectable for tests
 * @param {number} [opts.maxAgeMs]  how long a rendered list stays trustworthy
 * @returns {Promise<Array>}
 */
export async function resolvePhotosManifest(cfg, net, photosModule, { now = Date.now(), maxAgeMs = 20 * 60 * 1000 } = {}) {
  const list = photosModule.photoManifest();
  const at = photosModule.photoManifestAt?.() ?? 0;
  if (list.length && now - at < maxAgeMs) return list;
  const fetched = (await photosModule.fetchData(cfg, net)).photos ?? [];
  return fetched.length ? fetched : list;
}
