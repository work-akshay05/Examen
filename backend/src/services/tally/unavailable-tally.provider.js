export function createUnavailableTallyProvider() {
  return {
    source: 'none',
    async lookup() { return { status: 'UNAVAILABLE', source: 'none', record: null }; }
  };
}
