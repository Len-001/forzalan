// Continuous distance along the route; lateral excursions never count as lost laps.
export function routeProgress(car, track) {
  if (!track?.count || !track?.pts || !track?.tan) return 0;
  const n = track.count, i = ((Math.round(car.trackIdx || 0) % n) + n) % n;
  const p = track.pts[i], t = track.tan[i], pos = car.pos;
  const h = Math.hypot(t.x, t.z) || 1;
  const along = pos ? ((pos.x - p.x) * t.x + (pos.z - p.z) * t.z) / h : 0;
  const fraction = Math.max(-0.5, Math.min(0.5, along / track.spacing));
  return (car.lineCross || 0) + (i + fraction) / n;
}
