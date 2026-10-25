import { requireCambodiaPhysicalBooks } from './physicalBookCountryGate.middleware.js'

export function requireShadowMallPhysicalBookCountry(req, res, next) {
  return requireCambodiaPhysicalBooks(req, res, next)
}
