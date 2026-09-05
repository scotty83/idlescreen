// iCloud Photos widget. The shared render/fetch lives in photos-core; this file
// pins the iCloud source. Its twin is gdrivephotos.js. meta.title is "Photos"
// (clean on the wall); the descriptive "iCloud Photos" label lives in
// WIDGET_LABELS (settings + setup pickers).

import { createPhotoWidget, mapPhotos as mapPhotosCore } from './photos-core.js';

const widget = createPhotoWidget({
  id: 'photos',
  cfgKey: 'photos',
  endpoint: '/icloud/album?token=',
  emptyAction: 'add an iCloud shared album',
  emptyDest: 'iCloud Photos',
});

export const meta = widget.meta;
export const render = widget.render;
export const fetchData = widget.fetchData;
export const photoManifest = widget.photoManifest;
export const photoManifestAt = widget.photoManifestAt;
export const mapPhotos = mapPhotosCore;
