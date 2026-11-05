import { afterEach, describe, expect, it, vi } from 'vitest';
import { CATALOG, SECRET_CATALOG, entryFor } from '../web/src/catalog';
import { loadAssets } from '../web/src/assets';

describe('活动和岗位目录', () => {
  it('按用户确认的顺序对应经典模式的 11 个等级', () => {
    expect(CATALOG.classic.map((entry) => entry.name)).toEqual([
      '秋季百团迎新', '迎新晚会', '高端讲座', '乐队专场', 'V家例会',
      '东方例会', 'COS咖啡厅', '春季百团迎新', '春季晚会', '社庆', '元火标志',
    ]);
  });

  it('按用户确认的顺序对应无尽模式的 11 个岗位', () => {
    expect(CATALOG.endless.map((entry) => entry.name)).toEqual([
      '动研部', '宣传部', '组织部', '实践部', 'COS部', '技术部',
      '日常副社', '外联副社', '场财副社', '大活副社', '社长',
    ]);
    expect(CATALOG.endless.map((entry) => entry.label)).toEqual([
      '动研', '宣传', '组织', '实践', 'COS', '技术', '日常', '外联', '场财', '大活', '社长',
    ]);
  });

  it('用稳定且唯一的内容 ID 保存收藏，全部内容都有正式介绍', () => {
    const entries = [...CATALOG.classic, ...CATALOG.endless, ...Object.values(SECRET_CATALOG)];
    expect(new Set(entries.map((entry) => entry.id)).size).toBe(entries.length);
    expect(entries.every((entry) => entry.description.trim().length > 0 && !entry.description.includes('待补充'))).toBe(true);
    expect(CATALOG.classic.every((entry) => entry.sprite === `activities/${entry.id}.webp`)).toBe(true);
  });

  it('区分两种模式的隐藏内容和状态', () => {
    expect(SECRET_CATALOG.classic).toMatchObject({
      id: 'night-run', name: '医学部夜奔', status: '停办、复活赛中', sprite: 'secrets/night-run.webp',
    });
    expect(SECRET_CATALOG.endless).toMatchObject({
      id: 'stage', name: '舞台部', status: '已解散', sprite: 'secrets/stage.webp',
    });
  });

  it('按模式和 1 起始等级查找内容', () => {
    expect(entryFor('classic', 1)).toBe(CATALOG.classic[0]);
    expect(entryFor('classic', 11)).toBe(CATALOG.classic[10]);
    expect(entryFor('endless', 5).label).toBe('COS');
  });

  it.each([0, 12, -1, 1.5, Number.NaN])('拒绝没有对应内容的等级 %s', (level) => {
    expect(() => entryFor('classic', level)).toThrow(RangeError);
  });
});

describe('没有正式素材时的资源加载', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('空素材清单不请求不存在的图片，并提供两个模式的完整占位', async () => {
    const requests: string[] = [];
    const text: string[] = [];
    const gradient = { addColorStop() {} };
    const context = new Proxy({}, {
      get(_target, key) {
        if (key === 'createLinearGradient' || key === 'createRadialGradient') return () => gradient;
        if (key === 'measureText') return (value: string) => ({ width: value.length * 50 });
        if (key === 'fillText') return (value: string) => text.push(value);
        return () => {};
      },
      set() { return true; },
    });
    vi.stubGlobal('document', {
      createElement: () => ({ width: 0, height: 0, getContext: () => context }),
    });
    vi.stubGlobal('Image', class {
      onerror: (() => void) | null = null;
      set src(url: string) {
        requests.push(url);
        queueMicrotask(() => this.onerror?.());
      }
    });
    vi.stubGlobal('fetch', async () => ({ ok: true, json: async () => ({ files: [] }) }));
    vi.spyOn(console, 'info').mockImplementation(() => {});

    const progress: number[] = [];
    const assets = await loadAssets((loaded) => progress.push(loaded));
    expect(requests).toEqual([]);
    expect(assets.themes.classic).toHaveLength(11);
    expect(assets.themes.endless).toHaveLength(11);
    expect(assets.levels).toBe(assets.themes.classic);
    expect(Object.values(assets.secrets).every((sprite) => sprite.placeholder)).toBe(true);
    expect(assets.background?.placeholder).toBe(true);
    expect(assets.halo?.placeholder).toBe(true);
    expect(assets.realCount).toBe(0);
    expect(progress.at(-1)).toBe(29);
    expect(text).toContain('动研');
    expect(text).toContain('COS');
  });

  it('读取已登记的 PNG 和 WebP，并将正式球图裁成圆形', async () => {
    const requests: string[] = [];
    let clips = 0;
    const context = new Proxy({}, {
      get(_target, key) {
        if (key === 'createLinearGradient' || key === 'createRadialGradient') return () => ({ addColorStop() {} });
        if (key === 'measureText') return (value: string) => ({ width: value.length * 50 });
        if (key === 'clip') return () => { clips++; };
        return () => {};
      },
      set() { return true; },
    });
    vi.stubGlobal('document', { createElement: () => ({ width: 0, height: 0, getContext: () => context }) });
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      json: async () => ({ files: ['activities/autumn-welcome.webp', 'activities/welcome-gala.png', 'secrets/night-run.png'] }),
    }));
    vi.stubGlobal('Image', class {
      naturalWidth = 400;
      naturalHeight = 600;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(url: string) {
        requests.push(url);
        queueMicrotask(() => this.onload?.());
      }
    });
    const assets = await loadAssets();
    expect(requests).toEqual([
      '/assets/activities/autumn-welcome.webp',
      '/assets/activities/welcome-gala.png',
      '/assets/secrets/night-run.png',
    ]);
    expect(assets.themes.classic.slice(0, 2).every((sprite) => !sprite.placeholder)).toBe(true);
    expect(assets.secrets.classic.placeholder).toBe(false);
    expect(assets.realCount).toBe(3);
    expect(clips).toBe(3);
  });

  it('已登记图片没有响应时在短超时后完成加载', async () => {
    vi.useFakeTimers();
    const context = new Proxy({}, {
      get(_target, key) {
        if (key === 'createLinearGradient' || key === 'createRadialGradient') return () => ({ addColorStop() {} });
        if (key === 'measureText') return (value: string) => ({ width: value.length * 50 });
        return () => {};
      },
      set() { return true; },
    });
    vi.stubGlobal('document', { createElement: () => ({ width: 0, height: 0, getContext: () => context }) });
    vi.stubGlobal('fetch', async () => ({ ok: true, json: async () => ({ files: ['roles/animation.webp'] }) }));
    vi.stubGlobal('Image', class { src = ''; });
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const pending = loadAssets();
    await vi.runAllTimersAsync();
    const assets = await pending;
    expect(assets.themes.endless[0].placeholder).toBe(true);
    expect(assets.missing).toContain('roles/animation.webp');
    expect(assets.realCount).toBe(0);
  });
});
