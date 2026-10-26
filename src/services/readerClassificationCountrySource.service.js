export function isReaderClassificationCountryPolicyEnabled() {
  return false
}

export async function readReaderClassificationCountry(userId) {
  return {
    userId: String(userId || ''),
    country: null,
    verified: false,
    source: 'reader_classification_pending',
  }
}
