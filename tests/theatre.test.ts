// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { mountTheatre } from '../web/src/ui/theatre';

it('keeps every decorative SVG isolated with self-contained paint references for embedded browsers', () => {
  document.body.innerHTML = '<div id="app"></div>'; mountTheatre();
  const images = [...document.querySelectorAll<HTMLImageElement>('.theatre img')];
  expect(images).toHaveLength(6); expect(document.querySelector('.theatre svg')).toBeNull();
  for (const image of images) {
    const svg = new DOMParser().parseFromString(decodeURIComponent(image.src.split(',')[1]), 'image/svg+xml');
    expect(svg.querySelector('parsererror')).toBeNull();
    for (const match of new XMLSerializer().serializeToString(svg).matchAll(/url\(#([^)]*)\)/g)) expect(svg.getElementById(match[1])).not.toBeNull();
  }
});
