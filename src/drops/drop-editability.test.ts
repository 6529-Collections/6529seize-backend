import { getDropEditableUntil } from './drop-editability';
import { env } from '@/env';

describe('getDropEditableUntil', () => {
  let getIntOrNullSpy: jest.SpyInstance;

  beforeEach(() => {
    getIntOrNullSpy = jest.spyOn(env, 'getIntOrNull');
  });

  afterEach(() => {
    getIntOrNullSpy.mockRestore();
  });

  it('returns null when the edit window is not configured', () => {
    getIntOrNullSpy.mockReturnValue(null);
    expect(
      getDropEditableUntil({ createdAt: 1000, updatedAt: null })
    ).toBeNull();
  });

  it('returns null when the edit window is zero', () => {
    getIntOrNullSpy.mockReturnValue(0);
    expect(
      getDropEditableUntil({ createdAt: 1000, updatedAt: null })
    ).toBeNull();
  });

  it('adds the window to created_at when the drop was never updated', () => {
    getIntOrNullSpy.mockReturnValue(300_000);
    expect(getDropEditableUntil({ createdAt: 1000, updatedAt: null })).toBe(
      301_000
    );
  });

  it('adds the window to updated_at when the drop was edited before', () => {
    getIntOrNullSpy.mockReturnValue(300_000);
    expect(getDropEditableUntil({ createdAt: 1000, updatedAt: 5000 })).toBe(
      305_000
    );
  });
});
