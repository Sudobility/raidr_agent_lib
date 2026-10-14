import { describe, expect, it } from 'vitest';
import {
  condenseBody,
  condenseChunks,
  dateWindow,
  htmlText,
  itemDate,
} from './condense';

const weekend = dateWindow({
  start: '2026-10-17T00:00:00-07:00',
  end: '2026-10-18T23:59:00-07:00',
})!;

const page = (dates: string[]) => ({
  entries: dates.map((d, i) => ({
    api_id: `evt-${i}`,
    event: { name: `Event ${i}`, start_at: d, cover_url: '', hosts: [] },
  })),
  has_more: true,
  next_cursor: 'abc',
});

describe('itemDate / dateWindow', () => {
  it('finds a start on the item or one level down, never a bare number', () => {
    expect(itemDate({ event: { start_at: '2026-10-17T20:00:00Z' } })).toBe(
      Date.parse('2026-10-17T20:00:00Z')
    );
    expect(
      itemDate({ date: { startDate: 'Sun Oct 18 2026 02:00:00 GMT+0000' } })
    ).toBe(Date.parse('Sun Oct 18 2026 02:00:00 GMT+0000'));
    expect(itemDate({ id: '12345678', count: 20261017 })).toBeNull();
    expect(dateWindow({ start: null })).toBeNull();
  });
});

describe('condenseBody', () => {
  it('puts the cursor first, drops empty values and blanks other dates in place', () => {
    const text = condenseBody(
      page([
        '2026-10-13T01:00:00Z',
        '2026-10-17T20:00:00Z',
        '2026-10-25T01:00:00Z',
      ]),
      10_000,
      weekend
    );
    const [note, json] = text.split('\n');
    expect(note).toContain(
      'entries: 3 items, 2 of 3 dated outside 2026-10-17 – 2026-10-19'
    );
    const body = JSON.parse(json!);
    expect(Object.keys(body)).toEqual(['has_more', 'next_cursor', 'entries']);
    expect(body.entries[0]).toBeNull();
    expect(body.entries[1]).toEqual({
      api_id: 'evt-1',
      event: { name: 'Event 1', start_at: '2026-10-17T20:00:00Z' },
    });
    // Trailing out-of-window items are dropped; earlier positions stay.
    expect(body.entries).toHaveLength(2);
  });

  it('says to page further when every item is before the window', () => {
    const text = condenseBody(
      page(['2026-10-13T01:00:00Z', '2026-10-15T00:00:00Z']),
      10_000,
      weekend
    );
    expect(text.split('\n')[0]).toContain(
      'latest 2026-10-15: page further for later items'
    );
  });

  it('keeps fewer items and shorter strings until it fits, and says so', () => {
    const big = {
      next_cursor: 'keep-me',
      items: Array.from({ length: 200 }, (_, i) => ({
        id: i,
        text: 'x'.repeat(300),
      })),
    };
    const text = condenseBody(big, 3_000);
    expect(text.length).toBeLessThanOrEqual(3_000);
    expect(text).toContain('more items not shown (of 200)');
    expect(text).toContain('"next_cursor":"keep-me"');
  });

  it('passes small bodies through without a window', () => {
    expect(condenseBody({ a: 1, b: 'two' }, 100)).toBe('{"a":1,"b":"two"}');
    expect(condenseBody([1, 2], 100)).toBe('[1,2]');
  });
});

describe('condenseChunks', () => {
  it('splits a long list into excerpts that together show every item, paths intact', () => {
    const body = {
      next_cursor: 'c',
      items: Array.from({ length: 40 }, (_, i) => ({
        id: i,
        title: `Item ${i} ${'x'.repeat(150)}`,
      })),
    };
    const chunks = condenseChunks(body, 3_000);
    expect(chunks.length).toBeGreaterThan(1);
    const seen = new Set<number>();
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(3_000);
      const json = JSON.parse(chunk.split('\n').at(-1)!);
      json.items.forEach((item: { id: number } | null, i: number) => {
        if (item) {
          expect(item.id).toBe(i);
          seen.add(i);
        }
      });
    }
    expect(seen.size).toBe(40);
  });

  it('is one excerpt when the body fits', () => {
    expect(condenseChunks({ items: [{ id: 1 }] }, 1_000)).toEqual([
      '{"items":[{"id":1}]}',
    ]);
  });
});

describe('htmlText', () => {
  it('keeps the text and each link of markup inside a JSON field', () => {
    const html =
      '<div class="venue"><a href="/reviews/next-level-burger-133328"><h3>Next Level Burger</h3></a><p>Vegan &amp; burgers</p></div><script>var x=1</script>';
    expect(htmlText(html)).toBe(
      'Next Level Burger (/reviews/next-level-burger-133328) Vegan & burgers |'
    );
  });

  it('shows a long markup field as text instead of cutting it to 200 characters', () => {
    const venues = Array.from(
      { length: 40 },
      (_, i) => `<li><a href="/v/${i}">Venue ${i}</a></li>`
    ).join('');
    const text = condenseBody(
      { recaptcha: {}, data: `<ul>${venues}</ul>` },
      16_000
    );
    expect(text).toContain('Venue 39 (/v/39)');
  });
});

describe('condenseBody with tuple items', () => {
  it('keeps every field of an item that is an array', () => {
    const body = {
      data: {
        items: [
          [
            17013267,
            2592781,
            145,
            5900,
            '1:1~37.85~-122.27',
            [6, 'berkeley-2009-toyota-camry'],
            [10, '$5,900'],
            '2009 Toyota Camry LE',
          ],
        ],
      },
    };
    const text = condenseBody(body, 10_000);
    expect(text).toContain('2009 Toyota Camry LE');
    expect(text).toContain('$5,900');
  });
});
