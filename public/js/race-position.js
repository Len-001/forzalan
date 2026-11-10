// Continuous distance along the route; lateral excursions never count as lost laps.
export function routeProgress(car, track) {
  if (!track?.count || !track?.pts || !track?.tan) return 0;
  const n = track.count;
  // Cache the segment frame per car. Progress remains an O(1) projection and
  // never performs a global closest-point search (including at the crossover).
  const i = ((Math.round(car.trackIdx || 0) % n) + n) % n;
  let segment=car._progressSegment;
  if (!segment || segment.track!==track || segment.i!==i) {
    segment=car._progressSegment || (car._progressSegment={});
    segment.track=track; segment.i=i; segment.point=track.pts[i]; segment.tangent=track.tan[i];
    segment.horizontal=Math.hypot(segment.tangent.x,segment.tangent.z) || 1;
  }
  const p = segment.point, t = segment.tangent, pos = car.pos;
  const h = segment.horizontal;
  const along = pos ? ((pos.x - p.x) * t.x + (pos.z - p.z) * t.z) / h : 0;
  const fraction = Math.max(-0.5, Math.min(0.5, along / track.spacing));
  return (car.lineCross || 0) + (i + fraction) / n;
}
