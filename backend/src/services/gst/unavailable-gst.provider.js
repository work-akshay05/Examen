export function createUnavailableGstProvider() {
  return {
    provider: 'none',
    async verify() {
      return { status: 'UNAVAILABLE', provider: 'none' };
    }
  };
}
