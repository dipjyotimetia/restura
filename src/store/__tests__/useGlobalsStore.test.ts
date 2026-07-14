import { beforeEach, describe, expect, it } from 'vitest';
import { useGlobalsStore } from '../useGlobalsStore';

describe('useGlobalsStore', () => {
  beforeEach(() => {
    useGlobalsStore.setState({ vars: {} });
  });

  describe('get / set / unset / clear', () => {
    it('starts empty', () => {
      expect(useGlobalsStore.getState().vars).toEqual({});
    });

    it('set / get round-trips a single key', () => {
      useGlobalsStore.getState().set('region', 'us-east-1');
      expect(useGlobalsStore.getState().get('region')).toBe('us-east-1');
      expect(useGlobalsStore.getState().vars).toEqual({ region: 'us-east-1' });
    });

    it('set overwrites existing key', () => {
      useGlobalsStore.getState().set('region', 'us-east-1');
      useGlobalsStore.getState().set('region', 'eu-west-1');
      expect(useGlobalsStore.getState().get('region')).toBe('eu-west-1');
    });

    it('unset removes a key', () => {
      useGlobalsStore.getState().set('token', 'abc');
      useGlobalsStore.getState().unset('token');
      expect(useGlobalsStore.getState().get('token')).toBeUndefined();
      expect(useGlobalsStore.getState().vars).not.toHaveProperty('token');
    });

    it('unset of a missing key is a no-op and does not change identity', () => {
      const before = useGlobalsStore.getState().vars;
      useGlobalsStore.getState().unset('missing');
      expect(useGlobalsStore.getState().vars).toBe(before);
    });

    it('clear empties the store', () => {
      useGlobalsStore.getState().set('a', '1');
      useGlobalsStore.getState().set('b', '2');
      useGlobalsStore.getState().clear();
      expect(useGlobalsStore.getState().vars).toEqual({});
    });
  });

  describe('applyMutations — the bridge from ScriptResult.globalsMutations', () => {
    it('applies a mix of sets and unsets in one transaction', () => {
      useGlobalsStore.setState({ vars: { keep: 'k', replaceMe: 'old', removeMe: 'x' } });
      useGlobalsStore.getState().applyMutations({
        replaceMe: 'new',
        removeMe: null,
        addedKey: 'added',
      });
      expect(useGlobalsStore.getState().vars).toEqual({
        keep: 'k',
        replaceMe: 'new',
        addedKey: 'added',
      });
    });

    it('treats null as unset for an absent key as a no-op', () => {
      useGlobalsStore.setState({ vars: { keep: 'k' } });
      useGlobalsStore.getState().applyMutations({ never_existed: null });
      expect(useGlobalsStore.getState().vars).toEqual({ keep: 'k' });
    });

    it('returns the same state reference when nothing changed (Zustand reuse)', () => {
      useGlobalsStore.setState({ vars: { keep: 'k' } });
      const before = useGlobalsStore.getState().vars;
      useGlobalsStore.getState().applyMutations({ keep: 'k' });
      expect(useGlobalsStore.getState().vars).toBe(before);
    });
  });
});
