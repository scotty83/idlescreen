// Google Drive Photos widget — twin of photos.js (iCloud). Shared render/fetch
// lives in photos-core; this file pins the Drive source. meta.title is "Photos"
// (clean on the wall); the descriptive "GDrive Photos" label lives in
// WIDGET_LABELS (settings + setup pickers).

import { createPhotoWidget, mapPhotos as mapPhotosCore } from './photos-core.js';

const widget = createPhotoWidget({
  id: 'gdrivephotos',
  cfgKey: 'gdrivephotos',
  endpoint: '/gdrive/album?folder=',
  emptyAction: 'add a Google Drive folder',
  emptyDest: 'GDrive Photos',
});

export const meta = widget.meta;
export const render = widget.render;
export const fetchData = widget.fetchData;
export const photoManifest = widget.photoManifest;
export const photoManifestAt = widget.photoManifestAt;
export const mapPhotos = mapPhotosCore;
