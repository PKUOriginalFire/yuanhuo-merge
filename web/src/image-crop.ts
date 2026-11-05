export interface ImageFraming {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  fit?: string;
}

/** Normalized selections stay valid after lossless positioning and proportional web resizing. */
export function imageCrop(width: number, height: number, framing?: ImageFraming) {
  let left = 0, top = 0, right = width, bottom = height;
  if (framing && [framing.x, framing.y, framing.width, framing.height].every(value => typeof value === 'number' && Number.isFinite(value))
    && framing.width! > 0 && framing.height! > 0) {
    left = Math.max(0, Math.min(width, framing.x! * width));
    top = Math.max(0, Math.min(height, framing.y! * height));
    right = Math.max(left, Math.min(width, (framing.x! + framing.width!) * width));
    bottom = Math.max(top, Math.min(height, (framing.y! + framing.height!) * height));
    if (right === left || bottom === top) { left = top = 0; right = width; bottom = height; }
  }
  const side = Math.min(right - left, bottom - top);
  return { x: left + (right - left - side) / 2, y: top + (bottom - top - side) / 2, width: side, height: side };
}

/** Fit the full diagonal inside the circle, so even the flame's tips survive clipping. */
export function circleContainBox(width: number, height: number, diameter: number) {
  const scale = diameter * 0.96 / Math.hypot(width, height);
  return { x: (diameter - width * scale) / 2, y: (diameter - height * scale) / 2, width: width * scale, height: height * scale };
}
