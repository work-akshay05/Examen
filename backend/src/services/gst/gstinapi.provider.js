const API_BASE_URL = 'https://www.gstinapi.in/v1/gstin';

export function createGstinApiProvider({ GSTINAPI_API_KEY, GSTINAPI_REQUEST_TIMEOUT_MS = 10000 } = {}) {
  if (!GSTINAPI_API_KEY) throw new Error('GSTINAPI_API_KEY is required for the gstinapi provider');

  return {
    provider: 'gstinapi.in',
    async verify(gstin) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), GSTINAPI_REQUEST_TIMEOUT_MS);
      timeout.unref?.();
      try {
        const response = await fetch(`${API_BASE_URL}/${encodeURIComponent(gstin)}`, {
          method: 'GET',
          headers: { 'x-api-key': GSTINAPI_API_KEY, accept: 'application/json' },
          signal: controller.signal,
          redirect: 'error'
        });

        if (response.status === 404) {
          return { status: 'MISMATCH', provider: this.provider, registration: null };
        }
        if (!response.ok) return { status: 'UNAVAILABLE', provider: this.provider };

        const body = await response.json();
        const registration = body?.data;
        if (body?.success !== true || !registration || typeof registration !== 'object') {
          return { status: 'UNAVAILABLE', provider: this.provider };
        }

        const returnedGstin = String(registration.gstin ?? body.gstin ?? '').trim().toUpperCase();
        if (!returnedGstin) return { status: 'UNAVAILABLE', provider: this.provider };

        const normalizedRegistration = {
          gstin: returnedGstin,
          legalName: typeof registration.legal_name === 'string' ? registration.legal_name : null,
          tradeName: typeof registration.trade_name === 'string' ? registration.trade_name : null,
          status: typeof registration.status === 'string' ? registration.status : null,
          taxpayerType: typeof registration.taxpayer_type === 'string' ? registration.taxpayer_type : null,
          registrationDate: typeof registration.registration_date === 'string' ? registration.registration_date : null,
          stateCode: typeof registration.state_code === 'string' ? registration.state_code : null
        };
        const isActive = normalizedRegistration.status?.trim().toLowerCase() === 'active';
        return {
          status: returnedGstin !== gstin ? 'MISMATCH' : isActive ? 'VERIFIED' : 'MISMATCH',
          provider: this.provider,
          registration: normalizedRegistration
        };
      } catch {
        return { status: 'UNAVAILABLE', provider: this.provider };
      } finally {
        clearTimeout(timeout);
      }
    }
  };
}
